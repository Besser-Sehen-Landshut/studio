import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { type ItemStatus, loadBoard, saveBoard } from '../src/board.js';
import { type CliDeps, runCli } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { limitHold } from '../src/credentials.js';
import { launchCrew } from '../src/crew.js';
import { DEFAULT_SECRET_GLOBS, evaluateGuard } from '../src/guard.js';
import { detectBlock, readBlocks } from '../src/limits.js';
import { STATE_FILES, stateRootFor } from '../src/paths.js';
import { type Ports, realPorts } from '../src/ports.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-block-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();

const STUDIO_YAML = `studio: 1
primary_repo: org/app
repos: [org/app]
allow_ambient_credentials: true
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
`;
const itemYaml = (id: string) =>
  `  - { id: ${id}, title: Item ${id}, type: fix, role: builder, repo: org/app, size: S, priority: 1, status: ready, paths: [], touches: [${id.toLowerCase()}/**], depends_on: [], dod: [tests pass], history: [] }`;

let n = 0;
function makeFx(ids: string[] = ['APP-1', 'APP-2']) {
  const base = join(root, `p${n++}`);
  mkdirSync(base);
  const home = join(base, 'home');
  mkdirSync(home);
  const origin = join(base, 'origin.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  const project = join(base, 'clone');
  git(base, 'clone', '-q', origin, project);
  git(project, 'checkout', '-q', '-b', 'main');
  writeFileSync(join(project, 'README.md'), 'x\n');
  git(project, 'add', 'README.md');
  git(project, 'commit', '-q', '-m', 'init');
  git(project, 'push', '-q', 'origin', 'main');
  mkdirSync(join(project, '.studio'));
  writeFileSync(join(project, '.studio', 'studio.yaml'), STUDIO_YAML);
  writeFileSync(
    join(project, '.studio', 'board.yaml'),
    `items:\n${ids.map(itemYaml).join('\n')}\n`,
  );
  const env: Record<string, string | undefined> = { PATH: process.env.PATH };
  const ownerDir = join(home, '.config', 'studio');
  const state = stateRootFor(project, { env, homedir: home });
  return { base, project, home, env, ownerDir, state };
}
type Fx = ReturnType<typeof makeFx>;

function makePorts() {
  const real = realPorts();
  const alive = new Set<number>();
  const stopped: number[] = [];
  const started: string[][] = [];
  const hooks: { onStop?: (pid: number) => void } = {};
  /** Overrides what the identity port answers for a pid; undefined means a failed read. */
  const identities = new Map<number, string | undefined>();
  let pid = 5000;
  const ports: Ports = {
    ...real,
    gh: { api: async () => '0', run: async () => ({ code: 0, stdout: '', stderr: '' }) },
    claude: {
      async start(_cwd, args, _prompt, logPath) {
        started.push(args);
        pid += 1;
        alive.add(pid);
        writeFileSync(logPath, '', { flag: 'a' });
        return { pid };
      },
      alive: (p) => alive.has(p),
      identity: async (p) => (identities.has(p) ? identities.get(p) : `start-${p}`),
      async stop(p) {
        hooks.onStop?.(p);
        stopped.push(p);
        alive.delete(p);
      },
    },
    clock: { now: () => new Date('2026-11-01T10:00:00Z'), sleep: async () => {} },
    host: { loadAvg1: () => 0, cpuCount: () => 4 },
  };
  return { ports, alive, stopped, started, hooks, identities };
}

async function cli(fx: Fx, ports: Ports, argv: string[], extra: Partial<CliDeps> = {}) {
  let out = '';
  let err = '';
  const code = await runCli(['--project', fx.project, ...argv], {
    ports,
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
    env: fx.env,
    homedir: fx.home,
    cwd: fx.project,
    ...extra,
  });
  return { code, out, err };
}

/** A provider that answers with `label` and leaves a trace of every call. */
const provider = (fx: Fx, label: string, before = '') => {
  mkdirSync(fx.ownerDir, { recursive: true });
  const f = join(fx.ownerDir, `provider-${n++}.sh`);
  const line = JSON.stringify({ label, env: { CLAUDE_CODE_OAUTH_TOKEN: 'fake-value-block-9f3a' } });
  writeFileSync(
    f,
    `#!/bin/sh\necho called >> "${fx.base}/provider-calls"\n${before}\ncat <<'OUT'\n${line}\nOUT\n`,
    { mode: 0o700 },
  );
  writeFileSync(join(fx.ownerDir, 'config.yaml'), `crew_credential_command: ${f}\n`);
};
const providerCalls = (fx: Fx): number => {
  const f = join(fx.base, 'provider-calls');
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').length : 0;
};

const log = (fx: Fx, id: string, ev: unknown) =>
  writeFileSync(join(fx.state, 'logs', `${id}.jsonl`), `${JSON.stringify(ev)}\n`, { flag: 'a' });
const ON_HOLD = { type: 'system', subtype: 'api_retry', error: 'account_on_hold' };
const blocksFile = (fx: Fx) => join(fx.state, 'blocks.json');
const blocksOf = (fx: Fx) => JSON.parse(readFileSync(blocksFile(fx), 'utf8'));
const seedBlocks = (fx: Fx, body: string) => {
  mkdirSync(fx.state, { recursive: true, mode: 0o700 });
  writeFileSync(blocksFile(fx), body);
};
const A_BLOCK = (label = 'label-a') => ({
  label,
  reason: 'account_on_hold',
  at: '2026-11-01T09:00:00.000Z',
});
const itemOf = (fx: Fx, id: string) => loadBoard(fx.project).items.find((i) => i.id === id);
const recordsOf = (fx: Fx) => JSON.parse(readFileSync(join(fx.state, 'crew.json'), 'utf8'));
const recordOf = (fx: Fx, id: string) => recordsOf(fx)[id];

/** Two running crews on two labels. */
async function twoCrews(fx: Fx, p: ReturnType<typeof makePorts>) {
  provider(fx, 'label-a');
  expect((await cli(fx, p.ports, ['launch', 'APP-1'])).code).toBe(0);
  provider(fx, 'label-b');
  expect((await cli(fx, p.ports, ['launch', 'APP-2'])).code).toBe(0);
}

describe('the real identity port', () => {
  it('reads a stable identity, and none for an invalid or unused pid', async () => {
    const { claude } = realPorts();
    const first = await claude.identity(process.pid);
    expect(first).toEqual(expect.any(String));
    expect(await claude.identity(process.pid)).toBe(first);
    expect(await claude.identity(-1)).toBeUndefined();
    expect(await claude.identity(0)).toBeUndefined();
    expect(await claude.identity(2 ** 30)).toBeUndefined();
  });
});

describe('detectBlock', () => {
  it('counts block categories on retry and top-level assistant events', () => {
    for (const [error, reason] of [
      ['authentication_failed', 'authentication_failed'],
      ['oauth_org_not_allowed', 'organization_not_allowed'],
      ['account_on_hold', 'account_on_hold'],
    ]) {
      expect(detectBlock(JSON.stringify({ type: 'system', subtype: 'api_retry', error }))).toEqual({
        reason,
      });
      expect(
        detectBlock(JSON.stringify({ type: 'assistant', error, message: { content: [] } })),
      ).toEqual({ reason });
    }
  });

  it('billing, rate limits and odd category values are not blocks', () => {
    for (const error of ['billing_error', 'rate_limit', 'constructor', '__proto__', 'x']) {
      expect(
        detectBlock(JSON.stringify({ type: 'system', subtype: 'api_retry', error })),
      ).toBeUndefined();
      expect(detectBlock(JSON.stringify({ type: 'assistant', error }))).toBeUndefined();
    }
    expect(
      detectBlock(JSON.stringify({ type: 'system', subtype: 'init', error: 'account_on_hold' })),
    ).toBeUndefined();
  });

  const TEXTS: [string, string][] = [
    ['Failed to authenticate: OAuth token revoked', 'authentication_failed'],
    ['Failed to authenticate. API Error: 401', 'authentication_failed'],
    ['OAuth token revoked', 'authentication_failed'],
    ['OAuth token has expired', 'authentication_failed'],
    [
      'Your account does not have access to Claude. Please login again or contact your administrator.',
      'authentication_failed',
    ],
    ["Your account is on hold and can't use Claude Code.", 'account_on_hold'],
    ['Your account is on hold and can’t sign in to Claude Code.', 'account_on_hold'],
    ['This organization has been disabled', 'organization_disabled'],
    ['API Error: 400 This organization has been disabled.', 'organization_disabled'],
    [
      'API Error: 400 {"type":"error","error":{"message":"This organization has been disabled."}}',
      'organization_disabled',
    ],
    ['Your ANTHROPIC_API_KEY belongs to a disabled organization', 'organization_disabled'],
    ['Your organization has disabled Claude subscription access', 'organization_disabled'],
    [
      'Claude Code is unable to respond to this request, which appears to violate our Usage Policy',
      'policy_violation',
    ],
    ['Your account has been disabled.', 'account_disabled'],
    ['This account has been suspended', 'account_disabled'],
    ['Your account was banned', 'account_disabled'],
  ];

  it('matches documented text in the trusted positions, with a fixed reason code', () => {
    for (const [text, reason] of TEXTS) {
      expect(detectBlock(text), text).toEqual({ reason });
      expect(
        detectBlock(JSON.stringify({ type: 'result', is_error: true, result: text })),
        text,
      ).toEqual({ reason });
      expect(detectBlock(JSON.stringify({ type: 'result', error: text })), text).toEqual({
        reason,
      });
      expect(
        detectBlock(
          JSON.stringify({
            type: 'assistant',
            isApiErrorMessage: true,
            message: { content: [{ type: 'text', text }] },
          }),
        ),
        text,
      ).toEqual({ reason });
    }
  });

  it('text is anchored and length-capped', () => {
    for (const text of [
      'note: OAuth token revoked',
      'The log says: This organization has been disabled',
      ' OAuth token revoked',
      `OAuth token revoked${'x'.repeat(2000)}`,
      'My account has been disabled',
      'API Error: 400 please read: This organization has been disabled',
      'Failed to authenticated nobody',
    ]) {
      expect(
        detectBlock(JSON.stringify({ type: 'result', is_error: true, result: text })),
        text,
      ).toBeUndefined();
    }
  });
});

describe('account block', () => {
  it('block event stops all crews', async () => {
    const fx = makeFx();
    const p = makePorts();
    await twoCrews(fx, p);
    const clone = join(fx.state, 'clones', 'APP-2');
    log(fx, 'APP-1', ON_HOLD);

    const r = await cli(fx, p.ports, ['status', '--json']);

    expect(r.code).toBe(0);
    expect(p.stopped.sort()).toEqual([5001, 5002]);
    expect(blocksOf(fx)).toEqual([
      { label: 'label-a', reason: 'account_on_hold', at: '2026-11-01T10:00:00.000Z' },
    ]);
    for (const id of ['APP-1', 'APP-2']) {
      const rec = recordOf(fx, id);
      expect(rec.stoppedAt).toBe('2026-11-01T10:00:00.000Z');
      expect(rec.block).toMatchObject({ reason: 'account_on_hold' });
      expect(rec.limit).toBeUndefined();
      const item = itemOf(fx, id);
      expect(item?.status).toBe('ready');
      expect(item?.notes?.join(' ')).toContain('account block');
    }
    expect(lstatSync(clone).isDirectory()).toBe(true);
    expect(existsSync(join(fx.state, 'limits.json'))).toBe(false);

    // Repeating changes nothing.
    const notes = itemOf(fx, 'APP-1')?.notes;
    await cli(fx, p.ports, ['status']);
    expect(p.stopped).toHaveLength(2);
    expect(itemOf(fx, 'APP-1')?.notes).toEqual(notes);
    expect(blocksOf(fx)).toHaveLength(1);
  });

  it('no launch under another label while any block exists', async () => {
    const fx = makeFx();
    const p = makePorts();
    provider(fx, 'label-b');
    seedBlocks(fx, JSON.stringify([A_BLOCK()]));

    const r = await cli(fx, p.ports, ['launch', 'APP-1']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('account block');
    expect(p.started).toHaveLength(0);
    expect(providerCalls(fx)).toBe(0);

    const owner = { env: fx.env, homedir: fx.home };
    const hold = await limitHold(
      fx.state,
      { crewCredentialCommand: join(fx.ownerDir, 'absent') } as never,
      p.ports,
      owner,
    );
    expect(hold).toContain('account block');

    // launchCrew refuses by itself, before any provider call.
    const item = loadBoard(fx.project).items[0];
    await expect(
      launchCrew(fx.project, item as never, loadConfig(fx.project), p.ports, owner),
    ).rejects.toThrow(/account block/);
    expect(providerCalls(fx)).toBe(0);
    expect(p.started).toHaveLength(0);
  });

  it('tool output quoting the text does not count', async () => {
    const quote = 'Your account has been disabled';
    const events = [
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', content: quote, is_error: true }] },
      },
      { type: 'user', error: 'account_on_hold', tool_use_result: quote },
      { type: 'assistant', message: { content: [{ type: 'text', text: quote }] } },
      { type: 'result', result: quote },
      { type: 'result', is_error: false, result: quote },
      { type: 'system', subtype: 'api_retry', message: quote },
      { type: 'user', message: { type: 'assistant', error: 'account_on_hold' } },
    ];
    for (const ev of events) expect(detectBlock(JSON.stringify(ev))).toBeUndefined();
    expect(detectBlock(`  ${quote}`)).toBeUndefined();
    expect(detectBlock(`output: ${quote}`)).toBeUndefined();

    const fx = makeFx();
    const p = makePorts();
    await twoCrews(fx, p);
    for (const ev of events) log(fx, 'APP-1', ev);
    await cli(fx, p.ports, ['status']);
    expect(p.stopped).toEqual([]);
    expect(existsSync(blocksFile(fx))).toBe(false);
    expect(itemOf(fx, 'APP-1')?.status).toBe('assigned');
  });

  it('unreadable blocks.json counts as blocked', async () => {
    const bad: ((fx: Fx) => void)[] = [
      (fx) => seedBlocks(fx, 'not json'),
      (fx) => seedBlocks(fx, '{}'),
      (fx) => seedBlocks(fx, JSON.stringify([{ ...A_BLOCK(), extra: 1 }])),
      (fx) => seedBlocks(fx, JSON.stringify([{ ...A_BLOCK(), label: '__proto__' }])),
      (fx) => seedBlocks(fx, JSON.stringify([{ ...A_BLOCK(), at: 'soon' }])),
      (fx) => seedBlocks(fx, JSON.stringify([{ ...A_BLOCK(), reason: 'x'.repeat(65) }])),
      (fx) => seedBlocks(fx, JSON.stringify([{ ...A_BLOCK(), reason: 'run\nthis' }])),
      (fx) => {
        writeFileSync(join(fx.base, 'real.json'), '[]');
        symlinkSync(join(fx.base, 'real.json'), blocksFile(fx));
      },
      (fx) => mkdirSync(blocksFile(fx)),
    ];
    for (const plant of bad) {
      const fx = makeFx();
      const p = makePorts();
      await twoCrews(fx, p);
      plant(fx);
      expect(readBlocks(fx.state)).toEqual({ ok: false });

      // Stops running crews and refuses launches; nothing is overwritten.
      const r = await cli(fx, p.ports, ['status', '--json']);
      expect(p.stopped.sort()).toEqual([5001, 5002]);
      expect(r.err).toContain('blocks.json');
      expect(recordOf(fx, 'APP-1').stoppedAt).toBeDefined();
      expect(itemOf(fx, 'APP-1')?.status).toBe('ready');
      const before = lstatSync(blocksFile(fx)).mtimeMs;
      const calls = providerCalls(fx);
      const launch = await cli(fx, p.ports, ['launch', 'APP-1']);
      expect(launch.code).toBe(1);
      expect(p.started).toHaveLength(2);
      expect(providerCalls(fx)).toBe(calls);
      expect(lstatSync(blocksFile(fx)).mtimeMs).toBe(before);
    }

    // A missing file is no block.
    expect(readBlocks(makeFx().state)).toEqual({ ok: true, blocks: [] });
  }, 60_000);

  it('limit events still only park the label', async () => {
    const fx = makeFx();
    const p = makePorts();
    await twoCrews(fx, p);
    log(fx, 'APP-1', {
      type: 'result',
      is_error: true,
      result: "You've hit your weekly limit · resets Nov 3, 9am",
    });
    await cli(fx, p.ports, ['status']);
    expect(p.stopped).toEqual([5001]);
    expect(readBlocks(fx.state)).toEqual({ ok: true, blocks: [] });
    expect(existsSync(blocksFile(fx))).toBe(false);
    expect(recordOf(fx, 'APP-1').limit).toMatchObject({ kind: 'weekly' });
    expect(recordOf(fx, 'APP-1').block).toBeUndefined();
    expect(recordOf(fx, 'APP-2').stoppedAt).toBeUndefined();
    expect(p.alive.has(5002)).toBe(true);
    expect(itemOf(fx, 'APP-2')?.status).toBe('assigned');
  });

  it('clear requires a terminal', async () => {
    const body = `${JSON.stringify([A_BLOCK('label-a'), A_BLOCK('label-b')])}\n`;
    const fx = makeFx();
    const p = makePorts();
    await cli(fx, p.ports, ['state']);
    seedBlocks(fx, body);

    for (const extra of [{}, { isTerminal: false }] as Partial<CliDeps>[]) {
      const r = await cli(fx, p.ports, ['accounts-clear', 'label-a'], extra);
      expect(r.code).toBe(1);
      expect(r.err).toContain('terminal');
      expect(readFileSync(blocksFile(fx), 'utf8')).toBe(body);
    }

    const crew = await cli(fx, p.ports, ['accounts-clear', 'label-a'], {
      isTerminal: true,
      env: { ...fx.env, STUDIO_ROLE: 'crew' },
    });
    expect(crew.code).toBe(1);
    expect(readFileSync(blocksFile(fx), 'utf8')).toBe(body);

    for (const args of [
      ['accounts-clear'],
      ['accounts-clear', '../x'],
      ['accounts-clear', 'a', 'b'],
    ]) {
      expect((await cli(fx, p.ports, args, { isTerminal: true })).code).toBe(1);
      expect(readFileSync(blocksFile(fx), 'utf8')).toBe(body);
    }

    const ok = await cli(fx, p.ports, ['accounts-clear', 'label-a'], { isTerminal: true });
    expect(ok.code).toBe(0);
    expect(blocksOf(fx)).toEqual([A_BLOCK('label-b')]);
    expect(p.started).toHaveLength(0);

    // The other label still blocks; clearing it frees launches, and nothing restarted by itself.
    expect((await cli(fx, p.ports, ['launch', 'APP-1'])).code).toBe(1);
    await cli(fx, p.ports, ['accounts-clear', 'label-b'], { isTerminal: true });
    expect(blocksOf(fx)).toEqual([]);
    expect(p.started).toHaveLength(0);
    expect((await cli(fx, p.ports, ['launch', 'APP-1'])).code).toBe(0);

    // An unreadable file: refuses, tells the owner, leaves it alone.
    const fx2 = makeFx();
    await cli(fx2, p.ports, ['state']);
    seedBlocks(fx2, 'not json');
    const r = await cli(fx2, p.ports, ['accounts-clear', 'label-a'], { isTerminal: true });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/inspect or remove/);
    expect(readFileSync(blocksFile(fx2), 'utf8')).toBe('not json');
  });
});

describe('identity check before a limit stop', () => {
  const LIMIT = {
    type: 'result',
    is_error: true,
    result: "You've hit your weekly limit · resets Nov 3, 9am",
  };

  it('a matching identity is stopped; a mismatch is gone and not signalled', async () => {
    const fx = makeFx();
    const p = makePorts();
    await twoCrews(fx, p);
    log(fx, 'APP-1', LIMIT);
    log(fx, 'APP-2', LIMIT);
    p.identities.set(5002, 'someone-else');
    const r = await cli(fx, p.ports, ['status']);
    expect(p.stopped).toEqual([5001]);
    expect(p.alive.has(5002)).toBe(true);
    expect(r.err).not.toContain('error:');
    for (const id of ['APP-1', 'APP-2']) {
      expect(recordOf(fx, id).limit).toMatchObject({ kind: 'weekly' });
      expect(itemOf(fx, id)?.status).toBe('ready');
    }
  });

  it('an unverified crew or a legacy record is not signalled and is reported', async () => {
    const fx = makeFx();
    const p = makePorts();
    await twoCrews(fx, p);
    const records = recordsOf(fx);
    delete records['APP-2'].identity;
    writeFileSync(join(fx.state, 'crew.json'), JSON.stringify(records));
    p.identities.set(5001, undefined);
    log(fx, 'APP-1', LIMIT);
    log(fx, 'APP-2', LIMIT);
    const r = await cli(fx, p.ports, ['status']);
    expect(p.stopped).toEqual([]);
    for (const [id, pid] of [
      ['APP-1', '5001'],
      ['APP-2', '5002'],
    ] as const) {
      expect(r.err).toContain(id);
      expect(r.err).toContain(pid);
      expect(recordOf(fx, id).stoppedAt).toBeUndefined();
      expect(recordOf(fx, id).limit).toBeUndefined();
      expect(itemOf(fx, id)?.status).toBe('assigned');
    }
    // The limit still counts for new launches on those labels.
    const limits = JSON.parse(readFileSync(join(fx.state, 'limits.json'), 'utf8'));
    expect(Object.keys(limits).sort()).toEqual(['label-a', 'label-b']);
  });
});

describe('account block details', () => {
  it('writes blocks.json before the first stop', async () => {
    const fx = makeFx();
    const p = makePorts();
    await twoCrews(fx, p);
    log(fx, 'APP-2', ON_HOLD);
    const seen: boolean[] = [];
    p.hooks.onStop = () => seen.push(existsSync(blocksFile(fx)));
    await cli(fx, p.ports, ['status']);
    expect(seen).toEqual([true, true]);
  });

  it('after a clear the old log event does not trigger again', async () => {
    const fx = makeFx();
    const p = makePorts();
    await twoCrews(fx, p);
    log(fx, 'APP-1', ON_HOLD);
    await cli(fx, p.ports, ['status']);
    await cli(fx, p.ports, ['accounts-clear', 'label-a'], { isTerminal: true });
    await cli(fx, p.ports, ['status']);
    expect(blocksOf(fx)).toEqual([]);
    expect(p.stopped).toHaveLength(2);
  });

  it('a later launch neither resumes the run nor replaces a clone that left its branch', async () => {
    const fx = makeFx();
    const p = makePorts();
    await twoCrews(fx, p);
    log(fx, 'APP-1', { type: 'system', subtype: 'init', session_id: 'sess-1' });
    log(fx, 'APP-1', ON_HOLD);
    await cli(fx, p.ports, ['status']);
    await cli(fx, p.ports, ['accounts-clear', 'label-a'], { isTerminal: true });

    expect((await cli(fx, p.ports, ['launch', 'APP-2'])).code).toBe(0);
    expect(p.started.at(-1)).not.toContain('--resume');

    const clone = join(fx.state, 'clones', 'APP-1');
    writeFileSync(join(clone, 'wip.txt'), 'kept');
    writeFileSync(join(clone, '.git', 'HEAD'), 'ref: refs/heads/other\n');
    const r = await cli(fx, p.ports, ['launch', 'APP-1']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('an account block');
    expect(readFileSync(join(clone, 'wip.txt'), 'utf8')).toBe('kept');
  });

  it('an exited crew counts even with a report, and stays marked', async () => {
    const fx = makeFx();
    const p = makePorts();
    await twoCrews(fx, p);
    log(fx, 'APP-1', { type: 'result', is_error: true, result: 'OAuth token revoked' });
    p.alive.delete(5001);
    const reports = join(fx.state, 'clones', 'APP-1', '.studio', 'reports');
    mkdirSync(reports, { recursive: true });
    writeFileSync(join(reports, 'APP-1.md'), 'x');
    await cli(fx, p.ports, ['status']);
    expect(blocksOf(fx)[0]).toMatchObject({ label: 'label-a', reason: 'authentication_failed' });
    expect(p.stopped).toEqual([5002]);
    expect(recordOf(fx, 'APP-1').stoppedAt).toBeDefined();
    expect(recordOf(fx, 'APP-1').block).toBeDefined();

    // The finished work stays active, also on later reconciles, and collect takes it end to end.
    await cli(fx, p.ports, ['status']);
    expect(itemOf(fx, 'APP-1')?.status).toBe('assigned');
    expect(itemOf(fx, 'APP-2')?.status).toBe('ready');
    const head = 'a'.repeat(40);
    const file = join(reports, 'APP-1.md');
    writeFileSync(
      file,
      `---\nstatus: done\nitem: APP-1\npr: 7\nhead_sha: ${head}\ntests_run: 3\nlessons: []\nquestions: []\n---\nbody\n`,
    );
    utimesSync(file, new Date('2026-11-02T00:00:00Z'), new Date('2026-11-02T00:00:00Z'));
    p.ports.gh.run = async () => ({
      code: 0,
      stderr: '',
      stdout: JSON.stringify({
        headRefOid: head,
        headRefName: 'studio/APP-1',
        headRepository: { name: 'app' },
        headRepositoryOwner: { login: 'org' },
        isCrossRepository: false,
      }),
    });
    const c = await cli(fx, p.ports, ['collect', 'APP-1']);
    expect(c.err).toBe('');
    expect(c.code).toBe(0);
    expect(itemOf(fx, 'APP-1')?.status).toBe('in_review');
    expect(itemOf(fx, 'APP-1')?.pr).toBe(7);
  });

  it('a live crew stopped just after writing its report keeps its item active', async () => {
    const fx = makeFx();
    const p = makePorts();
    await twoCrews(fx, p);
    const reports = join(fx.state, 'clones', 'APP-2', '.studio', 'reports');
    mkdirSync(reports, { recursive: true });
    writeFileSync(join(reports, 'APP-2.md'), 'x');
    log(fx, 'APP-1', ON_HOLD);
    await cli(fx, p.ports, ['status']);
    expect(p.stopped.sort()).toEqual([5001, 5002]);
    expect(recordOf(fx, 'APP-2').block).toBeDefined();
    expect(itemOf(fx, 'APP-2')?.status).toBe('assigned');
    expect(itemOf(fx, 'APP-1')?.status).toBe('ready');
  });

  /** Moves an item on the board without touching its crew record. */
  const setStatus = (fx: Fx, id: string, status: ItemStatus) => {
    const board = loadBoard(fx.project);
    saveBoard(fx.project, {
      ...board,
      items: board.items.map((i) => (i.id === id ? { ...i, status } : i)),
    });
  };

  it('a live pid on a merged item is not stopped by a block', async () => {
    const fx = makeFx();
    const p = makePorts();
    await twoCrews(fx, p);
    setStatus(fx, 'APP-2', 'merged');
    log(fx, 'APP-1', ON_HOLD);
    await cli(fx, p.ports, ['status']);
    expect(p.stopped).toEqual([5001]);
    expect(p.alive.has(5002)).toBe(true);
    expect(recordOf(fx, 'APP-2').stoppedAt).toBeUndefined();
    expect(recordOf(fx, 'APP-2').block).toBeUndefined();
    expect(itemOf(fx, 'APP-2')?.status).toBe('merged');
  });

  it('the old log of a merged item raises no block', async () => {
    const fx = makeFx();
    const p = makePorts();
    await twoCrews(fx, p);
    setStatus(fx, 'APP-2', 'merged');
    log(fx, 'APP-2', ON_HOLD);
    await cli(fx, p.ports, ['status']);
    expect(existsSync(blocksFile(fx))).toBe(false);
    expect(p.stopped).toEqual([]);
  });

  it('an unreadable board still records the block and stops crews, and moves nothing', async () => {
    const fx = makeFx();
    const p = makePorts();
    await twoCrews(fx, p);
    log(fx, 'APP-1', ON_HOLD);
    const boardFile = join(fx.project, '.studio', 'board.yaml');
    const good = readFileSync(boardFile, 'utf8');
    writeFileSync(boardFile, 'items: [not closed');

    const r = await cli(fx, p.ports, ['status']);
    expect(r.err).toContain('board');
    expect(blocksOf(fx)).toEqual([
      { label: 'label-a', reason: 'account_on_hold', at: '2026-11-01T10:00:00.000Z' },
    ]);
    expect(p.stopped.sort()).toEqual([5001, 5002]);
    expect(recordOf(fx, 'APP-2').block).toMatchObject({ reason: 'account_on_hold' });
    expect(readFileSync(boardFile, 'utf8')).toBe('items: [not closed');

    const before = p.started.length;
    expect((await cli(fx, p.ports, ['launch', 'APP-1'])).code).toBe(1);
    expect(p.started).toHaveLength(before);
    expect(readFileSync(boardFile, 'utf8')).toBe('items: [not closed');

    // Once the board is back, the moves left out are made, and the block still holds.
    writeFileSync(boardFile, good);
    await cli(fx, p.ports, ['status']);
    expect(itemOf(fx, 'APP-1')?.status).toBe('ready');
    expect(itemOf(fx, 'APP-2')?.status).toBe('ready');
    expect((await cli(fx, p.ports, ['launch', 'APP-1'])).code).toBe(1);
    expect(p.started).toHaveLength(before);
  });

  it('a block marker left after a clear hinders neither collect nor the next launch', async () => {
    const fx = makeFx();
    const p = makePorts();
    await twoCrews(fx, p);
    const reports = join(fx.state, 'clones', 'APP-1', '.studio', 'reports');
    mkdirSync(reports, { recursive: true });
    const file = join(reports, 'APP-1.md');
    writeFileSync(
      file,
      '---\nstatus: failed\nitem: APP-1\nlessons: []\nquestions: []\n---\nbody\n',
    );
    utimesSync(file, new Date('2026-11-02T00:00:00Z'), new Date('2026-11-02T00:00:00Z'));
    log(fx, 'APP-1', ON_HOLD);
    await cli(fx, p.ports, ['status']);
    await cli(fx, p.ports, ['accounts-clear', 'label-a'], { isTerminal: true });
    await cli(fx, p.ports, ['status']);
    expect(recordOf(fx, 'APP-1').block).toBeDefined();
    expect(itemOf(fx, 'APP-1')?.status).toBe('assigned');
    expect(p.stopped).toHaveLength(2);

    const c = await cli(fx, p.ports, ['collect', 'APP-1']);
    expect(c.err).toBe('');
    expect(c.code).toBe(0);
    expect(itemOf(fx, 'APP-1')?.status).toBe('blocked');

    // The next launch of a stopped item starts clean: a new record, no marker.
    expect((await cli(fx, p.ports, ['launch', 'APP-2'])).code).toBe(0);
    expect(recordOf(fx, 'APP-2').block).toBeUndefined();
    expect(recordOf(fx, 'APP-2').stoppedAt).toBeUndefined();
    await cli(fx, p.ports, ['status']);
    expect(itemOf(fx, 'APP-2')?.status).toBe('assigned');
  });

  it('stores the identity at launch and stops on a match', async () => {
    const fx = makeFx();
    const p = makePorts();
    await twoCrews(fx, p);
    expect(recordOf(fx, 'APP-1').identity).toBe('start-5001');
    log(fx, 'APP-1', ON_HOLD);
    await cli(fx, p.ports, ['status']);
    expect(p.stopped.sort()).toEqual([5001, 5002]);
  });

  it('an identity mismatch is not signalled: the crew is gone, no error', async () => {
    const fx = makeFx();
    const p = makePorts();
    await twoCrews(fx, p);
    log(fx, 'APP-1', ON_HOLD);
    p.identities.set(5002, 'someone-else');
    const r = await cli(fx, p.ports, ['status']);
    expect(p.stopped).toEqual([5001]);
    expect(p.alive.has(5002)).toBe(true);
    expect(r.err).not.toContain('error:');
    const rec = recordOf(fx, 'APP-2');
    expect(rec.processGone).toBe('2026-11-01T10:00:00.000Z');
    expect(rec.stoppedAt).toBeDefined();
    expect(rec.block).toBeUndefined();
    // Marked: later reconciles leave it alone.
    await cli(fx, p.ports, ['status']);
    expect(p.stopped).toEqual([5001]);
  });

  it('an unknown identity is skipped and reported, and launches stay refused', async () => {
    const fx = makeFx();
    const p = makePorts();
    await twoCrews(fx, p);
    log(fx, 'APP-1', ON_HOLD);
    p.identities.set(5002, undefined);
    const r = await cli(fx, p.ports, ['status']);
    expect(p.stopped).toEqual([5001]);
    expect(r.err).toContain('APP-2');
    expect(r.err).toContain('5002');
    expect(recordOf(fx, 'APP-2').stoppedAt).toBeUndefined();
    expect((await cli(fx, p.ports, ['launch', 'APP-1'])).code).toBe(1);
  });

  it('a legacy record with no stored identity is skipped and reported', async () => {
    const fx = makeFx();
    const p = makePorts();
    await twoCrews(fx, p);
    const records = recordsOf(fx);
    delete records['APP-2'].identity;
    writeFileSync(join(fx.state, 'crew.json'), JSON.stringify(records));
    log(fx, 'APP-1', ON_HOLD);
    const r = await cli(fx, p.ports, ['status']);
    expect(p.stopped).toEqual([5001]);
    expect(r.err).toContain('APP-2');
    expect(r.err).toContain('5002');
  });

  it('an unverifiable record raises no new block entry and is reported', async () => {
    const unknown = makeFx();
    const p = makePorts();
    await twoCrews(unknown, p);
    log(unknown, 'APP-1', ON_HOLD);
    p.identities.set(5001, undefined);
    const r = await cli(unknown, p.ports, ['status']);
    expect(existsSync(blocksFile(unknown))).toBe(false);
    expect(p.stopped).toEqual([]);
    expect(r.err).toContain('APP-1');
    expect(r.err).toContain('5001');

    const invalid = makeFx();
    const p2 = makePorts();
    await twoCrews(invalid, p2);
    const records = recordsOf(invalid);
    records['APP-1'].pid = -1;
    writeFileSync(join(invalid.state, 'crew.json'), JSON.stringify(records));
    log(invalid, 'APP-1', ON_HOLD);
    const r2 = await cli(invalid, p2.ports, ['status']);
    expect(existsSync(blocksFile(invalid))).toBe(false);
    expect(p2.stopped).toEqual([]);
    expect(r2.err).toContain('APP-1');
  });

  it('a clear moves logStart: the old event stays out, a new one counts', async () => {
    const fx = makeFx();
    const p = makePorts();
    await twoCrews(fx, p);
    // Unverified, so this record stays unmarked through the block.
    p.identities.set(5001, undefined);
    log(fx, 'APP-1', ON_HOLD);
    log(fx, 'APP-2', { type: 'system', subtype: 'init', session_id: 'other' });
    writeFileSync(blocksFile(fx), JSON.stringify([A_BLOCK('label-a')]));
    await cli(fx, p.ports, ['status']);
    expect(recordOf(fx, 'APP-1').stoppedAt).toBeUndefined();
    const logA = join(fx.state, 'logs', 'APP-1.jsonl');
    const logB = join(fx.state, 'logs', 'APP-2.jsonl');
    const startB = recordOf(fx, 'APP-2').logStart;

    await cli(fx, p.ports, ['accounts-clear', 'label-a'], { isTerminal: true });
    expect(recordOf(fx, 'APP-1').logStart).toBe(lstatSync(logA).size);
    // Another label's record keeps its place.
    expect(lstatSync(logB).size).toBeGreaterThan(startB);
    expect(recordOf(fx, 'APP-2').logStart).toBe(startB);

    p.identities.delete(5001);
    await cli(fx, p.ports, ['status']);
    expect(blocksOf(fx)).toEqual([]);
    expect(p.alive.has(5001)).toBe(true);

    log(fx, 'APP-1', ON_HOLD);
    await cli(fx, p.ports, ['status']);
    expect(blocksOf(fx)[0]).toMatchObject({ label: 'label-a', reason: 'account_on_hold' });
    expect(p.alive.has(5001)).toBe(false);
  });

  it('launch refuses on an unreadable board', async () => {
    const fx = makeFx();
    const p = makePorts();
    provider(fx, 'label-a');
    writeFileSync(join(fx.project, '.studio', 'board.yaml'), 'items: [not closed');
    const r = await cli(fx, p.ports, ['launch', 'APP-1']);
    expect(r.code).toBe(1);
    expect(p.started).toHaveLength(0);
    expect(providerCalls(fx)).toBe(0);
  });

  it('a live crew in any non-terminal status, or on a missing item, is stopped', async () => {
    for (const status of ['in_review', 'queued', 'ready', 'missing'] as const) {
      const fx = makeFx();
      const p = makePorts();
      await twoCrews(fx, p);
      if (status === 'missing') {
        const board = loadBoard(fx.project);
        saveBoard(fx.project, { ...board, items: board.items.filter((i) => i.id !== 'APP-2') });
      } else setStatus(fx, 'APP-2', status);
      log(fx, 'APP-1', ON_HOLD);
      await cli(fx, p.ports, ['status']);
      expect(p.stopped.sort(), status).toEqual([5001, 5002]);
      expect(recordOf(fx, 'APP-2').block, status).toBeDefined();
      // Board moves are for assigned and in_progress only.
      if (status !== 'missing') expect(itemOf(fx, 'APP-2')?.status, status).toBe(status);
    }
  }, 30_000);

  it('a live crew on a merged or dropped item is not stopped', async () => {
    for (const status of ['merged', 'dropped'] as const) {
      const fx = makeFx();
      const p = makePorts();
      await twoCrews(fx, p);
      setStatus(fx, 'APP-2', status);
      log(fx, 'APP-1', ON_HOLD);
      const r = await cli(fx, p.ports, ['status']);
      expect(p.stopped, status).toEqual([5001]);
      expect(recordOf(fx, 'APP-2').stoppedAt, status).toBeUndefined();
      expect(r.err, status).not.toContain('APP-2');
    }
  });

  it('an event of a live verified crew on a non-active item counts; of a finished one not', async () => {
    const fx = makeFx();
    const p = makePorts();
    await twoCrews(fx, p);
    setStatus(fx, 'APP-2', 'in_review');
    log(fx, 'APP-2', ON_HOLD);
    p.alive.delete(5002);
    await cli(fx, p.ports, ['status']);
    expect(existsSync(blocksFile(fx))).toBe(false);

    p.alive.add(5002);
    await cli(fx, p.ports, ['status']);
    expect(blocksOf(fx)[0]).toMatchObject({ label: 'label-b' });
    expect(p.stopped.sort()).toEqual([5001, 5002]);
  });

  it('a live crew on an active item of another label is stopped', async () => {
    const fx = makeFx();
    const p = makePorts();
    await twoCrews(fx, p);
    log(fx, 'APP-1', ON_HOLD);
    await cli(fx, p.ports, ['status']);
    expect(recordOf(fx, 'APP-2').label).toBe('label-b');
    expect(p.stopped).toContain(5002);
    expect(p.alive.has(5002)).toBe(false);
    expect(recordOf(fx, 'APP-2').block).toMatchObject({ reason: 'account_on_hold' });
  });

  it('a retry with a later success is no block; without one it counts for a live crew', async () => {
    const fx = makeFx();
    const p = makePorts();
    await twoCrews(fx, p);
    log(fx, 'APP-1', ON_HOLD);
    log(fx, 'APP-1', { type: 'assistant', message: { content: [] } });
    await cli(fx, p.ports, ['status']);
    expect(existsSync(blocksFile(fx))).toBe(false);
    expect(p.stopped).toEqual([]);

    log(fx, 'APP-2', { type: 'system', subtype: 'api_retry', error: 'authentication_failed' });
    await cli(fx, p.ports, ['status']);
    expect(blocksOf(fx)[0]).toMatchObject({ label: 'label-b', reason: 'authentication_failed' });
    expect(p.stopped.sort()).toEqual([5001, 5002]);
  });

  it('an event from an earlier run of the item does not count', async () => {
    const fx = makeFx(['APP-1']);
    const p = makePorts();
    provider(fx, 'label-a');
    await cli(fx, p.ports, ['state']);
    mkdirSync(join(fx.state, 'logs'), { recursive: true, mode: 0o700 });
    log(fx, 'APP-1', ON_HOLD);
    expect((await cli(fx, p.ports, ['launch', 'APP-1'])).code).toBe(0);
    await cli(fx, p.ports, ['status']);
    expect(p.stopped).toEqual([]);
    expect(existsSync(blocksFile(fx))).toBe(false);
  });

  it('a crash mid-stop heals: any live crew stops and a stale board moves', async () => {
    const fx = makeFx();
    const p = makePorts();
    await twoCrews(fx, p);
    // As if the last run wrote blocks.json and died before stopping anything.
    writeFileSync(blocksFile(fx), JSON.stringify([A_BLOCK()]));
    await cli(fx, p.ports, ['plan']);
    expect(p.stopped.sort()).toEqual([5001, 5002]);

    // As if the last run marked the record and died before moving the board.
    const fx2 = makeFx();
    const p2 = makePorts();
    await twoCrews(fx2, p2);
    const records = recordsOf(fx2);
    records['APP-1'].stoppedAt = '2026-11-01T09:00:00.000Z';
    records['APP-1'].block = { at: '2026-11-01T09:00:00.000Z', reason: 'account_on_hold' };
    writeFileSync(join(fx2.state, 'crew.json'), JSON.stringify(records));
    await cli(fx2, p2.ports, ['status']);
    expect(itemOf(fx2, 'APP-1')?.status).toBe('ready');
    expect(itemOf(fx2, 'APP-2')?.status).toBe('assigned');
  });

  it('a hit found while the file is unreadable is not lost', async () => {
    const fx = makeFx();
    const p = makePorts();
    await twoCrews(fx, p);
    log(fx, 'APP-1', ON_HOLD);
    writeFileSync(blocksFile(fx), 'not json');
    await cli(fx, p.ports, ['status']);
    expect(p.stopped.sort()).toEqual([5001, 5002]);
    rmSync(blocksFile(fx));
    await cli(fx, p.ports, ['status']);
    expect(blocksOf(fx)[0]).toMatchObject({ label: 'label-a', reason: 'account_on_hold' });
    expect(itemOf(fx, 'APP-1')?.status).toBe('ready');
  });

  it('never signals an invalid pid', async () => {
    const fx = makeFx();
    const p = makePorts();
    await twoCrews(fx, p);
    const records = recordsOf(fx);
    records['APP-2'].pid = -1;
    writeFileSync(join(fx.state, 'crew.json'), JSON.stringify(records));
    log(fx, 'APP-1', ON_HOLD);
    p.alive.add(-1);
    const r = await cli(fx, p.ports, ['status', '--json']);
    expect(p.stopped).toEqual([5001]);
    expect(r.err).toContain('no valid pid');
  });

  it('a block arriving during the provider call stops the launch before the start', async () => {
    const fx = makeFx();
    const p = makePorts();
    provider(fx, 'label-a');
    expect((await cli(fx, p.ports, ['launch', 'APP-2'])).code).toBe(0);
    provider(fx, 'label-b', `echo '${JSON.stringify([A_BLOCK()])}' > "${blocksFile(fx)}"`);
    const r = await cli(fx, p.ports, ['launch', 'APP-1']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('account block');
    expect(p.started).toHaveLength(1);
    expect(itemOf(fx, 'APP-1')?.status).toBe('ready');
  });

  it('a held reconcile lock refuses a launch', async () => {
    const fx = makeFx();
    const p = makePorts();
    await twoCrews(fx, p);
    writeFileSync(
      join(fx.state, 'blocks.lock'),
      JSON.stringify({
        pid: process.pid,
        startedAt: '2026-11-01T10:00:00Z',
        heartbeat: '2026-11-01T10:00:00Z',
        token: 'other',
      }),
    );
    const third = makePorts();
    const r = await cli(fx, third.ports, ['launch', 'APP-1']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('reconciling');
    expect(third.started).toHaveLength(0);
  });

  it('works with an unreadable limits.json', async () => {
    const fx = makeFx();
    const p = makePorts();
    await twoCrews(fx, p);
    log(fx, 'APP-1', ON_HOLD);
    writeFileSync(join(fx.state, 'limits.json'), 'not json');
    await cli(fx, p.ports, ['status']);
    expect(p.stopped.sort()).toEqual([5001, 5002]);
    expect(blocksOf(fx)).toHaveLength(1);
  });

  it('state.json holds one forOwner line and a notification per block', async () => {
    const fx = makeFx();
    const p = makePorts();
    await cli(fx, p.ports, ['state']);
    seedBlocks(fx, JSON.stringify([A_BLOCK('label-a'), A_BLOCK('label-b')]));
    const r = await cli(fx, p.ports, ['state']);
    expect(r.code).toBe(0);
    const s = JSON.parse(readFileSync(join(fx.state, 'state.json'), 'utf8'));
    expect(s.forOwner).toHaveLength(1);
    expect(s.forOwner[0].id).toBe('account-block');
    expect(s.forOwner[0].title).toContain('label-a');
    expect(s.forOwner[0].title).toContain('label-b');
    expect(s.notifications).toEqual([
      expect.objectContaining({ id: 'account-block', label: 'label-a', reason: 'account_on_hold' }),
      expect.objectContaining({ id: 'account-block', label: 'label-b', reason: 'account_on_hold' }),
    ]);
  });

  it('no notifications without a block', async () => {
    const fx = makeFx();
    await cli(fx, makePorts().ports, ['state']);
    const s = JSON.parse(readFileSync(join(fx.state, 'state.json'), 'utf8'));
    expect(readBlocks(fx.state)).toEqual({ ok: true, blocks: [] });
    expect(s.notifications).toBeUndefined();
    expect(s.forOwner).toEqual([]);
  });

  it('the guard denies the clear command and lists the block files, as a second net', () => {
    expect(STATE_FILES).toEqual(expect.arrayContaining(['blocks.json', 'blocks.lock']));
    const wt = join(root, 'guard-wt');
    mkdirSync(wt, { recursive: true });
    const ctx = {
      worktree: wt,
      ownerOnly: [],
      deployCommands: [],
      secretGlobs: DEFAULT_SECRET_GLOBS,
    };
    const run = (command: string) =>
      evaluateGuard({ toolName: 'Bash', toolInput: { command }, cwd: wt }, ctx).decision;
    for (const c of [
      'studio accounts-clear label-a',
      '/some/bin/studio accounts-clear label-a',
      'node /some/bin/studio accounts-clear label-a',
      'studio --project . accounts-clear label-a',
      'cd . && studio accounts-clear label-a',
    ]) {
      expect(run(c), c).toBe('deny');
    }
    expect(run('studio status')).toBe('allow');
    expect(run('echo accounts-clear')).toBe('allow');
  });
});
