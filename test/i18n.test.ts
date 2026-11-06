import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { formatRuntime } from '../hooks/board-model.js';
import { formatter } from '../hooks/i18n/format.js';
import {
  type I18n,
  isLang,
  LANGS,
  langOf,
  resolveLang,
  type Strings,
  stringsFor,
} from '../hooks/i18n/index.js';
import { LOCALES } from '../hooks/locales/index.js';
// @ts-expect-error: a plain .mjs script without types.
import { localeIndex, writeLocaleIndex } from '../scripts/gen-locales.mjs';
import { claudeLanguage } from '../src/claude-language.js';
import { ownerConfigSchema } from '../src/config.js';
import { allParkedLine } from '../src/credentials.js';
import { LEAD_WORK } from '../src/lessons-review.js';
import { blockLine } from '../src/limits.js';
import { PAUSED_LINE } from '../src/pause.js';
import { CI_PENDING, ONE_BUILD_PER_PLAN } from '../src/planner.js';
import { pushLanguage, pushText, testPushText } from '../src/push.js';
import { REASON_CODES, reasonOf } from '../src/reasons.js';
import {
  LABEL_FULL_LINE,
  PROVIDER_EMPTY_LINE,
  PROVIDER_HOLD_LINE,
  USAGE_UNREADABLE,
} from '../src/usage.js';

const repo = join(import.meta.dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'studio-i18n-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

describe('the locale files', () => {
  const en = LOCALES.find((l) => l.code === 'en');

  it('ship English and German, sorted, from the registry', () => {
    expect(LANGS).toEqual(['de', 'en']);
    expect(LOCALES.map((l) => l.code).sort()).toEqual(LANGS);
  });

  it('the registry lists exactly the locale files in the folder (run pnpm locales)', () => {
    const dir = join(repo, 'hooks', 'locales');
    expect(readFileSync(join(dir, 'index.ts'), 'utf8')).toBe(localeIndex(dir));
  });

  it('each locale is the file named by its code', () => {
    for (const l of LOCALES) {
      expect(l.code).toMatch(/^[a-z]{2,3}$/);
      const text = readFileSync(join(repo, 'hooks', 'locales', `${l.code}.ts`), 'utf8');
      expect(text).toContain(`code: '${l.code}'`);
      for (const name of l.names) expect(name).toBe(name.toLowerCase());
    }
  });

  it('English is complete and leaves nothing to another language', () => {
    expect(en?.english).toBeUndefined();
    // Strings is the type; this checks the value too, should a cast have hidden a gap.
    for (const [k, v] of Object.entries(en?.strings ?? {})) expect(v, k).toBeDefined();
  });

  it('every locale covers every text, or names the ones it leaves to English on purpose', () => {
    const base = (en?.strings ?? {}) as Record<string, unknown>;
    for (const l of LOCALES) {
      const own = l.strings as Record<string, unknown>;
      const left = new Set<string>(l.english ?? []);
      for (const key of Object.keys(own))
        expect(base, `${l.code}: ${key} is no text`).toHaveProperty(key);
      for (const [key, value] of Object.entries(base)) {
        if (left.has(key)) {
          expect(own[key], `${l.code}: ${key} is left to English but given`).toBeUndefined();
          continue;
        }
        expect(own[key], `${l.code} misses ${key}`).toBeDefined();
        if (isRecord(value)) {
          const sub = own[key];
          expect(isRecord(sub), `${l.code}: ${key} is a record`).toBe(true);
          if (isRecord(sub))
            expect(Object.keys(sub).sort(), `${l.code}: ${key}`).toEqual(Object.keys(value).sort());
        } else {
          expect(typeof own[key], `${l.code}: ${key}`).toBe(typeof value);
        }
      }
    }
  });

  it('every reason code Studio gives has words in every shipped language', () => {
    for (const lang of LANGS) {
      for (const code of REASON_CODES) {
        expect(stringsFor(lang).reason({ code }), `${lang}: ${code}`).toBeTypeOf('string');
      }
    }
  });

  it('a code from a file is never an object key', () => {
    for (const lang of LANGS) {
      const t = stringsFor(lang);
      expect(t.decision('constructor')).toBe(t.decision('other'));
      expect(t.blockReason('toString')).toBe('toString');
      expect(t.releaseStatus('hasOwnProperty', [])).toBe('hasOwnProperty');
      expect(t.reason({ code: '__proto__' })).toBeUndefined();
    }
  });
});

describe('adding a language', () => {
  /** A copy of the shared texts with one more locale file, and its registry written by the script. */
  async function withLocale(file: string, text: string): Promise<I18n & { index: string }> {
    const root = mkdtempSync(join(tmp, 'copy-'));
    mkdirSync(join(root, 'hooks'));
    for (const dir of ['i18n', 'locales']) {
      cpSync(join(repo, 'hooks', dir), join(root, 'hooks', dir), { recursive: true });
    }
    // messages.ts imports types from the board model; types are erased, so a stub does.
    writeFileSync(join(root, 'hooks', 'board-model.ts'), 'export {};\n');
    writeFileSync(join(root, 'hooks', 'locales', file), text);
    writeLocaleIndex(join(root, 'hooks', 'locales'));
    const mod = (await import(join(root, 'hooks', 'i18n', 'index.ts'))) as {
      LANGS: readonly string[];
      isLang: I18n['isLang'];
      stringsFor: I18n['stringsFor'];
      langOf: I18n['langOf'];
      resolveLang: I18n['resolve'];
    };
    return {
      langs: mod.LANGS,
      isLang: mod.isLang,
      stringsFor: mod.stringsFor,
      langOf: mod.langOf,
      resolve: mod.resolveLang,
      index: readFileSync(join(root, 'hooks', 'locales', 'index.ts'), 'utf8'),
    };
  }

  const STUB = [
    "import { defineLocale } from '../i18n/messages.js';",
    '',
    "export default defineLocale({ code: 'xx', names: ['xxish'], strings: {",
    "  paused: 'XX paused.',",
    "  crewState: { working: 'xx-working' },",
    '} });',
    '',
  ].join('\n');

  it('is one file: a stub xx locale is picked up, chosen and merged over English', async () => {
    const i = await withLocale('xx.ts', STUB);
    expect(i.index).toContain("import locale_xx from './xx.js';");
    expect(i.langs).toEqual(['de', 'en', 'xx']);
    expect(i.isLang('xx')).toBe(true);
    expect(i.resolve({ env: { LANG: 'xx_XX.UTF-8' } })).toBe('xx');
    expect(i.resolve({ setting: 'xxish' })).toBe('xx');
    expect(i.resolve({ override: 'xx', setting: 'german' })).toBe('xx');
    const t = i.stringsFor('xx');
    expect(t.paused).toBe('XX paused.');
    // What the stub leaves out is English, record entries one by one.
    expect(t.crewState.working).toBe('xx-working');
    expect(t.crewState.waiting).toBe('waiting');
    expect(t.opened).toBe(stringsFor('en').opened);
    expect(t.decisions(2)).toBe('! 2 decisions needed');
  });

  it('a file whose name is no language code is not a locale', async () => {
    const i = await withLocale('notes.ts', 'export const x = 1;\n');
    expect(i.langs).toEqual(['de', 'en']);
  });
});

describe('an unknown language', () => {
  it.each([
    [{ setting: 'français' }],
    [{ setting: 'fr' }],
    [{ env: { LANG: 'fr_FR.UTF-8' } }],
    [{ env: { LC_ALL: 'ja_JP.UTF-8', LANG: 'de_DE.UTF-8' } }],
    [{ override: 'fr' }],
    [{ override: 'auto' }],
    [{}],
  ])('falls back to English: %j', (inputs) => {
    expect(resolveLang(inputs)).toBe('en');
  });

  it('has the English texts, and is no language to choose', () => {
    expect(stringsFor('fr')).toBe(stringsFor('en'));
    expect(stringsFor(undefined)).toBe(stringsFor('en'));
    expect(isLang('fr')).toBe(false);
    expect(langOf('klingon')).toBe('en');
  });

  it('a setting that names no language passes on to the locale', () => {
    expect(resolveLang({ setting: '', env: { LANG: 'de_DE.UTF-8' } })).toBe('de');
    expect(resolveLang({ env: { LC_ALL: 'C', LANG: 'de_AT.UTF-8' } })).toBe('de');
    expect(resolveLang({ env: { LC_ALL: 'C.UTF-8', LC_MESSAGES: 'de_DE@euro' } })).toBe('de');
  });
});

describe('the pane and the pushes', () => {
  const cases: [string | undefined, string | undefined, Record<string, string>][] = [
    [undefined, undefined, {}],
    [undefined, 'german', { LANG: 'en_US.UTF-8' }],
    [undefined, 'English', { LANG: 'de_DE.UTF-8' }],
    [undefined, undefined, { LANG: 'de_DE.UTF-8' }],
    [undefined, undefined, { LC_ALL: 'en_GB', LANG: 'de_DE' }],
    ['auto', 'deutsch', {}],
    ['en', 'german', { LANG: 'de_DE' }],
    ['de', 'english', {}],
    [undefined, 'français', { LANG: 'de_DE' }],
  ];

  it.each(cases)(
    'resolve one language from the same inputs (%s, %s, %j)',
    (override, setting, env) => {
      const config = ownerConfigSchema.parse(
        override === undefined ? {} : { notify: { language: override } },
      );
      expect(pushLanguage(config, env, setting)).toBe(resolveLang({ override, setting, env }));
    },
  );

  it('notify.language takes any shipped code or auto, nothing else', () => {
    for (const language of [...LANGS, 'auto']) {
      expect(ownerConfigSchema.safeParse({ notify: { language } }).success, language).toBe(true);
    }
    for (const language of ['fr', 'EN', 'german', '', 'en-US']) {
      expect(ownerConfigSchema.safeParse({ notify: { language } }).success, language).toBe(false);
    }
  });

  it("read Claude Code's setting: project local, then project, then the user's", () => {
    const home = mkdtempSync(join(tmp, 'home-'));
    const project = mkdtempSync(join(tmp, 'project-'));
    mkdirSync(join(home, '.claude'));
    mkdirSync(join(project, '.claude'));
    const owner = { homedir: home, env: {} };
    expect(claudeLanguage(owner, project)).toBeUndefined();
    writeFileSync(join(home, '.claude', 'settings.json'), '{"language":"german"}');
    expect(claudeLanguage(owner, project)).toBe('german');
    expect(claudeLanguage(owner)).toBe('german');
    writeFileSync(join(project, '.claude', 'settings.json'), '{"language":"english"}');
    expect(claudeLanguage(owner, project)).toBe('english');
    writeFileSync(join(project, '.claude', 'settings.local.json'), '{"language":"deutsch"}');
    expect(claudeLanguage(owner, project)).toBe('deutsch');
    writeFileSync(join(project, '.claude', 'settings.local.json'), 'not json');
    expect(claudeLanguage(owner, project)).toBe('english');
    const config = mkdtempSync(join(tmp, 'config-'));
    writeFileSync(join(config, 'settings.json'), '{"language":"de"}');
    expect(claudeLanguage({ homedir: home, env: { CLAUDE_CONFIG_DIR: config } })).toBe('de');
  });
});

describe("Studio's lines as codes", () => {
  it.each([
    [PAUSED_LINE, { code: 'paused' }],
    [LABEL_FULL_LINE, { code: 'usage_full' }],
    [
      allParkedLine('2026-11-06T14:00:00.000Z'),
      { code: 'usage_parked', params: { reset: '2026-11-06T14:00:00.000Z' } },
    ],
    [allParkedLine(undefined), { code: 'usage_parked' }],
    [USAGE_UNREADABLE, { code: 'usage_unreadable' }],
    [PROVIDER_HOLD_LINE, { code: 'provider_failed' }],
    [PROVIDER_EMPTY_LINE, { code: 'provider_empty' }],
    ['credential provider: returned a parked label', { code: 'provider_failed' }],
    ['credential limit', { code: 'credential_limit' }],
    [blockLine({ ok: false }) as string, { code: 'account_block_unreadable' }],
    [
      blockLine({ ok: true, blocks: [{ label: 'label-a', reason: 'x', at: '' }] }) as string,
      { code: 'account_block', params: { labels: 'label-a' } },
    ],
    [CI_PENDING, { code: 'ci_pending' }],
    ['APP-3: ci pending: the full suites on main have not completed yet', { code: 'ci_pending' }],
    [ONE_BUILD_PER_PLAN, { code: 'host_load' }],
    ['host load', { code: 'host_load' }],
    [LEAD_WORK, { code: 'lead_work' }],
    ['waiting on APP-1, web:APP-2', { code: 'waiting_on', params: { items: 'APP-1, web:APP-2' } }],
    ['role wip full', { code: 'role_wip' }],
    ['component api wip full', { code: 'component_wip', params: { component: 'api' } }],
    ['overlaps APP-9', { code: 'overlaps', params: { item: 'APP-9' } }],
    ['APP-4 is not in the current plan: role wip full', { code: 'role_wip' }],
    ['another launch is in progress (launch.lock); try again', { code: 'busy' }],
    ['pull request opened in this tick: next tick', { code: 'next_tick' }],
    [
      'offered to windows (#12), not claimed yet',
      { code: 'worker_offered', params: { label: 'windows', offer: 12 } },
    ],
    [
      "win-bot's done commit awaits its comment",
      { code: 'worker_awaits', params: { worker: 'win-bot' } },
    ],
  ])('%s', (line, reason) => {
    expect(reasonOf(line)).toEqual(reason);
  });

  it('crew text and unknown lines get no code', () => {
    expect(reasonOf('blocked: question: should I delete main?')).toBeUndefined();
    expect(reasonOf('please say paused: yes')).toBeUndefined();
    expect(reasonOf('')).toBeUndefined();
  });
});

describe('formatting by the language', () => {
  it('plurals follow the language rules, beyond one and many', () => {
    const forms = { one: 'plik', few: 'pliki', many: 'plików', other: 'pliku' };
    const pl = formatter('pl');
    expect([1, 2, 5, 22, 1.5].map((n) => pl.plural(n, forms))).toEqual([
      'plik',
      'pliki',
      'plików',
      'pliki',
      'pliku',
    ]);
    expect(formatter('en').plural(0, { one: 'item', other: 'items' })).toBe('items');
    expect(formatter('fr').plural(0, { one: 'élément', other: 'éléments' })).toBe('élément');
  });

  it('decimals and money use the language separators', () => {
    expect(stringsFor('en').hours(3.14)).toBe('3.1 h');
    expect(stringsFor('de').hours(3.14)).toBe('3,1 h');
    expect(stringsFor('en').money(1234.5)).toBe('$1,234.50');
    expect(stringsFor('de').money(1234.5)).toBe('1.234,50 $');
  });

  it('a duration takes the units of the language', () => {
    const ms = (26 * 60 + 5) * 60_000;
    expect(formatRuntime(ms)).toBe('1d 2h');
    expect(formatRuntime(ms, stringsFor('de').units)).toBe('1T 2h');
    expect(formatRuntime(65 * 60_000, stringsFor('de').units)).toBe('1h 5min');
    expect(formatRuntime(-1, stringsFor('de').units)).toBe('0s');
  });
});

/** Every text of a language with sample values: what the snapshots hold. */
function sample(t: Strings): Record<keyof Strings, unknown> {
  const wait = { code: 'held', text: 'English fallback' };
  return {
    units: [t.units.s(5), t.units.m(3), t.units.h(2), t.units.d(1)],
    money: [t.money(0.5), t.money(1234.5)],
    hours: t.hours(3.14),
    missing: t.missing,
    unreadable: t.unreadable,
    paused: t.paused,
    status: [t.status(1, 1, 1, '1/8', 1), t.status(2, 0, 3, '?/8', 0)],
    statusPaused: t.statusPaused,
    forYou: t.forYou('Sign it'),
    accountBlocked: [t.accountBlocked('label-a', 'x'), t.accountBlocked('', 'x')],
    blockReason: [
      'authentication_failed',
      'organization_not_allowed',
      'organization_disabled',
      'account_on_hold',
      'account_disabled',
      'policy_violation',
      'state_unreadable',
      'something_new',
    ].map(t.blockReason),
    mainRed: [t.mainRed('abc1234'), t.mainRed('')],
    crashed: t.crashed('builder', 'APP-1'),
    more: [t.more(1), t.more(2)],
    crewState: t.crewState,
    crossCutting: t.crossCutting,
    noComponent: t.noComponent,
    noCrew: t.noCrew,
    accepting: t.accepting,
    reopened: t.reopened,
    epicDone: t.epicDone,
    now: t.now,
    next: t.next,
    queueEmpty: t.queueEmpty,
    queueStep: t.queueStep,
    mergedTodayList: t.mergedTodayList,
    ciUnreadable: t.ciUnreadable,
    mergeRule: [t.mergeRule(5, 8, false), t.mergeRule(5, 8, true)],
    headEpics: t.headEpics,
    headCrew: t.headCrew,
    headQueue: t.headQueue,
    headForYou: t.headForYou(2),
    headForLead: t.headForLead(2),
    headExceptions: t.headExceptions(2),
    headReleases: t.headReleases(2),
    releaseStatus: [
      'announced',
      'approvals',
      'triggered',
      'checking',
      'done',
      'failed',
      'stopped',
      'new',
    ].map((s) => t.releaseStatus(s, ['owner', 'qa'])),
    exceptionBy: ['evidence', 'owner', 'lead'].map(t.exceptionBy),
    leadTimeLine: t.leadTimeLine('3,1 h', 2),
    headDays: t.headDays,
    headUsage: t.headUsage,
    lastUpdate: t.lastUpdate(14),
    updated: [t.updated(0), t.updated(5)],
    stale: t.stale,
    pausedTag: t.pausedTag,
    decisions: [t.decisions(1), t.decisions(2)],
    running: [t.running(1), t.running(2)],
    waiting: [t.waiting(1), t.waiting(2)],
    today: t.today(3),
    decisionHead: t.decisionHead,
    say: t.say('show APP-1'),
    word: t.word,
    stage: t.stage,
    done: t.done(2),
    doneToday: t.doneToday(2),
    withoutEpic: t.withoutEpic,
    leadTime: t.leadTime('3,1 h'),
    costToday: t.costToday('$1.00'),
    decision: [
      'fix_limit',
      'changes_requested',
      'merge_failed',
      'question',
      'evidence',
      'blocked',
      'release_approval',
      'release_failed',
      'analyzer_timeout',
      'rea_install',
      'other',
    ].map(t.decision),
    reason: Object.fromEntries(
      REASON_CODES.map((code) => [
        code,
        t.reason({
          code,
          params: {
            reset: '14:00',
            labels: 'label-a',
            items: 'APP-1',
            component: 'api',
            item: 'APP-2',
            label: 'windows',
            offer: 12,
            worker: 'win-bot',
            minutes: 3,
          },
        }),
      ]),
    ),
    wait: [
      'ci_capacity',
      'checks_pending',
      'review_pending',
      'queue_held',
      'queue_position',
      'updating',
      'merging',
      'held',
      'worker',
      'other',
    ].map((code) => [
      t.wait({ ...wait, code, busy: 6, total: 8, max: 5, position: 2 }, 'why'),
      t.wait({ ...wait, code }, 'why'),
    ]),
    waitShort: [
      'ci_capacity',
      'worker',
      'checks_pending',
      'review_pending',
      'queue_position',
      'updating',
      'merging',
      'held',
    ].map((code) => [
      t.waitShort({ ...wait, code, busy: 6, total: 8, position: 2 }),
      t.waitShort({ ...wait, code }),
    ]),
    column: t.column,
    full: t.full,
    blocked: t.blocked,
    emptyTitle: t.emptyTitle,
    emptyHint: t.emptyHint,
    emptyExample: t.emptyExample,
    pausedSince: [t.pausedSince('14:02'), t.pausedSince(undefined)],
    staleBanner: t.staleBanner(14),
    staleQuestion: t.staleQuestion,
    staleSay: t.staleSay,
    groupTitle: t.groupTitle('shop'),
    groupMain: t.groupMain,
    groupHere: t.groupHere,
    groupNone: t.groupNone,
    groupIdle: t.groupIdle,
    groupProblem: ['no state yet', 'state unreadable', 'folder cannot be read', 'other'].map(
      t.groupProblem,
    ),
    groupBack: t.groupBack('shop'),
    groupOpen: t.groupOpen,
    reaConfirm: [t.reaConfirm('1.2.3', true), t.reaConfirm('1.2.3', false)],
    paneTitle: t.paneTitle,
    commandDescription: t.commandDescription,
    usage: t.usage('list | lang de|en|auto'),
    notInProject: t.notInProject,
    openFailed: t.openFailed,
    opened: t.opened,
    pauseNeedsTerminal: t.pauseNeedsTerminal('studio pause'),
    resumeNeedsTerminal: t.resumeNeedsTerminal('studio resume'),
    viewReply: t.viewReply,
    focusReply: t.focusReply('web'),
    noProjectReply: t.noProjectReply('web'),
    languageSet: t.languageSet,
    offReply: t.offReply,
    onReply: t.onReply,
    offPane: t.offPane,
    reaConfirmed: t.reaConfirmed,
    reaNotConfirmed: t.reaNotConfirmed,
    push: t.push,
    pushOne: t.pushOne(t.push.fix_limit, 'APP-3', 'app'),
    pushMany: [t.pushMany(1, 'app', false), t.pushMany(3, 'app', true)],
    pushTest: t.pushTest,
  };
}

describe('snapshots of every text', () => {
  it.each(['en', 'de'])('%s', (lang) => {
    expect(sample(stringsFor(lang))).toMatchSnapshot();
  });

  it('pushes are worded through the same tables', () => {
    const d = (kind: 'fix_limit' | 'account_block') => ({
      key: kind,
      item: 'APP-3',
      kind,
      urgent: false,
    });
    expect(pushText([d('fix_limit')], 'app', 'de')).toBe('Fix-Limit erreicht: APP-3 in app');
    expect(pushText([d('fix_limit'), d('account_block')], 'app', 'en')).toBe(
      '2 decisions needed in app: account blocked',
    );
    expect(testPushText('de')).toBe(stringsFor('de').pushTest);
  });
});
