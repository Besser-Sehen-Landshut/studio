// How the lead reaches a relay worker: the system's ssh client, one session per request, with
// nothing of the owner's SSH setup. The host key is pinned in a known_hosts file Studio writes with
// exactly the configured key under an alias of the label; no agent, no forwarding of any kind, no
// connection sharing, no password, no config file. What the worker runs is forced on its side
// (`studio relay serve`); the command line the lead sends means nothing there.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { OwnerEnv, RelayTarget } from './config.js';
import { ensureStateDir, ownerStateRootFor, writeStateFile } from './paths.js';
import {
  encodeMessage,
  LineReader,
  MAX_HEADER_BYTES,
  parseAnswer,
  RELAY_PROTOCOL,
  type RelayAnswer,
  type RelayFailure,
  type RelayOp,
  readMessage,
} from './relay-protocol.js';

/** One request and its answer; a transport that cannot reach the worker throws `RelayUnreachable`. */
export interface RelayTransport {
  call(
    header: Record<string, unknown>,
    payload: Uint8Array | undefined,
    opts: { maxPayload: number; timeoutMs: number },
  ): Promise<{ header: Record<string, unknown>; payload?: Buffer }>;
}

/** The worker did not answer at all: the connection, the login or the host key failed. */
export class RelayUnreachable extends Error {}

/** The alias the pinned host key is stored under: never the host name, which DNS could move. */
export const hostAlias = (label: string): string => `studio-relay-${label}`;

/** Where Studio keeps the pinned host key of a relay label: the owner's state, never a crew's. */
export function knownHostsFile(owner: OwnerEnv, label: string): string {
  return join(ownerStateRootFor(owner), 'relay', `${label}.known_hosts`);
}

/** Writes the pinned key, and nothing else, as the only entry of the label's known_hosts. */
export function writeKnownHosts(owner: OwnerEnv, label: string, target: RelayTarget): string {
  const root = ownerStateRootFor(owner);
  const file = knownHostsFile(owner, label);
  ensureStateDir(root, join(root, 'relay'));
  writeStateFile(root, file, `${hostAlias(label)} ${target.hostKey}\n`);
  return file;
}

/** The ssh arguments of one request: strict and closed, every option spelled out. */
export function sshArgs(label: string, target: RelayTarget, knownHosts: string): string[] {
  const o = (k: string, v: string) => ['-o', `${k}=${v}`];
  return [
    '-F',
    'none',
    '-T',
    '-x',
    '-a',
    ...o('BatchMode', 'yes'),
    ...o('StrictHostKeyChecking', 'yes'),
    ...o('UserKnownHostsFile', knownHosts),
    ...o('GlobalKnownHostsFile', 'none'),
    ...o('HostKeyAlias', hostAlias(label)),
    ...o('UpdateHostKeys', 'no'),
    ...o('CheckHostIP', 'no'),
    ...o('IdentitiesOnly', 'yes'),
    ...o('IdentityFile', target.identityFile),
    ...o('IdentityAgent', 'none'),
    ...o('ForwardAgent', 'no'),
    ...o('ForwardX11', 'no'),
    ...o('ClearAllForwardings', 'yes'),
    ...o('ControlMaster', 'no'),
    ...o('ControlPath', 'none'),
    ...o('PermitLocalCommand', 'no'),
    ...o('ProxyCommand', 'none'),
    ...o('ProxyJump', 'none'),
    ...o('PasswordAuthentication', 'no'),
    ...o('KbdInteractiveAuthentication', 'no'),
    ...o('RequestTTY', 'no'),
    ...o('ConnectTimeout', '20'),
    ...o('ServerAliveInterval', '15'),
    ...o('ServerAliveCountMax', '4'),
    ...o('LogLevel', 'ERROR'),
    '-p',
    String(target.port),
    '-l',
    target.user,
    '--',
    target.host,
    'studio-relay',
  ];
}

/** ssh's own last words, without control characters, short; never anything the request held. */
const sshNote = (stderr: string): string =>
  stderr
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-200);

/** A transport over the system's ssh client. */
export function sshTransport(o: {
  label: string;
  target: RelayTarget;
  owner: OwnerEnv;
  /** The ssh binary; `ssh` on PATH by default. */
  ssh?: string;
}): RelayTransport {
  return {
    async call(header, payload, opts) {
      const known = writeKnownHosts(o.owner, o.label, o.target);
      const child = spawn(o.ssh ?? 'ssh', sshArgs(o.label, o.target, known), {
        stdio: ['pipe', 'pipe', 'pipe'],
        // Nothing of the owner's agent or askpass reaches ssh.
        env: { PATH: o.owner.env?.PATH ?? process.env.PATH ?? '/usr/bin:/bin' },
      });
      let stderr = '';
      child.stderr?.on('data', (d) => {
        if (stderr.length < 8192) stderr += String(d);
      });
      const exited = new Promise<number>((res) => {
        child.on('error', () => res(255));
        child.on('close', (code) => res(code ?? 255));
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
      try {
        child.stdin?.on('error', () => {});
        for (const line of encodeMessage(header, payload)) {
          if (!(child.stdin?.write(line) ?? false)) {
            await new Promise<void>((r) => child.stdin?.once('drain', () => r()));
          }
        }
        child.stdin?.end();
        // Never more than one answer can need: its header, its payload in base64 lines, and slack.
        const maxTotal =
          MAX_HEADER_BYTES + Math.ceil((opts.maxPayload * 4) / 3) * 1.05 + 1024 * 1024;
        const reader = new LineReader(
          child.stdout as AsyncIterable<Buffer>,
          MAX_HEADER_BYTES,
          maxTotal,
        );
        let msg: Awaited<ReturnType<typeof readMessage>>;
        try {
          msg = await readMessage(reader, opts.maxPayload);
        } catch (e) {
          child.stdout?.destroy();
          child.kill('SIGKILL');
          throw new Error(`the relay worker ${o.label} answered badly: ${(e as Error).message}`);
        } finally {
          // One answer is all: whatever the worker sends after it is not read, and ssh ends.
          reader.stop();
        }
        if (msg !== undefined) {
          child.stdout?.destroy();
          child.kill('SIGKILL');
        }
        const code = await exited;
        if (msg === undefined) {
          throw new RelayUnreachable(
            `cannot reach the relay worker ${o.label} (ssh exit ${code}${stderr ? `: ${sshNote(stderr)}` : ''})`,
          );
        }
        return msg;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** One request to a relay worker, its answer checked against the shape of its op. */
export async function relayCall<O extends RelayOp>(
  t: RelayTransport,
  op: O,
  fields: Record<string, unknown> = {},
  o: { payload?: Uint8Array; maxPayload?: number; timeoutMs?: number } = {},
): Promise<{ answer: RelayAnswer<O> | RelayFailure; payload?: Buffer }> {
  const got = await t.call({ studioRelay: RELAY_PROTOCOL, op, ...fields }, o.payload, {
    maxPayload: o.maxPayload ?? 0,
    timeoutMs: o.timeoutMs ?? 120_000,
  });
  return {
    answer: parseAnswer(op, got.header),
    ...(got.payload === undefined ? {} : { payload: got.payload }),
  };
}
