// A workspace's open commands holding its agents back (HI-1954, design HI-1954/s19 §1 and s21 §3): the gate settles once,
// and as closed when its open's lifetime ends; it is reserved as the workspace opens, before anything hears of the open,
// when its open point has commands and this Combwork runs them; while it is held every start is refused at the chokepoint,
// and restart-resume's own starts wait for it. The workspace is real; no command or session runs.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('opengate-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { OpenGate, onGateSettled } = await import('../src/main/openGate')
const { createWorkspaceService, disposeWorkspaceService, WorkspaceService } = await import('../src/main/workspace')
const { onCombworkEvent } = await import('../src/main/events')
const { sessions } = await import('../src/main/sessions')

type WS = ReturnType<typeof createWorkspaceService>
const open: WS[] = []
afterAll(async () => {
  WorkspaceService.runsCommands = () => false
  for (const w of open) await disposeWorkspaceService(w)
})

/** A workspace with a project, its open point running one command (or none). */
function workspaceAt(name: string, withOpen: boolean): string {
  const at = join(base, name)
  mkdirSync(join(at, 'alpha', '.combwork'), { recursive: true })
  writeFileSync(join(at, 'alpha', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
  mkdirSync(join(at, '.combwork'), { recursive: true })
  const commands = { list: [{ id: 'c-00000001', name: 'Serve', command: 'serve' }], onOpen: { run: withOpen ? [{ scope: 'workspace', id: 'c-00000001' }] : [] }, onClose: { run: [] } }
  writeFileSync(join(at, '.combwork', 'workspace.json'), JSON.stringify({ version: 1, commands }))
  return at
}
const refused = (projectPath: string): string | null => {
  try {
    ;(sessions as unknown as { assertStartsAllowed: (p: string) => void }).assertStartsAllowed(projectPath)
    return null
  } catch (e) {
    return (e as Error).message
  }
}

describe('the open gate', () => {
  it('settles once; its lifetime ending settles it as closed; each settling is told', () => {
    const told = vi.fn()
    const stop = onGateSettled(told)
    const life = new AbortController()
    const g = new OpenGate(1, life.signal)
    expect(g.held).toBe(true)
    expect(g.settle('detached')).toBe(true)
    expect(g.settle('done')).toBe(false)
    expect([g.held, g.end, told.mock.calls.length]).toEqual([false, 'detached', 1])
    const h = new OpenGate(2, life.signal)
    life.abort()
    expect([h.held, h.end]).toEqual([false, 'closed'])
    stop()
  })

  it("is reserved as the workspace opens, before any event about the open; starts are refused while it's held, and allowed once it settles", async () => {
    WorkspaceService.runsCommands = () => true
    const at = workspaceAt('held', true)
    const ws = createWorkspaceService()
    open.push(ws)
    // The first thing anyone hears of the open: the gate is there, held.
    const seen: (boolean | undefined)[] = []
    const stop = onCombworkEvent(() => void seen.push(ws.openGate?.held))
    await ws.open(at)
    stop()
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[0]).toBe(true)
    expect(refused(join(at, 'alpha'))).toMatch(/open commands are still running/)
    ws.openGate!.settle('done')
    expect(refused(join(at, 'alpha'))).toBeNull()
    await ws.close()
  })

  it('none reserved with no open commands, or in a Combwork that runs none; closed while held, it settles as closed', async () => {
    WorkspaceService.runsCommands = () => true
    const ws = createWorkspaceService()
    open.push(ws)
    await ws.open(workspaceAt('none', false))
    expect(ws.openGate).toBeNull()
    await ws.close()
    WorkspaceService.runsCommands = () => false
    await ws.open(workspaceAt('quiet', true))
    expect(ws.openGate).toBeNull()
    await ws.close()
    WorkspaceService.runsCommands = () => true
    await ws.open(workspaceAt('closing', true))
    const gate = ws.openGate!
    await ws.close()
    expect([gate.held, gate.end]).toEqual([false, 'closed'])
  })
})
