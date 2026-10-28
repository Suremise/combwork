// A settings file replaced or grown between Hive's stat and its read (#333): both readers (the compaction reader's and
// the launch's read of a user's --settings) read the opened file to its end, never trusting the stat's size, and
// never past a byte over Claude Code's 2 MiB limit. `afterStat` runs once, right after the next stat of that file.
import { rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

const race = vi.hoisted(() => ({ file: '', afterStat: null as null | (() => void) }))
const fire = (p: unknown): void => {
  if (race.afterStat && String(p) === race.file) {
    const fn = race.afterStat
    race.afterStat = null
    fn()
  }
}
vi.mock('fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('fs')>()
  return {
    ...fs,
    statSync: ((p: string, o?: object) => {
      const st = fs.statSync(p, o as never)
      fire(p)
      return st
    }) as typeof fs.statSync
  }
})
vi.mock('fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('fs/promises')>()
  return {
    ...fs,
    stat: (async (p: string) => {
      const st = await fs.stat(p)
      fire(p)
      return st
    }) as typeof fs.stat
  }
})

const { SETTINGS_FILE_LIMIT, cliSettings } = await import('../src/main/providers/claude/autoCompact')
const { userSettings } = await import('../src/main/providers/claude/launchSettings')

const dir = tempDir('hive-settings-race-')
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const file = join(dir, 'mine.json')
/** JSON of exactly `bytes` bytes. */
const sized = (bytes: number, json: object): string => {
  const s = JSON.stringify({ ...json, pad: '' })
  return s.replace('"pad":""', `"pad":"${'x'.repeat(bytes - s.length)}"`)
}
/** The file holds `before` when stat'ed, and `after` once the stat has returned. */
const changes = (before: string, after: string): void => {
  writeFileSync(file, before)
  race.file = file
  race.afterStat = () => writeFileSync(file, after)
}
beforeEach(() => {
  race.afterStat = null
})

describe('a settings file that changes between the stat and the read (#333)', () => {
  const grown = JSON.stringify({ autoCompactWindow: 150_000, env: { A: 'x'.repeat(200_000) } })

  it('reads all of a file that grew but is within the limit', async () => {
    changes('{}', grown)
    expect(cliSettings(['--settings', file], dir)).toEqual({ label: `--settings ${file}`, kind: 'cli', file, json: JSON.parse(grown) })
    changes('{}', grown)
    expect(await userSettings(['--settings', file], dir)).toEqual(JSON.parse(grown))
  })

  it('reads a file replaced by a shorter one as it is now', async () => {
    changes(grown, '{"model":"opus"}')
    expect(cliSettings(['--settings', file], dir)?.json).toEqual({ model: 'opus' })
    changes(grown, '{"model":"opus"}')
    expect(await userSettings(['--settings', file], dir)).toEqual({ model: 'opus' })
  })

  it('refuses a file that grew past the limit, saying so (unsure for the compaction reader)', async () => {
    const big = sized(SETTINGS_FILE_LIMIT + 1, { autoCompactWindow: 150_000 })
    changes('{}', big)
    expect(cliSettings(['--settings', file], dir)).toEqual({ label: `--settings ${file}`, kind: 'cli', file, json: null, unsure: "couldn't be read (it's over Claude Code's 2 MiB limit)" })
    changes('{}', big)
    await expect(userSettings(['--settings', file], dir)).rejects.toThrow("can't be read: it's over Claude Code's 2 MiB limit for settings files.")
    // Exactly the limit is still read.
    const exact = sized(SETTINGS_FILE_LIMIT, { autoCompactWindow: 150_000 })
    changes('{}', exact)
    expect(cliSettings(['--settings', file], dir)?.json).toMatchObject({ autoCompactWindow: 150_000 })
    changes('{}', exact)
    expect(await userSettings(['--settings', file], dir)).toMatchObject({ autoCompactWindow: 150_000 })
  })
})
