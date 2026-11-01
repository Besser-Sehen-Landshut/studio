import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { capabilitiesDir, loadCapabilities } from '../src/capabilities.js';
import { loadSources, SourcesError } from '../src/sources.js';

const dir = capabilitiesDir();
const index = loadCapabilities();
const sources = loadSources();
const refs = index.rows.flatMap((r) => (Array.isArray(r.ref) ? r.ref : [r.ref]));
const FOLDERS: Record<string, [string, string]> = {
  analyzer: ['analyzers', '.md'],
  design: ['design', ''],
  knowledge: ['knowledge', ''],
};
const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});
const sourcesText = (text: string) => {
  const d = mkdtempSync(join(tmpdir(), 'studio-src-'));
  tmp.push(d);
  writeFileSync(join(d, 'SOURCES.yaml'), text);
  return d;
};
const one = (entry: string) => `version: 1\nsources:\n  - ${entry}\n`;

describe('index and files agree', () => {
  it('every local ref has its file', () => {
    for (const ref of refs) {
      const [kind = ''] = ref.split(':');
      const folder = FOLDERS[kind];
      if (!folder) continue;
      const name = ref.slice(kind.length + 1);
      expect(existsSync(join(dir, folder[0], name + folder[1])), ref).toBe(true);
    }
  });
  it('every shipped file has a row; no knowledge loads without one', () => {
    for (const [kind, [folder, ext]] of Object.entries(FOLDERS)) {
      for (const file of readdirSync(join(dir, folder))) {
        if (file === 'CONTRACT.md') continue;
        const name = ext ? file.slice(0, -ext.length) : file;
        expect(refs, file).toContain(`${kind}:${name}`);
      }
    }
  });
  it('every source named by a row exists and lists the file', () => {
    const ids = sources.sources.map((s) => s.id);
    for (const row of index.rows) {
      if (row.source !== undefined) expect(ids, row.id).toContain(row.source);
    }
    for (const ref of refs.filter((r) => r.startsWith('source:'))) {
      const rest = ref.slice('source:'.length);
      const id = rest.slice(0, rest.indexOf('/'));
      const src = sources.sources.find((s) => s.id === id);
      expect(src, ref).toBeDefined();
      expect(src?.reads, ref).toContain(rest.slice(id.length + 1));
    }
  });
  it('a row with a source that has a fallback-free ref names the source', () => {
    for (const row of index.rows) {
      const list = Array.isArray(row.ref) ? row.ref : [row.ref];
      if (list.some((r) => r.startsWith('source:'))) expect(row.source, row.id).toBeDefined();
    }
  });
});

describe('content rules', () => {
  const all = ['analyzers', 'design', 'knowledge'].flatMap((f) =>
    readdirSync(join(dir, f)).map((n) => join(f, n)),
  );
  it.each(all)('%s is free of the old process and within the read limit', (rel) => {
    const text = readFileSync(join(dir, rel), 'utf8');
    expect(text).not.toMatch(/\/dev |STATE\.md|ROADMAP\.md|\$DEV_|TECH_STACKS/);
    expect(text.split('\n').length).toBeLessThanOrEqual(201);
  });
  it('the spec check holds the mutation probe', () => {
    const text = readFileSync(join(dir, 'analyzers', 'spec-check.md'), 'utf8');
    expect(text).toContain('mutation probe');
    expect(text).toContain('Still green');
    expect(text).toContain('No named red test');
  });
  it('analyzers that need a source report skipped', () => {
    for (const f of ['design-detector.md', 'motion.md']) {
      expect(readFileSync(join(dir, 'analyzers', f), 'utf8')).toContain('skipped: ');
    }
  });
  it('the notice carries the MIT text for each adapted file', () => {
    const text = readFileSync(join(dir, 'NOTICE.md'), 'utf8');
    expect(text).toContain('Permission is hereby granted, free of charge');
    expect(text).toContain('ehmo/platform-design-skills');
    for (const f of ['platform-web.md', 'platform-apple.md', 'platform-android.md']) {
      expect(text).toContain(f);
    }
  });
});

describe('licence rules', () => {
  it('only MIT or Apache content is vendored in the shipped list', () => {
    const vendored = sources.sources.filter((s) => s.vendored);
    expect(vendored.map((s) => s.id)).toEqual(['ehmo']);
    for (const s of vendored) expect(['MIT', 'Apache-2.0']).toContain(s.license);
  });
  it('the unknown and copyleft sources stay referenced', () => {
    const by = (id: string) => sources.sources.find((s) => s.id === id);
    expect(by('wordpress')?.vendored).toBe(false);
    expect(by('better-auth')?.vendored).toBe(false);
    expect(by('svelte')?.vendored).toBe(false);
  });
  it.each([
    [
      'GPL vendored',
      '{ id: a, kind: git, url: "https://github.com/a/b", license: GPL-3.0-only, vendored: true, notice: NOTICE.md, reads: [] }',
    ],
    [
      'unknown vendored',
      '{ id: a, kind: git, url: "https://github.com/a/b", license: unknown, vendored: true, notice: NOTICE.md, reads: [] }',
    ],
    [
      'vendored without a notice',
      '{ id: a, kind: git, url: "https://github.com/a/b", license: MIT, vendored: true, reads: [] }',
    ],
    [
      'a read leaving the source',
      '{ id: a, kind: git, url: "https://github.com/a/b", license: MIT, vendored: false, reads: ["../x"] }',
    ],
    [
      'an absolute read',
      '{ id: a, kind: git, url: "https://github.com/a/b", license: MIT, vendored: false, reads: ["/etc/x"] }',
    ],
    [
      'a nested parent read',
      '{ id: a, kind: git, url: "https://github.com/a/b", license: MIT, vendored: false, reads: ["a/../../x"] }',
    ],
    [
      'a git source without a url',
      '{ id: a, kind: git, license: MIT, vendored: false, reads: [] }',
    ],
    [
      'a plain http url',
      '{ id: a, kind: git, url: "http://github.com/a/b", license: MIT, vendored: false, reads: [] }',
    ],
    [
      'another host',
      '{ id: a, kind: git, url: "https://example.com/a/b", license: MIT, vendored: false, reads: [] }',
    ],
    [
      'an option in the url',
      '{ id: a, kind: git, url: "https://github.com/a/b --upload-pack=x", license: MIT, vendored: false, reads: [] }',
    ],
    ['a bad id', '{ id: "../a", kind: plugin, license: MIT, vendored: false, reads: [] }'],
  ])('refuses %s', (_name, entry) => {
    expect(() => loadSources(sourcesText(one(entry)))).toThrow(SourcesError);
  });
  it('refuses a missing file and bad yaml', () => {
    const empty = mkdtempSync(join(tmpdir(), 'studio-src-'));
    tmp.push(empty);
    expect(() => loadSources(empty)).toThrow(SourcesError);
    expect(() => loadSources(sourcesText('a: ['))).toThrow(SourcesError);
  });
  it('refuses a duplicate id', () => {
    const e = '{ id: a, kind: plugin, license: MIT, vendored: false, reads: [] }';
    expect(() => loadSources(sourcesText(`version: 1\nsources:\n  - ${e}\n  - ${e}\n`))).toThrow(
      SourcesError,
    );
  });
});
