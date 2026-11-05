import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { activeLabel, addAccount } from '../src/accounts.js';
import { loadBoard } from '../src/board.js';
import { type CliDeps, runCli } from '../src/cli.js';
import { acquireStateLock, ownerStateRootFor, stateRootFor } from '../src/paths.js';
import { ONE_BUILD_PER_PLAN } from '../src/planner.js';
import { STUDIO_VERSION } from '../src/plugins.js';
import { type Ports, realPorts } from '../src/ports.js';
import { newReportName } from '../src/report.js';
import { prepareCrewDir } from './crew-dir.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-cli-limits-')));
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

type PlanOut = { assign: { id: string }[]; deferred: { id: string; reason: string }[] };
/** Items a launch would start now: assigned, or held back only because one build starts per plan. */
const startable = (plan: PlanOut) => [
  ...plan.assign.map((i) => i.id),
  ...plan.deferred.filter((d) => d.reason === ONE_BUILD_PER_PLAN).map((d) => d.id),
];

let n = 0;
function makeFx(ids: string[] = ['APP-1'], yaml = STUDIO_YAML) {
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
  writeFileSync(join(project, '.studio', 'studio.yaml'), yaml);
  writeFileSync(
    join(project, '.studio', 'board.yaml'),
    `items:\n${ids.map(itemYaml).join('\n')}\n`,
  );
  const env: Record<string, string | undefined> = { PATH: process.env.PATH };
  const ownerDir = join(home, '.config', 'studio');
  return {
    project,
    home,
    env,
    ownerDir,
    state: stateRootFor(project, { env, homedir: home }),
    owner: ownerStateRootFor({ env, homedir: home }),
  };
}
type Fx = ReturnType<typeof makeFx>;

function makePorts(tokenReplies: { code?: number; stdout?: string }[] = []) {
  const real = realPorts();
  const alive = new Set<number>();
  const stopped: number[] = [];
  const started: { args: string[]; env: Record<string, string> }[] = [];
  const tokens: { token: string; args: string[] }[] = [];
  let pid = 5000;
  let t = Date.parse('2026-11-01T10:00:00Z');
  const ports: Ports = {
    ...real,
    gh: {
      api: async () => '0',
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
    },
    claude: {
      async start(_cwd, args, _prompt, logPath, env) {
        started.push({ args, env });
        pid += 1;
        alive.add(pid);
        // The real port opens the log for appending.
        writeFileSync(logPath, '', { flag: 'a' });
        return { pid };
      },
      alive: (p) => alive.has(p),
      identity: async (p) => `start-${p}`,
      async stop(p) {
        stopped.push(p);
        alive.delete(p);
      },
    },
    clock: { now: () => new Date(t), sleep: async () => {} },
    host: { loadAvg1: () => 0, cpuCount: () => 4 },
    credentials: {
      runProvider: real.credentials.runProvider,
      async ghWithToken(token, args) {
        tokens.push({ token, args });
        const r = tokenReplies.shift() ?? { code: 0, stdout: '{"permissions":{"push":true}}' };
        return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: '' };
      },
    },
  };
  return {
    ports,
    alive,
    stopped,
    started,
    tokens,
    advance: (ms: number) => {
      t += ms;
    },
  };
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

const provider = (fx: Fx, line: string) => {
  mkdirSync(fx.ownerDir, { recursive: true });
  const f = join(fx.ownerDir, `provider-${n++}.sh`);
  // Keeps to the STUDIO_EXCLUDE contract: nothing for a label that is excluded. The planner asks
  // again with the label excluded and treats an answer with that label as a broken provider.
  const label = line === '' ? '-' : (JSON.parse(line) as { label: string }).label;
  writeFileSync(
    f,
    `#!/bin/sh\ncase ",$STUDIO_EXCLUDE," in *,${label},*) exit 0;; esac\ncat <<'OUT'\n${line}\nOUT\n`,
    { mode: 0o700 },
  );
  // These tests are about usage-limit parking, not the per-label parallel limit (default 2).
  writeFileSync(
    join(fx.ownerDir, 'config.yaml'),
    `crew_credential_command: ${f}\ncrew_label_limits:\n  max_parallel: 8\n`,
  );
  prepareCrewDir(fx.ownerDir);
};
const TOKEN = 'fake-value-oauth-cli-5d21';
const tokenLine = (label: string) =>
  JSON.stringify({ label, env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN } });
const WEEKLY = {
  type: 'result',
  is_error: true,
  result: "You've hit your weekly limit · resets Nov 3, 9am",
};
const hitLimit = (fx: Fx, id: string, ev: unknown = WEEKLY) =>
  writeFileSync(join(fx.state, 'logs', `${id}.jsonl`), `${JSON.stringify(ev)}\n`, { flag: 'a' });
const init = (fx: Fx, id: string, sid: string) =>
  hitLimit(fx, id, { type: 'system', subtype: 'init', session_id: sid });

const itemOf = (fx: Fx, id: string) => loadBoard(fx.project).items.find((i) => i.id === id);
const limitsOf = (fx: Fx) => JSON.parse(readFileSync(join(fx.owner, 'limits.json'), 'utf8'));
const recordOf = (fx: Fx, id: string) =>
  JSON.parse(readFileSync(join(fx.state, 'crew.json'), 'utf8'))[id];
const HOUR = 3_600_000;

function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== '.git') hits.push(...filesContaining(p, needle));
    } else if (e.isFile() && readFileSync(p).includes(needle)) hits.push(p);
  }
  return hits;
}

describe('usage limits through the CLI', () => {
  it('limit parks label and returns item to ready keeping clone', async () => {
    const fx = makeFx();
    provider(fx, tokenLine('label-a'));
    const p = makePorts();
    expect((await cli(fx, p.ports, ['launch', 'APP-1'])).code).toBe(0);
    const clone = join(fx.state, 'clones', 'APP-1');
    writeFileSync(join(clone, 'wip.txt'), 'kept');
    init(fx, 'APP-1', 'sess-77');
    hitLimit(fx, 'APP-1');

    const r = await cli(fx, p.ports, ['status', '--json']);
    expect(r.code).toBe(0);
    expect(p.stopped).toEqual([5001]);
    expect(limitsOf(fx)).toEqual({
      'label-a': { parkedUntil: '2026-11-01T11:00:00.000Z', kind: 'weekly' },
    });
    const item = itemOf(fx, 'APP-1');
    expect(item?.status).toBe('ready');
    expect(item?.notes?.join(' ')).toContain('label-a');
    expect(item?.notes?.join(' ')).toContain('2026-11-01T11:00:00.000Z');
    expect(readFileSync(join(clone, 'wip.txt'), 'utf8')).toBe('kept');
    expect(recordOf(fx, 'APP-1').limit).toMatchObject({ kind: 'weekly', sessionId: 'sess-77' });
  });

  it('reconcile is idempotent', async () => {
    const fx = makeFx();
    provider(fx, tokenLine('label-a'));
    const p = makePorts();
    await cli(fx, p.ports, ['launch', 'APP-1']);
    hitLimit(fx, 'APP-1');
    await cli(fx, p.ports, ['status']);
    const notes = itemOf(fx, 'APP-1')?.notes;
    const parked = limitsOf(fx);
    p.advance(60_000);
    await cli(fx, p.ports, ['plan']);
    await cli(fx, p.ports, ['status']);
    expect(p.stopped).toHaveLength(1);
    expect(itemOf(fx, 'APP-1')?.notes).toEqual(notes);
    expect(limitsOf(fx)).toEqual(parked);
  });

  it('runs at the start of plan, launch and state too', async () => {
    for (const cmd of [['plan'], ['state'], ['launch', 'APP-2']]) {
      const fx = makeFx(['APP-1', 'APP-2']);
      provider(fx, tokenLine('label-a'));
      const p = makePorts();
      await cli(fx, p.ports, ['launch', 'APP-1']);
      hitLimit(fx, 'APP-1');
      await cli(fx, p.ports, cmd);
      expect(itemOf(fx, 'APP-1')?.status, cmd.join(' ')).toBe('ready');
    }
  });

  it('a limit line in tool output parks nothing', async () => {
    const fx = makeFx();
    provider(fx, tokenLine('label-a'));
    const p = makePorts();
    await cli(fx, p.ports, ['launch', 'APP-1']);
    hitLimit(fx, 'APP-1', {
      type: 'user',
      message: { content: [{ type: 'tool_result', content: WEEKLY.result }] },
    });
    await cli(fx, p.ports, ['status']);
    expect(p.stopped).toEqual([]);
    expect(existsSync(join(fx.owner, 'limits.json'))).toBe(false);
    expect(itemOf(fx, 'APP-1')?.status).toBe('assigned');
  });

  it('an old limit line does not park the next run', async () => {
    const fx = makeFx();
    provider(fx, tokenLine('label-a'));
    const p = makePorts();
    await cli(fx, p.ports, ['launch', 'APP-1']);
    hitLimit(fx, 'APP-1');
    await cli(fx, p.ports, ['status']);
    p.advance(2 * HOUR);
    expect((await cli(fx, p.ports, ['launch', 'APP-1'])).code).toBe(0);
    await cli(fx, p.ports, ['status']);
    expect(itemOf(fx, 'APP-1')?.status).toBe('assigned');
    expect(p.stopped).toHaveLength(1);
  });

  it('a crew that exited on the limit is handled; one that left a report is not', async () => {
    const fx = makeFx(['APP-1', 'APP-2']);
    provider(fx, tokenLine('label-a'));
    const p = makePorts();
    await cli(fx, p.ports, ['launch', 'APP-1']);
    await cli(fx, p.ports, ['launch', 'APP-2']);
    p.alive.clear();
    hitLimit(fx, 'APP-1');
    hitLimit(fx, 'APP-2');
    const reports = join(fx.state, 'clones', 'APP-2', '.studio', 'reports');
    mkdirSync(reports, { recursive: true });
    writeFileSync(join(reports, newReportName(fx.state, 'APP-2')), '---\nstatus: done\n---\n');
    await cli(fx, p.ports, ['status']);
    expect(itemOf(fx, 'APP-1')?.status).toBe('ready');
    expect(itemOf(fx, 'APP-2')?.status).toBe('assigned');
    expect(p.stopped).toEqual([]);
  });

  describe('rate_limit retries', () => {
    const RETRY = { type: 'system', subtype: 'api_retry', error: 'rate_limit' };
    const RECOVERED = { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } };
    const launched = async () => {
      const fx = makeFx();
      provider(fx, tokenLine('label-a'));
      const p = makePorts();
      await cli(fx, p.ports, ['launch', 'APP-1']);
      return { fx, p };
    };
    const untouched = (fx: Fx, p: ReturnType<typeof makePorts>) => {
      expect(p.stopped).toEqual([]);
      expect(existsSync(join(fx.owner, 'limits.json'))).toBe(false);
      expect(itemOf(fx, 'APP-1')?.status).toBe('assigned');
      expect(recordOf(fx, 'APP-1').limit).toBeUndefined();
    };

    it('retry then recovery parks nothing on a live crew', async () => {
      const { fx, p } = await launched();
      hitLimit(fx, 'APP-1', RETRY);
      hitLimit(fx, 'APP-1', RECOVERED);
      await cli(fx, p.ports, ['status']);
      untouched(fx, p);
    });

    it('retry then recovery parks nothing on an exited crew', async () => {
      const { fx, p } = await launched();
      p.alive.clear();
      hitLimit(fx, 'APP-1', RETRY);
      hitLimit(fx, 'APP-1', RECOVERED);
      await cli(fx, p.ports, ['status']);
      untouched(fx, p);
    });

    it('a live crew with an unrecovered retry is not stopped and not parked', async () => {
      const { fx, p } = await launched();
      hitLimit(fx, 'APP-1', RETRY);
      await cli(fx, p.ports, ['status']);
      untouched(fx, p);
    });

    it('an exited crew with an unrecovered retry parks', async () => {
      const { fx, p } = await launched();
      p.alive.clear();
      hitLimit(fx, 'APP-1', RETRY);
      await cli(fx, p.ports, ['status']);
      expect(p.stopped).toEqual([]);
      expect(limitsOf(fx)['label-a']).toMatchObject({
        parkedUntil: '2026-11-01T11:00:00.000Z',
        kind: 'session',
      });
      expect(itemOf(fx, 'APP-1')?.status).toBe('ready');
    });

    it('an exited crew with an unrecovered retry and a report goes to collect', async () => {
      const { fx, p } = await launched();
      p.alive.clear();
      hitLimit(fx, 'APP-1', RETRY);
      const reports = join(fx.state, 'clones', 'APP-1', '.studio', 'reports');
      mkdirSync(reports, { recursive: true });
      writeFileSync(join(reports, newReportName(fx.state, 'APP-1')), '---\nstatus: done\n---\n');
      await cli(fx, p.ports, ['status']);
      untouched(fx, p);
    });

    it('terminal limit text on a live crew stops and parks', async () => {
      const { fx, p } = await launched();
      hitLimit(fx, 'APP-1', RETRY);
      hitLimit(fx, 'APP-1');
      await cli(fx, p.ports, ['status']);
      expect(p.stopped).toEqual([5001]);
      expect(limitsOf(fx)['label-a'].kind).toBe('weekly');
      expect(itemOf(fx, 'APP-1')?.status).toBe('ready');
    });
  });

  it('a crew stopped by the owner is left alone', async () => {
    const fx = makeFx();
    provider(fx, tokenLine('label-a'));
    const p = makePorts();
    await cli(fx, p.ports, ['launch', 'APP-1']);
    await cli(fx, p.ports, ['stop', 'APP-1']);
    hitLimit(fx, 'APP-1');
    await cli(fx, p.ports, ['status']);
    expect(itemOf(fx, 'APP-1')?.status).toBe('assigned');
    expect(existsSync(join(fx.owner, 'limits.json'))).toBe(false);
  });

  it('a crew record with an invalid pid is never signalled', async () => {
    const fx = makeFx();
    provider(fx, tokenLine('label-a'));
    const p = makePorts();
    await cli(fx, p.ports, ['launch', 'APP-1']);
    const file = join(fx.state, 'crew.json');
    const recs = JSON.parse(readFileSync(file, 'utf8'));
    recs['APP-1'].pid = -1;
    writeFileSync(file, JSON.stringify(recs));
    hitLimit(fx, 'APP-1');
    const r = await cli(fx, p.ports, ['status']);
    expect(p.stopped).toEqual([]);
    expect(r.err).toContain('APP-1');
  });

  it('a crash after the record but before the board move is finished on the next run', async () => {
    const fx = makeFx();
    provider(fx, tokenLine('label-a'));
    const p = makePorts();
    await cli(fx, p.ports, ['launch', 'APP-1']);
    const file = join(fx.state, 'crew.json');
    const recs = JSON.parse(readFileSync(file, 'utf8'));
    recs['APP-1'].limit = { at: '2026-11-01T10:00:00.000Z', kind: 'session' };
    recs['APP-1'].stoppedAt = '2026-11-01T10:00:00.000Z';
    writeFileSync(file, JSON.stringify(recs));
    await cli(fx, p.ports, ['status']);
    expect(itemOf(fx, 'APP-1')?.status).toBe('ready');
  });

  it('the next launch skips the parked label and resumes when usable', async () => {
    const fx = makeFx();
    provider(fx, tokenLine('label-a'));
    const p = makePorts();
    await cli(fx, p.ports, ['launch', 'APP-1']);
    init(fx, 'APP-1', 'sess-77');
    hitLimit(fx, 'APP-1');
    await cli(fx, p.ports, ['status']);
    provider(fx, tokenLine('label-b'));
    const r = await cli(fx, p.ports, ['launch', 'APP-1']);
    expect(r.code).toBe(0);
    expect(p.started[1]?.args.slice(-2)).toEqual(['--resume', 'sess-77']);
    expect(recordOf(fx, 'APP-1').label).toBe('label-b');
    expect(recordOf(fx, 'APP-1').limit).toBeUndefined();
  });

  it('does not resume in a clone that was recreated', async () => {
    const fx = makeFx();
    provider(fx, tokenLine('label-a'));
    const p = makePorts();
    await cli(fx, p.ports, ['launch', 'APP-1']);
    init(fx, 'APP-1', 'sess-77');
    hitLimit(fx, 'APP-1');
    await cli(fx, p.ports, ['status']);
    rmSync(join(fx.state, 'clones', 'APP-1'), { recursive: true, force: true });
    provider(fx, tokenLine('label-b'));
    const r = await cli(fx, p.ports, ['launch', 'APP-1']);
    expect(r.code).toBe(0);
    expect(p.started).toHaveLength(2);
    expect(p.started[1]?.args).not.toContain('--resume');
    expect(existsSync(join(fx.state, 'clones', 'APP-1', '.git'))).toBe(true);
  });

  describe('settings planted in a reused clone', () => {
    const planted = async (name: string, body: string) => {
      const fx = makeFx();
      provider(fx, tokenLine('label-a'));
      const p = makePorts();
      await cli(fx, p.ports, ['launch', 'APP-1']);
      init(fx, 'APP-1', 'sess-77');
      hitLimit(fx, 'APP-1');
      await cli(fx, p.ports, ['status']);
      const dir = join(fx.state, 'clones', 'APP-1', '.claude');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), body);
      provider(fx, tokenLine('label-b'));
      const r = await cli(fx, p.ports, ['launch', 'APP-1']);
      return { r, started: p.started };
    };

    for (const name of ['settings.json', 'settings.local.json']) {
      for (const [key, body] of [
        ['hooks', '{"hooks":{"Stop":[]}}'],
        ['apiKeyHelper', '{"apiKeyHelper":"fake-value-helper"}'],
        ['env.HTTPS_PROXY', '{"env":{"https_proxy":"http://fake-value.example.com"}}'],
      ] as const) {
        it(`${name} with ${key} does not refuse; the relaunch ignores project settings`, async () => {
          const { r, started } = await planted(name, body);
          expect(r.code).toBe(0);
          expect(r.err).not.toContain('fake-value');
          expect(started).toHaveLength(2);
          const args = (started[1] as { args: string[] }).args;
          const i = args.indexOf('--setting-sources');
          expect(args[i + 1]).toBe('user');
        });
      }
    }
  });

  it('all labels parked starts no crew and adds one owner line', async () => {
    const fx = makeFx(['APP-1', 'APP-2', 'APP-3']);
    provider(fx, tokenLine('label-a'));
    const p = makePorts();
    await cli(fx, p.ports, ['launch', 'APP-1']);
    await cli(fx, p.ports, ['launch', 'APP-2']);
    hitLimit(fx, 'APP-1');
    await cli(fx, p.ports, ['status']);
    provider(fx, '');

    const plan = JSON.parse((await cli(fx, p.ports, ['plan'])).out);
    expect(plan.assign).toEqual([]);
    expect(plan.deferred.map((d: { reason: string }) => d.reason).join()).toContain(
      '2026-11-01T11:00:00.000Z',
    );

    const before = p.started.length;
    const launch = await cli(fx, p.ports, ['launch', 'APP-3']);
    expect(launch.code).toBe(1);
    expect(p.started).toHaveLength(before);

    const state = JSON.parse((await cli(fx, p.ports, ['state'])).out);
    const lines = state.forOwner.filter((l: { id: string }) => l.id === 'usage-limit');
    expect(lines).toHaveLength(1);
    expect(lines[0].title).toContain('2026-11-01T11:00:00.000Z');
    expect(state.limits['label-a'].kind).toBe('weekly');

    // Resumes by itself once the park has run out.
    p.advance(2 * HOUR);
    provider(fx, tokenLine('label-a'));
    const later = JSON.parse((await cli(fx, p.ports, ['plan'])).out);
    expect(startable(later)).toContain('APP-3');
    expect(limitsOf(fx)).toEqual({});
  });

  it('without a provider: the item waits and forOwner gets one line', async () => {
    const fx = makeFx(['APP-1', 'APP-2']);
    const p = makePorts();
    await cli(fx, p.ports, ['launch', 'APP-1']);
    expect(recordOf(fx, 'APP-1').label).toBe('default');
    hitLimit(fx, 'APP-1');
    await cli(fx, p.ports, ['status']);
    expect(limitsOf(fx).default.kind).toBe('weekly');
    const plan = JSON.parse((await cli(fx, p.ports, ['plan'])).out);
    expect(plan.assign).toEqual([]);
    const state = JSON.parse((await cli(fx, p.ports, ['state'])).out);
    expect(state.forOwner.filter((l: { id: string }) => l.id === 'usage-limit')).toHaveLength(1);
    p.advance(2 * HOUR);
    const later = JSON.parse((await cli(fx, p.ports, ['plan'])).out);
    expect(startable(later)).toEqual(['APP-1', 'APP-2']);
  });

  it('an unreadable limits file holds everything and tells the owner', async () => {
    const fx = makeFx();
    const p = makePorts();
    mkdirSync(fx.owner, { recursive: true, mode: 0o700 });
    mkdirSync(fx.state, { recursive: true, mode: 0o700 });
    writeFileSync(join(fx.owner, 'limits.json'), 'not json');
    const r = await cli(fx, p.ports, ['plan']);
    expect(r.err).toContain('limits');
    expect(JSON.parse(r.out).assign).toEqual([]);
    const url = git(fx.project, 'remote', 'get-url', 'origin');
    writeFileSync(
      join(fx.state, 'marker.json'),
      JSON.stringify({ projectRealpath: realpathSync(fx.project), originUrl: url }),
    );
    const s = JSON.parse((await cli(fx, p.ports, ['state'])).out);
    expect(s.forOwner.filter((l: { id: string }) => l.id === 'usage-limit')).toHaveLength(1);
  });

  it('a provider handing out a parked label holds the plan', async () => {
    const fx = makeFx(['APP-1', 'APP-2']);
    provider(fx, tokenLine('label-a'));
    const p = makePorts();
    await cli(fx, p.ports, ['launch', 'APP-1']);
    hitLimit(fx, 'APP-1');
    await cli(fx, p.ports, ['status']);
    const plan = JSON.parse((await cli(fx, p.ports, ['plan'])).out);
    expect(plan.assign).toEqual([]);
  });

  it('a recognisable fake token never appears in anything Studio writes or prints', async () => {
    const fx = makeFx(['APP-1', 'APP-2']);
    provider(fx, tokenLine('label-a'));
    const p = makePorts();
    let printed = '';
    const run = async (...argv: string[]) => {
      const r = await cli(fx, p.ports, argv);
      printed += r.out + r.err;
      return r;
    };
    await run('launch', 'APP-1');
    expect(p.started[0]?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    await run('status', '--json');
    hitLimit(fx, 'APP-1');
    await run('status');
    provider(fx, tokenLine('label-b'));
    await run('plan');
    await run('state');
    await run('launch', 'APP-2');
    await run('doctor');
    expect(printed).not.toContain(TOKEN);
    expect(filesContaining(fx.state, TOKEN)).toEqual([]);
    expect(filesContaining(fx.owner, TOKEN)).toEqual([]);
    expect(readFileSync(join(fx.project, '.studio', 'board.yaml'), 'utf8')).not.toContain(TOKEN);
    for (const name of ['crew.json', 'state.json']) {
      expect(readFileSync(join(fx.state, name), 'utf8')).not.toContain(TOKEN);
    }
    expect(readFileSync(join(fx.owner, 'limits.json'), 'utf8')).not.toContain(TOKEN);
  });
});

describe('studio secret set crew-token', () => {
  const VALUE = 'fake-value-secret-set-3c88';
  const tokenFile = (fx: Fx) => join(fx.ownerDir, 'crew-token');
  const set = (fx: Fx, ports: Ports, input: string | undefined, ...extra: string[]) =>
    cli(fx, ports, ['secret', 'set', 'crew-token', ...extra], {
      readSecret: async () => input,
    });

  it('checks first, installs 0600, prints only valid for the repo', async () => {
    const fx = makeFx();
    const p = makePorts();
    const r = await set(fx, p.ports, `  ${VALUE.slice(0, 10)}\n${VALUE.slice(10)} \r\n`);
    expect(r.code).toBe(0);
    expect(r.out).toBe('valid for org/app\n');
    expect(r.err).toBe('');
    expect(readFileSync(tokenFile(fx), 'utf8')).toBe(`${VALUE}\n`);
    expect(statSync(tokenFile(fx)).mode & 0o777).toBe(0o600);
    expect(statSync(fx.ownerDir).mode & 0o777).toBe(0o700);
    expect(p.tokens[0]?.token).toBe(VALUE);
    for (const c of p.tokens) expect(c.args.join(' ')).not.toContain(VALUE);
  });

  it('writes nothing on a failed check and never echoes gh output', async () => {
    const fx = makeFx();
    const p = makePorts([{ code: 1, stdout: `HTTP 401 ${VALUE}` }]);
    const r = await set(fx, p.ports, VALUE);
    expect(r.code).toBe(1);
    expect(existsSync(tokenFile(fx))).toBe(false);
    expect(r.out + r.err).not.toContain(VALUE);
    expect(r.out + r.err).not.toContain('HTTP 401');
    expect(r.out + r.err).toMatch(/failing permission/);
  });

  it('names a missing push permission and keeps an existing token', async () => {
    const fx = makeFx();
    mkdirSync(fx.ownerDir, { recursive: true });
    writeFileSync(tokenFile(fx), 'fake-value-old\n', { mode: 0o600 });
    const p = makePorts([{ stdout: '{"permissions":{"push":false}}' }]);
    const r = await set(fx, p.ports, VALUE);
    expect(r.code).toBe(1);
    expect(r.out + r.err).toMatch(/failing permission: .*contents/);
    expect(readFileSync(tokenFile(fx), 'utf8')).toBe('fake-value-old\n');
  });

  it('an unreachable check writes nothing', async () => {
    const fx = makeFx();
    const p = makePorts();
    p.ports.credentials.ghWithToken = async () => {
      throw new Error(`boom ${VALUE}`);
    };
    const r = await set(fx, p.ports, VALUE);
    expect(r.code).toBe(1);
    expect(existsSync(tokenFile(fx))).toBe(false);
    expect(r.out + r.err).not.toContain(VALUE);
  });

  it('refuses without a terminal, an empty value and control characters', async () => {
    const fx = makeFx();
    const p = makePorts();
    expect((await set(fx, p.ports, undefined)).err).toMatch(/terminal/);
    expect((await cli(fx, p.ports, ['secret', 'set', 'crew-token'])).err).toMatch(/terminal/);
    expect((await set(fx, p.ports, ' \n ')).err).toMatch(/empty/);
    expect((await set(fx, p.ports, 'fake\u0007value')).code).toBe(1);
    expect(p.tokens).toEqual([]);
    expect(existsSync(tokenFile(fx))).toBe(false);
  });

  it('a value on the command line is refused and not echoed', async () => {
    const fx = makeFx();
    const p = makePorts();
    const r = await set(fx, p.ports, 'fake-value-prompt', VALUE);
    expect(r.code).toBe(1);
    expect(r.out + r.err).not.toContain(VALUE);
    expect(p.tokens).toEqual([]);
    const other = await cli(fx, p.ports, ['secret', 'set', VALUE]);
    expect(other.code).toBe(1);
    expect(other.out + other.err).not.toContain(VALUE);
  });

  it('refuses an invalid primary_repo', async () => {
    const fx = makeFx(
      ['APP-1'],
      STUDIO_YAML.replace('primary_repo: org/app', 'primary_repo: ../x'),
    );
    const p = makePorts();
    const r = await set(fx, p.ports, VALUE);
    expect(r.code).toBe(1);
    expect(r.err).toContain('primary_repo');
    expect(p.tokens).toEqual([]);
  });
});

describe('studio skills check', () => {
  const SP = 'superpowers@superpowers-marketplace';
  /** A claude whose marketplaces offer `offer`; it records each plugin call. */
  const offering = (offer: Record<string, string>, extra: Record<string, unknown> = {}) => {
    const p = makePorts();
    const calls: string[] = [];
    const ports: Ports = {
      ...p.ports,
      plugins: {
        run: async (args, env) => {
          calls.push(`${env.CLAUDE_CONFIG_DIR} ${args.join(' ')}`);
          const available = Object.entries(offer).map(([pluginId, version]) => ({
            pluginId,
            version,
            ...extra,
          }));
          return {
            code: 0,
            stdout: args.includes('--available')
              ? JSON.stringify({ installed: [], available })
              : '',
            stderr: '',
          };
        },
      },
    };
    return { ...p, ports, calls };
  };
  const withCrewDir = (fx: Fx) => {
    mkdirSync(join(fx.ownerDir, 'claude'), { recursive: true });
    const board = join(fx.project, '.studio', 'board.yaml');
    if (readFileSync(board, 'utf8').trim() === 'items:') writeFileSync(board, 'items: []\n');
    return fx;
  };
  const updateItems = (fx: Fx) =>
    loadBoard(fx.project).items.filter((i) => i.title.startsWith('Update '));

  it('creates one item per update, and none for the same update again', async () => {
    const fx = withCrewDir(makeFx([]));
    const p = offering({ [SP]: '7.1.0', 'studio@studio-marketplace': STUDIO_VERSION });
    const r = await cli(fx, p.ports, ['skills', 'check', '--now', '--json']);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.added).toEqual([
      { item: expect.any(String), key: `plugin ${SP} 7.1.0`, priority: 1 },
    ]);
    expect(out.notUsed).toEqual(['better-auth']);
    expect(updateItems(fx).map((i) => i.title)).toEqual([`Update ${SP} to 7.1.0`]);
    // The marketplaces are read in the crew config dir only.
    for (const c of p.calls) expect(c.startsWith(join(fx.ownerDir, 'claude'))).toBe(true);
    const again = JSON.parse((await cli(fx, p.ports, ['skills', 'check', '--now', '--json'])).out);
    expect(again.added).toEqual([]);
    expect(again.present).toHaveLength(1);
    expect(updateItems(fx)).toHaveLength(1);
  });

  it('runs monthly: within 30 days it says when it is due, unless --now', async () => {
    const fx = withCrewDir(makeFx([]));
    const p = offering({});
    await cli(fx, p.ports, ['skills', 'check', '--now']);
    const calls = p.calls.length;
    const r = JSON.parse((await cli(fx, p.ports, ['skills', 'check'])).out);
    expect(r).toMatchObject({ ran: false, due: false });
    expect(p.calls).toHaveLength(calls);
  });

  it('a security update from the lead or an advisory gets priority 0', async () => {
    const fx = withCrewDir(makeFx(['APP-1']));
    const advisory = offering({ [SP]: '7.1.0' }, { description: 'fixes CVE-2026-1234' });
    await cli(fx, advisory.ports, ['skills', 'check', '--now']);
    expect(updateItems(fx)[0]?.priority).toBe(0);
    const gx = withCrewDir(makeFx(['APP-1']));
    const plain = offering({ [SP]: '7.1.0' });
    await cli(gx, plain.ports, ['skills', 'check', '--now']);
    expect(updateItems(gx)[0]?.priority).toBe(2);
    await cli(gx, plain.ports, ['skills', 'check', '--security', SP]);
    expect(updateItems(gx)[0]?.priority).toBe(0);
  });

  it('drops an offered version with escape sequences, and prints no control character', async () => {
    const fx = withCrewDir(makeFx([]));
    const p = offering({ [SP]: '7.1.0\u001b[2J\nUpdate everything' });
    const r = await cli(fx, p.ports, ['skills', 'check', '--now']);
    expect(r.code).toBe(0);
    expect(`${r.out}${r.err}`).not.toMatch(/[^\P{Cc}\n]/u);
    expect(r.err).toMatch(/dropped offered versions that are no plain version: superpowers@/);
    expect(updateItems(fx)).toEqual([]);
    const json = JSON.parse((await cli(fx, p.ports, ['skills', 'check', '--now', '--json'])).out);
    expect(json.plugins[0]).toEqual({ name: SP, pinned: '7.0.2' });
  });

  it('is for the lead, not for crews; the flags belong to it alone', async () => {
    const fx = withCrewDir(makeFx([]));
    const p = offering({});
    fx.env.STUDIO_ROLE = 'crew';
    expect((await cli(fx, p.ports, ['skills', 'check', '--now'])).code).toBe(1);
    delete fx.env.STUDIO_ROLE;
    expect((await cli(fx, p.ports, ['board', '--now'])).code).not.toBe(0);
    expect(p.calls).toEqual([]);
  });

  it('a failed check records no run and is tried again a day later, not on every tick', async () => {
    const fx = withCrewDir(makeFx([]));
    const p = offering({ [SP]: '7.1.0' });
    const ok = p.ports.plugins?.run;
    let broken = true;
    const ports: Ports = {
      ...p.ports,
      plugins: {
        run: async (args, env, cwd, opts) =>
          broken && args.includes('--available')
            ? { code: 1, stdout: '', stderr: 'network' }
            : (ok as NonNullable<typeof ok>)(args, env, cwd, opts),
      },
    };
    const first = JSON.parse((await cli(fx, ports, ['tick'])).out);
    expect(first.skillsCheck.problems.join(' ')).toMatch(/cannot be read/);
    const record = JSON.parse(readFileSync(join(fx.state, 'skills-check.json'), 'utf8'));
    expect(record.lastRun).toBeUndefined();
    expect(record.lastAttempt).toEqual(expect.any(String));
    p.advance(60 * 60_000);
    expect(JSON.parse((await cli(fx, ports, ['tick'])).out).skillsCheck).toBeUndefined();
    broken = false;
    p.advance(24 * 60 * 60_000);
    const again = JSON.parse((await cli(fx, ports, ['tick'])).out);
    expect(again.skillsCheck.added).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(fx.state, 'skills-check.json'), 'utf8')).lastRun).toEqual(
      expect.any(String),
    );
  });

  it('tick runs it once in 30 days per project', async () => {
    const fx = withCrewDir(makeFx([]));
    const p = offering({ [SP]: '7.1.0' });
    const first = JSON.parse((await cli(fx, p.ports, ['tick'])).out);
    expect(first.skillsCheck.added).toHaveLength(1);
    const calls = p.calls.length;
    expect(calls).toBeGreaterThan(0);
    p.advance(29 * 86_400_000);
    const second = JSON.parse((await cli(fx, p.ports, ['tick'])).out);
    expect(second.skillsCheck).toBeUndefined();
    expect(p.calls).toHaveLength(calls);
    p.advance(2 * 86_400_000);
    const third = JSON.parse((await cli(fx, p.ports, ['tick'])).out);
    expect(third.skillsCheck).toEqual({ added: [], raised: [], problems: expect.any(Array) });
    expect(p.calls.length).toBeGreaterThan(calls);
    expect(updateItems(fx)).toHaveLength(1);
  });
});

describe('studio account', () => {
  const TOKEN = `fake-value-cli-account-${'z'.repeat(30)}`;
  /** A claude that records plugin calls and their environment instead of running. */
  const withPlugins = (code = 0) => {
    const p = makePorts();
    const calls: { args: string[]; env: Record<string, string>; cwd: string }[] = [];
    const ports: Ports = {
      ...p.ports,
      plugins: {
        run: async (args, env, cwd) => {
          calls.push({ args, env, cwd });
          return { code, stdout: '', stderr: code === 0 ? '' : 'failed' };
        },
      },
    };
    return { ports, calls };
  };
  const owner = (fx: Fx) => ({ homedir: fx.home, env: fx.env });
  const terminal = (token = TOKEN) => ({ isTerminal: true, readSecret: async () => token });

  it('add stores the token hidden, makes it active and sets up the plugins once', async () => {
    const fx = makeFx();
    const { ports, calls } = withPlugins();
    const r = await cli(fx, ports, ['account', 'add', 'work'], terminal());
    expect(r.code).toBe(0);
    expect(`${r.out}${r.err}`).not.toContain(TOKEN);
    expect(activeLabel(owner(fx))).toBe('work');
    expect(calls).toHaveLength(5);
    for (const c of calls) {
      expect(c.env.CLAUDE_CONFIG_DIR).toBe(join(fx.ownerDir, 'claude'));
      expect(Object.values(c.env).join(' ')).not.toContain(TOKEN);
      expect(c.cwd).toBe(join(fx.ownerDir, 'claude'));
    }
    expect(statSync(join(fx.ownerDir, 'claude')).mode & 0o777).toBe(0o700);
    await cli(fx, ports, ['account', 'add', 'spare'], terminal());
    expect(calls).toHaveLength(5);
  });

  it('add needs a terminal, the owner and a value; a wrong value stores nothing', async () => {
    const fx = makeFx();
    const { ports } = withPlugins();
    expect(
      (await cli(fx, ports, ['account', 'add', 'work'], { readSecret: async () => TOKEN })).code,
    ).toBe(1);
    fx.env.STUDIO_ROLE = 'crew';
    expect((await cli(fx, ports, ['account', 'add', 'work'], terminal())).code).toBe(1);
    delete fx.env.STUDIO_ROLE;
    const bad = await cli(fx, ports, ['account', 'add', 'work'], terminal('short'));
    expect(bad.code).toBe(1);
    expect(bad.err).not.toContain('short');
    expect(existsSync(join(fx.ownerDir, 'tokens', 'work.json'))).toBe(false);
    expect((await cli(fx, ports, ['account', 'add', '../x'], terminal())).code).toBe(1);
  });

  it('failed plugin setup keeps the token and names setup-plugins', async () => {
    const fx = makeFx();
    const { ports } = withPlugins(1);
    const r = await cli(fx, ports, ['account', 'add', 'work'], terminal());
    expect(r.code).toBe(1);
    expect(r.err).toContain('studio account setup-plugins');
    expect(existsSync(join(fx.ownerDir, 'tokens', 'work.json'))).toBe(true);
    const again = withPlugins();
    expect(
      (await cli(fx, again.ports, ['account', 'setup-plugins'], { isTerminal: true })).code,
    ).toBe(0);
    expect(again.calls).toHaveLength(5);
  });

  it('list shows labels, dates, the active one and the state, never a token', async () => {
    const fx = makeFx();
    const { ports } = withPlugins();
    await cli(fx, ports, ['account', 'add', 'work'], terminal());
    await cli(fx, ports, ['account', 'add', 'spare'], terminal());
    const r = await cli(fx, ports, ['account', 'list', '--json']);
    expect(r.out).not.toContain(TOKEN);
    const rows = JSON.parse(r.out).accounts;
    expect(rows.map((x: { label: string }) => x.label)).toEqual(['spare', 'work']);
    expect(rows.find((x: { label: string }) => x.label === 'work')).toMatchObject({
      active: true,
      state: 'free',
      expiry: 'ok',
      runsToday: 0,
    });
    const text = await cli(fx, ports, ['account', 'list']);
    expect(text.out).toMatch(/work.*active/);
  });

  it('list marks a parked account and warns near the end of the year', async () => {
    const fx = makeFx();
    const { ports } = withPlugins();
    addAccount(owner(fx), 'old', TOKEN, new Date('2025-11-20T00:00:00Z'));
    mkdirSync(fx.owner, { recursive: true });
    writeFileSync(
      join(fx.owner, 'limits.json'),
      JSON.stringify({ old: { parkedUntil: '2999-01-01T00:00:00.000Z', kind: 'session' } }),
    );
    const rows = JSON.parse((await cli(fx, ports, ['account', 'list', '--json'])).out).accounts;
    expect(rows[0]).toMatchObject({ label: 'old', expiry: 'soon' });
    expect(rows[0].state).toMatch(/^parked until/);
    expect((await cli(fx, ports, ['account', 'list'])).out).toMatch(/expires .*claude setup-token/);
  });

  it('use switches the active label, only in a terminal, only to an existing one', async () => {
    const fx = makeFx();
    const { ports } = withPlugins();
    await cli(fx, ports, ['account', 'add', 'work'], terminal());
    await cli(fx, ports, ['account', 'add', 'spare'], terminal());
    expect((await cli(fx, ports, ['account', 'use', 'spare'])).code).toBe(1);
    expect((await cli(fx, ports, ['account', 'use', 'spare'], terminal())).code).toBe(0);
    expect(activeLabel(owner(fx))).toBe('spare');
    expect((await cli(fx, ports, ['account', 'use', 'none'], terminal())).code).toBe(1);
  });

  it('remove refuses while a crew runs on the label, then removes it', async () => {
    const fx = makeFx();
    const { ports } = withPlugins();
    await cli(fx, ports, ['account', 'add', 'work'], terminal());
    for (const s of ['studio-crew', 'test-driven-development', 'systematic-debugging']) {
      mkdirSync(join(fx.ownerDir, 'claude', 'skills', s), { recursive: true });
      writeFileSync(join(fx.ownerDir, 'claude', 'skills', s, 'SKILL.md'), '---\nname: x\n---\n');
    }
    await cli(fx, ports, ['launch', 'APP-1']);
    const busy = await cli(fx, ports, ['account', 'remove', 'work'], terminal());
    expect(busy.code).toBe(1);
    expect(busy.err).toMatch(/running/);
    await cli(fx, ports, ['stop', 'APP-1']);
    expect((await cli(fx, ports, ['account', 'remove', 'work'])).code).toBe(1);
    expect((await cli(fx, ports, ['account', 'remove', 'work'], terminal())).code).toBe(0);
    expect(existsSync(join(fx.ownerDir, 'tokens', 'work.json'))).toBe(false);
  });

  it('setup-plugins is for the owner in a terminal', async () => {
    const fx = makeFx();
    const { ports, calls } = withPlugins();
    expect((await cli(fx, ports, ['account', 'setup-plugins'])).code).toBe(1);
    expect(calls).toHaveLength(0);
    expect((await cli(fx, ports, ['account', 'setup-plugins'], { isTerminal: true })).code).toBe(0);
    expect(calls).toHaveLength(5);
  });

  describe('pinned versions', () => {
    /** A claude whose `plugin list --json` reports `versions`, one list per call. */
    const listing = (...versions: Record<string, string>[]) => {
      const p = makePorts();
      const calls: string[] = [];
      let lists = 0;
      const ports: Ports = {
        ...p.ports,
        plugins: {
          run: async (args) => {
            calls.push(args.join(' '));
            if (args[1] !== 'list') return { code: 0, stdout: '', stderr: '' };
            const v = versions[Math.min(lists++, versions.length - 1)] ?? {};
            const out = Object.entries(v).map(([id, version]) => ({ id, version, enabled: true }));
            return { code: 0, stdout: JSON.stringify(out), stderr: '' };
          },
        },
      };
      return { ports, calls };
    };
    const SP = 'superpowers@superpowers-marketplace';
    const ST = 'studio@studio-marketplace';
    const pinned = { [SP]: '7.0.2', [ST]: STUDIO_VERSION };

    it('installs the pinned plugins and checks what was installed', async () => {
      const fx = makeFx();
      const { ports, calls } = listing(pinned);
      const r = await cli(fx, ports, ['account', 'setup-plugins'], { isTerminal: true });
      expect(r.code).toBe(0);
      expect(calls).toEqual([
        'plugin marketplace add https://github.com/obra/superpowers-marketplace.git',
        'plugin marketplace add https://github.com/Besser-Sehen-Landshut/studio.git',
        `plugin install ${SP}`,
        `plugin install ${ST}`,
        'plugin list --json',
      ]);
      expect(r.out).toContain(`${SP} 7.0.2`);
    });

    it('a crew dir set up before: "already added" and "already installed" count as done', async () => {
      const fx = makeFx();
      const base = listing(pinned);
      const calls: string[] = [];
      const ports: Ports = {
        ...base.ports,
        plugins: {
          run: async (args, env, cwd, opts) => {
            calls.push(args.join(' '));
            if (args[1] === 'marketplace') {
              return { code: 1, stdout: '', stderr: 'Marketplace is already added' };
            }
            if (args[1] === 'install') {
              return { code: 1, stdout: 'Plugin is already installed', stderr: '' };
            }
            return (base.ports.plugins as NonNullable<Ports['plugins']>).run(args, env, cwd, opts);
          },
        },
      };
      const r = await cli(fx, ports, ['account', 'setup-plugins'], { isTerminal: true });
      expect(r.code).toBe(0);
      expect(calls.at(-1)).toBe('plugin list --json');
      // Any other failure still fails.
      const failing: Ports = {
        ...base.ports,
        plugins: { run: async () => ({ code: 1, stdout: '', stderr: 'network down' }) },
      };
      expect(
        (await cli(fx, failing, ['account', 'setup-plugins'], { isTerminal: true })).code,
      ).toBe(1);
    });

    it('another version is updated once; still another one fails, naming both', async () => {
      const fx = makeFx();
      const old = { ...pinned, [SP]: '7.0.1' };
      const fixed = listing(old, pinned);
      expect(
        (await cli(fx, fixed.ports, ['account', 'setup-plugins'], { isTerminal: true })).code,
      ).toBe(0);
      expect(fixed.calls.slice(-2)).toEqual([`plugin update ${SP}`, 'plugin list --json']);
      const stuck = listing(old);
      const r = await cli(fx, stuck.ports, ['account', 'setup-plugins'], { isTerminal: true });
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/superpowers@superpowers-marketplace is 7\.0\.1, pinned 7\.0\.2/);
      expect(r.err).toMatch(/takes no version/);
    });

    const PG = `${STUDIO_YAML}plugins:\n  - { name: ${SP}, version: 7.1.0 }\n  - { name: pg@aiguide, version: 1.0.0 }\n`;
    const allowPg = (fx: Fx) => {
      mkdirSync(fx.ownerDir, { recursive: true });
      writeFileSync(
        join(fx.ownerDir, 'config.yaml'),
        'allowed_plugins:\n  - { name: pg@aiguide, marketplace: "https://github.com/acme/aiguide" }\n',
      );
    };

    it('a version pin in studio.yaml is what gets installed and checked', async () => {
      const fx = makeFx(['APP-1'], PG);
      allowPg(fx);
      const { ports, calls } = listing({ ...pinned, [SP]: '7.1.0', 'pg@aiguide': '1.0.0' });
      expect((await cli(fx, ports, ['account', 'setup-plugins'], { isTerminal: true })).code).toBe(
        0,
      );
      // The marketplace of an extra plugin comes from the owner config, never from studio.yaml.
      expect(calls).toContain('plugin marketplace add https://github.com/acme/aiguide');
      expect(calls).toContain('plugin install pg@aiguide');
    });

    it('a new plugin the owner did not allow is not installed', async () => {
      const fx = makeFx(['APP-1'], PG);
      const { ports, calls } = listing({ ...pinned, [SP]: '7.1.0' });
      const r = await cli(fx, ports, ['account', 'setup-plugins'], { isTerminal: true });
      expect(r.code).toBe(0);
      expect(calls.some((c) => c.includes('pg@aiguide') || c.includes('aiguide'))).toBe(false);
      expect(r.err).toMatch(/pg@aiguide is not installed: .*allowed_plugins in the owner config/);
    });

    it('studio.yaml that swaps the marketplace of superpowers is refused, nothing runs', async () => {
      const fx = makeFx(
        ['APP-1'],
        `${STUDIO_YAML}plugins:\n  - { name: ${SP}, version: 7.0.2, marketplace: "https://github.com/evil/superpowers-marketplace" }\n`,
      );
      const { ports, calls } = listing(pinned);
      const r = await cli(fx, ports, ['account', 'setup-plugins'], { isTerminal: true });
      expect(r.code).toBe(1);
      expect(r.err).toMatch(
        /may not change the marketplace of superpowers@superpowers-marketplace/,
      );
      expect(calls).toEqual([]);
      const doctor = JSON.parse((await cli(fx, ports, ['doctor', '--json'])).out);
      expect(doctor.pluginProblem).toMatch(/may not change the marketplace/);
    });
  });

  it('remove refuses while a launch holds the launch lock', async () => {
    const fx = makeFx();
    const { ports } = withPlugins();
    await cli(fx, ports, ['account', 'add', 'work'], terminal());
    mkdirSync(fx.owner, { recursive: true });
    const lock = acquireStateLock(fx.owner, 'launch.lock', {
      now: new Date(),
      heartbeatStaleMs: 60_000,
    });
    try {
      const r = await cli(fx, ports, ['account', 'remove', 'work'], terminal());
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/launch/);
      expect(existsSync(join(fx.ownerDir, 'tokens', 'work.json'))).toBe(true);
    } finally {
      lock?.release();
    }
  });

  it('removing the last account says that launches use the main login again', async () => {
    const fx = makeFx();
    const { ports } = withPlugins();
    await cli(fx, ports, ['account', 'add', 'work'], terminal());
    await cli(fx, ports, ['account', 'add', 'spare'], terminal());
    const first = await cli(fx, ports, ['account', 'remove', 'spare'], terminal());
    expect(first.err).not.toMatch(/main login/);
    const last = await cli(fx, ports, ['account', 'remove', 'work'], terminal());
    expect(last.code).toBe(0);
    expect(last.err).toMatch(/warning: .*no stored account is left.*main login/);
  });

  it('planning counts the room of the active account only', async () => {
    const fx = makeFx(['APP-1', 'APP-2']);
    const { ports } = withPlugins();
    await cli(fx, ports, ['account', 'add', 'work'], terminal());
    await cli(fx, ports, ['account', 'add', 'spare'], terminal());
    mkdirSync(fx.owner, { recursive: true });
    writeFileSync(
      join(fx.owner, 'limits.json'),
      JSON.stringify({ work: { parkedUntil: '2999-01-01T00:00:00.000Z', kind: 'session' } }),
    );
    const plan = JSON.parse((await cli(fx, ports, ['plan'])).out);
    expect(plan.assign).toEqual([]);
  });

  it('doctor names the accounts, the active one and the way crews log in', async () => {
    const fx = makeFx();
    const { ports } = withPlugins();
    const none = JSON.parse((await cli(fx, ports, ['doctor', '--json'])).out);
    expect(none.claudeLogin).toBe('main login (~/.claude or CLAUDE_CONFIG_DIR)');
    await cli(fx, ports, ['account', 'add', 'work'], terminal());
    const doc = JSON.parse((await cli(fx, ports, ['doctor', '--json'])).out);
    expect(doc.claudeLogin).toBe('account work');
    expect(doc.accounts).toEqual([
      expect.objectContaining({ label: 'work', active: true, expiry: 'ok' }),
    ]);
    expect(JSON.stringify(doc)).not.toContain(TOKEN);
    provider(fx, JSON.stringify({ label: 'p', env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN } }));
    const text = await cli(fx, ports, ['doctor']);
    expect(text.out).toMatch(/claude login: credential provider \(it comes before the accounts\)/);
    expect(text.out).not.toContain(TOKEN);
  });
});

describe('studio doctor', () => {
  const STRICT = STUDIO_YAML.replace(
    'allow_ambient_credentials: true',
    'allow_ambient_credentials: false',
  );
  const VALUE = 'fake-value-doctor-a61f';

  it('required crew token missing: exit 1, says what is missing', async () => {
    const fx = makeFx(['APP-1'], STRICT);
    const r = await cli(fx, makePorts().ports, ['doctor']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/crew token: missing/);
    expect(r.out).toMatch(/studio\.yaml: readable/);
    expect(r.out).toMatch(/credential provider: not configured/);
    expect(r.out).toMatch(/allow_api_billing: off/);
  });

  it('allow_ambient_credentials makes the token optional', async () => {
    const fx = makeFx();
    const r = await cli(fx, makePorts().ports, ['doctor']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/crew token: missing/);
  });

  it('lists the token source and API key names, never values', async () => {
    const fx = makeFx(['APP-1'], STRICT);
    mkdirSync(fx.ownerDir, { recursive: true });
    writeFileSync(join(fx.ownerDir, 'crew-token'), `${VALUE}\n`, { mode: 0o600 });
    fx.env.ANTHROPIC_API_KEY = VALUE;
    const r = await cli(fx, makePorts().ports, ['doctor']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/crew token: set \(file\)/);
    expect(r.out).toContain('ANTHROPIC_API_KEY');
    expect(r.out).not.toContain(VALUE);
    fx.env.STUDIO_T = VALUE;
    writeFileSync(
      join(fx.project, '.studio', 'studio.yaml'),
      `${STRICT}crew_token: { env: STUDIO_T }\n`,
    );
    const v = await cli(fx, makePorts().ports, ['doctor', '--json']);
    expect(v.out).not.toContain(VALUE);
    expect(JSON.parse(v.out).crewToken).toMatchObject({ status: 'set', source: 'env STUDIO_T' });
  });

  it('a token file with a wide mode counts as missing', async () => {
    const fx = makeFx(['APP-1'], STRICT);
    mkdirSync(fx.ownerDir, { recursive: true });
    writeFileSync(join(fx.ownerDir, 'crew-token'), `${VALUE}\n`, { mode: 0o644 });
    const r = await cli(fx, makePorts().ports, ['doctor']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/crew token: invalid/);
  });

  it('survives an unreadable studio.yaml and an invalid owner config', async () => {
    const fx = makeFx();
    rmSync(join(fx.project, '.studio', 'studio.yaml'));
    mkdirSync(fx.ownerDir, { recursive: true });
    writeFileSync(join(fx.ownerDir, 'config.yaml'), 'nonsense_key: 1\n');
    const r = await cli(fx, makePorts().ports, ['doctor']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/studio\.yaml: not readable/);
    expect(r.out).toMatch(/owner config: invalid/);
  });

  it('shows the configured provider path', async () => {
    const fx = makeFx();
    provider(fx, tokenLine('label-a'));
    const r = await cli(fx, makePorts().ports, ['doctor']);
    expect(r.out).toMatch(/credential provider: configured .*provider-/);
  });

  describe('the project checkout', () => {
    it('a git checkout with origin reads fine', async () => {
      const r = JSON.parse((await cli(makeFx(), makePorts().ports, ['doctor', '--json'])).out);
      expect(r.projectCheckout).toBe('git checkout with origin');
    });
    it('a folder that is not a git checkout says so and what to do', async () => {
      const fx = makeFx();
      rmSync(join(fx.project, '.git'), { recursive: true, force: true });
      const r = await cli(fx, makePorts().ports, ['doctor']);
      expect(r.out).toMatch(/project checkout: not a git checkout/);
      expect(r.out).toMatch(/clone/);
    });
    it('a checkout without origin says so', async () => {
      const fx = makeFx();
      execFileSync('git', ['remote', 'remove', 'origin'], { cwd: fx.project });
      const r = await cli(fx, makePorts().ports, ['doctor']);
      expect(r.out).toMatch(/project checkout: no remote origin/);
    });
  });

  describe('tools crews run', () => {
    it('a tool on PATH below the home and outside crew_toolchain_paths is named', async () => {
      const fx = makeFx();
      const bin = join(fx.home, '.cargo', 'bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, 'cargo'), '#!/bin/sh\n', { mode: 0o755 });
      fx.env.PATH = `${bin}:${process.env.PATH}`;
      const r = await cli(fx, makePorts().ports, ['doctor']);
      expect(r.out).toMatch(/toolchain: cargo .*outside crew_toolchain_paths/);
      mkdirSync(fx.ownerDir, { recursive: true });
      writeFileSync(join(fx.ownerDir, 'config.yaml'), `crew_toolchain_paths: [${bin}]\n`);
      const ok = await cli(fx, makePorts().ports, ['doctor']);
      expect(ok.out).not.toMatch(/toolchain: cargo/);
    });
  });

  describe('the git the merge check needs', () => {
    const withGit = (run: () => string) => {
      const p = makePorts();
      return { ...p.ports, git: { run: async () => run() } };
    };
    it.each<[string, string]>([
      ['git version 2.38.0', 'git: 2.38.0'],
      ['git version 2.54.0 (Apple Git-157)', 'git: 2.54.0'],
      ['git version 3.0.0', 'git: 3.0.0'],
    ])('%s is enough', async (version, line) => {
      const r = await cli(
        makeFx(),
        withGit(() => version),
        ['doctor'],
      );
      expect(r.out).toContain(line);
      expect(r.out).not.toContain('too old');
    });
    it('2.37 is too old, and says what it blocks', async () => {
      const r = await cli(
        makeFx(),
        withGit(() => 'git version 2.37.9'),
        ['doctor'],
      );
      expect(r.out).toMatch(/git: 2\.37\.9 \(too old: 2\.38 or newer/);
    });
    it('no git reads cannot tell', async () => {
      const r = await cli(
        makeFx(),
        withGit(() => {
          throw new Error('no git');
        }),
        ['doctor'],
      );
      expect(r.out).toContain('git: cannot tell');
    });
  });

  describe('plugins a crew needs', () => {
    const skill = (dir: string, name: string) => {
      mkdirSync(join(dir, 'skills', name), { recursive: true });
      writeFileSync(join(dir, 'skills', name, 'SKILL.md'), '---\nname: x\n---\n');
    };
    const loginWith = (fx: Fx, ...skills: string[]) => {
      const login = join(fx.ownerDir, 'accounts', 'label-a');
      mkdirSync(login, { recursive: true });
      for (const s of skills) skill(login, s);
      provider(fx, JSON.stringify({ label: 'label-a', env: { CLAUDE_CONFIG_DIR: login } }));
      return login;
    };

    it('looks in the config dir of the provider, not in the default one', async () => {
      const fx = makeFx();
      skill(join(fx.home, '.claude'), 'studio-crew');
      skill(join(fx.home, '.claude'), 'test-driven-development');
      const login = loginWith(fx);
      const r = await cli(fx, makePorts().ports, ['doctor', '--json']);
      expect(JSON.parse(r.out)).toMatchObject({
        superpowers: 'not found',
        studioCrew: 'not found',
      });
      const text = await cli(fx, makePorts().ports, ['doctor']);
      expect(text.out).toContain(`CLAUDE_CONFIG_DIR=${login} claude plugin install studio@`);
    });

    it('shows each pinned plugin with the version installed in the config dir', async () => {
      const fx = makeFx();
      const login = loginWith(fx, 'studio-crew', 'test-driven-development');
      mkdirSync(join(login, 'plugins'), { recursive: true });
      writeFileSync(
        join(login, 'plugins', 'installed_plugins.json'),
        JSON.stringify({
          version: 2,
          plugins: {
            'superpowers@superpowers-marketplace': [{ scope: 'user', version: '7.0.1' }],
            'studio@studio-marketplace': [{ scope: 'user', version: STUDIO_VERSION }],
          },
        }),
      );
      const json = JSON.parse((await cli(fx, makePorts().ports, ['doctor', '--json'])).out);
      expect(json.plugins).toEqual([
        { name: 'superpowers@superpowers-marketplace', pinned: '7.0.2', installed: '7.0.1' },
        { name: 'studio@studio-marketplace', pinned: STUDIO_VERSION, installed: STUDIO_VERSION },
      ]);
      const text = (await cli(fx, makePorts().ports, ['doctor'])).out;
      expect(text).toContain(
        'plugin superpowers@superpowers-marketplace: pinned 7.0.2, installed 7.0.1 (a launch refuses',
      );
      expect(text).toContain(
        `plugin studio@studio-marketplace: pinned ${STUDIO_VERSION}, installed ${STUDIO_VERSION}\n`,
      );
    });

    it('both installed in the provider dir read installed, with no hint', async () => {
      const fx = makeFx();
      loginWith(fx, 'studio-crew', 'test-driven-development');
      const r = await cli(fx, makePorts().ports, ['doctor']);
      expect(r.out).toContain('superpowers: installed');
      expect(r.out).toContain('studio plugin: installed');
      expect(r.out).not.toContain('claude plugin install');
    });

    it('the Studio plugin missing from the default dir gets the hint', async () => {
      const fx = makeFx();
      skill(join(fx.home, '.claude'), 'test-driven-development');
      const r = await cli(fx, makePorts().ports, ['doctor']);
      expect(r.out).toContain('studio plugin: not found');
      expect(r.out).toContain('claude plugin install studio@studio-marketplace');
    });

    it('a provider that gives nothing reads cannot tell', async () => {
      const fx = makeFx();
      provider(fx, '');
      const r = await cli(fx, makePorts().ports, ['doctor']);
      expect(r.out).toContain('superpowers: cannot tell');
      expect(r.out).toContain('studio plugin: cannot tell');
    });
  });
});
