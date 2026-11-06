// The Studio board mod: a pane, a status line, toasts and /studio, for the owner's session only.
// It displays, runs no process, and writes one file only: the owner's one-time REA install
// confirmation, when the person presses its button in the pane (never from a command or a model).
// Otherwise only $.store and its own state change: the view and a language override.
import type { EngineInterface, Register, TextProps } from 'claude-code';
import { atom, read, update } from 'claude-code';
import {
  type BoardRead,
  type Line,
  nestedWorktreesOf,
  newAlerts,
  paneLines,
  parseState,
  REA_CONFIRM_KEY,
  STATE_DIR,
  stateDirName,
  statusLine,
  statusText,
  VIEWS,
  type View,
} from './board-model.js';
import { isLang, LANGS, type Lang, resolveLang, stringsFor } from './i18n/index.js';

const PANE_ID = 'studio-board';
const TICK_MS = 10_000;
const MAX_PATH_DEPTH = 256;
/** The arguments, English in every language; the language codes come from the locale files. */
const COMMANDS = `list | pipeline | more | group [<project>] | status | pause | resume | lang ${[...LANGS, 'auto'].join('|')} | off | on`;
const HINT = 'list | pipeline | more | group | status | pause | resume | lang | off | on';
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
/** The group's name while another project of it is shown; '' for this project. */
const focusAtom = atom({ plugin: 'studio', key: 'focus' } as const, '', { shape: 'focus-1' });
/**
 * `/studio off` and `/studio on` in this session ($.state is the session's, kept over a reload);
 * `auto` until one of them: then the owner config decides (pane.nested_worktrees).
 */
const switchAtom = atom(
  { plugin: 'studio', key: 'switch' } as const,
  'auto' as 'auto' | 'on' | 'off',
  {
    shape: 'switch-1',
  },
);

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

/**
 * The language of the displayed text, by the chain pushes use too (hooks/i18n/resolve.ts):
 * `/studio lang` if set, else Claude Code's `language` setting, else the locale (LC_ALL,
 * LC_MESSAGES, LANG); English when none says or the language has no locale file.
 */
async function languageOf($: EngineInterface): Promise<Lang> {
  const stored = await $.store.get(LANG_KEY).catch(() => undefined);
  const setting = await $.settings.read({ key: 'language' }).catch(() => undefined);
  // The engine wants each variable named literally.
  const env = {
    LC_ALL: await $.env.get('LC_ALL').catch(() => undefined),
    LC_MESSAGES: await $.env.get('LC_MESSAGES').catch(() => undefined),
    LANG: await $.env.get('LANG').catch(() => undefined),
  };
  return resolveLang({
    override: isLang(stored) ? stored : undefined,
    setting: typeof setting === 'string' ? setting : undefined,
    env,
  });
}

async function storedView($: EngineInterface): Promise<View> {
  const v = await $.store.get(VIEW_KEY).catch(() => undefined);
  return isView(v) ? v : 'list';
}

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

/** `$XDG_CONFIG_HOME/studio/config.yaml`, else `$HOME/.config/studio/config.yaml`, as src/config.ts. */
async function ownerConfigFileOf($: EngineInterface): Promise<string | undefined> {
  const xdg = await $.env.get('XDG_CONFIG_HOME').catch(() => undefined);
  const home = await $.env.get('HOME').catch(() => undefined);
  const base = xdg && isAbsolute(xdg) ? xdg : home ? `${home}/.config` : undefined;
  return base === undefined ? undefined : `${withoutTrailingSlash(base)}/studio/config.yaml`;
}

/**
 * Whether the session runs in a git worktree nested under a Studio project: the nearest folder at
 * or above `cwd` with a `.git` holds it as a file (a linked worktree), and a folder above that one
 * holds `.studio/studio.yaml`.
 */
async function inNestedWorktree($: EngineInterface, cwd: string): Promise<boolean> {
  let dir = withoutTrailingSlash(cwd);
  for (let depth = 0; depth < MAX_PATH_DEPTH; depth++) {
    const git = `${dir}/.git`;
    if (await $.fs.exists(git)) {
      const st = await $.fs.stat(git);
      if (st.kind !== 'file') return false;
      const cut = dir.lastIndexOf('/');
      return cut >= 0 && (await findProject($, dir.slice(0, cut))) !== undefined;
    }
    const cut = dir.lastIndexOf('/');
    if (cut < 0) return false;
    dir = dir.slice(0, cut);
  }
  return false;
}

/** Whether the owner config hides the board in this session: `hide`, and a nested worktree. */
async function hiddenByConfig($: EngineInterface, cwd: string): Promise<boolean> {
  try {
    const file = await ownerConfigFileOf($);
    if (file === undefined || !(await $.fs.exists(file))) return false;
    if (nestedWorktreesOf(await $.fs.read(file)) !== 'hide') return false;
    return await inNestedWorktree($, cwd);
  } catch {
    return false;
  }
}

/** The board is off in this session: `/studio off`, or the owner config's switch before any. */
async function isOff($: EngineInterface): Promise<boolean> {
  const s = await read($, switchAtom);
  return s === 'off' || (s === 'auto' && live.hidden === true);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The owner state root, `<base>/studio/owner`, as ownerStateRootFor in src/paths.ts. */
async function ownerRootOf($: EngineInterface): Promise<string | undefined> {
  const xdg = await $.env.get('XDG_STATE_HOME');
  const home = await $.env.get('HOME');
  const base = xdg && isAbsolute(xdg) ? xdg : home ? `${home}/.local/state` : undefined;
  return base === undefined ? undefined : `${withoutTrailingSlash(base)}/studio/owner`;
}

/**
 * The person pressed the REA install button: writes the one confirmation, for the pinned version
 * and mode the state names (with `<home>/analysis` when no folder is granted), as its own small
 * file in the owner state, `rea-confirm.json`. The engine's file calls have no rename and no mode,
 * so the shared record is never rewritten here: Studio takes this file in, checks it (a plain file
 * of this user, writable by nobody else, one whole JSON object, nothing but that folder) and folds
 * it into its record with a temporary file and a rename. Nothing is written through a link: the
 * owner folder and the file must not be links. Only a press reaches here: a command or the model
 * cannot.
 */
async function confirmRea($: EngineInterface): Promise<void> {
  const language = await read($, lang);
  try {
    const current = (await read($, board)) as BoardRead;
    const want = current.kind === 'ok' ? current.state.reaInstall : undefined;
    const owner = await ownerRootOf($);
    const home = await $.env.get('HOME');
    if (want === undefined || owner === undefined) throw new Error('nothing to confirm');
    const dir = await $.fs.stat(owner);
    if (dir.isLink || dir.kind !== 'dir') throw new Error('the owner state is not a folder');
    const file = `${owner}/rea-confirm.json`;
    if (await $.fs.exists(file)) {
      const st = await $.fs.stat(file);
      if (st.isLink || st.kind !== 'file') throw new Error('not a plain file');
    }
    const confirmation = {
      version: want.version,
      mode: want.mode,
      at: new Date(await $.clock.now()).toISOString(),
      by: 'pane',
      ...(want.needsFolder && home ? { folder: `${withoutTrailingSlash(home)}/analysis` } : {}),
    };
    await $.fs.write(file, `${JSON.stringify(confirmation)}\n`);
    $.ui.toast(stringsFor(language).reaConfirmed);
  } catch {
    $.ui.toast(stringsFor(language).reaNotConfirmed);
  }
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
  /** The owner config hides the board in this session (a nested worktree). */
  hidden?: boolean;
  /** Another project of the group whose work list is shown, by its state folder. */
  focus?: { id: string; stateDir: string; group: string };
} = {};

/** `own`: this project's board, for the status line, also while another project is shown. */
async function publish(
  $: EngineInterface,
  next: BoardRead,
  isPaused: boolean,
  language: Lang,
  own: BoardRead = next,
) {
  await update($, board, () => next);
  await update($, paused, () => isPaused);
  await update($, lang, () => language);
  await update($, view, () => live.view ?? 'list');
  const line = own.kind === 'ok' ? statusLine(own.state, isPaused, language) : undefined;
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
  // Off in this session: nothing is read, drawn or toasted.
  if (await isOff($).catch(() => false)) return;
  try {
    const language = await languageOf($);
    live.view ??= await storedView($);
    const { dirName, root } = await stateRoot($, dir);
    const next = await readBoard($, root);
    const focus = live.focus;
    if (focus !== undefined && STATE_DIR.test(focus.stateDir)) {
      // Another project of the group: its state file beside this one, read only.
      const other = `${root.slice(0, root.lastIndexOf('/'))}/${focus.stateDir}`;
      await publish($, await readBoard($, other), await isPaused($, other), language, next);
      await update($, focusAtom, () => focus.group);
    } else {
      await publish($, next, await isPaused($, root), language);
      await update($, focusAtom, () => '');
    }
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
    live.hidden = await hiddenByConfig($, e.cwd);
    const t = stringsFor(await languageOf($));
    await $.command.register({
      name: 'studio',
      description: t.commandDescription,
      argumentHint: HINT,
    });
    armTimer($, dir);
    // Off in this session: the command stays, so /studio on can bring the board back.
    if (await isOff($)) return next(e);
    await refresh($, dir);
    void $.ui.open({ id: PANE_ID, title: t.paneTitle }).catch(() => undefined);
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
    if (project === undefined) return { text: stringsFor(await languageOf($)).notInProject };
    if (live.project === undefined) live.hidden = await hiddenByConfig($, await $.session.cwd());
    live.project = project;
    if (!live.timer) armTimer($, project);
    const pane = async () => ({ id: PANE_ID, title: stringsFor(await read($, lang)).paneTitle });
    if (arg === 'off') {
      await update($, switchAtom, () => 'off');
      live.shownStatus = undefined;
      $.ui.status(undefined);
      await $.ui.close({ id: PANE_ID }).catch(() => undefined);
      return { text: stringsFor(await languageOf($)).offReply };
    }
    if (arg === 'on') {
      await update($, switchAtom, () => 'on');
      await refresh($, project);
      void $.ui.open(await pane()).catch(() => undefined);
      return { text: stringsFor(await languageOf($)).onReply };
    }
    if (await isOff($)) return { text: stringsFor(await languageOf($)).offReply };
    if (arg === '') {
      const t = stringsFor(await read($, lang));
      try {
        await $.ui.open({ id: PANE_ID, title: t.paneTitle });
      } catch {
        return { text: t.openFailed };
      }
      return { text: t.opened };
    }
    if (arg === 'status') {
      await refresh($, project);
      const current = (await read($, board)) as BoardRead;
      return { text: statusText(current, await read($, paused), await read($, lang)) };
    }
    const groupArg = /^group\s+([a-z][a-z0-9-]{0,31})$/.exec(arg)?.[1];
    if (groupArg !== undefined) {
      live.focus = undefined;
      await refresh($, project);
      const own = (await read($, board)) as BoardRead;
      const row =
        own.kind === 'ok' ? own.state.group?.projects.find((p) => p.id === groupArg) : undefined;
      const t = stringsFor(await read($, lang));
      if (own.kind !== 'ok' || own.state.group === undefined || row === undefined) {
        return { text: t.noProjectReply(groupArg) };
      }
      if (!row.self && row.stateDir !== undefined) {
        live.focus = { id: row.id, stateDir: row.stateDir, group: own.state.group.name };
      }
      live.view = 'list';
      await update($, view, () => 'list');
      await refresh($, project);
      void $.ui.open(await pane()).catch(() => undefined);
      return { text: t.focusReply(row.id) };
    }
    if (isView(arg)) {
      const wasFocused = live.focus !== undefined;
      live.focus = undefined;
      live.view = arg;
      await update($, view, () => arg);
      if (wasFocused) await refresh($, project);
      // A store that fails keeps the view for this session only.
      await $.store.set(VIEW_KEY, arg).catch(() => undefined);
      void $.ui.open(await pane()).catch(() => undefined);
      return { text: stringsFor(await read($, lang)).viewReply[arg] };
    }
    const langArg = /^lang\s+(\S+)$/.exec(arg)?.[1];
    if (langArg !== undefined && (isLang(langArg) || langArg === 'auto')) {
      if (langArg === 'auto') await $.store.delete(LANG_KEY).catch(() => undefined);
      else await $.store.set(LANG_KEY, langArg).catch(() => undefined);
      await refresh($, project);
      return { text: stringsFor(await read($, lang)).languageSet };
    }
    const t = stringsFor(await languageOf($));
    const binary = shellWord(`${$.plugin.root}/bin/studio`);
    if (arg === 'pause') {
      return { text: t.pauseNeedsTerminal(`${binary} --project ${shellWord(project)} pause`) };
    }
    if (arg === 'resume') {
      return { text: t.resumeNeedsTerminal(`${binary} --project ${shellWord(project)} resume`) };
    }
    return { text: t.usage(COMMANDS) };
  });

  on('ui.render', { component: 'Pane', requestId: 'studio-board' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e);
    if (await isOff($)) {
      return (
        <Box flexDirection="column">
          <Text dimColor>{stringsFor(await read($, lang)).offPane}</Text>
        </Box>
      );
    }
    const lines = paneLines((await read($, board)) as BoardRead, {
      columns: e.props.bodyColumns,
      nowMs: await $.clock.now(),
      paused: await read($, paused),
      view: await read($, view),
      lang: await read($, lang),
      ...((await read($, focusAtom)) === '' ? {} : { focusOf: await read($, focusAtom) }),
    });
    return (
      <Box flexDirection="column">
        {lines.map((line) =>
          line.button?.key === REA_CONFIRM_KEY ? (
            <Button
              key={REA_CONFIRM_KEY}
              label={line.button.label}
              variant="primary"
              onPress={() => void confirmRea($)}
            />
          ) : (
            <Text {...(line.tone ? TONE[line.tone] : {})}>{line.text}</Text>
          ),
        )}
      </Box>
    );
  });
};
