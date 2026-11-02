// Sealed journals retired (HI-1723: an empty `<lease>.followed` folder per slot or copy job piled up in .slot-journals,
// never removed): a seal goes once its lease's job is gone, so nothing can write the journal again, and stays while any
// supervisor still holds the job (this Hive's, or one that outlived its Hive), while the journal holds a settle's
// evidence, or while that can't be told (fail-closed). With Hive's real process supervisor (Windows), as
// queueRunner.test does, and with `gone` simulated for the rest.
import { spawn } from 'child_process'
import { createRequire } from 'module'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
import { junction } from './pathAliases'
import { clearJournal, journalPath, LeaseJob, leaseJobGone, queueHost, retireSeal, sealJournal, sweepSeals } from '../src/main/workflow/queueJobs'
import type { JobHost } from '../src/main/processSupervisor'

const req = createRequire(import.meta.url)
const { baseEnv } = req('./e2e/runContext.cjs') as { baseEnv: () => NodeJS.ProcessEnv }
// Processes ended by identity, never by a remembered pid (#603): taken while they are known to be the test's own.
const { identify, endExactly } = req('./e2e/folderProcesses.cjs') as {
  identify: (pids: number[]) => { pid: number; started: number }[]
  endExactly: (targets: { pid: number; started: number }[]) => number
}

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
  it('stays, and so does the process running in its job, while this Hive holds the job; goes once it lets it go', async () => {
    const { root, dir } = folders()
    const host = queueHost()
    const lease = `copy-seal-${Date.now()}`
    const job = (await LeaseJob.open(host, lease, await journalPath(root, lease, dir))) as LeaseJob
    expect(job).toBeInstanceOf(LeaseJob)
    // A process in the job, running (HR4's design review: a sweep must never end what a held job runs).
    const after = Date.now() - 1
    const k = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true, windowsHide: true, env: baseEnv() })
    k.unref()
    const pid = k.pid!
    // Ended through its handle, which the test holds.
    ends.push(() => void k.kill())
    expect(await job.assign(pid, after, Date.now() + 1)).toBe(true)
    const runs = (): boolean => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    const seal = await settled(root, dir, lease)
    const gone = (l: string) => leaseJobGone(host, l)
    // Held (its handle still open here): a writer could exist, so the seal stays, and nothing in the job is touched.
    expect(await retireSeal(root, lease, dir, gone)).toBe(false)
    expect(await sweepSeals(root, dir, gone)).toBe(0)
    expect(existsSync(seal)).toBe(true)
    expect(runs()).toBe(true)
    // Let go: kill on close ends what it ran, and the seal goes.
    await job.close()
    await vi.waitFor(() => expect(runs()).toBe(false), { timeout: 30_000, interval: 100 })
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
    // That supervisor by its identity, taken now while it is known to be the test's own.
    // Its cleanup is registered before anything can fail, so a failing check never leaves it behind (endExactly is
    // synchronous: done when the cleanup returns).
    const relay = identify([other.pid!])
    ends.push(() => void endExactly(relay))
    expect(relay).toHaveLength(1)
    const seal = await settled(root, dir, lease)
    const gone = (l: string) => leaseJobGone(host, l)
    expect(await sweepSeals(root, dir, gone)).toBe(0)
    expect(existsSync(seal)).toBe(true)
    // That supervisor ends (its relay gone, its input closes): the job closes with it, and the next sweep takes the seal.
    expect(endExactly(relay)).toBe(1)
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
    // None of them has its job asked about: a live lease's journal (a file) least of all.
    expect(asked).toEqual([])
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

  it('never follows a link: a journals folder that is a junction, or a seal that is one, stays as it is', async () => {
    const { root, dir } = folders()
    const elsewhere = tempDir('journal-seals-elsewhere-')
    mkdirSync(join(elsewhere, 'slot-x.followed'))
    junction(elsewhere, dir)
    expect(await sweepSeals(root, dir, yes)).toBe(0)
    expect(await retireSeal(root, 'slot-x', dir, yes)).toBe(false)
    expect(existsSync(join(elsewhere, 'slot-x.followed'))).toBe(true)
    const other = folders()
    mkdirSync(other.dir)
    const target = tempDir('journal-seals-target-')
    junction(target, join(other.dir, 'slot-y.followed'))
    expect(await retireSeal(other.root, 'slot-y', other.dir, yes)).toBe(false)
    expect(existsSync(target)).toBe(true)
  })

  it('looks again once its job is known gone: a part or a file arriving meanwhile keeps it', async () => {
    const { root, dir } = folders()
    const seal = await settled(root, dir, 'slot-p')
    expect(await retireSeal(root, 'slot-p', dir, async () => (writeFileSync(join(dir, 'slot-p.sealed-1-0'), ''), true))).toBe(false)
    expect(existsSync(seal)).toBe(true)
    const seal2 = await settled(root, dir, 'slot-q')
    expect(await retireSeal(root, 'slot-q', dir, async () => (writeFileSync(join(seal2, 'late'), 'x'), true))).toBe(false)
    expect(existsSync(join(seal2, 'late'))).toBe(true)
  })

  it("a job is gone only on the supervisor's \"nojob\": exists, unknown, no answer or a failure all keep the seal", async () => {
    const host = (answer: unknown) => ({ request: async () => (answer instanceof Error ? Promise.reject(answer) : answer) }) as unknown as JobHost
    expect(await leaseJobGone(host('nojob'), 'slot-a')).toBe(true)
    for (const answer of ['exists', 'unknown: 5', 'unknown: 6', null, 'ended', new Error('no supervisor')]) {
      const { root, dir } = folders()
      const seal = await settled(root, dir, 'slot-a')
      expect(await retireSeal(root, 'slot-a', dir, (l) => leaseJobGone(host(answer), l))).toBe(false)
      expect(existsSync(seal)).toBe(true)
    }
  })

  it('a missing journals folder sweeps nothing', async () => {
    const { root, dir } = folders()
    expect(await sweepSeals(root, dir, yes)).toBe(0)
  })
})
