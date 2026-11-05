// The two messages between the lead and a worker, both public: an offer (an issue the lead opens)
// and a claim (commits on `refs/studio/claims/<id>` a worker writes). Neither ever carries a
// secret; both hold only what the board holds anyway and what Studio writes itself. Pure.
import { z } from 'zod';
import { type WorkItem, workItemSchema } from './board.js';
import { GITHUB_LOGIN_RE, WORKER_LABEL_RE } from './config.js';
import type { RunUsage } from './costs.js';

/** A claim older than its lease plus this is free for another worker: room for clock skew. */
export const LEASE_GRACE_MS = 2 * 60_000;
/** The first claim and one takeover after a lease ran out, like a local crew's one relaunch. */
export const MAX_CLAIM_ATTEMPTS = 2;

const OFFER_TITLE_RE = /^Studio offer ([A-Z]+-\d+) for ([a-z][a-z0-9-]{0,31})$/;

/** The board fields an offer carries: the brief a worker writes is made of these and the repo. */
const OFFER_FIELDS = [
  'id',
  'title',
  'type',
  'role',
  'repo',
  'size',
  'priority',
  'paths',
  'touches',
  'component',
  'components',
  'runsOn',
  'dod',
  'flag',
  'plan',
  'notes',
  'risk',
  'triggers',
  'model',
  'epic',
] as const;

/** Item types a worker may build; reviews, acceptances and releases stay with the lead. */
export const WORKER_TYPES: readonly WorkItem['type'][] = [
  'feature',
  'fix',
  'chore',
  'docs',
  'research',
];
export const WORKER_ROLES: readonly WorkItem['role'][] = ['builder', 'designer', 'researcher'];

/** Why an item cannot run on a worker, or undefined. */
export function workerItemProblem(item: WorkItem): string | undefined {
  if (!WORKER_TYPES.includes(item.type)) {
    return `runs_on works for ${WORKER_TYPES.join(', ')} items; a ${item.type} item stays with the lead`;
  }
  if (!WORKER_ROLES.includes(item.role)) {
    return `runs_on works for the roles ${WORKER_ROLES.join(', ')}; ${item.role} stays with the lead`;
  }
  return undefined;
}

const offerSchema = z.strictObject({
  studioOffer: z.literal(1),
  label: z.string().regex(WORKER_LABEL_RE),
  lead: z.string().regex(GITHUB_LOGIN_RE),
  offeredAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'not a time'),
  item: z.record(z.string(), z.unknown()),
});

export interface Offer {
  label: string;
  lead: string;
  offeredAt: string;
  /** The item as a worker launches it: status `assigned`, no history. */
  item: WorkItem;
}

const snake = (k: string): string => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const camel = (k: string): string => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

export const offerTitle = (id: string, label: string): string => `Studio offer ${id} for ${label}`;

/** The issue body of an offer: a line for people and one JSON block for workers. */
export function renderOffer(item: WorkItem, lead: string, now: Date): string {
  if (item.runsOn === undefined) throw new Error(`${item.id} names no runs_on label`);
  const fields: Record<string, unknown> = {};
  for (const k of OFFER_FIELDS) if (item[k] !== undefined) fields[snake(k)] = item[k];
  const body = {
    studio_offer: 1,
    label: item.runsOn,
    lead,
    offered_at: now.toISOString(),
    item: fields,
  };
  return [
    `Studio offers ${item.id} to workers with the label \`${item.runsOn}\` (\`studio worker --label ${item.runsOn}\`).`,
    '',
    'Studio opened this issue and closes it when the work is collected or withdrawn. Do not edit it: a worker refuses an offer that was edited after it was opened.',
    '',
    '```json',
    JSON.stringify(body, null, 2),
    '```',
    '',
  ].join('\n');
}

/**
 * Reads an offer as a worker: the title names the item and label, the body holds one JSON block
 * whose item passes the board schema and matches the title. Anything else is undefined.
 */
export function parseOffer(title: string, body: string): Offer | undefined {
  const t = OFFER_TITLE_RE.exec(title);
  if (!t) return undefined;
  const blocks = [...body.matchAll(/```json\n([\s\S]*?)\n```/g)];
  if (blocks.length !== 1) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse((blocks[0] as RegExpMatchArray)[1] as string);
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const top = Object.fromEntries(Object.entries(raw).map(([k, v]) => [camel(k), v]));
  const parsed = offerSchema.safeParse(top);
  if (!parsed.success) return undefined;
  const fields = Object.fromEntries(
    Object.entries(parsed.data.item).map(([k, v]) => [camel(k), v]),
  );
  if (Object.keys(fields).some((k) => !(OFFER_FIELDS as readonly string[]).includes(k))) {
    return undefined;
  }
  const item = workItemSchema.safeParse({
    ...fields,
    status: 'assigned',
    dependsOn: [],
    history: [],
  });
  if (!item.success) return undefined;
  const it = item.data;
  if (it.id !== t[1] || it.runsOn !== t[2] || parsed.data.label !== t[2]) return undefined;
  if (workerItemProblem(it) !== undefined) return undefined;
  return {
    label: parsed.data.label,
    lead: parsed.data.lead,
    offeredAt: parsed.data.offeredAt,
    item: it,
  };
}

/** Where a claim stands. `done`: the report is attached; `released`: the worker gave it up. */
export const CLAIM_STATES = ['claimed', 'alive', 'done', 'released'] as const;
export type ClaimState = (typeof CLAIM_STATES)[number];

const usageSchema = z.strictObject({
  runs: z.number().int().min(0).max(1000),
  tokensIn: z.number().min(0).max(1e12),
  tokensOut: z.number().min(0).max(1e12),
  tokensCache: z.number().min(0).max(1e12),
  costUsd: z.number().min(0).max(100_000),
  estimated: z.literal(true).optional(),
});

/** One line in Studio's own words or a report error; never longer than 300 characters. */
const reasonLine = z
  .string()
  .transform((s) => s.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim())
  .pipe(z.string().min(1).max(300));

const claimSchema = z.strictObject({
  studioClaim: z.literal(1),
  item: z.string().regex(/^[A-Z]+-\d+$/),
  label: z.string().regex(WORKER_LABEL_RE),
  worker: z.string().regex(GITHUB_LOGIN_RE),
  offer: z.number().int().positive(),
  attempt: z.number().int().min(1).max(MAX_CLAIM_ATTEMPTS),
  state: z.enum(CLAIM_STATES),
  leaseMinutes: z.number().int().min(10).max(240),
  pr: z.number().int().positive().optional(),
  headSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  reason: reasonLine.optional(),
  usage: usageSchema.optional(),
});
export type Claim = z.infer<typeof claimSchema>;

/** The commit message of a claim: a subject line and the claim as JSON. */
export function renderClaim(c: Claim): string {
  const raw = Object.fromEntries(
    Object.entries(c)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [
        snake(k),
        k === 'usage' && v !== null && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([a, b]) => [snake(a), b]))
          : v,
      ]),
  );
  return `Studio claim ${c.item}: ${c.state}\n\n${JSON.stringify(raw, null, 2)}\n`;
}

/** Reads a claim commit message strictly; undefined when it is not one. */
export function parseClaim(message: string): Claim | undefined {
  const at = message.indexOf('\n\n');
  if (at < 0) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(message.slice(at + 2));
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const top = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [
      camel(k),
      k === 'usage' && v !== null && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).map(([a, b]) => [camel(a), b]))
        : v,
    ]),
  );
  const parsed = claimSchema.safeParse(top);
  if (!parsed.success) return undefined;
  if (!message.startsWith(`Studio claim ${parsed.data.item}: ${parsed.data.state}\n`)) {
    return undefined;
  }
  return parsed.data;
}

/** Whether a claim's lease ran out: only a live claim (`claimed`, `alive`) can expire. */
export function claimExpired(c: Claim, committedAt: string, now: Date): boolean {
  if (c.state !== 'claimed' && c.state !== 'alive') return false;
  const at = Date.parse(committedAt);
  if (Number.isNaN(at)) return true;
  return now.getTime() - at > c.leaseMinutes * 60_000 + LEASE_GRACE_MS;
}

/** Minutes since the last claim commit, rounded down; for status lines. */
export const minutesSince = (committedAt: string, now: Date): number =>
  Math.max(0, Math.floor((now.getTime() - Date.parse(committedAt)) / 60_000));

export const toRunUsage = (u: Claim['usage']): RunUsage | undefined =>
  u === undefined
    ? undefined
    : {
        runs: u.runs,
        tokensIn: u.tokensIn,
        tokensOut: u.tokensOut,
        tokensCache: u.tokensCache,
        costUsd: u.costUsd,
        ...(u.estimated ? { estimated: true as const } : {}),
      };

/**
 * Text that looks like it holds a credential: tokens of GitHub, Anthropic, AWS, Slack, npm and
 * private keys, plus the exact values the caller knows (the worker's own tokens). A report or a
 * pull request text that matches stays on the worker.
 */
export function looksSecret(text: string, known: readonly string[] = []): boolean {
  if (known.some((k) => k.length >= 8 && text.includes(k))) return true;
  return /(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-ant-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[abposr]-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/.test(
    text,
  );
}
