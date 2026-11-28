// Ports for the Preview (HI-3614, design HI-3597 s16 §A): the TCP table's listening sockets, read by netstat in a process
// of its own (never on main's thread), and a port's test bind on 127.0.0.1 and ::1.

import { execFile } from 'child_process'
import { createServer } from 'net'
import { join } from 'path'
import type { Listener } from './previewRunner'

const NETSTAT = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'NETSTAT.EXE')

/** How long one read of the table may take. */
const READ_MS = 15_000

/**
 * The listening TCP sockets in `netstat -ano`'s output: its TCP lines whose foreign address is the any-address (0.0.0.0:0,
 * [::]:0), which only a listening socket has. Read by that, not by the state's word, which Windows translates.
 */
export function parseNetstat(out: string): Listener[] {
  const found: Listener[] = []
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 5 || cols[0].toUpperCase() !== 'TCP') continue
    const local = cols[1]
    const foreign = cols[2]
    if (foreign !== '0.0.0.0:0' && foreign !== '[::]:0' && foreign !== '*:*') continue
    const port = Number(local.slice(local.lastIndexOf(':') + 1))
    const pid = Number(cols[cols.length - 1])
    if (Number.isInteger(port) && port > 0 && port <= 65535 && Number.isInteger(pid) && pid >= 0) found.push({ port, pid })
  }
  return found
}

/** The TCP table's listening sockets now, or null when it can't be read. */
export function readListeners(): Promise<Listener[] | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  return new Promise((res) => {
    execFile(NETSTAT, ['-ano', '-p', 'TCP'], { windowsHide: true, encoding: 'utf8', timeout: READ_MS, maxBuffer: 8 * 1024 * 1024 }, (err, v4) => {
      if (err) return res(null)
      execFile(NETSTAT, ['-ano', '-p', 'TCPv6'], { windowsHide: true, encoding: 'utf8', timeout: READ_MS, maxBuffer: 8 * 1024 * 1024 }, (err6, v6) => res([...parseNetstat(String(v4)), ...(err6 ? [] : parseNetstat(String(v6)))]))
    })
  })
}

/** Whether `port` can be bound on `host` now (exclusively, closed at once). A host this machine lacks (no IPv6) counts as free. */
function bindsOn(port: number, host: string): Promise<boolean> {
  return new Promise((res) => {
    const s = createServer()
    s.once('error', (e: NodeJS.ErrnoException) => res(e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT'))
    s.listen({ port, host, exclusive: true }, () => s.close(() => res(true)))
  })
}

/** Whether `port` can be bound now on both 127.0.0.1 and ::1. */
export async function bindFree(port: number): Promise<boolean> {
  return (await bindsOn(port, '127.0.0.1')) && (await bindsOn(port, '::1'))
}
