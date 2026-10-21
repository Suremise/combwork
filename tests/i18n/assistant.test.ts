import { afterEach, describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser'
import { PSEUDO_LANGUAGE } from '../../src/shared/i18n/languages'
import { setLanguage, setProblemReporter, tr, type Msg } from '../../src/shared/i18n'
import { isAgentTemplate, readTemplate, shownProblem, templateLimitText } from '../../src/shared/templates'
import { englishText, shownText, type Text } from '../../src/shared/advanced'
import { oldWorktreesNotice, templateAgentParts, templateLoadDetail, templateLoadView } from '../../src/shared/templateLoad'
import { findSecretWarnings } from '../../src/main/mcpSecrets'
import { LEVEL_NAME } from '../../src/main/assistantControl'
import { assistantStatusLine } from '../../src/shared/assistantStatus'
import { installSourceText } from '../../src/shared/providers'
import type { AppSettings, ProjectConfig } from '../../src/shared/types'
import type { ModelInfo } from '../../src/shared/models'

// #806: the `assistant` area (the Assistant's panel and view, its modes, the Skills, Templates, Shared Notes, MCP and
// Projects sidebars, the template dialogs, and the template and MCP secret texts Hive works out). Its messages are read
// from the English catalogue (tests/i18nCatalogues.test.ts checks it is current); the sentences once built by hand read
// as before in English; the Load template plan marks the defaults from the values, never from a label's words (labels
// are in the window's language); and what the Assistant itself reads stays English.

const ROOT = resolve(__dirname, '../..')
const CATALOGUE = JSON.parse(readFileSync(join(ROOT, 'locales/en/assistant.json'), 'utf8')) as Record<string, { defaultMessage: string; description: string }>
const M: Record<string, Msg> = Object.fromEntries(Object.entries(CATALOGUE).map(([id, m]) => [id, { id, ...m }]))
const m = (id: string): Msg => {
  expect(M[id], id).toBeTruthy()
  return M[id]
}

afterEach(() => {
  setLanguage('en', {})
  setProblemReporter(() => undefined)
})

/** A message's placeholders (tags aside). */
function placeholders(els: MessageFormatElement[], acc = new Set<string>()): Set<string> {
  for (const el of els) {
    if (el.type === TYPE.literal || el.type === TYPE.pound) continue
    if (el.type !== TYPE.tag) acc.add(el.value)
    if (el.type === TYPE.plural || el.type === TYPE.select) for (const o of Object.values(el.options)) placeholders(o.value, acc)
    if (el.type === TYPE.tag) placeholders(el.children, acc)
  }
  return acc
}

/** Some value for each placeholder: a number where it is a plural's. */
function sampleValues(message: string): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  const walk = (els: MessageFormatElement[]): void => {
    for (const el of els) {
      if (el.type === TYPE.plural) out[el.value] = 2
      else if (el.type === TYPE.argument || el.type === TYPE.select || el.type === TYPE.number) out[el.value] ??= el.type === TYPE.number ? 2 : 'X'
      if (el.type === TYPE.plural || el.type === TYPE.select) for (const o of Object.values(el.options)) walk(o.value)
      if (el.type === TYPE.tag) walk(el.children)
    }
  }
  walk(parse(message))
  return out
}

const cfg = { providers: {}, defaultProvider: undefined } as unknown as Pick<ProjectConfig, 'providers' | 'defaultProvider'>
const settings = { defaultProvider: 'claude-code', providers: { 'claude-code': { enabled: true, defaultModel: '', defaultEffort: '', defaultPermissionMode: 'default' } } } as unknown as AppSettings
const info: ModelInfo = { defaultModel: 'claude-opus-5-5', catalog: { source: 'cli', version: null, at: '', models: [{ value: 'opus', resolved: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' }] } } as unknown as ModelInfo

describe('the assistant area', () => {
  it('has its messages, each with a note for translators, all under assistant.', () => {
    expect(Object.keys(CATALOGUE).length).toBeGreaterThan(400)
    for (const [id, c] of Object.entries(CATALOGUE)) {
      expect(id.startsWith('assistant.'), id).toBe(true)
      expect(c.description.length, id).toBeGreaterThan(10)
    }
  })

  it("its typed values list every message's placeholders", () => {
    const dts = readFileSync(join(ROOT, 'src/shared/i18n/values/assistant.d.ts'), 'utf8')
    for (const [id, c] of Object.entries(CATALOGUE)) {
      const line = dts.split(/\r?\n/).find((l) => l.trim().startsWith(`'${id}':`))
      expect(line, id).toBeTruthy()
      const names = [...placeholders(parse(c.defaultMessage))]
      if (!names.length) expect(line, id).toMatch(/: undefined$/)
      for (const n of names) expect(line, `${id}: ${n}`).toContain(`${n}: `)
    }
  })

  it('the pseudo-locale formats every message, with nothing reported', () => {
    const problems: string[] = []
    setProblemReporter((p) => problems.push(p))
    setLanguage(PSEUDO_LANGUAGE, {})
    for (const [id, c] of Object.entries(CATALOGUE)) {
      if (/<\w+>/.test(c.defaultMessage)) continue
      expect(tr(M[id], sampleValues(c.defaultMessage)), id).toMatch(/^\[.*\]$/s)
    }
    expect(problems).toEqual([])
  })
})

describe('what Hive works out in shared code is in the language when it is worked out', () => {
  it("a template file's problems: text, in the language shown when shown, English for the log (#870)", () => {
    const problem = (raw: unknown): Text => {
      const t = readTemplate(raw)
      if (isAgentTemplate(t)) throw new Error('it read a template')
      return t
    }
    const cases: [Text, string][] = [
      [problem('nope'), "It isn't a Hive agent template."],
      [problem({ version: 1, name: 'T', agents: [{ name: 'A', provider: 42 }] }), "A's coding agent isn't one Hive can use (none)."],
      [problem({ version: 1, name: 'T', agents: [{ name: 'A', provider: 'claude-code', effort: 'x y' }] }), "A's effort isn't one Hive can use."],
      [templateLimitText(24, 12), 'It has 24 agents, and this project can have up to 12 (Settings → Advanced → Agents per project).']
    ]
    for (const [t, english] of cases) expect(shownText(t)).toBe(english)
    const empty = problem({ version: 1, name: 'T', agents: [] })
    // The same text follows a change of language: a listed template's problem too.
    setLanguage(PSEUDO_LANGUAGE, {})
    expect(shownText(cases[0][0])).toMatch(/^\[Íţ íšñ'ţ/)
    expect(shownText(empty)).toMatch(/^\[Íţ ĥáš ñö áĝéñţš/)
    expect(shownProblem({ problem: englishText(empty), problemText: empty })).toMatch(/^\[Íţ ĥáš ñö áĝéñţš/)
    expect(shownProblem({ problem: 'Stored English' })).toBe('Stored English')
    for (const [t, english] of cases) expect(englishText(t)).toBe(english)
  })

  it("an MCP server's literal secrets", () => {
    expect(findSecretWarnings({ command: 'x', env: { GITHUB_TOKEN: 'ghp_abcdefghijkl' }, headers: { Authorization: 'Bearer sk-abcdefghijk' }, args: ['sk-abcdefgh'] })).toEqual([
      'env "GITHUB_TOKEN" looks like a literal secret. Use an environment variable reference such as "${GITHUB_TOKEN}".',
      'header "Authorization" looks like a literal secret. Use an environment variable reference such as "${AUTHORIZATION}".',
      'An argument starting "sk-abc…" looks like a literal secret.'
    ])
    setLanguage(PSEUDO_LANGUAGE, {})
    const [w] = findSecretWarnings({ command: 'x', env: { GITHUB_TOKEN: 'ghp_abcdefghijkl' } })
    expect(w).toMatch(/^\[.*GITHUB_TOKEN.*\$\{GITHUB_TOKEN\}.*\]$/)
  })

  it("the Load template plan and the notice after it, as before in English", () => {
    const plan = {
      remove: [{ id: 'a', name: 'Dev', running: false, dirty: 0, worktree: { path: 'D:/x/site/dev', branch: 'hive/dev' } }],
      create: [{ name: 'Dev', role: 'builder', provider: 'claude-code' as const, worktree: true }],
      worktrees: [{ branch: 'hive/dev-2', path: 'D:/x/site/dev-2', base: 'main', notReused: 'hive/dev has 1 uncommitted file' }],
      oldWorktrees: [{ path: 'D:/x/site/dev', removable: false, why: '2 commits not merged into main' }],
      setup: 'npm install'
    } as unknown as Parameters<typeof templateLoadDetail>[0]
    const text = templateLoadDetail(plan, cfg, settings, () => info)
    expect(text).toContain('Removed:\n• Dev (its worktree and branch hive/dev stay: 2 commits not merged into main): replaced by a new agent with the same name\n')
    expect(text).toContain('• Dev — builder (new): Claude Code, Opus 5.5 (default) · Medium (default)')
    expect(text).toContain('    own worktree on hive/dev-2 (from main) in D:/x/site/dev-2 (new: hive/dev has 1 uncommitted file)')
    expect(text).toMatch(/\n\nEach new worktree runs the project's setup command \(npm install\) before its agent first starts\.\nTheir conversations stay in the Sessions tab, and their open cards go back \(Doing ones to Todo\)\. The layout becomes the template's\.$/)
    expect(oldWorktreesNotice([{ branch: 'hive/a', removed: true }])).toEqual({ level: 'success', title: 'Removed an old worktree', detail: 'hive/a, with its branch: merged and clean.' })
    expect(oldWorktreesNotice([{ branch: 'hive/a', removed: false }, { branch: 'hive/b', removed: false, why: 'dirty' }])).toEqual({ level: 'warning', title: '2 old worktrees were kept', detail: 'hive/a: kept.\nhive/b: kept (dirty).' })
  })

  it("marks the defaults from the values, never from a label's words: the same in any language", () => {
    const agents = [
      { name: 'Own', provider: 'claude-code' as const, model: 'opus', effort: 'high' as const, permissionMode: 'acceptEdits' as const, worktree: false },
      { name: 'Left', provider: 'claude-code' as const, worktree: false }
    ]
    const marks = (): boolean[][] => agents.map((a) => Object.values(templateAgentParts(a, cfg, settings, info)).map((s) => !!s?.isDefault))
    const english = marks()
    expect(english).toEqual([
      [false, false, false],
      [true, true, true]
    ])
    // A language whose default mark is other words: the marks, and the setting's own name without them, stay.
    setLanguage('pl', { 'assistant.templateLoad.isDefault': '{setting} (domyślnie)' }, 'pl-PL')
    expect(marks()).toEqual(english)
    const left = templateLoadView({ remove: [], create: [agents[1]], worktrees: [null], setup: null }, cfg, settings, () => info).created[0]
    expect(left.model.text).toBe('Opus 5.5')
    expect(templateLoadDetail({ remove: [], create: [agents[1]], worktrees: [null], setup: null }, cfg, settings, () => info)).toContain('Opus 5.5 (domyślnie) · Medium (domyślnie)')
  })

  it("names the permission mode in the language shown (#889: it said Auto in a Japanese window)", () => {
    setLanguage(PSEUDO_LANGUAGE, {})
    const parts = templateAgentParts({ name: 'Own', provider: 'claude-code', permissionMode: 'acceptEdits', worktree: false }, cfg, settings, info)
    expect(parts.mode?.text).toContain('[')
    expect(parts.mode?.text).not.toContain('Accept edits')
  })
})

describe('the sentences once built by hand read as before, in English', () => {
  it('counts', () => {
    expect(tr(m('assistant.sidebar.needYou'), { count: 1 })).toBe('1 agent needs you')
    expect(tr(m('assistant.sidebar.needYou'), { count: 3 })).toBe('3 agents need you')
    expect(tr(m('assistant.panel.counts'), { running: 2, projects: 1 })).toBe('2 running · 1 project')
    expect(tr(m('assistant.panel.inactive'), { count: 2 })).toBe('2 inactive projects')
    expect(tr(m('assistant.view.unpriced'), { count: 1 })).toBe('1 conversation without a price')
    expect(tr(m('assistant.templates.rowDesc'), { count: 1, layout: 'Two columns' })).toBe('1 agent · Two columns layout')
    expect(tr(m('assistant.templates.savedDetail'), { name: 'Pair', count: 2, layout: tr(m('assistant.templates.layoutPhrase'), { layout: 'columns2' }) })).toBe('"Pair": 2 agents, two columns layout.')
    expect(tr(m('assistant.loadNames.takenNote'), { projects: 'beta', count: 1, names: 'Dev' })).toBe('Agent names are unique across the workspace, and beta already has an agent called Dev: give it other names below.')
  })

  it("who gets a skill, and where it goes", () => {
    expect(tr(m('assistant.skills.copiedDetail'), { audience: 'assistant' })).toBe('The Hive Assistant now gets it as a Hive skill, from their next session.')
    expect(tr(m('assistant.skills.copiedDetail'), { audience: 'agents' })).toBe('The project agents now get it as a Hive skill, from their next session.')
    expect(tr(m('assistant.skills.deleteHive'), { audience: 'all' })).toMatch(/^It's removed from the workspace, so new sessions of the project agents and the Hive Assistant no longer get it\./)
    expect(tr(m('assistant.skills.deleteLocal'), { known: 'yes', provider: 'Codex' })).toBe('Codex agents in this project no longer load it in new sessions.')
    expect(tr(m('assistant.skills.deleteLocal'), { known: 'no', provider: '' })).toBe('The agents in this project no longer load it in new sessions.')
    expect(tr(m('assistant.modes.deleteMessage'), { file: 'advisor.md', bundled: 'yes' })).toBe('advisor.md goes to the Recycle Bin. It ships with Hive, so you can restore it later.')
  })

  it('templates: where they are kept, and the import', () => {
    expect(tr(m('assistant.templates.where'), { name: 'Pair', scope: 'workspace', project: '' })).toBe('"Pair", in the workspace.')
    expect(tr(m('assistant.templates.clashMessage'), { name: 'Pair', scope: 'project', project: 'alpha' })).toBe('alpha already has "Pair".')
    expect(tr(m('assistant.templates.clashMessage'), { name: 'Pair', scope: 'workspace', project: '' })).toBe('The workspace already has "Pair".')
    expect(tr(m('assistant.templates.importMessage'), { count: 2, hasUnknown: 'no', unknown: '' })).toBe('2 agents. Where should it be kept?')
    expect(tr(m('assistant.templates.importedDetail'), { name: 'Pair', scope: 'workspace', project: '', hasUnknown: 'yes', unknown: 'It uses x.' })).toBe('"Pair", in the workspace. It uses x.')
  })

  it("the Assistant's panel", () => {
    expect(tr(m('assistant.panel.namesTip'), { shown: 'yes' })).toBe("Show only the agents' state marks (names on hover)")
    expect(tr(m('assistant.panel.namesTip'), { shown: 'no' })).toBe("Show the agents' names beside their state marks")
    expect(tr(m('assistant.panel.attention'), { kind: 'question' })).toBe('has a question for you')
    expect(tr(m('assistant.panel.openCard'), { number: 'AM-12', known: 'yes', column: 'Review' })).toBe('Open card AM-12, in Review')
    expect(tr(m('assistant.panel.progress'), { run: 'e2e: 4/12', hasStep: 'yes', step: 'agents' })).toBe('Progress: e2e: 4/12 (agents)')
    expect(tr(m('assistant.sidebar.expandTip'), { hasKey: 'yes', key: 'Ctrl+Alt+B' })).toBe('Expand Sidebar (Ctrl+Alt+B)')
  })
})

describe("the modes Hive ships: their names are window text, their files aren't", () => {
  it('each shipped mode has a message for its name, matching the name its file ships with (what modeName compares)', () => {
    const shipped = readdirSync(join(ROOT, 'resources/modes')).filter((f) => f.endsWith('.md'))
    expect(shipped.length).toBeGreaterThan(0)
    const names = Object.entries(CATALOGUE)
      .filter(([id]) => id.startsWith('assistant.modes.shipped.'))
      .map(([, c]) => c.defaultMessage)
    for (const f of shipped) {
      const name = /^name:\s*(.+)$/m.exec(readFileSync(join(ROOT, 'resources/modes', f), 'utf8'))?.[1].trim()
      expect(names, f).toContain(name)
    }
    expect(names).toHaveLength(shipped.length)
  })
})

describe("the Assistant panel's status line is window text (#885)", () => {
  const says = (l: ReturnType<typeof assistantStatusLine>): string => `${l.text}${l.cards.map((n) => `#${n}`).join(' ')}${l.after}`
  it('every status, a card watch with its chips, and what else wants the user, in the language shown', () => {
    setLanguage(PSEUDO_LANGUAGE, {})
    const at = (iso: string): string => iso.slice(11, 16)
    const watch = { cards: [271, 273], changes: [], column: 'review' as const, label: 'Waiting for #271, #273 → Review', since: '2026-10-07T20:00:00.000Z', limitAt: '2026-10-07T22:22:00.000Z' }
    const lines = [
      assistantStatusLine(null, at),
      assistantStatusLine({ status: 'ready' }, at),
      assistantStatusLine({ status: 'finished', backgroundTasks: 2 }, at),
      assistantStatusLine({ status: 'working' }, at),
      assistantStatusLine({ status: 'background', backgroundTasks: 1 }, at),
      assistantStatusLine({ status: 'waiting' }, at),
      assistantStatusLine({ status: 'signin' }, at, ['Stop a busy agent?']),
      assistantStatusLine({ status: 'error' }, at),
      assistantStatusLine({ status: 'watching', watch }, at),
      assistantStatusLine({ status: 'watching', watch: { ...watch, cards: [], agents: ['B6'], label: 'Waiting for B6 to finish' } }, at),
      assistantStatusLine({ status: 'working', question: { text: 'Which one?', since: '' } }, at),
      assistantStatusLine({ status: 'ready', untakenLine: { since: '', text: '[Hive] #1' } }, at),
      assistantStatusLine({ status: 'working' }, at, ['A?', 'B?'])
    ]
    for (const l of lines) expect(says(l)).toContain('[')
    for (const l of lines) expect(says(l)).not.toMatch(/Waiting|Idle|Working|Not running|Error|watch until|approval|question/)
    // The cards stay chips, between the words before and after them.
    const cards = lines[8]
    expect(cards.cards).toEqual([271, 273])
    expect(cards.after).toContain('22:22')
  })

  it('names where a CLI was found in the language shown; PATH, npm and WinGet are names', () => {
    setLanguage(PSEUDO_LANGUAGE, {})
    expect(installSourceText('settings', tr)).not.toBe('settings')
    expect(installSourceText('native install', tr)).toContain('[')
    expect(installSourceText('PATH', tr)).toBe('PATH')
    expect(installSourceText(null, tr)).toBe('')
  })
})

describe('what the Assistant reads stays English', () => {
  it("the control levels its refusals name don't follow the window's language", () => {
    setLanguage(PSEUDO_LANGUAGE, {})
    expect(LEVEL_NAME).toEqual({ look: 'Look and advise', agents: 'Control agents', projects: 'Control agents and create projects' })
  })
})
