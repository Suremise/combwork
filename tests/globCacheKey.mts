// HI-2457: Vitest 5 keeps transformed modules on disk between runs (fsModuleCache), keyed on a module's own source. A
// module that uses import.meta.glob depends on its folder's files too, and Vitest leaves those out of the cache only when
// the source has the literal `import.meta.glob(`: Combwork's are typed (`import.meta.glob<T>(`), so they were cached, and a
// later run kept the folder's old contents (agentTextSchema() held 46 ids instead of 290 after tool.json merged). This
// keeps every module that uses a glob out of the disk cache, typed or not; all others keep it.
import type { Plugin } from 'vite'

/** Whether a module's source uses import.meta.glob, with or without type arguments. */
export const usesImportGlob = (sourceCode: string): boolean => /import\.meta\.glob\s*[<(]/.test(sourceCode)

/** The cache key generator: false leaves the module out of the disk cache; undefined adds nothing to the key. */
export const globCacheKey = ({ sourceCode }: { sourceCode: string }): false | undefined => (usesImportGlob(sourceCode) ? false : undefined)

/** A Vitest plugin that keeps import.meta.glob users out of the disk module cache. */
export const globsUncached = (): Plugin =>
  ({
    name: 'cw:globs-uncached',
    configureVitest(ctx: { defineCacheKeyGenerator: (fn: typeof globCacheKey) => void }) {
      ctx.defineCacheKeyGenerator(globCacheKey)
    }
  }) as Plugin
