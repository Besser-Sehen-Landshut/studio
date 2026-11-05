import { createHash } from 'node:crypto';
import type {
  ClaimCommit,
  GitHubUser,
  OfferComment,
  OfferIssue,
  PullRequestFacts,
  WorkerHub,
} from '../src/worker-hub.js';

/** The numeric account id the fake gives a login: stable, and different per login. */
export const idOf = (login: string): number =>
  Number.parseInt(createHash('sha1').update(login.toLowerCase()).digest('hex').slice(0, 7), 16);

/** An accepted-worker entry of the owner config for a login of the fake. */
export const acceptEntry = (login: string): GitHubUser => ({ login, id: idOf(login) });

/**
 * GitHub as the lead and workers see it, in memory: issues with their author (locked offers take
 * comments from collaborators only), claim refs that are created once and move only from the
 * commit they point to (as a fast-forward does), commits dated by the shared clock, comments with
 * the account and association GitHub sets, branches and pull requests. One `hubAs(login)` per
 * identity; logins in `outsiders` have no write access.
 */
export function fakeGitHub(now: () => Date) {
  const issues = new Map<number, OfferIssue & { labels: string[]; locked: boolean }>();
  const refs = new Map<string, string>();
  const commits = new Map<
    string,
    { message: string; files: Record<string, string>; parents: string[]; at: string }
  >();
  /** Comments per offer, as GitHub keeps them; tests may edit one (`updatedAt`). */
  const comments = new Map<number, OfferComment[]>();
  const branches = new Map<string, string>();
  const prs = new Map<number, PullRequestFacts>();
  const outsiders = new Set<string>();
  /** Offers whose comments GitHub returns only in part (more pages than Studio reads). */
  const cut = new Set<number>();
  const calls: string[] = [];
  let nextIssue = 30;
  let nextComment = 900;
  let nextPr = 7;
  let seq = 0;
  const association = (login: string) =>
    outsiders.has(login) ? 'NONE' : login === 'lead-user' ? 'OWNER' : 'COLLABORATOR';
  const postComment = (n: number, login: string, body: string) => {
    const issue = issues.get(n);
    if (issue?.locked && association(login) === 'NONE') {
      throw new Error('GitHub: commenting on an offer failed (HTTP 403)');
    }
    const at = now().toISOString();
    const list = comments.get(n) ?? [];
    list.push({
      id: nextComment++,
      login,
      userId: idOf(login),
      association: association(login),
      body,
      createdAt: at,
      updatedAt: at,
    });
    comments.set(n, list);
    calls.push(`${login} comment #${n}: ${body}`);
  };
  const hubAs = (login: string): WorkerHub => ({
    async user() {
      return { login, id: idOf(login) };
    },
    async login() {
      return login;
    },
    async openOffer(_repo, title, body, labels) {
      const n = nextIssue++;
      issues.set(n, {
        number: n,
        title,
        body,
        author: login,
        edited: false,
        open: true,
        labels,
        locked: true,
      });
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
      return { sha, message: c.message, committedAt: c.at, parents: c.parents };
    },
    async claimCommit(_repo, sha) {
      const c = commits.get(sha);
      return c === undefined
        ? undefined
        : { sha, message: c.message, committedAt: c.at, parents: c.parents };
    },
    async commentOffer(_repo, n, body) {
      postComment(n, login, body);
    },
    async offerComments(_repo, n) {
      return { comments: [...(comments.get(n) ?? [])], complete: !cut.has(n) };
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
    async openPullRequests(_repo, branch) {
      return [...prs.values()].filter((p) => p.branch === branch && p.state === 'OPEN');
    },
    async createPullRequest(repo, o) {
      const number = nextPr++;
      prs.set(number, {
        number,
        author: login,
        authorId: idOf(login),
        branch: o.head,
        head: branches.get(o.head) ?? 'c'.repeat(40),
        base: o.base,
        headRepo: repo,
        state: 'OPEN',
      });
      calls.push(`${login} pr #${number}`);
      return number;
    },
    async editPullRequestBody(_repo, pr) {
      calls.push(`${login} edit pr #${pr}`);
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
  return { hubAs, issues, refs, commits, branches, prs, calls, plant, comments, outsiders, cut };
}
