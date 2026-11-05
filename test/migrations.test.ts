import { describe, expect, it } from 'vitest';
import { classifySql, naturalCompare, needsOwner, worstKind } from '../src/migrations.js';

const kind = (sql: string) => classifySql(sql).kind;

describe('migration kinds: only what is clearly additive runs without the owner', () => {
  it('reads new tables, indexes, columns, types and comments as additive', () => {
    for (const sql of [
      'CREATE TABLE orders (id bigint PRIMARY KEY, total numeric NOT NULL);',
      'CREATE TABLE IF NOT EXISTS orders (id bigint);',
      'CREATE UNIQUE INDEX CONCURRENTLY orders_ref ON orders (ref);',
      'ALTER TABLE orders ADD COLUMN note text;',
      'ALTER TABLE IF EXISTS ONLY public.orders ADD COLUMN paid_at timestamptz;',
      'ALTER TABLE "Orders" ADD COLUMN "Paid" boolean NOT NULL DEFAULT false;',
      "ALTER TYPE order_state ADD VALUE 'refunded';",
      'CREATE SEQUENCE invoice_no;',
      "COMMENT ON TABLE orders IS 'one row per order';",
      "SET lock_timeout = '5s';\nCREATE INDEX CONCURRENTLY a_b ON a (b);",
      '-- drop table orders; is only a comment\nCREATE TABLE a (id int);',
      "CREATE TABLE notes (body text DEFAULT 'DROP TABLE x; DELETE FROM y');",
    ]) {
      expect(kind(sql), sql).toBe('additive');
    }
  });

  it('reads drops, deletes, truncates, renames and type changes as destructive', () => {
    for (const sql of [
      'DROP TABLE orders;',
      'DROP INDEX CONCURRENTLY orders_ref;',
      'DELETE FROM orders WHERE total = 0;',
      'TRUNCATE orders;',
      'ALTER TABLE orders DROP COLUMN note;',
      'ALTER TABLE orders ALTER COLUMN total TYPE bigint;',
      'ALTER TABLE orders ALTER COLUMN total SET DATA TYPE bigint;',
      'ALTER TABLE orders RENAME COLUMN note TO remark;',
      'ALTER TABLE orders ADD COLUMN a int, DROP COLUMN b;',
      'CREATE TABLE a (id int);\nDROP TABLE b;',
    ]) {
      expect(kind(sql), sql).toBe('destructive');
    }
  });

  it('reads writes of rows as a backfill', () => {
    expect(kind("UPDATE orders SET state = 'open' WHERE state IS NULL;")).toBe('backfill');
    expect(kind("INSERT INTO settings (k, v) VALUES ('a', 'b');")).toBe('backfill');
    expect(kind('CREATE TABLE a (id int);\nINSERT INTO a VALUES (1);')).toBe('backfill');
  });

  it('calls everything else unclear, and unclear needs the owner', () => {
    for (const sql of [
      'CREATE OR REPLACE VIEW v AS SELECT 1;',
      'CREATE EXTENSION pgcrypto;',
      'GRANT SELECT ON orders TO reporting;',
      'ALTER TABLE orders ADD CONSTRAINT positive CHECK (total >= 0);',
      'ALTER TABLE orders ADD COLUMN customer bigint REFERENCES customers (id);',
      'ALTER TABLE orders ALTER COLUMN note SET NOT NULL;',
      'ALTER TABLE orders OWNER TO someone;',
      'DO $$ BEGIN PERFORM 1; END $$;',
      "SET search_path = 'other';",
      '',
      '-- only a comment',
      "SELECT 'a\\b';",
      'CREATE TABLE `a` (id int);',
      '/*! executable */ CREATE TABLE a (id int);',
    ]) {
      expect(kind(sql), JSON.stringify(sql)).toBe('unclear');
      expect(needsOwner(kind(sql))).toBe(true);
    }
    expect(needsOwner('additive')).toBe(false);
  });

  it('names the statement shape that decided, never the file text', () => {
    expect(classifySql('DROP TABLE secret_table_name;').why).toBe('DROP');
    expect(classifySql('GRANT SELECT ON orders TO reporting;').why).toBe(
      'GRANT is not clearly additive',
    );
    expect(classifySql("SELECT 'it''s';\\").why).toMatch(/^cannot be read for sure: a backslash/);
  });

  it('takes the worst kind of a file', () => {
    expect(worstKind(['additive', 'backfill'])).toBe('backfill');
    expect(worstKind(['backfill', 'unclear', 'additive'])).toBe('unclear');
    expect(worstKind(['unclear', 'destructive'])).toBe('destructive');
    expect(worstKind([])).toBe('additive');
  });
});

describe('migration order', () => {
  it('sorts numbered files the way migration tools do', () => {
    const files = ['m/10_c.sql', 'm/2_b.sql', 'm/1_a.sql', 'm/0002_x.sql', 'm/20261105_y.sql'];
    expect([...files].sort(naturalCompare)).toEqual([
      'm/1_a.sql',
      'm/2_b.sql',
      'm/0002_x.sql',
      'm/10_c.sql',
      'm/20261105_y.sql',
    ]);
  });
});

describe('migration kinds: nothing destructive or data-changing passes as additive', () => {
  it('reads CREATE with a query, a copy, a partition, a computed value or a call as unclear', () => {
    for (const sql of [
      'CREATE TABLE x AS SELECT * FROM customers;',
      'CREATE TABLE x AS WITH d AS (DELETE FROM customers RETURNING *) SELECT * FROM d;',
      'CREATE TABLE x AS TABLE customers;',
      'CREATE TABLE x (LIKE customers INCLUDING ALL);',
      'CREATE TABLE x PARTITION OF orders FOR VALUES IN (1);',
      'CREATE TABLE x (id int) PARTITION BY RANGE (id);',
      'CREATE TABLE x (id int) INHERITS (orders);',
      'CREATE TABLE x OF some_type;',
      'CREATE TABLE x (id int) WITH (fillfactor = 70);',
      'CREATE TABLE x (id int DEFAULT wipe_customers());',
      "CREATE TABLE x (id int DEFAULT nextval('s'));",
      'CREATE TABLE x (id int GENERATED ALWAYS AS (purge()) STORED);',
      'CREATE TABLE x (id int CHECK (purge() > 0));',
      "CREATE TABLE x (id int DEFAULT 'a'::text);",
      'CREATE TABLE x (id int, total numeric(purge()));',
      'CREATE TEMP TABLE x (id int);',
      'CREATE TRIGGER t AFTER INSERT ON orders FOR EACH ROW EXECUTE FUNCTION wipe();',
      'CREATE RULE r AS ON INSERT TO orders DO INSTEAD DELETE FROM customers;',
      'CREATE FUNCTION wipe() RETURNS void LANGUAGE sql AS $$ DELETE FROM customers $$;',
      'CREATE OR REPLACE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;',
      'CREATE PROCEDURE p() LANGUAGE sql AS $$ TRUNCATE customers $$;',
      'CREATE VIEW v AS SELECT purge();',
      'CREATE MATERIALIZED VIEW v AS SELECT purge();',
      'CREATE INDEX i ON orders (purge(id));',
      'CREATE INDEX i ON orders ((lower(ref)));',
      'CREATE INDEX i ON orders (ref) WHERE purge();',
      'CREATE INDEX i ON orders USING gin (ref);',
      'CREATE SCHEMA s CREATE TABLE t (id int);',
      'CREATE TYPE t AS (a int);',
      'CREATE SEQUENCE s OWNED BY orders.id;',
      'DO $$ BEGIN DELETE FROM customers; END $$;',
      "COMMENT ON FUNCTION f(int) IS 'x';",
    ]) {
      expect(kind(sql), sql).toBe('unclear');
    }
  });

  it('reads ALTER ... ADD COLUMN with a non-literal default or a generated value as unclear', () => {
    for (const sql of [
      'ALTER TABLE orders ADD COLUMN c int DEFAULT f();',
      'ALTER TABLE orders ADD COLUMN c timestamptz DEFAULT now();',
      'ALTER TABLE orders ADD COLUMN c int DEFAULT (SELECT max(id) FROM customers);',
      'ALTER TABLE orders ADD COLUMN c int GENERATED ALWAYS AS (purge()) STORED;',
      'ALTER TABLE orders ADD COLUMN c int, ADD COLUMN d int DEFAULT purge();',
      "ALTER TABLE orders ADD COLUMN c text DEFAULT 'x'::text;",
      'ALTER TABLE orders ADD COLUMN c int USING purge();',
      'ALTER TABLE orders ADD c int, ENABLE TRIGGER t;',
    ]) {
      expect(kind(sql), sql).toBe('unclear');
    }
  });

  it('keeps the plain shapes additive', () => {
    for (const sql of [
      "ALTER TABLE orders ADD COLUMN c int NOT NULL DEFAULT 0, ADD COLUMN d text DEFAULT 'x';",
      'ALTER TABLE orders ADD COLUMN c numeric(10, 2) DEFAULT -1.5;',
      "CREATE TABLE x (id bigint PRIMARY KEY, c varchar(20) NOT NULL DEFAULT 'a', o bigint REFERENCES app.orders (id) ON DELETE CASCADE, UNIQUE (c));",
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON ONLY app.orders (ref DESC NULLS LAST, id) INCLUDE (total);',
      "CREATE TYPE state AS ENUM ('open', 'paid');",
      'CREATE SCHEMA IF NOT EXISTS app;',
      'CREATE SEQUENCE s START 1 INCREMENT 1;',
      "ALTER TYPE state ADD VALUE IF NOT EXISTS 'refunded' AFTER 'paid';",
    ]) {
      expect(kind(sql), sql).toBe('additive');
    }
  });
});

describe('migration risks, directives and column names (adversarial review)', () => {
  it('a plain index locks the table; a NOT NULL column without default can fail; a serial fills rows', () => {
    for (const [sql, risk] of [
      ['CREATE INDEX i ON orders (ref);', 'lock'],
      ['CREATE UNIQUE INDEX i ON orders (ref);', 'lock'],
      ['ALTER TABLE orders ADD COLUMN c int NOT NULL;', 'fails_on_data'],
      ['ALTER TABLE orders ADD COLUMN n bigserial;', 'lock'],
      ['ALTER TABLE orders ADD COLUMN n serial;', 'lock'],
    ] as const) {
      expect(classifySql(sql), sql).toMatchObject({ kind: 'unclear', risks: [risk] });
    }
    expect(kind('CREATE INDEX CONCURRENTLY i ON orders (ref);')).toBe('additive');
    expect(kind('ALTER TABLE orders ADD COLUMN c int NOT NULL DEFAULT 0;')).toBe('additive');
  });

  it('after ADD [COLUMN] a keyword is no column name', () => {
    for (const sql of [
      'ALTER TABLE orders ADD NOT NULL ref;',
      'ALTER TABLE orders ADD CONSTRAINT c NOT NULL ref;',
      'ALTER TABLE orders ADD COLUMN NOT NULL;',
      'ALTER TABLE orders ADD PRIMARY KEY (id);',
      'ALTER TABLE orders ADD UNIQUE (ref);',
    ]) {
      expect(kind(sql), sql).toBe('unclear');
    }
  });

  it('a directive comment or a transaction statement makes the file unclear, naming it', () => {
    expect(classifySql('-- no-transaction\nCREATE TABLE a (id int);')).toEqual({
      kind: 'unclear',
      why: 'a directive comment ("-- no-transaction") changes how the file runs',
    });
    expect(classifySql('-- +goose NO TRANSACTION\nCREATE TABLE a (id int);').why).toContain(
      '"-- +goose NO TRANSACTION"',
    );
    expect(classifySql('CREATE TABLE a (id int);\nCOMMIT;\nCREATE TABLE b (id int);').why).toBe(
      'COMMIT: a transaction statement in the file',
    );
    expect(kind('BEGIN;\nCREATE TABLE a (id int);\nCOMMIT;')).toBe('unclear');
  });

  it('refuses whitespace that is not ASCII', () => {
    expect(classifySql('CREATE TABLE a (id int);')).toEqual({
      kind: 'unclear',
      why: 'cannot be read for sure: whitespace that is not ASCII',
    });
  });

  it('calls a renamed type lossy', () => {
    expect(classifySql("ALTER TYPE state RENAME VALUE 'a' TO 'b';")).toEqual({
      kind: 'destructive',
      why: 'ALTER TYPE with RENAME: lossy, code that uses the old name breaks',
    });
  });
});
