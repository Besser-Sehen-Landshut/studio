// The wire between the lead and a relay worker (src/relay-lead.ts, src/relay-serve.ts). The lead
// opens one SSH session per request; the worker's key is forced to `studio relay serve`, which
// reads exactly one request from stdin and writes exactly one answer to stdout, then exits.
//
// A message is one JSON line (its header). A header with `payload: true` is followed by the
// payload in base64 chunk lines (`{"c":"..."}`) and one closing line with its size and SHA-256
// (`{"end":<bytes>,"sha256":"<hex>"}`). Every field is snake_case on the wire. Nothing here runs
// a command or touches a file: it only shapes and checks what crosses. Pure.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { WORKER_LABEL_RE } from './config.js';

/** The protocol version both sides speak; another one is refused, never guessed at. */
export const RELAY_PROTOCOL = 1;

/** One header line: a start request carries the token and the item, nothing near this size. */
export const MAX_HEADER_BYTES = 1024 * 1024;
/** The bundle of the pinned `main` (and `studio/<id>`) the lead sends with a start. */
export const MAX_START_BUNDLE_BYTES = 1024 * 1024 * 1024;
/** The bundle of `studio/<id>` a worker hands back: crew output, held small. */
export const MAX_RESULT_BUNDLE_BYTES = 256 * 1024 * 1024;
/** Raw bytes per chunk line (base64 makes a third more). */
export const CHUNK_BYTES = 48 * 1024;

export const RELAY_OPS = [
  'hello',
  'probe',
  'start',
  'status',
  'collect',
  'stop',
  'cleanup',
] as const;
export type RelayOp = (typeof RELAY_OPS)[number];

const ITEM_ID = z.string().regex(/^[A-Z]+-\d+$/);
const SHA = z.string().regex(/^[0-9a-f]{40}$/);
const REPO = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/);

/** One line in Studio's words from the other side: control characters gone, at most 300 long. */
export const relayLine = z
  .string()
  .max(4000)
  .transform((s) =>
    s
      .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
      .trim()
      .slice(0, 300),
  )
  .pipe(z.string().min(1));

/** What a start hands the worker: the item as an offer carries it, the commit, the credential. */
export const relayJobSchema = z.strictObject({
  id: ITEM_ID,
  label: z.string().regex(WORKER_LABEL_RE),
  /** The project's `primary_repo`: the worker keeps one mirror per primary repository. */
  repo: REPO,
  /** The pinned `origin/main` commit: the whole brief and the crew's start come from it. */
  sha: SHA,
  /** `main`, or `studio/<id>` to go on with what an earlier run pushed (a fix round). */
  from: z.string().regex(/^(main|studio\/[A-Z]+-\d+)$/),
  /** The head of `studio/<id>` the bundle carries when `from` names it. */
  fromSha: SHA.optional(),
  /** The item's board fields, exactly as an offer carries them (worker-claim.ts). */
  item: z.record(z.string(), z.unknown()),
  /** The crew's Claude token: held in memory on the worker, never written, never logged. */
  token: z.string().min(8).max(4096),
});
export type RelayJob = z.infer<typeof relayJobSchema>;

const base = { studioRelay: z.literal(RELAY_PROTOCOL) };
export const relayRequestSchema = z.discriminatedUnion('op', [
  z.strictObject({ ...base, op: z.literal('hello') }),
  z.strictObject({ ...base, op: z.literal('probe') }),
  z.strictObject({
    ...base,
    op: z.literal('start'),
    job: relayJobSchema,
    payload: z.literal(true),
  }),
  z.strictObject({ ...base, op: z.literal('status'), id: ITEM_ID }),
  z.strictObject({ ...base, op: z.literal('collect'), id: ITEM_ID }),
  z.strictObject({ ...base, op: z.literal('stop'), id: ITEM_ID }),
  z.strictObject({ ...base, op: z.literal('cleanup'), id: ITEM_ID }),
]);
export type RelayRequest = z.infer<typeof relayRequestSchema>;

/** Where a job on the worker stands. */
export const RELAY_STATES = [
  /** Handed to the runner; the probe and the launch are under way. */
  'starting',
  /** The crew runs. */
  'running',
  /** The crew has ended: collect. */
  'ended',
  /** Not now: the probe or the load held it; nothing ran. */
  'held',
  /** Refused for this machine or this item; nothing ran. */
  'refused',
  /** Stopped by the lead. */
  'stopped',
  /** The worker knows no such job. */
  'unknown',
] as const;
export type RelayState = (typeof RELAY_STATES)[number];

const usageSchema = z.strictObject({
  runs: z.number().int().min(0).max(1000),
  tokensIn: z.number().min(0).max(1e12),
  tokensOut: z.number().min(0).max(1e12),
  tokensCache: z.number().min(0).max(1e12),
  costUsd: z.number().min(0).max(100_000),
  estimated: z.literal(true).optional(),
});

const warnings = z.array(relayLine).max(50).default([]);

const failed = z.strictObject({
  ...base,
  ok: z.literal(false),
  kind: z.enum(['held', 'refused', 'error']),
  line: relayLine,
});

export const helloAnswer = z.strictObject({
  ...base,
  ok: z.literal(true),
  studio: z.string().regex(/^[0-9A-Za-z.+-]{1,64}$/),
  platform: z.string().regex(/^[a-z0-9]{1,16}$/),
  /** The plugins installed in the crew Claude config dir, by name; null when unreadable. */
  plugins: z.record(z.string().max(200), z.string().max(64)).nullable(),
  /** The item of a job that is starting or running: one crew at a time. */
  busy: ITEM_ID.nullable(),
  /** Why a start would be held now (busy, load, disk); the lead sends nothing then. */
  held: relayLine.nullable(),
  /**
   * For each pairing younger than an hour: HMAC-SHA256 of this worker's host key under the
   * pairing's secret (src/relay-pair.ts), which proves the host key to the lead that paired.
   */
  pairProofs: z
    .array(
      z.strictObject({
        label: z.string().regex(WORKER_LABEL_RE),
        mac: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .max(20)
    .default([]),
  warnings,
});
export const probeAnswer = z.strictObject({
  ...base,
  ok: z.literal(true),
  /** Why nothing could start now (`held`) or here at all (`refused`); null when all held. */
  problem: relayLine.nullable(),
  kind: z.enum(['held', 'refused']).nullable(),
  load: z
    .strictObject({ cpuPercent: z.number().min(0).max(100), freeDiskGb: z.number().min(0) })
    .nullable(),
  warnings,
});
export const startAnswer = z.strictObject({
  ...base,
  ok: z.literal(true),
  state: z.literal('starting'),
  warnings,
});
export const statusAnswer = z.strictObject({
  ...base,
  ok: z.literal(true),
  state: z.enum(RELAY_STATES),
  line: relayLine.nullable(),
});
export const collectAnswer = z.strictObject({
  ...base,
  ok: z.literal(true),
  report: z.string().max(256 * 1024),
  /** The head of `studio/<id>` in the payload, when there is one. */
  headSha: SHA.nullable(),
  payload: z.boolean(),
  usage: usageSchema.nullable(),
  /** The crew ended at a usage limit of its credential: the lead parks the label it gave. */
  limit: z
    .strictObject({
      kind: z.enum(['session', 'weekly']),
      resetsAt: z.string().max(40).nullable(),
    })
    .nullable(),
  /** The crew's account was blocked: the lead records it for the label it gave. */
  block: z.boolean(),
  /** Why nothing usable came back (no report, a branch that differs): the lead blocks the item. */
  problem: relayLine.nullable(),
});
export const doneAnswer = z.strictObject({ ...base, ok: z.literal(true) });

export type HelloAnswer = z.infer<typeof helloAnswer>;
export type ProbeAnswer = z.infer<typeof probeAnswer>;
export type StatusAnswer = z.infer<typeof statusAnswer>;
export type CollectAnswer = z.infer<typeof collectAnswer>;
export type RelayFailure = z.infer<typeof failed>;

const ANSWERS = {
  hello: helloAnswer,
  probe: probeAnswer,
  start: startAnswer,
  status: statusAnswer,
  collect: collectAnswer,
  stop: doneAnswer,
  cleanup: doneAnswer,
} as const;
export type RelayAnswer<O extends RelayOp> = z.infer<(typeof ANSWERS)[O]>;

const snake = (k: string): string => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const camel = (k: string): string => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Keys to snake_case, deep; the item's fields are snake_case already and stay as they are. */
function toWire(v: unknown, key = ''): unknown {
  if (Array.isArray(v)) return v.map((x) => toWire(x));
  if (v === null || typeof v !== 'object' || key === 'item' || key === 'plugins') return v;
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => [snake(k), toWire(x, k)]),
  );
}

function fromWire(v: unknown, key = ''): unknown {
  if (Array.isArray(v)) return v.map((x) => fromWire(x));
  if (v === null || typeof v !== 'object' || key === 'item' || key === 'plugins') return v;
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>).map(([k, x]) => {
      const c = camel(k);
      return [c, fromWire(x, c)];
    }),
  );
}

/** The lines of one message: its header and, with a payload, the chunks and the closing line. */
export function* encodeMessage(header: object, payload?: Uint8Array): Generator<string> {
  const wire = toWire({ ...header, ...(payload === undefined ? {} : { payload: true }) });
  yield `${JSON.stringify(wire)}\n`;
  if (payload === undefined) return;
  for (let at = 0; at < payload.length; at += CHUNK_BYTES) {
    const part = Buffer.from(
      payload.buffer,
      payload.byteOffset + at,
      Math.min(CHUNK_BYTES, payload.length - at),
    );
    yield `${JSON.stringify({ c: part.toString('base64') })}\n`;
  }
  yield `${JSON.stringify({ end: payload.length, sha256: sha256(payload) })}\n`;
}

export const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** Splits a byte stream into lines; refuses a line longer than `max` before it is all read. */
export class LineReader {
  private buf = '';
  private lines: string[] = [];
  private ended = false;
  private waiting: (() => void) | undefined;
  private error: Error | undefined;
  private total = 0;
  private stopped = false;

  constructor(
    input: AsyncIterable<Uint8Array | string>,
    private readonly max: number,
    /** All bytes the stream may bring: past it, reading stops with an error. */
    private readonly maxTotal = Number.POSITIVE_INFINITY,
  ) {
    void (async () => {
      try {
        for await (const chunk of input) {
          if (this.stopped) break;
          this.total += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
          if (this.total > this.maxTotal)
            throw new Error('the relay answer is larger than allowed');
          this.buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
          let nl = this.buf.indexOf('\n');
          while (nl >= 0) {
            this.lines.push(this.buf.slice(0, nl));
            this.buf = this.buf.slice(nl + 1);
            nl = this.buf.indexOf('\n');
          }
          if (this.buf.length > this.max)
            throw new Error('a line of the relay protocol is too long');
          this.wake();
        }
      } catch (e) {
        this.error = e as Error;
      }
      this.ended = true;
      this.wake();
    })();
  }

  /** Reads nothing more: what the stream still brings is dropped. */
  stop(): void {
    this.stopped = true;
    this.lines = [];
    this.buf = '';
  }

  private wake() {
    const w = this.waiting;
    this.waiting = undefined;
    w?.();
  }

  /** The next line, or undefined at the end of the stream. */
  async next(): Promise<string | undefined> {
    for (;;) {
      const line = this.lines.shift();
      if (line !== undefined) {
        if (line.length > this.max) throw new Error('a line of the relay protocol is too long');
        return line;
      }
      if (this.error !== undefined) throw this.error;
      if (this.ended) return undefined;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
    }
  }
}

/**
 * Reads one message: a header line and, when it says so, its payload, checked against its size,
 * the cap and its SHA-256. The header comes back with camelCase keys, still unchecked.
 */
export async function readMessage(
  reader: LineReader,
  maxPayload: number,
): Promise<{ header: Record<string, unknown>; payload?: Buffer } | undefined> {
  const line = await reader.next();
  if (line === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error('the relay message is not JSON');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('the relay message is not an object');
  }
  const header = fromWire(raw) as Record<string, unknown>;
  if (header.payload !== true) return { header };
  const parts: Buffer[] = [];
  let size = 0;
  for (;;) {
    const l = await reader.next();
    if (l === undefined) throw new Error('the relay payload ended early');
    let m: { c?: unknown; end?: unknown; sha256?: unknown };
    try {
      m = JSON.parse(l) as typeof m;
    } catch {
      throw new Error('a relay payload line is not JSON');
    }
    if (typeof m.c === 'string') {
      const b = Buffer.from(m.c, 'base64');
      size += b.length;
      if (size > maxPayload) throw new Error('the relay payload is larger than allowed');
      parts.push(b);
      continue;
    }
    const payload = Buffer.concat(parts);
    if (m.end !== payload.length || m.sha256 !== sha256(payload)) {
      throw new Error('the relay payload does not match its size or checksum');
    }
    return { header, payload };
  }
}

/** Parses a request header strictly; a version or shape Studio does not know refuses. */
export function parseRequest(header: Record<string, unknown>): RelayRequest {
  if (header.studioRelay !== RELAY_PROTOCOL) {
    throw new Error(
      `relay protocol ${String(header.studioRelay)} is not ${RELAY_PROTOCOL}; update Studio on both machines`,
    );
  }
  const r = relayRequestSchema.safeParse(header);
  if (!r.success) throw new Error('the relay request has an unknown shape');
  return r.data;
}

/** Parses the worker's answer to `op`: a failure, or exactly the answer that op has. */
export function parseAnswer<O extends RelayOp>(
  op: O,
  header: Record<string, unknown>,
): RelayAnswer<O> | RelayFailure {
  if (header.studioRelay !== RELAY_PROTOCOL) {
    throw new Error(
      `the relay worker speaks protocol ${String(header.studioRelay)}, not ${RELAY_PROTOCOL}; update Studio on both machines`,
    );
  }
  if (header.ok === false) {
    const f = failed.safeParse(header);
    if (!f.success) throw new Error('the relay worker answered with an unknown failure');
    return f.data;
  }
  const r = ANSWERS[op].safeParse(header);
  if (!r.success) throw new Error(`the relay worker's answer to ${op} has an unknown shape`);
  return r.data as RelayAnswer<O>;
}
