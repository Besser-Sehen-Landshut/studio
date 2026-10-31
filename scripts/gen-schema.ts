// Writes schema/studio.schema.json from the zod schema. Run with node's native TS type stripping.
import { mkdirSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { studioConfigSchema } from '../src/config.ts';

const snake = (key: string): string => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

// The YAML file uses snake_case keys; the zod schema uses camelCase. Rename schema property names.
function snakeProps(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(snakeProps);
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'properties' && v !== null && typeof v === 'object') {
      out[k] = Object.fromEntries(Object.entries(v).map(([p, s]) => [snake(p), snakeProps(s)]));
    } else if (k === 'required' && Array.isArray(v)) {
      out[k] = v.map((r) => (typeof r === 'string' ? snake(r) : r));
    } else {
      out[k] = snakeProps(v);
    }
  }
  return out;
}

const schema = snakeProps(z.toJSONSchema(studioConfigSchema, { io: 'input' }));
mkdirSync('schema', { recursive: true });
writeFileSync('schema/studio.schema.json', `${JSON.stringify(schema, null, 2)}\n`);
