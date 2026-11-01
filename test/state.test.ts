import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { StudioConfig } from '../src/config.js';
import { type CrewRecord, crewStateOf } from '../src/crew.js';
import { readMainBuild } from '../src/main-build.js';
import { STATE_FILES } from '../src/paths.js';
import { clearPause, readPause, setPause } from '../src/pause.js';
import type { Ports } from '../src/ports.js';

const tmp = mkdtempSync(join(tmpdir(), 'studio-state-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const rec = (extra: Partial<CrewRecord> = {}): CrewRecord => ({
  name: 'builder-APP-1',
  item: 'APP-1',
  role: 'builder',
  pid: 4242,
  log: 'x.jsonl',
  startedAt: '2026-11-01T09:00:00Z',
  ...extra,
});

describe('crewStateOf', () => {
  const stoppedAt = '2026-11-01T09:30:00Z';
  const rows: [string, CrewRecord, string, boolean, boolean, string][] = [
    ['merged', rec(), 'merged', false, false, 'done'],
    ['dropped', rec(), 'dropped', false, true, 'done'],
    ['merged, still alive', rec(), 'merged', true, false, 'done'],
    ['stopped', rec({ stoppedAt }), 'in_progress', false, false, 'stopped'],
    ['stopped beats blocked', rec({ stoppedAt }), 'blocked', false, false, 'stopped'],
    ['blocked', rec(), 'blocked', false, false, 'blocked'],
    ['in_review', rec(), 'in_review', false, false, 'waiting'],
    ['queued', rec(), 'queued', false, false, 'waiting'],
    ['assigned alive', rec(), 'assigned', true, false, 'working'],
    ['in_progress alive', rec(), 'in_progress', true, false, 'working'],
    ['assigned with a report', rec(), 'assigned', false, true, 'waiting'],
    ['in_progress with a report', rec(), 'in_progress', false, true, 'waiting'],
    ['assigned, gone, no report', rec(), 'assigned', false, false, 'crashed'],
    ['in_progress, gone, no report', rec(), 'in_progress', false, false, 'crashed'],
    ['alive in review', rec(), 'in_review', true, false, 'working'],
    ['alive blocked', rec(), 'blocked', true, false, 'working'],
    ['alive queued', rec(), 'queued', true, false, 'working'],
  ];
  it.each(rows)('%s', (_name, record, status, alive, hasReport, expected) => {
    expect(crewStateOf(record, status, alive, hasReport)).toBe(expected);
  });
});

const CONFIG = { primaryRepo: 'org/app' } as StudioConfig;
function ghWith(reply: { code?: number; stdout?: string } | Error) {
  const calls: string[][] = [];
  const timeouts: Array<number | undefined> = [];
  const ports = {
    gh: {
      async run(args: string[], opts?: { timeoutMs?: number }) {
        calls.push(args);
        timeouts.push(opts?.timeoutMs);
        if (reply instanceof Error) throw reply;
        return { code: reply.code ?? 0, stdout: reply.stdout ?? '', stderr: '' };
      },
    },
  } as unknown as Ports;
  return { ports, calls, timeouts };
}
const run = (
  workflowName: string,
  status: string,
  conclusion: string,
  headSha = 'a'.repeat(40),
) => ({ workflowName, status, conclusion, headSha });

describe('readMainBuild', () => {
  const read = (runs: unknown) =>
    readMainBuild(CONFIG, ghWith({ stdout: JSON.stringify(runs) }).ports);

  it('asks gh for push runs of main of the primary repo', async () => {
    const g = ghWith({ stdout: '[]' });
    await readMainBuild(CONFIG, g.ports);
    expect(g.calls[0]).toEqual([
      'run',
      'list',
      '--repo',
      'org/app',
      '--branch',
      'main',
      '--event',
      'push',
      '--limit',
      '30',
      '--json',
      'status,conclusion,headSha,workflowName',
    ]);
  });

  it('reads with a 30 s timeout', async () => {
    const g = ghWith({ stdout: '[]' });
    await readMainBuild(CONFIG, g.ports);
    expect(g.timeouts).toEqual([30_000]);
  });

  it('green when the newest run of every workflow succeeded', async () => {
    expect(
      await read([run('ci', 'completed', 'success'), run('deploy', 'completed', 'success')]),
    ).toMatchObject({ status: 'green' });
  });

  it('only the newest run per workflow counts', async () => {
    const r = await read([run('ci', 'completed', 'success'), run('ci', 'completed', 'failure')]);
    expect(r.status).toBe('green');
  });

  it.each(['failure', 'timed_out', 'startup_failure'])(
    '%s is red, with sha and workflow',
    async (c) => {
      const sha = 'b'.repeat(40);
      expect(
        await read([run('ci', 'completed', 'success'), run('deploy', 'completed', c, sha)]),
      ).toEqual({ status: 'red', sha, workflow: 'deploy' });
    },
  );

  it('red wins over pending; the first red run is reported', async () => {
    const r = await read([
      run('a', 'in_progress', ''),
      run('b', 'completed', 'failure', 'c'.repeat(40)),
      run('c', 'completed', 'timed_out', 'd'.repeat(40)),
    ]);
    expect(r).toMatchObject({ status: 'red', workflow: 'b' });
  });

  it('pending when a run is not completed', async () => {
    expect((await read([run('ci', 'queued', ''), run('d', 'completed', 'success')])).status).toBe(
      'pending',
    );
    expect((await read([run('ci', 'in_progress', '')])).status).toBe('pending');
  });

  it('cancelled and skipped are not red', async () => {
    expect(
      (await read([run('a', 'completed', 'cancelled'), run('b', 'completed', 'skipped')])).status,
    ).toBe('green');
  });

  it('unknown without runs', async () => {
    expect(await read([])).toEqual({ status: 'unknown' });
  });

  it.each([
    ['malformed JSON', { stdout: '{nope' }],
    ['exit 1', { code: 1, stdout: '[]' }],
    ['not an array', { stdout: '{"a":1}' }],
    ['a row of the wrong shape', { stdout: '[{"status":5}]' }],
    ['a thrown error', new Error('spawn failed')],
  ] as const)('%s is unknown, never green', async (_n, reply) => {
    await expect(readMainBuild(CONFIG, ghWith(reply as never).ports)).resolves.toEqual({
      status: 'unknown',
    });
  });

  it('strips control characters from the workflow name', async () => {
    const r = await read([run('ci\u001b[31m\nx', 'completed', 'failure')]);
    expect(r.workflow).not.toMatch(/\p{Cc}/u);
  });
});

describe('pause file', () => {
  const dir = (n: string) => {
    const d = join(tmp, n);
    mkdirSync(d, { mode: 0o700 });
    return d;
  };

  it('is a state file', () => {
    expect(STATE_FILES).toContain('pause.json');
  });

  it('not paused without the file; set records the time; clear removes it', () => {
    const d = dir('a');
    expect(readPause(d)).toEqual({ paused: false });
    setPause(d, new Date('2026-11-01T10:00:00Z'));
    expect(readPause(d)).toEqual({ paused: true, at: '2026-11-01T10:00:00.000Z' });
    clearPause(d);
    expect(readPause(d)).toEqual({ paused: false });
    clearPause(d);
  });

  it.each([
    ['garbage', 'not json'],
    ['empty', ''],
    ['wrong shape', '[1,2]'],
  ])('%s content still means paused', (n, body) => {
    const d = dir(`c-${n.replace(' ', '-')}`);
    writeFileSync(join(d, 'pause.json'), body);
    expect(readPause(d).paused).toBe(true);
    clearPause(d);
    expect(readPause(d).paused).toBe(false);
  });

  it('a directory or a symlink in its place means paused and clears', () => {
    const d = dir('d');
    mkdirSync(join(d, 'pause.json'));
    expect(readPause(d).paused).toBe(true);
    clearPause(d);
    expect(readPause(d).paused).toBe(false);
    symlinkSync('/nonexistent-target', join(d, 'pause.json'));
    expect(readPause(d).paused).toBe(true);
    clearPause(d);
    expect(readPause(d).paused).toBe(false);
  });
});
