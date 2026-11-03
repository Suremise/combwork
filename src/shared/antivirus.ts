/**
 * Antivirus scanning of a workspace (#316): whether Microsoft Defender scans the folders Hive's work goes through, and
 * the exclusions Hive can offer. Pure: main (main/antivirus.ts) runs the read-only probe and the elevated changes and
 * gives their output here; the renderer shows the status. Only Windows has anything to check: elsewhere the status is
 * "not applicable".
 *
 * The folders are worked out per workspace (computed in main, always resolved absolute paths): the workspace root (its
 * projects live in it), its worktrees folder once it exists, and Hive's test area for people developing Hive. Nothing
 * broader is ever offered (a drive, a share, the home folder or the profile, or a folder holding one of them), and
 * Hive only ever removes the exclusions it added itself.
 *
 * Its sentences are window text, worked out in the language Hive shows (main's for a change's outcome).
 */
import { tr, type Msg } from './i18n'
import { msg } from './i18n/msg'

const M = {
  notAbsolute: msg({ id: 'workspace.antivirus.notAbsolute', defaultMessage: 'not an absolute folder', description: "Why Hive won't offer to exclude a folder from Defender's scans. Lower case: it follows the folder." }),
  wholeDrive: msg({ id: 'workspace.antivirus.wholeDrive', defaultMessage: 'a whole drive', description: "Why Hive won't offer to exclude a folder from Defender's scans. Lower case: it follows the folder." }),
  wholeShare: msg({ id: 'workspace.antivirus.wholeShare', defaultMessage: 'a whole network share', description: "Why Hive won't offer to exclude a folder from Defender's scans. Lower case: it follows the folder." }),
  holdsHome: msg({ id: 'workspace.antivirus.holdsHome', defaultMessage: 'it is, or holds, your home folder, profile or a system folder', description: "Why Hive won't offer to exclude a folder from Defender's scans. Lower case: it follows the folder." }),
  unresolved: msg({ id: 'workspace.antivirus.unresolved', defaultMessage: 'its real location couldn’t be established', description: "Why Hive won't offer to exclude a folder from Defender's scans (a link it couldn't follow). Lower case: it follows the folder." }),
  declined: msg({ id: 'workspace.antivirus.declined', defaultMessage: 'The administrator prompt was declined: nothing changed.', description: "After a change to Defender's exclusions: Windows' administrator (UAC) prompt was answered No." }),
  noPrompt: msg({ id: 'workspace.antivirus.noPrompt', defaultMessage: "Windows couldn't start the administrator prompt{hasError, select, yes {: {error}} other {.}}", description: "After a change to Defender's exclusions: Windows' administrator (UAC) prompt didn't start; {error} is Windows' reason." }),
  noReport: msg({ id: 'workspace.antivirus.noReport', defaultMessage: 'The change ran with administrator rights but reported nothing: check again to see what Defender has.', description: "After a change to Defender's exclusions." }),
  unknownError: msg({ id: 'workspace.antivirus.unknownError', defaultMessage: 'unknown error', description: "Defender's reason for refusing a change, when it gave none. Lower case: it follows a colon." }),
  policy: msg({ id: 'workspace.antivirus.policy', defaultMessage: 'Defender refused the change, probably because your organisation manages its settings: {error}', description: "After a change to Defender's exclusions; {error} is Defender's own message." }),
  refused: msg({ id: 'workspace.antivirus.refused', defaultMessage: 'Defender refused the change: {error}', description: "After a change to Defender's exclusions; {error} is Defender's own message." }),
  unreadable: msg({ id: 'workspace.antivirus.unreadable', defaultMessage: 'The change ran, but Defender’s list couldn’t be read afterwards: check again to see what it has.', description: "After a change to Defender's exclusions." }),
  checked: msg({ id: 'workspace.antivirus.checked', defaultMessage: 'Read Defender’s exclusions with administrator rights.', description: "After Check with administrator rights: Defender's exclusion list was read." }),
  alreadySkips: msg({ id: 'workspace.antivirus.alreadySkips', defaultMessage: 'Defender already skips these folders (an existing exclusion covers them): nothing added.', description: "After Add exclusions, when there was nothing to add." }),
  noneLeft: msg({ id: 'workspace.antivirus.noneLeft', defaultMessage: 'None of Combwork’s exclusions is in Defender’s list any more: nothing removed.', description: "After Remove exclusions, when there was nothing to remove." }),
  notApplied: msg({ id: 'workspace.antivirus.notApplied', defaultMessage: "Defender accepted the change but {action, select, add {doesn't list {missing, plural, one {one folder} other {# folders}}} other {still lists {missing, plural, one {one folder} other {# folders}}}}: your organisation's settings probably override local exclusions.", description: "After a change to Defender's exclusions that Defender accepted but doesn't show (added ones missing, or removed ones still there)." }),
  added: msg({ id: 'workspace.antivirus.added', defaultMessage: 'Defender no longer scans {count, plural, one {this folder} other {these # folders}}.', description: 'After Add exclusions: done.' }),
  moved: msg({ id: 'workspace.antivirus.moved', defaultMessage: "Moved Combwork's exclusions to the new folders: {removed, plural, =0 {none removed} one {# removed} other {# removed}}, {added, plural, =0 {none added (Defender already skips them)} one {# added} other {# added}}.", description: "After Repair moved Hive's Defender exclusions from a moved workspace's old folders to its new ones (#1302): how many old ones were removed and new ones added." }),
  moveNotApplied: msg({ id: 'workspace.antivirus.moveNotApplied', defaultMessage: "Defender accepted the change but {missing, plural, one {one folder isn't} other {# folders aren't}} as asked: your organisation's settings probably override local exclusions.", description: "After Repair moved Hive's Defender exclusions (#1302), when Defender doesn't show the change for some folders (an old one still listed, or a new one missing)." }),
  removed: msg({ id: 'workspace.antivirus.removed', defaultMessage: 'Removed {count, plural, one {the exclusion} other {# exclusions}} Combwork added.', description: 'After Remove exclusions: done.' }),
  kindWorkspace: msg({ id: 'workspace.antivirus.kindWorkspace', defaultMessage: 'The workspace (every project in it)', description: "A folder Defender may scan, as the antivirus status and Hive's offer name it." }),
  kindWorktrees: msg({ id: 'workspace.antivirus.kindWorktrees', defaultMessage: 'Its worktrees', description: "A folder Defender may scan: the workspace's worktrees folder." }),
  kindTests: msg({ id: 'workspace.antivirus.kindTests', defaultMessage: 'Combwork’s test area (developing Combwork)', description: "A folder Defender may scan: where Hive's own tests work, offered to people developing Hive." })
}

/** Which folder of the workspace's set a path is. */
export type AvPathKind = 'workspace' | 'worktrees' | 'tests'

/**
 * Whether Defender skips a folder: excluded or not (seen in Defender's list), unknown (Defender hides its list from
 * processes without administrator rights), or added by Hive and not seen since (the list is hidden).
 */
export type AvPathState = 'excluded' | 'not-excluded' | 'unknown' | 'added'

/**
 * Whether a folder is on a Dev Drive: confirmed trusted, or a Dev Drive that isn't trusted (scanned like any other),
 * both only from a check with administrator rights; a ReFS volume not checked (it may be one); not one; or unknown.
 */
export type AvDevDrive = 'trusted' | 'untrusted' | 'refs' | 'no' | 'unknown'

/** What scans the workspace. */
export type AvScan =
  /** Not Windows: nothing to check. */
  | 'not-applicable'
  /** A test copy of Hive without a fixture: it never asks Defender (tests stub it). */
  | 'test-copy'
  /** The status couldn't be read (PowerShell failed or took too long). */
  | 'unavailable'
  /** Microsoft Defender is the active antivirus. */
  | 'defender'
  /** Another antivirus is active instead: Hive can't manage it. */
  | 'other'
  /** No active antivirus was found. */
  | 'none'

export interface AvPath {
  path: string
  kind: AvPathKind
  state: AvPathState
  /** Hive added this exclusion (so Remove may take it away again). */
  addedByHive: boolean
  /** Defender lists this folder itself, not only a folder holding it (known only when its list is: #1302). */
  listed?: boolean
  devDrive: AvDevDrive
  /** Why Hive won't offer to exclude it (too broad, or its real location couldn't be established). */
  unsafe?: string
}

export interface AntivirusStatus {
  workspacePath: string
  scan: AvScan
  /** Defender's real-time protection (null when not Defender, or unknown). */
  realTime: boolean | null
  /** Defender's performance mode for trusted Dev Drives (null when unknown). */
  performanceMode: boolean | null
  /** Where the exclusion states come from: Defender's list now, the last check with administrator rights, or neither. */
  exclusionsFrom: 'live' | 'admin-check' | null
  /** When the administrator check was made (exclusionsFrom 'admin-check'). */
  adminCheckedAt?: string
  /** The other active antivirus products, by name (scan 'other'). */
  others: string[]
  paths: AvPath[]
  checkedAt: string
  /** Why it couldn't be read (scan 'unavailable'). */
  error?: string
  /**
   * Whether scanning likely slows this workspace in a way Hive can help with: Defender with real-time protection on,
   * and a folder Hive may offer that isn't known to be excluded nor on a trusted Dev Drive in performance mode.
   */
  slowed: boolean
  /** The folders an offer is about (the slowed ones), as a key: an offer is made once for each set. */
  offerKey: string
  /**
   * Hive's own exclusions of folders that no longer exist (#1389: a workspace moved without Repair moving them, its
   * prompt declined, a folder deleted): those Defender lists (`excluded`), or with its list hidden every one Hive
   * recorded (`added`, unconfirmed). Remove Hive's Exclusions… takes them away with the workspace's.
   */
  gone?: AvGone[]
}

export interface AvGone {
  path: string
  state: 'excluded' | 'added'
}

/** The read-only probe's output (main/antivirus.ts probeScript), as untrusted JSON. */
export interface AvProbe {
  defender: { antivirus: boolean; realTime: boolean; mode: string } | null
  /** Null when Defender hides the list (no administrator rights), or it couldn't be read or isn't a list of paths. */
  exclusions: string[] | null
  /** Defender's PerformanceModeStatus: 0 on, 1 off; null when unknown. */
  performanceMode: boolean | null
  /** Security Center's antivirus products (null where there is none, e.g. Windows Server). */
  products: { name: string; state: number }[] | null
  /** Each drive's file system, by letter (upper case). */
  volumes: Record<string, string | null>
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v])
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/**
 * A list of paths as PowerShell prints one (an array, or a single string for one entry), or null when it isn't one:
 * anything else is unknown, never an empty list.
 */
export function pathList(v: unknown): string[] | null {
  if (typeof v === 'string') return v.trim() ? [v] : []
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return null
  return (v as string[]).filter((x) => x.trim() !== '')
}

/**
 * Defender's exclusion list as read, or null when it wasn't really read: not a list of paths, or Defender's answer for
 * a hidden list ("N/A: Must be an administrator to view exclusions"), whichever read produced it. A genuinely empty
 * list is a list.
 */
export function readableList(v: unknown): string[] | null {
  const l = pathList(v)
  return l && !l.some((x) => /^N\/A\b/i.test(x.trim())) ? l : null
}

/** The probe's JSON, checked: anything missing or of the wrong kind is unknown, never a guess. */
export function parseProbe(raw: unknown): AvProbe {
  const r = obj(raw) ?? {}
  const d = obj(r.defender)
  const defender = d && typeof d.antivirus === 'boolean' && typeof d.realTime === 'boolean' ? { antivirus: d.antivirus, realTime: d.realTime, mode: str(d.mode) ?? '' } : null
  // Without administrator rights Defender answers "N/A: Must be an administrator to view exclusions".
  const ex = readableList(r.exclusions)
  const products = r.products === null || r.products === undefined ? null : list(r.products).flatMap((p) => {
    const o = obj(p)
    return o && typeof o.name === 'string' && typeof o.state === 'number' ? [{ name: o.name, state: o.state }] : []
  })
  const volumes: Record<string, string | null> = {}
  for (const v of list(r.volumes)) {
    const o = obj(v)
    const drive = str(o?.drive)
    if (drive && /^[a-z]$/i.test(drive)) volumes[drive.toUpperCase()] = str(o?.fs)
  }
  return { defender, exclusions: ex, performanceMode: r.perfMode === 0 ? true : r.perfMode === 1 ? false : null, products, volumes }
}

/** Whether a Security Center product state says it is on (the second byte of 0xAABBCC: 0x10 or 0x11 on). */
export const productOn = (state: number): boolean => ((state >> 12) & 0xf) === 1

const isDefender = (name: string): boolean => /defender/i.test(name)

/** A path as Defender compares them: backslashes, no trailing separator, any case. */
export function normPath(p: string): string {
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/** Whether an exclusion list covers a folder: the folder itself or one of its parents (no wildcards or variables). */
export function covered(path: string, exclusions: string[]): boolean {
  const p = normPath(path)
  return exclusions.some((e) => {
    const x = normPath(e.trim())
    return !!x && (p === x || p.startsWith(`${x}\\`))
  })
}

/** Whether an exclusion list has this exact entry (what Hive may remove: never a parent someone else added). */
export const listed = (path: string, exclusions: string[]): boolean => exclusions.some((e) => normPath(e) === normPath(path))

const driveOf = (p: string): string | null => /^([a-z]):/i.exec(p)?.[1].toUpperCase() ?? null

/** What `fsutil devdrv query X:` says about a drive (run with administrator rights): a Dev Drive, trusted or not. */
export function devDriveOf(text: unknown): 'trusted' | 'untrusted' | 'no' | null {
  if (typeof text !== 'string' || !text.trim()) return null
  if (/not a (trusted )?developer volume/i.test(text) && !/is a (trusted )?developer volume/i.test(text)) return 'no'
  if (/untrusted developer volume|not trusted/i.test(text)) return 'untrusted'
  if (/trusted developer volume/i.test(text)) return 'trusted'
  if (/developer volume/i.test(text)) return 'untrusted'
  return null
}

/**
 * Why a folder must never be excluded, or null when it may be offered: a drive or a share's root, or a folder that is
 * (or holds) the home folder, the profile or a system folder. `guarded` are those folders, resolved.
 */
export function unsafeFolder(path: string, guarded: string[]): string | null {
  const p = normPath(path)
  if (!/^[a-z]:(\\|$)|^\\\\[^\\]+\\[^\\]+/i.test(path.replace(/\//g, '\\'))) return tr(M.notAbsolute)
  if (/^[a-z]:$/.test(p)) return tr(M.wholeDrive)
  if (/^\\\\[^\\]+\\[^\\]+$/.test(p)) return tr(M.wholeShare)
  for (const g of guarded) {
    const x = normPath(g)
    if (x && (x === p || x.startsWith(`${p}\\`))) return tr(M.holdsHome)
  }
  return null
}

/** Hive's test area is offered only to people developing Hive: a dev or test build, or a workspace holding Hive's repository. */
export const testsEligible = (opts: { packaged: boolean; holdsHive: boolean }): boolean => !opts.packaged || opts.holdsHive

/**
 * The workspace's folders from their resolved paths (null: absent, or couldn't be resolved): duplicates dropped, each
 * marked unsafe when it must never be excluded, the root's failure to resolve too (fail closed).
 */
export function folderPlan(input: { root: string | null; rootUnresolved?: string; trees: string | null; tests: string | null }, guarded: string[]): { path: string; kind: AvPathKind; unsafe?: string }[] {
  const out: { path: string; kind: AvPathKind; unsafe?: string }[] = []
  const add = (path: string | null, kind: AvPathKind, unresolved?: string): void => {
    if (unresolved) return void out.push({ path: unresolved, kind, unsafe: tr(M.unresolved) })
    if (!path || out.some((f) => normPath(f.path) === normPath(path))) return
    const unsafe = unsafeFolder(path, guarded)
    out.push({ path, kind, ...(unsafe ? { unsafe } : {}) })
  }
  add(input.root, 'workspace', input.rootUnresolved)
  add(input.trees, 'worktrees')
  add(input.tests, 'tests')
  return out
}

/** What Hive last read with administrator rights: the exclusion list, and each drive's Dev Drive state. */
export interface AdminCheck {
  at: string
  exclusions: string[]
  devDrives?: Record<string, 'trusted' | 'untrusted' | 'no'>
}

/**
 * Hive's exclusions of folders that are gone (#1389), from those it recorded whose folder doesn't exist (`missing`):
 * the workspace's own folders left out; with Defender's list known, only those it lists itself (exact entries: what
 * Remove can take away), else every one, unconfirmed.
 */
export function goneExclusions(missing: string[], folders: { path: string }[], known: string[] | null): AvGone[] {
  const out: AvGone[] = []
  for (const p of missing) {
    if (folders.some((f) => normPath(f.path) === normPath(p)) || out.some((g) => normPath(g.path) === normPath(p))) continue
    if (!known) out.push({ path: p, state: 'added' })
    else if (listed(p, known)) out.push({ path: p, state: 'excluded' })
  }
  return out
}

/**
 * The status of a workspace's folders, from the probe. `added`: the exclusions Hive added; `adminCheck`: what was last
 * read with administrator rights, used while the live list is hidden (and for Dev Drives, which only it can confirm);
 * `missing`: those of `added` whose folder no longer exists.
 */
export function statusOf(workspacePath: string, probe: AvProbe, folders: { path: string; kind: AvPathKind; unsafe?: string }[], opts: { added: string[]; adminCheck?: AdminCheck | null; now: Date; missing?: string[] }): AntivirusStatus {
  const others = (probe.products ?? []).filter((p) => productOn(p.state) && !isDefender(p.name)).map((p) => p.name)
  const d = probe.defender
  // Defender in passive mode (another antivirus is active) or switched off doesn't scan in real time.
  const defenderActive = !!d && d.antivirus && !/passive|edr/i.test(d.mode)
  const scan: AvScan = defenderActive ? 'defender' : others.length ? 'other' : !d && !probe.products ? 'unavailable' : 'none'
  const live = probe.exclusions
  // A kept administrator read counts only if it is a readable list (never Defender's hidden-list answer).
  const admin = !live && opts.adminCheck && readableList(opts.adminCheck.exclusions) ? opts.adminCheck : null
  const known = live ?? admin?.exclusions ?? null
  const added = opts.added.map(normPath)
  const paths: AvPath[] = folders.map((f) => {
    const addedByHive = added.includes(normPath(f.path))
    const state: AvPathState = known ? (covered(f.path, known) ? 'excluded' : 'not-excluded') : addedByHive ? 'added' : 'unknown'
    const drive = driveOf(f.path)
    const checked = drive ? opts.adminCheck?.devDrives?.[drive] : undefined
    const fs = drive ? probe.volumes[drive] : undefined
    const devDrive: AvDevDrive = checked ?? (fs === undefined || fs === null ? 'unknown' : /^refs$/i.test(fs) ? 'refs' : 'no')
    return { path: f.path, kind: f.kind, state, addedByHive, ...(known && listed(f.path, known) ? { listed: true } : {}), devDrive, ...(f.unsafe ? { unsafe: f.unsafe } : {}) }
  })
  const realTime = scan === 'defender' ? d!.realTime : null
  // A trusted Dev Drive in performance mode is scanned lightly; an untrusted one, or performance mode off, is scanned like any other.
  const light = (p: AvPath): boolean => p.devDrive === 'trusted' && probe.performanceMode === true
  const slowedPaths = scan === 'defender' && realTime ? paths.filter((p) => !p.unsafe && p.state !== 'excluded' && p.state !== 'added' && !light(p)) : []
  const gone = scan === 'defender' ? goneExclusions(opts.missing ?? [], folders, known) : []
  return {
    workspacePath,
    scan,
    realTime,
    performanceMode: probe.performanceMode,
    exclusionsFrom: live ? 'live' : admin ? 'admin-check' : null,
    ...(admin ? { adminCheckedAt: admin.at } : {}),
    others,
    paths,
    checkedAt: opts.now.toISOString(),
    slowed: slowedPaths.length > 0,
    offerKey: slowedPaths.map((p) => normPath(p.path)).sort().join('|'),
    ...(gone.length ? { gone } : {})
  }
}

/** Hive's last suggestion for a workspace (#348): the folders it was about, when, and how many times for them. */
export interface AvOffer {
  offerKey: string
  /** For the wording (a reminder from the second) and diagnostics: never a limit. */
  count: number
  /** ISO time. */
  lastAt: string
}

/** A suggestion to show: the status, and which time it is for these folders (1, then reminders). */
export interface AvSuggestion {
  status: AntivirusStatus
  count: number
}

/**
 * The answer to "suggest now?": the suggestion to show, if any, and when a reminder for these folders may come (while
 * what makes scanning matter lasts, the window asks again then): null when nothing would be suggested (declined for
 * good, not slowed).
 */
export interface AvSuggestionReply {
  offer: AvSuggestion | null
  remindAt: string | null
}

/** A reminder for the same folders comes a day after the last suggestion at the earliest. */
export const REMIND_MS = 24 * 60 * 60_000

/** A remembered offer, also #316's form (only the folders' key: suggested once, when not known). Null: none, or not one. */
export function offerOf(v: unknown): AvOffer | null {
  if (typeof v === 'string') return v ? { offerKey: v, count: 1, lastAt: '' } : null
  if (!v || typeof v !== 'object') return null
  const o = v as Partial<AvOffer>
  if (typeof o.offerKey !== 'string' || !o.offerKey) return null
  return { offerKey: o.offerKey, count: typeof o.count === 'number' && o.count >= 1 ? Math.floor(o.count) : 1, lastAt: typeof o.lastAt === 'string' ? o.lastAt : '' }
}

/**
 * Whether to suggest now, for the folders a slowed status is about (`offerKey`, empty when nothing is slowed): the
 * offer to remember, or null. Folders not offered before are suggested at once (a new count); the same folders again
 * only `spacing` after the last time (when that isn't known, now), with no limit: "Don't ask again" is the user's stop.
 */
export function nextOffer(prev: AvOffer | null, offerKey: string, now: Date, spacing = REMIND_MS): AvOffer | null {
  if (!offerKey) return null
  if (!prev || prev.offerKey !== offerKey) return { offerKey, count: 1, lastAt: now.toISOString() }
  const last = Date.parse(prev.lastAt)
  if (Number.isFinite(last) && now.getTime() - last < spacing) return null
  return { offerKey, count: prev.count + 1, lastAt: now.toISOString() }
}

/** When a reminder for these folders may come after `offer` (the last suggestion): null when it was for other folders. */
export function remindAtOf(offer: AvOffer | null, offerKey: string, spacing = REMIND_MS): string | null {
  const last = offer && offerKey && offer.offerKey === offerKey ? Date.parse(offer.lastAt) : NaN
  return Number.isFinite(last) ? new Date(last + spacing).toISOString() : null
}

/** A status with nothing checked: not Windows, a test copy, or the probe failed. */
export function emptyStatus(workspacePath: string, scan: 'not-applicable' | 'test-copy' | 'unavailable', folders: { path: string; kind: AvPathKind; unsafe?: string }[], now: Date, error?: string): AntivirusStatus {
  return {
    workspacePath,
    scan,
    realTime: null,
    performanceMode: null,
    exclusionsFrom: null,
    others: [],
    paths: folders.map((f) => ({ path: f.path, kind: f.kind, state: 'unknown', addedByHive: false, devDrive: 'unknown', ...(f.unsafe ? { unsafe: f.unsafe } : {}) })),
    checkedAt: now.toISOString(),
    ...(error ? { error } : {}),
    slowed: false,
    offerKey: ''
  }
}

/**
 * What an elevated change does: add or remove exclusions, read the list with administrator rights, or move Hive's
 * exclusions from a moved workspace's old folders to its new ones (#1302: remove the old, add the new, in one run).
 */
export type AvAction = 'add' | 'remove' | 'check' | 'move'

export type AvOutcome = 'done' | 'refused' | 'policy' | 'error'

export interface AvChangeResult {
  outcome: AvOutcome
  /** A sentence for the user. */
  message: string
  /** The exclusion list as administrator rights see it after the change, only when it was read (never a guess). */
  exclusions?: string[]
  /** The entries this change added (Add), or removed (Remove), as Defender lists them afterwards. */
  added?: string[]
  removed?: string[]
  /** Each drive's Dev Drive state, read with administrator rights. */
  devDrives?: Record<string, 'trusted' | 'untrusted' | 'no'>
}

/**
 * The outcome of an elevated run. `launch`: whether the elevated PowerShell started (the UAC prompt was accepted);
 * `result`: what it wrote back (untrusted JSON), null if nothing was written. The elevated script reads Defender's
 * list first and asks only for what is needed (`requested`): Add skips a folder an existing exclusion already covers,
 * Remove takes only exact entries that are there.
 */
export function changeOutcome(action: AvAction, launch: { started: boolean; error?: string; cancelled?: boolean }, result: unknown): AvChangeResult {
  if (!launch.started) {
    if (launch.cancelled) return { outcome: 'refused', message: tr(M.declined) }
    return { outcome: 'error', message: tr(M.noPrompt, { hasError: launch.error ? 'yes' : 'no', error: launch.error ?? '' }) }
  }
  const r = obj(result)
  if (!r) return { outcome: 'error', message: tr(M.noReport) }
  // Only a list that was read, and is a list, counts: a missing or malformed one stays unknown.
  const exclusions = r.listed === true ? (readableList(r.exclusions) ?? undefined) : undefined
  const requested = pathList(r.requested) ?? []
  const devDrives: Record<string, 'trusted' | 'untrusted' | 'no'> = {}
  for (const [drive, text] of Object.entries(obj(r.devDrives) ?? {})) {
    const v = devDriveOf(text)
    if (/^[a-z]$/i.test(drive) && v) devDrives[drive.toUpperCase()] = v
  }
  const extra = { ...(exclusions ? { exclusions } : {}), ...(Object.keys(devDrives).length ? { devDrives } : {}) }
  // A move asks for both (#1302): `requested` the new folders to add, `removing` Hive's old entries to take away.
  const removing = action === 'move' ? (pathList(r.removing) ?? []) : action === 'remove' ? requested : []
  const adding = action === 'remove' ? [] : requested
  // What actually changed, as Defender lists it afterwards (unknown when it wasn't read: nothing claimed).
  const added = (action === 'add' || action === 'move') && exclusions ? adding.filter((p) => listed(p, exclusions)) : []
  const removed = (action === 'remove' || action === 'move') && exclusions ? removing.filter((p) => !listed(p, exclusions)) : []
  const changed = { ...(added.length ? { added } : {}), ...(removed.length ? { removed } : {}) }
  if (r.ok !== true) {
    const error = str(r.error) ?? tr(M.unknownError)
    // Organisation-managed machines (group policy, Intune, tamper protection over exclusions) refuse local changes.
    if (/polic|managed|tamper|0x800106ba|access is denied/i.test(error)) return { outcome: 'policy', message: tr(M.policy, { error }), ...extra, ...changed }
    return { outcome: 'error', message: tr(M.refused, { error }), ...extra, ...changed }
  }
  if (!exclusions) return { outcome: 'error', message: tr(M.unreadable), ...extra }
  if (action === 'check') return { outcome: 'done', message: tr(M.checked), ...extra }
  if (action === 'move') {
    const missing = adding.length - added.length + (removing.length - removed.length)
    if (missing) return { outcome: 'policy', message: tr(M.moveNotApplied, { missing }), ...extra, ...changed }
    return { outcome: 'done', message: tr(M.moved, { removed: removed.length, added: added.length }), ...extra, ...changed }
  }
  if (!requested.length) return { outcome: 'done', message: tr(action === 'add' ? M.alreadySkips : M.noneLeft), ...extra }
  const missing = action === 'add' ? requested.length - added.length : requested.length - removed.length
  // A change Defender accepted but doesn't show: a policy keeps local exclusions from applying.
  if (missing) return { outcome: 'policy', message: tr(M.notApplied, { action: action === 'add' ? 'add' : 'remove', missing }), ...extra, ...changed }
  const n = requested.length
  return { outcome: 'done', message: tr(action === 'add' ? M.added : M.removed, { count: n }), ...extra, ...changed }
}

/** The folders' labels, as the status and the offer say them: messages, shown with tr(). */
export const KIND_LABEL: Record<AvPathKind, Msg> = { workspace: M.kindWorkspace, worktrees: M.kindWorktrees, tests: M.kindTests }

/** Microsoft's Dev Drive documentation. */
export const DEV_DRIVE_URL = 'https://learn.microsoft.com/windows/dev-drive/'

/**
 * Defender and a moved workspace (#1302): its old folders (where it and its worktrees were) and its new ones, each with
 * whether Defender skips it, and what Repair would change: Hive's own exclusions of the old folders removed (`remove`,
 * exact entries Hive added) and the new folders that would lose Hive's cover (`add`), in one administrator prompt. Exclusions the user made of the old folders (`theirs`) are only
 * named, never changed. Null fields when Defender isn't the active antivirus: there's nothing to move.
 */
export interface AvMovePlan {
  scan: AvScan
  /** Where the states come from (as the Antivirus panel says it), or null: they need administrator rights to know. */
  exclusionsFrom: 'live' | 'admin-check' | null
  adminCheckedAt?: string
  /** The old folders and the new, by kind: the workspace and its worktrees. */
  old: AvPath[]
  now: AvPath[]
  remove: string[]
  /**
   * The new folders the move may exclude: the safe ones of a kind that had one of Hive's, and any one Hive's removed
   * entries cover now (moved inside the old folder). Candidates, whatever they show now: the elevated run adds only
   * those Defender's live list, once the removals are made, doesn't cover (so an administrator read gone stale, or the
   * old exclusion covering the new folder, never leaves it scanned).
   */
  add: string[]
  theirs: string[]
}

/**
 * The plan from a status read with the old folders among its paths (`oldPaths`, as given: they needn't exist any
 * more). Never broader than Hive's own: only the entries Hive added are removed, and only folders Hive may offer (not
 * unsafe: a drive, a share, the home folder…) are added, and only where Hive's cover would otherwise be lost.
 */
export function defenderMovePlan(status: AntivirusStatus, oldPaths: string[]): AvMovePlan {
  const isOld = (p: AvPath): boolean => oldPaths.some((o) => normPath(o) === normPath(p.path))
  const kinds = (p: AvPath): boolean => p.kind === 'workspace' || p.kind === 'worktrees'
  const old = status.paths.filter((p) => isOld(p) && kinds(p))
  const now = status.paths.filter((p) => !isOld(p) && kinds(p))
  const base = { scan: status.scan, exclusionsFrom: status.exclusionsFrom, ...(status.adminCheckedAt ? { adminCheckedAt: status.adminCheckedAt } : {}), old, now }
  if (status.scan !== 'defender') return { ...base, remove: [], add: [], theirs: [] }
  // Only an entry for the old folder itself is stale: one for a folder holding it (D:\Development) may cover the new
  // folder too, and isn't Hive's to remove nor the user's to be told about. With the list hidden, Hive's own count.
  const mine = old.filter((p) => p.addedByHive && (p.listed || p.state === 'added'))
  const moved = new Set(mine.map((p) => p.kind))
  const remove = mine.map((p) => p.path)
  return {
    ...base,
    remove,
    add: now.filter((p) => !p.unsafe && (moved.has(p.kind) || covered(p.path, remove))).map((p) => p.path),
    theirs: old.filter((p) => !p.addedByHive && p.listed).map((p) => p.path)
  }
}
