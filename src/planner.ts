import { type Board, componentsOf, GROUP_REF_RE, type WorkItem } from './board.js';
import type { StudioConfig } from './config.js';
import { touchesOverlap } from './glob.js';
import type { ExternalDep } from './group.js';
import { isLessonsReview, LEAD_WORK } from './lessons-review.js';
import { workerItemProblem } from './worker-claim.js';

/** CI capacity snapshot (produced by the capacity module). */
export type Capacity = {
  ciBusy: number;
  ciTotal: number;
  hostLoad: number;
  /** The merge rule: CI busy count, GitHub-hosted limit and host load all within limits. */
  ok: boolean;
  /** Host load alone within limits (`host_load_max`, or the cores with `shared_host`). */
  hostOk: boolean;
  /** Why CI could not be read (then everything counts as busy). */
  error?: string;
  /** `runners: both` only: GitHub-hosted runs in progress or queued, and the configured limit. */
  githubHostedBusy?: number;
  githubHostedLimit?: number;
  /** A limit that is not enforced, e.g. GitHub-hosted concurrency in `both` without a limit. */
  warning?: string;
};

export type Plan = {
  assign: WorkItem[];
  /**
   * Items with `runs_on` to offer to workers of their label (src/worker-lead.ts). They use no local
   * crew: no role WIP, no credential slot, no host load; overlaps, dependencies, component WIP,
   * holds and the daily cost cap apply as for any item.
   */
  offer: WorkItem[];
  /** Candidates that cannot be assigned for a reason other than plain limits. */
  blocked: { id: string; reason: string }[];
  /** Candidates that are fine but wait for WIP, host load or an overlap to clear. Informational. */
  deferred: { id: string; reason: string }[];
};

const BUILD_TYPES: readonly WorkItem['type'][] = ['feature', 'fix', 'chore'];
/** Deferral of every build after the first in one plan; a launch of that one item may still start it. */
export const ONE_BUILD_PER_PLAN = 'host load: one build start per plan';
const ACTIVE: readonly WorkItem['status'][] = ['assigned', 'in_progress', 'in_review', 'queued'];
/** What counts against a component's `wip`, as against a role's. */
const COMPONENT_ACTIVE: readonly WorkItem['status'][] = ['assigned', 'in_progress'];

/** Definition of Ready: title, dod, size, role and repo; features also need a plan. */
export function isReady(item: WorkItem): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!item.title?.trim()) missing.push('title');
  if (!item.dod?.some((d) => d.trim())) missing.push('dod');
  if (!item.size) missing.push('size');
  if (!item.role) missing.push('role');
  if (!item.repo?.trim()) missing.push('repo');
  if (item.type === 'feature' && !item.plan?.trim()) missing.push('plan');
  return { ok: missing.length === 0, missing };
}

/** Natural id order: APP-2 before APP-10. */
function compareIds(a: string, b: string): number {
  const pa = /^(.*?)(\d+)$/.exec(a);
  const pb = /^(.*?)(\d+)$/.exec(b);
  if (pa && pb && pa[1] === pb[1]) return Number(pa[2]) - Number(pb[2]);
  return a < b ? -1 : a > b ? 1 : 0;
}

function conflicts(a: WorkItem, b: WorkItem): boolean {
  if (a.conflictsWith?.includes(b.id) || b.conflictsWith?.includes(a.id)) return true;
  return a.touches.some((ta) => b.touches.some((tb) => touchesOverlap(ta, tb)));
}

/** Ids that lie on a dependency cycle (including self-dependency), plus ids that reach one. Iterative, terminates on any graph. */
function cycleTainted(items: WorkItem[]): Set<string> {
  const deps = new Map(items.map((i) => [i.id, i.dependsOn]));
  const reach = (start: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [...(deps.get(start) ?? [])];
    while (stack.length > 0) {
      const n = stack.pop() as string;
      if (seen.has(n)) continue;
      seen.add(n);
      for (const d of deps.get(n) ?? []) if (!seen.has(d)) stack.push(d);
    }
    return seen;
  };
  const reachable = new Map(items.map((i) => [i.id, reach(i.id)]));
  const onCycle = new Set(items.filter((i) => reachable.get(i.id)?.has(i.id)).map((i) => i.id));
  const tainted = new Set<string>();
  for (const i of items) {
    if (onCycle.has(i.id) || [...(reachable.get(i.id) ?? [])].some((n) => onCycle.has(n))) {
      tainted.add(i.id);
    }
  }
  return tainted;
}

/**
 * Pick the ready items to assign now. Pure.
 *
 * Priority: LOWER number = higher priority (P1 before P2); ties by natural id order.
 * Only `ready` items are candidates. `blocked` lists candidates that cannot run for a non-limit
 * reason (not ready, cycle, unknown dependency, role not configured, owner only, waiting on
 * unmerged dependencies). Candidates held back only by role WIP, component WIP, host load or an
 * overlap go to `deferred`, which callers may ignore. An item counts against the `wip` of every
 * component it belongs to (`componentsOf`). CI runner capacity does not hold a launch: a crew builds
 * and tests in its own clone, and Studio gates CI load where it starts it, when `collect` opens
 * the pull request and in the merge queue. A plan starts at most one build item (fix, feature,
 * chore): the host load is a single, lagging reading. When several blocked reasons apply, the first of this order wins:
 * not ready, dependency cycle, unknown dependency, owner only, role not configured, waiting.
 * With `hold` (no crew credential available) nothing is assigned; every candidate is deferred.
 * `credentialSlots` is how many more crews the credentials allow (per-label limits); at 0 every
 * candidate is deferred with the reason `credential limit`, and each assignment uses one slot.
 */
/** Why a review waits: a reviewer launched on running CI would ask for changes CI may not need. */
export const CI_PENDING = 'ci pending';

export function planAssignments(
  board: Board,
  config: StudioConfig,
  capacity: Capacity,
  running: Record<string, number>,
  hold?: string,
  credentialSlots?: number,
  /** Review items whose pull request head still has checks running: they wait (`ci pending`). */
  ciPending?: ReadonlySet<string>,
  /**
   * What holds offers to workers, which use no local credential: a pause, an account block, the
   * daily cost cap. Defaults to `hold`.
   */
  offerHold: string | undefined = hold,
  /**
   * Cross-project dependencies (`<project>:<id>`) as `resolveExternalDeps` read them, keyed by
   * `<item> <ref>`. One that is missing here counts as unreadable: the item waits (fail closed).
   */
  external?: ReadonlyMap<string, ExternalDep>,
): Plan {
  const byId = new Map(board.items.map((i) => [i.id, i]));
  const tainted = cycleTainted(board.items);
  const blocked: Plan['blocked'] = [];
  const eligible: WorkItem[] = [];
  // A lessons review is the lead's own work (`lessons accept` refuses a crew): it never launches.
  const leadWork: Plan['deferred'] = [];

  const candidates = board.items
    .filter((i) => i.status === 'ready')
    .sort((a, b) => a.priority - b.priority || compareIds(a.id, b.id));

  for (const item of candidates) {
    if (isLessonsReview(item)) {
      leadWork.push({ id: item.id, reason: LEAD_WORK });
      continue;
    }
    const ready = isReady(item);
    const local = item.dependsOn.filter((d) => !GROUP_REF_RE.test(d));
    const remote = item.dependsOn
      .filter((d) => GROUP_REF_RE.test(d))
      .map((ref) => ({
        ref,
        dep: external?.get(`${item.id} ${ref}`) ?? {
          state: 'unreadable' as const,
          why: 'not checked',
        },
      }));
    const unknown =
      local.find((d) => !byId.has(d)) ?? remote.find((r) => r.dep.state === 'unknown')?.ref;
    const unreadable = remote.find((r) => r.dep.state === 'unreadable');
    const waiting = [
      ...local.filter((d) => byId.get(d)?.status !== 'merged'),
      ...remote.filter((r) => r.dep.state === 'waiting').map((r) => r.ref),
    ];
    let reason: string | undefined;
    if (!ready.ok) reason = `not ready: missing ${ready.missing.join(', ')}`;
    else if (tainted.has(item.id) || remote.some((r) => r.dep.state === 'cycle')) {
      reason = 'dependency cycle';
    } else if (unknown !== undefined) reason = `unknown dependency ${unknown}`;
    else if (unreadable !== undefined) {
      reason = `dependency ${unreadable.ref} unreadable: ${(unreadable.dep as { why: string }).why}`;
    } else if (item.ownerOnly) reason = 'owner only';
    else if (!config.roles[item.role]) reason = 'role not configured';
    else if (item.runsOn !== undefined && workerItemProblem(item) !== undefined) {
      reason = workerItemProblem(item);
    } else if (waiting.length > 0) reason = `waiting on ${waiting.join(', ')}`;
    if (reason) blocked.push({ id: item.id, reason });
    else eligible.push(item);
  }

  const roleSlots = new Map<string, number>();
  const slotsFor = (role: string): number => {
    if (!roleSlots.has(role)) {
      const wip = config.roles[role as keyof StudioConfig['roles']]?.wip ?? 0;
      roleSlots.set(role, Math.max(0, wip - (running[role] ?? 0)));
    }
    return roleSlots.get(role) as number;
  };

  // Room per component with a wip: its limit less its items in assigned or in_progress.
  const componentSlots = new Map<string, number>();
  for (const c of config.components ?? []) {
    if (c.wip !== undefined) componentSlots.set(c.id, c.wip);
  }
  const componentsByItem = new Map<string, string[]>();
  const componentsFor = (item: WorkItem): string[] => {
    if (!componentsByItem.has(item.id)) componentsByItem.set(item.id, componentsOf(item, config));
    return componentsByItem.get(item.id) as string[];
  };
  const useComponents = (item: WorkItem) => {
    if (componentSlots.size === 0) return;
    for (const c of componentsFor(item)) {
      const left = componentSlots.get(c);
      if (left !== undefined) componentSlots.set(c, left - 1);
    }
  };
  for (const i of board.items) if (COMPONENT_ACTIVE.includes(i.status)) useComponents(i);
  const fullComponent = (item: WorkItem): string | undefined =>
    componentSlots.size === 0
      ? undefined
      : componentsFor(item).find((c) => (componentSlots.get(c) ?? 1) <= 0);

  const active = board.items.filter((i) => ACTIVE.includes(i.status));
  const assign: WorkItem[] = [];
  const offer: WorkItem[] = [];
  const deferred: Plan['deferred'] = [];
  // The host load is read once per plan and lags behind new work, so one reading backs one build
  // start; the next plan, with a fresh reading, may start the next. A build held back only by this
  // still takes its WIP, credential and overlap room here, so the items after it get the reason
  // they would get once it runs.
  let buildStarted = false;
  const planned: WorkItem[] = [];
  const take = (item: WorkItem) => {
    planned.push(item);
    roleSlots.set(item.role, slotsFor(item.role) - 1);
    useComponents(item);
    if (credentialSlots !== undefined) credentialSlots -= 1;
  };

  for (const item of eligible) {
    const isBuild = BUILD_TYPES.includes(item.type);
    const clash = [...active, ...planned].find((o) => conflicts(item, o));
    const full = fullComponent(item);
    if (item.runsOn !== undefined) {
      if (offerHold !== undefined) deferred.push({ id: item.id, reason: offerHold });
      else if (full !== undefined) {
        deferred.push({ id: item.id, reason: `component ${full} wip full` });
      } else if (clash) deferred.push({ id: item.id, reason: `overlaps ${clash.id}` });
      else {
        offer.push(item);
        planned.push(item);
        useComponents(item);
      }
      continue;
    }
    if (hold !== undefined) deferred.push({ id: item.id, reason: hold });
    else if (ciPending?.has(item.id)) deferred.push({ id: item.id, reason: CI_PENDING });
    else if (credentialSlots !== undefined && credentialSlots <= 0) {
      deferred.push({ id: item.id, reason: 'credential limit' });
    } else if (slotsFor(item.role) <= 0) deferred.push({ id: item.id, reason: 'role wip full' });
    else if (full !== undefined) {
      deferred.push({ id: item.id, reason: `component ${full} wip full` });
    } else if (isBuild && !capacity.hostOk) deferred.push({ id: item.id, reason: 'host load' });
    else if (clash) deferred.push({ id: item.id, reason: `overlaps ${clash.id}` });
    else if (isBuild && buildStarted) {
      deferred.push({ id: item.id, reason: ONE_BUILD_PER_PLAN });
      take(item);
    } else {
      assign.push(item);
      take(item);
      if (isBuild) buildStarted = true;
    }
  }

  return { assign, offer, blocked, deferred: [...deferred, ...leadWork] };
}
