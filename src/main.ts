// Entry point of the control-room CLI. Bundled to dist-bundle/studio.mjs (see `pnpm bundle`).
import { homedir } from 'node:os';
import { runCli } from './cli.js';
import { readHiddenLine } from './hidden-input.js';
import { realPorts } from './ports.js';

process.exitCode = await runCli(process.argv.slice(2), {
  ports: realPorts(),
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  env: process.env,
  homedir: homedir(),
  cwd: process.cwd(),
  readSecret: (prompt) => readHiddenLine(prompt, process.stdin, (s) => process.stderr.write(s)),
});
