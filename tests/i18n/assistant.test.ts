import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser'
import { PSEUDO_LANGUAGE } from '../../src/shared/i18n/languages'
import { setLanguage, setProblemReporter, tr, type Msg } from '../../src/shared/i18n'
import { isAgentTemplate, readTemplate, shownProblem } from '../../src/shared/templates'
import { englishText, shownText, type Text } from '../../src/shared/advanced'
import { connectionValues, templateLoadDetail } from '../../src/shared/templateLoad'
import type { ConnectionOption } from '../../src/shared/templateConnections'
import { findSecretWarnings } from '../../src/main/mcpSecrets'
import { LEVEL_NAME } from '../../src/main/assistantControl'
import { assistantStatusLine } from '../../src/shared/assistantStatus'
import { installSourceText } from '../../src/shared/providers'
import type { AppSettings } from '../../src/shared/types'

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

const settings = { defaultProvider: 'claude-code', providers: { 'claude-code': { enabled: true, defaultModel: '', defaultEffort: '', defaultPermissionMode: 'default' } } } as unknown as AppSettings

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
      [problem({ version: 2, name: 'T', agents: [{ name: 'A', provider: 'claude-code', role: 'boss' }] }), "A's role in the workflow isn't builder, reviewer, either or generalist."],
      [problem({ version: 2, name: 'T', agents: [{ name: 'A', mcpServers: 'all' }] }), "A's MCP servers aren't a list Hive can use."]
    ]
    for (const [t, english] of cases) expect(shownText(t)).toBe(english)
    const empty = problem({ version: 2, name: 'T', agents: [] })
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

  it("the Load template plan, as before in English", () => {
    const plan = {
      remove: [{ id: 'a', name: 'Dev', running: false, dirty: 0, worktree: { path: 'D:/x/site/dev', branch: 'hive/dev' } }],
      create: [{ name: 'Dev', role: 'builder' as const, provider: 'claude-code' as const }]
    }
    const high: ConnectionOption = { id: 'c-1', name: 'Claude · High', account: 'a-1', accountName: 'Personal', cli: 'claude-code', model: 'opus', effort: 'high' }
    const text = templateLoadDetail(plan, () => high, settings)
    expect(text).toContain('Removed:\n• Dev (its worktree and branch hive/dev stay): replaced by a new agent with the same name\n')
    expect(text).toContain('• Dev — Builder (new): Claude · High (opus · High)')
    expect(text).toMatch(/\n\nTheir conversations stay in the Sessions tab, and their open cards go back \(Active ones to Todo\)\. The layout becomes the template's\.$/)
  })

  it("names a connection's permission mode in the language shown (#889: it said Auto in a Japanese window)", () => {
    setLanguage(PSEUDO_LANGUAGE, {})
    const shown = connectionValues({ id: 'c-1', name: 'Own', account: 'a-1', accountName: 'Personal', cli: 'claude-code', permissionMode: 'acceptEdits' }, settings)
    expect(shown).toContain('[')
    expect(shown).not.toContain('Accept edits')
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
    expect(tr(m('assistant.loadNames.filledNote'), { projects: 'beta', count: 1, names: 'Dev' })).toBe('Agent names are unique across the workspace, and this name is taken already: Dev (projects: beta). A free name is filled in below. Change any name you like.')
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
    // Every kind of what needs you says what it is (#1632 round 1: sign-in and errors read "has finished").
    expect(tr(m('assistant.panel.attention'), { kind: 'signin' })).toBe('needs you to sign in')
    expect(tr(m('assistant.panel.attention'), { kind: 'error' })).toBe('was stopped by an error')
    expect(tr(m('assistant.panel.attention'), { kind: 'failed' })).toBe("couldn't start")
    for (const kind of ['waiting', 'signin', 'question', 'error', 'safeguard', 'failed'] as const) expect(tr(m('assistant.panel.attention'), { kind }), kind).not.toBe('has finished')
    expect(tr(m('assistant.panel.openCard'), { number: 'AM-12', known: 'yes', column: 'Review' })).toBe('Open card AM-12, in Review')
    expect(tr(m('assistant.panel.progress'), { run: 'e2e: 4/12', hasStep: 'yes', step: 'agents' })).toBe('Progress: e2e: 4/12 (agents)')
    expect(tr(m('assistant.sidebar.expandTip'), { hasKey: 'yes', key: 'Ctrl+Alt+B' })).toBe('Expand Sidebar (Ctrl+Alt+B)')
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
