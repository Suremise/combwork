import { readdirSync, readFileSync, statSync } from 'original-fs'
import { join } from 'path'
import { parentPort } from 'worker_threads'
import { compileGuard, matchGuards, parseAddedLines, previewGuard, type GuardPreview, type GuardProblem, type GuardReport, type MergeGuard } from '../../shared/workflow/mergeGuards'

/**
 * The merge guards' worker (HI-3284, design HI-3284/s16): a user's patterns are run only here, never on main's thread,
 * where a pattern that backtracks would hold every keystroke. One worker per check, ended by its caller when the check
 * ends, runs past its time limit or is cancelled (mergeGuardsRun.ts), so a runaway pattern takes nothing with it. It
 * tells its caller which guard it starts on, so a time limit can name the guard that was running. No Electron here (a
 * worker can't load it).
 */

/**
 * A preview (Darren's decision, 15 Nov): one guard over the project's files as they are on disk, `files` the paths to
 * read (its version control's, tracked and not ignored) or, with none, a walk of `root` leaving out `skipDirs` and every
 * dot folder; at most `maxFiles` files and `maxBytes` of text, each file at most `maxFile` (a larger one is left out).
 */
export type PreviewRequest = { type: 'preview'; root: string; files: string[] | null; skipDirs: string[]; guard: MergeGuard; maxFiles: number; maxBytes: number; maxFile: number }

export type GuardsRequest = { type: 'check'; diff: string; guards: MergeGuard[]; maxLines: number } | { type: 'empty'; guards: MergeGuard[] } | PreviewRequest

export type GuardsReply = { running: string } | { report: GuardReport } | { problems: GuardProblem[] } | { preview: GuardPreview }

/** The project's files a preview reads: the given ones, or a walk; `null` once past the bound. */
function listFiles(m: PreviewRequest): string[] | null {
  if (m.files) return m.files.length > m.maxFiles ? null : m.files
  const out: string[] = []
  const skip = new Set(m.skipDirs.map((d) => d.toLowerCase()))
  const walk = (rel: string): boolean => {
    for (const e of readdirSync(join(m.root, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || skip.has(e.name.toLowerCase()) || skip.has(p.toLowerCase())) continue
        if (!walk(p)) return false
      } else if (e.isFile()) {
        out.push(p)
        if (out.length > m.maxFiles) return false
      }
    }
    return true
  }
  return walk('') ? out : null
}

/** A preview: the files read one at a time (binary ones, and one past `maxFile`, left out), within the bounds. */
function preview(m: PreviewRequest): GuardPreview {
  const files = listFiles(m)
  if (!files) return { count: 0, hits: [], files: 0, incomplete: 'tooLarge' } // i18n-ignore: a reason's code
  let bytes = 0
  let over = false
  function* texts(): Generator<{ path: string; text: string }> {
    for (const path of files!) {
      let buf: Buffer
      try {
        if (statSync(join(m.root, path)).size > m.maxFile) continue
        buf = readFileSync(join(m.root, path))
      } catch {
        continue
      }
      if (buf.subarray(0, 8192).includes(0)) continue
      bytes += buf.length
      if (bytes > m.maxBytes) {
        over = true
        return
      }
      yield { path, text: buf.toString('utf8') }
    }
  }
  const r = previewGuard(texts(), m.guard)
  return over ? { ...r, incomplete: 'tooLarge' } : r // i18n-ignore: a reason's code
}

/** Runs one request, telling `post` of each guard it starts on; returns its answer. */
export function handleGuards(m: GuardsRequest, post: (r: GuardsReply) => void): GuardsReply {
  if (m.type === 'preview') return { preview: preview(m) }
  if (m.type === 'empty') {
    const problems: GuardProblem[] = []
    m.guards.forEach((g, i) => {
      post({ running: String(i) })
      try {
        if (compileGuard(g).test('')) problems.push({ guard: i, field: 'pattern', why: 'matchesEmpty' }) // i18n-ignore: a problem's code (GUARD_PROBLEMS has its message)
      } catch (e) {
        problems.push({ guard: i, field: 'pattern', why: 'invalid', detail: e instanceof Error ? e.message : String(e) }) // i18n-ignore: a problem's code (GUARD_PROBLEMS has its message)
      }
    })
    return { problems }
  }
  const added = parseAddedLines(m.diff, m.maxLines)
  if ('incomplete' in added) return { report: { hits: [], more: 0, messages: [], incomplete: added.incomplete === 'tooManyLines' ? 'tooLarge' : 'malformed' } } // i18n-ignore: a reason's code
  return { report: matchGuards(added.files, m.guards, (name) => post({ running: name })) }
}

const port = parentPort
if (port) {
  port.on('message', (m: GuardsRequest) => {
    const post = (r: GuardsReply): void => port.postMessage(r)
    post(handleGuards(m, post))
  })
}
