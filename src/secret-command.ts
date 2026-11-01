import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  crewTokenFile,
  loadConfig,
  loadOwnerConfig,
  type OwnerConfig,
  type OwnerEnv,
  type StudioConfig,
} from './config.js';
import { installCrewToken, readCrewTokenFile, validToken } from './credentials.js';
import type { Ports } from './ports.js';
import { assertPrimaryRepo, safe } from './setup-ci-command.js';

function readPrimaryRepo(project: string): string {
  const file = join(project, '.studio', 'studio.yaml');
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch {
    throw new Error('cannot read .studio/studio.yaml');
  }
  return assertPrimaryRepo((raw as { primary_repo?: unknown } | null)?.primary_repo);
}

/** The failing permission, or undefined when the token works. Output of `gh` is never shown. */
async function checkToken(token: string, repo: string, ports: Ports): Promise<string | undefined> {
  const call = async (path: string) => {
    try {
      return await ports.credentials.ghWithToken(token, ['api', path]);
    } catch {
      return { code: 1, stdout: '', stderr: '' };
    }
  };
  const info = await call(`/repos/${repo}`);
  if (info.code !== 0) return 'repository read (or GitHub is not reachable)';
  let push: unknown;
  try {
    push = (JSON.parse(info.stdout) as { permissions?: { push?: unknown } }).permissions?.push;
  } catch {
    return 'repository read (unexpected answer)';
  }
  if (push !== true) return 'contents write';
  const pulls = await call(`/repos/${repo}/pulls?per_page=1`);
  return pulls.code === 0 ? undefined : 'pull requests read';
}

/**
 * `studio secret set crew-token`. The value comes only from the hidden prompt, is checked once
 * against GitHub and installed only when that passes. Everything printed is fixed text plus the
 * validated repository name.
 */
export async function runSecretSet(o: {
  project: string;
  ports: Ports;
  owner: OwnerEnv;
  readSecret?: (prompt: string) => Promise<string | undefined>;
  stdout(s: string): void;
}): Promise<number> {
  const repo = readPrimaryRepo(o.project);
  const input = o.readSecret ? await o.readSecret('Crew token (input hidden): ') : undefined;
  if (input === undefined) {
    throw new Error('studio secret set needs a terminal for hidden input; nothing written');
  }
  const token = input.replace(/\s+/g, '');
  if (token === '') throw new Error('empty value; nothing written');
  if (!validToken(token)) throw new Error('the value holds control characters; nothing written');
  const failing = await checkToken(token, repo, o.ports);
  if (failing !== undefined) {
    o.stdout(`failing permission: ${failing}\n`);
    return 1;
  }
  installCrewToken(token, o.owner);
  o.stdout(`valid for ${repo}\n`);
  return 0;
}

const API_KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

/** `studio doctor`: what is set and what is missing, never a value. */
export function runDoctor(o: {
  project: string;
  owner: OwnerEnv;
  env: Record<string, string | undefined>;
  json: boolean;
  stdout(s: string): void;
}): number {
  let config: StudioConfig | undefined;
  try {
    config = loadConfig(o.project);
  } catch {
    config = undefined;
  }
  let ownerConfig: OwnerConfig | undefined;
  try {
    ownerConfig = loadOwnerConfig(o.owner);
  } catch {
    ownerConfig = undefined;
  }
  const envName = config?.crewToken?.env;
  let crewToken: { status: 'set' | 'missing' | 'invalid'; source?: string };
  if (envName && o.env[envName]) crewToken = { status: 'set', source: `env ${envName}` };
  else {
    const file = readCrewTokenFile(o.owner);
    if (file.kind === 'ok') crewToken = { status: 'set', source: 'file' };
    else if (file.kind === 'bad') crewToken = { status: 'invalid', source: 'file' };
    else crewToken = { status: 'missing' };
  }
  const required = !(config?.allowAmbientCredentials ?? false);
  const report = {
    crewToken: { ...crewToken, required },
    crewTokenFile: crewTokenFile(o.owner),
    studioYaml: config ? 'readable' : 'not readable',
    ownerConfig: ownerConfig ? 'readable' : 'invalid',
    credentialProvider: ownerConfig?.crewCredentialCommand ?? null,
    allowApiBilling: ownerConfig?.allowApiBilling ?? false,
    notify: ownerConfig?.notify ? 'configured' : 'not configured',
    apiKeyVarsInEnvironment: API_KEY_VARS.filter((k) => o.env[k]),
  };
  if (o.json) o.stdout(`${JSON.stringify(report, null, 2)}\n`);
  else {
    const source = crewToken.source ? ` (${crewToken.source})` : '';
    const provider = report.credentialProvider;
    const lines = [
      `crew token: ${crewToken.status}${source}${required ? '' : ' (optional: allow_ambient_credentials)'}`,
      `studio.yaml: ${report.studioYaml}`,
      `owner config: ${report.ownerConfig}`,
      `credential provider: ${provider === null ? 'not configured' : `configured ${provider}`}`,
      `notify: ${report.notify}`,
      `allow_api_billing: ${report.allowApiBilling ? 'on' : 'off'}`,
      `API key variables in the environment: ${report.apiKeyVarsInEnvironment.join(', ') || 'none'}`,
    ];
    o.stdout(`${lines.map(safe).join('\n')}\n`);
  }
  return required && crewToken.status !== 'set' ? 1 : 0;
}
