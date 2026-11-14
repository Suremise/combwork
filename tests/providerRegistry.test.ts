// HI-3201: each provider lives in its own folders (src/shared/providers/<folder>, src/main/providers/<folder>) behind one
// line of src/shared/providers/registry.ts. Code anywhere else reads providers only through the registry: it never imports
// a provider's folder, nor names a provider by its id (a literal such as 'codex', or an id-made one such as
// 'codex.hooks.timeoutSeconds'). Comments and messages (msg, agentMsg) may name a product: they are words, not code.
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join, relative, resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'
import { PROVIDERS } from '../src/shared/providers'
import { PROVIDER_MODULES } from '../src/shared/providers/registry'
import { orderedAdapters } from '../src/main/providers/index'
import type { ProviderAdapter } from '../src/main/providers/types'

const traverse = ((traverseModule as unknown as { default?: typeof traverseModule }).default ?? traverseModule) as typeof traverseModule
const ROOT = resolve(__dirname, '..')
const SHARED = join(ROOT, 'src', 'shared', 'providers')
const MAIN = join(ROOT, 'src', 'main', 'providers')
const folders = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
const IDS = PROVIDERS.map((p) => p.id)

/**
 * Where code may still name a provider, each with its reason. Keep it short: anything else that names one moves into the
 * provider's folder or reads the registry.
 */
const EXCEPTIONS: { file: string; what: string; why: string }[] = [
  // The built-in templates' data: a team of builders on Claude Code and reviewers on Codex is the template itself.
  { file: 'src/shared/templateDefaults.ts', what: "'claude-code'", why: "the built-in templates' agents" },
  { file: 'src/shared/templateDefaults.ts', what: "'codex'", why: "the built-in templates' agents" },
  // The workspace's and project's GitHub host settings (HI-2779): their stored key for where Copilot signs in is
  // github.copilotHost (and the settings catalogue's), an upgrade input, so the code that reads it keeps its name.
  { file: 'src/shared/githubHost.ts', what: 'declares COPILOT_SAME_AS_REPO', why: 'the stored copilotHost value "repo"' },
  { file: 'src/shared/githubHost.ts', what: 'declares COPILOT_GHES_PROXY', why: 'the stored copilotHost value "ghes-proxy"' },
  { file: 'src/shared/githubHost.ts', what: 'declares ParsedCopilotChoice', why: 'a stored copilotHost value, parsed' },
  { file: 'src/shared/githubHost.ts', what: 'declares parseCopilotChoice', why: 'parses a stored copilotHost value' },
  { file: 'src/shared/githubHost.ts', what: 'declares CopilotHostProblem', why: "why a stored copilotHost can't be used" },
  { file: 'src/renderer/src/components/GithubHosts.tsx', what: "'copilot'", why: 'the copilotHost row, as data-github-option names it (the e2e suites read it)' }
]

/** Files whose code is checked: everything under src but each provider's own folders and the registry. */
function checkedFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, d.name)
      if (d.isDirectory()) {
        if ((dir === SHARED || dir === MAIN) && existsSync(p)) continue
        walk(p)
      } else if (/\.(ts|tsx|mts)$/.test(d.name) && !d.name.endsWith('.d.ts')) out.push(p)
    }
  }
  walk(join(ROOT, 'src'))
  return out.filter((f) => f !== join(SHARED, 'registry.ts'))
}

/** A provider's name in a declared name: each provider's, by its folder's name (and agy, Antigravity's CLI). */
const PRODUCT = new RegExp(`(${[...folders(SHARED), 'agy'].join('|')})`, 'i')

/** Whether a declaration is the module's own (not a local one inside a function). */
const topLevel = (p: { parentPath: { node: { type: string }; parentPath: unknown } | null; node: { type: string } }): boolean => {
  let q = p.node.type === 'VariableDeclarator' ? (p.parentPath as typeof p | null) : (p as typeof p | null)
  if (q?.parentPath?.node.type === 'ExportNamedDeclaration') q = q.parentPath as typeof p
  return q?.parentPath?.node.type === 'Program'
}

/** A call whose arguments are words (a message), not code. */
const WORDS = new Set(['msg', 'agentMsg'])

/** Each place a checked file names a provider: by its id in a literal, or by importing its folder. */
function namings(file: string): { line: number; what: string }[] {
  const code = readFileSync(file, 'utf8')
  const ast = parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: true })
  const found: { line: number; what: string }[] = []
  const names = (s: string): string | null => IDS.find((id) => s === id || s.startsWith(`${id}.`) || s.startsWith(`${id}:`)) ?? null
  traverse(ast, {
    CallExpression(p) {
      const c = p.node.callee
      if (c.type === 'Identifier' && WORDS.has(c.name)) p.skip()
    },
    ImportDeclaration(p) {
      const spec = p.node.source.value
      if (!spec.startsWith('.') && !spec.startsWith('@shared/')) return
      const to = spec.startsWith('@shared/') ? join(ROOT, 'src', 'shared', spec.slice('@shared/'.length)) : resolve(file, '..', spec)
      const inside = [SHARED, MAIN].some((root) => folders(root).some((f) => to === join(root, f) || to.startsWith(join(root, f) + '\\') || to.startsWith(join(root, f) + '/')))
      if (inside) found.push({ line: p.node.loc?.start.line ?? 0, what: `imports ${spec}` })
    },
    StringLiteral(p) {
      if (p.parentPath.isImportDeclaration() || p.parentPath.isExportDeclaration()) return
      const id = names(p.node.value)
      if (id) found.push({ line: p.node.loc?.start.line ?? 0, what: `'${p.node.value}'` })
    },
    // A name declared here after a provider (claudeFileAllowed, CODEX_…): that provider's code, which belongs in its folder.
    'FunctionDeclaration|ClassDeclaration|VariableDeclarator|TSInterfaceDeclaration|TSTypeAliasDeclaration'(p) {
      const id = (p.node as { id?: { type: string; name?: string } }).id
      if (id?.type === 'Identifier' && id.name && PRODUCT.test(id.name) && topLevel(p)) found.push({ line: p.node.loc?.start.line ?? 0, what: `declares ${id.name}` })
    },
    TemplateLiteral(p) {
      const first = p.node.quasis[0]?.value.cooked ?? ''
      const id = names(first)
      if (id) found.push({ line: p.node.loc?.start.line ?? 0, what: `\`${first}…\`` })
    }
  })
  return found
}

/** What a file imports (and re-exports, and imports when it runs), as written. */
function importsOf(file: string): string[] {
  const ast = parse(readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: true })
  const out: string[] = []
  traverse(ast, {
    'ImportDeclaration|ExportNamedDeclaration|ExportAllDeclaration'(p) {
      const source = (p.node as { source?: { value: string } | null }).source
      if (source) out.push(source.value)
    },
    CallExpression(p) {
      const [arg] = p.node.arguments
      if (p.node.callee.type === 'Import' && arg?.type === 'StringLiteral') out.push(arg.value)
    }
  })
  return out
}

describe('the provider registry (HI-3201)', () => {
  it('is the single entry point: no code outside a provider\'s folders names a provider or imports its folder', () => {
    const bad: string[] = []
    for (const file of checkedFiles()) {
      const rel = relative(ROOT, file).replace(/\\/g, '/')
      for (const n of namings(file)) {
        if (EXCEPTIONS.some((e) => e.file === rel && n.what === e.what)) continue
        bad.push(`${rel}:${n.line} ${n.what}`)
      }
    }
    expect(bad, "read the provider through the registry (src/shared/providers' helpers, main's provider(id)), or move the code into its folder").toEqual([])
  })

  it('keeps each exception in use', () => {
    for (const e of EXCEPTIONS) expect(namings(join(ROOT, e.file)).some((n) => n.what === e.what), `${e.file}: ${e.what} (${e.why})`).toBe(true)
  })

  it('lists each provider once, with both of its folders', () => {
    expect(new Set(IDS).size).toBe(IDS.length)
    expect(PROVIDER_MODULES.map((m) => m.descriptor.id)).toEqual(IDS)
    const shared = folders(SHARED)
    const main = folders(MAIN).filter((f) => existsSync(join(MAIN, f, 'adapter.ts')))
    expect(main.sort()).toEqual(shared.sort())
    expect(shared.length).toBe(IDS.length)
    // Each main folder's adapter is a registered provider's (src/main/providers/index.ts finds them by these names).
    for (const f of main) expect(readFileSync(join(MAIN, f, 'adapter.ts'), 'utf8')).toMatch(/^export default \w+\s*$/m)
  })

  it("keeps the shared halves renderer-safe and each provider's folders to themselves", () => {
    const imports = (file: string): string[] => importsOf(file)
    const filesIn = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? filesIn(join(dir, d.name)) : /\.tsx?$/.test(d.name) ? [join(dir, d.name)] : []))
    const bad: string[] = []
    for (const file of filesIn(join(ROOT, 'src', 'shared'))) {
      for (const spec of imports(file).filter((x) => x.startsWith('.'))) if (resolve(file, '..', spec).startsWith(join(ROOT, 'src', 'main'))) bad.push(`${relative(ROOT, file)} imports ${spec} (main's code)`)
    }
    for (const root of [SHARED, MAIN]) {
      for (const own of folders(root)) {
        for (const file of filesIn(join(root, own))) {
          for (const spec of imports(file).filter((x) => x.startsWith('.'))) {
            const to = resolve(file, '..', spec)
            const other = [SHARED, MAIN].flatMap((r) => folders(r).filter((f) => f !== own).map((f) => join(r, f))).find((d) => to === d || to.startsWith(d + '\\') || to.startsWith(d + '/'))
            if (other) bad.push(`${relative(ROOT, file)} imports ${spec} (another provider's)`)
          }
        }
      }
    }
    expect(bad).toEqual([])
  })

  it("puts the adapters in the registry's order, and refuses one missing, one unregistered or two for a provider", () => {
    const a = (id: string): ProviderAdapter => ({ id }) as unknown as ProviderAdapter
    expect(orderedAdapters([a('b'), a('a')], ['a', 'b']).map((x) => x.id)).toEqual(['a', 'b'])
    expect(() => orderedAdapters([a('a')], ['a', 'b'])).toThrow(/"b" has no adapter/)
    expect(() => orderedAdapters([a('a'), a('c')], ['a'])).toThrow(/"c" has no line/)
    expect(() => orderedAdapters([a('a'), a('a')], ['a'])).toThrow(/Two adapters/)
  })
})
