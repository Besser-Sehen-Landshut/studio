import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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

function writeFileAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
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
  gitDir: string,
): string {
  const id = item.id;
  const ctxFile = join(stateDir, 'guard', `${id}.json`);
  const ctx = {
    worktree,
    ownerOnly: config.ownerOnly,
    deployCommands: config.deployCommands,
    secretGlobs: DEFAULT_SECRET_GLOBS,
    crewAllowedWorkflows: config.crewAllowedWorkflows,
    crewAllowedWorkflowRefs: config.crewAllowedWorkflowRefs,
    protectedPaths: [ctxFile, stateDir, gitDir],
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
      filesystem: { allowWrite: [worktree, tmpdir()] },
      network: { allowedDomains: config.sandbox.networkAllow, strictAllowlist: true },
    },
  };
  const file = join(stateDir, 'settings', `${id}.json`);
  writeFileAtomic(file, `${JSON.stringify(settings, null, 2)}\n`);
  return file;
}

const BASE_ENV = ['PATH', 'HOME', 'LANG', 'TERM', 'USER', 'TMPDIR'] as const;

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

export async function launchCrew(
  projectDir: string,
  item: WorkItem,
  config: StudioConfig,
  ports: Ports,
): Promise<{ name: string; pid: number; log: string }> {
  const role = config.roles[item.role];
  if (!role) throw new Error(`role ${item.role} is not configured`);
  let token: string | undefined;
  if (config.crewToken) {
    token = process.env[config.crewToken.env];
    if (!token) {
      throw new Error(
        `crew token variable ${config.crewToken.env} is not set; refusing to launch without the least-privilege token`,
      );
    }
  }
  const stateDir = stateDirOf(projectDir);
  const wt = await prepareWorktree(projectDir, item, ports);
  const gitDirRaw = await ports.git.run(wt.path, ['rev-parse', '--git-dir']);
  const gitDir = resolve(wt.path, gitDirRaw.trim());
  const brief = writeBrief(stateDir, item, config);
  const settings = writeCrewSettings(stateDir, item, wt.path, config, gitDir);
  const settingsEnv = (
    JSON.parse(readFileSync(settings, 'utf8')) as { env: Record<string, string> }
  ).env;
  const env: Record<string, string> = {};
  for (const k of BASE_ENV) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
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
  const crewFile = join(stateDir, 'crew.json');
  const all = readCrewFile(crewFile);
  all[item.id] = {
    name,
    item: item.id,
    role: item.role,
    pid,
    log,
    startedAt: ports.clock.now().toISOString(),
  };
  writeFileAtomic(crewFile, `${JSON.stringify(all, null, 2)}\n`);
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
