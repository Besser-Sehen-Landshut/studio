import { GITHUB_HOSTED_UNLIMITED, type RunnerLoad, type StudioConfig } from './config.js';
import type { Capacity } from './planner.js';
import type { Clock, Gh, Host } from './ports.js';

export type CapacityOptions = {
  /** Upper bound for each CI read; a timeout counts as fully busy. */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;

/** `work`, or a rejection naming `what` after `ms`; the timer never keeps the process alive. */
export function withTimeout<T>(work: Promise<T>, ms: number, what = 'CI read'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

const RUNNER_JQ = '.runners[] | [.name, .status, .busy] | @tsv';
const RUNNER_LINE = /^(\S+)\t(\S+)\t(true|false)$/;

/**
 * Online, busy runners of the organisation whose name matches the pattern (all when unset). A read
 * that finds no runner to count says nothing about capacity, so it throws: repository-level runners
 * are not read here, and an empty list must not look like idle runners.
 */
async function selfHostedBusy(config: StudioConfig, gh: Gh, timeoutMs: number): Promise<number> {
  const org = config.primaryRepo.split('/')[0] as string;
  return orgRunnersBusy(org, config.ci.runnerNamePattern, gh, timeoutMs);
}

async function orgRunnersBusy(
  org: string,
  pattern: string | undefined,
  gh: Gh,
  timeoutMs: number,
): Promise<number> {
  const re = pattern === undefined ? undefined : new RegExp(pattern);
  const out = await gh.api(`/orgs/${org}/actions/runners`, RUNNER_JQ, { timeoutMs });
  let busy = 0;
  let matching = 0;
  for (const line of out.split('\n')) {
    if (line.trim() === '') continue;
    const m = RUNNER_LINE.exec(line);
    if (!m) throw new Error(`unparsable runner line: ${line}`);
    const [, name = '', status, isBusy] = m;
    if (re !== undefined && !re.test(name)) continue;
    matching++;
    if (status === 'online' && isBusy === 'true') busy++;
  }
  if (matching === 0) {
    throw new Error(
      pattern === undefined
        ? `no organisation runner found for ${org}; capacity reads organisation runners only`
        : `no organisation runner of ${org} matches ${pattern}; capacity reads organisation runners only`,
    );
  }
  return busy;
}

async function runCount(
  config: StudioConfig,
  gh: Gh,
  status: string,
  timeoutMs: number,
): Promise<number> {
  const out = await gh.api(
    `/repos/${config.primaryRepo}/actions/runs?status=${status}&per_page=1`,
    '.total_count',
    { paginate: false, timeoutMs },
  );
  // One page of one run is enough: only total_count is read.
  const first = out.split('\n')[0]?.trim() ?? '';
  if (!/^\d+$/.test(first)) throw new Error(`unparsable run count: ${first}`);
  return Number(first);
}

async function githubHostedBusy(config: StudioConfig, gh: Gh, timeoutMs: number): Promise<number> {
  const running = await runCount(config, gh, 'in_progress', timeoutMs);
  const queued = await runCount(config, gh, 'queued', timeoutMs);
  return running + queued;
}

/**
 * Whether the local host's load allows more work: at or below `hostLoadMax`, or with
 * `shared_host` at or below the core count. Without either setting the host never holds.
 */
function hostLoadOk(config: StudioConfig, host: Host, hostLoad: number): boolean {
  const { hostLoadMax } = config.ci.capacity;
  if (hostLoadMax !== undefined) return hostLoad <= hostLoadMax;
  if (config.ci.sharedHost === true) {
    const cores = host.cpuCount();
    return Number.isFinite(cores) && cores > 0 && hostLoad <= cores;
  }
  return true;
}

/**
 * Reads CI busy count and host load. Any error, unparsable output or timeout from GitHub counts
 * as fully busy (`ciBusy = total`, `ok = false`). `ok` is the merge rule (CI and host); `hostOk`
 * is the host part alone, which launches use: a crew loads the host, not CI.
 */
export async function readCapacity(
  config: StudioConfig,
  ports: { gh: Gh; host: Host },
  options: CapacityOptions = {},
): Promise<Capacity> {
  const { total, mergeMaxBusy } = config.ci.capacity;
  const { githubHostedLimit } = config.ci;
  const hostLoad = ports.host.loadAvg1();
  const hostOk = hostLoadOk(config, ports.host, hostLoad);
  const mode = config.ci.runners;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let selfBusy = 0;
  let hostedBusy = 0;
  try {
    const read = async () => {
      if (mode === 'self-hosted' || mode === 'both') {
        selfBusy = await selfHostedBusy(config, ports.gh, timeoutMs);
      }
      if (mode === 'github-hosted' || mode === 'both') {
        hostedBusy = await githubHostedBusy(config, ports.gh, timeoutMs);
      }
    };
    await withTimeout(read(), timeoutMs);
  } catch (err) {
    // Still fully busy (fail closed), but say why so the control room can fix the cause.
    const error = (err instanceof Error ? err.message : String(err))
      .replace(/\p{Cc}/gu, ' ')
      .slice(0, 300);
    return { ciBusy: total, ciTotal: total, hostLoad, ok: false, hostOk, error };
  }
  // `both` keeps the two kinds apart: only self-hosted runners count toward ciBusy.
  const ciBusy = Math.min(total, mode === 'github-hosted' ? hostedBusy : selfBusy);
  let ok = ciBusy <= mergeMaxBusy;
  const out: Capacity = { ciBusy, ciTotal: total, hostLoad, ok, hostOk };
  if (mode === 'both') {
    out.githubHostedBusy = hostedBusy;
    if (githubHostedLimit === undefined) out.warning = GITHUB_HOSTED_UNLIMITED;
    else {
      out.githubHostedLimit = githubHostedLimit;
      ok = ok && hostedBusy <= githubHostedLimit;
    }
  }
  out.ok = ok && hostOk;
  return out;
}

/**
 * Two reads `checkTwiceSeconds` apart, both ok; `capacity` is the read that decided. A busy first
 * read returns without waiting. The merge queue and the pull request `collect` opens share it.
 */
export async function readCapacityTwice(
  config: StudioConfig,
  ports: { gh: Gh; host: Host; clock: Clock },
  options: CapacityOptions = {},
): Promise<{ ok: boolean; capacity: Capacity }> {
  const first = await readCapacity(config, ports, options);
  if (!first.ok) return { ok: false, capacity: first };
  await ports.clock.sleep(config.ci.capacity.checkTwiceSeconds * 1000);
  const second = await readCapacity(config, ports, options);
  return { ok: second.ok, capacity: second };
}

export type RunnerLoadRead = { ok: boolean; busy?: number; error?: string };

/**
 * The `merge.runner_load` gate: `samples` reads `intervalS` apart, each with at most `maxBusy`
 * busy runners. A busy read returns at once; a failed, unparsable or timed-out read, and one that
 * finds no runner matching the pattern, counts as busy (fail closed) and says why.
 */
export async function readRunnerLoad(
  rule: RunnerLoad,
  ports: { gh: Gh; clock: Clock },
  options: CapacityOptions = {},
): Promise<RunnerLoadRead> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let last: RunnerLoadRead = { ok: false };
  for (let i = 0; i < rule.samples; i++) {
    if (i > 0) await ports.clock.sleep(rule.intervalS * 1000);
    try {
      const busy = await withTimeout(
        orgRunnersBusy(rule.org, rule.namePattern, ports.gh, timeoutMs),
        timeoutMs,
      );
      last = { ok: busy <= rule.maxBusy, busy };
    } catch (err) {
      const error = (err instanceof Error ? err.message : String(err))
        .replace(/\p{Cc}/gu, ' ')
        .slice(0, 300);
      return { ok: false, error };
    }
    if (!last.ok) return last;
  }
  return last;
}

/** Two reads `checkTwiceSeconds` apart, both ok. A busy first read returns false without waiting. */
export async function capacityHoldsTwice(
  config: StudioConfig,
  ports: { gh: Gh; host: Host; clock: Clock },
  options: CapacityOptions = {},
): Promise<boolean> {
  return (await readCapacityTwice(config, ports, options)).ok;
}
