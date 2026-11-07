// Codex's unelevated sandbox can refuse a shell launch when two runners use one test home (#478). Hold one slot
// for the whole real suite/run, across worktrees; a separate home has a separate slot. Since HI-2606 this is the Codex
// side of testHomeLock.mjs (both CLI test homes' leases, reentrant within a run's tree, taken in one order).
import { join } from 'path'
import { createRequire } from 'module'
import { acquireTestHome, homeLockDir, waitForTestHome } from './testHomeLock.mjs'

const ctx = createRequire(import.meta.url)('./runContext.cjs')

export function codexLockDir(home, poolRoot = join(ctx.TEST_ROOT, 'codex-home-locks')) {
  return homeLockDir('codex', home, poolRoot)
}

/** Real Codex suites, and a suite explicitly naming the shared home (skills), use the same lease. */
export const usesCodexHome = (suite) => suite.needs?.includes('codex') || suite.codexHome === 'test'

export function acquireCodexHome(home, options = {}) {
  return acquireTestHome('codex', home, options)
}

export function waitForCodexHome(home, options) {
  return waitForTestHome('codex', home, options)
}
