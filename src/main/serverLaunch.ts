import type { ServerCaps } from '../shared/providers'
import type { ServerModel } from '../shared/types'
import { fillArgs } from './providers/cliAdapter'

/**
 * A server connection's values in a launch from its CLI's templates (HI-3197: a data-only CLI's description, combwork-cli
 * once it is a provider): its server's URL, its key (or the CLI's stand-in for a local server with none), the launch's
 * own model as finally resolved, and that model's context and output as the user set them on the server (HI-2682). A
 * variable or argument naming a value the launch hasn't is left out. `names`: every variable the templates name, which a
 * launch on the CLI's own setup (no server) is given none of, whatever Combwork's own environment has.
 */
export interface ServerLaunchValues {
  env: Record<string, string>
  args: string[]
  names: string[]
}

/** The server a launch runs on, as connectionForLaunch prepared it (its key decrypted for this launch alone). */
export interface ServerOn {
  baseUrl: string
  key: string | null
  models: readonly ServerModel[]
}

export function serverLaunch(caps: ServerCaps, on: ServerOn | null, model: string | null): ServerLaunchValues {
  const t = caps.launch
  if (!t) return { env: {}, args: [], names: [] }
  const names = Object.keys(t.env)
  if (!on) return { env: {}, args: [], names }
  const entry = model ? on.models.find((m) => m.id === model) : undefined
  const values: Record<string, string | null> = {
    baseUrl: on.baseUrl,
    key: on.key ?? caps.keylessToken,
    model: model || null,
    context: entry?.context ? String(entry.context) : null,
    output: entry?.output ? String(entry.output) : null
  }
  const env: Record<string, string> = {}
  for (const [name, template] of Object.entries(t.env)) {
    const filled = fillArgs([template], values)
    if (filled.length) env[name] = filled[0]
  }
  // Never the key on a command line (cliDescription.ts refuses it there too): a process's arguments are seen by others.
  const args = fillArgs(t.args ?? [], { ...values, key: null })
  return { env, args, names }
}
