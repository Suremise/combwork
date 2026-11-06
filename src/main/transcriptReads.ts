/**
 * Transcripts Combwork is reading right now (the Sessions tab's viewer, a search, an export), by project and session:
 * archiving or deleting a session skips one being read rather than moving its files from under the reader.
 * Entries go when their last read ends, so the map holds only reads in progress.
 */
const reads = new Map<string, number>()

const key = (projectPath: string, sessionId: string): string => `${projectPath.toLowerCase()}|${sessionId.toLowerCase()}`

export async function whileReading<T>(projectPath: string, sessionId: string, fn: () => Promise<T>): Promise<T> {
  const k = key(projectPath, sessionId)
  reads.set(k, (reads.get(k) ?? 0) + 1)
  try {
    return await fn()
  } finally {
    const n = (reads.get(k) ?? 1) - 1
    if (n > 0) reads.set(k, n)
    else reads.delete(k)
  }
}

export function beingRead(projectPath: string, sessionId: string): boolean {
  return reads.has(key(projectPath, sessionId))
}

/**
 * The transcripts open in Sessions tabs (and the Assistant's conversations), by window and view: archiving or deleting
 * skips one that is open (the window asking closes its own view first, and says so). Views say when they open and
 * close; a window's go when it closes. At most MAX_VIEWS (the oldest go first).
 */
const views = new Map<string, { window: number; key: string }>()
const MAX_VIEWS = 200

export function setViewing(window: number, view: string, projectPath: string | null, sessionId: string | null): void {
  if (typeof view !== 'string' || view.length > 64) throw new Error('view: a short id') // i18n-ignore: a call's argument refused, which no person sees (the window always sends one)
  const k = `${window}:${view}`
  views.delete(k)
  if (projectPath && sessionId) views.set(k, { window, key: key(projectPath, sessionId) })
  while (views.size > MAX_VIEWS) views.delete(views.keys().next().value!)
}

/** The windows with this session's transcript open. */
export function viewingWindows(projectPath: string, sessionId: string): number[] {
  const k = key(projectPath, sessionId)
  return [...new Set([...views.values()].filter((v) => v.key === k).map((v) => v.window))]
}

export function forgetWindowViews(window: number): void {
  for (const [k, v] of views) if (v.window === window) views.delete(k)
}
