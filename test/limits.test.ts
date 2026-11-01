import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isLegalMove } from '../src/board.js';
import {
  activeParks,
  detectLimit,
  earliestReset,
  parkUntil,
  readLimits,
  scanLogForLimit,
  sessionIdSince,
  writeLimits,
} from '../src/limits.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-limits-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const stateDir = (): string => {
  const d = join(root, `s${n++}`);
  mkdirSync(join(d, 'logs'), { recursive: true });
  return d;
};

const WEEKLY = "You've hit your weekly limit · resets Nov 3, 9am";
const SESSION = "You've hit your session limit · resets 3pm";
const NOW = new Date('2026-11-01T10:00:00Z');

describe('detectLimit', () => {
  it('detectLimit parses weekly text with reset', () => {
    expect(detectLimit(WEEKLY)).toEqual({ kind: 'weekly', resetsAt: 'Nov 3, 9am' });
  });

  it('parses session text with reset and without reset', () => {
    expect(detectLimit(SESSION)).toEqual({ kind: 'session', resetsAt: '3pm' });
    expect(detectLimit("You've hit your session limit")).toEqual({ kind: 'session' });
  });

  it('matches the other wordings; only weekly maps to weekly', () => {
    for (const words of ['limit', 'usage limit', '5-hour limit', 'Opus limit', 'Sonnet limit']) {
      expect(detectLimit(`You've hit your ${words}`), words).toEqual({ kind: 'session' });
      expect(detectLimit(`You’ve hit your ${words} · resets 3pm`), words).toEqual({
        kind: 'session',
        resetsAt: '3pm',
      });
    }
  });

  it('takes other segments before or after the reset', () => {
    expect(detectLimit("You've hit your limit · progress saved")).toEqual({ kind: 'session' });
    expect(detectLimit("You've hit your weekly limit · resets 3pm · progress saved")).toEqual({
      kind: 'weekly',
      resetsAt: '3pm',
    });
    expect(detectLimit("You've hit your Opus limit · progress saved · resets 3pm")).toEqual({
      kind: 'session',
      resetsAt: '3pm',
    });
  });

  it('still matches only the whole string', () => {
    for (const text of [
      "You've hit your limit of patience",
      "You've hit your limit.",
      "You've hit your limit ·",
      "You've hit your limit · · resets 3pm",
      "You've hit your limit · resets 3pm\nand more",
      "You've hit your",
      "You've hit your  limit",
      "you've hit your limit",
      "You've hit your weekly limit today · resets 3pm",
    ]) {
      expect(
        detectLimit(JSON.stringify({ type: 'result', is_error: true, result: text })),
        text,
      ).toBeUndefined();
    }
  });

  it('new wordings stay event-aware: a model answer or tool output does not count', () => {
    const text = "You've hit your usage limit";
    expect(detectLimit(JSON.stringify({ type: 'result', result: text }))).toBeUndefined();
    expect(detectLimit(JSON.stringify({ type: 'user', text }))).toBeUndefined();
    expect(detectLimit(`tool said: ${text}`)).toBeUndefined();
    expect(detectLimit(JSON.stringify({ type: 'result', is_error: true, result: text }))).toEqual({
      kind: 'session',
    });
  });

  it('detectLimit parses rate_limit retry event', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'api_retry', error: 'rate_limit' });
    expect(detectLimit(line)).toEqual({ kind: 'session' });
  });

  it('keeps an absolute reset carried by the retry event', () => {
    const iso = JSON.stringify({
      type: 'system',
      subtype: 'api_retry',
      error: 'rate_limit',
      resets_at: '2026-11-01T12:00:00Z',
    });
    expect(detectLimit(iso)).toEqual({ kind: 'session', resetsAt: '2026-11-01T12:00:00Z' });
    const epoch = JSON.stringify({
      type: 'system',
      subtype: 'api_retry',
      error: 'rate_limit',
      resetsAt: 1793000000,
    });
    expect(detectLimit(epoch)).toEqual({ kind: 'session', resetsAt: '1793000000' });
  });

  it('matches the limit text as error text of a result event', () => {
    expect(detectLimit(JSON.stringify({ type: 'result', is_error: true, result: WEEKLY }))).toEqual(
      { kind: 'weekly', resetsAt: 'Nov 3, 9am' },
    );
    expect(detectLimit(JSON.stringify({ type: 'result', error: SESSION }))).toEqual({
      kind: 'session',
      resetsAt: '3pm',
    });
  });

  it('matches the limit text of an assistant message flagged as an API error', () => {
    const msg = { content: [{ type: 'text', text: SESSION }] };
    expect(
      detectLimit(JSON.stringify({ type: 'assistant', isApiErrorMessage: true, message: msg })),
    ).toEqual({ kind: 'session', resetsAt: '3pm' });
    expect(
      detectLimit(JSON.stringify({ type: 'assistant', error: 'rate_limit', message: msg })),
    ).toEqual({ kind: 'session', resetsAt: '3pm' });
  });

  describe('negatives: crew output is untrusted', () => {
    const cases: [string, unknown][] = [
      [
        'tool result in a user message',
        { type: 'user', message: { content: [{ type: 'tool_result', content: WEEKLY }] } },
      ],
      [
        'top-level text on a user event',
        { type: 'user', error: 'rate_limit', result: WEEKLY, subtype: 'api_retry' },
      ],
      [
        'ordinary assistant text',
        { type: 'assistant', message: { content: [{ type: 'text', text: WEEKLY }] } },
      ],
      ['successful result text', { type: 'result', is_error: false, result: WEEKLY }],
      ['result without is_error', { type: 'result', result: WEEKLY }],
      [
        'result that only quotes the text',
        { type: 'result', is_error: true, result: `x ${WEEKLY}` },
      ],
      [
        'nested retry event',
        { type: 'user', event: { type: 'system', subtype: 'api_retry', error: 'rate_limit' } },
      ],
      ['retry with another error', { type: 'system', subtype: 'api_retry', error: 'server_error' }],
      ['system event of another subtype', { type: 'system', subtype: 'init', error: 'rate_limit' }],
    ];
    for (const [name, ev] of cases) {
      it(name, () => {
        expect(detectLimit(JSON.stringify(ev))).toBeUndefined();
      });
    }

    it('a non-JSON line matches only at its start', () => {
      expect(detectLimit(`tool said: ${WEEKLY}`)).toBeUndefined();
      expect(detectLimit(`  ${WEEKLY}`)).toBeUndefined();
      expect(detectLimit("You've hit your weekly limit of patience")).toBeUndefined();
    });

    it('a JSON scalar or a torn JSON line never matches', () => {
      expect(detectLimit(JSON.stringify(WEEKLY))).toBeUndefined();
      expect(detectLimit(`{"type":"user","x":"${WEEKLY}`)).toBeUndefined();
      expect(detectLimit('')).toBeUndefined();
    });
  });
});

describe('parkUntil', () => {
  const hourLater = new Date(NOW.getTime() + 3_600_000);

  it('uses an ISO time or an epoch', () => {
    expect(parkUntil('2026-11-01T12:00:00Z', NOW)).toEqual(new Date('2026-11-01T12:00:00Z'));
    const epoch = Math.floor(new Date('2026-11-01T13:00:00Z').getTime() / 1000);
    expect(parkUntil(String(epoch), NOW)).toEqual(new Date('2026-11-01T13:00:00Z'));
    expect(parkUntil(String(epoch * 1000), NOW)).toEqual(new Date('2026-11-01T13:00:00Z'));
  });

  it('does not guess local-time phrases: one hour from now', () => {
    for (const phrase of ['3pm', 'Nov 3, 9am', 'Nov 3 2026', '12/01/2026', 'tomorrow']) {
      expect(parkUntil(phrase, NOW)).toEqual(hourLater);
    }
    expect(parkUntil(undefined, NOW)).toEqual(hourLater);
  });

  it('a time in the past or absurdly far ahead is not believed', () => {
    expect(parkUntil('2026-10-01T12:00:00Z', NOW)).toEqual(hourLater);
    expect(parkUntil('2999-01-01T00:00:00Z', NOW)).toEqual(hourLater);
  });
});

describe('limits file', () => {
  it('missing file means nothing parked', () => {
    expect(readLimits(stateDir())).toEqual({ ok: true, labels: {} });
  });

  it('round-trips and filters expired parks', () => {
    const s = stateDir();
    writeLimits(s, {
      'label-a': { parkedUntil: '2026-11-01T11:00:00.000Z', kind: 'session' },
      'label-b': { parkedUntil: '2026-11-01T09:00:00.000Z', kind: 'weekly' },
    });
    const read = readLimits(s);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const parks = activeParks(read.labels, NOW);
    expect(Object.keys(parks)).toEqual(['label-a']);
    expect(earliestReset(parks)).toBe('2026-11-01T11:00:00.000Z');
  });

  it('anything unexpected is unreadable (fail closed)', () => {
    const bad = [
      'not json',
      '[]',
      '{"label-a":{"parkedUntil":"soon"}}',
      '{"label-a":{"parkedUntil":"2026-11-01T11:00:00Z","extra":1}}',
      '{"bad label":{}}',
      '{"__proto__":{}}',
      '{"label-a":5}',
    ];
    for (const body of bad) {
      const s = stateDir();
      writeFileSync(join(s, 'limits.json'), body);
      expect(readLimits(s).ok, body).toBe(false);
    }
  });

  it('a symlinked limits file is unreadable', () => {
    const s = stateDir();
    writeFileSync(join(s, 'elsewhere.json'), '{}');
    symlinkSync(join(s, 'elsewhere.json'), join(s, 'limits.json'));
    expect(readLimits(s).ok).toBe(false);
  });
});

describe('scanLogForLimit', () => {
  const retry = JSON.stringify({ type: 'system', subtype: 'api_retry', error: 'rate_limit' });
  const result = JSON.stringify({ type: 'result', is_error: true, result: WEEKLY });

  it('returns the last limit event from the given offset on', () => {
    const s = stateDir();
    writeFileSync(join(s, 'logs', 'APP-1.jsonl'), `${retry}\nnoise\n${result}\n`);
    expect(scanLogForLimit(s, 'APP-1', 0)?.kind).toBe('weekly');
  });

  it('ignores what an earlier run appended before its start offset', () => {
    const s = stateDir();
    const early = `${result}\n`;
    writeFileSync(join(s, 'logs', 'APP-1.jsonl'), `${early}{"type":"system"}\n`);
    expect(scanLogForLimit(s, 'APP-1', Buffer.byteLength(early))).toBeUndefined();
  });

  it('reads a bounded tail and drops the torn first line', () => {
    const s = stateDir();
    // The log is longer than the tail: the head is out of reach and the first tail line is torn.
    const long = `{"type":"user","text":"${'x'.repeat(300_000)}"}\n`;
    writeFileSync(join(s, 'logs', 'APP-1.jsonl'), `You've hit your weekly limit\n${long}`);
    expect(scanLogForLimit(s, 'APP-1', 0)).toBeUndefined();
    // The tail would start exactly at limit-looking text inside a tool output line.
    const tail = 256 * 1024;
    const inner = `You've hit your weekly limit\n`;
    const filler = 'y'.repeat(tail - inner.length);
    writeFileSync(join(s, 'logs', 'APP-3.jsonl'), `{"text":"abc${inner}${filler}`);
    expect(scanLogForLimit(s, 'APP-3', 0)).toBeUndefined();
    writeFileSync(join(s, 'logs', 'APP-2.jsonl'), `${long}${result}\n`);
    expect(scanLogForLimit(s, 'APP-2', 0)?.kind).toBe('weekly');
  });

  describe('retries', () => {
    const scan = (...events: unknown[]) => {
      const s = stateDir();
      const body = events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n');
      writeFileSync(join(s, 'logs', 'APP-1.jsonl'), `${body}\n`);
      return scanLogForLimit(s, 'APP-1', 0);
    };
    const retryEv = { type: 'system', subtype: 'api_retry', error: 'rate_limit' };
    const assistant = { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } };

    it('a retry followed by an assistant event or a good result is recovered', () => {
      expect(scan(retryEv, assistant)).toBeUndefined();
      expect(scan(retryEv, { type: 'result', is_error: false, result: 'done' })).toBeUndefined();
      expect(scan(retryEv, { type: 'result', result: 'done' })).toBeUndefined();
      expect(scan(retryEv, assistant, retryEv, assistant)).toBeUndefined();
    });

    it('a retry with nothing recovering it is reported as retry only', () => {
      expect(scan(retryEv)).toEqual({ kind: 'session', retryOnly: true });
      expect(scan(assistant, retryEv)).toEqual({ kind: 'session', retryOnly: true });
      expect(scan(retryEv, { type: 'user', message: { content: [] } }, 'noise')).toEqual({
        kind: 'session',
        retryOnly: true,
      });
    });

    it('error events do not recover a retry', () => {
      const apiError = { ...assistant, isApiErrorMessage: true };
      const flagged = { ...assistant, error: 'server_error' };
      const failed = { type: 'result', is_error: true, result: 'boom' };
      for (const ev of [apiError, flagged, failed]) {
        expect(scan(retryEv, ev)).toEqual({ kind: 'session', retryOnly: true });
      }
    });

    it('terminal limit text counts at once, after a retry and after later events', () => {
      const terminal = { type: 'result', is_error: true, result: WEEKLY };
      expect(scan(retryEv, terminal)).toEqual({ kind: 'weekly', resetsAt: 'Nov 3, 9am' });
      expect(scan(terminal, assistant)).toEqual({ kind: 'weekly', resetsAt: 'Nov 3, 9am' });
      expect(scan(WEEKLY, retryEv)).toEqual({ kind: 'weekly', resetsAt: 'Nov 3, 9am' });
    });

    it('detectLimit itself still parses the retry event', () => {
      expect(detectLimit(JSON.stringify(retryEv))).toEqual({ kind: 'session' });
    });
  });

  it('a missing or symlinked log finds nothing', () => {
    const s = stateDir();
    expect(scanLogForLimit(s, 'APP-1', 0)).toBeUndefined();
    writeFileSync(join(s, 'real.jsonl'), `${result}\n`);
    symlinkSync(join(s, 'real.jsonl'), join(s, 'logs', 'APP-2.jsonl'));
    expect(scanLogForLimit(s, 'APP-2', 0)).toBeUndefined();
  });
});

describe('sessionIdSince', () => {
  it('reads the first session id from the offset and refuses unsafe ids', () => {
    const s = stateDir();
    const first = `${JSON.stringify({ type: 'system', session_id: 'old-run' })}\n`;
    writeFileSync(
      join(s, 'logs', 'APP-1.jsonl'),
      `${first}${JSON.stringify({ type: 'system', session_id: 'new-run' })}\n`,
    );
    expect(sessionIdSince(s, 'APP-1', 0)).toBe('old-run');
    expect(sessionIdSince(s, 'APP-1', Buffer.byteLength(first))).toBe('new-run');
    writeFileSync(
      join(s, 'logs', 'APP-2.jsonl'),
      `${JSON.stringify({ type: 'system', session_id: '--dangerous' })}\n`,
    );
    expect(sessionIdSince(s, 'APP-2', 0)).toBeUndefined();
  });
});

describe('board move back to ready', () => {
  it('a stopped run may return to ready', () => {
    expect(isLegalMove('assigned', 'ready', false)).toBe(true);
    expect(isLegalMove('in_progress', 'ready', false)).toBe(true);
    expect(isLegalMove('in_review', 'ready', false)).toBe(false);
  });
});
