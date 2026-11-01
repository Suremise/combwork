// A terminal's size from its process's start (#486): a process starts at the size the window last gave its terminal
// (a restart, a mode switch, a fit that came before the process), and a size refresh redraws a CLI's screen as resizing
// the window by hand does: one row shorter for a moment, then its size again, or the size the window gives meanwhile.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface Fake {
  resizes: string[]
  spawnedAt: string
  cols: number
  rows: number
}
const fakes = vi.hoisted(() => [] as Fake[])
vi.mock('@lydell/node-pty', () => ({
  spawn: (_file: string, _args: string[], opts: { cols: number; rows: number }) => {
    const f: Fake = { resizes: [], spawnedAt: `${opts.cols}x${opts.rows}`, cols: opts.cols, rows: opts.rows }
    fakes.push(f)
    return {
      get cols() {
        return f.cols
      },
      get rows() {
        return f.rows
      },
      onData: () => undefined,
      onExit: () => undefined,
      write: () => undefined,
      resize: (c: number, r: number) => {
        f.resizes.push(`${c}x${r}`)
        f.cols = c
        f.rows = r
      },
      kill: () => undefined
    }
  }
}))
vi.mock('../src/main/events', () => ({ sendPty: () => undefined }))
vi.mock('../src/main/providers', () => ({ allProviders: () => [] }))

const { PTY_COLS, PTY_ROWS, ptySize, refreshPty, resizePty, spawnPty, startSize } = await import('../src/main/ptyHost')
const spawn = (key: string): Fake => {
  spawnPty(key, { file: 'fake', args: [], cwd: '.', env: {} })
  return fakes.at(-1)!
}

beforeEach(() => {
  fakes.length = 0
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the size a process starts at', () => {
  it('is the default until the window has sized its terminal', () => {
    expect(startSize('s1')).toEqual({ cols: PTY_COLS, rows: PTY_ROWS })
    expect(spawn('s1').spawnedAt).toBe(`${PTY_COLS}x${PTY_ROWS}`)
  })

  it('is the size the window gave its terminal last, for the next process in it', () => {
    spawn('s2')
    resizePty('s2', 84, 34)
    expect(ptySize('s2')).toEqual({ cols: 84, rows: 34 })
    expect(spawn('s2b').spawnedAt).toBe(`${PTY_COLS}x${PTY_ROWS}`)
    expect(startSize('s2')).toEqual({ cols: 84, rows: 34 })
  })

  it('keeps a size given before the process exists', () => {
    resizePty('s3', 100.6, 40.2)
    expect(spawn('s3').spawnedAt).toBe('100x40')
  })

  it('ignores a size no pane has (hidden, mid-layout)', () => {
    resizePty('s4', 1, 30)
    resizePty('s4', Number.NaN, 30)
    expect(startSize('s4')).toEqual({ cols: PTY_COLS, rows: PTY_ROWS })
  })

  // A session's view is made at its start, before its process is spawned, and asks once: hidden, nothing fits it after,
  // so it is told the size that process will start at, never nothing (HI-2250: it stayed xterm's 80 × 24).
  it('is what a view asking before its process exists is told, and the process then has it', () => {
    expect(ptySize('none')).toEqual({ cols: PTY_COLS, rows: PTY_ROWS })
    resizePty('s5', 111, 33)
    const asked = ptySize('s5')
    expect(asked).toEqual({ cols: 111, rows: 33 })
    spawnPty('s5', { file: 'fake', args: [], cwd: '.', env: {}, ...startSize('s5') })
    expect(ptySize('s5')).toEqual(asked)
  })
})

describe('a size refresh', () => {
  it('is one row shorter for a moment, then its size again', () => {
    resizePty('r1', 90, 30)
    const f = spawn('r1')
    refreshPty('r1')
    expect(f.resizes).toEqual(['90x29'])
    vi.advanceTimersByTime(200)
    expect(f.resizes).toEqual(['90x29', '90x30'])
  })

  it('ends at the size the window gave meanwhile', () => {
    resizePty('r2', 90, 30)
    const f = spawn('r2')
    refreshPty('r2')
    resizePty('r2', 70, 25)
    vi.advanceTimersByTime(200)
    expect(f.resizes).toEqual(['90x29', '70x25'])
    expect(startSize('r2')).toEqual({ cols: 70, rows: 25 })
  })

  it('one at a time: a second while one is under way is left alone', () => {
    resizePty('r3', 90, 30)
    const f = spawn('r3')
    refreshPty('r3')
    refreshPty('r3')
    vi.advanceTimersByTime(200)
    expect(f.resizes).toEqual(['90x29', '90x30'])
  })

  it('does nothing without a process', () => {
    expect(() => refreshPty('r4')).not.toThrow()
  })
})
