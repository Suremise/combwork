/** `fn` on each of `items`, at most `n` at once; the results in the items' order. */
export async function atMost<T, R>(n: number, items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length })
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return out
}
