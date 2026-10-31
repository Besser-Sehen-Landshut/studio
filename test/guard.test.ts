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
    crewAllowedWorkflows: ['ci.yml'],
    protectedPaths: [join(root, 'state')],
  };
  mkdirSync(join(root, 'state'));
  mkdirSync(join(root, 'clean'));
  writeFileSync(join(root, 'clean', 'a.txt'), 'x');
  mkdirSync(join(wt, '.claude'));
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
    'git push -u origin HEAD',
    'git push',
    'git push origin',
    'git push origin @',
    "bash -c 'git push -f'",
    'echo $(git push -f)',
    'echo ok && git push --force-if-includes',
  ])('denies %s', (cmd) => {
    expect(bash(cmd).decision).toBe('deny');
  });

  it.each([
    'git push origin studio/APP-1',
    'git push -u origin HEAD:refs/heads/studio/APP-1',
    'git status',
  ])('allows %s', (cmd) => {
    expect(bash(cmd).decision).toBe('allow');
  });
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

describe('round 1 regressions', () => {
  const denies = (cmds: string[], cwd = wt) => {
    for (const c of cmds) expect(bash(c, cwd), c).toMatchObject({ decision: 'deny' });
  };

  it('CR-1 Grep/Glob secret access', () => {
    expect(
      tool('Grep', { pattern: 'x', glob: '*.{pem,txt}', path: join(root, 'clean') }).decision,
    ).toBe('deny');
    expect(tool('Glob', { pattern: '**/.env*', path: join(root, 'clean') }).decision).toBe('deny');
    expect(tool('Grep', { pattern: 'x', path: wt }).decision).toBe('deny');
    expect(tool('Glob', { pattern: '*.ts', path: wt }).decision).toBe('deny');
    expect(tool('Grep', { pattern: 'x' }).decision).toBe('deny');
    expect(tool('Grep', { pattern: 'credentials', path: join(root, 'clean') }).decision).toBe(
      'allow',
    );
    expect(tool('Grep', { pattern: 'x', path: join(wt, 'sub') }).decision).toBe('allow');
    expect(tool('Glob', { pattern: '**/*.ts', path: join(root, 'clean') }).decision).toBe('allow');
  });

  it('CR-2 protected-branch bypasses', () => {
    denies([
      'git config alias.p push',
      'git config --add remote.origin.push +HEAD:refs/heads/main',
      'git config --replace-all branch.x.merge refs/heads/main',
      'git config push.default upstream',
      "env -S 'git push -f'",
      'env --split-string="sudo ls"',
      'git push',
      'git push origin',
      'git push origin HEAD',
      'git push origin @',
      "git push origin ''",
    ]);
    expect(bash('git push origin HEAD:refs/heads/studio/APP-1').decision).toBe('allow');
    expect(bash('git push origin studio/APP-1').decision).toBe('allow');
  });

  it('CR-3 deploy matching and workflow allow list', () => {
    denies([
      '/usr/bin/gh workflow run deploy-prod.yml',
      '/usr/bin/env gh workflow run deploy-prod.yml',
      'gh -R org/app workflow run deploy-prod.yml',
      'gh --repo=org/app workflow run deploy-prod.yml',
      'gh workflow run --ref main deploy-prod.yml',
      'gh workflow run other.yml',
      'gh workflow run',
      'gh workflow run $W',
    ]);
    expect(bash('gh workflow run ci.yml').decision).toBe('allow');
    expect(bash('gh workflow run --ref x -f a=b ci.yml').decision).toBe('allow');
  });

  it('CR-4 config and state writes', () => {
    for (const f of ['.claude/settings.json', '.mcp.json', '.git/config', '.git/hooks/pre-push']) {
      expect(tool('Write', { file_path: join(wt, f) }).decision, f).toBe('deny');
    }
    expect(tool('Edit', { file_path: join(root, 'state', 'ctx.json') }).decision).toBe('deny');
    denies([
      'echo x > .claude/settings.json',
      'rm -rf .git',
      'cp a .mcp.json',
      'tee .git/config',
      `echo x > ${join(root, 'state', 'guard.jsonl')}`,
      'rm .Claude/x',
    ]);
    expect(bash('git status', wt).decision).toBe('allow');
  });

  it('I1 wrappers', () => {
    denies([
      '/usr/bin/env git push -f',
      '/usr/bin/env sudo ls',
      '/usr/bin/nohup git push -f',
      '/usr/bin/timeout 5 git push -f',
      'command -p git push -f',
      'exec -a x git push -f',
      'time -p sudo ls',
      'nice -n5 sudo ls',
      'nice -n 5 sudo ls',
      "env -S 'sudo ls'",
      'stdbuf -o0 sudo ls',
      'coproc sudo ls',
      'xargs --max-args 1 sudo',
      'xargs --bogus sudo',
      'env -C /tmp rm x',
    ]);
  });

  it('I2 push refspec evasions', () => {
    denies([
      'git push origin HEAD:heads/main',
      'git push origin HEAD:{main,x}',
      'git push {-f,origin} x',
      'git push origin $(echo +main)',
      'R=+main; git push origin $R',
      'git push $(echo -f) origin x',
      'echo +main | xargs git push origin',
      'git push origin HEAD:refs/main',
      'git push origin studio/*',
      'git push --repo=origin +main',
    ]);
  });

  it('I3 git config injection and plumbing', () => {
    denies([
      'git -c remote.origin.push=+HEAD:refs/heads/main push origin',
      'git -c push.default=upstream push origin',
      'git --config-env=alias.p=V p origin x',
      'git --config-env alias.p=V p origin x',
      'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p -f',
      'env GIT_DIR=/tmp/x git status',
      'export GIT_WORK_TREE=/tmp',
      'git send-pack --force origin HEAD:main',
      'git -c core.hooksPath=/tmp/h status',
    ]);
  });

  it('I4 gh evasions', () => {
    denies([
      'gh pr $(echo merge) 3',
      'gh pr "$M" 3',
      'gh api -X POST repos/org/app/merges -f base=main -f head=x',
      'gh api -X PUT repos/org/app/pulls/3/merge/',
      'gh api -X PUT repos/org/app/contents/a.txt -f branch=main',
      'gh api graphql -F query=@m.graphql',
      'gh api graphql -f query="$Q"',
      'gh api graphql --input q.json',
      "gh api graphql -f query='mutation { mergePullRequest(input:{}) { clientMutationId } }'",
      'gh api $E',
    ]);
    expect(bash("gh api graphql -f query='query { viewer { login } }'").decision).toBe('allow');
    expect(bash('gh pr create --title "$T" --body "$(date)"').decision).toBe('allow');
  });

  it('I5 deploy and owner-only after normalisation', () => {
    denies(['/usr/local/bin/terraform apply', 'env X=1 /opt/bin/terraform apply -auto-approve']);
  });

  it('I6 write path globs, cd state, <>', () => {
    denies([
      'touch li*/pwned',
      'rm lin?/x',
      `cd ${root} && pushd ${wt} && popd && rm x`,
      'CDPATH=/ cd tmp && rm x',
      'export CDPATH=/; cd sub; rm x',
      'exec 3<> /tmp/x',
      'rm ../*',
      'touch {a,../b}',
    ]);
    expect(bash('touch s*/x', wt).decision).toBe('allow');
  });

  it('I7 heredoc delimiter quote removal', () => {
    expect(bash('cat <<E\\"OF\nE"OF\nrm /tmp/x\nEOF', wt).decision).toBe('deny');
    expect(bash("cat <<'EOF'\nrm /tmp/x\nEOF", wt).decision).toBe('allow');
    expect(bash('cat <<"EOF"\nrm /tmp/x\nEOF', wt).decision).toBe('allow');
  });

  it('I8 secret globs are case-insensitive', () => {
    expect(bash('cat .ENV', wt).decision).toBe('deny');
    expect(tool('Read', { file_path: join(wt, '.ENV') }).decision).toBe('deny');
    expect(tool('Read', { file_path: join(wt, 'KEY.PEM') }).decision).toBe('deny');
  });

  it('I9 other tools', () => {
    expect(tool('Monitor', { command: 'rm /tmp/x' }).decision).toBe('deny');
    expect(tool('Monitor', { command: 'tail -f log' }).decision).toBe('allow');
    expect(tool('PowerShell', { command: 'ls' }).decision).toBe('deny');
    expect(tool('SomethingNew', { command: 'git push -f' }).decision).toBe('deny');
  });

  it('M1 invalid ctx is rejected', () => {
    const bad = { ...ctx, secretGlobs: 'nope' } as unknown as GuardContext;
    expect(evaluateGuard({ toolName: 'Read', toolInput: {} }, bad).decision).toBe('deny');
    expect(
      evaluateGuard({ toolName: 'Read', toolInput: {} }, null as unknown as GuardContext).decision,
    ).toBe('deny');
  });

  it('M1 bin denies a ctx file that is not an object', () => {
    const f = join(root, 'ctx-array.json');
    writeFileSync(f, '[]');
    const r = spawnSync(
      process.execPath,
      [join(import.meta.dirname, '..', 'bin', 'studio-guard.mjs')],
      {
        input: JSON.stringify({
          cwd: wt,
          tool_name: 'Read',
          tool_input: { file_path: join(root, 'clean', 'a.txt') },
        }),
        env: { PATH: process.env.PATH ?? '', STUDIO_GUARD_CTX: f },
        encoding: 'utf8',
      },
    );
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
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
    const state = join(root, 'statedir');
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
