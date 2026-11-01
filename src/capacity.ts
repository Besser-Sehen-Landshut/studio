import { GITHUB_HOSTED_UNLIMITED, type StudioConfig } from './config.js';
import type { Capacity } from './planner.js';
import type { Clock, Gh, Host } from './ports.js';

export type CapacityOptions = {
  /** Upper bound for each CI read; a timeout counts as fully busy. */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`CI read timed out after ${ms} ms`)), ms);
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
async function selfHostedBusy(config: StudioConfig, gh: Gh): Promise<number> {
  const org = config.primaryRepo.split('/')[0];
  const pattern = config.ci.runnerNamePattern;
  const re = pattern === undefined ? undefined : new RegExp(pattern);
  const out = await gh.api(`/orgs/${org}/actions/runners`, RUNNER_JQ);
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

async function runCount(config: StudioConfig, gh: Gh, status: string): Promise<number> {
  const out = await gh.api(
    `/repos/${config.primaryRepo}/actions/runs?status=${status}&per_page=1`,
    '.total_count',
    { paginate: false },
  );
  // One page of one run is enough: only total_count is read.
  const first = out.split('\n')[0]?.trim() ?? '';
  if (!/^\d+$/.test(first)) throw new Error(`unparsable run count: ${first}`);
  return Number(first);
}

async function githubHostedBusy(config: StudioConfig, gh: Gh): Promise<number> {
  const running = await runCount(config, gh, 'in_progress');
  const queued = await runCount(config, gh, 'queued');
  return running + queued;
}

/**
 * Reads CI busy count and host load. Any error, unparsable output or timeout from GitHub counts
 * as fully busy (`ciBusy = total`, `ok = false`).
 */
export async function readCapacity(
  config: StudioConfig,
  ports: { gh: Gh; host: Host },
  options: CapacityOptions = {},
): Promise<Capacity> {
  const { total, mergeMaxBusy, hostLoadMax } = config.ci.capacity;
  const { sharedHost, githubHostedLimit } = config.ci;
  const hostLoad = ports.host.loadAvg1();
  const mode = config.ci.runners;
  let selfBusy = 0;
  let hostedBusy = 0;
  try {
    const read = async () => {
      if (mode === 'self-hosted' || mode === 'both') {
        selfBusy = await selfHostedBusy(config, ports.gh);
      }
      if (mode === 'github-hosted' || mode === 'both') {
        hostedBusy = await githubHostedBusy(config, ports.gh);
      }
    };
    await withTimeout(read(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  } catch (err) {
    // Still fully busy (fail closed), but say why so the control room can fix the cause.
    const error = (err instanceof Error ? err.message : String(err))
      .replace(/\p{Cc}/gu, ' ')
      .slice(0, 300);
    return { ciBusy: total, ciTotal: total, hostLoad, ok: false, error };
  }
  // `both` keeps the two kinds apart: only self-hosted runners count toward ciBusy.
  const ciBusy = Math.min(total, mode === 'github-hosted' ? hostedBusy : selfBusy);
  let ok = ciBusy <= mergeMaxBusy;
  const out: Capacity = { ciBusy, ciTotal: total, hostLoad, ok };
  if (mode === 'both') {
    out.githubHostedBusy = hostedBusy;
    if (githubHostedLimit === undefined) out.warning = GITHUB_HOSTED_UNLIMITED;
    else {
      out.githubHostedLimit = githubHostedLimit;
      ok = ok && hostedBusy <= githubHostedLimit;
    }
  }
  if (hostLoadMax !== undefined) {
    ok = ok && hostLoad <= hostLoadMax;
  } else if (sharedHost === true) {
    const cores = ports.host.cpuCount();
    ok = ok && Number.isFinite(cores) && cores > 0 && hostLoad <= cores;
  }
  out.ok = ok;
  return out;
}

/** Two reads `checkTwiceSeconds` apart, both ok. A busy first read returns false without waiting. */
export async function capacityHoldsTwice(
  config: StudioConfig,
  ports: { gh: Gh; host: Host; clock: Clock },
  options: CapacityOptions = {},
): Promise<boolean> {
  if (!(await readCapacity(config, ports, options)).ok) return false;
  await ports.clock.sleep(config.ci.capacity.checkTwiceSeconds * 1000);
  return (await readCapacity(config, ports, options)).ok;
}
