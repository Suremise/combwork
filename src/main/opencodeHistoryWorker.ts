import { parentPort } from 'worker_threads'
import { HistoryCore, type CoreReply, type CoreRequest } from './providers/opencode/historyCore'

/**
 * The OpenCode history's worker (HI-2762): a thread of its own running historyCore, so the reads of OpenCode sessions from
 * their agents' servers (HTTP, a session's whole history as JSON), the exports' output and the mirrors' writes never hold
 * up Combwork's main process, and with it the keystrokes typed into a pane. Requests are applied in the order they come.
 * No Electron here (a worker can't load it): main logs what it is told.
 */

const port = parentPort
if (port) {
  const post = (r: CoreReply): void => port.postMessage(r)
  const core = new HistoryCore((e) => post(e))
  port.on('message', (m: CoreRequest) => {
    core.handle(m).then(
      (value) => post({ id: m.id, ok: true, value: value ?? null }),
      (e: unknown) => post({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) })
    )
  })
}
