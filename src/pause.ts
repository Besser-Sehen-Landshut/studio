import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { removeStateEntry, writeStateFile } from './paths.js';

/**
 * The owner's pause: while `pause.json` exists in the state root nothing new starts (no plan
 * assignment, no launch, no merge). Running crews continue.
 */
export const PAUSE_FILE = 'pause.json';

/** The one line for refusals and holds. */
export const PAUSED_LINE =
  'paused: no crew starts and nothing is merged until the owner runs studio resume';

export interface PauseState {
  paused: boolean;
  /** When the pause was set; absent when the file cannot be read (it still pauses). */
  at?: string;
}

/**
 * Fail closed: any entry under the name, whatever it holds (garbage, a directory, a symlink, or
 * something that cannot be inspected), means paused.
 */
export function readPause(root: string): PauseState {
  const file = join(root, PAUSE_FILE);
  try {
    const st = lstatSync(file, { throwIfNoEntry: false });
    if (st === undefined) return { paused: false };
    if (!st.isFile()) return { paused: true };
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const at = (raw as { at?: unknown } | null)?.at;
    return typeof at === 'string' && !Number.isNaN(Date.parse(at))
      ? { paused: true, at }
      : { paused: true };
  } catch {
    return { paused: true };
  }
}

export function setPause(root: string, now: Date): void {
  writeStateFile(root, join(root, PAUSE_FILE), `${JSON.stringify({ at: now.toISOString() })}\n`);
}

/** Removes the file whatever it is: an unreadable pause must be clearable. */
export function clearPause(root: string): void {
  removeStateEntry(root, join(root, PAUSE_FILE));
}
