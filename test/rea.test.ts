import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
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
import { ownerConfigSchema, studioConfigSchema } from '../src/config.js';
import { launchCrew, REA_SERVER_BIN, writeCrewSettings } from '../src/crew.js';
import {
  DEFAULT_SECRET_GLOBS,
  evaluateGuard,
  type GuardContext,
  isPlaceKey,
  isWriteKey,
} from '../src/guard.js';
import { ownerStateRootFor, stateRootFor } from '../src/paths.js';
import { type Ports, realPorts } from '../src/ports.js';
import { privacyHits, privacyHitsInAdded, privacyLine } from '../src/privacy.js';
import {
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
import {
  installRea,
  itemReaClasses,
  prepareReaRun,
  readReaAllow,
  removeReaRun,
  updateReaAllow,
  verifyReaInstall,
  writeReaSpec,
} from '../src/rea-install.js';
import { REA_TOOL_SCHEMAS } from '../src/rea-schemas.js';
import { reaState } from '../src/secret-command.js';
import { fakeReaInstall, REA_TEST_INTEGRITY } from './rea-fixture.js';

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

  it('keeps the classes the owner opened in the state root, per item; a typo or a bad file opens nothing', () => {
    const st = join(root, 'allow-state');
    expect(itemReaClasses(st, 'APP-5')).toEqual([]);
    expect(updateReaAllow(st, 'APP-5', { add: ['observe', 'debug'] })).toEqual([
      'debug',
      'observe',
    ]);
    expect(itemReaClasses(st, 'APP-5')).toEqual(['debug', 'observe']);
    expect(itemReaClasses(st, 'APP-6')).toEqual([]);
    expect(updateReaAllow(st, 'APP-5', { remove: ['debug'] })).toEqual(['observe']);
    expect(updateReaAllow(st, 'APP-5', { remove: 'all' })).toEqual([]);
    expect(readReaAllow(st)).toEqual({});
    writeFileSync(join(st, 'rea-allow.json'), '{"APP-5": ["dbug", "debug"], "x": ["debug"]}');
    expect(readReaAllow(st)).toEqual({ 'APP-5': ['debug'] });
    writeFileSync(join(st, 'rea-allow.json'), 'not json');
    expect(itemReaClasses(st, 'APP-5')).toEqual([]);
  });

  it('starts the server through the wrapper with Node by absolute path, never npx', () => {
    const s = reaMcpServer({
      node: '/opt/node/bin/node',
      wrapper: REA_SERVER_BIN,
      spec: '/s/x.json',
    });
    expect(s.command).toBe('/opt/node/bin/node');
    expect(s.args).toEqual([REA_SERVER_BIN, '/s/x.json']);
    expect(REA_SERVER_BIN).toMatch(/^\/.*\/bin\/studio-rea-server\.mjs$/);
    expect(JSON.stringify(s)).not.toContain('npx');
    expect(s.env).toEqual({ NODE_OPTIONS: '', NODE_PATH: '' });
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

  it('allows a static tool on an absolute path in the analysis directory, never the checkout', () => {
    expect(mcp('open_binary', { path: join(art, 'target.bin') }).decision).toBe('allow');
    expect(mcp('search_strings', { pattern: '/api/v1' }).decision).toBe('allow');
    expect(
      mcp('analyze_javascript_application', {
        input_path: art,
        source_paths: [join(art, 'main.js')],
      }).decision,
    ).toBe('allow');
    expect(mcp('open_binary', { path: join(wt, 'x.bin') }).decision).toBe('deny');
    expect(mcp('open_binary', { path: join(wt, 'link-to-art', 'target.bin') }).decision).toBe(
      'deny',
    );
    expect(
      mcp('analyze_javascript_application', { input_path: art, source_paths: ['main.js'] })
        .decision,
    ).toBe('deny');
  });

  it('refuses a symlinked folder inside the analysis directory that points outside it', () => {
    // The crew cannot write the analysis directory (sandbox denyWrite), so a link there is the
    // owner's and stays as checked; one that leads out is refused on its real path.
    mkdirSync(join(art, 'pkg'), { recursive: true });
    symlinkSync(other, join(art, 'pkg', 'lib'));
    writeFileSync(join(other, 'secret.db'), 'x');
    expect(mcp('open_binary', { path: join(art, 'pkg', 'lib', 'secret.db') }).decision).toBe(
      'deny',
    );
    expect(
      mcp('inspect_sqlite_database', { path: join(art, 'pkg', 'lib', 'secret.db') }).decision,
    ).toBe('deny');
  });

  it('refuses the debugger context of a recorded crash unless the debug class is open', () => {
    const p = join(art, 'crash.ips');
    expect(mcp('inspect_recorded_crash', { path: p }).decision).toBe('allow');
    expect(
      mcp('inspect_recorded_crash', { path: p, include_debugger_context: false }).decision,
    ).toBe('allow');
    expect(
      mcp('inspect_recorded_crash', { path: p, include_debugger_context: true }).decision,
    ).toBe('deny');
    const open = { ...ctx, ...reaGuard(art, ['debug']) };
    expect(
      mcp('inspect_recorded_crash', { path: p, include_debugger_context: true }, open).decision,
    ).toBe('allow');
  });

  it('refuses every git push of a research item, and only of one', () => {
    const research = { ...ctx, noPush: true };
    expect(bash('git push origin HEAD:refs/heads/studio/APP-5', research).decision).toBe('deny');
    expect(bash('git -C . push origin studio/APP-5', research).decision).toBe('deny');
    expect(bash('git push origin HEAD:refs/heads/studio/APP-5').decision).toBe('allow');
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
  it('fails a line too long to check, instead of reading only its start', () => {
    const long = `${'a'.repeat(4000)} mail a@real-domain.org`;
    expect(privacyHits(`ok\n${long}`, 'r')).toEqual([
      { kind: 'line too long to check', line: 2, file: 'r' },
    ]);
    expect(privacyHits('a'.repeat(4000), 'r')).toEqual([]);
  });

  it('shows the kind and the line, never the text', () => {
    const line = privacyLine(privacyHits('x\nmail anna.k@mail-provider.de', 'report'));
    expect(line).toContain('email address (report:2)');
    expect(line).not.toContain('anna');
  });
  it('checks the lines a pull request adds, with their own line numbers, and refuses odd files', () => {
    expect(
      privacyHitsInAdded([{ path: 'docs/research/a.md', lines: [{ line: 3, text: 'structure' }] }]),
    ).toEqual([]);
    const hits = privacyHitsInAdded([
      {
        path: 'docs/research/a.md',
        lines: [
          { line: 7, text: 'fine' },
          { line: 9, text: 'mail a@real-domain.org' },
        ],
      },
      { path: 'docs/research/b.bin', odd: 'binary', lines: [] },
      { path: 'docs/research/ln', odd: 'link', lines: [] },
      { path: 'x.md', odd: 'unreadable', lines: [] },
    ]);
    expect(hits).toEqual(
      expect.arrayContaining([
        { kind: 'email address', line: 9, file: 'docs/research/a.md' },
        { kind: 'file that is not text', line: 0, file: 'docs/research/b.bin' },
        { kind: 'link in the pull request', line: 0, file: 'docs/research/ln' },
        { kind: 'file whose lines could not be read', line: 0, file: 'x.md' },
      ]),
    );
    expect(privacyLine(hits)).not.toContain('real-domain');
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
    expect(docs).toContain('opened for this item: debug');
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

  function setup(
    opts: { roots?: string[]; artifacts?: string; skill?: boolean; installed?: boolean } = {},
  ) {
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
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', CREW_TOKEN: 'crew-token-value' };
    const ownerRoot = ownerStateRootFor({ homedir: home, env });
    const entry =
      opts.installed === false ? undefined : fakeReaInstall(join(ownerRoot, 'rea', '6.7.0'));
    const claude = join(home, '.claude');
    const skills = ['studio-crew', ...(opts.skill === false ? [] : ['reverse-engineer-anything'])];
    for (const s of skills) {
      mkdirSync(join(claude, 'skills', s), { recursive: true });
      writeFileSync(join(claude, 'skills', s, 'SKILL.md'), '---\nname: x\n---\n');
    }
    const launcher = { homedir: home, env };
    const config = {
      ...base,
      crewToken: { env: 'CREW_TOKEN' },
      research: { artifacts: opts.artifacts ?? artifacts },
    };
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
      entry,
    };
  }

  it('gives the researcher one pinned server, the allowlist, a read-only analysis directory', async () => {
    const f = setup();
    await launchCrew(f.project, research, f.config, f.ports, f.launcher);
    const mcp = JSON.parse(readFileSync(join(f.state, 'settings', 'APP-5.mcp.json'), 'utf8'));
    expect(Object.keys(mcp.mcpServers)).toEqual(['rea']);
    const spec = join(f.state, 'settings', 'APP-5.rea.json');
    expect(mcp.mcpServers.rea).toEqual({
      type: 'stdio',
      command: process.execPath,
      args: [REA_SERVER_BIN, spec],
      env: { NODE_OPTIONS: '', NODE_PATH: '' },
    });
    // The spec names the integrity-checked install, the run's own folder and the engine variables
    // only: nothing of the crew's environment, no token.
    const run = join(f.state, 'rea', 'APP-5');
    const specJson = JSON.parse(readFileSync(spec, 'utf8'));
    expect(specJson.entry).toBe(f.entry);
    expect(specJson.env).toEqual({ JAVA_HOME: '/opt/jdk' });
    expect(specJson.run).toEqual({
      home: join(run, 'home'),
      tmp: join(run, 'tmp'),
      cache: join(run, 'cache'),
      config: join(run, 'config'),
      data: join(run, 'data'),
      state: join(run, 'state'),
      cwd: join(run, 'cwd'),
    });
    expect(readFileSync(spec, 'utf8')).not.toContain('crew-token-value');
    const s = JSON.parse(readFileSync(join(f.state, 'settings', 'APP-5.json'), 'utf8'));
    expect(s.sandbox.filesystem.denyRead).toContain(run);
    expect(s.sandbox.filesystem.denyWrite).toContain(run);
    expect(s.sandbox.filesystem.allowWrite).not.toContain(run);
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
    expect(ctx.secretGlobs).toEqual(expect.arrayContaining([run, `${run}/**`]));
    expect(ctx.noPush).toBe(true);
    // A research item pushes nothing: no token that could push reaches it.
    expect(f.started[0]?.env.GH_TOKEN).toBeUndefined();
    expect(JSON.stringify(f.started[0]?.env)).not.toContain('crew-token-value');
    const brief = readFileSync(join(f.state, 'briefs', 'APP-5.md'), 'utf8');
    expect(brief).toContain('## Reverse engineering (REA)');
    expect(brief).toContain('reverse-engineer-anything');
  });

  it('adds the classes the owner opened, and never one a board note names', async () => {
    const noted = setup();
    await launchCrew(
      noted.project,
      { ...research, notes: ['rea-allow: observe, debug, device'] },
      noted.config,
      noted.ports,
      noted.launcher,
    );
    const plain = JSON.parse(readFileSync(join(noted.state, 'guard', 'APP-5.json'), 'utf8'));
    expect(plain.mcpAllow).not.toContain('mcp__rea__capture_web_screenshot');
    expect(plain.reaClasses).toEqual([]);

    // `studio research allow` writes into the bound state root; a first launch binds it here.
    const f = setup();
    await launchCrew(f.project, research, f.config, f.ports, f.launcher);
    updateReaAllow(f.state, 'APP-5', { add: ['observe'] });
    await launchCrew(f.project, research, f.config, f.ports, f.launcher);
    const ctx = JSON.parse(readFileSync(join(f.state, 'guard', 'APP-5.json'), 'utf8'));
    expect(ctx.mcpAllow).toContain('mcp__rea__capture_web_screenshot');
    expect(ctx.mcpAllow).not.toContain('mcp__rea__start_frida_session');
    expect(ctx.reaClasses).toEqual(['observe']);
    expect(ctx.blockedCommands).toContain('adb');
    expect(ctx.blockedCommands).not.toContain('tcpdump');
  });

  it('gives a builder its push token and no REA folder', async () => {
    const f = setup();
    const builder = { ...research, id: 'APP-7', type: 'chore' as const, role: 'builder' as const };
    await launchCrew(f.project, builder, f.config, f.ports, f.launcher);
    expect(f.started[0]?.env.GH_TOKEN).toBe('crew-token-value');
    const ctx = JSON.parse(readFileSync(join(f.state, 'guard', 'APP-7.json'), 'utf8'));
    expect(ctx.noPush).toBeUndefined();
    expect(() => readFileSync(join(f.state, 'settings', 'APP-7.rea.json'))).toThrow();
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
    ).rejects.toThrow(/REA skill is not installed.*node .*rea\.mjs setup/);
    expect(noSkill.started).toHaveLength(0);

    const notInstalled = setup({ installed: false });
    await expect(
      launchCrew(
        notInstalled.project,
        research,
        notInstalled.config,
        notInstalled.ports,
        notInstalled.launcher,
      ),
    ).rejects.toThrow(/not installed; run studio research install/);
    expect(notInstalled.started).toHaveLength(0);
  });
});

describe('studio doctor on REA', () => {
  it('takes no REA version from studio.yaml: the repository cannot pin the code the owner runs', () => {
    const cfg = {
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
    };
    expect(studioConfigSchema.safeParse({ ...cfg, research: { artifacts: '/a' } }).success).toBe(
      true,
    );
    expect(
      studioConfigSchema.safeParse({ ...cfg, research: { artifacts: '/a', reaVersion: '6.7.0' } })
        .success,
    ).toBe(false);
  });

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
      research: { artifacts: join(root, 'does-not-exist') },
    });
    const owner = ownerConfigSchema.parse({ researchRoots: [root], reaVersion: '6.8.0' });
    const s = reaState(cfg, owner, undefined, join(root, 'no-owner-state'));
    expect(s?.server).toBe('rea-agents@6.8.0');
    expect(s?.pinnedBy).toBe('owner config');
    expect(s?.installed).toMatch(/^no: not installed; run studio research install/);
    expect(reaState(cfg, undefined, undefined)?.pinnedBy).toBe('Studio default');
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

  it('refuses relative paths, and resolves absolute ones through links', () => {
    expect(mcp('open_binary', { path: join(art, 'sub', 'x') }).decision).toBe('allow');
    // Relative: the guard and the server would resolve it against different directories.
    expect(mcp('open_binary', { path: 'sub/x' }).decision).toBe('deny');
    expect(mcp('open_binary', { path: 'x.bin' }).decision).toBe('deny');
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
        if (skipped.has(key) || isWriteKey(key)) {
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

  it('fails write keys closed, whatever the value type; only a limit takes a number', () => {
    expect(mcp('close_binary', { overwrite: 1 }).decision).toBe('deny');
    expect(mcp('close_binary', { overwrite: 0 }).decision).toBe('deny');
    expect(mcp('close_binary', { snapshot_path: 7 }).decision).toBe('deny');
    expect(mcp('close_binary', { overwrite: 'false' }).decision).toBe('deny');
    expect(mcp('close_binary', { overwrite: true }).decision).toBe('deny');
    expect(mcp('close_binary', { overwrite: false }).decision).toBe('allow');
    expect(mcp('close_binary', { snapshot_path: '' }).decision).toBe('allow');
  });

  it('judges write keys by the words of their name: export names, levels and sizes are no writes', () => {
    for (const k of [
      'snapshot_path',
      'overwrite',
      'output_directory',
      'output',
      'export_path',
      'save',
      'dest',
      'destination',
      'writeTo',
    ]) {
      expect(isWriteKey(k), k).toBe(true);
    }
    for (const k of [
      'left_export_name',
      'right_export_name',
      'rewrite_level',
      'destination_scope',
      'max_output_bytes',
      'max_output_files',
      'output_bytes',
    ]) {
      expect(isWriteKey(k), k).toBe(false);
    }
    const f = join(art, 'a.js');
    expect(
      mcp('compare_javascript_export_shapes', {
        left_module_path: f,
        right_module_path: f,
        left_export_name: 'default',
        right_export_name: 'run',
      }).decision,
    ).toBe('allow');
    // A limit takes its number, even where the tool writes (the export class opened).
    const exp = { ...ctx, ...reaGuard(art, ['export']) };
    const fw = (input: Record<string, unknown>) =>
      evaluateGuard({ toolName: reaToolName('extract_firmware'), toolInput: input }, exp).decision;
    expect(fw({ path: join(art, 'fw.bin'), max_output_files: 10, max_output_bytes: 1000 })).toBe(
      'allow',
    );
  });

  it('confines every string under a path argument, even one that does not look like a place', () => {
    expect(mcp('open_binary', { path: 'plain' }).decision).toBe('deny');
    expect(
      mcp('analyze_javascript_application', {
        input_path: art,
        source_paths: [join(art, 'a'), join(art, 'b', 'c')],
      }).decision,
    ).toBe('allow');
    expect(
      mcp('analyze_javascript_application', { input_path: art, source_paths: ['a'] }).decision,
    ).toBe('deny');
    expect(
      mcp('analyze_javascript_application', { input_path: art, source_paths: ['a', '../b'] })
        .decision,
    ).toBe('deny');
    expect(
      mcp('analyze_javascript_application', { input_path: art, source_paths: ['out'] }).decision,
    ).toBe('deny');
  });

  it('confines a nested argument named like a place even when its value is a bare name', () => {
    // rea-agents 6.7.0 resolves `local_path` with path.resolve, against its working directory; a
    // bare name must not reach it, and nor may one in a reference or manifest entry.
    const subject = (local_path: string) => ({
      subject: { name: 'app', local_path, format: 'apk' },
    });
    expect(
      mcp('compare_artifacts', {
        left: subject(join(art, 'a.apk')),
        right: subject(join(art, 'b.apk')),
      }).decision,
    ).toBe('allow');
    for (const bad of ['secret.db', join(other, 'x.apk'), join(wt, 'x.apk')]) {
      expect(
        mcp('compare_artifacts', { left: subject(bad), right: subject(join(art, 'b.apk')) })
          .decision,
        bad,
      ).toBe('deny');
    }
    expect(
      mcp('compare_source_to_bundle', {
        reference: { entries: [{ path: 'src/index.ts', kind: 'file' }] },
      }).decision,
    ).toBe('deny');
    expect(isPlaceKey('local_path')).toBe(true);
    expect(isPlaceKey('manifestPath')).toBe(true);
    expect(isPlaceKey('format')).toBe(false);
    expect(isPlaceKey('evidence_id')).toBe(false);
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
    const runDir = join(state, 'rea', 'APP-5');
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
        rea: { artifacts: art, classes: [], runDir },
      },
      { homedir: join(dir, 'home'), env: {} },
    );
    const fs = JSON.parse(readFileSync(file, 'utf8')).sandbox.filesystem;
    for (const p of [art, runDir]) {
      expect(fs.denyRead).toContain(p);
      expect(fs.denyWrite).toContain(p);
      expect(fs.allowRead).not.toContain(p);
      expect(fs.allowWrite).not.toContain(p);
    }
    // The guard keeps the crew's file tools out of the server's folder too.
    const ctx: GuardContext = JSON.parse(readFileSync(join(state, 'guard', 'APP-5.json'), 'utf8'));
    expect(
      evaluateGuard(
        { toolName: 'Read', toolInput: { file_path: join(runDir, 'tmp', 'app.apk') } },
        ctx,
      ).decision,
    ).toBe('deny');
  });
});

describe('the REA install', () => {
  const fakeNpm = (o: {
    registry?: string;
    locked?: string;
    resolved?: string;
    code?: number;
    entry?: string;
    frida?: boolean;
  }) => {
    const calls: { args: string[]; env: Record<string, string>; cwd: string }[] = [];
    const npm = {
      async run(args: string[], env: Record<string, string>, cwd: string) {
        calls.push({ args, env, cwd });
        if (args[0] === 'view') {
          return { code: 0, stdout: JSON.stringify(o.registry ?? REA_TEST_INTEGRITY), stderr: '' };
        }
        if (o.code !== undefined) return { code: o.code, stdout: '', stderr: '' };
        fakeReaInstall(cwd, {
          integrity: o.locked ?? REA_TEST_INTEGRITY,
          ...(o.entry === undefined ? {} : { entryScript: o.entry }),
        });
        if (o.frida === true) mkdirSync(join(cwd, 'node_modules', 'frida'), { recursive: true });
        if (o.resolved !== undefined) {
          const lock = JSON.parse(readFileSync(join(cwd, 'package-lock.json'), 'utf8'));
          lock.packages['node_modules/rea-agents'].resolved = o.resolved;
          writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify(lock));
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    return { npm, calls };
  };
  const now = new Date('2026-11-05T10:00:00Z');

  it('installs the pinned version into the owner state with npm config and tokens kept out', async () => {
    const owner = join(root, 'inst-ok');
    const { npm, calls } = fakeNpm({});
    const got = await installRea({
      ownerRoot: owner,
      version: '6.7.0',
      npm,
      path: '/usr/bin',
      now,
    });
    expect(got).toEqual({ dir: join(owner, 'rea', '6.7.0'), integrity: REA_TEST_INTEGRITY });
    expect(calls.map((c) => c.args[0])).toEqual(['view', 'install']);
    for (const c of calls) {
      expect(c.env.npm_config_userconfig).toBe('/dev/null');
      expect(c.env.npm_config_globalconfig).toBe('/dev/null');
      expect(Object.keys(c.env).some((k) => /TOKEN|AUTH/i.test(k))).toBe(false);
      expect(c.cwd.startsWith(join(owner, 'rea'))).toBe(true);
    }
    expect(calls[0]?.args).toEqual(['view', 'rea-agents@6.7.0', 'dist.integrity', '--json']);
    // No install script runs and no optional (native) dependency comes along.
    expect(calls[1]?.args).toEqual(expect.arrayContaining(['--ignore-scripts', '--omit=optional']));
    const record = JSON.parse(readFileSync(join(got.dir, 'studio-rea.json'), 'utf8'));
    expect(record).toMatchObject({ version: '6.7.0', integrity: REA_TEST_INTEGRITY });
    expect(verifyReaInstall(owner, '6.7.0').entry).toBe(
      join(got.dir, 'node_modules', 'rea-agents', 'scripts', 'rea.mjs'),
    );
  });

  it('refuses a tarball whose integrity is not the registry’s, or from another place, and keeps the old install', async () => {
    const owner = join(root, 'inst-bad');
    await installRea({ ownerRoot: owner, version: '6.7.0', npm: fakeNpm({}).npm, path: '', now });
    const other = `sha512-${'B'.repeat(86)}==`;
    await expect(
      installRea({
        ownerRoot: owner,
        version: '6.7.0',
        npm: fakeNpm({ locked: other }).npm,
        path: '',
        now,
      }),
    ).rejects.toThrow(/integrity is not the one the registry reported/);
    await expect(
      installRea({
        ownerRoot: owner,
        version: '6.7.0',
        npm: fakeNpm({ resolved: 'https://evil.example/rea-agents-6.7.0.tgz' }).npm,
        path: '',
        now,
      }),
    ).rejects.toThrow(/other than the npm registry/);
    await expect(
      installRea({
        ownerRoot: owner,
        version: '6.7.0',
        npm: fakeNpm({ code: 1 }).npm,
        path: '',
        now,
      }),
    ).rejects.toThrow(/npm install failed/);
    expect(verifyReaInstall(owner, '6.7.0').integrity).toBe(REA_TEST_INTEGRITY);
    await expect(
      installRea({ ownerRoot: owner, version: '^6.7.0', npm: fakeNpm({}).npm, path: '', now }),
    ).rejects.toThrow(/not exact/);
  });

  it('keeps the earlier install until the new one is verified, and restores it otherwise', async () => {
    const owner = join(root, 'inst-swap');
    const dir = join(owner, 'rea', '6.7.0');
    const entry = join(dir, 'node_modules', 'rea-agents', 'scripts', 'rea.mjs');
    await installRea({
      ownerRoot: owner,
      version: '6.7.0',
      npm: fakeNpm({ entry: '// first\n' }).npm,
      path: '',
      now,
    });
    // Lockfile and integrity fine, but an optional native part came along: verification fails.
    await expect(
      installRea({
        ownerRoot: owner,
        version: '6.7.0',
        npm: fakeNpm({ entry: '// second\n', frida: true }).npm,
        path: '',
        now,
      }),
    ).rejects.toThrow(/optional native dependency frida/);
    expect(readFileSync(entry, 'utf8')).toBe('// first\n');
    expect(verifyReaInstall(owner, '6.7.0').entry).toBe(entry);
    expect(() => lstatSync(`${dir}.previous`)).toThrow();
    expect(() => lstatSync(`${dir}.staging`)).toThrow();
    // A good one replaces it, and nothing of the earlier one is left beside it.
    await installRea({
      ownerRoot: owner,
      version: '6.7.0',
      npm: fakeNpm({ entry: '// third\n' }).npm,
      path: '',
      now,
    });
    expect(readFileSync(entry, 'utf8')).toBe('// third\n');
    expect(() => lstatSync(`${dir}.previous`)).toThrow();
  });

  it('refuses at launch an install that is missing, altered, linked or writable by others', () => {
    const owner = join(root, 'inst-verify');
    const dir = join(owner, 'rea', '6.7.0');
    expect(() => verifyReaInstall(owner, '6.7.0')).toThrow(/not installed/);
    fakeReaInstall(dir, { recordIntegrity: `sha512-${'C'.repeat(86)}==` });
    expect(() => verifyReaInstall(owner, '6.7.0')).toThrow(/does not match the install record/);
    fakeReaInstall(dir);
    expect(() => verifyReaInstall(owner, '6.8.0')).toThrow(/not installed/);
    const entry = join(dir, 'node_modules', 'rea-agents', 'scripts', 'rea.mjs');
    chmodSync(entry, 0o666);
    expect(() => verifyReaInstall(owner, '6.7.0')).toThrow(/writable by group or others/);
    chmodSync(entry, 0o644);
    rmSync(entry);
    symlinkSync(join(root, 'elsewhere.mjs'), entry);
    expect(() => verifyReaInstall(owner, '6.7.0')).toThrow(/symbolic link/);
    rmSync(entry);
    writeFileSync(entry, '');
    expect(() => verifyReaInstall(owner, '6.7.0', 12345)).toThrow(/belongs to another user/);
  });
});

describe('the REA server wrapper', () => {
  it('starts the installed server in a neutral folder with a clean environment, whatever the clone holds', () => {
    const dir = join(root, 'wrap');
    const state = join(dir, 'state');
    const clone = join(dir, 'clone');
    // What a crew could plant in its clone: a fake package and an npmrc. None of it may count.
    mkdirSync(join(clone, 'node_modules', 'rea-agents'), { recursive: true });
    writeFileSync(join(clone, '.npmrc'), 'registry=https://evil.example/\n');
    writeFileSync(join(clone, 'node_modules', 'rea-agents', 'index.js'), 'throw 1;\n');
    const entry = fakeReaInstall(join(dir, 'owner', 'rea', '6.7.0'), {
      entryScript:
        'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env }));\n',
    });
    const run = prepareReaRun(state, 'APP-5');
    const spec = writeReaSpec(state, 'APP-5', {
      entry,
      run,
      path: process.env.PATH ?? '/usr/bin:/bin',
      env: { JAVA_HOME: '/opt/jdk' },
    });
    const out = execFileSync(process.execPath, [REA_SERVER_BIN, spec], {
      cwd: clone,
      env: {
        PATH: process.env.PATH,
        GH_TOKEN: 'gh-secret',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret',
        ANTHROPIC_API_KEY: 'api-secret',
        HOME: join(dir, 'crew-home'),
        TMPDIR: join(dir, 'crew-tmp'),
        npm_config_registry: 'https://evil.example/',
      },
      encoding: 'utf8',
    });
    const got = JSON.parse(out) as { argv: string[]; cwd: string; env: Record<string, string> };
    expect(got.argv).toEqual(['mcp']);
    expect(realpathSync(got.cwd)).toBe(realpathSync(run.cwd));
    expect(got.env.HOME).toBe(run.home);
    expect(got.env.TMPDIR).toBe(run.tmp);
    expect(got.env.XDG_CACHE_HOME).toBe(run.cache);
    expect(got.env.XDG_CONFIG_HOME).toBe(run.config);
    expect(got.env.XDG_DATA_HOME).toBe(run.data);
    expect(got.env.XDG_STATE_HOME).toBe(run.state);
    expect(got.env.npm_config_userconfig).toBe('/dev/null');
    expect(got.env.JAVA_HOME).toBe('/opt/jdk');
    expect(got.env.npm_config_registry).toBeUndefined();
    expect(out).not.toMatch(/gh-secret|oauth-secret|api-secret|crew-home|crew-tmp/);
  });

  it('refuses a spec that is not the owner’s plain file, or that names a variable REA does not read', () => {
    const dir = join(root, 'wrap-bad');
    const state = join(dir, 'state');
    const entry = fakeReaInstall(join(dir, 'owner', 'rea', '6.7.0'));
    const run = prepareReaRun(state, 'APP-5');
    const spec = writeReaSpec(state, 'APP-5', { entry, run, path: '/usr/bin', env: {} });
    const runWrapper = (file: string) =>
      spawnSync(process.execPath, [REA_SERVER_BIN, file], { encoding: 'utf8', env: {} });
    chmodSync(spec, 0o666);
    expect(runWrapper(spec).status).toBe(2);
    chmodSync(spec, 0o600);
    const link = join(dir, 'link.json');
    symlinkSync(spec, link);
    expect(runWrapper(link).stderr).toMatch(/symbolic link/);
    const raw = JSON.parse(readFileSync(spec, 'utf8'));
    writeFileSync(spec, JSON.stringify({ ...raw, env: { GH_TOKEN: 'x' } }));
    expect(runWrapper(spec).stderr).toMatch(/env GH_TOKEN is refused/);
    expect(runWrapper('relative.json').status).toBe(2);
  });

  it('removes the per-run folder with what REA copied into it', () => {
    const state = join(root, 'run-clean');
    const run = prepareReaRun(state, 'APP-5');
    writeFileSync(join(run.tmp, 'app.apk'), 'x');
    expect(prepareReaRun(state, 'APP-5').tmp).toBe(run.tmp);
    expect(() => readFileSync(join(run.tmp, 'app.apk'))).toThrow();
    writeFileSync(join(run.tmp, 'app.apk'), 'x');
    removeReaRun(state, 'APP-5');
    expect(() => readFileSync(join(run.tmp, 'app.apk'))).toThrow();
  });
});
