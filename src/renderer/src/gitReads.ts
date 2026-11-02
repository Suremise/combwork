/** A Git read's answer as the Git tab and status bar show it: whose it is, and whether a read is under way. */
export type GitReadState<T> = { for: string; data: T | null; error: string | null; loading: boolean; at: number }

/**
 * The reads of useGitRead (views/GitTab.tsx): `reload(path)` reads the project at `path` and `update` gets each change
 * of state. One read at a time: those asked while one is under way for the same project are one more after it, with no
 * state set when asked (#1366: as agents' sessions end, a usage change each set state in the hook's effect, and fifty
 * in a row was React's update loop, error #185). A read for another project starts at once; the earlier one's answer
 * is then dropped.
 */
export function gitReader<T>(read: (path: string) => Promise<T>, update: (change: (s: GitReadState<T>) => GitReadState<T>) => void, errorText: (e: unknown) => string): (path: string) => void {
  let loads = 0
  /** The read under way, and whether another was asked for meanwhile. */
  let running: { path: string; again: boolean } | null = null
  const reload = (path: string): void => {
    if (running?.path === path) {
      running.again = true
      return
    }
    const n = ++loads
    running = { path, again: false }
    update((s) => (s.for === path ? (s.loading ? s : { ...s, loading: true }) : { for: path, data: null, error: null, loading: true, at: 0 }))
    const settled = (): void => {
      if (n !== loads) return
      const again = running?.again
      running = null
      if (again) reload(path)
    }
    void read(path).then(
      (data) => {
        if (n === loads) update(() => ({ for: path, data, error: null, loading: false, at: Date.now() }))
        settled()
      },
      (e) => {
        if (n === loads) update((s) => ({ ...s, for: path, error: errorText(e), loading: false }))
        settled()
      }
    )
  }
  return reload
}
