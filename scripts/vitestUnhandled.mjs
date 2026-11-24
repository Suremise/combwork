// A Vitest reporter for scripts/focusedTests.mjs (HI-3567): writes the run's unhandled errors, each with the test file
// Vitest attributes it to, to the JSON file named by CW_FOCUSED_UNHANDLED, so the runner can fail that file alone
// rather than every file that passed. [{ file: absolute path or null, name, message }]; [] when there were none.
import { mkdirSync, writeFileSync } from 'fs'
import { dirname } from 'path'

export default class UnhandledErrorsReporter {
  onTestRunEnd(_modules, errors) {
    const out = process.env.CW_FOCUSED_UNHANDLED
    if (!out) return
    const rows = (errors ?? []).map((e) => ({ file: typeof e?.VITEST_TEST_PATH === 'string' ? e.VITEST_TEST_PATH : null, name: String(e?.name ?? 'Error'), message: String(e?.message ?? '').split('\n')[0] }))
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, `${JSON.stringify(rows)}\n`)
  }
}
