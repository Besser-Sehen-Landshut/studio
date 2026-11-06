// The hand-over of a relay job's spec on a real Windows machine (the windows-latest CI job): the
// PowerShell child gets the spec on stdin, creates the runner through CIM and writes the spec into
// a pipe only the runner it created may read. The runner here is a stand-in that writes what it got.
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { systemSpawnRunner } from '../src/relay-serve.js';

const on = process.platform === 'win32';

describe.skipIf(!on)('the relay hand-over on Windows', () => {
  it('reaches the runner it created, through a pipe of the relay account', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'studio-relay-win-')));
    const out = join(dir, 'got.txt');
    // Started as `<node> <bin> relay run APP-1 --pipe <name> --home <dir>`: it reads the pipe.
    const bin = join(dir, 'runner.mjs');
    writeFileSync(
      bin,
      `import { connect } from 'node:net';
import { writeFileSync } from 'node:fs';
const name = process.argv[process.argv.indexOf('--pipe') + 1];
const chunks = [];
const s = connect('\\\\\\\\.\\\\pipe\\\\' + name);
s.on('data', (d) => chunks.push(d));
s.on('end', () => writeFileSync(${JSON.stringify(out)}, Buffer.concat(chunks)));
s.on('error', (e) => writeFileSync(${JSON.stringify(out)}, 'error ' + e.code));
`,
    );
    const start = systemSpawnRunner({ home: dir, platform: 'win32', bin });
    const spec = JSON.stringify({ nonce: 'n', job: { token: 'token-for-the-handover-test-0001' } });
    const { pid } = await start({ id: 'APP-1', spec, log: join(dir, 'log') });
    expect(pid).toBeGreaterThan(0);
    for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 100));
    expect(readFileSync(out, 'utf8')).toBe(spec);
  }, 120_000);
});
