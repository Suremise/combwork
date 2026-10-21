// The Assistant's journal in a workspace (#1031): its settings in workspace.json (on by default, work only), Hive's own
// facts (lanes started and ended with their merge, a card into Done, an unexpected close), nothing written while it is
// off or outside its scope while the entries are kept, the Assistant told when they change, and deleting it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { DEFAULT_JOURNAL } from '../src/shared/journal'
// The longest a wait here waits for what it waits on: a bound for a hung run (tests/README.md).
const HUNG_MS = 10_000

const base = tempDir('hive-journal-service-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const lanes = await import('../src/main/lanes')
const journal = await import('../src/main/journal')
const service = await import('../src/main/journalService')
const deliveries = await import('../src/main/deliveries')

vi.setConfig({ testTimeout: 30_000 })
type WS = ReturnType<typeof createWorkspaceService>
const user = { kind: 'user' } as const

describe('the journal in a workspace', () => {
  let w: WS
  const wsPath = join(base, 'ws')
  const trashDir = join(base, 'trash')
  beforeAll(async () => {
    process.env.HIVE_TEST_TRASH_DIR = trashDir
    // The Assistant reads an inbox (its CLI would say so as it starts).
    deliveries.setReadsInboxForTests(() => true)
    const p = join(wsPath, 'alpha')
    mkdirSync(join(p, '.hive'), { recursive: true })
    writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }] }))
    w = createWorkspaceService()
    await w.open(wsPath)
  })
  afterAll(async () => {
    delete process.env.HIVE_TEST_TRASH_DIR
    deliveries.setReadsInboxForTests(null)
    await disposeWorkspaceService(w)
  })
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
  const home = (): string => w.assistantHome
  /** A new card moved into Done by the user. */
  const doneCard = async (title: string): Promise<void> => {
    const c = await run(() => tasks.createTask({ title, project: 'alpha' }, user))
    await run(() => tasks.updateTask(c.number, { column: 'done' }, user))
  }
  const facts = (): string[] => (existsSync(journal.journalFile(home())) ? journal.recall(home(), { limit: 50 }).filter((r) => r.source === 'hive').map((r) => r.summary) : [])
  /** What the Assistant was told (its inbox's bodies). */
  const told = async (): Promise<string[]> => (await deliveries.deliveriesOf(home(), 'assistant')).map((d) => d.body)

  it('is on by default, work only, kept in workspace.json once changed', async () => {
    expect(service.journalSettingsOf(w)).toEqual(DEFAULT_JOURNAL)
    expect(service.journalStatus(w)).toEqual({ settings: DEFAULT_JOURNAL, bytes: 0, entries: 0 })
    const s = await service.setJournalSettings(w, { scope: ['decision', 'event', 'preference'], capMB: null })
    expect(s).toEqual({ ...DEFAULT_JOURNAL, scope: ['decision', 'event', 'preference'], capMB: null })
    expect(JSON.parse(readFileSync(join(wsPath, '.hive', 'workspace.json'), 'utf8')).journal).toEqual(s)
    // Told: the scope changed while it may be running.
    expect((await told()).at(-1)).toMatch(/scope changed: store only decision, event, preference entries/)
  })

  it('two changes at once each keep the other: off and no cap together leave it off with no cap (#1031 round 1)', async () => {
    const before = service.journalSettingsOf(w)
    const [a, b] = await Promise.all([service.setJournalSettings(w, { enabled: false }), service.setJournalSettings(w, { capMB: 20 })])
    expect(a.enabled).toBe(false)
    expect(b).toMatchObject({ enabled: false, capMB: 20 })
    expect(service.journalSettingsOf(w)).toEqual({ ...before, enabled: false, capMB: 20 })
    expect(JSON.parse(readFileSync(join(wsPath, '.hive', 'workspace.json'), 'utf8')).journal).toMatchObject({ enabled: false, capMB: 20 })
    // Told once that it went off (the cap's save changed nothing it tells).
    expect((await told()).filter((t) => /journal is off/.test(t))).toHaveLength(1)
    await Promise.all([service.setJournalSettings(w, { enabled: true }), service.setJournalSettings(w, { scope: before.scope, capMB: before.capMB })])
    expect(service.journalSettingsOf(w)).toEqual(before)
  })

  it("records Hive's facts: a lane started and ended with its merge, a card into Done", async () => {
    const [c1, c2] = [await run(() => tasks.createTask({ title: 'One', project: 'alpha' }, user)), await run(() => tasks.createTask({ title: 'Two', project: 'alpha' }, user))]
    const l = await run(() => lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [c1.number, c2.number], name: 'storage', by: 'B1 (alpha)' }))
    await run(() => tasks.updateTask(c1.number, { column: 'done' }, user))
    await run(() => lanes.endLane(w, l.lane.id, { mergeCommit: '45b5696b' }))
    expect(facts().reverse()).toEqual([
      `Lane "storage" started: B1 / R1, #${c1.number}, #${c2.number}`,
      `#${c1.number} "One" is Done (merged), moved there by You`,
      `Lane "storage" ended, merged at 45b5696b: B1 / R1, #${c1.number}, #${c2.number}`
    ])
    // Linked and marked: the merge is important and points at its commit and cards.
    const merged = journal.recall(home(), { link: { type: 'commit', ref: '45b5696b' } })
    expect(merged).toHaveLength(1)
    expect(journal.readEntry(home(), merged[0].id)).toMatchObject({ kind: 'event', source: 'hive', project: 'alpha', importance: 2, tags: ['hive', 'lane'] })
    expect(journal.recall(home(), { link: { type: 'card', ref: String(c1.number) } })).toHaveLength(3)
  })

  it('an unexpected close is a fact for the workspace, open or not', async () => {
    await service.journalFactAt(wsPath, { summary: 'Hive closed unexpectedly (a test)', importance: 2, tags: ['incident'] })
    expect(facts()[0]).toBe('Hive closed unexpectedly (a test)')
  })

  it('off: nothing written, the entries kept; facts outside the scope neither; on again, as before', async () => {
    const before = facts().length
    await service.setJournalSettings(w, { enabled: false })
    expect((await told()).at(-1)).toMatch(/journal is off: nothing is written .* Its entries are kept/)
    await doneCard('Three')
    expect(facts()).toHaveLength(before)
    expect(service.journalStatus(w).entries).toBeGreaterThanOrEqual(before)
    // On, but events out of the scope: Hive's facts aren't written either.
    await service.setJournalSettings(w, { enabled: true, scope: ['decision'] })
    expect((await told()).at(-1)).toMatch(/journal is on again/)
    await doneCard('Four')
    expect(facts()).toHaveLength(before)
    await service.setJournalSettings(w, { scope: ['decision', 'event'] })
    await doneCard('Five')
    expect(facts()[0]).toMatch(/"Five" is Done/)
  })

  it('a tighter retention prunes at once; Delete Journal sends it to the Recycle Bin and tells the Assistant', async () => {
    const id = journal.writeEntry(home(), service.journalSettingsOf(w), { kind: 'decision', summary: 'An old everyday decision' }, 'assistant')
    journal.closeJournal(home())
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(journal.journalFile(home()))
    db.prepare('UPDATE entries SET at = ? WHERE id = ?').run(new Date(Date.now() - 60 * 86_400_000).toISOString(), id)
    db.close()
    await service.setJournalSettings(w, { retentionDays: 30 })
    expect(journal.readEntry(home(), id)).toBeNull()
    await service.deleteWorkspaceJournal(w)
    expect(existsSync(journal.journalFile(home()))).toBe(false)
    await vi.waitFor(() => expect(readFileSync(join(trashDir, 'trash.jsonl'), 'utf8')).toContain('journal.db'), { timeout: HUNG_MS })
    expect((await told()).at(-1)).toMatch(/deleted your journal/)
    expect(service.journalStatus(w)).toMatchObject({ bytes: 0, entries: 0 })
  })
})
