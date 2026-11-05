// Combwork's bundled skills and modes in a workspace (src/main/bundled.ts): new ones are added, untouched copies of
// older versions updated, edited copies and same-name folders of the user's kept, deleted ones left deleted; a swap
// never leaves a half-copied folder; the recorded versions cover what ships (scripts/bundled-history.mjs).
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { open } from 'fs/promises'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { bundledAction, type BundledInput } from '../src/main/bundled'
import { cleanSwaps, contentHash, copySkillTree, swapIn } from '../src/main/fsutil'
import HISTORY from '../src/main/bundledHistory.json'
import { tempDir } from './tempDir'

const RES = join(__dirname, '..', 'resources')

describe('what to do with a bundled item', () => {
  const base: BundledInput = { shipped: 'v3', copy: 'v3', given: { from: 'v3' }, manifest: true, versions: ['v1', 'v2', 'v3'], shippedBefore: true, folder: true }
  const act = (p: Partial<BundledInput>) => bundledAction({ ...base, ...p })

  it('adds one the workspace was never given', () => {
    expect(act({ copy: null, given: undefined })).toBe('add')
    // A workspace from before the manifest gets the ones that are new since.
    expect(act({ copy: null, given: undefined, manifest: false, shippedBefore: false })).toBe('add')
    // A workspace from before modes has no modes folder: it was never given them.
    expect(act({ copy: null, given: undefined, manifest: false, folder: false })).toBe('add')
  })

  it('leaves a deleted one deleted', () => {
    expect(act({ copy: null })).toBe('deleted')
    expect(act({ copy: null, given: { from: null } })).toBe('deleted')
    // Without a manifest, one that shipped before was given, so it was deleted.
    expect(act({ copy: null, given: undefined, manifest: false })).toBe('deleted')
  })

  it('updates an untouched copy of an older version, and only an older one', () => {
    expect(act({ copy: 'v1', given: { from: 'v1' } })).toBe('update')
    expect(act({ copy: 'v2', given: undefined, manifest: false })).toBe('update')
    // A version reverted to (v1 → v2 → v1): the copy of v2 is older than this v1.
    expect(act({ shipped: 'v1', copy: 'v2', versions: ['v1', 'v2', 'v1'] })).toBe('update')
    // A copy of a version this Combwork doesn't know (a newer Combwork's, sharing the workspace) stays.
    expect(act({ copy: 'v4' })).toBe('keep')
    expect(act({ copy: 'v3' })).toBe('keep')
  })

  it('keeps an edited copy and a same-name folder of the user', () => {
    expect(act({ copy: 'edited', given: { from: 'v2' } })).toBe('keep')
    expect(act({ copy: 'mine', given: undefined, manifest: false })).toBe('keep')
  })
})

describe('recorded versions', () => {
  it('include the version of each bundled skill and mode that ships now, as its latest', async () => {
    const history = HISTORY as Record<'skills' | 'modes' | 'dialects', Record<string, string[]>>
    for (const name of readdirSync(join(RES, 'skills'))) {
      expect(history.skills[name]?.at(-1), `${name}: run npm run bundled-history`).toBe(await contentHash(join(RES, 'skills', name)))
    }
    for (const f of readdirSync(join(RES, 'modes'))) {
      const id = f.replace(/\.md$/, '')
      expect(history.modes[id]?.at(-1), `${id}: run npm run bundled-history`).toBe(await contentHash(join(RES, 'modes', f)))
    }
    // Dialect files (HI-2439), each `<folder>/<label>`, once Combwork ships them.
    const dialects = join(RES, 'dialects')
    for (const folder of existsSync(dialects) ? readdirSync(dialects) : []) {
      for (const f of readdirSync(join(dialects, folder)).filter((n) => n.endsWith('.json'))) {
        const id = `${folder}/${f.slice(0, -5)}`
        expect(history.dialects[id]?.at(-1), `${id}: run npm run bundled-history`).toBe(await contentHash(join(dialects, folder, f)))
      }
    }
  })

  it('counts a link by where it points, without following it', async () => {
    const dir = tempDir('cw-hash-link-')
    const plain = join(dir, 'plain')
    const linked = join(dir, 'linked')
    const target = join(dir, 'target')
    for (const d of [plain, linked, target]) mkdirSync(d, { recursive: true })
    writeFileSync(join(plain, 'SKILL.md'), 'same')
    writeFileSync(join(linked, 'SKILL.md'), 'same')
    writeFileSync(join(target, 'custom.md'), 'mine')
    const before = await contentHash(linked)
    expect(before).toBe(await contentHash(plain))
    symlinkSync(target, join(linked, 'references'), 'junction')
    const withLink = await contentHash(linked)
    expect(withLink).not.toBe(before)
    // What the link points to isn't read: changing the target's files doesn't change the hash.
    writeFileSync(join(target, 'custom.md'), 'mine, edited')
    expect(await contentHash(linked)).toBe(withLink)
    rmSync(dir, { recursive: true, force: true })
  })

  it("ignores line endings, so a checkout's CRLF is the same version", async () => {
    const dir = tempDir('cw-hash-')
    mkdirSync(join(dir, 'a', 'ref'), { recursive: true })
    mkdirSync(join(dir, 'b', 'ref'), { recursive: true })
    writeFileSync(join(dir, 'a', 'SKILL.md'), 'one\ntwo\n')
    writeFileSync(join(dir, 'b', 'SKILL.md'), 'one\r\ntwo\r\n')
    writeFileSync(join(dir, 'a', 'ref', 'x.md'), 'x')
    writeFileSync(join(dir, 'b', 'ref', 'x.md'), 'x')
    // Combwork's copy marker isn't content.
    writeFileSync(join(dir, 'b', '.combwork-copy'), '{}')
    expect(await contentHash(join(dir, 'a'))).toBe(await contentHash(join(dir, 'b')))
    writeFileSync(join(dir, 'b', 'ref', 'x.md'), 'y')
    expect(await contentHash(join(dir, 'a'))).not.toBe(await contentHash(join(dir, 'b')))
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('swapping a folder in', () => {
  const dir = tempDir('cw-swap-')
  const src = join(dir, 'src')
  mkdirSync(join(src, 'references'), { recursive: true })
  writeFileSync(join(src, 'SKILL.md'), 'new')
  writeFileSync(join(src, 'references', 'r.md'), 'new ref')
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('replaces the whole folder, references included, and adds to the copy before it goes in', async () => {
    const dest = join(dir, 'skills', 'a')
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'SKILL.md'), 'old')
    writeFileSync(join(dest, 'stale.md'), 'gone after')
    await swapIn(src, dest, { prepare: async (copy) => writeFileSync(join(copy, '.combwork-copy'), 'marker') })
    expect(readdirSync(dest).sort()).toEqual(['.combwork-copy', 'SKILL.md', 'references'])
    expect(readFileSync(join(dest, 'references', 'r.md'), 'utf8')).toBe('new ref')
    expect(readdirSync(join(dir, 'skills'))).toEqual(['a'])
  })

  it.runIf(process.platform === 'win32')('leaves the old folder as it was when a file in it is open', async () => {
    const dest = join(dir, 'skills', 'busy')
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'SKILL.md'), 'old')
    const handle = await open(join(dest, 'SKILL.md'), 'r')
    try {
      await expect(swapIn(src, dest)).rejects.toThrow()
    } finally {
      await handle.close()
    }
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toBe('old')
    expect(readdirSync(join(dir, 'skills')).sort()).toEqual(['a', 'busy'])
  })

  it('tidies what a crash between the steps leaves', async () => {
    const parent = join(dir, 'crash')
    mkdirSync(join(parent, '.x.cw-old-1-1'), { recursive: true })
    writeFileSync(join(parent, '.x.cw-old-1-1', 'SKILL.md'), 'kept')
    mkdirSync(join(parent, '.y.cw-new-1-2'), { recursive: true })
    mkdirSync(join(parent, 'z'), { recursive: true })
    mkdirSync(join(parent, '.z.cw-old-1-3'), { recursive: true })
    await cleanSwaps(parent)
    // x's place was empty: the old copy comes back. A copy not yet in place goes, as does an old one replaced.
    expect(readdirSync(parent).sort()).toEqual(['x', 'z'])
    expect(readFileSync(join(parent, 'x', 'SKILL.md'), 'utf8')).toBe('kept')
  })
})

describe('a workspace', () => {
  const base = tempDir('cw-bundled-')
  ;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
  // Trash is the Recycle Bin in Combwork; here it deletes.
  ;(electron.shell as unknown as { trashItem: (p: string) => Promise<void> }).trashItem = async (p) => rmSync(p, { recursive: true, force: true })
  const skillsDir = (ws: string) => join(ws, '.combwork', 'skills')
  const OLD_HANDOVER = '---\nname: handover\ndescription: An older handover skill.\n---\n\nOld text.\n'
  const OLD_OVERSEER = '---\nname: Overseer\ndescription: A lighthouse keeper.\nicon: 🗼\n---\n\nYou keep the light.\n'
  const OLD_COORDINATOR = '---\nname: Coordinator\ndescription: An older coordinator.\nicon: 🧭\n---\n\nOld text.\n'
  const OLD_USE_HIVE_API = '---\nname: use-hive-api\ndescription: Hive\'s HTTP API.\n---\n\nAs shipped.\n'
  let mod: typeof import('../src/main/bundled')
  let wsMod: typeof import('../src/main/workspace')
  let skills: typeof import('../src/main/skills')
  let modesMod: typeof import('../src/main/modes')
  let oldHash = ''
  let oldCoordinator = ''

  beforeAll(async () => {
    // The history this Combwork "shipped": an older handover, then today's of each.
    const old = join(base, 'old-handover')
    mkdirSync(old, { recursive: true })
    writeFileSync(join(old, 'SKILL.md'), OLD_HANDOVER)
    const history = structuredClone(HISTORY) as Record<'skills' | 'modes', Record<string, string[]>>
    oldHash = await contentHash(old)
    history.skills.handover = [oldHash, ...history.skills.handover]
    // An Overseer persona this Combwork "shipped" before working modes replaced it (#259).
    writeFileSync(join(base, 'old-overseer.md'), OLD_OVERSEER)
    history.modes.overseer = [...(history.modes.overseer ?? []), await contentHash(join(base, 'old-overseer.md'))]
    // An older Coordinator, so a copy of it is an untouched one to update.
    writeFileSync(join(base, 'old-coordinator.md'), OLD_COORDINATOR)
    oldCoordinator = await contentHash(join(base, 'old-coordinator.md'))
    history.modes.coordinator = [oldCoordinator, ...history.modes.coordinator]
    // A use-hive-api this Hive "shipped" before the skill was renamed use-cw-api (HI-2463).
    mkdirSync(join(base, 'old-use-hive-api'), { recursive: true })
    writeFileSync(join(base, 'old-use-hive-api', 'SKILL.md'), OLD_USE_HIVE_API)
    history.skills['use-hive-api'] = [...(history.skills['use-hive-api'] ?? []), await contentHash(join(base, 'old-use-hive-api'))]
    vi.resetModules()
    vi.doMock('../src/main/bundledHistory.json', () => ({ default: history }))
    mod = await import('../src/main/bundled')
    wsMod = await import('../src/main/workspace')
    skills = await import('../src/main/skills')
    modesMod = await import('../src/main/modes')
  })
  afterAll(() => rmSync(base, { recursive: true, force: true }))

  const opened = async (path: string) => {
    const w = wsMod.createWorkspaceService()
    await w.open(path)
    return w
  }

  it('a new one gets every bundled skill and mode, and the manifest records them', async () => {
    const ws = join(base, 'fresh')
    mkdirSync(ws, { recursive: true })
    const w = await opened(ws)
    try {
      await wsMod.inWorkspace(w, () => mod.syncBundled({ fresh: true }))
      expect(readdirSync(skillsDir(ws)).sort()).toEqual(readdirSync(join(RES, 'skills')).sort())
      expect(readdirSync(join(ws, '.combwork', 'modes')).sort()).toEqual(readdirSync(join(RES, 'modes')).sort())
      const m = JSON.parse(readFileSync(join(ws, '.combwork', 'bundled.json'), 'utf8'))
      expect(m.skills['work-on-card'].from).toBe(await contentHash(join(RES, 'skills', 'work-on-card')))
    } finally {
      await wsMod.disposeWorkspaceService(w)
    }
  })

  it('writes the manifest only when it changes what the file holds (HI-1705: every open wrote it)', async () => {
    const ws = join(base, 'unchanged')
    mkdirSync(ws, { recursive: true })
    const w = await opened(ws)
    try {
      await wsMod.inWorkspace(w, () => mod.syncBundled({ fresh: true }))
      const file = join(ws, '.combwork', 'bundled.json')
      // A mark the sync would overwrite if it wrote the file: still there after one that changes nothing.
      const text = readFileSync(file, 'utf8')
      writeFileSync(file, text + ' ')
      await wsMod.inWorkspace(w, () => mod.syncBundled())
      expect(readFileSync(file, 'utf8')).toBe(text + ' ')
      // A manifest from before 0.9.3 (its modes under "personas") is written in today's form, though nothing else changed.
      const m = JSON.parse(text)
      writeFileSync(file, JSON.stringify({ skills: m.skills, personas: m.modes }))
      await wsMod.inWorkspace(w, () => mod.syncBundled())
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(m)
    } finally {
      await wsMod.disposeWorkspaceService(w)
    }
  })

  it('an older one: untouched copies updated, edited ones and the user’s kept, deleted ones left, new ones added', async () => {
    const ws = join(base, 'older')
    // Hive 0.3's workspace: skills (one untouched old, one edited, one deleted, one a user folder) and no modes folder.
    mkdirSync(join(ws, '.combwork', 'skills', 'handover'), { recursive: true })
    writeFileSync(join(skillsDir(ws), 'handover', 'SKILL.md'), OLD_HANDOVER.replace(/\n/g, '\r\n'))
    mkdirSync(join(skillsDir(ws), 'merge-ready'), { recursive: true })
    writeFileSync(join(skillsDir(ws), 'merge-ready', 'SKILL.md'), '---\nname: merge-ready\ndescription: Mine now.\n---\n\nMy own steps.\n')
    for (const n of ['review-agent-work', 'split-work', 'workspace-note']) mkdirSync(join(skillsDir(ws), n), { recursive: true })
    for (const n of ['review-agent-work', 'split-work', 'workspace-note']) writeFileSync(join(skillsDir(ws), n, 'SKILL.md'), readFileSync(join(RES, 'skills', n, 'SKILL.md')))
    // pick-up was deleted by the user.
    const w = await opened(ws)
    try {
      await wsMod.inWorkspace(w, () => mod.syncBundled())
      const text = (n: string) => readFileSync(join(skillsDir(ws), n, 'SKILL.md'), 'utf8')
      expect(text('handover')).toBe(readFileSync(join(RES, 'skills', 'handover', 'SKILL.md'), 'utf8'))
      expect(text('merge-ready')).toContain('My own steps.')
      expect(existsSync(join(skillsDir(ws), 'pick-up'))).toBe(false)
      expect(existsSync(join(skillsDir(ws), 'work-on-card', 'SKILL.md'))).toBe(true)
      expect(readdirSync(join(ws, '.combwork', 'modes')).length).toBe(readdirSync(join(RES, 'modes')).length)

      // The views: the edited copy is "changed", the deleted one "missing" (Restore), the rest Combwork's.
      const listed = await wsMod.inWorkspace(w, () => skills.combworkSkills(true))
      const state = Object.fromEntries(listed.map((s) => [s.name, s.bundled]))
      expect(state).toMatchObject({ handover: 'same', 'merge-ready': 'changed', 'pick-up': 'missing', 'work-on-card': 'same' })

      // Opening again changes nothing: a deleted skill isn't brought back, an edited one isn't touched.
      rmSync(join(skillsDir(ws), 'work-on-card'), { recursive: true })
      await wsMod.inWorkspace(w, () => mod.syncBundled())
      expect(existsSync(join(skillsDir(ws), 'work-on-card'))).toBe(false)
      expect(existsSync(join(skillsDir(ws), 'pick-up'))).toBe(false)
      expect(text('merge-ready')).toContain('My own steps.')

      // Restore puts one back as Combwork's, and later updates follow it again.
      await wsMod.inWorkspace(w, () => skills.restoreBundledSkill('pick-up'))
      expect((await wsMod.inWorkspace(w, () => skills.combworkSkills(true))).find((s) => s.name === 'pick-up')?.bundled).toBe('same')
    } finally {
      await wsMod.disposeWorkspaceService(w)
    }
  })

  it('retires the old personas (#259): an untouched copy goes, an edited one stays, and an Assistant that used one moves to its mode', async () => {
    const ws = join(base, 'retired')
    const modes = join(ws, '.combwork', 'modes')
    mkdirSync(modes, { recursive: true })
    writeFileSync(join(modes, 'overseer.md'), OLD_OVERSEER.replace(/\n/g, '\r\n'))
    writeFileSync(join(modes, 'reviewer.md'), '---\nname: Reviewer\n---\n\nMy own reviewer.\n')
    // The workspace's Assistant chose the Overseer.
    mkdirSync(join(ws, '.combwork', 'assistant', '.combwork'), { recursive: true })
    writeFileSync(join(ws, '.combwork', 'assistant', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'assistant', name: 'Assistant', mode: 'overseer' }] }))
    const w = await opened(ws)
    try {
      await wsMod.inWorkspace(w, () => mod.syncBundled())
      expect(existsSync(join(modes, 'overseer.md'))).toBe(false)
      expect(readFileSync(join(modes, 'reviewer.md'), 'utf8')).toContain('My own reviewer.')
      // The new modes are added (Planner, which shipped before as a persona, counts as deleted here: no manifest).
      for (const mode of ['coordinator', 'qa-triager', 'release-manager']) expect(existsSync(join(modes, `${mode}.md`)), mode).toBe(true)
      const cfg = await wsMod.inWorkspace(w, () => w.projectConfig(w.assistantHome))
      expect(cfg.agents.find((a) => a.id === 'assistant')?.mode).toBe('coordinator')
      const m = JSON.parse(readFileSync(join(ws, '.combwork', 'bundled.json'), 'utf8'))
      expect(m.modes.overseer).toBeUndefined()
      // Again: nothing more to do (the edited one is the user's).
      await wsMod.inWorkspace(w, () => mod.syncBundled())
      expect(existsSync(join(modes, 'reviewer.md'))).toBe(true)
    } finally {
      await wsMod.disposeWorkspaceService(w)
    }
  })

  it('retires a skill shipped under a new name (HI-2463: use-hive-api is use-cw-api): a copy Combwork shipped goes, an edited one stays', async () => {
    const make = (ws: string, text: string) => {
      const dir = join(ws, '.combwork', 'skills', 'use-hive-api')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), text)
      return dir
    }
    // A version it shipped (its hash in the history, as each shipped version's is), and one the user edited since.
    make(join(base, 'renamed-skill'), OLD_USE_HIVE_API)
    const edited = make(join(base, 'renamed-skill-edited'), `${OLD_USE_HIVE_API}\nMy own notes.\n`)
    for (const [ws, kept] of [[join(base, 'renamed-skill'), false], [join(base, 'renamed-skill-edited'), true]] as const) {
      const w = await opened(ws)
      try {
        await wsMod.inWorkspace(w, () => mod.syncBundled())
        expect(existsSync(join(ws, '.combwork', 'skills', 'use-hive-api')), ws).toBe(kept)
        expect(readFileSync(join(ws, '.combwork', 'skills', 'use-cw-api', 'SKILL.md'), 'utf8')).toBe(readFileSync(join(RES, 'skills', 'use-cw-api', 'SKILL.md'), 'utf8'))
        const m = JSON.parse(readFileSync(join(ws, '.combwork', 'bundled.json'), 'utf8'))
        expect(m.skills['use-hive-api'], ws).toBeUndefined()
      } finally {
        await wsMod.disposeWorkspaceService(w)
      }
    }
    expect(readFileSync(join(edited, 'SKILL.md'), 'utf8')).toContain('My own notes.')
  })

  it('moves .combwork/personas from before 0.9.3 to .combwork/modes (#1084): edits kept, the copies still tracked, the chosen mode kept', async () => {
    const ws = join(base, 'personas')
    const legacy = join(ws, '.combwork', 'personas')
    const modes = join(ws, '.combwork', 'modes')
    mkdirSync(legacy, { recursive: true })
    // Hive 0.9.2's workspace: an untouched older Coordinator, an edited Planner, the user's own mode, QA triager deleted.
    writeFileSync(join(legacy, 'coordinator.md'), OLD_COORDINATOR)
    writeFileSync(join(legacy, 'planner.md'), '---\nname: Planner\n---\n\nMy own planning.\n')
    writeFileSync(join(legacy, 'my-own.md'), '---\nname: My own\n---\n\nMine.\n')
    const planner = await contentHash(join(RES, 'modes', 'planner.md'))
    writeFileSync(join(ws, '.combwork', 'bundled.json'), JSON.stringify({ skills: {}, personas: { coordinator: { from: oldCoordinator }, planner: { from: planner }, 'qa-triager': { from: null } } }))
    // Its Assistant chose the user's mode, in the agent's `persona` of then.
    mkdirSync(join(ws, '.combwork', 'assistant', '.combwork'), { recursive: true })
    writeFileSync(join(ws, '.combwork', 'assistant', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'assistant', name: 'Assistant', persona: 'my-own' }] }))
    // As Combwork opens it: the bundled copies are brought up to date before its folders are watched (ipc.ts).
    let before: { dir: string; mode: string | undefined } | null = null
    wsMod.WorkspaceService.onOpened = async () => {
      // Before the move (or while it can't be made), the modes are read where they are.
      before = { dir: wsMod.workspace.modesDir, mode: (await modesMod.readMode('my-own'))?.body }
      await mod.syncBundled()
    }
    const w = await opened(ws).finally(() => (wsMod.WorkspaceService.onOpened = null))
    try {
      expect(before).toEqual({ dir: legacy, mode: expect.stringContaining('Mine.') })
      expect(existsSync(legacy)).toBe(false)
      expect(w.modesDir).toBe(modes)
      expect(readFileSync(join(modes, 'coordinator.md'), 'utf8')).toBe(readFileSync(join(RES, 'modes', 'coordinator.md'), 'utf8'))
      expect(readFileSync(join(modes, 'planner.md'), 'utf8')).toContain('My own planning.')
      expect(readFileSync(join(modes, 'my-own.md'), 'utf8')).toContain('Mine.')
      expect(existsSync(join(modes, 'qa-triager.md'))).toBe(false)
      expect(existsSync(join(modes, 'release-manager.md'))).toBe(true)
      const m = JSON.parse(readFileSync(join(ws, '.combwork', 'bundled.json'), 'utf8'))
      expect(m.personas).toBeUndefined()
      expect(m.modes).toMatchObject({ coordinator: { from: await contentHash(join(RES, 'modes', 'coordinator.md')) }, planner: { from: planner }, 'qa-triager': { from: null } })
      const listed = Object.fromEntries((await wsMod.inWorkspace(w, () => modesMod.listModes())).map((p) => [p.id, p.bundled]))
      expect(listed).toMatchObject({ coordinator: 'same', planner: 'changed', 'qa-triager': 'missing' })
      expect(listed['my-own']).toBeUndefined()
      const cfg = await wsMod.inWorkspace(w, () => w.projectConfig(w.assistantHome))
      expect(cfg.agents.find((a) => a.id === 'assistant')).toMatchObject({ mode: 'my-own' })
      expect(cfg.agents.find((a) => a.id === 'assistant')).not.toHaveProperty('persona')

      // An older Hive opening it again makes .combwork/personas once more: it is left alone, and .combwork/modes is used.
      mkdirSync(legacy, { recursive: true })
      writeFileSync(join(legacy, 'coordinator.md'), OLD_COORDINATOR)
      await wsMod.inWorkspace(w, () => mod.syncBundled())
      expect(w.modesDir).toBe(modes)
      expect(readFileSync(join(legacy, 'coordinator.md'), 'utf8')).toBe(OLD_COORDINATOR)
      expect(readFileSync(join(modes, 'planner.md'), 'utf8')).toContain('My own planning.')
    } finally {
      await wsMod.disposeWorkspaceService(w)
    }
  })

  it('says an edited copy has an update when it was made from an older version', async () => {
    const ws = join(base, 'edited')
    mkdirSync(join(ws, '.combwork', 'skills', 'handover'), { recursive: true })
    writeFileSync(join(skillsDir(ws), 'handover', 'SKILL.md'), OLD_HANDOVER)
    const w = await opened(ws)
    try {
      // A copy made from the old version, which the user then edited: this Combwork's version can't go in over the edit.
      await wsMod.inWorkspace(w, () => mod.syncBundled())
      writeFileSync(join(skillsDir(ws), 'handover', 'SKILL.md'), OLD_HANDOVER + 'My addition.\n')
      const m = JSON.parse(readFileSync(join(ws, '.combwork', 'bundled.json'), 'utf8'))
      m.skills.handover.from = oldHash
      writeFileSync(join(ws, '.combwork', 'bundled.json'), JSON.stringify(m))
      await wsMod.inWorkspace(w, () => mod.syncBundled())
      const h = (await wsMod.inWorkspace(w, () => skills.combworkSkills(true))).find((s) => s.name === 'handover')!
      expect(h.bundled).toBe('changed')
      expect(h.updateAvailable).toBe(true)
      expect(readFileSync(join(skillsDir(ws), 'handover', 'SKILL.md'), 'utf8')).toContain('My addition.')
    } finally {
      await wsMod.disposeWorkspaceService(w)
    }
  })

  it("keeps an older copy the user linked files into, with its link, instead of updating it", async () => {
    const ws = join(base, 'linked')
    const target = join(base, 'linked-target')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'custom.md'), 'My own reference.')
    mkdirSync(join(skillsDir(ws), 'handover'), { recursive: true })
    writeFileSync(join(skillsDir(ws), 'handover', 'SKILL.md'), OLD_HANDOVER)
    symlinkSync(target, join(skillsDir(ws), 'handover', 'references'), 'junction')
    const w = await opened(ws)
    try {
      await wsMod.inWorkspace(w, () => mod.syncBundled())
      expect(readFileSync(join(skillsDir(ws), 'handover', 'SKILL.md'), 'utf8')).toBe(OLD_HANDOVER)
      expect(readFileSync(join(skillsDir(ws), 'handover', 'references', 'custom.md'), 'utf8')).toBe('My own reference.')
      expect((await wsMod.inWorkspace(w, () => skills.combworkSkills(true))).find((x) => x.name === 'handover')?.bundled).toBe('changed')
    } finally {
      await wsMod.disposeWorkspaceService(w)
    }
  })

  it('offers an update only from an older version: not to a copy from a newer or unknown Combwork', async () => {
    const ws = join(base, 'newer')
    mkdirSync(ws, { recursive: true })
    const w = await opened(ws)
    try {
      await wsMod.inWorkspace(w, () => mod.syncBundled({ fresh: true }))
      // Another Combwork (newer, sharing the workspace) gave its own versions, which this one doesn't know.
      writeFileSync(join(skillsDir(ws), 'handover', 'SKILL.md'), 'A newer handover.\n')
      writeFileSync(join(ws, '.combwork', 'modes', 'planner.md'), '---\nname: Planner\n---\nA newer planner.\n')
      const m = JSON.parse(readFileSync(join(ws, '.combwork', 'bundled.json'), 'utf8'))
      m.skills.handover.from = 'feedfacefeedface'
      m.modes.planner.from = 'feedfacefeedface'
      writeFileSync(join(ws, '.combwork', 'bundled.json'), JSON.stringify(m))
      await wsMod.inWorkspace(w, () => mod.syncBundled())
      expect(readFileSync(join(skillsDir(ws), 'handover', 'SKILL.md'), 'utf8')).toBe('A newer handover.\n')
      const h = (await wsMod.inWorkspace(w, () => skills.combworkSkills(true))).find((x) => x.name === 'handover')!
      expect([h.bundled, h.updateAvailable]).toEqual(['changed', undefined])
      const status = await wsMod.inWorkspace(w, () => mod.bundledStatus('modes', 'planner', join(ws, '.combwork', 'modes', 'planner.md')))
      expect(status).toEqual({ bundled: 'changed' })
      // From a version this Combwork knows to be older, an update is offered (modes too).
      m.modes.planner.from = (HISTORY as { modes: Record<string, string[]> }).modes.planner[0]
      writeFileSync(join(ws, '.combwork', 'bundled.json'), JSON.stringify(m))
      expect(await wsMod.inWorkspace(w, () => mod.bundledStatus('modes', 'planner', join(ws, '.combwork', 'modes', 'planner.md')))).toEqual({ bundled: 'changed', updateAvailable: true })
    } finally {
      await wsMod.disposeWorkspaceService(w)
    }
  })

  it('gives project agents and the Assistant the skills for them (metadata.audience), agents by default', async () => {
    const ws = join(base, 'fresh')
    mkdirSync(join(skillsDir(ws), 'my-own'), { recursive: true })
    writeFileSync(join(skillsDir(ws), 'my-own', 'SKILL.md'), '---\nname: my-own\ndescription: A user skill.\n---\n')
    const w = await opened(ws)
    try {
      const names = async (role: 'agent' | 'assistant') => (await wsMod.inWorkspace(w, () => skills.combworkSkills(false, role))).map((s) => s.name)
      const forAgents = await names('agent')
      const forAssistant = await names('assistant')
      expect(forAgents).toEqual(expect.arrayContaining(['my-own', 'work-on-card', 'review-agent-work', 'merge-ready', 'handover', 'split-work']))
      expect(forAgents).not.toContain('coordinate-agents')
      expect(forAssistant).toEqual(expect.arrayContaining(['coordinate-agents', 'split-work', 'handover', 'pick-up', 'workspace-note']))
      // use-cw-api is for both (HI-2012): its tools.md has the hive tools' cases.
      expect(forAgents).toContain('use-cw-api')
      expect(forAssistant).toContain('use-cw-api')
      for (const n of ['my-own', 'work-on-card', 'review-agent-work', 'merge-ready']) expect(forAssistant).not.toContain(n)
    } finally {
      await wsMod.disposeWorkspaceService(w)
    }
  })
})

describe("Codex's copies of a session's skills", () => {
  const base = tempDir('cw-codex-skills-')
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  const source = (name: string, text: string) => {
    const d = join(base, 'workspace-skills', name)
    mkdirSync(join(d, 'references'), { recursive: true })
    writeFileSync(join(d, 'SKILL.md'), text)
    writeFileSync(join(d, 'references', 'r.md'), `ref of ${name}`)
    return d
  }
  const sync = async (cwd: string, skills: { name: string; sourcePath: string }[]) => {
    const { syncAgentsSkills } = await import('../src/main/providers/common')
    return syncAgentsSkills({ cwd, skills } as unknown as import('../src/main/providers/types').LaunchContext, 'Codex')
  }

  it('tidies what a crash in a swap left before syncing, and the next launch has the new copy', async () => {
    const cwd = join(base, 'crash')
    const dir = join(cwd, '.agents', 'skills')
    const example = source('example', 'v2')
    // A crash after the old copy was renamed aside: its place is empty, the new copy half-made beside it.
    mkdirSync(join(dir, '.cw-example.cw-old-1-1', 'references'), { recursive: true })
    writeFileSync(join(dir, '.cw-example.cw-old-1-1', 'SKILL.md'), 'v1')
    writeFileSync(join(dir, '.cw-example.cw-old-1-1', '.combwork-copy'), JSON.stringify({ hash: 'old' }))
    mkdirSync(join(dir, '.cw-example.cw-new-1-1'), { recursive: true })
    // And one for a skill the session no longer gets: it comes back as Combwork's copy, then goes like any such copy (its
    // content still its marker's hash: unchanged since Combwork made it, #1431).
    mkdirSync(join(dir, '.cw-gone.cw-old-1-2'), { recursive: true })
    writeFileSync(join(dir, '.cw-gone.cw-old-1-2', '.combwork-copy'), JSON.stringify({ hash: await contentHash(join(dir, '.cw-gone.cw-old-1-2')) }))
    const out = await sync(cwd, [{ name: 'example', sourcePath: example }])
    expect(readdirSync(dir).sort()).toEqual(['cw-example'])
    expect(readFileSync(join(dir, 'cw-example', 'SKILL.md'), 'utf8')).toBe('v2')
    expect(readFileSync(join(dir, 'cw-example', 'references', 'r.md'), 'utf8')).toBe('ref of example')
    expect(out.example).toEqual({ revision: await contentHash(example) })
  })

  it("says when a skill isn't delivered: a folder of the user's has its name, or the old copy is in use", async () => {
    const cwd = join(base, 'deliver')
    const dir = join(cwd, '.agents', 'skills')
    const handover = source('handover', 'Combwork handover')
    const held = source('held', 'held v1')
    mkdirSync(join(dir, 'cw-handover'), { recursive: true })
    writeFileSync(join(dir, 'cw-handover', 'SKILL.md'), 'MY OWN')
    let out = await sync(cwd, [{ name: 'handover', sourcePath: handover }, { name: 'held', sourcePath: held }])
    expect(out.handover).toEqual({ revision: null, problem: expect.stringMatching(/folder of the user's/), lasting: true })
    expect(readFileSync(join(dir, 'cw-handover', 'SKILL.md'), 'utf8')).toBe('MY OWN')
    const v1 = await contentHash(join(dir, 'cw-held'))
    expect(out.held).toEqual({ revision: v1 })
    // The skill changes while a running session has a file of its copy open: that copy stays, and is reported as kept.
    writeFileSync(join(held, 'SKILL.md'), 'held v2')
    if (process.platform === 'win32') {
      const handle = await open(join(dir, 'cw-held', 'SKILL.md'), 'r')
      try {
        out = await sync(cwd, [{ name: 'held', sourcePath: held }])
      } finally {
        await handle.close()
      }
      expect(out.held).toEqual({ revision: v1, problem: expect.stringMatching(/old copy was in use/) })
      expect(readdirSync(dir).filter((f) => f.startsWith('.'))).toEqual([])
    }
    out = await sync(cwd, [{ name: 'held', sourcePath: held }])
    expect(out.held).toEqual({ revision: await contentHash(held) })
  })
})

describe('links in skills Combwork copies', () => {
  const base = tempDir('cw-skill-links-')
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  const target = join(base, 'my-references')
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'custom.md'), 'My own reference.')
  const sync = async (cwd: string, skills: { name: string; sourcePath: string }[]) => {
    const { syncAgentsSkills } = await import('../src/main/providers/common')
    return syncAgentsSkills({ cwd, skills } as unknown as import('../src/main/providers/types').LaunchContext, 'Codex')
  }

  it("copies a link as a link to the same place, so the copy is the same content as its source", async () => {
    const src = join(base, 'copy-src')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'SKILL.md'), 'skill')
    symlinkSync(target, join(src, 'references'), 'junction')
    const dest = join(base, 'copy-dest')
    await copySkillTree(src, dest)
    expect(lstatSync(join(dest, 'references')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(dest, 'references', 'custom.md'), 'utf8')).toBe('My own reference.')
    expect(await contentHash(dest)).toBe(await contentHash(src))
  })

  it('Codex: a link added to the workspace skill reaches the next launch, and then counts as delivered', async () => {
    const cwd = join(base, 'added')
    const src = join(base, 'added-src')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'SKILL.md'), 'skill')
    await sync(cwd, [{ name: 'example', sourcePath: src }])
    symlinkSync(target, join(src, 'references'), 'junction')
    const out = await sync(cwd, [{ name: 'example', sourcePath: src }])
    const copy = join(cwd, '.agents', 'skills', 'cw-example')
    expect(readFileSync(join(copy, 'references', 'custom.md'), 'utf8')).toBe('My own reference.')
    expect(out.example).toEqual({ revision: await contentHash(src) })
    // Nothing changed since: the copy stays as it is, still the one asked for (no restart asked for again and again).
    const again = await sync(cwd, [{ name: 'example', sourcePath: src }])
    expect(again.example).toEqual({ revision: await contentHash(src) })
  })

  it("Codex: a user's same-name folder with a linked reference is never taken for Combwork's, nor replaced later", async () => {
    const cwd = join(base, 'users')
    const src = join(base, 'users-src')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'SKILL.md'), 'skill')
    const theirs = join(cwd, '.agents', 'skills', 'cw-example')
    mkdirSync(theirs, { recursive: true })
    writeFileSync(join(theirs, 'SKILL.md'), 'skill')
    symlinkSync(target, join(theirs, 'references'), 'junction')
    let out = await sync(cwd, [{ name: 'example', sourcePath: src }])
    expect(out.example).toMatchObject({ revision: null, lasting: true })
    expect(existsSync(join(theirs, '.combwork-copy'))).toBe(false)
    writeFileSync(join(src, 'SKILL.md'), 'skill, changed')
    out = await sync(cwd, [{ name: 'example', sourcePath: src }])
    expect(out.example).toMatchObject({ revision: null, lasting: true })
    expect(readFileSync(join(theirs, 'SKILL.md'), 'utf8')).toBe('skill')
    expect(lstatSync(join(theirs, 'references')).isSymbolicLink()).toBe(true)
  })
})

describe('what a launch records', () => {
  it('reports the delivered revisions and problems, and needs a restart only for what a restart would deliver', async () => {
    const { launchRecord } = await import('../src/main/guidance')
    const r = launchRecord(
      { a: 'A2', mine: 'M1', held: 'H2', failed: 'F1' },
      { a: { revision: 'A2' }, mine: { revision: null, problem: "a folder of the user's", lasting: true }, held: { revision: 'H1', problem: 'old copy in use' }, failed: { revision: null, problem: 'could not be copied' } }
    )
    expect(r.skills).toEqual({ a: 'A2', held: 'H1' })
    expect(r.problems).toEqual({ mine: "a folder of the user's", held: 'old copy in use', failed: 'could not be copied' })
    // Compared with the workspace's (A2, M1, H2, F1): "mine" matches (a restart can't change it); held and failed don't.
    expect(r.settled).toEqual({ a: 'A2', mine: 'M1', held: 'H1', failed: '' })
    expect(launchRecord({ a: 'A2' }, { a: { revision: 'A2' } })).toEqual({ skills: { a: 'A2' }, settled: { a: 'A2' } })
  })
})
