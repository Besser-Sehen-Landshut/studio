import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  agentStartOf,
  agentsFileOf,
  analyzerTimeUp,
  isTimeoutResult,
  markTimedOut,
  readAgentStarts,
  readAgents,
  reviewTimeouts,
  skippedOwedParts,
  TIMEOUT_RESULT,
  timedOutAgents,
  timeoutBrief,
  timeoutDecision,
  timeoutReportProblem,
  timeoutsFileOf,
  timeoutsOfContext,
} from '../src/analyzer-timeout.js';
import { parseConfig } from '../src/config.js';
import { classifyDecision } from '../src/pane-data.js';
import { checkReviewCaps } from '../src/review.js';

const dir = mkdtempSync(join(tmpdir(), 'studio-timeout-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const T0 = Date.parse('2026-11-06T10:00:00Z');
const MIN = 60_000;
const t = reviewTimeouts({
  analyzerMinutes: 30,
  analyzers: 3,
  now: new Date(T0),
  reportFile: '/clone/.studio/reports/r-abc.md',
  agentsFile: join(dir, 'agents.json'),
});

describe('reviewTimeouts', () => {
  it('gives each analyzer its minutes and the session all of them plus one share', () => {
    expect(t.analyzerMs).toBe(30 * MIN);
    expect(Date.parse(t.sessionEndsAt) - T0).toBe(4 * 30 * MIN);
  });
});

describe('timeoutDecision', () => {
  const call = (over: Partial<Parameters<typeof timeoutDecision>[1]>) =>
    timeoutDecision(t, { now: T0, toolName: 'Bash', toolInput: { command: 'ls' }, ...over });

  it('lets a subagent work within its time', () => {
    expect(call({ agentId: 'a1', agentStart: T0, now: T0 + 29 * MIN })).toBeUndefined();
  });
  it('refuses every tool of a subagent once its time is up, saying skipped: timeout', () => {
    const r = call({ agentId: 'a1', agentStart: T0, now: T0 + 30 * MIN });
    expect(r).toBe(analyzerTimeUp(30));
    expect(r).toContain(TIMEOUT_RESULT);
    expect(call({ agentId: 'a1', agentStart: T0, now: T0 + 31 * MIN, toolName: 'Read' })).toBe(r);
  });
  it('refuses a subagent whose start is unknown (fail closed)', () => {
    expect(call({ agentId: 'a1' })).toBe(analyzerTimeUp(30));
  });
  it('lets the main session work until the deadline', () => {
    expect(call({ now: T0 + 119 * MIN })).toBeUndefined();
  });
  it('after the deadline allows only writing the report', () => {
    const late = T0 + 121 * MIN;
    expect(call({ now: late })).toContain('time is up');
    expect(
      call({ now: late, toolName: 'Write', toolInput: { file_path: t.reportFile } }),
    ).toBeUndefined();
    expect(
      call({
        now: late,
        toolName: 'Write',
        toolInput: { file_path: '.studio/reports/r-abc.md' },
        cwd: '/clone',
      }),
    ).toBeUndefined();
    expect(
      call({ now: late, toolName: 'Write', toolInput: { file_path: '/clone/src/x.ts' } }),
    ).toContain('time is up');
    expect(call({ now: late, toolName: 'Agent', toolInput: { prompt: 'x' } })).toContain(
      'time is up',
    );
  });
  it('a subagent past the session deadline is refused too', () => {
    expect(call({ agentId: 'a2', agentStart: T0 + 119 * MIN, now: T0 + 121 * MIN })).toBe(
      analyzerTimeUp(30),
    );
  });
  it('an unreadable deadline counts as passed', () => {
    expect(
      timeoutDecision(
        { ...t, sessionEndsAt: 'never' },
        { now: T0, toolName: 'Bash', toolInput: {} },
      ),
    ).toContain('time is up');
  });
});

describe('agentStartOf', () => {
  it('records the first sight of a subagent and keeps it', () => {
    const file = join(dir, 'starts.json');
    expect(agentStartOf(file, 'agent-1', T0)).toBe(T0);
    expect(agentStartOf(file, 'agent-1', T0 + 5 * MIN)).toBe(T0);
    expect(agentStartOf(file, 'agent-2', T0 + 5 * MIN)).toBe(T0 + 5 * MIN);
    expect(readAgentStarts(file)).toEqual({ 'agent-1': T0, 'agent-2': T0 + 5 * MIN });
  });
  it('refuses an odd agent id and a file it cannot read, so the guard denies', () => {
    const file = join(dir, 'bad.json');
    expect(() => agentStartOf(file, '../x y', T0)).toThrow(/agent id/);
    writeFileSync(file, '[1]');
    expect(() => agentStartOf(file, 'a', T0)).toThrow();
  });
});

describe('a subagent stopped for time is recorded and held against the report', () => {
  const state = join(dir, 'state');
  mkdirSync(join(state, 'guard'), { recursive: true });
  const file = agentsFileOf(state, 'APP-9');
  const analyzers = ['diff-review', 'spec-check', 'similar-bugs', 'motion'];
  const pass = {
    'diff-review': 'pass',
    'spec-check': 'pass',
    'similar-bugs': 'pass',
    motion: 'pass',
  };

  const mandatory = ['diff-review', 'spec-check'];

  it('keeps each stopped subagent as one appended line, counted once', () => {
    agentStartOf(file, 'agent-a', T0, 'general-purpose');
    agentStartOf(file, 'agent-b', T0, 'similar-bugs');
    expect(readAgents(file)['agent-a']).toEqual({ start: T0, type: 'general-purpose' });
    expect(timedOutAgents(state, 'APP-9')).toBe(0);
    markTimedOut(file, 'agent-a');
    markTimedOut(file, 'agent-a');
    expect(readFileSync(timeoutsFileOf(file), 'utf8')).toBe('agent-a\nagent-a\n');
    expect(timedOutAgents(state, 'APP-9')).toBe(1);
    markTimedOut(file, 'agent-b');
    expect(timedOutAgents(state, 'APP-9')).toBe(2);
  });

  it('marks racing from many processes are all kept (append only)', async () => {
    const racing = agentsFileOf(state, 'APP-6');
    const script = `import { appendFileSync } from 'node:fs';\nfor (let i = 0; i < 50; i++) appendFileSync(process.argv[2], 'agent-' + process.argv[3] + '\\n', { flag: 'a' });\n`;
    const writer = join(dir, 'writer.mjs');
    writeFileSync(writer, script);
    // The same appends markTimedOut makes, from eight processes at once.
    await Promise.all(
      Array.from(
        { length: 8 },
        (_, k) =>
          new Promise<void>((done, fail) => {
            execFile(process.execPath, [writer, timeoutsFileOf(racing), String(k)], (e) =>
              e ? fail(e) : done(),
            );
          }),
      ),
    );
    expect(timedOutAgents(state, 'APP-6')).toBe(8);
    expect(
      readFileSync(timeoutsFileOf(racing), 'utf8')
        .split('\n')
        .filter((l) => l).length,
    ).toBe(400);
  });

  it('after a timeout, never an approval while a mandatory analyzer reads a result', () => {
    const problem = timeoutReportProblem(
      1,
      { ...pass, motion: TIMEOUT_RESULT },
      analyzers,
      mandatory,
    );
    expect(problem).toBe(
      'approval refused: the guard stopped 1 subagent for time, and mandatory diff-review, spec-check read a result: the lead decides',
    );
    expect(classifyDecision(problem as string)).toBe('analyzer_timeout');
    // Which subagent ran which analyzer is not trusted: a type named after an analyzer changes nothing.
    expect(timeoutReportProblem(2, pass, analyzers, mandatory)).toMatch(/the lead decides$/);
  });

  it('holds only when every mandatory analyzer reads skipped: timeout and the count is met', () => {
    const allTimeout = {
      'diff-review': TIMEOUT_RESULT,
      'spec-check': TIMEOUT_RESULT,
      'similar-bugs': 'pass',
      motion: 'pass',
    };
    expect(timeoutReportProblem(2, allTimeout, analyzers, mandatory)).toBeUndefined();
    expect(timeoutReportProblem(3, allTimeout, analyzers, mandatory)).toMatch(
      /stopped 3 subagents for time, but only 2 analyzers read skipped: timeout/,
    );
    expect(timeoutReportProblem(0, pass, analyzers, mandatory)).toBeUndefined();
  });

  it('a record that cannot be read, or a line of another form, counts as a timeout', () => {
    const bad = timeoutsFileOf(agentsFileOf(state, 'APP-8'));
    writeFileSync(bad, 'agent-1\n../x y\n');
    expect(timedOutAgents(state, 'APP-8')).toBe(2);
    rmSync(bad);
    mkdirSync(bad);
    expect(timedOutAgents(state, 'APP-8')).toBe(1);
    expect(timedOutAgents(state, 'APP-7')).toBe(0);
    expect(() => markTimedOut(agentsFileOf(state, 'APP-8'), 'agent-1')).toThrow();
  });
});

describe('timeoutsOfContext', () => {
  it('reads the timeouts of a guard context and nothing else', () => {
    const ctx = join(dir, 'ctx.json');
    writeFileSync(ctx, JSON.stringify({ worktree: '/x', timeouts: t }));
    expect(timeoutsOfContext(ctx)).toEqual(t);
    writeFileSync(ctx, JSON.stringify({ worktree: '/x' }));
    expect(timeoutsOfContext(ctx)).toBeUndefined();
    expect(timeoutsOfContext(join(dir, 'missing.json'))).toBeUndefined();
  });
});

describe('the approval rules', () => {
  const caps = {
    tier: 'large' as const,
    analyzers: ['diff-review', 'spec-check', 'similar-bugs', 'motion'],
    mandatory: ['diff-review', 'spec-check', 'similar-bugs'],
    reviewsTarget: 'org/app#7',
    headRefOid: 'a'.repeat(40),
    baseRefName: 'main',
  };
  const report = (analyzers: Record<string, string>) => ({
    status: 'done' as const,
    verdict: 'approve' as const,
    reviews: 'org/app#7',
    headSha: 'a'.repeat(40),
    lessons: [],
    questions: [],
    mutationProbe: 'red: t1',
    analyzers,
  });
  it('a mandatory analyzer that timed out is not passed: the approval is refused, named', () => {
    const r = report({
      'diff-review': 'pass',
      'spec-check': 'pass',
      'similar-bugs': TIMEOUT_RESULT,
      motion: 'pass',
    });
    expect(() => checkReviewCaps(caps, r)).toThrow(
      /approval refused: mandatory analyzer timed out: similar-bugs/,
    );
  });
  it('an optional analyzer that timed out is listed as skipped and the approval holds', () => {
    const r = report({
      'diff-review': 'pass',
      'spec-check': 'pass',
      'similar-bugs': 'pass',
      motion: TIMEOUT_RESULT,
    });
    expect(checkReviewCaps(caps, r).skipped).toEqual(['motion']);
  });
  it('names timeouts and other skips apart', () => {
    expect(
      skippedOwedParts(['a', 'b'], { a: 'skipped: timeout after 30 min', b: 'skipped: no time' }),
    ).toEqual(['mandatory analyzer timed out: a', 'mandatory analyzer skipped: b']);
    expect(isTimeoutResult('Skipped: Timeout')).toBe(true);
    expect(isTimeoutResult('skipped: timeouts are hard')).toBe(false);
  });
  it('the lead line is classified as an analyzer timeout for the pane and the push', () => {
    expect(
      classifyDecision('approval refused: mandatory analyzer timed out: similar-bugs; studio stop'),
    ).toBe('analyzer_timeout');
    expect(classifyDecision('review timed out: the crew wrote no report')).toBe('analyzer_timeout');
  });
});

describe('config and brief', () => {
  const base = readFileSync(
    join(import.meta.dirname, 'fixtures', 'basic', '.studio', 'studio.yaml'),
    'utf8',
  );
  it('review.analyzer_timeout_minutes is optional, 5 to 240, default 30', () => {
    expect(parseConfig(base, 'x').review).toBeUndefined();
    expect(parseConfig(`${base}\nreview: {}\n`, 'x').review?.analyzerTimeoutMinutes).toBe(30);
    expect(
      parseConfig(`${base}\nreview: { analyzer_timeout_minutes: 45 }\n`, 'x').review
        ?.analyzerTimeoutMinutes,
    ).toBe(45);
    expect(() => parseConfig(`${base}\nreview: { analyzer_timeout_minutes: 1 }\n`, 'x')).toThrow();
  });
  it('the brief names the limits and the skipped: timeout result', () => {
    const lines = timeoutBrief({ analyzerMinutes: 30, sessionEndsAt: t.sessionEndsAt }).join('\n');
    expect(lines).toContain('30 minutes');
    expect(lines).toContain(t.sessionEndsAt);
    expect(lines).toContain('`skipped: timeout`');
  });
});
