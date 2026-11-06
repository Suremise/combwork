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
  modeOfferAgents: Map<string, Map<string, string>>
  modeOffers: Map<string, unknown>
  applyModeSettings: (only?: ReadonlyMap<string, string>) => Promise<{ switched: string[]; skipped: string[] }>
  noticeModeSetting: (l: unknown, mode: string) => void
  agentDef: (p: string, a: string) => Promise<unknown>
  effective: (p: string, provider: unknown) => Promise<{ permissionMode: string | null }>
  resumeProvider: (...a: unknown[]) => Promise<unknown>
}

describe("a notice's button acts for its own offer only", () => {
  const ws = tempDir('cw-session-offers-')
  const home = join(ws, '.combwork', 'assistant')
  const id = `${home.toLowerCase()}#assistant`
  let sessions: typeof import('../src/main/sessions').sessions
  let s: Internals
  let dispose: () => Promise<void>
  let service: { sessionsFile: (p: string) => Promise<unknown> }

  beforeEach(async () => {
    const workspace = await import('../src/main/workspace')
    const w = workspace.createWorkspaceService()
    w.path = ws
    service = w as never
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
    s.modeOffers.clear()
    vi.restoreAllMocks()
    vi.useRealTimers()
    ;(await import('../src/main/notify')).resetOffers()
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

  it('Switch Now: an open offer switches only the agents it named, into the modes it named', async () => {
    s.modeOfferAgents.set('modes:7', new Map([['c:\\work\\alpha#a1', 'acceptEdits']]))
    const apply = vi.spyOn(s, 'applyModeSettings').mockResolvedValue({ switched: [], skipped: [] })
    await sessions.applyModeOffer('modes:7')
    expect([...(apply.mock.calls[0][0] ?? new Map())]).toEqual([['c:\\work\\alpha#a1', 'acceptEdits']])
  })

  it('Switch Now: an old OPEN offer, then a newer saved mode (a newer offer): the old one is superseded, and its click switches nothing (HR2 round 2)', async () => {
    vi.useFakeTimers()
    const l = { state: { projectPath: home, agentId: 'assistant', sessionId: 's1', status: 'finished', provider: 'claude-code', permissionMode: 'default' }, configuredMode: 'default', offeredMode: undefined }
    s.live.set(id, l)
    s.noticeModeSetting(l, 'acceptEdits')
    await vi.advanceTimersByTimeAsync(500)
    const [first] = [...s.modeOfferAgents.keys()]
    expect(s.modeOfferAgents.get(first)?.get(id)).toBe('acceptEdits')
    s.noticeModeSetting(l, 'bypassPermissions')
    await vi.advanceTimersByTimeAsync(500)
    expect(s.modeOfferAgents.has(first)).toBe(false)
    expect(R.resolutions.find((r) => r.offer === first)?.outcome).toBe('Settings changed since: nothing switched')
    const apply = vi.spyOn(s, 'applyModeSettings')
    await sessions.applyModeOffer(first)
    expect(apply).not.toHaveBeenCalled()
  })

  it('Switch Now: the setting changed since its notice (no newer offer yet): its click switches nothing and says so', async () => {
    running('s1')
    s.modeOfferAgents.set('modes:9', new Map([[id, 'acceptEdits']]))
    vi.spyOn(s, 'agentDef').mockResolvedValue({ agent: { id: 'assistant', name: 'Assistant', provider: 'claude-code' } })
    vi.spyOn(s, 'effective').mockResolvedValue({ permissionMode: 'plan' })
    const apply = vi.spyOn(s, 'applyModeSettings')
    expect(await sessions.applyModeOffer('modes:9')).toEqual({ switched: [], skipped: [] })
    expect(apply).not.toHaveBeenCalled()
    expect(R.resolutions).toEqual([{ offer: 'modes:9', outcome: 'Settings changed since: nothing switched' }])
  })

  it('Stop It and Resume: the agent started meanwhile (during its own waits): nothing is stopped or started, and it says so', async () => {
    const { tell } = await import('../src/main/notify')
    tell({ kind: 'warning', title: 'background', offer: `bg:${id}#job1#s1` })
    vi.spyOn(s, 'agentDef').mockImplementation(async () => {
      // A competing start lands while the handler waits.
      running('s9')
      return { agent: { id: 'assistant', name: 'Assistant', provider: 'claude-code' }, count: 1 }
    })
    vi.spyOn(service, 'sessionsFile').mockResolvedValue({ sessions: [] })
    vi.spyOn(s, 'resumeProvider').mockResolvedValue(null)
    const start = vi.spyOn(sessions, 'start')
    await sessions.stopBackgroundAndResume(home, 'assistant', 'job1', 's1', `bg:${id}#job1#s1`)
    expect(start).not.toHaveBeenCalled()
    expect(R.resolutions).toEqual([{ offer: `bg:${id}#job1#s1`, outcome: 'It runs another conversation here now' }])
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
