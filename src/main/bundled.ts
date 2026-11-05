import { fmt, msg, tr } from '../shared/i18n'
import { existsSync } from 'original-fs'
import { lstat, readdir } from 'original-fs/promises'
import { join } from 'path'
import { cleanSwaps, contentHash, readJson, renameRetrying, SwapAbandoned, swapIn, swapOut, withFileLock, writeJsonAtomic } from './fsutil'
import { createLogger, userText } from './logger'
import { resourcesDir } from './paths'
import { revisionOf } from './revisions'
import { workspace } from './workspace'
import HISTORY from './bundledHistory.json'
import { RETIRED_PERSONAS, RETIRED_SKILLS, projectAgents } from '../shared/defaults'
import { ASSISTANT_AGENT_ID, LEGACY_MODES_DIR, MODES_DIR } from '../shared/assistant'
import { toast } from './events'
import { atMost } from '../shared/atMost'
import { dialectsDir } from './dialects/store'

/**
 * Keeps a workspace's copies of Hive's bundled skills, the Assistant's modes and the dialect files (HI-2439) up to date,
 * without overriding the user:
 * - a bundled item the workspace was never given is added (a new workspace, or one Hive added since);
 * - a copy the user never changed (a version Hive shipped, older than this one) is updated in place;
 * - a copy the user changed is kept as it is (the Skills, Modes and Dialects views offer Revert, and say when the copy
 *   came from an older version);
 * - an item the user deleted stays deleted (the views offer Restore).
 * `.combwork/bundled.json` records which items the workspace has been given and the version each copy came from.
 * bundledHistory.json lists every version Hive has shipped of each (scripts/bundled-history.mjs), oldest first.
 */

const log = createLogger('bundled')
/** Bundled items brought up to date at once (HI-1694): each is a folder's copy, hash and rename, slow on a drive a virus scanner watches. */
const ITEMS_AT_ONCE = 4
/** A sync this slow is logged with how long it took and what it changed (HI-1694). */
const SLOW_SYNC_MS = 1000
/** A bundled item's update this slow says its time (HI-1694). */
const SLOW_ITEM_MS = 500

/**
 * What Hive bundles: skills (a folder each), modes (a file each) and dialect files (`dialects`, HI-2439: a file each,
 * in a CLI's folder, its id `<folder>/<label>`, such as "claude-code/Opus 5.5").
 */
export type BundledKind = 'skills' | 'modes' | 'dialects'

/** What `.combwork/bundled.json` holds: per item, the shipped version its copy was made from (null: not Hive's copy). */
interface Manifest {
  skills: Record<string, { from: string | null }>
  modes: Record<string, { from: string | null }>
  dialects: Record<string, { from: string | null }>
}

/** Items that shipped before Hive kept a manifest: missing from a workspace without one, they were deleted by the user. */
const BEFORE_MANIFEST: Record<BundledKind, string[]> = {
  skills: ['handover', 'merge-ready', 'pick-up', 'review-agent-work', 'split-work', 'workspace-note'],
  modes: ['orchestrator', 'overseer', 'planner', 'reviewer'],
  dialects: []
}

const history = HISTORY as Record<BundledKind, Record<string, string[]>>

export function bundledDir(kind: BundledKind): string {
  return join(resourcesDir(), kind)
}

/** A bundled item's path: a skill's folder, a mode's file, a dialect file (its id is `<folder>/<label>`). */
const itemPath = (dir: string, kind: BundledKind, id: string): string => join(dir, kind === 'skills' ? id : kind === 'modes' ? `${id}.md` : `${id}.json`)

/** A dialect file's folders, as Hive ships them: a provider's id, or `api`. */
const DIALECT_FOLDER = /^[a-z0-9][a-z0-9-]*$/

/** The dialect files a folder of them holds, as ids (`<folder>/<label>`). */
async function dialectIds(dir: string): Promise<string[]> {
  const ids: string[] = []
  for (const f of (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory() && DIALECT_FOLDER.test(e.name))) {
    for (const e of await readdir(join(dir, f.name), { withFileTypes: true }).catch(() => [])) if (e.isFile() && e.name.endsWith('.json') && !e.name.startsWith('.')) ids.push(`${f.name}/${e.name.slice(0, -5)}`)
  }
  return ids.sort()
}

/** The items this version of Hive ships. */
export async function bundledIds(kind: BundledKind): Promise<string[]> {
  if (kind === 'dialects') return dialectIds(bundledDir(kind))
  try {
    const entries = await readdir(bundledDir(kind), { withFileTypes: true })
    return kind === 'skills'
      ? entries.filter((e) => e.isDirectory() && existsSync(join(bundledDir(kind), e.name, 'SKILL.md'))).map((e) => e.name)
      : entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name.slice(0, -3))
  } catch {
    return []
  }
}

/** What to do with one bundled item in a workspace (pure: the rules above). */
export interface BundledInput {
  /** This version's hash. */
  shipped: string
  /** The workspace copy's hash, or null when it has none. */
  copy: string | null
  /** The manifest's entry: undefined when the workspace was never given it (or has no manifest yet). */
  given: { from: string | null } | undefined
  /** Whether the workspace has a manifest (one from before keeps none). */
  manifest: boolean
  /** Every shipped version, oldest first (this one included). */
  versions: string[]
  /** Whether it shipped before the manifest existed. */
  shippedBefore: boolean
  /** Whether the folder that holds these exists (a workspace from before modes has no modes folder). */
  folder: boolean
}

export type BundledAction = 'add' | 'update' | 'keep' | 'deleted'

export function bundledAction(i: BundledInput): BundledAction {
  if (i.copy === null) {
    if (i.given) return 'deleted'
    // Without a manifest, an item that shipped before was given to the workspace, so it was deleted; unless the
    // workspace never had the folder.
    if (!i.manifest && i.shippedBefore && i.folder) return 'deleted'
    return 'add'
  }
  if (i.copy === i.shipped) return 'keep'
  // Untouched: a version Hive shipped before this one (a copy of a newer one, from another Hive, is left alone).
  const was = i.versions.lastIndexOf(i.copy)
  return was >= 0 && was < i.versions.lastIndexOf(i.shipped) ? 'update' : 'keep'
}

/** How a workspace copy compares with what this Hive ships, for the Skills and Modes views. */
export interface BundledStatus {
  bundled: 'same' | 'changed'
  /** A changed copy made from an older version than this one: Revert also brings in the newer version. */
  updateAvailable?: true
}

const manifestPath = (): string => join(workspace.hiveDir, 'bundled.json')

async function readManifest(): Promise<Manifest | null> {
  return manifestOf(await readJson<unknown>(manifestPath(), null))
}

/** The manifest as a file holds it (as read), or null. */
function manifestOf(file: unknown): Manifest | null {
  const m = file as Partial<Manifest> | null
  if (!m || typeof m !== 'object') return null
  const part = (v: unknown): Manifest['skills'] => (v && typeof v === 'object' ? (v as Manifest['skills']) : {})
  // Until 0.9.3 the modes were personas, and so was their key (#1084).
  return { skills: part(m.skills), modes: part(m.modes ?? (m as { personas?: unknown }).personas), dialects: part(m.dialects) }
}

/** Changes the manifest under its lock (another window's sync or a Restore may be writing it). */
function changeManifest(fn: (m: Manifest) => void): Promise<void> {
  const path = manifestPath()
  return withFileLock(path, async () => {
    const m = (await readManifest()) ?? { skills: {}, modes: {}, dialects: {} }
    fn(m)
    await writeJsonAtomic(path, m)
  })
}

const folderOf = (kind: BundledKind): string => (kind === 'skills' ? workspace.skillsDir : kind === 'modes' ? workspace.modesDir : dialectsDir(workspace.hiveDir))

/** What an item is called in the log. */
const itemWord = (kind: BundledKind): string => (kind === 'skills' ? 'skill' : kind === 'modes' ? 'mode' : 'dialect file') // i18n-ignore: the log's words for a bundled item

/**
 * Puts this Hive's version of an item in the workspace (swapIn: a skill's folder or a mode's file, all at once). An
 * automatic update or add passes what the copy was when it was decided (its contentHash, or null: none): if the user
 * changed, deleted or replaced it since, SwapAbandoned, and theirs stays. Restore and Revert, which the user asked for,
 * pass nothing.
 */
async function install(kind: BundledKind, id: string, expected?: string | null): Promise<void> {
  await swapIn(itemPath(bundledDir(kind), kind, id), itemPath(folderOf(kind), kind, id), { expected })
}

/**
 * A swap's leftover old copy is disposable when it is a version Hive shipped of that item (nothing of the user's).
 * `folder`: a dialect file's folder, the first part of its id.
 */
function shippedVersion(kind: BundledKind, folder?: string): (old: string, name: string) => Promise<boolean> {
  const idOf = (name: string): string => (kind === 'skills' ? name : kind === 'modes' ? name.replace(/\.md$/, '') : `${folder}/${name.replace(/\.json$/, '')}`)
  return async (old, name) => (history[kind][idOf(name)] ?? []).includes(await contentHash(old))
}

/** Cleans what a crash in a swap left where a kind's items are swapped in: its folder, and each dialect folder in it. */
async function cleanKind(kind: BundledKind, folder: string): Promise<void> {
  if (kind !== 'dialects') return cleanSwaps(folder, shippedVersion(kind))
  for (const f of (await readdir(folder, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory() && DIALECT_FOLDER.test(e.name))) await cleanSwaps(join(folder, f.name), shippedVersion(kind, f.name))
}

/**
 * Brings the workspace's bundled skills, modes and dialect files up to date (each time it opens; `fresh` for a workspace Hive has
 * just set up). One item that can't be updated (a file in it open) is left as it is until the next time; the others go
 * ahead.
 */
export async function syncBundled(opts: { fresh?: boolean } = {}): Promise<void> {
  const started = performance.now()
  const changed = { skills: 0, modes: 0, dialects: 0 }
  await withFileLock(manifestPath(), async () => {
    await moveLegacyModes()
    const file = await readJson<unknown>(manifestPath(), null)
    const before = manifestOf(file)
    // A copy: compared with the file when it is written.
    const m: Manifest = before ? structuredClone(before) : { skills: {}, modes: {}, dialects: {} }
    const ids = { skills: await bundledIds('skills'), modes: await bundledIds('modes'), dialects: await bundledIds('dialects') }
    for (const kind of ['skills', 'modes', 'dialects'] as const) {
      const folder = folderOf(kind)
      // A workspace Hive has just set up has empty folders: nothing in it was deleted.
      const hadFolder = !opts.fresh && existsSync(folder)
      // What a crash in a swap left: an old copy that isn't a shipped version (the user's) is kept, renamed beside it.
      await cleanKind(kind, folder)
      const syncItem = async (id: string): Promise<void> => {
        const t0 = performance.now()
        const dest = itemPath(folder, kind, id)
        const shipped = await contentHash(itemPath(bundledDir(kind), kind, id))
        // A dangling link is still the user's (lstat, not existsSync); a copy that can't be read counts as edited.
        const present = await lstat(dest).then(() => true, () => false)
        const copy = present ? await contentHash(dest).catch(() => 'unreadable') : null
        const action = bundledAction({ shipped, copy, given: m[kind][id], manifest: !!before, versions: history[kind][id] ?? [shipped], shippedBefore: BEFORE_MANIFEST[kind].includes(id), folder: hadFolder })
        try {
          if (action === 'add' || action === 'update') {
            // Only over the copy this was decided on (or into an empty place): a change of the user's meanwhile wins.
            await install(kind, id, copy)
            m[kind][id] = { from: shipped }
            changed[kind]++
            // Its time when slow (HI-1694: 1.3 s each on a 0.9 workspace's first open, where the files take milliseconds).
            const ms = performance.now() - t0
            log.info(`${action === 'add' ? 'Added' : 'Updated'} the bundled ${itemWord(kind)} ${userText(id)}${ms > SLOW_ITEM_MS ? ` (${Math.round(ms)} ms)` : ''}`)
          } else if (action === 'deleted') m[kind][id] ??= { from: null }
          else if (copy === shipped) m[kind][id] = { from: shipped }
          // A changed copy keeps the version it came from; one Hive never gave (a same-name folder of the user's) has none.
          else m[kind][id] ??= { from: (history[kind][id] ?? []).includes(copy!) ? copy : null }
        } catch (e) {
          // The user changed it meanwhile: it is theirs now, as the next scan will see; the manifest isn't changed.
          if (e instanceof SwapAbandoned) {
            log.info(`Left the bundled ${itemWord(kind)} ${userText(id)} as it is: it changed while Combwork was ${action === 'add' ? 'adding' : 'updating'} it`)
            return
          }
          log.warn(`Could not ${action === 'add' ? 'add' : 'update'} the bundled ${itemWord(kind)} ${userText(id)}; trying again next time`, e)
        }
      }
      // A few at once (HI-1694): one after another, a 0.9 workspace's 19 took 20 s on a scanned drive.
      await atMost(ITEMS_AT_ONCE, ids[kind], syncItem)
    }
    await retirePersonas(m)
    await retireSkills(m)
    // Written only when it changes what the file holds (HI-1705: every open wrote it).
    if (JSON.stringify(m) !== JSON.stringify(file)) await writeJsonAtomic(manifestPath(), m)
  })
  const ms = performance.now() - started
  if (ms > SLOW_SYNC_MS) log.info(`bringing the bundled skills, modes and dialect files up to date took ${(ms / 1000).toFixed(1)} s: ${changed.skills} skill(s), ${changed.modes} mode(s) and ${changed.dialects} dialect file(s) added or updated`)
}

/**
 * Until 0.9.3 the modes were personas, in .combwork/personas (#1084): the folder is moved to .combwork/modes as it is, the
 * user's edits and the copies bundled.json tracks with it, as the workspace opens (before its folders are watched, which
 * would hold them). One that can't be moved now (a file in it open) is used where it is (workspace.modesDir) and moved
 * the next time; one an older Hive made again beside .combwork/modes is left alone.
 */
async function moveLegacyModes(): Promise<void> {
  const from = join(workspace.hiveDir, LEGACY_MODES_DIR)
  const to = join(workspace.hiveDir, MODES_DIR)
  if (existsSync(to) || !existsSync(from)) return
  try {
    // A moment's lock (an indexer, a virus scan) is waited out; a file held open fails it.
    await renameRetrying(from, to)
    log.info("Moved the Assistant's modes from .combwork/personas to .combwork/modes")
  } catch (e) {
    log.warn('Could not move .combwork/personas to .combwork/modes: its modes are used where they are until the next time', e)
  }
}

/**
 * Skills shipped under a new name (RETIRED_SKILLS, HI-2463): the old name's workspace copy goes while it is a version
 * Combwork shipped, never changed (the new one was added above, so agents get the skill once); one the user changed is
 * theirs and stays. Afterwards there is no copy, so this happens once.
 */
async function retireSkills(m: Manifest): Promise<void> {
  for (const id of Object.keys(RETIRED_SKILLS)) {
    const dest = itemPath(folderOf('skills'), 'skills', id)
    if (await lstat(dest).then(() => true, () => false)) {
      const copy = await contentHash(dest).catch(() => 'unreadable')
      if (!(history.skills[id] ?? []).includes(copy)) continue
      try {
        // Only while it is still that copy: an edit of the user's meanwhile stays (swapOut).
        await swapOut(dest, copy)
        log.info(`Removed the bundled skill ${userText(id)}: it ships as ${userText(RETIRED_SKILLS[id])} now`)
      } catch (e) {
        if (e instanceof SwapAbandoned) log.info(`Kept the skill ${userText(id)}: it changed while Combwork was removing it, so it is the user's`)
        else log.warn(`Could not remove the renamed skill ${userText(id)}; trying again next time`, e)
        continue
      }
    }
    delete m.skills[id]
  }
}

/**
 * Personas Hive no longer ships (working modes replaced them, #259): a workspace copy that is a version Hive shipped,
 * never changed, goes (nothing of the user's is lost); one the user changed is theirs and stays. A workspace whose
 * Assistant used one that went moves to its mode, and is told once (this happens once: afterwards there is no copy).
 */
async function retirePersonas(m: Manifest): Promise<void> {
  const moved: string[] = []
  // The modes' own names, as their files name them.
  const name = (id: string): string => (id === 'qa-triager' ? 'QA triager' : id.charAt(0).toUpperCase() + id.slice(1)) // i18n-ignore: a mode's name
  for (const [id, mode] of Object.entries(RETIRED_PERSONAS)) {
    const dest = itemPath(workspace.modesDir, 'modes', id)
    const present = await lstat(dest).then(() => true, () => false)
    if (present) {
      const copy = await contentHash(dest).catch(() => 'unreadable')
      if (!(history.modes[id] ?? []).includes(copy)) continue
      try {
        // Only while it is still that copy: an edit or a replacement of the user's meanwhile stays (swapOut).
        await swapOut(dest, copy)
        log.info(`Removed the retired persona ${userText(id)}: it is now the ${userText(mode)} mode`)
      } catch (e) {
        if (e instanceof SwapAbandoned) log.info(`Kept the retired persona ${userText(id)}: it changed while Combwork was removing it, so it is the user's`)
        else log.warn(`Could not remove the retired persona ${userText(id)}; trying again next time`, e)
        continue
      }
    }
    delete m.modes[id]
    // One of the user's in its place meanwhile (made while it was being removed): theirs, and the choice of it stays.
    if (await lstat(dest).then(() => true, () => false)) continue
    if (await chooseModeFor(id, mode)) moved.push(`${name(id)} → ${name(mode)}`)
    else if (present) moved.push(`${name(id)} → ${name(mode)}`)
  }
  if (moved.length)
    toast(
      'info',
      tr(msg({ id: 'main.modes.retiredTitle', defaultMessage: "The Assistant's personas are now working modes", description: "A notice once, after an update: the Assistant's character personas became working modes." })),
      tr(msg({ id: 'main.modes.retiredBody', defaultMessage: "Coordinator, Planner, QA triager and Release manager replace Combwork's character personas ({moved}). Switch modes from the Assistant's header; your own personas are unchanged.", description: 'The notice that personas became working modes. The four names are the modes\' own names: keep them. {moved} lists which persona became which mode ("Pirate → Coordinator").' }), { moved: fmt.list(moved) })
    )
}

/**
 * The workspace's Assistant chose a persona that went: its mode instead. Decided under the Assistant home's config lock
 * on the choice as it is then, so a choice the user made meanwhile stays; true when it moved.
 */
async function chooseModeFor(id: string, mode: string): Promise<boolean> {
  const home = workspace.assistantHome
  // Most workspaces never chose it: nothing is written then.
  if ((await workspace.projectConfig(home).catch(() => null))?.agents?.find((a) => a.id === ASSISTANT_AGENT_ID)?.mode !== id) return false
  let moved = false
  await workspace
    .mutateProjectConfig(home, (cfg) => {
      const agents = projectAgents(cfg)
      if (agents.find((a) => a.id === ASSISTANT_AGENT_ID)?.mode !== id) return {}
      moved = true
      return { agents: agents.map((a) => (a.id === ASSISTANT_AGENT_ID ? { ...a, mode } : a)) }
    })
    .catch((e) => log.warn('moving the Assistant to its mode', e))
  return moved
}

/** Puts back an item as this Hive ships it (Restore, Revert), and records that the copy is Hive's again. */
export async function restoreBundled(kind: BundledKind, id: string): Promise<void> {
  await install(kind, id)
  const shipped = await contentHash(itemPath(bundledDir(kind), kind, id))
  await changeManifest((m) => {
    m[kind][id] = { from: shipped }
  })
}

/** How the workspace's copy of a bundled item compares with this Hive's. */
export async function bundledStatus(kind: BundledKind, id: string, copyPath: string): Promise<BundledStatus> {
  const [copy, shipped] = await Promise.all([revisionOf(copyPath).catch(() => ''), revisionOf(itemPath(bundledDir(kind), kind, id))])
  if (copy === shipped) return { bundled: 'same' }
  // Only a copy made from a version older than this one has an update here: one from a newer Hive (sharing the
  // workspace) or an unknown one doesn't, and Revert would take it back.
  const from = (await readManifest())?.[kind][id]?.from
  return from && olderThan(kind, id, from, shipped) ? { bundled: 'changed', updateAvailable: true } : { bundled: 'changed' }
}

/** Whether `version` is a version Hive shipped before `shipped` (bundledHistory.json's order). */
export function olderThan(kind: BundledKind, id: string, version: string, shipped: string): boolean {
  const versions = history[kind][id] ?? []
  const at = versions.lastIndexOf(version)
  return at >= 0 && at < versions.lastIndexOf(shipped)
}
