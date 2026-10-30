// Removes the unit run's own temp folder once the run has ended (#995): tests/runTemp.mts made it, in the test area,
// before the workers started. What Hive's code under test wrote after a test file's own clean-up (tests/tempCleanup.ts)
// goes with it. A run inside a test (its parent's folder) leaves it to the parent.
import { endRunTemp } from './tempDir'

export default function setup(): () => void {
  return () => {
    const failed = endRunTemp()
    if (failed) console.warn(`The run's temp folder was left behind (npm run test:clean sweeps it after a day): ${failed}`)
  }
}
