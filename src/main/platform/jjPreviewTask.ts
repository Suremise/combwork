// The Operations preview's work off main's thread (HI-2800; HR2's round 3): the verified capture's prints and the final
// answer, run by jj's worker (jjWorker.ts), or here where there is no worker (unit tests). No process, no Electron.
//
// The final answer is one synchronous task: the preview worked out (previewOf), then the print of every source taken
// again and compared with the one the capture began with. Nothing is awaited between that check and the answer it
// carries; main only relays it. That is enough here because the preview writes nothing and the user acts later, if at
// all: no write follows the check, as one did J5's compare-and-set (the Assistant's note on HI-2800).

import { previewOf, type OpPreviewCore, type OpPreviewInput } from './jjOpView'
import { sourcesPrintWithin, type PrintBounds, type PrintSources } from './jjSourcesPrint'

/** The Operations print's bounds: its trees' files and folders, and the bytes it reads in all. Past any: no command. */
export const OPERATIONS_PRINT_BOUNDS: PrintBounds = { files: 20_000, dirs: 2_000, bytes: 16 * 1024 * 1024 }

/** The fence a preview's answer is checked against: the sources and the print the capture began with. */
export interface OpFence {
  sources: PrintSources
  print: string
}

/** A preview's answer: its core, and whether the print at its end is still the capture's (`held`), another, or past a bound. */
export interface OpPreviewAnswer {
  core: OpPreviewCore
  fence: 'held' | 'moved' | 'over' | 'unreadable'
}

/** One print of the Operations sources within their bounds. */
export const printTask = (sources: PrintSources): string | 'over' | undefined => sourcesPrintWithin(sources, OPERATIONS_PRINT_BOUNDS)

/** The final answer: the preview, then the print again, in one synchronous task. */
export function previewTask(input: OpPreviewInput, fence: OpFence): OpPreviewAnswer {
  const core = previewOf(input)
  const now = printTask(fence.sources)
  return { core, fence: now === undefined ? 'unreadable' : now === 'over' ? 'over' : now === fence.print ? 'held' : 'moved' }
}
