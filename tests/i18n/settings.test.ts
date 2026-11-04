import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { PSEUDO_LANGUAGE } from '../../src/shared/i18n/languages'
import { setLanguage, setProblemReporter, tr, type Msg } from '../../src/shared/i18n'
import { APP_SETTINGS_CATALOG, PROJECT_SETTINGS_SECTIONS, SETTINGS_CATALOG, SETTINGS_SECTIONS, SETTINGS_TEXT, settingEntry, settingPath, shownSetting, shownSettingPath, type SettingEntry } from '../../src/shared/settingsCatalog'
import { ADVANCED_DEFS, advancedDef, advancedRow, advancedShown, advancedTakes, advancedTakesText, checkAdvanced, englishText, linesOf, listOf, shownText, withValues, type TextPart } from '../../src/shared/advanced'
import { parseNumberDraft, rangeText } from '../../src/shared/numberInput'
import { settingText } from '../../src/shared/toolReplies'
import { settingDetail } from '../../src/main/settingsTools'

// #793: the `settings` area. Settings shows the catalogue's rows, its sections and Advanced's list in the user's
// language, while the Hive Assistant's tools keep their English (#767: the catalogue is also the Assistant's).

const ROOT = resolve(__dirname, '../..')
const EN = JSON.parse(readFileSync(join(ROOT, 'locales/en/settings.json'), 'utf8')) as Record<string, { defaultMessage: string; description: string }>

/** Every piece of text an entry shows: its title, description, tip, choices, Off label, placeholder and confirmation. */
function textsOf(e: SettingEntry): TextPart[] {
  const t = e.text
  return [t.title, t.desc, t.tip, t.off, t.confirmOn?.title, t.confirmOn?.message, t.confirmOn?.detail, e.placeholder, ...(e.options ?? []).map((o) => o.text)].filter((x): x is TextPart => x !== null && x !== undefined)
}

/** The messages a text is made of, nested ones too. */
function messagesOf(t: TextPart, acc: Msg[] = []): Msg[] {
  if (typeof t !== 'object') return acc
  if ('id' in t) acc.push(t)
  else if ('list' in t) for (const x of t.list) messagesOf(x, acc)
  else if ('lines' in t) for (const x of t.lines) messagesOf(x, acc)
  else if ('cap' in t) messagesOf(t.cap, acc)
  else if ('shown' in t) messagesOf(t.shown, acc)
  else if ('said' in t) return acc
  else {
    acc.push(t.m)
    for (const v of Object.values(t.values)) messagesOf(v, acc)
  }
  return acc
}

const problems: string[] = []
afterEach(() => {
  setLanguage('en', {})
  setProblemReporter(() => undefined)
  problems.length = 0
})
const pseudo = (): void => {
  setProblemReporter((p) => problems.push(p))
  setLanguage(PSEUDO_LANGUAGE, {})
}

describe('the settings catalogue as Settings shows it', () => {
  it("every row's text is messages of the settings area, in the English catalogue with a note for translators", () => {
    for (const e of SETTINGS_CATALOG)
      for (const m of textsOf(e).flatMap((t) => messagesOf(t))) {
        // A language's own name, the permission and file lock modes' names (the agents area's, #885; the CLI's own setting's,
        // #1284), and the workflow
        // options' words, the Workflow section's own (#1278: the workflow area's, glossary 2.6).
        if (m.id.startsWith('language.') || m.id.startsWith('workflow.') || /^agents\.(claude|codex|copilot|cliOwn|fileLock)\./.test(m.id)) continue
        expect(m.id, e.id).toMatch(/^settings\./)
        expect(EN[m.id], `${e.id}: ${m.id}`).toEqual({ defaultMessage: m.defaultMessage, description: m.description })
        expect(m.description.length, m.id).toBeGreaterThan(10)
      }
  })

  it('shows every row in another language, every placeholder given, with no problem reported', () => {
    pseudo()
    for (const e of SETTINGS_CATALOG) {
      const shown = shownSetting(e)
      for (const t of textsOf(e)) {
        const s = shownText(t)
        expect(s, e.id).not.toMatch(/\{\w+\}/)
        // The pseudo-locale brackets every message: text that isn't one (a name, a pattern) shows plain.
        if (typeof t === 'object') expect(s, e.id).toContain('[')
      }
      expect(shown.title, e.id).not.toBe(e.title)
    }
    expect(problems).toEqual([])
  })

  it("keeps the English for the Assistant's tools whatever the language shown", () => {
    const before = SETTINGS_CATALOG.map((e) => [e.id, e.title, e.desc, e.tip, settingPath(e)])
    pseudo()
    expect(SETTINGS_CATALOG.map((e) => [e.id, e.title, e.desc, e.tip, settingPath(e)])).toEqual(before)
    for (const e of SETTINGS_CATALOG) {
      expect(englishText(e.text.title), e.id).toBe(e.title)
      if (e.text.desc) expect(englishText(e.text.desc), e.id).toBe(e.desc)
      if (e.text.tip) expect(englishText(e.text.tip), e.id).toBe(e.tip)
      for (const o of e.options ?? []) expect(englishText(o.text), `${e.id}: ${o.value}`).toBe(o.label)
    }
  })

  it('reads as before in English: a row, its choices, a confirmation, its path', () => {
    const quit = settingEntry('general.confirmOnQuit')!
    expect(shownSetting(quit).title).toBe('Confirm before quitting')
    expect(quit.options?.map((o) => shownText(o.text))).toEqual(['When an agent is working', 'Whenever sessions are running', 'Never'])
    const danger = settingEntry('claude-code.enableDangerousMode')!
    expect(danger.confirmOn?.title).toBe('Enable the Bypass permissions option?')
    expect(shownText(danger.text.confirmOn!.title)).toBe('Enable the Bypass permissions option?')
    expect(shownSettingPath(settingEntry('sessions.transcriptWarnMB')!)).toBe('Settings → Sessions → Warn when a transcript is over')
  })

  it("a dangerous mode's opt-in names its modes as one list, with the grammar of how many", () => {
    const copilot = settingEntry('copilot.enableDangerousMode')!
    expect(copilot.title).toBe('Enable the Autopilot option')
    expect(shownText(withValues((copilot.text.title as { m: Msg }).m, { n: 2, names: listOf(['Autopilot', 'Allow all']) }))).toBe('Enable the Autopilot and Allow all options')
    expect(englishText(listOf(['"A"', '"B"', '"C"'], 'disjunction'))).toBe('"A", "B" or "C"')
    expect(englishText(linesOf(['one', withValues({ id: 'settings.x', defaultMessage: '{n} two', description: 'test' }, { n: 2 })]))).toBe('one\n2 two')
  })

  it("names permission modes and file lock modes in the language shown: the choices, the tips and the texts that quote them (#885)", () => {
    pseudo()
    const english = ['Block', 'Ask me', 'Approve for me', 'Accept edits', 'Bypass permissions', 'Full access', 'Autopilot']
    const shown = (id: string): string[] => {
      const e = settingEntry(id)
      expect(e, id).toBeTruthy()
      const s = shownSetting(e!)
      return [s.title, s.desc, s.tip, ...(e!.options ?? []).map((o) => shownText(o.text)), ...(e!.text.confirmOn ? [shownText(e!.text.confirmOn.title)] : [])]
    }
    for (const id of ['workflow.git.fileLocks', 'workspace.workflow.none.fileLocks', 'project.workflow.fileLocks', 'claude-code.enableDangerousMode', 'codex.enableDangerousMode', 'copilot.enableDangerousMode'])
      for (const text of shown(id)) for (const name of english) expect(text, `${id}: ${name}`).not.toContain(name)
    expect(problems).toEqual([])
  })

  it('names a section and the Language row as the user sees them; the title in another language also says its English', () => {
    pseudo()
    for (const s of [...SETTINGS_SECTIONS, ...PROJECT_SETTINGS_SECTIONS]) {
      if (!s.provider) expect(shownText(s.text.label), s.id).not.toBe(s.label)
      expect(shownText(s.text.desc), s.id).not.toBe(s.desc)
    }
    // A provider's page is its name, in any language.
    expect(shownText(SETTINGS_SECTIONS.find((s) => s.id === 'provider:codex')!.text.label)).toBe('Codex')
    const lang = shownSetting(settingEntry('general.language')!)
    expect(lang.title).toMatch(/\(Language\)$/)
    expect(shownSetting(settingEntry('general.closeToTray')!).title).not.toMatch(/Close to tray/)
    expect(problems).toEqual([])
  })

  it('a row that depends on another says why in the language shown', () => {
    const e = APP_SETTINGS_CATALOG.find((x) => x.id === 'general.progressCommands')!
    const off = { general: { progressPanel: false } } as never
    expect(shownText(e.disabledBy!(off)!)).toBe('Turn on the Progress panel to use this.')
    pseudo()
    expect(shownText(e.disabledBy!(off)!)).toMatch(/^\[Ţüŕñ öñ ţĥé Þŕöĝŕéšš þáñéļ/)
    expect(e.disabledBy!({ general: { progressPanel: true } } as never)).toBeNull()
  })
})

describe("Settings → Advanced's text", () => {
  const reply = advancedDef('hive.mcp.replySeconds')!

  it('keeps each value\'s English for the tools and errors; Settings shows its messages', () => {
    for (const d of ADVANCED_DEFS) {
      expect(englishText(d.text.title), d.id).toBe(d.title)
      expect(englishText(d.text.desc), d.id).toBe(d.desc)
    }
    expect(advancedTakes(reply)).toBe('A whole number of seconds, 30 to 3600.')
    const bad = checkAdvanced(reply, 5)
    expect(bad).toMatchObject({ error: 'hive tools: reply timeout takes a whole number from 30 to 3600.' })
    pseudo()
    // The value's title, itself a message, inside the reason.
    expect('error' in bad && shownText(bad.errorText)).toMatch(/^\[\[ĥíṽé ţööļš: ŕéþļý ţíɱéöüţ/)
    expect(advancedTakes(reply)).toBe('A whole number of seconds, 30 to 3600.')
    expect(shownText(advancedTakesText(reply))).toMatch(/^\[Á ŵĥöļé ñüɱƀéŕ öƒ šéçöñðš, 30 ţö 3600\./)
    for (const d of ADVANCED_DEFS) {
      expect(shownText(d.text.title), d.id).toContain('[')
      expect(shownText(d.text.desc), d.id).toContain('[')
    }
    expect(problems).toEqual([])
  })

  it("an override that isn't taken, or no longer finds the CLI's text, says so as shown; the English stays for the log", () => {
    const state = (values: Record<string, unknown>, workspace: Record<string, unknown> | null = null) => ({ values, madeFor: {}, workspace, cli: {} })
    const row = advancedRow(reply, state({ 'hive.mcp.replySeconds': 5 }))
    expect(row.problem).toBe('hive tools: reply timeout takes a whole number from 30 to 3600.')
    const lanes = advancedDef('hive.progress.lanesShown')!
    const own = advancedRow(lanes, state({}, { 'hive.progress.lanesShown': 99 }))
    expect(own.problem).toBe("This workspace's: Progress panel: lanes shown takes a whole number from 1 to 24.")
    const placeholder = advancedDef('codex.ready.placeholder')!
    const miss = advancedRow(placeholder, state({ 'codex.ready.placeholder': 'zzz' }))
    expect(miss.miss).toBe(`It doesn't find what Codex 0.162.1 showed ("› Ask Codex to do anything"). Fine if Codex has changed since.`)
    pseudo()
    expect(shownText(row.problemText!)).toContain('[')
    expect(shownText(own.problemText!)).toMatch(/^\[Ţĥíš ŵöŕķšþáçé'š:/)
    expect(shownText(miss.missText!)).toContain('Codex 0.162.1')
    expect(row.problem).toBe('hive tools: reply timeout takes a whole number from 30 to 3600.')
    expect(problems).toEqual([])
  })

  it("shows a value's unit in the language shown, with plurals", () => {
    expect(advancedShown(reply, 300)).toBe('300 s')
    expect(advancedShown(advancedDef('hive.progress.lanesShown')!, 1)).toBe('1 lane')
    expect(advancedShown(advancedDef('hive.progress.lanesShown')!, 4)).toBe('4 lanes')
    expect(advancedShown(advancedDef('hive.showDeveloperFeatures')!, true)).toBe('on')
    pseudo()
    expect(advancedShown(advancedDef('hive.progress.lanesShown')!, 4)).toMatch(/^\[4 ļáñéš/)
  })
})

describe('with a translation loaded (as a language file gives it)', () => {
  it("a provider that is off is one message, so the language places the mark around the name (#793 round 1)", () => {
    expect(EN['settings.provider.off'].defaultMessage).toBe('{provider} (off)')
    expect(tr(SETTINGS_TEXT.providerOff, { provider: 'Codex' })).toBe('Codex (off)')
    setLanguage('de', { 'settings.provider.off': '{provider} (aus)' }, 'de-DE')
    expect(tr(SETTINGS_TEXT.providerOff, { provider: 'Codex' })).toBe('Codex (aus)')
    setLanguage('ja', { 'settings.provider.off': '（オフ）{provider}' }, 'ja-JP')
    expect(tr(SETTINGS_TEXT.providerOff, { provider: 'Codex' })).toBe('（オフ）Codex')
  })

  it("a value typed into Advanced's list is refused in the language shown, its title too; the tools keep the English (#793 round 1)", () => {
    const field = advancedDef('codex.rateLimits.field')!
    const refused = checkAdvanced(field, '0bad')
    if (!('error' in refused)) throw new Error('0bad was taken')
    expect(refused.error).toBe('Session file: plan limits field takes a field name: letters, digits and _ (not starting with a digit).')
    setProblemReporter((p) => problems.push(p))
    setLanguage('de', { 'settings.advanced.error.field': '{title} nimmt einen Feldnamen: Buchstaben, Ziffern und _ (keine Ziffer am Anfang).', 'settings.advanced.codex.rateLimits.field.title': 'Sitzungsdatei: Feld der Planlimits' }, 'de-DE')
    expect(shownText(refused.errorText)).toBe('Sitzungsdatei: Feld der Planlimits nimmt einen Feldnamen: Buchstaben, Ziffern und _ (keine Ziffer am Anfang).')
    expect(refused.error).toMatch(/^Session file: plan limits field takes/)
    expect(problems).toEqual([])
  })

  it("a language that quotes mode names quotes each one in a dangerous mode's opt-in; the English stays bare (#904)", () => {
    const zh = Object.assign({}, ...['settings', 'agents'].map((a) => JSON.parse(readFileSync(join(ROOT, `locales/zh-CN/${a}.json`), 'utf8')) as Record<string, string>))
    setProblemReporter((p) => problems.push(p))
    setLanguage('zh-CN', zh, 'zh-CN')
    for (const id of ['claude-code.enableDangerousMode', 'codex.enableDangerousMode', 'copilot.enableDangerousMode']) {
      const e = settingEntry(id)!
      const s = shownSetting(e)
      expect([s.title, s.tip, shownText(e.text.confirmOn!.title)], id).toEqual([expect.stringMatching(/^启用“[^“”]+”选项$/), expect.stringMatching(/^只有连接可以选择“[^“”]+”。/), expect.stringMatching(/^启用“[^“”]+”选项？$/)])
    }
    // Two modes (as Copilot's were, #461): each in its own quotes, not the whole list in one pair (“Autopilot和Allow all”).
    const copilot = settingEntry('copilot.enableDangerousMode')!
    const quote: Msg = { id: 'settings.provider.enableDangerousMode.quoted', ...EN['settings.provider.enableDangerousMode.quoted'] }
    const two = { n: 2, names: listOf(['Autopilot', 'Allow all']), quotedNames: listOf(['Autopilot', 'Allow all'].map((mode) => withValues(quote, { mode }))) }
    const titled = (t: TextPart | null | undefined): string => shownText(withValues((t as { m: Msg }).m, two))
    expect([titled(copilot.text.title), titled(copilot.text.tip), titled(copilot.text.confirmOn?.title)]).toEqual([expect.stringMatching(/^启用“Autopilot”和“Allow all”选项$/), expect.stringMatching(/^只有连接可以选择“Autopilot”和“Allow all”。/), '启用“Autopilot”和“Allow all”选项？'])
    // What the Assistant's tools read doesn't follow it.
    const claude = settingEntry('claude-code.enableDangerousMode')!
    expect([claude.title, claude.confirmOn?.title, englishText(claude.text.title)]).toEqual(['Enable the Bypass permissions option', 'Enable the Bypass permissions option?', 'Enable the Bypass permissions option'])
    expect(problems).toEqual([])
  })
})

describe("a number setting's box", () => {
  it('says its range in the language shown, its numbers grouped', () => {
    expect(rangeText({ min: 1000, max: 100000 })).toBe('Between 1,000 and 100,000')
    expect(parseNumberDraft('5', { min: 1000, max: 100000 })).toEqual({ kind: 'invalid', message: 'Between 1,000 and 100,000.' })
    pseudo()
    expect(parseNumberDraft('', { min: 1 }, { badInput: true })).toEqual({ kind: 'invalid', message: expect.stringMatching(/^\[Éñţéŕ á ñüɱƀéŕ\. \[1 öŕ ɱöŕé/) })
    expect(problems).toEqual([])
  })
})

describe("the Assistant's cw_read_setting (#793: shownAs)", () => {
  const e = settingEntry('sessions.transcriptWarnMB')!

  it('in English, names the setting once: no shownAs', () => {
    const d = settingDetail(e, null)
    expect(d.path).toBe('Settings → Sessions → Warn when a transcript is over')
    expect(d.shownAs).toBeUndefined()
    expect(settingText(d)).not.toContain('The user sees it as')
  })

  it('in another language, also says where the user sees it, in their words; the rest stays English', () => {
    pseudo()
    const d = settingDetail(e, null)
    expect(d.path).toBe('Settings → Sessions → Warn when a transcript is over')
    expect(d.desc).toBe(e.desc)
    expect(d.shownAs).toBe(shownSettingPath(e))
    expect(d.shownAs).toMatch(/^\[Šéţţíñĝš/)
    expect(settingText(d)).toContain(`The user sees it as: ${d.shownAs}.`)
  })
})

