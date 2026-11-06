// Settling a slot command's job (#1429, HR1's round 2; src/main/slotJobs.ts): #1360's protocol on a real journal folder
// and parser, with the supervisor and the processes simulated (no process is started or ended): the job ended first,
// the journal sealed before its one read (a write after it can't land), what it names ended as trees and seen gone,
// and only then cleared; anything that fails keeps the evidence for the next try.
import { appendFileSync, existsSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
import { settleSlotJob } from '../src/main/slotJobs'
import { fileTimeMs, journalPath } from '../src/main/workflow/queueJobs'
import type { Listed, ProcessProbe } from '../src/main/workflow/queueProcs'

/** A journal record as the supervisor writes it: pid, FILETIME start, check. */
const FILETIME_1970 = 116444736000000000n
function record(pid: number, startedMs: number): string {
  const created = BigInt(startedMs) * 10000n + FILETIME_1970
  return `${pid}:${created}:${(BigInt(pid) + created) % 1000003n}\n`
}
const T = Date.now() - 60_000
const started = (ms: number): number => fileTimeMs(String(BigInt(ms) * 10000n + FILETIME_1970))

/** Processes that run until ended (`stubborn`: never), and the ones each `end` was asked to end. */
function processes(list: Listed[], o: { stubborn?: number[] } = {}): ProcessProbe & { ended: number[][]; running: Listed[] } {
  const running = [...list]
  const ended: number[][] = []
  return {
    running,
    ended,
    self: async () => ({ pid: 1, started: 1 }),
    alive: async (pid, s) => running.some((p) => p.pid === pid && p.started === s),
    list: async () => [...running],
    end: async (targets) => {
      ended.push(targets.map((t) => t.pid))
      const gone = targets.filter((t) => !o.stubborn?.includes(t.pid)).map((t) => t.pid)
      for (const pid of gone) running.splice(running.findIndex((p) => p.pid === pid), 1)
      return gone
    }
  }
}

async function journal(): Promise<{ root: string; dir: string; main: string }> {
  const root = tempDir('slot-jobs-')
  const dir = join(root, '.slot-journals')
  return { root, dir, main: await journalPath(root, 'slot-j1', dir) }
}

describe('settling a slot command job (#1429)', () => {
  it('ends what the journal names, with what it started; a write after the seal never lands', async () => {
    const j = await journal()
    writeFileSync(j.main, record(123, T))
    const p = processes([
      { pid: 123, parent: 1, started: started(T) },
      { pid: 124, parent: 123, started: started(T) + 5 },
      { pid: 9, parent: 1, started: 1 }
    ])
    let late: unknown = null
    const ok = await settleSlotJob(
      {
        endJob: async () => true,
        probe: p,
        root: j.root,
        dir: j.dir,
        // A supervisor that outlived its Combwork tries to write down another process after the seal: it can't (it ends it).
        afterSeal: () => {
          try {
            appendFileSync(j.main, record(456, T))
          } catch (e) {
            late = e
          }
        }
      },
      'slot-j1'
    )
    expect(ok).toBe(true)
    expect(late).not.toBeNull()
    expect(p.ended).toEqual([[124, 123]])
    expect(p.running.map((x) => x.pid)).toEqual([9])
    // Cleared but sealed: what is left is the seal, a folder.
    expect(readdirSync(j.dir)).toEqual(['slot-j1.followed'])
  })

  it('a record written between the job ending and the seal is read and ended too', async () => {
    const j = await journal()
    writeFileSync(j.main, record(123, T))
    const p = processes([
      { pid: 123, parent: 1, started: started(T) },
      { pid: 456, parent: 1, started: started(T) }
    ])
    const ok = await settleSlotJob({ endJob: async () => (appendFileSync(j.main, record(456, T)), true), probe: p, root: j.root, dir: j.dir }, 'slot-j1')
    expect(ok).toBe(true)
    expect(p.ended.flat().sort()).toEqual([123, 456])
  })

  it('a process that will not end keeps the evidence, and the next try finishes once it is gone', async () => {
    const j = await journal()
    writeFileSync(j.main, record(123, T))
    const p = processes([{ pid: 123, parent: 1, started: started(T) }], { stubborn: [123] })
    // Its wait for them to go, bounded short: the stubborn one never does.
    const o = { endJob: async () => true, probe: p, root: j.root, dir: j.dir, waitMs: 300 }
    expect(await settleSlotJob(o, 'slot-j1')).toBe(false)
    expect(readdirSync(j.dir).some((n) => n.startsWith('slot-j1.sealed-'))).toBe(true)
    // A crash here, then a later settle: the seal already there, the moved-aside record still read.
    p.running.splice(0)
    expect(await settleSlotJob(o, 'slot-j1')).toBe(true)
    expect(readdirSync(j.dir)).toEqual(['slot-j1.followed'])
  })

  it("refuses while the job can't be ended, the journal is damaged, or the processes can't be listed", async () => {
    const j = await journal()
    writeFileSync(j.main, record(123, T))
    const p = processes([{ pid: 123, parent: 1, started: started(T) }])
    expect(await settleSlotJob({ endJob: async () => false, probe: p, root: j.root, dir: j.dir }, 'slot-j1')).toBe(false)
    expect(existsSync(j.main) && !readdirSync(j.dir).some((n) => n.includes('sealed'))).toBe(true)
    appendFileSync(j.main, '123:cut')
    expect(await settleSlotJob({ endJob: async () => true, probe: p, root: j.root, dir: j.dir }, 'slot-j1')).toBe(false)
    expect(p.ended).toEqual([])
    const j2 = await journal()
    writeFileSync(j2.main, record(123, T))
    expect(await settleSlotJob({ endJob: async () => true, probe: { ...p, list: async () => null }, root: j2.root, dir: j2.dir }, 'slot-j1')).toBe(false)
  })

  it('a job whose journal was never written settles at once', async () => {
    const root = tempDir('slot-jobs-')
    expect(await settleSlotJob({ endJob: async () => true, probe: processes([]), root, dir: join(root, '.slot-journals') }, 'slot-none')).toBe(true)
  })
})
