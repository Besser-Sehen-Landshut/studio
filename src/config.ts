import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { isLang, LANGS } from '../hooks/i18n/index.js';
import { globProblem } from './glob.js';
import { allowedPluginSchema, pluginPinSchema } from './plugins.js';
import { PROOF_LANGUAGES, type ProofLanguage, UNKNOWN_LANGUAGE } from './proofs.js';
import { REA_VERSION_RE, reaEnvKeyOk } from './rea.js';

export { globProblem };

export const ROLE_TEMPLATES = ['builder', 'reviewer', 'designer', 'researcher', 'release'] as const;
export type RoleTemplate = (typeof ROLE_TEMPLATES)[number];

const strList = z.array(z.string()).default([]);

/** Credential locations below the real home that a crew session must never read. */
export const CREDENTIAL_PATHS = [
  '.config/gh',
  '.git-credentials',
  '.ssh',
  '.netrc',
  '.gnupg',
  '.aws',
  '.docker/config.json',
  'Library/Keychains',
  '.cargo/credentials',
  '.cargo/credentials.toml',
];

/** Locations below the real home a crew toolchain path must not open besides the credentials. */
export const PROTECTED_HOME_PATHS = [...CREDENTIAL_PATHS, '.claude'];

/** Path comparison key: case-insensitive on darwin (its default file systems are). */
export const pathKey = (p: string, platform: NodeJS.Platform = process.platform): string =>
  platform === 'darwin' ? p.toLowerCase() : p;

/** `child` equals `parent` or lies below it (both already resolved and case-folded). */
export const within = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/**
 * Lexical check (no filesystem access) of a crew toolchain read path; returns why it is refused,
 * or undefined. Rejected: relative paths, `/`, the home itself or a parent of it, and any path that
 * equals, contains or lies inside a credential location or the Claude config dir (so the
 * `.config` and `Library` parents are out as well). Case-insensitive on darwin. The launch repeats
 * this on the real paths (`canonicalToolchainPaths` in paths.ts).
 */
export function toolchainPathProblem(
  path: string,
  home: string,
  extraProtectedPaths: string[] = [],
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!isAbsolute(path)) return 'must be an absolute path';
  const key = (x: string) => pathKey(resolve(x), platform);
  const p = key(path);
  if (p === key('/')) return 'must not be the filesystem root';
  if (within(key(home), p)) return 'must not be the home directory or a parent of it';
  const hit = [...PROTECTED_HOME_PATHS.map((c) => join(home, c)), ...extraProtectedPaths].find(
    (c) => within(p, key(c)) || within(key(c), p),
  );
  return hit ? `must not equal, contain or lie inside the credential location ${hit}` : undefined;
}

/** A value for `--model`: it never starts with a dash. Same rule as in board.ts (a test keeps them equal). */
export const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/;
const modelName = z.string().regex(MODEL_NAME_RE, 'not a model name');

const ITEM_TYPES = ['feature', 'fix', 'chore', 'docs', 'research', 'review', 'release'] as const;

const globSchema = z.string().superRefine((g, ctx) => {
  const problem = globProblem(g);
  if (problem !== undefined) ctx.addIssue({ code: 'custom', message: problem });
});

const roleSkillsSchema = z.strictObject({
  required: strList,
  allowed: strList,
  denied: strList,
  // More skills when the item's paths or type match, on top of capabilities/INDEX.yaml.
  when: z
    .array(
      z.strictObject({
        paths: z.array(globSchema).optional(),
        itemTypes: z.array(z.enum(ITEM_TYPES)).optional(),
        required: z.array(z.string()).optional(),
        allowed: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});
export type RoleSkills = z.infer<typeof roleSkillsSchema>;

const roleSchema = z.strictObject({
  model: modelName,
  // Another model for some item types, e.g. a cheaper one for docs.
  types: z.partialRecord(z.enum(ITEM_TYPES), modelName).optional(),
  // What `studio escalate <id>` moves a stuck item of this role to.
  escalateTo: modelName.optional(),
  wip: z.number().int().positive(),
  skills: roleSkillsSchema.default({ required: [], allowed: [], denied: [] }),
});
export type RoleConfig = z.infer<typeof roleSchema>;

export const ciSchema = z.strictObject({
  provider: z.literal('github'),
  runners: z.enum(['github-hosted', 'self-hosted', 'both']),
  runnerLabels: strList,
  runnerNamePattern: z.string().optional(),
  // The self-hosted runners share their host with other workloads: host load is capped at
  // `hostLoadMax`, or at the core count when that is unset.
  sharedHost: z.boolean().optional(),
  // Most GitHub-hosted runs (in progress + queued) allowed with `runners: both`.
  githubHostedLimit: z.number().int().positive().optional(),
  capacity: z.strictObject({
    total: z.number().int().positive(),
    mergeMaxBusy: z.number().int().nonnegative(),
    checkTwiceSeconds: z.number().nonnegative(),
    hostLoadMax: z.number().positive().optional(),
  }),
  rhythm: z.strictObject({ buildWindow: z.string(), timezone: z.string() }).optional(),
});

/** A component id. Same rule as in board.ts (a test keeps them equal). */
export const COMPONENT_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** A CI job name, one plain line. */
const ciLine = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u, 'one line of at most 200 characters');

/** A workflow by its file: `.github/workflows/<file>.yml`. */
const workflowFile = z
  .string()
  .regex(
    /^\.github\/workflows\/[A-Za-z0-9._-]{1,100}\.ya?ml$/,
    'must be the workflow file, .github/workflows/<file>.yml',
  );

/** A CI job by its workflow file and its job name, as `acceptance.suites` names one. */
const workflowJob = z.strictObject({
  workflow: workflowFile,
  job: ciLine.pipe(
    z.string().regex(/^[A-Za-z0-9 ._()/:-]+$/, 'letters, digits, spaces and . _ - ( ) / : only'),
  ),
});

/** One plain line of at most `max` characters: no control or format characters. */
const oneLine = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}\p{Cf}]+$/u, `one line of at most ${max} characters`);

/** An approver id: it names the approval in `studio release approve`. `owner` is Studio's own. */
export const APPROVER_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** Why a release block with a command is refused: only a named workflow runs a release. */
export const NO_RELEASE_COMMANDS =
  'a release runs only a named workflow file (release.workflow); commands and skills are not supported: 0.17 showed how hard sandboxing them is';

const RELEASE_COMMAND_KEYS = ['command', 'commands', 'run', 'script', 'skill', 'steps'];

/**
 * `release:` of a component: how `studio release <component>` ships it. The release path is one
 * workflow file on the default branch, started with `gh workflow run` and the release commit as
 * input `sha`; the checks after the deploy are named jobs, by workflow file. Studio never runs a
 * command of its own for a release, and never runs the way back.
 */
const releaseRuleSchema = z
  .looseObject({
    // Needs `on: workflow_dispatch` with an input `sha`: the commit to deploy.
    workflow: workflowFile,
    // Jobs that must pass after the deploy: in the release workflow's own run, or in another
    // workflow that Studio starts once the release run passed (input `sha` as well).
    postChecks: z.array(workflowJob).min(1).max(20),
    // Migration files of the component, read and classified for the note.
    migrations: z.array(globSchema).max(20).default([]),
    // Files that declare configuration (`.env.example` style): only names reach the note.
    config: z.array(globSchema).max(20).default([]),
    // The way back, shown when a check is red and in the note; never run by Studio.
    rollback: z.union([
      z.strictObject({ text: oneLine(300) }),
      z.strictObject({ workflow: workflowFile }),
    ]),
    // Third parties whose approval a release needs, e.g. for a part an external partner owns.
    approvers: z
      .array(
        z.strictObject({
          id: z
            .string()
            .regex(APPROVER_ID_RE, 'must match ^[a-z][a-z0-9-]{0,31}$')
            .refine((id) => id !== 'owner', 'owner is the owner approval itself'),
          // Who approves, as the lead knows them: one line, shown to the lead and owner only.
          who: oneLine(100),
          // What they approve, one line.
          for: oneLine(200).optional(),
          // Needed only when the release changes one of these paths; always without.
          paths: z.array(globSchema).min(1).max(20).optional(),
        }),
      )
      .max(10)
      .default([]),
    // How long after the trigger the release run and its checks may take before Studio stops.
    timeoutMinutes: z.number().int().min(5).max(1440).default(60),
    // Files outside .github the release workflows run, e.g. deploy scripts: the owner's like the
    // workflows, pinned at the announcement and guarded against crews' pull requests.
    guardedPaths: z.array(globSchema).max(50).default([]),
  })
  .superRefine((r, ctx) => {
    const known = [
      'workflow',
      'postChecks',
      'migrations',
      'config',
      'rollback',
      'approvers',
      'timeoutMinutes',
      'guardedPaths',
    ];
    for (const key of Object.keys(r).filter((k) => !known.includes(k))) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: RELEASE_COMMAND_KEYS.includes(key) ? NO_RELEASE_COMMANDS : 'unknown key',
      });
    }
    const ids = new Set<string>();
    for (const [i, a] of r.approvers.entries()) {
      if (ids.has(a.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['approvers', i, 'id'],
          message: `duplicate approver ${a.id}`,
        });
      }
      ids.add(a.id);
    }
  })
  .transform(
    ({
      workflow,
      postChecks,
      migrations,
      config,
      rollback,
      approvers,
      timeoutMinutes,
      guardedPaths,
    }) => ({
      workflow,
      postChecks,
      migrations,
      config,
      rollback,
      approvers,
      timeoutMinutes,
      guardedPaths,
    }),
  );
export type ReleaseRule = z.infer<typeof releaseRuleSchema>;

/** Words `studio release` takes as subcommands: no component with a release may be named so. */
export const RELEASE_SUBCOMMANDS = ['list', 'show', 'approve', 'cancel'];

// A part of the product developed and released on its own: an API server, a desktop app, a web
// app in a second repo. Items belong to one or several (cross-cutting work).
const componentSchema = z.strictObject({
  id: z.string().regex(COMPONENT_ID_RE, 'must match ^[a-z][a-z0-9-]{0,31}$'),
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[^\p{Cc}\p{Cf}]+$/u, 'one line of at most 100 characters'),
  repo: z.string().min(1),
  paths: z.array(globSchema).min(1),
  // Most items of this component in assigned or in_progress at once, on top of role wip.
  wip: z.number().int().positive().optional(),
  // How `studio release <id>` ships this component (src/release.ts).
  release: releaseRuleSchema.optional(),
});
export type ComponentConfig = z.infer<typeof componentSchema>;

/** A GitHub repository as `owner/repo`: it reaches commands, URLs and push texts. */
const repoName = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'must be owner/repo (letters, digits, . _ -)')
  .refine((r) => r.split('/').every((p) => p !== '.' && p !== '..'), 'must be owner/repo');

/**
 * `acceptance:` in studio.yaml: the CI jobs that are the full suites of an epic's acceptance (E2E,
 * browser), which no crew sandbox can run. Without it, every workflow run on the main commit counts.
 */
const acceptanceSchema = z.strictObject({
  suites: z
    .array(
      z.strictObject({
        // The workflow by its file, never its display name: two workflows can share a name.
        workflow: z
          .string()
          .regex(
            /^\.github\/workflows\/[A-Za-z0-9._-]{1,100}\.ya?ml$/,
            'must be the workflow file, .github/workflows/<file>.yml',
          ),
        // Quoted as data into item titles: letters, digits, spaces and . _ - ( ) / : only.
        job: ciLine.pipe(
          z
            .string()
            .regex(/^[A-Za-z0-9 ._()/:-]+$/, 'letters, digits, spaces and . _ - ( ) / : only'),
        ),
      }),
    )
    // `[]`: a repository without CI says so; the acceptance then is the review alone.
    .max(20),
});

/** An evidence rule id: it names the rule in logs, lead lines and `studio exceptions grant`. */
export const EVIDENCE_ID_RE = /^[a-z][a-z0-9-]{0,47}$/;

/** Why a rule with a command is refused: no user-configured command runs in this version. */
export const NO_COMMANDS =
  'evidence rules take a built-in proof (comments_only, paths_only); custom proof commands come later, with a real sandbox';

/** Keys of the command rules an earlier draft had; refused with NO_COMMANDS. */
const COMMAND_KEYS = ['command', 'run', 'inputs', 'timeoutSeconds', 'job'];

/**
 * `evidence:` in studio.yaml: a guard job whose failure a built-in proof can show a false alarm on
 * exactly one diff. Studio computes the proof itself (src/proofs.ts), no command runs, and it reads
 * these rules only from studio.yaml at the pull request's base on the default branch
 * (src/evidence.ts).
 */
export const evidenceRuleSchema = z
  .looseObject({
    id: z.string().regex(EVIDENCE_ID_RE, 'must match ^[a-z][a-z0-9-]{0,47}$'),
    // The CI job that reports the hit, e.g. a migration guard.
    guard: workflowJob,
    // Every changed file of the pull request must lie under `paths`. comments_only: each one is a
    // file in one of `languages` that changes plain comments only. paths_only: that is all.
    proof: z.enum(['comments_only', 'whitespace_only', 'paths_only']),
    paths: z.array(globSchema).min(1).max(50),
    // comments_only: the languages it reads (PROOF_LANGUAGES, by file extension); any other file
    // proves nothing.
    languages: z
      .array(
        z
          .string()
          .refine(
            (l): l is ProofLanguage => (PROOF_LANGUAGES as readonly string[]).includes(l),
            UNKNOWN_LANGUAGE,
          ),
      )
      .min(1)
      .optional(),

    // A hit the proof does not explain goes to the owner, not the lead.
    ownerOnly: z.boolean().default(false),
  })
  .superRefine((r, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    const known = ['id', 'guard', 'proof', 'paths', 'languages', 'ownerOnly'];
    for (const key of Object.keys(r).filter((k) => !known.includes(k))) {
      issue(key, COMMAND_KEYS.includes(key) ? NO_COMMANDS : 'unknown key');
    }
    if (r.proof === 'whitespace_only') {
      issue('proof', 'whitespace_only is not in this version: it comes later');
    }
    if (r.proof === 'comments_only' && r.languages === undefined) {
      issue('languages', 'comments_only needs the languages it reads');
    }
    if (r.proof !== 'comments_only' && r.languages !== undefined) {
      issue('languages', 'only comments_only reads languages');
    }
  })
  .transform(({ id, guard, proof, paths, languages, ownerOnly }) => ({
    id,
    guard,
    proof,
    paths,
    ...(languages === undefined ? {} : { languages }),
    ownerOnly,
  }));
export type EvidenceRule = z.infer<typeof evidenceRuleSchema>;

/** A worker label: `runs_on` of an item names one, `studio worker --label` serves one. */
export const WORKER_LABEL_RE = /^[a-z][a-z0-9-]{0,31}$/;
const workerLabel = z.string().regex(WORKER_LABEL_RE, 'must match ^[a-z][a-z0-9-]{0,31}$');

/** A GitHub login: letters, digits and single dashes, at most 39 characters. */
export const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const githubLogin = z.string().regex(GITHUB_LOGIN_RE, 'not a GitHub login');

/**
 * A place a worker's crews must never read or write: an absolute POSIX path, or a Windows drive
 * path (`D:\data`, `D:/data`), which only a worker inside WSL2 can enforce (src/worker-deny.ts).
 * Network paths (`\\server\share`) and relative paths are refused here.
 */
const denyPath = z
  .string()
  .min(2)
  .max(500)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u, 'one line of at most 500 characters')
  .refine(
    (p) => (p.startsWith('/') && !p.startsWith('//')) || /^[A-Za-z]:[\\/]/.test(p),
    'must be an absolute path (/srv/data) or a Windows drive path (D:\\data); network paths are not supported',
  );

/** What a worker's crews must never touch: places, and ports on the worker machine. */
export const workerDenySchema = z.strictObject({
  paths: z.array(denyPath).max(50).default([]),
  ports: z.array(z.number().int().min(1).max(65535)).max(50).default([]),
});
export type WorkerDeny = z.infer<typeof workerDenySchema>;
const NO_DENY = { paths: [], ports: [] };

/**
 * Whether a `network_allow` entry is a wildcard over an IP address (`*.<address>`, any spelling a
 * URL parser takes, a port or a trailing dot allowed). Such a wildcard means nothing and would slip
 * past the checks for local hosts, so it is refused.
 */
export function wildcardOverIp(entry: string): boolean {
  const m = /^\*\.(.+?)(?::\d+)?$/.exec(entry.trim().toLowerCase());
  if (!m) return false;
  let base = (m[1] as string).replace(/\.$/, '');
  if (base.includes(':') && !base.startsWith('[')) base = `[${base}]`;
  try {
    const host = new URL(`http://${base}/`).hostname.replace(/^\[|\]$/g, '');
    return isIP(host) !== 0;
  } catch {
    return false;
  }
}

/**
 * `merge.runner_load`: the queue merges only while at most `max_busy` of the organisation's
 * self-hosted runners whose name matches `name_pattern` are busy, in each of `samples` reads
 * `interval_s` apart. A read that fails counts as busy.
 */
export const runnerLoadSchema = z.strictObject({
  org: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/, 'must be a GitHub organisation name'),
  namePattern: z
    .string()
    .min(1)
    .max(200)
    .superRefine((p, ctx) => {
      try {
        new RegExp(p);
      } catch {
        ctx.addIssue({ code: 'custom', message: 'not a valid regular expression' });
      }
    }),
  maxBusy: z.number().int().nonnegative(),
  samples: z.number().int().min(1).max(10).default(2),
  intervalS: z.number().nonnegative().max(600).default(30),
});
export type RunnerLoad = z.infer<typeof runnerLoadSchema>;

/** `limits:` in studio.yaml and in the owner config. */
const dailyLimitsSchema = z.strictObject({
  dailyCostUsd: z.number().positive().optional(),
});

export const studioConfigSchema = z
  .strictObject({
    studio: z.literal(1),
    primaryRepo: repoName,
    repos: z.array(repoName).min(1),
    notify: z
      .strictObject({
        channel: z.string().min(1),
        ownerOnly: z.boolean(),
        irreversibleAnnounce: z.boolean(),
      })
      .optional(),
    ci: ciSchema,
    merge: z.strictObject({
      strategy: z.enum(['studio-queue', 'native-queue']),
      contractPaths: strList,
      method: z.enum(['merge', 'squash', 'rebase']).default('merge'),
      // Optional gate before every merge of the queue: the self-hosted runners of an organisation
      // that the merged repositories' CI uses. Off when unset.
      runnerLoad: runnerLoadSchema.optional(),
    }),
    // Partial record keyed by role template name; at least one role must be configured.
    roles: z
      .partialRecord(z.enum(ROLE_TEMPLATES), roleSchema)
      .refine((r) => Object.keys(r).length > 0, 'at least one role is required'),
    // Detected from manifest files and stored by `studio setup stack`.
    stacks: z.array(z.string().min(1)).optional(),
    sandbox: z
      .strictObject({
        networkAllow: z
          .array(
            z
              .string()
              .refine((e) => !wildcardOverIp(e), 'a wildcard over an IP address means nothing'),
          )
          .default([]),
      })
      .default({ networkAllow: [] }),
    // Name of the env var that holds the least-privilege token (never the token itself).
    crewToken: z.strictObject({ env: z.string().min(1) }).optional(),
    // Opt-in: let a crew run start without the least-privilege token (default: refuse).
    allowAmbientCredentials: z.boolean().default(false),
    ownerOnly: strList,
    deployCommands: strList,
    // Workflows (file name or name) a crew session may start with `gh workflow run`.
    crewAllowedWorkflows: strList,
    // Refs a crew session may pass to `gh workflow run --ref`; empty = default branch only.
    crewAllowedWorkflowRefs: strList,
    // Base branches a pull request may be reviewed against; empty = default branch only.
    reviewBases: strList,
    components: z.array(componentSchema).min(1).optional(),
    // Plugins crews need, each at one exact version, over the defaults (src/plugins.ts).
    // `studio account setup-plugins` installs them; a launch refuses another installed version.
    plugins: z.array(pluginPinSchema).optional(),
    // Spending brake: once the ended crew runs of the local day cost this much, nothing new starts.
    limits: dailyLimitsSchema.optional(),
    // The full suites an epic's acceptance waits for on main (src/acceptance.ts).
    acceptance: acceptanceSchema.optional(),
    // A reviewer's time limits (src/analyzer-timeout.ts): minutes per analyzer subagent; the
    // session gets them for every analyzer plus one share, then only the report may be written.
    review: z
      .strictObject({
        analyzerTimeoutMinutes: z.number().int().min(5).max(240).default(30),
      })
      .optional(),
    // Exceptions by evidence: guard jobs whose hits a command can prove false alarms.
    evidence: z.array(evidenceRuleSchema).max(20).optional(),
    // Workers on other machines, per label (`runs_on` of an item): what their crews must never
    // touch. The worker adds its own list from its owner config; neither can lift the other's.
    workers: z
      .record(workerLabel, z.strictObject({ deny: workerDenySchema.default(NO_DENY) }))
      .optional(),
    // Reverse engineering for the researcher role (src/rea.ts). `artifacts` is the one directory
    // its tools may read; it must lie below a `research_roots` entry of the owner config.
    research: z
      .strictObject({
        artifacts: z
          .string()
          .min(1)
          .max(500)
          .refine((p) => isAbsolute(p) && !/\p{Cc}/u.test(p), 'must be an absolute path'),
        // The server's version is the owner's (owner config `rea_version`), never the repository's.
      })
      .optional(),
  })
  .superRefine((cfg, ctx) => {
    const ids = new Set<string>();
    for (const [i, r] of (cfg.evidence ?? []).entries()) {
      if (ids.has(r.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['evidence', i, 'id'],
          message: `duplicate evidence id ${r.id}`,
        });
      }
      ids.add(r.id);
    }
    const seen = new Set<string>();
    for (const [i, c] of (cfg.components ?? []).entries()) {
      if (seen.has(c.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['components', i, 'id'],
          message: `duplicate component id ${c.id}`,
        });
      }
      seen.add(c.id);
      if (c.release !== undefined && RELEASE_SUBCOMMANDS.includes(c.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['components', i, 'id'],
          message: `${c.id} is a word of studio release; a component with a release needs another id`,
        });
      }
      // A deploy is never a crew's: no workflow Studio starts for a release may be one a crew may
      // start (by file or by file name, as crew_allowed_workflows lists them).
      const started = [
        ...(c.release === undefined ? [] : [c.release.workflow]),
        ...(c.release?.postChecks ?? []).map((p) => p.workflow),
        ...(c.release !== undefined && 'workflow' in c.release.rollback
          ? [c.release.rollback.workflow]
          : []),
      ];
      for (const file of started) {
        const name = file.slice('.github/workflows/'.length);
        if (cfg.crewAllowedWorkflows.some((w) => w === file || w === name)) {
          ctx.addIssue({
            code: 'custom',
            path: ['crew_allowed_workflows'],
            message: `${name} is a release workflow of component ${c.id}: a crew may never start it`,
          });
        }
      }
      if (!cfg.repos.includes(c.repo)) {
        ctx.addIssue({
          code: 'custom',
          path: ['components', i, 'repo'],
          message: 'must be one of repos',
        });
      }
    }
  });

export type StudioConfig = z.infer<typeof studioConfigSchema>;

export class ConfigError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'ConfigError';
    this.path = path;
  }
}

const camel = (key: string): string =>
  key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Recursively convert snake_case object keys to camelCase. Role keys are template names (single words), so they pass through unchanged. */
export function camelizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelizeKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [camel(k), camelizeKeys(v)]));
  }
  return value;
}

/**
 * A key written in two spellings in one object (`crew_allowed_workflows` and
 * `crewAllowedWorkflows`): after camelizing, one would silently win. Returns the dotted path of
 * the first such key, or undefined.
 */
export function bothSpellings(value: unknown, at = ''): string | undefined {
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      const hit = bothSpellings(v, `${at}[${i}]`);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (value === null || typeof value !== 'object') return undefined;
  const seen = new Map<string, string>();
  for (const [k, v] of Object.entries(value)) {
    const c = camel(k);
    const other = seen.get(c);
    if (other !== undefined && other !== k) return `${at === '' ? '' : `${at}.`}${k}`;
    seen.set(c, k);
    const hit = bothSpellings(v, at === '' ? k : `${at}.${k}`);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

const snake = (key: string): string => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function dotted(path: readonly PropertyKey[]): string {
  return path.map((p) => (typeof p === 'symbol' ? String(p) : snake(String(p)))).join('.');
}

function describeIssue(issue: z.core.$ZodIssue): string[] {
  const base = dotted(issue.path);
  const join2 = (leaf: string) => (base ? `${base}.${leaf}` : leaf);
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((k) => `${join2(snake(k))}: unknown key`);
  }
  return [`${base || '(root)'}: ${issue.message}`];
}

/** Where crew_toolchain_paths moved to (it opens reads on the owner's machine, not the repo's call). */
const OWNER_CONFIG_HINT =
  'crew_toolchain_paths is not read from studio.yaml any more; move it to the owner config ($XDG_CONFIG_HOME/studio/config.yaml or ~/.config/studio/config.yaml)';

export function loadConfig(projectDir: string): StudioConfig {
  const file = join(projectDir, '.studio', 'studio.yaml');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new ConfigError(file, `cannot read file (${(e as Error).message})`);
  }
  return parseConfig(text, file);
}

/** What `loadConfig` does with the text of `file`, without reading it: also for text in memory. */
export function parseConfig(text: string, file: string): StudioConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new ConfigError(file, `invalid YAML (${(e as Error).message})`);
  }
  if (raw !== null && typeof raw === 'object' && 'crew_toolchain_paths' in raw) {
    throw new ConfigError(file, OWNER_CONFIG_HINT);
  }
  const twice = bothSpellings(raw);
  if (twice !== undefined) {
    throw new ConfigError(file, `${twice}: the same key is written in two spellings; keep one`);
  }
  const result = studioConfigSchema.safeParse(camelizeKeys(raw));
  if (!result.success) {
    throw new ConfigError(file, result.error.issues.flatMap(describeIssue).join('; '));
  }
  return result.data;
}

/** Whether Intl knows this time zone (an IANA name). */
export function validTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Usage limits per credential label; the whole block defaults to two crews at once per label. */
export const crewLabelLimitsSchema = z
  .strictObject({
    maxParallel: z.number().int().positive().default(2),
    maxRunsPerDay: z.number().int().positive().optional(),
    // IANA zone whose midnight starts the day count; default is the system zone.
    timezone: z
      .string()
      .refine(validTimeZone, { message: 'not a known IANA time zone' })
      .optional(),
  })
  .default({ maxParallel: 2 });

/** An https base URL: no login, query or fragment, no trailing slash. */
export function validNtfyServer(v: string): boolean {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  return (
    u.protocol === 'https:' &&
    u.username === '' &&
    u.password === '' &&
    u.search === '' &&
    u.hash === '' &&
    !v.endsWith('/') &&
    !/[\s\p{Cc}]/u.test(v)
  );
}

/** Quiet hours: `HH:MM-HH:MM`, 24-hour clock. */
export const QUIET_RE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

/** A project id in a group: `depends_on: <id>:<item>` names it. Same rule as in board.ts. */
export const GROUP_PROJECT_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const groupProjectId = z.string().regex(GROUP_PROJECT_ID_RE, 'must match ^[a-z][a-z0-9-]{0,31}$');

/** A project of a group: its id, its repository and the folder of its checkout on this machine. */
const groupProjectSchema = z.strictObject({
  id: groupProjectId,
  repo: repoName,
  dir: z
    .string()
    .min(1)
    .max(500)
    .refine((p) => isAbsolute(p) && !/\p{Cc}/u.test(p), 'must be an absolute path'),
  // A member only: the contract paths that concern it (default: all of the group's).
  contracts: z.array(globSchema).min(1).max(50).optional(),
});
export type GroupProject = z.infer<typeof groupProjectSchema>;

/**
 * A group of related projects (src/group.ts). It lives here, outside every repository: a project
 * cannot claim to be in a group, name the main project or widen what its crews read.
 */
const groupSchema = z
  .strictObject({
    name: groupProjectId,
    // The project that owns contracts, ADRs and the glossary.
    main: groupProjectId,
    projects: z.array(groupProjectSchema).min(2).max(20),
    // Paths in the main project that member crews get as a read-only excerpt in their brief.
    reference: z.array(globSchema).min(1).max(50),
    // The paths whose change gives each affected member a check item (default: `reference`).
    contracts: z.array(globSchema).min(1).max(50).optional(),
    // The excerpt's total size cap.
    referenceMaxKib: z.number().int().min(16).max(2048).default(256),
  })
  .superRefine((g, ctx) => {
    const ids = new Set<string>();
    for (const [i, p] of g.projects.entries()) {
      if (ids.has(p.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['projects', i, 'id'],
          message: `duplicate project ${p.id}`,
        });
      }
      ids.add(p.id);
      if (p.id === g.main && p.contracts !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['projects', i, 'contracts'],
          message: 'the main project owns the contracts; contracts narrows a member only',
        });
      }
    }
    if (!ids.has(g.main)) {
      ctx.addIssue({
        code: 'custom',
        path: ['main'],
        message: 'must be the id of one of projects',
      });
    }
  });
export type GroupConfig = z.infer<typeof groupSchema>;

/** Owner-level settings, kept outside every repository. */
export const ownerConfigSchema = z.strictObject({
  // Absolute directories a crew may read in addition to its clone, tmp dir and HOME (toolchains
  // below the real home, e.g. a version manager). Default empty: crew uses system toolchains.
  crewToolchainPaths: strList,
  // Absolute path of an executable that hands a crew run its model credential (see README).
  crewCredentialCommand: z.string().min(1).optional(),
  // Opt-in: let crew runs bill the API. An API key would otherwise take precedence over the
  // subscription login, so the variables and settings for it are refused by default.
  allowApiBilling: z.boolean().default(false),
  // Opens the macOS TLS trust service to crew shells so gh can run; weakens the network
  // boundary (SECURITY.md). Off: Studio opens a crew's pull request itself.
  crewAllowMacosTrustService: z.boolean().default(false),
  crewLabelLimits: crewLabelLimitsSchema,
  // Plugins and their marketplaces beyond Studio's defaults that a project's studio.yaml may pin.
  // They live here, outside every repository: a project cannot bring a marketplace of its own.
  allowedPlugins: z.array(allowedPluginSchema).default([]),
  // Absolute directories below which a project's `research.artifacts` may lie. Empty: no project
  // can give its researcher the REA tools. They live here, outside every repository.
  researchRoots: z
    .array(
      z
        .string()
        .min(1)
        .max(500)
        .refine((p) => isAbsolute(p), 'must be absolute'),
    )
    .max(20)
    .default([]),
  // The rea-agents version researcher crews run (`studio research install` installs it). Exact
  // x.y.z only, never a range, tag or prerelease; the default is pinned in Studio. It lives here,
  // because it runs third-party code with the owner's privileges.
  reaVersion: z.string().regex(REA_VERSION_RE, 'must be one exact version (x.y.z)').optional(),
  // Reverse engineering for researcher crews (src/rea-consent.ts). `trust` (the default): REA is
  // installed in full and researcher crews may use every tool class; false: the static install and
  // the classes the owner opens per item (studio research allow).
  research: z.strictObject({ trust: z.boolean().default(true) }).default({ trust: true }),
  // Environment for the REA server (where its analysis engines are): these names only, short
  // values. Never a secret.
  reaEnv: z
    .record(
      z.string().refine(reaEnvKeyOk, 'not a name REA reads (GHIDRA_INSTALL_DIR, JAVA_HOME, REA_*)'),
      z
        .string()
        .max(500)
        .refine((v) => !/\p{Cc}/u.test(v), 'no control characters'),
    )
    .default({}),
  // Push notifications: an absolute executable that gets each message in its environment (see
  // README). It lives here, not in studio.yaml, because it runs on the owner's machine. `quiet`
  // and `language` shape the pushes of `tick` (the topic: `studio setup --notifications`).
  notify: z
    .strictObject({
      channel: z
        .string()
        .regex(/^[A-Za-z0-9._-]{1,64}$/, 'must match [A-Za-z0-9._-]{1,64}')
        .optional(),
      command: z.string().min(1).optional(),
      // Local hours (the owner's zone) in which a push that is not urgent waits, e.g. 22:00-07:00.
      quiet: z
        .string()
        .regex(QUIET_RE, 'must be HH:MM-HH:MM')
        .refine((q) => q.slice(0, 5) !== q.slice(6), 'start and end must differ')
        .optional(),
      // The zone of the quiet hours (IANA); default the system zone.
      timezone: z
        .string()
        .refine(validTimeZone, { message: 'not a known IANA time zone' })
        .optional(),
      // The language of pushes and notify messages: a code with a locale file (hooks/locales) or
      // `auto` (the default): Claude Code's `language` setting, else the locale, else English.
      language: z
        .string()
        .regex(/^(?:auto|[a-z]{2,3})$/, 'must be auto or a language code such as en')
        .refine((v) => v === 'auto' || isLang(v), {
          message: `must be auto or one of ${LANGS.join(', ')}`,
        })
        .optional(),
      // The ntfy server for self-hosters; default https://ntfy.sh.
      ntfyServer: z
        .string()
        .refine(validNtfyServer, 'must be an https URL without query, fragment or login')
        .optional(),
    })
    .refine(
      (n) => (n.channel === undefined) === (n.command === undefined),
      'channel and command go together',
    )
    .optional(),
  // The Studio board in Claude Code (hooks/register.tsx reads this key itself, without a YAML
  // library: hooks/board-model.ts nestedWorktreesOf). `hide`: a session in a git worktree nested
  // under a Studio project starts with the board off (`/studio on` brings it back).
  pane: z.strictObject({ nestedWorktrees: z.enum(['show', 'hide']).default('show') }).optional(),
  // The same daily cost cap as in studio.yaml, over all projects of the owner together.
  limits: dailyLimitsSchema.optional(),
  // Groups of related projects (src/group.ts); a project folder is in at most one.
  groups: z
    .array(groupSchema)
    .max(20)
    .optional()
    .superRefine((groups, ctx) => {
      const names = new Set<string>();
      const dirs = new Map<string, string>();
      for (const [i, g] of (groups ?? []).entries()) {
        if (names.has(g.name)) {
          ctx.addIssue({ code: 'custom', path: [i, 'name'], message: `duplicate group ${g.name}` });
        }
        names.add(g.name);
        for (const [j, p] of g.projects.entries()) {
          const key = pathKey(resolve(p.dir));
          const other = dirs.get(key);
          if (other !== undefined) {
            ctx.addIssue({
              code: 'custom',
              path: [i, 'projects', j, 'dir'],
              message: `this folder is already ${other}: a project is in at most one group, once`,
            });
          }
          dirs.set(key, `${g.name}/${p.id}`);
        }
      }
    }),
  // Workers on other machines (src/worker.ts, src/worker-lead.ts). On the lead's machine,
  // `accept` names the GitHub logins whose claims count, per label; on a worker machine, `self`
  // names the lead whose offers it takes and what its crews must never touch.
  workers: z
    .strictObject({
      // Each with the numeric account id (`gh api users/<login> --jq .id`): a login can be
      // renamed and taken by someone else, the id stays.
      accept: z
        .record(
          workerLabel,
          z
            .array(z.strictObject({ login: githubLogin, id: z.number().int().positive() }))
            .min(1)
            .max(20),
        )
        .default({}),
      self: z
        .strictObject({
          lead: githubLogin,
          // The lead's numeric account id: offers are taken by this, never by the login alone.
          leadId: z.number().int().positive(),
          deny: workerDenySchema.default(NO_DENY),
          // On WSL2 every Windows file system is denied to crews; these places are opened for reads.
          allowRead: z.array(denyPath).max(50).default([]),
          // How long a claim holds without a heartbeat before another worker may take it over.
          leaseMinutes: z.number().int().min(10).max(240).default(30),
        })
        .optional(),
    })
    .optional(),
});

export type OwnerConfig = z.infer<typeof ownerConfigSchema>;

/** Home, environment and platform of the owner; injectable so tests never touch the real ones. */
export interface OwnerEnv {
  homedir?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** The current user id for ownership checks; defaults to the process's. */
  uid?: number;
}

/** An XDG base directory variable, or undefined when unset or relative (the spec ignores those). */
export function xdgDir(env: Record<string, string | undefined>, name: string): string | undefined {
  const v = env[name];
  return v && isAbsolute(v) ? v : undefined;
}

/** `$XDG_CONFIG_HOME/studio/config.yaml`, else `<home>/.config/studio/config.yaml`. */
export function ownerConfigFile(opts: OwnerEnv = {}): string {
  const env = opts.env ?? process.env;
  const base = xdgDir(env, 'XDG_CONFIG_HOME') ?? join(opts.homedir ?? homedir(), '.config');
  return join(base, 'studio', 'config.yaml');
}

/** The directory of the owner config. */
export const ownerConfigDir = (opts: OwnerEnv = {}): string => dirname(ownerConfigFile(opts));

/** Where `studio setup --notifications` keeps the push transport and its secret (key or topic). */
export const notifySecretFile = (opts: OwnerEnv = {}): string =>
  join(ownerConfigDir(opts), 'notify-secret');

/**
 * Where `studio secret set worker-token` keeps a worker machine's own GitHub token: claims, pull
 * requests and pushes for a crew, never handed into a crew session.
 */
export const workerTokenFile = (opts: OwnerEnv = {}): string =>
  join(ownerConfigDir(opts), 'worker-token');

/** Where `studio secret set crew-token` keeps the least-privilege GitHub token. */
export const crewTokenFile = (opts: OwnerEnv = {}): string =>
  join(ownerConfigDir(opts), 'crew-token');

/**
 * Reads the owner config; a missing file means defaults. Toolchain paths get the lexical check
 * here; the launch checks them again against the real filesystem.
 */
export function loadOwnerConfig(opts: OwnerEnv = {}): OwnerConfig {
  const file = ownerConfigFile(opts);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ownerConfigSchema.parse({});
    throw new ConfigError(file, `cannot read file (${(e as Error).message})`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(text) ?? {};
  } catch (e) {
    throw new ConfigError(file, `invalid YAML (${(e as Error).message})`);
  }
  const result = ownerConfigSchema.safeParse(camelizeKeys(raw));
  if (!result.success) {
    throw new ConfigError(file, result.error.issues.flatMap(describeIssue).join('; '));
  }
  const home = opts.homedir ?? homedir();
  const problems = result.data.crewToolchainPaths.flatMap((path) => {
    const problem = toolchainPathProblem(path, home, [], opts.platform);
    return problem ? [`crew_toolchain_paths: ${path}: ${problem}`] : [];
  });
  const command = result.data.crewCredentialCommand;
  if (command !== undefined && !isAbsolute(command)) {
    problems.push('crew_credential_command: must be an absolute path');
  }
  const notifyCommand = result.data.notify?.command;
  if (notifyCommand !== undefined && !isAbsolute(notifyCommand)) {
    problems.push('notify.command: must be an absolute path');
  }
  if (problems.length > 0) throw new ConfigError(file, problems.join('; '));
  return result.data;
}

export const GITHUB_HOSTED_UNLIMITED =
  'ci.runners both: GitHub-hosted concurrency is not checked until github_hosted_limit is set';

/** Non-fatal findings about a loaded config. */
export function configWarnings(config: StudioConfig): string[] {
  const warnings: string[] = [];
  if (config.merge.strategy === 'native-queue') {
    warnings.push(
      'merge.strategy native-queue is not supported yet (planned for stage d): queue add and queue run refuse; use studio-queue',
    );
  }
  if (config.ci.runners === 'both' && config.ci.githubHostedLimit === undefined) {
    warnings.push(GITHUB_HOSTED_UNLIMITED);
  }
  if (config.crewAllowedWorkflowRefs.length > 0) {
    warnings.push(
      `crew_allowed_workflow_refs (${config.crewAllowedWorkflowRefs.join(', ')}) must be protected server-side (branch protection or rulesets): the crew guard cannot stop a push to those refs from another path`,
    );
  }
  if (config.notify !== undefined) {
    warnings.push(
      'notify in studio.yaml has no effect: the notify command is set in the owner config ($XDG_CONFIG_HOME/studio/config.yaml or ~/.config/studio/config.yaml)',
    );
  }
  return warnings;
}
