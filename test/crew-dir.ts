import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The crew config dir `<owner config>/claude` that a token from a provider or a stored account
 * comes with, holding the skills a builder launch requires.
 */
export function prepareCrewDir(ownerDir: string): string {
  const dir = join(ownerDir, 'claude');
  for (const s of ['studio-crew', 'test-driven-development', 'systematic-debugging']) {
    mkdirSync(join(dir, 'skills', s), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'skills', s, 'SKILL.md'), '---\nname: x\n---\n');
  }
  return dir;
}
