import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { type AccountRow, accountRows, expiryLine } from './account-command.js';
import { builtInAccount, crewClaudeDir } from './accounts.js';
import {
  crewTokenFile,
  loadConfig,
  loadOwnerConfig,
  type OwnerConfig,
  type OwnerEnv,
  type StudioConfig,
  within,
} from './config.js';
import {
  checkProviderConfigDir,
  installCrewToken,
  installWorkerToken,
  readCrewTokenFile,
  runCredentialProvider,
  validToken,
} from './credentials.js';
import { CREW_SKILL, skillInstalled, studioPluginHint } from './crew.js';
import { ownerStateRootFor } from './paths.js';
import { installedVersions, pinnedPlugins, unallowedPlugins } from './plugins.js';
import type { Ports } from './ports.js';
import { readNotifySecret } from './push.js';
import {
  REA_CLASS_NAMES,
  REA_DEFAULT_VERSION,
  REA_KNOWN_TOOLS,
  REA_PACKAGE,
  REA_SERVER,
  REA_SKILL,
  REA_STATIC_TOOLS,
  reaSetupHint,
} from './rea.js';
import { verifyReaInstall } from './rea-install.js';
import { assertPrimaryRepo, safe } from './setup-ci-command.js';

export function readPrimaryRepo(project: string): string {
  const file = join(project, '.studio', 'studio.yaml');
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch {
    throw new Error('cannot read .studio/studio.yaml');
  }
  return assertPrimaryRepo((raw as { primary_repo?: unknown } | null)?.primary_repo);
}

/** The failing permission, or undefined when the token works. Output of `gh` is never shown. */
async function checkToken(token: string, repo: string, ports: Ports): Promise<string | undefined> {
  const call = async (path: string) => {
    try {
      return await ports.credentials.ghWithToken(token, ['api', path]);
    } catch {
      return { code: 1, stdout: '', stderr: '' };
    }
  };
  const info = await call(`/repos/${repo}`);
  if (info.code !== 0) return 'repository read (or GitHub is not reachable)';
  let push: unknown;
  try {
    push = (JSON.parse(info.stdout) as { permissions?: { push?: unknown } }).permissions?.push;
  } catch {
    return 'repository read (unexpected answer)';
  }
  if (push !== true) return 'contents write';
  const pulls = await call(`/repos/${repo}/pulls?per_page=1`);
  return pulls.code === 0 ? undefined : 'pull requests read';
}

/**
 * `studio secret set crew-token`. The value comes only from the hidden prompt, is checked once
 * against GitHub and installed only when that passes. Everything printed is fixed text plus the
 * validated repository name.
 */
export async function runSecretSet(o: {
  project: string;
  ports: Ports;
  owner: OwnerEnv;
  readSecret?: (prompt: string) => Promise<string | undefined>;
  stdout(s: string): void;
  /** The repository to check the token against; default `primary_repo` of studio.yaml. */
  repo?: string;
  /** Which token: the crew's (default) or a worker machine's own (`studio worker`). */
  name?: 'crew-token' | 'worker-token';
}): Promise<number> {
  const repo = o.repo === undefined ? readPrimaryRepo(o.project) : assertPrimaryRepo(o.repo);
  const worker = o.name === 'worker-token';
  const input = o.readSecret
    ? await o.readSecret(worker ? 'Worker token (input hidden): ' : 'Crew token (input hidden): ')
    : undefined;
  if (input === undefined) {
    throw new Error('studio secret set needs a terminal for hidden input; nothing written');
  }
  const token = input.replace(/\s+/g, '');
  if (token === '') throw new Error('empty value; nothing written');
  if (!validToken(token)) throw new Error('the value holds control characters; nothing written');
  const failing = await checkToken(token, repo, o.ports);
  if (failing !== undefined) {
    o.stdout(`failing permission: ${failing}\n`);
    return 1;
  }
  if (worker) {
    // The worker's own identity must never be what a crew gets.
    const crew = readCrewTokenFile(o.owner);
    if (crew.kind === 'ok' && crew.token === token) {
      throw new Error('the worker token must differ from the crew token; nothing written');
    }
    installWorkerToken(token, o.owner);
  } else installCrewToken(token, o.owner);
  o.stdout(`valid for ${repo}\n`);
  return 0;
}

const API_KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

/** The config dir a crew would get; undefined when a provider cannot say. Its token is dropped. */
async function crewConfigDir(
  command: string | undefined,
  owner: OwnerEnv,
  env: Record<string, string | undefined>,
  ports: Ports,
): Promise<string | undefined> {
  const fallback = env.CLAUDE_CONFIG_DIR || join(owner.homedir ?? homedir(), '.claude');
  if (command === undefined) return fallback;
  try {
    // No item: a probe, which a provider does not count as use.
    const got = await runCredentialProvider(
      command,
      { item: '', role: '', exclude: [] },
      ports,
      owner,
    );
    if (got === undefined) return undefined;
    return got.configDir === undefined
      ? crewClaudeDir(owner)
      : checkProviderConfigDir(got.configDir, owner);
  } catch {
    return undefined;
  }
}

/** The merge check compares trees with `git merge-tree --write-tree`, new in git 2.38. */
async function gitState(project: string, ports: Ports): Promise<string> {
  try {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(await ports.git.run(project, ['--version']));
    if (!m) return 'cannot tell';
    const enough = Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 38);
    return enough
      ? (m[0] as string)
      : `${m[0]} (too old: 2.38 or newer is needed to accept a merged base)`;
  } catch {
    return 'cannot tell';
  }
}

const CHECKOUT_OK = 'git checkout with origin';
/** A version doctor found new enough: digits only, no note after it. */
const GIT_OK = /^\d+\.\d+\.\d+$/;

/** A launch needs the project folder to be a git checkout with `origin`. */
async function checkoutState(project: string, ports: Ports): Promise<string> {
  try {
    await ports.git.run(project, ['rev-parse', '--show-toplevel']);
  } catch {
    return 'not a git checkout: clone the repository and run studio in that clone';
  }
  try {
    await ports.git.run(project, ['remote', 'get-url', 'origin']);
  } catch {
    return 'no remote origin: add it with git remote add origin <url>';
  }
  return CHECKOUT_OK;
}

const CREW_TOOLS = ['cargo', 'rustc', 'rustup', 'node', 'pnpm', 'npm', 'gh', 'git'];

/**
 * Tools on PATH that lie below the home but outside `crew_toolchain_paths`: the sandbox denies the
 * home, so crews cannot run them.
 */
function toolsOutside(
  env: Record<string, string | undefined>,
  home: string,
  toolchain: string[],
): string[] {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const realHome = real(home);
  const open = toolchain.map(real);
  const out: string[] = [];
  for (const tool of CREW_TOOLS) {
    for (const dir of (env.PATH ?? '').split(':').filter((d) => d !== '')) {
      const file = join(dir, tool);
      try {
        if (!statSync(file).isFile()) continue;
      } catch {
        continue;
      }
      const at = real(file);
      if (within(at, realHome) && !open.some((t) => within(at, t) || within(file, t))) {
        out.push(`${tool} lies at ${file}, outside crew_toolchain_paths: crews cannot run it`);
      }
      break;
    }
  }
  return out;
}

/** The stored push transport by name: never the topic. */
function notificationsState(owner: OwnerEnv): 'ntfy' | 'none' | 'invalid' {
  const read = readNotifySecret(owner);
  return read.kind === 'ok' ? read.secret.transport : read.kind === 'absent' ? 'none' : 'invalid';
}

/** Whether a skill a crew needs is in that config dir. */
function skillState(dir: string | undefined, name: string): string {
  const found = dir === undefined ? undefined : skillInstalled(dir, name);
  return found === undefined ? 'cannot tell' : found ? 'installed' : 'not found';
}

/**
 * REA for the researcher (src/rea.ts), as far as the owner can check it: which server version
 * crews run and whether it is installed and matches its recorded integrity, whether the project's
 * analysis directory is one the owner allows, the skill in the crew config dir, and whether the
 * server registered there is the pinned one. Names and states, never a path or a value. Null when
 * nothing asks for REA.
 */
export function reaState(
  config: StudioConfig | undefined,
  ownerConfig: OwnerConfig | undefined,
  configDir: string | undefined,
  ownerRoot?: string,
) {
  const roots = ownerConfig?.researchRoots ?? [];
  if (config?.research === undefined && roots.length === 0) return null;
  const version = ownerConfig?.reaVersion ?? REA_DEFAULT_VERSION;
  let installed = 'cannot tell';
  let entry: string | undefined;
  if (ownerRoot !== undefined) {
    try {
      const got = verifyReaInstall(
        ownerRoot,
        version,
        process.getuid?.(),
        ownerConfig?.research.trust === false ? 'static' : 'full',
      );
      entry = got.entry;
      installed = `yes (${got.integrity.slice(0, 19)}...)`;
    } catch (e) {
      installed = `no: ${(e as Error).message.replace(/^[^:]*: /, '').replace(/; .*$/, '')}; it installs on first use after one confirmation (or studio research install)`;
    }
  }
  let artifacts: string;
  if (config?.research === undefined) artifacts = 'not set in studio.yaml (research.artifacts)';
  else if (roots.length === 0) artifacts = 'refused: no research_roots in the owner config';
  else {
    try {
      const real = realpathSync(config.research.artifacts);
      if (!statSync(real).isDirectory()) artifacts = 'refused: not a directory';
      else {
        const inside = roots.some((r) => {
          try {
            return within(real, realpathSync(r));
          } catch {
            return false;
          }
        });
        artifacts = inside ? 'allowed' : 'refused: not below a research_roots entry';
      }
    } catch {
      artifacts = 'refused: does not exist';
    }
  }
  // What the crew config dir's own registration says; a launch writes its own server entry, so a
  // stale one there is only a sign that REA's setup ran for another version.
  let registered = 'not registered';
  if (configDir !== undefined) {
    try {
      const raw = JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf8')) as {
        mcpServers?: Record<string, { args?: unknown }>;
      };
      const args = raw.mcpServers?.[REA_SERVER]?.args;
      const at = Array.isArray(args)
        ? args.find((a) => typeof a === 'string' && a.startsWith(`${REA_PACKAGE}@`))
        : undefined;
      if (typeof at === 'string') {
        const v = at.slice(REA_PACKAGE.length + 1);
        registered =
          v === version
            ? `${version} (the pin)`
            : `${v.replace(/[^\w.+-]/g, '?').slice(0, 40)} (not the pin)`;
      }
    } catch {
      registered = 'cannot tell';
    }
  }
  return {
    server: `${REA_PACKAGE}@${version}`,
    pinnedBy: ownerConfig?.reaVersion === undefined ? 'Studio default' : 'owner config',
    // Trust mode (default): every class, full install. Strict: per-item classes, static install.
    mode: ownerConfig?.research.trust === false ? 'strict' : 'trust',
    installed,
    analysisDirectory: artifacts,
    skill: skillState(configDir, REA_SKILL),
    registeredInCrewConfig: registered,
    engineEnvironment: Object.keys(ownerConfig?.reaEnv ?? {}).sort(),
    staticTools: REA_STATIC_TOOLS.length,
    deniedByDefault: REA_KNOWN_TOOLS.length - REA_STATIC_TOOLS.length,
    classes: [...REA_CLASS_NAMES],
    setup: configDir === undefined ? null : reaSetupHint(configDir, entry),
  };
}

/** The line `doctor` warns with while git tracks the board, which is lead-machine state. */
export const BOARD_TRACKED_LINE =
  'warning: .studio/board.yaml is tracked by git, but the board is lead-machine state that Studio edits in the working tree: run git rm --cached .studio/board.yaml, add /.studio/board.yaml to .gitignore and commit both; studio roadmap --write writes the shareable ROADMAP.md';

/** Whether git tracks the board: `yes`, `no`, or `unknown` when git cannot tell (no checkout). */
async function boardTrackedState(project: string, ports: Ports): Promise<'yes' | 'no' | 'unknown'> {
  try {
    const out = await ports.git.run(project, ['ls-files', '--', '.studio/board.yaml']);
    return out.trim() === '' ? 'no' : 'yes';
  } catch {
    return 'unknown';
  }
}

export type DoctorReport = Awaited<ReturnType<typeof doctorReport>>;

/** What `studio doctor` finds, without printing; `studio init` reads the same checks. */
export async function doctorReport(o: {
  project: string;
  owner: OwnerEnv;
  env: Record<string, string | undefined>;
  ports: Ports;
}) {
  let config: StudioConfig | undefined;
  try {
    config = loadConfig(o.project);
  } catch {
    config = undefined;
  }
  let ownerConfig: OwnerConfig | undefined;
  try {
    ownerConfig = loadOwnerConfig(o.owner);
  } catch {
    ownerConfig = undefined;
  }
  const envName = config?.crewToken?.env;
  let crewToken: { status: 'set' | 'missing' | 'invalid'; source?: string };
  if (envName && o.env[envName]) crewToken = { status: 'set', source: `env ${envName}` };
  else {
    const file = readCrewTokenFile(o.owner);
    if (file.kind === 'ok') crewToken = { status: 'set', source: 'file' };
    else if (file.kind === 'bad') crewToken = { status: 'invalid', source: 'file' };
    else crewToken = { status: 'missing' };
  }
  const required = !(config?.allowAmbientCredentials ?? false);
  const command = ownerConfig?.crewCredentialCommand;
  let accounts: AccountRow[] = [];
  let accountProblem: string | undefined;
  let account: string | undefined;
  try {
    accounts = accountRows({
      owner: o.owner,
      ownerRoot: ownerStateRootFor(o.owner),
      ports: o.ports,
    });
    account = builtInAccount(o.owner, o.ports.clock.now())?.label;
  } catch (e) {
    accountProblem = (e as Error).message;
  }
  // The way a crew logs in to Claude, in the order a launch tries them.
  let claudeLogin: string;
  if (command !== undefined) {
    claudeLogin = `credential provider${accounts.length > 0 ? ' (it comes before the accounts)' : ''}`;
  } else if (accountProblem !== undefined) {
    claudeLogin = `accounts, but a launch refuses: ${accountProblem}`;
  } else if (account !== undefined) {
    claudeLogin = `account ${account}`;
  } else if (o.env.CLAUDE_CODE_OAUTH_TOKEN) {
    claudeLogin = 'CLAUDE_CODE_OAUTH_TOKEN from the environment';
  } else {
    claudeLogin = 'main login (~/.claude or CLAUDE_CONFIG_DIR)';
  }
  const configDir =
    command === undefined && account !== undefined
      ? crewClaudeDir(o.owner)
      : await crewConfigDir(command, o.owner, o.env, o.ports);
  const studioCrew = skillState(configDir, CREW_SKILL.split(':').at(-1) ?? '');
  // Pinned against what Claude Code recorded in the crew's config dir.
  const have = configDir === undefined ? undefined : installedVersions(configDir);
  let pinProblem: string | undefined;
  let pins: ReturnType<typeof pinnedPlugins> = [];
  try {
    pins = pinnedPlugins(config?.plugins, ownerConfig?.allowedPlugins ?? []);
  } catch (e) {
    pinProblem = (e as Error).message;
  }
  const plugins = pins.map((p) => ({
    name: p.name,
    pinned: p.version,
    installed: have === undefined ? 'unknown' : (have.get(p.name) ?? 'not installed'),
  }));
  const pluginsNotAllowed = unallowedPlugins(config?.plugins, ownerConfig?.allowedPlugins ?? []);
  const git = await gitState(o.project, o.ports);
  const projectCheckout = await checkoutState(o.project, o.ports);
  const boardTracked = await boardTrackedState(o.project, o.ports);
  const toolchain = toolsOutside(
    o.env,
    o.owner.homedir ?? homedir(),
    ownerConfig?.crewToolchainPaths ?? [],
  );
  const report = {
    claudeLogin,
    projectCheckout,
    boardTracked,
    toolchainOutside: toolchain,
    accounts,
    git,
    crewToken: { ...crewToken, required },
    crewTokenFile: crewTokenFile(o.owner),
    studioYaml: config ? 'readable' : 'not readable',
    stacks: config?.stacks ?? null,
    // The foundation builders need: feature and fix items require its skills.
    superpowers: skillState(configDir, 'test-driven-development'),
    studioCrew,
    plugins,
    ...(pinProblem === undefined ? {} : { pluginProblem: pinProblem }),
    pluginsNotAllowed,
    ownerConfig: ownerConfig ? 'readable' : 'invalid',
    credentialProvider: ownerConfig?.crewCredentialCommand ?? null,
    allowApiBilling: ownerConfig?.allowApiBilling ?? false,
    rea: reaState(config, ownerConfig, configDir, ownerStateRootFor(o.owner)),
    notify: ownerConfig?.notify?.command ? 'configured' : 'not configured',
    notifications: notificationsState(o.owner),
    apiKeyVarsInEnvironment: API_KEY_VARS.filter((k) => o.env[k]),
  };
  return {
    report,
    required,
    gitOk: GIT_OK.test(git),
    checkoutOk: projectCheckout === CHECKOUT_OK,
    configDir,
  };
}

/** `studio doctor`: what is set and what is missing, never a value. */
export async function runDoctor(o: {
  project: string;
  owner: OwnerEnv;
  env: Record<string, string | undefined>;
  ports: Ports;
  json: boolean;
  stdout(s: string): void;
}): Promise<number> {
  const { report, required, configDir } = await doctorReport(o);
  const { crewToken, accounts, git, projectCheckout, studioCrew, claudeLogin } = report;
  const toolchain = report.toolchainOutside;
  if (o.json) o.stdout(`${JSON.stringify(report, null, 2)}\n`);
  else {
    const source = crewToken.source ? ` (${crewToken.source})` : '';
    const provider = report.credentialProvider;
    const lines = [
      `project checkout: ${projectCheckout}`,
      ...toolchain.map((t) => `toolchain: ${t}`),
      `claude login: ${claudeLogin}`,
      ...accounts.map(
        (a) =>
          `account ${a.label}${a.active ? ' (active)' : ''}: added ${a.addedAt.slice(0, 10)}, ${a.state}`,
      ),
      ...accounts.flatMap((a) => expiryLine(a) ?? []),
      `crew token: ${crewToken.status}${source}${required ? '' : ' (optional: allow_ambient_credentials)'}`,
      `studio.yaml: ${report.studioYaml}`,
      ...(report.boardTracked === 'yes' ? [BOARD_TRACKED_LINE] : []),
      `superpowers: ${report.superpowers}`,
      `git: ${git}`,
      `studio plugin: ${studioCrew}${studioCrew === 'not found' && configDir !== undefined ? ` (${studioPluginHint(configDir)})` : ''}`,
      ...(report.pluginProblem === undefined ? [] : [`plugins: ${report.pluginProblem}`]),
      ...report.pluginsNotAllowed.map(
        (n) => `plugin ${n}: not in allowed_plugins of the owner config, never installed`,
      ),
      ...report.plugins.map(
        (p) =>
          `plugin ${p.name}: pinned ${p.pinned}, installed ${p.installed}${p.installed !== p.pinned && p.installed !== 'unknown' ? ' (a launch refuses: run studio account setup-plugins)' : ''}`,
      ),
      `stacks: ${report.stacks === null ? 'not set: run studio setup stack' : report.stacks.join(', ') || '(none)'}`,
      `owner config: ${report.ownerConfig}`,
      `credential provider: ${provider === null ? 'not configured' : `configured ${provider}`}`,
      `notify: ${report.notify}`,
      `notifications: ${report.notifications}`,
      `allow_api_billing: ${report.allowApiBilling ? 'on' : 'off'}`,
      ...(report.rea === null
        ? []
        : [
            `rea: ${report.rea.server} (${report.rea.pinnedBy}), installed: ${report.rea.installed}; analysis directory ${report.rea.analysisDirectory}`,
            `rea skill in the crew config dir: ${report.rea.skill}; server registered there: ${report.rea.registeredInCrewConfig}`,
            `rea tools: ${report.rea.staticTools} static allowed, ${report.rea.deniedByDefault} known ones denied unless an item allows their class (${report.rea.classes.join(', ')}); engine variables set: ${report.rea.engineEnvironment.join(', ') || 'none'}`,
            ...(report.rea.skill === 'installed' || report.rea.setup === null
              ? []
              : [`rea setup: ${report.rea.setup}`]),
          ]),
      `API key variables in the environment: ${report.apiKeyVarsInEnvironment.join(', ') || 'none'}`,
    ];
    o.stdout(`${lines.map(safe).join('\n')}\n`);
  }
  return required && crewToken.status !== 'set' ? 1 : 0;
}
