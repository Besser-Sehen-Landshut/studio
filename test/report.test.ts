import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { WorkItem } from '../src/board.js';
import {
  collectReport,
  MAX_REPORT_BYTES,
  parseReport,
  ReportError,
  readReport,
} from '../src/report.js';

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

describe('a report that leaves the pull request to Studio', () => {
  it('pr_title instead of pr is a done report; the body is the pull request text', () => {
    const r = parseReport(
      `---\nstatus: done\nitem: APP-1\npr_title: "APP-1: fix it"\nhead_sha: ${SHA}\ntests_run: 3\n---\n\nWhat changed.\n`,
      item('fix'),
    );
    expect(r.pr).toBeUndefined();
    expect(r.prTitle).toBe('APP-1: fix it');
    expect(r.body).toBe('What changed.');
  });
  it('a title over 200 characters or with a line break refuses', () => {
    for (const t of ['x'.repeat(201), 'a\\nb']) {
      expect(() =>
        parseReport(
          `---\nstatus: done\npr_title: "${t}"\nhead_sha: ${SHA}\ntests_run: 3\n---\n`,
          item('fix'),
        ),
      ).toThrow(/pr_title|prTitle/);
    }
  });
});

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
  it('accepts a done review report without pr, with the head it reviewed', () => {
    const r = parseReport(
      doc(
        'status: done\nitem: APP-1\nverdict: approve\nreviews: org/app#9\nhead_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ),
      item('review'),
    );
    expect(r).toMatchObject({ status: 'done', verdict: 'approve', reviews: 'org/app#9' });
    expect(r.pr).toBeUndefined();
    expect(r.headSha).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('refuses a done review report without head_sha, or with a pr of its own', () => {
    expect(() =>
      parseReport(
        doc('status: done\nitem: APP-1\nverdict: approve\nreviews: org/app#9'),
        item('review'),
      ),
    ).toThrow(/head_sha/);
    expect(() =>
      parseReport(
        doc(
          'status: done\nverdict: approve\npr: 3\nhead_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        ),
        item('review'),
      ),
    ).toThrow(/no pr/);
  });

  it('requires a verdict on done review reports and rejects bad values', () => {
    expect(() =>
      parseReport(
        doc('status: done\nitem: APP-1\nhead_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
        item('review'),
      ),
    ).toThrow(/verdict/);
    expect(() =>
      parseReport(
        doc('status: done\nverdict: merge_it\nhead_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
        item('review'),
      ),
    ).toThrow(ReportError);
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

  it('R80: refuses a report last modified before notBefore', () => {
    write('APP-2', `status: done\npr: 4\nhead_sha: ${SHA}\ntests_run: 2`);
    const file = join(dir, '.studio', 'reports', 'APP-2.md');
    utimesSync(file, new Date('2026-10-31T09:00:00Z'), new Date('2026-10-31T09:00:00Z'));
    const start = new Date('2026-10-31T10:00:00Z');
    expect(() => readReport(dir, 'APP-2', undefined, { notBefore: start })).toThrow(
      /older than the crew run/,
    );
    utimesSync(file, start, start);
    expect(readReport(dir, 'APP-2', undefined, { notBefore: start }).status).toBe('done');
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

describe('review fields', () => {
  const parse = (front: string) => parseReport(`---\nstatus: blocked\n${front}\n---\n`);
  it('reads a probe that stayed green', () => {
    expect(parse('mutation_probe: "green: t"').mutationProbe).toBe('green: t');
  });
  it('reads analyzers, the probe and the attempts', () => {
    const r = parse(
      'analyzers: { a: pass, b: findings, c: "skipped: no source" }\nmutation_probe: "red: t"\nfinding_attempts: 2',
    );
    expect(r.analyzers).toEqual({ a: 'pass', b: 'findings', c: 'skipped: no source' });
    expect(r.mutationProbe).toBe('red: t');
    expect(r.findingAttempts).toBe(2);
  });
  it.each([
    'analyzers: { a: maybe }',
    'analyzers: { a: "pass\\nx" }',
    'analyzers: { "a b": pass }',
    'mutation_probe: green',
    'mutation_probe: "red: "',
    'finding_attempts: -1',
    'not_run_here_jobs:\n  - { command: make e2e, job: e2e }',
    'not_run_here_jobs:\n  - { command: make e2e, workflow: ci.yml, job: "e2e\\nx" }',
    'not_run_here_jobs:\n  - { command: make e2e, workflow: ci.yml, job: e2e, passed: true }',
  ])('refuses %s, without echoing it', (front) => {
    expect(() => parse(front)).toThrow(/bad field/);
  });
  it('reads the CI job named for each not_run_here command; an empty value is none', () => {
    expect(
      parse(
        'not_run_here_jobs:\n  - { command: make e2e, workflow: .github/workflows/ci.yml, job: e2e }',
      ).notRunHereJobs,
    ).toEqual([{ command: 'make e2e', workflow: '.github/workflows/ci.yml', job: 'e2e' }]);
    expect(parse('not_run_here_jobs:').notRunHereJobs).toEqual([]);
    expect(parse('').notRunHereJobs).toEqual([]);
  });
});

describe('commands a crew could not run in its sandbox', () => {
  const NOT_RUN = [
    'not_run_here:',
    '  - command: cargo test --workspace',
    '    missing: database',
    '    reason: "1370 database-backed tests in other crates stop with DATABASE_URL must be set"',
  ].join('\n');
  const done = (extra: string) =>
    doc(`status: done\nitem: APP-1\npr: 4\nhead_sha: ${SHA}\ntests_run: 742\n${extra}`);

  it('a done report lists them with the command, the missing service and the reason', () => {
    const r = parseReport(done(NOT_RUN), item('fix'));
    expect(r.status).toBe('done');
    expect(r.notRunHere).toEqual([
      {
        command: 'cargo test --workspace',
        missing: 'database',
        reason: '1370 database-backed tests in other crates stop with DATABASE_URL must be set',
      },
    ]);
  });

  it('defaults to an empty list', () => {
    expect(parseReport(done(''), item('fix')).notRunHere).toEqual([]);
  });

  it('reads an empty value as an empty list, like lessons and questions', () => {
    const r = parseReport(done('not_run_here:\nlessons:\nquestions:'), item('fix'));
    expect(r.notRunHere).toEqual([]);
    expect(r.lessons).toEqual([]);
    expect(r.questions).toEqual([]);
  });

  it('strips format characters (bidi, zero-width) from command and reason', () => {
    const r = parseReport(
      done(
        'not_run_here:\n  - { command: "make\u202e e2e\u200b", missing: docker, reason: "no\u2066 docker\ufeff" }',
      ),
      item('fix'),
    );
    expect(r.notRunHere).toEqual([{ command: 'make e2e', missing: 'docker', reason: 'no docker' }]);
  });

  it('cuts an over-long reason to 300 characters instead of refusing the report', () => {
    // the real case: a crew wrote a 500-character reason and its whole report was refused twice
    const long = `DATABASE_URL must be set: ${'x'.repeat(480)}`;
    const r = parseReport(
      done(`not_run_here:\n  - { command: cargo test, missing: database, reason: "${long}" }`),
      item('fix'),
    );
    const reason = r.notRunHere[0]?.reason ?? '';
    expect([...reason]).toHaveLength(300);
    expect(reason.endsWith('…')).toBe(true);
    expect(reason.startsWith('DATABASE_URL must be set: ')).toBe(true);
  });

  it('still refuses an over-long command: the job gate matches commands exactly', () => {
    expect(() =>
      parseReport(
        done(`not_run_here:\n  - { command: "${'c'.repeat(301)}", missing: docker, reason: x }`),
        item('fix'),
      ),
    ).toThrow(/bad field notRunHere/);
  });

  it('refuses a field that is only format characters', () => {
    expect(() =>
      parseReport(
        done('not_run_here:\n  - { command: "\u200b", missing: docker, reason: x }'),
        item('fix'),
      ),
    ).toThrow(/bad field notRunHere/);
  });

  it.each(['database', 'docker', 'network', 'service'])('names the missing %s', (missing) => {
    const r = parseReport(
      done(`not_run_here:\n  - { command: make e2e, missing: ${missing}, reason: x }`),
      item('fix'),
    );
    expect(r.notRunHere[0]?.missing).toBe(missing);
  });

  it.each([
    ['no missing service', '  - { command: cargo test --workspace, reason: took too long }'],
    ['a missing that is no service', '  - { command: cargo test, missing: time, reason: slow }'],
    ['no reason', '  - { command: cargo test --workspace, missing: database }'],
    ['an empty reason', '  - { command: cargo test --workspace, missing: database, reason: "" }'],
    ['no command', '  - { missing: database, reason: x }'],
    ['a plain string', '  - cargo test --workspace'],
    ['an unknown key', '  - { command: c, missing: database, reason: x, passed: true }'],
  ])('refuses an entry with %s', (_why, entry) => {
    expect(() => parseReport(done(`not_run_here:\n${entry}`), item('fix'))).toThrow(
      /bad field notRunHere/,
    );
  });

  it('refuses a control character in a command; one in a reason becomes a space', () => {
    expect(() =>
      parseReport(
        done('not_run_here:\n  - { command: "a\\u0007b", missing: database, reason: x }'),
        item('fix'),
      ),
    ).toThrow(/bad field notRunHere/);
    // Nothing matches against a reason: a line break in it never rejects the whole report.
    const r = parseReport(
      done('not_run_here:\n  - { command: a, missing: database, reason: "x\\ny" }'),
      item('fix'),
    );
    expect(r.notRunHere[0]?.reason).toBe('x y');
  });

  it('a failed report stays failed with the list', () => {
    const r = parseReport(
      doc(`status: failed\nitem: APP-1\ntests_run: 3\n${NOT_RUN}`),
      item('fix'),
    );
    expect(r.status).toBe('failed');
    expect(r.notRunHere).toHaveLength(1);
  });
});
