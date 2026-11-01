import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import type { Ports } from '../src/ports.js';
import { detectStacks, STACK_IDS } from '../src/stack.js';

const root = mkdtempSync(join(tmpdir(), 'studio-stack-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const project = (files: Record<string, string>): string => {
  const d = join(root, `p${n++}`);
  mkdirSync(d);
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(d, f)), { recursive: true });
    if (f.endsWith('/')) mkdirSync(join(d, f), { recursive: true });
    else writeFileSync(join(d, f), text);
  }
  return d;
};
const pkg = (name: string, kind = 'dependencies') =>
  JSON.stringify({ [kind]: { [name]: '1.0.0' } });

describe('detectStacks', () => {
  it.each<[string, Record<string, string>, string]>([
    ['nextjs', { 'next.config.mjs': '' }, 'nextjs'],
    ['nextjs dep', { 'package.json': pkg('next') }, 'nextjs'],
    ['shadcn', { 'components.json': '{}' }, 'shadcn'],
    ['postgres dep', { 'package.json': pkg('pg') }, 'postgres'],
    ['postgres migrations', { 'migrations/1.sql': '' }, 'postgres'],
    ['ios podfile', { Podfile: '' }, 'ios'],
    ['ios swift package', { 'Package.swift': '' }, 'ios'],
    ['ios xcodeproj', { 'App.xcodeproj/project.pbxproj': '' }, 'ios'],
    ['winui', { 'App.csproj': '<PackageReference Include="Microsoft.WindowsAppSDK" />' }, 'winui'],
    ['rust', { 'Cargo.toml': '' }, 'rust'],
    ['tauri', { 'src-tauri/x': '' }, 'tauri'],
    ['tauri implies rust', { 'src-tauri/x': '' }, 'rust'],
    ['android', { 'build.gradle.kts': '' }, 'android'],
    ['expo app.json', { 'app.json': '{"expo":{}}' }, 'expo'],
    ['react native', { 'package.json': pkg('react-native') }, 'expo'],
    ['svelte', { 'svelte.config.js': '' }, 'svelte'],
    ['web', { 'index.html': '' }, 'web'],
    ['web vite', { 'vite.config.ts': '' }, 'web'],
    ['docker', { 'Dockerfile.prod': '' }, 'docker'],
    ['compose', { 'docker-compose.dev.yml': '' }, 'docker'],
    ['gha', { '.github/workflows/ci.yml': '' }, 'gha'],
    ['better-auth', { 'package.json': pkg('better-auth') }, 'better-auth'],
    ['stripe', { 'package.json': pkg('stripe') }, 'stripe'],
    ['fastify', { 'package.json': pkg('fastify') }, 'fastify'],
    ['ai', { 'package.json': pkg('ai') }, 'ai-sdk'],
    [
      'playwright dev dep',
      { 'package.json': pkg('@playwright/test', 'devDependencies') },
      'playwright',
    ],
    ['wordpress', { 'wp-config.php': '' }, 'wordpress'],
    ['wordpress theme', { 'style.css': '/* Theme Name: X */' }, 'wordpress'],
    ['wordpress plugin', { 'x.php': '<?php /* Plugin Name: X */' }, 'wordpress'],
    ['tailwind', { 'package.json': pkg('tailwindcss', 'devDependencies') }, 'tailwind'],
    ['monorepo', { 'apps/web/next.config.js': '' }, 'nextjs'],
    ['monorepo crate', { 'crates/a/Cargo.toml': '' }, 'rust'],
  ])('%s', (_name, files, want) => {
    expect(detectStacks(project(files)).stacks).toContain(want);
  });

  it('every id it can answer is in the list', () => {
    for (const s of detectStacks(project({ 'Cargo.toml': '', 'index.html': '' })).stacks) {
      expect(STACK_IDS).toContain(s);
    }
  });

  it('web only without another web stack', () => {
    expect(detectStacks(project({ 'index.html': '', 'next.config.js': '' })).stacks).not.toContain(
      'web',
    );
  });

  it('a csproj without WinUI is not winui', () => {
    expect(detectStacks(project({ 'a.csproj': '<Project/>' })).stacks).toEqual([]);
  });

  it('never opens .env', () => {
    const d = project({ '.env': 'DATABASE_URL=postgres://x' });
    chmodSync(join(d, '.env'), 0o000);
    expect(detectStacks(d)).toEqual({ stacks: [], notes: [] });
    chmodSync(join(d, '.env'), 0o600);
  });

  it('ignores a symlinked manifest and a symlinked folder', () => {
    const outside = project({ 'Cargo.toml': '', 'package.json': pkg('next') });
    const d = project({});
    symlinkSync(join(outside, 'Cargo.toml'), join(d, 'Cargo.toml'));
    symlinkSync(join(outside, 'package.json'), join(d, 'package.json'));
    symlinkSync(outside, join(d, 'apps'));
    expect(detectStacks(d).stacks).toEqual([]);
  });

  it('a package.json that is too large or broken is a note, never a stack', () => {
    const big = project({ 'package.json': `{"a":"${'x'.repeat(2 * 1024 * 1024)}","next":1}` });
    const r = detectStacks(big);
    expect(r.stacks).toEqual([]);
    expect(r.notes.join()).toContain('package.json');
    const bad = detectStacks(project({ 'package.json': '{nope' }));
    expect(bad.stacks).toEqual([]);
    expect(bad.notes.join()).toContain('package.json');
    const wrong = detectStacks(project({ 'package.json': '{"dependencies":["next"]}' }));
    expect(wrong.stacks).toEqual([]);
  });

  it('skips node_modules below a monorepo folder', () => {
    expect(detectStacks(project({ 'packages/node_modules/Cargo.toml': '' })).stacks).toEqual([]);
  });

  it('sorts and removes duplicates', () => {
    const { stacks } = detectStacks(
      project({ 'Cargo.toml': '', 'src-tauri/x': '', 'crates/a/Cargo.toml': '' }),
    );
    expect(stacks).toEqual(['rust', 'tauri']);
  });
});

const YAML = `# top comment
studio: 1
primary_repo: org/app # the repo
repos: [org/app]
ci:
  provider: github
  runners: github-hosted
  capacity: { total: 1, merge_max_busy: 1, check_twice_seconds: 0 }
merge: { strategy: studio-queue }
roles:
  builder: { model: sonnet, wip: 1 }
`;

describe('studio setup stack', () => {
  const run = async (dir: string, ...args: string[]) => {
    let out = '';
    let err = '';
    const code = await runCli(['--project', dir, 'setup', 'stack', ...args], {
      ports: {} as Ports,
      stdout: (s) => {
        out += s;
      },
      stderr: (s) => {
        err += s;
      },
      env: {},
      homedir: root,
      cwd: root,
    });
    return { code, out, err };
  };

  it('changes nothing without --write', async () => {
    const d = project({ 'Cargo.toml': '', '.studio/studio.yaml': YAML });
    const r = await run(d);
    expect(r.code).toBe(0);
    expect(r.out).toContain('rust');
    expect(readFileSync(join(d, '.studio/studio.yaml'), 'utf8')).toBe(YAML);
  });

  it('--write stores the stacks and keeps comments', async () => {
    const d = project({ 'Cargo.toml': '', '.studio/studio.yaml': YAML });
    expect((await run(d, '--write')).code).toBe(0);
    expect(loadConfig(d).stacks).toEqual(['rust']);
    const text = readFileSync(join(d, '.studio/studio.yaml'), 'utf8');
    expect(text).toContain('# top comment');
    expect(text).toContain('# the repo');
  });

  it('says what differs from the stored list', async () => {
    const d = project({
      'Cargo.toml': '',
      '.studio/studio.yaml': `${YAML}stacks: [docker]\n`,
    });
    const r = await run(d, '--json');
    const parsed = JSON.parse(r.out);
    expect(parsed.stacks).toEqual(['rust']);
    expect(parsed.added).toEqual(['rust']);
    expect(parsed.removed).toEqual(['docker']);
    expect(parsed.written).toBe(false);
  });

  it('invalid yaml fails and writes nothing', async () => {
    const d = project({ 'Cargo.toml': '', '.studio/studio.yaml': 'a: [1' });
    const r = await run(d, '--write');
    expect(r.code).toBe(1);
    expect(readFileSync(join(d, '.studio/studio.yaml'), 'utf8')).toBe('a: [1');
  });

  it('a file that would stay invalid writes nothing', async () => {
    const d = project({ 'Cargo.toml': '', '.studio/studio.yaml': 'studio: 1\n' });
    expect((await run(d, '--write')).code).toBe(1);
    expect(readFileSync(join(d, '.studio/studio.yaml'), 'utf8')).toBe('studio: 1\n');
  });

  it('an unknown setup subcommand is a usage error', async () => {
    let err = '';
    const code = await runCli(['setup', 'nope'], {
      ports: {} as Ports,
      stdout: () => {},
      stderr: (s) => {
        err += s;
      },
      env: {},
      homedir: root,
      cwd: root,
    });
    expect(code).toBe(1);
    expect(err).toContain('setup needs a subcommand');
  });

  it('doctor names the stacks or says how to set them', async () => {
    const d = project({ '.studio/studio.yaml': `${YAML}stacks: [rust]\n` });
    const doctor = async (dir: string) => {
      let out = '';
      await runCli(['--project', dir, 'doctor'], {
        ports: {} as Ports,
        stdout: (s) => {
          out += s;
        },
        stderr: () => {},
        env: {},
        homedir: root,
        cwd: root,
      });
      return out;
    };
    expect(await doctor(d)).toContain('stacks: rust');
    const none = project({ '.studio/studio.yaml': YAML });
    expect(await doctor(none)).toContain('stacks: not set: run studio setup stack');
  });
});
