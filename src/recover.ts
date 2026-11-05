import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadBoard, saveBoard, transition, type WorkItem } from './board.js';
import { COSTS_LOCK, COSTS_LOCK_STALE_MS } from './costs.js';
import { crewHold, isItemId } from './crew.js';
import { EXCEPTIONS_LOCK, EXCEPTIONS_LOCK_STALE_MS } from './evidence.js';
import { RERUNS_LOCK, RERUNS_LOCK_STALE_MS } from './flaky-ci.js';
import { LOCK_STALE_MS as LIMITS_LOCK_STALE_MS } from './limits.js';
import { NOTIFY_LOCK, LOCK_STALE_MS as NOTIFY_LOCK_STALE_MS } from './notify.js';
import { MIGRATE_LOCK, LOCK_STALE_MS as MIGRATE_LOCK_STALE_MS } from './owner-state.js';
import { PR_HELD } from './pane-data.js';
import {
  acquireStateLock,
  BOARD_LOCK,
  BOARD_LOCK_STALE_MS,
  inspectStateLock,
  pidAlive,
  removeStateEntry,
  withBoardLock,
} from './paths.js';
import type { Ports } from './ports.js';
import { PUSH_LOCK, LOCK_STALE_MS as PUSH_LOCK_STALE_MS } from './push.js';
import {
  FILE_LOCK,
  FILE_LOCK_STALE_MS,
  loadQueue,
  RUN_LOCK,
  RUN_LOCK_HEARTBEAT_STALE_MS,
} from './queue.js';
import { RELEASES_LOCK, RELEASES_LOCK_STALE_MS } from './release.js';
import { reportName } from './report.js';
import { LESSONS_LOCK, LESSONS_LOCK_STALE_MS } from './role-memory.js';
import { readCrewRecords } from './state.js';
import { LAUNCH_LOCK, LAUNCH_LOCK_STALE_MS } from './usage.js';

/** One tick at a time; a tick whose holder died is taken over after this long. */
export const TICK_LOCK = 'tick.lock';
export const TICK_LOCK_STALE_MS = 15 * 60_000;

/** Every lock Studio takes, where it lives and when its holder counts as gone. */
const LOCKS: readonly { where: 'project' | 'owner'; name: string; staleMs: number }[] = [
  { where: 'project', name: TICK_LOCK, staleMs: TICK_LOCK_STALE_MS },
  { where: 'project', name: RUN_LOCK, staleMs: RUN_LOCK_HEARTBEAT_STALE_MS },
  { where: 'project', name: FILE_LOCK, staleMs: FILE_LOCK_STALE_MS },
  { where: 'project', name: BOARD_LOCK, staleMs: BOARD_LOCK_STALE_MS },
  { where: 'project', name: RERUNS_LOCK, staleMs: RERUNS_LOCK_STALE_MS },
  { where: 'project', name: LESSONS_LOCK, staleMs: LESSONS_LOCK_STALE_MS },
  { where: 'project', name: COSTS_LOCK, staleMs: COSTS_LOCK_STALE_MS },
  { where: 'project', name: EXCEPTIONS_LOCK, staleMs: EXCEPTIONS_LOCK_STALE_MS },
  { where: 'project', name: RELEASES_LOCK, staleMs: RELEASES_LOCK_STALE_MS },
  { where: 'owner', name: LAUNCH_LOCK, staleMs: LAUNCH_LOCK_STALE_MS },
  { where: 'owner', name: 'limits.lock', staleMs: LIMITS_LOCK_STALE_MS },
  { where: 'owner', name: 'blocks.lock', staleMs: LIMITS_LOCK_STALE_MS },
  { where: 'owner', name: PUSH_LOCK, staleMs: PUSH_LOCK_STALE_MS },
  { where: 'owner', name: NOTIFY_LOCK, staleMs: NOTIFY_LOCK_STALE_MS },
  { where: 'owner', name: MIGRATE_LOCK, staleMs: MIGRATE_LOCK_STALE_MS },
];

/** What a recovery check found, and what it did about it (nothing in a dry run). */
export interface Finding {
  check: 'lock' | 'leftover' | 'launch' | 'crew' | 'queue';
  /** The item, the lock or the file the finding is about. */
  subject: string;
  found: string;
  did?: string;
}

export interface Recovery {
  dryRun: boolean;
  findings: Finding[];
  /** What only the lead (or the owner) can decide. */
  needsLead: { item: string; reason: string }[];
}

export interface RecoverOptions {
  project: string;
  stateRoot: string;
  ownerRoot: string;
  ports: Ports;
  now: Date;
  /** Look only: no lock is broken, no file removed, no item moved. */
  dryRun: boolean;
  /**
   * `tick` runs only what must happen before it plans: interrupted launches, items without a crew,
   * stray queue entries. `studio recover` adds locks, leftovers and every crew.
   */
  scope: 'tick' | 'all';
}

/** Leftovers of a write or a lock break that a crash cut short, at the top of a state root. */
const ASIDE = /^.+\.lock\.[0-9a-f]{8}\.stale$/;
const TMP = /^.+\.(\d+)\.\d+\.[0-9a-f]{8}\.tmp$/;
/** A record without a start time this young may belong to a launch that is still writing it. */
const LAUNCH_GRACE_MS = 2 * 60_000;
/** An aside younger than this may belong to a breaker that is between its rename and its check. */
const ASIDE_GRACE_MS = 60_000;

/** When the item last became `ready`; minus infinity when its history does not say. */
function readySince(item: WorkItem): number {
  const at = item.history.findLast((h) => h.to === 'ready')?.at;
  const t = at === undefined ? Number.NaN : Date.parse(at);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/** A log written within this long may belong to a crew that still runs. */
const LOG_QUIET_MS = 30 * 60_000;

/** How long ago the item's crew log was last written; undefined without one. */
function logWrittenAgo(stateRoot: string, item: string, now: Date): number | undefined {
  if (!isItemId(item)) return undefined;
  try {
    const st = lstatSync(join(stateRoot, 'logs', `${item}.jsonl`));
    return st.isFile() ? Math.max(0, now.getTime() - st.mtimeMs) : undefined;
  } catch {
    return undefined;
  }
}

function hasReport(stateRoot: string, item: string): boolean {
  if (!isItemId(item)) return false;
  const name = reportName(stateRoot, item);
  return (
    name !== undefined && existsSync(join(stateRoot, 'clones', item, '.studio', 'reports', name))
  );
}

/**
 * The checks after a crash or a reboot, safe to run any time and idempotent: a second run finds
 * nothing left to do. Nothing here starts a crew or merges: an interrupted launch whose crew record
 * is on disk is completed on the board, never started again; an ended crew is left to `collect`;
 * an interrupted merge is left to the queue, which sees a merged pull request as merged.
 */
export async function recoverProject(o: RecoverOptions): Promise<Recovery> {
  const out: Recovery = { dryRun: o.dryRun, findings: [], needsLead: [] };
  const lead = (item: string, reason: string) => {
    if (!out.needsLead.some((n) => n.item === item && n.reason === reason)) {
      out.needsLead.push({ item, reason });
    }
  };

  if (o.scope === 'all') {
    for (const l of LOCKS) {
      const root = l.where === 'project' ? o.stateRoot : o.ownerRoot;
      if (!existsSync(root)) continue;
      const opts = { now: o.now, heartbeatStaleMs: l.staleMs };
      const seen = inspectStateLock(root, l.name, opts);
      if (seen.state === 'free') continue;
      if (seen.state === 'held') {
        const by = seen.pid === undefined ? '' : ` by pid ${seen.pid}`;
        // A live holder is never broken; a long silence is only reported.
        const silent =
          seen.silentMs >= l.staleMs ? `, silent ${Math.round(seen.silentMs / 60_000)} min` : '';
        out.findings.push({
          check: 'lock',
          subject: l.name,
          found: `held${by}${silent}, holder alive`,
        });
        continue;
      }
      const finding: Finding = { check: 'lock', subject: l.name, found: `stale: ${seen.reason}` };
      if (!o.dryRun) {
        // Taken with the same rules every holder uses, then let go at once.
        const lock = acquireStateLock(root, l.name, opts);
        if (lock !== undefined) {
          lock.release();
          finding.did = 'broke it';
        }
      }
      out.findings.push(finding);
    }
    for (const root of [o.stateRoot, o.ownerRoot]) {
      let names: string[];
      try {
        names = readdirSync(root);
      } catch {
        continue;
      }
      for (const name of names) {
        const file = join(root, name);
        const tmp = TMP.exec(name);
        let gone = false;
        if (ASIDE.test(name)) {
          try {
            const st = lstatSync(file);
            gone = st.isFile() && o.now.getTime() - st.ctimeMs >= ASIDE_GRACE_MS;
          } catch {
            gone = false;
          }
        } else if (tmp !== null) {
          gone = !pidAlive(Number(tmp[1]));
        }
        if (!gone) continue;
        const finding: Finding = {
          check: 'leftover',
          subject: name,
          found: 'left behind by an interrupted write',
        };
        if (!o.dryRun) {
          removeStateEntry(root, file);
          finding.did = 'removed it';
        }
        out.findings.push(finding);
      }
    }
  }

  if (!existsSync(o.stateRoot)) return out;
  const records = readCrewRecords(o.stateRoot);
  const board = loadBoard(o.project);

  // A launch the lead's process did not finish: the crew record is on disk (its pid was written
  // right after the start) but the item is still `ready`. Starting it again would put a second crew
  // into the same clone, so the item moves to `assigned` with that crew, as the launch would have.
  // A launch still under way is not cut short: while any launch holds the launch lock, and while
  // a record has no start time yet and is young, the launching process does the move itself.
  const launching =
    existsSync(o.ownerRoot) &&
    inspectStateLock(o.ownerRoot, LAUNCH_LOCK, {
      now: o.now,
      heartbeatStaleMs: LAUNCH_LOCK_STALE_MS,
    }).state === 'held';
  const interrupted = launching
    ? []
    : board.items.filter((i) => {
        const rec = records[i.id];
        if (i.status !== 'ready' || rec === undefined || rec.stoppedAt !== undefined) return false;
        const started = Date.parse(rec.startedAt);
        if (Number.isNaN(started) || started < readySince(i)) return false;
        return rec.identity !== undefined || o.now.getTime() - started >= LAUNCH_GRACE_MS;
      });
  if (launching) {
    for (const i of board.items) {
      const rec = records[i.id];
      if (i.status === 'ready' && rec !== undefined && rec.stoppedAt === undefined) {
        out.findings.push({
          check: 'launch',
          subject: i.id,
          found: 'a launch holds the launch lock: left to it',
        });
      }
    }
  }
  for (const item of interrupted) {
    const rec = records[item.id];
    if (rec === undefined) continue;
    const finding: Finding = {
      check: 'launch',
      subject: item.id,
      found: `ready, but crew ${rec.name} (pid ${rec.pid}) was started for it at ${rec.startedAt}`,
    };
    if (!o.dryRun) {
      const moved = await withBoardLock(o.stateRoot, o.now, () => {
        const fresh = loadBoard(o.project);
        if (fresh.items.find((i) => i.id === item.id)?.status !== 'ready') return false;
        const next = transition(fresh, item.id, 'assigned', 'studio', o.now);
        saveBoard(o.project, {
          ...next,
          items: next.items.map((i) => (i.id === item.id ? { ...i, crew: rec.name } : i)),
        });
        return true;
      });
      if (moved) finding.did = 'moved it to assigned with that crew; collect takes it from there';
    }
    out.findings.push(finding);
  }

  const done = new Set(interrupted.map((i) => i.id));
  for (const item of board.items) {
    if (done.has(item.id)) continue;
    // An item on a worker has no crew record here by design: tick follows its claim.
    if (item.runsOn !== undefined) continue;
    if (item.status !== 'assigned' && item.status !== 'in_progress') continue;
    const rec = records[item.id];
    if (rec === undefined) {
      // A pull request held for CI capacity has no crew left by design.
      if ((item.notes ?? []).some((n) => n.startsWith(PR_HELD))) continue;
      // A log written lately may be a crew that runs without its record: look before dropping.
      const written = logWrittenAgo(o.stateRoot, item.id, o.now);
      const recent = written !== undefined && written < LOG_QUIET_MS;
      const reason = recent
        ? `${item.id} is ${item.status} but has no crew record, and its log was written ${Math.round(written / 60_000)} min ago: a crew may still run for it; check by hand (logs/${item.id}.jsonl, its clone) before dropping it`
        : `${item.id} is ${item.status} but has no crew record: nothing runs for it; drop it, or add it again`;
      out.findings.push({
        check: 'crew',
        subject: item.id,
        found: recent ? 'no crew record, log written lately' : 'no crew record',
      });
      lead(item.id, reason);
      continue;
    }
    if (o.scope !== 'all') continue;
    const hold = await crewHold(rec, o.ports);
    if (hold === 'running') {
      out.findings.push({ check: 'crew', subject: item.id, found: `crew ${rec.name} runs` });
    } else if (hold === 'unverified') {
      out.findings.push({ check: 'crew', subject: item.id, found: 'crew cannot be verified' });
      lead(
        item.id,
        `crew ${rec.name} may still run (pid ${rec.pid}) but cannot be verified; check it by hand, then studio stop ${item.id} --release`,
      );
    } else if (hasReport(o.stateRoot, item.id)) {
      out.findings.push({
        check: 'crew',
        subject: item.id,
        found: `crew ${rec.name} ended with a report: the next tick collects it`,
      });
    } else {
      out.findings.push({
        check: 'crew',
        subject: item.id,
        found: `crew ${rec.name} ended without a report`,
      });
      lead(
        item.id,
        `crew ${rec.name} ended without a report; studio stop ${item.id} --requeue for its one relaunch`,
      );
    }
  }

  // The queue: an entry a killed run left current resumes in the next tick, which reads the pull
  // request first, so one that was merged already is booked, never merged again.
  let queue: ReturnType<typeof loadQueue> | undefined;
  try {
    queue = loadQueue(o.stateRoot);
  } catch (e) {
    out.findings.push({ check: 'queue', subject: 'queue.json', found: (e as Error).message });
  }
  if (queue !== undefined) {
    const running =
      inspectStateLock(o.stateRoot, RUN_LOCK, {
        now: o.now,
        heartbeatStaleMs: RUN_LOCK_HEARTBEAT_STALE_MS,
      }).state === 'held';
    const c = queue.current;
    if (c !== undefined && !running && o.scope === 'all') {
      out.findings.push({
        check: 'queue',
        subject: c.item ?? `${c.repo}#${c.pr}`,
        found: `a queue run stopped at step ${c.step}: the next tick resumes it there and never merges twice`,
      });
    }
    const waiting = [...queue.pending, ...(c === undefined ? [] : [c])];
    // `queue add` wrote the entry, then died before the board said `queued`: finish that move, or
    // the merge result would find the item in review and leave the board as it is.
    for (const item of board.items) {
      if (item.status !== 'in_review' || item.pr === undefined || item.type === 'review') continue;
      const inQueue = waiting.some((e) =>
        e.item === undefined ? e.repo === item.repo && e.pr === item.pr : e.item === item.id,
      );
      if (!inQueue) continue;
      const finding: Finding = {
        check: 'queue',
        subject: item.id,
        found: 'in the merge queue, but the board still says in_review',
      };
      if (!o.dryRun) {
        const moved = await withBoardLock(o.stateRoot, o.now, () => {
          const fresh = loadBoard(o.project);
          if (fresh.items.find((i) => i.id === item.id)?.status !== 'in_review') return false;
          saveBoard(o.project, transition(fresh, item.id, 'queued', 'studio', o.now));
          return true;
        });
        if (moved) finding.did = 'moved it to queued';
      }
      out.findings.push(finding);
    }
    for (const item of board.items) {
      if (item.status !== 'queued') continue;
      const holds = (e: { item?: string; repo: string; pr: number }) =>
        e.item === undefined ? e.repo === item.repo && e.pr === item.pr : e.item === item.id;
      if (waiting.some(holds)) continue;
      if (queue.done.some(holds)) {
        if (o.scope === 'all') {
          out.findings.push({
            check: 'queue',
            subject: item.id,
            found: 'queued with a recorded result: the next tick puts it on the board',
          });
        }
        continue;
      }
      out.findings.push({
        check: 'queue',
        subject: item.id,
        found: 'queued, but the queue holds neither an entry nor a result for it',
      });
      lead(
        item.id,
        `${item.id} is queued but the merge queue does not hold it: check ${item.repo}#${item.pr ?? '?'} and drop or re-add the item`,
      );
    }
  }
  return out;
}
