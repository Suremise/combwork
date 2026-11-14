import { msg } from '../i18n/msg'
import { agentMsg, say } from '../agentText'
import { withValues, type AdvancedDef, type AdvancedSource, type Text } from '../advancedDef'
import { CLI_OWN_MODE, withCliOwn } from '../cliOwnMode'
import type { ModeOption, ModelGroup, ProviderDescriptor } from '.'
import { defineProvider, type ProviderModule } from './parts'
import { SERVER_PROTOCOLS } from './common'

/**
 * A data-only provider (HI-3196): a CLI Combwork runs from a description alone, with one generic adapter
 * (main/providers/cliAdapter.ts) and no code of its own. A description is plain JSON, never code: the binary and how it
 * is found, the launch's arguments, how the first prompt goes in, the permission modes as arguments, how a session is
 * resumed by Combwork's id, and the screen rules its status is read by. A user's own are files in the profile's `clis`
 * folder (main/clis.ts); each is checked here before it is used, and one that doesn't check out is never registered.
 *
 * Such a CLI has no hooks, transcript, usage, accounts or Combwork tools: its adapter has only the install, launch,
 * terminal and (with modes) modes parts, and providerGaps says plainly what it lacks.
 */

/** What a launch's argument may name, each replaced by the launch's value: the model, the folder, the first prompt, the session id. */
export const CLI_PLACEHOLDERS = ['model', 'cwd', 'prompt', 'id'] as const

/**
 * What a server connection's variables and arguments may name (HI-3197): its server's base URL, its key (variables only),
 * the launch's model, and that model's context and output as the user set them.
 */
export const SERVER_PLACEHOLDERS = ['baseUrl', 'key', 'model', 'context', 'output'] as const

export interface CliDescription {
  /** The provider id: a slug no other provider has. */
  id: string
  /** Its product name, as Combwork shows it. */
  name: string
  company?: string
  binary: {
    /** Its executable's names on PATH ("mycli"; ".exe", ".cmd" and ".bat" found too). */
    names: string[]
    /** Folders (each looked in for its names) or files where it may be, a %VARIABLE% at the start allowed. */
    paths?: string[]
    /** The arguments that print its version, and the pattern whose first group is the version. */
    versionArgs?: string[]
    versionPattern?: string
  }
  launch: {
    /** Its arguments for every launch ({model} left out with its argument when the launch names no model). */
    args?: string[]
    /** How the first prompt goes in: typed once its screen is ready, or as these arguments ({prompt}). */
    prompt: 'typed' | { arg: string[] }
    /** Its permission modes, each as the arguments that give it (none: only "The CLI's own setting"). */
    modes?: { value: string; label: string; args: string[] }[]
    /** Variables set for its process (never one of Combwork's CW_ variables). */
    env?: Record<string, string>
  }
  /** How a session is started under Combwork's id and resumed by it; absent: it can't be resumed. */
  session?: { new: string[]; resume: string[] }
  /** The screen rules its status is read by (each a regular expression, case-insensitive, ^ and $ at each line). */
  status: {
    /** Its prompt is ready for a line (its screen, rendered). */
    ready: string
    /** It is working on a turn. */
    working?: string
    /** It asks the user something (a question, a permission). */
    asks?: string
    /** Its terminal title says it asks the user something. */
    titleAsks?: string
    /** It writes its turn's state as an OSC 7501 sequence (state=working, state=idle), as Copilot does. */
    osc7501?: boolean
    /** What ends it at a lane's end, typed then Enter ("/exit"). */
    exit?: string
  }
  models?: { placeholder?: string; list?: string[] }
  /**
   * It takes a server connection (HI-3197: a model server of the user's, such as Ollama): the protocol it speaks, and how a
   * launch on one gives it the server (variables and arguments naming SERVER_PLACEHOLDERS); absent: it takes none.
   */
  server?: { api: 'openai' | 'anthropic'; env: Record<string, string>; args?: string[]; keyless?: string }
}

/** How big a description may be, and each part of it. */
export const CLI_BOUNDS = { files: 32, fileBytes: 64 * 1024, args: 32, argChars: 1000, env: 32, envValueChars: 4000, patternChars: 500, nameChars: 60, models: 64, modes: 16, paths: 16 } as const

const ID = /^[a-z][a-z0-9-]{1,30}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const MODE_VALUE = /^[a-z][a-z0-9-]{0,30}$/

const M = {
  notObject: msg({ id: 'clis.problem.notObject', defaultMessage: 'It isn’t a description: a JSON object is expected.', description: 'Why a CLI description (a JSON file in Combwork’s clis folder, HI-3196) is refused: the file holds something other than a JSON object.' }),
  badId: msg({ id: 'clis.problem.badId', defaultMessage: '“id” must be lower case letters, digits and dashes, starting with a letter (2 to 31 characters).', description: 'Why a CLI description is refused: its "id" field (keep it as it is) isn’t a short slug.' }),
  idTaken: msg({ id: 'clis.problem.idTaken', defaultMessage: '“id” {id} is taken: {by}.', description: 'Why a CLI description is refused: another provider or another description has the same id. {id} is the id; {by} names what has it (a provider’s name, or a file).' }),
  missing: msg({ id: 'clis.problem.missing', defaultMessage: '“{field}” is missing.', description: 'Why a CLI description is refused: a required field is missing. {field} is its name, as written in the file (keep it).' }),
  badType: msg({ id: 'clis.problem.badType', defaultMessage: '“{field}” must be {kind, select, text {text} list {a list of texts} object {an object} yesNo {true or false} other {{kind}}}.', description: 'Why a CLI description is refused: a field has the wrong kind of value. {field} is its name as written in the file (keep it).' }),
  tooLong: msg({ id: 'clis.problem.tooLong', defaultMessage: '“{field}” is longer than {max, number} characters.', description: 'Why a CLI description is refused: a text in it is too long. {field} is its name as written in the file (keep it); {max} the limit.' }),
  tooMany: msg({ id: 'clis.problem.tooMany', defaultMessage: '“{field}” has more than {max, number} items.', description: 'Why a CLI description is refused: a list in it is too long. {field} is its name as written in the file (keep it); {max} the limit.' }),
  badPattern: msg({ id: 'clis.problem.badPattern', defaultMessage: '“{field}” isn’t a valid regular expression: {error}', description: 'Why a CLI description is refused: a pattern in it doesn’t compile. {field} is its name as written in the file (keep it); {error} the English reason.' }),
  badPlaceholder: msg({ id: 'clis.problem.badPlaceholder', defaultMessage: '“{field}” names {name}, which isn’t one of {known}.', description: 'Why a CLI description is refused: an argument names a placeholder Combwork doesn’t fill. {field} is its name as written in the file; {name} the placeholder ({x}); {known} the ones it fills. Keep them as they are.' }),
  badEnv: msg({ id: 'clis.problem.badEnv', defaultMessage: '“launch.env” can’t set {name}: {why, select, name {it isn’t a variable’s name} combwork {Combwork’s own variables (CW_…) are Combwork’s} other {}}.', description: 'Why a CLI description is refused: it sets an environment variable it may not. {name} is the variable’s name (keep it).' }),
  badMode: msg({ id: 'clis.problem.badMode', defaultMessage: '“launch.modes” has a mode {value} that isn’t a short lower-case name, or is given twice.', description: 'Why a CLI description is refused: a permission mode’s "value" (keep the field names) is invalid or repeated. {value} is the value.' }),
  noPrompt: msg({ id: 'clis.problem.noPrompt', defaultMessage: "“launch.prompt” must be 'typed', or an object whose 'arg' names '{prompt}'.", description: 'Why a CLI description is refused: how its first prompt goes in isn’t one of the two forms. Keep "typed", "arg" and {prompt} as they are.' }),
  badApi: msg({ id: 'clis.problem.badApi', defaultMessage: "“server.api” must be 'openai' or 'anthropic'.", description: 'Why a CLI description is refused (HI-3197): its server section names a protocol Combwork doesn’t know. Keep server.api, openai and anthropic as they are.' }),
  keyInArgs: msg({ id: 'clis.problem.keyInArgs', defaultMessage: "“server.args” can’t name '{key}': a key goes in a variable, never on a command line others can see.", description: 'Why a CLI description is refused (HI-3197): it puts the server key in a command-line argument. Keep server.args and {key} as they are.' }),
  noBaseUrl: msg({ id: 'clis.problem.noBaseUrl', defaultMessage: "“server” must name '{baseUrl}' in a variable or an argument.", description: 'Why a CLI description is refused (HI-3197): its server section never passes the server’s address. Keep server and {baseUrl} as they are.' }),
  noId: msg({ id: 'clis.problem.noId', defaultMessage: "“session.{which}” must name '{id}'.", description: 'Why a CLI description is refused: its session arguments (new or resume) don’t name the session id placeholder. Keep "session" and {id} as they are; {which} is new or resume.' })
}

/** A description that checked out, or why not (each problem as Settings shows it and in English for the log). */
export type CliCheck = { ok: true; cli: CliDescription } | { ok: false; problems: Text[] }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * Whether a parsed description can be used, and the description as Combwork keeps it (only the fields it knows). `taken`:
 * the ids already in use and what has each (built-in providers, and the descriptions read before this one).
 */
export function checkCliDescription(raw: unknown, taken: ReadonlyMap<string, string> = new Map()): CliCheck {
  const problems: Text[] = []
  if (!isObj(raw)) return { ok: false, problems: [M.notObject] }
  const text = (v: unknown, field: string, max: number = CLI_BOUNDS.nameChars, required = true): string | undefined => {
    if (v === undefined) {
      if (required) problems.push(withValues(M.missing, { field }))
      return undefined
    }
    if (typeof v !== 'string' || (required && !v.trim())) return void problems.push(withValues(M.badType, { field, kind: 'text' }))
    if (v.length > max) return void problems.push(withValues(M.tooLong, { field, max }))
    return v
  }
  const list = (v: unknown, field: string, max: number, itemMax: number, required = false): string[] | undefined => {
    if (v === undefined) {
      if (required) problems.push(withValues(M.missing, { field }))
      return undefined
    }
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return void problems.push(withValues(M.badType, { field, kind: 'list' }))
    if (v.length > max) return void problems.push(withValues(M.tooMany, { field, max }))
    if (v.some((x: string) => x.length > itemMax)) return void problems.push(withValues(M.tooLong, { field, max: itemMax }))
    return v as string[]
  }
  const named = (s: string, field: string, known: readonly string[]): void => {
    for (const m of s.matchAll(/\{([^{}]*)\}/g)) {
      if (!known.includes(m[1])) problems.push(withValues(M.badPlaceholder, { field, name: `{${m[1]}}`, known: known.map((p) => `{${p}}`).join(', ') }))
    }
  }
  const args = (v: unknown, field: string, required = false, known: readonly string[] = CLI_PLACEHOLDERS): string[] | undefined => {
    const a = list(v, field, CLI_BOUNDS.args, CLI_BOUNDS.argChars, required)
    for (const s of a ?? []) named(s, field, known)
    return a
  }
  /** Variables for its process: names that are variables' and never Combwork's own, values within bounds (and naming `known`, if given). */
  const envMap = (v: unknown, field: string, known?: readonly string[]): Record<string, string> | undefined => {
    if (v === undefined) return undefined
    if (!isObj(v)) return void problems.push(withValues(M.badType, { field, kind: 'object' }))
    const entries = Object.entries(v)
    if (entries.length > CLI_BOUNDS.env) problems.push(withValues(M.tooMany, { field, max: CLI_BOUNDS.env }))
    const out: Record<string, string> = {}
    for (const [k, x] of entries) {
      if (!ENV_NAME.test(k)) problems.push(withValues(M.badEnv, { name: k, why: 'name' })) // i18n-ignore: a select key, not text
      else if (/^CW_/i.test(k)) problems.push(withValues(M.badEnv, { name: k, why: 'combwork' })) // i18n-ignore: a select key, not text
      else if (typeof x !== 'string') problems.push(withValues(M.badType, { field: `${field}.${k}`, kind: 'text' }))
      else if (x.length > CLI_BOUNDS.envValueChars) problems.push(withValues(M.tooLong, { field: `${field}.${k}`, max: CLI_BOUNDS.envValueChars }))
      else {
        if (known) named(x, `${field}.${k}`, known)
        out[k] = x
      }
    }
    return out
  }
  const pattern = (v: unknown, field: string, required = false): string | undefined => {
    const p = text(v, field, CLI_BOUNDS.patternChars, required)
    if (p === undefined) return undefined
    try {
      void new RegExp(p, 'im')
    } catch (e) {
      problems.push(withValues(M.badPattern, { field, error: (e as Error).message }))
      return undefined
    }
    return p
  }
  const obj = (v: unknown, field: string, required = true): Record<string, unknown> | undefined => {
    if (v === undefined) {
      if (required) problems.push(withValues(M.missing, { field }))
      return undefined
    }
    if (!isObj(v)) return void problems.push(withValues(M.badType, { field, kind: 'object' }))
    return v
  }

  const id = text(raw.id, 'id', 31)
  if (id !== undefined && !ID.test(id)) problems.push(M.badId)
  else if (id !== undefined && taken.has(id)) problems.push(withValues(M.idTaken, { id, by: taken.get(id)! }))
  const name = text(raw.name, 'name')
  const company = text(raw.company, 'company', CLI_BOUNDS.nameChars, false)

  const binaryRaw = obj(raw.binary, 'binary')
  const names = list(binaryRaw?.names, 'binary.names', CLI_BOUNDS.paths, CLI_BOUNDS.nameChars, !!binaryRaw)
  if (names && !names.length) problems.push(withValues(M.missing, { field: 'binary.names' }))
  const paths = list(binaryRaw?.paths, 'binary.paths', CLI_BOUNDS.paths, CLI_BOUNDS.argChars)
  const versionArgs = list(binaryRaw?.versionArgs, 'binary.versionArgs', CLI_BOUNDS.args, CLI_BOUNDS.argChars)
  const versionPattern = pattern(binaryRaw?.versionPattern, 'binary.versionPattern')

  const launchRaw = obj(raw.launch, 'launch')
  const launchArgs = args(launchRaw?.args, 'launch.args')
  let prompt: CliDescription['launch']['prompt'] | undefined
  if (launchRaw) {
    const p = launchRaw.prompt
    if (p === 'typed') prompt = 'typed'
    else if (isObj(p)) {
      const arg = args(p.arg, 'launch.prompt.arg', true)
      if (arg && !arg.some((a) => a.includes('{prompt}'))) problems.push(M.noPrompt)
      else if (arg) prompt = { arg }
    } else problems.push(M.noPrompt)
  }
  let modes: CliDescription['launch']['modes']
  if (launchRaw?.modes !== undefined) {
    if (!Array.isArray(launchRaw.modes)) problems.push(withValues(M.badType, { field: 'launch.modes', kind: 'list' }))
    else if (launchRaw.modes.length > CLI_BOUNDS.modes) problems.push(withValues(M.tooMany, { field: 'launch.modes', max: CLI_BOUNDS.modes }))
    else {
      const seen = new Set<string>([CLI_OWN_MODE])
      modes = []
      for (const m of launchRaw.modes as unknown[]) {
        if (!isObj(m)) {
          problems.push(withValues(M.badType, { field: 'launch.modes', kind: 'object' }))
          continue
        }
        const value = text(m.value, 'launch.modes.value', 31)
        const label = text(m.label, 'launch.modes.label')
        const margs = args(m.args, 'launch.modes.args', true)
        if (value !== undefined && (!MODE_VALUE.test(value) || seen.has(value))) problems.push(withValues(M.badMode, { value }))
        if (value) seen.add(value)
        if (value && label && margs) modes.push({ value, label, args: margs })
      }
    }
  }
  const env = envMap(launchRaw?.env, 'launch.env')

  let session: CliDescription['session']
  const sessionRaw = obj(raw.session, 'session', false)
  if (sessionRaw) {
    const nu = args(sessionRaw.new, 'session.new', true)
    const resume = args(sessionRaw.resume, 'session.resume', true)
    if (nu && !nu.some((a) => a.includes('{id}'))) problems.push(withValues(M.noId, { which: 'new' }))
    if (resume && !resume.some((a) => a.includes('{id}'))) problems.push(withValues(M.noId, { which: 'resume' }))
    if (nu && resume) session = { new: nu, resume }
  }

  const statusRaw = obj(raw.status, 'status')
  const ready = pattern(statusRaw?.ready, 'status.ready', !!statusRaw)
  const working = pattern(statusRaw?.working, 'status.working')
  const asks = pattern(statusRaw?.asks, 'status.asks')
  const titleAsks = pattern(statusRaw?.titleAsks, 'status.titleAsks')
  const osc7501 = statusRaw?.osc7501
  if (osc7501 !== undefined && typeof osc7501 !== 'boolean') problems.push(withValues(M.badType, { field: 'status.osc7501', kind: 'yesNo' }))
  const exit = text(statusRaw?.exit, 'status.exit', CLI_BOUNDS.argChars, false)

  let models: CliDescription['models']
  const modelsRaw = obj(raw.models, 'models', false)
  if (modelsRaw) models = { placeholder: text(modelsRaw.placeholder, 'models.placeholder', CLI_BOUNDS.nameChars, false), list: list(modelsRaw.list, 'models.list', CLI_BOUNDS.models, CLI_BOUNDS.nameChars) }

  let server: CliDescription['server']
  const serverRaw = obj(raw.server, 'server', false)
  if (serverRaw) {
    const api = serverRaw.api
    if (api !== 'openai' && api !== 'anthropic') problems.push(M.badApi)
    if (serverRaw.env === undefined) problems.push(withValues(M.missing, { field: 'server.env' }))
    const senv = envMap(serverRaw.env, 'server.env', SERVER_PLACEHOLDERS)
    const sargs = args(serverRaw.args, 'server.args', false, SERVER_PLACEHOLDERS)
    if (sargs?.some((a) => a.includes('{key}'))) problems.push(M.keyInArgs)
    const keyless = text(serverRaw.keyless, 'server.keyless', CLI_BOUNDS.nameChars, false)
    if (senv && ![...Object.values(senv), ...(sargs ?? [])].some((x) => x.includes('{baseUrl}'))) problems.push(M.noBaseUrl)
    if ((api === 'openai' || api === 'anthropic') && senv) server = { api, env: senv, ...(sargs?.length ? { args: sargs } : {}), ...(keyless ? { keyless } : {}) }
  }

  if (problems.length || !id || !name || !names || !prompt || !ready) return { ok: false, problems }
  return {
    ok: true,
    cli: {
      id,
      name,
      ...(company ? { company } : {}),
      binary: { names, ...(paths ? { paths } : {}), ...(versionArgs ? { versionArgs } : {}), ...(versionPattern ? { versionPattern } : {}) },
      launch: { ...(launchArgs ? { args: launchArgs } : {}), prompt, ...(modes?.length ? { modes } : {}), ...(env && Object.keys(env).length ? { env } : {}) },
      ...(session ? { session } : {}),
      status: { ready, ...(working ? { working } : {}), ...(asks ? { asks } : {}), ...(titleAsks ? { titleAsks } : {}), ...(osc7501 === true ? { osc7501: true } : {}), ...(exit ? { exit } : {}) },
      ...(models && (models.placeholder || models.list?.length) ? { models: { ...(models.placeholder ? { placeholder: models.placeholder } : {}), ...(models.list?.length ? { list: models.list } : {}) } } : {}),
      ...(server ? { server } : {})
    }
  }
}

/** A description's notes as agents and the Agent API read them (said when read; the window's are the messages beside them). */
const NOTE = {
  install: agentMsg({ id: 'clis.note.install', text: 'It runs from a description in your Combwork folder (clis): install it yourself, then Reload in Settings → Providers → Your own CLIs.', note: "A CLI that runs from a description (HI-3196): how it is installed, as the Agent API's provider listing says it." }),
  signIn: agentMsg({ id: 'clis.note.signIn', text: 'Sign it in as its own documentation says, in a terminal: Combwork runs no sign-in for it.', note: 'A CLI that runs from a description (HI-3196): how to sign it in again, as agents read it.' })
}

const TEXT = {
  installNote: msg({ id: 'clis.note.install', defaultMessage: 'It runs from a description in your Combwork folder (clis): install it yourself, then Reload in Settings → Providers → Your own CLIs.', description: 'Provider Setup, under a CLI that runs from a description (HI-3196): how it is installed. clis is a folder’s name: keep it. Names of Combwork’s settings: keep them as Combwork shows them.' }),
  extensionNote: msg({ id: 'clis.note.extension', defaultMessage: 'No editor copy is used.', description: 'Provider Setup, for a CLI that runs from a description: editor extensions are never looked for.' }),
  signInHelp: msg({ id: 'clis.note.signIn', defaultMessage: 'Sign it in as its own documentation says, in a terminal: Combwork runs no sign-in for it.', description: 'For a CLI that runs from a description (HI-3196): how to sign it in again, Combwork having no sign-in task for it.' }),
  modelPlaceholder: msg({ id: 'clis.note.modelPlaceholder', defaultMessage: 'Model ID', description: 'The custom model ID box’s placeholder for a CLI that runs from a description without its own example.' })
}

/** A description's permission modes, each a choice in the pickers, and the CLI's own setting after them. */
function modesOf(cli: CliDescription): ModeOption[] {
  return withCliOwn((cli.launch.modes ?? []).map((m) => ({ value: m.value, label: m.label, description: m.label })))
}

/** A description as the descriptor every window and the shared settings logic read. */
export function cliDescriptor(cli: CliDescription): ProviderDescriptor {
  const groups: ModelGroup[] = cli.models?.list?.length ? [{ label: cli.name, models: cli.models.list.map((m) => ({ value: m, label: m })) }] : []
  return {
    id: cli.id,
    name: cli.name,
    assistant: cli.name,
    company: cli.company ?? '',
    cliName: cli.binary.names[0],
    icon: 'cli',
    setupUrl: '',
    pricingUrl: '',
    permissionModes: modesOf(cli),
    defaultPermissionMode: CLI_OWN_MODE,
    assistantMode: CLI_OWN_MODE,
    effortLevels: [],
    modelGroups: groups,
    modelPlaceholder: cli.models?.placeholder ?? 'Model ID', // i18n-ignore: English (text.modelPlaceholder is the window's)
    capabilities: {
      terminal: { attachments: [] },
      session: { fixedSessionId: !!cli.session, combworkTools: false },
      // A server it takes (HI-3197): server accounts beside its PC-wide one, their values from its description's templates.
      ...(cli.server
        ? {
            connections: {
              signIn: false as const,
              server: { api: cli.server.api, keylessToken: cli.server.keyless ?? 'none', launch: { env: cli.server.env, ...(cli.server.args ? { args: cli.server.args } : {}) }, ...SERVER_PROTOCOLS[cli.server.api] }
            }
          }
        : {})
    },
    reservedKeys: [],
    instructionsFile: '',
    get installNote() {
      return say(NOTE.install)
    },
    extensionNote: '',
    get signInHelp() {
      return say(NOTE.signIn)
    },
    safeguardHelp: null,
    text: { installNote: TEXT.installNote, extensionNote: TEXT.extensionNote, signInHelp: TEXT.signInHelp, safeguardHelp: null, modelPlaceholder: TEXT.modelPlaceholder },
    modelLabel: (m) => m,
    canSwitchLive: () => false
  }
}

/** The advanced values a description's patterns are (#367: an override fixes one without editing its file), by kind. */
export const CLI_PATTERNS = ['ready', 'working', 'asks', 'titleAsks', 'osc7501', 'version'] as const
export type CliPattern = (typeof CLI_PATTERNS)[number]

/** A CLI's pattern's advanced id: `<id>.status.<kind>`, or `<id>.binary.versionPattern`. */
export const cliPatternId = (id: string, kind: CliPattern): string => (kind === 'version' ? `${id}.binary.versionPattern` : `${id}.status.${kind}`)

/** The OSC 7501 sequence's state, as Copilot writes it (its value, after "state="). */
export const OSC7501_DEFAULT = String.raw`^7501;state=(\w+)`

const PATTERN_TEXT: Record<CliPattern, { title: Text; desc: Text }> = {
  ready: {
    title: msg({ id: 'clis.advanced.ready.title', defaultMessage: 'Screen: ready for a line', description: "An advanced setting's title (Settings → Advanced, under a CLI that runs from a description, HI-3196)." }),
    desc: msg({ id: 'clis.advanced.ready.desc', defaultMessage: 'What its screen shows when it is ready for a line: Combwork types the first prompt then, and shows it ready. Wrong, it shows as working and nothing is typed into it.', description: 'What the advanced setting "Screen: ready for a line" is for (Settings → Advanced, a CLI that runs from a description).' })
  },
  working: {
    title: msg({ id: 'clis.advanced.working.title', defaultMessage: 'Screen: working', description: "An advanced setting's title (Settings → Advanced, under a CLI that runs from a description, HI-3196)." }),
    desc: msg({ id: 'clis.advanced.working.desc', defaultMessage: 'What its screen shows while it works on a turn. Wrong, Combwork may show it idle while it works, or the other way round.', description: 'What the advanced setting "Screen: working" is for (Settings → Advanced, a CLI that runs from a description).' })
  },
  asks: {
    title: msg({ id: 'clis.advanced.asks.title', defaultMessage: 'Screen: asks you something', description: "An advanced setting's title (Settings → Advanced, under a CLI that runs from a description, HI-3196)." }),
    desc: msg({ id: 'clis.advanced.asks.desc', defaultMessage: 'What its screen shows when it asks you something: the agent waits for you, and nothing is typed into it meanwhile. Wrong, a question could be answered by what Combwork types.', description: 'What the advanced setting "Screen: asks you something" is for (Settings → Advanced, a CLI that runs from a description).' })
  },
  titleAsks: {
    title: msg({ id: 'clis.advanced.titleAsks.title', defaultMessage: 'Title: asks you something', description: "An advanced setting's title (Settings → Advanced, under a CLI that runs from a description, HI-3196)." }),
    desc: msg({ id: 'clis.advanced.titleAsks.desc', defaultMessage: 'What its terminal title says when it asks you something. Wrong, the agent doesn’t show as waiting for you when it does.', description: 'What the advanced setting "Title: asks you something" is for (Settings → Advanced, a CLI that runs from a description).' })
  },
  osc7501: {
    title: msg({ id: 'clis.advanced.osc7501.title', defaultMessage: 'Terminal: its turn’s state', description: "An advanced setting's title (Settings → Advanced, under a CLI that runs from a description, HI-3196)." }),
    desc: msg({ id: 'clis.advanced.osc7501.desc', defaultMessage: 'The terminal sequence it writes its turn’s state in (OSC 7501), its first group the state (working, idle). Wrong, its status is read from its screen alone.', description: 'What the advanced setting "Terminal: its turn’s state" is for (Settings → Advanced, a CLI that runs from a description). Keep OSC 7501, working and idle as they are.' })
  },
  version: {
    title: msg({ id: 'clis.advanced.version.title', defaultMessage: 'Its version', description: "An advanced setting's title (Settings → Advanced, under a CLI that runs from a description, HI-3196)." }),
    desc: msg({ id: 'clis.advanced.version.desc', defaultMessage: 'Where its version is in what its version command prints: the first group. Wrong, Provider Setup shows no version.', description: 'What the advanced setting "Its version" is for (Settings → Advanced, a CLI that runs from a description).' })
  }
}

/**
 * A description's patterns as the advanced values' sources (#367), as a provider's shared half lists them: a built-in
 * data-only provider's are gathered with every provider's (advanced.ts); a user's own CLI's are cliAdvancedDefs'.
 */
export function cliAdvancedSources(cli: CliDescription): AdvancedSource[] {
  return cliAdvancedDefs(cli, () => '').map(({ text, ...d }) => ({ ...d, title: text.title, desc: text.desc }))
}

/** A description's patterns as advanced values (#367): their defaults the description's, no samples (no recording of the user's own CLI). */
export function cliAdvancedDefs(cli: CliDescription, englishText: (t: Text) => string): AdvancedDef[] {
  const values: Partial<Record<CliPattern, string>> = {
    ready: cli.status.ready,
    working: cli.status.working,
    asks: cli.status.asks,
    titleAsks: cli.status.titleAsks,
    osc7501: cli.status.osc7501 ? OSC7501_DEFAULT : undefined,
    version: cli.binary.versionPattern
  }
  return CLI_PATTERNS.flatMap((kind): AdvancedDef[] => {
    const v = values[kind]
    if (v === undefined) return []
    const t = PATTERN_TEXT[kind]
    return [{ id: cliPatternId(cli.id, kind), group: cli.id, title: englishText(t.title), desc: englishText(t.desc), text: t, kind: 'pattern', default: v, flags: 'im', applies: 'sessions' }]
  })
}

/**
 * A description as the shared half the registry lists (no prices or tips of its own): a built-in data-only provider's
 * folder exports `cliModule(itsDescription)` and has no main folder (main/providers/index.ts runs it on the generic
 * adapter); a user's own CLI's is made at each reload. Its patterns are its advanced values (gathered with the built-in
 * providers' for a built-in one; a user's own are registered with its snapshot).
 */
export function cliModule(cli: CliDescription): ProviderModule {
  return defineProvider({ descriptor: cliDescriptor(cli), prices: { checked: '', shipped: {} }, advanced: cliAdvancedSources(cli), cli })
}
