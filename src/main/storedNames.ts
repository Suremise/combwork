import { CW_TOOLS, TOOLS_SERVER } from '../shared/assistantTools'
import { NOTICE_PREFIX } from '../shared/doorbell'
import { agentMsg, inDefaultDialect, say } from '../shared/agentText'
import { ADVANCED_DEFS } from '../shared/advanced'

/**
 * The names upgrade's maps for stored values (HI-2598, its design HI-2598/s9): what 1.0 and the 1.1 release candidates
 * stored under Hive's names, as each step converts it once. Only the upgrade's steps use these (the board's and the
 * journal's schema steps, the profile's and the workspace's files): nothing reads an old value while the app runs.
 * Pure, so each step's tests use them as they are.
 */

/** A stored value's map, old to new: unchanged when it isn't old. */
const mapped = <T>(map: Readonly<Record<string, T>>) => (v: unknown): unknown => (typeof v === 'string' && Object.hasOwn(map, v) ? map[v] : v)

/** A fact's actor, a lane's builder id, a merge's `by`, a progress run's and the journal's source, a sender's kind. */
export const OLD_ID = 'hive'
export const NEW_ID = 'combwork'

/** A stored display name of Combwork's own (card history's `by`, a lane's builder and starter, a card's creator). */
export const OLD_NAME = 'Hive' // i18n-ignore: a stored identity, as stored before 1.1
export const NEW_NAME = 'Combwork' // i18n-ignore: a stored identity, as Combwork writes it

/** The workflow options' values: who merges, and the merge's commit message. */
export const optionValue = {
  finish: mapped({ hiveMerges: 'combworkMerges' }),
  commitMessage: mapped({ hive: 'combwork' })
} as const

/** A refusal's rule id. */
export const ruleId = mapped({ 'merge.hiveMerges': 'merge.combworkMerges' })

/** Workflow options (a level's, a ruleset's, a template's) with their old values converted; null when none is old. */
export function upgradedOptions<T extends Record<string, unknown>>(o: T | null | undefined): T | null {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  let out: T | null = null
  for (const key of Object.keys(optionValue) as (keyof typeof optionValue)[]) {
    if (!(key in o)) continue
    const now = optionValue[key](o[key])
    if (now !== o[key]) out = { ...(out ?? o), [key]: now }
  }
  return out
}

/** A run's or a check's name written by Combwork before 1.1: "Hive (merge queue)", "Hive (slot c)", "Hive (copy 2)". */
const OLD_RUN_NAME = /^Combwork \(/
export const upgradedRunName = (name: unknown): unknown => (typeof name === 'string' && OLD_RUN_NAME.test(name) ? `${NEW_NAME} (${name.slice('Hive ('.length)}` : name) // i18n-ignore: a run's stored name

/** A tool's name in a metrics series written before HI-2463 (`hive_<tool>`): its `cw_<tool>`, when it is one. */
export const upgradedToolName = (name: string): string => (name.startsWith('hive_') && CW_TOOLS.includes(`cw_${name.slice(5)}`) ? `cw_${name.slice(5)}` : name)

/** The prefix of Combwork's lines before HI-2463. */
export const OLD_NOTICE_PREFIX = '[Hive] '

const RENAMED = agentMsg({
  id: 'inbox.renamedNote',
  text: '(Combwork has renamed what agents use: a hive_<tool> named here is now cw_<tool>, mcp__hive__ is mcp__{server}__, and hive-progress is cw-progress.)',
  note: "HI-2463, HI-2598: added once, by the names upgrade, after a stored line or message from Combwork that names an old tool or command outside what it quotes (one written before the rename). Its words are kept as written (they may be a person's or an agent's): this says how the old names map. server: Combwork's MCP server's name."
})

/** What a person or an agent wrote, as Combwork's text quotes it: whole between <<< >>> (a relayed answer), or in quotes. */
const QUOTED = /<<<[\s\S]*?>>>|"[^"\n]*"|“[^”]*”/g

/**
 * Whether a text names a Combwork tool or command by its name before HI-2463 (hive_<tool>, mcp__hive__, hive-progress)
 * outside what it quotes: words quoted are someone's, and say what they say.
 */
export function namesOldProtocol(text: string): boolean {
  const own = text.replace(QUOTED, ' ')
  if (/\bmcp__hive__/.test(own) || /\bhive-progress\b/.test(own)) return true
  for (const m of own.matchAll(/\bhive_[a-z_]+\b/g)) if (upgradedToolName(m[0]) !== m[0]) return true
  return false
}

/** The note, in English: it is stored, so it is said in no agent's dialect. */
export const renamedNote = (): string => inDefaultDialect(() => say(RENAMED, { server: TOOLS_SERVER }))

/**
 * A stored line or message of Combwork's own, upgraded once: every word kept as written, since its text may quote a
 * person's or an agent's (a relayed answer, a card's latest comment, a lane's brief). A leading "[Hive] " becomes
 * "[CW] ", and one that names an old tool or command outside its quotes gets the note after it, unless it has it.
 * Null when nothing changes, so a step run again changes nothing. `fits`: whether a text is within what its store keeps
 * (a fired watch's line has a cap, and one over it isn't read): a note that wouldn't fit is left out.
 */
export function upgradedOwnText(text: string, fits: (s: string) => boolean = () => true): string | null {
  const head = text.startsWith(OLD_NOTICE_PREFIX) ? NOTICE_PREFIX + text.slice(OLD_NOTICE_PREFIX.length) : text
  const note = renamedNote()
  const noted = namesOldProtocol(text) && !head.endsWith(note) ? `${head} ${note}` : head
  const out = fits(noted) ? noted : head
  return out === text ? null : out
}

/**
 * Combwork's own advanced settings' ids before HI-2518 (`hive.<area>.<name>`), each with the `cw.` id it has now, and the
 * two kept only for a move they still feed (LEGACY_ADVANCED: `hive.assistant.otherMcpServers`, `hive.agents.perProject`).
 */
const OLD_ADVANCED: ReadonlyMap<string, string> = new Map([
  ...ADVANCED_DEFS.filter((d) => d.group === 'cw').map((d): [string, string] => [`hive.${d.id.slice('cw.'.length)}`, d.id]),
  ['hive.assistant.otherMcpServers', 'cw.assistant.otherMcpServers'],
  ['hive.agents.perProject', 'cw.agents.perProject']
])

/** An advanced id's current one: a CLI override's `preApproveHiveTools` is `preApproveCombworkTools`; unchanged when not old. */
export function upgradedAdvancedId(id: string): string {
  const to = OLD_ADVANCED.get(id)
  if (to) return to
  return id.endsWith('.override.preApproveHiveTools') ? `${id.slice(0, -'preApproveHiveTools'.length)}preApproveCombworkTools` : id
}

/**
 * A record keyed by advanced ids (advanced.json's values and madeFor, a workspace's own) with each old id renamed:
 * `renamed` lists the old ids moved or dropped. Where both are there, the new one is kept (by presence: false, 0 and []
 * are values) and the old one dropped. Other keys stay as they are, in their order. Pure.
 */
export function upgradedAdvancedIds<T>(record: Record<string, T>): { record: Record<string, T>; renamed: string[] } {
  const renamed = Object.keys(record).filter((k) => upgradedAdvancedId(k) !== k)
  if (!renamed.length) return { record, renamed }
  const out: Record<string, T> = {}
  for (const [k, v] of Object.entries(record)) {
    const to = upgradedAdvancedId(k)
    if (to === k) out[k] = v
    else if (!Object.hasOwn(record, to)) out[to] = v
  }
  return { record: out, renamed }
}
