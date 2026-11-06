import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadBoard, type WorkItem } from '../src/board.js';
import { runCli } from '../src/cli.js';
import { loadOwnerConfig, studioConfigSchema } from '../src/config.js';
import { launchCrew } from '../src/crew.js';
import { classifyDecision } from '../src/pane-data.js';
import { ownerStateRootFor, stateRootFor } from '../src/paths.js';
import { type Ports, realPorts } from '../src/ports.js';
import { REA_CLASS_NAMES } from '../src/rea.js';
import {
  consentQuestion,
  DEFAULT_ANALYSIS_DIR,
  ensureRea,
  FOLDER_QUESTION,
  ReaInstallNeeded,
  readConsent,
  recordConsent,
  researchFolder,
  TRUST_NOTICE,
} from '../src/rea-consent.js';
import { updateReaAllow, verifyReaInstall } from '../src/rea-install.js';
import { fakeReaInstall, REA_TEST_INTEGRITY } from './rea-fixture.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-rea-consent-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();

const config = studioConfigSchema.parse({
  studio: 1,
  primaryRepo: 'org/app',
  repos: ['org/app'],
  ci: {
    provider: 'github',
    runners: 'github-hosted',
    runnerLabels: [],
    capacity: { total: 8, mergeMaxBusy: 5, checkTwiceSeconds: 30 },
  },
  merge: { strategy: 'studio-queue', contractPaths: [] },
  roles: {
    researcher: { model: 'sonnet', wip: 1, skills: { required: [], allowed: [], denied: [] } },
  },
  sandbox: { networkAllow: ['github.com'] },
  allowAmbientCredentials: true,
});

const research: WorkItem = {
  id: 'APP-5',
  title: 'How does the sync work',
  type: 'research',
  role: 'researcher',
  repo: 'org/app',
  size: 'S',
  priority: 1,
  status: 'assigned',
  paths: [],
  touches: [],
  dependsOn: [],
  dod: ['structure of the sync protocol'],
  history: [],
};

/** npm that "installs" the fake package and records what it was asked. */
function fakeNpm() {
  const calls: string[][] = [];
  return {
    calls,
    npm: {
      async run(args: string[], _env: Record<string, string>, cwd: string) {
        calls.push(args);
        if (args[0] === 'view') {
          return { code: 0, stdout: JSON.stringify(REA_TEST_INTEGRITY), stderr: '' };
        }
        fakeReaInstall(cwd);
        return { code: 0, stdout: '', stderr: '' };
      },
    },
  };
}

/** A project, an owner home with a config, the REA skill, and ports with a fake npm and claude. */
function setup(
  o: { roots?: boolean; ownerYaml?: string; installed?: boolean; trust?: boolean } = {},
) {
  const dir = join(root, `c${n++}`);
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const origin = join(dir, 'origin.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  const project = join(dir, 'clone');
  git(dir, 'clone', '-q', origin, project);
  git(project, 'checkout', '-q', '-b', 'main');
  writeFileSync(join(project, 'README.md'), 'x\n');
  git(project, 'add', 'README.md');
  git(project, 'commit', '-q', '-m', 'init');
  git(project, 'push', '-q', 'origin', 'main');
  const area = join(dir, 'area');
  mkdirSync(join(area, 'vendor-x'), { recursive: true });
  mkdirSync(join(home, '.config', 'studio'), { recursive: true });
  const yaml =
    o.ownerYaml ??
    `${o.roots === false ? '' : `research_roots: ${JSON.stringify([area])}\n`}${o.trust === false ? 'research: { trust: false }\n' : ''}`;
  writeFileSync(join(home, '.config', 'studio', 'config.yaml'), yaml);
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  const owner = { homedir: home, env };
  const ownerRoot = ownerStateRootFor(owner);
  if (o.installed === true) {
    fakeReaInstall(join(ownerRoot, 'rea', '6.7.0'), { full: o.trust !== false });
  }
  const skills = join(home, '.claude', 'skills');
  for (const s of ['studio-crew', 'reverse-engineer-anything']) {
    mkdirSync(join(skills, s), { recursive: true });
    writeFileSync(join(skills, s, 'SKILL.md'), '---\nname: x\n---\n');
  }
  const started: string[][] = [];
  const npm = fakeNpm();
  const ports: Ports = {
    ...realPorts(),
    npm: npm.npm,
    claude: {
      async start(_cwd, args) {
        started.push(args);
        return { pid: 4242 };
      },
      alive: () => false,
      identity: async () => 'start-4242',
      stop: async () => {},
    },
  };
  const item: WorkItem = { ...research, artifacts: realpathSync(join(area, 'vendor-x')) };
  return {
    project,
    home,
    owner,
    ownerRoot,
    area: realpathSync(area),
    item,
    ports,
    npm,
    started,
    state: stateRootFor(project, owner),
  };
}

type F = ReturnType<typeof setup>;
const answers = (lines: string[]) => {
  const asked: string[] = [];
  return {
    asked,
    asker: {
      isTerminal: true,
      readLine: async (p: string) => {
        asked.push(p);
        return lines.shift();
      },
    },
  };
};
const launch = (
  f: F,
  asker?: ReturnType<typeof answers>['asker'],
  item = f.item,
  cfg: typeof config = config,
) => launchCrew(f.project, item, cfg, f.ports, { ...f.owner, ...(asker ? { asker } : {}) });
/** The project's own analysis folder, as studio.yaml names it: under the default root. */
const inDefault = (f: F) => ({ ...config, research: { artifacts: join(f.home, 'analysis') } });

describe('the first REA install, in a terminal', () => {
  it('asks once, installs in full for trust mode, and the launch goes on; the answer is kept', async () => {
    const f = setup();
    const a = answers(['']);
    const r = await launch(f, a.asker);
    expect(a.asked).toEqual([consentQuestion('6.7.0')]);
    expect(a.asked[0]).toBe(
      'REA is not installed yet. Install rea-agents 6.7.0 now? It runs with your user rights outside the sandbox. [Y/n] ',
    );
    // Trust mode: optional dependencies and install scripts come along.
    const install = f.npm.calls.find((c) => c[0] === 'install') ?? [];
    expect(install).not.toContain('--ignore-scripts');
    expect(install).not.toContain('--omit=optional');
    expect(verifyReaInstall(f.ownerRoot, '6.7.0', undefined, 'full').entry).toContain('rea-agents');
    expect(readConsent(f.ownerRoot, '6.7.0', 'full')).toBe('yes');
    expect(f.started).toHaveLength(1);
    // The first launch in trust mode says what it means, once.
    expect(r.notice).toBe(TRUST_NOTICE);
    expect(TRUST_NOTICE).toMatch(/run as you, outside the sandbox/);
    const again = await launch(f, answers([]).asker);
    expect(again.notice).toBeUndefined();
  });

  it('a no is kept for that version: nothing installed, nothing started, never asked again', async () => {
    const f = setup();
    const a = answers(['n']);
    await expect(launch(f, a.asker)).rejects.toThrow(/declined; studio research install --yes/);
    expect(f.npm.calls).toEqual([]);
    expect(f.started).toEqual([]);
    const b = answers(['y']);
    await expect(launch(f, b.asker)).rejects.toThrow(/declined/);
    expect(b.asked).toEqual([]);
  });

  it('asks for the analysis folder when none is granted; Enter takes ~/analysis', async () => {
    const f = setup({ roots: false });
    const a = answers(['y', '']);
    await launch(f, a.asker, research, inDefault(f));
    expect(f.started).toHaveLength(1);
    expect(a.asked).toEqual([consentQuestion('6.7.0'), FOLDER_QUESTION]);
    expect(FOLDER_QUESTION).toContain(DEFAULT_ANALYSIS_DIR);
    expect(DEFAULT_ANALYSIS_DIR).toBe('~/analysis');
    const granted = join(f.home, 'analysis');
    expect(existsSync(granted)).toBe(true);
    expect(loadOwnerConfig(f.owner).researchRoots).toEqual([granted]);
  });
});

describe('the first REA install without a terminal', () => {
  /** What the pane's button writes (hooks/register.tsx, tested in hooks/register.test.tsx). */
  const paneConfirms = (f: F, version: string, folder?: string) => {
    mkdirSync(f.ownerRoot, { recursive: true });
    writeFileSync(
      join(f.ownerRoot, 'rea-consent.json'),
      JSON.stringify({
        [`${version}:full`]: {
          answer: 'yes',
          at: '2026-11-06T10:00:00.000Z',
          by: 'pane',
          ...(folder === undefined ? {} : { folder }),
        },
      }),
    );
  };
  const research_install = (f: F, args: string[], terminal: boolean) => {
    let err = '';
    return runCli(['--project', f.project, 'research', 'install', ...args], {
      ports: f.ports,
      stdout: () => {},
      stderr: (s) => {
        err += s;
      },
      env: { ...f.owner.env },
      homedir: f.home,
      cwd: f.project,
      isTerminal: terminal,
    }).then((code) => ({ code, err }));
  };

  it('puts one decision to the lead that never suggests a command without a terminal', async () => {
    const f = setup();
    const e = await launch(f).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ReaInstallNeeded);
    expect((e as Error).message).toBe(
      'REA install needed for APP-5: the owner confirms once, with the button in the Studio pane or with studio research install in their own terminal',
    );
    expect((e as Error).message).not.toContain('--yes');
    expect(classifyDecision((e as Error).message)).toBe('rea_install');
    expect(f.npm.calls).toEqual([]);
  });

  it('a --yes or --folder without a terminal is refused and changes nothing', async () => {
    const f = setup({ roots: false });
    for (const args of [
      ['--yes'],
      ['--yes', '--folder', join(f.home, 'x')],
      ['--folder', '/tmp'],
    ]) {
      const r = await research_install(f, args, false);
      expect(r.code).toBe(1);
      expect(r.err).toContain('needs your own terminal');
    }
    await expect(
      ensureRea({
        ownerRoot: f.ownerRoot,
        owner: f.owner,
        env: f.owner.env,
        ports: f.ports,
        asker: { isTerminal: false },
        now: new Date(),
        yes: true,
      }),
    ).rejects.toThrow(/count only in your own terminal/);
    expect(f.npm.calls).toEqual([]);
    expect(readConsent(f.ownerRoot, '6.7.0', 'full')).toBeUndefined();
    expect(loadOwnerConfig(f.owner).researchRoots).toEqual([]);
  });

  it('the pane confirmation counts: the next launch installs without asking', async () => {
    const f = setup();
    await expect(launch(f)).rejects.toThrow(ReaInstallNeeded);
    paneConfirms(f, '6.7.0');
    expect(readConsent(f.ownerRoot, '6.7.0', 'full')).toBe('yes');
    await launch(f);
    expect(f.npm.calls.map((c) => c[0])).toEqual(['view', 'install']);
    expect(f.started).toHaveLength(1);
  });

  it('without a granted folder the pane confirms ~/analysis with it, and the launch grants it', async () => {
    const f = setup({ roots: false });
    const e = await launch(f, undefined, research, inDefault(f)).catch((x: unknown) => x);
    expect((e as Error).message).toContain('(analysis folder ~/analysis)');
    const folder = join(f.home, 'analysis');
    paneConfirms(f, '6.7.0', folder);
    await launch(f, undefined, research, inDefault(f));
    expect(loadOwnerConfig(f.owner).researchRoots).toEqual([folder]);
    expect(f.started).toHaveLength(1);
  });

  it('in the owner terminal --yes and --folder confirm without a question', async () => {
    const f = setup({ roots: false });
    const folder = join(f.home, 'work', 'analysis');
    const r = await research_install(f, ['--yes', '--folder', folder], true);
    expect(r.code).toBe(0);
    expect(readConsent(f.ownerRoot, '6.7.0', 'full')).toBe('yes');
    expect(loadOwnerConfig(f.owner).researchRoots).toEqual([folder]);
  });

  it('a remembered yes installs without asking anybody', async () => {
    const f = setup();
    recordConsent(f.ownerRoot, '6.7.0', 'full', 'yes', new Date());
    await launch(f);
    expect(f.npm.calls.map((c) => c[0])).toEqual(['view', 'install']);
    expect(f.started).toHaveLength(1);
  });

  it('a new pinned version asks again', async () => {
    const f = setup({ ownerYaml: '' });
    writeFileSync(
      join(f.home, '.config', 'studio', 'config.yaml'),
      `research_roots: ${JSON.stringify([f.area])}\nrea_version: 6.8.0\n`,
    );
    recordConsent(f.ownerRoot, '6.7.0', 'full', 'yes', new Date());
    await expect(launch(f)).rejects.toThrow(ReaInstallNeeded);
    const a = answers(['y']);
    await launch(f, a.asker).catch(() => undefined);
    expect(a.asked).toEqual([consentQuestion('6.8.0')]);
    expect(readConsent(f.ownerRoot, '6.8.0', 'full')).toBe('yes');
  });
});

describe('never for a crew', () => {
  it('a crew can neither install nor confirm', async () => {
    const f = setup();
    const crewEnv = { ...f.owner.env, STUDIO_ROLE: 'crew' };
    await expect(
      ensureRea({
        ownerRoot: f.ownerRoot,
        owner: f.owner,
        env: crewEnv,
        ports: f.ports,
        asker: answers(['y']).asker,
        now: new Date(),
        yes: true,
      }),
    ).rejects.toThrow(/never by a crew/);
    let err = '';
    const code = await runCli(['--project', f.project, 'research', 'install', '--yes'], {
      ports: f.ports,
      stdout: () => {},
      stderr: (s) => {
        err += s;
      },
      env: crewEnv,
      homedir: f.home,
      cwd: f.project,
      isTerminal: true,
    });
    expect(code).toBe(1);
    expect(err).toContain('never by a crew');
    expect(f.npm.calls).toEqual([]);
    expect(readConsent(f.ownerRoot, '6.7.0', 'full')).toBeUndefined();
  });

  it('without --yes and without a terminal, research install changes nothing', async () => {
    const f = setup();
    const code = await runCli(['--project', f.project, 'research', 'install'], {
      ports: f.ports,
      stdout: () => {},
      stderr: () => {},
      env: f.owner.env,
      homedir: f.home,
      cwd: f.project,
      isTerminal: false,
    });
    expect(code).toBe(1);
    expect(f.npm.calls).toEqual([]);
  });
});

describe('trust mode and strict mode', () => {
  const classesOf = (f: F) =>
    JSON.parse(readFileSync(join(f.state, 'guard', 'APP-5.json'), 'utf8')).mcpAllow as string[];
  it('trust mode (the default) opens every class without studio research allow', async () => {
    const f = setup({ installed: true });
    expect(loadOwnerConfig(f.owner).research.trust).toBe(true);
    await launch(f);
    const allowed = classesOf(f);
    expect(allowed).toContain('mcp__rea__start_frida_session');
    expect(allowed).toContain('mcp__rea__capture_adb_screen');
    expect(REA_CLASS_NAMES.length).toBeGreaterThan(1);
  });
  it('strict mode keeps the static install and the per-item classes', async () => {
    const f = setup({ installed: true, trust: false });
    await launch(f);
    expect(classesOf(f)).not.toContain('mcp__rea__start_frida_session');
    updateReaAllow(f.state, 'APP-5', { add: ['debug'] });
    await launch(f);
    expect(classesOf(f)).toContain('mcp__rea__start_frida_session');
  });
  it('a static install does not count for trust mode, which asks for the full one', async () => {
    const f = setup({ installed: false });
    fakeReaInstall(join(f.ownerRoot, 'rea', '6.7.0'));
    await expect(launch(f)).rejects.toThrow(ReaInstallNeeded);
  });
});

describe('a folder on request', () => {
  it('takes a sub-folder of a granted root and refuses one outside every root', () => {
    const f = setup();
    expect(researchFolder(join(f.area, 'vendor-x'), [f.area], f.home)).toBe(
      join(f.area, 'vendor-x'),
    );
    mkdirSync(join(f.home, 'analysis', 'vendor-y'), { recursive: true });
    expect(researchFolder('~/analysis/vendor-y', [join(f.home, 'analysis')], f.home)).toBe(
      realpathSync(join(f.home, 'analysis', 'vendor-y')),
    );
    expect(() => researchFolder(join(f.home), [f.area], f.home)).toThrow(/not below a granted/);
    expect(() => researchFolder(join(f.area, 'missing'), [f.area], f.home)).toThrow(/no such/);
    expect(() => researchFolder(join(f.area, 'vendor-x'), [], f.home)).toThrow(
      /no research_roots granted/,
    );
  });

  it('studio add --artifacts files a research item for the researcher with that folder', async () => {
    const f = setup({ installed: true });
    mkdirSync(join(f.project, '.studio'), { recursive: true });
    writeFileSync(
      join(f.project, '.studio', 'studio.yaml'),
      'studio: 1\nprimary_repo: org/app\nrepos: [org/app]\nci: { provider: github, runners: github-hosted, runner_labels: [], capacity: { total: 4, merge_max_busy: 3, check_twice_seconds: 0 } }\nmerge: { strategy: studio-queue, contract_paths: [] }\nroles:\n  researcher: { model: sonnet, wip: 1 }\n',
    );
    writeFileSync(join(f.project, '.studio', 'board.yaml'), 'items: []\n');
    let out = '';
    const run = (dir: string) =>
      runCli(
        [
          '--project',
          f.project,
          'add',
          'What does vendor x send',
          '--dod',
          'the message format is described',
          '--artifacts',
          dir,
        ],
        {
          ports: f.ports,
          stdout: (s) => {
            out += s;
          },
          stderr: () => {},
          env: f.owner.env,
          homedir: f.home,
          cwd: f.project,
          isTerminal: false,
        },
      );
    expect(await run(join(f.area, 'vendor-x'))).toBe(0);
    expect(JSON.parse(out).item).toBe('APP-1');
    expect(loadBoard(f.project).items[0]).toMatchObject({
      role: 'researcher',
      type: 'research',
      artifacts: join(f.area, 'vendor-x'),
    });
    expect(await run(f.home)).toBe(1);
  });
});
