import { lstatSync, mkdirSync, readlinkSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { runAccount } from './account-command.js';
import type { OwnerEnv } from './config.js';
import { ghCheck, githubRepoOf } from './init.js';
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
  /** Also link `studio` into a folder on the terminal's PATH. */
  link: boolean;
  /** The absolute path of the plugin's `bin/studio`; undefined when it cannot be told. */
  launcher?: string;
  stdout(s: string): void;
  stderr(s: string): void;
};

const DEFAULT_LABEL = 'main';

const TOKEN_TEXT = [
  '   Crews push their branches and open pull requests with a GitHub token of their own, never',
  '   with your gh login. Create a fine-grained token on GitHub (Settings, Developer settings,',
  "   Personal access tokens), limited to this project's repositories, with",
  '   contents and pull requests read/write and nothing else (no administration, no workflows).',
  '   Studio checks it once against the repository and stores it with mode 0600; it is never shown.',
];

const ACCOUNT_TEXT = [
  '   Crews run Claude Code with a token of their own, so your own login stays yours. In another',
  '   terminal tab run: claude setup-token',
  '   It prints a token valid for one year (it needs a Pro, Max, Ultra, Team or Enterprise plan).',
  '   Paste it below; the input is hidden.',
];

const RELINK_NOTE =
  "   The plugin's folder changes with each version: after an update, run studio setup --link again.";

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
  const answer = await o.readLine?.('   Repository the crews work on (owner/name): ');
  if (answer === undefined) return undefined;
  try {
    return assertPrimaryRepo(answer.trim());
  } catch {
    o.stdout('   that is not owner/name; nothing stored\n');
    return undefined;
  }
}

/** Step 4 with --link: a link in ~/.local/bin when that is on PATH, else the line to run. */
async function link(o: SetupOptions, home: string): Promise<void> {
  const say = (s: string) => o.stdout(`${safe(s)}\n`);
  if (o.launcher === undefined) {
    say('4. studio in your terminal: cannot tell where the plugin is; nothing linked');
    return;
  }
  const launcher = o.launcher;
  const localBin = join(home, '.local', 'bin');
  const onPath = (o.env.PATH ?? '')
    .split(':')
    .some((d) => d !== '' && resolve(d) === resolve(localBin));
  const line = (dir: string) => `ln -s ${shQuote(launcher)} ${shQuote(join(dir, 'studio'))}`;
  if (!onPath) {
    say('4. studio in your terminal: ~/.local/bin is not on your PATH.');
    say('   Studio does not edit shell files. Link it into a folder that is on your PATH:');
    say(`     mkdir -p ${shQuote(localBin)} && ${line(localBin)}`);
    say("   and add ~/.local/bin to PATH in your shell's startup file, or use any folder on PATH.");
    say(RELINK_NOTE);
    return;
  }
  const target = join(localBin, 'studio');
  let current: string | undefined;
  let isLink = false;
  try {
    isLink = lstatSync(target).isSymbolicLink();
    current = isLink ? readlinkSync(target) : '';
  } catch {
    current = undefined;
  }
  if (current === launcher) {
    say(`4. studio in your terminal: done (${target})`);
    say(RELINK_NOTE);
    return;
  }
  let prompt: string;
  if (current === undefined) prompt = `   Create the link ${target} -> ${launcher}? [Y/n] `;
  else if (isLink && /\/bin\/studio$/.test(current)) {
    prompt = `   ${target} links to an earlier Studio (${current}). Replace it? [Y/n] `;
  } else {
    say(`4. studio in your terminal: ${target} exists and is not a Studio link; nothing changed.`);
    say(`   To link it elsewhere on your PATH: ${line('<folder>')}`);
    return;
  }
  say('4. studio in your terminal:');
  const answer = await o.readLine?.(safe(prompt));
  if (answer === undefined || !yes(answer)) {
    say(`   nothing linked; to do it yourself: ${line(localBin)}`);
    return;
  }
  mkdirSync(localBin, { recursive: true });
  if (current !== undefined) unlinkSync(target);
  symlinkSync(launcher, target);
  say(`   linked ${target}`);
  say(RELINK_NOTE);
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
    const answer = await o.readLine(`   Label for this account [${DEFAULT_LABEL}]: `);
    if (answer === undefined) return 1;
    const label = answer.trim() === '' ? DEFAULT_LABEL : answer.trim();
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

  if (o.link) await link(o, home);
  else {
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
