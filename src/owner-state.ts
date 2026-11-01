import { lstatSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  type AccountBlock,
  type Parks,
  readBlocksFile,
  readLimitsFile,
  writeBlocks,
  writeLimits,
} from './limits.js';
import {
  acquireStateLock,
  ensureStateDir,
  legacyEntries,
  projectStateRoots,
  removeStateEntry,
  writeStateFile,
} from './paths.js';
import {
  LAUNCH_LOCK,
  LAUNCH_LOCK_STALE_MS,
  readUsageFile,
  type Usage,
  writeUsage,
} from './usage.js';

/**
 * Blocks, limits and usage used to live in each project's state root; they are owner-wide now. This
 * moves what an old version left there into the owner root.
 */

const MIGRATE_LOCK = 'migrate.lock';
const LOCK_STALE_MS = 5 * 60_000;

/** Merged, or why not: the old file cannot be interpreted, or the owner file cannot. */
type MergeResult = 'merged' | 'legacy-unreadable' | 'owner-unreadable';

function mergeBlocks(ownerRoot: string, legacy: string): MergeResult {
  const old = readBlocksFile(legacy);
  if (!old.ok) return 'legacy-unreadable';
  const own = readBlocksFile(join(ownerRoot, 'blocks.json'));
  if (!own.ok) return 'owner-unreadable';
  const merged: AccountBlock[] = own.blocks.map((b) => ({ ...b }));
  for (const block of old.blocks) {
    const same = merged.find((b) => b.label === block.label && b.reason === block.reason);
    if (!same) merged.push({ ...block });
    else if (Date.parse(block.at) < Date.parse(same.at)) same.at = block.at;
  }
  writeBlocks(ownerRoot, merged);
  return 'merged';
}

const parkEnd = (until: string | undefined): number =>
  until === undefined ? Number.NEGATIVE_INFINITY : Date.parse(until);

function mergeLimits(ownerRoot: string, legacy: string): MergeResult {
  const old = readLimitsFile(legacy);
  if (!old.ok) return 'legacy-unreadable';
  const own = readLimitsFile(join(ownerRoot, 'limits.json'));
  if (!own.ok) return 'owner-unreadable';
  // Labels are checked names (`validLabel`), so they cannot reach the prototype.
  const merged: Parks = { ...own.labels };
  for (const [label, park] of Object.entries(old.labels)) {
    const current = merged[label];
    if (!current || parkEnd(park.parkedUntil) > parkEnd(current.parkedUntil)) merged[label] = park;
  }
  writeLimits(ownerRoot, merged);
  return 'merged';
}

/** A crash between the write and the unlink counts a file twice: the safe direction. */
function mergeUsage(ownerRoot: string, legacy: string): MergeResult {
  const old = readUsageFile(legacy);
  if (!old.ok) return 'legacy-unreadable';
  const own = readUsageFile(join(ownerRoot, 'usage.json'));
  if (!own.ok) return 'owner-unreadable';
  const merged: Usage = own.days;
  for (const [day, labels] of Object.entries(old.days)) {
    const counts: Record<string, number> = merged[day] ?? Object.create(null);
    for (const [label, runs] of Object.entries(labels)) {
      counts[label] = (Object.hasOwn(counts, label) ? (counts[label] as number) : 0) + runs;
    }
    merged[day] = counts;
  }
  writeUsage(ownerRoot, merged);
  return 'merged';
}

/** Each with the lock its owner file is written under, so a running process loses nothing. */
const FILES = [
  { name: 'blocks.json', lock: 'blocks.lock', staleMs: LOCK_STALE_MS, merge: mergeBlocks },
  { name: 'limits.json', lock: 'limits.lock', staleMs: LOCK_STALE_MS, merge: mergeLimits },
  { name: 'usage.json', lock: LAUNCH_LOCK, staleMs: LAUNCH_LOCK_STALE_MS, merge: mergeUsage },
];

const present = (file: string): boolean => lstatSync(file, { throwIfNoEntry: false }) !== undefined;

/** Old state files still lying in project roots, as absolute paths. Writes nothing. */
export function pendingLegacyState(stateBase: string): string[] {
  return projectStateRoots(stateBase).flatMap((root) =>
    FILES.map((f) => join(root, f.name)).filter(present),
  );
}

/** A name not in use yet: `rename` would silently replace an earlier kept copy. */
function freeName(file: string): string {
  let candidate = file;
  for (let i = 1; present(candidate); i++) candidate = `${file}.${i}`;
  return candidate;
}

/**
 * Keeps an old file that cannot be interpreted beside the owner file, where it holds that file (see
 * `ownerFileHeld`) until the owner removes it. A symlink is never followed: only a note is kept.
 */
function keepUnreadable(ownerRoot: string, root: string, name: string): void {
  const legacy = join(root, name);
  const kept = freeName(join(ownerRoot, `${name}.legacy-${basename(root)}`));
  ensureStateDir(ownerRoot, ownerRoot);
  if (lstatSync(legacy).isSymbolicLink()) {
    const note = `${name} in the project state root ${basename(root)} was a symlink; it was not followed\n`;
    writeStateFile(ownerRoot, kept, note);
    removeStateEntry(root, legacy);
  } else {
    renameSync(legacy, kept);
  }
}

function migrateFile(
  ownerRoot: string,
  roots: string[],
  file: (typeof FILES)[number],
  now: Date,
  problems: string[],
): void {
  const here = roots.filter((root) => present(join(root, file.name)));
  if (here.length === 0) return;
  const lock = acquireStateLock(ownerRoot, file.lock, { now, heartbeatStaleMs: file.staleMs });
  if (!lock) {
    problems.push(`${file.name} from older versions was not migrated: ${file.lock} is held`);
    return;
  }
  try {
    for (const root of here) {
      const legacy = join(root, file.name);
      const link = lstatSync(legacy).isSymbolicLink();
      const merged = link ? 'legacy-unreadable' : file.merge(ownerRoot, legacy);
      if (merged === 'merged') removeStateEntry(root, legacy);
      else if (merged === 'legacy-unreadable') keepUnreadable(ownerRoot, root, file.name);
      else {
        problems.push(
          `${join(ownerRoot, file.name)} is unreadable, so ${legacy} was not merged: inspect or remove the owner file`,
        );
      }
    }
  } finally {
    lock.release();
  }
}

/**
 * Merges the old blocks, limits and usage files of all project roots into the owner root and removes
 * them; a file it cannot interpret is kept aside and holds work until the owner removes it. Returns
 * lines for the owner, also for copies kept by an earlier run. Writes nothing when there is nothing
 * to migrate. A lost lock skips this run; a launch then refuses while old files remain. Never throws:
 * every reader of the owner root fails closed on its own.
 */
export function migrateOwnerState(ownerRoot: string, now: Date): string[] {
  const problems: string[] = [];
  try {
    if (pendingLegacyState(dirname(ownerRoot)).length > 0) {
      const lock = acquireStateLock(ownerRoot, MIGRATE_LOCK, {
        now,
        heartbeatStaleMs: LOCK_STALE_MS,
      });
      if (!lock) {
        problems.push('another Studio process is migrating old state files; skipped this run');
      } else {
        try {
          const roots = projectStateRoots(dirname(ownerRoot));
          for (const file of FILES) migrateFile(ownerRoot, roots, file, now, problems);
        } finally {
          lock.release();
        }
      }
    }
    for (const entry of legacyEntries(ownerRoot)) {
      problems.push(
        `${join(ownerRoot, entry)} is an old state file Studio could not read: no crew starts until the owner inspects and removes it`,
      );
    }
  } catch (e) {
    problems.push(`old state files were not migrated: ${(e as Error).message}`);
  }
  return problems;
}
