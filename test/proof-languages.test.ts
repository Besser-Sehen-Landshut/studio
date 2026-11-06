// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the samples are source text with templates and parameter expansions
import { describe, expect, it } from 'vitest';
import {
  codeOf,
  commentsOnly,
  commentsOnlyWhy,
  languageOf,
  PROOF_LANGUAGES,
  type ProofLanguage,
} from '../src/proofs.js';

const ALL = PROOF_LANGUAGES;
const yes = (l: ProofLanguage, a: string, b: string, path = '') =>
  expect(commentsOnlyWhy(a, b, l, path), `${l}: ${JSON.stringify(b)}`).toBeUndefined();
const no = (l: ProofLanguage, a: string, b: string, path = '') =>
  expect(commentsOnly(a, b, l, path), `${l}: ${JSON.stringify(b)}`).toBe(false);
const unsure = (l: ProofLanguage, t: string, path = '') =>
  expect(codeOf(t, l, path), `${l}: ${JSON.stringify(t)}`).toBeUndefined();
const reads = (l: ProofLanguage, t: string, path = '') =>
  expect(codeOf(t, l, path), `${l}: ${JSON.stringify(t)}`).toBeDefined();

describe('the language comes from the file extension', () => {
  it('each extension maps to its language, case-insensitively, among the allowed ones', () => {
    const cases: [string, ProofLanguage][] = [
      ['src/main.rs', 'rust'],
      ['a/b.ts', 'typescript'],
      ['a/b.tsx', 'typescript'],
      ['a/b.d.ts', 'typescript'],
      ['a/b.mts', 'typescript'],
      ['a/b.cts', 'typescript'],
      ['a/b.js', 'javascript'],
      ['a/b.jsx', 'javascript'],
      ['a/b.mjs', 'javascript'],
      ['a/b.cjs', 'javascript'],
      ['.github/workflows/ci.yml', 'yaml'],
      ['k8s/app.YAML', 'yaml'],
      ['Cargo.toml', 'toml'],
      ['db/001.sql', 'sql'],
    ];
    for (const [path, lang] of cases) {
      expect(languageOf(path, ALL), path).toBe(lang);
      expect(
        languageOf(
          path,
          ALL.filter((l) => l !== lang),
        ),
        path,
      ).toBeUndefined();
    }
  });
  it('an unknown extension is in no language: the proof does not apply', () => {
    for (const p of [
      'a.go',
      'a.c',
      'a.zsh',
      'a.fish',
      'Makefile',
      'Dockerfile',
      'a.json',
      'a.md',
      'a.rs.bak',
      'a.tsx~',
      'rs',
      'README',
    ]) {
      expect(languageOf(p, ALL), p).toBeUndefined();
    }
  });
  it('shell and Python are not applicable: they read their own source and line numbers', () => {
    expect(ALL).not.toContain('shell');
    expect(ALL).not.toContain('python');
    for (const p of ['run.sh', 'run.bash', 'tool.py', 'tool.pyi', 'scripts/X.SH']) {
      expect(languageOf(p, ALL), p).toBeUndefined();
    }
  });
});

describe('characters no new language reads', () => {
  it.each(ALL.filter((l) => l !== 'sql'))(
    '%s: separators, bidi controls and a BOM prove nothing',
    (l) => {
      for (const bad of ['\u2028', '\u2029', '\u0085', '\u202E', '\u2066', '\u200F']) {
        const t = `x = 1 ${l === 'rust' || l === 'typescript' || l === 'javascript' ? '//' : '#'} a${bad}b\n`;
        expect(commentsOnlyWhy('x = 1\n', t, l)).toMatch(
          /the head has a (line separator|bidirectional control)/,
        );
      }
      expect(commentsOnlyWhy('x\n', '\uFEFFx\n', l)).toBe('the head has a byte order mark');
      expect(commentsOnlyWhy('x\n', 'x\0\n', l)).toBe('the head has binary');
      expect(commentsOnlyWhy('x\n', 'x\r\n', l)).toBe('its line endings changed');
    },
  );
  it('a reason names the side that cannot be read', () => {
    expect(commentsOnlyWhy('let a = 1;\n', 'let a = `x;\n', 'typescript')).toBe(
      'the head cannot be read for sure: an unterminated template literal',
    );
  });
});

describe('rust', () => {
  const r: ProofLanguage = 'rust';
  it('plain line and block comments may change; code may not', () => {
    yes(r, 'fn main() {}\n', '// entry\nfn main() {} /* nothing */\n');
    yes(r, 'fn a() {\n    1\n}\n', 'fn a() {\n    // one\n    1\n}\n');
    no(r, 'fn a() { 1 }\n', 'fn a() { 2 }\n');
    no(r, 'let ab = 1;', 'let a/* x */b = 1;');
    yes(r, 'let a = b;', 'let a = /* x */ b;');
  });
  it('block comments nest: code after an inner close is still comment', () => {
    yes(r, 'fn a() {}\n', '/* outer /* inner */ still comment */\nfn a() {}\n');
    unsure(r, '/* outer /* inner */ fn a() {}\n');
    // naive reading would end at the first */ and see `evil();` as code, or the reverse
    yes(r, 'x();\n/* a /* b */ evil(); */\n', 'x();\n/* a /* b */ good(); */\n');
  });
  it('doc comments are code: rustdoc attributes, doctests and derive-macro text', () => {
    for (const doc of ['/// Adds.', '//! Crate.', '/** Adds. */', '/*! Crate. */']) {
      no(
        r,
        `${doc}\nfn a() {}\n`,
        `${doc.replace('s.', 's more.').replace('e.', 'e more.')}\nfn a() {}\n`,
      );
      no(r, 'fn a() {}\n', `${doc}\nfn a() {}\n`);
    }
    no(
      r,
      '/// ```\n/// assert!(true);\n/// ```\nfn a() {}\n',
      '/// ```\n/// assert!(false);\n/// ```\nfn a() {}\n',
    );
    // clap reads the doc comment as the help text
    no(
      r,
      '#[derive(Parser)]\nstruct A {\n    /// Port\n    port: u16,\n}\n',
      '#[derive(Parser)]\nstruct A {\n    /// Port to bind\n    port: u16,\n}\n',
    );
  });
  it('comment markers inside strings, raw strings, byte and C strings are content', () => {
    no(r, 'let s = "// a";', 'let s = "// b";');
    no(r, 'let s = "/* a */";', 'let s = "/* b */";');
    no(r, 'let s = "a\\" // b";', 'let s = "a\\" // c";');
    no(r, 'let s = r"// a";', 'let s = r"// b";');
    no(r, 'let s = r#"a "// x" b"#;', 'let s = r#"a "// y" b"#;');
    no(r, 'let s = r##"a "#// x"##;', 'let s = r##"a "#// y"##;');
    no(r, 'let s = b"// a";', 'let s = b"// b";');
    no(r, 'let s = br#"// a"#;', 'let s = br#"// b"#;');
    no(r, 'let s = c"// a";', 'let s = c"// b";');
    no(r, 'let s = "line\n// a\n";', 'let s = "line\n// b\n";');
    yes(r, 'let s = "x";', 'let s = "x"; // y');
  });
  it('chars are told from lifetimes and labels', () => {
    no(r, "let c = '\"'; // a\nlet d = 1;", "let c = '\"'; // a\nlet d = 2;");
    yes(
      r,
      "fn f<'a>(x: &'a str) -> &'a str { x }\n",
      "fn f<'a>(x: &'a str) -> &'a str { x } // id\n",
    );
    yes(r, "'outer: loop { break 'outer; }\n", "'outer: loop { break 'outer; } // l\n");
    yes(
      r,
      "let c = '\\''; let d = '\\u{1F600}'; let e = b'x';\n",
      "let c = '\\''; let d = '\\u{1F600}'; let e = b'x'; // c\n",
    );
    yes(r, "let c = '😀';\n", "let c = '😀'; // emoji\n");
    no(r, "let c = '/';\n", "let c = '*';\n");
    unsure(r, "let c = 'ab';");
    unsure(r, "let c = ''';");
  });
  it('raw identifiers are code, a shebang line stays, an inner attribute is no shebang', () => {
    yes(r, 'let r#type = 1;\n', 'let r#type = 1; // kw\n');
    no(
      r,
      '#!/usr/bin/env run-cargo-script\nfn main() {}\n',
      '#!/usr/bin/env run-cargo-script //x\nfn main() {}\n',
    );
    yes(r, '#![allow(dead_code)]\nfn main() {}\n', '#![allow(dead_code)]\n// c\nfn main() {}\n');
  });
  it('a SAFETY comment is meaningful: clippy reads it', () => {
    no(r, 'unsafe { f() }\n', '// SAFETY: f is fine\nunsafe { f() }\n');
    no(r, '// SAFETY: a\nunsafe { f() }\n', '// SAFETY: b\nunsafe { f() }\n');
  });
  it('line! and column! make a moved line code', () => {
    unsure(r, 'fn a() -> u32 { line!() }');
    unsure(r, 'fn a() -> u32 { std::column !() }');
    reads(r, 'fn a() { let line = 1; }');
  });
  it('anything unterminated or unclear proves nothing', () => {
    for (const t of [
      '/* open',
      '"open',
      'r#"open"',
      'r##"open"#',
      "'",
      'let x = foo"a";',
      'let x = foo#bar;',
      'let x = \\u;',
      'let größe = 1;',
      'r###x',
    ]) {
      unsure(r, t);
    }
    no(r, 'fn a() {}', 'fn a() {} /* open');
  });
});

describe('typescript and javascript', () => {
  const ts: ProofLanguage = 'typescript';
  const js: ProofLanguage = 'javascript';
  it('plain comments may change, also JSDoc prose; code may not', () => {
    yes(ts, 'const a = 1;\n', '// one\nconst a = 1; /* x */\n');
    yes(ts, 'function f() {}\n', '/**\n * Does f.\n */\nfunction f() {}\n');
    no(ts, 'const a = 1;\n', 'const a = 2;\n');
    no(ts, 'a\n(b)', 'a /* x */ (b)');
    yes(ts, 'a\n(b)', 'a /* x\n */ (b)');
    yes(js, 'f(a, b);', 'f(a, /* second */ b);');
  });
  it('comment markers inside strings, templates and regular expressions are content', () => {
    no(ts, "const s = '// a';", "const s = '// b';");
    no(ts, 'const s = "/* a */";', 'const s = "/* b */";');
    no(ts, 'const s = `// a`;', 'const s = `// b`;');
    no(ts, 'const s = `a\n// x\n`;', 'const s = `a\n// y\n`;');
    no(ts, 'const s = `${a /* x */}`;', 'const s = `${b /* x */}`;');
    yes(ts, 'const s = `${ a }`;', 'const s = `${ a /* x */ }`;');
    no(ts, 'const s = `${`// ${x}`}`;', 'const s = `${`// ${y}`}`;');
    no(ts, 'const r = /[/*]/; f(); // */', 'const r = /[/*]/; g(); // */');
    no(ts, 'const r = /\\/*/; f(); // */', 'const r = /\\/*/; g(); // */');
    no(ts, "const r = /'/; f(); // '", "const r = /'/; g(); // '");
    yes(ts, 'const r = /a/g;', 'const r = /a/g; // re');
    // The literal ends as the lexical grammar says, without nested classes (flags come after it):
    // node reads `/*]/v; f(); //*/` as a comment too.
    yes(ts, 'const r = /[[a]/ /*]/v; f(); //*/', 'const r = /[[a]/ /*]/u; g(); //*/');
  });
  it('a / is told as division or regular expression by what stands before it', () => {
    yes(ts, 'const x = (a + b) / 2;', 'const x = (a + b) / 2; // half');
    yes(ts, 'const x = a[0] / 2 / c;', 'const x = a[0] / 2 / c; // q');
    yes(ts, 'const x = this.n / 2;', 'const x = this.n / 2; // half');
    yes(ts, 'x = a.return / 2;', 'x = a.return / 2; // prop');
    yes(ts, 'return /a/.test(s);', 'return /a/.test(s); // t');
    // division misread as a regular expression would make `// '` code and hide `evil()`
    no(ts, "x = a / 2 + '/' + '// '; evil();", "x = a / 2 + '/' + '// '; good();");
  });
  it('a / or < that may go either way is refused', () => {
    unsure(ts, 'if (a) /re/.test(s);');
    unsure(ts, 'while (a) /re/.test(s);');
    unsure(ts, 'for await (const x of y) /re/.test(x);');
    unsure(ts, '}\n/re/.test(s);');
    unsure(ts, 'x = a++ / 2;');
    unsure(ts, 'x = a! / 2;');
    unsure(ts, 'x = await / 2;');
    unsure(ts, 'x = yield /re/;');
    unsure(ts, 'if (a) <div/>;', 'a.tsx');
  });
  it('JSX text is content: a // or quote in it is no comment', () => {
    no(js, 'const a = <p>see // a</p>;', 'const a = <p>see // b</p>;', 'a.jsx');
    no(js, 'const a = <p>see // a</p>;', 'const a = <p>see // b</p>;', 'a.js');
    no(ts, 'const a = <p>/* a */</p>;', 'const a = <p>/* b */</p>;', 'a.tsx');
    no(
      ts,
      'const a = (\n  <p>\n    // a\n  </p>\n);',
      'const a = (\n  <p>\n    // b\n  </p>\n);',
      'a.tsx',
    );
    yes(ts, 'const a = <p>{ x }</p>;', 'const a = <p>{ x /* why */ }</p>;', 'a.tsx');
    yes(ts, 'const a = <p>{/* a */}</p>;', 'const a = <p>{/* b */}</p>;', 'a.tsx');
    no(ts, 'const a = <a href="//x">t</a>;', 'const a = <a href="//y">t</a>;', 'a.tsx');
    yes(
      ts,
      'const a = <><A b={1} {...c} d />text</>;',
      'const a = <><A b={1} {...c} d />text</>; // x',
      'a.tsx',
    );
    yes(ts, 'return cond && <A x={<B />} />;', 'return cond && <A x={<B />} />; // y', 'a.tsx');
    yes(js, "const a = <p>it's</p>;", "const a = <p>it's</p>; // ok", 'a.jsx');
    no(js, "const a = <p>it's // a</p>;", "const a = <p>it's // b</p>;", 'a.jsx');
    unsure(ts, 'const a = <p>x</q>;', 'a.tsx');
    unsure(ts, 'const a = <p>x;', 'a.tsx');
    unsure(ts, 'const f = <T,>(x: T) => x;', 'a.tsx');
  });
  it('in plain TypeScript a < is never JSX', () => {
    yes(ts, 'const a = <T>b;', 'const a = <T>b; // cast', 'a.ts');
    yes(ts, 'const a: Array<string> = [];', 'const a: Array<string> = []; // c', 'a.ts');
    yes(ts, 'if (a < b) f();', 'if (a < b) f(); // c', 'a.tsx');
  });
  it('comments with a meaning stay as they are', () => {
    for (const c of [
      '// @ts-ignore',
      '// @ts-expect-error',
      '/// <reference path="a.d.ts" />',
      '// eslint-disable-next-line no-console',
      '// biome-ignore lint: x',
      '// prettier-ignore',
      '/* istanbul ignore next */',
      '/* webpackChunkName: "a" */',
      '/*#__PURE__*/',
      '//# sourceMappingURL=a.js.map',
      '/** @type {string} */',
      '/** @internal */',
      '/** @jsxImportSource preact */',
      '/*! license */',
      '/* global foo */',
      // split, or vitest reads it as this file's own pragma
      `// @vitest-${'environment'} jsdom`,
    ]) {
      no(ts, 'f(a);\n', `${c}\nf(a);\n`);
      no(ts, `${c}\nf(a);\n`, 'f(a);\n');
    }
  });
  it('a hashbang stays; private names are code', () => {
    no(js, '#!/usr/bin/env node\nf();\n', '#!/usr/bin/env node //x\nf();\n');
    yes(ts, 'class A { #x = 1; }', 'class A { #x = 1; } // p');
  });
  it('a script-only comment form, a backslash or non-ASCII in code proves nothing', () => {
    unsure(js, 'x = 1 <!-- y\n');
    unsure(js, '--> y\n');
    unsure(js, 'const \\u0061 = 1;');
    unsure(js, 'const a\u00A0= /x/;');
    unsure(js, 'const größe = 1;');
    reads(js, "const s = 'größe';");
  });
  it('anything unterminated or unbalanced proves nothing', () => {
    for (const t of [
      '/* open',
      "'open",
      '"a\nb"',
      '`open',
      '`${open`',
      '/open',
      'f(',
      'f)',
      '{',
      '}',
      'x = /[/;',
    ]) {
      unsure(ts, t);
    }
  });
});

describe('yaml', () => {
  const y: ProofLanguage = 'yaml';
  it('plain comments may change; data and indentation may not', () => {
    yes(y, 'a: 1\nb:\n  c: 2\n', '# top\na: 1 # one\nb:\n  # c next\n  c: 2\n');
    no(y, 'a: 1\n', 'a: 2\n');
    no(y, 'a:\n  b: 1\n', 'a:\nb: 1\n');
    yes(
      y,
      'on:\n  push:\njobs:\n  a:\n    steps:\n      - run: x\n        name: y\n',
      'on:\n  push: # main\njobs:\n  a:\n    steps:\n      # first\n      - run: x\n        name: y\n',
    );
  });
  it('a # without a blank before it, or inside quotes, is content', () => {
    no(y, 'a: b#c\n', 'a: b#d\n');
    no(y, 'a: "x # y"\n', 'a: "x # z"\n');
    no(y, "a: 'x # y'\n", "a: 'x # z'\n");
    no(y, "a: 'it''s # y'\n", "a: 'it''s # z'\n");
    no(y, 'a: "q\\" # y"\n', 'a: "q\\" # z"\n');
    yes(y, "a: it's\n", "a: it's # plain\n");
  });
  it('block scalars are content, comment-like lines and blank lines in them too', () => {
    no(y, 'run: |\n  echo a\n  # a\n', 'run: |\n  echo a\n  # b\n');
    no(y, 'run: >-\n  a\n  # a\nnext: 1\n', 'run: >-\n  a\n  # b\nnext: 1\n');
    no(y, '- |\n  # a\n', '- |\n  # b\n');
    no(y, 'run: |+\n  a\n\nnext: 1\n', 'run: |+\n  a\nnext: 1\n');
    yes(y, 'run: |\n  a\nnext: 1\n', 'run: | # script\n  a\n# between\nnext: 1\n');
    no(y, 'k: !!str |\n  # a\n', 'k: !!str |\n  # b\n');
    unsure(y, '--- |\ntext\n# not a comment\n');
    unsure(y, '|\n  text\n');
  });
  it('a quoted or plain scalar over several lines is refused', () => {
    unsure(y, 'a: "x\n  # y"\n');
    unsure(y, "a: 'x\n  # y'\n");
    unsure(y, 'a: x\n  y\n');
    unsure(y, 'a:\n  x\n  y\n');
  });
  it('flow collections may span lines with comments', () => {
    yes(y, 'a: [1,\n  2]\n', 'a: [1, # one\n  # two\n  2]\n');
    no(y, 'a: [1,\n  2]\n', 'a: [1,\n  3]\n');
  });
  it('the loaded data must be the same too', () => {
    // tokens alike, but an anchor alias flip: data differs
    no(y, 'a: &x 1\nb: *x\n', 'a: &x 1\nb: *y\n');
  });
  it('tool comments stay', () => {
    for (const c of [
      '# yaml-language-server: $schema=x.json',
      '# yamllint disable-line',
      '# renovate: datasource=docker',
      '# zizmor: ignore[x]',
    ]) {
      no(y, 'a: 1\n', `${c}\na: 1\n`);
    }
  });
  it('a tab in indentation proves nothing', () => unsure(y, 'a:\n\tb: 1\n'));
});

describe('toml', () => {
  const t: ProofLanguage = 'toml';
  it('plain comments may change; values may not', () => {
    yes(t, '[a]\nb = 1\n', '# section\n[a] # a\nb = 1 # one\n');
    no(t, 'b = 1\n', 'b = 2\n');
    yes(t, 'x = [\n  1,\n  2,\n]\n', 'x = [\n  1, # one\n  2,\n]\n');
  });
  it('strings of every kind hold # as content', () => {
    no(t, 'a = "# x"\n', 'a = "# y"\n');
    no(t, "a = '# x'\n", "a = '# y'\n");
    no(t, 'a = """\n# x\n"""\n', 'a = """\n# y\n"""\n');
    no(t, "a = '''\n# x\n'''\n", "a = '''\n# y\n'''\n");
    no(t, 'a = "q\\" # x"\n', 'a = "q\\" # y"\n');
    no(t, 'a = """x""" # c\nb = 1\n', 'a = """x""" # c\nb = 2\n');
    no(t, 'a = """x""""\nb = 1 # c\n', 'a = """x""""\nb = 1 # d\nc = 1\n');
  });
  it('a key or value moved off its line is code', () => {
    no(t, 'a = 1\n', 'a # x\n= 1\n');
  });
  it('anything unclear proves nothing', () => {
    for (const x of [
      'a = "open',
      "a = 'open",
      'a = """open',
      "a = '''open",
      'a\\b = 1',
      'größe = 1',
      'a = "x\ny"',
    ])
      unsure(t, x);
  });
});

describe('a change to code is never classified as comments only, in any language', () => {
  // A sample per language, chunks of code and plain comments.
  const samples: [ProofLanguage, string, [boolean, string][]][] = [
    [
      'rust',
      'a.rs',
      [
        [true, 'fn f(x: &str) -> u8 { let s = r#"// q"#; b\'x\' }\n'],
        [false, '// why\n'],
        [true, "fn g<'a>() {}\n"],
        [false, '/* note */'],
      ],
    ],
    [
      'typescript',
      'a.tsx',
      [
        [true, 'const r = /[/*]/g;\nconst s = `a${b}c`;\n'],
        [false, '// why\n'],
        [true, 'const e = <p>t</p>;\n'],
        [false, '/* note */'],
      ],
    ],
    [
      'yaml',
      'a.yml',
      [
        [true, 'a: 1\nb: "x"\nc: |\n  # body\n'],
        [false, '# why\n'],
        [true, 'd: [1, 2]\n'],
      ],
    ],
    [
      'toml',
      'a.toml',
      [
        [true, '[a]\nb = "x"\nc = [1, 2]\n'],
        [false, '# why\n'],
        [true, "d = 'q'\n"],
      ],
    ],
  ];
  const join = (cs: [boolean, string][]) => cs.map(([, t]) => t).join('');
  it.each(samples)(
    '%s: the sample reads, and every one-character change in its code is not proven',
    (lang, path, chunks) => {
      const base = join(chunks);
      expect(codeOf(base, lang, path), lang).toBeDefined();
      yes(
        lang,
        base,
        join(chunks.map(([c, t]) => [c, c ? t : t.replace('why', 'how').replace('note', 'text')])),
        path,
      );
      for (const [k, [code, text]] of chunks.entries()) {
        if (!code) continue;
        for (let i = 0; i < text.length; i++) {
          const c = text[i] as string;
          if (/\s/.test(c)) continue;
          const replacement = c === 'Q' ? 'R' : 'Q';
          const changed = chunks.map(([cd, t], j): [boolean, string] =>
            j === k ? [cd, t.slice(0, i) + replacement + t.slice(i + 1)] : [cd, t],
          );
          expect(commentsOnly(base, join(changed), lang, path), `${lang} at ${k}:${i} (${c})`).toBe(
            false,
          );
        }
      }
    },
  );
});

describe('the tokenizers are linear', () => {
  const size = 2 * 1024 * 1024;
  const fill = (unit: string) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  const nl = (unit: string) =>
    unit
      .repeat(Math.ceil(size / unit.length))
      .slice(0, size)
      .replace(/[^\n]*$/, '');
  it.each([
    ['rust', 'a.rs', nl('let s = "a"; // c\n/* b /* n */ */ x\n')],
    ['typescript', 'a.tsx', nl('const a = `x${b}`; // c\nf(<p>{x}</p>, /r/g);\n')],
    ['javascript', 'a.js', fill('/* */')],
    ['yaml', 'a.yml', nl('- a: "x" # c\n  b: [1, 2]\n')],
    ['toml', 'a.toml', nl('a = "x" # c\n')],
  ] as [ProofLanguage, string, string][])(
    '2 MB of %s finish in under two seconds',
    (lang, path, text) => {
      const started = performance.now();
      codeOf(text, lang, path);
      expect(performance.now() - started).toBeLessThan(2000);
    },
  );
  it('deep nesting is refused, not a stack overflow', () => {
    unsure('typescript', `${'`${'.repeat(5000)}${'}`'.repeat(5000)}`);
    unsure('typescript', `x = ${'<a>'.repeat(5000)}${'</a>'.repeat(5000)};`, 'a.tsx');
  });
});
