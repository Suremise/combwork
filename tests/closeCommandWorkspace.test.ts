// HI-1368 with a real WorkspaceService (HR6's round 3, Darren's decision of 28 Oct ~15:30): a switch whose old workspace's
// close is held by a closing task shows its saving step; Skip the command keeps the panel up and the close going, never
// cancelled or begun again; once the close is released the panel goes, the switch opens the next workspace, intact, and
// neither the workspace's command nor When Combwork quits starts. The runner's start is stood in for (it would run a command).
import { mkdirSync, rmSync } from 'fs'
import { EventEmitter } from 'events'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const started = vi.hoisted(() => [] as string[])
vi.mock('../src/main/closeCommand/runs', async (orig) => {
  const real = await orig<typeof import('../src/main/closeCommand/runs')>()
  return {
    ...real,
    runsCloseCommands: () => true,
    startRun: (_root: string, _folder: string, command: string) => {
      started.push(command)
      throw new Error('no runner in a unit test')
    }
  }
})

const base = tempDir('cw-close-ws-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
afterAll(() => rmSync(base, { recursive: true, force: true }))

const { createWorkspaceService, disposeWorkspaceService, WorkspaceService } = await import('../src/main/workspace')
const { closeCommandState, closeWithCommand, dontWait, runQuitCommand } = await import('../src/main/closeCommand/closeCommands')

/** A window, as far as the panels use one. */
function fakeWin() {
  return Object.assign(new EventEmitter(), { webContents: { id: 9001, send: () => undefined }, isDestroyed: () => false, isVisible: () => true, showInactive: () => undefined })
}
/** A gate a test opens: what waits on it goes on then. */
const gate = (): { wait: Promise<void>; open: () => void } => {
  let open!: () => void
  return { wait: new Promise<void>((r) => (open = r)), open }
}
/** Lets what is ready run: each await a step. */
const settle = async (until: () => boolean): Promise<boolean> => {
  for (let i = 0; i < 200 && !until(); i++) await new Promise((r) => setImmediate(r))
  return until()
}

describe("a switch whose old workspace's close is held", () => {
  it("Skip the command: the panel stays while the close goes on; released, the switch completes and nothing runs", async () => {
    const wsA = join(base, 'Work')
    const wsB = join(base, 'Next')
    for (const d of [wsA, wsB]) mkdirSync(d, { recursive: true })
    const w = createWorkspaceService()
    const held = gate()
    let heldFor: string | null = null
    const task = async (path: string): Promise<void> => {
      heldFor = path
      await held.wait
    }
    WorkspaceService.closingTasks.add(task)
    try {
      await w.open(wsA)
      await w.saveWorkspaceConfigWith(() => ({ commands: { list: [{ id: 'c-00000001', name: 'Backup', command: 'backup {reason}' }], onOpen: { run: [] }, onClose: { run: [{ scope: 'workspace', id: 'c-00000001' }] } } }))
      const win = fakeWin()
      let outcome: string | null = null
      const closing = closeWithCommand(w, 'switch', win as never).then((r) => (outcome = r))
      expect(await settle(() => closeCommandState(win as never)?.state === 'saving' && heldFor !== null)).toBe(true)
      const saving = closeCommandState(win as never)!
      expect(saving.workspace).toBe('Work')
      dontWait(win as never, saving.id)
      // Skipped, and still up: the close goes on, held, never cancelled.
      expect(closeCommandState(win as never)).toMatchObject({ state: 'saving', skipped: true })
      expect(await settle(() => outcome !== null)).toBe(false)
      expect(w.path).toBe(wsA)
      held.open()
      await closing
      expect(outcome).toBe('leftSaving')
      expect(closeCommandState(win as never)).toBeNull()
      // The switch opens the next workspace, once, with nothing of the old close left to run.
      await w.open(wsB)
      expect(w.path).toBe(wsB)
      await expect(runQuitCommand({ list: [{ id: 'c-0000000f', name: 'Quit', command: 'backup all' }], onQuit: { run: [{ scope: 'combwork', id: 'c-0000000f' }] } }, 'quit', null, 'left')).resolves.toBe('leftSaving')
      expect(started).toEqual([])
    } finally {
      WorkspaceService.closingTasks.delete(task)
      held.open()
      await disposeWorkspaceService(w)
    }
  })
})
