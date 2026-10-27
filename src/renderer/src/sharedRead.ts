/**
 * One read shared by every view that asks for it with the same keys (HI-1754: each view showing For you read it for
 * itself, about seven calls to main per board change). A call with keys that differ from the last one's (another
 * workspace, the board read again) starts a new read; with the same keys it gets the read under way or done.
 */
export function sharedRead<T>(read: () => Promise<T>): (...keys: unknown[]) => Promise<T> {
  let last: { keys: unknown[]; read: Promise<T> } | null = null
  return (...keys) => {
    if (!last || last.keys.length !== keys.length || last.keys.some((k, i) => k !== keys[i])) last = { keys, read: read() }
    return last.read
  }
}
