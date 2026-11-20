// HI-3201: an adapter's capability parts may be objects of their own, not the adapter (the class adapters return
// themselves, so their tests can't tell). A part's member is called on its part: one that reads its own state through
// `this` works the same whether Combwork calls it directly or takes it out first (HR2's round 1: cliAsks bound
// terminal.idleQuestion to the adapter, so a separate terminal part's question went unseen and Combwork could type into it).
import { afterEach, describe, expect, it } from 'vitest'
import { claudeCode } from '../src/main/providers/claude/adapter'
import { TerminalScreen } from '../src/main/terminalScreen'
import { sessions } from '../src/main/sessions'

const project = 'C:/fake-ws/parts'
const id = 'p1'
const key = `${project.toLowerCase()}#${id}`
type Entry = Record<string, unknown> & { state: Record<string, unknown>; screen: TerminalScreen }
const live = (sessions as unknown as { live: Map<string, Entry> }).live

/** An adapter given as data: Claude Code's own parts but a terminal part of its own, whose question lives in its own field. */
const withOwnTerminal = (question: string): object => {
  const terminal = {
    question,
    idleQuestion(screen: string): string | null {
      return screen.includes(this.question) ? this.question : null
    }
  }
  return { id: claudeCode.id, descriptor: claudeCode.descriptor, install: claudeCode.install, launch: claudeCode.launch, terminal }
}

function running(adapter: object): Entry {
  const screen = new TerminalScreen(80, 24)
  const e: Entry = { state: { projectPath: project, agentId: id, agentName: 'P1', runId: 'run-p1', status: 'ready', open: [] }, prompts: 0, screen, adapter }
  live.set(key, e)
  return e
}
const draw = (e: Entry, text: string): Promise<void> => new Promise((r) => e.screen.write(`\x1b[2J\x1b[H${text}`, r))

describe('a capability part of its own (HI-3201)', () => {
  afterEach(() => {
    live.get(key)?.screen.dispose()
    live.delete(key)
  })

  it("is called on itself: a separate terminal part's question, read from its own state, keeps Combwork from typing", async () => {
    const e = running(withOwnTerminal('Proceed?'))
    await draw(e, 'Proceed?')
    expect(sessions.cliAsks(project, id)).toBe(true)
    await draw(e, 'nothing asked')
    expect(sessions.cliAsks(project, id)).toBe(false)
  })

  it('an adapter without a terminal part asks nothing', async () => {
    const e = running({ id: claudeCode.id, descriptor: claudeCode.descriptor, install: claudeCode.install, launch: claudeCode.launch })
    await draw(e, 'Proceed?')
    expect(sessions.cliAsks(project, id)).toBe(false)
  })
})
