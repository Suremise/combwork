// HI-3009: a command's tree ended on main's thread never blocks it (as HI-2997 did for jj's, tests/jjProcessTree.test.ts):
// the merge queue's bounded git, a card's focused pick, a check's or a slot's command and the submodules step end theirs
// through treeEnding (endTreeAsync), never endTree's spawnSync; the thread ticks meanwhile; and the outcome comes only
// once the whole tree has gone. The source guard (only cw-progress's own process uses the blocking endTree) is
// tests/endTreeImports.test.ts, run by check:repo. Windows only (the trees are listed with PowerShell); tempDir() only.
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

const { syncCalls } = vi.hoisted(() => ({ syncCalls: [] as string[] }))
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return { ...real, spawnSync: (...a: Parameters<typeof real.spawnSync>) => (syncCalls.push(String(a[0])), real.spawnSync(...a)) }
})

const { gitTree } = await import('../src/main/workflow/mergeQueue')
const { runPick } = await import('../src/main/workflow/focusedRun')
const { execCommand } = await import('../src/main/workflow/queueChecks')
const { gitFilesExec } = await import('../src/main/platform/gitModulesRun')

const req = createRequire(import.meta.url)
const { baseEnv } = req('./e2e/runContext.cjs') as { baseEnv: () => Record<string, string> }

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A command that starts a child of its own (a hook, a signer, a server), writes that child's pid, and waits. */
function fakeTree(): { dir: string; script: string; pidFile: string } {
  const dir = tempDir('tree-end-')
  const pidFile = join(dir, 'child.pid')
  const script = join(dir, 'fake.js')
  writeFileSync(script, `const { spawn } = require('child_process'); const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000)\n`)
  return { dir, script, pidFile }
}

/** A spawn that runs the fake in place of whatever it was asked for (the caller's own options kept). */
const fakeSpawn = (script: string) => (_file: string, _args: string[], opts: SpawnOptions): ChildProcess => nodeSpawn(process.execPath, [script], { ...opts, shell: false, windowsVerbatimArguments: false })

/**
 * Runs `start` (which ends its tree, by a bound or a cancel, once `pidFile` names the child), and says how the thread fared:
 * the spawnSync calls made meanwhile, its ticks, and whether the child had gone by the outcome.
 */
async function ended<T>(pidFile: string, start: () => { run: Promise<T>; cancel?: () => void }): Promise<{ result: T; sync: string[]; ticks: number; childGone: boolean }> {
  const { run, cancel } = start()
  await vi.waitFor(() => expect(existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0).toBe(true), { timeout: 20_000, interval: 50 })
  const child = Number(readFileSync(pidFile, 'utf8'))
  expect(alive(child)).toBe(true)
  // The thread's ticks while the tree is ended: a teardown on it would show as no tick until it was over.
  let ticks = 0
  const iv = setInterval(() => ticks++, 5)
  syncCalls.length = 0
  cancel?.()
  const result = await run
  clearInterval(iv)
  return { result, sync: [...syncCalls], ticks, childGone: !alive(child) }
}

const isWin = process.platform === 'win32'

describe.skipIf(!isWin)("a command's tree ended off main's thread (HI-3009)", () => {
  it("the merge queue's bounded git (a hook or signer under it): timed out, never spawnSync, its result once the tree has gone", async () => {
    const { dir, script, pidFile } = fakeTree()
    // git runs the fake as an alias (sh, then node): git, a shell and the fake's own child, a tree as a hook makes.
    const alias = `!"${process.execPath.replace(/\\/g, '/')}" "${script.replace(/\\/g, '/')}"`
    const t = await ended(pidFile, () => ({ run: gitTree(dir, ['-c', `alias.hang=${alias}`, 'hang'], { env: baseEnv(), timeoutMs: 3000 }) }))
    expect(t.result).toMatchObject({ ok: false, timedOut: true })
    expect(t.sync).toEqual([])
    expect(t.ticks).toBeGreaterThan(5)
    expect(t.childGone).toBe(true)
  }, 60_000)

  for (const how of ['timedOut', 'cancelled'] as const) {
    it(`a card's focused pick, ${how}: never spawnSync, its outcome once the tree has gone`, async () => {
      const { dir, script, pidFile } = fakeTree()
      const ac = new AbortController()
      const deps = { spawn: fakeSpawn(script), platform: process.platform, env: () => baseEnv(), timeoutMs: how === 'timedOut' ? 1500 : 60_000, signal: ac.signal }
      const t = await ended(pidFile, () => ({ run: runPick(deps, `"${process.execPath}" "${script}"`, dir, 'HEAD', []), cancel: how === 'cancelled' ? () => ac.abort() : undefined }))
      expect(t.result).toMatchObject({ state: 'unknown', why: how })
      expect(t.sync).toEqual([])
      expect(t.ticks).toBeGreaterThan(5)
      expect(t.childGone).toBe(true)
    }, 60_000)
  }

  it("a check's command (and a slot's warming) at its time limit: never spawnSync, its end once the tree has gone", async () => {
    const { dir, script, pidFile } = fakeTree()
    const o = { spawn: fakeSpawn(script), platform: process.platform, timeoutMs: 1500, env: () => baseEnv() }
    const t = await ended(pidFile, () => ({ run: execCommand(o, `"${process.execPath}" "${script}"`, dir, { write: () => undefined }) }))
    expect(t.result).toMatchObject({ timedOut: true })
    expect(t.sync).toEqual([])
    expect(t.ticks).toBeGreaterThan(5)
    expect(t.childGone).toBe(true)
  }, 60_000)

  for (const how of ['timedOut', 'cancelled'] as const) {
    it(`the submodules step's git, ${how}: never spawnSync, its result once the tree has gone`, async () => {
      const { dir, script, pidFile } = fakeTree()
      const ac = new AbortController()
      const x = gitFilesExec({ spawn: fakeSpawn(script), env: baseEnv(), log: { write: () => undefined }, timeoutMs: how === 'timedOut' ? 1500 : 60_000, signal: ac.signal })
      try {
        const t = await ended(pidFile, () => ({ run: x.git(dir, ['submodule', 'update']), cancel: how === 'cancelled' ? () => ac.abort() : undefined }))
        expect(t.result.ok).toBe(false)
        expect(x.timedOut()).toBe(how === 'timedOut')
        expect(t.sync).toEqual([])
        expect(t.ticks).toBeGreaterThan(5)
        expect(t.childGone).toBe(true)
      } finally {
        x.close()
      }
    }, 60_000)
  }
})
