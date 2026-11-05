import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A syntactically valid sha512 integrity that stands for the pinned tarball in tests. */
export const REA_TEST_INTEGRITY = `sha512-${'A'.repeat(86)}==`;

/**
 * What `studio research install` leaves in `dir` (the owner state's rea/<version>/): a lockfile, the
 * install record and the package with its command. `entryScript` is the command's content.
 */
export function fakeReaInstall(
  dir: string,
  o: { version?: string; integrity?: string; recordIntegrity?: string; entryScript?: string } = {},
): string {
  const version = o.version ?? '6.7.0';
  const integrity = o.integrity ?? REA_TEST_INTEGRITY;
  const pkg = join(dir, 'node_modules', 'rea-agents');
  mkdirSync(join(pkg, 'scripts'), { recursive: true, mode: 0o755 });
  writeFileSync(
    join(dir, 'package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/rea-agents': {
          version,
          resolved: `https://registry.npmjs.org/rea-agents/-/rea-agents-${version}.tgz`,
          integrity,
        },
      },
    }),
  );
  writeFileSync(
    join(dir, 'studio-rea.json'),
    JSON.stringify({
      package: 'rea-agents',
      version,
      integrity: o.recordIntegrity ?? integrity,
      installedAt: '2026-11-05T10:00:00.000Z',
    }),
  );
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({ name: 'rea-agents', version, bin: { 'rea-agents': 'scripts/rea.mjs' } }),
  );
  const entry = join(pkg, 'scripts', 'rea.mjs');
  writeFileSync(entry, o.entryScript ?? 'process.exit(0);\n');
  return entry;
}
