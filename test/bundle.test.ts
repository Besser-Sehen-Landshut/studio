import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SECRET_GLOBS, evaluateGuard, type GuardContext } from '../src/guard.js';

// An installed plugin has bin/ and dist-bundle/ but no node_modules and no dist: simulate that.
const repo = join(import.meta.dirname, '..');
let plugin: string;

beforeAll(() => {
  plugin = mkdtempSync(join(tmpdir(), 'studio-bundle-'));
  cpSync(join(repo, 'bin'), join(plugin, 'bin'), { recursive: true });
  cpSync(join(repo, 'dist-bundle'), join(plugin, 'dist-bundle'), { recursive: true });
  cpSync(join(repo, 'capabilities'), join(plugin, 'capabilities'), { recursive: true });
  writeFileSync(join(plugin, 'package.json'), '{"type":"module"}\n');
});

afterAll(() => rmSync(plugin, { recursive: true, force: true }));

// `claude plugin test` needs the CLI, which CI does not have: these are the checks CI can make.
describe('the board mod', () => {
  const hooks = join(repo, 'hooks');

  it('hooks.json names the module, and the manifest the contract', () => {
    const { modules } = JSON.parse(readFileSync(join(hooks, 'hooks.json'), 'utf8'));
    expect(modules).toEqual(['./register.tsx']);
    expect(existsSync(join(hooks, 'register.tsx'))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(repo, '.claude-plugin', 'plugin.json'), 'utf8'));
    expect(manifest.types).toBe('./types/index.d.ts');
    expect(existsSync(join(repo, 'types', 'index.d.ts'))).toBe(true);
  });

  it('register.tsx and what it imports transform under esbuild', async () => {
    const out = await build({
      entryPoints: [join(hooks, 'register.tsx')],
      bundle: true,
      write: false,
      format: 'esm',
      logLevel: 'silent',
      external: ['claude-code'],
      jsx: 'transform',
      jsxFactory: 'h',
      jsxFragment: 'Fragment',
    });
    const text = out.outputFiles[0]?.text ?? '';
    expect(text).toContain('export {');
    expect(text).toContain('stateDirName');
  });

  it('no process, one file write (the REA confirmation on a press), no import the engine would refuse', () => {
    const source = readFileSync(join(hooks, 'register.tsx'), 'utf8');
    expect(source).not.toMatch(/\$\.process\b|\bimport\(|node:/);
    // The one write is the owner's REA install confirmation, inside confirmRea, run by onPress.
    expect(source.match(/\$\.fs\.write\b/g) ?? []).toHaveLength(1);
    const confirm = source.slice(source.indexOf('async function confirmRea'));
    expect(confirm.slice(0, confirm.indexOf('\n}\n'))).toMatch(/\$\.fs\.write\(\s*file/);
    expect(source).toMatch(/onPress=\{\(\) => void confirmRea\(\$\)\}/);
    expect(source.match(/confirmRea\(/g) ?? []).toHaveLength(2);
  });

  it('stays out of vitest', () => {
    const config = readFileSync(join(repo, 'vitest.config.ts'), 'utf8');
    expect(config).toContain("'hooks/**'");
  });
});

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

  it('bin/studio setup refuses without a terminal and asks nothing', () => {
    const home = mkdtempSync(join(tmpdir(), 'studio-bundle-home-'));
    try {
      const r = spawnSync(process.execPath, [join(plugin, 'bin', 'studio'), 'setup', '--link'], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', HOME: home },
        input: '',
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/needs your own terminal/);
      expect(r.stdout).toBe('');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('ships /studio:init (on request only) and /studio:add as skills', () => {
    const front = (name: string) => {
      const text = readFileSync(join(repo, 'skills', name, 'SKILL.md'), 'utf8');
      return /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
    };
    expect(front('init')).toMatch(/^name: init$/m);
    expect(front('init')).toMatch(/^disable-model-invocation: true$/m);
    expect(front('add')).toMatch(/^name: add$/m);
    const init = readFileSync(join(repo, 'skills', 'init', 'SKILL.md'), 'utf8');
    expect(init).toContain('studio init --write');
    expect(init).toContain('studio setup');
    expect(init).toContain('Never push');
    const add = readFileSync(join(repo, 'skills', 'add', 'SKILL.md'), 'utf8');
    expect(add).toContain('Shall I add this?');
    // The example command quotes every word singly, with the title after --.
    const example = /```bash\n\s*(studio add [^\n]*)\n/.exec(add)?.[1] ?? '';
    expect(example).toMatch(/ -- '/);
    expect(example).not.toContain('"');
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

  it('bin/studio-guard.mjs holds a reviewer to its analyzer and session time', () => {
    const wt = join(plugin, 'wt-timeout');
    mkdirSync(wt);
    const ctxFile = join(plugin, 'ctx-timeout.json');
    const agentsFile = join(plugin, 'agents.agents.json');
    const reportFile = join(wt, '.studio', 'reports', 'r.md');
    const base = { worktree: wt, ownerOnly: [], deployCommands: [], secretGlobs: [] };
    const hook = (input: Record<string, unknown>) =>
      spawnSync(process.execPath, [join(plugin, 'bin', 'studio-guard.mjs')], {
        input: JSON.stringify({ cwd: wt, ...input }),
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', STUDIO_GUARD_CTX: ctxFile },
      });
    const reason = (r: ReturnType<typeof hook>) =>
      r.stdout === ''
        ? undefined
        : JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason;
    const ls = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } };
    // Time left: SubagentStart records the start, the subagent's call passes.
    writeFileSync(
      ctxFile,
      JSON.stringify({
        ...base,
        timeouts: {
          analyzerMs: 60_000,
          sessionEndsAt: new Date(Date.now() + 3_600_000).toISOString(),
          reportFile,
          agentsFile,
        },
      }),
    );
    const started = hook({ hook_event_name: 'SubagentStart', agent_id: 'agent-1' });
    expect(started.status).toBe(0);
    expect(started.stdout).toBe('');
    expect(Object.keys(JSON.parse(readFileSync(agentsFile, 'utf8')))).toEqual(['agent-1']);
    expect(reason(hook({ ...ls, agent_id: 'agent-1' }))).toBeUndefined();
    // The subagent started long ago: its calls are refused with the timeout line.
    writeFileSync(agentsFile, JSON.stringify({ 'agent-1': Date.now() - 120_000 }));
    expect(reason(hook({ ...ls, agent_id: 'agent-1', agent_type: 'general-purpose' }))).toMatch(
      /skipped: timeout/,
    );
    // The refusal is recorded, so collect holds the report to it.
    expect(readFileSync(join(plugin, 'agents.timeouts'), 'utf8')).toBe('agent-1\n');
    // The session is over: only the report may be written.
    writeFileSync(
      ctxFile,
      JSON.stringify({
        ...base,
        timeouts: {
          analyzerMs: 60_000,
          sessionEndsAt: '2000-01-01T00:00:00Z',
          reportFile,
          agentsFile,
        },
      }),
    );
    expect(reason(hook(ls))).toMatch(/time is up/);
    expect(
      reason(
        hook({
          hook_event_name: 'PreToolUse',
          tool_name: 'Write',
          tool_input: { file_path: reportFile, content: 'x' },
        }),
      ),
    ).toBeUndefined();
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

describe('capabilities in an installed plugin', () => {
  it('the bundle finds them next to dist-bundle, without node_modules', () => {
    const r = spawnSync('node', [join(plugin, 'bin', 'studio'), 'sources', 'list', '--json'], {
      cwd: plugin,
      encoding: 'utf8',
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).capabilitiesDir).toBe(join(realpathSync(plugin), 'capabilities/'));
  });
});
