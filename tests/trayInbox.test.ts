// The tray menu's Need you list across windows: oldest first over every workspace before it is cut to 10, unknown
// times last, the rest counted, and each item shown in the window of its own workspace.
import { describe, expect, it, vi } from 'vitest'
import { firstAcross, type InboxItem } from '../src/shared/inbox'
import type { AgentInfo, LiveSessionState, ProjectInfo } from '../src/shared/types'

const item = (agentId: string, since: string): InboxItem => ({ projectPath: 'C:/ws/p', projectName: 'p', agentId, agentName: agentId, assistant: false, kind: 'waiting', since })

describe('firstAcross', () => {
  it('sorts across the windows before cutting, keeps each item with its window, unknown times last', () => {
    const { shown, total } = firstAcross(
      [
        { owner: 'A', items: [item('a1', '2026-10-02T12:00:00Z'), item('a2', '2026-10-02T12:05:00Z'), item('a0', '')] },
        { owner: 'B', items: [item('b1', '2026-10-02T10:00:00Z'), item('b2', '2026-10-02T12:01:00Z')] }
      ],
      4
    )
    expect(shown.map((s) => `${s.owner}:${s.item.agentId}`)).toEqual(['B:b1', 'A:a1', 'B:b2', 'A:a2'])
    expect(total).toBe(5)
  })

  it('equal times keep the windows in order', () => {
    const t = '2026-10-02T12:00:00Z'
    const { shown } = firstAcross([{ owner: 'A', items: [item('a', t)] }, { owner: 'B', items: [item('b', t)] }], 10)
    expect(shown.map((s) => s.owner)).toEqual(['A', 'B'])
  })
})

describe('tray menu', () => {
  type Template = { label?: string; enabled?: boolean; click?: () => void }[]

  /** The real createTray, with Electron and the main process stubbed: two windows, ten agents waiting in the first and an older one in the second. */
  async function tray() {
    vi.resetModules()
    let menu: Template = []
    const shown: unknown[] = []
    vi.doMock('electron', () => ({
      app: { isPackaged: false },
      Menu: { buildFromTemplate: (t: Template) => (menu = t) },
      Tray: class {
        setToolTip(): void {}
        setImage(): void {}
        setContextMenu(): void {}
        on(): void {}
      },
      nativeImage: { createFromPath: () => ({ isEmpty: () => true, addRepresentation: () => undefined }) }
    }))
    const states: LiveSessionState[] = []
    const workspace = (name: string, waiting: [string, string][]) => {
      const path = `C:/${name}/p`
      const agents = waiting.map(([id, since]) => {
        states.push({ projectPath: path, agentId: id, status: 'waiting', statusSince: since } as LiveSessionState)
        return { id, name: id, live: null, place: { folder: path, is: 'project', name: null, branch: null } } as unknown as AgentInfo
      })
      const window = { name, isMinimized: () => false, restore: () => undefined, show: () => undefined, focus: () => undefined }
      return { path: `C:/${name}`, window, info: () => ({ projects: [{ name, path, agents } as unknown as ProjectInfo], assistant: null }), activeNames: () => [] }
    }
    // Window A, opened first: ten agents waiting since 12:00 onwards (and one with no time). Window B: one waiting since 10:00.
    const a = workspace('A', [...Array.from({ length: 10 }, (_, i): [string, string] => [`a${i}`, `2026-10-02T12:${String(i).padStart(2, '0')}:00Z`]), ['a-unknown', '']])
    const b = workspace('B', [['b-oldest', '2026-10-02T10:00:00Z']])
    vi.doMock('../src/main/workspace', () => ({ openWorkspaces: () => [a, b] }))
    vi.doMock('../src/main/sessions', () => ({ sessions: { liveStates: () => states, projectStates: () => [] } }))
    vi.doMock('../src/main/branchWatch', () => ({ knownStatus: () => null }))
    vi.doMock('../src/main/events', () => ({ onHiveEvent: () => undefined, emitTo: (win: unknown, e: { args: unknown[] }) => shown.push([(win as { name: string }).name, ...e.args]) }))
    vi.doMock('../src/main/paths', () => ({ resourcesDir: () => 'C:/res' }))
    vi.doMock('../src/main/updater', () => ({ updateState: () => ({ status: 'idle' }), restartAndInstall: () => undefined }))
    const { createTray } = await import('../src/main/tray')
    createTray(() => null, { quit: () => undefined, quitNow: () => undefined, cancelPendingQuit: () => undefined })
    return { menu, shown }
  }

  it('lists the oldest across windows first, cuts at ten, counts the rest, and shows each in its own window', async () => {
    const { menu, shown } = await tray()
    const head = menu.findIndex((m) => m.label?.startsWith('Need you'))
    expect(menu[head].label).toBe('Need you (12)')
    const items = menu.slice(head + 1, head + 12)
    expect(items.map((m) => m.label?.split(' · ')[1]?.split(' ')[0] ?? m.label)).toEqual(['b-oldest', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'and 2 more'])
    items[0].click!()
    items[1].click!()
    expect(shown).toEqual([
      ['B', 'C:/B/p', 'b-oldest'],
      ['A', 'C:/A/p', 'a0']
    ])
  })
})
