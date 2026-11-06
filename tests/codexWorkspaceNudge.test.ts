// Codex's prompts at a workspace's limit (HI-2619): once a workspace member's turn fails at the workspace's credit or
// usage limit, Codex 0.166.0 shows "You've reached your workspace credit limit … Notify owner?" or "Usage limit reached
// … Request increase?" in place of its input, "1. Yes (y)" and "› 2. No (default) (n)". Its "y" emails the workspace's
// owner, a step that reaches outside the PC, and Enter or "n" answers it: a wake typed into it would answer it. No
// [notice] key hides them (its features.workspace_owner_usage_nudge is "removed"). Like the offer of a cheaper model
// (HI-2609, codexRateLimitNudge.test.ts), each is a question by itself: the agent waits, and nothing is typed.
import { readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { codex, codexIdleQuestion } from '../src/main/providers/codex/adapter'
import { TerminalScreen } from '../src/main/terminalScreen'
import { sessions } from '../src/main/sessions'
import * as pty from '../src/main/ptyHost'
import * as writer from '../src/main/lineWriter'

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8').replace(/\r\n/g, '\n')
const CREDITS = fixture('advanced/credit-limit-nudge-codex-0.166.0.txt')
const USAGE = fixture('advanced/usage-limit-nudge-codex-0.166.0.txt')
const IDLE = fixture('screen-codex-0.162.1-idle.txt')
const CREDITS_TITLE = "You've reached your workspace credit limit"
const USAGE_TITLE = 'Usage limit reached'
const PROMPTS: [string, string, string][] = [
  ['credits', CREDITS, CREDITS_TITLE],
  ['usage limit', USAGE, USAGE_TITLE]
]
const INPUT = '› Ask Codex to do anything\n\n  GPT-6-Astra low · C:\\work\\alpha\n  ? for shortcuts'
/** The view from its title down, "Yes" selected. */
const yesSelected = (screen: string): string => screen.replace('  1. Yes (y)', '› 1. Yes (y)').replace('› 2. No (default) (n)', '  2. No (default) (n)')

describe("Codex's prompts at a workspace's limit, on its screen (0.166.0)", () => {
  for (const [name, screen, title] of PROMPTS) {
    it(`reads the ${name} prompt: its title, whichever choice is selected, its footer below`, () => {
      expect(codexIdleQuestion(screen)).toBe(title)
      expect(codexIdleQuestion(yesSelected(screen))).toBe(title)
      // The view alone, without its footer.
      const view = screen.slice(screen.indexOf(`  ${title}\n`)).replace(/\n\n {2}enter select · esc back\n?$/, '')
      expect(codexIdleQuestion(view)).toBe(title)
    })

    it(`reads the ${name} prompt in a narrow pane: its question wrapped onto several lines`, () => {
      // Wrapped at 30 columns, as a narrow pane draws it: four lines or more.
      const narrow = screen.replace(/^( {2}(?:Your workspace|Request a limit).*)$/m, (q) => q.trim().replace(/(.{1,28})(?: |$)/g, '  $1\n').trimEnd())
      expect(narrow.split('\n').length).toBeGreaterThan(screen.split('\n').length + 2)
      expect(codexIdleQuestion(narrow)).toBe(title)
    })

    it(`isn't fooled by the ${name} prompt's words above a real input line, or typed into it`, () => {
      const view = screen.slice(screen.indexOf(`  ${title}\n`)).replace('› 2.', '  2.')
      // What is left of it once answered, Codex's input drawn below.
      expect(codexIdleQuestion(`${view}\n\n${INPUT}`)).toBeNull()
      // Typed into the input, numbered as its choices are.
      expect(codexIdleQuestion(`• Done.\n\n› 1. ${title}\n  2. No (default) (n)\n\n  GPT-6-Astra low · C:\\work\\alpha`)).toBeNull()
    })
  }

  it("is none for Codex's error line alone, nor for its title without a choice of it", () => {
    expect(codexIdleQuestion(`■ Usage limit reached.\n\n${INPUT}`)).toBeNull()
    expect(codexIdleQuestion(`  ${USAGE_TITLE}\n  Some other question?\n\n› 1. Yes (y)\n  2. Later`)).toBeNull()
    expect(codexIdleQuestion(IDLE)).toBeNull()
  })
})

// The real SessionManager, an agent's live state made by hand (as codexRateLimitNudge.test.ts), its screen a real TerminalScreen.
const project = 'C:/fake-ws/alpha'
const id = 'a1'
const key = `${project.toLowerCase()}#${id}`
type Entry = Record<string, unknown> & { state: Record<string, unknown>; prompts: number; screen: TerminalScreen }
const live = (sessions as unknown as { live: Map<string, Entry> }).live
const internals = sessions as unknown as { lookAtIdleScreen(id: string, l: Entry): void; notify: (...a: unknown[]) => void }
const liveKey = (): string => [...live.keys()].find((k) => live.get(k)?.state.agentId === id) ?? ''

function running(status = 'finished'): Entry {
  const screen = new TerminalScreen(120, 40)
  const e: Entry = { state: { projectPath: project, agentId: id, agentName: 'CB1', runId: 'run1', status, open: [], provider: 'codex', startedAt: '2026-11-06T01:00:00.000Z' }, prompts: 0, screen, adapter: codex }
  live.set(key, e)
  return e
}
const draw = (e: Entry, text: string): Promise<void> => new Promise((r) => e.screen.write(`\x1b[2J\x1b[H${text.replace(/\n/g, '\r\n')}`, r))

describe("a Codex agent at its workspace's limit (HI-2619)", () => {
  afterEach(() => {
    live.get(key)?.screen.dispose()
    live.delete(key)
    vi.restoreAllMocks()
  })

  for (const [name, screen, title] of PROMPTS) {
    it(`the ${name} prompt: nothing is typed into it and no Enter pressed, and the agent waits for the user with it`, async () => {
      vi.spyOn(internals, 'notify').mockImplementation(() => undefined)
      const writes: string[] = []
      vi.spyOn(pty, 'writePty').mockImplementation((_k, data) => void writes.push(data))
      const e = running()
      await draw(e, screen)
      expect(sessions.cliAsks(project, id)).toBe(true)
      // A wake with a "y" in it ("your") would ask the owner, typed into the prompt.
      await expect(sessions.sendPrompt(project, id, '[CW] New in your inbox: 1 card event (HI-12)')).rejects.toThrow(/shows a question for you/)
      expect(sessions.submitAgain(project, id, 'run1')).toBe(false)
      expect(writer.whyNoLine(project, id)).toMatch(/shows a question for the user/)
      internals.lookAtIdleScreen(liveKey(), e)
      expect(e.state.status).toBe('waiting')
      expect(String(e.state.statusMessage ?? '')).toContain(title)
      expect(writes).toEqual([])
      // Answered by the user ("n"): Codex's input again.
      await draw(e, IDLE)
      expect(sessions.cliAsks(project, id)).toBe(false)
    })
  }
})
