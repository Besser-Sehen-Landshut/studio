import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// An installed plugin has bin/ and dist-bundle/ but no node_modules and no dist: simulate that.
const repo = join(import.meta.dirname, '..');
let plugin: string;

beforeAll(() => {
  plugin = mkdtempSync(join(tmpdir(), 'studio-bundle-'));
  cpSync(join(repo, 'bin'), join(plugin, 'bin'), { recursive: true });
  cpSync(join(repo, 'dist-bundle'), join(plugin, 'dist-bundle'), { recursive: true });
  writeFileSync(join(plugin, 'package.json'), '{"type":"module"}\n');
});

afterAll(() => rmSync(plugin, { recursive: true, force: true }));

describe('self-contained plugin bundle', () => {
  it('ships the bundles and an executable bare `studio` command', () => {
    expect(existsSync(join(repo, 'dist-bundle', 'studio.mjs'))).toBe(true);
    expect(existsSync(join(repo, 'dist-bundle', 'studio-guard.mjs'))).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(join(repo, 'bin', 'studio')).mode & 0o111).not.toBe(0);
    }
  });

  it('bin/studio runs from the bundle without node_modules', () => {
    const r = spawnSync(process.execPath, [join(plugin, 'bin', 'studio'), '--help'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage: studio');
  });

  it('bin/studio-guard.mjs denies from the bundle without node_modules', () => {
    const ctxFile = join(plugin, 'ctx.json');
    writeFileSync(
      ctxFile,
      JSON.stringify({ worktree: plugin, tmpDir: plugin, repo: 'org/app', allowedWorkflows: [] }),
    );
    const r = spawnSync(process.execPath, [join(plugin, 'bin', 'studio-guard.mjs')], {
      input: JSON.stringify({
        cwd: plugin,
        tool_name: 'Bash',
        tool_input: { command: 'git push --force' },
        hook_event_name: 'PreToolUse',
      }),
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', STUDIO_GUARD_CTX: ctxFile },
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('bin/studio-guard.mjs fails closed when no bundle is present', () => {
    const empty = mkdtempSync(join(tmpdir(), 'studio-nobundle-'));
    try {
      cpSync(join(repo, 'bin'), join(empty, 'bin'), { recursive: true });
      const r = spawnSync(process.execPath, [join(empty, 'bin', 'studio-guard.mjs')], {
        input: '{}',
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
