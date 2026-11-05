// A waiting agent's pop-up stays until it is answered (#157); main tells every window once the agent no longer asks
// (src/main/notices.ts), and its entries say so (HI-2320).
import { afterEach, describe, expect, it } from 'vitest'
import { emit, onCombworkEvent } from '../src/main/events'
import { startNoticeResolver } from '../src/main/notices'
import { askOffer, resetOffers, setNotifyHost, tell } from '../src/main/notify'
import type { CombworkEvent, LiveSessionState } from '../src/shared/types'

const state = (agentId: string, status: LiveSessionState['status'], question?: string): LiveSessionState =>
  ({ projectPath: 'C:\\Work\\Alpha', agentId, status, ...(question ? { question } : {}) }) as LiveSessionState

describe('closing waiting banners', () => {
  it('once an agent stops asking, or its session ends, every window hears it; never for one that was not asking', () => {
    const stop = startNoticeResolver()
    const resolved: string[] = []
    const off = onCombworkEvent((e: CombworkEvent) => {
      if (e.type === 'notice-resolved') resolved.push(e.agentId)
    })
    try {
      emit({ type: 'session-status', state: state('a1', 'working') })
      emit({ type: 'session-status', state: state('a1', 'finished') })
      expect(resolved).toEqual([])
      emit({ type: 'session-status', state: state('a1', 'waiting') })
      emit({ type: 'session-status', state: state('a1', 'waiting') })
      expect(resolved).toEqual([])
      // Answered: it works again.
      emit({ type: 'session-status', state: state('a1', 'working') })
      expect(resolved).toEqual(['a1'])
      // A question while it works counts as asking; answered, it resolves.
      emit({ type: 'session-status', state: state('a2', 'working', 'Which branch?') })
      emit({ type: 'session-status', state: state('a2', 'working') })
      expect(resolved).toEqual(['a1', 'a2'])
      // Waiting, then the session ends.
      emit({ type: 'session-status', state: state('a3', 'waiting') })
      emit({ type: 'session-exit', projectPath: 'C:\\Work\\Alpha', agentId: 'a3', sessionId: 's', exitCode: 0 })
      expect(resolved).toEqual(['a1', 'a2', 'a3'])
      emit({ type: 'session-exit', projectPath: 'C:\\Work\\Alpha', agentId: 'a3', sessionId: 's', exitCode: 0 })
      expect(resolved).toEqual(['a1', 'a2', 'a3'])
    } finally {
      off()
      stop()
    }
  })
})

// HI-2320: each ask is its own offer, so answering an old ask never touches the entry of a newer one.
describe('a waiting agent\'s entries, by ask', () => {
  afterEach(() => resetOffers())
  it('the agent no longer asking resolves the entries of its asks so far, never a later ask\'s', () => {
    const stop = startNoticeResolver()
    const resolved: { ids: string[]; outcome: string }[] = []
    const off = onCombworkEvent((e: CombworkEvent) => {
      if (e.type === 'toast-resolved') resolved.push({ ids: e.ids, outcome: e.outcome })
    })
    const owner = { isDestroyed: () => false, webContents: { id: 3, send: () => undefined } }
    setNotifyHost({ focused: () => ({ win: owner as never, workspacePath: 'C:\\Work', projectPath: 'C:\\Work\\Alpha' }), fallback: () => owner as never, workspaceOf: () => 'C:\\Work' })
    try {
      const first = tell({ kind: 'needsYou', title: 'Alpha · a1 needs your input', projectPath: 'C:\\Work\\Alpha', agentId: 'a1', offer: askOffer('C:\\Work\\Alpha', 'a1') })
      emit({ type: 'session-status', state: state('a1', 'waiting') })
      emit({ type: 'session-status', state: state('a1', 'working') })
      expect(resolved).toEqual([{ ids: [first.id], outcome: 'Answered' }])
      // A new ask: a new offer; its answer resolves it alone.
      const second = tell({ kind: 'needsYou', title: 'Alpha · a1 needs your input', projectPath: 'C:\\Work\\Alpha', agentId: 'a1', offer: askOffer('C:\\Work\\Alpha', 'a1') })
      emit({ type: 'session-status', state: state('a1', 'waiting') })
      emit({ type: 'session-exit', projectPath: 'C:\\Work\\Alpha', agentId: 'a1', sessionId: 's', exitCode: 0 })
      expect(resolved).toEqual([
        { ids: [first.id], outcome: 'Answered' },
        { ids: [second.id], outcome: 'Its session ended' }
      ])
    } finally {
      off()
      stop()
      setNotifyHost({ focused: () => null, fallback: () => null, workspaceOf: () => null })
    }
  })
})
