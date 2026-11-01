// Stop's exit keys on conditions (HI-2272, src/main/exitKeys.ts), against a simulated Copilot on a test clock: a turn
// whose cancel takes a while, keys lost as it winds down, Hive's view of the turn a second behind, the hint once a key at
// its prompt arms the exit, and the exit a while after the key that exits it.
import { describe, expect, it } from 'vitest'
import { driveExitKeys, EXIT_POLL_MS, type ExitKeysIO } from '../src/main/exitKeys'

interface Model {
  /** In a turn when Stop comes. */
  inTurn?: boolean
  /** How long a turn's cancel takes, from the key to the turn's end. */
  cancelMs?: number
  /** Keys arriving this long after the turn's end are lost (it is still winding down). */
  absorbMs?: number
  /** How long after the turn's end Hive's view of it (the ledger, from its events) says so. */
  ledgerLagMs?: number
  /** How long a key at its prompt takes to show the hint, and how long the exit stays armed. */
  hintMs?: number
  armWindowMs?: number
  /** How long it takes to exit after the key that exits it. */
  exitMs?: number
  /** Killed at this time (the grace): gone, whatever it was doing. */
  killAt?: number
  /** Keys lost at these times as well (a key the terminal dropped). */
  lostAt?: number[]
}

/** A simulated Copilot and the driver's view of it, on a clock `now` that only `wait` moves. */
function copilotModel(m: Model = {}) {
  const o = { inTurn: false, cancelMs: 380, absorbMs: 50, ledgerLagMs: 1000, hintMs: 60, armWindowMs: 3000, exitMs: 1400, killAt: 10_000, lostAt: [] as number[], ...m }
  let now = 0
  let phase: 'turn' | 'cancelling' | 'prompt' = o.inTurn ? 'turn' : 'prompt'
  let turnEndAt = o.inTurn ? Infinity : -Infinity
  let armedAt: number | null = null
  let exitAt = Infinity
  const presses: number[] = []
  const settle = (): void => {
    if (phase === 'cancelling' && now >= turnEndAt) phase = 'prompt'
  }
  const isArmed = (): boolean => armedAt !== null && now >= armedAt + o.hintMs && now < armedAt + o.armWindowMs
  const io: ExitKeysIO = {
    alive: () => now < exitAt && now < o.killAt,
    inTurn: () => o.inTurn && now < turnEndAt + o.ledgerLagMs,
    armed: () => (settle(), isArmed() || (exitAt !== Infinity && armedAt !== null)),
    press: () => {
      presses.push(now)
      settle()
      if (o.lostAt.includes(now) || exitAt !== Infinity) return
      if (phase === 'turn') {
        phase = 'cancelling'
        turnEndAt = now + o.cancelMs
      } else if (phase === 'cancelling' || now < turnEndAt + o.absorbMs) {
        // Lost while the turn winds down.
      } else if (isArmed()) {
        exitAt = now + o.exitMs
      } else {
        armedAt = now
      }
    },
    wait: async (ms) => {
      now += ms
    }
  }
  return { io, presses, exitedAt: () => (exitAt < o.killAt ? exitAt : null), now: () => now }
}

/** The fixed beat Stop used before (three keys 400 ms apart), on the same model: whether it exited before the kill. */
function fixedBeat(m: Model): number | null {
  const sim = copilotModel(m)
  for (let i = 0; i < 3; i++) {
    sim.io.press()
    void sim.io.wait(400)
  }
  while (sim.io.alive()) void sim.io.wait(EXIT_POLL_MS)
  return sim.exitedAt()
}

describe('Stop’s exit keys on conditions (HI-2272)', () => {
  it('reproduces the lost exit with the fixed beat: the second key lands as the cancelled turn winds down', () => {
    expect(fixedBeat({ inTurn: true })).toBeNull()
  })

  it('a Copilot stopped mid-turn exits by itself: its turn cancelled, its end waited for, armed, then exited', async () => {
    const sim = copilotModel({ inTurn: true })
    await driveExitKeys(sim.io, 400)
    expect(sim.exitedAt()).not.toBeNull()
    expect(sim.exitedAt()!).toBeLessThan(10_000)
    // Cancel, arm, exit: no key wasted while the turn wound down.
    expect(sim.presses).toHaveLength(3)
    expect(sim.presses[1]).toBeGreaterThanOrEqual(380 + 1000)
  })

  it('at its prompt: two keys, the second once the hint shows', async () => {
    const sim = copilotModel()
    await driveExitKeys(sim.io, 400)
    expect(sim.presses).toHaveLength(2)
    expect(sim.presses[1] - sim.presses[0]).toBeGreaterThanOrEqual(60)
    expect(sim.exitedAt()).toBe(sim.presses[1] + 1400)
  })

  it('a key lost at its prompt is typed again once the hint hasn’t come, and it still exits', async () => {
    const sim = copilotModel({ lostAt: [0] })
    await driveExitKeys(sim.io, 400)
    expect(sim.exitedAt()).not.toBeNull()
    expect(sim.presses).toHaveLength(3)
  })

  it('the key that exits lost too: armed again once the hint goes, and it still exits', async () => {
    // The hint shows at 60 ms, so the exit key goes at 100 (the next look): lost.
    const sim = copilotModel({ lostAt: [100], armWindowMs: 1500 })
    await driveExitKeys(sim.io, 400)
    expect(sim.exitedAt()).not.toBeNull()
    expect(sim.presses.length).toBeGreaterThanOrEqual(4)
  })

  it('a hint that no longer matches (Copilot changed it): keys at its prompt until it exits', async () => {
    const sim = copilotModel()
    const io: ExitKeysIO = { ...sim.io, armed: () => false }
    await driveExitKeys(io, 400)
    expect(sim.exitedAt()).not.toBeNull()
  })

  it('a turn whose cancel never ends: one key, then nothing until the kill, and the driver stops with it', async () => {
    const sim = copilotModel({ inTurn: true, cancelMs: Infinity })
    await driveExitKeys(sim.io, 400)
    expect(sim.exitedAt()).toBeNull()
    expect(sim.presses).toEqual([0])
    expect(sim.now()).toBeGreaterThanOrEqual(10_000)
  })

  it('its session replaced while a wait yields (a restart taking its terminal): no key after that, at any wait', async () => {
    // HR2's probe on HI-2272: the hint shows at a wait, and before the driver resumes the session ends and a restart's
    // takes its terminal (queued behind the wait's resolution). Each key the driver types records whether its session
    // was still the one being stopped. Replaced at each of the driver's waits in turn: the arm wait, the turn's end, the exit.
    for (const at of ['arm', 'turn', 'exit'] as const) {
      let alive = true
      let armed = false
      let inTurn = at === 'turn'
      const presses: boolean[] = []
      const replace = (): void => void Promise.resolve().then(() => queueMicrotask(() => (alive = false)))
      const io: ExitKeysIO = {
        alive: () => alive,
        inTurn: () => inTurn,
        armed: () => armed,
        press: () => void presses.push(alive),
        wait: async () => {
          if (at === 'arm' && presses.length === 1) {
            armed = true
            replace()
          }
          if (at === 'turn' && presses.length === 1) {
            inTurn = false
            replace()
          }
          if (at === 'exit' && presses.length === 1) armed = true
          if (at === 'exit' && presses.length === 2) {
            armed = false
            replace()
          }
        }
      }
      await driveExitKeys(io, 400)
      expect(presses, at).toEqual(presses.map(() => true))
      expect(alive, at).toBe(false)
    }
  })

  it('Hive’s view of the turn behind (the hint shows, it still says working): the key that exits goes anyway', async () => {
    // Already at its prompt, but Hive still thinks it in a turn: the first key arms it, and the hint ends the wait.
    const sim = copilotModel({ inTurn: true, cancelMs: 0, absorbMs: 0 })
    const io: ExitKeysIO = { ...sim.io, inTurn: () => true }
    sim.io.press()
    await sim.io.wait(EXIT_POLL_MS)
    await driveExitKeys(io, 400)
    expect(sim.exitedAt()).not.toBeNull()
  })
})
