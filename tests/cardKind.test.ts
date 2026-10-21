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
const { cardKind } = await import('../src/main/workflow/cardWork')

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
  mkdirSync(join(ws, 'p', '.hive'), { recursive: true })
  writeFileSync(join(ws, 'p', '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Builder' }] }))
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
})
