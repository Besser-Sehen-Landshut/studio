import { parse as parseYaml } from 'yaml';
import type { ApprovedJob } from './board.js';
import type { Git } from './ports.js';
import type { Check } from './queue.js';
import type { NotRunHereJob } from './report.js';

const GIT_FETCH_MS = 120_000;
const GIT_LOCAL_MS = 60_000;
const WORKFLOW_FILE = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/;

export type JobGate = { ok: true; jobs: ApprovedJob[] } | { ok: false; entry: number; why: string };

/** Every check of `job` in `workflow` passed, and there is at least one. Statuses have no workflow. */
const jobPassed = (checks: readonly Check[], workflow: string, job: string): boolean => {
  const mine = checks.filter(
    (c) => c.workflow !== undefined && c.workflow === workflow && c.name === job,
  );
  return mine.length > 0 && mine.every((c) => c.bucket === 'pass');
};

/**
 * Holds each command the builder could not run to the CI job the reviewer named for it, read in the
 * owner's checkout at the base commit, never in the pull request: the file must be a workflow
 * there, the job must be in it (by its `name:`, else its id), one of its `run:` steps must hold the
 * command's program and first argument (a plain substring test, a heuristic), and every check of
 * that job in that workflow must have passed on the pull request. Reasons are fixed text: the
 * commands and the job names are crew text.
 */
export async function verifyNotRunHereJobs(o: {
  git: Git;
  checkout: { dir: string; remote: string };
  baseOid: string | undefined;
  commands: readonly string[];
  entries: readonly NotRunHereJob[];
  checks: readonly Check[];
}): Promise<JobGate> {
  const g = (args: string[], timeoutMs: number) =>
    o.git.run(o.checkout.dir, ['--no-replace-objects', ...args], { timeoutMs });
  let fetched: boolean | undefined;
  const jobs: ApprovedJob[] = [];
  for (const [i, command] of o.commands.entries()) {
    const fail = (why: string): JobGate => ({ ok: false, entry: i + 1, why });
    const named = o.entries.find((e) => e.command.trim() === command.trim());
    if (named === undefined) return fail('no CI job named for it');
    if (o.baseOid === undefined || !/^[0-9a-f]{40,64}$/i.test(o.baseOid)) {
      return fail('the base commit is unknown');
    }
    if (!WORKFLOW_FILE.test(named.workflow))
      return fail('the workflow is no file in .github/workflows');
    if (fetched === undefined) {
      try {
        await g(
          ['fetch', '--no-tags', '--no-write-fetch-head', o.checkout.remote, o.baseOid],
          GIT_FETCH_MS,
        );
        fetched = true;
      } catch {
        fetched = false;
      }
    }
    if (!fetched) return fail('the base commit cannot be fetched');
    let doc: unknown;
    try {
      doc = parseYaml(
        await g(['cat-file', 'blob', `${o.baseOid}:${named.workflow}`], GIT_LOCAL_MS),
      );
    } catch {
      return fail('the workflow is not at the base or not valid YAML');
    }
    const wf = (doc ?? {}) as { name?: unknown; jobs?: unknown };
    const workflow =
      typeof wf.name === 'string' && wf.name.trim() !== '' ? wf.name : named.workflow;
    const all =
      wf.jobs !== null && typeof wf.jobs === 'object' ? Object.entries(wf.jobs as object) : [];
    const job = all.find(([id, j]) => {
      const name = (j as { name?: unknown } | null)?.name;
      return (typeof name === 'string' ? name : id) === named.job;
    })?.[1] as { steps?: unknown } | undefined;
    if (job === undefined) return fail('the job is not in the workflow at the base');
    const runs = (Array.isArray(job.steps) ? job.steps : [])
      .map((s) => (s as { run?: unknown } | null)?.run)
      .filter((r): r is string => typeof r === 'string');
    const need = command.trim().split(/\s+/).slice(0, 2);
    if (!runs.some((r) => need.every((t) => r.includes(t)))) {
      return fail('no run step of the job holds the command');
    }
    if (!jobPassed(o.checks, workflow, named.job)) {
      return fail('the job has no passing check on the pull request (missing or skipped)');
    }
    jobs.push({ workflow, job: named.job });
  }
  return { ok: true, jobs };
}

/** Why the jobs an approval named no longer hold for the merge; undefined while they all passed. */
export function approvedJobsProblem(
  jobs: readonly ApprovedJob[],
  checks: readonly Check[],
): string | undefined {
  for (const [i, j] of jobs.entries()) {
    if (!jobPassed(checks, j.workflow, j.job)) {
      return `approved CI job ${i + 1} has no passing check on the pull request now: review it again`;
    }
  }
  return undefined;
}
