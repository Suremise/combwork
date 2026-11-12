// A cancelled or timed-out jj process's tree is ended without blocking the thread it runs on (HI-2997: a jj write runs on
// main's, which carries every keystroke): never spawnSync, the thread free while PowerShell lists and ends the tree, and the
// outcome given only once the whole tree has gone, so a write's admission still ends after its processes. Windows only
// (the tree is listed with PowerShell); tempDir() only.
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

const { syncCalls } = vi.hoisted(() => ({ syncCalls: [] as string[] }))
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return { ...real, spawnSync: (...a: Parameters<typeof real.spawnSync>) => (syncCalls.push(String(a[0])), real.spawnSync(...a)) }
})

const { runJj } = await import('../src/main/platform/jjProcess')

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe.skipIf(process.platform !== 'win32')("a jj process's tree ended off the thread (HI-2997)", () => {
  for (const how of ['cancelled', 'timedOut'] as const) {
    it(`${how}: never spawnSync, the thread free meanwhile, and the outcome only once its child is gone too`, async () => {
      const dir = tempDir('jj-tree-')
      const pidFile = join(dir, 'child.pid')
      // A "jj" that starts a child of its own (as jj starts git or a hook), says its pid, and waits.
      const fake = join(dir, 'fake-jj.js')
      writeFileSync(fake, `const { spawn } = require('child_process'); const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000)\n`)
      const ac = new AbortController()
      const run = runJj({ exe: process.execPath, args: [fake], cwd: dir, env: { SYSTEMROOT: process.env.SYSTEMROOT, PATH: '' }, maxOutput: 1e6, timeout: how === 'timedOut' ? 1500 : 60_000 }, ac.signal)
      await vi.waitFor(() => expect(existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0).toBe(true), { timeout: 20_000, interval: 50 })
      const child = Number(readFileSync(pidFile, 'utf8'))
      expect(alive(child)).toBe(true)
      // The thread's ticks while the tree is ended: a teardown on it would show as no tick until it was over.
      let ticks = 0
      const iv = setInterval(() => ticks++, 5)
      syncCalls.length = 0
      if (how === 'cancelled') ac.abort()
      const r = await run
      clearInterval(iv)
      expect(r.end).toEqual({ notRun: how })
      expect(syncCalls).toEqual([])
      expect(ticks).toBeGreaterThan(5)
      // The ordering kept: by the outcome, jj's own child has gone too.
      expect(alive(child)).toBe(false)
    }, 60_000)
  }
})
