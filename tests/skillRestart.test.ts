// HI-2268: a workspace skill edited, added or removed under a running agent asks it for a restart (the window's "restart
// to apply" banner, the sidebar's dot and the Agent API's status, all `restartNeeded`) with nothing else to set it off:
// the skills folder's watch schedules the refresh that works it out, as a change made in the window does. A skill left as
// it was asks for nothing, and a restart (its launch settings taken again) clears it.
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-skill-restart-')
process.env.CLAUDE_CONFIG_DIR = join(base, 'claude-home')
process.env.CODEX_HOME = join(base, 'codex-home')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace, workspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')

const wsPath = join(base, 'ws')
const project = join(wsPath, 'alpha')
const skills = join(wsPath, '.combwork', 'skills')
const agent = { id: 'a1', name: 'Agent 1', provider: 'claude-code' as const }
const s = sessions as unknown as { live: Map<string, { state: Record<string, unknown> }> }
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)

/** The agent running with the launch settings it has now: as started, or restarted, just now. */
async function launched(): Promise<void> {
  const signature = await run(async () => sessions.signature(await sessions.effective(project, agent)))
  s.live.set(`${project.toLowerCase()}#${agent.id}`, { state: { provider: 'claude-code', runId: 'run-a1', projectPath: project, agentId: agent.id, sessionId: null, status: 'ready', launchSignature: signature } })
}

/** Whether it needs a restart, as a refresh works it out. */
async function needsRestart(): Promise<boolean> {
  const info = await run(async () => sessions.liveInfo(project, await workspace.projectConfig(project)))
  return info.agents.find((a) => a.id === agent.id)!.restartNeeded
}

/** The refreshes the workspace runs from now, by itself (its watches, its writes' asks): none run by the test. */
function refreshesRun(): { count: () => number; restore: () => void } {
  const real = w.refresh.bind(w)
  let n = 0
  const spy = vi.spyOn(w, 'refresh').mockImplementation(async () => {
    n++
    return real()
  })
  return { count: () => n, restore: () => spy.mockRestore() }
}

/** After a change on disk: a refresh the watch scheduled has run, and the agent needs a restart. */
async function askedForRestart(): Promise<void> {
  const r = refreshesRun()
  try {
    await vi.waitFor(() => expect(r.count()).toBeGreaterThan(0), { timeout: 15_000, interval: 50 })
    await w.refreshesSettled()
  } finally {
    r.restore()
  }
  expect(await needsRestart()).toBe(true)
}

/** One of Combwork's skills copied into the workspace's. */
const addSkill = (name: string): void => cpSync(join(resolve('resources/skills'), name), join(skills, name), { recursive: true })

/** A skill a test added, removed, with the refresh its removal's watch scheduled run (none if it wasn't there). */
async function removedSkill(name: string): Promise<void> {
  if (!existsSync(join(skills, name))) return
  const r = refreshesRun()
  try {
    rmSync(join(skills, name), { recursive: true })
    await vi.waitFor(() => expect(r.count()).toBeGreaterThan(0), { timeout: 15_000, interval: 50 })
    await w.refreshesSettled()
  } finally {
    r.restore()
  }
}

beforeAll(async () => {
  for (const name of ['handover', 'work-on-card']) cpSync(join(resolve('resources/skills'), name), join(skills, name), { recursive: true })
  mkdirSync(join(project, '.combwork'), { recursive: true })
  writeFileSync(join(project, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [agent] }))
  w = createWorkspaceService()
  w.setLiveProvider((p, cfg, scope) => sessions.liveInfo(p, cfg, scope))
  await w.open(wsPath)
})
afterAll(async () => {
  s.live.clear()
  await disposeWorkspaceService(w)
})
// Each test from a quiet workspace, the agent just (re)started: the refreshes of the last test's writes have run.
beforeEach(async () => {
  await w.refreshesSettled()
  await launched()
})

describe('a changed workspace skill asks running agents for a restart (HI-2268)', () => {
  it('an unchanged skill asks for nothing', async () => {
    expect(await needsRestart()).toBe(false)
    // Something else in .combwork changing (a shared note) isn't a skill change.
    mkdirSync(join(wsPath, '.combwork', 'shared'), { recursive: true })
    writeFileSync(join(wsPath, '.combwork', 'shared', 'note.md'), '# A note\n')
    await w.refreshesSettled()
    expect(await needsRestart()).toBe(false)
  })

  it("a skill's content edited (as an editor or an agent saves it): asked, with no refresh asked for; a restart clears it", async () => {
    writeFileSync(join(skills, 'handover', 'SKILL.md'), `${'x'.repeat(10)}\n`, { flag: 'a' })
    await askedForRestart()
    await launched()
    expect(await needsRestart()).toBe(false)
  })

  it('a file added to a skill (a reference): asked', async () => {
    mkdirSync(join(skills, 'work-on-card', 'references'), { recursive: true })
    writeFileSync(join(skills, 'work-on-card', 'references', 'extra.md'), 'More.\n')
    await askedForRestart()
  })

  it('a skill added: asked', async () => {
    try {
      addSkill('pick-up')
      await askedForRestart()
    } finally {
      // Its own state gone again, its removal's refresh run, so the next test starts from the skills it started with.
      await removedSkill('pick-up')
    }
  })

  it('a skill removed: asked', async () => {
    // Its own skill, there when the agent (re)starts: the watch's refresh of its adding has run first.
    addSkill('split-work')
    await askedForRestart()
    await launched()
    expect(await needsRestart()).toBe(false)
    rmSync(join(skills, 'split-work'), { recursive: true })
    await askedForRestart()
  })
})
