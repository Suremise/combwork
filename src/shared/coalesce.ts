// Reads the window repeats as things change (#1629): never two of the same at once. Two shapes:
// - coalesced(): per key, one call in flight; callers asking meanwhile share one more call, started once it settles, so
//   each gets data read after it asked.
// - serialReads(): one read at a time for a source whose scope can change (the window's workspace); asked meanwhile,
//   the newest scope is read once the current read settles, and a result is taken only when it is still the newest
//   ask's scope and no newer read of that scope has been taken.

/** A function that calls `fetch` for a key, one call in flight per key, as above. */
export function coalesced<T>(): (key: string, fetch: () => Promise<T>) => Promise<T> {
  const slots = new Map<string, { running: Promise<T>; queued: Promise<T> | null }>()
  const start = (key: string, fetch: () => Promise<T>): Promise<T> => {
    let p: Promise<T>
    try {
      p = fetch()
    } catch (e) {
      p = Promise.reject(e)
    }
    const slot = slots.get(key)
    if (slot) {
      slot.running = p
      slot.queued = null
    } else slots.set(key, { running: p, queued: null })
    const end = (): void => {
      const s = slots.get(key)
      if (s && s.running === p && !s.queued) slots.delete(key)
    }
    p.then(end, end)
    return p
  }
  return (key, fetch) => {
    const slot = slots.get(key)
    if (!slot) return start(key, fetch)
    if (slot.queued) return slot.queued
    const after = slot.running.then(
      () => undefined,
      () => undefined
    )
    slot.queued = after.then(() => start(key, fetch))
    return slot.queued
  }
}

/**
 * One read at a time of a source whose scope can change. `ask(scope)` reads it (at once, or after the read under way,
 * for the newest scope asked); `take(scope, data)` gets a result only while its scope is the newest asked, and each
 * read's result in the order read. A failed read takes nothing.
 */
export function serialReads<T>(fetch: (scope: string) => Promise<T>, take: (scope: string, data: T) => void): { ask: (scope: string) => void } {
  let asked: string | null = null
  let reading = false
  let pending: string | null = null
  const read = (scope: string): void => {
    reading = true
    pending = null
    const settle = (r: { data: T } | null): void => {
      reading = false
      // Only for the scope asked last: a read for one the window has left is dropped.
      if (r && asked === scope) take(scope, r.data)
      if (pending !== null) read(pending)
    }
    let p: Promise<T>
    try {
      p = fetch(scope)
    } catch (e) {
      p = Promise.reject(e)
    }
    p.then(
      (data) => settle({ data }),
      () => settle(null)
    )
  }
  return {
    ask(scope: string): void {
      asked = scope
      if (reading) pending = scope
      else read(scope)
    }
  }
}
