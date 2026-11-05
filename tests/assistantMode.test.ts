import { beforeEach, describe, expect, it, vi } from 'vitest'

// main/assistantMode.ts with its services stood in for: what the Assistant is told when (#259, #334). A gate holds a
// mode read or a prompt being typed, so a switch can land in the middle of a resume's check or of a delivery.
const st = vi.hoisted(() => ({
  home: 'C:\\ws\\.combwork\\assistant',
  live: null as { runId: string; status: string; sessionId: string } | null,
  saved: 'launch',
  record: undefined as string | undefined,
  told: [] as string[],
  recorded: [] as string[],
  delivering: false,
  holdRead: null as { id: string; until: Promise<void> } | null,
  holdSend: null as Promise<void> | null,
  // Holds the next save before it has project.json's lock (still waiting for it, as Combwork's file lock retries), once.
  holdSave: null as Promise<void> | null,
  lock: Promise.resolve() as Promise<unknown>,
  onStatus: null as ((e: unknown) => void) | null
}))

vi.mock('../src/main/logger', () => ({ createLogger: () => ({ info: () => undefined, warn: () => undefined, debug: () => undefined }), userText: (s: string) => s }))
vi.mock('../src/main/config', () => ({ config: { settings: {} } }))
vi.mock('../src/main/events', () => ({ onHiveEvent: (fn: (e: unknown) => void) => (st.onStatus = fn) }))
vi.mock('../src/main/modes', () => ({
  readMode: async (id: string) => {
    if (st.holdRead?.id === id) await st.holdRead.until
    return { id, name: id.toUpperCase(), summary: `Habits of ${id}.`, body: '' }
  }
}))
vi.mock('../src/main/workspace', () => {
  const ws = {
    sessionsFile: async () => ({ sessions: [{ id: 's1', mode: st.record }] }),
    projectConfig: async () => ({ agents: [{ id: 'assistant', mode: st.saved }] })
  }
  return {
    workspace: {
      get assistantHome() {
        return st.home
      },
      // As Combwork's: one writer at a time, each reading the file inside the lock.
      mutateProjectConfig: async (_home: string, fn: (cfg: { agents: { id: string; name: string; mode?: string }[] }) => { agents?: { id: string; mode?: string }[] }) => {
        const hold = st.holdSave
        st.holdSave = null
        if (hold) await hold
        const run = st.lock.then(async () => {
          const next = fn({ agents: [{ id: 'assistant', name: 'Combwork Assistant', mode: st.saved }] })
          if (next.agents) st.saved = next.agents[0].mode ?? ''
        })
        st.lock = run.catch(() => undefined)
        await run
      }
    },
    workspaceOf: () => ws,
    inWorkspace: (_w: unknown, fn: () => unknown) => fn()
  }
})
vi.mock('../src/main/sessions', () => ({
  sessions: {
    onAssistantResumed: () => undefined,
    liveFor: () => st.live,
    userMayBeTyping: () => false,
    // As Combwork's: one prompt at a time, and the guard checked again before Enter.
    sendPrompt: async (_home: string, _agent: string, text: string, guard: () => void) => {
      if (st.delivering) throw new Error('Combwork is already typing a prompt into this agent; it is busy.')
      st.delivering = true
      try {
        guard()
        if (st.holdSend) await st.holdSend
        guard()
        st.told.push(text.replace(/^\[CW\] Mode: (\w+).*$/, '$1'))
      } finally {
        st.delivering = false
      }
    },
    modeGiven: async (_home: string, _agent: string, runId: string, mode: string) => {
      if (st.live?.runId === runId) st.recorded.push(mode)
    }
  }
}))

// The delivery service (#649) as assistantMode uses it, stood in for: one mode message waiting per home (a newer one made
// again from a newer switch), ended once its launch has, made again just before it is offered (one no longer due is
// dropped), typed only while it holds, received once typed, and tried again when the Assistant is next idle.
vi.mock('../src/main/deliveries', async () => {
  const { sessions } = await import('../src/main/sessions')
  const { onHiveEvent } = await import('../src/main/events')
  type R = { id: string; source?: string; ref?: string; body: string; forRun?: string; meta?: Record<string, unknown> }
  type Source = { refresh?: (r: R, host: string) => Promise<{ cancel: string } | { body: string } | null>; holds?: (r: R, host: string) => boolean; received?: (r: R, host: string) => void }
  const sources = new Map<string, Source>()
  let waiting: R | null = null
  let n = 0
  const idle = (): boolean => !!st.live && ['ready', 'finished', 'watching'].includes(st.live.status)
  const offerNow = async (host: string, agentId: string): Promise<boolean> => {
    const r = waiting
    if (!r || !idle()) return false
    const src = r.source ? sources.get(r.source) : undefined
    if (st.live?.runId !== r.forRun) {
      if (waiting === r) waiting = null
      return false
    }
    const f = await src?.refresh?.(r, host)
    if (f && 'cancel' in f) {
      if (waiting === r) waiting = null
      return false
    }
    try {
      await (sessions as unknown as { sendPrompt: (h: string, a: string, t: string, g: () => void) => Promise<void> }).sendPrompt(host, agentId, r.body, () => {
        if (src?.holds && !src.holds(r, host)) throw new Error('It no longer holds.')
        if (!idle()) throw new Error('The Assistant got busy.')
      })
    } catch {
      return false
    }
    if (waiting === r) waiting = null
    src?.received?.(r, host)
    return true
  }
  onHiveEvent((e: unknown) => {
    const ev = e as { type: string; state: { projectPath: string; agentId: string; status: string } }
    if (ev.type === 'session-status' && ['ready', 'finished', 'watching'].includes(ev.state.status)) setTimeout(() => void offerNow(ev.state.projectPath, ev.state.agentId), 500)
  })
  return {
    registerSource: (name: string, s: Source) => sources.set(name, s),
    createDelivery: async (_host: string, nd: Omit<R, 'id'>) => {
      waiting = waiting && waiting.ref === nd.ref ? { ...waiting, ...nd, id: waiting.id } : { ...nd, id: `m${++n}` }
      return waiting
    },
    offerNow
  }
})

const gate = (): { until: Promise<void>; open: () => void } => {
  let open = (): void => undefined
  const until = new Promise<void>((r) => (open = r))
  return { until, open }
}
const settle = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms))

type Mod = typeof import('../src/main/assistantMode')
let mod: Mod
let sessions: { onAssistantResumed: (home: string, runId: string, sessionId: string, mode: string) => void }
beforeEach(async () => {
  Object.assign(st, { live: { runId: 'r1', status: 'ready', sessionId: 's1' }, saved: 'launch', record: undefined, told: [], recorded: [], delivering: false, holdRead: null, holdSend: null, holdSave: null, lock: Promise.resolve() })
  vi.resetModules()
  mod = await import('../src/main/assistantMode')
  sessions = (await import('../src/main/sessions')).sessions as never
  mod.initAssistantModes()
})
/** Combwork's status event for the Assistant becoming idle: a waiting message is typed half a second later. */
const idleAgain = async (): Promise<void> => {
  st.onStatus?.({ type: 'session-status', state: { agentId: 'assistant', projectPath: st.home, status: 'ready' } })
  await settle(600)
}

describe('the Assistant resumed in a mode (#334)', () => {
  it('tells a resumed conversation its mode once, unless that is the mode it was last given', async () => {
    st.record = 'old'
    sessions.onAssistantResumed(st.home, 'r1', 's1', 'launch')
    await settle()
    expect(st.told).toEqual(['LAUNCH'])
    expect(st.recorded).toEqual(['launch'])
    st.record = 'launch'
    sessions.onAssistantResumed(st.home, 'r1', 's1', 'launch')
    await settle()
    expect(st.told).toEqual(['LAUNCH'])
  })

  it('a conversation with no mode recorded (from before) is told too', async () => {
    sessions.onAssistantResumed(st.home, 'r1', 's1', 'launch')
    await settle()
    expect(st.told).toEqual(['LAUNCH'])
  })

  it('a switch completed while the resume reads its mode wins: the older mode is never told after it', async () => {
    st.record = 'old'
    const g = gate()
    st.holdRead = { id: 'launch', until: g.until }
    sessions.onAssistantResumed(st.home, 'r1', 's1', 'launch')
    await settle()
    expect(await mod.switchMode('new')).toBe('told')
    g.open()
    await settle()
    await idleAgain()
    expect(st.told).toEqual(['NEW'])
    expect(st.recorded).toEqual(['new'])
  })

  it('a switch whose message is still being typed when the resume check ends wins too', async () => {
    st.record = 'old'
    const read = gate()
    st.holdRead = { id: 'launch', until: read.until }
    sessions.onAssistantResumed(st.home, 'r1', 's1', 'launch')
    await settle()
    const send = gate()
    st.holdSend = send.until
    const switched = mod.switchMode('new')
    await settle()
    read.open()
    await settle()
    st.holdSend = null
    send.open()
    expect(await switched).toBe('told')
    await idleAgain()
    expect(st.told).toEqual(['NEW'])
    expect(st.recorded).toEqual(['new'])
  })

  it('a resume message being typed when a switch comes is dropped, and the switch is told after it', async () => {
    st.record = 'old'
    const send = gate()
    st.holdSend = send.until
    sessions.onAssistantResumed(st.home, 'r1', 's1', 'launch')
    await settle()
    expect(await mod.switchMode('new')).toBe('later')
    st.holdSend = null
    send.open()
    await settle()
    await idleAgain()
    expect(st.told).toEqual(['NEW'])
    expect(st.recorded).toEqual(['new'])
  })

  it('a resume message waiting for the Assistant to be idle is replaced by a newer switch', async () => {
    st.record = 'old'
    st.live!.status = 'working'
    sessions.onAssistantResumed(st.home, 'r1', 's1', 'launch')
    await settle()
    expect(await mod.switchMode('new')).toBe('later')
    st.live!.status = 'ready'
    await idleAgain()
    expect(st.told).toEqual(['NEW'])
  })

  it('a mode chosen after the launch read its mode is left to that switch', async () => {
    st.record = 'old'
    st.saved = 'new'
    sessions.onAssistantResumed(st.home, 'r1', 's1', 'launch')
    await settle()
    expect(st.told).toEqual([])
  })

  it('nothing is told to a run that has stopped or been restarted', async () => {
    st.record = 'old'
    sessions.onAssistantResumed(st.home, 'r0', 's1', 'launch')
    await settle()
    expect(st.told).toEqual([])
  })
})

describe('two switches, the newer finishing first (#334)', () => {
  it('while it runs: the newer is told, recorded and saved, though the older read its mode last', async () => {
    const g = gate()
    st.holdRead = { id: 'older', until: g.until }
    const older = mod.switchMode('older')
    await settle()
    expect(await mod.switchMode('newer')).toBe('told')
    g.open()
    expect(await older).toBe('saved')
    await idleAgain()
    expect(st.told).toEqual(['NEWER'])
    expect(st.recorded).toEqual(['newer'])
    expect(st.saved).toBe('newer')
  })

  it('while it is stopped: the newer is saved', async () => {
    st.live = null
    const g = gate()
    st.holdRead = { id: 'older', until: g.until }
    const older = mod.switchMode('older')
    await settle()
    expect(await mod.switchMode('newer')).toBe('saved')
    g.open()
    expect(await older).toBe('saved')
    expect(st.saved).toBe('newer')
  })

  it('an older save still waiting for the lock writes nothing over the newer choice', async () => {
    const g = gate()
    st.holdSave = g.until
    const older = mod.switchMode('older')
    await settle()
    const newer = mod.switchMode('newer')
    await settle()
    g.open()
    expect(await older).toBe('saved')
    expect(await newer).toBe('told')
    await idleAgain()
    expect(st.saved).toBe('newer')
    expect(st.told).toEqual(['NEWER'])
    expect(st.recorded).toEqual(['newer'])
  })

  it('…and while it is stopped', async () => {
    st.live = null
    const g = gate()
    st.holdSave = g.until
    const older = mod.switchMode('older')
    await settle()
    const newer = mod.switchMode('newer')
    g.open()
    await Promise.all([older, newer])
    expect(st.saved).toBe('newer')
  })

  it('one after the other, both are told and the last is saved', async () => {
    expect(await mod.switchMode('older')).toBe('told')
    expect(await mod.switchMode('newer')).toBe('told')
    expect(st.told).toEqual(['OLDER', 'NEWER'])
    expect(st.recorded).toEqual(['older', 'newer'])
    expect(st.saved).toBe('newer')
  })
})
