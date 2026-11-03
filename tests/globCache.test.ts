// HI-2457: a module built from import.meta.glob sees its folder as it is now, not as Vitest's disk module cache last saw
// it. The schema test fails on a stale cache (a schema area file added after a run cached schema.ts); the key generator's
// tests say which sources stay out of the cache (tests/globCacheKey.mts, in vitest.config.ts).
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { agentTextSchema } from '../src/main/dialects/schema'
import { schemaOf } from '../src/main/dialects/format'
import { globCacheKey, usesImportGlob } from './globCacheKey.mts'

const ROOT = join(__dirname, '..')

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

  it("covers each of Hive's glob users", () => {
    for (const file of ['src/main/dialects/schema.ts', 'src/main/installDir.ts', 'src/shared/i18n/catalogues.ts'])
      expect(usesImportGlob(readFileSync(join(ROOT, file), 'utf8')), file).toBe(true)
  })
})
