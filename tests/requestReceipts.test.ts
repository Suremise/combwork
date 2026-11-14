// HI-3195 (Darren's decision of 14 Nov, "ok (b)"): a project agent's keyed write is applied once. Its durable "applied"
// marker is saved in the write's own board transaction, so a retry with the same key (after a lost reply, a crash before
// the reply, the board reopened) is answered "already applied" with what it produced, never written again; a retry of
// one still in flight joins it; a key reused for another request is refused; another connection's commit of the same
// key undoes this one's write; a refused first try runs again; markers expire after 24 hours; in flight is bounded.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-receipts-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const receipts = await import('../src/main/requestReceipts')
const { advanced } = await import('../src/main/advanced')

advanced.load(join(base, 'profile'))
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  advanced.stop()
  for (const w of opened) await disposeWorkspaceService(w).catch(() => undefined)
  store.closeAllBoards()
})

const user = { kind: 'user' } as const
const agent = { kind: 'agent' as const, name: 'Builder (p)', self: { project: 'p', agentId: 'a1' }, scope: 'p' }
let n = 0

async function workspace(path = join(base, `ws-${++n}`)): Promise<{ w: WS; path: string }> {
  const repo = join(path, 'p')
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Builder' }] }))
  } catch {
    // Opened again: already made.
  }
  const w = createWorkspaceService()
  await w.open(path)
  opened.push(w)
  return { w, path }
}
const req = (key: string, body: unknown = { text: 'A note' }, card = '#1') => ({ run: 'run-1', key, fingerprint: receipts.fingerprintOf('POST', '/v1/tasks/:n/comments', [card], body), route: 'POST /v1/tasks/:n/comments', card })
const comments = async (w: WS, card: number) => (await inWorkspace(w, () => tasks.getTask(card))).comments.length
const comment = (w: WS, card: number) => () => inWorkspace(w, () => tasks.commentTask(card, 'A note', agent))
const KEY = (i: number) => `key-${String(i).padStart(12, '0')}`

describe('a keyed write is applied once (HI-3195)', () => {
  it('a retry after a lost reply is answered "already applied", with one comment written', async () => {
    const { w } = await workspace()
    const card = await inWorkspace(w, async () => (await tasks.createTask({ title: 'Work', project: 'p' }, user)).number)
    const first = await inWorkspace(w, () => receipts.onceFor(w, req(KEY(1)), comment(w, card)))
    expect((first as { number?: number }).number).toBe(card)
    const again = await inWorkspace(w, () => receipts.onceFor(w, req(KEY(1)), comment(w, card)))
    expect(again).toEqual({ replayed: true, applied: true, produced: { card: '#1' } })
    expect(await comments(w, card)).toBe(1)
    // Another key is another write.
    await inWorkspace(w, () => receipts.onceFor(w, req(KEY(2)), comment(w, card)))
    expect(await comments(w, card)).toBe(2)
  })

  it("a retried create gets the card it made, and makes no other", async () => {
    const { w } = await workspace()
    const create = () => inWorkspace(w, () => tasks.createTask({ title: 'Made once', project: 'p' }, agent))
    const r = { run: 'run-1', key: KEY(3), fingerprint: receipts.fingerprintOf('POST', '/v1/tasks', [], { title: 'Made once' }), route: 'POST /v1/tasks' }
    const made = (await inWorkspace(w, () => receipts.onceFor(w, r, create))) as { number: number; key: string }
    const again = await inWorkspace(w, () => receipts.onceFor(w, r, create))
    // The card it made, by its key (or #n, a card with none, as this project's are): the same card, not another.
    const created = (again as unknown as { produced: { created: string } }).produced.created
    expect(again).toMatchObject({ replayed: true, applied: true })
    expect(created === made.key || created === `#${made.number}`).toBe(true)
    expect((await inWorkspace(w, () => tasks.listTasks())).filter((c) => c.title === 'Made once')).toHaveLength(1)
  })

  it('committed, then a crash before the reply: the retry is "already applied", after the board is reopened too', async () => {
    const { w, path } = await workspace()
    const card = await inWorkspace(w, async () => (await tasks.createTask({ title: 'Work', project: 'p' }, user)).number)
    const crashAfter = () => inWorkspace(w, async () => {
      await tasks.commentTask(card, 'A note', agent)
      throw new Error('Combwork stopped before replying')
    })
    await expect(inWorkspace(w, () => receipts.onceFor(w, req(KEY(4)), crashAfter))).rejects.toThrow(/stopped/)
    expect(await comments(w, card)).toBe(1)
    // The board closed and opened again (its marker durable).
    await disposeWorkspaceService(w)
    store.closeAllBoards()
    const again = await workspace(path)
    expect(await inWorkspace(again.w, () => receipts.onceFor(again.w, req(KEY(4)), comment(again.w, card)))).toMatchObject({ applied: true })
    expect(await comments(again.w, card)).toBe(1)
  })

  it('a first try refused (nothing committed) runs again; a key reused for another request is refused', async () => {
    const { w } = await workspace()
    const card = await inWorkspace(w, async () => (await tasks.createTask({ title: 'Work', project: 'p' }, user)).number)
    let calls = 0
    const refuseOnce = () => (++calls === 1 ? Promise.reject(new Error('refused')) : comment(w, card)())
    await expect(inWorkspace(w, () => receipts.onceFor(w, req(KEY(5)), refuseOnce))).rejects.toThrow(/refused/)
    await inWorkspace(w, () => receipts.onceFor(w, req(KEY(5)), refuseOnce))
    expect([calls, await comments(w, card)]).toEqual([2, 1])
    // The same key, another body: refused, nothing written.
    await expect(inWorkspace(w, () => receipts.onceFor(w, req(KEY(5), { text: 'Another note' }), comment(w, card)))).rejects.toBeInstanceOf(receipts.KeyReused)
    expect(await comments(w, card)).toBe(1)
  })

  it('simultaneous identical requests: one write, the second joins the first; another body meanwhile is refused', async () => {
    const { w } = await workspace()
    const card = await inWorkspace(w, async () => (await tasks.createTask({ title: 'Work', project: 'p' }, user)).number)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let ran = 0
    const slow = () => inWorkspace(w, async () => {
      ran++
      await gate
      return tasks.commentTask(card, 'A note', agent)
    })
    const a = inWorkspace(w, () => receipts.onceFor(w, req(KEY(6)), slow))
    const b = inWorkspace(w, () => receipts.onceFor(w, req(KEY(6)), slow))
    await expect(inWorkspace(w, () => receipts.onceFor(w, req(KEY(6), { text: 'Other' }), slow))).rejects.toBeInstanceOf(receipts.KeyReused)
    release()
    const [ra, rb] = await Promise.all([a, b])
    expect([ran, await comments(w, card)]).toEqual([1, 1])
    expect((rb as { number: number }).number).toBe((ra as { number: number }).number)
  })

  it("another connection's commit of the same key (another process, past the in-flight map) undoes this write: answered as applied", async () => {
    const { w, path } = await workspace()
    const card = await inWorkspace(w, async () => (await tasks.createTask({ title: 'Work', project: 'p' }, user)).number)
    const r = req(KEY(7))
    const plantedFirst = () => {
      // The other one commits first, on its own connection, before this write's transaction begins.
      const other = new DatabaseSync(join(path, '.combwork', 'combwork.db'))
      other.prepare('INSERT INTO request_receipts (run, key, fingerprint, route, produced, at) VALUES (?, ?, ?, ?, ?, ?)').run(r.run, r.key, r.fingerprint, r.route, '{"card":"#1"}', new Date().toISOString())
      other.close()
      return comment(w, card)()
    }
    expect(await inWorkspace(w, () => receipts.onceFor(w, r, plantedFirst))).toMatchObject({ applied: true })
    expect(await comments(w, card)).toBe(0)
  })

  it('a marker past 24 hours is gone: the key runs again; past the in-flight limit a new key waits (503), its retries still join', async () => {
    const { w, path } = await workspace()
    const card = await inWorkspace(w, async () => (await tasks.createTask({ title: 'Work', project: 'p' }, user)).number)
    const r = req(KEY(8))
    const other = new DatabaseSync(join(path, '.combwork', 'combwork.db'))
    other.prepare('INSERT INTO request_receipts (run, key, fingerprint, route, produced, at) VALUES (?, ?, ?, ?, ?, ?)').run(r.run, r.key, r.fingerprint, r.route, '{}', new Date(Date.now() - 25 * 3_600_000).toISOString())
    other.close()
    await inWorkspace(w, () => receipts.onceFor(w, r, comment(w, card)))
    expect(await comments(w, card)).toBe(1)
    // The in-flight limit: that many held open, the next new key refused for now; a retry of one held joins it.
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    const held = Array.from({ length: receipts.IN_FLIGHT_MAX }, (_, i) => receipts.onceFor(w, req(KEY(100 + i)), () => gate.then(() => 'done')))
    expect(receipts.inFlightForTests()).toBe(receipts.IN_FLIGHT_MAX)
    await expect(receipts.onceFor(w, req(KEY(9)), () => Promise.resolve('x'))).rejects.toBeInstanceOf(receipts.KeysBusy)
    const joined = receipts.onceFor(w, req(KEY(100)), () => Promise.resolve('second'))
    release()
    expect(await joined).toBe('done')
    await Promise.all(held)
    expect(receipts.inFlightForTests()).toBe(0)
  })
})
