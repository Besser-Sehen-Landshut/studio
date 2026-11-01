// Globs for capabilities and role skills. They come from repo config and paths come from pull
// requests, so nothing here may backtrack or expand without a limit. No regular expressions:
// a state machine costs at most glob length x path length, and every character is just a character.

export const MAX_GLOB_LENGTH = 256;
export const MAX_GLOB_GROUPS = 8;
export const MAX_GLOB_EXPANSIONS = 64;
export const MAX_GLOB_WILDCARDS = 16;
export const MAX_PATH_LENGTH = 4096;

const CONTROL = /\p{Cc}/u;

/** Consecutive globstars are one globstar. */
function normalize(glob: string): string {
  return glob
    .replace(/\*{3,}/g, '**')
    .replace(/(?:\*\*\/)+/g, '**/')
    .replace(/\*\*\/\*\*(?!\/)/g, '**');
}

/** Brace structure: flat groups only, so this count and the expander cannot disagree. */
function braceShape(glob: string): { problem?: string; expansions: number } {
  let depth = 0;
  let alternatives = 1;
  let expansions = 1;
  for (const c of glob) {
    if (c === '{') {
      if (depth > 0) return { problem: 'nested braces in glob', expansions };
      depth = 1;
      alternatives = 1;
    } else if (c === '}') {
      if (depth === 0) return { problem: 'unbalanced braces in glob', expansions };
      depth = 0;
      expansions = Math.min(expansions * alternatives, MAX_GLOB_EXPANSIONS + 1);
    } else if (c === ',' && depth > 0) alternatives++;
  }
  if (depth > 0) return { problem: 'unbalanced braces in glob', expansions };
  return { expansions };
}

/** Why this glob is refused, or undefined. Schemas use it; `matchGlob` treats a refused one as a hit. */
export function globProblem(glob: string): string | undefined {
  if (glob.length === 0) return 'empty glob';
  if (glob.length > MAX_GLOB_LENGTH) return `glob longer than ${MAX_GLOB_LENGTH} characters`;
  if (CONTROL.test(glob)) return 'control character in glob';
  const shape = braceShape(glob);
  if (shape.problem !== undefined) return shape.problem;
  if ([...glob].filter((c) => c === '{').length > MAX_GLOB_GROUPS) {
    return `more than ${MAX_GLOB_GROUPS} brace groups in glob`;
  }
  if (shape.expansions > MAX_GLOB_EXPANSIONS) {
    return `glob expands to more than ${MAX_GLOB_EXPANSIONS} patterns`;
  }
  const wildcards = normalize(glob).match(/\*+|\?/g)?.length ?? 0;
  if (wildcards > MAX_GLOB_WILDCARDS) return `more than ${MAX_GLOB_WILDCARDS} wildcards in glob`;
  return undefined;
}

/**
 * The plain globs a pattern stands for, or undefined at the budget. The budget runs over all work,
 * so no shape of braces can outrun it, whatever the validator said.
 */
export function expandBraces(glob: string): string[] | undefined {
  const done: string[] = [];
  const open = [glob];
  let steps = 0;
  while (open.length > 0) {
    if (++steps > MAX_GLOB_EXPANSIONS * 4) return undefined;
    const g = open.pop() as string;
    const m = /\{([^{}]*)\}/.exec(g);
    if (!m) {
      done.push(g);
      if (done.length > MAX_GLOB_EXPANSIONS) return undefined;
      continue;
    }
    const alternatives = (m[1] as string).split(',');
    if (open.length + alternatives.length > MAX_GLOB_EXPANSIONS * 4) return undefined;
    const head = g.slice(0, m.index);
    const tail = g.slice(m.index + m[0].length);
    for (const alt of alternatives.reverse()) open.push(head + alt + tail);
  }
  return [...new Set(done)];
}

type Token =
  | { k: 'char'; c: string }
  | { k: 'one' } // ?
  | { k: 'star' } // * within a segment
  | { k: 'any' } // ** at the end of a segment: anything
  | { k: 'dirs' }; // **/ zero or more whole segments

function tokenize(glob: string): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        out.push({ k: 'dirs' });
        i += 2;
      } else {
        out.push({ k: 'any' });
        i += 1;
      }
    } else if (c === '*') out.push({ k: 'star' });
    else if (c === '?') out.push({ k: 'one' });
    else out.push({ k: 'char', c: c.toLowerCase() });
  }
  return out;
}

/** Runs the tokens over the path, tracking every state at once. */
function run(tokens: readonly Token[], path: string): boolean {
  const size = tokens.length + 1;
  let at = new Uint8Array(size);
  // Inside a segment that `dirs` at this index is skipping.
  let skipping = new Uint8Array(size);
  const settle = (states: Uint8Array) => {
    for (let i = 0; i < tokens.length; i++) {
      const k = tokens[i]?.k;
      if (states[i] && (k === 'star' || k === 'any' || k === 'dirs')) states[i + 1] = 1;
    }
  };
  at[0] = 1;
  settle(at);
  for (const c of path) {
    const next = new Uint8Array(size);
    const nextSkipping = new Uint8Array(size);
    const slash = c === '/';
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i] as Token;
      if (t.k === 'dirs') {
        if (at[i] || skipping[i]) {
          if (slash) next[i] = 1;
          else nextSkipping[i] = 1;
        }
        continue;
      }
      if (!at[i]) continue;
      if (t.k === 'char') {
        if (c === t.c) next[i + 1] = 1;
      } else if (t.k === 'one') {
        if (!slash) next[i + 1] = 1;
      } else if (t.k === 'star') {
        if (!slash) next[i] = 1;
      } else next[i] = 1;
    }
    settle(next);
    at = next;
    skipping = nextSkipping;
  }
  return at[tokens.length] === 1;
}

/**
 * `**`, `*`, `?` and `{a,b}`; case-insensitive, because a file system or a person may be. Any
 * character counts, newlines too. A glob over the limits matches everything: it fails closed.
 */
export function matchGlob(glob: string, path: string): boolean {
  if (globProblem(glob) !== undefined) return true;
  const globs = expandBraces(normalize(glob));
  if (globs === undefined) return true;
  const lower = path.toLowerCase();
  return globs.some((g) => run(tokenize(g), lower));
}

/** A path no reviewer can read at a glance: every path condition counts as hit. */
export function hostilePath(path: string): boolean {
  return path.length > MAX_PATH_LENGTH || CONTROL.test(path);
}
