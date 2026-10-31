import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkItem } from './board.js';
import type { StudioConfig } from './config.js';
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

const same = (a: string, b: string): boolean => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
};

/**
 * Creates `<projectDir>/.studio/worktrees/<id>` on branch `studio/<id>` from `origin/main`.
 * Idempotent: a registered worktree of that path on that branch is returned untouched; an existing
 * branch (worktree removed) is checked out again instead of being recreated.
 */
export async function prepareWorktree(
  projectDir: string,
  item: WorkItem,
  ports: Ports,
): Promise<{ path: string; branch: string }> {
  assertItemId(item.id);
  const path = join(projectDir, '.studio', 'worktrees', item.id);
  const branch = `studio/${item.id}`;
  const listing = await ports.git.run(projectDir, ['worktree', 'list', '--porcelain']);
  for (const block of listing.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const wt = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
    const br = lines.find((l) => l.startsWith('branch '))?.slice('branch '.length);
    if (wt && br === `refs/heads/${branch}` && existsSync(wt) && same(wt, path)) {
      return { path, branch };
    }
  }
  await ports.git.run(projectDir, ['fetch', 'origin']);
  await ports.git.run(projectDir, ['worktree', 'prune']);
  let branchExists = true;
  try {
    await ports.git.run(projectDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  } catch {
    branchExists = false;
  }
  await ports.git.run(
    projectDir,
    branchExists
      ? ['worktree', 'add', path, branch]
      : ['worktree', 'add', path, '-b', branch, 'origin/main'],
  );
  return { path, branch };
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
    '- Work only inside this worktree.',
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
    `Write \`.studio/reports/${id}.md\` in the worktree and commit it with the pull request.`,
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
  worktree: string,
  config: StudioConfig,
  dirs: { gitDir: string; commonDir: string; homeDir: string },
): string {
  assertItemId(item.id);
  const id = item.id;
  const realHome = homedir();
  const denyRead = CREDENTIAL_PATHS.map((p) => join(realHome, p));
  const ctxFile = join(stateDir, 'guard', `${id}.json`);
  const ctx = {
    worktree,
    ownerOnly: config.ownerOnly,
    deployCommands: config.deployCommands,
    // Absolute credential locations of the real home, on top of the default globs.
    secretGlobs: [...DEFAULT_SECRET_GLOBS, ...denyRead.flatMap((p) => [p, `${p}/**`])],
    crewAllowedWorkflows: config.crewAllowedWorkflows,
    crewAllowedWorkflowRefs: config.crewAllowedWorkflowRefs,
    protectedPaths: [ctxFile, stateDir, dirs.gitDir, dirs.commonDir],
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
        // commonDir: git writes objects, refs and worktrees/<id> there on commit and push.
        allowWrite: [worktree, tmpdir(), dirs.commonDir, dirs.homeDir],
        denyRead,
      },
      network: { allowedDomains: config.sandbox.networkAllow, strictAllowlist: true },
    },
  };
  const file = join(stateDir, 'settings', `${id}.json`);
  writeFileAtomic(file, `${JSON.stringify(settings, null, 2)}\n`);
  return file;
}

/** Credential locations below the real home that a crew session must never read. */
const CREDENTIAL_PATHS = [
  '.config/gh',
  '.git-credentials',
  '.ssh',
  '.netrc',
  '.gnupg',
  '.aws',
  '.docker/config.json',
  'Library/Keychains',
];

const GITCONFIG = `[user]
\tname = Studio Crew
\temail = crew@studio.invalid
[credential "https://github.com"]
\thelper =
\thelper = !gh auth git-credential
`;

const BASE_ENV = ['PATH', 'LANG', 'TERM', 'USER', 'TMPDIR'] as const;
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
): Promise<{ name: string; pid: number; log: string }> {
  assertItemId(item.id);
  const role = config.roles[item.role];
  if (!role) throw new Error(`role ${item.role} is not configured`);
  // Fail closed: without the least-privilege token the session would fall back to ambient
  // credentials, so that needs an explicit opt-in.
  let token: string | undefined;
  if (config.crewToken) token = process.env[config.crewToken.env] || undefined;
  if (!token && !config.allowAmbientCredentials) {
    throw new Error(
      config.crewToken
        ? `crew token variable ${config.crewToken.env} is not set; refusing to launch without the least-privilege token (or set allow_ambient_credentials: true)`
        : 'crew_token is not configured; refusing to launch without a least-privilege token (or set allow_ambient_credentials: true)',
    );
  }
  const stateDir = stateDirOf(projectDir);
  const wt = await prepareWorktree(projectDir, item, ports);
  const gitDir = resolve(
    wt.path,
    (await ports.git.run(wt.path, ['rev-parse', '--git-dir'])).trim(),
  );
  const commonDir = resolve(
    wt.path,
    (await ports.git.run(wt.path, ['rev-parse', '--git-common-dir'])).trim(),
  );
  // Isolated HOME: only a git identity and a credential helper that reads GH_TOKEN. Nothing is
  // copied or linked from the real home (no gh config, git credential store, ssh keys, netrc).
  const homeDir = join(stateDir, 'homes', item.id);
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(join(homeDir, '.gitconfig'), GITCONFIG);
  const brief = writeBrief(stateDir, item, config);
  const settings = writeCrewSettings(stateDir, item, wt.path, config, {
    gitDir,
    commonDir,
    homeDir,
  });
  const settingsEnv = (
    JSON.parse(readFileSync(settings, 'utf8')) as { env: Record<string, string> }
  ).env;
  const env: Record<string, string> = {};
  for (const k of BASE_ENV) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  env.HOME = homeDir;
  // The Claude login and plugins live in the config dir; it holds no gh or git credentials.
  env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  for (const k of PASS_THROUGH_ENV) {
    const v = process.env[k];
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
