// Version control's own folders (HI-2800): Git's `.git`. Each is hidden in the Files tab, skipped by search and the
// watchers, never a document or a deliverable, and never a project write, whatever the project's platform.

/** The version controls' own folders, at a project's root. */
export const METADATA_DIRS: readonly string[] = ['.git']

/** Whether a project-relative path (`/` or `\`) is a platform's own folder or inside one; `anyCase` folds case (Windows). */
export function inMetadataDir(rel: string, anyCase = false): boolean {
  const first = rel.split(/[\\/]/)[0] ?? ''
  const name = anyCase ? first.toLowerCase() : first
  return METADATA_DIRS.includes(name)
}
