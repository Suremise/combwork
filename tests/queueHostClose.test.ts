// A merge queue's run that its workspace's close ends (HI-1989): the workspace closes between two of its steps, so its
// next step finds it closed ("The workspace this card belongs to has closed"). The run didn't fail: it says it ended,
// with no warning. A failure while the workspace is open still warns. The workflow service is a stand-in that closes
// the workspace (or not) and throws as the real one does.
import { describe, expect, it, vi } from 'vitest'

const lines: { level: 'info' | 'warn'; text: string }[] = []
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ info: (text: string) => void lines.push({ level: 'info', text }), warn: (text: string) => void lines.push({ level: 'warn', text }), debug: () => undefined, error: () => undefined }),
  userText: (s: unknown) => String(s)
}))

/** What the stand-in workflowFor does: closes the workspace first (the race), then throws. */
const stub = { close: null as (() => void) | null, error: new Error('unset') }
vi.mock('../src/main/workflow/service', () => ({
  workflowEnforced: () => true,
  workflowFor: async () => {
    stub.close?.()
    throw stub.error
  }
}))

const { kickQueue } = await import('../src/main/workflow/queueHost')

/** A workspace as the host sees it: its path, its lifetime (which its close aborts) and its window's events. */
function workspace(path: string): { ws: never; close: () => void } {
  const life = new AbortController()
  const ws = { path, lifetime: life.signal, emit: () => undefined }
  return { ws: ws as never, close: () => life.abort() }
}

describe('a merge queue run its workspace closed under (HI-1989)', () => {
  it('closed between its steps: the run ends, said as info, with no warning', async () => {
    lines.length = 0
    const { ws, close } = workspace('C:\\ws-closed')
    stub.close = close
    stub.error = new Error('The workspace this card belongs to has closed')
    await kickQueue(ws, 'C:\\ws-closed\\alpha', 'integration')
    expect(lines.filter((l) => l.level === 'warn')).toEqual([])
    expect(lines).toContainEqual({ level: 'info', text: 'the merge queue for integration in alpha ended: its workspace closed (The workspace this card belongs to has closed)' })
  })

  it('a failure while its workspace is open still warns', async () => {
    lines.length = 0
    const { ws } = workspace('C:\\ws-open')
    stub.close = null
    stub.error = new Error('the board could not be read')
    await kickQueue(ws, 'C:\\ws-open\\alpha', 'integration')
    expect(lines.filter((l) => l.level === 'warn').map((l) => l.text)).toEqual(['running the merge queue for integration in alpha'])
  })
})
