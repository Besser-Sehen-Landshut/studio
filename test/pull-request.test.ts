import { describe, expect, it } from 'vitest';
import { type WorkItem, workItemSchema } from '../src/board.js';
import type { Ports } from '../src/ports.js';
import { openCrewPr } from '../src/pull-request.js';

const item: WorkItem = workItemSchema.parse({
  id: 'APP-1',
  title: 't',
  type: 'fix',
  role: 'builder',
  repo: 'org/app',
  size: 'S',
  priority: 1,
  status: 'in_progress',
  dod: ['d'],
});

const capacity = { ciBusy: 0, ciTotal: 0, hostLoad: 0, ok: true, hostOk: true };

describe('openCrewPr', () => {
  it('never renews a pull request from a fork that names its branch studio/<id>', async () => {
    const calls: string[] = [];
    const ports = {
      gh: {
        async api() {
          return '';
        },
        async run(args: string[]) {
          const line = args.join(' ');
          calls.push(line);
          if (line.startsWith('pr list')) {
            return {
              code: 0,
              stdout: JSON.stringify([{ number: 5, isCrossRepository: true }]),
              stderr: '',
            };
          }
          return { code: 0, stdout: 'https://github.com/org/app/pull/8\n', stderr: '' };
        },
      },
    } as unknown as Ports;
    const r = await openCrewPr(
      ports,
      item,
      'APP-1: t',
      'body',
      [],
      'tok',
      async () => ({ ok: true, capacity }),
      () => {},
    );
    expect(r).toEqual({ pr: 8 });
    expect(calls[0]).toContain('--json number,isCrossRepository');
    expect(calls.some((c) => c.startsWith('pr edit 5'))).toBe(false);
  });
});
