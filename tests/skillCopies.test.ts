// Combwork's skill copies per folder (#1431, SPEC §16.15 C row 15): Codex and Copilot read Combwork's skills from copies in the
// folder's .agents/skills, which Combwork records (skill_copies) and removes only when its record and the copy's marker both
// say Combwork made it, the copy is unchanged since and no session of Combwork's works there; Settings → Advanced says where
// (Slots only, Everywhere, Never). The skills delivered are a choice (Skills → Delivered to agents), which the launch,
// the copies and the guidance follow.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import type { SkillCopyBook, SkillCopyRecord } from '../src/main/providers/types'

const base = tempDir('hive-skill-copies-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
afterAll(() => rmSync(base, { recursive: true, force: true }))

const { syncAgentsSkills, removeCombworkCopies } = await import('../src/main/providers/common')
const { contentHash } = await import('../src/main/fsutil')
const { SKILLS_REMOVE_IDLE_COPIES } = await import('../src/shared/advanced')
const { offNames, skillOff, withSkillDelivered } = await import('../src/shared/skillDelivery')
const { boardSkillsLine, combworkInstructions } = await import('../src/shared/combworkGuidance')

/** A book kept in memory, as combwork.db's table keeps it (by folder and skill, case-insensitively). */
function memBook(): SkillCopyBook & { rows: Map<string, SkillCopyRecord & { folder: string }> } {
  const rows = new Map<string, SkillCopyRecord & { folder: string }>()
  const key = (folder: string, skill: string): string => `${folder.toLowerCase()}\n${skill.toLowerCase()}`
  return {
    rows,
    of: async (folder) => new Map([...rows.values()].filter((r) => r.folder.toLowerCase() === folder.toLowerCase()).map((r) => [r.skill.toLowerCase(), { skill: r.skill, project: r.project, revision: r.revision }])),
    record: async (folder, project, skill, revision) => void rows.set(key(folder, skill), { folder, project, skill, revision }),
    forget: async (folder, skill) => void rows.delete(key(folder, skill))
  }
}

let n = 0
/** A project folder and a slot beside it, with sources for the skills named. */
function world(...names: string[]) {
  const root = join(base, `w${++n}`)
  const project = join(root, 'proj')
  const slot = join(root, 'proj.worktrees', 'slot-a')
  mkdirSync(project, { recursive: true })
  mkdirSync(slot, { recursive: true })
  const sources = names.map((name) => {
    const sourcePath = join(root, 'src', name)
    mkdirSync(sourcePath, { recursive: true })
    writeFileSync(join(sourcePath, 'SKILL.md'), `# ${name}`)
    return { name, sourcePath }
  })
  const copy = (folder: string, name: string): string => join(folder, '.agents', 'skills', `cw-${name}`)
  return { root, project, slot, sources, copy }
}

const sync = (cwd: string, projectPath: string, skills: { name: string; sourcePath: string }[], copies?: SkillCopyBook) => syncAgentsSkills({ cwd, projectPath, skills, copies } as never, 'Codex')

describe('delivery records (#1431)', () => {
  it('records each copy it makes, at the revision it wrote, in the folder the session is in', async () => {
    const w = world('deploy', 'notes')
    const book = memBook()
    const out = await sync(w.slot, w.project, w.sources, book)
    expect([...book.rows.values()].map((r) => [r.folder, r.skill, r.project]).sort()).toEqual([
      [w.slot, 'deploy', w.project],
      [w.slot, 'notes', w.project]
    ])
    for (const r of book.rows.values()) expect(r.revision).toBe(await contentHash(w.copy(w.slot, r.skill)))
    expect(out.deploy.revision).toBe(book.rows.get(`${w.slot.toLowerCase()}\ndeploy`)!.revision)
    // The project folder gets none of these: a session's copies are in its own folder.
    expect(existsSync(join(w.project, '.agents'))).toBe(false)
  })

  it('an edited copy keeps its old record, and is never taken for Combwork\'s own', async () => {
    const w = world('deploy')
    const book = memBook()
    await sync(w.slot, w.project, w.sources, book)
    const before = [...book.rows.values()][0].revision
    writeFileSync(join(w.copy(w.slot, 'deploy'), 'SKILL.md'), '# deploy, my edit')
    await sync(w.slot, w.project, w.sources, book)
    expect([...book.rows.values()][0].revision).toBe(before)
    // No longer given: the edited copy stays.
    await sync(w.slot, w.project, [], book)
    expect(readFileSync(join(w.copy(w.slot, 'deploy'), 'SKILL.md'), 'utf8')).toBe('# deploy, my edit')
  })
})

describe('safe clean-up (#1431)', () => {
  it("removes Combwork's own unchanged copies, never a user's skill, an edited copy or a folder with a running session", async () => {
    const w = world('deploy', 'notes', 'review')
    const book = memBook()
    await sync(w.slot, w.project, w.sources, book)
    // The user's own skills: one of their own name, one using Combwork's prefix.
    for (const mine of ['mine', 'hive-theirs']) {
      mkdirSync(join(w.slot, '.agents', 'skills', mine), { recursive: true })
      writeFileSync(join(w.slot, '.agents', 'skills', mine, 'SKILL.md'), `# ${mine}`)
    }
    writeFileSync(join(w.copy(w.slot, 'review'), 'SKILL.md'), '# review, edited')

    // A session of Combwork's works there: nothing goes.
    expect(await removeCombworkCopies(w.slot, w.project, book, () => true)).toEqual([])
    for (const s of ['deploy', 'notes', 'review']) expect(existsSync(w.copy(w.slot, s)), s).toBe(true)

    // None now: Combwork's two unchanged copies go, with their records; the edited one and the user's stay.
    expect((await removeCombworkCopies(w.slot, w.project, book, () => false)).sort()).toEqual(['deploy', 'notes'])
    expect(existsSync(w.copy(w.slot, 'deploy'))).toBe(false)
    expect(existsSync(w.copy(w.slot, 'notes'))).toBe(false)
    expect(readFileSync(join(w.copy(w.slot, 'review'), 'SKILL.md'), 'utf8')).toBe('# review, edited')
    expect(readFileSync(join(w.slot, '.agents', 'skills', 'mine', 'SKILL.md'), 'utf8')).toBe('# mine')
    expect(readFileSync(join(w.slot, '.agents', 'skills', 'hive-theirs', 'SKILL.md'), 'utf8')).toBe('# hive-theirs')
    expect([...book.rows.values()].map((r) => r.skill)).toEqual(['review'])
    // Nothing of a swap is left beside them.
    expect(readdirSync(join(w.slot, '.agents', 'skills')).filter((f) => f.startsWith('.')).length).toBe(0)
  })

  it("a marked copy from before records is Combwork's when unchanged (recorded, then removed); one with an old marker isn't", async () => {
    const w = world('deploy', 'legacy')
    // Made without a book (before records): marked, unrecorded.
    await sync(w.slot, w.project, w.sources)
    // A marker from before hashes: whether it changed can't be told.
    writeFileSync(join(w.copy(w.slot, 'legacy'), '.combwork-copy'), JSON.stringify({ source: 'x' }) + '\n')
    const book = memBook()
    expect(await removeCombworkCopies(w.slot, w.project, book, () => false)).toEqual(['deploy'])
    expect(existsSync(w.copy(w.slot, 'legacy'))).toBe(true)
    expect(book.rows.size).toBe(0)
  })

  it('a folder under the old prefix (hive-<skill>) is never read or touched by delivery or clean-up: the names upgrade retires the old copies (HI-2594)', async () => {
    const w = world('deploy')
    const book = memBook()
    await sync(w.slot, w.project, w.sources, book)
    // As a build before the rename left one: the same copy, marked, under the old prefix.
    const old = join(w.slot, '.agents', 'skills', 'hive-deploy')
    renameSync(w.copy(w.slot, 'deploy'), old)
    const out = await sync(w.slot, w.project, w.sources, book)
    expect(readFileSync(join(old, 'SKILL.md'), 'utf8')).toBe('# deploy')
    expect(readFileSync(join(w.copy(w.slot, 'deploy'), 'SKILL.md'), 'utf8')).toBe('# deploy')
    expect(out.deploy.revision).toBe(await contentHash(w.copy(w.slot, 'deploy')))
    expect(await removeCombworkCopies(w.slot, w.project, book, () => false)).toEqual(['deploy'])
    expect(existsSync(w.copy(w.slot, 'deploy'))).toBe(false)
    expect(readFileSync(join(old, 'SKILL.md'), 'utf8')).toBe('# deploy')
  })

  it("records it can't read keep every copy; a record whose copy has gone is dropped", async () => {
    const w = world('deploy')
    const book = memBook()
    await sync(w.slot, w.project, w.sources, book)
    const broken: SkillCopyBook = { ...book, of: async () => Promise.reject(new Error('board closed')) }
    expect(await removeCombworkCopies(w.slot, w.project, broken, () => false)).toEqual([])
    expect(existsSync(w.copy(w.slot, 'deploy'))).toBe(true)
    rmSync(w.copy(w.slot, 'deploy'), { recursive: true })
    expect(await removeCombworkCopies(w.slot, w.project, book, () => false)).toEqual([])
    expect(book.rows.size).toBe(0)
  })

  it("a launch meanwhile wins: the clean-up asks whether the folder is busy inside the copies' lock, either order", async () => {
    const w = world('deploy')
    const book = memBook()
    await sync(w.slot, w.project, w.sources, book)
    // A session is live (busy) before its launch copies, as sessions.ts records it before prepareLaunch.
    let busy = false
    const launch = (): Promise<unknown> => ((busy = true), sync(w.slot, w.project, w.sources, book))
    // The launch first: the clean-up, queued behind it, finds the folder busy and removes nothing.
    const first = launch()
    const after = removeCombworkCopies(w.slot, w.project, book, () => busy)
    await first
    expect(await after).toEqual([])
    // The clean-up asked first, the session live before it takes the lock (or after: then the launch behind it copies
    // again): either way the launch ends with its copy, recorded.
    busy = false
    const cleanUp = removeCombworkCopies(w.slot, w.project, book, () => busy)
    const second = launch()
    await cleanUp
    await second
    expect(readFileSync(join(w.copy(w.slot, 'deploy'), 'SKILL.md'), 'utf8')).toBe('# deploy')
    expect([...book.rows.values()].map((r) => r.skill)).toEqual(['deploy'])

    // The clean-up inside the lock (past its busy check, reading its records) when a session starts: it removes the
    // copy, and the launch, waiting for the lock, copies it again.
    busy = false
    let open!: () => void
    const gate = new Promise<void>((r) => (open = r))
    let reading!: () => void
    const inside = new Promise<void>((r) => (reading = r))
    const slow: SkillCopyBook = { ...book, of: async (f) => (reading(), await gate, book.of(f)) }
    const held = removeCombworkCopies(w.slot, w.project, slow, () => busy)
    await inside
    const third = launch()
    open()
    expect(await held).toEqual(['deploy'])
    await third
    expect(readFileSync(join(w.copy(w.slot, 'deploy'), 'SKILL.md'), 'utf8')).toBe('# deploy')
    expect([...book.rows.values()].map((r) => r.skill)).toEqual(['deploy'])
  })

  it('an edit made while the clean-up is part way through keeps the copy, at a session\'s end and at a launch', async () => {
    for (const via of ['clean-up', 'launch'] as const) {
      const w = world('deploy')
      // Made before records: the clean-up records it (an await) before removing it, and the user saves meanwhile.
      await sync(w.slot, w.project, w.sources)
      const file = join(w.copy(w.slot, 'deploy'), 'SKILL.md')
      const book = memBook()
      const editing: SkillCopyBook = { ...book, record: async (...a) => (writeFileSync(file, '# deploy, my edit'), book.record(...a)) }
      const removed = via === 'clean-up' ? await removeCombworkCopies(w.slot, w.project, editing, () => false) : (await sync(w.slot, w.project, [], editing), [])
      expect(removed, via).toEqual([])
      expect(readFileSync(file, 'utf8'), via).toBe('# deploy, my edit')
      // Its record is at the revision before the edit: never taken for Combwork's own again.
      expect(await removeCombworkCopies(w.slot, w.project, book, () => false), via).toEqual([])
      expect(readFileSync(file, 'utf8'), via).toBe('# deploy, my edit')
      expect(readdirSync(join(w.slot, '.agents', 'skills')).filter((f) => f.startsWith('.')), via).toEqual([])
    }
  })

  it('a skill switched off keeps its copy while another session of Combwork\'s works in the folder, and loses it once none does', async () => {
    const w = world('deploy', 'notes')
    const book = memBook()
    await sync(w.slot, w.project, w.sources, book)
    const [deploy] = w.sources
    let others = true
    const launch = (): Promise<unknown> => syncAgentsSkills({ cwd: w.slot, projectPath: w.project, skills: [deploy], copies: book, othersHere: () => others } as never, 'Codex')
    // A second session starts with notes switched off: the first may be reading it, so it stays.
    await launch()
    expect(readFileSync(join(w.copy(w.slot, 'notes'), 'SKILL.md'), 'utf8')).toBe('# notes')
    expect(existsSync(w.copy(w.slot, 'deploy'))).toBe(true)
    // The first has stopped: the next launch there removes it.
    others = false
    await launch()
    expect(existsSync(w.copy(w.slot, 'notes'))).toBe(false)
    expect([...book.rows.values()].map((r) => r.skill)).toEqual(['deploy'])
  })
})

describe('the switch: Slots only, Everywhere, Never (#1431)', () => {
  it('says where idle copies go', async () => {
    const { removesIn } = await import('../src/main/skillCopies')
    const project = 'D:\\ws\\proj'
    const slot = 'D:\\ws.worktrees\\proj\\slot-a'
    expect([removesIn(slot, project, 'slots'), removesIn(project, project, 'slots'), removesIn('d:/ws/proj/', project, 'slots')]).toEqual([true, false, false])
    expect([removesIn(slot, project, 'everywhere'), removesIn(project, project, 'everywhere')]).toEqual([true, true])
    expect([removesIn(slot, project, 'never'), removesIn(project, project, 'never')]).toEqual([false, false])
  })

  it("in a workspace: the record is combwork.db's, and each value removes the copies where it says, at a session's end and at start", async () => {
    const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
    const { advanced } = await import('../src/main/advanced')
    const { closeAllBoards } = await import('../src/main/boardStore')
    const { copyBook, initSkillCopies, removeCopiesIn, sessionEnded, sweepIdleCopies, idleCopies } = await import('../src/main/skillCopies')
    const w = world('deploy')
    mkdirSync(join(w.project, '.combwork'), { recursive: true })
    writeFileSync(join(w.project, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Agent 1' }] }))
    const ws = createWorkspaceService()
    await ws.open(w.root)
    const busy = new Set<string>()
    initSkillCopies((folder) => busy.has(folder))
    try {
      const book = copyBook(ws)
      const both = async () => {
        await sync(w.slot, w.project, w.sources, book)
        await sync(w.project, w.project, w.sources, book)
      }
      await both()
      expect([...(await book.of(w.slot)).keys()]).toEqual(['deploy'])
      expect([...(await book.of(w.project)).keys()]).toEqual(['deploy'])

      // Slots only (the default): a session ending in the slot removes its copies; in the project folder they stay.
      expect(idleCopies()).toBe('slots')
      busy.add(w.slot)
      expect(await sessionEnded(w.project, w.slot)).toEqual([])
      busy.delete(w.slot)
      expect(await sessionEnded(w.project, w.slot)).toEqual(['deploy'])
      expect(await sessionEnded(w.project, w.project)).toEqual([])
      expect(existsSync(w.copy(w.slot, 'deploy'))).toBe(false)
      expect(existsSync(w.copy(w.project, 'deploy'))).toBe(true)
      expect((await book.of(w.slot)).size).toBe(0)

      // At start: the slot's (made again) go; the project folder's stay.
      await both()
      await sweepIdleCopies(ws)
      expect([existsSync(w.copy(w.slot, 'deploy')), existsSync(w.copy(w.project, 'deploy'))]).toEqual([false, true])

      // Everywhere: the project folder's go too.
      await advanced.set(SKILLS_REMOVE_IDLE_COPIES, 'everywhere')
      await both()
      expect(await sessionEnded(w.project, w.project)).toEqual(['deploy'])
      await sweepIdleCopies(ws)
      expect([existsSync(w.copy(w.slot, 'deploy')), existsSync(w.copy(w.project, 'deploy'))]).toEqual([false, false])

      // Never: nothing goes, at a session's end or at start; a slot about to be removed still loses them (always).
      await advanced.set(SKILLS_REMOVE_IDLE_COPIES, 'never')
      await both()
      expect(await sessionEnded(w.project, w.slot)).toEqual([])
      await sweepIdleCopies(ws)
      expect([existsSync(w.copy(w.slot, 'deploy')), existsSync(w.copy(w.project, 'deploy'))]).toEqual([true, true])
      expect(await removeCopiesIn(w.project, w.slot, { always: true })).toEqual(['deploy'])
    } finally {
      await advanced.set(SKILLS_REMOVE_IDLE_COPIES, null)
      await disposeWorkspaceService(ws)
      closeAllBoards()
    }
  })
})

describe('choosing the skills delivered (#1431)', () => {
  it('a skill off in the workspace is off everywhere; a project switches off more, never one on again', () => {
    const ws = { skillDelivery: withSkillDelivered(undefined, 'Handover', false) }
    expect(ws.skillDelivery).toEqual({ off: ['handover'] })
    expect(skillOff('handover', ws)).toBe(true)
    expect(skillOff('pick-up', ws, { skillDelivery: { off: ['pick-up'] } })).toBe(true)
    expect(skillOff('pick-up', ws)).toBe(false)
    expect(skillOff('handover', ws, { skillDelivery: withSkillDelivered(undefined, 'handover', true) })).toBe(true)
    expect(withSkillDelivered(ws.skillDelivery, 'handover', true)).toEqual({ off: [] })
    // A hand-edited file may hold anything.
    expect([...offNames({ off: ['x', 3, null] as never })]).toEqual(['x'])
    expect([...offNames({ off: 'x' } as never)]).toEqual([])
  })

  it("a skill switched off isn't given at launch (Claude Code's plugin and the copies both take the launch's skills), and the copies lose it", async () => {
    const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
    const { sessions } = await import('../src/main/sessions')
    const { closeAllBoards } = await import('../src/main/boardStore')
    const w = world()
    mkdirSync(join(w.project, '.combwork'), { recursive: true })
    writeFileSync(join(w.project, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Agent 1' }] }))
    for (const name of ['deploy', 'notes', 'helper']) {
      mkdirSync(join(w.root, '.combwork', 'skills', name), { recursive: true })
      writeFileSync(join(w.root, '.combwork', 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: The ${name} skill.\n${name === 'helper' ? 'metadata:\n  audience: assistant\n' : ''}---\n\n# ${name}\n`)
    }
    const ws = createWorkspaceService()
    await ws.open(w.root)
    try {
      const names = async (p = w.project) => (await sessions.effective(p)).skills.map((s) => s.name).sort()
      expect(await names()).toEqual(['deploy', 'notes'])
      // Off in the project: its agents don't get it, nor count it as not delivered.
      await ws.mutateProjectConfig(w.project, (c) => ({ skillDelivery: withSkillDelivered(c.skillDelivery, 'notes', false) }))
      const eff = await sessions.effective(w.project)
      expect(eff.skills.map((s) => s.name)).toEqual(['deploy'])
      expect(Object.keys(eff.skillHashes)).toEqual(['deploy'])
      // Off in the workspace: no project's agents get it; the Assistant's own skills aren't chosen here.
      await ws.saveWorkspaceConfigWith((c) => ({ skillDelivery: withSkillDelivered(c.skillDelivery, 'deploy', false) }))
      expect(await names()).toEqual([])
      expect(await names(ws.assistantHome)).toEqual(['helper'])

      // The copies follow the launch's skills: the one switched off goes from Combwork's copies at the next launch.
      const book = memBook()
      const all = ['deploy', 'notes'].map((name) => ({ name, sourcePath: join(w.root, '.combwork', 'skills', name) }))
      await sync(w.slot, w.project, all, book)
      await sync(w.slot, w.project, all.filter((s) => s.name !== 'notes'), book)
      expect([existsSync(w.copy(w.slot, 'deploy')), existsSync(w.copy(w.slot, 'notes'))]).toEqual([true, false])
      expect([...book.rows.values()].map((r) => r.skill)).toEqual(['deploy'])
    } finally {
      await disposeWorkspaceService(ws)
      closeAllBoards()
    }
  })

  it("the guidance names only the skills delivered: switching one off drops it from the session contract", () => {
    const all = combworkInstructions('p')
    expect(all).toContain(boardSkillsLine())
    for (const skill of ['work-on-card', 'review-agent-work', 'card-loop', 'generalist']) {
      expect(all, skill).toContain(skill)
      const without = combworkInstructions('p', 'agent', true, new Set([skill]))
      expect(without, skill).not.toContain(skill)
    }
    expect(combworkInstructions('p', 'agent', true, new Set(['handover']))).not.toMatch(/\bhandovers,/)
    expect(boardSkillsLine(new Set(['work-on-card']))).toMatch(/Asked to review or check a card, use review-agent-work/)
    expect(boardSkillsLine(new Set(['work-on-card', 'review-agent-work', 'card-loop', 'handover', 'pick-up', 'workspace-note', 'merge-ready', 'split-work', 'use-cw-api', 'generalist']))).toBe("The board shows your project's cards, each named by its key (AM-12).")
    // The Assistant's own skills aren't chosen here.
    expect(combworkInstructions('', 'assistant', true, new Set(['handover']))).toBe(combworkInstructions('', 'assistant'))
  })
})
