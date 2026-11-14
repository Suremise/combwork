// A moved submodule in Combwork's diffs (HI-2864, design HI-2864/s10): what each side of a path is, read from git's
// modes (160000 is a gitlink), never from a read that failed. Pure: main reads git's output and passes it in; the
// renderer shows the row from the result.

/** One side of a changed path: a submodule's commit, a file, a symbolic link, or nothing there. */
export type GitlinkSide = { kind: 'gitlink'; commit: string } | { kind: 'file' } | { kind: 'link' } | { kind: 'none' }

/** A change where at least one side is a gitlink. `dirty`: the working tree's checkout has changes of its own. */
export interface GitlinkChange {
  from: GitlinkSide
  to: GitlinkSide
  dirty?: boolean
}

/** One row of `git diff --raw -z --no-abbrev --no-renames`: both modes and ids as git wrote them, zeros included. */
export interface RawRow {
  oldMode: string
  newMode: string
  oldId: string
  newId: string
  status: string
  path: string
}

export const GITLINK_MODE = '160000'
const ZERO = /^0+$/

/** `git diff --raw -z --no-abbrev --no-renames` output as rows; null when any part isn't that (never a partial list). */
export function parseRawRows(out: string): RawRow[] | null {
  const parts = out.split('\0')
  const rows: RawRow[] = []
  for (let i = 0; i < parts.length; ) {
    const head = parts[i]
    if (!head) {
      // Only the empty piece after the last NUL (or an empty output) is allowed.
      if (i === parts.length - 1) break
      return null
    }
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([A-Z])$/.exec(head)
    const path = parts[i + 1]
    if (!m || !path) return null
    rows.push({ oldMode: m[1], newMode: m[2], oldId: m[3], newId: m[4], status: m[5], path })
    i += 2
  }
  return rows
}

/**
 * What a mode and id say a side is. A gitlink's id is its commit; a file's or link's id is never named. A folder (a
 * tree, 040000: a gitlink replaced by files under its path) has nothing at the path itself: none.
 */
export function sideOf(mode: string, id: string): GitlinkSide {
  if (ZERO.test(mode) || mode === '040000') return { kind: 'none' }
  if (mode === GITLINK_MODE) return { kind: 'gitlink', commit: id }
  if (mode === '120000') return { kind: 'link' }
  return { kind: 'file' }
}

/** A raw row's gitlink change, or null when neither side is a gitlink. */
export function gitlinkOf(row: RawRow): GitlinkChange | null {
  if (row.oldMode !== GITLINK_MODE && row.newMode !== GITLINK_MODE) return null
  return { from: sideOf(row.oldMode, row.oldId), to: sideOf(row.newMode, row.newId) }
}

/** Whether a gitlink side's commit is still unknown: the working tree's id, which raw gives as zeros once the checkout moved. */
export function unresolved(side: GitlinkSide): boolean {
  return side.kind === 'gitlink' && ZERO.test(side.commit)
}

/** The line git writes for a gitlink side in a patch (its own representation, shown when the row is expanded). */
export function subprojectLine(commit: string, dirty = false): string {
  return `Subproject commit ${commit}${dirty ? '-dirty' : ''}\n` // i18n-ignore: git's own line, exactly as git writes it
}

/**
 * The working tree's side of one path's patch (`git diff --submodule=short <ref> -- <path>`): the commit and whether it
 * is dirty, from the `+Subproject commit` line of its gitlink section only (`new file mode 160000`, or an `index` line
 * ending in 160000). A type change has two sections; the other one's lines are never read. Null when there isn't exactly
 * one such line, so a doubtful read is an error, never a guessed id.
 *
 * `bothGitlinks` (HR3's round 1): raw's modes already say both sides are gitlinks, so the patch is one section, the
 * gitlink's, and it is taken as such even without a header: a checkout dirty at the index's commit gets no `index` line
 * from git (`-Subproject commit A`, `+Subproject commit A-dirty`). Only exactly one section is; more is doubtful (null).
 */
export function parseSubprojectPatch(patch: string, bothGitlinks = false): { commit: string; dirty: boolean } | null {
  const found: { commit: string; dirty: boolean }[] = []
  const lines = patch.split(/\r?\n/)
  if (bothGitlinks && lines.filter((l) => l.startsWith('diff --git ')).length !== 1) return null
  let gitlink = false
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      gitlink = bothGitlinks
      continue
    }
    if (/^(new file mode|new mode) 160000$/.test(line) || /^index [0-9a-f]+\.\.[0-9a-f]+ 160000$/.test(line)) gitlink = true
    if (!gitlink) continue
    const m = /^\+Subproject commit ([0-9a-f]{40}|[0-9a-f]{64})(-dirty)?$/.exec(line)
    if (m) found.push({ commit: m[1], dirty: !!m[2] })
  }
  return found.length === 1 ? found[0] : null
}

/** A commit's short form, as the row shows it (the full id is in its tooltip). */
export const shortCommit = (commit: string): string => commit.slice(0, 7)
