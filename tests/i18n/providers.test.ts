import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { tempDir, tempRoot } from '../tempDir'

// #797: the `providers` area, the provider adapters' user text. What Hive's own code and agents read stays English: a
// provider's install info (readiness, notes) is kept in English, for GET /v1/status and /v1/providers, and the window is
// sent it in its language (shownInstallInfo), again when the language changes; a transcript's notices are cached as data
// and shown in the window's language; tool names, hook names, commands and status messages in the CLI's place stay as
// they are. Errors thrown at a launch reach the window and the Agent API alike: they are HiveErrors (#842), English for
// the Agent API and in the window's language for the window.

vi.mock('electron', () => ({ app: { getPath: () => tempRoot(), isPackaged: false, getVersion: () => '0.0.0' } }))

const { setLanguage, setProblemReporter } = await import('../../src/shared/i18n')
const { PSEUDO_LANGUAGE } = await import('../../src/shared/i18n/languages')
const { provider } = await import('../../src/main/providers')
const { installText, shownInstallInfo } = await import('../../src/main/providers/common')
const { COPILOT_PLAN_NOTE, copilotReadiness } = await import('../../src/main/providers/copilot/install')
const { ConversationParser } = await import('../../src/main/providers/claude/conversation')
const { shownNotice, transcriptMarkdown } = await import('../../src/main/providers/conversation')
const { autoCompactOf, settingsScopes, UNREAD_SOURCES } = await import('../../src/main/providers/claude/autoCompact')
const { strayCodexWarning } = await import('../../src/main/providers/codex/strayFolder')
const { providerService } = await import('../../src/main/providerService')
const { onHiveEvent } = await import('../../src/main/events')
type Info = import('../../src/shared/types').AgentInstallInfo

const ROOT = resolve(__dirname, '../..')
const EN = JSON.parse(readFileSync(join(ROOT, 'locales/en/providers.json'), 'utf8')) as Record<string, { defaultMessage: string; description: string }>
const FILES = ['src/main/keySteps.ts', ...['claude/adapter', 'claude/autoCompact', 'claude/conversation', 'claude/launchSettings', 'claude/safeguards', 'codex/adapter', 'codex/background', 'codex/rollout', 'codex/safeguards', 'codex/strayFolder', 'common', 'conversation', 'copilot/adapter', 'copilot/events', 'copilot/install', 'index'].map((f) => `src/main/providers/${f}.ts`)]
const PSEUDO = /^\[/
const info = (o: Partial<Info>): Info => ({ provider: 'claude-code', found: true, path: 'C:/x/claude.exe', version: '2.1.0', source: null, latestVersion: '2.2.0', updateAvailable: false, loggedIn: true, authMethod: null, rejected: [], ...o }) as Info

const problems: string[] = []
afterEach(() => {
  setLanguage('en', {})
  setProblemReporter(() => undefined)
  problems.length = 0
})

describe('the providers area', () => {
  it('every message is of the providers area, with a note for translators', () => {
    expect(Object.keys(EN).length).toBeGreaterThan(50)
    for (const [id, m] of Object.entries(EN)) {
      expect(id).toMatch(/^providers\./)
      expect(m.description.length, id).toBeGreaterThan(10)
    }
  })

  it('its files have no text left to convert, and no error both audiences read waits for HiveError any more (#842)', () => {
    for (const f of FILES) expect(existsSync(join(ROOT, 'i18n/allow', `${f.replace(/\//g, '__')}.json`)), f).toBe(false)
    for (const f of FILES) expect(readFileSync(join(ROOT, f), 'utf8'), f).not.toMatch(/HiveError \(E10a\)/)
  })
})

describe('errors thrown at a launch (#842): English for the Agent API, as before, and the window in its language', () => {
  /** A German translation of the launch errors (the rest stays English). */
  const GERMAN = {
    'providers.settings.noValue': 'Das letzte --settings in Zusätzliche Argumente hat keinen Wert.',
    'providers.settings.unreadable': 'Die Einstellungsdatei {file} (--settings in Zusätzliche Argumente) kann nicht gelesen werden: {why}.',
    'providers.settings.noFile': 'diese Datei gibt es nicht',
    'providers.settings.tooLarge': 'sie ist größer als 2 MiB',
    'providers.settings.hooksOff': '{source, select, inline {Das --settings in Zusätzliche Argumente} other {Die Einstellungsdatei {file}}} schaltet alle Hooks ab (disableAllHooks).',
    'providers.cmdTooLong': '{file} läuft über cmd.exe, das höchstens {max, number} Zeichen nimmt; dieser Start braucht etwa {length, number}.',
    'providers.unknown': 'Unbekannter Anbieter „{provider}“.'
  }
  const caught = async (p: Promise<unknown> | (() => unknown)): Promise<Error> => {
    try {
      await (typeof p === 'function' ? p() : p)
    } catch (e) {
      return e as Error
    }
    throw new Error('it did not throw')
  }
  const fix = 'Fix it or remove it in Agent Settings or Settings → Claude Code.'

  it('says each in English exactly as before, whatever language Hive shows, and in German to the window', async () => {
    const { userSettings } = await import('../../src/main/providers/claude/launchSettings')
    const { shownError, windowError } = await import('../../src/main/hiveError')
    const { apiErrorReply } = await import('../../src/main/servers')
    const dir = tempDir('hive-launch-errors-')
    mkdirSync(join(dir, 'folder.json'))
    writeFileSync(join(dir, 'big.json'), `{"x":"${'a'.repeat(2 * 1024 * 1024)}"}`)
    writeFileSync(join(dir, 'bad.json'), '{ not json')
    writeFileSync(join(dir, 'list.json'), '[1]')
    setLanguage('de', GERMAN)
    const cases: [Error, string, string | null][] = [
      [await caught(userSettings(['--settings'], dir)), "The last --settings in Extra arguments has no value. Give it a settings file or inline JSON (--settings '<file or JSON>'), or remove it in Agent Settings or Settings → Claude Code.", GERMAN['providers.settings.noValue']],
      [await caught(userSettings(['--settings', 'missing.json'], dir)), `The settings file missing.json (--settings in Extra arguments) can't be read: there is no such file. ${fix}`, 'Die Einstellungsdatei missing.json (--settings in Zusätzliche Argumente) kann nicht gelesen werden: diese Datei gibt es nicht.'],
      [await caught(userSettings(['--settings', 'big.json'], dir)), `The settings file big.json (--settings in Extra arguments) can't be read: it's over Claude Code's 2 MiB limit for settings files. ${fix}`, 'Die Einstellungsdatei big.json (--settings in Zusätzliche Argumente) kann nicht gelesen werden: sie ist größer als 2 MiB.'],
      [await caught(userSettings(['--settings', 'folder.json'], dir)), `The settings file folder.json (--settings in Extra arguments) can't be read: it isn't a file. ${fix}`, "Die Einstellungsdatei folder.json (--settings in Zusätzliche Argumente) kann nicht gelesen werden: it isn't a file."],
      [await caught(userSettings(['--settings', 'list.json'], dir)), `The settings file list.json (--settings in Extra arguments) isn't a settings object ({ … }). ${fix}`, null],
      [await caught(userSettings(['--settings', '{"disableAllHooks":true}'], dir)), "The --settings in Extra arguments turns off all hooks (disableAllHooks). Hive's hooks are how it knows what the agent is doing (its status, file locks, what it is told) and they carry its status line, so Hive doesn't start an agent without them. Take disableAllHooks out of those settings, or remove the --settings from Extra arguments in Agent Settings or Settings → Claude Code.", 'Das --settings in Zusätzliche Argumente schaltet alle Hooks ab (disableAllHooks).'],
      [await caught(userSettings(['--settings', '{"allowedHttpHookUrls":"x"}'], dir)), "The --settings in Extra arguments sets allowedHttpHookUrls to something other than a list, which stops Hive's hooks reaching it. Make it a list ([ … ]) or remove it in Agent Settings or Settings → Claude Code.", null],
      [await caught(() => provider('nope')), 'Unknown provider "nope". It may need a newer version of Hive.', 'Unbekannter Anbieter „nope“.']
    ]
    for (const [e, english, german] of cases) {
      // The Agent API's reply (and every reader of .message): the English, as before.
      expect(e.message).toBe(english)
      expect(apiErrorReply(e).body.error).toBe(english)
      // The window (IPC's conversion): in its language, or English where this test has no translation.
      expect((windowError(e) as Error).message).toBe(german ?? english)
      expect(shownError(e)).toBe(german ?? english)
    }
    // JSON.parse's own words stay as they came, inside either language.
    const bad = await caught(userSettings(['--settings', 'bad.json'], dir))
    expect(bad.message).toMatch(new RegExp(`^The settings file bad\\.json \\(--settings in Extra arguments\\) isn't valid JSON \\(.+\\)\\. ${fix.replace(/[.→]/g, '\\$&')}$`))
    // An unknown provider is refused as invalid (400), as its English said before.
    expect(apiErrorReply(cases.at(-1)![0]).status).toBe(400)
  })

  it.runIf(process.platform === 'win32')("formats cmd.exe's limit with its numbers in each language", async () => {
    const { toSpawnable, CMD_MAX_CHARS } = await import('../../src/main/providers/common')
    const { shownError } = await import('../../src/main/hiveError')
    setLanguage('de', GERMAN)
    const e = await caught(() => toSpawnable(join(tempDir('hive-cmd-'), 'tool.cmd'), ['x'.repeat(CMD_MAX_CHARS)]))
    expect(e.message).toMatch(/^tool\.cmd has to run through cmd\.exe, which takes a command line of at most 8,191 characters, and this launch needs about \d{1,3}(,\d{3})+\. Set the CLI's path in Settings to its \.exe \(or install the standalone CLI\), which has no such limit\.$/)
    expect(shownError(e)).toMatch(/^tool\.cmd läuft über cmd\.exe, das höchstens 8\.191 Zeichen nimmt; dieser Start braucht etwa \d{1,3}(\.\d{3})+\.$/)
  })
})

describe("a provider's install info: English for agents and Hive's own code, the window's language for the window", () => {
  it('reads as before in English', () => {
    expect(provider('claude-code').readiness(info({ found: false }))).toEqual([{ id: 'not-installed', level: 'error', message: 'Claude Code is not installed.', action: { label: 'Install', task: 'install' } }])
    expect(provider('codex').readiness(info({ provider: 'codex', loggedIn: false, updateAvailable: true }))).toEqual([
      { id: 'signed-out', level: 'error', message: 'Codex is not signed in.', action: { label: 'Sign in', task: 'login' } },
      { id: 'update', level: 'info', message: 'Codex 2.2.0 is available.', action: { label: 'Update', task: 'update' } }
    ])
  })

  it('in another language: kept in English, shown to the window in it (messages, buttons, paragraphs, notes)', () => {
    setProblemReporter((p) => problems.push(p))
    setLanguage(PSEUDO_LANGUAGE, {})
    const english = copilotReadiness(info({ provider: 'copilot', loggedIn: false }), { GH_TOKEN: 'x' })
    expect(english[0]).toMatchObject({ message: 'GitHub Copilot is not signed in.', action: { label: 'Sign in' } })
    expect(english[0].detail?.at(-1)).toBe('Copilot agents don’t get `GH_TOKEN` from Hive’s environment, so it doesn’t sign them in. For a token of Copilot’s own, set `COPILOT_GITHUB_TOKEN`.')
    const shown = shownInstallInfo(info({ provider: 'copilot', readiness: english, notes: [installText(COPILOT_PLAN_NOTE)] }))
    const issue = shown.readiness![0]
    expect([issue.message, issue.action!.label, ...issue.detail!, ...shown.notes!].every((t) => PSEUDO.test(t))).toBe(true)
    // The variable and the command stay as they are, inside the translated paragraph.
    expect(issue.detail!.at(-1)).toContain('`GH_TOKEN`')
    expect(problems).toEqual([])
  })

  it('a language change sends the windows each provider in it; what the API and Hive read stays English', () => {
    const seen: { type: string; info?: Info }[] = []
    const off = onHiveEvent((e) => void seen.push(e as never))
    try {
      // As a detection leaves it: English.
      ;(providerService as unknown as { infos: Map<string, Info> }).infos.set('codex', info({ provider: 'codex', readiness: provider('codex').readiness(info({ provider: 'codex', found: false })) }))
      setLanguage(PSEUDO_LANGUAGE, {})
      const sent = seen.find((e) => e.type === 'provider-install' && e.info?.provider === 'codex')
      expect(sent?.info?.readiness?.[0].message).toMatch(PSEUDO)
      expect(providerService.shown().codex.readiness?.[0].message).toMatch(PSEUDO)
      expect(providerService.info('codex').readiness?.[0].message).toBe('Codex is not installed.')
    } finally {
      off()
    }
  })
})

describe('the transcript viewer', () => {
  const line = (o: object): string => JSON.stringify(o)
  const parsed = () => {
    const p = new ConversationParser('C:\\p')
    p.feed(Buffer.from([line({ type: 'user', timestamp: 't1', message: { role: 'user', content: 'Hello' } }), line({ type: 'user', timestamp: 't2', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } })].join('\n') + '\n'))
    return p.items
  }

  it("Hive's notices are cached as data, in English, and shown in the language the window shows", () => {
    const notice = parsed().at(-1)!
    expect(notice).toMatchObject({ kind: 'notice', text: 'Interrupted by you' })
    setLanguage('de', { 'providers.transcript.interrupted': 'Von dir unterbrochen' }, 'de-DE')
    expect(shownNotice(notice as never)).toBe('Von dir unterbrochen')
    // A CLI's own words stay as they are.
    expect(shownNotice({ text: 'Rate limited' })).toBe('Rate limited')
  })

  it('the Markdown export: as before in English; in the language shown', () => {
    const items = parsed()
    expect(transcriptMarkdown(items, 'T', 'S')).toContain('## You')
    setLanguage('de', { 'providers.export.you': 'Du', 'providers.transcript.interrupted': 'Von dir unterbrochen' }, 'de-DE')
    const md = transcriptMarkdown(items, 'T', 'S')
    expect(md).toContain('## Du')
    expect(md).toContain('> *Von dir unterbrochen*')
  })
})

describe('the rest of the area', () => {
  it("auto-compaction's source in the language shown; its English constant as before", () => {
    const cwd = tempDir('hive-i18n-ac-')
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ autoCompactWindow: 400_000 }))
    expect(autoCompactOf([], {}, settingsScopes(cwd, join(cwd, 'home')), ['opus']).source).toBe("autoCompactWindow in the project's .claude/settings.json")
    expect(UNREAD_SOURCES).toMatch(/^an estimate: managed policies/)
    setLanguage('de', { 'providers.autoCompact.keyIn': '{key} in {scope}', 'providers.autoCompact.scope.project': '.claude/settings.json des Projekts' }, 'de-DE')
    expect(autoCompactOf([], {}, settingsScopes(cwd, join(cwd, 'home')), ['opus']).source).toBe('autoCompactWindow in .claude/settings.json des Projekts')
  })

  it("a settings file Hive can't be sure of is a whole clause per file, so Chinese joins a Chinese name with no space (#917)", () => {
    const programFiles = tempDir('hive-i18n-pf-')
    mkdirSync(join(programFiles, 'ClaudeCode', 'managed-settings.json'), { recursive: true })
    const cwd = tempDir('hive-i18n-ac-')
    mkdirSync(join(cwd, 'home', 'settings.json'), { recursive: true })
    vi.stubEnv('ProgramFiles', programFiles)
    try {
      const estimate = (): string | undefined => autoCompactOf([], {}, settingsScopes(cwd, join(cwd, 'home'), ['--safe-mode']), ['opus']).estimate
      expect(estimate()).toContain("managed settings couldn't be read (it isn't a file)")
      expect(estimate()).toContain("Claude Code's settings.json couldn't be read (it isn't a file)")
      setLanguage('zh-CN', JSON.parse(readFileSync(join(ROOT, 'locales/zh-CN/providers.json'), 'utf8')))
      // A Chinese name takes no space before the reason; a file name or a command-line option keeps one.
      expect(estimate()).toContain('托管设置无法读取（它不是文件）')
      expect(estimate()).toContain('Claude Code 的 settings.json 无法读取（它不是文件）')
      expect(estimate()).toContain('--safe-mode 可能导致')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("a stray .codex folder's warning, Copilot's launch notice, start hints, export subtitles and memory labels: all in the language shown", () => {
    const folder = tempDir('hive-i18n-stray-')
    mkdirSync(join(folder, '.codex'), { recursive: true })
    for (const f of ['a.log', 'b.log', 'c.log', 'd.log']) writeFileSync(join(folder, '.codex', f), 'x')
    setProblemReporter((p) => problems.push(p))
    setLanguage(PSEUDO_LANGUAGE, {})
    const stray = strayCodexWarning(folder)!
    expect([stray.title, stray.message].every((t) => PSEUDO.test(t))).toBe(true)
    expect(stray.message).toContain(join(folder, '.codex'))
    const copilot = provider('copilot')
    expect(copilot.launchNotice?.({ permissionMode: 'accept-edits', cwd: 'C:\\a (b)' } as never)?.title).toMatch(PSEUDO)
    for (const id of ['claude-code', 'codex', 'copilot'] as const) {
      const p = provider(id)
      expect(p.startHint?.('error: unknown model "x" not found')?.hint, id).toMatch(PSEUDO)
      expect(p.exportSubtitle('s1', 'site'), id).toMatch(PSEUDO)
    }
    expect(problems).toEqual([])
  })
})
