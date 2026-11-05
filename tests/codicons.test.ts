// Two copies of the Codicons font: @vscode/codicons (Combwork's icons) and Monaco's, both named "codicon"; whichever the
// page settles on draws every icon. That is only safe while they agree: each of Combwork's icons at the same codepoint
// in Monaco's font. An upgrade of either that breaks this would draw wrong icons once an editor has loaded.
import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

// Straight from node_modules: Monaco's package exports don't map its deep paths for require.resolve.
const read = (rel: string): string => readFileSync(new URL(`../node_modules/${rel}`, import.meta.url), 'utf8')

describe('the two Codicons fonts', () => {
  it("Monaco's has each of Combwork's icons at the same codepoint", () => {
    const hive = new Map<string, number>()
    for (const m of read('@vscode/codicons/dist/codicon.css').matchAll(/\.codicon-([\w-]+):before\s*\{\s*content:\s*"\\([0-9a-f]+)"/g)) hive.set(m[1], parseInt(m[2], 16))
    const monaco = new Map<string, number>()
    for (const m of read('monaco-editor/esm/vs/base/common/codiconsLibrary.js').matchAll(/register\(\s*'([\w-]+)'\s*,\s*(0x[0-9a-fA-F]+)\s*\)/g)) monaco.set(m[1], parseInt(m[2], 16))
    // Both lists were read (a changed file layout would otherwise pass with nothing compared).
    expect(hive.size).toBeGreaterThan(500)
    expect(monaco.size).toBeGreaterThan(500)
    const wrong = [...hive].filter(([name, at]) => monaco.get(name) !== at).map(([name]) => name)
    expect(wrong).toEqual([])
  })
})
