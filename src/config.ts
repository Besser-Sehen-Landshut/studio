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

const within = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent + sep);

/**
 * Why `path` may not be a crew toolchain read path, or undefined when it is fine. Rejected:
 * relative paths, `/`, the home itself, and any path that equals, contains or lies inside a
 * credential location (so the `.config` and `Library` parents are out as well).
 */
export function toolchainPathProblem(
  path: string,
  home: string,
  extraCredentialPaths: string[] = [],
): string | undefined {
  if (!isAbsolute(path)) return 'must be an absolute path';
  const p = resolve(path);
  if (p === resolve('/')) return 'must not be the filesystem root';
  if (p === resolve(home)) return 'must not be the home directory';
  const creds = [...CREDENTIAL_PATHS.map((c) => join(home, c)), ...extraCredentialPaths].map((c) =>
    resolve(c),
  );
  const hit = creds.find((c) => within(p, c) || within(c, p));
  return hit ? `must not equal, contain or lie inside the credential location ${hit}` : undefined;
}

const roleSchema = z.strictObject({
  model: z.string().min(1),
  wip: z.number().int().positive(),
  skills: z
    .strictObject({ required: strList, allowed: strList, denied: strList })
    .default({ required: [], allowed: [], denied: [] }),
});

const ciSchema = z.strictObject({
  provider: z.literal('github'),
  runners: z.enum(['github-hosted', 'self-hosted', 'both']),
  runnerLabels: strList,
  runnerNamePattern: z.string().optional(),
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
  // Absolute directories the crew may read in addition to its clone, tmp dir and HOME (toolchains
  // below the real home, e.g. a version manager). Default empty: crew uses system toolchains.
  crewToolchainPaths: strList.superRefine((paths, ctx) => {
    paths.forEach((path, index) => {
      const problem = toolchainPathProblem(path, homedir());
      if (problem) ctx.addIssue({ code: 'custom', path: [index], message: `${path}: ${problem}` });
    });
  }),
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
function camelizeKeys(value: unknown): unknown {
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
  const result = studioConfigSchema.safeParse(camelizeKeys(raw));
  if (!result.success) {
    throw new ConfigError(file, result.error.issues.flatMap(describeIssue).join('; '));
  }
  return result.data;
}

/** Non-fatal findings about a loaded config. */
export function configWarnings(config: StudioConfig): string[] {
  const warnings: string[] = [];
  if (config.crewAllowedWorkflowRefs.length > 0) {
    warnings.push(
      `crew_allowed_workflow_refs (${config.crewAllowedWorkflowRefs.join(', ')}) must be protected server-side (branch protection or rulesets): the crew guard cannot stop a push to those refs from another path`,
    );
  }
  return warnings;
}
