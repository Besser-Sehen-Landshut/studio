import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
const SHA_RE = /^[0-9a-f]{40}$/i;

const reportSchema = z.object({
  status: z.enum(['done', 'blocked', 'failed']),
  item: z.string().optional(),
  pr: z.number().int().positive().nullish(),
  headSha: z.string().nullish(),
  testsRun: z.number().int().nonnegative().nullish(),
  lessons: z.array(z.string()).default([]),
  questions: z.array(z.string()).default([]),
});

export interface Report {
  status: 'done' | 'blocked' | 'failed';
  item?: string;
  pr?: number;
  headSha?: string;
  testsRun?: number;
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
  } catch (e) {
    throw new ReportError(`report frontmatter is not valid YAML (${(e as Error).message})`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ReportError('report frontmatter must be a mapping');
  }
  const camelized = Object.fromEntries(Object.entries(raw).map(([k, v]) => [camel(k), v]));
  const parsed = reportSchema.safeParse(camelized);
  if (!parsed.success) {
    throw new ReportError(
      `invalid report: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const d = parsed.data;
  if (item && d.item !== undefined && d.item !== item.id) {
    throw new ReportError(`report item ${d.item} does not match ${item.id}`);
  }
  if (d.status === 'done') {
    if (!d.headSha || !SHA_RE.test(d.headSha)) {
      throw new ReportError('done report needs head_sha (40 hex characters)');
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
    lessons: d.lessons,
    questions: d.questions,
  };
}

/**
 * Reads `<worktree>/.studio/reports/<id>.md`. With `prHead` (the current PR head sha) a report that
 * names a different head is rejected: a report only counts for the commit it was written for.
 */
export function collectReport(
  worktree: string,
  id: string,
  prHead?: string,
  item?: WorkItem,
): Report {
  const file = join(worktree, '.studio', 'reports', `${id}.md`);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new ReportError(`cannot read report ${file} (${(e as Error).message})`);
  }
  const report = parseReport(text, item);
  if (
    prHead !== undefined &&
    (report.status === 'done' || report.headSha !== undefined) &&
    report.headSha?.toLowerCase() !== prHead.toLowerCase()
  ) {
    throw new ReportError(
      `report head ${report.headSha ?? '(none)'} differs from PR head ${prHead}`,
    );
  }
  return report;
}
