// Removes the unit run's own temp folder once the run has ended (#995): tests/runTemp.mts made it, in the test area,
// before the workers started. What Combwork's code under test wrote after a test file's own clean-up (tests/tempCleanup.ts)
// goes with it. A run inside a test (its parent's folder) leaves it to the parent.
// HI-3447: first, the Git Bash /tmp keeper startRunTemp started has started, before any worker can start Git Bash
// (vitest.config.ts can't await: Vitest builds it as CommonJS). One that didn't start throws here, and Vitest starts no
// worker (HR1's round 1).
import { endRunTemp, msysTempKept } from './runTemp.mts'

export default async function setup(): Promise<() => void> {
  await msysTempKept()
  return () => {
    const failed = endRunTemp()
    if (failed) console.warn(`The run's temp folder was left behind (npm run test:clean sweeps it after a day): ${failed}`)
  }
}
