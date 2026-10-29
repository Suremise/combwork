// A full unit run is a heavy run (#599): it waits for a test slot as a full e2e set does (tests/e2e/slots.mjs), so at most
// a few heavy runs go at once on the machine. The whole set's workers, and what its tests start, beside e2e runs ran
// Windows short (0xc0000142: a process failing as it starts). A focused run (some files, -t, --changed, --related) or
// watch mode stays light, as does a run started inside one that holds a CPU slot for it, an e2e suite say (its parent's
// slot counts it, #211; slots.mjs heldCredit). A pre-merge run (its agent holds the merge slot) goes first. The slot is
// let go when the run ends.
import { createRequire } from 'module'
import { join } from 'path'
import type { TestProject } from 'vitest/node'
import { slotWaitProgress } from './progressReport.mts'
// @ts-expect-error: plain .mjs modules without types
import { heldCredit, isFullUnitRun, preMerge, waitForSlot, waitLine, waitSummary } from './e2e/slots.mjs'

const runContext = createRequire(import.meta.url)('./e2e/runContext.cjs')

export default async function setup(project: TestProject): Promise<(() => void) | undefined> {
  const args = process.argv.slice(2)
  const c = project.config
  // A run inside one that holds a CPU slot for it is covered by that one (HI-2070: inside a model trial, it isn't).
  if (heldCredit().has('cpu') || !isFullUnitRun({ args, watch: c.watch, changed: c.changed, related: c.related, testNamePattern: c.testNamePattern })) return undefined
  const queue = slotWaitProgress('unit tests', `npx vitest ${args.join(' ')}`.trim(), args)
  let said = ''
  const got = await waitForSlot(runContext.HEAVY_DIR, {
    what: 'unit tests: the full set',
    root: join(__dirname, '..'),
    first: preMerge(false),
    onWait: (look: { holders: { at: number }[] }) => {
      const line = waitLine(look)
      if (line !== said) console.log(line)
      said = line
      queue.waitingAs(waitSummary(look))
    }
  })
  if (said) {
    const after = `${Math.round(got.waitedMs / 1000)} s`
    console.log(`Got a test slot after ${after}.`)
    await queue.finish(`got a test slot after ${after}`)
  }
  return () => got.release()
}
