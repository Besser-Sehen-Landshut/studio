/**
 * Built-in proofs for exceptions by evidence: pure functions over the files of the base and the
 * head, no command runs. Each accepts only the boring case and errs towards "not proven".
 *
 * `comments_only` reads SQL as PostgreSQL does, and nothing else: comment text edited or added,
 * with code untouched. More languages and dialects come later, each with an adversarial review of
 * its own. It compares the code of a file with its plain comments taken out and its whitespace
 * reduced to "a line break here" or "a blank here"; string literals, quoted identifiers and
 * dollar-quoted bodies stay byte for byte, and comments with a meaning (directives, hints,
 * executable comments) must be byte-identical and in the same place.
 */

export const PROOF_LANGUAGES = ['sql'] as const;
export type ProofLanguage = (typeof PROOF_LANGUAGES)[number];

/** Why another language is refused in a rule. */
export const ONLY_SQL =
  'comments_only reads sql only so far; more languages come later, each with its own adversarial review';

/** The language of a path by its extension, among `allowed`; undefined for any other file. */
export function languageOf(
  path: string,
  allowed: readonly ProofLanguage[],
): ProofLanguage | undefined {
  return allowed.includes('sql') && path.toLowerCase().endsWith('.sql') ? 'sql' : undefined;
}

/**
 * A run of the file. A comment keeps its kind while the tokenizer runs; `meaningful` marks one
 * that must stay byte for byte, and nothing in the tokenizer reads that flag.
 */
type Seg = { kind: 'code' | 'string' | 'comment' | 'ws'; text: string; meaningful?: true };
/** Thrown for anything the tokenizer cannot classify for sure. */
class Unclassifiable extends Error {}
const no = (why: string): never => {
  throw new Unclassifiable(why);
};

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

/**
 * Collects segments. Each comment is classified the moment it is read, on its own, and keeps its
 * kind; comments are never merged, so a plain comment cannot hide a meaningful one right behind
 * it. Only whitespace and code runs are merged.
 */
class Out {
  segs: Seg[] = [];
  push(kind: Seg['kind'], text: string): void {
    if (kind === 'comment') {
      this.segs.push({ kind, text, ...(meaningful(text) ? { meaningful: true as const } : {}) });
      return;
    }
    const last = this.segs.at(-1);
    if (last !== undefined && last.kind === kind && (kind === 'ws' || kind === 'code')) {
      last.text += text;
    } else this.segs.push({ kind, text });
  }
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

/**
 * The text of a blob as SQL may be read here, or why not: valid UTF-8 only (a byte order mark is
 * kept), no backslash anywhere (escapes in `E'...'`, other dialects' strings), no form feed or
 * vertical tab, no carriage return but one right before a line feed (PostgreSQL ends a `--`
 * comment at a lone one), and line endings either all LF or all CRLF.
 */
function plainText(
  bytes: Uint8Array | string,
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
  if (raw.includes('\\')) return 'a backslash';
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
  const out = new Out();
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
      out.push('comment', s.slice(i, stop));
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

/**
 * The code of a SQL text with plain comments out, as tokens joined by `\n` (a line break, or a
 * line comment, lay between them) or a blank; undefined when unsure. A line comment always ends a
 * line here, so code before and after it is never joined. A meaningful comment stays as it is.
 */
export function codeOf(text: string, _language: ProofLanguage = 'sql'): string | undefined {
  const plain = plainText(text);
  if (typeof plain === 'string') return undefined;
  return normalized(plain.text);
}

function normalized(text: string): string | undefined {
  let segs: Seg[];
  try {
    segs = tokenizeSql(text);
  } catch (e) {
    if (e instanceof Unclassifiable) return undefined;
    throw e;
  }
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
    const line = seg.kind === 'comment' && seg.text.startsWith('--');
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

/** Why two versions of a SQL file are not "comments only"; undefined when they are. */
export function commentsOnlyWhy(
  base: Uint8Array | string,
  head: Uint8Array | string,
): string | undefined {
  const a = plainText(base);
  const b = plainText(head);
  if (typeof a === 'string') return `the base has ${a}`;
  if (typeof b === 'string') return `the head has ${b}`;
  if (a.crlf !== undefined && b.crlf !== undefined && a.crlf !== b.crlf) {
    return 'its line endings changed';
  }
  const ca = normalized(a.text);
  const cb = normalized(b.text);
  if (ca === undefined || cb === undefined) return 'it cannot be read for sure';
  return ca === cb ? undefined : 'it changes more than plain comments';
}

/** Whether two versions of a SQL file differ in plain comments only. */
export function commentsOnly(
  base: Uint8Array | string,
  head: Uint8Array | string,
  _language: ProofLanguage = 'sql',
): boolean {
  return commentsOnlyWhy(base, head) === undefined;
}

/** A token of SQL code: a bare word (upper-cased), a quoted name, a literal or one character. */
export type SqlToken = { kind: 'word' | 'name' | 'literal' | 'punct'; text: string };

/**
 * The statements of a SQL text as tokens, comments left out; why not when the text cannot be read
 * for sure (the same rules as `comments_only`). Bare words are upper-cased; string literals and
 * dollar-quoted bodies are one `literal` token each, so a word inside them is never read as code.
 * A `;` ends a statement; empty statements are dropped.
 */
export function sqlStatements(bytes: Uint8Array | string): { statements: SqlToken[][] } | string {
  const plain = plainText(bytes);
  if (typeof plain === 'string') return plain;
  let segs: Seg[];
  try {
    segs = tokenizeSql(plain.text);
  } catch (e) {
    if (e instanceof Unclassifiable) return e.message;
    throw e;
  }
  const statements: SqlToken[][] = [];
  let cur: SqlToken[] = [];
  const end = () => {
    if (cur.length > 0) statements.push(cur);
    cur = [];
  };
  for (const seg of segs) {
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
  return { statements };
}
