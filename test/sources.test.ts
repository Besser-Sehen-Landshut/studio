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
  compareTrees,
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
const verdict = (next: Record<string, string>, old = OLD) =>
  compareTrees(tree(old), tree(next), source);

describe('compareTrees', () => {
  it('a text edit fits', () => {
    expect(verdict({ ...OLD, 'docs/a.md': 'hello there\n', 'docs/b.md': 'new\n' })).toEqual({
      verdict: 'fits',
      findings: [],
    });
  });
  it.each<[string, Record<string, string>, string, string]>([
    ['a read file vanished', { LICENSE: OLD.LICENSE }, 'conflict', 'read-missing'],
    ['the licence went away', { 'docs/a.md': 'x' }, 'conflict', 'license-removed'],
    [
      'the licence became copyleft',
      { ...OLD, LICENSE: 'GNU General Public License v3\n' },
      'conflict',
      'license-copyleft',
    ],
    [
      'the licence text changed',
      { ...OLD, LICENSE: 'Apache License 2.0\n' },
      'unclear',
      'license-changed',
    ],
    ['a new hook file', { ...OLD, 'hooks/hooks.json': '{}' }, 'unclear', 'hook'],
    ['a new hooks.json', { ...OLD, 'x/hooks.json': '{}' }, 'unclear', 'hook'],
    ['settings in a skill', { ...OLD, '.claude/settings.json': '{}' }, 'unclear', 'hook'],
    [
      'hooks in front matter',
      { ...OLD, 'docs/a.md': '---\nname: a\nhooks:\n  x: y\n---\n' },
      'unclear',
      'hook',
    ],
    [
      'pipe to shell',
      { ...OLD, 'docs/a.md': 'run curl https://x.example/i | sh\n' },
      'unclear',
      'install-step',
    ],
    [
      'sudo pipe to shell',
      { ...OLD, 'docs/b.md': 'wget -q x | sudo bash\n' },
      'unclear',
      'install-step',
    ],
    [
      'an install step',
      { ...OLD, 'docs/a.md': 'first npm install -g thing\n' },
      'unclear',
      'install-step',
    ],
    ['pip install', { ...OLD, 'docs/a.md': 'pip install thing\n' }, 'unclear', 'install-step'],
    [
      'a new script with a network call',
      { ...OLD, 'bin/x.sh': 'curl https://x.example\n' },
      'unclear',
      'network-script',
    ],
    ['a python script', { ...OLD, 'bin/x.py': 'import urllib\n' }, 'unclear', 'network-script'],
    [
      'a read file more than doubled',
      { ...OLD, 'docs/a.md': 'x'.repeat(100) },
      'unclear',
      'read-grew',
    ],
  ])('%s', (_name, next, want, kind) => {
    const r = verdict(next);
    expect(r.verdict).toBe(want);
    expect(r.findings.map((f) => f.kind)).toContain(kind);
  });
  it('an install step that was already there is no news', () => {
    const old = { ...OLD, 'docs/b.md': 'npm install -g thing\n' };
    expect(verdict({ ...old, 'docs/b.md': 'npm install -g thing\nmore\n' }, old).verdict).toBe(
      'fits',
    );
  });
  it('a new symlink is unclear and is not followed', () => {
    const next = tree(OLD);
    writeFileSync(join(root, 'secret-target'), 'SECRET');
    symlinkSync(join(root, 'secret-target'), join(next, 'link'));
    const r = compareTrees(tree(OLD), next, source);
    expect(r.verdict).toBe('unclear');
    expect(r.findings.map((f) => f.kind)).toContain('symlink');
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });
  it('a read file that became a symlink is a conflict', () => {
    const next = tree({ LICENSE: OLD.LICENSE });
    symlinkSync(join(root, 'secret-target'), join(next, 'docs-a'));
    mkdirSync(join(next, 'docs'));
    symlinkSync(join(root, 'secret-target'), join(next, 'docs', 'a.md'));
    expect(compareTrees(tree(OLD), next, source).verdict).toBe('conflict');
  });
  it('a link that git recorded is reported, also with links checked out as files', () => {
    const r = compareTrees(tree(OLD), tree(OLD), source, { newLinks: ['x/link'] });
    expect(r.verdict).toBe('unclear');
    expect(r.findings.map((f) => f.kind)).toContain('symlink');
  });
  it('an unreadable tree is unclear, never fits', () => {
    expect(compareTrees(join(root, 'nope'), tree(OLD), source).verdict).toBe('unclear');
    expect(compareTrees(tree(OLD), join(root, 'nope'), source).verdict).not.toBe('fits');
  });
  it('a findings detail holds no control characters', () => {
    const next = tree(OLD);
    mkdirSync(join(next, 'hooks'));
    writeFileSync(join(next, 'hooks', 'a\u001b[2Jb.json'), '{}');
    const r = compareTrees(tree(OLD), next, source);
    expect(JSON.stringify(r.findings)).not.toContain('\\u001b');
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
    expect(JSON.parse(read(o, 'sources/lock.json')).demo.commit).toBe(SHA1);
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
  it('a fitting candidate is not applied by check, only by apply', async () => {
    const { o, up } = await fetched({ ...OLD, 'docs/a.md': 'hello there\n' });
    const { ports } = fakeGit(up);
    const r = await checkSources({ ownerRoot: o, index: file, ports });
    expect(r[0]?.verdict).toBe('fits');
    expect(read(o, 'sources/demo/docs/a.md')).toBe('hello\n');
    expect((await applySource({ ownerRoot: o, index: file, ports, id: 'demo' })).applied).toBe(
      true,
    );
    expect(read(o, 'sources/demo/docs/a.md')).toBe('hello there\n');
    expect(JSON.parse(read(o, 'sources/lock.json')).demo.commit).toBe(SHA2);
    expect(existsSync(join(o, 'sources', 'demo.candidate'))).toBe(false);
  });
  it('a candidate changed after the check is judged again', async () => {
    const { o, up } = await fetched({ ...OLD, 'docs/a.md': 'hello there\n' });
    const { ports } = fakeGit(up);
    await checkSources({ ownerRoot: o, index: file, ports });
    writeFileSync(join(o, 'sources', 'demo.candidate', 'hooks.json'), '{}');
    const applied = await applySource({ ownerRoot: o, index: file, ports, id: 'demo' });
    expect(applied.applied).toBe(false);
    expect(read(o, 'sources/demo/docs/a.md')).toBe('hello\n');
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
