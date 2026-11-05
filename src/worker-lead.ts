// The lead's side of workers on other machines. An item with `runs_on: <label>` never gets a local
// crew: `tick` offers it (an issue on the primary repository), follows its claim ref, and collects
// it once the claim carries the report, through the same `collect` as a local crew. What the lead
// knows about each offer lives in `workers.json` in the state root, changed under `workers.lock`.
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
}): Promise<number> {
  const label = o.item.runsOn;
  if (label === undefined) throw new Error(`${o.item.id} names no runs_on label`);
  const title = offerTitle(o.item.id, label);
  const open = await o.hub.listOffers(o.repo);
  const mine = open.find((i) => i.title === title && i.author === o.lead);
  if (mine !== undefined) return mine.number;
  return o.hub.openOffer(o.repo, title, renderOffer(o.item, o.lead, o.now), [
    OFFER_LABEL,
    `studio-runs-on:${label}`,
  ]);
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
}): Promise<{ follow: Follow; seen?: SeenClaim }> {
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
  const foreign = claimIdentityProblem(
    read,
    claim,
    o.ownerConfig.workers?.accept[record.label] ?? [],
    record.label,
  );
  if (foreign !== undefined) {
    return { follow: { kind: 'lead', line: `${item.id}: ${foreign}; nothing of it counts` } };
  }
  if (claim.label !== record.label || claim.offer !== record.offer) {
    return {
      follow: {
        kind: 'lead',
        line: `the claim of ${item.id} names offer #${claim.offer} for ${claim.label}, not #${record.offer} for ${record.label}`,
      },
    };
  }
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
  if (claim.state === 'done') return { follow: { kind: 'done', claim, sha: read.sha }, seen };
  if (claim.state === 'released') {
    return {
      follow: {
        kind: 'released',
        claim,
        sha: read.sha,
        reason: claim.reason ?? 'no reason given',
      },
      seen,
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
    };
  }
  return {
    follow: {
      kind: 'waiting',
      claimed: true,
      line: `${WORKER_WAIT}on ${claim.worker} (${record.label}), heartbeat ${ago} min ago`,
    },
    seen,
  };
}

/**
 * Why a claim counts for nothing, or undefined. Its `worker` field is written by whoever wrote the
 * commit, so it counts only when GitHub verified the commit and attributes it to that very account,
 * and that account is accepted for the label.
 */
export function claimIdentityProblem(
  read: ClaimCommit,
  claim: Claim,
  accepted: readonly string[],
  label: string,
): string | undefined {
  const who = claim.worker.toLowerCase();
  if (!accepted.some((a) => a.toLowerCase() === who)) {
    return `claimed by ${claim.worker}, who is not accepted for the label ${label} (workers.accept in the owner config)`;
  }
  if (!read.verified) {
    return `the claim names ${claim.worker}, but GitHub did not verify its commit`;
  }
  if (read.login === undefined || read.login.toLowerCase() !== who) {
    const by =
      read.login === undefined ? 'no single account' : read.login.replace(/[^A-Za-z0-9-]/g, '?');
    return `the claim names ${claim.worker}, but GitHub attributes its commit to ${by}`;
  }
  return undefined;
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
