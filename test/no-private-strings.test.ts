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

function denylistPatterns(): RegExp[] {
  return readFileSync(resolve(root, 'test/denylist.txt'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => new RegExp(line, 'i'));
}

// Returns 1-based line numbers of lines matching any pattern. Never returns matched text.
function matchingLines(text: string, patterns: RegExp[]): number[] {
  const lines: number[] = [];
  text.split('\n').forEach((line, index) => {
    if (patterns.some((pattern) => pattern.test(line))) lines.push(index + 1);
  });
  return lines;
}

// Forks get no secrets: CI sets this flag only for fork pull requests.
const wordsOptional = process.env.STUDIO_PRIVATE_WORDS_OPTIONAL === '1';

describe('no private strings in tracked files', () => {
  const words = (process.env.STUDIO_PRIVATE_WORDS ?? '')
    .split(',')
    .map((word) => word.trim())
    .filter(Boolean);

  it('has a private word list configured (unless this is a fork run)', () => {
    if (wordsOptional && words.length === 0) return;
    expect(words.length, 'STUDIO_PRIVATE_WORDS must be set and non-empty').toBeGreaterThan(0);
  });

  it('loads at least three denylist patterns', () => {
    expect(denylistPatterns().length).toBeGreaterThanOrEqual(3);
  });

  it('detects an IPv4 address and a home-directory path (matcher self-check)', () => {
    const patterns = denylistPatterns();
    // Built from pieces so this file contains no literal hit.
    const ip = ['10', '0', '0', '1'].join('.');
    const home = `${'/'}Users${'/'}someone`;
    expect(matchingLines(`host ${ip} here`, patterns)).toEqual([1]);
    expect(matchingLines(`path ${home}`, patterns)).toEqual([1]);
    expect(matchingLines('nothing to see', patterns)).toEqual([]);
  });

  it('scans a non-empty file list', () => {
    expect(scannedFiles().length).toBeGreaterThan(0);
  });

  it('finds no denylisted pattern or private word', () => {
    const patterns = denylistPatterns();
    for (const word of words) patterns.push(new RegExp(escapeRegExp(word), 'i'));

    const slug = repoSlug();
    const slugPattern = slug ? new RegExp(escapeRegExp(slug), 'gi') : undefined;

    const hits: string[] = [];
    for (const file of scannedFiles()) {
      const buffer = readFileSync(resolve(root, file));
      if (buffer.includes(0)) continue; // binary
      let text = buffer.toString('utf8');
      if (slugPattern) text = text.replace(slugPattern, '');
      for (const line of matchingLines(text, patterns)) hits.push(`${file}:${line}`);
    }
    expect(hits).toEqual([]);
  });
});
