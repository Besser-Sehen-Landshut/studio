// Runs the mod's tests (run: pnpm test:mod). `claude plugin test` takes every *.test.ts(x) under its
// folder and test/ holds vitest files that need Node, so it gets a copy holding only the mod.
// Needs the claude CLI, which CI does not have: this is a local check.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = join(import.meta.dirname, '..');
const copy = mkdtempSync(join(tmpdir(), 'studio-mod-test-'));
let status = 1;
try {
  mkdirSync(join(copy, '.claude-plugin'));
  cpSync(join(repo, '.claude-plugin', 'plugin.json'), join(copy, '.claude-plugin', 'plugin.json'));
  cpSync(join(repo, 'hooks'), join(copy, 'hooks'), { recursive: true });
  cpSync(join(repo, 'types'), join(copy, 'types'), { recursive: true });
  const run = spawnSync('claude', ['plugin', 'test', copy], { stdio: 'inherit' });
  if (run.error) console.error(`could not run claude: ${run.error.message}`);
  status = run.status ?? 1;
} finally {
  rmSync(copy, { recursive: true, force: true });
}
process.exit(status);
