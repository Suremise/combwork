// Custom commands' model (HI-1954, src/shared/commands.ts): cleaning what is saved, HI-1368's single commands adopted
// into the lists once and the same way again, points resolved, and placeholders filled as written or said missing.
import { describe, expect, it } from 'vitest'
import { cleanHive, cleanWorkspace, commandsVersion, fillCommand, isCommandId, migrateHiveCommands, migratedId, migrateWorkspaceCommands, newCommandId, resolvePoint } from '../src/shared/commands'
import { DEFAULT_APP_CONFIG, mergeDefaults, migrateConfig } from '../src/shared/defaults'

const A = 'c-0000000a'
const B = 'c-0000000b'

describe('what is saved', () => {
  it('a command needs an id, a name and a command; its fields are trimmed and bounded; each id once', () => {
    const w = cleanWorkspace({
      list: [
        { id: A, name: ' DB ', command: ' start-db ', folder: '  ', needed: true, extra: 1 },
        { id: A, name: 'again', command: 'x' },
        { id: 'nope', name: 'n', command: 'x' },
        { id: B, name: '', command: 'x' },
        { id: B, name: 'Serve', command: 'x'.repeat(5000) }
      ]
    })
    expect(w.list).toEqual([{ id: A, name: 'DB', command: 'start-db', needed: true }, { id: B, name: 'Serve', command: 'x'.repeat(4000) }])
  })

  it("a point keeps its refs once, in order; Hive's quit point only Hive's; onUpdate only where it applies", () => {
    const w = cleanWorkspace({ onOpen: { run: [{ scope: 'workspace', id: B }, { scope: 'hive', id: A }, { scope: 'workspace', id: B }], onUpdate: true }, onClose: { run: [{ scope: 'other', id: A }], onUpdate: true } })
    expect(w.onOpen).toEqual({ run: [{ scope: 'workspace', id: B }, { scope: 'hive', id: A }] })
    expect(w.onClose).toEqual({ run: [], onUpdate: true })
    expect(cleanHive({ onQuit: { run: [{ scope: 'workspace', id: A }, { scope: 'hive', id: B }] } }).onQuit).toEqual({ run: [{ scope: 'hive', id: B }] })
  })

  it('new ids are well formed and differ', () => {
    const ids = new Set(Array.from({ length: 50 }, newCommandId))
    expect([...ids].every(isCommandId)).toBe(true)
    expect(ids.size).toBe(50)
  })
})

describe("HI-1368's single commands adopted (one way, the same again)", () => {
  it("a workspace's close command becomes a named command its close point runs, with its box", () => {
    const w = migrateWorkspaceCommands({ onClose: { command: ' backup.cmd "{workspace}" ', onUpdate: true } }, 'Close command')
    const id = migratedId('onClose', 'backup.cmd "{workspace}"')
    expect(w.list).toEqual([{ id, name: 'Close command', command: 'backup.cmd "{workspace}"' }])
    expect(w.onClose).toEqual({ run: [{ scope: 'workspace', id }], onUpdate: true })
    expect(w.onOpen).toEqual({ run: [] })
  })

  it('run again (a save that never happened, or a file with both): nothing added twice', () => {
    const once = migrateWorkspaceCommands({ onClose: { command: 'b.cmd', onUpdate: false } }, 'Close command')
    const twice = migrateWorkspaceCommands({ commands: once, onClose: { command: 'b.cmd', onUpdate: false } }, 'Close command')
    expect(twice).toEqual(once)
  })

  it('an empty or missing command adopts nothing', () => {
    expect(migrateWorkspaceCommands({ onClose: { command: '  ', onUpdate: true } }, 'x')).toEqual({ list: [], onOpen: { run: [] }, onClose: { run: [] } })
    expect(migrateHiveCommands({}, 'x')).toEqual({ list: [], onQuit: { run: [] } })
  })

  it("Hive's When Hive quits, run, at config load: adopted, and general.onQuit gone", () => {
    const raw = { version: 9, settings: { general: { onQuit: { command: 'sync.cmd {reason}', onUpdate: true } } } }
    const cfg = migrateConfig(mergeDefaults(structuredClone(DEFAULT_APP_CONFIG), raw), raw)
    const id = migratedId('onQuit', 'sync.cmd {reason}')
    expect(cfg.settings.commands.list).toEqual([{ id, name: 'Quit command', command: 'sync.cmd {reason}' }])
    expect(cfg.settings.commands.onQuit).toEqual({ run: [{ scope: 'hive', id }], onUpdate: true })
    expect(cfg.settings.general.onQuit).toBeUndefined()
  })
})

describe('points and versions', () => {
  it("a point resolves in order, from its scopes' lists; a ref to a deleted command is null", () => {
    const hive = [{ id: A, name: 'H', command: 'h' }]
    const workspace = [{ id: B, name: 'W', command: 'w' }]
    const r = resolvePoint({ run: [{ scope: 'workspace', id: B }, { scope: 'hive', id: A }, { scope: 'hive', id: B }] }, { hive, workspace })
    expect(r.map((x) => x.command?.name ?? null)).toEqual(['W', 'H', null])
  })

  it('a version changes with any command or point, and not otherwise', () => {
    const w = cleanWorkspace({ list: [{ id: A, name: 'a', command: 'x' }] })
    expect(commandsVersion(w)).toBe(commandsVersion(structuredClone(w)))
    expect(commandsVersion({ ...w, onOpen: { run: [{ scope: 'workspace', id: A }] } })).not.toBe(commandsVersion(w))
    expect(commandsVersion({ ...w, list: [{ id: A, name: 'a', command: 'y' }] })).not.toBe(commandsVersion(w))
  })
})

describe('placeholders', () => {
  const values = { workspace: 'C:\\Work\\Hive', name: 'Hive', reason: 'open' as const, projects: { api: 'C:\\Work\\Hive\\api' } }
  it('filled as written: the user quotes paths; other braces stay', () => {
    expect(fillCommand('backup "{workspace}" {name} {reason} "{project:API}" {other}', values)).toEqual({ text: 'backup "C:\\Work\\Hive" Hive open "C:\\Work\\Hive\\api" {other}', missing: [] })
  })
  it("one that can't be filled is said missing, once, and left as written", () => {
    expect(fillCommand('x {project:web} {workspace} {project:web}', { reason: 'quit' })).toEqual({ text: 'x {project:web} {workspace} {project:web}', missing: ['{project:web}', '{workspace}'] })
  })
})
