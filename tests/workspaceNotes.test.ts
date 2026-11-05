// Workspace notes (#1433, #873, SPEC §16.10.7): one shared note per workspace, delivered inline at each launch after
// Combwork's guidance, on every CLI and in any folder; a project's own section reaches only its agents; bounded at 4 KB
// (Settings → Advanced), cut with a pointer; off with the note empty or the switch.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { parse as parseToml } from 'smol-toml'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import type { LaunchContext } from '../src/main/providers/types'

const base = tempDir('hive-workspace-notes-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const homes = { CODEX_HOME: process.env.CODEX_HOME, COPILOT_HOME: process.env.COPILOT_HOME }

const { advanced } = await import('../src/main/advanced')
const { appendedInstructions, claudeCode } = await import('../src/main/providers/claude/adapter')
const { codex } = await import('../src/main/providers/codex/adapter')
const { copilot, toolNamesLine } = await import('../src/main/providers/copilot/adapter')
const { DELIVER_WORKSPACE_NOTES, WORKSPACE_NOTES_MAX_ID, advancedDef, overrideId } = await import('../src/shared/advanced')
const { overridesNow } = await import('../src/main/advancedValues')
const { deliveredNotes, notesFor, WORKSPACE_NOTES_MAX, WORKSPACE_NOTES_PATH, workspaceNotesPath } = await import('../src/shared/workspaceNotes')
const { utf8Bytes } = await import('../src/shared/metrics')

beforeAll(() => {
  // Never the user's own homes: the adapters read their config.
  process.env.CODEX_HOME = join(base, 'codex-home')
  process.env.COPILOT_HOME = join(base, 'copilot-home')
  mkdirSync(join(base, 'profile'), { recursive: true })
  advanced.load(join(base, 'profile'))
})
afterEach(async () => {
  await advanced.resetAll()
})
afterAll(() => {
  advanced.stop()
  for (const [k, v] of Object.entries(homes)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(base, { recursive: true, force: true })
})

const NOTE = ['# Workspace notes', '', 'Node is C:\\tools\\node22\\node.exe here.', '', '## alpha', 'alpha runs its tests with D:\\bin\\alpha-test.cmd.', '', '## Setup', 'Everyone: the proxy is localhost:3128.', '', '## Beta', 'beta builds need VS 2022.', '```', '## alpha (in a code block: not a heading)', '```'].join('\n')
const PROJECTS = ['alpha', 'beta', 'gamma']

describe('the note and its sections', () => {
  it("gives a project the parts for everyone and its own section, never another project's", () => {
    const alpha = notesFor(NOTE, 'alpha', PROJECTS)
    expect(alpha).toContain('Node is C:\\tools\\node22\\node.exe here.')
    expect(alpha).toContain('alpha runs its tests')
    // A heading naming no project is everyone's.
    expect(alpha).toContain('the proxy is localhost:3128')
    expect(alpha).not.toContain('VS 2022')
    // Any case.
    const beta = notesFor(NOTE, 'BETA', PROJECTS)
    expect(beta).toContain('beta builds need VS 2022.')
    expect(beta).not.toContain('alpha runs its tests')
    // A heading in a code block is the section's text, not a heading.
    expect(beta).toContain('## alpha (in a code block: not a heading)')
    const gamma = notesFor(NOTE, 'gamma', PROJECTS)
    expect(gamma).not.toContain('alpha runs')
    expect(gamma).not.toContain('VS 2022')
    expect(gamma).toContain('Node is C:\\tools\\node22')
    // The Assistant gets the whole note.
    expect(notesFor(NOTE, null, PROJECTS)).toBe(NOTE)
    // CRLF reads as LF.
    expect(notesFor(NOTE.replace(/\n/g, '\r\n'), 'alpha', PROJECTS)).toBe(alpha)
  })

  it("follows Markdown's code fences: a heading inside one, of any fence, is text, never a section (HR5's round 1)", () => {
    const fenced = (open: string, inner: string, close: string): string => ['## beta', open, inner, '## alpha', 'BETA-PRIVATE', close, '## alpha', 'ALPHA-OWN'].join('\n')
    for (const [open, inner, close] of [
      ['````', '```', '````'], // a shorter run of the same character doesn't close it
      ['```', '~~~', '```'], // nor does the other character
      ['~~~~', '```', '~~~~~'], // closed by a longer run
      ['```js', '``` not a close', '```'], // an info string opens; a run with text after doesn't close
      ['   ```', '', '  ```'] // up to three spaces in
    ]) {
      const alpha = notesFor(fenced(open, inner, close), 'alpha', PROJECTS)
      expect(alpha, `${open} … ${close}`).toContain('ALPHA-OWN')
      expect(alpha, `${open} … ${close}`).not.toContain('BETA-PRIVATE')
      expect(notesFor(fenced(open, inner, close), 'beta', PROJECTS), `${open} … ${close}`).toContain('BETA-PRIVATE')
    }
    // A fence never closed runs to the end: what follows is still the section's.
    expect(notesFor(['## beta', '```', '## alpha', 'BETA-PRIVATE'].join('\n'), 'alpha', PROJECTS)).toBe('')
    // A backtick run with a backtick after it isn't a fence (inline code), so the heading after it counts.
    expect(notesFor(['## beta', '``` inline ` code', '## alpha', 'ALPHA-OWN'].join('\n'), 'alpha', PROJECTS)).toBe('## alpha\nALPHA-OWN')
    // Four spaces in is indented code, not a heading; a heading may close with #s and be indented up to three.
    expect(notesFor(['## beta', '    ## alpha', 'BETA-PRIVATE'].join('\n'), 'alpha', PROJECTS)).toBe('')
    expect(notesFor(['## beta', 'BETA-PRIVATE', '   ## alpha ##', 'ALPHA-OWN'].join('\n'), 'alpha', PROJECTS)).toBe('## alpha ##\nALPHA-OWN')
  })

  it('is delivered under its header; empty, nothing', () => {
    expect(deliveredNotes('  \n ')).toEqual({ text: '', cut: false, bytes: 0 })
    const d = deliveredNotes(notesFor(NOTE, 'alpha', PROJECTS))
    expect(d.cut).toBe(false)
    expect(d.text.split('\n')[0]).toBe('Workspace notes (this machine), from the shared note "Workspace notes":')
    expect(d.bytes).toBe(utf8Bytes(d.text))
  })

  it('is cut at the bound (bytes, header included), at a line, never mid-character, with a pointer to the note', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `Line ${i}: ünïcödé ✓ 𝄞 notes about this machine.`)
    for (const max of [WORKSPACE_NOTES_MAX, 1000, 600]) {
      const d = deliveredNotes(lines.join('\n'), max)
      expect(d.cut, String(max)).toBe(true)
      expect(d.bytes, String(max)).toBeLessThanOrEqual(max)
      expect(d.bytes).toBe(utf8Bytes(d.text))
      expect(d.text.endsWith('\n(cut: read the shared note Workspace notes for the rest)')).toBe(true)
      // Whole lines kept: the last one before the pointer is one of the note's.
      const kept = d.text.split('\n').slice(1, -1)
      expect(lines.slice(0, kept.length)).toEqual(kept)
      expect(d.text).not.toContain('\uFFFD')
    }
    // One long line: cut inside it, on a character.
    const long = deliveredNotes('𝄞'.repeat(2000), 700)
    expect(long.bytes).toBeLessThanOrEqual(700)
    expect(long.text.split('\n')[1]).toMatch(/^(𝄞)+$/u)
  })

  it('has its switches in Settings → Advanced, for sessions started afterwards, and a fixed path', () => {
    expect(advancedDef(DELIVER_WORKSPACE_NOTES)).toMatchObject({ kind: 'boolean', default: true, applies: 'sessions', group: 'cw' })
    expect(advancedDef(WORKSPACE_NOTES_MAX_ID)).toMatchObject({ kind: 'number', default: 4096, unit: 'bytes', applies: 'sessions' })
    expect(WORKSPACE_NOTES_PATH).toBe('Workspace notes.md')
    expect(workspaceNotesPath('D:\\ws\\')).toBe('D:\\ws\\.combwork\\shared\\Workspace notes.md')
  })
})

function context(over: Partial<LaunchContext> = {}): LaunchContext {
  const cwd = join(base, 'proj')
  mkdirSync(cwd, { recursive: true })
  return {
    projectPath: cwd, agentId: 'a-1', executable: 'C:\\bin\\cli.exe', cwd, workspacePath: base, runId: `r-${Math.random()}`, sessionId: '0cb916db-26aa-40f2-86b5-1ba81b225fd2',
    resume: false, name: '', skills: [], mcpServers: { combwork: { command: 'node', args: ['cw-mcp.js'] } }, model: null, effort: null, permissionMode: null, extraArgs: [],
    hookUrl: 'http://127.0.0.1:5000/hook?run=r1', hookAuthFile: join(base, 'auth.txt'), privateDir: join(base, `private-${Math.random()}`), guidance: 'Combwork guidance', allowBackgroundSessions: false, use200kContext: false,
    env: { PATH: 'C:\\Windows' },
    ...over
  }
}

const NOTES = deliveredNotes('Node is C:\\tools\\node22\\node.exe here.').text

describe('delivered at launch, on every CLI, after Combwork\'s guidance', () => {
  it("Claude Code: appended to the system prompt from the launch's file, after the Assistant's role", () => {
    expect(appendedInstructions(context({ notes: NOTES }))).toBe(NOTES)
    expect(appendedInstructions(context({ notes: NOTES, instructions: 'You are in Planner mode.' }))).toBe(`You are in Planner mode.\n\n${NOTES}`)
    expect(appendedInstructions(context({ notes: '' }))).toBe('')
    const args = (ctx: LaunchContext): string[] => claudeCode.buildCommand('C:\\bin\\claude.exe', ctx).args
    expect(args(context({ notes: NOTES }))).toContain('--append-system-prompt-file')
    expect(args(context())).not.toContain('--append-system-prompt-file')
    // A resumed conversation gets the notes as they are now, not as it started with them.
    expect(args(context({ notes: NOTES, resume: true, cliVersion: '2.1.305' })).join(' ')).toContain('--system-prompt-snapshot off')
  })

  it("Claude Code: a conversation Combwork gave instructions to before loses them on resume once they're off or emptied (HR5's rounds 1–2)", () => {
    /** A launch's command: whether it renders the prompt fresh, and whether it appends. */
    const launch = (over: Partial<LaunchContext>) => {
      const args = claudeCode.buildCommand('C:\\bin\\claude.exe', context({ cliVersion: '2.1.305', mcpServers: {}, guidance: '', ...over })).args
      return { fresh: args.join(' ').includes('--system-prompt-snapshot off'), appends: args.includes('--append-system-prompt-file') }
    }
    // Started with notes.
    expect(launch({ notes: NOTES })).toEqual({ fresh: false, appends: true })
    // Resumed with notes switched off or emptied (none given now), the conversation's record saying Combwork gave some before
    // (SessionRecord.promptAdded, by whichever agent): nothing appended, and the prompt rendered fresh, without the old note.
    expect(launch({ resume: true, notes: '', promptAddedBefore: true })).toEqual({ fresh: true, appends: false })
    // A conversation never given any: left as Claude Code keeps it.
    expect(launch({ resume: true, promptAddedBefore: false })).toEqual({ fresh: false, appends: false })
    expect(launch({ resume: true })).toEqual({ fresh: false, appends: false })
    // A new conversation has nothing saved to refresh.
    expect(launch({ promptAddedBefore: true })).toEqual({ fresh: false, appends: false })
    // The user's own --system-prompt-snapshot, and the switch off (#1167), still decide.
    expect(launch({ resume: true, promptAddedBefore: true, extraArgs: ['--system-prompt-snapshot', 'on'] }).fresh).toBe(false)
  })

  it('Claude Code: the switch off (#1167) leaves a resumed prompt as Claude Code keeps it', async () => {
    await advanced.set(overrideId('claude-code', 'promptSnapshotOff'), false)
    const args = claudeCode.buildCommand('C:\\bin\\claude.exe', context({ cliVersion: '2.1.305', resume: true, promptAddedBefore: true, overrides: overridesNow('claude-code') })).args
    expect(args).not.toContain('--system-prompt-snapshot')
  })

  it('Copilot: in its instruction file, after the guidance and the role', async () => {
    const file = (ctx: LaunchContext): string => readFileSync(join(ctx.privateDir, 'instructions', '.github', 'instructions', 'hive.instructions.md'), 'utf8')
    const agent = context({ notes: NOTES })
    await copilot.prepareLaunch(agent)
    // The guidance comes as the hive server's instructions (the switch on): the file has the tools' names and the notes.
    expect(file(agent)).toBe(`---\napplyTo: '**'\n---\n${toolNamesLine()}\n\n${NOTES}\n`)
    expect(copilot.buildCommand('C:\\bin\\copilot.exe', agent).env?.COPILOT_CUSTOM_INSTRUCTIONS_DIRS).toBe(join(agent.privateDir, 'instructions'))
    const assistant = context({ notes: NOTES, instructions: 'You are in Planner mode.' })
    await copilot.prepareLaunch(assistant)
    expect(file(assistant)).toBe(`---\napplyTo: '**'\n---\n${toolNamesLine()}\n\nYou are in Planner mode.\n\n${NOTES}\n`)
    const none = context()
    await copilot.prepareLaunch(none)
    expect(file(none)).toBe(`---\napplyTo: '**'\n---\n${toolNamesLine()}\n`)
  })

  it("Codex: in developer_instructions after the user's own and Combwork's guidance; Codex unable to say, an agent's are left alone", async () => {
    const fake = join(__dirname, 'e2e', 'fake-codex', 'fake-codex.cmd')
    const home = join(base, 'developer-codex-home')
    const homeBefore = process.env.CODEX_HOME
    process.env.CODEX_HOME = home
    mkdirSync(home, { recursive: true })
    const said = join(home, 'fake-developer-instructions.txt')
    const env = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ComSpec: process.env.ComSpec ?? '', CODEX_HOME: home }
    const developer = async (over: Partial<LaunchContext>): Promise<string | null> => {
      const ctx = context({ executable: fake, env, ...over })
      await codex.prepareLaunch(ctx)
      const a = codex.buildCommand('C:\\bin\\codex.exe', ctx).args.findLast((x) => x.startsWith('developer_instructions='))
      return a ? (parseToml(a) as { developer_instructions: string }).developer_instructions : null
    }
    try {
      expect(await developer({ notes: NOTES })).toBe(`Combwork guidance\n\n${NOTES}`)
      writeFileSync(said, 'Mine.')
      expect(await developer({ notes: NOTES })).toBe(`Mine.\n\nCombwork guidance\n\n${NOTES}`)
      expect(await developer({ notes: NOTES, instructions: 'You are the Assistant.' })).toBe(`Mine.\n\nCombwork guidance\n\nYou are the Assistant.\n\n${NOTES}`)
      // Combwork's guidance off: the notes still come, after the user's own.
      expect(await developer({ notes: NOTES, guidance: '' })).toBe(`Mine.\n\n${NOTES}`)
      writeFileSync(said, '!fail')
      expect(await developer({ notes: NOTES })).toBeNull()
      expect(await developer({ notes: NOTES, instructions: 'You are the Assistant.' })).toBe(`You are the Assistant.\n\n${NOTES}`)
    } finally {
      process.env.CODEX_HOME = homeBefore
      rmSync(home, { recursive: true, force: true })
    }
  })
})

// A project agent's write refused, the Assistant's taken: e2e workspacenotes (the Agent API).
describe("in a workspace: the launch's notes and the switch", () => {
  it('reads the note as it is at each launch, for the project, bounded, and nothing with the switch off or the note empty', async () => {
    const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
    const { closeAllBoards } = await import('../src/main/boardStore')
    const { workspaceNotesFor } = await import('../src/main/workspaceNotes')
    const root = join(base, 'ws')
    for (const p of PROJECTS) {
      mkdirSync(join(root, p, '.combwork'), { recursive: true })
      writeFileSync(join(root, p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    }
    const ws = createWorkspaceService()
    await ws.open(root)
    try {
      expect(await workspaceNotesFor(join(root, 'alpha'))).toBe('')
      const file = join(ws.sharedDir, WORKSPACE_NOTES_PATH)
      mkdirSync(ws.sharedDir, { recursive: true })
      writeFileSync(file, NOTE)
      const alpha = await workspaceNotesFor(join(root, 'alpha'))
      expect(alpha).toBe(deliveredNotes(notesFor(NOTE, 'alpha', PROJECTS)).text)
      expect(alpha).not.toContain('VS 2022')
      expect(await workspaceNotesFor(join(root, 'beta'))).toContain('VS 2022')
      // An edit reaches the next launch.
      writeFileSync(file, `EDITED\n${NOTE}`)
      expect(await workspaceNotesFor(join(root, 'gamma'))).toContain('EDITED')
      // The bound is the Advanced value's.
      await advanced.set(WORKSPACE_NOTES_MAX_ID, 512)
      writeFileSync(file, 'x'.repeat(5000))
      const cut = await workspaceNotesFor(join(root, 'gamma'))
      expect(utf8Bytes(cut)).toBeLessThanOrEqual(512)
      expect(cut).toMatch(/\(cut: read the shared note Workspace notes for the rest\)$/)
      // Off: nothing.
      await advanced.set(DELIVER_WORKSPACE_NOTES, false)
      expect(await workspaceNotesFor(join(root, 'gamma'))).toBe('')
      await advanced.set(DELIVER_WORKSPACE_NOTES, null)
      writeFileSync(file, '   \n')
      expect(await workspaceNotesFor(join(root, 'gamma'))).toBe('')
    } finally {
      await disposeWorkspaceService(ws)
      closeAllBoards()
    }
  })

  it("remembers that a conversation was given Combwork's instructions with the conversation itself: any agent, a restart, many newer ones", async () => {
    const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
    const { closeAllBoards } = await import('../src/main/boardStore')
    const root = join(base, 'ws-prompted')
    const proj = join(root, 'alpha')
    mkdirSync(join(proj, '.combwork'), { recursive: true })
    writeFileSync(join(proj, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a-first', name: 'First' }, { id: 'a-second', name: 'Second' }] }))
    const old = '7b1d2e3f-0000-4000-8000-000000000000'
    const open = async () => {
      const ws = createWorkspaceService()
      await ws.open(root)
      return ws
    }
    let ws = await open()
    try {
      // First gave it notes (sessions.ts records promptAdded with the launch's session record).
      await ws.upsertSession(proj, { id: old, agent: 'claude-code', agentId: 'a-first', promptAdded: true })
      // Many newer conversations since, and Second records a later launch of the same one (no field: nothing cleared).
      await ws.mutateSessions(proj, (f) => {
        for (let i = 1; i <= 250; i++) f.sessions.push({ id: `7b1d2e3f-0000-4000-8000-${String(i).padStart(12, '0')}`, agent: 'claude-code', name: '', createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), archived: false })
      })
      await ws.upsertSession(proj, { id: old, agentId: 'a-second', lastActiveAt: new Date().toISOString() })
      await disposeWorkspaceService(ws)
      closeAllBoards()
      // After a restart: still there, for whichever agent resumes it.
      ws = await open()
      const rec = (await ws.sessionsFile(proj)).sessions.find((s) => s.id === old)
      expect(rec?.promptAdded).toBe(true)
      expect(rec?.agentId).toBe('a-second')
    } finally {
      await disposeWorkspaceService(ws)
      closeAllBoards()
    }
  })
})
