// None's deliverables port (HI-3489): its NoneAdapter, its manifests' diff and its reads off main's thread
// (noneBaseline.ts), found through deliverablesPorts.ts.

import type { DeliverablesPort } from '../deliverables'
import { NoneAdapter } from './none'
import { readBaseline, readCheckPoint } from './noneBaseline'

export const noneDeliverables: DeliverablesPort = {
  of: (project, excluded) => new NoneAdapter(project, excluded),
  diff: (before, after) => NoneAdapter.diff(before, after),
  readWhole: (d, signal) => readBaseline(d, signal),
  readPoint: (d, paths, snapshot) => readCheckPoint({ project: d.project, excluded: d.excludedNames, caseless: d.caseless, paths, snapshot })
}
