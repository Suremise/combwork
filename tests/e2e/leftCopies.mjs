// Test copies of Hive a run left running (HI-1453): a copy that outlived its suite (its runner killed, its shell ended)
// ran on for 12 h, holding its lane's Agent API port, so no later runner took that lane and nothing ended it. A runner
// ends a suite's copies when the suite ends (run.mjs); this ends, at a run's start, those an earlier run left in the
// lanes no running runner holds: recorded there (lib.cjs) or with their profile there, each by pid and start time,
// never by name (the installed Hive is Hive.exe too).
import { createRequire } from 'module'
import { idleLanes, laneWork } from './lanes.mjs'

const { endCopies } = createRequire(import.meta.url)('./folderProcesses.cjs')

/** Ends what an earlier run left in the idle lanes of `lanesDir`, whose folders are in `work`: { ended, lanes }. */
export async function endLeftCopies(lanesDir, work, { alive, end = endCopies } = {}) {
  const idle = await idleLanes(lanesDir, alive ? { alive } : {})
  const ended = idle.lanes.length ? end(idle.lanes.map((k) => laneWork(work, k)), { before: idle.at }) : 0
  return { ended, lanes: idle.lanes }
}
