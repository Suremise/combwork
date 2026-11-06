// A terminal is killed once (#297): on Windows node-pty closes the pseudoconsole a moment after kill(), and a second
// kill before the first has finished closed it again, which corrupted the heap and took Combwork's main process down
// (Stop, then switching workspace or quitting at once). Until it exits, nothing more is sent to it either.
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface Fake {
  kills: number
  writes: string[]
  resizes: string[]
  cols: number
  rows: number
  exit: (code: number) => void
  failKill: boolean
}
const fakes = vi.hoisted(() => [] as Fake[])
vi.mock('@lydell/node-pty', () => ({
  spawn: (_file: string, _args: string[], opts: { cols: number; rows: number }) => {
    let onExit: (e: { exitCode: number }) => void = () => undefined
    const f: Fake = { kills: 0, writes: [], resizes: [], cols: opts.cols, rows: opts.rows, exit: (code) => onExit({ exitCode: code }), failKill: false }
    fakes.push(f)
    return {
      get cols() {
        return f.cols
      },
      get rows() {
        return f.rows
      },
      onData: () => undefined,
      onExit: (fn: (e: { exitCode: number }) => void) => (onExit = fn),
      write: (d: string) => f.writes.push(d),
      resize: (c: number, r: number) => {
        f.resizes.push(`${c}x${r}`)
        f.cols = c
        f.rows = r
      },
      kill: () => {
        if (f.failKill) throw new Error('kill failed')
        f.kills++
      }
    }
  }
}))
vi.mock('../src/main/events', () => ({ sendPty: () => undefined }))
vi.mock('../src/main/providers', () => ({ allProviders: () => [] }))

const { hasPty, killAll, killPty, resizePty, spawnPty, writePty } = await import('../src/main/ptyHost')
const spawn = (key: string): Fake => {
  spawnPty(key, { file: 'fake', args: [], cwd: '.', env: {} })
  return fakes.at(-1)!
}

beforeEach(() => {
  fakes.length = 0
})

describe('killing a terminal', () => {
  it('kills once: a second kill before it exits is left alone', () => {
    const f = spawn('k1')
    killPty('k1')
    killPty('k1')
    killAll()
    expect(f.kills).toBe(1)
    f.exit(0)
    expect(hasPty('k1')).toBe(false)
  })

  it('sends nothing more to a terminal being killed', () => {
    const f = spawn('k2')
    writePty('k2', 'before')
    resizePty('k2', 100, 30)
    killPty('k2')
    writePty('k2', 'after')
    resizePty('k2', 90, 30)
    expect(f.writes).toEqual(['before'])
    expect(f.resizes).toEqual(['100x30'])
    f.exit(0)
  })

  it('tries again after a kill that failed', () => {
    const f = spawn('k3')
    f.failKill = true
    killPty('k3')
    expect(f.kills).toBe(0)
    f.failKill = false
    killPty('k3')
    expect(f.kills).toBe(1)
    f.exit(0)
  })

  it('a new process in the same terminal can be killed in its turn', () => {
    const first = spawn('k4')
    killPty('k4')
    first.exit(0)
    const second = spawn('k4')
    killPty('k4')
    expect([first.kills, second.kills]).toEqual([1, 1])
    second.exit(0)
  })
})
