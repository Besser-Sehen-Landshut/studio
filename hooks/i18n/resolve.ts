// Which language a person reads, from what they set. One chain for the pane and the pushes:
// an explicit choice (`/studio lang <code>` for the pane, `notify.language` for pushes), then Claude
// Code's `language` setting, then the locale (LC_ALL, LC_MESSAGES, LANG), then English.

export const FALLBACK_LANG = 'en';

/** What the chain needs of each locale. */
export interface Named {
  code: string;
  names: readonly string[];
}

/**
 * The language a value names: a registered code, English for a language without a locale file,
 * undefined when the value says nothing (unset, empty, `C`, `POSIX`). Reads a code or BCP 47 tag
 * (`de`, `de-AT`, `zh-Hant-TW`), a POSIX locale (`fr_FR.UTF-8`, `de_DE@euro`) or a name
 * (`german`, `Deutsch`).
 */
export function languageIn(
  value: string | undefined,
  locales: readonly Named[],
): string | undefined {
  if (value === undefined) return undefined;
  const v = value
    .trim()
    .toLowerCase()
    .replace(/[.@].*$/, '');
  if (v === '' || v === 'c' || v === 'posix') return undefined;
  const byName = locales.find((l) => l.code === v || l.names.includes(v));
  if (byName !== undefined) return byName.code;
  const primary = /^([a-z]{2,3})(?:[-_]|$)/.exec(v)?.[1];
  const byTag = primary === undefined ? undefined : locales.find((l) => l.code === primary);
  return byTag?.code ?? FALLBACK_LANG;
}

export interface LanguageInputs {
  /** The explicit choice: a code, or `auto` / undefined for none. A code without a locale is none. */
  override?: string | undefined;
  /** Claude Code's `language` setting. */
  setting?: string | undefined;
  /** The process environment: LC_ALL, LC_MESSAGES and LANG are read, in that order. */
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * The language to show. The first input that names a language decides; one without a locale file
 * means English (a person who set French reads English, not the locale's German).
 */
export function resolveLanguage(inputs: LanguageInputs, locales: readonly Named[]): string {
  const override = inputs.override?.trim().toLowerCase();
  if (override !== undefined && locales.some((l) => l.code === override)) return override;
  const fromSetting = languageIn(inputs.setting, locales);
  if (fromSetting !== undefined) return fromSetting;
  const env = inputs.env ?? {};
  for (const name of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const fromLocale = languageIn(env[name], locales);
    if (fromLocale !== undefined) return fromLocale;
  }
  return FALLBACK_LANG;
}
