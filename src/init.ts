import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { boardPath, parseBoard } from './board.js';
import { withTimeout } from './capacity.js';
import { type ComponentConfig, globProblem, type OwnerEnv, parseConfig } from './config.js';
import { installCommand, type LeadKind, leadKind, leadMachineProblem } from './lead-machine.js';
import type { Ports } from './ports.js';
import { doctorReport } from './secret-command.js';
import { proposeCi } from './setup-ci.js';
import { detectCi, safe, snakeKeys } from './setup-ci-command.js';
import { detectStacks, MONOREPO_DIRS } from './stack.js';
import { detectPlatform } from './worker-deny.js';

/** One line of the prerequisites list: a failure blocks `--write`, a warning never does. */
export type Check = {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  detail: string;
  fix?: string;
};

const MIN_NODE_MAJOR = 24;
const GH_TIMEOUT_MS = 15_000;
const CLAUDE_TIMEOUT_MS = 10_000;
const MANIFESTS = ['package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml'];
const TOOLING_DIRS = ['.github', 'tooling', 'scripts'];
const MAX_ENTRIES = 200;
/** A folder name that is a glob of itself and a one-line component name. */
const PLAIN_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const COMPONENT_ID_MAX = 32;

/** Hosts a crew needs for the package managers of these manifests, besides GitHub. */
const REGISTRY_HOSTS: Record<string, string[]> = {
  'package.json': ['registry.npmjs.org'],
  'Cargo.toml': ['crates.io', 'index.crates.io', 'static.crates.io'],
  'go.mod': ['proxy.golang.org', 'sum.golang.org'],
  'pyproject.toml': ['pypi.org', 'files.pythonhosted.org'],
};

/** Hosts the detected stacks commonly need, where that is clear. */
const STACK_HOSTS: Record<string, string[]> = {
  docker: ['registry-1.docker.io', 'auth.docker.io', 'production.cloudflare.docker.com'],
  rust: ['crates.io', 'index.crates.io', 'static.crates.io'],
};

const PLUGIN_INSTALL = [
  '/plugin marketplace add Besser-Sehen-Landshut/studio',
  '/plugin install studio@studio-marketplace',
];
const SUPERPOWERS_INSTALL =
  '/plugin marketplace add obra/superpowers-marketplace, then /plugin install superpowers@superpowers-marketplace';

const isRealDir = (path: string): boolean => {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
};

const isRealFile = (path: string): boolean => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};

const exists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** `owner/name` of a GitHub remote URL (https, ssh or scp form); undefined for anything else. */
export function githubRepoOf(url: string): string | undefined {
  const m =
    /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
      url.trim(),
    );
  if (!m) return undefined;
  const [, owner = '', name = ''] = m;
  if ([owner, name].some((p) => p === '.' || p === '..')) return undefined;
  return `${owner}/${name}`;
}

/** A component id from a folder name: lower case, dashes, starting with a letter, at most 32. */
function componentId(name: string, root: string, taken: Set<string>): string {
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!/^[a-z]/.test(base)) base = `${root.replace(/s$/, '')}-${base}`.replace(/-$/, '');
  base = base.slice(0, COMPONENT_ID_MAX).replace(/-$/, '');
  let id = base;
  for (let i = 2; taken.has(id); i++) {
    const suffix = `-${i}`;
    id = `${base.slice(0, COMPONENT_ID_MAX - suffix.length).replace(/-$/, '')}${suffix}`;
  }
  taken.add(id);
  return id;
}

/**
 * Components from a monorepo layout: one per direct child of `apps`, `packages`, `services`,
 * `crates` and `libs` that holds a manifest, plus `tooling` for `.github`, `tooling` and `scripts`
 * when there is at least one. A single-package repo gets none. Never follows a link.
 */
export function proposeComponents(
  project: string,
  repo: string,
): { components: ComponentConfig[]; manifests: string[]; notes: string[] } {
  const components: ComponentConfig[] = [];
  const manifests = new Set(MANIFESTS.filter((m) => isRealFile(join(project, m))));
  const notes: string[] = [];
  const taken = new Set<string>();
  for (const root of MONOREPO_DIRS) {
    const base = join(project, root);
    if (!isRealDir(base)) continue;
    let names: string[];
    try {
      names = readdirSync(base).sort().slice(0, MAX_ENTRIES);
    } catch {
      notes.push(`${root}: cannot be read`);
      continue;
    }
    for (const name of names) {
      if (name.startsWith('.') || name === 'node_modules' || !isRealDir(join(base, name))) continue;
      const found = MANIFESTS.filter((m) => isRealFile(join(base, name, m)));
      if (found.length === 0) continue;
      if (!PLAIN_NAME.test(name)) {
        notes.push(`${root}/${safe(name)}: name needs quoting in a glob, add it by hand`);
        continue;
      }
      for (const m of found) manifests.add(m);
      components.push({
        id: componentId(name, root, taken),
        name,
        repo,
        paths: [`${root}/${name}/**`],
      });
    }
  }
  const tooling = TOOLING_DIRS.filter((d) => isRealDir(join(project, d)));
  if (components.length > 0 && tooling.length > 0) {
    components.push({
      id: componentId('tooling', 'tooling', taken),
      name: 'Tooling',
      repo,
      paths: tooling.map((d) => `${d}/**`),
    });
  }
  for (const c of components) {
    for (const g of c.paths) {
      const problem = globProblem(g);
      if (problem !== undefined) throw new Error(`component ${c.id}: ${problem}`);
    }
  }
  return { components, manifests: [...manifests], notes };
}

const BOARD_TEXT = (
  prefix: string,
  repo: string,
) => `# The Studio board: one entry per work item, in the order you like.
# Add one with: studio add "<title>" --type fix --dod "<what done means>"
# The lead (skill studio:studio-lead, running studio tick) moves items from ready to merged.
#
# Fields of an item:
#   id        PREFIX-<n>, unique
#   title     one line
#   type      feature | fix | chore | docs | research (review items are added by Studio)
#   role      builder (reviewer for reviews)
#   repo      owner/name, one of repos in studio.yaml
#   size      S | M | L
#   priority  a lower number goes first
#   status    ready for new work
#   paths     globs of the files the item is about; touches: globs it changes
#   dod       the Definition of Done, at least one line
#   plan      a plan file; a feature needs one before it is planned
#
# Example:
# items:
#   - id: ${prefix}-1
#     title: Add a health endpoint
#     type: fix
#     role: builder
#     repo: ${repo}
#     size: S
#     priority: 1
#     status: ready
#     paths: ["src/health/**"]
#     touches: ["src/health/**"]
#     depends_on: []
#     dod: ["GET /health returns 200", "test added"]
#     history: []
items: []
`;

/** The id prefix of a repository's items: the letters of its name, upper case. */
export function prefixOf(repo: string): string {
  const letters = (repo.split('/').at(-1) ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  return letters.slice(0, 8) || 'ITEM';
}

/** A port call under a timeout: a hang or a throw becomes a non-zero code with the reason. */
async function bounded(
  work: () => Promise<{ code: number }>,
  ms: number,
  what: string,
): Promise<{ code: number; why?: string }> {
  try {
    return await withTimeout(work(), ms, what);
  } catch (e) {
    return { code: 1, why: (e as Error).message };
  }
}

/** `gh` installed and logged in to github.com; `studio setup` asks the same. */
export async function ghCheck(ports: Ports, ghMs = GH_TIMEOUT_MS): Promise<Check> {
  const gh = (args: string[]) => () => ports.gh.run(args, { timeoutMs: ghMs });
  const ghVersion = await bounded(gh(['--version']), ghMs, 'gh --version');
  if (ghVersion.code !== 0) {
    return {
      name: 'gh',
      status: 'fail',
      detail: ghVersion.why ?? 'not found',
      fix: 'install the GitHub CLI (https://cli.github.com), then gh auth login',
    };
  }
  // Only github.com: a stale login to another host must not fail a healthy one.
  const auth = await bounded(
    gh(['auth', 'status', '--hostname', 'github.com']),
    ghMs,
    'gh auth status',
  );
  return auth.code === 0
    ? { name: 'gh', status: 'pass', detail: 'logged in to github.com' }
    : {
        name: 'gh',
        status: 'fail',
        detail: auth.why ?? 'not logged in to github.com',
        fix: 'gh auth login --hostname github.com',
      };
}

async function prerequisites(o: InitOptions): Promise<Check[]> {
  const checks: Check[] = [];
  const ghMs = o.timeouts?.ghMs ?? GH_TIMEOUT_MS;
  const claudeMs = o.timeouts?.claudeMs ?? CLAUDE_TIMEOUT_MS;
  const doctor = await doctorReport(o);
  const r = doctor.report;
  // The install commands of this machine, for every fix below.
  const kind: LeadKind =
    o.platform === 'darwin'
      ? 'macos'
      : o.platform === 'win32'
        ? 'windows'
        : o.platform === undefined || o.platform === 'linux'
          ? leadKind(detectPlatform())
          : 'other';
  checks.push(
    doctor.gitOk
      ? { name: 'git', status: 'pass', detail: r.git }
      : {
          name: 'git',
          status: 'fail',
          detail: r.git,
          fix: `git 2.38 or newer: ${installCommand('git', kind)}`,
        },
  );
  checks.push(await ghCheck(o.ports, ghMs));
  const env = { PATH: o.env.PATH ?? '', HOME: o.owner.homedir ?? '' };
  const plugins = o.ports.plugins;
  const claude = plugins
    ? await bounded(
        () => plugins.run(['--version'], env, o.project, { timeoutMs: claudeMs }),
        claudeMs,
        'claude --version',
      )
    : { code: 1 };
  checks.push(
    claude.code === 0
      ? { name: 'claude', status: 'pass', detail: 'Claude Code CLI found' }
      : {
          name: 'claude',
          status: 'fail',
          detail: claude.why ?? 'the claude CLI does not run',
          fix: `install Claude Code so that claude is on PATH: ${installCommand('claude', kind)}`,
        },
  );
  const node = o.nodeVersion ?? process.versions.node;
  const major = Number(node.split('.')[0]);
  checks.push(
    major >= MIN_NODE_MAJOR
      ? { name: 'node', status: 'pass', detail: node }
      : {
          name: 'node',
          status: 'fail',
          detail: `${node} (too old)`,
          fix: `Node.js ${MIN_NODE_MAJOR} or newer: ${installCommand('node', kind)}`,
        },
  );
  const platform = o.platform ?? process.platform;
  checks.push(
    platform === 'darwin' || platform === 'linux'
      ? { name: 'sandbox', status: 'pass', detail: `supported on ${platform}` }
      : {
          name: 'sandbox',
          status: 'fail',
          detail: `Claude Code's sandbox does not run on ${platform}`,
          fix:
            leadMachineProblem(kind, o.env)?.fix ?? 'run the control room on macOS, Linux or WSL2',
        },
  );
  checks.push(
    r.crewToken.status === 'set'
      ? { name: 'crew token', status: 'pass', detail: `set (${r.crewToken.source})` }
      : {
          name: 'crew token',
          status: 'warn',
          detail: r.crewToken.status,
          fix: 'in your own terminal: studio setup (or studio secret set crew-token; a least-privilege token, see README)',
        },
  );
  const loginReady = r.credentialProvider !== null || r.accounts.length > 0;
  checks.push(
    loginReady
      ? { name: 'claude account', status: 'pass', detail: r.claudeLogin }
      : {
          name: 'claude account',
          status: 'warn',
          detail: `none stored; crews would use ${r.claudeLogin}`,
          fix: 'in your own terminal: studio setup (or claude setup-token, then studio account add <label>)',
        },
  );
  if (r.superpowers === 'not found') {
    checks.push({
      name: 'superpowers',
      status: 'warn',
      detail: 'not installed: feature and fix items need its skills',
      fix: `in Claude Code: ${SUPERPOWERS_INSTALL}`,
    });
  }
  return checks;
}

export type InitOptions = {
  project: string;
  ports: Ports;
  owner: OwnerEnv;
  env: Record<string, string | undefined>;
  json: boolean;
  write: boolean;
  stdout(s: string): void;
  /** Injectable for tests; default the running Node.js and platform. */
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  /** Per call: gh 15 s, claude 10 s by default. */
  timeouts?: { ghMs?: number; claudeMs?: number };
  /** Creates one file and never overwrites; injectable so tests can fail a write. */
  writeFile?: (path: string, text: string) => void;
  /** The roles the proposal holds; default a builder and a reviewer. */
  roles?: Record<string, unknown>;
  /** The plugin's `bin/studio`, named for a terminal where `studio` is not on PATH. */
  launcher?: string;
};

const DEFAULT_ROLES = { builder: { model: 'sonnet', wip: 2 }, reviewer: { model: 'opus', wip: 1 } };
const CI_UNREAD_COMMENT = '# runners could not be read; run studio setup ci';

/** The files a project's `.studio/` holds that `init` writes, relative to the project. */
const STUDIO_FILES = ['.studio/studio.yaml', '.studio/board.yaml'];
/** What goes into the repository: the config and the role files; the board stays on the lead machine. */
const COMMITTED = ['.studio/studio.yaml', '.studio/roles/builder.md'];
export const BOARD_IGNORE = '/.studio/board.yaml';
const BOARD_IGNORE_TEXT = `# Studio: the board is lead-machine state; studio roadmap --write writes the shareable ROADMAP.md\n${BOARD_IGNORE}\n`;

/**
 * Adds the board to the project's `.gitignore` (created when missing), so Studio's edits of the
 * working-tree board never show as changes. Refuses a `.gitignore` that is a link or no file.
 */
function ignoreBoard(project: string): void {
  const file = join(project, '.gitignore');
  let text = '';
  if (exists(file)) {
    const st = lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error('.gitignore is not a plain file');
    text = readFileSync(file, 'utf8');
  }
  if (text.split(/\r?\n/).some((l) => l.trim() === BOARD_IGNORE)) return;
  const sep = text === '' || text.endsWith('\n') ? '' : '\n';
  writeFileSync(file, `${text}${sep}${text === '' ? '' : '\n'}${BOARD_IGNORE_TEXT}`);
}

async function isIgnored(o: InitOptions, file: string): Promise<boolean> {
  try {
    await o.ports.git.run(o.project, ['check-ignore', '-q', '--', file]);
    return true;
  } catch {
    return false;
  }
}

/** The steps still to do: what a check found done is left out. */
function nextSteps(
  prefix: string,
  written: boolean,
  checks: Check[],
  launcher: string | undefined,
): string[] {
  const open = (name: string) => checks.some((c) => c.name === name && c.status !== 'pass');
  const notFound =
    launcher === undefined
      ? ''
      : ` If studio is not found there: node '${launcher.replace(/'/g, `'\\''`)}' setup --link`;
  return [
    ...(open('ci')
      ? [
          'Studio could not read your CI runners: run studio setup ci (with --write) to fix the ci: block.',
        ]
      : []),
    ...(written ? [] : ['Run studio init --write to write the two files.']),
    'Commit .studio/studio.yaml and .gitignore. The board (.studio/board.yaml) stays on this machine and is not committed; studio roadmap --write writes ROADMAP.md to share.',
    ...(open('crew token') || open('claude account')
      ? [
          `In your own terminal, run studio setup once: it stores the crew token and a Claude account for the crews, one guided step each.${notFound}`,
        ]
      : []),
    ...(open('superpowers') ? [`In Claude Code, install superpowers: ${SUPERPOWERS_INSTALL}`] : []),
    `In Claude Code, install the Studio plugin if it is not yet: ${PLUGIN_INSTALL.join(', then ')}; then restart Claude Code in this folder. The board comes with the plugin.`,
    'Open the board pane with /studio.',
    `Add a first item: in Claude Code run /studio:add and say what you need, or run studio add "Add a health endpoint" --type fix --dod "GET /health returns 200" (it gets the id ${prefix}-1)`,
    'In a Claude Code session in this folder say: run the Studio lead loop (skill studio:studio-lead). It runs studio tick every few minutes.',
  ];
}

/**
 * Creates `.studio` when missing and each file exclusively (`wx`). When a write fails, the files
 * this call created are removed again, and so is a `.studio` it created, so nothing half is left.
 */
function writeBoth(o: InitOptions, dir: string, files: [string, string][]): void {
  const write = o.writeFile ?? ((path, text) => writeFileSync(path, text, { flag: 'wx' }));
  const madeDir = !exists(dir);
  if (madeDir) mkdirSync(dir);
  // Checked again after the mkdir: a link put there meanwhile is refused, never written through.
  if (!isRealDir(dir)) throw new Error('.studio is not a directory: nothing written');
  const done: string[] = [];
  try {
    for (const [path, text] of files) {
      write(path, text);
      done.push(path);
    }
  } catch (e) {
    for (const path of done) rmSync(path, { force: true });
    if (madeDir) rmdirSync(dir);
    throw e;
  }
}

/** `studio init [--write]`: checks, proposes and (with --write) writes `.studio/`. */
export async function runInit(o: InitOptions): Promise<number> {
  const dotStudio = join(o.project, '.studio');
  if (exists(dotStudio) && !isRealDir(dotStudio)) {
    throw new Error(
      '.studio is not a directory (a link or a file): nothing written; remove it first',
    );
  }
  const present = STUDIO_FILES.filter((f) => exists(join(o.project, f)));
  if (present.length > 0) {
    throw new Error(
      `${present.join(' and ')} already exists: Studio is set up here, nothing written; edit the file by hand, or use studio setup ci, studio setup stack and studio doctor`,
    );
  }
  const checks = await prerequisites(o);
  const warnings: string[] = [];

  let origin: string | undefined;
  try {
    origin = (await o.ports.git.run(o.project, ['remote', 'get-url', 'origin'])).trim();
  } catch {
    origin = undefined;
  }
  const primary = origin === undefined ? undefined : githubRepoOf(origin);
  if (origin === undefined) {
    checks.push({
      name: 'repository',
      status: 'fail',
      detail: 'not a git checkout with a remote origin',
      fix: 'run studio init in a clone of the GitHub repository (git remote add origin <url>)',
    });
  } else if (primary === undefined) {
    checks.push({
      name: 'repository',
      status: 'fail',
      detail: 'origin is not a GitHub repository',
      fix: 'Studio works with GitHub: set origin to https://github.com/<owner>/<name>.git',
    });
  } else checks.push({ name: 'repository', status: 'pass', detail: primary });

  // studio.yaml and roles/ go into the repository; the board does not (init ignores it).
  const ignored = (
    await Promise.all(COMMITTED.map(async (f) => ((await isIgnored(o, f)) ? f : undefined)))
  ).filter((f) => f !== undefined);
  const boardIgnored = await isIgnored(o, '.studio/board.yaml');
  checks.push(
    ignored.length === 0
      ? {
          name: 'gitignore',
          status: 'pass',
          detail: boardIgnored
            ? '.studio/studio.yaml is not ignored, the board is'
            : `.studio/studio.yaml is not ignored; --write adds ${BOARD_IGNORE} to .gitignore`,
        }
      : {
          name: 'gitignore',
          status: 'warn',
          detail: `${ignored.join(', ')} ignored by git, but studio.yaml and roles/ belong in the repository`,
          fix: `ignore only ${BOARD_IGNORE}, not all of .studio (runtime state lives outside the repository)`,
        },
  );

  const repo = primary ?? 'owner/name';
  const prefix = prefixOf(repo);
  const ghMs = o.timeouts?.ghMs ?? GH_TIMEOUT_MS;
  const ci =
    primary === undefined
      ? undefined
      : await detectCi(o.project, primary, o.ports, undefined, ghMs);
  let ciBlock = ci?.proposal.ci;
  let ciUnread = false;
  if (ci !== undefined) {
    warnings.push(...ci.errors.map((e) => `ci: ${e}`), ...ci.warnings.map((w) => `ci: ${w}`));
    if (ciBlock === undefined || ci.proposal.errors.length > 0) {
      // No usable proposal (runners unreadable, self-hosted on a public repository): start on
      // GitHub-hosted runners, which needs no runner of its own; setup ci can change it later.
      ciBlock = proposeCi({ source: 'none', runners: [] }, ci.visibility).ci;
      ciUnread = ci.detection.source === 'unknown';
      checks.push({
        name: 'ci',
        status: 'warn',
        detail: ciUnread
          ? `runners could not be read (${ci.detection.error ?? 'unknown error'}): GitHub-hosted for now`
          : `no usable proposal (${ci.proposal.errors.join('; ')}): GitHub-hosted for now`,
        fix: 'studio setup ci',
      });
    } else checks.push({ name: 'ci', status: 'pass', detail: `runners: ${ciBlock.runners}` });
  }
  const stacks = detectStacks(o.project);
  const found = proposeComponents(o.project, repo);
  warnings.push(...found.notes.map((n) => `components: ${n}`));
  const networkAllow = [
    'github.com',
    'api.github.com',
    ...new Set([
      ...found.manifests.flatMap((m) => REGISTRY_HOSTS[m] ?? []),
      ...stacks.stacks.flatMap((st) => STACK_HOSTS[st] ?? []),
    ]),
  ];
  const config = {
    studio: 1,
    primary_repo: repo,
    repos: [repo],
    ci: snakeKeys(ciBlock ?? {}),
    merge: { strategy: 'studio-queue', contract_paths: [] },
    roles: o.roles ?? DEFAULT_ROLES,
    stacks: stacks.stacks,
    sandbox: { network_allow: networkAllow },
    owner_only: [],
    deploy_commands: [],
    crew_allowed_workflows: [],
    crew_allowed_workflow_refs: [],
    review_bases: [],
    ...(found.components.length === 0 ? {} : { components: snakeKeys(found.components) }),
  };
  let body = stringify(config, { lineWidth: 0 });
  if (ciUnread) body = body.replace(/^ci:/m, `${CI_UNREAD_COMMENT}\nci:`);
  const configText = `# Studio project settings, written by studio init. See the Studio README for every key.\n${body}`;
  const boardText = BOARD_TEXT(prefix, repo);

  // Proof before writing, in memory: the loaders' own parsing of both texts.
  if (primary !== undefined) {
    try {
      const file = join(dotStudio, 'studio.yaml');
      parseBoard(boardText, boardPath(o.project), parseConfig(configText, file));
      checks.push({ name: 'proposal', status: 'pass', detail: 'both files load' });
    } catch (e) {
      checks.push({
        name: 'proposal',
        status: 'fail',
        detail: `the proposed files would not load: ${(e as Error).message}`,
        fix: 'report this as a Studio bug; write the files by hand meanwhile (README)',
      });
    }
  }

  const failed = checks.filter((c) => c.status === 'fail');
  const written: string[] = [];
  let refused: string | undefined;
  if (o.write) {
    if (failed.length > 0 || ciBlock === undefined) {
      refused = `nothing written: fix ${failed.map((c) => c.name).join(', ') || 'the checks'} first`;
    } else {
      writeBoth(o, dotStudio, [
        [join(dotStudio, 'studio.yaml'), configText],
        [boardPath(o.project), boardText],
      ]);
      written.push(...STUDIO_FILES);
      if (!boardIgnored) {
        try {
          ignoreBoard(o.project);
          written.push('.gitignore');
        } catch (e) {
          warnings.push(
            `gitignore: could not add ${BOARD_IGNORE} (${(e as Error).message}); add it by hand`,
          );
        }
      }
    }
  }
  const steps = nextSteps(prefix, written.length > 0, checks, o.launcher);

  if (o.json) {
    o.stdout(
      `${JSON.stringify(
        {
          checks,
          config,
          board: { items: [] },
          stacks: stacks.stacks,
          warnings: [...warnings, ...stacks.notes.map((n) => `stack: ${n}`)],
          written,
          ...(refused === undefined ? {} : { refused }),
          nextSteps: steps,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    const width = Math.max(...checks.map((c) => c.name.length));
    const lines = ['Checks:'];
    for (const c of checks) {
      const mark = c.status === 'fail' ? 'FAIL' : c.status;
      lines.push(`  ${mark.padEnd(4)}  ${c.name.padEnd(width)}  ${c.detail}`);
      if (c.fix !== undefined && c.status !== 'pass')
        lines.push(`        ${''.padEnd(width)}  fix: ${c.fix}`);
    }
    const allWarnings = [...warnings, ...stacks.notes.map((n) => `stack: ${n}`)];
    if (allWarnings.length > 0) lines.push('Warnings:', ...allWarnings.map((w) => `  - ${w}`));
    lines.push(
      '',
      '.studio/studio.yaml:',
      ...configText
        .trimEnd()
        .split('\n')
        .map((l) => `  ${l}`),
    );
    lines.push(
      '',
      '.studio/board.yaml: an empty board (items: []) with a commented example; it stays on this machine',
      ...(boardIgnored ? [] : [`.gitignore: gets ${BOARD_IGNORE}`]),
      '',
    );
    if (refused !== undefined) lines.push(refused);
    else if (written.length > 0) lines.push(`written: ${written.join(', ')}`);
    else lines.push('dry run: nothing written; run studio init --write to write these files');
    lines.push('', 'Next steps:', ...steps.map((s, i) => `  ${i + 1}. ${s}`));
    o.stdout(`${lines.map(safe).join('\n')}\n`);
  }
  return refused === undefined ? 0 : 1;
}
