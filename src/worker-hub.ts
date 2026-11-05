// The GitHub side of workers on other machines: offers are issues the lead opens, claims are refs
// below `refs/studio/claims/` whose commits carry the claim and, at the end, the report. Nothing
// else is shared between the machines. The calls go through a transport: `gh` with the owner's
// login on the lead's machine, or in-process `fetch` with the worker's own token on a worker
// machine, so that token never sits in the environment of a child process while a crew runs.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Gh } from './ports.js';

/** The label every offer carries; workers list open issues with it. */
export const OFFER_LABEL = 'studio-offer';
/** Where a claim lives: one ref per item, outside branches and tags, so it starts no workflow. */
export const CLAIM_PREFIX = 'refs/studio/claims/';

/** A GitHub account: the numeric id stays when a login is renamed or reused. */
export interface GitHubUser {
  login: string;
  id: number;
}

/** An offer as GitHub shows it: who opened it and whether anyone edited it since. */
export interface OfferIssue {
  number: number;
  title: string;
  body: string;
  /** The login that opened the issue; GitHub sets it, no client can. */
  author: string;
  /** Its numeric account id: the lead is told by this, a login can be renamed and reused. */
  authorId: number;
  /** The login of the last edit, when the body was edited after it was opened. */
  editor?: string;
  editorId?: number;
  edited: boolean;
  open: boolean;
}

/**
 * A commit of a claim ref. The ref is only the lock: nothing in a commit, neither its content nor
 * its author, committer or signature, says who wrote it (GitHub matches authors by e-mail, and API
 * commits of a user token are unsigned). Who claimed is proven by a comment (`OfferComment`).
 */
export interface ClaimCommit {
  sha: string;
  message: string;
  /** The committer date in the commit. Writer-supplied: shown, never used for a lease. */
  committedAt: string;
  parents: string[];
}

/** A comment on an offer, as GitHub shows it: its author is the account that posted it. */
export interface OfferComment {
  id: number;
  /** `user.login` and `user.id`, set by GitHub from the token that posted it. */
  login: string;
  userId: number;
  /** `author_association`: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, ... */
  association: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequestFacts {
  number: number;
  author: string;
  authorId: number;
  branch: string;
  head: string;
  base: string;
  /** `owner/name` of the head repository; undefined when GitHub names none (a deleted fork). */
  headRepo?: string;
  state: string;
}

export interface WorkerHub {
  /** The account this hub acts as. */
  user(): Promise<GitHubUser>;
  login(): Promise<string>;
  /** Opens the offer and locks it, so only collaborators can comment on it. */
  openOffer(repo: string, title: string, body: string, labels: string[]): Promise<number>;
  /** Locks an offer so only collaborators can comment on it; idempotent. */
  lockOffer(repo: string, n: number): Promise<void>;
  /** Comments (Studio's own words) and closes. */
  closeOffer(repo: string, n: number, comment: string): Promise<void>;
  /** Open issues with the offer label, oldest first, every page. */
  listOffers(repo: string): Promise<OfferIssue[]>;
  offer(repo: string, n: number): Promise<OfferIssue | undefined>;
  readClaim(repo: string, item: string): Promise<ClaimCommit | undefined>;
  /** One commit of a claim chain, by its SHA; undefined when GitHub has none. */
  claimCommit(repo: string, sha: string): Promise<ClaimCommit | undefined>;
  /** Posts a comment on an offer, as this identity. */
  commentOffer(repo: string, n: number, body: string): Promise<void>;
  /** Every comment of an offer, oldest first; `complete: false` when the page cap was reached. */
  offerComments(repo: string, n: number): Promise<{ comments: OfferComment[]; complete: boolean }>;
  /**
   * Makes a commit with `files` and points the claim ref at it. Without `parent` the ref is
   * created and fails when it exists; with `parent` it moves only as a fast-forward from it, so a
   * claim another writer moved meanwhile is never overwritten. `ok: false` means someone else won.
   */
  writeClaim(
    repo: string,
    item: string,
    o: { message: string; files: Record<string, string>; parent?: string },
  ): Promise<{ ok: true; sha: string } | { ok: false }>;
  /** A file of a claim commit; undefined when it has none. */
  claimFile(repo: string, sha: string, path: string): Promise<string | undefined>;
  deleteClaim(repo: string, item: string): Promise<void>;
  /**
   * Puts the claim ref back from `from` (the commit the caller wrote) to `to` (the tip before it)
   * when, and only when, it still points at `from`; false when someone moved it meanwhile.
   */
  resetClaim(repo: string, item: string, o: { from: string; to: string }): Promise<boolean>;
  /** The head of a branch; undefined when it does not exist. */
  branchHead(repo: string, branch: string): Promise<string | undefined>;
  pullRequest(repo: string, pr: number): Promise<PullRequestFacts | undefined>;
  /** Open pull requests whose head is `branch` of the repository itself. */
  openPullRequests(repo: string, branch: string): Promise<PullRequestFacts[]>;
  createPullRequest(
    repo: string,
    o: { head: string; base: string; title: string; body: string },
  ): Promise<number>;
  editPullRequestBody(repo: string, pr: number, body: string): Promise<void>;
}

/** One HTTP exchange with the GitHub API; `status` 0 when there was no answer. */
export interface Transport {
  request(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }>;
}

const TIMEOUT_MS = 60_000;
const MAX_FILE = 1024 * 1024;
/** Comment pages read at most; a claim beyond them is never decided, the lead is asked. */
export const MAX_COMMENT_PAGES = 100;
const MAX_OFFER_PAGES = 20;

/** The HTTP status `gh api` names on a failed request, e.g. `(HTTP 422)`. */
export function httpStatus(stderr: string): number | undefined {
  const m = /\(HTTP (\d{3})\)/.exec(stderr) ?? /HTTP (\d{3})/.exec(stderr);
  return m ? Number(m[1]) : undefined;
}

export class HubError extends Error {
  readonly status: number | undefined;
  constructor(what: string, status: number | undefined) {
    // Fixed text only: GitHub's answer may quote what was sent.
    super(
      `GitHub: ${what} failed${status === undefined || status === 0 ? '' : ` (HTTP ${status})`}`,
    );
    this.name = 'HubError';
    this.status = status;
  }
}

/** `gh api` as the transport, with `token` for every call when given. Bodies go through a file. */
export function ghTransport(gh: Gh, token?: string): Transport {
  return {
    async request(method, path, body) {
      const run = (extra: string[]) =>
        gh.run(['api', '-X', method, path, ...extra], {
          timeoutMs: TIMEOUT_MS,
          ...(token === undefined ? {} : { token }),
        });
      let r: Awaited<ReturnType<typeof run>>;
      if (body === undefined) r = await run([]);
      else {
        const dir = mkdtempSync(join(tmpdir(), 'studio-hub-'));
        try {
          const file = join(dir, 'body.json');
          writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
          r = await run(['--input', file]);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
      if (r.code !== 0) return { status: httpStatus(r.stderr) ?? 0, json: null };
      try {
        return { status: 200, json: r.stdout.trim() === '' ? null : JSON.parse(r.stdout) };
      } catch {
        return { status: 0, json: null };
      }
    },
  };
}

/**
 * In-process HTTPS to api.github.com with `token`: no child process ever gets it. No redirect is
 * followed, so the token never goes to another host.
 */
export function fetchTransport(token: string, doFetch: typeof fetch = fetch): Transport {
  return {
    async request(method, path, body) {
      try {
        const r = await doFetch(`https://api.github.com/${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'studio-worker',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: 'error',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const text = await r.text();
        let json: unknown = null;
        try {
          json = text.trim() === '' ? null : JSON.parse(text);
        } catch {
          json = null;
        }
        return { status: r.status, json };
      } catch {
        return { status: 0, json: null };
      }
    },
  };
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ITEM_RE = /^[A-Z]+-\d+$/;
const SHA_RE = /^[0-9a-f]{40,64}$/;
const BRANCH_RE = /^studio\/[A-Z]+-\d+$/;

function assertRepo(repo: string): void {
  if (!REPO_RE.test(repo)) throw new Error(`invalid repository: ${JSON.stringify(repo)}`);
}
function assertItem(item: string): void {
  if (!ITEM_RE.test(item)) throw new Error(`invalid item id: ${JSON.stringify(item)}`);
}
function assertBranch(branch: string): void {
  if (!BRANCH_RE.test(branch)) throw new Error('invalid branch');
}

const ISSUES_QUERY = `query($owner: String!, $name: String!, $label: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 50, after: $after, states: OPEN, labels: [$label], orderBy: {field: CREATED_AT, direction: ASC}) {
      nodes { number title body state author { login ... on User { databaseId } } editor { login ... on User { databaseId } } lastEditedAt }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
const ISSUE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) { number title body state author { login ... on User { databaseId } } editor { login ... on User { databaseId } } lastEditedAt }
  }
}`;

type IssueNode = {
  number?: unknown;
  title?: unknown;
  body?: unknown;
  state?: unknown;
  author?: { login?: unknown; databaseId?: unknown } | null;
  editor?: { login?: unknown; databaseId?: unknown } | null;
  lastEditedAt?: unknown;
};

function issueOf(n: IssueNode | null | undefined): OfferIssue | undefined {
  if (!n || typeof n.number !== 'number' || typeof n.title !== 'string') return undefined;
  if (typeof n.body !== 'string' || typeof n.author?.login !== 'string') return undefined;
  if (typeof n.author.databaseId !== 'number') return undefined;
  const editor = typeof n.editor?.login === 'string' ? n.editor.login : undefined;
  const editorId = typeof n.editor?.databaseId === 'number' ? n.editor.databaseId : undefined;
  return {
    number: n.number,
    title: n.title,
    body: n.body,
    author: n.author.login,
    authorId: n.author.databaseId,
    ...(editor === undefined ? {} : { editor }),
    ...(editorId === undefined ? {} : { editorId }),
    edited: n.lastEditedAt !== null && n.lastEditedAt !== undefined,
    open: n.state === 'OPEN',
  };
}

type RestPull = {
  number?: unknown;
  user?: { login?: unknown; id?: unknown } | null;
  head?: { ref?: unknown; sha?: unknown; repo?: { full_name?: unknown } | null } | null;
  base?: { ref?: unknown } | null;
  state?: unknown;
};

function pullOf(j: RestPull | null | undefined): PullRequestFacts | undefined {
  if (
    !j ||
    typeof j.number !== 'number' ||
    typeof j.user?.login !== 'string' ||
    typeof j.user.id !== 'number' ||
    typeof j.head?.ref !== 'string' ||
    typeof j.head.sha !== 'string' ||
    typeof j.base?.ref !== 'string'
  ) {
    return undefined;
  }
  const headRepo = j.head.repo?.full_name;
  return {
    number: j.number,
    author: j.user.login,
    authorId: j.user.id,
    branch: j.head.ref,
    head: j.head.sha,
    base: j.base.ref,
    ...(typeof headRepo === 'string' ? { headRepo } : {}),
    state: typeof j.state === 'string' ? j.state.toUpperCase() : 'UNKNOWN',
  };
}

/** The worker hub over a transport. */
export function makeHub(t: Transport): WorkerHub {
  const must = async (what: string, method: string, path: string, body?: unknown) => {
    const r = await t.request(method, path, body);
    if (r.status < 200 || r.status > 299) throw new HubError(what, r.status);
    return r.json as Record<string, unknown> | null;
  };
  const graphql = async (what: string, query: string, variables: Record<string, unknown>) => {
    const j = (await must(what, 'POST', 'graphql', { query, variables })) as {
      data?: {
        repository?: {
          issues?: {
            nodes?: IssueNode[];
            pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
          };
          issue?: IssueNode | null;
        };
      };
    } | null;
    return j ?? {};
  };
  /** A commit by its SHA (git/commits); undefined on 404. */
  const commitOf = async (sha: string, repo: string): Promise<ClaimCommit | undefined> => {
    const r = await t.request('GET', `repos/${repo}/git/commits/${sha}`);
    if (r.status === 404) return undefined;
    if (r.status < 200 || r.status > 299) throw new HubError('reading a claim commit', r.status);
    const c = r.json as {
      message?: unknown;
      committer?: { date?: unknown };
      parents?: { sha?: unknown }[];
    } | null;
    if (typeof c?.message !== 'string' || typeof c.committer?.date !== 'string') {
      throw new HubError('reading a claim commit (incomplete)', undefined);
    }
    return {
      sha,
      message: c.message,
      committedAt: c.committer.date,
      parents: (c.parents ?? []).flatMap((p) => (typeof p.sha === 'string' ? [p.sha] : [])),
    };
  };
  const lock = async (repo: string, n: number) => {
    await must('locking an offer', 'PUT', `repos/${repo}/issues/${n}/lock`, {
      lock_reason: 'resolved',
    });
  };
  const split = (repo: string) => {
    assertRepo(repo);
    const [owner, name] = repo.split('/') as [string, string];
    return { owner, name };
  };
  const user = async (): Promise<GitHubUser> => {
    const j = await must('reading the account', 'GET', 'user');
    if (typeof j?.login !== 'string' || typeof j.id !== 'number') {
      throw new HubError('reading the account', undefined);
    }
    return { login: j.login, id: j.id };
  };
  return {
    user,
    async login() {
      return (await user()).login;
    },
    async openOffer(repo, title, body, labels) {
      assertRepo(repo);
      const j = await must('opening an offer', 'POST', `repos/${repo}/issues`, {
        title,
        body,
        labels,
      });
      const n = j?.number;
      if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
        throw new HubError('opening an offer (no issue number)', undefined);
      }
      // Locked at once: from here only collaborators can comment, so no one floods the claims.
      await lock(repo, n);
      return n;
    },
    async lockOffer(repo, n) {
      assertRepo(repo);
      await lock(repo, n);
    },
    async closeOffer(repo, n, comment) {
      assertRepo(repo);
      await must('commenting on an offer', 'POST', `repos/${repo}/issues/${n}/comments`, {
        body: comment,
      });
      await must('closing an offer', 'PATCH', `repos/${repo}/issues/${n}`, { state: 'closed' });
    },
    async listOffers(repo) {
      const { owner, name } = split(repo);
      const out: OfferIssue[] = [];
      let after: string | null = null;
      for (let page = 0; page < MAX_OFFER_PAGES; page++) {
        const j = await graphql('listing offers', ISSUES_QUERY, {
          owner,
          name,
          label: OFFER_LABEL,
          after,
        });
        const issues = j.data?.repository?.issues;
        for (const n of issues?.nodes ?? []) {
          const o = issueOf(n);
          if (o !== undefined) out.push(o);
        }
        const next = issues?.pageInfo;
        if (next?.hasNextPage !== true || typeof next.endCursor !== 'string') break;
        after = next.endCursor;
      }
      return out;
    },
    async offer(repo, n) {
      const { owner, name } = split(repo);
      const j = await graphql('reading an offer', ISSUE_QUERY, { owner, name, number: n });
      return issueOf(j.data?.repository?.issue);
    },
    async readClaim(repo, item) {
      assertRepo(repo);
      assertItem(item);
      const ref = await t.request('GET', `repos/${repo}/git/ref/studio/claims/${item}`);
      if (ref.status === 404) return undefined;
      if (ref.status < 200 || ref.status > 299) throw new HubError('reading a claim', ref.status);
      const sha = (ref.json as { object?: { sha?: unknown } } | null)?.object?.sha;
      if (typeof sha !== 'string' || !SHA_RE.test(sha)) {
        throw new HubError('reading a claim (no commit)', undefined);
      }
      const c = await commitOf(sha, repo);
      if (c === undefined) throw new HubError('reading a claim commit (missing)', 404);
      return c;
    },
    async claimCommit(repo, sha) {
      assertRepo(repo);
      if (!SHA_RE.test(sha)) throw new Error('invalid claim commit');
      return commitOf(sha, repo);
    },
    async commentOffer(repo, n, body) {
      assertRepo(repo);
      await must('commenting on an offer', 'POST', `repos/${repo}/issues/${n}/comments`, { body });
    },
    async offerComments(repo, n) {
      assertRepo(repo);
      const comments: OfferComment[] = [];
      for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
        const j = await must(
          'reading offer comments',
          'GET',
          `repos/${repo}/issues/${n}/comments?per_page=100&page=${page}`,
        );
        const list = Array.isArray(j) ? (j as unknown[]) : [];
        for (const raw of list) {
          const c = raw as {
            id?: unknown;
            user?: { login?: unknown; id?: unknown } | null;
            author_association?: unknown;
            body?: unknown;
            created_at?: unknown;
            updated_at?: unknown;
          };
          if (
            typeof c.id === 'number' &&
            typeof c.user?.login === 'string' &&
            typeof c.user.id === 'number' &&
            typeof c.body === 'string' &&
            typeof c.created_at === 'string' &&
            typeof c.updated_at === 'string'
          ) {
            comments.push({
              id: c.id,
              login: c.user.login,
              userId: c.user.id,
              association: typeof c.author_association === 'string' ? c.author_association : 'NONE',
              body: c.body,
              createdAt: c.created_at,
              updatedAt: c.updated_at,
            });
          }
        }
        if (list.length < 100) return { comments, complete: true };
      }
      return { comments, complete: false };
    },
    async writeClaim(repo, item, o) {
      assertRepo(repo);
      assertItem(item);
      const tree = await must('writing a claim tree', 'POST', `repos/${repo}/git/trees`, {
        tree: Object.entries(o.files).map(([path, content]) => ({
          path,
          mode: '100644',
          type: 'blob',
          content,
        })),
      });
      const treeSha = tree?.sha;
      if (typeof treeSha !== 'string') throw new HubError('writing a claim tree', undefined);
      const commit = await must('writing a claim commit', 'POST', `repos/${repo}/git/commits`, {
        message: o.message,
        tree: treeSha,
        parents: o.parent === undefined ? [] : [o.parent],
      });
      const sha = commit?.sha;
      if (typeof sha !== 'string' || !SHA_RE.test(sha)) {
        throw new HubError('writing a claim commit', undefined);
      }
      const moved =
        o.parent === undefined
          ? await t.request('POST', `repos/${repo}/git/refs`, {
              ref: `${CLAIM_PREFIX}${item}`,
              sha,
            })
          : await t.request('PATCH', `repos/${repo}/git/refs/studio/claims/${item}`, {
              sha,
              force: false,
            });
      if (moved.status >= 200 && moved.status <= 299) return { ok: true, sha };
      // 422: the ref exists (create) or the move is no fast-forward (update): someone else won.
      if (moved.status === 422) return { ok: false };
      throw new HubError('writing a claim', moved.status);
    },
    async claimFile(repo, sha, path) {
      assertRepo(repo);
      if (!SHA_RE.test(sha) || !/^[a-z.-]{1,40}$/.test(path)) throw new Error('invalid claim file');
      const r = await t.request('GET', `repos/${repo}/contents/${path}?ref=${sha}`);
      if (r.status === 404) return undefined;
      if (r.status < 200 || r.status > 299) throw new HubError('reading a claim file', r.status);
      const j = r.json as { content?: unknown; encoding?: unknown; size?: unknown } | null;
      if (typeof j?.content !== 'string' || j.encoding !== 'base64') return undefined;
      if (typeof j.size === 'number' && j.size > MAX_FILE) return undefined;
      return Buffer.from(j.content, 'base64').toString('utf8');
    },
    async deleteClaim(repo, item) {
      assertRepo(repo);
      assertItem(item);
      const r = await t.request('DELETE', `repos/${repo}/git/refs/studio/claims/${item}`);
      if ((r.status < 200 || r.status > 299) && r.status !== 404 && r.status !== 422) {
        throw new HubError('removing a claim', r.status);
      }
    },
    async resetClaim(repo, item, o) {
      assertRepo(repo);
      assertItem(item);
      if (!SHA_RE.test(o.from) || !SHA_RE.test(o.to)) throw new Error('invalid claim commit');
      const ref = await t.request('GET', `repos/${repo}/git/ref/studio/claims/${item}`);
      if (ref.status < 200 || ref.status > 299) throw new HubError('reading a claim', ref.status);
      const tip = (ref.json as { object?: { sha?: unknown } } | null)?.object?.sha;
      if (tip !== o.from) return false;
      // A rewind cannot be a fast-forward; it runs only while the ref still is the caller's own.
      await must('resetting a claim', 'PATCH', `repos/${repo}/git/refs/studio/claims/${item}`, {
        sha: o.to,
        force: true,
      });
      return true;
    },
    async branchHead(repo, branch) {
      assertRepo(repo);
      assertBranch(branch);
      const r = await t.request('GET', `repos/${repo}/git/ref/heads/${branch}`);
      if (r.status === 404) return undefined;
      if (r.status < 200 || r.status > 299) throw new HubError('reading a branch', r.status);
      const sha = (r.json as { object?: { sha?: unknown } } | null)?.object?.sha;
      return typeof sha === 'string' && SHA_RE.test(sha) ? sha : undefined;
    },
    async pullRequest(repo, pr) {
      assertRepo(repo);
      const r = await t.request('GET', `repos/${repo}/pulls/${pr}`);
      if (r.status < 200 || r.status > 299) return undefined;
      return pullOf(r.json as RestPull);
    },
    async openPullRequests(repo, branch) {
      const { owner } = split(repo);
      assertBranch(branch);
      const j = await must(
        'listing pull requests',
        'GET',
        `repos/${repo}/pulls?state=open&per_page=100&head=${encodeURIComponent(`${owner}:${branch}`)}`,
      );
      return (Array.isArray(j) ? (j as RestPull[]) : []).flatMap((p) => {
        const f = pullOf(p);
        return f === undefined ? [] : [f];
      });
    },
    async createPullRequest(repo, o) {
      assertRepo(repo);
      assertBranch(o.head);
      const j = await must('opening a pull request', 'POST', `repos/${repo}/pulls`, o);
      const n = j?.number;
      if (typeof n !== 'number') throw new HubError('opening a pull request', undefined);
      return n;
    },
    async editPullRequestBody(repo, pr, body) {
      assertRepo(repo);
      await must('renewing a pull request', 'PATCH', `repos/${repo}/pulls/${pr}`, { body });
    },
  };
}

/** The hub on `gh`: the lead's own login, or `token` for every call. */
export const ghHub = (gh: Gh, token?: string): WorkerHub => makeHub(ghTransport(gh, token));

/** The hub a worker uses: in-process HTTPS with its own token. */
export const fetchHub = (token: string, doFetch?: typeof fetch): WorkerHub =>
  makeHub(fetchTransport(token, doFetch));
