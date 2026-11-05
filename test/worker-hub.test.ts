import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Gh } from '../src/ports.js';
import { fetchHub, ghHub, httpStatus } from '../src/worker-hub.js';

type Reply = { code?: number; stdout?: string; stderr?: string };

/** A gh that records each call with the JSON body it was given through --input. */
function recordingGh(reply: (args: string[], body: unknown) => Reply) {
  const calls: { args: string[]; body: unknown; token?: string }[] = [];
  const gh: Gh = {
    async api() {
      throw new Error('the hub never uses gh.api');
    },
    async run(args, opts) {
      const at = args.indexOf('--input');
      const body = at < 0 ? undefined : JSON.parse(readFileSync(args[at + 1] as string, 'utf8'));
      calls.push({ args, body, ...(opts?.token === undefined ? {} : { token: opts.token }) });
      const r = reply(args, body);
      return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
  };
  return { gh, calls };
}

const SHA = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const COMMIT = 'c'.repeat(40);

describe('ghHub', () => {
  it('reads the HTTP status gh names on a failure', () => {
    expect(httpStatus('gh: Reference already exists (HTTP 422)')).toBe(422);
    expect(httpStatus('gh: Not Found (HTTP 404)')).toBe(404);
    expect(httpStatus('timeout')).toBeUndefined();
  });

  it('creates a claim as tree, commit and a new ref, with the token, bodies never on argv', async () => {
    const { gh, calls } = recordingGh((args) => {
      const path = args[3];
      if (path === 'repos/org/app/git/trees') return { stdout: JSON.stringify({ sha: TREE }) };
      if (path === 'repos/org/app/git/commits') return { stdout: JSON.stringify({ sha: COMMIT }) };
      if (path === 'repos/org/app/git/refs') return { stdout: '{}' };
      return { code: 1, stderr: 'unexpected' };
    });
    const hub = ghHub(gh, 'tok');
    const r = await hub.writeClaim('org/app', 'APP-1', {
      message: 'Studio claim APP-1: claimed\n\n{}',
      files: { 'claim.json': '{}\n' },
    });
    expect(r).toEqual({ ok: true, sha: COMMIT });
    expect(calls.map((c) => c.args.slice(0, 4).join(' '))).toEqual([
      'api -X POST repos/org/app/git/trees',
      'api -X POST repos/org/app/git/commits',
      'api -X POST repos/org/app/git/refs',
    ]);
    expect(calls.every((c) => c.token === 'tok')).toBe(true);
    expect(calls.some((c) => c.args.some((a) => a.includes('Studio claim')))).toBe(false);
    expect(calls[1]?.body).toEqual({
      message: 'Studio claim APP-1: claimed\n\n{}',
      tree: TREE,
      parents: [],
    });
    expect(calls[2]?.body).toEqual({ ref: 'refs/studio/claims/APP-1', sha: COMMIT });
  });

  it('a claim that exists, or moved meanwhile, is lost with 422; a move is never forced', async () => {
    const answer = (refStatus: number) =>
      recordingGh((args) => {
        const path = args[3] ?? '';
        if (path.endsWith('/git/trees')) return { stdout: JSON.stringify({ sha: TREE }) };
        if (path.endsWith('/git/commits')) return { stdout: JSON.stringify({ sha: COMMIT }) };
        return { code: 1, stderr: `gh: failed (HTTP ${refStatus})` };
      });
    const create = answer(422);
    expect(
      await ghHub(create.gh).writeClaim('org/app', 'APP-1', { message: 'm', files: {} }),
    ).toEqual({ ok: false });
    const move = answer(422);
    expect(
      await ghHub(move.gh).writeClaim('org/app', 'APP-1', { message: 'm', files: {}, parent: SHA }),
    ).toEqual({ ok: false });
    expect(move.calls[2]?.args.slice(0, 4)).toEqual([
      'api',
      '-X',
      'PATCH',
      'repos/org/app/git/refs/studio/claims/APP-1',
    ]);
    expect(move.calls[2]?.body).toEqual({ sha: COMMIT, force: false });
    const other = answer(500);
    await expect(
      ghHub(other.gh).writeClaim('org/app', 'APP-1', { message: 'm', files: {} }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('reads a claim: none on 404, else the commit with its parents, and no identity at all', async () => {
    const none = recordingGh(() => ({ code: 1, stderr: 'gh: Not Found (HTTP 404)' }));
    expect(await ghHub(none.gh).readClaim('org/app', 'APP-1')).toBeUndefined();
    const some = recordingGh((args) =>
      args[3] === 'repos/org/app/git/ref/studio/claims/APP-1'
        ? { stdout: JSON.stringify({ object: { sha: SHA } }) }
        : args[3] === `repos/org/app/git/commits/${SHA}`
          ? {
              stdout: JSON.stringify({
                message: 'Studio claim APP-1: alive\n\n{}',
                author: { name: 'x', email: 'forged@example.com' },
                committer: { date: '2026-11-05T10:00:00Z' },
                parents: [{ sha: COMMIT }],
              }),
            }
          : { code: 1, stderr: 'unexpected' },
    );
    expect(await ghHub(some.gh).readClaim('org/app', 'APP-1')).toEqual({
      sha: SHA,
      message: 'Studio claim APP-1: alive\n\n{}',
      committedAt: '2026-11-05T10:00:00Z',
      parents: [COMMIT],
    });
  });

  it('posts a claim comment as a body, and reads comments with their GitHub author, page by page', async () => {
    const page = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: from + i,
        user: { login: 'win-bot', id: 7 },
        author_association: 'COLLABORATOR',
        body: `c${from + i}`,
        created_at: '2026-11-05T10:00:00Z',
        updated_at: '2026-11-05T10:00:00Z',
      }));
    const { gh, calls } = recordingGh((args) => {
      const path = args[3] ?? '';
      if (path.endsWith('page=1')) return { stdout: JSON.stringify(page(1, 100)) };
      if (path.endsWith('page=2'))
        return { stdout: JSON.stringify([...page(101, 2), { id: 'bad' }]) };
      return { stdout: '{}' };
    });
    const hub = ghHub(gh, 'tok');
    await hub.commentOffer('org/app', 30, 'studio-claim x y');
    expect(calls[0]?.args.slice(0, 4)).toEqual([
      'api',
      '-X',
      'POST',
      'repos/org/app/issues/30/comments',
    ]);
    expect(calls[0]?.body).toEqual({ body: 'studio-claim x y' });
    const all = await hub.offerComments('org/app', 30);
    expect(all.complete).toBe(true);
    expect(all.comments).toHaveLength(102);
    expect(all.comments[101]).toEqual({
      id: 102,
      login: 'win-bot',
      userId: 7,
      association: 'COLLABORATOR',
      body: 'c102',
      createdAt: '2026-11-05T10:00:00Z',
      updatedAt: '2026-11-05T10:00:00Z',
    });
  });

  it('lists offers with author and editor through GraphQL, owner and name as strings', async () => {
    const { gh, calls } = recordingGh(() => ({
      stdout: JSON.stringify({
        data: {
          repository: {
            issues: {
              nodes: [
                {
                  number: 30,
                  title: 'Studio offer APP-1 for windows',
                  body: 'b',
                  state: 'OPEN',
                  author: { login: 'lead-user' },
                  editor: null,
                  lastEditedAt: null,
                },
                { number: 'x' },
              ],
            },
          },
        },
      }),
    }));
    expect(await ghHub(gh).listOffers('org/app')).toEqual([
      {
        number: 30,
        title: 'Studio offer APP-1 for windows',
        body: 'b',
        author: 'lead-user',
        edited: false,
        open: true,
      },
    ]);
    expect(calls[0]?.args.slice(0, 4)).toEqual(['api', '-X', 'POST', 'graphql']);
    expect(calls[0]?.body).toMatchObject({
      variables: { owner: 'org', name: 'app', label: 'studio-offer', after: null },
    });
  });

  it('refuses names that would leave the paths it builds', async () => {
    const { gh } = recordingGh(() => ({}));
    const hub = ghHub(gh);
    await expect(hub.readClaim('org/app', '../x')).rejects.toThrow(/invalid item/);
    await expect(hub.readClaim('org/../app', 'APP-1')).rejects.toThrow(/invalid repository/);
    await expect(hub.branchHead('org/app', 'main')).rejects.toThrow(/invalid branch/);
    await expect(hub.claimFile('org/app', SHA, '../x')).rejects.toThrow(/invalid claim file/);
  });

  it('locks an offer right after opening it', async () => {
    const { gh, calls } = recordingGh((args) =>
      args[3] === 'repos/org/app/issues' ? { stdout: JSON.stringify({ number: 30 }) } : {},
    );
    expect(await ghHub(gh).openOffer('org/app', 't', 'b', ['studio-offer'])).toBe(30);
    expect(calls.map((c) => c.args.slice(0, 4).join(' '))).toEqual([
      'api -X POST repos/org/app/issues',
      'api -X PUT repos/org/app/issues/30/lock',
    ]);
  });

  it('pages through every open offer', async () => {
    const node = (n: number) => ({
      number: n,
      title: `t${n}`,
      body: 'b',
      state: 'OPEN',
      author: { login: 'lead-user' },
      editor: null,
      lastEditedAt: null,
    });
    const { gh, calls } = recordingGh((_args, body) => {
      const after = (body as { variables: { after: string | null } }).variables.after;
      return {
        stdout: JSON.stringify({
          data: {
            repository: {
              issues:
                after === null
                  ? { nodes: [node(1)], pageInfo: { hasNextPage: true, endCursor: 'c1' } }
                  : { nodes: [node(2)], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          },
        }),
      };
    });
    expect((await ghHub(gh).listOffers('org/app')).map((o) => o.number)).toEqual([1, 2]);
    expect(calls).toHaveLength(2);
  });

  it('says when an offer has more comment pages than it reads', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      user: { login: 'x', id: 1 },
      body: 'b',
      created_at: 't',
      updated_at: 't',
    }));
    const { gh } = recordingGh(() => ({ stdout: JSON.stringify(full) }));
    const r = await ghHub(gh).offerComments('org/app', 30);
    expect(r.complete).toBe(false);
  });
});

describe('fetchHub: the worker talks to GitHub in-process', () => {
  it('sends the token as a header to api.github.com only, never follows a redirect', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ login: 'win-bot', id: 7 }), { status: 200 });
    }) as typeof fetch;
    expect(await fetchHub('tok-1', fake).user()).toEqual({ login: 'win-bot', id: 7 });
    const first = seen[0];
    if (first === undefined) throw new Error('no request');
    expect(first.url).toBe('https://api.github.com/user');
    expect((first.init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
    expect(first.init.redirect).toBe('error');
  });

  it('reads a status: 422 on a taken claim, a failed request as no answer', async () => {
    const answers = [
      new Response(JSON.stringify({ sha: TREE }), { status: 201 }),
      new Response(JSON.stringify({ sha: COMMIT }), { status: 201 }),
      new Response('{"message":"Reference already exists"}', { status: 422 }),
    ];
    const fake = (async () => answers.shift() as Response) as unknown as typeof fetch;
    expect(
      await fetchHub('t', fake).writeClaim('org/app', 'APP-1', { message: 'm', files: {} }),
    ).toEqual({ ok: false });
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await expect(fetchHub('t', down).user()).rejects.toThrow(/reading the account failed/);
  });

  it('opens a pull request in-process, and lists open ones by the head of the repository', async () => {
    const seen: string[] = [];
    const fake = (async (url: string | URL, init?: RequestInit) => {
      seen.push(`${init?.method} ${String(url)}`);
      return String(url).includes('/pulls?')
        ? new Response('[]', { status: 200 })
        : new Response(JSON.stringify({ number: 9 }), { status: 201 });
    }) as typeof fetch;
    const hub = fetchHub('t', fake);
    expect(await hub.openPullRequests('org/app', 'studio/APP-1')).toEqual([]);
    expect(
      await hub.createPullRequest('org/app', {
        head: 'studio/APP-1',
        base: 'main',
        title: 't',
        body: 'b',
      }),
    ).toBe(9);
    expect(seen).toEqual([
      'GET https://api.github.com/repos/org/app/pulls?state=open&per_page=100&head=org%3Astudio%2FAPP-1',
      'POST https://api.github.com/repos/org/app/pulls',
    ]);
  });
});
