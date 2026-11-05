// The "nothing running here" check (slots.ts `quiet`, HI-1753): renaming a slot's or copy's folder aside and back. Several
// checks of one folder at once (isolated checks' leases each looking at the pool's returning copies) renamed it on from one
// aside name to the next, and the first couldn't put it back (ENOENT). Now one runs per folder and the others share its
// answer: one rename pair, the folder in place, nothing logged. The renames are counted, and the first held at a gate
// until every caller has asked, so the checks overlap whatever the timing.
import { existsSync, mkdirSync, readdirSync } from 'fs'
import { spawn } from 'child_process'
import { dirname, join } from 'path'
import { createRequire } from 'module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

const fsState = vi.hoisted(() => ({ renames: [] as [string, string][], gate: null as Promise<void> | null }))
vi.mock('fs/promises', async (original) => {
  const real = await original<typeof import('fs/promises')>()
  const rename = async (from: string, to: string): Promise<void> => {
    fsState.renames.push([from, to])
    if (fsState.gate && /\.cw-quiet-/.test(to)) await fsState.gate
    return real.rename(from, to)
  }
  return { ...real, default: { ...real, rename }, rename }
})
const errors = vi.hoisted(() => [] as string[])
vi.mock('../src/main/logger', async (original) => {
  const real = await original<typeof import('../src/main/logger')>()
  return {
    ...real,
    createLogger: (scope: string) => {
      const l = real.createLogger(scope)
      return { ...l, error: (m: string, e?: unknown) => (errors.push(`[${scope}] ${m}`), l.error(m, e)) }
    }
  }
})

const { quiet } = await import('../src/main/slots')
const req = createRequire(import.meta.url)
const { baseEnv } = req('./e2e/runContext.cjs') as { baseEnv: () => Record<string, string> }

// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take.
const HUNG_MS = 20_000

afterEach(() => {
  fsState.renames.length = 0
  fsState.gate = null
  errors.length = 0
})

/** A copy's folder, with a file in it. */
function folder(): string {
  const f = join(tempDir('quiet-'), 'copies', 'copy-4')
  mkdirSync(join(f, 'src'), { recursive: true })
  return f
}

describe('the quiet check, several at once on one folder (HI-1753)', { timeout: 60_000 }, () => {
  it('runs one rename pair and shares its answer; the folder is in place and nothing is logged', async () => {
    const f = folder()
    let open!: () => void
    fsState.gate = new Promise<void>((r) => (open = r))
    // Five callers at once, one naming the folder in other case (Windows paths compare without case).
    const checks = [quiet(f), quiet(f), quiet(f.toUpperCase()), quiet(f), quiet(f)]
    await vi.waitFor(() => expect(fsState.renames).toHaveLength(1), { timeout: HUNG_MS })
    open()
    expect(await Promise.all(checks)).toEqual([true, true, true, true, true])
    expect(fsState.renames).toHaveLength(2)
    const [aside, back] = fsState.renames
    expect(aside[0]).toBe(f)
    expect(back).toEqual([aside[1], f])
    expect(existsSync(f)).toBe(true)
    expect(readdirSync(dirname(f))).toEqual(['copy-4'])
    expect(errors).toEqual([])
  })

  it('a check after the last one ended runs again (an answer is shared only while its check runs)', async () => {
    const f = folder()
    expect(await quiet(f)).toBe(true)
    expect(await quiet(f)).toBe(true)
    expect(fsState.renames).toHaveLength(4)
  })

  it('with a process in the folder, every caller at once is told it is busy, from one try', async () => {
    const f = folder()
    const child = spawn(process.execPath, ['-e', 'console.log("up"); setInterval(() => {}, 1000)'], { cwd: f, env: baseEnv(), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    try {
      await new Promise<void>((r) => child.stdout!.once('data', () => r()))
      expect(await Promise.all([quiet(f), quiet(f), quiet(f)])).toEqual([false, false, false])
      expect(fsState.renames).toHaveLength(1)
      expect(existsSync(f)).toBe(true)
      expect(errors).toEqual([])
    } finally {
      child.kill()
      await new Promise<void>((r) => (child.exitCode !== null || child.signalCode !== null ? r() : child.once('exit', () => r())))
    }
  })
})
