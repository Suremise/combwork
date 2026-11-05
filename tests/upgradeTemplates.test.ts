// 0.9's agent templates at the upgrade to 1.0 (#1436; Darren's 19 Oct decision on #1123, and the Assistant's 23 Oct scope
// call: copy only): nothing is copied while the upgrade waits; once upgraded, each 0.9 template of the workspace and of
// each project is copied into the 0.9 backup's folder (by the project's id), the originals left byte for byte as they
// were (a 1.0 template, a damaged file and a .bak not copied); 1.0 never lists, loads or deletes a 0.9 file; it is done
// once (board_meta), again, twice at once and overlapping copying each template once and never touching another run's
// temporary file; a folder or file that can't be read leaves it unmarked for the next open; one quiet notice says a copy
// is kept.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { as09 } from './boardDb'
import { TEMPLATE_VERSION } from '../src/shared/templates'
import type { HiveEvent } from '../src/shared/types'

const base = tempDir('hive-upgrade-templates-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const step = await import('../src/main/templateUpgrade')
const templates = await import('../src/main/templates')

// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take.
const HUNG_MS = 15000
let n = 0
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})
afterEach(() => {
  store.boardTestHooks.upgradeAnswer = null
  step.testHooks.fail = undefined
  step.testHooks.beforePublish = undefined
})

async function open(ws: string): Promise<WS> {
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return w
}
async function close(w: WS): Promise<void> {
  const path = w.path!
  opened.splice(opened.indexOf(w), 1)
  await disposeWorkspaceService(w)
  store.closeBoard(path)
}

const v1 = (name: string): string => JSON.stringify({ version: 1, name, savedAt: '', layout: 'auto', agents: [{ name: 'A', provider: 'claude-code', worktree: true }] })
const v2 = (name: string): string => JSON.stringify({ version: TEMPLATE_VERSION, name, savedAt: '', layout: 'auto', agents: [{ name: 'A', role: 'builder', provider: 'claude-code' }] })
/** A folder's files, a damaged one by its name before reading it set it aside (`readKeptJson`: `.corrupt-<time>`). */
const files = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).map((f) => f.replace(/\.corrupt-.*$/, '')).sort() : [])

/**
 * A workspace as 0.9 left it: project p (with its own templates), a board of 0.9's, and in the workspace's templates two
 * of 0.9's (one with its kept copy), a 1.0 one and a damaged one.
 */
async function workspace09(): Promise<{ ws: string; wsTemplates: string; pTemplates: string }> {
  const ws = join(base, `ws-${++n}`)
  const wsTemplates = join(ws, '.combwork', 'templates')
  const pTemplates = join(ws, 'p', '.combwork', 'templates')
  mkdirSync(pTemplates, { recursive: true })
  writeFileSync(join(ws, 'p', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Agent 1' }] }))
  const w = await open(ws)
  await inWorkspace(w, () => tasks.createTask({ title: 'From 0.9', project: 'p' }, { kind: 'user' }))
  await close(w)
  as09(store.boardFile(ws))
  mkdirSync(wsTemplates, { recursive: true })
  writeFileSync(join(wsTemplates, 'pair.json'), v1('Pair'))
  writeFileSync(join(wsTemplates, 'pair.json.bak'), v1('Pair'))
  writeFileSync(join(wsTemplates, 'team.json'), v1('Team'))
  writeFileSync(join(wsTemplates, 'new.json'), v2('New'))
  writeFileSync(join(wsTemplates, 'damaged.json'), '{ nope')
  writeFileSync(join(pTemplates, 'mine.json'), v1('Mine'))
  return { ws, wsTemplates, pTemplates }
}

/** The quiet notices a workspace's window would be shown. */
function notices(w: WS): { title: string; message: string }[] {
  const seen: { title: string; message: string }[] = []
  const emit = w.emit.bind(w)
  w.emit = ((e: HiveEvent) => {
    if (e.type === 'toast') seen.push({ title: e.toast.title, message: e.toast.message ?? '' })
    return emit(e)
  }) as typeof w.emit
  return seen
}

/** Each file of a folder with its bytes: what must stay exactly as it was. */
const snapshot = (dir: string): Record<string, string> => Object.fromEntries(files(dir).map((f) => [f, readFileSync(join(dir, f), 'latin1')]))
/** The mark gone, as after Restore the 0.9 Board Backup and another upgrade (the board put back has none). */
const unmark = (w: WS): Promise<void> => inWorkspace(w, () => store.boardWrite(w, async () => void store.boardWriteOp(w, (db) => db.prepare("DELETE FROM board_meta WHERE key = 'templates.v09'").run())))
/** An error as the file system gives one (EACCES: a file or folder another program holds). */
const ioError = (what: string): NodeJS.ErrnoException => Object.assign(new Error(`EACCES: permission denied, ${what}`), { code: 'EACCES' })

describe("0.9's agent templates at the upgrade to 1.0 (#1436)", () => {
  it('waits for the upgrade; then copies each 0.9 template once, leaves the originals as they were, never lists them, says so once', async () => {
    const { ws, wsTemplates, pTemplates } = await workspace09()
    let w = await open(ws)
    // The upgrade waits: nothing copied.
    expect(await inWorkspace(w, () => step.copyV09Templates(w))).toBeNull()
    expect(await step.backupFiles(ws)).toEqual([])
    await close(w)
    store.boardTestHooks.upgradeAnswer = 'yes'
    w = await open(ws)
    const said = notices(w)
    const before = [snapshot(wsTemplates), snapshot(pTemplates)]
    expect(await inWorkspace(w, () => step.copyV09Templates(w))).toBe(3)
    // The originals byte for byte; copies of the three 0.9 templates (not the .bak, the 1.0 one or the damaged one).
    expect([snapshot(wsTemplates), snapshot(pTemplates)]).toEqual(before)
    const id = (await w.projectIds()).byPath.get(join(ws, 'p').toLowerCase())!
    expect(await step.backupFiles(ws)).toEqual(['workspace/pair.json', 'workspace/team.json', `projects/${id}/mine.json`].sort())
    expect(readFileSync(join(ws, '.combwork', 'backups', step.V09_TEMPLATES, 'workspace', 'pair.json'), 'utf8')).toBe(v1('Pair'))
    // 1.0 lists only its own: the 0.9 files aren't listed, loaded, added from or deleted.
    const listed = await inWorkspace(w, () => templates.listTemplates(join(ws, 'p')))
    expect(listed.filter((t) => t.scope !== 'combwork').map((t) => t.file).sort()).toEqual(['damaged.json', 'new.json'])
    await expect(inWorkspace(w, () => templates.templatePlan(join(ws, 'p'), 'workspace', 'pair.json'))).rejects.toThrow(/no longer there/)
    await expect(inWorkspace(w, () => templates.addAgentFromTemplate(join(ws, 'p'), 'project', 'mine.json', 0))).rejects.toThrow(/no longer there/)
    await expect(inWorkspace(w, () => templates.deleteTemplate({ scope: 'workspace', file: 'team.json' }))).rejects.toThrow(/no longer there/)
    // A save of that name makes a new file beside the 0.9 one, never over it.
    await inWorkspace(w, () => templates.saveTemplate(join(ws, 'p'), 'workspace', 'Pair'))
    expect(readFileSync(join(wsTemplates, 'pair.json'), 'utf8')).toBe(v1('Pair'))
    // Done once.
    expect(await inWorkspace(w, () => step.copyV09Templates(w))).toBeNull()
    await step.sayV09TemplatesOnce(w)
    await expect.poll(() => store.boardValue(w, 'templates.v09.notice'), { timeout: HUNG_MS }).toBe('said')
    await step.sayV09TemplatesOnce(w)
    expect(said).toEqual([{ title: 'Your 0.9 agent templates aren’t used in 1.0', message: '1.0 templates don’t pin agents to worktrees, so the Combwork templates take their place. A copy of the 3 templates is kept with the 0.9 board backup.' }])
    await close(w)
  })

  it('again (the mark gone) and twice at once: each template copied once', async () => {
    const { ws } = await workspace09()
    store.boardTestHooks.upgradeAnswer = 'yes'
    const w = await open(ws)
    const both = await Promise.all([inWorkspace(w, () => step.copyV09Templates(w)), inWorkspace(w, () => step.copyV09Templates(w))])
    expect(both.every((x) => typeof x === 'number')).toBe(true)
    const id = (await w.projectIds()).byPath.get(join(ws, 'p').toLowerCase())!
    const once = ['workspace/pair.json', 'workspace/team.json', `projects/${id}/mine.json`].sort()
    expect(await step.backupFiles(ws)).toEqual(once)
    await unmark(w)
    expect(await inWorkspace(w, () => step.copyV09Templates(w))).toBe(0)
    expect(await step.backupFiles(ws)).toEqual(once)
    await close(w)
  })

  it("two runs overlapping (HR3's round 4): one paused with its copy written, not yet published, while the other runs through; both complete, the originals unchanged, each template copied once", async () => {
    const { ws, wsTemplates } = await workspace09()
    store.boardTestHooks.upgradeAnswer = 'yes'
    const w = await open(ws)
    const before = snapshot(wsTemplates)
    let reached!: () => void
    let release!: () => void
    const atGate = new Promise<void>((r) => (reached = r))
    const gate = new Promise<void>((r) => (release = r))
    step.testHooks.beforePublish = async (part) => {
      if (!part.includes('.pair.json.')) return
      step.testHooks.beforePublish = undefined
      reached()
      await gate
    }
    const a = inWorkspace(w, () => step.copyV09Templates(w))
    await atGate
    // The other run, start to finish, while the first holds its temporary copy of pair.json.
    const b = await inWorkspace(w, () => step.copyV09Templates(w))
    release()
    const first = await a
    expect([typeof first, b]).toEqual(['number', 3])
    const id = (await w.projectIds()).byPath.get(join(ws, 'p').toLowerCase())!
    expect(await step.backupFiles(ws)).toEqual(['workspace/pair.json', 'workspace/team.json', `projects/${id}/mine.json`].sort())
    expect(snapshot(wsTemplates)).toEqual(before)
    await close(w)
  })

  it('a template changed since its copy is copied again beside it (pair-2.json); the first copy stays', async () => {
    const { ws, wsTemplates } = await workspace09()
    store.boardTestHooks.upgradeAnswer = 'yes'
    const w = await open(ws)
    await inWorkspace(w, () => step.copyV09Templates(w))
    writeFileSync(join(wsTemplates, 'pair.json'), v1('Pair, edited in 0.9'))
    await unmark(w)
    expect(await inWorkspace(w, () => step.copyV09Templates(w))).toBe(1)
    const kept = join(ws, '.combwork', 'backups', step.V09_TEMPLATES, 'workspace')
    expect(files(kept)).toEqual(['pair-2.json', 'pair.json', 'team.json'])
    expect([readFileSync(join(kept, 'pair.json'), 'utf8'), readFileSync(join(kept, 'pair-2.json'), 'utf8')]).toEqual([v1('Pair'), v1('Pair, edited in 0.9')])
    await close(w)
  })

  it("a folder or file that can't be read, or a copy that can't be written, leaves it unmarked; the next open goes on; a copy cut short is cleaned up", async () => {
    const { ws, wsTemplates } = await workspace09()
    store.boardTestHooks.upgradeAnswer = 'yes'
    const w = await open(ws)
    const cases: [op: 'scan' | 'read' | 'write', match: (p: string) => boolean][] = [
      ['scan', (p) => resolve(p).toLowerCase() === resolve(wsTemplates).toLowerCase()],
      ['read', (p) => p.endsWith('team.json')],
      // (pair.json is copied by then: team.json's copy fails to be written.)
      ['write', (p) => p.endsWith('team.json')]
    ]
    for (const [op, match] of cases) {
      step.testHooks.fail = (o, path) => {
        if (o === op && match(path)) throw ioError(`${op} '${path}'`)
      }
      await expect(inWorkspace(w, () => step.copyV09Templates(w)), op).rejects.toThrow(/EACCES/)
      expect(store.boardValue(w, 'templates.v09'), op).toBeNull()
    }
    step.testHooks.fail = undefined
    // A copy a crash left half written: never a template's name, so harmless, and left alone (it may be another run's).
    const kept = join(ws, '.combwork', 'backups', step.V09_TEMPLATES, 'workspace')
    mkdirSync(kept, { recursive: true })
    writeFileSync(join(kept, '.team.json.0123456789ab.part'), '{"version": 1, "na')
    await inWorkspace(w, () => step.copyV09Templates(w))
    expect(files(kept)).toEqual(['.team.json.0123456789ab.part', 'pair.json', 'team.json'])
    expect(store.boardValue(w, 'templates.v09')).not.toBeNull()
    await close(w)
  })

  it('a workspace made in 1.0 has nothing to copy: marked done, nothing said', async () => {
    const ws = join(base, `ws-${++n}`)
    mkdirSync(join(ws, 'p', '.combwork'), { recursive: true })
    writeFileSync(join(ws, 'p', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    const w = await open(ws)
    const said = notices(w)
    expect(await inWorkspace(w, () => step.copyV09Templates(w))).toBe(0)
    expect(store.boardValue(w, 'templates.v09')).toBe('0')
    await step.sayV09TemplatesOnce(w)
    expect(said).toEqual([])
    expect(existsSync(join(ws, '.combwork', 'backups', step.V09_TEMPLATES))).toBe(false)
    await close(w)
  })
})
