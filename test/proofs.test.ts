import { describe, expect, it } from 'vitest';
import {
  codeOf,
  commentsOnly,
  languageOf,
  PROOF_LANGUAGES,
  type ProofLanguage,
  whitespaceOnly,
} from '../src/proofs.js';

const yes = (lang: ProofLanguage, a: string, b: string) =>
  expect(commentsOnly(a, b, lang)).toBe(true);
const no = (lang: ProofLanguage, a: string, b: string) =>
  expect(commentsOnly(a, b, lang)).toBe(false);

describe('languages by extension', () => {
  it('only the listed languages count', () => {
    expect(languageOf('migrations/001.SQL', ['sql'])).toBe('sql');
    expect(languageOf('src/a.rs', ['sql'])).toBeUndefined();
    expect(languageOf('a.mts', ['ts'])).toBe('ts');
    expect(languageOf('ci.yml', ['yaml', 'toml'])).toBe('yaml');
    expect(languageOf('README', [...PROOF_LANGUAGES])).toBeUndefined();
  });
});

describe('comments_only per language', () => {
  it('sql: line and block comments, and blank lines, change nothing', () => {
    yes(
      'sql',
      'CREATE TABLE a (id int);\n',
      '-- the table\nCREATE TABLE a (id int); /* note */\n\n',
    );
    no('sql', 'CREATE TABLE a (id int);\n', 'CREATE TABLE a (id bigint);\n');
  });
  it('sql: a comment marker inside a string literal is no comment', () => {
    no('sql', "SELECT '-- a';\n", "SELECT '-- b';\n");
    no('sql', 'SELECT "/* a */";\n', 'SELECT "/* b */";\n');
  });
  it('sql: dollar quoting holds `--` as content, also with a tag', () => {
    no(
      'sql',
      'CREATE FUNCTION f() AS $$ SELECT 1 -- a\n$$;\n',
      'CREATE FUNCTION f() AS $$ SELECT 1 -- b\n$$;\n',
    );
    no('sql', 'DO $body$ SELECT 1; -- a\n$body$;', 'DO $body$ SELECT 2; -- a\n$body$;');
    yes('sql', 'DO $body$ SELECT 1; $body$;', '-- c\nDO $body$ SELECT 1; $body$;');
    // a positional parameter is no dollar quote
    yes('sql', 'SELECT $1;', 'SELECT $1; -- p');
  });
  it('sql: what dialects read differently is never proven', () => {
    expect(codeOf('SELECT 1 --x\n', 'sql')).toBeUndefined();
    expect(codeOf("SELECT 'a\\' -- b';", 'sql')).toBeUndefined();
    expect(codeOf('/* a /* b */ SELECT 1; */', 'sql')).toBeUndefined();
    expect(codeOf('SELECT 1; /* open', 'sql')).toBeUndefined();
    expect(codeOf("SELECT 'open", 'sql')).toBeUndefined();
    expect(codeOf('SELECT $x$ open', 'sql')).toBeUndefined();
  });
  it('rust: nested block comments, and code after the outer end', () => {
    yes('rust', 'fn a() {}', '/* a /* b */ c */ fn a() {}');
    no('rust', '/* a /* b */ c */ fn a() {}', '/* a /* b */ c */ fn b() {}');
    expect(codeOf('/* a /* b */ fn a() {}', 'rust')).toBeUndefined();
    // JavaScript does not nest: the rest after the first `*/` is code there
    no('js', '/* a /* b */ x */ f()', '/* a /* b */ y */ f()');
  });
  it('rust: strings, raw strings, chars and lifetimes', () => {
    no('rust', 'let s = "// a";', 'let s = "// b";');
    no('rust', 'let s = r#"/* a "# */"#;', 'let s = r#"/* b "# */"#;');
    yes(
      'rust',
      "fn f<'a>(x: &'a str) -> char { '/' }",
      "fn f<'a>(x: &'a str) -> char { '/' } // c",
    );
    no('rust', "let c = '/';", "let c = '*';");
  });
  it('js and ts: strings, templates, and slashes that may start a regular expression', () => {
    no('js', 'const a = "// x";', 'const a = "// y";');
    no('ts', "const a = '/* x */';", "const a = '/* y */';");
    yes('ts', 'const a = 1;\n', '// one\nconst a = 1; /* still one */\n');
    yes('js', 'const r = a / b;', 'const r = a / b; // ratio');
    expect(codeOf('const r = /a\\/*b/; f();', 'js')).toBeUndefined();
    expect(codeOf('if (a) /x/.test(s);', 'js')).toBeUndefined();
    expect(codeOf('return /x/;', 'js')).toBeUndefined();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: template source as data
    expect(codeOf('const t = `a ${b}`;', 'ts')).toBeUndefined();
    no('js', 'const t = `// a`;', 'const t = `// b`;');
  });
  it('js: a line break is code (automatic semicolons), and so is a comment that spans lines', () => {
    no('js', 'return\nx', 'return x');
    no('js', 'a b', 'a /*\n*/ b');
    yes('js', 'a\nb', 'a // c\nb');
  });
  it('python: comments, strings and docstrings; indentation counts', () => {
    yes('python', 'def f():\n    return 1\n', '# f\ndef f():\n    return 1  # one\n');
    no('python', 's = "# a"\n', 's = "# b"\n');
    no('python', 'def f():\n    """a"""\n', 'def f():\n    """b"""\n');
    no('python', 'if a:\n    b\nc\n', 'if a:\n    b\n    c\n');
    expect(codeOf('x = f"{d["#"]}"\n', 'python')).toBeUndefined();
  });
  it('sh: comments at a word start only; here-documents and $-quotes are never proven', () => {
    yes('sh', 'echo a\n', '# say a\necho a # here\n');
    no('sh', 'echo "# a"\n', 'echo "# b"\n');
    no('sh', 'echo a#b\n', 'echo a#c\n');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell source as data
    no('sh', 'echo ${x#a}\n', 'echo ${x#b}\n');
    expect(codeOf('cat <<EOF\n# a\nEOF\n', 'sh')).toBeUndefined();
    expect(codeOf("echo $'it\\'s # a'\n", 'sh')).toBeUndefined();
    expect(codeOf('echo a\\ #b\n', 'sh')).toBeUndefined();
  });
  it('yaml: quotes only at a scalar start; block scalars are never proven', () => {
    yes('yaml', 'a: 1\n', '# top\na: 1 # one\n');
    no('yaml', "a: '# x'\n", "a: '# y'\n");
    // an apostrophe in a plain scalar opens nothing: the quoted value below stays a string
    no('yaml', "a: it's\nb: 'x #y'\n", "a: it's\nb: 'x #z'\n");
    expect(codeOf('a: |\n  # kept\n', 'yaml')).toBeUndefined();
    no('yaml', 'a:\n  b: 1\n', 'a:\nb: 1\n');
  });
  it('toml: comments and all string forms', () => {
    yes('toml', 'a = 1\n', '# one\na = 1 # still\n');
    no('toml', 'a = "# x"\n', 'a = "# y"\n');
    no('toml', "a = '''\n# x\n'''\n", "a = '''\n# y\n'''\n");
  });
  it('an unterminated block comment proves nothing, in every language that has them', () => {
    for (const lang of ['sql', 'rust', 'ts', 'js'] as const) {
      expect(codeOf('x /* open', lang)).toBeUndefined();
      no(lang, 'x', 'x /* open');
    }
  });
  it('CRLF: a comment change in a CRLF file is proven, a change in a string is not', () => {
    yes('sql', 'SELECT 1;\r\nSELECT 2;\r\n', '-- c\r\nSELECT 1;\r\nSELECT 2;\r\n');
    yes('python', 'a = 1\r\n', 'a = 1\n');
    no('python', 'a = """x\r\ny"""\r\n', 'a = """x\ny"""\r\n');
  });
  it('a hunk that changes code and a comment on the same line is not proven', () => {
    no('sql', 'SELECT 1; -- a\n', 'SELECT 2; -- b\n');
    no('js', 'x = 1; // a\n', 'x = 2; // b\n');
    no('rust', 'let x = 1; /* a */\n', 'let x = 2; /* b */\n');
    no('python', 'x = 1  # a\n', 'x = 2  # b\n');
    no('sh', 'echo 1 # a\n', 'echo 2 # b\n');
    no('yaml', 'a: 1 # a\n', 'a: 2 # b\n');
    no('toml', 'a = 1 # a\n', 'a = 2 # b\n');
  });
});

describe('comments with a meaning are code', () => {
  it('sql: executable comments and optimizer hints are never proven', () => {
    expect(codeOf('SELECT 1 /*! , 2 */;', 'sql')).toBeUndefined();
    expect(codeOf('SELECT /*+ INDEX(a i) */ * FROM a;', 'sql')).toBeUndefined();
    expect(codeOf('SELECT /*M!100000 1 */;', 'sql')).toBeUndefined();
    no('sql', 'SELECT 1;', 'SELECT 1 /*!50000 , 2 */;');
    no('sql', 'SELECT * FROM a;', 'SELECT /*+ FULL(a) */ * FROM a;');
    // a plain block comment still is one
    yes('sql', 'SELECT 1;', 'SELECT 1; /* plain */ /** doc */');
  });
  it('sql: migration and query directives in line comments', () => {
    for (const d of [
      '-- +goose Up',
      '-- +migrate Down',
      '--+ INDEX(a i)',
      '-- no-transaction',
      '-- name: GetUser :one',
      '-- sqlx: offline',
    ]) {
      no('sql', 'SELECT 1;\n', `${d}\nSELECT 1;\n`);
    }
  });
  it('a shebang in line 1 is code', () => {
    no('sh', '#!/bin/sh\necho a\n', '#!/bin/bash\necho a\n');
    no('python', '#!/usr/bin/env python3\nx = 1\n', '#!/usr/bin/env python2\nx = 1\n');
    no('python', 'x = 1\n', '#!/usr/bin/env python3\nx = 1\n');
    // a `#!` further down is a comment like any other
    yes('sh', 'echo a\n', 'echo a\n#! not an interpreter line\n');
  });
  it('python: a coding line in line 1 or 2, and checker directives, are code', () => {
    no('python', 'x = 1\n', '# -*- coding: latin-1 -*-\nx = 1\n');
    no(
      'python',
      '#!/usr/bin/env python3\nx = 1\n',
      '#!/usr/bin/env python3\n# coding=utf-8\nx = 1\n',
    );
    for (const d of [
      '# type: ignore',
      '# noqa: E501',
      '# pragma: no cover',
      '# pylint: disable=all',
      '# mypy: ignore-errors',
      '# fmt: off',
      '# nosec',
    ]) {
      no('python', 'x = f(1)\n', `x = f(1)  ${d}\n`);
    }
  });
  it('rust: attributes are code; doc comments are code, they hold doctests', () => {
    no('rust', 'fn a() {}', '#[inline]\nfn a() {}');
    no('rust', '#![allow(dead_code)]\nfn a() {}', '#![deny(dead_code)]\nfn a() {}');
    no('rust', 'fn a() {}', '/// ```\n/// assert!(false);\n/// ```\nfn a() {}');
    no('rust', 'fn a() {}', '//! crate docs\nfn a() {}');
    no('rust', 'fn a() {}', '/** docs */ fn a() {}');
    yes('rust', 'fn a() {}', '// plain\nfn a() {}');
  });
  it('ts and js: type checker, linter, bundler and source map pragmas are code', () => {
    for (const d of [
      '// @ts-ignore',
      '// @ts-expect-error',
      '// @ts-nocheck',
      '/// <reference types="node" />',
      '//# sourceMappingURL=a.js.map',
      '/* @jsx h */',
      '// eslint-disable-next-line',
      '/* eslint-disable */',
      '// biome-ignore lint: x',
      '// prettier-ignore',
      '/** @type {number} */',
      '/* istanbul ignore next */',
    ]) {
      no('ts', 'const a = f(1);\n', `${d}\nconst a = f(1);\n`);
      no('js', 'const a = f(1);\n', `${d}\nconst a = f(1);\n`);
    }
    no('js', 'const a = f(1);', 'const a = /*#__PURE__*/ f(1);');
  });
  it('shell, yaml and toml: tool directives are code', () => {
    no('sh', 'echo $a\n', '# shellcheck disable=SC2086\necho $a\n');
    no('yaml', 'a: 1\n', '# yaml-language-server: $schema=./s.json\na: 1\n');
    no('yaml', 'a: 1\n', 'a: 1 # yamllint disable-line\n');
    no('toml', 'a = 1\n', '#:schema ./s.json\na = 1\n');
  });
  it('a plain comment right before a meaningful one does not hide it, in every language', () => {
    // sql: a block comment glued to an executable one, and to a migration directive
    expect(codeOf('SELECT 1; /* a *//*! DROP TABLE a */', 'sql')).toBeUndefined();
    no('sql', 'SELECT 1;\n', 'SELECT 1; /* a */-- +goose Down\n');
    // rust: a block comment glued to a doc comment; a plain line comment before an inner doc
    no('rust', 'fn a() {}\n', '/* x *//// ```\nfn a() {}\n');
    no('rust', 'fn a() {}\n', '// x\n//! attr\nfn a() {}\n');
    no('rust', 'fn a() {}\n', '/* x *//*! inner docs */\nfn a() {}\n');
    for (const lang of ['ts', 'js'] as const) {
      no(lang, 'f();\n', '/* a *//* @ts-ignore */\nf();\n');
      no(lang, 'f();\n', '/* a */// @ts-expect-error\nf();\n');
      no(lang, 'f();\n', '/* a *//*#__PURE__*/ f();\n');
    }
    no('python', 'x = 1\n', '# a\n# coding: latin-1\nx = 1\n');
    no('python', 'x = f(1)\n', '# a\nx = f(1)  # noqa\n');
    no('sh', 'echo $a\n', '# a\n# shellcheck disable=SC2086\necho $a\n');
    no('yaml', 'a: 1\n', '# a\n# yaml-language-server: $schema=./s.json\na: 1\n');
    no('toml', 'a = 1\n', '# a\n#:schema ./s.json\na = 1\n');
  });
  it('jsx files are never read: .tsx and .jsx are in no language', () => {
    expect(languageOf('a.tsx', ['ts', 'js'])).toBeUndefined();
    expect(languageOf('a.jsx', ['ts', 'js'])).toBeUndefined();
  });
});

describe('a change to code is never classified as comments only', () => {
  // Each sample: chunks of code and comment, as the language reads them.
  const samples: [ProofLanguage, [boolean, string][]][] = [
    [
      'sql',
      [
        [true, "CREATE TABLE a (id int, s text DEFAULT '-- x');\n"],
        [false, '-- why\n'],
        [true, 'SELECT $$ -- y $$;\n'],
      ],
    ],
    [
      'rust',
      [
        [true, 'fn f(x: &str) -> u8 { let s = "/* z */"; '],
        [false, '/* a /* b */ c */'],
        [true, " b'/' }\n"],
      ],
    ],
    [
      'ts',
      [
        [true, 'const a: number = b / c;\n'],
        [false, '// note\n'],
        [true, "const s = '// q';\n"],
      ],
    ],
    [
      'js',
      [
        [true, 'f(a, "x");\n'],
        [false, '/* note */'],
        [true, ' g(b);\n'],
      ],
    ],
    [
      'python',
      [
        [true, 'def f(a):\n    s = "# x"\n'],
        [false, '    # note\n'],
        [true, '    return a\n'],
      ],
    ],
    [
      'sh',
      [
        [true, 'echo "# x" a\n'],
        [false, '# note\n'],
        [true, 'ls -l b\n'],
      ],
    ],
    [
      'yaml',
      [
        [true, 'a: "# x"\nb:\n  - c\n'],
        [false, '# note\n'],
        [true, 'd: 1\n'],
      ],
    ],
    [
      'toml',
      [
        [true, 'a = "# x"\n[b]\n'],
        [false, '# note\n'],
        [true, 'c = 1\n'],
      ],
    ],
  ];
  it.each(samples)('%s: every one-character change inside code is not proven', (lang, chunks) => {
    const join = (cs: [boolean, string][]) => cs.map(([, t]) => t).join('');
    const base = join(chunks);
    expect(codeOf(base, lang)).toBeDefined();
    // a change to the comment is proven
    yes(
      lang,
      base,
      join(
        chunks.map(([code, t]) => [
          code,
          code ? t : t.replace('note', 'other').replace('a /*', 'z /*'),
        ]),
      ),
    );
    for (const [k, [code, text]] of chunks.entries()) {
      if (!code) continue;
      for (let i = 0; i < text.length; i++) {
        const c = text[i] as string;
        const replacement = c === 'Q' ? 'R' : 'Q';
        // Whitespace that only separates the same tokens may change; everything else may not.
        if (/\s/.test(c)) continue;
        const changed = chunks.map(([cd, t], j): [boolean, string] =>
          j === k ? [cd, t.slice(0, i) + replacement + t.slice(i + 1)] : [cd, t],
        );
        expect(commentsOnly(base, join(changed), lang), `${lang} at ${k}:${i} (${c})`).toBe(false);
      }
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
