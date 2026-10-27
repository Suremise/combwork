/**
 * One read shared by every view that asks for it with the same keys (HI-1754: each view showing For you read it for
 * itself, about seven calls to main per board change). A call with keys that differ from the last one's (another
 * workspace, the board read again) starts a new read; with the same keys it gets the read under way or done. A read
 * that fails is let go once it has (unless a newer read has replaced it), so the next call with the same keys reads again.
 */
export function sharedRead<T>(read: () => Promise<T>): (...keys: unknown[]) => Promise<T> {
  let last: { keys: unknown[]; read: Promise<T> } | null = null
  return (...keys) => {
    if (!last || last.keys.length !== keys.length || last.keys.some((k, i) => k !== keys[i])) {
      const entry: { keys: unknown[]; read: Promise<T> } = { keys, read: read() }
      entry.read.catch(() => {
        if (last === entry) last = null
      })
      last = entry
    }
    return last.read
  }
}
