import { describe, expect, it } from 'vitest';
import type { WorkItem } from '../src/board.js';
import { workItemSchema } from '../src/board.js';
import { WORKER_LABEL_RE } from '../src/config.js';
import {
  type Claim,
  claimExpired,
  LEASE_GRACE_MS,
  looksSecret,
  offerTitle,
  parseClaim,
  parseOffer,
  renderClaim,
  renderOffer,
  workerItemProblem,
} from '../src/worker-claim.js';

const item: WorkItem = workItemSchema.parse({
  id: 'APP-4',
  title: 'Read the device log',
  type: 'fix',
  role: 'builder',
  repo: 'org/app',
  size: 'S',
  priority: 2,
  status: 'ready',
  paths: ['tools/**'],
  touches: ['tools/log/**'],
  runsOn: 'windows',
  dependsOn: ['APP-1'],
  dod: ['the log is parsed', 'a test covers it'],
  notes: ['fix round: header'],
  history: [{ at: '2026-11-01T10:00:00Z', from: 'ready', to: 'assigned', by: 'studio' }],
});

const NOW = new Date('2026-11-05T10:00:00Z');

describe('offers', () => {
  it('round-trip the item fields a brief needs, never status, history or dependencies', () => {
    const body = renderOffer(item, 'lead-user', NOW);
    expect(body).toContain('Do not edit it');
    const o = parseOffer(offerTitle('APP-4', 'windows'), body);
    expect(o).toMatchObject({ label: 'windows', lead: 'lead-user', offeredAt: NOW.toISOString() });
    expect(o?.item).toMatchObject({
      id: 'APP-4',
      title: item.title,
      runsOn: 'windows',
      dod: item.dod,
      notes: item.notes,
      status: 'assigned',
      dependsOn: [],
      history: [],
    });
  });
  it('refuses a title that does not match, a second block, unknown fields and bad items', () => {
    const body = renderOffer(item, 'lead-user', NOW);
    expect(parseOffer('Studio offer APP-5 for windows', body)).toBeUndefined();
    expect(parseOffer('Studio offer APP-4 for linux', body)).toBeUndefined();
    expect(parseOffer(offerTitle('APP-4', 'windows'), `${body}\n${body}`)).toBeUndefined();
    const tamper = (f: (j: Record<string, unknown>) => void) => {
      const j = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(body)?.[1] ?? '{}');
      f(j);
      return parseOffer(
        offerTitle('APP-4', 'windows'),
        body.replace(/```json\n[\s\S]*?\n```/, `\`\`\`json\n${JSON.stringify(j)}\n\`\`\``),
      );
    };
    expect(tamper(() => {})).toBeDefined();
    expect(tamper((j) => Object.assign(j.item as object, { status: 'merged' }))).toBeUndefined();
    expect(tamper((j) => Object.assign(j.item as object, { crew_token: 'x' }))).toBeUndefined();
    expect(tamper((j) => Object.assign(j.item as object, { type: 'review' }))).toBeUndefined();
    expect(tamper((j) => Object.assign(j, { extra: 1 }))).toBeUndefined();
    expect(tamper((j) => Object.assign(j, { label: 'linux' }))).toBeUndefined();
  });
  it('only builds, docs and research of builders, designers and researchers run on workers', () => {
    expect(workerItemProblem(item)).toBeUndefined();
    expect(workerItemProblem({ ...item, type: 'review', role: 'reviewer' })).toMatch(
      /stays with the lead/,
    );
    expect(workerItemProblem({ ...item, type: 'release' })).toMatch(/stays with the lead/);
    expect(workerItemProblem({ ...item, role: 'release' })).toMatch(/stays with the lead/);
  });
  it('the board and the config share one label rule', () => {
    for (const l of ['windows', 'lab-2', 'a']) {
      expect(WORKER_LABEL_RE.test(l)).toBe(true);
      expect(workItemSchema.safeParse({ ...item, runsOn: l }).success).toBe(true);
    }
    for (const l of ['Windows', '2lab', 'a_b', '', 'x'.repeat(33)]) {
      expect(WORKER_LABEL_RE.test(l)).toBe(false);
      expect(workItemSchema.safeParse({ ...item, runsOn: l }).success).toBe(false);
    }
  });
});

const claim: Claim = {
  studioClaim: 1,
  item: 'APP-4',
  label: 'windows',
  worker: 'win-bot',
  offer: 31,
  attempt: 1,
  state: 'claimed',
  leaseMinutes: 30,
};

describe('claims', () => {
  it('round-trip through the commit message, usage included', () => {
    const done: Claim = {
      ...claim,
      state: 'done',
      pr: 7,
      headSha: 'a'.repeat(40),
      usage: { runs: 1, tokensIn: 10, tokensOut: 5, tokensCache: 2, costUsd: 0.25 },
    };
    const msg = renderClaim(done);
    expect(msg.split('\n')[0]).toBe('Studio claim APP-4: done');
    expect(msg).toContain('"tokens_in": 10');
    expect(parseClaim(msg)).toEqual(done);
  });
  it('refuses a subject that does not match its body, extra fields and bad values', () => {
    const msg = renderClaim(claim);
    expect(parseClaim(msg.replace('APP-4: claimed', 'APP-4: done'))).toBeUndefined();
    expect(parseClaim(msg.replace('"attempt": 1', '"attempt": 3'))).toBeUndefined();
    expect(parseClaim(msg.replace('"worker": "win-bot"', '"worker": "-x"'))).toBeUndefined();
    expect(parseClaim(msg.replace('{', '{"token": "x",'))).toBeUndefined();
    expect(parseClaim('Studio claim APP-4: claimed')).toBeUndefined();
  });
  it('a reason is one plain line of at most 300 characters', () => {
    const r = parseClaim(renderClaim({ ...claim, state: 'released', reason: 'a‮b\nc' }));
    expect(r?.reason).toBe('a b c');
    expect(
      parseClaim(renderClaim({ ...claim, state: 'released', reason: 'x'.repeat(301) })),
    ).toBeUndefined();
  });
  it('a live claim expires after its lease and the grace; a done one never', () => {
    const at = NOW.toISOString();
    const later = (ms: number) => new Date(NOW.getTime() + ms);
    expect(claimExpired(claim, at, later(30 * 60_000 + LEASE_GRACE_MS))).toBe(false);
    expect(claimExpired(claim, at, later(30 * 60_000 + LEASE_GRACE_MS + 1))).toBe(true);
    expect(claimExpired({ ...claim, state: 'alive' }, at, later(3_600_000))).toBe(true);
    expect(claimExpired({ ...claim, state: 'done' }, at, later(86_400_000))).toBe(false);
    expect(claimExpired(claim, 'not a time', NOW)).toBe(true);
  });
});

describe('looksSecret', () => {
  it('finds tokens by their shape and by the values the worker knows', () => {
    const gh = ['gh', 'p_', 'A'.repeat(36)].join('');
    const ant = ['sk', '-ant-', 'oat01-', 'b'.repeat(30)].join('');
    const key = ['-----BEGIN ', 'OPENSSH PRIVATE KEY-----'].join('');
    for (const t of [gh, ant, key]) expect(looksSecret(`see ${t} here`)).toBe(true);
    expect(looksSecret('the value is plain-known-1234', ['plain-known-1234'])).toBe(true);
    expect(looksSecret('nothing here; tests_run: 12')).toBe(false);
    expect(looksSecret('short', ['abc'])).toBe(false);
  });
});
