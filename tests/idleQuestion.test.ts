// Claude Code 2.1.312's offer to teach auto mode about the environment (HI-1959): a question it puts on its screen by
// itself after a turn, with no hook. HB4's wake was typed into it, Hive's Enter again answered it, and the line it took
// left the agent held behind an empty input. The adapter reads the question and its input box from recorded screens;
// with the real SessionManager and the terminal's writes caught, the agent waits for the user with the question, nothing
// is typed or pressed meanwhile, and a held line gone from the input is let go only on a second look that says the same.
import { readFileSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { claudeCode } from '../src/main/providers/claude/adapter'
import { heldLineLost, type HeldLook } from '../src/main/heldLine'
import { hookStep, idleQuestionGone } from '../src/main/hookStatus'
import { TerminalScreen } from '../src/main/terminalScreen'
import { sessions } from '../src/main/sessions'
import * as pty from '../src/main/ptyHost'
import * as writer from '../src/main/lineWriter'
import { advanced } from '../src/main/advanced'
import { ADVANCED_DEFS } from '../src/shared/advanced'
import { tempDir } from './tempDir'

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8').replace(/\r\n/g, '\n')
const QUESTION = 'Teach auto mode about your environment?'
/** The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take. */
const HUNG_MS = 10_000
const RULE = '─'.repeat(60)

describe("Claude Code's question by itself and its input box, on its screen (2.1.312)", () => {
  it('reads the question from both of its dialogs, and none from an idle screen, a typed line or a safeguard prompt', () => {
    expect(claudeCode.idleQuestion(fixture('advanced/envsetup-claude-2.1.312.txt'))).toBe(QUESTION)
    expect(claudeCode.idleQuestion(fixture('advanced/envsetup-offer-claude-2.1.312.txt'))).toBe(QUESTION)
    expect(claudeCode.idleQuestion(fixture('screen-claude-2.1.296-idle.txt'))).toBeNull()
    expect(claudeCode.idleQuestion(fixture('advanced/input-claude-2.1.312.txt'))).toBeNull()
    expect(claudeCode.idleQuestion(fixture('advanced/safeguard-prompt-claude-2.1.296.txt'))).toBeNull()
  })

  it("isn't fooled by the question's words in a prompt or a reply: the dialog replaces the input box (HR3's round 1)", () => {
    // Typed into the input (a prompt about this very feature), whole or as a line of its own.
    expect(claudeCode.idleQuestion(`${RULE}\n❯ Explain: ${QUESTION}\n${RULE}\n  ⏵⏵ auto mode on`)).toBeNull()
    expect(claudeCode.idleQuestion(`${RULE}\n❯ Explain this dialog:\n  ${QUESTION}\n${RULE}`)).toBeNull()
    // Quoted in a reply, on a line of its own, with the input box under it.
    expect(claudeCode.idleQuestion(`● Claude Code may ask:\n\n  ${QUESTION}\n\n  It reads your project first.\n\n${RULE}\n❯ \n${RULE}\n  ⏵⏵ auto mode on`)).toBeNull()
    // Within a line of a reply: never the dialog's title.
    expect(claudeCode.idleQuestion(`● It asked "${QUESTION}" after the turn.`)).toBeNull()
  })

  it('reads the question 2.1.314 draws under its input box and footer, the empty box still above it (HI-2191, recorded)', () => {
    const offer = fixture('advanced/envsetup-offer-claude-2.1.314.txt')
    expect(claudeCode.promptText(offer)).toBe('')
    expect(claudeCode.idleQuestion(offer)).toBe(QUESTION)
    // Its words quoted in a reply above the box, with the dialog under it too: the dialog's.
    expect(claudeCode.idleQuestion(`● Claude Code may ask:\n\n  ${QUESTION}\n\n${offer}`)).toBe(QUESTION)
    // The dialog answered (gone from under the box): the quote above the box alone is no question.
    const answered = offer.slice(0, offer.indexOf(`  ${QUESTION}`))
    expect(claudeCode.idleQuestion(`● Claude Code may ask:\n\n  ${QUESTION}\n\n${answered}`)).toBeNull()
  })

  it("reads what its input holds: the recorded line, an empty box, wrapped rows joined; none under a dialog or a menu's ❯", () => {
    expect(claudeCode.promptText(fixture('advanced/input-claude-2.1.312.txt'))).toBe('hive wake line typed and not sent')
    expect(claudeCode.promptText(fixture('screen-claude-2.1.296-idle.txt'))).toBe('')
    expect(claudeCode.promptText(`${RULE}\n❯ [CW] New in your inbox: 1 task (HI-1959)\n  (m21559). Call cw_inbox to read it\n${RULE}\n  ⏵⏵ auto mode on`)).toBe('[CW] New in your inbox: 1 task (HI-1959) (m21559). Call cw_inbox to read it')
    // The last box drawn is the input: an earlier one scrolled up is not.
    expect(claudeCode.promptText(`${RULE}\n❯ old\n${RULE}\nsome output\n${RULE}\n❯\n${RULE}`)).toBe('')
    expect(claudeCode.promptText(fixture('advanced/envsetup-claude-2.1.312.txt'))).toBeNull()
    expect(claudeCode.promptText(fixture('advanced/safeguard-prompt-claude-2.1.296.txt'))).toBeNull()
    expect(claudeCode.promptText('')).toBeNull()
  })

  it("2.1.312's screens still match what else Hive reads of them: its auto mode footer, its turn's done line", () => {
    const re = (id: string): RegExp => new RegExp(String(ADVANCED_DEFS.find((d) => d.id === id)!.default), ADVANCED_DEFS.find((d) => d.id === id)!.flags ?? '')
    expect(re('claude-code.footer.auto').test(fixture('advanced/input-claude-2.1.312.txt'))).toBe(true)
    expect(re('claude-code.trust.prompt').test(fixture('advanced/input-claude-2.1.312.txt'))).toBe(false)
    expect(re('claude-code.turnScreen.done').test(fixture('advanced/envsetup-claude-2.1.312.txt'))).toBe(true)
    expect(re('claude-code.safeguard.prompt').test(fixture('advanced/envsetup-claude-2.1.312.txt'))).toBe(false)
  })

  it("leaves its dim hint out of the screen it reads the input from: an empty input with Claude Code's hint is empty", () => {
    const screen = new TerminalScreen(80, 6)
    const drawn = new Promise<void>((r) => screen.write(`${RULE}\r\n❯ \x1b[2mTry "how does <filepath> work?"\x1b[22m\r\n${RULE}\r\n`, r))
    return drawn.then(() => {
      expect(screen.text()).toContain('Try "how does')
      expect(screen.textWithoutDim()).not.toContain('Try')
      expect(claudeCode.promptText(screen.text())).toBe('Try "how does <filepath> work?"')
      expect(claudeCode.promptText(screen.textWithoutDim())).toBe('')
      screen.dispose()
    })
  })
})

describe('a held line gone from the input (heldLineLost)', () => {
  const look = (over: Partial<HeldLook> = {}): HeldLook => ({ asked: false, input: '', status: 'ready', takenSince: false, ...over })

  it('is lost only at its prompt, its input drawn and empty, with nothing taken and no question showing', () => {
    expect(heldLineLost(look())).toBe(true)
    for (const status of ['finished', 'background', 'watching'] as const) expect(heldLineLost(look({ status }))).toBe(true)
  })

  it('is no sign of loss under a dialog or a redraw, with the line or the user\'s text in the input, a turn begun, or a prompt taken', () => {
    // A transient blank screen, a dialog or a redraw: no ordinary input drawn.
    expect(heldLineLost(look({ input: null }))).toBe(false)
    // The CLI's question over it: wait for the user.
    expect(heldLineLost(look({ asked: true }))).toBe(false)
    // The line still there (whole or wrapped), or the user's replacement: theirs, never cleared or typed over.
    expect(heldLineLost(look({ input: '[CW] New in your inbox: 1 task (HI-1959)' }))).toBe(false)
    expect(heldLineLost(look({ input: 'my own words' }))).toBe(false)
    // Taken late: a prompt hook, or a delivery it rang for read.
    expect(heldLineLost(look({ takenSince: true }))).toBe(false)
    for (const status of ['working', 'waiting', 'starting', 'stopped'] as const) expect(heldLineLost(look({ status }))).toBe(false)
  })

  it('the question gone, a waiting agent is idle again, nothing open; anything else is left as it is', () => {
    expect(idleQuestionGone({ status: 'waiting', backgroundWakes: false, tasks: 0 } as never)).toMatchObject({ next: 'ready', open: [], waitingOn: null })
    expect(idleQuestionGone({ status: 'waiting', backgroundWakes: true, tasks: 2 } as never)).toMatchObject({ next: 'background' })
    expect(idleQuestionGone({ status: 'working', backgroundWakes: false, tasks: 0 } as never).next).toBeNull()
  })
})

// The real SessionManager, an agent's live state made by hand (wakeTaken.test.ts), its screen a real TerminalScreen.
const project = 'C:/fake-ws/alpha'
const id = 'a1'
const key = `${project.toLowerCase()}#${id}`
type Entry = Record<string, unknown> & { state: Record<string, unknown>; prompts: number; screen: TerminalScreen }
const live = (sessions as unknown as { live: Map<string, Entry> }).live
const internals = sessions as unknown as { lookAtIdleScreen(id: string, l: Entry): void; notify: (...a: unknown[]) => void }
const liveKey = (): string => [...live.keys()].find((k) => live.get(k)?.state.agentId === id) ?? ''

function running(status = 'ready'): Entry {
  const screen = new TerminalScreen(80, 24)
  const e: Entry = { state: { projectPath: project, agentId: id, agentName: 'HB4', runId: 'run1', status, open: [] }, prompts: 0, screen, adapter: claudeCode }
  live.set(key, e)
  return e
}
const draw = (e: Entry, text: string): Promise<void> => new Promise((r) => e.screen.write(`\x1b[2J\x1b[H${text.replace(/\n/g, '\r\n')}`, r))
const look = (e: Entry): void => internals.lookAtIdleScreen(liveKey(), e)
const QUESTION_SCREEN = fixture('advanced/envsetup-claude-2.1.312.txt')
const EMPTY_INPUT = `● done\n\n${RULE}\n❯ \n${RULE}\n  ⏵⏵ auto mode on`
const HELD_INPUT = `● done\n\n${RULE}\n❯ [CW] New in your inbox: 1 task (HI-1959)\n${RULE}\n  ⏵⏵ auto mode on`

describe('the agent and its question by itself (HI-1959)', () => {
  afterEach(() => {
    const e = live.get(key)
    e?.screen.dispose()
    live.delete(key)
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('nothing is typed into the question and no Enter pressed: the agent is refused with why, and so is a line of Hive\'s', async () => {
    const writes: string[] = []
    vi.spyOn(pty, 'writePty').mockImplementation((_k, data) => void writes.push(data))
    const e = running()
    await draw(e, QUESTION_SCREEN)
    expect(sessions.cliAsks(project, id)).toBe(true)
    await expect(sessions.sendPrompt(project, id, '[CW] New in your inbox: 1 task')).rejects.toThrow(/shows a question for you/)
    expect(sessions.submitAgain(project, id, 'run1')).toBe(false)
    expect(writer.whyNoLine(project, id)).toMatch(/shows a question for the user/)
    expect(writes).toEqual([])
    // Gone (the user put it off), typing goes on.
    await draw(e, EMPTY_INPUT)
    expect(sessions.cliAsks(project, id)).toBe(false)
    // Its words in a prompt the user is writing are no question of the CLI's (HR3's round 1).
    await draw(e, `${RULE}\n❯ Explain: ${QUESTION}\n${RULE}`)
    expect(sessions.cliAsks(project, id)).toBe(false)
  })

  it('the agent waits for the user with the question while it shows, and is idle again once it is gone', async () => {
    const notified = vi.spyOn(internals, 'notify').mockImplementation(() => undefined)
    const e = running('finished')
    await draw(e, QUESTION_SCREEN)
    look(e)
    expect(e.state.status).toBe('waiting')
    expect(String(e.state.statusMessage ?? '')).toBe(`Claude Code asks: ${QUESTION}`)
    expect(notified).toHaveBeenCalled()
    // Drawn again with the question: told once.
    const told = notified.mock.calls.length
    look(e)
    expect(notified.mock.calls.length).toBe(told)
    await draw(e, EMPTY_INPUT)
    look(e)
    expect(e.state.status).toBe('ready')
  })

  it("2.1.314's offer drawn before its turn's Stop is carried out, nothing drawn since: seen once the Stop makes it idle (HI-2191)", async () => {
    vi.spyOn(internals, 'notify').mockImplementation(() => undefined)
    const e = running('working')
    e.screen.dispose()
    e.screen = new TerminalScreen(120, 40)
    await draw(e, fixture('advanced/envsetup-offer-claude-2.1.314.txt'))
    look(e)
    expect(e.state.status).toBe('working')
    const ev = { kind: 'stop', lastMessage: 'ok' }
    ;(sessions as unknown as { carryOut(id: string, l: Entry, step: unknown, cause: string, ev: unknown): void }).carryOut(liveKey(), e, hookStep(ev as never, (sessions as unknown as { statusInput(l: Entry): unknown }).statusInput(e) as never), 'Stop', ev)
    await vi.waitFor(() => expect(e.state.status).toBe('waiting'), { timeout: HUNG_MS })
    expect(String(e.state.statusMessage ?? '')).toBe(`Claude Code asks: ${QUESTION}`)
  })

  it('is no question of a working agent: a turn under way is left to its hooks', async () => {
    const e = running('working')
    await draw(e, QUESTION_SCREEN)
    look(e)
    expect(e.state.status).toBe('working')
  })
})

describe('a held line the screen took (HI-1959, the 12:47 comment)', () => {
  afterEach(() => {
    const e = live.get(key)
    if (e) (sessions as unknown as { dropLostLook(l: Entry): void }).dropLostLook(e)
    e?.screen.dispose()
    live.delete(key)
    vi.restoreAllMocks()
  })
  const held = (e: Entry, rangFor: string[] = ['d1']): void => {
    sessions.lineNotTaken(project, id, 'run1', '[CW] New in your inbox: 1 task (HI-1959) (m21559). Call cw_inbox to read it, act on it, then ack it.', true, rangFor)
    expect(e.state.untakenLine).toBeTruthy()
  }
  // The second look, as its timer runs it (hive.lostLine.steadySeconds after the first): its own timer is made too long
  // to run within the test, so each case says when the second look comes.
  const later = (): void => void vi.spyOn(advanced, 'number').mockImplementation(((name: string) => (name === 'hive.lostLine.steadySeconds' ? 3600 : 30)) as typeof advanced.number)
  const secondLook = (e: Entry): void => {
    const seen = e.lostSeen as { since: string } | undefined
    ;(sessions as unknown as { lostLineSteady(id: string, l: Entry, since: string): void }).lostLineSteady(liveKey(), e, seen?.since ?? String((e.state.untakenLine as { since: string } | undefined)?.since))
  }
  const quiet = (): ReturnType<typeof vi.spyOn> => vi.spyOn(internals, 'notify').mockImplementation(() => undefined)

  it('swallowed: an empty input at its prompt, still so on the second look, lets the hold go; its deliveries are offered again', async () => {
    later()
    quiet()
    const e = running()
    // Typed a moment ago (its CLI never took it): pending as well as marked.
    e.typed = { at: Date.now(), prompts: 0, from: 0 }
    held(e)
    await draw(e, EMPTY_INPUT)
    look(e)
    const rang = vi.spyOn(sessions, 'lineLost').mockImplementation(() => undefined)
    // One look isn't enough: it waits for the second.
    expect(e.state.untakenLine).toBeTruthy()
    expect(e.lostSeen).toBeTruthy()
    expect(rang).not.toHaveBeenCalled()
    secondLook(e)
    expect(e.state.untakenLine).toBeUndefined()
    expect(sessions.lineWaiting(project, id)).toBe(false)
    // What it rang for is queued again by the delivery service, for that launch.
    expect(rang).toHaveBeenCalledWith(project, id, 'run1', ['d1'])
  })

  it("kept: a redraw between the looks calls it off; the line or the user's text in the input, or the question, is never seen lost", async () => {
    later()
    quiet()
    const e = running()
    held(e)
    // Seen empty, then a transient blank screen (a redraw) before the second look: called off.
    await draw(e, EMPTY_INPUT)
    look(e)
    await draw(e, '')
    look(e)
    expect(e.lostSeen).toBeUndefined()
    secondLook(e)
    expect(e.state.untakenLine).toBeTruthy()
    // Seen empty, then the screen says otherwise at the second look itself: kept.
    await draw(e, EMPTY_INPUT)
    look(e)
    await draw(e, HELD_INPUT)
    secondLook(e)
    expect(e.state.untakenLine).toBeTruthy()
    // The line still in the input (whole or wrapped), the user's own words, or the question: never seen lost.
    for (const screen of [HELD_INPUT, `${RULE}\n❯ [CW] New in your inbox:\n  1 task (HI-1959)\n${RULE}`, `${RULE}\n❯ my own words\n${RULE}`, QUESTION_SCREEN]) {
      await draw(e, screen)
      look(e)
      expect(e.lostSeen, screen).toBeUndefined()
      expect(e.state.untakenLine, screen).toBeTruthy()
    }
  })

  it('taken late: a prompt taken (its hook) between the two looks keeps it; a delivery it rang for read clears it as taken', async () => {
    later()
    quiet()
    const e = running()
    held(e)
    await draw(e, EMPTY_INPUT)
    look(e)
    // The CLI reports a prompt before the second look (a late UserPromptSubmit): no loss, nothing offered again.
    e.prompts = 1
    secondLook(e)
    expect(e.state.untakenLine).toBeTruthy()
    // A delivery it rang for read (lineTaken): the mark goes as taken, its look with it.
    sessions.lineTaken(project, id, 'run1', 'd1', 'read')
    expect(e.state.untakenLine).toBeUndefined()
    expect(e.lostSeen).toBeUndefined()
  })

  it('a held line that rang for no delivery is told to the user with its words, never dropped unseen', async () => {
    later()
    const notified = quiet()
    const e = running()
    held(e, [])
    notified.mockClear()
    await draw(e, EMPTY_INPUT)
    look(e)
    secondLook(e)
    expect(e.state.untakenLine).toBeUndefined()
    expect(JSON.stringify(notified.mock.calls.at(-1))).toContain('Call cw_inbox to read it, act on it, then ack it.')
  })

  it('a line marked held when its input is already empty, with nothing drawn after, is looked at at once (HR3\'s round 1)', async () => {
    later()
    quiet()
    const e = running()
    // The dialog took the line and closed before the line was marked: its empty input is all there is, and stays so.
    await draw(e, EMPTY_INPUT)
    held(e)
    await vi.waitFor(() => expect(e.lostSeen).toBeTruthy(), { timeout: 10_000 })
    secondLook(e)
    expect(e.state.untakenLine).toBeUndefined()
  })

  it('a line marked held with its text, or the user\'s, still in the input, or taken late, is kept however it was looked at', async () => {
    later()
    quiet()
    const e = running()
    await draw(e, `${RULE}\n❯ my own words\n${RULE}`)
    held(e)
    // Looked at in hook order like any look: nothing seen lost.
    await (sessions as unknown as { inHookOrder(k: string, fn: () => void): Promise<void> }).inHookOrder('run1', () => undefined)
    expect(e.lostSeen).toBeUndefined()
    expect(e.state.untakenLine).toBeTruthy()
    // Empty, but a prompt taken since the mark (a late hook): no loss at the first look, nor at a second.
    await draw(e, EMPTY_INPUT)
    e.prompts = 1
    look(e)
    expect(e.lostSeen).toBeUndefined()
    secondLook(e)
    expect(e.state.untakenLine).toBeTruthy()
  })

  it("the timer's own second look, after the wait, lets a swallowed line go", async () => {
    vi.spyOn(advanced, 'number').mockImplementation(((name: string) => (name === 'hive.lostLine.steadySeconds' ? 0.05 : 30)) as typeof advanced.number)
    quiet()
    const e = running()
    held(e)
    await draw(e, EMPTY_INPUT)
    look(e)
    await vi.waitFor(() => expect(e.state.untakenLine).toBeUndefined(), { timeout: 10_000 })
  })
})
describe("a Claude Code launch's settings: the offer turned off (HI-1959)", () => {
  const base = tempDir('hive-envsetup-')
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  const launch = async (name: string, extraArgs: string[] = []) => {
    const cwd = join(base, `${name}-project`)
    mkdirSync(cwd, { recursive: true })
    const ctx = {
      projectPath: cwd, agentId: 'a1', executable: 'C:\\bin\\claude.exe', cwd, workspacePath: cwd, runId: 'r', sessionId: '00000000-0000-4000-8000-000000000000',
      resume: false, name: '', skills: [], mcpServers: {}, model: null, effort: null, permissionMode: null, extraArgs, hookUrl: 'http://127.0.0.1:9/hook?run=r', hookAuthFile: 'C:/hive/hook-auth/r.txt', privateDir: join(base, `${name}-private`), guidance: '', env: {}, allowBackgroundSessions: true, use200kContext: false
    }
    await claudeCode.prepareLaunch(ctx as never)
    return JSON.parse(readFileSync(join(ctx.privateDir, 'settings.json'), 'utf8')) as Record<string, unknown>
  }
  const offer = (on: boolean) => {
    const real = advanced.get.bind(advanced)
    return vi.spyOn(advanced, 'get').mockImplementation(((name: string) => (name === 'claude-code.autoModeSetup.offer' ? on : real(name))) as typeof advanced.get)
  }
  afterEach(() => vi.restoreAllMocks())

  it('offered by default: nothing added; off: the skill turned off for that launch, the user\'s own overrides kept and theirs standing', async () => {
    expect((await launch('default')).skillOverrides).toBeUndefined()
    offer(false)
    expect((await launch('off')).skillOverrides).toEqual({ 'auto-mode-setup': 'off' })
    const theirs = join(base, 'theirs.json')
    writeFileSync(theirs, JSON.stringify({ skillOverrides: { review: 'off', 'auto-mode-setup': 'on' } }))
    expect((await launch('theirs', ['--settings', theirs])).skillOverrides).toEqual({ review: 'off', 'auto-mode-setup': 'on' })
    const others = join(base, 'others.json')
    writeFileSync(others, JSON.stringify({ skillOverrides: { review: 'off' } }))
    expect((await launch('others', ['--settings', others])).skillOverrides).toEqual({ review: 'off', 'auto-mode-setup': 'off' })
  })
})
