import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkItem } from './board.js';
import { loadOwnerConfig, type OwnerEnv, type StudioConfig } from './config.js';
import { DEFAULT_SECRET_GLOBS } from './guard.js';
import {
  assertStatePath,
  canonicalToolchainPaths,
  checkStateMarker,
  cloneOriginUrl,
  credentialLocations,
  ensureStateDir,
  projectRealpath,
  removeStateEntry,
  STATE_FILES,
  STATE_PROTECTED_DIRS,
  stateRootFor,
  writeStateFile,
} from './paths.js';
import type { Ports } from './ports.js';

export const crewName = (item: WorkItem): string => `studio-${item.role}-${item.id.toLowerCase()}`;

export const GUARD_BIN = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'bin',
  'studio-guard.mjs',
);

/**
 * Shell-form hook command for the guard. Exit code 2 blocks the tool call; any other non-zero exit
 * (node missing: 127, script missing: 1) would be a non-blocking error and let the call through,
 * so every failure is mapped to 2 (https://code.claude.com/docs/en/hooks, "Exit code 2").
 */
export function guardHookCommand(bin: string): string {
  // The path is placed between double quotes for `sh -c`: refuse anything the shell would expand.
  if (/["$`\\\n]/.test(bin)) throw new Error(`unsafe guard path: ${JSON.stringify(bin)}`);
  return `node "${bin}" || exit 2`;
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
 * Gives an item its own blob-less clone `<stateRoot>/clones/<id>` on branch `studio/<id>` from
 * the project's `origin/main`. No `git worktree` on the owner's repository: its shared git dir
 * would be writable by the crew. Idempotent: a clone already on that branch is returned untouched;
 * anything else in that place (a symlink included, which is unlinked, not followed) is removed and
 * cloned again.
 */
export async function prepareCheckout(
  stateRoot: string,
  projectDir: string,
  item: WorkItem,
  ports: Ports,
): Promise<{ path: string; branch: string }> {
  assertItemId(item.id);
  const clones = ensureStateDir(stateRoot, join(stateRoot, 'clones'));
  const path = join(clones, item.id);
  const branch = `studio/${item.id}`;
  assertStatePath(stateRoot, path);
  const url = await ownerOriginUrl(projectDir, ports);
  if (isLink(path)) removeStateEntry(stateRoot, path);
  // Reuse only a clone on the item branch whose `.git/config` (read as a file) names the owner
  // repo's origin; anything else is removed and cloned again.
  if (cloneBranch(path) === branch && cloneOriginUrl(path) === url) return { path, branch };
  removeStateEntry(stateRoot, path);
  await ports.git.run(clones, ['clone', '--filter=blob:none', url, path]);
  chmodSync(path, 0o700);
  await ports.git.run(path, ['checkout', '-b', branch, 'origin/main']);
  return { path, branch };
}

/** Origin URL of the owner's repository (git runs in the owner repo, never in a crew clone). */
async function ownerOriginUrl(projectDir: string, ports: Ports): Promise<string> {
  const url = (await ports.git.run(projectDir, ['remote', 'get-url', 'origin'])).trim();
  if (!url) throw new Error(`project ${projectDir} has no origin URL`);
  return url;
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
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

/** Home, environment and platform of the launcher; injectable so tests never touch the real ones. */
export type LauncherEnv = OwnerEnv;

const unique = (xs: string[]): string[] => [...new Set(xs)];

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

const list = (xs: string[]): string => (xs.length > 0 ? xs.join(', ') : '(none)');

/**
 * Writes the crew's instructions to `<stateRoot>/briefs/<id>.md`; the role brief comes from the
 * project's committed `.studio/roles/<role>.md`.
 */
export function writeBrief(
  stateRoot: string,
  item: WorkItem,
  config: StudioConfig,
  projectDir: string,
): string {
  assertItemId(item.id);
  const role = config.roles[item.role];
  const skills = role?.skills ?? { required: [], allowed: [], denied: [] };
  const first = [
    'studio:studio-crew',
    ...skills.required.filter((s) => s !== 'studio:studio-crew'),
  ];
  const roleFile = join(projectDir, '.studio', 'roles', `${item.role}.md`);
  const roleBrief = existsSync(roleFile) ? readFileSync(roleFile, 'utf8').trim() : '';
  const id = item.id;
  const opensPr = item.type !== 'review' && item.type !== 'research';
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
    `Invoke these skills first: ${list(first)}`,
    `Allowed skills: ${list(skills.allowed)}`,
    `Denied skills (never invoke): ${list(skills.denied)}`,
    '',
    '## Working rules',
    '',
    '- Work only inside this checkout.',
    '- Test first for code: write a failing test, then the change.',
    '- Stage files by name; never `git add -A` or `git add .`.',
    '- Commit with `git commit -F <message file>` or a literal `-m "..."`; never use `$(...)` inside git or gh commands.',
    // Review and research items open no PR and push nothing, so their brief carries no push or PR rule.
    ...(opensPr
      ? [
          `- Push with an explicit refspec: \`git push -u origin HEAD:refs/heads/studio/${id}\`.`,
          `- Open the pull request with \`gh pr create --title "${id}: <summary>" --body-file <file>\`.`,
        ]
      : []),
    '- Git identity and GitHub authentication are preconfigured; do not change git config or log in.',
    '- Never merge, deploy, force-push, or touch secrets.',
    "- Run the project's full test command; tests_run is the count from that run. If the command errors or fails, fix it or report status failed — never report a partial count.",
    '- If you are blocked: write the report with status blocked and stop. Never wait for an answer.',
    '',
    '## Report contract',
    '',
    opensPr
      ? `Write \`.studio/reports/${id}.md\` in the checkout as the last step, after pushing; do not commit it. head_sha is the SHA of the pushed head (\`git rev-parse HEAD\`).`
      : `Write \`.studio/reports/${id}.md\` in the checkout as the last step; do not commit it.`,
    'It starts with YAML frontmatter:',
    '',
    '```yaml',
    '---',
    'status: done|blocked|failed',
    `item: ${id}`,
    ...(item.type === 'review'
      ? ['verdict: approve|changes_requested', 'reviews: <repo>#<pr>']
      : item.type === 'research'
        ? []
        : [
            'pr: <number>',
            'head_sha: <40-hex sha of the pushed head commit>',
            'tests_run: <number of tests that ran>',
          ]),
    'lessons: []',
    'questions: []',
    '---',
    '```',
    '',
    ...(item.type === 'review'
      ? [
          'A reviewer opens no pull request: omit pr and head_sha. reviews names the pull request you reviewed.',
          '',
        ]
      : item.type === 'research'
        ? [
            'A research item opens no pull request and pushes nothing: omit pr, head_sha and tests_run. Give the result in the report body.',
            '',
          ]
        : []),
    'The body says what changed and how it was verified.',
    '',
  ];
  const file = join(stateRoot, 'briefs', `${id}.md`);
  writeStateFile(stateRoot, file, lines.join('\n'));
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
  stateRoot: string,
  item: WorkItem,
  clone: string,
  config: StudioConfig,
  dirs: { homeDir: string; tmpDir: string; projectDir: string; toolchainPaths: string[] },
  launcher: LauncherEnv = {},
): string {
  assertItemId(item.id);
  const id = item.id;
  const realHome = launcher.homedir ?? homedir();
  const env = launcher.env ?? process.env;
  const { all: credentialPaths, extra: extraSecret } = credentialLocations(realHome, env);
  const toolchain = canonicalToolchainPaths(dirs.toolchainPaths, {
    home: realHome,
    env,
    platform: launcher.platform,
    projectDir: dirs.projectDir,
    stateRoot,
    extraCredentialPaths: extraSecret,
  });
  // Sandbox reads: the whole real home is denied, then only these are let back in: the clone, the
  // crew tmp dir, the crew HOME and the real paths of the owner's crew_toolchain_paths. Nothing is
  // derived from PATH. Credential locations stay listed explicitly as a second net.
  // The state base (parent of every state root: other projects, other items, settings, logs) is
  // denied too, literal and real spelling, so an XDG_STATE_HOME outside the home is covered.
  const stateBase = dirname(stateRoot);
  const denyRead = unique([realHome, ...credentialPaths, stateBase, realOr(stateBase)]);
  const allowRead = [clone, dirs.tmpDir, dirs.homeDir, ...toolchain];
  const ctxFile = join(stateRoot, 'guard', `${id}.json`);
  // The clone lives inside the state root, so the root itself cannot be protected (the guard
  // would deny every write in the clone). Protected: the ctx file, every fixed state directory and
  // state file. Other items' clones lie outside this clone and are denied by worktree confinement.
  const protectedPaths = [
    ctxFile,
    ...STATE_PROTECTED_DIRS.map((d) => join(stateRoot, d)),
    ...STATE_FILES.map((f) => join(stateRoot, f)),
  ];
  const ctx = {
    worktree: clone,
    ownerOnly: config.ownerOnly,
    deployCommands: config.deployCommands,
    // Absolute credential locations of the real home, on top of the default globs.
    secretGlobs: [...DEFAULT_SECRET_GLOBS, ...credentialPaths.flatMap((p) => [p, `${p}/**`])],
    crewAllowedWorkflows: config.crewAllowedWorkflows,
    crewAllowedWorkflowRefs: config.crewAllowedWorkflowRefs,
    protectedPaths,
  };
  writeStateFile(stateRoot, ctxFile, `${JSON.stringify(ctx, null, 2)}\n`);
  const settings = {
    env: {
      STUDIO_ROLE: 'crew',
      STUDIO_ITEM: id,
      STUDIO_PROJECT: config.primaryRepo,
      STUDIO_GUARD_CTX: ctxFile,
      STUDIO_STATE_DIR: stateRoot,
    },
    disableAllHooks: false,
    // Crew needs neither the web nor MCP servers; the guard denies these tools too.
    // Bare names remove the tool, `mcp__*` every MCP tool (https://code.claude.com/docs/en/permissions).
    permissions: { deny: ['WebFetch', 'WebSearch', 'mcp__*'] },
    hooks: {
      PreToolUse: [
        {
          matcher: '*',
          // onFailure "block" also blocks when the hook cannot start or times out
          // (https://code.claude.com/docs/en/hooks, "Block the action when a hook fails").
          hooks: [{ type: 'command', command: guardHookCommand(GUARD_BIN), onFailure: 'block' }],
        },
      ],
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
  const file = join(stateRoot, 'settings', `${id}.json`);
  writeStateFile(stateRoot, file, `${JSON.stringify(settings, null, 2)}\n`);
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
  /** Set by `studio stop`. */
  stoppedAt?: string;
}

function readCrewFile(file: string): Record<string, CrewRecord> {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, CrewRecord>;
  } catch {
    return {};
  }
}

// Updates of crew.json are serialised in-process; the unique temp name of writeStateFile keeps
// concurrent writers from different processes from clobbering each other's temp file.
let crewFileChain: Promise<void> = Promise.resolve();

function updateCrewFile(
  stateRoot: string,
  file: string,
  mutate: (all: Record<string, CrewRecord>) => void,
): Promise<void> {
  const run = crewFileChain.then(() => {
    const all = readCrewFile(file);
    mutate(all);
    writeStateFile(stateRoot, file, `${JSON.stringify(all, null, 2)}\n`);
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
  const home = launcher.homedir ?? homedir();
  const owner: LauncherEnv = { homedir: home, env: penv, platform: launcher.platform };
  // Refuses a state root inside (or around) the project before anything is created.
  const stateRoot = stateRootFor(projectDir, owner);
  // Everything that can refuse runs before the first side effect.
  const toolchainPaths = loadOwnerConfig(owner).crewToolchainPaths;
  canonicalToolchainPaths(toolchainPaths, {
    home,
    env: penv,
    platform: launcher.platform,
    projectDir,
    stateRoot,
    extraCredentialPaths: credentialLocations(home, penv).extra,
  });
  for (const sub of ['clones', 'homes', 'tmp']) {
    assertStatePath(stateRoot, join(stateRoot, sub, item.id));
  }
  // First side effect: bind the state root to this project and origin (or refuse a mismatch).
  checkStateMarker(stateRoot, {
    projectRealpath: projectRealpath(projectDir),
    originUrl: await ownerOriginUrl(projectDir, ports),
  });
  const wt = await prepareCheckout(stateRoot, projectDir, item, ports);
  // Isolated HOME, recreated from scratch on every launch: only a git identity and a credential
  // helper that reads GH_TOKEN. Nothing is copied or linked from the real home.
  const homeDir = join(stateRoot, 'homes', item.id);
  removeStateEntry(stateRoot, homeDir);
  ensureStateDir(stateRoot, homeDir);
  writeHomeFile(homeDir, '.gitconfig', GITCONFIG);
  const tmpDir = join(stateRoot, 'tmp', item.id);
  removeStateEntry(stateRoot, tmpDir);
  ensureStateDir(stateRoot, tmpDir);
  const brief = writeBrief(stateRoot, item, config, projectDir);
  const settings = writeCrewSettings(
    stateRoot,
    item,
    wt.path,
    config,
    { homeDir, tmpDir, projectDir, toolchainPaths },
    owner,
  );
  // No MCP server at all: --strict-mcp-config ignores every other MCP configuration and the only
  // one given is empty (https://code.claude.com/docs/en/cli-reference).
  const mcpConfig = join(stateRoot, 'settings', `${item.id}.mcp.json`);
  writeStateFile(stateRoot, mcpConfig, `${JSON.stringify({ mcpServers: {} })}\n`);
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
  env.CLAUDE_CONFIG_DIR = penv.CLAUDE_CONFIG_DIR || join(home, '.claude');
  for (const k of PASS_THROUGH_ENV) {
    const v = penv[k];
    if (v) env[k] = v;
  }
  Object.assign(env, settingsEnv);
  if (token) env.GH_TOKEN = token;
  const log = join(stateRoot, 'logs', `${item.id}.jsonl`);
  ensureStateDir(stateRoot, dirname(log));
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
      '--strict-mcp-config',
      '--mcp-config',
      mcpConfig,
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
  await updateCrewFile(stateRoot, join(stateRoot, 'crew.json'), (all) => {
    all[item.id] = record;
  });
  return { name, pid, log };
}

/** Session id of a crew run (first `system` event of its stream-json log), for `--resume`. */
export function crewSessionId(stateRoot: string, id: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(stateRoot, 'logs', `${id}.jsonl`), 'utf8');
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
