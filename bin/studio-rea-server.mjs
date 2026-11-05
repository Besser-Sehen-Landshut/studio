#!/usr/bin/env node
// Starts the REA MCP server for a researcher crew (src/rea.ts, src/rea-install.ts).
//
// Claude Code starts a stdio MCP server in the session's working directory, which for a crew is its
// clone, and with the session's environment, which holds the crew's tokens. This wrapper is what it
// starts instead of the server: it takes everything from a spec file Studio wrote in the state root
// (absolute, owned by this user, writable by nobody else), changes to a neutral, empty directory
// Studio owns, and starts the installed package with a clean environment: PATH, HOME, TMPDIR and the
// XDG directories in the run's own folder, no npm user or global config, and only the engine
// variables the owner config names. No GH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN or any other variable of
// the crew reaches the server.
//
// Self-contained on purpose: no import of Studio's sources or of anything the working directory
// could provide.
import { spawn } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const fail = (why) => {
  process.stderr.write(`studio-rea-server: ${why}\n`);
  process.exit(2);
};

const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
const plain = (path, kind) => {
  if (typeof path !== 'string' || !isAbsolute(path) || /\p{Cc}/u.test(path)) {
    fail('the spec names a path that is not absolute');
  }
  let st;
  try {
    st = lstatSync(path);
  } catch {
    fail(`${path} does not exist`);
  }
  if (st.isSymbolicLink()) fail(`${path} is a symbolic link`);
  if (kind === 'dir' ? !st.isDirectory() : !st.isFile()) fail(`${path} is not a ${kind}`);
  if (uid !== undefined && st.uid !== uid) fail(`${path} belongs to another user`);
  if ((st.mode & 0o022) !== 0) fail(`${path} is writable by group or others`);
  return path;
};

const specFile = plain(process.argv[2], 'file');
let spec;
try {
  spec = JSON.parse(readFileSync(specFile, 'utf8'));
} catch {
  fail('the spec cannot be read');
}
const run = spec?.run ?? {};
const dirs = ['home', 'tmp', 'cache', 'config', 'data', 'state', 'cwd'];
for (const d of dirs) plain(run[d], 'dir');
const entry = plain(spec.entry, 'file');
if (typeof spec.path !== 'string' || /\p{Cc}/u.test(spec.path)) fail('the spec has no PATH');

const ENGINE = /^(GHIDRA_INSTALL_DIR|JAVA_HOME|REA_[A-Z0-9_]{1,60})$/;
const engine = {};
for (const [k, v] of Object.entries(spec.env ?? {})) {
  if (!ENGINE.test(k) || typeof v !== 'string' || /\p{Cc}/u.test(v)) fail(`env ${k} is refused`);
  engine[k] = v;
}

const env = {
  PATH: spec.path,
  ...(typeof spec.lang === 'string' && /^[A-Za-z0-9_.@-]{1,40}$/.test(spec.lang)
    ? { LANG: spec.lang }
    : {}),
  HOME: run.home,
  TMPDIR: run.tmp,
  TMP: run.tmp,
  TEMP: run.tmp,
  XDG_CACHE_HOME: run.cache,
  XDG_CONFIG_HOME: run.config,
  XDG_DATA_HOME: run.data,
  XDG_STATE_HOME: run.state,
  npm_config_userconfig: '/dev/null',
  npm_config_globalconfig: '/dev/null',
  npm_config_cache: run.cache,
  npm_config_update_notifier: 'false',
  ...engine,
};

process.chdir(run.cwd);
const child = spawn(process.execPath, [entry, 'mcp'], { cwd: run.cwd, env, stdio: 'inherit' });
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => child.kill(sig));
}
child.on('error', (e) => fail(`cannot start the server: ${e.message}`));
child.on('exit', (code, signal) => process.exit(code ?? (signal === null ? 1 : 128)));
