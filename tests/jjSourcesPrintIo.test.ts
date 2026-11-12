// The Operations print's byte bound limits what is actually read (HR2's HI-2800 round 4), not only what is accepted:
// every byte the print's file reads return is counted (original-fs, wrapped), so an oversized file, a tree file past the
// remaining budget and the cumulative budget are shown unread, and a file changing between its size and its read, or
// unreadable, is unknown, never a partial read's hash. J5's unbounded small sources are read whole, as before.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

const io = vi.hoisted(() => ({ read: 0, lie: new Map<string, number>(), refuse: new Set<string>() }))
vi.mock('original-fs', async (orig) => {
  const real = await orig<typeof import('fs')>()
  const fdPath = new Map<number, string>()
  return {
    ...real,
    openSync: ((p: string, flags: string) => {
      if (io.refuse.has(p)) throw Object.assign(new Error(`EPERM: ${p}`), { code: 'EPERM' })
      const fd = real.openSync(p, flags)
      fdPath.set(fd, p)
      return fd
    }) as typeof real.openSync,
    fstatSync: ((fd: number) => {
      const s = real.fstatSync(fd)
      const lie = io.lie.get(fdPath.get(fd) ?? '')
      return lie === undefined ? s : Object.assign(Object.create(Object.getPrototypeOf(s)), s, { size: lie })
    }) as typeof real.fstatSync,
    readSync: ((fd: number, buf: Buffer, off: number, len: number, pos: number | null) => {
      const n = real.readSync(fd, buf, off, len, pos)
      io.read += n
      return n
    }) as typeof real.readSync,
    readFileSync: ((p: string, o?: unknown) => {
      const b = real.readFileSync(p, o as never) as Buffer | string
      io.read += b.length
      return b
    }) as typeof real.readFileSync
  }
})

const { sourcesPrintWithin, rawSourcesPrint } = await import('../src/main/platform/jjSourcesPrint')

function fixture() {
  const root = tempDir('jjprintio-')
  const jjRepo = join(root, 'repo')
  mkdirSync(join(jjRepo, 'op_heads', 'heads'), { recursive: true })
  writeFileSync(join(jjRepo, 'op_heads', 'heads', 'a'.repeat(128)), '')
  const store = join(root, 'git')
  mkdirSync(join(store, 'refs', 'tags'), { recursive: true })
  writeFileSync(join(store, 'HEAD'), 'ref: refs/heads/main\n')
  const sources = { jjRepo, files: [{ label: 'HEAD', path: join(store, 'HEAD') }, { label: 'packed', path: join(store, 'packed-refs') }], trees: [{ label: 'refs/tags', path: join(store, 'refs', 'tags') }] }
  return { store, sources }
}
const budget = { files: 1000, dirs: 100, bytes: 1024 }

beforeEach(() => {
  io.read = 0
  io.lie.clear()
  io.refuse.clear()
})

describe('the byte bound limits actual reads', () => {
  it('an explicit file already past the remaining budget is refused unread', () => {
    const f = fixture()
    writeFileSync(join(f.store, 'packed-refs'), 'x'.repeat(4096))
    io.read = 0
    expect(sourcesPrintWithin(f.sources, budget)).toBe('over')
    expect(io.read).toBeLessThanOrEqual(1024)
    expect(io.read).toBe(21)
  })

  it('a tree file past the remaining budget is refused unread', () => {
    const f = fixture()
    writeFileSync(join(f.store, 'refs', 'tags', 'big'), 'y'.repeat(5000))
    io.read = 0
    expect(sourcesPrintWithin(f.sources, budget)).toBe('over')
    expect(io.read).toBeLessThanOrEqual(1024)
  })

  it('the cumulative budget: files read until the next would pass it, that one unread', () => {
    const f = fixture()
    for (let i = 0; i < 10; i++) writeFileSync(join(f.store, 'refs', 'tags', `t${i}`), 'z'.repeat(200))
    io.read = 0
    expect(sourcesPrintWithin(f.sources, budget)).toBe('over')
    expect(io.read).toBeLessThanOrEqual(1024)
    expect(io.read).toBe(21 + 5 * 200)
  })

  it('a file changing between its size and its read, or grown past the cap, is unknown or over, never a partial hash', () => {
    const f = fixture()
    writeFileSync(join(f.store, 'packed-refs'), 'p'.repeat(100))
    io.lie.set(join(f.store, 'packed-refs'), 10)
    expect(sourcesPrintWithin(f.sources, budget)).toBeUndefined()
    io.lie.set(join(f.store, 'packed-refs'), 500)
    expect(sourcesPrintWithin(f.sources, budget)).toBeUndefined()
    // Grown well past what its size said (2,000 bytes, said 900): read only to one byte past the size said, unknown.
    writeFileSync(join(f.store, 'packed-refs'), 'p'.repeat(2000))
    io.lie.set(join(f.store, 'packed-refs'), 900)
    io.read = 0
    expect(sourcesPrintWithin(f.sources, budget)).toBeUndefined()
    expect(io.read).toBe(21 + 901)
  })

  it('an unreadable file is unknown; within the budget the print is the unbounded one', () => {
    const f = fixture()
    writeFileSync(join(f.store, 'packed-refs'), 'q'.repeat(100))
    expect(sourcesPrintWithin(f.sources, budget)).toBe(rawSourcesPrint(f.sources))
    io.refuse.add(join(f.store, 'packed-refs'))
    expect(sourcesPrintWithin(f.sources, budget)).toBeUndefined()
  })
})
