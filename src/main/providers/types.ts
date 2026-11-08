import type { AgentInstallInfo, AutoCompactSetting, BackgroundTaskType, CatalogModel, EffortLevel, LaunchedLimits, LaunchedPicker, McpServerDef, MemorySource, PathDataCopy, PermissionMode, PlanUsage, ProviderId, ProviderUpdateRetry, ReadinessIssue, RetryWait, ServerModel, SessionUsage, SubSession, TranscriptImageRef, TranscriptItem } from '../../shared/types'
import type { ProviderDescriptor } from '../../shared/providers'
import type { StartHint } from '../../shared/startFailure'
import type { SafeguardEvent } from '../../shared/safeguards'
import type { Text } from '../../shared/advanced'
import type { TypedNewline } from '../../shared/terminalInput'
import type { HookListing } from '../../shared/hooks'

export interface LaunchSkill {
  name: string
  sourcePath: string
  /**
   * The source's content hash as the launch's settings read it (HI-2268: revisions.ts's, hashed again only when its
   * files' sizes or times changed), so agents launched in a row hash an unchanged skill once. Absent (or empty: it
   * couldn't be read then), the adapter hashes the source itself.
   */
  revision?: string
}

/**
 * What a launch gave the session of a skill it asked for: the content hash of the copy the CLI reads (null when there
 * is no copy of Combwork's), and why it isn't the skill as asked for, if it isn't. `lasting`: a restart won't change that
 * (a folder of the user's has its name), as opposed to an old copy kept because it was in use.
 */
export interface SkillDelivery {
  revision: string | null
  problem?: string
  lasting?: true
}

/** A launch's hooks for its Hooks dialog (HI-982: ProviderAdapter.launchHooks). */
export interface LaunchHooks {
  /** As established at launch. */
  listing: HookListing
  /** Listed again for the dialog (the CLI's own listing asked now, or its files compared with the launch's); absent: `listing`. */
  now?(): Promise<HookListing>
  /** Combwork's own hook for each event (its form: http, command), by the event's name: what a hook it received came through. */
  receivers: Readonly<Record<string, string>>
}

export interface LaunchContext {
  projectPath: string
  /** Which of the project's agents is launching; each gets its own launch folder. */
  agentId: string
  /** The provider's CLI, as found (providerService). */
  executable: string
  /** Its version, as it reported it (null when it didn't), for arguments only some versions take. */
  cliVersion?: string | null
  /** Folder the agent works in: the project folder or its worktree. */
  cwd: string
  workspacePath: string
  /** Combwork's id for this launch; hooks carry it (see hookUrl). */
  runId: string
  /** The session to start (providers with fixed ids) or resume; empty for a new session of a provider that picks its own id. */
  sessionId: string
  resume: boolean
  name: string
  skills: LaunchSkill[]
  mcpServers: Record<string, McpServerDef>
  model: string | null
  effort: EffortLevel | null
  permissionMode: PermissionMode | null
  extraArgs: string[]
  /** Hook endpoint for this launch, with its run id (…/hook?run=<runId>). */
  hookUrl: string
  /**
   * The file holding this launch's hook Authorization header, for hook commands (`curl -H @<file>`): in Combwork's user
   * data, never the project, so no generated file holds the token (#345). HTTP hooks read `CW_HOOK_TOKEN` instead.
   */
  hookAuthFile: string
  /**
   * The launch's private folder, in Combwork's user data and removed when it ends (#345): for generated files that may hold
   * a secret (Claude Code's settings and MCP config, with the user's and the workspace's servers' own values), which
   * must never be written to the project.
   */
  privateDir: string
  /** Combwork's guidance for the agent (the combwork MCP server's instructions), for providers that don't show MCP instructions themselves. */
  guidance: string
  /** More instructions for this launch, over the provider's own (the Combwork Assistant's role and mode). */
  instructions?: string
  /**
   * The Workspace notes note as this launch delivers it (#1433: its part for the project, bounded, under its header), on
   * every provider after Combwork's guidance and the launch's instructions; empty or missing: none (switched off, no note).
   */
  notes?: string
  /**
   * A resume of a conversation Combwork gave instructions of its own at an earlier launch, by any agent (SessionRecord.promptAdded,
   * #1433): its prompt is rendered fresh, so instructions given then and not now leave it.
   */
  promptAddedBefore?: boolean
  /**
   * The provider's override switches (#1167) as read once for this launch (overridesNow), so prepareLaunch and
   * buildCommand agree when one changes meanwhile; read with launchOverrides. Missing: each read as it is now.
   */
  overrides?: Readonly<Record<string, boolean>>
  /** Tools of the combwork MCP server this launch may use without asking, for providers that can pre-approve tools. */
  trustedCombworkTools?: string[]
  /** The first task, given on the command line so the CLI starts on it (e.g. from the Combwork Assistant). */
  initialPrompt?: string
  env: Record<string, string>
  /**
   * Its own folder in Agents' temp folder (HI-2496), made, and already TEMP, TMP and TMPDIR in `env`; null or missing: the
   * system Temp. A CLI with a temp variable of its own (Claude Code's CLAUDE_CODE_TMPDIR) sets it in its adapter.
   */
  tempDir?: string | null
  /** The connection's folder this launch runs on (HI-1757: its homeEnv's value in `env`), absent when it runs on the CLI's own home. */
  connectionHome?: string
  /** A server connection's models as they run now and its name (HI-2682: a local model's limits), absent off one. */
  server?: { models: ServerModel[]; connection: string }
  /** What the adapter applied of them (HI-2682), set by prepareLaunch: the launch keeps it for the context meter. */
  localLimits?: LaunchedLimits | null
  /** The /model lineup the adapter asked for on a server connection (HI-2684), set by prepareLaunch: kept on the session. */
  picker?: LaunchedPicker
  /** The user lets sessions move into the CLI's own background service (see capabilities.backgroundSessions). */
  allowBackgroundSessions: boolean
  /** A 200K context window instead of the model's 1M one (capabilities.contextLimit). */
  use200kContext: boolean
  /**
   * Combwork's record of the skill copies it made in folders (#1431, skillCopies.ts), for CLIs that read copies in the folder
   * (syncAgentsSkills). Missing: nothing is recorded, and no copy is removed but by its marker and content (tests).
   */
  copies?: SkillCopyBook
  /**
   * Whether another session of Combwork's (not this launch's) runs or is starting in `cwd` (#1431): it may be reading Combwork's
   * skill copies there, so the copies of skills this launch no longer gets stay while one does.
   */
  othersHere?: () => boolean
  /**
   * Folders outside `cwd` the session may read and write (#1439, capabilities.extraDirs): a reviewer's grant of its
   * project's review copies, one fixed folder. Given on the command line, never in the CLI's config; none when missing.
   */
  extraDirs?: string[]
}

/** One skill copy Combwork recorded making in a folder (#1431): its revision is the copy's contentHash, its marker left out. */
export interface SkillCopyRecord {
  skill: string
  project: string
  revision: string
}

/**
 * Combwork's record of its skill copies (#1431, the `skill_copies` table): what it made in a folder, at which revision. A
 * failure to read or write it never stops a launch: unrecorded copies are only kept, never removed.
 */
export interface SkillCopyBook {
  /** The folder's recorded copies, by skill name in lower case. */
  of(folder: string): Promise<Map<string, SkillCopyRecord>>
  record(folder: string, project: string, skill: string, revision: string): Promise<void>
  forget(folder: string, skill: string): Promise<void>
}

export interface UpdateRetry {
  command: CommandSpec
  notice: ProviderUpdateRetry
}

/** A home folder's sign-in, as its CLI reports it (HI-980): `ok: false` when it couldn't be told, `error` in English. */
export type ConnectionStatus = { ok: true; loggedIn: boolean; email?: string; orgId?: string; plan?: string | null; loginExpiresAt?: string } | { ok: false; error: string }

/**
 * A workspace folder a connection's CLI must trust (HI-1870), as the CLIs look trust up (probed with Claude Code 2.1.311
 * and Codex 0.164.0): `root` is the real path of a Git project's main repository root (the parent of its common git
 * folder, which covers the project, its slots and copies, all worktrees of it), or of a project without Git; null when
 * Combwork couldn't resolve it. `short`: Combwork launches it by an 8.3 path, which Claude Code doesn't expand.
 */
export interface TrustTarget {
  root: string | null
  git: boolean
  short: boolean
  /** The project's own folder, real path (a linked worktree's own, when the project is one): Codex looks it up first. */
  folder?: string | null
}

/**
 * A CLI's trust of one target (HI-1871): trusted, not (asked at its root), unknown (null), or not and asked at another
 * folder (`at`: Codex's own entry for the project's folder, which it looks up before the main root, says no).
 */
export type TrustReading = boolean | null | { at: string }

export interface CommandSpec {
  file: string
  args: string[]
  /**
   * The command line to start it with instead of `args`, passed on as it is (a .cmd/.bat through cmd.exe, HI-2722:
   * toSpawnable, whose `args` then say what it runs). Whatever starts the command uses it when it is there.
   */
  line?: string
  env?: Record<string, string>
  /** The folder a setup task runs in (HI-2547: agy's first-run setup, in Combwork's check profile); absent: the user's home. */
  cwd?: string
  /** Typed into the program once its interface is ready (e.g. Codex's /permissions menu for its sandbox setup). */
  keys?: KeySteps
  /** What its screen shows once the program is ready for `keys` (matched against the screen its output draws: KeyGate). */
  readyPattern?: RegExp
  /**
   * A window title (set by the program's OSC 0/2 sequences) that means it is busy: `keys` wait until it has been
   * idle for a moment, since a busy CLI queues what is typed instead of acting on it (Codex: "tab to queue message").
   */
  busyTitle?: RegExp
  /**
   * Whether its screen (rendered, a line per row) shows it busy and holding what was typed (Codex: "tab to queue
   * message" under its input, #363): `keys` wait while it does, as for busyTitle. The title can say so later.
   */
  busyScreen?: (screen: string) => boolean
  /** True once the task has done its job, for a program that stays open afterwards (Codex after its sandbox setup): Combwork then closes it. */
  done?: () => boolean
}

/**
 * Keys typed into a CLI's own interface (a menu, a slash command), with pauses between them. A step is keys as they
 * are, or a pick: it reads the CLI's screen as rendered and returns what to type, null until the screen shows it, for
 * a menu whose order the CLI can change (Codex's /permissions, #396); `what` names what it looks for, for the error
 * when it never shows (main/keySteps.ts). A step that submits (Enter) can say how the screen shows it wasn't taken:
 * `heldOn` is true while the CLI still holds what it submits, unrun (Codex's input still holding the command, #363).
 */
export type KeyStep = { keys: string; waitMs?: number; heldOn?: (screen: string) => boolean } | { pick: (screen: string) => string | null; what: string; waitMs?: number }
export type KeySteps = KeyStep[]

export interface ExternalSession {
  id: string
  transcriptPath: string
  modified: string
  /** The transcript's size and time, from the stat that found it (HI-1681): the list needn't stat it again. */
  bytes?: number
  mtimeMs?: number
  /** A session the CLI started for another one (from the transcript's first line). */
  sub?: SubSession
}

/** Something the CLI asks the user, from its hooks. */
export interface Ask {
  /** A permission request (in a reviewed mode the CLI's own reviewer answers it), or a question. */
  kind: 'permission' | 'question'
  /** The agent stops until it is answered; otherwise it carries on, and the answer comes later as a prompt. */
  blocking: boolean
  /** What it asks, for the status and the notification ('' when the CLI doesn't say). */
  message: string
  /** When `message` is Combwork's own words (a safeguard prompt, #606), not the CLI's: as the window shows them (#847). */
  text?: Text
  /** The tool call it is about (ToolEnd's `call`), when the CLI says: that call ending answers it. */
  call?: string
  /**
   * Read from the CLI's screen (its question by itself, HI-1959), not reported: it is there to see, so it is put to the
   * person at once, even for a CLI whose terminal title otherwise says when one must act (HI-2609: Codex's offer of a
   * cheaper model, which may not title its terminal).
   */
  onScreen?: true
}

/** A provider's hook call, turned into what Combwork tracks. */
export type HookEvent =
  | { kind: 'start'; source: string | null }
  /**
   * A prompt the CLI took: `text`, what it says (when the CLI reports it), for telling who sent what (#418).
   * `injected`: one Combwork put into the running turn itself (the turn ledger knows it, #648): not a new prompt.
   * `cli`: one the CLI started by itself (Claude Code's task-notification wake, HI-2410): a turn, never the user's words.
   */
  | { kind: 'prompt'; text?: string | null; injected?: true; cli?: true }
  /** `resumes`: the tool starts a turn Combwork took as over, or one it saw no prompt for (the turn ledger says, #648). */
  | { kind: 'toolStart'; resumes?: true }
  /** `call`: which tool call ended, when the CLI says (see Ask.call). */
  | { kind: 'toolEnd'; call?: string }
  /** The CLI asks the user something (whether a person is asked now is the status rules' call: see hookStatus). */
  | { kind: 'ask'; ask: Ask }
  /**
   * The turn ended. `failed`: on an error (a rate limit, the server; not the sign-in), which ends it as Stop does but
   * is no request that worked: it says nothing of the CLI's sign-in.
   */
  | { kind: 'stop'; lastMessage: string | null; failed?: true }
  /** The turn ended because the CLI's sign-in was refused (expired, revoked, an invalid key): `message` is the CLI's. */
  | { kind: 'signIn'; message: string | null }
  /**
   * The CLI's model request failed and it tries again by itself (HI-1973: Copilot's recoverable ErrorOccurred): the turn
   * goes on. `status`: the HTTP status that refused it (429: rate-limited), when the CLI names one; `network`: the
   * service couldn't be reached at all.
   */
  | { kind: 'retry'; status: number | null; network: boolean }
  | { kind: 'interrupt' }
  /**
   * The CLI says it is idle at its prompt, waiting for input, with nothing running (Claude Code's idle_prompt
   * notification, a minute after a turn): no turn is in flight, whatever Combwork last saw (#612).
   */
  | { kind: 'idle' }
  | { kind: 'compactStart'; trigger: string }
  | { kind: 'compactEnd' }
  | { kind: 'end' }
  | { kind: 'ignore' }

export interface NormalizedHook {
  event: HookEvent
  /** The provider's session id, when the hook names one. */
  sessionId: string | null
  /** Where the provider writes the transcript, when the hook says. */
  transcriptPath: string | null
  /** The permission mode the hook reports, when it reliably reflects the live mode. */
  mode: PermissionMode | null
  /** The reply for a PreToolUse-style hook that edits files: the files it will change (absolute or relative to cwd). */
  editedPaths: string[]
  /** Which turn and call the hook is about, as the CLI names them (#648: the turn ledger). */
  ids: HookIds
}

/**
 * A hook's own ids (#648), each null when the CLI doesn't send it: `turn` the CLI's turn (Claude Code's prompt_id, Codex's
 * turn_id), `call` the tool call (tool_use_id), `sub` the sub-agent that sent it (Claude Code's agent_id), and `continued`
 * that this Stop comes after the turn was carried on past an earlier Stop (stop_hook_active).
 */
export interface HookIds {
  turn: string | null
  call: string | null
  sub: string | null
  continued: boolean
}

/** Details about a running session a provider reports outside hooks (Claude's status line, Codex's rollout). */
export interface LiveDetails {
  modelName?: string
  /** The model's id as the CLI reports it (to learn its default effort, observedDefaultEffort). */
  modelId?: string
  /**
   * When the CLI recorded modelId (its record's time), where its records carry one (Codex's rollout): a record from before
   * this launch (a resumed conversation's earlier turns) is never taken for a model switch (HI-2609). Absent: live.
   */
  modelAt?: string
  effort?: string
  costUsd?: number
  permissionMode?: PermissionMode
  planMode?: boolean
  planUsage?: PlanUsage | null
  /** The model's context window in tokens. */
  contextWindow?: number
  /** A turn ended because the CLI's sign-in was refused (Codex's rollout): the CLI's message (see HookEvent signIn). */
  signIn?: string
  /** When the CLI recorded that turn's end (ISO), when it says: one from before this launch (a resumed log) is history. */
  signInAt?: string
  /**
   * A turn ended on an error that isn't a refused sign-in, as the CLI recorded it (#1632, Codex's rollout: its Stop hook
   * says nothing of it): the CLI's message ('' for none), and when (ISO). A turn after it clears it; one from before
   * this launch is history.
   */
  turnFailed?: string
  turnFailedAt?: string
  /** The turn it names (its id as the CLI's hooks name turns), when the record names one. */
  turnFailedTurn?: string
  /**
   * When a turn last ended on an interrupt the CLI sends no hook for (Copilot's `abort`, also when a person cancels its
   * permission dialog), as recorded (ISO): handled as an interrupt hook. One from before this launch is history.
   */
  interruptedAt?: string
  /**
   * When a compaction last completed, as recorded (ISO), on a CLI that sends no hook at its end (Copilot's
   * session.compaction_complete, #454): handled as a compaction's end hook. One from before this launch is history.
   */
  compactedAt?: string
  /**
   * The CLI's own record says its latest turn is over, with nothing started since (Codex's task_complete, #648): `turn`
   * its id as the hooks name turns, `at` when (ISO). Null: a turn began after the last one ended; absent: the lines read
   * say neither.
   */
  turnEnded?: { turn: string; at: string } | null
  /**
   * For CLIs whose records don't name turns as their hooks do (Copilot): when each of its Stop hooks was answered, as it
   * recorded them (its agentStop hook.end), in the lines read (ISO). Combwork compares them with the Stops it got (#648).
   */
  stopsAnswered?: string[]
}

export type { BackgroundTaskType } from '../../shared/types'

/**
 * A background task an agent started (a command left running, a Monitor, a subagent) or that ended, from its transcript.
 * `at` is when the line was written (ms); a task with `expiresAt` ends then if nothing says so sooner. A start may say
 * what it is (`type`; left out, a command) and its CLI's description of it (a subagent's: user text). `resumed`: a
 * task that ended starts again under its id (a subagent given a message after it finished).
 */
/** `stopped`: an end the agent made itself (Claude Code's TaskStop, #640): its CLI isn't told, so no turn follows. */
export type BackgroundTaskEvent = { kind: 'start'; id: string; at: number; expiresAt?: number; type?: BackgroundTaskType; description?: string; resumed?: true } | { kind: 'end'; id: string; at: number; stopped?: true }

/** A turn as the transcript identifies it (#1371): its id, when its prompt was written (Unix ms), whether the model took it up. */
export interface TranscriptTurn {
  id: string
  at: number
  worked: boolean
  /** With no turn ids in its hooks: its prompt's text as compared with a prompt hook's (hooksHealth's promptKey). */
  prompt?: string
}

/** Where an image's data sits in a transcript: the line's byte range and the path to it inside the entry. */
export interface ImageLocation {
  offset: number
  length: number
  path: (number | string)[]
}

/** Incremental transcript → usage parser: feed it whole lines as the transcript grows, read the usage so far. */
export interface UsageParser {
  feed(text: string): void
  result(): SessionUsage
}

/** Incremental transcript → conversation parser (transcripts are append-only). */
export interface ConversationParserLike {
  readonly items: TranscriptItem[]
  readonly images: ImageLocation[]
  /** Bytes consumed, always at a line boundary. */
  offset: number
  feed(buf: Buffer): number
  /**
   * Its CLI may write the transcript again in place, not only append (HI-2546: agy): the reader checks the bytes it read are
   * unchanged whenever the file changes, and reads it again from the start when they aren't.
   */
  readonly rewritten?: boolean
}

/** The answer to a PreToolUse file-lock check, in the provider's hook reply format. */
export type LockDecision = { kind: 'deny' | 'ask'; reason: string } | { kind: 'warn'; context: string }

export interface SkillRoots {
  /** User-level skills the CLI always loads (e.g. ~/.claude/skills). */
  machine: string[]
  /** Installed plugins, whose skills the CLI loads. */
  plugins: string | null
  /**
   * Folders inside a project the CLI loads skills from (e.g. .claude/skills), the one Combwork creates a project's skills in
   * first; [] for none. Copilot reads several (.github/skills, .agents/skills and .claude/skills).
   */
  local: string[]
  /** Combwork's own copies inside `local`, which aren't the project's skills (folder name prefix). */
  combworkCopyPrefix: string | null
}

/**
 * Everything Combwork needs from a coding-agent CLI. One adapter per provider, registered in
 * providers/index.ts; the rest of Combwork never checks which provider it is talking to.
 */
export interface ProviderAdapter {
  readonly id: ProviderId
  readonly descriptor: ProviderDescriptor

  // Installation
  locate(): Promise<AgentInstallInfo>
  /**
   * The newest version the installer of `executable` (the one found) can deliver, which updateCommand installs: its own
   * source's, never one it can't get yet (HI-2729). Null when it can't say.
   */
  latestVersion(executable?: string | null): Promise<string | null>
  isNewer(latest: string, current: string): boolean
  installCommand(): CommandSpec
  updateCommand(executable: string): CommandSpec
  /** A known update failure's explanation and explicit retry, if this installer supports one. */
  updateRetry?(executable: string, exitCode: number): UpdateRetry | null
  /**
   * What this CLI keeps for one agent of Combwork's (Antigravity's private profile, HI-2731), sent to the Recycle Bin once
   * the agent is removed, so it is never left behind nor reused. CLIs whose homes are a connection's have none.
   */
  agentRemoved?(agentId: string, workspacePath: string): Promise<void>
  /** An update's exit code that means its installer had nothing newer (HI-2729: WinGet's 0x8A15002B): it ended well. */
  updateUpToDate?(executable: string, exitCode: number): boolean
  loginCommand(executable: string): CommandSpec
  /**
   * Who a home folder is signed in as (HI-980: an account's folder, given in `env` under the descriptor's
   * `capabilities.connections.homeEnv`), from the CLI's own status: never a token. `ok: false` when it couldn't be told
   * (a timeout, output it couldn't read), which isn't signed out.
   */
  accountStatus?(executable: string, env: NodeJS.ProcessEnv): Promise<ConnectionStatus>
  /**
   * Whether a connection's folder (`home`) has had the CLI's one-time first-run setup that Set Up answers (HI-1870), as
   * the CLI's own files there say, read only; null when it can't be told. Absent: the CLI has none to tell.
   */
  connectionSetUp?(home: string): Promise<boolean | null>
  /** The arguments the CLI takes in a connection's Set Up on its folder (`home`), as its launches there do (HI-1893). Absent: none. */
  connectionSetUpArgs?(home: string): string[]
  /**
   * Whether the CLI on a connection's folder (`home`) trusts each of a workspace's folders (HI-1870), as its own files
   * there say, read only: true, false (not trusted, or no record), or null when it can't be told (a file it can't
   * read, a folder Combwork couldn't resolve). Absent: the CLI keeps no trust to tell.
   */
  connectionTrusts?(home: string, targets: readonly TrustTarget[]): Promise<TrustReading[]>
  /** Where a shared folder of an account (capabilities.connections.shared) links to: that folder of the CLI's own home. */
  accountSharedTarget?(name: string): string
  /** Whether a file in an account's folder is one that changes when the CLI signs in or out there: watched, never read. */
  accountLoginFile?(name: string): boolean
  /**
   * The key Combwork presses for a line break in a prompt it types (HI-1327), for the CLI at `version`: one of the
   * descriptor's `typedNewlines`, as Settings → Advanced chooses it; null: a space (as before). Absent: always a space.
   */
  typedNewline?(version: string | null): TypedNewline | null
  /** A connection's sign-in, when it differs from loginCommand (HI-1757: Codex keeps the login in the connection's folder). */
  accountLoginCommand?(executable: string): CommandSpec
  /**
   * Environment variables the CLI reads as a login (HI-1757: Codex's CODEX_ACCESS_TOKEN), left out wherever it runs on a
   * connection (its sign-in, its checks, its sessions: withoutAccountEnv), so they can't stand in for the connection's own.
   */
  accountEnvDrop?(): readonly string[]
  /** The same by a pattern on the variable's name (HI-1772: Claude Code reads whole families: ANTHROPIC_*, CLAUDE_CODE_USE_*). */
  accountEnvDropPattern?(): RegExp
  /**
   * Whether a connection's folder (its home) is held by the CLI's own check of it, not yet confirmed ended (HI-1757:
   * Codex's app server): its sign-in and removal are refused meanwhile, as while a launch holds it.
   */
  accountHeld?(home: string): boolean
  /** A one-time setup task (Codex's Windows sandbox), when the provider has one. */
  setupCommand?(executable: string): CommandSpec
  /** The CLI's own home (its sign-in and config) as Combwork's sessions get it: what a test copy notes beside the CLI (#368). */
  configHome?(): string
  /** What still keeps agents from running, given what locate() found. */
  readiness(info: AgentInstallInfo): ReadinessIssue[]
  /**
   * Advanced settings (ids) that change what locate() finds (#1281: the environment its sign-in is checked in): a change
   * of one checks the CLI again, so the account shown is the one its sessions get.
   */
  readonly locateSettings?: readonly string[]
  /** Extra lines for Help → Copy Diagnostics (Codex: its Windows sandbox), with no paths or names in them. */
  diagnostics?(): string[]
  /** The CLI's own default model from its settings, if set. */
  /** The CLI's own default model from its settings; `home`: a connection's home (HI-1755) rather than the CLI's own. */
  configuredDefaultModel(home?: string): string | null
  /** Whether a model seen in a transcript is this provider's (to learn the CLI's default). */
  ownsModel(model: string): boolean
  /** Environment variables to remove from sessions: a parent session's identity when Combwork runs inside one. */
  readonly envToStrip: string[]

  // Launch
  /** Prepares the launch (skills, MCP, hooks) and says what it delivered of each skill in ctx.skills, by name. */
  prepareLaunch(ctx: LaunchContext): Promise<Record<string, SkillDelivery>>
  /** Where this launch's CLI reads a delivered Combwork skill (its copy), for measuring what the session got. */
  skillCopyPath(ctx: LaunchContext, skill: string): string
  buildCommand(executable: string, ctx: LaunchContext): CommandSpec
  /** Something the user should know about this launch (a mode the CLI can't fully give there), shown once per agent while Combwork runs. */
  launchNotice?(ctx: LaunchContext): { title: string; message: string } | null
  /** Something in a folder agents work in (any provider's) that stops this CLI working there (#509: a stray .codex), or null. */
  folderWarning?(folder: string): { title: string; message: string } | null

  // Hooks and live details
  normalizeHook(body: Record<string, any>): NormalizedHook
  /**
   * For CLIs whose terminal title says when a person must act (Codex's "Action Required"): a test of a title, for
   * this version of the CLI, and the launch (its override switches: a title Combwork didn't set isn't read). Null (or
   * absent) when its title doesn't say: its hooks then tell Combwork (see hookStatus).
   */
  titleAttention?(version: string | null, ctx?: Pick<LaunchContext, 'overrides'>): ((title: string) => boolean) | null
  lockReply(decision: LockDecision): Record<string, unknown>
  /**
   * The reply that puts Combwork's fixed notice text before the model at this hook (#650: the CLI's own event name, as the
   * hook sent it), in the CLI's format: a checkpoint after a tool call (PostToolUse), or carrying the turn on at its Stop
   * (the drain; stopContinues says it does). Null for an event that can't carry one on this CLI, or one not verified to.
   */
  noticeReply(event: string, text: string): Record<string, unknown> | null
  /**
   * The reply to a session's start hook that puts context before the model (#1032: the Assistant's state view, at a
   * start, a resume and after a compaction). Absent where it isn't verified: such a CLI's sessions get no view.
   */
  startContextReply?(text: string): Record<string, unknown>
  /**
   * Where the start context goes after a compaction, on a CLI that starts no session then (#1065): 'prompt' puts it in
   * the reply to the next prompt hook (startContextReply's form), once. Absent: its SessionStart after a compaction
   * carries it, as for a start.
   */
  readonly startContextAfterCompaction?: 'prompt'
  /**
   * Whether the turn a drain carries on comes back to Combwork as a new prompt hook, with the notice as its prompt (Copilot):
   * the turn ledger then takes it as Combwork's own in the running turn, not a new one.
   */
  readonly drainIsPrompt?: boolean
  /** Whether Combwork's reply to a Stop hook makes the CLI carry the turn on (a block, or context it acts on, #648). */
  stopContinues(reply: Record<string, any>): boolean
  /**
   * For CLIs whose screen shows for sure whether a turn runs (#648, the turn ledger's last check before "state unknown"):
   * a reading of the rendered screen, for this version of the CLI: 'idle' at its prompt, 'working' on a turn, or null when
   * it doesn't show for sure. Null (or absent) for versions it wasn't checked with.
   */
  turnScreen?(version: string | null): ((screen: string) => 'idle' | 'working' | null) | null
  /**
   * Whether the CLI is waiting to retry its model request (HI-1972: rate-limited, its connection lost), from its own
   * records: its newest such wait in conversation `sessionId` recorded since `since` (ms), or null (none, or Combwork can't
   * tell). `env` is the launch's environment (where its CLI keeps its records), `transcriptPath` its transcript where
   * known. Read off main's thread and bounded in time; never changes anything of the CLI's. Absent: Combwork can't tell.
   */
  retryWait?(q: { sessionId: string; env: NodeJS.ProcessEnv; transcriptPath?: string; since: number }): Promise<RetryWait | null>
  /** How long a running turn goes without a hook before retryWait is asked (ms); absent: 20 s. */
  retryLookAfterMs?(): number
  /** Claude Code's status-line JSON. */
  statusLine?(body: Record<string, any>): LiveDetails
  /**
   * The conversation a status line names, for a CLI that can't be given one up front (HI-2544: the Antigravity CLI):
   * a valid id, or null. Combwork takes it for the launch while it has none, and never in place of a known one.
   */
  statusLineSession?(body: Record<string, any>): string | null
  /**
   * A permission prompt the CLI's status line says it shows, for a CLI that sends no hook for one (HI-2545: the Antigravity
   * CLI's `tool_confirmation_pending`): the blocking ask, or null when none is pending. Combwork applies it as a hook's ask,
   * in order with the launch's hooks, once when it begins (Combwork never answers it: the person does, in the CLI).
   */
  statusLineAsk?(body: Record<string, any>): Ask | null
  /**
   * Reads, before the hook is normalized, what it needs from the CLI's own records (HI-2545: the Antigravity CLI's user
   * prompt, from its transcript, as its hooks carry none), adding it to `body`. Called in the launch's hook order, off
   * main's thread for its reads and bounded in time; `launch` says whose hook it is (only that agent's own records are
   * read). Absent: the hook is normalized as it came.
   */
  prepareHook?(body: Record<string, any>, launch: { agentId: string; workspacePath: string; sessionId: string | null; memo: Record<string, unknown>; alive: () => boolean }): Promise<void>
  /**
   * The raw events whose reply can carry a notice whatever they normalize to (HI-2545: the Antigravity CLI's PreInvocation
   * and Stop, whose meaning prepareHook decides): their reply is decided in the launch's order (noticeIn), always settled.
   */
  readonly noticeEvents?: readonly string[]
  /** Whether this prepared hook may carry a notice (absent: as the turn ledger says); `memo` the launch's. */
  noticeWanted?(body: Record<string, any>, memo: Record<string, unknown>): boolean
  /** A notice was put in this hook's reply (it won't carry another at its place). */
  noticeGiven?(body: Record<string, any>, memo: Record<string, unknown>): void
  /** How long the CLI waits for this event's reply: a notice decided later never reached it, so isn't given. Absent: no limit. */
  noticeDeadlineMs?(event: string): number | null
  /** The reply to a PreToolUse Combwork doesn't refuse, for a CLI that takes no answer as a denial (HI-2545: agy's `allow`). */
  preToolUseDefault?(): Record<string, unknown>
  /**
   * Whether the status line says the CLI is idle, for a CLI that sends no hook when its turn ends some ways (HI-2545: a
   * cancelled permission prompt in the Antigravity CLI): a running turn with no end heard within idleGraceMs is interrupted.
   */
  statusLineIdle?(body: Record<string, any>): boolean
  idleGraceMs?(): number
  /**
   * How a launch's CLI will compact by itself, read from its command, environment and the CLI's settings files (never
   * changed), for the model it runs as (`models`: the id it resolves to, then the choice). Absent: Combwork doesn't know.
   */
  autoCompact?(ctx: LaunchContext, cmd: CommandSpec, models: string[]): AutoCompactSetting
  /**
   * Where the CLI's settings files turn its hooks off for a launch (#1336: why its hooks don't reach Combwork), read now and
   * never changed: the settings' name in the window's language, or null when none does (or Combwork can't tell).
   */
  hooksOffIn?(ctx: LaunchContext): string | null
  /**
   * The launch's hooks for its Hooks dialog (HI-982), once its command is built: Combwork's own as passed for it, and the CLI's
   * others as far as this provider can establish them. Read-only, never changing a hook or a CLI's config. Absent: the
   * dialog lists none.
   */
  launchHooks?(ctx: LaunchContext, cmd: CommandSpec): LaunchHooks
  /**
   * Details from lines appended to the session's transcript (Codex: model, preset, Plan mode, plan limits). `memo` is
   * the launch's own, kept between reads (and emptied when the reading starts again), for what a later line completes.
   */
  transcriptDetails?(appended: string, memo: Record<string, unknown>): LiveDetails
  /**
   * Background tasks started or ended in lines appended to the session's transcript (whole lines). `memo` is the
   * launch's own, kept between reads (and emptied when the reading starts again), for what a later line completes.
   */
  backgroundTasks?(appended: string, memo: Record<string, unknown>): BackgroundTaskEvent[]
  /**
   * Safeguard stops, and model changes after one (#606), in lines appended to the session's transcript (whole lines).
   * `memo` is the launch's own, kept between reads (and emptied when the reading starts again). Absent: Combwork can't
   * detect them for this CLI (descriptor.safeguardHelp is null).
   */
  safeguards?(appended: string, memo: Record<string, unknown>): SafeguardEvent[]
  /**
   * Turns the session's transcript identifies in lines appended to it (whole lines; #1371, hooks health): each by the
   * id its hooks carry for it (`turnsJoin: 'id'`), or by the transcript's own id when its hooks carry none (`'time'`),
   * with when its prompt was written and whether the model took it up. Only turns a person's (or Combwork's) prompt began,
   * never a sub-agent's, a compaction or a local command. `memo` is kept between reads of one file (emptied when the
   * reading starts again); a turn whose prompt wasn't read (before the reading began, or in a gap) isn't returned.
   */
  transcriptTurns?(appended: string, memo: Record<string, unknown>): TranscriptTurn[]
  /** How transcriptTurns' ids meet its hooks: the same id ('id'), or only by when its hooks came ('time'). */
  turnsJoin?: 'id' | 'time'
  /**
   * Whether an ask is the CLI's prompt about a safeguard stop (Claude Code asks whether to switch models), from the ask
   * and the terminal's screen as it shows it.
   */
  safeguardAsk?(ask: Ask, screen: string): boolean
  /**
   * The question a CLI puts on its screen by itself while idle, sending no hook (HI-1959: Claude Code's offer to teach
   * auto mode about the environment), from the screen as shown; null when none shows. The agent waits for the user
   * while it does, and nothing is typed into it: the question takes the keys, and Enter answers it.
   */
  idleQuestion?(screen: string): string | null
  /**
   * What the CLI's ordinary input holds, from the screen with dim cells blanked (TerminalScreen.textWithoutDim: a hint in
   * an empty input is dim): '' when empty, null when no ordinary input is drawn (a dialog, a redraw, a blank screen).
   */
  promptText?(screen: string): string | null
  /**
   * What promptText reads, as drawn: its rows and their spacing kept (HI-1979: a Ctrl+U that deletes an empty row, a
   * line break's, changes this and not promptText's words). Null where promptText is.
   */
  promptBox?(screen: string): string | null
  /**
   * The installed CLI's models and what each can do (#125), when it can say (null: couldn't, or an unexpected reply).
   * Asking may start the CLI briefly, but never a session, a prompt or a sign-in. env: the sessions' environment.
   */
  listModels?(executable: string, env: Record<string, string>): Promise<CatalogRead | null>
  /** The effort the CLI's own settings choose for every model, if any (Codex's model_reasoning_effort). */
  configuredDefaultEffort?(): string | null
  /** For liveModeSwitch 'menu': the keys that pick a mode in the CLI's menu. */
  modeMenuKeys?(target: PermissionMode): KeySteps
  /** The mode the CLI says it switched to, from its terminal output after a menu switch (null: not said yet). */
  modeFromOutput?(tail: string): PermissionMode | null
  /**
   * Whether the CLI's screen shows its own question about the mode just picked (Codex's warning before Full Access,
   * #1014): the user answers it in the terminal, and a menu switch waits for that answer.
   */
  modeConfirmScreen?(screen: string): boolean
  /**
   * With modeConfirmScreen, how long the CLI has after the pick to show its question (when no transcript can confirm the
   * switch) and how long the switch waits for the user's answer, in milliseconds: advanced settings, as a CLI changes.
   */
  modeConfirmWait?(): { appearMs: number; answerMs: number }
  /** Whether the CLI's screen shows it busy holding what was typed (as CommandSpec.busyScreen): a menu switch waits while it does. */
  busyScreen?(screen: string): boolean
  /** For providers with a Plan toggle: the key that turns it on or off. */
  readonly planToggleKey?: string
  /**
   * The permission mode shown in the terminal footer, from the terminal's rendered screen (its lines as text), and the
   * mode the session was launched in (for modes whose footers look the same).
   */
  footerMode?(screen: string, launched?: PermissionMode | null): PermissionMode | null
  /** Whether a running session can switch to a mode without restarting. */
  canSwitchLive(target: PermissionMode, current: PermissionMode | undefined, launched: PermissionMode | null | undefined): boolean
  /** Terminal output meaning a compaction Combwork started was refused or failed (no hook comes). */
  readonly compactFailure: RegExp | null
  /**
   * Terminal output meaning the CLI is waiting for a prompt, for CLIs whose first hook only comes with the
   * first prompt (Codex creates its thread lazily): until then Combwork shows the agent as ready from this.
   */
  readonly readyOutput?: RegExp

  // Transcripts
  transcriptPath(folder: string, sessionId: string, recorded?: string): Promise<string | null>
  /** Where to put a transcript restored from Combwork's backup so the CLI can resume it; null if it can't be restored. */
  restorePath(folder: string, sessionId: string, recorded?: string): string | null
  /**
   * The CLI's sessions run in a folder. `skip`: ids the caller has already (Combwork's own sessions), left out before their
   * files are looked at (HI-1681): a session list asks for every folder its sessions ran in, mostly Combwork's own.
   */
  listSessions(folder: string, skip?: (id: string) => boolean): Promise<ExternalSession[]>
  /**
   * Whether a transcript (one of the CLI's, or Combwork's copy of it) is a sub-session, from its first line; cached by mtime.
   * `mtimeMs`: the file's, from a stat the caller has (HI-1681), so it isn't stat'd again.
   */
  subSessionOf(path: string, sessionId: string, mtimeMs?: number): Promise<SubSession | null>
  /**
   * What the CLI keeps by a folder's path rather than in it (Claude Code: ~/.claude/projects/<path as name>/, its
   * transcripts and auto memory), for a folder that moved (#146). With apply, copied to the new path's name: never moved
   * or deleted, and a file already there with other content is kept. One copy per folder the CLI keeps `from`'s data in
   * (Claude Code may have several, #493); none when it has nothing for `from`. Providers that keep sessions by id (Codex)
   * have none.
   */
  copyPathData?(from: string, to: string, apply: boolean): Promise<PathDataCopy[]>
  /** Output that means the CLI is asking the user something before it starts (e.g. whether to trust the folder). */
  readonly startupQuestion?: RegExp
  /**
   * How Combwork ends the CLI as a person would, for CLIs that write what Combwork reads only as they exit (Copilot's token
   * totals, #465): the keys it types, one every gapMs, before killing the CLI if it is still running after graceMs.
   * Without it, Stop kills the process. `armed` (HI-2272): what its screen shows once a first key at its prompt has
   * armed the next to exit. With it, Stop types the first key on conditions rather than at a fixed beat (exitKeys.ts):
   * a turn under way is cancelled first and its end waited for, and the key that exits is typed once this shows.
   */
  readonly exitKeys?: { keys: string[]; gapMs: number; graceMs: number; armed?: RegExp }
  /**
   * The command a person types to end the CLI (Claude Code's /exit, Codex's /quit), which Combwork types, then Enter, at a
   * lane's end once its builder's turn is over (HI-1706, sessions.quit), killing it if it is still running after graceMs.
   * Only that end uses it: Stop and restarts don't. A CLI without one is ended there by its exitKeys, or killed.
   */
  readonly quitLine?: { line: string; graceMs: number }
  parseUsage(text: string, sessionId: string): SessionUsage
  /** Reads a transcript's usage a piece at a time (whole lines), for transcripts that keep growing. */
  usageParser(sessionId: string): UsageParser
  /**
   * The title the CLI gives a session outside its transcript (Codex's and Copilot's session index), for a usage read
   * without it (the usage history, #1106); absent for a CLI whose transcript has it.
   */
  usageTitle?(sessionId: string): string | null
  conversationParser(projectPath: string): ConversationParserLike
  /** An image's data URL from the transcript line holding it. */
  /** `transcriptPath`: the transcript the line is from, for an image kept beside it (agy's media files, HI-2546). */
  imageData(line: Record<string, any>, loc: ImageLocation, transcriptPath: string): string | null | Promise<string | null>
  /** Heading for a Markdown export. */
  exportSubtitle(sessionId: string, project: string): string

  // Project files
  /** `homes`: the connections' homes on in the project's workspace (HI-1755), whose user memory replaces the CLI's own home's. */
  memorySources(projectPath: string, homes?: readonly { id: string; name: string; home: string }[]): Promise<MemorySource[]>
  /**
   * The memory the CLI saves by itself for a folder (HI-2666: Claude Code's auto memory), where it keeps it: the folder
   * (where it would write it, when none is there yet) and its Markdown files, its index first. Absent: Combwork doesn't
   * show what this CLI saves, if anything.
   */
  autoMemory?(folder: string): Promise<{ folder: string; files: MemorySource[] }>
  /** Files in the CLI's own folder Combwork may show and edit (instructions, memory); false for anything else. */
  /** `homes`: the connections' homes (HI-1755) to allow in place of the CLI's own home. */
  fileAllowed(path: string, write: boolean, homes?: readonly string[]): boolean
  /** `home`: a connection's home (HI-1755) rather than the CLI's own. */
  skillRoots(home?: string): SkillRoots
  /** MCP servers a project defines in the CLI's own config, which Combwork leaves off until copied to the workspace. */
  projectMcpServers(projectPath: string): Promise<Record<string, McpServerDef>>

  /**
   * What to do about the CLI exiting before its session started, from the lines it printed last (escapes removed):
   * e.g. an argument it refused, a model it doesn't know, no sign-in. Null when it doesn't recognise the error.
   */
  startHint?(text: string): StartHint | null

  // Background sessions (capabilities.backgroundSessions)
  /** The CLI's background job named in what it printed when it refused to resume a session held there; null if none. */
  backgroundJobIn?(output: string): string | null
  /** Stops one of the CLI's background jobs (its conversation is kept). */
  stopBackgroundJob?(executable: string, jobId: string): Promise<void>
}

/** A CLI's model catalog as read (models.ts files of each adapter): its models, and the one it runs by default. */
export interface CatalogRead {
  models: CatalogModel[]
  defaultModel?: string
}

export type { TranscriptImageRef }
