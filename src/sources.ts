import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { capabilitiesDir } from './capabilities.js';

const VENDORABLE = ['MIT', 'Apache-2.0'];

const safeRelative = (p: string): boolean =>
  p.length > 0 &&
  !p.startsWith('/') &&
  !p.includes('\\') &&
  !p.split('/').some((seg) => seg === '..' || seg === '' || seg === '.') &&
  !/\p{Cc}/u.test(p);

export const sourceSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    kind: z.enum(['git', 'plugin', 'skill']),
    url: z
      .string()
      .regex(
        /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
        'must be a GitHub https URL',
      )
      .optional(),
    license: z.string().min(1),
    vendored: z.boolean(),
    notice: z.string().optional(),
    reads: z.array(z.string().refine(safeRelative, 'must stay inside the source')),
  })
  .superRefine((s, ctx) => {
    if (s.kind === 'git' && s.url === undefined) {
      ctx.addIssue({ code: 'custom', message: 'a git source needs a url', path: ['url'] });
    }
    if (s.vendored && !VENDORABLE.includes(s.license)) {
      ctx.addIssue({ code: 'custom', message: 'only MIT or Apache-2.0 may be vendored' });
    }
    if (s.vendored && s.notice === undefined) {
      ctx.addIssue({ code: 'custom', message: 'vendored content needs its notice' });
    }
  });

export const sourcesSchema = z.strictObject({
  version: z.literal(1),
  rules: z.array(z.string()).default([]),
  sources: z.array(sourceSchema),
});

export type Source = z.infer<typeof sourceSchema>;
export type SourcesFile = z.infer<typeof sourcesSchema>;

export class SourcesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourcesError';
  }
}

/** Reads `SOURCES.yaml`; anything missing or malformed throws. */
export function loadSources(dir: string = capabilitiesDir()): SourcesFile {
  const file = join(dir, 'SOURCES.yaml');
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new SourcesError(`${file}: cannot read (${(e as Error).message.split('\n')[0]})`);
  }
  const parsed = sourcesSchema.safeParse(raw);
  if (!parsed.success) {
    const where = parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ');
    throw new SourcesError(`${file}: invalid at ${where}`);
  }
  const ids = new Set<string>();
  for (const s of parsed.data.sources) {
    if (ids.has(s.id)) throw new SourcesError(`${file}: duplicate source id ${s.id}`);
    ids.add(s.id);
  }
  return parsed.data;
}
