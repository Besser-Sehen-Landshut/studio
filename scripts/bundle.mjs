// Builds the self-contained plugin bundles committed under dist-bundle/ (run: pnpm bundle). Writes
// the language registry first, so a new locale file is in the bundle and the board mod.
import { join } from 'node:path';
import { build } from 'esbuild';
import { writeLocaleIndex } from './gen-locales.mjs';

writeLocaleIndex(join(import.meta.dirname, '..', 'hooks', 'locales'));

const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  legalComments: 'none',
  logLevel: 'warning',
  outdir: 'dist-bundle',
  outExtension: { '.js': '.mjs' },
  // CommonJS dependencies may call require() at runtime.
  banner: {
    js: "import { createRequire as __studioCreateRequire } from 'node:module';\nconst require = __studioCreateRequire(import.meta.url);",
  },
};

await build({ ...common, entryPoints: { studio: 'src/main.ts' } });
await build({ ...common, entryPoints: { 'studio-guard': 'src/guard-main.ts' } });
