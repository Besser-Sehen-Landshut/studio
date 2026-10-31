import type { StudioConfig } from './config.js';
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

/** Online, busy runners of the organisation whose name matches the pattern (all when unset). */
async function selfHostedBusy(config: StudioConfig, gh: Gh): Promise<number> {
  const org = config.primaryRepo.split('/')[0];
  const pattern = config.ci.runnerNamePattern;
  const re = pattern === undefined ? undefined : new RegExp(pattern);
  const out = await gh.api(`/orgs/${org}/actions/runners`, RUNNER_JQ);
  let busy = 0;
  for (const line of out.split('\n')) {
    if (line.trim() === '') continue;
    const m = RUNNER_LINE.exec(line);
    if (!m) throw new Error(`unparsable runner line: ${line}`);
    const [, name = '', status, isBusy] = m;
    if (status === 'online' && isBusy === 'true' && (re === undefined || re.test(name))) busy++;
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
  const hostLoad = ports.host.loadAvg1();
  const mode = config.ci.runners;
  let ciBusy: number;
  try {
    const read = async () => {
      let n = 0;
      if (mode === 'self-hosted' || mode === 'both') n += await selfHostedBusy(config, ports.gh);
      if (mode === 'github-hosted' || mode === 'both')
        n += await githubHostedBusy(config, ports.gh);
      return n;
    };
    ciBusy = Math.min(total, await withTimeout(read(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  } catch {
    return { ciBusy: total, ciTotal: total, hostLoad, ok: false };
  }
  const ok = ciBusy <= mergeMaxBusy && (hostLoadMax === undefined || hostLoad <= hostLoadMax);
  return { ciBusy, ciTotal: total, hostLoad, ok };
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
