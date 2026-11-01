// The board's own Stalled mark reads main's start state (HI-1977): each agent's info carries it (withAgentStarts), and the
// window's stall (stallAgentOf, then startFailedReason and stalledReason, as Board.tsx's cardStall reads them) agrees with
// the stall check behind lane watches' notices and the Agent API (cardStall with agentNowOf, HI-1976): an agent whose
// start is under way (its slot being prepared) isn't stalled, and one whose start failed says why, in the window's language.
import { readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import type { AgentInfo, TaskCard } from '../src/shared/types'
import { tempDir } from './tempDir'

const base = tempDir('hive-boardstartstall-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { resetAgentStartsForTests, startBegun, startEnded, startSeq, startWaits } = await import('../src/main/agentStarts')
const { agentNowOf, agentStartOf, cardStall, withAgentStarts } = await import('../src/main/cardStall')
const { stallAgentOf, stalledReason, startFailedReason, startWaitingReason } = await import('../src/shared/tasks')
const { setLanguage, tr } = await import('../src/shared/i18n')

const p = join(base, 'ws', 'alpha')
const card = { number: 7, project: 'alpha', column: 'doing', archived: false, agent: 'b1', agentName: 'B1', blocked: null, history: [], comments: [] } as unknown as TaskCard
const info = { agents: [{ id: 'b1', name: 'B1', live: null } as AgentInfo, { id: 'b2', name: 'B2', live: null } as AgentInfo] }

/** The board's mark for the card, from its agent's info as the window gets it. */
const boardMark = (): string | null => {
  const now = stallAgentOf(withAgentStarts(p, info).agents[0])
  return startFailedReason(card, now, tr) ?? startWaitingReason(card, now, tr) ?? stalledReason(card, now, tr)
}
/** The notice's (and the Agent API's) stall for the card. */
const notice = (): string | null => cardStall(card, agentNowOf(p, 'b1', 'B1'), null)

afterEach(() => {
  resetAgentStartsForTests()
  setLanguage('en', {})
})

describe("the board's Stalled mark while an agent starts (HI-1977)", () => {
  it('a start under way (its slot being prepared): no mark on the board, as no notice', () => {
    startBegun(p, 'b1', '#7', { fresh: true })
    expect(agentStartOf(p, 'b1')).toEqual({ starting: true })
    const agents = withAgentStarts(p, info).agents
    expect(agents[0].start).toEqual({ starting: true })
    // Another agent with no start under way carries none.
    expect(agents[1]).not.toHaveProperty('start')
    expect(boardMark()).toBeNull()
    expect(notice()).toBeNull()
  })

  it("each read carries the count of start changes it has, which each change raises (HR6's round 1: the window orders reads and changes by it)", () => {
    const before = startSeq()
    expect(withAgentStarts(p, info).agents.map((a) => a.startSeq)).toEqual([before, before])
    startBegun(p, 'b1', '#7', { fresh: true })
    startEnded(p, 'b1', '#7', { failed: 'its slot could not be prepared' })
    expect(startSeq()).toBe(before + 2)
    expect(withAgentStarts(p, info).agents[0]).toMatchObject({ startSeq: before + 2, start: { failed: 'its slot could not be prepared' } })
  })

  it("a failed start: the board's mark says why, the same words as the notice", () => {
    startBegun(p, 'b1', '#7', { fresh: true })
    startEnded(p, 'b1', '#7', { failed: "Hive couldn't get slot-b ready: the folder is in use" })
    expect(agentStartOf(p, 'b1')).toEqual({ failed: "Hive couldn't get slot-b ready: the folder is in use" })
    expect(boardMark()).toBe("B1's start failed: Hive couldn't get slot-b ready: the folder is in use")
    expect(boardMark()).toBe(notice())
  })

  it("no start, or one that ended: the mark is still \"isn't running\", as the notice", () => {
    expect(agentStartOf(p, 'b1')).toBeUndefined()
    expect(boardMark()).toBe("B1 isn't running.")
    startBegun(p, 'b1', '#7', { fresh: true })
    startEnded(p, 'b1', '#7', { ok: true })
    expect(boardMark()).toBe("B1 isn't running.")
    expect(boardMark()).toBe(notice())
  })

  it("a start waiting for its held slot (HI-2304): stalled with what holds it, though its placement's hold is on, as the notice; then gone once it goes on", () => {
    const why = "slot-a is held by WindowsSandboxServer, left running by B1's last run: it is free once they end"
    startBegun(p, 'b1', '#7', { fresh: true })
    startWaits(p, 'b1', '#7', why)
    expect(agentStartOf(p, 'b1')).toEqual({ waiting: why })
    expect(boardMark()).toBe(`B1 waits to start: ${why}`)
    expect(boardMark()).toBe(notice())
    // Told only on a change: the same reason again tells nothing.
    const seq = startSeq()
    startWaits(p, 'b1', '#7', why)
    expect(startSeq()).toBe(seq)
    // It goes on: starting again, not stalled; and its start's end takes a wait it left with it.
    startWaits(p, 'b1', '#7', null)
    expect(agentStartOf(p, 'b1')).toEqual({ starting: true })
    expect(boardMark()).toBeNull()
    startWaits(p, 'b1', '#7', why)
    startEnded(p, 'b1', '#7', { ok: true })
    expect(agentStartOf(p, 'b1')).toBeUndefined()
    expect(boardMark()).toBe("B1 isn't running.")
  })

  it("a failed start's mark is in the window's language; the failure is shown as given", () => {
    setLanguage('de', JSON.parse(readFileSync(join(__dirname, '..', 'locales', 'de', 'board.json'), 'utf8')))
    startEnded(p, 'b1', '#7', { failed: 'error: unknown option --bogus' })
    expect(boardMark()).toBe('Agent B1 konnte nicht gestartet werden: error: unknown option --bogus')
  })
})
