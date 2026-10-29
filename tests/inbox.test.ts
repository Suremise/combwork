import { describe, expect, it } from 'vitest'
import { asksYou, branchSummary, finishedUnseen, inbox, inboxStateText } from '../src/shared/inbox'
import type { AgentBranchStatus, AgentInfo, LiveSessionState, ProjectInfo, SessionStatus } from '../src/shared/types'

const live = (status: SessionStatus, statusSince: string, unseen = false, extra: Partial<LiveSessionState> = {}): LiveSessionState =>
  ({ provider: 'claude-code', runId: 'r', projectPath: '', agentId: '', cwd: '', sessionId: '', status, statusSince, unseen, startedAt: '', launchSignature: '', ...extra }) as LiveSessionState

const agent = (id: string, l: LiveSessionState | null, worktree = false): AgentInfo =>
  ({ id, name: id, live: l, restartNeeded: false, resume: null, place: worktree ? { folder: `C:/wt/${id}`, is: 'legacy', name: id, branch: `hive/${id}`, base: 'main' } : { folder: 'C:/ws', is: 'project', name: null, branch: null } }) as AgentInfo

const project = (name: string, agents: AgentInfo[]): ProjectInfo => ({ name, path: `C:/ws/${name}`, agents }) as ProjectInfo

const work = (ahead: number, dirty: number): AgentBranchStatus => ({ branch: 'hive/x', base: 'main', into: 'main', ahead, dirty, diff: { files: 3, insertions: 120, deletions: 40 } })

describe('attention inbox', () => {
  it('asks you: waiting (seen or not) or signing in; finished unseen is told apart, never as a need (#1632)', () => {
    expect(asksYou(live('waiting', 't', false))).toBe(true)
    expect(asksYou(live('signin', 't', false))).toBe(true)
    expect(asksYou(live('finished', 't', true))).toBe(false)
    expect(finishedUnseen(live('finished', 't', true))).toBe(true)
    expect(finishedUnseen(live('finished', 't', false))).toBe(false)
    expect(finishedUnseen(live('working', 't', true))).toBe(false)
    expect(finishedUnseen(null)).toBe(false)
  })

  it('needs you: an agent at a prompt, signing in, asking or stopped by an error; one that only finished is apart (#1632)', () => {
    const p = project('alpha', [
      agent('prompt', live('waiting', '2026-10-25T22:00:00Z', false, { statusMessage: 'Allow Bash?' })),
      agent('signin', live('signin', '2026-10-25T22:01:00Z')),
      agent('error', live('error', '2026-10-25T22:02:00Z', false, { statusMessage: 'API Error: Connection error.' })),
      agent('done', live('finished', '2026-10-25T22:03:00Z', true)),
      agent('seen', live('finished', '2026-10-25T22:04:00Z', false)),
      agent('busy', live('working', '2026-10-25T22:05:00Z'))
    ])
    const box = inbox([p], null, () => null)
    expect(box.needYou.map((i) => `${i.agentId}/${i.kind}`)).toEqual(['prompt/waiting', 'signin/signin', 'error/error'])
    expect(box.needYou.map(inboxStateText)).toEqual(['Needs input: Allow Bash?', 'Needs sign-in', 'Stopped by an error: API Error: Connection error.'])
    expect(box.finished.map((i) => `${i.agentId}/${i.kind}`)).toEqual(['done/finished'])
    expect(inboxStateText(box.finished[0])).toBe('Finished')
  })

  it('a question the agent works on beside: it needs you, though it is working, until answered', () => {
    const q = { text: 'Which colour?', since: '2026-10-02T09:30:00Z' }
    expect(asksYou(live('working', 't', false, { question: q }))).toBe(true)
    expect(asksYou(live('finished', 't', true))).toBe(false)
    // Waiting comes first: what it waits on is what it needs now.
    const p = project('alpha', [
      agent('asks', live('working', '2026-10-02T10:00:00Z', false, { question: q })),
      agent('both', live('waiting', '2026-10-02T10:02:00Z', false, { statusMessage: 'Allow curl?', question: q })),
      agent('late', live('finished', '2026-10-02T10:01:00Z', true, { question: { text: '', since: '2026-10-02T10:04:00Z' } }))
    ])
    const box = inbox([p], null, () => null)
    expect(box.needYou.map((i) => `${i.agentId}/${i.kind}/${i.since}`)).toEqual(['asks/question/2026-10-02T09:30:00Z', 'both/waiting/2026-10-02T10:02:00Z', 'late/question/2026-10-02T10:04:00Z'])
    expect(box.needYou.map(inboxStateText)).toEqual(['Asks: Which colour?', 'Needs input: Allow curl?', 'Asks you something'])
  })

  it('needs you: an agent on another model after a safeguard stop (#606), until its pane is seen; waiting comes first', () => {
    const switched = { from: 'claude-opus-5-5', to: 'claude-opus-4-8', at: '2026-10-11T14:20:00.000Z' }
    const note = { at: '2026-10-11T14:12:12.921Z', model: 'claude-opus-5-5', tools: ['Bash'], stops: 1, switched, unseen: true }
    const p = project('alpha', [
      agent('fell', live('working', '2026-10-11T14:00:00Z', false, { safeguard: note })),
      agent('seen', live('working', '2026-10-11T14:00:00Z', false, { safeguard: { ...note, unseen: undefined } })),
      agent('asks', live('waiting', '2026-10-11T14:30:00Z', false, { statusMessage: 'Allow Bash?', safeguard: note })),
      agent('stopped', live('working', '2026-10-11T14:00:00Z', false, { safeguard: { at: note.at, tools: [], stops: 1 } }))
    ])
    const box = inbox([p], null, () => null)
    expect(box.needYou.map((i) => `${i.agentId}/${i.kind}/${i.since}`)).toEqual(['fell/safeguard/2026-10-11T14:20:00.000Z', 'asks/waiting/2026-10-11T14:30:00Z'])
    expect(inboxStateText(box.needYou[0])).toBe('After a safeguard stop: Now runs on Opus 4.8 instead of Opus 5.5')
    expect(asksYou(p.agents[0].live)).toBe(false)
  })

  it("needs you: a turn that ended on an error, from the CLI's own event, until its next turn starts (#1632 round 1)", async () => {
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    const { applyStep, hookStep } = await import('../src/main/hookStatus')
    const at = (st: LiveSessionState) => inbox([project('alpha', [agent('one', st)])], null, () => null)
    const step = (st: LiveSessionState, body: Record<string, unknown>) => {
      const ev = claudeCode.normalizeHook(body).event
      applyStep(st, hookStep(ev, { status: st.status, askedAtStart: false, compacting: null, backgroundWakes: false, tasks: 0, attention: 'hooks', reviewed: false, titleAsks: false, open: [], waitingOn: null, question: false, reviewing: false, safeguardPrompt: false }), '2026-10-25T21:40:00.000Z')
    }
    // 25 Oct's case: Claude Code's StopFailure on an API connection error.
    const st = live('working', '2026-10-25T21:30:00Z')
    step(st, { hook_event_name: 'StopFailure', error: 'unknown', last_assistant_message: 'API Error: Connection error.' })
    // Still idle as a turn's end makes it (Hive prompts and wakes it as any idle agent), and it needs you.
    expect(st.status).toBe('finished')
    expect(at(st).needYou.map((i) => `${i.kind}/${i.message}/${i.since}`)).toEqual(['error/API Error: Connection error./2026-10-25T21:40:00.000Z'])
    expect(inboxStateText(at(st).needYou[0])).toBe('Stopped by an error: API Error: Connection error.')
    expect(at(st).finished).toEqual([])
    // Looked at, it still needs you: only its next turn clears it.
    st.unseen = false
    expect(at(st).needYou).toHaveLength(1)
    step(st, { hook_event_name: 'UserPromptSubmit', prompt: 'try again' })
    expect(st.status).toBe('working')
    expect(at(st).needYou).toEqual([])
    // A turn that ends well is a finish, not an error; one with no words from the CLI still says it failed.
    step(st, { hook_event_name: 'Stop', last_assistant_message: 'Done.' })
    expect(st.failedTurn).toBeUndefined()
    expect(at(st).finished.map((i) => i.kind)).toEqual(['finished'])
    step(st, { hook_event_name: 'UserPromptSubmit', prompt: 'again' })
    // No words from the CLI (round 2 finding 2): English for agents, the window's language in the window.
    const { setLanguage, pseudoText } = await import('../src/shared/i18n')
    const { PSEUDO_LANGUAGE } = await import('../src/shared/i18n/languages')
    const { shownStatusMessage } = await import('../src/shared/runtime')
    setLanguage(PSEUDO_LANGUAGE, {})
    try {
      step(st, { hook_event_name: 'StopFailure', error: 'server_error' })
      expect(st.statusMessage).toBe('The turn ended on an error')
      expect(shownStatusMessage(st)).toContain(pseudoText('The turn ended on an error'))
      expect(at(st).needYou.map((i) => `${i.kind}/${i.message ?? ''}`)).toEqual(['error/'])
      expect(inboxStateText(at(st).needYou[0])).toContain(pseudoText('Stopped by an error'))
    } finally {
      setLanguage('en', {})
    }
  })

  it('lists them across projects and the Assistant, oldest first', () => {
    const a = project('alpha', [agent('one', live('finished', '2026-10-02T10:05:00Z', true)), agent('two', live('working', '2026-10-02T09:00:00Z'))])
    const b = project('beta', [agent('three', live('waiting', '2026-10-02T10:01:00Z', false, { statusMessage: 'Allow Bash?' }))])
    const assistant = project('assistant', [agent('assistant', live('finished', '2026-10-02T10:03:00Z', true))])
    const box = inbox([a, b], assistant, () => null)
    expect(box.needYou.map((i) => `${i.projectName}/${i.agentId}/${i.kind}`)).toEqual(['beta/three/waiting'])
    expect(box.needYou[0].message).toBe('Allow Bash?')
    expect(box.finished.map((i) => `${i.projectName}/${i.agentId}/${i.kind}`)).toEqual(['Hive Assistant/assistant/finished', 'alpha/one/finished'])
    expect(box.finished[0].assistant).toBe(true)
  })

  it('needs you: an agent whose start failed, with the first line of why, until it runs again', () => {
    const p = project('alpha', [agent('broken', null), agent('running', live('working', '2026-10-02T10:00:00Z'))])
    const failures: Record<string, { reason: string; at: string }> = { 'C:/ws/alpha/broken': { reason: "error: unknown option '--x'\nmore", at: '2026-10-02T09:00:00Z' }, 'C:/ws/alpha/running': { reason: 'old', at: 't' } }
    const box = inbox([p], null, () => null, (path, id) => failures[`${path}/${id}`])
    expect(box.needYou.map((i) => `${i.agentId}/${i.kind}/${i.message}/${i.since}`)).toEqual(["broken/failed/error: unknown option '--x'/2026-10-02T09:00:00Z"])
    expect(inboxStateText(box.needYou[0])).toBe("Couldn't start: error: unknown option '--x'")
  })

  it('to review: idle worktree agents with unmerged work, not counted with those that need you', () => {
    const p = project('alpha', [
      agent('done', live('finished', '2026-10-02T10:00:00Z', false), true),
      agent('stopped', null, true),
      agent('busy', live('working', '2026-10-02T10:00:00Z'), true),
      agent('clean', live('finished', '2026-10-02T10:00:00Z'), true),
      agent('unseen', live('finished', '2026-10-02T10:00:00Z', true), true),
      agent('folder', live('finished', '2026-10-02T10:00:00Z'))
    ])
    const branches: Record<string, AgentBranchStatus> = { done: work(2, 0), stopped: work(0, 1), busy: work(1, 0), clean: work(0, 0), unseen: work(1, 0), folder: work(1, 0) }
    const box = inbox([p], null, (_path, id) => branches[id])
    expect(box.toReview.map((i) => i.agentId)).toEqual(['done', 'stopped'])
    // An unseen finish is listed once, with the finished, and still carries its work.
    expect(box.needYou).toEqual([])
    expect(box.finished.map((i) => i.agentId)).toEqual(['unseen'])
    expect(box.finished[0].branch?.ahead).toBe(1)
  })

  it('sums up a branch', () => {
    expect(branchSummary(work(2, 1))).toBe('3 files, +120 −40 · 2 commits, 1 uncommitted file')
    expect(branchSummary({ ...work(1, 0), diff: undefined })).toBe('1 commit')
  })
})

describe('merging a worktree agent', () => {
  it('waits until the agent is between tasks', async () => {
    const { mergeBlocked } = await import('../src/shared/defaults')
    expect(mergeBlocked('Two', 'working')).toBe('Two is working. Merge once it has finished.')
    expect(mergeBlocked('Two', 'starting')).toContain('is working')
    expect(mergeBlocked('Two', 'waiting')).toBe('Two is waiting for your answer. Merge once it has finished.')
    expect(mergeBlocked('Two', 'background')).toContain('background tasks')
    // Watching cards: in the middle of its card loop, so its unfinished work isn't merged (cancel the watch first).
    expect(mergeBlocked('Two', 'watching')).toMatch(/waiting for cards .* cancel its watch first/)
    // The Assistant asks before stopping an agent in the middle of something; one only watching is idle (HI-1994).
    const { stopAsksUser } = await import('../src/shared/defaults')
    for (const st of ['starting', 'working', 'waiting', 'background'] as const) expect(stopAsksUser(st), st).toBe(true)
    for (const st of ['watching', 'ready', 'finished', 'stopped', 'error', null, undefined] as const) expect(stopAsksUser(st), String(st)).toBe(false)
    for (const s of ['finished', 'ready', 'stopped', null, undefined] as const) expect(mergeBlocked('Two', s)).toBeNull()
  })
})
