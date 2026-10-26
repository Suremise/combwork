// What a load of src/main/logger.ts listens to on the process (HI-1728): its exit (flushLogs) and the console's
// streams' errors (HI-1684). A run loads one logger; a test that loads it again with vi.resetModules adds them again
// each time, and they pile up past Node's limit of 10 (MaxListenersExceededWarning). These take off what a test added,
// keeping what was there before it.
import { afterEach, beforeEach } from 'vitest'

type Owned = [NodeJS.EventEmitter, string]
const owned = (): Owned[] => [
  [process, 'exit'],
  [process.stdout, 'error'],
  [process.stderr, 'error']
]

/** Notes the listeners there now; the function it returns removes those added since. */
export function listenersNow(): () => void {
  const before = owned().map(([e, name]) => [e, name, e.listeners(name)] as const)
  return () => {
    for (const [e, name, had] of before) for (const l of e.listeners(name)) if (!had.includes(l)) e.removeListener(name, l as (...a: unknown[]) => void)
  }
}

/** Each test of this file leaves the logger's listeners as it found them. */
export function dropLoggerListenersAfterEach(): void {
  let drop: (() => void) | null = null
  beforeEach(() => {
    drop = listenersNow()
  })
  afterEach(() => {
    drop?.()
    drop = null
  })
}

/** How many there are now, to check a file left none behind. */
export const loggerListenerCounts = (): number[] => owned().map(([e, name]) => e.listenerCount(name))
