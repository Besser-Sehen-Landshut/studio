import { closeSync, constants, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A privacy check for what a researcher with REA hands in: the result is structure, never content.
 * The check is a set of heuristics and fails closed: one hit and the report goes to the lead, who
 * reads the hit's kind and line (never the matched text) and decides. It cannot prove a text is
 * clean; it catches the careless leak, not a determined one (SECURITY.md).
 */

export interface PrivacyHit {
  kind: string;
  /** 1-based line within the text, `file` names where it was found. */
  line: number;
  file: string;
}

const EMAIL = /[A-Za-z0-9._%+-]{1,64}@([A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,24}/g;
/** Domains reserved for examples and tests (RFC 2606, RFC 6761): generic placeholders. */
const RESERVED_DOMAIN =
  /(^|\.)(example(\.(com|net|org))?|invalid|test|localhost|local|placeholder)$/i;
const PHONE = /(?<![\w.])\+?\d[\d\s()./-]{6,}\d(?![\w])/g;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([ T]\d{2})?/;
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;
const SECRET = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
];
/** `first_name: Anna`, `"email": "..."`, `iban = ...`: a personal field with a value. */
const PII_FIELD =
  /\b(first_?name|last_?name|sur_?name|full_?name|given_?name|birth_?(date|day)|date_of_birth|dob|street|house_?number|postal_?code|zip_?code|phone(_?number)?|mobile|email(_?address)?|iban|ssn|tax_?id|patient(_?name)?|customer(_?name)?)\b["']?\s*[:=]\s*["']?([^\s"',;|}]{2,})/gi;
/** Values that describe a field instead of filling it: types, placeholders, empty markers. */
const FIELD_VALUE_OK =
  /^(string|text|varchar|char|int|integer|bigint|smallint|number|float|double|decimal|bool|boolean|date|datetime|timestamp|blob|binary|bytes|uuid|json|null|none|nil|true|false|optional|required|unknown|n\/a|tbd|redacted|masked|<[^>]*>|\[[^\]]*\]|\{[^}]*\}|\*+|x+|\.{2,}|\w*\(.*\)|\?)$/i;

const LINE_LIMIT = 4000;

/** Checks one text; `file` is only a label for the hits. */
export function privacyHits(text: string, file: string): PrivacyHit[] {
  const hits: PrivacyHit[] = [];
  const add = (kind: string, line: number) => {
    if (!hits.some((h) => h.kind === kind && h.line === line)) hits.push({ kind, line, file });
  };
  const lines = text.split(/\r?\n/);
  const delim = lines.map(
    (l) => (l.match(/\t/g)?.length ?? 0) * 100 + (l.match(/,/g)?.length ?? 0),
  );
  lines.forEach((raw, i) => {
    const l = raw.slice(0, LINE_LIMIT);
    const n = i + 1;
    for (const m of l.matchAll(EMAIL)) {
      const domain = m[0].slice(m[0].lastIndexOf('@') + 1);
      if (!RESERVED_DOMAIN.test(domain)) add('email address', n);
    }
    for (const m of l.matchAll(PHONE)) {
      const digits = m[0].replace(/\D/g, '');
      if (digits.length < 8 || digits.length > 15 || ISO_DATE.test(m[0].trim())) continue;
      // A version, an address range or a hash fragment has no separator group of digits like a phone.
      if (/^\d+(\.\d+){2,3}$/.test(m[0].trim())) continue;
      if (!/^\+/.test(m[0].trim()) && !/[\s()/-]/.test(m[0].trim())) continue;
      add('phone-like number', n);
    }
    if ([...l.matchAll(IBAN)].some((m) => m[0].replace(/\s/g, '').length >= 15))
      add('account number', n);
    for (const m of l.matchAll(CARD)) if (luhn(m[0].replace(/\D/g, ''))) add('card number', n);
    for (const re of SECRET) if (re.test(l)) add('credential or key', n);
    for (const m of l.matchAll(PII_FIELD)) {
      const value = (m[m.length - 1] ?? '').replace(/["']+$/, '');
      if (!FIELD_VALUE_OK.test(value)) add('personal field with a value', n);
    }
    if (/\binsert\s+into\b[\s\S]*\bvalues\b/i.test(l)) add('row dump (insert statement)', n);
  });
  // A run of lines with the same, high number of separators is a table of rows (csv or tsv).
  for (let i = 0; i + 4 < lines.length; i++) {
    const d = delim[i] as number;
    const commas = d % 100;
    const tabs = Math.floor(d / 100);
    if (commas < 2 && tabs < 2) continue;
    let run = 1;
    while (i + run < lines.length && delim[i + run] === d && (lines[i + run] ?? '').trim() !== '')
      run++;
    if (run >= 5) {
      add('row dump (delimited lines)', i + 1);
      i += run - 1;
    }
  }
  return hits;
}

function luhn(d: string): boolean {
  if (d.length < 13 || d.length > 19 || /^(\d)\1+$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let x = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) {
      x *= 2;
      if (x > 9) x -= 9;
    }
    sum += x;
  }
  return sum % 10 === 0;
}

const MAX_FILES = 200;
const MAX_FILE_BYTES = 256 * 1024;

/** Text files below `dir` (no links), bounded; a file that is too big or not text is itself a hit. */
export function privacyHitsInDir(dir: string, label: string): PrivacyHit[] {
  const hits: PrivacyHit[] = [];
  let seen = 0;
  const walk = (d: string, rel: string) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const at = join(d, name);
      const shown = `${label}/${rel}${name}`;
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(at);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        hits.push({ kind: 'link in the findings directory', line: 0, file: shown });
      } else if (st.isDirectory()) {
        walk(at, `${rel}${name}/`);
      } else if (st.isFile()) {
        if (++seen > MAX_FILES) {
          hits.push({ kind: 'too many files', line: 0, file: label });
          return;
        }
        if (st.size > MAX_FILE_BYTES) {
          hits.push({ kind: 'file larger than 256 KiB', line: 0, file: shown });
          continue;
        }
        const text = readText(at, st.size);
        if (text === undefined || text.includes('\0')) {
          hits.push({ kind: 'file that is not text', line: 0, file: shown });
        } else hits.push(...privacyHits(text, shown));
      } else hits.push({ kind: 'special file', line: 0, file: shown });
    }
  };
  walk(dir, '');
  return hits;
}

function readText(file: string, size: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const buf = Buffer.alloc(size);
    const n = readSync(fd, buf, 0, size, 0);
    return buf.toString('utf8', 0, n);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The line a ReportError shows: kinds and places, never what matched. */
export function privacyLine(hits: readonly PrivacyHit[]): string {
  const shown = hits
    .slice(0, 8)
    .map(
      (h) =>
        `${h.kind} (${h.file.replace(/[^\w./-]/g, '?').slice(0, 80)}${h.line > 0 ? `:${h.line}` : ''})`,
    );
  return `privacy check failed, the report is held for the lead: ${shown.join('; ')}${hits.length > 8 ? `; ${hits.length - 8} more` : ''}`;
}
