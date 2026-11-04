import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { MoveOwner, PathDataCopy } from '../../src/shared/types'
import { tempDir, tempRoot } from '../tempDir'

// #796, the `main` area's services, in the language Hive shows while what agents read stays English: the Agent API's
// notice titles (grouped finishes, plan usage, Hive closing), before and after a language change; Repair's report of a
// copy recorded in one language and shown in another; Initialise Git Repository's reply.

vi.mock('electron', () => ({
  app: { getPath: () => tempRoot(), isPackaged: false, getVersion: () => '0.0.0' },
  // Windows notifications, supported and dropped.
  Notification: class {
    static isSupported(): boolean {
      return true
    }
    on(): this {
      return this
    }
    show(): void {}
  }
}))
/** The project folders the mocked workspace knows (Initialise Git Repository's). */
let projects: string[] = []
vi.mock('../../src/main/workspace', async (original) => ({
  ...(await original<object>()),
  workspace: {
    assertProject: (p: string) => {
      if (!projects.some((x) => x.toLowerCase() === p.toLowerCase())) throw new Error(`Not a project: ${p}`)
      return p
    }
  },
  workspaceOf: () => ({ refresh: async () => ({}) })
}))
vi.mock('../../src/main/sessions', () => ({ sessions: {} }))
vi.mock('../../src/main/mergeSlotHost', () => ({ mergeSlots: {} }))
vi.mock('../../src/main/branchWatch', () => ({ checkProject: async () => undefined }))

const { setLanguage } = await import('../../src/shared/i18n')
const { PSEUDO_LANGUAGE } = await import('../../src/shared/i18n/languages')
const { config } = await import('../../src/main/config')
const { planNotice, reportPlanUsage } = await import('../../src/main/planUsage')
const { onHiveEvent } = await import('../../src/main/events')
const { closedNotice } = await import('../../src/main/notices')
const { setNotifyHost, tell } = await import('../../src/main/notify')
const { apiEventFor } = await import('../../src/main/apiEvents')
const { finishedApiTitle, finishedNotice } = await import('../../src/shared/bursts')
const { DEFAULT_SETTINGS } = await import('../../src/shared/defaults')
const { blockerNames, copyReport, moveOwner, owned } = await import('../../src/main/workspaceMove')
const { initRepo } = await import('../../src/main/gitInit')

/** A German translation of the messages these tests show (the rest stays English). */
const GERMAN = {
  'main.plan.used': '{share, number, ::percent} Ihres {window, select, hours {{hours, plural, one {#-Stunden-Limits} other {#-Stunden-Limits}}} weekly {Wochenlimits} other {{label}-Limits}} für {provider} verbraucht',
  'main.finished.inProject': '{n} Agenten in {project} fertig',
  'main.quit.closed': 'Combwork wurde geschlossen',
  'main.move.copied':
    "{n, plural, one {{owner, select, project {{host}: {n, number} Datei von {provider} für das Projekt kopiert.} assistant {{host}: {n, number} Datei von {provider} für den Assistenten kopiert.} worktree {{host}: {n, number} Datei von {provider} für das Arbeitsverzeichnis von {agent} kopiert.} other {{host}: {n, number} Datei von {provider} für {of} kopiert.}}} other {{owner, select, project {{host}: {n, number} Dateien von {provider} für das Projekt kopiert.} assistant {{host}: {n, number} Dateien von {provider} für den Assistenten kopiert.} worktree {{host}: {n, number} Dateien von {provider} für das Arbeitsverzeichnis von {agent} kopiert.} other {{host}: {n, number} Dateien von {provider} für {of} kopiert.}}}}"
}
const PSEUDO = /^\[/

afterEach(() => setLanguage('en', {}))

describe('notices: in the language shown, their Agent API title in English', () => {
  const seen: { type: string; notice?: { title: string }; windows?: true }[] = []
  let off: () => void
  beforeEach(() => {
    seen.length = 0
    off = onHiveEvent((e) => void seen.push(e as never))
    vi.spyOn(config, 'update').mockImplementation((fn: (c: ReturnType<typeof config.get>) => void) => fn(config.get()))
    config.get().planWarnings = {}
    // Hive in the background: a Windows notification, told to the Agent API's stream.
    setNotifyHost({ focused: () => null, fallback: () => null, workspaceOf: () => null })
  })
  afterEach(() => {
    off()
    vi.restoreAllMocks()
    Object.assign(config.settings.notifications, DEFAULT_SETTINGS.notifications)
  })
  /** What the Agent API's stream says of each notice told, and what the user sees of it. */
  const told = () => seen.filter((e) => e.type === 'notice').map((e) => ({ user: e.notice!.title, api: (apiEventFor(e as never, null) as { notice: { title: string } }).notice.title }))
  const usage = (percent: number) => ({ provider: 'claude-code', plan: null, limits: [{ id: 'five_hour', label: '5-hour', windowMinutes: 300, usedPercent: percent, resetsAt: null }], updatedAt: new Date().toISOString() }) as never

  it('a plan usage warning, before and after a language change', () => {
    setLanguage(PSEUDO_LANGUAGE, {})
    reportPlanUsage('claude-code', usage(96))
    setLanguage('de', GERMAN, 'de-DE')
    config.get().planWarnings = {}
    reportPlanUsage('claude-code', usage(97))
    const [pseudo, german] = told()
    expect(pseudo.user).toMatch(PSEUDO)
    expect(pseudo.api).toBe('96% of your Claude Code 5-hour limit used')
    expect(german).toEqual({ user: '97\u00a0% Ihres 5-Stunden-Limits für Claude Code verbraucht', api: '97% of your Claude Code 5-hour limit used' })
  })

  it("a plan limit's window: its hours as a number, the weekly one, else the provider's own label", () => {
    const limit = (windowMinutes: number | null, label: string) => ({ label, windowMinutes, usedPercent: 81, resetsAt: null })
    setLanguage('de', GERMAN, 'de-DE')
    const titles = [limit(120, '2-hour'), limit(10080, 'weekly'), limit(90, '2-hour'), limit(null, 'primary')].map((l) => planNotice('codex', l, 80))
    expect(titles.map((t) => t.apiTitle)).toEqual(['81% of your Codex 2-hour limit used', '81% of your Codex weekly limit used', '81% of your Codex 2-hour limit used', '81% of your Codex primary limit used'])
    expect(titles.map((t) => t.title)).toEqual(['81 % Ihres 2-Stunden-Limits für Codex verbraucht', '81 % Ihres Wochenlimits für Codex verbraucht', '81 % Ihres 2-hour-Limits für Codex verbraucht', '81 % Ihres primary-Limits für Codex verbraucht'])
  })

  it('Hive closing', () => {
    setLanguage('de', GERMAN, 'de-DE')
    const c = closedNotice(2)
    tell({ kind: 'quit', title: c.title, message: c.body, apiTitle: c.apiTitle })
    expect(told()).toEqual([{ user: 'Combwork wurde geschlossen', api: 'Combwork has closed' }])
  })

  it('finishes that came together; one alone keeps its own title', () => {
    const fin = (project: string, agent: string) => ({ projectPath: `D:/ws/${project}`, project, agent, title: `${agent} finished`, body: '' })
    const two = [fin('site', 'B1'), fin('site', 'B2')]
    setLanguage(PSEUDO_LANGUAGE, {})
    expect(finishedNotice(two).title).toMatch(PSEUDO)
    expect(finishedApiTitle(two)).toBe('2 agents finished in site')
    setLanguage('de', GERMAN, 'de-DE')
    expect(finishedNotice(two).title).toBe('2 Agenten in site fertig')
    expect(finishedApiTitle([...two, fin('api', 'C1')])).toBe('3 agents finished')
    expect(finishedApiTitle([two[0]])).toBe('B1 finished')
    // As the Agent API sends it: the English title, the user's beside it.
    const event = { type: 'notice', notice: { id: 'n1', kind: 'finished', title: finishedNotice(two).title, apiTitle: finishedApiTitle(two), body: 'B1, B2', projectPath: 'D:/ws/site' } }
    expect(apiEventFor(event as never, null)).toMatchObject({ notice: { title: '2 agents finished in site' } })
  })
})

describe("Repair's report of a copy: whose it is, kept as data", () => {
  const copy = (m: { of: string; owner?: MoveOwner }): PathDataCopy => ({ provider: 'claude-code', from: 'D:/old/b1', to: 'D:/new/b1', copy: 2, kept: [], ...m })

  it('recorded in one language, retried after a change to another: the whole sentence in the new one', () => {
    setLanguage(PSEUDO_LANGUAGE, {})
    // As project.json keeps it (pendingCopies), through a restart.
    const record = JSON.parse(JSON.stringify({ from: 'D:/old/b1', to: 'D:/new/b1', ...owned({ kind: 'worktree', agent: 'B1' }) }))
    expect(record).toEqual({ from: 'D:/old/b1', to: 'D:/new/b1', of: "B1's worktree", owner: { kind: 'worktree', agent: 'B1' } })
    setLanguage('de', GERMAN, 'de-DE')
    expect(copyReport('site', copy({ of: record.of, owner: moveOwner(record) ?? undefined }), 'Claude Code').done).toEqual(['site: 2 Dateien von Claude Code für das Arbeitsverzeichnis von B1 kopiert.'])
  })

  it("a record from before (an English label only): its owner recovered; a label that is no owner's, named as it is", () => {
    expect(moveOwner({ of: "Builder's worktree" })).toEqual({ kind: 'worktree', agent: 'Builder' })
    expect(moveOwner({ of: 'the project' })).toEqual({ kind: 'project' })
    expect(moveOwner({ of: 'the Assistant' })).toEqual({ kind: 'assistant' })
    expect(moveOwner({ of: 'somewhere' })).toBeNull()
    setLanguage('de', GERMAN, 'de-DE')
    expect(copyReport('site', copy({ of: 'the project' }), 'Codex').done).toEqual(['site: 2 Dateien von Codex für das Projekt kopiert.'])
    expect(copyReport('site', copy({ of: 'somewhere' }), 'Codex').done).toEqual(['site: 2 Dateien von Codex für somewhere kopiert.'])
  })

  it('reads as before in English', () => {
    const r = copyReport('site', { ...copy(owned({ kind: 'assistant' })), kept: ['a.jsonl'], failed: ['b.jsonl'] }, 'Claude Code')
    expect(r).toEqual({
      done: ["site: copied 2 files of Claude Code's conversations and memory for the Assistant to its folder for the new path (the old folder is kept)."],
      skipped: ["site: 1 file of Claude Code's for the Assistant already in D:/new/b1 with other content, not overwritten: a.jsonl."],
      failed: ["site: 1 file of Claude Code's for the Assistant couldn't be copied to D:/new/b1: b.jsonl. Repair tries them again."]
    })
  })
})

describe("Repair's report of a recreate git's prune refused (#1313)", () => {
  it('names the worktrees git would forget: an agent’s by its name, one Hive has no agent for by its folder', () => {
    const trees = [
      { agentName: 'Second', from: 'D:\\old\\ws.worktrees\\alpha\\second', to: null },
      { agentName: 'Third', from: 'D:\\old\\ws.worktrees\\alpha\\third', to: 'D:\\new\\ws.worktrees\\alpha\\third' }
    ]
    expect(blockerNames(['d:\\old\\ws.worktrees\\alpha\\second'], trees)).toEqual(["Second's worktree"])
    // git names only an unmanaged worktree (Second's registration is gone): never Second, whatever the plan says of it.
    expect(blockerNames(['D:\\old\\external-blocker'], trees)).toEqual(['external-blocker'])
    expect(blockerNames(['D:\\new\\ws.worktrees\\alpha\\third', '(lost)'], trees)).toEqual(["Third's worktree", '(lost)'])
  })
})

describe("Initialise Git Repository's reply", () => {
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, noSystem: process.env.GIT_CONFIG_NOSYSTEM }
  afterEach(() => {
    process.env.GIT_CONFIG_GLOBAL = saved.global
    if (saved.noSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
    else process.env.GIT_CONFIG_NOSYSTEM = saved.noSystem
  })

  it('in the language shown: its steps joined by the language, the first capitalised', { timeout: 60_000 }, async () => {
    const base = tempDir('hive-i18n-gitinit-')
    const global = join(base, 'global.gitconfig')
    writeFileSync(global, '[user]\n\tname = Global Person\n\temail = global@example.com\n')
    process.env.GIT_CONFIG_GLOBAL = global
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    const p = join(base, 'translated')
    mkdirSync(join(p, '.combwork'), { recursive: true })
    writeFileSync(join(p, '.combwork', 'sessions.json'), '{}\n')
    writeFileSync(join(p, 'a.txt'), 'a\n')
    projects = [p]
    setLanguage('pl', {
      'main.gitInit.done': '{steps}. Folder .combwork zostaje poza gitem.',
      'main.gitInit.step.init': 'utworzono repozytorium git na main',
      'main.gitInit.step.commit': '{n, plural, one {zatwierdzono # plik} few {zatwierdzono # pliki} many {zatwierdzono # plików} other {zatwierdzono # pliku}}'
    }, 'pl-PL')
    // The starter .gitignore's step has no translation: English, in the Polish sentence.
    expect(await initRepo(p, { gitignore: 'minimal' })).toBe('Utworzono repozytorium git na main, added a minimal .gitignore i zatwierdzono 2 pliki. Folder .combwork zostaje poza gitem.')
    expect(execFileSync('git', ['log', '--format=%s'], { cwd: p, encoding: 'utf8' }).trim()).toBe('Initial commit')
  })
})
