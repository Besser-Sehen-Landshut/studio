import { type SqlToken, sqlStatements } from './proofs.js';

/**
 * The kind of a migration in a release note, read conservatively. Only what is clearly additive
 * runs without the owner: every statement creates something new (a table, an index, a column
 * added to a table, a comment). Anything that drops, deletes, truncates, renames or changes a
 * type is `destructive`; anything that writes rows is `backfill`; anything else, and anything the
 * tokenizer cannot read for sure, is `unclear`. All but `additive` need the owner's approval.
 *
 * No SQL parser: an allow-list of exact statement shapes over the tokens of src/proofs.ts, with
 * comments out and literals as one token, so a word in a string is never read as code. A
 * statement is additive only when it matches one shape from its first token to its last; a
 * query, a copy, a partition, a computed or non-literal default, any call shape and any statement
 * not on the list is `unclear`. It errs towards "needs owner": a column named `type`, for
 * example, makes an `ALTER TABLE` destructive.
 */
export const MIGRATION_KINDS = ['additive', 'backfill', 'unclear', 'destructive'] as const;
export type MigrationKind = (typeof MIGRATION_KINDS)[number];

export interface Classified {
  kind: MigrationKind;
  /** Studio's own words: the statement shape that decided, never file text. */
  why: string;
}

/** Severity order: a later kind wins over an earlier one. */
const RANK: Record<MigrationKind, number> = {
  additive: 0,
  backfill: 1,
  unclear: 2,
  destructive: 3,
};

export const worstKind = (kinds: readonly MigrationKind[]): MigrationKind =>
  kinds.reduce<MigrationKind>((a, b) => (RANK[b] > RANK[a] ? b : a), 'additive');

export const needsOwner = (kind: MigrationKind): boolean => kind !== 'additive';

const word = (t: SqlToken | undefined): string | undefined =>
  t?.kind === 'word' ? t.text : undefined;

/** Words that make an ALTER statement destructive wherever they stand in it. */
const ALTER_DESTRUCTIVE = new Set(['DROP', 'RENAME', 'TYPE']);
/** Index after a (possibly schema-qualified) name starting at `i`, or -1 when none is there. */
function afterName(s: SqlToken[], i: number): number {
  let j = i;
  for (;;) {
    const t = s[j];
    if (t === undefined || (t.kind !== 'word' && t.kind !== 'name')) return -1;
    j++;
    if (s[j]?.kind === 'punct' && s[j]?.text === '.') {
      j++;
      continue;
    }
    return j;
  }
}

/** Session settings a migration may start with: they change no data and no schema. */
const SETTINGS = new Set([
  'LOCK_TIMEOUT',
  'STATEMENT_TIMEOUT',
  'IDLE_IN_TRANSACTION_SESSION_TIMEOUT',
]);
/** Type names that take numeric arguments in parentheses: `numeric(10, 2)`, `varchar(20)`. */
const SIZED_TYPES = new Set([
  'NUMERIC',
  'DECIMAL',
  'VARCHAR',
  'CHAR',
  'CHARACTER',
  'VARYING',
  'TIMESTAMP',
  'TIMESTAMPTZ',
  'TIME',
  'TIMETZ',
  'INTERVAL',
  'BIT',
  'VARBIT',
  'FLOAT',
]);
/**
 * Words that take a table body or a column out of the allow-list: a query, a copy of another
 * table, a partition, a computed value, a check expression. Any of them makes it `unclear`.
 */
const NOT_PLAIN = new Set([
  'AS',
  'SELECT',
  'WITH',
  'PARTITION',
  'OF',
  'INHERITS',
  'LIKE',
  'GENERATED',
  'CHECK',
  'EXCLUDE',
  'USING',
  'EXECUTE',
  'TABLESPACE',
  'WITHOUT',
]);
/** Words of a constraint: it holds existing rows to a new rule, so it can fail or block writes. */
const CONSTRAINTS = new Set([
  'CONSTRAINT',
  'PRIMARY',
  'UNIQUE',
  'CHECK',
  'FOREIGN',
  'REFERENCES',
  'EXCLUDE',
]);

const isP = (t: SqlToken | undefined, text: string): boolean =>
  t?.kind === 'punct' && t.text === text;
const isNumber = (t: SqlToken | undefined): boolean =>
  t?.kind === 'punct' && /^[0-9]+$/.test(t.text);
const isNameLike = (t: SqlToken | undefined): boolean =>
  t !== undefined && (t.kind === 'word' || t.kind === 'name');

/** The index of the `)` that closes the `(` at `open`, or -1. */
function closing(s: SqlToken[], open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (isP(s[i], '(')) depth++;
    else if (isP(s[i], ')')) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** A literal default: a string, a number (with a sign), TRUE, FALSE or NULL. Returns its length. */
function literalAt(s: SqlToken[], i: number): number {
  const t = s[i];
  if (t?.kind === 'literal' && t.text.startsWith("'")) return 1;
  if (isNumber(t)) return isP(s[i + 1], '.') && isNumber(s[i + 2]) ? 3 : 1;
  if (isP(t, '-') && isNumber(s[i + 1])) return isP(s[i + 2], '.') && isNumber(s[i + 3]) ? 4 : 2;
  if (t?.kind === 'word' && (t.text === 'TRUE' || t.text === 'FALSE' || t.text === 'NULL'))
    return 1;
  return 0;
}

/**
 * Column definitions (and, for a table, table constraints) from `from` to `to`, exclusive: names,
 * type words, `NOT NULL`, a literal `DEFAULT`, keys and references. A parenthesis is allowed only
 * after a sized type with numbers inside, or (tables only) after `KEY`, `UNIQUE` or a referenced
 * table with names inside. Anything else, any call shape, a cast, a dollar body, is not plain.
 * Returns why not, or undefined.
 */
function plainColumns(s: SqlToken[], from: number, to: number, table: boolean): string | undefined {
  for (let i = from; i < to; i++) {
    const t = s[i] as SqlToken;
    if (t.kind === 'word') {
      if (NOT_PLAIN.has(t.text)) return t.text;
      if (!table && CONSTRAINTS.has(t.text)) return t.text;
      if (t.text === 'DEFAULT') {
        const n = literalAt(s, i + 1);
        if (n === 0) return 'a DEFAULT that is no literal';
        i += n;
      }
      continue;
    }
    if (t.kind === 'name') continue;
    if (t.kind === 'literal') return 'a literal outside DEFAULT';
    if (t.text === ',' || /^[0-9]+$/.test(t.text) || t.text === '.') continue;
    if (t.text !== '(') return `"${t.text}"`;
    const end = closing(s, i);
    if (end === -1 || end > to) return 'an unclosed parenthesis';
    const inner = s.slice(i + 1, end);
    if (inner.some((x) => isP(x, '('))) return 'nested parentheses';
    const prev = s[i - 1];
    const sized = prev?.kind === 'word' && SIZED_TYPES.has(prev.text);
    const numbers = inner.every((x) => isNumber(x) || isP(x, ','));
    // `REFERENCES other (id)` and `REFERENCES app.other (id)`.
    let k = i - 1;
    while (isNameLike(s[k]) && isP(s[k - 1], '.')) k -= 2;
    const referenced =
      isNameLike(s[k]) && s[k - 1]?.kind === 'word' && s[k - 1]?.text === 'REFERENCES';
    const keyed = prev?.kind === 'word' && (prev.text === 'KEY' || prev.text === 'UNIQUE');
    const names = inner.every((x) => isNameLike(x) || isP(x, ','));
    if (sized && numbers && inner.length > 0) {
      i = end;
      continue;
    }
    if (table && (keyed || referenced) && names && inner.length > 0) {
      i = end;
      continue;
    }
    return 'a call or expression in parentheses';
  }
  return undefined;
}

/** `CREATE TABLE [IF NOT EXISTS] <name> ( <plain columns> )`, nothing after it. */
function createTable(s: SqlToken[], w: (i: number) => string | undefined): Classified {
  let i = 2;
  if (w(i) === 'IF' && w(i + 1) === 'NOT' && w(i + 2) === 'EXISTS') i += 3;
  const j = afterName(s, i);
  if (j === -1 || !isP(s[j], '(')) return unclear('CREATE TABLE without a plain column list');
  const end = closing(s, j);
  if (end !== s.length - 1) return unclear('CREATE TABLE with more than a column list');
  const why = plainColumns(s, j + 1, end, true);
  return why === undefined
    ? { kind: 'additive', why: 'CREATE TABLE' }
    : unclear(`CREATE TABLE with ${why}`);
}

/**
 * `CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] [<name>] ON [ONLY] <table> ( <columns> )
 * [INCLUDE ( <columns> )]`: columns by name, with ASC, DESC, NULLS FIRST or LAST and operator
 * classes; no expression, no predicate, no method.
 */
function createIndex(s: SqlToken[], w: (i: number) => string | undefined): Classified {
  let i = w(1) === 'UNIQUE' ? 3 : 2;
  if (w(i) === 'CONCURRENTLY') i++;
  if (w(i) === 'IF' && w(i + 1) === 'NOT' && w(i + 2) === 'EXISTS') i += 3;
  if (w(i) !== 'ON') {
    const j = afterName(s, i);
    if (j === -1) return unclear('CREATE INDEX');
    i = j;
  }
  if (w(i) !== 'ON') return unclear('CREATE INDEX');
  i++;
  if (w(i) === 'ONLY') i++;
  const j = afterName(s, i);
  if (j === -1 || !isP(s[j], '(')) return unclear('CREATE INDEX without a plain column list');
  const columns = (open: number): number => {
    const end = closing(s, open);
    if (end === -1) return -1;
    const inner = s.slice(open + 1, end);
    return inner.length > 0 && inner.every((x) => isNameLike(x) || isP(x, ',') || isP(x, '.'))
      ? end
      : -1;
  };
  let end = columns(j);
  if (end === -1) return unclear('CREATE INDEX on an expression');
  if (w(end + 1) === 'INCLUDE' && isP(s[end + 2], '(')) {
    end = columns(end + 2);
    if (end === -1) return unclear('CREATE INDEX with an INCLUDE expression');
  }
  return end === s.length - 1
    ? { kind: 'additive', why: 'CREATE INDEX' }
    : unclear('CREATE INDEX with a predicate or options');
}

/** One statement, by an allow-list of exact shapes: what is not on it is `unclear`. */
export function classifyStatement(s: SqlToken[]): Classified {
  const w = (i: number) => word(s[i]);
  const first = w(0);
  if (first === undefined)
    return { kind: 'unclear', why: 'a statement that starts with no keyword' };
  if (first === 'BEGIN' || first === 'COMMIT' || first === 'END') {
    return s.length <= 2 && (s.length === 1 || w(1) === 'TRANSACTION' || w(1) === 'WORK')
      ? { kind: 'additive', why: 'a transaction bracket' }
      : unclear(first);
  }
  if (first === 'START') {
    return w(1) === 'TRANSACTION' && s.length === 2
      ? { kind: 'additive', why: 'a transaction bracket' }
      : unclear('START');
  }
  if (first === 'SET') {
    const at = w(1) === 'LOCAL' || w(1) === 'SESSION' ? 2 : 1;
    const name = w(at);
    let v = at + 1;
    if (isP(s[v], '=') || w(v) === 'TO') v++;
    const n = literalAt(s, v);
    return name !== undefined && SETTINGS.has(name) && n > 0 && v + n === s.length
      ? { kind: 'additive', why: `SET ${name}` }
      : unclear('SET');
  }
  if (first === 'DROP' || first === 'TRUNCATE' || first === 'DELETE') {
    return { kind: 'destructive', why: first };
  }
  if (first === 'UPDATE' || first === 'INSERT' || first === 'COPY' || first === 'MERGE') {
    return { kind: 'backfill', why: first };
  }
  if (first === 'COMMENT') {
    // COMMENT ON <object> <name> IS '<text>' | NULL: names only, no signature in parentheses.
    const is = s.findIndex((t) => t.kind === 'word' && t.text === 'IS');
    const between = s.slice(2, is);
    const ok =
      w(1) === 'ON' &&
      is > 2 &&
      between.every((t) => isNameLike(t) || isP(t, '.')) &&
      literalAt(s, is + 1) === 1 &&
      is + 2 === s.length;
    return ok ? { kind: 'additive', why: 'COMMENT ON' } : unclear('COMMENT');
  }
  if (first === 'CREATE') {
    if (w(1) === 'TABLE') return createTable(s, w);
    if (w(1) === 'INDEX' || (w(1) === 'UNIQUE' && w(2) === 'INDEX')) return createIndex(s, w);
    if (w(1) === 'SEQUENCE') {
      // CREATE SEQUENCE [IF NOT EXISTS] <name> [options of words and numbers].
      const rest = s.slice(2);
      return rest.every(
        (t) => t.kind === 'word' || t.kind === 'name' || isNumber(t) || isP(t, '.') || isP(t, '-'),
      ) && !rest.some((t) => t.kind === 'word' && (t.text === 'AS' || t.text === 'OWNED'))
        ? { kind: 'additive', why: 'CREATE SEQUENCE' }
        : unclear('CREATE SEQUENCE with options');
    }
    if (w(1) === 'SCHEMA') {
      let i = 2;
      if (w(i) === 'IF' && w(i + 1) === 'NOT' && w(i + 2) === 'EXISTS') i += 3;
      return isNameLike(s[i]) && i + 1 === s.length
        ? { kind: 'additive', why: 'CREATE SCHEMA' }
        : unclear('CREATE SCHEMA with more than a name');
    }
    if (w(1) === 'TYPE') {
      // CREATE TYPE <name> AS ENUM ('a', 'b').
      const j = afterName(s, 2);
      const end = j === -1 ? -1 : closing(s, j + 2);
      const inner = end === -1 ? [] : s.slice(j + 3, end);
      return j !== -1 &&
        w(j) === 'AS' &&
        w(j + 1) === 'ENUM' &&
        isP(s[j + 2], '(') &&
        end === s.length - 1 &&
        inner.every((t) => (t.kind === 'literal' && t.text.startsWith("'")) || isP(t, ','))
        ? { kind: 'additive', why: 'CREATE TYPE AS ENUM' }
        : unclear('CREATE TYPE that is no plain enum');
    }
    return unclear(`CREATE ${w(1) ?? ''}`.trim());
  }
  if (first === 'ALTER') {
    const object = w(1);
    const destructive = s.slice(1).find((t) => t.kind === 'word' && ALTER_DESTRUCTIVE.has(t.text));
    if (object === 'TYPE') {
      // ALTER TYPE <name> ADD VALUE [IF NOT EXISTS] '<label>' [BEFORE | AFTER '<label>'].
      const j = afterName(s, 2);
      if (j !== -1 && w(j) === 'ADD' && w(j + 1) === 'VALUE') {
        let k = j + 2;
        if (w(k) === 'IF' && w(k + 1) === 'NOT' && w(k + 2) === 'EXISTS') k += 3;
        const label = (x: number) => s[x]?.kind === 'literal' && s[x]?.text.startsWith("'");
        const ok =
          label(k) &&
          (k + 1 === s.length ||
            ((w(k + 1) === 'BEFORE' || w(k + 1) === 'AFTER') &&
              label(k + 2) &&
              k + 3 === s.length));
        if (ok) return { kind: 'additive', why: 'ALTER TYPE ADD VALUE' };
      }
      return destructive === undefined || destructive.text === 'TYPE'
        ? unclear('ALTER TYPE')
        : { kind: 'destructive', why: `ALTER TYPE with ${destructive.text}` };
    }
    if (destructive !== undefined) {
      return { kind: 'destructive', why: `ALTER ${object ?? ''} with ${destructive.text}` };
    }
    if (object !== 'TABLE') return unclear(`ALTER ${object ?? ''}`.trim());
    // ALTER TABLE [IF EXISTS] [ONLY] <name> ADD [COLUMN] [IF NOT EXISTS] <column>, ADD ...
    let i = 2;
    if (w(i) === 'IF' && w(i + 1) === 'EXISTS') i += 2;
    if (w(i) === 'ONLY') i++;
    const j = afterName(s, i);
    if (j === -1 || w(j) !== 'ADD') return unclear('ALTER TABLE');
    let k = j;
    while (k < s.length) {
      if (w(k) !== 'ADD') return unclear('ALTER TABLE with an action other than ADD');
      k++;
      if (w(k) === 'COLUMN') k++;
      if (w(k) === 'IF' && w(k + 1) === 'NOT' && w(k + 2) === 'EXISTS') k += 3;
      let end = k;
      let depth = 0;
      while (end < s.length && !(depth === 0 && isP(s[end], ','))) {
        if (isP(s[end], '(')) depth++;
        if (isP(s[end], ')')) depth--;
        end++;
      }
      if (!isNameLike(s[k]) || end - k < 2) return unclear('ALTER TABLE ADD without a column');
      const why = plainColumns(s, k + 1, end, false);
      if (why !== undefined) return unclear(`ALTER TABLE ADD with ${why}`);
      k = end + 1;
    }
    return { kind: 'additive', why: 'ALTER TABLE ADD COLUMN' };
  }
  return unclear(first);
}

const unclear = (shape: string): Classified => ({
  kind: 'unclear',
  why: `${shape} is not clearly additive`,
});

/**
 * A whole SQL migration: the worst of its statements. A text the tokenizer cannot read for sure,
 * or one without any statement, is `unclear`.
 */
export function classifySql(bytes: Uint8Array | string): Classified {
  const read = sqlStatements(bytes);
  if (typeof read === 'string') return { kind: 'unclear', why: `cannot be read for sure: ${read}` };
  if (read.statements.length === 0) return { kind: 'unclear', why: 'no statement found' };
  const all = read.statements.map(classifyStatement);
  const kind = worstKind(all.map((c) => c.kind));
  if (kind === 'additive') return { kind, why: 'every statement adds something new' };
  const whys = [...new Set(all.filter((c) => c.kind === kind).map((c) => c.why))];
  return { kind, why: whys.slice(0, 3).join('; ') };
}

/** Paths in natural order: `2_x.sql` before `10_x.sql`, the way migration tools number them. */
export function naturalCompare(a: string, b: string): number {
  const pa = a.match(/\d+|\D+/g) ?? [];
  const pb = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i] as string;
    const y = pb[i] as string;
    if (x === y) continue;
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const d = BigInt(x) - BigInt(y);
      if (d !== 0n) return d < 0n ? -1 : 1;
      return x.length - y.length;
    }
    return x < y ? -1 : 1;
  }
  return pa.length - pb.length;
}
