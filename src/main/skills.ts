import { join, basename, dirname, extname, relative, resolve, sep } from 'path'
import { mkdir, readFile, rm, writeFile } from 'original-fs/promises'
import { existsSync, type Dirent } from 'original-fs'
import { unzipSync } from 'fflate'
import yaml from 'js-yaml'
import type { ProviderId, SkillAudience, SkillInfo, SkillTarget, WorkspaceConfig } from '../shared/types'
import { allProviders, provider } from './providers'
import { connectionHomes } from './accounts'
import { bundledDir, bundledIds, bundledStatus, restoreBundled } from './bundled'
import { copyDir, COPY_MARKER, isDir, isFile, readDirBounded } from './fsutil'
import { englishText, withValues, type Text, type TextValues } from '../shared/advanced'
import { msg, type Msg } from '../shared/i18n'
import { combworkError } from './combworkError'
import { createLogger } from './logger'
import { headerOf, SKILL_HEAD_MAX } from './revisions'
import { workspace, workspaceOf } from './workspace'
import { trash } from './trash'

const log = createLogger('skills')

/** Combwork's copies of workspace skills in a project folder (Codex's .agents/skills) carry this marker file. */
const OWN_COPY_MARKER = COPY_MARKER

/** What a SKILL.md's header says: its name, description and (Combwork skills) audience, or why it can't be read. */
export interface SkillHeader {
  name?: string
  description?: string
  audience?: SkillAudience
  /**
   * The header is broken (not closed, not YAML, not a mapping) or its audience isn't one Combwork knows. A Combwork skill with a
   * problem is given to nobody until it is fixed, rather than to a recipient Combwork would have to guess.
   */
  problem?: string
  /** `problem` as the window shows it (#849). */
  problemText?: Text
}

/** A header's problem: its English (agents', sessions' and the log's) and its text for the window (#849). */
function problemOf(m: Msg, values?: TextValues): { problem: string; problemText: Text } {
  const text = values ? withValues(m, values) : m
  // agent-stored: agentField says it for each agent where the skill is listed (servers.ts skillRow)
  return { problem: englishText(text), problemText: text }
}

/** Why a Combwork skill's header can't be used (SkillInfo.problem), and the skills' refusals, in the window's language (#849). */
const M = {
  notClosedWithin: msg({ id: 'content.skill.notClosedWithin', defaultMessage: "its header isn't closed within its first {kb} KB", description: "Why nobody gets a Combwork skill: its SKILL.md header (front matter, between --- lines) doesn't end within its first {kb} KB. It follows \"Nobody gets this skill until its header is fixed:\", so it starts in lower case." }),
  notClosed: msg({ id: 'content.skill.notClosed', defaultMessage: "its header isn't closed (no line with --- after it)", description: "Why nobody gets a Combwork skill: its SKILL.md header (front matter) starts with a --- line but no --- line ends it. Keep ---. It starts in lower case (it follows a colon)." }),
  yamlAt: msg({ id: 'content.skill.yamlAt', defaultMessage: "its header isn't valid YAML (line {line}: {reason})", description: "Why nobody gets a Combwork skill: its SKILL.md header can't be read as YAML. {line} is the line of the file, {reason} the YAML reader's own words (English). It starts in lower case (it follows a colon)." }),
  yaml: msg({ id: 'content.skill.yaml', defaultMessage: "its header isn't valid YAML ({reason})", description: "Why nobody gets a Combwork skill: its SKILL.md header can't be read as YAML. {reason} is the YAML reader's own words (English). It starts in lower case (it follows a colon)." }),
  notFields: msg({ id: 'content.skill.notFields', defaultMessage: "its header isn't a list of fields (`name: …`, `description: …`)", description: "Why nobody gets a Combwork skill: its SKILL.md header is YAML but not a set of fields. Keep what is between backticks (`name: …`, `description: …`) as it is, backticks included: they mark YAML. It starts in lower case (it follows a colon)." }),
  metadata: msg({ id: 'content.skill.metadata', defaultMessage: "its metadata isn't a set of fields (`metadata:`, then `audience: …` indented under it)", description: "Why nobody gets a Combwork skill: the metadata field of its SKILL.md header isn't a set of fields. Keep what is between backticks (`metadata:`, `audience: …`) as it is, backticks included: they mark YAML. It starts in lower case (it follows a colon)." }),
  audience: msg({ id: 'content.skill.audience', defaultMessage: '{kind, select, text {its audience is "{audience}", not agents, assistant or all} empty {its audience is empty, not agents, assistant or all} list {its audience is a list, not agents, assistant or all} other {its audience is a {type}, not agents, assistant or all}}', description: "Why nobody gets a Combwork skill: its header's metadata.audience isn't agents, assistant or all (keep those three words, which the header must say). {kind} is what it is instead: text ({audience} is the text), empty, a list, or another YAML value ({type}: number, boolean or object, as YAML names them). It starts in lower case (it follows a colon)." }),
  badName: msg({ id: 'content.skill.badName', defaultMessage: 'Skill names may contain letters, numbers, "-" and "_" (max 64 characters).', description: "An error adding a skill: its name has a character a skill's name can't have, or is too long." })
}

const AUDIENCES: readonly string[] = ['agents', 'assistant', 'all']

/**
 * Reads `name`, `description` and Combwork's `metadata.audience` from a SKILL.md's YAML frontmatter (the Agent Skills
 * format), with a YAML parser (js-yaml, its core schema: plain data, no custom types), so comments, flow mappings,
 * quoting and block scalars mean what YAML says. Only those fields are taken, each only if it has the right type. No
 * audience means the project agents; one that isn't agents, assistant or all is a problem, not a default. `truncated`:
 * the text is only the start of the file (headerOf's cap): a header not closed within it is a problem too.
 */
export function parseSkillFrontmatter(text: string, truncated = false): SkillHeader {
  const body = text.replace(/^﻿/, '')
  if (!/^---\r?\n/.test(body)) return {}
  const m = /^---\r?\n([\s\S]*?)(?:\r?\n)?^---[ \t]*(?:\r?\n|$)/m.exec(body)
  if (!m) return truncated ? problemOf(M.notClosedWithin, { kb: Math.round(SKILL_HEAD_MAX / 1024) }) : problemOf(M.notClosed)
  let data: unknown
  try {
    // Not json mode: a key given twice is an error, not a silent last-one-wins.
    data = yaml.load(m[1], { schema: yaml.CORE_SCHEMA })
  } catch (e) {
    const line = (e as { mark?: { line?: number } }).mark?.line
    const reason = String((e as { reason?: string }).reason ?? (e as Error).message ?? 'unreadable').slice(0, 120) // i18n-ignore: the YAML reader's words, as it gave them
    return line !== undefined ? problemOf(M.yamlAt, { line: line + 2, reason }) : problemOf(M.yaml, { reason })
  }
  if (data === null || data === undefined) return {}
  if (typeof data !== 'object' || Array.isArray(data)) return problemOf(M.notFields)
  const d = data as Record<string, unknown>
  const scalar = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined)
  const out: SkillHeader = {}
  const name = scalar(d.name)
  if (name !== undefined) out.name = name.trim()
  const description = scalar(d.description)
  if (description !== undefined) out.description = description.trim()
  const meta = d.metadata
  if (meta === undefined || meta === null) return out
  if (typeof meta !== 'object' || Array.isArray(meta)) return { ...out, ...problemOf(M.metadata) }
  // Absent: the default. Present but empty (null, ~, nothing after the colon) is an audience Combwork doesn't know.
  if (!Object.hasOwn(meta, 'audience')) return out
  const audience = (meta as Record<string, unknown>).audience
  const a = typeof audience === 'string' ? audience.trim().toLowerCase() : undefined
  if (a === undefined || !AUDIENCES.includes(a)) {
    const kind = typeof audience === 'string' ? 'text' : audience === null ? 'empty' : Array.isArray(audience) ? 'list' : 'other'
    return { ...out, ...problemOf(M.audience, { kind, audience: typeof audience === 'string' ? audience.slice(0, 40) : '', type: typeof audience }) }
  }
  return { ...out, audience: a as SkillAudience }
}

/** Whether a Combwork skill reaches a session: project agents get skills for agents (the default), the Assistant those for it. */
export function skillFor(audience: SkillAudience | undefined, role: 'agent' | 'assistant'): boolean {
  const a = audience ?? 'agents'
  return a === 'all' || (role === 'assistant' ? a === 'assistant' : a === 'agents')
}

/** A description as a YAML scalar: quoted when YAML would read it as something else ("Use for: x", "# notes", a leading quote…). */
function yamlText(text: string): string {
  const plain = text.trim().replace(/\s*\n\s*/g, ' ')
  return /[:#]|^[\s'"&*!|>%@`{[\]-]/.test(plain) ? `"${plain.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : plain
}

/**
 * SKILL.md text named `name`: the frontmatter's name is set to it (the CLIs use it as the skill's name), and
 * a file without frontmatter gets one, since the CLIs only load skills that have a description.
 */
export function skillText(text: string, name: string): string {
  const body = text.replace(/^﻿/, '')
  const m = body.match(/^---\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*\r?\n?/)
  if (!m) {
    const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim()
    const desc = heading && heading.toLowerCase() !== name.toLowerCase() ? heading : 'Describe when the agent should use this skill.' // i18n-ignore: SKILL.md's text, which agents read
    return `---\nname: ${name}\ndescription: ${yamlText(desc)}\n---\n\n${body}`
  }
  const nl = m[0].includes('\r\n') ? '\r\n' : '\n'
  const lines = m[1].split(/\r?\n/)
  const i = lines.findIndex((l) => l.startsWith('name:'))
  if (i >= 0) lines[i] = `name: ${name}`
  else lines.unshift(`name: ${name}`)
  if (!lines.some((l) => l.startsWith('description:'))) lines.push('description: Describe when the agent should use this skill.') // i18n-ignore: SKILL.md's text, which agents read
  return `---${nl}${lines.join(nl)}${nl}---${nl}` + body.slice(m[0].length)
}

async function readSkill(dir: string, level: SkillInfo['level'], plugin?: string): Promise<SkillInfo | null> {
  // Only its header is read (at most SKILL_HEAD_MAX), and only again once the file has changed.
  const fm = await headerOf(join(dir, 'SKILL.md'), parseSkillFrontmatter).catch(() => null)
  if (!fm) return null
  const s: SkillInfo = { name: fm.name || basename(dir), description: fm.description ?? '', level, path: dir, plugin }
  // A Combwork skill whose header can't be read, or whose audience isn't one Combwork knows, has no audience: nobody gets it,
  // and `problem` says why. Other skills only lend their name and description, so a broken header just leaves those out.
  if (level === 'combwork') {
    if (fm.problem) Object.assign(s, { problem: fm.problem }, fm.problemText ? { problemText: fm.problemText } : {})
    else s.audience = fm.audience ?? 'agents'
  }
  return s
}

/** Entries of a skills folder Combwork looks at (the workspace's, a provider's): past this it uses the first it lists, and says so in its log. */
export const MAX_SKILL_FOLDERS = 1000
const warnedFull = new Set<string>()

/** Recursively finds skill folders (containing SKILL.md) under a root, skipping dot-folders. */
async function findSkills(root: string, level: SkillInfo['level'], maxDepth: number): Promise<SkillInfo[]> {
  const out: SkillInfo[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return
    const s = await readSkill(dir, level)
    if (s) {
      out.push(s)
      return
    }
    let entries: Dirent[]
    try {
      entries = (await readDirBounded(dir, MAX_SKILL_FOLDERS)).entries
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') await walk(join(dir, e.name), depth + 1)
    }
  }
  await walk(root, 0)
  return out
}

/**
 * Machine skills read lately, by the homes they were read from (HI-1755: each workspace's connections' own). Entries
 * last 30 seconds and at most MACHINE_CACHE_MAX are kept, the least recently used going first (HI-1782): a set of
 * homes no longer asked for (a connection turned off, a workspace closed) is let go rather than kept until Combwork quits.
 */
const machineCache = new Map<string, { at: number; skills: SkillInfo[] }>()
const MACHINE_CACHE_MS = 30_000
const MACHINE_CACHE_MAX = 8

function pruneMachineCache(now: number): void {
  for (const [key, entry] of machineCache) if (now - entry.at >= MACHINE_CACHE_MS) machineCache.delete(key)
  // A Map iterates in insertion order and a hit is put back last, so the first keys are the least recently used.
  for (const key of machineCache.keys()) {
    if (machineCache.size <= MACHINE_CACHE_MAX) break
    machineCache.delete(key)
  }
}

/** How many sets of homes the machine-skill cache holds (for tests). */
export function machineSkillCacheSize(): number {
  return machineCache.size
}

/**
 * Skills each provider's CLI loads from the user's profile and its installed plugins: for a CLI with connections, those
 * of the connections on in the asking workspace (`cfg`; HI-1755), never another workspace's; else the CLI's own home.
 */
async function machineSkills(cfg: WorkspaceConfig | null): Promise<SkillInfo[]> {
  const homes: [ReturnType<typeof provider>, string | undefined][] = allProviders().flatMap((x) => connectionHomes(x.id, cfg)?.map((h): [typeof x, string | undefined] => [x, h.home]) ?? [[x, undefined]])
  const key = JSON.stringify(homes.map(([p, h]) => [p.id, h ?? '']))
  pruneMachineCache(Date.now())
  const cached = machineCache.get(key)
  if (cached) {
    machineCache.delete(key)
    machineCache.set(key, cached)
    return cached.skills
  }
  const all: SkillInfo[] = []
  for (const [p, home] of homes) {
    const roots = p.skillRoots(home)
    const skills: SkillInfo[] = []
    for (const dir of roots.machine) skills.push(...(await findSkills(dir, 'machine', 4)))
    const pluginSkills = roots.plugins ? await findSkills(roots.plugins, 'plugin', 7) : []
    for (const s of pluginSkills) {
      // .../<plugin>/[<version>/]skills/<skill> → the plugin name is the folder above "skills" (or above the version).
      const parts = relative(roots.plugins!, s.path).split(sep)
      const i = parts.lastIndexOf('skills')
      let plugin = i > 0 ? parts[i - 1] : parts[0]
      if (/^\d+\.\d+/.test(plugin) && i > 1) plugin = parts[i - 2]
      s.plugin = plugin
    }
    const seen = new Set<string>()
    for (const s of [...skills, ...pluginSkills]) {
      const k = `${s.level}:${s.plugin ?? ''}:${s.name}`
      if (seen.has(k)) continue
      seen.add(k)
      all.push({ ...s, provider: p.id })
    }
  }
  machineCache.delete(key)
  machineCache.set(key, { at: Date.now(), skills: all })
  pruneMachineCache(Date.now())
  return all
}

/** Skills that ship with Hive (resources/skills), kept up to date in each workspace (bundled.ts). */
export function bundledSkillsDir(): string {
  return bundledDir('skills')
}

/**
 * The workspace's Combwork skills. `withMissing` adds the bundled skills the workspace doesn't have (for the Skills
 * view); `role` keeps only those for project agents or the Assistant (SKILL.md's metadata.audience).
 */
export async function combworkSkills(withMissing = false, role?: 'agent' | 'assistant'): Promise<SkillInfo[]> {
  if (!workspace.path) return []
  const out: SkillInfo[] = []
  let entries: Dirent[] = []
  try {
    const list = await readDirBounded(workspace.skillsDir, MAX_SKILL_FOLDERS)
    entries = list.entries
    if (list.more && !warnedFull.has(workspace.skillsDir)) {
      warnedFull.add(workspace.skillsDir)
      log.warn(`The workspace's skills folder has more than ${MAX_SKILL_FOLDERS} entries; Combwork uses the first ${MAX_SKILL_FOLDERS} it lists`)
    }
  } catch {
    entries = []
  }
  const bundled = new Set(await bundledIds('skills'))
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    const s = await readSkill(join(workspace.skillsDir, e.name), 'combwork')
    if (!s) continue
    // The folder name is the identity Combwork uses for copies and invocation.
    s.name = e.name
    if (bundled.has(e.name)) Object.assign(s, await bundledStatus('skills', e.name, s.path))
    out.push(s)
  }
  if (withMissing) {
    const have = new Set(out.map((s) => s.name.toLowerCase()))
    for (const name of bundled) {
      if (have.has(name.toLowerCase())) continue
      const s = await readSkill(join(bundledSkillsDir(), name), 'combwork')
      if (s) out.push({ ...s, name, bundled: 'missing' })
    }
  }
  return out.filter((s) => !role || s.bundled === 'missing' || (!s.problem && skillFor(s.audience, role))).sort((a, b) => a.name.localeCompare(b.name))
}

/** The most of a skill's folder skillFiles looks at: files listed, entries (files, folders, links) seen, folder depth. */
export const SKILL_FILES_LIMITS = { files: 200, entries: 2000, depth: 8 }

/**
 * A skill folder's files (relative paths with /, in code-point order), skipping Combwork's copy marker and never
 * following a link. `truncated`: there may be more than `files` (over a limit); each can still be read by its path.
 */
export async function skillFiles(dir: string, lim = SKILL_FILES_LIMITS): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = []
  let seen = 0
  let truncated = false
  const walk = async (rel: string, depth: number): Promise<void> => {
    // Listed a batch at a time, up to what's left of the entries allowed: a huge folder isn't read whole.
    const list = await readDirBounded(rel ? join(dir, rel) : dir, lim.entries - seen).catch(() => ({ entries: [], more: false }))
    seen += list.entries.length
    if (list.more) truncated = true
    for (const e of list.entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (depth < lim.depth) await walk(r, depth + 1)
        else truncated = true
      } else if (e.isFile() && e.name !== COPY_MARKER) files.push(r)
    }
  }
  await walk('', 1)
  files.sort()
  if (files.length > lim.files) {
    truncated = true
    files.length = lim.files
  }
  return { files, truncated }
}

/**
 * A skill's files for its page (HI-2011: SKILL.md and the reference files it links), only for a skill the Skills view
 * or the project's skills tab lists (the workspace's Combwork skills, or `projectPath`'s): any other folder is refused, so
 * the window can't list a folder that isn't a skill it shows. Bounded as skillFiles is, saying when it stopped short.
 */
export async function listedSkillFiles(dir: string, projectPath?: string): Promise<{ files: string[]; truncated: boolean }> {
  const want = resolve(String(dir)).toLowerCase()
  const listed = [...(await combworkSkills(true)), ...(projectPath ? await listSkills(projectPath) : [])]
  if (!listed.some((s) => resolve(s.path).toLowerCase() === want)) throw combworkError(msg({ id: 'content.skill.notListed', defaultMessage: "That folder isn't a skill Combwork lists.", description: "An error listing a skill's files for its page: the folder asked for isn't one of the skills Combwork shows (the workspace's skills or a project's)." }), undefined, { kind: 'forbidden' })
  return skillFiles(dir)
}

/** The folder a provider's project skills are created in (e.g. <project>/.claude/skills): the first it loads them from. */
function localDir(projectPath: string, id: ProviderId): string {
  const rel = provider(id).skillRoots().local[0]
  if (!rel) throw combworkError(msg({ id: 'content.skill.noLocalFolder', defaultMessage: '{cli} has no project skills folder.', description: "An error adding a project's own skill for a coding agent CLI ({cli}: \"Codex\") that reads no skills from a project's folder." }), { cli: provider(id).descriptor.name })
  return join(projectPath, rel)
}

/**
 * Skills in the project's own folders for each provider (e.g. .claude/skills), without Combwork's copies there. A folder
 * several CLIs read (Copilot also reads .claude/skills and .agents/skills) is listed once, for the first provider.
 */
export async function localSkills(projectPath: string): Promise<SkillInfo[]> {
  const out: SkillInfo[] = []
  const seen = new Set<string>()
  for (const p of allProviders()) {
    for (const rel of p.skillRoots().local) {
      const dir = join(projectPath, rel)
      if (seen.has(dir.toLowerCase())) continue
      seen.add(dir.toLowerCase())
      if (!(await isDir(dir))) continue
      for (const s of await findSkills(dir, 'local', 2)) {
        if (existsSync(join(s.path, OWN_COPY_MARKER))) continue
        out.push({ ...s, provider: p.id })
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Every skill: the workspace's Combwork skills, each provider's user and plugin skills, and the project's local skills if given. */
export async function listSkills(projectPath?: string): Promise<SkillInfo[]> {
  // The asking workspace's: the project's, else the current work's (HI-1755: its connections' skills only).
  const ws = projectPath ? workspaceOf(projectPath) : workspace
  const out = [...(await combworkSkills()), ...(await machineSkills(ws.path ? ws.config : null))]
  if (projectPath) out.push(...(await localSkills(projectPath)))
  return out
}

export function invalidateSkillCache(): void {
  machineCache.clear()
}

export function validSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)
}

function assertName(name: string): void {
  if (!validSkillName(name)) throw combworkError(M.badName, undefined, { kind: 'invalid' })
}

function targetDir(target: SkillTarget): string {
  if (target.kind === 'combwork') return workspace.skillsDir
  return localDir(workspace.assertProject(target.projectPath), target.provider)
}

/** Writes one skill (a map of relative paths to contents) into each target; fails before writing if any target has it already. */
async function writeSkill(name: string, files: Map<string, Uint8Array | string>, targets: SkillTarget[]): Promise<SkillInfo> {
  assertName(name)
  if (!targets.length) throw combworkError(msg({ id: 'content.skill.noTarget', defaultMessage: 'No place to add the skill to.', description: 'An error adding a skill with no place chosen for it (the workspace, or a project for a coding agent).' }), undefined, { kind: 'invalid' })
  const dirs = targets.map((t) => join(targetDir(t), name))
  const exists = (d: string): Error => combworkError(msg({ id: 'content.skill.exists', defaultMessage: 'A skill named "{name}" already exists in {folder}', description: 'An error adding a skill: the skills folder {folder} (relative to the workspace) already has one called {name}.' }), { name, folder: relative(workspace.path ?? '', dirname(d)) || dirname(d) }, { kind: 'conflict' })
  for (const d of dirs) if (existsSync(d)) throw exists(d)
  // Each folder is claimed (created, never reused) before anything is written: two adds at once can't share one.
  // If anything fails, the folders claimed so far go again, so a retry isn't blocked by a half-written skill.
  const claimed: string[] = []
  try {
    for (const d of dirs) {
      await mkdir(dirname(d), { recursive: true })
      await mkdir(d).catch((e: NodeJS.ErrnoException) => {
        throw e.code === 'EEXIST' ? exists(d) : e
      })
      claimed.push(d)
    }
    for (const d of dirs) {
      for (const [rel, data] of files) {
        const f = join(d, rel)
        await mkdir(dirname(f), { recursive: true })
        await writeFile(f, data)
      }
    }
  } catch (e) {
    for (const c of claimed) await rm(c, { recursive: true, force: true }).catch(() => undefined)
    throw e
  }
  const s = (await readSkill(dirs[0], targets[0].kind === 'combwork' ? 'combwork' : 'local'))!
  if (targets[0].kind === 'local') s.provider = targets[0].provider
  else s.name = name
  return s
}

/** A new skill with a starter SKILL.md, in the workspace or a project's local folders. */
export async function createSkill(name: string, description: string, targets: SkillTarget[] = [{ kind: 'combwork' }]): Promise<SkillInfo> {
  const desc = yamlText(description || 'Describe when the agent should use this skill.') // i18n-ignore: SKILL.md's text, which agents read
  // i18n-ignore: a new SKILL.md's text, which agents read
  const text = `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\nWrite the instructions the agent should follow when this skill applies.\n`
  return writeSkill(name, new Map([['SKILL.md', text]]), targets)
}

/** Limits for a skill .zip, so a mistaken pick (a big archive) fails quickly instead of filling the disk. */
const ZIP_MAX_FILES = 500
const ZIP_MAX_BYTES = 50 * 1024 * 1024

/**
 * The files of a skill .zip: SKILL.md at its root, or inside a single top folder (which is dropped).
 * Paths that would land outside the skill folder are refused.
 */
export function skillFromZip(data: Uint8Array): { files: Map<string, Uint8Array>; folder: string | null } {
  let total = 0
  const entries = unzipSync(data, {
    filter: (f) => {
      total += f.originalSize
      if (total > ZIP_MAX_BYTES) throw combworkError(msg({ id: 'content.skill.zipTooLarge', defaultMessage: 'The .zip is too large for a skill (over {mb} MB unpacked).', description: 'An error adding a skill from a .zip: its files take more than {mb} MB unpacked.' }), { mb: ZIP_MAX_BYTES / 1024 / 1024 })
      return true
    }
  })
  const names = Object.keys(entries).filter((n) => !n.endsWith('/') && !/(^|\/)(__MACOSX|\.DS_Store)(\/|$)/.test(n))
  if (names.length > ZIP_MAX_FILES) throw combworkError(msg({ id: 'content.skill.zipTooMany', defaultMessage: 'The .zip has too many files for a skill (over {max}).', description: 'An error adding a skill from a .zip: it has more than {max} files.' }), { max: ZIP_MAX_FILES })
  const norm = (n: string): string => n.replace(/\\/g, '/')
  let prefix = ''
  let folder: string | null = null
  if (!names.some((n) => norm(n) === 'SKILL.md')) {
    const tops = new Set(names.map((n) => norm(n).split('/')[0]))
    const top = tops.size === 1 ? [...tops][0] : null
    if (!top || !names.some((n) => norm(n) === `${top}/SKILL.md`)) throw combworkError(msg({ id: 'content.skill.zipNoSkill', defaultMessage: 'No SKILL.md found. A skill .zip has SKILL.md at its top level, or inside one folder.', description: 'An error adding a skill from a .zip that has no SKILL.md where Combwork looks. Keep SKILL.md as it is: it is a file name.' }))
    prefix = `${top}/`
    folder = top
  }
  const files = new Map<string, Uint8Array>()
  for (const n of names) {
    const rel = norm(n).slice(prefix.length)
    if (!rel || rel.split('/').some((p) => p === '..' || p === '') || /^[a-z]:|^\//i.test(rel)) throw combworkError(msg({ id: 'content.skill.zipUnsafe', defaultMessage: 'The .zip has a file with an unsafe path: {path}', description: "An error adding a skill from a .zip: a file's path ({path}) would land outside the skill's folder." }), { path: n })
    files.set(rel, entries[n])
  }
  return { files, folder }
}

/** A name suggested for a skill added from a file: the frontmatter's name, else the folder or file name. */
export async function suggestSkillName(file: string): Promise<string> {
  const clean = (s: string): string => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
  if (extname(file).toLowerCase() === '.zip') {
    const { files, folder } = skillFromZip(await readFile(file))
    const fm = parseSkillFrontmatter(new TextDecoder().decode(files.get('SKILL.md')))
    return clean(fm.name ?? folder ?? basename(file, extname(file)))
  }
  const fm = parseSkillFrontmatter(await readFile(file, 'utf8'))
  const stem = basename(file, extname(file))
  return clean(fm.name ?? (stem.toUpperCase() === 'SKILL' ? basename(dirname(file)) : stem))
}

/** Adds a skill from a .md (becomes its SKILL.md) or a .zip (unpacked as the skill folder). */
export async function addSkillFromFile(file: string, name: string, targets: SkillTarget[]): Promise<SkillInfo> {
  assertName(name)
  const ext = extname(file).toLowerCase()
  let files: Map<string, Uint8Array | string>
  if (ext === '.zip') {
    const zip = skillFromZip(await readFile(file))
    files = zip.files
    files.set('SKILL.md', skillText(new TextDecoder().decode(zip.files.get('SKILL.md')), name))
  } else if (ext === '.md' || ext === '.markdown') {
    files = new Map([['SKILL.md', skillText(await readFile(file, 'utf8'), name)]])
  } else {
    throw combworkError(msg({ id: 'content.skill.chooseFile', defaultMessage: 'Choose a .md file or a .zip.', description: 'An error adding a skill from a file that is neither Markdown (.md) nor a .zip.' }), undefined, { kind: 'invalid' })
  }
  return writeSkill(name, files, targets)
}

/** Whether a folder is a skill Combwork may delete: a Combwork skill in the workspace, or a local skill in a project. */
async function deletableSkill(dir: string): Promise<boolean> {
  if (!workspace.path) return false
  const parent = dirname(resolve(dir)).toLowerCase()
  if (parent === resolve(workspace.skillsDir).toLowerCase()) return true
  for (const project of await workspace.listProjectPaths()) {
    for (const p of allProviders()) {
      if (p.skillRoots().local.some((rel) => parent === resolve(project, rel).toLowerCase())) return true
    }
  }
  return false
}

/** Moves a Combwork or local skill folder to the Recycle Bin. */
export async function deleteSkill(dir: string): Promise<void> {
  if (!(await deletableSkill(dir)) || !existsSync(join(dir, 'SKILL.md'))) throw combworkError(msg({ id: 'content.skill.cantDelete', defaultMessage: "Only Combwork skills and a project's local skills can be deleted in Combwork.", description: "An error deleting a skill Combwork doesn't manage (a CLI's own, from the user's profile or a plugin)." }), undefined, { kind: 'forbidden' })
  if (existsSync(join(dir, OWN_COPY_MARKER))) throw combworkError(msg({ id: 'content.skill.isCopy', defaultMessage: "That's Combwork's own copy of a workspace skill; delete the skill in the workspace instead.", description: "An error deleting a skill in a project's folder that is Combwork's copy of a workspace skill (Combwork puts it there for a coding agent)." }), undefined, { kind: 'forbidden' })
  await trash(dir)
}

/** Puts back a bundled skill as this version of Combwork ships it: the workspace copy (edited) goes to the Recycle Bin. */
export async function restoreBundledSkill(name: string): Promise<SkillInfo> {
  if (!(await bundledIds('skills')).includes(name)) throw combworkError(msg({ id: 'content.skill.notBundled', defaultMessage: '"{name}" isn\'t one of Combwork\'s bundled skills.', description: 'An error restoring a skill Combwork ships: Combwork ships no skill called {name}.' }), { name }, { kind: 'notFound' })
  const dest = join(workspace.skillsDir, name)
  if (existsSync(dest)) await trash(dest)
  await restoreBundled('skills', name)
  const s = (await readSkill(dest, 'combwork'))!
  return { ...s, name, bundled: 'same' }
}

/** Deploys a Local or Machine skill into the workspace so Combwork can manage it. */
export async function copySkillToWorkspace(skillPath: string): Promise<SkillInfo> {
  const name = basename(skillPath)
  if (!validSkillName(name)) throw combworkError(msg({ id: 'content.skill.cantCopyName', defaultMessage: '"{name}" can\'t be a Combwork skill name: use letters, numbers, "-" and "_" (rename the folder first).', description: "An error copying a skill into the workspace: its folder's name {name} can't be a Combwork skill's name." }), { name }, { kind: 'invalid' })
  const dest = join(workspace.skillsDir, name)
  if (existsSync(dest)) throw combworkError(msg({ id: 'content.skill.copyExists', defaultMessage: 'The workspace already has a skill named "{name}"', description: 'An error copying a skill into the workspace: it has one called {name} already.' }), { name }, { kind: 'conflict' })
  if (!(await isFile(join(skillPath, 'SKILL.md')))) throw combworkError(msg({ id: 'content.skill.notSkill', defaultMessage: 'Not a skill folder (no SKILL.md)', description: 'An error copying a skill into the workspace: its folder has no SKILL.md (a file name: keep it).' }))
  await copyDir(skillPath, dest)
  const s = (await readSkill(dest, 'combwork'))!
  s.name = name
  return s
}
