// The language of the setup flows (`studio setup`, `account add`, `relay pair`, `relay install`):
// `notify.language` of the owner config, then Claude Code's language setting, then the locale,
// English for anything without a locale file. The texts are in hooks/locales.
import { resolveLang, type SetupStrings, stringsFor } from '../hooks/i18n/index.js';
import { claudeLanguage } from './claude-language.js';
import { loadOwnerConfig, type OwnerEnv } from './config.js';

export function setupText(o: {
  owner: OwnerEnv;
  project?: string;
  env: Record<string, string | undefined>;
}): SetupStrings {
  let override: string | undefined;
  try {
    override = loadOwnerConfig(o.owner).notify?.language;
  } catch {
    override = undefined;
  }
  return stringsFor(
    resolveLang({ override, setting: claudeLanguage(o.owner, o.project), env: o.env }),
  ).setup;
}
