// 0.9.3's agent fields survive every save (#1452, SPEC §16.10.3): `AgentDef` no longer types `worktree` and `needsSetup`,
// and 1.0 makes no new worktree, but an agent written again without them keeps what project.json stores, so a return to
// 0.9.3 finds its worktree. Repair's unlink, which means to drop one, writes the key. Real workspace service.
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { carryLegacyAgentFields, legacySetupPending, legacyWorktree } from '../src/shared/agentFolders'
import { tempDir } from './tempDir'

const TREE = { path: 'C:\\ws.worktrees\\alpha\\hb1', branch: 'hive/hb1', base: 'main' }

describe("0.9.3's agent fields, carried through (pure)", () => {
  it('an agent written without them keeps the stored ones; one that writes the key, as undefined, drops them', () => {
    const before = [{ id: 'a1', name: 'HB1', worktree: TREE, needsSetup: true }, { id: 'a2', name: 'HR1' }]
    const after = carryLegacyAgentFields(before, [{ id: 'a1', name: 'HB1 renamed', model: 'opus' }, { id: 'a2', name: 'HR1' }, { id: 'a3', name: 'New' }])
    expect(after).toEqual([{ id: 'a1', name: 'HB1 renamed', model: 'opus', worktree: TREE, needsSetup: true }, { id: 'a2', name: 'HR1' }, { id: 'a3', name: 'New' }])
    const unlinked = carryLegacyAgentFields(before, [{ id: 'a1', name: 'HB1', worktree: undefined, needsSetup: undefined }])
    expect(JSON.parse(JSON.stringify(unlinked))).toEqual([{ id: 'a1', name: 'HB1' }])
  })

  it('legacyWorktree reads only a well-formed one; legacySetupPending only with a worktree', () => {
    expect(legacyWorktree({ worktree: TREE })).toEqual(TREE)
    for (const bad of [{}, { worktree: null }, { worktree: 'x' }, { worktree: { path: '' } }, null, undefined]) expect(legacyWorktree(bad as object)).toBeNull()
    expect([legacySetupPending({ worktree: TREE, needsSetup: true }), legacySetupPending({ needsSetup: true }), legacySetupPending({ worktree: TREE })]).toEqual([true, false, false])
  })
})

describe("0.9.3's agent fields survive the workspace's saves", async () => {
  const base = tempDir('hive-legacyfields-')
  ;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
  const { createWorkspaceService, disposeWorkspaceService, inWorkspace, workspace } = await import('../src/main/workspace')

  it('renaming an agent, changing its model, reordering and a whole agents list sent without it: the stored worktree is byte-identical', async () => {
    const ws = join(base, 'ws')
    const alpha = join(ws, 'alpha')
    mkdirSync(join(alpha, '.hive'), { recursive: true })
    const file = join(alpha, '.hive', 'project.json')
    // As 0.9.3 wrote it: its agents' worktree and setup fields.
    writeFileSync(file, JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'HB1', provider: 'claude-code', worktree: TREE, needsSetup: true }, { id: 'a2', name: 'HR1', provider: 'codex' }] }))
    const stored = () => {
      const a1 = JSON.parse(readFileSync(file, 'utf8')).agents.find((a: { id: string }) => a.id === 'a1')
      return JSON.stringify({ worktree: a1.worktree, needsSetup: a1.needsSetup })
    }
    const was = stored()
    const w = createWorkspaceService()
    try {
      await w.open(ws)
      await w.updateAgent(alpha, 'a1', { name: 'HB1 renamed' })
      expect(stored()).toBe(was)
      await w.updateAgent(alpha, 'a1', { model: 'opus', effort: 'high' })
      expect(stored()).toBe(was)
      // Agent Settings' save: the window's copy, which says nothing of 0.9.3's fields, as a whole list.
      await w.updateProjectConfig(alpha, { agents: [{ id: 'a2', name: 'HR1', provider: 'codex' }, { id: 'a1', name: 'HB1 renamed', provider: 'claude-code', model: 'opus' }] })
      expect(stored()).toBe(was)
      expect(JSON.parse(readFileSync(file, 'utf8')).agents.map((a: { id: string }) => a.id)).toEqual(['a2', 'a1'])
      // A field 1.0 still writes: only the one named changes.
      await w.updateLegacyAgent(alpha, 'a1', { needsSetup: false })
      expect(JSON.parse(stored())).toEqual({ worktree: TREE, needsSetup: false })
    } finally {
      await disposeWorkspaceService(w)
    }
  })

  it("updateLegacyAgent goes to its project's workspace, whichever is current (#1452 round 1, HR2's case)", async () => {
    const first = createWorkspaceService()
    const second = createWorkspaceService()
    const a = join(base, 'first', 'alpha')
    const b = join(base, 'second', 'beta')
    for (const p of [a, b]) {
      mkdirSync(join(p, '.hive'), { recursive: true })
      writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'B1', ...(p === a ? { worktree: TREE, needsSetup: true } : {}) }] }))
    }
    try {
      await first.open(join(base, 'first'))
      await first.refreshesSettled()
      await second.open(join(base, 'second'))
      await second.refreshesSettled()
      // Asked while the second workspace is current: written in the first's project, recorded by the first.
      await inWorkspace(second, () => workspace.updateLegacyAgent(a, 'a1', { needsSetup: false }))
      expect(JSON.parse(readFileSync(join(a, '.hive', 'project.json'), 'utf8')).agents[0].needsSetup).toBe(false)
      expect([second.projectForRoot(TREE.path), first.projectForRoot(TREE.path)]).toEqual([null, a])
    } finally {
      await disposeWorkspaceService(first)
      await disposeWorkspaceService(second)
    }
  })
})
