import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

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
    expect(cfg.sandbox.networkAllow).toEqual([]);
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
