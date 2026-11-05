// #850 (E10f): the `service` area, the services behind the workspace, files, git, lanes, transcripts, metrics,
// benchmarks, providers and advanced settings. Refusals are HiveErrors: the Agent API and every reader of `.message` get
// the English exactly as before, with the status its English gave, and the window (IPC) its language. Text only agents
// read stays English (a lane's refusals to cw_lane, a delivery's reasons, progress runs). Metrics keep their English
// lists for agents with the window's text beside them, item for item; advanced.json's problem is text too.
import { execFileSync } from 'child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from '../tempDir'

const base = tempDir('hive-i18n-service-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { setLanguage } = await import('../../src/shared/i18n')
const { englishText, parseAdvancedFile, shownText } = await import('../../src/shared/advanced')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../../src/main/workspace')
const files = await import('../../src/main/files')
const { gitDiff } = await import('../../src/main/git')
const gitRepo = await import('../../src/main/gitRepo')
const { untrackHive } = await import('../../src/main/combworkVcs')
const { ownAttachmentsFolder } = await import('../../src/main/attachmentsFolder')
const lanes = await import('../../src/main/lanes')
const metrics = await import('../../src/main/metrics')
const { HiveError, shownError, windowError } = await import('../../src/main/combworkError')
const { apiErrorReply } = await import('../../src/main/servers')

const ROOT = resolve(__dirname, '../..')
const EN = JSON.parse(readFileSync(join(ROOT, 'locales/en/service.json'), 'utf8')) as Record<string, { defaultMessage: string; description: string }>
const FILES = ['advanced.ts', 'attachmentsFolder.ts', 'benchmarks.ts', 'files.ts', 'fsutil.ts', 'git.ts', 'gitRepo.ts', 'combworkVcs.ts', 'lanes.ts', 'lineWriter.ts', 'metrics.ts', 'progress.ts', 'providerService.ts', 'transcriptReads.ts', 'transcripts.ts', 'workspace.ts']

/** A German translation of some of the area's messages, as a language file gives them (the rest stays English). */
const GERMAN: Record<string, string> = {
  'service.workspace.notProject': 'Kein Projekt im offenen Arbeitsbereich: {path}',
  'service.workspace.badName': 'Projektnamen dürfen nicht mit „.“ beginnen und {chars} nicht enthalten',
  'service.files.nameRequired': 'Ein Name ist nötig',
  'service.files.existsIn': '{root, select, yes {„{name}“ gibt es im Projektordner schon} other {„{name}“ gibt es in {folder} schon}}',
  'service.git.outside': 'Der Pfad liegt außerhalb des Projekts',
  'git.validate.enterName': 'Gib einen Namen ein',
  'git.validate.enterUrl': 'Gib eine URL ein',
  'git.validate.notEmail': 'Das ist keine E-Mail-Adresse',
  'service.gitRepo.badName': '{kind, select, tag {{hasName, select, yes {{name} ist kein gültiger Tag-Name.} other {Das ist kein gültiger Tag-Name.}}} other {{hasName, select, yes {{name} ist kein gültiger Branch-Name.} other {Das ist kein gültiger Branch-Name.}}}}',
  'service.combworkVcs.noRepo': 'Kein Git-Repository enthält dieses Projekt.',
  'service.attachments.badFolder': 'Kein Name eines Sitzungsordners.',
  'service.lanes.unknown': 'Unbekannte Lane {id}',
  'service.metrics.badRole': 'role muss agent, assistant, api oder viewer sein',
  'service.advanced.notJson': 'advanced.json ist kein gültiges JSON: {error}'
}

const git = (cwd: string, ...a: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8' }).trim()
const wsPath = join(base, 'ws')
const proj = join(wsPath, 'proj')
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => T | Promise<T>): Promise<T> => inWorkspace(w, async () => fn())

beforeAll(async () => {
  mkdirSync(join(proj, '.combwork'), { recursive: true })
  mkdirSync(join(proj, 'sub'), { recursive: true })
  writeFileSync(join(proj, 'a.txt'), 'a\n')
  writeFileSync(join(proj, 'sub', 'a.txt'), 'b\n')
  execFileSync('git', ['init', '-q', '-b', 'main', proj])
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com']]) git(proj, 'config', k, v)
  git(proj, 'add', 'a.txt')
  git(proj, 'commit', '-qm', 'a')
  writeFileSync(join(proj, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
  w = createWorkspaceService()
  await w.open(wsPath)
})
afterAll(() => disposeWorkspaceService(w))
afterEach(() => setLanguage('en', {}))

/** What a call threw. */
async function caught(p: () => unknown): Promise<Error> {
  try {
    await run(p)
  } catch (e) {
    return e as Error
  }
  throw new Error(`it did not throw: ${String(p)}`)
}

describe('the service area', () => {
  it('every message is of the service area, with a note for translators, and its sixteen files have no text left to convert', () => {
    expect(Object.keys(EN).length).toBeGreaterThan(120)
    for (const [id, m] of Object.entries(EN)) {
      expect(id).toMatch(/^service\./)
      expect(m.description.length, id).toBeGreaterThan(10)
    }
    for (const f of FILES) expect(() => readFileSync(join(ROOT, 'i18n/allow', `src__main__${f}.json`)), f).toThrow()
  })
})

describe('refusals: English for agents and the log as before, the window in its language', () => {
  it('says each in English with the status it always had, and in German to the window', async () => {
    setLanguage('de', GERMAN)
    const notRepo = tempDir('hive-not-a-repo-')
    const nowhere = join(base, 'elsewhere')
    const cases: [Error, string, number, string][] = [
      [await caught(() => w.assertProject(nowhere)), `Not a project in the open workspace: ${nowhere}`, 404, `Kein Projekt im offenen Arbeitsbereich: ${nowhere}`],
      [await caught(() => w.createProject('a:b')), 'Project names cannot start with "." or contain < > : " / \\ | ? *', 400, 'Projektnamen dürfen nicht mit „.“ beginnen und < > : " / \\ | ? * nicht enthalten'],
      [await caught(() => files.create(proj, '', '', false)), 'A name is required', 500, 'Ein Name ist nötig'],
      [await caught(() => files.move(proj, ['sub/a.txt'], '')), '"a.txt" already exists in the project root', 500, '„a.txt“ gibt es im Projektordner schon'],
      [await caught(() => gitDiff(proj, '../x')), 'Path is outside the project', 500, 'Der Pfad liegt außerhalb des Projekts'],
      [await caught(() => gitRepo.createTag(proj, 'a..b', '')), "a..b isn't a valid tag name.", 500, 'a..b ist kein gültiger Tag-Name.'],
      // The Git view's checks shared with its dialogs (#871): English in the message, whatever language Combwork shows.
      [await caught(() => gitRepo.addRemote(proj, '', 'https://example.com/r.git')), 'Enter a name', 500, 'Gib einen Namen ein'],
      [await caught(() => gitRepo.setRemoteUrl(proj, 'origin', ' ')), 'Enter a URL', 500, 'Gib eine URL ein'],
      [await caught(() => gitRepo.setIdentity(proj, 'A', 'nope')), "That isn't an email address", 500, 'Das ist keine E-Mail-Adresse'],
      [await caught(() => untrackHive(notRepo, [])), 'No git repository holds this project.', 500, 'Kein Git-Repository enthält dieses Projekt.'],
      [await caught(() => ownAttachmentsFolder(proj, '..')), 'Not a session folder name.', 400, 'Kein Name eines Sitzungsordners.'],
      [await caught(() => lanes.endLane(w, 'zzz', {})), 'Unknown lane zzz', 404, 'Unbekannte Lane zzz'],
      [await caught(() => metrics.queryMetrics(w, { scope: { kind: 'workspace' }, role: 'x' as never })), 'role must be agent, assistant, api or viewer', 400, 'role muss agent, assistant, api oder viewer sein']
    ]
    for (const [e, english, status, german] of cases) {
      expect(e.message).toBe(english)
      expect(apiErrorReply(e).body.error).toBe(english)
      expect(apiErrorReply(e).status, english).toBe(status)
      expect((windowError(e) as Error).message).toBe(german)
      expect(shownError(e)).toBe(german)
    }
  })

  it("keeps a lane's refusals to agents English, with their status, whatever language Combwork shows", () => {
    setLanguage('de', GERMAN)
    const e = new lanes.LaneError(400, "A lane's builder can't be its reviewer")
    expect(e).toBeInstanceOf(HiveError)
    expect([e.message, e.status, e.kind, shownError(e)]).toEqual(["A lane's builder can't be its reviewer", 400, 'invalid', "A lane's builder can't be its reviewer"])
    expect(apiErrorReply(e).status).toBe(400)
  })
})

describe("metrics: English lists for agents, the window's text item for item", () => {
  it("gives notMeasuredText beside notMeasured, in the window's language", () => {
    setLanguage('de', {})
    const r = metrics.queryMetrics(w, { scope: { kind: 'workspace' } })
    expect(r.notMeasured.length).toBeGreaterThan(0)
    expect(r.notMeasuredText).toHaveLength(r.notMeasured.length)
    r.notMeasured.forEach((english, i) => expect(englishText(r.notMeasuredText![i])).toBe(english))
  })
})

describe("advanced.json's problem: English for the log, text for the window", () => {
  it('says why the file is unreadable in both', () => {
    setLanguage('de', GERMAN)
    const r = parseAdvancedFile('{')
    expect('error' in r).toBe(true)
    if (!('error' in r)) return
    expect(r.error).toMatch(/^advanced\.json isn't valid JSON \(.+\)\.$/)
    expect(shownText(r.errorText)).toMatch(/^advanced\.json ist kein gültiges JSON: /)
    expect(englishText(r.errorText)).toBe(r.error)
  })
})
