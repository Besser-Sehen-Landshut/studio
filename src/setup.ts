import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { SetupStrings } from '../hooks/i18n/index.js';
import { runAccount } from './account-command.js';
import { claudeLanguage } from './claude-language.js';
import { loadOwnerConfig, type OwnerConfig, type OwnerEnv, ownerConfigDir } from './config.js';
import { ghCheck, githubRepoOf } from './init.js';
import {
  installCommand,
  type LeadKind,
  type LeadTool,
  leadKind,
  leadMachineProblem,
  onPath,
  onWindowsDrive,
} from './lead-machine.js';
import { validLabel } from './limits.js';
import { ownerStateRootFor } from './paths.js';
import type { Ports } from './ports.js';
import {
  installNotifySecret,
  type NotifySecret,
  newNtfyTopic,
  pushFailure,
  pushLanguage,
  readNotifySecret,
  sendPush,
  subscribeLink,
  testPushText,
} from './push.js';
import { ensureRea, reaMode, reaVersionOf, recordSetupSkip, setupSkipped } from './rea-consent.js';
import { verifyReaInstall } from './rea-install.js';
import { doctorReport, readPrimaryRepo, runSecretSet } from './secret-command.js';
import { assertPrimaryRepo, safe } from './setup-ci-command.js';
import { setupText } from './setup-text.js';
import { detectPlatform, type WorkerPlatform } from './worker-deny.js';

export type SetupOptions = {
  project: string;
  ports: Ports;
  owner: OwnerEnv;
  env: Record<string, string | undefined>;
  isTerminal: boolean;
  readSecret?: (prompt: string) => Promise<string | undefined>;
  /** A visible line from the terminal; undefined on abort. */
  readLine?: (prompt: string) => Promise<string | undefined>;
  /** Also put a `studio` shim into a folder on the terminal's PATH. */
  link: boolean;
  /** Only the notifications step, also when they are set up already. */
  notifications?: boolean;
  /** The absolute path of the plugin's `bin/studio`; undefined when it cannot be told. */
  launcher?: string;
  /** The machine (tests); detected by default. */
  platform?: WorkerPlatform;
  /** Where a program is on PATH (tests); the PATH of `env` by default. */
  which?: (name: string) => string | undefined;
  /** `--dry-run`: check every step, say what it would ask and store; write and ask nothing. */
  dryRun?: boolean;
  stdout(s: string): void;
  stderr(s: string): void;
};

const DEFAULT_LABEL = 'main';
const MAX_LABEL = 32;

/** Answers at a visible prompt that are tokens pasted at the wrong prompt. */
const LOOKS_LIKE_TOKEN = /^(sk-ant|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)/;

/** Line 2 of a shim `studio setup --link` wrote; a file is ours only with exactly this line. */
export const SHIM_MARKER = '# studio-shim v1';

/** Picks the enabled studio plugin from `claude plugin list --json` on stdin; prints its launcher. */
const PICK = [
  'let s="";process.stdin.on("data",d=>{s+=d}).on("end",()=>{',
  'const fs=require("fs"),p=require("path");let a;',
  'try{a=JSON.parse(s)}catch{const l=s.trim().split("\\n").pop()||"";try{a=JSON.parse(l)}catch{process.exit(1)}}',
  'for(const e of Array.isArray(a)?a:[]){',
  'if(!e||typeof e.id!=="string"||!e.id.startsWith("studio@")||e.enabled!==true)continue;',
  'const r=typeof e.readFromFolder==="string"?e.readFromFolder:e.installPath;',
  'if(typeof r!=="string")continue;const b=p.join(r,"bin","studio");',
  'if(fs.existsSync(b)&&!fs.existsSync(p.join(r,".orphaned_at"))){console.log(b);return}}',
  'process.exit(1)})',
].join('');

/**
 * The shim: a regular file, so a plugin update cannot leave it dangling. It uses the cached launcher
 * while that exists and its plugin folder is not orphaned, else asks `claude plugin list --json`
 * (documented fields `id`, `enabled`, `installPath`, `readFromFolder`) and rewrites the cache.
 */
export const SHIM = `#!/bin/sh
${SHIM_MARKER}
# Written by studio setup --link. Runs the Studio plugin's CLI and finds the plugin again after an
# update. Studio replaces this file only while the line above is unchanged.
case "\${XDG_CONFIG_HOME:-}" in /*) dir="$XDG_CONFIG_HOME/studio" ;; *) dir="$HOME/.config/studio" ;; esac
cache="$dir/launcher"
launcher=""
if [ -f "$cache" ]; then
  launcher=$(cat "$cache")
  root=$(dirname "$(dirname "$launcher")")
  if [ ! -f "$launcher" ] || [ -e "$root/.orphaned_at" ]; then launcher=""; fi
fi
if [ -z "$launcher" ]; then
  if ! command -v claude >/dev/null 2>&1; then
    echo "studio: the claude CLI is not on PATH; it is needed to find the Studio plugin. Install Claude Code, or run node <plugin>/bin/studio" >&2
    exit 127
  fi
  launcher=$(claude plugin list --json 2>/dev/null | node -e '${PICK}') || launcher=""
  if [ -z "$launcher" ]; then
    echo "studio: no enabled studio plugin in claude plugin list; in Claude Code: /plugin install studio@studio-marketplace" >&2
    exit 1
  fi
  { mkdir -p "$dir" && tmp=$(mktemp "$dir/.launcher.XXXXXX") && printf '%s\\n' "$launcher" > "$tmp" && mv -f "$tmp" "$cache"; } 2>/dev/null || true
fi
exec node "$launcher" "$@"
`;

/** One shell word in single quotes. */
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The first executable `studio` on PATH, or undefined. A dangling link does not count. */
function studioOnPath(env: Record<string, string | undefined>): string | undefined {
  for (const dir of (env.PATH ?? '').split(':').filter((d) => d !== '')) {
    const file = join(dir, 'studio');
    try {
      const st = statSync(file);
      if (st.isFile() && (st.mode & 0o111) !== 0) return file;
    } catch {
      // not here
    }
  }
  return undefined;
}

/** Yes at a `[Y/n]` prompt: Enter, y or yes; j or ja for a German one. */
const yes = (answer: string) => /^(|y|yes|j|ja)$/i.test(answer.trim());

/** Writes `text` to `file` through a new temporary file in the same folder and a rename. */
function writeAtomic(file: string, text: string, mode: number): void {
  const tmp = join(dirname(file), `.studio-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, text, { flag: 'wx', mode });
    chmodSync(tmp, mode);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** The repository the crew token is checked against: studio.yaml, then origin, then asked. */
async function tokenRepo(o: SetupOptions, t: SetupStrings): Promise<string | undefined> {
  try {
    return readPrimaryRepo(o.project);
  } catch {
    // no studio.yaml yet: the usual case before init
  }
  try {
    const origin = await o.ports.git.run(o.project, ['remote', 'get-url', 'origin']);
    const repo = githubRepoOf(origin);
    if (repo !== undefined) return repo;
  } catch {
    // not a checkout with origin
  }
  if (o.dryRun === true) return undefined;
  o.stdout(`${t.noRepo}\n`);
  const answer = await o.readLine?.(t.repoPrompt);
  if (answer === undefined) return undefined;
  const repo = answer.trim();
  if (LOOKS_LIKE_TOKEN.test(repo) || repo.length > 100) {
    o.stdout(`${t.repoLooksLikeToken}\n`);
    return undefined;
  }
  try {
    return assertPrimaryRepo(repo);
  } catch {
    o.stdout(`${t.repoNotOwnerName}\n`);
    return undefined;
  }
}

/** The label for `account add`, checked before the hidden prompt; undefined when refused. */
async function accountLabel(o: SetupOptions, t: SetupStrings): Promise<string | undefined> {
  const answer = await o.readLine?.(t.labelPrompt(DEFAULT_LABEL));
  if (answer === undefined) return undefined;
  const label = answer.trim() === '' ? DEFAULT_LABEL : answer.trim();
  if (LOOKS_LIKE_TOKEN.test(label) || label.length > MAX_LABEL) {
    o.stdout(`${t.labelLooksLikeToken}\n`);
    return undefined;
  }
  if (!validLabel(label) || label.startsWith('.')) {
    o.stdout(`${t.labelBad}\n`);
    return undefined;
  }
  return label;
}

/** Step 4 with --link: a shim in ~/.local/bin when that is on PATH. 1 when it refuses. */
async function link(o: SetupOptions, home: string, t: SetupStrings): Promise<number> {
  const say = (s: string) => o.stdout(`${safe(s)}\n`);
  if (o.launcher === undefined) {
    say(t.step(4, t.terminal, t.noPlugin));
    return 0;
  }
  const launcher = o.launcher;
  const run = `node ${shQuote(launcher)} <command>`;
  const localBin = join(home, '.local', 'bin');
  const onPath = (o.env.PATH ?? '')
    .split(':')
    .some((d) => d !== '' && resolve(d) === resolve(localBin));
  if (!onPath) {
    say(t.step(4, t.terminal, t.localBinOff));
    for (const l of t.localBinHelp) say(l);
    say(t.untilThen(run));
    return 0;
  }
  const target = join(localBin, 'studio');
  let current: string | undefined;
  try {
    // A link or a folder is never ours: only a regular file can carry the marker.
    current = lstatSync(target).isFile() ? readFileSync(target, 'utf8') : '';
  } catch {
    current = undefined;
  }
  const cache = join(ownerConfigDir(o.owner), 'launcher');
  const writeCache = () => {
    mkdirSync(dirname(cache), { recursive: true, mode: 0o700 });
    writeAtomic(cache, `${launcher}\n`, 0o600);
  };
  if (current === SHIM) {
    if (o.dryRun !== true) writeCache();
    say(t.step(4, t.terminal, t.done(target)));
    say(t.shimNote);
    return 0;
  }
  let prompt: string;
  if (current === undefined) prompt = t.writePrompt(target);
  else if (current.split('\n')[1] === SHIM_MARKER) {
    prompt = t.updatePrompt(target);
  } else {
    say(t.step(4, t.terminal, t.notAShim(target)));
    say(t.notAShimHelp);
    return 1;
  }
  say(t.stepOpen(4, t.terminal));
  if (o.dryRun === true) {
    say(t.would(`write ${target} and ${cache} (it asks first)`));
    return 0;
  }
  const answer = await o.readLine?.(safe(prompt));
  if (answer === undefined || !yes(answer)) {
    say(t.nothingWritten(run));
    return 0;
  }
  mkdirSync(localBin, { recursive: true });
  writeCache();
  writeAtomic(target, SHIM, 0o755);
  say(t.wrote(target));
  say(t.shimNote);
  return 0;
}

/**
 * Step 6, optional: REA for researcher crews. Done when the pinned version is installed in the mode
 * the owner config asks for and a research root is granted; otherwise offered (`standalone`: asked
 * directly, as `studio setup research`). Runs the same one-time confirmation as a first launch.
 */
export async function researchStep(o: SetupOptions, standalone: boolean): Promise<number> {
  const say = (s: string) => o.stdout(`${safe(s)}\n`);
  if (o.env.STUDIO_ROLE === 'crew') throw new Error('this command is not for crew sessions');
  if (o.dryRun !== true && (!o.isTerminal || o.readLine === undefined)) {
    throw new Error(
      'studio setup research needs your own terminal; without one use studio research install --yes --folder <dir>. Nothing changed',
    );
  }
  const t = setupText(o);
  let config: OwnerConfig;
  try {
    config = loadOwnerConfig(o.owner);
  } catch {
    say(t.step(6, t.research, t.researchConfigBad));
    return 1;
  }
  const ownerRoot = ownerStateRootFor(o.owner);
  const version = reaVersionOf(config);
  const mode = reaMode(config);
  let installed = true;
  try {
    verifyReaInstall(ownerRoot, version, o.owner.uid ?? process.getuid?.(), mode);
  } catch {
    installed = false;
  }
  const modeWord = mode === 'full' ? t.trustMode : t.strictMode;
  if (installed && config.researchRoots.length > 0) {
    say(t.step(6, t.research, t.researchDone(version, modeWord, config.researchRoots.join(', '))));
    return 0;
  }
  if (!standalone && setupSkipped(ownerRoot)) {
    say(t.step(6, t.researchOptional, t.researchSkipped));
    return 0;
  }
  say(t.step(6, t.researchOptional, t.notSetUp));
  if (o.dryRun === true) {
    say(t.would(`offer REA (rea-agents ${version}) for researcher crews; studio setup research`));
    return 0;
  }
  for (const l of t.researchText) say(l);
  const readLine = o.readLine as NonNullable<typeof o.readLine>;
  if (!standalone) {
    const answer = await readLine(t.researchPrompt);
    // Enter is no here: the step is optional.
    if (answer === undefined || !['y', 'yes', 'j', 'ja'].includes(answer.trim().toLowerCase())) {
      // Asked once: setup stays quiet about it from now on.
      recordSetupSkip(ownerRoot, o.ports.clock.now());
      say(t.researchLater);
      return 0;
    }
  }
  try {
    const r = await ensureRea({
      ownerRoot,
      owner: o.owner,
      env: o.env,
      ports: o.ports,
      asker: {
        isTerminal: true,
        readLine: (p) => readLine(`   ${p}`),
        say: (l) => say(`   ${l}`),
      },
      now: o.ports.clock.now(),
    });
    say(t.researchInstalled(r.version, modeWord, r.installed));
    return 0;
  } catch (e) {
    say(`   ${(e as Error).message}`);
    return 1;
  }
}

/**
 * Step 5: push notifications through ntfy, or none. A new random topic, the subscribe link shown
 * once, a test push; the topic is stored only once that push went out. 1 when it fails.
 */
async function notificationsStep(
  o: SetupOptions,
  again: boolean,
  t: SetupStrings,
): Promise<number> {
  const say = (s: string) => o.stdout(`${safe(s)}\n`);
  let config: OwnerConfig;
  try {
    config = loadOwnerConfig(o.owner);
  } catch {
    const [first, ...rest] = t.notifyConfigBad;
    say(t.step(5, t.notifications, first ?? ''));
    for (const l of rest) say(l);
    return 1;
  }
  const stored = readNotifySecret(o.owner);
  if (stored.kind === 'ok' && !again) {
    say(t.step(5, t.notifications, t.done(stored.secret.transport)));
    return 0;
  }
  say(
    t.step(
      5,
      t.notifications,
      t.notifyState(
        stored.kind === 'absent' ? 'none' : stored.kind,
        stored.kind === 'ok' ? stored.secret.transport : '',
      ),
    ),
  );
  if (o.dryRun === true) {
    say(
      t.would(
        'offer push notifications through ntfy: a new secret topic, a test push, then stored',
      ),
    );
    return 0;
  }
  for (const l of t.notifyText) say(l);
  const answer = await o.readLine?.(t.notifyPrompt);
  const choice = answer?.trim().toLowerCase();
  if (choice === undefined || ['none', 'n', 'no', 'nein', 'skip'].includes(choice)) {
    say(t.notifyNone(stored.kind === 'ok'));
    return 0;
  }
  if (choice !== '' && choice !== 'ntfy') {
    say(t.notifyAnswer);
    return 1;
  }
  const http = o.ports.http;
  if (http === undefined) {
    say(t.noHttps);
    return 1;
  }
  const secret: NotifySecret = { transport: 'ntfy', topic: newNtfyTopic() };
  // The one place the topic is shown: the owner's own terminal.
  say(t.notifyOpen);
  say(`   ${subscribeLink(config, secret)}`);
  say(t.notifySecret);
  const ready = await o.readLine?.(t.notifyReady);
  if (ready === undefined || ready.trim().toLowerCase() === 'skip') {
    say(t.notifyLater);
    return 0;
  }
  const reply = await sendPush(http, secret, config, {
    text: testPushText(pushLanguage(config, o.env, claudeLanguage(o.owner, o.project))),
    urgent: false,
  });
  if (!reply.ok) {
    say(t.notifyFailed(pushFailure(reply)));
    return 1;
  }
  installNotifySecret(secret, o.owner);
  say(t.notifySent);
  return 0;
}

const MIN_NODE_MAJOR = 24;

/**
 * Step 0: this machine can run the lead. Native Windows and WSL1 get the command that leads to
 * WSL2; a missing git, claude or a Node.js older than 24 gets its install command for this machine;
 * under WSL2 Studio's own files must lie in the Linux file system. False when setup stops here.
 */
function machineStep(
  o: SetupOptions,
  platform: WorkerPlatform,
  kind: LeadKind,
  t: SetupStrings,
): boolean {
  const say = (s: string) => o.stdout(`${safe(s)}\n`);
  const which = o.which ?? ((name: string) => onPath(name, o.env));
  if (leadMachineProblem(kind, o.env) !== undefined) {
    const [why, fix] =
      kind === 'windows'
        ? [t.windowsWhy, t.windowsFix]
        : kind === 'wsl1'
          ? [t.wsl1Why, t.wsl1Fix(o.env.WSL_DISTRO_NAME ?? '<distribution>')]
          : [t.otherWhy, t.otherFix];
    say(t.step(0, t.machine, why));
    say(t.fix(fix));
    return false;
  }
  const label =
    kind === 'macos'
      ? 'macOS'
      : kind === 'wsl2'
        ? `WSL2 (${o.env.WSL_DISTRO_NAME ?? 'Linux'})`
        : 'Linux';
  const node = process.versions.node;
  const missing: LeadTool[] = [
    ...(which('git') === undefined ? (['git'] as const) : []),
    ...(Number(node.split('.')[0]) < MIN_NODE_MAJOR ? (['node'] as const) : []),
    ...(which('claude') === undefined ? (['claude'] as const) : []),
    ...(kind !== 'macos' && (which('bwrap') === undefined || which('socat') === undefined)
      ? (['sandbox'] as const)
      : []),
  ];
  if (missing.length > 0) {
    const named = missing.map((m) =>
      m === 'node' ? t.nodeOld(MIN_NODE_MAJOR, node) : m === 'sandbox' ? t.sandboxTools : m,
    );
    say(t.step(0, t.machine, t.missing(label, named.join(', '))));
    for (const m of missing) say(t.tool(m, installCommand(m, kind)));
    say(t.newTerminal);
    return false;
  }
  if (kind === 'wsl2') {
    for (const [what, dir] of [
      ['config', ownerConfigDir(o.owner)],
      ['state', ownerStateRootFor(o.owner)],
    ] as const) {
      if (onWindowsDrive(dir, platform)) {
        say(t.step(0, t.machine, t.onWindowsDrive(label, what, dir)));
        say(t.onWindowsDriveFix);
        return false;
      }
    }
  }
  say(t.step(0, t.machine, t.machineDone(label, node)));
  if (kind === 'wsl2' && onWindowsDrive(o.project, platform)) say(t.projectOnWindows(o.project));
  if (which('ssh') === undefined || which('ssh-keygen') === undefined) {
    say(t.sshLater(installCommand('ssh', kind)));
  }
  return true;
}

/**
 * `studio setup [--link] [--notifications] [--dry-run]`: the owner's one-time setup in a terminal.
 * Each step is skipped when it is done; secrets go through `secret set crew-token` and `account
 * add`, never through here. With `--dry-run` it checks every step and says what it would ask and
 * store, and writes, stores and asks nothing.
 */
export async function runSetup(o: SetupOptions): Promise<number> {
  if (o.env.STUDIO_ROLE === 'crew') throw new Error('this command is not for crew sessions');
  const dry = o.dryRun === true;
  if (!dry && (!o.isTerminal || o.readSecret === undefined || o.readLine === undefined)) {
    throw new Error(
      'studio setup needs your own terminal (it asks for tokens with hidden input); run it there, not inside Claude Code (studio setup --dry-run shows the steps anywhere). Nothing changed',
    );
  }
  const t = setupText(o);
  const say = (s: string) => o.stdout(`${safe(s)}\n`);
  const home = o.owner.homedir ?? homedir();
  if (dry) say(t.dryRun);
  if (o.notifications === true) return await notificationsStep(o, true, t);

  const platform = o.platform ?? detectPlatform();
  const kind = leadKind(platform);
  if (!machineStep(o, platform, kind, t)) return 1;

  const gh = await ghCheck(o.ports);
  if (gh.status !== 'pass') {
    say(t.step(1, t.gh, gh.detail));
    const fix = gh.fix?.startsWith('install the GitHub CLI')
      ? t.ghInstall(installCommand('gh', kind))
      : (gh.fix ?? 'gh auth login');
    say(t.ghFix(fix));
    return 1;
  }
  say(t.step(1, t.gh, t.done(gh.detail)));

  const { report } = await doctorReport(o);
  if (report.crewToken.status === 'set') {
    say(t.step(2, t.token, t.done(report.crewToken.source ?? 'set')));
  } else {
    say(t.step(2, t.token, report.crewToken.status === 'invalid' ? t.unusable : t.missingWord));
    if (dry) {
      const repo = await tokenRepo(o, t);
      say(
        t.would(
          `ask for the crew token at a hidden prompt, check it against ${repo ?? '<owner/name, asked first>'} and store it (mode 0600)`,
        ),
      );
    } else {
      for (const l of t.tokenText) say(l);
      const repo = await tokenRepo(o, t);
      if (repo === undefined) return 1;
      const code = await runSecretSet({
        project: o.project,
        ports: o.ports,
        owner: o.owner,
        readSecret: o.readSecret as NonNullable<typeof o.readSecret>,
        stdout: (s) => o.stdout(`   ${s}`),
        repo,
      });
      if (code !== 0) {
        say(t.tokenNothing);
        return code;
      }
    }
  }

  if (report.claudeLogin.startsWith('accounts, but')) {
    say(t.step(3, t.account, report.claudeLogin));
    say(t.accountWrong);
    return 1;
  }
  if (report.credentialProvider !== null || report.accounts.length > 0) {
    say(t.step(3, t.account, t.done(report.claudeLogin)));
  } else {
    say(t.step(3, t.account, t.noneStored));
    if (dry) {
      say(
        t.would(
          `ask for a label (Enter keeps ${DEFAULT_LABEL}) and the token of claude setup-token at a hidden prompt, then store it`,
        ),
      );
    } else {
      for (const l of t.accountText(DEFAULT_LABEL)) say(l);
      const label = await accountLabel(o, t);
      if (label === undefined) return 1;
      const code = await runAccount({
        args: ['add', label],
        owner: o.owner,
        ownerRoot: ownerStateRootFor(o.owner),
        ports: o.ports,
        env: o.env,
        json: false,
        isTerminal: true,
        readSecret: o.readSecret,
        nested: true,
        stdout: (s) => o.stdout(`   ${s}`),
        stderr: o.stderr,
      });
      if (code !== 0) return code;
    }
  }

  if (o.link) {
    const code = await link(o, home, t);
    if (code !== 0) return code;
  } else {
    const found = studioOnPath(o.env);
    if (found !== undefined) say(t.step(4, t.terminal, t.done(found)));
    else {
      say(t.step(4, t.terminal, t.notOnPath));
      say(t.linkHint);
      if (o.launcher !== undefined) say(t.untilParen(`node ${shQuote(o.launcher)} <command>`));
    }
  }

  const notified = await notificationsStep(o, false, t);
  if (notified !== 0) return notified;

  const researched = await researchStep(o, false);
  if (researched !== 0) return researched;

  say('');
  say(dry ? t.dryRun : t.finalNext);
  return 0;
}
