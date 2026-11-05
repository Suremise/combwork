// The running marker's write (#1111): asynchronous, whole or not at all, and never put back once the run has ended.
import { existsSync, readdirSync, readFileSync, renameSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { writeMarkerFile } from '../src/main/lastRun'
import type { RunMarker } from '../src/shared/unexpectedClose'
import { tempDir } from './tempDir'

const marker: RunMarker = { version: 1, pid: 42, startedAt: '2026-10-20T00:00:00.000Z', lastSeen: '2026-10-20T00:01:00.000Z', app: '0.9.4', workspaces: [], agents: [], processes: [] }

describe('the running marker (#1111)', () => {
  it('is written whole, compact, with no temp file left', async () => {
    const dir = tempDir('run-marker-')
    const file = join(dir, 'running.json')
    expect(await writeMarkerFile(file, marker, () => true)).toBe(true)
    const text = readFileSync(file, 'utf8')
    expect(JSON.parse(text)).toEqual(marker)
    expect(text).toBe(`${JSON.stringify(marker)}\n`)
    expect(readdirSync(dir)).toEqual(['running.json'])
  })

  it('is not put back when the run ended while it was written (Combwork quitting)', async () => {
    const dir = tempDir('run-marker-')
    const file = join(dir, 'running.json')
    expect(await writeMarkerFile(file, marker, () => false)).toBe(false)
    expect(existsSync(file)).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  it('a write that fails leaves nothing behind', async () => {
    const dir = tempDir('run-marker-')
    expect(await writeMarkerFile(join(dir, 'missing', 'running.json'), marker, () => true)).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  // HI-2201: the rename into place was refused for a moment (EPERM: a virus scanner looking at the file just written), and
  // the marker missed what had joined the launch until the next heartbeat. A rename refused the first times, as Windows does.
  const refusedAtFirst = (times: number, meanwhile: () => void = () => undefined) => {
    let tries = 0
    const once = async (from: string, to: string): Promise<void> => {
      if (++tries <= times) {
        meanwhile()
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' })
      }
      renameSync(from, to)
    }
    return { once, tries: () => tries }
  }

  it('is written once the rename is let through', async () => {
    const dir = tempDir('run-marker-')
    const file = join(dir, 'running.json')
    const rename = refusedAtFirst(3)
    expect(await writeMarkerFile(file, marker, () => true, rename.once)).toBe(true)
    expect(rename.tries()).toBe(4)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(marker)
    expect(readdirSync(dir)).toEqual(['running.json'])
  })

  it('is not put back when the run ends while its rename is refused', async () => {
    const dir = tempDir('run-marker-')
    const file = join(dir, 'running.json')
    let wanted = true
    const rename = refusedAtFirst(3, () => (wanted = false))
    expect(await writeMarkerFile(file, marker, () => wanted, rename.once)).toBe(false)
    expect(rename.tries()).toBe(1)
    expect(readdirSync(dir)).toEqual([])
  })
})
