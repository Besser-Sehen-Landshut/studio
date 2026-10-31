import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkItem } from './board.js';
import { CREDENTIAL_PATHS, type StudioConfig, toolchainPathProblem } from './config.js';
import { DEFAULT_SECRET_GLOBS } from './guard.js';
import type { Ports } from './ports.js';

export const crewName = (item: WorkItem): string => `studio-${item.role}-${item.id.toLowerCase()}`;

/** Studio's state directory below a project (briefs, settings, guard contexts, logs, crew.json). */
export const stateDirOf = (projectDir: string): string => join(projectDir, '.studio', 'state');

const GUARD_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'studio-guard.mjs');

let tmpCounter = 0;

function writeFileAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${tmpCounter++}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

const ITEM_ID_RE = /^[A-Z]+-\d+$/;

/** Item ids end up in paths and branch names: refuse anything but the board's id shape. */
function assertItemId(id: string): void {
  if (!ITEM_ID_RE.test(id)) throw new Error(`invalid item id: ${JSON.stringify(id)}`);
}

/**
 * Rule (D4): the control room never runs git inside a crew clone once a crew has run in it.
 * A crew-controlled `.git/config` (core.fsmonitor, hooks, ...) would execute in the owner's
 * context. Git touches the clone only at preparation time; afterwards we read files (the branch
 * from `.git/HEAD`, the report) or ask `gh`.
 */

/** Branch of a clone, read from `.git/HEAD` as a plain file; undefined when it is no clone. */
function cloneBranch(path: string): string | undefined {
  try {
    const head = readFileSync(join(path, '.git', 'HEAD'), 'utf8').trim();
    return /^ref: refs\/heads\/(.+)$/.exec(head)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Gives an item its own blob-less clone `<stateDir>/clones/<id>` on branch `studio/<id>` from
 * `origin/main`. No `git worktree` on the owner's repository: its shared git dir would be writable
 * by the crew. Idempotent: a clone already on that branch is returned untouched; anything else in
 * that place is removed and cloned again.
 */
export async function prepareCheckout(
  projectDir: string,
  item: WorkItem,
  ports: Ports,
): Promise<{ path: string; branch: string }> {
  assertItemId(item.id);
  assertSafeState(projectDir);
  const path = join(stateDirOf(projectDir), 'clones', item.id);
  const branch = `studio/${item.id}`;
  if (cloneBranch(path) === branch) return { path, branch };
  rmSync(path, { recursive: true, force: true });
  mkdirSync(dirname(path), { recursive: true });
  const url = (await ports.git.run(projectDir, ['remote', 'get-url', 'origin'])).trim();
  await ports.git.run(dirname(path), ['clone', '--filter=blob:none', url, path]);
  await ports.git.run(path, ['checkout', '-b', branch, 'origin/main']);
  return { path, branch };
}

/**
 * Writes `name` into `homeDir` without following a planted link: the parent must resolve to a
 * place under the real path of `homeDir`, and the file is created with `wx` (fails on any
 * existing entry, a symlink included).
 */
export function writeHomeFile(homeDir: string, name: string, content: string): void {
  const target = join(homeDir, name);
  const realHome = realpathSync(homeDir);
  const parent = realpathSync(dirname(target));
  if (parent !== realHome && !parent.startsWith(realHome + sep)) {
    throw new Error(`refusing to write outside the crew home: ${target}`);
  }
  writeFileSync(join(parent, basename(target)), content, { flag: 'wx' });
}

/** Home and environment of the launcher; injectable so tests never touch the real ones. */
export interface LauncherEnv {
  homedir?: string;
  env?: Record<string, string | undefined>;
}

const within = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent + sep);

/** Resolved variants of a path (literal and, when it exists, its realpath). */
function variants(p: string): string[] {
  const out = [resolve(p)];
  try {
    out.push(realpathSync(p));
  } catch {
    // does not exist: the literal path is all there is
  }
  return out;
}

/**
 * Fails closed on toolchain read paths that would open credentials or the owner's project: the
 * config check (home, credential locations) is repeated with the launcher's home and env extras,
 * and a path that is the project directory or one of its parents is refused.
 */
function assertToolchainPaths(
  paths: string[],
  home: string,
  extraCredentialPaths: string[],
  projectDir?: string,
): void {
  const projects = projectDir ? variants(projectDir) : [];
  for (const path of paths) {
    const problem = toolchainPathProblem(path, home, extraCredentialPaths);
    if (problem) throw new Error(`crew_toolchain_paths: ${path}: ${problem}`);
    if (variants(path).some((v) => projects.some((pr) => within(pr, v)))) {
      throw new Error(
        `crew_toolchain_paths: ${path}: must not be the project directory or a parent`,
      );
    }
  }
}

/**
 * Refuses a state directory that is, or sits behind, a symlink (a merged PR could commit `.studio`
 * as a link) before anything below it is deleted or written.
 */
function assertSafeState(projectDir: string): void {
  const state = stateDirOf(projectDir);
  for (const p of [
    join(projectDir, '.studio'),
    state,
    join(state, 'clones'),
    join(state, 'homes'),
    join(state, 'tmp'),
  ]) {
    let link = false;
    try {
      link = lstatSync(p).isSymbolicLink();
    } catch {
      continue; // does not exist yet
    }
    if (link) throw new Error(`refusing to use ${p}: it is a symlink`);
  }
  try {
    const real = realpathSync(state);
    if (!within(real, realpathSync(projectDir))) {
      throw new Error(`refusing to use ${state}: it resolves outside the project`);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

const list = (xs: string[]): string => (xs.length > 0 ? xs.join(', ') : '(none)');

/** Writes the crew's instructions to `<stateDir>/briefs/<id>.md`. */
export function writeBrief(stateDir: string, item: WorkItem, config: StudioConfig): string {
  assertItemId(item.id);
  const role = config.roles[item.role];
  const skills = role?.skills ?? { required: [], allowed: [], denied: [] };
  const roleFile = join(dirname(stateDir), 'roles', `${item.role}.md`);
  const roleBrief = existsSync(roleFile) ? readFileSync(roleFile, 'utf8').trim() : '';
  const id = item.id;
  const lines = [
    `# Brief for ${id}`,
    '',
    ...(roleBrief ? ['## Role', '', roleBrief, ''] : []),
    '## Item',
    '',
    `- id: ${id}`,
    `- title: ${item.title}`,
    `- type: ${item.type}`,
    `- size: ${item.size}`,
    `- repo: ${item.repo}`,
    `- paths: ${list(item.paths)}`,
    `- touches: ${list(item.touches)}`,
    `- plan: ${item.plan ?? '(none)'}`,
    `- flag: ${item.flag ?? '(none)'}`,
    `- notes: ${list(item.notes ?? [])}`,
    '',
    '## Definition of done',
    '',
    ...(item.dod.length > 0 ? item.dod.map((d) => `- [ ] ${d}`) : ['- (none listed)']),
    '',
    '## Skills',
    '',
    `Invoke these skills first: ${list(skills.required)}`,
    `Allowed skills: ${list(skills.allowed)}`,
    `Denied skills (never invoke): ${list(skills.denied)}`,
    '',
    '## Working rules',
    '',
    '- Work only inside this checkout.',
    '- Test first for code: write a failing test, then the change.',
    '- Stage files by name; never `git add -A` or `git add .`.',
    '- Commit with `git commit -F <message file>` or a literal `-m "..."`; never use `$(...)` inside git or gh commands.',
    `- Push with an explicit refspec: \`git push -u origin HEAD:refs/heads/studio/${id}\`.`,
    `- Open the pull request with \`gh pr create --title "${id}: <summary>" --body-file <file>\`.`,
    '- Git identity and GitHub authentication are preconfigured; do not change git config or log in.',
    '- Never merge, deploy, force-push, or touch secrets.',
    '- If you are blocked: write the report with status blocked and stop. Never wait for an answer.',
    '',
    '## Report contract',
    '',
    `Write \`.studio/reports/${id}.md\` in the checkout and commit it with the pull request.`,
    'It starts with YAML frontmatter:',
    '',
    '```yaml',
    '---',
    'status: done|blocked|failed',
    `item: ${id}`,
    'pr: <number>',
    'head_sha: <40-hex sha of the pushed head commit>',
    'tests_run: <number of tests that ran>',
    'lessons: []',
    'questions: []',
    '---',
    '```',
    '',
    'The body says what changed and how it was verified.',
    '',
  ];
  const file = join(stateDir, 'briefs', `${id}.md`);
  writeFileAtomic(file, lines.join('\n'));
  return file;
}

/**
 * Writes the per-session Claude Code settings file and the guard context it points to.
 * Keys verified against the Claude Code docs (2.1.314):
 *  - https://code.claude.com/docs/en/settings         (`--settings`, `env`, `disableAllHooks`)
 *  - https://code.claude.com/docs/en/sandboxing       (`sandbox.*`, `strictAllowlist`)
 *  - https://code.claude.com/docs/en/hooks            (PreToolUse, deny in every permission mode)
 *  - https://code.claude.com/docs/en/settings-reference
 * `permissions.defaultMode: bypassPermissions` is ignored from settings files, so launchCrew passes
 * `--permission-mode bypassPermissions` on the command line. The crew token is never written here.
 */
export function writeCrewSettings(
  stateDir: string,
  item: WorkItem,
  clone: string,
  config: StudioConfig,
  dirs: { homeDir: string; tmpDir: string },
  launcher: LauncherEnv = {},
): string {
  assertItemId(item.id);
  const id = item.id;
  const realHome = launcher.homedir ?? homedir();
  const env = launcher.env ?? process.env;
  const extraSecret: string[] = [];
  if (env.GH_CONFIG_DIR) extraSecret.push(env.GH_CONFIG_DIR);
  if (env.XDG_CONFIG_HOME) {
    extraSecret.push(
      join(env.XDG_CONFIG_HOME, 'gh'),
      join(env.XDG_CONFIG_HOME, 'git', 'credentials'),
    );
  }
  const credentialPaths = [...CREDENTIAL_PATHS.map((p) => join(realHome, p)), ...extraSecret];
  assertToolchainPaths(config.crewToolchainPaths, realHome, extraSecret);
  // Sandbox reads: the whole real home is denied, then only these are let back in: the clone, the
  // crew tmp dir, the crew HOME and the configured crew_toolchain_paths. Nothing is derived from
  // PATH. Credential locations stay listed explicitly as a second net.
  const denyRead = [realHome, ...credentialPaths];
  const allowRead = [clone, dirs.tmpDir, dirs.homeDir, ...config.crewToolchainPaths];
  const ctxFile = join(stateDir, 'guard', `${id}.json`);
  const ctx = {
    worktree: clone,
    ownerOnly: config.ownerOnly,
    deployCommands: config.deployCommands,
    // Absolute credential locations of the real home, on top of the default globs.
    secretGlobs: [...DEFAULT_SECRET_GLOBS, ...credentialPaths.flatMap((p) => [p, `${p}/**`])],
    crewAllowedWorkflows: config.crewAllowedWorkflows,
    crewAllowedWorkflowRefs: config.crewAllowedWorkflowRefs,
    protectedPaths: [ctxFile, stateDir],
  };
  writeFileAtomic(ctxFile, `${JSON.stringify(ctx, null, 2)}\n`);
  const settings = {
    env: {
      STUDIO_ROLE: 'crew',
      STUDIO_ITEM: id,
      STUDIO_PROJECT: config.primaryRepo,
      STUDIO_GUARD_CTX: ctxFile,
      STUDIO_STATE_DIR: stateDir,
    },
    disableAllHooks: false,
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `node "${GUARD_BIN}"` }] }],
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: [clone, dirs.tmpDir, dirs.homeDir],
        denyRead,
        allowRead,
      },
      network: { allowedDomains: config.sandbox.networkAllow, strictAllowlist: true },
    },
  };
  const file = join(stateDir, 'settings', `${id}.json`);
  writeFileAtomic(file, `${JSON.stringify(settings, null, 2)}\n`);
  return file;
}

const GITCONFIG = `[user]
\tname = Studio Crew
\temail = crew@studio.invalid
[credential "https://github.com"]
\thelper =
\thelper = !gh auth git-credential
`;

const BASE_ENV = ['PATH', 'LANG', 'TERM', 'USER'] as const;
const PASS_THROUGH_ENV = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const;

export interface CrewRecord {
  name: string;
  item: string;
  role: string;
  pid: number;
  log: string;
  startedAt: string;
}

function readCrewFile(file: string): Record<string, CrewRecord> {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, CrewRecord>;
  } catch {
    return {};
  }
}

// Updates of crew.json are serialised in-process; the unique temp name of writeFileAtomic keeps
// concurrent writers from different processes from clobbering each other's temp file.
let crewFileChain: Promise<void> = Promise.resolve();

function updateCrewFile(
  file: string,
  mutate: (all: Record<string, CrewRecord>) => void,
): Promise<void> {
  const run = crewFileChain.then(() => {
    const all = readCrewFile(file);
    mutate(all);
    writeFileAtomic(file, `${JSON.stringify(all, null, 2)}\n`);
  });
  crewFileChain = run.catch(() => {});
  return run;
}

export async function launchCrew(
  projectDir: string,
  item: WorkItem,
  config: StudioConfig,
  ports: Ports,
  launcher: LauncherEnv = {},
): Promise<{ name: string; pid: number; log: string }> {
  assertItemId(item.id);
  const penv = launcher.env ?? process.env;
  const role = config.roles[item.role];
  if (!role) throw new Error(`role ${item.role} is not configured`);
  // Fail closed: without the least-privilege token the session would fall back to ambient
  // credentials, so that needs an explicit opt-in.
  let token: string | undefined;
  if (config.crewToken) token = penv[config.crewToken.env] || undefined;
  if (!token && !config.allowAmbientCredentials) {
    throw new Error(
      config.crewToken
        ? `crew token variable ${config.crewToken.env} is not set; refusing to launch without the least-privilege token (or set allow_ambient_credentials: true)`
        : 'crew_token is not configured; refusing to launch without a least-privilege token (or set allow_ambient_credentials: true)',
    );
  }
  assertToolchainPaths(config.crewToolchainPaths, launcher.homedir ?? homedir(), [], projectDir);
  assertSafeState(projectDir);
  const stateDir = stateDirOf(projectDir);
  const wt = await prepareCheckout(projectDir, item, ports);
  // Isolated HOME, recreated from scratch on every launch: only a git identity and a credential
  // helper that reads GH_TOKEN. Nothing is copied or linked from the real home.
  const homeDir = join(stateDir, 'homes', item.id);
  rmSync(homeDir, { recursive: true, force: true });
  mkdirSync(homeDir, { recursive: true });
  writeHomeFile(homeDir, '.gitconfig', GITCONFIG);
  const tmpDir = join(stateDir, 'tmp', item.id);
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  const brief = writeBrief(stateDir, item, config);
  const settings = writeCrewSettings(
    stateDir,
    item,
    wt.path,
    config,
    { homeDir, tmpDir },
    launcher,
  );
  const settingsEnv = (
    JSON.parse(readFileSync(settings, 'utf8')) as { env: Record<string, string> }
  ).env;
  const env: Record<string, string> = {};
  for (const k of BASE_ENV) {
    const v = penv[k];
    if (v !== undefined) env[k] = v;
  }
  env.HOME = homeDir;
  env.TMPDIR = tmpDir;
  // The Claude login and plugins live in the config dir; it holds no gh or git credentials.
  env.CLAUDE_CONFIG_DIR = penv.CLAUDE_CONFIG_DIR || join(launcher.homedir ?? homedir(), '.claude');
  for (const k of PASS_THROUGH_ENV) {
    const v = penv[k];
    if (v) env[k] = v;
  }
  Object.assign(env, settingsEnv);
  if (token) env.GH_TOKEN = token;
  const log = join(stateDir, 'logs', `${item.id}.jsonl`);
  mkdirSync(dirname(log), { recursive: true });
  const { pid } = await ports.claude.start(
    wt.path,
    [
      '-p',
      '--settings',
      settings,
      '--model',
      role.model,
      '--permission-mode',
      'bypassPermissions',
      '--output-format',
      'stream-json',
      '--verbose',
    ],
    `Read ${brief} and follow it.`,
    log,
    env,
  );
  const name = crewName(item);
  const record: CrewRecord = {
    name,
    item: item.id,
    role: item.role,
    pid,
    log,
    startedAt: ports.clock.now().toISOString(),
  };
  await updateCrewFile(join(stateDir, 'crew.json'), (all) => {
    all[item.id] = record;
  });
  return { name, pid, log };
}

/** Session id of a crew run (first `system` event of its stream-json log), for `--resume`. */
export function crewSessionId(stateDir: string, id: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(stateDir, 'logs', `${id}.jsonl`), 'utf8');
  } catch {
    return undefined;
  }
  for (const line of text.split('\n')) {
    try {
      const ev = JSON.parse(line) as { type?: unknown; session_id?: unknown };
      if (ev.type === 'system' && typeof ev.session_id === 'string') return ev.session_id;
    } catch {
      // not a JSON line (stderr noise)
    }
  }
  return undefined;
}
