import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseLinuxStartTime, realPorts } from '../src/ports.js';

const dir = mkdtempSync(join(tmpdir(), 'studio-ports-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met before deadline');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('realPorts', () => {
  it('git.run returns stdout and throws with stderr on failure', async () => {
    const { git } = realPorts();
    await git.run(dir, ['init', '-q']);
    expect(await git.run(dir, ['rev-parse', '--is-inside-work-tree'])).toBe('true');
    await expect(git.run(dir, ['checkout', 'no-such-branch'])).rejects.toThrow(/no-such-branch/);
  });

  it('claude.start detaches, logs output, and stop terminates', async () => {
    const { claude } = realPorts('sh');
    const log = join(dir, 'out.log');
    const { pid } = await claude.start(dir, ['-c', 'cat; sleep 30'], 'hello\n', log, {
      PATH: process.env.PATH ?? '',
    });
    expect(claude.alive(pid)).toBe(true);
    await until(() => readFileSync(log, 'utf8').includes('hello'));
    await claude.stop(pid);
    expect(claude.alive(pid)).toBe(false);
  });

  it('claude.stop also terminates descendants of the session', async () => {
    const { claude } = realPorts('sh');
    const pidFile = join(dir, 'grandchild.pid');
    const script = `sleep 30 & echo $! > ${pidFile}; wait`;
    const { pid } = await claude.start(dir, ['-c', script], '', join(dir, 'gc.log'), {
      PATH: process.env.PATH ?? '',
    });
    await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
    const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
    expect(isAlive(grandchild)).toBe(true);
    await claude.stop(pid);
    await until(() => !isAlive(grandchild));
    expect(claude.alive(pid)).toBe(false);
  });

  it('clock sleeps and host reports a load average', async () => {
    const { clock, host } = realPorts();
    const t0 = clock.now().getTime();
    await clock.sleep(20);
    expect(clock.now().getTime() - t0).toBeGreaterThanOrEqual(15);
    expect(host.loadAvg1()).toBeGreaterThanOrEqual(0);
    expect(host.cpuCount()).toBeGreaterThanOrEqual(1);
  });
});

describe('parseLinuxStartTime', () => {
  const fields = (after: string[]) => `4242 (comm) ${after.join(' ')}\n`;
  const rest = (start: string) => {
    // Fields 3..22: state, then 18 numbers, then starttime (field 22).
    const a = ['S', ...Array.from({ length: 18 }, (_, i) => String(i)), start];
    return a;
  };

  it('returns field 22 of a plain stat line', () => {
    expect(parseLinuxStartTime(fields(rest('987654')))).toBe('987654');
  });

  it('parses after the last ")" when comm holds spaces and parens', () => {
    const line = `4242 (a) (b c) d) ${rest('13579').join(' ')} 0 0\n`;
    expect(parseLinuxStartTime(line)).toBe('13579');
  });

  it('returns undefined for malformed input', () => {
    expect(parseLinuxStartTime('')).toBeUndefined();
    expect(parseLinuxStartTime('4242 no parens S 1 2 3')).toBeUndefined();
    expect(parseLinuxStartTime('4242 (comm) S 1 2 3')).toBeUndefined();
    expect(parseLinuxStartTime(fields(rest('12x4')))).toBeUndefined();
    expect(parseLinuxStartTime(fields(rest('')))).toBeUndefined();
    expect(parseLinuxStartTime(fields(rest('-5')))).toBeUndefined();
  });

  it.skipIf(process.platform !== 'linux')('reads a stable identity from /proc twice', async () => {
    const { claude } = realPorts();
    const first = await claude.identity(process.pid);
    expect(first).toMatch(/^\d+$/);
    expect(await claude.identity(process.pid)).toBe(first);
    expect(await claude.identity(2 ** 30)).toBeUndefined();
  });
});
