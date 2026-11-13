// Files jj doesn't track (HI-3096): with the user's `snapshot.auto-track` narrowed (`none()`, say: jj's own setting for
// adding files by hand), a new file is on disk and in no commit, and jj's snapshot says nothing about it. Darren's
// decision on HI-3096 (12 Nov, option (a)): such a file is a slot's uncommitted work, as Git's untracked file is, so a
// slot holding one is never clean, never lent to the next card and never removed with it.
//
// The pinned jj (0.47.1) lists them in `jj status`, after the working copy's changes:
//   Untracked paths:
//   ? new-work.txt
//   ? sub\
// one line each, a folder whose files are all untracked shown once with a trailing separator, paths as jj shows them
// (backslashes on Windows). A line of the block in another shape still counts: its text is taken as the path, so an
// unknown form never reads as clean.

const HEADER = /^Untracked paths:\s*$/

/** The paths `jj status` lists as untracked (its "Untracked paths" block), as jj shows them; none: []. */
export function untrackedPaths(status: string): string[] {
  const lines = status.split(/\r?\n/)
  const at = lines.findIndex((l) => HEADER.test(l))
  if (at < 0) return []
  const out: string[] = []
  for (const l of lines.slice(at + 1)) {
    const m = /^\?\s+(.+?)\s*$/.exec(l)
    if (!m) break
    out.push(m[1])
  }
  // A header with no line jj could have meant (an unknown form): still not clean.
  return out.length ? out : ['(untracked paths)'] // i18n-ignore: a protocol detail, never shown as such
}
