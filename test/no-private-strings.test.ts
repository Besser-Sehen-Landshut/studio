import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const excluded = new Set(['test/denylist.txt', 'test/no-private-strings.test.ts']);

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function repoSlug(): string {
  const fromEnv = process.env.GITHUB_REPOSITORY;
  if (fromEnv) return fromEnv;
  try {
    const url = git('remote', 'get-url', 'origin').trim();
    const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
    return match?.[1] ?? '';
  } catch {
    return '';
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scannedFiles(): string[] {
  // Tracked files plus new, not yet committed files that are not ignored.
  return git('ls-files', '--cached', '--others', '--exclude-standard', '-z')
    .split('\0')
    .filter((file) => file && !excluded.has(file) && existsSync(resolve(root, file)));
}

describe('no private strings in tracked files', () => {
  const words = (process.env.STUDIO_PRIVATE_WORDS ?? '')
    .split(',')
    .map((word) => word.trim())
    .filter(Boolean);

  it('has a private word list configured', () => {
    expect(words.length, 'STUDIO_PRIVATE_WORDS must be set and non-empty').toBeGreaterThan(0);
  });

  it('finds no denylisted pattern or private word', () => {
    const patterns = readFileSync(resolve(root, 'test/denylist.txt'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => new RegExp(line, 'i'));
    for (const word of words) patterns.push(new RegExp(escapeRegExp(word), 'i'));

    const slug = repoSlug();
    const slugPattern = slug ? new RegExp(escapeRegExp(slug), 'gi') : undefined;

    const hits: string[] = [];
    for (const file of scannedFiles()) {
      const buffer = readFileSync(resolve(root, file));
      if (buffer.includes(0)) continue; // binary
      let text = buffer.toString('utf8');
      if (slugPattern) text = text.replace(slugPattern, '');
      text.split('\n').forEach((line, index) => {
        for (const pattern of patterns) {
          // Report file and line only, never the matched text.
          if (pattern.test(line)) hits.push(`${file}:${index + 1}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });
});
