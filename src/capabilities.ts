import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { WorkItem } from './board.js';
import type { RoleSkills } from './config.js';

// scripts/gen-schema.ts loads this file through node's type stripping: type imports only.

export const PHASES = ['design', 'build', 'review'] as const;
export type Phase = (typeof PHASES)[number];

export const TRIGGERS = ['rework', 'after-fix', 'epic-end', 'release'] as const;
const ROLES = ['lead', 'builder', 'reviewer', 'designer', 'researcher', 'release'] as const;
const ITEM_TYPES = ['feature', 'fix', 'chore', 'docs', 'research', 'review', 'release'] as const;
const RISKS = ['ui', 'landing', 'auth', 'security', 'data', 'migration'] as const;
const TIERS = ['small', 'large'] as const;

const REF_RE = /^(skill|analyzer|knowledge|design|source|bundled):[^\s]+$/;
const refSchema = z.string().regex(REF_RE, 'must be <kind>:<name>');

const whenPart = {
  paths: z.array(z.string().min(1)).optional(),
  risks: z.array(z.enum(RISKS)).optional(),
};

const whenSchema = z.strictObject({
  roles: z.array(z.enum(ROLES)).optional(),
  itemTypes: z.array(z.enum(ITEM_TYPES)).optional(),
  itemTypesNot: z.array(z.enum(ITEM_TYPES)).optional(),
  stacks: z.array(z.string().min(1)).optional(),
  phases: z.array(z.enum(PHASES)).optional(),
  triggers: z.array(z.enum(TRIGGERS)).optional(),
  tiers: z.array(z.enum(TIERS)).optional(),
  any: z.array(z.strictObject(whenPart)).optional(),
  ...whenPart,
});

const rowSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  ref: z.union([refSchema, z.array(refSchema).min(1)]),
  when: whenSchema,
  mode: z.enum(['required', 'offered', 'review']),
  load: z.enum(['invoke', 'read', 'subagent', 'run']),
  source: z.string().optional(),
  fallback: refSchema.optional(),
  model: z.enum(['standard', 'capable']).optional(),
  optional: z.boolean().optional(),
  overrides: z.array(z.string()).optional(),
});

export const capabilitiesSchema = z.strictObject({
  version: z.literal(1),
  rows: z.array(rowSchema),
  denied: z.array(refSchema).default([]),
});

export type CapabilityRow = z.infer<typeof rowSchema>;
export type CapabilitiesIndex = z.infer<typeof capabilitiesSchema>;
export type Load = CapabilityRow['load'];

export class CapabilitiesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilitiesError';
  }
}

const camel = (key: string): string =>
  key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

function camelize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [camel(k), camelize(v)]));
  }
  return value;
}

/** The shipped `capabilities/`: the same relative path from `src/` and from `dist-bundle/`. */
export function capabilitiesDir(): string {
  return fileURLToPath(new URL('../capabilities/', import.meta.url));
}

/** Reads `INDEX.yaml`; anything missing or malformed throws, so a launch starts nothing. */
export function loadCapabilities(dir: string = capabilitiesDir()): CapabilitiesIndex {
  const file = join(dir, 'INDEX.yaml');
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new CapabilitiesError(`${file}: cannot read (${(e as Error).message.split('\n')[0]})`);
  }
  const parsed = capabilitiesSchema.safeParse(camelize(raw));
  if (!parsed.success) {
    const where = parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ');
    throw new CapabilitiesError(`${file}: invalid at ${where}`);
  }
  const ids = new Set<string>();
  for (const row of parsed.data.rows) {
    if (ids.has(row.id)) throw new CapabilitiesError(`${file}: duplicate row id ${row.id}`);
    ids.add(row.id);
  }
  return parsed.data;
}

function expandBraces(glob: string): string[] {
  const m = /\{([^{}]*)\}/.exec(glob);
  if (!m) return [glob];
  const head = glob.slice(0, m.index);
  const tail = glob.slice(m.index + m[0].length);
  return (m[1] as string).split(',').flatMap((alt) => expandBraces(head + alt + tail));
}

function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        out += '(?:[^/]*/)*';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 'i');
}

/** `**`, `*`, `?` and `{a,b}`; case-insensitive, because a file system or a person may be. */
export function matchGlob(glob: string, path: string): boolean {
  return expandBraces(glob).some((g) => globToRegExp(g).test(path));
}

export type ChangedPaths = readonly string[] | 'unknown';

export interface ResolveOptions {
  index?: CapabilitiesIndex;
  roleSkills?: RoleSkills;
  triggers?: readonly string[];
  tier?: 'small' | 'large';
}

export interface AnalyzerRef {
  id: string;
  ref: string;
  rowId: string;
  load: Load;
  model?: 'standard' | 'capable';
  source?: string;
}

export interface KnowledgeRef {
  rowId: string;
  ref: string;
  load: Load;
  optional: boolean;
  source?: string;
  fallback?: string;
}

export interface ResolvedSkills {
  required: string[];
  offered: string[];
  /** Required when installed: a missing one reads `skipped:`, it does not stop the launch. */
  optionalRequired: string[];
  analyzers: AnalyzerRef[];
  knowledge: KnowledgeRef[];
  denied: string[];
}

/** Unknown changed paths match every path condition: a security row must not fall silent. */
const pathsHit = (globs: readonly string[], paths: ChangedPaths): boolean =>
  paths === 'unknown' || paths.some((p) => globs.some((g) => matchGlob(g, p)));

const someOf = <T>(want: readonly T[], have: readonly T[]): boolean =>
  want.some((w) => have.includes(w));

interface MatchContext {
  item: WorkItem;
  role: string;
  stack: readonly string[];
  paths: ChangedPaths;
  phase: Phase;
  triggers: readonly string[];
  tier: 'small' | 'large' | undefined;
}

function partMatches(
  part: { paths?: readonly string[] | undefined; risks?: readonly string[] | undefined },
  c: MatchContext,
): boolean {
  if (part.paths && !pathsHit(part.paths, c.paths)) return false;
  if (part.risks && !someOf(part.risks, c.item.risk ?? [])) return false;
  return true;
}

function rowMatches(row: CapabilityRow, c: MatchContext): boolean {
  const w = row.when;
  if (w.roles && !(w.roles as readonly string[]).includes(c.role)) return false;
  if (w.itemTypes && !w.itemTypes.includes(c.item.type)) return false;
  if (w.itemTypesNot?.includes(c.item.type)) return false;
  if (w.stacks && !someOf(w.stacks, c.stack)) return false;
  if (w.phases && !w.phases.includes(c.phase)) return false;
  if (w.triggers && !someOf<string>(w.triggers, c.triggers)) return false;
  if (w.tiers && (c.tier === undefined || !w.tiers.includes(c.tier))) return false;
  if (w.any && !w.any.some((p) => partMatches(p, c))) return false;
  return partMatches(w, c);
}

const CREW_SKILL = 'studio:studio-crew';

const unique = (xs: readonly string[]): string[] => [...new Set(xs)];

const after = (ref: string): string => ref.slice(ref.indexOf(':') + 1);

/**
 * What a crew in this role must use for this item. Pure, apart from reading the shipped index when
 * none is passed. The denied list wins over every other list.
 */
export function resolveSkills(
  item: WorkItem,
  role: string,
  stack: readonly string[],
  changedPaths: ChangedPaths,
  phase: Phase,
  opts: ResolveOptions = {},
): ResolvedSkills {
  const index = opts.index ?? loadCapabilities();
  const ctx: MatchContext = {
    item,
    role,
    stack,
    paths: changedPaths,
    phase,
    triggers: opts.triggers ?? itemTriggers(item),
    tier: opts.tier,
  };
  const required: string[] = [];
  const offered: string[] = [];
  const optionalRequired: string[] = [];
  const analyzers = new Map<string, AnalyzerRef>();
  const knowledge = new Map<string, KnowledgeRef>();
  for (const row of index.rows) {
    if (!rowMatches(row, ctx)) continue;
    for (const ref of Array.isArray(row.ref) ? row.ref : [row.ref]) {
      if (ref.startsWith('skill:')) {
        const name = after(ref);
        if (row.mode === 'offered') offered.push(name);
        else if (row.optional) optionalRequired.push(name);
        else required.push(name);
      } else if (ref.startsWith('analyzer:')) {
        const id = after(ref);
        if (!analyzers.has(id)) {
          analyzers.set(id, {
            id,
            ref,
            rowId: row.id,
            load: row.load,
            ...(row.model === undefined ? {} : { model: row.model }),
            ...(row.source === undefined ? {} : { source: row.source }),
          });
        }
      } else if (!knowledge.has(ref)) {
        knowledge.set(ref, {
          rowId: row.id,
          ref,
          load: row.load,
          optional: row.optional === true,
          ...(row.source === undefined ? {} : { source: row.source }),
          ...(row.fallback === undefined ? {} : { fallback: row.fallback }),
        });
      }
    }
  }
  const rs = opts.roleSkills;
  required.push(...(rs?.required ?? []));
  offered.push(...(rs?.allowed ?? []));
  for (const extra of rs?.when ?? []) {
    if (extra.paths && !pathsHit(extra.paths, changedPaths)) continue;
    if (extra.itemTypes && !extra.itemTypes.includes(item.type)) continue;
    required.push(...(extra.required ?? []));
    offered.push(...(extra.allowed ?? []));
  }
  const denied = unique([
    ...index.denied.map(after),
    ...(rs?.denied ?? []).filter((s) => s !== CREW_SKILL),
  ]);
  const isDenied = (s: string) => denied.includes(s);
  const req = unique(required).filter((s) => !isDenied(s));
  const opt = unique(optionalRequired).filter((s) => !isDenied(s) && !req.includes(s));
  return {
    required: req,
    optionalRequired: opt,
    offered: unique(offered).filter((s) => !isDenied(s) && !req.includes(s) && !opt.includes(s)),
    analyzers: [...analyzers.values()],
    knowledge: [...knowledge.values()],
    denied,
  };
}

/** Design for the designer, review for review work, build for everything else. */
export function phaseOf(item: WorkItem): Phase {
  if (item.role === 'reviewer' || item.type === 'review') return 'review';
  return item.role === 'designer' ? 'design' : 'build';
}

/** Triggers the item itself carries: declared ones, a release, and rework after a first review. */
export function itemTriggers(item: WorkItem): string[] {
  return unique([
    ...(item.triggers ?? []),
    ...(item.type === 'release' ? ['release'] : []),
    ...(item.history.some((h) => h.to === 'in_review') ? ['rework'] : []),
  ]);
}
