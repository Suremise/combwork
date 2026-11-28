// HI-3616 round 1 (HR1's findings): cw_preview's Combwork side with its neighbours stood in for. A lease that ends or
// passes on between the place's resolution and the act refuses it (a builder's slot, a returned review copy) and never
// starts or stops the next holder's preview; the ports' owners are checked before a load; a preview's close during a
// capture, or its stop before the save, leaves no file; a capture past its deadline times out; the source now is read at
// the capture and compared with the page's load.
import { readdir } from 'fs/promises'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreviewPlace, PreviewSource, PreviewView } from '../src/shared/preview'
import { tempDir } from './tempDir'

const state = vi.hoisted(() => ({
  places: [] as unknown[],
  copies: null as unknown,
  cwd: '' as string,
  runner: null as unknown,
  guard: null as unknown,
  started: [] as unknown[],
  startThrows: null as unknown,
  shotsDir: '' as string,
  seconds: 10
}))

vi.mock('../src/main/advanced', () => ({ advanced: { number: () => state.seconds } }))
vi.mock('../src/main/slotsApp', () => ({ poolIfMade: () => null }))
vi.mock('../src/main/sessions', () => ({ sessions: { liveFor: () => ({ cwd: state.cwd }) } }))
vi.mock('../src/main/copiesApp', () => ({ copiesFor: async () => state.copies }))
vi.mock('../src/main/previewApp', () => {
  class PlaceMoved extends Error {}
  return {
    PlaceMoved,
    // Each resolution takes the next place queued (the last one stays): a lease turning over between two calls.
    placeOf: async () => (state.places.length > 1 ? state.places.shift() : state.places[0]),
    previewForAgents: () => ({ runner: state.runner, guard: async () => state.guard }),
    shotsDirIn: () => state.shotsDir,
    startPreview: async (...a: unknown[]) => {
      if (state.startThrows) throw state.startThrows
      state.started.push(a)
      return null
    }
  }
})

const { agentPreview, PreviewRefused } = await import('../src/main/previewAgent')
const { closeOps } = await import('../src/main/previewCapture')
const { PlaceMoved } = await import('../src/main/previewApp')

const ws = {} as never
const clean: PreviewSource = { kind: 'clean', commit: 'a'.repeat(40) }
const slot = (gen: string): PreviewPlace => ({ kind: 'slot', name: 'slot-a', folder: 'C:\\ws.worktrees\\p\\slot-a', generation: gen })
let n = 0
const view = (place: PreviewPlace, over: Partial<PreviewView> = {}): PreviewView => ({ id: `pv-${++n}`, projectPath: 'C:\\ws\\p', place, state: 'running', port: 46001, hmrPort: null, url: 'http://127.0.0.1:46001/', startedAt: '', readyAt: '', stoppedAt: null, end: null, source: clean, changedAt: null, held: false, logPath: null, ...over })

function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => undefined
  const wait = new Promise<void>((r) => (open = r))
  return { wait, open }
}

/** A runner holding one view; its stop, ownership and source reads recorded. */
function runnerWith(v: PreviewView | null, o: { owned?: boolean; source?: () => PreviewSource } = {}) {
  return {
    at: vi.fn(() => v),
    stop: vi.fn(async () => undefined),
    checkOwnership: vi.fn(async () => (o.owned === false ? { ok: false, end: { kind: 'stranger', port: 46001, pid: 9 } } : { ok: true })),
    sourceNow: vi.fn(async () => ({ now: o.source ? o.source() : clean, changed: false }))
  }
}

/** An agents' page whose DevTools screenshot waits on `shot` (when given), its loads and paints recorded. */
function pageWith(o: { shot?: Promise<void> } = {}) {
  const handlers = new Set<(...a: unknown[]) => void>()
  const loads: string[] = []
  const page = {
    console: [],
    consoleTotal: 0,
    loadedAt: null as number | null,
    loadSource: null as PreviewSource | null,
    win: {
      isDestroyed: () => false,
      getContentSize: () => [1280, 800],
      setContentSize: () => undefined,
      webContents: {
        session: { clearCache: async () => undefined },
        loadURL: async (u: string) => {
          loads.push(u)
          page.loadedAt = Date.now()
        },
        getURL: () => 'http://127.0.0.1:46001/',
        getTitle: () => 'Home',
        on: (_e: string, f: (...a: unknown[]) => void) => handlers.add(f),
        off: (_e: string, f: (...a: unknown[]) => void) => handlers.delete(f),
        invalidate: () => {
          for (const f of [...handlers]) f(null, null, { getSize: () => ({ width: 1280, height: 800 }) })
        },
        debugger: {
          isAttached: () => true,
          attach: () => undefined,
          sendCommand: async (method: string) => {
            if (method === 'Accessibility.getFullAXTree') return { nodes: [{ nodeId: '1', role: { value: 'heading' }, name: { value: 'Hello' } }] }
            if (method === 'Page.captureScreenshot') {
              await o.shot
              return { data: Buffer.from('png').toString('base64') }
            }
            return {}
          }
        }
      }
    }
  }
  return { page, loads, guard: { agentPage: async () => page } }
}

const refusal = (p: Promise<unknown>) => p.then(() => null, (e) => (e instanceof PreviewRefused ? e.code : String(e)))

beforeEach(() => {
  state.places = []
  state.copies = null
  state.cwd = 'C:\\ws.worktrees\\p\\slot-a'
  state.started = []
  state.startThrows = null
  state.shotsDir = join(tempDir('preview-agent'), 'shots')
  state.seconds = 10
})

describe('its place, checked again before each act', () => {
  it("a builder's slot lease that turns over before the start: refused, nothing started", async () => {
    state.places = [slot('lease-1'), slot('lease-2')]
    state.runner = runnerWith(null)
    expect(await refusal(agentPreview(ws, 'C:\\ws\\p', 'a-1', { action: 'start' }))).toBe('placeChanged')
    expect(state.started).toEqual([])
  })
  it('a start under its own lease passes the lease to the start, which refuses a place moved meanwhile', async () => {
    state.places = [slot('lease-1')]
    state.runner = runnerWith(null)
    await agentPreview(ws, 'C:\\ws\\p', 'a-1', { action: 'start' })
    expect(state.started[0]).toEqual([ws, 'C:\\ws\\p', slot('lease-1').folder, { generation: 'lease-1' }])
    state.startThrows = new PlaceMoved()
    expect(await refusal(agentPreview(ws, 'C:\\ws\\p', 'a-1', { action: 'start' }))).toBe('placeChanged')
  })
  it("a lease that turns over before the stop: refused, and the next holder's preview isn't stopped", async () => {
    state.places = [slot('lease-1'), slot('lease-2')]
    const next = view(slot('lease-2'))
    state.runner = runnerWith(next)
    expect(await refusal(agentPreview(ws, 'C:\\ws\\p', 'a-1', { action: 'stop' }))).toBe('placeChanged')
    expect((state.runner as ReturnType<typeof runnerWith>).stop).not.toHaveBeenCalled()
  })
  it("a stop under its own lease stops its own preview by its id; another lease's in the folder is never stopped", async () => {
    state.places = [slot('lease-1')]
    const other = view(slot('lease-9'))
    state.runner = runnerWith(other)
    await agentPreview(ws, 'C:\\ws\\p', 'a-1', { action: 'stop' })
    expect((state.runner as ReturnType<typeof runnerWith>).stop).not.toHaveBeenCalled()
    const own = view(slot('lease-1'))
    state.runner = runnerWith(own)
    await agentPreview(ws, 'C:\\ws\\p', 'a-1', { action: 'stop' })
    expect((state.runner as ReturnType<typeof runnerWith>).stop).toHaveBeenCalledWith(own.id, { kind: 'stopped' })
  })
  it('a review copy returned before the act: its place is no longer the copy, so the act is refused', async () => {
    const copy: PreviewPlace = { kind: 'copy', name: 'copy-1', folder: 'C:\\ws.copies\\p\\copy-1', generation: 'review-7' }
    const project: PreviewPlace = { kind: 'project', name: 'p', folder: 'C:\\ws\\p', generation: 'project' }
    const lease = { id: 'review-7', agent: 'a-r', kind: 'review', copy: 'copy-1', returned: false, card: 12 }
    state.copies = { unfreed: () => [lease], copies: () => [{ name: 'copy-1', folder: copy.folder }] }
    state.places = [copy, project]
    state.cwd = 'C:\\ws\\p'
    state.runner = runnerWith(view(copy))
    expect(await refusal(agentPreview(ws, 'C:\\ws\\p', 'a-r', { action: 'stop' }))).toBe('placeChanged')
    expect((state.runner as ReturnType<typeof runnerWith>).stop).not.toHaveBeenCalled()
  })
})

describe('captures', () => {
  it("a stranger on its port: refused before any load (the runner's check stops the preview)", async () => {
    state.places = [slot('lease-1')]
    state.runner = runnerWith(view(slot('lease-1')), { owned: false })
    const p = pageWith()
    state.guard = p.guard
    expect(await refusal(agentPreview(ws, 'C:\\ws\\p', 'a-1', { action: 'snapshot' }))).toBe('notOwned')
    expect(await refusal(agentPreview(ws, 'C:\\ws\\p', 'a-1', { action: 'goto', path: '/x' }))).toBe('notOwned')
    expect(p.loads).toEqual([])
  })
  it('the owners are checked before every capture, a page loaded earlier included', async () => {
    state.places = [slot('lease-1')]
    const r = runnerWith(view(slot('lease-1')))
    state.runner = r
    state.guard = pageWith().guard
    await agentPreview(ws, 'C:\\ws\\p', 'a-1', { action: 'snapshot' })
    await agentPreview(ws, 'C:\\ws\\p', 'a-1', { action: 'console' })
    expect(r.checkOwnership).toHaveBeenCalledTimes(2)
  })
  it("its preview's close while a screenshot is held: refused, no file, and the close waits for it", async () => {
    state.places = [slot('lease-1')]
    const v = view(slot('lease-1'))
    state.runner = runnerWith(v)
    const held = gate()
    state.guard = pageWith({ shot: held.wait }).guard
    const shot = refusal(agentPreview(ws, 'C:\\ws\\p', 'a-1', { action: 'screenshot' }))
    await vi.waitFor(async () => expect((await import('../src/main/previewCapture')).opsRunning(v.id)).toBe(1))
    const closing = closeOps(v.id, 60_000)
    expect(await shot).toBe('notRunning')
    held.open()
    await closing
    expect(await readdir(state.shotsDir).catch(() => [])).toEqual([])
  })
  it('its preview stopped between the capture and the save: refused, no file', async () => {
    state.places = [slot('lease-1')]
    const v = view(slot('lease-1'))
    const r = runnerWith(v)
    state.runner = r
    const held = gate()
    state.guard = pageWith({ shot: held.wait }).guard
    const shot = refusal(agentPreview(ws, 'C:\\ws\\p', 'a-1', { action: 'screenshot' }))
    await vi.waitFor(() => expect(r.checkOwnership).toHaveBeenCalled())
    r.at.mockReturnValue({ ...v, state: 'stopped' })
    held.open()
    expect(await shot).toBe('notRunning')
    expect(await readdir(state.shotsDir).catch(() => [])).toEqual([])
  })
  it('a screenshot slower than the capture time: timed out, no file', async () => {
    state.places = [slot('lease-1')]
    state.seconds = 2
    state.runner = runnerWith(view(slot('lease-1')))
    const held = gate()
    state.guard = pageWith({ shot: held.wait }).guard
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const shot = refusal(agentPreview(ws, 'C:\\ws\\p', 'a-1', { action: 'screenshot' }))
      await vi.advanceTimersByTimeAsync(2500)
      expect(await shot).toBe('timedOut')
    } finally {
      vi.useRealTimers()
    }
    held.open()
    await new Promise((r) => setImmediate(r))
    expect(await readdir(state.shotsDir).catch(() => [])).toEqual([])
  })
  it('the source is read again at each capture and compared with the source at the load', async () => {
    state.places = [slot('lease-1')]
    let src: PreviewSource = clean
    state.runner = runnerWith(view(slot('lease-1')), { source: () => src })
    state.guard = pageWith().guard
    const a = (await agentPreview(ws, 'C:\\ws\\p', 'a-1', { action: 'snapshot' })) as { notes: { sinceLoad: string; sinceStart: string } }
    expect(a.notes).toMatchObject({ sinceLoad: 'same', sinceStart: 'same' })
    src = { kind: 'dirty', commit: 'a'.repeat(40), content: 'b'.repeat(40) }
    const b = (await agentPreview(ws, 'C:\\ws\\p', 'a-1', { action: 'snapshot' })) as { notes: { sinceLoad: string; sinceStart: string; sourceNow: PreviewSource } }
    expect(b.notes).toMatchObject({ sinceLoad: 'changed', sinceStart: 'changed', sourceNow: src })
    // Reloaded: the page has the files now, the server still started from the older ones.
    const c = (await agentPreview(ws, 'C:\\ws\\p', 'a-1', { action: 'goto', path: '/' })) as { notes: { sinceLoad: string; sinceStart: string } }
    expect(c.notes).toMatchObject({ sinceLoad: 'same', sinceStart: 'changed' })
    src = { kind: 'unknown', commit: null, why: 'clean filter failed' }
    const d = (await agentPreview(ws, 'C:\\ws\\p', 'a-1', { action: 'console' })) as { notes: { sinceLoad: string } }
    expect(d.notes.sinceLoad).toBe('unknown')
  })
})
