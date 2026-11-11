// The window's offer of repository mutations (SPEC §16.3.6 port 5, R5.2; HI-2788's R3, HR3's round 1): an operation the
// platform doesn't list isn't offered and isn't dispatched. Clean Up offers each part by its own operation (local lines
// by deleting lines, remote ones by deleting remote lines); every merge entry point (the Git view's row, the pane's
// header and the agent's menu, the Merge dialogs' Merge and Merge anyway, the older agent and unused-worktree merges)
// is gated by its merge's operation; and no mutation is dispatched past `repoOp`. Main's own refusal is
// tests/repoOpsBoundary.test.ts.
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OPERATIONS, PLATFORMS } from '../src/shared/platform/descriptors'
import { REPO_OP_CHANNELS } from '../src/shared/repoOpChannels'
import { offered, offeredCleanup } from '../src/renderer/src/repoOffers'

// The dispatch module reaches the window's IPC (and its aliases), outside this project's types: loaded untyped.
const DISPATCH = '../src/renderer/src/repoOps'
const { repoOp } = (await import(/* @vite-ignore */ DISPATCH)) as { repoOp: (channel: string, ...args: unknown[]) => Promise<unknown> }

type Op = (typeof OPERATIONS)[number]
const git = PLATFORMS.git as { operations: readonly Op[] }
const without = (...ops: Op[]): void => {
  git.operations = OPERATIONS.filter((o) => !ops.includes(o))
}
afterEach(() => {
  git.operations = OPERATIONS
  vi.unstubAllGlobals()
})

describe('the window offers only what the platform lists (HI-2788)', () => {
  it('every channel while Git lists everything', () => {
    for (const c of Object.keys(REPO_OP_CHANNELS) as (keyof typeof REPO_OP_CHANNELS)[]) expect(offered(c), c).toBe(true)
  })

  it('Clean Up: each part by its own operation, the action while either is offered', () => {
    const offer = { local: ['a'], remote: ['origin/a'] }
    without('deleteRemoteLines')
    expect(offeredCleanup(offer)).toEqual({ local: ['a'], remote: [] })
    without('deleteLines')
    expect(offeredCleanup(offer)).toEqual({ local: [], remote: ['origin/a'] })
    expect(offered('git:deleteBranches') || offered('git:deleteRemoteBranches')).toBe(true)
    without('deleteLines', 'deleteRemoteLines')
    expect(offeredCleanup(offer)).toEqual({ local: [], remote: [] })
  })

  it('merging withdrawn: none of its three entries offered, and nothing dispatched', async () => {
    const invoke = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('window', { combwork: { invoke } })
    without('mergeLine')
    expect([offered('worktrees:mergeBranch'), offered('agents:merge'), offered('worktrees:mergeUnused')]).toEqual([false, false, false])
    await expect(repoOp('worktrees:mergeBranch', 'p', 'side', { target: 'main', squash: false, message: '' })).rejects.toThrow(/doesn’t offer that/)
    await expect(repoOp('agents:merge', 'p', 'a1', { squash: false, message: '', cleanup: false })).rejects.toThrow(/doesn’t offer that/)
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('the renderer’s merge entries and mutation calls (HI-2788)', () => {
  const root = join(__dirname, '..', 'src', 'renderer', 'src')
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.tsx?$/.test(e)) files.push(p)
    }
  }
  walk(root)
  const lines = files.flatMap((f) => readFileSync(f, 'utf8').split(/\r?\n/).map((text, i) => ({ at: `${f.slice(root.length + 1)}:${i + 1}`, text })))

  it('each control that opens a Merge dialog is gated by its merge’s operation', () => {
    const opens = lines.filter((l) => /set\(\{ (branchMergeFor|mergeFor): \{/.test(l.text) || /\? \{ branchMergeFor:/.test(l.text))
    expect(opens.length).toBeGreaterThan(3)
    expect(opens.filter((l) => !l.text.includes('offered(')).map((l) => l.at)).toEqual([])
  })

  it('no mutation channel is called past repoOp', () => {
    const channels = Object.keys(REPO_OP_CHANNELS).map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const direct = new RegExp(`\\bcall(?:Shared)?\\('(?:${channels.join('|')})'`)
    expect(lines.filter((l) => direct.test(l.text)).map((l) => l.at)).toEqual([])
  })
})
