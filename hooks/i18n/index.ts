// The languages Studio ships and the one way to get a language's texts. The list comes from the
// registry hooks/locales/index.ts, which scripts/gen-locales.mjs writes from the locale files in
// that folder: adding a language is adding one file there.
import { LOCALES } from '../locales/index.js';
import type { Locale, Strings } from './messages.js';
import { FALLBACK_LANG, type LanguageInputs, languageIn, resolveLanguage } from './resolve.js';

export type { Locale, Params, PushKind, QueueStep, Reason, Strings } from './messages.js';
export { FALLBACK_LANG, type LanguageInputs } from './resolve.js';

/** A language code with a locale file. */
export type Lang = string;

export interface I18n {
  /** Every language code with a locale file, sorted. */
  langs: readonly Lang[];
  isLang: (v: unknown) => v is Lang;
  /** A language's texts merged over English; English for a code without a locale. */
  stringsFor: (lang: Lang | undefined) => Strings;
  /** The language a setting or locale value names (see languageIn). */
  langOf: (value: string | undefined) => Lang | undefined;
  resolve: (inputs: LanguageInputs) => Lang;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** `over` on top of `base`, records key by key: what `over` leaves out stays as in `base`. */
function merge(base: Strings, over: Locale['strings']): Strings {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    const b = out[k];
    out[k] = isRecord(b) && isRecord(v) ? { ...b, ...v } : v;
  }
  return out as unknown as Strings;
}

/** The registry's functions over a list of locales; one of them must be English and complete. */
export function createI18n(locales: readonly Locale[]): I18n {
  const english = locales.find((l) => l.code === FALLBACK_LANG);
  if (english === undefined) throw new Error('no English locale');
  const base = english.strings as Strings;
  const langs = locales.map((l) => l.code).sort();
  const merged = new Map<string, Strings>();
  const stringsFor = (lang: Lang | undefined): Strings => {
    const code = lang !== undefined && langs.includes(lang) ? lang : FALLBACK_LANG;
    let s = merged.get(code);
    if (s === undefined) {
      const locale = locales.find((l) => l.code === code) as Locale;
      s = code === FALLBACK_LANG ? base : merge(base, locale.strings);
      merged.set(code, s);
    }
    return s;
  };
  return {
    langs,
    isLang: (v: unknown): v is Lang => typeof v === 'string' && langs.includes(v),
    stringsFor,
    langOf: (value) => languageIn(value, locales),
    resolve: (inputs) => resolveLanguage(inputs, locales),
  };
}

const shipped = createI18n(LOCALES);

export const LANGS = shipped.langs;
export const isLang = shipped.isLang;
export const stringsFor = shipped.stringsFor;
export const langOf = shipped.langOf;
/** The pane's and the pushes' language: the same chain for both. */
export const resolveLang = shipped.resolve;
