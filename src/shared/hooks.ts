/**
 * An agent's hooks, as its Hooks dialog shows them (HI-982): what its launch loaded, each row saying how sure Hive is,
 * and what Hive observed of the hooks it received (its reply, and what the turn ledger made of each), kept in memory per
 * launch and bounded. Read-only: Hive never edits, enables or turns off a hook here.
 */

/** How many hooks a launch keeps for its dialog (the newest). */
export const HOOK_FIRED_MAX = 50
/** At most this many of a source's hooks are listed (the rest counted). */
export const HOOK_ROWS_MAX = 100
/** A hook's command is kept to this many characters (marked truncated past it). */
export const HOOK_TEXT_MAX = 4096
/** An event name, a reason or an error is kept to this many characters. */
export const HOOK_SHORT_MAX = 300

/**
 * Where a hook comes from: Hive's own (passed for this launch), the CLI's settings scopes (managed, the command line's,
 * the project's, its local file, the user's or a connection's home), or a plugin.
 */
export type HookSource = 'combwork' | 'managed' | 'cli' | 'project' | 'local' | 'user' | 'plugin' | 'other'

/**
 * How sure Hive is of a hook: `passed`, Hive passed it for this launch; `trusted`, `untrusted`, `modified`, as the CLI
 * itself lists it now (Codex's trust); `unverified`, configured but nothing says the CLI loaded it; `disabled`, a
 * setting turns it off; `notLoaded`, the launch's arguments leave its file out; `unsupported`, a form Hive doesn't know
 * (shown with its type); `unknown`, the CLI couldn't say.
 */
export type HookStatus = 'passed' | 'trusted' | 'untrusted' | 'modified' | 'unverified' | 'disabled' | 'notLoaded' | 'unsupported' | 'unknown'

export interface HookRow {
  event: string
  source: HookSource
  /** The file it is configured in, when it has one. */
  file?: string
  /** Its form as the CLI takes it (command, http, prompt…). */
  type: string
  /** Its command or URL, Hive's authentication left out, cut to HOOK_TEXT_MAX. */
  command: string
  truncated?: boolean
  matcher?: string
  status: HookStatus
  /** Why it has its status (the setting that disables it, the argument that leaves it out), when there is one. */
  why?: string
  /** Hive receives what it runs (one of Hive's hooks); a user's hook never is. */
  observed: boolean
}

/**
 * Something the listing says beside its rows: a file Hive couldn't read (never "no hooks"), one changed since the launch
 * read it, the CLI couldn't be asked, one source with more hooks than listed, or a CLI that may load hooks Hive doesn't read.
 */
export type HookNote =
  | { kind: 'unreadable'; file: string; why: string }
  | { kind: 'notJson'; file: string }
  | { kind: 'changed'; file: string }
  | { kind: 'cliUnknown'; why: string }
  | { kind: 'more'; source: HookSource; count: number }
  | { kind: 'othersUnread' }
  | { kind: 'unsure'; what: string; why: string }

/**
 * A launch's hooks: `basis` says where the rows other than Hive's come from: `cli`, the CLI's own listing, asked now with
 * the launch's settings (its session read its config when it started); `launch`, its settings files as read at launch.
 */
export interface HookListing {
  basis: 'cli' | 'launch'
  rows: HookRow[]
  notes: HookNote[]
}

/** Hive's reply to a hook it received: nothing, context, a lock decision (allowed, warned, asked, blocked), or an error. */
export type HookResponse = 'none' | 'context' | 'allowed' | 'warned' | 'asked' | 'blocked' | 'error'

/** What the turn ledger made of it: applied, carried on by Hive, ignored (with why), or not reached (an error first). */
export type HookLedger = 'applied' | 'continued' | 'ignored' | 'none'

/** A hook Hive received, as it observed it: never a claim about any other hook the CLI ran for that event. */
export interface HookFired {
  at: number
  /** The event as the CLI named it. */
  event: string
  /** Which of Hive's hooks it came through (its form), by the launch's authenticated route. */
  receiver: string
  response: HookResponse
  /** A block's reason, an error's step and message. */
  why?: string
  ledger: HookLedger
  ledgerWhy?: string
  /** How long Hive took to handle it (not how long any hook command took). */
  ms: number
}

/** An agent's hooks for its dialog: its launch (runId), what it loaded and what Hive received. */
export interface SessionHooks {
  runId: string
  provider: string
  listing: HookListing
  fired: HookFired[]
}

/** A run of fired hooks alike (same event, reply and ledger outcome), as the dialog groups them. */
export interface HookFiredGroup {
  first: HookFired
  last: HookFired
  count: number
}

/** Consecutive hooks alike, grouped (newest first, as given), so 34 ignored Stops read as one row. */
export function groupFired(fired: readonly HookFired[]): HookFiredGroup[] {
  const out: HookFiredGroup[] = []
  for (const f of fired) {
    const g = out.at(-1)
    if (g && g.last.event === f.event && g.last.response === f.response && g.last.ledger === f.ledger && g.last.why === f.why && g.last.ledgerWhy === f.ledgerWhy) {
      g.last = f
      g.count++
    } else out.push({ first: f, last: f, count: 1 })
  }
  return out
}

/** Text cut to `max` characters, saying whether it was. */
export function clip(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max ? { text: `${text.slice(0, max - 1)}…`, truncated: true } : { text, truncated: false }
}

/**
 * A command or URL with Hive's authentication material left out: a bearer token, the run id in Hive's hook URL and the
 * path of the launch's auth file (`secrets`: values to hide wherever they appear).
 */
export function withoutCombworkAuth(text: string, secrets: readonly string[] = []): string {
  let out = text
  // A path in either slash form (curl is given the auth file's path with forward slashes).
  for (const s of secrets) if (s && s.length >= 4) for (const form of new Set([s, s.replace(/\\/g, '/')])) out = out.split(form).join('…')
  return out.replace(/(Bearer\s+)(?!\$)[^\s"']+/gi, '$1…').replace(/([?&]run=)[^&\s"']+/g, '$1…')
}

/**
 * A lock block live now, as Activity shows it (HI-982): an agent's edit Hive's file lock blocked (or asked the user
 * about), while that decision stands. `key` is the block's identity: its launch, tool call, file and holder's launch.
 */
export interface ActivityHookBlock {
  key: string
  agentId: string
  /** The file, relative to the agent's folder. */
  file: string
  /** The agent holding the lock, when it is in the same project (else null: another project's). */
  holder: string | null
  kind: 'blocked' | 'asked'
  at: number
}
