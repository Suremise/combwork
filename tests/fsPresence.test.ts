// HI-2598 (the Assistant's note after HR1's rounds 1 and 2): in the one-way upgrade's steps only a thing's absence means
// "not there"; any other error (held by another program, access denied) throws, so the step fails, nothing is recorded
// done and the next open or start tries again. The shared helper (fsPresence.ts), and the places that used to take an
// error for an absence: the folder move's refusal (presence.ts), its marker read and host listing (combworkMove.ts), and
// the profile's run marker (nameUpgradeProfile.ts).
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

/** Paths reads refuse with EPERM, as another program holding them would. */
const held = new Set<string>()
const refused = (p: unknown): boolean => held.has(String(p).toLowerCase())
const eperm = (p: unknown): Error => Object.assign(new Error(`EPERM: operation not permitted, '${String(p)}' (test)`), { code: 'EPERM' })

vi.mock('original-fs', async (orig) => {
  const real = await orig<typeof import('fs')>()
  return {
    ...real,
    statSync: ((p: string, o?: unknown) => {
      if (refused(p)) throw eperm(p)
      return real.statSync(p, o as never)
    }) as typeof real.statSync,
    lstatSync: ((p: string, o?: unknown) => {
      if (refused(p)) throw eperm(p)
      return real.lstatSync(p, o as never)
    }) as typeof real.lstatSync,
    readdirSync: ((p: string, o?: unknown) => {
      if (refused(p)) throw eperm(p)
      return real.readdirSync(p, o as never)
    }) as typeof real.readdirSync,
    readFileSync: ((p: string, o?: unknown) => {
      if (refused(p)) throw eperm(p)
      return real.readFileSync(p, o as BufferEncoding)
    }) as typeof real.readFileSync
  }
})
vi.mock('original-fs/promises', async (orig) => {
  const real = await orig<typeof import('fs/promises')>()
  return {
    ...real,
    lstat: (async (p: string) => (refused(p) ? Promise.reject(eperm(p)) : real.lstat(p))) as typeof real.lstat,
    readFile: (async (p: string, o?: unknown) => (refused(p) ? Promise.reject(eperm(p)) : real.readFile(p, o as BufferEncoding))) as typeof real.readFile
  }
})

const { ifAbsent, lstatOrNull, lstatOrNullAsync, present } = await import('../src/main/fsPresence')
const { othersPresentByProcess, PRESENCE_DIR } = await import('../src/main/presence')
const { classify, MARK_FILE } = await import('../src/main/combworkMove')
const { upgradeProfileFiles } = await import('../src/main/nameUpgradeProfile')

const base = tempDir('fspresence-')
let n = 0
const fresh = (): string => {
  const d = join(base, `d${++n}`)
  mkdirSync(d, { recursive: true })
  return d
}
const hold = (p: string): void => void held.add(p.toLowerCase())

describe('only absence is "not there" (fsPresence.ts)', () => {
  it('a missing path, or one under a file, is absent; one that is there, present; any other error throws', async () => {
    const d = fresh()
    writeFileSync(join(d, 'f'), 'x')
    expect(present(join(d, 'f'))).toBe(true)
    expect(present(join(d, 'none'))).toBe(false)
    expect(present(join(d, 'f', 'under-a-file'))).toBe(false)
    expect(lstatOrNull(join(d, 'none'))).toBeNull()
    expect(await lstatOrNullAsync(join(d, 'none'))).toBeNull()
    hold(join(d, 'f'))
    expect(() => present(join(d, 'f'))).toThrow(/EPERM/)
    expect(() => lstatOrNull(join(d, 'f'))).toThrow(/EPERM/)
    await expect(lstatOrNullAsync(join(d, 'f'))).rejects.toThrow(/EPERM/)
    expect(await Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' })).catch(ifAbsent('none'))).toBe('none')
    await expect(Promise.reject(eperm('x')).catch(ifAbsent('none'))).rejects.toThrow(/EPERM/)
  })
})

describe('the places that took an error for an absence', () => {
  it("the folder move's refusal: no markers folder is nobody; one it can't list, or a marker it can't read, throws", () => {
    const d = fresh()
    expect(othersPresentByProcess(d)).toEqual([])
    mkdirSync(join(d, PRESENCE_DIR))
    writeFileSync(join(d, PRESENCE_DIR, 'other.json'), JSON.stringify({ pid: 1, profile: 'p', appVersion: '1', startedAt: '', heartbeat: new Date().toISOString() }))
    hold(join(d, PRESENCE_DIR, 'other.json'))
    expect(() => othersPresentByProcess(d)).toThrow(/EPERM/)
    hold(join(d, PRESENCE_DIR))
    expect(() => othersPresentByProcess(d)).toThrow(/EPERM/)
  })

  it("a host's .combwork whose marker can't be read now fails the look, never taken for a host Combwork didn't move", async () => {
    const ws = fresh()
    mkdirSync(join(ws, '.combwork'))
    expect(await classify(ws, ws, 'workspace')).toBe('current')
    const marker = join(ws, '.combwork', MARK_FILE)
    writeFileSync(marker, JSON.stringify({ kind: 'combwork-move', version: 1, id: 'x' }))
    hold(marker)
    await expect(classify(ws, ws, 'workspace')).rejects.toThrow(/EPERM/)
  })

  it("the profile's run marker and its progress history: held, the start is refused; missing, nothing to do", () => {
    const p = fresh()
    expect(upgradeProfileFiles(p)).toEqual([])
    // old-name: begin old-run-marker
    writeFileSync(join(p, 'running.json'), JSON.stringify({ version: 1, hive: '1.0.0' }))
    // old-name: end old-run-marker
    hold(join(p, 'running.json'))
    expect(upgradeProfileFiles(p)).toEqual([join(p, 'running.json')])
    const q = fresh()
    mkdirSync(join(q, 'progress-history'))
    hold(join(q, 'progress-history'))
    expect(upgradeProfileFiles(q)).toEqual([join(q, 'progress-history')])
  })
})
