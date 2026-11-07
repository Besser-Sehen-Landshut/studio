// German: complete. Commands, codes and phrases to say to the lead stay English.
import { formatter } from '../i18n/format.js';
import { defineLocale, pick } from '../i18n/messages.js';

const f = formatter('de');
const n = f.number;

export default defineLocale({
  code: 'de',
  names: ['german', 'deutsch'],
  strings: {
    units: {
      s: (v) => `${n(v)}s`,
      m: (v) => `${n(v)}min`,
      h: (v) => `${n(v)}h`,
      d: (v) => `${n(v)}T`,
    },
    money: (usd) => f.usd(usd),
    hours: (h) => `${f.decimal(h, 1)} h`,

    missing: 'Noch kein Board. Die Steuerung schreibt es mit studio state.',
    unreadable: 'Das Board ist gerade nicht lesbar. Es aktualisiert sich von selbst.',
    paused: 'Pausiert.',
    status: (w, a, q, ci, y) =>
      `● ${n(w)} aktiv · ${n(a)} ${f.plural(a, { one: 'wartet', other: 'warten' })} · ${n(q)} in Warteschlange · CI ${ci} · zu entscheiden: ${n(y)}`,
    statusPaused: 'pausiert',
    forYou: (t) => `Zur Entscheidung: ${t}`,
    accountBlocked: (l, r) => `Konto gesperrt${l ? ` (${l})` : ''}: ${r}`,
    blockReason: (code) =>
      pick(
        {
          authentication_failed: 'Anmeldung fehlgeschlagen',
          organization_not_allowed: 'Organisation nicht zugelassen',
          organization_disabled: 'Organisation deaktiviert',
          account_on_hold: 'Konto angehalten',
          account_disabled: 'Konto deaktiviert',
          policy_violation: 'Nutzungsrichtlinie',
          state_unreadable: 'Sperrstand nicht lesbar',
        },
        code,
      ) ?? code,
    mainRed: (sha) => `Build auf main ist rot${sha ? ` (${sha})` : ''}`,
    crashed: (role, item) => `Abgestürzt: ${role} an ${item}`,
    more: (v) => `… ${n(v)} weitere`,
    crewState: {
      working: 'aktiv',
      waiting: 'wartet',
      blocked: 'blockiert',
      stopped: 'gestoppt',
      crashed: 'abgestürzt',
      done: 'fertig',
    },
    crossCutting: 'übergreifend',
    noComponent: 'ohne Komponente',
    noCrew: 'Keine Crew aktiv.',
    accepting: 'in Abnahme',
    reopened: 'wieder offen',
    epicDone: 'fertig',
    now: 'jetzt',
    next: 'danach',
    queueEmpty: 'Warteschlange ist leer.',
    queueStep: {
      update: 'Zweig wird aktualisiert',
      checks: 'Prüfungen laufen',
      capacity: 'wartet auf CI-Kapazität',
      merge: 'wird gemergt',
    },
    mergedTodayList: 'Heute gemergt',
    ciUnreadable: 'CI nicht lesbar, gilt als belegt',
    mergeRule: (m, t, over) =>
      `Merge-Regel: höchstens ${n(m)}/${n(t)} belegt${over ? ', derzeit darüber' : ''}`,
    headEpics: 'Vorhaben',
    headCrew: 'Crew',
    headQueue: 'Merge-Warteschlange',
    headForYou: (v) => `Zur Entscheidung (${n(v)})`,
    headForLead: (v) => `Für die Steuerung (${n(v)})`,
    headExceptions: (v) => `Ausnahmen per Beweis (${n(v)})`,
    headReleases: (v) => `Releases (${n(v)})`,
    releaseStatus: (s, p) =>
      pick(
        {
          announced: 'angekündigt, bereit zum Auslösen',
          approvals: `wartet auf Freigabe: ${p.join(', ')}`,
          triggered: 'wird ausgeliefert',
          checking: 'ausgeliefert, Prüfungen laufen',
          done: 'fertig',
          failed: 'angehalten: eine Prüfung ist rot',
          stopped: 'abgebrochen',
        },
        s,
      ) ?? s,
    exceptionBy: (by) => (by === 'evidence' ? 'Beweis' : by === 'owner' ? 'Inhaber' : 'Steuerung'),
    leadTimeLine: (m, d) => `Durchlaufzeit (Median) ${m} · Deploys heute ${n(d)}`,
    headDays: 'Letzte 7 Tage (gemergt/ausgeliefert)',
    headUsage: 'Nutzung (Läufe)',
    lastUpdate: (m) => `Letzte Aktualisierung vor ${n(m)} min.`,
    updated: (m) => (m < 1 ? 'gerade aktualisiert' : `vor ${n(m)} min`),
    stale: '! Stand alt',
    pausedTag: '◷ pausiert',
    decisions: (v) =>
      `! ${n(v)} ${f.plural(v, { one: 'Entscheidung', other: 'Entscheidungen' })} nötig`,
    running: (v) => `● ${n(v)} ${f.plural(v, { one: 'läuft', other: 'laufen' })}`,
    waiting: (v) => `◷ ${n(v)} ${f.plural(v, { one: 'wartet', other: 'warten' })}`,
    today: (v) => `✓ ${n(v)} heute fertig`,
    decisionHead: 'Entscheidung nötig',
    say: (p) => `→ sagen: „${p}“`,
    word: {
      decision: 'entscheiden',
      blocked: 'blockiert',
      running: 'läuft',
      waiting: 'wartet',
      ready: 'bereit',
    },
    stage: {
      ready: 'bereit',
      building: 'baut',
      pr_held: 'PR zurückgehalten',
      review: 'Review',
      queued: 'Warteschlange',
      blocked: 'blockiert',
    },
    done: (v) => `✓ ${n(v)} fertig`,
    doneToday: (v) => `✓ ${n(v)} heute fertig`,
    withoutEpic: 'Ohne Vorhaben',
    leadTime: (h) => `Ø Durchlauf ${h}`,
    costToday: (cost) => `heute ${cost}`,
    decision: (code) =>
      pick(
        {
          fix_limit: 'Fix-Limit erreicht – entscheiden',
          changes_requested: 'Änderungen angefordert',
          merge_failed: 'Merge fehlgeschlagen',
          question: 'Crew hat eine Frage',
          evidence: 'Prüfungstreffer ohne Beweis – entscheiden',
          blocked: 'blockiert',
          release_approval: 'Release-Freigabe nötig',
          release_failed: 'Release angehalten: eine Prüfung ist rot',
          analyzer_timeout: 'Prüfer-Zeit abgelaufen – entscheiden',
          rea_install: 'REA-Installation – einmal hier bestätigen',
        },
        code,
      ) ?? 'Entscheidung nötig',
    reason: ({ code, params: p = {} }) => {
      switch (code) {
        case 'paused':
          return 'pausiert: nichts startet, nichts wird gemergt bis studio resume';
        case 'usage_full':
          return 'Nutzungslimit: jede Crew-Anmeldung ist an ihrem Limit';
        case 'usage_parked':
          return `Nutzungslimit: keine Crew-Anmeldung frei; frühestens wieder ${p.reset ?? 'unbekannt'}`;
        case 'usage_label':
          return `Nutzungslimit bei ${p.label} bis ${p.reset}; darauf startet nichts`;
        case 'limits_unreadable':
          return 'limits.json ist nicht lesbar: keine Crew startet';
        case 'usage_unreadable':
          return 'usage.json ist nicht lesbar: keine Crew startet';
        case 'provider_failed':
          return 'der Anmeldungs-Lieferant ist fehlgeschlagen: keine Crew startet';
        case 'provider_empty':
          return 'der Anmeldungs-Lieferant gab nichts zurück: keine Crew startet';
        case 'credential_limit':
          return 'Anmeldungs-Limit erreicht';
        case 'account_block':
          return `Konto gesperrt (${p.labels}): keine Crew startet bis studio accounts-clear`;
        case 'account_block_unreadable':
          return 'Sperrstand nicht lesbar (blocks.json): keine Crew startet';
        case 'crew_records_unreadable':
          return 'Crew-Einträge sind nicht lesbar: keine Crew startet';
        case 'legacy_state':
          return 'alte Stand-Dateien noch nicht übernommen: kein Merge';
        case 'busy':
          return 'ein anderer Studio-Prozess arbeitet: nächster Durchlauf';
        case 'ci_pending':
          return 'CI läuft noch';
        case 'next_tick':
          return 'Pull Request gerade geöffnet: nächster Durchlauf';
        case 'waiting_on':
          return `wartet auf ${p.items}`;
        case 'role_wip':
          return 'WIP-Limit der Rolle voll';
        case 'component_wip':
          return `WIP-Limit der Komponente ${p.component} voll`;
        case 'overlaps':
          return `überschneidet sich mit ${p.item}`;
        case 'host_load':
          return 'Rechnerlast: ein Build-Start nach dem anderen';
        case 'lead_work':
          return 'Arbeit der Steuerung: Rückblick auf die Lektionen';
        case 'ci_capacity':
          return 'CI-Kapazität';
        case 'worker_offered':
          return `angeboten an ${p.label} (#${p.offer}), noch nicht übernommen`;
        case 'worker_awaits':
          return `Commit von ${p.worker} wartet auf seinen Kommentar`;
        case 'worker_expired':
          return `Übernahme durch ${p.worker} abgelaufen (seit ${p.minutes} min kein Lebenszeichen)`;
        case 'worker_on':
          return `auf ${p.worker} (${p.label}), Lebenszeichen vor ${p.minutes} min`;
        case 'worker_none':
          return `kein Arbeiter für ${p.label} zugelassen`;
        case 'relay_on':
          return `auf Relay ${p.label}, Crew läuft`;
        case 'relay_starting':
          return `auf Relay ${p.label}, Crew startet`;
        case 'relay_unreachable':
          return `Relay ${p.label} seit ${p.minutes} min nicht erreichbar`;
        case 'relay_held':
          return `Relay ${p.label}: jetzt nicht`;
        default:
          return undefined;
      }
    },
    wait: (w, why) => {
      switch (w.code) {
        case 'ci_capacity':
          return w.busy !== undefined && w.total !== undefined && w.max !== undefined
            ? `Läufer ${n(w.busy)}/${n(w.total)} belegt, Merge ab ≤${n(w.max)}`
            : `CI-Kapazität: ${why}`;
        case 'checks_pending':
          return 'Prüfungen laufen';
        case 'review_pending':
          return 'Review noch nicht begonnen';
        case 'queue_held':
          return `Warteschlange angehalten: ${why}`;
        case 'queue_position':
          return w.position === undefined ? why : `Platz ${n(w.position)} in der Warteschlange`;
        case 'updating':
          return 'Zweig wird aktualisiert';
        case 'merging':
          return 'wird gemergt';
        case 'held':
          return `zurückgestellt: ${why}`;
        case 'worker':
          return `Arbeiter: ${why}`;
        default:
          return why;
      }
    },
    waitShort: (w) => {
      switch (w.code) {
        case 'ci_capacity':
          return w.busy !== undefined && w.total !== undefined
            ? `CI ${n(w.busy)}/${n(w.total)}`
            : 'CI';
        case 'worker':
          return 'Arbeiter';
        case 'checks_pending':
          return 'Prüfung';
        case 'review_pending':
          return 'offen';
        case 'queue_position':
          return w.position === undefined ? 'wartet' : `Platz ${n(w.position)}`;
        case 'updating':
          return 'Update';
        case 'merging':
          return 'Merge';
        default:
          return 'zurückgest.';
      }
    },
    column: {
      ready: 'BEREIT',
      building: 'BAUT',
      review: 'REVIEW',
      queue: 'QUEUE',
      today: 'HEUTE',
    },
    full: '⚠ voll',
    blocked: 'BLOCKIERT',
    emptyTitle: 'Noch keine Aufgabe.',
    emptyHint: 'In eigenen Worten beschreiben, was gebaut werden soll, z. B.:',
    emptyExample: '„Neue Aufgabe für die API: … Fertig, wenn ein Test … belegt.“',
    pausedSince: (t) =>
      `${t === undefined ? 'Pausiert.' : `Pausiert seit ${t}.`} Nichts startet, nichts wird gemergt; laufende Crews arbeiten zu Ende.`,
    staleBanner: (m) => `Letzte Aktualisierung vor ${n(m)} min.`,
    staleQuestion: 'Läuft die Steuerung noch?',
    staleSay: 'start the Studio lead loop',
    groupTitle: (name) => `Verbund ${name}`,
    groupMain: 'Haupt',
    groupHere: 'hier',
    groupNone:
      'Dieses Projekt gehört zu keinem Verbund. Verbünde stehen in der Inhaber-Konfiguration.',
    groupIdle: 'nichts offen',
    groupProblem: (p) =>
      pick(
        {
          'no state yet': 'noch kein Stand',
          'state unreadable': 'Stand nicht lesbar',
          'folder cannot be read': 'Ordner nicht lesbar',
        },
        p,
      ) ?? 'nicht lesbar',
    groupBack: (name) => `Verbund ${name} · zurück: /studio group`,
    groupOpen: 'Projekt öffnen: /studio group <Projekt>',
    reaConfirm: (v, withFolder) =>
      `REA-Installation bestätigen (rea-agents ${v}${withFolder ? ', Ordner ~/analysis' : ''})`,

    paneTitle: 'Studio-Board',
    commandDescription: 'Das Studio-Board zeigen: Arbeitsliste, Pipeline oder Details',
    usage: (commands) => `Aufruf: /studio [${commands}]`,
    notInProject: 'Kein Studio-Projekt.',
    openFailed: 'Das Board ließ sich hier nicht öffnen.',
    opened: 'Studio-Board geöffnet.',
    pauseNeedsTerminal: (command) => `Pausieren braucht ein Terminal: ${command} ausführen`,
    resumeNeedsTerminal: (command) => `Fortsetzen braucht ein Terminal: ${command} ausführen`,
    viewReply: {
      list: 'Studio-Board: Arbeitsliste.',
      pipeline: 'Studio-Board: Pipeline (bei schmalem Bereich die Arbeitsliste).',
      more: 'Studio-Board: Details. Zurück mit /studio list.',
      group: 'Studio-Board: der Verbund, eine Zeile je Projekt.',
    },
    focusReply: (id) => `Studio-Board: die Arbeitsliste von ${id}. Zurück mit /studio group.`,
    noProjectReply: (id) => `Kein Projekt ${id} in diesem Verbund. Siehe /studio group.`,
    languageSet: 'Studio-Board: Deutsch.',
    offReply:
      'Studio-Board in dieser Sitzung aus: kein Bereich, keine Statuszeile, keine Hinweise. Zurück mit /studio on.',
    onReply: 'Studio-Board in dieser Sitzung wieder an.',
    offPane: 'Studio-Board ist in dieser Sitzung aus. → /studio on',
    reaConfirmed: 'REA-Installation bestätigt. Sie läuft beim nächsten Start, der sie braucht.',
    reaNotConfirmed:
      'Die REA-Bestätigung ließ sich nicht speichern; studio research install im eigenen Terminal ausführen.',

    setup: {
      step: (k, name, status) => `${k}. ${name}: ${status}`,
      stepOpen: (k, name) => `${k}. ${name}:`,
      done: (d) => `erledigt (${d})`,
      fix: (what) => `   Behebung: ${what}`,
      dryRun: 'Probelauf: nichts wird geschrieben, gespeichert oder geändert.',
      would: (what) => `   würde: ${what}`,
      next: (what) => `Fertig. Als Nächstes: ${what}`,

      machine: 'Dieser Rechner',
      windowsWhy:
        'die Steuerung läuft nicht unter Windows selbst (Claude Code hat dort keine Sandbox)',
      windowsFix:
        'in PowerShell als Administrator: wsl --install -d Ubuntu-24.04, den PC neu starten, Ubuntu öffnen und dort studio setup ausführen (README, "Lead on a Windows PC (WSL2)")',
      wsl1Why:
        'das ist WSL1 (oder eine WSL, deren Version sich nicht bestimmen lässt); die Steuerung braucht WSL2',
      wsl1Fix: (d) =>
        `in PowerShell: wsl --set-version ${d} 2, dann neu öffnen und studio setup ausführen`,
      otherWhy: 'diese Plattform wird nicht unterstützt',
      otherFix: 'die Steuerung unter macOS, Linux oder WSL2 betreiben',
      missing: (label, list) => `${label}; es fehlt: ${list}`,
      nodeOld: (min, have) => `Node.js ${min} (vorhanden: ${have})`,
      sandboxTools: 'bubblewrap und socat (die Sandbox von Claude Code)',
      tool: (name, command) => `   ${name}: ${command}`,
      newTerminal: '   Danach ein neues Terminal öffnen und studio setup erneut ausführen.',
      onWindowsDrive: (label, folder, dir) =>
        `${label}; Studios ${folder === 'config' ? 'Konfigurations' : 'Zustands'}ordner ${dir} liegt auf einem Windows-Laufwerk, das keine Dateirechte kennt (Tokens und Schlüssel dort wären offen)`,
      onWindowsDriveFix:
        '   Behebung: XDG_CONFIG_HOME und XDG_STATE_HOME entfernen oder unter ~ im Linux-Dateisystem setzen, dann studio setup erneut ausführen.',
      machineDone: (label, node) => `erledigt (${label}, git, Node.js ${node}, claude)`,
      projectOnWindows: (p) =>
        `   Hinweis: das Projekt ${p} liegt auf einem Windows-Laufwerk; für Tempo und genaue Dateirechte ins Linux-Dateisystem (unter ~) klonen.`,
      sshLater: (command) => `   Für Relay-Worker später: ssh und ssh-keygen (${command}).`,

      gh: 'GitHub CLI',
      ghFix: (fix) => `   Behebung: ${fix}, dann studio setup erneut ausführen.`,
      ghInstall: (command) => `${command}, dann gh auth login`,

      token: 'Crew-Token',
      unusable: 'die gespeicherte Datei ist nicht verwendbar',
      missingWord: 'fehlt',
      tokenText: [
        '   Crews pushen ihre Branches und öffnen Pull Requests mit einem eigenen GitHub-Token, nie',
        '   mit deinem gh-Login. Lege auf GitHub ein fine-grained Token an (Settings, Developer settings,',
        '   Personal access tokens), beschränkt auf die Repositories dieses Projekts, mit',
        '   contents und pull requests read/write und sonst nichts (keine administration, keine workflows).',
        '   Studio prüft es einmal gegen das Repository und speichert es mit Modus 0600; es wird nie angezeigt.',
        '   Das Token kommt nur in die verdeckte Eingabe.',
      ],
      noRepo:
        '   Hier ist kein GitHub-Repository zu finden. Die nächste Eingabe ist sichtbar; das Token kommt danach.',
      repoPrompt: '   Repository, an dem die Crews arbeiten, als owner/name (sichtbar): ',
      repoLooksLikeToken:
        '   das sieht nach einem Token aus — nicht gespeichert; bitte owner/name eingeben',
      repoNotOwnerName: '   das ist kein owner/name; nichts gespeichert',
      tokenNothing:
        '   Nichts gespeichert. Token auf GitHub korrigieren, dann studio setup erneut ausführen.',

      account: 'Claude-Konto für Crews',
      accountWrong: '   studio account list und studio doctor zeigen, was nicht stimmt.',
      noneStored: 'keins gespeichert',
      accountText: (def) => [
        '   Crews betreiben Claude Code mit einem eigenen Token, dein eigener Login bleibt deiner. In einem',
        '   anderen Terminal-Tab ausführen: claude setup-token',
        '   Es gibt ein Token aus, das ein Jahr gilt (es braucht einen Pro-, Max-, Ultra-, Team- oder Enterprise-Plan).',
        `   Zuerst tippst du ein kurzes Kürzel für dieses Konto (sichtbar; Enter behält ${def}).`,
        '   Dann fügst du das Token in der zweiten Eingabe ein (verdeckt).',
      ],
      labelPrompt: (def) =>
        `   Kurzes Kürzel für dieses Konto, sichtbar (Enter behält ${def}) [${def}]: `,
      labelLooksLikeToken:
        '   das sieht nach einem Token aus — nicht gespeichert; bitte ein kurzes Kürzel eingeben',
      labelBad:
        '   ein Kürzel hat Buchstaben, Ziffern, Punkt, Bindestrich oder Unterstrich und beginnt nicht mit einem Punkt; nichts gespeichert',

      terminal: 'studio in deinem Terminal',
      noPlugin: 'der Ort des Plugins ist nicht bestimmbar; nichts geschrieben',
      localBinOff: '~/.local/bin steht nicht im PATH.',
      localBinHelp: [
        '   Studio ändert keine Shell-Dateien. ~/.local/bin in der Startdatei deiner Shell zum PATH',
        '   hinzufügen, ein neues Terminal öffnen und studio setup --link erneut ausführen.',
      ],
      untilThen: (command) => `   Bis dahin: ${command}`,
      shimNote:
        '   Der Shim findet das Plugin nach einem Update wieder; --link ist kein zweites Mal nötig.',
      notAShim: (target) => `${target} ist kein Studio-Shim; nichts geändert.`,
      notAShimHelp: '   Wegräumen und studio setup --link erneut ausführen, oder behalten.',
      writePrompt: (target) => `   Studio-Shim ${target} schreiben? [J/n] `,
      updatePrompt: (target) => `   Studio-Shim ${target} aktualisieren? [J/n] `,
      nothingWritten: (command) => `   nichts geschrieben; bis dahin: ${command}`,
      wrote: (target) => `   ${target} geschrieben`,
      notOnPath: 'nicht im PATH (Claude Code findet es selbst).',
      linkHint: '   Für studio in jedem Terminal: studio setup --link',
      untilParen: (command) => `   (bis dahin: ${command})`,

      notifications: 'Benachrichtigungen',
      notifyConfigBad: [
        'die Owner-Konfiguration ist nicht lesbar; mit studio doctor beheben, dann',
        '   studio setup --notifications ausführen. Nichts gespeichert.',
      ],
      notifyState: (state, transport) =>
        state === 'bad'
          ? 'die gespeicherte Datei ist nicht verwendbar'
          : state === 'ok'
            ? `eingerichtet (${transport}), neu einrichten`
            : 'keine',
      notifyText: [
        '   Studio kann dir eine Zeile aufs Telefon schicken, wenn eine Entscheidung ansteht: eine feste',
        '   Phrase, die Item-ID und den Projektnamen, sonst nichts. Dafür dient ntfy, ohne Konto: Studio',
        '   legt ein geheimes Topic an, du abonnierst es in der ntfy-App.',
      ],
      notifyPrompt: '   ntfy oder none? [ntfy/none] (Enter: ntfy): ',
      notifyNone: (unchanged) =>
        `   ${unchanged ? 'unverändert' : 'keine Benachrichtigungen'}; später: studio setup --notifications`,
      notifyAnswer: '   bitte ntfy oder none antworten; nichts gespeichert',
      noHttps: '   kein HTTPS-Client in diesem Prozess; nichts gespeichert',
      notifyOpen: '   Installiere die ntfy-App und öffne diesen Link:',
      notifySecret:
        '   Der Link ist das Geheimnis: wer ihn hat, liest deine Pushes. Studio zeigt ihn nur hier.',
      notifyReady: '   Enter drücken, sobald abonniert (skip bricht ab): ',
      notifyLater: '   nichts gespeichert; später: studio setup --notifications',
      notifyFailed: (why) => `   Test-Push fehlgeschlagen: ${why}; nichts gespeichert`,
      notifySent: '   Test-Push gesendet; schau aufs Telefon. Topic gespeichert.',

      research: 'Reverse Engineering',
      researchOptional: 'Reverse Engineering (optional)',
      researchConfigBad:
        'die Owner-Konfiguration ist nicht lesbar; mit studio doctor beheben. Nichts geändert.',
      researchDone: (version, mode, roots) => `erledigt (rea-agents ${version}, ${mode}, ${roots})`,
      trustMode: 'Vertrauensmodus',
      strictMode: 'strenger Modus',
      researchSkipped: 'übersprungen; studio setup research richtet es ein',
      notSetUp: 'nicht eingerichtet',
      researchText: [
        '   Eine Researcher-Crew kann ausgelieferte Programme mit REA (rea-agents) untersuchen. Studio',
        '   installiert es einmal in seinen eigenen Zustand, geprüft gegen die npm-Registry, und gibt ihm',
        '   einen Analyseordner. REA-Werkzeuge laufen mit deinen Rechten außerhalb der Sandbox. Überspringe',
        '   es, wenn du es nie brauchst: Studio fragt wieder, wenn ein Researcher-Item es braucht.',
      ],
      researchPrompt: '   Jetzt einrichten? [j/N] ',
      researchLater: '   übersprungen; später: studio setup research',
      researchInstalled: (version, mode, now) =>
        `   erledigt (rea-agents ${version}, ${mode}${now ? ', jetzt installiert' : ''})`,

      finalNext: 'Fertig. Jetzt das Projekt in Claude Code öffnen und /studio:init ausführen.',

      pairPc:
        'Auf dem Windows-PC, in einer PowerShell als Administrator (am PC oder per Remotedesktop, nie per SSH), innerhalb einer Stunde:',
      pairWhat: (version) =>
        `Sie installiert Node.js und Git, falls sie fehlen (sie fragt vorher), Studio ${version} und den Relay-Worker.`,
      pairHasStudio: (command) => `Ist Studio dort schon installiert: ${command}`,
      pairThen: (command) => `Danach hier: ${command}`,
      pairSecret: 'Die Zeile enthält ein Einmal-Geheimnis: nur auf dem Worker einfügen.',
      paired: (label, where, studio, platform, fp) =>
        `gekoppelt: ${label} ist ${where}, Studio ${studio} auf ${platform}, Host-Schlüssel festgelegt (${fp}).`,
      installWebClient:
        'Studio relay install: stoppt und deaktiviert den Dienst WebClient (WebDAV), den die Crew-Sandbox nicht hält.',
      installStopped:
        'studio: relay install angehalten; beheben, was es sagt, und erneut ausführen (es repariert)',
      hostKey: (fp) => `Fingerabdruck des Host-Schlüssels: ${fp}`,
      hostKeyUnknown: 'Host-Schlüssel: der Schlüssel des OpenSSH-Servers ist nicht lesbar',
      installNext: (label) =>
        `Fertig. Als Nächstes, auf der Steuerung innerhalb einer Stunde: studio relay pair ${label} --connect`,
      uninstallNoRecord:
        'Kein Installationsprotokoll (Installation einer früheren Version): Dienste, die Studio gestoppt hat, bleiben, wie sie sind.',
      uninstallStopped:
        'studio: relay uninstall angehalten; beheben, was es sagt, und studio relay uninstall erneut ausführen (es macht dort weiter)',
      uninstallNext: (leads) =>
        leads.length === 0
          ? 'Fertig. Als Nächstes: auf der Steuerung diesen Worker aus workers.relay der Owner-Konfiguration entfernen.'
          : `Fertig. Als Nächstes: auf jeder Steuerung ${leads.map((l) => `workers.relay.${l}`).join(', ')} aus der Owner-Konfiguration entfernen.`,
      accountStored: (label, active) => `Konto ${label} gespeichert${active ? ' und aktiv' : ''}`,
      accountNext:
        'Fertig. Als Nächstes: studio doctor zeigt das Konto; studio setup erledigt die übrigen Schritte.',
    },

    push: {
      fix_limit: 'Fix-Limit erreicht',
      changes_requested: 'Änderungen angefordert',
      merge_failed: 'Merge fehlgeschlagen',
      merged: 'Gemergt',
      question: 'Crew hat eine Frage',
      evidence: 'Prüfungstreffer, der Inhaber entscheidet',
      blocked: 'Blockiert',
      account_block: 'Konto gesperrt',
      release_approval: 'Release-Freigabe nötig',
      release_failed: 'Release angehalten, eine Prüfung ist rot',
      release_announced: 'Release angekündigt, nach dem Auslösen nicht umkehrbar',
      analyzer_timeout: 'Prüfer-Zeit abgelaufen',
      rea_install: 'REA-Installation braucht eine Bestätigung',
      other: 'Entscheidung nötig',
    },
    pushOne: (phrase, item, project) => `${phrase}: ${item} in ${project}`,
    pushMany: (v, project, blocked) =>
      `${n(v)} ${f.plural(v, { one: 'Entscheidung', other: 'Entscheidungen' })} nötig in ${project}${blocked ? ': Konto gesperrt' : ''}`,
    pushTest: 'Test: Studio erreicht dich hier',
  },
});
