// A connection switch whose resume is refused because its slot is still held (HI-2304: MB1's switch, its slot held by
// what its run left running there): it waits for the slot, looking again at each change, tells the user once, and
// resumes once the slot is free; a real failure still ends it, and it gives up after its bound. runSwitch with stand-ins.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runSwitch, SlotHeld } from '../src/main/connectionSwitch'

// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take.
const HUNG_MS = 10_000

function agent(waitMs?: number) {
  const looks = new Set<() => void>()
  const a = {
    running: true,
    held: 'slot-a is held by WindowsSandboxServer, left running by MB1\'s last run' as string | null,
    fail: null as Error | null,
    resumes: 0,
    told: [] as string[],
    log: [] as string[],
    change: () => {
      for (const l of looks) l()
    }
  }
  const op = runSwitch(
    {
      running: () => a.running,
      heldNow: () => null,
      quit: async () => 'sent',
      resume: async () => {
        a.resumes++
        if (a.fail) throw a.fail
        if (a.held) throw new SlotHeld('slot-a', a.held)
      },
      waits: (e) => (e instanceof SlotHeld ? e.why : null),
      told: (why) => a.told.push(why),
      watch: (look) => {
        looks.add(look)
        return () => looks.delete(look)
      },
      log: (line) => a.log.push(line)
    },
    waitMs
  )
  return { a, op }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("a switch's resume waits for its held slot (HI-2304)", () => {
  it('held: waits, told once; looked at again at each change; resumes once the slot is free', async () => {
    const { a, op } = agent()
    a.running = false
    a.change()
    await vi.waitFor(() => expect(a.told).toHaveLength(1), { timeout: HUNG_MS })
    expect(a.told[0]).toContain('WindowsSandboxServer')
    const tried = a.resumes
    a.change()
    await vi.waitFor(() => expect(a.resumes).toBeGreaterThan(tried), { timeout: HUNG_MS })
    // What holds it changed (fewer processes): logged, the user not told again.
    a.held = "slot-a is held by node, left running by MB1's last run"
    a.change()
    await vi.waitFor(() => expect(a.log.at(-1)).toContain('held by node'), { timeout: HUNG_MS })
    expect(a.told).toHaveLength(1)
    a.held = null
    a.change()
    expect(await op.done).toBe('resumed')
    const resumed = a.resumes
    a.change()
    expect(a.resumes).toBe(resumed)
  })

  it('a failure that is no wait still ends it, as before', async () => {
    const { a, op } = agent()
    a.held = null
    a.fail = new Error('its workspace closed')
    a.running = false
    a.change()
    expect(await op.done).toBe('failed')
    expect(a.told).toEqual([])
  })

  it('cancelled while it waits: nothing more is resumed', async () => {
    const { a, op } = agent()
    a.running = false
    a.change()
    await vi.waitFor(() => expect(a.told).toHaveLength(1), { timeout: HUNG_MS })
    op.cancel('the user started it')
    expect(await op.done).toBe('cancelled')
    const tried = a.resumes
    a.held = null
    a.change()
    expect(a.resumes).toBe(tried)
  })

  it('gives up after its bound, held all along', async () => {
    vi.useFakeTimers()
    const { a, op } = agent(60_000)
    a.running = false
    a.change()
    await vi.waitFor(() => expect(a.told).toHaveLength(1), { timeout: HUNG_MS })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await op.done).toBe('failed')
    expect(a.log.at(-1)).toContain('waited')
  })
})
