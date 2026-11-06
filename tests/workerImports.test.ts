// Combwork's worker threads in an installed copy (HI-1880): each finds its script inside app.asar and starts as a thread of
// its own, and none loads Electron, which a worker thread can't (the usage worker reached it through fsutil.ts's
// logger, so in an installed Combwork it would have ended as it started). tests/e2e/packaged-workers.cjs checks the threads
// run in a packaged build.
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { bundledScriptExists } from '../src/main/workerThreads'
import { tempDir } from './tempDir'

const root = join(__dirname, '..')
/** The build's entries (electron.vite.config.ts) other than main's own: each runs where Electron can't be loaded. */
const entries = [...readFileSync(join(root, 'electron.vite.config.ts'), 'utf8').matchAll(/'([\w-]+)': resolve\(__dirname, '(src\/main\/[^']+)'\)/g)]
  .map((m) => ({ name: m[1], file: m[2] }))
  .filter((e) => e.name !== 'index')

describe('worker threads load no Electron (HI-1880)', () => {
  it('finds the workers among the build entries', () => {
    expect(entries.map((e) => e.name)).toEqual(expect.arrayContaining(['usage-worker', 'repo-lock-worker', 'git-worker', 'stall-watchdog', 'log-writer', 'wal-checkpoint-worker']))
  })

  it.each(entries)('$name imports nothing from Electron', async ({ file }) => {
    const r = await build({ entryPoints: [join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, metafile: true, packages: 'external', external: ['original-fs', 'original-fs/promises'], logLevel: 'silent' })
    const importers = Object.entries(r.metafile.inputs)
      .filter(([, i]) => i.imports.some((x) => x.path === 'electron'))
      .map(([p]) => p)
    expect(importers).toEqual([])
  }, 60_000)
})

describe('bundledScriptExists (HI-1880)', () => {
  it('takes a script inside an archive as there when the archive is', () => {
    const dir = tempDir('bundled-script')
    writeFileSync(join(dir, 'app.asar'), 'an archive')
    expect(bundledScriptExists(join(dir, 'app.asar', 'out', 'main', 'usage-worker.js'))).toBe(true)
    expect(bundledScriptExists(join(dir, 'gone.asar', 'out', 'main', 'usage-worker.js'))).toBe(false)
  })

  it('looks for a script on disk, a real folder named *.asar included', () => {
    const dir = tempDir('bundled-script')
    mkdirSync(join(dir, 'art.asar'))
    writeFileSync(join(dir, 'art.asar', 'worker.js'), '')
    writeFileSync(join(dir, 'worker.js'), '')
    expect(bundledScriptExists(join(dir, 'worker.js'))).toBe(true)
    expect(bundledScriptExists(join(dir, 'art.asar', 'worker.js'))).toBe(true)
    expect(bundledScriptExists(join(dir, 'art.asar', 'other.js'))).toBe(false)
    expect(bundledScriptExists(join(dir, 'none.js'))).toBe(false)
    expect(bundledScriptExists(dir)).toBe(false)
  })
})
