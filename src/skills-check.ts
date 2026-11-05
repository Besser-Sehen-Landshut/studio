import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pluginEnv } from './account-command.js';
import { boardPrefix } from './add-item.js';
import { type Board, loadBoard, saveBoard, type WorkItem, workItemSchema } from './board.js';
import type { OwnerEnv, StudioConfig } from './config.js';
import { assertStatePath, writeStateFile } from './paths.js';
import { availableVersions, compareVersions, type PluginPin, pinnedPlugins } from './plugins.js';
import type { Ports } from './ports.js';
import { type CheckResult, checkSources, notUsed, type SourcesFile } from './sources.js';

/** `tick` runs the check at most this often per project; `studio skills check --now` any time. */
export const SKILLS_CHECK_DAYS = 30;
const DAY_MS = 86_400_000;
const NOTE = 'skills-update: ';
const PLUGIN_TIMEOUT_MS = 300_000;

const recordFile = (stateRoot: string) => join(stateRoot, 'skills-check.json');

/** When the check last ran in this project; undefined when never, or unreadable. */
export function lastSkillsCheck(stateRoot: string): string | undefined {
  const file = recordFile(stateRoot);
  try {
    assertStatePath(stateRoot, file);
    if (!lstatSync(file).isFile()) return undefined;
    const at = (JSON.parse(readFileSync(file, 'utf8')) as { lastRun?: unknown }).lastRun;
    return typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? at : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the monthly check is due: never ran, or ran 30 days ago or more. */
export function skillsCheckDue(
  stateRoot: string,
  now: Date,
): { due: boolean; lastRun?: string; nextDue?: string } {
  const lastRun = lastSkillsCheck(stateRoot);
  if (lastRun === undefined) return { due: true };
  const next = Date.parse(lastRun) + SKILLS_CHECK_DAYS * DAY_MS;
  return { due: now.getTime() >= next, lastRun, nextDue: new Date(next).toISOString() };
}

export interface SkillUpdate {
  /** What makes the update one: the same key never gets a second item. */
  key: string;
  kind: 'plugin' | 'source';
  name: string;
  title: string;
  detail: string;
  security: boolean;
  dod: string[];
}

const SCENARIOS =
  'Run the stored skill scenarios in test/skills against the new version where they apply, and record the result';
const ADAPT =
  "Propose the adaptation of Studio's own rules (skills, capabilities) the change needs";

/** A pinned plugin the marketplace offers in a newer version is one update. */
export function pluginUpdates(
  pins: readonly PluginPin[],
  available: ReadonlyMap<string, { version: string; security: boolean }>,
): SkillUpdate[] {
  const out: SkillUpdate[] = [];
  for (const p of pins) {
    const a = available.get(p.name);
    if (a === undefined || compareVersions(a.version, p.version) <= 0) continue;
    out.push({
      key: `plugin ${p.name} ${a.version}`,
      kind: 'plugin',
      name: p.name,
      title: `Update ${p.name} to ${a.version}`,
      detail: `pinned ${p.version}, offered ${a.version}`,
      security: a.security,
      dod: [
        `Compare ${p.name} ${p.version} with ${a.version}: its changelog and the changed skills`,
        SCENARIOS,
        ADAPT,
        `Raise the pin in plugins: of studio.yaml to ${a.version} only after a green review`,
      ],
    });
  }
  return out;
}

const HELD = ['not-fetched', 'no-pin', 'upstream-unreadable', 'fetch-failed'];

/**
 * A source whose watched or read files changed upstream is one update; a source that cannot be
 * judged is a problem for the lead, not an item.
 */
export function sourceUpdates(results: readonly CheckResult[]): {
  updates: SkillUpdate[];
  problems: string[];
} {
  const updates: SkillUpdate[] = [];
  const problems: string[] = [];
  for (const r of results) {
    const held = r.findings.filter((f) => HELD.includes(f.kind));
    if (held.length > 0) {
      problems.push(`source ${r.id}: ${held.map((f) => `${f.kind}: ${f.detail}`).join('; ')}`);
      continue;
    }
    if (r.verdict === 'fits') continue;
    const detail = r.findings
      .slice(0, 10)
      .map((f) => `${f.kind}: ${f.detail}`)
      .join('; ');
    updates.push({
      key: `source ${r.id} ${r.candidate ?? r.pinned ?? 'local'}`,
      kind: 'source',
      name: r.id,
      title: `Review upstream change in ${r.id}`,
      detail: `${r.verdict}: ${detail}`,
      security: false,
      dod: [
        `Compare the upstream change in ${r.id} (${detail})`,
        SCENARIOS,
        ADAPT,
        `Adopt it (studio sources apply ${r.id}, or the vendored files with their notice) only after a green review`,
      ],
    });
  }
  return { updates, problems };
}

const OPEN = (i: WorkItem) => i.status !== 'merged' && i.status !== 'dropped';

/**
 * One chore item per update, for a builder: the same update (by its key, in any status) never gets
 * a second one. A security update, or one the lead names with `--security`, gets priority 0, also
 * when its item exists and is still open.
 */
export function addUpdateItems(o: {
  board: Board;
  updates: readonly SkillUpdate[];
  repo: string;
  /** Names (plugin `name@marketplace` or source id) the lead marked security-relevant. */
  security: readonly string[];
}): {
  board: Board;
  added: { item: string; key: string; priority: number }[];
  present: { item: string; key: string }[];
  raised: string[];
} {
  let items = [...o.board.items];
  const added: { item: string; key: string; priority: number }[] = [];
  const present: { item: string; key: string }[] = [];
  const raised: string[] = [];
  const prefix = boardPrefix(o.board, o.repo);
  for (const u of o.updates) {
    const note = `${NOTE}${u.key}`;
    const urgent = u.security || o.security.includes(u.name);
    const have = items.find((i) => (i.notes ?? []).includes(note));
    if (have !== undefined) {
      present.push({ item: have.id, key: u.key });
      if (urgent && OPEN(have) && have.priority !== 0) {
        items = items.map((i) => (i.id === have.id ? { ...i, priority: 0 } : i));
        raised.push(have.id);
      }
      continue;
    }
    const numbers = items
      .filter((i) => i.id.startsWith(`${prefix}-`))
      .map((i) => Number(i.id.slice(prefix.length + 1)));
    const id = `${prefix}-${Math.max(0, ...numbers) + 1}`;
    const priority = urgent ? 0 : Math.max(0, ...items.map((i) => i.priority)) + 1;
    const parsed = workItemSchema.safeParse({
      id,
      title: u.title,
      type: 'chore',
      role: 'builder',
      repo: o.repo,
      size: 'S',
      priority,
      status: 'ready',
      paths: [],
      touches: u.kind === 'plugin' ? ['.studio/studio.yaml'] : [],
      dependsOn: [],
      dod: u.dod,
      notes: [note, u.detail, ...(urgent ? ['security-relevant update: priority 0'] : [])],
      history: [],
    });
    if (!parsed.success) throw new Error(`the update item for ${u.key} would be invalid`);
    items = [...items, parsed.data];
    added.push({ item: id, key: u.key, priority });
  }
  return { board: { ...o.board, items }, added, present, raised };
}

export interface SkillsCheckResult {
  ran: true;
  checkedAt: string;
  plugins: { name: string; pinned: string; offered?: string }[];
  sources: { id: string; verdict: string }[];
  /** Sources of unknown licence: never used, so never watched. */
  notUsed: string[];
  added: { item: string; key: string; priority: number }[];
  present: { item: string; key: string }[];
  raised: string[];
  problems: string[];
}

/**
 * `studio skills check`: the pinned plugins against what their marketplaces offer (read in the
 * crew config dir, which this refreshes), and the sources against upstream (`sources check`, the
 * vendored ones' watched files too). Each update becomes one board item; nothing is installed or
 * adopted. Records the run for the monthly cadence of `tick`, also when parts failed.
 */
export async function runSkillsCheck(o: {
  project: string;
  stateRoot: string;
  ownerRoot: string;
  config: StudioConfig;
  index: SourcesFile;
  ports: Ports;
  owner: OwnerEnv;
  env: Record<string, string | undefined>;
  security: readonly string[];
  locked: <T>(fn: () => T) => Promise<T>;
}): Promise<SkillsCheckResult> {
  const now = o.ports.clock.now();
  const problems: string[] = [];
  const pins = pinnedPlugins(o.config.plugins);
  let offered: ReadonlyMap<string, { version: string; security: boolean }> = new Map();
  const { dir, runEnv } = pluginEnv(o.owner, o.env);
  if (o.ports.plugins === undefined) problems.push('plugins: no claude command available');
  else if (!existsSync(dir)) {
    problems.push('plugins: the crew config dir is missing; run studio account setup-plugins');
  } else {
    try {
      const opts = { timeoutMs: PLUGIN_TIMEOUT_MS };
      const update = await o.ports.plugins.run(
        ['plugin', 'marketplace', 'update'],
        runEnv,
        dir,
        opts,
      );
      if (update.code !== 0) problems.push('plugins: claude plugin marketplace update failed');
      const r = await o.ports.plugins.run(
        ['plugin', 'list', '--json', '--available'],
        runEnv,
        dir,
        opts,
      );
      const got = r.code === 0 ? availableVersions(r.stdout) : undefined;
      if (got === undefined) problems.push('plugins: the offered versions cannot be read');
      else offered = got;
    } catch (e) {
      problems.push(`plugins: ${(e as Error).message.replace(/\p{Cc}/gu, ' ').slice(0, 200)}`);
    }
  }
  let results: CheckResult[] = [];
  try {
    results = await checkSources({ ownerRoot: o.ownerRoot, index: o.index, ports: o.ports });
  } catch (e) {
    problems.push(`sources: ${(e as Error).message.replace(/\p{Cc}/gu, ' ').slice(0, 200)}`);
  }
  const fromSources = sourceUpdates(results);
  problems.push(...fromSources.problems);
  const updates = [...pluginUpdates(pins, offered), ...fromSources.updates];
  const written = await o.locked(() => {
    const board = loadBoard(o.project, o.config);
    const r = addUpdateItems({
      board,
      updates,
      repo: o.config.primaryRepo,
      security: o.security,
    });
    if (r.added.length > 0 || r.raised.length > 0) saveBoard(o.project, r.board);
    return r;
  });
  writeStateFile(
    o.stateRoot,
    recordFile(o.stateRoot),
    `${JSON.stringify({ lastRun: now.toISOString() })}\n`,
  );
  return {
    ran: true,
    checkedAt: now.toISOString(),
    plugins: pins.map((p) => {
      const v = offered.get(p.name)?.version;
      return { name: p.name, pinned: p.version, ...(v === undefined ? {} : { offered: v }) };
    }),
    sources: results.map((r) => ({ id: r.id, verdict: r.verdict })),
    notUsed: notUsed(o.index),
    added: written.added,
    present: written.present,
    raised: written.raised,
    problems,
  };
}
