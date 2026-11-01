import { parse } from 'yaml';
import type { StudioConfig } from './config.js';
import type { Gh } from './ports.js';

export type DetectedRunner = { name: string; labels: string[]; online: boolean; busy: boolean };

export type Detected = {
  source: 'org' | 'repo' | 'none' | 'unknown';
  runners: DetectedRunner[];
  error?: string;
};

export type CiConfig = StudioConfig['ci'];

export type WorkflowUsage = { githubHosted: boolean; selfHosted: boolean };

const RUNNER_JQ = '.runners[] | [.name, .status, .busy, ([.labels[].name] | join(","))] | @tsv';
const RUNNER_LINE = /^(\S+)\t(online|offline)\t(true|false)\t([^\t]*)$/;
const SAFE_NAME = /^[A-Za-z0-9_.-]+$/;
const DEFAULT_GITHUB_HOSTED_TOTAL = 20;
const DEFAULT_CHECK_TWICE_SECONDS = 30;
const PUBLIC_REPO_ERROR =
  'self-hosted runners on a public repository need fork pull requests blocked';

/** Strict parse; any deviation throws so the caller fails closed. */
function parseRunners(out: string): DetectedRunner[] {
  const runners: DetectedRunner[] = [];
  for (const line of out.split('\n')) {
    if (line.trim() === '') continue;
    const m = RUNNER_LINE.exec(line);
    if (!m) throw new Error('unparsable runner line');
    const [, name = '', status, busy, labels = ''] = m;
    runners.push({
      name,
      labels: labels === '' ? [] : labels.split(','),
      online: status === 'online',
      busy: busy === 'true',
    });
  }
  return runners;
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\p{Cc}/gu, ' ').slice(0, 300);
}

type Read = { ok: true; runners: DetectedRunner[] } | { ok: false; error: string };

async function read(gh: Gh, path: string): Promise<Read> {
  try {
    return { ok: true, runners: parseRunners(await gh.api(path, RUNNER_JQ)) };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

/**
 * Lists the runners visible to the repository: organisation endpoint first, repository endpoint
 * as fallback. Any failed read that does not end in runners from the other endpoint is `unknown`
 * (never `none`), so no numbers are proposed from a partial picture.
 */
export async function detectRunners(
  owner: string,
  repo: string,
  ports: { gh: Gh },
): Promise<Detected> {
  if (
    !SAFE_NAME.test(owner) ||
    !SAFE_NAME.test(repo) ||
    owner === '.' ||
    owner === '..' ||
    repo === '.' ||
    repo === '..'
  ) {
    return { source: 'unknown', runners: [], error: 'invalid repository name' };
  }
  const org = await read(ports.gh, `/orgs/${owner}/actions/runners`);
  if (org.ok && org.runners.length > 0) return { source: 'org', runners: org.runners };
  const rep = await read(ports.gh, `/repos/${owner}/${repo}/actions/runners`);
  if (rep.ok && rep.runners.length > 0) return { source: 'repo', runners: rep.runners };
  if (org.ok && rep.ok) return { source: 'none', runners: [] };
  const errors = [
    ...(org.ok ? [] : [`org: ${org.error}`]),
    ...(rep.ok ? [] : [`repo: ${rep.error}`]),
  ];
  return { source: 'unknown', runners: [], error: errors.join('; ').slice(0, 300) };
}

type Group = { key: string; labels: string[]; runners: DetectedRunner[] };

const labelKey = (labels: string[]): string =>
  [...new Set(labels.map((l) => l.toLowerCase()))].sort().join(',');

function groupSelfHosted(runners: DetectedRunner[]): Group[] {
  const groups = new Map<string, Group>();
  for (const r of runners) {
    if (!r.labels.some((l) => l.toLowerCase() === 'self-hosted')) continue;
    const key = labelKey(r.labels);
    const g = groups.get(key) ?? { key, labels: [], runners: [] };
    if (g.runners.length === 0) g.labels = [...new Set(r.labels)].sort();
    g.runners.push(r);
    groups.set(key, g);
  }
  // Largest first; ties by label key so the choice never depends on API order.
  return [...groups.values()].sort(
    (a, b) => b.runners.length - a.runners.length || (a.key < b.key ? -1 : 1),
  );
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function commonPrefix(names: string[]): string {
  let prefix = names[0] ?? '';
  for (const n of names) {
    let i = 0;
    while (i < prefix.length && i < n.length && prefix[i] === n[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}

/** Anchored, escaped pattern from the common name prefix; undefined when there is none. */
function namePattern(names: string[]): string | undefined {
  const prefix = commonPrefix(names).replace(/[0-9]+$/, '');
  if (prefix === '') return undefined;
  const digitNext = names.every((n) => /^[0-9]/.test(n.slice(prefix.length)));
  return `^${escapeRegex(prefix)}${digitNext ? '[0-9]' : ''}`;
}

const mergeMaxBusyFor = (total: number): number => Math.max(1, Math.round(total * 0.625));

/**
 * Proposes the `ci:` block from detected runners. `usage` says which runner kinds the workflows
 * use; without it a self-hosted group means `self-hosted`. Unknown runners propose nothing.
 */
export function proposeCi(
  detect: Detected,
  repoVisibility: 'public' | 'private',
  current?: CiConfig,
  usage?: WorkflowUsage,
): { ci?: CiConfig; notes: string[]; errors: string[] } {
  const notes: string[] = [];
  const errors: string[] = [];
  if (detect.source === 'unknown') {
    return { notes, errors: [`cannot read runners: ${detect.error ?? 'unknown error'}`] };
  }
  const groups = groupSelfHosted(detect.runners);
  const group = groups[0];
  const mode: CiConfig['runners'] = !group
    ? 'github-hosted'
    : usage?.githubHosted && usage.selfHosted
      ? 'both'
      : 'self-hosted';

  if (detect.source === 'repo') {
    notes.push(
      'runners were read from the repository; capacity reads organisation runners only and will count as busy',
    );
  }
  if (mode !== 'github-hosted' && repoVisibility === 'public') errors.push(PUBLIC_REPO_ERROR);

  let total: number;
  let runnerLabels: string[] = [];
  let runnerNamePattern: string | undefined;
  if (group) {
    total = group.runners.length;
    runnerLabels = group.labels;
    const others = groups.slice(1);
    if (others.length > 0) {
      notes.push(
        `other runner groups ignored: ${others.map((g) => `${g.labels.join(',')} (${g.runners.length})`).join('; ')}`,
      );
    }
    const offline = group.runners.filter((r) => !r.online).length;
    if (offline > 0) notes.push(`${offline} of ${total} runners in the group are offline`);
    runnerNamePattern = namePattern(group.runners.map((r) => r.name));
    if (runnerNamePattern === undefined) {
      notes.push(
        'runners share no name prefix: no name pattern proposed, capacity counts all organisation runners',
      );
    } else {
      const re = new RegExp(runnerNamePattern);
      const inGroup = new Set(group.runners);
      const extra = detect.runners.filter((r) => !inGroup.has(r) && re.test(r.name)).length;
      if (extra > 0)
        notes.push(`the name pattern would also match ${extra} runner(s) outside the group`);
    }
    if (mode === 'both') {
      notes.push(
        'GitHub-hosted concurrency is not limited until `github_hosted_limit` is set; total counts self-hosted runners only',
      );
    }
  } else {
    total = current?.capacity.total ?? DEFAULT_GITHUB_HOSTED_TOTAL;
    notes.push('GitHub-hosted concurrency depends on the plan; check the total against it');
  }

  const ci: CiConfig = {
    ...current,
    provider: current?.provider ?? 'github',
    runners: mode,
    runnerLabels,
    capacity: {
      ...current?.capacity,
      total,
      mergeMaxBusy: mergeMaxBusyFor(total),
      checkTwiceSeconds: current?.capacity.checkTwiceSeconds ?? DEFAULT_CHECK_TWICE_SECONDS,
    },
  };
  if (runnerNamePattern === undefined) delete ci.runnerNamePattern;
  else ci.runnerNamePattern = runnerNamePattern;
  return { ci, notes, errors };
}

// ---------------------------------------------------------------------------------------------
// Workflow lint. Workflow files are untrusted data: they are parsed as plain YAML, never
// evaluated, and every piece of their text that reaches a message is sanitised.

export type WorkflowFile = { path: string; text: string };

const GITHUB_HOSTED = /^(ubuntu|windows|macos)-/i;
const MAX_TEXT = 120;

function clean(text: unknown): string {
  return String(text)
    .replace(/\p{Cc}/gu, ' ')
    .slice(0, MAX_TEXT);
}

type RunsOn =
  | { kind: 'hosted' }
  | { kind: 'set'; labels: string[] }
  | { kind: 'unverifiable'; why: string }
  | { kind: 'invalid'; why: string };

function labelList(value: unknown): string[] | undefined {
  const items = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(items) || items.length === 0) return undefined;
  if (!items.every((l) => typeof l === 'string' && l.trim() !== '')) return undefined;
  return items.map((l: string) => l.trim());
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The one classification shared by the lint and the usage summary. */
function resolveRunsOn(value: unknown): RunsOn {
  const record = isRecord(value) ? value : undefined;
  if (record && !('labels' in record)) {
    return 'group' in record
      ? { kind: 'unverifiable', why: 'runner group without labels' }
      : { kind: 'invalid', why: 'runs-on map has no labels' };
  }
  const labels = labelList(record ? record.labels : value);
  if (!labels) return { kind: 'invalid', why: 'runs-on is not a label or list of labels' };
  if (labels.some((l) => l.includes('${{'))) {
    return { kind: 'unverifiable', why: 'runs-on uses an expression' };
  }
  if (record && 'group' in record) {
    return { kind: 'unverifiable', why: 'runner group membership is not checked' };
  }
  const [only] = labels;
  if (labels.length === 1 && only !== undefined && GITHUB_HOSTED.test(only)) {
    return { kind: 'hosted' };
  }
  return { kind: 'set', labels };
}

type Parsed =
  | { ok: true; doc: Record<string, unknown>; jobs: [string, Record<string, unknown>][] }
  | { ok: false; error: string };

function parseWorkflow(text: string): Parsed {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    return { ok: false, error: `cannot parse: ${clean(err instanceof Error ? err.message : err)}` };
  }
  if (!isRecord(doc)) return { ok: false, error: 'not a YAML mapping' };
  const jobs = doc.jobs;
  if (!isRecord(jobs) || Object.keys(jobs).length === 0) {
    return { ok: false, error: 'has no jobs map' };
  }
  const entries: [string, Record<string, unknown>][] = [];
  for (const [name, job] of Object.entries(jobs)) {
    if (!isRecord(job)) return { ok: false, error: `job "${clean(name)}" is not a mapping` };
    entries.push([name, job]);
  }
  return { ok: true, doc, jobs: entries };
}

function triggers(on: unknown): Set<string> {
  if (typeof on === 'string') return new Set([on]);
  if (Array.isArray(on)) return new Set(on.filter((t): t is string => typeof t === 'string'));
  if (isRecord(on)) return new Set(Object.keys(on));
  return new Set();
}

/** Which runner kinds the workflows use; expressions and unparsable files count toward neither. */
export function workflowRunnerUsage(files: WorkflowFile[]): WorkflowUsage {
  const usage: WorkflowUsage = { githubHosted: false, selfHosted: false };
  for (const f of files) {
    const p = parseWorkflow(f.text);
    if (!p.ok) continue;
    for (const [, job] of p.jobs) {
      if (typeof job.uses === 'string' || !('runs-on' in job)) continue;
      const r = resolveRunsOn(job['runs-on']);
      if (r.kind === 'hosted') usage.githubHosted = true;
      else if (r.kind === 'set') usage.selfHosted = true;
    }
  }
  return usage;
}

function lintConcurrency(doc: Record<string, unknown>, expectedGroup: string): string | undefined {
  const c = doc.concurrency;
  if (!isRecord(c)) {
    return 'push and pull_request without a workflow-level concurrency group (or not in map form)';
  }
  if (typeof c.group !== 'string' || c.group.trim() !== expectedGroup) {
    return `concurrency.group must be exactly ${clean(expectedGroup)}`;
  }
  if (c['cancel-in-progress'] !== true) return 'concurrency.cancel-in-progress must be true';
  return undefined;
}

/**
 * Checks workflows against the detected runners: every self-hosted label set needs an online
 * runner carrying all its labels (otherwise the job waits forever), and workflows triggered by both
 * push and pull_request need the shared concurrency group with cancel-in-progress.
 */
export function lintWorkflows(
  files: WorkflowFile[],
  detect: Detected,
  expectedGroup: string,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const online = detect.runners
    .filter((r) => r.online)
    .map((r) => new Set(r.labels.map((l) => l.toLowerCase())));
  for (const f of files) {
    const path = clean(f.path);
    const p = parseWorkflow(f.text);
    if (!p.ok) {
      errors.push(`${path}: ${p.error}`);
      continue;
    }
    for (const [name, job] of p.jobs) {
      const where = `${path}: job "${clean(name)}"`;
      if (typeof job.uses === 'string') continue;
      if (!('runs-on' in job)) {
        errors.push(`${where} has no runs-on and no uses`);
        continue;
      }
      const r = resolveRunsOn(job['runs-on']);
      if (r.kind === 'invalid') errors.push(`${where}: ${r.why}`);
      else if (r.kind === 'unverifiable') warnings.push(`${where}: cannot verify, ${r.why}`);
      else if (r.kind === 'set') {
        const shown = r.labels.map(clean).join(', ');
        const want = r.labels.map((l) => l.toLowerCase());
        if (detect.source === 'unknown') {
          warnings.push(`${where}: cannot verify runs-on [${shown}], runners are unknown`);
        } else if (!online.some((have) => want.every((l) => have.has(l)))) {
          errors.push(
            `${where}: runs-on [${shown}] matches no online runner; it would wait forever`,
          );
        }
      }
    }
    const t = triggers(p.doc.on);
    if (t.has('push') && t.has('pull_request')) {
      const problem = lintConcurrency(p.doc, expectedGroup);
      if (problem) errors.push(`${path}: ${problem}`);
    }
  }
  return { errors, warnings };
}
