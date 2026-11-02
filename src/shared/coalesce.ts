// Reads the window repeats as things change (#1629): never two of the same at once.
// - coalesced(): per key, one call in flight; callers asking meanwhile share one more call, started once it settles, so
//   each gets data read after it asked. joined() (HI-1681): callers asking meanwhile share the call in flight.
// - serialReads(): one read at a time for a source whose scope can change (the window's workspace); asked meanwhile,
//   the newest scope is read once the current read settles, and a result is taken only when it is still the newest
//   ask's scope and no newer read of that scope has been taken.
// - oneAtATime(): one load at a time per scope for a view that keeps its own results (#1646); asked meanwhile, once
//   more after it. withinTime(): a load that fails once its time is up, so a view never waits on it without end.
// - latestOnly() and boundedQueue() (#1254): reads that belong to a view's lifetime: only the newest read's result is
//   taken, a few reads at once, and none after the view is hidden or gone (cancel()).

/** A function that calls `load` for a key, one call in flight per key, as above. */
export function coalesced<T>(): (key: string, load: () => Promise<T>) => Promise<T> {
  const slots = new Map<string, { running: Promise<T>; queued: Promise<T> | null }>()
  const start = (key: string, load: () => Promise<T>): Promise<T> => {
    let p: Promise<T>
    try {
      p = load()
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
  return (key, load) => {
    const slot = slots.get(key)
    if (!slot) return start(key, load)
    if (slot.queued) return slot.queued
    const after = slot.running.then(
      () => undefined,
      () => undefined
    )
    slot.queued = after.then(() => start(key, load))
    return slot.queued
  }
}

/**
 * A function that calls `load` for a key, joining the call in flight for it (HI-1681): asked while one runs, a caller
 * gets that call's result, not one more call. For reads whose source changes without telling (a CLI's own session
 * folders), where one more read after the one under way only doubles the wait.
 */
export function joined<T>(): (key: string, load: () => Promise<T>) => Promise<T> {
  const running = new Map<string, Promise<T>>()
  return (key, load) => {
    const now = running.get(key)
    if (now) return now
    let p: Promise<T>
    try {
      p = load()
    } catch (e) {
      p = Promise.reject(e)
    }
    running.set(key, p)
    const end = (): void => {
      if (running.get(key) === p) running.delete(key)
    }
    p.then(end, end)
    return p
  }
}

/**
 * One read at a time of a source whose scope can change. `ask(scope)` reads it (at once, or after the read under way,
 * for the newest scope asked); `take(scope, data)` gets a result only while its scope is the newest asked, and each
 * read's result in the order read. A failed read takes nothing.
 */
export function serialReads<T>(load: (scope: string) => Promise<T>, take: (scope: string, data: T) => void): { ask: (scope: string) => void } {
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
      p = load(scope)
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

/** `p`, or a failure with `error()` once `ms` pass without its answer (#1646): a load shows as failed, with Retry, never as a spinner without end. */
export function withinTime<T>(p: Promise<T>, ms: number, error: () => string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(error())), ms)
  })
  return Promise.race([p, late]).finally(() => clearTimeout(t))
}

/**
 * One load at a time per scope, for a view that asks again as things change (#1646). `run(scope, start, rerun)` calls
 * `start` now, unless a load for that scope is under way: then the last `rerun` asked for it is called once, after
 * that load ends, however many times it was asked meanwhile. Per scope, whatever was asked between (A, then B, then A
 * again while the first A runs starts no second A), so a scope's loads never overlap and never end out of order. With
 * numbered loads (useScopedLoad) a newer load drops the one under way, so loads slower than the changes asking for
 * them never showed anything; one at a time, each is shown. Bounded by the scopes with a load under way.
 */
export function oneAtATime(): { run: (scope: string, start: () => Promise<unknown>, rerun: () => void) => void } {
  const running = new Set<string>()
  const again = new Map<string, () => void>()
  return {
    run(scope, start, rerun) {
      if (running.has(scope)) {
        again.set(scope, rerun)
        return
      }
      running.add(scope)
      const ended = (): void => {
        running.delete(scope)
        const next = again.get(scope)
        again.delete(scope)
        // After whatever took this load's result.
        if (next) setTimeout(next, 0)
      }
      let p: Promise<unknown>
      try {
        p = start()
      } catch (e) {
        p = Promise.reject(e)
      }
      p.then(ended, ended)
    }
  }
}

/**
 * A read repeated for one view: only the newest one started applies its result, and none once cancel() was called
 * (the view hidden, gone, or showing something else). An older read that finishes after a newer one changes nothing.
 */
export function latestOnly(): { run: <T>(read: Promise<T>, apply: (value: T) => void, failed?: (e: unknown) => void) => void; cancel: () => void } {
  let n = 0
  return {
    run(read, apply, failed) {
      const mine = ++n
      read.then(
        (v) => mine === n && apply(v),
        (e) => mine === n && failed?.(e)
      )
    },
    cancel() {
      n++
    }
  }
}

/**
 * Reads for a view, at most `limit` at once, each key once while it is queued or running. cancel() (the view hidden,
 * gone, or showing something else) drops those waiting; those running finish but apply nothing and start no more.
 */
export function boundedQueue(limit: number): { add: <T>(key: string, read: () => Promise<T>, apply: (value: T) => void) => void; cancel: () => void } {
  let gen = 0
  let waiting: { key: string; start: () => void }[] = []
  let running = new Set<string>()
  const next = (): void => {
    while (running.size < limit && waiting.length) waiting.shift()!.start()
  }
  return {
    add(key, read, apply) {
      if (running.has(key) || waiting.some((w) => w.key === key)) return
      const mine = gen
      waiting.push({
        key,
        start: () => {
          const now = running
          now.add(key)
          const ended = (): void => {
            now.delete(key)
            if (mine === gen) next()
          }
          let p: Promise<unknown>
          try {
            p = read().then((v) => {
              if (mine === gen) apply(v)
            })
          } catch (e) {
            p = Promise.reject(e)
          }
          p.then(ended, ended)
        }
      })
      next()
    },
    cancel() {
      gen++
      waiting = []
      running = new Set()
    }
  }
}
