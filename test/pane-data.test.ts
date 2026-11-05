import { mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Board, WorkItem } from '../src/board.js';
import {
  clockTime,
  leadDecisions,
  paneItems,
  readTickRecord,
  TICK_FILE,
  writeTickRecord,
} from '../src/pane-data.js';
import type { QueueState } from '../src/queue.js';

const T0 = '2026-11-01T10:00:00.000Z';

function item(id: string, over: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    title: `Title of ${id}`,
    type: 'feature',
    role: 'builder',
    repo: 'org/app',
    size: 'S',
    priority: 1,
    status: 'ready',
    paths: [],
    touches: [],
    dependsOn: [],
    dod: [],
    history: [],
    ...over,
  };
}

const board = (items: WorkItem[]): Board => ({ items }) as Board;
const NO_QUEUE: QueueState = { pending: [], done: [] };
const CI = { busy: 6, total: 8, mergeMaxBusy: 5, ok: true };
const at = (t: string, from: WorkItem['status'], to: WorkItem['status']) => ({
  at: t,
  from,
  to,
  by: 'studio',
});

describe('paneItems', () => {
  it('lists every non-terminal item that is no review, with its stage', () => {
    const items = paneItems(
      board([
        item('APP-1'),
        item('APP-2', { status: 'assigned' }),
        item('APP-3', { status: 'in_progress' }),
        item('APP-4', { status: 'in_review', pr: 4 }),
        item('APP-5', { status: 'queued', pr: 5 }),
        item('APP-6', { status: 'blocked', notes: ['needs a key'] }),
        item('APP-7', { status: 'merged' }),
        item('APP-8', { status: 'dropped' }),
        item('APP-9', { type: 'review', role: 'reviewer', status: 'in_progress' }),
      ]),
      NO_QUEUE,
      CI,
    );
    expect(items.map((i) => [i.id, i.stage])).toEqual([
      ['APP-1', 'ready'],
      ['APP-2', 'building'],
      ['APP-3', 'building'],
      ['APP-4', 'review'],
      ['APP-5', 'queued'],
      ['APP-6', 'blocked'],
    ]);
    expect(items[0]).toEqual({
      id: 'APP-1',
      title: 'Title of APP-1',
      type: 'feature',
      status: 'ready',
      stage: 'ready',
    });
  });

  it('carries epic and components when given', () => {
    const [row] = paneItems(board([item('APP-1', { epic: 'E-1' })]), NO_QUEUE, CI, {
      componentsOf: () => ['api'],
    });
    expect(row).toMatchObject({ epic: 'E-1', components: ['api'] });
  });

  it('takes the time the item entered its stage, across statuses of one stage', () => {
    const [row] = paneItems(
      board([
        item('APP-1', {
          status: 'in_progress',
          history: [
            at('2026-11-01T08:00:00.000Z', 'ready', 'assigned'),
            at('2026-11-01T09:00:00.000Z', 'assigned', 'in_progress'),
          ],
        }),
      ]),
      NO_QUEUE,
      CI,
    );
    expect(row?.since).toBe('2026-11-01T08:00:00.000Z');
  });

  it('a pull request held for CI is pr_held with the CI figures', () => {
    const [row] = paneItems(
      board([
        item('APP-1', {
          status: 'in_progress',
          notes: ['pr held: ci capacity (busy 6 of 8, limit 5)'],
        }),
      ]),
      NO_QUEUE,
      CI,
    );
    expect(row).toMatchObject({
      stage: 'pr_held',
      wait: { code: 'ci_capacity', busy: 6, total: 8, max: 5 },
    });
    expect(row?.wait?.text).toBe('ci capacity (busy 6 of 8, limit 5)');
  });

  it('a review that has not started is review pending; a running one has no wait', () => {
    const items = paneItems(
      board([
        item('APP-1', { status: 'in_review', pr: 4 }),
        item('APP-2', { status: 'in_review', pr: 5 }),
        item('APP-3', {
          type: 'review',
          role: 'reviewer',
          status: 'ready',
          notes: ['review org/app#4'],
        }),
        item('APP-4', {
          type: 'review',
          role: 'reviewer',
          status: 'in_progress',
          notes: ['review org/app#5'],
        }),
      ]),
      NO_QUEUE,
      CI,
    );
    expect(items[0]?.wait).toEqual({ code: 'review_pending', text: 'review APP-3 not started' });
    expect(items[1]?.wait).toBeUndefined();
  });

  it('queued items wait on the queue step or their place', () => {
    const items = paneItems(
      board([
        item('APP-1', { status: 'queued', pr: 1 }),
        item('APP-2', { status: 'queued', pr: 2 }),
        item('APP-3', { status: 'queued', pr: 3 }),
      ]),
      {
        current: { pr: 1, repo: 'org/app', item: 'APP-1', step: 'checks' },
        pending: [
          { pr: 9, repo: 'org/app' },
          { pr: 2, repo: 'org/app', item: 'APP-2' },
          { pr: 3, repo: 'org/app' },
        ],
        done: [],
      },
      CI,
    );
    expect(items.map((i) => i.wait)).toEqual([
      { code: 'checks_pending', text: 'checks pending' },
      { code: 'queue_position', text: 'place 2 in the queue', position: 2 },
      { code: 'queue_position', text: 'place 3 in the queue', position: 3 },
    ]);
  });

  it('a queue that waits for CI capacity names the CI figures', () => {
    const [row] = paneItems(
      board([item('APP-1', { status: 'queued', pr: 1 })]),
      {
        current: { pr: 1, repo: 'org/app', item: 'APP-1', step: 'capacity' },
        pending: [],
        done: [],
      },
      CI,
    );
    expect(row?.wait).toMatchObject({ code: 'ci_capacity', busy: 6, total: 8, max: 5 });
  });

  it('a held queue from the latest tick is the wait of every queued item not in progress', () => {
    const items = paneItems(
      board([item('APP-1', { status: 'queued', pr: 1 })]),
      { pending: [{ pr: 1, repo: 'org/app', item: 'APP-1' }], done: [] },
      CI,
      {
        tick: {
          at: T0,
          needsLead: [],
          held: [{ item: 'queue', reason: 'paused: nothing is merged' }],
        },
      },
    );
    expect(items[0]?.wait).toEqual({ code: 'queue_held', text: 'paused: nothing is merged' });
  });

  it('a ready item the latest tick deferred carries the reason', () => {
    const [row] = paneItems(board([item('APP-1')]), NO_QUEUE, CI, {
      tick: { at: T0, needsLead: [], held: [{ item: 'APP-1', reason: 'wip builder 2/2' }] },
    });
    expect(row?.wait).toEqual({ code: 'held', text: 'wip builder 2/2' });
  });

  it('strips control characters from titles and reasons', () => {
    const [row] = paneItems(
      board([item('APP-1', { title: 'a\u001b[31mb', status: 'blocked', notes: ['x\u0007y'] })]),
      NO_QUEUE,
      CI,
    );
    expect(row?.title).toBe('a[31mb');
    expect(row?.wait).toEqual({ code: 'blocked', text: 'xy' });
  });
});

describe('leadDecisions', () => {
  const tick = (needsLead: { item: string; reason: string }[]) => ({ at: T0, needsLead, held: [] });

  it('classifies the reason and suggests a next step the owner can say', () => {
    const out = leadDecisions(
      tick([
        { item: 'APP-1', reason: 'blocked: fix limit reached: 6 review rounds' },
        {
          item: 'APP-2',
          reason:
            'changes requested by APP-9: blocked → ready with the findings, then the fix round',
        },
        { item: 'APP-3', reason: 'merge failed: checks red; fix it through a crew and a review' },
        { item: 'APP-4', reason: 'blocked: needs a key' },
        { item: 'APP-5', reason: 'the report cannot be read; studio stop APP-5 --requeue' },
      ]),
      board(['APP-1', 'APP-2', 'APP-3', 'APP-4', 'APP-5'].map((id) => item(id))),
    );
    expect(out).toEqual([
      {
        item: 'APP-1',
        code: 'fix_limit',
        reason: 'fix limit reached: 6 review rounds',
        next: { say: 'show APP-1' },
      },
      {
        item: 'APP-2',
        code: 'changes_requested',
        reason: 'changes requested by APP-9',
        next: { say: 'start the fix round for APP-2' },
      },
      {
        item: 'APP-3',
        code: 'merge_failed',
        reason: 'merge failed: checks red',
        next: { say: 'show why APP-3 did not merge' },
      },
      { item: 'APP-4', code: 'blocked', reason: 'needs a key', next: { say: 'show APP-4' } },
      {
        item: 'APP-5',
        code: 'other',
        reason: 'the report cannot be read',
        next: { say: 'show APP-5' },
      },
    ]);
  });

  it('leaves out items that are merged or dropped by now', () => {
    const out = leadDecisions(
      tick([
        { item: 'APP-1', reason: 'blocked: x' },
        { item: 'APP-2', reason: 'blocked: y' },
      ]),
      board([item('APP-1', { status: 'merged' }), item('APP-2')]),
    );
    expect(out.map((d) => d.item)).toEqual(['APP-2']);
  });

  it('is empty without a tick record', () => {
    expect(leadDecisions(undefined, board([item('APP-1')]))).toEqual([]);
  });
});

describe('the tick record', () => {
  const root = () => realpathSync(mkdtempSync(join(tmpdir(), 'studio-tick-')));

  it('round-trips needsLead and held', () => {
    const dir = root();
    const rec = {
      at: T0,
      needsLead: [{ item: 'APP-1', reason: 'blocked: x' }],
      held: [{ item: 'queue', reason: 'busy' }],
    };
    writeTickRecord(dir, rec);
    expect(JSON.parse(readFileSync(join(dir, TICK_FILE), 'utf8'))).toEqual(rec);
    expect(readTickRecord(dir)).toEqual(rec);
  });

  it('reads a missing, broken or wrong-shaped file as none, and drops bad rows', () => {
    const dir = root();
    expect(readTickRecord(dir)).toBeUndefined();
    writeFileSync(join(dir, TICK_FILE), '{');
    expect(readTickRecord(dir)).toBeUndefined();
    writeFileSync(
      join(dir, TICK_FILE),
      JSON.stringify({ at: T0, needsLead: [{ item: 1 }, { item: 'A-1', reason: 'r' }], held: 3 }),
    );
    expect(readTickRecord(dir)).toEqual({
      at: T0,
      needsLead: [{ item: 'A-1', reason: 'r' }],
      held: [],
    });
  });

  it('does not read through a symlink', () => {
    const dir = root();
    const other = join(dir, 'other.json');
    writeFileSync(other, JSON.stringify({ at: T0, needsLead: [], held: [] }));
    symlinkSync(other, join(dir, TICK_FILE));
    expect(readTickRecord(dir)).toBeUndefined();
  });
});

describe('clockTime', () => {
  it('is HH:MM in the given time zone, UTC without one', () => {
    expect(clockTime('2026-11-01T13:02:00.000Z', 'Europe/Berlin')).toBe('14:02');
    expect(clockTime('2026-11-01T13:02:00.000Z', undefined)).toBe('13:02');
    expect(clockTime('2026-11-01T13:02:00.000Z', 'Not/AZone')).toBe('13:02');
  });
});
