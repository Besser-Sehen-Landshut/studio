import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import {
  type MigrationScheme,
  type MigrationUse,
  migrationCollisions,
  pullRequestMigrationCheck,
  type Register,
  readMigrationUse,
  readRegister,
  registerDoctorLine,
  releaseMigrationNumber,
  reserveIn,
  reserveMigrationNumber,
  updateRegister,
} from '../src/migration-numbers.js';
import {
  DEFAULT_NUMBER_PATTERN,
  migrationEntryOf,
  migrationNumberOf,
  numberPatternProblem,
} from '../src/migration-pattern.js';
import { acquireStateLock } from '../src/paths.js';
import type { Gh } from '../src/ports.js';

const root = mkdtempSync(join(tmpdir(), 'studio-mig-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const stateRoot = () => {
  const dir = join(root, `s${n++}`);
  mkdirSync(dir, { mode: 0o700 });
  return dir;
};

const BASE_YAML = `studio: 1
primary_repo: org/app
repos: [org/app, org/web]
ci:
  provider: github
  runners: github-hosted
  runner_labels: []
  capacity: { total: 2, merge_max_busy: 1, check_twice_seconds: 30 }
merge:
  strategy: studio-queue
  contract_paths: []
roles:
  builder: { model: strongest, wip: 1 }
`;
const parse = (extra: string) => parseConfig(`${BASE_YAML}${extra}`, 'studio.yaml');
const NOW = new Date('2026-11-06T10:00:00Z');

describe('migrations in studio.yaml', () => {
  it('reads dir, number_pattern and repo; the pattern defaults to leading digits', () => {
    const c = parse('migrations: { dir: db/migrations, number_pattern: "^\\\\d{8}(\\\\d{6})_" }\n');
    expect(c.migrations).toEqual({ dir: 'db/migrations', numberPattern: '^\\d{8}(\\d{6})_' });
    expect(parse('migrations: { dir: migrations }\n').migrations?.numberPattern).toBe(
      DEFAULT_NUMBER_PATTERN,
    );
    expect(parse('migrations: { dir: m, repo: org/web }\n').migrations?.repo).toBe('org/web');
  });

  it.each([
    ['dir: /abs/migrations', /migrations\.dir: must be a relative path/],
    ['dir: ../outside', /migrations\.dir: must be a relative path/],
    ['dir: db/migrations/', /migrations\.dir: must be a relative path/],
    ['dir: "db/./m"', /migrations\.dir: must be a relative path/],
    ['dir: m, number_pattern: "^\\\\d+_"', /exactly one capturing group.*holds 0/],
    ['dir: m, number_pattern: "^(\\\\d+)_(\\\\w+)"', /exactly one capturing group.*holds 2/],
    ['dir: m, number_pattern: "^(\\\\d+"', /not a valid regular expression/],
    ['dir: m, number_pattern: "^(\\\\d+)+_"', /must not repeat a group/],
    ['dir: m, number_pattern: ""', /1 to 200 characters/],
    ['dir: m, repo: org/other', /migrations\.repo: must be one of repos/],
    ['dir: m, numbers: x', /migrations\.numbers: unknown key/],
  ])('refuses %s', (block, message) => {
    expect(() => parse(`migrations: { ${block} }\n`)).toThrow(message);
  });

  it('a named group counts as the one capturing group', () => {
    expect(numberPatternProblem('^(?<n>\\d+)_')).toBeUndefined();
    expect(numberPatternProblem('^(?:V)(\\d+)__')).toBeUndefined();
  });
});

describe('reading a number from a name', () => {
  it.each([
    ['plain', '^(\\d+)_', '0042_add_users.sql', 42],
    ['timestamp and sequence', '^\\d{8}(\\d{6})_', '20261027000039_some_name.sql', 39],
    ['whole timestamp', '^(\\d+)_', '20240101120000_init.sql', 20240101120000],
    ['flyway', '^V(\\d+)__', 'V7__create_table.sql', 7],
    ['a folder per migration', '^(\\d+)_', '20240101120000_init', 20240101120000],
    ['sqlx up and down', '^(\\d+)_', '0003_x.down.sql', 3],
  ])('%s', (_name, pattern, entry, expected) => {
    expect(migrationNumberOf(entry, new RegExp(pattern))).toBe(expected);
  });

  it('no match, a capture that is no number, or too many digits: no number', () => {
    expect(migrationNumberOf('README.md', /^(\d+)_/)).toBeUndefined();
    expect(migrationNumberOf('abc_x.sql', /^(\w+)_/)).toBeUndefined();
    expect(migrationNumberOf(`${'1'.repeat(16)}_x.sql`, /^(\d+)_/)).toBeUndefined();
    expect(migrationNumberOf(`${'1'.repeat(300)}_x.sql`, /^(\d+)_/)).toBeUndefined();
  });

  it('the entry is the first segment below the folder', () => {
    expect(migrationEntryOf('db/m/0001_a.sql', 'db/m')).toBe('0001_a.sql');
    expect(migrationEntryOf('db/m/0001_a/migration.sql', 'db/m')).toBe('0001_a');
    expect(migrationEntryOf('db/mx/0001_a.sql', 'db/m')).toBeUndefined();
    expect(migrationEntryOf('db/m', 'db/m')).toBeUndefined();
  });
});

const SCHEME: MigrationScheme = { repo: 'org/app', dir: 'db/m', pattern: /^(\d+)_/ };
const use = (
  main: Record<number, string>,
  prs: Record<number, Record<number, string>> = {},
): MigrationUse => ({
  branch: 'main',
  main: new Map(Object.entries(main).map(([k, v]) => [Number(k), v])),
  names: new Set(Object.values(main)),
  prs: new Map(
    Object.entries(prs).map(([pr, m]) => [
      Number(pr),
      new Map(Object.entries(m).map(([k, v]) => [Number(k), v])),
    ]),
  ),
  dirOnMain: true,
});
const empty = (): Register => ({ v: 1, reservations: [] });

describe('reserving', () => {
  it('gives one above the highest number on main, in open pull requests and reserved', () => {
    const reg = empty();
    const u = use({ 1: '0001_a.sql', 7: '0007_b.sql' }, { 12: { 9: '0009_c.sql' } });
    expect(reserveIn(reg, u, { for: 'B-1', purpose: 'users table' }, NOW).number).toBe(10);
    expect(reserveIn(reg, u, { for: 'B-2', purpose: 'orders' }, NOW).number).toBe(11);
    expect(reg.reservations.map((r) => [r.number, r.for, r.status])).toEqual([
      [10, 'B-1', 'reserved'],
      [11, 'B-2', 'reserved'],
    ]);
  });

  it('starts at 1 in an empty folder', () => {
    expect(reserveIn(empty(), use({}), { for: 'B-1', purpose: 'x' }, NOW).number).toBe(1);
  });

  it('gives a requested number only when it is free', () => {
    const reg = empty();
    const u = use({ 3: '0003_a.sql' }, { 12: { 5: '0005_c.sql' } });
    expect(reserveIn(reg, u, { for: 'B-1', purpose: 'x', number: 40 }, NOW).number).toBe(40);
    expect(() => reserveIn(reg, u, { for: 'B-2', purpose: 'y', number: 3 }, NOW)).toThrow(
      /number 3 is already on main \(0003_a\.sql\); nothing reserved/,
    );
    expect(() => reserveIn(reg, u, { for: 'B-2', purpose: 'y', number: 5 }, NOW)).toThrow(
      /number 5 is used by open pull request #12/,
    );
    expect(() => reserveIn(reg, u, { for: 'B-2', purpose: 'y', number: 40 }, NOW)).toThrow(
      /number 40 is reserved for B-1 \(x\)/,
    );
    expect(reg.reservations).toHaveLength(1);
  });

  it('a released number is free again; a landed one is not', () => {
    const r = stateRoot();
    updateRegister(r, (reg) => reserveIn(reg, use({}), { for: 'B-1', purpose: 'x' }, NOW), {
      now: NOW,
    });
    expect(releaseMigrationNumber(r, 1, NOW).status).toBe('released');
    expect(() => releaseMigrationNumber(r, 1, NOW)).toThrow(/number 1 is not reserved/);
    const again = updateRegister(
      r,
      (reg) => reserveIn(reg, use({}), { for: 'B-2', purpose: 'y' }, NOW),
      { now: NOW },
    );
    expect(again.number).toBe(1);
    updateRegister(
      r,
      (reg) => reserveIn(reg, use({ 1: '0001_y.sql' }), { for: 'B-3', purpose: 'z' }, NOW),
      {
        now: NOW,
      },
    );
    expect(() => releaseMigrationNumber(r, 1, NOW)).toThrow(/landed on main/);
    expect(readRegister(r).reservations.map((x) => [x.number, x.for, x.status, x.file])).toEqual([
      [1, 'B-1', 'released', undefined],
      [1, 'B-2', 'landed', '0001_y.sql'],
      [2, 'B-3', 'reserved', undefined],
    ]);
  });

  it('refuses a holder or purpose that is not one plain line', () => {
    expect(() => reserveIn(empty(), use({}), { for: 'two words', purpose: 'x' }, NOW)).toThrow(
      /--for/,
    );
    expect(() => reserveIn(empty(), use({}), { for: 'B-1', purpose: 'a\nb' }, NOW)).toThrow(
      /--purpose/,
    );
    expect(() => reserveIn(empty(), use({}), { for: 'B-1', purpose: 'x', number: 0 }, NOW)).toThrow(
      /--number/,
    );
  });

  it('an unreadable register refuses instead of starting over', () => {
    const r = stateRoot();
    writeFileSync(join(r, 'migration-numbers.json'), '{"v":1,"reservations":[{"number":"x"}]}');
    expect(() => readRegister(r)).toThrow(/is invalid/);
    expect(() =>
      updateRegister(r, (reg) => reserveIn(reg, use({}), { for: 'B-1', purpose: 'x' }, NOW), {
        now: NOW,
      }),
    ).toThrow(/is invalid/);
  });

  it('waits for the lock and refuses when another process keeps it', () => {
    const r = stateRoot();
    // Held by this live process under another token: never stale.
    const lock = acquireStateLock(r, 'migration-numbers.lock', { now: NOW, heartbeatStaleMs: 1 });
    expect(lock).toBeDefined();
    try {
      expect(() =>
        updateRegister(r, (reg) => reserveIn(reg, use({}), { for: 'B-1', purpose: 'x' }, NOW), {
          now: NOW,
          timeoutMs: 100,
        }),
      ).toThrow(/locked/);
    } finally {
      lock?.release();
    }
    expect(readRegister(r).reservations).toEqual([]);
  });

  it('processes reserving at the same time each get their own number', async () => {
    const r = stateRoot();
    const entry = join(root, 'reserve-entry.ts');
    writeFileSync(
      entry,
      `import { updateRegister, reserveIn } from ${JSON.stringify(join(import.meta.dirname, '..', 'src', 'migration-numbers.ts'))};
const [stateRoot, who, startAt] = process.argv.slice(2);
while (Date.now() < Number(startAt)) {}
const use = { branch: 'main', main: new Map([[4, '0004_a.sql']]), names: new Set(['0004_a.sql']), prs: new Map(), dirOnMain: true };
for (let i = 0; i < 5; i++) {
  const r = updateRegister(stateRoot, (reg) => reserveIn(reg, use, { for: who + '-' + i, purpose: 'race' }, new Date()), { now: new Date(), timeoutMs: 20000 });
  process.stdout.write(r.number + '\\n');
}
`,
    );
    const out = await build({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
      logLevel: 'silent',
      // What the committed bundles do: CommonJS dependencies need a require.
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
    });
    const script = join(root, 'reserve.mjs');
    writeFileSync(script, out.outputFiles[0]?.text ?? '');
    const startAt = String(Date.now() + 1500);
    const runs = Array.from(
      { length: 6 },
      (_, i) =>
        new Promise<string>((resolve, reject) => {
          const child = spawn(process.execPath, [script, r, `S${i}`, startAt]);
          let text = '';
          child.stdout.on('data', (d) => {
            text += String(d);
          });
          child.stderr.on('data', (d) => {
            text += String(d);
          });
          child.on('error', reject);
          child.on('exit', (code) =>
            code === 0 ? resolve(text) : reject(new Error(`exit ${code}: ${text}`)),
          );
        }),
    );
    const numbers = (await Promise.all(runs)).flatMap((t) => t.trim().split('\n').map(Number));
    expect(numbers).toHaveLength(30);
    expect(new Set(numbers).size).toBe(30);
    expect([...numbers].sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i + 5));
    expect(readRegister(r).reservations).toHaveLength(30);
  }, 30_000);
});

describe('collisions of a pull request', () => {
  const reg = (): Register => ({
    v: 1,
    reservations: [
      { number: 8, for: 'B-1', purpose: 'users', at: NOW.toISOString(), status: 'reserved' },
      { number: 9, for: 'B-2', purpose: 'orders', at: NOW.toISOString(), status: 'reserved' },
    ],
  });
  const check = (files: string[], holder: string[], u = use({ 7: '0007_a.sql' })) =>
    migrationCollisions({ scheme: SCHEME, use: u, reg: reg(), pr: 30, files, holder });

  it('its own reserved number passes, as does a changed migration that is on main', () => {
    expect(check(['db/m/0008_users.sql', 'db/m/0007_a.sql', 'src/x.ts'], ['B-1'])).toEqual([]);
  });

  it('a number reserved for someone else blocks, with the holder and purpose', () => {
    expect(check(['db/m/0009_mine.sql'], ['B-1', 'crew-b-1'])).toEqual([
      '0009_mine.sql: number 9 is reserved for B-2 (orders)',
    ]);
  });

  it('a number on main under another name blocks, even when it was reserved', () => {
    expect(check(['db/m/0007_other.sql'], ['B-1'])).toEqual([
      '0007_other.sql: number 7 is already on main (0007_a.sql)',
    ]);
  });

  it('a number another open pull request uses blocks; its reservation holder passes', () => {
    const u = use({ 7: '0007_a.sql' }, { 31: { 12: '0012_x.sql', 8: '0008_y.sql' } });
    expect(check(['db/m/0012_z.sql'], ['B-1'], u)).toEqual([
      '0012_z.sql: number 12 is used by open pull request #31 (0012_x.sql)',
    ]);
    expect(check(['db/m/0008_users.sql'], ['b-1'], u)).toEqual([]);
  });

  it('a name that is not plain is quoted as data in the reason', () => {
    expect(check(['db/m/0009_say \u202e hi.sql'], [])).toEqual([
      '"0009_say ? hi.sql": number 9 is reserved for B-2 (orders)',
    ]);
  });

  it('an unreserved free number passes; the holder matches case-insensitively', () => {
    expect(check(['db/m/0013_new.sql'], [])).toEqual([]);
    expect(check(['db/m/0009_x.sql'], ['b-2'])).toEqual([]);
  });
});

/** A gh that answers like GitHub for the register's reads. */
function fakeGh(o: {
  main?: string[] | 'missing';
  open?: { number: number; files: { path: string; changeType: string }[] }[];
  prFiles?: Record<number, string[]>;
  fail?: RegExp;
}) {
  const calls: string[] = [];
  const gh: Gh = {
    api: async () => {
      throw new Error('api is not used');
    },
    run: async (args) => {
      const line = args.join(' ');
      calls.push(line);
      const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
      if (o.fail?.test(line)) return { code: 1, stdout: '', stderr: 'HTTP 502' };
      if (line === 'repo view org/app --json defaultBranchRef') {
        return ok(JSON.stringify({ defaultBranchRef: { name: 'main' } }));
      }
      if (line === 'api repos/org/app/git/trees/main%3Adb%2Fm') {
        if (o.main === 'missing')
          return { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };
        return ok(
          JSON.stringify({
            truncated: false,
            tree: (o.main ?? []).map((path) => ({ path, type: 'blob' })),
          }),
        );
      }
      if (line.startsWith('pr list --repo org/app --state open'))
        return ok(JSON.stringify(o.open ?? []));
      const m = /^api --paginate repos\/org\/app\/pulls\/(\d+)\/files/.exec(line);
      if (m) return ok((o.prFiles?.[Number(m[1])] ?? []).map((f) => JSON.stringify(f)).join('\n'));
      return { code: 1, stdout: '', stderr: `unscripted: ${line}` };
    },
  };
  return { gh, calls };
}

describe('what main and the open pull requests hold', () => {
  it('reads numbers on main and new ones in open pull requests', async () => {
    const { gh } = fakeGh({
      main: ['0001_a.sql', '0002_b.sql', 'README.md'],
      open: [
        {
          number: 5,
          files: [
            { path: 'db/m/0003_c.sql', changeType: 'ADDED' },
            { path: 'db/m/0002_b.sql', changeType: 'MODIFIED' },
            { path: 'db/m/0009_gone.sql', changeType: 'DELETED' },
          ],
        },
        { number: 6, files: [{ path: 'src/x.ts', changeType: 'MODIFIED' }] },
      ],
    });
    const u = await readMigrationUse(gh, SCHEME);
    expect([...u.main]).toEqual([
      [1, '0001_a.sql'],
      [2, '0002_b.sql'],
    ]);
    expect([...u.prs]).toEqual([[5, new Map([[3, '0003_c.sql']])]]);
  });

  it('a pull request with a full file list is read page by page', async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      path: `src/f${i}.ts`,
      changeType: 'ADDED',
    }));
    const { gh, calls } = fakeGh({
      open: [{ number: 5, files: many }],
      prFiles: { 5: [...many.map((f) => f.path), 'db/m/0004_late.sql'] },
    });
    const u = await readMigrationUse(gh, SCHEME);
    expect(u.prs.get(5)?.get(4)).toBe('0004_late.sql');
    expect(calls.some((c) => c.startsWith('api --paginate repos/org/app/pulls/5/files'))).toBe(
      true,
    );
  });

  it('a folder not on main yet holds no numbers; a read that fails throws', async () => {
    expect((await readMigrationUse(fakeGh({ main: 'missing' }).gh, SCHEME)).dirOnMain).toBe(false);
    await expect(readMigrationUse(fakeGh({ fail: /^pr list/ }).gh, SCHEME)).rejects.toThrow(
      /cannot read the open pull requests/,
    );
    await expect(readMigrationUse(fakeGh({ fail: /git\/trees/ }).gh, SCHEME)).rejects.toThrow(
      /cannot read db\/m on main/,
    );
  });

  it('reserve reads first and refuses without writing when GitHub cannot be read', async () => {
    const r = stateRoot();
    await expect(
      reserveMigrationNumber({
        gh: fakeGh({ fail: /^pr list/ }).gh,
        root: r,
        scheme: SCHEME,
        request: { for: 'B-1', purpose: 'x' },
        now: NOW,
      }),
    ).rejects.toThrow(/cannot read/);
    expect(readRegister(r).reservations).toEqual([]);
    const ok = await reserveMigrationNumber({
      gh: fakeGh({ main: ['0001_a.sql'] }).gh,
      root: r,
      scheme: SCHEME,
      request: { for: 'B-1', purpose: 'x' },
      now: NOW,
    });
    expect(ok.number).toBe(2);
  });
});

describe('the check of one pull request', () => {
  const config = parse('migrations: { dir: db/m }\n');

  it('passes a pull request outside the folder without reading main', async () => {
    const { gh, calls } = fakeGh({ prFiles: { 30: ['src/x.ts'] } });
    const r = await pullRequestMigrationCheck({
      gh,
      root: stateRoot(),
      config,
      repo: 'org/app',
      pr: 30,
      holder: ['B-1'],
      now: NOW,
    });
    expect(r).toEqual({});
    expect(calls.some((c) => c.includes('git/trees'))).toBe(false);
  });

  it('blocks a number reserved for another item and marks landed ones', async () => {
    const r = stateRoot();
    writeFileSync(
      join(r, 'migration-numbers.json'),
      JSON.stringify({
        v: 1,
        reservations: [
          { number: 2, for: 'B-9', purpose: 'old', at: NOW.toISOString(), status: 'reserved' },
          { number: 3, for: 'B-2', purpose: 'orders', at: NOW.toISOString(), status: 'reserved' },
        ],
      }),
    );
    const { gh } = fakeGh({
      main: ['0001_a.sql', '0002_b.sql'],
      open: [{ number: 30, files: [{ path: 'db/m/0003_x.sql', changeType: 'ADDED' }] }],
      prFiles: { 30: ['db/m/0003_x.sql'] },
    });
    const res = await pullRequestMigrationCheck({
      gh,
      root: r,
      config,
      repo: 'org/app',
      pr: 30,
      holder: ['B-1'],
      now: NOW,
    });
    expect(res.problem).toBe('migration number: 0003_x.sql: number 3 is reserved for B-2 (orders)');
    expect(readRegister(r).reservations.map((x) => [x.number, x.status])).toEqual([
      [2, 'landed'],
      [3, 'reserved'],
    ]);
  });

  it('cannot read GitHub: unreadable, never passed', async () => {
    const res = await pullRequestMigrationCheck({
      gh: fakeGh({ prFiles: { 30: ['db/m/0003_x.sql'] }, fail: /^pr list/ }).gh,
      root: stateRoot(),
      config,
      repo: 'org/app',
      pr: 30,
      holder: [],
      now: NOW,
    });
    expect(res.unreadable).toMatch(/cannot read/);
  });

  it('a project without the block, or another repository, is not checked', async () => {
    const { gh, calls } = fakeGh({});
    const none = parse('');
    expect(
      await pullRequestMigrationCheck({
        gh,
        root: stateRoot(),
        config: none,
        repo: 'org/app',
        pr: 1,
        holder: [],
        now: NOW,
      }),
    ).toEqual({});
    expect(
      await pullRequestMigrationCheck({
        gh,
        root: stateRoot(),
        config,
        repo: 'org/web',
        pr: 1,
        holder: [],
        now: NOW,
      }),
    ).toEqual({});
    expect(calls).toEqual([]);
  });
});

describe('the doctor line', () => {
  it('names the folder and counts, or says it is not configured or unreadable', () => {
    const r = stateRoot();
    expect(registerDoctorLine(parse(''), r)).toBe('not configured (migrations in studio.yaml)');
    const config = parse('migrations: { dir: db/m }\n');
    expect(registerDoctorLine(config, r)).toBe('db/m in org/app, 0 reserved, 0 landed');
    updateRegister(r, (reg) => reserveIn(reg, use({}), { for: 'B-1', purpose: 'x' }, NOW), {
      now: NOW,
    });
    expect(registerDoctorLine(config, r)).toBe('db/m in org/app, 1 reserved, 0 landed');
    writeFileSync(join(r, 'migration-numbers.json'), 'not json');
    expect(registerDoctorLine(config, r)).toMatch(/^unreadable: .*not valid JSON/);
    expect(readFileSync(join(r, 'migration-numbers.json'), 'utf8')).toBe('not json');
  });
});
