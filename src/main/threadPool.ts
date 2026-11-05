import { stat } from 'original-fs'

/**
 * Main's libuv thread pool, made larger than Node's 4 (HI-1702). Every asynchronous file call of main's and of its worker
 * threads (the usage history's, the repository lock's) waits for one of the pool's threads, and so do zlib, crypto and
 * DNS: with 4, a few slow calls (a large read, a file the antivirus holds, a busy disk) made every window's file work
 * queue behind them, and a step that awaits a hundred calls in turn (a window's open, a skill update, a session listing)
 * took seconds. The pool reads UV_THREADPOOL_SIZE once, when it is first used: this module is imported first by main's
 * entry, sets it, starts the pool with a stat, and puts the variable back, so no process Combwork starts inherits it. The
 * bundle loads its shared chunks before this code: one that used the pool as it loaded would leave it at 4, which the
 * stalls e2e suite checks (eight calls held, a ninth still goes through).
 */
export const THREAD_POOL_SIZE = 16

const before = process.env.UV_THREADPOOL_SIZE
/** The pool's size: a size the user set for Combwork themselves is kept (libuv takes 1 to 1024). */
export const threadPoolSize = before ? Math.min(1024, Math.max(1, Math.trunc(Number(before)) || 4)) : THREAD_POOL_SIZE
if (!before) {
  process.env.UV_THREADPOOL_SIZE = String(THREAD_POOL_SIZE)
  stat(process.execPath, () => undefined)
  delete process.env.UV_THREADPOOL_SIZE
}
