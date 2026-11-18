// HI-3374, row 3: a quiet check's rename aside is claimed in the board's database before it renames and let go once the
// folder is back; a claim left behind is recovered by that claim at the next look, never by a folder's name. Two
// connections to one database file stand for two Combworks (each its own owner identity); real folders and renames.
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'

const { fileSlotConn, folderThere, quiet, quietDeps, quietNeeds, QUIET_BACK } = await import('../src/main/slots')
const { claimDeps, claimOf, recoverClaim, takeClaim } = await import('../src/main/quietClaims')
type Target = Parameters<typeof claimOf>[0]
type Owner = ReturnType<typeof claimDeps.self>

const real = { ...claimDeps }
afterEach(() => Object.assign(claimDeps, real))

let n = 0
/** A board database with copy `c1` of project `p` (its folder made), and two connections to it: two processes. */
function setup() {
  const dir = tempDir(`cw-quiet-claims-${++n}-`)
  const file = join(dir, 'combwork.db')
  const folder = join(dir, 'copies', 'c1')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'a.txt'), 'a')
  const one = fileSlotConn(file)
  const two = fileSlotConn(file)
  void one.write((db) => db.prepare("INSERT INTO copies (project, name, folder, state, created_at, used_at, op, op_kind, op_pid, op_started) VALUES ('p', 'c1', ?, 'free', 't0', 't0', NULL, NULL, NULL, NULL)").run(folder))
  const target = (conn: typeof one): Target => ({ conn, project: 'p', kind: 'copy', name: 'c1' })
  return { dir, folder, one, two, a: target(one), b: target(two), close: () => (one.close(), two.close()) }
}

/** Runs `fn` as the process `who` (its identity), with the liveness of others as `alive` says. */
async function as<T>(who: Owner, alive: Record<number, 'alive' | 'dead' | 'unknown'>, fn: () => Promise<T>): Promise<T> {
  claimDeps.self = () => who
  claimDeps.alive = async (o) => alive[o.pid] ?? 'dead'
  return fn()
}
const P1 = { pid: 111, started: 1_000_000 }
const P2 = { pid: 222, started: 2_000_000 }
const asides = (s: ReturnType<typeof setup>) => readdirSync(join(s.dir, 'copies')).filter((x) => x.includes('.cw-quiet-'))

describe('the quiet check claims its rename aside (HI-3374)', () => {
  it('a check claims, renames aside and back, and lets go: nothing left', async () => {
    const s = setup()
    try {
      expect(await as(P1, {}, () => quiet(s.folder, s.a))).toBe(true)
      expect(claimOf(s.a)).toBeNull()
      expect(asides(s)).toEqual([])
      expect(existsSync(join(s.folder, 'a.txt'))).toBe(true)
    } finally {
      s.close()
    }
  })

  it('two processes claiming at once: one claims, the other is held; nothing renamed twice', async () => {
    const s = setup()
    try {
      const c1 = await as(P1, {}, () => takeClaim(s.a, s.folder, `${s.folder}.cw-quiet-aaaaaa`))
      const c2 = await as(P2, { [P1.pid]: 'alive' }, () => takeClaim(s.b, s.folder, `${s.folder}.cw-quiet-bbbbbb`))
      expect(c1).not.toBeNull()
      expect(c2).toBeNull()
      // While P1's claim stands (P1 alive), P2's check is held and renames nothing.
      expect(await as(P2, { [P1.pid]: 'alive' }, () => quiet(s.folder, s.b))).toBe(false)
      expect(asides(s)).toEqual([])
      expect(existsSync(s.folder)).toBe(true)
    } finally {
      s.close()
    }
  })

  it('a crash after the rename: the next look (another process, the owner gone) puts it back by its claim', async () => {
    const s = setup()
    try {
      const aside = `${s.folder}.cw-quiet-cccccc`
      const c = await as(P1, {}, () => takeClaim(s.a, s.folder, aside))
      renameSync(s.folder, aside)
      expect(c).not.toBeNull()
      // P1 crashed. P2 looks: the copy is there (never marked gone) while its claim stands, then put back.
      expect(await as(P2, { [P1.pid]: 'dead' }, () => folderThere(s.folder, s.b))).toBe(true)
      expect(existsSync(join(s.folder, 'a.txt'))).toBe(true)
      expect(existsSync(aside)).toBe(false)
      expect(claimOf(s.b)).toBeNull()
    } finally {
      s.close()
    }
  })

  it('a crash before the rename, or after the put-back: the claim is let go once the folder is the one claimed', async () => {
    const s = setup()
    try {
      await as(P1, {}, () => takeClaim(s.a, s.folder, `${s.folder}.cw-quiet-dddddd`))
      expect(await as(P2, { [P1.pid]: 'dead' }, () => folderThere(s.folder, s.b))).toBe(true)
      expect(claimOf(s.b)).toBeNull()
      expect(existsSync(join(s.folder, 'a.txt'))).toBe(true)
    } finally {
      s.close()
    }
  })

  it("this process's own claim, its check over (a put-back that kept failing): the next look puts it back", async () => {
    const s = setup()
    try {
      const aside = `${s.folder}.cw-quiet-eeeeee`
      await as(P1, {}, () => takeClaim(s.a, s.folder, aside))
      renameSync(s.folder, aside)
      expect(await as(P1, {}, () => folderThere(s.folder, s.a))).toBe(true)
      expect(existsSync(aside)).toBe(false)
      expect(claimOf(s.a)).toBeNull()
    } finally {
      s.close()
    }
  })

  it("an owner alive (another Combwork's live check), or one whose liveness can't be told: held, nothing touched", async () => {
    const s = setup()
    try {
      const aside = `${s.folder}.cw-quiet-ffffff`
      const c = await as(P1, {}, () => takeClaim(s.a, s.folder, aside))
      renameSync(s.folder, aside)
      for (const state of ['alive', 'unknown'] as const) {
        expect(await as(P2, { [P1.pid]: state }, () => recoverClaim(s.b, c!))).toEqual({ state: 'held' })
        expect(existsSync(aside)).toBe(true)
        expect(claimOf(s.b)?.owner.pid).toBe(P1.pid)
      }
    } finally {
      s.close()
    }
  })

  it("two processes recovering one dead owner's claim at once: one takes it over, the other is held", async () => {
    const s = setup()
    try {
      const aside = `${s.folder}.cw-quiet-gggggg`
      const c = await as(P1, {}, () => takeClaim(s.a, s.folder, aside))
      renameSync(s.folder, aside)
      // P2 takes it over first (in one write); P3's recovery of the same claim then finds it isn't P1's any more.
      const r2 = await as(P2, { [P1.pid]: 'dead' }, () => recoverClaim(s.b, c!))
      const r3 = await as({ pid: 333, started: 3_000_000 }, { [P1.pid]: 'dead', [P2.pid]: 'alive' }, () => recoverClaim(s.a, c!))
      expect(r2).toEqual({ state: 'released' })
      expect(r3).toEqual({ state: 'held' })
      expect(existsSync(join(s.folder, 'a.txt'))).toBe(true)
    } finally {
      s.close()
    }
  })

  it("the pool's hold changed since (another operation took the copy): needs you, nothing renamed", async () => {
    const s = setup()
    try {
      const aside = `${s.folder}.cw-quiet-hhhhhh`
      const c = await as(P1, {}, () => takeClaim(s.a, s.folder, aside))
      renameSync(s.folder, aside)
      await s.one.write((db) => db.prepare("UPDATE copies SET op = 'other', op_kind = 'lease', op_pid = 1, op_started = 1, used_at = 't1' WHERE project = 'p' AND name = 'c1'").run())
      const r = await as(P2, { [P1.pid]: 'dead' }, () => recoverClaim(s.b, c!))
      expect(r.state).toBe('needs')
      expect(existsSync(aside)).toBe(true)
      expect(existsSync(s.folder)).toBe(false)
    } finally {
      s.close()
    }
  })

  it('its place taken meanwhile (a folder there that is not the one claimed), or both there: needs you, nothing touched; said for the copy', async () => {
    const s = setup()
    try {
      const aside = `${s.folder}.cw-quiet-iiiiii`
      await as(P1, {}, () => takeClaim(s.a, s.folder, aside))
      renameSync(s.folder, aside)
      mkdirSync(s.folder)
      expect(await as(P2, { [P1.pid]: 'dead' }, () => folderThere(s.folder, s.b))).toBe(true)
      expect(existsSync(aside)).toBe(true)
      expect(quietNeeds(s.folder)?.aside).toBe(aside)
      // Still held, never lent, while it needs the user.
      expect(await as(P2, { [P1.pid]: 'dead' }, () => quiet(s.folder, s.b))).toBe(false)
      expect(existsSync(aside)).toBe(true)
    } finally {
      s.close()
    }
  })

  it('an aside without a claim (from before HI-3374) is never put back by its name', async () => {
    const s = setup()
    try {
      const aside = `${s.folder}.cw-quiet-jjjjjj`
      renameSync(s.folder, aside)
      expect(await as(P2, {}, () => folderThere(s.folder, s.b))).toBe(false)
      expect(existsSync(aside)).toBe(true)
    } finally {
      s.close()
    }
  })
})

describe('putting a folder back is retried for at least a minute (HI-3374)', () => {
  it('a put-back refused for 5 s, then let through: the check succeeds and lets go of its claim', async () => {
    const s = setup()
    try {
      expect(QUIET_BACK.boundMs).toBeGreaterThanOrEqual(60_000)
      let refusedUntil = 0
      const rename = quietDeps.rename
      // The put-back (aside → folder) is refused until 5 s after the rename aside; the renames themselves are real.
      quietDeps.rename = async (a, b) => {
        if (a.includes('.cw-quiet-') && Date.now() < refusedUntil) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
        if (b.includes('.cw-quiet-')) refusedUntil = Date.now() + 5000
        return rename(a, b)
      }
      try {
        const started = Date.now()
        expect(await as(P1, {}, () => quiet(s.folder, s.a))).toBe(true)
        expect(Date.now() - started).toBeGreaterThanOrEqual(5000)
        expect(claimOf(s.a)).toBeNull()
        expect(existsSync(join(s.folder, 'a.txt'))).toBe(true)
      } finally {
        quietDeps.rename = rename
      }
    } finally {
      s.close()
    }
  }, 30_000)
})
