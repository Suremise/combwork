// The synchronous tail of a publish observation (HI-2873's final step, moved here by HI-2882's J9b2, design HI-2882/s22):
// the validator's synchronous reads (the operation heads, the target's Git ref from the files, the sources' print) and,
// only if they still match what the observation decided on, the re-check's sweep and flags and the owed rows' settles,
// each a compare-and-set on the store. Pure: no process, no Electron, no logger, so a worker thread runs it inside its
// own database transaction (jjPublishWorker.ts) and `observePublish` runs it in its own continuation (jjIntegration.ts).

import { readFileSync } from 'original-fs'
import { join } from 'path'
import { rawSourcesPrint } from './jjSourcesPrint'
import { readOpHeads } from './jjView'
import type { ConfigSources, JjObligation, ObligationKey, ObligationStore, PublishDiffer, PublishObserved, RecheckPlan } from './jjIntegration'
import type { JjReadUnknown } from './jjReads'

const lines = (s: string): string[] => s.split(/\r?\n/).filter((l) => l.trim() !== '')
const moved = (detail: string): JjReadUnknown => ({ jjUnknown: 'moved', detail })

/**
 * A ref's commit read synchronously from the store's files (no process, so nothing can move between it and a synchronous
 * write after it): the loose ref, else its packed line; null when it is in neither; undefined when it can't be read.
 */
export function refFromFiles(store: string, ref: string): string | null | undefined {
  const read = (f: string): string | null | undefined => {
    try {
      return readFileSync(join(store, f), 'utf8')
    } catch (e) {
      const code = (e as { code?: string }).code
      return code === 'ENOENT' || code === 'ENOTDIR' ? null : undefined
    }
  }
  const loose = read(ref)
  if (loose === undefined) return undefined
  if (loose !== null) {
    const v = loose.trim()
    return /^[0-9a-f]{40}$/.test(v) ? v : undefined
  }
  const packed = read('packed-refs')
  if (packed === undefined) return undefined
  if (packed === null) return null
  for (const l of lines(packed)) {
    const [oid, name] = l.split(' ')
    if (name === ref) return /^[0-9a-f]{40}$/.test(oid) ? oid : undefined
  }
  return null
}

/**
 * A fingerprint of every source the publish decision rests on, read synchronously (no process): jj's operation heads,
 * the store's HEAD (an `onbranch` condition), the target's loose ref and the packed refs, Git's config environment, and
 * the raw bytes of every config file `configSources` found (absent ones as absent). Raw bytes only, never interpreted:
 * any difference between two prints means something changed, whether or not it matters. Undefined when any source can't
 * be read (a read error but "not there").
 */
export function sourcesPrint(store: string, jjRepo: string, target: string, sources: ConfigSources): string | undefined {
  // The verified capture's print, shared with the Operations preview (jjSourcesPrint.ts, HI-2800): these sources, as before.
  return rawSourcesPrint({
    jjRepo,
    env: sources.env,
    files: [{ label: 'HEAD', path: join(store, 'HEAD') }, { label: 'ref', path: join(store, 'refs', 'heads', ...target.split('/')) }, { label: 'packed', path: join(store, 'packed-refs') }, ...sources.files.map((f) => ({ label: `config:${f.toLowerCase()}`, path: f }))] // i18n-ignore: a print's labels, hashed, never shown
  })
}

/**
 * Applies a re-check plan (synchronous; the caller runs it in the same continuation as its final validator): the
 * schedule moved to its next generation by its compare-and-set first, and only if that held, each flag by its own
 * compare-and-set. Any pass applied since this one was planned advanced the generation, so this one then writes nothing
 * of the re-check (HR2's round 1: no ABA through a completed or unchanged schedule).
 */
export function applyRecheck(store: ObligationStore, target: string, plan: RecheckPlan, at: number): { key: ObligationKey; differs: PublishDiffer[] }[] {
  if (!store.setSweep(target, plan.expectedGen, plan.next)) return []
  const flagged: { key: ObligationKey; differs: PublishDiffer[] }[] = []
  for (const { o, check } of plan.flags) {
    const key = { card: o.card, cycle: o.cycle, bundle: o.bundle }
    if (store.flag(key, o.result, check.was, o.at!, { ...check, at })) flagged.push({ key, differs: check.differs })
  }
  return flagged
}

/** What an observation decided and the evidence it decided on: structured-cloneable, for a worker thread. */
export interface PublishTailInput {
  target: string
  view: { jjRepo: string; store: string }
  /** The single operation head and the target's Git ref the observation read. */
  op: string
  gitRef: string | null
  head: string
  /** The config sources and their print the final `still()` captured. */
  sources: ConfigSources
  print: string
  /** Where it checked (`beforeSettle`): in an unknown's detail. */
  where: string
  plan: RecheckPlan
  decided: { o: JjObligation; to: 'published' | 'notHeld' }[]
  remote: string | null
  url: string | null
  pushed: string | null
  /** No remote at all (a verified absence): nothing settled, settled rows still re-checked. */
  absent: boolean
  at: number
}

/**
 * The tail, synchronous: the validator first (the operation heads, the target's ref and the sources' print, read now),
 * then, only if they match, the re-check and the settles. The caller runs it in the continuation (or the database
 * transaction) that commits its writes, with nothing in between.
 */
export function publishTail(store: ObligationStore, t: PublishTailInput): PublishObserved {
  if (readOpHeads(t.view.jjRepo)?.join() !== t.op) return moved(`heads:${t.where}`)
  const refNow = refFromFiles(t.view.store, `refs/heads/${t.target}`)
  if (refNow === undefined || refNow !== t.gitRef) return moved(`ref:${t.where}`)
  if (sourcesPrint(t.view.store, t.view.jjRepo, t.target, t.sources) !== t.print) return moved(`sources:${t.where}`)
  const flagged = applyRecheck(store, t.target, t.plan, t.at)
  if (t.absent) return { noRemote: true, flagged }
  const settled: { key: ObligationKey; to: 'published' | 'notHeld' }[] = []
  const seen = { remote: t.remote!, url: t.url!, pushed: t.pushed, head: t.head, op: t.op, print: t.print, at: t.at }
  for (const { o, to } of t.decided) {
    const key = { card: o.card, cycle: o.cycle, bundle: o.bundle }
    if (store.settle(key, o.result, to, seen)) settled.push({ key, to })
  }
  return { remote: t.remote!, url: t.url!, pushed: t.pushed, settled, flagged }
}
