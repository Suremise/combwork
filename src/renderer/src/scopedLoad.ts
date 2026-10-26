import { useRef, useState } from 'react'
import { scopedLoads, type Scoped } from '@shared/scoped'

/**
 * Loads for a view, kept per scope (see Scoped in @shared/scoped). `load(scope, fetch, early)` starts one for `scope`,
 * which the caller builds from the same values as `fetch`. Loads are numbered: one that finishes after a newer one
 * started, or after the view moved to another scope, is dropped; `early`, part of the results, shows while it runs
 * (scopedLoads). `data`, `error` and `at` are the current scope's only: data null and no error means loading; data with
 * an error means a failed refresh.
 */
export function useScopedLoad<T>(scope: string) {
  const [state, setState] = useState<Scoped<T>>({ scope, data: null, error: null, at: 0 })
  const current = useRef(scope)
  current.current = scope
  const loader = useRef<ReturnType<typeof scopedLoads<T>> | null>(null)
  loader.current ??= scopedLoads<T>(setState, () => current.current)
  const mine = state.scope === scope
  return { data: mine ? state.data : null, error: mine ? state.error : null, at: mine ? state.at : 0, load: loader.current }
}
