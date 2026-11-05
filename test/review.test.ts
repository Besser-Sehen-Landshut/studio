import { describe, expect, it } from 'vitest';
import type { Board, WorkItem } from '../src/board.js';
import type { Ports } from '../src/ports.js';
import {
  checkReviewCaps,
  gateRules,
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

const PR_HEAD = { headRefOid: 'a'.repeat(40), baseRefName: 'main', isCrossRepository: false };

describe('readPrFacts', () => {
  const target = { repo: 'org/app', pr: 7 };
  it('counts lines without markdown', async () => {
    const out = JSON.stringify({
      ...PR_HEAD,
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
      head: PR_HEAD.headRefOid,
      base: 'main',
      title: '',
      body: '',
      crossRepository: false,
    });
  });
  it('fewer files than changed is incomplete', async () => {
    const out = JSON.stringify({
      ...PR_HEAD,
      changedFiles: 200,
      files: [{ path: 'a', additions: 1, deletions: 0 }],
    });
    expect((await readPrFacts(ghWith(0, out), target))?.complete).toBe(false);
  });
  it('a fork is reported as such', async () => {
    const out = JSON.stringify({
      ...PR_HEAD,
      isCrossRepository: true,
      changedFiles: 0,
      files: [],
    });
    expect((await readPrFacts(ghWith(0, out), target))?.crossRepository).toBe(true);
  });
  it.each([
    [1, '{}'],
    [0, 'nope'],
    [0, '{}'],
    [0, '{"changedFiles":0,"files":[],"isCrossRepository":false}'],
    [0, '{"changedFiles":0,"files":[],"headRefOid":"zz","isCrossRepository":false}'],
    [0, `{"changedFiles":0,"files":[],"headRefOid":"${'a'.repeat(40)}"}`],
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
  it('says how to get the head, and runs the probe last and alone', () => {
    const t = renderReviewRoutine({
      tier: 'small',
      reasons: [],
      analyzers: [],
      skipped: [],
      contract: '/c',
      round: 0,
      pr: 41,
    }).join('\n');
    expect(t).toContain('git fetch origin pull/41/head');
    expect(t).toContain('git reset --hard FETCH_HEAD');
    expect(t).toMatch(/last and alone/);
    expect(t).toContain('git checkout -- <file>');
  });
  it('approves code that is fine with green checks; changes only for a change the code needs', () => {
    expect(text).toMatch(/If the code is fine and the checks are green, the verdict is `approve`/);
    expect(text).toMatch(/`changes_requested` only for a change the code needs/);
    expect(text).toMatch(/Checks still running are never a reason for `changes_requested`/);
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
    headRefOid: PR_HEAD.headRefOid,
    baseRefName: 'main',
  };
  const report = (over = {}) => ({
    status: 'done' as const,
    verdict: 'approve' as const,
    reviews: 'org/app#7',
    headSha: PR_HEAD.headRefOid,
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
  it('refuses an approval of another head than launch saw: its tier may be wrong', () => {
    const r = report({ headSha: 'b'.repeat(40) });
    expect(() => checkReviewCaps(caps, r)).toThrow(/relaunch/);
  });
  it('refuses an approval when the record holds no head', () => {
    const { headRefOid: _, ...old } = caps;
    expect(() => checkReviewCaps(old, report())).toThrow(/relaunch/);
  });
  it('a request for changes on another head still counts', () => {
    const r = report({ headSha: 'b'.repeat(40), verdict: 'changes_requested' });
    expect(checkReviewCaps(caps, r).target).toBe('org/app#7');
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
  it('a large tier cannot skip the probe; a small one can', () => {
    expect(() => checkReviewCaps(caps, report({ mutationProbe: 'skipped: no test' }))).toThrow(
      /large/,
    );
    expect(
      checkReviewCaps(
        { ...caps, tier: 'small' as const },
        report({ mutationProbe: 'skipped: small tier' }),
      ),
    ).toEqual({ skipped: ['motion'], target: 'org/app#7' });
  });
  it('what launch skipped reaches the lead, by id', () => {
    const r = report({
      analyzers: { 'diff-review': 'pass', 'spec-check': 'pass', security: 'pass', motion: 'pass' },
    });
    expect(
      checkReviewCaps({ ...caps, skipped: ['design-detector', 'gha-security'] }, r).skipped,
    ).toEqual(['design-detector', 'gha-security']);
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

describe('the gate per pull request', () => {
  const base = { tier: 'small' as const, afterFix: false, fixItem: false };
  it('diff review and spec check are mandatory for every pull request, each with its reason', () => {
    const g = gateRules({ ...base, ids: ['diff-review', 'spec-check', 'similar-bugs'] });
    expect(g.mandatory.map((m) => m.id)).toEqual(['diff-review', 'spec-check']);
    for (const m of g.mandatory) expect(m.why).toMatch(/every pull request/);
    expect(g.probeRequired).toBeUndefined();
  });
  it('a small change without risk names what it leaves out, and why', () => {
    const g = gateRules({ ...base, ids: ['diff-review', 'spec-check', 'similar-bugs'] });
    expect(g.notRun.map((n) => n.id)).toEqual(['security', 'performance']);
    expect(g.notRun[0]?.why).toMatch(/no risk tag/);
  });
  it('security is mandatory with the reason launch found', () => {
    const g = gateRules({
      ...base,
      ids: ['diff-review', 'spec-check', 'security', 'similar-bugs'],
      securityWhy: 'a contract path changed (merge.contract_paths: api/**)',
    });
    expect(g.mandatory.find((m) => m.id === 'security')?.why).toContain('contract path');
  });
  it('similar bugs is owed after a fix round, else when diff review reports findings', () => {
    const ids = ['diff-review', 'spec-check', 'similar-bugs'];
    expect(gateRules({ ...base, ids }).onFinding).toEqual(['similar-bugs']);
    const fix = gateRules({ ...base, ids, afterFix: true });
    expect(fix.mandatory.map((m) => m.id)).toContain('similar-bugs');
    expect(fix.onFinding).toEqual([]);
  });
  it('performance is owed in the large tier; the probe must run for a fix and in the large tier', () => {
    const ids = ['diff-review', 'spec-check', 'similar-bugs', 'performance'];
    const large = gateRules({ ...base, tier: 'large', ids });
    expect(large.mandatory.map((m) => m.id)).toContain('performance');
    expect(large.probeRequired).toMatch(/large/);
    expect(gateRules({ ...base, ids, fixItem: true }).probeRequired).toMatch(/fix/);
    expect(gateRules({ ...base, ids, afterFix: true }).probeRequired).toMatch(/fix round/);
  });
  it('the routine states each mandatory analyzer and each left out, one line each', () => {
    const text = renderReviewRoutine({
      tier: 'small',
      reasons: [],
      analyzers: [
        { id: 'diff-review', path: '/c/diff-review.md', why: 'every pull request' },
        { id: 'spec-check', path: '/c/spec-check.md', why: 'every pull request' },
        { id: 'similar-bugs', path: '/c/similar-bugs.md', onFinding: true },
      ],
      notRun: [{ id: 'security', why: 'no risk tag, no security-sensitive or contract path' }],
      probeRequired: 'the change is a fix',
      skipped: [],
      contract: '/c/CONTRACT.md',
      round: 0,
    }).join('\n');
    expect(text).toContain('- diff-review: mandatory: every pull request');
    expect(text).toContain('- spec-check: mandatory: every pull request');
    expect(text).toMatch(/- similar-bugs: mandatory when diff-review reports findings/);
    expect(text).toContain('- security: not run: no risk tag');
    expect(text).toMatch(/mutation probe must run: the change is a fix/);
  });
});

describe('collect refuses an approval that owes a mandatory analyzer', () => {
  const caps = {
    tier: 'small' as const,
    analyzers: ['diff-review', 'spec-check', 'similar-bugs', 'accessibility'],
    mandatory: ['diff-review', 'spec-check'],
    onFinding: ['similar-bugs'],
    reviewsTarget: 'org/app#7',
    headRefOid: 'a'.repeat(40),
    baseRefName: 'main',
  };
  const report = (analyzers: Record<string, string>, over = {}) => ({
    status: 'done' as const,
    verdict: 'approve' as const,
    reviews: 'org/app#7',
    headSha: 'a'.repeat(40),
    lessons: [],
    questions: [],
    mutationProbe: 'red: t1',
    analyzers,
    ...over,
  });
  it('lists every missing and every skipped mandatory analyzer at once', () => {
    expect(() =>
      checkReviewCaps(caps, report({ 'diff-review': 'skipped: no time', 'similar-bugs': 'pass' })),
    ).toThrow(/no result for spec-check, accessibility; mandatory analyzer skipped: diff-review/);
  });
  it('similar bugs may skip only while diff review found nothing', () => {
    const ok = { 'spec-check': 'pass', accessibility: 'pass' };
    expect(
      checkReviewCaps(
        caps,
        report({ ...ok, 'diff-review': 'pass', 'similar-bugs': 'skipped: no finding' }),
      ).skipped,
    ).toEqual(['similar-bugs']);
    expect(() =>
      checkReviewCaps(
        caps,
        report({ ...ok, 'diff-review': 'findings', 'similar-bugs': 'skipped: no time' }),
      ),
    ).toThrow(/mandatory analyzer skipped: similar-bugs/);
  });
  it('a fix needs a probe that ran, also in the small tier', () => {
    const all = {
      'diff-review': 'pass',
      'spec-check': 'pass',
      'similar-bugs': 'pass',
      accessibility: 'pass',
    };
    expect(() =>
      checkReviewCaps(
        { ...caps, probeRequired: true },
        report(all, { mutationProbe: 'skipped: no test' }),
      ),
    ).toThrow(/fix without a mutation probe that ran/);
    expect(checkReviewCaps(caps, report(all, { mutationProbe: 'skipped: docs' })).skipped).toEqual(
      [],
    );
  });
});
