// The runners' timings file, which every runner on the machine shares (#1518): a read that fails while another runner
// renames its new copy into place (ENOENT on Windows, for a moment) is tried again, and timings that can't be read are
// never written over. Real files; the read's failures injected.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

/**
 * readFileSync failures to give for `file`, in order (an error code each), before it reads the file again; `locked`: the
 * new copy beside it held by another process (a scanner), its rename and removal refused (EPERM).
 */
const fault = vi.hoisted(() => ({ file: '', codes: [] as string[], locked: false }))
vi.mock('node:fs', async () => {
  const real = await vi.importActual<typeof import('node:fs')>('node:fs')
  const read = real.readFileSync as (p: unknown, o?: unknown) => string | Buffer
  const held = (p: unknown): boolean => fault.locked && String(p).startsWith(`${fault.file}.`) && String(p).endsWith('.tmp')
  const refused = () => Object.assign(new Error('EPERM: injected'), { code: 'EPERM' })
  return {
    ...real,
    readFileSync: (p: unknown, o?: unknown) => {
      if (fault.codes.length && String(p) === fault.file) throw Object.assign(new Error(`${fault.codes[0]}: injected`), { code: fault.codes.shift() })
      return read(p, o)
    },
    renameSync: (from: string, to: string) => {
      if (held(from)) throw refused()
      return real.renameSync(from, to)
    },
    rmSync: (p: string, o?: Parameters<typeof real.rmSync>[1]) => {
      if (held(p)) throw refused()
      return real.rmSync(p, o)
    }
  }
})

const { estimateFor, recordTiming } = await import('../src/main/progressReporters/report.mts')

const dir = tempDir('cw-timings-')
let file = ''
let n = 0
beforeEach(() => {
  file = join(dir, `t${++n}`, 'progress-timings.json')
  mkdirSync(join(dir, `t${n}`), { recursive: true })
  fault.file = file
  fault.codes = []
  fault.locked = false
})
const kept = () => JSON.parse(readFileSync(file, 'utf8')) as { runs: Record<string, { ms: number[] }> }

describe("the runners' timings (#1518)", () => {
  it('a read failing for a moment (another runner replacing the file) is tried again: the estimate is there', () => {
    recordTiming(file, 'e2e:about', 1000)
    fault.codes = ['ENOENT', 'ENOENT', 'EPERM']
    expect(estimateFor(file, 'e2e:about')).toBe(1000)
    expect(fault.codes).toEqual([])
  })

  it("a run recorded while the file can't be read leaves every other run's timing as it was", () => {
    recordTiming(file, 'e2e:about', 1000)
    recordTiming(file, 'e2e:board', 2000)
    fault.codes = Array(40).fill('EBUSY')
    recordTiming(file, 'e2e:new', 3000)
    fault.codes = []
    expect(Object.keys(kept().runs).sort()).toEqual(['e2e:about', 'e2e:board'])
    // Unreadable for good (a folder where the file should be): no estimate, nothing written.
    const folder = join(dir, `t${n}`, 'a-folder.json')
    mkdirSync(folder)
    expect(estimateFor(folder, 'e2e:about')).toBeUndefined()
    recordTiming(folder, 'e2e:about', 1000)
    expect(existsSync(join(folder, 'e2e:about'))).toBe(false)
  })

  it("every read saying there's no file while the table is there (a replacement under way) never replaces it (HR6's round 1)", () => {
    recordTiming(file, 'e2e:about', 1000)
    recordTiming(file, 'e2e:board', 2000)
    fault.codes = Array(40).fill('ENOENT')
    recordTiming(file, 'e2e:new', 3000)
    fault.codes = []
    expect(Object.keys(kept().runs).sort()).toEqual(['e2e:about', 'e2e:board'])
    // Nothing left of its new copy beside it.
    expect(readdirSync(join(dir, `t${n}`))).toEqual(['progress-timings.json'])
  })

  it("its new copy held by another process (its rename and removal refused): the run's time is lost, nothing throws, the table stays (HR6's round 2)", () => {
    recordTiming(file, 'e2e:about', 1000)
    fault.locked = true
    expect(() => recordTiming(file, 'e2e:new', 3000)).not.toThrow()
    fault.locked = false
    expect(Object.keys(kept().runs)).toEqual(['e2e:about'])
    // Its copy left behind (held), then the next run records as usual and removes its own.
    expect(readdirSync(join(dir, `t${n}`)).filter((f) => f.endsWith('.tmp'))).toHaveLength(1)
    recordTiming(file, 'e2e:new', 3000)
    expect(Object.keys(kept().runs).sort()).toEqual(['e2e:about', 'e2e:new'])
    expect(readdirSync(join(dir, `t${n}`)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('no file yet is none, and a damaged one starts again', () => {
    expect(estimateFor(file, 'e2e:about')).toBeUndefined()
    recordTiming(file, 'e2e:about', 1000)
    expect(kept().runs['e2e:about'].ms).toEqual([1000])
    writeFileSync(file, '{ not json')
    expect(estimateFor(file, 'e2e:about')).toBeUndefined()
    recordTiming(file, 'e2e:board', 2000)
    expect(Object.keys(kept().runs)).toEqual(['e2e:board'])
  })
})
