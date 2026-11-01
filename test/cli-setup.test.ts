import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import type { Gh, Ports } from '../src/ports.js';

const root = mkdtempSync(join(tmpdir(), 'studio-setup-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const YAML = `# top comment
studio: 1
primary_repo: org/app # the main repo
repos: [org/app]
ci:
  # provider comment
  provider: github
  runners: github-hosted # was hosted
  runner_labels: []
  runner_name_pattern: '^old-'
  capacity: { total: 8, merge_max_busy: 5, check_twice_seconds: 30 }
merge:
  strategy: studio-queue
  contract_paths: []
roles:
  builder: { model: sonnet, wip: 2 } # builders
owner_only: []
deploy_commands: []
`;

const POOL = ['runner-1', 'runner-2', 'runner-3']
  .map((n) => `${n}\tonline\tfalse\tself-hosted,linux`)
  .join('\n');

// biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
const GROUP = 'ci-${{ github.head_ref || github.ref_name }}';
const WORKFLOW = (runsOn: string, group = GROUP) => `name: ci
on: [push, pull_request]
concurrency:
  group: ${group}
  cancel-in-progress: true
jobs:
  build:
    runs-on: ${runsOn}
    steps: []
`;

type Opts = {
  runners?: string;
  visibility?: string | Error;
  yaml?: string | null;
  workflows?: Record<string, string>;
};

let n = 0;
function fixture(o: Opts = {}) {
  const dir = join(root, `p${n++}`);
  mkdirSync(join(dir, '.studio'), { recursive: true });
  if (o.yaml !== null) writeFileSync(join(dir, '.studio', 'studio.yaml'), o.yaml ?? YAML);
  if (o.workflows) {
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    for (const [f, t] of Object.entries(o.workflows)) {
      writeFileSync(join(dir, '.github', 'workflows', f), t);
    }
  }
  const calls: string[] = [];
  const gh: Gh = {
    async api(path) {
      calls.push(path);
      if (path.endsWith('/actions/runners')) {
        if (path.startsWith('/orgs/')) return o.runners ?? POOL;
        return '';
      }
      if (path.startsWith('/repos/')) {
        const v = o.visibility ?? 'private';
        if (v instanceof Error) throw v;
        return `${v}\n`;
      }
      throw new Error(`unscripted ${path}`);
    },
    async run() {
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  const ports = {
    gh,
    host: { loadAvg1: () => 0, cpuCount: () => 4 },
  } as unknown as Ports;
  return { dir, calls, ports, file: join(dir, '.studio', 'studio.yaml') };
}

async function cli(fx: ReturnType<typeof fixture>, ...argv: string[]) {
  let out = '';
  let err = '';
  const code = await runCli(['--project', fx.dir, ...argv], {
    ports: fx.ports,
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
    env: {},
    homedir: fx.dir,
    cwd: fx.dir,
  });
  return { code, out, err };
}

describe('studio setup ci', () => {
  it('--json prints the detection, the proposal and the lint result', async () => {
    const fx = fixture();
    const r = await cli(fx, 'setup', 'ci', '--json');
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(Object.keys(j).sort()).toEqual([
      'detection',
      'errors',
      'proposal',
      'warnings',
      'written',
    ]);
    expect(j.detection.source).toBe('org');
    expect(j.proposal.ci).toMatchObject({
      runners: 'self-hosted',
      runner_labels: ['linux', 'self-hosted'],
      runner_name_pattern: '^runner-[0-9]',
      capacity: { total: 3 },
    });
    expect(j.proposal.notes).toEqual(expect.any(Array));
    expect(j.errors).toEqual([]);
    expect(j.written).toBe(false);
    expect(readFileSync(fx.file, 'utf8')).toBe(YAML);
  });

  it('text mode prints sections and strips control characters from untrusted text', async () => {
    const fx = fixture({
      runners:
        'runner-\u001b[31m1\tonline\tfalse\tself-hosted\nrunner-2\tonline\tfalse\tself-hosted',
      workflows: { 'ci.yml': WORKFLOW('[self-hosted, nope‮]') },
    });
    const r = await cli(fx, 'setup', 'ci');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Detection/);
    expect(r.out).toMatch(/Proposal/);
    expect(r.out).toMatch(/Errors/);
    expect(r.out).toContain('matches no online runner');
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none are printed
    expect(r.out).not.toMatch(/[\u001b‮]/);
  });

  it('fails clearly without a readable studio.yaml or a valid primary_repo, without calling gh', async () => {
    const missing = fixture({ yaml: null });
    const a = await cli(missing, 'setup', 'ci');
    expect(a.code).toBe(1);
    expect(a.err).toMatch(/studio\.yaml/);
    for (const bad of ['../x', 'org/app/extra', 'org', 'org/..', 'a b/c']) {
      const fx = fixture({ yaml: YAML.replace('primary_repo: org/app', `primary_repo: "${bad}"`) });
      const r = await cli(fx, 'setup', 'ci');
      expect(r.code, bad).toBe(1);
      expect(r.err, bad).toMatch(/primary_repo/);
      expect(fx.calls, bad).toEqual([]);
    }
  });

  it('an unknown or missing setup subcommand is a usage error', async () => {
    const fx = fixture();
    for (const argv of [['setup', 'nope'], ['setup']]) {
      const r = await cli(fx, ...argv);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/Usage/);
    }
    expect(fx.calls).toEqual([]);
  });

  it('--write refuses on a proposal error and leaves the file byte-identical', async () => {
    const fx = fixture({ visibility: 'public' });
    const r = await cli(fx, 'setup', 'ci', '--write', '--json');
    expect(r.code).toBe(1);
    const j = JSON.parse(r.out);
    expect(j.errors.join('\n')).toMatch(/public repository/);
    expect(j.written).toBe(false);
    expect(readFileSync(fx.file, 'utf8')).toBe(YAML);
  });

  it('--write refuses on a lint error and leaves the file byte-identical', async () => {
    const fx = fixture({ workflows: { 'ci.yml': WORKFLOW('[self-hosted, missing-label]') } });
    const r = await cli(fx, 'setup', 'ci', '--write');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/matches no online runner/);
    expect(readFileSync(fx.file, 'utf8')).toBe(YAML);
    expect(readdirSync(join(fx.dir, '.studio'))).toEqual(['studio.yaml']);
  });

  it('--write refuses when the resulting document is invalid and leaves the file alone', async () => {
    const broken = YAML.replace('repos: [org/app]', 'repos: []');
    const fx = fixture({ yaml: broken });
    const r = await cli(fx, 'setup', 'ci', '--write');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/nothing written/);
    expect(readFileSync(fx.file, 'utf8')).toBe(broken);
    expect(readdirSync(join(fx.dir, '.studio'))).toEqual(['studio.yaml']);
  });

  it('plain run exits 1 on a lint error too', async () => {
    const fx = fixture({ workflows: { 'ci.yml': WORKFLOW('[self-hosted, missing-label]') } });
    expect((await cli(fx, 'setup', 'ci')).code).toBe(1);
  });

  it('--write changes only the ci block, keeps other keys and comments, and loads', async () => {
    const fx = fixture({ workflows: { 'ci.yml': WORKFLOW('[self-hosted, linux]') } });
    const r = await cli(fx, 'setup', 'ci', '--write', '--json');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).written).toBe(true);
    const text = readFileSync(fx.file, 'utf8');
    for (const kept of [
      '# top comment',
      'primary_repo: org/app # the main repo',
      '# provider comment',
      '# was hosted',
      'builder: { model: sonnet, wip: 2 } # builders',
    ]) {
      expect(text).toContain(kept);
    }
    expect(text).not.toContain('^old-');
    expect(text).toContain('^runner-[0-9]');
    expect(text).toMatch(/runners: self-hosted/);
    const cfg = loadConfig(fx.dir);
    expect(cfg.ci).toMatchObject({
      runners: 'self-hosted',
      runnerLabels: ['linux', 'self-hosted'],
      runnerNamePattern: '^runner-[0-9]',
      capacity: { total: 3, mergeMaxBusy: 2, checkTwiceSeconds: 30 },
    });
    // The part outside ci is byte-identical.
    const tailOf = (t: string) => t.slice(t.indexOf('merge:'));
    expect(tailOf(text)).toBe(tailOf(YAML));
    expect(readdirSync(join(fx.dir, '.studio'))).toEqual(['studio.yaml']);
  });

  it('--write adds a ci block when none exists', async () => {
    const noCi = YAML.replace(/ci:[\s\S]*?(?=merge:)/, '');
    const fx = fixture({ yaml: noCi, workflows: { 'ci.yml': WORKFLOW('[self-hosted, linux]') } });
    const r = await cli(fx, 'setup', 'ci', '--write');
    expect(r.code).toBe(0);
    expect(loadConfig(fx.dir).ci.runners).toBe('self-hosted');
  });

  it('passes a valid current ci to the proposal and notes an invalid one', async () => {
    const keep = fixture({
      yaml: YAML.replace('check_twice_seconds: 30', 'check_twice_seconds: 99'),
    });
    const j = JSON.parse((await cli(keep, 'setup', 'ci', '--json')).out);
    expect(j.proposal.ci.capacity.check_twice_seconds).toBe(99);
    const bad = fixture({ yaml: YAML.replace('provider: github', 'provider: gitlab') });
    const r = await cli(bad, 'setup', 'ci', '--json');
    expect(JSON.parse(r.out).proposal.notes.join('\n')).toMatch(/existing ci block is invalid/);
    expect(JSON.parse(r.out).proposal.ci.capacity.check_twice_seconds).toBe(30);
  });

  it('reads visibility via the Gh port: internal is private, unknown values and errors are public', async () => {
    const internal = fixture({ visibility: 'internal' });
    expect((await cli(internal, 'setup', 'ci', '--json')).code).toBe(0);
    expect(internal.calls).toContain('/repos/org/app');
    const odd = fixture({ visibility: 'weird' });
    expect((await cli(odd, 'setup', 'ci', '--json')).code).toBe(1);
    const failing = fixture({ visibility: new Error('boom') });
    const r = await cli(failing, 'setup', 'ci', '--json');
    expect(r.code).toBe(1);
    const j = JSON.parse(r.out);
    expect(j.errors.join('\n')).toMatch(/public repository/);
    expect(j.proposal.notes.join('\n')).toMatch(/visibility/);
  });

  it('a missing workflows directory is a note; an unreadable workflow file is an error', async () => {
    const none = fixture();
    const a = JSON.parse((await cli(none, 'setup', 'ci', '--json')).out);
    expect(a.proposal.notes.join('\n')).toMatch(/no workflows/);
    const unreadable = fixture();
    mkdirSync(join(unreadable.dir, '.github', 'workflows', 'broken.yml'), { recursive: true });
    const r = await cli(unreadable, 'setup', 'ci', '--json');
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).errors.join('\n')).toMatch(/broken\.yml/);
  });

  it('reads .yml and .yaml, ignores other files, and applies the expected concurrency group', async () => {
    const fx = fixture({
      workflows: {
        'a.yaml': WORKFLOW('[self-hosted, linux]', 'wrong-group'),
        'b.yml': WORKFLOW('[self-hosted, linux]'),
        'c.txt': 'not yaml: [',
      },
    });
    const j = JSON.parse((await cli(fx, 'setup', 'ci', '--json')).out);
    expect(j.errors).toHaveLength(1);
    expect(j.errors[0]).toMatch(/a\.yaml/);
    expect(j.errors[0]).toMatch(/concurrency/);
  });

  it('usage from workflows selects both', async () => {
    const fx = fixture({
      workflows: {
        'a.yml': WORKFLOW('[self-hosted, linux]'),
        'b.yml': WORKFLOW('ubuntu-latest'),
      },
    });
    const j = JSON.parse((await cli(fx, 'setup', 'ci', '--json')).out);
    expect(j.proposal.ci.runners).toBe('both');
  });

  it('the file never changes without --write', async () => {
    const fx = fixture();
    await cli(fx, 'setup', 'ci');
    expect(existsSync(fx.file)).toBe(true);
    expect(readFileSync(fx.file, 'utf8')).toBe(YAML);
  });
});
