import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MODEL_NAME_RE as BOARD_MODEL_RE, type WorkItem } from '../src/board.js';
import {
  CapabilitiesError,
  capabilitiesDir,
  itemTriggers,
  loadCapabilities,
  matchGlob,
  phaseOf,
  resolveSkills,
} from '../src/capabilities.js';
import { MODEL_NAME_RE } from '../src/config.js';

const item = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: 'APP-1',
  title: 't',
  type: 'feature',
  role: 'builder',
  repo: 'org/app',
  size: 'S',
  priority: 1,
  status: 'ready',
  paths: [],
  touches: [],
  dependsOn: [],
  dod: ['d'],
  history: [],
  ...over,
});
const TDD = 'superpowers:test-driven-development';
const dirs: string[] = [];
const fixture = (index: string | undefined): string => {
  const d = mkdtempSync(join(tmpdir(), 'studio-cap-'));
  dirs.push(d);
  if (index !== undefined) writeFileSync(join(d, 'INDEX.yaml'), index);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const review = (over: Partial<WorkItem> = {}) =>
  item({ type: 'review', role: 'reviewer', ...over });
const analyzerIds = (paths: readonly string[] | 'unknown', it: WorkItem = review()) =>
  resolveSkills(it, 'reviewer', [], paths, 'review').analyzers.map((a) => a.id);

describe('loadCapabilities', () => {
  it('loads the shipped index', () => {
    const idx = loadCapabilities();
    expect(idx.version).toBe(1);
    expect(idx.rows.length).toBeGreaterThan(20);
    expect(capabilitiesDir().endsWith(`capabilities/`)).toBe(true);
  });
  it.each([
    ['missing file', undefined],
    ['bad yaml', 'version: [1'],
    [
      'unknown when key',
      'version: 1\nrows:\n  - { id: a, ref: "skill:x", mode: offered, load: invoke, when: { nope: [] } }\n',
    ],
    [
      'unknown row key',
      'version: 1\nrows:\n  - { id: a, ref: "skill:x", mode: offered, load: invoke, when: {}, extra: 1 }\n',
    ],
    [
      'bad ref kind',
      'version: 1\nrows:\n  - { id: a, ref: "http:x", mode: offered, load: invoke, when: {} }\n',
    ],
    [
      'duplicate id',
      'version: 1\nrows:\n  - { id: a, ref: "skill:x", mode: offered, load: invoke, when: {} }\n  - { id: a, ref: "skill:y", mode: offered, load: invoke, when: {} }\n',
    ],
  ])('refuses %s', (_name, text) => {
    expect(() => loadCapabilities(fixture(text))).toThrow(CapabilitiesError);
  });
});

describe('matchGlob', () => {
  it.each([
    ['**/auth*', 'src/Auth/Login.tsx', false],
    ['**/auth*/**', 'src/Auth/Login.tsx', true],
    ['**/auth*', 'auth.ts', true],
    ['**/*.sql', 'a.sql', true],
    ['**/*.sql', 'db/b/a.SQL', true],
    ['src/*.ts', 'src/a/b.ts', false],
    ['src/**', 'src', false],
    ['src/**/a.ts', 'src/a.ts', true],
    ['a?.ts', 'ab.ts', true],
    ['a?.ts', 'a/.ts', false],
    ['**/*.{tsx,css}', 'x/y.css', true],
    ['**/*.{tsx,css}', 'x/y.ts', false],
    ['a.b', 'axb', false],
    ['a+b(c).ts', 'a+b(c).ts', true],
  ])('%s vs %s is %s', (glob, path, want) => {
    expect(matchGlob(glob, path)).toBe(want);
  });
});

describe('resolveSkills', () => {
  it('a feature builder must use test-driven development', () => {
    const r = resolveSkills(item(), 'builder', [], [], 'build');
    expect(r.required).toContain(TDD);
    expect(r.required).not.toContain('superpowers:systematic-debugging');
  });
  it('a fix adds systematic debugging', () => {
    const r = resolveSkills(item({ type: 'fix' }), 'builder', [], [], 'build');
    expect(r.required).toContain('superpowers:systematic-debugging');
  });
  it('rework adds receiving-code-review', () => {
    const r = resolveSkills(item(), 'builder', [], [], 'build', { triggers: ['rework'] });
    expect(r.required).toContain('superpowers:receiving-code-review');
  });
  it('a reviewer gets the diff review and the spec check', () => {
    expect(analyzerIds([])).toEqual(expect.arrayContaining(['diff-review', 'spec-check']));
  });
  it('a builder gets no analyzer', () => {
    expect(resolveSkills(item(), 'builder', [], ['src/auth.ts'], 'build').analyzers).toEqual([]);
  });
  it('a docs review has no spec check', () => {
    const ids = analyzerIds([], review({ notes: [], type: 'docs' }));
    expect(ids).not.toContain('spec-check');
  });
  it.each([
    'src/Auth/Login.tsx',
    'src/auth.ts',
    'app/API/x.ts',
    'db/Schema.prisma',
    'SignUp.tsx',
    'web/sign-up/page.tsx',
    'web/login/page.tsx',
    'web/Upload/form.tsx',
    'web/reset/page.tsx',
    'src/sessions/store.ts',
    'src/session.ts',
    'server/middleware.ts',
    'app/items/route.ts',
    'db/migrations/001.sql',
    'lib/password-reset.ts',
    'lib/reset.ts',
    'web/upload.tsx',
    'db/policies.sql',
    'security/Policy.ts',
    '.github/workflows/ci.yml',
  ])('security is always on for %s', (path) => {
    expect(analyzerIds([path])).toContain('security');
  });
  it('security is off for an unrelated file', () => {
    expect(analyzerIds(['src/util/format.ts'])).not.toContain('security');
  });
  it('a docs item touching an auth file still gets security', () => {
    expect(analyzerIds(['src/auth.ts'], review({ type: 'docs' }))).toContain('security');
  });
  it('unknown changed paths fail closed', () => {
    expect(analyzerIds('unknown')).toContain('security');
  });
  it('a risk tag turns security on with no path', () => {
    expect(analyzerIds([], review({ risk: ['data'] }))).toContain('security');
  });
  it('no analyzer is listed twice', () => {
    const ids = analyzerIds(['src/auth.ts'], review({ triggers: ['release'] }));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['bugs', 'dead-code', 'security']));
  });
  it('epic end adds the full scans', () => {
    const ids = analyzerIds([], review({ triggers: ['epic-end'] }));
    expect(ids).toEqual(expect.arrayContaining(['bugs', 'dead-code', 'performance']));
  });
  it('the large tier adds performance, the small tier not', () => {
    const at = (tier: 'small' | 'large') =>
      resolveSkills(review(), 'reviewer', [], [], 'review', { tier }).analyzers.map((a) => a.id);
    expect(at('large')).toContain('performance');
    expect(at('small')).not.toContain('performance');
  });
  it('after a fix the similar-bug scan runs', () => {
    const r = resolveSkills(review(), 'reviewer', [], [], 'review', { triggers: ['after-fix'] });
    expect(r.analyzers.map((a) => a.id)).toContain('similar-bugs');
  });
  it('a stack row needs the stack and the path', () => {
    const skills = (stack: string[], paths: string[]) =>
      resolveSkills(review(), 'reviewer', stack, paths, 'review').optionalRequired;
    expect(skills(['rust'], ['src/a.rs'])).toContain('rust-best-practices');
    expect(skills([], ['src/a.rs'])).not.toContain('rust-best-practices');
    expect(skills(['rust'], ['README.txt'])).not.toContain('rust-best-practices');
    const b = resolveSkills(item(), 'builder', ['rust'], ['src/a.rs'], 'build');
    expect(b.required).not.toContain('rust-best-practices');
  });
  it('knowledge appears only for a matching row', () => {
    const none = resolveSkills(item(), 'builder', [], [], 'build').knowledge;
    expect(none.map((k) => k.ref)).not.toContain('design:platform-web.md');
    const web = resolveSkills(item({ risk: ['ui'] }), 'builder', ['nextjs'], [], 'build').knowledge;
    expect(web.map((k) => k.ref)).toContain('design:platform-web.md');
    expect(web.map((k) => k.ref)).not.toContain('design:platform-apple.md');
  });
  it('an optional skill goes to its own list', () => {
    const r = resolveSkills(item({ risk: ['ui'] }), 'builder', [], [], 'build');
    expect(r.optionalRequired).toContain('ux-ui-design');
    expect(r.required).not.toContain('ux-ui-design');
  });
  it('the index denies what crews must never use', () => {
    const r = resolveSkills(item(), 'builder', [], [], 'build');
    expect(r.denied).toContain('superpowers:finishing-a-development-branch');
  });
  it('a denied skill wins over required, offered and role lists', () => {
    const r = resolveSkills(item(), 'builder', [], [], 'build', {
      roleSkills: {
        required: ['a:b', 'c:d'],
        allowed: ['c:d', 'e:f'],
        denied: [TDD, 'a:b', 'e:f'],
      },
    });
    expect(r.required).not.toContain(TDD);
    expect(r.required).not.toContain('a:b');
    expect(r.required).toContain('c:d');
    expect(r.offered).not.toContain('e:f');
    expect(r.offered).not.toContain('c:d');
    expect(r.denied).toEqual(expect.arrayContaining([TDD, 'a:b', 'e:f']));
  });
  it('the crew skill is never listed as denied', () => {
    const r = resolveSkills(item(), 'builder', [], [], 'build', {
      roleSkills: { required: [], allowed: [], denied: ['studio:studio-crew'] },
    });
    expect(r.denied).not.toContain('studio:studio-crew');
  });
  it('role skills.when adds skills by path and by item type', () => {
    const roleSkills = {
      required: [],
      allowed: [],
      denied: [],
      when: [
        { paths: ['migrations/**'], required: ['pg:m'] },
        { itemTypes: ['fix' as const], allowed: ['x:y'] },
      ],
    };
    const r = resolveSkills(item(), 'builder', [], ['migrations/1.sql'], 'build', { roleSkills });
    expect(r.required).toContain('pg:m');
    expect(r.offered).not.toContain('x:y');
    const f = resolveSkills(item({ type: 'fix' }), 'builder', [], [], 'build', { roleSkills });
    expect(f.required).not.toContain('pg:m');
    expect(f.offered).toContain('x:y');
  });
  it('uses an injected index', () => {
    const index = loadCapabilities(
      fixture(
        'version: 1\nrows:\n  - { id: a, ref: "skill:only", mode: required, load: invoke, when: {} }\n',
      ),
    );
    expect(resolveSkills(item(), 'builder', [], [], 'build', { index }).required).toEqual(['only']);
  });
});

describe('item facts', () => {
  it('phaseOf follows the role and the type', () => {
    expect(phaseOf(item())).toBe('build');
    expect(phaseOf(item({ role: 'designer' }))).toBe('design');
    expect(phaseOf(review())).toBe('review');
    expect(phaseOf(item({ type: 'review' }))).toBe('review');
  });
  it('itemTriggers derives release and rework', () => {
    expect(itemTriggers(item())).toEqual([]);
    expect(itemTriggers(item({ type: 'release' }))).toEqual(['release']);
    expect(itemTriggers(item({ triggers: ['epic-end'] }))).toEqual(['epic-end']);
    const history = [{ at: 'x', from: 'in_progress' as const, to: 'in_review' as const, by: 's' }];
    expect(itemTriggers(item({ history }))).toEqual(['rework']);
  });
  it('board and config use the same model name rule', () => {
    expect(BOARD_MODEL_RE.source).toBe(MODEL_NAME_RE.source);
    expect(MODEL_NAME_RE.test('opus[1m]')).toBe(true);
    expect(MODEL_NAME_RE.test('--evil')).toBe(false);
  });
});
