import { parse as parseYaml } from 'yaml';
import type { ApprovedJob } from './board.js';
import type { Git } from './ports.js';
import type { Check } from './queue.js';
import type { NotRunHereJob } from './report.js';

const GIT_FETCH_MS = 120_000;
const GIT_LOCAL_MS = 60_000;
const WORKFLOWS_DIR = '.github/workflows/';
const WORKFLOW_FILE = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/;
const SHA = /^[0-9a-f]{40,64}$/i;

export type JobGate = { ok: true; jobs: ApprovedJob[] } | { ok: false; entry: number; why: string };

/**
 * The checks of `job` in `workflow`: the job itself, or each instance of a matrix job, which
 * GitHub names `<job> (<leg>)`. Commit statuses have no workflow and never count.
 */
const instances = (checks: readonly Check[], workflow: string, job: string): Check[] =>
  checks.filter(
    (c) =>
      c.workflow !== undefined &&
      c.workflow === workflow &&
      (c.name === job || (c.name.startsWith(`${job} (`) && c.name.endsWith(')'))),
  );

/** At least one instance of the job ran, and every one of them passed. */
const jobPassed = (checks: readonly Check[], workflow: string, job: string): boolean => {
  const mine = instances(checks, workflow, job);
  return mine.length > 0 && mine.every((c) => c.bucket === 'pass');
};

type Workflow = { name: string; jobs: [string, unknown][] };

/** The workflow's name as checks report it (its `name:`, else its path) and its jobs. */
function readWorkflow(text: string, path: string): Workflow | undefined {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return undefined;
  }
  if (doc === null || typeof doc !== 'object') return undefined;
  const wf = doc as { name?: unknown; jobs?: unknown };
  const name = typeof wf.name === 'string' && wf.name.trim() !== '' ? wf.name : path;
  const jobs =
    wf.jobs !== null && typeof wf.jobs === 'object' ? Object.entries(wf.jobs as object) : [];
  return { name, jobs };
}

/**
 * Why `job` of `wf` does not surely run `command`; undefined when it does. The job is found by its
 * `name:`, else its id. A reusable workflow job, or a job with `if:` or `continue-on-error`, is
 * refused; steps with `if:` or `continue-on-error` do not count. The command must start a line of
 * a `run:` script, whole, followed by nothing, a space or `;`, `&` or `|`. This is a heuristic: it
 * shows the job names the command, not what the command does.
 */
function jobProblem(wf: Workflow, job: string, command: string): string | undefined {
  const found = wf.jobs.find(([id, j]) => {
    const name = (j as { name?: unknown } | null)?.name;
    return (typeof name === 'string' ? name : id) === job;
  })?.[1] as Record<string, unknown> | null | undefined;
  if (found === undefined || found === null || typeof found !== 'object') {
    return 'the job is not in the workflow';
  }
  if ('uses' in found) return 'the job calls a reusable workflow, which the gate cannot follow';
  if ('if' in found || 'continue-on-error' in found) {
    return 'the job has an if or continue-on-error';
  }
  const cmd = command.trim();
  const runs = (Array.isArray(found.steps) ? found.steps : [])
    .filter(
      (s): s is Record<string, unknown> =>
        s !== null && typeof s === 'object' && !('if' in s) && !('continue-on-error' in s),
    )
    .map((s) => s.run)
    .filter((r): r is string => typeof r === 'string');
  const starts = (line: string) =>
    line === cmd || (line.startsWith(cmd) && /[\s;&|]/.test(line[cmd.length] as string));
  if (!runs.some((r) => r.split('\n').some((l) => starts(l.trim())))) {
    return 'no run step of the job starts a line with the command';
  }
  return undefined;
}

/**
 * Holds each command the builder could not run to the CI job the reviewer named for it, read in the
 * owner's checkout, never in the crew's clone. `baseOid` is the pull request's base commit as gh
 * reports it (`baseRefOid`, the base the checks ran against). At that commit the file must be a
 * workflow whose name no other workflow file there shares, the job must run the command (see
 * `jobProblem`), and every check of the job in that workflow must have passed on the pull request.
 * When the pull request changes that workflow file, the version at its head, the one that ran,
 * must pass the same test under the same name. Reasons are fixed text: commands and job names are
 * crew text.
 */
export async function verifyNotRunHereJobs(o: {
  git: Git;
  checkout: { dir: string; remote: string };
  baseOid: string | undefined;
  headOid: string;
  commands: readonly string[];
  entries: readonly NotRunHereJob[];
  checks: readonly Check[];
}): Promise<JobGate> {
  const g = (args: string[], timeoutMs: number) =>
    o.git.run(o.checkout.dir, ['--no-replace-objects', ...args], { timeoutMs });
  const read = async (oid: string, path: string): Promise<Workflow | undefined> => {
    try {
      return readWorkflow(await g(['cat-file', 'blob', `${oid}:${path}`], GIT_LOCAL_MS), path);
    } catch {
      return undefined;
    }
  };
  let fetched: boolean | undefined;
  const jobs: ApprovedJob[] = [];
  for (const [i, command] of o.commands.entries()) {
    const fail = (why: string): JobGate => ({ ok: false, entry: i + 1, why });
    const named = o.entries.find((e) => e.command.trim() === command.trim());
    if (named === undefined) return fail('no CI job named for it');
    const base = o.baseOid;
    if (base === undefined || !SHA.test(base) || !SHA.test(o.headOid)) {
      return fail('the base commit is unknown');
    }
    if (!WORKFLOW_FILE.test(named.workflow)) {
      return fail('the workflow is no file in .github/workflows');
    }
    if (fetched === undefined) {
      try {
        await g(
          ['fetch', '--no-tags', '--no-write-fetch-head', o.checkout.remote, base, o.headOid],
          GIT_FETCH_MS,
        );
        fetched = true;
      } catch {
        fetched = false;
      }
    }
    if (!fetched) return fail('the base commit cannot be fetched');
    const wf = await read(base, named.workflow);
    if (wf === undefined) return fail('the workflow is not at the base or not valid YAML');
    // Checks name a workflow by its name only: another file of that name could have run instead.
    let others: string[];
    try {
      others = (await g(['ls-tree', '--name-only', '-z', base, WORKFLOWS_DIR], GIT_LOCAL_MS))
        .split('\0')
        .filter((p) => p !== '' && p !== named.workflow && WORKFLOW_FILE.test(p));
    } catch {
      return fail('the workflows at the base cannot be listed');
    }
    for (const other of others) {
      const w = await read(base, other);
      if (w === undefined || w.name === wf.name) {
        return fail('the workflow name is not unique at the base');
      }
    }
    const atBase = jobProblem(wf, named.job, command);
    if (atBase !== undefined) return fail(`${atBase} at the base`);
    let changed: boolean;
    try {
      changed =
        (
          await g(
            [
              'diff',
              '--name-only',
              '--no-renames',
              '-z',
              `${base}...${o.headOid}`,
              '--',
              named.workflow,
            ],
            GIT_LOCAL_MS,
          )
        ).trim() !== '';
    } catch {
      return fail('the change of the workflow cannot be read');
    }
    if (changed) {
      const head = await read(o.headOid, named.workflow);
      if (head === undefined) return fail('the workflow is gone at the pull request head');
      if (head.name !== wf.name)
        return fail('the workflow has another name at the pull request head');
      const atHead = jobProblem(head, named.job, command);
      if (atHead !== undefined) return fail(`${atHead} at the pull request head`);
    }
    if (!jobPassed(o.checks, wf.name, named.job)) {
      return fail('the job has no passing check on the pull request (missing or skipped)');
    }
    jobs.push({ workflow: wf.name, job: named.job });
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
