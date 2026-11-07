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
import { ownerStateRootFor } from '../src/paths.js';
import { type Ports, realPorts } from '../src/ports.js';
import { installNotifySecret, newNtfyTopic, readNotifySecret } from '../src/push.js';
import { recordSetupSkip } from '../src/rea-consent.js';
import { SHIM_MARKER } from '../src/setup.js';
import type { WorkerPlatform } from '../src/worker-deny.js';

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
  /** Notifications are set up already; default true, so the other steps' tests ask nothing more. */
  notified?: boolean;
  /** What the fake ntfy server answers; default 200. */
  httpReply?: { ok: boolean; status?: number };
  /** The optional REA step was skipped before; default true, so the other tests ask nothing more. */
  researchSkipped?: boolean;
  /** No `claude` on PATH; by default a stand-in is there. */
  noClaude?: boolean;
  /** No bubblewrap and socat on PATH; by default stand-ins are there. */
  noSandbox?: boolean;
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
  const posts: { url: string; body: string; headers: Record<string, string> }[] = [];
  const real = realPorts();
  const ports: Ports = {
    ...real,
    http: {
      async post(url, body, headers) {
        posts.push({ url, body, headers });
        return o.httpReply ?? { ok: true, status: 200 };
      },
    },
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
  if (o.notified !== false)
    installNotifySecret({ transport: 'ntfy', topic: newNtfyTopic() }, owner);
  if (o.researchSkipped !== false) recordSetupSkip(ownerStateRootFor(owner), new Date());
  return {
    base,
    project,
    home,
    env,
    owner,
    ports,
    launcher,
    localBin,
    tokens,
    pluginRuns,
    posts,
    gone: [...(o.noClaude ? ['claude'] : []), ...(o.noSandbox ? ['bwrap', 'socat'] : [])],
  };
}
type Fx = ReturnType<typeof fixture>;

type Io = {
  terminal?: boolean;
  secrets?: string[];
  lines?: string[];
  role?: string;
};

const LINUX: WorkerPlatform = { platform: 'linux', wsl: 'none', automountRoot: '/mnt/' };

async function setup(
  fx: Fx,
  argv: string[] = [],
  io: Io & { platform?: WorkerPlatform; env?: Record<string, string> } = {},
) {
  let out = '';
  let err = '';
  const asked: string[] = [];
  const secrets = [...(io.secrets ?? [])];
  const lines = [...(io.lines ?? [])];
  const env = {
    ...fx.env,
    ...(io.role === undefined ? {} : { STUDIO_ROLE: io.role }),
    ...(io.env ?? {}),
  };
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
    workerPlatform: io.platform ?? LINUX,
    // What this machine has installed never decides: every tool is there unless the fixture
    // takes it away.
    which: (name) => (fx.gone.includes(name) ? undefined : `/usr/bin/${name}`),
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
    expect(r.out).toContain('Fix: sudo apt-get install -y gh, then gh auth login');
  });

  it('step 0 sends native Windows and WSL1 to WSL2, and names what is missing with its command', async () => {
    const win = await setup(fixture(), [], {
      platform: { platform: 'win32', wsl: 'none', automountRoot: '/mnt/' },
    });
    expect(win.code).toBe(1);
    expect(win.out).toContain('0. This machine: the lead does not run on native Windows');
    expect(win.out).toContain('wsl --install -d Ubuntu-24.04');
    expect(win.out).not.toContain('1. GitHub CLI');
    const wsl1 = await setup(fixture(), [], {
      platform: { platform: 'linux', wsl: 'wsl1', automountRoot: '/mnt/' },
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
    });
    expect(wsl1.out).toContain('wsl --set-version Ubuntu 2');
    const bare = await setup(fixture({ noClaude: true }), [], {
      platform: { platform: 'linux', wsl: 'wsl2', automountRoot: '/mnt/' },
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
    });
    expect(bare.code).toBe(1);
    expect(bare.out).toContain('0. This machine: WSL2 (Ubuntu); missing: claude');
    expect(bare.out).toContain('   claude: curl -fsSL https://claude.ai/install.sh | bash');
    const noBox = await setup(fixture({ noSandbox: true }), [], {
      platform: { platform: 'linux', wsl: 'wsl2', automountRoot: '/mnt/' },
    });
    expect(noBox.out).toContain("missing: bubblewrap and socat (Claude Code's sandbox)");
    expect(noBox.out).toContain('   sandbox: sudo apt-get install -y bubblewrap socat');
    expect(bare.asked).toEqual([]);
    const mac = await setup(fixture({ noClaude: true, noGh: true }), [], {
      platform: { platform: 'darwin', wsl: 'none', automountRoot: '/mnt/' },
    });
    expect(mac.out).toContain('0. This machine: macOS; missing: claude');
  });

  it("step 0 under WSL2: Studio's own files never on a Windows drive; a project there is a note", async () => {
    const fx = fixture({ studioOnPath: true });
    installCrewToken(CREW_VALUE, fx.owner);
    addAccount(fx.owner, 'main', ACCOUNT_VALUE, new Date('2026-11-01T00:00:00Z'));
    const onC = await setup(fx, [], {
      platform: {
        platform: 'linux',
        wsl: 'wsl2',
        automountRoot: '/mnt/',
        windowsMounts: [fx.home],
      },
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
    });
    expect(onC.code).toBe(1);
    expect(onC.out).toMatch(/Studio's config folder .* is on a Windows drive/);
    expect(onC.out).toContain('unset XDG_CONFIG_HOME and XDG_STATE_HOME');
    const project = await setup(fx, [], {
      platform: {
        platform: 'linux',
        wsl: 'wsl2',
        automountRoot: '/mnt/',
        windowsMounts: [fx.project],
      },
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
    });
    expect(project.code).toBe(0);
    expect(project.out).toMatch(
      /0\. This machine: done \(WSL2 \(Ubuntu\), git, Node\.js [\d.]+, claude\)/,
    );
    expect(project.out).toContain('is on a Windows drive; clone it into the Linux file system');
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

describe('studio setup: reverse engineering', () => {
  const ready = () => {
    const fx = fixture({ studioOnPath: true, researchSkipped: false });
    installCrewToken(CREW_VALUE, fx.owner);
    addAccount(fx.owner, 'main', ACCOUNT_VALUE, new Date('2026-11-01T00:00:00Z'));
    return fx;
  };

  it('offers the optional step once; a skip is kept, so the next setup asks nothing', async () => {
    const fx = ready();
    const r = await setup(fx, [], { lines: [''] });
    expect(r.code).toBe(0);
    expect(r.asked).toEqual(['line:    Set it up now? [y/N] ']);
    expect(r.out).toContain('6. Reverse engineering (optional): not set up');
    expect(r.out).toContain('skipped; later: studio setup research');
    const again = await setup(fx);
    expect(again.asked).toEqual([]);
    expect(again.out).toContain('6. Reverse engineering (optional): skipped');
  });

  it('studio setup research asks directly, and is for the owner in a terminal only', async () => {
    const fx = ready();
    const r = await setup(fx, ['research'], { lines: ['n'] });
    // Asked the install question at once (no "set it up now?"), and the no is kept.
    expect(r.asked).toEqual([
      'line:    REA is not installed yet. Install rea-agents 6.7.0 now? It runs with your user rights outside the sandbox. [Y/n] ',
    ]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('declined');
    expect((await setup(fx, ['research'], { terminal: false })).code).not.toBe(0);
    expect((await setup(fx, ['research'], { role: 'crew' })).code).not.toBe(0);
  });
});

describe('studio setup: notifications', () => {
  const ready = () => {
    const fx = fixture({ studioOnPath: true, notified: false });
    installCrewToken(CREW_VALUE, fx.owner);
    addAccount(fx.owner, 'main', ACCOUNT_VALUE, new Date('2026-11-01T00:00:00Z'));
    return fx;
  };

  it('offers ntfy, shows the link once, sends a test push and stores the topic after it', async () => {
    const fx = ready();
    const r = await setup(fx, [], { lines: ['', ''] });
    expect(r.code).toBe(0);
    expect(r.asked).toEqual([
      'line:    ntfy or none? [ntfy/none] (Enter: ntfy): ',
      'line:    Press Enter once you subscribed (type skip to stop): ',
    ]);
    const stored = readNotifySecret(fx.owner);
    if (stored.kind !== 'ok') throw new Error('not stored');
    const link = `https://ntfy.sh/${stored.secret.topic}`;
    expect(r.out).toContain('Install the ntfy app and open this link:');
    // Shown exactly once, and only in the owner's terminal.
    expect(r.out.split(stored.secret.topic)).toHaveLength(2);
    expect(r.out).toContain(link);
    expect(r.out).toContain('test push sent');
    expect(fx.posts).toEqual([
      {
        url: link,
        body: 'Test: Studio reaches you here',
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          Title: 'Studio',
          Priority: 'default',
        },
      },
    ]);
    // doctor names the transport, never the topic.
    let doctor = '';
    await runCli(['--project', fx.project, 'doctor'], {
      ports: fx.ports,
      stdout: (s) => {
        doctor += s;
      },
      stderr: (s) => {
        doctor += s;
      },
      env: fx.env,
      homedir: fx.home,
      cwd: fx.project,
    });
    expect(doctor).toContain('notifications: ntfy');
    expect(doctor).not.toContain(stored.secret.topic);
  });

  it('stores nothing when the test push fails, and says why without the topic', async () => {
    const fx = fixture({
      studioOnPath: true,
      notified: false,
      httpReply: { ok: false, status: 429 },
    });
    installCrewToken(CREW_VALUE, fx.owner);
    addAccount(fx.owner, 'main', ACCOUNT_VALUE, new Date('2026-11-01T00:00:00Z'));
    const r = await setup(fx, [], { lines: ['ntfy', ''] });
    expect(r.code).toBe(1);
    expect(r.out).toContain('test push failed: ntfy answered 429; nothing stored');
    expect(readNotifySecret(fx.owner)).toEqual({ kind: 'absent' });
    const topic = /ntfy\.sh\/(studio-\S+)/.exec(r.out)?.[1] as string;
    expect(r.out.split(topic)).toHaveLength(2);
  });

  it('none and an aborted prompt skip the step', async () => {
    for (const lines of [['none'], []]) {
      const fx = ready();
      const r = await setup(fx, [], { lines });
      expect(r.code).toBe(0);
      expect(r.out).toContain('later: studio setup --notifications');
      expect(fx.posts).toEqual([]);
      expect(readNotifySecret(fx.owner)).toEqual({ kind: 'absent' });
    }
  });

  it('--notifications runs only that step, also when it is set up, with the self-hosted server', async () => {
    const fx = fixture({ notified: true });
    const cfg = join(fx.home, 'config', 'studio');
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, 'config.yaml'), 'notify:\n  ntfy_server: https://ntfy.example.org\n');
    const before = readNotifySecret(fx.owner);
    const r = await setup(fx, ['--notifications'], { lines: ['ntfy', ''] });
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/GitHub CLI/);
    expect(fx.posts[0]?.url).toMatch(/^https:\/\/ntfy\.example\.org\/studio-/);
    const after = readNotifySecret(fx.owner);
    expect(after).not.toEqual(before);
  });

  it('refuses a crew session and a missing terminal', async () => {
    const fx = ready();
    expect((await setup(fx, ['--notifications'], { role: 'crew' })).code).not.toBe(0);
    expect((await setup(fx, ['--notifications'], { terminal: false })).code).not.toBe(0);
    expect(fx.posts).toEqual([]);
  });
});
