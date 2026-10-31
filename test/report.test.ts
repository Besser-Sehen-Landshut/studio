import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { WorkItem } from '../src/board.js';
import { collectReport, MAX_REPORT_BYTES, parseReport, ReportError } from '../src/report.js';

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

describe('parseReport for review and research items', () => {
  it('accepts a done review report without pr and head_sha', () => {
    const r = parseReport(
      doc('status: done\nitem: APP-1\nverdict: approve\nreviews: org/app#9'),
      item('review'),
    );
    expect(r).toMatchObject({ status: 'done', verdict: 'approve', reviews: 'org/app#9' });
    expect(r.pr).toBeUndefined();
    expect(r.headSha).toBeUndefined();
  });

  it('requires a verdict on done review reports and rejects bad values', () => {
    expect(() => parseReport(doc('status: done\nitem: APP-1'), item('review'))).toThrow(/verdict/);
    expect(() => parseReport(doc('status: done\nverdict: merge_it'), item('review'))).toThrow(
      ReportError,
    );
    expect(() =>
      parseReport(doc('status: done\nverdict: approve\nreviews: nope'), item('review')),
    ).toThrow(ReportError);
  });

  it('accepts a done research report without pr', () => {
    expect(parseReport(doc('status: done\nitem: APP-1'), item('research')).status).toBe('done');
  });

  it('still requires head_sha when a pr is present, and for build types', () => {
    expect(() => parseReport(doc('status: done\nverdict: approve\npr: 3'), item('review'))).toThrow(
      /head_sha/,
    );
    expect(() => parseReport(doc('status: done\ntests_run: 3'), item('feature'))).toThrow(
      /head_sha/,
    );
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

describe('collectReport treats the report as untrusted input', () => {
  const SECRET = 'sk-fake-secret-value-123';
  const mk = () => {
    const d = mkdtempSync(join(tmpdir(), 'studio-rep-'));
    dirsToClean.push(d);
    return d;
  };
  const dirsToClean: string[] = [];
  afterAll(() => {
    for (const d of dirsToClean) rmSync(d, { recursive: true, force: true });
  });
  const errOf = (fn: () => unknown): string => {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(ReportError);
      return (e as Error).message;
    }
    throw new Error('did not throw');
  };

  it('refuses a symlinked report and does not leak the target', () => {
    const d = mk();
    const target = join(mk(), 'secret.md');
    writeFileSync(target, `---\nstatus: done\n${SECRET}\n---\n`);
    mkdirSync(join(d, '.studio', 'reports'), { recursive: true });
    symlinkSync(target, join(d, '.studio', 'reports', 'APP-1.md'));
    const msg = errOf(() => collectReport(d, 'APP-1'));
    expect(msg).not.toContain(SECRET);
    expect(msg).not.toContain(target);
  });

  it('refuses a symlinked .studio directory', () => {
    const d = mk();
    const other = mk();
    mkdirSync(join(other, 'reports'));
    writeFileSync(join(other, 'reports', 'APP-1.md'), '---\nstatus: blocked\n---\n');
    symlinkSync(other, join(d, '.studio'));
    expect(() => collectReport(d, 'APP-1')).toThrow(ReportError);
  });

  it('refuses a FIFO and an oversized report', () => {
    const d = mk();
    const dir = join(d, '.studio', 'reports');
    mkdirSync(dir, { recursive: true });
    execFileSync('mkfifo', [join(dir, 'APP-1.md')]);
    expect(() => collectReport(d, 'APP-1')).toThrow(ReportError);
    const big = mk();
    mkdirSync(join(big, '.studio', 'reports'), { recursive: true });
    writeFileSync(
      join(big, '.studio', 'reports', 'APP-1.md'),
      `---\nstatus: blocked\n---\n${'x'.repeat(300 * 1024)}`,
    );
    expect(() => collectReport(big, 'APP-1')).toThrow(ReportError);
  });

  it('the size cap is on bytes read: exactly the cap passes, one more byte is refused', () => {
    const d = mk();
    const dir = join(d, '.studio', 'reports');
    mkdirSync(dir, { recursive: true });
    const head = '---\nstatus: blocked\n---\n';
    writeFileSync(join(dir, 'APP-1.md'), head + 'x'.repeat(MAX_REPORT_BYTES - head.length));
    expect(collectReport(d, 'APP-1').status).toBe('blocked');
    writeFileSync(join(dir, 'APP-1.md'), head + 'x'.repeat(MAX_REPORT_BYTES - head.length + 1));
    expect(() => collectReport(d, 'APP-1')).toThrow(ReportError);
  });

  it('error messages never contain report content', () => {
    const d = mk();
    mkdirSync(join(d, '.studio', 'reports'), { recursive: true });
    const write = (front: string) =>
      writeFileSync(join(d, '.studio', 'reports', 'APP-1.md'), `---\n${front}\n---\n`);
    write(`status: [${SECRET}\n  bad: : :`);
    expect(errOf(() => collectReport(d, 'APP-1'))).not.toContain(SECRET);
    write(`status: ${SECRET}`);
    expect(errOf(() => collectReport(d, 'APP-1'))).not.toContain(SECRET);
    write(`status: blocked\nitem: ${SECRET}`);
    expect(errOf(() => collectReport(d, 'APP-1', undefined, item('docs')))).not.toContain(SECRET);
    write(`status: blocked\nhead_sha: ${SECRET}`);
    expect(errOf(() => collectReport(d, 'APP-1', 'a'.repeat(40)))).not.toContain(SECRET);
  });
});
