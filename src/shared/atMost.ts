/**
 * `fn` on each of `items`, at most `n` at once; the results in the items' order. A failure starts no more items, and is
 * thrown once those under way have ended (HI-1705): none goes on after it returns.
 */
export async function atMost<T, R>(n: number, items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length })
  let next = 0
  let failed = false
  const worker = async (): Promise<void> => {
    while (next < items.length && !failed) {
      const i = next++
      try {
        out[i] = await fn(items[i])
      } catch (e) {
        failed = true
        throw e
      }
    }
  }
  await whenAll(Array.from({ length: Math.min(n, items.length) }, worker))
  return out
}

/**
 * Promise.all that settles only once every promise has (HI-1705): work run at once, one part failing, leaves none of the
 * others still running after it returns (a close waiting for it would otherwise go ahead under them). Then the first
 * failure, in the promises' order, as Promise.all would throw one.
 */
export async function whenAll<T extends readonly unknown[] | []>(values: T): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  const settled = (await Promise.allSettled(values)) as PromiseSettledResult<unknown>[]
  for (const r of settled) if (r.status === 'rejected') throw r.reason
  return settled.map((r) => (r as PromiseFulfilledResult<unknown>).value) as { -readonly [K in keyof T]: Awaited<T[K]> }
}
