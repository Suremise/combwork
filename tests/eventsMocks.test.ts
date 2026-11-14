// HI-2861: a test that loads the real agentProcesses, with Combwork's events mocked by a factory of its own, gives that
// mock every export agentProcesses uses. Its job host can end mid-run (a PowerShell gone on a shared machine): the
// lost-host path then toasts (noteUntracked), and an export missing from the mock throws "No "toast" export is defined
// on the mock" outside any test, ending the worker instead of the run going on as the product's would.
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..')
const read = (f: string): string => readFileSync(join(root, f), 'utf8')

/** The names a module imports from './events', values only (`import type` and `type x` left out). */
function eventsImports(source: string): string[] {
  const names: string[] = []
  for (const m of source.matchAll(/^import\s+(type\s+)?\{([^}]*)\}\s+from\s+'\.\/events'/gm)) {
    if (m[1]) continue
    for (const part of m[2].split(',')) {
      const name = part.trim()
      if (name && !name.startsWith('type ')) names.push(name.split(/\s+as\s+/)[0].trim())
    }
  }
  return names
}

/** The text of `vi.mock('<module>', …)`'s factory, from its opening parenthesis to the matching close; null if none. */
function mockFactory(source: string, module: string): string | null {
  const start = source.indexOf(`vi.mock('${module}',`)
  if (start < 0) return null
  let depth = 0
  for (let i = source.indexOf('(', start); i < source.length; i++) {
    if (source[i] === '(') depth++
    else if (source[i] === ')' && --depth === 0) return source.slice(start, i + 1)
  }
  return null
}

/** The exports a factory leaves undefined: none when it spreads the real module (`await orig()`), else each name not given. */
function missingFromMock(factory: string, names: string[]): string[] {
  if (/\.\.\.\s*(\(\s*)?await\s+\w+\s*(<[^>]*>)?\s*\(\s*\)|\.\.\.\s*(real|actual)\b/.test(factory)) return []
  return names.filter((n) => !new RegExp(`(^|[{,\\s])${n}\\s*[:(,}]`).test(factory))
}

/** Whether a test loads the real agentProcesses: it imports it, or sessions (which imports it), and mocks neither. */
const loadsAgentProcesses = (source: string): boolean =>
  ['agentProcesses', 'sessions'].some((m) => new RegExp(`['"]\\.\\./src/main/${m}['"]`).test(source) && !source.includes(`vi.mock('../src/main/${m}'`))

describe("tests' mocks of Combwork's events", () => {
  it('reads the names a module imports from events, and what a factory leaves out', () => {
    expect(eventsImports("import { emit, onCombworkEvent, toast } from './events'\nimport type { X } from './events'")).toEqual(['emit', 'onCombworkEvent', 'toast'])
    const f = mockFactory("vi.mock('../src/main/events', () => ({ emit: (e: unknown) => f(e) }))\nnext()", '../src/main/events')!
    expect(f).toBe("vi.mock('../src/main/events', () => ({ emit: (e: unknown) => f(e) }))")
    expect(missingFromMock(f, ['emit', 'toast'])).toEqual(['toast'])
    expect(missingFromMock("vi.mock('../src/main/events', async (orig) => ({ ...(await orig<object>()), emit: () => 1 }))", ['toast'])).toEqual([])
  })

  it('give every export agentProcesses uses, in each test that loads it for real', () => {
    const names = eventsImports(read('src/main/agentProcesses.ts'))
    expect(names).toContain('toast')
    const missing: string[] = []
    for (const f of readdirSync(join(root, 'tests')).filter((n) => n.endsWith('.test.ts'))) {
      const source = read(`tests/${f}`)
      if (!loadsAgentProcesses(source)) continue
      const factory = mockFactory(source, '../src/main/events')
      if (factory === null) continue
      const gone = missingFromMock(factory, names)
      if (gone.length) missing.push(`tests/${f}: ${gone.join(', ')}`)
    }
    expect(missing).toEqual([])
  })
})
