import { describe, expect, it } from 'vitest'
import { join } from 'path'
import { API_EVENTS, COMMAND_TITLE, apiEventFor, publicRun, publicSessionState } from '../src/main/apiEvents'
import type { HiveEvent, LiveSessionState, MergeSlotInfo, ProgressRun } from '../src/shared/types'

// What the Agent API's event stream sends of Hive's events, and to whom (#620): every listed event to the workspace
// token and viewers, a project agent its own project's, and nothing private (no notice body, no prompt the Assistant
// quoted). The paths are only compared, never touched.
const ws = join('C:\\', 'work')
const alpha = join(ws, 'alpha')
const beta = join(ws, 'beta')
const other = join('C:\\', 'elsewhere')
const agent = { workspace: ws, projectPath: alpha }

const run = (projectPath: string | null, id: string): ProgressRun => ({ id, workspacePath: ws, projectPath, agentId: projectPath ? 'a1' : null, agentName: projectPath ? 'B1' : 'Script', provider: null, source: projectPath ? 'agent' : 'api', title: 'unit tests', command: null, total: null, step: null, stepName: null, estimateMs: null, startedAt: 1, updatedAt: 1, finishedAt: null, state: 'running', staleReason: null, stopReason: null, waiting: null, waitingSince: null, heldEstimateMs: null, pid: null, summary: null, dismissed: false, seenAt: null, expectedMs: null, exitCode: null, logPath: null })
const slot = (project: string): MergeSlotInfo => ({ project, branch: 'main', holder: { id: 'h', kind: 'agent', agentId: 'a1', name: 'B1', cards: [12], since: 1, until: 2, taken: true }, waiting: [] })
const status = (projectPath: string) => ({ type: 'session-status', state: { projectPath, agentId: 'a1' } as LiveSessionState }) as HiveEvent

describe('apiEventFor', () => {
  it('sends the events Apiary needs, and none of the windows\' own', () => {
    expect(API_EVENTS).toEqual(expect.arrayContaining(['progress-changed', 'merge-slots-changed', 'notice', 'notice-resolved', 'assistant-activity', 'agent-added']))
    for (const e of [{ type: 'toast', toast: { id: 't', level: 'info', title: 'x', timestamp: '' } }, { type: 'settings-changed', settings: {} }, { type: 'chime', projectPath: alpha }, { type: 'files-changed', projectPath: alpha, dirs: [] }, { type: 'assistant-questions', projectPath: alpha, questions: [] }] as HiveEvent[]) {
      expect(apiEventFor(e, null), e.type).toBeNull()
    }
  })

  it('gives the workspace token and viewers every project, an agent its own', () => {
    expect(apiEventFor(status(beta), null)).not.toBeNull()
    expect(apiEventFor(status(beta), agent)).toBeNull()
    expect(apiEventFor(status(alpha), agent)).not.toBeNull()
    for (const e of [{ type: 'agent-added', projectPath: beta, agentId: 'a2' }, { type: 'notice-resolved', projectPath: beta, agentId: 'a2' }, { type: 'session-exit', projectPath: beta, agentId: 'a2', sessionId: 's', exitCode: 0 }] as HiveEvent[]) {
      expect(apiEventFor(e, null), e.type).toEqual(e)
      expect(apiEventFor(e, agent), e.type).toBeNull()
      expect(apiEventFor({ ...e, projectPath: alpha } as HiveEvent, agent), e.type).not.toBeNull()
    }
  })

  it('sends progress runs and merge slots, an agent only its project\'s and its workspace\'s', () => {
    const runs = [run(alpha, 'r1'), run(beta, 'r2'), run(null, 'r3')]
    expect(apiEventFor({ type: 'progress-changed', workspacePath: ws, runs }, null)).toEqual({ type: 'progress-changed', workspacePath: ws, runs: runs.map(publicRun) })
    expect((apiEventFor({ type: 'progress-changed', workspacePath: ws, runs }, agent)!.runs as ProgressRun[]).map((r) => r.id)).toEqual(['r1'])
    expect(apiEventFor({ type: 'progress-changed', workspacePath: other, runs: [] }, agent)).toBeNull()
    const slots = [slot(alpha), slot(beta)]
    expect(apiEventFor({ type: 'merge-slots-changed', workspacePath: ws, slots }, null)).toEqual({ type: 'merge-slots-changed', workspacePath: ws, slots: slots.map((s) => ({ project: s.project, branch: 'main', holder: { kind: 'agent', agentId: 'a1', name: 'B1', cards: [12], since: 1, until: 2, taken: true }, waiting: [] })) })
    expect((apiEventFor({ type: 'merge-slots-changed', workspacePath: ws, slots }, agent)!.slots as MergeSlotInfo[]).map((s) => s.project)).toEqual([alpha])
    expect(apiEventFor({ type: 'merge-slots-changed', workspacePath: other, slots }, agent)).toBeNull()
  })

  it("leaves out a notice's body (an agent's last reply, its question)", () => {
    const notice = { id: 'n1', kind: 'finished' as const, title: 'B1 finished', body: 'Here is the secret reply', projectPath: alpha, agentId: 'a1' }
    const sent = apiEventFor({ type: 'notice', notice }, null)
    expect(sent).toEqual({ type: 'notice', notice: { id: 'n1', kind: 'finished', title: 'B1 finished', projectPath: alpha, agentId: 'a1' } })
    expect(JSON.stringify(sent)).not.toContain('secret')
    expect(apiEventFor({ type: 'notice', notice }, { workspace: ws, projectPath: beta })).toBeNull()
    // An app-wide notice (plan usage, Hive closing) is the workspace's, not an agent's.
    expect(apiEventFor({ type: 'notice', notice: { ...notice, projectPath: null } }, null)).not.toBeNull()
    expect(apiEventFor({ type: 'notice', notice: { ...notice, projectPath: null } }, agent)).toBeNull()
  })

  it("sends the Assistant's actions without what they quote, and not to agents", () => {
    const home = join(ws, '.combwork', 'assistant')
    const action = { id: 'x', at: '2026-10-11T00:00:00Z', text: 'Gave B1 in alpha a task: the secret prompt', brief: 'Gave B1 in alpha a task', ok: true }
    const sent = apiEventFor({ type: 'assistant-activity', projectPath: home, action }, null)
    expect(sent).toEqual({ type: 'assistant-activity', workspacePath: ws, action: { id: 'x', at: action.at, text: 'Gave B1 in alpha a task', ok: true } })
    expect(JSON.stringify(sent)).not.toContain('secret')
    // A line that quotes nothing is sent as it is, with why it was refused in Hive's own words (#763).
    expect((apiEventFor({ type: 'assistant-activity', projectPath: home, action: { id: 'y', at: '', text: 'Stop B1 in alpha', ok: false, error: 'not allowed', reason: 'Not allowed' } }, null) as { action: unknown }).action).toEqual({ id: 'y', at: '', text: 'Stop B1 in alpha', ok: false, error: 'Not allowed' })
    expect(apiEventFor({ type: 'assistant-activity', projectPath: home, action }, agent)).toBeNull()
  })

  it("sends the Assistant's action's kind and targets (#763), and nothing else it holds", () => {
    const home = join(ws, '.combwork', 'assistant')
    const agentB1 = { id: 'a1', name: 'B1' }
    const action = {
      id: 'x', at: 't', text: 'Left B1 in alpha a message (m3) for #12 round 1: the secret message', brief: 'Left B1 in alpha a message (m3) for #12 round 1', ok: true,
      kind: 'message-agent' as const, project: 'alpha', agent: { ...agentB1, token: 'secret-token' } as never, card: 12,
      setting: { id: 's', path: 'p', old: 'secret-old', new: 'secret-new', oldText: 'secret-old', newText: 'secret-new' }
    }
    const sent = apiEventFor({ type: 'assistant-activity', projectPath: home, action }, null) as { action: Record<string, unknown> }
    expect(sent.action).toEqual({ id: 'x', at: 't', text: action.brief, ok: true, kind: 'message-agent', project: 'alpha', agent: agentB1, card: 12 })
    expect(JSON.stringify(sent)).not.toContain('secret')
    // A refusal: the kind it tried, with its targets, and its public reason, never the error's text (it can quote what
    // was sent: here a setting's value), nor "Failed" replaced by it when no reason was given.
    const refused = { id: 'y', at: 't', text: 'Change B1’s settings in alpha', ok: false, error: '"secret-value/x" isn’t an MCP server’s name.', reason: 'The request was invalid', kind: 'update-agent' as const, project: 'alpha', agent: agentB1 }
    const sentRefused = apiEventFor({ type: 'assistant-activity', projectPath: home, action: refused }, null) as { action: unknown }
    expect(sentRefused.action).toEqual({ id: 'y', at: 't', text: refused.text, ok: false, error: 'The request was invalid', kind: 'update-agent', project: 'alpha', agent: agentB1 })
    expect(JSON.stringify(sentRefused)).not.toContain('secret')
    const noReason = apiEventFor({ type: 'assistant-activity', projectPath: home, action: { ...refused, reason: undefined } }, null) as { action: { error: string } }
    expect(noReason.action.error).toBe('Failed')
    // Lanes, batches and settings: their ids and numbers, never a setting's value.
    const lane = { id: 'z', at: 't', text: 'Lane l1 started', ok: true, kind: 'lane-start' as const, lane: 'lane-1', cards: [3, 4], agent: agentB1, project: 'alpha' }
    expect((apiEventFor({ type: 'assistant-activity', projectPath: home, action: lane }, null) as { action: unknown }).action).toEqual(lane)
    const setting = { id: 's', at: 't', text: 'Changed Settings → Sessions → Confirm before stopping: secret → value', brief: 'Changed Settings → Sessions → Confirm before stopping', ok: true, kind: 'setting' as const, settingId: 'sessions.confirmStop' }
    expect(JSON.stringify(apiEventFor({ type: 'assistant-activity', projectPath: home, action: setting }, null))).not.toContain('secret')
  })

  // Every free-text field holds SECRET: none of it may reach the stream, for any token (#620 review, round 1).
  it("gives an agent's live state without anything it was told or said", () => {
    const state = {
      provider: 'codex', runId: 'r', projectPath: alpha, agentId: 'a1', agentName: 'B1', cwd: alpha, sessionId: 's', status: 'waiting', statusSince: 't', startedAt: 't', unseen: false, launchSignature: 'SECRET-launch',
      statusMessage: 'SECRET-cli-message', review: 'Codex asks to run SECRET-command', question: { text: 'SECRET-question', since: 'q' }, signIn: { message: 'SECRET-signin', since: 's1' },
      untakenLine: { since: 'u', text: 'SECRET-typed' }, inbox: { unread: [{ id: 'm1', from: 'the Assistant', text: 'SECRET-queued', at: 'm', state: 'queued' }], overdue: 1 }, titleAtRename: 'SECRET-title',
      mergeSlot: 'Waiting for the merge slot (B4 is merging #305)', watch: { cards: [12], changes: ['column'], label: 'Waiting for #12 → Review', since: 'w', limitAt: 'l' }, costUsd: 1.5, modelName: 'GPT', backgroundTasks: 2,
      futureField: 'SECRET-future'
    } as unknown as LiveSessionState
    const sent = apiEventFor({ type: 'session-status', state }, null)
    expect(JSON.stringify(sent)).not.toContain('SECRET')
    expect(sent!.state).toMatchObject({ status: 'waiting', agentName: 'B1', question: { since: 'q' }, reviewing: true, signIn: { since: 's1' }, untakenLine: { since: 'u' }, inbox: { unread: [{ id: 'm1', from: 'the Assistant', at: 'm', state: 'queued' }], overdue: 1 }, mergeSlot: state.mergeSlot, watch: { cards: [12], label: 'Waiting for #12 → Review' }, costUsd: 1.5, backgroundTasks: 2 })
    expect(publicSessionState({ ...state, question: undefined, review: undefined })).not.toHaveProperty('reviewing')
    // A launch that failed: that it did, not the CLI's output.
    const exit = apiEventFor({ type: 'session-exit', projectPath: alpha, agentId: 'a1', sessionId: 's', exitCode: 1, failure: { reason: 'SECRET-output', exitCode: 1, resumed: false, at: 't' } }, null)
    expect(exit).toEqual({ type: 'session-exit', projectPath: alpha, agentId: 'a1', sessionId: 's', exitCode: 1, failedToStart: true })
  })

  it('gives a progress run without its command line or a reporter\'s text', () => {
    const r = { ...run(alpha, 'r1'), title: 'e2e: full set', command: 'curl -H "Authorization: Bearer SECRET-token" https://x', stepName: 'SECRET-step', waiting: 'SECRET-waiting', waitingSince: 5, summary: 'SECRET-summary', logPath: 'C:\\SECRET\\log.txt', pid: 42, heldEstimateMs: 7, futureField: 'SECRET-future' } as ProgressRun
    const sent = publicRun(r)
    expect(JSON.stringify(sent)).not.toContain('SECRET')
    expect(sent).toMatchObject({ id: 'r1', title: 'e2e: full set', titleFromCommand: false, waiting: true, waitingSince: 5, state: 'running' })
    // No title of its own: the command line was its title, so none of it leaves Hive (Darren's rule): "a command".
    for (const command of [r.command!, '"C:\\Program Files\\nodejs\\npm.cmd" test --token SECRET', 'SECRET-tool']) {
      expect(publicRun({ ...r, command, title: command })).toMatchObject({ title: COMMAND_TITLE, titleFromCommand: true })
    }
    expect(JSON.stringify(apiEventFor({ type: 'progress-changed', workspacePath: ws, runs: [r] }, null))).not.toContain('SECRET')
  })

  // Round 2's finding: a command line longer than a title is cut to 120 characters as a title and 200 as a command, so
  // the two differ; with the credential early in the arguments, neither may reach the API (#620).
  it('calls a long command "a command" however its title and command were cut, with or without the reporter saying so', () => {
    const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
    const line = `cmd /c echo SECRET-token-0123456789abcdef SECRET-arg ${'z'.repeat(300)}`
    const base = { ...run(alpha, 'long'), title: cut(line, 120), command: cut(line, 200) }
    expect(base.title).not.toBe(base.command)
    const quoted = `"C:\\Program Files\\tool\\SECRET-run.exe" --token SECRET ${'z'.repeat(300)}`
    for (const r of [base, { ...base, titleFromCommand: true as const }, { ...base, title: cut(line.replace(/\s+/g, ' '), 120) }, { ...base, title: cut(quoted, 120), command: cut(quoted, 200) }]) {
      const sent = publicRun(r)
      expect(sent).toMatchObject({ title: COMMAND_TITLE, titleFromCommand: true })
      expect(JSON.stringify(sent)).not.toContain('SECRET')
    }
    // The reporter says so: whatever the title is, it stays in Hive.
    expect(publicRun({ ...base, title: 'anything', titleFromCommand: true }).title).toBe(COMMAND_TITLE)
    // An explicit title of its own stays, long or not.
    expect(publicRun({ ...base, title: 'e2e: the full set before merging' }).title).toBe('e2e: the full set before merging')
    expect(JSON.stringify(apiEventFor({ type: 'progress-changed', workspacePath: ws, runs: [base] }, null))).not.toContain('SECRET')
  })

  it('names only the workspace for workspace and lane changes', () => {
    expect(apiEventFor({ type: 'workspace-changed', workspace: { path: ws } as never }, null)).toEqual({ type: 'workspace-changed', workspace: ws })
    expect(apiEventFor({ type: 'lanes-changed', workspacePath: ws, lanes: [{ id: 'l' } as never] }, agent)).toEqual({ type: 'lanes-changed', workspacePath: ws })
  })
})
