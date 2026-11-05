import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { setLanguage, setProblemReporter, tr, tRich, type Msg } from '../../src/shared/i18n'
import { PSEUDO_LANGUAGE } from '../../src/shared/i18n/languages'
import { otherUsers, shortcutUsers } from '../../src/renderer/src/keyConflicts'

// #795: the `shell` area: commands (their names, categories and hover tips), the title bar's menus, the command palette,
// dialog chrome, the quit, Compact and Provider Setup dialogs, About, Diagnostics and shortcuts. The renderer's modules
// load React views, so this checks commands.ts's source and the area's messages as extracted.

const ROOT = resolve(__dirname, '../..')
const EN = JSON.parse(readFileSync(join(ROOT, 'locales/en/shell.json'), 'utf8')) as Record<string, { defaultMessage: string; description: string }>
const COMMANDS = readFileSync(join(ROOT, 'src/renderer/src/commands.ts'), 'utf8')
const m = (id: string): Msg => {
  const e = EN[id]
  if (!e) throw new Error(`no message ${id}`)
  return { id, defaultMessage: e.defaultMessage, description: e.description }
}

const problems: string[] = []
afterEach(() => {
  setLanguage('en', {})
  setProblemReporter(() => undefined)
  problems.length = 0
})

describe('commands', () => {
  it('every command has a name message (shell.command.<id>), none a label written as text', () => {
    const ids = [...COMMANDS.matchAll(/\{\s*id: '([\w.]+)',\s*name: msg\(\{ id: '([\w.]+)'/g)]
    expect(ids.length).toBeGreaterThan(100)
    for (const [, id, msgId] of ids) {
      expect(msgId, id).toBe(`shell.command.${id}`)
      expect(EN[msgId], msgId).toBeTruthy()
    }
    expect(COMMANDS).not.toMatch(/\blabel: ['"`]/)
    // The three named by values: a layout, an agent's number, Combwork's name.
    for (const id of ['shell.command.layout', 'shell.command.agent.focusN', 'shell.command.help.about']) expect(EN[id], id).toBeTruthy()
  })

  it("a command's label is its name in the language shown, read each time (a getter)", () => {
    expect(COMMANDS).toMatch(/Object\.defineProperty\(d as Command, 'label', \{ get: \(\) => tr\(d\.name, d\.nameValues\)/)
  })

  it('every category is an id with a name message; Project and Session ones can be overridden by a project', () => {
    const used = new Set([...COMMANDS.matchAll(/category: '(\w+)'/g)].map((x) => x[1]))
    expect(used.size).toBeGreaterThanOrEqual(10)
    for (const c of used) {
      expect(c, c).toMatch(/^[a-z]+$/)
      expect(EN[`shell.category.${c}`], c).toBeTruthy()
    }
    expect(COMMANDS).toContain("PROJECT_KEYBINDING_CATEGORIES.some((x) => x.toLowerCase() === c.category)")
  })

  it('Help → Improve This Translation opens the translators\' section of CONTRIBUTING, which has that heading', () => {
    expect(COMMANDS).toContain("id: 'help.improveTranslation'")
    const anchor = /TRANSLATING_URL = '[^']*CONTRIBUTING\.md#([\w-]+)'/.exec(COMMANDS)?.[1]
    expect(anchor).toBe('fix-a-translation')
    expect(readFileSync(join(ROOT, 'CONTRIBUTING.md'), 'utf8')).toMatch(/^## Fix a translation$/m)
    expect(readFileSync(join(ROOT, 'src/renderer/src/components/TitleBar.tsx'), 'utf8')).toContain("'help.improveTranslation'")
  })
})

describe('the sentences built from parts are whole messages, and read as before in English', () => {
  it('the quit dialog', () => {
    const stops = m('shell.quit.stops')
    // #911: a whole sentence for each case, not a subject and an object glued together.
    const say = (how: string, busy: boolean, n: number, windows = 1): string => tr(stops, { how, windows, busy: busy ? 'yes' : 'no', n })
    expect(say('app', true, 2)).toBe('Quitting stops all 2 sessions.')
    expect(say('app', true, 1)).toBe('Quitting stops its session.')
    expect(say('app', false, 1)).toBe('Quitting stops the running session.')
    expect(say('workspace', false, 3)).toBe('Closing the workspace stops its 3 running sessions.')
    expect(say('switch', true, 2)).toBe("Switching workspace stops this workspace's 2 sessions.")
    expect(say('window', true, 1)).toBe("Closing this window stops this workspace's session.")
    expect(say('allWindows', false, 4, 3)).toBe('Quitting closes all 3 windows and stops 4 running sessions, in every workspace.')
    expect(tr(m('shell.errorBoundary.named'), { view: 'progress' })).toBe("The Progress panel ran into a problem and couldn't be shown.")
    expect(tr(m('shell.errorBoundary.named'), { view: 'hive' })).toBe("Combwork ran into a problem and couldn't be shown.")
    expect(tr(m('shell.quit.busy'), { n: 1 })).toBe('An agent is in the middle of something.')
    expect(tr(m('shell.quit.title'), { how: 'allWindows', windows: 2 })).toBe('Quit Combwork and close all 2 windows?')
    expect(tr(m('shell.quit.now'), { action: 'saveAndQuit' })).toBe('Save and quit now')
    expect(tr(m('shell.quit.when'), { action: 'quit', working: 2 })).toBe('Quit when agents finish')
    expect(tr(m('shell.quit.windowOnly'), { named: 'yes', workspace: 'ws', others: 1 })).toBe('Meant to close only this window (ws)? Its agents stop, and the other window stays open, as with its X.')
    expect(tr(m('shell.quit.unsaved'), { n: 1 })).toBe('1 file has unsaved changes.')
  })

  it('batch commands, the palette and the rest', () => {
    expect(tr(m('shell.command.session.startNewAllLive'), { several: 'yes', n: 3 })).toBe('Start New (3)…')
    expect(tr(m('shell.command.session.archiveAllLive'), { several: 'no', n: 0 })).toBe('Archive and Start New…')
    expect(tr(m('shell.command.session.removeAllLive'), { n: 1 })).toBe('Remove Agent…')
    expect(tr(m('shell.command.session.removeAllLive'), { n: 4 })).toBe('Remove All Agents (4)…')
    expect(tr(m('shell.palette.command'), { category: 'Session', command: 'Compact Conversation…' })).toBe('Session: Compact Conversation…')
    expect(tr(m('shell.compact.title'), { several: 'yes', project: 'alpha', agent: 'One' })).toBe('Compact alpha · One?')
    expect(tr(m('shell.setup.signedInAs'), { account: 'me@x', method: 'none' })).toBe('Signed in as me@x')
    expect(tr(m('shell.setup.signedInAs'), { account: 'none', method: 'OAuth' })).toBe('Signed in (OAuth)')
    expect(tr(m('shell.table.selectAllMatching'), { n: 12 })).toBe('Select all 12 matching rows')
  })

  it('every message of the area shows in another language with no problem reported (numbers for plurals, text else)', () => {
    setProblemReporter((p) => problems.push(p))
    setLanguage(PSEUDO_LANGUAGE, {})
    for (const id of Object.keys(EN)) {
      const text = EN[id].defaultMessage
      const names = [...text.matchAll(/\{(\w+)(?:, (plural|select|number))?/g)]
      const values = Object.fromEntries(names.map(([, n, kind]) => [n, kind === 'plural' || kind === 'number' ? 2 : kind === 'select' ? 'other' : 'X']))
      // A message with tags is shown with tRich, each tag drawn by a function.
      const tags = [...text.matchAll(/<(\w+)>/g)].map((x) => x[1])
      const shown = tags.length ? tRich<string>(m(id), { ...values, ...Object.fromEntries(tags.map((t) => [t, (chunks: string[]) => chunks.join('')])) }).join('') : tr(m(id), values)
      expect(shown, id).toMatch(/^\[/)
    }
    expect(problems).toEqual([])
  })
})

describe('round 1 of review (#795)', () => {
  it('shortcut clashes are kept by command id: never a clash with itself, and two commands named alike still clash', () => {
    const users = shortcutUsers([
      { id: 'palette.show', key: 'Mod+Shift+P' },
      { id: 'project.goto', key: 'mod+shift+p' },
      { id: 'view.board', key: 'Mod+Shift+J' },
      { id: 'help.docs', key: undefined }
    ])
    expect(otherUsers(users, 'Mod+Shift+P', 'palette.show')).toEqual(['project.goto'])
    expect(otherUsers(users, 'MOD+SHIFT+P', 'project.goto')).toEqual(['palette.show'])
    expect(otherUsers(users, 'Mod+Shift+J', 'view.board')).toEqual([])
    expect(otherUsers(users, undefined, 'help.docs')).toEqual([])
    // The editor keeps no labels: it names the commands (with their categories, HI-1838) when it shows a clash.
    const editor = readFileSync(join(ROOT, 'src/renderer/src/components/Keybindings.tsx'), 'utf8')
    expect(editor).toContain('otherUsers(conflicts, r.key, r.c.id).map(commandIn)')
    expect(editor).not.toMatch(/filter\(\(l\) => l !== /)
  })

  it('the palette is made again when the language changes', () => {
    expect(readFileSync(join(ROOT, 'src/renderer/src/components/Overlays.tsx'), 'utf8')).toContain('}, [q, projects, open, mode, shownLanguage, tasks, keys, moved, hiveCommands, wsCommands])')
  })

  it("an agent's background tasks are whole sentences with the count, which a language words by the count", () => {
    expect(tr(m('shell.status.waitingOnTasks'), { n: 1 })).toBe('Waiting on 1 background task')
    expect(tr(m('shell.status.finishedWithTasks'), { n: 2 })).toBe('Finished · 2 background tasks running')
    expect(tr(m('shell.status.readyWithTasks'), { n: 1 })).toBe('Ready · 1 background task running')
    expect(EN['shell.status.tasks']).toBeUndefined()
    // Polish says "1 task is running", "2 tasks are running", "5 tasks are running" each its own way.
    setProblemReporter((p) => problems.push(p))
    setLanguage('pl', { 'shell.status.finishedWithTasks': '{n, plural, one {Gotowe · działa # zadanie w tle} few {Gotowe · działają # zadania w tle} other {Gotowe · działa # zadań w tle}}' }, 'pl-PL')
    expect([1, 2, 5].map((n) => tr(m('shell.status.finishedWithTasks'), { n }))).toEqual(['Gotowe · działa 1 zadanie w tle', 'Gotowe · działają 2 zadania w tle', 'Gotowe · działa 5 zadań w tle'])
    expect(problems).toEqual([])
  })
})
