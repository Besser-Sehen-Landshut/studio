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
/** As many jobs as the board stores with an approval. */
const MAX_JOBS = 20;

/** A reviewer's `covers` text for one entry, shown to the lead after the gate passed. */
export type CoveredJob = { entry: number; workflow: string; job: string; covers: string };

export type JobGate =
  | { ok: true; jobs: ApprovedJob[]; covered: CoveredJob[] }
  | { ok: false; entry: number; why: string };

/**
 * The checks of `job` in `workflow`: `job` itself, or `job (<leg>)` for a matrix leg, the leg
 * being everything inside the outer parentheses (it may hold ` / ` or parentheses). For a job of a
 * reusable workflow `job` is `<caller> / <called>`. A check of that workflow whose name starts
 * with `job` and a space but does not parse this way (`job (1) / x`, `job / x`, `job (1`) is
 * ambiguous: the gate refuses rather than drop it, so a failing check can never fall out of
 * "every instance passed". Names that go on without a space (`job-slow`) are other jobs. Commit
 * statuses have no workflow and never count.
 */
const instances = (
  checks: readonly Check[],
  workflow: string,
  job: string,
): Check[] | 'ambiguous' => {
  const mine: Check[] = [];
  for (const c of checks) {
    if (c.workflow === undefined || c.workflow !== workflow) continue;
    if (c.name === job) {
      mine.push(c);
      continue;
    }
    if (!c.name.startsWith(`${job} `)) continue;
    const rest = c.name.slice(job.length);
    if (rest.length > 3 && rest.startsWith(' (') && rest.endsWith(')')) mine.push(c);
    else return 'ambiguous';
  }
  return mine;
};

/** Why the job's checks do not show it passed; undefined when at least one ran and all passed. */
const jobProblem = (
  checks: readonly Check[],
  workflow: string,
  job: string,
): 'ambiguous' | 'not passed' | undefined => {
  const mine = instances(checks, workflow, job);
  if (mine === 'ambiguous') return 'ambiguous';
  return mine.length > 0 && mine.every((c) => c.bucket === 'pass') ? undefined : 'not passed';
};

type Job = Record<string, unknown>;
type Workflow = {
  name: string;
  jobs: [string, unknown][];
  onPullRequest: boolean;
  onWorkflowCall: boolean;
};

/** Whether `on:` names `event` (a string, a list or a map). */
function runsOn(on: unknown, event: string): boolean {
  if (on === event) return true;
  if (Array.isArray(on)) return on.includes(event);
  return on !== null && typeof on === 'object' && event in on;
}

/** The workflow's name as checks report it (its `name:`, else its path) and its jobs. */
function readWorkflow(text: string, path: string): Workflow | undefined {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return undefined;
  }
  if (doc === null || typeof doc !== 'object') return undefined;
  const wf = doc as { name?: unknown; jobs?: unknown; on?: unknown };
  const name = typeof wf.name === 'string' && wf.name.trim() !== '' ? wf.name : path;
  const jobs =
    wf.jobs !== null && typeof wf.jobs === 'object' ? Object.entries(wf.jobs as object) : [];
  return {
    name,
    jobs,
    onPullRequest: runsOn(wf.on, 'pull_request'),
    onWorkflowCall: runsOn(wf.on, 'workflow_call'),
  };
}

const isJob = (j: unknown): j is Job => j !== null && typeof j === 'object' && !Array.isArray(j);
/** The name a check reports for a job: its `name:`, else its id. */
const checkName = (id: string, j: Job): string => (typeof j.name === 'string' ? j.name : id);
const guarded = (j: Job): boolean => 'if' in j || 'continue-on-error' in j;
const localCall = (j: Job, path: string): boolean => j.uses === `./${path}`;
/** A `uses:` naming this file of another repository: `<owner>/<repo>/<path>@<ref>`. */
const remoteCall = (j: Job, path: string): boolean =>
  typeof j.uses === 'string' && !j.uses.startsWith('./') && j.uses.includes(`/${path}@`);

/**
 * What the named job is at one commit: the check names it reports (`targets`, by workflow name)
 * and its definition (`def`, the called job and its callers as parsed YAML), or why it does not
 * hold. A workflow on `pull_request` holds the job itself. A workflow that is only
 * `workflow_call` holds it when pull_request workflows call it with `uses: ./<file>` from a job,
 * one level deep; its checks are then `<caller> / <job>` in the caller's workflow. No job on the
 * way may have `if:` or `continue-on-error`; checks name a workflow by its name only, so the name
 * of each workflow whose checks count must be unique.
 */
type Found = { targets: ApprovedJob[]; def: string } | string;

function findJob(
  files: ReadonlyMap<string, Workflow | undefined>,
  path: string,
  job: string,
  where: string,
): Found {
  const w = files.get(path);
  if (w === undefined) return `the workflow is not at ${where} or not valid YAML`;
  const unique = (wf: Workflow, own: string): boolean =>
    [...files].every(([p, x]) => p === own || (x !== undefined && x.name !== wf.name));
  const found = w.jobs.find(([id, j]) => isJob(j) && checkName(id, j) === job);
  if (found === undefined) return `the job is not in the workflow at ${where}`;
  const [, called] = found as [string, Job];
  if (guarded(called)) return `the job has an if or continue-on-error at ${where}`;
  if (w.onPullRequest) {
    if (typeof called.uses === 'string') {
      return called.uses.startsWith('./')
        ? `the job calls a reusable workflow: name the called workflow file and its job (at ${where})`
        : `the job calls a remote reusable workflow, which the gate cannot follow (at ${where})`;
    }
    if (!unique(w, path)) return `the workflow name is not unique at ${where}`;
    return { targets: [{ workflow: w.name, job }], def: JSON.stringify([called]) };
  }
  if (!w.onWorkflowCall) return `the workflow does not run on pull_request at ${where}`;
  if ('uses' in called) {
    return `the called job calls a reusable workflow itself: one level only (at ${where})`;
  }
  const targets: ApprovedJob[] = [];
  const callers: Job[] = [];
  let remote = false;
  let nested = false;
  for (const [p, x] of files) {
    for (const [id, j] of x?.jobs ?? []) {
      if (!isJob(j) || x === undefined) continue;
      if (remoteCall(j, path) && x.onPullRequest) remote = true;
      if (!localCall(j, path)) continue;
      if (!x.onPullRequest) {
        nested = true;
        continue;
      }
      if (guarded(j)) return `a calling job has an if or continue-on-error at ${where}`;
      if (!unique(x, p)) return `the workflow name is not unique at ${where}`;
      targets.push({ workflow: x.name, job: `${checkName(id, j)} / ${job}` });
      callers.push(j);
    }
  }
  if (targets.length === 0) {
    if (remote) {
      return `a pull_request workflow calls it only as a remote reusable workflow, which the gate cannot follow (at ${where})`;
    }
    if (nested) {
      return `the workflow is called only through another reusable workflow: one level only (at ${where})`;
    }
    return `no pull_request workflow calls the workflow at ${where}`;
  }
  return { targets, def: JSON.stringify([called, ...callers]) };
}

/**
 * Holds each command the builder could not run to the CI job the reviewer named for it, read in the
 * owner's checkout, never in the crew's clone. `baseOid` is the pull request's base commit as gh
 * reports it (`baseRefOid`, the base the checks ran against). At that commit and at the pull
 * request head the job must hold (see `findJob`) under the same check names; its definition must
 * be the same at both unless the item is a CI item (`ciItem`), and every check of it must have
 * passed on the pull request. Whether the job covers the command is the reviewer's judgement: each
 * entry needs a `covers` text, which comes back for the lead, the gate does not test it. Reasons
 * are fixed text: commands, job names and covers texts are crew text.
 */
export async function verifyNotRunHereJobs(o: {
  git: Git;
  checkout: { dir: string; remote: string };
  baseOid: string | undefined;
  headOid: string;
  ciItem: boolean;
  commands: readonly string[];
  entries: readonly NotRunHereJob[];
  checks: readonly Check[];
}): Promise<JobGate> {
  const g = (args: string[], timeoutMs: number) =>
    o.git.run(o.checkout.dir, ['--no-replace-objects', ...args], { timeoutMs });
  /** Every workflow file at a commit, parsed; undefined for one that is not valid YAML. */
  const trees = new Map<string, Map<string, Workflow | undefined> | undefined>();
  const workflowsAt = async (oid: string) => {
    if (trees.has(oid)) return trees.get(oid);
    let files: Map<string, Workflow | undefined> | undefined;
    try {
      const paths = (await g(['ls-tree', '--name-only', '-z', oid, WORKFLOWS_DIR], GIT_LOCAL_MS))
        .split('\0')
        .filter((p) => p !== '' && WORKFLOW_FILE.test(p));
      files = new Map();
      for (const p of paths) {
        let text: string | undefined;
        try {
          text = await g(['cat-file', 'blob', `${oid}:${p}`], GIT_LOCAL_MS);
        } catch {
          text = undefined;
        }
        files.set(p, text === undefined ? undefined : readWorkflow(text, p));
      }
    } catch {
      files = undefined;
    }
    trees.set(oid, files);
    return files;
  };
  let fetched: boolean | undefined;
  const jobs: ApprovedJob[] = [];
  const covered: CoveredJob[] = [];
  for (const [i, command] of o.commands.entries()) {
    const fail = (why: string): JobGate => ({ ok: false, entry: i + 1, why });
    const named = o.entries.find((e) => e.command.trim() === command.trim());
    if (named === undefined) return fail('no CI job named for it');
    if (named.covers === undefined || named.covers.trim() === '') {
      return fail('no covers text says why the named job covers the command');
    }
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
    // The same test at the base and at the head: the head's version is the one that ran.
    const at = async (oid: string, where: string): Promise<Found> => {
      const files = await workflowsAt(oid);
      if (files === undefined) return `the workflows at ${where} cannot be listed`;
      return findJob(files, named.workflow, named.job, where);
    };
    const atBase = await at(base, 'the base');
    if (typeof atBase === 'string') return fail(atBase);
    const atHead = await at(o.headOid, 'the pull request head');
    if (typeof atHead === 'string') return fail(atHead);
    const key = (f: { targets: ApprovedJob[] }) => JSON.stringify(f.targets);
    if (key(atHead) !== key(atBase)) {
      return fail('the workflow names or callers differ at the pull request head');
    }
    if (!o.ciItem && atHead.def !== atBase.def) {
      return fail('the job definition changed at the pull request head and the item is no CI item');
    }
    for (const t of atBase.targets) {
      const problem = jobProblem(o.checks, t.workflow, t.job);
      if (problem === 'ambiguous') {
        return fail('a check of the workflow has a name like the job that does not parse as it');
      }
      if (problem !== undefined) {
        return fail('the job has no passing check on the pull request (missing or skipped)');
      }
      if (!jobs.some((j) => j.workflow === t.workflow && j.job === t.job)) jobs.push(t);
      covered.push({ entry: i + 1, ...t, covers: named.covers });
    }
    if (jobs.length > MAX_JOBS) return fail(`more than ${MAX_JOBS} CI jobs in all`);
  }
  return { ok: true, jobs, covered };
}

/** Why the jobs an approval named no longer hold for the merge; undefined while they all passed. */
export function approvedJobsProblem(
  jobs: readonly ApprovedJob[],
  checks: readonly Check[],
): string | undefined {
  for (const [i, j] of jobs.entries()) {
    const problem = jobProblem(checks, j.workflow, j.job);
    if (problem === 'ambiguous') {
      return `approved CI job ${i + 1} has a check whose name does not parse as the job: review it again`;
    }
    if (problem !== undefined) {
      return `approved CI job ${i + 1} has no passing check on the pull request now: review it again`;
    }
  }
  return undefined;
}
