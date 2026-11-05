import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Gh } from '../src/ports.js';
import { ghHub, httpStatus } from '../src/worker-hub.js';

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

  it('reads a claim: none on 404, else the commit with GitHub date and parents', async () => {
    const none = recordingGh(() => ({ code: 1, stderr: 'gh: Not Found (HTTP 404)' }));
    expect(await ghHub(none.gh).readClaim('org/app', 'APP-1')).toBeUndefined();
    const some = recordingGh((args) =>
      args[3] === 'repos/org/app/git/ref/studio/claims/APP-1'
        ? { stdout: JSON.stringify({ object: { sha: SHA } }) }
        : {
            stdout: JSON.stringify({
              message: 'Studio claim APP-1: alive\n\n{}',
              committer: { date: '2026-11-05T10:00:00Z' },
              parents: [{ sha: COMMIT }],
            }),
          },
    );
    expect(await ghHub(some.gh).readClaim('org/app', 'APP-1')).toEqual({
      sha: SHA,
      message: 'Studio claim APP-1: alive\n\n{}',
      committedAt: '2026-11-05T10:00:00Z',
      parents: [COMMIT],
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
    expect(calls[0]?.args).toEqual(
      expect.arrayContaining([
        'graphql',
        '-f',
        'owner=org',
        '-f',
        'name=app',
        '-f',
        'label=studio-offer',
      ]),
    );
  });

  it('refuses names that would leave the paths it builds', async () => {
    const { gh } = recordingGh(() => ({}));
    const hub = ghHub(gh);
    await expect(hub.readClaim('org/app', '../x')).rejects.toThrow(/invalid item/);
    await expect(hub.readClaim('org/../app', 'APP-1')).rejects.toThrow(/invalid repository/);
    await expect(hub.branchHead('org/app', 'main')).rejects.toThrow(/invalid branch/);
    await expect(hub.claimFile('org/app', SHA, '../x')).rejects.toThrow(/invalid claim file/);
  });
});
