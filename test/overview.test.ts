import {
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
import { formatOverview, readOverview } from '../src/overview.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-overview-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const base = join(root, 'state', 'studio');
const item = (id: string, status: string) =>
  `  - { id: ${id}, title: t, type: fix, role: builder, repo: org/app, size: S, priority: 1, status: ${status} }`;

function project(name: string, statuses: string[]): string {
  const dir = join(root, name);
  mkdirSync(join(dir, '.studio'), { recursive: true });
  writeFileSync(
    join(dir, '.studio', 'board.yaml'),
    `items:\n${statuses.map((s, i) => item(`APP-${i + 1}`, s)).join('\n')}\n`,
  );
  return dir;
}

function stateRoot(dirName: string, files: Record<string, string>): string {
  const dir = join(base, dirName);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

const marker = (dir: string) => JSON.stringify({ projectRealpath: dir, originUrl: 'x' });
const crew = (records: Record<string, { pid: number; stoppedAt?: string }>) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(records).map(([id, r]) => [
        id,
        { name: `c-${id}`, item: id, role: 'builder', log: 'l', startedAt: 'now', ...r },
      ]),
    ),
  );

const api = project('api', ['ready', 'ready', 'in_progress', 'assigned', 'merged']);
const web = project('web', ['in_review']);
stateRoot('0123456789abcdef-api', {
  'marker.json': marker(api),
  'crew.json': crew({
    'APP-3': { pid: 11 },
    'APP-4': { pid: 12 },
    'APP-9': { pid: 11, stoppedAt: 'x' },
  }),
  'queue.json': JSON.stringify({
    current: { pr: 1, repo: 'org/app', step: 'checks' },
    pending: [{ pr: 2, repo: 'org/app' }],
    done: [],
  }),
});
stateRoot('fedcba9876543210-web', {
  'marker.json': marker(web),
  'queue.json': '{ not json',
});
stateRoot('1111111111111111-gone', { 'marker.json': marker(join(root, 'gone')) });
stateRoot('2222222222222222-bare', {});
stateRoot('owner', { 'usage.json': '{}' });
stateRoot('not-a-project', {});

const alive = (pid: number) => pid === 11;

/** Every path below `dir` with its size and modification time: what a write would change. */
function tree(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((e) => {
      const p = join(e.parentPath, e.name);
      const s = statSync(p);
      return `${p} ${s.size} ${s.mtimeMs}`;
    })
    .sort();
}

describe('readOverview', () => {
  it('lists every project state root with item counts, running crews and queued merges', () => {
    const list = readOverview(base, alive);
    expect(list.map((p) => p.name)).toEqual(['api', 'bare', 'gone', 'web']);
    expect(list[0]).toEqual({
      name: 'api',
      stateRoot: join(base, '0123456789abcdef-api'),
      project: api,
      items: { ready: 2, assigned: 1, in_progress: 1, merged: 1 },
      crews: 1,
      queued: 2,
      problems: [],
    });
  });

  it('reports a broken or partial state root and goes on', () => {
    const byName = Object.fromEntries(readOverview(base, alive).map((p) => [p.name, p]));
    expect(byName.web).toMatchObject({ items: { in_review: 1 }, crews: 0 });
    expect(byName.web?.queued).toBeUndefined();
    expect(byName.web?.problems.join()).toMatch(/queue file .* is not valid JSON/);
    expect(byName.gone?.items).toBeUndefined();
    expect(byName.gone?.problems.join()).toMatch(/board/);
    expect(byName.bare?.project).toBeUndefined();
    expect(byName.bare?.problems).toEqual(['no marker.json: the project is unknown']);
    expect(byName.bare).toMatchObject({ crews: 0, queued: 0 });
  });

  it('skips the owner dir and names that are no project root', () => {
    const roots = readOverview(base, alive).map((p) => p.stateRoot);
    expect(roots.some((r) => r.endsWith('owner') || r.endsWith('not-a-project'))).toBe(false);
  });

  it('writes nothing', () => {
    const before = tree(root);
    readOverview(base, alive);
    expect(tree(root)).toEqual(before);
  });

  it('is empty when there is no state base yet', () => {
    expect(readOverview(join(root, 'missing'), alive)).toEqual([]);
  });

  it('prints one row per project', () => {
    const text = formatOverview(readOverview(base, alive));
    expect(text.split('\n')[0]).toMatch(/^PROJECT\s+ITEMS\s+CREWS\s+QUEUED\s+PROBLEMS$/);
    expect(text).toMatch(/api\s+ready 2, assigned 1, in_progress 1, merged 1\s+1\s+2/);
    expect(text).toMatch(/web\s+in_review 1\s+0\s+\?\s+queue file/);
    expect(formatOverview([])).toBe('No Studio projects yet.\n');
  });

  it('keeps file content out of the problems', () => {
    writeFileSync(join(base, 'fedcba9876543210-web', 'crew.json'), '"secret\u001b[2J"');
    const web = readOverview(base, alive).find((p) => p.name === 'web');
    expect(web?.problems.join()).not.toContain('secret');
    expect(readFileSync(join(base, 'fedcba9876543210-web', 'crew.json'), 'utf8')).toContain(
      'secret',
    );
  });
});
