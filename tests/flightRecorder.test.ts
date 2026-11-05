import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { ADVANCED_DEFS } from '../src/shared/advanced'
import { FLIGHT_PATTERN_OFF, knownIds, unknownIn } from '../src/shared/flightRecorder'
import { parseRecording } from '../src/shared/consoleFixtures.mts'
import { sessionSourceId, hiveSourceId } from '../src/shared/devConsole'
import { setLanguage } from '../src/shared/i18n'

// The developer console's flight recorder (#698): the events and fields each CLI is known to send (advanced values; every
// recorded fixture's are known), the console keeping agents' events while a trigger is on (and nothing while none is),
// captures written as redacted recordings and pruned, each trigger firing once per agent per period with a notice, what
// a capture says masked as events are, the recorder's own state bounded and dropped when every trigger is off, a
// trigger turned off stopping at once, and a damaged versions file read as none.

const profile = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', async () => {
  const { tempDir } = await import('./tempDir')
  profile.dir = tempDir('hive-flight-')
  return { app: { getPath: () => profile.dir, getVersion: () => '0.9.0-test', isPackaged: false } }
})
// Settings → Advanced as the test sets them; anything else at its default.
const settings = vi.hoisted(() => ({ values: {} as Record<string, unknown>, listeners: [] as (() => void)[] }))
vi.mock('../src/main/advanced', async () => {
  const { ADVANCED_DEFS: defs } = await import('../src/shared/advanced')
  const get = (id: string) => {
    if (id in settings.values) return settings.values[id]
    const d = defs.find((x) => x.id === id)
    if (!d) throw new Error(`No advanced setting "${id}"`)
    return d.default
  }
  return { advanced: { get, number: (id: string) => Number(get(id)), pattern: (id: string) => new RegExp(String(get(id)), 'i'), onChange: (fn: () => void) => settings.listeners.push(fn) } }
})
const toasts = vi.hoisted(() => ({ list: [] as { level: string; title: string; message?: string; actions?: { command: string; args?: unknown[] }[]; source?: string }[] }))
vi.mock('../src/main/events', () => ({ toast: (level: string, title: string, message?: string, actions?: never, source?: string) => toasts.list.push({ level, title, message, actions, source }) }))
vi.mock('../src/main/workspace', () => ({ workspace: { isAssistantHome: () => false } }))
// A capture's write can be held (a slow or stuck disk): saveCapture waits for the gate while one is set.
const disk = vi.hoisted(() => ({ gate: null as Promise<void> | null, writes: 0 }))
vi.mock('../src/main/consoleRecorder', async (original) => {
  const real = await original<typeof import('../src/main/consoleRecorder')>()
  return {
    ...real,
    saveCapture: async (...a: Parameters<typeof real.saveCapture>) => {
      disk.writes++
      try {
        if (disk.gate) await disk.gate
        return await real.saveCapture(...a)
      } finally {
        disk.writes--
      }
    }
  }
})
vi.mock('../src/main/providerService', () => ({ providerService: { all: () => ({ 'claude-code': { version: '2.1.999', tested: { version: '2.1.296' } } }) } }))

const set = (values: Record<string, unknown>): void => {
  settings.values = values
  for (const fn of settings.listeners) fn()
}
const FIX = join(__dirname, 'fixtures')
const defaultOf = (id: string): string[] => ADVANCED_DEFS.find((d) => d.id === id)!.default as string[]
/** A synthetic secret, as a key would look: masked wherever it is kept. */
const SECRET = 'sk-abcdefghijklmnopqrstuvwxyz0123456789'

describe('the events and fields each CLI is known to send', () => {
  /** Every hook (by provider) in a recorded fixture: its event name and top-level fields. */
  const hooksIn = (file: string): Record<string, unknown>[] => {
    const out: Record<string, unknown>[] = []
    const walk = (o: unknown): void => {
      if (Array.isArray(o)) o.forEach(walk)
      else if (o && typeof o === 'object') {
        const r = o as Record<string, unknown>
        if (typeof r.hook_event_name === 'string' || typeof r.hookEventName === 'string') out.push(r)
        Object.values(r).forEach(walk)
      }
    }
    walk(JSON.parse(readFileSync(join(FIX, file), 'utf8')))
    return out
  }
  const known = (provider: string) => ({ events: defaultOf(knownIds(provider).events), fields: defaultOf(knownIds(provider).fields) })

  it("knows every event and field of the recorded CLIs' hooks and status line", () => {
    for (const [provider, file] of [['claude-code', 'turns-claude-2.1.296.json'], ['codex', 'turns-codex-0.162.1.json'], ['copilot', 'console/copilot.json']]) {
      const hooks = hooksIn(file)
      expect(hooks.length).toBeGreaterThan(3)
      for (const h of hooks) expect([provider, unknownIn('hook', h, known(provider))]).toEqual([provider, { event: null, fields: [] }])
    }
    const statusLine = JSON.parse(readFileSync(join(FIX, 'advanced', 'statusline-claude-2.1.296.json'), 'utf8'))
    expect(unknownIn('statusline', statusLine, { fields: defaultOf(knownIds('claude-code').statusFields) })).toEqual({ event: null, fields: [] })
  })

  it('names an event or a field it doesn\'t know, safely; judges nothing without a list', () => {
    const k = known('claude-code')
    expect(unknownIn('hook', { hook_event_name: 'FutureHookEvent', session_id: 's' }, k)).toEqual({ event: 'FutureHookEvent', fields: [] })
    expect(unknownIn('hook', { hook_event_name: 'Stop', session_id: 's', brand_new: 1, 'a b"c': 2 }, k)).toEqual({ event: null, fields: ['<name>', 'brand_new'] })
    expect(unknownIn('hook', { hook_event_name: SECRET, unexpected: 1 }, k)).toEqual({ event: SECRET, fields: ['unexpected'] })
    expect(unknownIn('hook', { hook_event_name: 'x y <z>', session_id: 's' }, k).event).toBe('<name>')
    expect(unknownIn('statusline', { session_id: 's', new_meter: {} }, { fields: defaultOf(knownIds('claude-code').statusFields) })).toEqual({ event: null, fields: ['new_meter'] })
    expect([unknownIn('hook', { x: 1 }, {}), unknownIn('hook', null, k), unknownIn('hook', [1], k)]).toEqual([{ event: null, fields: [] }, { event: null, fields: [] }, { event: null, fields: [] }])
  })

  it('the pattern trigger is off by default: its default never matches; the others are off', () => {
    expect(ADVANCED_DEFS.find((d) => d.id === 'cw.recorder.pattern')?.default).toBe(FLIGHT_PATTERN_OFF)
    expect(new RegExp(FLIGHT_PATTERN_OFF, 'i').test('hook Stop: anything at all')).toBe(false)
    for (const t of ['safeguard', 'unknown', 'version', 'stalled']) expect(ADVANCED_DEFS.find((d) => d.id === `cw.recorder.${t}`)?.default).toBe(false)
  })
})

describe("the console's flight mode", async () => {
  const { DevConsole, FLIGHT_MAX_SOURCES, FLIGHT_RING_EVENTS } = await import('../src/main/devConsole')
  const a = sessionSourceId('C:\\ws\\alpha', 'a1')
  const hive = hiveSourceId('C:\\ws')
  const ev = (n: number) => () => ({ kind: 'hook' as const, name: `Hook ${n}`, summary: `hook ${n}`, raw: { prompt: 'secret words', token: SECRET } })

  it('keeps the sources it is given whether watched or not, redacted, bounded, and nothing once off', () => {
    const c = new DevConsole()
    c.capture([a], ev(0))
    expect([c.capturing(a), c.flightEvents(a)]).toEqual([false, []])
    const kept: string[] = []
    c.setFlight((s) => s.startsWith('session:'), (e) => kept.push(e.name))
    expect([c.capturing(a), c.capturing(hive)]).toEqual([true, false])
    for (let i = 1; i <= FLIGHT_RING_EVENTS + 5; i++) c.capture([a, hive], ev(i))
    const events = c.flightEvents(a)
    expect(events.length).toBe(FLIGHT_RING_EVENTS)
    expect(events.at(-1)!.name).toBe(`Hook ${FLIGHT_RING_EVENTS + 5}`)
    expect(kept.length).toBe(FLIGHT_RING_EVENTS + 5)
    // Redacted as capture is: no text, no secret.
    expect(JSON.stringify(events)).not.toMatch(/secret words|sk-abc/)
    // The console's own rings and readers aren't touched: nobody watches.
    expect([c.events(a), c.flightEvents(hive), c.stats().sources]).toEqual([[], [], 0])
    // The least recently written sources go past the bound.
    for (let i = 0; i <= FLIGHT_MAX_SOURCES; i++) c.capture([sessionSourceId('C:\\ws\\p', `x${i}`)], ev(i))
    expect(c.stats().flightSources).toBe(FLIGHT_MAX_SOURCES)
    expect(c.flightEvents(a)).toEqual([])
    c.setFlight(null)
    c.capture([sessionSourceId('C:\\ws\\p', 'x1')], ev(1))
    expect([c.capturing(a), c.stats().flightSources, c.flightEvents(sessionSourceId('C:\\ws\\p', 'x1'))]).toEqual([false, 0, []])
  })

  it('a watched source is kept in both: the console sees it as before', () => {
    const c = new DevConsole()
    c.setFlight((s) => s.startsWith('session:'))
    c.subscribe('w', [a])
    c.capture([a], ev(1))
    expect([c.events(a).length, c.flightEvents(a).length]).toEqual([1, 1])
  })
})

describe('captures and triggers', async () => {
  process.env.HIVE_TEST_FLIGHT_AFTER_MS = '1'
  const { devConsole } = await import('../src/main/devConsole')
  const { saveCapture, listCaptures, recordingsDir, latestRecording } = await import('../src/main/consoleRecorder')
  const { flightRecorder, FLIGHT_MAX_PENDING } = await import('../src/main/flightRecorder')
  /** The agents running, by console source, as sessions.ts would say. */
  const running = new Map<string, { projectPath: string; agentId: string; provider: string; label: () => string }>()
  flightRecorder.start((source) => running.get(source) ?? null)
  let n = 0
  const agent = () => ({ projectPath: `C:\\ws\\proj${++n}`, agentId: 'a1', provider: 'claude-code' })
  const run = (w: ReturnType<typeof agent>, label = 'proj · R') => {
    running.set(sessionSourceId(w.projectPath, w.agentId), { ...w, label: () => label })
    return w
  }
  const captures = () => readdirSync(recordingsDir()).filter((f) => f.endsWith('-capture.jsonl'))
  const fileOf = (name: string) => parseRecording(readFileSync(join(recordingsDir(), name), 'utf8'))
  /** Lets every capture waiting be saved, or dropped: waits until none is. */
  const settled = () => vi.waitFor(() => expect(flightRecorder.sizes().pending).toBe(0), { timeout: 10_000 })
  beforeEach(() => {
    toasts.list = []
  })
  afterEach(async () => {
    await settled()
    set({})
  })

  it('a capture is a redacted recording with its trigger; only the newest kept are kept; Copy Diagnostics sees the newest', async () => {
    const e = { seq: 1, at: new Date().toISOString(), source: 's', kind: 'hook' as const, name: 'Stop', summary: 'stop', bytes: 10 }
    for (let i = 0; i < 4; i++) await saveCapture({ source: { kind: 'session', label: 'proj · A', provider: 'claude-code' }, events: [e], trigger: 'safeguard', what: `stop ${i}`, keep: 3 })
    expect(captures().length).toBe(3)
    const list = await listCaptures()
    expect(list.map((c) => c.capture?.what)).toEqual(['stop 3', 'stop 2', 'stop 1'])
    const r = fileOf(list[0].name)
    expect([r.header?.text, r.header?.capture, r.end?.reason, r.events.length]).toEqual([false, { trigger: 'safeguard', what: 'stop 3' }, 'captured', 1])
    expect((await latestRecording())?.capture?.what).toBe('stop 3')
  })

  it('every trigger off: nothing is kept and nothing fires', async () => {
    const who = agent()
    flightRecorder.safeguard(who, () => 'proj · A', { kind: 'stop', model: 'opus' })
    devConsole.capture([sessionSourceId(who.projectPath, who.agentId)], () => ({ kind: 'hook', name: 'Stop', summary: 'stop' }))
    expect([devConsole.capturing(sessionSourceId(who.projectPath, who.agentId)), devConsole.stats().flightSources, toasts.list]).toEqual([false, 0, []])
  })

  it('a trigger saves the events before it and a notice, once per agent per period', async () => {
    set({ 'cw.recorder.safeguard': true })
    const who = agent()
    const source = sessionSourceId(who.projectPath, who.agentId)
    devConsole.capture([source], () => ({ kind: 'hook', name: 'PreToolUse', summary: 'before it', raw: { prompt: 'secret words' } }))
    const before = captures().length
    flightRecorder.safeguard(who, () => 'proj · A', { kind: 'stop', model: 'opus' })
    flightRecorder.safeguard(who, () => 'proj · A', { kind: 'stop', model: 'opus' })
    await vi.waitFor(() => expect(toasts.list.length).toBe(1), { timeout: 10_000 })
    const t = toasts.list[0]
    expect(t.title).toBe('Captured a safeguard stop on proj · A')
    expect(t.actions?.[0]).toMatchObject({ command: 'console.showCapture' })
    expect(t.source).toBe(who.projectPath)
    const r = fileOf(String(t.actions![0].args![0]))
    expect(r.header?.capture).toEqual({ trigger: 'safeguard', what: 'safeguards stopped a response on opus', whatText: { id: 'safeguardStopOn', values: { model: 'opus' } } })
    expect(r.events.map((e) => `${e.kind} ${e.name}`)).toEqual(['hook PreToolUse', 'trigger safeguard'])
    expect(JSON.stringify(r)).not.toContain('secret words')
    expect(captures().length).toBe(before + 1)
    // Within the period: nothing more for that agent and trigger; another agent still fires.
    flightRecorder.safeguard(who, () => 'proj · A', { kind: 'switch', from: 'opus', to: 'sonnet' })
    flightRecorder.safeguard(agent(), () => 'proj · B', { kind: 'switch', from: 'opus', to: 'sonnet' })
    await vi.waitFor(() => expect(toasts.list.length).toBe(2), { timeout: 10_000 })
    expect(toasts.list[1].title).toBe('Captured a safeguard stop on proj · B')
  })

  it('unknown events and fields, a version change, a silence and a pattern each fire when on', async () => {
    set({ 'cw.recorder.unknown': true, 'cw.recorder.version': true, 'cw.recorder.stalled': true, 'cw.recorder.pattern': 'needle' })
    const who = agent()
    const label = () => 'proj · C'
    flightRecorder.arrived(who, label, 'hook', { hook_event_name: 'Stop', session_id: 's', stop_hook_active: false })
    expect(toasts.list).toEqual([])
    flightRecorder.arrived(who, label, 'hook', { hook_event_name: 'Stop', session_id: 's', brand_new_field: 1 })
    flightRecorder.arrived(agent(), label, 'hook', { hook_event_name: 'FutureHookEvent', session_id: 's' })
    flightRecorder.launched(who, label, '2.1.999')
    flightRecorder.launched(agent(), label, '2.1.999')
    flightRecorder.launched(agent(), label, '2.2.0')
    flightRecorder.stalled(who, label, 300_000)
    const watched = run(agent())
    devConsole.capture([sessionSourceId(watched.projectPath, watched.agentId)], () => ({ kind: 'terminal', name: 'title', summary: 'found the needle' }))
    await vi.waitFor(() => expect(toasts.list.length).toBe(5), { timeout: 10_000 })
    const whats = toasts.list.map((t) => t.message ?? '')
    expect(whats.some((w) => /hook Stop with fields Combwork doesn't know: brand_new_field/.test(w))).toBe(true)
    expect(whats.some((w) => /hook FutureHookEvent, an event Combwork doesn't know/.test(w))).toBe(true)
    expect(whats.some((w) => /claude-code 2\.1\.999 → 2\.2\.0/.test(w))).toBe(true)
    expect(whats.some((w) => /silent in a turn for 300 s/.test(w))).toBe(true)
    expect(whats.some((w) => /terminal title: found the needle/.test(w))).toBe(true)
  })

  it("the notice and the list say what a capture saw in Combwork's language; the file keeps its English beside it", async () => {
    const PL = join(__dirname, '..', 'locales', 'pl')
    const polish = Object.assign({}, ...readdirSync(PL).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(PL, f), 'utf8'))))
    set({ 'cw.recorder.safeguard': true, 'cw.recorder.unknown': true })
    setLanguage('pl', polish, 'pl-PL')
    try {
      flightRecorder.safeguard(agent(), () => 'proj · P', { kind: 'stop', model: 'opus' })
      flightRecorder.arrived(agent(), () => 'proj · Q', 'hook', { hook_event_name: 'Stop', session_id: 's', brand_new: 1 })
      await vi.waitFor(() => expect(toasts.list.length).toBe(2), { timeout: 10_000 })
      for (const t of toasts.list) expect(`${t.title} ${t.message}`).not.toMatch(/Captured|saved|safeguards stopped|doesn't know/)
      expect(toasts.list.map((t) => t.message).join()).toMatch(/opus/)
      // The two saves finish in either order: the safeguard's notice is the one naming its model.
      const guard = toasts.list.find((t) => /opus/.test(t.message ?? ''))!
      const file = fileOf(String(guard.actions![0].args![0]))
      expect(file.header?.capture?.what).toBe('safeguards stopped a response on opus')
      const listed = (await listCaptures()).find((c) => c.name === guard.actions![0].args![0])
      expect(listed?.capture?.whatText).toEqual({ id: 'safeguardStopOn', values: { model: 'opus' } })
    } finally {
      setLanguage('en', {})
    }
  })

  it('what a capture says it saw is masked in its file, its notice and the list, as events are', async () => {
    set({ 'cw.recorder.unknown': true, 'cw.recorder.safeguard': true })
    flightRecorder.arrived(agent(), () => 'proj · D', 'hook', { hook_event_name: SECRET, unexpected: 1 })
    flightRecorder.safeguard(agent(), () => 'proj · E', { kind: 'switch', from: SECRET, to: 'sonnet' })
    await vi.waitFor(() => expect(toasts.list.length).toBe(2), { timeout: 10_000 })
    for (const t of toasts.list) {
      expect(`${t.title} ${t.message}`).not.toContain(SECRET)
      expect(readFileSync(join(recordingsDir(), String(t.actions![0].args![0])), 'utf8')).not.toContain(SECRET)
    }
    expect(JSON.stringify(await listCaptures())).not.toContain(SECRET)
  })

  it('holds a bounded number of cooldowns and captures, waiting or being written, and nothing once every trigger is off', async () => {
    set({ 'cw.recorder.pattern': 'needle' })
    // A burst on many agents: at most so many captures are held at once.
    const many = Array.from({ length: 60 }, () => run(agent()))
    let release!: () => void
    disk.gate = new Promise((r) => (release = r))
    for (const w of many) devConsole.capture([sessionSourceId(w.projectPath, w.agentId)], () => ({ kind: 'terminal', name: 'title', summary: 'needle' }))
    expect(flightRecorder.sizes().pending).toBe(FLIGHT_MAX_PENDING)
    // A stuck disk: their writes began and hang; they still hold their slots, and nothing more is taken on.
    await vi.waitFor(() => expect(disk.writes).toBe(FLIGHT_MAX_PENDING), { timeout: 10_000 })
    for (const w of Array.from({ length: 20 }, () => run(agent()))) devConsole.capture([sessionSourceId(w.projectPath, w.agentId)], () => ({ kind: 'terminal', name: 'title', summary: 'needle' }))
    expect([flightRecorder.sizes().pending, disk.writes]).toEqual([FLIGHT_MAX_PENDING, FLIGHT_MAX_PENDING])
    // The disk recovers: each write settles and frees its slot.
    disk.gate = null
    release()
    await settled()
    expect(flightRecorder.sizes().pending).toBe(0)
    // Every trigger off: the recorder holds nothing.
    set({})
    expect(flightRecorder.sizes()).toEqual({ cooldowns: 0, pending: 0 })
  })

  it('the pattern trigger catches an agent that was running before it was set, and again after every trigger was off', async () => {
    const w = run(agent(), 'proj · S')
    const needle = () => devConsole.capture([sessionSourceId(w.projectPath, w.agentId)], () => ({ kind: 'terminal', name: 'title', summary: 'a needle' }))
    needle()
    expect(toasts.list).toEqual([])
    set({ 'cw.recorder.pattern': 'needle' })
    needle()
    await vi.waitFor(() => expect(toasts.list.length).toBe(1), { timeout: 10_000 })
    expect(toasts.list[0].title).toBe('Captured an event matching your pattern on proj · S')
    await settled()
    set({})
    set({ 'cw.recorder.pattern': 'needle' })
    needle()
    await vi.waitFor(() => expect(toasts.list.length).toBe(2), { timeout: 10_000 })
    // An agent no longer running: nothing to say it is, so nothing captured.
    running.delete(sessionSourceId(w.projectPath, w.agentId))
    await settled()
    set({})
    set({ 'cw.recorder.pattern': 'needle' })
    needle()
    expect(flightRecorder.sizes().pending).toBe(0)
  })

  it('a trigger turned off stops at once: its capture waiting is dropped, another trigger still on saves its own', async () => {
    process.env.HIVE_TEST_FLIGHT_AFTER_MS = '300'
    try {
      // Many kept, so this test's capture isn't pruned by the earlier ones.
      set({ 'cw.recorder.safeguard': true, 'cw.recorder.stalled': true, 'cw.recorder.keep': 200 })
      const before = captures().length
      flightRecorder.safeguard(agent(), () => 'proj · F', { kind: 'stop' })
      flightRecorder.stalled(agent(), () => 'proj · G', 1000)
      expect(flightRecorder.sizes().pending).toBe(2)
      set({ 'cw.recorder.stalled': true, 'cw.recorder.keep': 200 })
      expect(flightRecorder.sizes().pending).toBe(1)
      await vi.waitFor(() => expect(toasts.list.length).toBe(1), { timeout: 10_000 })
      expect(toasts.list[0].title).toBe('Captured a silence past its limit on proj · G')
      // And off altogether before its wait ends: nothing is written.
      flightRecorder.stalled(agent(), () => 'proj · H', 1000)
      set({})
      await settled()
      expect(captures().length).toBe(before + 1)
      expect(toasts.list.length).toBe(1)
    } finally {
      process.env.HIVE_TEST_FLIGHT_AFTER_MS = '1'
    }
  })

  it('a damaged versions file counts as none: no failure, and versions are kept from then on', async () => {
    const { flightRecorder: fresh } = await import('../src/main/flightRecorder?damaged' as string)
    writeFileSync(join(profile.dir, 'flight-recorder.json'), '{broken')
    set({ 'cw.recorder.version': true })
    const rejected: unknown[] = []
    const onRejection = (e: unknown) => rejected.push(e)
    process.on('unhandledRejection', onRejection)
    try {
      fresh.start()
      fresh.launched(agent(), () => 'proj · I', '3.0.0')
      await vi.waitFor(() => expect(JSON.parse(readFileSync(join(profile.dir, 'flight-recorder.json'), 'utf8')).versions['claude-code']).toBe('3.0.0'), { timeout: 10_000 })
      fresh.launched(agent(), () => 'proj · I', '3.1.0')
      await vi.waitFor(() => expect(toasts.list.some((t) => /3\.0\.0 → 3\.1\.0/.test(t.message ?? ''))).toBe(true), { timeout: 10_000 })
      expect(rejected).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
      fresh.stop()
    }
  })
})
