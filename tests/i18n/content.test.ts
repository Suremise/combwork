// #849 (E10e): the `content` area, the services behind the workspace's content: MCP servers, skills, shared notes,
// agent templates, the Assistant's modes. Refusals are HiveErrors: the Agent API and every reader of `.message` get the
// English exactly as before, the window (IPC) its language. What a skill's header or an MCP server's definition has
// wrong is kept English (`problem`, `error`: agents and launches read them) with the window's text beside it
// (`problemText`, `errorText`). A template's load plan is the window's: its reasons are in its language, and what a
// missing provider's problem is (`problem`) is a key the window matches, never its words. Agent-facing content stays
// English: a new SKILL.md, a new server's definition, the Assistant's instructions.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from '../tempDir'

const base = tempDir('hive-i18n-content-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { setLanguage } = await import('../../src/shared/i18n')
const { englishText, shownText } = await import('../../src/shared/advanced')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../../src/main/workspace')
const { config } = await import('../../src/main/config')
const { providerService } = await import('../../src/main/providerService')
const mcp = await import('../../src/main/mcp')
const skills = await import('../../src/main/skills')
const notes = await import('../../src/main/notes')
const modes = await import('../../src/main/modes')
const templates = await import('../../src/main/templates')
const { switchMode } = await import('../../src/main/assistantMode')
const { shownError, windowError } = await import('../../src/main/hiveError')
const { apiErrorReply, handOverFailedToast, handoverCreatedToast } = await import('../../src/main/servers')

const ROOT = resolve(__dirname, '../..')
const EN = JSON.parse(readFileSync(join(ROOT, 'locales/en/content.json'), 'utf8')) as Record<string, { defaultMessage: string; description: string }>
const FILES = ['assistantMode.ts', 'mcp.ts', 'notes.ts', 'modes.ts', 'skills.ts', 'templates.ts']

/** A German translation of some of the area's messages, as a language file gives them (the rest stays English). */
const GERMAN: Record<string, string> = {
  'content.mode.unknown': 'In diesem Arbeitsbereich gibt es keinen Modus „{mode}“.',
  'content.mode.badName': 'Gib dem Modus einen Namen mit Buchstaben oder Ziffern.',
  'content.notes.nameRequired': 'Ein Name ist nötig',
  'content.notes.outside': 'Der Pfad liegt außerhalb des Ordners der geteilten Notizen',
  'content.skill.badName': 'Skill-Namen dürfen Buchstaben, Ziffern, „-“ und „_“ enthalten (höchstens 64 Zeichen).',
  'content.skill.audience': '{kind, select, text {sein Publikum ist „{audience}“, nicht agents, assistant oder all} empty {sein Publikum ist leer, nicht agents, assistant oder all} list {sein Publikum ist eine Liste, nicht agents, assistant oder all} other {sein Publikum ist ein {type}, nicht agents, assistant oder all}}',
  'content.skill.notClosed': 'sein Kopf ist nicht geschlossen (keine Zeile mit --- danach)',
  'content.mcp.badName': 'Servernamen dürfen Buchstaben, Ziffern, „-“ und „_“ enthalten (höchstens 64 Zeichen). „hive“ ist vergeben.',
  'content.mcp.listNotObject': 'Die Definition muss ein JSON-Objekt sein',
  'content.mcp.notObject': 'Die Definition muss ein JSON-Objekt sein, wie in {path}.',
  'content.mcp.runs': 'Startet: {command}',
  'content.mcp.env': 'Umgebung: {items}',
  'content.mcp.set': '{name} (gesetzt)',
  'mcp.error.invalidName': 'Ungültiger Servername',
  'content.templates.noFile': 'Diese Datei ist nicht da.',
  'content.templates.connectionUnknown': 'Keine Verbindung „{ref}“ kann jetzt in diesem Arbeitsbereich verwendet werden: wähle eine andere.',
  'content.templates.connectionChoices': 'Diese Verbindungswahl passt nicht zu ihren Agenten: {keys}. Öffne sie erneut.',
  'content.templates.cantLoad': 'Die Vorlage kann noch nicht geladen werden:',
  'content.templates.nameEach': 'Gib jedem ihrer Agenten einen Namen.',
  'content.templates.cantUse': '„{name}“ kann nicht verwendet werden: {problem}',
  'assistant.template.noAgents': 'Sie hat keine Agenten.',
  'content.notes.handoverCreated': 'Übergabe erstellt',
  'content.notes.openHandover': 'Öffnen',
  'session.handOver.apiFailed': 'Übergabe an {agent} nicht möglich'
}

const wsPath = join(base, 'ws')
const proj = join(wsPath, 'beta')
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => T | Promise<T>): Promise<T> => inWorkspace(w, async () => fn())

beforeAll(async () => {
  mkdirSync(join(proj, '.combwork'), { recursive: true })
  writeFileSync(join(proj, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
  w = createWorkspaceService()
  await w.open(wsPath)
  // A template with an agent for Claude Code, kept in the workspace.
  mkdirSync(join(wsPath, '.combwork', 'templates'), { recursive: true })
  writeFileSync(join(wsPath, '.combwork', 'templates', 'pair.json'), JSON.stringify({ version: 2, name: 'Pair', savedAt: '', layout: 'auto', agents: [{ name: 'Builder', role: 'builder', provider: 'claude-code' }] }))
  providerService.info = ((id: string) => ({ provider: id, found: true })) as never
})
afterAll(() => disposeWorkspaceService(w))
afterEach(() => {
  setLanguage('en', {})
  config.settings.providers['claude-code'].enabled = true
})

/** What a call threw. */
async function caught(p: () => unknown): Promise<Error> {
  try {
    await run(p)
  } catch (e) {
    return e as Error
  }
  throw new Error('it did not throw')
}

describe('the content area', () => {
  it('every message is of the content area, with a note for translators, and its six files have no text left to convert', () => {
    expect(Object.keys(EN).length).toBeGreaterThan(80)
    for (const [id, m] of Object.entries(EN)) {
      expect(id).toMatch(/^content\./)
      expect(m.description.length, id).toBeGreaterThan(10)
    }
    for (const f of FILES) expect(() => readFileSync(join(ROOT, 'i18n/allow', `src__main__${f}.json`)), f).toThrow()
  })
})

describe('refusals: English for agents and the log as before, the window in its language', () => {
  it('says each in English with the status it always had, and in German to the window', async () => {
    setLanguage('de', GERMAN)
    const cases: [Error, string, number, string | null][] = [
      [await caught(() => switchMode('nope')), 'There is no mode "nope" in this workspace.', 404, 'In diesem Arbeitsbereich gibt es keinen Modus „nope“.'],
      [await caught(() => modes.createMode('!!!')), 'Give the mode a name with letters or numbers.', 400, 'Gib dem Modus einen Namen mit Buchstaben oder Ziffern.'],
      [await caught(() => notes.createNote('  ', false)), 'Name is required', 400, 'Ein Name ist nötig'],
      [await caught(() => notes.createNote('../outside.md', false)), 'Path is outside the shared notes folder', 500, 'Der Pfad liegt außerhalb des Ordners der geteilten Notizen'],
      [await caught(() => skills.createSkill('no spaces allowed', '')), 'Skill names may contain letters, numbers, "-" and "_" (max 64 characters).', 400, 'Skill-Namen dürfen Buchstaben, Ziffern, „-“ und „_“ enthalten (höchstens 64 Zeichen).'],
      [await caught(() => mcp.createMcp('hive')), 'Server names may contain letters, numbers, "-" and "_" (max 64 characters). "combwork" and "hive" are reserved.', 400, 'Servernamen dürfen Buchstaben, Ziffern, „-“ und „_“ enthalten (höchstens 64 Zeichen). „hive“ ist vergeben.'],
      [await caught(() => mcp.readMcp('../x')), 'Invalid server name', 500, 'Ungültiger Servername'],
      [await caught(() => mcp.checkMcpDef([])), 'The definition must be a JSON object, as in .combwork/mcp/<name>.json.', 500, 'Die Definition muss ein JSON-Objekt sein, wie in .combwork/mcp/<name>.json.'],
      [await caught(() => mcp.checkMcpDef({ command: 'x', args: [1] })), '"args" must be a list of strings.', 500, null],
      [await caught(() => templates.readImport(join(base, 'no-such.json'))), "That file isn't there.", 404, 'Diese Datei ist nicht da.'],
      [await caught(() => templates.templatePlan(proj, 'workspace', 'pair.json', undefined, [''])), 'Enter a name for each of its agents.', 400, 'Gib jedem ihrer Agenten einen Namen.']
    ]
    for (const [e, english, status, german] of cases) {
      expect(e.message).toBe(english)
      expect(apiErrorReply(e).body.error).toBe(english)
      expect(apiErrorReply(e).status, english).toBe(status)
      expect((windowError(e) as Error).message).toBe(german ?? english)
      expect(shownError(e)).toBe(german ?? english)
    }
  })
})

describe("a skill's header problem: English for agents, the window's text beside it", () => {
  it('keeps problem English and gives problemText for the window', () => {
    setLanguage('de', GERMAN)
    const audience = skills.parseSkillFrontmatter('---\nname: a\nmetadata:\n  audience: assitant\n---\n')
    expect(audience.problem).toBe('its audience is "assitant", not agents, assistant or all')
    expect(shownText(audience.problemText!)).toBe('sein Publikum ist „assitant“, nicht agents, assistant oder all')
    expect(englishText(audience.problemText!)).toBe(audience.problem)
    const open = skills.parseSkillFrontmatter('---\nname: a\n\n# no closing line\n')
    expect(open.problem).toBe("its header isn't closed (no line with --- after it)")
    expect(shownText(open.problemText!)).toBe('sein Kopf ist nicht geschlossen (keine Zeile mit --- danach)')
    for (const [yaml, kind] of [['[x]', 'a list'], ['3', 'a number'], ['', 'empty']]) {
      const p = skills.parseSkillFrontmatter(`---\nname: a\nmetadata:\n  audience: ${yaml}\n---\n`)
      expect(p.problem).toBe(`its audience is ${kind}, not agents, assistant or all`)
    }
  })

  it("lists a Combwork skill with a broken header with both, and a new skill's SKILL.md stays English", async () => {
    setLanguage('de', GERMAN)
    const made = await run(() => skills.createSkill('fresh', ''))
    const text = readFileSync(join(made.path, 'SKILL.md'), 'utf8')
    expect(text).toContain('description: Describe when the agent should use this skill.')
    expect(text).toContain('Write the instructions the agent should follow when this skill applies.')
    writeFileSync(join(made.path, 'SKILL.md'), '---\nname: fresh\nmetadata:\n  audience: assitant\n---\n')
    const listed = (await run(() => skills.hiveSkills())).find((s) => s.name === 'fresh')!
    expect(listed.problem).toBe('its audience is "assitant", not agents, assistant or all')
    expect(shownText(listed.problemText!)).toBe('sein Publikum ist „assitant“, nicht agents, assistant oder all')
  })
})

describe("MCP servers: a definition's error English for the Agent API, the window's text beside it", () => {
  it("gives errorText for Combwork's words only, and what a server runs in the window's language", async () => {
    setLanguage('de', GERMAN)
    mkdirSync(join(wsPath, '.combwork', 'mcp'), { recursive: true })
    writeFileSync(join(wsPath, '.combwork', 'mcp', 'list.json'), '[1, 2]')
    writeFileSync(join(wsPath, '.combwork', 'mcp', 'broken.json'), '{ not json')
    const listed = await run(() => mcp.listMcp())
    const list = listed.find((m) => m.name === 'list')!
    expect(list.error).toBe('Definition must be a JSON object')
    expect(shownText(list.errorText!)).toBe('Die Definition muss ein JSON-Objekt sein')
    // JSON's reader's words stay as it gave them, with no text of Combwork's beside them.
    const broken = listed.find((m) => m.name === 'broken')!
    expect(broken.error).toMatch(/JSON/)
    expect(broken.errorText).toBeUndefined()
    expect(mcp.mcpRuns({ command: 'npx', args: ['-y', 'pkg'], env: { TOKEN: 'abc', REF: '${REF}' } })).toEqual(['Startet: npx -y pkg', 'Umgebung: TOKEN (gesetzt), REF=${REF}'])
    setLanguage('en', {})
    expect(mcp.mcpRuns({ url: 'https://x.test', type: 'http', cwd: 'C:/s', headers: { A: 'b' } })).toEqual(['Connects to: https://x.test (http)', 'In: C:/s', 'Headers: A (set)'])
  })

  it("writes a new server's definition in English", async () => {
    setLanguage('de', GERMAN)
    const made = await run(() => mcp.createMcp('fresh'))
    expect(JSON.parse(readFileSync(made.path, 'utf8')).description).toBe('Describe what this server provides.')
  })
})

describe("a template's load plan is the window's", () => {
  it("says why it can't load in the window's language, and its refusal in English for the log", async () => {
    // No account here (HI-2109): none offered, and a connection asked for is refused.
    setLanguage('de', GERMAN)
    const plan = await run(() => templates.templatePlan(proj, 'workspace', 'pair.json'))
    expect([plan.options, plan.blocked]).toEqual([[], []])
    const e = await caught(() => templates.loadTemplate(proj, 'workspace', 'pair.json', plan.remove.map((a) => a.id), undefined, undefined, { roles: { builder: 'Claude · High' } }))
    expect(e.message).toBe('No connection "Claude · High" can be used in this workspace now: choose another.')
    expect(shownError(e)).toBe('Keine Verbindung „Claude · High“ kann jetzt in diesem Arbeitsbereich verwendet werden: wähle eine andere.')
    setLanguage('en', {})
  })
})

describe("a template file's problem: English for the log, the window's text beside it (#870)", () => {
  it("lists a damaged template with its problem in English and as text, and refuses it in English with the window's text", async () => {
    const file = join(wsPath, '.combwork', 'templates', 'empty.json')
    writeFileSync(file, JSON.stringify({ version: 2, name: 'Empty', savedAt: '', layout: 'auto', agents: [] }))
    try {
      setLanguage('de', GERMAN)
      const entry = (await run(() => templates.listAllTemplates())).find((t) => t.file === 'empty.json')!
      expect(entry.problem).toBe('It has no agents.')
      expect(shownText(entry.problemText!)).toBe('Sie hat keine Agenten.')
      // The listed text follows a change of language without the list being read again.
      setLanguage('en', {})
      expect(shownText(entry.problemText!)).toBe('It has no agents.')
      setLanguage('de', GERMAN)
      const used = await caught(() => templates.templatePlan(proj, 'workspace', 'empty.json'))
      expect(used.message).toBe(`"Empty" can't be used: It has no agents.`)
      expect(shownError(used)).toBe('„Empty“ kann nicht verwendet werden: Sie hat keine Agenten.')
      const imported = await caught(() => templates.readImport(file))
      expect(imported.message).toBe('It has no agents.')
      expect(shownError(imported)).toBe('Sie hat keine Agenten.')
    } finally {
      rmSync(file, { force: true })
    }
  })
})

describe("lists in the language's way, never joined with English commas", () => {
  it("lists the connections' keys it doesn't know in the window's language, and English in the refusal's message (HI-2109)", async () => {
    writeFileSync(join(wsPath, '.combwork', 'templates', 'crew.json'), JSON.stringify({ version: 2, name: 'Crew', savedAt: '', layout: 'auto', agents: ['Builder', 'Reviewer', 'Tester'].map((name) => ({ name, role: 'builder', provider: 'claude-code' })) }))
    const plan = await run(() => templates.templatePlan(proj, 'workspace', 'crew.json'))
    const load = () => caught(() => templates.loadTemplate(proj, 'workspace', 'crew.json', plan.remove.map((a) => a.id), undefined, undefined, { roles: { builders: 'x', testers: 'x' }, agents: { 9: 'x' } } as never))
    setLanguage('de', GERMAN)
    const e = await load()
    expect(e.message).toBe("These connection choices don't fit its agents: role builders, role testers and agent 9. Open it again.")
    expect(shownError(e)).toBe('Diese Verbindungswahl passt nicht zu ihren Agenten: role builders, role testers und agent 9. Öffne sie erneut.')
    // A language with no translation yet still lists in its own way.
    setLanguage('ja', {})
    expect(shownError(await load())).toContain('role builders、role testers、agent 9')
  })

  it("lists an MCP server's variables and headers in the window's language", () => {
    const def = { command: 'node', env: { TOKEN: 'abc', REF: '${REF}' }, headers: { A: 'b', B: 'c' } }
    setLanguage('de', GERMAN)
    expect(mcp.mcpRuns(def)).toEqual(['Startet: node', 'Umgebung: TOKEN (gesetzt), REF=${REF}', 'Headers: A (gesetzt), B (gesetzt)'])
    setLanguage('ja', {})
    // Japanese's unit list joins with 、 (CLDR's joins with spaces, #893).
    expect(mcp.mcpRuns(def)).toEqual(['Runs: node', 'Environment: TOKEN (set)、REF=${REF}', 'Headers: A (set)、B (set)'])
    setLanguage('en', {})
    expect(mcp.mcpRuns(def)).toEqual(['Runs: node', 'Environment: TOKEN (set), REF=${REF}', 'Headers: A (set), B (set)'])
  })
})

describe("the Assistant's instructions stay English", () => {
  it("puts a mode's name under an English heading whatever language Combwork shows", async () => {
    setLanguage('de', GERMAN)
    await run(() => modes.createMode('Tester'))
    const told = await run(() => modes.assistantInstructions('tester'))
    expect(told.modeText.startsWith('# Your mode: Tester\n\n')).toBe(true)
    expect(told.text).toContain('You are the Combwork Assistant')
  })
})

describe("the Agent API's own notices are the window's (#867)", () => {
  it("tells of a handover an agent saved and a hand-over that failed in the window's language, the error's text too", async () => {
    setLanguage('de', GERMAN)
    const created = handoverCreatedToast('beta', 'Where things stand', 'handovers/x.md')
    expect(created.title).toBe('Übergabe erstellt')
    expect(created.message).toBe('beta: Where things stand')
    expect(created.actions).toEqual([{ label: 'Öffnen', command: 'notes.open', args: ['handovers/x.md'] }])
    const e = await caught(() => notes.createNote('  ', false))
    const failed = handOverFailedToast(proj, 'Reviewer', e)
    expect(failed.title).toBe('Übergabe an Reviewer nicht möglich')
    expect(failed.message).toBe('Ein Name ist nötig')
    // Readers of the error itself (the Assistant's activity, the log) keep its English.
    expect(e.message).toBe('Name is required')
    setLanguage('en', {})
    expect(handoverCreatedToast('', 'Plan', 'handovers/y.md')).toMatchObject({ title: 'Handover created', message: 'Plan', actions: [{ label: 'Open' }] })
    expect(handOverFailedToast(proj, 'Reviewer', e)).toMatchObject({ title: 'Could not hand over to Reviewer', message: 'Name is required' })
  })
})
