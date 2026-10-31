import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { realPorts } from '../src/ports.js';

const dir = mkdtempSync(join(tmpdir(), 'studio-ports-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

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
    await new Promise((r) => setTimeout(r, 200));
    expect(readFileSync(log, 'utf8')).toContain('hello');
    await claude.stop(pid);
    expect(claude.alive(pid)).toBe(false);
  });

  it('clock sleeps and host reports a load average', async () => {
    const { clock, host } = realPorts();
    const t0 = clock.now().getTime();
    await clock.sleep(20);
    expect(clock.now().getTime() - t0).toBeGreaterThanOrEqual(15);
    expect(host.loadAvg1()).toBeGreaterThanOrEqual(0);
  });
});
