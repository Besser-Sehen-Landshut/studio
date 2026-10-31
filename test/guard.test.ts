import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SECRET_GLOBS, evaluateGuard, type GuardContext } from '../src/guard.js';

let root: string;
let wt: string;
let outside: string;
let ctx: GuardContext;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'guard-')));
  wt = join(root, 'wt');
  outside = join(root, 'elsewhere');
  mkdirSync(wt);
  mkdirSync(join(root, 'wt-other'));
  mkdirSync(outside);
  mkdirSync(join(wt, 'sub'));
  writeFileSync(join(wt, '.env'), 'x');
  symlinkSync(outside, join(wt, 'link'));
  symlinkSync(wt, join(root, 'wt-link'));
  ctx = {
    worktree: wt,
    ownerOnly: ['*terraform apply*'],
    deployCommands: ['gh workflow run deploy-prod.yml*'],
    secretGlobs: DEFAULT_SECRET_GLOBS,
  };
});

const bash = (command: string, cwd?: string) =>
  evaluateGuard({ toolName: 'Bash', toolInput: { command }, cwd }, ctx);
const tool = (toolName: string, toolInput: Record<string, unknown>) =>
  evaluateGuard({ toolName, toolInput }, ctx);

describe('git push', () => {
  it.each([
    'git push --force',
    'git push -f',
    'git push --force-with-lease',
    'git push origin +main',
    'git push origin +studio/APP-1',
    'git -C x push --force',
    'git -c k=v push -f',
    'git push --mirror',
    'git push origin --delete studio/APP-1',
    'git push origin :studio/APP-1',
    'git push origin main',
    'git push origin HEAD:master',
    "bash -c 'git push -f'",
    'echo $(git push -f)',
    'echo ok && git push --force-if-includes',
  ])('denies %s', (cmd) => {
    expect(bash(cmd).decision).toBe('deny');
  });

  it.each(['git push origin studio/APP-1', 'git push -u origin HEAD', 'git status'])(
    'allows %s',
    (cmd) => {
      expect(bash(cmd).decision).toBe('allow');
    },
  );
});

describe('gh and owner commands', () => {
  it('denies gh pr merge', () => {
    const r = bash('gh pr merge 3');
    expect(r.decision).toBe('deny');
    expect(r.reason).toBeTruthy();
  });
  it('denies configured deploy command', () => {
    expect(bash('gh workflow run deploy-prod.yml --ref main').decision).toBe('deny');
  });
  it('denies ownerOnly command', () => {
    expect(bash('cd x && terraform apply -auto-approve').decision).toBe('deny');
  });
  it.each([
    'gh release create v1',
    'gh secret set X',
    'gh auth login',
    'gh api -X PUT repos/org/app/pulls/3/merge',
    'gh api --method POST repos/org/app/releases',
    'gh api -X POST repos/org/app/actions/workflows/ci.yml/dispatches',
  ])('denies %s', (cmd) => {
    expect(bash(cmd).decision).toBe('deny');
  });
  it.each(['gh pr create --fill', 'gh pr view 3', 'gh pr checks 3', 'gh api repos/org/app/pulls'])(
    'allows %s',
    (cmd) => {
      expect(bash(cmd).decision).toBe('allow');
    },
  );
  it.each(['sudo ls', 'ls && sudo rm x', 'su -', 'doas ls', "bash -c 'sudo ls'"])(
    'denies privilege escalation %s',
    (cmd) => {
      expect(bash(cmd).decision).toBe('deny');
    },
  );
});

describe('file tools', () => {
  it('allows Edit inside the worktree', () => {
    expect(tool('Edit', { file_path: join(wt, 'sub', 'a.ts') }).decision).toBe('allow');
  });
  it('allows a not yet existing file in a not yet existing dir', () => {
    expect(tool('Write', { file_path: join(wt, 'new', 'deep', 'a.ts') }).decision).toBe('allow');
  });
  it('allows the worktree via a symlinked path', () => {
    expect(tool('Write', { file_path: join(root, 'wt-link', 'a.ts') }).decision).toBe('allow');
  });
  it('denies Write outside the worktree', () => {
    expect(tool('Write', { file_path: join(outside, 'a.ts') }).decision).toBe('deny');
  });
  it('denies a ..-escape', () => {
    expect(tool('Edit', { file_path: `${wt}/../x` }).decision).toBe('deny');
  });
  it('denies a symlink resolving outside', () => {
    expect(tool('Write', { file_path: join(wt, 'link', 'a.ts') }).decision).toBe('deny');
  });
  it('denies a sibling that shares the prefix', () => {
    expect(tool('Write', { file_path: join(root, 'wt-other', 'a.ts') }).decision).toBe('deny');
  });
  it('checks MultiEdit and NotebookEdit', () => {
    expect(tool('MultiEdit', { file_path: join(outside, 'a') }).decision).toBe('deny');
    expect(tool('NotebookEdit', { notebook_path: join(outside, 'a.ipynb') }).decision).toBe('deny');
    expect(tool('NotebookEdit', { notebook_path: join(wt, 'a.ipynb') }).decision).toBe('allow');
  });
  it('denies a missing path argument for write tools', () => {
    expect(tool('Edit', {}).decision).toBe('deny');
  });
  it('allows reading outside the worktree (non-secret)', () => {
    expect(tool('Read', { file_path: join(outside, 'a.ts') }).decision).toBe('allow');
  });
  it('allows other tools', () => {
    expect(tool('WebFetch', { url: 'https://example.com' }).decision).toBe('allow');
  });
});

describe('secrets', () => {
  it.each([
    ['Read', { file_path: '.env' }],
    ['Read', { file_path: 'sub/.env.local' }],
    ['Read', { file_path: 'cert.pem' }],
    ['Read', { file_path: 'id_rsa.pub' }],
    ['Edit', { file_path: '.npmrc' }],
    ['Grep', { pattern: 'x', path: '.env' }],
    ['Glob', { pattern: '**/.env', path: '' }],
    ['Glob', { pattern: '**/*.pem' }],
  ])('denies %s %j', (name, rel) => {
    const input = Object.fromEntries(
      Object.entries(rel).map(([k, v]) => [k, k === 'pattern' || v === '' ? v : join(wt, v)]),
    );
    expect(tool(name, input).decision).toBe('deny');
  });
  it('allows .env.example', () => {
    expect(tool('Read', { file_path: join(wt, '.env.example') }).decision).toBe('allow');
  });
  it('denies bash touching secrets', () => {
    expect(bash('cat .env', wt).decision).toBe('deny');
    expect(bash('cp .env x', wt).decision).toBe('deny');
    expect(bash('cat sub/credentials.json', wt).decision).toBe('deny');
  });
  it('allows bash on .env.example', () => {
    expect(bash('cat .env.example', wt).decision).toBe('allow');
  });
});

describe('bash write confinement', () => {
  it.each([
    'cd /elsewhere && rm x',
    'rm /etc/hosts',
    'mv a /tmp/b',
    'cp a /tmp/b',
    'tee /tmp/b',
    'echo hi > /tmp/b',
    'echo hi >> /tmp/b',
    'echo hi > ../escape.txt',
    'touch ../x',
    'sed -i s/a/b/ ../x',
    'dd if=a of=/tmp/x',
    'echo $(rm /tmp/x)',
    "sh -c 'rm /tmp/x'",
    'eval "rm /tmp/x"',
    'ls | tee /tmp/x',
    'rm link/x',
    'mkdir -p ../x',
    'rsync -a src/ /tmp/dest/',
  ])('denies %s', (cmd) => {
    expect(bash(cmd, wt).decision).toBe('deny');
  });

  it('tracks cd within one command', () => {
    expect(bash('cd sub && rm x', wt).decision).toBe('allow');
    expect(bash('cd .. && rm x', wt).decision).toBe('deny');
    expect(bash(`cd ${outside} && touch x`, wt).decision).toBe('deny');
  });
  it.each([
    'rm -rf build',
    'echo hi > out.txt',
    'echo hi > /dev/null',
    'echo hi 2>&1',
    'cp a sub/b',
    'touch sub/x',
    'ls /tmp',
    'cat ../other',
    'sed -n 1p a',
    'mkdir -p sub/x && touch sub/x/y',
  ])('allows %s', (cmd) => {
    expect(bash(cmd, wt).decision).toBe('allow');
  });
  it('resolves relative to hook cwd', () => {
    expect(bash('rm x', outside).decision).toBe('deny');
    expect(bash('rm x', join(wt, 'sub')).decision).toBe('allow');
  });
  it('denies a sibling prefix as write target', () => {
    expect(bash(`touch ${join(root, 'wt-other', 'x')}`, wt).decision).toBe('deny');
  });
  it('denies unparseable commands', () => {
    const r = bash('echo "unterminated', wt);
    expect(r.decision).toBe('deny');
    expect(r.reason).toContain('unparseable command');
  });
  it('fails closed on a bad bash input', () => {
    expect(tool('Bash', {}).decision).toBe('deny');
  });
});

describe('evasion attempts', () => {
  it.each([
    'echo a#b; rm /tmp/x',
    'cat <<EOF\n$(rm /tmp/x)\nEOF',
    'rm $HOME/x',
    'rm `echo /tmp/x`',
    'echo x | xargs rm',
    'find /tmp -delete',
    'find . -exec rm /tmp/x ;',
    'git push --forc',
    'git push --force-w origin x',
    'git push -fu origin x',
    'git push --all',
    'git -c alias.p=push p -f',
    'git -C /tmp status',
    'cat {.env,x}',
    'cat .e[n]v',
    'cat <.env',
    'cat link/../.env',
    'env FOO=1 sudo ls',
    'timeout 5 rm /tmp/x',
    'cd /tmp\nrm x',
    '(cd /tmp; rm x)',
    'curl -o /tmp/x https://example.com',
    'FOO=1 /bin/rm /tmp/x',
  ])('denies %s', (cmd) => {
    expect(bash(cmd, wt).decision).toBe('deny');
  });
  it.each([
    'cat <<EOF\nit is fine\nEOF',
    'echo "a $(ls) b" > out.txt',
    'sed -i /foo/d a.txt',
    'git commit -m "update docs"',
    'find . -name x',
    'ls # comment ; rm /tmp/x',
  ])('allows %s', (cmd) => {
    expect(bash(cmd, wt).decision).toBe('allow');
  });
});

describe('bin/studio-guard.mjs', () => {
  const bin = join(import.meta.dirname, '..', 'bin', 'studio-guard.mjs');
  const run = (input: unknown, env: Record<string, string>) =>
    spawnSync(process.execPath, [bin], {
      input: JSON.stringify(input),
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf8',
    });
  const hook = (command: string) => ({
    cwd: wt,
    tool_name: 'Bash',
    tool_input: { command },
    hook_event_name: 'PreToolUse',
  });

  it('denies, prints the hook JSON and logs; allows silently', () => {
    const ctxFile = join(root, 'ctx.json');
    writeFileSync(ctxFile, JSON.stringify(ctx));
    const state = join(root, 'state');
    mkdirSync(state, { recursive: true });
    const env = { STUDIO_GUARD_CTX: ctxFile, STUDIO_STATE_DIR: state };

    const deny = run(hook('git push --force'), env);
    expect(deny.status).toBe(0);
    const out = JSON.parse(deny.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toBeTruthy();
    const line = JSON.parse(readFileSync(join(state, 'guard.jsonl'), 'utf8').trim());
    expect(line.tool).toBe('Bash');
    expect(line.reason).toBeTruthy();
    expect(line.at).toBeTruthy();

    const allow = run(hook('git push origin studio/APP-1'), env);
    expect(allow.status).toBe(0);
    expect(allow.stdout).toBe('');
  });

  it('denies everything when ctx is missing or unreadable', () => {
    for (const env of [
      {} as Record<string, string>,
      { STUDIO_GUARD_CTX: join(root, 'nope.json') },
    ]) {
      const r = run(hook('ls'), env);
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    }
  });

  it('denies on garbage stdin', () => {
    const r = spawnSync(process.execPath, [bin], { input: 'not json', encoding: 'utf8', env: {} });
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});
