// The Preview's filtering proxy in a utility process of its own (HI-3615, design HI-3597 s21 §C′): off main's thread, one
// per preview generation (previewGuard.ts starts it, and ends it with its generation). It runs previewProxyCore.ts and
// talks to main over its parent port: `start` (the generation's own ports; test copies' resolver and address map), `ping`
// (its health), `close`. It says `ready` with its port, `pong`, and each decision as `log`.

import { startProxy, type RunningProxy } from './previewProxyCore'

interface Start {
  type: 'start'
  own: number[]
  /** Test copies only (main gives them only unpackaged, from CW_TEST_PREVIEW_DNS): each name's answers, in turn (the last repeats). */
  dns?: Record<string, string[][]>
  /** Test copies only (CW_TEST_PREVIEW_CONNECT): a checked "public" test address and port, reached at a local fixture. */
  connect?: Record<string, string>
}
type Message = Start | { type: 'ping'; n: number } | { type: 'close' }

const parent = process.parentPort
let proxy: RunningProxy | null = null

parent.on('message', (e: { data: Message }) => {
  const m = e.data
  if (m.type === 'ping') return parent.postMessage({ type: 'pong', n: m.n })
  if (m.type === 'close') {
    void (proxy?.close() ?? Promise.resolve()).finally(() => process.exit(0))
    return
  }
  if (m.type !== 'start' || proxy) return
  const asked = new Map<string, number>()
  const dns = m.dns
  const resolve = dns
    ? async (host: string): Promise<string[]> => {
        const answers = dns[host.toLowerCase()]
        if (!answers?.length) return []
        const n = asked.get(host) ?? 0
        asked.set(host, n + 1)
        return answers[Math.min(n, answers.length - 1)]
      }
    : undefined
  const map = m.connect
  const connectTo = map
    ? (address: string, port: number): { host: string; port: number } | null => {
        const to = map[`${address}:${port}`]
        if (!to) return null
        const i = to.lastIndexOf(':')
        return { host: to.slice(0, i), port: Number(to.slice(i + 1)) }
      }
    : undefined
  startProxy({ own: () => ({ ports: m.own }), ...(resolve ? { resolve } : {}), ...(connectTo ? { connectTo } : {}), log: (event) => parent.postMessage({ type: 'log', event }) }).then(
    (p) => {
      proxy = p
      parent.postMessage({ type: 'ready', port: p.port })
    },
    (err: unknown) => {
      parent.postMessage({ type: 'failed', why: err instanceof Error ? err.message : String(err) })
      process.exit(1)
    }
  )
})
