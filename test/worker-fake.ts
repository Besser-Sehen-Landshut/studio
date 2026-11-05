import { createHash } from 'node:crypto';
import type {
  ClaimCommit,
  OfferComment,
  OfferIssue,
  PullRequestFacts,
  WorkerHub,
} from '../src/worker-hub.js';

/**
 * GitHub as the lead and workers see it, in memory: issues with their author, claim refs that
 * are created once and move only from the commit they point to (as a fast-forward does), commits
 * dated by the shared clock, branches and pull requests. One `hubAs(login)` per identity.
 */
export function fakeGitHub(now: () => Date) {
  const issues = new Map<number, OfferIssue & { labels: string[] }>();
  const refs = new Map<string, string>();
  const commits = new Map<
    string,
    {
      message: string;
      files: Record<string, string>;
      parents: string[];
      at: string;
    }
  >();
  /** Comments per offer, as GitHub keeps them; tests may edit one (`updatedAt`). */
  const comments = new Map<number, OfferComment[]>();
  let nextComment = 900;
  const branches = new Map<string, string>();
  const prs = new Map<number, PullRequestFacts>();
  const calls: string[] = [];
  let nextIssue = 30;
  let seq = 0;
  const hubAs = (login: string): WorkerHub => ({
    async login() {
      return login;
    },
    async openOffer(_repo, title, body, labels) {
      const n = nextIssue++;
      issues.set(n, { number: n, title, body, author: login, edited: false, open: true, labels });
      calls.push(`${login} open #${n}`);
      return n;
    },
    async closeOffer(_repo, n, comment) {
      const i = issues.get(n);
      if (i) i.open = false;
      calls.push(`${login} close #${n}: ${comment}`);
    },
    async listOffers() {
      return [...issues.values()].filter((i) => i.open && i.labels.includes('studio-offer'));
    },
    async offer(_repo, n) {
      return issues.get(n);
    },
    async readClaim(_repo, item): Promise<ClaimCommit | undefined> {
      const sha = refs.get(item);
      if (sha === undefined) return undefined;
      const c = commits.get(sha);
      if (c === undefined) throw new Error('dangling claim');
      return {
        sha,
        message: c.message,
        committedAt: c.at,
        parents: c.parents,
      };
    },
    async claimCommit(_repo, sha) {
      const c = commits.get(sha);
      return c === undefined
        ? undefined
        : { sha, message: c.message, committedAt: c.at, parents: c.parents };
    },
    async commentOffer(_repo, n, body) {
      const at = now().toISOString();
      const list = comments.get(n) ?? [];
      list.push({ id: nextComment++, login, body, createdAt: at, updatedAt: at });
      comments.set(n, list);
      calls.push(`${login} comment #${n}: ${body}`);
    },
    async offerComments(_repo, n) {
      return [...(comments.get(n) ?? [])];
    },
    async writeClaim(_repo, item, o) {
      const sha = createHash('sha1').update(`${seq++}:${o.message}`).digest('hex');
      commits.set(sha, {
        message: o.message,
        files: o.files,
        parents: o.parent === undefined ? [] : [o.parent],
        at: now().toISOString(),
      });
      const tip = refs.get(item);
      if (o.parent === undefined ? tip !== undefined : tip !== o.parent) return { ok: false };
      refs.set(item, sha);
      calls.push(`${login} claim ${item}: ${o.message.split('\n')[0]}`);
      return { ok: true, sha };
    },
    async claimFile(_repo, sha, path) {
      return commits.get(sha)?.files[path];
    },
    async deleteClaim(_repo, item) {
      refs.delete(item);
      calls.push(`${login} delete claim ${item}`);
    },
    async branchHead(_repo, branch) {
      return branches.get(branch);
    },
    async pullRequest(_repo, pr) {
      return prs.get(pr);
    },
  });
  /**
   * A claim commit someone wrote straight to the ref, as any account with contents write can,
   * with whatever author e-mail and dates they like: nothing about it says who wrote it.
   */
  const plant = (item: string, message: string, o: { at?: string } = {}): string => {
    const sha = createHash('sha1').update(`${seq++}:planted:${message}`).digest('hex');
    const tip = refs.get(item);
    commits.set(sha, {
      message,
      files: {},
      parents: tip === undefined ? [] : [tip],
      at: o.at ?? now().toISOString(),
    });
    refs.set(item, sha);
    return sha;
  };
  return { hubAs, issues, refs, commits, branches, prs, calls, plant, comments };
}
