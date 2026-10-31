import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { join, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { WorkItem } from './board.js';

export class ReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportError';
  }
}

const BUILD_TYPES: readonly WorkItem['type'][] = ['feature', 'fix', 'chore'];
const NO_PR_TYPES: readonly WorkItem['type'][] = ['review', 'research'];
const REVIEWS_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d{0,9}$/;
const SHA_RE = /^[0-9a-f]{40}$/i;

const reportSchema = z.object({
  status: z.enum(['done', 'blocked', 'failed']),
  item: z.string().optional(),
  pr: z.number().int().positive().nullish(),
  headSha: z.string().nullish(),
  testsRun: z.number().int().nonnegative().nullish(),
  verdict: z.enum(['approve', 'changes_requested']).nullish(),
  reviews: z.string().regex(REVIEWS_RE).nullish(),
  lessons: z.array(z.string()).default([]),
  questions: z.array(z.string()).default([]),
});

export interface Report {
  status: 'done' | 'blocked' | 'failed';
  item?: string;
  pr?: number;
  headSha?: string;
  testsRun?: number;
  verdict?: 'approve' | 'changes_requested';
  reviews?: string;
  lessons: string[];
  questions: string[];
}

const camel = (key: string): string =>
  key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Parses the YAML frontmatter of a crew report; the body is free text and not interpreted. */
export function parseReport(text: string, item?: WorkItem): Report {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) throw new ReportError('report has no YAML frontmatter');
  // A 40-hex sha made of digits or with an exponent would be read as a number: force a string.
  const front = (m[1] as string).replace(/^(head_sha:[ \t]*)([0-9a-fA-F]{40})[ \t]*$/m, '$1"$2"');
  let raw: unknown;
  try {
    raw = parseYaml(front);
  } catch {
    // Fixed text: crew-controlled content must never reach the output.
    throw new ReportError('report frontmatter is not valid YAML');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ReportError('report frontmatter must be a mapping');
  }
  const camelized = Object.fromEntries(Object.entries(raw).map(([k, v]) => [camel(k), v]));
  const parsed = reportSchema.safeParse(camelized);
  if (!parsed.success) {
    throw new ReportError(
      `invalid report: bad field ${[...new Set(parsed.error.issues.map((i) => i.path.map(String).join('.') || '(root)'))].join(', ')}`,
    );
  }
  const d = parsed.data;
  if (item && d.item !== undefined && d.item !== item.id) {
    throw new ReportError(`report item does not match ${item.id}`);
  }
  if (d.status === 'done') {
    // Review and research items may finish without a PR; a PR still needs its head.
    const noPrOk = item !== undefined && NO_PR_TYPES.includes(item.type) && d.pr == null;
    if (d.headSha ? !SHA_RE.test(d.headSha) : !noPrOk) {
      throw new ReportError('done report needs head_sha (40 hex characters)');
    }
    if (item?.type === 'review' && !d.verdict) {
      throw new ReportError('done report for a review item needs verdict');
    }
    if (item && BUILD_TYPES.includes(item.type) && !(d.testsRun && d.testsRun > 0)) {
      throw new ReportError(`done report for a ${item.type} item needs tests_run > 0`);
    }
  }
  return {
    status: d.status,
    ...(d.item !== undefined && { item: d.item }),
    ...(d.pr != null && { pr: d.pr }),
    ...(d.headSha != null && { headSha: d.headSha }),
    ...(d.testsRun != null && { testsRun: d.testsRun }),
    ...(d.verdict != null && { verdict: d.verdict }),
    ...(d.reviews != null && { reviews: d.reviews }),
    lessons: d.lessons,
    questions: d.questions,
  };
}

export const MAX_REPORT_BYTES = 256 * 1024;
const UNSAFE = 'report file is missing or not a safe regular file';

/**
 * Reads a crew-written report as untrusted input: no symlink between the clone root and the file,
 * a regular file of at most 256 KB, opened without following links. Errors carry fixed text only.
 */
function readReportFile(root: string, file: string): string {
  const unsafe = () => new ReportError(UNSAFE);
  let fd: number | undefined;
  try {
    const parts = [root, join(root, '.studio'), join(root, '.studio', 'reports'), file];
    parts.forEach((p, i) => {
      const st = lstatSync(p);
      if (st.isSymbolicLink()) throw unsafe();
      if (i < parts.length - 1 ? !st.isDirectory() : !st.isFile()) throw unsafe();
    });
    const realRoot = realpathSync(root);
    if (!realpathSync(file).startsWith(realRoot + sep)) throw unsafe();
    fd = openSync(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    if (!fstatSync(fd).isFile()) throw unsafe();
    // Bounded read that does not trust the size: a file that grows still stops at the cap.
    const buf = Buffer.alloc(MAX_REPORT_BYTES + 1);
    let total = 0;
    while (total < buf.length) {
      const n = readSync(fd, buf, total, buf.length - total, null);
      if (n === 0) break;
      total += n;
    }
    if (total > MAX_REPORT_BYTES) throw unsafe();
    return buf.toString('utf8', 0, total);
  } catch (e) {
    throw e instanceof ReportError ? e : unsafe();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Reads and parses `<worktree>/.studio/reports/<id>.md` exactly once. */
export function readReport(worktree: string, id: string, item?: WorkItem): Report {
  const file = join(worktree, '.studio', 'reports', `${id}.md`);
  return parseReport(readReportFile(worktree, file), item);
}

/**
 * A report that names a head (always for `done`) only counts for that exact commit: rejects a
 * different PR head.
 */
export function checkReportHead(report: Report, prHead: string): void {
  if (
    (report.status === 'done' || report.headSha !== undefined) &&
    report.headSha?.toLowerCase() !== prHead.toLowerCase()
  ) {
    throw new ReportError('report head differs from PR head');
  }
}

/** Reads the report once; with `prHead` (the current PR head sha) also checks the head. */
export function collectReport(
  worktree: string,
  id: string,
  prHead?: string,
  item?: WorkItem,
): Report {
  const report = readReport(worktree, id, item);
  if (prHead !== undefined) checkReportHead(report, prHead);
  return report;
}
