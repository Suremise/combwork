// HI-3054: endTreeAsync never ends a process that took its root's pid while it awaited the MSYS search or the listing.
// Mock-only: node:child_process's spawn is replaced, so no real process is listed, selected or ended; the PowerShell
// each run would get is recorded, never run. The root's exit is simulated by setting exitCode, as Node does before it
// closes the process's handle (only then can Windows give its pid to another process).
import type { ChildProcess } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', async (original) => (await import('./processTreeMock')).mocked(await original<typeof import('node:child_process')>()))

const { endTreeAsync } = await import('../src/main/processTree')
const { probe, resetProbe, ends } = await import('./processTreeMock')

/** What the first end was given, in order (`pid:started`), or null when there was none. */
const targets = (): string[] | null => ends()[0] ?? null
const fakeChild = (pid: number) => ({ pid, exitCode: null as number | null, signalCode: null as string | null, kill: vi.fn() })
/** An MSYS search's answer: started by 2000 (Unix ms), marked winpid `win` (MSYS pid 7). */
const marked = (win: number) => ({ out: ['t 2.000000', `a 7 ${win}`, `m 7 ${win}`, `b 7 ${win}`, 'end'].join('\n') })

beforeEach(resetProbe)

describe('endTreeAsync: the root that exited during the wait (HI-3054)', () => {
  it("the root exits during the MSYS search and its pid goes to another process: that one and its children are never ended, the root's marked MSYS program still is", async () => {
    // 4141: the replacement (started at 3000, after the search began); 4200 its child. 5000: the marked MSYS program,
    // started before the search, its parent long gone; 5100 its child.
    probe.listings = [['4141 0 3000', '4200 4141 3100', '5000 1 1500', '5100 5000 1600'].join('\n')]
    const root = fakeChild(4141)
    await endTreeAsync(root as unknown as ChildProcess, 'win32', {
      mark: '0123456789abcdef',
      bin: 'unused',
      discover: async () => {
        root.exitCode = 0
        return marked(5000)
      }
    })
    expect(targets()).toEqual(['5100:1600', '5000:1500'])
    expect(root.kill).not.toHaveBeenCalled()
  })

  it("the card's probe: the replacement under the root's pid is never a target", async () => {
    probe.listings = ['4141 0 3000']
    const root = fakeChild(4141)
    await endTreeAsync(root as unknown as ChildProcess, 'win32', {
      mark: '0123456789abcdef',
      bin: 'unused',
      discover: async () => {
        root.exitCode = 0
        return { out: 't 2.000000\nend\n' }
      }
    })
    expect([...probe.commands, ...probe.requests].some((c) => c.includes('4141:3000'))).toBe(false)
    expect(targets()).toBeNull()
  })

  it('the root ends by a signal while the listing runs (no MSYS search): nothing is ended, and the child is not killed again', async () => {
    probe.listings = [['4141 0 3000', '4200 4141 3100'].join('\n')]
    const root = fakeChild(4141)
    probe.onList = () => void (root.signalCode = 'SIGTERM')
    await endTreeAsync(root as unknown as ChildProcess, 'win32')
    expect(targets()).toBeNull()
    expect(root.kill).not.toHaveBeenCalled()
  })

  it('the root still running after the listing: its tree and its marked programs are ended, children before parents, as before', async () => {
    probe.listings = [['4141 0 1000', '4200 4141 1100', '4300 4200 1200', '5000 1 1500'].join('\n')]
    const root = fakeChild(4141)
    await endTreeAsync(root as unknown as ChildProcess, 'win32', { mark: '0123456789abcdef', bin: 'unused', discover: async () => marked(5000) })
    expect(targets()).toEqual(['5000:1500', '4300:1200', '4200:1100', '4141:1000'])
    expect(root.kill).not.toHaveBeenCalled()
  })

  it('the root still running but not in the listing: ended through its own handle (child.kill), as before', async () => {
    probe.listings = ['9999 0 1000']
    const root = fakeChild(4141)
    await endTreeAsync(root as unknown as ChildProcess, 'win32')
    expect(targets()).toBeNull()
    expect(root.kill).toHaveBeenCalledTimes(1)
  })
})
