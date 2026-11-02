// Cards on slots, the app's side (#1438, HR1's rounds 1 and 2):
// - a Done card's merged line deleted by the card (its board number, never a number read from the line's name), only
//   with the rules on and the switch on, only once its target contains it, never one checked out; a checkout coming in
//   between the worktree list and the ref's removal keeps both the branch and the checkout; and a deletion cut short by
//   a crash right after the ref's removal is settled by the next pass from its durable intent (`LineDeleting`), never
//   leaving a checkout without its branch, never claiming one kept that couldn't be put back;
// - a builder's placement counts a delivery only while it was given or is on its way: one refused, or a launch that
//   couldn't start, is made again by the next pass; one uncertain is left to the deliveries' own policy (its agent
//   started where it is offered, nothing made again);
// - a card's cycle read from its facts;
// - Hive quitting (#1628): a pass running is waited for (bounded) before the boards close, goes on to no next step, and
//   a failure as they close is no warning; no pass starts after, and the next start's do.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { B1, commit, moved, setup, sh, type Env } from './workflow/harness'
import { tempDir } from './tempDir'
import { join } from 'path'
import { lineName } from '../src/main/workflow/runtime'
import { withRepoLock } from '../src/main/repoLock'
import type { Fact } from '../src/shared/workflow/facts'
import { DatabaseSync } from 'node:sqlite'
import { boardFile } from '../src/main/boardStore'
import { readFileSync, rmSync, writeFileSync } from 'fs'

/** The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take. */
const HUNG_MS = 30_000

/** What the stand-ins do: the switches, git's and the worktree list's hooks, the agent, its deliveries and launches. */
const state = vi.hoisted(() => ({
  enforced: true,
  afterList: null as null | (() => void),
  /** After git's `update-ref -d` has run: throws to stand for Hive ending right there. */
  afterRemove: null as null | (() => void),
  /** Git's `update-ref <ref> <head> ''` (putting a branch back) refused. */
  restoreFails: false,
  live: null as null | { cwd: string; sessionId: string },
  /** The card's slot folder, where a start that wins runs the builder. */
  slot: '',
  deliveries: [] as { id: string; source?: string; ref?: string; state: string; body?: string; meta?: Record<string, unknown> }[],
  /** The next delivery or launch: given, or not (refused, or its launch failed: cancelled). */
  next: [] as ('given' | 'refused' | 'launchFails')[],
  calls: [] as string[],
  /** The card's runtime, as workflowFor gives it. */
  wf: null as unknown,
  /** Settings → Advanced, Delete a card's branch once it's merged. */
  deleteOn: true,
  /** The pass's read of the lanes (its step after the deletions and renames): null, none. */
  lanes: null as null | (() => Promise<unknown[]>),
  /** Lanes waiting for a slot looked up: the pass's step 4. */
  waitingLooks: 0,
  /** The lanes waiting for a slot, as the pass reads them. */
  waiting: [] as unknown[],
  /** Cards that are no-code: a waiting lane whose cards are all of them takes no slot (HI-2338, noCodeOnly). */
  noCode: [] as number[],
  /** The pool's own, over the stand-in's (a lend held, say). */
  pool: {} as Record<string, unknown>,
  /** The slots' log, as `<level> <line>`. */
  logged: [] as string[],
  /** The builder's conversation bound to the card's lease, as sessions.leaseConversation gives it (HI-1746). */
  conv: { is: 'none' } as { is: 'none' } | { is: 'resume'; id: string; name: string } | { is: 'held'; hold: { is: string; slot: string } },
  /** The next starts: fail (its resume couldn't start), or lose to another start (that start then runs the builder there). */
  starts: [] as ('fails' | 'lost' | 'busy')[],
  /** This run's restart record will resume the builder (restartResume.isResuming). */
  resuming: false,
  /** The conversation's lookup fails (its transcript can't be read now: unknown). */
  convFails: false,
  /** Why its builder can't take a line now (lineWriter.whyNoLine), or null. */
  busy: null as string | null,
  /** When the pause after the user typed in its builder's pane ends (sessions.userQuietAt), or null. */
  quietAt: null as number | null,
  /** What listens for Hive being done with an agent's line (lineWriter.onLineFreed). */
  lineFreed: new Set<(projectPath: string, agentId: string) => void>(),
  /**
   * Its builder freed right after the pass's look, before the wait listens (HR3's round 2): 'line', Hive's line done
   * with (its notice told then, to whoever listens); 'quiet', the user's pause over (nothing told).
   */
  freeAfterLook: null as null | { how: 'line' | 'quiet'; project: string },
  /** What holds the builder's slot (HI-2304, agentFolders.slotHeldWords), or null; and how often it was asked. */
  held: null as string | null,
  heldLooks: 0,
  /** Freed just after the pass's look (HR1's round 1): before its wait listens, with no event to come. */
  freeAfterHeldLook: false
}))
vi.mock('../src/main/agentFolders', async (orig) => ({
  ...(await orig<object>()),
  slotHeldWords: async () => {
    state.heldLooks++
    const held = state.held
    if (held && state.freeAfterHeldLook) {
      state.freeAfterHeldLook = false
      state.held = null
    }
    return held
  }
}))
vi.mock('../src/main/lineWriter', async (orig) => ({
  ...(await orig<object>()),
  whyNoLine: () => {
    const busy = state.busy
    const f = state.freeAfterLook
    if (busy && f) {
      state.freeAfterLook = null
      queueMicrotask(() => {
        state.busy = null
        if (f.how === 'line') for (const fn of [...state.lineFreed]) fn(f.project, 'B1')
      })
    }
    return busy
  },
  onLineFreed: (fn: (projectPath: string, agentId: string) => void) => (state.lineFreed.add(fn), () => void state.lineFreed.delete(fn))
}))
vi.mock('../src/main/restartResume', async (orig) => ({ ...(await orig<object>()), isResuming: () => state.resuming }))

vi.mock('../src/main/workflow/service', async (orig) => ({ ...(await orig<object>()), workflowEnforced: () => state.enforced, agentRunsGoing: () => [], workflowFor: async () => state.wf }))
vi.mock('../src/main/worktrees', async (orig) => {
  const actual = await orig<typeof import('../src/main/worktrees')>()
  return {
    ...actual,
    listWorktreesOrNull: async (cwd: string) => {
      const r = await actual.listWorktreesOrNull(cwd)
      const hook = state.afterList
      state.afterList = null
      hook?.()
      return r
    }
  }
})
vi.mock('../src/main/git', async (orig) => {
  const actual = await orig<typeof import('../src/main/git')>()
  return {
    ...actual,
    git: async (cwd: string, args: string[], ...rest: unknown[]) => {
      if (state.restoreFails && args[0] === 'update-ref' && args.length === 4 && args[3] === '') return { ok: false, out: '', err: 'refused (test)', code: 1 }
      const r = await (actual.git as (...a: unknown[]) => Promise<{ ok: boolean }>)(cwd, args, ...rest)
      if (args[0] === 'update-ref' && args[1] === '-d' && r.ok && state.afterRemove) {
        const hook = state.afterRemove
        state.afterRemove = null
        hook()
      }
      return r
    }
  }
})
vi.mock('../src/main/workflow/lineUpdates', async (orig) => ({ ...(await orig<object>()), agentBusy: () => false }))
vi.mock('../src/main/tasks', async (orig) => ({ ...(await orig<object>()), getTask: async (n: number) => ({ number: n, key: `AM-${n}`, title: 'Placed', description: '', project: 'project', column: 'doing', labels: [], comments: [], history: [], blockedBy: [] }) }))
vi.mock('../src/main/slotsApp', async (orig) => ({
  ...(await orig<object>()),
  holder: { self: async () => ({ pid: process.pid, started: 1 }), alive: async () => false, live: new Set() },
  // The project's pool as the pass reads it: no leases open or ended (what it settles first doesn't come from them).
  poolFor: async () => ({ closed: false, openLeases: () => [], endedSince: () => [], lease: () => null, renames: () => [], ...state.pool })
}))
vi.mock('../src/main/lanes', async (orig) => ({
  ...(await orig<object>()),
  rawLanes: async () => (state.lanes ? state.lanes() : []),
  lanesWaitingForSlot: async () => (state.waitingLooks++, state.waiting),
  setLaneSlotWait: async (_ws: unknown, lane: string) => void state.calls.push(`lane ${lane} waits no more`)
}))
vi.mock('../src/main/laneStart', async (orig) => ({
  ...(await orig<object>()),
  startWaitingLane: async (_ws: unknown, _p: string, lane: string, slot: string | null) => (state.calls.push(`start lane ${lane}${slot ? '' : ' with no slot'}`), true),
  noCodeOnly: (_ws: unknown, cards?: number[]) => !!cards?.length && cards.every((c) => state.noCode.includes(c))
}))
vi.mock('../src/main/logger', async (orig) => {
  const actual = await orig<typeof import('../src/main/logger')>()
  return {
    ...actual,
    createLogger: (scope: string) => {
      const l = actual.createLogger(scope)
      if (scope !== 'slots') return l
      return { ...l, info: (m: string, e?: unknown) => (state.logged.push(`info ${m}`), l.info(m, e)), warn: (m: string, e?: unknown) => (state.logged.push(`warn ${m}`), l.warn(m, e)) }
    }
  }
})
vi.mock('../src/main/advanced', async (orig) => {
  const actual = await orig<typeof import('../src/main/advanced')>()
  const advanced = Object.create(actual.advanced) as typeof actual.advanced
  advanced.get = ((id: string, ...rest: unknown[]) => (id === 'hive.slots.deleteMergedLines' ? state.deleteOn : (actual.advanced.get as (...a: unknown[]) => unknown)(id, ...rest))) as typeof advanced.get
  return { ...actual, advanced }
})
vi.mock('../src/main/sessions', async (orig) => {
  const actual = await orig<typeof import('../src/main/sessions')>()
  const stub = {
    liveFor: () => (state.live ? { ...state.live, status: 'ready' } : null),
    // The pause after the user typed in its builder's pane, while it holds (HI-2191): when it ends.
    userQuietAt: () => state.quietAt,
    hiveToolsWaiting: () => false,
    agentNow: () => (state.live ? { status: 'ready', pending: false, backgroundTasks: 0 } : null),
    // No run writes in a slot here (HI-1762's takeover of the slot an agent's own run still writes in finds none).
    runNow: () => null,
    hiveMcp: () => null,
    start: async (_p: string, o: { prompt?: string; resumeId?: string }) => {
      const name = `${o.resumeId ? `resume ${o.resumeId}` : 'start'}${o.prompt ? ' with the card' : ''}`
      const how = state.starts.shift()
      state.calls.push(how ? `${name} (${how})` : name)
      if (how === 'fails') throw new Error("its conversation couldn't resume (test)")
      if (how === 'busy') {
        const { HiveError } = await vi.importActual<typeof import('../src/main/hiveError')>('../src/main/hiveError')
        const text = 'slot-a still has another session in it (test)'
        throw new HiveError({ shown: text, english: text }, { kind: 'conflict' })
      }
      if (how === 'lost') {
        // Another start of it (the restart queue, Resume All) won: it runs there now, and this one is refused.
        state.live = { cwd: state.slot, sessionId: o.resumeId ?? 'other' }
        throw new Error('This agent is already running or starting. Stop it first.')
      }
      return {}
    },
    newConversation: async () => (state.calls.push('newConversation'), {}),
    leaseConversation: async () => {
      if (state.convFails) throw new Error('EBUSY: the transcript folder is busy (test)')
      return state.conv
    },
    pendingStart: () => null
  }
  return { ...actual, sessions: stub }
})
vi.mock('../src/main/deliveries', async (orig) => {
  const actual = await orig<typeof import('../src/main/deliveries')>()
  let seq = 0
  const make = (nd: { source?: string; ref?: string; body?: string; meta?: Record<string, unknown> }, given: boolean): { id: string; source?: string; ref?: string; state: string; body?: string; meta?: Record<string, unknown> } => {
    const r = { id: `m${++seq}`, source: nd.source, ref: nd.ref, state: given ? 'offered' : 'cancelled', body: nd.body, ...(nd.meta ? { meta: nd.meta } : {}) }
    state.deliveries.push(r)
    return r
  }
  return {
    ...actual,
    deliveriesOf: async () => state.deliveries.map((r) => ({ ...r })),
    deliverNow: async (_h: string, nd: { source?: string; ref?: string; body?: string }) => {
      const how = state.next.shift() ?? 'given'
      state.calls.push(`typed (${how})`)
      const r = make(nd, how === 'given')
      if (how !== 'given') throw new actual.NotGiven('its agent got busy (test)')
      return r
    },
    launchWith: async (_h: string, nd: { source?: string; ref?: string; body: string }, start: (line: string) => Promise<unknown>) => {
      const how = state.next.shift() ?? 'given'
      const r = make(nd, how === 'given')
      if (how === 'launchFails') {
        state.calls.push('launch failed')
        throw new Error("its CLI couldn't start (test)")
      }
      try {
        return { record: r, launched: await start(nd.body) }
      } catch (e) {
        // As launchWith does: a launch that didn't start gives its delivery to nobody.
        r.state = 'cancelled'
        throw e
      }
    }
  }
})

const { tellListeners } = await import('../src/main/events')
const { gitTestHooks } = await import('../src/main/git')
const { observer } = await import('../src/main/platform/observe')
const { withWriteFence } = await import('../src/main/workflow/factStore')
const { LeaseLost } = await import('../src/main/workflow/queueRunner')
const { cycleIn, deleteMergedLine, expectStartPrompt, finishedSlot, finishedSlots, laneSlotIn, place, placementDue, placementTracksForTests, quitSlotCards, settleSlotCards, startSlotCards, stopSlotCards, unsettledDeletions } = await import('../src/main/slotCards')
const { resetAgentStartsForTests, startBegun, startNow } = await import('../src/main/agentStarts')

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
  resetAgentStartsForTests()
  Object.assign(state, { enforced: true, afterList: null, afterRemove: null, restoreFails: false, live: null, slot: '', deliveries: [], next: [], calls: [], wf: null, deleteOn: true, lanes: null, waitingLooks: 0, waiting: [], noCode: [], pool: {}, logged: [], conv: { is: 'none' }, starts: [], resuming: false, convFails: false, busy: null, quietAt: null, freeAfterLook: null, held: null, heldLooks: 0, freeAfterHeldLook: false })
})

/**
 * A card started in a slot (a worktree on its line, under lease l-1), its change merged into its target (main unless
 * given: a line made from main first) and reported: Done.
 */
async function doneInSlot(title: string, target = 'main'): Promise<{ e: Env; n: number; line: string; slot: string }> {
  const e = (env = setup({ platform: 'git', review: 'none', finish: 'agentMerges', folder: 'slots', target }, { autoRun: false }))
  if (target !== 'main') sh(e.project, 'branch', target, 'main')
  const card = e.wf.createCard({ title })
  const line = lineName('AM', card)
  const slot = join(tempDir('slot-'), 'slot-a')
  sh(e.project, 'worktree', 'add', '-q', '-b', line, slot, target)
  e.wf.cfg.slotFor = async () => ({ slot: 'slot-a', folder: slot, lease: 'l-1', fresh: true })
  moved(await e.wf.start(card.key, B1))
  commit(slot, { 'work.txt': `${title}\n` }, title)
  moved(await e.wf.submit(card.key, B1, { summary: 'done' }))
  if (target !== 'main') sh(e.project, 'switch', '-q', target)
  sh(e.project, 'merge', '-q', '--no-ff', '-m', `Merge ${line}`, line)
  if (target !== 'main') sh(e.project, 'switch', '-q', 'main')
  moved(await e.wf.reportMerge(card.key, B1))
  expect(e.wf.state(card).stage).toBe('done')
  return { e, n: card.id, line, slot }
}

const hasLine = (e: Env, line: string): boolean => {
  try {
    sh(e.project, 'rev-parse', '--verify', '-q', `refs/heads/${line}`)
    return true
  } catch {
    return false
  }
}

/** Hive ending right after the ref's removal: the deletion's call ends there (as the process would), its intent kept. */
const crashAfterRemove = (): void => {
  state.afterRemove = () => {
    throw new Error('Hive ended (test)')
  }
}

describe("a Done card's merged line (#1438)", { timeout: 60_000 }, () => {
  it('is kept while its slot has it checked out, deleted once nothing does, and noted on the card', async () => {
    const { e, n, line, slot } = await doneInSlot('Merged work')
    expect(await deleteMergedLine({} as never, e.project, e.wf, n)).toBe(false)
    expect(hasLine(e, line)).toBe(true)
    sh(slot, 'switch', '-q', '--detach')
    expect(await deleteMergedLine({} as never, e.project, e.wf, n)).toBe(true)
    expect(hasLine(e, line)).toBe(false)
    expect(e.kinds(n).filter((k) => k.startsWith('Line'))).toEqual(['LineDeleting', 'LineDeleted'])
    // Once deleted, never again.
    expect(await deleteMergedLine({} as never, e.project, e.wf, n)).toBe(false)
  })

  it('a checkout coming in after the worktrees were read keeps both: its branch put back at the same head', async () => {
    const { e, n, line, slot } = await doneInSlot('Raced')
    sh(slot, 'switch', '-q', '--detach')
    const head = sh(e.project, 'rev-parse', line)
    // Another worktree takes the branch right after the first look, before the ref goes.
    const other = join(tempDir('other-'), 'wt')
    state.afterList = () => void sh(e.project, 'worktree', 'add', '-q', other, line)
    expect(await deleteMergedLine({} as never, e.project, e.wf, n)).toBe(false)
    expect(sh(e.project, 'rev-parse', line)).toBe(head)
    expect(sh(other, 'branch', '--show-current')).toBe(line)
    expect(e.kinds(n)).not.toContain('LineDeleted')
    expect(e.kinds(n)).toContain('LineDeleteUndone')
  })

  it("Hive ending right after the ref's removal, a checkout having come in: the next pass puts the branch back at its head, the checkout kept", async () => {
    const { e, n, line, slot } = await doneInSlot('Crashed with a checkout')
    sh(slot, 'switch', '-q', '--detach')
    const head = sh(e.project, 'rev-parse', line)
    const other = join(tempDir('other-'), 'wt')
    state.afterList = () => void sh(e.project, 'worktree', 'add', '-q', other, line)
    crashAfterRemove()
    expect(await deleteMergedLine({} as never, e.project, e.wf, n)).toBe(false)
    // As Hive left it: the ref gone, the checkout's HEAD naming it, the intent recorded.
    expect(hasLine(e, line)).toBe(false)
    expect(sh(other, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/${line}`)
    expect(e.kinds(n).filter((k) => k.startsWith('Line'))).toEqual(['LineDeleting'])
    // The rules off meanwhile: settled all the same (it left a checkout without its branch).
    state.enforced = false
    expect(await deleteMergedLine({} as never, e.project, e.wf, n)).toBe(false)
    expect(sh(e.project, 'rev-parse', line)).toBe(head)
    expect(sh(other, 'branch', '--show-current')).toBe(line)
    expect(e.kinds(n).filter((k) => k.startsWith('Line'))).toEqual(['LineDeleting', 'LineDeleteUndone'])
  })

  it("Hive ending right after the ref's removal, nothing checking it out: the next pass records it deleted", async () => {
    const { e, n, line, slot } = await doneInSlot('Crashed alone')
    sh(slot, 'switch', '-q', '--detach')
    crashAfterRemove()
    expect(await deleteMergedLine({} as never, e.project, e.wf, n)).toBe(false)
    expect(hasLine(e, line)).toBe(false)
    expect(await deleteMergedLine({} as never, e.project, e.wf, n)).toBe(true)
    expect(e.kinds(n).filter((k) => k.startsWith('Line'))).toEqual(['LineDeleting', 'LineDeleted'])
  })

  it("a branch that can't be put back is never claimed kept: its intent stays for the next pass, which puts it back", async () => {
    const { e, n, line, slot } = await doneInSlot('Not put back')
    sh(slot, 'switch', '-q', '--detach')
    const head = sh(e.project, 'rev-parse', line)
    const other = join(tempDir('other-'), 'wt')
    state.afterList = () => void sh(e.project, 'worktree', 'add', '-q', other, line)
    state.restoreFails = true
    expect(await deleteMergedLine({} as never, e.project, e.wf, n)).toBe(false)
    expect(hasLine(e, line)).toBe(false)
    expect(e.kinds(n).filter((k) => k.startsWith('Line'))).toEqual(['LineDeleting'])
    state.restoreFails = false
    expect(await deleteMergedLine({} as never, e.project, e.wf, n)).toBe(false)
    expect(sh(e.project, 'rev-parse', line)).toBe(head)
    expect(e.kinds(n).filter((k) => k.startsWith('Line'))).toEqual(['LineDeleting', 'LineDeleteUndone'])
  })

  it('never with the rules off, and never a line with work its target lacks', async () => {
    const { e, n, line, slot } = await doneInSlot('Off')
    sh(slot, 'switch', '-q', '--detach')
    state.enforced = false
    expect(await deleteMergedLine({} as never, e.project, e.wf, n)).toBe(false)
    expect(hasLine(e, line)).toBe(true)
    state.enforced = true
    // A commit after the merge: not in main, so the line stays.
    sh(slot, 'switch', '-q', line)
    commit(slot, { 'later.txt': 'later\n' }, 'after the merge')
    sh(slot, 'switch', '-q', '--detach')
    expect(await deleteMergedLine({} as never, e.project, e.wf, n)).toBe(false)
    expect(hasLine(e, line)).toBe(true)
    expect(e.kinds(n).filter((k) => k.startsWith('Line'))).toEqual([])
  })
})

describe("a finished card's slot (HI-2014, HI-1986)", { timeout: 60_000 }, () => {
  const view = (slot: string, open = true) => () => ({ name: 'slot-a', folder: slot, target: 'main', busy: false, open })
  const branch = (slot: string): string => sh(slot, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
  const asked = (e: Env, n: number): number => e.wf.state(e.store.cardByKey(`#${n}`)!).requests.filter((r) => r.gate === 'slotDirty').length

  it("a running lane's slot, clean: detached at the target's head, so its merged line can go", async () => {
    const { e, n, line, slot } = await doneInSlot('Lane card')
    await finishedSlot(e.project, e.wf, n, 'l-1', view(slot))
    expect(branch(slot)).toBe('HEAD')
    expect(sh(slot, 'rev-parse', 'HEAD').trim()).toBe(sh(e.project, 'rev-parse', 'main').trim())
    expect(asked(e, n)).toBe(0)
    expect(await deleteMergedLine({} as never, e.project, e.wf, n)).toBe(true)
    expect(hasLine(e, line)).toBe(false)
  })

  it("a slot made from main whose card targeted another line: detached at that line's head, not main's (HI-2185)", async () => {
    const { e, n, line, slot } = await doneInSlot('Card for 1.0.0', '1.0.0')
    expect(sh(e.project, 'rev-parse', '1.0.0').trim()).not.toBe(sh(e.project, 'rev-parse', 'main').trim())
    // The slot's own target (view's) is the branch it was made from, main; its card's is 1.0.0.
    expect(await finishedSlot(e.project, e.wf, n, 'l-1', view(slot))).toBe(true)
    expect(branch(slot)).toBe('HEAD')
    expect(sh(slot, 'rev-parse', 'HEAD').trim()).toBe(sh(e.project, 'rev-parse', '1.0.0').trim())
    expect(await deleteMergedLine({} as never, e.project, e.wf, n)).toBe(true)
    expect(hasLine(e, line)).toBe(false)
  })

  it('uncommitted changes: left on its line, the user asked once; once clean, detached and the question closed', async () => {
    const { e, n, line, slot } = await doneInSlot('Dirty card')
    writeFileSync(join(slot, 'wip.txt'), 'uncommitted')
    await finishedSlot(e.project, e.wf, n, 'l-1', view(slot))
    await finishedSlot(e.project, e.wf, n, 'l-1', view(slot))
    expect(branch(slot)).toBe(line)
    expect(asked(e, n)).toBe(1)
    rmSync(join(slot, 'wip.txt'))
    await finishedSlot(e.project, e.wf, n, 'l-1', view(slot))
    expect(branch(slot)).toBe('HEAD')
    expect(asked(e, n)).toBe(0)
  })

  it("another lease's now (reused), or the card back out of Done: its checkout left alone", async () => {
    const { e, n, line, slot } = await doneInSlot('Reused')
    writeFileSync(join(slot, 'wip.txt'), 'uncommitted')
    await finishedSlot(e.project, e.wf, n, 'l-1', view(slot))
    expect(asked(e, n)).toBe(1)
    // Reused by another lease: the question closes, the slot untouched.
    rmSync(join(slot, 'wip.txt'))
    await finishedSlot(e.project, e.wf, n, 'l-1', () => null)
    expect(asked(e, n)).toBe(0)
    expect(branch(slot)).toBe(line)
    // Another lease's id, or the card reopened: nothing done.
    await finishedSlot(e.project, e.wf, n, 'l-2', view(slot))
    expect(branch(slot)).toBe(line)
    moved(await e.wf.move(e.store.cardByKey(`#${n}`)!.key, 'todo', 'user', { confirm: true, reason: 'reopened' }))
    await finishedSlot(e.project, e.wf, n, 'l-1', view(slot))
    expect(branch(slot)).toBe(line)
  })

  // HR2's round 1 finding 1: what the pass decided on changes while it waits for the repository's lock. The lock held,
  // the pass started (it waits for it), the change made, the lock let go: the slot is left as it is.
  const whileWaiting = async (e: Env, run: () => Promise<boolean>, meanwhile: () => Promise<void> | void): Promise<boolean> => {
    let release!: () => void
    let held!: () => void
    const taken = new Promise<void>((r) => (held = r))
    const lock = withRepoLock(e.project, () => {
      held()
      return new Promise<void>((r) => (release = r))
    })
    await taken
    const pass = run()
    await meanwhile()
    release()
    await lock
    return pass
  }

  it('its card reopened while the pass waits for the lock: its checkout left on its line', async () => {
    const { e, n, line, slot } = await doneInSlot('Reopened while waiting')
    const key = e.store.cardByKey(`#${n}`)!.key
    expect(await whileWaiting(e, () => finishedSlot(e.project, e.wf, n, 'l-1', view(slot)), async () => void moved(await e.wf.move(key, 'todo', 'user', { confirm: true, reason: 'reopened' })))).toBe(false)
    expect(branch(slot)).toBe(line)
  })

  it('its workspace closed while the pass waits: nothing done', async () => {
    const { e, n, line, slot } = await doneInSlot('Closed while waiting')
    let open = true
    expect(await whileWaiting(e, () => finishedSlot(e.project, e.wf, n, 'l-1', view(slot), null, () => open), () => void (open = false))).toBe(false)
    expect(branch(slot)).toBe(line)
  })

  it("its slot another lease's while the pass waits: the new checkout untouched, the old question closed", async () => {
    const { e, n, line, slot } = await doneInSlot('Reused while waiting')
    writeFileSync(join(slot, 'wip.txt'), 'uncommitted')
    await finishedSlot(e.project, e.wf, n, 'l-1', view(slot))
    expect(asked(e, n)).toBe(1)
    rmSync(join(slot, 'wip.txt'))
    let mine = true
    const reused = () => (mine ? view(slot)() : null)
    expect(await whileWaiting(e, () => finishedSlot(e.project, e.wf, n, 'l-1', reused), () => void (mine = false))).toBe(false)
    expect(branch(slot)).toBe(line)
    // The next look finds it another lease's: its question closes, the checkout still untouched.
    await finishedSlot(e.project, e.wf, n, 'l-1', reused)
    expect(asked(e, n)).toBe(0)
    expect(branch(slot)).toBe(line)
  })

  it("an ended lane gone from the lanes' list: its finished card's slot question still settled from the board's lane (HR2's finding 3)", async () => {
    const { e, n, slot } = await doneInSlot('Old lane')
    const ruleset = e.store.facts(n).find((f) => f.kind === 'Started')!.ruleset!
    e.store.startLane('lane-old', [n], ruleset)
    writeFileSync(join(slot, 'wip.txt'), 'uncommitted')
    await finishedSlot(e.project, e.wf, n, 'l-1', view(slot))
    expect(asked(e, n)).toBe(1)
    rmSync(join(slot, 'wip.txt'))
    // The lane's lease ended long ago, and the lane has left the list the pass reads (an empty map).
    const lease = { id: 'l-1', project: 'project', slot: 'slot-a', kind: 'lane', card: null, lane: 'lane-old', agent: 'b1', from: '2026-01-01T00:00:00Z', to: '2026-01-01T01:00:00Z', why: 'laneEnded', endRev: null }
    const pool = { openLeases: () => [], endedSince: () => [lease], slotOf: () => ({ name: 'slot-a', folder: slot, target: 'main', op: null }), openLease: () => null, lease: () => lease }
    await finishedSlots({ lifetime: { aborted: false } } as never, e.project, e.wf, pool as never, new Map())
    expect(asked(e, n)).toBe(0)
  })

  it("a released card's slot isn't switched here (the pool detaches it as it looks at it)", async () => {
    const { e, n, line, slot } = await doneInSlot('Released')
    await finishedSlot(e.project, e.wf, n, 'l-1', view(slot, false))
    expect(branch(slot)).toBe(line)
  })

  // HI-2170: a request raised and closed within a merge (the pool's detach of a released slot read halfway through as
  // uncommitted changes). Its first two reads are the pass's and the lock's, before git's; the change comes after them.
  it.each([
    ['turns busy (an operation, the pool’s settle)', { busy: true }],
    ['changes in the pool (a settle ran and ended meanwhile)', { state: 'ready' }],
    ['is taken by a later card of its lane', { taken: true }]
  ])('HI-2170: a dirty slot that %s while git reads it: nothing asked on the finished card', async (_what, change) => {
    const { e, n, line, slot } = await doneInSlot('Changed while read')
    writeFileSync(join(slot, 'wip.txt'), 'uncommitted')
    let reads = 0
    const changing = () => ({ ...view(slot)(), state: 'dirty', ...(++reads > 2 ? change : {}) })
    await finishedSlot(e.project, e.wf, n, 'l-1', changing)
    expect(reads).toBeGreaterThan(2)
    expect(asked(e, n)).toBe(0)
    expect(branch(slot)).toBe(line)
    // Unchanged, the same slot is asked about.
    await finishedSlot(e.project, e.wf, n, 'l-1', () => ({ ...view(slot)(), state: 'dirty' }))
    expect(asked(e, n)).toBe(1)
  })

  it("HI-2170: a released lease's dirty slot is asked about only once the pool has looked at it and nothing holds it", async () => {
    const { e, n, slot } = await doneInSlot('Released, settling')
    writeFileSync(join(slot, 'wip.txt'), 'uncommitted')
    const lease = { id: 'l-1', project: 'project', slot: 'slot-a', kind: 'card', card: n, lane: null, agent: 'b1', from: '2026-01-01T00:00:00Z', to: '2026-01-01T01:00:00Z', why: 'done', endRev: null }
    let row: Record<string, unknown> = { name: 'slot-a', folder: slot, target: 'main', state: 'lent', op: null, writer: null }
    const pool = { openLeases: () => [], endedSince: () => [lease], slotOf: () => row, openLease: () => null, lease: () => lease }
    const pass = () => finishedSlots({ lifetime: { aborted: false } } as never, e.project, e.wf, pool as never, new Map())
    // Its builder's session still draining there, the pool not having looked since the lease ended.
    row = { ...row, writer: { run: 'r-1', lease: 'l-1', agent: 'b1', pid: 1, started: 1 } }
    await pass()
    expect(asked(e, n)).toBe(0)
    // The writer gone, no look yet (still lent).
    row = { ...row, writer: null }
    await pass()
    expect(asked(e, n)).toBe(0)
    // The pool settling it (from dirty, say): its operation holds the slot.
    row = { ...row, state: 'dirty', op: { token: 'o-1', kind: 'warm', lease: null, pid: 1, started: 1 } }
    await pass()
    expect(asked(e, n)).toBe(0)
    // Looked at, and dirty, nothing holding it: the real case, asked once.
    row = { ...row, op: null }
    await pass()
    await pass()
    expect(asked(e, n)).toBe(1)
  })

  it("HI-2170: a running lane's dirty slot, a later card of the lane under way on its lease: nothing asked on the finished card", async () => {
    const { e, n, slot } = await doneInSlot('First of the lane')
    writeFileSync(join(slot, 'wip.txt'), 'uncommitted')
    const next = e.wf.createCard({ title: 'Second of the lane' })
    moved(await e.wf.start(next.key, B1))
    const lease = { id: 'l-1', project: 'project', slot: 'slot-a', kind: 'lane', card: null, lane: 'lane-1', agent: 'b1', from: '2026-01-01T00:00:00Z', to: null, why: null, endRev: null }
    const pool = { openLeases: () => [lease], endedSince: () => [], slotOf: () => ({ name: 'slot-a', folder: slot, target: 'main', state: 'lent', op: null, writer: null }), openLease: () => lease, lease: () => lease }
    const lanes = new Map([['lane-1', { id: 'lane-1', cards: [n, next.id], state: 'active' }]])
    await finishedSlots({ lifetime: { aborted: false } } as never, e.project, e.wf, pool as never, lanes as never)
    expect(asked(e, n)).toBe(0)
    // The later card put back: the finished card's slot is asked about.
    moved(await e.wf.move(next.key, 'todo', 'user', { confirm: true, reason: 'put back' }))
    await finishedSlots({ lifetime: { aborted: false } } as never, e.project, e.wf, pool as never, lanes as never)
    expect(asked(e, n)).toBe(1)
  })

  it('HI-2115: a slot git found on another line is asked again only once its repository’s refs move; never where they aren’t watched', async () => {
    const { e, n, line, slot } = await doneInSlot('Moved on')
    /** How many times the slot's checkout was asked of git (heads) while `fn` ran. */
    const asks = async (fn: () => Promise<unknown>): Promise<number> => {
      let k = 0
      gitTestHooks.started = (_cwd, args) => void (args[0] === 'rev-parse' && args.includes('--symbolic-full-name') && k++)
      try {
        await fn()
      } finally {
        gitTestHooks.started = undefined
      }
      return k
    }
    const look = () => finishedSlot(e.project, e.wf, n, 'l-1', view(slot))
    // Not watched: git each time, as before.
    await look()
    expect(branch(slot)).toBe('HEAD')
    expect(await asks(look)).toBe(1)
    expect(await asks(look)).toBe(1)
    observer.follow([{ path: e.project, platform: 'git', root: e.project }])
    try {
      // Watched: asked once more (nothing known yet), then not while nothing moves, whatever else happens on the board.
      expect(await asks(look)).toBe(1)
      expect(await asks(look)).toBe(0)
      expect(await asks(look)).toBe(0)
      // A commit in the project (a line moved): asked again, still elsewhere.
      commit(e.project, { 'other.txt': 'o\n' }, 'other')
      expect(await asks(look)).toBe(1)
      expect(await asks(look)).toBe(0)
      // The slot switched to a new branch at the same commit (only its HEAD and reflog change): asked again.
      sh(slot, 'switch', '-q', '-c', 'side')
      expect(await asks(look)).toBe(1)
      // Back on the card's line, with uncommitted changes: asked, found there, the user asked; not kept while on it.
      sh(slot, 'switch', '-q', line)
      writeFileSync(join(slot, 'wip.txt'), 'uncommitted')
      expect(await asks(look)).toBe(1)
      expect(asked(e, n)).toBe(1)
      expect(await asks(look)).toBe(1)
      // Clean: detached as before, the question closed; then kept again.
      rmSync(join(slot, 'wip.txt'))
      expect(await asks(look)).toBe(1)
      expect(branch(slot)).toBe('HEAD')
      expect(asked(e, n)).toBe(0)
      expect(await asks(look)).toBe(1)
      expect(await asks(look)).toBe(0)
      // Another slot view (reused for the next card under another name): asked again.
      expect(await asks(() => finishedSlot(e.project, e.wf, n, 'l-1', () => ({ ...view(slot)(), name: 'slot-b' })))).toBe(1)
    } finally {
      observer.follow([])
    }
  })

  it('HI-2183: two finished cards of one slot, the slot elsewhere: one refs move asks git once for the slot, not once per card', async () => {
    const { e, n, slot } = await doneInSlot('First in the slot')
    // A second card in the same slot under another lease, on its own line from main, merged and Done.
    const second = e.wf.createCard({ title: 'Second in the slot' })
    const line2 = lineName('AM', second)
    sh(slot, 'switch', '-q', '-c', line2, 'main')
    e.wf.cfg.slotFor = async () => ({ slot: 'slot-a', folder: slot, lease: 'l-2', fresh: true })
    moved(await e.wf.start(second.key, B1))
    commit(slot, { 'second.txt': 'second\n' }, 'second')
    moved(await e.wf.submit(second.key, B1, { summary: 'done' }))
    sh(e.project, 'merge', '-q', '--no-ff', '-m', `Merge ${line2}`, line2)
    moved(await e.wf.reportMerge(second.key, B1))
    sh(slot, 'switch', '-q', '--detach')
    const asks = async (fn: () => Promise<unknown>): Promise<number> => {
      let k = 0
      gitTestHooks.started = (_cwd, args) => void (args[0] === 'rev-parse' && args.includes('--symbolic-full-name') && k++)
      try {
        await fn()
      } finally {
        gitTestHooks.started = undefined
      }
      return k
    }
    const both = () => Promise.all([finishedSlot(e.project, e.wf, n, 'l-1', view(slot)), finishedSlot(e.project, e.wf, second.id, 'l-2', view(slot))])
    observer.follow([{ path: e.project, platform: 'git', root: e.project }])
    try {
      expect(await asks(both)).toBe(1)
      expect(await asks(both)).toBe(0)
      commit(e.project, { 'other.txt': 'o\n' }, 'other')
      expect(await asks(both)).toBe(1)
      expect(await asks(both)).toBe(0)
      // On the second card's line: the first card's look isn't asked again, the second's is (its own line, each time).
      sh(slot, 'switch', '-q', line2)
      writeFileSync(join(slot, 'wip.txt'), 'uncommitted')
      expect(await asks(() => finishedSlot(e.project, e.wf, second.id, 'l-2', view(slot)))).toBe(1)
      expect(await asks(() => finishedSlot(e.project, e.wf, n, 'l-1', view(slot)))).toBe(0)
      expect(await asks(() => finishedSlot(e.project, e.wf, second.id, 'l-2', view(slot)))).toBe(1)
      expect(asked(e, second.id)).toBe(1)
      expect(asked(e, n)).toBe(0)
    } finally {
      observer.follow([])
    }
  })

  it("HI-2115 (HR3's round 1, finding 1): back on its line at the same commit with no reflog: asked again, and detached", async () => {
    const { e, n, line, slot } = await doneInSlot('No reflog')
    const asks = async (fn: () => Promise<unknown>): Promise<number> => {
      let k = 0
      gitTestHooks.started = (_cwd, args) => void (args[0] === 'rev-parse' && args.includes('--symbolic-full-name') && k++)
      try {
        await fn()
      } finally {
        gitTestHooks.started = undefined
      }
      return k
    }
    const look = () => finishedSlot(e.project, e.wf, n, 'l-1', view(slot))
    observer.follow([{ path: e.project, platform: 'git', root: e.project }])
    try {
      await look()
      expect(branch(slot)).toBe('HEAD')
      // No reflogs from here on, the slot's own gone; the card's line at the commit the slot is detached at.
      sh(e.project, 'config', 'core.logAllRefUpdates', 'false')
      rmSync(join(sh(slot, 'rev-parse', '--absolute-git-dir').trim(), 'logs', 'HEAD'), { force: true })
      sh(e.project, 'branch', '-f', line, sh(slot, 'rev-parse', 'HEAD').trim())
      expect(await asks(look)).toBe(1)
      expect(await asks(look)).toBe(0)
      // The switch moves no line, no commit and no reflog: only the slot's HEAD file says it.
      sh(slot, 'switch', '-q', line)
      expect(await asks(look)).toBe(1)
      expect(branch(slot)).toBe('HEAD')
    } finally {
      observer.follow([])
    }
  })

  it("HI-2115 (HR3's round 1, finding 2): a reftable repository's refs can't be watched: git each time", async () => {
    const base = tempDir('reftable-')
    const repo = join(base, 'repo')
    sh(base, 'init', '-q', '--ref-format=reftable', '-b', 'main', repo)
    commit(repo, { 'a.txt': 'a\n' }, 'a')
    observer.follow([{ path: repo, platform: 'git', root: repo }])
    try {
      expect(await observer.refsNow(repo, repo)).toBeNull()
    } finally {
      observer.follow([])
    }
  })
})

describe("a begun deletion settled by the project's pass, whatever the switches (#1438, HR1's round 3)", { timeout: 60_000 }, () => {
  /** A Done card's deletion cut short right after its ref went, a checkout having come in: as a crash leaves it. */
  async function cutShort(title: string): Promise<{ e: Env; n: number; line: string; head: string; other: string; ws: never }> {
    const { e, n, line, slot } = await doneInSlot(title)
    state.wf = e.wf
    sh(slot, 'switch', '-q', '--detach')
    const head = sh(e.project, 'rev-parse', line)
    const other = join(tempDir('other-'), 'wt')
    state.afterList = () => void sh(e.project, 'worktree', 'add', '-q', other, line)
    crashAfterRemove()
    expect(await deleteMergedLine({} as never, e.project, e.wf, n)).toBe(false)
    expect(hasLine(e, line)).toBe(false)
    expect(sh(other, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/${line}`)
    const ws = { path: e.home, lifetime: { aborted: false }, info: () => ({ projects: [] }), projectConfig: async () => ({ agents: [] }) } as never
    return { e, n, line, head, other, ws }
  }

  for (const off of ['the rules', "Delete a card's branch once it's merged"] as const) {
    it(`with ${off} off, the next pass puts the branch back for the checkout, and records it`, async () => {
      const { e, n, line, head, other, ws } = await cutShort(`Off: ${off}`)
      if (off === 'the rules') state.enforced = false
      else state.deleteOn = false
      await settleSlotCards(ws, e.project)
      expect(sh(e.project, 'rev-parse', line)).toBe(head)
      expect(sh(other, 'branch', '--show-current')).toBe(line)
      expect(e.kinds(n).filter((k) => k.startsWith('Line'))).toEqual(['LineDeleting', 'LineDeleteUndone'])
      expect(unsettledDeletions(e.store.factsOfKind(['LineDeleting', 'LineDeleted', 'LineDeleteUndone']))).toEqual([])
    })
  }

  it('found whatever the card has done since (started again), and never settled twice', async () => {
    const { e, n, line, head, ws } = await cutShort('Started again')
    // A later cycle of the card: the begun deletion isn't in its current cycle any more, and is still found.
    await e.wf.write(e.store.card(n), null, 'hive', (w) => void w.fact('Started', { folder: 'project', line: 'main', base: head, target: 'main', builder: 'B1', cardKind: 'code' }))
    expect(cycleIn(e.store.facts(n))).toBeNull()
    await settleSlotCards(ws, e.project)
    expect(sh(e.project, 'rev-parse', line)).toBe(head)
    await settleSlotCards(ws, e.project)
    expect(e.kinds(n).filter((k) => k === 'LineDeleteUndone')).toHaveLength(1)
  })

  it("asked for inside the merge queue's fenced write (a merge freeing a slot, HI-1685), runs outside that fence: its writes never check the queue's lease", async () => {
    const { e, n, line, head, ws } = await cutShort('Asked inside a fence')
    // The queue's lease, gone by the time the pass writes (the runner let it go after its drain): every fenced write throws.
    const lost = (): void => {
      throw new LeaseLost('integration')
    }
    await withWriteFence(lost, () => settleSlotCards(ws, e.project))
    expect(sh(e.project, 'rev-parse', line)).toBe(head)
    expect(e.kinds(n).filter((k) => k === 'LineDeleteUndone')).toHaveLength(1)
  })
})

describe("a builder's placement in its slot (#1438, HR1's round 2)", { timeout: 60_000 }, () => {
  /** A card started in a slot and prepared there (its `SlotPrepared`), its builder B1: what `place` is asked to do. */
  async function prepared(): Promise<{ e: Env; n: number; slot: string; cycle: NonNullable<ReturnType<typeof cycleIn>>; ws: never }> {
    const e = (env = setup({ platform: 'git', review: 'none', finish: 'agentMerges', folder: 'slots', target: 'main' }, { autoRun: false }))
    state.wf = e.wf
    const card = e.wf.createCard({ title: 'Placed' })
    const slot = join(tempDir('slot-'), 'slot-a')
    e.wf.cfg.slotFor = async () => ({ slot: 'slot-a', folder: slot, lease: 'l-1', fresh: true })
    moved(await e.wf.start(card.key, B1))
    await e.wf.write(card, null, 'hive', (w) => void w.fact('SlotPrepared', { lease: 'l-1', line: 'hive/AM/x', revision: 'r' }))
    const cycle = cycleIn(e.store.facts(card.id))!
    const ws = { path: e.home, lifetime: { aborted: false }, projectConfig: async () => ({ agents: [{ id: 'B1', name: 'B1' }] }) } as never
    return { e, n: card.id, slot, cycle, ws }
  }
  const lease = { id: 'l-1', agent: 'B1', slot: 'slot-a', kind: 'card', card: 0, lane: null, project: 'p', from: '', to: null, why: null, endRev: null } as never
  const placed = (e: Env, n: number): number => e.kinds(n).filter((k) => k === 'BuilderPlaced').length

  it('typed in where it runs there: refused once (its agent got busy), nothing recorded; the next try gives it, once', async () => {
    const { e, n, slot, cycle, ws } = await prepared()
    state.live = { cwd: slot, sessionId: 's1' }
    state.next = ['refused', 'given']
    await expect(place(ws, e.project, e.wf, n, cycle, lease)).rejects.toThrow(/busy/)
    expect(placed(e, n)).toBe(0)
    await place(ws, e.project, e.wf, n, cycleIn(e.store.facts(n))!, lease)
    expect(placed(e, n)).toBe(1)
    expect(state.calls).toEqual(['typed (refused)', 'typed (given)'])
    expect(state.deliveries.map((d) => d.state)).toEqual(['cancelled', 'offered'])
    // Placed: a later pass makes nothing more.
    await place(ws, e.project, e.wf, n, cycleIn(e.store.facts(n))!, lease)
    expect(placed(e, n)).toBe(1)
    expect(state.deliveries).toHaveLength(2)
  })

  describe("HI-2191: its builder unable to take a line: no delivery made or called off, said once; given once it can, woken by what ends each reason", () => {
    /** A placement waiting for B1, which can't take a line for `why`: the pass that waits, and how often it said so. */
    async function waiting(why: string) {
      const { e, n, slot, cycle, ws } = await prepared()
      state.live = { cwd: slot, sessionId: 's1' }
      state.busy = why
      const placing = place(ws, e.project, e.wf, n, cycle, lease)
      const said = (): number => state.logged.filter((m) => /waits for its builder ⁨?B1⁩?, which can't take a line now/.test(m)).length
      await vi.waitFor(() => expect(said()).toBe(1), { timeout: HUNG_MS })
      return { e, n, placing, said }
    }
    /** Nothing given while it waits, through unrelated events and its own that leave it busy. */
    const nothingYet = async (e: Env, n: number, said: () => number): Promise<void> => {
      for (let i = 0; i < 3; i++) {
        tellListeners({ type: 'session-status', state: { projectPath: e.project, agentId: 'B1', status: 'watching' } } as never)
        tellListeners({ type: 'session-status', state: { projectPath: e.project, agentId: 'R1', status: 'ready' } } as never)
        for (const fn of [...state.lineFreed]) fn(e.project, 'R1')
        tellListeners({ type: 'progress-changed' } as never)
      }
      await new Promise((r) => setImmediate(r))
      expect(state.deliveries).toEqual([])
      expect(state.calls).toEqual([])
      expect(placed(e, n)).toBe(0)
      expect(said(), 'said once').toBe(1)
      expect(state.logged.some((m) => /Giving/.test(m))).toBe(false)
    }
    /** Given once, well before nextLook's 30 s fallback would have looked again. */
    const givenOnce = async (e: Env, n: number, placing: Promise<void>): Promise<void> => {
      let bound: NodeJS.Timeout | undefined
      await Promise.race([placing, new Promise((_, no) => (bound = setTimeout(() => no(new Error('not woken: only the 30 s fallback would have looked')), 10_000)))])
      clearTimeout(bound)
      expect(state.calls).toEqual(['typed (given)'])
      expect(placed(e, n)).toBe(1)
    }

    it('waiting on cards (its builder watching), then its status frees it', async () => {
      const { e, n, placing, said } = await waiting('it is waiting on cards, and takes no new work until it is woken')
      await nothingYet(e, n, said)
      state.busy = null
      tellListeners({ type: 'session-status', state: { projectPath: e.project, agentId: 'B1', status: 'ready' } } as never)
      await givenOnce(e, n, placing)
    })

    it('its input blocked, then freed (its status back to idle)', async () => {
      const { e, n, placing, said } = await waiting('something on its screen is taking its keys, and it waits for the user to answer it there')
      await nothingYet(e, n, said)
      state.busy = null
      tellListeners({ type: 'session-status', state: { projectPath: e.project, agentId: 'B1', status: 'ready' } } as never)
      await givenOnce(e, n, placing)
    })

    it("Hive already typing a line into it: woken when that line is done with, with no status change", async () => {
      const { e, n, placing, said } = await waiting('Hive is already typing a line into it')
      await nothingYet(e, n, said)
      state.busy = null
      for (const fn of [...state.lineFreed]) fn(e.project, 'B1')
      await givenOnce(e, n, placing)
    })

    it.each(['line', 'quiet'] as const)("freed between the pass's look and the wait's listening (%s): not lost, given at once (HR3's round 2)", async (how) => {
      const { e, n, slot, cycle, ws } = await prepared()
      state.live = { cwd: slot, sessionId: 's1' }
      state.busy = how === 'line' ? 'Hive is already typing a line into it' : 'the user has just typed in its terminal and may still be writing there'
      state.freeAfterLook = { how, project: e.project }
      await givenOnce(e, n, place(ws, e.project, e.wf, n, cycle, lease))
    })

    it('the user typing in its pane: woken once, at the end of the pause after they typed, with no status change', async () => {
      state.quietAt = Date.now() + 1500
      const { e, n, placing, said } = await waiting('the user has just typed in its terminal and may still be writing there')
      await nothingYet(e, n, said)
      // The pause ends: nothing else happens, and its own timer looks again.
      const busyUntil = state.quietAt
      state.busy = null
      expect(Date.now()).toBeLessThan(busyUntil)
      await givenOnce(e, n, placing)
    })
  })

  it("not running: a launch that couldn't start is nothing given; the next try starts it with the card, once", async () => {
    const { e, n, cycle, ws } = await prepared()
    state.next = ['launchFails', 'given']
    await expect(place(ws, e.project, e.wf, n, cycle, lease)).rejects.toThrow(/couldn't start/)
    expect(placed(e, n)).toBe(0)
    await place(ws, e.project, e.wf, n, cycleIn(e.store.facts(n))!, lease)
    expect(placed(e, n)).toBe(1)
    expect(state.calls).toEqual(['launch failed', 'start with the card'])
  })

  it('a delivery on its way (uncertain) is never made again: its agent, not running, is started where it is offered', async () => {
    const { e, n, cycle, ws } = await prepared()
    state.deliveries.push({ id: 'm9', source: 'slot-placement', ref: `${n}:${cycle.seq}:l-1`, state: 'uncertain' })
    await place(ws, e.project, e.wf, n, cycle, lease)
    expect(placed(e, n)).toBe(1)
    expect(state.calls).toEqual(['start'])
    expect(state.deliveries).toHaveLength(1)
    expect(e.store.facts(n).find((f) => f.kind === 'BuilderPlaced')?.data).toMatchObject({ delivery: 'm9', how: 'started' })
  })
})

describe("a Start's prompt goes to the slot's placement only while one is due (HI-1953)", { timeout: 60_000 }, () => {
  // taskStart hands a Start's prompt to the slot's placement when placementDue says one will come; otherwise it gives the
  // card itself (typed in, or its agent started with it). A card back from Review keeps its placed cycle: no new start is
  // written, so no placement comes, and a prompt handed over then was given to nobody.
  async function inSlot(): Promise<{ e: Env; n: number; cycle: NonNullable<ReturnType<typeof cycleIn>>; ws: never }> {
    const e = (env = setup({ platform: 'git', review: 'agent', noSelfReview: true, finish: 'agentMerges', folder: 'slots', target: 'main' }, { autoRun: false }))
    state.wf = e.wf
    const card = e.wf.createCard({ title: 'Back for more' })
    e.wf.cfg.slotFor = async () => ({ slot: 'slot-a', folder: join(tempDir('slot-'), 'slot-a'), lease: 'l-1', fresh: true })
    moved(await e.wf.start(card.key, B1))
    await e.wf.write(card, null, 'hive', (w) => void w.fact('SlotPrepared', { lease: 'l-1', line: 'hive/AM/x', revision: 'r' }))
    const ws = { path: e.home, lifetime: { aborted: false }, projectConfig: async () => ({ agents: [{ id: 'B1', name: 'B1' }] }) } as never
    return { e, n: card.id, cycle: cycleIn(e.store.facts(card.id))!, ws }
  }
  const lease = { id: 'l-1', agent: 'B1', slot: 'slot-a', kind: 'card', card: 0, lane: null, project: 'p', from: '', to: null, why: null, endRev: null } as never

  it('a card just started in its slot: due, in its slot and lease', async () => {
    const { e, n, ws } = await inSlot()
    expect(await placementDue(ws, e.project, n)).toEqual({ slot: 'slot-a', lease: 'l-1' })
  })

  it('placed, then in Review and moved back to Doing by a Start: none due (no new start), so the Start gives the card itself', async () => {
    const { e, n, cycle, ws } = await inSlot()
    await place(ws, e.project, e.wf, n, cycle, lease)
    expect(await placementDue(ws, e.project, n)).toBeNull()
    const card = e.store.card(n)
    await e.wf.write(card, null, 'hive', (w) => void w.move('review', 'intent'))
    // A Start names its agent (taskStart's move gives it): never a move into Active for nobody (HI-2062).
    moved(await e.wf.move(n, 'active', 'assistant', { builder: 'B1' }))
    expect(e.wf.state(e.store.card(n)).stage).toBe('active')
    expect(e.kinds(n).filter((k) => k === 'Started')).toHaveLength(1)
    expect(await placementDue(ws, e.project, n)).toBeNull()
  })

  it('with the rules off: none due (nothing is placed)', async () => {
    const { e, n, ws } = await inSlot()
    state.enforced = false
    expect(await placementDue(ws, e.project, n)).toBeNull()
  })
})

describe("a slot that couldn't be prepared (HI-1796)", { timeout: 60_000 }, () => {
  it("tells its card with the workflow's own message (so its history line can show it), once", async () => {
    const e = (env = setup({ platform: 'git', review: 'none', finish: 'agentMerges', folder: 'slots', target: 'main' }, { autoRun: false }))
    state.wf = e.wf
    const card = e.wf.createCard({ title: 'Placed' })
    const slot = join(tempDir('slot-'), 'slot-a')
    e.wf.cfg.slotFor = async () => ({ slot: 'slot-a', folder: slot, lease: 'l-1', fresh: true })
    moved(await e.wf.start(card.key, B1))
    const lease = { id: 'l-1', agent: 'B1', slot: 'slot-a', kind: 'card', card: card.id, lane: null, project: 'p', from: '', to: null, why: null, endRev: null }
    let tries = 0
    state.pool = { openLeases: () => [lease], lease: () => lease, prepare: async () => (tries++, { error: 'git checkout failed (test)' }) }
    const ws = { path: e.home, lifetime: { aborted: false }, projectConfig: async () => ({ agents: [{ id: 'B1', name: 'B1' }] }) } as never
    // Its Start's hold (HI-1976): starting until the preparation fails, then a failed start, with why.
    startBegun(e.project, 'B1', `#${card.id}`, { fresh: true })
    expect(startNow(e.project, 'B1')).toEqual({ starting: true, failed: null, waiting: null })
    await settleSlotCards(ws, e.project)
    const notices = () => e.store.pendingActions().filter((a) => a.kind === 'notify')
    await vi.waitFor(() => expect(notices()).toHaveLength(1), { timeout: HUNG_MS })
    await vi.waitFor(() => expect(startNow(e.project, 'B1')).toEqual({ starting: false, failed: "Hive couldn't get slot-a ready: git checkout failed (test)", waiting: null }), { timeout: HUNG_MS })
    const shown = notices()[0].payload.shown as { id: string; values: Record<string, string> }
    expect(shown).toEqual({ id: 'service.slots.notPrepared', values: { slot: 'slot-a', card: card.key, why: 'git checkout failed (test)' } })
    // A message the workflow knows: what the card's history line and the window resolve it by.
    const { workflowMessage } = await import('../src/shared/workflow/texts')
    expect(workflowMessage(shown.id)?.id).toBe('service.slots.notPrepared')
    // Not tried again, nor told again, by the next pass.
    await settleSlotCards(ws, e.project)
    expect(tries).toBe(1)
    expect(notices()).toHaveLength(1)
  })
})

describe("a placement owed at a restart resumes its builder's conversation (HI-1746)", { timeout: 60_000 }, () => {
  async function owed(): Promise<{ e: Env; n: number; key: string; slot: string; cycle: NonNullable<ReturnType<typeof cycleIn>>; ws: never }> {
    const e = (env = setup({ platform: 'git', review: 'none', finish: 'agentMerges', folder: 'slots', target: 'main' }, { autoRun: false }))
    state.wf = e.wf
    const card = e.wf.createCard({ title: 'Placed' })
    const slot = join(tempDir('slot-'), 'slot-a')
    state.slot = slot
    e.wf.cfg.slotFor = async () => ({ slot: 'slot-a', folder: slot, lease: 'l-1', fresh: true })
    moved(await e.wf.start(card.key, B1))
    await e.wf.write(card, null, 'hive', (w) => void w.fact('SlotPrepared', { lease: 'l-1', line: 'hive/AM/x', revision: 'r' }))
    const ws = { path: e.home, lifetime: { aborted: false }, projectConfig: async () => ({ agents: [{ id: 'B1', name: 'B1' }] }) } as never
    return { e, n: card.id, key: card.key, slot, cycle: cycleIn(e.store.facts(card.id))!, ws }
  }
  const lease = { id: 'l-1', agent: 'B1', slot: 'slot-a', kind: 'card', card: 0, lane: null, project: 'p', from: '', to: null, why: null, endRev: null } as never
  const placedHow = (e: Env, n: number): string[] => e.store.facts(n).filter((f) => f.kind === 'BuilderPlaced').map((f) => (f.data as { how: string }).how)
  const notices = (e: Env): string[] => e.store.pendingActions().filter((a) => a.kind === 'notify').map((a) => String(a.payload.text))
  /** The builder's status changing (what a waiting placement looks again at). */
  const status = (): void => tellListeners({ type: 'session-status', state: { agentId: 'B1', projectPath: env!.project } as never })
  const resume = { is: 'resume', id: 'c1', name: 'B1 · AM-1' } as const

  it('its builder stopped, its conversation bound to the lease: that conversation resumed with the card, once', async () => {
    const { e, n, cycle, ws } = await owed()
    state.conv = resume
    await place(ws, e.project, e.wf, n, cycle, lease)
    expect(state.calls).toEqual(['resume c1 with the card'])
    expect(placedHow(e, n)).toEqual(['resumed'])
    expect(state.deliveries.map((d) => d.state)).toEqual(['offered'])
  })

  it("HI-2134: resumed with the card, its fact not written (its workspace closed): the next pass records it resumed, not typed, and gives nothing more", async () => {
    const { e, n, slot, cycle, ws } = await owed()
    // The earlier pass's launch: the conversation resumed in its slot with the card's delivery, kept with how it was made.
    state.deliveries.push({ id: 'm8', source: 'slot-placement', ref: `${n}:${cycle.seq}:l-1`, state: 'received', meta: { how: 'resumed' } })
    state.live = { cwd: slot, sessionId: 'c1' }
    await place(ws, e.project, e.wf, n, cycle, lease)
    expect(state.calls).toEqual([])
    expect(state.deliveries).toHaveLength(1)
    expect(e.store.facts(n).find((f) => f.kind === 'BuilderPlaced')?.data).toMatchObject({ delivery: 'm8', how: 'resumed' })
  })

  it("HI-2134: a placement's delivery keeps how it was made", async () => {
    const { e, n, cycle, ws } = await owed()
    state.conv = resume
    await place(ws, e.project, e.wf, n, cycle, lease)
    expect(state.deliveries.map((d) => d.meta)).toEqual([{ how: 'resumed' }])
  })

  it("its conversation's lookup failing (unknown): nothing launched, tried again; resumed once it can be read", async () => {
    const { e, n, cycle, ws } = await owed()
    state.conv = resume
    state.convFails = true
    await expect(place(ws, e.project, e.wf, n, cycle, lease)).rejects.toThrow(/EBUSY/)
    expect(state.calls).toEqual([])
    expect(placedHow(e, n)).toEqual([])
    state.convFails = false
    await place(ws, e.project, e.wf, n, cycleIn(e.store.facts(n))!, lease)
    expect(state.calls).toEqual(['resume c1 with the card'])
    expect(placedHow(e, n)).toEqual(['resumed'])
  })

  it('no conversation it can resume there (none bound, or its transcript gone): a new one in the slot, as before', async () => {
    const { e, n, cycle, ws } = await owed()
    await place(ws, e.project, e.wf, n, cycle, lease)
    expect(state.calls).toEqual(['start with the card'])
    expect(placedHow(e, n)).toEqual(['started'])
  })

  it('its conversation held: it waits, the card told once, never a new or an older conversation; resumed once it can', async () => {
    const { e, n, cycle, ws } = await owed()
    state.conv = { is: 'held', hold: { is: 'draining', slot: 'slot-a' } }
    const placing = place(ws, e.project, e.wf, n, cycle, lease)
    await vi.waitFor(() => expect(notices(e)).toHaveLength(1), { timeout: HUNG_MS })
    expect(notices(e)[0]).toMatch(/can't give AM-\d+ to B1 yet: its conversation in slot-a can't resume now \(its last session there is still ending\)/)
    // Looked at again, still held: not told again, and nothing launched.
    status()
    await vi.waitFor(() => expect(state.logged.filter((l) => /waits for .*B1.*'s conversation/.test(l)).length).toBeGreaterThanOrEqual(2), { timeout: HUNG_MS })
    expect(notices(e)).toHaveLength(1)
    expect(state.calls).toEqual([])
    state.conv = resume
    status()
    await placing
    expect(state.calls).toEqual(['resume c1 with the card'])
    expect(placedHow(e, n)).toEqual(['resumed'])
  })

  it("this run's restart resume will bring it back: it waits, launches nothing, and types the card into the resumed conversation", async () => {
    const { e, n, slot, cycle, ws } = await owed()
    state.conv = resume
    state.resuming = true
    const placing = place(ws, e.project, e.wf, n, cycle, lease)
    status()
    expect(state.calls).toEqual([])
    // The queue's resume: running in its slot, in that conversation.
    state.live = { cwd: slot, sessionId: 'c1' }
    state.resuming = false
    status()
    await placing
    expect(state.calls).toEqual(['typed (given)'])
    expect(placedHow(e, n)).toEqual(['typed'])
  })

  it("the restart resume failing or cancelled (the builder still stopped): it then resumes the conversation itself", async () => {
    const { e, n, cycle, ws } = await owed()
    state.conv = resume
    state.resuming = true
    const placing = place(ws, e.project, e.wf, n, cycle, lease)
    status()
    expect(state.calls).toEqual([])
    state.resuming = false
    status()
    await placing
    expect(state.calls).toEqual(['resume c1 with the card'])
    expect(placedHow(e, n)).toEqual(['resumed'])
  })

  it('another start of it winning (Resume All, the restart queue): its own refused and not given; the next try types the card in, once', async () => {
    const { e, n, cycle, ws } = await owed()
    state.conv = resume
    state.starts = ['lost']
    await expect(place(ws, e.project, e.wf, n, cycle, lease)).rejects.toThrow(/already running or starting/)
    expect(placedHow(e, n)).toEqual([])
    await place(ws, e.project, e.wf, n, cycleIn(e.store.facts(n))!, lease)
    expect(state.calls).toEqual(['resume c1 with the card (lost)', 'typed (given)'])
    expect(state.deliveries.map((d) => d.state)).toEqual(['cancelled', 'offered'])
    expect(placedHow(e, n)).toEqual(['typed'])
    expect(notices(e)).toEqual([])
  })

  it("its resume refused for now (a crashed run's processes still in its slot): a wait, told once, never a counted try; resumed once the slot is ready", async () => {
    const { e, n, cycle, ws } = await owed()
    state.conv = resume
    state.starts = ['busy', 'busy', 'busy']
    const placing = place(ws, e.project, e.wf, n, cycle, lease)
    await vi.waitFor(() => expect(notices(e)).toHaveLength(1), { timeout: HUNG_MS })
    expect(notices(e)[0]).toMatch(/can't give AM-\d+ to B1 yet: its conversation in slot-a can't resume now \(slot-a still has another session in it \(test\)\)/)
    // Each look refused again: still a wait, not told again, never given up on.
    for (const tries of [2, 3]) {
      status()
      await vi.waitFor(() => expect(state.calls).toHaveLength(tries), { timeout: HUNG_MS })
    }
    expect(notices(e)).toHaveLength(1)
    // The slot ready: the next look resumes it.
    status()
    await placing
    expect(state.calls).toEqual(['resume c1 with the card (busy)', 'resume c1 with the card (busy)', 'resume c1 with the card (busy)', 'resume c1 with the card'])
    expect(placedHow(e, n)).toEqual(['resumed'])
    expect(state.logged.some((l) => /didn't resume/.test(l))).toBe(false)
  })

  it("its slot held by what a run left running there (HI-2304): no resume tried, nothing delivered, told once and on the agent; resumed once it is freed", async () => {
    const { e, n, cycle, ws } = await owed()
    state.conv = resume
    state.held = "slot-a is held by WindowsSandboxServer, left running by B1's last run: it is free once they end"
    const placing = place(ws, e.project, e.wf, n, cycle, lease)
    await vi.waitFor(() => expect(notices(e)).toHaveLength(1), { timeout: HUNG_MS })
    expect(notices(e)[0]).toMatch(/can't give AM-\d+ to B1 yet: its conversation in slot-a can't resume now \(slot-a is held by WindowsSandboxServer, left running by B1's last run/)
    // On the agent, and so the card's stall: why its start waits.
    expect(startNow(e.project, 'B1').waiting).toMatch(/held by WindowsSandboxServer/)
    // Each look while it is still held: nothing started or delivered, not told again.
    // (Each wait also asks once as it starts listening, HR1's round 1.)
    for (let i = 0; i < 2; i++) {
      const looked = state.heldLooks
      status()
      await vi.waitFor(() => expect(state.heldLooks).toBeGreaterThan(looked + 1), { timeout: HUNG_MS })
    }
    expect(state.calls).toEqual([])
    expect(state.deliveries).toEqual([])
    expect(notices(e)).toHaveLength(1)
    expect(state.logged.filter((l) => /waits for .*slot-a.* to be freed/.test(l))).toHaveLength(1)
    // Freed: the next look resumes it, and its start no longer waits.
    state.held = null
    status()
    await placing
    expect(state.calls).toEqual(['resume c1 with the card'])
    expect(placedHow(e, n)).toEqual(['resumed'])
    expect(startNow(e.project, 'B1').waiting).toBeNull()
  })

  it("its slot freed while the pass told its card, before its wait listens (HR1's round 1): it goes on at once, never waiting the fallback", async () => {
    const { e, n, cycle, ws } = await owed()
    state.conv = resume
    state.held = "slot-a is held by WindowsSandboxServer, left running by B1's last run: it is free once they end"
    state.freeAfterHeldLook = true
    // No event comes (no status, no slot freed told): only the wait's own look, once it listens, finds it free.
    await place(ws, e.project, e.wf, n, cycle, lease)
    expect(notices(e)).toHaveLength(1)
    expect(state.calls).toEqual(['resume c1 with the card'])
    expect(placedHow(e, n)).toEqual(['resumed'])
  }, HUNG_MS)

  it('three failed resumes: the card told, never a new conversation; once its builder runs there (resumed by hand), the card typed in once', async () => {
    const { e, n, slot, cycle, ws } = await owed()
    state.conv = resume
    state.starts = ['fails', 'fails', 'fails']
    await expect(place(ws, e.project, e.wf, n, cycle, lease)).rejects.toThrow(/couldn't resume/)
    await expect(place(ws, e.project, e.wf, n, cycleIn(e.store.facts(n))!, lease)).rejects.toThrow(/couldn't resume/)
    expect(notices(e)).toEqual([])
    const placing = place(ws, e.project, e.wf, n, cycleIn(e.store.facts(n))!, lease)
    await vi.waitFor(() => expect(notices(e)).toHaveLength(1), { timeout: HUNG_MS })
    expect(notices(e)[0]).toMatch(/couldn't resume B1's conversation in slot-a for AM-\d+ \(three tries\): its conversation couldn't resume \(test\)\. Resume B1 from Sessions/)
    // Its card's stall says why (HI-1976), not only that B1 isn't running.
    expect(startNow(e.project, 'B1').failed).toMatch(/^its conversation in slot-a didn't resume \(3 tries\): its conversation couldn't resume \(test\)/)
    // A look while it is still stopped launches nothing more.
    status()
    await vi.waitFor(() => expect(state.logged.some((l) => /didn't resume \(3 tries\)/.test(l))).toBe(true), { timeout: HUNG_MS })
    expect(state.calls).toEqual(['resume c1 with the card (fails)', 'resume c1 with the card (fails)', 'resume c1 with the card (fails)'])
    // The user resumes it from Sessions: it runs in its slot, and the card is typed in.
    state.live = { cwd: slot, sessionId: 'c1' }
    status()
    await placing
    expect(state.calls.slice(3)).toEqual(['typed (given)'])
    expect(placedHow(e, n)).toEqual(['typed'])
  })

  describe('what a placement keeps between its looks and tries (HI-1804)', () => {
    const kept = (ws: never, n: number) => placementTracksForTests(ws).get(`${env!.project.toLowerCase()}#${n}`) ?? null

    it('kept while it waits or is tried again (its tries, its cutoff, the holds it told), let go once it is placed', async () => {
      const { e, n, slot, cycle, ws } = await owed()
      state.conv = resume
      // Two failed tries: kept across ensure's tries again (each a new call).
      state.starts = ['fails', 'fails']
      await expect(place(ws, e.project, e.wf, n, cycle, lease)).rejects.toThrow(/couldn't resume/)
      await expect(place(ws, e.project, e.wf, n, cycleIn(e.store.facts(n))!, lease)).rejects.toThrow(/couldn't resume/)
      expect(kept(ws, n)).toMatchObject({ ref: `${n}:${cycle.seq}:l-1`, failures: 2, gaveUp: false })
      // Held now: it waits, told once, and keeps that while it waits.
      state.conv = { is: 'held', hold: { is: 'draining', slot: 'slot-a' } }
      const placing = place(ws, e.project, e.wf, n, cycleIn(e.store.facts(n))!, lease)
      await vi.waitFor(() => expect(notices(e)).toHaveLength(1), { timeout: HUNG_MS })
      expect(kept(ws, n)).toMatchObject({ failures: 2, told: new Set(['draining']) })
      // Resumed by hand meanwhile: typed in, and what it kept let go.
      state.live = { cwd: slot, sessionId: 'c1' }
      status()
      await placing
      expect(placedHow(e, n)).toEqual(['typed'])
      expect(kept(ws, n)).toBeNull()
    })

    it('let go once its placement is obsolete (the card moved on, the rules off) or its workspace ends', async () => {
      const { e, n, cycle, ws } = await owed()
      state.conv = resume
      state.starts = ['fails']
      await expect(place(ws, e.project, e.wf, n, cycle, lease)).rejects.toThrow(/couldn't resume/)
      expect(kept(ws, n)).toMatchObject({ failures: 1 })
      // The rules off before its next try: nothing to place, and nothing kept.
      state.enforced = false
      await place(ws, e.project, e.wf, n, cycleIn(e.store.facts(n))!, lease)
      expect(kept(ws, n)).toBeNull()
      // Waiting on a hold when its workspace ends: the wait ends, and nothing is kept.
      state.enforced = true
      state.conv = { is: 'held', hold: { is: 'draining', slot: 'slot-a' } }
      const placing = place(ws, e.project, e.wf, n, cycleIn(e.store.facts(n))!, lease)
      await vi.waitFor(() => expect(kept(ws, n)?.told.has('draining')).toBe(true), { timeout: HUNG_MS })
      ;(ws as unknown as { lifetime: { aborted: boolean } }).lifetime.aborted = true
      status()
      await placing
      expect(kept(ws, n)).toBeNull()
      expect(placedHow(e, n)).toEqual([])
    })

    it("a failed try's record goes at the slot pass once its card is put back, without place running again (HR4's round 1)", async () => {
      const { e, n, key, cycle, ws } = await owed()
      state.conv = resume
      state.starts = ['fails']
      await expect(place(ws, e.project, e.wf, n, cycle, lease)).rejects.toThrow(/couldn't resume/)
      expect(kept(ws, n)).toMatchObject({ failures: 1 })
      // Put back: its lease ends, and the pass passes the card over (no placement pending for it).
      moved(await e.wf.putBack(key, B1, { why: 'not now' }))
      await settleSlotCards(ws, e.project)
      expect(kept(ws, n)).toBeNull()
      expect(state.calls).toEqual(['resume c1 with the card (fails)'])
    })

    it('a pending placement keeps its record through the passes while it waits, and loses it once its card is put back', async () => {
      const { e, n, key, ws } = await owed()
      state.conv = { is: 'held', hold: { is: 'draining', slot: 'slot-a' } }
      const open = lease as { id: string; card: number }
      state.pool = { openLeases: () => (e.wf.state(e.store.card(n)!).stage === 'active' ? [{ ...open, card: n }] : []), lease: () => ({ ...open, card: n }) }
      // The pass starts its placement, which waits on the hold: told once, its record kept.
      await settleSlotCards(ws, e.project)
      await vi.waitFor(() => expect(kept(ws, n)?.told.has('draining')).toBe(true), { timeout: HUNG_MS })
      await settleSlotCards(ws, e.project)
      expect(kept(ws, n)?.told.has('draining')).toBe(true)
      expect(notices(e)).toHaveLength(1)
      // Put back: the next pass lets it go, and the waiting placement ends at its next look.
      moved(await e.wf.putBack(key, B1, { why: 'not now' }))
      await settleSlotCards(ws, e.project)
      expect(kept(ws, n)).toBeNull()
      status()
      expect(placedHow(e, n)).toEqual([])
    })

    it("a new cycle of the card starts afresh: the last cycle's tries and notices aren't its own", async () => {
      const { e, n, key, cycle, ws } = await owed()
      state.conv = resume
      state.starts = ['fails', 'fails']
      await expect(place(ws, e.project, e.wf, n, cycle, lease)).rejects.toThrow(/couldn't resume/)
      await expect(place(ws, e.project, e.wf, n, cycleIn(e.store.facts(n))!, lease)).rejects.toThrow(/couldn't resume/)
      expect(kept(ws, n)).toMatchObject({ failures: 2 })
      // Started again (put back, started: a new cycle under a new lease, prepared).
      moved(await e.wf.putBack(key, B1, { why: 'again' }))
      e.wf.cfg.slotFor = async () => ({ slot: 'slot-a', folder: state.slot, lease: 'l-2', fresh: true })
      moved(await e.wf.start(key, B1))
      await e.wf.write(e.store.card(n)!, null, 'hive', (w) => void w.fact('SlotPrepared', { lease: 'l-2', line: 'hive/AM/x', revision: 'r' }))
      const again = cycleIn(e.store.facts(n))!
      const lease2 = { ...(lease as object), id: 'l-2' } as never
      // One failure on the new cycle is its first, not the old one's third: no cutoff, no notice.
      state.starts = ['fails']
      await expect(place(ws, e.project, e.wf, n, again, lease2)).rejects.toThrow(/couldn't resume/)
      expect(kept(ws, n)).toMatchObject({ ref: `${n}:${again.seq}:l-2`, failures: 1, gaveUp: false })
      expect(notices(e)).toEqual([])
    })
  })
})

describe("a lane's brief in every placement of its cards (HI-1795)", { timeout: 60_000 }, () => {
  /** A lane's card started in its slot (the lane's lease, l-1) and prepared there, its builder B1; the lane as kept. */
  async function laneCard(brief: string | null = 'Lane order: a, then b. Stay off src/renderer.'): Promise<{ e: Env; n: number; key: string; slot: string; cycle: NonNullable<ReturnType<typeof cycleIn>>; ws: never }> {
    const e = (env = setup({ platform: 'git', review: 'none', finish: 'agentMerges', folder: 'slots', target: 'main' }, { autoRun: false }))
    state.wf = e.wf
    const card = e.wf.createCard({ title: 'In a lane' })
    const slot = join(tempDir('slot-'), 'slot-a')
    state.slot = slot
    e.wf.cfg.slotFor = async () => ({ slot: 'slot-a', folder: slot, lease: 'l-1', fresh: true })
    moved(await e.wf.start(card.key, B1))
    await e.wf.write(card, null, 'hive', (w) => void w.fact('SlotPrepared', { lease: 'l-1', line: 'hive/AM/x', revision: 'r' }))
    lane.text = brief
    const ws = { path: e.home, lifetime: { aborted: false }, projectConfig: async () => ({ agents: [{ id: 'B1', name: 'B1' }] }) } as never
    return { e, n: card.id, key: card.key, slot, cycle: cycleIn(e.store.facts(card.id))!, ws }
  }
  /** The lane as rawLanes gives it: its brief's text set by each test. */
  const lane = { text: null as string | null }
  const laneLease = { id: 'l-1', agent: 'B1', slot: 'slot-a', kind: 'lane', card: null, lane: 'lane-1', project: 'p', from: '', to: null, why: null, endRev: null } as never
  const cardLease = { id: 'l-1', agent: 'B1', slot: 'slot-a', kind: 'card', card: 0, lane: null, project: 'p', from: '', to: null, why: null, endRev: null } as never
  const keptLanes = () => [{ id: 'lane-1', state: 'active', startedBy: 'the Assistant', ...(lane.text !== undefined ? { brief: { text: lane.text, rev: 1, out: null } } : {}) }]
  const bodies = (): string[] => state.deliveries.map((d) => d.body ?? '')
  const BRIEF = /Your lane's brief \(lane lane-1, from the Assistant\):\nLane order: a, then b\. Stay off src\/renderer\./

  for (const [how, given] of [
    ['typed', () => (state.live = { cwd: state.slot, sessionId: 's1' })],
    ['newConversation', () => (state.live = { cwd: 'C:\\elsewhere', sessionId: 's0' })],
    ['started', () => undefined],
    ['resumed', () => (state.conv = { is: 'resume', id: 'c1', name: 'B1' })]
  ] as const) {
    it(`a lane's card placed ${how}: the one delivery carries the card's prompt, then the lane's brief`, async () => {
      state.lanes = async () => keptLanes() as never
      const { e, n, cycle, ws } = await laneCard()
      given()
      await place(ws, e.project, e.wf, n, cycle, laneLease)
      expect(e.store.facts(n).filter((f) => f.kind === 'BuilderPlaced').map((f) => (f.data as { how: string }).how)).toEqual([how])
      expect(bodies()).toHaveLength(1)
      expect(bodies()[0]).toMatch(/^Work on task AM-\d+ from the Hive task board: /)
      expect(bodies()[0]).toMatch(BRIEF)
    })
  }

  it("its lane read failing (unknown, HR4's round 1): nothing delivered or placed, tried again; the retry's prompt keeps the brief", async () => {
    let fails = 1
    state.lanes = async () => {
      if (fails-- > 0) throw new Error('the board is closing (test)')
      return keptLanes() as never
    }
    const { e, n, cycle, ws } = await laneCard()
    await expect(place(ws, e.project, e.wf, n, cycle, laneLease)).rejects.toThrow(/board is closing/)
    expect(bodies()).toEqual([])
    expect(e.store.facts(n).some((f) => f.kind === 'BuilderPlaced')).toBe(false)
    await place(ws, e.project, e.wf, n, cycleIn(e.store.facts(n))!, laneLease)
    expect(bodies()).toHaveLength(1)
    expect(bodies()[0]).toMatch(BRIEF)
  })

  it("a card of no lane, or a lane with no brief (or one cleared): the card's prompt alone", async () => {
    state.lanes = async () => keptLanes() as never
    const one = await laneCard()
    await place(one.ws, one.e.project, one.e.wf, one.n, one.cycle, cardLease)
    expect(bodies()[0]).not.toMatch(/lane's brief/)
    env!.close()
    state.deliveries = []
    const cleared = await laneCard(null)
    await place(cleared.ws, cleared.e.project, cleared.e.wf, cleared.n, cleared.cycle, laneLease)
    expect(bodies()).toHaveLength(1)
    expect(bodies()[0]).not.toMatch(/lane's brief/)
  })

  it("a window Start's own prompt is kept whole, the brief after it", async () => {
    state.lanes = async () => keptLanes() as never
    const { e, n, cycle, ws } = await laneCard()
    expectStartPrompt(e.project, n)('Work on task AM-1 from the window, with the user\'s note: be quick.')
    await place(ws, e.project, e.wf, n, cycle, laneLease)
    expect(bodies()[0]).toMatch(/^Work on task AM-1 from the window, with the user's note: be quick\.\n\nYour lane's brief/)
    expect(bodies()[0]).toMatch(BRIEF)
  })

  it('fixed once made: a retry finds its delivery and makes no other, whatever the brief says since; one not given is made again with the brief as it is then', async () => {
    state.lanes = async () => keptLanes() as never
    const { e, n, cycle, ws } = await laneCard()
    // The first try's delivery not given (its launch failed): nothing recorded.
    state.next = ['launchFails']
    await expect(place(ws, e.project, e.wf, n, cycle, laneLease)).rejects.toThrow(/couldn't start/)
    // The brief edited before the next try: that try's one delivery carries the new text.
    lane.text = 'Edited: only card b now.'
    await place(ws, e.project, e.wf, n, cycleIn(e.store.facts(n))!, laneLease)
    expect(bodies()).toHaveLength(2)
    expect(bodies()[1]).toMatch(/Your lane's brief \(lane lane-1, from the Assistant\):\nEdited: only card b now\./)
    // Placed: edited again, a later pass makes nothing more (its delivery's body is what was given).
    lane.text = 'Edited again.'
    await place(ws, e.project, e.wf, n, cycleIn(e.store.facts(n))!, laneLease)
    expect(bodies()).toHaveLength(2)
    expect(bodies()[1]).toMatch(/Edited: only card b now\./)
  })

  it('a delivery made before a restart (on its way: uncertain) is never remade with a later brief', async () => {
    state.lanes = async () => keptLanes() as never
    const { e, n, cycle, ws } = await laneCard()
    state.deliveries.push({ id: 'm9', source: 'slot-placement', ref: `${n}:${cycle.seq}:l-1`, state: 'uncertain', body: 'Work on task … (as made before the restart)' })
    lane.text = 'A brief edited after that delivery was made.'
    await place(ws, e.project, e.wf, n, cycle, laneLease)
    expect(bodies()).toEqual(['Work on task … (as made before the restart)'])
    expect(e.store.facts(n).find((f) => f.kind === 'BuilderPlaced')?.data).toMatchObject({ delivery: 'm9' })
  })
})

describe('Hive quitting (#1628)', { timeout: 60_000 }, () => {
  // Each test quits: started again after it, as the next Hive's start does, so the other tests' passes run.
  afterEach(() => {
    startSlotCards()
    stopSlotCards()
  })

  /** A pass of a project's slots held at its read of the lanes, until `go` lets it on (or fails it). */
  async function heldPass(): Promise<{ pass: Promise<void>; go: (fail?: Error) => void; reads: () => number; ws: never; project: string }> {
    const e = (env = setup({ platform: 'git', review: 'none', finish: 'agentMerges', folder: 'slots', target: 'main' }, { autoRun: false }))
    state.wf = e.wf
    let release!: (fail?: Error) => void
    const held = new Promise<void>((resolve, reject) => (release = (fail) => (fail ? reject(fail) : resolve())))
    let reads = 0
    state.lanes = async () => {
      reads++
      await held
      return []
    }
    const ws = { path: e.home, lifetime: { aborted: false }, info: () => ({ projects: [] }), projectConfig: async () => ({ agents: [] }) } as never
    const pass = settleSlotCards(ws, e.project)
    await vi.waitFor(() => expect(reads).toBe(1), { timeout: HUNG_MS })
    return { pass, go: release, reads: () => reads, ws, project: e.project }
  }

  it("waits for a pass running, which goes on to no next step; none starts after, and the next start's do", async () => {
    const { pass, go, reads, ws, project } = await heldPass()
    let quit = false
    const quitting = quitSlotCards(HUNG_MS).then(() => void (quit = true))
    await new Promise((r) => setImmediate(r))
    expect(quit).toBe(false)
    go()
    await quitting
    await pass
    // Past the lanes' read the pass stopped: the lanes waiting for a slot (step 4) never looked up.
    expect(state.waitingLooks).toBe(0)
    await settleSlotCards(ws, project)
    expect(reads()).toBe(1)
    // The next start: passes run again.
    startSlotCards()
    stopSlotCards()
    await settleSlotCards(ws, project)
    expect(reads()).toBe(2)
    expect(state.waitingLooks).toBe(1)
  })

  it("a pass whose boards close under it as Hive quits says so in the log, not as a warning", async () => {
    const { pass, go } = await heldPass()
    const quitting = quitSlotCards(HUNG_MS)
    go(new Error('No workspace is open'))
    await quitting
    await pass
    expect(state.logged.filter((l) => l.startsWith('warn'))).toEqual([])
    expect(state.logged.some((l) => l.startsWith('info settling the slots of') && l.includes('cut short by quitting'))).toBe(true)
  })

  it("a lane waiting for a slot whose lend is under way as Hive quits isn't started: it keeps the slot and its wait for the next start", async () => {
    const e = (env = setup({ platform: 'git', review: 'none', finish: 'agentMerges', folder: 'slots', target: 'main' }, { autoRun: false }))
    state.wf = e.wf
    state.waiting = [{ id: 'lane-1', project: 'project', builder: { id: 'b1', name: 'B1' }, slotWait: { since: '2026-10-25T00:00:00.000Z' } }]
    let lends = 0
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    state.pool = {
      leaseOf: () => null,
      leasesOf: () => [],
      lend: async () => {
        lends++
        await held
        return { ok: true, lease: { id: 'l-9', slot: 'slot-a' }, slot: { name: 'slot-a' } }
      }
    }
    const ws = { path: e.home, lifetime: { aborted: false }, info: () => ({ projects: [{ name: 'project', path: e.project }] }), projectConfig: async () => ({ agents: [] }) } as never
    const pass = settleSlotCards(ws, e.project)
    await vi.waitFor(() => expect(lends).toBe(1), { timeout: HUNG_MS })
    const quitting = quitSlotCards(HUNG_MS)
    release()
    await quitting
    await pass
    expect(state.calls).toEqual([])
    expect(state.logged.filter((l) => l.startsWith('warn'))).toEqual([])
  })

  it('a lane waiting for a slot whose cards are all no-code by now (HI-2338): started with no slot, nothing lent, its wait cleared; one with a code card is lent one', async () => {
    const e = (env = setup({ platform: 'git', review: 'none', finish: 'agentMerges', folder: 'slots', target: 'main' }, { autoRun: false }))
    state.wf = e.wf
    state.noCode = [7, 8]
    state.waiting = [
      { id: 'lane-1', project: 'project', builder: { id: 'b1', name: 'B1' }, cards: [7, 8], slotWait: { since: '2026-10-25T00:00:00.000Z' } },
      { id: 'lane-2', project: 'project', builder: { id: 'b2', name: 'B2' }, cards: [8, 9], slotWait: { since: '2026-10-25T00:01:00.000Z' } }
    ]
    const lent: string[] = []
    state.pool = {
      leaseOf: () => null,
      leasesOf: () => [],
      lend: async (o: { lane: string }) => (lent.push(o.lane), { ok: true, lease: { id: 'l-9', slot: 'slot-a' }, slot: { name: 'slot-a' } })
    }
    const ws = { path: e.home, lifetime: { aborted: false }, info: () => ({ projects: [{ name: 'project', path: e.project }] }), projectConfig: async () => ({ agents: [] }) } as never
    await settleSlotCards(ws, e.project)
    expect(lent).toEqual(['lane-2'])
    expect(state.calls).toEqual(['start lane lane-1 with no slot', 'lane lane-1 waits no more', 'start lane lane-2', 'lane lane-2 waits no more'])
  })

  it('a pass that never ends holds the quit only for its bound', async () => {
    const { go } = await heldPass()
    await quitSlotCards(10)
    go()
  })

  it('quitNow quiets the slots before the sessions stop and waits for them before Hive quits, the boards closing after (index.ts)', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8')
    const body = src.slice(src.indexOf('async function quitNow('), src.indexOf('function relaunch('))
    const at = (s: string): number => {
      const i = body.indexOf(s)
      expect(i, s).toBeGreaterThan(-1)
      return i
    }
    expect(at('= quitSlotCards()')).toBeLessThan(at('sessions.stopAllAndWait('))
    expect(at('await slotsQuiet')).toBeLessThan(at('app.quit()'))
    // The stopped runs' slot writers released once their outcomes are known (after the leftovers' look), before the
    // workspaces close (HI-1801).
    expect(at('await quitLeftovers()')).toBeLessThan(at('await sessions.writersSettled('))
    expect(at('await sessions.writersSettled(')).toBeLessThan(at('app.quit()'))
    const willQuit = src.slice(src.indexOf("app.on('will-quit'"))
    expect(willQuit.indexOf('stopSlotCards()')).toBeLessThan(willQuit.indexOf('closeAllBoards()'))
  })
})

describe("a card's cycle in a slot (#1438)", () => {
  const f = (seq: number, kind: string, data: object): Fact => ({ seq, card: 1, kind, at: '', actor: 'hive', source: 'recorded', data }) as unknown as Fact
  const started = (seq: number, lease: string) => f(seq, 'Started', { folder: 'F', line: 'hive/AM/AM-1-x', base: 'b', target: 'main', builder: 'B1', cardKind: 'code', slot: 'slot-a', lease })

  it("is its last start's, with what was done for it since; a start outside slots has none", () => {
    expect(cycleIn([f(1, 'Started', { folder: 'project', line: 'main', base: 'b', target: 'main', builder: 'B1', cardKind: 'code' })])).toBeNull()
    const facts = [started(1, 'l-1'), f(2, 'SlotPrepared', { lease: 'l-1', line: 'hive/AM/AM-1-x', revision: 'r' }), f(3, 'PlacementClaimed', { lease: 'l-1', pid: 5, started: 6 }), f(4, 'BuilderPlaced', { lease: 'l-1', delivery: 'm1', how: 'typed' })]
    expect(cycleIn(facts)).toMatchObject({ seq: 1, prepared: { revision: 'r' }, claimed: { pid: 5, seq: 3 }, placed: true, deleted: false, deleting: null })
    // Put back and started again (the same lease, or another): a new cycle owes all of it again.
    expect(cycleIn([...facts, started(5, 'l-1')])).toMatchObject({ seq: 5, prepared: null, claimed: null, placed: false })
    // What another lease's facts say isn't this cycle's.
    expect(cycleIn([started(1, 'l-2'), f(2, 'SlotPrepared', { lease: 'l-1', line: 'x', revision: 'r' })])).toMatchObject({ prepared: null })
    // A deletion begun is owed until it is settled.
    expect(cycleIn([...facts, f(6, 'LineDeleting', { line: 'x', revision: 'r' })])).toMatchObject({ deleting: { line: 'x' }, deleted: false })
    expect(cycleIn([...facts, f(6, 'LineDeleting', { line: 'x', revision: 'r' }), f(7, 'LineDeleteUndone', { line: 'x', revision: 'r', why: 'checkedOut' })])).toMatchObject({ deleting: null, deleted: false })
    expect(cycleIn([...facts, f(6, 'LineDeleting', { line: 'x', revision: 'r' }), f(7, 'LineDeleted', { line: 'x', revision: 'r', why: 'merged' })])).toMatchObject({ deleting: null, deleted: true })
  })

  it("follows Repair's move and its line's rename since its start, as the card's state does (HI-1791); a later start's own folder and line", () => {
    const at = (folder: string, seq: number, lease = 'l-1') => f(seq, 'Started', { folder, line: 'hive/AM/AM-1-x', base: 'b', target: 'main', builder: 'B1', cardKind: 'code', slot: 'slot-a', lease })
    const before = 'C:\\before\\ws.worktrees\\alpha\\slot-a'
    const after = 'C:\\after\\ws.worktrees\\alpha\\slot-a'
    const afterMove = [at(before, 1), f(2, 'FolderMoved', { from: before.toUpperCase(), to: after, why: 'repair' }), f(3, 'LineRenamed', { from: 'HIVE/AM/AM-1-x', to: 'hive/AM/AM-1-y', why: 'repair' })]
    expect(cycleIn(afterMove)?.started).toMatchObject({ folder: after, line: 'hive/AM/AM-1-y', slot: 'slot-a', lease: 'l-1' })
    // Another folder's move, or another line's rename, isn't its own.
    expect(cycleIn([at(before, 1), f(2, 'FolderMoved', { from: 'C:\\elsewhere', to: after, why: 'repair' }), f(3, 'LineRenamed', { from: 'hive/AM/AM-2-z', to: 'hive/AM/AM-2-w', why: 'repair' })])?.started).toMatchObject({ folder: before, line: 'hive/AM/AM-1-x' })
    // A move before its start was the last cycle's: its start names where it is.
    expect(cycleIn([...afterMove, at(after, 4, 'l-2')])?.started).toMatchObject({ folder: after, line: 'hive/AM/AM-1-x', lease: 'l-2' })
  })
})

describe("a lane's slot in the Progress panel (#1446)", () => {
  it("is its own project's: another project's carried slot, its builder's id the same, is never its slot (HR3's round 1)", () => {
    const e = (env = setup({ platform: 'git' }, { autoRun: false }))
    const card = e.wf.createCard({ title: 'Own line' })
    const db = new DatabaseSync(boardFile(e.home))
    try {
      db.exec('PRAGMA foreign_keys = ON')
      const at = '2026-10-23T10:00:00.000Z'
      let port = 51000
      const slot = (project: string, name: string, slotState = 'lent'): void => void db.prepare('INSERT INTO slots (project, name, folder, state, port_base, created_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(project, name, join(e.home, project, name), slotState, (port += 10), at, at)
      const lease = (id: string, project: string, name: string, kind: 'lane' | 'carried', agent: string, lane: string | null = null): void =>
        void db.prepare('INSERT INTO slot_leases (id, project, slot, kind, lane, agent, from_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, project, name, kind, lane, agent, at)
      // beta's builder, with the same local id as alpha's, carries beta-home.
      slot('beta-id', 'beta-home')
      lease('l-beta', 'beta-id', 'beta-home', 'carried', 'b1')
      const alphaLane = { id: 'lane-a', builder: { id: 'b1', name: 'B1' } }
      expect(laneSlotIn(db, 'alpha-id', alphaLane)).toBeNull()
      expect(laneSlotIn(db, 'beta-id', { id: 'lane-b', builder: { id: 'b1', name: 'B1' } })).toMatchObject({ name: 'beta-home', carried: true })
      // alpha's own carried slot is its slot, with the line of the card last started under that lease.
      slot('alpha-id', 'hb1')
      lease('l-alpha', 'alpha-id', 'hb1', 'carried', 'b1')
      db.prepare("INSERT INTO card_facts (card, seq, kind, at, actor, source, data) VALUES (?, 99, 'Started', ?, 'hive', 'recorded', ?)").run(card.id, at, JSON.stringify({ lease: 'l-alpha', line: 'hive/AM/AM-1-own-line' }))
      expect(laneSlotIn(db, 'alpha-id', alphaLane)).toEqual({ name: 'hb1', carried: true, line: 'hive/AM/AM-1-own-line', state: 'ready', since: at })
      // A slot lent to the lane wins over the carried one; one being made reads as being prepared.
      slot('alpha-id', 'slot-a', 'creating')
      lease('l-lane', 'alpha-id', 'slot-a', 'lane', 'b2', 'lane-a')
      expect(laneSlotIn(db, 'alpha-id', alphaLane)).toMatchObject({ name: 'slot-a', carried: false, line: null, state: 'preparing' })
    } finally {
      db.close()
    }
  })
})
