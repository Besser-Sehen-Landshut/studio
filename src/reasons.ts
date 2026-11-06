// Studio's own English lines that reach the pane, the toasts and the pushes (owner lines, holds of
// items and of the queue) as a code and its values, so each language words them itself. The English
// line stays in the state beside the code: the fallback for a code a language has no words for,
// and what the details view and the CLI print. Crew text never gets a code: only Studio's phrases
// at the start of a line are matched.
import type { Reason } from '../hooks/i18n/index.js';

export type { Reason };

/** A value of a reason: ids, labels, numbers and times only, at most 100 characters. */
const value = (s: string | undefined): string | undefined => {
  const v = s?.trim();
  return v !== undefined && v !== '' && v.length <= 100 && !/[\p{Cc}\p{Cf}]/u.test(v)
    ? v
    : undefined;
};

type Rule = [RegExp, string, ((m: RegExpExecArray) => Reason['params'] | undefined)?];

const RULES: readonly Rule[] = [
  [/^paused: /, 'paused'],
  [/^usage limit: every crew credential is at its configured limit/, 'usage_full'],
  [
    /^usage limit: no crew credential available; earliest reset (\S+)$/,
    'usage_parked',
    (m) => {
      const reset = value(m[1]);
      return reset === undefined || reset === 'unknown' ? undefined : { reset };
    },
  ],
  [/^usage limit state is unreadable/, 'limits_unreadable'],
  [/^usage\.json is unreadable/, 'usage_unreadable'],
  [/^credential provider returned nothing/, 'provider_empty'],
  [/^credential provider(?: failed|:)/, 'provider_failed'],
  [/^credential limit\b/, 'credential_limit'],
  [/^account block state is unreadable/, 'account_block_unreadable'],
  [
    /^account block on (.+?): all crew stopped/,
    'account_block',
    (m) => {
      const labels = value(m[1]);
      return labels === undefined ? undefined : { labels };
    },
  ],
  [/^crew records of a project are unreadable/, 'crew_records_unreadable'],
  [/^old project state files are not migrated yet/, 'legacy_state'],
  [
    /^(?:another launch is in progress|queue already running|another tick is running|another Studio process is reconciling)/,
    'busy',
  ],
  [/^(?:[A-Z]+-\d+: )?ci pending\b/, 'ci_pending'],
  [/^pull request opened in this tick/, 'next_tick'],
  [
    /^waiting on (.+)$/,
    'waiting_on',
    (m) => {
      const items = value(m[1]);
      return items === undefined ? undefined : { items };
    },
  ],
  [/^role wip full$/, 'role_wip'],
  [/^component (\S+) wip full$/, 'component_wip', (m) => ({ component: value(m[1]) ?? '?' })],
  [/^overlaps ([A-Z]+-\d+)$/, 'overlaps', (m) => ({ item: m[1] as string })],
  [/^host load\b/, 'host_load'],
  [/^lead work: /, 'lead_work'],
  [/^ci capacity\b/, 'ci_capacity'],
  [
    /^offered to (\S+) \(#(\d+)\), not claimed yet$/,
    'worker_offered',
    (m) => ({ label: value(m[1]) ?? '?', offer: Number(m[2]) }),
  ],
  [
    /^(\S+)'s \S+ commit awaits its comment$/,
    'worker_awaits',
    (m) => ({ worker: value(m[1]) ?? '?' }),
  ],
  [
    /^claim of (\S+) expired \(no heartbeat for (\d+) min\)/,
    'worker_expired',
    (m) => ({ worker: value(m[1]) ?? '?', minutes: Number(m[2]) }),
  ],
  [
    /^on (\S+) \((\S+)\), heartbeat (\d+) min ago$/,
    'worker_on',
    (m) => ({ worker: value(m[1]) ?? '?', label: value(m[2]) ?? '?', minutes: Number(m[3]) }),
  ],
  [
    /^no worker is accepted for the label (\S+)/,
    'worker_none',
    (m) => ({ label: value(m[1]) ?? '?' }),
  ],
];

/** Every code `reasonOf` gives: each locale words them (a test holds English and German to it). */
export const REASON_CODES: readonly string[] = [...new Set(RULES.map((r) => r[1]))];

/** `<id> is not in the current plan: <why>`: the why is the reason. */
const NOT_IN_PLAN = /^[A-Z]+-\d+ is not in the current plan: (.+)$/;

/** The code of one of Studio's English lines; undefined for a line it does not know. */
export function reasonOf(line: string): Reason | undefined {
  const text = line.trim();
  const inner = NOT_IN_PLAN.exec(text)?.[1];
  if (inner !== undefined) return reasonOf(inner);
  for (const [re, code, params] of RULES) {
    const m = re.exec(text);
    if (m === null) continue;
    const p = params?.(m);
    return p === undefined ? { code } : { code, params: p };
  }
  return undefined;
}
