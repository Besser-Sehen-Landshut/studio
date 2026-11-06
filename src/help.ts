// The one source of the CLI's help text: `studio help`, `studio --help`, `-h` and the usage line
// after a wrong call all print what is generated here. test/help.test.ts holds it to the dispatcher
// in src/cli.ts, to the options parseCli accepts and to the CLI table of the README.

/** One entry of the help: how it is called, and what it does (one or more lines). */
export interface HelpEntry {
  usage: string;
  about: string;
}

/** Options every command takes. */
export const GLOBAL_OPTIONS: HelpEntry[] = [
  { usage: '--project <dir>', about: 'The project folder (default: the current folder)' },
  { usage: '--json', about: 'Print JSON where a command supports it' },
  { usage: '-h, --help', about: 'Print this help (also: studio help)' },
];

export const COMMANDS: HelpEntry[] = [
  { usage: 'help', about: 'Print this help; studio --help and studio -h do the same' },
  {
    usage: 'init [--write]',
    about: 'Check the prerequisites and propose .studio/ for this project; --write writes it',
  },
  {
    usage:
      'add "<title>" --dod <line>... [--type fix|feature|chore|docs|research] [--repo <owner/name>] [--path <glob>]... [--component <id>] [--plan <file>] [--epic <id>] [--artifacts <dir>]',
    about:
      'Add a ready builder item; --artifacts <dir> files a research item for the researcher with its own analysis folder below a granted research_roots entry',
  },
  {
    usage: 'board [--component <id>] [--epic <id>]',
    about: 'Show the board, or the items of one component or epic',
  },
  {
    usage: 'epic add "<title>" --goal <text> --acceptance <line>... [--component <id>]...',
    about: 'Add an open epic with the next free id (E-<n>)',
  },
  { usage: 'epic list', about: 'Epics with their items by status and merged of total' },
  { usage: 'epic show <id>', about: 'One epic: goal, acceptance, items' },
  {
    usage:
      'epic edit <id> [--title <t>] [--goal <text>] [--acceptance <line>...] [--member <project>:<id>...]',
    about:
      "Replace an epic's title, goal, acceptance lines or (main project of a group only) its member items",
  },
  { usage: 'epic drop <id>', about: 'End an epic; refused while it has open items' },
  {
    usage: 'roadmap [--write] [--out <file>] [--force]',
    about: 'Render the roadmap from the board; --write writes ROADMAP.md',
  },
  {
    usage: 'roadmap import <file> [--write]',
    about: 'Turn "- [ ] Phase <n> — <title>" lines into epics (dry run without --write)',
  },
  { usage: 'plan', about: 'Dry-run the planner (JSON)' },
  { usage: 'launch <id>', about: 'Start a crew session for a planned item' },
  { usage: 'status', about: 'Crew sessions and their board status, items on workers included' },
  {
    usage: 'status --group <name>',
    about: 'Read only: one line per project of a group and every lead decision of the group',
  },
  {
    usage: 'worker --label <label> [--once]',
    about:
      'Serve offered items of this label on this machine: claim one, run its crew, open its pull request, hand the report back',
  },
  {
    usage: 'overview',
    about: 'Owner only, in a terminal: every project of this owner, read only',
  },
  { usage: 'collect <id>', about: 'Read a crew report and move the item' },
  {
    usage: 'tick [--dry-run]',
    about:
      'One lead heartbeat: collect, launch, queue and merge what is due (JSON); --dry-run prints what it would do (collect, launch, queue, contract checks, REA decisions) and changes nothing',
  },
  { usage: 'queue add <repo>#<pr>', about: 'Put a reviewed PR into the merge queue' },
  { usage: 'queue run', about: 'Merge the queued PRs, one at a time' },
  { usage: 'state', about: 'Refresh state.json in the state root' },
  { usage: 'pause', about: 'Owner only: nothing new starts or merges until resume' },
  { usage: 'resume', about: 'Owner only: lift the pause' },
  {
    usage: 'stop <id> [--release] [--requeue]',
    about:
      'Stop a crew session; --release closes the record of one it cannot verify, --requeue puts its item back to ready',
  },
  { usage: 'drop <id>', about: 'End an item; refuses while its crew runs' },
  {
    usage: 'link <id> <repo>#<pr>',
    about: 'Owner only, in a terminal: tie a pull request opened by hand to its item',
  },
  {
    usage: 'adopt --from <old state root> [--apply]',
    about:
      "Owner only, in a terminal: bring the history (metrics, costs, lessons, queue history, releases, ...) of an earlier state root of the same repository into this project's; a dry run without --apply; never copies clones, crew records, locks or run folders and never deletes the old root",
  },
  {
    usage: 'metrics',
    about: 'Lead time, deploy frequency, change failure rate, time to restore, costs',
  },
  { usage: 'deploy record [<sha>]', about: 'Record a production deploy' },
  { usage: 'incident open <id>', about: 'Record that a deploy broke something' },
  { usage: 'incident resolve <id>', about: 'Record that service is restored' },
  {
    usage: 'flaky record <test> <sha> pass|fail',
    about: 'Record a test that failed once, with its rerun',
  },
  { usage: 'flaky [list]', about: 'The flaky-test ledger, worst first' },
  { usage: 'solutions search <words>', about: 'Earlier solutions in .studio/solutions' },
  {
    usage: 'exceptions [list]',
    about: 'Exceptions by evidence: applied and not proven, with head and diff digest',
  },
  {
    usage: 'exceptions grant <repo>#<pr> <rule> --reason "<line>"',
    about:
      "The lead's decision for a guard hit no evidence explained, for this head; an owner_only rule or item takes the owner's, in a terminal",
  },
  {
    usage: 'release <component> [--dry-run] [--since <commit>]',
    about:
      "The release gate: draft the note and log the announcement; run it again to trigger the release workflow once approvals are in, then it follows the checks after the deploy. --since names production's commit, first release only; --dry-run prints the note and changes nothing",
  },
  { usage: 'release list', about: 'Releases with status, commit and what they wait for' },
  { usage: 'release show <id>', about: "A release's note" },
  {
    usage: 'release approve <id> <approver> --said "<words>" [--by "<who>"] [--at <time>]',
    about:
      "Record an approval: a third party's, relayed by the lead with who said it and when; the owner's (approver owner) only in a terminal",
  },
  {
    usage: 'release resolve <id> --deployed|--not-deployed --reason "<line>"',
    about: 'Settle a failed release whose deploy is unknown, after checking production',
  },
  { usage: 'release cancel <id> --reason "<line>"', about: 'Stop a release before its trigger' },
  {
    usage: 'lessons [list]',
    about: 'Lessons crews proposed for the role memory, with age, item and evidence',
  },
  { usage: 'lessons accept <n>', about: 'Move a proposed lesson into its role file' },
  {
    usage: 'lessons drop <n> [--reason <line>]',
    about: 'Discard a proposed lesson, with a one-line reason',
  },
  { usage: 'lessons prune <role> <line>', about: 'Remove a lesson line from a role file' },
  {
    usage: 'lessons review [--now]',
    about: 'Bundle pending proposals into one review item per role (weekly; tick runs it)',
  },
  {
    usage: 'recover [--dry-run]',
    about:
      'After a crash or reboot: stale locks, interrupted launches and merges, ended crews; prints what it found and did (--dry-run changes nothing)',
  },
  { usage: 'escalate <id>', about: "Run a stuck item on the role's stronger model" },
  { usage: 'sources list', about: 'Third-party sources and their licences' },
  {
    usage: 'sources check',
    about: 'Judge upstream updates: fits, unclear or conflict; adopts nothing',
  },
  { usage: 'sources apply <id>', about: 'Adopt a candidate that fits' },
  {
    usage: 'skills check [--now] [--security <name>]...',
    about:
      'Pinned plugins against their marketplaces and sources against upstream; one board item per update. Monthly (tick runs it); --now runs it at once, --security marks an update as security-relevant (priority 0)',
  },
  {
    usage: 'setup [--link] [--notifications]',
    about:
      "Owner only, in a terminal: gh, crew token, Claude account, studio on your terminal's PATH (--link), phone notifications and, optionally, REA for researcher crews; one guided step each, skipped when done; --notifications runs only that step again",
  },
  {
    usage: 'setup ci [--write]',
    about: 'Detect CI runners, propose the ci: block, lint workflows',
  },
  { usage: 'setup stack [--write]', about: "Detect the project's stacks from its manifest files" },
  {
    usage: 'setup sources [<id>...]',
    about: 'Fetch the referenced third-party sources (nothing runs)',
  },
  {
    usage: 'setup research',
    about:
      'Owner only, in a terminal: the optional REA step of studio setup on its own (install, analysis folder, default ~/analysis); idempotent',
  },
  {
    usage: 'secret set crew-token|worker-token',
    about: "Store the crew's (or a worker machine's) GitHub token (hidden input, checked first)",
  },
  {
    usage: 'doctor',
    about:
      'What is set and what is missing, never values; warns when .studio/board.yaml is tracked',
  },
  {
    usage: 'account add <label>',
    about: 'Owner only, in a terminal: store a token from claude setup-token',
  },
  { usage: 'account list', about: 'Stored Claude accounts and their state, never a token' },
  {
    usage: 'account use <label>',
    about: 'Owner only, in a terminal: make another account the active one',
  },
  { usage: 'account remove <label>', about: 'Owner only, in a terminal: remove a stored account' },
  {
    usage: 'account setup-plugins',
    about: 'Install the plugins crews need into the crew config dir',
  },
  {
    usage: 'accounts-clear <label>',
    about: "Owner only, in a terminal: clear a label's account block",
  },
  {
    usage: 'research allow <id> <class>...',
    about:
      'Owner only, in a terminal: open REA tool classes (annotate, debug, observe, device, export) for one researcher item, from its next launch',
  },
  {
    usage: 'research revoke <id> [<class>...]',
    about: 'Owner only, in a terminal: close them again (all without a class)',
  },
  { usage: 'research list', about: 'The REA classes the owner opened, per item' },
  {
    usage: 'research install [--yes] [--folder <dir>]',
    about:
      "Owner only, in a terminal: install the pinned rea-agents into the owner state, checked against the registry's integrity; --yes confirms without asking, --folder grants an analysis folder",
  },
];

const WIDTH = 100;
const COLUMN = 27;

/** Words of `text` in lines of at most `width - indent` characters, each line indented. */
function wrap(text: string, indent: number, first = indent): string[] {
  const lines: string[] = [];
  let line = '';
  let pad = first;
  for (const word of text.split(' ')) {
    if (line !== '' && pad + line.length + 1 + word.length > WIDTH) {
      lines.push(' '.repeat(pad) + line);
      line = word;
      pad = indent;
    } else line = line === '' ? word : `${line} ${word}`;
  }
  if (line !== '') lines.push(' '.repeat(pad) + line);
  return lines;
}

function entryLines(e: HelpEntry): string[] {
  const usage = wrap(e.usage, 4, 2);
  const last = usage.at(-1) as string;
  // A short call takes the text beside it; a long one puts the text below, in the column.
  if (usage.length === 1 && last.length < COLUMN - 1) {
    const about = wrap(e.about, COLUMN);
    return [`${last.padEnd(COLUMN)}${(about[0] as string).trimStart()}`, ...about.slice(1)];
  }
  return [...usage, ...wrap(e.about, COLUMN)];
}

/** The whole help text. */
export function helpText(): string {
  return [
    'Usage: studio [--project <dir>] [--json] <command>',
    '',
    'Options:',
    ...GLOBAL_OPTIONS.flatMap(entryLines),
    '',
    'Commands:',
    ...COMMANDS.flatMap(entryLines),
    '',
    'See README.md for every command in full.',
    '',
  ].join('\n');
}

export const USAGE = helpText();
