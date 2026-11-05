/**
 * Built-in proofs for exceptions by evidence: pure functions over the files of the base and the
 * head, no command runs. Each errs towards "not proven": what a tokenizer cannot classify for sure
 * proves nothing, so a change to code can never pass as a change to comments.
 *
 * `comments_only` compares the code of each file with its comments taken out and its whitespace
 * normalized; string literals stay byte for byte. Whitespace normalization keeps what a language
 * gives meaning: a line break in JavaScript, TypeScript, Python, YAML, TOML and shell (and the
 * indentation after it in Python, YAML, TOML and shell); in SQL and Rust only that tokens are
 * separated. A comment that spans lines counts as a line break.
 */

export const PROOF_LANGUAGES = ['sql', 'rust', 'ts', 'js', 'sh', 'yaml', 'toml', 'python'] as const;
export type ProofLanguage = (typeof PROOF_LANGUAGES)[number];

const EXTENSIONS: Record<ProofLanguage, readonly string[]> = {
  sql: ['.sql'],
  rust: ['.rs'],
  ts: ['.ts', '.mts', '.cts'],
  js: ['.js', '.mjs', '.cjs'],
  sh: ['.sh', '.bash'],
  yaml: ['.yml', '.yaml'],
  toml: ['.toml'],
  python: ['.py'],
};

/** The language of a path by its extension, among `allowed`; undefined for any other file. */
export function languageOf(
  path: string,
  allowed: readonly ProofLanguage[],
): ProofLanguage | undefined {
  const lower = path.toLowerCase();
  return allowed.find((l) => EXTENSIONS[l].some((ext) => lower.endsWith(ext)));
}

type Seg = { kind: 'code' | 'string' | 'comment' | 'ws'; text: string };
/** Thrown for anything the tokenizer cannot classify for sure. */
class Unclassifiable extends Error {}
const no = (why: string): never => {
  throw new Unclassifiable(why);
};

const isWs = (c: string | undefined): boolean =>
  c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
const isIdent = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_$]/.test(c);

/** Collects segments, merging neighbours of the same kind. */
/**
 * Collects segments. Each comment is classified the moment it is read, on its own: one with a
 * meaning (`meaningful`) becomes code. Comments are never merged, so a plain comment cannot hide
 * a meaningful one right behind it; only whitespace and code runs are merged.
 */
class Out {
  segs: Seg[] = [];
  private line = 1;
  constructor(private readonly lang: ProofLanguage) {}
  push(kind: Seg['kind'], text: string): void {
    const own = kind === 'comment' && meaningful(text, this.lang, this.line) ? 'code' : kind;
    for (const ch of text) if (ch === '\n') this.line++;
    const last = this.segs.at(-1);
    if (last !== undefined && last.kind === own && (own === 'ws' || own === 'code')) {
      last.text += text;
    } else this.segs.push({ kind: own, text });
  }
}

/** A quoted run from `i` (at the opening quote) to its closing quote; returns the end index. */
function quoted(
  s: string,
  i: number,
  quote: string,
  o: { escapes: boolean; doubled?: boolean; multiline: boolean },
): number {
  let j = i + quote.length;
  for (;;) {
    if (j >= s.length) return no('an unterminated string');
    const c = s[j];
    if (o.escapes && c === '\\') {
      j += 2;
      continue;
    }
    if (s.startsWith(quote, j)) {
      if (o.doubled === true && s.startsWith(quote, j + quote.length)) {
        j += quote.length * 2;
        continue;
      }
      return j + quote.length;
    }
    if (!o.multiline && c === '\n') return no('a line break in a one-line string');
    j++;
  }
}

/** The previous character that is no whitespace, in what was read so far. */
function prevCode(out: Out): { char: string | undefined; word: string } {
  for (let k = out.segs.length - 1; k >= 0; k--) {
    const seg = out.segs[k] as Seg;
    if (seg.kind === 'ws' || seg.kind === 'comment') continue;
    if (seg.kind === 'string') return { char: '"', word: '' };
    const t = seg.text.replace(/\s+$/, '');
    if (t === '') continue;
    const word = /[A-Za-z0-9_$]+$/.exec(t)?.[0] ?? '';
    return { char: t.at(-1), word };
  }
  return { char: undefined, word: '' };
}

/** Keywords after which a `/` starts a regular expression in JavaScript. */
const REGEX_AFTER = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

function tokenizeJs(s: string, lang: ProofLanguage): Seg[] {
  const out = new Out(lang);
  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    if (isWs(c)) {
      out.push('ws', c);
      i++;
    } else if (s.startsWith('//', i)) {
      const end = s.indexOf('\n', i);
      const stop = end === -1 ? s.length : end;
      out.push('comment', s.slice(i, stop));
      i = stop;
    } else if (s.startsWith('/*', i)) {
      const end = s.indexOf('*/', i + 2);
      if (end === -1) no('an unterminated block comment');
      out.push('comment', s.slice(i, end + 2));
      i = end + 2;
    } else if (c === '"' || c === "'") {
      const end = quoted(s, i, c, { escapes: true, multiline: false });
      out.push('string', s.slice(i, end));
      i = end;
    } else if (c === '`') {
      const end = quoted(s, i, '`', { escapes: true, multiline: true });
      const text = s.slice(i, end);
      // A substitution can hold code, strings and comments of its own.
      if (text.includes('${')) no('a template literal with a substitution');
      out.push('string', text);
      i = end;
    } else if (c === '/') {
      // A lone slash: division only where a regular expression cannot start.
      const prev = prevCode(out);
      const division =
        prev.char !== undefined &&
        (isIdent(prev.char) || prev.char === ']') &&
        !REGEX_AFTER.has(prev.word);
      if (!division) no('a slash that may start a regular expression');
      out.push('code', c);
      i++;
    } else if (c === '\\') {
      no('a backslash outside a string');
    } else {
      out.push('code', c);
      i++;
    }
  }
  return out.segs;
}

function tokenizeRust(s: string, lang: ProofLanguage): Seg[] {
  const out = new Out(lang);
  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    if (isWs(c)) {
      out.push('ws', c);
      i++;
    } else if (s.startsWith('//', i)) {
      const end = s.indexOf('\n', i);
      const stop = end === -1 ? s.length : end;
      out.push('comment', s.slice(i, stop));
      i = stop;
    } else if (s.startsWith('/*', i)) {
      // Rust block comments nest.
      let depth = 0;
      let j = i;
      for (;;) {
        if (j >= s.length) no('an unterminated block comment');
        if (s.startsWith('/*', j)) {
          depth++;
          j += 2;
        } else if (s.startsWith('*/', j)) {
          depth--;
          j += 2;
          if (depth === 0) break;
        } else j++;
      }
      out.push('comment', s.slice(i, j));
      i = j;
    } else if (/^(?:b|c)?r#*"/.test(s.slice(i, i + 260)) && !isIdent(s[i - 1])) {
      const m = /^((?:b|c)?r)(#*)"/.exec(s.slice(i, i + 260)) as RegExpExecArray;
      const close = `"${m[2]}`;
      const end = s.indexOf(close, i + m[0].length);
      if (end === -1) no('an unterminated raw string');
      out.push('string', s.slice(i, end + close.length));
      i = end + close.length;
    } else if (c === '"' || ((c === 'b' || c === 'c') && s[i + 1] === '"' && !isIdent(s[i - 1]))) {
      const start = c === '"' ? i : i + 1;
      const end = quoted(s, start, '"', { escapes: true, multiline: true });
      out.push('string', s.slice(i, end));
      i = end;
    } else if (c === "'") {
      // A char literal, or a lifetime: only the exact char forms count as a literal.
      const m = /^'(?:\\(?:u\{[0-9A-Fa-f]{1,6}\}|x[0-9A-Fa-f]{2}|.)|[^\\'\n])'/u.exec(
        s.slice(i, i + 16),
      );
      if (m !== null) {
        out.push('string', m[0]);
        i += m[0].length;
      } else if (/^'[A-Za-z_]/.test(s.slice(i, i + 2))) {
        out.push('code', c);
        i++;
      } else no('a quote that is neither a char literal nor a lifetime');
    } else {
      out.push('code', c);
      i++;
    }
  }
  return out.segs;
}

function tokenizeSql(s: string, lang: ProofLanguage): Seg[] {
  const out = new Out(lang);
  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    if (isWs(c)) {
      out.push('ws', c);
      i++;
    } else if (s.startsWith('--', i)) {
      // MySQL reads `--x` as two minus signs: only `-- ` is a comment in every dialect.
      const next = s[i + 2];
      if (next !== undefined && !isWs(next)) no('-- without a space after it');
      const end = s.indexOf('\n', i);
      const stop = end === -1 ? s.length : end;
      out.push('comment', s.slice(i, stop));
      i = stop;
    } else if (s.startsWith('/*', i)) {
      const end = s.indexOf('*/', i + 2);
      if (end === -1) no('an unterminated block comment');
      // PostgreSQL nests block comments, MySQL does not: an inner opener is ambiguous.
      if (s.slice(i + 2, end).includes('/*')) no('a nested block comment');
      // `/*!...*/` runs in MySQL, `/*+...*/` is an optimizer hint: only `/*` followed by a blank
      // or `*` is a plain comment.
      const first = s[i + 2];
      if (first !== '*' && !isWs(first)) no('a block comment that may be executable or a hint');
      out.push('comment', s.slice(i, end + 2));
      i = end + 2;
    } else if (c === "'") {
      const end = quoted(s, i, "'", { escapes: false, doubled: true, multiline: true });
      const text = s.slice(i, end);
      // MySQL reads a backslash as an escape, standard SQL does not.
      if (text.includes('\\')) no('a backslash in a string');
      out.push('string', text);
      i = end;
    } else if (c === '"' || c === '`') {
      const end = quoted(s, i, c, { escapes: false, doubled: true, multiline: true });
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

/** Python: `#` comments; strings with any prefix but f, single or triple quoted. */
function tokenizePython(s: string, lang: ProofLanguage): Seg[] {
  const out = new Out(lang);
  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    if (isWs(c)) {
      out.push('ws', c);
      i++;
    } else if (c === '#') {
      const end = s.indexOf('\n', i);
      const stop = end === -1 ? s.length : end;
      out.push('comment', s.slice(i, stop));
      i = stop;
    } else if (
      c === '"' ||
      c === "'" ||
      (/^[A-Za-z]{1,2}["']/.test(s.slice(i, i + 3)) && !isIdent(s[i - 1]))
    ) {
      const prefix = /^[A-Za-z]{0,2}/.exec(s.slice(i, i + 2))?.[0] ?? '';
      const at = i + (c === '"' || c === "'" ? 0 : prefix.length);
      const pre = s.slice(i, at).toLowerCase();
      if (!/^(?:|r|u|b|br|rb)$/.test(pre)) no('an f-string or an unknown string prefix');
      const q = s[at] as string;
      const triple = s.startsWith(q.repeat(3), at);
      const end = quoted(s, at, triple ? q.repeat(3) : q, { escapes: true, multiline: triple });
      out.push('string', s.slice(i, end));
      i = end;
    } else {
      out.push('code', c);
      i++;
    }
  }
  return out.segs;
}

/** TOML: `#` comments; basic, literal and multi-line strings. */
function tokenizeToml(s: string, lang: ProofLanguage): Seg[] {
  const out = new Out(lang);
  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    if (isWs(c)) {
      out.push('ws', c);
      i++;
    } else if (c === '#') {
      const end = s.indexOf('\n', i);
      const stop = end === -1 ? s.length : end;
      out.push('comment', s.slice(i, stop));
      i = stop;
    } else if (c === '"' || c === "'") {
      const triple = s.startsWith(c.repeat(3), i);
      const end = quoted(s, i, triple ? c.repeat(3) : c, {
        escapes: c === '"',
        multiline: triple,
      });
      out.push('string', s.slice(i, end));
      i = end;
    } else {
      out.push('code', c);
      i++;
    }
  }
  return out.segs;
}

/** YAML: `#` after whitespace or at a line start; quotes only where a scalar starts. */
function tokenizeYaml(s: string, lang: ProofLanguage): Seg[] {
  const out = new Out(lang);
  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    const before = s[i - 1];
    // A quote opens a scalar only where one starts: at a line start or after an indicator, with
    // blanks between at most. Inside a plain scalar (`say "hi"`) it is a character.
    let k = i - 1;
    while (s[k] === ' ' || s[k] === '\t') k--;
    const atToken = k < 0 || s[k] === '\n' || ':-[{,?'.includes(s[k] as string);
    if (isWs(c)) {
      out.push('ws', c);
      i++;
    } else if (c === '#' && (before === undefined || isWs(before))) {
      const end = s.indexOf('\n', i);
      const stop = end === -1 ? s.length : end;
      out.push('comment', s.slice(i, stop));
      i = stop;
    } else if ((c === '"' || c === "'") && atToken) {
      const end = quoted(s, i, c, {
        escapes: c === '"',
        doubled: c === "'",
        multiline: true,
      });
      out.push('string', s.slice(i, end));
      i = end;
    } else if (c === '|' || c === '>') {
      // A block scalar holds `#` lines as content; a plain `>` is too close to call.
      no('a block scalar indicator');
    } else {
      out.push('code', c);
      i++;
    }
  }
  return out.segs;
}

/** Shell: `#` at the start of a word; quotes; no here-documents, no `$'...'`. */
function tokenizeSh(s: string, lang: ProofLanguage): Seg[] {
  const out = new Out(lang);
  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    const before = s[i - 1];
    if (isWs(c)) {
      out.push('ws', c);
      i++;
    } else if (c === '#' && (before === undefined || isWs(before) || ';|&()'.includes(before))) {
      const end = s.indexOf('\n', i);
      const stop = end === -1 ? s.length : end;
      out.push('comment', s.slice(i, stop));
      i = stop;
    } else if (c === "'") {
      if (before === '$') no("an ANSI-C $'...' string");
      const end = s.indexOf("'", i + 1);
      if (end === -1) no('an unterminated string');
      out.push('string', s.slice(i, end + 1));
      i = end + 1;
    } else if (c === '"') {
      const end = quoted(s, i, '"', { escapes: true, multiline: true });
      out.push('string', s.slice(i, end));
      i = end;
    } else if (c === '\\') {
      const next = s[i + 1];
      // An escaped space or tab joins words, so a `#` after it is no comment.
      if (next === ' ' || next === '\t' || next === undefined) no('an escaped blank');
      out.push('code', s.slice(i, i + 2));
      i += 2;
    } else if (s.startsWith('<<', i)) {
      no('a here-document');
    } else {
      out.push('code', c);
      i++;
    }
  }
  return out.segs;
}

const TOKENIZERS: Record<ProofLanguage, (s: string, lang: ProofLanguage) => Seg[]> = {
  sql: tokenizeSql,
  rust: tokenizeRust,
  ts: tokenizeJs,
  js: tokenizeJs,
  sh: tokenizeSh,
  yaml: tokenizeYaml,
  toml: tokenizeToml,
  python: tokenizePython,
};

/** How much of whitespace keeps its meaning in a language. */
const BREAKS: Record<ProofLanguage, 'none' | 'line' | 'indent'> = {
  sql: 'none',
  rust: 'none',
  ts: 'line',
  js: 'line',
  sh: 'indent',
  yaml: 'indent',
  toml: 'indent',
  python: 'indent',
};

/**
 * Words that make a comment a directive to some tool: a type checker, a linter, a formatter, a
 * bundler, a schema, a migration runner. Such a comment counts as code, so adding, removing or
 * changing one is never "comments only". Matched case-insensitively anywhere in the comment: a
 * prose comment that holds one of them counts as code too, which errs the safe way.
 */
const DIRECTIVE =
  /@ts-|<reference|sourcemappingurl|sourceurl|@jsx|eslint|biome|prettier|jshint|jscs|istanbul|\bc8\b|v8 ignore|@flow|@license|@preserve|__pure__|__no_side_effects__|webpack|vite-ignore|shellcheck|yaml-language-server|yamllint|\$schema|#:schema|taplo|tombi|renovate|noqa|nosec|pragma|pylint|mypy|pyright|ruff|isort|type:\s*ignore|\btype:|fmt:|pyre-|flake8|yapf|coverage|codespell|cspell|spell-checker|trunk-ignore|checkov|semgrep|tfsec|kics|hadolint|gitleaks|lint|ignore|disable|enable|no-transaction|goose|sqlx|flyway|liquibase|changeset|rollback|precondition|migrate/i;

/** Line comments whose form gives them meaning in a language, whatever their words. */
function meaningful(t: string, language: ProofLanguage, line: number): boolean {
  if (DIRECTIVE.test(t)) return true;
  // An interpreter line: line 1, `#!`.
  if (line === 1 && t.startsWith('#!')) return true;
  switch (language) {
    case 'python':
      // PEP 263: a coding declaration in line 1 or 2 decides how the file is read.
      return line <= 2 && /coding[:=]/.test(t);
    case 'js':
    case 'ts':
      // JSDoc tags type JavaScript under checkJs, `//#`, `//@` and `///` are pragmas.
      return /@[A-Za-z_]/.test(t) || /^\/\/[#@/]/.test(t);
    case 'rust':
      // Doc comments are docs, and their code blocks run as doctests.
      return /^\/\/[/!]/.test(t) || /^\/\*[*!]/.test(t);
    case 'sql':
      // `-- +goose Up`, `--+ INDEX(...)` (an Oracle hint), `-- name: ...` (sqlc) and the like.
      return /^--\s*(?:[+!@$#:%]|[A-Za-z_-]+\s*:)/.test(t);
    default:
      return false;
  }
}

/** The code of a file with comments out and whitespace normalized; undefined when unsure. */
export function codeOf(text: string, language: ProofLanguage): string | undefined {
  let segs: Seg[];
  try {
    segs = TOKENIZERS[language](text, language);
  } catch (e) {
    if (e instanceof Unclassifiable) return undefined;
    throw e;
  }
  const mode = BREAKS[language];
  const parts: string[] = [];
  let gap: string | undefined;
  const flush = () => {
    if (gap === undefined) return;
    if (mode !== 'none' && gap.includes('\n')) {
      const indent = mode === 'indent' ? (/[ \t]*$/.exec(gap)?.[0] ?? '') : '';
      parts.push(`\n${indent}`);
    } else parts.push(' ');
    gap = undefined;
  };
  for (const seg of segs) {
    if (seg.kind === 'ws') gap = (gap ?? '') + seg.text;
    // A comment is a gap; one that spans lines is a line break.
    else if (seg.kind === 'comment') gap = (gap ?? '') + (seg.text.includes('\n') ? '\n' : ' ');
    else {
      flush();
      parts.push(seg.text);
    }
  }
  return parts.join('').trim();
}

/** Whether two versions of a file differ in comments and whitespace only. */
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
