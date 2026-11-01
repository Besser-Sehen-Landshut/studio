import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Board, WorkItem } from './board.js';
import {
  type AnalyzerRef,
  type ChangedPaths,
  capabilitiesDir,
  itemTriggers,
  loadCapabilities,
  phaseOf,
  type ResolvedSkills,
  resolveSkills,
} from './capabilities.js';
import type { RoleConfig, StudioConfig } from './config.js';
import { removeStateEntry, writeStateFile } from './paths.js';
import type { Ports } from './ports.js';
import {
  type CrewCaps,
  capsFile,
  type RoutineAnalyzer,
  readPrFacts,
  reviewRounds,
  reviewTarget,
  reviewTier,
} from './review.js';
import { loadSources } from './sources.js';

const MAX_COPY_BYTES = 256 * 1024;
const MANDATORY = ['diff-review', 'spec-check', 'security'];
const NO_SKILLS = { required: [], allowed: [], denied: [] };

/** The item's own model, else the one for its type, else the role's. */
export function resolveModel(item: WorkItem, role: RoleConfig): string {
  return item.model ?? role.types?.[item.type] ?? role.model;
}

/** Declared globs as paths a capability glob can match: `src/auth/**` reads as `src/auth/x`. */
const concrete = (globs: readonly string[]): string[] =>
  globs.map((g) => g.replace(/\*+|\?/g, 'x'));

export interface ResolvedForItem {
  resolved: ResolvedSkills;
  review?: {
    tier: 'small' | 'large';
    reasons: string[];
    round: number;
    target?: string;
  };
}

/**
 * Works out the item's skills, knowledge and analyzers without writing anything. For review work
 * it reads the pull request; whatever it cannot read counts as everything changed.
 */
export async function resolveForItem(o: {
  item: WorkItem;
  config: StudioConfig;
  ports: Ports;
  readBoard: () => Board;
  dir?: string;
}): Promise<ResolvedForItem> {
  const { item, config } = o;
  const index = loadCapabilities(o.dir ?? capabilitiesDir());
  const roleSkills = config.roles[item.role]?.skills ?? NO_SKILLS;
  const stack = config.stacks ?? [];
  const phase = phaseOf(item);
  const declared = concrete([...item.paths, ...item.touches]);
  const base = { index, roleSkills };
  if (phase !== 'review') {
    return {
      resolved: resolveSkills(item, item.role, stack, declared, phase, {
        ...base,
        triggers: itemTriggers(item),
      }),
    };
  }
  const target = reviewTarget(item);
  if (target === undefined && item.type === 'review') {
    throw new Error(`${item.id} names no pull request: add the note review <owner/repo>#<n>`);
  }
  const facts = target === undefined ? undefined : await readPrFacts(o.ports, target);
  const paths: ChangedPaths = facts?.complete ? [...facts.files, ...declared] : 'unknown';
  const name = target === undefined ? undefined : `${target.repo}#${target.pr}`;
  let round: number;
  try {
    round = name === undefined ? 0 : reviewRounds(o.readBoard(), name);
  } catch {
    // An unreadable board must not hide earlier rounds: the scan runs once too often at worst.
    round = 1;
  }
  const triggers = [...itemTriggers(item), ...(round > 0 ? ['after-fix'] : [])];
  const first = resolveSkills(item, item.role, stack, paths, phase, { ...base, triggers });
  const { tier, reasons } = reviewTier(
    item,
    facts,
    first.analyzers.some((a) => a.id === 'security'),
  );
  return {
    resolved: resolveSkills(item, item.role, stack, paths, phase, { ...base, triggers, tier }),
    review: { tier, reasons, round, ...(name === undefined ? {} : { target: name }) },
  };
}

/** A regular file below `root`, with no link on the way, of a bounded size; else why not. */
function readBelow(root: string, rel: string): { text: string } | { why: string } {
  try {
    let at = root;
    const segments = rel.split('/');
    if (lstatSync(at).isSymbolicLink()) return { why: 'it is reached through a link' };
    for (const [i, seg] of segments.entries()) {
      if (seg === '..' || seg === '' || seg === '.') return { why: 'it leaves the source' };
      at = join(at, seg);
      const st = lstatSync(at);
      if (st.isSymbolicLink()) return { why: 'it is reached through a link' };
      if (i < segments.length - 1 ? !st.isDirectory() : !st.isFile()) {
        return { why: 'it is not a regular file' };
      }
      if (i === segments.length - 1 && st.size > MAX_COPY_BYTES) {
        return { why: 'it is larger than 256 KiB' };
      }
    }
    return { text: readFileSync(at, 'utf8') };
  } catch {
    return { why: 'it cannot be read' };
  }
}

export interface BriefCaps {
  required: string[];
  whenAvailable: string[];
  offered: string[];
  denied: string[];
  skipped: { id: string; reason: string }[];
  knowledge: { ref: string; where: string; fallback?: string }[];
  review?: {
    tier: 'small' | 'large';
    reasons: string[];
    round: number;
    contract: string;
    analyzers: RoutineAnalyzer[];
  };
}

/**
 * The brief's skill lists with nothing copied: what a brief says when no launch prepared it. Used
 * by `writeBrief`'s default, so a brief always carries the resolver's answer.
 */
export function plainCaps(item: WorkItem, config: StudioConfig): BriefCaps {
  const skills = config.roles[item.role]?.skills ?? NO_SKILLS;
  const r = resolveSkills(
    item,
    item.role,
    config.stacks ?? [],
    concrete([...item.paths, ...item.touches]),
    phaseOf(item),
    { roleSkills: skills },
  );
  return {
    required: r.required,
    whenAvailable: r.optionalRequired,
    offered: r.offered,
    denied: r.denied,
    skipped: [],
    knowledge: [],
  };
}

/**
 * Copies only what matching rows name to `briefs/<id>.caps/`, out of the crew's write reach, and
 * records what a reviewer owes. Nothing else of `capabilities/` reaches a crew.
 */
export function writeCaps(o: {
  stateRoot: string;
  ownerRoot: string;
  id: string;
  forItem: ResolvedForItem;
  dir?: string;
  isInstalled: (skill: string) => boolean | undefined;
}): BriefCaps {
  const { stateRoot, id, forItem } = o;
  const { resolved, review } = forItem;
  const shipped = o.dir ?? capabilitiesDir();
  const capsDir = join(stateRoot, 'briefs', `${id}.caps`);
  removeStateEntry(stateRoot, capsDir);
  removeStateEntry(stateRoot, capsFile(stateRoot, id));
  const skipped: { id: string; reason: string }[] = [];
  const copy = (rel: string, text: string): string => {
    const file = join(capsDir, ...rel.split('/'));
    writeStateFile(stateRoot, file, text);
    return file;
  };
  const sourceReads = (source: string): string[] | undefined => {
    const entry = loadSources(shipped).sources.find((s) => s.id === source);
    return entry?.reads.filter((r) => r !== 'LICENSE');
  };
  const sourceRoot = (source: string) => join(o.ownerRoot, 'sources', source);

  const knowledge: BriefCaps['knowledge'] = [];
  for (const k of resolved.knowledge) {
    const colon = k.ref.indexOf(':');
    const kind = k.ref.slice(0, colon);
    const rest = k.ref.slice(colon + 1);
    if (kind === 'bundled') {
      knowledge.push({
        ref: k.ref,
        where: rest,
        ...(k.fallback === undefined ? {} : { fallback: k.fallback.replace(/^skill:/, '') }),
      });
      continue;
    }
    if (kind === 'source') {
      const source = rest.slice(0, rest.indexOf('/'));
      const rel = rest.slice(source.length + 1);
      try {
        lstatSync(sourceRoot(source));
      } catch {
        skipped.push({ id: k.rowId, reason: `source ${source} not fetched` });
        continue;
      }
      const got = readBelow(sourceRoot(source), rel);
      if ('why' in got) {
        skipped.push({ id: k.rowId, reason: `source ${source}: ${got.why}` });
        continue;
      }
      knowledge.push({ ref: k.ref, where: copy(`sources/${source}/${rel}`, got.text) });
      continue;
    }
    const got = readBelow(join(shipped, kind), rest);
    if ('why' in got) {
      skipped.push({ id: k.rowId, reason: `shipped file: ${got.why}` });
      continue;
    }
    knowledge.push({ ref: k.ref, where: copy(`${kind}/${rest}`, got.text) });
  }

  const analyzers: RoutineAnalyzer[] = [];
  const copyAnalyzer = (a: AnalyzerRef): boolean => {
    const got = readBelow(join(shipped, 'analyzers'), `${a.id}.md`);
    if ('why' in got) {
      if (MANDATORY.includes(a.id)) {
        throw new Error(`analyzer ${a.id} is missing from the plugin; refusing to launch`);
      }
      skipped.push({ id: a.id, reason: `shipped file: ${got.why}` });
      return false;
    }
    if (a.source !== undefined) {
      const reads = sourceReads(a.source) ?? [];
      const texts: { rel: string; text: string }[] = [];
      for (const rel of reads) {
        try {
          lstatSync(sourceRoot(a.source));
        } catch {
          skipped.push({ id: a.id, reason: `source ${a.source} not fetched` });
          return false;
        }
        const part = readBelow(sourceRoot(a.source), rel);
        if ('why' in part) {
          skipped.push({ id: a.id, reason: `source ${a.source}: ${part.why}` });
          return false;
        }
        texts.push({ rel, text: part.text });
      }
      for (const t of texts) {
        const where = copy(`sources/${a.source}/${t.rel}`, t.text);
        knowledge.push({ ref: `source:${a.source}/${t.rel}`, where });
      }
    }
    analyzers.push({
      id: a.id,
      path: copy(`analyzers/${a.id}.md`, got.text),
      ...(a.model === undefined ? {} : { model: a.model }),
    });
    return true;
  };
  for (const a of resolved.analyzers) copyAnalyzer(a);

  const whenAvailable: string[] = [];
  for (const skill of resolved.optionalRequired) {
    if (o.isInstalled(skill) === false) skipped.push({ id: skill, reason: 'skill not installed' });
    else whenAvailable.push(skill);
  }

  let reviewOut: BriefCaps['review'];
  if (review !== undefined) {
    const contract = readBelow(join(shipped, 'analyzers'), 'CONTRACT.md');
    if ('why' in contract) throw new Error('the analyzer contract is missing from the plugin');
    reviewOut = {
      tier: review.tier,
      reasons: review.reasons,
      round: review.round,
      contract: copy('analyzers/CONTRACT.md', contract.text),
      analyzers,
    };
    const ids = analyzers.map((a) => a.id);
    const caps: CrewCaps = {
      tier: review.tier,
      analyzers: ids,
      mandatory: MANDATORY.filter((m) => ids.includes(m)),
      ...(review.target === undefined ? {} : { reviewsTarget: review.target }),
    };
    writeStateFile(stateRoot, capsFile(stateRoot, id), `${JSON.stringify(caps, null, 2)}\n`);
  }
  return {
    required: resolved.required,
    whenAvailable,
    offered: resolved.offered,
    denied: resolved.denied,
    skipped,
    knowledge,
    ...(reviewOut === undefined ? {} : { review: reviewOut }),
  };
}
