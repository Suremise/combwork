// A folder being changed under its agents (#646, main/folderFence.ts): while a fence is up nothing of Combwork's is typed into
// an agent working in that folder or inside it (lineWriter, so every delivery), and it is free again once what it guards
// settles, also when that fails. With the real SessionManager's live state and the line writer; nothing is typed.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sessions } from '../src/main/sessions'
import { changingFolder, folderChanging, folderSteady } from '../src/main/folderFence'
import { whyNoLine } from '../src/main/lineWriter'

const project = 'C:/fake-ws/alpha'
const id = 'a1'
const live = (sessions as unknown as { live: Map<string, unknown> }).live
const key = `${project.toLowerCase()}#${id}`

describe("a folder being changed holds Combwork's lines to the agents working in it (#646)", () => {
  afterEach(() => live.delete(key))
  const idleIn = (cwd: string): void => {
    live.set(key, { state: { projectPath: project, agentId: id, agentName: 'B1', runId: 'run1', status: 'ready', cwd, runtime: { lifecycle: 'running', maintenance: null, attention: null, composer: 'free' }, turn: { state: 'over' } }, prompts: 0 })
  }

  it('no line while it changes, for an agent in it or in a folder inside it; one elsewhere is free; free again once done', async () => {
    idleIn(project)
    expect(whyNoLine(project, id)).toBeNull()
    let open!: () => void
    const gate = new Promise<void>((r) => (open = r))
    let inside!: () => void
    const started = new Promise<void>((r) => (inside = r))
    const done = changingFolder(project, 'a Git switch', async () => {
      inside()
      await gate
      return 'switched'
    })
    await started
    expect(whyNoLine(project, id)).toBe('its folder is being changed (a Git switch)')
    idleIn('C:/fake-ws/alpha/packages/app')
    expect(whyNoLine(project, id)).toBe('its folder is being changed (a Git switch)')
    // A sibling whose name only starts the same isn't in it.
    idleIn('C:/fake-ws/alpha-2')
    expect(whyNoLine(project, id)).toBeNull()
    idleIn(project)
    open()
    expect(await done).toBe('switched')
    expect(whyNoLine(project, id)).toBeNull()
  })

  it('no Enter again for a line not taken while its folder changes: held, then pressed once it is done (#646 round 1)', async () => {
    const pty = await import('../src/main/ptyHost')
    const writer = await import('../src/main/lineWriter')
    const writes: string[] = []
    const write = vi.spyOn(pty, 'writePty').mockImplementation((_k: string, d: string) => void writes.push(d))
    writer.testHooks.takeMs = 50
    try {
      idleIn(project)
      // submitAgain itself refuses inside a fence.
      await changingFolder(project, 'a Git pull', async () => {
        expect(sessions.submitAgain(project, id, 'run1')).toBe(false)
      })
      expect(writes).toEqual([])
      // A line typed and not taken: its confirmation reaches Enter again while git pulls, and holds it until git is done.
      let open!: () => void
      const gate = new Promise<void>((r) => (open = r))
      let inside!: () => void
      const started = new Promise<void>((r) => (inside = r))
      const pull = changingFolder(project, 'a Git pull', async () => {
        inside()
        await gate
      })
      await started
      let ended = false
      const confirmed = writer.confirmTaken(project, id, { runId: 'run1', count: 0 }, '[CW] line').finally(() => (ended = true))
      // Its first window passes with the line not taken; then it waits on the folder, pressing nothing.
      await vi.waitFor(() => expect(writer.confirmsInFlight()).toBe(1), { timeout: 5000 })
      await new Promise<void>((r) => setTimeout(r, 200)) // on purpose: well past its 50 ms window, to see no Enter comes
      expect(writes).toEqual([])
      expect(ended).toBe(false)
      open()
      await pull
      await vi.waitFor(() => expect(writes).toEqual(['\r']), { timeout: 5000 })
      // Taken after it: confirmed.
      ;(live.get(key) as { prompts: number }).prompts = 1
      expect(await confirmed).toBe(true)
    } finally {
      writer.testHooks.takeMs = undefined
      write.mockRestore()
    }
  })

  it('a fence whose work fails comes down too; two at once on the same folder hold it until both are done', async () => {
    await expect(changingFolder(project, 'a Git pull', async () => { throw new Error('git failed') })).rejects.toThrow('git failed')
    expect(folderChanging(project)).toBeNull()
    let openA!: () => void
    let openB!: () => void
    const a = changingFolder(project, 'one', () => new Promise<void>((r) => (openA = r)))
    const b = changingFolder(project, 'two', () => new Promise<void>((r) => (openB = r)))
    let steady = false
    const waited = folderSteady(project).then(() => (steady = true))
    openA()
    await a
    expect(folderChanging(project)).toBe('two')
    expect(steady).toBe(false)
    openB()
    await b
    await waited
    expect(steady).toBe(true)
    expect(folderChanging(project)).toBeNull()
  })
})
