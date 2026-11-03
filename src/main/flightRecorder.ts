import { join } from 'path'
import { readFile } from 'original-fs/promises'
import { app } from 'electron'
import { advanced } from './advanced'
import { devConsole } from './devConsole'
import { saveCapture } from './consoleRecorder'
import { toast } from './events'
import { writeTextAtomic } from './fsutil'
import { createLogger, userText } from './logger'
import { workspace } from './workspace'
import { msg, tr, type Msg } from '../shared/i18n'
import { sessionSourceId, type ConsoleEvent } from '../shared/devConsole'
import { FLIGHT_PATTERN_OFF, FLIGHT_TRIGGER_NAME, FLIGHT_WHAT, knownIds, unknownIn, type FlightTrigger, type FlightWhat } from '../shared/flightRecorder'
import { englishText, withValues } from '../shared/advanced'
import { maskText } from '../shared/redact'

/**
 * The developer console's flight recorder (#698): when something rare happens to an agent, its newest console events
 * (before it, and for a short while after) are saved as a capture, a recording like the user's (consoleRecorder.ts),
 * redacted, with a notice. Each trigger is opt-in (Settings → Advanced, `hive.recorder.<trigger>`, off by default); while
 * one is on, the console keeps every agent's events in a small ring whether a console is open or not
 * (`DevConsole.setFlight`), and with all off it keeps nothing. One capture per trigger per agent every
 * `hive.recorder.minutes`; the newest `hive.recorder.keep` captures are kept. What a capture says of its trigger is
 * recorded data, in English (#1104); the notice is in Hive's language.
 */

const log = createLogger('console')

/** How long after a trigger its capture waits, for what follows it (an advanced value). Unpackaged test builds can shorten it (HIVE_TEST_FLIGHT_AFTER_MS). */
const afterMs = (): number => (!app.isPackaged && Number(process.env.HIVE_TEST_FLIGHT_AFTER_MS) > 0 ? Number(process.env.HIVE_TEST_FLIGHT_AFTER_MS) : advanced.number('hive.recorder.afterSeconds') * 1000)

/** Bounds on what the recorder holds besides the console's rings: cooldowns, and captures waiting or being written. */
export const FLIGHT_MAX_COOLDOWNS = 1000
export const FLIGHT_MAX_PENDING = 20

/** What a capture says it saw: masked as an event's summary is (secrets, sign-ins), and cut short. */
const clean = (what: string): string => maskText(what).slice(0, 300)

const SETTING: Record<FlightTrigger, string> = {
  safeguard: 'hive.recorder.safeguard',
  unknown: 'hive.recorder.unknown',
  version: 'hive.recorder.version',
  stalled: 'hive.recorder.stalled',
  pattern: 'hive.recorder.pattern'
}

const M = {
  captured: msg({ id: 'console.flight.captured', defaultMessage: 'Captured {trigger} on {agent}', description: "A notice: the developer console's flight recorder saved an agent's recent events because something rare happened. {trigger} is what (\"a safeguard stop\"), {agent} the agent." }),
  capturedDetail: msg({ id: 'console.flight.capturedDetail', defaultMessage: '{events, plural, one {# event} other {# events}} saved, redacted: {what}', description: "The notice that the flight recorder saved a capture: how many developer console events it holds, and what it saw (\"safeguards stopped a response on claude-opus-5-5\", itself translated)." }),
  show: msg({ id: 'console.flight.show', defaultMessage: 'Show in Folder', description: "A button on the flight recorder's notice: shows the capture's file in File Explorer." }),
  failed: msg({ id: 'console.flight.failed', defaultMessage: "Couldn't save the capture of {agent}", description: "A warning: the developer console's flight recorder couldn't write its capture. The reason follows." })
}

/** The agent a trigger fired on: its session as sessions.ts has it, and its name as Hive shows it. */
export interface FlightAgent {
  projectPath: string
  agentId: string
  provider: string
  label: () => string
}

class FlightRecorder {
  /** When each trigger last fired on each agent ("<trigger>|<source>"): kept for its cooldown only, at most FLIGHT_MAX_COOLDOWNS. */
  private last = new Map<string, number>()
  /**
   * Captures by trigger and agent, from their trigger until their file is written (or they are dropped): waiting, then
   * writing. At most FLIGHT_MAX_PENDING, a slow disk included: a slot is free only once its write has settled.
   */
  private jobs = new Map<string, { trigger: FlightTrigger; timer: ReturnType<typeof setTimeout> | null }>()
  /** The running agent a console source is (sessions.ts gives it): the pattern trigger finds who an event is of when it matches. */
  private agentOf: (source: string) => FlightAgent | null = () => null
  /** Each CLI's version at its last launch (in the profile), for the version trigger. */
  private versions: Promise<Record<string, string>> | null = null
  private active = false
  private started = false

  /** Follows the settings: the console keeps agents' events while a trigger is on, and nothing while none is. `agentOf`: the running agent a source is. */
  start(agentOf?: (source: string) => FlightAgent | null): void {
    if (agentOf) this.agentOf = agentOf
    if (this.started) return
    this.started = true
    advanced.onChange(() => this.refresh())
    this.refresh()
  }

  private on(trigger: FlightTrigger): boolean {
    try {
      return trigger === 'pattern' ? advanced.get<string>(SETTING.pattern) !== FLIGHT_PATTERN_OFF : advanced.get<boolean>(SETTING[trigger]) === true
    } catch {
      return false
    }
  }

  /**
   * A setting changed: a trigger turned off stops at once (its captures waiting are dropped; one being written checked
   * its trigger as it began); with every one off, the recorder holds nothing (the console's rings, the cooldowns).
   */
  private refresh(): void {
    this.active = (Object.keys(SETTING) as FlightTrigger[]).some((t) => this.on(t))
    for (const [key, job] of this.jobs) {
      if ((this.active && this.on(job.trigger)) || !job.timer) continue
      clearTimeout(job.timer)
      this.jobs.delete(key)
    }
    if (!this.active) this.last.clear()
    devConsole.setFlight(this.active ? (s) => s.startsWith('session:') : null, this.on('pattern') ? (e) => this.matched(e) : null)
  }

  /** The pattern trigger: an event (not a trigger's own) whose name or summary the pattern finds. */
  private matched(e: ConsoleEvent): void {
    if (e.kind === 'trigger') return
    let re: RegExp
    try {
      re = advanced.pattern(SETTING.pattern)
    } catch {
      return
    }
    if (!re.test(`${e.name} ${e.summary}`)) return
    // Whoever the source is now: an agent started before the pattern was set too.
    const who = this.agentOf(e.source)
    // The event as the console recorded it: its kind, name and summary, in English (#1104).
    if (who) this.fire('pattern', who, { id: 'pattern', values: { event: `${e.kind} ${e.name}: ${e.summary}`.slice(0, 200) } })
  }

  /** An agent launched: the version trigger when its CLI's version changed since the last launch. */
  launched(st: { projectPath: string; agentId: string; provider: string }, label: () => string, version: string | null | undefined): void {
    if (version) this.noteVersion({ projectPath: st.projectPath, agentId: st.agentId, provider: st.provider, label }, version).catch((e) => log.warn('flight recorder: could not note the CLI version', e))
  }

  private async noteVersion(who: FlightAgent, version: string): Promise<void> {
    const file = join(app.getPath('userData'), 'flight-recorder.json')
    // Read once, by every launch at once alike; a file that is missing, damaged or not as written counts as none.
    this.versions ??= readFile(file, 'utf8').then(
      (text) => {
        try {
          const v = JSON.parse(text)?.versions
          if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
          return Object.fromEntries(Object.entries(v).filter(([k, x]) => k.length <= 40 && typeof x === 'string' && x.length <= 40).slice(0, 20)) as Record<string, string>
        } catch {
          return {}
        }
      },
      () => ({})
    )
    const versions = await this.versions
    const was = versions[who.provider]
    const now = version.slice(0, 40)
    if (was === now) return
    versions[who.provider] = now
    // Kept whether the trigger is on or not, so turning it on later doesn't fire for a change long past.
    await writeTextAtomic(file, `${JSON.stringify({ versions })}\n`).catch((e) => log.warn('flight recorder: could not keep the CLI versions', e))
    if (was) this.fire('version', who, { id: 'version', values: { provider: who.provider, from: was, to: now } })
  }

  /** A model's safeguards stopped a response or switched the model (sessions.ts noteSafeguard). */
  safeguard(st: { projectPath: string; agentId: string; provider: string }, label: () => string, ev: { kind: 'stop' | 'switch'; model?: string; from?: string; to?: string }): void {
    if (!this.on('safeguard')) return
    const model = (m: string | undefined): string => (m ?? '').slice(0, 80)
    const what: FlightWhat = ev.kind === 'switch' ? { id: 'modelSwitch', values: { from: model(ev.from) || '?', to: model(ev.to) || '?' } } : ev.model ? { id: 'safeguardStopOn', values: { model: model(ev.model) } } : { id: 'safeguardStop', values: {} }
    this.fire('safeguard', { ...st, label }, what)
  }

  /** What a CLI is known to send, as its advanced values list it (none for a CLI without them). */
  private known(id: string): readonly string[] | undefined {
    try {
      return advanced.get<string[]>(id)
    } catch {
      return undefined
    }
  }

  /** A hook or status line arrived: the unknown trigger when it is an event, or has a field, Hive doesn't know. */
  arrived(st: { projectPath: string; agentId: string; provider: string }, label: () => string, kind: 'hook' | 'statusline', body: Record<string, unknown>): void {
    if (!this.on('unknown')) return
    const ids = knownIds(st.provider)
    const found = kind === 'hook' ? unknownIn('hook', body, { events: this.known(ids.events), fields: this.known(ids.fields) }) : unknownIn('statusline', body, { fields: this.known(ids.statusFields) })
    if (!found.event && !found.fields.length) return
    const named = typeof body.hook_event_name === 'string' ? body.hook_event_name : typeof body.hookEventName === 'string' ? body.hookEventName : ''
    // The event's name only once it is a known one, or as unknownIn made it safe.
    const name = kind !== 'hook' ? '' : (found.event ?? (this.known(ids.events)?.includes(named) ? named : ''))
    const fields = found.fields.join(', ')
    const what: FlightWhat =
      kind !== 'hook' ? { id: 'unknownStatusFields', values: { fields } }
      : found.event ? (fields ? { id: 'unknownEventFields', values: { event: found.event, fields } } : { id: 'unknownEvent', values: { event: found.event } })
      : name ? { id: 'unknownHookFields', values: { event: name, fields } }
      : { id: 'unknownFields', values: { fields } }
    this.fire('unknown', { ...st, label }, what)
  }

  /** An agent working on a turn went silent past its limit: its state is unknown (sessions.ts checkSilence). */
  stalled(st: { projectPath: string; agentId: string; provider: string }, label: () => string, silentMs: number | null): void {
    this.fire('stalled', { ...st, label }, { id: 'stalled', values: { seconds: Math.round((silentMs ?? 0) / 1000) } })
  }

  /**
   * A trigger fired on an agent: unless it is off, fired on that agent within the last `hive.recorder.minutes`, or as many
   * captures as the recorder holds are waiting, it is noted as an event of the agent's own (kind `trigger`), and its
   * capture is written a short while later. What it saw is masked as an event's summary is: each value, and its English.
   */
  private fire(trigger: FlightTrigger, who: FlightAgent, seen: FlightWhat): void {
    if (!this.on(trigger)) return
    const shown: FlightWhat = { id: seen.id, values: Object.fromEntries(Object.entries(seen.values).map(([k, v]) => [k, typeof v === 'string' ? clean(v) : v])) }
    // window: what the flight recorder saw, in its recording's header (the developer console)
    const what = clean(englishText(withValues(FLIGHT_WHAT[shown.id], shown.values)))
    const source = sessionSourceId(who.projectPath, who.agentId)
    const key = `${trigger}|${source}`
    const now = Date.now()
    const every = Math.max(1, advanced.number('hive.recorder.minutes')) * 60_000
    if (this.jobs.has(key) || now - (this.last.get(key) ?? -Infinity) < every) return
    if (this.jobs.size >= FLIGHT_MAX_PENDING) return log.warn(`flight recorder: ${trigger} on ${userText(who.label())} not captured: ${FLIGHT_MAX_PENDING} captures are waiting or being written`)
    // Cooldowns that have run out are forgotten; past the bound, the oldest go.
    for (const [k, at] of this.last) if (now - at >= every) this.last.delete(k)
    this.last.delete(key)
    this.last.set(key, now)
    while (this.last.size > FLIGHT_MAX_COOLDOWNS) this.last.delete(this.last.keys().next().value!)
    devConsole.capture([source], () => ({ kind: 'trigger', name: trigger, summary: what, provider: who.provider }))
    log.info(`flight recorder: ${trigger} on ${userText(who.label())} (${userText(what)}); capturing`)
    const job: { trigger: FlightTrigger; timer: ReturnType<typeof setTimeout> | null } = { trigger, timer: null }
    job.timer = setTimeout(() => {
      if (this.jobs.get(key) !== job) return
      // Writing: its slot stays taken until the write settles, however long the disk takes.
      job.timer = null
      void this.save(trigger, who, source, what, shown).finally(() => {
        if (this.jobs.get(key) === job) this.jobs.delete(key)
      })
    }, afterMs())
    job.timer.unref?.()
    this.jobs.set(key, job)
  }

  private async save(trigger: FlightTrigger, who: FlightAgent, source: string, what: string, shown: FlightWhat): Promise<void> {
    // Turned off meanwhile: nothing is saved.
    if (!this.on(trigger)) return
    const label = who.label()
    try {
      const events = devConsole.flightEvents(source)
      const kind = workspace.isAssistantHome(who.projectPath) ? 'assistant' : 'session'
      const info = await saveCapture({ source: { kind, label, provider: who.provider as never }, events, trigger, what, whatText: shown, keep: advanced.number('hive.recorder.keep') })
      log.info(`flight recorder: saved ${info.name} (${trigger}, ${events.length} events)`)
      toast('info', tr(M.captured, { trigger: tr(FLIGHT_TRIGGER_NAME[trigger]), agent: label }), tr(M.capturedDetail, { events: events.length, what: tr(FLIGHT_WHAT[shown.id] as Msg, shown.values as never) }), [{ label: tr(M.show), command: 'console.showCapture', args: [info.name] }], who.projectPath)
    } catch (e) {
      log.warn(`flight recorder: couldn't save the ${trigger} capture of ${userText(label)}`, e)
      toast('warning', tr(M.failed, { agent: label }), String((e as Error)?.message ?? e), undefined, who.projectPath)
    }
  }

  /** What the recorder holds (tests): cooldowns, and captures waiting or being written. */
  sizes(): { cooldowns: number; pending: number } {
    return { cooldowns: this.last.size, pending: this.jobs.size }
  }

  /** Captures waiting to be written are dropped (Hive quitting). */
  stop(): void {
    for (const job of this.jobs.values()) if (job.timer) clearTimeout(job.timer)
    this.jobs.clear()
  }
}

export const flightRecorder = new FlightRecorder()
