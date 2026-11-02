// HI-1368: every write to a workspace's databases that can be under way as it closes is counted (dbWrites), so its close
// command waits for it. Each place in main that takes the board's lock or a lease on its database is listed here with
// how it is counted, by the function it is in: a new one fails until it is counted and listed (HR6's s30 answer: each
// entry checked, not only found). And the count itself: begun, ended once, matched by the workspace's real place.
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import { describe, expect, it } from 'vitest'
import { beginWrite, countedWrite, onWriteEnded, writesAt } from '../src/main/dbWrites'

/** Each function taking the board's lock or a lease, and how its write is counted. */
const COUNTED: Record<string, string> = {
  'boardStore.ts boardWriteLocked': 'boardWrite counts it (countedWrite) before its wait for the lock',
  'boardStore.ts upgradeBoard': 'countedWrite around its lock',
  'boardStore.ts restoreBoardBackup': 'countedWrite around its lock',
  'boardStore.ts withLeasedDb': 'its lease (leaseDb counts each lease until it is released)',
  'deliveries.ts leftOnLease': 'its lease (withLeasedDb), taken before the lock',
  'sessionStore.ts changeSessions': 'its lease (withLeasedDb), taken before its save waits for the lock',
  'sessionStore.ts changeSessionRecord': 'its lease (withLeasedDb), taken before its write waits for the lock',
  'storeRows.ts withStoreLock': 'beginWrite before its wait for the lock',
  'storeRows.ts saveTableLocked': 'saveTable counts it (countedWrite) before its wait for the lock',
  'storeRows.ts openTable': 'countedWrite around its lock',
  'storeTables.ts saveTableLocked': 'saveTable counts it (countedWrite) before its wait for the lock',
  'storeTables.ts openTable': 'countedWrite around its lock'
}

const MAIN = join(__dirname, '..', 'src', 'main')
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? files(p) : n.endsWith('.ts') ? [p] : []
  })
}

describe('every write entry is counted', () => {
  it('each place taking the board lock or a lease is in a function listed as counted', () => {
    const found = new Set<string>()
    for (const file of files(MAIN)) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/)
      let fn = ''
      for (const line of lines) {
        const decl = /^(?:export )?(?:async )?function\*? (\w+)/.exec(line)
        if (decl) fn = decl[1]
        if (/^\s*(\/\/|\*)/.test(line)) continue
        if (/withFileLock\(boardLock\(|[^.\w]leaseDb\(|withLeasedDb\(/.test(line) && !/^export (async )?function (leaseDb|withLeasedDb)/.test(line)) found.add(`${relative(MAIN, file).replace(/\\/g, '/')} ${fn}`)
      }
    }
    const unlisted = [...found].filter((k) => !(k in COUNTED))
    expect(unlisted).toEqual([])
    // And nothing listed that is no longer there (the list stays the code's).
    expect(Object.keys(COUNTED).filter((k) => !found.has(k))).toEqual([])
  })
})

describe('the count', () => {
  it('begun and ended once, by any spelling of the place, and each end told', async () => {
    const told: number[] = []
    const stop = onWriteEnded(() => told.push(writesAt('d:\\ws\\a', 'D:\\ws\\a')))
    const end = beginWrite('D:\\ws\\a')
    const other = beginWrite('d:/ws/a/')
    expect(writesAt('d:\\ws\\a', 'D:\\ws\\a')).toBe(2)
    end()
    end()
    expect(told).toEqual([1])
    await countedWrite('D:\\ws\\a', async () => expect(writesAt('d:\\ws\\a', 'D:\\WS\\A')).toBe(2))
    other()
    expect(writesAt('d:\\ws\\a', 'D:\\ws\\a')).toBe(0)
    expect(told).toEqual([1, 1, 0])
    stop()
    await expect(countedWrite('D:\\ws\\b', async () => Promise.reject(new Error('disk full')))).rejects.toThrow('disk full')
    expect(writesAt('d:\\ws\\b', 'D:\\ws\\b')).toBe(0)
  })
})
