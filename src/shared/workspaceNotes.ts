import { agentMsg, say } from './agentText'
import { utf8Bytes } from './metrics'

/**
 * Workspace notes (#1433, #873, SPEC §16.10.7): one shared note per workspace for what is true of this machine (a
 * full-path command, a local tool's version), which no committed file should hold. It lives in the workspace's
 * git-excluded `.combwork/shared`, and Combwork delivers it inline at each launch, after the session contract, to every agent
 * on every CLI, in whichever folder it works (a slot, a worktree, the project folder): a git-ignored file in the project
 * reaches only some of them. A `## <project name>` section is that project's alone; the rest is everyone's.
 */

/** The note's path in `.combwork/shared` (as the notes tools and the Agent API name it). */
export const WORKSPACE_NOTES_PATH = 'Workspace notes.md' // i18n-ignore: a file name, the same in every language

/** The note's file in a workspace (Windows paths, as the window names a shared note's file). */
export const workspaceNotesPath = (workspacePath: string): string => `${workspacePath.replace(/[\\/]+$/, '')}\\.combwork\\shared\\${WORKSPACE_NOTES_PATH}`

/** The note's name in agents' text: the shared note they read for the rest of a cut note (its file's name, never translated). */
const NOTE_NAME = WORKSPACE_NOTES_PATH.replace(/\.md$/, '')

/** How much of the note an agent gets at most, by default (Settings → Advanced, cw.notes.workspaceNotesMax). */
export const WORKSPACE_NOTES_MAX = 4096

const N = {
  header: agentMsg({ id: 'contract.notes.header', text: 'Workspace notes (this machine), from the shared note "{note}":', note: "The line above the Workspace notes a launch delivers (#1433). note: the shared note's name." }),
  cut: agentMsg({ id: 'contract.notes.cut', text: '(cut: read the shared note {note} for the rest)', note: "Ends Workspace notes cut at their limit (Settings → Advanced, cw.notes.workspaceNotesMax). note: the shared note's name." })
}

/** A heading that starts a section (`#` or `##`, outside a code block), and its text. */
const heading = (line: string): string | null => /^ {0,3}#{1,2}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line)?.[1] ?? null

/**
 * The part of the note one project's agents get: everything outside the projects' sections, and its own section
 * (`## <name>`, its name as the workspace lists it, any case). With `project` null (the Combwork Assistant), the whole note.
 * A heading that names no project of the workspace is everyone's.
 */
export function notesFor(text: string, project: string | null, projects: readonly string[]): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (project === null) return lines.join('\n').trim()
  const names = new Set(projects.map((p) => p.toLowerCase()))
  const mine = project.toLowerCase()
  const out: string[] = []
  let owner: string | null = null
  // The code block a line is in (Markdown's fences: three or more backticks or tildes, up to three spaces in; closed
  // only by the same character, at least as many, with nothing after), so a heading inside one is its text.
  let fence: { char: string; length: number } | null = null
  for (const line of lines) {
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    let h: string | null = null
    if (fence) {
      if (f && f[1][0] === fence.char && f[1].length >= fence.length && !f[2].trim()) fence = null
    } else if (f && !(f[1][0] === '`' && f[2].includes('`'))) fence = { char: f[1][0], length: f[1].length }
    else h = heading(line)
    if (h !== null) owner = names.has(h.toLowerCase()) ? h.toLowerCase() : null
    if (owner === null || owner === mine) out.push(line)
  }
  return out.join('\n').trim()
}

/**
 * What a launch's instructions get of the note: its part for the project under a header, bounded at `max` bytes (UTF-8,
 * header included). Over it, the part is cut at a line where it can be (else mid-line, never mid-character) and ends with
 * a pointer to the note. Empty: nothing is delivered.
 */
export function deliveredNotes(part: string, max: number = WORKSPACE_NOTES_MAX): { text: string; cut: boolean; bytes: number } {
  const body = part.trim()
  if (!body) return { text: '', cut: false, bytes: 0 }
  const header = say(N.header, { note: NOTE_NAME })
  const whole = `${header}\n${body}`
  if (utf8Bytes(whole) <= max) return { text: whole, cut: false, bytes: utf8Bytes(whole) }
  const cut = say(N.cut, { note: NOTE_NAME })
  const room = Math.max(0, max - utf8Bytes(`${header}\n\n${cut}`))
  // The longest start of the body within `room` bytes, by characters (a surrogate pair is never split).
  let kept = ''
  let size = 0
  for (const ch of body) {
    const n = utf8Bytes(ch)
    if (size + n > room) break
    kept += ch
    size += n
  }
  const line = kept.lastIndexOf('\n')
  if (line > kept.length / 2) kept = kept.slice(0, line)
  const text = `${header}\n${kept.trimEnd()}\n${cut}`
  return { text, cut: true, bytes: utf8Bytes(text) }
}
