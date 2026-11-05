// HI-2587: the names upgrade's steps in the profile, at start (nameUpgradeProfile.ts, logger.ts moveOldLogs). The run
// marker of a 1.0 or RC run names its version under `hive`: renamed `app` before it is read, its other fields as they
// were; one already new, or not JSON, is left. The log's files: hive.log and hive.1.log take the new names while those
// are free; one whose new name is taken stays where it is, byte for byte; a fresh profile has nothing to do.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
import { upgradedRunMarker, upgradeRunMarkerFile } from '../src/main/nameUpgradeProfile'
import { parseRunMarker } from '../src/shared/unexpectedClose'
import { moveOldLogs } from '../src/main/logger'

const base = tempDir('nameupgrade-profile-')
let n = 0
const MARKER = { version: 1, pid: 42, startedAt: '2026-10-17T01:00:00.000Z', lastSeen: '2026-10-17T03:02:56.000Z', hive: '1.1.0-rc.2', workspaces: ['D:/ws'], agents: [] }

describe('the run marker', () => {
  it("a 1.0 or RC marker's version is renamed app, read as before", () => {
    const now = upgradedRunMarker(JSON.stringify(MARKER))!
    expect(JSON.parse(now)).toEqual({ ...Object.fromEntries(Object.entries(MARKER).filter(([k]) => k !== 'hive')), app: '1.1.0-rc.2' })
    expect(parseRunMarker(now)?.app).toBe('1.1.0-rc.2')
    expect(upgradedRunMarker(now)).toBeNull()
    expect(upgradedRunMarker('not json')).toBeNull()
  })

  it('the file is rewritten in place once; a missing one is nothing', () => {
    const file = join(base, `running${++n}.json`)
    writeFileSync(file, JSON.stringify(MARKER))
    upgradeRunMarkerFile(file)
    expect(JSON.parse(readFileSync(file, 'utf8')).app).toBe('1.1.0-rc.2')
    upgradeRunMarkerFile(join(base, 'none.json'))
    expect(existsSync(join(base, 'none.json'))).toBe(false)
  })
})

describe("the log's files", () => {
  it('take the new names while they are free', () => {
    const dir = join(base, `logs${++n}`)
    mkdirSync(dir)
    writeFileSync(join(dir, 'hive.log'), 'now')
    writeFileSync(join(dir, 'hive.1.log'), 'before')
    moveOldLogs(dir)
    expect(readdirSync(dir).sort()).toEqual(['combwork.1.log', 'combwork.log'])
    expect(readFileSync(join(dir, 'combwork.log'), 'utf8')).toBe('now')
    expect(readFileSync(join(dir, 'combwork.1.log'), 'utf8')).toBe('before')
  })

  it("one whose new name is taken stays where it is, byte for byte; a fresh folder has nothing", () => {
    const dir = join(base, `logs${++n}`)
    mkdirSync(dir)
    writeFileSync(join(dir, 'hive.log'), 'old')
    writeFileSync(join(dir, 'combwork.log'), 'new')
    moveOldLogs(dir)
    expect(readFileSync(join(dir, 'hive.log'), 'utf8')).toBe('old')
    expect(readFileSync(join(dir, 'combwork.log'), 'utf8')).toBe('new')
    const fresh = join(base, `logs${++n}`)
    mkdirSync(fresh)
    moveOldLogs(fresh)
    expect(readdirSync(fresh)).toEqual([])
  })
})
