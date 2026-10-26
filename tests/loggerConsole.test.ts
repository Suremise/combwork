// A dev or test build whose stdout or stderr is closed (HI-1684: a probe's output piped into `head`): the console write
// threw EPIPE, an uncaught error the exit log logged, whose console write threw again, 6,595 times in seconds. The
// console goes quiet after the first, and the file log keeps every line.
import { readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { app } from 'electron'

const epipe = (): Error => Object.assign(new Error('EPIPE: broken pipe, write'), { code: 'EPIPE' })
/** The logger as a new run loads it (unpackaged: the stub's app), its console on. */
const load = async () => {
  vi.resetModules()
  return import('../src/main/logger')
}
/** How many of the log file's lines carry this marker. */
const inFile = (marker: string): number => {
  try {
    return readFileSync(join(app.getPath('userData'), 'logs', 'hive.log'), 'utf8').split('\n').filter((l) => l.includes(marker)).length
  } catch {
    return 0
  }
}

describe("the log's console copy once the console is closed (HI-1684)", () => {
  afterEach(() => vi.restoreAllMocks())

  it('a console write that throws EPIPE is the last one: nothing is thrown, and the file has every line', async () => {
    const { createLogger } = await load()
    const log = createLogger('exit')
    const toConsole = vi.spyOn(console, 'error').mockImplementation(() => {
      throw epipe()
    })
    const marker = `closed-console-${Date.now()}`
    // As the exit log does with an uncaught error: each one logged, three times over.
    for (let i = 0; i < 3; i++) expect(() => log.error(`uncaughtException ${marker}`, epipe())).not.toThrow()
    expect(toConsole).toHaveBeenCalledTimes(1)
    expect(inFile(marker)).toBe(3)
  })

  it('a closed stream reporting EPIPE as an error is caught, and the console is no longer written to', async () => {
    const { createLogger } = await load()
    const log = createLogger('test')
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    log.info('before the pipe closed')
    expect(out).toHaveBeenCalledTimes(1)
    // A stream's error with no listener would be an uncaught exception; the logger listens.
    expect(() => process.stdout.emit('error', epipe())).not.toThrow()
    const marker = `after-close-${Date.now()}`
    log.info(marker)
    expect(out).toHaveBeenCalledTimes(1)
    expect(inFile(marker)).toBe(1)
  })
})
