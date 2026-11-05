// `npm run i18n:numbers` (#880): numbers passed to plain placeholders, found by typing them `string` in a copy. A
// review aid, not a check; these keep it working: its patches still apply, and run on a probe it finds what it should.
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
// @ts-expect-error: plain .mjs modules without types
import { audit, dropRichTypeArgs, mixedPlaceholders, patchCounts, removeCopy, siteKind, tscErrors } from '../scripts/i18nNumbers.mjs'
// @ts-expect-error: plain .mjs modules without types
import { valuesDts } from '../scripts/i18nValues.mjs'

const ROOT = resolve(__dirname, '..')

type Site ={ file: string; line: number; col: number; kind: 'number' | 'maybe' | 'dynamic' }

/** A probe in the window's code: each export a case, `// →` what the audit should say of it. */
const PROBE = 'src/renderer/src/i18nNumbersProbe.tsx'
const PROBE_TEXT = `import type { ReactNode } from 'react'
import { msg, tr, tRich, type Msg } from '@shared/i18n'

const PLAIN = msg({ id: 'numbersProbe.plain', defaultMessage: 'Plain {n}', description: 'A probe: {n} is plain.' })
const FORMATTED = msg({ id: 'numbersProbe.formatted', defaultMessage: 'Formatted {n, number}', description: 'A probe: {n} is formatted.' })
const UNITS: Record<string, Msg> = { plain: PLAIN, formatted: FORMATTED }
const big = 1234.5 as number
const label = 'x' as string

export const explicitRich = tRich<ReactNode>(PLAIN, { n: big }) // → number
export const inferredRich = tRich(PLAIN, { n: big }) // → number
export const richElement = tRich<ReactNode>(PLAIN, { n: <b key="b">{label}</b> }) // → nothing
export const richFormatted = tRich<ReactNode>(FORMATTED, { n: big }) // → nothing
export const plainTr = tr(PLAIN, { n: big }) // → number
export const textTr = tr(PLAIN, { n: label }) // → nothing
export const formattedTr = tr(FORMATTED, { n: big }) // → nothing
export const dynamicTr = (unit: string): string => tr(UNITS[unit], { n: big }) // → dynamic
`

describe('i18n:numbers', () => {
  it('each helper it patches is still as the patch expects (else update PATCHES in scripts/i18nNumbers.mjs)', () => {
    const counts = patchCounts() as [string, string, number][]
    expect(counts.length).toBeGreaterThan(0)
    expect(counts.filter(([, , n]) => n !== 1).map(([file, from, n]) => `${file} (${n}×): ${from}`)).toEqual([])
  })

  it('run on a probe, finds numbers through tr and tRich (its type argument given or not), and calls of a message not known there; formatted numbers and text pass', { timeout: 120_000 }, () => {
    // The copy goes in a temp folder of the test's, never in the repository (it links to its node_modules).
    const work = tempDir('hive-i18n-numbers-')
    const { sites, other, dir } = audit({ extra: { [PROBE]: PROBE_TEXT }, dir: work }) as { sites: Site[]; other: unknown[]; dir: string }
    expect(dir).toBe(work)
    const lines = PROBE_TEXT.split('\n')
    const expected = lines.flatMap((text, i) => {
      const want = / \/\/ → (number|dynamic)$/.exec(text)?.[1]
      // Where the number is: the value's name, in the source as written (tRich's type argument and all).
      return want ? [`${i + 1}:${text.indexOf('n: big') + 1} ${want}`] : []
    })
    expect(expected).toHaveLength(4)
    expect(sites.filter((s) => s.file === PROBE).map((s) => `${s.line}:${s.col} ${s.kind}`)).toEqual(expected)
    // Nothing else in the copy fails to compile; the copy is gone, and the packages it linked to are still there.
    expect(other).toEqual([])
    expect(existsSync(dir)).toBe(false)
    expect(existsSync(join(ROOT, 'node_modules', 'typescript', 'package.json'))).toBe(true)
  })

  it('removes the junction to the packages before the copy, leaving what it points to', () => {
    const work = tempDir('hive-i18n-numbers-')
    const target = tempDir('hive-i18n-numbers-target-')
    writeFileSync(join(target, 'kept.txt'), 'not the copy’s')
    mkdirSync(join(work, 'src'))
    symlinkSync(target, join(work, 'node_modules'), 'junction')
    try {
      removeCopy(work)
      expect(existsSync(work)).toBe(false)
      expect(readFileSync(join(target, 'kept.txt'), 'utf8')).toBe('not the copy’s')
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('drops tRich type arguments, its definition aside, and says how far each later column moved', () => {
    const { text, shifts } = dropRichTypeArgs('export function tRich<T>(m: Msg) {}\nconst a = tRich<ReactNode>(A, { n }) + tRich<string | number>(B, { n })\n')
    expect(text).toBe('export function tRich<T>(m: Msg) {}\nconst a = tRich(A, { n }) + tRich(B, { n })\n')
    expect(shifts.get(1)).toBeUndefined()
    expect(shifts.get(2)).toEqual([
      [11, 11],
      [29, 17]
    ])
  })

  it('types a plain placeholder `string` for the audit, and `string | number` otherwise', () => {
    const catalogue = { 'x.a': { defaultMessage: '{name} has {n, plural, one {# card} other {# cards}} on port {port}' } }
    expect(valuesDts('x', catalogue, 'string')).toContain("'x.a': { name: string; n: number; port: string }")
    expect(valuesDts('x', catalogue)).toContain("'x.a': { name: string | number; n: number; port: string | number }")
  })

  it('reads tsc errors with their continuation lines, and tells a number from a value that may be one or a message not known there', () => {
    const errors = tscErrors(
      [
        "D:\\copy\\run-1\\src/main/a.ts(3,10): error TS2322: Type 'number' is not assignable to type 'string'.",
        "src/main/b.ts(7,5): error TS2345: Argument of type '[{ card: number; }]' is not assignable to parameter of type '[values: { card: string; }]'.",
        "  Type '{ card: number; }' is not assignable to type '{ card: string; }'.",
        "    Types of property 'card' are incompatible.",
        "      Type 'number' is not assignable to type 'string'.",
        "src/main/c.ts(9,1): error TS2322: Type 'TextPart' is not assignable to type 'string | Text'.",
        "  Type 'number' is not assignable to type 'string | Text'.",
        "src/main/d.ts(2,4): error TS2322: Type 'number' is not assignable to type 'string | boolean | Date | CombworkDynamicMessage | null | undefined'.",
        "src/main/e.ts(1,1): error TS2741: Property 'why' is missing in type '{}'."
      ].join('\r\n'),
      'D:\\copy\\run-1'
    )
    expect(errors.map((e: { file: string; line: number; col: number }) => `${e.file}:${e.line}:${e.col}`)).toEqual(['src/main/a.ts:3:10', 'src/main/b.ts:7:5', 'src/main/c.ts:9:1', 'src/main/d.ts:2:4', 'src/main/e.ts:1:1'])
    expect(errors.map(siteKind)).toEqual(['number', 'number', 'maybe', 'dynamic', null])
  })

  it('lists a placeholder used both plain and as a number or plural', () => {
    expect(
      mixedPlaceholders({
        'x.a': { defaultMessage: '{n} of {n, number}' },
        'x.b': { defaultMessage: '{all, select, yes {{tried, plural, one {one} other {#}}} other {{tried} of them}}' },
        'x.c': { defaultMessage: '{n, plural, one {# card} other {# cards}} by {name}' }
      }).map((m: { id: string; name: string }) => `${m.id}:${m.name}`)
    ).toEqual(['x.a:n', 'x.b:tried'])
  })
})
