// The GitHub side of workers on other machines: offers are issues the lead opens, claims are refs
// below `refs/studio/claims/` whose commits carry the claim and, at the end, the report. Nothing
// else is shared between the machines. Every call goes through `gh`, with the caller's identity:
// the owner's login on the lead's machine, the worker's own token on a worker machine.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Gh } from './ports.js';

/** The label every offer carries; workers list open issues with it. */
export const OFFER_LABEL = 'studio-offer';
/** Where a claim lives: one ref per item, outside branches and tags, so it starts no workflow. */
export const CLAIM_PREFIX = 'refs/studio/claims/';

/** An offer as GitHub shows it: who opened it and whether anyone edited it since. */
export interface OfferIssue {
  number: number;
  title: string;
  body: string;
  /** The login that opened the issue; GitHub sets it, no client can. */
  author: string;
  /** The login of the last edit, when the body was edited after it was opened. */
  editor?: string;
  edited: boolean;
  open: boolean;
}

/** The commit a claim ref points to, with GitHub's own view of who made it. */
export interface ClaimCommit {
  sha: string;
  message: string;
  /** The committer date in the commit. Writer-supplied: shown, never used for a lease. */
  committedAt: string;
  parents: string[];
  /**
   * The GitHub account GitHub attributes the commit to, when author and committer are one
   * account; undefined otherwise. The claim's own `worker` field is self-declared and only counts
   * when it equals this.
   */
  login?: string;
  /** Whether GitHub verified the commit's signature (`commit.verification.verified`). */
  verified: boolean;
}

export interface PullRequestFacts {
  number: number;
  author: string;
  branch: string;
  head: string;
  base: string;
  crossRepository: boolean;
  state: string;
}

export interface WorkerHub {
  /** The login of the identity this hub acts as. */
  login(): Promise<string>;
  openOffer(repo: string, title: string, body: string, labels: string[]): Promise<number>;
  /** Comments (Studio's own words) and closes. */
  closeOffer(repo: string, n: number, comment: string): Promise<void>;
  /** Open issues with the offer label, oldest first. */
  listOffers(repo: string): Promise<OfferIssue[]>;
  offer(repo: string, n: number): Promise<OfferIssue | undefined>;
  readClaim(repo: string, item: string): Promise<ClaimCommit | undefined>;
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
  /** The head of a branch; undefined when it does not exist. */
  branchHead(repo: string, branch: string): Promise<string | undefined>;
  pullRequest(repo: string, pr: number): Promise<PullRequestFacts | undefined>;
}

const TIMEOUT_MS = 60_000;
const MAX_FILE = 1024 * 1024;

/** The HTTP status `gh api` names on a failed request, e.g. `(HTTP 422)`. */
export function httpStatus(stderr: string): number | undefined {
  const m = /\(HTTP (\d{3})\)/.exec(stderr) ?? /HTTP (\d{3})/.exec(stderr);
  return m ? Number(m[1]) : undefined;
}

export class HubError extends Error {
  readonly status: number | undefined;
  constructor(what: string, code: number, status: number | undefined) {
    // Fixed text only: GitHub's answer may quote what was sent.
    super(
      `GitHub: ${what} failed (gh exit ${code}${status === undefined ? '' : `, HTTP ${status}`})`,
    );
    this.name = 'HubError';
    this.status = status;
  }
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ITEM_RE = /^[A-Z]+-\d+$/;
const SHA_RE = /^[0-9a-f]{40,64}$/;

function assertRepo(repo: string): void {
  if (!REPO_RE.test(repo)) throw new Error(`invalid repository: ${JSON.stringify(repo)}`);
}
function assertItem(item: string): void {
  if (!ITEM_RE.test(item)) throw new Error(`invalid item id: ${JSON.stringify(item)}`);
}

const ISSUES_QUERY = `query($owner: String!, $name: String!, $label: String!) {
  repository(owner: $owner, name: $name) {
    issues(first: 50, states: OPEN, labels: [$label], orderBy: {field: CREATED_AT, direction: ASC}) {
      nodes { number title body state author { login } editor { login } lastEditedAt }
    }
  }
}`;
const ISSUE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) { number title body state author { login } editor { login } lastEditedAt }
  }
}`;

type IssueNode = {
  number?: unknown;
  title?: unknown;
  body?: unknown;
  state?: unknown;
  author?: { login?: unknown } | null;
  editor?: { login?: unknown } | null;
  lastEditedAt?: unknown;
};

function issueOf(n: IssueNode | null | undefined): OfferIssue | undefined {
  if (!n || typeof n.number !== 'number' || typeof n.title !== 'string') return undefined;
  if (typeof n.body !== 'string' || typeof n.author?.login !== 'string') return undefined;
  const editor = typeof n.editor?.login === 'string' ? n.editor.login : undefined;
  return {
    number: n.number,
    title: n.title,
    body: n.body,
    author: n.author.login,
    ...(editor === undefined ? {} : { editor }),
    edited: n.lastEditedAt !== null && n.lastEditedAt !== undefined,
    open: n.state === 'OPEN',
  };
}

/**
 * The hub on `gh`. With `token`, every call runs as that identity (GH_TOKEN for that call only);
 * without, as the gh login of the machine. Request bodies go through a 0600 file, never argv.
 */
export function ghHub(gh: Gh, token?: string): WorkerHub {
  const run = (args: string[]) =>
    gh.run(args, { timeoutMs: TIMEOUT_MS, ...(token === undefined ? {} : { token }) });
  const api = async (
    what: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<
    { ok: true; json: unknown } | { ok: false; status: number | undefined; code: number }
  > => {
    const call = async (extra: string[]) => {
      const r = await run(['api', '-X', method, path, ...extra]);
      if (r.code !== 0) return { ok: false as const, status: httpStatus(r.stderr), code: r.code };
      let json: unknown = null;
      try {
        json = r.stdout.trim() === '' ? null : JSON.parse(r.stdout);
      } catch {
        throw new HubError(`${what} (unreadable answer)`, 0, undefined);
      }
      return { ok: true as const, json };
    };
    if (body === undefined) return call([]);
    const dir = mkdtempSync(join(tmpdir(), 'studio-hub-'));
    try {
      const file = join(dir, 'body.json');
      writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
      return await call(['--input', file]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const must = async (what: string, method: string, path: string, body?: unknown) => {
    const r = await api(what, method, path, body);
    if (!r.ok) throw new HubError(what, r.code, r.status);
    return r.json as Record<string, unknown> | null;
  };
  const graphql = async (what: string, query: string, vars: string[]) => {
    const r = await run(['api', 'graphql', '-f', `query=${query}`, ...vars]);
    if (r.code !== 0) throw new HubError(what, r.code, httpStatus(r.stderr));
    try {
      return JSON.parse(r.stdout) as {
        data?: { repository?: { issues?: { nodes?: IssueNode[] }; issue?: IssueNode | null } };
      };
    } catch {
      throw new HubError(`${what} (unreadable answer)`, 0, undefined);
    }
  };
  const split = (repo: string) => {
    assertRepo(repo);
    const [owner, name] = repo.split('/') as [string, string];
    return { owner, name };
  };
  return {
    async login() {
      const j = await must('reading the login', 'GET', 'user');
      const login = j?.login;
      if (typeof login !== 'string') throw new HubError('reading the login', 0, undefined);
      return login;
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
        throw new HubError('opening an offer (no issue number)', 0, undefined);
      }
      return n;
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
      const j = await graphql('listing offers', ISSUES_QUERY, [
        '-f',
        `owner=${owner}`,
        '-f',
        `name=${name}`,
        '-f',
        `label=${OFFER_LABEL}`,
      ]);
      return (j.data?.repository?.issues?.nodes ?? []).flatMap((n) => {
        const o = issueOf(n);
        return o === undefined ? [] : [o];
      });
    },
    async offer(repo, n) {
      const { owner, name } = split(repo);
      const j = await graphql('reading an offer', ISSUE_QUERY, [
        '-f',
        `owner=${owner}`,
        '-f',
        `name=${name}`,
        '-F',
        `number=${n}`,
      ]);
      return issueOf(j.data?.repository?.issue);
    },
    async readClaim(repo, item) {
      assertRepo(repo);
      assertItem(item);
      const ref = await api(
        'reading a claim',
        'GET',
        `repos/${repo}/git/ref/studio/claims/${item}`,
      );
      if (!ref.ok) {
        if (ref.status === 404) return undefined;
        throw new HubError('reading a claim', ref.code, ref.status);
      }
      const sha = (ref.json as { object?: { sha?: unknown } } | null)?.object?.sha;
      if (typeof sha !== 'string' || !SHA_RE.test(sha)) {
        throw new HubError('reading a claim (no commit)', 0, undefined);
      }
      // The commits endpoint (not git/commits): it adds the accounts GitHub attributes the commit
      // to and its signature verification.
      const c = (await must('reading a claim commit', 'GET', `repos/${repo}/commits/${sha}`)) as {
        commit?: {
          message?: unknown;
          committer?: { date?: unknown };
          verification?: { verified?: unknown };
        };
        author?: { login?: unknown } | null;
        committer?: { login?: unknown } | null;
        parents?: { sha?: unknown }[];
      } | null;
      const message = c?.commit?.message;
      const date = c?.commit?.committer?.date;
      if (typeof message !== 'string' || typeof date !== 'string') {
        throw new HubError('reading a claim commit (incomplete)', 0, undefined);
      }
      const author = c?.author?.login;
      const committer = c?.committer?.login;
      const login =
        typeof author === 'string' &&
        typeof committer === 'string' &&
        author.toLowerCase() === committer.toLowerCase()
          ? committer
          : undefined;
      return {
        sha,
        message,
        committedAt: date,
        parents: (c?.parents ?? []).flatMap((p) => (typeof p.sha === 'string' ? [p.sha] : [])),
        ...(login === undefined ? {} : { login }),
        verified: c?.commit?.verification?.verified === true,
      };
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
      if (typeof treeSha !== 'string') throw new HubError('writing a claim tree', 0, undefined);
      // No author or committer: GitHub sets both from this identity, with its own clock.
      const commit = await must('writing a claim commit', 'POST', `repos/${repo}/git/commits`, {
        message: o.message,
        tree: treeSha,
        parents: o.parent === undefined ? [] : [o.parent],
      });
      const sha = commit?.sha;
      if (typeof sha !== 'string' || !SHA_RE.test(sha)) {
        throw new HubError('writing a claim commit', 0, undefined);
      }
      const moved =
        o.parent === undefined
          ? await api('creating a claim', 'POST', `repos/${repo}/git/refs`, {
              ref: `${CLAIM_PREFIX}${item}`,
              sha,
            })
          : await api('moving a claim', 'PATCH', `repos/${repo}/git/refs/studio/claims/${item}`, {
              sha,
              force: false,
            });
      if (moved.ok) return { ok: true, sha };
      // 422: the ref exists (create) or the move is no fast-forward (update): someone else won.
      if (moved.status === 422) return { ok: false };
      throw new HubError('writing a claim', moved.code, moved.status);
    },
    async claimFile(repo, sha, path) {
      assertRepo(repo);
      if (!SHA_RE.test(sha) || !/^[a-z.-]{1,40}$/.test(path)) throw new Error('invalid claim file');
      const r = await api(
        'reading a claim file',
        'GET',
        `repos/${repo}/contents/${path}?ref=${sha}`,
      );
      if (!r.ok) {
        if (r.status === 404) return undefined;
        throw new HubError('reading a claim file', r.code, r.status);
      }
      const j = r.json as { content?: unknown; encoding?: unknown; size?: unknown } | null;
      if (typeof j?.content !== 'string' || j.encoding !== 'base64') return undefined;
      if (typeof j.size === 'number' && j.size > MAX_FILE) return undefined;
      return Buffer.from(j.content, 'base64').toString('utf8');
    },
    async deleteClaim(repo, item) {
      assertRepo(repo);
      assertItem(item);
      const r = await api(
        'removing a claim',
        'DELETE',
        `repos/${repo}/git/refs/studio/claims/${item}`,
      );
      if (!r.ok && r.status !== 404 && r.status !== 422) {
        throw new HubError('removing a claim', r.code, r.status);
      }
    },
    async branchHead(repo, branch) {
      assertRepo(repo);
      if (!/^studio\/[A-Z]+-\d+$/.test(branch)) throw new Error('invalid branch');
      const r = await api('reading a branch', 'GET', `repos/${repo}/git/ref/heads/${branch}`);
      if (!r.ok) {
        if (r.status === 404) return undefined;
        throw new HubError('reading a branch', r.code, r.status);
      }
      const sha = (r.json as { object?: { sha?: unknown } } | null)?.object?.sha;
      return typeof sha === 'string' && SHA_RE.test(sha) ? sha : undefined;
    },
    async pullRequest(repo, pr) {
      assertRepo(repo);
      const r = await run([
        'pr',
        'view',
        String(pr),
        '--repo',
        repo,
        '--json',
        'number,author,headRefName,headRefOid,baseRefName,isCrossRepository,state',
      ]);
      if (r.code !== 0) return undefined;
      try {
        const j = JSON.parse(r.stdout) as {
          number?: unknown;
          author?: { login?: unknown } | null;
          headRefName?: unknown;
          headRefOid?: unknown;
          baseRefName?: unknown;
          isCrossRepository?: unknown;
          state?: unknown;
        };
        if (
          typeof j.number !== 'number' ||
          typeof j.author?.login !== 'string' ||
          typeof j.headRefName !== 'string' ||
          typeof j.headRefOid !== 'string' ||
          typeof j.baseRefName !== 'string'
        ) {
          return undefined;
        }
        return {
          number: j.number,
          author: j.author.login,
          branch: j.headRefName,
          head: j.headRefOid,
          base: j.baseRefName,
          crossRepository: j.isCrossRepository !== false,
          state: typeof j.state === 'string' ? j.state : 'UNKNOWN',
        };
      } catch {
        return undefined;
      }
    },
  };
}
