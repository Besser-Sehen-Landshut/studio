import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Board } from '../src/board.js';
import { notifySecretFile, type OwnerConfig, ownerConfigSchema } from '../src/config.js';
import { writeBlocks } from '../src/limits.js';
import { writeStateFile } from '../src/paths.js';
import type { Http } from '../src/ports.js';
import {
  type Decision,
  decisionsOf,
  inQuietHours,
  installNotifySecret,
  newNtfyTopic,
  PUSHED_FILE,
  pushDecisions,
  pushLanguage,
  pushText,
  readNotifySecret,
} from '../src/push.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-push-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

const TOPIC = 'studio-FakeTopicForTests0000012';
const TOPIC_ID = TOPIC.slice('studio-'.length);

function setup(config: Record<string, unknown> = {}) {
  const dir = join(root, `d${n++}`);
  mkdirSync(dir, { recursive: true });
  const owner = { homedir: dir, env: { LANG: 'en_US.UTF-8' } };
  const ownerRoot = join(dir, 'owner');
  mkdirSync(ownerRoot, { recursive: true });
  const posts: { url: string; message: string; headers: Record<string, string> }[] = [];
  const replies: { ok: boolean; status?: number }[] = [];
  const http: Http = {
    async post(url, body, headers) {
      posts.push({ url, message: body, headers });
      return replies.shift() ?? { ok: true, status: 200 };
    },
  };
  const ownerConfig: OwnerConfig = ownerConfigSchema.parse(config);
  // `sent` lists the messages only, in order.
  const sent = posts;
  return { dir, owner, ownerRoot, sent, posts, replies, http, ownerConfig };
}

const d = (item: string, kind: Decision['kind'] = 'blocked', urgent = false): Decision => ({
  key: `p:${item}:${kind}:t0`,
  item,
  kind,
  urgent,
});

const at = (iso: string) => new Date(iso);

function push(
  s: ReturnType<typeof setup>,
  decisions: Decision[],
  now: Date,
  projectKey = 'proj-a',
  project = 'app',
) {
  return pushDecisions({
    ownerRoot: s.ownerRoot,
    projectKey,
    project,
    decisions,
    ownerConfig: s.ownerConfig,
    owner: s.owner,
    http: s.http,
    now,
  });
}

describe('the notify secret', () => {
  it('is written 0600 in the owner config dir and read back; a wider mode is refused', () => {
    const s = setup();
    expect(readNotifySecret(s.owner)).toEqual({ kind: 'absent' });
    installNotifySecret({ transport: 'ntfy', topic: TOPIC }, s.owner);
    const file = notifySecretFile(s.owner);
    expect(file.startsWith(join(s.dir, '.config', 'studio'))).toBe(true);
    expect(readNotifySecret(s.owner)).toEqual({
      kind: 'ok',
      secret: { transport: 'ntfy', topic: TOPIC },
    });
    chmodSync(file, 0o644);
    const bad = readNotifySecret(s.owner);
    expect(bad.kind).toBe('bad');
    expect(JSON.stringify(bad)).not.toContain(TOPIC_ID);
  });

  it('new topics are url-safe and carry at least 128 random bits', () => {
    const a = newNtfyTopic();
    const b = newNtfyTopic();
    expect(a).toMatch(/^studio-[A-Za-z0-9_-]{24}$/);
    expect(a).not.toBe(b);
    // 24 base64url characters: 144 bits.
    expect((a.length - 'studio-'.length) * 6).toBeGreaterThanOrEqual(128);
  });
});

describe('pushDecisions', () => {
  it('sends nothing and reports nothing without stored keys', async () => {
    const s = setup();
    expect(await push(s, [d('APP-1')], at('2026-11-05T10:00:00Z'))).toEqual({
      sent: 0,
      errors: [],
    });
    expect(s.sent).toEqual([]);
  });

  it('sends one line per new decision and never the same one twice', async () => {
    const s = setup();
    installNotifySecret({ transport: 'ntfy', topic: TOPIC }, s.owner);
    const r = await push(s, [d('APP-1', 'fix_limit')], at('2026-11-05T10:00:00Z'));
    expect(r).toEqual({ sent: 1, errors: [] });
    expect(s.posts).toEqual([
      {
        url: `https://ntfy.sh/${TOPIC}`,
        message: 'Fix limit reached: APP-1 in app',
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          Title: 'Studio',
          Priority: 'default',
        },
      },
    ]);
    // Twenty minutes later, the same decision is still listed: no second push.
    await push(s, [d('APP-1', 'fix_limit')], at('2026-11-05T10:20:00Z'));
    expect(s.sent).toHaveLength(1);
    // Neither the keys nor anything but ids and times lands in the owner state.
    const state = readFileSync(join(s.ownerRoot, PUSHED_FILE), 'utf8');
    expect(state).not.toContain(TOPIC_ID);
  });

  it('holds a second push within ten minutes and bundles what waited', async () => {
    const s = setup();
    installNotifySecret({ transport: 'ntfy', topic: TOPIC }, s.owner);
    await push(s, [d('APP-1')], at('2026-11-05T10:00:00Z'));
    const held = await push(s, [d('APP-1'), d('APP-2')], at('2026-11-05T10:04:00Z'));
    expect(held).toEqual({ sent: 0, deferred: 'throttle', errors: [] });
    const held2 = await push(s, [d('APP-1'), d('APP-2'), d('APP-3')], at('2026-11-05T10:08:00Z'));
    expect(held2.deferred).toBe('throttle');
    const r = await push(
      s,
      [d('APP-1'), d('APP-2'), d('APP-3'), d('APP-4', 'question')],
      at('2026-11-05T10:10:00Z'),
    );
    expect(r).toEqual({ sent: 3, errors: [] });
    expect(s.sent.map((m) => m.message)).toEqual([
      'Blocked: APP-1 in app',
      '3 decisions needed in app',
    ]);
  });

  it('throttles per project: another project pushes at once', async () => {
    const s = setup();
    installNotifySecret({ transport: 'ntfy', topic: TOPIC }, s.owner);
    await push(s, [d('APP-1')], at('2026-11-05T10:00:00Z'), 'proj-a', 'app');
    const other: Decision = {
      key: 'q:WEB-1:blocked:t0',
      item: 'WEB-1',
      kind: 'blocked',
      urgent: false,
    };
    const r = await push(s, [other], at('2026-11-05T10:01:00Z'), 'proj-b', 'web');
    expect(r.sent).toBe(1);
    expect(s.sent.at(-1)?.message).toBe('Blocked: WEB-1 in web');
  });

  it('waits through quiet hours on the owner clock and sends the bundle after them', async () => {
    const s = setup({ notify: { quiet: '22:00-07:00', timezone: 'Europe/Berlin' } });
    installNotifySecret({ transport: 'ntfy', topic: TOPIC }, s.owner);
    // 23:30 in Berlin (UTC+1 in November).
    const r = await push(s, [d('APP-1')], at('2026-11-05T22:30:00Z'));
    expect(r).toEqual({ sent: 0, deferred: 'quiet', errors: [] });
    const r2 = await push(s, [d('APP-1'), d('APP-2')], at('2026-11-06T05:59:00Z'));
    expect(r2.deferred).toBe('quiet');
    // 07:00 in Berlin: the window is over.
    const r3 = await push(s, [d('APP-1'), d('APP-2')], at('2026-11-06T06:00:00Z'));
    expect(r3.sent).toBe(2);
    expect(s.sent.map((m) => m.message)).toEqual(['2 decisions needed in app']);
  });

  it('an account block is urgent: it passes quiet hours and the throttle, high priority', async () => {
    const s = setup({ notify: { quiet: '00:00-23:59' } });
    installNotifySecret({ transport: 'ntfy', topic: TOPIC }, s.owner);
    const block: Decision = {
      key: 'block:main:x:t',
      item: 'main',
      kind: 'account_block',
      urgent: true,
    };
    const r = await push(s, [block], at('2026-11-05T10:00:00Z'));
    expect(r.sent).toBe(1);
    expect(s.sent[0]).toMatchObject({
      message: 'Account blocked: main in app',
      headers: { Priority: 'high' },
    });
    // A minute later another block arrives together with a plain decision: both go out now.
    const block2: Decision = { ...block, key: 'block:spare:x:t', item: 'spare' };
    const r2 = await push(s, [block, block2, d('APP-9')], at('2026-11-05T10:01:00Z'));
    expect(r2.sent).toBe(2);
    expect(s.sent[1]).toMatchObject({
      message: '2 decisions needed in app: account blocked',
      headers: { Priority: 'high' },
    });
  });

  it('records a failed send as a notify error without secrets and retries it next time', async () => {
    const s = setup();
    installNotifySecret({ transport: 'ntfy', topic: TOPIC }, s.owner);
    s.replies.push({ ok: false, status: 500 }, { ok: false });
    const r = await push(s, [d('APP-1')], at('2026-11-05T10:00:00Z'));
    expect(r).toEqual({ sent: 0, errors: ['notify: ntfy answered 500; retried next tick'] });
    const r2 = await push(s, [d('APP-1')], at('2026-11-05T10:01:00Z'));
    expect(r2.errors).toEqual(['notify: ntfy could not be reached; retried next tick']);
    const r3 = await push(s, [d('APP-1')], at('2026-11-05T10:02:00Z'));
    expect(r3.sent).toBe(1);
    for (const out of [r, r2, r3]) {
      expect(JSON.stringify(out)).not.toContain(TOPIC_ID);
    }
  });

  it('an unusable key file and an unreadable record are errors, never thrown', async () => {
    const s = setup();
    writeStateFile(s.dir, notifySecretFile(s.owner), 'not json');
    const r = await push(s, [d('APP-1')], at('2026-11-05T10:00:00Z'));
    expect(r.errors[0]).toMatch(
      /^notify: .*notify-secret is not valid JSON; run studio setup --notifications$/,
    );
    installNotifySecret({ transport: 'ntfy', topic: TOPIC }, s.owner);
    writeStateFile(s.ownerRoot, join(s.ownerRoot, PUSHED_FILE), '[1]');
    const r2 = await push(s, [d('APP-1')], at('2026-11-05T10:00:00Z'));
    expect(r2.errors).toEqual([`notify: ${PUSHED_FILE} is unreadable; nothing sent`]);
    expect(s.sent).toEqual([]);
  });
});

describe('decisionsOf', () => {
  const board = (at: string): Board =>
    ({
      items: [
        {
          id: 'APP-3',
          history: [{ from: 'in_review', to: 'blocked', at, by: 'studio' }],
        },
      ],
    }) as unknown as Board;

  it('classifies by Studio phrase, keys by item, kind and the time it arose, keeps no crew text', () => {
    const s = setup();
    const lead = [
      { item: 'APP-3', reason: 'blocked: fix limit reached: 3 review rounds, attempts 2' },
      { item: 'APP-4', reason: 'blocked: question: SECRET CREW TEXT?' },
      { item: 'APP-5', reason: 'merge failed: check ci failed' },
      { item: 'APP-6', reason: 'changes requested by APP-7: blocked → ready ...' },
      { item: 'APP-8', reason: 'release approval needed for api' },
      { item: 'api-1', reason: 'release failed: api-1: smoke failed after the deploy' },
      { item: 'evil\nid', reason: 'anything' },
    ];
    const out = decisionsOf({
      projectKey: 'pk',
      needsLead: lead,
      board: board('2026-11-05T09:00:00.000Z'),
      ownerRoot: s.ownerRoot,
    });
    expect(out.map((x) => [x.item, x.kind])).toEqual([
      ['APP-3', 'fix_limit'],
      ['APP-4', 'question'],
      ['APP-5', 'merge_failed'],
      ['APP-6', 'changes_requested'],
      ['APP-8', 'release_approval'],
      ['api-1', 'release_failed'],
      ['?', 'other'],
    ]);
    expect(out[0]?.key).toBe('pk:APP-3:fix_limit:2026-11-05T09:00:00.000Z');
    expect(JSON.stringify(out)).not.toContain('SECRET');
    // The item moved again: a new decision with a new key.
    const later = decisionsOf({
      projectKey: 'pk',
      needsLead: lead.slice(0, 1),
      board: board('2026-11-05T11:00:00.000Z'),
      ownerRoot: s.ownerRoot,
    });
    expect(later[0]?.key).not.toBe(out[0]?.key);
  });

  it('adds each account block, keyed owner-wide, as urgent', () => {
    const s = setup();
    writeBlocks(s.ownerRoot, [
      { label: 'main', reason: 'authentication_failed', at: '2026-11-05T08:00:00.000Z' },
    ]);
    const out = decisionsOf({
      projectKey: 'pk',
      needsLead: [],
      board: undefined,
      ownerRoot: s.ownerRoot,
    });
    expect(out).toEqual([
      {
        key: 'block:main:authentication_failed:2026-11-05T08:00:00.000Z',
        item: 'main',
        kind: 'account_block',
        urgent: true,
      },
    ]);
  });

  it('pushes each external merge result of the last day once, a failure only once with its lead line', () => {
    const s = setup();
    const by = { by: 'lead', at: '2026-11-05T07:00:00.000Z', head: 'a'.repeat(40) };
    const done = [
      {
        pr: 5,
        repo: 'org/app',
        external: by,
        result: 'merged' as const,
        at: '2026-11-05T09:00:00.000Z',
      },
      {
        pr: 6,
        repo: 'org/app',
        external: by,
        result: 'failed' as const,
        reason: 'check ci failed',
        at: '2026-11-05T09:30:00.000Z',
      },
      // Older than a day, and a board item's result: neither is pushed from here.
      {
        pr: 7,
        repo: 'org/app',
        external: by,
        result: 'merged' as const,
        at: '2026-11-03T09:00:00.000Z',
      },
      {
        pr: 8,
        repo: 'org/app',
        item: 'APP-8',
        result: 'merged' as const,
        at: '2026-11-05T09:00:00.000Z',
      },
    ];
    const out = decisionsOf({
      projectKey: 'pk',
      needsLead: [{ item: 'org/app#6', reason: 'merge failed: check ci failed' }],
      board: undefined,
      ownerRoot: s.ownerRoot,
      queueDone: done,
      now: at('2026-11-05T10:00:00.000Z'),
    });
    expect(out).toEqual([
      {
        key: 'pk:org/app#6:merge_failed:2026-11-05T09:30:00.000Z',
        item: 'org/app#6',
        kind: 'merge_failed',
        urgent: false,
      },
      {
        key: 'pk:org/app#5:merged:2026-11-05T09:00:00.000Z',
        item: 'org/app#5',
        kind: 'merged',
        urgent: false,
      },
    ]);
  });
});

describe('review fixes', () => {
  it('quiet hours use notify.timezone, never the crew limits zone', async () => {
    // 23:30 UTC: quiet in UTC, but 08:30 in Tokyo.
    const s = setup({
      notify: { quiet: '22:00-07:00' },
      crewLabelLimits: { timezone: 'Asia/Tokyo' },
    });
    installNotifySecret({ transport: 'ntfy', topic: TOPIC }, s.owner);
    const sys = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const t = new Date('2026-11-05T23:30:00Z');
    const expected = inQuietHours('22:00-07:00', t, sys) ? 'quiet' : undefined;
    expect((await push(s, [d('APP-1')], t)).deferred).toBe(expected);
    const tokyo = setup({ notify: { quiet: '22:00-07:00', timezone: 'Asia/Tokyo' } });
    installNotifySecret({ transport: 'ntfy', topic: TOPIC }, tokyo.owner);
    expect((await push(tokyo, [d('APP-1')], t)).sent).toBe(1);
    expect(() => ownerConfigSchema.parse({ notify: { timezone: 'Mars/Base' } })).toThrow();
  });

  it('a project name that is not a plain name becomes ?', async () => {
    for (const bad of ['app\nInjected line', 'https://evil.example/x', '']) {
      const s = setup();
      installNotifySecret({ transport: 'ntfy', topic: TOPIC }, s.owner);
      await push(s, [d('APP-1')], at('2026-11-05T10:00:00Z'), 'proj-a', bad);
      expect(s.sent[0]?.message).toBe('Blocked: APP-1 in ?');
    }
  });
});

describe('text, language and quiet hours', () => {
  it('speaks German when asked or when the locale says so', () => {
    expect(pushText([d('APP-1', 'merge_failed')], 'app', 'de')).toBe(
      'Merge fehlgeschlagen: APP-1 in app',
    );
    expect(pushText([d('APP-1'), d('APP-2')], 'app', 'de')).toBe('2 Entscheidungen nötig in app');
    const c = ownerConfigSchema.parse({});
    expect(pushLanguage(c, { LANG: 'de_DE.UTF-8' })).toBe('de');
    expect(pushLanguage(c, { LC_ALL: 'C', LANG: 'en_GB' })).toBe('en');
    expect(pushLanguage(ownerConfigSchema.parse({ notify: { language: 'de' } }), {})).toBe('de');
  });

  it('a window may span midnight; one within a day works too', () => {
    const z = 'UTC';
    expect(inQuietHours('22:00-07:00', at('2026-11-05T23:00:00Z'), z)).toBe(true);
    expect(inQuietHours('22:00-07:00', at('2026-11-05T06:59:00Z'), z)).toBe(true);
    expect(inQuietHours('22:00-07:00', at('2026-11-05T07:00:00Z'), z)).toBe(false);
    expect(inQuietHours('12:00-13:00', at('2026-11-05T12:30:00Z'), z)).toBe(true);
    expect(inQuietHours('12:00-13:00', at('2026-11-05T13:30:00Z'), z)).toBe(false);
    expect(inQuietHours(undefined, at('2026-11-05T23:00:00Z'), z)).toBe(false);
  });

  it('a self-hosted ntfy server is used for the push', async () => {
    const s = setup({ notify: { ntfyServer: 'https://ntfy.example.org' } });
    installNotifySecret({ transport: 'ntfy', topic: TOPIC }, s.owner);
    await push(s, [d('APP-1')], at('2026-11-05T10:00:00Z'));
    expect(s.posts[0]?.url).toBe(`https://ntfy.example.org/${TOPIC}`);
    for (const bad of [
      'http://ntfy.example.org',
      'https://u:p@x.org',
      'https://x.org/',
      'https://x.org?a=1',
    ]) {
      expect(() => ownerConfigSchema.parse({ notify: { ntfyServer: bad } })).toThrow();
    }
  });

  it('the owner config checks quiet hours and keeps channel and command together', () => {
    expect(() => ownerConfigSchema.parse({ notify: { quiet: '25:00-07:00' } })).toThrow();
    expect(() => ownerConfigSchema.parse({ notify: { quiet: '07:00-07:00' } })).toThrow();
    expect(() => ownerConfigSchema.parse({ notify: { channel: 'a' } })).toThrow();
    expect(ownerConfigSchema.parse({ notify: { quiet: '22:00-07:00' } }).notify?.quiet).toBe(
      '22:00-07:00',
    );
  });
});
