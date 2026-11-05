// A launch's side of the workflow, as its metrics count it (HI-2049): its part in the running lanes as it launches,
// which wins over its own role, taken once; and a tool list its hive server reports later counts on that launch's side,
// never on the side of the launch that took its place.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { launchWorkflow } from '../src/shared/workflow/roles'

const base = tempDir('hive-launchworkflow-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
// A test copy on its CLI test home (tests/cliHomes.ts), as an e2e run is: its agents start with no connection.
process.env.CW_USER_DATA = join(base, 'profile')
process.env.CW_TEST_CLI_HOME_CONNECTION = '1'

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { providerService } = await import('../src/main/providerService')
const { config } = await import('../src/main/config')

const wsPath = join(base, 'ws')
const p = join(wsPath, 'ambrosia')
const s = sessions as unknown as { live: Map<string, { workflow?: string; state: { runId: string } }>; runs: Map<string, string> }
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
const liveOf = (agentId: string) => s.live.get(`${p.toLowerCase()}#${agentId}`)

/**
 * Launches the agent up to just before its terminal would start (a failed launch is gone at once: `during` runs while it
 * is live), and gives its side and run as the launch took them.
 */
async function launchSide(agentId: string, during?: (runId: string) => void): Promise<{ workflow: string | undefined; runId: string }> {
  const past = new Error('past the launch')
  let seen: { workflow: string | undefined; runId: string } | null = null
  const started = run(() =>
    sessions.start(p, {
      agentId,
      allowed: () => {
        const l = liveOf(agentId)!
        seen = { workflow: l.workflow, runId: l.state.runId }
        during?.(l.state.runId)
        throw past
      }
    })
  )
  await expect(started).rejects.toBe(past)
  return seen!
}

describe('a launch’s side of the workflow', () => {
  it('is its lane part, either for parts in two lanes, else its own role; generalists and the Assistant none', () => {
    expect(launchWorkflow('either', ['reviewer'])).toBe('reviewer')
    expect(launchWorkflow('builder', ['reviewer'])).toBe('reviewer')
    expect(launchWorkflow('reviewer', ['builder', 'reviewer'])).toBe('either')
    expect(launchWorkflow('either', [])).toBe('either')
    expect(launchWorkflow('builder', [])).toBe('builder')
    expect(launchWorkflow('generalist', [])).toBe('none')
    expect(launchWorkflow(null, [])).toBe('none')
  })
})

describe('the side a launch is counted on', () => {
  const info = providerService.info
  const enabled = config.settings.providers['claude-code'].enabled
  const laneParts = sessions.laneParts
  beforeAll(async () => {
    mkdirSync(join(wsPath, '.combwork'), { recursive: true })
    mkdirSync(join(p, '.combwork'), { recursive: true })
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'amb1', name: 'AMB1', provider: 'claude-code', workflowRole: 'either' }, { id: 'amb2', name: 'AMB2', provider: 'claude-code', workflowRole: 'generalist' }] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    providerService.info = ((pid: string) => ({ provider: pid, found: true, path: join(base, 'no-cli.exe') })) as never
    config.settings.providers['claude-code'].enabled = true
  })
  afterEach(() => {
    vi.restoreAllMocks()
    sessions.laneParts = laneParts
    s.live.clear()
    s.runs.clear()
  })
  afterAll(async () => {
    providerService.info = info
    config.settings.providers['claude-code'].enabled = enabled
    await disposeWorkspaceService(w)
  })

  it('an either agent launched as a lane’s reviewer is a reviewer launch; reviewer of one lane and builder of another, either', async () => {
    sessions.laneParts = async () => ['reviewer']
    expect((await launchSide('amb1')).workflow).toBe('reviewer')
    sessions.laneParts = async () => ['builder', 'reviewer']
    expect((await launchSide('amb1')).workflow).toBe('either')
  })

  it('in no lane: its own role (either), a generalist none; lanes that can’t be read: its own role', async () => {
    expect((await launchSide('amb1')).workflow).toBe('either')
    expect((await launchSide('amb2')).workflow).toBe('none')
    sessions.laneParts = async () => {
      throw new Error('the board is busy')
    }
    expect((await launchSide('amb1')).workflow).toBe('either')
  })

  it('is taken once, as it launched: its lanes changing meanwhile leave it', async () => {
    sessions.laneParts = async () => ['reviewer']
    let later: string | null = null
    await launchSide('amb1', (runId) => {
      sessions.laneParts = async () => ['builder']
      later = sessions.launchSide(p, 'amb1', runId)
    })
    expect(later).toBe('reviewer')
  })

  it('a report from an earlier launch, or with no launch, never takes the current launch’s side', async () => {
    sessions.laneParts = async () => ['reviewer']
    const first = await launchSide('amb1')
    // Gone with its launch: unknown.
    expect(sessions.launchSide(p, 'amb1', first.runId)).toBe('unknown')
    sessions.laneParts = async () => ['builder']
    let sides: Record<string, string> = {}
    const second = await launchSide('amb1', (runId) => {
      // The first launch's hive server reports late (its CLI restarted meanwhile): unknown, not the builder launch's.
      sides = { first: sessions.launchSide(p, 'amb1', first.runId), second: sessions.launchSide(p, 'amb1', runId), none: sessions.launchSide(p, 'amb1', null), other: sessions.launchSide(p, 'nobody', runId) }
    })
    expect(second.runId).not.toBe(first.runId)
    expect(sides).toEqual({ first: 'unknown', second: 'builder', none: 'unknown', other: 'unknown' })
  })
})
