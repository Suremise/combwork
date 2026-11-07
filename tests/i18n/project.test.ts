import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser'
import { PSEUDO_LANGUAGE } from '../../src/shared/i18n/languages'
import { setLanguage, setProblemReporter, tr, type Msg } from '../../src/shared/i18n'
import { PROJECT_TABS, instructionsStarter } from '../../src/shared/projectTabs'
import { PERIODS, costText, money, moneyLabel } from '../../src/shared/usageTotals'
import { unpricedText } from '../../src/shared/prices'
import { providerName } from '../../src/shared/providers'

// #805: the `project` area (the project's header and tabs, the Overview and its plan limits, Changes, Memory, Skills,
// MCP and Project Settings, with the shared tab list, periods and costs). Its messages are read from the English
// catalogue (tests/i18nCatalogues.test.ts checks it is current); the sentences once built by hand read as before in
// English; data kept at module level (the tab list, the periods) follows a change of language; and the window's
// costs are Intl's while money() stays fixed English for what agents read.

const ROOT = resolve(__dirname, '../..')
const CATALOGUE = JSON.parse(readFileSync(join(ROOT, 'locales/en/project.json'), 'utf8')) as Record<string, { defaultMessage: string; description: string }>
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

describe('the project area', () => {
  it('has its messages, each with a note for translators, all under project.', () => {
    expect(Object.keys(CATALOGUE).length).toBeGreaterThan(250)
    for (const [id, c] of Object.entries(CATALOGUE)) {
      expect(id.startsWith('project.'), id).toBe(true)
      expect(c.description.length, id).toBeGreaterThan(10)
    }
  })

  it("its typed values list every message's placeholders", () => {
    const dts = readFileSync(join(ROOT, 'src/shared/i18n/values/project.d.ts'), 'utf8')
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

describe('data kept at module level follows the language', () => {
  it("the tabs' labels are messages, shown when drawn", () => {
    expect(PROJECT_TABS.map((t) => tr(t.label))).toEqual(['Session', 'Overview', 'Performance', 'Tasks', 'Sessions', 'Files', 'Attachments', 'Version Control', 'Activity', 'Memory', 'Skills', 'Templates', 'MCP', 'Settings'])
    setLanguage(PSEUDO_LANGUAGE, {})
    expect(tr(PROJECT_TABS[0].label)).toMatch(/^\[Šéššíöñ/)
  })

  it("the periods' labels are read again each time", () => {
    expect(PERIODS.map((p) => p.label)).toEqual(['Today', '7 days', '30 days', 'All time'])
    setLanguage(PSEUDO_LANGUAGE, {})
    expect(PERIODS[0].label).toMatch(/^\[Ţöðáý/)
  })
})

describe('plurals take the count itself', () => {
  it("so a language with more forms picks its own (a provider's prompts in Polish)", () => {
    setLanguage('pl', { 'project.card.promptsSub': '{count, plural, one {# prompt} few {# prompty} many {# promptów} other {# promptu}}' }, 'pl-PL')
    expect([1, 2, 5, 22, 1.5].map((count) => tr(m('project.card.promptsSub'), { count }))).toEqual(['1 prompt', '2 prompty', '5 promptów', '22 prompty', '1,5 promptu'])
  })
})

describe("what agents read stays English, whatever the window's language", () => {
  it("a new instructions file from Memory: the English starter under the project's own name", () => {
    setLanguage(PSEUDO_LANGUAGE, {})
    expect(instructionsStarter('Żółw app', providerName('codex'))).toBe('# Żółw app\n\nInstructions for Codex in this project.\n')
    setLanguage('pl', {}, 'pl-PL')
    expect(instructionsStarter('alpha', providerName('claude-code'))).toBe('# alpha\n\nInstructions for Claude Code in this project.\n')
    expect(Object.keys(CATALOGUE).some((id) => /Instructions for/.test(CATALOGUE[id].defaultMessage))).toBe(false)
  })

  it('its first lines name whom the file applies to (HI-2667): the project, a connection in every project, or every project', () => {
    setLanguage('pl', {}, 'pl-PL')
    const claude = providerName('claude-code')
    // A project's file (CLAUDE.md, .claude/CLAUDE.md, CLAUDE.local.md, AGENTS.md): its project.
    expect(instructionsStarter('hive', claude)).toBe('# hive\n\nInstructions for Claude Code in this project.\n')
    // A connection's (its home's CLAUDE.md or AGENTS.md): its name, never the project's.
    expect(instructionsStarter('hive', claude, { connection: 'Anthropic-1' })).toBe('# Anthropic-1\n\nInstructions for Claude Code agents on this connection, in every project.\n')
    expect(instructionsStarter('hive', providerName('codex'), { connection: 'Work' })).toBe('# Work\n\nInstructions for Codex agents on this connection, in every project.\n')
    // The user's own (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md, Copilot's copilot-instructions.md): every project.
    expect(instructionsStarter('hive', claude, 'user')).toBe('# All projects\n\nInstructions for Claude Code in every project.\n')
    expect(instructionsStarter('hive', providerName('copilot'), 'user')).toBe('# All projects\n\nInstructions for GitHub Copilot in every project.\n')
  })
})

describe('costs', () => {
  it('read in English as before, through Intl', () => {
    expect(moneyLabel(1.2)).toBe('$1.20')
    expect(moneyLabel(0)).toBe('$0.00')
    expect(moneyLabel(0.004)).toBe('< $0.01')
    expect(moneyLabel(150.4)).toBe('$150')
    expect(costText({ cost: 1.2, estimated: true, priced: 1, unpriced: 1 })).toBe('≈ $1.20 + ?')
    expect(costText({ cost: 0, estimated: false, priced: 0, unpriced: 2 })).toBe('Unknown')
    expect(unpricedText('gpt-9', 'Codex')).toBe("Combwork has no API price for gpt-9, so it can't estimate this session's cost. Add one in Settings → Codex → API prices.")
  })

  it("follow the window's language, while money() stays fixed English for agents", () => {
    setLanguage('pl', {}, 'pl-PL')
    expect(moneyLabel(1.2).replace(/\s/g, ' ')).toBe('1,20 USD')
    expect(money(1.2)).toBe('$1.20')
    expect(money(150.4)).toBe('$150')
  })

  it("the chart's other projects", () => {
    expect(tr(m('project.chart.other'), { count: 2 })).toBe('Other (2)')
  })
})

describe('the sentences once built by hand read as before, in English', () => {
  it("the project header's batch actions", () => {
    expect(tr(m('project.header.startNew'), { many: 'yes', count: 3 })).toBe('Start New (3)')
    expect(tr(m('project.header.startNew'), { many: 'no', count: 1 })).toBe('Start New')
    expect(tr(m('project.header.removeAllMenu'), { many: 'yes', count: 3 })).toBe('Remove All (3)…')
    expect(tr(m('project.header.stopAllTip'), { count: 1 })).toBe('Stop the running agent')
    expect(tr(m('project.header.stopAllTip'), { count: 10 })).toBe('Stop all 10 running agents')
    expect(tr(m('project.header.resumeAllTip'), { count: 2 })).toBe('Resume all 2 stopped agents')
    expect(tr(m('project.header.carryOnManyTip'), { stopped: 0, stalled: 1 })).toBe('Carry on the agent a refused sign-in stopped (other running ones are left alone)')
    expect(tr(m('project.header.carryOnManyTip'), { stopped: 2, stalled: 3 })).toBe('Resume the 2 stopped agents and carry on the 3 agents a refused sign-in stopped (other running ones are left alone)')
    expect(tr(m('project.header.carryOnManyTip'), { stopped: 1, stalled: 1 })).toBe('Resume the stopped agent and carry on the agent a refused sign-in stopped (other running ones are left alone)')
  })

  it('the banners', () => {
    expect(tr(m('project.banner.restartNeeded'), { many: 'yes', agent: 'One' })).toBe("Skills, MCP servers, dialects or settings changed since One's session started. Restart the session to apply them — the conversation continues.")
    expect(tr(m('project.banner.dangerous'), { modes: 'Bypass', count: 1 })).toBe('Bypass is on in this project: the agent runs every command and edit without asking.')
  })

  it('the Overview and its plan limits (GitHub issue #1)', () => {
    expect(tr(m('project.card.withoutPrice'), { count: 1 })).toBe('1 session without a price')
    expect(tr(m('project.card.compactionsSub'), { count: 2 })).toBe('2 compactions')
    expect(tr(m('project.card.promptsSub'), { count: 1 })).toBe('1 prompt')
    expect(tr(m('project.card.promptsSub'), { count: 1234 })).toBe('1,234 prompts')
    expect(tr(m('project.chart.dayTip'), { day: 'Fri 10 Oct', tokens: '1.2M', cost: '$1.00', prompts: 1 })).toBe('Fri 10 Oct: 1.2M tokens · $1.00 · 1 prompt')
    expect(tr(m('project.card.warmLeft'), { left: '3 min', ttl: 'minutes' })).toBe('≈ 3 min left of 5 min TTL')
    expect(tr(m('project.limit.title'), { window: 'fiveHour', label: '' })).toBe('5-hour limit')
    expect(tr(m('project.limit.title'), { window: 'weekly', label: '' })).toBe('Weekly limit')
    expect(tr(m('project.limit.title'), { window: 'other', label: 'Monthly' })).toBe('Monthly limit')
    expect(tr(m('project.limit.resets'), { when: 'in 2 h 5 min' })).toBe('used · resets in 2 h 5 min')
    expect(tr(m('project.limit.heading'), { plan: 'max', when: '4m ago' })).toBe('Plan limits (max), account-wide, as of 4m ago')
    expect(tr(m('project.limit.heading'), { plan: 'none', when: '4m ago' })).toBe('Plan limits, account-wide, as of 4m ago')
  })

  it('Changes, Memory and Project Settings', () => {
    expect(tr(m('project.changes.status'), { status: 'untracked' })).toBe('Untracked')
    expect(tr(m('project.changes.status'), { status: 'U' })).toBe('Conflict')
    expect(tr(m('project.changes.staged'), { status: 'Modified', path: 'a.ts' })).toBe('Modified (staged): a.ts')
    expect(tr(m('project.apply.new'), { live: 'yes' })).toBe('Changes apply to new sessions — restart the running session to apply them.')
    expect(tr(m('project.skills.assistantOnly'), { count: 1 })).toBe("1 Combwork skill is for the Assistant only, so it isn't listed: this project's agents don't get it.")
    expect(tr(m('project.settings.inherit'), { value: 'on' })).toBe('Inherit (on)')
  })
})
