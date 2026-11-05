// The Studio board mod: a pane, a status line, toasts and /studio, for the owner's session only.
// It only displays. It writes no file and runs no process; only $.store and its own state change.
// The view (work list, pipeline, detailed) and a language override are such stored preferences.
import type { EngineInterface, Register, TextProps } from 'claude-code';
import { atom, read, update } from 'claude-code';
import {
  type BoardRead,
  LANGS,
  type Lang,
  type Line,
  langOf,
  newAlerts,
  paneLines,
  parseState,
  stateDirName,
  statusLine,
  statusText,
  VIEWS,
  type View,
} from './board-model';

const PANE = { id: 'studio-board', title: 'Studio board' };
const TICK_MS = 10_000;
const MAX_PATH_DEPTH = 256;
const USAGE = 'Usage: /studio [list | pipeline | more | status | pause | resume | lang de|en|auto]';
const HINT = 'list | pipeline | more | status | pause | resume | lang';
/** $.store keys of the preferences; neither is per project. */
const VIEW_KEY = 'view';
const LANG_KEY = 'lang';

const board = atom(
  { plugin: 'studio', key: 'board' } as const,
  { kind: 'missing' },
  {
    shape: 'board-1',
  },
);
const paused = atom({ plugin: 'studio', key: 'paused' } as const, false, { shape: 'paused-1' });
const view = atom({ plugin: 'studio', key: 'view' } as const, 'list' as View, { shape: 'view-1' });
const lang = atom({ plugin: 'studio', key: 'lang' } as const, 'en' as Lang, { shape: 'lang-1' });

const TONE: Record<NonNullable<Line['tone']>, TextProps> = {
  ok: { color: 'success' },
  wait: { color: 'warning' },
  idle: { color: 'inactive' },
  err: { color: 'error' },
  dim: { dimColor: true },
  head: { weight: 'bold' },
  run: { color: 'suggestion' },
  you: { color: 'warning', weight: 'bold', inverse: true },
};

const isView = (v: unknown): v is View => VIEWS.includes(v as View);
const isLang = (v: unknown): v is Lang => LANGS.includes(v as Lang);

/**
 * The language of the displayed text: `/studio lang` if set, else Claude Code's `language`
 * setting, else the locale (LC_ALL, LC_MESSAGES, LANG); English when none says.
 */
async function languageOf($: EngineInterface): Promise<Lang> {
  const stored = await $.store.get(LANG_KEY).catch(() => undefined);
  if (isLang(stored)) return stored;
  const setting = await $.settings.read({ key: 'language' }).catch(() => undefined);
  const fromSetting = typeof setting === 'string' ? langOf(setting) : undefined;
  if (fromSetting !== undefined) return fromSetting;
  for (const value of [
    await $.env.get('LC_ALL').catch(() => undefined),
    await $.env.get('LC_MESSAGES').catch(() => undefined),
    await $.env.get('LANG').catch(() => undefined),
  ]) {
    const fromLocale = langOf(value);
    if (fromLocale !== undefined) return fromLocale;
  }
  return 'en';
}

async function storedView($: EngineInterface): Promise<View> {
  const v = await $.store.get(VIEW_KEY).catch(() => undefined);
  return isView(v) ? v : 'list';
}

const VIEW_REPLY: Record<Lang, Record<View, string>> = {
  en: {
    list: 'Studio board: work list.',
    pipeline: 'Studio board: pipeline (the work list when the pane is narrow).',
    more: 'Studio board: details. Back with /studio list.',
  },
  de: {
    list: 'Studio-Board: Arbeitsliste.',
    pipeline: 'Studio-Board: Pipeline (bei schmalem Bereich die Arbeitsliste).',
    more: 'Studio-Board: Details. Zurück mit /studio list.',
  },
};

const isAbsolute = (p: string): boolean => /^(?:[\\/]|[A-Za-z]:[\\/])/.test(p);
const withoutTrailingSlash = (p: string): string => p.replace(/\/+$/, '');

/** The nearest folder at or above `cwd` holding `.studio/studio.yaml`. */
async function findProject($: EngineInterface, cwd: string): Promise<string | undefined> {
  let dir = withoutTrailingSlash(cwd);
  for (let depth = 0; depth < MAX_PATH_DEPTH; depth++) {
    if (await $.fs.exists(`${dir}/.studio/studio.yaml`)) return dir === '' ? '/' : dir;
    const cut = dir.lastIndexOf('/');
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

const TOAST_MAX = 1500;

/** One toast per tick: a plugin's toast replaces its own, so several would overwrite each other. */
function oneToast(texts: string[]): string {
  const joined = texts.join(' · ');
  const cps = [...joined];
  return cps.length <= TOAST_MAX ? joined : `${cps.slice(0, TOAST_MAX - 1).join('')}…`;
}

/** The seen list is saved before anything shows, so a store that fails never repeats a toast. */
async function raiseToasts(
  $: EngineInterface,
  dirName: string,
  state: Parameters<typeof newAlerts>[1],
  language: Lang,
) {
  try {
    const key = `seen:${dirName}`;
    const stored = await $.store.get(key);
    const seen = Array.isArray(stored) ? stored.filter((s) => typeof s === 'string') : [];
    const fresh = newAlerts(seen, state, language);
    await $.store.set(key, fresh.seen);
    if (fresh.toasts.length > 0) $.ui.toast(oneToast(fresh.toasts));
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
const live: {
  project?: string;
  timer?: boolean;
  shownStatus?: string;
  running?: Promise<void>;
  view?: View;
} = {};

async function publish($: EngineInterface, next: BoardRead, isPaused: boolean, language: Lang) {
  await update($, board, () => next);
  await update($, paused, () => isPaused);
  await update($, lang, () => language);
  await update($, view, () => live.view ?? 'list');
  const line = next.kind === 'ok' ? statusLine(next.state, isPaused, language) : undefined;
  if (line !== live.shownStatus) {
    live.shownStatus = line;
    $.ui.status(line);
  }
}

/** As readPause in src/pause.ts: any entry named pause.json counts, a dangling link too. */
async function isPaused($: EngineInterface, root: string): Promise<boolean> {
  try {
    return (await $.fs.list(root)).some((entry) => entry.name === 'pause.json');
  } catch {
    // A missing root is not paused; a root that exists but cannot be listed fails closed.
    return $.fs.exists(root);
  }
}

async function refreshOnce($: EngineInterface, dir: string) {
  try {
    const language = await languageOf($);
    live.view ??= await storedView($);
    const { dirName, root } = await stateRoot($, dir);
    const next = await readBoard($, root);
    await publish($, next, await isPaused($, root), language);
    if (next.kind === 'ok') await raiseToasts($, dirName, next.state, language);
  } catch {
    try {
      await publish($, { kind: 'unreadable' }, false, await languageOf($));
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

function armTimer($: EngineInterface, dir: string) {
  live.timer = true;
  $.clock.every(TICK_MS, () => void refresh($, dir));
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
      description: 'Show the Studio board: work list, pipeline or details',
      argumentHint: HINT,
    });
    await refresh($, dir);
    armTimer($, dir);
    void $.ui.open(PANE).catch(() => undefined);
    return next(e);
  });

  on('command.run', { command: 'studio' }, async ($, e) => {
    const arg = e.args.trim();
    // A plugin reload may have lost the module's variables and its timer: derive both again.
    // The command can only be typed where something draws, so a session without a surface is not one.
    const project =
      live.project ??
      (await ownerProject(
        $,
        (await $.session.surfaces().catch(() => [])).length > 0,
        await $.session.cwd(),
      ).catch(() => undefined));
    if (project === undefined) return { text: 'Not in a Studio project.' };
    live.project = project;
    if (!live.timer) armTimer($, project);
    if (arg === '') {
      try {
        await $.ui.open(PANE);
      } catch {
        return { text: 'The board could not be opened here.' };
      }
      return { text: 'Studio board opened.' };
    }
    if (arg === 'status') {
      await refresh($, project);
      const current = (await read($, board)) as BoardRead;
      return { text: statusText(current, await read($, paused), await read($, lang)) };
    }
    if (isView(arg)) {
      live.view = arg;
      await update($, view, () => arg);
      // A store that fails keeps the view for this session only.
      await $.store.set(VIEW_KEY, arg).catch(() => undefined);
      void $.ui.open(PANE).catch(() => undefined);
      return { text: VIEW_REPLY[await read($, lang)][arg] };
    }
    const langArg = /^lang\s+(\S+)$/.exec(arg)?.[1];
    if (langArg !== undefined && (isLang(langArg) || langArg === 'auto')) {
      if (langArg === 'auto') await $.store.delete(LANG_KEY).catch(() => undefined);
      else await $.store.set(LANG_KEY, langArg).catch(() => undefined);
      await refresh($, project);
      const now = await read($, lang);
      return { text: now === 'de' ? 'Studio-Board: Deutsch.' : 'Studio board: English.' };
    }
    const binary = shellWord(`${$.plugin.root}/bin/studio`);
    if (arg === 'pause') {
      return {
        text: `Pausing needs a terminal: run ${binary} --project ${shellWord(project)} pause`,
      };
    }
    if (arg === 'resume') {
      return {
        text: `Resuming needs a terminal: run ${binary} --project ${shellWord(project)} resume`,
      };
    }
    return { text: USAGE };
  });

  on('ui.render', { component: 'Pane', requestId: 'studio-board' }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e);
    const lines = paneLines((await read($, board)) as BoardRead, {
      columns: e.props.bodyColumns,
      nowMs: await $.clock.now(),
      paused: await read($, paused),
      view: await read($, view),
      lang: await read($, lang),
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
