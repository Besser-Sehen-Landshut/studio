import { type SqlToken, sqlStatements } from './proofs.js';

/**
 * The kind of a migration in a release note, read conservatively. Only what is clearly additive
 * runs without the owner: every statement creates something new (a table, an index, a column
 * added to a table, a comment). Anything that drops, deletes, truncates, renames or changes a
 * type is `destructive`; anything that writes rows is `backfill`; anything else, and anything the
 * tokenizer cannot read for sure, is `unclear`. All but `additive` need the owner's approval.
 *
 * No SQL parser: a list of statement shapes over the tokens of src/proofs.ts, with comments out
 * and literals as one token, so a word in a string is never read as code. It errs towards
 * "needs owner": a column named `type`, for example, makes an `ALTER TABLE` destructive.
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
/** Words after which an `ALTER TABLE ... ADD` is no longer clearly additive. */
const ALTER_UNCLEAR = new Set([
  'ALTER',
  'SET',
  'RESET',
  'OWNER',
  'DISABLE',
  'ENABLE',
  'ATTACH',
  'DETACH',
  'INHERIT',
  'CLUSTER',
  'REPLICA',
  'VALIDATE',
  'USING',
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
/** Objects a plain `CREATE` adds without touching anything that exists. */
const CREATE_ADDITIVE = new Set(['TABLE', 'INDEX', 'SEQUENCE', 'SCHEMA', 'TYPE', 'VIEW']);
/** Session settings a migration may start with: they change no data and no schema. */
const SETTINGS = new Set([
  'LOCK_TIMEOUT',
  'STATEMENT_TIMEOUT',
  'IDLE_IN_TRANSACTION_SESSION_TIMEOUT',
]);

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

/** One statement, by its leading words. */
export function classifyStatement(s: SqlToken[]): Classified {
  const w = (i: number) => word(s[i]);
  const first = w(0);
  if (first === undefined)
    return { kind: 'unclear', why: 'a statement that starts with no keyword' };
  if (first === 'BEGIN' || first === 'COMMIT' || first === 'END') {
    return s.length <= 2 ? { kind: 'additive', why: 'a transaction bracket' } : unclear(first);
  }
  if (first === 'START' && w(1) === 'TRANSACTION') {
    return { kind: 'additive', why: 'a transaction bracket' };
  }
  if (first === 'SET') {
    const at = w(1) === 'LOCAL' || w(1) === 'SESSION' ? 2 : 1;
    const name = w(at);
    return name !== undefined && SETTINGS.has(name) && s.length <= at + 4
      ? { kind: 'additive', why: `SET ${name}` }
      : unclear('SET');
  }
  if (first === 'DROP' || first === 'TRUNCATE' || first === 'DELETE') {
    return { kind: 'destructive', why: first };
  }
  if (first === 'UPDATE' || first === 'INSERT' || first === 'COPY' || first === 'MERGE') {
    return { kind: 'backfill', why: first };
  }
  if (first === 'COMMENT' && w(1) === 'ON') return { kind: 'additive', why: 'COMMENT ON' };
  if (first === 'CREATE') {
    let i = 1;
    if (w(i) === 'OR') return { kind: 'unclear', why: 'CREATE OR REPLACE' };
    if (w(i) === 'UNIQUE') i++;
    if (w(i) === 'TEMP' || w(i) === 'TEMPORARY' || w(i) === 'UNLOGGED') i++;
    const object = w(i);
    if (object !== undefined && CREATE_ADDITIVE.has(object)) {
      return { kind: 'additive', why: `CREATE ${object}` };
    }
    return unclear(`CREATE ${object ?? ''}`.trim());
  }
  if (first === 'ALTER') {
    const object = w(1);
    const destructive = s.slice(1).find((t) => t.kind === 'word' && ALTER_DESTRUCTIVE.has(t.text));
    if (object === 'TYPE') {
      // ALTER TYPE <name> ADD VALUE '<label>': an enum value added.
      const j = afterName(s, 2);
      if (
        j !== -1 &&
        w(j) === 'ADD' &&
        w(j + 1) === 'VALUE' &&
        destructiveAfter(s, j) === undefined
      ) {
        return { kind: 'additive', why: 'ALTER TYPE ADD VALUE' };
      }
      return destructive === undefined || destructive.text === 'TYPE'
        ? unclear('ALTER TYPE')
        : { kind: 'destructive', why: `ALTER TYPE with ${destructive.text}` };
    }
    if (destructive !== undefined) {
      return { kind: 'destructive', why: `ALTER ${object ?? ''} with ${destructive.text}` };
    }
    if (object !== 'TABLE') return unclear(`ALTER ${object ?? ''}`.trim());
    let i = 2;
    if (w(i) === 'IF' && w(i + 1) === 'EXISTS') i += 2;
    if (w(i) === 'ONLY') i++;
    const j = afterName(s, i);
    if (j === -1 || w(j) !== 'ADD') return unclear('ALTER TABLE');
    // A constraint holds existing rows to a new rule: it can fail or block writes.
    const rule = s.slice(j).find((t) => t.kind === 'word' && CONSTRAINTS.has(t.text));
    if (rule !== undefined) return unclear(`ALTER TABLE ADD with ${rule.text}`);
    const other = s.slice(j).find((t) => t.kind === 'word' && ALTER_UNCLEAR.has(t.text));
    return other === undefined
      ? { kind: 'additive', why: 'ALTER TABLE ADD' }
      : unclear(`ALTER TABLE ADD with ${other.text}`);
  }
  return unclear(first);
}

const destructiveAfter = (s: SqlToken[], from: number): SqlToken | undefined =>
  s.slice(from).find((t) => t.kind === 'word' && ALTER_DESTRUCTIVE.has(t.text));

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
