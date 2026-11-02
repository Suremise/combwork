// A dev or test build whose stdout or stderr is closed (HI-1684: a probe's output piped into `head`): the console write
// threw EPIPE, an uncaught error the exit log logged, whose console write threw again, 6,595 times in seconds. The
// console goes quiet after the first, and the file log keeps every line. A console that fails for another reason (EIO,
// a throw of its own) goes quiet too, and the file says why each time (HR3, round 1: no error hidden).
import { readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { app } from 'electron'

const failure = (code: string, message: string): Error => Object.assign(new Error(message), { code })
const epipe = (): Error => failure('EPIPE', 'EPIPE: broken pipe, write')
/** The streams' error listeners each load added, taken off after its test: one logger listens at a time, as in a run. */
const added: [NodeJS.WriteStream, (...a: unknown[]) => void][] = []
/** The logger as a new run loads it (unpackaged: the stub's app), its console on. */
const load = async () => {
  vi.resetModules()
  const before = new Map([process.stdout, process.stderr].map((s) => [s, s.listeners('error')]))
  const logger = await import('../src/main/logger')
  for (const [s, had] of before) for (const l of s.listeners('error')) if (!had.includes(l)) added.push([s, l as (...a: unknown[]) => void])
  return logger
}
/** The log file's lines that carry this text. */
const inFile = (text: string): string[] => {
  try {
    return readFileSync(join(app.getPath('userData'), 'logs', 'hive.log'), 'utf8').split('\n').filter((l) => l.includes(text))
  } catch {
    return []
  }
}

describe("the log's console copy once the console fails (HI-1684)", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    for (const [s, l] of added.splice(0)) s.off('error', l)
  })

  it('a console write that throws EPIPE is the last one: nothing is thrown, the file has every line, and says so once', async () => {
    const { createLogger } = await load()
    const log = createLogger('exit')
    const toConsole = vi.spyOn(console, 'error').mockImplementation(() => {
      throw epipe()
    })
    const closedBefore = inFile("The console's stderr is closed (EPIPE)").length
    const marker = `closed-console-${Date.now()}`
    // As the exit log does with an uncaught error: each one logged, three times over.
    for (let i = 0; i < 3; i++) expect(() => log.error(`uncaughtException ${marker}`, epipe())).not.toThrow()
    expect(toConsole).toHaveBeenCalledTimes(1)
    expect(inFile(marker)).toHaveLength(3)
    expect(inFile("The console's stderr is closed (EPIPE)")).toHaveLength(closedBefore + 1)
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
    expect(inFile(marker)).toHaveLength(1)
  })

  it('another error its stream reports (EIO) is in the file with its stack, and the console is no longer written to', async () => {
    const { createLogger } = await load()
    const log = createLogger('test')
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const message = `unexpected-stdout-EIO-${Date.now()}`
    expect(() => process.stdout.emit('error', failure('EIO', message))).not.toThrow()
    const said = inFile(message)
    expect(said).toHaveLength(1)
    expect(said[0]).toMatch(/\[ERROR\] \[logger\] The console's stdout failed, so log lines go to this file only from now: Error: unexpected-stdout-EIO-/)
    const marker = `after-eio-${Date.now()}`
    log.info(marker)
    expect(out).not.toHaveBeenCalled()
    expect(inFile(marker)).toHaveLength(1)
  })

  it('a console that throws something else keeps the line it was writing, and the file says why', async () => {
    const { createLogger } = await load()
    const log = createLogger('test')
    const message = `console-broke-${Date.now()}`
    const out = vi.spyOn(console, 'log').mockImplementation(() => {
      throw new TypeError(message)
    })
    const marker = `the-line-${Date.now()}`
    expect(() => log.info(marker)).not.toThrow()
    expect(inFile(marker)).toHaveLength(1)
    const said = inFile(message)
    expect(said).toHaveLength(1)
    expect(said[0]).toMatch(/\[ERROR\] \[logger\] The console's stdout failed, so log lines go to this file only from now: TypeError: console-broke-/)
    // Not tried again.
    log.info(`${marker}-2`)
    expect(out).toHaveBeenCalledTimes(1)
    expect(inFile(`${marker}-2`)).toHaveLength(1)
  })
})
