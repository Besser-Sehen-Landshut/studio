// Windows PowerShell as the crew user runs it for Studio (bin/studio-crew-host.mjs): the system's
// own by its full path, with its modules only from `$PSHOME\Modules`.
//
// Self-contained on purpose, like the crew host that loads it: no import of Studio's sources.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/** Windows PowerShell of the system, by its full path, not whatever `PATH` finds first. */
export const PS_HOME = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
);
export const PS_EXE = join(PS_HOME, 'powershell.exe');

/**
 * Every PowerShell the crew user runs: its modules only from `$PSHOME\Modules`, so a module named
 * in its environment cannot stand in for a core one. The module path is pinned twice, in the
 * environment and as the first statement.
 */
export function pinnedPowerShell(script) {
  const env = { ...process.env, PSModulePath: join(PS_HOME, 'Modules') };
  for (const k of Object.keys(env)) {
    if (k !== 'PSModulePath' && k.toLowerCase() === 'psmodulepath') delete env[k];
  }
  return {
    file: PS_EXE,
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$env:PSModulePath = Join-Path $PSHOME 'Modules'\n${script}`,
    ],
    env,
  };
}

export const powershell = (script) => {
  const ps = pinnedPowerShell(script);
  return execFileSync(ps.file, ps.args, {
    encoding: 'utf8',
    windowsHide: true,
    env: ps.env,
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
};
