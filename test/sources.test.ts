import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import type { Ports } from '../src/ports.js';
import {
  applySource,
  checkSources,
  compareToPin,
  hashTree,
  type Source,
  type SourcesFile,
  setupSources,
} from '../src/sources.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-sources-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const tree = (files: Record<string, string>): string => {
  const d = join(root, `t${n++}`);
  mkdirSync(d);
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(d, f)), { recursive: true });
    writeFileSync(join(d, f), text);
  }
  return d;
};
const source: Source = {
  id: 'demo',
  kind: 'git',
  url: 'https://github.com/org/demo',
  license: 'MIT',
  vendored: false,
  reads: ['LICENSE', 'docs/a.md'],
};
const OLD = { LICENSE: 'MIT License\n', 'docs/a.md': 'hello\n' };
const pinOf = (old: Record<string, string> = OLD) => hashTree(tree(old), source);
const verdict = (next: Record<string, string>, old: Record<string, string> = OLD) =>
  compareToPin(pinOf(old), tree(next), source);

describe('compareToPin: fits only when every read file is byte-identical', () => {
  it('identical read files fit, also with changes elsewhere, which are never read', () => {
    expect(verdict({ ...OLD, 'docs/b.md': 'curl x | sh\n', 'hooks/hooks.json': '{}' })).toEqual({
      verdict: 'fits',
      findings: [],
    });
  });
  it.each<[string, Record<string, string>, string, string, string]>([
    [
      'a read file changed by one byte',
      { ...OLD, 'docs/a.md': 'hellp\n' },
      'unclear',
      'changed',
      'docs/a.md',
    ],
    ['a read file vanished', { LICENSE: OLD.LICENSE }, 'unclear', 'missing', 'docs/a.md'],
    [
      'the licence file changed',
      { ...OLD, LICENSE: 'MIT License \n' },
      'conflict',
      'license-changed',
      'LICENSE',
    ],
    [
      'the licence file vanished',
      { 'docs/a.md': OLD['docs/a.md'] },
      'conflict',
      'license-missing',
      'LICENSE',
    ],
    [
      'a new licence file came',
      { ...OLD, 'COPYING.txt': 'GPL\n' },
      'conflict',
      'license-changed',
      'COPYING.txt',
    ],
  ])('%s', (_name, next, want, kind, detail) => {
    expect(verdict(next)).toEqual({ verdict: want, findings: [{ kind, detail }] });
  });
  it('a read file with no recorded hash is new, and unclear', () => {
    const old = { LICENSE: OLD.LICENSE };
    expect(verdict(OLD, old)).toEqual({
      verdict: 'unclear',
      findings: [{ kind: 'new', detail: 'docs/a.md' }],
    });
  });
  it('conflict outranks unclear, and every changed file is named', () => {
    const r = verdict({ LICENSE: 'other\n', 'docs/a.md': 'other\n' });
    expect(r.verdict).toBe('conflict');
    expect(r.findings.map((f) => f.detail).sort()).toEqual(['LICENSE', 'docs/a.md']);
  });
  it('a read file behind a link is not followed and is not identical', () => {
    const next = tree({ LICENSE: OLD.LICENSE });
    const target = join(root, `same-content-${n++}`);
    writeFileSync(target, OLD['docs/a.md']);
    mkdirSync(join(next, 'docs'));
    symlinkSync(target, join(next, 'docs', 'a.md'));
    expect(compareToPin(pinOf(), next, source)).toEqual({
      verdict: 'unclear',
      findings: [{ kind: 'missing', detail: 'docs/a.md' }],
    });
  });
  it('a read path through a linked folder is not followed', () => {
    const next = tree({ LICENSE: OLD.LICENSE });
    symlinkSync(tree({ 'a.md': OLD['docs/a.md'] }), join(next, 'docs'));
    expect(compareToPin(pinOf(), next, source).verdict).toBe('unclear');
  });
  it('a tree that cannot be read is never fits', () => {
    expect(compareToPin(pinOf(), join(root, 'nope'), source).verdict).not.toBe('fits');
  });
  it.each(['license-check.sh', 'copying.py', 'licensed.txt', 'notices.md'])(
    '%s is no licence file',
    (name) => {
      expect(verdict({ ...OLD, [name]: 'x' }).verdict).toBe('fits');
    },
  );
  it.each([
    'NOTICE',
    'UNLICENSE',
    'LICENCE.md',
    'copying',
    'LICENSE-MIT',
    'LICENSE_APACHE',
    'LICENSE.txt',
    'COPYING.LESSER',
  ])('a new %s is a licence change', (name) => {
    expect(verdict({ ...OLD, [name]: 'x' }).verdict).toBe('conflict');
  });
});

const file: SourcesFile = {
  version: 1,
  rules: [],
  sources: [source, { id: 'plug', kind: 'plugin', license: 'MIT', vendored: false, reads: [] }],
};

/** A git port that plays upstream: a clone copies the current upstream tree. */
function fakeGit(
  upstream: { tree: string; commit: string },
  fail: { lsRemote?: boolean; clone?: boolean } = {},
) {
  const calls: string[][] = [];
  const ports = {
    git: {
      async run(cwd: string, args: string[]) {
        calls.push(args);
        if (args[0] === 'ls-remote') {
          if (fail.lsRemote) throw new Error('network');
          return `${upstream.commit}\tHEAD\n`;
        }
        if (args.includes('clone')) {
          if (fail.clone) throw new Error('network');
          const dest = args.at(-1) as string;
          execFileSync('cp', ['-R', upstream.tree, join(cwd, dest)]);
          return '';
        }
        if (args[0] === 'rev-parse') return `${upstream.commit}\n`;
        if (args[0] === 'ls-files') return '';
        throw new Error(`unscripted ${args.join(' ')}`);
      },
    },
    clock: { now: () => new Date('2026-11-01T10:00:00Z'), sleep: async () => {} },
  } as unknown as Ports;
  return { ports, calls };
}
const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const ownerRoot = () => {
  const d = join(root, `o${n++}`);
  mkdirSync(d);
  return d;
};
const read = (dir: string, f: string) => readFileSync(join(dir, f), 'utf8');

describe('setupSources', () => {
  it('fetches a git source without hooks or links and pins the commit', async () => {
    const o = ownerRoot();
    const { ports, calls } = fakeGit({ tree: tree(OLD), commit: SHA1 });
    const r = await setupSources({ ownerRoot: o, index: file, ports });
    expect(r).toEqual([{ id: 'demo', result: 'fetched', commit: SHA1 }]);
    expect(read(o, 'sources/demo/docs/a.md')).toBe('hello\n');
    const clone = calls.find((c) => c.includes('clone')) as string[];
    expect(clone).toEqual(
      expect.arrayContaining(['core.hooksPath=/dev/null', 'core.symlinks=false']),
    );
    expect(clone).toContain('https://github.com/org/demo');
    expect(clone.indexOf('--')).toBeLessThan(clone.indexOf('https://github.com/org/demo'));
    const lock = JSON.parse(read(o, 'sources/lock.json')).demo;
    expect(lock.commit).toBe(SHA1);
    expect(Object.keys(lock.hashes).sort()).toEqual(['LICENSE', 'docs/a.md']);
    expect(lock.hashes.LICENSE).toMatch(/^[0-9a-f]{64}$/);
  });
  it('leaves a present source alone', async () => {
    const o = ownerRoot();
    const up = { tree: tree(OLD), commit: SHA1 };
    await setupSources({ ownerRoot: o, index: file, ports: fakeGit(up).ports });
    up.commit = SHA2;
    const r = await setupSources({ ownerRoot: o, index: file, ports: fakeGit(up).ports });
    expect(r[0]?.result).toBe('present');
    expect(JSON.parse(read(o, 'sources/lock.json')).demo.commit).toBe(SHA1);
  });
  it('a failed fetch leaves nothing behind', async () => {
    const o = ownerRoot();
    const { ports } = fakeGit({ tree: tree(OLD), commit: SHA1 }, { clone: true });
    const r = await setupSources({ ownerRoot: o, index: file, ports });
    expect(r[0]?.result).toBe('failed');
    expect(existsSync(join(o, 'sources', 'demo'))).toBe(false);
  });
  it('refuses an id that is not on the list', async () => {
    const o = ownerRoot();
    const { ports } = fakeGit({ tree: tree(OLD), commit: SHA1 });
    await expect(
      setupSources({ ownerRoot: o, index: file, ports, only: ['../x'] }),
    ).rejects.toThrow(/unknown source/);
  });
});

describe('the fetch cannot leave a half copy or lose pins', () => {
  it('a corrupt lock fails the fetch and stays as it was', async () => {
    const o = ownerRoot();
    mkdirSync(join(o, 'sources'));
    writeFileSync(join(o, 'sources', 'lock.json'), '{nope');
    const r = await setupSources({
      ownerRoot: o,
      index: file,
      ports: fakeGit({ tree: tree(OLD), commit: SHA1 }).ports,
    });
    expect(r[0]?.result).toBe('failed');
    expect(read(o, 'sources/lock.json')).toBe('{nope');
    expect(existsSync(join(o, 'sources', 'demo'))).toBe(false);
  });
  it('the clone goes to a temporary name first', async () => {
    const o = ownerRoot();
    const { ports, calls } = fakeGit({ tree: tree(OLD), commit: SHA1 });
    await setupSources({ ownerRoot: o, index: file, ports });
    expect((calls.find((c) => c.includes('clone')) as string[]).at(-1)).toBe('demo.fetching');
    expect(existsSync(join(o, 'sources', 'demo.fetching'))).toBe(false);
    expect(existsSync(join(o, 'sources', 'demo', 'LICENSE'))).toBe(true);
  });
  it('a leftover temporary clone is replaced, never served', async () => {
    const o = ownerRoot();
    mkdirSync(join(o, 'sources', 'demo.fetching'), { recursive: true });
    writeFileSync(join(o, 'sources', 'demo.fetching', 'stale'), 'x');
    await setupSources({
      ownerRoot: o,
      index: file,
      ports: fakeGit({ tree: tree(OLD), commit: SHA1 }).ports,
    });
    expect(existsSync(join(o, 'sources', 'demo', 'stale'))).toBe(false);
  });
});

describe('checkSources and applySource', () => {
  const fetched = async (next?: Record<string, string>) => {
    const o = ownerRoot();
    const up = { tree: tree(OLD), commit: SHA1 };
    await setupSources({ ownerRoot: o, index: file, ports: fakeGit(up).ports });
    if (next) {
      up.tree = tree(next);
      up.commit = SHA2;
    }
    return { o, up };
  };
  it('a source not fetched is unclear', async () => {
    const r = await checkSources({
      ownerRoot: ownerRoot(),
      index: file,
      ports: fakeGit({ tree: tree(OLD), commit: SHA1 }).ports,
    });
    expect(r).toEqual([
      {
        id: 'demo',
        verdict: 'unclear',
        findings: [{ kind: 'not-fetched', detail: 'run studio setup sources' }],
      },
    ]);
  });
  it('no upstream change fits and fetches nothing', async () => {
    const { o, up } = await fetched();
    const { ports, calls } = fakeGit(up);
    const r = await checkSources({ ownerRoot: o, index: file, ports });
    expect(r[0]).toMatchObject({ verdict: 'fits', pinned: SHA1 });
    expect(calls.some((c) => c.includes('clone'))).toBe(false);
  });
  it('an unreadable upstream is unclear', async () => {
    const { o, up } = await fetched();
    const r = await checkSources({
      ownerRoot: o,
      index: file,
      ports: fakeGit(up, { lsRemote: true }).ports,
    });
    expect(r[0]?.verdict).toBe('unclear');
  });
  it('a bad candidate is held: the active tree and the pin stay', async () => {
    const { o, up } = await fetched({
      LICENSE: 'GNU General Public License\n',
      'docs/a.md': 'evil\n',
    });
    const { ports } = fakeGit(up);
    const r = await checkSources({ ownerRoot: o, index: file, ports });
    expect(r[0]).toMatchObject({ verdict: 'conflict', pinned: SHA1, candidate: SHA2 });
    expect(read(o, 'sources/demo/docs/a.md')).toBe('hello\n');
    expect(JSON.parse(read(o, 'sources/lock.json')).demo.commit).toBe(SHA1);
    const applied = await applySource({ ownerRoot: o, index: file, ports, id: 'demo' });
    expect(applied.applied).toBe(false);
    expect(applied.reason).toContain('conflict');
    expect(read(o, 'sources/demo/docs/a.md')).toBe('hello\n');
  });
  it('a changed read file is held and named', async () => {
    const { o, up } = await fetched({ ...OLD, 'docs/a.md': 'hello there\n' });
    const { ports } = fakeGit(up);
    const r = await checkSources({ ownerRoot: o, index: file, ports });
    expect(r[0]).toMatchObject({
      verdict: 'unclear',
      findings: [{ kind: 'changed', detail: 'docs/a.md' }],
    });
    expect((await applySource({ ownerRoot: o, index: file, ports, id: 'demo' })).applied).toBe(
      false,
    );
    expect(read(o, 'sources/demo/docs/a.md')).toBe('hello\n');
  });
  it('a fitting candidate is not applied by check, only by apply', async () => {
    const { o, up } = await fetched({ ...OLD, 'docs/other.md': 'new\n' });
    const { ports } = fakeGit(up);
    const r = await checkSources({ ownerRoot: o, index: file, ports });
    expect(r[0]?.verdict).toBe('fits');
    expect(existsSync(join(o, 'sources', 'demo', 'docs', 'other.md'))).toBe(false);
    expect((await applySource({ ownerRoot: o, index: file, ports, id: 'demo' })).applied).toBe(
      true,
    );
    expect(read(o, 'sources/demo/docs/other.md')).toBe('new\n');
    expect(JSON.parse(read(o, 'sources/lock.json')).demo.commit).toBe(SHA2);
    expect(existsSync(join(o, 'sources', 'demo.candidate'))).toBe(false);
  });
  it('a candidate changed after the check is judged again', async () => {
    const { o, up } = await fetched({ ...OLD, 'docs/other.md': 'new\n' });
    const { ports } = fakeGit(up);
    await checkSources({ ownerRoot: o, index: file, ports });
    writeFileSync(join(o, 'sources', 'demo.candidate', 'docs', 'a.md'), 'changed\n');
    expect((await applySource({ ownerRoot: o, index: file, ports, id: 'demo' })).applied).toBe(
      false,
    );
    expect(read(o, 'sources/demo/docs/a.md')).toBe('hello\n');
  });
  it('an active copy that no longer matches its pin is not fits, even with no upstream change', async () => {
    const { o, up } = await fetched();
    writeFileSync(join(o, 'sources', 'demo', 'docs', 'a.md'), 'tampered\n');
    const r = await checkSources({ ownerRoot: o, index: file, ports: fakeGit(up).ports });
    expect(r[0]).toMatchObject({
      verdict: 'unclear',
      findings: [{ kind: 'changed', detail: 'docs/a.md' }],
    });
  });
  it('a lock without hashes is unclear', async () => {
    const { o, up } = await fetched();
    writeFileSync(
      join(o, 'sources', 'lock.json'),
      JSON.stringify({ demo: { commit: SHA1, license: 'MIT', fetchedAt: 'x' } }),
    );
    const r = await checkSources({ ownerRoot: o, index: file, ports: fakeGit(up).ports });
    expect(r[0]?.verdict).toBe('unclear');
  });
  it('apply without a candidate, or for a stranger, does nothing', async () => {
    const { o, up } = await fetched();
    const { ports } = fakeGit(up);
    expect((await applySource({ ownerRoot: o, index: file, ports, id: 'demo' })).applied).toBe(
      false,
    );
    await expect(applySource({ ownerRoot: o, index: file, ports, id: 'nope' })).rejects.toThrow(
      /unknown source/,
    );
  });
});

describe('CLI', () => {
  const run = async (env: Record<string, string>, ...argv: string[]) => {
    let out = '';
    let err = '';
    const home = join(root, `h${n++}`);
    mkdirSync(home);
    const code = await runCli(argv, {
      ports: fakeGit({ tree: tree(OLD), commit: SHA1 }, { lsRemote: true, clone: true }).ports,
      stdout: (s) => {
        out += s;
      },
      stderr: (s) => {
        err += s;
      },
      env,
      homedir: home,
      cwd: home,
    });
    return { code, out, err };
  };
  it.each([[['sources', 'check']], [['sources', 'apply', 'docker']], [['setup', 'sources']]])(
    '%j refuses for a crew',
    async (argv) => {
      const r = await run({ STUDIO_ROLE: 'crew' }, ...argv);
      expect(r.code).toBe(1);
      expect(r.err).toContain('not for crew');
    },
  );
  it('check lists every git source with a verdict and installs nothing', async () => {
    const r = await run({}, 'sources', 'check', '--json');
    expect(r.code).toBe(0);
    const rows = JSON.parse(r.out);
    expect(rows.results.length).toBeGreaterThan(5);
    for (const row of rows.results) expect(row.verdict).toBe('unclear');
    expect(rows.notWatched).toContain('superpowers');
  });
  it('apply needs one id', async () => {
    const r = await run({}, 'sources', 'apply');
    expect(r.code).toBe(1);
  });
});
