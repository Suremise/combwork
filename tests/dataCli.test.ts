// HI-3196: the data-only provider tier. A CLI from a description alone: its checks and bounds, the command line the
// generic adapter gives a launch, its status from its terminal (screenStep), what it lacks (providerGaps), the registry's
// live tail and its advanced values, the launch policy's clamp, the clis folder's reload contract (a malformed edit keeps
// the last good version, deletion, collisions, bounds), and a launch's own pinned patterns.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-data-cli-')
process.env.CW_USER_DATA = join(base, 'profile')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { checkCliDescription, cliDescriptor, cliPatternId, CLI_BOUNDS } = await import('../src/shared/providers/cliDescription')
const { englishText, advancedDef, listedAdvanced } = await import('../src/shared/advanced')
const { PROVIDERS, providerDescriptor, DEFAULT_PROVIDER, providerSwitchOn, signInConnections } = await import('../src/shared/providers')
const { inLaunchScope, pinInLaunchScope } = await import('../src/main/launchScope')
const { SETTINGS_SECTIONS, settingEntry } = await import('../src/shared/settingsCatalog')
const { BUILT_IN_PROVIDERS } = await import('../src/shared/providers/registry')
const { registerCliSnapshot } = await import('../src/shared/providers/cliSnapshot')
const { providerGaps, providerGapsForAgents } = await import('../src/shared/providers/gaps')
const { launchPolicy } = await import('../src/shared/launchPolicy')
const { screenStep, startupScreen } = await import('../src/main/hookStatus')
const { cliArgs, fillArgs, CliAdapter, lastMatch } = await import('../src/main/providers/cliAdapter')
const { serverLaunch } = await import('../src/main/serverLaunch')
const { pcWideSignIn } = await import('../src/shared/connectionDefaults')
const { readClis, reloadClis, cliSnapshot } = await import('../src/main/clis')
const { TerminalScreen } = await import('../src/main/terminalScreen')
const { advanced } = await import('../src/main/advanced')
const { cliModule } = await import('../src/shared/providers/cliDescription')

type Desc = Parameters<typeof checkCliDescription>[0]
const desc = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'fake-cli',
  name: 'Fake CLI',
  binary: { names: ['fakecli'], versionArgs: ['--version'], versionPattern: 'fakecli (\\d+\\.\\d+\\.\\d+)' },
  launch: { args: ['--model', '{model}'], prompt: 'typed', modes: [{ value: 'auto', label: 'Auto', args: ['--yolo'] }] },
  session: { new: ['--session-id', '{id}'], resume: ['--resume', '{id}'] },
  status: { ready: '^> ', working: 'Working…', asks: 'Allow\\?', osc7501: true, exit: '/exit' },
  ...over
})
const ok = (d: Desc) => {
  const r = checkCliDescription(d)
  if (!r.ok) throw new Error(r.problems.map((p) => englishText(p)).join('; '))
  return r.cli
}
const problems = (d: Desc, taken?: Map<string, string>): string[] => {
  const r = checkCliDescription(d, taken)
  return r.ok ? [] : r.problems.map((p) => englishText(p))
}

describe('a description (HI-3196)', () => {
  it('checks out, keeping only the fields Combwork knows', () => {
    const cli = ok({ ...desc(), extra: 'ignored' })
    expect(cli).not.toHaveProperty('extra')
    expect(cli.launch.prompt).toBe('typed')
    expect(cli.session).toEqual({ new: ['--session-id', '{id}'], resume: ['--resume', '{id}'] })
  })

  it('is refused, saying why, for each kind of problem', () => {
    expect(problems([] as never)).toEqual(['It isn’t a description: a JSON object is expected.'])
    expect(problems(desc({ id: 'Bad Id' }))[0]).toMatch(/“id” must be lower case/)
    expect(problems(desc({ id: 'claude-code' }), new Map([['claude-code', 'Claude Code']]))[0]).toMatch(/is taken: Claude Code/)
    expect(problems(desc({ name: undefined }))).toContain('“name” is missing.')
    expect(problems(desc({ binary: { names: 'fakecli' } }))[0]).toMatch(/“binary.names” must be a list of texts/)
    expect(problems(desc({ name: 'x'.repeat(61) }))[0]).toMatch(/“name” is longer than 60/)
    expect(problems(desc({ launch: { args: Array(CLI_BOUNDS.args + 1).fill('a'), prompt: 'typed' } }))[0]).toMatch(/“launch.args” has more than 32 items/)
    expect(problems(desc({ status: { ready: '(' } }))[0]).toMatch(/“status.ready” isn’t a valid regular expression/)
    expect(problems(desc({ status: { ready: 'x'.repeat(501) } }))[0]).toMatch(/longer than 500/)
    expect(problems(desc({ launch: { args: ['{home}'], prompt: 'typed' } }))[0]).toMatch(/names \{home\}, which isn’t one of/)
    expect(problems(desc({ launch: { prompt: 'typed', env: { 'BAD NAME': 'x' } } }))[0]).toMatch(/can’t set BAD NAME: it isn’t a variable’s name/)
    expect(problems(desc({ launch: { prompt: 'typed', env: { CW_TOKEN: 'x' } } }))[0]).toMatch(/Combwork’s own variables/)
    expect(problems(desc({ launch: { prompt: 'typed', modes: [{ value: 'a', label: 'A', args: [] }, { value: 'a', label: 'B', args: [] }] } }))[0]).toMatch(/given twice/)
    expect(problems(desc({ launch: { prompt: 'piped' } }))[0]).toMatch(/must be 'typed'/)
    expect(problems(desc({ launch: { prompt: { arg: ['-p'] } } }))[0]).toMatch(/names \{prompt\}/)
    expect(problems(desc({ session: { new: ['--x'], resume: ['--resume', '{id}'] } }))[0]).toMatch(/“session.new” must name \{id\}/)
    expect(problems(desc({ status: {} }))).toContain('“status.ready” is missing.')
  })

  it('makes a descriptor with no Combwork tools, its modes and the CLI’s own setting, and a fixed session id with a resume', () => {
    const d = cliDescriptor(ok(desc()))
    expect(d.capabilities.session).toEqual({ fixedSessionId: true, combworkTools: false })
    expect(d.permissionModes.map((m) => m.value)).toEqual(['auto', 'cli-own'])
    expect(d.defaultPermissionMode).toBe('cli-own')
    expect(cliDescriptor(ok(desc({ session: undefined }))).capabilities.session?.fixedSessionId).toBe(false)
  })
})

describe('the generic adapter’s command line', () => {
  const cli = ok(desc())
  const ctx = { cwd: 'C:\\p', model: 'm1', sessionId: 'S1', resume: false, permissionMode: 'auto', initialPrompt: 'hi', extraArgs: ['--x'] }
  it('fills the launch’s values: its mode’s args, a new session or its resume, extra args; a typed prompt never on it', () => {
    expect(cliArgs(cli, ctx)).toEqual(['--model', 'm1', '--yolo', '--session-id', 'S1', '--x'])
    expect(cliArgs(cli, { ...ctx, resume: true, permissionMode: 'cli-own' })).toEqual(['--model', 'm1', '--resume', 'S1', '--x'])
  })
  it('leaves out a value the launch hasn’t, with its option; a prompt by argument goes last', () => {
    expect(cliArgs(cli, { ...ctx, model: null })).toEqual(['--yolo', '--session-id', 'S1', '--x'])
    expect(fillArgs(['--a', '{model}', '--b'], { model: null })).toEqual(['--b'])
    // A left-out --opt={x} is an option of its own: the flag before it stays (HI-3268).
    expect(fillArgs(['--no-banner', '--model={model}'], { model: null })).toEqual(['--no-banner'])
    expect(fillArgs(['-y', '--ctx={context}', '--url', '{baseUrl}'], { context: null, baseUrl: 'http://h' })).toEqual(['-y', '--url', 'http://h'])
    const byArg = ok(desc({ launch: { prompt: { arg: ['-p', '{prompt}'] } } }))
    expect(cliArgs(byArg, ctx)).toEqual(['--session-id', 'S1', '--x', '-p', 'hi'])
    expect(cliArgs(byArg, { ...ctx, initialPrompt: undefined })).toEqual(['--session-id', 'S1', '--x'])
  })
})

describe('its status from its terminal (screenStep)', () => {
  const s = (status: string) => ({ status, askedAtStart: false, compacting: null, backgroundWakes: false, tasks: 0, attention: 'hooks', reviewed: false, titleAsks: false, open: [], waitingOn: null, question: false, reviewing: false, safeguardPrompt: false }) as never
  it('works, finishes, waits on a question and comes back from it; nothing while starting or unsure', () => {
    expect(screenStep('working', s('ready')).next).toBe('working')
    expect(screenStep('ready', s('working'))).toMatchObject({ next: 'finished', actions: ['notifyFinished', 'turnEnded'] })
    expect(screenStep('asks', s('working')).next).toBe('waiting')
    expect(screenStep('asks', s('waiting')).next).toBeNull()
    expect(screenStep('working', s('waiting')).next).toBe('working')
    expect(screenStep('ready', s('waiting')).next).toBe('ready')
    expect(screenStep('ready', s('ready')).next).toBeNull()
    expect(screenStep('working', s('starting')).next).toBeNull()
    expect(screenStep(null, s('working')).next).toBeNull()
  })
})

describe('the registry’s live tail', () => {
  afterEach(() => registerCliSnapshot({ generation: 0, clis: [] }))
  it('puts a snapshot’s CLIs after the built-in providers, replaces them whole, and never changes a built-in', () => {
    const builtIn = PROVIDERS.slice(0, BUILT_IN_PROVIDERS).map((p) => p.id)
    registerCliSnapshot({ generation: 1, clis: [ok(desc()), ok(desc({ id: 'other-cli', name: 'Other' }))] })
    expect(PROVIDERS.map((p) => p.id)).toEqual([...builtIn, 'fake-cli', 'other-cli'])
    expect(advancedDef(cliPatternId('fake-cli', 'ready'))).toMatchObject({ group: 'fake-cli', kind: 'pattern', default: '^> ' })
    registerCliSnapshot({ generation: 2, clis: [ok(desc({ id: 'other-cli', name: 'Other' }))] })
    expect(PROVIDERS.map((p) => p.id)).toEqual([...builtIn, 'other-cli'])
    expect(advancedDef(cliPatternId('fake-cli', 'ready'))).toBeUndefined()
    // A saved id whose CLI is gone stays its own (an unknown provider), never the default.
    expect(providerDescriptor('fake-cli').id).toBe('fake-cli')
    expect(providerDescriptor('fake-cli').id).not.toBe(DEFAULT_PROVIDER)
  })

  it('says what a CLI from a description lacks, and nothing of a full provider; its launches get no tools or guidance', () => {
    registerCliSnapshot({ generation: 3, clis: [ok(desc()), ok(desc({ id: 'no-resume', name: 'NR', session: undefined }))] })
    expect(providerGaps('fake-cli')).toEqual(['tools', 'hooks', 'transcript', 'cost', 'liveMode'])
    expect(providerGaps('no-resume')).toContain('resume')
    expect(providerGaps('claude-code')).toEqual([])
    expect(providerGapsForAgents('fake-cli')[0]).toMatch(/^no Combwork tools/)
    expect(launchPolicy({ launch: {} }, 'fake-cli')).toMatchObject({ guidance: false, tools: false, typing: true })
    expect(launchPolicy(null, 'claude-code')).toMatchObject({ guidance: true, tools: true })
  })
})

describe('the clis folder (reload contract)', () => {
  const folder = join(base, 'clis')
  const write = (file: string, body: unknown): void => {
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, file), typeof body === 'string' ? body : JSON.stringify(body))
  }
  afterEach(() => rmSync(folder, { recursive: true, force: true }))

  it('reads each description, refusing a malformed one, an id twice and a built-in’s id, each saying why', async () => {
    write('a.json', desc())
    write('b.json', '{ not json')
    write('c.json', desc({ id: 'twice' }))
    write('d.json', desc({ id: 'twice' }))
    write('e.json', desc({ id: 'codex' }))
    const { view: v } = await readClis(folder, new Map())
    expect(v.clis.map((c) => c.id)).toEqual(['fake-cli'])
    const why = Object.fromEntries(v.problems.map((p) => [p.file, p.problems.map((t) => englishText(t)).join(' ')]))
    expect(why['b.json']).toMatch(/isn’t valid JSON/)
    expect(why['c.json']).toMatch(/also in d.json/)
    expect(why['e.json']).toMatch(/is taken: Codex/)
  })

  it('keeps a file’s last good version through a malformed edit, and drops it once the file is deleted', async () => {
    write('a.json', desc())
    const first = await readClis(folder, new Map())
    expect(first.view.clis.map((c) => c.id)).toEqual(['fake-cli'])
    write('a.json', desc({ status: { ready: '(' } }))
    const second = await readClis(folder, first.lastGood)
    expect(second.view.clis.map((c) => c.id)).toEqual(['fake-cli'])
    expect(second.view.problems).toMatchObject([{ file: 'a.json', usingLastGood: true }])
    // Reading changed nothing it was given: the read before it still has only its own.
    expect([...first.lastGood.keys()]).toEqual(['a.json'])
    rmSync(join(folder, 'a.json'))
    const third = await readClis(folder, second.lastGood)
    expect(third.view.clis).toEqual([])
    expect(third.lastGood.size).toBe(0)
  })

  it('refuses a file over its size, and reads no more than its count', async () => {
    write('big.json', `${JSON.stringify(desc())}${' '.repeat(CLI_BOUNDS.fileBytes)}`)
    for (let i = 0; i < CLI_BOUNDS.files; i++) write(`n${String(i).padStart(2, '0')}.json`, desc({ id: `cli-${i}` }))
    const { view: v } = await readClis(folder, new Map())
    expect(englishText(v.problems.find((p) => p.file === 'big.json')!.problems[0])).toMatch(/larger than/)
    expect(v.problems.filter((p) => englishText(p.problems[0]).startsWith('Only the first'))).toHaveLength(1)
  })

  it('applies overlapping reloads in the order they were asked: a reload reads only once the one before it has applied', async () => {
    const reads: string[] = []
    let releaseFirst: () => void = () => undefined
    const firstHeld = new Promise<void>((r) => (releaseFirst = r))
    const read = (name: string, held?: Promise<void>) => async (_f?: string, prior?: ReadonlyMap<string, unknown>): Promise<Awaited<ReturnType<typeof readClis>>> => {
      reads.push(`${name} read after ${[...(prior?.keys() ?? [])].join(',') || 'none'}`)
      await held
      return { view: { generation: 0, folder: name, clis: [], problems: [] }, lastGood: new Map([[`${name}.json`, ok(desc())]]) }
    }
    const older = reloadClis(folder, read('older', firstHeld))
    const newer = reloadClis(folder, read('newer'))
    // The newer one hasn't read while the older one's read is held.
    await Promise.resolve()
    expect(reads).toHaveLength(1)
    releaseFirst()
    const [a, b] = await Promise.all([older, newer])
    // The newer read came after, from the last good versions the older one kept.
    expect(reads[1]).toBe('newer read after older.json')
    expect(b.generation).toBeGreaterThan(a.generation)
    expect(cliSnapshot().folder).toBe('newer')
  })
})

describe('a launch’s own patterns (forLaunch)', () => {
  afterEach(async () => {
    await advanced.set(cliPatternId('fake-cli', 'ready'), null)
    registerCliSnapshot({ generation: 0, clis: [] })
  })
  it('keeps the description and patterns it started with, overrides included, whatever changes after', async () => {
    advanced.load(join(base, 'profile'))
    const cli = ok(desc())
    registerCliSnapshot({ generation: 5, clis: [cli] })
    await advanced.set(cliPatternId('fake-cli', 'ready'), '^READY')
    const registered = new CliAdapter({ ...cliModule(cli), cli })
    const launch = registered.forLaunch()
    // A later override, and a reload with another description: the launch keeps its own.
    await advanced.set(cliPatternId('fake-cli', 'ready'), '^SOON')
    registerCliSnapshot({ generation: 6, clis: [ok(desc({ status: { ready: '^NEW' } }))] })
    expect(launch.launch.readyOutput?.source).toBe('^READY')
    expect(launch.terminal?.turnScreen?.(null)?.('READY now')).toBe('idle')
    // The next launch takes the values as they are now.
    expect(registered.forLaunch().launch.readyOutput?.source).toBe('^SOON')
  })
})

describe('its start, read from its rendered screen a line each (startupOnScreen)', () => {
  it('is ready at its prompt’s line, and waits on its question before it, as its patterns anchor at each line', () => {
    const launch = new CliAdapter({ ...cliModule(ok(desc())), cli: ok(desc()) }).forLaunch().launch
    expect(launch.startupOnScreen).toBe(true)
    const starting = { status: 'starting', askedAtStart: false, settled: false } as const
    // The rendered screen keeps its lines (the raw tail run together would put its banner before "> " on one line).
    expect(startupScreen(starting, 'fakecli 1.2.3\n> ', launch)).toBe('ready')
    expect(startupScreen(starting, 'fakecli 1.2.3 > ', launch)).toBeNull()
    expect(startupScreen(starting, 'fakecli 1.2.3\nAllow? (y/n)', launch)).toEqual({ asked: 'Allow?' })
    // Answered, it is ready once its prompt shows.
    expect(startupScreen({ status: 'waiting', askedAtStart: true, settled: false }, 'Allow? (y/n) y\n> ', launch)).toBe('ready')
  })

  it('reads the latest of its question and its prompt on the screen (HI-3246): an old prompt above its question is no answer', () => {
    const launch = new CliAdapter({ ...cliModule(ok(desc())), cli: ok(desc()) }).forLaunch().launch
    const starting = { status: 'starting', askedAtStart: false, settled: false } as const
    const asked = { status: 'waiting', askedAtStart: true, settled: false } as const
    const oldPromptThenQuestion = 'fakecli 1.2.3\n> \nAllow? (y/n)'
    // An old prompt above its question: asked, and drawn again unanswered, still asked (not ready, nothing new).
    expect(startupScreen(starting, oldPromptThenQuestion, launch)).toEqual({ asked: 'Allow?' })
    expect(startupScreen(asked, oldPromptThenQuestion, launch)).toBeNull()
    // An old, answered question above its new prompt: ready, at the start or once asked.
    expect(startupScreen(starting, 'Allow? (y/n) y\n> ', launch)).toBe('ready')
    expect(startupScreen(asked, 'Allow? (y/n) y\nfakecli 1.2.3\n> ', launch)).toBe('ready')
    // Ready but not yet settled, its question drawn below the prompt: asked (#679's order, from the screen).
    expect(startupScreen({ status: 'ready', askedAtStart: false, settled: false }, oldPromptThenQuestion, launch)).toEqual({ asked: 'Allow?' })
    // Its prompt and question matching at the same place (overlapping patterns): the question, never ready.
    const cli = ok(desc({ status: { ready: '^>', asks: '^> Allow this folder\\?' } }))
    const overlapping = new CliAdapter({ ...cliModule(cli), cli }).forLaunch().launch
    expect(startupScreen(starting, '> Allow this folder?', overlapping)).toEqual({ asked: '> Allow this folder?' })
    expect(startupScreen(asked, '> Allow this folder?', overlapping)).toBeNull()
    expect(startupScreen(asked, '> Allow this folder? y\n> ', overlapping)).toBe('ready')
    expect(startupScreen(starting, 'fakecli 1.2.3', overlapping)).toBeNull()
  })
})

describe('its screen’s rules: the one matched last says what it is doing', () => {
  it('reads an answered question and a finished turn’s work as over once its prompt is back', () => {
    const t = new CliAdapter({ ...cliModule(ok(desc())), cli: ok(desc()) }).forLaunch().terminal!
    const turn = t.turnScreen!(null)!
    expect(turn('> do it\nWorking…')).toBe('working')
    expect(turn('> do it\nWorking…\nDone: do it\n> ')).toBe('idle')
    expect(t.idleQuestion!('> ask\nAllow? (y/n) ')).toBe('Allow?')
    expect(turn('> ask\nAllow? (y/n) ')).toBeNull()
    expect(t.idleQuestion!('> ask\nAllow? (y/n) y\nAllowed.\n> ')).toBeNull()
    expect(turn('> ask\nAllow? (y/n) y\nAllowed.\n> ')).toBe('idle')
    expect(lastMatch(/a/m, 'xaya')).toEqual({ at: 3, text: 'a' })
    expect(lastMatch(/z/m, 'xaya')).toBeNull()
  })
  it('counts work begun as its prompt taken (it has no hook to say so)', () => {
    const s = { status: 'ready', askedAtStart: false, compacting: null, backgroundWakes: false, tasks: 0, attention: 'hooks', reviewed: false, titleAsks: false, open: [], waitingOn: null, question: false, reviewing: false, safeguardPrompt: false } as never
    expect(screenStep('working', s).actions).toEqual(['prompted'])
  })
})

describe('Ollama 0.40.15 from the user guide’s description (a recorded run, HI-3196)', () => {
  const rec = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'datacli', 'ollama-0.40.15.json'), 'utf8')) as Record<'ready' | 'working' | 'finished', string>
  const ollama = ok({
    id: 'ollama-chat',
    name: 'Ollama',
    binary: { names: ['ollama'], versionArgs: ['--version'], versionPattern: 'version is (\\d+\\.\\d+\\.\\d+)' },
    launch: { args: ['run', '{model}', '--think=false'], prompt: 'typed', env: { OLLAMA_NOHISTORY: '1' } },
    status: { ready: '^>>> Send a message', working: '^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]', exit: '/bye' },
    models: { list: ['qwen3:8b'] }
  })
  const rendered = (raw: string): Promise<string> => {
    const screen = new TerminalScreen(120, 40)
    return new Promise((r) => screen.write(raw, () => (r(screen.text()), screen.dispose())))
  }
  it('reads its prompt, its work and its turn’s end from its screen', async () => {
    const adapter = new CliAdapter({ ...cliModule(ollama), cli: ollama }).forLaunch()
    const turn = adapter.terminal!.turnScreen!(null)!
    const starting = { status: 'starting', askedAtStart: false, settled: false } as const
    expect(startupScreen(starting, await rendered(rec.ready), adapter.launch)).toBe('ready')
    expect(turn(await rendered(rec.working))).toBe('working')
    expect(turn(await rendered(rec.finished))).toBe('idle')
    expect(adapter.launch.quitLine?.line).toBe('/bye')
  })
})

describe('finding its executable (locate)', () => {
  it('never takes a copy inside an editor’s extensions, and goes on to the standalone one', async () => {
    const fake = join(__dirname, 'e2e', 'fake-datacli')
    const ext = join(base, 'home', '.vscode', 'extensions', 'some.cli-1.0.0')
    mkdirSync(ext, { recursive: true })
    for (const f of ['datacli.cmd']) writeFileSync(join(ext, f), readFileSync(join(fake, f)))
    const cli = ok(desc({ id: 'locate-cli', binary: { names: ['no-such-cli-anywhere'], paths: [join(ext, 'datacli.cmd'), join(fake, 'datacli.cmd')], versionArgs: ['--version'], versionPattern: 'datacli (\\d+\\.\\d+\\.\\d+)' } }))
    const info = await new CliAdapter({ ...cliModule(cli), cli }).locate()
    expect(info.rejected).toEqual([join(ext, 'datacli.cmd')])
    expect(info.path).toBe(join(fake, 'datacli.cmd'))
    expect(info.version).toBe('1.2.3')
  })
  it('looks in a folder for its names, and never takes the folder itself (HI-3269)', async () => {
    const fake = join(__dirname, 'e2e', 'fake-datacli')
    const empty = join(base, 'locate-empty')
    mkdirSync(empty, { recursive: true })
    const at = async (paths: string[], names = ['datacli']) => {
      const cli = ok(desc({ id: 'locate-cli', binary: { names, paths, versionArgs: ['--version'], versionPattern: 'datacli (\\d+\\.\\d+\\.\\d+)' } }))
      return await new CliAdapter({ ...cliModule(cli), cli }).locate()
    }
    // A folder without it is passed over, and the next place is reached.
    const info = await at([empty, fake])
    expect(info.path).toBe(join(fake, 'datacli.cmd'))
    expect(info.version).toBe('1.2.3')
    // A name with its extension is looked for as written, never datacli.cmd.cmd.
    expect((await at([empty, fake], ['datacli.cmd'])).path).toBe(join(fake, 'datacli.cmd'))
  })
})

describe('what is made from the providers follows a snapshot (Settings, the Assistant’s catalogue)', () => {
  afterEach(() => registerCliSnapshot({ generation: 0, clis: [] }))
  it('has a CLI’s page, its rows and its advanced values while it is registered, and none after', () => {
    const cli = ok(desc())
    registerCliSnapshot({ generation: 21, clis: [cli] })
    expect(SETTINGS_SECTIONS.some((s) => s.id === 'provider:fake-cli')).toBe(true)
    expect(settingEntry('fake-cli.executablePath')).toBeDefined()
    expect(settingEntry('fake-cli.status')?.action).toBe(true)
    expect(listedAdvanced().some((d) => d.id === 'fake-cli.status.ready')).toBe(true)
    registerCliSnapshot({ generation: 22, clis: [] })
    expect(SETTINGS_SECTIONS.some((s) => s.id === 'provider:fake-cli')).toBe(false)
    expect(settingEntry('fake-cli.executablePath')).toBeUndefined()
    expect(listedAdvanced().some((d) => d.id === 'fake-cli.status.ready')).toBe(false)
  })
})

describe('each launch keeps its own view of its CLI (launchScope), everything else the registry as it is now', () => {
  afterEach(() => registerCliSnapshot({ generation: 0, clis: [] }))
  it('keeps an old launch on its copy and a new one on the new, while listings and settings read the new', async () => {
    const mode = (value: string) => ({ value, label: value, args: [`--${value}`] })
    const oldCli = ok(desc({ name: 'Old CLI', launch: { prompt: 'typed', modes: [mode('old-mode')] } }))
    const newCli = ok(desc({ name: 'New CLI', launch: { prompt: 'typed', modes: [mode('new-mode')] } }))
    const modes = (): string[] => providerDescriptor('fake-cli').permissionModes.map((m) => m.value)
    registerCliSnapshot({ generation: 41, clis: [oldCli] })
    let releaseOld: () => void = () => undefined
    const oldHeld = new Promise<void>((r) => (releaseOld = r))
    const seen: Record<string, unknown> = {}
    // A launch of the old description pins it, then waits (its preparation) while a reload registers the new one.
    const oldLaunch = inLaunchScope(async () => {
      pinInLaunchScope(providerDescriptor('fake-cli'))
      await oldHeld
      seen.old = { name: providerDescriptor('fake-cli').name, modes: modes(), tools: launchPolicy(null, 'fake-cli').tools }
    })
    registerCliSnapshot({ generation: 42, clis: [newCli] })
    // A second launch, of the new one, at the same time.
    await inLaunchScope(async () => {
      pinInLaunchScope(providerDescriptor('fake-cli'))
      await Promise.resolve()
      seen.new = { name: providerDescriptor('fake-cli').name, modes: modes() }
    })
    seen.outside = { name: providerDescriptor('fake-cli').name, modes: modes() }
    releaseOld()
    await oldLaunch
    expect(seen.old).toEqual({ name: 'Old CLI', modes: ['old-mode', 'cli-own'], tools: false })
    expect(seen.new).toEqual({ name: 'New CLI', modes: ['new-mode', 'cli-own'] })
    expect(seen.outside).toEqual({ name: 'New CLI', modes: ['new-mode', 'cli-own'] })
    // Its switch alone says whether it is off, registered or not.
    expect(providerSwitchOn({ providers: { gone: { enabled: true } } } as never, 'gone')).toBe(true)
  })
})

describe('a server it takes (HI-3197): its description, its launch values, its accounts', () => {
  const server = { api: 'openai', env: { OPENAI_BASE_URL: '{baseUrl}', OPENAI_API_KEY: '{key}', CTX: '{context}' }, args: ['--max-out', '{output}'] }
  it('checks the server section: a protocol it knows, the address passed, the key never in an argument, known names only', () => {
    expect(problems(desc({ server }))).toEqual([])
    expect(problems(desc({ server: { ...server, api: 'grpc' } })).join(' ')).toMatch(/server\.api/)
    expect(problems(desc({ server: { ...server, args: ['--key', '{key}'] } })).join(' ')).toMatch(/never on a command line/)
    expect(problems(desc({ server: { api: 'openai', env: { OPENAI_API_KEY: '{key}' } } })).join(' ')).toMatch(/\{baseUrl\}/)
    expect(problems(desc({ server: { ...server, env: { ...server.env, X: '{token}' } } })).join(' ')).toMatch(/\{token\}/)
    expect(problems(desc({ server: { ...server, env: { ...server.env, CW_THING: '{baseUrl}' } } })).join(' ')).toMatch(/CW_THING/)
    expect(problems(desc({ server: { api: 'openai' } })).join(' ')).toMatch(/server\.env/)
  })
  it('makes it server-only: its PC-wide account beside server accounts, no sign-in accounts, the protocol’s presets', () => {
    const cli = ok(desc({ server }))
    registerCliSnapshot({ generation: 51, clis: [cli] })
    try {
      const d = providerDescriptor('fake-cli')
      expect(d.capabilities.connections).toMatchObject({ signIn: false, server: { api: 'openai', keylessToken: 'none', launch: { env: server.env, args: server.args } } })
      expect(d.capabilities.connections?.server?.presets.map((p) => p.id)).toEqual(['ollama', 'lmstudio', 'llamacpp', 'vllm'])
      expect(signInConnections(d)).toBeUndefined()
      expect(pcWideSignIn('fake-cli')).toBe(true)
      // A full provider with sign-in accounts keeps them.
      expect(signInConnections(providerDescriptor('claude-code'))?.homeEnv).toBe('CLAUDE_CONFIG_DIR')
      expect(pcWideSignIn('claude-code')).toBe(false)
    } finally {
      registerCliSnapshot({ generation: 0, clis: [] })
    }
  })
  it('fills its launch values from the launch’s model and that model’s limits, leaving out what it hasn’t, never the key in an argument', () => {
    const caps = cliDescriptor(ok(desc({ server }))).capabilities.connections!.server!
    const on = { baseUrl: 'http://127.0.0.1:9/v1', key: 'sk-x', models: [{ id: 'big', context: 131072, output: 8192 }, { id: 'small' }] }
    expect(serverLaunch(caps, on, 'big')).toEqual({ env: { OPENAI_BASE_URL: 'http://127.0.0.1:9/v1', OPENAI_API_KEY: 'sk-x', CTX: '131072' }, args: ['--max-out', '8192'], names: ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'CTX'] })
    // A model without limits: those left out, with their option; a local server without a key: the CLI's stand-in.
    expect(serverLaunch(caps, { ...on, key: null }, 'small')).toEqual({ env: { OPENAI_BASE_URL: 'http://127.0.0.1:9/v1', OPENAI_API_KEY: 'none' }, args: [], names: ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'CTX'] })
    // Its own setup (no server): no values, and the names it must not be given.
    expect(serverLaunch(caps, null, 'big')).toEqual({ env: {}, args: [], names: ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'CTX'] })
  })
  it('gives its description’s own variables never over one its server names, on a server launch or its own setup', () => {
    const cli = ok(desc({ server, launch: { prompt: 'typed', env: { OPENAI_API_KEY: 'from-description', OTHER: 'kept' } } }))
    const adapter = new CliAdapter({ ...cliModule(cli), cli }).forLaunch()
    const ctx = (served: { args: string[]; names: string[] }) => ({ env: { OPENAI_API_KEY: 'sk-server' }, cwd: 'C:\\p', model: null, sessionId: '', resume: false, permissionMode: null, initialPrompt: undefined, extraArgs: [], serverLaunch: served }) as never
    const cmd = adapter.launch.buildCommand('C:\\x\\datacli.exe', ctx({ args: ['--server-mode'], names: ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'CTX'] }))
    expect(cmd.env).toMatchObject({ OPENAI_API_KEY: 'sk-server', OTHER: 'kept' })
    expect(cmd.args).toContain('--server-mode')
  })
})
