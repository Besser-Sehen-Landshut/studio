import type { StudioConfig } from './config.js';
import type { Ports } from './ports.js';

export interface MainBuild {
  status: 'green' | 'red' | 'pending' | 'unknown';
  sha?: string;
  workflow?: string;
}

const UNKNOWN: MainBuild = { status: 'unknown' };
const RED = new Set(['failure', 'timed_out', 'startup_failure']);
const MAX_NAME = 100;
const READ_TIMEOUT_MS = 30_000;

interface Run {
  workflow: string;
  status: string;
  conclusion: string;
  sha: string;
}

function parseRuns(stdout: string): Run[] | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(raw)) return undefined;
  const runs: Run[] = [];
  for (const r of raw) {
    if (r === null || typeof r !== 'object') return undefined;
    const { status, conclusion, headSha, workflowName } = r as Record<string, unknown>;
    if (typeof status !== 'string' || typeof workflowName !== 'string') return undefined;
    if (conclusion !== null && conclusion !== undefined && typeof conclusion !== 'string') {
      return undefined;
    }
    runs.push({
      workflow: workflowName,
      status,
      conclusion: conclusion ?? '',
      sha: typeof headSha === 'string' ? headSha : '',
    });
  }
  return runs;
}

const cleanName = (s: string): string => s.replace(/\p{Cc}/gu, ' ').slice(0, MAX_NAME);
const validSha = (s: string): string | undefined => (/^[0-9a-f]{7,64}$/i.test(s) ? s : undefined);

/** The newest push run of each workflow on `branch`; undefined when it cannot be read. */
async function latestPushRuns(
  gh: Ports['gh'],
  repo: string,
  branch: string,
): Promise<Run[] | undefined> {
  const reply = await gh.run(
    [
      'run',
      'list',
      '--repo',
      repo,
      '--branch',
      branch,
      '--event',
      'push',
      '--limit',
      '30',
      '--json',
      'status,conclusion,headSha,workflowName',
    ],
    { timeoutMs: READ_TIMEOUT_MS },
  );
  if (reply.code !== 0) return undefined;
  const runs = parseRuns(reply.stdout);
  if (runs === undefined) return undefined;
  // gh lists the newest run first.
  const newest = new Map<string, Run>();
  for (const r of runs) if (!newest.has(r.workflow)) newest.set(r.workflow, r);
  return [...newest.values()];
}

/**
 * Whether a push build on `branch` of `repo` still runs, which a merge now would cancel or race:
 * `idle` (none runs, also when the branch has no push builds at all), `running`, or `unknown`
 * when it cannot be read. Does not throw.
 */
export async function branchBuildRunning(
  gh: Ports['gh'],
  repo: string,
  branch: string,
): Promise<'idle' | 'running' | 'unknown'> {
  try {
    const latest = await latestPushRuns(gh, repo, branch);
    if (latest === undefined) return 'unknown';
    return latest.some((r) => r.status !== 'completed') ? 'running' : 'idle';
  } catch {
    return 'unknown';
  }
}

/**
 * State of the push builds on `main` of the primary repo, from the newest run of each workflow. Any
 * failure to read is `unknown`, never green. Does not throw.
 */
export async function readMainBuild(config: StudioConfig, ports: Ports): Promise<MainBuild> {
  try {
    const latest = await latestPushRuns(ports.gh, config.primaryRepo, 'main');
    if (latest === undefined || latest.length === 0) return UNKNOWN;
    const red = latest.find((r) => r.status === 'completed' && RED.has(r.conclusion));
    if (red) {
      const sha = validSha(red.sha);
      return {
        status: 'red',
        ...(sha === undefined ? {} : { sha }),
        workflow: cleanName(red.workflow),
      };
    }
    if (latest.some((r) => r.status !== 'completed')) return { status: 'pending' };
    const first = latest[0] as Run;
    const sha = validSha(first.sha);
    return {
      status: 'green',
      ...(sha === undefined ? {} : { sha }),
      workflow: cleanName(first.workflow),
    };
  } catch {
    return UNKNOWN;
  }
}
