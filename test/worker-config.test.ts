import { describe, expect, it } from 'vitest';
import { type Board, workItemSchema } from '../src/board.js';
import { ownerConfigSchema, parseConfig } from '../src/config.js';
import { planAssignments } from '../src/planner.js';

const YAML = `studio: 1
primary_repo: org/app
repos: [org/app]
ci:
  provider: github
  runners: github-hosted
  runner_labels: []
  capacity: { total: 4, merge_max_busy: 3, check_twice_seconds: 30 }
merge: { strategy: studio-queue, contract_paths: [] }
roles:
  builder: { model: sonnet, wip: 1 }
`;

describe('worker settings', () => {
  it('studio.yaml declares a deny list per label', () => {
    const c = parseConfig(
      `${YAML}workers:\n  windows:\n    deny: { paths: ["D:\\\\data", "/srv/backup"], ports: [5432] }\n  lab: {}\n`,
      'studio.yaml',
    );
    expect(c.workers).toEqual({
      windows: { deny: { paths: ['D:\\data', '/srv/backup'], ports: [5432] } },
      lab: { deny: { paths: [], ports: [] } },
    });
  });
  it('refuses relative and network paths, bad ports and bad labels', () => {
    const bad = (workers: string) => () =>
      parseConfig(`${YAML}workers:\n${workers}`, 'studio.yaml');
    expect(bad('  windows: { deny: { paths: ["data"] } }\n')).toThrow(/absolute path/);
    expect(bad('  windows: { deny: { paths: ["\\\\\\\\server\\\\share"] } }\n')).toThrow(
      /network paths are not supported/,
    );
    expect(bad('  windows: { deny: { ports: [70000] } }\n')).toThrow(/ports/);
    expect(bad('  Windows: {}\n')).toThrow(/workers/);
    expect(bad('  windows: { deny: {}, extra: 1 }\n')).toThrow(/unknown key/);
  });
  it('the owner config holds the accepted logins and this machine as a worker', () => {
    const o = ownerConfigSchema.parse({
      workers: { accept: { windows: ['win-bot'] }, self: { lead: 'lead-user' } },
    });
    expect(o.workers).toEqual({
      accept: { windows: ['win-bot'] },
      self: { lead: 'lead-user', deny: { paths: [], ports: [] }, leaseMinutes: 30 },
    });
    expect(() => ownerConfigSchema.parse({ workers: { accept: { windows: ['-bad'] } } })).toThrow();
    expect(() =>
      ownerConfigSchema.parse({ workers: { self: { lead: 'x', leaseMinutes: 5 } } }),
    ).toThrow();
  });
});

const item = (id: string, extra: Record<string, unknown> = {}) =>
  workItemSchema.parse({
    id,
    title: `Item ${id}`,
    type: 'fix',
    role: 'builder',
    repo: 'org/app',
    size: 'S',
    priority: 1,
    status: 'ready',
    touches: [`${id.toLowerCase()}/**`],
    dod: ['done'],
    ...extra,
  });

const capacity = { ciBusy: 0, ciTotal: 4, hostLoad: 0, ok: true, hostOk: true };
const config = parseConfig(YAML, 'studio.yaml');

describe('planning items for workers', () => {
  it('offers them beside local work: no role wip, no credential slot, no host load', () => {
    const board: Board = {
      items: [
        item('APP-1', { runsOn: 'windows' }),
        item('APP-2'),
        item('APP-3', { runsOn: 'windows' }),
      ],
    };
    const p = planAssignments(board, config, { ...capacity, hostOk: false }, {}, undefined, 0);
    expect(p.offer.map((i) => i.id)).toEqual(['APP-1', 'APP-3']);
    expect(p.assign).toEqual([]);
    expect(p.deferred).toEqual([{ id: 'APP-2', reason: 'credential limit' }]);
  });
  it('holds them for a pause, a block or the cost cap, and for overlaps and dependencies', () => {
    const board: Board = {
      items: [
        item('APP-1', { runsOn: 'windows', touches: ['shared/**'] }),
        item('APP-2', { status: 'in_progress', touches: ['shared/x/**'] }),
        item('APP-3', { runsOn: 'windows', dependsOn: ['APP-2'] }),
        item('APP-4', { runsOn: 'windows' }),
      ],
    };
    const p = planAssignments(
      board,
      config,
      capacity,
      {},
      undefined,
      undefined,
      undefined,
      'paused',
    );
    expect(p.offer).toEqual([]);
    expect(p.deferred).toContainEqual({ id: 'APP-4', reason: 'paused' });
    const q = planAssignments(board, config, capacity, {});
    expect(q.offer.map((i) => i.id)).toEqual(['APP-4']);
    expect(q.deferred).toContainEqual({ id: 'APP-1', reason: 'overlaps APP-2' });
    expect(q.blocked).toContainEqual({ id: 'APP-3', reason: 'waiting on APP-2' });
  });
  it('a review or a release never runs on a worker', () => {
    const board: Board = {
      items: [
        item('APP-1', {
          runsOn: 'windows',
          type: 'review',
          role: 'reviewer',
          notes: ['review org/app#1'],
        }),
      ],
    };
    const cfg = parseConfig(`${YAML}  reviewer: { model: opus, wip: 1 }\n`, 'studio.yaml');
    const p = planAssignments(board, cfg, capacity, {});
    expect(p.blocked).toEqual([
      { id: 'APP-1', reason: expect.stringMatching(/a review item stays with the lead/) },
    ]);
  });
});
