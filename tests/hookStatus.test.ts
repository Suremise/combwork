import { describe, expect, it } from 'vitest'
import { applyStep, compactionOver, hookStep, safeguardAnswered, SAFEGUARD_IDLE_MESSAGE, titleStep, type HookAction, type HookStatusInput, type HookStep } from '../src/main/hookStatus'
import { COMPACTING_MESSAGE } from '../src/shared/defaults'
import type { Ask, ProviderAdapter } from '../src/main/providers/types'
import type { SessionStatus } from '../src/shared/types'

/**
 * Hook calls as each CLI sends them, through its adapter's normaliser and the status rules, the way
 * SessionManager.handleHookNow does (it carries out the actions; here they're only recorded).
 */
interface Agent {
  status: SessionStatus
  statusMessage?: string
  unseen?: boolean
  question?: { text: string; since: string }
  review?: string
  askedAtStart: boolean
  compacting: HookStatusInput['compacting']
  tasks: number
  attention: HookStatusInput['attention']
  reviewed: boolean
  titleAsks: boolean
  open: Ask[]
  waitingOn: Ask | null
  safeguardPrompt?: boolean
  actions: HookAction[]
}

const agent = (status: SessionStatus, extra: Partial<Agent> = {}): Agent => ({ status, askedAtStart: false, compacting: null, tasks: 0, attention: 'hooks', reviewed: false, titleAsks: false, open: [], waitingOn: null, actions: [], ...extra })

const input = (a: Agent, backgroundWakes = false): HookStatusInput => ({ ...a, question: !!a.question, reviewing: !!a.review, safeguardPrompt: !!a.safeguardPrompt, backgroundWakes })

/** What SessionManager.carryOut does with a step: the actions (recorded here), the open asks and the wait, the status. */
function apply(a: Agent, step: HookStep): Agent {
  a.actions.push(...step.actions)
  if (step.open !== undefined) a.open = step.open
  if (step.waitingOn !== undefined) a.waitingOn = step.waitingOn
  applyStep(a, step)
  return a
}

/** The CLI's title comes to say a person must act, or no longer (watchTitle). */
function title(a: Agent, asks: boolean): Agent {
  const step = titleStep(asks, input(a))
  a.titleAsks = asks
  return apply(a, step)
}

function send(adapter: ProviderAdapter, a: Agent, ...bodies: Record<string, unknown>[]): Agent {
  for (const body of bodies) {
    const step = hookStep(adapter.normalizeHook(body).event, input(a, adapter.descriptor.capabilities.backgroundWakes))
    apply(a, step)
    // SessionManager.carryOut: the compaction Combwork asked for has begun, or is over (the step set the status).
    if (step.actions.includes('compactBegan')) a.compacting = 'started'
    if (step.actions.includes('compactEnded')) a.compacting = null
  }
  return a
}

const providers = async (): Promise<[string, ProviderAdapter, Record<string, Record<string, unknown>>][]> => {
  const { claudeCode } = await import('../src/main/providers/claude/adapter')
  const { codex } = await import('../src/main/providers/codex/adapter')
  return [
    [
      'Claude Code',
      claudeCode,
      {
        start: { hook_event_name: 'SessionStart', source: 'startup' },
        prompt: { hook_event_name: 'UserPromptSubmit', prompt: 'hi' },
        toolStart: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
        toolEnd: { hook_event_name: 'PostToolUse', tool_name: 'Bash' },
        ask: { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' },
        stop: { hook_event_name: 'Stop', last_assistant_message: 'All done.' },
        compactStart: { hook_event_name: 'PreCompact', trigger: 'manual' },
        compactEnd: { hook_event_name: 'PostCompact' },
        end: { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }
      }
    ],
    [
      'Codex',
      codex,
      {
        start: { hook_event_name: 'SessionStart', source: 'startup' },
        prompt: { hook_event_name: 'UserPromptSubmit', prompt: 'hi' },
        toolStart: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
        toolEnd: { hook_event_name: 'PostToolUse', tool_name: 'Bash' },
        ask: { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } },
        stop: { hook_event_name: 'Stop', last_assistant_message: 'All done.' },
        compactStart: { hook_event_name: 'PreCompact', trigger: 'manual' },
        compactEnd: { hook_event_name: 'PostCompact' },
        end: { hook_event_name: 'SessionEnd' }
      }
    ]
  ]
}

describe("a prompt's text, for telling the user's replies from Combwork's lines (#418)", () => {
  it('each provider reports what its CLI took; a Codex answer to its question loses its tag', async () => {
    for (const [name, adapter, h] of await providers()) expect(adapter.normalizeHook(h.prompt).event, name).toEqual({ kind: 'prompt', text: 'hi' })
    const { codex } = await import('../src/main/providers/codex/adapter')
    expect(codex.normalizeHook({ hook_event_name: 'UserPromptSubmit', prompt: '<send_user_message_question_reply>Red' }).event).toEqual({ kind: 'prompt', text: 'Red' })
  })
})

describe('hook → status, for each provider', () => {
  it('a turn: starting → ready → working → waiting → working → finished', async () => {
    for (const [name, adapter, h] of await providers()) {
      const a = agent('starting')
      expect(send(adapter, a, h.start).status, name).toBe('ready')
      expect(send(adapter, a, h.prompt, h.toolStart).status, name).toBe('working')
      send(adapter, a, h.ask)
      expect(a.status, name).toBe('waiting')
      expect(a.statusMessage, name).toMatch(name === 'Codex' ? /^Codex asks to run rm -rf build/ : /permission to use Bash/)
      expect(a.unseen, name).toBe(true)
      a.unseen = false
      // The user answers: the tool runs.
      send(adapter, a, h.toolEnd)
      expect([a.status, a.statusMessage], name).toEqual(['working', undefined])
      send(adapter, a, h.stop)
      expect([a.status, a.statusMessage, a.unseen], name).toEqual(['finished', undefined, true])
      expect(a.actions.filter((x) => x === 'notifyWaiting' || x === 'notifyFinished'), name).toEqual(['notifyWaiting', 'notifyFinished'])
      expect(a.actions, name).toContain('releaseLocks')
      expect(a.actions, name).toContain('turnEnded')
    }
  })

  it('a SessionStart later (a resume or /clear) leaves a running agent alone', async () => {
    for (const [name, adapter, h] of await providers()) {
      expect(send(adapter, agent('working'), h.start).status, name).toBe('working')
      expect(send(adapter, agent('finished'), h.start).status, name).toBe('finished')
      // But one that asked a question at start (folder trust) is ready once answered.
      expect(send(adapter, agent('waiting', { askedAtStart: true }), h.start).status, name).toBe('ready')
    }
  })

  it('a prompt from any state is working; a tool ending revives an idle agent', async () => {
    for (const [name, adapter, h] of await providers()) {
      for (const from of ['ready', 'finished', 'waiting', 'background'] as SessionStatus[]) {
        expect(send(adapter, agent(from), h.prompt).status, `${name} ${from}`).toBe('working')
        expect(send(adapter, agent(from), h.toolEnd).status, `${name} ${from}`).toBe('working')
      }
      expect(send(adapter, agent('starting'), h.toolEnd).status, name).toBe('starting')
    }
  })

  it('the session ends: stopped, every lock released and the tasks forgotten', async () => {
    for (const [name, adapter, h] of await providers()) {
      const a = send(adapter, agent('working', { tasks: 2 }), h.end)
      expect(a.status, name).toBe('stopped')
      expect(a.actions, name).toEqual(['releaseAllLocks', 'clearTasks'])
    }
  })

  it('compaction Combwork asked for: under way, then ready', async () => {
    for (const [name, adapter, h] of await providers()) {
      const a = agent('working', { statusMessage: COMPACTING_MESSAGE, compacting: 'requested' })
      send(adapter, a, h.compactStart)
      expect([a.status, a.statusMessage, a.compacting, a.actions], name).toEqual(['working', COMPACTING_MESSAGE, 'started', ['compactBegan']])
      send(adapter, a, h.compactEnd)
      expect([a.status, a.statusMessage, a.compacting, a.unseen], name).toEqual(['ready', undefined, null, undefined])
    }
  })

  it("compaction Combwork asked for, its end unsaid: a new turn ends it, and a late end doesn't make the turn idle", async () => {
    for (const [name, adapter, h] of await providers()) {
      const a = send(adapter, agent('working', { statusMessage: COMPACTING_MESSAGE, compacting: 'requested' }), h.compactStart, h.prompt)
      expect([a.status, a.statusMessage, a.compacting], name).toEqual(['working', undefined, null])
      expect(a.actions, name).toEqual(['compactBegan', 'answered', 'prompted', 'compactEnded'])
      // PostCompact after all, or Combwork noticing the end (transcript, time limit): the turn stands.
      expect(send(adapter, a, h.compactEnd).status, name).toBe('working')
      expect(compactionOver(a).next, name).toBeNull()
    }
  })

  it("a prompt before the CLI begins Combwork's compaction (it may be the /compact typed) leaves it under way", async () => {
    for (const [name, adapter, h] of await providers()) {
      const a = send(adapter, agent('working', { statusMessage: COMPACTING_MESSAGE, compacting: 'requested' }), h.prompt)
      expect([a.status, a.statusMessage, a.compacting], name).toEqual(['working', COMPACTING_MESSAGE, 'requested'])
      send(adapter, a, h.compactStart, h.compactEnd)
      expect([a.status, a.statusMessage, a.compacting], name).toEqual(['ready', undefined, null])
    }
  })

  it('a compaction over by what Combwork saw (no hook): ready only while it still shows', () => {
    const shown = agent('working', { statusMessage: COMPACTING_MESSAGE })
    expect(applyStep(shown, compactionOver(shown))).toBe(true)
    expect([shown.status, shown.statusMessage]).toEqual(['ready', undefined])
    for (const other of [agent('working'), agent('working', { statusMessage: 'Setting up the worktree: x' }), agent('waiting', { statusMessage: COMPACTING_MESSAGE }), agent('stopped')]) {
      const before = { ...other }
      expect(applyStep(other, compactionOver(other))).toBe(false)
      expect(other).toEqual(before)
    }
  })

  it('compaction the CLI does by itself: said, and an idle agent is ready again after it', async () => {
    for (const [name, adapter, h] of await providers()) {
      // Mid-turn: it keeps working, with a heads-up.
      const busy = send(adapter, agent('working'), h.compactStart)
      expect([busy.status, busy.statusMessage, busy.actions], name).toEqual(['working', undefined, ['autoCompact']])
      expect(send(adapter, busy, h.compactEnd).status, name).toBe('working')
      // /compact typed while idle: working while it compacts, and ready (not stuck working) once done.
      const idle = send(adapter, agent('ready'), h.compactStart)
      expect([idle.status, idle.statusMessage], name).toEqual(['working', COMPACTING_MESSAGE])
      // Watched for its end as Combwork's own Compact is: nothing else may say so (#1115).
      expect(idle.actions, name).toEqual(['autoCompact', 'autoCompactIdle'])
      send(adapter, idle, h.compactEnd)
      expect([idle.status, idle.statusMessage], name).toEqual(['ready', undefined])
      // A prompt typed meanwhile (queued until it is done) starts a turn its end doesn't idle.
      const queued = send(adapter, agent('ready'), h.compactStart, h.prompt, h.compactEnd)
      expect([queued.status, queued.statusMessage], name).toEqual(['working', undefined])
      // Compacted while waiting on its background tasks (#521): background again, not ready, where they wake it.
      const waiting = send(adapter, agent('background', { tasks: 1 }), h.compactStart, h.compactEnd)
      expect(waiting.status, name).toBe(adapter.descriptor.capabilities.backgroundWakes ? 'background' : 'ready')
    }
    const shown = agent('working', { statusMessage: COMPACTING_MESSAGE })
    expect(applyStep(shown, compactionOver(shown, 'background'))).toBe(true)
    expect(shown.status).toBe('background')
  })

  it('duplicates: the same question or a second Stop notifies once', async () => {
    for (const [name, adapter, h] of await providers()) {
      const a = send(adapter, agent('working'), h.ask, h.ask)
      expect(a.actions.filter((x) => x === 'notifyWaiting').length, name).toBe(1)
      send(adapter, a, h.stop, h.stop)
      expect(a.actions.filter((x) => x === 'notifyFinished').length, name).toBe(1)
      expect(a.status, name).toBe('finished')
    }
  })

  it('out of order: a late tool end after Stop revives the agent; a Stop then settles it again', async () => {
    for (const [name, adapter, h] of await providers()) {
      const a = send(adapter, agent('working'), h.stop, h.toolEnd)
      expect(a.status, name).toBe('working')
      expect(send(adapter, a, h.stop).status, name).toBe('finished')
    }
  })

  it('unknown hooks and tool starts change nothing', async () => {
    for (const [name, adapter, h] of await providers()) {
      const a = send(adapter, agent('waiting', { statusMessage: 'Allow?' }), { hook_event_name: 'SubagentStop' }, h.toolStart)
      expect([a.status, a.statusMessage, a.actions], name).toEqual(['waiting', 'Allow?', []])
    }
  })
})

describe('Codex: who is asked', () => {
  // The hooks as Codex 0.160.0 sent them (tests/e2e probes, Oct 2026): a permission request comes before anyone
  // answers it, in every mode; the async question returns at once and its answer comes later as a prompt.
  const pre = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'curl.exe https://example.com' } }
  const permission = { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'curl.exe https://example.com' } }
  const post = { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'curl.exe https://example.com' } }
  /** Another command, run beside the one asked about. */
  const besidePre = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }
  const besidePost = { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }
  const asyncQuestion = { hook_event_name: 'PreToolUse', tool_name: 'request_user_input_async', tool_input: { questions: [{ title: 'Which colour?', options: ['Red', 'Blue'] }] } }
  const asyncAccepted = { hook_event_name: 'PostToolUse', tool_name: 'request_user_input_async' }
  const question = { hook_event_name: 'PreToolUse', tool_name: 'request_user_input', tool_input: { questions: [{ question: 'Which language?' }] } }
  const answer = { hook_event_name: 'UserPromptSubmit', prompt: '<send_user_message_question_reply>' }
  const stop = { hook_event_name: 'Stop', last_assistant_message: 'Done.' }
  const interrupt = { hook_event_name: 'Interrupt' }
  const ASKS = 'Codex asks to run curl.exe https://example.com'

  const codexAdapter = async (): Promise<ProviderAdapter> => (await import('../src/main/providers/codex/adapter')).codex
  /** A Codex agent mid-turn, told by its title (0.160.0 and later), in Approve for me or Ask for approval. */
  const codexAgent = (mode: 'approve-for-me' | 'ask', extra: Partial<Agent> = {}): Agent => agent('working', { attention: 'title', reviewed: mode === 'approve-for-me', ...extra })
  const told = (a: Agent) => a.actions.filter((x) => x === 'notifyWaiting' || x === 'notifyQuestion')
  const asked = (a: Agent) => [a.status, a.statusMessage, a.question?.text]

  it('Approve for me: an auto-reviewed request never says you are needed, allowed or denied', async () => {
    const codex = await codexAdapter()
    const allowed = send(codex, codexAgent('approve-for-me'), pre, permission)
    // Under review beside the status (which stays working, its message unset), what is asked as its details.
    expect([...asked(allowed), allowed.review]).toEqual(['working', undefined, undefined, ASKS])
    send(codex, allowed, post)
    expect([...asked(allowed), allowed.review]).toEqual(['working', undefined, undefined, undefined])
    send(codex, allowed, stop)
    expect([allowed.status, told(allowed)]).toEqual(['finished', []])
    // Denied: no PostToolUse; the next tool shows the review is over, and the turn ends as usual.
    const denied = send(codex, codexAgent('approve-for-me'), pre, permission, { ...pre, tool_input: { command: 'ls' } })
    expect([...asked(denied), denied.review]).toEqual(['working', undefined, undefined, undefined])
    expect([send(codex, denied, stop).status, told(denied)]).toEqual(['finished', []])
    // Or the turn ends on the denial itself.
    const ended = send(codex, codexAgent('approve-for-me'), pre, permission, stop)
    expect([ended.status, ended.statusMessage, told(ended)]).toEqual(['finished', undefined, []])
  })

  it('Approve for me: if Codex did put the request to you (its title says so), you are told once', async () => {
    const codex = await codexAdapter()
    const a = send(codex, codexAgent('approve-for-me'), pre, permission)
    title(a, true)
    // Unsaid: a reviewed request is never taken for the title (a finished review could be taken for a later one).
    expect([...asked(a), told(a)]).toEqual(['waiting', undefined, undefined, ['notifyWaiting']])
    // The title blinks ("[ ! ]" / "[ . ]"): still the same need.
    title(a, true)
    expect(told(a)).toEqual(['notifyWaiting'])
    title(a, false)
    send(codex, a, post)
    expect(asked(a)).toEqual(['working', undefined, undefined])
  })

  it('Ask for approval: waiting while the prompt is up, told once, and over when it is answered', async () => {
    const codex = await codexAdapter()
    // Approved.
    const yes = send(codex, codexAgent('ask'), pre, permission)
    expect(asked(yes)).toEqual(['working', undefined, undefined])
    title(yes, true)
    expect([...asked(yes), yes.unseen, told(yes)]).toEqual(['waiting', ASKS, undefined, true, ['notifyWaiting']])
    title(yes, false)
    expect(asked(yes)).toEqual(['working', undefined, undefined])
    send(codex, yes, post, stop)
    expect([yes.status, told(yes)]).toEqual(['finished', ['notifyWaiting']])
    // Rejected (Esc): the prompt goes, and the turn is interrupted.
    const no = title(send(codex, codexAgent('ask'), pre, permission), true)
    send(codex, title(no, false), interrupt)
    expect([no.status, no.statusMessage, no.open, no.waitingOn]).toEqual(['ready', undefined, [], null])
    // Hooks in the other order: the title first (the hook is still on its way), then what was asked.
    const late = title(codexAgent('ask'), true)
    expect([...asked(late), told(late)]).toEqual(['waiting', undefined, undefined, ['notifyWaiting']])
    send(codex, late, permission, permission)
    expect([...asked(late), told(late)]).toEqual(['waiting', ASKS, undefined, ['notifyWaiting']])
  })

  it('a tool ending beside an open prompt does not answer it', async () => {
    const codex = await codexAdapter()
    const a = title(send(codex, codexAgent('ask'), pre, permission), true)
    send(codex, a, besidePre, besidePost)
    expect(a.status).toBe('waiting')
    title(a, false)
    expect(a.status).toBe('working')
  })

  it('a blocking question waits; it is answered when the title says so', async () => {
    const codex = await codexAdapter()
    const a = title(send(codex, codexAgent('approve-for-me'), question), true)
    expect([...asked(a), told(a)]).toEqual(['waiting', 'Which language?', undefined, ['notifyWaiting']])
    title(a, false)
    expect(asked(a)).toEqual(['working', undefined, undefined])
  })

  it('an async question: working on, the question pending until it is answered, told once', async () => {
    const codex = await codexAdapter()
    // A call Codex rejected (bad arguments) shows nothing: only the title says a question is up.
    const a = send(codex, codexAgent('approve-for-me'), asyncQuestion, asyncQuestion, asyncAccepted)
    expect(asked(a)).toEqual(['working', undefined, undefined])
    title(a, true)
    expect([...asked(a), told(a)]).toEqual(['working', undefined, 'Which colour?', ['notifyQuestion']])
    // It works on meanwhile; tools and other prompts don't answer it, nor does the title blinking.
    send(codex, a, pre, post, { hook_event_name: 'UserPromptSubmit', prompt: 'also do x' })
    title(a, true)
    expect([...asked(a), told(a)]).toEqual(['working', undefined, 'Which colour?', ['notifyQuestion']])
    // The answer: a prompt, and the title clears.
    send(codex, a, answer)
    title(a, false)
    expect([...asked(a), told(a)]).toEqual(['working', undefined, undefined, ['notifyQuestion']])
  })

  it('an async question still open at the turn end stays until answered', async () => {
    const codex = await codexAdapter()
    const a = title(send(codex, codexAgent('ask'), asyncQuestion, asyncAccepted), true)
    send(codex, a, stop)
    expect([a.status, a.question?.text]).toEqual(['finished', 'Which colour?'])
    title(a, false)
    expect([a.status, a.question]).toEqual(['finished', undefined])
  })

  it('the title before the async question: told once, then shown as the question it is', async () => {
    const codex = await codexAdapter()
    const a = title(codexAgent('approve-for-me'), true)
    send(codex, a, asyncQuestion, asyncAccepted)
    expect([...asked(a), told(a)]).toEqual(['working', undefined, 'Which colour?', ['notifyWaiting']])
  })

  it('a blocking ask while a question is pending is told: it is a new need', async () => {
    const codex = await codexAdapter()
    const a = title(send(codex, codexAgent('ask'), asyncQuestion, asyncAccepted), true)
    send(codex, a, pre, permission)
    expect([...asked(a), told(a)]).toEqual(['waiting', ASKS, 'Which colour?', ['notifyQuestion', 'notifyWaiting']])
  })

  // The title is one for everything, so it can't say which of two asks it is for: a pending question keeps it on.
  describe('with a question pending (the title already on)', () => {
    /** A Codex agent working on with an async question pending, its title on. */
    const withQuestion = async (mode: 'approve-for-me' | 'ask'): Promise<Agent> => {
      const codex = await codexAdapter()
      const a = title(send(codex, codexAgent(mode), asyncQuestion, asyncAccepted), true)
      expect([...asked(a), told(a)]).toEqual(['working', undefined, 'Which colour?', ['notifyQuestion']])
      return a
    }

    it('Approve for me: an auto-review allowed meanwhile is not you being asked', async () => {
      const codex = await codexAdapter()
      const a = send(codex, await withQuestion('approve-for-me'), pre, permission, permission)
      title(a, true)
      expect([...asked(a), a.review, told(a)]).toEqual(['working', undefined, 'Which colour?', ASKS, ['notifyQuestion']])
      send(codex, a, post)
      expect([...asked(a), a.review, told(a)]).toEqual(['working', undefined, 'Which colour?', undefined, ['notifyQuestion']])
      // The question is answered: a prompt, and the title goes back.
      send(codex, a, answer)
      title(a, false)
      expect([...asked(a), told(a)]).toEqual(['working', undefined, undefined, ['notifyQuestion']])
    })

    it('Approve for me: nor one denied, which the next command shows is over', async () => {
      const codex = await codexAdapter()
      const a = send(codex, await withQuestion('approve-for-me'), pre, permission, besidePre, besidePost)
      expect([...asked(a), told(a)]).toEqual(['working', undefined, 'Which colour?', ['notifyQuestion']])
      send(codex, a, stop)
      expect([a.status, a.question?.text, told(a)]).toEqual(['finished', 'Which colour?', ['notifyQuestion']])
    })

    it('Approve for me: a request the reviewer hands to you once the question is answered is told', async () => {
      const codex = await codexAdapter()
      const a = send(codex, await withQuestion('approve-for-me'), pre, permission, answer)
      title(a, false)
      title(a, true)
      expect([a.status, told(a)]).toEqual(['waiting', ['notifyQuestion', 'notifyWaiting']])
    })

    it('Ask for approval: the prompt is a new need, and its own command ending answers it', async () => {
      const codex = await codexAdapter()
      const a = send(codex, await withQuestion('ask'), pre, permission, permission)
      title(a, true)
      expect([...asked(a), told(a)]).toEqual(['waiting', ASKS, 'Which colour?', ['notifyQuestion', 'notifyWaiting']])
      // Another command ending doesn't; the one asked about does, though the question keeps the title on.
      send(codex, a, besidePre, besidePost)
      expect(a.status).toBe('waiting')
      send(codex, a, post)
      expect([...asked(a), told(a)]).toEqual(['working', undefined, 'Which colour?', ['notifyQuestion', 'notifyWaiting']])
      send(codex, a, answer)
      title(a, false)
      expect(asked(a)).toEqual(['working', undefined, undefined])
    })

    it('Ask for approval: rejected (Esc), the turn ends and the question stays', async () => {
      const codex = await codexAdapter()
      const a = send(codex, await withQuestion('ask'), pre, permission, interrupt)
      expect([a.status, a.question?.text]).toEqual(['ready', 'Which colour?'])
    })

    it('a blocking question meanwhile waits, and its own end answers it', async () => {
      const codex = await codexAdapter()
      const a = send(codex, await withQuestion('approve-for-me'), question)
      expect([...asked(a), told(a)]).toEqual(['waiting', 'Which language?', 'Which colour?', ['notifyQuestion', 'notifyWaiting']])
      send(codex, a, { hook_event_name: 'PostToolUse', tool_name: 'request_user_input', tool_input: question.tool_input })
      expect(asked(a)).toEqual(['working', undefined, 'Which colour?'])
    })
  })

  it('a question asked while a prompt waits leaves the wait, and is shown beside it', async () => {
    const codex = await codexAdapter()
    const a = title(send(codex, codexAgent('ask'), pre, permission), true)
    send(codex, a, asyncQuestion, asyncAccepted)
    expect([...asked(a), told(a)]).toEqual(['waiting', ASKS, 'Which colour?', ['notifyWaiting']])
    send(codex, a, post)
    expect(asked(a)).toEqual(['working', undefined, 'Which colour?'])
  })

  // What is asked is remembered from its hook until it is resolved; nothing resolved can explain a later title.
  describe('the lifetime of what is asked', () => {
    const titleFirst = async (a: Agent): Promise<Agent> => send(await codexAdapter(), title(a, true), asyncQuestion, asyncAccepted)
    const hookFirst = async (a: Agent): Promise<Agent> => title(send(await codexAdapter(), a, asyncQuestion, asyncAccepted), true)

    for (const [order, ask] of [['title before its hook', titleFirst], ['hook before its title', hookFirst]] as const) {
      for (const outcome of ['allowed', 'denied'] as const) {
        it(`a review ${outcome}, then a new question (${order}): the question, not the finished review`, async () => {
          const codex = await codexAdapter()
          // Duplicate request hooks, and for a denial the next command.
          const a = send(codex, codexAgent('approve-for-me'), pre, permission, permission, ...(outcome === 'allowed' ? [post] : [besidePre, besidePost]))
          expect([...asked(a), a.open]).toEqual(['working', undefined, undefined, []])
          await ask(a)
          expect([...asked(a), a.waitingOn]).toEqual(['working', undefined, 'Which colour?', null])
          // Told once: of the question, or (title first) of a need its hook then named.
          expect(told(a)).toEqual([order === 'title before its hook' ? 'notifyWaiting' : 'notifyQuestion'])
          send(codex, a, answer)
          title(a, false)
          expect(asked(a)).toEqual(['working', undefined, undefined])
        })
      }

      it(`a prompt approved, then a new question (${order}): the question, not the answered prompt`, async () => {
        const codex = await codexAdapter()
        const a = title(send(codex, codexAgent('ask'), pre, permission), true)
        title(send(codex, a, post), false)
        expect([a.status, a.open, a.waitingOn]).toEqual(['working', [], null])
        await ask(a)
        expect(asked(a)).toEqual(['working', undefined, 'Which colour?'])
      })
    }

    it('an ask whose call ended before the title came is resolved: it is not what the title is about', async () => {
      const codex = await codexAdapter()
      // Ask for approval, but the call ends at once (approved by a rule of the user's): never asked.
      const a = send(codex, codexAgent('ask'), pre, permission, post)
      expect(a.open).toEqual([])
      await titleFirst(a)
      expect(asked(a)).toEqual(['working', undefined, 'Which colour?'])
    })

    it('a late or repeated hook of a resolved call changes nothing', async () => {
      const codex = await codexAdapter()
      const a = send(codex, codexAgent('approve-for-me'), pre, permission, post, post)
      expect([...asked(a), a.open, told(a)]).toEqual(['working', undefined, undefined, [], []])
    })

    it('two prompts at once (calls side by side): the wait stays until both are answered', async () => {
      const codex = await codexAdapter()
      const other = { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } }
      const a = title(send(codex, codexAgent('ask'), pre, permission, besidePre), true)
      send(codex, a, other)
      expect([a.status, a.statusMessage, told(a)]).toEqual(['waiting', 'Codex asks to run ls', ['notifyWaiting']])
      // The newer one answered: still waiting, on the first, without telling again.
      send(codex, a, besidePost)
      expect([a.status, a.statusMessage, told(a)]).toEqual(['waiting', ASKS, ['notifyWaiting']])
      send(codex, a, post)
      title(a, false)
      expect([a.status, a.open, a.waitingOn]).toEqual(['working', [], null])
    })

    it('a question and a prompt open before the title: it is about both, told once', async () => {
      const codex = await codexAdapter()
      const a = title(send(codex, codexAgent('ask'), asyncQuestion, asyncAccepted, pre, permission), true)
      expect([...asked(a), told(a), a.open]).toEqual(['waiting', ASKS, 'Which colour?', ['notifyWaiting'], []])
      // Its prompt answered, the title stays on for the question.
      send(codex, a, post)
      expect([...asked(a), told(a)]).toEqual(['working', undefined, 'Which colour?', ['notifyWaiting']])
      title(a, false)
      expect(asked(a)).toEqual(['working', undefined, undefined])
    })
  })

  it('an older Codex (no title): by its hooks, where the mode says who answers', async () => {
    const codex = await codexAdapter()
    // Approve for me: its reviewer answers permission requests.
    const reviewed = send(codex, agent('working', { reviewed: true }), pre, permission)
    expect([...asked(reviewed), reviewed.review, told(reviewed)]).toEqual(['working', undefined, undefined, ASKS, []])
    // Ask for approval: the request is the prompt.
    const prompted = send(codex, agent('working'), pre, permission)
    expect([...asked(prompted), told(prompted)]).toEqual(['waiting', ASKS, undefined, ['notifyWaiting']])
    send(codex, prompted, post)
    expect(prompted.status).toBe('working')
    // A question, in any mode; the async one is answered by the next prompt.
    const q = send(codex, agent('working', { reviewed: true }), asyncQuestion, asyncAccepted)
    expect([...asked(q), told(q)]).toEqual(['working', undefined, 'Which colour?', ['notifyQuestion']])
    send(codex, q, answer)
    expect(q.question).toBeUndefined()
    expect(send(codex, agent('working', { reviewed: true }), question).status).toBe('waiting')
  })

  // An action under Codex's own review is shown beside the status, never as it: the status stays working, nobody is
  // told, and it goes as soon as the review is over, the turn ends, or a person is asked after all.
  describe('automatic review (Approve for me)', () => {
    const other = { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm.cmd run e2e -- icons' } }
    const otherPre = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm.cmd run e2e -- icons' } }
    const view = (a: Agent) => [a.status, a.statusMessage, a.review]

    it('repeated and successive requests: the latest is shown, never as the status, never told', async () => {
      const codex = await codexAdapter()
      const a = send(codex, codexAgent('approve-for-me'), pre, permission, permission)
      expect(view(a)).toEqual(['working', undefined, ASKS])
      send(codex, a, post, otherPre, other)
      expect(view(a)).toEqual(['working', undefined, 'Codex asks to run npm.cmd run e2e -- icons'])
      expect([told(a), a.actions.includes('notifyFinished')]).toEqual([[], false])
    })

    it('it goes at the turn end, an interruption, a prompt and the session end', async () => {
      const codex = await codexAdapter()
      for (const end of [stop, interrupt, { hook_event_name: 'UserPromptSubmit', prompt: 'also' }, { hook_event_name: 'SessionEnd' }]) {
        const a = send(codex, codexAgent('approve-for-me'), pre, permission, end)
        expect(a.review, end.hook_event_name).toBeUndefined()
      }
    })

    it('the reviewer hands it to you (the title asks): waiting, told once, the review gone', async () => {
      const codex = await codexAdapter()
      const a = title(send(codex, codexAgent('approve-for-me'), pre, permission), true)
      expect([...view(a), told(a)]).toEqual(['waiting', undefined, undefined, ['notifyWaiting']])
      // A late repeat of the request while you are asked doesn't put it back.
      send(codex, a, permission)
      expect(view(a)).toEqual(['waiting', undefined, undefined])
    })

    it('a request while a person is already asked (a blocking question) shows no review over the wait', async () => {
      const codex = await codexAdapter()
      const a = title(send(codex, codexAgent('approve-for-me'), question), true)
      send(codex, a, pre, permission)
      expect([...view(a), a.question?.text]).toEqual(['waiting', 'Which language?', undefined, undefined])
    })

    it('Ask for approval: the request is put to you, never shown as under review', async () => {
      const codex = await codexAdapter()
      const a = title(send(codex, codexAgent('ask'), pre, permission), true)
      expect([...view(a), told(a)]).toEqual(['waiting', ASKS, undefined, ['notifyWaiting']])
    })

    it('Claude Code: its modes have no automatic review in hooks, so a permission prompt is always a wait', async () => {
      const [[, claude, h]] = await providers()
      const a = send(claude, agent('working', { reviewed: false }), h.ask)
      expect(view(a)).toEqual(['waiting', 'Claude needs your permission to use Bash', undefined])
    })
  })

  it('the session ending clears a pending question', async () => {
    const codex = await codexAdapter()
    const a = title(send(codex, codexAgent('ask'), asyncQuestion), true)
    send(codex, a, { hook_event_name: 'SessionEnd' })
    expect([a.status, a.question, a.open, a.waitingOn]).toEqual(['stopped', undefined, [], null])
  })
})

describe('background tasks at a turn end', () => {
  it('Claude Code (told when they end): background while any run, without a finished notification', async () => {
    const [[, claude, h]] = await providers()
    const a = send(claude, agent('working', { tasks: 1 }), h.stop)
    expect(a.status).toBe('background')
    expect(a.actions).not.toContain('notifyFinished')
    // An interrupted turn with tasks still running is background too.
    expect(hookStep({ kind: 'interrupt' }, input(agent('working', { tasks: 2 }), true)).next).toBe('background')
  })

  it("Codex (not told): finished, since it won't carry on by itself", async () => {
    const [, [, codexAdapter, h]] = await providers()
    const a = send(codexAdapter, agent('working', { tasks: 1 }), h.stop)
    expect(a.status).toBe('finished')
    expect(a.actions).toContain('notifyFinished')
    expect(send(codexAdapter, agent('working', { tasks: 1 }), { hook_event_name: 'Interrupt' }).status).toBe('ready')
  })
})

describe("Claude Code's prompt about a safeguard stop, answered (#606)", () => {
  const idle = { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }
  const asked = { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' }

  it('waits on the prompt until its idle notice, then is idle, ready for a nudge, with nothing open', async () => {
    const [[, claude, h]] = await providers()
    // HB3, 11 Oct: its turn ended, then Claude Code asked whether to switch models; answered, no hook said so.
    const a = send(claude, agent('working'), h.stop, asked)
    expect(a.status).toBe('waiting')
    a.safeguardPrompt = true
    send(claude, a, idle)
    expect([a.status, a.statusMessage, a.waitingOn]).toEqual(['ready', SAFEGUARD_IDLE_MESSAGE, null])
    expect(a.actions).toContain('releaseLocks')
  })

  it('the prompt gone from its screen answers it too; with background tasks it is on them, with no nudge asked for', () => {
    const a = agent('waiting', { safeguardPrompt: true })
    expect(apply(a, safeguardAnswered(input(a)))).toMatchObject({ status: 'ready', statusMessage: SAFEGUARD_IDLE_MESSAGE })
    const b = agent('waiting', { safeguardPrompt: true, tasks: 1 })
    apply(b, safeguardAnswered(input(b, true)))
    expect([b.status, b.statusMessage]).toEqual(['background', undefined])
  })

  it('changes nothing while it waits on another prompt, or no longer waits', async () => {
    const [[, claude]] = await providers()
    // A tool's permission prompt is answered by its call: the idle notice leaves it waiting, as before.
    expect(send(claude, agent('waiting'), idle).status).toBe('waiting')
    for (const status of ['working', 'ready', 'finished'] as SessionStatus[]) expect(safeguardAnswered(input(agent(status, { safeguardPrompt: true }))).next).toBeNull()
    expect(safeguardAnswered(input(agent('waiting'))).next).toBeNull()
  })
})

describe("the CLI says it is idle at its prompt (Claude Code's idle_prompt, #612)", () => {
  const idle = { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }

  it("an agent Combwork still shows working (its turn's end missed) is idle again, its claims released, and the log told", async () => {
    const [[, claude]] = await providers()
    const a = send(claude, agent('working'), idle)
    expect(a.status).toBe('ready')
    expect(a.actions).toEqual(['releaseLocks', 'idleAgain'])
    // A stale "Compacting…" (a compaction whose end never came) goes too.
    expect(send(claude, agent('working', { statusMessage: COMPACTING_MESSAGE }), idle)).toMatchObject({ status: 'ready', statusMessage: undefined })
    // Background tasks it is told about still count.
    expect(hookStep({ kind: 'idle' }, input(agent('working', { tasks: 1 }), true)).next).toBe('background')
  })

  it('changes nothing else: an idle, waiting or background agent, or one Combwork is compacting', async () => {
    const [[, claude]] = await providers()
    for (const status of ['ready', 'finished', 'watching', 'waiting', 'background', 'signin'] as SessionStatus[]) {
      const a = send(claude, agent(status), idle)
      expect([a.status, a.actions]).toEqual([status, []])
    }
    for (const compacting of ['requested', 'started'] as const) expect(hookStep({ kind: 'idle' }, input(agent('working', { compacting, statusMessage: COMPACTING_MESSAGE }))).next).toBeNull()
  })

  it("an idle compaction and its recap, as Claude Code 2.1.296 sends them, leave an idle agent idle", async () => {
    const [[, claude, h]] = await providers()
    const a = send(claude, agent('working'), h.stop)
    expect(a.status).toBe('finished')
    // The compaction: PreCompact (auto), SessionStart (compact), PostCompact; Combwork's hooks have no SubagentStop.
    send(claude, a, { hook_event_name: 'PreCompact', trigger: 'auto' })
    expect([a.status, a.statusMessage]).toEqual(['working', COMPACTING_MESSAGE])
    send(claude, a, { hook_event_name: 'SessionStart', source: 'compact' }, { hook_event_name: 'PostCompact', trigger: 'auto' })
    expect([a.status, a.statusMessage]).toEqual(['ready', undefined])
    // The recap sends no hook of Combwork's; the idle notification a minute after the turn changes nothing either.
    send(claude, a, idle)
    expect(a.status).toBe('ready')
  })
})

describe('background tasks: their time limit', () => {
  it('drops tasks past their own expiry quietly, and those past the limit by name', async () => {
    const { expireTasks } = await import('../src/main/hookStatus')
    const now = Date.parse('2026-10-02T12:00:00Z')
    const min = 60_000
    const tasks = new Map([
      ['tests', { at: now - 5 * min }],
      ['server', { at: now - 61 * min }],
      ['monitor', { at: now - 2 * min, expiresAt: now - 1 }],
      ['watch', { at: now - 2 * min, expiresAt: now + 10 * min }]
    ])
    expect(expireTasks(tasks, now, 60)).toEqual(['server'])
    expect([...tasks.keys()]).toEqual(['tests', 'watch'])
    expect(expireTasks(tasks, now, 60)).toEqual([])
    // At exactly the limit it stops counting.
    expect(expireTasks(new Map([['a', { at: now - 10 * min }]]), now, 10)).toEqual(['a'])
  })
})

describe("a CLI's start, read from its screen (#679)", () => {
  const copilot = { readyOutput: /· \/ commands ·/, startupQuestion: /Do you trust the files in this folder\?/ }
  const claude = { readyOutput: null, startupQuestion: /Do you trust the files in this folder\?/ }
  const footer = '← open sidebar · Interactive · Manual Approval · / commands · ? help'
  const trust = 'Confirm folder trust … Do you trust the files in this folder? ❯ 1. Yes'
  const state = (status: SessionStatus, extra: { askedAtStart?: boolean; settled?: boolean } = {}) => ({ status, askedAtStart: false, settled: false, ...extra })

  it('starting: its question makes it wait, its prompt makes it ready', async () => {
    const { startupScreen } = await import('../src/main/hookStatus')
    expect(startupScreen(state('starting'), trust, copilot)).toEqual({ asked: 'Do you trust the files in this folder?' })
    expect(startupScreen(state('starting'), footer, copilot)).toBe('ready')
    // Both on screen: the question wins (it is drawn over the prompt).
    expect(startupScreen(state('starting'), `${footer} ${trust}`, copilot)).toEqual({ asked: 'Do you trust the files in this folder?' })
    expect(startupScreen(state('starting'), 'Loading…', copilot)).toBeNull()
  })

  it('its question after its prompt was drawn still makes it wait, until it has taken a prompt', async () => {
    const { startupScreen, startupWatched } = await import('../src/main/hookStatus')
    expect(startupScreen(state('ready'), trust, copilot)).toEqual({ asked: 'Do you trust the files in this folder?' })
    expect(startupScreen(state('ready'), footer, copilot)).toBeNull()
    expect(startupWatched(state('ready', { settled: true }), copilot)).toBe(false)
    expect(startupScreen(state('ready', { settled: true }), trust, copilot)).toBeNull()
    // Working or finished: a turn's text is never read as its start.
    expect(startupScreen(state('working'), trust, copilot)).toBeNull()
    expect(startupScreen(state('finished'), trust, copilot)).toBeNull()
  })

  it('asked: only its prompt counts (answered), and then nothing more', async () => {
    const { startupScreen, startupWatched } = await import('../src/main/hookStatus')
    expect(startupScreen(state('waiting', { askedAtStart: true }), `${trust} ${footer}`, copilot)).toBe('ready')
    expect(startupScreen(state('waiting', { askedAtStart: true }), trust, copilot)).toBeNull()
    expect(startupWatched(state('ready', { settled: true }), copilot)).toBe(false)
  })

  it('a CLI whose start a hook reports: its question only while starting, as before', async () => {
    const { startupScreen, startupWatched } = await import('../src/main/hookStatus')
    expect(startupScreen(state('starting'), trust, claude)).toEqual({ asked: 'Do you trust the files in this folder?' })
    expect(startupWatched(state('ready'), claude)).toBe(false)
    expect(startupScreen(state('ready'), trust, claude)).toBeNull()
    expect(startupWatched(state('starting'), {})).toBe(false)
  })
})
