import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pluginEnv } from './account-command.js';
import { boardPrefix } from './add-item.js';
import { type Board, loadBoard, saveBoard, type WorkItem, workItemSchema } from './board.js';
import type { OwnerEnv, StudioConfig } from './config.js';
import { assertStatePath, writeStateFile } from './paths.js';
import {
  type AllowedPlugin,
  availableVersions,
  compareVersions,
  type PluginPin,
  pinnedPlugins,
} from './plugins.js';
import type { Ports } from './ports.js';
import { type CheckResult, checkSources, notUsed, type SourcesFile } from './sources.js';

/** `tick` runs the check at most this often per project; `studio skills check --now` any time. */
export const SKILLS_CHECK_DAYS = 30;
const DAY_MS = 86_400_000;
const NOTE = 'skills-update: ';
const PLUGIN_TIMEOUT_MS = 300_000;

const recordFile = (stateRoot: string) => join(stateRoot, 'skills-check.json');

const at = (v: unknown): string | undefined =>
  typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : undefined;

/** The record: the last run that succeeded, and the last attempt; empty when never or unreadable. */
function readRecord(stateRoot: string): { lastRun?: string; lastAttempt?: string } {
  const file = recordFile(stateRoot);
  try {
    assertStatePath(stateRoot, file);
    if (!lstatSync(file).isFile()) return {};
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      lastRun?: unknown;
      lastAttempt?: unknown;
    };
    const lastRun = at(raw.lastRun);
    const lastAttempt = at(raw.lastAttempt);
    return {
      ...(lastRun === undefined ? {} : { lastRun }),
      ...(lastAttempt === undefined ? {} : { lastAttempt }),
    };
  } catch {
    return {};
  }
}

/** When the check last succeeded in this project; undefined when never, or unreadable. */
export function lastSkillsCheck(stateRoot: string): string | undefined {
  return readRecord(stateRoot).lastRun;
}

/**
 * Whether the monthly check is due: it never succeeded, or succeeded 30 days ago or more. A check
 * that failed is tried again a day after the failed attempt, not on every tick.
 */
export function skillsCheckDue(
  stateRoot: string,
  now: Date,
): { due: boolean; lastRun?: string; lastAttempt?: string; nextDue?: string } {
  const { lastRun, lastAttempt } = readRecord(stateRoot);
  const monthly = lastRun === undefined ? 0 : Date.parse(lastRun) + SKILLS_CHECK_DAYS * DAY_MS;
  const failedLater =
    lastAttempt !== undefined &&
    (lastRun === undefined || Date.parse(lastAttempt) > Date.parse(lastRun));
  const retry = failedLater ? Date.parse(lastAttempt as string) + DAY_MS : 0;
  const next = Math.max(monthly, retry);
  return {
    due: now.getTime() >= next,
    ...(lastRun === undefined ? {} : { lastRun }),
    ...(lastAttempt === undefined ? {} : { lastAttempt }),
    ...(next === 0 ? {} : { nextDue: new Date(next).toISOString() }),
  };
}

export interface SkillUpdate {
  /** What the builder reads in the item's notes: no file name from upstream. */
  note: string;
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
      note: `pinned ${p.version}, offered ${a.version}`,
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
    // Licence files are named by upstream: the builder reads only what changed, never the name.
    const licence = r.findings.some((f) => f.kind.startsWith('license-'));
    const files = r.findings.filter((f) => !f.kind.startsWith('license-')).length;
    const summary = [
      ...(files > 0
        ? [`${files} watched or read file${files === 1 ? '' : 's'} changed, new or missing`]
        : []),
      ...(licence ? ['licence file changed'] : []),
    ].join('; ');
    updates.push({
      key: `source ${r.id} ${r.candidate ?? r.pinned ?? 'local'}`,
      kind: 'source',
      name: r.id,
      title: `Review upstream change in ${r.id}`,
      detail: `${r.verdict}: ${detail}`,
      note: `${r.verdict}: ${summary}`,
      security: false,
      dod: [
        `Compare the upstream change in ${r.id} (${summary}; studio sources check names the files)`,
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
      notes: [note, u.note, ...(urgent ? ['security-relevant update: priority 0'] : [])],
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
  sources: { id: string; verdict: string; findings?: string[] }[];
  /** A part could not be read: lastRun stays, the check is tried again in a day. */
  failed?: true;
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
  /** `allowed_plugins` of the owner config. */
  allowed: readonly AllowedPlugin[];
  ports: Ports;
  owner: OwnerEnv;
  env: Record<string, string | undefined>;
  security: readonly string[];
  locked: <T>(fn: () => T) => Promise<T>;
}): Promise<SkillsCheckResult> {
  const now = o.ports.clock.now();
  const problems: string[] = [];
  // A part that could not be read at all: the run is no success and is tried again in a day.
  let failed = false;
  const fail = (line: string) => {
    failed = true;
    problems.push(line);
  };
  const pins = pinnedPlugins(o.config.plugins, o.allowed);
  let offered: ReadonlyMap<string, { version: string; security: boolean }> = new Map();
  const { dir, runEnv } = pluginEnv(o.owner, o.env);
  if (o.ports.plugins === undefined) fail('plugins: no claude command available');
  else if (!existsSync(dir)) {
    fail('plugins: the crew config dir is missing; run studio account setup-plugins');
  } else {
    try {
      const opts = { timeoutMs: PLUGIN_TIMEOUT_MS };
      const update = await o.ports.plugins.run(
        ['plugin', 'marketplace', 'update'],
        runEnv,
        dir,
        opts,
      );
      if (update.code !== 0) fail('plugins: claude plugin marketplace update failed');
      const r = await o.ports.plugins.run(
        ['plugin', 'list', '--json', '--available'],
        runEnv,
        dir,
        opts,
      );
      const got = r.code === 0 ? availableVersions(r.stdout) : undefined;
      if (got === undefined) fail('plugins: the offered versions cannot be read');
      else {
        offered = got.offered;
        if (got.dropped.length > 0) {
          problems.push(
            `plugins: dropped offered versions that are no plain version: ${got.dropped.slice(0, 10).join(', ')}`,
          );
        }
      }
    } catch (e) {
      fail(`plugins: ${(e as Error).message.replace(/\p{Cc}/gu, ' ').slice(0, 200)}`);
    }
  }
  let results: CheckResult[] = [];
  try {
    results = await checkSources({ ownerRoot: o.ownerRoot, index: o.index, ports: o.ports });
  } catch (e) {
    fail(`sources: ${(e as Error).message.replace(/\p{Cc}/gu, ' ').slice(0, 200)}`);
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
  const before = readRecord(o.stateRoot).lastRun;
  const lastRun = failed ? before : now.toISOString();
  writeStateFile(
    o.stateRoot,
    recordFile(o.stateRoot),
    `${JSON.stringify({ ...(lastRun === undefined ? {} : { lastRun }), lastAttempt: now.toISOString() })}\n`,
  );
  return {
    ran: true,
    checkedAt: now.toISOString(),
    plugins: pins.map((p) => {
      const v = offered.get(p.name)?.version;
      return { name: p.name, pinned: p.version, ...(v === undefined ? {} : { offered: v }) };
    }),
    // For the lead: the files each source changed in, as `sources check` names them.
    sources: results.map((r) => ({
      id: r.id,
      verdict: r.verdict,
      ...(r.findings.length === 0
        ? {}
        : { findings: r.findings.slice(0, 10).map((f) => `${f.kind}: ${f.detail}`) }),
    })),
    ...(failed ? { failed: true as const } : {}),
    notUsed: notUsed(o.index),
    added: written.added,
    present: written.present,
    raised: written.raised,
    problems,
  };
}
