// The deny set travels from the lead to a relay worker (src/relay-deny-sync.ts): in the pairing
// line under its MAC, into workers.serve.deny and the firewall rules at install, and later with
// `relay pair <label> --update-deny`, signed with the lead's key and checked against the key the
// worker authorized.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ipv4 } from '../src/egress-proxy.js';
import { stateBaseFor, stateDirName } from '../src/paths.js';
import { realPorts } from '../src/ports.js';
import { type Exec, runRelayCommand, scriptOfRun } from '../src/relay-command.js';
import {
  addToServeDeny,
  DENY_NAMESPACE,
  denyDigest,
  denyUpdateMessage,
  denyUpdateProblem,
  EMPTY_DENY,
  encodeDeny,
  leadDenyFor,
  parseDenyUpdate,
  readDenyUpdates,
  renderDenyUpdate,
  sshsigBlob,
  sshsigHolds,
} from '../src/relay-deny-sync.js';
import {
  judgeLockdownAll,
  type LockdownState,
  lockdownFor,
  lockdownWant,
  PROBE_FIXED,
} from '../src/relay-lockdown.js';
import {
  pairProof,
  parsePairLine,
  proofHolds,
  readPairings,
  readPending,
  renderPairLine,
  writePairings,
} from '../src/relay-pair.js';
import {
  installRecordFile,
  MACHINE_PATH,
  machineConfig,
  relayDenyScript,
} from '../src/relay-windows.js';
import { SYSTEM_FOLDERS } from '../src/system-folders-ps.js';
import { readSystemFolders, systemTool, windowsDirectory } from '../src/windows-sandbox.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-deny-sync-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = (name: string) => {
  const d = join(root, `${name}-${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};

async function* chunks(lines: string[]): AsyncGenerator<string> {
  for (const l of lines) yield l;
}

const YAML = `studio: 1
primary_repo: org/app
repos: [org/app]
ci:
  provider: github
  runners: github-hosted
  runner_labels: []
  capacity: { total: 4, merge_max_busy: 3, check_twice_seconds: 30 }
merge: { strategy: studio-queue, contract_paths: [] }
roles:
  builder: { model: sonnet, wip: 1 }
`;

/** A lead home with projects whose studio.yaml deny something for `lab` (and one for another label). */
function leadWithProjects(): {
  home: string;
  owner: { env: Record<string, string>; homedir: string };
} {
  const home = fresh('lead');
  const owner = {
    env: { XDG_STATE_HOME: join(home, 'state'), XDG_CONFIG_HOME: join(home, 'config') },
    homedir: home,
  };
  const project = (name: string, workers: string) => {
    const dir = realpathSync(fresh(name));
    mkdirSync(join(dir, '.studio'), { recursive: true });
    writeFileSync(join(dir, '.studio', 'studio.yaml'), `${YAML}${workers}`);
    const stateRoot = join(stateBaseFor(owner), stateDirName(dir));
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(join(stateRoot, 'marker.json'), JSON.stringify({ projectRealpath: dir }));
  };
  project(
    'app',
    `workers:\n  lab:\n    deny: { hosts: [nas.example], ports: [5432], prefixes: ["${ipv4(198, 51, 100, 0)}/24"] }\n`,
  );
  project(
    'api',
    'workers:\n  lab:\n    deny: { ports: [6379, 5432] }\n  other:\n    deny: { ports: [22] }\n',
  );
  project('plain', '');
  return { home, owner };
}

const WANT = {
  hosts: ['nas.example'],
  ports: [5432, 6379],
  prefixes: [`${ipv4(198, 51, 100, 0)}/24`],
};

const realExec: Exec = async (file, args, o) => {
  try {
    return {
      code: 0,
      stdout: execFileSync(file, args, {
        encoding: 'utf8',
        ...(o?.input === undefined ? {} : { input: o.input }),
      }),
      stderr: '',
    };
  } catch (e) {
    const x = e as { status?: number; stdout?: string; stderr?: string };
    return { code: x.status ?? 1, stdout: String(x.stdout ?? ''), stderr: String(x.stderr ?? '') };
  }
};

describe('the deny set in the pairing line', () => {
  it("is the union of the lead's projects for that label, and the line carries it under its MAC", async () => {
    const { owner, home } = leadWithProjects();
    expect(leadDenyFor(stateBaseFor(owner), 'lab').deny).toEqual(WANT);
    expect(leadDenyFor(stateBaseFor(owner), 'other').deny).toEqual({
      hosts: [],
      ports: [22],
      prefixes: [],
    });
    const out: string[] = [];
    const code = await runRelayCommand({
      rest: ['pair', 'lab', 'worker.example'],
      values: {},
      owner,
      ports: realPorts(),
      env: owner.env,
      homedir: home,
      stdin: chunks([]),
      stdout: (s) => out.push(s),
      stderr: () => {},
      exec: realExec,
      platform: { platform: 'linux', wsl: 'none', automountRoot: '/mnt/' },
    });
    expect(code).toBe(0);
    const text = out.join('');
    const line = /'(studio-pair-2 [^']+)' \| studio relay install --pair -/.exec(
      text,
    )?.[1] as string;
    expect(parsePairLine(line).deny).toEqual(WANT);
    expect(text).toContain('nas.example');
    expect(readPending(owner, 'lab', new Date())?.deny).toEqual(WANT);
  });

  it('refuses a line whose deny set was changed: smaller, larger, or the old format without one', () => {
    const key = `ssh-ed25519 ${'A'.repeat(68)}`;
    const secret = 'a'.repeat(43);
    const line = renderPairLine({ label: 'lab', secret, key, deny: WANT });
    expect(parsePairLine(line).deny).toEqual(WANT);
    const parts = line.split(' ');
    const swap = (deny: object) => [...parts.slice(0, 5), encodeDeny(deny), parts[6]].join(' ');
    expect(() => parsePairLine(swap({ ...WANT, ports: [5432] }))).toThrow(/changed on the way/);
    expect(() => parsePairLine(swap(EMPTY_DENY))).toThrow(/changed on the way/);
    expect(() => parsePairLine(swap({ ...WANT, ports: [5432, 6379, 8080] }))).toThrow(
      /changed on the way/,
    );
    // Another spelling of the same set is refused too: one spelling is signed.
    const loose = Buffer.from(
      JSON.stringify({ ports: WANT.ports, hosts: WANT.hosts, prefixes: WANT.prefixes }),
    ).toString('base64url');
    expect(() => parsePairLine([...parts.slice(0, 5), loose, parts[6]].join(' '))).toThrow(
      /one spelling/,
    );
    expect(() => parsePairLine(`studio-pair-1 lab ${secret} ${key}`)).toThrow(/not a pairing line/);
  });

  it("the worker's proof at --connect covers the deny set it recorded", () => {
    const host = `ssh-ed25519 ${'B'.repeat(68)}`;
    const secret = 'a'.repeat(43);
    const recorded = pairProof(secret, host, denyDigest({ ...WANT, ports: [5432] }));
    expect(proofHolds(secret, host, recorded, denyDigest(WANT))).toBe(false);
    expect(
      proofHolds(secret, host, pairProof(secret, host, denyDigest(WANT)), denyDigest(WANT)),
    ).toBe(true);
  });
});

describe('relay install --pair: the set joins workers.serve.deny and the rules', () => {
  it('reads the line from stdin, puts the set into the lockdown and the config, records its digest', async () => {
    const machine = fresh('m');
    const line = renderPairLine({
      label: 'lab',
      secret: 'a'.repeat(43),
      key: `ssh-ed25519 ${'A'.repeat(68)}`,
      deny: WANT,
    });
    const scripts: string[] = [];
    const exec: Exec = async (file, _args, o) => {
      const s = scriptOfRun(o);
      if (s !== undefined) scripts.push(s);
      return { code: 0, stdout: file === 'powershell.exe' ? '1' : '', stderr: '' };
    };
    const out: string[] = [];
    const code = await runRelayCommand({
      rest: ['install'],
      values: { pair: '-', source: 'fd7a::/48' },
      owner: { env: {}, homedir: machine },
      ports: realPorts(),
      env: {},
      homedir: machine,
      stdin: chunks([`${line}\n`]),
      stdout: (s) => out.push(s),
      stderr: (s) => out.push(s),
      exec,
      platform: { platform: 'win32', wsl: 'none', automountRoot: '/mnt/' },
      elevated: async () => true,
      machine,
    });
    expect(code, out.join('')).toBe(0);
    expect(scripts[0]).toContain('$lockPorts = @(5432, 6379)');
    expect(scripts[0]).toContain(`${ipv4(198, 51, 100, 0)}-${ipv4(198, 51, 100, 255)}`);
    // The pairing line never stands on a command line.
    expect(scripts.join('\n')).not.toContain('studio-pair-2');
    const config = readFileSync(join(machineConfig(machine), 'studio', 'config.yaml'), 'utf8');
    expect(config).toContain('local-subnets');
    expect(config).toContain('nas.example');
    expect(config).toContain('6379');
    expect(readPairings(machine).lab?.denyDigest).toBe(denyDigest(WANT));
  });

  it('adds to an existing config without removing anything, comments kept', () => {
    const file = join(fresh('cfg'), 'config.yaml');
    writeFileSync(
      file,
      '# mine\nworkers:\n  serve:\n    deny:\n      hosts: [local-subnets, printer.example]\n      ports: [22]\n',
    );
    const added = addToServeDeny(file, WANT, '');
    expect(added).toEqual(WANT);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('# mine');
    for (const x of ['printer.example', 'local-subnets', 'nas.example', '22', '5432', '6379'])
      expect(text).toContain(x);
    expect(addToServeDeny(file, { ports: [22] }, '')).toEqual(EMPTY_DENY);
  });
});

/** The active store as the rules of `plan` make it, for the relay account `me`. */
const storeOf = (plan: Awaited<ReturnType<typeof lockdownFor>>, me: string): LockdownState => ({
  me,
  profiles: ['Domain', 'Private', 'Public'].map((name) => ({
    name,
    enabled: 'True',
    local: 'True',
  })),
  rules: [
    {
      enabled: 'True',
      action: 'Block',
      direction: 'Outbound',
      users: `D:(A;;CC;;;${me})`,
      remote: [...plan.local, ...plan.hosts],
    },
  ],
  routes: [],
  ports: (['TCP', 'UDP'] as const).map((protocol) => ({
    protocol,
    enabled: 'True',
    action: 'Block',
    direction: 'Outbound',
    users: `D:(A;;CC;;;${me})`,
    remote: plan.ports.map(String),
  })),
  v6: null,
  connect: Object.fromEntries(PROBE_FIXED.map((t) => [t, '10013'])),
});

describe('a deny entry added later holds the start; the --update-deny line fixes it', () => {
  const me = 'S-1-5-21-1-2-3-1001';
  const lookup = async () => [ipv4(203, 0, 113, 9)];

  it('an entry a project adds after the install holds the start with the --update-deny fix', async () => {
    const installed = await lockdownFor({
      deny: { hosts: ['nas.example'], ports: [5432] },
      lookup,
    });
    const want = await lockdownWant({
      deny: { hosts: ['nas.example'], ports: [5432, 6379], prefixes: [] },
      lookup,
      lead: 'lab',
    });
    const r = judgeLockdownAll(storeOf(installed, me), want);
    expect(r?.kind).toBe('held');
    expect(r?.line).toContain('deny.ports 6379 has no TCP firewall rule');
    expect(r?.line).toContain(
      'on the lead, run studio relay pair lab --update-deny and paste the line it prints in an elevated PowerShell on this PC',
    );
  });

  it('the lead signs the set with its key; the worker takes it only with that key, that label, fresh and unchanged', async () => {
    const { owner, home } = leadWithProjects();
    const keyDir = fresh('key');
    const key = join(keyDir, 'lab_ed25519');
    execFileSync('ssh-keygen', [
      '-q',
      '-t',
      'ed25519',
      '-N',
      '',
      '-C',
      'studio-relay-lab',
      '-f',
      key,
    ]);
    const pub = readFileSync(`${key}.pub`, 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
    mkdirSync(join(owner.env.XDG_CONFIG_HOME as string, 'studio'), { recursive: true });
    writeFileSync(
      join(owner.env.XDG_CONFIG_HOME as string, 'studio', 'config.yaml'),
      `workers:\n  relay:\n    lab:\n      host: worker.example\n      user: studio-relay\n      port: 22\n      host_key: ssh-ed25519 ${'C'.repeat(68)}\n      identity_file: ${key}\n`,
    );
    const out: string[] = [];
    const code = await runRelayCommand({
      rest: ['pair', 'lab'],
      values: { 'update-deny': true },
      owner,
      ports: realPorts(),
      env: owner.env,
      homedir: home,
      stdin: chunks([]),
      stdout: (s) => out.push(s),
      stderr: (s) => out.push(s),
      exec: realExec,
      platform: { platform: 'linux', wsl: 'none', automountRoot: '/mnt/' },
    });
    expect(code, out.join('')).toBe(0);
    const text = out.join('');
    expect(text).toContain("OpenBaseKey('LocalMachine', 'Registry64')");
    expect(text).toContain("GetValue('ProgramFilesDir', $null, 'DoNotExpandEnvironmentNames')");
    const line = /relay update-deny '(studio-deny-1 [^']+)'/.exec(text)?.[1] as string;
    const u = parseDenyUpdate(line);
    expect(u.deny).toEqual(WANT);
    const now = new Date(u.issuedAt * 1000);
    expect(denyUpdateProblem(u, pub, now)).toBeUndefined();
    // Another key, another label, a changed set, too old: refused.
    const other = join(keyDir, 'other');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', other]);
    const otherPub = readFileSync(`${other}.pub`, 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
    expect(denyUpdateProblem(u, otherPub, now)).toMatch(/not signed with the key of lead lab/);
    expect(denyUpdateProblem(u, undefined, now)).toMatch(/no lead lab is paired here/);
    expect(denyUpdateProblem({ ...u, deny: { ...WANT, ports: [5432] } }, pub, now)).toMatch(
      /not signed/,
    );
    expect(denyUpdateProblem({ ...u, label: 'lab2' }, pub, now)).toMatch(/not signed/);
    expect(denyUpdateProblem(u, pub, new Date(now.getTime() + 25 * 60 * 60_000))).toMatch(
      /older than a day/,
    );
    // A signature in another namespace (an SSH key used for git commits, say) never counts.
    const foreign = execFileSync('ssh-keygen', ['-Y', 'sign', '-f', key, '-n', 'git'], {
      input: denyUpdateMessage('lab', WANT, u.issuedAt),
      encoding: 'utf8',
    });
    expect(
      sshsigHolds(
        pub,
        DENY_NAMESPACE,
        denyUpdateMessage('lab', WANT, u.issuedAt),
        sshsigBlob(foreign),
      ),
    ).toBe(false);
    expect(renderDenyUpdate(u)).toBe(line);

    // On the worker: the set joins the config and the rules; then the start goes on.
    const machine = fresh('w');
    writePairings(machine, {
      lab: { key: pub, secret: 'a'.repeat(43), pairedAt: now.toISOString() },
    });
    mkdirSync(machine, { recursive: true });
    writeFileSync(
      installRecordFile(machine),
      JSON.stringify({
        version: 1,
        relayUser: 'studio-relay',
        crewPrefix: 'studio-crew',
        firewall: true,
        prior: null,
      }),
    );
    const scripts: string[] = [];
    const wout: string[] = [];
    const exec: Exec = async (_file, _args, o) => {
      const s = scriptOfRun(o);
      if (s !== undefined) scripts.push(s);
      return { code: 0, stdout: '', stderr: '' };
    };
    const worker = (l: string) =>
      runRelayCommand({
        rest: ['update-deny', l],
        values: {},
        owner: { env: {}, homedir: machine },
        ports: { ...realPorts(), clock: { now: () => now, sleep: async () => {} } },
        env: {},
        homedir: machine,
        stdin: chunks([]),
        stdout: (s) => wout.push(s),
        stderr: (s) => wout.push(s),
        exec,
        platform: { platform: 'win32', wsl: 'none', automountRoot: '/mnt/' },
        elevated: async () => true,
        machine,
      });
    const tampered = line.replace(
      / [A-Za-z0-9_-]+ (\d+ )/,
      ` ${encodeDeny({ ...WANT, ports: [5432] })} $1`,
    );
    await expect(worker(tampered)).rejects.toThrow(/not signed/);
    expect(scripts).toEqual([]);
    expect(await worker(line), wout.join('')).toBe(0);
    // The same line again, or an older one, is refused: the worker took a newer one already.
    await expect(worker(line)).rejects.toThrow(/not newer than the last one/);
    expect(readDenyUpdates(machine).lab).toBe(u.issuedAt);
    expect(scripts[0]).toContain('$lockPorts = @(5432, 6379)');
    expect(scripts[0]).toContain('NoRelayJob');
    // sshd pauses first (no lead can start a job meanwhile), starts again only if it ran; the
    // sshd config stays as it is.
    const script = scripts[0] as string;
    expect(script.indexOf('Stop-Service -Name sshd')).toBeLessThan(script.indexOf('NoRelayJob\n'));
    expect(script).toContain("if ($sshdWas -eq 'Running') { Start-Service -Name sshd }");
    expect(script).not.toContain('sshd_config');
    // New rules first, the old ones after.
    expect(script.indexOf("New-NetFirewallRule @base -Name ('StudioLockdown-local-'")).toBeLessThan(
      script.indexOf('$old | Remove-NetFirewallRule'),
    );
    const config = readFileSync(join(machineConfig(machine), 'studio', 'config.yaml'), 'utf8');
    for (const x of ['nas.example', '5432', '6379']) expect(config).toContain(x);
    // The rules the update wrote hold what the projects deny: the start goes on.
    const plan = await lockdownFor({ deny: WANT, lookup });
    const want = await lockdownWant({ deny: WANT, lookup, lead: 'lab' });
    expect(judgeLockdownAll(storeOf(plan, me), want)).toBeUndefined();
  });
});

describe('the system folders: HKLM and the kernel, never the environment', () => {
  it('the function reads HKLM in the 64-bit view, unexpanded, and refuses another drive, Users and a foreign owner', () => {
    expect(SYSTEM_FOLDERS).toContain('[Microsoft.Win32.RegistryView]::Registry64');
    expect(SYSTEM_FOLDERS).toContain("GetValue('ProgramFilesDir', $null, $raw)");
    expect(SYSTEM_FOLDERS).toContain(
      "[regex]::Replace($k[1], '%SystemDrive%', $drive, 'IgnoreCase')",
    );
    expect(SYSTEM_FOLDERS).toContain("$v.StartsWith($drive + '\\Users\\'");
    expect(SYSTEM_FOLDERS).toContain('$owners -notcontains $owner');
    expect(SYSTEM_FOLDERS).not.toMatch(/\$env:/);
    expect(MACHINE_PATH).toContain(`${SYSTEM_FOLDERS}$sys = SystemFolders`);
  });
  it('no script of Studio reads a folder from the environment', () => {
    for (const f of [
      'relay-windows',
      'relay-uninstall',
      'crew-accounts',
      'relay-lockdown',
      'windows-sandbox',
      'relay-command',
    ]) {
      const text = readFileSync(join(import.meta.dirname, '..', 'src', `${f}.ts`), 'utf8');
      expect(text, f).not.toMatch(
        /\$env:(ProgramFiles|ProgramData|SystemRoot|windir|SystemDrive)\b/i,
      );
      expect(text, f).not.toMatch(/GetFolderPath\('(ProgramFiles|CommonApplicationData)'\)/);
      // Only systemFolders' branch for other platforms (tests on Linux and macOS) reads them.
      const rest =
        f === 'windows-sandbox'
          ? text.replace(/if \(platform !== 'win32'\) \{[\s\S]*?\n {2}\}/, '')
          : text;
      expect(rest, f).not.toMatch(/env\.(ProgramFiles|PROGRAMFILES|ProgramData|PROGRAMDATA)\b/);
    }
  });
});

describe.skipIf(process.platform !== 'win32')('the scripts parse in Windows PowerShell', () => {
  it('SystemFolders gives the same answer under a hostile environment', () => {
    const hostile = {
      ...process.env,
      ProgramFiles: 'C:\\Users\\Public\\fake',
      ProgramData: 'C:\\Users\\Public\\fake',
      ALLUSERSPROFILE: 'C:\\Users\\Public\\fake',
      SystemRoot: 'C:\\Users\\Public\\fake',
      windir: 'C:\\Users\\Public\\fake',
      SystemDrive: 'Z:',
    };
    const ask = (env: NodeJS.ProcessEnv) =>
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `${SYSTEM_FOLDERS}$f = SystemFolders; [Console]::Out.Write($f.windows + '|' + $f.programFiles + '|' + $f.programData)`,
        ],
        { encoding: 'utf8', env },
      );
    const real = ask(process.env);
    expect(ask(hostile)).toBe(real);
    const f = readSystemFolders();
    expect(real.toLowerCase()).toBe(
      `${f.windows}|${f.programFiles}|${f.programData}`.toLowerCase(),
    );
  });
  it('Program Files and ProgramData come from the system, whatever the environment says', () => {
    const real = readSystemFolders();
    const keys = [
      'ProgramFiles',
      'ProgramData',
      'SystemRoot',
      'windir',
      'ALLUSERSPROFILE',
    ] as const;
    const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      for (const k of keys) process.env[k] = 'C:\\Users\\Public\\fake';
      expect(readSystemFolders()).toEqual(real);
    } finally {
      for (const k of keys) process.env[k] = before[k];
    }
    expect(real.programFiles.toLowerCase()).toBe((before.ProgramFiles ?? '').toLowerCase());
    expect(real.programData.toLowerCase()).toBe((before.ProgramData ?? '').toLowerCase());
  });
  it("the Windows folder is the kernel's \\SystemRoot, whatever the environment says", () => {
    const before = { SystemRoot: process.env.SystemRoot, windir: process.env.windir };
    const real = windowsDirectory();
    try {
      process.env.SystemRoot = 'C:\\Users\\Public\\fake';
      process.env.windir = 'C:\\Users\\Public\\fake';
      expect(windowsDirectory()).toBe(real);
      expect(systemTool('icacls')).toBe(`${real}\\System32\\icacls.exe`);
      expect(real.toLowerCase()).toBe((before.SystemRoot ?? '').toLowerCase());
    } finally {
      process.env.SystemRoot = before.SystemRoot;
      process.env.windir = before.windir;
    }
  });
  it('the deny update script and the bootstrap template have no parse errors', async () => {
    const plan = await lockdownFor({ deny: WANT, lookup: async () => [] });
    const files = {
      deny: relayDenyScript({
        machine: 'C:\\Program Files\\Studio\\relay',
        relayUser: 'studio-relay',
        crewPrefix: 'studio-crew',
        lockdown: plan,
      }),
      bootstrap: readFileSync(
        join(import.meta.dirname, '..', 'scripts', 'studio-relay-bootstrap.ps1'),
        'utf8',
      ),
    };
    for (const [name, text] of Object.entries(files)) {
      const file = join(fresh('ps'), `${name}.ps1`);
      writeFileSync(file, text);
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$e = $null; $t = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$t, [ref]$e); @($e).Count; @($e | ForEach-Object { $_.Message + ' @' + $_.Extent.StartLineNumber })`,
        ],
        { encoding: 'utf8' },
      );
      expect(out.trim().split(/\r?\n/)[0], `${name}: ${out}`).toBe('0');
    }
  });
});
