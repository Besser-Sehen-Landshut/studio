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
import { loadBoard } from '../src/board.js';
import { type CliDeps, runCli } from '../src/cli.js';
import { stateRootFor } from '../src/paths.js';
import { type Ports, realPorts } from '../src/ports.js';

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
  return { project, home, env, ownerDir, state: stateRootFor(project, { env, homedir: home }) };
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
  writeFileSync(f, `#!/bin/sh\ncat <<'OUT'\n${line}\nOUT\n`, { mode: 0o700 });
  writeFileSync(join(fx.ownerDir, 'config.yaml'), `crew_credential_command: ${f}\n`);
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
const limitsOf = (fx: Fx) => JSON.parse(readFileSync(join(fx.state, 'limits.json'), 'utf8'));
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
    expect(existsSync(join(fx.state, 'limits.json'))).toBe(false);
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
    writeFileSync(join(reports, 'APP-2.md'), '---\nstatus: done\n---\n');
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
      expect(existsSync(join(fx.state, 'limits.json'))).toBe(false);
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
      writeFileSync(join(reports, 'APP-1.md'), '---\nstatus: done\n---\n');
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
    expect(existsSync(join(fx.state, 'limits.json'))).toBe(false);
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
        it(`${name} with ${key} refuses the launch and starts no process`, async () => {
          const { r, started } = await planted(name, body);
          expect(r.code).toBe(1);
          expect(r.err).toContain(key);
          expect(r.err).not.toContain('fake-value');
          expect(r.err).not.toContain(TOKEN);
          expect(started).toHaveLength(1);
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
    expect(later.assign.map((i: { id: string }) => i.id)).toContain('APP-3');
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
    expect(later.assign.map((i: { id: string }) => i.id)).toEqual(['APP-1', 'APP-2']);
  });

  it('an unreadable limits file holds everything and tells the owner', async () => {
    const fx = makeFx();
    const p = makePorts();
    mkdirSync(fx.state, { recursive: true, mode: 0o700 });
    writeFileSync(join(fx.state, 'limits.json'), 'not json');
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
    expect(readFileSync(join(fx.project, '.studio', 'board.yaml'), 'utf8')).not.toContain(TOKEN);
    for (const name of ['crew.json', 'limits.json', 'state.json']) {
      expect(readFileSync(join(fx.state, name), 'utf8')).not.toContain(TOKEN);
    }
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
});
