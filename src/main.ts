// Entry point of the control-room CLI. Bundled to dist-bundle/studio.mjs (see `pnpm bundle`).
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runCli } from './cli.js';
import { readHiddenLine, readVisibleLine } from './hidden-input.js';
import { realPorts } from './ports.js';

/** The plugin's `bin/studio`: this file is `dist-bundle/studio.mjs` (or `dist/main.js`). */
function launcher(): string | undefined {
  try {
    return realpathSync(fileURLToPath(new URL('../bin/studio', import.meta.url)));
  } catch {
    return undefined;
  }
}
const bin = launcher();

process.exitCode = await runCli(process.argv.slice(2), {
  ports: realPorts(),
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  env: process.env,
  homedir: homedir(),
  cwd: process.cwd(),
  isTerminal: process.stdin.isTTY === true && process.stdout.isTTY === true,
  readSecret: (prompt) => readHiddenLine(prompt, process.stdin, (s) => process.stderr.write(s)),
  readLine: (prompt) => readVisibleLine(prompt, process.stdin, process.stderr),
  ...(bin === undefined ? {} : { launcher: bin }),
});
