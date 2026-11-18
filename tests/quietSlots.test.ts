// HI-3374 (HR3's round 1): the slot pool's own checks go through the quiet claims too. A real SlotPool on a real
// SlotStore (a board database file): its guard (what a removal checks: is the folder there, is it quiet) recovers a
// slot folder a crashed check left aside by its claim, and holds one left aside with no claim (never read as gone).
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'

const { fileSlotConn, SlotPool, SlotStore, quietNeeds } = await import('../src/main/slots')
const { claimDeps, claimOf, takeClaim } = await import('../src/main/quietClaims')

const real = { ...claimDeps }
afterEach(() => Object.assign(claimDeps, real))

let n = 0
async function world() {
  const dir = tempDir(`cw-quiet-slots-${++n}-`)
  const root = join(dir, 'slots')
  const folder = join(root, 'slot-a')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'a.txt'), 'a')
  const conn = fileSlotConn(join(dir, 'combwork.db'))
  await conn.write((db) => db.prepare("INSERT INTO slots (project, name, folder, state, port_base, target, created_at, used_at) VALUES ('p', 'slot-a', ?, 'ready', 41000, 'main', 't0', 't0')").run(folder))
  const store = new SlotStore(conn, 'p')
  const holder = { self: async () => ({ pid: 1, started: 1001 }), alive: async () => true, live: new Set<string>() }
  const pool = new SlotPool({ store, project: join(dir, 'proj'), root, options: async () => ({ setup: '', archive: '', copy: '' }), builders: () => 1, cap: () => 4, runner: async () => ({ ok: true, exitCode: 0, logPath: null, settled: true }), settle: async () => true, holder, sessionIn: () => null } as unknown as ConstructorParameters<typeof SlotPool>[0])
  /** The pool's removal guard, the processes' part (forgotten: no dirty check), on slot-a as the store has it. */
  const guard = () => (pool as unknown as { guard: (s: unknown, probe: boolean, token?: string, forgotten?: boolean) => Promise<{ why: string } | null> }).guard(store.slot('slot-a'), true, undefined, true)
  const target = { conn, project: 'p', kind: 'slot' as const, name: 'slot-a' }
  return { folder, conn, pool, guard, target, close: async () => (await pool.close(), conn.close()) }
}

describe("the slot pool's checks claim and recover (HI-3374, HR3's round 1)", () => {
  it('its own check claims the rename aside and lets go: nothing left', async () => {
    const w = await world()
    try {
      expect(await w.guard()).toBeNull()
      expect(claimOf(w.target)).toBeNull()
      expect(existsSync(join(w.folder, 'a.txt'))).toBe(true)
    } finally {
      await w.close()
    }
  })

  it("a slot folder a crashed Combwork's check left aside: the pool's next look puts it back by its claim, and the slot is quiet", async () => {
    const w = await world()
    try {
      claimDeps.self = () => ({ pid: 111, started: 1_000_000 })
      const aside = `${w.folder}.cw-quiet-aaaaaa`
      await takeClaim(w.target, w.folder, aside)
      renameSync(w.folder, aside)
      // The next Combwork (another process), the first one gone.
      claimDeps.self = () => ({ pid: 222, started: 2_000_000 })
      claimDeps.alive = async () => 'dead'
      expect(await w.guard()).toBeNull()
      expect(existsSync(join(w.folder, 'a.txt'))).toBe(true)
      expect(existsSync(aside)).toBe(false)
      expect(claimOf(w.target)).toBeNull()
    } finally {
      await w.close()
    }
  })

  it('a slot folder left aside with no claim: held (a process holds it, so it is never removed or made again), the aside untouched, said', async () => {
    const w = await world()
    try {
      const aside = `${w.folder}.cw-quiet-bbbbbb`
      renameSync(w.folder, aside)
      expect(await w.guard()).toEqual({ why: 'process' })
      expect(existsSync(aside)).toBe(true)
      expect(existsSync(w.folder)).toBe(false)
      expect(quietNeeds(w.folder)?.aside).toBe(aside)
    } finally {
      await w.close()
    }
  })
})
