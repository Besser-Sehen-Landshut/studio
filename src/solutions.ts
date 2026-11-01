import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeLesson } from './role-memory.js';

const MAX_FILE_BYTES = 64 * 1024;
const MAX_FILES = 1000;
const MIN_WORD = 3;
const SAFE_NAME = /^[A-Za-z0-9._-]+\.md$/;

export interface SolutionHit {
  path: string;
  title: string;
  score: number;
}

const wordsOf = (text: string): string[] => [
  ...new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= MIN_WORD),
  ),
];

const isReal = (path: string, test: 'dir' | 'file'): boolean => {
  try {
    const st = lstatSync(path);
    return test === 'dir' ? st.isDirectory() : st.isFile() && st.size <= MAX_FILE_BYTES;
  } catch {
    return false;
  }
};

/**
 * Searches `.studio/solutions/*.md`: earlier learnings, read at planning time. Answers with paths
 * and titles, never the contents. Links and large files are not read.
 */
export function searchSolutions(projectDir: string, query: string, limit = 5): SolutionHit[] {
  const words = wordsOf(query);
  const studio = join(projectDir, '.studio');
  const dir = join(studio, 'solutions');
  if (words.length === 0 || !isReal(studio, 'dir') || !isReal(dir, 'dir')) return [];
  const hits: SolutionHit[] = [];
  for (const name of readdirSync(dir).sort().slice(0, MAX_FILES)) {
    if (!SAFE_NAME.test(name) || !isReal(join(dir, name), 'file')) continue;
    const text = readFileSync(join(dir, name), 'utf8');
    const lower = text.toLowerCase();
    const score = words.filter((w) => lower.includes(w)).length;
    if (score === 0) continue;
    const heading = text.split('\n').find((l) => l.startsWith('# '));
    const title = sanitizeLesson(heading?.slice(2) ?? '') ?? name.slice(0, -'.md'.length);
    hits.push({ path: `.studio/solutions/${name}`, title, score });
  }
  return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}
