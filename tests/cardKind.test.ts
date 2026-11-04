// A card's kind (#1277, SPEC §16.7.3, OP-6/OP-7), on the real board (a temp hive.db): code by default; the user's or
// the Assistant's no-code from the start; a project agent's only proposed (the card stays code, a KindProposed fact)
// until the user or the Assistant confirms it (KindDecided) or keeps it code; changing it later is an exception to the
// rules: the user's asked first, the Assistant's with a reason, one Override (card.kind); agents never.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-cardkind-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { FactStore } = await import('../src/main/workflow/factStore')
const { cardKind, workBadges } = await import('../src/main/workflow/cardWork')

type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const user = { kind: 'user' } as const
const assistant = { kind: 'assistant' } as const
const agent = { kind: 'agent', name: 'Builder (p)', self: { project: 'p', agentId: 'a1' }, scope: 'p' } as const
let n = 0

async function workspace(): Promise<WS> {
  const ws = join(base, `ws-${++n}`)
  mkdirSync(join(ws, 'p', '.combwork'), { recursive: true })
  writeFileSync(join(ws, 'p', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Builder' }] }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return w
}
const kindOf = (w: WS, card: number) => FactStore.forBoard(w, { project: 'p', key: '' }).card(card).kind
const kinds = (w: WS, card: number): string[] => FactStore.forBoard(w, { project: 'p', key: '' }).facts(card).map((f) => f.kind)
const create = (w: WS, actor: Parameters<typeof tasks.createTask>[1], kind?: 'code' | 'no-code') => inWorkspace(w, () => tasks.createTask({ title: 'Work', project: 'p', ...(kind ? { kind } : {}) }, actor))

describe("a card's kind (#1277)", () => {
  it('code by default; no-code from the user or the Assistant at once, said in its history', async () => {
    const w = await workspace()
    const plain = await create(w, user)
    expect(kindOf(w, plain.number)).toBe('code')
    for (const actor of [user, assistant] as const) {
      const c = await create(w, actor, 'no-code')
      expect(kindOf(w, c.number)).toBe('no-code')
      expect(kinds(w, c.number)).not.toContain('KindProposed')
      expect(c.history.map((h) => h.what)).toContain('Made as no code')
      expect(cardKind(w, c.number)).toEqual({ kind: 'no-code', kindProposed: null })
    }
    await expect(create(w, user, 'docs' as never)).rejects.toThrow(/code or no-code, not docs/)
  })

  it("a project agent's no-code is proposed: the card stays code until the user confirms it, or keeps it code", async () => {
    const w = await workspace()
    const c = await create(w, agent, 'no-code')
    expect(kindOf(w, c.number)).toBe('code')
    expect(kinds(w, c.number)).toContain('KindProposed')
    expect(c.history.map((h) => h.what)).toContain('Proposed as no code')
    expect(cardKind(w, c.number)).toEqual({ kind: 'code', kindProposed: 'no-code' })
    // Agents never answer it.
    await expect(inWorkspace(w, () => tasks.confirmKind(c.number, true, agent))).rejects.toThrow(/Agents can't change a card's kind/)
    const confirmed = await inWorkspace(w, () => tasks.confirmKind(c.number, true, user))
    expect(kindOf(w, c.number)).toBe('no-code')
    expect(confirmed.history.at(-1)?.what).toBe('Confirmed as no code')
    expect(cardKind(w, c.number)).toEqual({ kind: 'no-code', kindProposed: null })
    // Answered: nothing proposes one now.
    await expect(inWorkspace(w, () => tasks.confirmKind(c.number, true, user))).rejects.toThrow(/Nothing proposes a kind/)
    // Another, kept as code by the Assistant.
    const d = await create(w, agent, 'no-code')
    await inWorkspace(w, () => tasks.confirmKind(d.number, false, assistant))
    expect(kindOf(w, d.number)).toBe('code')
    expect(cardKind(w, d.number)).toEqual({ kind: 'code', kindProposed: null })
    expect(kinds(w, d.number).filter((k) => k === 'KindDecided')).toHaveLength(1)
  })

  it("changed later: the user's asked first, nothing written; confirmed, one Override (card.kind) with the reason", async () => {
    const w = await workspace()
    const c = await create(w, user)
    const before = kinds(w, c.number)
    expect(await inWorkspace(w, () => tasks.setKind(c.number, 'no-code', user))).toEqual({ ask: true })
    expect(kinds(w, c.number)).toEqual(before)
    expect(kindOf(w, c.number)).toBe('code')
    const changed = await inWorkspace(w, () => tasks.setKind(c.number, 'no-code', user, { confirm: true, reason: 'It is a write-up' }))
    expect(kindOf(w, c.number)).toBe('no-code')
    expect('history' in changed && changed.history.at(-1)?.what).toBe('Kind changed to no code')
    const o = FactStore.forBoard(w, { project: 'p', key: '' }).facts(c.number).filter((f) => f.kind === 'Override')
    expect(o).toMatchObject([{ actor: 'user', data: { rules: ['card.kind'], move: 'kind code→no-code', by: 'user', reason: 'It is a write-up' } }])
    // The same kind again: no change, no Override.
    await inWorkspace(w, () => tasks.setKind(c.number, 'no-code', user, { confirm: true }))
    expect(kinds(w, c.number).filter((k) => k === 'Override')).toHaveLength(1)
  })

  it('the Assistant changes it only with a reason; an agent never; an open proposal is answered by the change', async () => {
    const w = await workspace()
    const c = await create(w, agent, 'no-code')
    await expect(inWorkspace(w, () => tasks.setKind(c.number, 'no-code', assistant))).rejects.toThrow(/override.reason/)
    await expect(inWorkspace(w, () => tasks.setKind(c.number, 'no-code', agent, { reason: 'x' }))).rejects.toThrow(/Agents can't change a card's kind/)
    expect(kindOf(w, c.number)).toBe('code')
    await inWorkspace(w, () => tasks.setKind(c.number, 'no-code', assistant, { reason: 'The user says it is a decision' }))
    expect(kindOf(w, c.number)).toBe('no-code')
    expect(FactStore.forBoard(w, { project: 'p', key: '' }).facts(c.number).find((f) => f.kind === 'Override')).toMatchObject({ actor: 'assistant', data: { by: 'assistant', reason: 'The user says it is a decision' } })
    expect(cardKind(w, c.number)).toEqual({ kind: 'no-code', kindProposed: null })
  })

  it("a revoked caller (the Assistant's Control or session, its `commit` check) changes nothing: neither a kind nor a proposal's answer (HR3's round 1)", async () => {
    const w = await workspace()
    const c = await create(w, agent, 'no-code')
    const before = kinds(w, c.number)
    const history = (await inWorkspace(w, () => tasks.getTask(c.number, w))).history.length
    const revoked = () => {
      throw new Error('Control was turned down meanwhile')
    }
    await expect(inWorkspace(w, () => tasks.setKind(c.number, 'no-code', assistant, { reason: 'x', commit: revoked }))).rejects.toThrow(/turned down/)
    await expect(inWorkspace(w, () => tasks.confirmKind(c.number, true, assistant, { commit: revoked }))).rejects.toThrow(/turned down/)
    expect(kindOf(w, c.number)).toBe('code')
    expect(kinds(w, c.number)).toEqual(before)
    expect((await inWorkspace(w, () => tasks.getTask(c.number, w))).history).toHaveLength(history)
    expect(cardKind(w, c.number)).toEqual({ kind: 'code', kindProposed: 'no-code' })
  })

  it("one change of a kind with other fields (a PATCH) is one board change: refused part way, none of it is saved (HR3's round 1)", async () => {
    const w = await workspace()
    const c = await create(w, agent, 'no-code')
    const before = kinds(w, c.number)
    await expect(
      inWorkspace(w, () =>
        tasks.cardBatch(w, async () => {
          await tasks.confirmKind(c.number, true, assistant)
          await tasks.updateTask(c.number, { agent: 'nobody-here' }, assistant)
        })
      )
    ).rejects.toThrow()
    expect(kindOf(w, c.number)).toBe('code')
    expect(kinds(w, c.number)).toEqual(before)
    expect(cardKind(w, c.number)).toEqual({ kind: 'code', kindProposed: 'no-code' })
    expect(() => tasks.kindOf('docs')).toThrow(/code or no-code, not docs/)
  })

  it("after a start the card shows its kind now: changed both ways, a proposal confirmed; one made in Doing starts as its kind (HR3's round 1)", async () => {
    const w = await workspace()
    const badge = (card: number) => workBadges(w).find((b) => b.card === card)
    const c = await create(w, user)
    await inWorkspace(w, () => tasks.updateTask(c.number, { column: 'doing', agent: 'a1' }, user))
    expect(kinds(w, c.number)).toContain('Started')
    await inWorkspace(w, () => tasks.setKind(c.number, 'no-code', user, { confirm: true, reason: 'A write-up' }))
    expect(badge(c.number)?.kind).toBe('no-code')
    await inWorkspace(w, () => tasks.setKind(c.number, 'code', user, { confirm: true, reason: 'A script after all' }))
    expect(badge(c.number)?.kind).toBe('code')
    // A proposal answered after the card started.
    const p = await create(w, agent, 'no-code')
    await inWorkspace(w, () => tasks.updateTask(p.number, { column: 'doing', agent: 'a1' }, user))
    await inWorkspace(w, () => tasks.confirmKind(p.number, true, user))
    expect(badge(p.number)).toMatchObject({ kind: 'no-code', kindProposed: null })
    // Made in Doing as no code: its start says so.
    const d = await inWorkspace(w, () => tasks.createTask({ title: 'Decide', project: 'p', column: 'doing', agent: 'a1', kind: 'no-code' }, user))
    const started = FactStore.forBoard(w, { project: 'p', key: '' }).facts(d.number).find((f) => f.kind === 'Started')
    expect(started?.data).toMatchObject({ cardKind: 'no-code' })
    expect(badge(d.number)?.kind).toBe('no-code')
  })
})
