// The workflow core's text in every language (#1264, SPEC §16.8.3): each refusal's three sentences render in each locale
// with sample values (no placeholder left, no English where a translation exists), the names in their values (a stage,
// a move, a rule) and what a platform couldn't read shown through their own messages, and Hive's For you requests kept
// as data beside their English.
import { afterEach, describe, expect, it } from 'vitest'
import { fmt, setLanguage, tr } from '../../src/shared/i18n'
import { msg, type Msg } from '../../src/shared/i18n/msg'
import { availableLanguages, loadCatalogue } from '../../src/shared/i18n/catalogues'
import { REFUSALS, refusal, refusalLines, type RefusalFormat, type RefusalValues, type RuleId } from '../../src/shared/workflow/refusals'
import { FOR_YOU, MOVE_NAMES, RULE_NAMES, UNREAD_NOTES, UNREADABLE, unreadWhy, workflowEnglish, workflowLine, workflowText } from '../../src/shared/workflow/texts'
import { STAGE_TEXT } from '../../src/shared/workflow/stages'
import { unknown } from '../../src/main/platform/types'
import { GUARDS } from '../../src/shared/workflow/pieces'
import { B1, commit, moved, setup, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import en from '../../locales/en/workflow.json'
import board from '../../locales/en/board.json'

const LOCALES = ['de', 'es', 'fr', 'ja', 'pl', 'pt-BR', 'zh-CN']

const WINDOW: RefusalFormat = { one: (m, values) => tr(m, values), list: (items) => fmt.list(items), names: true }

/** A value for every placeholder the refusals have. */
const SAMPLE: RefusalValues = {
  card: 'AM-12',
  revision: 'a3f2c1d',
  reason: 'waits for the design',
  waitsFor: 'AM-3',
  side: 'builder',
  // submit.focusedChosen (HI-1367): why its pick couldn't choose.
  state: 'unknown',
  design: 'AM-12/s40',
  waiting: 'AM-12/s44',
  step: 'followUp',
  minutes: 12,
  files: 'src/a.ts',
  path: 'node_modules/pad/index.js',
  folder: 'D:\\work\\am',
  commit: 'b4c5d6e',
  submitted: 'e89aa2f',
  head: 'bd6ff9d',
  current: 'bd6ff9d',
  command: 'npm test',
  check: 'unit',
  email: 'team@example.com',
  // submit.identity (HI-2266): a commit with another identity; 'yes' (git has none) is rendered on its own below.
  missing: 'no',
  runs: 'unit tests',
  submission: 3,
  latest: 4,
  target: 'main',
  stage: 'approved',
  move: 'start review',
  moves: 'submit, put back',
  stages: 'todo, active, done',
  intent: 'report merge',
  rules: 'submit.checksPassed, approval.given',
  key: 'AM-12',
  earlier: 'AM-11',
  line: 'hive/b1',
  alias: '#1061',
  what: workflowText(UNREADABLE.head, { where: 'D:\\work\\am' }),
  rule: 'submit.checksPassed',
  cause: 'passes',
  n: 1,
  q: 2
}

const messages = (rule: RuleId): Msg[] => [REFUSALS[rule].message, REFUSALS[rule].next, ...(REFUSALS[rule].change ? [REFUSALS[rule].change!] : [])]

afterEach(() => setLanguage('en', {}))

describe('the workflow text in every locale', () => {
  it('has every locale, each with every workflow message translated', async () => {
    expect(availableLanguages()).toEqual(expect.arrayContaining(LOCALES))
    for (const code of LOCALES) {
      const cat = await loadCatalogue(code)
      const missing = Object.keys(en).filter((id) => typeof cat[id] !== 'string')
      expect(missing, code).toEqual([])
    }
  })

  it('renders every refusal in each locale with sample values: no placeholder left, no English where a translation exists', async () => {
    const english = Object.fromEntries((Object.keys(REFUSALS) as RuleId[]).map((rule) => [rule, refusalLines(rule, SAMPLE, WINDOW)]))
    for (const code of LOCALES) {
      const cat = await loadCatalogue(code)
      setLanguage(code, cat, code)
      for (const rule of Object.keys(REFUSALS) as RuleId[]) {
        const shown = refusalLines(rule, SAMPLE, WINDOW)
        const lines = [shown.message, shown.next, ...(shown.change !== null ? [shown.change] : [])]
        const was = [english[rule].message, english[rule].next, ...(english[rule].change !== null ? [english[rule].change] : [])]
        messages(rule).forEach((m, i) => {
          expect(lines[i], `${code} ${m.id}`).not.toMatch(/[{}]/)
          // A translation the same as the English (a name, a short word) may render the same; any other may not.
          if (cat[m.id] !== (en as Record<string, { defaultMessage: string }>)[m.id].defaultMessage) expect(lines[i], `${code} ${m.id}`).not.toBe(was[i])
        })
      }
    }
  })

  it("renders a submit.checksPassed refusal recorded before its text took the last run's reason, in every locale (HR1's #1654 round 1)", async () => {
    // A Refused fact's values as they were stored then: no why, files or copy.
    const before = { card: 'AM-12', check: 'lint', revision: 'a3f2c1d', command: 'hive-progress --check lint --card AM-12' }
    expect(refusal('submit.checksPassed', before)).toMatchObject({ message: "Review refused: lint hasn't passed on a3f2c1d.", next: 'Run hive-progress --check lint --card AM-12, then submit again.' })
    for (const code of LOCALES) {
      setLanguage(code, await loadCatalogue(code), code)
      const shown = refusalLines('submit.checksPassed', before, WINDOW)
      for (const line of [shown.message, shown.next]) {
        expect(line, code).not.toMatch(/[{}]/)
        expect(line, code).toContain('lint')
      }
      expect(shown.next, code).toContain('hive-progress --check lint --card AM-12')
      // A value it has is kept: the new reason shows.
      expect(refusalLines('submit.checksPassed', { ...before, why: 'changed', files: 'src/a.ts', copy: 'yes' }, WINDOW).message, code).toContain('src/a.ts')
    }
  })

  it("renders both branches of submit.identity's {missing} select in every locale, as its guard gives them (HI-2281)", async () => {
    // guards.ts: no identity in git is missing 'yes' with no commit or email; another identity is 'no' with both.
    const none = { card: 'AM-12', missing: 'yes', commit: '', email: '', command: 'git config user.email' }
    const other = { card: 'AM-12', missing: 'no', commit: 'b4c5d6e', email: 'team@example.com', command: 'git commit --amend --no-edit --reset-author' }
    expect(refusal('submit.identity', none)).toMatchObject({ message: "AM-12 can't be submitted: its commits must use the project's identity, and git has none set for the project.", next: "Set the project's identity in Version Control → Branches & remotes → Commit identity (or with git config user.email), then submit again." })
    expect(refusal('submit.identity', other)).toMatchObject({ message: "AM-12: commit b4c5d6e isn't authored with the project's identity (team@example.com).", next: 'Set the identity, run git commit --amend --no-edit --reset-author, then submit again.' })
    for (const code of LOCALES) {
      setLanguage(code, await loadCatalogue(code), code)
      const [a, b] = [refusalLines('submit.identity', none, WINDOW), refusalLines('submit.identity', other, WINDOW)]
      for (const line of [a.message, a.next, b.message, b.next]) expect(line, code).not.toMatch(/[{}]/)
      expect(a.message, code).toContain('AM-12')
      expect(a.message, code).not.toBe(b.message)
      expect(a.next, code).toContain('git config user.email')
      expect(b.message, code).toContain('b4c5d6e')
      expect(b.message, code).toContain('team@example.com')
      expect(b.next, code).toContain('git commit --amend --no-edit --reset-author')
    }
  })

  it('shows the names in a refusal through their messages in the window, and intents as they are to agents', async () => {
    const agents = refusal('move.notFromHere', SAMPLE)
    expect(agents.message).toBe("AM-12 is in Approved: start review isn't possible from there.")
    expect(agents.next).toBe('From Approved, use: submit, put back.')
    expect(refusalLines('move.notFromHere', SAMPLE, WINDOW)).toMatchObject({ message: "AM-12 is in Approved: Start review isn't possible from there.", next: 'From Approved, use: Submit for review and Put back.' })
    expect(refusalLines('move.needsOverride', { ...SAMPLE, stage: 'merging' }, WINDOW).message).toBe('Moving AM-12 to Merging skips: Checks pass before review and Your OK before merging.')
    // Nothing possible from there: the next step says so, never "use: ." (#1264).
    expect(refusal('move.notFromHere', { ...SAMPLE, moves: '' }).next).toBe('Nothing waits to be done there now.')
    // A start or submit on a card in Done (HI-2227): more work the user asked for takes it back to Doing, a separate
    // follow-up is a new card; any other move refused there (an answer to a closed request) keeps the line above.
    for (const move of ['start', 'submit']) expect(refusal('move.notFromHere', { ...SAMPLE, stage: 'done', move, moves: '' }).next).toBe("It's finished. More work on it that the user asked for: move it back with hive_update_task (column: doing), then work on it as usual. Separate follow-up work goes on a new card (hive_create_task).")
    expect(refusalLines('move.notFromHere', { ...SAMPLE, stage: 'done', move: 'start', moves: '' }, WINDOW).next).toBe("It's finished. More work on it that you ask for takes it back to Doing; separate follow-up work goes on a new card.")
    expect(refusal('move.notFromHere', { ...SAMPLE, stage: 'done', move: 'answer', moves: '' }).next).toBe('Nothing waits to be done there now.')
    const de = await loadCatalogue('de')
    setLanguage('de', de, 'de')
    const shown = refusalLines('move.notFromHere', SAMPLE, WINDOW)
    expect(shown.message).toContain(tr(STAGE_TEXT.approved))
    expect(shown.message).toContain(tr(MOVE_NAMES['start review']))
    expect(shown.next).toContain(tr(MOVE_NAMES.submit))
    expect(refusalLines('move.needsOverride', SAMPLE, WINDOW).message).toContain(tr(RULE_NAMES['submit.checksPassed']))
  })

  it("names a refusal's stages by their stage names in every locale, and to agents as the board does (HR2's #1290 round 1, #1604)", async () => {
    expect(refusal('move.noStage', SAMPLE).next).toBe('Move it to one of its steps: Todo, Active, Done.')
    for (const code of ['en', ...LOCALES]) {
      if (code !== 'en') setLanguage(code, await loadCatalogue(code), code)
      const next = refusalLines('move.noStage', SAMPLE, WINDOW).next
      for (const stage of ['todo', 'active', 'done'] as const) expect(next, `${code} ${stage}`).toContain(tr(STAGE_TEXT[stage]))
      if (code !== 'en') expect(next, code).not.toMatch(/\btodo\b|\bactive\b/)
    }
  })

  it("gives a refused reviewer or builder its own side's next step, in every locale (#1604)", async () => {
    const reviewer = { ...SAMPLE, stage: 'active', move: 'verdict', whose: 'reviewer', back: 'yes' }
    expect(refusal('move.notFromHere', reviewer)).toMatchObject({ message: "AM-12 is in Active: verdict isn't possible from there.", next: 'Its review is over: it went back for more work. Leave it where it is, with no verdict, and wait for it to come back to Review.' })
    expect(refusal('move.notFromHere', { ...reviewer, stage: 'approved', back: 'no' }).next).toBe('Its review is over: it has moved on from Review. Leave it where it is, with no verdict.')
    expect(refusal('move.notFromHere', { ...SAMPLE, stage: 'review', move: 'put back', whose: 'builder' }).next).toBe("It waits for its reviewer's verdict: wait for that, which brings it back if there is more to do.")
    for (const code of LOCALES) {
      setLanguage(code, await loadCatalogue(code), code)
      for (const values of [reviewer, { ...reviewer, back: 'no' }, { ...SAMPLE, stage: 'review', whose: 'builder' }]) {
        const next = refusalLines('move.notFromHere', values, WINDOW).next
        expect(next, `${code} ${values.whose}`).not.toMatch(/[{}]/)
        expect(next, `${code} ${values.whose}`).not.toBe(refusal('move.notFromHere', values).next)
      }
    }
  })

  it('names every guard, move and stage for the window', () => {
    for (const id of Object.keys(GUARDS)) expect(RULE_NAMES[id], id).toBeDefined()
    for (const stage of ['hold', 'todo', 'active', 'review', 'approved', 'merging', 'done'] as const) expect(tr(STAGE_TEXT[stage])).not.toBe(stage)
  })
})

describe("what a platform couldn't read", () => {
  it('keeps its English for agents and its message for the window', async () => {
    const u = unknown(UNREADABLE.deliverables, { project: 'site', n: 20000 })
    expect(u.what).toBe('the work in site: it has over 20,000 files')
    expect(u.whatText).toEqual({ id: 'workflow.unreadable.deliverables', values: { project: 'site', n: 20000 } })
    const r = refusal('platform.unknown', { card: 'AM-12', what: unknown(UNREADABLE.head, { where: 'D:\\work\\am' }).whatText!, rule: 'submit.checksPassed' })
    expect(r.message).toBe("AM-12: Hive couldn't read the latest commit in D:\\work\\am, so the rule submit.checksPassed can't be checked.")
    const fr = await loadCatalogue('fr')
    setLanguage('fr', fr, 'fr')
    const shown = refusalLines('platform.unknown', r.values, WINDOW)
    expect(shown.message).toContain(tr(UNREADABLE.head, { where: 'D:\\work\\am' }))
    expect(shown.message).toContain(tr(RULE_NAMES['submit.checksPassed']))
    expect(shown.message).not.toContain('the latest commit')
  })

  it("the card dialog's Work section words why a field wasn't read, in the window's language, saying it once (#1477)", async () => {
    const work = (id: keyof typeof board): Msg => msg({ id, defaultMessage: board[id].defaultMessage, description: board[id].description })
    const notRead = work('board.work.notRead')
    const revision = work('board.work.revisionNotRead')
    const files = work('board.work.filesNotRead')
    const format = (m: Msg, values?: Record<string, string | number>): string => tr(m, values)
    // Nothing read before the change (a card moved into Review with no agent), as main records it for agents.
    const before = { unknown: { line: UNREAD_NOTES.beforeChange, revision: UNREAD_NOTES.beforeChange, files: UNREAD_NOTES.beforeChange }, unknownText: {} }
    // A platform's read that failed, its reason kept as data too; and main's other two notes.
    const head = unknown(UNREADABLE.head, { where: 'D:\\work\\am' })
    const failed = { unknown: { revision: head.what, base: UNREAD_NOTES.noTarget, files: UNREAD_NOTES.noBaseOrHead }, unknownText: { revision: head.whatText! } }
    const lines = (): string[] => [tr(revision, unreadWhy('revision', before, format)), tr(files, unreadWhy('files', before, format)), tr(notRead, unreadWhy('line', before, format)), tr(revision, unreadWhy('revision', failed, format)), tr(notRead, unreadWhy('base', failed, format)), tr(files, unreadWhy('files', failed, format))]
    expect(lines()).toEqual([
      "No revision recorded: Hive didn't read one when the card went to Review. Its next submission reads it again.",
      'Files not read',
      'Not read when its work started',
      "Revision not read when it was submitted: Hive couldn't read the latest commit in D:\\work\\am. Its next submission reads it again.",
      'Not read: there was no target branch to start from',
      'Files not read: there was no base or revision to compare'
    ])
    for (const code of LOCALES) {
      setLanguage(code, await loadCatalogue(code), code)
      const shown = lines()
      for (const line of shown) expect(line, code).not.toMatch(/not read|no target|no base|latest commit|\{/)
      expect(shown[3], code).toContain(tr(UNREADABLE.head, { where: 'D:\\work\\am' }))
    }
    // A fact recorded before the reasons were kept as data: main's notes are still worded, another reason shown as recorded.
    expect(unreadWhy('revision', { unknown: { revision: UNREAD_NOTES.beforeChange }, unknownText: {} }, format)).toEqual({ note: 'beforeChange', why: '' })
    expect(unreadWhy('revision', { unknown: { revision: 'cannot read repository HEAD' }, unknownText: {} }, format)).toEqual({ note: 'other', why: 'cannot read repository HEAD' })
  })

  it("an id this Hive doesn't know (a newer Hive's record) shows as nothing rather than failing", () => {
    expect(workflowLine({ id: 'workflow.unreadable.fromTheFuture' }, (m) => tr(m))).toBeNull()
    expect(workflowEnglish({ id: 'workflow.unreadable.fromTheFuture' })).toBe('workflow.unreadable.fromTheFuture')
  })
})

describe('For you requests', () => {
  let env: Env | null = null
  afterEach(() => {
    env?.close()
    env = null
  })

  it('keep their English for agents and their message as data for the window, in the fact and the notice', async () => {
    const e = (env = setup({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [], review: 'you', noSelfReview: false, finish: 'agentMerges' }))
    const card = e.wf.createCard({ title: 'Yours' })
    const s = await e.wf.start(card.key, B1)
    moved(s)
    commit(s.data!.folder as string, { 'y.txt': 'y\n' }, 'Yours')
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    const req = e.wf.state(card).requests[0]
    expect(req).toMatchObject({ gate: 'review', text: `${card.key} waits for your review`, requestText: { id: FOR_YOU.review.id, values: { card: card.key } } })
    expect(e.notes.at(-1)).toEqual({ card: card.key, text: `${card.key} waits for your review`, shown: { id: FOR_YOU.review.id, values: { card: card.key } } })
    const ja = await loadCatalogue('ja')
    setLanguage('ja', ja, 'ja')
    expect(workflowLine(req.requestText, (m, values) => tr(m, values))).toBe(tr(FOR_YOU.review, { card: card.key }))
    expect(workflowLine(req.requestText, (m, values) => tr(m, values))).not.toContain('waits for your review')
  })
})
