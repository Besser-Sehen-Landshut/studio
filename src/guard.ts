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
}

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
  return env.secretRes.some((re) => re.test(s));
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
  return env.protectedReal.some((p) => low === p || low.startsWith(`${p}/`));
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
const SENSITIVE_VAR =
  /^(STUDIO_|NODE_OPTIONS$|NODE_PATH$|NPM_CONFIG_|PNPM_|YARN_|COREPACK_|GIT_|GH_|GITHUB_|LD_|DYLD_|CDPATH$|PATH$|HOME$|BASH_ENV$|ENV$|SHELLOPTS$|BASHOPTS$|PROMPT_COMMAND$|IFS$)/i;

const unresolved = (w: string): boolean => w.includes(SUBST) || w.includes('$') || w.includes('`');
/** A word whose real value depends on the shell at run time (variables, substitutions, globs). */
const unresolvedWord = (w: string): boolean =>
  unresolved(w) || (/[*?[]/.test(w) && w !== '[' && w !== '[[');

function checkVarName(name: string): void {
  if (SENSITIVE_VAR.test(name)) deny(`setting ${name} is not allowed`);
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
  let repoGiven = false;
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
      if (name === '--repo') repoGiven = true;
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

function checkFetch(rawArgs: string[]): void {
  const args = rawArgs.flatMap((a) => braceExpand(a));
  for (const a of args) {
    if (unresolvedWord(a)) {
      deny(`unresolved git fetch argument: ${a.replaceAll(SUBST, '<runtime>')}`);
    }
  }
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string;
    const refmap = a === '--refmap' ? args[k + 1] : a.startsWith('--refmap=') ? a.slice(9) : null;
    if (refmap !== null) {
      // a --refmap that is not a plain refspec cannot be told from one that writes remote refs
      if (refmap === undefined || writesRemoteRefs(refmap.replace(/^\+/, ''))) {
        deny('git fetch --refmap into refs/remotes/ is not allowed');
      }
      continue;
    }
    if (!a.startsWith('-') && writesRemoteRefs(a.replace(/^\+/, ''))) {
      deny('git fetch into refs/remotes/ is not allowed (origin/* is set by the owner)');
    }
  }
}

function checkGit(env: Env, args: string[], state: State): void {
  let i = 0;
  while (i < args.length) {
    const a = args[i] as string;
    if (unresolvedWord(a)) deny('unresolved git option');
    if (a === '-C' || a === '--git-dir' || a === '--work-tree') {
      const v = args[i + 1];
      if (v === undefined) deny(`missing value for git ${a}`);
      checkInsideDir(env, v as string, state, `git ${a}`);
      i += 2;
    } else if (a.startsWith('--git-dir=') || a.startsWith('--work-tree=')) {
      checkInsideDir(env, a.slice(a.indexOf('=') + 1), state, 'git option');
      i++;
    } else if (a === '-c' || a === '--config-env') {
      checkGitC(args[i + 1] ?? '');
      i += 2;
    } else if (a.startsWith('--config-env=')) {
      checkGitC(a.slice(13));
      i++;
    } else if (a === '--namespace' || a === '--exec-path') i += 2;
    else if (a.startsWith('-')) i++;
    else break;
  }
  const sub = args[i];
  if (sub === undefined) return;
  if (unresolvedWord(sub)) deny('unresolved command word (git subcommand)');
  const rest = args.slice(i + 1);
  if (sub === 'push') checkPush(env, rest);
  else if (sub === 'fetch' || sub === 'pull') checkFetch(rest);
  else if (
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
  } else if (sub === 'clone') {
    const pos = positionals(rest);
    if (pos.length >= 2) checkWritePath(env, pos[pos.length - 1] as string, state.cwd, 'git clone');
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

const GH_BLOCKED_TOPICS = new Set(['release', 'secret', 'auth', 'alias']);
const GH_RUN_VALUE_FLAGS = ['--ref', '-r', '-f', '--raw-field', '-F', '--field', ...GH_VALUE_FLAGS];

function checkGh(env: Env, args: string[]): void {
  const words: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string;
    if (GH_VALUE_FLAGS.includes(a)) k++;
    else if (!a.startsWith('-')) words.push(a);
  }
  const [g0, g1] = words;
  for (const w of [g0, g1]) {
    if (w !== undefined && unresolvedWord(w)) deny('unresolved command word (gh subcommand)');
  }
  if (g0 === 'pr' && g1 === 'merge') deny('gh pr merge is not allowed (merging is owner-only)');
  if (g0 && GH_BLOCKED_TOPICS.has(g0)) deny(`gh ${g0} is not allowed`);
  if (g0 === 'workflow' && g1 === 'run') {
    const pos: string[] = [];
    for (let k = 0; k < args.length; k++) {
      const a = args[k] as string;
      if (GH_RUN_VALUE_FLAGS.includes(a)) k++;
      else if (!a.startsWith('-')) pos.push(a);
    }
    for (let k = 0; k < args.length; k++) {
      const a = args[k] as string;
      let ref: string | undefined;
      if (a === '--ref' || a === '-r') ref = args[k + 1] ?? '';
      else if (a.startsWith('--ref=')) ref = a.slice(6);
      else if (/^-r./.test(a) && !a.startsWith('--')) ref = a.slice(2);
      if (ref !== undefined && (unresolvedWord(ref) || !env.allowedRefs.includes(ref))) {
        deny(`workflow ref "${ref}" is not in crew_allowed_workflow_refs`);
      }
    }
    const target = pos[2];
    if (target === undefined) deny('gh workflow run needs an explicit workflow');
    if (unresolved(target as string)) deny('unresolved workflow name');
    if (!env.allowedWorkflows.includes(target as string)) {
      deny(`workflow "${target}" is not in crew_allowed_workflows`);
    }
  }
  if (g0 === 'api') checkGhApi(args);
}

/**
 * `gh api` for the crew: plain GET reads only. Exact flag allowlist, every flag its own token:
 * -H/--header V, -q/--jq V, --paginate, -i/--include, --hostname github.com.
 */
function checkGhApi(rawArgs: string[]): void {
  const apiAt = rawArgs.indexOf('api');
  for (let k = 0; k < apiAt; k++) {
    const a = rawArgs[k] as string;
    if (a === '-R' || a === '--repo') k++;
    else deny(`gh option ${a} before api is not allowed`);
  }
  const args = rawArgs.slice(apiAt + 1);
  let endpoint: string | undefined;
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string;
    if (a === '-H' || a === '--header' || a === '-q' || a === '--jq') {
      if (args[k + 1] === undefined) deny(`missing value for gh api ${a}`);
      k++;
    } else if (a === '--hostname') {
      if (args[++k] !== 'github.com') deny('gh api --hostname must be github.com');
    } else if (a === '--paginate' || a === '-i' || a === '--include') {
      // allowed read flags
    } else if (a.startsWith('-')) {
      deny(`gh api flag ${a} is not allowed (read-only: -H, -q, --paginate, -i, --hostname)`);
    } else if (endpoint !== undefined) {
      deny('gh api with more than one endpoint is not allowed');
    } else endpoint = a;
  }
  if (endpoint === undefined) deny('gh api without endpoint');
  if (unresolved(endpoint as string)) deny('unresolved gh api endpoint');
  if (/[%#]|:\/\//.test(endpoint as string)) deny('suspicious gh api endpoint');
  const path = (endpoint as string).split('?')[0]?.replace(/\/+$/, '') as string;
  if (/graphql$/i.test(path)) deny('gh api graphql is not allowed');
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

/** Flags that make node print something and run no script. */
const NODE_INFO_FLAGS = new Set(['--version', '--help', '--test']);

/**
 * Denies node unless it runs a literal script file (or only prints information). Inline code
 * (`-e`, `-p`, `--eval`, `--print`) and scripts read from stdin are denied: node may read stdin after
 * flags, so a missing script path is a denial. An option without `=` may take the next word as its
 * value, so that word and the one after it both count as possible scripts. Words after the script
 * are its arguments and stay free. Flags before a script are allowed (`node --no-warnings a.js`).
 */
function checkNode(args: string[]): void {
  const notLiteral = 'node with a script argument that is not literal is not allowed';
  const noScript = 'node without a literal script file is not allowed';
  let mayBeValue = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string;
    if (unresolvedWord(a)) deny(notLiteral);
    if (a === '-') deny(noScript);
    if (a === '--') {
      const script = args[k + 1];
      if (script === undefined) deny(noScript);
      if (script !== undefined && unresolvedWord(script)) deny(notLiteral);
      if (script !== undefined && isStudioBinary(script)) deny(CREW_NO_STUDIO);
      return;
    }
    if (a.startsWith('-')) {
      if (/studio/i.test(a)) deny(CREW_NO_STUDIO);
      if (/^(-[A-Za-z]*[pe][A-Za-z]*|--eval|--print)(=|$)/.test(a)) deny(noScript);
      mayBeValue = !a.includes('=');
      continue;
    }
    if (isStudioBinary(a)) deny(CREW_NO_STUDIO);
    if (!mayBeValue) return;
    mayBeValue = false;
  }
  if (!args.some((a) => NODE_INFO_FLAGS.has(a))) deny(noScript);
}

/**
 * One simple rule for package runners: tools that fetch and run a package, and `--shell-mode`, are
 * denied. Everything else in npm, pnpm and yarn passes; the guard does not contain a malicious crew
 * (package.json scripts run anything), the sandbox does.
 */
function checkPackageRunner(name: string, args: string[]): void {
  const deniedRunner = (): never => deny(`${name} is a package runner and is not allowed`);
  if (name === 'npx' || name === 'pnpx' || name === 'bunx' || name === 'corepack') deniedRunner();
  if (name === 'bun' && args[0] === 'x') deniedRunner();
  if (name !== 'npm' && name !== 'pnpm' && name !== 'yarn') return;
  if (args.some((a) => a === '--shell-mode' || a.startsWith('--shell-mode='))) {
    deny(`${name} --shell-mode is not allowed`);
  }
  const own = args.indexOf('--');
  const before = own === -1 ? args : args.slice(0, own);
  if (before.some((a) => a === 'exec' || a === 'dlx')) deniedRunner();
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
  if (name === 'gh') checkGh(env, args);
  for (const t of writeTargets(name, args)) checkWritePath(env, t, state.cwd, name);
}

function checkBash(env: Env, cmd: string, cwd: string | null, depth: number): void {
  if (depth > 8) deny('command nesting too deep');
  // Arithmetic can assign (`(( X = 1 ))`, `$(( X++ ))`) without an assignment word; deny any `((` command
  // that has an assignment or increment operator. `==`, `!=`, `<=`, `>=` are comparisons and stay allowed.
  if (cmd.includes('((') && /(?<![=!<>])=(?!=)|<<=|>>=|\+\+|--/.test(cmd)) {
    deny('assignment in arithmetic is not allowed');
  }
  const { lines, subs } = scan(cmd);
  for (const sub of subs) checkBash(env, sub, cwd, depth + 1);
  const state: State = { cwd };
  for (const line of lines) {
    for (const seg of toSegments(line)) checkSegment(env, seg, state);
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
    (c.protectedPaths !== undefined && !isStringArray(c.protectedPaths))
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
  };
  const { toolName, toolInput } = input;
  const cwd = resolveReal(input.cwd ?? wt, wt);

  if (typeof toolName !== 'string' || !CREW_TOOLS.has(toolName)) {
    deny(`tool not allowed for crew: ${String(toolName)}`);
  }
  if (toolName === 'Bash' || typeof toolInput.command === 'string') {
    const command = toolInput.command;
    if (typeof command !== 'string') deny(`${toolName} call without a command`);
    checkBash(env, command as string, cwd, 0);
    return;
  }

  const writeKey = WRITE_TOOLS[toolName];
  if (writeKey !== undefined) {
    const p = toolInput[writeKey];
    if (typeof p !== 'string' || p === '') deny(`${toolName} call without ${writeKey}`);
    checkWritePath(env, p as string, cwd, toolName);
  }
  if (FILE_TOOLS.has(toolName)) {
    for (const key of ['file_path', 'notebook_path']) {
      const v = toolInput[key];
      if (typeof v === 'string' && v !== '') checkSecretPath(env, v, cwd);
    }
  } else if (toolName === 'Grep') {
    checkSearch(env, toolInput.path, [toolInput.glob], cwd);
  } else if (toolName === 'Glob') {
    checkSearch(env, toolInput.path, [toolInput.pattern], cwd);
  }
}
