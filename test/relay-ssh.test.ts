// The real ssh client against a real sshd on loopback, run as the current user: the lead's
// transport (pinned host key, no config, no agent) reaches `studio relay serve` through a forced
// command and gets its answer. Skipped where no sshd is installed.
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { relayTargetSchema } from '../src/config.js';
import { LOOPBACK } from '../src/egress-proxy.js';
import { STUDIO_VERSION } from '../src/plugins.js';
import { RelayUnreachable, relayCall, sshTransport } from '../src/relay-transport.js';

const SSHD = ['/usr/sbin/sshd', '/usr/bin/sshd'].find((p) => existsSync(p));
const SSH = ['/usr/bin/ssh', '/usr/local/bin/ssh'].find((p) => existsSync(p));
const enabled = SSHD !== undefined && SSH !== undefined && process.platform !== 'win32';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-relay-ssh-')));
const procs: { kill(): void }[] = [];
afterAll(() => {
  for (const p of procs) p.kill();
  rmSync(root, { recursive: true, force: true });
});

const freePort = () =>
  new Promise<number>((res) => {
    const s = createServer();
    s.listen(0, LOOPBACK, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });

describe.skipIf(!enabled)('the ssh transport against a real sshd', () => {
  it('reaches the forced command with the pinned key, and refuses another host key', async (ctx) => {
    const keygen = (file: string) =>
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file]);
    const hostKey = join(root, 'host_ed25519');
    const otherHostKey = join(root, 'other_ed25519');
    const leadKey = join(root, 'lead_ed25519');
    for (const k of [hostKey, otherHostKey, leadKey]) keygen(k);
    const home = join(root, 'relay-home');
    mkdirSync(home);
    const bin = join(import.meta.dirname, '..', 'bin', 'studio');
    const command = `"${process.execPath}" "${bin}" relay serve --home "${home}"`;
    const keys = join(root, 'authorized_keys');
    writeFileSync(
      keys,
      `restrict,command="${command.replace(/"/g, '\\"')}" ${readFileSync(`${leadKey}.pub`, 'utf8')}`,
      {
        mode: 0o600,
      },
    );
    const port = await freePort();
    const config = join(root, 'sshd_config');
    writeFileSync(
      config,
      [
        `ListenAddress ${LOOPBACK}`,
        `Port ${port}`,
        `HostKey ${hostKey}`,
        `AuthorizedKeysFile ${keys}`,
        `PidFile ${join(root, 'sshd.pid')}`,
        'StrictModes no',
        'PasswordAuthentication no',
        'KbdInteractiveAuthentication no',
        'UsePAM no',
        `AllowUsers ${userInfo().username}`,
        `ForceCommand ${command}`,
        'PermitTTY no',
        'AllowTcpForwarding no',
        'X11Forwarding no',
        'AllowAgentForwarding no',
        '',
      ].join('\n'),
    );
    const sshd = spawn(SSHD as string, ['-D', '-e', '-f', config], { stdio: 'ignore' });
    procs.push(sshd);
    let exited = false;
    sshd.once('exit', () => {
      exited = true;
    });
    await new Promise((r) => setTimeout(r, 800));
    // An sshd that cannot run as this user here (no privilege separation directory) proves nothing.
    if (exited) ctx.skip();
    const pub = (f: string) =>
      readFileSync(`${f}.pub`, 'utf8').trim().split(' ').slice(0, 2).join(' ');
    const target = (key: string) =>
      relayTargetSchema.parse({
        host: LOOPBACK,
        port,
        user: userInfo().username.slice(0, 20),
        hostKey: key,
        identityFile: leadKey,
      });
    const owner = { env: { PATH: process.env.PATH }, homedir: join(root, 'lead-home') };
    const t = sshTransport({ label: 'lab', target: target(pub(hostKey)), owner, ssh: SSH });
    const { answer } = await relayCall(t, 'hello', {}, { timeoutMs: 60_000 });
    expect(answer).toMatchObject({ ok: true, studio: STUDIO_VERSION, busy: null });
    // Another host key than the pinned one: no session at all.
    const wrong = sshTransport({
      label: 'lab',
      target: target(pub(otherHostKey)),
      owner,
      ssh: SSH,
    });
    await expect(relayCall(wrong, 'hello', {}, { timeoutMs: 60_000 })).rejects.toThrow(
      RelayUnreachable,
    );
  }, 120_000);
});
