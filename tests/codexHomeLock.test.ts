import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { homedir } from 'os'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { afterAll, describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
import { junction } from './pathAliases'
// @ts-expect-error: plain .mjs module without types
import { acquireCodexHome, codexLockDir, usesCodexHome } from './e2e/codexHomeLock.mjs'

const ctx = createRequire(import.meta.url)('./e2e/runContext.cjs')
const tmp = tempDir('cw-codex-home-lock-')
afterAll(() => rmSync(tmp, { recursive: true, force: true }))
let number = 0
const fixture = () => {
  const root = join(tmp, String(++number))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  return { home, poolRoot: join(root, 'locks') }
}

describe('machine-wide Codex test-home lease (#478)', () => {
  it('keys a home by its real path, so junctions share a slot and different homes do not', () => {
    const f = fixture()
    const alias = junction(f.home, join(tmp, `alias-${number}`))
    expect(codexLockDir(alias, f.poolRoot)).toBe(codexLockDir(f.home, f.poolRoot))
    expect(codexLockDir(join(f.home, '..', 'other'), f.poolRoot)).not.toBe(codexLockDir(f.home, f.poolRoot))
    expect(codexLockDir(f.home + '/', f.poolRoot)).toBe(codexLockDir(f.home, f.poolRoot))
    if (process.platform === 'win32') expect(codexLockDir(f.home.toUpperCase(), f.poolRoot)).toBe(codexLockDir(f.home, f.poolRoot))
    expect(() => codexLockDir(join(process.env.USERPROFILE || homedir(), '.codex'), f.poolRoot)).toThrow('require a test home')
  })

  it('covers real Codex and explicit shared-home suites, not unrelated/fake-home suites', () => {
    expect(usesCodexHome({ needs: ['codex'] })).toBe(true)
    expect(usesCodexHome({ codexHome: 'test' })).toBe(true)
    expect(usesCodexHome({ needs: ['claude'] })).toBe(false)
    expect(usesCodexHome({})).toBe(false)
  })

  it('orders contenders by the holder condition, always one slot, and removes exit listeners on release', async () => {
    const f = fixture()
    const alive = () => true
    const listeners = process.listenerCount('exit')
    const first = await acquireCodexHome(f.home, { poolRoot: f.poolRoot, owner: 101, alive, what: 'first worktree', slots: 9 })
    expect(first.slot).toBe(0)
    let observed!: (value: unknown) => void
    const waiting = new Promise((resolve) => { observed = resolve })
    let acquired = false
    const next = acquireCodexHome(f.home, { poolRoot: f.poolRoot, owner: 102, alive, pollMs: 5, onWait: observed }).then((lease: { release(): void }) => { acquired = true; return lease })
    expect(await waiting).toMatchObject({ holders: [{ pid: 101, what: 'first worktree' }] })
    expect(acquired).toBe(false)
    first.release()
    const second = await next
    expect(acquired).toBe(true)
    second.release()
    expect(readdirSync(codexLockDir(f.home, f.poolRoot)).filter((n) => n.endsWith('.json'))).toEqual([])
    expect(process.listenerCount('exit')).toBe(listeners)
  })

  it('recovers a dead or stale holder without an old release deleting its replacement', async () => {
    const f = fixture()
    const first = await acquireCodexHome(f.home, { poolRoot: f.poolRoot, owner: 101, alive: () => true })
    const second = await acquireCodexHome(f.home, { poolRoot: f.poolRoot, owner: 102, alive: (pid: number) => pid !== 101 })
    const file = join(codexLockDir(f.home, f.poolRoot), 'slot-0.json')
    first.release()
    expect(JSON.parse(readFileSync(file, 'utf8')).pid).toBe(102)
    const state = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, JSON.stringify({ ...state, at: Date.now() - 25 * 60 * 60_000 }))
    const third = await acquireCodexHome(f.home, { poolRoot: f.poolRoot, owner: 103, alive: () => true })
    second.release()
    expect(JSON.parse(readFileSync(file, 'utf8')).pid).toBe(103)
    third.release()
  })

  it('releases on process exit even when the caller does not release it explicitly', () => {
    const f = fixture()
    const url = pathToFileURL(join(__dirname, 'e2e', 'codexHomeLock.mjs')).href
    const script = `import(${JSON.stringify(url)}).then(async ({ acquireCodexHome }) => { await acquireCodexHome(${JSON.stringify(f.home)}, { poolRoot: ${JSON.stringify(f.poolRoot)} }); process.exit(0); })`
    execFileSync(process.execPath, ['-e', script], { env: ctx.baseEnv(), encoding: 'utf8', timeout: 20_000 })
    expect(readdirSync(codexLockDir(f.home, f.poolRoot)).filter((n) => n.endsWith('.json'))).toEqual([])
  })
})
