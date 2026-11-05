import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { WorkItem } from '../src/board.js';
import { resolveSkills } from '../src/capabilities.js';
import { studioConfigSchema } from '../src/config.js';
import { launchCrew, writeCrewSettings } from '../src/crew.js';
import { DEFAULT_SECRET_GLOBS, evaluateGuard, type GuardContext } from '../src/guard.js';
import { stateRootFor } from '../src/paths.js';
import { type Ports, realPorts } from '../src/ports.js';
import { privacyHits, privacyHitsInDir, privacyLine } from '../src/privacy.js';
import {
  itemReaClasses,
  REA_CLASS_NAMES,
  REA_CLASSES,
  REA_KNOWN_TOOLS,
  REA_SKILL,
  REA_STATIC_TOOLS,
  reaAllowedTools,
  reaDenyRules,
  reaGuard,
  reaMcpServer,
  reaToolName,
  renderReaBrief,
} from '../src/rea.js';
import { REA_TOOL_SCHEMAS } from '../src/rea-schemas.js';
import { reaState } from '../src/secret-command.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-rea-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('the REA tool allowlist', () => {
  it('names each tool once: static tools are in no class, classes do not overlap', () => {
    const all = [...REA_STATIC_TOOLS, ...Object.values(REA_CLASSES).flat()];
    expect(new Set(all).size).toBe(all.length);
    expect(REA_KNOWN_TOOLS.length).toBe(all.length);
    for (const t of all) expect(t).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('keeps every dynamic, instrumenting, writing or device tool out of the static list', () => {
    const bad =
      /(^|_)(frida|gdb|rizin_debug|adb|capture|observe|install|uninstall|start|stop|push|pull|comment|set|annotate|bookmark|instrument|extract|export|execute|cutter|unknown)(_|$)/;
    const stray = REA_STATIC_TOOLS.filter((t) => bad.test(t));
    // Both only compare or check what exists.
    expect(stray.sort()).toEqual(['compare_javascript_export_shapes', 'verify_unknown_resolution']);
  });

  it('puts the named tools in the classes the issue lists', () => {
    expect(REA_CLASSES.debug).toContain('instrument_with_frida');
    expect(REA_CLASSES.debug).toContain('start_gdb_session');
    expect(REA_CLASSES.debug).toContain('start_rizin_debug_session');
    expect(REA_CLASSES.device).toContain('install_adb_package');
    expect(REA_CLASSES.device).toContain('push_adb_file');
    expect(REA_CLASSES.device).toContain('pull_adb_file');
    expect(REA_CLASSES.observe).toContain('capture_web_screenshot');
    expect(REA_CLASSES.observe).toContain('observe_native_calls');
    expect(REA_CLASSES.annotate).toContain('set_comment');
    expect(REA_CLASSES.annotate).toContain('set_address_name');
    expect(REA_STATIC_TOOLS).toContain('procedure_pseudo_code');
    expect(REA_STATIC_TOOLS).toContain('search_strings');
    expect(REA_STATIC_TOOLS).toContain('list_procedures');
    expect(REA_STATIC_TOOLS).toContain('inspect_artifact');
  });

  it('allows the static tools by default and a class only when named', () => {
    const base = reaAllowedTools([]);
    expect(base).toContain(reaToolName('search_strings'));
    expect(base).not.toContain(reaToolName('instrument_with_frida'));
    expect(reaAllowedTools(['debug'])).toContain(reaToolName('instrument_with_frida'));
    expect(reaAllowedTools(['debug'])).not.toContain(reaToolName('install_adb_package'));
  });

  it('denies every known tool that is not allowed, by name', () => {
    const deny = reaDenyRules([]);
    expect(deny).toContain('mcp__rea__start_frida_session');
    expect(deny).not.toContain('mcp__rea__search_strings');
    expect(deny.length).toBe(REA_KNOWN_TOOLS.length - REA_STATIC_TOOLS.length);
    expect(reaDenyRules(REA_CLASS_NAMES)).toEqual([]);
  });

  it('reads classes from an item note and ignores a typo', () => {
    expect(itemReaClasses(['rea-allow: debug, observe', 'other'])).toEqual(['debug', 'observe']);
    expect(itemReaClasses(['rea-allow: dbug'])).toEqual([]);
    expect(itemReaClasses(['question: rea-allow: debug'])).toEqual([]);
    expect(itemReaClasses(undefined)).toEqual([]);
  });

  it('registers the server at an exact version with a fixed npm cache', () => {
    const s = reaMcpServer('6.7.0', { JAVA_HOME: '/x' }, '/cache') as {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
    expect(s.command).toBe('npx');
    expect(s.args).toEqual(['-y', 'rea-agents@6.7.0', 'mcp']);
    expect(s.env).toMatchObject({ JAVA_HOME: '/x', npm_config_cache: '/cache' });
  });
});

describe('who may use the REA skill', () => {
  const item: WorkItem = {
    id: 'APP-5',
    title: 'x',
    type: 'research',
    role: 'researcher',
    repo: 'org/app',
    size: 'S',
    priority: 1,
    status: 'assigned',
    paths: [],
    touches: [],
    dependsOn: [],
    dod: ['a'],
    history: [],
  };
  const skills = { required: [], allowed: [REA_SKILL], denied: [] };
  it('offers it to the researcher', () => {
    const r = resolveSkills(item, 'researcher', [], [], 'build', { roleSkills: skills });
    expect(r.offered).toContain(REA_SKILL);
    expect(r.denied).not.toContain(REA_SKILL);
  });
  it('denies it to every other role, even when studio.yaml lists it', () => {
    for (const role of ['builder', 'reviewer', 'designer', 'release', 'lead']) {
      const r = resolveSkills({ ...item, role: role as WorkItem['role'] }, role, [], [], 'build', {
        roleSkills: { required: [REA_SKILL], allowed: [REA_SKILL], denied: [] },
      });
      expect(r.denied, role).toContain(REA_SKILL);
      expect([...r.required, ...r.offered, ...r.optionalRequired], role).not.toContain(REA_SKILL);
    }
  });
});

describe('the guard for a researcher', () => {
  const art = join(root, 'g', 'art');
  const wt = join(root, 'g', 'wt');
  const other = join(root, 'g', 'other');
  mkdirSync(art, { recursive: true });
  mkdirSync(wt, { recursive: true });
  mkdirSync(other, { recursive: true });
  writeFileSync(join(art, 'target.bin'), 'x');
  symlinkSync(art, join(wt, 'link-to-art'));
  symlinkSync(other, join(art, 'escape'));
  const ctx: GuardContext = {
    worktree: wt,
    ownerOnly: [],
    deployCommands: [],
    secretGlobs: DEFAULT_SECRET_GLOBS,
    item: 'APP-5',
    base: 'main',
    ...reaGuard(art, []),
  };
  const mcp = (tool: string, input: Record<string, unknown>, c = ctx) =>
    evaluateGuard({ toolName: reaToolName(tool), toolInput: input }, c);
  const bash = (command: string, c = ctx) =>
    evaluateGuard({ toolName: 'Bash', toolInput: { command } }, c);

  it('allows a static tool on a path in the analysis directory or the checkout', () => {
    expect(mcp('open_binary', { path: join(art, 'target.bin') }).decision).toBe('allow');
    expect(mcp('search_strings', { pattern: '/api/v1' }).decision).toBe('allow');
    expect(
      mcp('analyze_javascript_application', { input_path: art, source_paths: ['main.js'] })
        .decision,
    ).toBe('allow');
  });

  it('denies a path outside, through .., through a link out, or in a URL form', () => {
    expect(mcp('open_binary', { path: join(other, 'x') }).decision).toBe('deny');
    expect(mcp('open_binary', { path: `${art}/../other/x` }).decision).toBe('deny');
    expect(mcp('open_binary', { path: join(art, 'escape', 'x') }).decision).toBe('deny');
    expect(mcp('open_binary', { path: 'file:///etc/passwd' }).decision).toBe('deny');
    expect(mcp('open_binary', { path: '~/x' }).decision).toBe('deny');
    expect(
      mcp('analyze_javascript_application', { input_path: art, source_paths: ['../x'] }).decision,
    ).toBe('deny');
  });

  it('denies any tool that asks to write, even a static one', () => {
    expect(mcp('close_binary', { snapshot_path: join(art, 's.json') }).decision).toBe('deny');
    expect(mcp('close_binary', { overwrite: true }).decision).toBe('deny');
    expect(mcp('close_binary', {}).decision).toBe('allow');
  });

  it('reads a database for its structure, never its rows', () => {
    const p = join(art, 'a.sqlite');
    expect(mcp('inspect_sqlite_database', { path: p }).decision).toBe('allow');
    expect(mcp('inspect_sqlite_database', { path: p, schema_scope: 'database' }).decision).toBe(
      'allow',
    );
    expect(mcp('inspect_sqlite_database', { path: p, table: 't' }).decision).toBe('deny');
    expect(mcp('inspect_sqlite_database', { path: p, row_limit: 3 }).decision).toBe('deny');
    expect(
      mcp('inspect_sqlite_database', { path: p, schema_scope: 'selected_table' }).decision,
    ).toBe('deny');
  });

  it('denies dynamic tools, unknown tools and other servers', () => {
    expect(mcp('start_frida_session', {}).decision).toBe('deny');
    expect(mcp('install_adb_package', {}).decision).toBe('deny');
    expect(mcp('some_future_tool', {}).decision).toBe('deny');
    expect(evaluateGuard({ toolName: 'mcp__other__x', toolInput: {} }, ctx).decision).toBe('deny');
  });

  it('allows a class tool only when the item names its class', () => {
    const open = { ...ctx, ...reaGuard(art, ['debug']) };
    expect(mcp('start_gdb_session', {}, open).decision).toBe('allow');
    expect(mcp('install_adb_package', {}, open).decision).toBe('deny');
  });

  it('allows no REA tool for a crew without an analysis directory', () => {
    const plain = { ...ctx, mcpAllow: undefined, artifacts: undefined, blockedCommands: undefined };
    expect(mcp('search_strings', {}, plain).decision).toBe('deny');
  });

  it('keeps the analysis directory out of the read tools, the writers and the shell', () => {
    const f = join(art, 'target.bin');
    for (const tool of ['Read', 'Grep', 'Glob']) {
      const input = tool === 'Read' ? { file_path: f } : { path: art, pattern: '*' };
      expect(evaluateGuard({ toolName: tool, toolInput: input }, ctx).decision, tool).toBe('deny');
    }
    expect(
      evaluateGuard(
        { toolName: 'Write', toolInput: { file_path: join(art, 'n.txt'), content: 'x' } },
        ctx,
      ).decision,
    ).toBe('deny');
    for (const c of [
      `strings ${f}`,
      `cat ${f} | head`,
      `cp ${f} .`,
      `python3 ${join(art, 'run.py')}`,
      `ls ${art}`,
      `cat < ${f}`,
      `echo $(cat ${f})`,
      `git add ${f}`,
      `touch ${join(art, 'n.txt')}`,
    ]) {
      expect(bash(c).decision, c).toBe('deny');
    }
    expect(
      evaluateGuard({ toolName: 'Bash', toolInput: { command: 'ls' }, cwd: art }, ctx).decision,
    ).toBe('deny');
    expect(bash('ls').decision).toBe('allow');
    expect(bash('git add notes.md').decision).toBe('allow');
  });

  it('refuses debuggers, device and capture tools unless the class is named', () => {
    for (const c of [
      'gdb ./x',
      'lldb x',
      'frida -p 1',
      'adb devices',
      'tcpdump -i en0',
      'strace ls',
    ]) {
      expect(bash(c).decision, c).toBe('deny');
    }
    const open = { ...ctx, ...reaGuard(art, ['debug', 'device', 'observe']) };
    expect(bash('adb devices', open).decision).toBe('allow');
    expect(bash('gdb --version', open).decision).toBe('allow');
  });
});

describe('the privacy check', () => {
  const kinds = (t: string) => privacyHits(t, 'r').map((h) => h.kind);
  it('passes a structure report', () => {
    const text = [
      '# Findings',
      'The store is a SQLite file with 14 tables. Table `customer` has columns id (integer), first_name (text), email (text).',
      'The client calls POST /api/v1/sync with a JSON body; field `phone` is a string. Placeholder: user@example.invalid.',
      'Version 2.14.7 of the module at 0x00401000; built 2026-11-05 10:20:30.',
      '| column | type |',
      '| --- | --- |',
      '| id | integer |',
    ].join('\n');
    expect(privacyHits(text, 'r')).toEqual([]);
  });
  it('catches an email, a phone-like number, a personal field with a value', () => {
    expect(kinds('write to anna.k@mail-provider.de please')).toContain('email address');
    expect(kinds('call +49 871 123456 today')).toContain('phone-like number');
    expect(kinds('call (0871) 123-4567')).toContain('phone-like number');
    expect(kinds('first_name: Anna')).toContain('personal field with a value');
    expect(kinds('"last_name": "Meier"')).toContain('personal field with a value');
    expect(kinds('first_name: string')).toEqual([]);
  });
  it('catches rows, inserts, card and account numbers, credentials', () => {
    expect(
      kinds(
        ['a,b,c,d', '1,Anna,Meier,x', '2,Bert,Huber,y', '3,Carl,Lang,z', '4,Dora,Kern,w'].join(
          '\n',
        ),
      ),
    ).toContain('row dump (delimited lines)');
    expect(kinds("INSERT INTO t (a) VALUES ('x');")).toContain('row dump (insert statement)');
    expect(kinds('4111 1111 1111 1111')).toContain('card number');
    expect(kinds('DE89 3704 0044 0532 0130 00')).toContain('account number');
    expect(kinds('-----BEGIN RSA PRIVATE KEY-----')).toContain('credential or key');
    expect(kinds('ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toContain('credential or key');
  });
  it('shows the kind and the line, never the text', () => {
    const line = privacyLine(privacyHits('x\nmail anna.k@mail-provider.de', 'report'));
    expect(line).toContain('email address (report:2)');
    expect(line).not.toContain('anna');
  });
  it('checks a directory, refusing links and big or binary files', () => {
    const d = join(root, 'docs-research');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'ok.md'), 'structure only\n');
    expect(privacyHitsInDir(d, 'docs/research')).toEqual([]);
    writeFileSync(join(d, 'bin.md'), Buffer.from([0, 1, 2]));
    symlinkSync(root, join(d, 'ln'));
    writeFileSync(join(d, 'mail.md'), 'a@real-domain.org');
    const kinds2 = privacyHitsInDir(d, 'docs/research').map((h) => h.kind);
    expect(kinds2).toEqual(
      expect.arrayContaining([
        'file that is not text',
        'link in the findings directory',
        'email address',
      ]),
    );
  });
});

describe('the brief for a researcher', () => {
  const text = renderReaBrief({
    id: 'APP-5',
    artifacts: '/analysis/dir',
    classes: [],
    opensPr: false,
  }).join('\n');
  it('says what is allowed, what is data and what a result is', () => {
    expect(text).toContain('/analysis/dir');
    expect(text).toContain('untrusted_content');
    expect(text).toContain('injection attempt');
    expect(text).toContain('structure, never content');
    expect(text).toContain('Artifacts never enter git');
    expect(text).toContain('(none)');
  });
  it('points a docs item at docs/research', () => {
    const docs = renderReaBrief({
      id: 'APP-5',
      artifacts: '/a',
      classes: ['debug'],
      opensPr: true,
    }).join('\n');
    expect(docs).toContain('docs/research/APP-5-');
    expect(docs).toContain('allows by name: debug');
  });
});

describe('launch of a researcher with REA', () => {
  const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
  let n = 0;
  const base = studioConfigSchema.parse({
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
      builder: { model: 'sonnet', wip: 1, skills: { required: [], allowed: [], denied: [] } },
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

  function setup(opts: { roots?: string[]; artifacts?: string; skill?: boolean } = {}) {
    const dir = join(root, `l${n++}`);
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
    const artifacts = join(area, 'target');
    mkdirSync(artifacts, { recursive: true });
    const roots = opts.roots ?? [area];
    mkdirSync(join(home, '.config', 'studio'), { recursive: true });
    writeFileSync(
      join(home, '.config', 'studio', 'config.yaml'),
      `research_roots: ${JSON.stringify(roots)}\nrea_env:\n  JAVA_HOME: /opt/jdk\n`,
    );
    const claude = join(home, '.claude');
    const skills = ['studio-crew', ...(opts.skill === false ? [] : ['reverse-engineer-anything'])];
    for (const s of skills) {
      mkdirSync(join(claude, 'skills', s), { recursive: true });
      writeFileSync(join(claude, 'skills', s, 'SKILL.md'), '---\nname: x\n---\n');
    }
    const launcher = { homedir: home, env: { PATH: process.env.PATH } };
    const config = { ...base, research: { artifacts: opts.artifacts ?? artifacts } };
    const started: { args: string[]; env: Record<string, string> }[] = [];
    const ports: Ports = {
      ...realPorts(),
      claude: {
        async start(_cwd, args, _prompt, _log, env) {
          started.push({ args, env });
          return { pid: 4242 };
        },
        alive: () => false,
        identity: async () => 'start-4242',
        stop: async () => {},
      },
    };
    return {
      project,
      launcher,
      config,
      ports,
      started,
      state: stateRootFor(project, launcher),
      artifacts: realpathSync(artifacts),
    };
  }

  it('gives the researcher one pinned server, the allowlist, a read-only analysis directory', async () => {
    const f = setup();
    await launchCrew(f.project, research, f.config, f.ports, f.launcher);
    const mcp = JSON.parse(readFileSync(join(f.state, 'settings', 'APP-5.mcp.json'), 'utf8'));
    expect(Object.keys(mcp.mcpServers)).toEqual(['rea']);
    expect(mcp.mcpServers.rea.args).toEqual(['-y', 'rea-agents@6.7.0', 'mcp']);
    expect(mcp.mcpServers.rea.env.JAVA_HOME).toBe('/opt/jdk');
    const s = JSON.parse(readFileSync(join(f.state, 'settings', 'APP-5.json'), 'utf8'));
    expect(s.permissions.deny).toContain('mcp__rea__start_frida_session');
    expect(s.permissions.deny).not.toContain('mcp__rea__search_strings');
    expect(s.permissions.deny).not.toContain('mcp__*');
    expect(s.permissions.deny).not.toContain('Skill(reverse-engineer-anything)');
    expect(s.sandbox.filesystem.denyRead).toContain(f.artifacts);
    expect(s.sandbox.filesystem.allowRead).not.toContain(f.artifacts);
    expect(s.sandbox.filesystem.denyWrite).toContain(f.artifacts);
    expect(s.sandbox.filesystem.allowWrite).not.toContain(f.artifacts);
    const ctx = JSON.parse(readFileSync(join(f.state, 'guard', 'APP-5.json'), 'utf8'));
    expect(ctx.artifacts).toBe(f.artifacts);
    expect(ctx.mcpAllow).toContain('mcp__rea__search_strings');
    expect(ctx.mcpAllow).not.toContain('mcp__rea__start_frida_session');
    const brief = readFileSync(join(f.state, 'briefs', 'APP-5.md'), 'utf8');
    expect(brief).toContain('## Reverse engineering (REA)');
    expect(brief).toContain('reverse-engineer-anything');
  });

  it('adds the classes an item names, and nothing else', async () => {
    const f = setup();
    await launchCrew(
      f.project,
      { ...research, notes: ['rea-allow: observe'] },
      f.config,
      f.ports,
      f.launcher,
    );
    const ctx = JSON.parse(readFileSync(join(f.state, 'guard', 'APP-5.json'), 'utf8'));
    expect(ctx.mcpAllow).toContain('mcp__rea__capture_web_screenshot');
    expect(ctx.mcpAllow).not.toContain('mcp__rea__start_frida_session');
    expect(ctx.blockedCommands).toContain('adb');
    expect(ctx.blockedCommands).not.toContain('tcpdump');
  });

  it('gives a builder no server and denies the skill, whatever studio.yaml names', async () => {
    const f = setup();
    const builder = { ...research, id: 'APP-6', type: 'chore' as const, role: 'builder' as const };
    await launchCrew(f.project, builder, f.config, f.ports, f.launcher);
    const mcp = JSON.parse(readFileSync(join(f.state, 'settings', 'APP-6.mcp.json'), 'utf8'));
    expect(mcp).toEqual({ mcpServers: {} });
    const s = JSON.parse(readFileSync(join(f.state, 'settings', 'APP-6.json'), 'utf8'));
    expect(s.permissions.deny).toContain('mcp__*');
    expect(s.permissions.deny).toContain('Skill(reverse-engineer-anything)');
    const ctx = JSON.parse(readFileSync(join(f.state, 'guard', 'APP-6.json'), 'utf8'));
    expect(ctx.artifacts).toBeUndefined();
    expect(ctx.mcpAllow).toBeUndefined();
  });

  it('runs a researcher of a project without research.artifacts as before, skill denied', async () => {
    const f = setup();
    const { research: _r, ...plain } = f.config;
    await launchCrew(f.project, research, plain as typeof f.config, f.ports, f.launcher);
    const s = JSON.parse(readFileSync(join(f.state, 'settings', 'APP-5.json'), 'utf8'));
    expect(s.permissions.deny).toContain('mcp__*');
    expect(s.permissions.deny).toContain('Skill(reverse-engineer-anything)');
    expect(JSON.parse(readFileSync(join(f.state, 'settings', 'APP-5.mcp.json'), 'utf8'))).toEqual({
      mcpServers: {},
    });
  });

  it('refuses without research_roots, outside them, in the credential store, or without the skill', async () => {
    const none = setup({ roots: [] });
    await expect(
      launchCrew(none.project, research, none.config, none.ports, none.launcher),
    ).rejects.toThrow(/research_roots/);
    expect(none.started).toHaveLength(0);

    const out = setup({ roots: [join(root, 'nowhere')] });
    await expect(
      launchCrew(out.project, research, out.config, out.ports, out.launcher),
    ).rejects.toThrow(/not below a research_roots/);

    const home = setup();
    mkdirSync(join(home.launcher.homedir, '.ssh'));
    const bad = { ...home.config, research: { artifacts: join(home.launcher.homedir, '.ssh') } };
    await expect(
      launchCrew(home.project, research, bad, home.ports, home.launcher),
    ).rejects.toThrow(/research\.artifacts/);

    const noSkill = setup({ skill: false });
    await expect(
      launchCrew(noSkill.project, research, noSkill.config, noSkill.ports, noSkill.launcher),
    ).rejects.toThrow(/REA skill is not installed/);
    expect(noSkill.started).toHaveLength(0);
  });
});

describe('studio doctor on REA', () => {
  it('shows nothing when nothing asks for REA', () => {
    expect(reaState(undefined, undefined, undefined)).toBeNull();
  });
  it('shows the pin, states and no path', () => {
    const cfg = studioConfigSchema.parse({
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
      research: { artifacts: join(root, 'does-not-exist'), reaVersion: '6.8.0' },
    });
    const s = reaState(cfg, undefined, undefined);
    expect(s?.server).toBe('rea-agents@6.8.0');
    expect(s?.pinnedBy).toBe('studio.yaml');
    expect(s?.analysisDirectory).toMatch(/refused/);
    expect(JSON.stringify(s)).not.toContain(root);
  });
});

describe('the guard reads values, not key names, and resolves every path', () => {
  const dir = join(root, 'v');
  const art = join(dir, 'art');
  const wt = join(dir, 'wt');
  const other = join(dir, 'other');
  mkdirSync(join(art, 'sub'), { recursive: true });
  mkdirSync(join(wt, 'sub'), { recursive: true });
  mkdirSync(other, { recursive: true });
  symlinkSync(other, join(wt, 'out'));
  symlinkSync(other, join(art, 'sub', 'out'));
  const ctx: GuardContext = {
    worktree: wt,
    ownerOnly: [],
    deployCommands: [],
    secretGlobs: DEFAULT_SECRET_GLOBS,
    item: 'APP-5',
    base: 'main',
    ...reaGuard(art, []),
  };
  const mcp = (tool: string, input: Record<string, unknown>) =>
    evaluateGuard({ toolName: reaToolName(tool), toolInput: input }, ctx);
  const bash = (command: string, cwd?: string) =>
    evaluateGuard({ toolName: 'Bash', toolInput: { command }, ...(cwd ? { cwd } : {}) }, ctx);

  it('resolves relative paths, through links', () => {
    expect(mcp('open_binary', { path: 'sub/x' }).decision).toBe('allow');
    expect(mcp('open_binary', { path: 'out/x' }).decision).toBe('deny');
    expect(mcp('open_binary', { path: '../other/x' }).decision).toBe('deny');
    expect(mcp('open_binary', { path: join(art, 'sub', 'out', 'x') }).decision).toBe('deny');
    expect(mcp('open_binary', { path: './out' }).decision).toBe('deny');
    expect(mcp('open_binary', { path: join(other, 'x') }).decision).toBe('deny');
  });

  it('treats any argument of every static tool as a place when its value looks like one', () => {
    const skipped = new Set([
      'query',
      'pattern',
      'name',
      'names',
      'symbols',
      'selector',
      'class_name',
      'method_name',
      'type_names',
      'mask',
      'key',
      'filter',
      'filters',
      'display_filter',
      'decoder',
    ]);
    let checked = 0;
    for (const tool of REA_STATIC_TOOLS) {
      for (const key of REA_TOOL_SCHEMAS[tool]?.keys ?? []) {
        if (skipped.has(key) || /snapshot|output|export|save|dest|overwrite|write/i.test(key)) {
          continue;
        }
        checked++;
        expect(mcp(tool, { [key]: join(other, 'x') }).decision, `${tool}.${key}`).toBe('deny');
        expect(mcp(tool, { [key]: 'out/x' }).decision, `${tool}.${key} via a link`).toBe('deny');
        expect(mcp(tool, { [key]: `${art}/../other/x` }).decision, `${tool}.${key} ..`).toBe(
          'deny',
        );
        expect(mcp(tool, { [key]: 'C:\\x\\y' }).decision, `${tool}.${key} windows`).toBe('deny');
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('refuses an argument its schema does not list, and every write key', () => {
    expect(mcp('open_binary', { path: join(art, 'x'), extra: 'a' }).decision).toBe('deny');
    expect(
      mcp('open_binary', { path: join(art, 'x'), snapshot_path: join(art, 's') }).decision,
    ).toBe('deny');
    expect(mcp('close_binary', { overwrite: true }).decision).toBe('deny');
    expect(mcp('close_binary', { snapshot_path: join(wt, 's.json') }).decision).toBe('deny');
    expect(mcp('open_binary', { path: join(art, 'x') }).decision).toBe('allow');
  });

  it('keeps a schema for every known tool and for no other', () => {
    for (const t of REA_KNOWN_TOOLS) expect(REA_TOOL_SCHEMAS[t], t).toBeDefined();
    expect(Object.keys(REA_TOOL_SCHEMAS).sort()).toEqual([...REA_KNOWN_TOOLS].sort());
  });

  it('fails write keys closed, whatever the value type', () => {
    expect(mcp('close_binary', { overwrite: 1 }).decision).toBe('deny');
    expect(mcp('close_binary', { overwrite: 'false' }).decision).toBe('deny');
    expect(mcp('close_binary', { overwrite: false }).decision).toBe('allow');
    expect(mcp('close_binary', { snapshot_path: '' }).decision).toBe('allow');
  });

  it('confines every string under a path argument, even one that does not look like a place', () => {
    expect(mcp('open_binary', { path: 'plain' }).decision).toBe('allow');
    expect(
      mcp('analyze_javascript_application', { input_path: art, source_paths: ['a', 'b/c'] })
        .decision,
    ).toBe('allow');
    expect(
      mcp('analyze_javascript_application', { input_path: art, source_paths: ['a', '../b'] })
        .decision,
    ).toBe('deny');
    expect(
      mcp('analyze_javascript_application', { input_path: art, source_paths: ['out'] }).decision,
    ).toBe('deny');
  });

  it('exempts free text only at the top level of a tool that names it', () => {
    expect(mcp('search_strings', { pattern: '/etc/passwd' }).decision).toBe('allow');
    expect(mcp('search_strings', { pattern: { pattern: '/etc/passwd' } }).decision).toBe('deny');
    expect(mcp('open_binary', { path: join(art, 'x'), provider_id: '/etc/x' }).decision).toBe(
      'deny',
    );
  });
});

describe('the sandbox of a researcher', () => {
  it('denies the analysis directory to every shell process and allows it nowhere', async () => {
    const dir = join(root, 'sb');
    const art = join(dir, 'art');
    const wt = join(dir, 'wt');
    mkdirSync(art, { recursive: true });
    mkdirSync(wt, { recursive: true });
    const cfg = studioConfigSchema.parse({
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
    });
    const state = join(dir, 'state', 'proj');
    mkdirSync(state, { recursive: true });
    const item = {
      id: 'APP-5',
      title: 't',
      type: 'research',
      role: 'researcher',
      repo: 'org/app',
      size: 'S',
      priority: 1,
      status: 'assigned',
      paths: [],
      touches: [],
      dependsOn: [],
      dod: ['x'],
      history: [],
    } as WorkItem;
    const file = writeCrewSettings(
      state,
      item,
      wt,
      cfg,
      {
        homeDir: join(dir, 'h'),
        tmpDir: join(dir, 't'),
        projectDir: join(dir, 'p'),
        toolchainPaths: [],
        rea: { artifacts: art, classes: [] },
      },
      { homedir: join(dir, 'home'), env: {} },
    );
    const fs = JSON.parse(readFileSync(file, 'utf8')).sandbox.filesystem;
    expect(fs.denyRead).toContain(art);
    expect(fs.denyWrite).toContain(art);
    expect(fs.allowRead).not.toContain(art);
    expect(fs.allowWrite).not.toContain(art);
  });
});
