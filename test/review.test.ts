import { describe, expect, it } from 'vitest';
import type { Board, WorkItem } from '../src/board.js';
import type { Ports } from '../src/ports.js';
import {
  checkReviewCaps,
  MAX_FIX_ATTEMPTS,
  MAX_REVIEW_ROUNDS,
  readPrFacts,
  renderReviewRoutine,
  reviewRounds,
  reviewTarget,
  reviewTier,
  SMALL_MAX_LINES,
} from '../src/review.js';

const item = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: 'APP-2',
  title: 't',
  type: 'review',
  role: 'reviewer',
  repo: 'org/app',
  size: 'S',
  priority: 1,
  status: 'ready',
  paths: [],
  touches: [],
  dependsOn: [],
  dod: ['d'],
  history: [],
  ...over,
});
const ghWith = (code: number, stdout: string) =>
  ({
    gh: { run: async () => ({ code, stdout, stderr: '' }), api: async () => '' },
  }) as unknown as Ports;

describe('limits', () => {
  it('are the agreed numbers', () => {
    expect(MAX_FIX_ATTEMPTS).toBe(3);
    expect(MAX_REVIEW_ROUNDS).toBe(6);
    expect(SMALL_MAX_LINES).toBe(400);
  });
});

describe('reviewTarget', () => {
  it('reads the note the lead writes', () => {
    expect(reviewTarget(item({ notes: ['x', 'review org/app#7 at head'] }))).toEqual({
      repo: 'org/app',
      pr: 7,
    });
  });
  it.each([[undefined], [[]], [['review org/app#0']], [['see org/app#7']], [['review a#1']]])(
    'finds none in %j',
    (notes) => {
      expect(reviewTarget(item(notes === undefined ? {} : { notes }))).toBeUndefined();
    },
  );
});

describe('readPrFacts', () => {
  const target = { repo: 'org/app', pr: 7 };
  it('counts lines without markdown', async () => {
    const out = JSON.stringify({
      changedFiles: 2,
      files: [
        { path: 'a.ts', additions: 3, deletions: 2 },
        { path: 'README.md', additions: 500, deletions: 0 },
      ],
    });
    expect(await readPrFacts(ghWith(0, out), target)).toEqual({
      files: ['a.ts', 'README.md'],
      lines: 5,
      complete: true,
    });
  });
  it('fewer files than changed is incomplete', async () => {
    const out = JSON.stringify({
      changedFiles: 200,
      files: [{ path: 'a', additions: 1, deletions: 0 }],
    });
    expect((await readPrFacts(ghWith(0, out), target))?.complete).toBe(false);
  });
  it.each([
    [1, '{}'],
    [0, 'nope'],
    [0, '{}'],
    [0, '{"changedFiles":1,"files":[{"path":3}]}'],
    [0, '{"changedFiles":"x","files":[]}'],
  ])('gh exit %i with %s gives nothing', async (code, out) => {
    expect(await readPrFacts(ghWith(code, out), target)).toBeUndefined();
  });
  it('a throwing gh gives nothing', async () => {
    const ports = {
      gh: {
        run: async () => {
          throw new Error('x');
        },
      },
    } as unknown as Ports;
    expect(await readPrFacts(ports, target)).toBeUndefined();
  });
});

describe('reviewTier', () => {
  const facts = (lines: number) => ({ files: ['a.ts'], lines, complete: true });
  it('small for a small plain change', () => {
    expect(reviewTier(item(), facts(10), false).tier).toBe('small');
    expect(reviewTier(item(), facts(400), false).tier).toBe('small');
  });
  it.each([
    ['facts missing', item(), undefined, false],
    ['facts incomplete', item(), { files: [], lines: 1, complete: false }, false],
    ['security hit', item(), facts(1), true],
    ['many lines', item(), facts(401), false],
    ['risk tag', item({ risk: ['migration'] }), facts(1), false],
  ])('large when %s, with a reason', (_n, it0, f, hit) => {
    const r = reviewTier(it0, f, hit);
    expect(r.tier).toBe('large');
    expect(r.reasons.length).toBeGreaterThan(0);
  });
  it('a ui risk tag alone does not make it large', () => {
    expect(reviewTier(item({ risk: ['ui'] }), facts(1), false).tier).toBe('small');
  });
});

describe('reviewRounds', () => {
  const review = (id: string, verdict: string, target = 'org/app#7'): WorkItem =>
    item({ id, status: 'merged', notes: [`verdict: ${verdict}`, `reviews: ${target}`] });
  it('counts only requested changes on this target', () => {
    const board: Board = {
      items: [
        review('APP-3', 'changes_requested'),
        review('APP-4', 'approve'),
        review('APP-5', 'changes_requested', 'org/app#8'),
        review('APP-6', 'changes_requested'),
        item({
          id: 'APP-7',
          type: 'fix',
          notes: ['verdict: changes_requested', 'reviews: org/app#7'],
        }),
      ],
    };
    expect(reviewRounds(board, 'org/app#7')).toBe(2);
  });
});

describe('renderReviewRoutine', () => {
  const text = renderReviewRoutine({
    tier: 'large',
    reasons: ['sensitive files changed'],
    analyzers: [
      { id: 'security', path: '/caps/analyzers/security.md', model: 'capable' },
      { id: 'diff-review', path: '/caps/analyzers/diff-review.md' },
    ],
    skipped: [{ id: 'motion', reason: 'source emil not fetched' }],
    contract: '/caps/analyzers/CONTRACT.md',
    round: 2,
  }).join('\n');
  it('names tier, reason and each analyzer with an explicit model', () => {
    expect(text).toContain('Tier: large');
    expect(text).toContain('sensitive files changed');
    expect(text).toMatch(/security.*model: opus.*security\.md/);
    expect(text).toMatch(/diff-review.*model: sonnet/);
    expect(text).toContain('/caps/analyzers/CONTRACT.md');
  });
  it('says skipped is no pass', () => {
    expect(text).toContain('motion: skipped: source emil not fetched');
    expect(text).toMatch(/never a pass/i);
  });
  it('holds the fix limit, the probe, the round and refutation', () => {
    expect(text).toContain('3 attempts per finding');
    expect(text).toContain('6 rounds');
    expect(text).toMatch(/mutation probe/i);
    expect(text).toContain('Review round: 3');
    expect(text).toMatch(/what is wrong/i);
  });
});

describe('checkReviewCaps', () => {
  const caps = {
    tier: 'large' as const,
    analyzers: ['diff-review', 'spec-check', 'security', 'motion'],
    mandatory: ['diff-review', 'spec-check', 'security'],
    reviewsTarget: 'org/app#7',
  };
  const report = (over = {}) => ({
    status: 'done' as const,
    verdict: 'approve' as const,
    reviews: 'org/app#7',
    lessons: [],
    questions: [],
    mutationProbe: 'red: t1',
    analyzers: {
      'diff-review': 'pass',
      'spec-check': 'findings',
      security: 'pass',
      motion: 'skipped: no source',
    },
    ...over,
  });
  it('accepts a complete approval and lists what was skipped', () => {
    expect(checkReviewCaps(caps, report())).toEqual({ skipped: ['motion'], target: 'org/app#7' });
  });
  it('refuses a missing analyzer', () => {
    const r = report({
      analyzers: { 'diff-review': 'pass', 'spec-check': 'pass', motion: 'pass' },
    });
    expect(() => checkReviewCaps(caps, r)).toThrow(/security/);
  });
  it('refuses a mandatory analyzer that was skipped', () => {
    const r = report({
      analyzers: {
        'diff-review': 'pass',
        'spec-check': 'pass',
        security: 'skipped: x',
        motion: 'pass',
      },
    });
    expect(() => checkReviewCaps(caps, r)).toThrow(/security/);
  });
  it('refuses no analyzers at all', () => {
    const { analyzers: _a, ...rest } = report();
    expect(() => checkReviewCaps(caps, rest)).toThrow();
  });
  it('refuses a spec check without the probe', () => {
    const { mutationProbe: _m, ...rest } = report();
    expect(() => checkReviewCaps(caps, rest)).toThrow(/mutation_probe/);
  });
  it('refuses an approval whose probe stayed green: the test cannot fail', () => {
    expect(() => checkReviewCaps(caps, report({ mutationProbe: 'green: t1' }))).toThrow(/green/);
  });
  it('refuses a review of another pull request', () => {
    expect(() => checkReviewCaps(caps, report({ reviews: 'org/app#8' }))).toThrow(/reviews/);
    expect(() => checkReviewCaps(caps, report({ reviews: undefined }))).toThrow(/reviews/);
  });
  it('requested changes need no analyzers but the recorded target', () => {
    const r = {
      status: 'done' as const,
      verdict: 'changes_requested' as const,
      reviews: 'org/app#7',
      lessons: [],
      questions: [],
    };
    expect(checkReviewCaps(caps, r)).toEqual({ skipped: [], target: 'org/app#7' });
  });
  it.each(['changes_requested', 'approve'] as const)(
    'a %s report naming another pull request is refused',
    (verdict) => {
      const r = {
        status: 'done' as const,
        verdict,
        reviews: 'org/app#8',
        lessons: [],
        questions: [],
      };
      expect(() => checkReviewCaps(caps, r)).toThrow(/reviews/);
    },
  );
  it.each(['changes_requested', 'approve'] as const)(
    'a %s report without a recorded target is refused',
    (verdict) => {
      const r = {
        status: 'done' as const,
        verdict,
        reviews: 'org/app#7',
        lessons: [],
        questions: [],
      };
      const { reviewsTarget: _t, ...noTarget } = caps;
      expect(() => checkReviewCaps(noTarget, r)).toThrow(/relaunch/);
      expect(() => checkReviewCaps(undefined, r)).toThrow(/relaunch/);
    },
  );
  it('a blocked or failed report owes nothing and has no target', () => {
    const r = { status: 'blocked' as const, lessons: [], questions: [] };
    expect(checkReviewCaps(undefined, r)).toEqual({ skipped: [] });
  });
  it('refuses an approval without caps, also an unknown ones', () => {
    expect(() => checkReviewCaps(undefined, report())).toThrow(/relaunch/);
  });
});
