// HI-2598 (its design HI-2598/s9 §4 and §6): the names upgrade's stored values in a workspace's and its projects'
// settings files: project.json's workflow options (its own and each kept platform's), workspace.json's workflow
// defaults, command refs to Combwork's own list and advanced ids, and every template's sections, in the workspace and in
// each project. A fresh workspace changes nothing; a 1.0 one and a partly converted RC2 end the same; a second run writes
// nothing; a late project gets its own; a file that doesn't parse is left as it is. And a 1.0 export with 1.0's values
// is refused at import, never converted (HI-2611, replacing §6's import exception).
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { TEMPLATE_VERSION } from '../src/shared/templates'
import { tempDir } from './tempDir'

vi.mock('../src/main/events', async (orig) => ({ ...(await orig<object>()), toast: () => undefined }))

const base = tempDir('nameupgrade-values-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { moveFolders } = await import('../src/main/combworkMove')
const { NAMES_DONE_FILE, NAMES_VERSION } = await import('../src/main/nameUpgrade')
const { upgradedProjectConfig, upgradedTemplate, upgradedWorkspaceConfig, upgradeProjectValues, upgradeWorkspaceValues } = await import('../src/main/nameUpgradeValues')
const { readImport } = await import('../src/main/templates')

// old-name: begin nameUpgradeValues-inputs
/** The values 1.0 and RC2 stored: the finish, the commit message and command scope, an advanced id, 1.0's folder. */
const OLD_FINISH = 'hiveMerges'
const OLD_NAME = 'hive'
const OLD_REPLY = 'hive.mcp.replySeconds'
const OLD_DIR = '.hive'
/** The refusal of a 1.0 export (its text is HI-2625's, with the message). */
const OLD_EXPORT_REFUSED = /exported from version 1\.0, whose workflow settings Combwork doesn't import/
// old-name: end nameUpgradeValues-inputs

let n = 0
const json = (p: string, v: unknown): void => {
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, JSON.stringify(v, null, 2) + '\n')
}
const read = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'))

const template = (finish: string, commitMessage = finish === OLD_FINISH ? OLD_NAME : 'combwork'): unknown => ({ version: TEMPLATE_VERSION, name: 'Team', savedAt: '2026-10-05T10:00:00.000Z', layout: 'columns2', agents: [{ name: 'A', role: 'builder', provider: 'claude-code' }], workflow: { git: { preset: null, options: { finish, commitMessage } }, none: { preset: null, options: { review: true } } } })

/** A workspace with every stored value under 1.0's (`old`) or Combwork's names, its project alpha, as RC2 left the folders (.combwork). */
function workspace(old: boolean): { ws: string; alpha: string } {
  const ws = join(base, `ws${++n}`)
  const fin = old ? OLD_FINISH : 'combworkMerges'
  const msg = old ? OLD_NAME : 'combwork'
  const scope = old ? OLD_NAME : 'combwork'
  json(join(ws, '.combwork', 'workspace.json'), {
    workflow: { git: { finish: fin, commitMessage: msg }, none: { review: true } },
    commands: { list: [], onOpen: { run: [{ scope, id: 'tidy' }, { scope: 'workspace', id: 'w' }] }, onClose: { run: [{ scope, id: 'tidy' }], onUpdate: true } },
    advanced: old ? { [OLD_REPLY]: 600, 'claude-code.trust.prompt': 'x' } : { 'cw.mcp.replySeconds': 600, 'claude-code.trust.prompt': 'x' },
    commitMessageChosen: true
  })
  json(join(ws, '.combwork', 'templates', 'team.json'), template(fin))
  const alpha = join(ws, 'alpha')
  json(join(alpha, '.combwork', 'project.json'), { id: 'a1', workflow: { platform: 'git', preset: null, options: { finish: fin, commitMessage: msg, review: true }, kept: { none: { preset: null, options: { review: true } }, git: { preset: null, options: { finish: fin } } }, commitMessageChosen: true } })
  json(join(alpha, '.combwork', 'templates', 'own.json'), template(fin))
  return { ws, alpha }
}

function expectNew(w: { ws: string; alpha: string }): void {
  const want = workspace(false)
  for (const f of [join('.combwork', 'workspace.json'), join('.combwork', 'templates', 'team.json')]) expect(read(join(w.ws, f))).toEqual(read(join(want.ws, f)))
  for (const f of [join('.combwork', 'project.json'), join('.combwork', 'templates', 'own.json')]) expect(read(join(w.alpha, f))).toEqual(read(join(want.alpha, f)))
}

const stamps = (w: { ws: string; alpha: string }): number[] => [join(w.ws, '.combwork', 'workspace.json'), join(w.ws, '.combwork', 'templates', 'team.json'), join(w.alpha, '.combwork', 'project.json'), join(w.alpha, '.combwork', 'templates', 'own.json')].map((f) => statSync(f).mtimeMs)
const texts = (w: { ws: string; alpha: string }): string[] => [join(w.ws, '.combwork', 'workspace.json'), join(w.ws, '.combwork', 'templates', 'team.json'), join(w.alpha, '.combwork', 'project.json'), join(w.alpha, '.combwork', 'templates', 'own.json')].map((f) => readFileSync(f, 'utf8'))

describe("the names upgrade's stored values (HI-2598)", () => {
  it('each conversion is pure, null when nothing is old', () => {
    expect(upgradedProjectConfig({ workflow: { options: { finish: 'combworkMerges' } } })).toBeNull()
    expect(upgradedProjectConfig({})).toBeNull()
    expect(upgradedProjectConfig({ workflow: { options: {}, kept: { git: { options: { finish: OLD_FINISH } } } } })).toEqual({ workflow: { options: {}, kept: { git: { options: { finish: 'combworkMerges' } } } } })
    expect(upgradedWorkspaceConfig({ commands: { onOpen: { run: [{ scope: 'combwork', id: 'x' }] } }, advanced: { 'cw.mcp.replySeconds': 1 } })).toBeNull()
    // Both refs there: one kept. Both advanced ids there: the cw one wins.
    expect(upgradedWorkspaceConfig({ commands: { onOpen: { run: [{ scope: OLD_NAME, id: 'x' }, { scope: 'combwork', id: 'x' }] } }, advanced: { [OLD_REPLY]: 1, 'cw.mcp.replySeconds': 2 } })).toEqual({ commands: { onOpen: { run: [{ scope: 'combwork', id: 'x' }] } }, advanced: { 'cw.mcp.replySeconds': 2 } })
    expect(upgradedTemplate({ workflow: { git: { options: { finish: 'combworkMerges' } } } })).toBeNull()
    expect(upgradedTemplate('nope')).toBeNull()
  })

  it('a workspace with nothing old: nothing rewritten', async () => {
    const w = workspace(false)
    const before = texts(w)
    const at = stamps(w)
    await moveFolders(w.ws)
    expect(texts(w)).toEqual(before)
    expect(stamps(w)).toEqual(at)
    expect((read(join(w.ws, '.combwork', NAMES_DONE_FILE)) as { version: number }).version).toBe(NAMES_VERSION)
  })

  it('a 1.0 workspace with every old value (moved from its 1.0 folders) ends with the new ones; a second open writes nothing', async () => {
    const w = workspace(true)
    // 1.0's folders, in the workspace and the project.
    const { renameSync } = await import('fs')
    renameSync(join(w.ws, '.combwork'), join(w.ws, OLD_DIR))
    renameSync(join(w.alpha, '.combwork'), join(w.alpha, OLD_DIR))
    await moveFolders(w.ws)
    expectNew(w)
    // As Combwork's writer writes them, commitMessageChosen kept.
    expect(readFileSync(join(w.alpha, '.combwork', 'project.json'), 'utf8')).toBe(JSON.stringify(read(join(w.alpha, '.combwork', 'project.json')), null, 2) + '\n')
    expect((read(join(w.alpha, '.combwork', 'project.json')) as { workflow: { commitMessageChosen: unknown } }).workflow.commitMessageChosen).toBe(true)
    // Recorded at an older version: the steps run again, and change nothing now.
    json(join(w.ws, '.combwork', NAMES_DONE_FILE), { version: 1 })
    const at = stamps(w)
    await moveFolders(w.ws)
    expect(stamps(w)).toEqual(at)
    expect((read(join(w.ws, '.combwork', NAMES_DONE_FILE)) as { version: number }).version).toBe(NAMES_VERSION)
  })

  it('an RC2 workspace partly converted (its project done, the workspace not) ends the same', async () => {
    const w = workspace(true)
    const done = workspace(false)
    for (const f of [join('.combwork', 'project.json'), join('.combwork', 'templates', 'own.json')]) writeFileSync(join(w.alpha, f), readFileSync(join(done.alpha, f)))
    await moveFolders(w.ws)
    expectNew(w)
  })

  it('a late project (`only`) gets its own values converted', async () => {
    const w = workspace(false)
    await moveFolders(w.ws)
    const beta = join(w.ws, 'beta')
    json(join(beta, '.combwork', 'project.json'), { workflow: { platform: 'git', preset: null, options: { finish: OLD_FINISH } } })
    json(join(beta, '.combwork', 'templates', 'b.json'), template(OLD_FINISH))
    await moveFolders(w.ws, { only: beta })
    expect(read(join(beta, '.combwork', 'project.json'))).toEqual({ workflow: { platform: 'git', preset: null, options: { finish: 'combworkMerges' } } })
    expect(read(join(beta, '.combwork', 'templates', 'b.json'))).toEqual(template('combworkMerges'))
  })

  it("a file that doesn't parse is left as it is; the others are converted", async () => {
    const w = workspace(true)
    const broken = `{ "workflow": { "options": { "finish": "${OLD_FINISH}" `
    writeFileSync(join(w.alpha, '.combwork', 'project.json'), broken)
    writeFileSync(join(w.ws, '.combwork', 'templates', 'bad.json'), broken)
    await moveFolders(w.ws)
    expect(readFileSync(join(w.alpha, '.combwork', 'project.json'), 'utf8')).toBe(broken)
    expect(readFileSync(join(w.ws, '.combwork', 'templates', 'bad.json'), 'utf8')).toBe(broken)
    expect(read(join(w.ws, '.combwork', 'templates', 'team.json'))).toEqual(template('combworkMerges'))
  })

  it("an import of a 1.0 export with 1.0's finish is refused, saying why; one with Combwork's values imports (HI-2611)", async () => {
    const file = join(base, `export${++n}.combwork-template.json`)
    const t = template(OLD_FINISH) as Record<string, unknown>
    json(file, { ...t, workflow: { git: { preset: null, options: { finish: OLD_FINISH, folder: 'slots' } } } })
    await expect(readImport(file)).rejects.toThrow(OLD_EXPORT_REFUSED)
    const now = join(base, `export${++n}.combwork-template.json`)
    json(now, { ...t, workflow: { git: { preset: null, options: { finish: 'combworkMerges', folder: 'slots' } } } })
    expect((await readImport(now)).workflow?.git?.options).toEqual({ finish: 'combworkMerges', folder: 'slots' })
  })

  it('a file it cannot read now (another program holds it) is left for the next open: not settled, so nothing is recorded, and the rest still converts', async () => {
    const w = workspace(true)
    // A folder where the file is: an error reading it other than its absence.
    const held = join(w.alpha, '.combwork', 'project.json')
    const { renameSync, rmSync } = await import('fs')
    renameSync(held, `${held}.kept`)
    mkdirSync(held)
    expect(await upgradeProjectValues(w.alpha)).toBe(false)
    expect(read(join(w.alpha, '.combwork', 'templates', 'own.json'))).toEqual(read(join(workspace(false).alpha, '.combwork', 'templates', 'own.json')))
    rmSync(held, { recursive: true })
    renameSync(`${held}.kept`, held)
    expect(await upgradeProjectValues(w.alpha)).toBe(true)
    expect(await upgradeWorkspaceValues(w.ws)).toBe(true)
    expectNew(w)
  })
})
