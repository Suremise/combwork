/**
 * What a view loaded, kept with the scope it was loaded for: a project, a workspace, a search. A view shows results and
 * errors only for its current scope, so after a switch it never shows (or edits) another scope's results as its own:
 * a new scope starts as loading. A refresh of the same scope that fails keeps the last results (stale, with when they
 * are from) beside the error. The renderer's useScopedLoad keeps one of these per view.
 */
export interface Scoped<T> {
  scope: string
  data: T | null
  error: string | null
  /** When `data` was loaded (0: never). */
  at: number
}

/** The state after a load for `scope` finished with `r`. */
export function settle<T>(prev: Scoped<T>, scope: string, r: { data: T } | { error: string }, now: number): Scoped<T> {
  if ('data' in r) return { scope, data: r.data, error: null, at: now }
  // The same scope keeps what it had; another scope has nothing of its own yet.
  return prev.scope === scope ? { ...prev, error: r.error } : { scope, data: null, error: r.error, at: 0 }
}

/**
 * A view's numbered loads (useScopedLoad's, apart from React): `load(scope, loader, early)` starts one for `scope`. A load
 * that finishes after a newer one started, or after the view moved to another scope (`current()`), is dropped. `early`
 * (HI-1681): part of the results, shown while the load runs (Hive's own sessions before the rest): taken only until the
 * load has finished and while it is the newest, and its failure is ignored, so the load alone says how it ended, its
 * time limit included.
 */
export function scopedLoads<T>(set: (next: (prev: Scoped<T>) => Scoped<T>) => void, current: () => string, now: () => number = Date.now): (asked: string, loader: () => Promise<T>, early?: Promise<T>) => void {
  let loads = 0
  return (asked, loader, early) => {
    const n = ++loads
    let finished = false
    const mine = (): boolean => n === loads && asked === current()
    const done = (r: { data: T } | { error: string }): void => {
      finished = true
      if (mine()) set((prev) => settle(prev, asked, r, now()))
    }
    early?.then(
      (data) => {
        if (!finished && mine()) set(() => ({ scope: asked, data, error: null, at: now() }))
      },
      () => undefined
    )
    let p: Promise<T>
    try {
      p = loader()
    } catch (e) {
      p = Promise.reject(e)
    }
    p.then(
      (data) => done({ data }),
      (e) => done({ error: e instanceof Error ? e.message : String(e) })
    )
  }
}
