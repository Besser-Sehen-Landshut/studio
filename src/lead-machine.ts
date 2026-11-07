// The machine the lead runs on, as `studio setup` and `studio relay pair` check it: macOS, Linux, or
// a Linux distribution in WSL2 on a Windows PC. Native Windows and WSL1 cannot run the lead (Claude
// Code's sandbox runs on macOS, Linux and WSL2 only); each gets the one command that gets it there.
// Under WSL2 the lead's own files must stay in the Linux file system: a Windows drive mounted into
// it (`/mnt/c`) neither keeps file modes (an SSH key there is refused by ssh, a token file is open
// to every Windows program) nor case.
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { WorkerPlatform } from './worker-deny.js';

export type LeadKind = 'macos' | 'linux' | 'wsl2' | 'wsl1' | 'windows' | 'other';

export function leadKind(p: WorkerPlatform): LeadKind {
  if (p.platform === 'darwin') return 'macos';
  if (p.platform === 'win32') return 'windows';
  if (p.platform !== 'linux') return 'other';
  if (p.wsl === 'wsl2') return 'wsl2';
  if (p.wsl === 'wsl1' || p.wsl === 'unknown') return 'wsl1';
  return 'linux';
}

export type LeadTool = 'git' | 'gh' | 'node' | 'claude' | 'ssh' | 'sandbox';

/** The command that installs a tool the lead needs, for this kind of machine (Ubuntu for Linux). */
export function installCommand(tool: LeadTool, kind: LeadKind): string {
  const mac = kind === 'macos';
  switch (tool) {
    case 'git':
      return mac ? 'xcode-select --install' : 'sudo apt-get install -y git';
    case 'gh':
      return mac ? 'brew install gh' : 'sudo apt-get install -y gh';
    case 'node':
      return mac
        ? 'brew install node@24'
        : 'curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs';
    case 'claude':
      return 'curl -fsSL https://claude.ai/install.sh | bash';
    case 'ssh':
      return mac ? 'ssh is part of macOS' : 'sudo apt-get install -y openssh-client';
    case 'sandbox':
      // Claude Code's sandbox on Linux and WSL2: bubblewrap and socat; macOS has its own.
      return mac ? 'part of macOS' : 'sudo apt-get install -y bubblewrap socat';
  }
}

/** The way from a machine that cannot run the lead to one that can; undefined when it can. */
export function leadMachineProblem(
  kind: LeadKind,
  env: Record<string, string | undefined>,
): { why: string; fix: string } | undefined {
  if (kind === 'windows') {
    return {
      why: 'the lead does not run on native Windows (Claude Code has no sandbox there)',
      fix: 'in PowerShell as administrator: wsl --install -d Ubuntu-24.04, restart the PC, open Ubuntu and run studio setup there (README, "Lead on a Windows PC (WSL2)")',
    };
  }
  if (kind === 'wsl1') {
    const distro = env.WSL_DISTRO_NAME ?? '<distribution>';
    return {
      why: 'this is WSL1 (or a WSL whose version cannot be told); the lead needs WSL2',
      fix: `in PowerShell: wsl --set-version ${distro} 2, then open it again and run studio setup`,
    };
  }
  if (kind === 'other')
    return { why: 'this platform is not supported', fix: 'run the lead on macOS, Linux or WSL2' };
  return undefined;
}

/**
 * Under WSL2: a path on a Windows drive mounted into the distribution, which keeps no Unix file
 * modes; undefined elsewhere and for a path in the Linux file system.
 */
export function onWindowsDrive(path: string, p: WorkerPlatform): boolean {
  if (p.platform !== 'linux' || p.wsl === 'none') return false;
  const abs = `${resolve(path).replace(/\/+$/, '')}/`;
  const roots = [p.automountRoot, ...(p.windowsMounts ?? [])].map(
    (r) => `${r.replace(/\/+$/, '')}/`,
  );
  return roots.some((r) => r !== '/' && abs.startsWith(r));
}

/** An executable named `name` on PATH, or undefined. */
export function onPath(name: string, env: Record<string, string | undefined>): string | undefined {
  for (const dir of (env.PATH ?? '').split(':').filter((d) => d !== '')) {
    const file = join(dir, name);
    try {
      const st = statSync(file);
      if (st.isFile() && (st.mode & 0o111) !== 0) return file;
    } catch {
      // not here
    }
  }
  return undefined;
}
