// Writes schema/*.schema.json from the zod schemas. Run with node's native TS type stripping.
import { mkdirSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { z } from 'zod';

// Sources import each other as './x.js'; type stripping runs them as './x.ts'.
registerHooks({
  resolve(specifier, context, next) {
    const ours = specifier.startsWith('./') && context.parentURL?.includes('/src/');
    return next(ours ? specifier.replace(/\.js$/, '.ts') : specifier, context);
  },
});
const { boardSchema } = await import('../src/board.ts');
const { capabilitiesSchema } = await import('../src/capabilities.ts');
const { ownerConfigSchema, studioConfigSchema } = await import('../src/config.ts');
const { sourcesSchema } = await import('../src/sources.ts');

const snake = (key: string): string => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

// The YAML files use snake_case keys; the zod schemas use camelCase. Rename schema property names.
function snakeProps(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(snakeProps);
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'properties' && v !== null && typeof v === 'object') {
      out[k] = Object.fromEntries(Object.entries(v).map(([p, s]) => [snake(p), snakeProps(s)]));
    } else if (k === 'required' && Array.isArray(v)) {
      out[k] = v.map((r) => (typeof r === 'string' ? snake(r) : r));
    } else if (k === 'default') {
      out[k] = snakeKeys(v);
    } else {
      out[k] = snakeProps(v);
    }
  }
  return out;
}

// A default value is data in the YAML shape, so its keys are snake_case too.
function snakeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [snake(k), snakeKeys(v)]));
}

mkdirSync('schema', { recursive: true });
for (const [file, zodSchema] of [
  ['schema/studio.schema.json', studioConfigSchema],
  ['schema/board.schema.json', boardSchema],
  ['schema/owner.schema.json', ownerConfigSchema],
  ['schema/capabilities.schema.json', capabilitiesSchema],
  ['schema/sources.schema.json', sourcesSchema],
] as const) {
  const schema = snakeProps(z.toJSONSchema(zodSchema, { io: 'input' }));
  writeFileSync(file, `${JSON.stringify(schema, null, 2)}\n`);
}
