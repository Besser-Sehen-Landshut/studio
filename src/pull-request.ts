// Opening a crew's pull request from its pushed branch, outside the sandbox: for the lead (a crew
// that could not run gh) and for a worker (src/worker.ts), which opens it with its own identity.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NotRunHere, WorkItem } from './board.js';
import type { Capacity } from './planner.js';
import type { Ports } from './ports.js';

const PR_BODY_MAX = 20_000;

/**
 * Opens the pull request of a crew that pushed `studio/<id>` but could not run gh, with the crew
 * token, outside the sandbox. Title and body are crew text: cleaned, cut and passed as data in a
 * file, never on a command line. An open pull request of that branch is taken instead and its
 * text renewed with `gh pr edit`; both wait for `capacity`. A new one is opened only when `capacity` holds;
 * otherwise nothing is opened and the read that decided comes back as `held`. `unchanged` runs
 * after the capacity wait, right before the create, and throws when the item moved meanwhile.
 */
export async function openCrewPr(
  ports: Ports,
  item: WorkItem,
  title: string,
  body: string,
  notRunHere: readonly NotRunHere[],
  token: string,
  capacity: () => Promise<{ ok: boolean; capacity: Capacity }>,
  unchanged: () => void,
): Promise<{ pr: number } | { held: Capacity }> {
  const head = `studio/${item.id}`;
  const list = await ports.gh.run(
    ['pr', 'list', '--repo', item.repo, '--head', head, '--state', 'open', '--json', 'number'],
    { token },
  );
  if (list.code !== 0)
    throw new Error(`cannot list pull requests of ${head} (gh exit ${list.code})`);
  const open = JSON.parse(list.stdout || '[]') as { number?: unknown }[];
  const known = open.find((p) => Number.isInteger(p.number))?.number;
  // Crew text loses control and format characters (bidi overrides, zero-width).
  const plainTitle = title.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  if (plainTitle === '')
    throw new Error(`the pull request title for ${head} is empty; nothing moved`);
  // Studio's own lines come first, so crew text can neither push them out of view nor fake an end.
  const text = `Opened by Studio for ${item.id}; the text below the line was written by the crew.\n${notRunSection(notRunHere)}\n---\n\n${body.replace(/[^\P{Cc}\n\t]|\p{Cf}/gu, '').slice(0, PR_BODY_MAX)}\n`;
  const withBody = async <T>(use: (file: string) => Promise<T>): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-pr-'));
    try {
      const file = join(dir, 'body.md');
      writeFileSync(file, text, { mode: 0o600 });
      return await use(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  // Opening and editing both wait for CI capacity: an edit can start workflows too.
  const room = await capacity();
  if (!room.ok) return { held: room.capacity };
  unchanged();
  if (typeof known === 'number') {
    // The open pull request gets this report's text, so its not_run_here list is never stale.
    return withBody(async (file) => {
      const r = await ports.gh.run(
        ['pr', 'edit', String(known), '--repo', item.repo, '--body-file', file],
        { token },
      );
      if (r.code !== 0) {
        throw new Error(`gh pr edit failed for ${head} (exit ${r.code}); nothing moved`);
      }
      return { pr: known };
    });
  }
  return withBody(async (file) => {
    const r = await ports.gh.run(
      [
        'pr',
        'create',
        '--repo',
        item.repo,
        '--head',
        head,
        '--title',
        plainTitle,
        '--body-file',
        file,
      ],
      { token },
    );
    const m = /\/pull\/(\d+)\s*$/.exec(r.stdout);
    if (r.code !== 0 || !m)
      throw new Error(`gh pr create failed for ${head} (exit ${r.code}); nothing moved`);
    return { pr: Number(m[1]) };
  });
}
/**
 * The pull request section for commands the crew could not run in its sandbox. Each line is crew
 * text, already one plain line by the report schema; fences are cut so it stays in its block.
 */
export function notRunSection(list: readonly NotRunHere[]): string {
  if (list.length === 0) return '';
  const lines = list.map((x) =>
    `${x.command} (missing ${x.missing}: ${x.reason})`.replace(/`{3,}/g, ''),
  );
  return `\n## Not run in the crew sandbox\n\nThe crew could not run these commands, because its sandbox lacks the service named (crew text). CI must run them; an approval counts only with green checks.\n\n\`\`\`text\n${lines.join('\n')}\n\`\`\`\n`;
}
