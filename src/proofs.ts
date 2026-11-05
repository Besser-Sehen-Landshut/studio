/**
 * Built-in proofs for exceptions by evidence: pure functions over the files of the base and the
 * head, no command runs. Each errs towards "not proven": what the tokenizer cannot classify for
 * sure proves nothing, so a change to code can never pass as a change to comments.
 *
 * `comments_only` reads SQL only, the case it exists for (migration guards). More languages come
 * later, each with an adversarial review of its own. It compares the code of a file with its plain
 * comments taken out and its whitespace collapsed; string literals and quoted identifiers stay
 * byte for byte, and comments with a meaning (directives, hints, executable comments) count as
 * code.
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
 * that counts as code, and nothing in the tokenizer reads that flag.
 */
type Seg = { kind: 'code' | 'string' | 'comment' | 'ws'; text: string; meaningful?: true };
/** Thrown for anything the tokenizer cannot classify for sure. */
class Unclassifiable extends Error {}
const no = (why: string): never => {
  throw new Unclassifiable(why);
};

const isWs = (c: string | undefined): boolean =>
  c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
const isIdent = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_$]/.test(c);

/**
 * Words that make a comment a directive to some tool (a migration runner, a query generator, a
 * linter). Matched case-insensitively anywhere in the comment: a prose comment that holds one
 * counts as code too, which errs the safe way.
 */
const DIRECTIVE =
  /goose|sqlx|flyway|liquibase|changeset|rollback|precondition|migrate|no-transaction|sqlc|sqlfluff|squawk|noqa|lint|ignore|disable|enable|pragma/i;

/** Whether a comment has a meaning beyond prose: then it counts as code. */
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
    if (j >= s.length) return no('an unterminated string');
    if (s[j] === quote) {
      if (s[j + 1] === quote) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
}

// SQL. Line comments `-- `, block comments (slash-star to star-slash), strings `'...'` with
// doubled quotes, quoted identifiers `"..."` and backtick ones, dollar quoting `$tag$...$tag$`.
// Not proven, because dialects read them differently or they run: `--` without a blank after it
// (MySQL reads two minus signs), a backslash in a string or outside one (escapes in MySQL and in
// `E'...'`), a block comment inside a block comment (PostgreSQL nests them, MySQL does not), a
// block comment whose opener is not followed by a blank or a star (the MySQL executable form
// with `!` runs, the `+` form is an optimizer hint), and anything unterminated.
function tokenizeSql(s: string): Seg[] {
  const out = new Out();
  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    if (isWs(c)) {
      out.push('ws', c);
      i++;
    } else if (s.startsWith('--', i)) {
      const next = s[i + 2];
      if (next !== undefined && !isWs(next)) no('-- without a blank after it');
      const end = s.indexOf('\n', i);
      const stop = end === -1 ? s.length : end;
      out.push('comment', s.slice(i, stop));
      i = stop;
    } else if (s.startsWith('/*', i)) {
      const end = s.indexOf('*/', i + 2);
      if (end === -1) no('an unterminated block comment');
      if (s.slice(i + 2, end).includes('/*')) no('a nested block comment');
      const first = s[i + 2];
      if (first !== '*' && !isWs(first)) no('a block comment that may be executable or a hint');
      out.push('comment', s.slice(i, end + 2));
      i = end + 2;
    } else if (c === "'") {
      const end = quoted(s, i, "'");
      const text = s.slice(i, end);
      if (text.includes('\\')) no('a backslash in a string');
      out.push('string', text);
      i = end;
    } else if (c === '"' || c === '`') {
      const end = quoted(s, i, c);
      out.push('string', s.slice(i, end));
      i = end;
    } else if (c === '$' && !isIdent(s[i - 1])) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i, i + 70));
      if (m === null) {
        out.push('code', c);
        i++;
        continue;
      }
      const end = s.indexOf(m[0], i + m[0].length);
      if (end === -1) no('an unterminated dollar quote');
      out.push('string', s.slice(i, end + m[0].length));
      i = end + m[0].length;
    } else if (c === '\\') {
      no('a backslash outside a string');
    } else {
      out.push('code', c);
      i++;
    }
  }
  return out.segs;
}

/** The code of a SQL file with plain comments out and whitespace collapsed; undefined when unsure. */
export function codeOf(text: string, _language: ProofLanguage): string | undefined {
  let segs: Seg[];
  try {
    segs = tokenizeSql(text);
  } catch (e) {
    if (e instanceof Unclassifiable) return undefined;
    throw e;
  }
  const parts: string[] = [];
  let gap = false;
  for (const seg of segs) {
    // A plain comment is a gap like whitespace; a meaningful one is compared like code.
    if (seg.kind === 'ws' || (seg.kind === 'comment' && seg.meaningful !== true)) {
      gap = true;
      continue;
    }
    if (gap && parts.length > 0) parts.push(' ');
    gap = false;
    parts.push(seg.text);
  }
  return parts.join('');
}

/** Whether two versions of a file differ in plain comments and whitespace only. */
export function commentsOnly(base: string, head: string, language: ProofLanguage): boolean {
  const a = codeOf(base, language);
  const b = codeOf(head, language);
  return a !== undefined && b !== undefined && a === b;
}

/**
 * Whether two versions of a text file differ only in whitespace that no language reads: line
 * endings, whitespace at the end of a line, and blank lines at the end of the file. Indentation
 * and blank lines inside a file can carry meaning (Python, YAML, string literals) and count.
 */
export function whitespaceOnly(base: string, head: string): boolean {
  const norm = (t: string) =>
    t
      .split(/\r?\n/)
      .map((l) => l.replace(/[ \t\r]+$/, ''))
      .join('\n')
      .replace(/\n+$/, '');
  return norm(base) === norm(head);
}
