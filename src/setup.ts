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
import { runAccount } from './account-command.js';
import { type OwnerEnv, ownerConfigDir } from './config.js';
import { ghCheck, githubRepoOf } from './init.js';
import { validLabel } from './limits.js';
import { ownerStateRootFor } from './paths.js';
import type { Ports } from './ports.js';
import { doctorReport, readPrimaryRepo, runSecretSet } from './secret-command.js';
import { assertPrimaryRepo, safe } from './setup-ci-command.js';

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
  /** The absolute path of the plugin's `bin/studio`; undefined when it cannot be told. */
  launcher?: string;
  stdout(s: string): void;
  stderr(s: string): void;
};

const DEFAULT_LABEL = 'main';
const MAX_LABEL = 32;

const TOKEN_TEXT = [
  '   Crews push their branches and open pull requests with a GitHub token of their own, never',
  '   with your gh login. Create a fine-grained token on GitHub (Settings, Developer settings,',
  "   Personal access tokens), limited to this project's repositories, with",
  '   contents and pull requests read/write and nothing else (no administration, no workflows).',
  '   Studio checks it once against the repository and stores it with mode 0600; it is never shown.',
  '   The token goes only into the hidden prompt.',
];

const ACCOUNT_TEXT = [
  '   Crews run Claude Code with a token of their own, so your own login stays yours. In another',
  '   terminal tab run: claude setup-token',
  '   It prints a token valid for one year (it needs a Pro, Max, Ultra, Team or Enterprise plan).',
  `   First you type a short label for this account (visible; Enter keeps ${DEFAULT_LABEL}).`,
  '   Then you paste the token at the second prompt (hidden).',
];

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

const SHIM_NOTE =
  '   The shim finds the plugin again after an update; no need to run --link again.';

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

const yes = (answer: string) => /^(|y|yes)$/i.test(answer.trim());

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
async function tokenRepo(o: SetupOptions): Promise<string | undefined> {
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
  o.stdout(
    '   No GitHub repository found here. The next prompt is visible; the token comes after.\n',
  );
  const answer = await o.readLine?.('   Repository the crews work on, as owner/name (visible): ');
  if (answer === undefined) return undefined;
  const repo = answer.trim();
  if (LOOKS_LIKE_TOKEN.test(repo) || repo.length > 100) {
    o.stdout('   that looks like a token — it was not stored; enter owner/name\n');
    return undefined;
  }
  try {
    return assertPrimaryRepo(repo);
  } catch {
    o.stdout('   that is not owner/name; nothing stored\n');
    return undefined;
  }
}

/** The label for `account add`, checked before the hidden prompt; undefined when refused. */
async function accountLabel(o: SetupOptions): Promise<string | undefined> {
  const answer = await o.readLine?.(
    `   Short label for this account, visible (Enter keeps ${DEFAULT_LABEL}) [${DEFAULT_LABEL}]: `,
  );
  if (answer === undefined) return undefined;
  const label = answer.trim() === '' ? DEFAULT_LABEL : answer.trim();
  if (LOOKS_LIKE_TOKEN.test(label) || label.length > MAX_LABEL) {
    o.stdout('   that looks like a token — it was not stored; enter a short label\n');
    return undefined;
  }
  if (!validLabel(label) || label.startsWith('.')) {
    o.stdout(
      '   a label has letters, digits, dot, dash or underscore and does not start with a dot; nothing stored\n',
    );
    return undefined;
  }
  return label;
}

/** Step 4 with --link: a shim in ~/.local/bin when that is on PATH. 1 when it refuses. */
async function link(o: SetupOptions, home: string): Promise<number> {
  const say = (s: string) => o.stdout(`${safe(s)}\n`);
  if (o.launcher === undefined) {
    say('4. studio in your terminal: cannot tell where the plugin is; nothing written');
    return 0;
  }
  const launcher = o.launcher;
  const localBin = join(home, '.local', 'bin');
  const onPath = (o.env.PATH ?? '')
    .split(':')
    .some((d) => d !== '' && resolve(d) === resolve(localBin));
  if (!onPath) {
    say('4. studio in your terminal: ~/.local/bin is not on your PATH.');
    say("   Studio does not edit shell files. Add ~/.local/bin to PATH in your shell's startup");
    say('   file, open a new terminal and run studio setup --link again.');
    say(`   Until then: node ${shQuote(launcher)} <command>`);
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
    writeCache();
    say(`4. studio in your terminal: done (${target})`);
    say(SHIM_NOTE);
    return 0;
  }
  let prompt: string;
  if (current === undefined) prompt = `   Write the Studio shim ${target}? [Y/n] `;
  else if (current.split('\n')[1] === SHIM_MARKER) {
    prompt = `   Update the Studio shim ${target}? [Y/n] `;
  } else {
    say(`4. studio in your terminal: ${target} is not a Studio shim; nothing changed.`);
    say('   Move it away and run studio setup --link again, or keep it.');
    return 1;
  }
  say('4. studio in your terminal:');
  const answer = await o.readLine?.(safe(prompt));
  if (answer === undefined || !yes(answer)) {
    say(`   nothing written; until you do: node ${shQuote(launcher)} <command>`);
    return 0;
  }
  mkdirSync(localBin, { recursive: true });
  writeCache();
  writeAtomic(target, SHIM, 0o755);
  say(`   wrote ${target}`);
  say(SHIM_NOTE);
  return 0;
}

/**
 * `studio setup [--link]`: the owner's one-time setup in a terminal. Each step is skipped when it
 * is done; secrets go through `secret set crew-token` and `account add`, never through here.
 */
export async function runSetup(o: SetupOptions): Promise<number> {
  if (o.env.STUDIO_ROLE === 'crew') throw new Error('this command is not for crew sessions');
  if (!o.isTerminal || o.readSecret === undefined || o.readLine === undefined) {
    throw new Error(
      'studio setup needs your own terminal (it asks for tokens with hidden input); run it there, not inside Claude Code. Nothing changed',
    );
  }
  const say = (s: string) => o.stdout(`${safe(s)}\n`);
  const home = o.owner.homedir ?? homedir();

  const gh = await ghCheck(o.ports);
  if (gh.status !== 'pass') {
    say(`1. GitHub CLI: ${gh.detail}`);
    say(`   Fix: ${gh.fix ?? 'gh auth login'}, then run studio setup again.`);
    return 1;
  }
  say(`1. GitHub CLI: done (${gh.detail})`);

  const { report } = await doctorReport(o);
  if (report.crewToken.status === 'set') {
    say(`2. Crew token: done (${report.crewToken.source ?? 'set'})`);
  } else {
    say(
      `2. Crew token: ${report.crewToken.status === 'invalid' ? 'the stored file is not usable' : 'missing'}`,
    );
    for (const l of TOKEN_TEXT) say(l);
    const repo = await tokenRepo(o);
    if (repo === undefined) return 1;
    const code = await runSecretSet({
      project: o.project,
      ports: o.ports,
      owner: o.owner,
      readSecret: o.readSecret,
      stdout: (s) => o.stdout(`   ${s}`),
      repo,
    });
    if (code !== 0) {
      say('   Nothing stored. Fix the token on GitHub, then run studio setup again.');
      return code;
    }
  }

  if (report.claudeLogin.startsWith('accounts, but')) {
    say(`3. Claude account for crews: ${report.claudeLogin}`);
    say('   Run studio account list and studio doctor to see what is wrong.');
    return 1;
  }
  if (report.credentialProvider !== null || report.accounts.length > 0) {
    say(`3. Claude account for crews: done (${report.claudeLogin})`);
  } else {
    say('3. Claude account for crews: none stored');
    for (const l of ACCOUNT_TEXT) say(l);
    const label = await accountLabel(o);
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
      stdout: (s) => o.stdout(`   ${s}`),
      stderr: o.stderr,
    });
    if (code !== 0) return code;
  }

  if (o.link) {
    const code = await link(o, home);
    if (code !== 0) return code;
  } else {
    const found = studioOnPath(o.env);
    if (found !== undefined) say(`4. studio in your terminal: done (${found})`);
    else {
      say('4. studio in your terminal: not on your PATH (Claude Code finds it on its own).');
      say('   To use studio in any terminal: studio setup --link');
      if (o.launcher !== undefined) {
        say(`   (until then: node ${shQuote(o.launcher)} <command>)`);
      }
    }
  }

  say('');
  say('Done. Now open your project in Claude Code and run /studio:init.');
  return 0;
}
