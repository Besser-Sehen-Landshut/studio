import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  accountFile,
  accountsDir,
  activeLabel,
  addAccount,
  builtInAccount,
  crewClaudeDir,
  expiryState,
  listAccounts,
  looksLikeToken,
  PLUGIN_COMMANDS,
  removeAccount,
  setActiveLabel,
} from '../src/accounts.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-accounts-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const owner = () => {
  const home = join(root, `h${n++}`);
  mkdirSync(home);
  return { homedir: home, env: {} as Record<string, string | undefined> };
};
const TOKEN = `fake-value-${'x'.repeat(40)}`;
const NOW = new Date('2026-11-03T10:00:00Z');

describe('where accounts live', () => {
  it('tokens and the crew config dir lie in the owner config, never in ~/.claude', () => {
    const o = owner();
    expect(accountsDir(o)).toBe(join(o.homedir, '.config', 'studio', 'tokens'));
    expect(accountFile(o, 'work')).toBe(join(accountsDir(o), 'work.json'));
    expect(crewClaudeDir(o)).toBe(join(o.homedir, '.config', 'studio', 'claude'));
    expect(crewClaudeDir(o)).not.toContain(join(o.homedir, '.claude'));
  });
  it('plugins come over HTTPS, into the crew config dir only', () => {
    for (const args of PLUGIN_COMMANDS) expect(args[0]).toBe('plugin');
    const sources = PLUGIN_COMMANDS.filter((a) => a[1] === 'marketplace').map((a) => a[3]);
    expect(sources.every((s) => s?.startsWith('https://'))).toBe(true);
  });
});

describe('the token format check', () => {
  it.each([TOKEN, `sk-ant-oat01-${'A'.repeat(60)}`])('%s is accepted', (t) => {
    expect(looksLikeToken(t)).toBe(true);
  });
  it.each(['', 'short', `a b${'x'.repeat(30)}`, `x\n${'y'.repeat(30)}`, 'x'.repeat(5000)])(
    '%j is refused',
    (t) => {
      expect(looksLikeToken(t)).toBe(false);
    },
  );
});

describe('adding, listing, using and removing', () => {
  it('a token is stored 0600 in a 0700 directory, with the date it was added', () => {
    const o = owner();
    addAccount(o, 'work', TOKEN, NOW);
    const file = accountFile(o, 'work');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(accountsDir(o)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      label: 'work',
      token: TOKEN,
      addedAt: NOW.toISOString(),
    });
    expect(listAccounts(o)).toEqual([{ label: 'work', addedAt: NOW.toISOString() }]);
  });
  it('the list never holds a token', () => {
    const o = owner();
    addAccount(o, 'work', TOKEN, NOW);
    expect(JSON.stringify(listAccounts(o))).not.toContain(TOKEN);
  });
  it('the first account becomes the active one; later ones do not', () => {
    const o = owner();
    addAccount(o, 'a', TOKEN, NOW);
    addAccount(o, 'b', TOKEN, NOW);
    expect(activeLabel(o)).toBe('a');
    setActiveLabel(o, 'b');
    expect(activeLabel(o)).toBe('b');
  });
  it('adding again replaces the token and the date', () => {
    const o = owner();
    addAccount(o, 'a', TOKEN, NOW);
    const later = new Date('2027-10-01T00:00:00Z');
    addAccount(o, 'a', `${TOKEN}2`, later);
    expect(listAccounts(o)).toEqual([{ label: 'a', addedAt: later.toISOString() }]);
  });
  it('using a label that does not exist refuses', () => {
    const o = owner();
    addAccount(o, 'a', TOKEN, NOW);
    expect(() => setActiveLabel(o, 'b')).toThrow(/no account b/);
  });
  it('removing the active account leaves none active', () => {
    const o = owner();
    addAccount(o, 'a', TOKEN, NOW);
    removeAccount(o, 'a');
    expect(existsSync(accountFile(o, 'a'))).toBe(false);
    expect(activeLabel(o)).toBeUndefined();
    expect(() => removeAccount(o, 'a')).toThrow(/no account a/);
  });
  it.each(['', '.x', 'a/b', '../x', 'a b', 'x'.repeat(65)])('label %j refuses', (label) => {
    expect(() => addAccount(owner(), label, TOKEN, NOW)).toThrow(/label/);
  });
  it('a bad token refuses and stores nothing', () => {
    const o = owner();
    expect(() => addAccount(o, 'a', 'short', NOW)).toThrow(/token/);
    expect(existsSync(accountFile(o, 'a'))).toBe(false);
  });
});

describe('the built-in way', () => {
  it('no accounts: not in use', () => {
    expect(builtInAccount(owner(), NOW)).toBeUndefined();
  });
  it('gives the active label with its token', () => {
    const o = owner();
    addAccount(o, 'a', TOKEN, NOW);
    addAccount(o, 'b', `${TOKEN}b`, NOW);
    setActiveLabel(o, 'b');
    expect(builtInAccount(o, NOW)).toMatchObject({ label: 'b', token: `${TOKEN}b` });
  });
  it('accounts but none active refuses, naming account use', () => {
    const o = owner();
    addAccount(o, 'a', TOKEN, NOW);
    rmSync(join(accountsDir(o), 'active'));
    expect(() => builtInAccount(o, NOW)).toThrow(/studio account use/);
  });
  it('an expired token refuses, naming the renewal', () => {
    const o = owner();
    addAccount(o, 'a', TOKEN, NOW);
    const later = new Date(NOW.getTime() + 366 * 86_400_000);
    expect(() => builtInAccount(o, later)).toThrow(/expired.*claude setup-token/);
  });
  it.each<[string, (o: ReturnType<typeof owner>) => void]>([
    ['a token file others can read', (o) => chmodSync(accountFile(o, 'a'), 0o644)],
    ['a directory others can read', (o) => chmodSync(accountsDir(o), 0o755)],
    [
      'a token file that is a link',
      (o) => {
        const real = join(o.homedir, 'elsewhere.json');
        writeFileSync(real, readFileSync(accountFile(o, 'a')), { mode: 0o600 });
        rmSync(accountFile(o, 'a'));
        symlinkSync(real, accountFile(o, 'a'));
      },
    ],
    [
      'a file whose label is another',
      (o) =>
        writeFileSync(
          accountFile(o, 'a'),
          JSON.stringify({ label: 'b', token: TOKEN, addedAt: NOW.toISOString() }),
          { mode: 0o600 },
        ),
    ],
    ['a file that is not JSON', (o) => writeFileSync(accountFile(o, 'a'), 'x', { mode: 0o600 })],
    [
      'an active file that names no account',
      (o) => writeFileSync(join(accountsDir(o), 'active'), 'gone\n', { mode: 0o600 }),
    ],
  ])('%s refuses: fail closed', (_name, spoil) => {
    const o = owner();
    addAccount(o, 'a', TOKEN, NOW);
    spoil(o);
    expect(() => builtInAccount(o, NOW)).toThrow();
  });
});

describe('errors never carry file content', () => {
  const SECRET = `fake-value-secret-${'s'.repeat(40)}`;
  const messages = (o: ReturnType<typeof owner>): string[] => {
    const out: string[] = [];
    for (const call of [
      () => builtInAccount(o, NOW),
      () => listAccounts(o),
      () => setActiveLabel(o, 'a'),
      () => removeAccount(o, 'a'),
      () => activeLabel(o),
    ]) {
      try {
        call();
      } catch (e) {
        out.push((e as Error).message);
      }
    }
    return out;
  };
  it.each([
    `{"label":"a","token":"${SECRET}"`,
    `${SECRET}`,
    `{"label":"a","token":"${SECRET}","addedAt":}`,
    `{"label":"a","token":${SECRET}}`,
  ])('a broken account file %#: refused, and the token is in no message', (text) => {
    const o = owner();
    addAccount(o, 'a', TOKEN, NOW);
    writeFileSync(accountFile(o, 'a'), text, { mode: 0o600 });
    const all = messages(o);
    expect(all.length).toBeGreaterThan(0);
    for (const m of all) expect(m).not.toContain(SECRET.slice(0, 24));
    expect(all.some((m) => m.endsWith('is not valid JSON'))).toBe(true);
  });
  it('a broken active file: refused, and its content is in no message', () => {
    const o = owner();
    addAccount(o, 'a', TOKEN, NOW);
    writeFileSync(join(accountsDir(o), 'active'), `${SECRET}\n`, { mode: 0o600 });
    for (const m of messages(o)) expect(m).not.toContain(SECRET.slice(0, 24));
  });
  it('a FIFO in place of the account file refuses at once, without hanging', () => {
    const o = owner();
    addAccount(o, 'a', TOKEN, NOW);
    rmSync(accountFile(o, 'a'));
    spawnSync('mkfifo', ['-m', '600', accountFile(o, 'a')]);
    expect(() => builtInAccount(o, NOW)).toThrow(/not a regular file/);
  });
  it('a link in place of the account file is not followed', () => {
    const o = owner();
    addAccount(o, 'a', TOKEN, NOW);
    const real = join(o.homedir, 'real.json');
    writeFileSync(real, readFileSync(accountFile(o, 'a')), { mode: 0o600 });
    rmSync(accountFile(o, 'a'));
    symlinkSync(real, accountFile(o, 'a'));
    expect(() => builtInAccount(o, NOW)).toThrow(/cannot be read \(ELOOP\)|not a regular file/);
  });
  it('an unreadable file names the error code, nothing else', () => {
    const o = owner();
    addAccount(o, 'a', TOKEN, NOW);
    chmodSync(accountFile(o, 'a'), 0o000);
    try {
      expect(() => builtInAccount(o, NOW)).toThrow(/cannot be read \(EACCES\)$/);
    } finally {
      chmodSync(accountFile(o, 'a'), 0o600);
    }
  });
});

describe('expiry, one year after the token was added', () => {
  const added = '2026-01-01T00:00:00.000Z';
  it.each<[string, string]>([
    ['2026-11-01T00:00:00Z', 'ok'],
    ['2026-12-03T00:00:00Z', 'soon'],
    ['2027-01-02T00:00:00Z', 'expired'],
  ])('at %s it is %s', (at, state) => {
    expect(expiryState(added, new Date(at)).state).toBe(state);
  });
  it('names the day it ends', () => {
    expect(expiryState(added, NOW).expiresAt).toBe('2027-01-01T00:00:00.000Z');
  });
});
