// A neutral scenario for the pane's views: one decision, work running, waiting and ready, epics
// with progress and merges today. No real project, person or host.
export const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

export function scenario(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project: 'shop',
    crew: [
      {
        role: 'builder',
        item: 'APP-17',
        state: 'working',
        title: 'Backup log line',
        since: ago(4),
      },
      {
        role: 'reviewer',
        item: 'APP-20',
        state: 'working',
        title: 'Review of APP-14',
        since: ago(12),
      },
    ],
    queue: {
      current: { pr: 31, repo: 'org/shop', step: 'capacity', item: 'APP-12' },
      pending: [],
    },
    ci: { busy: 6, total: 8, mergeMaxBusy: 5, ok: true },
    today: {
      day: '2026-11-01',
      merged: [
        { pr: 27, repo: 'org/shop', at: ago(300), item: 'APP-11', epic: 'E-3' },
        { pr: 28, repo: 'org/shop', at: ago(200), item: 'APP-18', epic: 'E-4' },
        { pr: 29, repo: 'org/shop', at: ago(100), item: 'APP-10' },
      ],
      deployed: 1,
    },
    mainBuild: { status: 'green' },
    counts: { ready: 2, queued: 1 },
    forOwner: [],
    epics: [
      { id: 'E-3', title: 'Connection limits', status: 'open', merged: 1, total: 4 },
      { id: 'E-4', title: 'Privacy tests', status: 'open', merged: 1, total: 3 },
    ],
    items: [
      {
        id: 'APP-15',
        title: 'Retry on timeout',
        stage: 'blocked',
        epic: 'E-3',
        since: ago(30),
        wait: { code: 'blocked', text: 'fix limit reached: 6 review rounds' },
      },
      { id: 'APP-14', title: 'Header timeout', stage: 'review', epic: 'E-3', since: ago(12) },
      { id: 'APP-16', title: 'Idle timeout', stage: 'ready', epic: 'E-3' },
      { id: 'APP-17', title: 'Backup log line', stage: 'building', epic: 'E-4', since: ago(4) },
      { id: 'APP-19', title: 'More log tests', stage: 'ready', epic: 'E-4' },
      {
        id: 'APP-12',
        title: 'Duplicate header lines',
        stage: 'queued',
        since: ago(3),
        wait: { code: 'ci_capacity', text: 'waiting for CI capacity', busy: 6, total: 8, max: 5 },
      },
    ],
    needsLead: [
      {
        item: 'APP-15',
        code: 'fix_limit',
        reason: 'fix limit reached: 6 review rounds',
        next: { say: 'show APP-15' },
      },
    ],
    wip: { building: 4, review: 2 },
    updatedAt: ago(1),
    metrics: { medianLeadTimeHours: 3.1, perDay: {} },
    ...over,
  };
}
