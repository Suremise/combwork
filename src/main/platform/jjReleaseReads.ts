// HI-3148: jj's release reads (releaseReads.ts), every read pinned to one operation (jjReads.ts). Released: a tag named
// exactly `v<line>` or `<line>` whose commit is in the line's bookmark's history, and that bookmark's commit in the default
// line's history (its local `main`, `master` or `trunk` bookmark, as Git's main line is found). A conflicted tag or bookmark, one naming several
// commits, or any read that fails is unknown, never "not released". jj keeps no tag date: none is given.

import { jjContextOf } from './jjDetect'
import { isJjUnknown, JjReads, type JjMaybe, type JjReadUnknown } from './jjReads'
import { jjRunner, type JjRunner } from './jjRunner'
import { singleHead } from './jjView'
import { releaseTagNames, type ReleaseInfo, type ReleaseReads } from './releaseReads'
import { unknown, withDetail, type Maybe } from './types'
import { UNREADABLE as U } from '../../shared/workflow/texts'

const SEP = '\u001f'
/** A tag: its name and the commit it names (empty when conflicted). */
const TAG_T = `name ++ "${SEP}" ++ if(normal_target, normal_target.commit_id(), "") ++ "\\n"`
/** A commit's id and its local bookmarks' names. */
const COMMIT_T = `commit_id ++ "${SEP}" ++ local_bookmarks.map(|b| b.name()).join(",") ++ "\\n"`

const lines = (out: string): string[] => out.split(/\r?\n/).filter(Boolean)
/** A revset naming exactly this string (jj's string pattern, quoted as JSON quotes it). */
const exact = (fn: 'bookmarks' | 'tags', name: string): string => `${fn}(exact:${JSON.stringify(name)})`

/** Release reads through jj `runner` (Combwork's own unless a test gives one). */
export function jjReleaseReadsWith(runner: JjRunner): ReleaseReads {
  /** The line's bookmark at one operation: exactly one commit (true), none (false), or unknown (several: conflicted). */
  async function existsAt(projectPath: string, line: string): Promise<Maybe<boolean>> {
    const what = (u?: JjReadUnknown) => withDetail(unknown(U.line, { branch: line }), u ? (u.detail ?? u.jjUnknown) : undefined)
    const ctx = await jjContextOf(projectPath, runner)
    if (!('jj' in ctx)) return what()
    const reads = new JjReads({ folder: ctx.jj.root, jjRepo: ctx.jj.jjRepo }, runner)
    const pinned = await reads.pinned((op) => reads.run(op, ['log', '--no-graph', '-r', `present(${exact('bookmarks', line)})`, '-T', 'commit_id ++ "\\n"']))
    if (isJjUnknown(pinned)) return what(pinned)
    const n = lines(pinned.value).length
    return n > 1 ? what() : n === 1
  }
  return {
    exists: existsAt,
    // Every read is pinned to one operation: any jj operation since (a tag or bookmark moved, Git's refs imported) moves
    // the single operation head, read from its files; several heads (unsettled) are unknown.
    async watch(projectPath) {
      const ctx = await jjContextOf(projectPath, runner)
      if (!('jj' in ctx)) return null
      const repo = ctx.jj.jjRepo
      return () => singleHead(repo)
    },
    async released(projectPath, line): Promise<Maybe<ReleaseInfo | null>> {
      const what = (u?: JjReadUnknown) => withDetail(unknown(U.line, { branch: line }), u ? (u.detail ?? u.jjUnknown) : undefined)
      const ctx = await jjContextOf(projectPath, runner)
      if (!('jj' in ctx)) return what()
      const reads = new JjReads({ folder: ctx.jj.root, jjRepo: ctx.jj.jjRepo }, runner)
      const pinned = await reads.pinned(async (op): Promise<JjMaybe<ReleaseInfo | null | 'unknown'>> => {
        // The line's bookmark: exactly one commit (none: no such line; several: conflicted, unknown).
        const at = await reads.run(op, ['log', '--no-graph', '-r', exact('bookmarks', line), '-T', COMMIT_T])
        if (isJjUnknown(at)) return at
        const lineAt = lines(at)
        if (lineAt.length === 0) return null
        if (lineAt.length > 1) return 'unknown'
        const head = lineAt[0].split(SEP)[0]
        // jj's default line, as Git's main line is found: the first local bookmark of main, master or trunk there is
        // (jj's trunk() reads remote bookmarks only, so a repository with no remote would have none), never the line.
        let into: string | null = null
        let trunkCommit = ''
        for (const name of ['main', 'master', 'trunk'].filter((n) => n !== line)) {
          const t = await reads.run(op, ['log', '--no-graph', '-r', exact('bookmarks', name), '-T', COMMIT_T])
          if (isJjUnknown(t)) return t
          const trunkAt = lines(t)
          if (trunkAt.length === 0) continue
          if (trunkAt.length > 1) return 'unknown'
          into = name
          trunkCommit = trunkAt[0].split(SEP)[0]
          break
        }
        if (!into) return null
        const tags = await reads.run(op, ['tag', 'list', '-T', TAG_T])
        if (isJjUnknown(tags)) return tags
        // Every line a name has: a conflicted tag is listed more than once, one of them with no commit of its own.
        const byName = new Map<string, string[]>()
        for (const l of lines(tags)) {
          const [name, commit] = l.split(SEP)
          byName.set(name, [...(byName.get(name) ?? []), commit ?? ''])
        }
        for (const name of releaseTagNames(line)) {
          const targets = byName.get(name)
          if (!targets) continue
          // Conflicted: it names no one commit.
          if (targets.length !== 1 || !targets[0]) return 'unknown'
          const commit = targets[0]
          const inLine = await reads.run(op, ['log', '--no-graph', '-r', `${commit} & ::${head}`, '-T', 'commit_id ++ "\\n"'])
          if (isJjUnknown(inLine)) return inLine
          if (!lines(inLine).length) continue
          const merged = await reads.run(op, ['log', '--no-graph', '-r', `${head} & ::${trunkCommit}`, '-T', 'commit_id ++ "\\n"'])
          if (isJjUnknown(merged)) return merged
          return lines(merged).length ? { tag: name, into, date: null } : null
        }
        return null
      })
      if (isJjUnknown(pinned)) return what(pinned)
      return pinned.value === 'unknown' ? what() : pinned.value
    }
  }
}

export const jjReleaseReads: ReleaseReads = jjReleaseReadsWith(jjRunner)
