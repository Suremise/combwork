// Codex's offer of a cheaper model near the account's limit (HI-2609): "Approaching rate limits", its first choice
// ("Switch to gpt-6-luna") selected, which Enter takes. A wake typed into it answered it, and agents ran gpt-6-luna on
// connections that said otherwise. Combwork turns the offer off for each launch (an advanced switch), reads it on the
// screen as a question by itself (the agent waits, nothing is typed), and marks any model a session runs that its launch
// didn't give it, by model ID, never by a display name.
import { readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { codex, codexIdleQuestion } from '../src/main/providers/codex/adapter'
import { rolloutDetails } from '../src/main/providers/codex/rollout'
import { TerminalScreen } from '../src/main/terminalScreen'
import { sessions } from '../src/main/sessions'
import * as pty from '../src/main/ptyHost'
import * as events from '../src/main/events'
import * as writer from '../src/main/lineWriter'
import { advanced } from '../src/main/advanced'
import { MODEL_ID_EQUIVALENT_SUFFIXES, modelIdentity, modelSwitched } from '../src/shared/models'
import type { AgentInstallInfo, ModelCatalog } from '../src/shared/types'
import { tempDir } from './tempDir'

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8').replace(/\r\n/g, '\n')
const NUDGE = fixture('advanced/ratelimit-nudge-codex-0.166.0.txt')
const IDLE = fixture('screen-codex-0.162.1-idle.txt')
const TITLE = 'Approaching rate limits'
/** The offer's view as the fixture draws it, from its title down. */
const VIEW = NUDGE.slice(NUDGE.indexOf(`  ${TITLE}`)).trimEnd()
const INPUT = '› Ask Codex to do anything\n\n  GPT-6-Astra low · C:\\work\\alpha\n  ? for shortcuts'
/** The fixture with choice n selected (HR2's round 2): "›" moved to its row. */
const selecting = (n: number): string => NUDGE.replace('› 1. Switch', '  1. Switch').replace(new RegExp(`^  ${n}\\. `, 'm'), `› ${n}. `)

describe("Codex's offer of a cheaper model, on its screen (0.166.0)", () => {
  it('reads it from the composed screen: its title, with its first choice selected ("› 1. …", not an input line)', () => {
    expect(codexIdleQuestion(NUDGE)).toBe(TITLE)
    // Another choice selected, and the view drawn alone (nothing above it).
    expect(codexIdleQuestion(NUDGE.replace('› 1. Switch', '  1. Switch').replace('  2. Keep current model', '› 2. Keep current model'))).toBe(TITLE)
    expect(codexIdleQuestion(VIEW)).toBe(TITLE)
  })

  it("reads it whichever choice is selected, and with a choice's text wrapped (HR2's round 2)", () => {
    for (const n of [1, 2, 3]) expect(codexIdleQuestion(selecting(n)), `choice ${n}`).toBe(TITLE)
    // A narrow pane: a choice's description wrapped onto lines of their own, above and below the selected row.
    const wrapped = `  ${TITLE}\n  Switch to gpt-6-luna for lower credit usage?\n\n  1. Switch to gpt-6-luna   Uses fewer credits for\n                            upcoming turns.\n  2. Keep current model\n› 3. Keep current model (never show\n     again)`
    expect(codexIdleQuestion(wrapped)).toBe(TITLE)
  })

  it('is none on an idle or a working screen, or with its title and no choice of it', () => {
    expect(codexIdleQuestion(IDLE)).toBeNull()
    expect(codexIdleQuestion(fixture('screen-codex-0.162.1-working.txt'))).toBeNull()
    expect(codexIdleQuestion(`• ${TITLE}: Codex may offer gpt-6-luna.\n`)).toBeNull()
  })

  it("isn't fooled by its words above a real input line: a reply, a prompt, or what is left of a view answered", () => {
    // A reply quoting the whole view, Codex's input drawn under it.
    expect(codexIdleQuestion(`${VIEW.replace('› 1.', '  1.')}\n\n${INPUT}`)).toBeNull()
    // The view itself above the input: drawn over by the conversation since, as fullaccess-codex-0.162.1.txt was.
    expect(codexIdleQuestion(`${VIEW}\n\n• Model changed to gpt-6-luna medium.\n\n${INPUT}`)).toBeNull()
    // Typed into the input (a prompt about it), on one line or wrapped onto two.
    expect(codexIdleQuestion(`• Done.\n\n› ${TITLE}: 2. Keep current model\n\n  GPT-6-Astra low · C:\\work\\alpha`)).toBeNull()
  })

  it("isn't fooled by a draft in Codex's input, however it wraps or is numbered (HR2's round 1)", () => {
    const FOOTER = '\n\n  GPT-6-Astra low · C:\\work\\alpha\n  ? for shortcuts'
    for (const draft of [
      // Several lines: its title and a choice on lines of their own.
      `› Explain this Codex prompt:\n  ${TITLE}\n  2. Keep current model`,
      // Numbered: its first line looks like a selected row, with the title in it.
      `› 1. Explain ${TITLE}\n  2. Keep current model`,
      // Numbered, the title on a line of its own below the first.
      `› 1. Explain this:\n  ${TITLE}\n  2. Keep current model`,
      // Wrapped onto a blank line and on.
      `› Explain:\n\n  ${TITLE}\n\n  2. Keep current model`
    ]) {
      expect(codexIdleQuestion(`• Done.\n\n${draft}${FOOTER}`), draft).toBeNull()
      expect(codexIdleQuestion(`• Done.\n\n${draft}`), draft).toBeNull()
    }
    // A numbered draft under a reply that quotes the title: the title is the reply's, not a view's.
    expect(codexIdleQuestion(`• Codex may show:\n  ${TITLE}\n\n› 1. Fix it\n  2. Keep current model${FOOTER}`)).toBeNull()
  })

  it('both texts are advanced settings: another wording is read once they say it', () => {
    const real = advanced.pattern.bind(advanced)
    const spy = vi.spyOn(advanced, 'pattern').mockImplementation(((id: string) => (id === 'codex.screen.idleQuestion' ? /Credit limit near/i : id === 'codex.screen.idleQuestionChoice' ? /\b\d\.\s+Stay\b/i : real(id))) as typeof advanced.pattern)
    try {
      expect(codexIdleQuestion(NUDGE)).toBeNull()
      expect(codexIdleQuestion('  Credit limit near\n\n› 1. Switch\n  2. Stay')).toBe('Credit limit near')
    } finally {
      spy.mockRestore()
    }
  })
})

// The real SessionManager, an agent's live state made by hand (as idleQuestion.test.ts), its screen a real TerminalScreen.
const project = 'C:/fake-ws/alpha'
const id = 'a1'
const key = `${project.toLowerCase()}#${id}`
type Entry = Record<string, unknown> & { state: Record<string, unknown>; prompts: number; screen: TerminalScreen }
const live = (sessions as unknown as { live: Map<string, Entry> }).live
const internals = sessions as unknown as { lookAtIdleScreen(id: string, l: Entry): void; notify: (...a: unknown[]) => void; applyDetails(l: Entry, d: Record<string, unknown>): void }
const liveKey = (): string => [...live.keys()].find((k) => live.get(k)?.state.agentId === id) ?? ''
const STARTED = '2026-11-05T21:37:20.000Z'

function running(status = 'ready', state: Record<string, unknown> = {}): Entry {
  const screen = new TerminalScreen(120, 40)
  const e: Entry = { state: { projectPath: project, agentId: id, agentName: 'CB1', runId: 'run1', status, open: [], provider: 'codex', startedAt: STARTED, ...state }, prompts: 0, screen, adapter: codex }
  live.set(key, e)
  return e
}
const draw = (e: Entry, text: string): Promise<void> => new Promise((r) => e.screen.write(`\x1b[2J\x1b[H${text.replace(/\n/g, '\r\n')}`, r))

describe('a Codex agent and its offer of a cheaper model (HI-2609)', () => {
  afterEach(() => {
    const e = live.get(key)
    e?.screen.dispose()
    live.delete(key)
    vi.restoreAllMocks()
  })

  it('nothing is typed into it and no Enter pressed: a wake is refused with why, and goes once the offer is answered', async () => {
    const writes: string[] = []
    vi.spyOn(pty, 'writePty').mockImplementation((_k, data) => void writes.push(data))
    const e = running()
    await draw(e, NUDGE)
    expect(sessions.cliAsks(project, id)).toBe(true)
    await expect(sessions.sendPrompt(project, id, '[CW] New in your inbox: 1 card event (HI-12)')).rejects.toThrow(/shows a question for you/)
    expect(sessions.submitAgain(project, id, 'run1')).toBe(false)
    expect(writer.whyNoLine(project, id)).toMatch(/shows a question for the user/)
    expect(writes).toEqual([])
    // Answered by the user (Keep current model): Codex's input again.
    await draw(e, IDLE)
    expect(sessions.cliAsks(project, id)).toBe(false)
  })

  it("whichever choice is selected, the agent waits and nothing is typed or pressed (HR2's round 2)", async () => {
    vi.spyOn(internals, 'notify').mockImplementation(() => undefined)
    const writes: string[] = []
    vi.spyOn(pty, 'writePty').mockImplementation((_k, data) => void writes.push(data))
    for (const n of [1, 2, 3]) {
      const e = running('finished')
      await draw(e, selecting(n))
      // Before its status says so (the screen read first), every way of typing is refused for the question itself.
      expect(sessions.cliAsks(project, id), `choice ${n}`).toBe(true)
      await expect(sessions.sendPrompt(project, id, '[CW] New in your inbox: 1 card event (HI-12)'), `choice ${n}`).rejects.toThrow(/shows a question for you/)
      expect(sessions.submitAgain(project, id, 'run1'), `choice ${n}`).toBe(false)
      expect(writer.whyNoLine(project, id), `choice ${n}`).toMatch(/shows a question for the user/)
      // Then the agent waits for the user with it.
      internals.lookAtIdleScreen(liveKey(), e)
      expect(e.state.status, `choice ${n}`).toBe('waiting')
      e.screen.dispose()
      live.delete(key)
    }
    expect(writes).toEqual([])
  })

  it("a draft with the offer's words in Codex's input is no question: the agent stays idle, and typing goes on (HR2's round 1)", async () => {
    vi.spyOn(internals, 'notify').mockImplementation(() => undefined)
    for (const draft of [`› Explain this Codex prompt:\n  ${TITLE}\n  2. Keep current model`, `› 1. Explain ${TITLE}\n  2. Keep current model`]) {
      const e = running('finished')
      await draw(e, `• Done.\n\n${draft}\n\n  GPT-6-Astra low · C:\\work\\alpha`)
      expect(sessions.cliAsks(project, id), draft).toBe(false)
      internals.lookAtIdleScreen(liveKey(), e)
      expect(e.state.status, draft).toBe('finished')
      expect(writer.whyNoLine(project, id) ?? '', draft).not.toMatch(/shows a question/)
      e.screen.dispose()
      live.delete(key)
    }
  })

  it('the agent waits for the user with it while it shows ("Codex asks: …"), and is idle again once it is gone', async () => {
    vi.spyOn(internals, 'notify').mockImplementation(() => undefined)
    const e = running('finished')
    await draw(e, NUDGE)
    internals.lookAtIdleScreen(liveKey(), e)
    expect(e.state.status).toBe('waiting')
    expect(String(e.state.statusMessage ?? '')).toBe(`Codex asks: ${TITLE}`)
    await draw(e, IDLE)
    internals.lookAtIdleScreen(liveKey(), e)
    expect(e.state.status).toBe('ready')
  })

  it("waits for the user even where Codex's terminal title says when one must act, and it doesn't say so here", async () => {
    vi.spyOn(internals, 'notify').mockImplementation(() => undefined)
    const e = running('finished')
    e.titleAttention = (title: string) => /^\[ [!.] \] Action Required\b/.test(title)
    await draw(e, NUDGE)
    internals.lookAtIdleScreen(liveKey(), e)
    expect(e.state.status).toBe('waiting')
  })

  it('reports another model than its launch gave it, once its record is of this launch: marked, and told once a launch', () => {
    const told = vi.spyOn(events, 'toast').mockImplementation(() => ({}) as never)
    const e = running('ready', { launchedWith: { model: 'gpt-6-astra', effort: 'low', own: true }, modelId: 'gpt-6-astra' })
    // A resumed rollout's earlier turn on another model: no switch of this launch.
    internals.applyDetails(e, { modelId: 'gpt-6-luna', modelName: 'gpt-6-luna', modelAt: '2026-11-05T20:00:00.000Z' })
    expect(e.state.modelSwitch).toBeUndefined()
    expect(told).not.toHaveBeenCalled()
    // Its own model again, then the offer taken (21:42:36, CB1's rollout).
    internals.applyDetails(e, { modelId: 'gpt-6-astra', modelName: 'gpt-6-astra', modelAt: '2026-11-05T21:37:21.000Z' })
    internals.applyDetails(e, { modelId: 'gpt-6-luna', modelName: 'gpt-6-luna', modelAt: '2026-11-05T21:42:36.000Z' })
    expect(e.state.modelSwitch).toMatchObject({ launched: 'gpt-6-astra', running: 'gpt-6-luna' })
    expect(told).toHaveBeenCalledTimes(1)
    expect(String(told.mock.calls[0][1])).toMatch(/CB1 runs another model/)
    expect(String(told.mock.calls[0][2])).toMatch(/now runs .*Luna.*, not .*Astra/i)
    // Back on its own model: no longer marked. Switched again in the same launch: marked, not told again.
    internals.applyDetails(e, { modelId: 'gpt-6-astra', modelName: 'gpt-6-astra', modelAt: '2026-11-05T21:50:00.000Z' })
    expect(e.state.modelSwitch).toBeUndefined()
    internals.applyDetails(e, { modelId: 'gpt-6-luna', modelName: 'gpt-6-luna', modelAt: '2026-11-05T21:55:00.000Z' })
    expect(e.state.modelSwitch).toMatchObject({ running: 'gpt-6-luna' })
    expect(told).toHaveBeenCalledTimes(1)
  })

  it("decides nothing for a launch on its CLI's default, or on a server connection", () => {
    const told = vi.spyOn(events, 'toast').mockImplementation(() => ({}) as never)
    const e = running('ready', { launchedWith: { model: null, effort: null } })
    internals.applyDetails(e, { modelId: 'gpt-6-luna', modelName: 'gpt-6-luna' })
    expect(e.state.modelSwitch).toBeUndefined()
    live.delete(key)
    e.screen.dispose()
    const s = running('ready', { launchedWith: { model: 'qwen3:32b', effort: null, own: true }, launchedConnection: { id: 'c1', name: 'Local', server: { models: [] } } })
    internals.applyDetails(s, { modelId: 'claude-opus-5-5', modelName: 'claude-opus-5-5' })
    expect(s.state.modelSwitch).toBeUndefined()
    expect(told).not.toHaveBeenCalled()
  })
})

describe("a Codex launch's arguments: the offer turned off (HI-2609)", () => {
  const launch = (extraArgs: string[] = []): string[] => {
    const home = tempDir('cw-codex-nudge-')
    const before = process.env.CODEX_HOME
    process.env.CODEX_HOME = home
    try {
      const ctx = {
        projectPath: home, agentId: 'a-1', executable: 'C:\\bin\\codex.exe', cwd: 'C:\\work\\alpha', workspacePath: home, runId: 'r', sessionId: '',
        resume: false, name: '', skills: [], mcpServers: {}, model: 'gpt-6-astra', effort: null, permissionMode: null, extraArgs, hookUrl: 'http://127.0.0.1:1/hook?run=r', hookAuthFile: 'C:/hive/hook-auth/r.txt', privateDir: 'C:/hive/launches/r', guidance: '', env: {}, allowBackgroundSessions: false, use200kContext: false
      }
      return codex.buildCommand(ctx.executable, ctx as never).args
    } finally {
      if (before === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = before
      rmSync(home, { recursive: true, force: true })
    }
  }
  const NUDGE_OFF = 'notice.hide_rate_limit_model_nudge=true'

  it("on by default: its -c for the launch, before the user's own arguments (the last -c wins in Codex)", () => {
    expect(advanced.get<boolean>('codex.rateLimitNudge.hide')).toBe(true)
    const args = launch(['-c', 'notice.hide_rate_limit_model_nudge=false'])
    const i = args.indexOf(NUDGE_OFF)
    expect(args[i - 1]).toBe('-c')
    expect(i).toBeLessThan(args.lastIndexOf('notice.hide_rate_limit_model_nudge=false'))
  })

  it('off: no -c of it', () => {
    const real = advanced.get.bind(advanced)
    vi.spyOn(advanced, 'get').mockImplementation(((name: string) => (name === 'codex.rateLimitNudge.hide' ? false : real(name))) as typeof advanced.get)
    try {
      expect(launch()).not.toContain(NUDGE_OFF)
    } finally {
      vi.restoreAllMocks()
    }
  })
})

describe("Codex's rollout: when its model was recorded (HI-2609)", () => {
  it("gives the time of the record that named the model: thread settings applied or a turn's context", () => {
    const line = (o: unknown): string => JSON.stringify(o)
    const text = [
      line({ timestamp: '2026-11-05T21:37:21.000Z', type: 'turn_context', payload: { model: 'gpt-6-astra', effort: 'low' } }),
      line({ timestamp: '2026-11-05T21:42:36.000Z', type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-luna' } } })
    ].join('\n')
    expect(rolloutDetails(text)).toMatchObject({ modelId: 'gpt-6-luna', modelAt: '2026-11-05T21:42:36.000Z' })
    expect(rolloutDetails(text.split('\n')[0])).toMatchObject({ modelId: 'gpt-6-astra', modelAt: '2026-11-05T21:37:21.000Z' })
    expect(rolloutDetails(line({ type: 'turn_context', payload: { model: 'gpt-6-astra' } })).modelAt).toBeUndefined()
  })
})

describe('a model other than the launch gave it (modelSwitched, HI-2609)', () => {
  const info = (models: ModelCatalog['models']): Pick<AgentInstallInfo, 'catalog' | 'configuredEffort' | 'observedEfforts' | 'defaultModel'> => ({ catalog: { source: 'cli', version: '1', models, at: '' } })
  const own = (model: string) => ({ model, own: true as const })

  it('is a switch between two IDs, even when the catalogue gives them one name', () => {
    const same = info([
      { value: 'gpt-6-astra', label: 'GPT-6' },
      { value: 'gpt-6-luna', label: 'GPT-6' }
    ])
    expect(modelSwitched('codex', own('gpt-6-astra'), 'gpt-6-luna', same)).toEqual({ launched: 'gpt-6-astra', running: 'gpt-6-luna' })
    expect(modelSwitched('codex', own('gpt-6-astra'), 'gpt-6-luna', null)).toEqual({ launched: 'gpt-6-astra', running: 'gpt-6-luna' })
  })

  it("is none for one ID whatever it is called: a label changed, another case, the CLI's context suffix", () => {
    for (const label of ['GPT-6 Astra', 'Astra (renamed)']) expect(modelSwitched('codex', own('gpt-6-astra'), 'gpt-6-astra', info([{ value: 'gpt-6-astra', label }]))).toBeNull()
    expect(modelSwitched('codex', own('GPT-6-Astra'), 'gpt-6-astra', null)).toBeNull()
    expect(modelSwitched('claude-code', own('claude-opus-5-5'), 'claude-opus-5-5[1m]', null)).toBeNull()
    expect(modelIdentity(' Claude-Opus-5-5[1m] ')).toBe('claude-opus-5-5')
  })

  it('is another model for another snapshot date or an unlisted suffix: only the listed ones are the same model (HR2)', () => {
    expect(MODEL_ID_EQUIVALENT_SUFFIXES).toEqual(['[1m]'])
    expect(modelSwitched('claude-code', own('claude-opus-5-5'), 'claude-opus-5-5-20261015', null)).toEqual({ launched: 'claude-opus-5-5', running: 'claude-opus-5-5-20261015' })
    expect(modelSwitched('codex', own('gpt-6-astra'), 'gpt-6-astra[preview]', null)).toEqual({ launched: 'gpt-6-astra', running: 'gpt-6-astra[preview]' })
    expect(modelIdentity('gpt-6-astra[preview]')).not.toBe(modelIdentity('gpt-6-astra[beta]'))
    expect(modelIdentity('gpt-6-astra[preview]')).toBe('gpt-6-astra[preview]')
  })

  it('resolves an alias through the catalogue first, and decides nothing for one it cannot resolve', () => {
    const claude = info([{ value: 'opus', label: 'Opus', resolved: 'claude-opus-5-5' }])
    expect(modelSwitched('claude-code', own('opus'), 'claude-opus-5-5', claude)).toBeNull()
    expect(modelSwitched('claude-code', own('opus[1m]'), 'claude-opus-5-5[1m]', claude)).toBeNull()
    expect(modelSwitched('claude-code', own('opus'), 'claude-sonnet-5-5', claude)).toEqual({ launched: 'claude-opus-5-5', running: 'claude-sonnet-5-5' })
    expect(modelSwitched('claude-code', own('opus'), 'claude-sonnet-5-5', null)).toBeNull()
  })

  it("decides nothing on the CLI's default, a model not its own, or nothing reported", () => {
    expect(modelSwitched('codex', { model: null }, 'gpt-6-luna', null)).toBeNull()
    expect(modelSwitched('codex', { model: 'gpt-6-astra' }, 'gpt-6-luna', null)).toBeNull()
    expect(modelSwitched('codex', own('gpt-6-astra'), '', null)).toBeNull()
    expect(modelSwitched('codex', undefined, 'gpt-6-luna', null)).toBeNull()
  })
})
