// HI-2320 (HR2's round 1): each notice's button carries its own offer through its command to its handler, and the
// handler acts only for that offer: an old notice's Allow answers no newer ask, its Switch Now switches no session
// begun since, its Stop It and Resume stops nothing once the agent runs, and its Hand Over to… is for its own
// conversation only. A stale one resolves its own entry and changes nothing. Through SessionManager's real handlers,
// with the Assistant's home as the session host (no project needed) and fake live sessions.
import { realpathSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

const R = vi.hoisted(() => ({ resolutions: [] as { offer: string; outcome: string }[] }))
vi.mock('../src/main/notify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/notify')>()
  return {
    ...actual,
    resolveOffer: (offer: string, outcome: string) => {
      R.resolutions.push({ offer, outcome })
      return actual.resolveOffer(offer, outcome)
    }
  }
})

type Internals = {
  live: Map<string, unknown>
  lockAsked: Map<string, number>
  lockAllowed: Map<string, number>
  modeOfferAgents: Map<string, Set<string>>
  applyModeSettings: (only?: ReadonlySet<string>) => Promise<{ switched: string[]; skipped: string[] }>
}

describe("a notice's button acts for its own offer only", () => {
  const ws = tempDir('hive-session-offers-')
  const home = join(ws, '.hive', 'assistant')
  const id = `${home.toLowerCase()}#assistant`
  let sessions: typeof import('../src/main/sessions').sessions
  let s: Internals
  let dispose: () => Promise<void>

  beforeEach(async () => {
    const workspace = await import('../src/main/workspace')
    const w = workspace.createWorkspaceService()
    w.path = ws
    dispose = () => workspace.disposeWorkspaceService(w)
    sessions = (await import('../src/main/sessions')).sessions
    s = sessions as unknown as Internals
    R.resolutions.length = 0
  })
  afterEach(async () => {
    s.live.delete(id)
    s.lockAsked.clear()
    s.lockAllowed.clear()
    s.modeOfferAgents.clear()
    vi.restoreAllMocks()
    await dispose()
  })
  const running = (sessionId: string) => s.live.set(id, { state: { projectPath: home, agentId: 'assistant', sessionId, status: 'finished' }, goAheads: undefined })

  it("Allow: an old notice's (its ask's sequence) answers no newer ask of the same file, and says it no longer applies; the current one allows", async () => {
    running('s1')
    const file = join(ws, 'a.txt')
    writeFileSync(file, 'x')
    const key = `${id}|${realpathSync.native(file).toLowerCase()}`
    // Ask 1 was let go, ask 2 is open now.
    s.lockAsked.set(key, 2)
    await sessions.allowLockedEdit(home, 'assistant', file, `lock:${key}#1`)
    expect(s.lockAllowed.has(key)).toBe(false)
    expect(R.resolutions).toEqual([{ offer: `lock:${key}#1`, outcome: 'No longer asked' }])
    await sessions.allowLockedEdit(home, 'assistant', file, `lock:${key}#2`).catch(() => undefined)
    expect(s.lockAllowed.has(key)).toBe(true)
    expect(R.resolutions.at(-1)).toEqual({ offer: `lock:${key}#2`, outcome: 'Allowed' })
  })

  it('Switch Now: an offer already closed switches nothing (no session begun since is touched)', async () => {
    const apply = vi.spyOn(s, 'applyModeSettings')
    const r = await sessions.applyModeOffer('modes:old-closed')
    expect(r).toEqual({ switched: [], skipped: [] })
    expect(apply).not.toHaveBeenCalled()
    expect(R.resolutions).toEqual([{ offer: 'modes:old-closed', outcome: 'Nothing to switch: every running agent is in its mode' }])
  })

  it('Switch Now: an open offer switches only the agents it named', async () => {
    s.modeOfferAgents.set('modes:7', new Set(['c:\\work\\alpha#a1']))
    const apply = vi.spyOn(s, 'applyModeSettings').mockResolvedValue({ switched: [], skipped: [] })
    await sessions.applyModeOffer('modes:7')
    expect([...(apply.mock.calls[0][0] ?? [])]).toEqual(['c:\\work\\alpha#a1'])
  })

  it('Stop It and Resume: an offer no longer open does nothing; with the agent running (another conversation), it stops nothing and says so', async () => {
    running('s2')
    // Not open (resolved before, or never told): nothing at all.
    await sessions.stopBackgroundAndResume(home, 'assistant', 'job1', 's1', `bg:${id}#job1#s1`)
    expect(R.resolutions).toEqual([])
    // Open: the agent runs another conversation, so its job isn't stopped.
    const { tell } = await import('../src/main/notify')
    tell({ kind: 'warning', title: 'background', offer: `bg:${id}#job1#s1` })
    await sessions.stopBackgroundAndResume(home, 'assistant', 'job1', 's1', `bg:${id}#job1#s1`)
    expect(R.resolutions).toEqual([{ offer: `bg:${id}#job1#s1`, outcome: 'It runs another conversation here now' }])
  })

  it("Hand Over to…: for its own conversation only; the agent on another, the notice says so and nothing opens", () => {
    running('s2')
    expect(sessions.handOverOfferCurrent(home, 'assistant', 's2')).toBe(true)
    expect(sessions.handOverOfferCurrent(home, 'assistant', 's1')).toBe(false)
    expect(R.resolutions).toEqual([{ offer: `transcript:${id}#s1`, outcome: 'It has a new conversation now' }])
  })
})
