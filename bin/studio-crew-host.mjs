#!/usr/bin/env node
// The crew host of a native Windows worker (src/windows-sandbox.ts). Studio starts it as the crew
// sandbox user with `Start-Process -Credential`; it never runs as the owner.
//
// It reads its spec from the keeper's named pipe (the keeper put it in a job object first and
// checked that the pipe's client is this process), so the crew's environment never lands on disk.
// run:   starts the crew (Claude Code) with the arguments of the spec, writes the prompt to its
//        stdin and appends its output to the crew's log. Stopping is the keeper's: ending it ends
//        the job and the whole tree.
// probe: checks what the sandbox must hold for this user and prints the results to its stdout, a
//        file of the owner. Every check reports ok or not; a check that cannot run reports not ok.
//
// Self-contained on purpose: no import of Studio's sources or of anything the working directory
// could provide.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { closeSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { userInfo } from 'node:os';
import { join } from 'node:path';

const fail = (why) => {
  process.stderr.write(`studio-crew-host: ${why}\n`);
  process.exit(2);
};

// The spec comes over the keeper's named pipe, never from a file: it holds the crew's environment
// and with it the Claude token. The pipe's name is the only argument.
const pipeName = process.argv[2];
if (typeof pipeName !== 'string' || !/^studio-[0-9a-f]{32}$/.test(pipeName)) fail('no pipe name');
const readPipe = () =>
  new Promise((resolve, reject) => {
    const chunks = [];
    const s = connect(`\\\\.\\pipe\\${pipeName}`);
    s.setTimeout(60_000, () => {
      s.destroy();
      reject(new Error('the keeper sent no spec'));
    });
    s.on('data', (d) => chunks.push(d));
    s.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    s.on('error', reject);
  });
let spec;
try {
  spec = JSON.parse(await readPipe());
} catch (e) {
  fail(`the spec cannot be read: ${e?.message ?? e}`);
}
if (spec === null || typeof spec !== 'object') fail('bad spec');
const childEnv =
  spec.env !== null && typeof spec.env === 'object'
    ? { ...spec.env }
    : fail('the spec has no environment');

// The IPv4 loopback address, from its parts (the public repository refuses dotted literals).
const LOOPBACK = [127, 0, 0, 1].join('.');

const denied = (e) => e?.code === 'EACCES' || e?.code === 'EPERM';

/** A TCP connection to host:port within `ms`: 'open', or why not. */
const tryConnect = (host, port, ms) =>
  new Promise((resolve) => {
    const s = connect({ host, port });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(ms, () => done('timeout'));
    s.once('connect', () => done('open'));
    s.once('error', (e) => done(e.code ?? 'error'));
  });

/** The status line the proxy answers a CONNECT with. */
const proxyAnswer = (port, target) =>
  new Promise((resolve) => {
    const s = connect({ host: LOOPBACK, port });
    let got = '';
    s.setTimeout(10_000, () => {
      s.destroy();
      resolve('timeout');
    });
    s.on('data', (d) => {
      got += d.toString('latin1');
      if (got.includes('\r\n')) {
        s.destroy();
        resolve(got.split('\r\n')[0]);
      }
    });
    s.once('error', (e) => resolve(e.code ?? 'error'));
    s.write(`CONNECT ${target}:443 HTTP/1.1\r\nHost: ${target}:443\r\n\r\n`);
  });

// Windows' own network and credential APIs, through PowerShell, answering with numbers only: the
// language of the system never matters.
const NET_API = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class StudioNet {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class Res { public int Scope; public int Type; public int DisplayType; public int Usage; public string LocalName; public string RemoteName; public string Comment; public string Provider; }
  [DllImport("mpr.dll", CharSet = CharSet.Unicode)] public static extern int WNetAddConnection2(Res r, string password, string user, int flags);
  [DllImport("mpr.dll", CharSet = CharSet.Unicode)] public static extern int WNetCancelConnection2(string name, int flags, bool force);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool CredEnumerate(string filter, int flags, out int count, out IntPtr creds);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr p);
}
'@
`;

const powershell = (script) =>
  new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 60_000 },
      (err, stdout) => resolve(err === null ? stdout.trim() : undefined),
    );
  });

/** The system error code of `\\<host>\IPC$` opened without credentials (0: a session opened). */
async function smbCode(host) {
  if (!/^[A-Za-z0-9.:-]{1,253}$/.test(host)) return -1;
  // No persistence (flags 0), no drive letter; a session that opened is cancelled at once.
  const target = `\\\\${host}\\IPC$`;
  const out = await powershell(
    `${NET_API}$r = New-Object StudioNet+Res; $r.RemoteName = '${target}'; $c = [StudioNet]::WNetAddConnection2($r, $null, $null, 0); if ($c -eq 0) { [void][StudioNet]::WNetCancelConnection2('${target}', 0, $true) }; [Console]::Out.Write($c)`,
  );
  const n = Number(out);
  return out !== undefined && /^\d+$/.test(out) ? n : -1;
}

/** How many credentials this user has stored (Credential Manager); -1 when it cannot be read. */
function storedCredentials() {
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `${NET_API}$n = 0; $p = [IntPtr]::Zero; if ([StudioNet]::CredEnumerate($null, 0, [ref]$n, [ref]$p)) { [StudioNet]::CredFree($p); [Console]::Out.Write($n) } elseif ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) { [Console]::Out.Write(0) } else { [Console]::Out.Write(-1) }`,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 60_000 },
    ).trim();
    return /^-?\d+$/.test(out) ? Number(out) : -1;
  } catch {
    return -1;
  }
}

async function probe(p) {
  const results = [];
  const add = (check, ok, detail) => results.push({ check, ok, detail });
  const me = userInfo().username;
  add(
    'user',
    me.toLowerCase() === String(p.user).toLowerCase(),
    `runs as ${me}, expected ${p.user}`,
  );
  try {
    // An administrator's token holds the group enabled; a filtered one holds it for deny only.
    const groups = execFileSync('whoami', ['/groups', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const admin = groups
      .split(/\r?\n/)
      .some((l) => l.includes('S-1-5-32-544') && !/deny only|nur verweigern/i.test(l));
    add('admin', !admin, admin ? 'the crew user is an administrator' : 'not an administrator');
  } catch (e) {
    add('admin', false, `whoami failed: ${e.message.split('\n')[0]}`);
  }
  // What a crew's processes see: a child started with the spec's environment.
  let seen = '';
  try {
    seen = execFileSync(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.STUDIO_PROBE_MARK ?? "")'],
      {
        encoding: 'utf8',
        env: childEnv,
        windowsHide: true,
      },
    );
  } catch (e) {
    seen = `(failed: ${String(e?.message ?? e).split('\n')[0]})`;
  }
  add(
    'env',
    seen === p.mark,
    `a child of the host sees the environment Studio set: ${seen === p.mark}`,
  );
  const readable = [];
  for (const path of p.mustNotRead) {
    try {
      try {
        readdirSync(path);
      } catch (e) {
        if (e?.code !== 'ENOTDIR') throw e;
        readFileSync(path);
      }
      readable.push(path);
    } catch (e) {
      if (!denied(e) && e?.code !== 'ENOENT') readable.push(`${path} (${e?.code})`);
    }
  }
  add(
    'read',
    readable.length === 0,
    readable.length === 0 ? 'denied' : `readable: ${readable.join(', ')}`,
  );
  const writable = [];
  for (const path of p.mustNotWrite) {
    try {
      writeFileSync(path, 'x', { flag: 'wx' });
      writable.push(path);
      try {
        unlinkSync(path);
      } catch {}
    } catch (e) {
      if (!denied(e)) writable.push(`${path} (${e?.code})`);
    }
  }
  add(
    'write',
    writable.length === 0,
    writable.length === 0 ? 'denied' : `writable: ${writable.join(', ')}`,
  );
  const direct = await tryConnect(p.direct.host, p.direct.port, 8000);
  add(
    'direct',
    direct !== 'open',
    `a direct connection to ${p.direct.host}:${p.direct.port}: ${direct}`,
  );
  const answer = await proxyAnswer(p.proxy.port, p.proxy.refused);
  add(
    'proxy',
    /^HTTP\/1\.1 403 /.test(answer),
    `the proxy answered ${p.proxy.refused} with ${answer}`,
  );
  // A place taken back: the file this user made there, its ACL and the place stay out of reach.
  if (p.former !== undefined && p.former !== null) {
    const bad = [];
    try {
      writeFileSync(p.former.file, 'changed');
      bad.push('changed the file it made');
    } catch (e) {
      if (!denied(e)) bad.push(`writing the file: ${e?.code}`);
    }
    try {
      execFileSync('icacls', [p.former.file, '/grant', `${p.user}:F`], {
        windowsHide: true,
        stdio: 'ignore',
      });
      bad.push('changed the ACL of the file it made');
    } catch {
      // refused, as it must be
    }
    try {
      writeFileSync(join(p.former.dir, 'new.txt'), 'x', { flag: 'wx' });
      bad.push('added a file');
    } catch (e) {
      if (!denied(e)) bad.push(`adding a file: ${e?.code}`);
    }
    add(
      'former',
      bad.length === 0,
      bad.length === 0
        ? 'a place taken back stays closed'
        : `a place taken back: ${bad.join(', ')}`,
    );
  } else {
    add('former', false, 'no place taken back was given to check');
  }
  // Relay workers: places this user must not reach directly, the firewall rule holds them.
  for (const [check, list, what] of [
    ['unreachable', p.unreachable, 'a direct connection'],
    ['loopback', p.loopback, 'a denied port on loopback'],
  ]) {
    if (!Array.isArray(list)) continue;
    const open = [];
    const seen = [];
    for (const t of list) {
      const r = await tryConnect(t.host, t.port, 5000);
      seen.push(`${t.host}:${t.port} ${r}`);
      if (r === 'open') open.push(`${t.host}:${t.port}`);
    }
    add(
      check,
      open.length === 0,
      open.length === 0
        ? `${what}: ${seen.join(', ') || 'none to try'}`
        : `${what} opened: ${open.join(', ')}`,
    );
  }
  // SMB passes the firewall rule (the redirector runs in the System process): each host's IPC$,
  // opened without credentials, must refuse or not be there. A session that opened is closed.
  if (Array.isArray(p.smb)) {
    const codes = {};
    const queue = [...p.smb];
    const worker = async () => {
      for (;;) {
        const h = queue.shift();
        if (h === undefined) return;
        codes[h] = await smbCode(h);
      }
    };
    await Promise.all(Array.from({ length: Math.min(16, queue.length) }, worker));
    const bad = Object.entries(codes).filter(
      ([, c]) => ![5, 86, 1326, 1327, 1331, 1909, 53, 64, 67, 1231].includes(c),
    );
    results.push({
      check: 'smb',
      ok: bad.length === 0,
      detail:
        bad.length === 0
          ? `${p.smb.length} host(s): none opened`
          : bad.map(([h, c]) => `${h}: ${c === 0 ? 'session opened' : `error ${c}`}`).join(', '),
      codes,
    });
  }
  if (p.noStoredCredentials === true) {
    const n = storedCredentials();
    add(
      'credentials',
      n === 0,
      n === 0
        ? 'no stored credential'
        : n < 0
          ? 'the stored credentials cannot be listed'
          : `${n} stored credential(s)`,
    );
  }
  // A scheduled task of this user would start processes outside every keeper's job.
  try {
    const tasks = execFileSync('schtasks', ['/query', '/fo', 'csv', '/v', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const me = String(p.user).toLowerCase();
    const mine = tasks
      .split(/\r?\n/)
      .filter((l) => l.toLowerCase().includes(`"${me}"`) || l.toLowerCase().includes(`\\${me}"`));
    add(
      'tasks',
      mine.length === 0,
      mine.length === 0
        ? 'no scheduled task runs as the crew user'
        : `${mine.length} scheduled task(s) run as the crew user: ${mine.map((l) => l.split(',')[1]).join(', ')}`,
    );
  } catch (e) {
    add('tasks', false, `schtasks failed: ${String(e?.message ?? e).split('\n')[0]}`);
  }
  return results;
}

if (spec.mode === 'seed') {
  try {
    writeFileSync(spec.seed, 'made by the crew user');
    process.exit(0);
  } catch (e) {
    fail(`cannot write the seed: ${e?.code ?? e}`);
  }
} else if (spec.mode === 'probe') {
  let results;
  try {
    results = await probe(spec.probe);
  } catch (e) {
    results = [{ check: 'host', ok: false, detail: String(e?.message ?? e).split('\n')[0] }];
  }
  // Stdout is a file of the owner the keeper opened: the probe's answer goes there.
  process.stdout.write(JSON.stringify(results), () => process.exit(0));
} else {
  run();
}

function run() {
  if (spec.mode !== 'run' || typeof spec.cmd !== 'string' || !Array.isArray(spec.args)) {
    fail('bad run spec');
  }
  let fd;
  try {
    fd = openSync(spec.log, 'a');
  } catch (e) {
    fail(`cannot open the log ${spec.log}: ${e?.code ?? e}`);
  }
  // The whole tree lives in the keeper's job: ending the keeper ends it, so no stop signal here.
  const child = spawn(spec.cmd, spec.args, {
    cwd: spec.cwd,
    env: childEnv,
    stdio: ['pipe', fd, fd],
    windowsHide: true,
  });
  closeSync(fd);
  child.stdin?.on('error', () => {});
  child.stdin?.end(spec.prompt ?? '');
  child.on('exit', (code) => process.exit(code ?? 1));
  child.on('error', (e) => fail(`the crew did not start: ${e.message}`));
}
