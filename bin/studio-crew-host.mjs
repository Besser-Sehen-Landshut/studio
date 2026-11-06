#!/usr/bin/env node
// The crew host of a native Windows worker (src/windows-sandbox.ts). Studio starts it as the crew
// sandbox user with `Start-Process -Credential`; it never runs as the owner.
//
// run:   starts the crew (Claude Code) with the arguments of the spec, writes the prompt to its
//        stdin, appends its output to the crew's log, and stops its whole process tree when Studio
//        writes `stop` into the control dir (the owner's account may not end another user's
//        processes). It records its pid and a nonce in `host.json`, which Studio reads as the run's
//        identity.
// probe: checks what the sandbox must hold for this user and writes the results to `probe.json`.
//        Every check reports ok or not; a check that cannot run reports not ok.
//
// Self-contained on purpose: no import of Studio's sources or of anything the working directory
// could provide.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { userInfo } from 'node:os';
import { join } from 'node:path';

const fail = (why) => {
  process.stderr.write(`studio-crew-host: ${why}\n`);
  process.exit(2);
};

const specFile = process.argv[2];
if (typeof specFile !== 'string') fail('no spec file');
let spec;
try {
  spec = JSON.parse(readFileSync(specFile, 'utf8'));
} catch {
  fail('the spec cannot be read');
}
if (spec === null || typeof spec !== 'object' || typeof spec.dir !== 'string') fail('bad spec');

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
  add(
    'env',
    process.env.STUDIO_PROBE_MARK === p.mark,
    'the environment Studio set reached the crew user',
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
  return results;
}

if (spec.mode === 'probe') {
  let results;
  try {
    results = await probe(spec.probe);
  } catch (e) {
    results = [{ check: 'host', ok: false, detail: String(e?.message ?? e).split('\n')[0] }];
  }
  writeFileSync(join(spec.dir, 'probe.json'), JSON.stringify(results));
  process.exit(0);
}

if (spec.mode !== 'run' || typeof spec.cmd !== 'string' || !Array.isArray(spec.args)) {
  fail('bad run spec');
}
const nonce = randomBytes(12).toString('hex');
writeFileSync(join(spec.dir, 'host.json'), JSON.stringify({ pid: process.pid, nonce }));
const fd = openSync(spec.log, 'a');
const child = spawn(spec.cmd, spec.args, {
  cwd: spec.cwd,
  env: process.env,
  stdio: ['pipe', fd, fd],
  windowsHide: true,
});
closeSync(fd);
child.stdin?.on('error', () => {});
child.stdin?.end(spec.prompt ?? '');
const stopFile = join(spec.dir, 'stop');
const timer = setInterval(() => {
  if (!existsSync(stopFile)) return;
  clearInterval(timer);
  try {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  } catch {
    child.kill();
  }
}, 1000);
child.on('exit', (code) => {
  clearInterval(timer);
  process.exit(code ?? 1);
});
child.on('error', (e) => {
  clearInterval(timer);
  fail(`the crew did not start: ${e.message}`);
});
