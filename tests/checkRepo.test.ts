// `npm run check:repo` (HI-2244): the merge queue's fast check beside typecheck and lint, the repo-wide checks only,
// which a change anywhere can break and a focused run doesn't pick: the i18n guard over src/ and its allowlists, the unit
// tests that scan every file (or every file of a kind) rather than test one area, then, by name, the tree-reading tests
// of files that mostly test behaviour (e2esuites.test.ts's suite list, areas and run-context rules; folderProcesses.test.ts's
// rule against ending a remembered pid; i18nCatalogues.test.ts's catalogues and translations being current; admission's
// rule that only a window's workspace admits; bundled's recorded versions current, npm run bundled-history): whole,
// the first three took 50 s of a minute. The full unit run is for a release's final checks, and on
// request. Vitest takes files and the name pattern as filters, so a file or test renamed would silently drop out: each
// must still be there.
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: plain .mjs modules without types
import { UNIT_SCANS } from './e2e/affected.mjs'

const root = join(__dirname, '..')
const script: string = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts['check:repo']
const FILES = '((?:tests\\/[\\w/]+\\.test\\.ts ?)+)'
// The agent-text guard and its catalogue's freshness (HI-2065) beside the i18n guard's, then the names check of the
// change (HI-2617: the lines it adds since the merge queue's target, CW_CHECK_BASE), and the WorkspaceService rule when the
// change touches one of its inputs (HI-2678, tests/e2e/workspaceRuleCheck.mjs).
const SHAPE = new RegExp(`^node scripts\\/i18nGuard\\.mjs && node scripts\\/agentTextGuard\\.mjs && node scripts\\/agentTextExtract\\.mjs --check && node tests\\/oldNames\\.mjs --diff && node tests\\/e2e\\/workspaceRuleCheck\\.mjs --diff && vitest run ${FILES} && vitest run ${FILES} -t "([^"]+)"$`)
const shape = SHAPE.exec(script)
const list = (s: string | undefined): string[] => s?.trim().split(' ') ?? []
const whole = list(shape?.[1])
const byName = list(shape?.[2])

/** A pattern's top-level alternatives (split at each | outside parentheses). */
function alternatives(pattern: string): string[] {
  const out = ['']
  let depth = 0
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') out[out.length - 1] += c + pattern[++i]
    else if (c === '|' && !depth) out.push('')
    else {
      depth += c === '(' ? 1 : c === ')' ? -1 : 0
      out[out.length - 1] += c
    }
  }
  return out
}

describe('npm run check:repo', () => {
  it("runs the i18n guard, the agent-text guard and its catalogue's check, the change's names check, the repo-wide test files, then the tree-reading tests of more files by name", () => {
    expect(shape, script).not.toBeNull()
  })

  it('names test files that exist, once each, sorted', () => {
    for (const files of [whole, byName]) {
      expect(files.length).toBeGreaterThan(0)
      expect(files.filter((f) => !existsSync(join(root, f)))).toEqual([])
      expect(files).toEqual([...new Set(files)].sort())
    }
    expect(whole.filter((f) => byName.includes(f))).toEqual([])
  })

  // Vitest matches the pattern against each level's name on its own (a describe's, a test's), never the two joined, so
  // a part spanning both matches nothing: each part must match one title, and each file named must have a match.
  it('each part of the name pattern matches a describe or test there is, and each file named has one', () => {
    const titles = new Map(byName.map((f) => [f, [...readFileSync(join(root, f), 'utf8').matchAll(/\b(?:describe|it)(?:\.\w+(?:\([^)]*\))?)?\((['"])(.*?)\1/g)].map((m) => m[2])]))
    const all = [...titles.values()].flat()
    const parts = alternatives(shape?.[3] ?? '')
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.filter((p) => !all.some((t) => new RegExp(p).test(t)))).toEqual([])
    const pattern = new RegExp(shape?.[3] ?? '^$')
    expect(byName.filter((f) => !titles.get(f)!.some((t) => pattern.test(t)))).toEqual([])
  })

  it('includes each test that scans the whole repository (a UNIT_SCANS entry with no paths)', () => {
    const all = [...new Set((UNIT_SCANS as { test: string; paths?: string[] }[]).filter((e) => !e.paths).map((e) => e.test))]
    expect(all.filter((t) => ![...whole, ...byName].includes(t))).toEqual([])
  })
})
