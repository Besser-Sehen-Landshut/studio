#!/usr/bin/env node
// Stand-in for `claude -p` used by the end-to-end loop test. It checks the arguments the crew
// launcher passes, reads the prompt from stdin, and behaves like a crew session that finishes
// its item: one commit in the cwd (the crew clone) and a report file.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const value = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const settings = value('--settings');
const ok =
  args.includes('-p') &&
  settings !== undefined &&
  existsSync(settings) &&
  value('--model') !== undefined &&
  value('--permission-mode') === 'bypassPermissions' &&
  value('--output-format') === 'stream-json';
if (!ok) {
  process.stderr.write(`fake-claude: unexpected arguments: ${args.join(' ')}\n`);
  process.exit(2);
}

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const brief = /^Read (\S+) and follow it\.$/.exec(prompt.trim())?.[1];
if (!brief || !existsSync(brief)) {
  process.stderr.write('fake-claude: prompt does not name an existing brief\n');
  process.exit(2);
}
const id = process.env.STUDIO_ITEM;
if (!id || !/^[A-Z]+-\d+$/.test(id)) {
  process.stderr.write('fake-claude: STUDIO_ITEM is missing\n');
  process.exit(2);
}

await new Promise((resolve) => setTimeout(resolve, 100));
process.stdout.write(
  `${JSON.stringify({ type: 'system', subtype: 'init', session_id: `fake-${id}` })}\n`,
);

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const cwd = process.cwd();
const file = `${id.toLowerCase()}.txt`;
writeFileSync(join(cwd, file), `work for ${id}\n`);
writeFileSync(join(cwd, '.git-message'), `${id}: fake work\n`);
git('add', file);
git('commit', '-F', '.git-message');
const head = git('rev-parse', 'HEAD');

// Simplification: the report is written after the last commit and stays untracked, so its
// head_sha is the real head of the branch. The control room only reads the file.
mkdirSync(join(cwd, '.studio', 'reports'), { recursive: true });
writeFileSync(
  join(cwd, '.studio', 'reports', `${id}.md`),
  [
    '---',
    'status: done',
    `item: ${id}`,
    `pr: ${Number(id.split('-')[1])}`,
    `head_sha: ${head}`,
    'tests_run: 3',
    'lessons: []',
    'questions: []',
    '---',
    '',
    `Did the fake work for ${id}.`,
    '',
  ].join('\n'),
);
process.stdout.write(
  `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false })}\n`,
);
