// A card's Read first references (#818): parsed (a Markdown file with an optional #slug, never a line number), checked
// and recorded on the card (its history says so; a card without any has no field), resolved to their sections' sizes
// for the start prompt and to their text for the card dialog's viewer, in the project's folder or the shared notes.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { parseDocRef, splitDocRefs } from '../src/shared/docRefs'
import { taskPrompt } from '../src/shared/tasks'
import type { TaskCard } from '../src/shared/types'

const base = tempDir('hive-cardcontext-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const { checkDocRef: resolveDocRef, checkDocRef: docRefSection, contextProblems } = await import('../src/main/docSections')

const PLAN = '# Plan\n\nIntro.\n\n## Setup\n\nInstall.\n\n## Release\n\nShip.\n'

describe('parseDocRef', () => {
  it('a Markdown file, with or without #slug; shared notes too', () => {
    expect(parseDocRef('docs/PLAN.md#setup')).toEqual({ path: 'docs/PLAN.md', slug: 'setup' })
    expect(parseDocRef(' shared:plans/notes.md#open-questions ')).toEqual({ path: 'shared:plans/notes.md', slug: 'open-questions' })
    expect(parseDocRef('README.markdown')).toEqual({ path: 'README.markdown', slug: null })
  })
  it('never a line number, nor a file that isn’t Markdown, nor a slug with spaces', () => {
    for (const bad of ['docs/PLAN.md#L12', 'docs/PLAN.md#12', 'docs/PLAN.md:12', 'src/app.ts#setup', 'docs/PLAN.md#two words', 'my docs/PLAN.md', '#setup', ''])
      expect(parseDocRef(bad), bad).toBeNull()
  })
  it("splitDocRefs: one a line or comma separated, trimmed, once each", () => {
    expect(splitDocRefs('a.md#x\n b.md , a.md#x\n\n')).toEqual(['a.md#x', 'b.md'])
  })
})

describe("a card's context", () => {
  let w: ReturnType<typeof createWorkspaceService>
  let alpha = ''
  beforeEach(async () => {
    const ws = tempDir('hive-cardcontext-ws-')
    alpha = join(ws, 'alpha')
    mkdirSync(join(alpha, '.hive'), { recursive: true })
    mkdirSync(join(alpha, 'docs'), { recursive: true })
    writeFileSync(join(alpha, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    writeFileSync(join(alpha, 'docs', 'PLAN.md'), PLAN)
    w = createWorkspaceService()
    await w.open(ws)
    mkdirSync(join(w.sharedDir, 'plans'), { recursive: true })
    writeFileSync(join(w.sharedDir, 'plans', 'notes.md'), '# Notes\n\n## Open questions\n\nWhich first?\n')
  })
  afterEach(() => disposeWorkspaceService(w))
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
  const user = { kind: 'user' } as const

  it('is set on a new card and replaced, its history saying so; cleared, the field goes', async () => {
    const c = await run(() => tasks.createTask({ title: 'T', project: 'alpha', context: ['docs/PLAN.md#setup', 'docs/PLAN.md#setup', ' shared:plans/notes.md '] }, user))
    expect(c.context).toEqual(['docs/PLAN.md#setup', 'shared:plans/notes.md'])
    const said: string[] = []
    const u = await run(() => tasks.updateTask(c.number, { context: ['docs/PLAN.md#release'] }, user, { said }))
    expect(u.context).toEqual(['docs/PLAN.md#release'])
    expect(said).toContain('Read first: docs/PLAN.md#release')
    // The same list again: no change, no history line.
    const before = u.history.length
    expect((await run(() => tasks.updateTask(c.number, { context: ['docs/PLAN.md#release'] }, user))).history.length).toBe(before)
    const cleared = await run(() => tasks.updateTask(c.number, { context: [] }, user))
    expect('context' in cleared).toBe(false)
    expect(JSON.stringify(cleared.history.at(-1))).toContain('Removed the doc sections to read first')
    // A card made without any has no field at all.
    expect('context' in (await run(() => tasks.createTask({ title: 'U', project: 'alpha' }, user)))).toBe(false)
  })

  it('refuses what isn’t a list of doc sections, or more than ten, changing nothing', async () => {
    const c = await run(() => tasks.createTask({ title: 'T', project: 'alpha', context: ['docs/PLAN.md'] }, user))
    await expect(run(() => tasks.updateTask(c.number, { context: 'docs/PLAN.md' as never }, user))).rejects.toThrow(/context must be a list/)
    await expect(run(() => tasks.updateTask(c.number, { context: ['docs/PLAN.md#L3'] }, user))).rejects.toThrow(/isn't a doc section/)
    await expect(run(() => tasks.updateTask(c.number, { context: Array.from({ length: 11 }, (_, i) => `d${i}.md`) }, user))).rejects.toThrow(/up to 10/)
    await expect(run(() => tasks.createTask({ title: 'V', project: 'alpha', context: ['x'.repeat(301) + '.md'] }, user))).rejects.toThrow(/isn't a doc section/)
    expect((await run(() => tasks.getTask(c.number))).context).toEqual(['docs/PLAN.md'])
  })

  it("resolves to each section's size, the whole document's, or why not (with the closest headings)", async () => {
    const shared = w.sharedDir
    const setup = await resolveDocRef(alpha, shared, 'docs/PLAN.md#setup')
    expect('size' in setup && setup.size).toBe('## Setup\n\nInstall.\n\n'.length)
    expect(await resolveDocRef(alpha, shared, 'docs/PLAN.md')).toMatchObject({ size: PLAN.length })
    expect(await resolveDocRef(alpha, shared, 'shared:plans/notes.md#open-questions')).toMatchObject({ size: '## Open questions\n\nWhich first?\n'.length })
    const near = await resolveDocRef(alpha, shared, 'docs/PLAN.md#setupp')
    expect(near).toMatchObject({ problem: 'noHeading' })
    expect('closest' in near && near.closest?.[0]).toBe('setup')
    expect(await resolveDocRef(alpha, shared, 'docs/GONE.md#x')).toMatchObject({ problem: 'notFound' })
    expect(await resolveDocRef(alpha, shared, '../outside.md')).toMatchObject({ problem: 'outside' })
    expect(await resolveDocRef(alpha, shared, 'docs/PLAN.md#L2')).toMatchObject({ problem: 'invalid' })
  })

  it("the dialog's viewer: a section's text and line; a card about the workspace reads shared notes only", async () => {
    expect(await docRefSection(alpha, w.sharedDir, 'docs/PLAN.md#release')).toMatchObject({ ref: 'docs/PLAN.md#release', content: '## Release\n\nShip.', line: 9 })
    expect(await docRefSection(null, w.sharedDir, 'shared:plans/notes.md#open-questions')).toMatchObject({ line: 3 })
    expect(await docRefSection(null, w.sharedDir, 'docs/PLAN.md#setup')).toMatchObject({ problem: 'notFound' })
  })
})

describe('references that no longer resolve (#819)', () => {
  let w: ReturnType<typeof createWorkspaceService>
  let alpha = ''
  beforeEach(async () => {
    const ws = tempDir('hive-cardcontext-819-')
    alpha = join(ws, 'alpha')
    mkdirSync(join(alpha, '.hive'), { recursive: true })
    mkdirSync(join(alpha, 'docs'), { recursive: true })
    writeFileSync(join(alpha, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    writeFileSync(join(alpha, 'docs', 'PLAN.md'), PLAN)
    w = createWorkspaceService()
    await w.open(ws)
    mkdirSync(join(w.sharedDir, 'plans'), { recursive: true })
    writeFileSync(join(w.sharedDir, 'plans', 'notes.md'), '# Notes\n\n## Open questions\n\nWhich first?\n')
  })
  afterEach(() => disposeWorkspaceService(w))
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
  const user = { kind: 'user' } as const
  const check = (refs: string[]) => contextProblems(alpha, w.sharedDir, refs)

  it('a renamed heading: no such heading, the closest suggested', async () => {
    writeFileSync(join(alpha, 'docs', 'PLAN.md'), PLAN.replace('## Setup', '## Set up'))
    const renamed = await check(['docs/PLAN.md#setup'])
    expect(renamed).toMatchObject([{ ref: 'docs/PLAN.md#setup', problem: 'noHeading' }])
    expect(renamed[0].closest?.[0]).toBe('set-up')
  })
  it('a renamed heading with an explicit id (#1535) still resolves by it, and a heading another shares the text of is no longer ambiguous', async () => {
    writeFileSync(join(alpha, 'docs', 'PLAN.md'), PLAN.replace('## Setup', '## Set up <a id="setup"></a>'))
    expect(await check(['docs/PLAN.md#setup'])).toEqual([])
    const section = await resolveDocRef(alpha, w.sharedDir, 'docs/PLAN.md#setup')
    expect('content' in section && section.content).toMatch(/^## Set up <a id="setup"><\/a>/)
    writeFileSync(join(alpha, 'docs', 'PLAN.md'), PLAN.replace('## Setup', '## Setup <a id="setup"></a>').replace('## Release', '## Setup\n\nAnother.\n\n## Release'))
    expect(await check(['docs/PLAN.md#setup', 'docs/PLAN.md#setup-1'])).toEqual([{ ref: 'docs/PLAN.md#setup-1', problem: 'ambiguous', closest: ['setup', 'setup-1'] }])
  })
  it('an explicit id two headings carry (a section copied with its anchor): a reference to it, or to the copy, is ambiguous, never the first picked', async () => {
    writeFileSync(join(alpha, 'docs', 'PLAN.md'), PLAN.replace('## Setup', '## Setup <a id="setup"></a>').replace('## Release', '## Setup again <a id="setup"></a>\n\nAnother.\n\n## Release'))
    expect(await check(['docs/PLAN.md#setup', 'docs/PLAN.md#SETUP', 'docs/PLAN.md#setup-1'])).toEqual([
      { ref: 'docs/PLAN.md#setup', problem: 'ambiguous', closest: ['setup', 'setup-1'] },
      { ref: 'docs/PLAN.md#SETUP', problem: 'ambiguous', closest: ['setup', 'setup-1'] },
      { ref: 'docs/PLAN.md#setup-1', problem: 'ambiguous', closest: ['setup', 'setup-1'] }
    ])
  })
  it('a deleted file', async () => {
    expect(await check(['docs/GONE.md#setup', 'docs/GONE.md'])).toEqual([
      { ref: 'docs/GONE.md#setup', problem: 'notFound' },
      { ref: 'docs/GONE.md', problem: 'notFound' }
    ])
  })
  it('a duplicate heading: the one meant may now be another, so it is flagged with both; a renumbered slug is gone', async () => {
    writeFileSync(join(alpha, 'docs', 'PLAN.md'), PLAN.replace('## Release', '## Setup\n\nAnother.\n\n## Release'))
    expect(await check(['docs/PLAN.md#setup'])).toEqual([{ ref: 'docs/PLAN.md#setup', problem: 'ambiguous', closest: ['setup', 'setup-1'] }])
    // The second of two removed: its numbered slug no longer resolves.
    writeFileSync(join(alpha, 'docs', 'PLAN.md'), PLAN)
    const gone = await check(['docs/PLAN.md#setup-1'])
    expect(gone).toMatchObject([{ problem: 'noHeading' }])
    expect(gone[0].closest?.[0]).toBe('setup')
  })
  it('a shared note: its heading renamed, and the note deleted', async () => {
    writeFileSync(join(w.sharedDir, 'plans', 'notes.md'), '# Notes\n\n## Questions\n\nWhich first?\n')
    const shared = await check(['shared:plans/notes.md#open-questions', 'shared:plans/gone.md'])
    expect(shared).toMatchObject([{ ref: 'shared:plans/notes.md#open-questions', problem: 'noHeading' }, { ref: 'shared:plans/gone.md', problem: 'notFound' }])
    expect(shared[0].closest?.[0]).toBe('questions')
    expect(await check(['shared:plans/notes.md'])).toEqual([])
  })
  it('are recorded on the card as its references are saved, and cleared once they resolve', async () => {
    const c = await run(() => tasks.createTask({ title: 'T', project: 'alpha', context: ['docs/PLAN.md#setup', 'docs/PLAN.md#nope'] }, user))
    expect(c.contextProblems).toEqual([{ ref: 'docs/PLAN.md#nope', problem: 'noHeading', closest: expect.any(Array) }])
    const fixed = await run(() => tasks.updateTask(c.number, { context: ['docs/PLAN.md#setup'] }, user))
    expect('contextProblems' in fixed).toBe(false)
    // As a start finds them (the file changed since): recorded, without a history line; the same again changes nothing.
    const checked = { context: ['docs/PLAN.md#setup'], project: 'alpha' }
    expect(await run(() => tasks.setContextProblems(c.number, [{ ref: 'docs/PLAN.md#setup', problem: 'noHeading', closest: ['set-up'] }], checked))).toBe(true)
    const now = await run(() => tasks.getTask(c.number))
    expect(now.contextProblems).toEqual([{ ref: 'docs/PLAN.md#setup', problem: 'noHeading', closest: ['set-up'] }])
    expect(now.history.length).toBe(fixed.history.length)
    expect(await run(() => tasks.setContextProblems(c.number, [], checked))).toBe(true)
    expect('contextProblems' in (await run(() => tasks.getTask(c.number)))).toBe(false)
  })

  it("a start's check made before the list changed is never saved over it (edited, cleared, or the card moved)", async () => {
    mkdirSync(join(alpha, '..', 'beta', '.hive'), { recursive: true })
    writeFileSync(join(alpha, '..', 'beta', '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    await w.refresh()
    const c = await run(() => tasks.createTask({ title: 'T', project: 'alpha', context: ['docs/PLAN.md#gone'] }, user))
    // The start checked this list (it doesn't resolve)…
    const before = { context: ['docs/PLAN.md#gone'], project: 'alpha' }
    const stale = await check(before.context)
    expect(stale).toMatchObject([{ problem: 'noHeading' }])
    // …and meanwhile the list was edited to one that does: the edit checked and saved its own (none).
    const edited = await run(() => tasks.updateTask(c.number, { context: ['docs/PLAN.md#setup'] }, user))
    expect('contextProblems' in edited).toBe(false)
    expect(await run(() => tasks.setContextProblems(c.number, stale, before))).toBe(false)
    expect('contextProblems' in (await run(() => tasks.getTask(c.number)))).toBe(false)
    // Cleared meanwhile: the old results aren't written either.
    await run(() => tasks.updateTask(c.number, { context: [] }, user))
    expect(await run(() => tasks.setContextProblems(c.number, stale, before))).toBe(false)
    expect('contextProblems' in (await run(() => tasks.getTask(c.number)))).toBe(false)
    // Its project changed meanwhile, the list the same: not written.
    await run(() => tasks.updateTask(c.number, { context: ['docs/PLAN.md#gone'] }, user))
    const flagged = (await run(() => tasks.getTask(c.number))).contextProblems
    await run(() => tasks.updateTask(c.number, { project: 'beta' }, user))
    expect(await run(() => tasks.setContextProblems(c.number, [], before))).toBe(false)
    expect((await run(() => tasks.getTask(c.number))).contextProblems).toEqual(flagged)
  })
})

describe('the start prompt', () => {
  const card = { number: 7, title: 'Fix it', description: 'The details.', blockedBy: [], comments: [], context: ['docs/PLAN.md#setup', 'shared:plans/notes.md'] } as unknown as TaskCard
  it('lists the references with their sizes, and how to read them, not their text', () => {
    expect(taskPrompt(card, true, { context: [{ ref: 'docs/PLAN.md#setup', size: 840 }, { ref: 'shared:plans/notes.md', size: 12_400 }] })).toBe(
      'Work on task #7 from the Combwork task board: Fix it\n\nThe details.\n\nRead these first: docs/PLAN.md#setup (840 characters), shared:plans/notes.md (12k characters). cw_read_section reads each as the card has it (path: the file; heading: # and the slug after it, none for a whole file; from: "project").\n\nUse the work-on-card skill.'
    )
  })
  it('names what no longer resolves, why and the closest, never silently nothing (#819)', () => {
    const text = taskPrompt(card, true, { context: [{ ref: 'docs/PLAN.md#setup', problem: { ref: 'docs/PLAN.md#setup', problem: 'noHeading', closest: ['set-up'] } }, { ref: 'shared:plans/notes.md', size: 400 }] })
    expect(text).toContain('Read these first: shared:plans/notes.md (400 characters).')
    expect(text).toContain('This reference no longer resolves: docs/PLAN.md#setup (no such heading; closest: #set-up). Ask the user which section is meant, or read the closest.')
    const all = taskPrompt(card, true, { context: [{ ref: 'a.md#x', problem: { ref: 'a.md#x', problem: 'ambiguous', closest: ['x', 'x-1'] } }, { ref: 'b.md', problem: { ref: 'b.md', problem: 'notFound' } }] })
    expect(all).not.toContain('Read these first')
    expect(all).toContain('These references no longer resolve: a.md#x (several headings have its text; they are: #x, #x-1); b.md (no such file).')
    // With none resolving, how to read the closest still says the project's copy (#819 round 2).
    expect(all).toContain('cw_read_section reads the closest as the card has it (path: the file; heading: # and the slug; from: "project").')
    expect(text).toContain('cw_read_section reads each as the card has it')
  })
  it("without Hive's tools, or with no sizes worked out, the references alone; none, no line", () => {
    expect(taskPrompt(card, false)).toBe("Work on task #7 from the Combwork task board: Fix it\n\nThe details.\n\nRead these sections of the project's docs first: docs/PLAN.md#setup, shared:plans/notes.md.")
    expect(taskPrompt({ ...card, context: undefined }, true)).not.toContain('Read these first')
  })
})
