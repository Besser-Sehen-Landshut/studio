import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { boardPath, loadBoard } from './board.js';
import { type ComponentConfig, globProblem, loadConfig, type OwnerEnv } from './config.js';
import type { Ports } from './ports.js';
import { doctorReport } from './secret-command.js';
import { proposeCi } from './setup-ci.js';
import { detectCi, safe, snakeKeys } from './setup-ci-command.js';
import { detectStacks } from './stack.js';

/** One line of the prerequisites list: a failure blocks `--write`, a warning never does. */
export type Check = {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  detail: string;
  fix?: string;
};

const MIN_NODE_MAJOR = 24;
/** Folders whose direct children are the parts of a monorepo. */
const COMPONENT_ROOTS = ['apps', 'packages', 'services', 'crates', 'libs'];
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
  for (const root of COMPONENT_ROOTS) {
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

async function prerequisites(o: InitOptions): Promise<Check[]> {
  const checks: Check[] = [];
  const doctor = await doctorReport(o);
  const r = doctor.report;
  checks.push(
    doctor.gitOk
      ? { name: 'git', status: 'pass', detail: r.git }
      : { name: 'git', status: 'fail', detail: r.git, fix: 'install git 2.38 or newer' },
  );
  const ghVersion = await o.ports.gh.run(['--version']).catch(() => ({ code: 1 }));
  if (ghVersion.code !== 0) {
    checks.push({
      name: 'gh',
      status: 'fail',
      detail: 'not found',
      fix: 'install the GitHub CLI (https://cli.github.com), then gh auth login',
    });
  } else {
    const auth = await o.ports.gh.run(['auth', 'status']).catch(() => ({ code: 1 }));
    checks.push(
      auth.code === 0
        ? { name: 'gh', status: 'pass', detail: 'logged in' }
        : { name: 'gh', status: 'fail', detail: 'not logged in', fix: 'gh auth login' },
    );
  }
  const env = { PATH: o.env.PATH ?? '', HOME: o.owner.homedir ?? '' };
  const claude = o.ports.plugins
    ? await o.ports.plugins.run(['--version'], env, o.project).catch(() => ({ code: 1 }))
    : { code: 1 };
  checks.push(
    claude.code === 0
      ? { name: 'claude', status: 'pass', detail: 'Claude Code CLI found' }
      : {
          name: 'claude',
          status: 'fail',
          detail: 'the claude CLI does not run',
          fix: 'install Claude Code (https://code.claude.com) so that claude is on PATH',
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
          fix: `install Node.js ${MIN_NODE_MAJOR} or newer`,
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
          fix: 'run the control room on macOS, Linux or WSL2',
        },
  );
  checks.push(
    r.crewToken.status === 'set'
      ? { name: 'crew token', status: 'pass', detail: `set (${r.crewToken.source})` }
      : {
          name: 'crew token',
          status: 'warn',
          detail: r.crewToken.status,
          fix: 'after init --write, in a terminal: studio secret set crew-token (a least-privilege token, see README)',
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
          fix: 'in a terminal: claude setup-token, then studio account add <label>',
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
};

/** The files a project's `.studio/` holds that `init` writes, relative to the project. */
const STUDIO_FILES = ['.studio/studio.yaml', '.studio/board.yaml'];

async function isIgnored(o: InitOptions, file: string): Promise<boolean> {
  try {
    await o.ports.git.run(o.project, ['check-ignore', '-q', '--', file]);
    return true;
  } catch {
    return false;
  }
}

function nextSteps(prefix: string, written: boolean): string[] {
  return [
    ...(written ? [] : ['Run studio init --write to write the two files.']),
    'Commit .studio/studio.yaml and .studio/board.yaml.',
    'In a terminal, store the crew token: studio secret set crew-token',
    'In a terminal, add a Claude account for the crews: claude setup-token, then studio account add <label>',
    `In Claude Code, install the Studio plugin if it is not yet: ${PLUGIN_INSTALL.join(', then ')}; then restart Claude Code in this folder. The board comes with the plugin.`,
    'Open the board pane with /studio.',
    `Add a first item: studio add "Add a health endpoint" --type fix --dod "GET /health returns 200" (it gets the id ${prefix}-1)`,
    'In a Claude Code session in this folder say: run the Studio lead loop (skill studio:studio-lead). It runs studio tick every few minutes.',
  ];
}

/** `studio init [--write]`: checks, proposes and (with --write) writes `.studio/`. */
export async function runInit(o: InitOptions): Promise<number> {
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

  const ignored = (
    await Promise.all(STUDIO_FILES.map(async (f) => ((await isIgnored(o, f)) ? f : undefined)))
  ).filter((f) => f !== undefined);
  checks.push(
    ignored.length === 0
      ? { name: 'gitignore', status: 'pass', detail: '.studio/ is not ignored' }
      : {
          name: 'gitignore',
          status: 'warn',
          detail: `${ignored.join(', ')} ignored by git, but they belong in the repository`,
          fix: 'remove .studio from .gitignore (runtime state lives outside the repository)',
        },
  );

  const repo = primary ?? 'owner/name';
  const prefix = prefixOf(repo);
  const ci = primary === undefined ? undefined : await detectCi(o.project, primary, o.ports);
  let ciBlock = ci?.proposal.ci;
  if (ci !== undefined) {
    warnings.push(...ci.errors.map((e) => `ci: ${e}`), ...ci.warnings.map((w) => `ci: ${w}`));
    if (ciBlock === undefined || ci.proposal.errors.length > 0) {
      // No usable proposal (runners unreadable, self-hosted on a public repository): start on
      // GitHub-hosted runners, which needs no runner of its own; setup ci can change it later.
      ciBlock = proposeCi({ source: 'none', runners: [] }, ci.visibility).ci;
      warnings.push('ci: no usable proposal, GitHub-hosted runners for now; run studio setup ci');
    }
  }
  const stacks = detectStacks(o.project);
  const found = proposeComponents(o.project, repo);
  warnings.push(...found.notes.map((n) => `components: ${n}`));
  const networkAllow = [
    'github.com',
    'api.github.com',
    ...new Set(found.manifests.flatMap((m) => REGISTRY_HOSTS[m] ?? [])),
  ];
  const config = {
    studio: 1,
    primary_repo: repo,
    repos: [repo],
    ci: snakeKeys(ciBlock ?? {}),
    merge: { strategy: 'studio-queue', contract_paths: [] },
    roles: { builder: { model: 'sonnet', wip: 2 }, reviewer: { model: 'opus', wip: 1 } },
    stacks: stacks.stacks,
    sandbox: { network_allow: networkAllow },
    owner_only: [],
    deploy_commands: [],
    crew_allowed_workflows: [],
    crew_allowed_workflow_refs: [],
    review_bases: [],
    ...(found.components.length === 0 ? {} : { components: snakeKeys(found.components) }),
  };
  const configText = `# Studio project settings, written by studio init. See the Studio README for every key.\n${stringify(config, { lineWidth: 0 })}`;
  const boardText = BOARD_TEXT(prefix, repo);

  const failed = checks.filter((c) => c.status === 'fail');
  const written: string[] = [];
  let refused: string | undefined;
  if (failed.length === 0 && ciBlock !== undefined) {
    // Proof before writing: the real loaders read both files from a scratch copy.
    const scratch = mkdtempSync(join(tmpdir(), 'studio-init-'));
    try {
      mkdirSync(join(scratch, '.studio'));
      writeFileSync(join(scratch, '.studio', 'studio.yaml'), configText);
      writeFileSync(boardPath(scratch), boardText);
      loadBoard(scratch, loadConfig(scratch));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  if (o.write) {
    if (failed.length > 0 || ciBlock === undefined) {
      refused = `nothing written: fix ${failed.map((c) => c.name).join(', ') || 'the checks'} first`;
    } else {
      mkdirSync(join(o.project, '.studio'), { recursive: true });
      // `wx`: a file that appeared meanwhile is never overwritten.
      writeFileSync(join(o.project, '.studio', 'studio.yaml'), configText, { flag: 'wx' });
      written.push('.studio/studio.yaml');
      writeFileSync(boardPath(o.project), boardText, { flag: 'wx' });
      written.push('.studio/board.yaml');
    }
  }
  const steps = nextSteps(prefix, written.length > 0);

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
    lines.push('', '.studio/board.yaml: an empty board (items: []) with a commented example', '');
    if (refused !== undefined) lines.push(refused);
    else if (written.length > 0) lines.push(`written: ${written.join(', ')}`);
    else lines.push('dry run: nothing written; run studio init --write to write these files');
    lines.push('', 'Next steps:', ...steps.map((s, i) => `  ${i + 1}. ${s}`));
    o.stdout(`${lines.map(safe).join('\n')}\n`);
  }
  return refused === undefined ? 0 : 1;
}
