import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const ROLE_TEMPLATES = ['builder', 'reviewer', 'designer', 'researcher', 'release'] as const;
export type RoleTemplate = (typeof ROLE_TEMPLATES)[number];

const strList = z.array(z.string()).default([]);

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
  runnerLabels: z.array(z.string()),
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
    contractPaths: z.array(z.string()),
    method: z.enum(['merge', 'squash', 'rebase']).default('merge'),
  }),
  // Partial record keyed by role template name; at least one role must be configured.
  roles: z
    .partialRecord(z.enum(ROLE_TEMPLATES), roleSchema)
    .refine((r) => Object.keys(r).length > 0, 'at least one role is required'),
  sandbox: z.strictObject({ networkAllow: strList }).default({ networkAllow: [] }),
  // Name of the env var that holds the least-privilege token (never the token itself).
  crewToken: z.strictObject({ env: z.string().min(1) }).optional(),
  ownerOnly: strList,
  deployCommands: strList,
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
