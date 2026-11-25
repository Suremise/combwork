// The reconciler follows each project as its platform says (HI-2896): a project switched to another platform is followed
// afresh, its old watch disposed and a new one made. The watcher's subscriptions are recorded here (historyPorts'
// observePort), not run.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-reconciler-follow-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

/** Each watch made (its project), and each disposed. */
const made: string[] = []
const disposed: string[] = []
vi.mock('../src/main/platform/historyPorts', async (original) => {
  const real = await original<typeof import('../src/main/platform/historyPorts')>()
  return {
    ...real,
    observePort: {
      ...real.observePort,
      subscribe: (project: string) => {
        made.push(project)
        return { dispose: () => void disposed.push(project) }
      }
    }
  }
})

const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
const store = await import('../src/main/boardStore')
const { reconcileWorkspace, stopReconciling } = await import('../src/main/workflow/reconciler')
const sw = await import('../src/main/workflow/platformSwitch')

const opened: ReturnType<typeof createWorkspaceService>[] = []
afterAll(async () => {
  stopReconciling()
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

describe('the reconciler follows a project as its platform says (HI-2896)', () => {
  it('a project switched from None to Git is followed afresh: the old follow’s watch disposed, a new one made', async () => {
    const ws = join(base, 'ws')
    const p = join(ws, 'p')
    mkdirSync(join(p, '.combwork'), { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: p, stdio: 'pipe' })
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'none', agents: [] }))
    const w = createWorkspaceService()
    await w.open(ws)
    opened.push(w)
    reconcileWorkspace(w)
    expect(made).toEqual([p])
    await sw.setPlatform(w, p, 'git', { expected: 'none' })
    reconcileWorkspace(w)
    expect(disposed).toEqual([p])
    expect(made).toEqual([p, p])
    // Unchanged since: followed as it is, nothing made again.
    reconcileWorkspace(w)
    expect(made).toEqual([p, p])
  })
})
