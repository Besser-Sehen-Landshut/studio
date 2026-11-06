import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_SECRET_GLOBS, evaluateGuard, type GuardContext } from '../src/guard.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'guard-cache-')));
const wt = join(root, 'wt');
mkdirSync(join(wt, 'src'), { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const plain: GuardContext = {
  worktree: wt,
  ownerOnly: [],
  deployCommands: [],
  secretGlobs: DEFAULT_SECRET_GLOBS,
  item: 'APP-1',
  base: 'main',
};
const steps = ['cargo fetch --locked', 'cargo build --workspace --all-targets --locked'];
const report = join(wt, '.studio', 'reports', 'r1.md');
const cacheCtx: GuardContext = {
  ...plain,
  noPush: true,
  onlyCommands: steps,
  onlyWrites: [report],
};
const bash = (command: string, ctx = cacheCtx) =>
  evaluateGuard({ toolName: 'Bash', toolInput: { command } }, ctx).decision;

describe('a cache crew: only its listed commands and its report', () => {
  it('runs exactly the listed commands, surrounding space aside', () => {
    expect(bash('cargo fetch --locked')).toBe('allow');
    expect(bash('  cargo build --workspace --all-targets --locked\n')).toBe('allow');
  });

  it('refuses every other command, also a listed one with more attached', () => {
    for (const c of [
      'ls',
      'git status',
      'cargo fetch --locked && rm -rf src',
      'cargo fetch --locked; echo x',
      'cargo build',
      'cargo fetch  --locked',
    ]) {
      expect(bash(c), c).toBe('deny');
    }
  });

  it('writes only the report, and edits nothing', () => {
    const write = (tool: string, file: string) =>
      evaluateGuard({ toolName: tool, toolInput: { file_path: file, content: 'x' } }, cacheCtx)
        .decision;
    expect(write('Write', report)).toBe('allow');
    expect(write('Write', '.studio/reports/r1.md')).toBe('allow');
    expect(write('Write', join(wt, 'src', 'lib.rs'))).toBe('deny');
    expect(write('Edit', report)).toBe('deny');
    expect(write('MultiEdit', join(wt, 'a.rs'))).toBe('deny');
  });

  it('starts no subagent, which would not be held to the list', () => {
    for (const tool of ['Task', 'Agent']) {
      expect(evaluateGuard({ toolName: tool, toolInput: { prompt: 'x' } }, cacheCtx).decision).toBe(
        'deny',
      );
    }
  });

  it('a context with a malformed list is invalid', () => {
    const bad = { ...cacheCtx, onlyCommands: 'ls' } as unknown as GuardContext;
    expect(evaluateGuard({ toolName: 'Bash', toolInput: { command: 'ls' } }, bad).reason).toBe(
      'invalid guard context',
    );
  });

  it('other crews are not limited by it', () => {
    expect(bash('ls', plain)).toBe('allow');
  });
});
