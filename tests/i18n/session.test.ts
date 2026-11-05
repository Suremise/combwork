import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import * as electron from 'electron'
import { tempDir } from '../tempDir'

// #847 (E10c): sessions in the window's language, English for agents. Errors are CombworkErrors (English message, the
// window's text through IPC); Combwork's own statuses are text beside the English statusMessage (statusText), as is the
// merge slot's note (mergeSlotText) and Combwork's sign-in message (signIn.messageText); notices are formatted twice: the
// user's title and the Agent API stream's English one.

const base = tempDir('cw-i18n-session-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { setLanguage } = await import('../../src/shared/i18n')
const { englishText, shownText, withValues } = await import('../../src/shared/advanced')
const { COMPACTING_MESSAGE, isCompacting } = await import('../../src/shared/defaults')
const { COMPACTING_TEXT, runtimeLabel, shownMergeSlot, shownStatusMessage } = await import('../../src/shared/runtime')
const { finishedApiTitle } = await import('../../src/shared/bursts')
const { waitingNote, holdingNote } = await import('../../src/shared/mergeSlot')
const { applyStep, hookStep, SAFEGUARD_IDLE_MESSAGE, SAFEGUARD_IDLE_TEXT } = await import('../../src/main/hookStatus')
const { CombworkError, shownError } = await import('../../src/main/combworkError')
const { onCombworkEvent } = await import('../../src/main/events')
const { apiEventFor } = await import('../../src/main/apiEvents')
const { noteUntracked, trackingProblem } = await import('../../src/main/agentProcesses')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../../src/main/workspace')
const { sessions } = await import('../../src/main/sessions')
const { claudeCode } = await import('../../src/main/providers/claude/adapter')

const ROOT = resolve(__dirname, '../..')
const EN = JSON.parse(readFileSync(join(ROOT, 'locales/en/session.json'), 'utf8')) as Record<string, { defaultMessage: string; description: string }>
/** A message of the area as the code has it, from its English catalogue. */
const M = (id: string) => ({ id, defaultMessage: EN[id].defaultMessage, description: EN[id].description })

/** A German translation of the messages these tests show (the rest stays English). */
const GERMAN = {
  'session.error.noAgents': 'Dieses Projekt hat noch keine Agenten. Füge zuerst einen hinzu.',
  'session.error.noSession': 'Für diesen Agenten läuft keine Sitzung.',
  'session.start.fenced': '{why}, daher können seine Agenten jetzt nicht starten.',
  'session.start.removing': 'Dieses Projekt wird entfernt',
  'session.status.compacting': 'Die Unterhaltung wird verdichtet…',
  'session.status.safeguardIdle': 'Untätig nach einem Sicherheitsstopp: gib ihm einen Anstoß',
  'session.status.safeguardAsks': 'Ein Sicherheitsfilter hat eine Antwort gestoppt: {provider} fragt, was zu tun ist',
  'session.notice.notWatching': '{agent} beobachtet {cards} nicht',
  'session.notice.notWatchingBody': '{n, plural, one {Sein Zug endete ohne Kartenbeobachtung.} other {Sein Zug endete ohne Kartenbeobachtung ({n} Karten).}}',
  'session.notice.finished': '{agent} ist fertig',
  'session.mergeSlot.waitingMergingCards': 'Wartet auf den Merge-Slot ({agent} merged {cards})',
  'session.mergeSlot.holding': 'Merged in {branch} (Merge-Slot)',
  'session.signIn.one': '{agent} muss sich bei {provider} anmelden',
  'session.signIn.expired': 'Die Anmeldung von {provider} ist abgelaufen. {help}',
  'agents.codex.signInHelp': 'Melde dich erneut an: Hilfe → Agent-Einrichtung → Codex → Anmelden.',
  'session.tracker.title': 'Combwork kann die Prozesse der Agenten nicht verfolgen',
  'session.tracker.body': '{reason}. {detail} Hilfe → Diagnose kopieren sagt warum.',
  'session.tracker.stopped': 'Hives Prozessverfolgung wurde beendet ({why})',
  'session.tracker.lost': '{launches, plural, =0 {Was Agenten starten, wird bis zu ihrem Neustart nicht verfolgt.} one {Was der laufende Agent startet, wird bis zu seinem Neustart nicht verfolgt.} other {Was die # laufenden Agenten starten, wird bis zu ihrem Neustart nicht verfolgt.}}'
}

const wsPath = join(base, 'ws')
const alpha = join(wsPath, 'alpha')
const empty = join(wsPath, 'empty')
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T> | T): Promise<T> => inWorkspace(w, async () => fn())

type Live = { state: Record<string, unknown> }
const s = sessions as unknown as { live: Map<string, Live>; runs: Map<string, string> }

/** A running agent of alpha (two agents, so it is labelled "alpha · B1"): its state only, no process. */
function live(agentId: string, name: string): Record<string, unknown> {
  const st = { provider: 'claude-code', runId: `run-${agentId}`, projectPath: alpha, agentId, agentName: name, cwd: alpha, sessionId: '', status: 'ready', startedAt: new Date().toISOString(), launchSignature: '', unseen: false }
  s.live.set(`${alpha.toLowerCase()}#${agentId}`, { state: st, adapter: claudeCode, transcriptMtime: '', defaultModel: false, modeTail: '', launchMode: null, configuredMode: null } as never)
  s.runs.set(st.runId, `${alpha.toLowerCase()}#${agentId}`)
  return st
}

beforeAll(async () => {
  for (const p of [alpha, empty]) mkdirSync(join(p, '.combwork'), { recursive: true })
  mkdirSync(join(wsPath, '.combwork'), { recursive: true })
  writeFileSync(join(alpha, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'B1', provider: 'claude-code' }, { id: 'a2', name: 'R1', provider: 'claude-code' }] }))
  writeFileSync(join(empty, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
  w = createWorkspaceService()
  await w.open(wsPath)
})
afterAll(async () => {
  s.live.clear()
  s.runs.clear()
  await disposeWorkspaceService(w)
})
afterEach(() => setLanguage('en', {}))

describe('the session area', () => {
  it('has every message in locales/en with a note for translators, and no English left to convert in its four files', () => {
    expect(Object.keys(EN).length).toBeGreaterThan(150)
    for (const [id, m] of Object.entries(EN)) {
      expect(id.startsWith('session.')).toBe(true)
      expect(m.description.length, id).toBeGreaterThan(10)
    }
    for (const f of ['sessions', 'agentProcesses', 'hookStatus', 'ptyHost']) expect(() => readFileSync(join(ROOT, `i18n/allow/src__main__${f}.ts.json`))).toThrow()
  })

  it('says in English exactly what it said before, which agents, the log and the API status patterns read', () => {
    const before: [string, Record<string, string | number> | undefined, string][] = [
      ['session.start.openIn', { agent: 'another agent' }, 'This conversation is already open in another agent. An agent can only resume a session no other agent is running.'],
      ['session.start.providerOff', { provider: 'Codex', resuming: 'no', agent: 'B1' }, 'Codex is turned off. Turn it on in Settings → Providers to run B1.'],
      ['session.start.providerOff', { provider: 'Codex', resuming: 'yes', agent: 'B1' }, 'Codex is turned off. Turn it on in Settings → Providers to resume this conversation.'],
      ['session.start.providerMissing', { provider: 'Codex', resuming: 'no', agent: 'B1' }, 'Codex is required to run B1. Install it from Help → Provider Setup.'],
      ['session.start.providerMissing', { provider: 'Codex', resuming: 'yes', agent: 'B1' }, 'Codex is required to resume this conversation. Install it from Help → Provider Setup.'],
      ['session.start.args', { problem: 'Bad.', connection: 'Max 1' }, 'Bad. Fix it in its connection, Max 1, in Settings → Accounts & Connections.'],
      ['session.error.stopFirst', { action: 'unarchive' }, 'Stop the session before you unarchive it.'],
      ['session.handOver.didntStop', { agent: 'B1', handover: 'handovers/x.md' }, 'B1 didn\'t stop. Stop it, then start it and ask it to read the handover "handovers/x.md".'],
      ['session.leftovers.notEnded', { n: 1 }, "1 process is still running: Windows didn't let Combwork end it. It stays listed in the ⋯ menu on the agent's pane, to try again or keep."],
      ['session.leftovers.notEnded', { n: 3 }, "3 processes are still running: Windows didn't let Combwork end them. They stay listed in the ⋯ menu on the agent's pane, to try again or keep."],
      ['session.status.tasksDropped', { minutes: 60 }, 'Stopped counting its background tasks after 60 minutes'],
      ['session.status.safeguardAsksTools', { provider: 'Claude Code', tools: 'Bash, Edit' }, 'A safety classifier stopped a response: Claude Code asks what to do (its last tool calls: Bash, Edit)'],
      ['session.signIn.notSignedIn', { provider: 'Codex' }, "Codex isn't signed in."],
      ['session.status.signedInAgain', undefined, 'Stopped while signed out'],
      ['session.mergeSlot.waitingMergingCards', { agent: 'B2', cards: '#304' }, waitingNote({ id: 'x', kind: 'agent', name: 'B2', cards: [304], since: 0, until: 0, taken: true })],
      ['session.mergeSlot.waitingNext', { agent: 'B2' }, waitingNote({ id: 'x', kind: 'agent', name: 'B2', cards: [], since: 0, until: 0, taken: false })],
      ['session.mergeSlot.waitingForYou', undefined, waitingNote({ id: 'x', kind: 'user', name: 'You', cards: [], since: 0, until: 0, taken: true })],
      ['session.mergeSlot.holding', { branch: 'main' }, holdingNote('main')]
    ]
    setLanguage('de', GERMAN, 'de-DE')
    for (const [id, values, english] of before) expect(englishText(values ? withValues(M(id), values) : M(id)), id).toBe(english)
    // Statuses Combwork compares by their English.
    expect(englishText(COMPACTING_TEXT)).toBe(COMPACTING_MESSAGE)
    expect(SAFEGUARD_IDLE_MESSAGE).toBe('Idle after a safeguard stop: give it a nudge')
    expect(englishText(SAFEGUARD_IDLE_TEXT)).toBe(SAFEGUARD_IDLE_MESSAGE)
  })
})

describe('errors: English for agents, the window gets its language', () => {
  it('a refused action, from the session manager', async () => {
    setLanguage('de', GERMAN, 'de-DE')
    const e = await run(() => sessions.soleAgent(empty)).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(CombworkError)
    expect((e as Error).message).toBe('This project has no agents yet. Add one first.')
    expect((e as InstanceType<typeof CombworkError>).kind).toBe('conflict')
    expect(shownError(e)).toBe('Dieses Projekt hat noch keine Agenten. Füge zuerst einen hinzu.')
    const none = await run(() => sessions.compact(alpha, undefined, 'a1')).catch((x: unknown) => x)
    expect((none as Error).message).toBe('No session is running for this agent.')
    expect(shownError(none)).toBe('Für diesen Agenten läuft keine Sitzung.')
  })

  it("a fence's reason inside the refusal, in the same language", async () => {
    setLanguage('de', GERMAN, 'de-DE')
    const lift = sessions.fenceStarts(alpha)
    try {
      const e = await run(() => sessions.start(alpha, { agentId: 'a1' })).catch((x: unknown) => x)
      expect((e as Error).message).toBe("This project is being removed, so its agents can't start now.")
      expect(shownError(e)).toBe('Dieses Projekt wird entfernt, daher können seine Agenten jetzt nicht starten.')
    } finally {
      lift()
    }
  })
})

describe("statuses: Combwork's words as text beside the English", () => {
  const input = (status: string, statusMessage?: string) =>
    ({ status, statusMessage, askedAtStart: false, compacting: null, backgroundWakes: false, tasks: 0, attention: 'hooks', reviewed: false, titleAsks: false, open: [], waitingOn: null, question: false, reviewing: false, safeguardPrompt: false }) as never

  it('compacting: the English isCompacting compares, the text the window shows; over, both go', () => {
    setLanguage('de', GERMAN, 'de-DE')
    const st: { status: 'ready' | 'working'; statusMessage?: string; statusText?: unknown } = { status: 'ready' }
    applyStep(st as never, hookStep({ kind: 'compactStart' } as never, input('ready')))
    expect(st.statusMessage).toBe(COMPACTING_MESSAGE)
    expect(isCompacting(st as never)).toBe(true)
    expect(shownStatusMessage(st as never)).toBe('Die Unterhaltung wird verdichtet…')
    applyStep(st as never, hookStep({ kind: 'compactEnd' } as never, input('working', COMPACTING_MESSAGE)))
    expect(st.statusMessage).toBeUndefined()
    expect(st.statusText).toBeUndefined()
  })

  it("a CLI's own words stay as they came, with no text; a safeguard prompt is Combwork's, in the window's language", () => {
    setLanguage('de', GERMAN, 'de-DE')
    const st: { status: string; statusMessage?: string; statusText?: unknown } = { status: 'working' }
    applyStep(st as never, hookStep({ kind: 'ask', ask: { kind: 'permission', blocking: true, message: 'Claude needs your permission to use Bash' } } as never, input('working')))
    expect(st.statusMessage).toBe('Claude needs your permission to use Bash')
    expect(st.statusText).toBeUndefined()
    expect(shownStatusMessage(st as never)).toBe('Claude needs your permission to use Bash')
    const text = withValues(M('session.status.safeguardAsks'), { provider: 'Claude Code' })
    const st2: { status: string; statusMessage?: string; statusText?: unknown } = { status: 'working' }
    applyStep(st2 as never, hookStep({ kind: 'ask', ask: { kind: 'question', blocking: true, message: englishText(text), text } } as never, input('working')))
    expect(st2.statusMessage).toBe('A safety classifier stopped a response: Claude Code asks what to do')
    expect(shownStatusMessage(st2 as never)).toBe('Ein Sicherheitsfilter hat eine Antwort gestoppt: Claude Code fragt, was zu tun ist')
  })

  it("the window's status line: compacting and the merge slot in its language", () => {
    setLanguage('de', GERMAN, 'de-DE')
    const compacting = { runtime: { lifecycle: 'running', maintenance: 'compacting', attention: null, composer: 'free' }, statusMessage: COMPACTING_MESSAGE }
    expect(runtimeLabel(compacting as never)).toBe('Die Unterhaltung wird verdichtet…')
    // A state from before (no text): its English.
    expect(shownMergeSlot({ mergeSlot: 'Merging into main (merge slot)' })).toBe('Merging into main (merge slot)')
  })

  it("the merge slot's note: English for agents, the window's text beside it", () => {
    setLanguage('de', GERMAN, 'de-DE')
    const st = live('a1', 'B1')
    const holder = { id: 'h', kind: 'agent' as const, agentId: 'a2', name: 'R1', cards: [12], since: 0, until: 0, taken: true }
    sessions.setMergeSlotNote(alpha, 'a1', 'run-a1', waitingNote(holder), { waitingFor: holder })
    expect(st.mergeSlot).toBe('Waiting for the merge slot (R1 is merging #12)')
    expect(shownMergeSlot(st as never)).toBe('Wartet auf den Merge-Slot (R1 merged #12)')
    sessions.setMergeSlotNote(alpha, 'a1', 'run-a1', holdingNote('main'), { holding: 'main' })
    expect(shownMergeSlot(st as never)).toBe('Merged in main (Merge-Slot)')
    sessions.setMergeSlotNote(alpha, 'a1', 'run-a1', null)
    expect(st.mergeSlot).toBeUndefined()
    expect(st.mergeSlotText).toBeUndefined()
  })
})

describe('notices: the user in their language, the Agent API in English', () => {
  const seen: { type: string; notice?: { title: string; body: string }; toast?: { title: string; message?: string } }[] = []
  let off: () => void
  beforeAll(() => {
    off = onCombworkEvent((e) => void seen.push(e as never))
  })
  afterAll(() => off())

  it("an agent in a card loop that isn't watching its cards", async () => {
    setLanguage('de', GERMAN, 'de-DE')
    live('a2', 'R1')
    seen.length = 0
    // Combwork in the background: a Windows notification, told to the Agent API's stream.
    await run(() => sessions.notifyNotWatching(alpha, 'a2', [12, 13]))
    const e = seen.find((x) => x.type === 'notice')!
    expect(e.notice!.title).toBe('alpha · R1 beobachtet #12, #13 nicht')
    expect(e.notice!.body).toBe('Sein Zug endete ohne Kartenbeobachtung (2 Karten).')
    expect((apiEventFor(e as never, null) as { notice: { title: string } }).notice.title).toBe("alpha · R1 isn't watching #12, #13")
  })

  it("an expired sign-in: how to sign in is the provider's own message, in the user's language (not its English)", async () => {
    setLanguage('de', GERMAN, 'de-DE')
    const st = live('a1', 'B1')
    Object.assign(st, { provider: 'codex', status: 'signin' })
    seen.length = 0
    try {
      await run(() => (sessions as unknown as { tellSignedOut: (p: string) => void }).tellSignedOut('codex'))
      const e = seen.find((x) => x.type === 'notice')!
      expect(e.notice!.title).toBe('alpha · B1 muss sich bei Codex anmelden')
      expect(e.notice!.body).toBe('Die Anmeldung von Codex ist abgelaufen. Melde dich erneut an: Hilfe → Agent-Einrichtung → Codex → Anmelden.')
      expect((apiEventFor(e as never, null) as { notice: { title: string } }).notice.title).toBe('alpha · B1 needs you to sign in to Codex')
    } finally {
      Object.assign(st, { provider: 'claude-code', status: 'ready' })
    }
  })

  it("an agent finishing alone: the user's title, the English one for the stream", () => {
    setLanguage('de', GERMAN, 'de-DE')
    const title = withValues(M('session.notice.finished'), { agent: 'alpha · B1' })
    const one = { projectPath: alpha, project: 'alpha', agent: 'B1', title: shownText(title), apiTitle: englishText(title), body: '' }
    expect(one.title).toBe('alpha · B1 ist fertig')
    expect(finishedApiTitle([one])).toBe('alpha · B1 finished')
    // A finish recorded without one (before #847): its title as it is.
    expect(finishedApiTitle([{ ...one, apiTitle: undefined }])).toBe('alpha · B1 ist fertig')
  })

  it("the process tracker: the notice in the user's language, Diagnostics in English", () => {
    setLanguage('de', GERMAN, 'de-DE')
    seen.length = 0
    noteUntracked(withValues(M('session.tracker.stopped'), { why: 'exit 1' }), withValues(M('session.tracker.lost'), { launches: 2 }))
    const t = seen.find((x) => x.type === 'toast')!.toast!
    expect(t.title).toBe('Combwork kann die Prozesse der Agenten nicht verfolgen')
    expect(t.message).toBe('Hives Prozessverfolgung wurde beendet (exit 1). Was die 2 laufenden Agenten starten, wird bis zu ihrem Neustart nicht verfolgt. Hilfe → Diagnose kopieren sagt warum.')
    // Diagnostics reads the tracker's problem in English (none here: the tracker never failed in this run).
    expect(trackingProblem()).toBeNull()
  })
})
