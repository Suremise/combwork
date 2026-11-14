// The reconciler follows each project with its platform's watches (HI-2896): a project switched to another platform is
// followed afresh, its old watches disposed and its new platform's made. Before, a project followed while it used Git
// kept Git's alone after its switch to jj, so a non-colocated jj repository (whose operations change no Git ref) was never
// reconciled to Integrated. The platform's repository watch is recorded here (historyPorts' repoWatchOf), not run.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-reconciler-follow-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

/** Each repository watch made (its platform), and each disposed. */
const made: string[] = []
const disposed: string[] = []
vi.mock('../src/main/platform/historyPorts', async (original) => {
  const real = await original<typeof import('../src/main/platform/historyPorts')>()
  return {
    ...real,
    repoWatchOf: (platform: string) => () => {
      made.push(platform)
      return { dispose: () => void disposed.push(platform) }
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

describe('the reconciler follows a project with its platform’s watches (HI-2896)', () => {
  it('a project switched from None to Git is followed afresh: the old follow disposed, the new platform’s watch made', async () => {
    const ws = join(base, 'ws')
    const p = join(ws, 'p')
    mkdirSync(join(p, '.combwork'), { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: p, stdio: 'pipe' })
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'none', agents: [] }))
    const w = createWorkspaceService()
    await w.open(ws)
    opened.push(w)
    reconcileWorkspace(w)
    expect(made).toEqual(['none'])
    await sw.setPlatform(w, p, 'git', { expected: 'none' })
    reconcileWorkspace(w)
    expect(disposed).toEqual(['none'])
    expect(made).toEqual(['none', 'git'])
    // Unchanged since: followed as it is, nothing made again.
    reconcileWorkspace(w)
    expect(made).toEqual(['none', 'git'])
  })
})
