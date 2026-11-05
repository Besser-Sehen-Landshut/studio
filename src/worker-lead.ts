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
import { type ClaimCommit, OFFER_LABEL, type WorkerHub } from './worker-hub.js';
import { type OfferRecord, readWorkers, type SeenClaim, updateWorkers } from './worker-state.js';

/** The pane's prefix for an item that runs on a worker: `tick` holds it with this reason. */
export const WORKER_WAIT = 'worker: ';

/** The crew name the board shows for an item on a worker. */
export const workerCrewName = (label: string): string => `worker:${label}`;

export type { OfferRecord, SeenClaim, WorkerRun, WorkersState } from './worker-state.js';
export { readWorkers, updateWorkers, WORKERS_FILE, WORKERS_LOCK } from './worker-state.js';

/**
 * Opens the offer of a planned item, or finds the open one an earlier tick made (a tick cut short
 * between the issue and the board). Returns the issue number.
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
  const mine = open.find((i) => i.title === title && i.author === o.lead && !i.edited);
  const known = mine === undefined ? undefined : parseOffer(mine.title, mine.body);
  if (mine !== undefined && known !== undefined) return { offer: mine.number, nonce: known.nonce };
  const nonce = randomBytes(16).toString('hex');
  const offer = await o.hub.openOffer(o.repo, title, renderOffer(o.item, o.lead, o.now, nonce), [
    OFFER_LABEL,
    `studio-runs-on:${label}`,
  ]);
  return { offer, nonce };
}

/** Longest claim chain the lead walks back to the commit that started an attempt. */
const MAX_CHAIN = 500;

/**
 * Who made a claim, proven by GitHub rather than by the claim. The ref is only the lock: the
 * lead walks back from its tip to the commit that started this attempt (state `claimed`; every
 * commit on the way names the same worker, offer and attempt), and takes the first unedited
 * comment on the offer naming that commit and the offer's nonce. Its author, set by GitHub from
 * the token that posted it, must be the claim's worker and accepted for the label.
 * `warnings` are claim comments that do not count: from accounts not accepted, edited ones, a
 * second claimer of the same commit, another nonce. The lead hears of each.
 */
export async function proveClaim(o: {
  hub: WorkerHub;
  repo: string;
  record: OfferRecord;
  tip: ClaimCommit;
  claim: Claim;
  accepted: readonly string[];
}): Promise<
  { ok: true; anchor: string; warnings: string[] } | { ok: false; line: string; warnings: string[] }
> {
  const { claim, record } = o;
  const lower = (s: string) => s.toLowerCase();
  const warnings: string[] = [];
  const nonce = record.nonce;
  if (nonce === undefined) return { ok: false, line: 'its offer has no nonce on record', warnings };
  // Back to the start of this attempt.
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
  const comments = (await o.hub.offerComments(o.repo, record.offer)).flatMap((c) => {
    const p = parseClaimComment(c.body);
    return p === undefined ? [] : [{ ...c, ...p }];
  });
  comments.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id);
  const accepted = o.accepted.map(lower);
  for (const c of comments) {
    const who = c.login.replace(/[^A-Za-z0-9-[\]]/g, '?');
    if (c.updatedAt !== c.createdAt)
      warnings.push(`claim comment ${c.id} by ${who} was edited and does not count`);
    else if (!accepted.includes(lower(c.login)))
      warnings.push(`claim comment ${c.id} by ${who}, who is not accepted for ${record.label}`);
    else if (c.nonce !== nonce)
      warnings.push(`claim comment ${c.id} by ${who} names another offer`);
  }
  const valid = comments.filter(
    (c) => c.updatedAt === c.createdAt && c.nonce === nonce && c.sha === anchor,
  );
  const first = valid[0];
  if (first === undefined) {
    return {
      ok: false,
      line: `no claim comment on #${record.offer} proves who claimed it (${anchor.slice(0, 12)})`,
      warnings,
    };
  }
  for (const later of valid.slice(1)) {
    warnings.push(
      `claim comment ${later.id} by ${later.login.replace(/[^A-Za-z0-9-[\]]/g, '?')} names a commit already claimed`,
    );
  }
  if (lower(first.login) !== lower(claim.worker)) {
    return {
      ok: false,
      line: `the claim names ${claim.worker}, but ${first.login.replace(/[^A-Za-z0-9-[\]]/g, '?')} commented it first`,
      warnings,
    };
  }
  if (!accepted.includes(lower(first.login))) {
    return {
      ok: false,
      line: `claimed by ${claim.worker}, who is not accepted for the label ${record.label} (workers.accept in the owner config)`,
      warnings,
    };
  }
  return { ok: true, anchor, warnings };
}

/** What `followClaim` found for one item. */
export type Follow =
  /** Nobody claimed it yet, or the claim runs: `tick` holds it with this line. */
  | { kind: 'waiting'; line: string; claimed: boolean }
  /** The claim carries the report: collect it. */
  | { kind: 'done'; claim: Claim; sha: string }
  /** The worker gave the item up without a report. */
  | { kind: 'released'; claim: Claim; sha: string; reason: string }
  /** Needs the lead: an unknown worker, a lost claim, the last attempt expired. */
  | { kind: 'lead'; line: string };

/**
 * Reads the claim of one offered item and says what it means. Only a worker listed for the label
 * under `workers.accept` in the owner config counts; its claim must name this offer.
 */
export async function followClaim(o: {
  hub: WorkerHub;
  repo: string;
  item: WorkItem;
  record: OfferRecord;
  ownerConfig: OwnerConfig;
  now: Date;
}): Promise<{ follow: Follow; seen?: SeenClaim; warnings?: string[] }> {
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
    accepted: o.ownerConfig.workers?.accept[record.label] ?? [],
  });
  if (!proof.ok) {
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
    ...(claim.pr === undefined ? {} : { pr: claim.pr }),
  };
  if (claim.state === 'done') {
    return { follow: { kind: 'done', claim, sha: read.sha }, seen, warnings };
  }
  if (claim.state === 'released') {
    return {
      follow: {
        kind: 'released',
        claim,
        sha: read.sha,
        reason: claim.reason ?? 'no reason given',
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
 * Counts an ended worker run once: on the item (workers.json) and in the day's cost ledger, under
 * the key `<id>@<claim time>`. The usage is what the worker reported.
 */
export async function recordWorkerRun(o: {
  stateRoot: string;
  item: string;
  claim: Claim;
  at: string;
  now: Date;
  timezone?: string;
}): Promise<void> {
  const usage = toRunUsage(o.claim.usage);
  if (usage === undefined) return;
  const key = `${o.item}@${new Date(Date.parse(o.at)).toISOString()}`;
  const added = updateWorkers(o.stateRoot, (s) => {
    const runs = s.runs[o.item] ?? [];
    if (runs.some((r) => r.key === key)) return false;
    s.runs[o.item] = [...runs, { key, worker: o.claim.worker, usage }];
    return true;
  });
  if (!added) return;
  await recordLedgerRun(o.stateRoot, key, o.item, usage, o.now, o.timezone);
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
