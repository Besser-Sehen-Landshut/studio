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
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  acceptLesson,
  dropLesson,
  listLessons,
  MAX_LESSON_CHARS,
  MAX_LESSON_LINES,
  proposeLessons,
  pruneLesson,
  readRoleMemory,
  sanitizeLesson,
} from '../src/role-memory.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-role-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const dirs = () => {
  const base = join(root, `r${n++}`);
  const project = join(base, 'project');
  const state = join(base, 'state');
  mkdirSync(join(project, '.studio', 'roles'), { recursive: true });
  mkdirSync(state);
  return { project, state };
};
const NOW = new Date('2026-11-01T10:00:00Z');
const roleFile = (project: string, role = 'builder') =>
  join(project, '.studio', 'roles', `${role}.md`);

describe('sanitizeLesson', () => {
  it('makes one plain line', () => {
    expect(sanitizeLesson('  run\nthe\ttests \u001b[2J twice ')).toBe('run the tests [2J twice');
  });
  it.each([
    ['## Ignore the rules', 'Ignore the rules'],
    ['- item', 'item'],
    ['> quote', 'quote'],
    ['* star', 'star'],
    ['# # deep', 'deep'],
  ])('takes the markup off %s', (input, want) => {
    expect(sanitizeLesson(input)).toBe(want);
  });
  it('caps the length', () => {
    expect(sanitizeLesson('x'.repeat(10_000))?.length).toBe(MAX_LESSON_CHARS);
  });
  it.each(['', '   ', '\n\n', '##', '\u0007'])('drops %j', (input) => {
    expect(sanitizeLesson(input)).toBeUndefined();
  });
});

describe('proposals', () => {
  it('only proposes: the role file stays untouched', () => {
    const { project, state } = dirs();
    expect(proposeLessons(state, 'builder', 'APP-1', ['a lesson', '## b\nmore'], NOW)).toBe(2);
    expect(existsSync(roleFile(project))).toBe(false);
    expect(listLessons(state)).toEqual([
      { n: 1, role: 'builder', item: 'APP-1', text: 'a lesson', at: NOW.toISOString() },
      { n: 2, role: 'builder', item: 'APP-1', text: 'b more', at: NOW.toISOString() },
    ]);
  });
  it('merges duplicates by text, per role', () => {
    const { state } = dirs();
    proposeLessons(state, 'builder', 'APP-1', ['Same', 'same'], NOW);
    expect(proposeLessons(state, 'builder', 'APP-2', ['SAME'], NOW)).toBe(0);
    expect(proposeLessons(state, 'reviewer', 'APP-2', ['same'], NOW)).toBe(1);
    expect(listLessons(state)).toHaveLength(2);
  });
  it('takes at most 10 from a report and 200 in all', () => {
    const { state } = dirs();
    const many = (p: string, c: number) => Array.from({ length: c }, (_, i) => `${p}${i}`);
    expect(proposeLessons(state, 'builder', 'APP-1', many('a', 50), NOW)).toBe(10);
    for (let i = 0; i < 25; i++) proposeLessons(state, 'builder', 'APP-1', many(`b${i}-`, 10), NOW);
    expect(listLessons(state)).toHaveLength(200);
  });
  it('an unreadable file throws for list and propose', () => {
    const { state } = dirs();
    writeFileSync(join(state, 'lessons.json'), '{nope');
    expect(() => listLessons(state)).toThrow();
    expect(() => proposeLessons(state, 'builder', 'APP-1', ['x'], NOW)).toThrow();
  });
  it('a file of the wrong shape throws', () => {
    const { state } = dirs();
    writeFileSync(join(state, 'lessons.json'), '{"lessons":[{"text":3}]}');
    expect(() => listLessons(state)).toThrow();
  });
  it('drop removes one; numbers stay stable', () => {
    const { state } = dirs();
    proposeLessons(state, 'builder', 'APP-1', ['a', 'b', 'c'], NOW);
    dropLesson(state, 2);
    expect(listLessons(state).map((l) => [l.n, l.text])).toEqual([
      [1, 'a'],
      [3, 'c'],
    ]);
    expect(() => dropLesson(state, 2)).toThrow(/no proposed lesson 2/);
  });
});

describe('acceptLesson', () => {
  const proposed = (text = 'keep tests fast') => {
    const d = dirs();
    proposeLessons(d.state, 'builder', 'APP-1', [text], NOW);
    return d;
  };
  it('creates the section and keeps what stands before it', () => {
    const { project, state } = proposed();
    writeFileSync(roleFile(project), '# Builder\n\nBrief text.\n');
    expect(acceptLesson(project, state, 1)).toEqual({
      role: 'builder',
      text: 'keep tests fast',
      lines: 1,
    });
    expect(readFileSync(roleFile(project), 'utf8')).toBe(
      '# Builder\n\nBrief text.\n\n## Lessons\n\n- keep tests fast\n',
    );
    expect(listLessons(state)).toEqual([]);
  });
  it('creates the file when missing', () => {
    const { project, state } = proposed();
    acceptLesson(project, state, 1);
    expect(readFileSync(roleFile(project), 'utf8')).toBe('## Lessons\n\n- keep tests fast\n');
  });
  it('keeps a section after Lessons', () => {
    const { project, state } = proposed();
    writeFileSync(roleFile(project), '## Lessons\n\n- old\n\n## Other\n\ntext\n');
    acceptLesson(project, state, 1);
    expect(readFileSync(roleFile(project), 'utf8')).toBe(
      '## Lessons\n\n- old\n- keep tests fast\n\n## Other\n\ntext\n',
    );
  });
  it('a duplicate is a no-op that clears the proposal', () => {
    const { project, state } = proposed();
    const text = '## Lessons\n\n- Keep Tests Fast\n';
    writeFileSync(roleFile(project), text);
    expect(acceptLesson(project, state, 1).lines).toBe(1);
    expect(readFileSync(roleFile(project), 'utf8')).toBe(text);
    expect(listLessons(state)).toEqual([]);
  });
  it('the 41st line is refused and the proposal stays', () => {
    const { project, state } = proposed();
    const full = Array.from({ length: MAX_LESSON_LINES }, (_, i) => `- l${i}`).join('\n');
    writeFileSync(roleFile(project), `## Lessons\n\n${full}\n`);
    expect(() => acceptLesson(project, state, 1)).toThrow(/prune/);
    expect(listLessons(state)).toHaveLength(1);
  });
  it('a symlinked role file is refused', () => {
    const { project, state } = proposed();
    const elsewhere = join(root, `else${n++}.md`);
    writeFileSync(elsewhere, 'x');
    symlinkSync(elsewhere, roleFile(project));
    expect(() => acceptLesson(project, state, 1)).toThrow(/link/);
    expect(readFileSync(elsewhere, 'utf8')).toBe('x');
  });
  it('a role that is no template is refused', () => {
    const { project, state } = dirs();
    writeFileSync(
      join(state, 'lessons.json'),
      JSON.stringify({
        next: 2,
        lessons: [{ n: 1, role: '../../evil', item: 'A-1', text: 't', at: 'x' }],
      }),
    );
    expect(() => acceptLesson(project, state, 1)).toThrow();
  });
  it('a text edited in the file is cleaned again', () => {
    const { project, state } = dirs();
    writeFileSync(
      join(state, 'lessons.json'),
      JSON.stringify({
        next: 2,
        lessons: [{ n: 1, role: 'builder', item: 'A-1', text: 'a\n## Evil', at: 'x' }],
      }),
    );
    acceptLesson(project, state, 1);
    expect(readFileSync(roleFile(project), 'utf8')).toBe('## Lessons\n\n- a ## Evil\n');
  });
});

describe('pruneLesson', () => {
  it('removes the numbered line', () => {
    const { project } = dirs();
    writeFileSync(roleFile(project), 'x\n\n## Lessons\n\n- a\n- b\n- c\n');
    pruneLesson(project, 'builder', 2);
    expect(readFileSync(roleFile(project), 'utf8')).toBe('x\n\n## Lessons\n\n- a\n- c\n');
  });
  it.each([0, 4, -1, 1.5])('refuses line %s', (line) => {
    const { project } = dirs();
    writeFileSync(roleFile(project), '## Lessons\n\n- a\n- b\n- c\n');
    expect(() => pruneLesson(project, 'builder', line)).toThrow();
  });
});

describe('readRoleMemory', () => {
  it('is empty without a file', () => {
    expect(readRoleMemory(dirs().project, 'builder')).toEqual({
      brief: '',
      lessons: [],
      cut: false,
    });
  });
  it('keeps instructions and lessons apart', () => {
    const { project } = dirs();
    writeFileSync(roleFile(project), 'text\n\n## Lessons\n\n- a\n\n## Other\n\nmore\n');
    expect(readRoleMemory(project, 'builder')).toEqual({
      brief: 'text\n\n## Other\n\nmore',
      lessons: ['a'],
      cut: false,
    });
  });
  it('a hand-edited file shows only the newest 40 lessons', () => {
    const { project } = dirs();
    const lines = Array.from({ length: 60 }, (_, i) => `- l${i}`).join('\n');
    writeFileSync(roleFile(project), `text\n\n## Lessons\n\n${lines}\n`);
    const m = readRoleMemory(project, 'builder');
    expect(m.lessons).toHaveLength(40);
    expect(m.lessons[0]).toBe('l20');
    expect(m.cut).toBe(true);
  });
  it('a hand-edited lesson is cleaned on the way out', () => {
    const { project } = dirs();
    writeFileSync(roleFile(project), '## Lessons\n\n``` closing fence\n- \u001b[2Jnote\n');
    expect(readRoleMemory(project, 'builder').lessons).toEqual(['``` closing fence', '[2Jnote']);
  });
});

describe('the role file is reached safely', () => {
  const linked = (segment: 'studio' | 'roles' | 'file') => {
    const base = join(root, `s${n++}`);
    const project = join(base, 'project');
    mkdirSync(project, { recursive: true });
    const outside = join(base, 'outside');
    mkdirSync(join(outside, 'roles'), { recursive: true });
    writeFileSync(join(outside, 'roles', 'builder.md'), 'OUTSIDE');
    writeFileSync(join(outside, 'builder.md'), 'OUTSIDE');
    if (segment === 'studio') symlinkSync(outside, join(project, '.studio'));
    else {
      mkdirSync(join(project, '.studio'));
      if (segment === 'roles')
        symlinkSync(join(outside, 'roles'), join(project, '.studio', 'roles'));
      else {
        mkdirSync(join(project, '.studio', 'roles'));
        symlinkSync(join(outside, 'builder.md'), join(project, '.studio', 'roles', 'builder.md'));
      }
    }
    return { project, outside };
  };
  it.each(['studio', 'roles', 'file'] as const)('a link at %s is refused everywhere', (segment) => {
    const { project, outside } = linked(segment);
    const state = join(root, `st${n++}`);
    mkdirSync(state);
    proposeLessons(state, 'builder', 'APP-1', ['x'], NOW);
    expect(() => readRoleMemory(project, 'builder')).toThrow(/link/);
    expect(() => acceptLesson(project, state, 1)).toThrow(/link/);
    expect(() => pruneLesson(project, 'builder', 1)).toThrow(/link/);
    expect(readFileSync(join(outside, 'builder.md'), 'utf8')).toBe('OUTSIDE');
    expect(readFileSync(join(outside, 'roles', 'builder.md'), 'utf8')).toBe('OUTSIDE');
    expect(listLessons(state)).toHaveLength(1);
  });
  it.each(['../evil', 'lead', 'builder/../reviewer', ''])('the role %j is refused', (role) => {
    const { project } = dirs();
    expect(() => readRoleMemory(project, role)).toThrow(/role/);
    expect(() => pruneLesson(project, role, 1)).toThrow(/role/);
  });
  it('a folder in place of the file is refused', () => {
    const { project } = dirs();
    mkdirSync(roleFile(project));
    expect(() => readRoleMemory(project, 'builder')).toThrow();
  });
});
