// Monaco's DOMPurify is Combwork's (#1141). monaco-editor 0.57.0 bundles its own copy of DOMPurify 3.4.15 (two IN_PLACE
// advisories) and imports it by a relative path, so package.json's override alone wouldn't change what ships: the
// renderer build's cw-monaco-dompurify plugin (electron.vite.config.ts) gives Monaco's domSanitize.js Combwork's dompurify
// instead, and a build that would take Monaco's copy fails. Built here for real (Monaco's sanitiser alone, with the
// plugin), the bundle has Combwork's DOMPurify and not Monaco's. And once Monaco bundles 3.4.17 or later, a test here fails
// to say the plugin and the override are to go.
import { readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { build } from 'vite'
import { describe, expect, it } from 'vitest'
import { monacoDompurify } from '../electron.vite.config'
import { tempDir } from './tempDir'

const root = resolve(__dirname, '..')
const monacoEsm = join(root, 'node_modules', 'monaco-editor', 'esm', 'vs', 'base', 'browser')
const sanitize = join(monacoEsm, 'domSanitize.js')
const monacosCopy = join(monacoEsm, 'dompurify', 'dompurify.js')
const ours = join(root, 'node_modules', 'dompurify', 'dist', 'purify.es.mjs')
/** The DOMPurify versions a module sets (`DOMPurify.version = '3.4.15'`): a copy's own, or a bundle's. */
const versionsIn = (code: string): string[] => [...code.matchAll(/DOMPurify\.version\s*=\s*["'](\d+\.\d+\.\d+)["']/g)].map((m) => m[1])
const versionOf = (file: string): string => versionsIn(readFileSync(file, 'utf8'))[0] ?? ''
const atLeast = (v: string, min: number[]): boolean => {
  const n = v.split('.').map(Number)
  for (let i = 0; i < min.length; i++) if (n[i] !== min[i]) return n[i] > min[i]
  return true
}

describe("Monaco's DOMPurify is Combwork's (#1141)", () => {
  it("is still needed: Monaco bundles a DOMPurify older than 3.4.17 (else remove the plugin and package.json's override)", () => {
    const bundled = versionOf(monacosCopy)
    const listed = (JSON.parse(readFileSync(join(root, 'node_modules', 'monaco-editor', 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }).dependencies?.dompurify ?? ''
    expect(bundled, "Monaco's own DOMPurify copy isn't where the plugin expects it: check cw-monaco-dompurify still has something to do").toMatch(/^\d/)
    expect(atLeast(bundled, [3, 4, 17]) || atLeast(listed.replace(/^[^\d]*/, ''), [3, 4, 17]), `Monaco now has DOMPurify ${bundled} (lists ${listed}): remove the cw-monaco-dompurify plugin (electron.vite.config.ts) and package.json's dompurify override, and this test`).toBe(false)
  })

  it("maps only domSanitize.js's import of Monaco's copy to Combwork's dompurify", () => {
    const plugin = monacoDompurify() as unknown as { resolveId: (s: string, i?: string) => string | null; load: (id: string) => null }
    expect(plugin.resolveId('./dompurify/dompurify.js', sanitize)).toBe(ours)
    expect(plugin.resolveId('./dompurify/dompurify.js', join(monacoEsm, 'markdownRenderer.js'))).toBeNull()
    expect(plugin.resolveId('./dom.js', sanitize)).toBeNull()
    expect(plugin.resolveId('./dompurify/dompurify.js')).toBeNull()
    expect(plugin.load(join(monacoEsm, 'dom.js'))).toBeNull()
    expect(() => plugin.load(monacosCopy)).toThrow(/Monaco's own DOMPurify would be bundled/)
  })

  it("a build of Monaco's sanitiser has Combwork's DOMPurify, not Monaco's", async () => {
    const dir = tempDir('monaco-dompurify')
    const entry = join(dir, 'entry.js')
    writeFileSync(entry, `import { sanitizeHtml } from ${JSON.stringify(sanitize.split('\\').join('/'))}\nexport default sanitizeHtml\n`)
    const out = (await build({ root: dir, logLevel: 'silent', configFile: false, plugins: [monacoDompurify()], build: { write: false, minify: false, lib: { entry, formats: ['es'], fileName: 'out' } } })) as { output: { code?: string }[] }[]
    const code = out.flatMap((o) => o.output).map((c) => c.code ?? '').join('\n')
    const own = versionOf(ours)
    expect(own).toMatch(/^\d/)
    expect(versionsIn(code)).toEqual([own])
  }, 60_000)
})
