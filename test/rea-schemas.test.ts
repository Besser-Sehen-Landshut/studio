import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REA_TOOL_SCHEMAS } from '../src/rea-schemas.js';

const root = mkdtempSync(join(tmpdir(), 'studio-rea-schemas-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const script = join(import.meta.dirname, '..', 'scripts', 'gen-rea-schemas.mjs');

/** Runs the generator on a synthetic `tools/list` result and reads the entries it wrote. */
function generate(tools: unknown[]): string {
  const input = join(root, `tools-${Math.random().toString(36).slice(2)}.json`);
  const out = `${input}.ts`;
  writeFileSync(input, JSON.stringify({ tools }));
  execFileSync(process.execPath, [script, '--tools', input, '--out', out]);
  return readFileSync(out, 'utf8');
}

describe('the REA schema generator', () => {
  it('classifies by type: only strings name a place or hold free text', () => {
    const text = generate([
      {
        name: 'analyze',
        inputSchema: {
          properties: {
            input_path: { type: 'string' },
            source_paths: { type: 'array', items: { type: 'string' } },
            max_semantic_nodes_per_file: { type: 'integer' },
            max_output_files: { type: 'integer' },
            max_entries: { type: 'integer' },
            manifest: { type: 'object' },
            evidence_bundle: { type: 'object', properties: { path: { type: 'string' } } },
            root: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            left_export_name: { type: 'string' },
            pattern: { type: 'string' },
            query: { type: 'object' },
            names: { type: 'object' },
          },
        },
      },
    ]);
    expect(text).toContain(
      "analyze: { keys: ['evidence_bundle', 'input_path', 'left_export_name', 'manifest', 'max_entries', 'max_output_files', 'max_semantic_nodes_per_file', 'names', 'pattern', 'query', 'root', 'source_paths'], paths: ['input_path', 'root', 'source_paths'], text: ['pattern'] },",
    );
  });

  it('left no number among the paths and no object among the free text of the committed schemas', () => {
    for (const [tool, s] of Object.entries(REA_TOOL_SCHEMAS)) {
      for (const p of s.paths) expect(p, `${tool}.${p}`).not.toMatch(/^max_/);
      for (const t of s.text) {
        expect(['filters', 'names'], `${tool}.${t}`).not.toContain(t);
      }
    }
    expect(REA_TOOL_SCHEMAS.analyze_javascript_application?.paths).toEqual([
      'input_path',
      'source_paths',
    ]);
  });
});
