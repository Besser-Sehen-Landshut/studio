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
      'BEGIN;\nCREATE TABLE a (id int);\nCOMMIT;',
      "SET lock_timeout = '5s';\nCREATE INDEX a_b ON a (b);",
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
