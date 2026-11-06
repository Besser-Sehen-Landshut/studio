// REA installs itself when a researcher item first needs it, after one confirmation by the owner
// per pinned version: asked in a terminal, or, without one, put to the lead as a decision the owner
// confirms once (`studio research install --yes`). A crew can never install it or confirm it.
//
// Trust mode (owner config `research.trust`, default true) installs REA in full (optional
// dependencies and install scripts, which the debug and observe tools need) and lets researcher
// crews use every REA tool class without a per-item `studio research allow`. Strict mode
// (`research.trust: false`) keeps the static install and the per-item classes.
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isMap, isSeq, parseDocument } from 'yaml';
import {
  loadOwnerConfig,
  type OwnerConfig,
  type OwnerEnv,
  ownerConfigFile,
  pathKey,
  within,
} from './config.js';
import { ensureStateDir, writeStateFile } from './paths.js';
import type { Ports } from './ports.js';
import { REA_DEFAULT_VERSION, REA_PACKAGE } from './rea.js';
import { installRea, verifyReaInstall } from './rea-install.js';

/** Remembered answers, per pinned version and install mode, in the owner state root. */
export const CONSENT_FILE = 'rea-consent.json';
/** Written once the trust-mode notice was shown, so it never nags again. */
export const TRUST_NOTICE_FILE = 'rea-trust-notice.json';
/** Written when the owner skipped the optional setup step, so `studio setup` asks it once. */
export const SETUP_SKIP_FILE = 'rea-setup-skipped.json';

export function setupSkipped(ownerRoot: string): boolean {
  try {
    return lstatSync(join(ownerRoot, SETUP_SKIP_FILE)).isFile();
  } catch {
    return false;
  }
}

export function recordSetupSkip(ownerRoot: string, now: Date): void {
  ensureStateDir(ownerRoot, ownerRoot);
  writeStateFile(
    ownerRoot,
    join(ownerRoot, SETUP_SKIP_FILE),
    `${JSON.stringify({ skippedAt: now.toISOString() })}\n`,
  );
}

/** The analysis folder offered when the owner config names none. */
export const DEFAULT_ANALYSIS_DIR = '~/analysis';

export type ReaMode = 'full' | 'static';

/** Full in trust mode (the default), static in strict mode. */
export const reaMode = (owner: OwnerConfig): ReaMode => (owner.research.trust ? 'full' : 'static');

export const reaVersionOf = (owner: OwnerConfig): string => owner.reaVersion ?? REA_DEFAULT_VERSION;

export const consentQuestion = (version: string): string =>
  `REA is not installed yet. Install ${REA_PACKAGE} ${version} now? It runs with your user rights outside the sandbox. [Y/n] `;

export const FOLDER_QUESTION = `Analysis folder for reverse engineering [${DEFAULT_ANALYSIS_DIR}]: `;

/** The one notice of trust mode; shown on the first launch that uses it, then never again. */
export const TRUST_NOTICE =
  'REA trust mode: researcher crews may use every REA tool class (annotate, debug, observe, device, export). REA tools run as you, outside the sandbox. For per-item approval set research: { trust: false } in the owner config.';

/** A researcher item needs REA, and only the owner can say yes: the lead hears this line. */
export class ReaInstallNeeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReaInstallNeeded';
  }
}

type Answer = 'yes' | 'no';
const consentKey = (version: string, mode: ReaMode) => `${version}:${mode}`;

/** The remembered answer for this version and mode; an unreadable file counts as none. */
export function readConsent(ownerRoot: string, version: string, mode: ReaMode): Answer | undefined {
  return readConsentEntry(ownerRoot, version, mode)?.answer;
}

/**
 * The remembered entry: the answer and, from the pane's button, the analysis folder the owner
 * confirmed with it (absolute, below the home: the pane writes `<home>/analysis`).
 */
export function readConsentEntry(
  ownerRoot: string,
  version: string,
  mode: ReaMode,
): { answer: Answer; folder?: string } | undefined {
  try {
    const file = join(ownerRoot, CONSENT_FILE);
    if (!lstatSync(file).isFile()) return undefined;
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<
      string,
      { answer?: unknown; folder?: unknown }
    >;
    const e = raw?.[consentKey(version, mode)];
    const a = e?.answer;
    if (a !== 'yes' && a !== 'no') return undefined;
    const folder =
      typeof e?.folder === 'string' && isAbsolute(e.folder) && !/\p{Cc}/u.test(e.folder)
        ? e.folder
        : undefined;
    return { answer: a, ...(folder === undefined ? {} : { folder }) };
  } catch {
    return undefined;
  }
}

export function recordConsent(
  ownerRoot: string,
  version: string,
  mode: ReaMode,
  answer: Answer,
  now: Date,
): void {
  const file = join(ownerRoot, CONSENT_FILE);
  let raw: Record<string, unknown> = {};
  try {
    if (lstatSync(file).isFile())
      raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    raw = {};
  }
  ensureStateDir(ownerRoot, ownerRoot);
  writeStateFile(
    ownerRoot,
    file,
    `${JSON.stringify({ ...raw, [consentKey(version, mode)]: { answer, at: now.toISOString() } }, null, 2)}\n`,
  );
}

/** `~/x` and `~` against the home; anything else must be absolute. */
export function expandHome(dir: string, home: string): string {
  if (dir === '~') return home;
  if (dir.startsWith('~/')) return join(home, dir.slice(2));
  return dir;
}

/**
 * Adds `dir` to `research_roots` of the owner config, keeping the rest of the file (comments too),
 * through a temporary file and a rename. Creates the folder (0700) when it is missing. Returns the
 * absolute folder. A folder below a listed root is not added again.
 */
export function addResearchRoot(owner: OwnerEnv, dir: string): string {
  const home = owner.homedir ?? homedir();
  const abs = resolve(expandHome(dir.trim(), home));
  if (!isAbsolute(expandHome(dir.trim(), home)) || /\p{Cc}/u.test(abs)) {
    throw new Error('the analysis folder must be an absolute path or start with ~/');
  }
  mkdirSync(abs, { recursive: true, mode: 0o700 });
  const file = ownerConfigFile(owner);
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const doc = parseDocument(text === '' ? '{}' : text);
  if (doc.errors.length > 0) throw new Error(`${file}: invalid YAML; nothing changed`);
  if (!isMap(doc.contents)) throw new Error(`${file}: not a map; nothing changed`);
  const current = doc.get('research_roots');
  const roots = isSeq(current)
    ? current.items.map((i) => String((i as { value?: unknown }).value ?? i))
    : [];
  if (roots.some((r) => within(pathKey(abs), pathKey(resolve(r))))) return abs;
  doc.set('research_roots', [...roots, abs]);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, doc.toString(), { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  // Read back: a file Studio cannot load afterwards would stop every command.
  loadOwnerConfig(owner);
  return abs;
}

/**
 * A researcher item's own analysis folder (`studio add --artifacts`): `~/` expanded, absolute, and
 * below a granted `research_roots` entry by its real path; no new owner step is needed for it. A
 * folder outside every root is refused: granting a root is the owner's (studio research install).
 */
export function researchFolder(dir: string, roots: readonly string[], home: string): string {
  const abs = resolve(expandHome(dir.trim(), home));
  if (!isAbsolute(expandHome(dir.trim(), home)) || /\p{Cc}/u.test(abs)) {
    throw new Error('--artifacts must be an absolute path or start with ~/');
  }
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    throw new Error(`--artifacts ${abs}: no such folder`);
  }
  const inside = roots.some((r) => {
    let root = r;
    try {
      root = realpathSync(r);
    } catch {
      return false;
    }
    return within(pathKey(real), pathKey(root));
  });
  if (!inside) {
    throw new Error(
      roots.length === 0
        ? `--artifacts ${abs}: no research_roots granted yet; the owner grants one with studio research install`
        : `--artifacts ${abs} is not below a granted research_roots entry (${roots.join(', ')})`,
    );
  }
  return real;
}

/** How the owner can be asked right now: a terminal with a line reader, or nobody. */
export interface Asker {
  isTerminal: boolean;
  readLine?: (prompt: string) => Promise<string | undefined>;
  say?: (line: string) => void;
}

const isYes = (a: string | undefined): boolean | undefined => {
  const v = a?.trim().toLowerCase();
  if (v === undefined) return undefined;
  if (v === '' || v === 'y' || v === 'yes') return true;
  if (v === 'n' || v === 'no') return false;
  return undefined;
};

/** The line the lead gets when nobody can be asked. */
export const installNeededLine = (item: string, needsFolder: boolean): string =>
  `REA install needed for ${item}: the owner confirms once, with the button in the Studio pane${needsFolder ? ` (analysis folder ${DEFAULT_ANALYSIS_DIR})` : ''} or with studio research install in their own terminal`;

/**
 * Makes sure the pinned REA is installed in the mode the owner config asks for. Installed already:
 * nothing happens. Otherwise: never for a crew; a remembered "no" refuses; a remembered "yes"
 * installs; with nobody to ask (no terminal) the lead gets `ReaInstallNeeded`; in a terminal the
 * owner is asked once (and for the analysis folder when the owner config names none), and the
 * answer is remembered for this version. `yes` is the owner's own confirmation, given by command.
 */
export async function ensureRea(o: {
  ownerRoot: string;
  owner: OwnerEnv;
  env: Record<string, string | undefined>;
  ports: Ports;
  asker: Asker;
  now: Date;
  /** The item that needs it, for the lead's line. */
  item?: string;
  /** The owner confirmed by command (`--yes`). */
  yes?: boolean;
  /** The analysis folder the owner named by command (`--folder`). */
  folder?: string;
  uid?: number;
}): Promise<{ installed: boolean; root?: string; version: string; mode: ReaMode }> {
  let ownerConfig = loadOwnerConfig(o.owner);
  const version = reaVersionOf(ownerConfig);
  const mode = reaMode(ownerConfig);
  if (o.env.STUDIO_ROLE === 'crew') {
    throw new Error('REA is installed and confirmed by the owner only, never by a crew');
  }
  const needsFolder = ownerConfig.researchRoots.length === 0;
  let installedNow = true;
  try {
    verifyReaInstall(o.ownerRoot, version, o.uid ?? process.getuid?.(), mode);
    installedNow = false;
  } catch {
    installedNow = true;
  }
  if (!installedNow && !needsFolder && o.folder === undefined) {
    return { installed: false, version, mode };
  }
  // `yes` and `folder` are the owner's own words: only in the owner's terminal.
  if ((o.yes === true || o.folder !== undefined) && !o.asker.isTerminal) {
    throw new Error(
      'studio research install --yes and --folder count only in your own terminal; or confirm with the button in the Studio pane',
    );
  }
  const remembered = readConsentEntry(o.ownerRoot, version, mode);
  let answer: Answer | undefined = o.yes === true ? 'yes' : remembered?.answer;
  // A folder confirmed with the pane's button counts like one named in the terminal.
  let folder = o.folder ?? (needsFolder && answer === 'yes' ? remembered?.folder : undefined);
  const canAsk = o.asker.isTerminal && o.asker.readLine !== undefined;
  if (installedNow && answer === undefined) {
    if (!canAsk)
      throw new ReaInstallNeeded(installNeededLine(o.item ?? 'a researcher item', needsFolder));
    const yes = isYes(await o.asker.readLine?.(consentQuestion(version)));
    answer = yes === true ? 'yes' : 'no';
    recordConsent(o.ownerRoot, version, mode, answer, o.now);
  } else if (o.yes === true) recordConsent(o.ownerRoot, version, mode, 'yes', o.now);
  if (installedNow && answer === 'no') {
    throw new Error(
      `the install of ${REA_PACKAGE} ${version} was declined; studio research install --yes installs it`,
    );
  }
  let root: string | undefined;
  if (needsFolder || folder !== undefined) {
    if (folder === undefined) {
      if (!canAsk)
        throw new ReaInstallNeeded(installNeededLine(o.item ?? 'a researcher item', true));
      folder = (await o.asker.readLine?.(FOLDER_QUESTION))?.trim() || DEFAULT_ANALYSIS_DIR;
    }
    root = addResearchRoot(o.owner, folder);
    ownerConfig = loadOwnerConfig(o.owner);
    o.asker.say?.(`research_roots: ${root}`);
  }
  if (installedNow) {
    if (o.ports.npm === undefined) throw new Error('npm is not available here; nothing installed');
    o.asker.say?.(
      `installing ${REA_PACKAGE} ${version} (${mode === 'full' ? 'trust mode, full' : 'strict mode, static tools'}) ...`,
    );
    await installRea({
      ownerRoot: o.ownerRoot,
      version,
      npm: o.ports.npm,
      path: o.env.PATH ?? '/usr/bin:/bin',
      now: o.now,
      full: mode === 'full',
    });
  }
  return { installed: installedNow, ...(root === undefined ? {} : { root }), version, mode };
}

/**
 * The trust-mode notice, once per owner: true the first time (and records it), false after. A
 * record that cannot be written shows it again next time, never fails a launch.
 */
export function trustNoticeDue(ownerRoot: string, now: Date): boolean {
  const file = join(ownerRoot, TRUST_NOTICE_FILE);
  try {
    lstatSync(file);
    return false;
  } catch {
    try {
      ensureStateDir(ownerRoot, ownerRoot);
      writeStateFile(ownerRoot, file, `${JSON.stringify({ shownAt: now.toISOString() })}\n`);
    } catch {
      // shown again next time
    }
    return true;
  }
}
