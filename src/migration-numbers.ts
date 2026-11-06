// The register of reserved database migration numbers (`studio migration`). The lead hands out
// numbers to several sessions; a promise made only in chat once went to two of them, and main and
// the open pull requests show only what is pushed. The register lives in the lead's state root
// (never in git), next to what main and the open pull requests hold, and a pull request whose new
// migration takes a number that is someone else's is held at collect and in the queue.
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { MigrationsConfig, StudioConfig } from './config.js';
import { migrationEntryOf, migrationNumberOf, TOO_LARGE } from './migration-pattern.js';
import { acquireStateLock, assertStatePath, writeStateFile } from './paths.js';
import type { Gh } from './ports.js';
import { readDefaultBranch, usableBaseName } from './review.js';

export const REGISTER_FILE = 'migration-numbers.json';
export const REGISTER_LOCK = 'migration-numbers.lock';
const LOCK_STALE_MS = 30_000;
const GH_TIMEOUT_MS = 60_000;
/** Landed and released entries kept for `list`, newest first; reserved ones are always kept. */
const KEEP_HISTORY = 500;
/** A pull request list returns at most this many files per pull request; more are read one by one. */
const LIST_FILES_CAP = 100;
/** GitHub lists at most this many files of a pull request: a list this long may be cut. */
const PR_FILES_API_CAP = 3000;
/** Open pull requests read at once: a list this long may be cut. */
const PR_LIST_LIMIT = 1000;

/** Who a number is for: an item id, a crew or session name, a branch. One plain word. */
export const HOLDER_RE = /^[A-Za-z0-9][A-Za-z0-9._:/#@-]{0,63}$/;
const holderSchema = z.string().regex(HOLDER_RE, 'one word of at most 64 characters');
const purposeSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u, 'one line of at most 200 characters');
/** A name from main kept in the register: plain characters only, else it is left out. */
const SAFE_NAME = /^[A-Za-z0-9._-]{1,255}$/;
/** A name in a reason: as it is when plain, else quoted as data (a crew chooses its file names). */
const shown = (name: string): string =>
  SAFE_NAME.test(name) ? name : JSON.stringify(name.replace(/[\p{Cc}\p{Cf}]/gu, '?').slice(0, 120));

const reservationSchema = z.strictObject({
  number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  for: holderSchema,
  purpose: purposeSchema,
  at: z.string(),
  status: z.enum(['reserved', 'landed', 'released']),
  landedAt: z.string().optional(),
  /** The migration on main that holds the number, once it landed. */
  file: z.string().regex(SAFE_NAME).optional(),
  releasedAt: z.string().optional(),
});
export type Reservation = z.infer<typeof reservationSchema>;

const registerSchema = z.strictObject({
  v: z.literal(1),
  reservations: z.array(reservationSchema),
});
export type Register = z.infer<typeof registerSchema>;

/** The migrations block with its pattern compiled and its repository resolved. */
export interface MigrationScheme {
  repo: string;
  dir: string;
  pattern: RegExp;
}

/** The scheme of a project, or undefined when studio.yaml has no `migrations:` block. */
export function migrationScheme(config: StudioConfig): MigrationScheme | undefined {
  const m: MigrationsConfig | undefined = config.migrations;
  if (m === undefined) return undefined;
  return { repo: m.repo ?? config.primaryRepo, dir: m.dir, pattern: new RegExp(m.numberPattern) };
}

/** What main and the open pull requests hold, by number. */
export interface MigrationUse {
  /** The default branch the numbers on `main` were read from. */
  branch: string;
  /** Numbers on the default branch, each with the first name that holds it. */
  main: Map<number, string>;
  /** Every entry name on the default branch: a pull request that changes one adds nothing. */
  names: Set<string>;
  /**
   * Entries on the default branch whose number is too large to compare. One in an open pull
   * request is left out: that pull request's own check blocks it, and no other user is held.
   */
  tooLarge: string[];
  /** Per open pull request: the numbers of its migrations that are not on main. */
  prs: Map<number, Map<number, string>>;
  /** False when the folder does not exist on the default branch (yet). */
  dirOnMain: boolean;
}

const registerFile = (root: string) => join(root, REGISTER_FILE);

/** The register; missing means empty. Anything unreadable or invalid throws: never guessed. */
export function readRegister(root: string): Register {
  const file = registerFile(root);
  assertStatePath(root, file);
  if (!existsSync(file)) return { v: 1, reservations: [] };
  if (lstatSync(file).isSymbolicLink()) {
    throw new Error(`refusing to read ${file}: it is a symlink`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`migration register ${file} is not valid JSON`);
  }
  const parsed = registerSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`migration register ${file} is invalid`);
  return parsed.data;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Reads, changes and writes the register under its lock, so two reservations in different
 * processes never hand out the same number. Waits up to 5 s for the lock.
 */
export function updateRegister<T>(
  root: string,
  mutate: (reg: Register) => T,
  opts: { now: Date; timeoutMs?: number },
): T {
  const until = Date.now() + (opts.timeoutMs ?? 5000);
  for (;;) {
    const lock = acquireStateLock(root, REGISTER_LOCK, {
      now: opts.now,
      heartbeatStaleMs: LOCK_STALE_MS,
    });
    if (lock) {
      try {
        const reg = readRegister(root);
        const result = mutate(reg);
        const reserved = reg.reservations.filter((r) => r.status === 'reserved');
        const history = reg.reservations
          .filter((r) => r.status !== 'reserved')
          .slice(-KEEP_HISTORY);
        const kept = new Set([...reserved, ...history]);
        reg.reservations = reg.reservations.filter((r) => kept.has(r));
        writeStateFile(root, registerFile(root), `${JSON.stringify(reg, null, 2)}\n`);
        return result;
      } finally {
        lock.release();
      }
    }
    if (Date.now() >= until) {
      throw new Error(`the migration register is locked (${REGISTER_LOCK}); try again`);
    }
    sleepSync(25);
  }
}

/**
 * Numbers of the entries below `dir` in `paths`, each with the first entry that holds it, and the
 * entries whose number is too large to compare (kept apart: never read as no migration).
 */
function numbersOf(
  paths: readonly string[],
  scheme: MigrationScheme,
): { numbers: Map<number, string>; tooLarge: string[] } {
  const numbers = new Map<number, string>();
  const tooLarge = new Set<string>();
  for (const p of paths) {
    const entry = migrationEntryOf(p, scheme.dir);
    if (entry === undefined) continue;
    const n = migrationNumberOf(entry, scheme.pattern);
    if (n === TOO_LARGE) tooLarge.add(entry);
    else if (n !== undefined && !numbers.has(n)) numbers.set(n, entry);
  }
  return { numbers, tooLarge: [...tooLarge] };
}

/** `gh` that must answer: anything else throws with a line that names what could not be read. */
async function ghJson(gh: Gh, args: string[], what: string): Promise<unknown> {
  const r = await gh.run(args, { timeoutMs: GH_TIMEOUT_MS });
  if (r.code !== 0) throw new Error(`cannot read ${what} (gh exit ${r.code})`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`cannot read ${what}: gh returned no JSON`);
  }
}

/** The entry names directly in `dir` on `branch`; undefined when the folder is not there. */
async function namesOnBranch(
  gh: Gh,
  scheme: MigrationScheme,
  branch: string,
): Promise<string[] | undefined> {
  const r = await gh.run(
    ['api', `repos/${scheme.repo}/git/trees/${encodeURIComponent(`${branch}:${scheme.dir}`)}`],
    { timeoutMs: GH_TIMEOUT_MS },
  );
  if (r.code !== 0) {
    if (/HTTP 404|Not Found/.test(`${r.stderr}${r.stdout}`)) return undefined;
    throw new Error(`cannot read ${scheme.dir} on ${branch} (gh exit ${r.code})`);
  }
  let tree: { tree?: unknown; truncated?: unknown };
  try {
    tree = JSON.parse(r.stdout) as typeof tree;
  } catch {
    throw new Error(`cannot read ${scheme.dir} on ${branch}: gh returned no JSON`);
  }
  // A cut list could hide a number: refused rather than read in part.
  if (tree.truncated !== false || !Array.isArray(tree.tree)) {
    throw new Error(`cannot read ${scheme.dir} on ${branch} in full`);
  }
  return tree.tree.flatMap((e: { path?: unknown }) => (typeof e.path === 'string' ? [e.path] : []));
}

/**
 * The files a pull request adds or changes (removed ones aside), every page of them. GitHub cuts
 * the list (at 3000 files): a list that does not hold every changed file the pull request counts,
 * or one at the cap, throws.
 */
export async function pullRequestFiles(gh: Gh, repo: string, pr: number): Promise<string[]> {
  const unreadable = (why: string) => new Error(`cannot read the files of ${repo}#${pr}${why}`);
  const r = await gh.run(
    [
      'api',
      '--paginate',
      `repos/${repo}/pulls/${pr}/files?per_page=100`,
      '--jq',
      '.[] | [.status, .filename] | @json',
    ],
    { timeoutMs: GH_TIMEOUT_MS },
  );
  if (r.code !== 0) throw unreadable(` (gh exit ${r.code})`);
  const files: string[] = [];
  let listed = 0;
  for (const line of r.stdout.split('\n')) {
    if (line.trim() === '') continue;
    let pair: unknown;
    try {
      pair = JSON.parse(line);
    } catch {
      throw unreadable(': gh returned no JSON');
    }
    const [status, name] = Array.isArray(pair) ? pair : [];
    if (typeof status !== 'string' || typeof name !== 'string') {
      throw unreadable(': gh returned no file');
    }
    listed++;
    if (status !== 'removed') files.push(name);
  }
  const count = await ghJson(
    gh,
    ['pr', 'view', String(pr), '--repo', repo, '--json', 'changedFiles'],
    `the file count of ${repo}#${pr}`,
  );
  const changed = (count as { changedFiles?: unknown } | null)?.changedFiles;
  if (!Number.isInteger(changed)) throw unreadable(': gh returned no file count');
  if ((changed as number) >= PR_FILES_API_CAP || listed >= PR_FILES_API_CAP) {
    throw unreadable(`: it changes ${PR_FILES_API_CAP} files or more, more than GitHub lists`);
  }
  if (listed !== changed) {
    throw unreadable(`: GitHub listed ${listed} of its ${changed as number} changed files`);
  }
  return files;
}

/**
 * The numbers main and every open pull request hold. Throws when any part cannot be read: a
 * number is never handed out, nor a pull request passed, on a partial view.
 */
export async function readMigrationUse(gh: Gh, scheme: MigrationScheme): Promise<MigrationUse> {
  const branch = await readDefaultBranch({ gh }, scheme.repo);
  if (branch === undefined || !usableBaseName(branch)) {
    throw new Error(`cannot read the default branch of ${scheme.repo}`);
  }
  const names = await namesOnBranch(gh, scheme, branch);
  const onBranch = numbersOf(
    (names ?? []).map((n) => `${scheme.dir}/${n}`),
    scheme,
  );
  const main = onBranch.numbers;
  const tooLarge = onBranch.tooLarge;
  const onMain = new Set(names ?? []);
  const list = await ghJson(
    gh,
    [
      'pr',
      'list',
      '--repo',
      scheme.repo,
      '--state',
      'open',
      '--limit',
      String(PR_LIST_LIMIT),
      '--json',
      'number,files',
    ],
    `the open pull requests of ${scheme.repo}`,
  );
  if (!Array.isArray(list)) throw new Error(`cannot read the open pull requests of ${scheme.repo}`);
  // A list at its limit may be cut: a pull request beyond it would go unseen.
  if (list.length >= PR_LIST_LIMIT) {
    throw new Error(
      `cannot read the open pull requests of ${scheme.repo} in full: ${PR_LIST_LIMIT} or more are open`,
    );
  }
  const prs = new Map<number, Map<number, string>>();
  for (const raw of list as { number?: unknown; files?: unknown }[]) {
    if (!Number.isInteger(raw.number) || !Array.isArray(raw.files)) {
      throw new Error(`cannot read the open pull requests of ${scheme.repo}`);
    }
    const pr = raw.number as number;
    const listed = raw.files as { path?: unknown; changeType?: unknown }[];
    const paths =
      listed.length >= LIST_FILES_CAP
        ? await pullRequestFiles(gh, scheme.repo, pr)
        : listed.flatMap((f) =>
            typeof f.path === 'string' && f.changeType !== 'DELETED' ? [f.path] : [],
          );
    // What is on main already is the pull request's change of an existing migration, no new one.
    const fresh = paths.filter((p) => {
      const entry = migrationEntryOf(p, scheme.dir);
      return entry !== undefined && !onMain.has(entry);
    });
    const read = numbersOf(fresh, scheme);
    if (read.numbers.size > 0) prs.set(pr, read.numbers);
  }
  return { branch, main, names: onMain, tooLarge, prs, dirOnMain: names !== undefined };
}

/** Marks reserved numbers that main now holds as landed; returns how many changed. */
export function syncLanded(reg: Register, use: MigrationUse, now: Date): number {
  let changed = 0;
  for (const r of reg.reservations) {
    if (r.status !== 'reserved') continue;
    const name = use.main.get(r.number);
    if (name === undefined) continue;
    r.status = 'landed';
    r.landedAt = now.toISOString();
    if (SAFE_NAME.test(name)) r.file = name;
    changed++;
  }
  return changed;
}

/** The reservation that holds `n` now (reserved or landed); released ones hold nothing. */
const holding = (reg: Register, n: number): Reservation | undefined =>
  reg.reservations.find((r) => r.number === n && r.status !== 'released');

/** The next free number: one above the highest on main, in an open pull request or held. */
export function nextFree(reg: Register, use: MigrationUse): number {
  let max = 0;
  for (const n of use.main.keys()) max = Math.max(max, n);
  for (const numbers of use.prs.values()) for (const n of numbers.keys()) max = Math.max(max, n);
  for (const r of reg.reservations) if (r.status !== 'released') max = Math.max(max, r.number);
  return max + 1;
}

/** Why `n` is not free, or undefined. */
export function takenBy(reg: Register, use: MigrationUse, n: number): string | undefined {
  const main = use.main.get(n);
  if (main !== undefined) return `number ${n} is already on ${use.branch} (${shown(main)})`;
  for (const [pr, numbers] of use.prs) {
    const name = numbers.get(n);
    if (name !== undefined) {
      return `number ${n} is used by open pull request #${pr} (${shown(name)})`;
    }
  }
  const held = holding(reg, n);
  if (held !== undefined) {
    return `number ${n} is ${held.status === 'landed' ? 'landed' : 'reserved'} for ${held.for} (${held.purpose})`;
  }
  return undefined;
}

export interface ReserveRequest {
  for: string;
  purpose: string;
  number?: number;
}

/** Checks a request's words; throws with the field that is wrong. */
export function checkReserveRequest(req: ReserveRequest): void {
  if (!holderSchema.safeParse(req.for).success) {
    throw new Error('--for must be one word of at most 64 characters (an item id, a session name)');
  }
  if (!purposeSchema.safeParse(req.purpose).success) {
    throw new Error('--purpose must be one line of at most 200 characters');
  }
  if (
    req.number !== undefined &&
    (!Number.isSafeInteger(req.number) || req.number < 1 || req.number > 999_999_999_999_999)
  ) {
    throw new Error('--number must be a whole number from 1 to 999999999999999');
  }
}

/** Pure: reserves in `reg` (landed ones synced first); throws when the requested number is taken. */
export function reserveIn(
  reg: Register,
  use: MigrationUse,
  req: ReserveRequest,
  now: Date,
): Reservation {
  checkReserveRequest(req);
  // Above a number too large to compare nothing is known to be free: refused, never guessed.
  if (use.tooLarge.length > 0) {
    throw new Error(
      `${use.tooLarge.slice(0, 3).map(shown).join(', ')} on ${use.branch} holds a number of more than 15 digits; the next free number cannot be told; nothing reserved`,
    );
  }
  syncLanded(reg, use, now);
  let n: number;
  if (req.number !== undefined) {
    const taken = takenBy(reg, use, req.number);
    if (taken !== undefined) throw new Error(`${taken}; nothing reserved`);
    n = req.number;
  } else {
    n = nextFree(reg, use);
  }
  const r: Reservation = {
    number: n,
    for: req.for,
    purpose: req.purpose,
    at: now.toISOString(),
    status: 'reserved',
  };
  reg.reservations.push(r);
  return r;
}

/**
 * `studio migration reserve`: main and the open pull requests are read first (any failure
 * refuses), then the number is chosen and written under the register's lock.
 */
export async function reserveMigrationNumber(o: {
  gh: Gh;
  root: string;
  scheme: MigrationScheme;
  request: ReserveRequest;
  now: Date;
}): Promise<Reservation> {
  checkReserveRequest(o.request);
  const use = await readMigrationUse(o.gh, o.scheme);
  return updateRegister(o.root, (reg) => reserveIn(reg, use, o.request, o.now), { now: o.now });
}

/** `studio migration release <n>`: a reserved number becomes free again. */
export function releaseMigrationNumber(root: string, n: number, now: Date): Reservation {
  return updateRegister(
    root,
    (reg) => {
      const r = reg.reservations.find((x) => x.number === n && x.status === 'reserved');
      if (r === undefined) {
        const landed = reg.reservations.some((x) => x.number === n && x.status === 'landed');
        throw new Error(
          landed
            ? `number ${n} has landed on main; there is nothing to release`
            : `number ${n} is not reserved`,
        );
      }
      r.status = 'released';
      r.releasedAt = now.toISOString();
      return { ...r };
    },
    { now },
  );
}

/**
 * `studio migration list`: the register, with landed numbers marked when main can be read, and
 * the number a reservation would get now. A read that fails leaves the register as it is.
 */
export async function listMigrationNumbers(o: {
  gh: Gh;
  root: string;
  scheme: MigrationScheme;
  now: Date;
}): Promise<{ reservations: Reservation[]; next?: number; warning?: string }> {
  let use: MigrationUse;
  try {
    use = await readMigrationUse(o.gh, o.scheme);
  } catch (e) {
    return {
      reservations: readRegister(o.root).reservations,
      warning: `${(e as Error).message}; landed numbers are not updated`,
    };
  }
  return updateRegister(
    o.root,
    (reg) => {
      syncLanded(reg, use, o.now);
      return { reservations: reg.reservations.map((r) => ({ ...r })), next: nextFree(reg, use) };
    },
    { now: o.now },
  );
}

/** Pure: why the new migrations of a pull request take numbers that are not theirs. */
export function migrationCollisions(o: {
  scheme: MigrationScheme;
  use: MigrationUse;
  reg: Register;
  pr: number;
  /** The pull request's files, removed ones aside. */
  files: readonly string[];
  /** The names a reservation for this pull request may carry: item id, crew, branch. */
  holder: readonly string[];
}): string[] {
  const own = new Set(o.holder.map((h) => h.toLowerCase()));
  const reasons = new Map<number, string>();
  const fresh = o.files.filter((p) => {
    const entry = migrationEntryOf(p, o.scheme.dir);
    return entry !== undefined && !o.use.names.has(entry);
  });
  const read = numbersOf(fresh, o.scheme);
  const large = read.tooLarge.map(
    (entry) => `${shown(entry)}: its number has more than 15 digits; Studio cannot check it`,
  );
  for (const [n, entry] of read.numbers) {
    const main = o.use.main.get(n);
    if (main !== undefined) {
      reasons.set(n, `${shown(entry)}: number ${n} is already on ${o.use.branch} (${shown(main)})`);
      continue;
    }
    const held = holding(o.reg, n);
    const ours = held !== undefined && own.has(held.for.toLowerCase());
    if (held !== undefined && !ours) {
      reasons.set(n, `${shown(entry)}: number ${n} is reserved for ${held.for} (${held.purpose})`);
      continue;
    }
    // The holder of the reservation keeps its number; without one, any other user collides.
    if (ours) continue;
    for (const [pr, numbers] of o.use.prs) {
      const other = numbers.get(n);
      if (pr === o.pr || other === undefined) continue;
      reasons.set(
        n,
        `${shown(entry)}: number ${n} is used by open pull request #${pr} (${shown(other)})`,
      );
      break;
    }
  }
  return [...large, ...reasons.values()];
}

/**
 * The register's check of one pull request, for collect and the queue: landed numbers are marked
 * on the way. `problem`: why it must not go on; `unreadable`: it could not be checked now (fails
 * closed: the caller waits or refuses). Nothing when the project keeps no register or the pull
 * request is in another repository.
 */
export async function pullRequestMigrationCheck(o: {
  gh: Gh;
  root: string;
  config: StudioConfig;
  repo: string;
  pr: number;
  holder: readonly string[];
  now: Date;
}): Promise<{ problem?: string; unreadable?: string }> {
  const scheme = migrationScheme(o.config);
  if (scheme === undefined || scheme.repo.toLowerCase() !== o.repo.toLowerCase()) return {};
  let use: MigrationUse;
  let files: string[];
  try {
    files = await pullRequestFiles(o.gh, o.repo, o.pr);
    // Only a pull request that touches the folder needs the rest of the picture.
    if (!files.some((f) => migrationEntryOf(f, scheme.dir) !== undefined)) return {};
    use = await readMigrationUse(o.gh, scheme);
  } catch (e) {
    return { unreadable: (e as Error).message };
  }
  try {
    const reasons = updateRegister(
      o.root,
      (reg) => {
        syncLanded(reg, use, o.now);
        return migrationCollisions({ scheme, use, reg, pr: o.pr, files, holder: o.holder });
      },
      { now: o.now },
    );
    return reasons.length === 0 ? {} : { problem: `migration number: ${reasons.join('; ')}` };
  } catch (e) {
    return { unreadable: (e as Error).message };
  }
}

/** The `studio doctor` line for the register; no network. */
export function registerDoctorLine(config: StudioConfig | undefined, root: string): string {
  const scheme = config === undefined ? undefined : migrationScheme(config);
  if (scheme === undefined) return 'not configured (migrations in studio.yaml)';
  let reg: Register;
  try {
    reg = readRegister(root);
  } catch (e) {
    return `unreadable: ${(e as Error).message}`;
  }
  const count = (s: Reservation['status']) => reg.reservations.filter((r) => r.status === s).length;
  return `${scheme.dir} in ${scheme.repo}, ${count('reserved')} reserved, ${count('landed')} landed`;
}
