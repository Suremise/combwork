// What each CLI test home holds (HI-2606, its design s17 with Darren's answers): every entry its supported CLI version
// writes, classified. `keep` stays (the sign-in, the machine's setup, the CLI's own downloads, which add nothing to a
// session's context); `clear` is state a run leaves behind (memory, transcripts, trust, history, caches a session
// reads, the CLI's temp files), removed before each run (testHomes.mjs). The sign-in files are named apart and are never
// opened, copied or written by a reset.
//
// An entry not listed here is unclassified: kept where it is and named in the run's report (Darren, 7 Nov: point 4), so a
// new CLI version's new file is noticed and classified here. Names are exact; a trailing `*` is a prefix, a leading one a suffix.
// Checked against: Claude Code 2.1.319 and Codex 0.166.0 (the homes' listings, names only, in tests/fixtures/testHomes:
// tests/testHomes.test.ts fails for a name there this doesn't classify). A new version: record its listing there too.

/** The sign-in: never opened, copied, written or removed by a reset. */
export const SIGN_IN = {
  claude: ['.credentials.json'],
  codex: ['auth.json']
}

/**
 * Each home's entries (top level): kept or cleared. Claude Code's `.claude.json` and Codex's `config.toml` are kept and
 * rewritten to hold only `KEPT_FIELDS` (below).
 */
export const ENTRIES = {
  claude: {
    keep: ['.claude.json', 'settings.json'],
    clear: [
      '.claude.json.tmp.*', '.claude.json.backup*', '.claude.json.lock', '.oauth_refresh.lock*', '.last-cleanup', '.last-update-result.json', 'backups', 'cache',
      'file-history', 'history.jsonl', 'mcp-needs-auth-cache.json', 'plugins', 'projects', 'session-env', 'sessions', 'shell-snapshots',
      'skills', 'state', 'statsig', 'todos', 'ide', 'debug', 'downloads'
    ]
  },
  codex: {
    keep: ['config.toml', 'installation_id', '.sandbox', '.sandbox-bin', '.sandbox_migration', 'cap_sid', 'packages', 'version.json'],
    clear: [
      '.sqlite-maintenance.lock', 'app-server-control', 'app-server-daemon', 'auth.lock', 'cache', 'history.jsonl', 'log', 'models_cache.json',
      'plugins', 'session_index.jsonl', 'session_index.jsonl.lock', 'sessions', 'skills', 'thread-writer-locks', 'tmp',
      'tui-thread-reference-capabilities', 'config.toml.lock', 'config.toml.tmp*',
      'goals_1.sqlite', 'goals_1.sqlite-shm', 'goals_1.sqlite-wal',
      'logs_2.sqlite', 'logs_2.sqlite-shm', 'logs_2.sqlite-wal',
      'memories_1.sqlite', 'memories_1.sqlite-shm', 'memories_1.sqlite-wal',
      'queue_1.sqlite', 'queue_1.sqlite-shm', 'queue_1.sqlite-wal',
      'state_5.sqlite', 'state_5.sqlite-shm', 'state_5.sqlite-wal',
      'thread_history_1.sqlite', 'thread_history_1.sqlite-shm', 'thread_history_1.sqlite-wal'
    ]
  }
}

/**
 * What a kept settings file keeps: Claude Code's `.claude.json` fields that are the account and its onboarding (Darren's
 * yes to s11's point 2: runs start signed in and onboarded), Codex's `config.toml` tables that are the PC's sandbox and
 * the onboarding flags. Everything else in them (projects and their trust, MCP servers, skill use, tips, caches) goes.
 */
export const KEPT_FIELDS = {
  claude: [
    'oauthAccount', 'userID', 'machineID', 'firstStartTime', 'firstStartVersion', 'hasCompletedOnboarding', 'lastOnboardingVersion',
    'installMethod', 'autoUpdates', 'autoUpdatesProtectedForNative', 'migrationVersion', 'hasAvailableSubscription', '*MigrationComplete'
  ],
  codex: ['windows', 'tui']
}

/** Each CLI's name, for what a reset says. */
export const HOME_NAMES = { claude: 'Claude Code', codex: 'Codex' }

/** Whether a name matches one of the patterns (exact, a prefix ending in `*`, or a suffix after a leading `*`), case-insensitively. */
export function matches(name, patterns) {
  const n = name.toLowerCase()
  return patterns.some((p) => {
    const q = p.toLowerCase()
    if (q.endsWith('*')) return n.startsWith(q.slice(0, -1))
    if (q.startsWith('*')) return n.endsWith(q.slice(1))
    return n === q
  })
}

/** An entry's class in a CLI's home: `sign-in`, `keep`, `clear` or `unclassified`. */
export function classify(cli, name) {
  if (matches(name, SIGN_IN[cli])) return 'sign-in'
  if (name === '.reset-backup' || name === '.reset-in-progress') return 'keep'
  if (matches(name, ENTRIES[cli].keep)) return 'keep'
  if (matches(name, ENTRIES[cli].clear)) return 'clear'
  return 'unclassified'
}

/**
 * What a reset does with an unclassified entry (Darren, 7 Nov, point 4): kept where it is, never deleted, and named in
 * the run's report; the run carries on. The one place this is decided.
 */
export const UNCLASSIFIED = 'keep-and-report'
