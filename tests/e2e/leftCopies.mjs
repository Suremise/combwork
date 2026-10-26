// Test copies of Hive a run left running (HI-1453): a copy that outlived its suite (its runner killed, its shell ended)
// ran on for 12 h, holding its lane's Agent API port, so no later runner took that lane and nothing ended it. A runner
// ends a suite's copies when the suite ends (run.mjs); this ends, at a run's start, those an earlier run recorded
// (lib.cjs) in the lanes no running runner holds, each only while it is still the process recorded (pid and start time).
// Nothing is ended without a record: what only looks like a copy is listed for a person to look at.
import { createRequire } from 'module'
import { idleLanes, laneWork } from './lanes.mjs'

const { endCopies } = createRequire(import.meta.url)('./folderProcesses.cjs')

/** Ends what an earlier run recorded in the idle lanes of `lanesDir`, whose folders are in `work`: { ended, unrecorded, lanes }. */
export async function endLeftCopies(lanesDir, work, { alive, end = endCopies } = {}) {
  const idle = await idleLanes(lanesDir, alive ? { alive } : {})
  const got = idle.lanes.length ? end(idle.lanes.map((k) => laneWork(work, k)), { before: idle.at }) : { ended: 0, unrecorded: [] }
  return { ...got, lanes: idle.lanes }
}
