import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { assertStatePath, writeStateFile } from './paths.js';

export const MAX_FLAKY = 500;
const MAX_NAME = 200;

const entrySchema = z.object({
  test: z.string(),
  count: z.number().int().positive(),
  lastSha: z.string(),
  lastAt: z.string(),
});
export type FlakyEntry = z.infer<typeof entrySchema>;

const fileOf = (stateRoot: string) => join(stateRoot, 'flaky.json');

function read(stateRoot: string): FlakyEntry[] {
  const file = fileOf(stateRoot);
  assertStatePath(stateRoot, file);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error('flaky.json cannot be read');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('flaky.json is not valid JSON');
  }
  const parsed = z.array(entrySchema).safeParse(raw);
  if (!parsed.success) throw new Error('flaky.json has the wrong shape');
  return parsed.data;
}

/** Worst first. */
const ordered = (entries: readonly FlakyEntry[]): FlakyEntry[] =>
  [...entries].sort((a, b) => b.count - a.count || a.test.localeCompare(b.test));

export const listFlaky = (stateRoot: string): FlakyEntry[] => ordered(read(stateRoot));

/**
 * A test that failed and passed on the rerun is flaky and counted. Failing on the rerun is a real
 * failure and stays out of the ledger: nothing is retried into green.
 */
export function recordFlaky(
  stateRoot: string,
  test: string,
  sha: string,
  rerun: 'pass' | 'fail',
  now: Date,
): { status: 'flaky'; count: number } | { status: 'real' } {
  const name = test
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
  if (name === '') throw new Error('a test name is needed');
  const entries = read(stateRoot);
  if (rerun === 'fail') return { status: 'real' };
  const known = entries.find((e) => e.test === name);
  const count = (known?.count ?? 0) + 1;
  const rest = entries.filter((e) => e.test !== name);
  // The newest entry always stays: only an older one with the lowest count gives way.
  const kept = ordered(rest).slice(0, MAX_FLAKY - 1);
  const next = [...kept, { test: name, count, lastSha: sha, lastAt: now.toISOString() }];
  writeStateFile(stateRoot, fileOf(stateRoot), `${JSON.stringify(next, null, 2)}\n`);
  return { status: 'flaky', count };
}
