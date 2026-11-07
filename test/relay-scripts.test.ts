// The PowerShell Studio generates for Windows workers, read as text: a backslash a template literal
// dropped would make a path that names nothing (a profile check that finds no profile, a check that
// checks no folder), and nothing would fail. Every Windows path in the scripts keeps its backslashes.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { crewAccountScript } from '../src/crew-accounts.js';
import { relayHandoffScript } from '../src/relay-serve.js';
import { relayUninstallScript } from '../src/relay-uninstall.js';
import {
  authorizedKeysScript,
  brokerScript,
  FOLDER_FUNCTIONS,
  relaySetupScript,
  sshdMatchBlock,
} from '../src/relay-windows.js';
import { KEEPER_SCRIPT, systemTool, windowsSetupScript } from '../src/windows-sandbox.js';

const scripts: Record<string, string> = {
  'crew sweep': crewAccountScript({
    op: 'sweep',
    prefix: 'studio-crew',
    places: { treeSource: 'C:\\crew\\studio-tree.cs', treeTemp: 'C:\\crew\\tmp' },
  }),
  'crew retire': crewAccountScript({
    op: 'retire',
    prefix: 'studio-crew',
    places: { treeSource: 'C:\\crew\\studio-tree.cs', treeTemp: 'C:\\crew\\tmp' },
  }),
  'crew fresh': crewAccountScript({
    places: { treeSource: 'C:\\crew\\studio-tree.cs', treeTemp: 'C:\\crew\\tmp' },
    op: 'fresh',
    prefix: 'studio-crew',
    credFile: 'C:\\c\\crew.bin',
    reader: 'S-1-5-21-1-2-3-1001',
  }),
  'native setup': windowsSetupScript({
    prefix: 'studio-crew',
    crewDir: 'C:\\Program Files\\Studio crew',
    readPaths: ['C:\\claude'],
  }),
  keeper: KEEPER_SCRIPT,
  setup: relaySetupScript({
    relayUser: 'studio-relay',
    crewPrefix: 'studio-crew',
    home: 'C:\\ProgramData\\Studio\\relay',
    machine: 'C:\\Program Files\\Studio\\relay',
    task: 'Studio relay broker',
    readPaths: ['C:\\claude'],
    source: { node: 'C:\\nodejs\\node.exe', studio: 'C:\\plugins\\studio' },
  }),
  install: relaySetupScript({
    relayUser: 'studio-relay',
    crewPrefix: 'studio-crew',
    home: 'C:\\ProgramData\\Studio\\relay',
    machine: 'C:\\Program Files\\Studio\\relay',
    task: 'Studio relay broker',
    readPaths: [],
    source: { node: 'C:\\nodejs\\node.exe', studio: 'C:\\plugins\\studio' },
    install: { port: 22, scope: { source: 'fd7a::/48' }, disableSpooler: true },
  }),
  'authorized keys': authorizedKeysScript({
    file: 'C:\\Program Files\\Studio\\relay\\authorized_keys',
    lines: [],
    relayUser: 'studio-relay',
  }),
  broker: brokerScript({
    op: 'fresh',
    prefix: 'studio-crew',
    machine: 'C:\\Program Files\\Studio\\relay',
  }),
  'folder functions': FOLDER_FUNCTIONS,
  uninstall: relayUninstallScript({
    relayUser: 'studio-relay',
    crewPrefix: 'studio-crew',
    task: 'Studio relay broker',
    home: 'C:\\ProgramData\\Studio\\relay',
    machine: 'C:\\Program Files\\Studio\\relay',
    readPaths: [],
    keepTree: false,
    forceStop: false,
    record: undefined,
    treeSource: 'C:\\plugins\\studio\\bin\\studio-tree.cs',
  }),
  'sshd block': sshdMatchBlock({
    relayUser: 'studio-relay',
    machine: 'C:\\Program Files\\Studio\\relay',
    command: 'x',
  }),
  handoff: relayHandoffScript({
    node: 'C:\\node.exe',
    bin: 'C:\\studio',
    id: 'APP-1',
    home: undefined,
    lead: 'lab',
  }),
};

/** Words that only ever follow a backslash in a Windows path. */
const GLUED =
  /(Software|SOFTWARE|Microsoft|Windows|Windows NT|CurrentVersion|Explorer|ProgramData|System32|OpenSSH)(Microsoft|Windows|CurrentVersion|Explorer|Classes|Run\b|RunOnce|User Shell|Shell Folders|Command Processor|ProfileList|ssh|OpenSSH|sshd)/;

describe('elevated runs start nothing from the cwd or a user folder', () => {
  it('system tools by absolute path on Windows; as named elsewhere and for anything else', () => {
    const env = { SystemRoot: 'C:\\Windows' };
    expect(systemTool('powershell.exe', env, 'win32')).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
    expect(systemTool('icacls', env, 'win32')).toBe('C:\\Windows\\System32\\icacls.exe');
    expect(systemTool('schtasks.exe', env, 'win32')).toBe('C:\\Windows\\System32\\schtasks.exe');
    expect(systemTool('whoami', env, 'win32')).toBe('C:\\Windows\\System32\\whoami.exe');
    expect(systemTool('tailscale', env, 'win32')).toBe('tailscale');
    expect(systemTool('powershell.exe', env, 'linux')).toBe('powershell.exe');
  });
  it('every elevated script searches the machine PATH only', () => {
    for (const name of ['install', 'setup', 'native setup', 'crew retire', 'uninstall']) {
      expect(scripts[name], name).toContain(
        "$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine')",
      );
      expect(scripts[name], name).not.toContain("GetEnvironmentVariable('Path', 'User')");
    }
  });
});

describe('the generated PowerShell keeps its backslashes', () => {
  for (const [name, text] of Object.entries(scripts)) {
    it(name, () => {
      expect(text, name).not.toMatch(GLUED);
      // Every registry path starts at Software with a backslash after it.
      for (const m of text.matchAll(/'(Software[^']*)'/g)) {
        expect(m[1], name).toMatch(/^Software\\[A-Z]/);
      }
    });
  }
  it('a .NET method never gets $null for a string: PowerShell would pass an empty string', () => {
    for (const [name, text] of Object.entries(scripts)) {
      expect(text, name).not.toMatch(/::Replace\([^)]*\$null\)/);
    }
  });

  it('the crew host imports every fs function it calls', () => {
    const host = readFileSync(new URL('../bin/studio-crew-host.mjs', import.meta.url), 'utf8');
    const imported = /import \{([^}]*)\} from 'node:fs'/.exec(host)?.[1] ?? '';
    for (const m of host.matchAll(/\b(\w+Sync)\(/g)) {
      const fn = m[1] as string;
      if (fn === 'powershellSync' || fn === 'execFileSync') continue;
      expect(imported, fn).toMatch(new RegExp(`\\b${fn}\\b`));
    }
  });

  it('each broker script fits a task action as -EncodedCommand, with room to spare', () => {
    for (const op of ['sweep', 'retire', 'fresh'] as const) {
      const script = brokerScript({
        op,
        prefix: 'abcdefghijklm',
        machine: 'C:\\Program Files\\Studio\\relay',
      });
      // A command line holds 32767 characters; the encoded script is the most of it.
      expect(Buffer.from(script, 'utf16le').toString('base64').length, op).toBeLessThan(24_000);
      expect(script, op).not.toMatch(/^\s*#/m);
    }
  });
  it('the profile list is named whole where crew users are deleted and where the host checks', () => {
    const key = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList';
    expect(scripts['crew retire']).toContain(`'${key}'`);
    // The crew host builds the key in a template literal of its own.
    const host = readFileSync(new URL('../bin/studio-crew-host.mjs', import.meta.url), 'utf8');
    expect(host).toContain(`'${key.replace(/\\/g, '\\\\')}\\\\\${sid}'`);
  });
});
