// Dialects (HI-2065), card 5c (HI-2441): the settings catalogue and the Assistant's settings tools. In the Default they
// read exactly as the code's English did; a dialect's override of a row's message or of the tools' own words reaches what
// the tools say while the entry keeps its English (Settings', searching's); and under the canary every word the tools say
// of a setting comes through the catalogue.
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import * as electron from 'electron'
import { inDefaultDialect, setProcessChain, type DialectChain } from '../src/shared/agentText'
import { canaryProblems, canaryTexts } from '../src/shared/agentText/canary'
import { SETTINGS_CATALOG, agentSetting, checkSettingValue, settingChangeTexts, settingEntry, settingOptions, settingPath, settingReadOnly, settingValueText } from '../src/shared/settingsCatalog'
import { tempDir } from './tempDir'
// @ts-expect-error: a plain .mjs module without types
import { readCatalogue } from '../scripts/agentTextExtract.mjs'

const ROOT = join(__dirname, '..')
type Catalogue = Record<string, { text: string; audience?: string }>
const catalogue = readCatalogue(ROOT) as Catalogue
const ids = new Set(Object.keys(catalogue))
const chain = (texts: Record<string, string>): DialectChain => ({ texts, files: ['test.json'], hash: 'test' })
const canary = (): void => setProcessChain(chain(canaryTexts(catalogue)))
const entry = (id: string) => settingEntry(id)!

/** The permission modes a provider's "Enable the … option" names: the CLIs' own names for them, not Hive's wording. */
const MODE_NAMES = ['agents.claude.bypass', 'agents.codex.fullAccess', 'agents.copilot.autopilot']

/** The window's message ids in a text, nested ones too. */
function messageIds(t: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(t)) for (const x of t) messageIds(x, out)
  else if (t && typeof t === 'object') {
    const o = t as Record<string, unknown>
    if (typeof o.id === 'string' && typeof o.defaultMessage === 'string') out.add(o.id)
    for (const v of Object.values(o)) messageIds(v, out)
  }
  return out
}

afterEach(() => setProcessChain(null))

describe('the settings catalogue in the Default', () => {
  it('says what it always said', () => {
    expect(agentSetting(entry('sessions.compactSuggestTokens')).title).toBe(entry('sessions.compactSuggestTokens').title)
    expect(settingPath(entry('sessions.compactSuggestTokens'))).toBe('Settings → Sessions → Suggest compacting above')
    expect(settingReadOnly(entry('assistant.control'))).toBe("These are the Assistant's own permissions: only the user can change it, in Settings → Assistant → Control.")
    expect(checkSettingValue(entry('general.showTips'), 'maybe')).toEqual({ error: `${entry('general.showTips').title} takes true or false.` })
    expect(settingValueText(entry('board.colors'), { a: 1, b: 2 })).toBe('(2 keys)')
    expect(settingValueText(entry('codex.modelFallback'), [1])).toBe('(1 entries)')
    expect(settingValueText(entry('codex.modelFallback'), [])).toBe("(Combwork's list)")
    expect(settingChangeTexts(entry('codex.prices'), {}, {}, { old: ['m'], new: [] })).toEqual({ oldText: 'm: removed', newText: "m: Combwork's price" })
    // A number above a thousand stays as the tools wrote it, never grouped.
    expect(checkSettingValue(entry('sessions.usageCacheSize'), 1)).toEqual({ error: `${entry('sessions.usageCacheSize').title} takes 100 to 50000.` })
  })

  it('lists every message the tools say of a setting in the catalogue, the rows\' as audience "both"', () => {
    // Nested ones too, which the canary can't tell apart (it marks the message they are said in).
    const said = new Set<string>()
    for (const e of SETTINGS_CATALOG) if (!e.action) messageIds([e.text.title, e.text.desc, e.text.tip, e.text.off, (e.options ?? []).map((o) => o.text)], said)
    expect([...said].filter((id) => !ids.has(id))).toEqual(MODE_NAMES)
    expect(catalogue['settings.sessions.compactSuggestTokens.title']?.audience).toBe('both')
    expect(catalogue['settings.advanced.hive.recorder.keep.desc']?.audience).toBe('both')
    expect(catalogue['settings.agent.helps.general.keepAwake']?.audience).toBeUndefined()
  })
})

describe('a dialect over the settings', () => {
  it("reaches a row's title, its path and the tools' own words, while the entry keeps its English", () => {
    const e = entry('general.showTips')
    const english = e.title
    setProcessChain(chain({ 'settings.general.showTips.title': 'Daily tips', 'settings.agent.error.boolean': '{title}: true or false only.', 'settings.agent.helps.general.showTips': 'Tips annoy them.' }))
    expect(agentSetting(e).title).toBe('Daily tips')
    expect(settingPath(e)).toBe('Settings → General → Daily tips')
    expect(checkSettingValue(e, 'maybe')).toEqual({ error: 'Daily tips: true or false only.' })
    expect(e.title).toBe(english)
    // A record kept for later says it in the Default.
    expect(inDefaultDialect(() => settingPath(e))).toBe(`Settings → General → ${english}`)
  })

  it("reaches a select's labels, by which the Assistant can also name a choice", () => {
    const e = entry('appearance.theme')
    const first = settingOptions(e)![0]
    setProcessChain(chain({ [(e.options![0].text as { id: string }).id]: 'Clair' }))
    expect(settingOptions(e)![0]).toMatchObject({ value: first.value, label: 'Clair' })
    expect(checkSettingValue(e, 'clair')).toEqual({ value: first.value })
  })
})

describe('the canary dialect over the settings tools', async () => {
  const base = tempDir('hive-agenttext-settings-')
  ;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  const { createWorkspaceService, inWorkspace, workspace } = await import('../src/main/workspace')
  const { settingDetail, settingRows } = await import('../src/main/settingsTools')
  const path = join(base, 'ws')
  mkdirSync(join(path, 'alpha', '.hive'), { recursive: true })
  mkdirSync(join(path, '.hive'), { recursive: true })
  writeFileSync(join(path, 'alpha', '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [], workflow: { platform: 'git', preset: null, options: {} } }))
  const w = createWorkspaceService()
  await w.open(path)

  it("finds every word of a setting's detail, its listing and its refusals in the catalogue", async () => {
    await inWorkspace(w, async () => {
      const project = { name: 'alpha', config: await workspace.projectConfig(join(path, 'alpha')) }
      canary()
      const problems: string[] = []
      for (const e of SETTINGS_CATALOG) {
        if (e.action) continue
        // What isn't wording: ids, values and choices as written, numbers, a heading of the user guide (docs).
        const values = [e.id, ...(settingOptions(e) ?? []).map((o) => o.value), 'inherit', 'low', 'high', 'Low']
        const d = settingDetail(e, project)
        for (const [field, text] of Object.entries({ title: d.title, path: d.path, takes: d.takes, desc: d.desc, tip: d.tip, helps: d.helps, restart: d.restart, readOnly: d.readOnly })) {
          if (text) problems.push(...canaryProblems(text, ids, values).map((p) => `${e.id} ${field}: ${p}`))
        }
        for (const raw of ['maybe', -1e9, [{}], {}, 'x'.repeat(600)]) {
          const r = checkSettingValue(e, raw, { efforts: () => [{ value: 'low', label: 'Low' }] })
          if ('error' in r) problems.push(...canaryProblems(r.error, ids, [...values, 'maybe', 'undefined']).map((p) => `${e.id} error: ${p}`))
        }
      }
      for (const r of [...settingRows({ query: '', project }), ...settingRows({ query: 'advanced' })]) {
        // Its desc is its first sentence, cut: the detail's checks it whole.
        problems.push(...canaryProblems(r.title, ids, [r.id]).map((p) => `${r.id} row: ${p}`))
      }
      expect(problems).toEqual([])
    })
  })
})
