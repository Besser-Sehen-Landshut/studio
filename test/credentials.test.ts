import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
  apiBillingProblem,
  checkCredentialCommand,
  checkProviderConfigDir,
  cloneSettingsProblem,
  installCrewToken,
  parseProviderOutput,
  readCrewTokenFile,
} from '../src/credentials.js';
import { readHiddenLine } from '../src/hidden-input.js';
import { realPorts } from '../src/ports.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-cred-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const dir = (): string => {
  const d = join(root, `d${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const TOKEN = 'fake-value-provider-output';
const own = (home: string) => ({ homedir: home, env: {} });
const otherUid = (process.getuid?.() ?? 0) + 1;

describe('parseProviderOutput', () => {
  const line = (v: unknown) => `${JSON.stringify(v)}\n`;
  const tok = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN };

  it('provider env accepts only the oauth key or the config dir', () => {
    expect(parseProviderOutput(line({ label: 'label-a', env: tok }))).toEqual({
      label: 'label-a',
      token: TOKEN,
    });
    expect(
      parseProviderOutput(line({ label: 'label-a', env: { CLAUDE_CONFIG_DIR: '/x/y' } })),
    ).toEqual({ label: 'label-a', configDir: '/x/y' });
  });

  it('empty output is reported as empty', () => {
    expect(parseProviderOutput('')).toBeUndefined();
    expect(parseProviderOutput('  \n')).toBeUndefined();
  });

  const bad: [string, string][] = [
    ['another env key', line({ label: 'a', env: { ANTHROPIC_API_KEY: TOKEN } })],
    ['two env keys', line({ label: 'a', env: { ...tok, X: TOKEN } })],
    ['both accepted keys', line({ label: 'a', env: { ...tok, CLAUDE_CONFIG_DIR: '/x' } })],
    ['no env key', line({ label: 'a', env: {} })],
    ['extra top-level key', line({ label: 'a', env: tok, x: 1 })],
    ['missing label', line({ env: tok })],
    ['bad label', line({ label: 'a b', env: tok })],
    ['long label', line({ label: 'a'.repeat(65), env: tok })],
    ['prototype label', line({ label: '__proto__', env: tok })],
    ['token with space', line({ label: 'a', env: { CLAUDE_CODE_OAUTH_TOKEN: `${TOKEN} x` } })],
    [
      'token with control char',
      line({ label: 'a', env: { CLAUDE_CODE_OAUTH_TOKEN: `${TOKEN}\u0007` } }),
    ],
    ['empty token', line({ label: 'a', env: { CLAUDE_CODE_OAUTH_TOKEN: '' } })],
    ['non-string token', line({ label: 'a', env: { CLAUDE_CODE_OAUTH_TOKEN: 1 } })],
    ['two lines', `${line({ label: 'a', env: tok })}${line({ label: 'b', env: tok })}`],
    ['not JSON', `${TOKEN}\n`],
    ['array', '[]\n'],
  ];
  for (const [name, text] of bad) {
    it(`refuses ${name} with a fixed message`, () => {
      let msg = '';
      try {
        parseProviderOutput(text);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toMatch(/credential provider/);
      expect(msg).not.toContain(TOKEN);
    });
  }
});

describe('checkCredentialCommand', () => {
  const script = (mode = 0o700): string => {
    const f = join(dir(), 'provider');
    writeFileSync(f, '#!/bin/sh\n');
    chmodSync(f, mode);
    return f;
  };

  it('accepts an owned executable', () => {
    expect(() => checkCredentialCommand(script(), {})).not.toThrow();
  });

  it('refuses relative, missing, directory, symlink, non-executable and writable', () => {
    expect(() => checkCredentialCommand('bin/provider', {})).toThrow(/absolute/);
    expect(() => checkCredentialCommand(join(dir(), 'none'), {})).toThrow(/regular file/);
    expect(() => checkCredentialCommand(dir(), {})).toThrow(/regular file/);
    const link = join(dir(), 'link');
    symlinkSync(script(), link);
    expect(() => checkCredentialCommand(link, {})).toThrow(/regular file/);
    expect(() => checkCredentialCommand(script(0o600), {})).toThrow(/executable/);
    expect(() => checkCredentialCommand(script(0o720), {})).toThrow(/writable/);
    expect(() => checkCredentialCommand(script(0o702), {})).toThrow(/writable/);
  });

  it('refuses a file of another owner', () => {
    expect(() => checkCredentialCommand(script(), { uid: otherUid })).toThrow(/owned/);
  });
});

describe('checkProviderConfigDir', () => {
  const setup = () => {
    const home = dir();
    const ownerDir = join(home, '.config', 'studio');
    mkdirSync(ownerDir, { recursive: true });
    return { home, ownerDir };
  };

  it('returns the real path of a directory below the owner dir', () => {
    const { home, ownerDir } = setup();
    const d = join(ownerDir, 'accounts', 'label-a');
    mkdirSync(d, { recursive: true });
    expect(checkProviderConfigDir(d, own(home))).toBe(d);
  });

  it('refuses the owner dir, escapes, relative, missing, a file and another owner', () => {
    const { home, ownerDir } = setup();
    expect(() => checkProviderConfigDir(ownerDir, own(home))).toThrow(/below/);
    expect(() => checkProviderConfigDir('accounts/a', own(home))).toThrow(/absolute/);
    expect(() => checkProviderConfigDir(join(ownerDir, 'none'), own(home))).toThrow(/directory/);
    writeFileSync(join(ownerDir, 'crew-token'), 'fake-value');
    expect(() => checkProviderConfigDir(join(ownerDir, 'crew-token'), own(home))).toThrow(
      /directory/,
    );
    const outside = dir();
    expect(() => checkProviderConfigDir(outside, own(home))).toThrow(/below/);
    symlinkSync(outside, join(ownerDir, 'escape'));
    expect(() => checkProviderConfigDir(join(ownerDir, 'escape'), own(home))).toThrow(/below/);
    const d = join(ownerDir, 'label-a');
    mkdirSync(d);
    expect(() => checkProviderConfigDir(d, { ...own(home), uid: otherUid })).toThrow(/owned/);
  });
});

describe('apiBillingProblem', () => {
  const settings = (body: string): string => {
    const f = join(dir(), 'settings.json');
    writeFileSync(f, body);
    return f;
  };

  it('a missing file or clean settings are fine', () => {
    expect(apiBillingProblem(join(dir(), 'none.json'))).toBeUndefined();
    expect(apiBillingProblem(settings('{"env":{"FOO":"1"}}'))).toBeUndefined();
  });

  it('names the key, never a value', () => {
    const v = 'fake-value-in-settings';
    for (const [body, key] of [
      [`{"apiKeyHelper":"${v}"}`, 'apiKeyHelper'],
      [`{"env":{"ANTHROPIC_API_KEY":"${v}"}}`, 'env.ANTHROPIC_API_KEY'],
      [`{"env":{"ANTHROPIC_AUTH_TOKEN":"${v}"}}`, 'env.ANTHROPIC_AUTH_TOKEN'],
    ] as const) {
      const p = apiBillingProblem(settings(body));
      expect(p).toContain(key);
      expect(p).not.toContain(v);
    }
  });

  it('an unparsable file is a problem, without echoing it', () => {
    const p = apiBillingProblem(settings('{"apiKeyHelper":"fake-value-broken'));
    expect(p).toMatch(/cannot be parsed/);
    expect(p).not.toContain('fake-value-broken');
    expect(apiBillingProblem(settings('[]'))).toMatch(/cannot be parsed/);
  });

  it('refuses a symlink where links are not trusted, follows it elsewhere', () => {
    const target = settings('{"env":{}}');
    const link = join(dir(), 'settings.json');
    symlinkSync(target, link);
    expect(apiBillingProblem(link)).toBeUndefined();
    expect(cloneSettingsProblem(link, false, false)).toMatch(/symlink/);
  });

  it('with billing allowed the keys pass, an unparsable file still does not', () => {
    expect(apiBillingProblem(settings('{"apiKeyHelper":"x"}'), true)).toBeUndefined();
    expect(apiBillingProblem(settings('nope'), true)).toMatch(/cannot be parsed/);
  });
});

describe('cloneSettingsProblem', () => {
  const settings = (body: unknown): string => {
    const f = join(dir(), 'settings.json');
    writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
    return f;
  };
  const V = 'fake-value-example.com';
  const KEYS = [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_BEDROCK_BASE_URL',
    'ANTHROPIC_VERTEX_BASE_URL',
    'ANTHROPIC_FOUNDRY_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NODE_EXTRA_CA_CERTS',
    'NODE_OPTIONS',
  ];

  it('refuses each redirecting env key, naming the key, never the value, billing allowed or not', () => {
    for (const key of KEYS) {
      for (const allowed of [false, true]) {
        for (const reused of [false, true]) {
          const p = cloneSettingsProblem(settings({ env: { [key]: V } }), allowed, reused);
          expect(p, key).toContain(`env.${key}`);
          expect(p).not.toContain(V);
          expect(p).not.toMatch(/allow_api_billing/);
        }
      }
    }
  });

  it('matches the proxy keys in any case', () => {
    for (const key of ['http_proxy', 'https_proxy', 'all_proxy', 'Https_Proxy']) {
      expect(cloneSettingsProblem(settings({ env: { [key]: V } }), true, false), key).toBeDefined();
    }
  });

  it('refuses hooks and apiKeyHelper on a reused clone, billing allowed or not', () => {
    for (const allowed of [false, true]) {
      const hooks = cloneSettingsProblem(settings({ hooks: { Stop: [{ x: V }] } }), allowed, true);
      expect(hooks).toContain('hooks');
      expect(hooks).not.toContain(V);
      const helper = cloneSettingsProblem(settings({ apiKeyHelper: V }), allowed, true);
      expect(helper).toContain('apiKeyHelper');
      expect(helper).not.toContain(V);
    }
  });

  it('on a fresh clone hooks pass and apiKeyHelper follows the billing switch', () => {
    expect(cloneSettingsProblem(settings({ hooks: {} }), false, false)).toBeUndefined();
    expect(cloneSettingsProblem(settings({ apiKeyHelper: V }), true, false)).toBeUndefined();
    expect(cloneSettingsProblem(settings({ apiKeyHelper: V }), false, false)).toMatch(
      /apiKeyHelper/,
    );
  });

  it('keeps the billing keys behind the switch and passes clean settings', () => {
    const f = settings({ env: { ANTHROPIC_API_KEY: V } });
    expect(cloneSettingsProblem(f, false, true)).toContain('env.ANTHROPIC_API_KEY');
    expect(cloneSettingsProblem(f, true, true)).toBeUndefined();
    expect(cloneSettingsProblem(settings({ env: { FOO: '1' } }), false, true)).toBeUndefined();
    expect(cloneSettingsProblem(join(dir(), 'none.json'), false, true)).toBeUndefined();
  });

  it('an unparsable file or a symlink refuses', () => {
    expect(cloneSettingsProblem(settings('nope'), true, false)).toMatch(/cannot be parsed/);
    const link = join(dir(), 'settings.json');
    symlinkSync(settings({}), link);
    expect(cloneSettingsProblem(link, true, false)).toMatch(/symlink/);
  });

  it('a directory refuses as not a regular file', () => {
    const d = join(dir(), 'settings.json');
    mkdirSync(d);
    expect(cloneSettingsProblem(d, true, false)).toMatch(/not a regular file/);
  });

  it('a FIFO refuses at once instead of hanging', () => {
    const f = join(dir(), 'settings.json');
    execFileSync('mkfifo', [f]);
    expect(cloneSettingsProblem(f, true, false)).toMatch(/not a regular file/);
  }, 5000);
});

describe('crew token file', () => {
  const TK = 'fake-value-crew-token';
  const file = (home: string) => join(home, '.config', 'studio', 'crew-token');

  it('installs with mode 0600 in a 0700 parent, no temp left', () => {
    const home = dir();
    installCrewToken(TK, own(home));
    expect(readFileSync(file(home), 'utf8')).toBe(`${TK}\n`);
    expect(statSync(file(home)).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, '.config', 'studio')).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(home, '.config', 'studio'))).toEqual(['crew-token']);
    expect(readCrewTokenFile(own(home))).toEqual({ kind: 'ok', token: TK });
  });

  it('honours XDG_CONFIG_HOME', () => {
    const home = dir();
    const xdg = dir();
    installCrewToken(TK, { homedir: home, env: { XDG_CONFIG_HOME: xdg } });
    expect(existsSync(join(xdg, 'studio', 'crew-token'))).toBe(true);
  });

  it('replaces a planted symlink instead of following it', () => {
    const home = dir();
    mkdirSync(join(home, '.config', 'studio'), { recursive: true });
    const victim = join(dir(), 'victim');
    writeFileSync(victim, 'untouched');
    symlinkSync(victim, file(home));
    installCrewToken(TK, own(home));
    expect(readFileSync(victim, 'utf8')).toBe('untouched');
  });

  it('refuses a symlinked owner dir', () => {
    const home = dir();
    mkdirSync(join(home, '.config'));
    symlinkSync(dir(), join(home, '.config', 'studio'));
    expect(() => installCrewToken(TK, own(home))).toThrow(/symlink/);
  });

  it('reads absent, wide mode, other owner, symlink and empty without leaking', () => {
    const home = dir();
    expect(readCrewTokenFile(own(home))).toEqual({ kind: 'absent' });
    installCrewToken(TK, own(home));
    chmodSync(file(home), 0o640);
    const wide = readCrewTokenFile(own(home));
    expect(wide.kind).toBe('bad');
    expect(JSON.stringify(wide)).not.toContain(TK);
    chmodSync(file(home), 0o700);
    expect(readCrewTokenFile(own(home)).kind).toBe('bad');
    chmodSync(file(home), 0o600);
    expect(readCrewTokenFile({ ...own(home), uid: otherUid }).kind).toBe('bad');
    writeFileSync(file(home), ' \n');
    expect(readCrewTokenFile(own(home)).kind).toBe('bad');
    writeFileSync(file(home), 'two parts\n');
    expect(readCrewTokenFile(own(home)).kind).toBe('bad');
    rmSync(file(home));
    const target = join(home, 'target');
    writeFileSync(target, TK, { mode: 0o600 });
    symlinkSync(target, file(home));
    expect(readCrewTokenFile(own(home)).kind).toBe('bad');
  });
});

describe('real credential port', () => {
  const { credentials } = realPorts();
  const script = (body: string): string => {
    const f = join(dir(), 'provider');
    writeFileSync(f, `#!/bin/sh\n${body}\n`);
    chmodSync(f, 0o700);
    return f;
  };
  const opts = { timeoutMs: 5000, maxBytes: 65536 };

  it('runs without a shell and with exactly the given environment', async () => {
    const r = await credentials.runProvider(
      script('/usr/bin/env'),
      { STUDIO_ITEM: 'APP-1', PATH: process.env.PATH ?? '' },
      opts,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('STUDIO_ITEM=APP-1');
    process.env.STUDIO_TEST_LEAK = 'fake-value-parent';
    const again = await credentials.runProvider(script('/usr/bin/env'), {}, opts);
    delete process.env.STUDIO_TEST_LEAK;
    expect(again.stdout).not.toContain('STUDIO_TEST_LEAK');
  });

  it('discards stderr and reports a non-zero exit', async () => {
    const r = await credentials.runProvider(
      script('echo fake-value-stderr >&2\necho out\nexit 3'),
      {},
      opts,
    );
    expect(r.code).toBe(3);
    expect(JSON.stringify(r)).not.toContain('fake-value-stderr');
  });

  it('stops at the timeout', async () => {
    const t = Date.now();
    const r = await credentials.runProvider(
      script('exec sleep 20'),
      {},
      {
        timeoutMs: 200,
        maxBytes: 65536,
      },
    );
    expect(r.code).not.toBe(0);
    expect(Date.now() - t).toBeLessThan(10_000);
  });

  it('fails above the stdout cap', async () => {
    const r = await credentials.runProvider(script('head -c 70000 /dev/zero'), {}, opts);
    expect(r.code).not.toBe(0);
  });

  it('a command that cannot start is a failure, not an exception', async () => {
    const r = await credentials.runProvider(join(dir(), 'none'), {}, opts);
    expect(r.code).not.toBe(0);
  });

  it('gives the token to gh through the environment, never argv', async () => {
    const bin = dir();
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho "args:$*"\necho "tok:$GH_TOKEN"\n');
    chmodSync(join(bin, 'gh'), 0o700);
    const old = process.env.PATH;
    process.env.PATH = `${bin}:${old}`;
    try {
      const r = await credentials.ghWithToken('fake-value-gh', ['api', '/repos/org/app']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('args:api /repos/org/app');
      expect(r.stdout.split('\n')[0]).not.toContain('fake-value-gh');
      expect(r.stdout).toContain('tok:fake-value-gh');
    } finally {
      process.env.PATH = old;
    }
  });
});

describe('readHiddenLine', () => {
  class FakeTty extends EventEmitter {
    isTTY = true;
    raw: boolean[] = [];
    setRawMode(v: boolean) {
      this.raw.push(v);
      return this;
    }
    resume() {
      return this;
    }
    pause() {
      return this;
    }
    setEncoding() {
      return this;
    }
  }
  const run = async (chunks: string[]) => {
    const tty = new FakeTty();
    let echoed = '';
    const p = readHiddenLine('Token: ', tty as never, (s) => {
      echoed += s;
    });
    for (const c of chunks) tty.emit('data', c);
    return { value: await p, echoed, tty };
  };

  it('reads to the line end without echoing and restores the terminal', async () => {
    const r = await run(['fake-', 'value\r']);
    expect(r.value).toBe('fake-value');
    expect(r.echoed).not.toContain('fake');
    expect(r.tty.raw).toEqual([true, false]);
  });

  it('handles backspace', async () => {
    expect((await run(['fake-valuex\u007f\n'])).value).toBe('fake-value');
  });

  it('Ctrl-C or Ctrl-D abort', async () => {
    expect((await run(['fake\u0003'])).value).toBeUndefined();
    expect((await run(['\u0004'])).value).toBeUndefined();
  });

  it('refuses when stdin is not a terminal', async () => {
    const tty = new FakeTty();
    tty.isTTY = false;
    expect(await readHiddenLine('Token: ', tty as never, () => {})).toBeUndefined();
    expect(tty.raw).toEqual([]);
  });
});
