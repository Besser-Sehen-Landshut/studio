import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkItem } from './board.js';
import { loadOwnerConfig, type OwnerEnv, type StudioConfig } from './config.js';
import {
  allParkedLine,
  apiBillingProblem,
  checkProviderConfigDir,
  readCrewTokenFile,
  runCredentialProvider,
} from './credentials.js';
import { DEFAULT_SECRET_GLOBS } from './guard.js';
import {
  activeParks,
  DEFAULT_LABEL,
  earliestReset,
  type LimitKind,
  readLimits,
  sessionIdSince,
} from './limits.js';
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
import { readCrewRecords } from './state.js';

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

const GITHUB_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

/**
 * HTTPS clone URL of an item's GitHub repository (`owner/name`). The crew clone's origin always
 * points here, so the crew pushes with its own token through the `gh` credential helper and never
 * through the owner's origin (which may be an ssh URL that the crew HOME cannot use).
 */
export function githubHttpsUrl(repo: string): string {
  const name = repo.split('/')[1];
  if (!GITHUB_REPO_RE.test(repo) || name === '.' || name === '..') {
    throw new Error(`invalid item repo: ${JSON.stringify(repo)}`);
  }
  return `https://github.com/${repo}.git`;
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
 * the project's `origin/main`; the clone's origin is then set to the HTTPS URL of `item.repo`.
 * No `git worktree` on the owner's repository: its shared git dir would be writable by the crew. Idempotent: a clone already on that branch is returned untouched;
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
  const crewOrigin = githubHttpsUrl(item.repo);
  assertStatePath(stateRoot, path);
  const url = await ownerOriginUrl(projectDir, ports);
  if (isLink(path)) removeStateEntry(stateRoot, path);
  // Reuse only a clone on the item branch whose `.git/config` (read as a file) names the item
  // repo's HTTPS origin; anything else is removed and cloned again.
  if (cloneBranch(path) === branch && cloneOriginUrl(path) === crewOrigin) return { path, branch };
  removeStateEntry(stateRoot, path);
  await ports.git.run(clones, ['clone', '--filter=blob:none', url, path]);
  chmodSync(path, 0o700);
  // Still a fresh clone no crew has run in, so git may run here (rule D4).
  await ports.git.run(path, ['remote', 'set-url', 'origin', crewOrigin]);
  await ports.git.run(path, ['checkout', '-b', branch, 'origin/main']);
  return { path, branch };
}

/** Origin URL of the owner's repository (git runs in the owner repo, never in a crew clone). */
async function ownerOriginUrl(projectDir: string, ports: Ports): Promise<string> {
  const url = (await ports.git.run(projectDir, ['remote', 'get-url', 'origin'])).trim();
  if (!url) throw new Error(`project ${projectDir} has no origin URL`);
  return url;
}

/**
 * Deletes `<clone>/.studio/reports/<id>.md` left by an earlier run, so collect can never pick up
 * a stale report. The clone is crew-controlled: every component is checked with lstat, and a
 * symlink on the way (or at the report path) is itself unlinked, never followed.
 */
export function removeOldReport(stateRoot: string, clone: string, id: string): void {
  assertItemId(id);
  let cur = clone;
  for (const seg of ['.studio', 'reports', `${id}.md`]) {
    cur = join(cur, seg);
    assertStatePath(stateRoot, cur);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(cur);
    } catch {
      return; // nothing there
    }
    if (st.isSymbolicLink()) {
      unlinkSync(cur);
      return;
    }
    if (seg === `${id}.md`) {
      removeStateEntry(stateRoot, cur);
      return;
    }
    if (!st.isDirectory()) return; // a file named .studio or reports holds no report
  }
}

function existsNoFollow(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function fileSize(p: string): number {
  try {
    return lstatSync(p).size;
  } catch {
    return 0;
  }
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
  dirs: {
    homeDir: string;
    tmpDir: string;
    projectDir: string;
    toolchainPaths: string[];
    /** Real path of a provider's CLAUDE_CONFIG_DIR. */
    providerConfigDir?: string;
  },
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
  // A provider's login dir is opened for reads on purpose. So the sandbox does not protect that
  // login from crew shell commands; the guard entry below is only a second net for the crew's file
  // tools (see SECURITY.md).
  const loginDir = dirs.providerConfigDir;
  const allowRead = [
    clone,
    dirs.tmpDir,
    dirs.homeDir,
    ...toolchain,
    ...(loginDir === undefined ? [] : [loginDir]),
  ];
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
    secretGlobs: [
      ...DEFAULT_SECRET_GLOBS,
      ...credentialPaths.flatMap((p) => [p, `${p}/**`]),
      ...(loginDir === undefined ? [] : [loginDir, `${loginDir}/**`]),
    ],
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
// An API key would take precedence over CLAUDE_CODE_OAUTH_TOKEN and bill the API, so these pass
// only with allow_api_billing: true in the owner config.
const API_BILLING_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

export interface CrewRecord {
  name: string;
  item: string;
  role: string;
  pid: number;
  log: string;
  startedAt: string;
  /** Set by `studio stop` and when a usage limit stopped the run. */
  stoppedAt?: string;
  /** Label of the credential this run used; the credential itself is never recorded. */
  label?: string;
  /** Config dir of a run in the token form: `--resume` works across labels sharing it. */
  tokenConfigDir?: string;
  /** Size of the log when this run started (the log is appended across runs). */
  logStart?: number;
  /** The run was stopped at a usage limit. */
  limit?: { at: string; kind: LimitKind; sessionId?: string };
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
  if (item.repo !== config.primaryRepo && !config.repos.includes(item.repo)) {
    throw new Error(`repo ${item.repo} is not configured (primary_repo/repos in studio.yaml)`);
  }
  githubHttpsUrl(item.repo);
  // Fail closed: without the least-privilege token the session would fall back to ambient
  // credentials, so that needs an explicit opt-in.
  const home = launcher.homedir ?? homedir();
  const owner: LauncherEnv = {
    homedir: home,
    env: penv,
    platform: launcher.platform,
    uid: launcher.uid,
  };
  let token: string | undefined;
  if (config.crewToken) token = penv[config.crewToken.env] || undefined;
  if (!token) {
    const file = readCrewTokenFile(owner);
    if (file.kind === 'bad') throw new Error(`refusing the crew token file: ${file.why}`);
    if (file.kind === 'ok') token = file.token;
  }
  if (!token && !config.allowAmbientCredentials) {
    throw new Error(
      config.crewToken
        ? `crew token variable ${config.crewToken.env} is not set and there is no crew-token file; refusing to launch without the least-privilege token (run studio secret set crew-token, or set allow_ambient_credentials: true)`
        : 'crew_token is not configured and there is no crew-token file; refusing to launch without a least-privilege token (run studio secret set crew-token, or set allow_ambient_credentials: true)',
    );
  }
  // Refuses a state root inside (or around) the project before anything is created.
  const stateRoot = stateRootFor(projectDir, owner);
  // Everything that can refuse runs before the first side effect.
  const ownerConfig = loadOwnerConfig(owner);
  const toolchainPaths = ownerConfig.crewToolchainPaths;
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
  // Two crews on one item would share the clone and the report: refuse while one still runs.
  // A crew.json that cannot be read refuses too (fail closed).
  const previous = readCrewRecords(stateRoot)[item.id];
  if (previous !== undefined) {
    if (!Number.isInteger(previous.pid) || previous.pid <= 0) {
      throw new Error(`crew record for ${item.id} has no valid pid; refusing to launch`);
    }
    if (ports.claude.alive(previous.pid)) {
      throw new Error(
        `crew ${previous.name} for ${item.id} is still running (pid ${previous.pid}); stop it first`,
      );
    }
  }
  const limits = readLimits(stateRoot);
  if (!limits.ok) {
    throw new Error(`${join(stateRoot, 'limits.json')} is unreadable; refusing to launch`);
  }
  const parks = activeParks(limits.labels, ports.clock.now());
  // The credential, before the first side effect. Provider or not, the value stays in this function
  // and reaches only the environment of the spawned process.
  let label = DEFAULT_LABEL;
  let oauthToken = penv.CLAUDE_CODE_OAUTH_TOKEN || undefined;
  let providerConfigDir: string | undefined;
  const command = ownerConfig.crewCredentialCommand;
  if (command === undefined) {
    if (parks[DEFAULT_LABEL]) {
      throw new Error(allParkedLine(parks[DEFAULT_LABEL].parkedUntil));
    }
  } else {
    const parked = Object.keys(parks);
    const got = await runCredentialProvider(
      command,
      { item: item.id, role: item.role, exclude: parked },
      ports,
      owner,
    );
    if (got === undefined) {
      if (parked.length > 0) throw new Error(allParkedLine(earliestReset(parks)));
      throw new Error('credential provider: returned nothing while no label is parked');
    }
    if (parks[got.label]) throw new Error('credential provider: returned a parked label');
    label = got.label;
    oauthToken = got.token;
    if (got.configDir !== undefined) {
      providerConfigDir = checkProviderConfigDir(got.configDir, owner);
    }
  }
  // The Claude login and plugins live in the config dir; it holds no gh or git credentials.
  const claudeConfigDir = providerConfigDir ?? (penv.CLAUDE_CONFIG_DIR || join(home, '.claude'));
  const billing = apiBillingProblem(
    join(claudeConfigDir, 'settings.json'),
    ownerConfig.allowApiBilling,
  );
  if (billing) throw new Error(billing);
  const clonePath = join(stateRoot, 'clones', item.id);
  // A run stopped at a limit keeps its work: never let prepareCheckout replace that clone.
  if (
    previous?.limit &&
    existsNoFollow(clonePath) &&
    (cloneBranch(clonePath) !== `studio/${item.id}` ||
      cloneOriginUrl(clonePath) !== githubHttpsUrl(item.repo))
  ) {
    throw new Error(
      `the clone of ${item.id} left its branch after a usage limit; refusing to replace it (inspect it, then remove ${clonePath} to start over)`,
    );
  }
  const tokenConfigDir =
    providerConfigDir === undefined && oauthToken !== undefined ? claudeConfigDir : undefined;
  const resumeId = (() => {
    const sessionId = previous?.limit?.sessionId;
    if (sessionId === undefined) return undefined;
    const sameLabel = (previous?.label ?? DEFAULT_LABEL) === label;
    const sameTokenDir =
      tokenConfigDir !== undefined && previous?.tokenConfigDir === tokenConfigDir;
    return sameLabel || sameTokenDir ? sessionId : undefined;
  })();
  // First side effect: bind the state root to this project and origin (or refuse a mismatch).
  checkStateMarker(stateRoot, {
    projectRealpath: projectRealpath(projectDir),
    originUrl: await ownerOriginUrl(projectDir, ports),
  });
  const wt = await prepareCheckout(stateRoot, projectDir, item, ports);
  removeOldReport(stateRoot, wt.path, item.id);
  // The clone's project settings would apply to the crew as well. Read as plain files (rule D4).
  for (const name of ['settings.json', 'settings.local.json']) {
    const problem = apiBillingProblem(
      join(wt.path, '.claude', name),
      ownerConfig.allowApiBilling,
      true,
    );
    if (problem) throw new Error(problem);
  }
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
    { homeDir, tmpDir, projectDir, toolchainPaths, providerConfigDir },
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
  env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  if (oauthToken !== undefined) env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  if (ownerConfig.allowApiBilling) {
    for (const k of API_BILLING_ENV) {
      const v = penv[k];
      if (v) env[k] = v;
    }
  }
  Object.assign(env, settingsEnv);
  if (token) env.GH_TOKEN = token;
  const log = join(stateRoot, 'logs', `${item.id}.jsonl`);
  ensureStateDir(stateRoot, dirname(log));
  const logStart = fileSize(log);
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
      ...(resumeId === undefined ? [] : ['--resume', resumeId]),
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
    label,
    ...(tokenConfigDir === undefined ? {} : { tokenConfigDir }),
    logStart,
  };
  await updateCrewFile(stateRoot, join(stateRoot, 'crew.json'), (all) => {
    all[item.id] = record;
  });
  return { name, pid, log };
}

/** Session id of a crew run (first `system` event of its stream-json log), for `--resume`. */
export function crewSessionId(stateRoot: string, id: string): string | undefined {
  return sessionIdSince(stateRoot, id, 0);
}
