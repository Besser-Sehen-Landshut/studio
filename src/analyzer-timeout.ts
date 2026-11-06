// Hard time limits for a reviewer crew: each analyzer subagent, and the review session as a whole.
// Claude Code fires the crew's hooks inside subagents too, with `agent_id` in the input
// (https://code.claude.com/docs/en/hooks, "Common input fields"), and `SubagentStart` when one is
// spawned. The guard records each subagent's start and, once its time is up, denies every further
// tool call of that subagent with a fixed line telling it to stop and answer `skipped: timeout`. The
// session itself gets a deadline after which only the report may still be written. `tick` stops a
// reviewer that is still alive well after that deadline and hands the item to the lead.
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/** Default minutes per analyzer subagent: `review.analyzer_timeout_minutes` in studio.yaml. */
export const DEFAULT_ANALYZER_TIMEOUT_MINUTES = 30;
/** After the session deadline, how long `tick` waits for the report before it stops the crew. */
export const REVIEW_GRACE_MS = 15 * 60_000;
/** What a timed-out analyzer reads in the report; the approval rules hold it to `skipped:`. */
export const TIMEOUT_RESULT = 'skipped: timeout';
/** At most this many subagents are remembered per run; more refuse (fail closed). */
const MAX_AGENTS = 500;

/** The time limits of one reviewer run, as the guard context carries them. */
export interface ReviewTimeouts {
  /** Per analyzer subagent, in milliseconds, from its start. */
  analyzerMs: number;
  /** When the session's time is up (ISO): from then on only the report may be written. */
  sessionEndsAt: string;
  /** The absolute path of this run's report file in the clone. */
  reportFile: string;
  /** Where the guard keeps the start of each subagent (absolute, below the state root). */
  agentsFile: string;
}

/**
 * The limits of a reviewer launched now: each analyzer gets its minutes, and the session the
 * minutes of every analyzer one after another plus one more share for loading and the report.
 */
export function reviewTimeouts(o: {
  analyzerMinutes: number;
  analyzers: number;
  now: Date;
  reportFile: string;
  agentsFile: string;
}): ReviewTimeouts {
  const analyzerMs = o.analyzerMinutes * 60_000;
  const sessionMs = analyzerMs * (Math.max(1, o.analyzers) + 1);
  return {
    analyzerMs,
    sessionEndsAt: new Date(o.now.getTime() + sessionMs).toISOString(),
    reportFile: o.reportFile,
    agentsFile: o.agentsFile,
  };
}

/** The line a subagent gets once its time is up. Studio's own words; the crew reads it. */
export const analyzerTimeUp = (minutes: number): string =>
  `Studio: this subagent's time is up (analyzer timeout of ${minutes} min). Call no further tool. End now and answer with exactly "${TIMEOUT_RESULT}"; the reviewer records the analyzer as ${TIMEOUT_RESULT}.`;

/** The line the reviewer gets once the session's time is up. */
export const sessionTimeUp = (report: string): string =>
  `Studio: the review's time is up. Only the report may still be written: write ${report} now, with "${TIMEOUT_RESULT}" for every analyzer that has no result, and end.`;

const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit'];

/**
 * Pure: whether a tool call of a reviewer run is past its time. `agentId` is set for a call made
 * inside a subagent, with the subagent's start (`agentStart`, epoch ms). Returns the deny line, or
 * undefined to let the call through to the rest of the guard.
 */
export function timeoutDecision(
  t: ReviewTimeouts,
  call: {
    now: number;
    agentId?: string;
    agentStart?: number;
    toolName: string;
    toolInput: Record<string, unknown>;
    cwd?: string;
  },
): string | undefined {
  const ends = Date.parse(t.sessionEndsAt);
  // A deadline that cannot be read counts as passed: fail closed.
  const sessionOver = Number.isNaN(ends) || call.now >= ends;
  if (call.agentId !== undefined) {
    const start = call.agentStart;
    if (start === undefined || call.now - start >= t.analyzerMs || sessionOver) {
      return analyzerTimeUp(Math.round(t.analyzerMs / 60_000));
    }
    return undefined;
  }
  if (!sessionOver) return undefined;
  const target = call.toolInput.file_path;
  if (WRITE_TOOLS.includes(call.toolName) && typeof target === 'string') {
    const full = isAbsolute(target) ? resolve(target) : resolve(call.cwd ?? '/', target);
    if (full === resolve(t.reportFile)) return undefined;
  }
  return sessionTimeUp(t.reportFile);
}

/** The subagent starts of one run: agent id to epoch ms. A missing file is none yet. */
export function readAgentStarts(file: string): Record<string, number> {
  let text: string;
  try {
    if (!lstatSync(file).isFile()) throw new Error(`${file} is not a plain file`);
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
  const raw = JSON.parse(text) as unknown;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${file} is not an object`);
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'number') out[k] = v;
  return out;
}

const AGENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The start of subagent `agentId`: the recorded one, else `now`, recorded. Throws on an id of an
 * unexpected form or a file it cannot keep, so the guard denies (fail closed). Two calls racing
 * may both record; the later start wins, which errs towards more time, by at most one call.
 */
export function agentStartOf(file: string, agentId: string, now: number): number {
  if (!AGENT_ID_RE.test(agentId)) throw new Error('unexpected agent id');
  const starts = readAgentStarts(file);
  const known = starts[agentId];
  if (known !== undefined) return known;
  if (Object.keys(starts).length >= MAX_AGENTS) throw new Error('too many subagents in one run');
  starts[agentId] = now;
  const tmp = `${file}.${process.pid}.${now}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(starts)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return now;
}

/** The timeouts in a guard context file, or undefined when the run has none or it is unreadable. */
export function timeoutsOfContext(ctxFile: string): ReviewTimeouts | undefined {
  try {
    const ctx = JSON.parse(readFileSync(ctxFile, 'utf8')) as { timeouts?: ReviewTimeouts };
    const t = ctx?.timeouts;
    if (
      t === undefined ||
      typeof t.analyzerMs !== 'number' ||
      typeof t.sessionEndsAt !== 'string' ||
      typeof t.reportFile !== 'string' ||
      typeof t.agentsFile !== 'string'
    ) {
      return undefined;
    }
    return t;
  } catch {
    return undefined;
  }
}

/** The brief's lines on the time limits; Studio's own words, no crew text. */
export function timeoutBrief(t: { analyzerMinutes: number; sessionEndsAt: string }): string[] {
  return [
    '## Time limits',
    '',
    `- Each analyzer subagent has ${t.analyzerMinutes} minutes from its start. Studio holds it: once its time is up, every further tool call of that subagent is refused with a line that says so. Record such an analyzer as \`${TIMEOUT_RESULT}\`, never as a pass, and go on with the next one.`,
    `- The review as a whole ends at ${t.sessionEndsAt} (UTC). From then on Studio refuses every tool call except writing the report file: write it then, with \`${TIMEOUT_RESULT}\` for every analyzer without a result.`,
    `- A mandatory analyzer that reads \`${TIMEOUT_RESULT}\` refuses the approval: the lead decides. Report the verdict your results support; never approve to beat the clock.`,
    '',
  ];
}

/** Whether an analyzer result is the timeout skip (any case, trailing reason words allowed). */
export const isTimeoutResult = (result: string | undefined): boolean =>
  result !== undefined && /^skipped:\s*timeout\b/i.test(result.trim());

/**
 * The refusal parts for owed analyzers that read `skipped:`: a timeout is named as one, so the lead
 * sees that the clock, not the analyzer, stopped it. Never passes: both refuse the approval.
 */
export function skippedOwedParts(
  skippedOwed: readonly string[],
  results: Readonly<Record<string, string | undefined>>,
): string[] {
  const timedOut = skippedOwed.filter((id) => isTimeoutResult(results[id]));
  const other = skippedOwed.filter((id) => !timedOut.includes(id));
  return [
    ...(timedOut.length > 0 ? [`mandatory analyzer timed out: ${timedOut.join(', ')}`] : []),
    ...(other.length > 0 ? [`mandatory analyzer skipped: ${other.join(', ')}`] : []),
  ];
}
