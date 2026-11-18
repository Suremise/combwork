// HI-3358: a process the tree starts after endTreeAsync's listing and before its end is ended too: the processes are
// listed again after each end, and what an ended process started since (its parent that process by identity, pid and
// start time) is ended, at most LATE_ROUNDS times. Mock-only, as processTreeRootReuse.test.ts: node:child_process's
// spawn is replaced, each listing is the next of `probe.listings`, and the PowerShell each run would get is recorded,
// never run.
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const probe = vi.hoisted(() => ({ commands: [] as string[], listings: [] as string[], lists: 0 }))
vi.mock('node:child_process', async (original) => {
  const real = await original<typeof import('node:child_process')>()
  return {
    ...real,
    spawn: (_exe: string, args: string[]) => {
      const cmd = args.at(-1)!
      probe.commands.push(cmd)
      const c = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: () => void }
      c.stdout = new EventEmitter()
      c.kill = () => undefined
      const listing = cmd.includes('Get-CimInstance')
      // Each listing is the next one given; past the last, the last again.
      const out = listing ? (probe.listings[Math.min(probe.lists++, probe.listings.length - 1)] ?? '') : [...cmd.matchAll(/(\d+):\d+/g)].map((m) => m[1]).join('\n')
      queueMicrotask(() => {
        c.stdout.emit('data', Buffer.from(out))
        c.emit('close', 0)
      })
      return c
    }
  }
})

const { endTreeAsync, lateStarted, LATE_ROUNDS, treeEnding } = await import('../src/main/processTree')

/** What each ending run was given, in order (`pid:started` each). */
const ends = (): string[][] => probe.commands.filter((c) => c.includes('GetProcessById')).map((c) => /'([^']*)'\.Split/.exec(c)![1].split(','))
const fakeChild = (pid: number) => ({ pid, exitCode: null as number | null, signalCode: null as string | null, kill: vi.fn() })
const lines = (...l: string[]): string => l.join('\n')

beforeEach(() => {
  probe.commands.length = 0
  probe.listings = []
  probe.lists = 0
})

describe('endTreeAsync: what the tree started after its listing (HI-3358)', () => {
  it("the card's reproduction: a child its shell starts between the listing and the end is ended in a second round", async () => {
    // 4141 git, 4200 its filter's shell. 4300: the shell's late node, started after the first listing.
    probe.listings = [lines('4141 0 1000', '4200 4141 1100'), lines('4300 4200 1500', '4400 4300 1600')]
    const root = fakeChild(4141)
    await endTreeAsync(root as unknown as ChildProcess, 'win32')
    expect(ends()).toEqual([['4200:1100', '4141:1000'], ['4400:1600', '4300:1500']])
    expect(root.kill).not.toHaveBeenCalled()
  })

  it('nothing started late: one more listing, no second end', async () => {
    probe.listings = [lines('4141 0 1000', '4200 4141 1100'), lines('9999 1 500')]
    await endTreeAsync(fakeChild(4141) as unknown as ChildProcess, 'win32')
    expect(ends()).toEqual([['4200:1100', '4141:1000']])
    expect(probe.lists).toBe(2)
  })

  it('a late child of a late child (each started before its parent was ended) is ended in the next round', async () => {
    probe.listings = [lines('4141 0 1000'), lines('4300 4141 1500'), lines('4500 4300 1700'), lines('9999 1 500')]
    await endTreeAsync(fakeChild(4141) as unknown as ChildProcess, 'win32')
    expect(ends()).toEqual([['4141:1000'], ['4300:1500'], ['4500:1700']])
  })

  it('still finding late children after LATE_ROUNDS rounds: stops and says so', async () => {
    const rounds = [lines('4141 0 1000')]
    for (let r = 1; r <= LATE_ROUNDS + 1; r++) rounds.push(lines(`${5000 + r} ${r === 1 ? 4141 : 5000 + r - 1} ${1000 + r * 100}`))
    probe.listings = rounds
    const spent = vi.fn()
    await endTreeAsync(fakeChild(4141) as unknown as ChildProcess, 'win32', undefined, { onLateLeft: spent })
    expect(ends()).toHaveLength(1 + LATE_ROUNDS)
    expect(spent).toHaveBeenCalledTimes(1)
    expect(probe.lists).toBe(LATE_ROUNDS + 2)
  })

  it('the outcome given after an end comes after the late rounds (treeEnding.after)', async () => {
    probe.listings = [lines('4141 0 1000'), lines('4300 4141 1500'), lines('9999 1 500')]
    const ending = treeEnding('win32')
    const seen: number[] = []
    ending.end(fakeChild(4141) as unknown as ChildProcess)
    await new Promise<void>((res) =>
      ending.after(() => {
        seen.push(ends().length)
        res()
      })
    )
    expect(seen).toEqual([2])
  })
})

describe('lateStarted: identities, never parent numbers alone (HI-3358)', () => {
  const ended = [{ pid: 4200, parent: 4141, started: 1100 }]
  const now = 10_000

  it("a process whose parent id names an ended process and that started after it is that process's", () => {
    expect(lateStarted([{ pid: 4300, parent: 4200, started: 1500 }], ended, ended, now)).toEqual([{ pid: 4300, parent: 4200, started: 1500 }])
  })

  it('one that started before the ended process (an older orphan under a reused number) is not', () => {
    expect(lateStarted([{ pid: 4300, parent: 4200, started: 900 }], ended, ended, now)).toEqual([])
  })

  it('one that started after the end had run (it cannot be a child of what was ended) is not', () => {
    expect(lateStarted([{ pid: 4300, parent: 4200, started: now + 1 }], ended, ended, now)).toEqual([])
  })

  it("the ended process's pid now another's, started before the child: the child may be that one's, so is left", () => {
    const list = [
      { pid: 4200, parent: 1, started: 1400 },
      { pid: 4300, parent: 4200, started: 1500 }
    ]
    expect(lateStarted(list, ended, ended, now)).toEqual([])
  })

  it("that pid's new holder started after the child: the child came first, so is the ended process's", () => {
    const list = [
      { pid: 4200, parent: 1, started: 1600 },
      { pid: 4300, parent: 4200, started: 1500 }
    ]
    expect(lateStarted(list, ended, ended, now)).toEqual([{ pid: 4300, parent: 4200, started: 1500 }])
  })

  it("what a late child started is ended with it, children first; a process already ended isn't again", () => {
    const list = [
      { pid: 4200, parent: 4141, started: 1100 },
      { pid: 4300, parent: 4200, started: 1500 },
      { pid: 4400, parent: 4300, started: 1600 }
    ]
    expect(lateStarted(list, ended, ended, now).map((p) => p.pid)).toEqual([4400, 4300])
  })
})
