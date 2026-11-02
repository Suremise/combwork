// The board's stages (#1417, SPEC §16.5.2): the stages every combination of review, who finishes and folder produces,
// in board order and in their categories (Merging in Approved); a card keeping the stages of its own ruleset; a stage no
// longer produced shown while a card is in it; the stages' names (messages, or the project's renames, N5) and the checks
// a rename gets; and names that aren't rules (a rename never changes a ruleset or its id).
import { afterEach, describe, expect, it } from 'vitest'
import { fmt, setLanguage, tr } from '../../src/shared/i18n'
import { loadCatalogue } from '../../src/shared/i18n/catalogues'
import { compile, mustCompile } from '../../src/shared/workflow/compile'
import { allOff, contradictions, preset, type Finisher, type FolderMode, type ReviewBy, type WorkflowOptions } from '../../src/shared/workflow/options'
import { STAGE_ORDER, STAGE_TEXT, stageName, stageNameProblems, stageNameProblemText, stageOf, stagesOf, stagesShown } from '../../src/shared/workflow/stages'
import { refusalLines } from '../../src/shared/workflow/refusals'
import type { StageId } from '../../src/shared/workflow/facts'
import { englishText } from '../../src/shared/advanced'
import { checkSettingValue, settingEntry, settingPatch } from '../../src/shared/settingsCatalog'
import { COLUMN_TEXT, columnLabel, columnName, TASK_COLUMNS } from '../../src/shared/tasks'

afterEach(() => setLanguage('en', {}))

const REVIEWS: ReviewBy[] = ['none', 'agent', 'agentThenYou', 'you']
const FINISHERS: Finisher[] = ['hiveMerges', 'agentMerges', 'committed', 'notChecked']
const FOLDERS: FolderMode[] = ['slots', 'project']

/**
 * §16.5.2's table (decided on #1417): On Hold, Todo, Active and Done always; Review with any review; Approved when a review
 * or your OK before merging (G10) approves the work and something follows: a merge in Git (Hive's, the agent's, or Not
 * checked), your OK after the reviewer agent in None (N1); Merging when Hive merges. Committed is done has nothing after.
 */
function expected(o: WorkflowOptions): StageId[] {
  const review = o.review !== 'none'
  const git = o.platform === 'git'
  const approved = git ? (review || o.okBefore.mode !== 'never') && ['hiveMerges', 'agentMerges', 'notChecked'].includes(o.finish) : o.review === 'agentThenYou'
  return STAGE_ORDER.filter((s) => s === 'hold' || s === 'todo' || s === 'active' || s === 'done' || (s === 'review' && review) || (s === 'approved' && approved) || (s === 'merging' && git && o.finish === 'hiveMerges'))
}

describe("the stages the options produce (§16.5.2's table)", () => {
  it('every combination of review, who finishes and folder, with and without your OK, gives its stages in board order and categories', () => {
    let checked = 0
    for (const review of REVIEWS)
      for (const finish of FINISHERS)
        for (const folder of FOLDERS)
          for (const ok of ['never', 'labels'] as const) {
            const o: WorkflowOptions = { ...allOff('git'), review, noSelfReview: review === 'agent' || review === 'agentThenYou', finish, folder, okBefore: { mode: ok, labels: ok === 'labels' ? ['ui'] : [] } }
            if (contradictions(o).length) continue
            const stages = stagesOf(mustCompile(o))
            expect(stages.map((s) => s.id), JSON.stringify({ review, finish, folder, ok })).toEqual(expected(o))
            checked++
          }
    for (const review of REVIEWS) {
      const o: WorkflowOptions = { ...allOff('none'), review, noSelfReview: review === 'agent' || review === 'agentThenYou' }
      expect(stagesOf(mustCompile(o)).map((s) => s.id), review).toEqual(expected(o))
      checked++
    }
    expect(checked).toBeGreaterThan(20)
  })

  it("follows the table's own cases: no Approved without a review or your OK, None's 'a reviewer agent, then you' has one (decided on #1417)", () => {
    const ids = (o: WorkflowOptions): string => mustCompile(o).stages.map((s) => s.id).join(' ')
    expect(ids({ ...allOff('git'), finish: 'agentMerges', folder: 'slots' })).toBe('hold todo active done')
    // G10's OK approves the work too: the card waits for it in Approved.
    expect(ids({ ...allOff('git'), finish: 'hiveMerges', folder: 'slots', okBefore: { mode: 'every', labels: [] } })).toBe('hold todo active approved merging done')
    expect(ids({ ...allOff('git'), finish: 'agentMerges', folder: 'slots', okBefore: { mode: 'labels', labels: ['ui'] } })).toBe('hold todo active approved done')
    expect(ids({ ...allOff('git'), review: 'agent', noSelfReview: true, finish: 'agentMerges', folder: 'slots' })).toBe('hold todo active review approved done')
    expect(ids({ ...allOff('git'), review: 'agent', noSelfReview: true, finish: 'committed', folder: 'project' })).toBe('hold todo active review done')
    expect(ids({ ...allOff('none'), review: 'agentThenYou', noSelfReview: true })).toBe('hold todo active review approved done')
    expect(ids({ ...allOff('none'), review: 'you' })).toBe('hold todo active review done')
  })

  it('places Merging in Approved, Active in doing and Approved in passed: the categories agents move cards by', () => {
    const stages = stagesOf(mustCompile(preset('git', 'pair')))
    expect(stages.map((s) => [s.id, s.category])).toEqual([
      ['hold', 'hold'],
      ['todo', 'todo'],
      ['active', 'doing'],
      ['review', 'review'],
      ['approved', 'passed'],
      ['merging', 'passed'],
      ['done', 'done']
    ])
    expect(stages.map((s) => s.name)).toEqual(['On Hold', 'Todo', 'Active', 'Review', 'Approved', 'Merging', 'Done'])
  })

  it("a card keeps the stage its facts give it, under its own ruleset; a card no view has read yet stands in its column's", () => {
    expect(stageOf({ column: 'passed' }, { stage: 'merging' })).toBe('merging')
    expect(stageOf({ column: 'passed' }, null)).toBe('approved')
    expect(stageOf({ column: 'doing' })).toBe('active')
  })

  it('shows a stage the options no longer produce while a card is in it, and hides it once none is', () => {
    const solo = mustCompile(preset('git', 'solo'))
    expect(stagesShown(solo, []).map((s) => s.id)).toEqual(['hold', 'todo', 'active', 'done'])
    // A card started under Pair is still in Merging after the switch to Solo (§16.17).
    expect(stagesShown(solo, ['active', 'merging', 'todo']).map((s) => s.id)).toEqual(['hold', 'todo', 'active', 'merging', 'done'])
    expect(stagesShown(solo, ['review']).map((s) => [s.id, s.category])).toEqual([
      ['hold', 'hold'],
      ['todo', 'todo'],
      ['active', 'doing'],
      ['review', 'review'],
      ['done', 'done']
    ])
  })
})

describe('stage names (N5, OP-30)', () => {
  it("names a stage by the project's own name, else its message in the window's language, else as it is", async () => {
    expect(stageName('active')).toBe('Active')
    expect(stageName('active', { active: 'Building' })).toBe('Building')
    expect(stageName('review', { active: 'Building' })).toBe('Review')
    expect(stageName('later')).toBe('later')
    const de = await loadCatalogue('de')
    setLanguage('de', de, 'de')
    expect(stageName('approved', null, tr)).toBe('Genehmigt')
    expect(stageName('approved', { approved: 'Abgenommen' }, tr)).toBe('Abgenommen')
    expect(stagesOf(mustCompile(preset('git', 'pair')), { merging: 'In der Warteschlange' }, tr).map((s) => s.name)).toEqual(['Geparkt', 'Offen', 'In Arbeit', 'Review', 'Genehmigt', 'In der Warteschlange', 'Erledigt'])
  })

  it('refuses an empty name, one over 24 characters, one with a control character, and one another stage has (ignoring case)', () => {
    expect(stageNameProblems({ active: 'Building', merging: 'In the queue' })).toEqual([])
    expect(stageNameProblems({ active: '   ' })).toEqual([{ stage: 'active', why: 'empty' }])
    expect(stageNameProblems({ active: 'x'.repeat(24) })).toEqual([])
    expect(stageNameProblems({ active: 'x'.repeat(25) })).toEqual([{ stage: 'active', why: 'long' }])
    // Trimmed before it is measured.
    expect(stageNameProblems({ active: ` ${'x'.repeat(24)} ` })).toEqual([])
    expect(stageNameProblems({ active: 'Build\ning' })).toEqual([{ stage: 'active', why: 'control' }])
    expect(stageNameProblems({ active: 'Build\u0007' })).toEqual([{ stage: 'active', why: 'control' }])
    // Another stage's default name, or another rename.
    expect(stageNameProblems({ active: 'review' })).toEqual([{ stage: 'active', why: 'duplicate' }])
    expect(stageNameProblems({ active: 'Ship', approved: 'ship ' })).toEqual([
      { stage: 'active', why: 'duplicate' },
      { stage: 'approved', why: 'duplicate' }
    ])
    // Every stage counts, produced or not: a stage kept for a card under old rules is shown, and options change.
    expect(stageNameProblems({ active: 'Merging' })).toEqual([{ stage: 'active', why: 'duplicate' }])
    // A rename frees its stage's default name for another stage.
    expect(stageNameProblems({ active: 'Building', review: 'Active' })).toEqual([])
    expect(englishText(stageNameProblemText({ stage: 'active', why: 'long' }))).toBe('The name of Active is longer than 24 characters.')
    expect(englishText(stageNameProblemText({ stage: 'merging', why: 'duplicate' }))).toBe('The name of Merging is already another stage’s name.')
  })

  it('checks a name against the names the window shows: a default name in the language Hive shows counts too (HR2, round 1)', async () => {
    setLanguage('de', await loadCatalogue('de'), 'de')
    // Done is Erledigt in German: Active can't be called that, nor Done (English's name for it).
    expect(stageNameProblems({ active: 'Erledigt' }, tr)).toEqual([{ stage: 'active', why: 'duplicate' }])
    expect(stageNameProblems({ active: 'erledigt ' }, tr)).toEqual([{ stage: 'active', why: 'duplicate' }])
    expect(stageNameProblems({ active: 'Done' }, tr)).toEqual([{ stage: 'active', why: 'duplicate' }])
    expect(stageNameProblems({ active: 'Bauen' }, tr)).toEqual([])
    // Without the window's language, only English's names.
    expect(stageNameProblems({ active: 'Erledigt' })).toEqual([])
  })

  it("aren't rules: a rename leaves the ruleset and its id as they were", () => {
    const pair = preset('git', 'pair')
    const plain = mustCompile(pair)
    const renamed = mustCompile({ ...pair, stageNames: { active: 'Building', merging: 'In the queue' } })
    expect(renamed.id).toBe(plain.id)
    expect(renamed.options).not.toHaveProperty('stageNames')
    expect(renamed).toEqual(plain)
    // A rename never hides a contradiction, nor makes one.
    expect(compile({ ...pair, folder: 'project', stageNames: { active: 'Building' } })).toMatchObject({ ok: false })
  })

  it("a refusal in the window names a renamed stage by the project's name; agents read its id", () => {
    const f = { one: (m: Parameters<typeof tr>[0], v?: Record<string, string | number>) => tr(m, v), list: (items: string[]) => fmt.list(items), names: true, stageNames: { active: 'Building' } }
    const values = { card: 'AM-12', stage: 'active', move: 'start review', moves: 'submit' }
    expect(refusalLines('move.notFromHere', values, f).message).toBe("AM-12 is in Building: Start review isn't possible from there.")
    expect(refusalLines('move.noStage', { card: 'AM-12', stage: 'review', stages: 'todo, active, done' }, f).next).toContain('Building')
  })

  it("the Assistant's tool takes stage names as an object of stage ids, trimmed, null inherits", () => {
    const e = settingEntry('project.workflow.stageNames')!
    expect(e).toMatchObject({ scope: 'project', workflow: 'stageNames', inherits: true })
    expect(checkSettingValue(e, { active: '  Building ', merging: 'In the queue' })).toEqual({ value: { active: 'Building', merging: 'In the queue' } })
    expect(checkSettingValue(e, { building: 'Building' })).toMatchObject({ error: expect.stringMatching(/an object of stage id/) })
    expect(checkSettingValue(e, { active: 3 })).toMatchObject({ error: expect.stringMatching(/an object of stage id/) })
    expect(checkSettingValue(e, null)).toEqual({ value: null })
    const patch = settingPatch(e, { active: 'Building' })
    const cfg = { version: 2, platform: 'git', workflow: { platform: 'git', preset: 'pair', options: { finish: 'hiveMerges' }, presetAsked: 'chosen', later: 1 } }
    expect('project' in patch && patch.project(cfg as never)).toEqual({ workflow: { platform: 'git', preset: 'pair', options: { finish: 'hiveMerges', stageNames: { active: 'Building' } }, presetAsked: 'chosen', later: 1 } })
  })
})

describe('the window says Active and Approved for the doing and passed categories (OP-1)', () => {
  it('names the columns in the window by the new words, agents by the ids and their English as before', async () => {
    expect(columnName('doing', tr)).toBe('Active')
    expect(columnName('passed', tr)).toBe('Approved')
    expect(TASK_COLUMNS.map((c) => c.id)).toEqual(['hold', 'todo', 'doing', 'review', 'passed', 'done'])
    expect(columnLabel('doing')).toBe('Doing')
    expect(columnLabel('passed')).toBe('Passed')
    // Each category's name in the window is its default stage's (glossary 2.2), in every language.
    for (const code of ['en', 'de', 'es', 'fr', 'ja', 'pl', 'pt-BR', 'zh-CN']) {
      if (code !== 'en') setLanguage(code, await loadCatalogue(code), code)
      expect(tr(COLUMN_TEXT.doing.label), code).toBe(tr(STAGE_TEXT.active))
      expect(tr(COLUMN_TEXT.passed.label), code).toBe(tr(STAGE_TEXT.approved))
      expect(tr(COLUMN_TEXT.hold.label), code).toBe(tr(STAGE_TEXT.hold))
    }
    setLanguage('de', await loadCatalogue('de'), 'de')
    expect(columnName('passed', tr)).toBe('Genehmigt')
    setLanguage('pl', await loadCatalogue('pl'), 'pl')
    expect(columnName('doing', tr)).toBe('Aktywne')
    setLanguage('zh-CN', await loadCatalogue('zh-CN'), 'zh-CN')
    expect(columnName('passed', tr)).toBe('已批准')
  })
})
