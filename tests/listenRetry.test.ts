// listenWithRetry (HI-2196): after an unexpected close the Agent API's listen is tried again while its port is in use,
// for a bound from the first try, then fails as a single try does. Real sockets hold the ports (each from listen(0));
// the bound is a fake clock's, so the number of tries is exact.
import { createServer, type AddressInfo, type Server } from 'net'
import { afterEach, describe, expect, it } from 'vitest'
import { listenWithRetry } from '../src/main/listenRetry'

const HOST = '127.0.0.1'
const open: Server[] = []
const made: Server[] = []
const make = (): Server => {
  const s = createServer()
  made.push(s)
  return s
}
/** A socket of the test's own that listens on a port, which it holds until closed. */
async function holder(): Promise<{ server: Server; port: number }> {
  const server = createServer()
  open.push(server)
  await new Promise<void>((r) => server.listen(0, HOST, r))
  return { server, port: (server.address() as AddressInfo).port }
}
const close = (s: Server): Promise<void> => new Promise((r) => (s.listening ? s.close(() => r()) : r()))
/** Whether nothing listens on port now. */
const free = async (port: number): Promise<boolean> => {
  const s = createServer()
  return new Promise((r) => {
    s.once('error', () => r(false))
    s.listen(port, HOST, () => s.close(() => r(true)))
  })
}

afterEach(async () => {
  for (const s of [...open, ...made]) await close(s)
  open.length = 0
  made.length = 0
})

describe('listenWithRetry', () => {
  it('a port that is freed while it waits: listens on a later try, each failed server closed', async () => {
    const held = await holder()
    let waits = 0
    // Released once the first try has found it in use, as the copy that held it ends.
    const got = await listenWithRetry(make, held.port, HOST, { retry: true, retryMs: 10, onWait: () => void (waits++, held.server.close()) })
    open.push(got.server)
    expect(got.server.listening).toBe(true)
    expect((got.server.address() as AddressInfo).port).toBe(held.port)
    expect(got.tries).toBeGreaterThan(1)
    expect(waits).toBe(1)
    expect(made.slice(0, -1).every((s) => !s.listening)).toBe(true)
  })

  it('a port held past the bound: EADDRINUSE once the next try would start after it, counted from the first try', async () => {
    const held = await holder()
    let waits = 0
    // Each try takes 100 ms of the clock, with a bound of 1000 ms and tries 10 ms apart: the tenth failure would retry past it.
    let t = 0
    const slow = (): Server => ((t += 100), make())
    const err = await listenWithRetry(slow, held.port, HOST, { retry: true, retryMs: 10, boundMs: 1000, now: () => t, onWait: () => void waits++ }).catch((e) => e)
    expect(err.code).toBe('EADDRINUSE')
    expect(err.tries).toBe(10)
    expect(waits).toBe(1)
    expect(made).toHaveLength(10)
    expect(made.every((s) => !s.listening)).toBe(true)
  })

  it('a pause that ends after the bound makes no other try, even with the port free by then (HR2, round 1)', async () => {
    const held = await holder()
    // The clock reads 0 for the first try and its check; the wait (as a busy event loop resumes the timer late) moves it
    // past the bound, and frees the port, which a try now would get.
    let t = 0
    const err = await listenWithRetry(make, held.port, HOST, { retry: true, retryMs: 10, boundMs: 100, now: () => t, onWait: () => void ((t = 101), held.server.close()) }).catch((e) => e)
    expect(err.code).toBe('EADDRINUSE')
    expect(err.tries).toBe(1)
    expect(made).toHaveLength(1)
    expect(made.every((s) => !s.listening)).toBe(true)
  })

  it('without retry: a port in use fails at the first try, as before', async () => {
    const held = await holder()
    let waits = 0
    const err = await listenWithRetry(make, held.port, HOST, { retry: false, onWait: () => void waits++ }).catch((e) => e)
    expect(err.code).toBe('EADDRINUSE')
    expect(err.tries).toBe(1)
    expect(waits).toBe(0)
    expect(made).toHaveLength(1)
  })

  it('another error is never tried again', async () => {
    const err = await listenWithRetry(make, 70000, HOST, { retry: true, retryMs: 10 }).catch((e) => e)
    expect(err.code).toBe('ERR_SOCKET_BAD_PORT')
    expect(err.tries).toBe(1)
    expect(made).toHaveLength(1)
  })

  it('stopped while it waits: no other try, nothing left listening even once the port is free', async () => {
    const held = await holder()
    const stop = new AbortController()
    const err = await listenWithRetry(make, held.port, HOST, { retry: true, retryMs: 10, signal: stop.signal, onWait: () => stop.abort() }).catch((e) => e)
    expect(err.name).toBe('AbortError')
    expect(made).toHaveLength(1)
    await close(held.server)
    expect(await free(held.port)).toBe(true)
    expect(made.every((s) => !s.listening)).toBe(true)
  })

  it('stopped before its first try: no server is made to listen', async () => {
    const stop = new AbortController()
    stop.abort()
    const { port } = await holder()
    const err = await listenWithRetry(make, port, HOST, { retry: true, signal: stop.signal }).catch((e) => e)
    expect(err.name).toBe('AbortError')
    expect(made.every((s) => !s.listening)).toBe(true)
  })
})
