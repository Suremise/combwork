// HI-3358: a process the tree starts after endTreeAsync's listing and before its end is ended too. The end runs in a
// PowerShell session that holds each process it ends (its pid can't be another's while held), lists again and ends what a
// held process started since, at most LATE_ROUNDS more times. Mock-only (processTreeMock.ts): no real process is listed,
// held or ended.
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', async (original) => (await import('./processTreeMock')).mocked(await original<typeof import('node:child_process')>()))

const { endTreeAsync, lateStarted, LATE_ROUNDS, TREE_END_MS, treeEnding } = await import('../src/main/processTree')
const { probe, resetProbe, ends } = await import('./processTreeMock')

const fakeChild = (pid: number) => ({ pid, exitCode: null as number | null, signalCode: null as string | null, kill: vi.fn() })
const lines = (...l: string[]): string => l.join('\n')

beforeEach(resetProbe)
afterEach(() => void vi.useRealTimers())

describe('endTreeAsync: what the tree started after its listing (HI-3358)', () => {
  it("the card's reproduction: a child its shell starts between the listing and the end is ended in a second round, in the same session", async () => {
    // 4141 git, 4200 its filter's shell. 4300: the shell's late node, started after the first listing; 4400 its child.
    probe.listings = [lines('4141 0 1000', '4200 4141 1100'), lines('4300 4200 1500', '4400 4300 1600'), lines('9999 1 500')]
    const root = fakeChild(4141)
    await endTreeAsync(root as unknown as ChildProcess, 'win32')
    expect(ends()).toEqual([['4200:1100', '4141:1000'], ['4400:1600', '4300:1500']])
    expect(probe.commands.filter((c) => c.includes('ReadLine'))).toHaveLength(1)
    expect(root.kill).not.toHaveBeenCalled()
  })

  it('nothing started late: one listing in the session, no second end', async () => {
    probe.listings = [lines('4141 0 1000', '4200 4141 1100'), lines('9999 1 500')]
    await endTreeAsync(fakeChild(4141) as unknown as ChildProcess, 'win32')
    expect(ends()).toEqual([['4200:1100', '4141:1000']])
    expect(probe.requests).toEqual(['end 4200:1100,4141:1000', 'list'])
  })

  it("HR1's case: the parent exited before its end, its pid went to an unrelated process that started a child and exited: that child is left", async () => {
    // 4200 (start 1100) exits before the end can hold it; 4200 is reused (start 1400), starts 4300 (1500) and exits.
    probe.listings = [lines('4141 0 1000', '4200 4141 1100'), lines('4141 0 1000', '4300 4200 1500')]
    probe.gone.add('4200:1100')
    await endTreeAsync(fakeChild(4141) as unknown as ChildProcess, 'win32')
    expect(ends()).toEqual([['4200:1100', '4141:1000']])
  })

  it('the parent never held, its pid held by a newer process started after the child: the child is still left (a parent id is only a number then)', async () => {
    probe.listings = [lines('4141 0 1000', '4200 4141 1100'), lines('4200 1 1600', '4300 4200 1500')]
    probe.gone.add('4200:1100')
    await endTreeAsync(fakeChild(4141) as unknown as ChildProcess, 'win32')
    expect(ends()).toEqual([['4200:1100', '4141:1000']])
  })

  it('a late child of a late child (its parent held in the round before) is ended in the next round', async () => {
    probe.listings = [lines('4141 0 1000'), lines('4300 4141 1500'), lines('4500 4300 1700'), lines('9999 1 500')]
    await endTreeAsync(fakeChild(4141) as unknown as ChildProcess, 'win32')
    expect(ends()).toEqual([['4141:1000'], ['4300:1500'], ['4500:1700']])
  })

  it('a late child that could not be held (it exited first): what it started is not followed', async () => {
    probe.listings = [lines('4141 0 1000'), lines('4300 4141 1500'), lines('4500 4300 1700'), lines('9999 1 500')]
    probe.gone.add('4300:1500')
    await endTreeAsync(fakeChild(4141) as unknown as ChildProcess, 'win32')
    expect(ends()).toEqual([['4141:1000'], ['4300:1500']])
  })

  it('still finding late children after LATE_ROUNDS rounds: stops and says so', async () => {
    const rounds = [lines('4141 0 1000')]
    for (let r = 1; r <= LATE_ROUNDS + 1; r++) rounds.push(lines(`${5000 + r} ${r === 1 ? 4141 : 5000 + r - 1} ${1000 + r * 100}`))
    probe.listings = rounds
    const left = vi.fn()
    await endTreeAsync(fakeChild(4141) as unknown as ChildProcess, 'win32', undefined, { onLateLeft: left })
    expect(ends()).toHaveLength(1 + LATE_ROUNDS)
    expect(left).toHaveBeenCalledTimes(1)
    expect(left.mock.calls[0][0]).toContain(`after ${LATE_ROUNDS} more ends`)
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

  it('bounded (HR1): runs that never answer are ended, and the teardown settles by TREE_END_MS, the root then ended through its handle', async () => {
    vi.useFakeTimers()
    probe.hang = true
    const root = fakeChild(4141)
    let settled = false
    const left = vi.fn()
    void endTreeAsync(root as unknown as ChildProcess, 'win32', undefined, { onLateLeft: left }).then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(TREE_END_MS - 1)
    // The listing ended at its bound gave nothing to end: no session was needed.
    expect(settled).toBe(true)
    expect(root.kill).toHaveBeenCalledTimes(1)
  })

  it('bounded (HR1): a session that never answers the end is ended at its bound, said, the root ended through its handle, and the teardown settles by TREE_END_MS', async () => {
    vi.useFakeTimers()
    probe.listings = [lines('4141 0 1000', '4200 4141 1100')]
    const root = fakeChild(4141)
    let settled = false
    const left = vi.fn()
    // The listing answers; the session started after it never does.
    probe.answers = 0
    void endTreeAsync(root as unknown as ChildProcess, 'win32', undefined, { onLateLeft: left }).then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(TREE_END_MS - 1)
    expect(settled).toBe(true)
    expect(probe.requests).toEqual(['end 4200:1100,4141:1000'])
    expect(left.mock.calls).toEqual([['its ending session ended before it answered the end']])
    expect(root.kill).toHaveBeenCalledTimes(1)
  })

  it('bounded (HR1): a session that ends the tree but never answers the listing after it is ended at its bound, said, and the teardown settles by TREE_END_MS', async () => {
    vi.useFakeTimers()
    probe.listings = [lines('4141 0 1000', '4200 4141 1100')]
    const root = fakeChild(4141)
    let settled = false
    const left = vi.fn()
    probe.answers = 1
    void endTreeAsync(root as unknown as ChildProcess, 'win32', undefined, { onLateLeft: left }).then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(TREE_END_MS - 1)
    expect(settled).toBe(true)
    expect(probe.requests).toEqual(['end 4200:1100,4141:1000', 'list'])
    expect(left.mock.calls).toEqual([['its ending session ended before a listing after the end']])
    // The root was ended by the first end: not again through its handle.
    expect(root.kill).not.toHaveBeenCalled()
  })

  it('a session that ends during a late end: said, and the teardown settles by TREE_END_MS', async () => {
    vi.useFakeTimers()
    probe.listings = [lines('4141 0 1000'), lines('4300 4141 1500')]
    const left = vi.fn()
    let settled = false
    probe.answers = 2
    void endTreeAsync(fakeChild(4141) as unknown as ChildProcess, 'win32', undefined, { onLateLeft: left }).then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(TREE_END_MS - 1)
    expect(settled).toBe(true)
    expect(probe.requests).toEqual(['end 4141:1000', 'list', 'end 4300:1500'])
    expect(left.mock.calls).toEqual([['its ending session ended during a late end']])
  })
})

describe('lateStarted: children of held processes only (HI-3358)', () => {
  const held = [{ pid: 4200, parent: 4141, started: 1100 }]

  it('a process whose parent id names a held process and that started no earlier than it is that process\'s', () => {
    expect(lateStarted([{ pid: 4300, parent: 4200, started: 1500 }], held, held)).toEqual([{ pid: 4300, parent: 4200, started: 1500 }])
  })

  it('one that started before the held process (an older orphan under that number) is not', () => {
    expect(lateStarted([{ pid: 4300, parent: 4200, started: 900 }], held, held)).toEqual([])
  })

  it('one whose parent was tried but never held is not, whenever it started', () => {
    expect(lateStarted([{ pid: 4300, parent: 4200, started: 1500 }], [], held)).toEqual([])
  })

  it("what a late child started is ended with it, children first; a process already tried isn't again", () => {
    const list = [
      { pid: 4200, parent: 4141, started: 1100 },
      { pid: 4300, parent: 4200, started: 1500 },
      { pid: 4400, parent: 4300, started: 1600 }
    ]
    expect(lateStarted(list, held, held).map((p) => p.pid)).toEqual([4400, 4300])
  })
})
