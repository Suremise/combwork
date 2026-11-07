// The Antigravity CLI's hooks and status line (HI-2545, against agy 1.5.0): Combwork's hooks in the profile (the command
// agy runs through cmd, its quoting), each recorded hook's event, the user-prompt ledger (a turn only for a prompt in the
// transcript: a repeated one is two, a continuation or a later invocation none), the replies, and the status line.
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-agy-hooks-')
process.env.CW_USER_DATA = join(base, 'userdata')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { AGY_EVENTS, USER_STEP, UserSteps, addUserStep, agyHooks, agyLockReply, agyNoticeReply, agyStartContextReply, agyStatusAsk, agyStatusDetails, agyStopContinues, isProfileTranscript, newestUserStep, normalizeAgyHook, profileTranscript, userRequestText } = await import('../src/main/providers/antigravity/hooks')
const { brainDir } = await import('../src/main/providers/antigravity/home')
const { launchSettings } = await import('../src/main/providers/antigravity/adapter')
const { admit, newLedger } = await import('../src/main/turnLedger')
const { TOOLS_SERVER } = await import('../src/shared/assistantTools')

const FIX = join(__dirname, 'fixtures', 'advanced')
const HOOKS: Record<string, Record<string, any>> = JSON.parse(readFileSync(join(FIX, 'hooks-antigravity-1.5.0.json'), 'utf8'))
/** A recorded hook as Combwork's server passes it on: its event named from the URL. */
const hook = (event: string, extra: Record<string, unknown> = {}): Record<string, any> => ({ ...structuredClone(HOOKS[event]), hook_event_name: event, ...extra })
const CONV = HOOKS.Stop.conversationId as string

describe("Combwork's hooks in the agent's profile", () => {
  const url = 'http://127.0.0.1:47822/hook?run=r-1'
  it('one named hook with each event agy has, the tool events under a matcher, each forwarding with the launch token', () => {
    const h = agyHooks(url, 'C:\\data\\launches\\r-1\\hook-auth.txt', true).combwork as Record<string, any[]>
    expect(Object.keys(h)).toEqual([...AGY_EVENTS])
    expect(h.SessionStart[0].type).toBe('command')
    expect(h.PreToolUse[0].matcher).toBe('*')
    const cmd = h.PreToolUse[0].hooks[0].command as string
    expect(cmd).toContain('"http://127.0.0.1:47822/hook?run=r-1&event=PreToolUse"')
    expect(cmd).toContain('-H "@C:/data/launches/r-1/hook-auth.txt"')
    expect(cmd).not.toMatch(/Bearer/)
    // agy's limit past curl's own, so curl ends first.
    expect(h.Stop[0].timeout).toBeGreaterThan(Number(/-m (\d+)/.exec(h.Stop[0].command)![1]))
  })
  it('without the tool hooks (its switch, HI-2545 open fact 1): the other events only', () => {
    expect(Object.keys(agyHooks(url, 'a.txt', false).combwork as object)).toEqual(['SessionStart', 'PreInvocation', 'PostInvocation', 'Stop'])
  })
  it('quoting on Windows: a path with spaces and non-ASCII letters stays one argument for cmd /c', () => {
    const auth = 'C:\\Users\\Zoë Ångström\\AppData\\Local\\Combwork\\launches\\r 1\\hook-auth.txt'
    const cmd = ((agyHooks(url, auth, true).combwork as Record<string, any[]>).Stop[0].command) as string
    expect(cmd).toContain('-H "@C:/Users/Zoë Ångström/AppData/Local/Combwork/launches/r 1/hook-auth.txt"')
    // Nothing cmd would split or expand outside quotes: the URL's & is inside its quotes, and no %.
    const outside = cmd.replace(/"[^"]*"/g, '')
    expect(outside).not.toMatch(/[&%^|<>]/)
  })
  it("the status line runs under agy's own (stack_with_default), and Combwork's tools are allowed as agy writes rules", () => {
    const ctx = { hookUrl: url, hookAuthFile: 'a.txt', mcpServers: { [TOOLS_SERVER]: { command: 'x' } }, trustedCombworkTools: undefined as string[] | undefined }
    const s = launchSettings(ctx, true) as Record<string, any>
    expect(s.statusLine.stack_with_default).toBe(true)
    expect(s.permissions.allow).toEqual([`mcp(${TOOLS_SERVER}/*)`])
    expect((launchSettings({ ...ctx, trustedCombworkTools: ['cw_inbox'] }, true) as any).permissions.allow).toEqual([`mcp(${TOOLS_SERVER}/cw_inbox)`])
  })
})

describe('each recorded hook (agy 1.5.0)', () => {
  it('SessionStart starts; the tool hooks name their call (the conversation step); PostInvocation is no event', () => {
    expect(normalizeAgyHook(hook('SessionStart')).event).toEqual({ kind: 'start', source: null })
    const pre = normalizeAgyHook(hook('PreToolUse'))
    expect(pre.event.kind).toBe('toolStart')
    expect(pre.ids.call).toBe(`${CONV}:2`)
    expect(pre.sessionId).toBe(CONV)
    expect(pre.transcriptPath).toMatch(/transcript_full\.jsonl$/)
    expect(normalizeAgyHook(hook('PostToolUse')).event).toEqual({ kind: 'toolEnd', call: `${CONV}:2` })
    expect(normalizeAgyHook(hook('PostInvocation')).event.kind).toBe('ignore')
  })
  it('PreInvocation is a model call, never a turn by itself: a prompt only with the user step read for it', () => {
    expect(normalizeAgyHook(hook('PreInvocation')).event.kind).toBe('ignore')
    const withStep = normalizeAgyHook(hook('PreInvocation', { [USER_STEP]: { index: 0, text: 'hello' } }))
    expect(withStep.event).toEqual({ kind: 'prompt', text: 'hello' })
    expect(withStep.ids.turn).toBe(`${CONV}:u0`)
  })
  it("Stop ends the turn; agy's own reasons say how: an error or a limit failed, the user's cancel an interrupt", () => {
    expect(normalizeAgyHook(hook('Stop')).event).toEqual({ kind: 'stop', lastMessage: null })
    expect(normalizeAgyHook(hook('Stop', { terminationReason: 'ERROR', error: 'quota exhausted' })).event).toEqual({ kind: 'stop', lastMessage: 'quota exhausted', failed: true })
    expect(normalizeAgyHook(hook('Stop', { terminationReason: 'MAX_INVOCATIONS' })).event).toMatchObject({ kind: 'stop', failed: true })
    expect(normalizeAgyHook(hook('Stop', { terminationReason: 'USER_CANCELED' })).event).toEqual({ kind: 'interrupt' })
  })
  it('an unknown event, or none, is nothing', () => {
    expect(normalizeAgyHook({ ...HOOKS.Stop, hook_event_name: 'Later' }).event.kind).toBe('ignore')
    expect(normalizeAgyHook({}).event.kind).toBe('ignore')
  })
})

describe("the user's prompts, from the transcript (HI-2410's lesson)", () => {
  const recorded = readFileSync(join(__dirname, 'fixtures', 'antigravity', 'plain-1.5.0.jsonl'), 'utf8')
  it("the prompt's text without what agy adds (the advanced pattern)", () => {
    expect(newestUserStep(recorded, 1)).toEqual({ index: 0, text: 'Reply with exactly the word BRAVO and nothing else. Do not use tools.' })
    expect(userRequestText('no wrapper')).toBe('no wrapper')
  })
  it('only steps before the invocation, written by the user; none yet is null', () => {
    expect(newestUserStep(recorded, 0)).toBeNull()
    const model = JSON.stringify({ step_index: 3, source: 'MODEL', type: 'USER_INPUT', content: 'x' })
    expect(newestUserStep(`${recorded}${model}\n`, 9)?.index).toBe(0)
  })

  const profile = join(base, 'agent-profile')
  const dir = join(brainDir(profile), CONV, '.system_generated', 'logs')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'transcript_full.jsonl')
  const step = (i: number, text: string, source = 'USER_EXPLICIT'): string => JSON.stringify({ step_index: i, source, type: 'USER_INPUT', status: 'DONE', content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: now.\n</ADDITIONAL_METADATA>` }) + '\n'
  const reply = (i: number): string => JSON.stringify({ step_index: i, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'OK' }) + '\n'
  const pre = (initialNumSteps: number, invocationNum = 0, extra: Record<string, unknown> = {}): Record<string, any> => ({ ...hook('PreInvocation'), transcriptPath: profileTranscript(profile, CONV), initialNumSteps, invocationNum, ...extra })

  it('read only from this agent’s own profile: a path a hook names elsewhere, or another conversation, is not read', () => {
    expect(isProfileTranscript(profileTranscript(profile, CONV), profile, CONV)).toBe(true)
    expect(isProfileTranscript(join(base, 'elsewhere', 'transcript_full.jsonl'), profile, CONV)).toBe(false)
    expect(profileTranscript(profile, '..\\..\\x')).toBeNull()
  })

  it('a turn per prompt: two identical prompts are two turns; a continuation and later model calls are none', async () => {
    writeFileSync(file, step(0, 'Reply with OK.') + reply(1))
    const taken = new UserSteps()
    const ledger = newLedger(0)
    const feed = async (body: Record<string, any>, now: number): Promise<string> => {
      await addUserStep(body, profile, CONV, taken, 0)
      const h = normalizeAgyHook(body)
      const a = admit(ledger, h.event, h.ids, { now })
      return `${h.event.kind}:${a.verdict}`
    }
    // The first prompt: its first model call begins the turn; a later call in the same execution is no prompt.
    expect(await feed(pre(1), 1)).toBe('prompt:apply')
    expect(await feed(pre(3, 1), 2)).toBe('ignore:apply')
    expect(await feed(hook('Stop'), 3)).toBe('stop:apply')
    // Combwork's Stop reply carried it on (a continuation): agy calls the model again, a new execution, no new user step.
    expect(await feed(pre(2), 4)).toBe('ignore:apply')
    expect(await feed(hook('Stop'), 5)).toBe('stop:apply')
    // The same words again, typed again: a new step, so a new turn.
    appendFileSync(file, step(2, 'Reply with OK.') + reply(3))
    expect(await feed(pre(3), 6)).toBe('prompt:apply')
    expect(ledger.active?.id).toBe(`${CONV}:u2`)
    // A step agy wrote for itself after the prompt (not the user's) doesn't make the prompt older or newer.
    appendFileSync(file, step(4, 'injected', 'SYSTEM'))
    expect(await feed(pre(5), 7)).toBe('ignore:apply')
  })

  it("another conversation's model call (a sub-agent's, while the launch has its own) is never the user's prompt", async () => {
    const taken = new UserSteps()
    const body = pre(1, 0, { conversationId: '11111111-2222-4333-8444-555555555555' })
    await addUserStep(body, profile, CONV, taken, 0)
    expect(body[USER_STEP]).toBeUndefined()
  })

  it('a prompt not on disk yet is read again within the wait; still missing, it is no turn (never guessed)', async () => {
    const conv = '22222222-3333-4444-8555-666666666666'
    const d2 = join(brainDir(profile), conv, '.system_generated', 'logs')
    mkdirSync(d2, { recursive: true })
    const f2 = join(d2, 'transcript_full.jsonl')
    writeFileSync(f2, '')
    const body: Record<string, any> = { ...pre(1), conversationId: conv, transcriptPath: f2 }
    await addUserStep(body, profile, null, new UserSteps(), 50)
    expect(body[USER_STEP]).toBeUndefined()
    const later: Record<string, any> = { ...pre(1), conversationId: conv, transcriptPath: f2 }
    setTimeout(() => writeFileSync(f2, step(0, 'late')), 100)
    await addUserStep(later, profile, null, new UserSteps(), 3000)
    expect(later[USER_STEP]).toEqual({ index: 0, text: 'late' })
  })
})

describe("Combwork's replies, in agy's form (hooks.md)", () => {
  it('a locked file: refused, or always asked (never an "allow" that would skip the mode); a warning has no place', () => {
    expect(agyLockReply({ kind: 'deny', reason: 'locked' })).toEqual({ decision: 'deny', reason: 'locked' })
    expect(agyLockReply({ kind: 'ask', reason: 'locked' })).toEqual({ decision: 'force_ask', reason: 'locked' })
    expect(agyLockReply({ kind: 'warn', context: 'note' })).toEqual({})
  })
  it('a notice before the next model call, or carrying the turn on at its Stop; none after a tool', () => {
    expect(agyNoticeReply('PreInvocation', 'n')).toEqual({ injectSteps: [{ ephemeralMessage: 'n' }] })
    expect(agyNoticeReply('Stop', 'n')).toEqual({ decision: 'continue', reason: 'n' })
    expect(agyNoticeReply('PostToolUse', 'n')).toBeNull()
    expect(agyStopContinues({ decision: 'continue' })).toBe(true)
    expect(agyStopContinues({})).toBe(false)
    expect(agyStartContextReply('ctx')).toEqual({ injectSteps: [{ systemMessage: { systemMessage: 'ctx' } }] })
  })
})

describe('the status line (agy 1.5.0, recorded)', () => {
  const lines = readFileSync(join(FIX, 'statusline-antigravity-1.5.0.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  it('the model by its name, its effort and the context window; no prompt pending', () => {
    expect(agyStatusDetails(lines[1])).toEqual({ modelName: 'Gemini 3.8 Flash (Low)', effort: 'low', contextWindow: 1048576 })
    expect(agyStatusDetails(lines[0])).toEqual({})
    expect(agyStatusAsk(lines[1])).toBeNull()
  })
  it('a permission prompt it shows: "waiting for you", blocking (Combwork never answers it)', () => {
    expect(agyStatusAsk({ ...lines[1], tool_confirmation_pending: true })).toEqual({ kind: 'permission', blocking: true, message: '' })
  })
})
