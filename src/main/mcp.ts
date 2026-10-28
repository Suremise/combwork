import { basename, dirname, extname, join } from 'path'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'original-fs/promises'
import { existsSync } from 'original-fs'
import { fmt, tr } from '../shared/i18n'
import { msg } from '../shared/i18n/msg'
import { unzipSync } from 'fflate'
import type { McpFileServer, McpProjectServer, McpServerDef, McpServerInfo, McpShown } from '../shared/types'
import { writeTextUnlessChanged } from './fsutil'
import { HiveError, hiveError } from './hiveError'
import { findSecretWarnings } from './mcpSecrets'
import { allProviders } from './providers'
import { currentWorkspace, inWorkspace, workspace } from './workspace'
import { trash } from './trash'

export { findSecretWarnings }

/** MCP servers' refusals and what a server runs, in the window's language (#849); the Agent API's list reads `error` in English. */
const M = {
  invalidName: msg({ id: 'mcp.error.invalidName', defaultMessage: 'Invalid server name', description: 'An error: an MCP server name Hive refuses.' }),
  badName: msg({ id: 'content.mcp.badName', defaultMessage: 'Server names may contain letters, numbers, "-" and "_" (max 64 characters). "hive" is reserved.', description: 'An error adding an MCP server: its name has a character a server name can\'t have, is too long, or is hive (Hive\'s own server: keep it).' }),
  exists: msg({ id: 'content.mcp.exists', defaultMessage: 'A server named "{name}" already exists', description: 'An error making a new MCP server: the workspace has one called {name}.' }),
  notJson: msg({ id: 'content.mcp.notJson', defaultMessage: "{file} isn't valid JSON ({reason}).", description: "An error adding an MCP server from a file: its definition {file} can't be read as JSON. {reason} is the JSON reader's own words (English)." }),
  runs: msg({ id: 'content.mcp.runs', defaultMessage: 'Runs: {command}', description: 'What an MCP server runs, shown before it is turned on: {command} is its command line, as it is.' }),
  connects: msg({ id: 'content.mcp.connects', defaultMessage: 'Connects to: {url}', description: 'What an MCP server connects to, shown before it is turned on: {url} is its address.' }),
  connectsType: msg({ id: 'content.mcp.connectsType', defaultMessage: 'Connects to: {url} ({type})', description: "What an MCP server connects to, shown before it is turned on: {url} is its address, {type} its transport (http or sse, as the definition says it)." }),
  folder: msg({ id: 'content.mcp.folder', defaultMessage: 'In: {folder}', description: 'The folder an MCP server runs in, shown before it is turned on.' }),
  env: msg({ id: 'content.mcp.env', defaultMessage: 'Environment: {items}', description: "An MCP server's environment variables, shown before it is turned on: {items} lists them, each NAME=${VAR} (a reference, as it is) or \"NAME (set)\"." }),
  headers: msg({ id: 'content.mcp.headers', defaultMessage: 'Headers: {items}', description: "An MCP server's HTTP headers, shown before it is turned on: {items} lists them, each Name=${VAR} (a reference, as it is) or \"Name (set)\"." }),
  set: msg({ id: 'content.mcp.set', defaultMessage: '{name} (set)', description: "An environment variable or header ({name}) an MCP server's definition gives a value of its own, not shown (it may be a secret)." }),
  offInWorkspace: msg({ id: 'mcp.error.offInWorkspace', defaultMessage: '{name} is off in the workspace: turn it on in the MCP view first (it can be turned on for the Hive Assistant there too).', description: 'An error turning an MCP server on for the Hive Assistant: the server is off in the workspace. {name} is the server; "MCP view" is a view in Hive: keep it as Hive shows it.' }),
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

export async function listMcp(): Promise<McpServerInfo[]> {
  if (!workspace.path) return []
  const enabled = new Set(workspace.config.mcp.enabled)
  const assistant = new Set(listed(workspace.config.mcp.assistant))
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
      if (!def || typeof def !== 'object' || Array.isArray(def)) throw hiveError(msg({ id: 'content.mcp.listNotObject', defaultMessage: 'Definition must be a JSON object', description: "Why an MCP server in the workspace can't be used: its definition file (.hive/mcp/<name>.json) holds JSON that isn't an object." }))
      if (!def.command && !def.url) throw hiveError(msg({ id: 'content.mcp.listNoCommand', defaultMessage: 'Definition needs a "command" (stdio) or a "url" (http/sse)', description: "Why an MCP server in the workspace can't be used: its definition has neither of the two fields that say what it is. Keep \"command\", \"url\", stdio, http and sse as they are." }))
      out.push({ name, path, def, revision, globallyEnabled: enabled.has(name), assistant: assistant.has(name), secretWarnings: findSecretWarnings(def), runs: mcpRuns(def) })
    } catch (e) {
      // Hive's own words are text the window shows in its language; JSON's reader's stay as it gave them.
      out.push({ name, path, def: null, error: (e as Error).message, ...(e instanceof HiveError ? { errorText: e.text } : {}), globallyEnabled: enabled.has(name), assistant: assistant.has(name), secretWarnings: [], runs: [] })
    }
  }
  return out
}

/** Converts a stored definition into the entry written to launch/mcp.json. */
export function toLaunchDef(def: McpServerDef, mcpDir: string): McpServerDef {
  const { description: _description, ...rest } = def
  const dir = mcpDir.replace(/\\/g, '/')
  const expand = (v: string): string => v.replace(/\$\{HIVE_MCP_DIR\}/g, dir)
  const out: McpServerDef = { ...rest }
  if (typeof out.command === 'string') out.command = expand(out.command)
  if (Array.isArray(out.args)) out.args = out.args.map((a) => (typeof a === 'string' ? expand(a) : a))
  if (out.env) out.env = Object.fromEntries(Object.entries(out.env).map(([k, v]) => [k, typeof v === 'string' ? expand(v) : v]))
  if (typeof out.cwd === 'string') out.cwd = expand(out.cwd)
  return out
}

/**
 * Adding, replacing and deleting servers and turning them on take turns (#550), so an enable can't land in the
 * middle of a replace and leave the new server on. Callers inside a turn use setGlobalNow.
 */
let mcpTurn: Promise<unknown> = Promise.resolve()
function inTurn<T>(fn: () => Promise<T>): Promise<T> {
  const run = mcpTurn.then(fn)
  mcpTurn = run.catch(() => undefined)
  return run
}

async function setGlobalNow(name: string, enabled: boolean): Promise<void> {
  const set = new Set(workspace.config.mcp.enabled)
  if (enabled) set.add(name)
  else set.delete(name)
  workspace.config.mcp.enabled = [...set].sort()
  await workspace.saveWorkspaceConfig()
}

/** The Hive Assistant's own choice for a server (HI-1472), as a project's: it runs for it while on in the workspace too. */
async function setAssistantNow(name: string, enabled: boolean): Promise<void> {
  await workspace.saveWorkspaceConfigWith((c) => {
    const on = new Set(listed(c.mcp.assistant))
    if (enabled) on.add(name)
    else on.delete(name)
    return { mcp: { ...c.mcp, assistant: [...on].sort() } }
  })
}

/**
 * Refuses when the server's definition is no longer `expected`, the one the user was shown what it runs from (replaced
 * or edited meanwhile), so a server never goes on with a definition the user hasn't seen.
 */
async function checkShown(name: string, expected: McpShown): Promise<void> {
  const path = join(workspace.mcpDir, `${name}.json`)
  // The installation (a replace writes a new file, even with the same text and new code beside it) and the text.
  const revision = await mcpRevision(path)
  const now = await readFile(path, 'utf8').then((t) => JSON.parse(t) as unknown, () => null)
  if (!now || !revision || revision !== expected.revision || JSON.stringify(now) !== JSON.stringify(expected.def)) throw hiveError(msg({ id: 'content.mcp.changed', defaultMessage: '{name} has changed since it was shown to you. Check what it runs and enable it again.', description: 'An error turning an MCP server on: its definition ({name} is the server) changed after Hive showed what it runs, so it stays off until checked again.' }), { name }, { kind: 'conflict' })
}

/**
 * Turns a server on or off in the workspace (#1093, its master switch): it runs in the projects that have it on, and
 * nowhere while off; off keeps the projects' own choices, so on again restores them. Turning it on with `expected`:
 * refused when the definition is no longer the one shown (checkShown). `projects` (path → on, the enable dialog's
 * picks) sets those projects' choices first, in the same turn, and `assistant` the Hive Assistant's (HI-1472).
 */
export function setMcpGlobal(name: string, enabled: boolean, expected?: McpShown, projects: Record<string, boolean> = {}, assistant?: boolean): Promise<void> {
  if (!validMcpName(name)) return Promise.reject(hiveError(M.invalidName))
  return inTurn(async () => {
    if (enabled && !existsSync(join(workspace.mcpDir, `${name}.json`))) throw noServer(name)
    if (enabled && expected) await checkShown(name, expected)
    for (const [p, on] of Object.entries(projects)) {
      const cfg = await workspace.projectConfig(p)
      if (listed(cfg.mcp.enabled).includes(name) !== on) await setProjectNow(p, name, on)
    }
    if (assistant !== undefined && listed(workspace.config.mcp.assistant).includes(name) !== assistant) await setAssistantNow(name, assistant)
    await setGlobalNow(name, enabled)
  })
}

const noServer = (name: string): Error => hiveError(msg({ id: 'mcp.error.noServer', defaultMessage: 'The workspace has no MCP server named {name}.', description: 'An error turning a server on in a project. {name} is its name.' }), { name }, { kind: 'notFound' })

/**
 * Which copy of a server's definition this is: its file's identity, modified time and size. Adding or replacing a
 * server writes a new file, so a replace changes it even when the definition's text is the same (an upgrade of the
 * code beside it); an edit changes it too. Null when there is no such file.
 */
async function mcpRevision(path: string): Promise<string | null> {
  const s = await stat(path, { bigint: true }).catch(() => null)
  return s ? `${s.ino}:${s.mtimeNs}:${s.size}` : null
}

/**
 * Turns a workspace server on or off in one project (#1093): the project's own choice; it runs there while the server
 * is on in the workspace too. Turning it on with `expected`: refused when the definition is no longer the one shown
 * (checkShown).
 */
export function setMcpProject(projectPath: string, name: string, enabled: boolean, expected?: McpShown): Promise<void> {
  if (!validMcpName(name)) return Promise.reject(hiveError(M.invalidName))
  return inTurn(async () => {
    if (enabled && !existsSync(join(workspace.mcpDir, `${name}.json`))) throw noServer(name)
    if (enabled && expected) await checkShown(name, expected)
    await setProjectNow(projectPath, name, enabled)
  })
}

/**
 * Turns a workspace server on or off for the Hive Assistant (HI-1472), its own choice as a project's: it runs for it
 * while the server is on in the workspace too. Turning it on with `expected`: refused when the definition is no longer
 * the one shown (checkShown).
 */
export function setMcpAssistant(name: string, enabled: boolean, expected?: McpShown): Promise<void> {
  if (!validMcpName(name)) return Promise.reject(hiveError(M.invalidName))
  // The workspace asked (its window's, or the Agent API caller's), through every await in the turn.
  const ws = currentWorkspace()
  return inTurn(() =>
    inWorkspace(ws, async () => {
      if (enabled && !existsSync(join(workspace.mcpDir, `${name}.json`))) throw noServer(name)
      // Turned on only where the workspace has it on (its enable shows what it runs and can tick the Assistant too); a
      // choice made before stays while the workspace has it off.
      if (enabled && !listed(workspace.config.mcp.enabled).includes(name)) throw hiveError(M.offInWorkspace, { name }, { kind: 'conflict' })
      if (enabled) await checkShown(name, expected ?? { def: null })
      await setAssistantNow(name, enabled)
    })
  )
}

/** A list from a config file: its names (a hand-edited file may hold anything). */
const listed = (list: unknown): string[] => (Array.isArray(list) ? list.filter((n): n is string => typeof n === 'string') : [])

async function setProjectNow(projectPath: string, name: string, enabled: boolean): Promise<void> {
  await workspace.mutateProjectConfig(projectPath, (cfg) => {
    const on = new Set(listed(cfg.mcp.enabled))
    if (enabled) on.add(name)
    else on.delete(name)
    return { mcp: { ...cfg.mcp, enabled: [...on].sort() } }
  })
}

/**
 * Every project's own choice for a server name goes (hidden projects' too), in a turn: a server added under a name used
 * before (deleted, replaced, or its file removed by hand) starts with no project's choice, so an old switch never turns
 * it on.
 */
async function forgetInProjects(name: string): Promise<void> {
  const paths = [...(await workspace.listProjectPaths()), ...(await workspace.listProjectPaths({ hidden: true }))]
  for (const p of paths) {
    const cfg = await workspace.projectConfig(p).catch(() => null)
    if (!cfg || ![cfg.mcp.enabled, cfg.mcp.disabled].some((l) => listed(l).includes(name))) continue
    await workspace.mutateProjectConfig(p, (c) => ({ mcp: { ...c.mcp, enabled: listed(c.mcp.enabled).filter((n) => n !== name), disabled: listed(c.mcp.disabled).filter((n) => n !== name) } }))
  }
}

/** Off everywhere, in a turn: in the workspace and in each project, whatever an earlier server of the name had. */
async function offEverywhere(name: string): Promise<void> {
  await setGlobalNow(name, false)
  await forgetInProjects(name)
  if (listed(workspace.config.mcp.assistant).includes(name)) await setAssistantNow(name, false)
}

export function validMcpName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name) && name !== 'hive'
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
  // Off everywhere (#1093): a template runs nothing until it is written and turned on.
  return inTurn(async () => {
    if (existsSync(path)) throw hiveError(M.exists, { name }, { kind: 'conflict' })
    await offEverywhere(name)
    await writeFile(path, JSON.stringify(template, null, 2) + '\n', { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
      throw e.code === 'EEXIST' ? hiveError(M.exists, { name }, { kind: 'conflict' }) : e
    })
    return (await listMcp()).find((m) => m.name === name)!
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
  return (await listMcp()).find((m) => m.name === name)!
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
    if (def && existsSync(folder) && usesFolder(def, name)) await trash(folder)
    if (existsSync(file)) await trash(file)
    await offEverywhere(name)
  })
}

/** Whether a definition runs what is in `${HIVE_MCP_DIR}/<folder>/` (its command, arguments, environment or folder). */
function usesFolder(def: McpServerDef, folder: string): boolean {
  return mcpValues(def).some((v) => folderRef(folder).test(v))
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** `${HIVE_MCP_DIR}/<folder>` followed by a slash or the end, either slash, any case (Windows paths). */
const folderRef = (folder: string): RegExp => new RegExp(`\\$\\{HIVE_MCP_DIR\\}[\\\\/]${escapeRe(folder)}(?=[\\\\/]|$|["'\\s])`, 'gi')

/** The strings of a definition that can name its files. */
function mcpValues(def: McpServerDef): string[] {
  return [def.command, def.cwd, ...(Array.isArray(def.args) ? def.args : []), ...Object.values(def.env ?? {})].filter((v): v is string => typeof v === 'string')
}

// ---------------------------------------------------------------------------
// Add MCP Server from File (#550): a .json definition, or a .zip of a server's folder with its definition.
// ---------------------------------------------------------------------------

/** The definition a server .zip carries, the first found: Hive's own name, then the mcp repo's example (USER_GUIDE). */
export const MCP_ZIP_DEFINITIONS = ['hive-mcp.json', 'hive-mcp.example.json']
/** Limits, so a mistaken pick (a big archive) fails quickly instead of filling the disk. */
const MCP_ZIP_MAX_FILES = 5000
const MCP_ZIP_MAX_BYTES = 200 * 1024 * 1024
const MCP_JSON_MAX_BYTES = 1024 * 1024

/** A definition from a file, checked as launches need it, so a broken one is never added. */
export function checkMcpDef(raw: unknown): McpServerDef {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw hiveError(msg({ id: 'content.mcp.notObject', defaultMessage: 'The definition must be a JSON object, as in {path}.', description: "An error adding an MCP server from a file whose definition holds JSON that isn't an object. {path} is where a workspace keeps one (.hive/mcp/<name>.json)." }), { path: '.hive/mcp/<name>.json' })
  const def = raw as McpServerDef
  if (typeof def.command !== 'string' && typeof def.url !== 'string') throw hiveError(msg({ id: 'content.mcp.noCommand', defaultMessage: 'The definition needs a "command" (a server Hive starts) or a "url" (an http or sse server).', description: 'An error adding an MCP server from a file whose definition has neither field that says what it is. Keep "command", "url", http and sse as they are.' }))
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
 * other files, which become .hive/mcp/<name>/. Refused: links, paths that would land outside the folder or that
 * Windows can't hold, too many files or bytes. Nothing in it runs.
 */
export function serverFromZip(data: Uint8Array): { def: McpServerDef; files: Map<string, Uint8Array>; folder: string | null } {
  const links = zipLinks(data)
  if (links.length) throw hiveError(msg({ id: 'content.mcp.zipLink', defaultMessage: "The .zip has a link, which Hive doesn't unpack: {path}", description: 'An error adding an MCP server from a .zip with a symbolic link in it ({path}), which could point outside its folder.' }), { path: links[0] })
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
    if (!top || !found) throw hiveError(msg({ id: 'content.mcp.zipNoDefinition', defaultMessage: 'No {files} found. A server .zip has its definition at its top level, or inside one folder.', description: 'An error adding an MCP server from a .zip without a definition where Hive looks. {files} are the file names it looks for, joined with "or".' }), { files: { list: MCP_ZIP_DEFINITIONS, type: 'disjunction' } })
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
  for (const n of names) if (n !== defEntry) files.set(norm(n).slice(prefix.length), entries[n])
  return { def, files, folder }
}

/** A name for a server from a file: letters, numbers, "-" and "_"; never "hive". */
function serverName(raw: string): string {
  const n = raw.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '').slice(0, 64)
  return n && n.toLowerCase() !== 'hive' ? n : 'server'
}

/** A definition's references to its zip's folder, moved to the name it is added as. */
function retarget(def: McpServerDef, from: string, to: string): McpServerDef {
  if (from === to) return def
  const move = (v: string): string => v.replace(folderRef(from), `\${HIVE_MCP_DIR}/${to}`)
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
    // The mcp repo's hive-mcp.example.json is named after its folder.
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
 * Adds a server from a .json or .zip as `name`, off in the workspace and in every project (#1093): it runs nothing until
 * the workspace turns it on, which shows what it runs first. A name in use is refused unless `replace`, which moves the
 * old definition (and its folder) to the Recycle Bin. Everything is read and checked before anything is written, and
 * the change is one turn with enables (inTurn): an enable waiting meanwhile was for the old definition, so it is refused
 * (setMcpGlobal's expected).
 */
export async function addMcpFromFile(file: string, name: string, replace = false): Promise<McpServerInfo> {
  if (!validMcpName(name)) throw hiveError(M.badName, undefined, { kind: 'invalid' })
  const r = await readServerFile(file)
  const def = r.folder ? retarget(r.def, r.folder, name) : r.def
  const taken = (): Error => hiveError(msg({ id: 'content.mcp.taken', defaultMessage: 'A server named "{name}" already exists: choose another name, or replace it.', description: 'An error adding an MCP server from a file under the name {name}, which a server of the workspace has.' }), { name }, { kind: 'conflict' })
  return inTurn(async () => {
    const dir = workspace.mcpDir
    const json = join(dir, `${name}.json`)
    const folder = join(dir, name)
    if (serverExists(name, !!r.files) && !replace) throw taken()
    await mkdir(dir, { recursive: true })
    // Off before it exists: a name enabled earlier (the old server, or a definition deleted by hand) mustn't turn it on,
    // for all projects or in one.
    await offEverywhere(name)
    if (replace) {
      // A .zip brings its own folder; a .json keeps the one there (its definition may run what is in it).
      if (r.files && existsSync(folder)) await trash(folder)
      if (existsSync(json)) await trash(json)
    }
    // The folder is claimed (created, never reused: two adds at once can't share one) and written in place, since the
    // workspace's watcher holds the folders under .hive, so Windows refuses to rename one into place. If anything
    // fails, what was written goes again, so a retry isn't blocked.
    let claimed = false
    try {
      if (r.files) {
        await mkdir(folder).catch((e: NodeJS.ErrnoException) => {
          throw e.code === 'EEXIST' ? taken() : e
        })
        claimed = true
        for (const [rel, data] of r.files) {
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
    return (await listMcp()).find((m) => m.name === name)!
  })
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
 * Copies servers defined in a project's own config (.mcp.json…) into the workspace, each turned on in the workspace and
 * in that project only (#713, #1093: added from the project, it is on there straight away; the copy's dialog showed
 * what it runs) when it is still the definition the user was shown (`shown`, by name); one changed meanwhile, or not
 * shown, is copied turned off. Returns the names copied and those on.
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
      await offEverywhere(n)
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
        await setProjectNow(projectPath, n, true)
        await setGlobalNow(n, true)
        on.push(n)
      }
    })
  }
  return { copied, on }
}
