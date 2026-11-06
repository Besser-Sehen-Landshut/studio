import { isDeepStrictEqual } from 'node:util';
import { parseAllDocuments } from 'yaml';
import {
  PY_CODING,
  tokenizeJs,
  tokenizePython,
  tokenizeRust,
  tokenizeShell,
  tokenizeToml,
  tokenizeYaml,
} from './proof-languages.js';
import { no, Out, type Seg, Unclassifiable } from './proof-tokens.js';

/**
 * Built-in proofs for exceptions by evidence: pure functions over the files of the base and the
 * head, no command runs. Each accepts only the boring case and errs towards "not proven".
 *
 * `comments_only` reads SQL as PostgreSQL does, and Rust, TypeScript and JavaScript, shell, Python,
 * YAML and TOML with the tokenizers in src/proof-languages.ts: comment text edited or added, with
 * code untouched. The language comes from the file extension. It compares the code of a file with
 * its plain comments taken out. In free-form languages (SQL, Rust, TypeScript, JavaScript, shell,
 * TOML) whitespace between tokens is reduced to "a line break here" or "a blank here"; in Python
 * and YAML, where indentation is code, every line stays byte for byte and only lines that hold
 * nothing but a plain comment or blanks drop out. String literals, raw strings, templates,
 * here-documents and the like stay byte for byte, and comments with a meaning (directives, hints,
 * doc comments in Rust, executable comments) must be byte-identical and in the same place.
 */

export const PROOF_LANGUAGES = [
  'sql',
  'rust',
  'typescript',
  'javascript',
  'shell',
  'python',
  'yaml',
  'toml',
] as const;
export type ProofLanguage = (typeof PROOF_LANGUAGES)[number];

/** The file extensions of each language, lower case. */
const EXTENSIONS: Record<ProofLanguage, readonly string[]> = {
  sql: ['.sql'],
  rust: ['.rs'],
  typescript: ['.ts', '.tsx', '.mts', '.cts'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs'],
  shell: ['.sh', '.bash'],
  python: ['.py', '.pyi'],
  yaml: ['.yml', '.yaml'],
  toml: ['.toml'],
};

/** Why another language is refused in a rule. */
export const UNKNOWN_LANGUAGE = `comments_only reads ${PROOF_LANGUAGES.join(', ')}; any other language comes later, with its own adversarial review`;

/** The language of a path by its extension, among `allowed`; undefined for any other file. */
export function languageOf(
  path: string,
  allowed: readonly ProofLanguage[],
): ProofLanguage | undefined {
  const lower = path.toLowerCase();
  return allowed.find((l) => EXTENSIONS[l].some((ext) => lower.endsWith(ext)));
}

/** Whether a TypeScript or JavaScript file may hold JSX: all but plain TypeScript, and an unknown path. */
const mayHoldJsx = (path: string): boolean => !/\.[mc]?ts$/i.test(path);

const isIdent = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_$]/.test(c);

/**
 * Words that make a comment a directive to some tool (a migration runner, a query generator, a
 * linter). Matched case-insensitively anywhere in the comment: a prose comment that holds one
 * counts as meaningful too, which errs the safe way.
 */
const DIRECTIVE =
  /goose|sqlx|flyway|liquibase|changeset|rollback|precondition|migrate|no-transaction|sqlc|sqlfluff|squawk|noqa|lint|ignore|disable|enable|pragma/i;

/** Whether a comment has a meaning beyond prose: then it must stay as it is, where it is. */
function meaningful(t: string): boolean {
  if (DIRECTIVE.test(t)) return true;
  // `-- +goose Up`, `--+ INDEX(...)` (an Oracle hint), `-- name: ...` (sqlc) and the like.
  return /^--\s*(?:[+!@$#:%]|[A-Za-z_-]+\s*:)/.test(t);
}

/** A quoted run from `i` (at the opening quote) to its closing quote, doubled quotes inside. */
function quoted(s: string, i: number, quote: string): number {
  let j = i + 1;
  for (;;) {
    const k = s.indexOf(quote, j);
    if (k === -1) return no('an unterminated string');
    if (s[k + 1] === quote) {
      j = k + 2;
      continue;
    }
    return k + 1;
  }
}

/** Line and paragraph separators and NEL: JavaScript and YAML end a line there, the tokenizers do not. */
const SEPARATORS = new Set([0x85, 0x2028, 0x2029]);
/** Bidirectional controls: code that reads otherwise than it shows. */
const BIDI = new Set([0x61c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e]);

/** Why a character of `raw` is refused outside SQL; undefined when none is. */
function refusedChar(raw: string): string | undefined {
  if (raw.charCodeAt(0) === 0xfeff) return 'a byte order mark';
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c < 0x80) continue;
    if (SEPARATORS.has(c)) return 'a line separator that is not a line feed';
    if (BIDI.has(c) || (c >= 0x2066 && c <= 0x2069)) return 'a bidirectional control character';
  }
  return undefined;
}

/**
 * The text of a blob as `language` may be read here, or why not: valid UTF-8 only, no form feed
 * or vertical tab, no carriage return but one right before a line feed (PostgreSQL ends a `--`
 * comment at a lone one), and line endings either all LF or all CRLF. SQL: a byte order mark is
 * kept, and no backslash anywhere (escapes in `E'...'`, other dialects' strings). Every other
 * language reads escapes itself, and refuses a byte order mark, a line or paragraph separator or
 * NEL (JavaScript and YAML end a line there, the tokenizers do not) and bidirectional controls
 * (code that reads otherwise than it shows).
 */
function plainText(
  bytes: Uint8Array | string,
  language: ProofLanguage = 'sql',
): { text: string; crlf: boolean | undefined } | string {
  let raw: string;
  if (typeof bytes === 'string') raw = bytes;
  else {
    try {
      raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return 'not valid UTF-8';
    }
  }
  if (raw.includes('\0')) return 'binary';
  if (language === 'sql') {
    if (raw.includes('\\')) return 'a backslash';
  } else {
    const refused = refusedChar(raw);
    if (refused !== undefined) return refused;
  }
  if (/[\f\v]/.test(raw)) return 'a form feed or vertical tab';
  if (/\r(?!\n)/.test(raw)) return 'a carriage return without a line feed';
  const lf = (raw.match(/\n/g) ?? []).length;
  const crlf = (raw.match(/\r\n/g) ?? []).length;
  if (crlf > 0 && crlf !== lf) return 'mixed line endings';
  return { text: raw.replace(/\r\n/g, '\n'), crlf: lf === 0 ? undefined : crlf > 0 };
}

// SQL as PostgreSQL reads it. Line comments `-- `, block comments (slash-star to star-slash),
// strings `'...'` with doubled quotes, quoted identifiers `"..."`, dollar quoting `$tag$...$tag$`
// with an ASCII tag, positional parameters `$1`. Not proven: `--` without a blank after it, a
// block comment inside a block comment, a block comment whose opener is not followed by a blank
// or a star (the MySQL executable form with `!` runs, the `+` form is an optimizer hint), a
// backtick, a `$` that is neither a dollar quote nor a parameter, and anything unterminated.
// Every loop moves forward: the work is linear in the length of the file.
function tokenizeSql(s: string): Seg[] {
  const out = new Out(meaningful);
  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    if (c === ' ' || c === '\t' || c === '\n') {
      out.push('ws', c);
      i++;
    } else if (s.startsWith('--', i)) {
      const next = s[i + 2];
      if (next !== undefined && next !== ' ' && next !== '\t' && next !== '\n') {
        no('-- without a blank after it');
      }
      const end = s.indexOf('\n', i);
      const stop = end === -1 ? s.length : end;
      out.push('comment', s.slice(i, stop), { eol: true });
      i = stop;
    } else if (s.startsWith('/*', i)) {
      const end = s.indexOf('*/', i + 2);
      if (end === -1) no('an unterminated block comment');
      const inner = s.indexOf('/*', i + 2);
      if (inner !== -1 && inner < end) no('a nested block comment');
      const first = s[i + 2];
      if (first !== '*' && first !== ' ' && first !== '\t' && first !== '\n') {
        no('a block comment that may be executable or a hint');
      }
      out.push('comment', s.slice(i, end + 2));
      i = end + 2;
    } else if (c === "'" || c === '"') {
      const end = quoted(s, i, c);
      out.push('string', s.slice(i, end));
      i = end;
    } else if (c === '`') {
      no('a backtick');
    } else if (c === '$') {
      if (isIdent(s[i - 1])) no('a $ inside a name');
      const param = /^\$[0-9]+/.exec(s.slice(i, i + 12));
      if (param !== null) {
        if (isIdent(s[i + param[0].length])) no('a parameter glued to a name');
        out.push('code', param[0]);
        i += param[0].length;
        continue;
      }
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]{0,62})?\$/.exec(s.slice(i, i + 66));
      if (tag === null) no('a $ that is neither a dollar quote nor a parameter');
      const open = (tag as RegExpExecArray)[0];
      const end = s.indexOf(open, i + open.length);
      if (end === -1) no('an unterminated dollar quote');
      out.push('string', s.slice(i, end + open.length));
      i = end + open.length;
    } else {
      out.push('code', c);
      i++;
    }
  }
  return out.segs;
}

/** The tokenizer of a language; `path` tells plain TypeScript from files that may hold JSX. */
function tokenize(text: string, language: ProofLanguage, path: string): Seg[] {
  switch (language) {
    case 'sql':
      return tokenizeSql(text);
    case 'rust':
      return tokenizeRust(text);
    case 'typescript':
    case 'javascript':
      return tokenizeJs(text, mayHoldJsx(path));
    case 'shell':
      return tokenizeShell(text);
    case 'python':
      return tokenizePython(text);
    case 'yaml':
      return tokenizeYaml(text);
    case 'toml':
      return tokenizeToml(text);
  }
}

/** Languages whose indentation is code: lines stay byte for byte. */
const BY_LINE: readonly ProofLanguage[] = ['python', 'yaml'];

/**
 * The code of a text with plain comments out; undefined when unsure. Free-form languages: tokens
 * joined by `\n` (a line break, or a line comment, lay between them) or a blank. A line comment
 * always ends a line here, so code before and after it is never joined. Python and YAML: see
 * `byLine`. A meaningful comment stays as it is.
 */
export function codeOf(
  text: string,
  language: ProofLanguage = 'sql',
  path = '',
): string | undefined {
  const plain = plainText(text, language);
  if (typeof plain === 'string') return undefined;
  const code = normalized(plain.text, language, path);
  return typeof code === 'string' ? code : undefined;
}

function normalized(text: string, language: ProofLanguage, path: string): string | { why: string } {
  let segs: Seg[];
  try {
    segs = tokenize(text, language, path);
    return BY_LINE.includes(language) ? byLine(segs, language) : byGap(segs);
  } catch (e) {
    if (e instanceof Unclassifiable) return { why: e.message };
    throw e;
  }
}

/**
 * The lines of the code, each byte for byte, with a trailing plain comment and the blanks before
 * it taken off, and lines that then hold nothing but blanks left out. Python: a line that ends in
 * a backslash joins the next one, so a dropped line after it, or a comment taken off right after a
 * backslash, is not proven.
 */
function byLine(segs: Seg[], language: ProofLanguage): string {
  const lines: Seg[][] = [[]];
  for (const seg of segs) {
    if (seg.kind !== 'ws') {
      (lines.at(-1) as Seg[]).push(seg);
      continue;
    }
    for (const [k, part] of seg.text.split('\n').entries()) {
      if (k > 0) lines.push([]);
      if (part !== '') (lines.at(-1) as Seg[]).push({ kind: 'ws', text: part });
    }
  }
  const kept: string[] = [];
  let joins = false;
  for (const line of lines) {
    let rest = line;
    let stripped = false;
    const last = rest.findLastIndex((x) => x.kind !== 'ws');
    const tail = rest[last];
    if (tail?.kind === 'comment' && tail.meaningful !== true) {
      rest = rest.slice(0, last);
      while (rest.at(-1)?.kind === 'ws') rest = rest.slice(0, -1);
      stripped = true;
    }
    if (rest.some((x) => x.kind === 'comment' && x.meaningful !== true)) {
      no('a comment that does not end its line');
    }
    if (!rest.some((x) => x.kind !== 'ws')) {
      if (joins) no('a line dropped after a backslash');
      continue;
    }
    const text = rest.map((x) => x.text).join('');
    // The Python tokenizer keeps a backslash and its line feed together in one code run.
    const backslash = language === 'python' && text.endsWith('\\\n');
    if (stripped && backslash) no('a comment right after a backslash');
    joins = backslash;
    kept.push(text);
  }
  return kept.join('\n');
}

function byGap(segs: Seg[]): string {
  const parts: string[] = [];
  let gap: 'none' | 'blank' | 'line' = 'none';
  const widen = (to: 'blank' | 'line') => {
    if (gap !== 'line') gap = to;
  };
  for (const seg of segs) {
    if (seg.kind === 'ws') {
      widen(seg.text.includes('\n') ? 'line' : 'blank');
      continue;
    }
    const line = seg.kind === 'comment' && seg.eol === true;
    if (seg.kind === 'comment' && seg.meaningful !== true) {
      widen(line || seg.text.includes('\n') ? 'line' : 'blank');
      continue;
    }
    if (parts.length > 0 && gap !== 'none') parts.push(gap === 'line' ? '\n' : ' ');
    parts.push(seg.text);
    gap = line ? 'line' : 'none';
  }
  return parts.join('');
}

/**
 * YAML read a second way: both versions must load without an error in the `yaml` package, to the
 * same data. A second reader that disagrees with the tokenizer proves nothing.
 */
function sameYaml(a: string, b: string): string | undefined {
  try {
    const load = (text: string) => {
      const docs = parseAllDocuments(text);
      const list = Array.isArray(docs) ? docs : [docs];
      if (list.some((d) => d.errors.length > 0)) return undefined;
      return list.map((d) => d.toJS({ maxAliasCount: 100 }) as unknown);
    };
    const da = load(a);
    const db = load(b);
    if (da === undefined || db === undefined) return 'it does not load as YAML';
    return isDeepStrictEqual(da, db) ? undefined : 'it loads to other data';
  } catch {
    return 'it does not load as YAML';
  }
}

/**
 * Why two versions of a file are not "comments only"; undefined when they are. `path` names the
 * file (plain TypeScript holds no JSX); the language is the caller's, from `languageOf`.
 */
export function commentsOnlyWhy(
  base: Uint8Array | string,
  head: Uint8Array | string,
  language: ProofLanguage = 'sql',
  path = '',
): string | undefined {
  const a = plainText(base, language);
  const b = plainText(head, language);
  if (typeof a === 'string') return `the base has ${a}`;
  if (typeof b === 'string') return `the head has ${b}`;
  if (a.crlf !== undefined && b.crlf !== undefined && a.crlf !== b.crlf) {
    return 'its line endings changed';
  }
  const ca = normalized(a.text, language, path);
  const cb = normalized(b.text, language, path);
  if (typeof ca !== 'string') return `the base cannot be read for sure: ${ca.why}`;
  if (typeof cb !== 'string') return `the head cannot be read for sure: ${cb.why}`;
  if (ca !== cb) return 'it changes more than plain comments';
  if (language === 'python') {
    // An encoding declaration counts only in line 1 or 2: a line added above it, or one in a
    // line where there was none, changes how the file is decoded.
    const firstTwo = (t: string) => t.split('\n').slice(0, 2);
    const la = firstTwo(a.text);
    const lb = firstTwo(b.text);
    const declares = [...la, ...lb].some((l) => PY_CODING.test(l));
    if (declares && la.join('\n') !== lb.join('\n')) {
      return 'it changes the lines that may declare the encoding';
    }
  }
  return language === 'yaml' ? sameYaml(a.text, b.text) : undefined;
}

/** Whether two versions of a file differ in plain comments only. */
export function commentsOnly(
  base: Uint8Array | string,
  head: Uint8Array | string,
  language: ProofLanguage = 'sql',
  path = '',
): boolean {
  return commentsOnlyWhy(base, head, language, path) === undefined;
}

/** A token of SQL code: a bare word (upper-cased), a quoted name, a literal or one character. */
export type SqlToken = { kind: 'word' | 'name' | 'literal' | 'punct'; text: string };

/**
 * The statements of a SQL text as tokens, comments left out; why not when the text cannot be read
 * for sure (the same rules as `comments_only`). Bare words are upper-cased; string literals and
 * dollar-quoted bodies are one `literal` token each, so a word inside them is never read as code.
 * A `;` ends a statement; empty statements are dropped.
 */
export function sqlStatements(
  bytes: Uint8Array | string,
): { statements: SqlToken[][]; directives: string[] } | string {
  const plain = plainText(bytes);
  if (typeof plain === 'string') return plain;
  // Whitespace PostgreSQL does not read as such, or a tool might: nothing is proven with it.
  if (/[\u0085\u00A0\u1680\u2000-\u200B\u2028\u2029\u202F\u205F\u3000\uFEFF]/u.test(plain.text)) {
    return 'whitespace that is not ASCII';
  }
  let segs: Seg[];
  try {
    segs = tokenizeSql(plain.text);
  } catch (e) {
    if (e instanceof Unclassifiable) return e.message;
    throw e;
  }
  const statements: SqlToken[][] = [];
  // Comments with a meaning to a tool (a migration runner's directive): they change how it runs.
  const directives: string[] = [];
  let cur: SqlToken[] = [];
  const end = () => {
    if (cur.length > 0) statements.push(cur);
    cur = [];
  };
  for (const seg of segs) {
    if (seg.kind === 'comment' && seg.meaningful === true) directives.push(seg.text);
    if (seg.kind === 'ws' || seg.kind === 'comment') continue;
    if (seg.kind === 'string') {
      cur.push({ kind: seg.text.startsWith('"') ? 'name' : 'literal', text: seg.text });
      continue;
    }
    for (const m of seg.text.matchAll(/[A-Za-z_][A-Za-z0-9_$]*|[0-9]+|[^A-Za-z0-9_\s]/g)) {
      const t = m[0];
      if (t === ';') end();
      else if (/^[A-Za-z_]/.test(t)) cur.push({ kind: 'word', text: t.toUpperCase() });
      else cur.push({ kind: 'punct', text: t });
    }
  }
  end();
  return { statements, directives };
}
