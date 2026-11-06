/**
 * Comment tokenizers of `comments_only` for languages other than SQL: Rust, TypeScript and
 * JavaScript (with JSX), shell, Python, YAML and TOML. Each reads only what it can classify for
 * sure and throws `Unclassifiable` for anything else: a proof errs towards "not proven".
 *
 * What each must get right is where a comment marker is not a comment: inside a string, a raw
 * string, a template, a regular expression, a here-document, a block scalar, a JSX text. Every
 * construct whose extent depends on context the tokenizer does not track (a `/` after `)` of an
 * `if`, a `case` inside `$(...)`, a quote inside an f-string field) is refused instead of guessed,
 * because a guess in either direction can hide code in what looks like a comment. Every loop moves
 * forward and nesting is capped, so the work is linear in the length of the file.
 */
import { no, Out, type Seg } from './proof-tokens.js';

/** How deep templates, JSX, `$(...)` and the like may nest before the tokenizer gives up. */
const MAX_DEPTH = 200;

const isAsciiIdentStart = (c: string | undefined): boolean =>
  c !== undefined && /[A-Za-z_]/.test(c);
const isAsciiIdent = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_]/.test(c);
const nonAscii = (c: string): boolean => c.charCodeAt(0) > 0x7f;

/**
 * Words that make a comment a directive to some tool (a linter, a formatter, a bundler, a type
 * checker, a dependency bot, a schema). Matched case-insensitively anywhere in the comment: a prose
 * comment that holds one counts as meaningful too, which errs the safe way.
 */
const TOOL_WORDS =
  /noqa|lint|ignore|disable|enable|pragma|nosec|generated|codegen|prettier|biome|eslint|istanbul|\bc8\b|coverage|shellcheck|clippy|rustfmt|safety|renovate|dependabot|schema|yaml-language-server|zizmor|release-please|checkov|tfsec|trivy|codespell|cspell|gitleaks|secret|taplo|mypy|pyright|pyre|pylint|ruff|isort|fmt:|type:|coding|vim:|tidy|sourcemappingurl|sourceurl|webpack|vite|jsx|ts-|deno|\$flow|noinspection|spdx|__pure__|__no_side_effects__/i;

/**
 * A `#` comment with a meaning: a tool word, or a `key:` or sigil right after the `#` (`# type:
 * ignore`, `# yaml-language-server: ...`, `#:schema`, `# -*- coding ...`). A prose comment that
 * starts with a word and a colon counts too, which errs the safe way.
 */
function hashMeaningful(t: string): boolean {
  return TOOL_WORDS.test(t) || /^#\s*(?:[!+@$:%-]|[A-Za-z_-]+\s*:)/.test(t);
}

/**
 * A JavaScript or TypeScript comment with a meaning: a tool word, any `@tag` (JSDoc types are read
 * by `checkJs`, `@internal` changes declaration output, `@jsx` and `@vitest-environment` are
 * pragmas), a triple-slash directive, `//#`, `//@`, `/*!` (kept in bundles), `#__PURE__`.
 */
function jsMeaningful(t: string): boolean {
  return (
    TOOL_WORDS.test(t) ||
    /@[A-Za-z]/.test(t) ||
    /^\/\/[/!#@$:+]/.test(t) ||
    /^\/\*[!#@]/.test(t) ||
    /^\/\*\s*(?:global|exported)\b/.test(t) ||
    /#__/.test(t)
  );
}

/**
 * A Rust comment with a meaning. Every doc comment (`///`, `//!`, `/**`, `/*!`) is one: it is a
 * `#[doc]` attribute, a code block in it runs as a doctest, and derive macros put its text into the
 * program (clap help, schema and OpenAPI descriptions). So only `//` and `/* *\/` prose is plain.
 */
function rustMeaningful(t: string): boolean {
  return TOOL_WORDS.test(t) || /^\/\/[/!]/.test(t) || /^\/\*[*!]/.test(t);
}

// --- Rust -----------------------------------------------------------------------------------

/**
 * Rust as rustc lexes it: line comments, nested block comments, strings with escapes over lines,
 * byte and C strings, raw strings with up to 255 `#`, char and byte literals told from lifetimes
 * and labels, raw identifiers, a shebang line. Not proven: a backslash or a non-ASCII character in
 * code, a name glued to a quote or `#` that is no literal prefix, anything unterminated, and any use
 * of `line!` or `column!` (a moved line changes their value).
 */
export function tokenizeRust(s: string): Seg[] {
  const out = new Out(rustMeaningful);
  let i = 0;
  if (s.startsWith('#!') && !/^#!\s*\[/.test(s)) {
    const end = s.indexOf('\n');
    i = end === -1 ? s.length : end;
    out.push('code', s.slice(0, i));
  }
  const escaped = (from: number, quote: string): number => {
    let j = from;
    for (;;) {
      const c = s[j];
      if (c === undefined) return no('an unterminated string');
      if (c === '\\') j += 2;
      else if (c === quote) return j + 1;
      else j++;
    }
  };
  const raw = (at: number): number => {
    // at: the first `#` or the `"`
    let j = at;
    while (s[j] === '#') j++;
    const hashes = j - at;
    if (hashes > 255) no('a raw string with too many #');
    if (s[j] !== '"') return no('a # that is no raw string');
    const close = `"${'#'.repeat(hashes)}`;
    const end = s.indexOf(close, j + 1);
    if (end === -1) no('an unterminated raw string');
    return end + close.length;
  };
  const charLit = (at: number): number => {
    // at: the opening quote of a char or byte literal
    if (s[at + 1] === '\\') {
      if (s[at + 2] === "'") {
        if (s[at + 3] !== "'") no('a char literal that cannot be read');
        return at + 4;
      }
      const end = s.indexOf("'", at + 2);
      if (end === -1 || end - at > 12 || s.slice(at, end).includes('\n')) {
        no('a char literal that cannot be read');
      }
      return end + 1;
    }
    const cp = s.codePointAt(at + 1);
    if (cp === undefined) return no('an unterminated char literal');
    const len = cp > 0xffff ? 2 : 1;
    if (s[at + 1 + len] !== "'" || s[at + 1] === "'" || s[at + 1] === '\n') {
      return no('a char literal that cannot be read');
    }
    return at + 2 + len;
  };
  while (i < s.length) {
    const c = s[i] as string;
    if (c === ' ' || c === '\t' || c === '\n') {
      out.push('ws', c);
      i++;
    } else if (s.startsWith('//', i)) {
      const end = s.indexOf('\n', i);
      const stop = end === -1 ? s.length : end;
      out.push('comment', s.slice(i, stop), { eol: true });
      i = stop;
    } else if (s.startsWith('/*', i)) {
      let depth = 1;
      let j = i + 2;
      while (depth > 0) {
        if (j >= s.length) no('an unterminated block comment');
        if (s.startsWith('/*', j)) {
          depth++;
          j += 2;
        } else if (s.startsWith('*/', j)) {
          depth--;
          j += 2;
        } else j++;
      }
      out.push('comment', s.slice(i, j));
      i = j;
    } else if (c === '"') {
      const end = escaped(i + 1, '"');
      out.push('string', s.slice(i, end));
      i = end;
    } else if (c === "'") {
      const next = s[i + 1];
      const astral = (s.codePointAt(i + 1) ?? 0) > 0xffff;
      if (next === '\\' || s[i + 2] === "'" || (astral && s[i + 3] === "'")) {
        const end = charLit(i);
        out.push('string', s.slice(i, end));
        i = end;
      } else if (isAsciiIdentStart(next)) {
        let j = i + 1;
        while (isAsciiIdent(s[j])) j++;
        if (s[j] === "'") no('a lifetime glued to a quote');
        out.push('code', s.slice(i, j));
        i = j;
      } else no('a quote that is neither a char literal nor a lifetime');
    } else if (isAsciiIdentStart(c)) {
      let j = i;
      while (isAsciiIdent(s[j])) j++;
      const word = s.slice(i, j);
      const after = s[j];
      if (after === '"' && (word === 'b' || word === 'c')) {
        const end = escaped(j + 1, '"');
        out.push('string', s.slice(i, end));
        i = end;
      } else if ((after === '"' || after === '#') && ['r', 'br', 'cr'].includes(word)) {
        if (after === '#' && word === 'r' && isAsciiIdentStart(s[j + 1])) {
          // a raw identifier: r#type
          let k = j + 1;
          while (isAsciiIdent(s[k])) k++;
          out.push('code', s.slice(i, k));
          i = k;
        } else {
          const end = raw(j);
          out.push('string', s.slice(i, end));
          i = end;
        }
      } else if (after === "'" && word === 'b') {
        const end = charLit(j);
        out.push('string', s.slice(i, end));
        i = end;
      } else if (after === '"' || after === "'" || after === '#') {
        no('a name glued to a quote or #');
      } else {
        out.push('code', word);
        i = j;
      }
    } else if (c === '\\') {
      no('a backslash in code');
    } else if (nonAscii(c)) {
      no('a character that is not ASCII in code');
    } else {
      out.push('code', c);
      i++;
    }
  }
  const code = out.segs
    .filter((x) => x.kind === 'code')
    .map((x) => x.text)
    .join(' ');
  if (/\b(?:line|column)\s*!/.test(code)) no('line! or column!, whose value a moved line changes');
  return out.segs;
}

// --- TypeScript and JavaScript ----------------------------------------------------------------

/** Words after which a `/` starts a regular expression and a `<` a JSX element. */
const EXPR_WORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'default',
  'extends',
]);
/** Words that are a keyword or a name depending on context: a `/` or `<` after them is refused. */
const AMBIGUOUS_WORDS = new Set([
  'yield',
  'await',
  'of',
  'let',
  'static',
  'get',
  'set',
  'async',
  'as',
  'satisfies',
  'from',
  'type',
  'keyof',
  'readonly',
  'infer',
  'is',
  'asserts',
  'declare',
  'module',
  'namespace',
  'abstract',
  'accessor',
  'override',
  'unique',
  'out',
]);
/** Words whose parenthesized head may be followed by a statement, so a `/` or `<` after `)` is refused. */
const CONTROL_WORDS = new Set(['if', 'while', 'for', 'with']);

/**
 * What came before, for `/` (division or regular expression) and `<` (operator or JSX):
 * `value` an operand, `expr` an operator or the start, `unsure` anything that may be either.
 */
type Prev = 'value' | 'expr' | 'unsure';

/**
 * TypeScript and JavaScript as an ECMAScript lexer reads them, with JSX unless the file is plain
 * TypeScript (`.ts`, `.mts`, `.cts`). Strings with escapes, template literals with nested
 * `${...}`, regular expressions with classes, JSX elements with text, attributes and `{...}`
 * children, a hashbang line. A `/` is a regular expression after an operator or at the start, a
 * division after an operand; after `)` of `if`/`while`/`for`/`with`, after `}`, after `++`/`--`, a
 * postfix `!`, or a contextual word it is refused, and so is a `<` that might start JSX there.
 * Not proven: a backslash or non-ASCII character in code, `<!--` and `-->` (comments in scripts),
 * and anything unterminated or unbalanced.
 */
export function tokenizeJs(s: string, jsx: boolean): Seg[] {
  const out = new Out(jsMeaningful);
  let i = 0;
  let depth = 0;
  const deeper = () => {
    if (++depth > MAX_DEPTH) no('nesting too deep');
  };
  if (s.startsWith('#!')) {
    const end = s.indexOf('\n');
    i = end === -1 ? s.length : end;
    out.push('code', s.slice(0, i));
  }

  /** A string from the quote at `i`; escapes, no raw line break. */
  const str = (): void => {
    const q = s[i] as string;
    let j = i + 1;
    for (;;) {
      const c = s[j];
      if (c === undefined || c === '\n') no('an unterminated string');
      if (c === '\\') j += 2;
      else if (c === q) break;
      else j++;
    }
    out.push('string', s.slice(i, j + 1));
    i = j + 1;
  };

  /** A regular expression from the `/` at `i`, with its flags. */
  const regex = (): void => {
    let j = i + 1;
    let cls = false;
    for (;;) {
      const c = s[j];
      if (c === undefined || c === '\n') no('an unterminated regular expression');
      if (c === '\\') {
        if (s[j + 1] === '\n' || s[j + 1] === undefined) no('an unterminated regular expression');
        j += 2;
        continue;
      }
      if (c === '[') cls = true;
      else if (c === ']') cls = false;
      else if (c === '/' && !cls) break;
      j++;
    }
    out.push('string', s.slice(i, j + 1));
    i = j + 1;
    let k = i;
    while (/[A-Za-z]/.test(s[k] ?? '')) k++;
    out.push('code', s.slice(i, k));
    i = k;
  };

  /** A template literal from the backtick at `i`, its `${...}` parts read as code. */
  const template = (): void => {
    deeper();
    let start = i;
    let j = i + 1;
    for (;;) {
      const c = s[j];
      if (c === undefined) no('an unterminated template literal');
      if (c === '\\') {
        j += 2;
      } else if (c === '`') {
        out.push('string', s.slice(start, j + 1));
        i = j + 1;
        break;
      } else if (c === '$' && s[j + 1] === '{') {
        out.push('string', s.slice(start, j + 2));
        i = j + 2;
        code('}');
        // i is at the closing brace, which opens the next text part
        start = i;
        j = i + 1;
      } else j++;
    }
    depth--;
  };

  /** `{...}` inside JSX, from the brace at `i` to after its closing brace. */
  const jsxExpr = (): void => {
    out.push('code', '{');
    i++;
    code('}');
    out.push('code', '}');
    i++;
  };

  const jsxName = (): string => {
    const m = /^[A-Za-z_$][A-Za-z0-9_$.:-]*/.exec(s.slice(i, i + 256));
    if (m === null) return no('a JSX name that cannot be read');
    out.push('code', m[0]);
    i += m[0].length;
    return m[0];
  };

  const jsxSpace = (): void => {
    while (s[i] === ' ' || s[i] === '\t' || s[i] === '\n') {
      out.push('ws', s[i] as string);
      i++;
    }
  };

  /** A JSX element or fragment from the `<` at `i`. */
  const element = (): void => {
    deeper();
    out.push('code', '<');
    i++;
    let name = '';
    if (s[i] !== '>') {
      name = jsxName();
      for (;;) {
        jsxSpace();
        const c = s[i];
        if (c === undefined) no('an unterminated JSX tag');
        if (s.startsWith('/>', i)) {
          out.push('code', '/>');
          i += 2;
          depth--;
          return;
        }
        if (c === '>') break;
        if (c === '{') {
          jsxExpr();
          continue;
        }
        jsxName();
        jsxSpace();
        if (s[i] !== '=') continue;
        out.push('code', '=');
        i++;
        jsxSpace();
        const v = s[i];
        if (v === '"' || v === "'") {
          const end = s.indexOf(v, i + 1);
          if (end === -1) no('an unterminated JSX attribute');
          out.push('string', s.slice(i, end + 1));
          i = end + 1;
        } else if (v === '{') jsxExpr();
        else if (v === '<') element();
        else no('a JSX attribute value that cannot be read');
      }
    }
    out.push('code', '>');
    i++;
    // children: text, {...}, elements, up to the closing tag
    let start = i;
    for (;;) {
      const c = s[i];
      if (c === undefined) no('an unterminated JSX element');
      if (c === '{' || c === '<') {
        out.push('string', s.slice(start, i));
        if (c === '{') jsxExpr();
        else if (s[i + 1] === '/') {
          out.push('code', '</');
          i += 2;
          jsxSpace();
          const closing = s[i] === '>' ? '' : jsxName();
          jsxSpace();
          if (closing !== name || s[i] !== '>') no('a JSX closing tag that does not match');
          out.push('code', '>');
          i++;
          depth--;
          return;
        } else element();
        start = i;
      } else if (c === '}' || c === '>') {
        no('a } or > in JSX text');
      } else i++;
    }
  };

  /**
   * Code up to the end, or (`until` = '}') up to an unmatched closing brace, where it stops
   * without consuming it.
   */
  const code = (until: 'eof' | '}'): void => {
    deeper();
    let prev: Prev = 'expr';
    let braces = 0;
    const parens: boolean[] = [];
    let control = false;
    let dot = false;
    while (i < s.length) {
      const c = s[i] as string;
      if (c === ' ' || c === '\t' || c === '\n') {
        out.push('ws', c);
        i++;
        continue;
      }
      if (s.startsWith('//', i)) {
        const end = s.indexOf('\n', i);
        const stop = end === -1 ? s.length : end;
        out.push('comment', s.slice(i, stop), { eol: true });
        i = stop;
        continue;
      }
      if (s.startsWith('/*', i)) {
        const end = s.indexOf('*/', i + 2);
        if (end === -1) no('an unterminated block comment');
        out.push('comment', s.slice(i, end + 2));
        i = end + 2;
        continue;
      }
      if (s.startsWith('<!--', i) || s.startsWith('-->', i)) no('<!-- or -->');
      const wasControl = control;
      const wasDot = dot;
      control = false;
      dot = false;
      if (c === '/') {
        if (prev === 'value') {
          out.push('code', c);
          i++;
          prev = 'expr';
        } else if (prev === 'expr') {
          regex();
          prev = 'value';
        } else no('a / that may start a regular expression');
      } else if (
        c === '<' &&
        jsx &&
        (isAsciiIdentStart(s[i + 1]) || s[i + 1] === '>' || s[i + 1] === '$')
      ) {
        if (prev === 'expr') {
          element();
          prev = 'value';
        } else if (prev === 'value') {
          out.push('code', c);
          i++;
          prev = 'expr';
        } else no('a < that may start JSX');
      } else if (c === '"' || c === "'") {
        str();
        prev = 'value';
      } else if (c === '`') {
        template();
        // template() leaves i after the closing backtick
        prev = 'value';
      } else if (isAsciiIdentStart(c) || c === '$' || c === '#') {
        let j = i + 1;
        while (isAsciiIdent(s[j]) || s[j] === '$') j++;
        const word = s.slice(i, j);
        out.push('code', word);
        i = j;
        if (wasDot) prev = 'value';
        else if (EXPR_WORDS.has(word)) prev = 'expr';
        else if (AMBIGUOUS_WORDS.has(word)) prev = 'unsure';
        else if (CONTROL_WORDS.has(word)) {
          prev = 'expr';
          control = true;
        } else prev = 'value';
        if (word === 'await' && wasControl) control = true;
      } else if (/[0-9]/.test(c)) {
        let j = i + 1;
        while (/[0-9A-Za-z_]/.test(s[j] ?? '') || (s[j] === '.' && /[0-9]/.test(s[j + 1] ?? '')))
          j++;
        out.push('code', s.slice(i, j));
        i = j;
        prev = 'value';
      } else if (c === '(') {
        parens.push(wasControl);
        out.push('code', c);
        i++;
        prev = 'expr';
      } else if (c === ')') {
        const head = parens.pop();
        if (head === undefined) no('an unbalanced )');
        out.push('code', c);
        i++;
        prev = head ? 'unsure' : 'value';
      } else if (c === '[') {
        out.push('code', c);
        i++;
        prev = 'expr';
      } else if (c === ']') {
        out.push('code', c);
        i++;
        prev = 'value';
      } else if (c === '{') {
        braces++;
        out.push('code', c);
        i++;
        prev = 'expr';
      } else if (c === '}') {
        if (braces === 0) {
          if (until !== '}') no('an unbalanced }');
          if (parens.length > 0) no('an unbalanced (');
          depth--;
          return;
        }
        braces--;
        out.push('code', c);
        i++;
        prev = 'unsure';
      } else if ((c === '+' || c === '-') && s[i + 1] === c) {
        out.push('code', s.slice(i, i + 2));
        i += 2;
        prev = 'unsure';
      } else if (c === '!' && prev === 'value' && s[i + 1] !== '=') {
        // a postfix non-null assertion, or a prefix not after a line break: refused before / or <
        out.push('code', c);
        i++;
        prev = 'unsure';
      } else if (c === '.' && s.startsWith('...', i)) {
        out.push('code', '...');
        i += 3;
        prev = 'expr';
      } else if (c === '.') {
        out.push('code', c);
        i++;
        prev = 'expr';
        dot = true;
      } else if (c === '?' && s[i + 1] === '.' && !/[0-9]/.test(s[i + 2] ?? '')) {
        out.push('code', '?.');
        i += 2;
        prev = 'expr';
        dot = true;
      } else if (c === '\\') {
        no('a backslash in code');
      } else if (nonAscii(c)) {
        no('a character that is not ASCII in code');
      } else {
        out.push('code', c);
        i++;
        prev = 'expr';
      }
    }
    if (until === '}') no('an unterminated template part or JSX expression');
    if (parens.length > 0 || braces > 0) no('an unbalanced ( or {');
    depth--;
  };

  code('eof');
  return out.segs;
}

// --- Shell ------------------------------------------------------------------------------------

/**
 * POSIX shell and bash as bash reads them: a `#` starts a comment only at the start of a word,
 * `'...'` holds everything, `"..."` and `$'...'` take escapes, `$(...)` and `${...}` nest (also in
 * double quotes), a backslash escapes one character and a backslash-newline joins lines,
 * here-documents (`<<`, `<<-`, quoted or not) are content up to their delimiter line, and the first
 * line's `#!` must stay. Not proven: backticks, `case` inside `$(...)`, a here-document delimiter
 * that is not a plain word, a line break inside a quote while a here-document waits, anything
 * unterminated, and a script that reads itself (`$0`, `BASH_SOURCE`): its comments may be its help.
 */
export function tokenizeShell(s: string): Seg[] {
  const out = new Out(hashMeaningful);
  let i = 0;
  let depth = 0;
  /** At the start of a word: a `#` here starts a comment. */
  let word = true;
  let pending: { delim: string; tabs: boolean }[] = [];
  const deeper = () => {
    if (++depth > MAX_DEPTH) no('nesting too deep');
  };
  if (s.startsWith('#!')) {
    const end = s.indexOf('\n');
    i = end === -1 ? s.length : end;
    out.push('comment', s.slice(0, i), { eol: true, meaningful: true });
  }
  const noBreakWhilePending = (text: string) => {
    if (pending.length > 0 && text.includes('\n')) {
      no('a line break inside a quote while a here-document waits');
    }
  };

  /**
   * The bodies of the waiting here-documents, one after the other, from `i` at the start of the
   * line after the one that named them. Each body, with its delimiter line, is content; `i` ends
   * at the line feed after the last delimiter line, or at the end.
   */
  const bodies = (): void => {
    const list = pending;
    pending = [];
    for (const [k, h] of list.entries()) {
      if (k > 0) {
        if (s[i] !== '\n') no('an unterminated here-document');
        out.push('ws', '\n');
        i++;
      }
      let p = i;
      for (;;) {
        if (p >= s.length) no('an unterminated here-document');
        const nl = s.indexOf('\n', p);
        const end = nl === -1 ? s.length : nl;
        const line = s.slice(p, end);
        if ((h.tabs ? line.replace(/^\t+/, '') : line) === h.delim) {
          out.push('string', s.slice(i, end));
          i = end;
          break;
        }
        if (nl === -1) no('an unterminated here-document');
        p = nl + 1;
      }
    }
  };

  const heredoc = (): void => {
    let j = i + 2;
    let tabs = false;
    if (s[j] === '-') {
      tabs = true;
      j++;
    }
    while (s[j] === ' ' || s[j] === '\t') j++;
    let delim: string;
    let end: number;
    const q = s[j];
    if (q === "'" || q === '"') {
      const close = s.indexOf(q, j + 1);
      if (close === -1) no('an unterminated here-document delimiter');
      delim = s.slice(j + 1, close);
      if (!/^[A-Za-z0-9_.-]+$/.test(delim))
        no('a here-document delimiter that is not a plain word');
      end = close + 1;
    } else {
      const from = q === '\\' ? j + 1 : j;
      const m = /^[A-Za-z0-9_][A-Za-z0-9_.-]*/.exec(s.slice(from, from + 256));
      if (m === null) no('a here-document delimiter that is not a plain word');
      delim = m[0];
      end = from + delim.length;
    }
    const after = s[end];
    if (after !== undefined && !/[\s;|&<>)]/.test(after)) {
      no('a here-document delimiter that is not a plain word');
    }
    out.push('code', s.slice(i, end));
    pending.push({ delim, tabs });
    i = end;
    word = true;
  };

  /** `"..."` from the quote at `i` (or `$"..."`), with `$(...)` and `${...}` inside. */
  const dquote = (): void => {
    deeper();
    let start = i;
    let j = i + 1;
    for (;;) {
      const c = s[j];
      if (c === undefined) no('an unterminated string');
      if (c === '\\') j += 2;
      else if (c === '"') {
        out.push('string', s.slice(start, j + 1));
        i = j + 1;
        break;
      } else if (c === '`') no('a backtick');
      else if (c === '$' && (s[j + 1] === '(' || s[j + 1] === '{')) {
        noBreakWhilePending(s.slice(start, j));
        out.push('string', s.slice(start, j));
        i = j;
        if (s[j + 1] === '(') subst();
        else param(true);
        start = i;
        j = i;
      } else j++;
    }
    noBreakWhilePending(s.slice(start, i));
    depth--;
  };

  /**
   * Arithmetic, `$((...))` or `((...))`, from `i`: no comments inside, so all of it is code, up to
   * the parenthesis that balances the first. A quote, a backslash or a substitution in it is
   * refused: they would move its end.
   */
  const arith = (): void => {
    let j = s[i] === '$' ? i + 1 : i;
    let open = 0;
    for (;;) {
      const c = s[j];
      if (c === undefined) no('unterminated arithmetic');
      if (c === '(') open++;
      else if (c === ')') {
        open--;
        if (open === 0) break;
      } else if (
        c === "'" ||
        c === '"' ||
        c === '`' ||
        c === '\\' ||
        (c === '$' && s[j + 1] === '(')
      ) {
        no('a quote or substitution in arithmetic');
      } else if (c === '\n' && pending.length > 0) {
        no('a line break in arithmetic while a here-document waits');
      }
      j++;
    }
    out.push('code', s.slice(i, j + 1));
    i = j + 1;
  };

  /** `$(...)` from the `$` at `i`; `$((...))` is arithmetic. */
  const subst = (): void => {
    if (s[i + 2] === '(') {
      arith();
      return;
    }
    out.push('code', '$(');
    i += 2;
    code(true);
    out.push('code', ')');
    i++;
  };

  /** `${...}` from the `$` at `i`: no comments inside. */
  const param = (inDouble: boolean): void => {
    deeper();
    out.push('code', '${');
    i += 2;
    for (;;) {
      const c = s[i];
      if (c === undefined) no('an unterminated parameter expansion');
      if (c === '}') {
        out.push('code', c);
        i++;
        break;
      }
      if (c === '\\') {
        out.push('code', s.slice(i, i + 2));
        i += 2;
      } else if (c === '`') no('a backtick');
      else if (c === '"') dquote();
      else if (c === "'" && !inDouble) single();
      else if (c === '$' && s[i + 1] === '(') subst();
      else if (c === '$' && s[i + 1] === '{') param(inDouble);
      else {
        if (c === '\n' && pending.length > 0)
          no('a line break inside a parameter expansion while a here-document waits');
        out.push('code', c);
        i++;
      }
    }
    depth--;
  };

  const single = (): void => {
    const end = s.indexOf("'", i + 1);
    if (end === -1) no('an unterminated string');
    noBreakWhilePending(s.slice(i, end));
    out.push('string', s.slice(i, end + 1));
    i = end + 1;
  };

  const ansi = (): void => {
    // $'...' from the $ at i
    let j = i + 2;
    for (;;) {
      const c = s[j];
      if (c === undefined) no('an unterminated string');
      if (c === '\\') j += 2;
      else if (c === "'") break;
      else j++;
    }
    noBreakWhilePending(s.slice(i, j));
    out.push('string', s.slice(i, j + 1));
    i = j + 1;
  };

  /** Code up to the end, or (`inSubst`) up to the `)` that closes a `$(`, not consumed. */
  const code = (inSubst: boolean): void => {
    deeper();
    let parens = 0;
    word = true;
    while (i < s.length) {
      const c = s[i] as string;
      if (c === ' ' || c === '\t') {
        out.push('ws', c);
        i++;
        word = true;
      } else if (c === '\n') {
        out.push('ws', c);
        i++;
        word = true;
        if (pending.length > 0) bodies();
      } else if (c === '#' && word) {
        const end = s.indexOf('\n', i);
        const stop = end === -1 ? s.length : end;
        out.push('comment', s.slice(i, stop), { eol: true });
        i = stop;
      } else if (c === '\\') {
        const next = s[i + 1];
        if (next === undefined) no('a backslash at the end');
        out.push('code', s.slice(i, i + 2));
        i += 2;
        // a backslash-newline is removed before words are read: the word goes on
        if (next !== '\n') word = false;
      } else if (c === "'") {
        single();
        word = false;
      } else if (c === '"') {
        dquote();
        word = false;
      } else if (c === '`') {
        no('a backtick');
      } else if (c === '$') {
        const next = s[i + 1];
        if (next === "'") ansi();
        else if (next === '"') {
          out.push('code', '$');
          i++;
          dquote();
        } else if (next === '(') subst();
        else if (next === '{') param(false);
        else if (next === '[') no('$[...] arithmetic');
        else {
          out.push('code', c);
          i++;
        }
        word = false;
      } else if (s.startsWith('((', i)) {
        arith();
        word = false;
      } else if (s.startsWith('<<<', i)) {
        // a here-string: its word follows as code or a quote
        out.push('code', '<<<');
        i += 3;
        word = true;
      } else if (s.startsWith('<<', i)) {
        heredoc();
      } else if (c === '(') {
        if (inSubst) parens++;
        out.push('code', c);
        i++;
        word = true;
      } else if (c === ')') {
        if (inSubst) {
          if (parens === 0) {
            depth--;
            return;
          }
          parens--;
        }
        out.push('code', c);
        i++;
        word = true;
      } else if (c === ';' || c === '&' || c === '|' || c === '<' || c === '>') {
        out.push('code', c);
        i++;
        word = true;
      } else if (isAsciiIdent(c)) {
        let j = i;
        while (isAsciiIdent(s[j])) j++;
        const w = s.slice(i, j);
        if (inSubst && word && w === 'case') no('case inside $(...)');
        out.push('code', w);
        i = j;
        word = false;
      } else {
        out.push('code', c);
        i++;
        word = false;
      }
    }
    if (inSubst) no('an unterminated $(...)');
    if (pending.length > 0) no('an unterminated here-document');
    depth--;
  };

  code(false);
  for (const x of out.segs) {
    if (x.kind !== 'comment' && /\$\{?0(?![0-9])|BASH_SOURCE/.test(x.text)) {
      no('a script that reads itself ($0, BASH_SOURCE)');
    }
  }
  return out.segs;
}

// --- Python -----------------------------------------------------------------------------------

const PY_PREFIXES = new Set(['r', 'u', 'b', 'br', 'rb', 'f', 'fr', 'rf', 't', 'tr', 'rt']);

/**
 * Python as its tokenizer reads it: `#` comments, strings with any prefix, single- and
 * triple-quoted, escapes (a backslash skips one character, also in raw strings), f- and t-strings
 * with `{{`, `}}` and fields. A field may hold strings in the other quote only; a quote of its own
 * kind, a `#`, a backslash or a line break in a field is refused. A backslash in code must end the
 * line. The first line's `#!` must stay. Not proven: non-ASCII characters in code, a name glued to
 * a quote that is no prefix, anything unterminated.
 */
export function tokenizePython(s: string): Seg[] {
  const out = new Out(hashMeaningful);
  let i = 0;
  if (s.startsWith('#!')) {
    const end = s.indexOf('\n');
    i = end === -1 ? s.length : end;
    out.push('comment', s.slice(0, i), { eol: true, meaningful: true });
  }
  const field = (from: number, quote: string): number => {
    // from: the `{` of a field; returns the index after its closing `}`
    const other = quote === '"' ? "'" : '"';
    let open = 1;
    let k = from + 1;
    for (;;) {
      const c = s[k];
      if (c === undefined) return no('an unterminated f-string field');
      if (c === quote || c === '#' || c === '\\' || c === '\n') {
        return no('an f-string field that cannot be read for sure');
      }
      if (c === other) {
        if (s.startsWith(other.repeat(3), k)) no('an f-string field that cannot be read for sure');
        const end = s.indexOf(other, k + 1);
        if (end === -1) return no('an unterminated string');
        const inner = s.slice(k + 1, end);
        if (inner.includes('\\') || inner.includes('\n')) {
          no('an f-string field that cannot be read for sure');
        }
        k = end + 1;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') open++;
      else if (c === ')' || c === ']' || c === '}') {
        open--;
        if (open === 0) return k + 1;
      }
      k++;
    }
  };
  const string = (start: number, prefix: string): number => {
    const at = start + prefix.length;
    const q = s[at] as string;
    const triple = s.startsWith(q.repeat(3), at);
    const close = triple ? q.repeat(3) : q;
    const f = /[ft]/i.test(prefix);
    let j = at + close.length;
    for (;;) {
      const c = s[j];
      if (c === undefined) return no('an unterminated string');
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (!triple && c === '\n') return no('an unterminated string');
      if (s.startsWith(close, j)) return j + close.length;
      if (f && c === '{') {
        if (s[j + 1] === '{') j += 2;
        else j = field(j, q);
        continue;
      }
      if (f && c === '}') {
        if (s[j + 1] !== '}') no('a lone } in an f-string');
        j += 2;
        continue;
      }
      j++;
    }
  };
  while (i < s.length) {
    const c = s[i] as string;
    if (c === ' ' || c === '\t' || c === '\n') {
      out.push('ws', c);
      i++;
    } else if (c === '#') {
      const end = s.indexOf('\n', i);
      const stop = end === -1 ? s.length : end;
      out.push('comment', s.slice(i, stop), { eol: true });
      i = stop;
    } else if (c === '\\') {
      if (s[i + 1] !== '\n') no('a backslash in code that does not end the line');
      out.push('code', '\\\n');
      i += 2;
    } else if (c === '"' || c === "'") {
      const end = string(i, '');
      out.push('string', s.slice(i, end));
      i = end;
    } else if (isAsciiIdentStart(c)) {
      let j = i;
      while (isAsciiIdent(s[j])) j++;
      const w = s.slice(i, j);
      if (s[j] === '"' || s[j] === "'") {
        if (!PY_PREFIXES.has(w.toLowerCase())) no('a name glued to a quote');
        const end = string(i, w);
        out.push('string', s.slice(i, end));
        i = end;
      } else {
        out.push('code', w);
        i = j;
      }
    } else if (nonAscii(c)) {
      no('a character that is not ASCII in code');
    } else {
      out.push('code', c);
      i++;
    }
  }
  return out.segs;
}

// --- TOML -------------------------------------------------------------------------------------

/**
 * TOML 1.0: `#` comments anywhere outside strings, basic strings with escapes, literal strings,
 * and both multi-line forms (up to two quotes may stand right before the closing three). Not
 * proven: a backslash or non-ASCII character outside strings, anything unterminated.
 */
export function tokenizeToml(s: string): Seg[] {
  const out = new Out(hashMeaningful);
  let i = 0;
  const multi = (q: string, escapes: boolean): number => {
    let j = i + 3;
    for (;;) {
      if (j >= s.length) return no('an unterminated multi-line string');
      if (escapes && s[j] === '\\') {
        j += 2;
        continue;
      }
      if (s.startsWith(q.repeat(3), j)) {
        let end = j + 3;
        while (s[end] === q && end < j + 5) end++;
        return end;
      }
      j++;
    }
  };
  while (i < s.length) {
    const c = s[i] as string;
    if (c === ' ' || c === '\t' || c === '\n') {
      out.push('ws', c);
      i++;
    } else if (c === '#') {
      const end = s.indexOf('\n', i);
      const stop = end === -1 ? s.length : end;
      out.push('comment', s.slice(i, stop), { eol: true });
      i = stop;
    } else if (c === '"' || c === "'") {
      let end: number;
      if (s.startsWith(c.repeat(3), i)) end = multi(c, c === '"');
      else {
        let j = i + 1;
        for (;;) {
          const d = s[j];
          if (d === undefined || d === '\n') no('an unterminated string');
          if (d === '\\' && c === '"') j += 2;
          else if (d === c) break;
          else j++;
        }
        end = j + 1;
      }
      out.push('string', s.slice(i, end));
      i = end;
    } else if (c === '\\') {
      no('a backslash in code');
    } else if (nonAscii(c)) {
      no('a character that is not ASCII in code');
    } else {
      out.push('code', c);
      i++;
    }
  }
  return out.segs;
}

// --- YAML -------------------------------------------------------------------------------------

/** The width of a line's leading blanks; a tab among them is refused. */
function indentOf(line: string): number {
  const m = /^[ \t]*/.exec(line) as RegExpExecArray;
  if (m[0].includes('\t') && m[0].length < line.length) no('a tab in indentation');
  return m[0].length;
}

/**
 * YAML, line by line, as far as comments go. A `#` at the start of a line's content or after a
 * blank, outside a quoted scalar, starts a comment; a block scalar (`|`, `>`) holds every following
 * line that is blank or indented more than its own line, as content. A quoted scalar must end on its
 * line. Not proven: a quoted scalar over several lines, a plain scalar over several lines outside a
 * flow collection, a block scalar at the top level, a tab in indentation.
 */
export function tokenizeYaml(s: string): Seg[] {
  const out = new Out(hashMeaningful);
  const lines = s.split('\n');
  let flow = 0;
  /** The last code line: where its content starts, and whether a child node may follow it. */
  let prev: { content: number; opens: boolean } | undefined;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li] as string;
    if (li > 0) out.push('ws', '\n');
    if (/^[ \t]*$/.test(line)) {
      out.push('ws', line);
      continue;
    }
    const indent = indentOf(line);
    out.push('ws', line.slice(0, indent));
    if (line[indent] === '#') {
      out.push('comment', line.slice(indent), { eol: true });
      continue;
    }
    const startFlow = flow;
    // the line's code, up to a comment
    let i = indent;
    let codeEnd = line.length;
    let comment: string | undefined;
    while (i < line.length) {
      const c = line[i] as string;
      const before = i === indent ? ' ' : (line[i - 1] as string);
      if (c === '#' && (before === ' ' || before === '\t')) {
        codeEnd = i;
        comment = line.slice(i);
        break;
      }
      if ((c === '"' || c === "'") && /[ \t[{,:]/.test(before)) {
        let j = i + 1;
        for (;;) {
          const d = line[j];
          if (d === undefined) no('a quoted scalar over several lines');
          if (c === '"' && d === '\\') j += 2;
          else if (d === c && c === "'" && line[j + 1] === "'") j += 2;
          else if (d === c) break;
          else j++;
        }
        out.push('string', line.slice(i, j + 1));
        i = j + 1;
        continue;
      }
      if ((c === '[' || c === '{') && (flow > 0 || /[ \t[{,:-]/.test(before))) flow++;
      else if ((c === ']' || c === '}') && flow > 0) flow--;
      out.push(c === ' ' || c === '\t' ? 'ws' : 'code', c);
      i++;
    }
    if (comment !== undefined) out.push('comment', comment, { eol: true });
    const text = line.slice(indent, codeEnd).trimEnd();
    // where the content starts after sequence and key indicators: `- - a` starts at 4
    const lead = /^(?:[-?:](?:[ \t]+|$))*/.exec(text) as RegExpExecArray;
    const content = indent + lead[0].length;
    const bare = text.replace(/(?:[ \t]+[&!][^ \t]*)+$/, '').replace(/^[&!][^ \t]*$/, '');
    const structural =
      /^(?:[-?:](?:[ \t]|$)|---|\.\.\.|%)/.test(text) ||
      /:(?:[ \t]|$)/.test(text.replace(/"[^"]*"|'[^']*'/g, '""'));
    if (startFlow === 0 && prev !== undefined && !prev.opens) {
      if (indent > prev.content || !structural) no('a plain scalar over several lines');
    }
    const opens =
      flow > 0 ||
      bare === '' ||
      bare.endsWith(':') ||
      /^(?:[-?](?:[ \t]+[-?])*)$/.test(bare) ||
      text === '---' ||
      /^---[ \t]/.test(text);
    prev = { content, opens };
    // a block scalar: its body is content
    const last = text.split(/[ \t]+/).at(-1) ?? '';
    if (flow === 0 && /^[|>][0-9+-]{0,2}$/.test(last)) {
      const head = text.slice(0, text.length - last.length);
      // A block scalar that is no mapping value or sequence entry may be a document's top node,
      // whose content may stand at any indentation, also below its own line.
      if (!/(?:^|[ \t])-[ \t]|:[ \t]|^\?[ \t]/.test(head)) no('a block scalar at the top level');
      const spaces = (l: string) => (/^ */.exec(l) as RegExpExecArray)[0].length;
      let j = li + 1;
      while (
        j < lines.length &&
        (/^[ \t]*$/.test(lines[j] as string) || spaces(lines[j] as string) > indent)
      ) {
        j++;
      }
      if (j > li + 1) {
        out.push('ws', '\n');
        out.push('string', lines.slice(li + 1, j).join('\n'));
        li = j - 1;
      }
      prev = { content, opens: false };
    }
  }
  return out.segs;
}
