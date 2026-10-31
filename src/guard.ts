// Crew guard: decides whether a tool call of a crew session may run.
// The sandbox only covers shell commands, so this is the layer that confines the file tools
// (Edit/Write/...) to the worktree. Best effort for shell commands; every internal error denies.
// Keep this module free of imports from other src files: bin/studio-guard.mjs may load it directly
// through Node's native TypeScript type stripping when the package was not built.
import { globSync, lstatSync, readlinkSync } from 'node:fs';
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
  return new RegExp(`^${glob.startsWith('/') ? '' : '(?:.*/)?'}${re}$`);
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

function checkWritePath(env: Env, tok: string, cwd: string | null, why: string): void {
  if (ALLOWED_DEVICES.has(tok)) return;
  for (const t of braceExpand(tok)) {
    if (t.includes(SUBST) || t.includes('$') || t.includes('`') || t.startsWith('~')) {
      deny(`unresolvable path in ${why}: ${t.replaceAll(SUBST, '<runtime>')}`);
    }
    if (t === '') deny(`empty path in ${why}`);
    if (cwd === null && !isAbsolute(t)) {
      deny(`relative path after unresolvable cd in ${why}: ${t}`);
    }
    if (!isInside(env, resolveReal(t, cwd ?? env.wt))) {
      deny(`write outside worktree (${why}): ${t}`);
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
          matches = globSync(e, { cwd: base }).slice(0, 500);
        } catch {
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
      for (; j < n && !/[\s;&|<>()]/.test(src[j] as string); j++) {
        const d = src[j] as string;
        if (d === "'" || d === '"' || d === '\\') quoted = true;
        else delim += d;
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
      } else if (t.op === '<' || t.op === '<>') {
        const target = wordOf(toks[++k]);
        if (target === undefined) deny('unparseable command');
        cur.reads.push(target as string);
      } else if (['>', '>>', '>|', '&>', '&>>', '>&'].includes(t.op)) {
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
  'time',
  'then',
  'do',
  'else',
  'elif',
  'if',
  'while',
  'until',
  'command',
  'builtin',
  'exec',
  'nohup',
  'setsid',
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function skipWrappers(words: string[]): number {
  let i = 0;
  while (i < words.length) {
    const w = words[i] as string;
    if (ASSIGNMENT.test(w) || WRAPPER_WORDS.has(w)) {
      i++;
    } else if (w === 'env') {
      i++;
      while (i < words.length) {
        const x = words[i] as string;
        if (x === '-u' || x === '-C' || x === '-S') i += 2;
        else if (x.startsWith('-') || ASSIGNMENT.test(x)) i++;
        else break;
      }
    } else if (w === 'nice') {
      i++;
      if (words[i] === '-n') i += 2;
      else if (/^-\d+$/.test(words[i] ?? '')) i++;
    } else if (w === 'timeout') {
      i++;
      while (i < words.length && (words[i] as string).startsWith('-')) {
        i += words[i] === '-s' || words[i] === '-k' ? 2 : 1;
      }
      i++; // duration
    } else break;
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

function checkCommandGlobs(env: Env, words: string[]): void {
  const text = words.join(' ');
  for (const g of env.ownerGlobs)
    if (g.re.test(text)) deny(`owner-only command (matches "${g.glob}")`);
  for (const g of env.deployGlobs)
    if (g.re.test(text)) deny(`deploy command (matches "${g.glob}")`);
}

const PUSH_DANGEROUS = [
  '--force',
  '--force-with-lease',
  '--force-if-includes',
  '--mirror',
  '--delete',
  '--prune',
  '--all',
];

function checkRefspec(ref: string): void {
  if (ref.startsWith('+')) deny(`git push with force refspec "${ref}"`);
  if (ref.startsWith(':')) deny(`git push deleting remote ref "${ref}"`);
  if (ref.includes('*')) deny(`git push with glob refspec "${ref}"`);
  const dest = (ref.includes(':') ? ref.slice(ref.lastIndexOf(':') + 1) : ref).replace(
    /^refs\/heads\//,
    '',
  );
  if (dest === 'main' || dest === 'master') deny(`git push to protected branch "${dest}"`);
}

function checkPush(args: string[]): void {
  const pos: string[] = [];
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
      if (
        !a.includes('=') &&
        ['--repo', '--receive-pack', '--exec', '--push-option'].includes(name)
      )
        k++;
    } else if (/^-[A-Za-z]+$/.test(a)) {
      if (/[fd]/.test(a)) deny(`git push ${a} is not allowed`);
      if (a.endsWith('o')) k++;
    } else pos.push(a);
  }
  for (const ref of pos.slice(1)) checkRefspec(ref);
}

function checkGit(env: Env, args: string[], state: State): void {
  let i = 0;
  while (i < args.length) {
    const a = args[i] as string;
    if (a === '-C' || a === '--git-dir' || a === '--work-tree') {
      const v = args[i + 1];
      if (v === undefined) deny(`missing value for git ${a}`);
      checkInsideDir(env, v as string, state, `git ${a}`);
      i += 2;
    } else if (a.startsWith('--git-dir=') || a.startsWith('--work-tree=')) {
      checkInsideDir(env, a.slice(a.indexOf('=') + 1), state, 'git option');
      i++;
    } else if (a === '-c') {
      const kv = args[i + 1] ?? '';
      if (/^alias\./i.test(kv)) deny('git -c alias is not allowed');
      i += 2;
    } else if (a === '--namespace' || a === '--exec-path') i += 2;
    else if (a.startsWith('-')) i++;
    else break;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === 'push') checkPush(rest);
  else if (sub === 'clone') {
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
const GH_API_FORBIDDEN =
  /\/(merge|dispatches)$|\/releases(\/|$)|\/actions\/workflows\/[^/]+\/dispatches|\/actions\/secrets|\/git\/refs|\/branches\/[^/]+\/protection|\/rulesets/;

function checkGh(args: string[]): void {
  const words: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string;
    if (a === '-R' || a === '--repo') k++;
    else if (!a.startsWith('-')) words.push(a);
  }
  const [g0, g1] = words;
  if (g0 === 'pr' && g1 === 'merge') deny('gh pr merge is not allowed (merging is owner-only)');
  if (g0 && GH_BLOCKED_TOPICS.has(g0)) deny(`gh ${g0} is not allowed`);
  if (g0 === 'api') checkGhApi(args);
}

function checkGhApi(args: string[]): void {
  let method: string | undefined;
  let hasFields = false;
  let endpoint: string | undefined;
  const withValue = new Set([
    '-H',
    '--header',
    '-q',
    '--jq',
    '-t',
    '--template',
    '--hostname',
    '--cache',
    '-p',
    '--preview',
    '-R',
    '--repo',
  ]);
  for (let k = 1; k < args.length; k++) {
    const a = args[k] as string;
    if (a === '-X' || a === '--method') method = args[++k];
    else if (a.startsWith('--method=')) method = a.slice(9);
    else if (/^-X./.test(a)) method = a.slice(2);
    else if (['-f', '-F', '--field', '--raw-field', '--input'].includes(a)) {
      hasFields = true;
      k++;
    } else if (withValue.has(a)) k++;
    else if (!a.startsWith('-') && endpoint === undefined) endpoint = a;
  }
  const text = args.join(' ');
  if (
    /mergePullRequest|enablePullRequestAutoMerge|createRelease|deleteRelease|updateRef|deleteRef/i.test(
      text,
    )
  ) {
    deny('gh api GraphQL mutation for merge/release/ref is not allowed');
  }
  const m = (method ?? (hasFields ? 'POST' : 'GET')).toUpperCase();
  if (m !== 'GET' && endpoint !== undefined) {
    const path = endpoint.split('?')[0] as string;
    if (GH_API_FORBIDDEN.test(path))
      deny(`gh api ${m} ${path} is not allowed (merge/release/deploy)`);
  }
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
    checkWords(env, cmd, state, 0);
  }
}

const XARGS_VALUE_FLAGS = new Set(['-n', '-I', '-P', '-d', '-L', '-s', '-E', '-a']);

function checkSegment(env: Env, seg: Segment, state: State, depth: number): void {
  const base = state.cwd ?? env.wt;
  for (const w of seg.writes) checkWritePath(env, w, state.cwd, 'redirection');
  for (const r of seg.reads) checkSecretToken(env, r, base);
  for (const w of seg.writes) checkSecretToken(env, w, base);
  checkWords(env, seg.words, state, depth);
}

function checkWords(env: Env, words: string[], state: State, depth: number): void {
  if (words.length === 0) return;
  const base = state.cwd ?? env.wt;
  for (const w of words) checkSecretToken(env, w, base);
  checkCommandGlobs(env, words);
  const at = skipWrappers(words);
  const cmdWord = words[at];
  if (cmdWord === undefined) return;
  if (at > 0) checkCommandGlobs(env, words.slice(at));
  if (cmdWord.includes(SUBST) || cmdWord.includes('$')) {
    deny('unresolvable command word');
  }
  const name = basename(cmdWord);
  const args = words.slice(at + 1);

  if (name === 'sudo' || name === 'su' || name === 'doas') {
    deny(`privilege escalation (${name}) is not allowed`);
  }
  if (name === 'cd' || name === 'pushd') {
    const target = args.find((a) => !a.startsWith('-') || a === '-');
    if (
      target === undefined ||
      target === '-' ||
      target.includes(SUBST) ||
      target.includes('$') ||
      target.startsWith('~')
    ) {
      state.cwd = null;
    } else if (state.cwd === null && !isAbsolute(target)) {
      state.cwd = null;
    } else {
      state.cwd = resolveReal(target, state.cwd ?? env.wt);
    }
    return;
  }
  if (['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(name)) {
    const idx = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
    if (idx >= 0) {
      const payload = args[idx + 1];
      if (payload === undefined) deny('unparseable command (missing -c payload)');
      checkBash(env, payload as string, state.cwd, depth + 1);
    }
    return;
  }
  if (name === 'eval') {
    checkBash(env, args.join(' '), state.cwd, depth + 1);
    return;
  }
  if (name === 'xargs') {
    let k = 0;
    while (k < args.length && (args[k] as string).startsWith('-')) {
      k += XARGS_VALUE_FLAGS.has(args[k] as string) ? 2 : 1;
    }
    checkWords(env, [...args.slice(k), SUBST], state, depth + 1);
    return;
  }
  if (name === 'find') checkFind(env, args, state);
  if (name === 'git') checkGit(env, args, state);
  if (name === 'gh') checkGh(args);
  for (const t of writeTargets(name, args)) checkWritePath(env, t, state.cwd, name);
}

function checkBash(env: Env, cmd: string, cwd: string | null, depth: number): void {
  if (depth > 8) deny('command nesting too deep');
  const { lines, subs } = scan(cmd);
  for (const sub of subs) checkBash(env, sub, cwd, depth + 1);
  const state: State = { cwd };
  for (const line of lines) {
    for (const seg of toSegments(line)) checkSegment(env, seg, state, depth);
  }
}

// ---------------------------------------------------------------- tools

const WRITE_TOOLS: Record<string, string> = {
  Edit: 'file_path',
  Write: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};
const SECRET_KEYS = ['file_path', 'notebook_path', 'path', 'pattern', 'glob'];
const SECRET_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'NotebookRead',
]);

function check(input: GuardInput, ctx: GuardContext): void {
  const wt = resolveReal(ctx.worktree, '/');
  if (wt === '/') deny('invalid worktree');
  const env: Env = {
    wt,
    secretRes: ctx.secretGlobs.map(fileGlobToRegExp),
    deployGlobs: ctx.deployCommands.map((glob) => ({ glob, re: commandGlobToRegExp(glob) })),
    ownerGlobs: ctx.ownerOnly.map((glob) => ({ glob, re: commandGlobToRegExp(glob) })),
  };
  const { toolName, toolInput } = input;
  const cwd = resolveReal(input.cwd ?? wt, wt);

  if (toolName === 'Bash') {
    const command = toolInput.command;
    if (typeof command !== 'string') deny('Bash call without a command');
    checkBash(env, command as string, cwd, 0);
    return;
  }

  const writeKey = WRITE_TOOLS[toolName];
  if (writeKey !== undefined) {
    const p = toolInput[writeKey];
    if (typeof p !== 'string' || p === '') deny(`${toolName} call without ${writeKey}`);
    checkWritePath(env, p as string, cwd, toolName);
  }
  if (SECRET_TOOLS.has(toolName)) {
    const dir = typeof toolInput.path === 'string' ? toolInput.path : undefined;
    for (const key of SECRET_KEYS) {
      const v = toolInput[key];
      if (typeof v !== 'string' || v === '') continue;
      checkSecretPath(env, v, cwd);
      if (dir !== undefined && key !== 'path') checkSecretPath(env, `${dir}/${v}`, cwd);
    }
  }
}
