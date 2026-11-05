import { describe, expect, it } from 'vitest';
import { codeOf, commentsOnly, languageOf, whitespaceOnly } from '../src/proofs.js';

const yes = (a: string, b: string) => expect(commentsOnly(a, b, 'sql')).toBe(true);
const no = (a: string, b: string) => expect(commentsOnly(a, b, 'sql')).toBe(false);
const unsure = (t: string) => expect(codeOf(t, 'sql')).toBeUndefined();

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

describe('sql: plain comments and whitespace', () => {
  it('line and block comments, and blank lines, change nothing', () => {
    yes('CREATE TABLE a (id int);\n', '-- the table\nCREATE TABLE a (id int); /* note */\n\n');
    yes('SELECT 1;', 'SELECT 1; /** doc */');
    no('CREATE TABLE a (id int);\n', 'CREATE TABLE a (id bigint);\n');
  });
  it('a comment glued between two tokens joins nothing it did not join', () => {
    no('SELECT ab;', 'SELECT a/* x */b;');
    yes('SELECT a b;', 'SELECT a /* x */ b;');
  });
  it('CRLF: a comment change in a CRLF file is proven; a CRLF inside a string is not', () => {
    yes('SELECT 1;\r\nSELECT 2;\r\n', '-- c\r\nSELECT 1;\r\nSELECT 2;\r\n');
    yes('SELECT 1;\r\n', 'SELECT 1;\n');
    no("SELECT 'a\r\nb';", "SELECT 'a\nb';");
  });
  it('a hunk that changes code and a comment on the same line is not proven', () => {
    no('SELECT 1; -- a\n', 'SELECT 2; -- b\n');
    no('SELECT 1; /* a */\n', 'SELECT 2; /* b */\n');
  });
});

describe('sql: strings, identifiers and dollar quoting are content', () => {
  it('a comment marker inside a string literal or a quoted identifier is no comment', () => {
    no("SELECT '-- a';\n", "SELECT '-- b';\n");
    no("SELECT '/* a */';", "SELECT '/* b */';");
    no('SELECT "-- a" FROM t;', 'SELECT "-- b" FROM t;');
    no('SELECT `-- a` FROM t;', 'SELECT `-- b` FROM t;');
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
    // a positional parameter is no dollar quote
    yes('SELECT $1;', 'SELECT $1; -- p');
    // another tag does not close it
    no('DO $a$ x $b$ -- c\n $a$;', 'DO $a$ x $b$ -- d\n $a$;');
  });
});

describe('sql: what dialects read differently, or what runs, is never proven', () => {
  it('-- without a blank after it', () => unsure('SELECT 1 --x\n'));
  it('a backslash in a string or outside one (MySQL escapes, E strings)', () => {
    unsure("SELECT 'a\\' -- b';");
    unsure("SELECT E'a\\n';");
    unsure('SELECT \\N;');
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

describe('sql: comments with a meaning are code', () => {
  it('migration and query directives in line comments', () => {
    for (const d of [
      '-- +goose Up',
      '-- +migrate Down',
      '--+ INDEX(a i)',
      '-- no-transaction',
      '-- name: GetUser :one',
      '-- sqlx: offline',
      '-- liquibase formatted sql',
      '-- changeset alice:1',
      '-- rollback DROP TABLE a;',
      '-- noqa: L010',
    ]) {
      no('SELECT 1;\n', `${d}\nSELECT 1;\n`);
      no(`${d}\nSELECT 1;\n`, `${d} x\nSELECT 1;\n`);
    }
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
    expect(codeOf(base, 'sql')).toBeDefined();
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
        expect(commentsOnly(base, join(changed), 'sql'), `at ${k}:${i} (${c})`).toBe(false);
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
      if (!inside(i)) expect(commentsOnly(base, head, 'sql'), `insert at ${i}`).toBe(false);
    }
  });
});

describe('whitespace_only', () => {
  it('line endings, trailing blanks and blank lines at the end only', () => {
    expect(whitespaceOnly('a\nb\n', 'a  \r\nb\r\n\n\n')).toBe(true);
    expect(whitespaceOnly('a\n  b\n', 'a\nb\n')).toBe(false);
    expect(whitespaceOnly('a\nb\n', 'a\n\nb\n')).toBe(false);
    expect(whitespaceOnly('a b\n', 'a  b\n')).toBe(false);
  });
});
