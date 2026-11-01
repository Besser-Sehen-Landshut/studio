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

/** How many plain globs a pattern stands for; undefined when its braces do not balance. */
function countExpansions(glob: string): number | undefined {
  let total = 1;
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '}') return undefined;
    if (c !== '{') {
      i++;
      continue;
    }
    let depth = 1;
    let j = i + 1;
    let start = j;
    let sum = 0;
    for (; j < glob.length && depth > 0; j++) {
      if (glob[j] === '{') depth++;
      else if (glob[j] === '}') depth--;
      if ((depth === 1 && glob[j] === ',') || depth === 0) {
        const part = countExpansions(glob.slice(start, j));
        if (part === undefined) return undefined;
        sum += part;
        start = j + 1;
      }
    }
    if (depth > 0) return undefined;
    total = Math.min(total * sum, MAX_GLOB_EXPANSIONS + 1);
    i = j;
  }
  return total;
}

/** Why this glob is refused, or undefined. Schemas use it; `matchGlob` treats a refused one as a hit. */
export function globProblem(glob: string): string | undefined {
  if (glob.length === 0) return 'empty glob';
  if (glob.length > MAX_GLOB_LENGTH) return `glob longer than ${MAX_GLOB_LENGTH} characters`;
  if (CONTROL.test(glob)) return 'control character in glob';
  if ([...glob].filter((c) => c === '{').length > MAX_GLOB_GROUPS) {
    return `more than ${MAX_GLOB_GROUPS} brace groups in glob`;
  }
  const n = countExpansions(glob);
  if (n === undefined) return 'unbalanced braces in glob';
  if (n > MAX_GLOB_EXPANSIONS) return `glob expands to more than ${MAX_GLOB_EXPANSIONS} patterns`;
  const wildcards = normalize(glob).match(/\*+|\?/g)?.length ?? 0;
  if (wildcards > MAX_GLOB_WILDCARDS) return `more than ${MAX_GLOB_WILDCARDS} wildcards in glob`;
  return undefined;
}

function expandBraces(glob: string): string[] {
  const m = /\{([^{}]*)\}/.exec(glob);
  if (!m) return [glob];
  const head = glob.slice(0, m.index);
  const tail = glob.slice(m.index + m[0].length);
  return (m[1] as string).split(',').flatMap((alt) => expandBraces(head + alt + tail));
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
  const lower = path.toLowerCase();
  return expandBraces(normalize(glob)).some((g) => run(tokenize(g), lower));
}

/** A path no reviewer can read at a glance: every path condition counts as hit. */
export function hostilePath(path: string): boolean {
  return path.length > MAX_PATH_LENGTH || CONTROL.test(path);
}
