// The lead's side of workers on other machines. An item with `runs_on: <label>` never gets a local
// crew: `tick` offers it (an issue on the primary repository), follows its claim ref, and collects
// it once the claim carries the report, through the same `collect` as a local crew. What the lead
// knows about each offer lives in `workers.json` in the state root, changed under `workers.lock`.
import { randomBytes } from 'node:crypto';
import type { WorkItem } from './board.js';
import type { OwnerConfig } from './config.js';
import { recordLedgerRun } from './costs.js';
import {
  type Claim,
  claimExpired,
  MAX_CLAIM_ATTEMPTS,
  minutesSince,
  offerTitle,
  parseClaim,
  parseClaimComment,
  parseOffer,
  renderOffer,
  toRunUsage,
} from './worker-claim.js';
import { type ClaimCommit, type GitHubUser, OFFER_LABEL, type WorkerHub } from './worker-hub.js';
import { type OfferRecord, readWorkers, type SeenClaim, updateWorkers } from './worker-state.js';

/** The pane's prefix for an item that runs on a worker: `tick` holds it with this reason. */
export const WORKER_WAIT = 'worker: ';

/** The crew name the board shows for an item on a worker. */
export const workerCrewName = (label: string): string => `worker:${label}`;

export type { OfferRecord, SeenClaim, WorkerRun, WorkersState } from './worker-state.js';
export { readWorkers, updateWorkers, WORKERS_FILE, WORKERS_LOCK } from './worker-state.js';

/** An accepted worker account: its login and the numeric id GitHub keeps when a login changes. */
export type AcceptedWorker = GitHubUser;

/** Associations of accounts with write access: only their claim comments are read at all. */
const COMMENTERS = ['OWNER', 'MEMBER', 'COLLABORATOR'];

const shown = (login: string): string => login.replace(/[^A-Za-z0-9-[\]]/g, '?');

/**
 * Why the accepted workers of a label cannot be trusted with this lead's crew token, or
 * undefined: a worker account that is also the crew token's account would let any crew of the
 * lead act as that worker.
 */
export function acceptProblem(
  accepted: readonly AcceptedWorker[],
  crew: GitHubUser | undefined,
  label: string,
): string | undefined {
  if (crew === undefined) return undefined;
  const same = accepted.find((a) => a.id === crew.id);
  return same === undefined
    ? undefined
    : `workers.accept for ${label} lists ${shown(same.login)}, the account of the lead's crew token: a crew could claim as that worker; give the worker an account of its own`;
}

/**
 * Opens the offer of a planned item, or finds the open one an earlier tick made (a tick cut short
 * between the issue and the board). Returns the issue number and the offer's nonce.
 */
export async function openOffer(o: {
  hub: WorkerHub;
  repo: string;
  item: WorkItem;
  lead: string;
  now: Date;
}): Promise<{ offer: number; nonce: string }> {
  const label = o.item.runsOn;
  if (label === undefined) throw new Error(`${o.item.id} names no runs_on label`);
  const title = offerTitle(o.item.id, label);
  const open = await o.hub.listOffers(o.repo);
  const me = await o.hub.user();
  // The lead is told by its numeric id; the login only decorates the offer.
  const mine = open.find((i) => i.title === title && i.authorId === me.id && !i.edited);
  const known = mine === undefined ? undefined : parseOffer(mine.title, mine.body);
  if (mine !== undefined && known !== undefined) {
    // An offer an earlier tick opened may have been cut short before its lock: lock it again.
    await o.hub.lockOffer(o.repo, mine.number);
    return { offer: mine.number, nonce: known.nonce };
  }
  const nonce = randomBytes(16).toString('hex');
  const offer = await o.hub.openOffer(o.repo, title, renderOffer(o.item, o.lead, o.now, nonce), [
    OFFER_LABEL,
    `studio-runs-on:${label}`,
  ]);
  return { offer, nonce };
}

/** Longest claim chain the lead walks back to the commit that started an attempt. */
const MAX_CHAIN = 500;

type Proof =
  | { ok: true; anchor: string; worker: AcceptedWorker; warnings: string[] }
  /** `grace`: the comment may only be late (written ref, comment not there yet). */
  | { ok: false; line: string; warnings: string[]; grace?: true };

/** How long a claim commit may wait for the comment that proves or announces it. */
export const COMMENT_GRACE_MS = 2 * 60_000;

/**
 * Who made a claim, proven by GitHub rather than by the claim. The ref is only the lock: the
 * lead walks back from its tip to the commit that started this attempt (state `claimed`; below
 * the tip only heartbeats, all naming the same worker, offer and attempt; a walk the lead did
 * before ends at the tip it saw then). Of the offer's comments only unedited ones by accounts
 * with write access (OWNER, MEMBER, COLLABORATOR) that are accepted for the label, by numeric id,
 * and name this offer's nonce are read; anyone else's is a warning, never a decision. The first
 * of them naming the start commit must be the claimed worker's, and a tip in another state than
 * a heartbeat counts only when that worker named the tip as well. When GitHub returned fewer
 * pages than exist, nothing is decided.
 */
export async function proveClaim(o: {
  hub: WorkerHub;
  repo: string;
  record: OfferRecord;
  tip: ClaimCommit;
  claim: Claim;
  accepted: readonly AcceptedWorker[];
}): Promise<Proof> {
  const { claim, record } = o;
  const lower = (s: string) => s.toLowerCase();
  const warnings: string[] = [];
  const nonce = record.nonce;
  if (nonce === undefined) return { ok: false, line: 'its offer has no nonce on record', warnings };
  const worker = o.accepted.find((a) => lower(a.login) === lower(claim.worker));
  if (worker === undefined) {
    return {
      ok: false,
      line: `claimed by ${claim.worker}, who is not accepted for the label ${record.label} (workers.accept in the owner config)`,
      warnings,
    };
  }
  // Back to the start of this attempt, or to the tip a walk before already proved.
  const cache =
    record.claim?.anchor !== undefined && record.claim.attempt === claim.attempt
      ? { tip: record.claim.sha, anchor: record.claim.anchor }
      : undefined;
  let cur: ClaimCommit | undefined = o.tip;
  let anchor: string | undefined;
  for (let i = 0; i < MAX_CHAIN && cur !== undefined; i++) {
    const c = parseClaim(cur.message);
    if (
      c === undefined ||
      c.item !== claim.item ||
      c.offer !== claim.offer ||
      c.attempt !== claim.attempt ||
      lower(c.worker) !== lower(claim.worker)
    ) {
      return {
        ok: false,
        line: `its chain holds a commit that is not this claim's (${cur.sha.slice(0, 12)})`,
        warnings,
      };
    }
    if (c.state === 'claimed') {
      anchor = cur.sha;
      break;
    }
    if (cur.sha !== o.tip.sha && c.state !== 'alive') {
      return {
        ok: false,
        line: `its chain holds a ${c.state} commit below its tip (${cur.sha.slice(0, 12)})`,
        warnings,
      };
    }
    if (cache !== undefined && cur.sha !== o.tip.sha && cur.sha === cache.tip) {
      anchor = cache.anchor;
      break;
    }
    const parent: string | undefined = cur.parents[0];
    cur = parent === undefined ? undefined : await o.hub.claimCommit(o.repo, parent);
  }
  if (anchor === undefined) {
    return {
      ok: false,
      line: 'its chain does not lead back to the commit that claimed it',
      warnings,
    };
  }
  const read = await o.hub.offerComments(o.repo, record.offer);
  if (!read.complete) {
    return {
      ok: false,
      line: `#${record.offer} has more comments than Studio reads; who claimed it cannot be told`,
      warnings,
    };
  }
  const comments = read.comments.flatMap((c) => {
    const p = parseClaimComment(c.body);
    return p === undefined ? [] : [{ ...c, ...p }];
  });
  comments.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id);
  const ids = new Set(o.accepted.map((a) => a.id));
  const counted = comments.filter((c) => {
    const who = shown(c.login);
    if (c.updatedAt !== c.createdAt) {
      warnings.push(`claim comment ${c.id} by ${who} was edited and does not count`);
    } else if (!COMMENTERS.includes(c.association)) {
      warnings.push(`claim comment ${c.id} by ${who}, who has no write access, does not count`);
    } else if (!ids.has(c.userId)) {
      warnings.push(`claim comment ${c.id} by ${who}, who is not accepted for ${record.label}`);
    } else if (c.nonce !== nonce) {
      warnings.push(`claim comment ${c.id} by ${who} names another offer`);
    } else return true;
    return false;
  });
  const valid = counted.filter((c) => c.sha === anchor);
  const first = valid[0];
  if (first === undefined) {
    return {
      ok: false,
      line: `no claim comment on #${record.offer} proves who claimed it (${anchor.slice(0, 12)})`,
      warnings,
      grace: true,
    };
  }
  for (const later of valid.slice(1)) {
    warnings.push(
      `claim comment ${later.id} by ${shown(later.login)} names a commit already claimed`,
    );
  }
  if (first.userId !== worker.id) {
    return {
      ok: false,
      line: `the claim names ${claim.worker}, but ${shown(first.login)} commented it first`,
      warnings,
    };
  }
  // A heartbeat changes nothing and may stay unannounced; any other state at the tip counts only
  // when the proven claimant named that very commit in a comment of its own.
  if (o.tip.sha !== anchor && claim.state !== 'alive') {
    if (!counted.some((c) => c.sha === o.tip.sha && c.userId === worker.id)) {
      return {
        ok: false,
        line: `its ${claim.state} commit ${o.tip.sha.slice(0, 12)} was not announced by ${claim.worker}`,
        warnings,
        grace: true,
      };
    }
  }
  return { ok: true, anchor, worker, warnings };
}

/** What `followClaim` found for one item. */
export type Follow =
  /** Nobody claimed it yet, or the claim runs: `tick` holds it with this line. */
  | { kind: 'waiting'; line: string; claimed: boolean }
  /** The claim carries the report: collect it. */
  | { kind: 'done'; claim: Claim; sha: string; worker: AcceptedWorker }
  /** The worker gave the item up without a report. */
  | { kind: 'released'; claim: Claim; sha: string; reason: string; worker: AcceptedWorker }
  /** Needs the lead: an unknown worker, a lost claim, the last attempt expired. */
  | { kind: 'lead'; line: string };

/** The accepted workers of a label, from the owner config. */
export const acceptedFor = (ownerConfig: OwnerConfig, label: string): AcceptedWorker[] =>
  ownerConfig.workers?.accept[label] ?? [];

/**
 * Reads the claim of one offered item and says what it means. Only a worker accepted for the label
 * under `workers.accept` in the owner config counts (`proveClaim`); its claim must name this offer.
 */
export async function followClaim(o: {
  hub: WorkerHub;
  repo: string;
  item: WorkItem;
  record: OfferRecord;
  ownerConfig: OwnerConfig;
  now: Date;
}): Promise<{
  follow: Follow;
  seen?: SeenClaim;
  /** The grace window of an unproven tip: kept in the offer record, never reset by a new tip. */
  grace?: { attempt: number; since: string };
  warnings?: string[];
}> {
  const { item, record } = o;
  const read = await o.hub.readClaim(o.repo, item.id);
  if (read === undefined) {
    if (record.claim !== undefined) {
      return {
        follow: {
          kind: 'lead',
          line: `the claim of ${item.id} by ${record.claim.worker} is gone from GitHub; withdraw it with studio stop ${item.id} --requeue, or drop it`,
        },
      };
    }
    return {
      follow: {
        kind: 'waiting',
        claimed: false,
        line: `${WORKER_WAIT}offered to ${record.label} (#${record.offer}), not claimed yet`,
      },
    };
  }
  const claim = parseClaim(read.message);
  if (claim === undefined || claim.item !== item.id) {
    return {
      follow: {
        kind: 'lead',
        line: `the claim ref of ${item.id} holds no claim Studio can read; look at refs/studio/claims/${item.id}`,
      },
    };
  }
  if (claim.label !== record.label || claim.offer !== record.offer) {
    return {
      follow: {
        kind: 'lead',
        line: `the claim of ${item.id} names offer #${claim.offer} for ${claim.label}, not #${record.offer} for ${record.label}`,
      },
    };
  }
  const proof = await proveClaim({
    hub: o.hub,
    repo: o.repo,
    record,
    tip: read,
    claim,
    accepted: acceptedFor(o.ownerConfig, record.label),
  });
  if (!proof.ok) {
    // A comment may just be late: one grace window per item and attempt, counted from the first
    // time the lead saw an unproven tip of that attempt. A new tip never restarts it.
    if (proof.grace === true) {
      const g = record.grace?.attempt === claim.attempt ? record.grace : undefined;
      const since =
        g !== undefined && !Number.isNaN(Date.parse(g.since)) ? g.since : o.now.toISOString();
      if (o.now.getTime() - Date.parse(since) <= COMMENT_GRACE_MS) {
        return {
          follow: {
            kind: 'waiting',
            claimed: false,
            line: `${WORKER_WAIT}${claim.worker}'s ${claim.state} commit awaits its comment`,
          },
          grace: { attempt: claim.attempt, since },
          warnings: proof.warnings,
        };
      }
    }
    return {
      follow: { kind: 'lead', line: `${item.id}: ${proof.line}; nothing of it counts` },
      warnings: proof.warnings,
    };
  }
  const warnings = proof.warnings;
  // The lead's own clock: the first time it saw this commit is the heartbeat it knows of.
  const at =
    record.claim?.sha === read.sha && !Number.isNaN(Date.parse(record.claim.at))
      ? record.claim.at
      : o.now.toISOString();
  const seen: SeenClaim = {
    sha: read.sha,
    worker: claim.worker,
    attempt: claim.attempt,
    state: claim.state,
    at,
    anchor: proof.anchor,
    ...(claim.pr === undefined ? {} : { pr: claim.pr }),
  };
  if (claim.state === 'done') {
    return { follow: { kind: 'done', claim, sha: read.sha, worker: proof.worker }, seen, warnings };
  }
  if (claim.state === 'released') {
    return {
      follow: {
        kind: 'released',
        claim,
        sha: read.sha,
        reason: claim.reason ?? 'no reason given',
        worker: proof.worker,
      },
      seen,
      warnings,
    };
  }
  const ago = minutesSince(at, o.now);
  if (claimExpired(claim, at, o.now)) {
    if (claim.attempt >= MAX_CLAIM_ATTEMPTS) {
      return {
        follow: {
          kind: 'lead',
          line: `the claim of ${item.id} by ${claim.worker} expired (no heartbeat for ${ago} min) after ${claim.attempt} attempts; look at the worker, then studio stop ${item.id} --requeue or drop it`,
        },
        seen,
        warnings,
      };
    }
    return {
      follow: {
        kind: 'waiting',
        claimed: true,
        line: `${WORKER_WAIT}claim of ${claim.worker} expired (no heartbeat for ${ago} min); another worker of ${record.label} may take it over`,
      },
      seen,
      warnings,
    };
  }
  return {
    follow: {
      kind: 'waiting',
      claimed: true,
      line: `${WORKER_WAIT}on ${claim.worker} (${record.label}), heartbeat ${ago} min ago`,
    },
    seen,
    warnings,
  };
}

/**
 * Counts an ended worker run once, under the key `<id>@<claim time>`: first in the day's cost
 * ledger, then on the item (workers.json), so a ledger that is busy or unreadable never loses the
 * run; the next tick tries again and the collect waits. The usage is what the worker reported; a
 * single run counts for at most the lowest daily cap (`cap`), so one report cannot stop a day.
 * Returns false when the ledger did not take it yet.
 */
export async function recordWorkerRun(o: {
  stateRoot: string;
  item: string;
  claim: Claim;
  at: string;
  now: Date;
  timezone?: string;
  cap?: number;
}): Promise<{ ok: boolean; clamped?: { reported: number; counted: number } }> {
  const reported = toRunUsage(o.claim.usage);
  if (reported === undefined) return { ok: true };
  const key = `${o.item}@${new Date(Date.parse(o.at)).toISOString()}`;
  if ((readWorkers(o.stateRoot).runs[o.item] ?? []).some((r) => r.key === key)) return { ok: true };
  const counted =
    o.cap !== undefined && reported.costUsd > o.cap ? { ...reported, costUsd: o.cap } : reported;
  if (!(await recordLedgerRun(o.stateRoot, key, o.item, counted, o.now, o.timezone))) {
    return { ok: false };
  }
  updateWorkers(o.stateRoot, (s) => {
    const runs = s.runs[o.item] ?? [];
    if (runs.some((r) => r.key === key)) return;
    s.runs[o.item] = [...runs, { key, worker: o.claim.worker, usage: counted }];
  });
  return counted === reported
    ? { ok: true }
    : { ok: true, clamped: { reported: reported.costUsd, counted: counted.costUsd } };
}

/** Closes the offer and removes the claim once the lead is done with the item. Best effort. */
export async function closeOffer(o: {
  hub: WorkerHub;
  repo: string;
  stateRoot: string;
  item: string;
  why: string;
}): Promise<string[]> {
  const errors: string[] = [];
  let record: OfferRecord | undefined;
  try {
    record = readWorkers(o.stateRoot).items[o.item];
  } catch (e) {
    errors.push((e as Error).message);
  }
  if (record !== undefined) {
    try {
      await o.hub.closeOffer(o.repo, record.offer, `Studio closed this offer: ${o.why}.`);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  try {
    await o.hub.deleteClaim(o.repo, o.item);
  } catch (e) {
    errors.push((e as Error).message);
  }
  if (errors.length === 0) {
    updateWorkers(o.stateRoot, (s) => {
      delete s.items[o.item];
    });
  }
  return errors;
}
