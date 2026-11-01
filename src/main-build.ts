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

/**
 * State of the push builds on `main` of the primary repo, from the newest run of each workflow. Any
 * failure to read is `unknown`, never green. Does not throw.
 */
export async function readMainBuild(config: StudioConfig, ports: Ports): Promise<MainBuild> {
  try {
    const reply = await ports.gh.run(
      [
        'run',
        'list',
        '--repo',
        config.primaryRepo,
        '--branch',
        'main',
        '--event',
        'push',
        '--limit',
        '30',
        '--json',
        'status,conclusion,headSha,workflowName',
      ],
      { timeoutMs: READ_TIMEOUT_MS },
    );
    if (reply.code !== 0) return UNKNOWN;
    const runs = parseRuns(reply.stdout);
    if (runs === undefined) return UNKNOWN;
    // gh lists the newest run first.
    const newest = new Map<string, Run>();
    for (const r of runs) if (!newest.has(r.workflow)) newest.set(r.workflow, r);
    const latest = [...newest.values()];
    if (latest.length === 0) return UNKNOWN;
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
