import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type CliDeps, runCli } from '../src/cli.js';
import { COMMANDS, GLOBAL_OPTIONS, USAGE } from '../src/help.js';
import type { Ports } from '../src/ports.js';

const repo = join(import.meta.dirname, '..');
const cliSource = readFileSync(join(repo, 'src', 'cli.ts'), 'utf8');
const readme = readFileSync(join(repo, 'README.md'), 'utf8');

async function run(...argv: string[]) {
  let out = '';
  let err = '';
  const deps: CliDeps = {
    // Help reads nothing: any port it touched would throw here.
    ports: new Proxy({} as Ports, {
      get: (_t, p) => {
        throw new Error(`help touched ports.${String(p)}`);
      },
    }),
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
    env: {},
    homedir: '/nonexistent-home',
    cwd: '/nonexistent-project',
  };
  const code = await runCli(argv, deps);
  return { code, out, err };
}

/** The top-level commands of the dispatcher in runCli: its `case '<name>':` lines. */
function dispatcherCommands(): string[] {
  const start = cliSource.indexOf('    switch (cmd) {');
  const end = cliSource.indexOf('throw new UsageError(cmd ? `unknown command', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const names = [...cliSource.slice(start, end).matchAll(/^ {6}case '([a-z][a-z-]*)':/gm)].map(
    (m) => m[1] as string,
  );
  return [...new Set(names)];
}

/** The long options parseCli accepts. */
function parsedOptions(): string[] {
  const start = cliSource.indexOf('function parseCli(');
  const block = cliSource.slice(start, cliSource.indexOf('allowPositionals', start));
  return [...block.matchAll(/^ {8}'?([a-z][a-z-]*)'?: \{ type:/gm)].map((m) => m[1] as string);
}

/** The rows of the README's CLI table: their first cell. */
function readmeRows(): string[] {
  const at = readme.indexOf('## CLI');
  const section = readme.slice(at, readme.indexOf('\n## ', at + 1));
  return section
    .split('\n')
    .filter((l) => l.startsWith('| `'))
    .map((l) => l.split(' | ')[0] as string);
}

const commandWords = new Set(COMMANDS.map((c) => c.usage.split(' ')[0]));

describe('studio help', () => {
  it('prints the help and exits 0 as help, --help and -h, reading nothing', async () => {
    const results = [await run('help'), await run('--help'), await run('-h')];
    for (const r of results) {
      expect(r.code).toBe(0);
      expect(r.err).toBe('');
      expect(r.out).toBe(USAGE);
    }
    expect(USAGE).toMatch(/^Usage: studio \[--project <dir>\] \[--json\] <command>/);
  });

  it('works after the global options and beside a command', async () => {
    expect((await run('--project', '/x', 'help')).code).toBe(0);
    expect((await run('tick', '--help')).out).toBe(USAGE);
  });

  it('names every top-level command of the dispatcher', () => {
    const commands = dispatcherCommands();
    expect(commands.length).toBeGreaterThan(30);
    for (const c of commands) expect(commandWords, `help lacks ${c}`).toContain(c);
    // And nothing the dispatcher does not know, besides help itself.
    for (const w of commandWords) {
      if (w !== 'help') expect(commands, `help names unknown ${w}`).toContain(w);
    }
  });

  it('names every option the parser accepts', () => {
    const options = parsedOptions();
    expect(options).toContain('dry-run');
    for (const o of options) expect(USAGE, `help lacks --${o}`).toContain(`--${o}`);
    expect(GLOBAL_OPTIONS.map((g) => g.usage)).toContain('-h, --help');
  });

  it('names every command and flag of the README CLI table', () => {
    const rows = readmeRows();
    expect(rows.length).toBeGreaterThan(30);
    for (const row of rows) {
      for (const cell of row.matchAll(/`([^`]+)`/g)) {
        const words = (cell[1] as string).split(' ');
        expect(commandWords, `help lacks ${cell[1]}`).toContain(words[0]);
        for (const flag of (cell[1] as string).matchAll(/--[a-z][a-z-]*/g)) {
          expect(USAGE, `help lacks ${flag[0]} of ${cell[1]}`).toContain(flag[0]);
        }
      }
    }
  });

  it('holds what the review found missing', () => {
    for (const s of [
      'setup research',
      'research install [--yes] [--folder <dir>]',
      'status --group <name>',
      '--artifacts <dir>',
      '--member <project>:<id>',
      'adopt --from',
      'tick [--dry-run]',
    ]) {
      expect(
        COMMANDS.some((c) => c.usage.includes(s)),
        s,
      ).toBe(true);
    }
    expect(USAGE).toMatch(/REA/);
  });

  it('keeps every line within 100 columns', () => {
    for (const line of USAGE.split('\n')) expect(line.length, line).toBeLessThanOrEqual(100);
  });
});
