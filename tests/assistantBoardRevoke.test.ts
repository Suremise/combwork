// The Assistant's card additions and comments revoked while queued (HI-2415), on the real board (a temp hive.db): admitted
// while Control allowed changes, then waiting behind another board write, the user turns Control down or the Assistant's
// session ends; the change's `commit` check (assistantChange's guard) runs just before each write, so nothing is saved:
// no card, no comment, no attachment file or row.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-assistrevoke-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const att = await import('../src/main/cardAttachments')

type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const user = { kind: 'user' } as const
const assistant = { kind: 'assistant' } as const
let n = 0

async function workspace(): Promise<WS> {
  const root = join(base, `ws-${++n}`)
  mkdirSync(join(root, 'p', '.hive'), { recursive: true })
  writeFileSync(join(root, 'p', '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
  const w = createWorkspaceService()
  await w.open(root)
  opened.push(w)
  return w
}

const cardCount = (w: WS): number => (store.boardRead(w, (db) => db.prepare('SELECT COUNT(*) AS n FROM cards').get()) as { n: number }).n
const attachmentRows = (w: WS): number => (store.boardRead(w, (db) => db.prepare('SELECT COUNT(*) AS n FROM card_attachments').get()) as { n: number }).n

/** A guard as assistantChange gives it: fine until revoked, then it throws (ChangeRefused's message). */
function authority() {
  let revoked = false
  return {
    revoke: () => (revoked = true),
    guard: () => {
      if (revoked) throw new Error('Control was turned down meanwhile')
    }
  }
}

/** Holds the board's lock (another board write under way) until released. */
function holdBoard(w: WS): { release: () => void; done: Promise<void> } {
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  const done = inWorkspace(w, () => tasks.boardLock(w, () => held))
  return { release, done }
}

/**
 * Holds the card's save at its own read of the project ids (saveCard's last await before the write, HR2's round 1): `reached`
 * once it waits there, until released. Only that read, so the change's checks before it have all run.
 */
function holdSave(w: WS): { reached: Promise<void>; release: () => void; restore: () => void } {
  const original = w.projectIds.bind(w)
  let reach!: () => void
  let release!: () => void
  const reached = new Promise<void>((r) => (reach = r))
  const gate = new Promise<void>((r) => (release = r))
  let armed = true
  w.projectIds = async (...args: Parameters<WS['projectIds']>) => {
    if (armed && new Error().stack?.includes('saveCard')) {
      armed = false
      reach()
      await gate
    }
    return original(...args)
  }
  return { reached, release, restore: () => void (w.projectIds = original) }
}

describe("the Assistant's queued board changes, revoked before they're written (HI-2415)", () => {
  it("revoked while the save itself reads the project ids (after every other check): no card, comment or change saved (HR2's round 1)", async () => {
    const w = await workspace()
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'Card', project: 'p' }, user))
    const before = cardCount(w)
    const cases: [string, (guard: () => void) => Promise<unknown>][] = [
      ['a new card', (guard) => tasks.createTask({ title: 'Held', project: 'p' }, assistant, { commit: guard })],
      ['a comment', (guard) => tasks.commentTask(c.number, 'Held comment', assistant, { commit: guard })],
      ['a change', (guard) => tasks.updateTask(c.number, { title: 'Renamed while held' }, assistant, { commit: guard })]
    ]
    for (const [what, run] of cases) {
      const a = authority()
      const hold = holdSave(w)
      try {
        const op = inWorkspace(w, () => run(a.guard))
        await hold.reached
        a.revoke()
        hold.release()
        await expect(op, what).rejects.toThrow(/turned down/)
      } finally {
        hold.restore()
      }
    }
    expect(cardCount(w)).toBe(before)
    const now = await inWorkspace(w, () => tasks.getTask(c.number, w))
    expect(now.title).toBe('Card')
    expect(now.comments).toEqual([])
  })

  it('a card added while another board write holds the lock, revoked meanwhile: no card', async () => {
    const w = await workspace()
    const before = cardCount(w)
    const a = authority()
    const lock = holdBoard(w)
    const made = inWorkspace(w, () => tasks.createTask({ title: 'Queued', project: 'p' }, assistant, { commit: a.guard }))
    a.revoke()
    lock.release()
    await lock.done
    await expect(made).rejects.toThrow(/turned down/)
    expect(cardCount(w)).toBe(before)
    // Not revoked: the same call adds it.
    await inWorkspace(w, () => tasks.createTask({ title: 'Allowed', project: 'p' }, assistant, { commit: authority().guard }))
    expect(cardCount(w)).toBe(before + 1)
  })

  it('a comment queued the same way, revoked meanwhile: the card keeps its comments', async () => {
    const w = await workspace()
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'Card', project: 'p' }, user))
    const a = authority()
    const lock = holdBoard(w)
    const said = inWorkspace(w, () => tasks.commentTask(c.number, 'Queued comment', assistant, { commit: a.guard }))
    a.revoke()
    lock.release()
    await lock.done
    await expect(said).rejects.toThrow(/turned down/)
    expect((await inWorkspace(w, () => tasks.getTask(c.number, w))).comments).toEqual([])
  })

  it('a card with files, revoked after the card is made but before its files are written: no card, no attachment row or file', async () => {
    const w = await workspace()
    const before = cardCount(w)
    const src = join(tempDir('hive-assistrevoke-src-'), 'shot.png')
    writeFileSync(src, 'png bytes')
    const real = await att.attachableSource(w, { kind: 'workspace' }, src)
    const staging = await att.stage(join(w.path!, 'p'), null, [{ path: real, name: 'shot.png' }])
    // Fine for the card's own write, revoked by the time the files are (their publish awaited meanwhile).
    let checks = 0
    const guard = () => {
      if (++checks > 1) throw new Error('The Assistant was restarted meanwhile')
    }
    await expect(inWorkspace(w, () => tasks.changeWithAttachments(assistant, { staging, drafts: [null] }, 'description', () => tasks.createTask({ title: 'With a shot', project: 'p' }, assistant, { commit: guard }), guard))).rejects.toThrow(/restarted/)
    expect(checks).toBe(2)
    expect(cardCount(w)).toBe(before)
    expect(attachmentRows(w)).toBe(0)
    const folder = join(w.path!, 'p', '.hive', 'attachments', 'cards')
    const files = existsSync(folder) ? readdirSync(folder, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()) : []
    expect(files).toEqual([])
  })
})
