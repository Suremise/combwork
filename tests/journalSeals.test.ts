// Sealed journals retired (HI-1723: an empty `<lease>.followed` folder per slot or copy job piled up in .slot-journals,
// never removed): a seal goes once its lease's job is gone, so nothing can write the journal again, and stays while any
// supervisor still holds the job (this Hive's, or one that outlived its Hive), while the journal holds a settle's
// evidence, or while that can't be told (fail-closed). With Hive's real process supervisor (Windows), as
// queueRunner.test does, and with `gone` simulated for the rest.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
import { clearJournal, journalPath, LeaseJob, leaseJobGone, queueHost, retireSeal, sealJournal, sweepSeals } from '../src/main/workflow/queueJobs'

const ends: (() => void)[] = []
afterAll(() => {
  for (const end of ends) end()
})

/** A project's worktrees folder with its journals folder, as slotsApp's journalsOf makes it. */
function folders(): { root: string; dir: string } {
  const root = tempDir('journal-seals-')
  return { root, dir: join(root, '.slot-journals') }
}

/** A settled lease's journal: sealed, then cleared, as settleSlotJob leaves it (the seal alone). */
async function settled(root: string, dir: string, lease: string): Promise<string> {
  await journalPath(root, lease, dir)
  expect(await sealJournal(root, lease, dir)).toBe(true)
  await clearJournal(root, lease, dir)
  return join(dir, `${lease}.followed`)
}

describe.runIf(process.platform === 'win32')("a seal goes once its job is gone (the real supervisor)", () => {
  it('stays while this Hive still holds the job, and goes once it lets it go', async () => {
    const { root, dir } = folders()
    const host = queueHost()
    const lease = `copy-seal-${Date.now()}`
    const job = await LeaseJob.open(host, lease, await journalPath(root, lease, dir))
    expect(job).toBeInstanceOf(LeaseJob)
    const seal = await settled(root, dir, lease)
    const gone = (l: string) => leaseJobGone(host, l)
    // Held (ended and empty, but its handle still open here): a writer could exist, so the seal stays.
    expect(await retireSeal(root, lease, dir, gone)).toBe(false)
    expect(existsSync(seal)).toBe(true)
    await (job as LeaseJob).close()
    expect(await retireSeal(root, lease, dir, gone)).toBe(true)
    expect(existsSync(seal)).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  it('stays while a supervisor that outlived its Hive holds the job; a sweep removes it once that one is gone', async () => {
    const { root, dir } = folders()
    const host = queueHost()
    // Another Hive's supervisor, outliving it (queueJobs.ts' RELAY): it holds the job, which this Hive can't close.
    const other = queueHost({ linger: true })
    const lease = `slot-seal-${Date.now()}`
    expect(await LeaseJob.open(other, lease, await journalPath(root, lease, dir))).toBeInstanceOf(LeaseJob)
    const relay = other.pid!
    ends.push(() => {
      try {
        process.kill(relay)
      } catch {
        // gone
      }
    })
    const seal = await settled(root, dir, lease)
    const gone = (l: string) => leaseJobGone(host, l)
    expect(await sweepSeals(root, dir, gone)).toBe(0)
    expect(existsSync(seal)).toBe(true)
    // That supervisor ends (its relay gone, its input closes): the job closes with it, and the next sweep takes the seal.
    process.kill(relay)
    await vi.waitFor(async () => expect(await sweepSeals(root, dir, gone)).toBe(1), { timeout: 30_000, interval: 250 })
    expect(existsSync(seal)).toBe(false)
  })
})

describe('what a seal needs before it goes', () => {
  const yes = async (): Promise<boolean> => true

  it("stays while the journal still holds a settle's evidence (a moved-aside part), however gone its job is", async () => {
    const { root, dir } = folders()
    const main = await journalPath(root, 'slot-a', dir)
    writeFileSync(main, '')
    expect(await sealJournal(root, 'slot-a', dir)).toBe(true)
    expect(readdirSync(dir).some((n) => n.startsWith('slot-a.sealed-'))).toBe(true)
    expect(await retireSeal(root, 'slot-a', dir, yes)).toBe(false)
    expect(existsSync(main)).toBe(true)
    // Cleared (what it named ended): now it goes.
    await clearJournal(root, 'slot-a', dir)
    expect(await retireSeal(root, 'slot-a', dir, yes)).toBe(true)
    expect(existsSync(main)).toBe(false)
  })

  it("stays when its job can't be told gone: held, the question failing, or no supervisor to ask", async () => {
    const { root, dir } = folders()
    const seal = await settled(root, dir, 'copy-b')
    expect(await retireSeal(root, 'copy-b', dir, async () => false)).toBe(false)
    expect(await retireSeal(root, 'copy-b', dir, async () => Promise.reject(new Error('no answer')))).toBe(false)
    expect(existsSync(seal)).toBe(true)
  })

  it("leaves what isn't a seal as sealJournal makes it: a journal still a file, a folder with something in it, an absent one", async () => {
    const { root, dir } = folders()
    const asked: string[] = []
    const gone = async (l: string): Promise<boolean> => (asked.push(l), true)
    const file = await journalPath(root, 'slot-live', dir)
    writeFileSync(file, '')
    mkdirSync(join(dir, 'slot-odd.followed'))
    writeFileSync(join(dir, 'slot-odd.followed', 'x'), 'x')
    expect(await retireSeal(root, 'slot-live', dir, gone)).toBe(false)
    expect(await retireSeal(root, 'slot-odd', dir, gone)).toBe(false)
    expect(await retireSeal(root, 'slot-none', dir, gone)).toBe(false)
    // A live lease's journal (a file) never has its job asked about.
    expect(asked).toEqual(['slot-odd'])
    expect(existsSync(file)).toBe(true)
    expect(existsSync(join(dir, 'slot-odd.followed', 'x'))).toBe(true)
  })

  it('a sweep removes the seals whose jobs are gone, one after another, and keeps the rest', async () => {
    const { root, dir } = folders()
    for (const lease of ['copy-1', 'copy-2', 'copy-c-3', 'slot-4']) await settled(root, dir, lease)
    writeFileSync(await journalPath(root, 'slot-5', dir), '')
    writeFileSync(join(dir, 'notes.txt'), 'x')
    let asking = 0
    let most = 0
    const gone = async (l: string): Promise<boolean> => {
      most = Math.max(most, ++asking)
      await new Promise((r) => setImmediate(r))
      asking--
      return l !== 'copy-2'
    }
    expect(await sweepSeals(root, dir, gone)).toBe(3)
    expect(most).toBe(1)
    expect(readdirSync(dir).sort()).toEqual(['copy-2.followed', 'notes.txt', 'slot-5.followed'])
  })

  it('a missing journals folder sweeps nothing', async () => {
    const { root, dir } = folders()
    expect(await sweepSeals(root, dir, yes)).toBe(0)
  })
})
