/**
 * Agent text (dialects, HI-2065; plans/2026-11-03-dialects-design.md, section 2): every text Combwork sends an agent is
 * declared beside its code with `agentMsg()` and rendered with `say()`, which takes the text of the **current chain**:
 * the dialect of the session the text is for. Plain English, always: the window's translations never reach it, and it
 * never reaches the window (the window renders its own messages with `tr()`).
 *
 * Where the chain comes from:
 * - **A scope**, in the main process: each Agent API request opens one for its caller (`inRequestScope`, asyncScope.ts),
 *   and wakes and deliveries for the session they target (`inDialectOf`). A **chain resolver** turns a scope into its
 *   chain; until one is registered (`setChainResolver`, the dialects service), every scope resolves to the Default.
 * - **The process**, in cw-mcp.js and cw-progress.js: one process serves one session, whose resolved texts Combwork
 *   writes to the file `CW_DIALECT_FILE` names (processDialect.ts loads it).
 * - Neither: the Default, the code's English.
 *
 * An override that doesn't format (a placeholder it lost, broken ICU) falls back to the code's English: a dialect can't
 * break what Combwork says. This module imports no Node module, so the window can import shared code that holds agent text
 * (it shows a preview of some, such as the Workspace notes an agent gets); there it is always the Default.
 */
import { formatIcu, IcuError } from './icu.ts'
import type { AgentMsg, AgentValues } from './msg.ts'

// Imports name their extension: tests' scripts load agent text in plain Node (combworkGuidance.ts, through replysize.cjs).
export { agentMsg, type AgentMsg, type AgentValues } from './msg.ts'

/** A resolved chain: each text an override of it changes (id → ICU text, merged down the chain), and where they came from. */
export interface DialectChain {
  /** Only the overrides: an id it doesn't name is the Default's. */
  texts: Readonly<Record<string, string>>
  /** The chain's files, top first (the launch record shows them). */
  files: readonly string[]
  /** A hash of the resolved texts, for the guidance revision and the launch record. */
  hash: string
}

/** The session a text is for: an agent (or the Assistant, in its home) by its folder and id. */
export interface DialectSession {
  projectPath: string
  agentId: string
}

/**
 * Whose dialect text is rendered in:
 * - `session`: an agent's or the Assistant's (its chain is pinned at its launch);
 * - `api`: a caller with no session (a script, `curl`): Default → Workspace → API;
 * - `default`: the Default whatever else is set (the guidance revision, the window's previews).
 */
export type DialectScope = { kind: 'session'; session: DialectSession } | { kind: 'api' } | { kind: 'default' }

/** Turns a scope into its chain, or null for the Default. Registered by the dialects service. */
export type ChainResolver = (scope: Exclude<DialectScope, { kind: 'default' }>) => DialectChain | null

/** Where the current scope is kept: a synchronous one here; the main process installs AsyncLocalStorage (asyncScope.ts). */
export interface ScopeStore {
  current(): DialectScope | undefined
  run<T>(scope: DialectScope, fn: () => T): T
}

/** The store with no async context: a scope holds for the synchronous part of fn only (no Node: the window has it). */
function syncStore(): ScopeStore {
  let now: DialectScope | undefined
  return {
    current: () => now,
    run: (scope, fn) => {
      const was = now
      now = scope
      try {
        return fn()
      } finally {
        now = was
      }
    }
  }
}

let store: ScopeStore = syncStore()
let resolver: ChainResolver | null = null
let processChain: DialectChain | null = null

/** Installs where scopes are kept (asyncScope.ts does, in the main process). */
export function setScopeStore(s: ScopeStore): void {
  store = s
}

/** Registers the chain resolver (the dialects service); null: every scope is the Default again. */
export function setChainResolver(r: ChainResolver | null): void {
  resolver = r
}

/** The process's own chain (processDialect.ts, in cw-mcp.js and cw-progress.js): used where no scope is open. */
export function setProcessChain(chain: DialectChain | null): void {
  processChain = chain
}

/** Runs fn in a scope. */
export const inDialectScope = <T>(scope: DialectScope, fn: () => T): T => store.run(scope, fn)

/** Runs fn with the dialect of the session it is for (a wake, a delivery, a launch's text). */
export const inDialectOf = <T>(session: DialectSession, fn: () => T): T => store.run({ kind: 'session', session }, fn)

/** Runs fn in the Default, whatever scope or process chain is set: text that must not vary by dialect (the guidance revision). */
export const inDefaultDialect = <T>(fn: () => T): T => store.run({ kind: 'default' }, fn)

/** The scope open now, if any. */
export const currentScope = (): DialectScope | undefined => store.current()

/** The chain text is rendered in now: the scope's (through the resolver), else the process's; null is the Default. */
export function currentChain(): DialectChain | null {
  const scope = store.current()
  if (!scope) return processChain
  if (scope.kind === 'default') return null
  return resolver?.(scope) ?? null
}

/** Overrides that don't format, each reported once (to the log, where one is set). */
const reported = new Set<string>()
let onProblem: (text: string) => void = () => undefined

/** Where an override that doesn't format is reported (main's log). */
export function setAgentTextProblemReporter(fn: (text: string) => void): void {
  onProblem = fn
}

/**
 * A message's text for the current chain, formatted with its values: the chain's override, else the code's English.
 * Never call it at module scope (the chain is known per call): keep the descriptor, and say it when the text is sent.
 */
export function say(m: AgentMsg, values?: AgentValues): string {
  return overrideOf(m.id, m.text, values) ?? formatIcu(m.text, values)
}

/**
 * The current chain's override of a text, formatted with its values; undefined where the chain has none (or one the
 * same as `english`), or one that doesn't format (the dialect's fault: reported once, and the caller says its English).
 * `say()` uses it for agent messages, and `agentText()` (shared/advanced.ts) for the window's messages agents also read.
 */
export function overrideOf(id: string, english: string, values?: AgentValues): string | undefined {
  const override = currentChain()?.texts[id]
  if (override === undefined || override === english) return undefined
  try {
    return formatIcu(override, values)
  } catch (e) {
    const key = `${id}:${override}`
    if (!reported.has(key)) {
      reported.add(key)
      onProblem(`agent text ${id}: its override doesn't format (${e instanceof IcuError ? e.message : String(e)}); the Default's English is used`)
    }
    return undefined
  }
}

/** Whether the current chain overrides any of these ids: stored English is re-rendered only where it does. */
export function overridesAny(ids: Iterable<string>): boolean {
  const texts = currentChain()?.texts
  if (!texts) return false
  for (const id of ids) if (Object.hasOwn(texts, id)) return true
  return false
}

const lists = new Intl.ListFormat('en-GB', { type: 'conjunction' })

/** Items joined as agent text joins them: "a", "a and b", "a, b and c" (no serial comma). */
export const agentList = (items: readonly string[]): string => lists.format(items)
