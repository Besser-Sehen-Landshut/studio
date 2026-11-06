import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isAlias, isMap, isScalar, parseDocument, visit, type YAMLMap } from 'yaml';
import { z } from 'zod';

/** This plugin's own version; a test keeps it equal to package.json and plugin.json. */
export const STUDIO_VERSION = '0.22.0';

const HTTPS_GIT = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\.git)?$/;

/** One exact version, as pins, marketplaces and the CLI must give it; anything else is dropped. */
export const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const PLUGIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** One plugin crews need, at a fixed version: `name@marketplace`, never a version range. */
export const pluginPinSchema = z.strictObject({
  name: z.string().regex(PLUGIN_ID_RE, 'must be name@marketplace'),
  version: z.string().regex(VERSION_RE, 'must be one exact version'),
  // Must match the default's or the owner's marketplace: a project cannot bring its own.
  marketplace: z.string().regex(HTTPS_GIT, 'must be a GitHub https URL').optional(),
});
export type PluginPin = z.infer<typeof pluginPinSchema>;

/**
 * A plugin and marketplace the owner allows beyond the defaults, in the owner config
 * (`allowed_plugins`), outside every repository: a project's studio.yaml can pin it, never add it.
 */
export const allowedPluginSchema = z.strictObject({
  name: z.string().regex(PLUGIN_ID_RE, 'must be name@marketplace'),
  marketplace: z.string().regex(HTTPS_GIT, 'must be a GitHub https URL'),
});
export type AllowedPlugin = z.infer<typeof allowedPluginSchema>;

/** A project config that tries to change where a plugin comes from. */
export class PluginTrustError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginTrustError';
  }
}

/** Shown in place of a version that is no plain version: the text itself never is. */
export const INVALID_VERSION = '(not a plain version)';

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

/**
 * The defaults with the project's versions over them. studio.yaml is repository content: it may
 * pin a version, never change a marketplace (that throws), and an extra plugin counts only when
 * the owner config allows it, with the owner's marketplace; one that is not allowed is left out.
 */
export function pinnedPlugins(
  configured: readonly PluginPin[] = [],
  allowed: readonly AllowedPlugin[] = [],
): PluginPin[] {
  const swap = (name: string, want: string | undefined, got: string | undefined) => {
    if (got !== undefined && got !== want) {
      throw new PluginTrustError(
        `studio.yaml may not change the marketplace of ${name}; a marketplace comes from the defaults or from allowed_plugins in the owner config`,
      );
    }
  };
  const out: PluginPin[] = DEFAULT_PLUGINS.map((d) => {
    const own = configured.find((c) => c.name === d.name);
    swap(d.name, d.marketplace, own?.marketplace);
    return own === undefined ? { ...d } : { ...d, version: own.version };
  });
  for (const c of configured) {
    if (out.some((o) => o.name === c.name)) continue;
    const owner = allowed.find((a) => a.name === c.name);
    if (owner === undefined) continue;
    swap(c.name, owner.marketplace, c.marketplace);
    out.push({ name: c.name, version: c.version, marketplace: owner.marketplace });
  }
  return out;
}

/** Extra plugins studio.yaml names that the owner config does not allow: never installed. */
export function unallowedPlugins(
  configured: readonly PluginPin[] = [],
  allowed: readonly AllowedPlugin[] = [],
): string[] {
  return configured
    .filter(
      (c) =>
        !DEFAULT_PLUGINS.some((d) => d.name === c.name) && !allowed.some((a) => a.name === c.name),
    )
    .map((c) => c.name);
}

/** What `studio account setup-plugins` runs: each marketplace once, then each plugin. */
export function pluginCommands(pins: readonly PluginPin[]): string[][] {
  const markets = [...new Set(pins.flatMap((p) => p.marketplace ?? []))];
  return [
    ...markets.map((m) => ['plugin', 'marketplace', 'add', m]),
    ...pins.map((p) => ['plugin', 'install', p.name]),
  ];
}

/** A version from outside Studio: kept only when it is a plain version. */
const asVersion = (v: unknown): string | undefined =>
  typeof v === 'string' && VERSION_RE.test(v) ? v : undefined;
const recorded = (v: unknown): string | undefined =>
  v === undefined || v === null ? undefined : (asVersion(v) ?? INVALID_VERSION);

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
  for (const { id, entry } of pluginEntries(plugins as Record<string, unknown>)) {
    const v = recorded(entry.version);
    if (v !== undefined) out.set(id, v);
  }
  return out;
}

type Entry = { scope?: unknown; version?: unknown; installPath?: unknown };

/** One entry per plugin id: the user scope wins. */
function pluginEntries(plugins: Record<string, unknown>): { id: string; entry: Entry }[] {
  const out: { id: string; entry: Entry }[] = [];
  for (const [id, raw] of Object.entries(plugins)) {
    const list = (Array.isArray(raw) ? raw : [raw]) as (Entry | null)[];
    const entry = list.find((e) => e?.scope === 'user') ?? list[0];
    if (entry !== null && typeof entry === 'object') out.push({ id, entry });
  }
  return out;
}

/** Where each installed plugin lives, from `installed_plugins.json` (`installPath`). */
function installPaths(configDir: string): { plugin: string; dir: string }[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(configDir, 'plugins', 'installed_plugins.json'), 'utf8'));
  } catch {
    return [];
  }
  const plugins = (raw as { plugins?: unknown } | null)?.plugins;
  if (plugins === null || typeof plugins !== 'object' || Array.isArray(plugins)) return [];
  return pluginEntries(plugins as Record<string, unknown>).flatMap(({ id, entry }) =>
    typeof entry.installPath === 'string' && entry.installPath !== ''
      ? [
          {
            plugin: id.slice(0, id.indexOf('@') < 0 ? id.length : id.indexOf('@')),
            dir: entry.installPath,
          },
        ]
      : [],
  );
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
    const v = recorded(e?.version);
    if (typeof e?.id === 'string' && PLUGIN_ID_RE.test(e.id) && v !== undefined) out.set(e.id, v);
  }
  return out;
}

const ADVISORY = /\b(security|vulnerab\w*|CVE-\d{4}-\d+|GHSA-[\w-]+|advisory)\b/i;

/**
 * What the marketplaces offer, from `claude plugin list --json --available` (`available[]` with
 * `pluginId` and the entry's `version`, when it declares one). Marketplace data is untrusted: an
 * entry whose id or version is not plain is dropped and named under `dropped` (by its id when that
 * is plain). An entry whose text names an advisory, or that says `security: true`, counts as a
 * security update.
 */
export function availableVersions(stdout: string):
  | {
      offered: Map<string, { version: string; security: boolean }>;
      dropped: string[];
    }
  | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const list = Array.isArray(raw) ? [] : (raw as { available?: unknown } | null)?.available;
  if (!Array.isArray(list)) return undefined;
  const offered = new Map<string, { version: string; security: boolean }>();
  const dropped: string[] = [];
  for (const e of list as Record<string, unknown>[]) {
    if (e === null || typeof e !== 'object' || e.version === undefined) continue;
    const id =
      typeof e.pluginId === 'string' && PLUGIN_ID_RE.test(e.pluginId) ? e.pluginId : undefined;
    const v = asVersion(e.version);
    if (id === undefined || v === undefined) {
      dropped.push(id ?? '(an entry without a plain id)');
      continue;
    }
    const text = Object.values(e)
      .filter((x) => typeof x === 'string')
      .join(' ');
    offered.set(id, { version: v, security: e.security === true || ADVISORY.test(text) });
  }
  return { offered, dropped };
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
const MAX_SKILL_BYTES = 256 * 1024;

const entriesOf = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** The `name:` of a SKILL.md front matter, unquoted; undefined when there is none. */
export type FrontmatterName =
  | { kind: 'none' }
  | { kind: 'name'; name: string }
  /** Anything Studio cannot read for sure: the skill is refused, never guessed. */
  | { kind: 'invalid' };

/**
 * The `name` of a SKILL.md front matter, read with the YAML parser: after an optional byte order
 * mark, a first line of exactly `---`, a closing line of exactly `---`, unique keys, and `name` a
 * plain string. No front matter at all is `none` (the directory names the skill); everything
 * ambiguous (no closing line, a header that does not parse, two `name` keys, a list or number, an
 * unreadable or oversized file) is `invalid`.
 */
/**
 * Front matter must be a strict subset of YAML: a map with plain string keys at the top, and no
 * anchor, alias, tag or merge key (`<<`) anywhere in it. Values of other keys may nest (a
 * `metadata:` block, a list); `name` is checked on its own.
 */
function strictFlat(map: YAMLMap): boolean {
  for (const pair of map.items) {
    const key = pair.key;
    if (!isScalar(key) || typeof key.value !== 'string') return false;
  }
  let clean = true;
  visit(map, {
    Node(_, node) {
      if (isAlias(node)) clean = false;
      else if (
        (node as { anchor?: unknown }).anchor !== undefined ||
        (node as { tag?: unknown }).tag !== undefined
      ) {
        clean = false;
      }
      return clean ? undefined : visit.BREAK;
    },
    Pair(_, pair) {
      if (isScalar(pair.key) && pair.key.value === '<<') clean = false;
      return clean ? undefined : visit.BREAK;
    },
  });
  return clean;
}

export function frontmatterName(file: string): FrontmatterName {
  let text: string;
  try {
    if (statSync(file).size > MAX_SKILL_BYTES) return { kind: 'invalid' };
    text = readFileSync(file, 'utf8');
  } catch {
    return { kind: 'invalid' };
  }
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  // Front matter that does not start the file, or a delimiter with more on its line, may be read
  // otherwise by Claude Code: refused, never guessed.
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0 || !(lines[first] ?? '').trimStart().startsWith('---')) return { kind: 'none' };
  if (first !== 0 || lines[0] !== '---') return { kind: 'invalid' };
  const end = lines.indexOf('---', 1);
  if (end < 0) return { kind: 'invalid' };
  const doc = parseDocument(lines.slice(1, end).join('\n'), { uniqueKeys: true });
  if (doc.errors.length > 0) return { kind: 'invalid' };
  const contents = doc.contents;
  if (contents === null) return { kind: 'none' };
  if (!isMap(contents) || !strictFlat(contents)) return { kind: 'invalid' };
  const names = contents.items.filter((i) => isScalar(i.key) && i.key.value === 'name');
  if (names.length === 0) return { kind: 'none' };
  const value = names[0]?.value;
  if (names.length > 1 || !isScalar(value) || typeof value.value !== 'string') {
    return { kind: 'invalid' };
  }
  return { kind: 'name', name: value.value };
}

interface Found {
  names: Set<string>;
  /** Where a skill sits whose name cannot become a `Skill(...)` rule. */
  invalid: string[];
}

/**
 * Skills in `dir/skills/<d>/SKILL.md`, named by their front matter (else the directory), and
 * commands in `dir/commands/<n>.md`, each with `prefix` (a plugin name and a colon).
 */
function collect(dir: string, prefix: string, found: Found): void {
  const add = (name: string, where: string) => {
    if (NAME.test(name)) found.names.add(`${prefix}${name}`);
    else found.invalid.push(where);
  };
  const skills = join(dir, 'skills');
  for (const d of entriesOf(skills)) {
    const file = join(skills, d, 'SKILL.md');
    if (!isDir(join(skills, d)) || !existsSync(file)) continue;
    const where = join(skills, d);
    const front = frontmatterName(file);
    if (front.kind === 'invalid') {
      found.invalid.push(where);
      continue;
    }
    add(front.kind === 'name' ? front.name : d, where);
    // The directory name is a second way in: deny it too, and refuse one no rule can hold.
    if (front.kind === 'name' && front.name !== d) add(d, where);
  }
  walkCommands(join(dir, 'commands'), [], prefix, found);
}

const MAX_COMMAND_DEPTH = 8;

/**
 * Commands below `commands/`, named as Claude Code names them: the path below `commands/` with
 * each `/` as `:`, then the file name without `.md` (`commands/db/migrate.md` is `db:migrate`,
 * https://code.claude.com/docs/en/skills and /plugins/components). Which name a `Skill(...)` rule
 * matches for a nested one is not documented, so the bare file name is denied as well. Anything
 * Studio cannot map is `invalid`: a link, another extension, a directory it cannot read, one too
 * deep. Only `.DS_Store`, which macOS writes into every folder, is passed over.
 */
function walkCommands(dir: string, path: string[], prefix: string, found: Found): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (path.length === 0 && (code === 'ENOENT' || code === 'ENOTDIR')) return;
    found.invalid.push(dir);
    return;
  }
  for (const entry of entries) {
    if (entry === '.DS_Store') continue;
    const at = join(dir, entry);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(at);
    } catch {
      found.invalid.push(at);
      continue;
    }
    if (st.isDirectory()) {
      if (!NAME.test(entry) || path.length + 1 >= MAX_COMMAND_DEPTH) found.invalid.push(at);
      else walkCommands(at, [...path, entry], prefix, found);
      continue;
    }
    const stem = entry.endsWith('.md') ? entry.slice(0, -3) : undefined;
    if (!st.isFile() || stem === undefined || !NAME.test(stem)) {
      found.invalid.push(at);
      continue;
    }
    found.names.add(`${prefix}${[...path, stem].join(':')}`);
    if (path.length > 0) found.names.add(`${prefix}${stem}`);
  }
}

/**
 * Every skill a crew could invoke from this config dir: user skills, and plugin skills and
 * commands as `<plugin>:<name>`, from the install paths `installed_plugins.json` records and from
 * the plugin cache (`cache/<marketplace>/<plugin>/<version>`). `invalid` names every one whose name
 * no deny rule can hold: a launch refuses then, rather than leave it open.
 */
export function installedSkills(configDir: string): { names: string[]; invalid: string[] } {
  const found: Found = { names: new Set(), invalid: [] };
  collect(configDir, '', found);
  const roots: { plugin: string; dir: string }[] = [...installPaths(configDir)];
  const cache = join(configDir, 'plugins', 'cache');
  for (const market of entriesOf(cache)) {
    if (!isDir(join(cache, market))) continue;
    for (const plugin of entriesOf(join(cache, market))) {
      if (!isDir(join(cache, market, plugin))) continue;
      for (const version of entriesOf(join(cache, market, plugin))) {
        const dir = join(cache, market, plugin, version);
        if (isDir(dir)) roots.push({ plugin, dir });
      }
    }
  }
  for (const r of roots) {
    const sub: Found = { names: new Set(), invalid: [] };
    collect(r.dir, '', sub);
    if (sub.names.size === 0 && sub.invalid.length === 0) continue;
    if (!NAME.test(r.plugin)) {
      found.invalid.push(r.dir);
      continue;
    }
    for (const n of sub.names) found.names.add(`${r.plugin}:${n}`);
    found.invalid.push(...sub.invalid);
  }
  return { names: [...found.names], invalid: [...new Set(found.invalid)] };
}

const plain = (s: string): boolean =>
  s.split(':').length <= 2 && s.split(':').every((p) => NAME.test(p));

/**
 * Whether an installed skill is one the brief names: exactly. A plugin skill needs its full
 * `<plugin>:<name>`; a bare name allows only a skill without a plugin.
 */
const named = (skill: string, allowed: readonly string[]): boolean => allowed.includes(skill);

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
  /** Skills bundled with Claude Code (not on disk): those the brief does not name are denied. */
  bundled: readonly string[] = [],
): string[] {
  const out = new Set<string>();
  const { names, invalid } = installedSkills(configDir);
  if (invalid.length > 0) throw new Error(undeniableLine(configDir, invalid));
  for (const s of [...names, ...bundled]) if (!named(s, allowed)) out.add(s);
  for (const d of denied) if (plain(d)) out.add(d);
  return [...out].map((s) => `Skill(${s})`);
}

/** Why a launch refuses: installed skills no deny rule can name could be invoked unseen. */
export function undeniableLine(configDir: string, invalid: readonly string[]): string {
  const shown = invalid
    .slice(0, 5)
    .map((p) => JSON.stringify(p.replace(/[\p{Cc}\p{Cf}]/gu, '?').slice(0, 200)))
    .join(', ');
  return `installed skills in ${configDir} have names a deny rule cannot hold (${shown}${invalid.length > 5 ? `, ${invalid.length - 5} more` : ''}); a crew could invoke them outside its brief: rename them to letters, digits, dot, dash and underscore, or remove them, then launch again`;
}
