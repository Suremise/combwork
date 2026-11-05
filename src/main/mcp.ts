import { isReservedServerName } from '../shared/assistantTools'
import { basename, dirname, extname, join } from 'path'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'original-fs/promises'
import { existsSync } from 'original-fs'
import { fmt, tr } from '../shared/i18n'
import { msg } from '../shared/i18n/msg'
import { unzipSync } from 'fflate'
import type { McpFileServer, McpPlacesResult, McpProjectServer, McpServerDef, McpServerInfo, McpShown, ProjectConfig } from '../shared/types'
import { writeTextUnlessChanged } from './fsutil'
import { HiveError, hiveError } from './hiveError'
import { findSecretWarnings } from './mcpSecrets'
import { allProviders } from './providers'
import { assistantMcpAdded, MCP_ADDED_MODEL, mcpAdded, mcpNames } from '../shared/agentMcp'
import { randomUUID } from 'crypto'
import { currentWorkspace, inWorkspace, workspace, type WorkspaceService } from './workspace'
import { trash } from './trash'
import { CW_DIR } from '../shared/defaults'

export { findSecretWarnings }

/** MCP servers' refusals and what a server runs, in the window's language (#849); the Agent API's list reads `error` in English. */
const M = {
  invalidName: msg({ id: 'mcp.error.invalidName', defaultMessage: 'Invalid server name', description: 'An error: an MCP server name Combwork refuses.' }),
  badName: msg({ id: 'content.mcp.badName', defaultMessage: 'Server names may contain letters, numbers, "-" and "_" (max 64 characters). "combwork" is reserved.', description: 'An error adding an MCP server: its name has a character a server name can\'t have, is too long, or is combwork (Combwork\'s own server: keep it as it is).' }),
  exists: msg({ id: 'content.mcp.exists', defaultMessage: 'A server named "{name}" already exists', description: 'An error making a new MCP server: the workspace has one called {name}.' }),
  notJson: msg({ id: 'content.mcp.notJson', defaultMessage: "{file} isn't valid JSON ({reason}).", description: "An error adding an MCP server from a file: its definition {file} can't be read as JSON. {reason} is the JSON reader's own words (English)." }),
  runs: msg({ id: 'content.mcp.runs', defaultMessage: 'Runs: {command}', description: 'What an MCP server runs, shown before it is turned on: {command} is its command line, as it is.' }),
  connects: msg({ id: 'content.mcp.connects', defaultMessage: 'Connects to: {url}', description: 'What an MCP server connects to, shown before it is turned on: {url} is its address.' }),
  connectsType: msg({ id: 'content.mcp.connectsType', defaultMessage: 'Connects to: {url} ({type})', description: "What an MCP server connects to, shown before it is turned on: {url} is its address, {type} its transport (http or sse, as the definition says it)." }),
  folder: msg({ id: 'content.mcp.folder', defaultMessage: 'In: {folder}', description: 'The folder an MCP server runs in, shown before it is turned on.' }),
  env: msg({ id: 'content.mcp.env', defaultMessage: 'Environment: {items}', description: "An MCP server's environment variables, shown before it is turned on: {items} lists them, each NAME=${VAR} (a reference, as it is) or \"NAME (set)\"." }),
  headers: msg({ id: 'content.mcp.headers', defaultMessage: 'Headers: {items}', description: "An MCP server's HTTP headers, shown before it is turned on: {items} lists them, each Name=${VAR} (a reference, as it is) or \"Name (set)\"." }),
  set: msg({ id: 'content.mcp.set', defaultMessage: '{name} (set)', description: "An environment variable or header ({name}) an MCP server's definition gives a value of its own, not shown (it may be a secret)." }),
  zipLarge: msg({ id: 'content.mcp.zipLarge', defaultMessage: 'The .zip is too large for an MCP server (over {mb} MB unpacked).', description: 'An error adding an MCP server from a .zip: its files take more than {mb} MB unpacked.' })
}

/** A whole `${VAR}` reference, shown as itself: what it holds comes from the environment when the server starts. */
const ENV_REF = /^\$\{[^}]+\}$/

/**
 * What a server runs, as lines to show before it is enabled (#550): the command and its arguments, or the URL it
 * connects to, its folder, and its environment variables and headers by name (a `${VAR}` reference shown as itself,
 * never a literal value).
 */
export function mcpRuns(def: McpServerDef): string[] {
  const quoted = (a: string): string => (/[\s"]/.test(a) || !a ? JSON.stringify(a) : a)
  const out: string[] = []
  if (typeof def.command === 'string') out.push(tr(M.runs, { command: [def.command, ...(Array.isArray(def.args) ? def.args : [])].map((a) => quoted(String(a))).join(' ') }))
  if (typeof def.url === 'string') out.push(typeof def.type === 'string' ? tr(M.connectsType, { url: def.url, type: def.type }) : tr(M.connects, { url: def.url }))
  if (typeof def.cwd === 'string') out.push(tr(M.folder, { folder: def.cwd }))
  const named = (label: typeof M.env | typeof M.headers, rec: unknown): void => {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return
    const items = Object.entries(rec as Record<string, unknown>).map(([k, v]) => (typeof v === 'string' && ENV_REF.test(v.trim()) ? `${k}=${v.trim()}` : tr(M.set, { name: k })))
    if (items.length) out.push(tr(label, { items: fmt.list(items, 'unit') }))
  }
  named(M.env, def.env)
  named(M.headers, def.headers)
  return out
}

/**
 * The workspace's servers. `places`: each with where it is added (HI-2059: the projects, hidden ones too, and the
 * Assistant), for the window; without, `projects` is empty and `assistant` still says the Assistant's (a launch's read).
 */
export async function listMcp(places = false): Promise<McpServerInfo[]> {
  if (!workspace.path) return []
  const where = places ? await addedPlaces() : null
  const assistant = new Set(where?.assistant ?? assistantMcpAdded(workspace.config.mcp))
  const projectsOf = (name: string): string[] => (where ? [...where.projects].filter(([, added]) => added.includes(name)).map(([p]) => p) : [])
  let files: string[] = []
  try {
    files = (await readdir(workspace.mcpDir)).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  const out: McpServerInfo[] = []
  for (const f of files.sort()) {
    const name = f.slice(0, -5)
    const path = join(workspace.mcpDir, f)
    try {
      // Before the text: a revision never stands for newer text than what is shown.
      const revision = (await mcpRevision(path)) ?? undefined
      const def = JSON.parse(await readFile(path, 'utf8')) as McpServerDef
      if (!def || typeof def !== 'object' || Array.isArray(def)) throw hiveError(msg({ id: 'content.mcp.listNotObject', defaultMessage: 'Definition must be a JSON object', description: "Why an MCP server in the workspace can't be used: its definition file (.combwork/mcp/<name>.json) holds JSON that isn't an object." }))
      if (!def.command && !def.url) throw hiveError(msg({ id: 'content.mcp.listNoCommand', defaultMessage: 'Definition needs a "command" (stdio) or a "url" (http/sse)', description: "Why an MCP server in the workspace can't be used: its definition has neither of the two fields that say what it is. Keep \"command\", \"url\", stdio, http and sse as they are." }))
      out.push({ name, path, def, revision, projects: projectsOf(name), assistant: assistant.has(name), secretWarnings: findSecretWarnings(def), runs: mcpRuns(def) })
    } catch (e) {
      // Hive's own words are text the window shows in its language; JSON's reader's stay as it gave them.
      out.push({ name, path, def: null, error: (e as Error).message, ...(e instanceof HiveError ? { errorText: e.text } : {}), projects: projectsOf(name), assistant: assistant.has(name), secretWarnings: [], runs: [] })
    }
  }
  return out
}

/**
 * The variable a definition points at the workspace's MCP folder with (HI-2503): `${CW_MCP_DIR}`, the only one read
 * (HI-2594). The names upgrade converts definitions stored before 1.1 (nameUpgradeFiles.ts).
 */
export const MCP_DIR_VAR = '${CW_MCP_DIR}'
const MCP_DIR_VARIABLE = /\$\{CW_MCP_DIR\}/g

/** Converts a stored definition into the entry written to launch/mcp.json. */
export function toLaunchDef(def: McpServerDef, mcpDir: string): McpServerDef {
  // Hive's own fields (its description and tags, HI-2059, and the catalogue it came from, HI-545) aren't the CLIs'.
  const { description: _description, tags: _tags, catalog: _catalog, ...rest } = def
  const dir = mcpDir.replace(/\\/g, '/')
  const expand = (v: string): string => v.replace(MCP_DIR_VARIABLE, () => dir)
  const out: McpServerDef = { ...rest }
  if (typeof out.command === 'string') out.command = expand(out.command)
  if (Array.isArray(out.args)) out.args = out.args.map((a) => (typeof a === 'string' ? expand(a) : a))
  if (out.env) out.env = Object.fromEntries(Object.entries(out.env).map(([k, v]) => [k, typeof v === 'string' ? expand(v) : v]))
  if (typeof out.cwd === 'string') out.cwd = expand(out.cwd)
  return out
}

/**
 * Adding, replacing and deleting servers and adding them to projects take turns (#550, HI-2059), so an Add can't land
 * in the middle of a replace and leave the new server added. Callers inside a turn use the *Now functions.
 */
let mcpTurn: Promise<unknown> = Promise.resolve()
export function inTurn<T>(fn: () => Promise<T>): Promise<T> {
  const run = mcpTurn.then(fn)
  mcpTurn = run.catch(() => undefined)
  return run
}

/** workspace.json's #1093 switch, frozen at HI-2059's upgrade: read for projects not yet converted (mcpAdded), never written. */
const legacyOn = (): unknown => workspace.config.mcp.enabled

/** Where a server is added (HI-2059): a project, by path, or the Hive Assistant. */
export type McpTarget = { project: string } | 'assistant'

/**
 * A project's added servers changed (HI-2059), in one locked write: worked out from what runs there now (mcpAdded), so a
 * project not yet converted is converted in the same write and a remembered choice its workspace had off never comes
 * back with it. Only `mcp` changes: whatever else changed meanwhile is kept.
 */
async function changeProjectNow(projectPath: string, change: (added: string[]) => string[]): Promise<void> {
  // A project's file that is there: never one made for a folder gone meanwhile.
  await workspace.mutateProjectConfig(projectPath, (cfg) => ({ mcp: { ...cfg.mcp, enabled: [...new Set(change(mcpAdded(cfg.mcp, legacyOn())))].sort(), model: MCP_ADDED_MODEL } }), { existing: true })
}

/** One of this workspace's projects as it is now (not hidden, its folder there): its path. */
function projectHere(p: string): string {
  const path = workspace.assertProject(p)
  if (!existsSync(join(path, CW_DIR, 'project.json'))) throw hiveError(msg({ id: 'mcp.error.noProject', defaultMessage: '{project} is no longer a project in this workspace.', description: 'An error adding an MCP server to a project, or removing it (HI-2059): the project was removed or moved meanwhile. {project} is its folder name.' }), { project: basename(path) }, { kind: 'notFound' })
  return path
}

/** The Hive Assistant's added servers changed (HI-2059), as a project's (changeProjectNow), in workspace.json. */
async function changeAssistantNow(change: (added: string[]) => string[]): Promise<void> {
  await workspace.saveWorkspaceConfigWith((c) => ({ mcp: { ...c.mcp, assistant: [...new Set(change(assistantMcpAdded(c.mcp)))].sort(), assistantModel: MCP_ADDED_MODEL } }))
}

/** A target's added servers changed; a project is checked to be this workspace's as it is now. */
async function changeTargetNow(target: McpTarget, change: (added: string[]) => string[]): Promise<void> {
  if (target === 'assistant') await changeAssistantNow(change)
  else await changeProjectNow(projectHere(target.project), change)
}

/** What runs where it is added, as the definition is now: refused when it isn't a usable server. */
const usable = (def: unknown): def is McpServerDef => !!def && typeof def === 'object' && !Array.isArray(def) && (typeof (def as McpServerDef).command === 'string' || typeof (def as McpServerDef).url === 'string')

/**
 * Refuses when the server's definition is no longer `expected`, the one the user was shown what it runs from (replaced
 * or edited meanwhile), or isn't one Hive can run, so a server is never added with a definition the user hasn't seen.
 */
export async function checkShown(name: string, expected: McpShown): Promise<void> {
  const path = join(workspace.mcpDir, `${name}.json`)
  // The installation (a replace writes a new file, even with the same text and new code beside it) and the text.
  const revision = await mcpRevision(path)
  const now = await readFile(path, 'utf8').then((t) => JSON.parse(t) as unknown, () => null)
  if (!usable(now) || !revision || revision !== expected.revision || JSON.stringify(now) !== JSON.stringify(expected.def)) throw hiveError(msg({ id: 'content.mcp.changedAdd', defaultMessage: '{name} has changed since it was shown to you. Check what it runs and add it again.', description: 'An error adding an MCP server to a project or the Combwork Assistant: its definition ({name} is the server) changed after Combwork showed what it runs, so it is not added until checked again.' }), { name }, { kind: 'conflict' })
}

const noServer = (name: string): Error => hiveError(msg({ id: 'mcp.error.noServerAdd', defaultMessage: 'The workspace has no MCP server named {name}.', description: 'An error adding a server to a project or the Combwork Assistant. {name} is its name.' }), { name }, { kind: 'notFound' })

/**
 * Adds a workspace server to a project or the Hive Assistant (HI-2059): it runs there from their next session. In a turn
 * with the server's other changes; refused when the target isn't this workspace's, or the definition is no longer
 * `expected`, the one shown (checkShown).
 */
export function addMcpTo(target: McpTarget, name: string, expected: McpShown): Promise<void> {
  if (!validMcpName(name)) return Promise.reject(hiveError(M.invalidName))
  // The workspace asked (its window's, or the Agent API caller's), through every await in the turn.
  const ws = currentWorkspace()
  return inTurn(() =>
    inWorkspace(ws, async () => {
      if (target !== 'assistant') projectHere(target.project)
      if (!existsSync(join(workspace.mcpDir, `${name}.json`))) throw noServer(name)
      await checkShown(name, expected)
      await changeTargetNow(target, (added) => [...added, name])
    })
  )
}

/** Removes a server from a project or the Hive Assistant (HI-2059): it no longer runs there, from their next session. */
export function removeMcpFrom(target: McpTarget, name: string): Promise<void> {
  if (!validMcpName(name)) return Promise.reject(hiveError(M.invalidName))
  const ws = currentWorkspace()
  return inTurn(() => inWorkspace(ws, () => changeTargetNow(target, (added) => added.filter((n) => n !== name))))
}

/**
 * Add to… (the MCP view, HI-2059): the server added to the places ticked and removed from the others listed (`projects`,
 * path → added; `assistant`, unless left out). Every place it changes is checked before the first write (this workspace's
 * project, its settings readable; the definition the one shown when it adds anywhere); then one write per place, each
 * checked again as it is made. Files are written one by one, so a failure midway leaves the earlier ones written: the
 * result says which changed and which failed.
 */
export function setMcpPlaces(name: string, expected: McpShown | undefined, projects: Record<string, boolean>, assistant?: boolean): Promise<McpPlacesResult> {
  if (!validMcpName(name)) return Promise.reject(hiveError(M.invalidName))
  const ws = currentWorkspace()
  return inTurn(() =>
    inWorkspace(ws, async () => {
      const changes: { place: string; target: McpTarget; add: boolean }[] = []
      for (const [p, add] of Object.entries(projects)) {
        const path = projectHere(p)
        if (mcpAdded((await workspace.projectConfig(path)).mcp, legacyOn()).includes(name) !== add) changes.push({ place: path, target: { project: path }, add })
      }
      if (assistant !== undefined && assistantMcpAdded(workspace.config.mcp).includes(name) !== assistant) changes.push({ place: 'assistant', target: 'assistant', add: assistant })
      if (changes.some((c) => c.add)) {
        if (!existsSync(join(workspace.mcpDir, `${name}.json`))) throw noServer(name)
        await checkShown(name, expected ?? { def: null })
      }
      const out: McpPlacesResult = { added: [], removed: [], failed: [] }
      for (const c of changes) {
        try {
          await changeTargetNow(c.target, (added) => (c.add ? [...added, name] : added.filter((n) => n !== name)))
          ;(c.add ? out.added : out.removed).push(c.place)
        } catch (e) {
          out.failed.push({ place: c.place, error: e instanceof Error ? e.message : String(e) })
        }
      }
      return out
    })
  )
}

/**
 * Which copy of a server's definition this is: its file's identity, modified time and size. Adding or replacing a
 * server writes a new file, so a replace changes it even when the definition's text is the same (an upgrade of the
 * code beside it); an edit changes it too. Null when there is no such file.
 */
export async function mcpRevision(path: string): Promise<string | null> {
  const s = await stat(path, { bigint: true }).catch(() => null)
  return s ? `${s.ino}:${s.mtimeNs}:${s.size}` : null
}

const listed = mcpNames

/**
 * Says once, quietly, in the workspace's window, that converting to added servers (HI-2059) dropped choices kept for
 * servers the workspace had off: nothing that ran changed, and those servers are added where they're needed.
 */
export async function sayMcpAddedOnce(ws: WorkspaceService): Promise<void> {
  const n = ws.config.mcp.droppedNotice
  if (!n) return
  const title = tr(msg({ id: 'service.mcp.addedTitle', defaultMessage: 'MCP servers are now added where they run', description: "A quiet notice's title, once after the upgrade that made a workspace's MCP servers added to projects and the Combwork Assistant, in place of switches." }))
  const message = tr(msg({ id: 'service.mcp.addedDropped', defaultMessage: 'Each project and the Assistant lists the servers that ran there. {n, plural, one {# choice kept for a server that was off in the workspace was} other {# choices kept for servers that were off in the workspace were}} dropped: add a server in a project’s MCP tab where you need it.', description: "A quiet notice once after the upgrade that made MCP servers added to projects and the Combwork Assistant: nothing that ran changed; {n} choices remembered for servers the workspace had switched off were not carried over. \"MCP tab\" as Combwork names it." }), { n })
  ws.emit({ type: 'toast', toast: { id: randomUUID(), level: 'info', title, message, timestamp: new Date().toISOString(), quiet: true } })
  await inWorkspace(ws, () => ws.saveWorkspaceConfigWith((c) => ({ mcp: { ...c.mcp, droppedNotice: undefined } })))
}

/** Every project, hidden ones too. */
async function allProjectPaths(): Promise<string[]> {
  return [...(await workspace.listProjectPaths()), ...(await workspace.listProjectPaths({ hidden: true }))]
}

/**
 * A project's MCP lists as its file has them now, or null when it has no project.json. One that can't be read or
 * parsed is an error, never "no servers" (HI-2059 rounds 1 and 2): with no master switch, a membership left behind
 * would add a new definition under the old name. So it is read strictly, from the current file's own text: never the
 * kept-file reader's last good copy or default, which stands in for a file still being saved.
 */
async function membershipOf(projectPath: string, name: string): Promise<ProjectConfig['mcp'] | null> {
  const file = join(projectPath, CW_DIR, 'project.json')
  const unreadable = (e: unknown): Error => hiveError(msg({ id: 'mcp.error.cannotClear', defaultMessage: "Couldn't read the settings of {project}, so {name} wasn't changed: it may still be added there. Try again once the project can be read.", description: 'An error replacing, creating or deleting an MCP server (HI-2059): a project\'s settings file could not be read, so Combwork could not make sure the server is removed there, and changed nothing. {project} is the project\'s folder name, {name} the server.' }), { project: basename(projectPath), name }, { kind: 'conflict', cause: e })
  const exists = await stat(file).then(
    () => true,
    (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return false
      throw unreadable(e)
    }
  )
  if (!exists) return null
  // The current text decides, read before anything that might put a kept copy in its place: a file that doesn't parse
  // as an object (one partway through a save) is uncertainty. Then Hive's own read must succeed too.
  const text = await readFile(file, 'utf8').catch((e) => {
    throw unreadable(e)
  })
  let now: unknown
  try {
    now = JSON.parse(text)
  } catch (e) {
    throw unreadable(e)
  }
  if (!now || typeof now !== 'object' || Array.isArray(now)) throw unreadable(new Error('project.json is not an object')) // i18n-ignore: the cause kept with the error, for the log
  await workspace.projectConfig(projectPath).catch((e) => {
    throw unreadable(e)
  })
  const mcp = (now as { mcp?: unknown }).mcp
  const lists = mcp && typeof mcp === 'object' && !Array.isArray(mcp) ? (mcp as Record<string, unknown>) : {}
  return { enabled: listed(lists.enabled), disabled: listed(lists.disabled), ...(lists.model === MCP_ADDED_MODEL ? { model: MCP_ADDED_MODEL } : {}) }
}

/**
 * Removed everywhere it is added or remembered, in a turn (HI-2059): every project (hidden ones too) and the Hive
 * Assistant, so a server added under a name used before (deleted, replaced, or its file removed by hand) starts added
 * nowhere. Every project is read first: one that can't be read refuses it before anything is written (HI-2059 round 1),
 * so the caller changes no definition. A project changed here is converted in the same write (changeProjectNow), so no
 * other remembered choice comes back with it.
 */
async function removeEverywhere(name: string): Promise<void> {
  const listing: string[] = []
  for (const p of await allProjectPaths()) {
    const cfg = await membershipOf(p, name)
    if (cfg && [cfg.enabled, cfg.disabled].some((l) => listed(l).includes(name))) listing.push(p)
  }
  for (const p of listing) await workspace.mutateProjectConfig(p, (c) => ({ mcp: { ...c.mcp, enabled: mcpAdded(c.mcp, legacyOn()).filter((n) => n !== name), disabled: listed(c.mcp.disabled).filter((n) => n !== name), model: MCP_ADDED_MODEL } }), { existing: true })
  if (listed(workspace.config.mcp.assistant).includes(name)) await changeAssistantNow((added) => added.filter((n) => n !== name))
}

/**
 * Where a server is added now (HI-545's update), read strictly (membershipOf: a project that can't be read is an error,
 * never "not added"): the projects' paths (hidden ones too, sorted) and whether the Assistant has it. In the caller's turn.
 */
export async function placesNow(name: string): Promise<{ projects: string[]; assistant: boolean }> {
  const projects: string[] = []
  for (const p of await allProjectPaths()) {
    const cfg = await membershipOf(p, name)
    if (cfg && mcpAdded(cfg, legacyOn()).includes(name)) projects.push(p)
  }
  return { projects: projects.sort(), assistant: assistantMcpAdded(workspace.config.mcp).includes(name) }
}

/** The places a server is added (HI-2059): the projects' paths (hidden ones too) and whether the Assistant has it. */
async function addedPlaces(): Promise<{ projects: Map<string, string[]>; assistant: string[] }> {
  const projects = new Map<string, string[]>()
  for (const p of await allProjectPaths()) {
    const cfg = await workspace.projectConfig(p).catch(() => null)
    if (cfg) projects.set(p, mcpAdded(cfg.mcp, legacyOn()))
  }
  return { projects, assistant: assistantMcpAdded(workspace.config.mcp) }
}

export function validMcpName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name) && !isReservedServerName(name)
}

export async function createMcp(name: string): Promise<McpServerInfo> {
  if (!validMcpName(name)) throw hiveError(M.badName, undefined, { kind: 'invalid' })
  const path = join(workspace.mcpDir, `${name}.json`)
  const template: McpServerDef = {
    description: 'Describe what this server provides.', // i18n-ignore: a new definition file's text
    command: 'npx',
    args: ['-y', 'your-mcp-server-package'],
    env: { EXAMPLE_TOKEN: '${EXAMPLE_TOKEN}' }
  }
  // Added nowhere (HI-2059): a template runs nothing until it is written and added.
  return inTurn(async () => {
    if (existsSync(path)) throw hiveError(M.exists, { name }, { kind: 'conflict' })
    await removeEverywhere(name)
    await writeFile(path, JSON.stringify(template, null, 2) + '\n', { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
      throw e.code === 'EEXIST' ? hiveError(M.exists, { name }, { kind: 'conflict' }) : e
    })
    return (await listMcp(true)).find((m) => m.name === name)!
  })
}

export async function readMcp(name: string): Promise<string> {
  if (!validMcpName(name)) throw hiveError(M.invalidName)
  return readFile(join(workspace.mcpDir, `${name}.json`), 'utf8')
}

export async function saveMcp(name: string, text: string, expected?: string): Promise<McpServerInfo> {
  if (!validMcpName(name)) throw hiveError(M.invalidName)
  JSON.parse(text) // throws a useful message on invalid JSON
  await writeTextUnlessChanged(join(workspace.mcpDir, `${name}.json`), text.endsWith('\n') ? text : text + '\n', expected)
  return (await listMcp(true)).find((m) => m.name === name)!
}

export async function deleteMcp(name: string): Promise<void> {
  if (!validMcpName(name)) throw hiveError(M.invalidName)
  return inTurn(async () => {
    // To the Recycle Bin, like files, skills, modes and sessions.
    const file = join(workspace.mcpDir, `${name}.json`)
    // Its folder too, when its definition runs what is in it (a server added from a .zip, #550). A definition that
    // can't be read as one (broken JSON, not an object) says nothing about a folder: only the file goes.
    const folder = join(workspace.mcpDir, name)
    const def = await readFile(file, 'utf8').then(
      (t) => {
        try {
          const d = JSON.parse(t) as unknown
          return d && typeof d === 'object' && !Array.isArray(d) ? (d as McpServerDef) : null
        } catch {
          return null
        }
      },
      () => null
    )
    // Removed everywhere first (HI-2059 round 1): refused there, the server is kept as it was.
    await removeEverywhere(name)
    if (def && existsSync(folder) && usesFolder(def, name)) await trash(folder)
    if (existsSync(file)) await trash(file)
  })
}

/** Whether a definition runs what is in `${CW_MCP_DIR}/<folder>/` (its command, arguments, environment or folder). */
function usesFolder(def: McpServerDef, folder: string): boolean {
  return mcpValues(def).some((v) => folderRef(folder).test(v))
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** `${CW_MCP_DIR}/<folder>` followed by a slash or the end, either slash, any case (Windows paths). */
const folderRef = (folder: string): RegExp => new RegExp(`\\$\\{CW_MCP_DIR\\}[\\\\/]${escapeRe(folder)}(?=[\\\\/]|$|["'\\s])`, 'gi')

/** The strings of a definition that can name its files. */
function mcpValues(def: McpServerDef): string[] {
  return [def.command, def.cwd, ...(Array.isArray(def.args) ? def.args : []), ...Object.values(def.env ?? {})].filter((v): v is string => typeof v === 'string')
}

// ---------------------------------------------------------------------------
// Add MCP Server from File (#550): a .json definition, or a .zip of a server's folder with its definition.
// ---------------------------------------------------------------------------

/**
 * The definition a server .zip carries, the first found: Combwork's own name, then the mcp repo's example (USER_GUIDE).
 * The other beside the one read is a definition too, never copied into the server's folder.
 */
export const MCP_ZIP_DEFINITIONS = ['combwork-mcp.json', 'combwork-mcp.example.json']
/** The names a refusal suggests. */
const MCP_ZIP_DEFINITIONS_SHOWN = MCP_ZIP_DEFINITIONS
/** Limits, so a mistaken pick (a big archive) fails quickly instead of filling the disk. */
const MCP_ZIP_MAX_FILES = 5000
const MCP_ZIP_MAX_BYTES = 200 * 1024 * 1024
const MCP_JSON_MAX_BYTES = 1024 * 1024

/** A definition from a file, checked as launches need it, so a broken one is never added. */
export function checkMcpDef(raw: unknown): McpServerDef {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw hiveError(msg({ id: 'content.mcp.notObject', defaultMessage: 'The definition must be a JSON object, as in {path}.', description: "An error adding an MCP server from a file whose definition holds JSON that isn't an object. {path} is where a workspace keeps one (.combwork/mcp/<name>.json)." }), { path: '.combwork/mcp/<name>.json' })
  const def = raw as McpServerDef
  if (typeof def.command !== 'string' && typeof def.url !== 'string') throw hiveError(msg({ id: 'content.mcp.noCommand', defaultMessage: 'The definition needs a "command" (a server Combwork starts) or a "url" (an http or sse server).', description: 'An error adding an MCP server from a file whose definition has neither field that says what it is. Keep "command", "url", http and sse as they are.' }))
  if (def.command !== undefined && (typeof def.command !== 'string' || !def.command.trim())) throw hiveError(msg({ id: 'content.mcp.badCommand', defaultMessage: '"command" must be the program to run.', description: 'An error adding an MCP server from a file: its definition\'s "command" field (keep it as it is) is empty or not text.' }))
  if (def.url !== undefined && (typeof def.url !== 'string' || !/^https?:\/\//i.test(def.url))) throw hiveError(msg({ id: 'content.mcp.badUrl', defaultMessage: '"url" must be an http:// or https:// address.', description: 'An error adding an MCP server from a file: its definition\'s "url" field (keep it as it is) isn\'t a web address.' }))
  if (def.args !== undefined && (!Array.isArray(def.args) || def.args.some((a) => typeof a !== 'string'))) throw hiveError(msg({ id: 'content.mcp.badArgs', defaultMessage: '"args" must be a list of strings.', description: 'An error adding an MCP server from a file: its definition\'s "args" field (keep it as it is) isn\'t a list of text.' }))
  for (const k of ['env', 'headers'] as const) {
    const v = def[k]
    if (v !== undefined && (!v || typeof v !== 'object' || Array.isArray(v) || Object.values(v).some((x) => typeof x !== 'string'))) throw hiveError(msg({ id: 'content.mcp.badRecord', defaultMessage: '"{field}" must be an object of strings.', description: 'An error adding an MCP server from a file: its definition\'s {field} field (env or headers, as it is) isn\'t a set of names with text values.' }), { field: k })
  }
  if (def.cwd !== undefined && typeof def.cwd !== 'string') throw hiveError(msg({ id: 'content.mcp.badCwd', defaultMessage: '"cwd" must be a folder.', description: 'An error adding an MCP server from a file: its definition\'s "cwd" field (keep it as it is) isn\'t text.' }))
  return def
}

/** Characters and names Windows can't have in a path part, and parts that leave the folder. */
function unsafePart(p: string): boolean {
  return !p || p === '.' || p === '..' || /[<>:"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p)
}

/** The names of a zip's entries that are symbolic links (a Unix mode in its central directory): one could point outside. */
export function zipLinks(data: Uint8Array): string[] {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let end = -1
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      end = i
      break
    }
  }
  if (end < 0) throw hiveError(msg({ id: 'content.mcp.zipUnreadable', defaultMessage: "The .zip can't be read: it has no list of its files.", description: "An error adding an MCP server from a .zip that isn't one (no central directory: the list of its files)." }))
  const count = v.getUint16(end + 10, true)
  let at = v.getUint32(end + 16, true)
  const links: string[] = []
  for (let n = 0; n < count && at + 46 <= data.length && v.getUint32(at, true) === 0x02014b50; n++) {
    const nameLength = v.getUint16(at + 28, true)
    // Made on Unix (3), with the file type in the high half of its attributes: a link (0o120000).
    if (v.getUint8(at + 5) === 3 && ((v.getUint32(at + 38, true) >>> 16) & 0o170000) === 0o120000) links.push(new TextDecoder().decode(data.subarray(at + 46, at + 46 + nameLength)))
    at += 46 + nameLength + v.getUint16(at + 30, true) + v.getUint16(at + 32, true)
  }
  return links
}

/**
 * A server .zip: its definition (MCP_ZIP_DEFINITIONS) at the top, or inside one folder (which is dropped), and the
 * other files, which become .combwork/mcp/<name>/. Refused: links, paths that would land outside the folder or that
 * Windows can't hold, too many files or bytes. Nothing in it runs.
 */
export function serverFromZip(data: Uint8Array): { def: McpServerDef; files: Map<string, Uint8Array>; folder: string | null } {
  const links = zipLinks(data)
  if (links.length) throw hiveError(msg({ id: 'content.mcp.zipLink', defaultMessage: "The .zip has a link, which Combwork doesn't unpack: {path}", description: 'An error adding an MCP server from a .zip with a symbolic link in it ({path}), which could point outside its folder.' }), { path: links[0] })
  let total = 0
  const entries = unzipSync(data, {
    filter: (f) => {
      total += f.originalSize
      if (total > MCP_ZIP_MAX_BYTES) throw hiveError(M.zipLarge, { mb: MCP_ZIP_MAX_BYTES / 1024 / 1024 })
      return true
    }
  })
  const norm = (n: string): string => n.replace(/\\/g, '/')
  const names = Object.keys(entries).filter((n) => !norm(n).endsWith('/') && !/(^|\/)(__MACOSX|\.DS_Store)(\/|$)/.test(norm(n)))
  if (names.length > MCP_ZIP_MAX_FILES) throw hiveError(msg({ id: 'content.mcp.zipTooMany', defaultMessage: 'The .zip has too many files for an MCP server (over {max, number}).', description: 'An error adding an MCP server from a .zip with more than {max} files.' }), { max: MCP_ZIP_MAX_FILES })
  for (const n of names) {
    const rel = norm(n)
    if (/^[a-z]:|^\//i.test(rel) || rel.split('/').some(unsafePart)) throw hiveError(msg({ id: 'content.mcp.zipUnsafe', defaultMessage: 'The .zip has a file with an unsafe path: {path}', description: "An error adding an MCP server from a .zip: a file's path ({path}) would land outside its folder, or Windows can't have it." }), { path: n })
  }
  const at = (prefix: string): string | undefined => MCP_ZIP_DEFINITIONS.map((d) => prefix + d).find((d) => names.some((n) => norm(n) === d))
  let prefix = ''
  let folder: string | null = null
  let found = at('')
  if (!found) {
    const tops = new Set(names.map((n) => norm(n).split('/')[0]))
    const top = tops.size === 1 ? [...tops][0] : null
    found = top ? at(`${top}/`) : undefined
    if (!top || !found) throw hiveError(msg({ id: 'content.mcp.zipNoDefinition', defaultMessage: 'No {files} found. A server .zip has its definition at its top level, or inside one folder.', description: 'An error adding an MCP server from a .zip without a definition where Combwork looks. {files} are the file names it looks for, joined with "or".' }), { files: { list: MCP_ZIP_DEFINITIONS_SHOWN, type: 'disjunction' } })
    prefix = `${top}/`
    folder = top
  }
  const defEntry = names.find((n) => norm(n) === found)!
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder().decode(entries[defEntry]))
  } catch (e) {
    throw hiveError(M.notJson, { file: found, reason: (e as Error).message }, { cause: e })
  }
  const def = checkMcpDef(raw)
  const files = new Map<string, Uint8Array>()
  // A zip carrying the definition under both names (the mcp repo's move to Combwork's, HI-2503) copies neither.
  const definitions = new Set(MCP_ZIP_DEFINITIONS.map((d) => prefix + d))
  for (const n of names) if (!definitions.has(norm(n))) files.set(norm(n).slice(prefix.length), entries[n])
  return { def, files, folder }
}

/** A name for a server from a file: letters, numbers, "-" and "_"; never "combwork". */
function serverName(raw: string): string {
  const n = raw.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '').slice(0, 64)
  return n && !isReservedServerName(n) ? n : 'server'
}

/** A definition's references to its zip's folder, moved to the name it is added as. */
export function retarget(def: McpServerDef, from: string, to: string): McpServerDef {
  if (from === to) return def
  const move = (v: string): string => v.replace(folderRef(from), () => `${MCP_DIR_VAR}/${to}`)
  const out: McpServerDef = { ...def }
  if (typeof out.command === 'string') out.command = move(out.command)
  if (typeof out.cwd === 'string') out.cwd = move(out.cwd)
  if (Array.isArray(out.args)) out.args = out.args.map(move)
  if (out.env) out.env = Object.fromEntries(Object.entries(out.env).map(([k, v]) => [k, move(v)]))
  return out
}

/** A server's file read once and checked: its definition, and for a .zip its files and folder. */
async function readServerFile(file: string): Promise<{ def: McpServerDef; files: Map<string, Uint8Array> | null; folder: string | null; name: string }> {
  const ext = extname(file).toLowerCase()
  if (ext !== '.json' && ext !== '.zip') throw hiveError(msg({ id: 'content.mcp.chooseFile', defaultMessage: 'Choose a .json definition or a .zip of a server folder.', description: 'An error adding an MCP server from a file that is neither a .json definition nor a .zip.' }), undefined, { kind: 'invalid' })
  const max = ext === '.json' ? MCP_JSON_MAX_BYTES : MCP_ZIP_MAX_BYTES
  const tooLarge = (): Error =>
    ext === '.json'
      ? hiveError(msg({ id: 'content.mcp.jsonLarge', defaultMessage: 'The .json is too large for an MCP server definition (over {mb} MB).', description: 'An error adding an MCP server from a .json file over {mb} MB.' }), { mb: MCP_JSON_MAX_BYTES / 1024 / 1024 })
      : hiveError(msg({ id: 'content.mcp.zipFileLarge', defaultMessage: 'The .zip is too large for an MCP server (over {mb} MB).', description: 'An error adding an MCP server from a .zip file over {mb} MB.' }), { mb: MCP_ZIP_MAX_BYTES / 1024 / 1024 })
  if ((await stat(file)).size > max) throw tooLarge()
  const data = await readFile(file)
  // The stat is a snapshot: a file that grew after it is held to the limit by the bytes read.
  if (data.length > max) throw tooLarge()
  if (ext === '.json') {
    let raw: unknown
    try {
      raw = JSON.parse(data.toString('utf8'))
    } catch (e) {
      throw hiveError(M.notJson, { file: basename(file), reason: (e as Error).message }, { cause: e })
    }
    const stem = basename(file, ext)
    // The mcp repo's combwork-mcp.example.json is named after its folder.
    const name = MCP_ZIP_DEFINITIONS.includes(basename(file).toLowerCase()) ? basename(dirname(file)) : stem
    return { def: checkMcpDef(raw), files: null, folder: null, name: serverName(name) }
  }
  const z = serverFromZip(data)
  // A zip with its files at the top: their folder is named after the zip.
  const folder = z.folder ?? basename(file, ext)
  return { ...z, folder, name: serverName(folder) }
}

/** What adding a file would add (the dialog shows it first): its name, what it runs, and whether the name is taken. */
export async function previewMcpFile(file: string): Promise<McpFileServer> {
  const r = await readServerFile(file)
  const def = r.folder ? retarget(r.def, r.folder, r.name) : r.def
  return { name: r.name, def, runs: mcpRuns(def), secretWarnings: findSecretWarnings(def), files: r.files?.size ?? 0, exists: serverExists(r.name, !!r.files) }
}

/** A server named so: its definition, or (for a .zip) its folder. */
function serverExists(name: string, folder: boolean): boolean {
  return existsSync(join(workspace.mcpDir, `${name}.json`)) || (folder && existsSync(join(workspace.mcpDir, name)))
}

/**
 * Adds a server from a .json or .zip as `name`, added nowhere (HI-2059): it runs nothing until it is added to a project
 * or the Assistant, which shows what it runs first. A name in use is refused unless `replace`, which moves the
 * old definition (and its folder) to the Recycle Bin. Everything is read and checked before anything is written, and
 * the change is one turn with Adds (inTurn): an Add waiting meanwhile was for the old definition, so it is refused
 * (addMcpTo's expected).
 */
export async function addMcpFromFile(file: string, name: string, replace = false): Promise<McpServerInfo> {
  if (!validMcpName(name)) throw hiveError(M.badName, undefined, { kind: 'invalid' })
  const r = await readServerFile(file)
  const def = r.folder ? retarget(r.def, r.folder, name) : r.def
  return inTurn(() => writeServerNow(name, def, r.files, replace))
}

/**
 * Writes a server's definition (and a .zip's folder) as `name`, in a turn (the caller's). A name in use is refused
 * unless `replace`, which moves the old definition (and, when this one brings a folder, the old folder) to the Recycle
 * Bin. Without `keepPlaces` it is removed everywhere first (HI-2059: added nowhere, refused while a project can't be
 * read); with it (a catalogue update whose places were just checked, HI-545), the places keep it. Returns the server
 * as listed.
 */
export async function writeServerNow(name: string, def: McpServerDef, files: Map<string, Uint8Array> | null, replace: boolean, keepPlaces = false): Promise<McpServerInfo> {
  const taken = (): Error => hiveError(msg({ id: 'content.mcp.taken', defaultMessage: 'A server named "{name}" already exists: choose another name, or replace it.', description: 'An error adding an MCP server from a file under the name {name}, which a server of the workspace has.' }), { name }, { kind: 'conflict' })
  const dir = workspace.mcpDir
  const json = join(dir, `${name}.json`)
  const folder = join(dir, name)
  if (serverExists(name, !!files) && !replace) throw taken()
  await mkdir(dir, { recursive: true })
  // Removed everywhere before it exists: a name added earlier (the old server, or a definition deleted by hand) mustn't
  // add it anywhere.
  if (!keepPlaces) await removeEverywhere(name)
  if (replace) {
    // A .zip brings its own folder; a .json keeps the one there (its definition may run what is in it).
    if (files && existsSync(folder)) await trash(folder)
    if (existsSync(json)) await trash(json)
  }
  // The folder is claimed (created, never reused: two adds at once can't share one) and written in place, since the
  // workspace's watcher holds the folders under .combwork, so Windows refuses to rename one into place. If anything
  // fails, what was written goes again, so a retry isn't blocked.
  let claimed = false
  try {
    if (files) {
      await mkdir(folder).catch((e: NodeJS.ErrnoException) => {
        throw e.code === 'EEXIST' ? taken() : e
      })
      claimed = true
      for (const [rel, data] of files) {
        const to = join(folder, ...rel.split('/'))
        await mkdir(dirname(to), { recursive: true })
        await writeFile(to, data, { flag: 'wx' })
      }
    }
    await writeFile(json, JSON.stringify(def, null, 2) + '\n', { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
      throw e.code === 'EEXIST' ? taken() : e
    })
  } catch (e) {
    if (claimed) await rm(folder, { recursive: true, force: true }).catch(() => undefined)
    throw e
  }
  return (await listMcp(true)).find((m) => m.name === name)!
}

/** The servers a project defines in its own config (.mcp.json…), the first provider's where two name one. */
async function projectDefs(projectPath: string): Promise<Record<string, McpServerDef>> {
  const defs: Record<string, McpServerDef> = {}
  for (const p of allProviders()) {
    for (const [n, d] of Object.entries(await p.projectMcpServers(projectPath).catch(() => ({})))) defs[n] ??= d
  }
  return defs
}

/** The servers a project defines in its own config that the workspace hasn't got, with what each runs: what copying them adds. */
export async function projectMcpServers(projectPath: string): Promise<McpProjectServer[]> {
  return Object.entries(await projectDefs(projectPath))
    .filter(([n]) => validMcpName(n) && !existsSync(join(workspace.mcpDir, `${n}.json`)))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, def]) => ({ name, def, runs: mcpRuns(def), secretWarnings: findSecretWarnings(def) }))
}

/**
 * Copies servers defined in a project's own config (.mcp.json…) into the workspace, each added to that project only
 * (#713, HI-2059: copied from the project, it runs there straight away; the copy's dialog showed what it runs) when it
 * is still the definition the user was shown (`shown`, by name); one changed meanwhile, or not shown, is copied added
 * nowhere. Returns the names copied and those added.
 */
export async function importFromProject(projectPath: string, names: string[], shown: Record<string, McpServerDef> = {}): Promise<{ copied: string[]; on: string[] }> {
  const defs = await projectDefs(projectPath)
  const copied: string[] = []
  const on: string[] = []
  for (const n of names) {
    const def = defs[n]
    if (!def || !validMcpName(n)) continue
    const path = join(workspace.mcpDir, `${n}.json`)
    await inTurn(async () => {
      if (existsSync(path)) return
      // A name used before starts with no project's choice.
      await removeEverywhere(n)
      // Never over one that appeared meanwhile.
      // i18n-ignore: the definition file's text (a description the CLIs drop)
      const wrote = await writeFile(path, JSON.stringify({ description: `Imported from project ${basename(projectPath)}`, ...def }, null, 2) + '\n', { flag: 'wx' }).then(
        () => true,
        (e: NodeJS.ErrnoException) => {
          if (e.code === 'EEXIST') return false
          throw e
        }
      )
      if (!wrote) return
      copied.push(n)
      if (shown[n] && JSON.stringify(shown[n]) === JSON.stringify(def)) {
        await changeProjectNow(projectPath, (added) => [...added, n])
        on.push(n)
      }
    })
  }
  return { copied, on }
}
