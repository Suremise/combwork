// The same folder by another name (#455): a workspace, project or worktree reached through a junction (or an 8.3 short
// name, as on GitHub's runner) is the same place as its real path. Opening a workspace, telling whether one moved (and
// Repair's Locate), project removal's guards (and Delete) and resuming a session compare places
// (`samePlace`/`containsPlace`), not spellings. Each test uses a junction, which makes another name on any machine
// (tests/pathAliases.ts). Windows (windowShowing, switching a window's workspace) are in the e2e suite `windows`. The
// Agent API's X-Combwork-Workspace header finds a workspace named another way, and locked files and transcript paths read
// relative to a folder named the other way (#494).
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import type { AgentDef } from '../src/shared/types'
import { junction } from './pathAliases'
import { tempDir } from './tempDir'

const base = tempDir('hive-places-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { movePlan } = await import('../src/main/workspaceMove')
const { checkedWorktrees, removeProject } = await import('../src/main/projectRemoval')
const { sessions } = await import('../src/main/sessions')
const { providerService } = await import('../src/main/providerService')
const { config } = await import('../src/main/config')
const { containsPlace, placeRelative, samePlace } = await import('../src/main/fsutil')
const { findWorkspace } = await import('../src/main/servers')
const { shortPath } = await import('../src/main/providers/conversation')
const { codex } = await import('../src/main/providers/codex/adapter')

const git = (cwd: string, ...a: string[]): string => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8' })
const wsPath = join(base, 'ws')
const proj = join(wsPath, 'proj')
/** A worktree of proj that is also a project of the workspace (a folder in it). */
const other = join(wsPath, 'other')
/** An agent worktree of proj, in the workspace's worktree folder. */
const tree = join(base, 'ws.worktrees', 'proj', 'a')
const aliases = join(base, 'aliases')
/** Another name for `target`: a junction in the aliases folder. */
const alias = (target: string, name: string): string => junction(target, join(aliases, name))
let w: ReturnType<typeof createWorkspaceService>
/** An agent with a worktree at `path`. */
const agent = (id: string, path: string): AgentDef => ({ id, name: id.toUpperCase(), provider: 'claude-code', worktree: { path, branch: `cw/${id}`, base: 'main' } }) as AgentDef

beforeAll(async () => {
  mkdirSync(proj, { recursive: true })
  mkdirSync(aliases, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', proj])
  writeFileSync(join(proj, 'a.txt'), 'a\n')
  git(proj, 'add', '-A')
  git(proj, 'commit', '-qm', 'a')
  git(proj, 'worktree', 'add', '-q', '-b', 'other', other)
  git(proj, 'worktree', 'add', '-q', '-b', 'cw/a', tree)
  w = createWorkspaceService()
  await w.open(wsPath)
})
afterAll(async () => {
  await disposeWorkspaceService(w)
})

describe('places by real path (#455)', () => {
  it('containsPlace and samePlace see through a junction', () => {
    const ws = alias(wsPath, 'ws-places')
    expect(samePlace(ws, wsPath)).toBe(true)
    expect(containsPlace(ws, proj)).toBe(true)
    expect(containsPlace(wsPath, join(ws, 'proj'))).toBe(true)
    expect(containsPlace(proj, ws)).toBe(false)
  })

  it('refuses a workspace open in another window, or inside or around one, by another name', async () => {
    const second = createWorkspaceService()
    try {
      await expect(second.open(alias(wsPath, 'ws-open'))).rejects.toThrow(/already open in another window/)
      await expect(second.open(alias(proj, 'proj-open'))).rejects.toThrow(/is inside the workspace/)
      await expect(second.open(alias(base, 'base-open'))).rejects.toThrow(/open in another window, is inside/)
      expect(second.path).toBeNull()
    } finally {
      await disposeWorkspaceService(second)
    }
  })

  it("a workspace reopened by another name hasn't moved; one opened in another folder has", async () => {
    const was = w.config.lastPath
    try {
      const ws = alias(wsPath, 'ws-moved')
      w.config.lastPath = ws
      await w.mutateProjectConfig(proj, () => ({ lastPath: join(ws, 'proj') }))
      expect(await movePlan(w)).toBeNull()
      // The check still sees a real move.
      w.config.lastPath = join(base, 'elsewhere', 'ws')
      expect((await movePlan(w))?.from).toBe(join(base, 'elsewhere', 'ws'))
    } finally {
      w.config.lastPath = was
      await w.mutateProjectConfig(proj, () => ({ lastPath: proj }))
    }
  })

  it("Repair's Locate of an agent's own worktree by another name changes nothing; another worktree is located", async () => {
    try {
      // The project moved (its recorded folder is elsewhere), so Repair looks at its agents' worktrees.
      await w.mutateProjectConfig(proj, () => ({ lastPath: join(base, 'elsewhere', 'proj'), agents: [{ id: 'l', name: 'L', provider: 'claude-code', worktree: { path: tree, branch: 'cw/a', base: 'main' } } as AgentDef] }))
      const worktrees = async (picked: string): Promise<unknown[]> => (await movePlan(w, { locate: { [`${proj}#l`]: picked } }))!.hosts.find((h) => samePlace(h.path, proj))!.worktrees
      expect(await worktrees(alias(tree, 'tree-locate'))).toEqual([])
      expect(await worktrees(other)).toEqual([expect.objectContaining({ agentId: 'l', how: 'located', to: other })])
    } finally {
      await w.mutateProjectConfig(proj, () => ({ lastPath: proj, agents: [] }))
    }
  })

  it("project removal won't take a worktree that is another project, named through a junction", async () => {
    const { ok, refused } = await checkedWorktrees(w, proj, [agent('x', alias(other, 'other-rm')), agent('a', alias(tree, 'tree-rm'))])
    expect(refused).toEqual([expect.stringMatching(/^X's worktree .* \(it is another project of the workspace\)$/)])
    expect(ok.map((a) => a.id)).toEqual(['a'])
  })

  describe('project removal, in a workspace inside a repository it is a worktree of', () => {
    // outer is a repository whose main worktree holds the workspace ws2; its projects q and q2 are worktrees of outer, so
    // git lists outer (containing the workspace and q) and q itself among q's worktrees. A worktree of outer's outside
    // the workspace (spare) is one an agent may have.
    const outer = join(base, 'outer')
    const ws2 = join(outer, 'ws2')
    const q = join(ws2, 'q')
    const q2 = join(ws2, 'q2')
    const spare = join(base, 'outer-wt', 'spare')
    let w2: ReturnType<typeof createWorkspaceService>
    beforeAll(async () => {
      mkdirSync(outer, { recursive: true })
      execFileSync('git', ['init', '-q', '-b', 'main', outer])
      writeFileSync(join(outer, 'a.txt'), 'a\n')
      git(outer, 'add', '-A')
      git(outer, 'commit', '-qm', 'a')
      for (const [at, branch] of [[q, 'q'], [q2, 'q2'], [spare, 'spare']]) git(outer, 'worktree', 'add', '-q', '-b', branch, at)
      w2 = createWorkspaceService()
      await w2.open(ws2)
    })
    afterAll(async () => {
      await disposeWorkspaceService(w2)
    })

    it('refuses, by real path, a worktree that is the project, contains it or the workspace, or is another project', async () => {
      const { ok, refused } = await checkedWorktrees(w2, q, [agent('z', alias(q, 'q-guard')), agent('y', alias(outer, 'outer-guard')), agent('x', alias(q2, 'q2-guard')), agent('s', alias(spare, 'spare-guard'))])
      expect(refused).toEqual([
        expect.stringMatching(/^Z's worktree .* \(it contains the project or the workspace\)$/),
        expect.stringMatching(/^Y's worktree .* \(it contains the project or the workspace\)$/),
        expect.stringMatching(/^X's worktree .* \(it is another project of the workspace\)$/)
      ])
      expect(ok.map((a) => a.id)).toEqual(['s'])
    })

    it('Delete moves the project and its own worktree to the trash, never a folder those guards protect', async () => {
      const trashDir = join(base, 'trash')
      const was = process.env.CW_TEST_TRASH_DIR
      process.env.CW_TEST_TRASH_DIR = trashDir
      try {
        const agents = [agent('z', alias(q, 'q-delete')), agent('y', alias(outer, 'outer-delete')), agent('x', alias(q2, 'q2-delete')), agent('s', alias(spare, 'spare-delete'))]
        // Under project.json's lock, as Combwork writes it (#1238): written beside it, a write the opened workspace began
        // before (its project ids, 250 ms on) put back the config from before, and Delete found no agents.
        await w2.mutateProjectConfig(q, () => ({ agents }))
        const { warnings } = await inWorkspace(w2, () => removeProject(q, 'delete'))
        expect(warnings).toEqual([expect.stringMatching(/^Left alone: Z's worktree .*contains the project/), expect.stringMatching(/^Left alone: Y's worktree .*contains the project/), expect.stringMatching(/^Left alone: X's worktree .*another project/)])
        // What went: the project, and the one worktree that was safe (by the name the agent had for it).
        const gone = readFileSync(join(trashDir, 'trash.jsonl'), 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l).from as string)
        expect(gone.map((p) => p.toLowerCase())).toEqual([q, join(aliases, 'spare-delete')].map((p) => p.toLowerCase()))
        for (const kept of [outer, ws2, q2, join(outer, 'a.txt'), join(aliases, 'outer-delete'), join(aliases, 'q2-delete')]) expect(existsSync(kept)).toBe(true)
      } finally {
        if (was === undefined) delete process.env.CW_TEST_TRASH_DIR
        else process.env.CW_TEST_TRASH_DIR = was
      }
    })
  })

  it('resumes a session whose recorded folder is its worktree by another name', async () => {
    const info = providerService.info
    const enabled = config.settings.providers['claude-code'].enabled
    providerService.info = ((id: string) => ({ provider: id, found: true, path: join(base, 'no-cli.exe') })) as never
    config.settings.providers['claude-code'].enabled = true
    try {
      const named = alias(tree, 'tree-resume')
      await w.mutateProjectConfig(proj, () => ({ worktreeSetup: 'echo setup', agents: [{ id: 'r', name: 'R', provider: 'claude-code', needsSetup: true, worktree: { path: named, branch: 'cw/a', base: 'main' } } as AgentDef] }))
      const id = '6f1d3b52-1c1e-4a39-9d5e-2f7a1b0c4d11'
      await w.upsertSession(proj, { id, agent: 'claude-code', agentId: 'r', name: 'Earlier', cwd: tree, createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), archived: false })
      // Stopped just before its terminal would start (the worktree's setup), past every check of the folder.
      const past = new Error('past the checks')
      const start = inWorkspace(w, () => sessions.start(proj, { agentId: 'r', resumeId: id, name: 'Later', allowed: () => { throw past } }))
      await expect(start).rejects.toBe(past)
    } finally {
      providerService.info = info
      config.settings.providers['claude-code'].enabled = enabled
      await w.mutateProjectConfig(proj, () => ({ agents: [] }))
    }
  })

  it('the X-Combwork-Workspace header finds the open workspace named through a junction', () => {
    const ws = alias(wsPath, 'ws-header')
    expect(findWorkspace(ws)).toBe(w)
    expect(findWorkspace(join(ws, '.'))).toBe(w)
    expect(findWorkspace('ws')).toBe(w)
    expect(findWorkspace(join(base, 'elsewhere', 'ws'))).toBeNull()
  })

  it('a path inside a folder named the other way reads relative to it; one outside keeps its relative path', () => {
    const named = alias(proj, 'proj-relative')
    expect(placeRelative(named, join(proj, 'src', 'a.txt'))).toBe(join('src', 'a.txt'))
    expect(placeRelative(proj, join(named, 'a.txt'))).toBe('a.txt')
    expect(placeRelative(named, proj)).toBe('')
    expect(placeRelative(proj, join(wsPath, 'x.txt'))).toBe(join('..', 'x.txt'))
    // Transcripts show a tool's path relative to the project the same way.
    expect(shortPath(join(proj, 'src', 'a.txt'), named)).toBe('src/a.txt')
    expect(shortPath(join(wsPath, 'x.txt'), named)).toBe(join(wsPath, 'x.txt'))
  })

  it("a lock message and an agent's locked files read relative to its folder named the other way", async () => {
    const s = sessions as unknown as { live: Map<string, unknown>; runs: Map<string, string>; locks: Map<string, { liveId: string }> }
    const named = alias(proj, 'proj-locks')
    // Two running Codex agents (no process): the holder's folder is the junction, while the CLIs report the real one.
    const running = (agentId: string, cwd: string) => {
      const state: Record<string, unknown> = { provider: 'codex', runId: `run-${agentId}`, projectPath: proj, agentId, cwd, sessionId: `session-${agentId}`, status: 'working', startedAt: '', launchSignature: '', unseen: false }
      s.live.set(`${proj.toLowerCase()}#${agentId}`, { state, adapter: codex, transcriptMtime: '', defaultModel: false, modeTail: '', launchMode: null, configuredMode: null })
      s.runs.set(`run-${agentId}`, `${proj.toLowerCase()}#${agentId}`)
      return state
    }
    const edit = (st: Record<string, unknown>) =>
      inWorkspace(w, async () => sessions.preToolUse(st.runId as string, { hook_event_name: 'PreToolUse', session_id: st.sessionId, cwd: proj, tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: a.txt\n@@\n+x\n*** End Patch' } }))
    // File locks as Combwork's workflow default (HI-1766), for either platform the project is detected as.
    const was = config.settings.workflow
    config.settings.workflow = { none: { fileLocks: 'warn' }, git: { fileLocks: 'warn' } }
    try {
      const holder = running('lh', named)
      const editor = running('le', proj)
      expect(await edit(holder)).toBeNull()
      expect(holder.lockedFiles).toEqual(['a.txt'])
      const reply = JSON.stringify(await edit(editor))
      expect(reply).toContain('is also editing a.txt right now')
    } finally {
      config.settings.workflow = was
      for (const id of ['lh', 'le']) {
        s.live.delete(`${proj.toLowerCase()}#${id}`)
        s.runs.delete(`run-${id}`)
      }
      for (const [k, v] of s.locks) if (v.liveId.endsWith('#lh') || v.liveId.endsWith('#le')) s.locks.delete(k)
    }
  })
})
