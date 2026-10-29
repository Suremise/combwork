// Advanced settings (#367): Hive's overridable defaults, each CLI-facing one checked against what the CLI was recorded
// sending (tests/fixtures/advanced and the other recordings), what an override takes and how it falls back, advanced.json
// (read, written, edited by hand, the CLI version an override was made for), the adapters using them, and the settings
// catalog's entries for the Assistant.
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ADVANCED_DEFS, advancedDef, advancedFileText, advancedUnit, advancedRow, checkAdvanced, cliFacing, parseAdvancedFile, sampleMiss, type AdvancedDef } from '../src/shared/advanced'
import { CLAUDE_FOOTER_MODES } from '../src/shared/claude'
import { COPILOT_FOOTER_MODES } from '../src/shared/copilot'
import { SETTINGS_CATALOG, checkSettingValue, settingDefault, settingEntry, settingPatch, settingValue, settingValueText } from '../src/shared/settingsCatalog'
import { AdvancedStore, advanced, bindAdvancedSettings, mcpAdvancedEnv, updateSettingsChecked, waitMaxSeconds } from '../src/main/advanced'
import { DEFAULT_SETTINGS, mergeDefaults } from '../src/shared/defaults'
import type { AppSettings } from '../src/shared/types'
import { tempDir } from './tempDir'

const ROOT = join(__dirname, '..')
const def = (id: string): AdvancedDef => advancedDef(id)!
// With LF line ends whatever the checkout's: a sample can span lines (a dialog's two choices).
const fixtureText = (from: string): string => readFileSync(join(ROOT, from), 'utf8').replace(/\r\n/g, '\n')

/** Every JSON object in a fixture (a JSON file, or JSON lines), however deep. */
function objectsIn(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') {
      out.push(v as Record<string, unknown>)
      Object.values(v).forEach(walk)
    }
  }
  const whole = (() => {
    try {
      return JSON.parse(text) as unknown
    } catch {
      return undefined
    }
  })()
  if (whole !== undefined) walk(whole)
  else for (const line of text.split(/\r?\n/)) if (line.trim()) walk(JSON.parse(line))
  return out
}

/** The text a fixture holds: as it is, and each JSON string in it decoded (a message inside JSON lines). */
function textsIn(from: string): string[] {
  const text = fixtureText(from)
  if (!/\.jsonl?$/.test(from)) return [text]
  return [text, ...objectsIn(text).flatMap((o) => Object.values(o).filter((v): v is string => typeof v === 'string'))]
}

describe('advanced defaults', () => {
  it('each has a unique id under its group, a title, a description and a default that checks out', () => {
    const ids = ADVANCED_DEFS.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const d of ADVANCED_DEFS) {
      expect(d.id.startsWith(`${d.group}.`), d.id).toBe(true)
      expect(d.title && d.desc, d.id).toBeTruthy()
      expect(checkAdvanced(d, d.default), d.id).toEqual({ value: d.default })
      if (d.kind === 'number') expect(d.min! <= (d.default as number) && (d.default as number) <= d.max!, d.id).toBe(true)
      // Every value of a CLI's is CLI-facing (what Hive reads from it, and what it gives it); Hive's own aren't.
      expect(cliFacing(d), d.id).toBe(d.group !== 'hive')
    }
  })

  it("every number's unit has a label for beside its box (#1281), and a number of seconds says s", () => {
    for (const d of ADVANCED_DEFS.filter((x) => x.unit)) expect(advancedUnit(d), d.id).toBeTruthy()
    expect(advancedUnit(def('codex.mcp.startupTimeoutSeconds'))).toBe('s')
    expect(advancedUnit(def('hive.showDeveloperFeatures'))).toBeNull()
  })

  it('every CLI-facing default has recorded samples, each found in its fixture, and reads every one', () => {
    for (const d of ADVANCED_DEFS.filter(cliFacing)) {
      expect(d.samples?.length, `${d.id} has no recorded sample`).toBeGreaterThan(0)
      for (const s of d.samples!) {
        expect(existsSync(join(ROOT, s.from)), s.from).toBe(true)
        // The fixture is named with the CLI version it was recorded with, or says it (a console fixture's "cli").
        const named = s.from.includes(s.version) || s.from.includes(s.version.replace(/\.0$/, ''))
        expect(named || (s.from.includes('/console/') && JSON.parse(fixtureText(s.from)).cli === s.version), `${s.from} ${s.version}`).toBe(true)
        if (s.text !== undefined) expect(textsIn(s.from).some((t) => t.includes(s.text!)), `${d.id}: "${s.text}" isn't in ${s.from}`).toBe(true)
        if (s.fields) {
          const want = [...s.fields].sort().join()
          expect(objectsIn(fixtureText(s.from)).some((o) => Object.keys(o).sort().join() === want), `${d.id}: no object with fields ${want} in ${s.from}`).toBe(true)
        }
        // The default reads each sample, not only one of them.
        expect(sampleMiss({ ...d, samples: [s] }, d.default), `${d.id} vs ${s.from}`).toBeNull()
      }
    }
  })

  it("the trust questions and the ready footer match the recorded screens, and not each other's or an idle one", () => {
    const screen = (name: string): string => fixtureText(`tests/fixtures/${name}`)
    const re = (id: string): RegExp => new RegExp(def(id).default as string, def(id).flags ?? '')
    expect(re('claude-code.trust.prompt').test(screen('advanced/trust-claude-2.1.296.txt'))).toBe(true)
    expect(re('claude-code.trust.prompt').test(screen('screen-claude-2.1.296-idle.txt'))).toBe(false)
    expect(re('codex.trust.prompt').test(screen('advanced/trust-codex-0.162.1.txt'))).toBe(true)
    expect(re('codex.trust.prompt').test(screen('screen-codex-0.162.1-idle.txt'))).toBe(false)
    expect(re('copilot.trust.prompt').test(screen('advanced/trust-copilot-1.0.95.txt'))).toBe(true)
    expect(re('copilot.trust.prompt').test(screen('advanced/ready-copilot-1.0.95.txt'))).toBe(false)
    expect(re('copilot.ready.footer').test(screen('advanced/ready-copilot-1.0.95.txt'))).toBe(true)
    expect(re('copilot.ready.footer').test(screen('advanced/trust-copilot-1.0.95.txt'))).toBe(false)
    // Codex's placeholder: on its idle screen, not while it asks about trust.
    expect(screen('screen-codex-0.162.1-idle.txt')).toContain(def('codex.ready.placeholder').default)
    expect(screen('advanced/trust-codex-0.162.1.txt')).not.toContain(def('codex.ready.placeholder').default)
  })

  it("each footer mode's default finds its own recorded screen, and no other mode's (#696)", () => {
    const footers = ADVANCED_DEFS.filter((d) => d.id.includes('.footer.'))
    expect(footers.map((d) => d.id)).toEqual([...CLAUDE_FOOTER_MODES.map((m) => `claude-code.footer.${m.key}`), ...COPILOT_FOOTER_MODES.map((m) => `copilot.footer.${m.key}`)])
    for (const d of footers) {
      const own = fixtureText(d.samples![0].from)
      for (const other of footers.filter((o) => o.group === d.group)) expect(new RegExp(other.default as string, other.flags ?? '').test(own), `${other.id} on ${d.samples![0].from}`).toBe(other === d)
    }
  })
})

describe('an override', () => {
  // A choice (#1292: the OSC 52 policy): one of its values, as advanced.json and the tools write them.
  it('takes one of a choice\'s values, any case, shown by its name; anything else refused, listing them', async () => {
    const { advancedShown, advancedText } = await import('../src/shared/advanced')
    const policy = def('hive.terminal.osc52')
    expect(policy).toMatchObject({ kind: 'choice', default: 'allow', applies: 'now' })
    expect(policy.choices!.map((c) => c.value)).toEqual(['allow', 'ask', 'block'])
    expect(checkAdvanced(policy, 'ask')).toEqual({ value: 'ask' })
    expect(checkAdvanced(policy, ' Block ')).toEqual({ value: 'block' })
    expect(checkAdvanced(policy, 'maybe')).toMatchObject({ error: 'A CLI putting text on the clipboard takes one of allow, ask, block.' })
    expect(checkAdvanced(policy, true)).toMatchObject({ error: expect.any(String) })
    expect(advancedText(policy, 'ask')).toBe('ask')
    expect(advancedShown(policy, 'ask')).toBe('Ask each time')
  })

  it('takes a pattern that compiles and finds something, text, a field name, names, a whole number in range', () => {
    const trust = def('claude-code.trust.prompt')
    expect(checkAdvanced(trust, 'trust (this|the) folder')).toEqual({ value: 'trust (this|the) folder' })
    expect(checkAdvanced(trust, 'trust (this')).toMatchObject({ error: expect.stringContaining("isn't a valid regular expression") })
    expect(checkAdvanced(trust, 'x*')).toMatchObject({ error: expect.stringContaining('would match anything') })
    expect(checkAdvanced(trust, '')).toMatchObject({ error: expect.any(String) })
    expect(checkAdvanced(trust, 'a\nb')).toMatchObject({ error: expect.stringContaining('one line') })
    expect(checkAdvanced(trust, 42)).toMatchObject({ error: expect.any(String) })
    const field = def('codex.rateLimits.field')
    expect(checkAdvanced(field, 'rateLimits')).toEqual({ value: 'rateLimits' })
    expect(checkAdvanced(field, 'rate-limits')).toMatchObject({ error: expect.stringContaining('field name') })
    expect(checkAdvanced(field, '1st')).toMatchObject({ error: expect.any(String) })
    expect(checkAdvanced(def('hive.showDeveloperFeatures'), 'on')).toEqual({ value: true })
    expect(checkAdvanced(def('hive.showDeveloperFeatures'), 'yes')).toMatchObject({ error: expect.stringContaining('true or false') })
    const items = def('codex.title.items')
    expect(checkAdvanced(items, 'activity, project-name, spinner')).toEqual({ value: ['activity', 'project-name', 'spinner'] })
    expect(checkAdvanced(items, ['activity'])).toEqual({ value: ['activity'] })
    expect(checkAdvanced(items, '')).toMatchObject({ error: expect.any(String) })
    expect(checkAdvanced(items, ['a b'])).toMatchObject({ error: expect.any(String) })
    const reply = def('hive.mcp.replySeconds')
    expect(checkAdvanced(reply, 600)).toEqual({ value: 600 })
    expect(checkAdvanced(reply, '600')).toEqual({ value: 600 })
    expect(checkAdvanced(reply, 29)).toMatchObject({ error: expect.stringContaining('30 to 3600') })
    expect(checkAdvanced(reply, 1.5)).toMatchObject({ error: expect.any(String) })
    expect(checkAdvanced(def('codex.ready.placeholder'), 'Ask Codex anything')).toEqual({ value: 'Ask Codex anything' })
  })

  it("says when it no longer finds what the CLI was recorded sending (kept: the CLI may have changed)", () => {
    expect(sampleMiss(def('claude-code.trust.prompt'), 'trust the workspace')).toMatch(/doesn't find what Claude Code 2\.1\.296 showed \("Yes, I trust this folder"\)/)
    expect(sampleMiss(def('claude-code.trust.prompt'), 'I trust')).toBeNull()
    expect(sampleMiss(def('codex.rateLimits.field'), 'limits')).toMatch(/Codex 0\.159\.0 sent no field "limits" here \(it sent type, info, rate_limits\)/)
    expect(sampleMiss(def('codex.ready.placeholder'), 'Ask Codex anything')).toMatch(/doesn't find/)
    // Hive's own have nothing recorded to try.
    expect(sampleMiss(def('hive.mcp.replySeconds'), 999)).toBeNull()
  })

  it('is used when it checks out; else the default, saying why; a workspace\'s own comes first where one is taken', () => {
    const lanes = def('hive.progress.lanesShown')
    const state = (values: Record<string, unknown>, workspace: Record<string, unknown> | null = null) => ({ values, madeFor: {}, workspace, cli: {} })
    expect(advancedRow(lanes, null).value).toBe(6)
    expect(advancedRow(lanes, state({ 'hive.progress.lanesShown': 6 })).value).toBe(6)
    expect(advancedRow(lanes, state({ 'hive.progress.lanesShown': 6 }, { 'hive.progress.lanesShown': 2 })).value).toBe(2)
    const bad = advancedRow(lanes, state({ 'hive.progress.lanesShown': 'six' }))
    expect(bad.value).toBe(6)
    expect(bad.problem).toMatch(/whole number/)
    const badOwn = advancedRow(lanes, state({ 'hive.progress.lanesShown': 6 }, { 'hive.progress.lanesShown': 99 }))
    expect(badOwn.value).toBe(6)
    expect(badOwn.problem).toMatch(/^This workspace's/)
    // A value a workspace can't take is its own nowhere.
    expect(advancedRow(def('hive.mcp.replySeconds'), state({}, { 'hive.mcp.replySeconds': 900 })).value).toBe(300)
    const trust = def('claude-code.trust.prompt')
    expect(advancedRow(trust, state({ 'claude-code.trust.prompt': '(' })).value).toBe('trust this folder')
  })

  it('is flagged once another CLI version is installed than the one it was made for', () => {
    const trust = def('claude-code.trust.prompt')
    const s = (installed: string | null) => ({ values: { 'claude-code.trust.prompt': 'I trust' }, madeFor: { 'claude-code.trust.prompt': { version: '2.1.296', value: 'I trust' } }, workspace: null, cli: { 'claude-code': installed } })
    expect(advancedRow(trust, s('2.1.296')).madeForOther).toBeNull()
    expect(advancedRow(trust, s('2.1.300')).madeForOther).toBe('2.1.296')
    expect(advancedRow(trust, s(null)).madeForOther).toBeNull()
  })
})

describe('advanced.json', () => {
  it('is versioned, its keys in order; a newer format, bad JSON or a wrong shape is refused; unknown ids are kept, not used', () => {
    const text = advancedFileText({ 'hive.mcp.replySeconds': 600, 'claude-code.trust.prompt': 'I trust' }, { 'claude-code.trust.prompt': { version: '2.1.296', value: 'I trust' } })
    expect(JSON.parse(text)).toEqual({ format: 1, values: { 'claude-code.trust.prompt': 'I trust', 'hive.mcp.replySeconds': 600 }, madeFor: { 'claude-code.trust.prompt': { version: '2.1.296', value: 'I trust' } } })
    expect(Object.keys(JSON.parse(text).values)).toEqual(['claude-code.trust.prompt', 'hive.mcp.replySeconds'])
    expect(parseAdvancedFile(text)).toEqual({ values: { 'claude-code.trust.prompt': 'I trust', 'hive.mcp.replySeconds': 600 }, madeFor: { 'claude-code.trust.prompt': { version: '2.1.296', value: 'I trust' } }, unknown: [] })
    expect(parseAdvancedFile('{ "values": ')).toMatchObject({ error: expect.stringContaining("isn't valid JSON") })
    expect(parseAdvancedFile('[]')).toMatchObject({ error: expect.stringContaining('object') })
    expect(parseAdvancedFile('{"format":2,"values":{}}')).toMatchObject({ error: expect.stringContaining('newer Hive') })
    expect(parseAdvancedFile('{"values":[]}')).toMatchObject({ error: expect.stringContaining('"values"') })
    expect(parseAdvancedFile('{"values":{"hive.nope":1,"hive.mcp.replySeconds":400}}')).toMatchObject({ unknown: ['hive.nope'] })
    // A record for a value no longer there is dropped.
    expect(parseAdvancedFile('{"values":{},"madeFor":{"claude-code.trust.prompt":{"version":"1","value":"x"}}}')).toMatchObject({ madeFor: {} })
  })
})

describe('the advanced store', () => {
  const stores: AdvancedStore[] = []
  const store = (): { s: AdvancedStore; dir: string; file: string } => {
    const dir = tempDir('hive-advanced-')
    const s = new AdvancedStore()
    stores.push(s)
    return { s, dir, file: join(dir, 'advanced.json') }
  }
  afterEach(() => {
    for (const s of stores.splice(0)) s.stop()
  })
  const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'))

  it('uses defaults with no file; writes an override, with the CLI version it was made for; the default again removes it', async () => {
    const { s, dir, file } = store()
    s.load(dir)
    expect(s.number('hive.mcp.replySeconds')).toBe(300)
    s.noteCli('claude-code', '2.1.296')
    await s.set('claude-code.trust.prompt', 'trust (this|the) folder')
    await s.set('hive.mcp.replySeconds', 600)
    expect(read(file)).toEqual({ format: 1, values: { 'claude-code.trust.prompt': 'trust (this|the) folder', 'hive.mcp.replySeconds': 600 }, madeFor: { 'claude-code.trust.prompt': { version: '2.1.296', value: 'trust (this|the) folder' } } })
    expect(s.pattern('claude-code.trust.prompt').test('Yes, I trust the folder')).toBe(true)
    expect(s.number('hive.mcp.replySeconds')).toBe(600)
    await expect(s.set('hive.mcp.replySeconds', 5)).rejects.toThrow('30 to 3600')
    await expect(s.set('hive.nope', 5)).rejects.toThrow('No advanced setting')
    await s.set('hive.mcp.replySeconds', 300)
    await s.set('claude-code.trust.prompt', null)
    expect(read(file)).toEqual({ format: 1, values: {}, madeFor: {} })
  })

  it('a retired setting (the Connections preview, HI-1774) is dropped as read, never unknown, and gone at the next write; a real unknown one stays', async () => {
    const { s, dir, file } = store()
    writeFileSync(file, JSON.stringify({ format: 1, values: { 'hive.accounts.preview': true, 'hive.nope': 1, 'hive.mcp.replySeconds': 400 }, madeFor: { 'hive.accounts.preview': { version: null, value: true } } }))
    expect(parseAdvancedFile(readFileSync(file, 'utf8'))).toEqual({ values: { 'hive.nope': 1, 'hive.mcp.replySeconds': 400 }, madeFor: {}, unknown: ['hive.nope'] })
    s.load(dir)
    expect(s.state(null).unknown).toEqual(['hive.nope'])
    await s.set('hive.mcp.replySeconds', 600)
    expect(read(file)).toEqual({ format: 1, values: { 'hive.nope': 1, 'hive.mcp.replySeconds': 600 }, madeFor: {} })
    await expect(s.set('hive.accounts.preview', true)).rejects.toThrow('No advanced setting')
  })

  it('reads a file edited by hand: a changed CLI-facing value is made for the CLI installed now; an invalid one falls back', async () => {
    const { s, dir, file } = store()
    writeFileSync(file, JSON.stringify({ values: { 'codex.trust.prompt': 'trust it', 'codex.hooks.timeoutSeconds': 0 }, madeFor: { 'codex.trust.prompt': { version: '0.150.0', value: 'trust that' } } }))
    s.noteCli('codex', '0.162.1')
    s.load(dir)
    expect(s.state(null).madeFor['codex.trust.prompt']).toEqual({ version: '0.162.1', value: 'trust it' })
    expect(s.number('codex.hooks.timeoutSeconds')).toBe(5)
    expect(s.pattern('codex.trust.prompt').source).toBe('trust it')
    // Changed by hand while Hive runs: read again when the file changes.
    writeFileSync(file, JSON.stringify({ format: 1, values: { 'codex.trust.prompt': 'trust here' } }))
    await vi.waitFor(() => expect(s.pattern('codex.trust.prompt').source).toBe('trust here'), { timeout: 10_000 })
  })

  it('writes back the CLI version a hand edit was made for, so a restart after the CLI updates still flags it', async () => {
    const { s, dir, file } = store()
    // A value edited by hand (no record), and one whose record was for another value.
    writeFileSync(file, JSON.stringify({ values: { 'codex.trust.prompt': 'trust it', 'codex.ready.placeholder': 'Ask Codex' }, madeFor: { 'codex.ready.placeholder': { version: '0.150.0', value: 'Ask' } } }))
    s.noteCli('codex', '0.162.1')
    s.load(dir)
    await vi.waitFor(() => expect(read(file).madeFor).toEqual({ 'codex.trust.prompt': { version: '0.162.1', value: 'trust it' }, 'codex.ready.placeholder': { version: '0.162.1', value: 'Ask Codex' } }), { timeout: 10_000 })
    s.stop()
    // Hive starts again after Codex updated.
    const again = store().s
    again.noteCli('codex', '0.163.0')
    again.load(dir)
    expect(advancedRow(def('codex.trust.prompt'), again.state(null)).madeForOther).toBe('0.162.1')
    expect(again.diagnostics([null])).toContain('  - made for another CLI version than the installed one: codex.trust.prompt, codex.ready.placeholder')
  })

  it("tracks the version for every value of a CLI's, those Hive gives it too (hooks, title, tool timeout)", async () => {
    const { s, dir, file } = store()
    s.load(dir)
    s.noteCli('codex', '0.162.1')
    await s.set('codex.hooks.timeoutSeconds', 8)
    await s.set('hive.mcp.replySeconds', 600)
    expect(read(file).madeFor).toEqual({ 'codex.hooks.timeoutSeconds': { version: '0.162.1', value: 8 } })
    s.noteCli('codex', '0.163.0')
    expect(advancedRow(def('codex.hooks.timeoutSeconds'), s.state(null)).madeForOther).toBe('0.162.1')
    expect(s.diagnostics([null])).toContain('  - made for another CLI version than the installed one: codex.hooks.timeoutSeconds')
  })

  it("resets every override (keeping ids this Hive doesn't know), and refuses while the file can't be read", async () => {
    const { s, dir, file } = store()
    writeFileSync(file, JSON.stringify({ values: { 'hive.mcp.replySeconds': 600, 'hive.someday': 1 } }))
    s.load(dir)
    await s.resetAll()
    expect(read(file).values).toEqual({ 'hive.someday': 1 })
    expect(s.number('hive.mcp.replySeconds')).toBe(300)
    writeFileSync(file, '{')
    await vi.waitFor(() => expect(s.state(null).fileError).toBeTruthy(), { timeout: 10_000 })
    await expect(s.resetAll()).rejects.toThrow('Fix or delete advanced.json')
    expect(readFileSync(file, 'utf8')).toBe('{')
  })

  it("keeps the developer switch and advanced.json one value: the setting written to the file, a hand edit to the setting", async () => {
    const dir = tempDir('hive-advanced-bound-')
    const file = join(dir, 'advanced.json')
    let settings = mergeDefaults(structuredClone(DEFAULT_SETTINGS), { advanced: { showDeveloperFeatures: true } }) as AppSettings
    const listeners: ((s: AppSettings) => void)[] = []
    const cfg = {
      get settings() {
        return settings
      },
      updateSettings: (patch: Parameters<typeof mergeDefaults>[1]) => {
        settings = mergeDefaults(structuredClone(settings), patch) as AppSettings
        for (const l of listeners) l(settings)
        return settings
      },
      onSettingsChanged: (fn: (s: AppSettings) => void) => void listeners.push(fn)
    }
    try {
      advanced.load(dir)
      // A setting already on at the first start is written to the file, not turned off.
      bindAdvancedSettings(cfg as never)
      await vi.waitFor(() => expect(existsSync(file) && read(file).values).toEqual({ 'hive.showDeveloperFeatures': true }), { timeout: 10_000 })
      expect(settings.advanced.showDeveloperFeatures).toBe(true)
      // The setting changed (Settings, the Assistant, Reset): the file follows.
      cfg.updateSettings({ advanced: { showDeveloperFeatures: false } })
      await vi.waitFor(() => expect(read(file).values).toEqual({}), { timeout: 10_000 })
      // The file edited by hand: the setting follows.
      writeFileSync(file, JSON.stringify({ format: 1, values: { 'hive.showDeveloperFeatures': true } }))
      await vi.waitFor(() => expect(settings.advanced.showDeveloperFeatures).toBe(true), { timeout: 10_000 })
      expect(advanced.diagnostics([null])).toEqual(['- Advanced settings: 1 override (hive.showDeveloperFeatures)'])
      // Set from the list: the setting too.
      await advanced.set('hive.showDeveloperFeatures', false)
      await vi.waitFor(() => expect(settings.advanced.showDeveloperFeatures).toBe(false), { timeout: 10_000 })
    } finally {
      advanced.stop()
    }
  })

  it('records each CLI found together: versions learnt at once both reach the file; changes at once all land', async () => {
    const { s, dir, file } = store()
    s.load(dir)
    // Overrides made before Hive knew either CLI's version.
    await s.set('claude-code.trust.prompt', 'trust (this|the) folder')
    await s.set('codex.trust.prompt', 'trust (this|the) folder')
    expect([read(file).madeFor['claude-code.trust.prompt'].version, read(file).madeFor['codex.trust.prompt'].version]).toEqual([null, null])
    // Two provider checks finishing together, nothing awaited between them.
    s.noteCli('claude-code', '2.1.296')
    s.noteCli('codex', '0.162.1')
    await vi.waitFor(() => expect([read(file).madeFor['claude-code.trust.prompt']?.version, read(file).madeFor['codex.trust.prompt']?.version]).toEqual(['2.1.296', '0.162.1']), { timeout: 10_000 })
    expect([s.state(null).madeFor['claude-code.trust.prompt'].version, s.state(null).madeFor['codex.trust.prompt'].version]).toEqual(['2.1.296', '0.162.1'])
    await Promise.all([s.set('hive.mcp.replySeconds', 600), s.set('hive.wait.cardMaxSeconds', 700), s.set('codex.hooks.timeoutSeconds', 7), s.keep('codex.trust.prompt')])
    expect(read(file).values).toMatchObject({ 'hive.mcp.replySeconds': 600, 'hive.wait.cardMaxSeconds': 700, 'codex.hooks.timeoutSeconds': 7, 'codex.trust.prompt': 'trust (this|the) folder' })
  })

  it('changes the developer setting only once advanced.json has it: a refusal (an unreadable file, an edit meanwhile) changes neither', async () => {
    const dir = tempDir('hive-advanced-checked-')
    const file = join(dir, 'advanced.json')
    const updates: unknown[] = []
    const update = (patch: unknown) => (updates.push(patch), {} as AppSettings)
    try {
      advanced.load(dir)
      await updateSettingsChecked({ advanced: { showDeveloperFeatures: true } }, update)
      expect(read(file).values).toEqual({ 'hive.showDeveloperFeatures': true })
      expect(updates).toHaveLength(1)
      // Other settings go straight through.
      await updateSettingsChecked({ general: { showTips: false } }, update)
      expect(updates).toHaveLength(2)
      writeFileSync(file, '{')
      await vi.waitFor(() => expect(advanced.state(null).fileError).toBeTruthy(), { timeout: 10_000 })
      await expect(updateSettingsChecked({ advanced: { showDeveloperFeatures: false } }, update)).rejects.toThrow('Fix advanced.json')
      expect(updates).toHaveLength(2)
      expect(readFileSync(file, 'utf8')).toBe('{')
      // An edit made since Hive read the file: refused, the edit read.
      writeFileSync(file, JSON.stringify({ values: { 'hive.showDeveloperFeatures': true } }))
      await vi.waitFor(() => expect(advanced.state(null).fileError).toBeNull(), { timeout: 10_000 })
      advanced.stop()
      writeFileSync(file, JSON.stringify({ values: { 'hive.showDeveloperFeatures': true, 'hive.mcp.replySeconds': 400 } }))
      await expect(updateSettingsChecked({ advanced: { showDeveloperFeatures: false } }, update)).rejects.toThrow('changed outside Hive')
      expect(updates).toHaveLength(2)
      expect(advanced.number('hive.mcp.replySeconds')).toBe(400)
    } finally {
      advanced.stop()
    }
  })

  it("keeps what it read while the file can't be read, and refuses changes until it's fixed", async () => {
    const { s, dir, file } = store()
    writeFileSync(file, JSON.stringify({ values: { 'hive.mcp.replySeconds': 900 } }))
    s.load(dir)
    writeFileSync(file, '{ "values": { "hive.mcp.replySeconds": 9')
    await vi.waitFor(() => expect(s.state(null).fileError).toMatch(/isn't valid JSON/), { timeout: 10_000 })
    expect(s.number('hive.mcp.replySeconds')).toBe(900)
    await expect(s.set('hive.mcp.replySeconds', 600)).rejects.toThrow('Fix advanced.json')
    // Through the Agent API (the Assistant's PATCH /v1/settings/:id reaches this set): a refusal by the file's state, 409
    // with its words and the caller's error in metrics, never Hive's 500 (HI-1952 round 1); so is a reset of them all.
    const { apiErrorReply } = await import('../src/main/servers')
    const { apiOutcome } = await import('../src/main/metrics')
    for (const refused of [await s.set('hive.mcp.replySeconds', 600).catch((e: unknown) => e), await s.resetAll().catch((e: unknown) => e)]) {
      const reply = apiErrorReply(refused)
      expect(reply.status, String(refused)).toBe(409)
      expect(reply.body.error).toMatch(/^advanced\.json isn't valid JSON.*Fix (or delete )?advanced\.json/s)
      expect(apiOutcome({ finished: true, status: reply.status, waiting: false })).toBe('client-error')
    }
    // No setting by that id: 404.
    expect(apiErrorReply(await s.set('hive.nope', 1).catch((e: unknown) => e)).status).toBe(404)
    // The broken file is left for the user to fix.
    expect(readFileSync(file, 'utf8')).toBe('{ "values": { "hive.mcp.replySeconds": 9')
  })

  it("doesn't overwrite an edit made since it read the file", async () => {
    const { s, dir, file } = store()
    s.load(dir)
    await s.set('hive.mcp.replySeconds', 600)
    s.stop()
    writeFileSync(file, advancedFileText({ 'hive.mcp.replySeconds': 1200 }, {}))
    await expect(s.set('hive.mcp.replySeconds', 700)).rejects.toThrow('changed outside Hive')
    expect(read(file).values).toEqual({ 'hive.mcp.replySeconds': 1200 })
    expect(s.number('hive.mcp.replySeconds')).toBe(1200)
  })

  it('records the CLI version once Hive learns it, keeps an override for a new version, and counts overrides for diagnostics (names only)', async () => {
    const { s, dir, file } = store()
    s.load(dir)
    await s.set('copilot.trust.prompt', 'trust these files')
    expect(read(file).madeFor['copilot.trust.prompt'].version).toBeNull()
    s.noteCli('copilot', '1.0.95')
    await vi.waitFor(() => expect(read(file).madeFor['copilot.trust.prompt'].version).toBe('1.0.95'), { timeout: 10_000 })
    s.noteCli('copilot', '1.0.99')
    const row = advancedRow(def('copilot.trust.prompt'), s.state(null))
    expect(row.madeForOther).toBe('1.0.95')
    expect(s.diagnostics([null])).toEqual(['- Advanced settings: 1 override (copilot.trust.prompt)', '  - made for another CLI version than the installed one: copilot.trust.prompt'])
    await s.keep('copilot.trust.prompt')
    expect(read(file).madeFor['copilot.trust.prompt'].version).toBe('1.0.99')
    expect(advancedRow(def('copilot.trust.prompt'), s.state(null)).madeForOther).toBeNull()
    expect(s.diagnostics([{ 'hive.progress.lanesShown': 6 }])).toEqual(['- Advanced settings: 1 override (copilot.trust.prompt); 1 workspace value'])
    writeFileSync(file, JSON.stringify({ values: { 'hive.mcp.replySeconds': 'x', 'hive.other': 1 } }))
    await s.reload()
    expect(s.diagnostics([null])).toEqual(['- Advanced settings: 1 override (hive.mcp.replySeconds)', '  - not valid, so the default is used: hive.mcp.replySeconds', '  - unknown to this Hive: 1'])
  })

  it("the developer console's show text is off by default; turned on, its listeners hear it and diagnostics name it (#699)", async () => {
    const { s, dir } = store()
    s.load(dir)
    expect(def('hive.console.showText')).toMatchObject({ kind: 'boolean', default: false, applies: 'now' })
    expect(s.get<boolean>('hive.console.showText')).toBe(false)
    const heard: boolean[] = []
    s.onChange(() => heard.push(s.get<boolean>('hive.console.showText')))
    await s.set('hive.console.showText', true)
    expect(heard).toEqual([true])
    expect(s.diagnostics([null])).toEqual(['- Advanced settings: 1 override (hive.console.showText)'])
    await s.set('hive.console.showText', false)
    expect(heard).toEqual([true, false])
    expect(s.diagnostics([null])).toEqual(['- Advanced settings: no overrides'])
  })
})

describe('the adapters and the hive MCP server use them', () => {
  afterEach(async () => {
    await advanced.resetAll().catch(() => undefined)
    advanced.stop()
  })

  it('reads the recorded screens and messages with the defaults (fixtures)', async () => {
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    const { codex, codexTurnScreen } = await import('../src/main/providers/codex/adapter')
    const { copilot } = await import('../src/main/providers/copilot/adapter')
    const { signInRefused: copilotSignIn } = await import('../src/main/providers/copilot/events')
    const { signInRefused: codexSignIn } = await import('../src/main/providers/codex/rollout')
    const screen = (name: string): string => fixtureText(`tests/fixtures/${name}`)
    expect(claudeCode.startupQuestion.test(screen('advanced/trust-claude-2.1.296.txt'))).toBe(true)
    expect(codex.startupQuestion!.test(screen('advanced/trust-codex-0.162.1.txt'))).toBe(true)
    expect(copilot.startupQuestion!.test(screen('advanced/trust-copilot-1.0.95.txt'))).toBe(true)
    expect(copilot.readyOutput!.test(screen('advanced/ready-copilot-1.0.95.txt'))).toBe(true)
    expect(codex.readyOutput!.test(screen('screen-codex-0.162.1-idle.txt'))).toBe(true)
    expect(codexTurnScreen(screen('screen-codex-0.162.1-idle.txt'))).toBe('idle')
    const error = objectsIn(screen('advanced/signin-error-copilot-1.0.95.jsonl')).find((o) => o.type === 'session.error')!.data as Record<string, unknown>
    expect(copilotSignIn(error)).toBe(error.message)
    // Without its type, by its message alone; and the ErrorOccurred hook's.
    expect(copilotSignIn({ message: error.message })).toBe(error.message)
    expect(copilot.normalizeHook({ hook_event_name: 'ErrorOccurred', sessionId: 's', error: { message: error.message } }).event).toEqual({ kind: 'signIn', message: error.message })
    const codexError = objectsIn(screen('signin-codex-0.160.0.jsonl')).find((o) => typeof o.message === 'string' && (o.message as string).startsWith('unexpected status 401'))!
    expect(codexSignIn({ message: codexError.message })).toBe(codexError.message)
    // #685: the turn screens, Codex's queue hint and /permissions labels, and the safeguard note and question.
    const { claudeTurnScreen } = await import('../src/main/providers/claude/adapter')
    const { codexHoldsInput } = await import('../src/main/providers/codex/adapter')
    const { permissionsMenuNumber } = await import('../src/main/providers/codex/permissionsMenu')
    const { claudeSafeguards } = await import('../src/main/providers/claude/safeguards')
    expect(claudeTurnScreen(screen('screen-claude-2.1.296-idle.txt'))).toBe('idle')
    expect(codexTurnScreen(screen('screen-codex-0.162.1-working.txt'))).toBe('working')
    expect(codexHoldsInput(screen('screen-codex-0.162.1-working.txt'))).toBe(true)
    expect(codexHoldsInput(screen('screen-codex-0.162.1-idle.txt'))).toBe(false)
    expect((['read-only', 'ask', 'approve-for-me', 'full-access'] as const).map((m) => permissionsMenuNumber(screen('codex-0.161-permissions-ask.txt'), m))).toEqual(['4', '1', '2', '3'])
    const stops = claudeSafeguards(screen('advanced/safeguards-claude-2.1.296.jsonl'), {})
    expect(stops).toEqual([expect.objectContaining({ kind: 'stop', id: 'u-note' })])
    const ask = { kind: 'permission', blocking: true, message: 'Claude needs your permission' } as const
    expect(claudeCode.safeguardAsk!(ask, screen('advanced/safeguard-prompt-claude-2.1.296.txt'))).toBe(true)
    expect(claudeCode.safeguardAsk!(ask, screen('screen-claude-2.1.296-idle.txt'))).toBe(false)
    // #696: each mode's footer, from the screens recorded in it.
    const claudeScreens = { manual: 'screen-claude-2.1.296-idle.txt', acceptEdits: 'advanced/footer-claude-2.1.296-acceptEdits.txt', plan: 'advanced/footer-claude-2.1.296-plan.txt', auto: 'screen-claude-2.1.296-hive-idle.txt', bypassPermissions: 'advanced/footer-claude-2.1.296-bypassPermissions.txt', dontAsk: 'advanced/footer-claude-2.1.296-dontAsk.txt' }
    for (const [mode, file] of Object.entries(claudeScreens)) expect(claudeCode.footerMode!(screen(file)), file).toBe(mode)
    const copilotScreens = { ask: 'advanced/ready-copilot-1.0.95.txt', 'allow-all': 'advanced/footer-copilot-1.0.95-allow-all.txt', plan: 'advanced/footer-copilot-1.0.95-plan.txt', autopilot: 'advanced/footer-copilot-1.0.95-autopilot.txt' }
    for (const [mode, file] of Object.entries(copilotScreens)) expect(copilot.footerMode!(screen(file), 'plan'), file).toBe(mode)
    expect(copilot.footerMode!(screen('advanced/ready-copilot-1.0.95.txt'), 'accept-edits')).toBe('accept-edits')
    expect(copilot.footerMode!(screen('advanced/trust-copilot-1.0.95.txt'))).toBeNull()
  })

  it("reads Codex's plan limits under renamed fields once the overrides name them (the recorded token_count, renamed)", async () => {
    const dir = tempDir('hive-advanced-fields-')
    advanced.load(dir)
    const { rolloutDetails } = await import('../src/main/providers/codex/rollout')
    const recorded = fixtureText('tests/fixtures/codex-0.159.jsonl')
      .split(/\r?\n/)
      .filter((l) => l.includes('"token_count"') && l.includes('"rate_limits"'))
    expect(recorded.length).toBeGreaterThan(0)
    const before = rolloutDetails(recorded.join('\n')).planUsage
    expect(before?.limits.map((l) => l.label)).toEqual(['5-hour', 'weekly'])
    // As if Codex renamed them: rate_limits → limits, used_percent → used, window_minutes → minutes.
    const renamed = recorded.map((l) => l.replace(/"rate_limits"/g, '"limits"').replace(/"used_percent"/g, '"used"').replace(/"window_minutes"/g, '"minutes"')).join('\n')
    expect(rolloutDetails(renamed).planUsage).toBeUndefined()
    await advanced.set('codex.rateLimits.field', 'limits')
    await advanced.set('codex.rateLimits.usedPercent', 'used')
    await advanced.set('codex.rateLimits.windowMinutes', 'minutes')
    expect(rolloutDetails(renamed).planUsage).toEqual({ ...before, updatedAt: expect.any(String) })
  })

  it("reads Claude Code's plan limits from its recorded status line, and under renamed fields once the overrides name them", async () => {
    const dir = tempDir('hive-advanced-claude-fields-')
    advanced.load(dir)
    const { parseClaudePlanUsage } = await import('../src/main/providers/claude/adapter')
    const recorded = fixtureText('tests/fixtures/advanced/statusline-claude-2.1.296.json')
    const now = new Date('2026-10-12T18:00:00Z')
    const before = parseClaudePlanUsage(JSON.parse(recorded), now)
    expect(before?.limits.map((l) => [l.id, l.label, l.usedPercent])).toEqual([['five_hour', '5-hour', 15], ['seven_day', 'weekly', 57]])
    expect(before?.limits[0].resetsAt).toBe(new Date(1791832800 * 1000).toISOString())
    // As if Claude Code renamed them.
    const renamed = JSON.parse(recorded.replace(/"rate_limits"/g, '"plan_limits"').replace(/"five_hour"/g, '"h5"').replace(/"seven_day"/g, '"d7"').replace(/"used_percentage": (\d)/g, '"used": $1'))
    expect(parseClaudePlanUsage(renamed, now)).toBeNull()
    await advanced.set('claude-code.statusLine.rateLimits', 'plan_limits')
    await advanced.set('claude-code.statusLine.fiveHour', 'h5')
    await advanced.set('claude-code.statusLine.weekly', 'd7')
    await advanced.set('claude-code.statusLine.usedPercent', 'used')
    expect(parseClaudePlanUsage(renamed, now)).toEqual(before)
  })

  it("counts Claude Code's recorded background subagents, and under a renamed status and fields once the overrides name them (#1584)", async () => {
    const dir = tempDir('hive-advanced-subagents-')
    advanced.load(dir)
    const { claudeBackgroundTasks } = await import('../src/main/providers/claude/background')
    const recorded = fixtureText('tests/fixtures/advanced/subagent-launch-claude-2.1.310.jsonl') + fixtureText('tests/fixtures/advanced/subagent-resume-claude-2.1.309.jsonl')
    const summary = (text: string): string[] => claudeBackgroundTasks(text).map((e) => `${e.kind} ${e.id}${e.kind === 'start' ? ` ${e.description ?? ''}${e.resumed ? ' resumed' : ''}` : ''}`)
    const before = summary(recorded)
    expect(before).toEqual(['start ab1827f13c285365d Review pl translations part A', 'end ab1827f13c285365d', 'start a152e8fb710ad64b4  resumed'])
    // As if Claude Code renamed them: the status, the id, the description and the resume's field.
    const renamed = recorded.replace(/"async_launched"/g, '"background_started"').replace(/"agentId"/g, '"subagentId"').replace(/"description"/g, '"task"').replace(/"resumedAgentId"/g, '"resumedSubagentId"')
    expect(summary(renamed)).toEqual(['end ab1827f13c285365d'])
    await advanced.set('claude-code.subagent.launched', 'background_started')
    await advanced.set('claude-code.subagent.idField', 'subagentId')
    await advanced.set('claude-code.subagent.descriptionField', 'task')
    await advanced.set('claude-code.subagent.resumedField', 'resumedSubagentId')
    expect(summary(renamed)).toEqual(before)
  })

  it("counts Codex's recorded subagent, and under a renamed item, kind and fields once the overrides name them (#1584)", async () => {
    const dir = tempDir('hive-advanced-codex-subagents-')
    advanced.load(dir)
    const { codexBackgroundTasks } = await import('../src/main/providers/codex/background')
    const recorded = fixtureText('tests/fixtures/advanced/subagent-codex-0.164.0.jsonl')
    const summary = (text: string): string[] => codexBackgroundTasks(text).map((e) => `${e.kind} ${e.id}${e.kind === 'start' ? ` ${e.description}` : ''}`)
    const before = summary(recorded)
    expect(before).toEqual(['start 01a16de6-2c40-7ef2-b882-f6423230efbe /root/sleep_task', 'end 01a16de6-2c40-7ef2-b882-f6423230efbe'])
    const renamed = recorded.replace(/"SubAgentActivity"/g, '"SubagentEvent"').replace(/"kind": "started"/g, '"kind": "spawned"').replace(/"agent_thread_id"/g, '"thread"').replace(/"agent_path"/g, '"task_path"')
    expect(summary(renamed)).toEqual([])
    await advanced.set('codex.subagent.item', 'SubagentEvent')
    await advanced.set('codex.subagent.started', 'spawned')
    await advanced.set('codex.subagent.threadField', 'thread')
    await advanced.set('codex.subagent.taskField', 'task_path')
    expect(summary(renamed)).toEqual(before)
  })

  it('takes an override at once (patterns, the placeholder, a sign-in error) and at the next launch (hooks, title, tool timeout)', async () => {
    const dir = tempDir('hive-advanced-adapters-')
    advanced.load(dir)
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    const { codex, codexMcpServer, codexTurnScreen } = await import('../src/main/providers/codex/adapter')
    const { copilotHooks } = await import('../src/main/providers/copilot/adapter')
    await advanced.set('claude-code.trust.prompt', 'trust the workspace')
    expect(claudeCode.startupQuestion.test('Do you trust the workspace?')).toBe(true)
    expect(claudeCode.startupQuestion.test('Yes, I trust this folder')).toBe(false)
    await advanced.set('codex.ready.placeholder', 'Ask Codex (anything)')
    expect(codex.readyOutput!.test('› Ask Codex (anything)')).toBe(true)
    expect(codexTurnScreen('header\n› Ask Codex (anything)\n')).toBe('idle')
    expect(codexTurnScreen('header\n› Ask Codex to do anything\n')).toBeNull()
    await advanced.set('claude-code.signIn.stopError', 'auth_failed')
    expect(claudeCode.normalizeHook({ hook_event_name: 'StopFailure', session_id: 's', error: 'auth_failed' }).event).toEqual({ kind: 'signIn', message: null })
    // #685: the turn screens, the queue hint, a /permissions label, the safeguard question.
    const { claudeTurnScreen } = await import('../src/main/providers/claude/adapter')
    const { codexHoldsInput } = await import('../src/main/providers/codex/adapter')
    const { permissionsMenuNumber } = await import('../src/main/providers/codex/permissionsMenu')
    const done = '✻ Worked for 12s · finished 16:52\n\n❯ \n'
    expect(claudeTurnScreen(done)).toBeNull()
    await advanced.set('claude-code.turnScreen.done', String.raw`for \d+s · finished \d+:\d+`)
    expect(claudeTurnScreen(done)).toBe('idle')
    await advanced.set('codex.turnScreen.working', String.raw`\bBusy \(`)
    expect(codexTurnScreen('• Busy (3s • ctrl+c to stop)\n')).toBe('working')
    expect(codexTurnScreen('• Working (3s • esc to interrupt)\n› Ask Codex (anything)\n')).toBe('idle')
    await advanced.set('codex.queue.hint', '^tab queues')
    expect(codexHoldsInput('› draft\n  tab queues it\n')).toBe(true)
    expect(codexHoldsInput('› draft\n  tab to queue message\n')).toBe(false)
    await advanced.set('codex.permissions.readOnly', 'Read only access')
    expect(permissionsMenuNumber('  1. Ask for approval   …\n› 2. Read only access (current)  Read workspace files\n', 'read-only')).toBe('2')
    await advanced.set('claude-code.safeguard.prompt', String.raw`\bModel switch\b`)
    expect(claudeCode.safeguardAsk!({ kind: 'permission', blocking: true, message: 'Claude needs your permission' }, ' ☐ Model switch\n')).toBe(true)
    // #696: a mode's footer, as if the CLI renamed it; the mode found last on screen still wins.
    const { copilot } = await import('../src/main/providers/copilot/adapter')
    expect(claudeCode.footerMode!('  ⏸ planning on (shift+tab to cycle)')).toBeNull()
    await advanced.set('claude-code.footer.plan', String.raw`⏸ planning on\b`)
    expect(claudeCode.footerMode!('  ⏸ planning on (shift+tab to cycle)')).toBe('plan')
    expect(claudeCode.footerMode!('  ⏸ plan mode on (shift+tab to cycle)')).toBeNull()
    expect(claudeCode.footerMode!('⏸ planning on\n  ⏵⏵ auto mode on (shift+tab to cycle)')).toBe('auto')
    await advanced.set('copilot.footer.ask', String.raw`\bInteractive · Ask\b`)
    expect(copilot.footerMode!(' · Interactive · Ask First · / commands', 'accept-edits')).toBe('accept-edits')
    expect(copilot.footerMode!(' · Interactive · Manual Approval · / commands')).toBeNull()
    await advanced.set('copilot.hooks.timeoutSeconds', 15)
    await advanced.set('copilot.hooks.preToolUseTimeoutSeconds', 30)
    const hooks = (copilotHooks('http://127.0.0.1:1/hook', 't') as { hooks: Record<string, { timeoutSec: number }[]> }).hooks
    expect(hooks.Stop[0].timeoutSec).toBe(15)
    expect(hooks.PreToolUse[0].timeoutSec).toBe(30)
    await advanced.set('codex.mcp.toolTimeoutSeconds', 1800)
    expect(codexMcpServer('hive', { command: 'node' }).table?.tool_timeout_sec).toBe(1800)
    await advanced.set('codex.title.items', 'activity, spinner')
    await advanced.set('codex.hooks.timeoutSeconds', 8)
    const home = tempDir('hive-advanced-codex-home-')
    const before = process.env.CODEX_HOME
    process.env.CODEX_HOME = home
    try {
      const ctx = { projectPath: home, agentId: 'a-1', executable: 'C:\\bin\\codex.exe', cwd: home, workspacePath: home, runId: 'r', sessionId: '', resume: false, name: '', skills: [], mcpServers: {}, model: null, effort: null, permissionMode: null, extraArgs: [], hookUrl: 'http://127.0.0.1:1/hook?run=r', hookAuthFile: 'C:/hive/hook-auth/r.txt', privateDir: 'C:/hive/launches/r', guidance: '', env: {}, allowBackgroundSessions: false, use200kContext: false }
      const { args } = codex.buildCommand(ctx.executable, ctx)
      expect(args.find((a) => a.startsWith('tui.terminal_title='))).toBe('tui.terminal_title=["activity","spinner"]')
      const stop = args.find((a) => a.startsWith('hooks.Stop='))!
      expect(stop).toContain('timeout=8}')
      expect(stop).toContain('-m 8 ')
      // Codex holds the interrupt hook to 3 s.
      expect(args.find((a) => a.startsWith('hooks.Interrupt='))).toContain('timeout=3}')
    } finally {
      if (before === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = before
    }
    // The hive MCP server's reply timeout and waits, kept a minute under Codex's tool timeout.
    await advanced.set('hive.mcp.replySeconds', 600)
    await advanced.set('hive.wait.cardMaxSeconds', 3000)
    expect(mcpAdvancedEnv()).toEqual({ HIVE_REPLY_SECONDS: '600', HIVE_WAIT_MAX_SECONDS: '1740', HIVE_AGENT_WAIT_MAX_SECONDS: '600' })
    await advanced.set('codex.mcp.toolTimeoutSeconds', null)
    expect(waitMaxSeconds('cards')).toBe(840)
  })

  it('defaults to what Hive did before: 840 and 600 s waits, 300 s replies', () => {
    expect(mcpAdvancedEnv()).toEqual({ HIVE_REPLY_SECONDS: '300', HIVE_WAIT_MAX_SECONDS: '840', HIVE_AGENT_WAIT_MAX_SECONDS: '600' })
  })
})

describe("the Assistant's settings catalog", () => {
  it('has every advanced value, and a workspace\'s own where one is taken, read, checked and changed like the others', () => {
    for (const d of ADVANCED_DEFS.filter((x) => !x.setting)) {
      const e = settingEntry(`advanced.${d.id}`)
      expect(e, d.id).toBeTruthy()
      expect(e!.hidden).toBe(true)
      expect(e!.docs).toBe('advanced-settings')
      expect(!!settingEntry(`workspace.advanced.${d.id}`), d.id).toBe(!!d.workspace)
      expect(e!.restart === 'sessions', d.id).toBe(d.applies === 'sessions')
    }
    const own = ADVANCED_DEFS.filter((d) => !d.setting)
    expect(SETTINGS_CATALOG.filter((e) => e.advanced).length).toBe(own.length + own.filter((d) => d.workspace).length)
    const reply = settingEntry('advanced.hive.mcp.replySeconds')!
    expect(settingValue(reply, {} as never, null, null, {})).toBe(300)
    expect(settingValue(reply, {} as never, null, null, { 'hive.mcp.replySeconds': 600 })).toBe(600)
    expect(settingDefault(reply)).toBe(300)
    expect(checkSettingValue(reply, 20)).toMatchObject({ error: expect.any(String) })
    expect(checkSettingValue(reply, 600)).toEqual({ value: 600 })
    expect(checkSettingValue(reply, null)).toEqual({ value: null })
    expect(settingPatch(reply, 600)).toEqual({ advanced: { id: 'hive.mcp.replySeconds', scope: 'app', value: 600 } })
    expect(settingValueText(reply, 600)).toBe('600 s')
    const items = settingEntry('advanced.codex.title.items')!
    expect(checkSettingValue(items, 'activity, project-name')).toEqual({ value: ['activity', 'project-name'] })
    expect(settingValueText(items, ['activity', 'project-name'])).toBe('activity, project-name')
    const lanes = settingEntry('workspace.advanced.hive.progress.lanesShown')!
    expect(lanes.scope).toBe('workspace')
    expect(settingValue(lanes, {} as never, null, { advanced: { 'hive.progress.lanesShown': 6 } })).toBe(6)
    expect(settingValue(lanes, {} as never, null, {})).toBeNull()
    expect(checkSettingValue(lanes, 'inherit')).toEqual({ value: null })
    expect(settingPatch(lanes, 6)).toEqual({ advanced: { id: 'hive.progress.lanesShown', scope: 'workspace', value: 6 } })
    // Agents per project (#562) is Maximum agents, a workflow option, since HI-2001 (agentLimit.test.ts).
    expect(settingEntry('workspace.advanced.hive.agents.perProject')).toBeUndefined()
    expect(settingEntry('advanced.hive.agents.perProject')).toBeUndefined()
    // The developer features switch keeps its key and entry in Hive's settings, with its advanced value's text.
    expect(settingEntry('advanced.showDeveloperFeatures')).toMatchObject({ hidden: true, type: 'boolean', title: def('hive.showDeveloperFeatures').title, desc: def('hive.showDeveloperFeatures').desc })
    expect(settingEntry('advanced.hive.showDeveloperFeatures')).toBeUndefined()
  })
})
