import { ADVANCED_DEFS, advancedDef, advancedRegExp, literalRegExp, overrideId } from '../shared/advanced'
import type { ProviderId } from '../shared/types'

/**
 * The advanced settings (#367) as the CLIs' transcript parsers read them (#1106): the parsers also run in the usage
 * worker (usageWorker.ts), which can't load Electron, so they read values here rather than from AdvancedStore (main's
 * advanced.ts, which makes itself the reader when it loads). In the worker the reader is the values main sent; before
 * either (unit tests), every value is its default.
 */
export interface AdvancedReader {
  get<T extends string | number | string[] | boolean>(id: string): T
  pattern(id: string): RegExp
}

/** A reader of resolved values (each setting's value as it applies), the default for any not given. */
export function valuesReader(values: Record<string, unknown>): AdvancedReader {
  const patterns = new Map<string, { source: string; re: RegExp }>()
  const get = <T>(id: string): T => {
    const def = advancedDef(id)
    if (!def) throw new Error(`No advanced setting "${id}"`) // i18n-ignore: a programming error (an id Combwork's code asks for), for the log
    return (id in values ? values[id] : def.default) as T
  }
  return {
    get,
    pattern: (id) => {
      const def = advancedDef(id)!
      const source = get<string>(id)
      const was = patterns.get(id)
      if (was?.source === source) return was.re
      const re = def.kind === 'text' ? literalRegExp(source) : advancedRegExp(def, source)
      patterns.set(id, { source, re })
      return re
    }
  }
}

let reader: AdvancedReader = valuesReader({})

/** What the parsers read: the reader set last. */
export const advancedValues: AdvancedReader = {
  get: <T extends string | number | string[] | boolean>(id: string) => reader.get<T>(id),
  pattern: (id) => reader.pattern(id)
}

/**
 * Whether Combwork applies one of its overrides of a CLI in its own runs of it, not a session's (#1167; HI-2670: Copilot's
 * sign-in check and model catalogue): the switch is each connection's now, so these follow the CLI's connections (main's
 * connectionLaunch.ts sets how), off only when every one has it off. A session reads its own connection's (LaunchContext.overrides).
 */
let ownRuns: (provider: ProviderId, what: string) => boolean = (provider, what) => advancedValues.get<boolean>(overrideId(provider, what))
export const overrides = (provider: ProviderId, what: string): boolean => ownRuns(provider, what)

/** Sets how Combwork's own runs of a CLI read its overrides (main, from the connections; tests). */
export function readOwnRunOverridesWith(fn: (provider: ProviderId, what: string) => boolean): void {
  ownRuns = fn
}

/**
 * A provider's override switches as they are now, by id: a launch reads them once as it is prepared
 * (LaunchContext.overrides), so its stages (prepareLaunch, then buildCommand after awaits) agree when one changes meanwhile.
 */
export function overridesNow(provider: ProviderId): Record<string, boolean> {
  return Object.fromEntries(ADVANCED_DEFS.filter((d) => d.override && d.group === provider).map((d) => [d.id, overrides(provider, d.id.slice(overrideId(provider, '').length))]))
}

/** One switch as a launch read it when it was prepared (overridesNow), or as it is now for a launch given none. */
export const launchOverrides = (taken: Readonly<Record<string, boolean>> | undefined, provider: ProviderId, what: string): boolean => taken?.[overrideId(provider, what)] ?? overrides(provider, what)

/** Makes `r` the parsers' reader (main's AdvancedStore; the worker's values from main). */
export function readAdvancedFrom(r: AdvancedReader): void {
  reader = r
}

/** Every setting's value as it applies now, for the worker. */
export function resolvedValues(r: AdvancedReader): Record<string, unknown> {
  return Object.fromEntries(ADVANCED_DEFS.map((d) => [d.id, r.get(d.id)]))
}
