// The PowerShell Studio generates for a relay worker, read as text: a backslash a template literal
// dropped would make a path that names nothing (a reset that cleans no key, a check that checks no
// folder), and nothing would fail. Every Windows path in the scripts keeps its backslashes.
import { describe, expect, it } from 'vitest';
import { relayHandoffScript } from '../src/relay-serve.js';
import {
  brokerScript,
  FOLDER_FUNCTIONS,
  relaySetupScript,
  sshdMatchBlock,
} from '../src/relay-windows.js';

const reset = (await import(new URL('../bin/studio-crew-reset.mjs', import.meta.url).href)) as {
  registryLeftScript: (base: string) => string;
  registryResetScript: (base: string) => string;
};

const scripts: Record<string, string> = {
  'registry reset': reset.registryResetScript('HKCU:\\'),
  'registry left': reset.registryLeftScript('HKCU:\\'),
  setup: relaySetupScript({
    relayUser: 'studio-relay',
    crewUser: 'studio-crew',
    home: 'C:\\ProgramData\\Studio\\relay',
    machine: 'C:\\Program Files\\Studio\\relay',
    task: 'Studio relay broker',
    readPaths: ['C:\\claude'],
    source: { node: 'C:\\nodejs\\node.exe', studio: 'C:\\plugins\\studio' },
  }),
  broker: brokerScript({ crewUser: 'studio-crew', result: 'C:\\r.json' }),
  'folder functions': FOLDER_FUNCTIONS,
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
  /(Software|Microsoft|Windows|CurrentVersion|Explorer|ProgramData|System32|OpenSSH)(Microsoft|Windows|CurrentVersion|Explorer|Classes|Run\b|RunOnce|User Shell|Shell Folders|Command Processor|ssh|OpenSSH|sshd)/;

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
  it('the reset and its check name the same keys, Classes and both shell folder keys included', () => {
    for (const text of [scripts['registry reset'], scripts['registry left']] as string[]) {
      for (const key of [
        'Software\\Classes',
        'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
        'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders',
        'Software\\Microsoft\\Windows\\CurrentVersion\\Run',
        'Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce',
        'Software\\Microsoft\\Command Processor',
      ]) {
        expect(text).toContain(`'${key}'`);
      }
    }
  });
});
