import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, sep } from 'node:path';
import { crewTokenFile, type OwnerConfig, type OwnerEnv, ownerConfigDir } from './config.js';
import {
  activeParks,
  DEFAULT_LABEL,
  earliestReset,
  type Parks,
  readLimits,
  validLabel,
} from './limits.js';
import type { Ports } from './ports.js';

export const PROVIDER_TIMEOUT_MS = 30_000;
export const PROVIDER_MAX_BYTES = 64 * 1024;

/** What a credential provider hands out: exactly one of the two forms. */
export type ProviderResult =
  | { label: string; token: string; configDir?: undefined }
  | { label: string; configDir: string; token?: undefined };

const fail = (what: string): never => {
  throw new Error(`credential provider: ${what}`);
};

/** A token goes into an environment variable: no whitespace, no control characters. */
export const validToken = (t: string): boolean => /^[^\s\p{Cc}]+$/u.test(t);

/**
 * Strict parse of the provider's stdout: undefined for an empty result, otherwise exactly one JSON
 * line with exactly `label` and `env`, and `env` with exactly one known key. Every message is fixed
 * text: stdout may hold a token, so none of it ever reaches an error.
 */
export function parseProviderOutput(stdout: string): ProviderResult | undefined {
  const text = stdout.trim();
  if (text === '') return undefined;
  if (text.includes('\n')) return fail('output must be exactly one JSON line');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail('output is not valid JSON');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('output must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  if (Object.keys(obj).sort().join() !== 'env,label') {
    return fail('output must have exactly the keys label and env');
  }
  const { label, env } = obj;
  if (typeof label !== 'string' || !validLabel(label)) return fail('label is not valid');
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    return fail('env must be an object');
  }
  const keys = Object.keys(env);
  if (keys.length !== 1) return fail('env must have exactly one key');
  const value = (env as Record<string, unknown>)[keys[0] as string];
  if (keys[0] === 'CLAUDE_CODE_OAUTH_TOKEN') {
    if (typeof value !== 'string' || !validToken(value)) return fail('the token is not valid');
    return { label, token: value };
  }
  if (keys[0] === 'CLAUDE_CONFIG_DIR') {
    if (typeof value !== 'string' || value === '') return fail('the config dir is not valid');
    return { label, configDir: value };
  }
  return fail('env holds a key that is not accepted');
}

const uidOf = (o: OwnerEnv): number | undefined => o.uid ?? process.getuid?.();

/** Absolute, a regular file (no symlink), executable, ours, writable only by us. */
export function checkCredentialCommand(path: string, owner: OwnerEnv): void {
  const refuse = (why: string): never => {
    throw new Error(`crew_credential_command ${path} ${why}`);
  };
  if (!isAbsolute(path)) refuse('must be an absolute path');
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    throw new Error(`crew_credential_command ${path} must be a regular file`);
  }
  if (!st.isFile()) refuse('must be a regular file');
  if (st.uid !== uidOf(owner)) refuse('must be owned by the current user');
  if ((st.mode & 0o022) !== 0) refuse('must not be group- or world-writable');
  if ((st.mode & 0o100) === 0) refuse('must be executable');
}

/**
 * The config dir form: absolute, an existing directory of ours, with a real path strictly below the
 * real owner config dir (that dir itself holds `crew-token`; symlink escapes end up outside).
 * Returns the real path. Messages name no path, since the value came from the provider.
 */
export function checkProviderConfigDir(dir: string, owner: OwnerEnv): string {
  if (!isAbsolute(dir)) return fail('config dir must be an absolute path');
  let real = '';
  let ownerReal = '';
  let st: ReturnType<typeof statSync>;
  try {
    real = realpathSync(dir);
    ownerReal = realpathSync(ownerConfigDir(owner));
    st = statSync(real);
  } catch {
    return fail('config dir must be an existing directory');
  }
  if (!st.isDirectory()) return fail('config dir must be an existing directory');
  if (!real.startsWith(ownerReal + sep)) {
    return fail('config dir must lie below the owner config dir');
  }
  if (st.uid !== uidOf(owner)) return fail('config dir must be owned by the current user');
  return real;
}

type SettingsFile = { env?: unknown; apiKeyHelper?: unknown; hooks?: unknown };
type SettingsRead = { settings?: SettingsFile; problem?: string };

/**
 * Reads a Claude settings file; neither field is set for a missing file. `plainOnly` requires a
 * regular file: one in a crew clone is crew-controlled (a FIFO would hang the launch), an owner's
 * may be a dotfile link.
 */
function readSettings(file: string, plainOnly: boolean): SettingsRead {
  let text: string;
  try {
    if (plainOnly) {
      const st = lstatSync(file);
      if (st.isSymbolicLink()) return { problem: `${file} is a symlink` };
      if (!st.isFile()) return { problem: `${file} is not a regular file` };
    }
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT'
      ? {}
      : { problem: `${file} cannot be read` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = undefined;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { problem: `${file} cannot be parsed` };
  }
  return { settings: raw as SettingsFile };
}

function billingProblem(file: string, s: SettingsFile): string | undefined {
  const hint = 'refusing API billing (set allow_api_billing: true in the owner config to allow it)';
  if (s.apiKeyHelper !== undefined) return `${file} sets apiKeyHelper; ${hint}`;
  if (s.env !== null && typeof s.env === 'object') {
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
      if (key in s.env) return `${file} sets env.${key}; ${hint}`;
    }
  }
  return undefined;
}

/**
 * Why a Claude settings file would switch a crew to API billing; undefined when it does not. With
 * `allowed` the keys pass, an unparsable file never does. Names the key, never a value.
 */
export function apiBillingProblem(file: string, allowed = false): string | undefined {
  const { settings, problem } = readSettings(file, false);
  if (problem !== undefined) return problem;
  return settings === undefined || allowed ? undefined : billingProblem(file, settings);
}

/** Env keys that send the Claude process, and with it a newly issued token, somewhere else. */
const REDIRECT_ENV = new Set([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
]);

/**
 * Why a settings file in a crew clone may not be used; undefined when it may. These files apply to
 * the Claude process, which runs outside the sandbox. A redirecting env key refuses always,
 * `allow_api_billing` or not. On a reused clone, which a crew has already run in, `hooks` and
 * `apiKeyHelper` refuse too. Billing keys follow `allowBilling`. Names the key, never a value.
 */
export function cloneSettingsProblem(
  file: string,
  allowBilling: boolean,
  reused: boolean,
): string | undefined {
  const { settings, problem } = readSettings(file, true);
  if (problem !== undefined) return problem;
  if (settings === undefined) return undefined;
  if (settings.env !== null && typeof settings.env === 'object') {
    for (const key of Object.keys(settings.env)) {
      const name = key.toUpperCase();
      if (REDIRECT_ENV.has(name)) return `${file} sets env.${name}; refusing to use it`;
    }
  }
  if (reused) {
    for (const key of ['hooks', 'apiKeyHelper'] as const) {
      if (settings[key] !== undefined) {
        return `${file} sets ${key} in a reused clone; refusing to use it (inspect it, then remove the clone to start over)`;
      }
    }
  }
  return allowBilling ? undefined : billingProblem(file, settings);
}

export type CrewTokenRead =
  | { kind: 'absent' }
  | { kind: 'ok'; token: string }
  | { kind: 'bad'; why: string };

/** The `crew-token` file: plain, ours, mode 0600 or narrower. The result never holds a bad value. */
export function readCrewTokenFile(owner: OwnerEnv): CrewTokenRead {
  const file = crewTokenFile(owner);
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'bad', why: `${file} cannot be read` };
  }
  if (!st.isFile()) return { kind: 'bad', why: `${file} is not a regular file` };
  if (st.uid !== uidOf(owner)) return { kind: 'bad', why: `${file} has another owner` };
  if ((st.mode & 0o777 & ~0o600) !== 0) {
    return { kind: 'bad', why: `${file} has a mode wider than 0600` };
  }
  let token: string;
  try {
    token = readFileSync(file, 'utf8').trim();
  } catch {
    return { kind: 'bad', why: `${file} cannot be read` };
  }
  if (!validToken(token)) return { kind: 'bad', why: `${file} holds no valid token` };
  return { kind: 'ok', token };
}

/** Temp file + rename, mode 0600, parent 0700. A symlink at the target is replaced, not followed. */
export function installCrewToken(token: string, owner: OwnerEnv): void {
  const file = crewTokenFile(owner);
  const parent = dirname(file);
  mkdirSync(dirname(parent), { recursive: true, mode: 0o700 });
  try {
    if (lstatSync(parent).isSymbolicLink()) {
      throw new Error(`refusing to use ${parent}: it is a symlink`);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    mkdirSync(parent, { mode: 0o700 });
  }
  chmodSync(parent, 0o700);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, `${token}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // never created, or already renamed
    }
    throw e;
  }
}

/** Runs the provider with a minimal environment. Throws fixed text on any failure. */
export async function runCredentialProvider(
  command: string,
  ctx: { item: string; role: string; exclude: string[] },
  ports: Ports,
  owner: OwnerEnv,
): Promise<ProviderResult | undefined> {
  checkCredentialCommand(command, owner);
  const penv = owner.env ?? process.env;
  const env: Record<string, string> = {
    HOME: owner.homedir ?? homedir(),
    STUDIO_ITEM: ctx.item,
    STUDIO_ROLE: ctx.role,
    STUDIO_EXCLUDE: ctx.exclude.join(','),
  };
  if (penv.PATH !== undefined) env.PATH = penv.PATH;
  let reply: { code: number; stdout: string };
  try {
    reply = await ports.credentials.runProvider(command, env, {
      timeoutMs: PROVIDER_TIMEOUT_MS,
      maxBytes: PROVIDER_MAX_BYTES,
    });
  } catch {
    return fail('could not be run');
  }
  if (reply.code !== 0) return fail('failed');
  return parseProviderOutput(reply.stdout);
}

export const allParkedLine = (reset: string | undefined): string =>
  `usage limit: no crew credential available; earliest reset ${reset ?? 'unknown'}`;

/** Why no crew may start at all right now, as the one line for the owner; undefined when one may. */
export async function limitHold(
  stateRoot: string,
  ownerConfig: OwnerConfig,
  ports: Ports,
  owner: OwnerEnv,
): Promise<string | undefined> {
  const read = readLimits(stateRoot);
  if (!read.ok)
    return 'usage limit state is unreadable (limits.json): no crew starts until it is fixed';
  const parks = activeParks(read.labels, ports.clock.now());
  return parksHold(parks, ownerConfig, ports, owner);
}

async function parksHold(
  parks: Parks,
  ownerConfig: OwnerConfig,
  ports: Ports,
  owner: OwnerEnv,
): Promise<string | undefined> {
  const labels = Object.keys(parks);
  const command = ownerConfig.crewCredentialCommand;
  if (command === undefined) {
    const park = parks[DEFAULT_LABEL];
    return park ? allParkedLine(park.parkedUntil) : undefined;
  }
  if (labels.length === 0) return undefined;
  // Only the provider knows its labels. The value it returns here is dropped unused.
  try {
    const got = await runCredentialProvider(
      command,
      { item: '', role: '', exclude: labels },
      ports,
      owner,
    );
    if (got === undefined) return allParkedLine(earliestReset(parks));
    if (parks[got.label]) return fail('returned a parked label');
    return undefined;
  } catch {
    return 'credential provider failed: no crew starts until it works again';
  }
}
