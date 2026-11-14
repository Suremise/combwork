import { randomUUID } from 'crypto'
import { existsSync } from 'original-fs'
import { join } from 'path'
import { msg } from '../../shared/i18n'
import { providerSettings } from '../../shared/providers'
import { OSC7501_DEFAULT, cliPatternId, type CliDescription, type CliPattern } from '../../shared/providers/cliDescription'
import { advancedDef } from '../../shared/advanced'
import type { ProviderModule } from '../../shared/providers/parts'
import type { AgentInstallInfo, ReadinessIssue } from '../../shared/types'
import { advanced } from '../advanced'
import { config } from '../config'
import { createLogger, userText } from '../logger'
import { EDITOR_EXTENSION_PATH, installText, run, toSpawnable } from './common'
import type { CommandSpec, LaunchContext, ProviderAdapter, SkillDelivery } from './types'

// The generic adapter (HI-3196): one class runs every data-only provider from its description (shared/providers/
// cliDescription.ts). It has the install, launch and terminal parts alone: no hooks, transcript, usage, accounts, models
// beyond its description's list, compaction, project files or background sessions. Its status is read from its screen,
// its title and its OSC 7501 sequence (sessions.ts' screen status); it writes nothing of the CLI's own, only its argv and
// its process's environment.

const log = createLogger('providers')

const NOT_FOUND = msg({ id: 'clis.readiness.notFound', defaultMessage: '{provider} isn’t found: install it yourself (its description names where it is looked for), then choose Check again.', description: 'Provider Setup, for a CLI that runs from a description (HI-3196): its executable wasn’t found. Combwork has no install task for it.' })

/** A description's patterns, compiled once: each launch's own (forLaunch), or the registry instance's, read as they are now. */
type Patterns = Partial<Record<CliPattern, RegExp>>

/** A folder or file from a description, a %VARIABLE% at its start expanded. */
const expand = (p: string): string => p.replace(/^%([A-Za-z_][A-Za-z0-9_]*)%/, (all, name: string) => process.env[name] ?? all)

/**
 * An argument with the launch's values put in; null when it names a value the launch hasn't (no model). Only the names
 * given are filled (a description's placeholders, or a server's: HI-3197), each checked when the description was.
 */
function fill(arg: string, values: Record<string, string | null>): string | null {
  let missing = false
  const out = arg.replace(/\{(\w+)\}/g, (all, k: string) => {
    if (!(k in values)) return all
    const v = values[k]
    if (v === null || v === undefined) missing = true
    return v ?? ''
  })
  return missing ? null : out
}

/**
 * Arguments with the launch's values: one naming a value the launch hasn't is left out, with the option before it (an
 * argument starting with "-" and naming no value: `--model {model}` goes whole when no model is chosen). Only a bare value
 * takes its option with it: a left-out `--model={model}` is an option of its own, and the flag before it stays (HI-3268).
 */
export function fillArgs(args: readonly string[], values: Record<string, string | null>): string[] {
  const out: string[] = []
  args.forEach((a, i) => {
    const v = fill(a, values)
    if (v !== null) out.push(v)
    else if (i > 0 && !a.startsWith('-') && args[i - 1].startsWith('-') && !/\{\w+\}/.test(args[i - 1]) && out[out.length - 1] === args[i - 1]) out.pop()
  })
  return out
}

/** The command line a description gives a launch (no shell: argv as it is). */
export function cliArgs(cli: CliDescription, ctx: Pick<LaunchContext, 'cwd' | 'model' | 'sessionId' | 'resume' | 'permissionMode' | 'initialPrompt' | 'extraArgs' | 'serverLaunch'>): string[] {
  const values = { model: ctx.model || null, cwd: ctx.cwd, prompt: ctx.initialPrompt ?? null, id: ctx.sessionId || null }
  const mode = cli.launch.modes?.find((m) => m.value === ctx.permissionMode)
  return [
    ...fillArgs(cli.launch.args ?? [], values),
    ...(mode ? fillArgs(mode.args, values) : []),
    ...(cli.session && ctx.sessionId ? fillArgs(ctx.resume ? cli.session.resume : cli.session.new, values) : []),
    // Its server connection's (HI-3197), filled from this launch's server and model.
    ...(ctx.serverLaunch?.args ?? []),
    ...ctx.extraArgs,
    ...(cli.launch.prompt !== 'typed' && ctx.initialPrompt ? fillArgs(cli.launch.prompt.arg, values) : [])
  ]
}

export class CliAdapter implements ProviderAdapter {
  readonly id: string
  readonly descriptor: ProviderModule['descriptor']
  readonly resumesById: boolean
  private readonly cli: CliDescription

  /** `pinned`: this launch's patterns (forLaunch); absent, the registry's instance, which reads them as they are now. */
  constructor(
    private readonly module: ProviderModule & { cli: CliDescription },
    private readonly pinned?: Patterns
  ) {
    this.cli = module.cli
    this.id = module.descriptor.id
    this.descriptor = module.descriptor
    this.resumesById = !!this.cli.session
  }

  // Its capability parts (ProviderAdapter): install, launch and terminal, each implemented by this class's own members.
  get install(): this {
    return this
  }
  get launch(): this {
    return this
  }
  get terminal(): this {
    return this
  }

  /** A pattern of its description: this launch's (pinned), else its effective value now (its advanced value, #367). */
  private pattern(kind: CliPattern): RegExp | null {
    if (this.pinned) return this.pinned[kind] ?? null
    return this.effective(kind)
  }

  /**
   * A pattern's effective value now: its advanced value (an override, or the description's default), or the description's
   * own where its advanced value isn't registered (a newer snapshot replaced this description meanwhile).
   */
  private effective(kind: CliPattern): RegExp | null {
    if (!this.has(kind)) return null
    const id = cliPatternId(this.id, kind)
    if (advancedDef(id)) return advanced.pattern(id)
    const own = kind === 'version' ? this.cli.binary.versionPattern : kind === 'osc7501' ? OSC7501_DEFAULT : this.cli.status[kind]
    return own ? new RegExp(own, 'im') : null
  }

  private has(kind: CliPattern): boolean {
    const s = this.cli.status
    return kind === 'version' ? !!this.cli.binary.versionPattern : kind === 'osc7501' ? !!s.osc7501 : !!s[kind]
  }

  /** Its copy for a launch (HI-3196): its description and its patterns' effective values taken now, kept until it ends. */
  forLaunch(): ProviderAdapter {
    const kinds: CliPattern[] = ['ready', 'working', 'asks', 'titleAsks', 'osc7501', 'version']
    const pinned: Patterns = {}
    for (const k of kinds) {
      const re = this.effective(k)
      if (re) pinned[k] = re
    }
    return new CliAdapter(this.module, pinned)
  }

  // ---- install
  readonly envToStrip: string[] = []

  async locate(): Promise<AgentInstallInfo> {
    const info: AgentInstallInfo = { provider: this.id, found: false, path: null, version: null, source: null, latestVersion: null, updateAvailable: false, loggedIn: null, authMethod: null, account: null, rejected: [] }
    for (const c of await this.candidates()) {
      if (!existsSync(c.path)) continue
      // Only the standalone CLI (SPEC §11): a copy inside an editor's extensions is never run, whoever names it.
      if (EDITOR_EXTENSION_PATH.test(c.path)) {
        info.rejected!.push(c.path)
        continue
      }
      const version = await this.version(c.path)
      Object.assign(info, { found: true, path: c.path, version, source: c.source })
      break
    }
    return info
  }

  /** Where it may be: Settings' path first, then its description's, then PATH (as the full adapters look). */
  private async candidates(): Promise<{ path: string; source: string }[]> {
    const out: { path: string; source: string }[] = []
    const custom = providerSettings(config.settings, this.id).executablePath.trim()
    if (custom) out.push({ path: custom, source: 'settings' })
    for (const p of this.cli.binary.paths ?? []) out.push({ path: expand(p), source: 'description' })
    for (const name of this.cli.binary.names) {
      const where = await run(process.platform === 'win32' ? 'where.exe' : 'which', [name], 5000)
      for (const line of where.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
        if (process.platform !== 'win32' || /\.(exe|cmd|bat)$/i.test(line)) out.push({ path: line, source: 'PATH' })
      }
    }
    return out
  }

  /** Its version, from its version command and pattern (none without them, or when it can't say). */
  private async version(path: string): Promise<string | null> {
    const args = this.cli.binary.versionArgs
    const re = this.pattern('version')
    if (!args || !re) return null
    const r = await run(path, args, 15000).catch(() => null)
    const v = r ? re.exec(`${r.stdout}\n${r.stderr}`)?.[1] ?? null : null
    if (!v) log.warn(`${userText(this.descriptor.name)} at ${userText(path)} didn't say its version`)
    return v
  }

  async latestVersion(): Promise<string | null> {
    return null
  }

  isNewer(): boolean {
    return false
  }

  readiness(info: AgentInstallInfo): ReadinessIssue[] {
    return info.found ? [] : [{ id: 'not-installed', level: 'error', message: installText({ m: NOT_FOUND, values: { provider: this.descriptor.name } }) }]
  }

  // ---- launch
  async prepareLaunch(): Promise<Record<string, SkillDelivery>> {
    // Nothing delivered: no skills, no MCP server, no launch folder (it takes none of Combwork's, HI-3196).
    return {}
  }

  skillCopyPath(ctx: LaunchContext, skill: string): string {
    return join(ctx.privateDir, 'skills', skill)
  }

  buildCommand(executable: string, ctx: LaunchContext): CommandSpec {
    const s = toSpawnable(executable, cliArgs(this.cli, ctx))
    // Its description's variables, over Combwork's environment; never one its server templates name (HI-3197): its server's
    // win, and on its own setup there are none.
    const served = new Set((ctx.serverLaunch?.names ?? []).map((n) => n.toLowerCase()))
    const own = Object.fromEntries(Object.entries(this.cli.launch.env ?? {}).filter(([k]) => !served.has(k.toLowerCase())))
    return { ...s, ...(Object.keys(own).length ? { env: { ...ctx.env, ...own } } : {}) }
  }

  newSessionId(): string {
    return randomUUID()
  }

  /** Its first prompt is typed once its screen is ready (sessions.ts), not passed on its command line. */
  get promptTyped(): boolean {
    return this.cli.launch.prompt === 'typed'
  }

  get startupOnScreen(): boolean {
    return true
  }

  get readyOutput(): RegExp | undefined {
    return this.pattern('ready') ?? undefined
  }

  get startupQuestion(): RegExp | undefined {
    return this.pattern('asks') ?? undefined
  }

  get quitLine(): { line: string; graceMs: number } | undefined {
    return this.cli.status.exit ? { line: this.cli.status.exit, graceMs: 5000 } : undefined
  }

  // ---- terminal
  /**
   * What its screen says now: the rule (its question, work, its prompt) matched last on it, as what came before stays on
   * the screen (an answered question, a finished turn's "Working…").
   */
  private latest(screen: string): { kind: 'asks' | 'working' | 'ready'; text: string } | null {
    let found: { kind: 'asks' | 'working' | 'ready'; text: string; at: number } | null = null
    for (const kind of ['ready', 'working', 'asks'] as const) {
      const m = lastMatch(this.pattern(kind), screen)
      if (m && (!found || m.at >= found.at)) found = { kind, ...m }
    }
    return found
  }

  turnScreen(): ((screen: string) => 'idle' | 'working' | null) | null {
    return (screen) => {
      const now = this.latest(screen)?.kind
      return now === 'working' ? 'working' : now === 'ready' ? 'idle' : null
    }
  }

  idleQuestion(screen: string): string | null {
    const now = this.latest(screen)
    return now?.kind === 'asks' ? now.text.trim() || now.text : null
  }

  terminalTurn(): RegExp | null {
    return this.pattern('osc7501')
  }

  titleAttention(): ((title: string) => boolean) | null {
    const re = this.pattern('titleAsks')
    return re ? (title) => re.test(title) : null
  }
}

/** Each pattern's global copy, to find its last match (made once a pattern). */
const GLOBAL = new WeakMap<RegExp, RegExp>()

/** Where a pattern last matches on a screen, and what it matched; null when it doesn't. */
export function lastMatch(re: RegExp | null, screen: string): { at: number; text: string } | null {
  if (!re) return null
  let g = GLOBAL.get(re)
  if (!g) GLOBAL.set(re, (g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)))
  let last: { at: number; text: string } | null = null
  for (const m of screen.matchAll(g)) last = { at: m.index, text: m[0] }
  return last
}
