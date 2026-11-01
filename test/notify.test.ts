import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { type OwnerConfig, ownerConfigSchema } from '../src/config.js';
import { sendNotifications } from '../src/notify.js';
import { ownerStateRootFor, stateRootFor } from '../src/paths.js';
import { type Ports, realPorts } from '../src/ports.js';
import type { StateSnapshot } from '../src/state.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-notify-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = (): string => {
  const d = join(root, `d${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};

interface Call {
  command: string;
  env: Record<string, string>;
  opts: { timeoutMs: number; maxBytes: number };
}

function setup(mode = 0o700) {
  const dir = fresh();
  const ownerRoot = join(dir, 'owner');
  mkdirSync(ownerRoot, { recursive: true });
  const command = join(dir, 'notify.sh');
  writeFileSync(command, '#!/bin/sh\nexit 0\n');
  chmodSync(command, mode);
  const calls: Call[] = [];
  const replies: number[] = [];
  const ports = {
    credentials: {
      runProvider: async (c: string, env: Record<string, string>, opts: Call['opts']) => {
        calls.push({ command: c, env, opts });
        return { code: replies.shift() ?? 0, stdout: 'SECRET-OUTPUT' };
      },
    },
  } as unknown as Ports;
  const ownerConfig: OwnerConfig = ownerConfigSchema.parse({
    notify: { channel: 'label-a', command },
  });
  return { dir, ownerRoot, command, calls, replies, ports, ownerConfig };
}

const snap = (
  forOwner: { id: string; title: string }[],
  notifications?: StateSnapshot['notifications'],
): StateSnapshot => ({ forOwner, ...(notifications ? { notifications } : {}) }) as StateSnapshot;

const run = (
  s: ReturnType<typeof setup>,
  snapshot: StateSnapshot,
  projectKey = 'proj-a',
  ownerConfig: OwnerConfig = s.ownerConfig,
) =>
  sendNotifications({
    ownerRoot: s.ownerRoot,
    projectKey,
    primaryRepo: 'org/app',
    snapshot,
    ownerConfig,
    ports: s.ports,
    owner: { env: { PATH: '/usr/bin' }, homedir: s.dir },
  });

describe('sendNotifications', () => {
  it('does nothing when no command is configured', async () => {
    const s = setup();
    const errs = await run(s, snap([{ id: 'APP-1', title: 'Decide' }]), 'proj-a', {
      ...s.ownerConfig,
      notify: undefined,
    });
    expect(errs).toEqual([]);
    expect(s.calls).toHaveLength(0);
  });

  it('sends a new line once and not again', async () => {
    const s = setup();
    const sn = snap([{ id: 'APP-1', title: 'Decide' }]);
    expect(await run(s, sn)).toEqual([]);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.opts).toEqual({ timeoutMs: 30_000, maxBytes: 64 * 1024 });
    expect(s.calls[0]?.env).toMatchObject({
      STUDIO_NOTIFY_CHANNEL: 'label-a',
      STUDIO_NOTIFY_KIND: 'owner-item',
      STUDIO_NOTIFY_ID: 'APP-1',
      STUDIO_NOTIFY_PROJECT: 'org/app',
      STUDIO_NOTIFY_TEXT: 'Decide',
    });
    expect(await run(s, sn)).toEqual([]);
    expect(s.calls).toHaveLength(1);
  });

  it('retries a failing command next time and the error holds no message text', async () => {
    const s = setup();
    s.replies.push(1);
    const sn = snap([{ id: 'APP-1', title: 'Pay the invoice' }]);
    const errs = await run(s, sn);
    expect(errs).toHaveLength(1);
    expect(errs.join('\n')).not.toMatch(/invoice|SECRET-OUTPUT|notify\.sh/);
    expect(await run(s, sn)).toEqual([]);
    expect(s.calls).toHaveLength(2);
    expect(await run(s, sn)).toEqual([]);
    expect(s.calls).toHaveLength(2);
  });

  it('a recurrence after the line vanished sends again', async () => {
    const s = setup();
    const sn = snap([{ id: 'APP-1', title: 'Decide' }]);
    await run(s, sn);
    await run(s, snap([]));
    await run(s, sn);
    expect(s.calls).toHaveLength(2);
  });

  it('strips control characters and caps the text', async () => {
    const s = setup();
    await run(s, snap([{ id: 'APP-1', title: `a\u001b[31mb\nc${'x'.repeat(600)}` }]));
    const text = s.calls[0]?.env.STUDIO_NOTIFY_TEXT ?? '';
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the test checks for them
    expect(text).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(text.startsWith('a [31mb c')).toBe(true);
    expect(text.length).toBe(500);
  });

  it('refuses a group-writable command without a call', async () => {
    const s = setup(0o770);
    const errs = await run(s, snap([{ id: 'APP-1', title: 'Decide' }]));
    expect(errs).toHaveLength(1);
    expect(errs[0]).not.toContain(s.command);
    expect(s.calls).toHaveLength(0);
  });

  it('sends a block once across two project keys', async () => {
    const s = setup();
    const block = {
      id: 'account-block' as const,
      title: 'account block on label-a: login',
      reason: 'login',
      at: '2026-11-01T10:00:00.000Z',
      label: 'label-a',
    };
    const sn = snap([{ id: 'account-block', title: block.title }], [block]);
    await run(s, sn, 'proj-a');
    await run(s, sn, 'proj-b');
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.env.STUDIO_NOTIFY_KIND).toBe('account-block');
  });

  it('sends the unreadable-block notification once, not on every run', async () => {
    const s = setup();
    const note = (at: string) =>
      snap(
        [{ id: 'account-block', title: 'account blocks unreadable' }],
        [
          {
            id: 'account-block',
            title: 'account blocks unreadable',
            reason: 'state_unreadable',
            at,
          },
        ],
      );
    await run(s, note('2026-11-01T10:00:00.000Z'));
    await run(s, note('2026-11-01T10:05:00.000Z'));
    expect(s.calls).toHaveLength(1);
  });

  it('passes exactly the listed environment keys', async () => {
    const s = setup();
    await run(s, snap([{ id: 'usage-limit', title: 'all parked' }]));
    expect(Object.keys(s.calls[0]?.env ?? {}).sort()).toEqual([
      'HOME',
      'PATH',
      'STUDIO_NOTIFY_CHANNEL',
      'STUDIO_NOTIFY_ID',
      'STUDIO_NOTIFY_KIND',
      'STUDIO_NOTIFY_PROJECT',
      'STUDIO_NOTIFY_TEXT',
    ]);
    expect(s.calls[0]?.env.STUDIO_NOTIFY_KIND).toBe('usage-limit');
  });

  it('sends nothing and reports when notified.json is corrupt', async () => {
    const s = setup();
    writeFileSync(join(s.ownerRoot, 'notified.json'), '{not json');
    const errs = await run(s, snap([{ id: 'APP-1', title: 'Decide' }]));
    expect(errs).toHaveLength(1);
    expect(s.calls).toHaveLength(0);
    expect(readFileSync(join(s.ownerRoot, 'notified.json'), 'utf8')).toBe('{not json');
  });

  it('sends at most 20 per run', async () => {
    const s = setup();
    const lines = Array.from({ length: 25 }, (_, i) => ({ id: `APP-${i}`, title: 'T' }));
    await run(s, snap(lines));
    expect(s.calls).toHaveLength(20);
    await run(s, snap(lines));
    expect(s.calls).toHaveLength(25);
  });
});

describe('owner config notify', () => {
  it('needs a plain channel name and a command', () => {
    const ok = { channel: 'label-a', command: '/x/y' };
    expect(ownerConfigSchema.safeParse({ notify: ok }).success).toBe(true);
    expect(ownerConfigSchema.safeParse({ notify: { channel: 'a b', command: '/x' } }).success).toBe(
      false,
    );
    expect(ownerConfigSchema.safeParse({ notify: { channel: 'label-a' } }).success).toBe(false);
  });
});

describe('studio.yaml notify block', () => {
  it('warns and sends nothing', async () => {
    const GIT_ENV = {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    };
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
    const base = fresh();
    const home = join(base, 'home');
    mkdirSync(home);
    const origin = join(base, 'origin.git');
    git(base, 'init', '-q', '--bare', '-b', 'main', origin);
    const project = join(base, 'clone');
    git(base, 'clone', '-q', origin, project);
    git(project, 'checkout', '-q', '-b', 'main');
    mkdirSync(join(project, '.studio'));
    writeFileSync(
      join(project, '.studio', 'studio.yaml'),
      `studio: 1
primary_repo: org/app
repos: [org/app]
allow_ambient_credentials: true
notify: { channel: label-a, owner_only: true, irreversible_announce: true }
ci:
  provider: github
  runners: github-hosted
  runner_labels: []
  capacity: { total: 8, merge_max_busy: 5, check_twice_seconds: 30 }
merge: { strategy: studio-queue, contract_paths: [], method: squash }
roles:
  builder: { model: sonnet, wip: 3 }
owner_only: []
deploy_commands: []
`,
    );
    writeFileSync(
      join(project, '.studio', 'board.yaml'),
      'items:\n  - { id: APP-1, title: Decide, type: fix, role: builder, repo: org/app, size: S, priority: 1, status: ready, paths: [], touches: [a/**], depends_on: [], dod: [x], history: [], owner_only: true }\n',
    );
    const calls: string[] = [];
    const real = realPorts();
    const ports: Ports = {
      ...real,
      gh: { api: async () => '0', run: async () => ({ code: 0, stdout: '', stderr: '' }) },
      credentials: {
        ...real.credentials,
        runProvider: async (c) => {
          calls.push(c);
          return { code: 0, stdout: '' };
        },
      },
    };
    let err = '';
    const env = { PATH: process.env.PATH };
    const code = await runCli(['--project', project, 'state'], {
      ports,
      stdout: () => {},
      stderr: (s) => {
        err += s;
      },
      env,
      homedir: home,
      cwd: project,
    });
    expect(code).toBe(0);
    expect(err).toMatch(/warning: .*notify/);
    expect(calls).toHaveLength(0);
    expect(ownerStateRootFor({ env, homedir: home })).toBeTruthy();
    expect(stateRootFor(project, { env, homedir: home })).toBeTruthy();
  });
});
