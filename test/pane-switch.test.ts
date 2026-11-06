import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { nestedWorktreesOf } from '../hooks/board-model.js';
import { loadOwnerConfig } from '../src/config.js';

const tmp = mkdtempSync(join(tmpdir(), 'studio-pane-switch-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
/** What the CLI's own loader makes of the same owner config text. */
function cliValue(text: string): string {
  const xdg = join(tmp, `c${n++}`);
  mkdirSync(join(xdg, 'studio'), { recursive: true });
  writeFileSync(join(xdg, 'studio', 'config.yaml'), text);
  return (
    loadOwnerConfig({ env: { XDG_CONFIG_HOME: xdg }, homedir: tmp }).pane?.nestedWorktrees ?? 'show'
  );
}

describe('pane.nested_worktrees', () => {
  const valid = [
    '',
    'pane:\n  nested_worktrees: hide\n',
    'pane:\n  nested_worktrees: show\n',
    'pane: { nested_worktrees: hide }\n',
    'pane: {nested_worktrees: "hide"}\n',
    "# owner config\npane: # the board\n  # comment\n  nested_worktrees: 'hide' # quiet\n",
    'allow_api_billing: false\npane:\n\n    nested_worktrees: hide\nnotify:\n  quiet: "22:00-07:00"\n',
    'pane: {}\n',
  ];

  it('the mod reads what the CLI reads', () => {
    for (const text of valid) expect(nestedWorktreesOf(text), text).toBe(cliValue(text));
  });

  it('defaults to show and only ever hides on an exact hide', () => {
    expect(nestedWorktreesOf('')).toBe('show');
    expect(nestedWorktreesOf('pane:\n  nested_worktrees: hidden\n')).toBe('show');
    expect(nestedWorktreesOf('nested_worktrees: hide\n')).toBe('show');
    expect(nestedWorktreesOf('other:\n  nested_worktrees: hide\n')).toBe('show');
    expect(nestedWorktreesOf('pane:\nnested_worktrees: hide\n')).toBe('show');
    expect(nestedWorktreesOf('# pane:\n#   nested_worktrees: hide\n')).toBe('show');
  });

  it('the CLI refuses another value', () => {
    expect(() => cliValue('pane:\n  nested_worktrees: hidden\n')).toThrow();
  });
});
