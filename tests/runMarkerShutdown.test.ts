// The running marker's write and Combwork quitting (HI-2201, HR2's round 1): a rename started after the write's guard and
// finishing after endRunMarker's removal would put the marker back, and the next start would say Combwork closed
// unexpectedly. The asynchronous rename here waits until the test lets it go: the marker's own rename must never be it.
// Apart from runMarker.test.ts: its mock of original-fs/promises is this file's only.
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { writeMarkerFile } from '../src/main/lastRun'
import type { RunMarker } from '../src/shared/unexpectedClose'
import { tempDir } from './tempDir'

const gate = vi.hoisted(() => {
  let release!: () => void
  let entered!: () => void
  const open = new Promise<void>((r) => (release = r))
  const started = new Promise<void>((r) => (entered = r))
  return { release, entered, open, started, calls: 0 }
})

vi.mock('original-fs/promises', async (original) => {
  const actual = await original<typeof import('fs/promises')>()
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      gate.calls++
      gate.entered()
      await gate.open
      return actual.rename(from, to)
    }
  }
})

const marker: RunMarker = { version: 1, pid: 42, startedAt: '2026-10-20T00:00:00.000Z', lastSeen: '2026-10-20T00:01:00.000Z', app: '1.0.0', workspaces: [], agents: [], processes: [] }

describe('the running marker as Combwork quits (HI-2201)', () => {
  it('is never put back once removed, whatever its rename waited on', async () => {
    const file = join(tempDir('run-marker-quit-'), 'running.json')
    let wanted = true
    const writing = writeMarkerFile(file, marker, () => wanted)
    try {
      // The write is either done or its rename has started: then Combwork quits (endRunMarker), and the rename may finish.
      await Promise.race([gate.started, writing])
      wanted = false
      rmSync(file, { force: true })
      gate.release()
      await writing
      expect(existsSync(file)).toBe(false)
      expect(gate.calls).toBe(0)
    } finally {
      gate.release()
      await writing
    }
  })
})
