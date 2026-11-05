import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser'
import { PSEUDO_LANGUAGE } from '../../src/shared/i18n/languages'
import { setLanguage, setProblemReporter, tr, type Msg } from '../../src/shared/i18n'
import { keepAwakeText } from '../../src/shared/keepAwake'
import { badgeDescription } from '../../src/shared/taskbar'
import { changeOutcome, folderPlan, KIND_LABEL } from '../../src/shared/antivirus'
import { lostLines, reuseNote, unusedState, unusedSummary, unusedWorkNotice, CHANGES_ABOUT } from '../../src/shared/unusedWorktrees'
import type { UnusedWorktree } from '../../src/shared/types'

// #807: the `workspace` area (the status bar and activity bar, the Workspace Overview, Settings → Workspace's storage,
// antivirus and hidden projects, Remove Project, Repair a Moved Workspace, updates, the notice banners, the docs view's
// own words, unused worktrees, and the shared texts behind them). Its messages are read from the English catalogue
// (tests/i18nCatalogues.test.ts checks it is current); the sentences once built by hand read as before in English;
// GitHub issue #1's plan limits tooltip is words of the window's language around the data; and what the Agent API
// says about a reused worktree stays English.

const ROOT = resolve(__dirname, '../..')
const CATALOGUE = JSON.parse(readFileSync(join(ROOT, 'locales/en/workspace.json'), 'utf8')) as Record<string, { defaultMessage: string; description: string }>
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

/** Some value for each placeholder: a number where it is a plural's or a number's. */
function sampleValues(message: string): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  const walk = (els: MessageFormatElement[]): void => {
    for (const el of els) {
      if (el.type === TYPE.plural || el.type === TYPE.number) out[el.value] = 2
      else if (el.type === TYPE.argument || el.type === TYPE.select) out[el.value] ??= 'X'
      if (el.type === TYPE.plural || el.type === TYPE.select) for (const o of Object.values(el.options)) walk(o.value)
      if (el.type === TYPE.tag) walk(el.children)
    }
  }
  walk(parse(message))
  return out
}

const tree = (check: Partial<UnusedWorktree['check']>, branch: string | null = 'hive/b4'): UnusedWorktree => ({ path: 'D:/w/.worktrees/b4', branch, check: { removable: false, into: 'main', ...check } }) as UnusedWorktree

describe('the workspace area', () => {
  it('has its messages, each with a note for translators, all under workspace.', () => {
    expect(Object.keys(CATALOGUE).length).toBeGreaterThan(400)
    for (const [id, c] of Object.entries(CATALOGUE)) {
      expect(id.startsWith('workspace.'), id).toBe(true)
      expect(c.description.length, id).toBeGreaterThan(10)
    }
  })

  it("its typed values list every message's placeholders", () => {
    const dts = readFileSync(join(ROOT, 'src/shared/i18n/values/workspace.d.ts'), 'utf8')
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

describe("GitHub issue #1: the status bar's plan limits tooltip", () => {
  it('reads as before in English, the window named by its size, the percent and when it resets', () => {
    expect(tr(m('workspace.statusBar.planLine'), { provider: 'Claude Code', hasPlan: 'yes', plan: 'max' })).toBe('Claude Code (max plan)')
    expect(tr(m('workspace.statusBar.limitLine'), { window: 'fiveHour', label: '5-hour', used: 0.42, hasReset: 'yes', when: 'in 2 h 5 min' })).toBe('5-hour limit: 42% used, resets in 2 h 5 min')
    expect(tr(m('workspace.statusBar.limitLine'), { window: 'weekly', label: 'weekly', used: 0.86, hasReset: 'yes', when: 'Sat 14:02' })).toBe('Weekly limit: 86% used, resets Sat 14:02')
    expect(tr(m('workspace.statusBar.limitLine'), { window: 'other', label: 'Monthly', used: 0.1, hasReset: 'no', when: '' })).toBe('Monthly limit: 10% used')
    expect(tr(m('workspace.statusBar.asOf'), { when: '4 minutes ago' })).toBe('As of 4 minutes ago. Updates while a session is running.')
    expect(tr(m('workspace.statusBar.shortLimit'), { window: 'weekly', label: 'weekly' })).toBe('Week')
  })

  it("in another language every word around the data is the language's, and the percent its format", () => {
    setLanguage('pl', { 'workspace.statusBar.limitLine': '{window, select, fiveHour {Limit 5-godzinny} weekly {Limit tygodniowy} other {Limit {label}}}: wykorzystano {used, number, ::percent}{hasReset, select, yes {, odnowienie {when}} other {}}' }, 'pl-PL')
    expect(tr(m('workspace.statusBar.limitLine'), { window: 'weekly', label: 'weekly', used: 0.86, hasReset: 'yes', when: 'sob. 14:02' })).toBe(`Limit tygodniowy: wykorzystano ${new Intl.NumberFormat('pl-PL', { style: 'percent' }).format(0.86)}, odnowienie sob. 14:02`)
  })
})

describe('the sentences once built by hand read as before, in English', () => {
  it('the status bar and the taskbar', () => {
    expect(keepAwakeText(1)).toBe('Keeping the PC awake: 1 agent working')
    expect(keepAwakeText(3)).toBe('Keeping the PC awake: 3 agents working')
    expect(badgeDescription(1)).toBe('1 needs you')
    expect(badgeDescription(2)).toBe('2 need you')
    expect(tr(m('workspace.statusBar.running'), { count: 4, working: 1, background: 1, waiting: 0 })).toBe('4 running session(s): 1 working, 1 waiting on background tasks, 0 waiting for you')
    expect(tr(m('workspace.statusBar.running'), { count: 1, working: 1, background: 0, waiting: 0 })).toBe('1 running session(s): 1 working, 0 waiting for you')
  })

  it('unused worktrees', () => {
    expect(unusedState(tree({ removable: true }))).toBe('Merged into main · clean')
    expect(unusedState(tree({ ahead: 1, dirty: 2 }))).toBe('1 commit not on main · 2 changed files')
    expect(unusedState(tree({ ahead: 3 }, null))).toBe('3 commits on no branch')
    expect(unusedSummary([tree({ removable: true }), tree({ ahead: 1 })])).toBe('2 unused worktrees (1 merged)')
    expect(unusedWorkNotice([tree({ ahead: 1 })])).toBe("1 unused worktree has work that isn't on main")
    expect(lostLines({ path: 'D:/x', branch: null, into: null, ahead: 1, dirty: 2 })).toEqual(['1 commit on no branch (only its detached HEAD has it)', '2 uncommitted files in D:/x', 'the files git ignores in its folder (build output, copied .env files)'])
    expect(CHANGES_ABOUT.unused('hive')).toBe('Worktrees no agent of hive works in: open one to see its changes and merge them, or remove it.')
    expect(CHANGES_ABOUT.unusedTip('main')).toMatch(/^Kept when their agent was removed \(by hand, or when a template's agents replaced it\), .*Loading a template gives none of them to its agents\. Those merged into main and clean can go with their branches; the others hold work that is nowhere else\.$/)
    expect(CHANGES_ABOUT.unusedTip(null)).not.toMatch(/merged into/)
    // #1562: 1.0's templates make agents without worktrees, so loading one gives no unused worktree back.
    expect(CHANGES_ABOUT.unusedTip('main')).not.toMatch(/gives them back/)
  })

  it("antivirus: a change's outcome, and the folders", () => {
    expect(changeOutcome('add', { started: false, cancelled: true }, null).message).toBe('The administrator prompt was declined: nothing changed.')
    expect(changeOutcome('add', { started: false, error: 'no shell' }, null).message).toBe("Windows couldn't start the administrator prompt: no shell")
    expect(changeOutcome('add', { started: true }, { ok: true, listed: true, exclusions: ['D:\\w'], requested: ['D:\\w'] }).message).toBe('Defender no longer scans this folder.')
    expect(changeOutcome('remove', { started: true }, { ok: true, listed: true, exclusions: [], requested: ['D:\\a', 'D:\\b'] }).message).toBe('Removed 2 exclusions Combwork added.')
    expect(changeOutcome('add', { started: true }, { ok: true, listed: true, exclusions: [], requested: ['D:\\a'] }).message).toBe("Defender accepted the change but doesn't list one folder: your organisation's settings probably override local exclusions.")
    expect(folderPlan({ root: 'D:\\', trees: null, tests: null }, [])[0].unsafe).toBe('a whole drive')
    expect(tr(KIND_LABEL.worktrees)).toBe('Its worktrees')
  })
})

describe("what Combwork works out follows the window's language; what agents read doesn't", () => {
  it('worked out under the pseudo-locale', () => {
    setLanguage(PSEUDO_LANGUAGE, {})
    expect(keepAwakeText(2)).toMatch(/^\[/)
    expect(unusedState(tree({ removable: true }))).toMatch(/^\[.*main.*\]$/)
    expect(changeOutcome('add', { started: false, cancelled: true }, null).message).toMatch(/^\[/)
    expect(reuseNote({ reused: true, branch: 'hive/b4', base: 'main', upTo: '66ce11b0' } as never, tr)).toMatch(/^\[.*hive\/b4.*66ce11b.*\]$/)
  })

  it("a reused worktree's note stays English for the Agent API and the log (no tr given)", () => {
    setLanguage(PSEUDO_LANGUAGE, {})
    expect(reuseNote({ reused: true, branch: 'hive/b4', base: 'main', upTo: '66ce11b0' } as never)).toBe('reused hive/b4, brought up to main at 66ce11b')
    expect(reuseNote({ reused: false, branch: 'hive/b4' } as never)).toBe("made a new worktree, leaving hive/b4's unused one as it is (not checked)")
  })
})
