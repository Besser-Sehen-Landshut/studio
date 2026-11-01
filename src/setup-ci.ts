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
