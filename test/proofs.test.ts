import { describe, expect, it } from 'vitest';
import { codeOf, commentsOnly, commentsOnlyWhy, languageOf } from '../src/proofs.js';

const yes = (a: string | Uint8Array, b: string | Uint8Array) =>
  expect(commentsOnly(a, b)).toBe(true);
const no = (a: string | Uint8Array, b: string | Uint8Array) =>
  expect(commentsOnly(a, b)).toBe(false);
const unsure = (t: string) => expect(codeOf(t)).toBeUndefined();

describe('comments_only reads sql only', () => {
  it('.sql files, any case; every other file is in no language', () => {
    expect(languageOf('migrations/001.SQL', ['sql'])).toBe('sql');
    for (const p of [
      'a.rs',
      'a.ts',
      'a.js',
      'a.tsx',
      'a.py',
      'a.sh',
      'a.yml',
      'a.toml',
      'README',
    ]) {
      expect(languageOf(p, ['sql'])).toBeUndefined();
    }
  });
});

describe('the boring case: comment text edited or added on its own lines', () => {
  it('line and block comments, and blank lines, change nothing', () => {
    yes('CREATE TABLE a (id int);\n', '-- the table\nCREATE TABLE a (id int); /* note */\n\n');
    yes('SELECT 1;', 'SELECT 1; /** doc */');
    yes('SELECT 1; -- a\nSELECT 2;\n', 'SELECT 1; -- b\nSELECT 2;\n');
    no('CREATE TABLE a (id int);\n', 'CREATE TABLE a (id bigint);\n');
  });
  it('a comment glued between two tokens joins nothing it did not join', () => {
    no('SELECT ab;', 'SELECT a/* x */b;');
    yes('SELECT a b;', 'SELECT a /* x */ b;');
  });
  it('a line comment always ends a line: code before and after it is never joined', () => {
    no('SELECT a b;', 'SELECT a -- x\nb;');
    yes('SELECT a\nb;', 'SELECT a -- x\nb;');
  });
  it('a hunk that changes code and a comment on the same line is not proven', () => {
    no('SELECT 1; -- a\n', 'SELECT 2; -- b\n');
    no('SELECT 1; /* a */\n', 'SELECT 2; /* b */\n');
  });
});

describe('line endings and bytes', () => {
  it('CRLF used throughout, in both versions, is fine; a change of line endings is not', () => {
    yes('SELECT 1;\r\nSELECT 2;\r\n', '-- c\r\nSELECT 1;\r\nSELECT 2;\r\n');
    no('SELECT 1;\r\nSELECT 2;\r\n', 'SELECT 1;\nSELECT 2;\n');
    expect(commentsOnlyWhy('SELECT 1;\nSELECT 2;\n', 'SELECT 1;\r\nSELECT 2;\n')).toBe(
      'the head has mixed line endings',
    );
  });
  it('a lone CR, a form feed or a vertical tab anywhere proves nothing, also in comments and strings', () => {
    for (const t of [
      '-- a\rDROP TABLE a;\nSELECT 1;\n',
      "SELECT 'a\rb';\n",
      'SELECT 1; /* a\r */\n',
      'SELECT\f1;\n',
      'SELECT\v1;\n',
    ]) {
      no('SELECT 1;\n', t);
      no(t, 'SELECT 1;\n');
    }
    expect(commentsOnlyWhy('SELECT 1;\n', '-- a\rDROP TABLE a;\nSELECT 1;\n')).toBe(
      'the head has a carriage return without a line feed',
    );
  });
  it('a backslash anywhere proves nothing: comments, strings, identifiers, E strings', () => {
    for (const t of [
      '-- a \\\nSELECT 1;\n',
      "SELECT 'a\\';\n",
      "SELECT E'\\n';\n",
      'SELECT "a\\" FROM t;\n',
      'SELECT \\N;\n',
    ]) {
      no('SELECT 1;\n', t);
      expect(commentsOnlyWhy('SELECT 1;\n', t)).toBe('the head has a backslash');
    }
  });
  it('bytes that are not valid UTF-8 prove nothing; a byte order mark is kept', () => {
    const base = new TextEncoder().encode('SELECT 1;\n');
    const bad = Uint8Array.from([...new TextEncoder().encode('-- '), 0xff, 0x0a, ...base]);
    expect(commentsOnlyWhy(base, bad)).toBe('the head has not valid UTF-8');
    const overlong = Uint8Array.from([0x2d, 0x2d, 0x20, 0xc0, 0xaf, 0x0a, ...base]);
    no(base, overlong);
    const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...base]);
    no(base, bom);
    yes(base, Uint8Array.from([...new TextEncoder().encode('-- a\n'), ...base]));
  });
  it('a NUL byte is binary', () => {
    expect(commentsOnlyWhy('SELECT 1;\n', 'SELECT 1;\0\n')).toBe('the head has binary');
  });
});

describe('strings, identifiers and dollar quoting are content', () => {
  it('a comment marker inside a string literal or a quoted identifier is no comment', () => {
    no("SELECT '-- a';\n", "SELECT '-- b';\n");
    no("SELECT '/* a */';", "SELECT '/* b */';");
    no('SELECT "-- a" FROM t;', 'SELECT "-- b" FROM t;');
    no("SELECT 'it''s -- a';", "SELECT 'it''s -- b';");
  });
  it('dollar quoting holds `--` as content, with and without a tag', () => {
    no(
      'CREATE FUNCTION f() AS $$ SELECT 1 -- a\n$$;\n',
      'CREATE FUNCTION f() AS $$ SELECT 1 -- b\n$$;\n',
    );
    no('DO $body$ SELECT 1; -- a\n$body$;', 'DO $body$ SELECT 2; -- a\n$body$;');
    no('DO $body$ /* a */ $body$;', 'DO $body$ /* b */ $body$;');
    yes('DO $body$ SELECT 1; $body$;', '-- c\nDO $body$ SELECT 1; $body$;');
    // another tag does not close it
    no('DO $a$ x $b$ -- c\n $a$;', 'DO $a$ x $b$ -- d\n $a$;');
  });
  it('positional parameters are code', () => {
    yes('SELECT $1;', 'SELECT $1; -- p');
    no('SELECT $1;', 'SELECT $2;');
  });
  it('a $ that is neither a clean ASCII tag nor a parameter proves nothing', () => {
    unsure('DO $ü$ SELECT 1; $ü$;');
    unsure(`DO $${'a'.repeat(64)}$ SELECT 1; $${'a'.repeat(64)}$;`);
    unsure('SELECT a$b FROM t;');
    unsure('SELECT $1a;');
    unsure('SELECT $ ;');
    unsure('SELECT `a` FROM t;');
  });
});

describe('what may run or be read otherwise is never proven', () => {
  it('-- without a blank after it, also the --+ hint form', () => {
    unsure('SELECT 1 --x\n');
    unsure('--+ INDEX(a i)\nSELECT 1;\n');
  });
  it('a nested block comment', () => unsure('/* a /* b */ SELECT 1; */'));
  it('executable comments and optimizer hints', () => {
    unsure('SELECT 1 /*! , 2 */;');
    unsure('SELECT /*+ INDEX(a i) */ * FROM a;');
    unsure('SELECT /*M!100000 1 */;');
    no('SELECT 1;', 'SELECT 1 /*!50000 , 2 */;');
  });
  it('anything unterminated', () => {
    unsure('SELECT 1; /* open');
    unsure("SELECT 'open");
    unsure('SELECT "open');
    unsure('SELECT $x$ open');
    no('SELECT 1;', 'SELECT 1; /* open');
  });
});

describe('comments with a meaning must stay as they are, where they are', () => {
  const directives = [
    '-- +goose Up',
    '-- +migrate Down',
    '-- no-transaction',
    '-- name: GetUser :one',
    '-- sqlx: offline',
    '-- liquibase formatted sql',
    '-- changeset alice:1',
    '-- rollback DROP TABLE a;',
    '-- noqa: L010',
  ];
  it.each(directives)('%s: added, removed, edited or moved is not proven', (d) => {
    no('SELECT 1;\n', `${d}\nSELECT 1;\n`);
    no(`${d}\nSELECT 1;\n`, 'SELECT 1;\n');
    no(`${d}\nSELECT 1;\n`, `${d} x\nSELECT 1;\n`);
    no(`${d}\nSELECT 1;\nSELECT 2;\n`, `SELECT 1;\n${d}\nSELECT 2;\n`);
    yes(`${d}\nSELECT 1;\n`, `${d}\n-- plain\nSELECT 1;\n`);
  });
  it('code moved onto a meaningful line comment is not proven', () => {
    no('-- +goose Up\nDROP TABLE a;\n', '-- +goose Up DROP TABLE a;\n');
    no('-- +goose Up\nDROP TABLE a;\n', '-- +goose Up\n-- DROP TABLE a;\n');
  });
  it('a plain comment right before a meaningful one does not hide it', () => {
    unsure('SELECT 1; /* a *//*! DROP TABLE a */');
    no('SELECT 1;\n', 'SELECT 1; /* a */-- +goose Down\n');
    no('SELECT 1;\n', '/* a */ /* +goose */\nSELECT 1;\n');
    no('SELECT 1;\n', '-- a\n-- +goose Down\nSELECT 1;\n');
  });
});

describe('a change to code is never classified as comments only', () => {
  // Chunks of code and comment, as SQL reads them.
  const chunks: [boolean, string][] = [
    [true, 'CREATE TABLE a (id int, s text DEFAULT \'-- x\', "q""r" int);\n'],
    [false, '-- why\n'],
    [true, 'SELECT $$ -- y $$, $t$ z $t$ FROM a WHERE id = $1;\n'],
    [false, '/* note */'],
    [true, ' DROP INDEX i;\n'],
  ];
  const join = (cs: [boolean, string][]) => cs.map(([, t]) => t).join('');
  const base = join(chunks);
  it('the sample reads, and a change to its comments is proven', () => {
    expect(codeOf(base)).toBeDefined();
    yes(
      base,
      join(
        chunks.map(([code, t]) => [
          code,
          code ? t : t.replace('why', 'how').replace('note', 'text'),
        ]),
      ),
    );
  });
  it('every one-character change inside code is not proven', () => {
    for (const [k, [code, text]] of chunks.entries()) {
      if (!code) continue;
      for (let i = 0; i < text.length; i++) {
        const c = text[i] as string;
        // Whitespace that only separates the same tokens may change; everything else may not.
        if (/\s/.test(c)) continue;
        const replacement = c === 'Q' ? 'R' : 'Q';
        const changed = chunks.map(([cd, t], j): [boolean, string] =>
          j === k ? [cd, t.slice(0, i) + replacement + t.slice(i + 1)] : [cd, t],
        );
        expect(commentsOnly(base, join(changed)), `at ${k}:${i} (${c})`).toBe(false);
      }
    }
  });
  it('inserting code anywhere outside a comment is not proven', () => {
    // Strictly inside a comment's text, after its opener and before its end.
    const line = base.indexOf('-- why');
    const block = base.indexOf('/* note */');
    const inside = (i: number) =>
      (i >= line + 2 && i <= line + '-- why'.length) ||
      (i >= block + 2 && i <= block + '/* note */'.length - 2);
    for (let i = 0; i <= base.length; i++) {
      const head = `${base.slice(0, i)}x${base.slice(i)}`;
      if (!inside(i)) expect(commentsOnly(base, head), `insert at ${i}`).toBe(false);
    }
  });
});

describe('the tokenizer is linear', () => {
  const size = 2 * 1024 * 1024;
  const fill = (unit: string) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  it.each([
    ['statements and comments', fill("SELECT 'a''b', \"c\" FROM t; -- note\n/* block */ $$x$$\n")],
    ['doubled quotes', `'${fill("''")}'`],
    ['line comments', fill('-- a\n')],
    ['block comments', fill('/* */')],
    ['dollar quotes', fill('$a$ $a$ ')],
    ['one long dollar quote', `$a$${fill('$b ')}$a$`],
    ['blanks', fill(' \t\n')],
  ])('2 MB of %s finish in under a second', (_what, text) => {
    const started = performance.now();
    commentsOnly(text, `-- head\n${text}`);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
