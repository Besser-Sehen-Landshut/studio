// Crew guard: decides whether a tool call of a crew session may run.
// The sandbox only covers shell commands, so this is the layer that confines the file tools
// (Edit/Write/...) to the worktree. Best effort for shell commands; every internal error denies.
// This hook is the LAST of four layers: sandbox, least-privilege token, server-side branch
// protection (the primary layer for main) and this guard. It is best effort for shell commands.
// The guard is a convenience layer, not a security boundary. The boundary is the sandbox, a
// least-privilege token and server-side branch protection. Constructs that are hard to check
// (eval, source, shells with command strings, xargs, command substitution inside git/gh, ...) are
// denied outright instead of being parsed.
// When in doubt, deny; prefer simple deny rules over clever parsing, and allowlists over deny lists.
// Principle: fail closed. In any security-relevant position (command word, subcommand and
// arguments, push refspecs, write paths, deploy matching) an unresolved word (variable, command
// substitution, backtick, unexpandable glob) is a deny, never ignored or taken literally.
// Keep this module free of imports from other src files: bin/studio-guard.mjs may load it directly
// through Node's native TypeScript type stripping when the package was not built.
import { type Dirent, globSync, lstatSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { type ParseEntry, parse as shellParse } from 'shell-quote';

export interface GuardInput {
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Working directory reported by the hook; defaults to the worktree. */
  cwd?: string;
}

export interface GuardContext {
  worktree: string;
  /** Globs over a normalised command segment (`*` matches anything). */
  ownerOnly: string[];
  deployCommands: string[];
  /** Path globs of files a crew session must not touch. */
  secretGlobs: string[];
  /** Workflows (file name or name) a crew session may start with `gh workflow run`. */
  crewAllowedWorkflows?: string[];
  /** Refs a crew session may pass to `gh workflow run --ref`. */
  crewAllowedWorkflowRefs?: string[];
  /** Absolute paths that must never be written (guard ctx file, state dir). */
  protectedPaths?: string[];
  /** Files and directories the read tools may reach, besides the worktree. Nothing else is. */
  readRoots?: string[];
  /** Read roots of Claude Code's own files, where `skillRootWaivedGlobs` give way. */
  skillRoots?: string[];
  /** Path globs of the saved tool outputs of this run, readable like a skill root. */
  toolResultGlobs?: string[];
  /** Entries of `secretGlobs` that cover a whole login dir. Every other entry always applies. */
  skillRootWaivedGlobs?: string[];
  /** The crew's item: `gh pr create` is allowed only for its branch `studio/<item>`. */
  item?: string;
  /** The branch the item's pull request targets: `gh pr create --base` must name it. */
  base?: string;
  /**
   * Ports a worker machine denies (src/worker-deny.ts): a Bash command that names one is refused.
   * A convenience like the rest of the guard: the sandbox's network rules are the boundary.
   */
  deniedPorts?: number[];
  /**
   * A researcher with REA (src/rea.ts): the MCP tools it may call (exact names; every other
   * `mcp__*` tool is denied), the one analysis directory those tools may reach (and nothing else,
   * the clone included; the crew's own shell and file tools never reach it), and shell commands it
   * may not run (debuggers, device and capture tools).
   */
  mcpAllow?: string[];
  artifacts?: string;
  blockedCommands?: string[];
  /** The REA tool classes the owner opened for this item (some arguments need one). */
  reaClasses?: string[];
  /** A research item: it opens no pull request, so every `git push` is refused. */
  noPush?: boolean;
  /**
   * Per allowed MCP tool (src/rea-schemas.ts): the argument names it accepts, those that name a
   * place on disk, and the free-text ones. Any other argument is refused.
   */
  mcpKeys?: Record<string, { keys: string[]; paths: string[]; text: string[] }>;
}

export interface GuardResult {
  decision: 'allow' | 'deny';
  reason?: string;
}

export const DEFAULT_SECRET_GLOBS: string[] = [
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/.npmrc',
  '**/.netrc',
  '**/credentials*',
];

/** Where a command names a denied port a denied port in a command: `:5432`, `--port 5432`, `-p5432`, `port=5432`. */
export function namedDeniedPort(cmd: string, ports: readonly number[]): number | undefined {
  for (const port of ports) {
    const p = String(port);
    const re = new RegExp(
      `(?::${p}(?![0-9]))|(?:(?:^|[\\s'"])(?:--port|-p|-P)(?:[\\s=]+|)${p}(?![0-9]))|(?:\\bport\\s*=\\s*${p}(?![0-9]))`,
      'i',
    );
    if (re.test(cmd)) return port;
  }
  return undefined;
}

/** Caps for glob expansion and directory walks; exceeding one denies (never truncates). */
export const GUARD_LIMITS = { glob: 1000, walk: 50000 };

class Deny extends Error {}
const deny = (reason: string): never => {
  throw new Deny(reason);
};

/** Marks a part of a command that is only known at run time (command substitution, xargs input). */
const SUBST = '\u0001';

interface Env {
  wt: string;
  secretRes: RegExp[];
  deployGlobs: { glob: string; re: RegExp }[];
  ownerGlobs: { glob: string; re: RegExp }[];
  allowedWorkflows: string[];
  allowedRefs: string[];
  protectedReal: string[];
  readRoots: string[];
  skillRoots: string[];
  toolResultRes: RegExp[];
  /** The secret rules no read root waives. */
  hardSecretRes: RegExp[];
  item: string | undefined;
  base: string | undefined;
  mcpAllow: Set<string>;
  /** Real path of the analysis directory; undefined for every other crew. */
  artifacts: string | undefined;
  /** The directory as the context spelled it. */
  artifactsGiven: string | undefined;
  blockedCommands: Set<string>;
  reaClasses: Set<string>;
  noPush: boolean;
  mcpKeys: Map<string, { keys: Set<string>; paths: Set<string>; text: Set<string> }>;
}

const isUnder = (roots: string[], p: string): boolean =>
  roots.some((r) => p === r || p.startsWith(`${r}/`));

/** Skill files and saved tool outputs in a config dir: not the login beside them. */
const isClaudeFile = (env: Env, p: string): boolean =>
  isUnder(env.skillRoots, p) || env.toolResultRes.some((re) => re.test(p));

export function evaluateGuard(input: GuardInput, ctx: GuardContext): GuardResult {
  try {
    check(input, ctx);
    return { decision: 'allow' };
  } catch (err) {
    if (err instanceof Deny) return { decision: 'deny', reason: err.message };
    return {
      decision: 'deny',
      reason: `guard error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------- globs

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\*?]/g, '\\$&');
}

function fileGlobToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; ) {
    if (glob.startsWith('**/', i)) {
      re += '(?:.*/)?';
      i += 3;
    } else if (glob.startsWith('**', i)) {
      re += '.*';
      i += 2;
    } else if (glob[i] === '*') {
      re += '[^/]*';
      i++;
    } else if (glob[i] === '?') {
      re += '[^/]';
      i++;
    } else {
      re += escapeRe(glob[i] as string);
      i++;
    }
  }
  return new RegExp(`^${glob.startsWith('/') ? '' : '(?:.*/)?'}${re}$`, 'i');
}

function commandGlobToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.split('*').map(escapeRe).join('.*')}$`);
}

function isSecretString(env: Env, s: string): boolean {
  if (basename(s) === '.env.example') return false;
  const ownFile = !s.split('/').includes('..') && isClaudeFile(env, s);
  return (ownFile ? env.hardSecretRes : env.secretRes).some((re) => re.test(s));
}

/** Expands simple comma brace lists (`{a,b}`); ranges are left alone. */
function braceExpand(s: string, budget = { n: 64 }): string[] {
  const open = s.indexOf('{');
  if (open < 0) return [s];
  let depth = 0;
  const commas: number[] = [];
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        if (commas.length === 0) return [s];
        const parts: string[] = [];
        let from = open + 1;
        for (const at of [...commas, i]) {
          parts.push(s.slice(from, at));
          from = at + 1;
        }
        const out: string[] = [];
        for (const p of parts) {
          for (const rest of braceExpand(s.slice(0, open) + p + s.slice(i + 1), budget)) {
            if (--budget.n < 0) deny('brace expansion too large');
            out.push(rest);
          }
        }
        return out;
      }
    } else if (c === ',' && depth === 1) commas.push(i);
  }
  return [s];
}

// ---------------------------------------------------------------- paths

/** Resolves a path to its real location: symlinks (also dangling ones) and `..` are followed in order. */
function resolveReal(p: string, base: string): string {
  const start = isAbsolute(p) ? p : `${base}/${p}`;
  const queue = start.split('/').filter((x) => x !== '' && x !== '.');
  let cur = '/';
  let missing = false;
  let hops = 0;
  while (queue.length > 0) {
    const seg = queue.shift() as string;
    if (seg === '..') {
      cur = dirname(cur);
      continue;
    }
    const next = cur === '/' ? `/${seg}` : `${cur}/${seg}`;
    if (missing) {
      cur = next;
      continue;
    }
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(next);
    } catch {
      missing = true;
      cur = next;
      continue;
    }
    if (st.isSymbolicLink()) {
      if (++hops > 40) deny('too many symlinks');
      const target = readlinkSync(next);
      if (isAbsolute(target)) cur = '/';
      queue.unshift(...target.split('/').filter((x) => x !== '' && x !== '.'));
      continue;
    }
    cur = next;
  }
  return cur;
}

function isInside(env: Env, real: string): boolean {
  return real === env.wt || real.startsWith(`${env.wt}/`);
}

const ALLOWED_DEVICES = new Set(['/dev/null', '/dev/stdout', '/dev/stderr']);

const hasMagic = (t: string): boolean => /[*?[]/.test(t);

function capped(paths: string[]): string[] {
  if (paths.length > GUARD_LIMITS.glob) deny('glob expands to too many paths');
  return paths;
}

/** Concrete candidates for a path with glob characters: matches of its directory part and leaf. */
function expandGlobPath(t: string, base: string): string[] {
  const out = [t];
  if (!hasMagic(t)) return out;
  const idx = t.lastIndexOf('/');
  const dirPart = idx > 0 ? t.slice(0, idx) : idx === 0 ? '/' : '';
  const leaf = t.slice(idx + 1);
  let dirs: string[] = [dirPart];
  try {
    if (dirPart !== '' && hasMagic(dirPart)) dirs = capped(globSync(dirPart, { cwd: base }));
    for (const d of dirs) {
      if (hasMagic(leaf)) {
        const where = d === '' ? base : resolveReal(d, base);
        for (const m of capped(globSync(leaf, { cwd: where }))) out.push(join(d, m));
      } else out.push(join(d, leaf));
    }
  } catch (err) {
    if (err instanceof Deny) throw err;
    deny(`unexpandable glob in write path: ${t}`);
  }
  return out;
}

function isProtected(env: Env, real: string): boolean {
  const low = real.toLowerCase();
  // A `.git` at any depth below the clone: a nested repository has hooks and config of its own.
  const below = isInside(env, real) ? low.slice(env.wt.length).split('/') : [];
  return (
    below.includes('.git') || env.protectedReal.some((p) => low === p || low.startsWith(`${p}/`))
  );
}

function checkWritePath(env: Env, tok: string, cwd: string | null, why: string): void {
  if (ALLOWED_DEVICES.has(tok)) return;
  for (const t0 of braceExpand(tok)) {
    if (t0.includes(SUBST) || t0.includes('$') || t0.includes('`') || t0.startsWith('~')) {
      deny(`unresolvable path in ${why}: ${t0.replaceAll(SUBST, '<runtime>')}`);
    }
    if (t0 === '') deny(`empty path in ${why}`);
    if (cwd === null && !isAbsolute(t0)) {
      deny(`relative path after unresolvable cd in ${why}: ${t0}`);
    }
    for (const t of expandGlobPath(t0, cwd ?? env.wt)) {
      const real = resolveReal(t, cwd ?? env.wt);
      if (!isInside(env, real)) deny(`write outside worktree (${why}): ${t}`);
      if (isProtected(env, real)) deny(`write to protected path (${why}): ${t}`);
    }
  }
}

function checkSecretPath(env: Env, tok: string, base: string): void {
  const lexical = isAbsolute(tok) ? normalize(tok) : normalize(join(base, tok));
  if (isSecretString(env, tok) || isSecretString(env, lexical)) {
    deny(`secret file access: ${tok}`);
  }
  if (isSecretString(env, resolveReal(tok, base))) deny(`secret file access: ${tok}`);
}

function checkSecretToken(env: Env, tok: string, base: string): void {
  if (tok === '' || tok.length > 4096 || /\s/.test(tok)) return;
  const eq = tok.indexOf('=');
  const variants = eq > 0 ? [tok, tok.slice(eq + 1)] : [tok];
  for (const v of variants) {
    for (const e of braceExpand(v)) {
      if (e === '' || e.includes(SUBST)) continue;
      checkSecretPath(env, e, base);
      if (/[*?[]/.test(e)) {
        let matches: string[] = [];
        try {
          matches = capped(globSync(e, { cwd: base }));
        } catch (err) {
          if (err instanceof Deny) throw err;
          // an unreadable glob cannot match a secret we could see
        }
        for (const m of matches) checkSecretPath(env, m, base);
      }
    }
  }
}

// ---------------------------------------------------------------- shell scanning

/** Index of the `)` that closes the `(` at `open`, aware of quotes and nesting. */
function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') i++;
    else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) deny('unparseable command');
      i = j;
    } else if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') i++;
        else if (src[i] === '$' && src[i + 1] === '(') i = matchParen(src, i + 1);
        i++;
      }
      if (i >= src.length) deny('unparseable command');
    } else if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return deny('unparseable command');
}

function matchBacktick(src: string, open: number): number {
  for (let i = open + 1; i < src.length; i++) {
    if (src[i] === '\\') i++;
    else if (src[i] === '`') return i;
  }
  return deny('unparseable command');
}

/** Substitutions inside an unquoted heredoc body (quotes in prose must not matter). */
function bodySubstitutions(body: string, subs: string[]): void {
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\') i++;
    else if (body[i] === '`') {
      const end = matchBacktick(body, i);
      subs.push(body.slice(i + 1, end));
      i = end;
    } else if (body[i] === '$' && body[i + 1] === '(') {
      let depth = 0;
      let j = i + 1;
      for (; j < body.length; j++) {
        if (body[j] === '(') depth++;
        else if (body[j] === ')' && --depth === 0) break;
      }
      if (j >= body.length) deny('unparseable command');
      subs.push(body.slice(i + 2, j));
      i = j;
    }
  }
}

interface Scanned {
  lines: string[];
  subs: string[];
}

/**
 * Splits a command into logical lines (newline = `;`), replaces command substitutions by a marker and
 * collects their payloads, drops comments and heredoc bodies. Throws on unbalanced quoting.
 */
function scan(src: string): Scanned {
  const lines: string[] = [];
  const subs: string[] = [];
  const heredocs: { delim: string; quoted: boolean; strip: boolean }[] = [];
  let out = '';
  let wordStart = true;
  let i = 0;
  const n = src.length;

  const consumeHeredocs = () => {
    for (const h of heredocs.splice(0)) {
      const body: string[] = [];
      while (i < n) {
        let end = src.indexOf('\n', i);
        if (end < 0) end = n;
        let line = src.slice(i, end);
        i = Math.min(end + 1, n);
        if (h.strip) line = line.replace(/^\t+/, '');
        if (line === h.delim) break;
        body.push(line);
      }
      if (!h.quoted) bodySubstitutions(body.join('\n'), subs);
    }
  };

  while (i < n) {
    const c = src[i] as string;
    if (c === '\\') {
      if (i + 1 >= n) {
        out += '\\\\';
        i++;
      } else if (src[i + 1] === '\n') i += 2;
      else {
        out += c + src[i + 1];
        i += 2;
      }
      wordStart = false;
    } else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) deny('unparseable command');
      out += src.slice(i, j + 1);
      i = j + 1;
      wordStart = false;
    } else if (c === '"') {
      let j = i + 1;
      let seg = '"';
      for (;;) {
        if (j >= n) deny('unparseable command');
        const d = src[j] as string;
        if (d === '\\') {
          seg += d + (src[j + 1] ?? '');
          j += 2;
        } else if (d === '"') {
          seg += '"';
          j++;
          break;
        } else if (d === '$' && src[j + 1] === '(') {
          const end = matchParen(src, j + 1);
          subs.push(src.slice(j + 2, end));
          seg += SUBST;
          j = end + 1;
        } else if (d === '`') {
          const end = matchBacktick(src, j);
          subs.push(src.slice(j + 1, end));
          seg += SUBST;
          j = end + 1;
        } else {
          seg += d;
          j++;
        }
      }
      out += seg;
      i = j;
      wordStart = false;
    } else if (c === '$' && src[i + 1] === '(') {
      const end = matchParen(src, i + 1);
      subs.push(src.slice(i + 2, end));
      out += SUBST;
      i = end + 1;
      wordStart = false;
    } else if (c === '`') {
      const end = matchBacktick(src, i);
      subs.push(src.slice(i + 1, end));
      out += SUBST;
      i = end + 1;
      wordStart = false;
    } else if ((c === '<' || c === '>') && src[i + 1] === '(') {
      const end = matchParen(src, i + 1);
      subs.push(src.slice(i + 2, end));
      out += SUBST;
      i = end + 1;
      wordStart = false;
    } else if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      let j = i + 2;
      const strip = src[j] === '-';
      if (strip) j++;
      while (src[j] === ' ' || src[j] === '\t') j++;
      let delim = '';
      let quoted = false;
      while (j < n && !/[\s;&|<>()]/.test(src[j] as string)) {
        const d = src[j] as string;
        if (d === '\\') {
          quoted = true;
          delim += src[j + 1] ?? '';
          j += 2;
        } else if (d === "'") {
          quoted = true;
          const e = src.indexOf("'", j + 1);
          if (e < 0) deny('unparseable command');
          delim += src.slice(j + 1, e);
          j = e + 1;
        } else if (d === '"') {
          quoted = true;
          j++;
          while (j < n && src[j] !== '"') {
            if (src[j] === '\\' && /["\\$`]/.test(src[j + 1] ?? '')) j++;
            delim += src[j] ?? '';
            j++;
          }
          if (j >= n) deny('unparseable command');
          j++;
        } else {
          delim += d;
          j++;
        }
      }
      heredocs.push({ delim, quoted, strip });
      out += '<< HEREDOC';
      i = j;
      wordStart = false;
    } else if (c === '\n') {
      lines.push(out);
      out = '';
      i++;
      consumeHeredocs();
      wordStart = true;
    } else if (c === '#') {
      if (wordStart) {
        while (i < n && src[i] !== '\n') i++;
      } else {
        out += '\\#';
        i++;
      }
    } else {
      out += c;
      i++;
      wordStart = /[\s;&|()<>]/.test(c);
    }
  }
  if (out !== '') lines.push(out);
  return { lines, subs };
}

const SEPARATORS = new Set(['&&', '||', ';', ';;', '|', '|&', '&', '(', ')', '<(']);

interface Segment {
  words: string[];
  writes: string[];
  reads: string[];
}

type Entry = ParseEntry;

function wordOf(entry: Entry | undefined): string | undefined {
  if (typeof entry === 'string') return entry;
  if (entry && 'op' in entry && entry.op === 'glob') return (entry as { pattern: string }).pattern;
  return undefined;
}

function isOp(e: Entry | undefined, op: string): boolean {
  return typeof e === 'object' && e !== null && 'op' in e && e.op === op;
}

function toSegments(line: string): Segment[] {
  const toks = shellParse(line, (key) => `$${key}`) as Entry[];
  const segments: Segment[] = [];
  let cur: Segment = { words: [], writes: [], reads: [] };
  const push = () => {
    if (cur.words.length || cur.writes.length || cur.reads.length) segments.push(cur);
    cur = { words: [], writes: [], reads: [] };
  };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k] as Entry;
    const word = wordOf(t);
    if (word !== undefined) {
      cur.words.push(word);
    } else if (isOp(t, '(') && isOp(toks[k + 1], '(')) {
      deny(ARITHMETIC_DENIED);
    } else if (typeof t !== 'object') {
      // unreachable: strings are words
    } else if ('comment' in t) {
      // scan() removes comments; a leftover one is ignored
    } else if ('op' in t) {
      if (SEPARATORS.has(t.op)) {
        push();
      } else if (t.op === '<<' || t.op === '<<<') {
        k++; // heredoc delimiter or here-string: data
      } else if (t.op === '<') {
        const target = wordOf(toks[++k]);
        if (target === undefined) deny('unparseable command');
        cur.reads.push(target as string);
      } else if (['>', '>>', '>|', '&>', '&>>', '>&', '<>'].includes(t.op)) {
        const target = wordOf(toks[++k]);
        if (target === undefined) deny('unparseable command');
        if (t.op === '>&' && /^(\d+|-)$/.test(target as string)) continue;
        cur.writes.push(target as string);
      } else {
        deny(`unparseable command (operator ${t.op})`);
      }
    }
  }
  push();
  return segments;
}

// ---------------------------------------------------------------- bash

interface State {
  cwd: string | null;
}

const WRAPPER_WORDS = new Set([
  '{',
  '}',
  '!',
  'then',
  'do',
  'else',
  'elif',
  'if',
  'while',
  'until',
]);
/** Wrappers that are denied outright: their option syntax is too rich to check. */
const DENIED_WRAPPERS = new Set([
  'stdbuf',
  'ionice',
  'chrt',
  'setsid',
  'unbuffer',
  'coproc',
  'doas',
  'run0',
  'pkexec',
  'shopt',
  'nice',
  'xargs',
  'eval',
  'source',
  '.',
  'mapfile',
  'readarray',
  'getopts',
  'trap',
  'alias',
  'hash',
  'let',
  'script',
  'flock',
  'watch',
]);
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOOSE_ASSIGNMENT = /^([^=\s/]+)=/;

/** Name of an assignment word (`NAME=value`), undefined for other words; odd names are denied. */
function assignmentName(w: string): string | undefined {
  const m = LOOSE_ASSIGNMENT.exec(w);
  if (!m) return undefined;
  const name = m[1] as string;
  if (!VAR_NAME.test(name))
    deny(`assignment to "${name}" is not allowed (plain variable names only)`);
  return name;
}
/** Case-sensitive on purpose: `path=src` and `env=prod` are ordinary names. Only npm reads `npm_config_*` in any case. */
const SENSITIVE_VAR =
  /^(STUDIO_|NODE_OPTIONS$|NODE_PATH$|NPM_CONFIG_|PNPM_|YARN_|COREPACK_|GIT_|GH_|GITHUB_|LD_|DYLD_|CDPATH$|PATH$|HOME$|BASH_ENV$|ENV$|SHELLOPTS$|BASHOPTS$|PROMPT_COMMAND$|IFS$)/;
const SENSITIVE_VAR_ANY_CASE = /^npm_config_/i;

const unresolved = (w: string): boolean => w.includes(SUBST) || w.includes('$') || w.includes('`');
/** A word whose real value depends on the shell at run time (variables, substitutions, globs). */
const unresolvedWord = (w: string): boolean =>
  unresolved(w) || (/[*?[]/.test(w) && w !== '[' && w !== '[[');

function checkVarName(name: string): void {
  if (SENSITIVE_VAR.test(name) || SENSITIVE_VAR_ANY_CASE.test(name))
    deny(`setting ${name} is not allowed`);
}

function checkAssignment(_state: State, a: string): void {
  const name = assignmentName(a);
  if (name !== undefined) checkVarName(name);
}

/** Simple wrapper forms only; anything with options is denied. */
function noOption(words: string[], i: number, what: string): void {
  if ((words[i] ?? '').startsWith('-')) deny(`${what} with options is not allowed`);
}

/** Index of the real command word after env assignments and wrapper commands. */
function skipWrappers(words: string[], state: State): number {
  let i = 0;
  while (i < words.length) {
    const w = words[i] as string;
    if (assignmentName(w) !== undefined) {
      checkAssignment(state, w);
      i++;
      continue;
    }
    const b = basename(w);
    if (WRAPPER_WORDS.has(b)) {
      i++;
      continue;
    }
    if (b === 'env') deny('env wrapper denied; use NAME=value cmd');
    if (DENIED_WRAPPERS.has(b)) deny(`${b} is not allowed`);
    switch (b) {
      case 'time':
      case 'command':
      case 'builtin':
      case 'exec':
      case 'nohup':
        noOption(words, i + 1, b);
        i++;
        break;
      case 'timeout':
        noOption(words, i + 1, 'timeout');
        if (!/^\d+(\.\d+)?[smhd]?$/.test(words[i + 1] ?? ''))
          deny('timeout needs a plain duration');
        noOption(words, i + 2, 'timeout');
        i += 2;
        break;
      default:
        return i;
    }
  }
  return i;
}

function positionals(args: string[]): string[] {
  const out: string[] = [];
  let end = false;
  for (const a of args) {
    if (!end && a === '--') end = true;
    else if (!end && a.startsWith('-') && a !== '-') continue;
    else out.push(a);
  }
  return out;
}

/** Values of `-x V`, `--long V` and `--long=V` style options. */
function optionValues(args: string[], short: string[], long: string[]): string[] {
  const out: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string;
    if (short.includes(a) || long.includes(a)) {
      if (k + 1 < args.length) out.push(args[k + 1] as string);
      else deny(`missing value for ${a}`);
      k++;
    } else {
      for (const l of long) if (a.startsWith(`${l}=`)) out.push(a.slice(l.length + 1));
    }
  }
  return out;
}

const WRITE_ALL = new Set([
  'rm',
  'rmdir',
  'mkdir',
  'touch',
  'chmod',
  'chown',
  'chgrp',
  'truncate',
  'ln',
  'tee',
  'unlink',
  'shred',
  'mv',
  'install',
]);

function writeTargets(name: string, args: string[]): string[] {
  const pos = positionals(args);
  const targetDirs = optionValues(args, ['-t'], ['--target-directory']);
  if (WRITE_ALL.has(name)) return [...pos, ...targetDirs];
  switch (name) {
    case 'cp':
      return targetDirs.length > 0 ? targetDirs : pos.slice(-1);
    case 'rsync':
      return pos.slice(-1);
    case 'dd':
      return args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3));
    case 'sed': {
      const inPlace = args.some(
        (a) =>
          a === '-i' || /^-i/.test(a) || /^--in-place/.test(a) || /^-[A-Za-z]*i[A-Za-z]*$/.test(a),
      );
      if (!inPlace) return [];
      const hasScriptOpt = args.some((a) => /^(-[A-Za-z]*[ef]|--expression|--file)/.test(a));
      return hasScriptOpt ? pos : pos.slice(1);
    }
    case 'curl':
      return optionValues(args, ['-o'], ['--output', '--output-dir']);
    case 'wget':
      return optionValues(args, ['-O', '-P'], ['--output-document', '--directory-prefix']);
    case 'tar':
      return optionValues(args, ['-C'], ['--directory']);
    default:
      return [];
  }
}

const GH_VALUE_FLAGS = ['-R', '--repo', '--hostname'];

/** Drops gh's global flags (`-R x`, `--repo x`, `--repo=x`, `--hostname x`) wherever they appear. */
function stripGhFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string;
    if (GH_VALUE_FLAGS.includes(a)) k++;
    else if (a.startsWith('--repo=') || a.startsWith('--hostname=')) continue;
    else out.push(a);
  }
  return out;
}

function checkCommandGlobs(env: Env, fromCommand: string[], raw: string[]): void {
  const head = basename(fromCommand[0] as string);
  const rest = fromCommand.slice(1);
  const normal = [head, ...(head === 'gh' ? stripGhFlags(rest) : rest)];
  const texts = new Set([raw.join(' '), fromCommand.join(' '), normal.join(' ')]);
  for (const text of texts) {
    for (const g of env.ownerGlobs) {
      if (g.re.test(text)) deny(`owner-only command (matches "${g.glob}")`);
    }
    for (const g of env.deployGlobs) {
      if (g.re.test(text)) deny(`deploy command (matches "${g.glob}")`);
    }
  }
}

const PUSH_DANGEROUS = [
  '--force',
  '--force-with-lease',
  '--force-if-includes',
  '--mirror',
  '--delete',
  '--prune',
  '--all',
  // tags would push refs the crew did not name; receive-pack/exec run a program on the remote side
  '--tags',
  '--follow-tags',
  '--receive-pack',
  '--exec',
];

const normRef = (r: string): string =>
  r
    .replace(/^refs\//, '')
    .replace(/^heads\//, '')
    .toLowerCase();

function checkRefspec(env: Env, ref: string): void {
  if (ref === '') deny('git push with empty refspec');
  if (ref.startsWith('+')) deny(`git push with force refspec "${ref}"`);
  if (ref.startsWith(':')) deny(`git push deleting remote ref "${ref}"`);
  const colon = ref.lastIndexOf(':');
  if (colon < 0 && (ref === 'HEAD' || ref === '@')) {
    deny(`git push "${ref}" needs an explicit destination (HEAD:refs/heads/<branch>)`);
  }
  const dest = colon < 0 ? ref : ref.slice(colon + 1);
  if (dest === '' || dest === 'HEAD' || dest === '@' || dest.startsWith('+')) {
    deny(`git push with unclear destination "${ref}"`);
  }
  if (/^refs\/(?!heads\/)/i.test(dest)) deny(`git push to non-branch ref "${dest}"`);
  // git matches a short destination against the remote's refs, `refs/<dest>` first: `studio/claims/<id>`
  // would move the claim ref `refs/studio/claims/<id>`. A short name with a slash is refused, except
  // the item's own branch.
  if (
    !/^refs\/heads\//i.test(dest) &&
    dest.includes('/') &&
    (env.item === undefined || dest.toLowerCase() !== `studio/${env.item}`.toLowerCase())
  ) {
    deny(`git push to "${dest}": name a branch in full (refs/heads/${dest})`);
  }
  const norm = dest
    .replace(/^refs\//, '')
    .replace(/^heads\//, '')
    .toLowerCase();
  if (norm === 'main' || norm === 'master') deny(`git push to protected branch "${norm}"`);
  if (env.allowedRefs.some((r) => normRef(r) === norm)) {
    deny(`git push to workflow ref "${norm}" is not allowed`);
  }
}

function checkPush(env: Env, rawArgs: string[]): void {
  const args = rawArgs.flatMap((a) => braceExpand(a));
  for (const a of args) {
    if (unresolved(a)) deny(`unresolved git push argument: ${a.replaceAll(SUBST, '<runtime>')}`);
    if (hasMagic(a)) deny(`glob in git push argument: ${a}`);
  }
  const pos: string[] = [];
  const repoGiven = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string;
    if (a === '--') {
      pos.push(...args.slice(k + 1));
      break;
    }
    if (a.startsWith('--')) {
      const name = a.split('=')[0] as string;
      // git accepts unambiguous prefixes of long options
      if (name.length >= 3 && PUSH_DANGEROUS.some((d) => d.startsWith(name))) {
        deny(`git push ${name} is not allowed`);
      }
      if (name === '--repo') deny('git push --repo is not allowed: push to origin');
      if (!a.includes('=') && ['--repo', '--push-option'].includes(name)) {
        k++;
      }
    } else if (/^-[A-Za-z]+$/.test(a)) {
      if (/[fd]/.test(a)) deny(`git push ${a} is not allowed`);
      if (a.endsWith('o')) k++;
    } else pos.push(a);
  }
  const refs = repoGiven ? pos : pos.slice(1);
  if (pos.length === 0) deny('git push needs an explicit remote and branch');
  if (pos[0] !== 'origin') deny('git push only to origin');
  if (refs.length === 0) deny('git push needs an explicit refspec');
  for (const ref of refs) checkRefspec(env, ref);
}

const GIT_C_ALLOWED = /^(user\.name|user\.email|commit\.gpgsign|color\.ui|advice\..+)$/i;
const GIT_CONFIG_READ = ['--get', '--get-all', '--get-regexp', '--list', '-l'];
const GIT_CONFIG_WRITE = [
  '--add',
  '--replace-all',
  '--unset',
  '--unset-all',
  '--edit',
  '-e',
  '--rename-section',
  '--remove-section',
  '-f',
  '--file',
  '--blob',
];

function checkGitC(kv: string): void {
  const key = kv.split('=')[0] as string;
  if (unresolvedWord(kv) || /["']/.test(key) || !GIT_C_ALLOWED.test(key)) {
    deny(`git -c ${key} is not allowed`);
  }
}

/**
 * Whether a fetch refspec writes below `refs/remotes/`. The crew clone's `origin/main` must stay
 * what the owner's fetch put there, so such destinations are refused (also with a leading `+`,
 * abbreviated as `remotes/...`, or as a glob that reaches `refs/remotes/`).
 */
function writesRemoteRefs(refspec: string): boolean {
  const colon = refspec.indexOf(':');
  if (colon < 0) return false;
  const dest = refspec.slice(colon + 1).toLowerCase();
  if (dest.startsWith('refs/remotes/') || dest.startsWith('remotes/')) return true;
  const star = dest.indexOf('*');
  if (star < 0) return false;
  const prefix = dest.slice(0, star);
  return 'refs/remotes/'.startsWith(prefix) || 'remotes/'.startsWith(prefix);
}

// Options a crew may give `git fetch` and `git pull`, each a whole word. Anything else is refused:
// fetch options are a grammar of their own (`--upload-pack`, `-u` as `--update-head-ok`, groups),
// so they are listed, not parsed.
const FETCH_FLAGS = new Set([
  '-q',
  '--quiet',
  '-v',
  '--verbose',
  '-p',
  '--prune',
  '-t',
  '--tags',
  '--no-tags',
  '--dry-run',
  '--unshallow',
  '--progress',
  '--no-progress',
]);
const PULL_FLAGS = new Set([
  ...FETCH_FLAGS,
  '-r',
  '--rebase',
  '--rebase=true',
  '--rebase=false',
  '--rebase=merges',
  '--no-rebase',
  '--ff',
  '--no-ff',
  '--ff-only',
  '--autostash',
  '--no-autostash',
  '--no-edit',
  '--stat',
  '--no-stat',
]);
const COUNT_FLAG = /^--(depth|deepen)=[1-9]\d{0,6}$/;
// A merge strategy option such as `ours`, `theirs` or `subtree=<path>`: plain words only.
const STRATEGY_OPTION = /^[A-Za-z][A-Za-z0-9-]*(=[A-Za-z0-9._/-]+)?$/;

/**
 * `git fetch` and `git pull` for a crew: listed options only, the remote is `origin` (or left out),
 * and no refspec writes below `refs/remotes/`, so `origin/*` stays what the owner's fetch put there.
 */
function checkFetchPull(sub: 'fetch' | 'pull', rawArgs: string[]): void {
  const args = rawArgs.flatMap((a) => braceExpand(a));
  const pos: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string;
    if (unresolvedWord(a))
      deny(`unresolved git ${sub} argument: ${a.replaceAll(SUBST, '<runtime>')}`);
    if (!a.startsWith('-')) {
      pos.push(a);
      continue;
    }
    if ((sub === 'fetch' ? FETCH_FLAGS : PULL_FLAGS).has(a) || COUNT_FLAG.test(a)) continue;
    if (sub === 'pull') {
      // -X<option>, -X <option>, --strategy-option=<option>, --strategy-option <option>
      let opt: string | undefined;
      if (a === '-X' || a === '--strategy-option') opt = args[++k] ?? '';
      else if (a.startsWith('--strategy-option=')) opt = a.slice(18);
      else if (a.startsWith('-X')) opt = a.slice(2);
      if (opt !== undefined) {
        if (!STRATEGY_OPTION.test(opt)) deny(`git pull strategy option "${opt}" is not allowed`);
        continue;
      }
    }
    deny(`git ${sub} ${a.split('=')[0]} is not allowed`);
  }
  if (pos.length > 0 && pos[0] !== 'origin') {
    deny(`git ${sub} only from origin, not "${pos[0]}"`);
  }
  for (const ref of pos.slice(1)) {
    // A plain ref or src:dst of plain refs: no URL, no `..`, no empty or rooted side.
    const sides = ref.replace(/^\+/, '').split(':');
    if (
      sides.length > 2 ||
      sides.some(
        (x) =>
          !/^[A-Za-z0-9._/-]+$/.test(x) ||
          x.startsWith('/') ||
          x.includes('//') ||
          x.split('/').includes('..'),
      )
    ) {
      deny(`git ${sub} refspec "${ref}" is not a plain ref`);
    }
    if (writesRemoteRefs(ref.replace(/^\+/, ''))) {
      deny(`git ${sub} into refs/remotes/ is not allowed (origin/* is set by the owner)`);
    }
  }
}

/** `git ls-remote origin [<ref>...]`: no options, no other remote. */
function checkLsRemote(rawArgs: string[]): void {
  const args = rawArgs.flatMap((a) => braceExpand(a));
  if (args.some((a) => unresolvedWord(a) || a.startsWith('-'))) {
    deny('git ls-remote takes no options: git ls-remote origin [<ref>...]');
  }
  if (args[0] !== 'origin') deny('git ls-remote only for origin: git ls-remote origin [<ref>...]');
}

/** Read-only `git remote`: list, `-v`, `get-url origin`, `show [-n] origin`. */
function checkRemote(args: string[]): void {
  const form = args.join(' ');
  if (['', '-v', '--verbose', 'get-url origin', 'show origin', 'show -n origin'].includes(form)) {
    return;
  }
  deny('git remote is read-only for crews: git remote -v, get-url origin, show [-n] origin');
}

// Network git runs from the clone root: another directory could hold a repository of its own.
const GIT_NETWORK = new Set(['fetch', 'pull', 'ls-remote', 'push']);

function checkGit(env: Env, args: string[], state: State): void {
  // Global options are an allowlist: an unknown one could take the next word as its value and hide
  // the subcommand, or change what git runs (`--exec-path`, `--attr-source`, `--config-env`).
  let i = 0;
  let moved = false;
  while (i < args.length) {
    const a = args[i] as string;
    if (unresolvedWord(a)) deny('unresolved git option');
    if (!a.startsWith('-')) break;
    if (a === '-C') {
      const v = args[i + 1];
      if (v === undefined) deny('missing value for git -C');
      checkInsideDir(env, v as string, state, 'git -C');
      moved = true;
      i += 2;
    } else if (a.startsWith('--git-dir=') || a.startsWith('--work-tree=')) {
      checkInsideDir(env, a.slice(a.indexOf('=') + 1), state, 'git option');
      moved = true;
      i++;
    } else if (a === '-c') {
      checkGitC(args[i + 1] ?? '');
      i += 2;
    } else if (a === '--no-pager' || a === '-P' || a === '--no-replace-objects') {
      i++;
    } else {
      deny(
        `git option ${a.split('=')[0]} is not allowed (-C, -c, --git-dir=, --work-tree=, --no-pager, -P, --no-replace-objects)`,
      );
    }
  }
  const sub = args[i];
  if (sub === undefined) return;
  if (unresolvedWord(sub)) deny('unresolved command word (git subcommand)');
  const rest = args.slice(i + 1);
  if (GIT_NETWORK.has(sub) && (moved || state.cwd !== env.wt)) {
    deny(`git ${sub} runs from the clone root only, without -C, --git-dir or --work-tree`);
  }
  if (sub === 'init') deny('git init is not allowed (no repository inside the clone)');
  if (sub === 'push') {
    if (env.noPush) deny('a research item pushes nothing: report the result in the report body');
    checkPush(env, rest);
  } else if (sub === 'fetch' || sub === 'pull') checkFetchPull(sub, rest);
  else if (sub === 'ls-remote') checkLsRemote(rest);
  else if (sub === 'remote') checkRemote(rest);
  else if (sub === 'submodule') {
    // update, add and sync fetch from URLs a pull request can write into .gitmodules
    const all = rest.flatMap((x) => braceExpand(x));
    if (!(all.length === 0 || (all.length === 1 && all[0] === 'status'))) {
      deny('git submodule is allowed only as git submodule status');
    }
  } else if (sub === 'archive') {
    const all = rest.flatMap((x) => braceExpand(x));
    if (
      all.some((a) => {
        const name = a.split('=')[0] as string;
        return (
          (name.length >= 3 && '--remote'.startsWith(name)) ||
          (name.length >= 3 && '--exec'.startsWith(name)) ||
          (name.length >= 3 && '--output'.startsWith(name)) ||
          /^-[A-Za-z]*o/.test(a)
        );
      })
    ) {
      deny('git archive --remote, --exec and --output are not allowed (it writes to stdout)');
    }
  } else if (
    // A crew has its clone: cloning or fetching packs reaches any URL with any options.
    sub === 'clone' ||
    sub === 'fetch-pack' ||
    sub === 'upload-pack' ||
    sub === 'upload-archive' ||
    sub === 'send-pack' ||
    sub === 'http-push' ||
    sub === 'subtree' ||
    sub === 'update-ref' ||
    sub === 'replace' ||
    sub === 'symbolic-ref'
  ) {
    // update-ref, replace and symbolic-ref rewrite refs or objects that origin/main is read from
    deny(`git ${sub} is not allowed`);
  } else if (sub === 'config') {
    // allowlist: reads only
    const all = rest.flatMap((x) => braceExpand(x));
    if (
      all.some(unresolvedWord) ||
      !all.some((a) => GIT_CONFIG_READ.includes(a)) ||
      all.some((a) => GIT_CONFIG_WRITE.includes(a) || a.startsWith('--file='))
    ) {
      deny('git config is allowed for reads only (--get, --get-all, --get-regexp, --list)');
    }
  }
}

function checkInsideDir(env: Env, dir: string, state: State, why: string): void {
  if (dir.includes(SUBST) || dir.includes('$') || dir.startsWith('~')) {
    deny(`unresolvable path in ${why}`);
  }
  if (state.cwd === null && !isAbsolute(dir)) deny(`relative path after unresolvable cd in ${why}`);
  if (!isInside(env, resolveReal(dir, state.cwd ?? env.wt)))
    deny(`${why} outside worktree: ${dir}`);
}

const PR_CREATE_OPTIONS = ['--head', '--base', '--title', '--body-file'];

/**
 * `gh pr create` from a crew has one form: `gh pr create --head studio/<id> --base <branch>
 * --title <text> --body-file <file>`, each option once, in any order, nothing else. The body file
 * is a relative path whose real path lies inside the clone. gh's own flag grammar (short groups,
 * `=`, aliases) is never parsed: anything but this form is refused.
 */
function checkPrCreate(env: Env, args: string[], cwd: string | null): void {
  const FORM = 'gh pr create --head studio/<id> --base <branch> --title <text> --body-file <file>';
  if (env.item === undefined) deny('gh pr create needs the item in the guard context');
  if (args[0] !== 'pr' || args[1] !== 'create' || args.length !== 10) deny(`use exactly: ${FORM}`);
  const got = new Map<string, string>();
  for (let k = 2; k < args.length; k += 2) {
    const flag = args[k] as string;
    const value = args[k + 1] as string;
    if (!PR_CREATE_OPTIONS.includes(flag) || got.has(flag)) deny(`use exactly: ${FORM}`);
    if (value.startsWith('-')) deny(`gh pr create ${flag} value may not start with "-"`);
    got.set(flag, value);
  }
  const own = `studio/${env.item}`;
  if (got.get('--head') !== own) deny(`gh pr create needs --head ${own} (the item's own branch)`);
  const base = got.get('--base') as string;
  if (env.base === undefined || base !== env.base) {
    deny(`gh pr create needs --base ${env.base ?? '<the item base>'} (the item's base branch)`);
  }
  const file = got.get('--body-file') as string;
  if (
    unresolvedWord(file) ||
    !/^[A-Za-z0-9._ /-]+$/.test(file) ||
    isAbsolute(file) ||
    file.split('/').includes('..')
  ) {
    deny('gh pr create --body-file needs a plain relative path inside the clone');
  }
  if (cwd !== env.wt) deny('gh pr create runs from the clone root only');
  if (!isInside(env, resolveReal(file, cwd as string))) {
    deny(`gh pr create --body-file outside the clone: ${file}`);
  }
}

// The gh a crew may run: these reads of pull requests, the one `gh pr create` form and, when the
// owner lists workflows, `gh workflow run <workflow> --ref <ref>`. Nothing else.
const JSON_FIELDS = /^[A-Za-z]+(,[A-Za-z]+)*$/;
const JQ = /^[^-]/;
const COUNT = /^[1-9]\d{0,3}$/;
const REF_NAME = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;
type ReadSpec = { number: boolean; flags: string[]; values: Record<string, RegExp> };
// What each read may take, flag by flag, each its own word: no clusters, no `=`, no -R, no --web.
const GH_PR_READ: Record<string, ReadSpec> = {
  view: { number: true, flags: [], values: { '--json': JSON_FIELDS, '--jq': JQ } },
  checks: {
    number: true,
    flags: ['--watch', '--required', '--fail-fast'],
    values: { '--json': JSON_FIELDS, '--jq': JQ, '--interval': COUNT },
  },
  diff: { number: true, flags: ['--name-only', '--patch'], values: {} },
  list: {
    number: false,
    flags: [],
    values: {
      '--json': JSON_FIELDS,
      '--jq': JQ,
      '--state': /^(open|closed|merged|all)$/,
      '--limit': COUNT,
      '--head': REF_NAME,
      '--base': REF_NAME,
    },
  },
  status: { number: false, flags: [], values: { '--json': JSON_FIELDS, '--jq': JQ } },
};

/** A read of a pull request with only the flags its spec lists; anything else is refused. */
function checkPrRead(sub: string, spec: ReadSpec, rest: string[]): void {
  let numbers = 0;
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k] as string;
    if (spec.flags.includes(a)) continue;
    const valid = spec.values[a];
    if (valid !== undefined) {
      const v = rest[++k];
      if (v === undefined || unresolvedWord(v) || !valid.test(v)) {
        deny(`gh pr ${sub} ${a} needs a plain value`);
      }
      continue;
    }
    if (spec.number && /^[1-9]\d{0,9}$/.test(a) && numbers++ === 0) continue;
    deny(`gh pr ${sub} does not take ${a.startsWith('-') ? a.split('=')[0] : 'that argument'}`);
  }
}

function checkGh(env: Env, args: string[], cwd: string | null): void {
  const [g0, g1] = args;
  for (const w of [g0, g1]) {
    if (w !== undefined && unresolvedWord(w)) deny('unresolved command word (gh subcommand)');
  }
  // No other repository or host, anywhere in the command.
  if (
    args.some(
      (a) =>
        /^-R/.test(a) ||
        a === '--repo' ||
        a.startsWith('--repo=') ||
        a === '--hostname' ||
        a.startsWith('--hostname='),
    )
  ) {
    deny('gh -R, --repo and --hostname are not allowed: crews work on their own repository');
  }
  if (g0 === 'pr' && g1 !== undefined && Object.hasOwn(GH_PR_READ, g1)) {
    checkPrRead(g1, GH_PR_READ[g1] as ReadSpec, args.slice(2));
    return;
  }
  if (g0 === 'pr' && g1 === 'create') {
    checkPrCreate(env, args, cwd);
    return;
  }
  if (g0 === 'workflow' && g1 === 'run' && env.allowedWorkflows.length > 0) {
    const [, , target, flag, ref, ...more] = args;
    if (
      flag !== '--ref' ||
      more.length > 0 ||
      target === undefined ||
      ref === undefined ||
      !env.allowedWorkflows.includes(target) ||
      !env.allowedRefs.includes(ref)
    ) {
      deny(
        'use exactly: gh workflow run <crew_allowed_workflows entry> --ref <crew_allowed_workflow_refs entry>',
      );
    }
    return;
  }
  deny(
    `gh ${[g0, g1].filter((x) => x !== undefined).join(' ')} is not allowed for crews (gh pr view, checks, diff, list, status and gh pr create)`,
  );
}

function checkFind(env: Env, args: string[], state: State): void {
  const roots: string[] = [];
  let k = 0;
  while (k < args.length && /^-[HLP]$/.test(args[k] as string)) k++;
  for (; k < args.length; k++) {
    const a = args[k] as string;
    if (a.startsWith('-') || a === '(' || a === '!') break;
    roots.push(a);
  }
  const exprs = args.slice(k);
  const execAt = exprs.findIndex((a) => ['-exec', '-execdir', '-ok', '-okdir'].includes(a));
  const writes = exprs.some((a) =>
    ['-delete', '-fprint', '-fprintf', '-fls', '-fprint0'].includes(a),
  );
  if (!writes && execAt < 0) return;
  for (const r of roots.length > 0 ? roots : ['.']) checkWritePath(env, r, state.cwd, 'find');
  for (const [idx, a] of exprs.entries()) {
    if (['-fprint', '-fprintf', '-fls', '-fprint0'].includes(a) && exprs[idx + 1]) {
      checkWritePath(env, exprs[idx + 1] as string, state.cwd, 'find output');
    }
  }
  if (execAt >= 0) {
    const cmd: string[] = [];
    for (const a of exprs.slice(execAt + 1)) {
      if (a === ';' || a === '+') break;
      cmd.push(a === '{}' ? (roots[0] ?? '.') : a);
    }
    checkWords(env, cmd, state);
  }
}

function checkSegment(env: Env, seg: Segment, state: State): void {
  const base = state.cwd ?? env.wt;
  for (const w of seg.writes) checkWritePath(env, w, state.cwd, 'redirection');
  for (const r of seg.reads) checkSecretToken(env, r, base);
  for (const w of seg.writes) checkSecretToken(env, w, base);
  checkWords(env, seg.words, state);
}

const VAR_BUILTINS = new Set([
  'read',
  'declare',
  'typeset',
  'local',
  'export',
  'readonly',
  'unset',
]);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);

/** export/declare/read/...: no options at all; names must be literal and not sensitive. */
function checkVarBuiltin(name: string, args: string[]): void {
  if (name === 'printf') {
    if (args.some((a) => /^-[A-Za-z]*v/.test(a))) deny('printf -v is not allowed');
    return;
  }
  for (const a of args) {
    if (/^[-+]/.test(a)) deny(`${name} with options is not allowed`);
    if (unresolved(a)) deny(`unresolved word in ${name}`);
    const vn = a.split('=')[0] as string;
    if (!VAR_NAME.test(vn)) deny(`${vn} is not a plain variable name`);
    checkVarName(vn);
  }
}

// A crew has no use for the studio CLI (its skill uses no studio command), and the owner's commands
// must stay the owner's. The CLI refuses those without a terminal; this is a second net, and a file
// a crew writes or copies itself can still get past it: the sandbox is the boundary.
const CREW_NO_STUDIO = 'a crew may not run studio';
const NODE_NAME = /^node(js)?[0-9.]*$/i;
/** `bin/studio` or `dist-bundle/studio.mjs`; case-insensitive because file systems can be. */
const isStudioBinary = (w: string): boolean => /^studio(\.(mjs|cjs|js))?$/i.test(basename(w));

const NODE_ALTERNATIVE = 'use node <relative script> or node --test <relative paths or patterns>';

const STUDIO_NAMES = ['studio', 'studio.mjs', 'studio.cjs', 'studio.js'];

/** One path for node: literal and relative with no `..`, or a plain pattern; never the studio binary. */
function checkNodePath(path: string): void {
  if (
    unresolved(path) ||
    path.startsWith('~') ||
    isAbsolute(path) ||
    path.split('/').includes('..')
  ) {
    deny(`node with a path that is not literal and relative is not allowed; ${NODE_ALTERNATIVE}`);
  }
  if (!hasMagic(path) && !path.includes('{')) {
    if (isStudioBinary(path)) deny(CREW_NO_STUDIO);
    return;
  }
  const plain = plainGlob(path);
  if ('why' in plain) deny(`node --test: ${plain.why}: ${path}; ${NODE_ALTERNATIVE}`);
  // A pattern that could name the studio binary is refused whether or not it matches now. A shell may
  // let `.*` or `.?` match `..`, so a segment starting with a dot takes no wildcard.
  for (const e of (plain as { expansions: string[] }).expansions) {
    if (e.split('/').some((s) => s.startsWith('.') && /[*?]/.test(s))) {
      deny(
        `node --test: a segment starting with a dot takes no wildcard: ${path}; ${NODE_ALTERNATIVE}`,
      );
    }
    const last = fileGlobToRegExp(e.slice(e.lastIndexOf('/') + 1));
    if (STUDIO_NAMES.some((n) => last.test(n))) deny(CREW_NO_STUDIO);
  }
}

/**
 * Running node directly is denied except `node --version`, `node --help`, `node --test`,
 * `node --test <paths>` and `node <path>`. A script path is the first argument (no option before
 * it), literal, relative, without a `..` segment and not the studio binary; words after it are the
 * script's arguments and stay free. After `--test` every word is such a path or a plain pattern
 * (see `plainGlob`), with no option among them.
 */
function checkNode(args: string[]): void {
  const first = args[0] ?? '-';
  if (args.length === 1 && (first === '--version' || first === '--help' || first === '--test')) {
    return;
  }
  if (first === '--test') {
    const paths = args.slice(1);
    if (paths.some((p) => p.startsWith('-'))) {
      deny(`node --test takes only paths here, no options; ${NODE_ALTERNATIVE}`);
    }
    for (const p of paths) checkNodePath(p);
    return;
  }
  if (first.startsWith('-') || first.startsWith('~')) {
    deny(`node without a literal relative script path is not allowed; ${NODE_ALTERNATIVE}`);
  }
  checkNodePath(first);
  if (hasMagic(first) || first.includes('{')) {
    deny(`node runs one literal script path; ${NODE_ALTERNATIVE}`);
  }
}

/** Options of npm, pnpm, yarn and bun that take the next word as a value; skipped to find the command. */
const PACKAGE_VALUE_OPTIONS = new Set([
  '--filter',
  '-F',
  '--dir',
  '-C',
  '--prefix',
  '--workspace',
  '-w',
  '--cwd',
  '--registry',
  '--config',
]);
const PACKAGE_RUN_INSTEAD =
  'run an installed tool with "pnpm exec <tool>" or a package.json script';

/**
 * A short denylist, not an allowlist: the guard does not contain a malicious crew (package.json scripts
 * run anything), the sandbox does. Denied are what fetches and runs foreign code (`npx`, `pnpx`, `bunx`,
 * `corepack`, `dlx`, `bun x`, `create`, `init`) and the options that run a shell string (`--shell*`,
 * `--script-shell`). The command is the first word that is not an option or an option's value.
 */
function checkPackageRunner(name: string, args: string[]): void {
  if (name === 'npx' || name === 'pnpx' || name === 'bunx' || name === 'corepack') {
    deny(`${name} downloads and runs foreign code and is not allowed; ${PACKAGE_RUN_INSTEAD}`);
  }
  if (name !== 'npm' && name !== 'pnpm' && name !== 'yarn' && name !== 'bun') return;
  if (args.some((a) => a.startsWith('--shell') || a.startsWith('--script-shell'))) {
    deny(
      `${name} with a shell option is not allowed; run it without --shell-mode and --script-shell`,
    );
  }
  let cmd: string | undefined;
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string;
    if (a === '--') break;
    if (a.startsWith('-')) {
      if (PACKAGE_VALUE_OPTIONS.has(a)) k++;
      continue;
    }
    cmd = a;
    break;
  }
  if (cmd === undefined) return;
  if (unresolvedWord(cmd))
    deny(`${name} with a command that is not literal is not allowed; name the command`);
  if (cmd === 'create' || cmd === 'init') {
    deny(`${name} ${cmd} fetches a template and is not allowed; create the files by hand`);
  }
  if (
    cmd === 'dlx' ||
    (name === 'bun' && cmd === 'x') ||
    (name === 'npm' && (cmd === 'x' || cmd === 'exec'))
  ) {
    deny(
      `${name} ${cmd} downloads and runs foreign code and is not allowed; ${PACKAGE_RUN_INSTEAD}`,
    );
  }
}

function checkWords(env: Env, words: string[], state: State): void {
  if (words.length === 0) return;
  const base = state.cwd ?? env.wt;
  for (const w of words) checkSecretToken(env, w, base);
  const at = skipWrappers(words, state);
  const cmdWord = words[at];
  if (cmdWord === undefined) return;
  checkCommandGlobs(env, words.slice(at), words);
  if (unresolvedWord(cmdWord)) deny('unresolved command word');
  if (cmdWord !== '{' && cmdWord.includes('{')) deny('brace expansion in command position');
  const name = basename(cmdWord);
  const args = words.slice(at + 1);
  if (env.artifacts !== undefined || env.blockedCommands.size > 0) {
    checkResearchCommand(env, name);
  }

  if (name === 'sudo' || name === 'su' || name === 'doas') {
    deny(`privilege escalation (${name}) is not allowed`);
  }
  if (VAR_BUILTINS.has(name) || name === 'printf') {
    checkVarBuiltin(name, args);
    return;
  }
  if (name === 'popd') {
    state.cwd = null;
    return;
  }
  if (name === 'cd' || name === 'pushd') {
    const target = args.find((a) => !a.startsWith('-') || a === '-');
    const relative = target !== undefined && !isAbsolute(target);
    if (
      target === undefined ||
      target === '-' ||
      unresolved(target) ||
      target.startsWith('~') ||
      (relative && state.cwd === null)
    ) {
      state.cwd = null;
    } else {
      state.cwd = resolveReal(target, state.cwd ?? env.wt);
    }
    return;
  }
  if (SHELLS.has(name)) {
    if (args.some((a) => /^-[A-Za-z]*[cs]/.test(a) || a.startsWith('--command'))) {
      deny(`${name} with a command string or stdin script is not allowed`);
    }
    if (positionals(args).length === 0 || args.includes('-')) {
      deny(`${name} reading its script from stdin is not allowed`);
    }
    if (positionals(args).some(isStudioBinary)) deny(CREW_NO_STUDIO);
  }
  if (isStudioBinary(name)) deny(CREW_NO_STUDIO);
  if (NODE_NAME.test(name)) checkNode(args);
  checkPackageRunner(name, args);
  // `for NAME in ...`, `select NAME in ...` and `(( NAME = 1 ))` set NAME without an assignment word.
  if (name === 'for' || name === 'select') checkVarName(args[0] ?? '');
  checkVarName(/^[A-Za-z_][A-Za-z0-9_]*/.exec(name)?.[0] ?? '');
  if (name === 'find') checkFind(env, args, state);
  if (name === 'git' || name === 'gh') {
    if (words.some((w) => w.includes(SUBST))) deny(`command substitution in a ${name} command`);
  }
  if (name === 'git') checkGit(env, args, state);
  if (name === 'gh') checkGh(env, args, state.cwd);
  for (const t of writeTargets(name, args)) checkWritePath(env, t, state.cwd, name);
}

const ARITHMETIC_DENIED =
  'arithmetic ((...)) is not allowed; use test or [ ] for comparisons, or a script';

function checkBash(env: Env, cmd: string, cwd: string | null, depth: number): void {
  if (depth > 8) deny('command nesting too deep');
  // `$[` and `${VAR:=x}` can assign without an assignment word; deny them outright. `((` and `$((` are
  // checked on the unquoted text only (below), so they may appear inside quoted words.
  if (/\$\[|\$\{[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?:?=/.test(cmd)) {
    deny('arithmetic and parameter-expansion assignment are not allowed');
  }
  const { lines, subs } = scan(cmd);
  for (const sub of subs) {
    // scan() turns `$((` into a substitution whose text starts with `(`.
    if (sub.startsWith('(')) deny(ARITHMETIC_DENIED);
    checkBash(env, sub, cwd, depth + 1);
  }
  const state: State = { cwd };
  for (const line of lines) {
    for (const seg of toSegments(line)) checkSegment(env, seg, state);
  }
}

// ---------------------------------------------------------------- research (REA)

/**
 * A researcher's shell never touches the analysis directory: the sandbox denies reads of it to every
 * Bash process (`denyRead`), and the REA tools, which run in the MCP server outside that sandbox,
 * are its only way in. Parsing shell syntax to protect a place is a losing game, so this is only the
 * early, friendly refusal: a command whose text names the directory, or that runs in it.
 */
function refuseArtifactsInBash(env: Env, command: string, cwd: string): void {
  const artifacts = env.artifacts;
  if (artifacts === undefined) return;
  if (isUnder([artifacts], cwd)) deny('a researcher works outside the analysis directory');
  const raw = env.artifactsGiven ?? artifacts;
  if (command.includes(artifacts) || command.includes(raw)) {
    deny(
      'the analysis directory is reachable through the REA tools only (search_strings, inspect_artifact, ...), not from a shell',
    );
  }
}

/** Without the class an item names, no debugger, device or capture tool in the shell either. */
function checkResearchCommand(env: Env, name: string): void {
  if (
    env.blockedCommands.has(name) ||
    env.blockedCommands.has(name.replace(/[-_.]?v?\d+([.-]\d+)*$/, ''))
  ) {
    deny(
      `${name} starts or watches a program or device: the owner has not opened that class for this item (studio research allow)`,
    );
  }
}

/**
 * An argument that asks a tool to write somewhere, judged by the words of its name: refused for
 * every tool, whatever it is. `snapshot`, `save` and `overwrite` anywhere in the name; `output`,
 * `dest`, `destination`, `export` and `write` only for a name that ends in a place (`output_directory`,
 * `export_path`) or is that word alone. So `left_export_name`, `rewrite_level` or
 * `destination_scope` are not write arguments, and neither is a limit (`max_output_bytes`).
 */
const WRITE_ALWAYS = new Set(['snapshot', 'snapshots', 'save', 'overwrite']);
const WRITE_VERB = new Set(['output', 'outputs', 'dest', 'destination', 'export', 'write']);
const WRITE_PLACE = new Set(['path', 'paths', 'dir', 'directory', 'file', 'files', 'folder', 'to']);
export function isWriteKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== '');
  // A limit (`max_output_files`) bounds what a tool returns; it names no place to write.
  if (['max', 'min', 'limit'].includes(words[0] ?? '')) return false;
  if (words.some((w) => WRITE_ALWAYS.has(w))) return true;
  const last = words.at(-1) ?? '';
  return words.some((w) => WRITE_VERB.has(w)) && (WRITE_PLACE.has(last) || WRITE_VERB.has(last));
}
/** A name that names a place on disk, as scripts/gen-rea-schemas.mjs classifies top-level ones. */
const PLACE_LAST = new Set(['path', 'paths', 'root', 'roots', 'directory', 'executable', 'tty']);
const PLACE_ANY = new Set(['file', 'files', 'dir']);
export function isPlaceKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== '');
  return PLACE_LAST.has(words.at(-1) ?? '') || words.some((w) => PLACE_ANY.has(w));
}
const MCP_LIMITS = { depth: 6, values: 500 };
const looksLikePath = (v: string): boolean =>
  /[\\/]/.test(v) ||
  /^[A-Za-z]:/.test(v) ||
  v.startsWith('~') ||
  v === '.' ||
  v === '..' ||
  /^file:/i.test(v);

/**
 * The input of an allowed REA tool. Only the argument names its schema lists are accepted. Every
 * string under an argument the schema declares as a path, and every string that looks like a place
 * (a slash or backslash, a drive letter, `~`, `.` or `..`, `file:`) under any other, must be
 * absolute and resolve, through links, into the analysis directory. Never the clone: the crew writes
 * there and could swap a link between this check and the server's read, and a relative path would
 * resolve against another directory in the server than here. The analysis directory is not
 * writable by the crew (sandbox `denyWrite`), so its links stay as they were checked. The one
 * exception is the free-text arguments the schema names, at the top level of that tool only. A
 * write argument (isWriteKey) is refused unless it is undefined, null, false or an empty string;
 * a limit (`max_*`, `min_*`, `limit_*`) is no write argument, so its number passes.
 */
function checkMcp(env: Env, tool: string, input: Record<string, unknown>, cwd: string): void {
  const artifacts = env.artifacts;
  if (artifacts === undefined) deny(`${tool}: no analysis directory is configured`);
  const schema = env.mcpKeys.get(tool);
  if (schema === undefined) deny(`${tool}: no input schema is known for this tool`);
  const known = schema as { keys: Set<string>; paths: Set<string>; text: Set<string> };
  for (const k of Object.keys(input)) {
    if (!known.keys.has(k)) deny(`${tool}: unknown argument ${k.slice(0, 40)}`);
  }
  let seen = 0;
  const confine = (v: string, key: string): void => {
    if (/\p{Cc}/u.test(v)) deny(`${tool}: control character in ${key}`);
    if (/^file:/i.test(v) || v.startsWith('~')) deny(`${tool}: ${key} must be a plain path`);
    if (/\\/.test(v) || /^[A-Za-z]:/.test(v))
      deny(`${tool}: ${key}: Windows paths are not supported`);
    if (v.split('/').includes('..')) deny(`${tool}: write ${key} without ..`);
    if (!isAbsolute(v)) deny(`${tool}: ${key} must be an absolute path in the analysis directory`);
    // Both as written and on its real path: a path through a link elsewhere (in the clone, which
    // the crew can change after this check) is refused even when it leads in today.
    const given = [
      artifacts as string,
      ...(env.artifactsGiven === undefined ? [] : [normalize(env.artifactsGiven)]),
    ];
    if (!isUnder(given, normalize(v)) || !isUnder([artifacts as string], resolveReal(v, cwd))) {
      deny(`${tool}: ${key} is outside the analysis directory`);
    }
  };
  const walk = (v: unknown, key: string, top: string, depth: number): void => {
    if (++seen > MCP_LIMITS.values || depth > MCP_LIMITS.depth) {
      deny(`${tool}: input too large to check`);
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, key, top, depth + 1);
      return;
    }
    if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, k, top, depth + 1);
      return;
    }
    if (isWriteKey(key) && v !== undefined && v !== null && v !== false && v !== '') {
      deny(`${tool}: ${key} asks the tool to write; a researcher's tools only read`);
    }
    if (typeof v !== 'string' || v === '') return;
    if (known.paths.has(top)) {
      confine(v, key);
      return;
    }
    // A nested argument named like a place (`left.subject.local_path`, `reference.entries[].path`,
    // `manifest.root`) is one, whatever its value looks like: REA resolves a bare name against its
    // own working directory or a root of its own, never against what the guard sees.
    if (depth > 1 && isPlaceKey(key)) {
      confine(v, key);
      return;
    }
    if (depth === 1 && known.text.has(key)) {
      if (/\p{Cc}/u.test(v)) deny(`${tool}: control character in ${key}`);
      return;
    }
    if (/\p{Cc}/u.test(v)) deny(`${tool}: control character in ${key}`);
    if (looksLikePath(v)) confine(v, key);
  };
  for (const [k, v] of Object.entries(input)) walk(v, k, k, 1);
  // A recorded crash is static, but its debugger context attaches a debugger.
  if (
    tool.endsWith('__inspect_recorded_crash') &&
    input.include_debugger_context !== undefined &&
    input.include_debugger_context !== false &&
    input.include_debugger_context !== null &&
    !env.reaClasses.has('debug')
  ) {
    deny(`${tool}: include_debugger_context needs the debug class (studio research allow)`);
  }
  if (tool.endsWith('__inspect_sqlite_database')) {
    for (const k of ['table', 'columns', 'row_limit']) {
      if (input[k] !== undefined) deny(`${tool}: rows are content; ask for the schema (no ${k})`);
    }
    if (input.schema_scope === 'selected_table') {
      deny(`${tool}: schema_scope selected_table samples rows; use inventory or database`);
    }
  }
}

// ---------------------------------------------------------------- tools

const WRITE_TOOLS: Record<string, string> = {
  Edit: 'file_path',
  Write: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};
/**
 * Tools a crew session may call at all. Everything else (WebFetch, WebSearch, every `mcp__*` tool,
 * tools added by later Claude Code versions) is denied: an allowlist fails closed on new tools.
 */
const CREW_TOOLS = new Set([
  'Bash',
  'Read',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Grep',
  'Glob',
  'Skill',
  'TodoWrite',
  'Task',
  'Agent',
]);
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'NotebookRead']);
const SECRET_FRAGMENT = /\.env|\.pem|\.key|id_rsa|id_ed25519|\.npmrc|\.netrc|credentials/i;
const SECRET_SAMPLES = [
  '.env',
  '.env.local',
  'a.pem',
  'a.key',
  'id_rsa',
  'id_ed25519',
  '.npmrc',
  '.netrc',
  'credentials',
  'credentials.json',
];

/** Denies a directory tree that contains a secret file (no silent exclusion). */
function scanDirForSecrets(env: Env, dir: string): void {
  const stack = [dir];
  let count = 0;
  while (stack.length > 0) {
    const d = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++count > GUARD_LIMITS.walk) deny('too many paths to check');
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== '.git') stack.push(full);
      } else if (isSecretString(env, full)) {
        deny(`search over a directory that contains a secret file: ${e.name}`);
      }
    }
  }
}

/** The one rule for read tools: the worktree and the listed roots, on the real path; nothing else. */
function checkReadScope(env: Env, tok: string, base: string, tool: string): void {
  // A tool may trim or expand these where this check would not: refuse rather than guess.
  if (tok.startsWith('~') || /^\s|\s$|\p{Cc}/u.test(tok)) {
    deny(`${tool}: unresolvable path: ${JSON.stringify(tok)}`);
  }
  refuseDotDot(tok, tool);
  // Without `..` a tool and this check reach the same file, so the real path decides.
  const real = resolveReal(tok, base);
  if (!isUnder(env.readRoots, real) && !isClaudeFile(env, real)) {
    deny(`${tool} outside this crew's files: ${tok}`);
  }
}

/**
 * A tool may drop `..` before it follows a link or after, and the two can name different files. No
 * set of checks covers every mix of links and `..`, so read tools do not take it at all.
 */
function refuseDotDot(tok: string, tool: string): void {
  if (tok.split('/').includes('..')) deny(`${tool}: write the path without ..: ${tok}`);
}

/** Braces that close in order and do not nest. */
function flatBraces(pattern: string): boolean {
  let open = false;
  for (const c of pattern) {
    if (c === '{') {
      if (open) return false;
      open = true;
    } else if (c === '}') {
      if (!open) return false;
      open = false;
    }
  }
  return !open;
}

/**
 * Deliberately an allowlist, not a model of glob syntax: only these characters and flat braces, and
 * nothing that is or could match `..`. A glob stays in scope when the part before its first wildcard
 * does.
 */
/**
 * The plain-pattern allowlist, shared by the Glob tool and `node --test`: the brace expansions of
 * `pattern`, or why it is refused.
 */
function plainGlob(pattern: string): { expansions: string[] } | { why: string } {
  if (!/^[\p{L}\p{N}_\-./*?,{}]+$/u.test(pattern))
    return { why: 'only plain patterns are allowed' };
  if (!flatBraces(pattern)) return { why: 'braces must close and must not nest' };
  if (pattern.includes('..')) return { why: 'write the pattern without ..' };
  const expansions = braceExpand(pattern);
  for (const e of expansions) {
    if (e.includes('{') || e.includes('}')) return { why: 'a brace group needs a comma' };
    if (e.includes('..') || e.split('/').some((s) => /^[.?]{2}$/.test(s))) {
      return { why: 'write the pattern without ..' };
    }
  }
  return { expansions };
}

function checkGlobScope(env: Env, pattern: string, base: string, tool: string): void {
  const plain = plainGlob(pattern);
  if ('why' in plain) {
    deny(`${tool}: ${plain.why}: ${pattern}; use a narrower pattern, or Bash in the sandbox`);
  }
  for (const e of (plain as { expansions: string[] }).expansions) {
    const segs = e.split('/');
    const first = segs.findIndex((s) => hasMagic(s));
    const prefix = first < 0 ? e : segs.slice(0, first).join('/') || (isAbsolute(e) ? '/' : '.');
    checkReadScope(env, prefix, base, tool);
  }
}

function checkSearch(env: Env, path: unknown, globs: unknown[], cwd: string): void {
  const given = typeof path === 'string' && path !== '' ? path : undefined;
  if (given !== undefined) checkSecretPath(env, given, cwd);
  const base = given !== undefined ? resolveReal(given, cwd) : cwd;
  let isDir = false;
  try {
    isDir = statSync(base).isDirectory();
  } catch {
    // a missing path searches nothing
  }
  if (isDir) scanDirForSecrets(env, base);
  for (const g of globs) {
    if (typeof g !== 'string' || g === '') continue;
    for (const e of braceExpand(g)) {
      if (e.includes(SUBST)) deny('unresolved search glob');
      if (isSecretString(env, e) || isSecretString(env, join(base, e))) {
        deny(`secret file access: ${e}`);
      }
      if (!hasMagic(e)) continue;
      const last = e.slice(e.lastIndexOf('/') + 1);
      if (SECRET_FRAGMENT.test(last)) {
        const re = fileGlobToRegExp(last);
        if (SECRET_SAMPLES.some((s) => re.test(s) && !isSecretExempt(s))) {
          deny(`search glob may match secret files: ${e}`);
        }
      }
      let matches: string[] = [];
      try {
        matches = capped(globSync(e, { cwd: base }));
      } catch (err) {
        if (err instanceof Deny) throw err;
        // unreadable glob: nothing to see
      }
      for (const m of matches) if (isSecretString(env, join(base, m))) deny(`secret file: ${m}`);
    }
  }
}

const isSecretExempt = (s: string): boolean => basename(s) === '.env.example';

const isStringArray = (v: unknown): boolean =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

function check(input: GuardInput, ctx: GuardContext): void {
  const c = ctx as unknown as Record<string, unknown> | null;
  if (
    c === null ||
    typeof c !== 'object' ||
    typeof c.worktree !== 'string' ||
    !isStringArray(c.ownerOnly) ||
    !isStringArray(c.deployCommands) ||
    !isStringArray(c.secretGlobs) ||
    (c.crewAllowedWorkflows !== undefined && !isStringArray(c.crewAllowedWorkflows)) ||
    (c.crewAllowedWorkflowRefs !== undefined && !isStringArray(c.crewAllowedWorkflowRefs)) ||
    (c.protectedPaths !== undefined && !isStringArray(c.protectedPaths)) ||
    (c.readRoots !== undefined && !isStringArray(c.readRoots)) ||
    (c.skillRoots !== undefined && !isStringArray(c.skillRoots)) ||
    (c.toolResultGlobs !== undefined && !isStringArray(c.toolResultGlobs)) ||
    (c.skillRootWaivedGlobs !== undefined && !isStringArray(c.skillRootWaivedGlobs)) ||
    (c.item !== undefined && (typeof c.item !== 'string' || !/^[A-Z]+-\d+$/.test(c.item))) ||
    (c.base !== undefined && (typeof c.base !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(c.base))) ||
    (c.mcpAllow !== undefined && !isStringArray(c.mcpAllow)) ||
    (c.blockedCommands !== undefined && !isStringArray(c.blockedCommands)) ||
    (c.reaClasses !== undefined && !isStringArray(c.reaClasses)) ||
    (c.noPush !== undefined && typeof c.noPush !== 'boolean') ||
    (c.mcpKeys !== undefined &&
      !(
        c.mcpKeys !== null &&
        typeof c.mcpKeys === 'object' &&
        Object.values(c.mcpKeys as Record<string, Record<string, unknown>>).every(
          (e) => isStringArray(e.keys) && isStringArray(e.paths) && isStringArray(e.text),
        )
      )) ||
    (c.artifacts !== undefined &&
      (typeof c.artifacts !== 'string' || !isAbsolute(c.artifacts) || c.artifacts === '/')) ||
    (c.deniedPorts !== undefined &&
      !(
        Array.isArray(c.deniedPorts) &&
        c.deniedPorts.every((p) => Number.isInteger(p) && p >= 1 && p <= 65535)
      ))
  ) {
    deny('invalid guard context');
  }
  const wt = resolveReal(ctx.worktree, '/');
  if (wt === '/') deny('invalid worktree');
  const protectedPaths = [
    `${wt}/.claude`,
    `${wt}/.mcp.json`,
    `${wt}/.git`,
    ...(ctx.protectedPaths ?? []),
  ];
  const env: Env = {
    wt,
    secretRes: ctx.secretGlobs.map(fileGlobToRegExp),
    deployGlobs: ctx.deployCommands.map((glob) => ({ glob, re: commandGlobToRegExp(glob) })),
    ownerGlobs: ctx.ownerOnly.map((glob) => ({ glob, re: commandGlobToRegExp(glob) })),
    allowedWorkflows: ctx.crewAllowedWorkflows ?? [],
    allowedRefs: ctx.crewAllowedWorkflowRefs ?? [],
    protectedReal: protectedPaths
      .flatMap((p) => [p, resolveReal(p, '/')])
      .map((p) => p.toLowerCase()),
    readRoots: [ctx.worktree, ...(ctx.readRoots ?? [])].map((p) => resolveReal(p, '/')),
    skillRoots: (ctx.skillRoots ?? []).flatMap((p) => [p, resolveReal(p, '/')]),
    toolResultRes: (ctx.toolResultGlobs ?? []).map(fileGlobToRegExp),
    hardSecretRes: ctx.secretGlobs
      .filter((g) => !(ctx.skillRootWaivedGlobs ?? []).includes(g))
      .map(fileGlobToRegExp),
    item: ctx.item,
    base: ctx.base,
    mcpAllow: new Set(ctx.mcpAllow ?? []),
    artifacts: ctx.artifacts === undefined ? undefined : resolveReal(ctx.artifacts, '/'),
    artifactsGiven: ctx.artifacts,
    blockedCommands: new Set(ctx.blockedCommands ?? []),
    reaClasses: new Set(ctx.reaClasses ?? []),
    noPush: ctx.noPush === true,
    mcpKeys: new Map(
      Object.entries(ctx.mcpKeys ?? {}).map(([k, v]) => [
        k,
        { keys: new Set(v.keys), paths: new Set(v.paths), text: new Set(v.text) },
      ]),
    ),
  };
  const { toolName, toolInput } = input;
  const given = input.cwd as unknown;
  if (
    given !== undefined &&
    (typeof given !== 'string' || !isAbsolute(given) || given.split('/').includes('..'))
  ) {
    deny('invalid working directory');
  }
  const cwd = resolveReal(input.cwd ?? wt, wt);

  if (typeof toolName === 'string' && env.mcpAllow.has(toolName)) {
    checkMcp(env, toolName, toolInput, cwd);
    return;
  }
  if (typeof toolName !== 'string' || !CREW_TOOLS.has(toolName)) {
    deny(`tool not allowed for crew: ${String(toolName)}`);
  }
  if (toolName === 'Bash') {
    const command = toolInput.command;
    if (typeof command !== 'string') deny(`${toolName} call without a command`);
    const port = namedDeniedPort(command as string, ctx.deniedPorts ?? []);
    if (port !== undefined) deny(`port ${port} is denied on this worker machine`);
    refuseArtifactsInBash(env, command as string, cwd);
    checkBash(env, command as string, cwd, 0);
    return;
  }
  // Only Bash has this field; on another tool it is not what the checks below look at.
  if (toolInput.command !== undefined) deny(`${toolName} call with a command`);

  const writeKey = WRITE_TOOLS[toolName];
  if (writeKey !== undefined) {
    const p = toolInput[writeKey];
    if (typeof p !== 'string' || p === '') deny(`${toolName} call without ${writeKey}`);
    checkWritePath(env, p as string, cwd, toolName);
  }
  if (toolName === 'Read') {
    const p = toolInput.file_path;
    if (typeof p !== 'string' || p === '') deny('Read call without file_path');
    checkReadScope(env, p as string, cwd, toolName);
  }
  if (FILE_TOOLS.has(toolName)) {
    for (const key of ['file_path', 'notebook_path']) {
      const v = toolInput[key];
      if (typeof v === 'string' && v !== '') checkSecretPath(env, v, cwd);
    }
  } else if (toolName === 'Grep' || toolName === 'Glob') {
    if (toolInput.path !== undefined && typeof toolInput.path !== 'string') {
      deny(`${toolName} call with a path that is not a string`);
    }
    const given = (toolInput.path ?? '') as string;
    const start = given === '' ? '.' : given;
    checkReadScope(env, start, cwd, toolName);
    if (toolName === 'Grep') {
      checkSearch(env, toolInput.path, [toolInput.glob], cwd);
    } else {
      if (typeof toolInput.pattern !== 'string') deny('Glob call without a pattern');
      checkGlobScope(env, toolInput.pattern as string, resolveReal(start, cwd), toolName);
      checkSearch(env, toolInput.path, [toolInput.pattern], cwd);
    }
  }
}
