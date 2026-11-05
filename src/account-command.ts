import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  activeLabel,
  addAccount,
  crewClaudeDir,
  expiryState,
  listAccounts,
  removeAccount,
  setActiveLabel,
} from './accounts.js';
import { loadOwnerConfig, type OwnerEnv } from './config.js';
import { activeParks, readBlocks, readLimits } from './limits.js';
import { acquireStateLock } from './paths.js';
import { DEFAULT_PLUGINS, listedVersions, type PluginPin, pluginCommands } from './plugins.js';
import type { Ports } from './ports.js';
import { safe } from './setup-ci-command.js';
import { LAUNCH_LOCK, LAUNCH_LOCK_STALE_MS, labelUsage } from './usage.js';

export interface AccountRow {
  label: string;
  addedAt: string;
  active: boolean;
  state: string;
  running: number;
  runsToday: number;
  expiry: 'ok' | 'soon' | 'expired';
  expiresAt: string;
}

/** Labels and their state for list and doctor; never a token. */
export function accountRows(o: { owner: OwnerEnv; ownerRoot: string; ports: Ports }): AccountRow[] {
  const accounts = listAccounts(o.owner);
  if (accounts.length === 0) return [];
  const now = o.ports.clock.now();
  const active = activeLabel(o.owner);
  const limits = readLimits(o.ownerRoot);
  const parks = limits.ok ? activeParks(limits.labels, now) : undefined;
  const blocks = readBlocks(o.ownerRoot);
  const usage = labelUsage({
    ownerRoot: o.ownerRoot,
    ownerConfig: loadOwnerConfig(o.owner),
    ports: o.ports,
  });
  return accounts.map(({ label, addedAt }) => {
    const blocked = blocks.ok ? blocks.blocks.find((b) => b.label === label) : undefined;
    const parked = parks?.[label];
    let state = 'free';
    if (!limits.ok || !blocks.ok || !usage.ok) state = 'unknown: state files unreadable';
    else if (blocked !== undefined) state = `blocked since ${blocked.at}`;
    else if (parked !== undefined) state = `parked until ${parked.parkedUntil}`;
    else if (!(usage.remaining(label) > 0)) state = 'at its parallel or daily limit';
    const { state: expiry, expiresAt } = expiryState(addedAt, now);
    return {
      label,
      addedAt,
      active: label === active,
      state,
      running: usage.running[label] ?? 0,
      runsToday: usage.runsToday[label] ?? 0,
      expiry,
      expiresAt,
    };
  });
}

/** A line about the token's end, or undefined when it is far off. */
export function expiryLine(row: AccountRow): string | undefined {
  if (row.expiry === 'ok') return undefined;
  const when = row.expiry === 'expired' ? 'expired' : 'expires';
  return `account ${row.label}: token ${when} ${row.expiresAt.slice(0, 10)}; run claude setup-token, then studio account add ${row.label}`;
}

/** A plugin studio.yaml names that the owner has not allowed: never installed. */
export const unallowedLine = (name: string): string =>
  `${name} is not installed: studio.yaml names it, but allowed_plugins in the owner config does not; the owner adds it there with its marketplace`;

/** The environment plugin commands run with: the crew config dir, no token. */
export function pluginEnv(
  owner: OwnerEnv,
  env: Record<string, string | undefined>,
): { dir: string; runEnv: Record<string, string> } {
  const dir = crewClaudeDir(owner);
  const runEnv: Record<string, string> = {
    CLAUDE_CONFIG_DIR: dir,
    HOME: owner.homedir ?? homedir(),
  };
  if (env.PATH !== undefined) runEnv.PATH = env.PATH;
  return { dir, runEnv };
}

/**
 * Installs the pinned plugins crews need into the crew config dir, then reads what got installed.
 * `claude plugin install` takes no version (https://code.claude.com/docs/en/plugins/cli-reference):
 * a plugin at another version gets one `claude plugin update`, and if it still differs, the setup
 * fails naming both versions. A launch refuses the same mismatch. No login, no token involved.
 */
export async function setupPlugins(
  owner: OwnerEnv,
  ports: Ports,
  env: Record<string, string | undefined>,
  pins: readonly PluginPin[] = DEFAULT_PLUGINS,
  say: (line: string) => void = () => {},
): Promise<string | undefined> {
  if (ports.plugins === undefined) return 'no claude command available';
  const cli = ports.plugins;
  const { dir, runEnv } = pluginEnv(owner, env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const run = async (args: string[]) => {
    const r = await cli.run(args, runEnv, dir);
    // A crew dir set up before: a marketplace already added or a plugin already installed is
    // what setup wants, not a failure. The versions are checked below either way.
    const already =
      (args[1] === 'install' || (args[1] === 'marketplace' && args[2] === 'add')) &&
      /\balready (installed|added|exists|present|configured)\b/i.test(`${r.stdout}\n${r.stderr}`);
    if (r.code !== 0 && !already) {
      throw new Error(
        `claude ${args.join(' ')} failed (exit ${r.code}): ${safe(r.stderr.trim()).slice(0, 300)}`,
      );
    }
    return r.stdout;
  };
  const off = (have: Map<string, string>) =>
    pins.filter((p) => have.get(p.name) !== undefined && have.get(p.name) !== p.version);
  try {
    for (const args of pluginCommands(pins)) await run(args);
    let have = listedVersions(await run(['plugin', 'list', '--json']));
    if (have === undefined) {
      say('installed versions: unknown (claude plugin list --json gave nothing readable)');
      return undefined;
    }
    const first = off(have);
    if (first.length > 0) {
      for (const p of first) await run(['plugin', 'update', p.name]);
      have = listedVersions(await run(['plugin', 'list', '--json'])) ?? have;
    }
    for (const p of pins)
      say(`${p.name} ${have.get(p.name) ?? 'not listed'} (pinned ${p.version})`);
    const still = off(have);
    if (still.length > 0) {
      return `${still.map((p) => `${p.name} is ${have?.get(p.name)}, pinned ${p.version}`).join('; ')}: claude plugin install takes no version and installs what the marketplace offers; set the pin to the installed version after a reviewed update item (studio skills check), or wait for the marketplace`;
    }
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

export async function runAccount(o: {
  args: string[];
  owner: OwnerEnv;
  ownerRoot: string;
  ports: Ports;
  env: Record<string, string | undefined>;
  json: boolean;
  isTerminal: boolean;
  /** The pinned plugins (studio.yaml over the defaults, extras as the owner allows); may throw. */
  pins?: () => { pins: readonly PluginPin[]; unallowed: readonly string[] };
  readSecret?: (prompt: string) => Promise<string | undefined>;
  stdout(s: string): void;
  stderr(s: string): void;
}): Promise<number> {
  const [sub, label, ...extra] = o.args;
  const ownerOnly = () => {
    if (o.env.STUDIO_ROLE === 'crew' || !o.isTerminal) {
      throw new Error(`account ${sub} is for the owner and needs a terminal; nothing changed`);
    }
  };
  const print = (v: unknown) => o.stdout(`${JSON.stringify(v, null, 2)}\n`);
  const noLabel = () => label === undefined || extra.length > 0;
  if (o.env.STUDIO_ROLE === 'crew') throw new Error('this command is not for crew sessions');

  if (sub === 'add' && !noLabel()) {
    ownerOnly();
    const input = o.readSecret
      ? await o.readSecret('Token from claude setup-token (hidden): ')
      : undefined;
    if (input === undefined)
      throw new Error('account add needs a terminal for hidden input; nothing stored');
    // The value is never echoed: an error names only what is wrong with it.
    const first = listAccounts(o.owner).length === 0;
    addAccount(o.owner, label as string, input.trim(), o.ports.clock.now());
    o.stdout(`account ${label} stored${activeLabel(o.owner) === label ? ' and active' : ''}\n`);
    // The first account sets up the crew config dir; later ones leave it to setup-plugins.
    if (!first) return 0;
    let failed: string | undefined;
    try {
      const p = o.pins?.();
      failed = await setupPlugins(o.owner, o.ports, o.env, p?.pins);
      for (const name of p?.unallowed ?? []) o.stderr(`warning: ${unallowedLine(name)}\n`);
    } catch (e) {
      failed = (e as Error).message;
    }
    if (failed === undefined) return 0;
    o.stderr(
      `error: plugin setup: ${failed}; the token is stored, run studio account setup-plugins\n`,
    );
    return 1;
  }
  if (sub === 'use' && !noLabel()) {
    ownerOnly();
    setActiveLabel(o.owner, label as string);
    o.stdout(`account ${label} is active\n`);
    return 0;
  }
  if (sub === 'remove' && !noLabel()) {
    ownerOnly();
    // Under the launch lock: no launch can pick this account between the check and the removal.
    const lock = acquireStateLock(o.ownerRoot, LAUNCH_LOCK, {
      now: o.ports.clock.now(),
      heartbeatStaleMs: LAUNCH_LOCK_STALE_MS,
    });
    if (!lock) throw new Error('a launch is in progress (launch.lock); try again, nothing removed');
    try {
      const row = accountRows(o).find((r) => r.label === label);
      if (row === undefined) throw new Error(`no account ${label}`);
      if (row.state.startsWith('unknown') || row.running > 0) {
        throw new Error(`account ${label} may have a crew running; stop it first, nothing removed`);
      }
      removeAccount(o.owner, label as string);
    } finally {
      lock.release();
    }
    o.stdout(`account ${label} removed\n`);
    if (listAccounts(o.owner).length === 0) {
      o.stderr(
        'warning: no stored account is left: launches use the environment or your main login (~/.claude or CLAUDE_CONFIG_DIR) again, unless a credential provider is set\n',
      );
    }
    return 0;
  }
  if (sub === 'setup-plugins' && label === undefined) {
    // No terminal needed: it handles no secret, installs only the pinned default plugins and the
    // owner-config allowlist, and the lead must re-run it whenever a Studio update moves the pins.
    // Crews are refused above.
    const p = o.pins?.();
    for (const name of p?.unallowed ?? []) o.stderr(`warning: ${unallowedLine(name)}\n`);
    const failed = await setupPlugins(o.owner, o.ports, o.env, p?.pins, (l) =>
      o.stdout(`${safe(l)}\n`),
    );
    if (failed !== undefined) throw new Error(`plugin setup: ${failed}`);
    o.stdout(`plugins installed in ${crewClaudeDir(o.owner)}\n`);
    return 0;
  }
  if ((sub === 'list' || sub === undefined) && label === undefined) {
    const rows = accountRows(o);
    if (o.json) {
      print({ crewConfigDir: crewClaudeDir(o.owner), accounts: rows });
      return 0;
    }
    if (rows.length === 0) o.stdout('no accounts; add one with studio account add <label>\n');
    for (const r of rows) {
      o.stdout(
        `${safe(r.label)}${r.active ? ' (active)' : ''}: added ${r.addedAt.slice(0, 10)}, ${r.state}, ${r.running} running, ${r.runsToday} today\n`,
      );
      const line = expiryLine(r);
      if (line !== undefined) o.stdout(`  ${line}\n`);
    }
    if (!existsSync(crewClaudeDir(o.owner)) && rows.length > 0) {
      o.stdout('crew config dir missing: run studio account setup-plugins\n');
    }
    return 0;
  }
  throw new Error(
    'account needs: add <label> | use <label> | remove <label> | list | setup-plugins',
  );
}
