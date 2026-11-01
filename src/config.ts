import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const ROLE_TEMPLATES = ['builder', 'reviewer', 'designer', 'researcher', 'release'] as const;
export type RoleTemplate = (typeof ROLE_TEMPLATES)[number];

const strList = z.array(z.string()).default([]);

/** Credential locations below the real home that a crew session must never read. */
export const CREDENTIAL_PATHS = [
  '.config/gh',
  '.git-credentials',
  '.ssh',
  '.netrc',
  '.gnupg',
  '.aws',
  '.docker/config.json',
  'Library/Keychains',
];

/** Locations below the real home a crew toolchain path must not open besides the credentials. */
export const PROTECTED_HOME_PATHS = [...CREDENTIAL_PATHS, '.claude'];

/** Path comparison key: case-insensitive on darwin (its default file systems are). */
export const pathKey = (p: string, platform: NodeJS.Platform = process.platform): string =>
  platform === 'darwin' ? p.toLowerCase() : p;

/** `child` equals `parent` or lies below it (both already resolved and case-folded). */
export const within = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/**
 * Lexical check (no filesystem access) of a crew toolchain read path; returns why it is refused,
 * or undefined. Rejected: relative paths, `/`, the home itself or a parent of it, and any path that
 * equals, contains or lies inside a credential location or the Claude config dir (so the
 * `.config` and `Library` parents are out as well). Case-insensitive on darwin. The launch repeats
 * this on the real paths (`canonicalToolchainPaths` in paths.ts).
 */
export function toolchainPathProblem(
  path: string,
  home: string,
  extraProtectedPaths: string[] = [],
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!isAbsolute(path)) return 'must be an absolute path';
  const key = (x: string) => pathKey(resolve(x), platform);
  const p = key(path);
  if (p === key('/')) return 'must not be the filesystem root';
  if (within(key(home), p)) return 'must not be the home directory or a parent of it';
  const hit = [...PROTECTED_HOME_PATHS.map((c) => join(home, c)), ...extraProtectedPaths].find(
    (c) => within(p, key(c)) || within(key(c), p),
  );
  return hit ? `must not equal, contain or lie inside the credential location ${hit}` : undefined;
}

const roleSchema = z.strictObject({
  model: z.string().min(1),
  wip: z.number().int().positive(),
  skills: z
    .strictObject({ required: strList, allowed: strList, denied: strList })
    .default({ required: [], allowed: [], denied: [] }),
});

export const ciSchema = z.strictObject({
  provider: z.literal('github'),
  runners: z.enum(['github-hosted', 'self-hosted', 'both']),
  runnerLabels: strList,
  runnerNamePattern: z.string().optional(),
  // The self-hosted runners share their host with other workloads: host load is capped at
  // `hostLoadMax`, or at the core count when that is unset.
  sharedHost: z.boolean().optional(),
  // Most GitHub-hosted runs (in progress + queued) allowed with `runners: both`.
  githubHostedLimit: z.number().int().positive().optional(),
  capacity: z.strictObject({
    total: z.number().int().positive(),
    mergeMaxBusy: z.number().int().nonnegative(),
    checkTwiceSeconds: z.number().nonnegative(),
    hostLoadMax: z.number().positive().optional(),
  }),
  rhythm: z.strictObject({ buildWindow: z.string(), timezone: z.string() }).optional(),
});

export const studioConfigSchema = z.strictObject({
  studio: z.literal(1),
  primaryRepo: z.string().min(1),
  repos: z.array(z.string().min(1)).min(1),
  notify: z
    .strictObject({
      channel: z.string().min(1),
      ownerOnly: z.boolean(),
      irreversibleAnnounce: z.boolean(),
    })
    .optional(),
  ci: ciSchema,
  merge: z.strictObject({
    strategy: z.enum(['studio-queue', 'native-queue']),
    contractPaths: strList,
    method: z.enum(['merge', 'squash', 'rebase']).default('merge'),
  }),
  // Partial record keyed by role template name; at least one role must be configured.
  roles: z
    .partialRecord(z.enum(ROLE_TEMPLATES), roleSchema)
    .refine((r) => Object.keys(r).length > 0, 'at least one role is required'),
  sandbox: z.strictObject({ networkAllow: strList }).default({ networkAllow: [] }),
  // Name of the env var that holds the least-privilege token (never the token itself).
  crewToken: z.strictObject({ env: z.string().min(1) }).optional(),
  // Opt-in: let a crew run start without the least-privilege token (default: refuse).
  allowAmbientCredentials: z.boolean().default(false),
  ownerOnly: strList,
  deployCommands: strList,
  // Workflows (file name or name) a crew session may start with `gh workflow run`.
  crewAllowedWorkflows: strList,
  // Refs a crew session may pass to `gh workflow run --ref`; empty = default branch only.
  crewAllowedWorkflowRefs: strList,
});

export type StudioConfig = z.infer<typeof studioConfigSchema>;

export class ConfigError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'ConfigError';
    this.path = path;
  }
}

const camel = (key: string): string =>
  key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Recursively convert snake_case object keys to camelCase. Role keys are template names (single words), so they pass through unchanged. */
export function camelizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelizeKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [camel(k), camelizeKeys(v)]));
  }
  return value;
}

const snake = (key: string): string => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function dotted(path: readonly PropertyKey[]): string {
  return path.map((p) => (typeof p === 'symbol' ? String(p) : snake(String(p)))).join('.');
}

function describeIssue(issue: z.core.$ZodIssue): string[] {
  const base = dotted(issue.path);
  const join2 = (leaf: string) => (base ? `${base}.${leaf}` : leaf);
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((k) => `${join2(snake(k))}: unknown key`);
  }
  return [`${base || '(root)'}: ${issue.message}`];
}

/** Where crew_toolchain_paths moved to (it opens reads on the owner's machine, not the repo's call). */
const OWNER_CONFIG_HINT =
  'crew_toolchain_paths is not read from studio.yaml any more; move it to the owner config ($XDG_CONFIG_HOME/studio/config.yaml or ~/.config/studio/config.yaml)';

export function loadConfig(projectDir: string): StudioConfig {
  const file = join(projectDir, '.studio', 'studio.yaml');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new ConfigError(file, `cannot read file (${(e as Error).message})`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new ConfigError(file, `invalid YAML (${(e as Error).message})`);
  }
  if (raw !== null && typeof raw === 'object' && 'crew_toolchain_paths' in raw) {
    throw new ConfigError(file, OWNER_CONFIG_HINT);
  }
  const result = studioConfigSchema.safeParse(camelizeKeys(raw));
  if (!result.success) {
    throw new ConfigError(file, result.error.issues.flatMap(describeIssue).join('; '));
  }
  return result.data;
}

/** Owner-level settings, kept outside every repository. */
export const ownerConfigSchema = z.strictObject({
  // Absolute directories a crew may read in addition to its clone, tmp dir and HOME (toolchains
  // below the real home, e.g. a version manager). Default empty: crew uses system toolchains.
  crewToolchainPaths: strList,
});

export type OwnerConfig = z.infer<typeof ownerConfigSchema>;

/** Home, environment and platform of the owner; injectable so tests never touch the real ones. */
export interface OwnerEnv {
  homedir?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}

/** An XDG base directory variable, or undefined when unset or relative (the spec ignores those). */
export function xdgDir(env: Record<string, string | undefined>, name: string): string | undefined {
  const v = env[name];
  return v && isAbsolute(v) ? v : undefined;
}

/** `$XDG_CONFIG_HOME/studio/config.yaml`, else `<home>/.config/studio/config.yaml`. */
export function ownerConfigFile(opts: OwnerEnv = {}): string {
  const env = opts.env ?? process.env;
  const base = xdgDir(env, 'XDG_CONFIG_HOME') ?? join(opts.homedir ?? homedir(), '.config');
  return join(base, 'studio', 'config.yaml');
}

/**
 * Reads the owner config; a missing file means defaults. Toolchain paths get the lexical check
 * here; the launch checks them again against the real filesystem.
 */
export function loadOwnerConfig(opts: OwnerEnv = {}): OwnerConfig {
  const file = ownerConfigFile(opts);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { crewToolchainPaths: [] };
    throw new ConfigError(file, `cannot read file (${(e as Error).message})`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(text) ?? {};
  } catch (e) {
    throw new ConfigError(file, `invalid YAML (${(e as Error).message})`);
  }
  const result = ownerConfigSchema.safeParse(camelizeKeys(raw));
  if (!result.success) {
    throw new ConfigError(file, result.error.issues.flatMap(describeIssue).join('; '));
  }
  const home = opts.homedir ?? homedir();
  const problems = result.data.crewToolchainPaths.flatMap((path) => {
    const problem = toolchainPathProblem(path, home, [], opts.platform);
    return problem ? [`crew_toolchain_paths: ${path}: ${problem}`] : [];
  });
  if (problems.length > 0) throw new ConfigError(file, problems.join('; '));
  return result.data;
}

export const GITHUB_HOSTED_UNLIMITED =
  'ci.runners both: GitHub-hosted concurrency is not checked until github_hosted_limit is set';

/** Non-fatal findings about a loaded config. */
export function configWarnings(config: StudioConfig): string[] {
  const warnings: string[] = [];
  if (config.merge.strategy === 'native-queue') {
    warnings.push(
      'merge.strategy native-queue is not supported yet (planned for stage d): queue add and queue run refuse; use studio-queue',
    );
  }
  if (config.ci.runners === 'both' && config.ci.githubHostedLimit === undefined) {
    warnings.push(GITHUB_HOSTED_UNLIMITED);
  }
  if (config.crewAllowedWorkflowRefs.length > 0) {
    warnings.push(
      `crew_allowed_workflow_refs (${config.crewAllowedWorkflowRefs.join(', ')}) must be protected server-side (branch protection or rulesets): the crew guard cannot stop a push to those refs from another path`,
    );
  }
  return warnings;
}
