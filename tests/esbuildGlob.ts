import { existsSync, readdirSync, readFileSync } from 'fs'
import { dirname, join, relative } from 'path'
import type { Plugin } from 'esbuild'

/**
 * Vite's eager import.meta.glob for a test's esbuild bundle of main's code (HI-3201: the usage worker finds each provider's
 * parser by it): `import.meta.glob<T>('./*\/name.ts', { eager: true, import: 'X' })` becomes an object of the matching
 * files' exports, by their paths, as Vite builds it. Only the providers' form: one pattern, a single `*` folder, eager.
 */
export function esbuildEagerGlob(): Plugin {
  return {
    name: 'eager-import-meta-glob',
    setup(b) {
      b.onLoad({ filter: /[\\/]src[\\/].*\.ts$/ }, (args) => {
        const code = readFileSync(args.path, 'utf8')
        if (!code.includes('import.meta.glob')) return undefined
        const dir = dirname(args.path)
        let n = 0
        const imports: string[] = []
        const out = code.replace(/import\.meta\.glob(?:<[^>]*>)?\(\s*'([^']+)'\s*,\s*\{\s*eager:\s*true(?:\s*,\s*import:\s*'([^']+)')?\s*\}\s*\)/g, (_all: string, pattern: string, name?: string) => {
          const m = /^(.*)\/\*\/([^/*]+)$/.exec(pattern)
          // Another form (a folder of JSON files: the dialects' schema) is left as it is, as esbuild leaves it.
          if (!m) return _all
          const base = join(dir, m[1])
          const entries = readdirSync(base, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => join(base, d.name, m[2]))
            .filter((f) => existsSync(f))
          const fields = entries.map((f) => {
            const id = `__glob${n++}`
            const spec = `./${relative(dir, f).replace(/\\/g, '/')}`
            imports.push(`import * as ${id} from ${JSON.stringify(spec.replace(/\.ts$/, ''))}`)
            return `${JSON.stringify(spec)}: ${name ? `${id}[${JSON.stringify(name)}]` : id}`
          })
          return `({ ${fields.join(', ')} })`
        })
        return { contents: `${imports.join('\n')}\n${out}`, loader: 'ts' }
      })
    }
  }
}
