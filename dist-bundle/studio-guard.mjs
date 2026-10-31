import { createRequire as __studioCreateRequire } from 'node:module';
const require = __studioCreateRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/.pnpm/shell-quote@1.12.0/node_modules/shell-quote/quote.js
var require_quote = __commonJS({
  "node_modules/.pnpm/shell-quote@1.12.0/node_modules/shell-quote/quote.js"(exports, module) {
    "use strict";
    var OPS = (
      /** @type {const} */
      [
        "||",
        "&&",
        ";;&",
        ";;",
        ";&",
        "|&",
        "<(",
        ">(",
        "<<<",
        "<<-",
        "<<",
        ">>",
        ">&",
        ">|",
        "&>>",
        "&>",
        "<&",
        "<>",
        "&",
        ";",
        "(",
        ")",
        "|",
        "<",
        ">"
      ]
    );
    var LINE_TERMINATORS = /[\n\r\u2028\u2029]/;
    var GLOB_SHELL_SPECIAL = /[\s#!"$&'():;<=>@\\^`|~]/g;
    module.exports = function quote(xs) {
      var sawComment = false;
      return xs.map(function(s) {
        if (sawComment && typeof s === "string" && LINE_TERMINATORS.test(s)) {
          throw new TypeError("a token after a `comment` must not contain line terminators");
        }
        if (s === "") {
          return (
            /** @type {const} */
            "''"
          );
        }
        if (s && typeof s === "object") {
          if ("op" in s && s.op === "glob") {
            if (typeof s.pattern !== "string") {
              throw new TypeError("glob token requires a string `pattern`");
            }
            if (LINE_TERMINATORS.test(s.pattern)) {
              throw new TypeError("glob `pattern` must not contain line terminators");
            }
            if (s.pattern === "") {
              return (
                /** @type {const} */
                "''"
              );
            }
            return s.pattern.replace(GLOB_SHELL_SPECIAL, "\\$&");
          }
          if ("op" in s && typeof s.op === "string") {
            if (OPS.indexOf(s.op) < 0) {
              throw new TypeError("invalid `op` value: " + JSON.stringify(s.op));
            }
            return s.op.replace(/[\s\S]/g, "\\$&");
          }
          if ("comment" in s && typeof s.comment === "string") {
            if (LINE_TERMINATORS.test(s.comment)) {
              throw new TypeError("`comment` must not contain line terminators");
            }
            sawComment = true;
            return "#" + s.comment;
          }
          throw new TypeError("unrecognized object token shape");
        }
        if (/'/.test(s) && /!/.test(s)) {
          return "'" + s.replace(/'/g, `'"'"'`) + "'";
        }
        if (/["\s\\]/.test(s) && !/'/.test(s)) {
          return "'" + s + "'";
        }
        if (/["'\s]/.test(s)) {
          return '"' + s.replace(/(["\\$`])/g, "\\$1") + '"';
        }
        return String(s).replace(/([A-Za-z]:)?([#!"$&'()*,:;<=>?@[\\\]^`{|}~])/g, "$1\\$2");
      }).join(" ");
    };
  }
});

// node_modules/.pnpm/shell-quote@1.12.0/node_modules/shell-quote/parse.js
var require_parse = __commonJS({
  "node_modules/.pnpm/shell-quote@1.12.0/node_modules/shell-quote/parse.js"(exports, module) {
    "use strict";
    var CONTROL = (
      /** @type {const} */
      "(?:" + /** @type {const} */
      [
        "\\|\\|",
        "\\&(?:\\&|>>?)",
        // `&&`, `&>`, and `&>>`
        ";;\\&?",
        // `;;` and `;;&`
        "[;|]\\&",
        // `;&` and `|&`
        "\\<\\(",
        "\\<\\<\\<",
        "\\<\\<-",
        "\\<\\<(?!\\()",
        // `<<(` stays `<` and `<(`, as zsh reads it; other shells reject it
        ">>",
        ">[&|(]",
        // `>&`, `>|`, and `>(`
        "<[&>]",
        // `<&` and `<>`
        "[&;()|<>]"
      ].join(
        /** @type {const} */
        "|"
      ) + /** @type {const} */
      ")"
    );
    var controlRE = new RegExp("^" + CONTROL + "$");
    var META = (
      /** @type {const} */
      "|&;()<> \\t"
    );
    var SINGLE_QUOTE = (
      /** @type {const} */
      "'([^']*?)'"
    );
    var ANSI_C_BODY = "(?:\\\\[\\s\\S]|[^\\\\'])*?";
    var ANSI_C_QUOTE = "\\$'" + ANSI_C_BODY + "'";
    var ansiCAt = new RegExp("\\$'" + ANSI_C_BODY + "(?:(')|\\\\?$)", "g");
    var ANSI_C_LETTERS = "abeEfnrtv";
    var ANSI_C_CHARS = "\x07\b\x1B\x1B\f\n\r	\v";
    var hash = /^#$/;
    var SQ = (
      /** @type {const} */
      "'"
    );
    var DQ = (
      /** @type {const} */
      '"'
    );
    var DS = (
      /** @type {const} */
      "$"
    );
    var TOKEN = "";
    var mult = (
      /** @type {const} */
      4294967296
    );
    for (i = 0; i < 4; i++) {
      TOKEN += (mult * Math.random()).toString(16);
    }
    var i;
    var startsWithToken = new RegExp("^" + TOKEN);
    function matchAll(s, r) {
      var origIndex = r.lastIndex;
      var matches = [];
      var matchObj;
      while (matchObj = r.exec(s)) {
        matches[matches.length] = matchObj;
        if (r.lastIndex === matchObj.index) {
          r.lastIndex += 1;
        }
      }
      r.lastIndex = origIndex;
      return matches;
    }
    function getVar(env, pre, key) {
      var r = typeof env === "function" ? env(key) : env[key];
      if (typeof r === "undefined" && key != "") {
        r = "";
      } else if (typeof r === "undefined") {
        r = "$";
      }
      if (typeof r === "object") {
        return pre + TOKEN + JSON.stringify(r) + TOKEN;
      }
      return pre + r;
    }
    var ansiCEscape = /\\([0-7]{1,3}|x[\dA-Fa-f]{1,2}|u[\dA-Fa-f]{1,4}|U[\dA-Fa-f]{1,8}|c(?:\\\\|[\s\S])|[abeEfnrtv\\'"?])/g;
    function expandAnsiCEscape(m, escape) {
      var kind = escape.charAt(0);
      if (kind === "c") {
        var ctrl = escape.charAt(1);
        return ctrl === "?" ? "\x7F" : String.fromCharCode(ctrl.charCodeAt(0) & 31);
      }
      if (kind === "x" || kind === "u" || kind === "U") {
        var cp = parseInt(escape.slice(1), 16);
        if (cp > 1114111) {
          return m;
        }
        return String.fromCharCode.apply(null, cp > 65535 ? [55232 + (cp >> 10), 56320 + (cp & 1023)] : [cp]);
      }
      if (kind >= "0" && kind <= "7") {
        return String.fromCharCode(parseInt(escape, 8) & 255);
      }
      var letter = ANSI_C_LETTERS.indexOf(escape);
      return letter < 0 ? escape : ANSI_C_CHARS.charAt(letter);
    }
    function expandAnsiC(body) {
      return body.replace(ansiCEscape, expandAnsiCEscape).split("\0")[0];
    }
    function closesAnsiC(s, i2) {
      ansiCAt.lastIndex = i2;
      return !!/** @type {RegExpExecArray} */
      ansiCAt.exec(s)[1];
    }
    function parseInternal(string, env, opts) {
      if (!opts) {
        opts = {};
      }
      var BS = opts.escape || "\\";
      var ifs = opts.splitUnquoted === true ? " 	\n" : typeof opts.splitUnquoted === "string" ? opts.splitUnquoted : "";
      var BAREWORD = "(\\" + BS + `['"$\\` + BS + META + "]|\\$\\$|\\$(?!" + ANSI_C_QUOTE.slice(2) + `)|[^\\s'"$` + META + "])+";
      var DOUBLE_QUOTE = '"(?:\\' + BS + '[\\s\\S]|[^"\\' + BS + '])*"';
      var chunker = new RegExp([
        "(" + CONTROL + ")",
        // control chars
        "(" + ANSI_C_QUOTE + "|" + BAREWORD + "|" + DOUBLE_QUOTE + "|" + SINGLE_QUOTE + ")+"
      ].join("|"), "g");
      var matches = matchAll(string, chunker);
      if (matches.length === 0) {
        return [];
      }
      if (!env) {
        env = {};
      }
      var commented = false;
      return matches.map(function(match) {
        var s = match[0];
        if (!s || commented) {
          return void 0;
        }
        if (controlRE.test(s)) {
          return (
            /** @type {ControlOperator} */
            { op: s }
          );
        }
        var quote = false;
        var esc = false;
        var out = "";
        var words = [];
        var sawQuote = false;
        var pendingNw = null;
        var isGlob = false;
        var i2;
        function parseEnvVar() {
          i2 += 1;
          var varend;
          var varname;
          var char = s.charAt(i2);
          if (char === "{") {
            i2 += 1;
            if (s.charAt(i2) === "}") {
              throw new Error("Bad substitution: " + s.slice(i2 - 2, i2 + 1));
            }
            var depth = 1;
            varend = i2;
            while (depth > 0 && varend < s.length) {
              if (s.charAt(varend) === "{" && s.charAt(varend - 1) === "$") {
                depth += 1;
              } else if (s.charAt(varend) === "}") {
                depth -= 1;
              }
              varend += 1;
            }
            if (depth !== 0) {
              throw new Error("Bad substitution: " + s.slice(i2));
            }
            varend -= 1;
            varname = s.slice(i2, varend);
            i2 = varend;
          } else if (/[*@#?$!-]/.test(char)) {
            varname = char;
          } else {
            var slicedFromI = s.slice(i2);
            varend = slicedFromI.match(/[^\w\d_]/);
            if (!varend) {
              varname = slicedFromI;
              i2 = s.length;
            } else {
              varname = slicedFromI.slice(0, varend.index);
              i2 += /** @type {number} */
              varend.index - 1;
            }
          }
          return getVar(
            /** @type {NonNullable<typeof env>} */
            env,
            "",
            varname
          );
        }
        function flushRun() {
          if (pendingNw === null) {
            return;
          }
          if (pendingNw === 0) {
            if (out !== "") {
              words[words.length] = out;
              out = "";
            }
          } else {
            words[words.length] = out;
            out = "";
            for (var fe = 1; fe < pendingNw; fe += 1) {
              words[words.length] = "";
            }
          }
          pendingNw = null;
        }
        for (i2 = 0; i2 < s.length; i2++) {
          var c = s.charAt(i2);
          if (ifs && c !== DS) {
            flushRun();
          }
          isGlob = isGlob || !quote && (c === "*" || c === "?");
          if (esc) {
            out += c;
            esc = false;
          } else if (quote) {
            if (c === quote) {
              quote = false;
            } else if (quote == SQ) {
              out += c;
            } else {
              if (c === BS) {
                i2 += 1;
                c = s.charAt(i2);
                if (c === DQ || c === BS || c === DS) {
                  out += c;
                } else {
                  out += BS + c;
                }
              } else if (c === DS) {
                out += parseEnvVar();
              } else {
                out += c;
              }
            }
          } else if (c === DQ || c === SQ) {
            quote = c;
            sawQuote = true;
          } else if (controlRE.test(c)) {
            return (
              /** @type {ControlOperator} */
              { op: s }
            );
          } else if (hash.test(c)) {
            commented = true;
            var commentObj = { comment: string.slice(match.index + i2 + 1) };
            if (out.length) {
              return (
                /** @type {const} */
                [out, commentObj]
              );
            }
            return (
              /** @type {const} */
              [commentObj]
            );
          } else if (c === BS) {
            esc = true;
          } else if (c === DS && s.charAt(i2 + 1) === SQ && closesAnsiC(s, i2)) {
            flushRun();
            sawQuote = true;
            out += expandAnsiC(s.slice(i2 + 2, ansiCAt.lastIndex - 1));
            i2 = ansiCAt.lastIndex - 1;
          } else if (c === DS) {
            var value = parseEnvVar();
            if (!ifs) {
              out += value;
            } else {
              for (var vi = 0; vi < value.length; vi += 1) {
                var vc = value.charAt(vi);
                if (ifs.indexOf(vc) < 0) {
                  flushRun();
                  out += vc;
                } else if (pendingNw === null) {
                  pendingNw = vc === " " || vc === "	" || vc === "\n" ? 0 : 1;
                } else if (vc !== " " && vc !== "	" && vc !== "\n") {
                  pendingNw += 1;
                }
              }
            }
          } else {
            out += c;
          }
        }
        if (isGlob) {
          return (
            /** @type {GlobPattern} */
            { op: "glob", pattern: out }
          );
        }
        if (ifs) {
          if (pendingNw !== null && pendingNw > 0) {
            words[words.length] = out;
            out = "";
            for (var te = 1; te < pendingNw; te += 1) {
              words[words.length] = "";
            }
          }
          if (out !== "" || sawQuote && words.length === 0) {
            words[words.length] = out;
          }
          return words;
        }
        return out;
      }).reduce(
        function(prev, arg) {
          if (typeof arg === "undefined") {
            return prev;
          }
          [].concat(arg).forEach(function(entry) {
            prev[prev.length] = entry;
          });
          return prev;
        },
        /** @type {ParseEntry[]} */
        []
      );
    }
    module.exports = function parse(s, env, opts) {
      var mapped = parseInternal(s, env, opts);
      if (typeof env !== "function") {
        return mapped;
      }
      return mapped.reduce(
        function(acc, s2) {
          if (typeof s2 === "object") {
            acc[acc.length] = s2;
            return acc;
          }
          var xs = s2.split(RegExp("(" + TOKEN + ".*?" + TOKEN + ")", "g"));
          if (xs.length === 1) {
            acc[acc.length] = xs[0];
            return acc;
          }
          xs.filter(Boolean).forEach(function(x) {
            acc[acc.length] = startsWithToken.test(x) ? JSON.parse(x.split(TOKEN)[1]) : x;
          });
          return acc;
        },
        /** @type {ParseEntry[]} */
        []
      );
    };
  }
});

// node_modules/.pnpm/shell-quote@1.12.0/node_modules/shell-quote/index.js
var require_shell_quote = __commonJS({
  "node_modules/.pnpm/shell-quote@1.12.0/node_modules/shell-quote/index.js"(exports) {
    "use strict";
    exports.quote = require_quote();
    exports.parse = require_parse();
  }
});

// src/guard-main.ts
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join as join2 } from "node:path";

// src/guard.ts
var import_shell_quote = __toESM(require_shell_quote(), 1);
import { globSync, lstatSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
var GUARD_LIMITS = { glob: 1e3, walk: 5e4 };
var Deny = class extends Error {
};
var deny = (reason) => {
  throw new Deny(reason);
};
var SUBST = "";
function evaluateGuard(input, ctx) {
  try {
    check(input, ctx);
    return { decision: "allow" };
  } catch (err) {
    if (err instanceof Deny) return { decision: "deny", reason: err.message };
    return {
      decision: "deny",
      reason: `guard error: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}
function escapeRe(s) {
  return s.replace(/[.+^${}()|[\]\\*?]/g, "\\$&");
}
function fileGlobToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; ) {
    if (glob.startsWith("**/", i)) {
      re += "(?:.*/)?";
      i += 3;
    } else if (glob.startsWith("**", i)) {
      re += ".*";
      i += 2;
    } else if (glob[i] === "*") {
      re += "[^/]*";
      i++;
    } else if (glob[i] === "?") {
      re += "[^/]";
      i++;
    } else {
      re += escapeRe(glob[i]);
      i++;
    }
  }
  return new RegExp(`^${glob.startsWith("/") ? "" : "(?:.*/)?"}${re}$`, "i");
}
function commandGlobToRegExp(glob) {
  return new RegExp(`^${glob.split("*").map(escapeRe).join(".*")}$`);
}
function isSecretString(env, s) {
  if (basename(s) === ".env.example") return false;
  return env.secretRes.some((re) => re.test(s));
}
function braceExpand(s, budget = { n: 64 }) {
  const open = s.indexOf("{");
  if (open < 0) return [s];
  let depth = 0;
  const commas = [];
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        if (commas.length === 0) return [s];
        const parts = [];
        let from = open + 1;
        for (const at of [...commas, i]) {
          parts.push(s.slice(from, at));
          from = at + 1;
        }
        const out = [];
        for (const p of parts) {
          for (const rest of braceExpand(s.slice(0, open) + p + s.slice(i + 1), budget)) {
            if (--budget.n < 0) deny("brace expansion too large");
            out.push(rest);
          }
        }
        return out;
      }
    } else if (c === "," && depth === 1) commas.push(i);
  }
  return [s];
}
function resolveReal(p, base) {
  const start = isAbsolute(p) ? p : `${base}/${p}`;
  const queue = start.split("/").filter((x) => x !== "" && x !== ".");
  let cur = "/";
  let missing = false;
  let hops = 0;
  while (queue.length > 0) {
    const seg = queue.shift();
    if (seg === "..") {
      cur = dirname(cur);
      continue;
    }
    const next = cur === "/" ? `/${seg}` : `${cur}/${seg}`;
    if (missing) {
      cur = next;
      continue;
    }
    let st;
    try {
      st = lstatSync(next);
    } catch {
      missing = true;
      cur = next;
      continue;
    }
    if (st.isSymbolicLink()) {
      if (++hops > 40) deny("too many symlinks");
      const target = readlinkSync(next);
      if (isAbsolute(target)) cur = "/";
      queue.unshift(...target.split("/").filter((x) => x !== "" && x !== "."));
      continue;
    }
    cur = next;
  }
  return cur;
}
function isInside(env, real) {
  return real === env.wt || real.startsWith(`${env.wt}/`);
}
var ALLOWED_DEVICES = /* @__PURE__ */ new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);
var hasMagic = (t) => /[*?[]/.test(t);
function capped(paths) {
  if (paths.length > GUARD_LIMITS.glob) deny("glob expands to too many paths");
  return paths;
}
function expandGlobPath(t, base) {
  const out = [t];
  if (!hasMagic(t)) return out;
  const idx = t.lastIndexOf("/");
  const dirPart = idx > 0 ? t.slice(0, idx) : idx === 0 ? "/" : "";
  const leaf = t.slice(idx + 1);
  let dirs = [dirPart];
  try {
    if (dirPart !== "" && hasMagic(dirPart)) dirs = capped(globSync(dirPart, { cwd: base }));
    for (const d of dirs) {
      if (hasMagic(leaf)) {
        const where = d === "" ? base : resolveReal(d, base);
        for (const m of capped(globSync(leaf, { cwd: where }))) out.push(join(d, m));
      } else out.push(join(d, leaf));
    }
  } catch (err) {
    if (err instanceof Deny) throw err;
    deny(`unexpandable glob in write path: ${t}`);
  }
  return out;
}
function isProtected(env, real) {
  const low = real.toLowerCase();
  return env.protectedReal.some((p) => low === p || low.startsWith(`${p}/`));
}
function checkWritePath(env, tok, cwd, why) {
  if (ALLOWED_DEVICES.has(tok)) return;
  for (const t0 of braceExpand(tok)) {
    if (t0.includes(SUBST) || t0.includes("$") || t0.includes("`") || t0.startsWith("~")) {
      deny(`unresolvable path in ${why}: ${t0.replaceAll(SUBST, "<runtime>")}`);
    }
    if (t0 === "") deny(`empty path in ${why}`);
    if (cwd === null && !isAbsolute(t0)) {
      deny(`relative path after unresolvable cd in ${why}: ${t0}`);
    }
    for (const t of expandGlobPath(t0, cwd ?? env.wt)) {
      const real = resolveReal(t, cwd ?? env.wt);
      if (!isInside(env, real)) deny(`write outside worktree (${why}): ${t}`);
      if (isProtected(env, real)) deny(`write to protected path (${why}): ${t}`);
    }
  }
}
function checkSecretPath(env, tok, base) {
  const lexical = isAbsolute(tok) ? normalize(tok) : normalize(join(base, tok));
  if (isSecretString(env, tok) || isSecretString(env, lexical)) {
    deny(`secret file access: ${tok}`);
  }
  if (isSecretString(env, resolveReal(tok, base))) deny(`secret file access: ${tok}`);
}
function checkSecretToken(env, tok, base) {
  if (tok === "" || tok.length > 4096 || /\s/.test(tok)) return;
  const eq = tok.indexOf("=");
  const variants = eq > 0 ? [tok, tok.slice(eq + 1)] : [tok];
  for (const v of variants) {
    for (const e of braceExpand(v)) {
      if (e === "" || e.includes(SUBST)) continue;
      checkSecretPath(env, e, base);
      if (/[*?[]/.test(e)) {
        let matches = [];
        try {
          matches = capped(globSync(e, { cwd: base }));
        } catch (err) {
          if (err instanceof Deny) throw err;
        }
        for (const m of matches) checkSecretPath(env, m, base);
      }
    }
  }
}
function matchParen(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") i++;
    else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) deny("unparseable command");
      i = j;
    } else if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\") i++;
        else if (src[i] === "$" && src[i + 1] === "(") i = matchParen(src, i + 1);
        i++;
      }
      if (i >= src.length) deny("unparseable command");
    } else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return deny("unparseable command");
}
function matchBacktick(src, open) {
  for (let i = open + 1; i < src.length; i++) {
    if (src[i] === "\\") i++;
    else if (src[i] === "`") return i;
  }
  return deny("unparseable command");
}
function bodySubstitutions(body, subs) {
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\") i++;
    else if (body[i] === "`") {
      const end = matchBacktick(body, i);
      subs.push(body.slice(i + 1, end));
      i = end;
    } else if (body[i] === "$" && body[i + 1] === "(") {
      let depth = 0;
      let j = i + 1;
      for (; j < body.length; j++) {
        if (body[j] === "(") depth++;
        else if (body[j] === ")" && --depth === 0) break;
      }
      if (j >= body.length) deny("unparseable command");
      subs.push(body.slice(i + 2, j));
      i = j;
    }
  }
}
function scan(src) {
  const lines = [];
  const subs = [];
  const heredocs = [];
  let out = "";
  let wordStart = true;
  let i = 0;
  const n = src.length;
  const consumeHeredocs = () => {
    for (const h of heredocs.splice(0)) {
      const body = [];
      while (i < n) {
        let end = src.indexOf("\n", i);
        if (end < 0) end = n;
        let line = src.slice(i, end);
        i = Math.min(end + 1, n);
        if (h.strip) line = line.replace(/^\t+/, "");
        if (line === h.delim) break;
        body.push(line);
      }
      if (!h.quoted) bodySubstitutions(body.join("\n"), subs);
    }
  };
  while (i < n) {
    const c = src[i];
    if (c === "\\") {
      if (i + 1 >= n) {
        out += "\\\\";
        i++;
      } else if (src[i + 1] === "\n") i += 2;
      else {
        out += c + src[i + 1];
        i += 2;
      }
      wordStart = false;
    } else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) deny("unparseable command");
      out += src.slice(i, j + 1);
      i = j + 1;
      wordStart = false;
    } else if (c === '"') {
      let j = i + 1;
      let seg = '"';
      for (; ; ) {
        if (j >= n) deny("unparseable command");
        const d = src[j];
        if (d === "\\") {
          seg += d + (src[j + 1] ?? "");
          j += 2;
        } else if (d === '"') {
          seg += '"';
          j++;
          break;
        } else if (d === "$" && src[j + 1] === "(") {
          const end = matchParen(src, j + 1);
          subs.push(src.slice(j + 2, end));
          seg += SUBST;
          j = end + 1;
        } else if (d === "`") {
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
    } else if (c === "$" && src[i + 1] === "(") {
      const end = matchParen(src, i + 1);
      subs.push(src.slice(i + 2, end));
      out += SUBST;
      i = end + 1;
      wordStart = false;
    } else if (c === "`") {
      const end = matchBacktick(src, i);
      subs.push(src.slice(i + 1, end));
      out += SUBST;
      i = end + 1;
      wordStart = false;
    } else if ((c === "<" || c === ">") && src[i + 1] === "(") {
      const end = matchParen(src, i + 1);
      subs.push(src.slice(i + 2, end));
      out += SUBST;
      i = end + 1;
      wordStart = false;
    } else if (c === "<" && src[i + 1] === "<" && src[i + 2] !== "<") {
      let j = i + 2;
      const strip = src[j] === "-";
      if (strip) j++;
      while (src[j] === " " || src[j] === "	") j++;
      let delim = "";
      let quoted = false;
      while (j < n && !/[\s;&|<>()]/.test(src[j])) {
        const d = src[j];
        if (d === "\\") {
          quoted = true;
          delim += src[j + 1] ?? "";
          j += 2;
        } else if (d === "'") {
          quoted = true;
          const e = src.indexOf("'", j + 1);
          if (e < 0) deny("unparseable command");
          delim += src.slice(j + 1, e);
          j = e + 1;
        } else if (d === '"') {
          quoted = true;
          j++;
          while (j < n && src[j] !== '"') {
            if (src[j] === "\\" && /["\\$`]/.test(src[j + 1] ?? "")) j++;
            delim += src[j] ?? "";
            j++;
          }
          if (j >= n) deny("unparseable command");
          j++;
        } else {
          delim += d;
          j++;
        }
      }
      heredocs.push({ delim, quoted, strip });
      out += "<< HEREDOC";
      i = j;
      wordStart = false;
    } else if (c === "\n") {
      lines.push(out);
      out = "";
      i++;
      consumeHeredocs();
      wordStart = true;
    } else if (c === "#") {
      if (wordStart) {
        while (i < n && src[i] !== "\n") i++;
      } else {
        out += "\\#";
        i++;
      }
    } else {
      out += c;
      i++;
      wordStart = /[\s;&|()<>]/.test(c);
    }
  }
  if (out !== "") lines.push(out);
  return { lines, subs };
}
var SEPARATORS = /* @__PURE__ */ new Set(["&&", "||", ";", ";;", "|", "|&", "&", "(", ")", "<("]);
function wordOf(entry) {
  if (typeof entry === "string") return entry;
  if (entry && "op" in entry && entry.op === "glob") return entry.pattern;
  return void 0;
}
function toSegments(line) {
  const toks = (0, import_shell_quote.parse)(line, (key) => `$${key}`);
  const segments = [];
  let cur = { words: [], writes: [], reads: [] };
  const push = () => {
    if (cur.words.length || cur.writes.length || cur.reads.length) segments.push(cur);
    cur = { words: [], writes: [], reads: [] };
  };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    const word = wordOf(t);
    if (word !== void 0) {
      cur.words.push(word);
    } else if (typeof t !== "object") {
    } else if ("comment" in t) {
    } else if ("op" in t) {
      if (SEPARATORS.has(t.op)) {
        push();
      } else if (t.op === "<<" || t.op === "<<<") {
        k++;
      } else if (t.op === "<") {
        const target = wordOf(toks[++k]);
        if (target === void 0) deny("unparseable command");
        cur.reads.push(target);
      } else if ([">", ">>", ">|", "&>", "&>>", ">&", "<>"].includes(t.op)) {
        const target = wordOf(toks[++k]);
        if (target === void 0) deny("unparseable command");
        if (t.op === ">&" && /^(\d+|-)$/.test(target)) continue;
        cur.writes.push(target);
      } else {
        deny(`unparseable command (operator ${t.op})`);
      }
    }
  }
  push();
  return segments;
}
var WRAPPER_WORDS = /* @__PURE__ */ new Set([
  "{",
  "}",
  "!",
  "then",
  "do",
  "else",
  "elif",
  "if",
  "while",
  "until"
]);
var DENIED_WRAPPERS = /* @__PURE__ */ new Set([
  "stdbuf",
  "ionice",
  "chrt",
  "setsid",
  "unbuffer",
  "coproc",
  "doas",
  "run0",
  "pkexec",
  "shopt",
  "nice",
  "xargs",
  "eval",
  "source",
  ".",
  "mapfile",
  "readarray",
  "getopts"
]);
var VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
var LOOSE_ASSIGNMENT = /^([^=\s/]+)=/;
function assignmentName(w) {
  const m = LOOSE_ASSIGNMENT.exec(w);
  if (!m) return void 0;
  const name = m[1];
  if (!VAR_NAME.test(name))
    deny(`assignment to "${name}" is not allowed (plain variable names only)`);
  return name;
}
var SENSITIVE_VAR = /^(GIT_|GH_|GITHUB_|LD_|DYLD_|CDPATH$|PATH$|HOME$|BASH_ENV$|ENV$|SHELLOPTS$|BASHOPTS$|PROMPT_COMMAND$|IFS$)/;
var unresolved = (w) => w.includes(SUBST) || w.includes("$") || w.includes("`");
var unresolvedWord = (w) => unresolved(w) || /[*?[]/.test(w) && w !== "[" && w !== "[[";
function checkVarName(name) {
  if (SENSITIVE_VAR.test(name)) deny(`setting ${name} is not allowed`);
}
function checkAssignment(_state, a) {
  const name = assignmentName(a);
  if (name !== void 0) checkVarName(name);
}
function noOption(words, i, what) {
  if ((words[i] ?? "").startsWith("-")) deny(`${what} with options is not allowed`);
}
function skipWrappers(words, state) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (assignmentName(w) !== void 0) {
      checkAssignment(state, w);
      i++;
      continue;
    }
    const b = basename(w);
    if (WRAPPER_WORDS.has(b)) {
      i++;
      continue;
    }
    if (b === "env") deny("env wrapper denied; use NAME=value cmd");
    if (DENIED_WRAPPERS.has(b)) deny(`${b} is not allowed`);
    switch (b) {
      case "time":
      case "command":
      case "builtin":
      case "exec":
      case "nohup":
        noOption(words, i + 1, b);
        i++;
        break;
      case "timeout":
        noOption(words, i + 1, "timeout");
        if (!/^\d+(\.\d+)?[smhd]?$/.test(words[i + 1] ?? ""))
          deny("timeout needs a plain duration");
        noOption(words, i + 2, "timeout");
        i += 2;
        break;
      default:
        return i;
    }
  }
  return i;
}
function positionals(args) {
  const out = [];
  let end = false;
  for (const a of args) {
    if (!end && a === "--") end = true;
    else if (!end && a.startsWith("-") && a !== "-") continue;
    else out.push(a);
  }
  return out;
}
function optionValues(args, short, long) {
  const out = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (short.includes(a) || long.includes(a)) {
      if (k + 1 < args.length) out.push(args[k + 1]);
      else deny(`missing value for ${a}`);
      k++;
    } else {
      for (const l of long) if (a.startsWith(`${l}=`)) out.push(a.slice(l.length + 1));
    }
  }
  return out;
}
var WRITE_ALL = /* @__PURE__ */ new Set([
  "rm",
  "rmdir",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "chgrp",
  "truncate",
  "ln",
  "tee",
  "unlink",
  "shred",
  "mv",
  "install"
]);
function writeTargets(name, args) {
  const pos = positionals(args);
  const targetDirs = optionValues(args, ["-t"], ["--target-directory"]);
  if (WRITE_ALL.has(name)) return [...pos, ...targetDirs];
  switch (name) {
    case "cp":
      return targetDirs.length > 0 ? targetDirs : pos.slice(-1);
    case "rsync":
      return pos.slice(-1);
    case "dd":
      return args.filter((a) => a.startsWith("of=")).map((a) => a.slice(3));
    case "sed": {
      const inPlace = args.some(
        (a) => a === "-i" || /^-i/.test(a) || /^--in-place/.test(a) || /^-[A-Za-z]*i[A-Za-z]*$/.test(a)
      );
      if (!inPlace) return [];
      const hasScriptOpt = args.some((a) => /^(-[A-Za-z]*[ef]|--expression|--file)/.test(a));
      return hasScriptOpt ? pos : pos.slice(1);
    }
    case "curl":
      return optionValues(args, ["-o"], ["--output", "--output-dir"]);
    case "wget":
      return optionValues(args, ["-O", "-P"], ["--output-document", "--directory-prefix"]);
    case "tar":
      return optionValues(args, ["-C"], ["--directory"]);
    default:
      return [];
  }
}
var GH_VALUE_FLAGS = ["-R", "--repo", "--hostname"];
function stripGhFlags(args) {
  const out = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (GH_VALUE_FLAGS.includes(a)) k++;
    else if (a.startsWith("--repo=") || a.startsWith("--hostname=")) continue;
    else out.push(a);
  }
  return out;
}
function checkCommandGlobs(env, fromCommand, raw) {
  const head = basename(fromCommand[0]);
  const rest = fromCommand.slice(1);
  const normal = [head, ...head === "gh" ? stripGhFlags(rest) : rest];
  const texts = /* @__PURE__ */ new Set([raw.join(" "), fromCommand.join(" "), normal.join(" ")]);
  for (const text of texts) {
    for (const g of env.ownerGlobs) {
      if (g.re.test(text)) deny(`owner-only command (matches "${g.glob}")`);
    }
    for (const g of env.deployGlobs) {
      if (g.re.test(text)) deny(`deploy command (matches "${g.glob}")`);
    }
  }
}
var PUSH_DANGEROUS = [
  "--force",
  "--force-with-lease",
  "--force-if-includes",
  "--mirror",
  "--delete",
  "--prune",
  "--all",
  // tags would push refs the crew did not name; receive-pack/exec run a program on the remote side
  "--tags",
  "--follow-tags",
  "--receive-pack",
  "--exec"
];
var normRef = (r) => r.replace(/^refs\//, "").replace(/^heads\//, "").toLowerCase();
function checkRefspec(env, ref) {
  if (ref === "") deny("git push with empty refspec");
  if (ref.startsWith("+")) deny(`git push with force refspec "${ref}"`);
  if (ref.startsWith(":")) deny(`git push deleting remote ref "${ref}"`);
  const colon = ref.lastIndexOf(":");
  if (colon < 0 && (ref === "HEAD" || ref === "@")) {
    deny(`git push "${ref}" needs an explicit destination (HEAD:refs/heads/<branch>)`);
  }
  const dest = colon < 0 ? ref : ref.slice(colon + 1);
  if (dest === "" || dest === "HEAD" || dest === "@" || dest.startsWith("+")) {
    deny(`git push with unclear destination "${ref}"`);
  }
  if (/^refs\/(?!heads\/)/i.test(dest)) deny(`git push to non-branch ref "${dest}"`);
  const norm = dest.replace(/^refs\//, "").replace(/^heads\//, "").toLowerCase();
  if (norm === "main" || norm === "master") deny(`git push to protected branch "${norm}"`);
  if (env.allowedRefs.some((r) => normRef(r) === norm)) {
    deny(`git push to workflow ref "${norm}" is not allowed`);
  }
}
function checkPush(env, rawArgs) {
  const args = rawArgs.flatMap((a) => braceExpand(a));
  for (const a of args) {
    if (unresolved(a)) deny(`unresolved git push argument: ${a.replaceAll(SUBST, "<runtime>")}`);
    if (hasMagic(a)) deny(`glob in git push argument: ${a}`);
  }
  const pos = [];
  let repoGiven = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "--") {
      pos.push(...args.slice(k + 1));
      break;
    }
    if (a.startsWith("--")) {
      const name = a.split("=")[0];
      if (name.length >= 3 && PUSH_DANGEROUS.some((d) => d.startsWith(name))) {
        deny(`git push ${name} is not allowed`);
      }
      if (name === "--repo") repoGiven = true;
      if (!a.includes("=") && ["--repo", "--push-option"].includes(name)) {
        k++;
      }
    } else if (/^-[A-Za-z]+$/.test(a)) {
      if (/[fd]/.test(a)) deny(`git push ${a} is not allowed`);
      if (a.endsWith("o")) k++;
    } else pos.push(a);
  }
  const refs = repoGiven ? pos : pos.slice(1);
  if (pos.length === 0) deny("git push needs an explicit remote and branch");
  if (refs.length === 0) deny("git push needs an explicit refspec");
  for (const ref of refs) checkRefspec(env, ref);
}
var GIT_C_ALLOWED = /^(user\.name|user\.email|commit\.gpgsign|color\.ui|advice\..+)$/i;
var GIT_CONFIG_READ = ["--get", "--get-all", "--get-regexp", "--list", "-l"];
var GIT_CONFIG_WRITE = [
  "--add",
  "--replace-all",
  "--unset",
  "--unset-all",
  "--edit",
  "-e",
  "--rename-section",
  "--remove-section",
  "-f",
  "--file",
  "--blob"
];
function checkGitC(kv) {
  const key = kv.split("=")[0];
  if (unresolvedWord(kv) || /["']/.test(key) || !GIT_C_ALLOWED.test(key)) {
    deny(`git -c ${key} is not allowed`);
  }
}
function checkGit(env, args, state) {
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (unresolvedWord(a)) deny("unresolved git option");
    if (a === "-C" || a === "--git-dir" || a === "--work-tree") {
      const v = args[i + 1];
      if (v === void 0) deny(`missing value for git ${a}`);
      checkInsideDir(env, v, state, `git ${a}`);
      i += 2;
    } else if (a.startsWith("--git-dir=") || a.startsWith("--work-tree=")) {
      checkInsideDir(env, a.slice(a.indexOf("=") + 1), state, "git option");
      i++;
    } else if (a === "-c" || a === "--config-env") {
      checkGitC(args[i + 1] ?? "");
      i += 2;
    } else if (a.startsWith("--config-env=")) {
      checkGitC(a.slice(13));
      i++;
    } else if (a === "--namespace" || a === "--exec-path") i += 2;
    else if (a.startsWith("-")) i++;
    else break;
  }
  const sub = args[i];
  if (sub === void 0) return;
  if (unresolvedWord(sub)) deny("unresolved command word (git subcommand)");
  const rest = args.slice(i + 1);
  if (sub === "push") checkPush(env, rest);
  else if (sub === "send-pack" || sub === "http-push" || sub === "subtree") {
    deny(`git ${sub} is not allowed`);
  } else if (sub === "config") {
    const all = rest.flatMap((x) => braceExpand(x));
    if (all.some(unresolvedWord) || !all.some((a) => GIT_CONFIG_READ.includes(a)) || all.some((a) => GIT_CONFIG_WRITE.includes(a) || a.startsWith("--file="))) {
      deny("git config is allowed for reads only (--get, --get-all, --get-regexp, --list)");
    }
  } else if (sub === "clone") {
    const pos = positionals(rest);
    if (pos.length >= 2) checkWritePath(env, pos[pos.length - 1], state.cwd, "git clone");
  }
}
function checkInsideDir(env, dir, state, why) {
  if (dir.includes(SUBST) || dir.includes("$") || dir.startsWith("~")) {
    deny(`unresolvable path in ${why}`);
  }
  if (state.cwd === null && !isAbsolute(dir)) deny(`relative path after unresolvable cd in ${why}`);
  if (!isInside(env, resolveReal(dir, state.cwd ?? env.wt)))
    deny(`${why} outside worktree: ${dir}`);
}
var GH_BLOCKED_TOPICS = /* @__PURE__ */ new Set(["release", "secret", "auth", "alias"]);
var GH_RUN_VALUE_FLAGS = ["--ref", "-r", "-f", "--raw-field", "-F", "--field", ...GH_VALUE_FLAGS];
function checkGh(env, args) {
  const words = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (GH_VALUE_FLAGS.includes(a)) k++;
    else if (!a.startsWith("-")) words.push(a);
  }
  const [g0, g1] = words;
  for (const w of [g0, g1]) {
    if (w !== void 0 && unresolvedWord(w)) deny("unresolved command word (gh subcommand)");
  }
  if (g0 === "pr" && g1 === "merge") deny("gh pr merge is not allowed (merging is owner-only)");
  if (g0 && GH_BLOCKED_TOPICS.has(g0)) deny(`gh ${g0} is not allowed`);
  if (g0 === "workflow" && g1 === "run") {
    const pos = [];
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (GH_RUN_VALUE_FLAGS.includes(a)) k++;
      else if (!a.startsWith("-")) pos.push(a);
    }
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      let ref;
      if (a === "--ref" || a === "-r") ref = args[k + 1] ?? "";
      else if (a.startsWith("--ref=")) ref = a.slice(6);
      else if (/^-r./.test(a) && !a.startsWith("--")) ref = a.slice(2);
      if (ref !== void 0 && (unresolvedWord(ref) || !env.allowedRefs.includes(ref))) {
        deny(`workflow ref "${ref}" is not in crew_allowed_workflow_refs`);
      }
    }
    const target = pos[2];
    if (target === void 0) deny("gh workflow run needs an explicit workflow");
    if (unresolved(target)) deny("unresolved workflow name");
    if (!env.allowedWorkflows.includes(target)) {
      deny(`workflow "${target}" is not in crew_allowed_workflows`);
    }
  }
  if (g0 === "api") checkGhApi(args);
}
function checkGhApi(rawArgs) {
  const apiAt = rawArgs.indexOf("api");
  for (let k = 0; k < apiAt; k++) {
    const a = rawArgs[k];
    if (a === "-R" || a === "--repo") k++;
    else deny(`gh option ${a} before api is not allowed`);
  }
  const args = rawArgs.slice(apiAt + 1);
  let endpoint;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "-H" || a === "--header" || a === "-q" || a === "--jq") {
      if (args[k + 1] === void 0) deny(`missing value for gh api ${a}`);
      k++;
    } else if (a === "--hostname") {
      if (args[++k] !== "github.com") deny("gh api --hostname must be github.com");
    } else if (a === "--paginate" || a === "-i" || a === "--include") {
    } else if (a.startsWith("-")) {
      deny(`gh api flag ${a} is not allowed (read-only: -H, -q, --paginate, -i, --hostname)`);
    } else if (endpoint !== void 0) {
      deny("gh api with more than one endpoint is not allowed");
    } else endpoint = a;
  }
  if (endpoint === void 0) deny("gh api without endpoint");
  if (unresolved(endpoint)) deny("unresolved gh api endpoint");
  if (/[%#]|:\/\//.test(endpoint)) deny("suspicious gh api endpoint");
  const path = endpoint.split("?")[0]?.replace(/\/+$/, "");
  if (/graphql$/i.test(path)) deny("gh api graphql is not allowed");
}
function checkFind(env, args, state) {
  const roots = [];
  let k = 0;
  while (k < args.length && /^-[HLP]$/.test(args[k])) k++;
  for (; k < args.length; k++) {
    const a = args[k];
    if (a.startsWith("-") || a === "(" || a === "!") break;
    roots.push(a);
  }
  const exprs = args.slice(k);
  const execAt = exprs.findIndex((a) => ["-exec", "-execdir", "-ok", "-okdir"].includes(a));
  const writes = exprs.some(
    (a) => ["-delete", "-fprint", "-fprintf", "-fls", "-fprint0"].includes(a)
  );
  if (!writes && execAt < 0) return;
  for (const r of roots.length > 0 ? roots : ["."]) checkWritePath(env, r, state.cwd, "find");
  for (const [idx, a] of exprs.entries()) {
    if (["-fprint", "-fprintf", "-fls", "-fprint0"].includes(a) && exprs[idx + 1]) {
      checkWritePath(env, exprs[idx + 1], state.cwd, "find output");
    }
  }
  if (execAt >= 0) {
    const cmd = [];
    for (const a of exprs.slice(execAt + 1)) {
      if (a === ";" || a === "+") break;
      cmd.push(a === "{}" ? roots[0] ?? "." : a);
    }
    checkWords(env, cmd, state);
  }
}
function checkSegment(env, seg, state) {
  const base = state.cwd ?? env.wt;
  for (const w of seg.writes) checkWritePath(env, w, state.cwd, "redirection");
  for (const r of seg.reads) checkSecretToken(env, r, base);
  for (const w of seg.writes) checkSecretToken(env, w, base);
  checkWords(env, seg.words, state);
}
var VAR_BUILTINS = /* @__PURE__ */ new Set([
  "read",
  "declare",
  "typeset",
  "local",
  "export",
  "readonly",
  "unset"
]);
var SHELLS = /* @__PURE__ */ new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
function checkVarBuiltin(name, args) {
  if (name === "printf") {
    if (args.some((a) => /^-[A-Za-z]*v/.test(a))) deny("printf -v is not allowed");
    return;
  }
  for (const a of args) {
    if (/^[-+]/.test(a)) deny(`${name} with options is not allowed`);
    if (unresolved(a)) deny(`unresolved word in ${name}`);
    const vn = a.split("=")[0];
    if (!VAR_NAME.test(vn)) deny(`${vn} is not a plain variable name`);
    checkVarName(vn);
  }
}
function checkWords(env, words, state) {
  if (words.length === 0) return;
  const base = state.cwd ?? env.wt;
  for (const w of words) checkSecretToken(env, w, base);
  const at = skipWrappers(words, state);
  const cmdWord = words[at];
  if (cmdWord === void 0) return;
  checkCommandGlobs(env, words.slice(at), words);
  if (unresolvedWord(cmdWord)) deny("unresolved command word");
  if (cmdWord !== "{" && cmdWord.includes("{")) deny("brace expansion in command position");
  const name = basename(cmdWord);
  const args = words.slice(at + 1);
  if (name === "sudo" || name === "su" || name === "doas") {
    deny(`privilege escalation (${name}) is not allowed`);
  }
  if (VAR_BUILTINS.has(name) || name === "printf") {
    checkVarBuiltin(name, args);
    return;
  }
  if (name === "popd") {
    state.cwd = null;
    return;
  }
  if (name === "cd" || name === "pushd") {
    const target = args.find((a) => !a.startsWith("-") || a === "-");
    const relative = target !== void 0 && !isAbsolute(target);
    if (target === void 0 || target === "-" || unresolved(target) || target.startsWith("~") || relative && state.cwd === null) {
      state.cwd = null;
    } else {
      state.cwd = resolveReal(target, state.cwd ?? env.wt);
    }
    return;
  }
  if (SHELLS.has(name)) {
    if (args.some((a) => /^-[A-Za-z]*[cs]/.test(a) || a.startsWith("--command"))) {
      deny(`${name} with a command string or stdin script is not allowed`);
    }
    if (positionals(args).length === 0 || args.includes("-")) {
      deny(`${name} reading its script from stdin is not allowed`);
    }
  }
  if (name === "find") checkFind(env, args, state);
  if (name === "git" || name === "gh") {
    if (words.some((w) => w.includes(SUBST))) deny(`command substitution in a ${name} command`);
  }
  if (name === "git") checkGit(env, args, state);
  if (name === "gh") checkGh(env, args);
  for (const t of writeTargets(name, args)) checkWritePath(env, t, state.cwd, name);
}
function checkBash(env, cmd, cwd, depth) {
  if (depth > 8) deny("command nesting too deep");
  const { lines, subs } = scan(cmd);
  for (const sub of subs) checkBash(env, sub, cwd, depth + 1);
  const state = { cwd };
  for (const line of lines) {
    for (const seg of toSegments(line)) checkSegment(env, seg, state);
  }
}
var WRITE_TOOLS = {
  Edit: "file_path",
  Write: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path"
};
var CREW_TOOLS = /* @__PURE__ */ new Set([
  "Bash",
  "Read",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "Grep",
  "Glob",
  "Skill",
  "TodoWrite",
  "Task",
  "Agent"
]);
var FILE_TOOLS = /* @__PURE__ */ new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "NotebookRead"]);
var SECRET_FRAGMENT = /\.env|\.pem|\.key|id_rsa|id_ed25519|\.npmrc|\.netrc|credentials/i;
var SECRET_SAMPLES = [
  ".env",
  ".env.local",
  "a.pem",
  "a.key",
  "id_rsa",
  "id_ed25519",
  ".npmrc",
  ".netrc",
  "credentials",
  "credentials.json"
];
function scanDirForSecrets(env, dir) {
  const stack = [dir];
  let count = 0;
  while (stack.length > 0) {
    const d = stack.pop();
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++count > GUARD_LIMITS.walk) deny("too many paths to check");
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== ".git") stack.push(full);
      } else if (isSecretString(env, full)) {
        deny(`search over a directory that contains a secret file: ${e.name}`);
      }
    }
  }
}
function checkSearch(env, path, globs, cwd) {
  const given = typeof path === "string" && path !== "" ? path : void 0;
  if (given !== void 0) checkSecretPath(env, given, cwd);
  const base = given !== void 0 ? resolveReal(given, cwd) : cwd;
  let isDir = false;
  try {
    isDir = statSync(base).isDirectory();
  } catch {
  }
  if (isDir) scanDirForSecrets(env, base);
  for (const g of globs) {
    if (typeof g !== "string" || g === "") continue;
    for (const e of braceExpand(g)) {
      if (e.includes(SUBST)) deny("unresolved search glob");
      if (isSecretString(env, e) || isSecretString(env, join(base, e))) {
        deny(`secret file access: ${e}`);
      }
      if (!hasMagic(e)) continue;
      const last = e.slice(e.lastIndexOf("/") + 1);
      if (SECRET_FRAGMENT.test(last)) {
        const re = fileGlobToRegExp(last);
        if (SECRET_SAMPLES.some((s) => re.test(s) && !isSecretExempt(s))) {
          deny(`search glob may match secret files: ${e}`);
        }
      }
      let matches = [];
      try {
        matches = capped(globSync(e, { cwd: base }));
      } catch (err) {
        if (err instanceof Deny) throw err;
      }
      for (const m of matches) if (isSecretString(env, join(base, m))) deny(`secret file: ${m}`);
    }
  }
}
var isSecretExempt = (s) => basename(s) === ".env.example";
var isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
function check(input, ctx) {
  const c = ctx;
  if (c === null || typeof c !== "object" || typeof c.worktree !== "string" || !isStringArray(c.ownerOnly) || !isStringArray(c.deployCommands) || !isStringArray(c.secretGlobs) || c.crewAllowedWorkflows !== void 0 && !isStringArray(c.crewAllowedWorkflows) || c.crewAllowedWorkflowRefs !== void 0 && !isStringArray(c.crewAllowedWorkflowRefs) || c.protectedPaths !== void 0 && !isStringArray(c.protectedPaths)) {
    deny("invalid guard context");
  }
  const wt = resolveReal(ctx.worktree, "/");
  if (wt === "/") deny("invalid worktree");
  const protectedPaths = [
    `${wt}/.claude`,
    `${wt}/.mcp.json`,
    `${wt}/.git`,
    ...ctx.protectedPaths ?? []
  ];
  const env = {
    wt,
    secretRes: ctx.secretGlobs.map(fileGlobToRegExp),
    deployGlobs: ctx.deployCommands.map((glob) => ({ glob, re: commandGlobToRegExp(glob) })),
    ownerGlobs: ctx.ownerOnly.map((glob) => ({ glob, re: commandGlobToRegExp(glob) })),
    allowedWorkflows: ctx.crewAllowedWorkflows ?? [],
    allowedRefs: ctx.crewAllowedWorkflowRefs ?? [],
    protectedReal: protectedPaths.flatMap((p) => [p, resolveReal(p, "/")]).map((p) => p.toLowerCase())
  };
  const { toolName, toolInput } = input;
  const cwd = resolveReal(input.cwd ?? wt, wt);
  if (typeof toolName !== "string" || !CREW_TOOLS.has(toolName)) {
    deny(`tool not allowed for crew: ${String(toolName)}`);
  }
  if (toolName === "Bash" || typeof toolInput.command === "string") {
    const command = toolInput.command;
    if (typeof command !== "string") deny(`${toolName} call without a command`);
    checkBash(env, command, cwd, 0);
    return;
  }
  const writeKey = WRITE_TOOLS[toolName];
  if (writeKey !== void 0) {
    const p = toolInput[writeKey];
    if (typeof p !== "string" || p === "") deny(`${toolName} call without ${writeKey}`);
    checkWritePath(env, p, cwd, toolName);
  }
  if (FILE_TOOLS.has(toolName)) {
    for (const key of ["file_path", "notebook_path"]) {
      const v = toolInput[key];
      if (typeof v === "string" && v !== "") checkSecretPath(env, v, cwd);
    }
  } else if (toolName === "Grep") {
    checkSearch(env, toolInput.path, [toolInput.glob], cwd);
  } else if (toolName === "Glob") {
    checkSearch(env, toolInput.path, [toolInput.pattern], cwd);
  }
}

// src/guard-main.ts
function deny2(reason, summary2) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason
      }
    })}
`
  );
  const dir = process.env.STUDIO_STATE_DIR;
  if (dir) {
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(
        join2(dir, "guard.jsonl"),
        `${JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), tool: summary2?.tool ?? null, reason, input: summary2?.input ?? null })}
`
      );
    } catch {
    }
  }
}
var summary;
try {
  const hook = JSON.parse(readFileSync(0, "utf8"));
  const input = hook.tool_input ?? {};
  summary = { tool: hook.tool_name, input: JSON.stringify(input).slice(0, 300) };
  const ctxPath = process.env.STUDIO_GUARD_CTX;
  if (!ctxPath) {
    deny2("guard context missing (STUDIO_GUARD_CTX not set)", summary);
  } else {
    let ctx;
    let readable = true;
    try {
      ctx = JSON.parse(readFileSync(ctxPath, "utf8"));
    } catch {
      readable = false;
      deny2("guard context unreadable", summary);
    }
    if (readable) {
      if (ctx === null || typeof ctx !== "object" || Array.isArray(ctx)) {
        deny2("guard context is not an object", summary);
      } else {
        const result = evaluateGuard(
          { toolName: hook.tool_name, toolInput: input, cwd: hook.cwd },
          ctx
        );
        if (result.decision === "deny") deny2(result.reason ?? "denied by guard", summary);
      }
    }
  }
} catch (err) {
  deny2(`guard error: ${err instanceof Error ? err.message : String(err)}`, summary);
}
