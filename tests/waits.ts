// HI-3378: a unit test's waits for a condition, bounded by a name from the tests' one timing file (tests/timing.json):
// vi.waitFor and expect.poll's options, the bound a generous one for a hung run (wait.hang unless named), the interval
// the file's. A test that checks a narrow result names a budget instead.
import { vi } from 'vitest'
import { timing } from './timing.cjs'

/** vi.waitFor / expect.poll's options for a wait bounded by `name` (tests/timing.json), polling at the file's interval. */
export function waitOptions(name = 'wait.hang'): { timeout: number; interval: number } {
  return { timeout: timing(name), interval: timing('wait.interval') }
}

/** vi.waitFor bounded by `name` (wait.hang by default) at the file's interval. */
export function waitUntil<T>(check: () => T | Promise<T>, name = 'wait.hang'): Promise<T> {
  return vi.waitFor(check, waitOptions(name))
}

export { timing }
