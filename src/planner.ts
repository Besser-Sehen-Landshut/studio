import type { Board, WorkItem } from './board.js';
import type { StudioConfig } from './config.js';

/** CI capacity snapshot (produced by the capacity module). */
export type Capacity = {
  ciBusy: number;
  ciTotal: number;
  hostLoad: number;
  ok: boolean;
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
  /** Candidates that cannot be assigned for a reason other than plain limits. */
  blocked: { id: string; reason: string }[];
  /** Candidates that are fine but wait for WIP, CI capacity or an overlap to clear. Informational. */
  deferred: { id: string; reason: string }[];
};

const BUILD_TYPES: readonly WorkItem['type'][] = ['feature', 'fix', 'chore'];
const ACTIVE: readonly WorkItem['status'][] = ['assigned', 'in_progress', 'in_review', 'queued'];

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

function staticPrefix(glob: string): string {
  const i = glob.search(/[*?[{]/);
  let head = i === -1 ? glob : glob.slice(0, i);
  // A glob starting mid-segment (`src/foo*`) cuts the prefix back to the last '/' (`src`).
  if (i > 0 && glob[i - 1] !== '/') head = head.slice(0, head.lastIndexOf('/') + 1);
  return head.replace(/\/+$/, '');
}

/** Two touches overlap if equal, or one static prefix equals / is a path-segment prefix of the other. Empty prefix overlaps everything. */
function touchesOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const pa = staticPrefix(a);
  const pb = staticPrefix(b);
  if (pa === '' || pb === '') return true;
  return pa === pb || pb.startsWith(`${pa}/`) || pa.startsWith(`${pb}/`);
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
 * unmerged dependencies). Candidates held back only by role WIP, CI capacity or an overlap go to
 * `deferred`, which callers may ignore. When several blocked reasons apply, the first of this order wins:
 * not ready, dependency cycle, unknown dependency, owner only, role not configured, waiting.
 * With `hold` (no crew credential available) nothing is assigned; every candidate is deferred.
 */
export function planAssignments(
  board: Board,
  config: StudioConfig,
  capacity: Capacity,
  running: Record<string, number>,
  hold?: string,
): Plan {
  const byId = new Map(board.items.map((i) => [i.id, i]));
  const tainted = cycleTainted(board.items);
  const blocked: Plan['blocked'] = [];
  const eligible: WorkItem[] = [];

  const candidates = board.items
    .filter((i) => i.status === 'ready')
    .sort((a, b) => a.priority - b.priority || compareIds(a.id, b.id));

  for (const item of candidates) {
    const ready = isReady(item);
    const unknown = item.dependsOn.find((d) => !byId.has(d));
    const waiting = item.dependsOn.filter((d) => byId.get(d)?.status !== 'merged');
    let reason: string | undefined;
    if (!ready.ok) reason = `not ready: missing ${ready.missing.join(', ')}`;
    else if (tainted.has(item.id)) reason = 'dependency cycle';
    else if (unknown !== undefined) reason = `unknown dependency ${unknown}`;
    else if (item.ownerOnly) reason = 'owner only';
    else if (!config.roles[item.role]) reason = 'role not configured';
    else if (waiting.length > 0) reason = `waiting on ${waiting.join(', ')}`;
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
  let buildSlots = capacity.ok ? Math.max(0, config.ci.capacity.mergeMaxBusy - capacity.ciBusy) : 0;

  const active = board.items.filter((i) => ACTIVE.includes(i.status));
  const assign: WorkItem[] = [];
  const deferred: Plan['deferred'] = [];

  for (const item of eligible) {
    const isBuild = BUILD_TYPES.includes(item.type);
    const clash = [...active, ...assign].find((o) => conflicts(item, o));
    if (hold !== undefined) deferred.push({ id: item.id, reason: hold });
    else if (slotsFor(item.role) <= 0) deferred.push({ id: item.id, reason: 'role wip full' });
    else if (isBuild && buildSlots <= 0) deferred.push({ id: item.id, reason: 'ci capacity' });
    else if (clash) deferred.push({ id: item.id, reason: `overlaps ${clash.id}` });
    else {
      assign.push(item);
      roleSlots.set(item.role, slotsFor(item.role) - 1);
      if (isBuild) buildSlots -= 1;
    }
  }

  return { assign, blocked, deferred };
}
