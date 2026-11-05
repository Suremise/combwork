import { existsSync } from 'original-fs'
import { mkdir, readdir, readFile, writeFile } from 'original-fs/promises'
import { basename, join } from 'path'
import { DEFAULT_MODE, newModeText, parseMode, modeId } from '../shared/assistant'
import type { AssistantControl, ModeInfo } from '../shared/types'
import { controlRules } from '../shared/hiveGuidance'
import { msg } from '../shared/i18n'
import { hiveError } from './hiveError'
import { bundledDir, bundledStatus, restoreBundled } from './bundled'
import { workspace } from './workspace'
import { trash } from './trash'

/**
 * The Combwork Assistant's modes: Markdown files in the workspace's .combwork/modes (a header with name,
 * description and icon, then the character and focus). Hive ships four (resources/modes), kept up to date in
 * each workspace like the bundled skills (bundled.ts).
 */

export function bundledModesDir(): string {
  return bundledDir('modes')
}

const validId = (id: string): boolean => /^[a-z0-9][a-z0-9-]{0,63}$/.test(id)

async function mdIds(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.md') && validId(f.slice(0, -3))).map((f) => f.slice(0, -3))
  } catch {
    return []
  }
}

async function info(path: string, id: string): Promise<ModeInfo> {
  const p = parseMode(await readFile(path, 'utf8').catch(() => ''))
  return { id, name: p.name || id, description: p.description ?? '', icon: p.icon ?? '', path }
}

/** The workspace's modes, then the bundled ones it doesn't have (greyed out, with Restore). */
export async function listModes(): Promise<ModeInfo[]> {
  if (!workspace.path) return []
  const bundled = new Set(await mdIds(bundledModesDir()))
  const out: ModeInfo[] = []
  for (const id of await mdIds(workspace.modesDir)) {
    const p = await info(join(workspace.modesDir, `${id}.md`), id)
    if (bundled.has(id)) Object.assign(p, await bundledStatus('modes', id, p.path))
    out.push(p)
  }
  for (const id of bundled) if (!out.some((p) => p.id === id)) out.push({ ...(await info(join(bundledModesDir(), `${id}.md`), id)), bundled: 'missing' })
  // The default first, then by name.
  return out.sort((a, b) => Number(b.id === DEFAULT_MODE) - Number(a.id === DEFAULT_MODE) || a.name.localeCompare(b.name))
}

export async function createMode(name: string): Promise<ModeInfo> {
  const id = modeId(name)
  if (!validId(id)) throw hiveError(msg({ id: 'content.mode.badName', defaultMessage: 'Give the mode a name with letters or numbers.', description: "An error making a new mode for the Combwork Assistant: its name has no letters or numbers to name its file after." }), undefined, { kind: 'invalid' })
  const path = join(workspace.modesDir, `${id}.md`)
  if (existsSync(path)) throw hiveError(msg({ id: 'content.mode.exists', defaultMessage: 'There is already a mode called "{mode}".', description: "An error making a new mode for the Combwork Assistant: the workspace already has one called {mode}." }), { mode: id }, { kind: 'conflict' })
  await mkdir(workspace.modesDir, { recursive: true })
  await writeFile(path, newModeText(name.trim()), { flag: 'wx' })
  return info(path, id)
}

/** Moves a mode's file to the Recycle Bin. */
export async function deleteMode(id: string): Promise<void> {
  if (!validId(id)) throw hiveError(msg({ id: 'content.mode.invalid', defaultMessage: 'Invalid mode', description: "An error deleting a mode of the Combwork Assistant: its id isn't one Combwork could have made." }), undefined, { kind: 'invalid' })
  const path = join(workspace.modesDir, `${id}.md`)
  if (existsSync(path)) await trash(path)
}

/** Puts back a bundled mode as this version of Hive ships it; the workspace's copy goes to the Recycle Bin. */
export async function restoreMode(id: string): Promise<ModeInfo> {
  const src = join(bundledModesDir(), `${id}.md`)
  if (!validId(id) || !existsSync(src)) throw hiveError(msg({ id: 'content.mode.notBundled', defaultMessage: '"{mode}" isn\'t one of Combwork\'s modes.', description: "An error restoring a mode Hive ships: Hive ships no mode called {mode}." }), { mode: id }, { kind: 'notFound' })
  const dest = join(workspace.modesDir, `${id}.md`)
  if (existsSync(dest)) await trash(dest)
  await restoreBundled('modes', id)
  return { ...(await info(dest, id)), bundled: 'same' }
}

/** A mode's name, summary and instructions: the workspace's file, else Hive's copy, else none. */
export async function readMode(id: string): Promise<{ id: string; name: string; summary?: string; body: string } | null> {
  if (!validId(id)) return null
  for (const dir of [workspace.modesDir, bundledModesDir()]) {
    const text = await readFile(join(dir, `${id}.md`), 'utf8').catch(() => null)
    if (text === null) continue
    const p = parseMode(text)
    return { id, name: p.name || id, ...(p.summary ? { summary: p.summary } : {}), body: p.body }
  }
  return null
}

/**
 * What the Assistant is told at launch, after Hive's session contract (hiveInstructions): who it is, the workspace,
 * what Control lets it do, and then its mode's character and focus. A mode can't change what it may do.
 */
export async function assistantInstructions(modeIdValue: string, control: AssistantControl = 'projects', changeSettings = false): Promise<{ text: string; mode: string; modeId: string; modeText: string }> {
  const ws = workspace.path ?? ''
  const projects = (await workspace.listProjectPaths()).map((p) => basename(p))
  const mode = (await readMode(modeIdValue)) ?? (await readMode(DEFAULT_MODE))
  const modeText = mode ? `# Your mode: ${mode.name}\n\n${mode.body}` : '' // i18n-ignore: the Assistant's instructions (agent-facing)
  const text = [
    `You are the Combwork Assistant: the overseer of the workspace "${basename(ws)}" (${ws}), in Combwork's side panel. The user talks to you here while coding agents work in its projects (at launch: ${projects.length ? projects.join(', ') : 'none yet'}). You work in the workspace folder, so you can read any project's files; agents, cards, notes and usage come from the combwork tools.`,
    controlRules(control, changeSettings),
    "Nothing wakes you except the user, your own tool calls returning, and a watch you started (cw_wait_for_agents or cw_wait_for_tasks with wake): never say you'll check again later unless a wait or a watch is running, and if you stop waiting, say so.",
    'Be brief. Your mode (below) says what to put first and how to hand things back; it never changes what you may do: only these rules do.',
    'The user picks your mode (and can switch it while you run: Combwork then tells you). When a request clearly fits another mode better, suggest switching in one short line; never switch or insist.',
    '',
    modeText
  ].join('\n')
  // The mode ends the text: a launch measures it as the mode, the rest as the Assistant's role.
  return { text, mode: mode?.name ?? '', modeId: mode?.id ?? '', modeText }
}
