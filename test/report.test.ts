import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { WorkItem } from '../src/board.js';
import { collectReport, parseReport, ReportError } from '../src/report.js';

const dir = mkdtempSync(join(tmpdir(), 'studio-report-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SHA = 'a'.repeat(40);
const item = (type: WorkItem['type']): WorkItem => ({
  id: 'APP-1',
  title: 't',
  type,
  role: 'builder',
  repo: 'org/app',
  size: 'S',
  priority: 1,
  status: 'assigned',
  paths: [],
  touches: [],
  dependsOn: [],
  dod: [],
  history: [],
});

const doc = (front: string) => `---\n${front}\n---\n\nBody text.\n`;

describe('parseReport', () => {
  it('rejects done without testsRun for build types', () => {
    const text = doc(`status: done\nitem: APP-1\npr: 4\nhead_sha: ${SHA}\ntests_run: 0`);
    expect(() => parseReport(text, item('feature'))).toThrow(ReportError);
    expect(() => parseReport(text, item('fix'))).toThrow(/tests_run|testsRun/);
    expect(() => parseReport(text, item('chore'))).toThrow(ReportError);
    expect(parseReport(text, item('docs')).status).toBe('done');
  });

  it('reads lessons list', () => {
    const r = parseReport(
      doc(
        `status: done\npr: 4\nhead_sha: ${SHA}\ntests_run: 3\nlessons:\n  - first\n  - second\nquestions: []`,
      ),
      item('feature'),
    );
    expect(r).toMatchObject({
      status: 'done',
      pr: 4,
      headSha: SHA,
      testsRun: 3,
      lessons: ['first', 'second'],
      questions: [],
    });
  });

  it('defaults lists, accepts blocked without sha, rejects done without a valid sha', () => {
    expect(parseReport(doc('status: blocked'))).toMatchObject({
      status: 'blocked',
      lessons: [],
      questions: [],
    });
    expect(() => parseReport(doc('status: done\ntests_run: 1'))).toThrow(ReportError);
    expect(() => parseReport(doc('status: done\ntests_run: 1\nhead_sha: abc123'))).toThrow(
      ReportError,
    );
  });

  it('keeps an all-digit or exponent-looking sha as a string', () => {
    const digits = '1'.repeat(40);
    expect(parseReport(doc(`status: done\ntests_run: 1\nhead_sha: ${digits}`)).headSha).toBe(
      digits,
    );
    const expo = `12345e${'6'.repeat(34)}`;
    expect(parseReport(doc(`status: done\ntests_run: 1\nhead_sha: ${expo}`)).headSha).toBe(expo);
  });

  it('rejects missing frontmatter, bad status and a foreign item id', () => {
    expect(() => parseReport('no frontmatter')).toThrow(ReportError);
    expect(() => parseReport(doc('status: great'))).toThrow(ReportError);
    expect(() => parseReport(doc('status: blocked\nitem: APP-2'), item('docs'))).toThrow(/item/);
  });
});

describe('collectReport', () => {
  const write = (id: string, front: string) => {
    mkdirSync(join(dir, '.studio', 'reports'), { recursive: true });
    writeFileSync(join(dir, '.studio', 'reports', `${id}.md`), doc(front));
  };

  it('rejects a report whose headSha differs from the PR head', () => {
    write('APP-1', `status: done\npr: 4\nhead_sha: ${SHA}\ntests_run: 2`);
    expect(() => collectReport(dir, 'APP-1', 'b'.repeat(40))).toThrow(/head/i);
    expect(collectReport(dir, 'APP-1', SHA).headSha).toBe(SHA);
    expect(collectReport(dir, 'APP-1').status).toBe('done');
  });

  it('throws ReportError when the file is missing', () => {
    expect(() => collectReport(dir, 'APP-9')).toThrow(ReportError);
  });
});
