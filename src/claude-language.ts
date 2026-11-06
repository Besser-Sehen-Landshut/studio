// Claude Code's `language` setting, read the way the board mod's `$.settings` sees it, so a push
// and the pane resolve the same language: the project's `.claude/settings.local.json`, then its
// `.claude/settings.json`, then the user's `settings.json` (in CLAUDE_CONFIG_DIR, else ~/.claude).
// Read only; a file that is missing, a link, too large or not JSON is skipped.
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { OwnerEnv } from './config.js';

const MAX_BYTES = 1024 * 1024;

function languageIn(file: string): string | undefined {
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size > MAX_BYTES) return undefined;
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const language = (raw as { language?: unknown }).language;
    return typeof language === 'string' && language.trim() !== '' ? language : undefined;
  } catch {
    return undefined;
  }
}

/** The `language` setting that applies in `projectDir` (or the user's alone without one). */
export function claudeLanguage(owner: OwnerEnv = {}, projectDir?: string): string | undefined {
  const env = owner.env ?? process.env;
  const configDir =
    env.CLAUDE_CONFIG_DIR !== undefined && isAbsolute(env.CLAUDE_CONFIG_DIR)
      ? env.CLAUDE_CONFIG_DIR
      : join(owner.homedir ?? homedir(), '.claude');
  const files = [
    ...(projectDir === undefined
      ? []
      : [
          join(projectDir, '.claude', 'settings.local.json'),
          join(projectDir, '.claude', 'settings.json'),
        ]),
    join(configDir, 'settings.json'),
  ];
  for (const file of files) {
    const language = languageIn(file);
    if (language !== undefined) return language;
  }
  return undefined;
}
