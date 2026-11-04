import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { addAccount, listAccounts } from '../src/accounts.js';
import { runCli } from '../src/cli.js';
import { installCrewToken, readCrewTokenFile } from '../src/credentials.js';
import { type Ports, realPorts } from '../src/ports.js';
import { SHIM_MARKER } from '../src/setup.js';

const root = mkdtempSync(join(tmpdir(), 'studio-setup-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const CREW_VALUE = 'fake-value-crew-token-setup-7d1e';
const ACCOUNT_VALUE = 'fake-value-claude-account-setup-91ac0f';

type Opts = {
  /** `gh auth status` exit code; default 0. */
  ghAuth?: number;
  /** `gh --version` fails: gh is not installed. */
  noGh?: boolean;
  origin?: string | null;
  studioYaml?: string;
  /** A folder on PATH that already holds an executable `studio`. */
  studioOnPath?: boolean;
  /** `~/.local/bin` is on PATH. */
  localBinOnPath?: boolean;
};

/** A fake plugin launcher that prints its version and arguments. */
const launcherScript = (version: string) =>
  `#!/usr/bin/env node\nconsole.log(${JSON.stringify(`launcher ${version}`)}, JSON.stringify(process.argv.slice(2)));\n`;

let n = 0;
function fixture(o: Opts = {}) {
  const base = join(root, `s${n++}`);
  const project = join(base, 'project');
  const home = join(base, 'home');
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: project, stdio: 'ignore' });
  if (o.origin !== null) {
    execFileSync(
      'git',
      ['remote', 'add', 'origin', o.origin ?? 'https://github.com/example-org/shop.git'],
      { cwd: project, stdio: 'ignore' },
    );
  }
  if (o.studioYaml !== undefined) {
    mkdirSync(join(project, '.studio'));
    writeFileSync(join(project, '.studio', 'studio.yaml'), o.studioYaml);
  }
  // The plugin's launcher, as main.ts resolves it.
  const plugin = join(base, 'plugin', '0.10.0');
  mkdirSync(join(plugin, 'bin'), { recursive: true });
  const launcher = join(plugin, 'bin', 'studio');
  writeFileSync(launcher, launcherScript('0.10.0'));
  chmodSync(launcher, 0o755);
  const pathDirs = [join(base, 'sysbin')];
  mkdirSync(pathDirs[0] as string);
  if (o.studioOnPath) {
    writeFileSync(join(base, 'sysbin', 'studio'), '#!/bin/sh\n');
    chmodSync(join(base, 'sysbin', 'studio'), 0o755);
  }
  const localBin = join(home, '.local', 'bin');
  if (o.localBinOnPath) pathDirs.unshift(localBin);
  const env: Record<string, string | undefined> = {
    PATH: [...pathDirs, process.env.PATH ?? ''].join(':'),
    XDG_STATE_HOME: join(home, 'state'),
    XDG_CONFIG_HOME: join(home, 'config'),
  };
  const owner = { env, homedir: home };
  const tokens: string[] = [];
  const pluginRuns: string[][] = [];
  const real = realPorts();
  const ports: Ports = {
    ...real,
    gh: {
      api: async () => '',
      async run(args) {
        if (o.noGh) return { code: 127, stdout: '', stderr: 'not found' };
        if (args[0] === 'auth') return { code: o.ghAuth ?? 0, stdout: '', stderr: '' };
        return { code: 0, stdout: 'gh version 2.80.0\n', stderr: '' };
      },
    },
    clock: { now: () => new Date('2026-11-04T10:00:00Z'), sleep: async () => {} },
    host: { loadAvg1: () => 0, cpuCount: () => 4 },
    credentials: {
      runProvider: real.credentials.runProvider,
      async ghWithToken(token, args) {
        tokens.push(token);
        const path = args[1] ?? '';
        if (path.endsWith('/pulls?per_page=1')) return { code: 0, stdout: '[]', stderr: '' };
        return { code: 0, stdout: '{"permissions":{"push":true}}', stderr: '' };
      },
    },
    plugins: {
      run: async (args) => {
        pluginRuns.push(args);
        return { code: 0, stdout: '', stderr: '' };
      },
    },
  };
  return { base, project, home, env, owner, ports, launcher, localBin, tokens, pluginRuns };
}
type Fx = ReturnType<typeof fixture>;

type Io = {
  terminal?: boolean;
  secrets?: string[];
  lines?: string[];
  role?: string;
};

async function setup(fx: Fx, argv: string[] = [], io: Io = {}) {
  let out = '';
  let err = '';
  const asked: string[] = [];
  const secrets = [...(io.secrets ?? [])];
  const lines = [...(io.lines ?? [])];
  const env = io.role === undefined ? fx.env : { ...fx.env, STUDIO_ROLE: io.role };
  const code = await runCli(['--project', fx.project, 'setup', ...argv], {
    ports: fx.ports,
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
    env,
    homedir: fx.home,
    cwd: fx.project,
    isTerminal: io.terminal ?? true,
    readSecret: async (prompt) => {
      asked.push(`secret: ${prompt}`);
      return secrets.shift();
    },
    readLine: async (prompt) => {
      asked.push(`line: ${prompt}`);
      return lines.shift();
    },
    launcher: fx.launcher,
  });
  return { code, out, err, asked, all: out + err };
}

describe('studio setup', () => {
  it('asks nothing when every step is done', async () => {
    const fx = fixture({ studioOnPath: true });
    installCrewToken(CREW_VALUE, fx.owner);
    addAccount(fx.owner, 'main', ACCOUNT_VALUE, new Date('2026-11-01T00:00:00Z'));
    const r = await setup(fx);
    expect(r.code).toBe(0);
    expect(r.asked).toEqual([]);
    expect(r.out).toMatch(/1\. GitHub CLI: done/);
    expect(r.out).toMatch(/2\. Crew token: done/);
    expect(r.out).toMatch(/3\. Claude account for crews: done/);
    expect(r.out).toMatch(/4\. studio in your terminal: done/);
    expect(r.out).toContain('/studio:init');
    expect(fx.tokens).toEqual([]);
  });

  it('runs the token flow when the crew token is missing, with the repository from origin', async () => {
    const fx = fixture({ studioOnPath: true });
    addAccount(fx.owner, 'main', ACCOUNT_VALUE, new Date('2026-11-01T00:00:00Z'));
    const r = await setup(fx, [], { secrets: [CREW_VALUE] });
    expect(r.code).toBe(0);
    expect(r.asked).toEqual(['secret: Crew token (input hidden): ']);
    // Explains what the token is and which permissions it needs, before asking.
    expect(r.out).toMatch(/contents and pull requests read\/write/);
    expect(r.out).toContain('valid for example-org/shop');
    expect(new Set(fx.tokens)).toEqual(new Set([CREW_VALUE]));
    const file = readCrewTokenFile(fx.owner);
    expect(file.kind).toBe('ok');
    expect(r.all).not.toContain(CREW_VALUE);
  });

  it('takes the repository from studio.yaml when the project has one', async () => {
    const fx = fixture({
      studioOnPath: true,
      origin: null,
      studioYaml: 'studio: 1\nprimary_repo: example-org/other\n',
    });
    addAccount(fx.owner, 'main', ACCOUNT_VALUE, new Date('2026-11-01T00:00:00Z'));
    const r = await setup(fx, [], { secrets: [CREW_VALUE] });
    expect(r.code).toBe(0);
    expect(r.out).toContain('valid for example-org/other');
  });

  it('asks for the repository when neither studio.yaml nor origin names one', async () => {
    const fx = fixture({ studioOnPath: true, origin: null });
    addAccount(fx.owner, 'main', ACCOUNT_VALUE, new Date('2026-11-01T00:00:00Z'));
    const r = await setup(fx, [], { secrets: [CREW_VALUE], lines: ['example-org/third'] });
    expect(r.code).toBe(0);
    expect(r.asked[0]).toMatch(/^line: .*owner\/name/);
    expect(r.out).toContain('valid for example-org/third');
  });

  it('runs the account flow with the default label main', async () => {
    const fx = fixture({ studioOnPath: true });
    installCrewToken(CREW_VALUE, fx.owner);
    const r = await setup(fx, [], { lines: [''], secrets: [ACCOUNT_VALUE] });
    expect(r.code).toBe(0);
    expect(r.asked).toHaveLength(2);
    expect(r.asked[0]).toMatch(/^line: .*label.*\[main\]/);
    expect(r.asked[1]).toBe('secret: Token from claude setup-token (hidden): ');
    expect(r.out).toContain('claude setup-token');
    expect(r.out).toContain('account main stored and active');
    expect(listAccounts(fx.owner).map((a) => a.label)).toEqual(['main']);
    // The first account sets up the crew config dir, as account add does.
    expect(fx.pluginRuns.length).toBeGreaterThan(0);
    expect(r.all).not.toContain(ACCOUNT_VALUE);
  });

  it('takes another label from the prompt', async () => {
    const fx = fixture({ studioOnPath: true });
    installCrewToken(CREW_VALUE, fx.owner);
    const r = await setup(fx, [], { lines: ['work'], secrets: [ACCOUNT_VALUE] });
    expect(r.code).toBe(0);
    expect(listAccounts(fx.owner).map((a) => a.label)).toEqual(['work']);
  });

  it('runs both flows in order on a fresh machine', async () => {
    const fx = fixture({ studioOnPath: true });
    const r = await setup(fx, [], { secrets: [CREW_VALUE, ACCOUNT_VALUE], lines: [''] });
    expect(r.code).toBe(0);
    expect(r.asked.map((a) => a.split(':')[0])).toEqual(['secret', 'line', 'secret']);
    expect(r.all).not.toContain(CREW_VALUE);
    expect(r.all).not.toContain(ACCOUNT_VALUE);
  });

  it('stops after a failed token check and asks nothing more', async () => {
    const fx = fixture({ studioOnPath: true });
    fx.ports.credentials.ghWithToken = async () => ({ code: 1, stdout: '', stderr: '' });
    const r = await setup(fx, [], { secrets: [CREW_VALUE], lines: [''] });
    expect(r.code).toBe(1);
    expect(r.asked).toHaveLength(1);
    expect(r.out).toMatch(/failing permission/);
    expect(readCrewTokenFile(fx.owner).kind).toBe('absent');
  });

  it('stops at gh when it is not logged in', async () => {
    const out = await setup(fixture({ ghAuth: 1 }), [], { secrets: [CREW_VALUE] });
    expect(out.code).toBe(1);
    expect(out.asked).toEqual([]);
    expect(out.out).toContain('gh auth login');
  });

  it('stops at gh when it is not installed', async () => {
    const r = await setup(fixture({ noGh: true }));
    expect(r.code).toBe(1);
    expect(r.asked).toEqual([]);
    expect(r.out).toContain('https://cli.github.com');
  });

  it('refuses without a terminal and changes nothing', async () => {
    const fx = fixture();
    const r = await setup(fx, [], { terminal: false, secrets: [CREW_VALUE] });
    expect(r.code).toBe(1);
    expect(r.asked).toEqual([]);
    expect(r.err).toMatch(/needs your own terminal/);
    expect(readCrewTokenFile(fx.owner).kind).toBe('absent');
  });

  it('refuses in a crew session', async () => {
    const fx = fixture();
    const r = await setup(fx, [], { role: 'crew', secrets: [CREW_VALUE] });
    expect(r.code).toBe(1);
    expect(r.asked).toEqual([]);
    expect(r.err).toMatch(/not for crew sessions/);
  });

  it('says the visible label prompt comes first, then the hidden token prompt', async () => {
    const fx = fixture({ studioOnPath: true });
    installCrewToken(CREW_VALUE, fx.owner);
    const r = await setup(fx, [], { lines: [''], secrets: [ACCOUNT_VALUE] });
    expect(r.out).toMatch(/First .*label.*visible/);
    expect(r.out).toMatch(/Then .*token.*hidden/);
    expect(r.asked[0]).toMatch(/visible/);
  });

  it('rejects a label that looks like a token before the hidden prompt', async () => {
    for (const label of ['sk-ant-oat01-abcdef', 'a'.repeat(33), 'a b']) {
      const fx = fixture({ studioOnPath: true });
      installCrewToken(CREW_VALUE, fx.owner);
      const r = await setup(fx, [], { lines: [label], secrets: [ACCOUNT_VALUE] });
      expect(r.code, label).toBe(1);
      expect(
        r.asked.filter((a) => a.startsWith('secret')),
        label,
      ).toEqual([]);
      expect(listAccounts(fx.owner), label).toEqual([]);
      if (label !== 'a b') expect(r.all, label).not.toContain(label);
    }
    const fx = fixture({ studioOnPath: true });
    installCrewToken(CREW_VALUE, fx.owner);
    const r = await setup(fx, [], { lines: ['sk-ant-oat01-abcdef'] });
    expect(r.out).toContain('that looks like a token — it was not stored; enter a short label');
  });

  it('rejects a token typed at the visible repository prompt', async () => {
    for (const answer of [
      'sk-ant-oat01-abcdef',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'github_pat_11abc',
    ]) {
      const fx = fixture({ studioOnPath: true, origin: null });
      addAccount(fx.owner, 'main', ACCOUNT_VALUE, new Date('2026-11-01T00:00:00Z'));
      const r = await setup(fx, [], { lines: [answer], secrets: [CREW_VALUE] });
      expect(r.code, answer).toBe(1);
      expect(r.asked[0], answer).toMatch(/visible/);
      expect(
        r.asked.filter((a) => a.startsWith('secret')),
        answer,
      ).toEqual([]);
      expect(r.out).toContain('that looks like a token — it was not stored; enter owner/name');
      expect(r.all).not.toContain(answer);
    }
  });

  it('names --link when studio is not on PATH', async () => {
    const fx = fixture();
    installCrewToken(CREW_VALUE, fx.owner);
    addAccount(fx.owner, 'main', ACCOUNT_VALUE, new Date('2026-11-01T00:00:00Z'));
    const r = await setup(fx);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/4\. studio in your terminal: not on your PATH/);
    expect(r.out).toContain('studio setup --link');
  });
});

describe('studio setup --link', () => {
  const ready = (o: Opts = {}) => {
    const fx = fixture(o);
    installCrewToken(CREW_VALUE, fx.owner);
    addAccount(fx.owner, 'main', ACCOUNT_VALUE, new Date('2026-11-01T00:00:00Z'));
    return fx;
  };
  const shimFile = (fx: Fx) => join(fx.localBin, 'studio');
  const cacheFile = (fx: Fx) => join(fx.home, 'config', 'studio', 'launcher');

  /** Runs the shim with only node, a fake `claude` (when `list` is given) and the system bins. */
  const runShim = (fx: Fx, args: string[], list?: unknown[]) => {
    const bin = mkdtempSync(join(fx.base, 'bin-'));
    symlinkSync(process.execPath, join(bin, 'node'));
    if (list !== undefined) {
      writeFileSync(join(bin, 'list.json'), JSON.stringify(list));
      writeFileSync(
        join(bin, 'claude'),
        `#!/bin/sh\n[ "$*" = "plugin list --json" ] || exit 2\ncat '${join(bin, 'list.json')}'\n`,
      );
      chmodSync(join(bin, 'claude'), 0o755);
    }
    return spawnSync('/bin/sh', [shimFile(fx), ...args], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: fx.home,
        XDG_CONFIG_HOME: join(fx.home, 'config'),
      },
    });
  };
  /** A newer plugin version next to the fixture's, as an update leaves it. */
  const update = (fx: Fx) => {
    const root = join(fx.base, 'plugin', '0.10.1');
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(join(root, 'bin', 'studio'), launcherScript('0.10.1'));
    writeFileSync(join(fx.base, 'plugin', '0.10.0', '.orphaned_at'), '1\n');
    return root;
  };

  it('writes a regular shim with the marker and the launcher cache after a yes', async () => {
    const fx = ready({ localBinOnPath: true });
    const r = await setup(fx, ['--link'], { lines: [''] });
    expect(r.code).toBe(0);
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]).toMatch(/\[Y\/n\]/);
    const st = lstatSync(shimFile(fx));
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o111).not.toBe(0);
    expect(readFileSync(shimFile(fx), 'utf8').split('\n')[1]).toBe(SHIM_MARKER);
    expect(readFileSync(cacheFile(fx), 'utf8').trim()).toBe(fx.launcher);
    expect(r.out).toMatch(/finds the plugin again after an update/);
    const run = runShim(fx, ['board', '--json']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('launcher 0.10.0 ["board","--json"]');
  });

  it('writes nothing after a no', async () => {
    const fx = ready({ localBinOnPath: true });
    const r = await setup(fx, ['--link'], { lines: ['n'] });
    expect(r.code).toBe(0);
    expect(existsSync(shimFile(fx))).toBe(false);
    expect(r.out).toMatch(/nothing written/);
  });

  it('is done when the shim is current, and updates an older shim of its own', async () => {
    const fx = ready({ localBinOnPath: true });
    await setup(fx, ['--link'], { lines: [''] });
    const again = await setup(fx, ['--link']);
    expect(again.asked).toEqual([]);
    expect(again.out).toMatch(/4\. studio in your terminal: done/);
    writeFileSync(shimFile(fx), `#!/bin/sh\n${SHIM_MARKER}\necho old\n`);
    const r = await setup(fx, ['--link'], { lines: ['y'] });
    expect(r.code).toBe(0);
    expect(r.asked[0]).toMatch(/Update/);
    expect(readFileSync(shimFile(fx), 'utf8')).not.toContain('echo old');
    expect(readdirSync(fx.localBin)).toEqual(['studio']);
  });

  it('never replaces a file without the exact marker, nor a link', async () => {
    for (const content of [
      'mine\n',
      `#!/bin/sh\n${SHIM_MARKER}x\n`,
      `#!/bin/sh\n# studio-shim v2\n`,
    ]) {
      const fx = ready({ localBinOnPath: true });
      mkdirSync(fx.localBin, { recursive: true });
      writeFileSync(shimFile(fx), content);
      const r = await setup(fx, ['--link'], { lines: ['y'] });
      expect(r.code, content).toBe(1);
      expect(r.asked, content).toEqual([]);
      expect(readFileSync(shimFile(fx), 'utf8')).toBe(content);
      expect(r.out).toMatch(/not a Studio shim; nothing changed/);
    }
    const fx = ready({ localBinOnPath: true });
    mkdirSync(fx.localBin, { recursive: true });
    symlinkSync(fx.launcher, shimFile(fx));
    const r = await setup(fx, ['--link'], { lines: ['y'] });
    expect(r.code).toBe(1);
    expect(lstatSync(shimFile(fx)).isSymbolicLink()).toBe(true);
  });

  it('re-resolves a cache whose plugin folder is orphaned, and rewrites the cache', async () => {
    const fx = ready({ localBinOnPath: true });
    await setup(fx, ['--link'], { lines: [''] });
    const root = update(fx);
    const run = runShim(
      fx,
      ['status'],
      [
        { id: 'other@x', enabled: true, installPath: fx.base, version: '1', scope: 'user' },
        { id: 'studio@m', enabled: false, installPath: fx.base, version: '0.9', scope: 'user' },
        { id: 'studio@m', enabled: true, installPath: root, version: '0.10.1', scope: 'user' },
      ],
    );
    expect(run.stderr).toBe('');
    expect(run.stdout).toContain('launcher 0.10.1 ["status"]');
    expect(readFileSync(cacheFile(fx), 'utf8').trim()).toBe(join(root, 'bin', 'studio'));
  });

  it('prefers readFromFolder for a plugin loaded in place', async () => {
    const fx = ready({ localBinOnPath: true });
    await setup(fx, ['--link'], { lines: [''] });
    const root = update(fx);
    const run = runShim(
      fx,
      [],
      [
        {
          id: 'studio@m',
          enabled: true,
          installPath: fx.base,
          readFromFolder: root,
          scope: 'user',
        },
      ],
    );
    expect(run.stdout).toContain('launcher 0.10.1');
  });

  it('says clearly when claude is missing and the cache cannot be used', async () => {
    const fx = ready({ localBinOnPath: true });
    await setup(fx, ['--link'], { lines: [''] });
    update(fx);
    const run = runShim(fx, ['status']);
    expect(run.status).not.toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toMatch(/claude CLI is not on PATH/);
  });

  it('says so when no enabled studio plugin is listed', async () => {
    const fx = ready({ localBinOnPath: true });
    await setup(fx, ['--link'], { lines: [''] });
    update(fx);
    const run = runShim(fx, [], [{ id: 'studio@m', enabled: false, installPath: fx.base }]);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/no enabled studio plugin/);
  });

  it('edits no shell file when ~/.local/bin is not on PATH', async () => {
    const fx = ready();
    const r = await setup(fx, ['--link']);
    expect(r.code).toBe(0);
    expect(r.asked).toEqual([]);
    expect(existsSync(join(fx.home, '.local'))).toBe(false);
    expect(r.out).toMatch(/does not edit shell files/);
    expect(r.out).toContain(`node '${fx.launcher}'`);
  });

  it('is a usage error after a subcommand', async () => {
    const fx = ready();
    const r = await setup(fx, ['ci', '--link']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/--link/);
  });
});
