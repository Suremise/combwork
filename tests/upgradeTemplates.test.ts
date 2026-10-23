// 0.9's agent templates at the upgrade to 1.0 (#1436; Darren's 19 Oct decision on #1123: wiped, with Hive's own in their
// place): nothing moves while the upgrade waits; once upgraded, the workspace's and each project's 0.9 files (with their
// kept copies) go into the 0.9 backup's folder, by the project's id, and a 1.0 template, a damaged file and anything else
// stay; it is done once (board_meta), twice at once moves each file once, one quiet notice says so, and Help → Restore
// the 0.9 Board Backup… puts them back for 0.9.3 without replacing a template saved since.
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs'
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

/** An error as the file system gives one (EACCES: a file or folder another program holds). */
const ioError = (what: string): NodeJS.ErrnoException => Object.assign(new Error(`EACCES: permission denied, ${what}`), { code: 'EACCES' })

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
  const wsTemplates = join(ws, '.hive', 'templates')
  const pTemplates = join(ws, 'p', '.hive', 'templates')
  mkdirSync(pTemplates, { recursive: true })
  writeFileSync(join(ws, 'p', '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Agent 1' }] }))
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

describe("0.9's agent templates at the upgrade to 1.0 (#1436)", () => {
  it('waits for the upgrade; then moves 0.9\'s files into the backup once, says so once, and Restore puts them back', async () => {
    const { ws, wsTemplates, pTemplates } = await workspace09()
    let w = await open(ws)
    // The upgrade waits: nothing moves.
    expect(await inWorkspace(w, () => step.setAsideV09Templates(w))).toBeNull()
    expect(files(wsTemplates)).toEqual(['damaged.json', 'new.json', 'pair.json', 'pair.json.bak', 'team.json'])
    // 1.0 lists them meanwhile as 0.9's, which it can't use.
    const listed = await inWorkspace(w, () => templates.listTemplates(join(ws, 'p')))
    expect(listed.find((t) => t.scope === 'workspace' && t.file === 'team.json')?.problem).toMatch(/from Hive 0\.9 and can't be loaded in 1\.0/)
    await close(w)
    store.boardTestHooks.upgradeAnswer = 'yes'
    w = await open(ws)
    const said = notices(w)
    expect(await inWorkspace(w, () => step.setAsideV09Templates(w))).toBe(3)
    // 0.9's (and the kept copy) gone; the 1.0 template and the damaged file stay.
    expect(files(wsTemplates)).toEqual(['damaged.json', 'new.json'])
    expect(files(pTemplates)).toEqual([])
    const id = (await w.projectIds()).byPath.get(join(ws, 'p').toLowerCase())!
    expect(await step.setAsideFiles(ws)).toEqual(['workspace/pair.json', 'workspace/pair.json.bak', 'workspace/team.json', `projects/${id}/mine.json`].sort())
    expect(JSON.parse(readFileSync(join(ws, '.hive', 'backups', step.V09_TEMPLATES, 'projects', id, 'mine.json'), 'utf8')).name).toBe('Mine')
    // Once: again, nothing to do; a 0.9 file put there by hand later stays (listed as 0.9's).
    writeFileSync(join(wsTemplates, 'late.json'), v1('Late'))
    expect(await inWorkspace(w, () => step.setAsideV09Templates(w))).toBeNull()
    expect(files(wsTemplates)).toContain('late.json')
    // Said once, quietly.
    await step.sayV09TemplatesOnce(w)
    await expect.poll(() => store.boardValue(w, 'templates.v09.notice'), { timeout: HUNG_MS }).toBe('said')
    await step.sayV09TemplatesOnce(w)
    expect(said).toEqual([{ title: 'Your 0.9 agent templates were set aside', message: "1.0 templates don't pin agents to worktrees. The Hive templates replace them; the 3 files are kept with the 0.9 board backup." }])
    // A template saved since under one of their names isn't replaced by Restore: that one stays in the backup.
    writeFileSync(join(wsTemplates, 'team.json'), v2('Team again'))
    await inWorkspace(w, () => store.restoreBoardBackup(w, () => 0))
    expect(await inWorkspace(w, () => step.putBackV09Templates(w))).toBe(2)
    expect(files(wsTemplates)).toEqual(['damaged.json', 'late.json', 'new.json', 'pair.json', 'pair.json.bak', 'team.json'])
    expect(JSON.parse(readFileSync(join(wsTemplates, 'team.json'), 'utf8')).name).toBe('Team again')
    expect(files(pTemplates)).toEqual(['mine.json'])
    expect(await step.setAsideFiles(ws)).toEqual(['workspace/team.json'])
    // The board put back has no mark: upgraded again, those put back are set aside again.
    await inWorkspace(w, () => store.upgradeBoard(w))
    // (Team again is 1.0's: it stays.)
    expect(await inWorkspace(w, () => step.setAsideV09Templates(w))).toBe(3)
    expect(files(wsTemplates)).toEqual(['damaged.json', 'new.json', 'team.json'])
    expect(await step.setAsideFiles(ws)).toEqual(['workspace/late.json', 'workspace/pair.json', 'workspace/pair.json.bak', 'workspace/team.json', `projects/${id}/mine.json`].sort())
    await close(w)
  })

  it("two runs at once in one Hive move each file once, losing none (the folder's lock)", async () => {
    const { ws, wsTemplates } = await workspace09()
    store.boardTestHooks.upgradeAnswer = 'yes'
    const w = await open(ws)
    const said = notices(w)
    const both = await Promise.all([inWorkspace(w, () => step.setAsideV09Templates(w)), inWorkspace(w, () => step.setAsideV09Templates(w))])
    // Both ran (neither had seen the other's mark); each 0.9 file is in the backup once, none lost or numbered twice.
    expect(both.every((x) => typeof x === 'number')).toBe(true)
    expect(files(wsTemplates)).toEqual(['damaged.json', 'new.json'])
    const id = (await w.projectIds()).byPath.get(join(ws, 'p').toLowerCase())!
    expect(await step.setAsideFiles(ws)).toEqual(['workspace/pair.json', 'workspace/pair.json.bak', 'workspace/team.json', `projects/${id}/mine.json`].sort())
    // The notice counts what the backup holds, whichever of them moved it.
    await step.sayV09TemplatesOnce(w)
    expect(said.map((s) => s.message)).toEqual([expect.stringContaining('the 3 files are kept')])
    await close(w)
  })

  it('another Hive (another process, no shared lock) moving a file first: this one leaves it, never a second copy', async () => {
    const { ws, wsTemplates } = await workspace09()
    store.boardTestHooks.upgradeAnswer = 'yes'
    const w = await open(ws)
    // Just before this run publishes pair.json, the other Hive's whole move of it (link, then unlink) happens.
    const kept = join(ws, '.hive', 'backups', step.V09_TEMPLATES, 'workspace')
    step.testHooks.beforePublish = async (dest) => {
      if (dest !== join(kept, 'pair.json')) return
      step.testHooks.beforePublish = undefined
      mkdirSync(kept, { recursive: true })
      linkSync(join(wsTemplates, 'pair.json'), join(kept, 'pair-2.json'))
      unlinkSync(join(wsTemplates, 'pair.json'))
    }
    await inWorkspace(w, () => step.setAsideV09Templates(w))
    // pair.json once, where the other Hive put it; its kept copy stays for the other Hive to move (or a later run).
    expect((await step.setAsideFiles(ws)).filter((f) => /pair(-2)?\.json$/.test(f))).toEqual(['workspace/pair-2.json'])
    expect(files(wsTemplates)).toEqual(['damaged.json', 'new.json', 'pair.json.bak'])
    await close(w)
  })

  it("a folder or file that can't be read stops the run unmarked (none lost), and the next open goes on (HR3's round 1, 3)", async () => {
    const { ws, wsTemplates, pTemplates } = await workspace09()
    store.boardTestHooks.upgradeAnswer = 'yes'
    const w = await open(ws)
    // The workspace's folder can't be listed: nothing marked, its 0.9 files where they were.
    step.testHooks.fail = (op, path) => {
      if (op === 'scan' && resolve(path).toLowerCase() === resolve(wsTemplates).toLowerCase()) throw ioError(`scandir '${path}'`)
    }
    await expect(inWorkspace(w, () => step.setAsideV09Templates(w))).rejects.toThrow(/EACCES/)
    expect(store.boardValue(w, 'templates.v09')).toBeNull()
    expect(files(wsTemplates)).toContain('pair.json')
    // A template moved but its kept copy not (the run cut short between them): unmarked; the copy follows next time.
    step.testHooks.fail = (op, path) => {
      if (op === 'move' && path.endsWith('pair.json.bak')) throw ioError(`link '${path}'`)
    }
    await expect(inWorkspace(w, () => step.setAsideV09Templates(w))).rejects.toThrow(/EACCES/)
    expect(store.boardValue(w, 'templates.v09')).toBeNull()
    expect(files(wsTemplates)).toContain('pair.json.bak')
    expect(await step.setAsideFiles(ws)).toContain('workspace/pair.json')
    // A file that can't be read: the same.
    step.testHooks.fail = (op, path) => {
      if (op === 'read' && path.endsWith('team.json')) throw ioError(`open '${path}'`)
    }
    await expect(inWorkspace(w, () => step.setAsideV09Templates(w))).rejects.toThrow(/EACCES/)
    expect(store.boardValue(w, 'templates.v09')).toBeNull()
    expect(files(wsTemplates)).toContain('team.json')
    step.testHooks.fail = undefined
    await inWorkspace(w, () => step.setAsideV09Templates(w))
    const id = (await w.projectIds()).byPath.get(join(ws, 'p').toLowerCase())!
    expect(await step.setAsideFiles(ws)).toEqual(['workspace/pair.json', 'workspace/pair.json.bak', 'workspace/team.json', `projects/${id}/mine.json`].sort())
    expect(files(wsTemplates)).toEqual(['damaged.json', 'new.json'])
    expect(files(pTemplates)).toEqual([])
    expect(store.boardValue(w, 'templates.v09')).not.toBeNull()
    await close(w)
  })

  it("Restore never replaces a template saved meanwhile, in any process: its bytes stay, and so does the backup's (HR3's round 1, 1)", async () => {
    const { ws, wsTemplates } = await workspace09()
    store.boardTestHooks.upgradeAnswer = 'yes'
    const w = await open(ws)
    expect(await inWorkspace(w, () => step.setAsideV09Templates(w))).toBe(3)
    await inWorkspace(w, () => store.restoreBoardBackup(w, () => 0))
    // A template saved as pair.json just as Restore publishes 0.9's (after any look it could take first).
    const saved = v2('Saved meanwhile')
    step.testHooks.beforePublish = async (dest) => {
      if (dest === join(wsTemplates, 'pair.json')) writeFileSync(dest, saved)
    }
    expect(await inWorkspace(w, () => step.putBackV09Templates(w))).toBe(2)
    expect(readFileSync(join(wsTemplates, 'pair.json'), 'utf8')).toBe(saved)
    // The 0.9 one stays in the backup, with its kept copy; the others went back.
    expect(await step.setAsideFiles(ws)).toEqual(['workspace/pair.json', 'workspace/pair.json.bak'])
    expect(files(wsTemplates)).toEqual(['damaged.json', 'new.json', 'pair.json', 'team.json'])
    await close(w)
  })

  it('a workspace made in 1.0 has nothing to set aside: marked done, nothing said', async () => {
    const ws = join(base, `ws-${++n}`)
    mkdirSync(join(ws, 'p', '.hive'), { recursive: true })
    writeFileSync(join(ws, 'p', '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    const w = await open(ws)
    const said = notices(w)
    expect(await inWorkspace(w, () => step.setAsideV09Templates(w))).toBe(0)
    expect(store.boardValue(w, 'templates.v09')).toBe('0')
    await step.sayV09TemplatesOnce(w)
    expect(said).toEqual([])
    expect(existsSync(join(ws, '.hive', 'backups', step.V09_TEMPLATES))).toBe(false)
    await close(w)
  })
})
