import { describe, expect, it } from 'vitest';
import type { Board, WorkItem } from '../src/board.js';
import { type StudioConfig, studioConfigSchema } from '../src/config.js';
import { type Capacity, isReady, planAssignments } from '../src/planner.js';

const config: StudioConfig = studioConfigSchema.parse({
  studio: 1,
  primaryRepo: 'org/app',
  repos: ['org/app'],
  ci: {
    provider: 'github',
    runners: 'github-hosted',
    runnerLabels: [],
    capacity: { total: 8, mergeMaxBusy: 5, checkTwiceSeconds: 30 },
  },
  merge: { strategy: 'studio-queue', contractPaths: [] },
  roles: {
    builder: { model: 'm', wip: 2 },
    reviewer: { model: 'm', wip: 1 },
  },
  ownerOnly: [],
  deployCommands: [],
});

const okCap: Capacity = { ciBusy: 0, ciTotal: 8, hostLoad: 0, ok: true };

function mk(id: string, extra: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    title: `Item ${id}`,
    type: 'fix',
    role: 'builder',
    repo: 'org/app',
    size: 'S',
    priority: 1,
    status: 'ready',
    paths: [],
    touches: [],
    dependsOn: [],
    dod: ['done'],
    history: [],
    ...extra,
  };
}

const board = (...items: WorkItem[]): Board => ({ items });
const ids = (r: { assign: WorkItem[] }) => r.assign.map((i) => i.id);
const wide: StudioConfig = {
  ...config,
  roles: { builder: { model: 'm', wip: 9, skills: { required: [], allowed: [], denied: [] } } },
};

describe('isReady', () => {
  it('requires title, dod, size, role, repo; feature also needs plan', () => {
    expect(isReady(mk('APP-1'))).toEqual({ ok: true, missing: [] });
    expect(isReady(mk('APP-1', { dod: [], title: '' })).missing).toEqual(['title', 'dod']);
    expect(isReady(mk('APP-1', { type: 'feature' })).missing).toEqual(['plan']);
    expect(isReady(mk('APP-1', { type: 'feature', plan: 'docs/p.md' })).ok).toBe(true);
  });
});

describe('planAssignments', () => {
  it('assigns highest priority first (lower number = higher priority, ties by natural id)', () => {
    const b = board(
      mk('APP-10', { priority: 2 }),
      mk('APP-3', { priority: 2 }),
      mk('APP-2', { priority: 1 }),
    );
    expect(ids(planAssignments(b, wide, okCap, {}))).toEqual(['APP-2', 'APP-3', 'APP-10']);
  });

  it('respects role wip', () => {
    const b = board(mk('APP-1'), mk('APP-2'), mk('APP-3'));
    expect(ids(planAssignments(b, config, okCap, {}))).toEqual(['APP-1', 'APP-2']);
    expect(ids(planAssignments(b, config, okCap, { builder: 1 }))).toEqual(['APP-1']);
    expect(ids(planAssignments(b, config, okCap, { builder: 5 }))).toEqual([]);
  });

  it('skips items with unmerged deps and reports them as waiting', () => {
    const b = board(
      mk('APP-1', { status: 'in_progress' }),
      mk('APP-2', { dependsOn: ['APP-1'] }),
      mk('APP-3', { status: 'merged' }),
      mk('APP-4', { dependsOn: ['APP-3'] }),
    );
    const r = planAssignments(b, config, okCap, {});
    expect(ids(r)).toEqual(['APP-4']);
    expect(r.blocked).toEqual([{ id: 'APP-2', reason: 'waiting on APP-1' }]);
  });

  it('reports cycle as blocked', () => {
    const b = board(mk('APP-1', { dependsOn: ['APP-2'] }), mk('APP-2', { dependsOn: ['APP-1'] }));
    const r = planAssignments(b, config, okCap, {});
    expect(r.assign).toEqual([]);
    expect(r.blocked).toEqual([
      { id: 'APP-1', reason: 'dependency cycle' },
      { id: 'APP-2', reason: 'dependency cycle' },
    ]);
  });

  it('terminates on a 3-node cycle, blocks its dependents, and reports a dangling dependency', () => {
    const b = board(
      mk('APP-1', { dependsOn: ['APP-3'] }),
      mk('APP-2', { dependsOn: ['APP-1'] }),
      mk('APP-3', { dependsOn: ['APP-2'] }),
      mk('APP-4', { dependsOn: ['APP-3'] }),
      mk('APP-5', { dependsOn: ['APP-9'] }),
      mk('APP-6', { dependsOn: ['APP-6'] }),
      mk('APP-7'),
    );
    const r = planAssignments(b, config, okCap, {});
    expect(ids(r)).toEqual(['APP-7']);
    expect(r.blocked).toEqual([
      { id: 'APP-1', reason: 'dependency cycle' },
      { id: 'APP-2', reason: 'dependency cycle' },
      { id: 'APP-3', reason: 'dependency cycle' },
      { id: 'APP-4', reason: 'dependency cycle' },
      { id: 'APP-5', reason: 'unknown dependency APP-9' },
      { id: 'APP-6', reason: 'dependency cycle' },
    ]);
  });

  it('assigns no build items when capacity not ok but still assigns docs/research', () => {
    const b = board(
      mk('APP-1'),
      mk('APP-2', { type: 'docs' }),
      mk('APP-3', { type: 'research', role: 'reviewer' }),
    );
    const r = planAssignments(b, config, { ...okCap, ok: false }, {});
    expect(ids(r)).toEqual(['APP-2', 'APP-3']);
    expect(r.blocked).toEqual([]);
  });

  it('limits build items to mergeMaxBusy minus ciBusy', () => {
    const b = board(mk('APP-1'), mk('APP-2'));
    expect(ids(planAssignments(b, config, { ...okCap, ciBusy: 4 }, {}))).toEqual(['APP-1']);
    expect(ids(planAssignments(b, config, { ...okCap, ciBusy: 7 }, {}))).toEqual([]);
  });

  it('ownerOnly item is never assigned', () => {
    const b = board(mk('APP-1', { ownerOnly: true }), mk('APP-2'));
    const r = planAssignments(b, config, okCap, {});
    expect(ids(r)).toEqual(['APP-2']);
    expect(r.blocked).toEqual([{ id: 'APP-1', reason: 'owner only' }]);
  });

  it('reports a role that is not configured', () => {
    const r = planAssignments(board(mk('APP-1', { role: 'designer' })), config, okCap, {});
    expect(r.blocked).toEqual([{ id: 'APP-1', reason: 'role not configured' }]);
  });

  it('feature without plan is reported not-ready with missing ["plan"]', () => {
    const r = planAssignments(board(mk('APP-1', { type: 'feature' })), config, okCap, {});
    expect(r.assign).toEqual([]);
    expect(r.blocked).toEqual([{ id: 'APP-1', reason: 'not ready: missing plan' }]);
  });

  it('never assigns two items whose touches overlap or that list each other in conflictsWith, nor one overlapping a running item', () => {
    // segment prefix and equality inside the plan
    let r = planAssignments(
      board(
        mk('APP-1', { touches: ['src/**'] }),
        mk('APP-2', { touches: ['src/a/b.ts'] }),
        mk('APP-3', { touches: ['docs/**'] }),
      ),
      wide,
      okCap,
      {},
    );
    expect(ids(r)).toEqual(['APP-1', 'APP-3']);
    // sibling directory with a shared textual prefix does not overlap
    r = planAssignments(
      board(mk('APP-1', { touches: ['src/a/**'] }), mk('APP-2', { touches: ['src/ab/**'] })),
      wide,
      okCap,
      {},
    );
    expect(ids(r)).toEqual(['APP-1', 'APP-2']);
    // a glob starting mid-segment is treated conservatively (prefix cut back to the last '/')
    r = planAssignments(
      board(mk('APP-1', { touches: ['src/foo*'] }), mk('APP-2', { touches: ['src/foobar/x.ts'] })),
      wide,
      okCap,
      {},
    );
    expect(ids(r)).toEqual(['APP-1']);
    r = planAssignments(
      board(mk('APP-1', { touches: ['src/a*.ts'] }), mk('APP-2', { touches: ['src/ab.ts'] })),
      wide,
      okCap,
      {},
    );
    expect(ids(r)).toEqual(['APP-1']);
    // empty static prefix overlaps everything
    r = planAssignments(
      board(mk('APP-1', { touches: ['**/*.ts'] }), mk('APP-2', { touches: ['docs/x.md'] })),
      wide,
      okCap,
      {},
    );
    expect(ids(r)).toEqual(['APP-1']);
    // conflictsWith is symmetric (listed on one side only)
    r = planAssignments(
      board(mk('APP-1'), mk('APP-2', { conflictsWith: ['APP-1'] })),
      wide,
      okCap,
      {},
    );
    expect(ids(r)).toEqual(['APP-1']);
    // against an active board item (R7), by touches and by conflictsWith
    r = planAssignments(
      board(
        mk('APP-1', { status: 'in_progress', touches: ['src/**'] }),
        mk('APP-2', { touches: ['src/x.ts'] }),
        mk('APP-3', { conflictsWith: ['APP-1'] }),
        mk('APP-4', { touches: ['docs/x.md'] }),
      ),
      wide,
      okCap,
      {},
    );
    expect(ids(r)).toEqual(['APP-4']);
  });
});
