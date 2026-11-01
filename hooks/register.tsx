// The Studio board mod: a pane, a status line, toasts and /studio, for the owner's session only.
// It only displays. It writes no file and runs no process; only $.store and its own state change.
import type { EngineInterface, Register, TextProps } from 'claude-code';
import { atom, read, update } from 'claude-code';
import {
  type BoardRead,
  boardLines,
  type Line,
  newAlerts,
  parseState,
  stateDirName,
  statusLine,
  statusText,
} from './board-model';

const PANE = { id: 'studio-board', title: 'Studio board' };
const TICK_MS = 10_000;
const MAX_PATH_DEPTH = 256;
const USAGE = 'Usage: /studio [status | pause | resume]';

const board = atom(
  { plugin: 'studio', key: 'board' } as const,
  { kind: 'missing' },
  {
    shape: 'board-1',
  },
);
const paused = atom({ plugin: 'studio', key: 'paused' } as const, false, { shape: 'paused-1' });

const TONE: Record<NonNullable<Line['tone']>, TextProps> = {
  ok: { color: 'success' },
  wait: { color: 'warning' },
  idle: { color: 'inactive' },
  err: { color: 'error' },
  dim: { dimColor: true },
  head: { weight: 'bold' },
};

const isAbsolute = (p: string): boolean => /^(?:[\\/]|[A-Za-z]:[\\/])/.test(p);
const withoutTrailingSlash = (p: string): string => p.replace(/[\\/]+$/, '');

/** The nearest folder at or above `cwd` holding `.studio/studio.yaml`. */
async function findProject($: EngineInterface, cwd: string): Promise<string | undefined> {
  let dir = withoutTrailingSlash(cwd);
  for (let depth = 0; depth < MAX_PATH_DEPTH; depth++) {
    if (await $.fs.exists(`${dir}/.studio/studio.yaml`)) return dir === '' ? '/' : dir;
    const cut = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'));
    if (cut < 0) return undefined;
    dir = dir.slice(0, cut);
  }
  return undefined;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The same directory as stateRootFor in src/paths.ts. Rejects when it cannot be told. */
async function stateRoot($: EngineInterface, project: string) {
  const { realPath } = await $.fs.stat(project, { resolve: true });
  if (realPath === undefined) throw new Error('no real path');
  const xdg = await $.env.get('XDG_STATE_HOME');
  const home = await $.env.get('HOME');
  const base = xdg && isAbsolute(xdg) ? xdg : home ? `${home}/.local/state` : undefined;
  if (base === undefined) throw new Error('no state base');
  const dirName = stateDirName(realPath, await sha256Hex(realPath));
  return { dirName, root: `${withoutTrailingSlash(base)}/studio/${dirName}` };
}

async function readBoard($: EngineInterface, root: string): Promise<BoardRead> {
  const file = `${root}/state.json`;
  if (!(await $.fs.exists(file))) return { kind: 'missing' };
  try {
    return parseState(await $.fs.read(file));
  } catch {
    return { kind: 'unreadable' };
  }
}

/** The seen list is saved before anything shows, so a store that fails never repeats a toast. */
async function raiseToasts(
  $: EngineInterface,
  dirName: string,
  state: Parameters<typeof newAlerts>[1],
) {
  try {
    const key = `seen:${dirName}`;
    const stored = await $.store.get(key);
    const seen = Array.isArray(stored) ? stored.filter((s) => typeof s === 'string') : [];
    const fresh = newAlerts(seen, state);
    await $.store.set(key, fresh.seen);
    for (const text of fresh.toasts) $.ui.toast(text);
  } catch {
    // The pane and the status line still say what the toast would have.
  }
}

/** A single-quoted shell word when the path would not paste as one word; control characters go. */
function shellWord(path: string): string {
  const clean = path.replace(/\p{Cc}/gu, '');
  return /^[\w./:@%+=,-]+$/.test(clean) ? clean : `'${clean.replaceAll("'", "'\\''")}'`;
}

/** What one session holds beyond the state atoms: none of it is drawn from. */
const live: { project?: string; shownStatus?: string; running?: Promise<void> } = {};

async function publish($: EngineInterface, next: BoardRead, isPaused: boolean) {
  await update($, board, () => next);
  await update($, paused, () => isPaused);
  const line = next.kind === 'ok' ? statusLine(next.state, isPaused) : undefined;
  if (line !== live.shownStatus) {
    live.shownStatus = line;
    $.ui.status(line);
  }
}

async function refreshOnce($: EngineInterface, dir: string) {
  try {
    const { dirName, root } = await stateRoot($, dir);
    const next = await readBoard($, root);
    await publish($, next, await $.fs.exists(`${root}/pause.json`));
    if (next.kind === 'ok') await raiseToasts($, dirName, next.state);
  } catch {
    try {
      await publish($, { kind: 'unreadable' }, false);
    } catch {
      // Nothing left to tell: the next tick tries again.
    }
  }
}

/** One at a time: a slow disk must not raise the same toast from two overlapping ticks. */
function refresh($: EngineInterface, dir: string): Promise<void> {
  live.running ??= refreshOnce($, dir).finally(() => {
    live.running = undefined;
  });
  return live.running;
}

async function ownerProject($: EngineInterface, isInteractive: boolean, cwd: string) {
  if (!isInteractive) return undefined;
  if ((await $.env.get('STUDIO_ROLE')) === 'crew') return undefined;
  return findProject($, cwd);
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const dir = await ownerProject($, e.isInteractive, e.cwd).catch(() => undefined);
    if (dir === undefined) return next(e);
    live.project = dir;
    await $.command.register({
      name: 'studio',
      description: 'Show the Studio board, or its status line',
      argumentHint: 'status | pause | resume',
    });
    await refresh($, dir);
    $.clock.every(TICK_MS, () => void refresh($, dir));
    void $.ui.open(PANE).catch(() => undefined);
    return next(e);
  });

  on('command.run', { command: 'studio' }, async ($, e) => {
    const arg = e.args.trim();
    const project = live.project;
    if (project === undefined) return { text: 'Not in a Studio project.' };
    if (arg === '') {
      await $.ui.open(PANE);
      return { text: 'Studio board opened.' };
    }
    if (arg === 'status') {
      await refresh($, project);
      const current = (await read($, board)) as BoardRead;
      return { text: statusText(current, await read($, paused)) };
    }
    if (arg === 'pause') {
      return {
        text: `Pausing needs a terminal: run studio --project ${shellWord(project)} pause`,
      };
    }
    if (arg === 'resume') {
      return {
        text: `Resuming needs a terminal: run studio --project ${shellWord(project)} resume`,
      };
    }
    return { text: USAGE };
  });

  on('ui.render', { component: 'Pane', requestId: 'studio-board' }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e);
    const lines = boardLines((await read($, board)) as BoardRead, {
      columns: e.props.bodyColumns,
      nowMs: await $.clock.now(),
      paused: await read($, paused),
    });
    return (
      <Box flexDirection="column">
        {lines.map((line) => (
          <Text {...(line.tone ? TONE[line.tone] : {})}>{line.text}</Text>
        ))}
      </Box>
    );
  });
};
