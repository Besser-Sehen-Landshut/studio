// How a project names its migrations: the folder they live in and how a number is read from a
// name in it (`migrations:` in studio.yaml). Pure and without imports, so config.ts can use it.

/** The pattern when studio.yaml names none: leading digits up to an underscore, `0042_x.sql`. */
export const DEFAULT_NUMBER_PATTERN = '^(\\d+)_';

/** Longest pattern studio.yaml may hold. */
export const MAX_PATTERN_LENGTH = 200;
/** Longest name a pattern is run on: a longer one in the folder counts as `TOO_LARGE`. */
const MAX_NAME_LENGTH = 255;
/** More digits than this do not fit a safe integer: such a capture is no number. */
const MAX_DIGITS = 15;

/** Capturing groups of `re`: an empty alternative matches `''` and yields one slot per group. */
function captureGroups(re: RegExp): number {
  const m = new RegExp(`${re.source}|`).exec('');
  return m === null ? 0 : m.length - 1;
}

/**
 * Why `pattern` cannot read migration numbers, or undefined. It must compile, hold exactly one
 * capturing group (the number) and carry no quantified group that holds a quantifier itself, the
 * shape whose backtracking can take very long (`(\d+)+`).
 */
export function numberPatternProblem(pattern: string): string | undefined {
  if (pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH) {
    return `must be a regular expression of 1 to ${MAX_PATTERN_LENGTH} characters`;
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    return 'is not a valid regular expression';
  }
  const groups = captureGroups(re);
  if (groups !== 1) {
    return `must hold exactly one capturing group, the number (it holds ${groups}); use (?:...) for others`;
  }
  if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)[+*{]/.test(pattern)) {
    return 'must not repeat a group that repeats itself, such as (\\d+)+';
  }
  return undefined;
}

/**
 * Why `dir` is no migrations folder of a repository, or undefined: a relative POSIX path of plain
 * segments, no `.` or `..`, no leading or trailing slash.
 */
export function migrationDirProblem(dir: string): string | undefined {
  if (dir.length === 0 || dir.length > 200) return 'must be a path of 1 to 200 characters';
  const segments = dir.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..' || !/^[A-Za-z0-9._-]+$/.test(s))) {
    return 'must be a relative path in the repository (letters, digits, . _ - and /), without . or .. segments and without a slash at either end';
  }
  return undefined;
}

/**
 * The migration a repository path belongs to: the first segment below `dir` (a file such as
 * `0042_x.sql`, or a folder such as `20240101120000_init/` that holds the migration's files).
 * Undefined for a path outside `dir` or `dir` itself.
 */
export function migrationEntryOf(path: string, dir: string): string | undefined {
  if (!path.startsWith(`${dir}/`)) return undefined;
  const entry = path.slice(dir.length + 1).split('/')[0];
  return entry === undefined || entry === '' ? undefined : entry;
}

/** A capture that is a number, but one too large to compare safely: never read as no migration. */
export const TOO_LARGE = 'too-large';

/**
 * The number of a migration entry: the digits the pattern's one group captures, leading zeros
 * aside. Undefined when the name does not match or the capture is no plain run of digits;
 * `TOO_LARGE` when the value has more than 15 digits, which callers treat as a problem (fails
 * closed), never as a name that is no migration.
 */
export function migrationNumberOf(
  entry: string,
  pattern: RegExp,
): number | typeof TOO_LARGE | undefined {
  // A name this long is refused, not skipped: the pattern is never run on it.
  if (entry.length > MAX_NAME_LENGTH) return TOO_LARGE;
  const m = pattern.exec(entry);
  const digits = m?.slice(1).find((g) => g !== undefined);
  if (digits === undefined || !/^\d+$/.test(digits)) return undefined;
  const value = digits.replace(/^0+(?=\d)/, '');
  return value.length > MAX_DIGITS ? TOO_LARGE : Number(value);
}
