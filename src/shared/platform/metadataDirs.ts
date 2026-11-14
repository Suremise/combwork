// Every version-control platform's own folder (HI-2800, J7's compatibility): Git's `.git` and jj's `.jj`. Each is hidden
// in the Files tab, skipped by search and the watchers, never a document or a deliverable, and never a project write,
// whatever the project's platform: a `.jj` beside a Git or None project is jj's store all the same (a non-colocated jj
// repository is a None project, SPEC §16.3.5), and its operations write there on every jj command.

/** The platforms' own folders, at a project's root. */
export const METADATA_DIRS: readonly string[] = ['.git', '.jj']

/** Whether a project-relative path (`/` or `\`) is a platform's own folder or inside one; `anyCase` folds case (Windows). */
export function inMetadataDir(rel: string, anyCase = false): boolean {
  const first = rel.split(/[\\/]/)[0] ?? ''
  const name = anyCase ? first.toLowerCase() : first
  return METADATA_DIRS.includes(name)
}
