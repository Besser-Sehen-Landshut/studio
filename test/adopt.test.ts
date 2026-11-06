import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { acquireStateLock, stateBaseFor, stateRootFor } from '../src/paths.js';
import type { Claude, Ports } from '../src/ports.js';
import { realPorts } from '../src/ports.js';
import { RUN_LOCK } from '../src/queue.js';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'studio-adopt-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let n = 0;
interface Fx {
  project: string;
  home: string;
  env: Record<string, string | undefined>;
  /** The current project's state root (not created yet). */
  to: string;
  /** An earlier state root of the same repository, full of history and run leftovers. */
  from: string;
}

function makeFx(opts: { origin?: string; oldOrigin?: string } = {}): Fx {
  const base = join(tmp, `p${n++}`);
  const home = join(base, 'home');
  const project = join(base, 'moved', 'app');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(project, '.studio'), { recursive: true });
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'remote', 'add', 'origin', opts.origin ?? 'https://github.com/org/app');
  writeFileSync(join(project, '.studio', 'studio.yaml'), 'studio: 1\n');
  const env = { PATH: process.env.PATH };
  const to = stateRootFor(project, { env, homedir: home });
  const from = join(stateBaseFor({ env, homedir: home }), '0123456789abcdef-app');
  mkdirSync(join(from, 'clones', 'APP-1'), { recursive: true });
  mkdirSync(join(from, 'logs'), { recursive: true });
  mkdirSync(join(from, 'briefs'), { recursive: true });
  writeFileSync(join(from, 'clones', 'APP-1', 'file.txt'), 'clone\n');
  writeFileSync(join(from, 'logs', 'APP-1.jsonl'), '{}\n');
  writeFileSync(
    join(from, 'marker.json'),
    JSON.stringify({
      projectRealpath: join(base, 'old', 'app'),
      originUrl: opts.oldOrigin ?? 'git@github.com:org/app.git',
    }),
  );
  writeFileSync(join(from, 'metrics.jsonl'), '{"kind":"merged","at":"2026-10-01"}\n');
  writeFileSync(join(from, 'costs.json'), '{"runs":{}}\n');
  writeFileSync(join(from, 'lessons.json'), '{"proposals":[]}\n');
  writeFileSync(join(from, 'skills-check.json'), '{"at":"2026-10-01T00:00:00Z"}\n');
  writeFileSync(join(from, 'exceptions.jsonl'), '{"rule":"a"}\n');
  writeFileSync(join(from, 'releases.json'), '[]\n');
  writeFileSync(join(from, 'rea-allow.json'), '{"APP-3":["debug"]}\n');
  writeFileSync(
    join(from, 'queue.json'),
    JSON.stringify({
      pending: [{ pr: 9, repo: 'org/app' }],
      done: [{ pr: 7, repo: 'org/app', result: 'merged', at: '2026-10-02T00:00:00Z' }],
    }),
  );
  writeFileSync(join(from, 'crew.json'), JSON.stringify({}));
  writeFileSync(join(from, 'state.json'), '{}\n');
  return { project, home, env, to, from };
}

function fakePorts(alive: number[] = []): Ports {
  const claude: Claude = {
    start: async () => ({ pid: 1 }),
    alive: (pid) => alive.includes(pid),
    identity: async (pid) => `start-${pid}`,
    stop: async () => {},
  };
  return {
    ...realPorts(),
    gh: {
      api: async () => {
        throw new Error('adopt calls no gh');
      },
      run: async () => {
        throw new Error('adopt calls no gh');
      },
    },
    claude,
    clock: { now: () => new Date('2026-11-06T10:00:00Z'), sleep: async () => {} },
  };
}

async function adopt(
  fx: Fx,
  argv: string[],
  o: { isTerminal?: boolean; env?: Record<string, string>; ports?: Ports } = {},
) {
  let out = '';
  let err = '';
  const code = await runCli(['--project', fx.project, 'adopt', ...argv], {
    ports: o.ports ?? fakePorts(),
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
    env: { ...fx.env, ...o.env },
    homedir: fx.home,
    cwd: fx.project,
    isTerminal: o.isTerminal ?? true,
  });
  return {
    code,
    out,
    err,
    json: code === 0 && argv.includes('--json') ? JSON.parse(out) : undefined,
  };
}

/** Every file below `dir` with its content: what a command changed there shows as a difference. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[p.slice(dir.length)] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

describe('studio adopt', () => {
  it('is the owner’s, in a terminal; refused for crews and without one', async () => {
    const fx = makeFx();
    const r1 = await adopt(fx, ['--from', fx.from], { isTerminal: false });
    expect(r1.code).toBe(1);
    expect(r1.err).toMatch(/owner and needs a terminal/);
    const r2 = await adopt(fx, ['--from', fx.from], { env: { STUDIO_ROLE: 'crew' } });
    expect(r2.code).toBe(1);
    expect(existsSync(fx.to)).toBe(false);
  });

  it('needs --from; --apply belongs to adopt and gc only', async () => {
    const fx = makeFx();
    expect((await adopt(fx, [])).err).toMatch(/adopt needs --from/);
    let err = '';
    await runCli(['--project', fx.project, 'status', '--apply'], {
      ports: fakePorts(),
      stdout: () => {},
      stderr: (s) => {
        err += s;
      },
      env: fx.env,
      homedir: fx.home,
      cwd: fx.project,
    });
    expect(err).toMatch(/--apply works with adopt and gc only/);
  });

  it('is a dry run by default: lists what it would take and writes nothing', async () => {
    const fx = makeFx();
    const before = snapshot(join(fx.home));
    const r = await adopt(fx, ['--from', fx.from, '--json']);
    expect(r.code).toBe(0);
    expect(r.json.applied).toBe(false);
    expect(
      r.json.files.map((f: { name: string; action: string }) => `${f.action} ${f.name}`),
    ).toEqual([
      'copy metrics.jsonl',
      'copy costs.json',
      'copy lessons.json',
      'copy skills-check.json',
      'copy exceptions.jsonl',
      'copy releases.json',
      'copy rea-allow.json',
      'merge queue.json (done)',
    ]);
    expect(r.json.next).toBe(`studio adopt --from ${fx.from} --apply`);
    expect(snapshot(fx.home)).toEqual(before);
    expect(existsSync(fx.to)).toBe(false);
  });

  it('with --apply copies the history, never clones, crew records, logs or locks, and keeps the old root', async () => {
    const fx = makeFx();
    const old = snapshot(fx.from);
    const r = await adopt(fx, ['--from', fx.from, '--apply']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\(applied\)/);
    expect(r.out).toContain(`rm -rf -- ${fx.from}`);
    expect(r.out).toMatch(/1 pending queue entries stay behind/);
    for (const f of [
      'metrics.jsonl',
      'costs.json',
      'lessons.json',
      'skills-check.json',
      'exceptions.jsonl',
      'releases.json',
      'rea-allow.json',
    ]) {
      expect(readFileSync(join(fx.to, f), 'utf8'), f).toBe(readFileSync(join(fx.from, f), 'utf8'));
    }
    const queue = JSON.parse(readFileSync(join(fx.to, 'queue.json'), 'utf8'));
    expect(queue.pending).toEqual([]);
    expect(queue.done).toEqual([
      { pr: 7, repo: 'org/app', result: 'merged', at: '2026-10-02T00:00:00Z' },
    ]);
    for (const never of ['clones', 'logs', 'briefs', 'crew.json', 'state.json']) {
      expect(existsSync(join(fx.to, never)), never).toBe(false);
    }
    expect(readdirSync(fx.to).filter((e) => e.endsWith('.lock'))).toEqual([]);
    // This root is bound to this project, the old one is left exactly as it was.
    expect(JSON.parse(readFileSync(join(fx.to, 'marker.json'), 'utf8')).projectRealpath).toBe(
      realpathSync(fx.project),
    );
    expect(snapshot(fx.from)).toEqual(old);
  });

  it('is idempotent: a second apply changes nothing', async () => {
    const fx = makeFx();
    await adopt(fx, ['--from', fx.from, '--apply']);
    const after = snapshot(fx.to);
    const r = await adopt(fx, ['--from', fx.from, '--apply', '--json']);
    expect(r.code).toBe(0);
    expect(r.json.applied).toBe(false);
    expect(new Set(r.json.files.map((f: { action: string }) => f.action))).toEqual(
      new Set(['same']),
    );
    expect(snapshot(fx.to)).toEqual(after);
  });

  it('merges append-only logs line by line and keeps a differing JSON file', async () => {
    const fx = makeFx();
    mkdirSync(fx.to, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(fx.to, 'marker.json'),
      JSON.stringify({
        projectRealpath: realpathSync(fx.project),
        originUrl: 'https://github.com/org/app',
      }),
    );
    writeFileSync(join(fx.to, 'metrics.jsonl'), '{"kind":"merged","at":"2026-11-01"}\n');
    writeFileSync(join(fx.to, 'costs.json'), '{"runs":{"x":1}}\n');
    const r = await adopt(fx, ['--from', fx.from, '--apply', '--json']);
    expect(r.code).toBe(1); // a conflict needs the owner's eye
    const r2 = await adopt(fx, ['--from', fx.from, '--json']);
    expect(r2.code).toBe(1);
    expect(readFileSync(join(fx.to, 'metrics.jsonl'), 'utf8')).toBe(
      '{"kind":"merged","at":"2026-10-01"}\n{"kind":"merged","at":"2026-11-01"}\n',
    );
    expect(readFileSync(join(fx.to, 'costs.json'), 'utf8')).toBe('{"runs":{"x":1}}\n');
    expect(r.out).toMatch(/conflict/);
  });

  it('takes another spelling of the same origin and refuses another repository', async () => {
    const fx = makeFx({
      origin: 'https://github.com/Org/App.git/',
      oldOrigin: 'git@github.com:org/app.git',
    });
    expect((await adopt(fx, ['--from', fx.from])).code).toBe(0);
    const other = makeFx({ oldOrigin: 'git@github.com:org/other.git' });
    const r = await adopt(other, ['--from', other.from, '--apply']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/github.com\/org\/other.*github.com\/org\/app.*same repository/);
    expect(existsSync(other.to)).toBe(false);
  });

  it('refuses a folder that is no state root, and the project’s own root', async () => {
    const fx = makeFx();
    rmSync(join(fx.from, 'marker.json'));
    expect((await adopt(fx, ['--from', fx.from])).err).toMatch(/no marker.json/);
    expect((await adopt(fx, ['--from', join(tmp, 'nowhere')])).err).toMatch(/not a state root/);
    mkdirSync(fx.to, { recursive: true });
    expect((await adopt(fx, ['--from', fx.to])).err).toMatch(/own state root/);
  });

  it('refuses while a crew is alive in either root', async () => {
    const fx = makeFx();
    const rec = {
      name: 'crew-APP-1',
      item: 'APP-1',
      role: 'builder',
      pid: 4242,
      log: 'x',
      startedAt: '2026-11-06T09:00:00Z',
      identity: 'start-4242',
    };
    writeFileSync(join(fx.from, 'crew.json'), JSON.stringify({ 'APP-1': rec }));
    const r = await adopt(fx, ['--from', fx.from, '--apply'], { ports: fakePorts([4242]) });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/old root: crew crew-APP-1 of APP-1 is alive; nothing changed/);
    expect(existsSync(fx.to)).toBe(false);
    // Ended: nothing holds it any more.
    expect((await adopt(fx, ['--from', fx.from], { ports: fakePorts([]) })).code).toBe(0);
  });

  it('refuses while a queue run is active in either root', async () => {
    const fx = makeFx();
    const lock = acquireStateLock(fx.from, RUN_LOCK, {
      now: new Date(),
      heartbeatStaleMs: 15 * 60_000,
    });
    try {
      const r = await adopt(fx, ['--from', fx.from, '--apply']);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/old root: a queue run is active/);
    } finally {
      lock?.release();
    }
    mkdirSync(fx.to, { recursive: true, mode: 0o700 });
    const here = acquireStateLock(fx.to, RUN_LOCK, {
      now: new Date(),
      heartbeatStaleMs: 15 * 60_000,
    });
    try {
      const r = await adopt(fx, ['--from', fx.from, '--apply']);
      expect(r.err).toMatch(/this root: a queue run is active/);
    } finally {
      here?.release();
    }
  });
});
