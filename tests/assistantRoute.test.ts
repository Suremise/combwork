// HI-3595: the Assistant's launch text (modes.ts' assistantInstructions) says to name the window's route first when
// Combwork's window can do what the user asks, and gives a command where it has none or when the user asks for one:
// "first", never "only". It is the Assistant's own rule, in that one place, whatever its Control or mode.
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-assistant-route-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { assistantInstructions } = await import('../src/main/modes')
const store = await import('../src/main/boardStore')

const RULE = "When Combwork's window can do what the user asks, name that route first, by its place in the window (merged branches: Version Control → Branches & remotes → Clean Up Merged Branches…). Find any other in Combwork's user guide (cw_doc_outline \"combwork:USER_GUIDE.md\", then cw_read_section) and give it in full; never guess one: not there, say so. Give a shell or git command only where the window has none (say so) or when the user asks for one; then give it."

const ws = join(base, 'ws')
mkdirSync(join(ws, 'alpha', '.combwork'), { recursive: true })
writeFileSync(join(ws, 'alpha', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
const w = createWorkspaceService()
await w.open(ws)
afterAll(async () => {
  await disposeWorkspaceService(w)
  store.closeAllBoards()
})

describe("the Assistant names the window's route first (HI-3595)", () => {
  it('is in its launch text once, before its mode, whatever its Control', async () => {
    for (const control of ['look', 'projects', 'agents'] as const) {
      const r = await inWorkspace(w, () => assistantInstructions('coordinator', control))
      expect(r.text.split(RULE).length - 1, control).toBe(1)
      expect(r.text.indexOf(RULE), control).toBeLessThan(r.text.indexOf(r.modeText || '\u0000'))
    }
  })

  it('is the Assistant’s own: not in the session contract every agent gets (one owner per rule)', () => {
    expect(readFileSync(join(__dirname, '..', 'src', 'shared', 'combworkGuidance.ts'), 'utf8')).not.toContain('name that route first')
  })
})
