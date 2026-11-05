// What a worker machine can enforce for its crews, and how. A worker runs a crew exactly like the
// lead does: Claude Code's sandbox is the boundary, Studio's guard is a convenience on top. So a
// worker only claims work where that sandbox exists and every deny entry maps onto it; anything
// else refuses with a line that says why (fail closed).
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute, join, posix } from 'node:path';
import { pathKey, type WorkerDeny, wildcardOverIp, within } from './config.js';

export { namedDeniedPort } from './guard.js';

/** The facts about the machine that decide what a worker can enforce. */
export interface WorkerPlatform {
  platform: NodeJS.Platform;
  /**
   * Linux under the Windows Subsystem for Linux, and which version; `none` elsewhere, `unknown`
   * when signs of WSL are there but the version cannot be told.
   */
  wsl: 'none' | 'wsl1' | 'wsl2' | 'unknown';
  /**
   * WSL interop (starting Windows programs from Linux): true when on, false when off, undefined
   * when it cannot be told. Only read under WSL.
   */
  interop?: boolean;
  /** Where WSL mounts the Windows drives (`[automount] root` of /etc/wsl.conf); `/mnt/` by default. */
  automountRoot: string;
  /** Mount points of Windows file systems (drvfs, 9p, virtiofs) from /proc/self/mountinfo. */
  windowsMounts?: string[];
}

type ReadText = (file: string) => string | undefined;

const readText: ReadText = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

/** `[automount] root = ...` of a wsl.conf text, with a trailing slash; the default `/mnt/`. */
export function automountRoot(conf: string | undefined): string {
  let section = '';
  for (const raw of (conf ?? '').split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, '').trim();
    const head = /^\[(.+)\]$/.exec(line);
    if (head) {
      section = (head[1] as string).trim().toLowerCase();
      continue;
    }
    const kv = /^([A-Za-z]+)\s*=\s*(.+)$/.exec(line);
    if (section === 'automount' && kv && (kv[1] as string).toLowerCase() === 'root') {
      const v = (kv[2] as string).trim().replace(/^"(.*)"$/, '$1');
      if (v.startsWith('/') && !v.split('/').includes('..')) return v.endsWith('/') ? v : `${v}/`;
    }
  }
  return '/mnt/';
}

/** Mount points of Windows file systems in a mountinfo text (field 5; the type after ` - `). */
export function windowsMountsOf(mountinfo: string | undefined): string[] {
  const out: string[] = [];
  for (const line of (mountinfo ?? '').split('\n')) {
    const [left, right] = line.split(' - ');
    if (left === undefined || right === undefined) continue;
    const point = left.split(' ')[4];
    const type = right.split(' ')[0];
    if (point === undefined || type === undefined) continue;
    if (!/^(drvfs|9p|virtiofs)$/.test(type)) continue;
    // mountinfo escapes space, tab, newline and backslash as octal.
    const p = point.replace(/\\([0-7]{3})/g, (_, o: string) =>
      String.fromCharCode(Number.parseInt(o, 8)),
    );
    if (p.startsWith('/') && p !== '/' && !out.includes(p)) out.push(p);
  }
  return out;
}

/** Reads the platform facts; `platform`, `read`, `env` and `exists` are seams for tests. */
export function detectPlatform(
  platform: NodeJS.Platform = process.platform,
  read: ReadText = readText,
  env: Record<string, string | undefined> = process.env,
  exists: (p: string) => boolean = existsSync,
): WorkerPlatform {
  if (platform !== 'linux') return { platform, wsl: 'none', automountRoot: '/mnt/' };
  const release = read('/proc/sys/kernel/osrelease') ?? '';
  // Any sign of WSL counts: the kernel name, the interop entries, the distro variable, /run/WSL.
  const signs =
    /microsoft/i.test(release) ||
    read('/proc/sys/fs/binfmt_misc/WSLInterop') !== undefined ||
    read('/proc/sys/fs/binfmt_misc/WSLInterop-late') !== undefined ||
    (env.WSL_DISTRO_NAME ?? '') !== '' ||
    exists('/run/WSL');
  if (!signs) return { platform, wsl: 'none', automountRoot: '/mnt/' };
  // WSL2 kernels name themselves `...-microsoft-standard-WSL2`; WSL1 reports `...-Microsoft`.
  const wsl = /WSL2|microsoft-standard/i.test(release)
    ? 'wsl2'
    : /microsoft/i.test(release)
      ? 'wsl1'
      : 'unknown';
  // binfmt_misc holds a WSLInterop entry while interop is on, and WSLInterop-late beside it when
  // it was registered late: interop counts as on when either says `enabled` on its first line.
  const entries = [
    read('/proc/sys/fs/binfmt_misc/WSLInterop'),
    read('/proc/sys/fs/binfmt_misc/WSLInterop-late'),
  ].filter((e): e is string => e !== undefined);
  const status = read('/proc/sys/fs/binfmt_misc/status');
  let interop: boolean | undefined;
  if (entries.length > 0) interop = entries.some((e) => /^enabled/m.test(e));
  else if (status !== undefined) interop = false;
  return {
    platform,
    wsl,
    ...(interop === undefined ? {} : { interop }),
    automountRoot: automountRoot(read('/etc/wsl.conf')),
    windowsMounts: windowsMountsOf(read('/proc/self/mountinfo')),
  };
}

/**
 * Why crews cannot run sandboxed here, or undefined. Claude Code's sandbox runs on macOS, Linux
 * and WSL2 (https://code.claude.com/docs/en/sandboxing); on native Windows it runs commands
 * unsandboxed, and Studio never starts a crew without it. Under WSL2 a crew can hand a Windows
 * program to the host through interop, and that program runs outside the Linux sandbox, so a
 * worker refuses while interop is on or cannot be told off.
 */
export function sandboxProblem(p: WorkerPlatform): string | undefined {
  if (p.platform === 'win32') {
    return 'native Windows has no sandbox for crew commands (Claude Code runs them unsandboxed there); run studio worker inside a WSL2 distribution on this machine';
  }
  if (p.platform !== 'linux' && p.platform !== 'darwin') {
    return `${p.platform} has no sandbox for crew commands; a worker runs on macOS, Linux or WSL2`;
  }
  if (p.wsl === 'unknown') {
    return 'this looks like WSL, but its version cannot be told; a worker runs only in WSL2 with interop off';
  }
  if (p.wsl === 'wsl1') {
    return 'WSL1 has no sandbox for crew commands; convert the distribution to WSL2 (wsl --set-version <distro> 2)';
  }
  if (p.wsl === 'wsl2' && p.interop !== false) {
    return p.interop === undefined
      ? 'cannot tell whether WSL interop is off: a crew could start Windows programs outside the sandbox; set [interop] enabled=false in /etc/wsl.conf, run wsl --shutdown and start the worker again'
      : 'WSL interop is on: a crew could start Windows programs, which run outside the sandbox; set [interop] enabled=false in /etc/wsl.conf, run wsl --shutdown and start the worker again';
  }
  return undefined;
}

/** What a launch hands the sandbox and the guard for one worker's deny list. */
export interface EnforcedDeny {
  /** Absolute paths the sandbox denies for reads and writes (literal and real spelling). */
  paths: string[];
  /** Ports on the worker machine: the guard refuses commands that name them. */
  ports: number[];
  /** Places inside a denied Windows mount the owner opened for reads (`workers.self.allow_read`). */
  allowRead: string[];
  /** One line per entry that is enforced more widely than written, for the worker's output. */
  notes: string[];
}

const WINDOWS_DRIVE = /^([A-Za-z]):[\\/]/;

const realOr = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * A host as a resolver will see it: lowercased, one trailing dot dropped, then WHATWG URL host
 * normalisation, which turns every IPv4 spelling (`0x7f.1`, `2130706433`, `127.1`) into dotted
 * form and IPv6 into its compressed form. A leading `*.` wildcard is kept aside. `undefined` when
 * the host does not parse: such an entry is refused.
 */
export function normalizeHost(
  host: string,
): { host: string; wildcard: boolean; ip: 0 | 4 | 6 } | undefined {
  let h = host.toLowerCase();
  if (h === '*') return { host: '*', wildcard: true, ip: 0 };
  const wildcard = h.startsWith('*.');
  if (wildcard) h = h.slice(2);
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h === '' || h.endsWith('.')) return undefined;
  // A bare IPv6 address needs brackets in a URL.
  const forUrl = h.includes(':') && !h.startsWith('[') ? `[${h}]` : h;
  let parsed: string;
  try {
    parsed = new URL(`http://${forUrl}/`).hostname;
  } catch {
    return undefined;
  }
  if (parsed === '') return undefined;
  const bare = parsed.startsWith('[') && parsed.endsWith(']') ? parsed.slice(1, -1) : parsed;
  const ip = isIP(bare);
  return { host: bare, wildcard, ip: ip === 4 ? 4 : ip === 6 ? 6 : 0 };
}

/** Names that can resolve to this machine or the local network: the proxy would reach their ports. */
function localName(host: string): boolean {
  const n = normalizeHost(host);
  if (n === undefined) return true;
  const h = n.host;
  if (h === '*' || h === 'localhost' || h.endsWith('.localhost')) return true;
  if (n.ip !== 0) return false;
  if (!h.includes('.')) return true;
  return /\.(local|lan|internal|intranet|home\.arpa|localdomain)$/.test(h);
}

/**
 * Whether a host is an IP address in any spelling a resolver takes, after `normalizeHost`: IPv4
 * in dotted, short, integer, octal or hex form, IPv6 bracketed or bare, mapped forms included.
 */
export function ipLiteral(host: string): boolean {
  const n = normalizeHost(host);
  return n !== undefined && !n.wildcard && n.ip !== 0;
}

/** Splits a `network_allow` entry into host and port (`[::1]:443`, `example.org:8080`). */
export function hostPort(entry: string): { host: string; port?: number } {
  const v6 = /^(\[[^\]]+\])(?::(\d+))?$/.exec(entry);
  if (v6) return { host: v6[1] as string, ...(v6[2] ? { port: Number(v6[2]) } : {}) };
  const m = /^([^:]+):(\d+)$/.exec(entry);
  return m ? { host: m[1] as string, port: Number(m[2]) } : { host: entry };
}

/**
 * Maps a deny list onto the sandbox and the guard, or says why it cannot be enforced here.
 *
 * Paths: an absolute POSIX path is denied as written and as its real path. A Windows drive path is
 * enforced only inside WSL2, where the drive is mounted below the automount root; the drive is
 * case-insensitive, so `/mnt/d/Data` and `/mnt/d/DATA` are the same place and a rule for one
 * spelling would not hold the other: the whole drive is denied instead, and a note says so. A
 * Windows path anywhere else, a path that covers the worker's own checkout, state or toolchains,
 * and `/` itself refuse.
 *
 * Ports: a crew command has no direct route out; its traffic goes through the sandbox proxy, which
 * refuses names that resolve only to local addresses (https://code.claude.com/docs/en/sandboxing).
 * What could still reach a port of this machine or its network is an allowed host that is local:
 * an IP literal, `localhost`, a bare `*`, a name without a dot or a local suffix. With ports
 * denied, such an entry refuses; the guard also refuses commands that name a denied port.
 */
export function enforceDeny(o: {
  deny: WorkerDeny;
  platform: WorkerPlatform;
  networkAllow: readonly string[];
  /** The worker's checkout, state root and toolchain paths: a deny entry must not cover them. */
  keep: readonly string[];
  /** Places on Windows mounts the owner opens for reads, one by one (`workers.self.allow_read`). */
  allowRead?: readonly string[];
}): EnforcedDeny | { refused: string } {
  const paths: string[] = [];
  const notes: string[] = [];
  const key = (p: string) => pathKey(p, o.platform.platform);
  const wsl = o.platform.wsl === 'wsl2';
  const root = o.platform.automountRoot;
  const explicit: string[] = [];
  for (const entry of o.deny.paths) {
    const drive = WINDOWS_DRIVE.exec(entry);
    let target: string;
    if (drive) {
      if (!wsl) {
        return {
          refused: `deny path ${entry} is a Windows path: only a worker inside WSL2 can enforce it`,
        };
      }
      target = `${root}${(drive[1] as string).toLowerCase()}`;
      notes.push(
        `deny path ${entry}: the whole drive ${target} is denied, because Windows drives ignore case and a narrower rule could be bypassed by another spelling`,
      );
    } else {
      if (!isAbsolute(entry) || entry.includes('\\')) {
        return { refused: `deny path ${entry} is not an absolute path` };
      }
      target = posix.normalize(entry).replace(/\/+$/, '') || '/';
      // A path below the automount root is a Windows drive as well.
      const mounted = wsl
        ? new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([a-z])(/|$)`, 'i').exec(
            target,
          )
        : null;
      if (mounted) {
        const whole = `${root}${(mounted[1] as string).toLowerCase()}`;
        if (whole !== target) {
          notes.push(
            `deny path ${entry}: the whole drive ${whole} is denied, because Windows drives ignore case and a narrower rule could be bypassed by another spelling`,
          );
        }
        target = whole;
      }
    }
    if (target === '/') return { refused: `deny path ${entry} denies everything` };
    explicit.push(target);
    for (const spelling of [target, realOr(target)]) {
      const k = key(spelling);
      const hit = o.keep.find((p) => within(key(p), k) || within(k, key(p)));
      if (hit !== undefined) {
        return {
          refused: `deny path ${entry} overlaps ${hit}, which the worker needs for its own checkout, state or toolchains`,
        };
      }
      if (!paths.includes(spelling)) paths.push(spelling);
    }
  }
  // On WSL2 every Windows file system is denied by default: the automount root and each drvfs,
  // 9p or virtiofs mount. The owner opens single places for reads; writes stay denied.
  const allowRead: string[] = [];
  if (wsl) {
    const defaults = [root.replace(/\/+$/, ''), ...(o.platform.windowsMounts ?? [])];
    for (const d of defaults) {
      if (d === '' || d === '/') continue;
      const hit = o.keep.find((p) => within(key(p), key(d)));
      if (hit !== undefined) {
        return {
          refused: `${hit} lies on a Windows file system (${d}); keep the worker's checkout, state and toolchains in the Linux file system`,
        };
      }
      if (!paths.includes(d)) paths.push(d);
    }
    for (const entry of o.allowRead ?? []) {
      const drive = WINDOWS_DRIVE.exec(entry);
      const target = drive
        ? `${root}${(drive[1] as string).toLowerCase()}/${entry.slice(3).replace(/\\/g, '/')}`.replace(
            /\/+$/,
            '',
          )
        : posix.normalize(entry).replace(/\/+$/, '');
      if (!isAbsolute(target) || !defaults.some((d) => within(target, d))) {
        return {
          refused: `allow_read ${entry} does not lie on a Windows file system of this machine`,
        };
      }
      const denied = explicit.find((d) => within(target, d) || within(d, target));
      if (denied !== undefined) {
        return {
          refused: `allow_read ${entry} lies inside the denied ${denied}; the deny list wins`,
        };
      }
      if (!allowRead.includes(target)) allowRead.push(target);
    }
  } else if ((o.allowRead ?? []).length > 0) {
    return {
      refused: 'allow_read opens places on Windows file systems and only holds inside WSL2',
    };
  }
  // A wildcard over an IP address means nothing and would pass as neither a name nor an address.
  for (const entry of o.networkAllow) {
    const normal = normalizeHost(hostPort(entry).host);
    if ((normal?.wildcard === true && normal.ip !== 0) || wildcardOverIp(entry)) {
      return { refused: `network_allow entry ${entry} is a wildcard over an IP address` };
    }
  }
  const ports = [...new Set(o.deny.ports)].sort((a, b) => a - b);
  if (ports.length > 0) {
    for (const entry of o.networkAllow) {
      const { host, port } = hostPort(entry);
      const normal = normalizeHost(host);
      if (normal === undefined) {
        return { refused: `network_allow entry ${entry} cannot be read as a host` };
      }

      if (port !== undefined && ports.includes(port)) {
        return { refused: `network_allow entry ${entry} opens denied port ${port}` };
      }
      if ((ipLiteral(host) || localName(host)) && port === undefined) {
        return {
          refused: `network_allow entry ${entry} may reach this machine or its network on every port, and ports ${ports.join(', ')} are denied: name the port (${host}:443) or remove the entry`,
        };
      }
    }
  }
  return { paths, ports, allowRead, notes };
}

/** The union of the repository's and the machine's deny lists: neither can lift the other's. */
export function mergeDeny(...lists: (WorkerDeny | undefined)[]): WorkerDeny {
  const paths: string[] = [];
  const ports: number[] = [];
  for (const l of lists) {
    for (const p of l?.paths ?? []) if (!paths.includes(p)) paths.push(p);
    for (const p of l?.ports ?? []) if (!ports.includes(p)) ports.push(p);
  }
  return { paths, ports };
}

/** The literal and real spelling of `dir/name`, for the guard's globs. */
export const denyGlobs = (paths: readonly string[]): string[] =>
  paths.flatMap((p) => [p, join(p, '**')]);
