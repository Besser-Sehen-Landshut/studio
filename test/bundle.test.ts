import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SECRET_GLOBS, evaluateGuard, type GuardContext } from '../src/guard.js';

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

  it('bin/studio-guard.mjs decides from the bundle without node_modules', () => {
    const wt = join(plugin, 'wt');
    mkdirSync(wt);
    const ctxFile = join(plugin, 'ctx.json');
    const ctx: GuardContext = {
      worktree: wt,
      ownerOnly: ['gh pr merge*'],
      deployCommands: [],
      secretGlobs: DEFAULT_SECRET_GLOBS,
    };
    writeFileSync(ctxFile, JSON.stringify(ctx));
    // The context must be valid, or every call is denied as "invalid guard context".
    expect(evaluateGuard({ toolName: 'Bash', toolInput: { command: 'ls' }, cwd: wt }, ctx)).toEqual(
      { decision: 'allow' },
    );
    const run = (command: string) =>
      spawnSync(process.execPath, [join(plugin, 'bin', 'studio-guard.mjs')], {
        input: JSON.stringify({
          cwd: wt,
          tool_name: 'Bash',
          tool_input: { command },
          hook_event_name: 'PreToolUse',
        }),
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', STUDIO_GUARD_CTX: ctxFile },
      });
    const allow = run('ls');
    expect(allow.status).toBe(0);
    expect(allow.stdout).toBe('');
    const deny = run('gh pr merge 7 --squash');
    expect(deny.status).toBe(0);
    const out = JSON.parse(deny.stdout).hookSpecificOutput;
    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason).toMatch(/merge/);
    expect(out.permissionDecisionReason).not.toMatch(/invalid guard context/);
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
