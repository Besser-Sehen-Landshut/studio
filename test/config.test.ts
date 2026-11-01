import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  configWarnings,
  loadConfig,
  loadOwnerConfig,
  ownerConfigFile,
  toolchainPathProblem,
} from '../src/config.js';

const fixture = join(import.meta.dirname, 'fixtures', 'basic');
const dirs: string[] = [];

const MINIMAL = `studio: 1
primary_repo: org/app
repos: [org/app]
ci:
  provider: github
  runners: github-hosted
  runner_labels: []
  capacity: { total: 2, merge_max_busy: 1, check_twice_seconds: 30 }
merge:
  strategy: studio-queue
  contract_paths: []
roles:
  builder: { model: strongest, wip: 1 }
`;

function project(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'studio-cfg-'));
  dirs.push(dir);
  mkdirSync(join(dir, '.studio'));
  writeFileSync(join(dir, '.studio', 'studio.yaml'), yaml);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('loads basic fixture', () => {
    const cfg = loadConfig(fixture);
    expect(cfg.primaryRepo).toBe('org/app');
    expect(cfg.roles.builder?.wip).toBe(2);
    expect(cfg.ci.capacity.mergeMaxBusy).toBe(5);
    expect(cfg.ci.rhythm?.buildWindow).toBe('18:00-07:00');
    expect(cfg.notify?.ownerOnly).toBe(true);
    expect(cfg.deployCommands).toEqual(['gh workflow run deploy*']);
    expect(cfg.roles.reviewer?.skills.allowed).toEqual([]);
  });

  it('rejects unknown runners value', () => {
    const dir = project(MINIMAL.replace('github-hosted', 'moon'));
    expect(() => loadConfig(dir)).toThrow(ConfigError);
    expect(() => loadConfig(dir)).toThrow(/ci\.runners/);
  });

  it('rejects role without model', () => {
    const dir = project(MINIMAL.replace('model: strongest, ', ''));
    expect(() => loadConfig(dir)).toThrow(/roles\.builder\.model/);
  });

  it('rejects unknown role template name', () => {
    const dir = project(`${MINIMAL}  core: { model: strongest, wip: 1 }\n`);
    expect(() => loadConfig(dir)).toThrow(/roles.*core/);
  });

  it('defaults merge.method to merge and optional fields', () => {
    const cfg = loadConfig(project(MINIMAL));
    expect(cfg.merge.method).toBe('merge');
    expect(cfg.notify).toBeUndefined();
    expect(cfg.crewToken).toBeUndefined();
    expect(cfg.ownerOnly).toEqual([]);
    expect(cfg.deployCommands).toEqual([]);
    expect(cfg.crewAllowedWorkflows).toEqual([]);
    expect(cfg.crewAllowedWorkflowRefs).toEqual([]);
    expect(cfg.sandbox.networkAllow).toEqual([]);
  });

  it('reads crew_allowed_workflows', () => {
    const cfg = loadConfig(project(`${MINIMAL}crew_allowed_workflows: [ci.yml]\n`));
    expect(cfg.crewAllowedWorkflows).toEqual(['ci.yml']);
  });

  it('reads crew_allowed_workflow_refs', () => {
    const cfg = loadConfig(project(`${MINIMAL}crew_allowed_workflow_refs: [studio-ci]\n`));
    expect(cfg.crewAllowedWorkflowRefs).toEqual(['studio-ci']);
  });

  it('warns that allowed workflow refs must be protected server-side', () => {
    expect(configWarnings(loadConfig(project(MINIMAL)))).toEqual([]);
    const cfg = loadConfig(project(`${MINIMAL}crew_allowed_workflow_refs: [studio-ci]\n`));
    const w = configWarnings(cfg);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('studio-ci');
    expect(w[0]).toContain('protected server-side');
  });

  it('reads ci.shared_host and ci.github_hosted_limit; rejects bad limits', () => {
    const both = MINIMAL.replace('github-hosted', 'both');
    const extra = '  runner_labels: []\n  shared_host: true\n  github_hosted_limit: 20';
    const ok = loadConfig(project(both.replace('  runner_labels: []', extra)));
    expect(ok.ci.sharedHost).toBe(true);
    expect(ok.ci.githubHostedLimit).toBe(20);
    for (const bad of ['0', '1.5', '-2']) {
      const yaml = both.replace(
        '  runner_labels: []',
        `  runner_labels: []\n  github_hosted_limit: ${bad}`,
      );
      expect(() => loadConfig(project(yaml))).toThrow(/github_hosted_limit/);
    }
  });

  it('warns that runners: both without github_hosted_limit does not limit hosted runs', () => {
    const both = MINIMAL.replace('github-hosted', 'both');
    const w = configWarnings(loadConfig(project(both)));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/GitHub-hosted concurrency is not checked/);
    const limited = both.replace(
      '  runner_labels: []',
      '  runner_labels: []\n  github_hosted_limit: 20',
    );
    expect(configWarnings(loadConfig(project(limited)))).toEqual([]);
  });

  it('warns that merge.strategy native-queue is not supported yet', () => {
    const cfg = loadConfig(
      project(MINIMAL.replace('strategy: studio-queue', 'strategy: native-queue')),
    );
    const w = configWarnings(cfg);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('native-queue is not supported yet');
  });

  it('rejects version other than 1', () => {
    const dir = project(MINIMAL.replace('studio: 1', 'studio: 2'));
    try {
      loadConfig(dir);
      expect.unreachable();
    } catch (e) {
      const err = e as ConfigError;
      expect(err).toBeInstanceOf(ConfigError);
      expect(err.message.slice(err.path.length)).toMatch(/^: studio: .*1/);
    }
  });

  it('defaults runner_labels and contract_paths to empty lists', () => {
    const yaml = MINIMAL.replace('  runner_labels: []\n', '').replace('  contract_paths: []\n', '');
    const cfg = loadConfig(project(yaml));
    expect(cfg.ci.runnerLabels).toEqual([]);
    expect(cfg.merge.contractPaths).toEqual([]);
  });

  it('rejects unknown keys with their dotted path', () => {
    const dir = project(
      MINIMAL.replace('  provider: github\n', '  provider: github\n  runnerz: x\n'),
    );
    expect(() => loadConfig(dir)).toThrow(/ci\.runnerz/);
  });

  it('reads crew_token env name', () => {
    const cfg = loadConfig(project(`${MINIMAL}crew_token: { env: STUDIO_CREW_TOKEN }\n`));
    expect(cfg.crewToken).toEqual({ env: 'STUDIO_CREW_TOKEN' });
  });

  it('defaults allow_ambient_credentials to false and reads true', () => {
    expect(loadConfig(project(MINIMAL)).allowAmbientCredentials).toBe(false);
    const cfg = loadConfig(project(`${MINIMAL}allow_ambient_credentials: true\n`));
    expect(cfg.allowAmbientCredentials).toBe(true);
  });

  it('refuses crew_toolchain_paths in studio.yaml and points to the owner config', () => {
    const dir = project(`${MINIMAL}crew_toolchain_paths: ["/opt/tool"]\n`);
    expect(() => loadConfig(dir)).toThrow(ConfigError);
    expect(() => loadConfig(dir)).toThrow(/owner config/);
  });

  it('reports the file path on a missing file and on invalid YAML', () => {
    const empty = mkdtempSync(join(tmpdir(), 'studio-cfg-'));
    dirs.push(empty);
    try {
      loadConfig(empty);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).path).toBe(join(empty, '.studio', 'studio.yaml'));
    }
    expect(() => loadConfig(project('a: [unclosed'))).toThrow(ConfigError);
  });
});

describe('owner config', () => {
  const home = () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-owner-'));
    dirs.push(dir);
    return dir;
  };
  const write = (file: string, text: string) => {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
  };

  it('lives under XDG_CONFIG_HOME or <home>/.config; a missing file means defaults', () => {
    const h = home();
    expect(ownerConfigFile({ homedir: h, env: {} })).toBe(
      join(h, '.config', 'studio', 'config.yaml'),
    );
    expect(ownerConfigFile({ homedir: h, env: { XDG_CONFIG_HOME: '/x' } })).toBe(
      '/x/studio/config.yaml',
    );
    expect(ownerConfigFile({ homedir: h, env: { XDG_CONFIG_HOME: 'rel' } })).toBe(
      join(h, '.config', 'studio', 'config.yaml'),
    );
    expect(loadOwnerConfig({ homedir: h, env: {} })).toEqual({
      crewToolchainPaths: [],
      allowApiBilling: false,
    });
  });

  it('reads crew_toolchain_paths from the XDG location', () => {
    const h = home();
    const xdg = join(h, 'xdg');
    write(join(xdg, 'studio', 'config.yaml'), `crew_toolchain_paths: ["${h}/.local/bin"]\n`);
    expect(loadOwnerConfig({ homedir: h, env: { XDG_CONFIG_HOME: xdg } })).toEqual({
      crewToolchainPaths: [`${h}/.local/bin`],
      allowApiBilling: false,
    });
  });

  it('rejects unknown keys and lexically unsafe toolchain paths', () => {
    const h = home();
    const file = join(h, '.config', 'studio', 'config.yaml');
    write(file, 'other: 1\n');
    expect(() => loadOwnerConfig({ homedir: h, env: {} })).toThrow(ConfigError);
    for (const bad of ['relative/bin', '/', h, `${h}/.config`, `${h}/Library`, `${h}/.ssh/x`]) {
      write(file, `crew_toolchain_paths: ["${bad}"]\n`);
      expect(() => loadOwnerConfig({ homedir: h, env: {} })).toThrow(/crew_toolchain_paths/);
    }
  });
});

describe('toolchainPathProblem', () => {
  it('compares case-insensitively on darwin only', () => {
    expect(toolchainPathProblem('/h/.SSH', '/h', [], 'darwin')).toMatch(/credential/);
    expect(toolchainPathProblem('/H', '/h', [], 'darwin')).toMatch(/home/);
    expect(toolchainPathProblem('/h/.CLAUDE/x', '/h', [], 'darwin')).toMatch(/credential/);
    expect(toolchainPathProblem('/h/.SSH', '/h', [], 'linux')).toBeUndefined();
    expect(toolchainPathProblem('/h/.claude', '/h', [], 'linux')).toMatch(/credential/);
    expect(toolchainPathProblem('/h/.local/bin', '/h', [], 'darwin')).toBeUndefined();
  });
});
