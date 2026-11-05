import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/** This plugin's own version; a test keeps it equal to package.json and plugin.json. */
export const STUDIO_VERSION = '0.12.0';

const HTTPS_GIT = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\.git)?$/;

/** One plugin crews need, at a fixed version: `name@marketplace`, never a version range. */
export const pluginPinSchema = z.strictObject({
  name: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must be name@marketplace'),
  version: z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/, 'must be one exact version'),
  // Where the marketplace comes from; only needed for one `setup-plugins` must add.
  marketplace: z.string().regex(HTTPS_GIT, 'must be a GitHub https URL').optional(),
});
export type PluginPin = z.infer<typeof pluginPinSchema>;

/** What Studio needs in a crew config dir when `plugins:` in studio.yaml names nothing else. */
export const DEFAULT_PLUGINS: readonly PluginPin[] = [
  {
    name: 'superpowers@superpowers-marketplace',
    version: '7.0.2',
    marketplace: 'https://github.com/obra/superpowers-marketplace.git',
  },
  {
    name: 'studio@studio-marketplace',
    version: STUDIO_VERSION,
    marketplace: 'https://github.com/Besser-Sehen-Landshut/studio.git',
  },
];

/** The defaults with the configured pins over them, by name; extra pins are added. */
export function pinnedPlugins(configured: readonly PluginPin[] = []): PluginPin[] {
  const out: PluginPin[] = DEFAULT_PLUGINS.map((d) => {
    const own = configured.find((c) => c.name === d.name);
    return own === undefined ? { ...d } : { ...d, ...own };
  });
  for (const c of configured) if (!out.some((o) => o.name === c.name)) out.push({ ...c });
  return out;
}

/** What `studio account setup-plugins` runs: each marketplace once, then each plugin. */
export function pluginCommands(pins: readonly PluginPin[]): string[][] {
  const markets = [...new Set(pins.flatMap((p) => p.marketplace ?? []))];
  return [
    ...markets.map((m) => ['plugin', 'marketplace', 'add', m]),
    ...pins.map((p) => ['plugin', 'install', p.name]),
  ];
}

const asVersion = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' && v.length <= 64 ? v : undefined;

/**
 * The version Claude Code recorded for each installed plugin in
 * `<config dir>/plugins/installed_plugins.json` ("records each install with its scope,
 * installPath, and version", https://code.claude.com/docs/en/plugins/loading). The layout around
 * those keys is not documented: an entry may be a list (the user scope wins) or one object.
 * Undefined when the file is missing or cannot be read.
 */
export function installedVersions(configDir: string): Map<string, string> | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(configDir, 'plugins', 'installed_plugins.json'), 'utf8'));
  } catch {
    return undefined;
  }
  const plugins = (raw as { plugins?: unknown } | null)?.plugins;
  if (plugins === null || typeof plugins !== 'object' || Array.isArray(plugins)) return undefined;
  const out = new Map<string, string>();
  for (const [id, entry] of Object.entries(plugins as Record<string, unknown>)) {
    const list = (Array.isArray(entry) ? entry : [entry]) as {
      scope?: unknown;
      version?: unknown;
    }[];
    const pick = list.find((e) => e?.scope === 'user') ?? list[0];
    const v = asVersion(pick?.version);
    if (v !== undefined) out.set(id, v);
  }
  return out;
}

/** Why a launch must not start: a pinned plugin is installed at another version. */
export function pinMismatch(configDir: string, pins: readonly PluginPin[]): string | undefined {
  const have = installedVersions(configDir);
  if (have === undefined) return undefined;
  for (const p of pins) {
    const v = have.get(p.name);
    if (v !== undefined && v !== p.version) {
      return `plugin ${p.name} is ${v} in ${configDir}, pinned ${p.version} (plugins: in studio.yaml); run studio account setup-plugins, or change the pin through a reviewed update item (studio skills check)`;
    }
  }
  return undefined;
}

/** Installed versions from `claude plugin list --json` (`id`, `version` per entry). */
export function listedVersions(stdout: string): Map<string, string> | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const list = Array.isArray(raw) ? raw : (raw as { installed?: unknown } | null)?.installed;
  if (!Array.isArray(list)) return undefined;
  const out = new Map<string, string>();
  for (const e of list as { id?: unknown; version?: unknown }[]) {
    const v = asVersion(e?.version);
    if (typeof e?.id === 'string' && v !== undefined) out.set(e.id, v);
  }
  return out;
}

const ADVISORY = /\b(security|vulnerab\w*|CVE-\d{4}-\d+|GHSA-[\w-]+|advisory)\b/i;

/**
 * What the marketplaces offer, from `claude plugin list --json --available` (`available[]` with
 * `pluginId` and the entry's `version`, when it declares one). An entry whose text names an
 * advisory, or that says `security: true`, counts as a security update.
 */
export function availableVersions(
  stdout: string,
): Map<string, { version: string; security: boolean }> | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const list = Array.isArray(raw) ? [] : (raw as { available?: unknown } | null)?.available;
  if (!Array.isArray(list)) return undefined;
  const out = new Map<string, { version: string; security: boolean }>();
  for (const e of list as Record<string, unknown>[]) {
    const v = asVersion(e?.version);
    if (typeof e?.pluginId !== 'string' || v === undefined) continue;
    const text = Object.values(e)
      .filter((x) => typeof x === 'string')
      .join(' ');
    out.set(e.pluginId, { version: v, security: e.security === true || ADVISORY.test(text) });
  }
  return out;
}

/**
 * Above 0 when `a` is newer than `b`. Numeric parts compare as numbers; a version that is no number
 * (a commit) can only be equal or not, and a different one counts as newer.
 */
export function compareVersions(a: string, b: string): number {
  const num = /^\d+(\.\d+)*$/;
  const core = (v: string) => v.replace(/^v/, '').split(/[-+]/)[0] ?? '';
  if (num.test(core(a)) && num.test(core(b))) {
    const pa = core(a).split('.').map(Number);
    const pb = core(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (d !== 0) return d;
    }
    return a === b ? 0 : a < b ? -1 : 1;
  }
  return a === b ? 0 : 1;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const names = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((n) => NAME.test(n));
  } catch {
    return [];
  }
};

/** Skills in `dir/skills/<n>/SKILL.md` and commands in `dir/commands/<n>.md`. */
function skillsIn(dir: string): string[] {
  return [
    ...names(join(dir, 'skills')).filter((n) => existsSync(join(dir, 'skills', n, 'SKILL.md'))),
    ...names(join(dir, 'commands'))
      .filter((n) => n.endsWith('.md'))
      .map((n) => n.slice(0, -3))
      .filter((n) => NAME.test(n)),
  ];
}

/**
 * Every skill a crew could invoke from this config dir: user skills by name, plugin skills and
 * commands as `<plugin>:<name>` from the plugin cache (`cache/<marketplace>/<plugin>/<version>`).
 */
export function installedSkills(configDir: string): string[] {
  const out = new Set(skillsIn(configDir));
  const cache = join(configDir, 'plugins', 'cache');
  for (const market of names(cache)) {
    for (const plugin of names(join(cache, market))) {
      for (const version of names(join(cache, market, plugin))) {
        for (const s of skillsIn(join(cache, market, plugin, version))) out.add(`${plugin}:${s}`);
      }
    }
  }
  return [...out];
}

const last = (s: string): string => s.slice(s.lastIndexOf(':') + 1);
const plain = (s: string): boolean =>
  s.split(':').length <= 2 && s.split(':').every((p) => NAME.test(p));

/** Whether an installed skill is one the brief names: by full name, or by name where one has no plugin. */
function named(skill: string, allowed: readonly string[]): boolean {
  return allowed.some(
    (a) => a === skill || ((!a.includes(':') || !skill.includes(':')) && last(a) === last(skill)),
  );
}

/**
 * `permissions.deny` rules for the crew settings: `Skill(<name>)` for every installed skill the
 * brief does not name, and for every denied one. Claude Code has no skill allowlist that holds in
 * `bypassPermissions` ("Allow rules have no effect in bypassPermissions"; "Deny rules block in
 * every mode", https://code.claude.com/docs/en/permission-modes), so the list is built from what
 * is installed. Bundled skills of Claude Code itself are not on disk and not listed.
 */
export function skillDenyRules(
  configDir: string,
  allowed: readonly string[],
  denied: readonly string[],
): string[] {
  const out = new Set<string>();
  for (const s of installedSkills(configDir)) if (!named(s, allowed)) out.add(s);
  for (const d of denied) if (plain(d)) out.add(d);
  return [...out].map((s) => `Skill(${s})`);
}
