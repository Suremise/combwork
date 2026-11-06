// HI-2457: a module built from import.meta.glob sees its folder as it is now, not as Vitest's disk module cache last saw
// it. The schema test fails on a stale cache (a schema area file added after a run cached schema.ts); the key generator's
// tests say which sources stay out of the cache (tests/globCacheKey.mts, in vitest.config.ts).
import { execFile } from 'child_process'
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { promisify } from 'util'
import { describe, expect, it } from 'vitest'
import { agentTextSchema } from '../src/main/dialects/schema'
import { schemaOf } from '../src/main/dialects/format'
import { globCacheKey, usesImportGlob } from './globCacheKey.mts'
import { tempDir } from './tempDir'

const ROOT = join(__dirname, '..')
const { childEnv } = createRequire(import.meta.url)('./e2e/runContext.cjs')
const run = promisify(execFile)
const HUNG_MS = 30_000

describe("import.meta.glob's users and Vitest's module cache", () => {
  it('agentTextSchema() is every agent-text/schema area file on disk now', () => {
    const dir = join(ROOT, 'agent-text', 'schema')
    const areas = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as unknown)
    const onDisk = schemaOf(areas)
    expect(Object.keys(agentTextSchema()).sort()).toEqual(Object.keys(onDisk).sort())
    expect(agentTextSchema()).toEqual(onDisk)
  })

  it('leaves a module out of the disk cache when it uses a glob, typed or not', () => {
    expect(usesImportGlob("const A = import.meta.glob<unknown>('../x/*.json', { eager: true })")).toBe(true)
    expect(usesImportGlob("const A = import.meta.glob('../x/*.json')")).toBe(true)
    expect(usesImportGlob("const A = import.meta.glob<{ default: unknown }>(['a', '!b'])")).toBe(true)
    expect(globCacheKey({ sourceCode: 'export const x = import.meta.glob<T>("*.json")' })).toBe(false)
    expect(globCacheKey({ sourceCode: 'export const x = 1 // import.meta.env' })).toBeUndefined()
  })

  it("covers each of Combwork's glob users", () => {
    for (const file of ['src/main/dialects/schema.ts', 'src/main/installDir.ts', 'src/shared/i18n/catalogues.ts'])
      expect(usesImportGlob(readFileSync(join(ROOT, file), 'utf8')), file).toBe(true)
  })

  it('HI-2478: the next cached run sees added and removed matches without changing the glob module', async () => {
    const dir = tempDir('cw-glob-cache-')
    const areas = join(dir, 'areas')
    const cache = join(dir, 'module-cache')
    mkdirSync(areas)
    writeFileSync(join(areas, 'first.json'), '{}')
    const source = "export const areas = import.meta.glob<unknown>('./areas/*.json', { eager: true })\n"
    writeFileSync(join(dir, 'matches.ts'), source)
    const modulePath = (file: string): string => JSON.stringify(join(ROOT, file).replace(/\\/g, '/'))
    writeFileSync(join(dir, 'vitest.config.mts'), `
      import { globsUncached } from ${modulePath('tests/globCacheKey.mts')}
      export default {
        plugins: [globsUncached()],
        cacheDir: './vite-cache',
        test: { include: ['probe.test.ts'], maxWorkers: 1, fsModuleCache: true, fsModuleCachePath: ${JSON.stringify(cache)} }
      }
    `)
    writeFileSync(join(dir, 'probe.test.ts'), `
      import { expect, test } from ${modulePath('node_modules/vitest/dist/index.js')}
      import { readdirSync } from 'node:fs'
      import { areas } from './matches'
      test('matches the files on disk now', () => {
        expect(Object.keys(areas).sort()).toEqual(readdirSync(new URL('./areas', import.meta.url)).map(f => './areas/' + f).sort())
      })
    `)
    const check = async (): Promise<void> => {
      const { stdout } = await run(process.execPath, [join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', '--config', join(dir, 'vitest.config.mts')], {
        cwd: dir, env: childEnv({ NO_COLOR: '1' }), windowsHide: true, timeout: HUNG_MS
      })
      expect(stdout).toContain('1 passed')
      expect(readFileSync(join(dir, 'matches.ts'), 'utf8')).toBe(source)
    }
    await check()
    expect(readdirSync(cache, { recursive: true }).length).toBeGreaterThan(0)
    writeFileSync(join(areas, 'second.json'), '{}')
    await check()
    unlinkSync(join(areas, 'first.json'))
    await check()
  }, HUNG_MS)
})
