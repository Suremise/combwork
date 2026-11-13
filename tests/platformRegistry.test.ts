// Each project's platform (SPEC §16.3, #1213): detected per case of §16.3.5's table, recorded in project.json when Combwork
// makes it and never switched silently after (a different detection is offered and said once), the
// descriptor's capabilities in ProjectInfo, and the two git calls that bypassed `git()` now going through it.
import { execFileSync } from 'child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import type { CombworkEvent, ProjectConfig } from '../src/shared/types'
import { PLATFORMS, revisionShort } from '../src/shared/platform/descriptors'
import { detect, foundKey, projectPlatform } from '../src/main/platform/registry'
import { jjOf } from '../src/main/vcsDetect'
import { git, gitTestHooks } from '../src/main/git'
import { checkGit } from '../src/main/gitTool'
import { excludeCopies } from '../src/main/providers/common'
import { onCombworkEvent } from '../src/main/events'
import { tempDir } from './tempDir'
import { bound } from './keepType'

const base = tempDir('cw-platform-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')

const run = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' })
const gitInit = (folder: string): void => void run(folder, 'init', '-q', '-b', 'main')

// The longest a test waits for what it is waiting on: a bound for a hung run, never how long it should take.
const HUNG_MS = 10000

describe('detection, per case of §16.3.5', () => {
  it('a Git repository is Git, at its root', () => {
    const p = tempDir('cw-platform-git-')
    gitInit(p)
    expect(detect(p)).toEqual({ platform: 'git', root: p })
  })

  it('a folder with no version control is None', () => {
    expect(detect(tempDir('cw-platform-none-'))).toEqual({ platform: 'none' })
  })

  it('a subfolder of a larger repository is Git, showing the repository root', () => {
    const root = tempDir('cw-platform-sub-')
    gitInit(root)
    const p = join(root, 'project')
    mkdirSync(p)
    expect(detect(p)).toEqual({ platform: 'git', root, subfolder: true })
  })

  it('Mercurial is None, naming what was found; a .jj alone is jj without a colocated Git repository (HI-2799)', () => {
    const p = tempDir('cw-platform-other-')
    mkdirSync(join(p, '.hg'))
    expect(detect(p)).toEqual({ platform: 'none', other: 'Mercurial' })
    const j = tempDir('cw-platform-jj-')
    mkdirSync(join(j, '.jj'))
    expect(detect(j)).toEqual({ platform: 'jj', root: j, jj: { colocated: false } })
  })

  it('a colocated jj+git repository is jj (HI-2799), offered, never taken by itself', () => {
    const p = tempDir('cw-platform-jjgit-')
    gitInit(p)
    mkdirSync(join(p, '.jj'))
    expect(detect(p)).toEqual({ platform: 'jj', root: p, jj: { colocated: true } })
    // A project with nothing recorded takes None, not jj; a None or Git project is offered jj.
    expect(projectPlatform(p, undefined).id).toBe('none')
    expect(projectPlatform(p, undefined).offer).toBeUndefined()
    expect(projectPlatform(p, 'none').offer).toEqual({ offer: 'jj', why: 'jjFound' })
    expect(projectPlatform(p, 'git').offer).toEqual({ offer: 'jj', why: 'jjFound' })
    // A jj project whose .jj is gone is offered Git back, where Git is.
    const g = tempDir('cw-platform-jjgone-')
    gitInit(g)
    expect(projectPlatform(g, 'jj').offer).toEqual({ offer: 'git', why: 'jjGone' })
  })

  it('a non-colocated jj repository is offered jj too (HI-2896), and its found key is not the earlier jj:separate', () => {
    const j = tempDir('cw-platform-jjsep-')
    mkdirSync(join(j, '.jj'))
    expect(projectPlatform(j, 'none').offer).toEqual({ offer: 'jj', why: 'jjFound' })
    expect(foundKey(detect(j))).toBe('jj:noncolocated')
    // A user who chose None while jj couldn't be switched to there (jj:separate recorded) is offered jj once.
    expect(projectPlatform(j, 'none', 'jj:separate').offer).toEqual({ offer: 'jj', why: 'jjFound' })
    expect(projectPlatform(j, 'none', 'jj:noncolocated').offer).toBeUndefined()
  })

  it('a non-colocated jj repository inside a Git working tree is found there (inGit) and not offered (HI-2896)', () => {
    const top = tempDir('cw-platform-jjingit-')
    gitInit(top)
    const j = join(top, 'inner')
    mkdirSync(join(j, '.jj'), { recursive: true })
    expect(detect(j)).toEqual({ platform: 'jj', root: j, jj: { colocated: false, inGit: top } })
    expect(projectPlatform(j, 'none').offer).toBeUndefined()
    expect(projectPlatform(j, 'git').offer).toEqual({ offer: 'none', why: 'otherFound' })
    // Colocated inside another Git repository: its own .git is nearer, so not inGit.
    gitInit(j)
    expect(detect(j)).toEqual({ platform: 'jj', root: j, jj: { colocated: true } })
  })

  it('a Git repository inside a non-colocated jj workspace is Git’s, the nearest marker: no jj offer (HI-2976)', () => {
    const outer = tempDir('cw-platform-gitinjj-')
    mkdirSync(join(outer, '.jj'), { recursive: true })
    const inner = join(outer, 'inner')
    mkdirSync(join(inner, 'deep'), { recursive: true })
    gitInit(inner)
    expect(jjOf(inner)).toBeNull()
    expect(detect(inner)).toEqual({ platform: 'git', root: inner })
    expect(detect(join(inner, 'deep'))).toEqual({ platform: 'git', root: inner, subfolder: true })
    expect(projectPlatform(inner, 'git').offer).toBeUndefined()
    expect(projectPlatform(inner, 'none').offer).toEqual({ offer: 'git', why: 'gitFound' })
    // Outside the Git repository, still in the jj workspace: jj's.
    expect(detect(outer)).toEqual({ platform: 'jj', root: outer, jj: { colocated: false } })
    // Another system nearer than the .jj still decides as before (None, its name).
    mkdirSync(join(outer, 'hg', '.hg'), { recursive: true })
    expect(jjOf(join(outer, 'hg'))).toBeNull()
    expect(detect(join(outer, 'hg'))).toEqual({ platform: 'none', other: 'Mercurial' })
  })
})

describe("a project's platform", () => {
  it('takes what detection finds until one is recorded, with its descriptor\'s capabilities', () => {
    const p = tempDir('cw-platform-first-')
    expect(projectPlatform(p, undefined)).toEqual({ id: 'none', capabilities: PLATFORMS.none.capabilities, detected: { platform: 'none' } })
    gitInit(p)
    expect(projectPlatform(p, undefined)).toEqual({ id: 'git', capabilities: PLATFORMS.git.capabilities, detected: { platform: 'git', root: p } })
  })

  it('keeps the recorded one when detection differs, and offers the switch', () => {
    const p = tempDir('cw-platform-kept-')
    gitInit(p)
    expect(projectPlatform(p, 'none')).toMatchObject({ id: 'none', capabilities: PLATFORMS.none.capabilities, offer: { offer: 'git', why: 'gitFound' } })
    renameSync(join(p, '.git'), join(p, 'moved.git'))
    expect(projectPlatform(p, 'git')).toMatchObject({ id: 'git', capabilities: PLATFORMS.git.capabilities, offer: { offer: 'none', why: 'repositoryGone' } })
    mkdirSync(join(p, '.hg'))
    expect(projectPlatform(p, 'git')).toMatchObject({ id: 'git', offer: { offer: 'none', why: 'otherFound' }, detected: { other: 'Mercurial' } })
    // None with another system found: nothing to offer (it is None either way).
    expect(projectPlatform(p, 'none').offer).toBeUndefined()
  })

  it('a recorded value that is no platform uses detection, offers nothing, and says what it holds', () => {
    const p = tempDir('cw-platform-invalid-')
    gitInit(p)
    for (const [value, said] of [['mercurial', 'mercurial'], ['Git', 'Git'], ['toString', 'toString'], ['__proto__', '__proto__'], [42, '42'], [true, 'true'], [{ id: 'git' }, '{"id":"git"}'], [['git'], '["git"]']] as const) {
      expect(projectPlatform(p, value)).toEqual({ id: 'git', capabilities: PLATFORMS.git.capabilities, detected: { platform: 'git', root: p }, invalid: said })
    }
    // Absent or null: not recorded, nothing to say.
    expect(projectPlatform(p, null)).toEqual({ id: 'git', capabilities: PLATFORMS.git.capabilities, detected: { platform: 'git', root: p } })
    // A valid one still holds against detection.
    expect(projectPlatform(p, 'none')).toMatchObject({ id: 'none', offer: { offer: 'git', why: 'gitFound' } })
  })

  it('shows revisions through its descriptor', () => {
    expect(revisionShort('git', 'a3f2c1d9e8b7')).toBe('a3f2c1d')
    expect(revisionShort('none', '0123456789abcdef')).toBe('0123456')
  })
})

describe('in ProjectInfo', () => {
  let ws: string
  let w: ReturnType<typeof createWorkspaceService>
  const events: CombworkEvent[] = []
  let off: () => void = () => undefined
  /**
   * A project Combwork sets up (its project.json made by ensureProject, as adding one does): as the workspace opens with it,
   * then with the refresh the open scheduled run. A folder made in an open workspace is a root-watch event, whose refresh
   * reads the project (its `.git` too) while the test renames or reads it (#1375: EPERM renaming `.git`, its notice said
   * by that refresh): now only the test reads it.
   */
  const project = async (name: string, before?: (p: string) => void): Promise<string> => {
    const p = join(ws, name)
    mkdirSync(p)
    before?.(p)
    await w.open(ws)
    await w.refreshesSettled()
    return p
  }
  const recorded = (p: string): ProjectConfig['platform'] => (JSON.parse(readFileSync(join(p, '.combwork', 'project.json'), 'utf8')) as ProjectConfig).platform
  const notices = (p: string) => events.flatMap((e) => (e.type === 'toast' && e.toast.source === p ? [e.toast] : []))
  const info = (p: string) => inWorkspace(w, () => w.projectInfo(p))

  beforeEach(async () => {
    ws = tempDir('cw-platform-ws-')
    events.length = 0
    off = onCombworkEvent((e) => events.push(e))
    w = createWorkspaceService()
    await w.open(ws)
  })
  afterEach(async () => {
    off()
    await disposeWorkspaceService(w)
  })

  it('records the platform found as the project is set up, then keeps it: git init is offered and said once, not switched to', async () => {
    const p = await project('alpha')
    expect(recorded(p)).toBe('none')
    expect((await info(p)).platform).toMatchObject({ id: 'none', capabilities: PLATFORMS.none.capabilities })
    expect(notices(p)).toEqual([])

    gitInit(p)
    const after = (await info(p)).platform
    expect(after).toMatchObject({ id: 'none', detected: { platform: 'git' }, offer: { offer: 'git', why: 'gitFound' } })
    expect(recorded(p)).toBe('none')
    expect(notices(p)).toHaveLength(1)
    // With Open Version Control, the tab that offers the switch (#1419).
    expect(notices(p)[0]).toMatchObject({ level: 'info', title: 'Version control changed in alpha', actions: [{ label: 'Open Version Control', command: 'project.openVersionControl', args: [p] }] })
    // Said once while it lasts.
    await info(p)
    expect(notices(p)).toHaveLength(1)
  })

  it('the notice goes once the platform and the folder agree again (HI-1905: switched to Git after git init)', async () => {
    const p = await project('epsilon')
    gitInit(p)
    await info(p)
    expect(notices(p)).toHaveLength(1)
    // HI-2320: its entry is resolved (it says so, its button goes), not taken away.
    const notice = notices(p)[0] as { id: string }
    const gone = () => events.flatMap((e) => (e.type === 'toast-resolved' ? e.ids : []))
    expect(gone()).toEqual([])
    await inWorkspace(w, () => w.mutateProjectConfig(p, (c) => ({ ...c, platform: 'git' })))
    await info(p)
    expect(gone()).toEqual([notice.id])
    expect(notice.id).toBe(`platform:${p.toLowerCase()}`)
    // Said once: read again, nothing more.
    await info(p)
    expect(gone()).toHaveLength(1)
  })

  it('a Git project whose repository goes stays Git, and says so', async () => {
    const p = await project('beta', gitInit)
    expect(recorded(p)).toBe('git')
    expect((await info(p)).platform?.id).toBe('git')
    renameSync(join(p, '.git'), join(p, 'moved.git'))
    expect((await info(p)).platform).toMatchObject({ id: 'git', capabilities: PLATFORMS.git.capabilities, offer: { why: 'repositoryGone' } })
    expect(notices(p).map((t) => t.message)).toEqual(["beta's Git repository is gone. Git's rules hold, so its cards can't move on until the repository is back or you switch the project to None in its Version Control tab."])
  })

  it("one notice per project: a newer detection replaces the earlier one, in Combwork's language (#1419)", async () => {
    const p = await project('gamma', gitInit)
    renameSync(join(p, '.git'), join(p, 'moved.git'))
    await info(p)
    mkdirSync(join(p, '.hg'))
    const { setLanguage } = await import('../src/shared/i18n')
    const { loadCatalogue } = await import('../src/shared/i18n/catalogues')
    setLanguage('de', await loadCatalogue('de'), 'de')
    try {
      await info(p)
    } finally {
      setLanguage('en', {})
    }
    const said = notices(p)
    expect(said).toHaveLength(2)
    // The same id: the window shows the newer in the older's place, never both.
    expect(new Set(said.map((t) => t.id))).toEqual(new Set([`platform:${p.toLowerCase()}`]))
    expect(said[1].title).not.toBe(said[0].title)
    expect(said[1].actions?.[0].label).not.toBe('Open Version Control')
  })

  it('a project.json naming no platform stays readable, with a warning said once', async () => {
    const p = join(ws, 'delta')
    mkdirSync(join(p, '.combwork'), { recursive: true })
    for (const value of ['mercurial', 7]) {
      writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [], platform: value }))
      expect((await info(p)).platform).toEqual({ id: 'none', capabilities: PLATFORMS.none.capabilities, detected: { platform: 'none' }, invalid: String(value) })
      await info(p)
    }
    expect(notices(p).map((t) => t.title)).toEqual(['Unknown version control setting in delta', 'Unknown version control setting in delta'])
    expect(notices(p).map((t) => [t.level, t.message])).toEqual([
      ['warning', `delta's project.json names a version control Combwork doesn't know (platform: mercurial). Until it says "git" or "none", Combwork uses what it finds in the folder.`],
      ['warning', `delta's project.json names a version control Combwork doesn't know (platform: 7). Until it says "git" or "none", Combwork uses what it finds in the folder.`]
    ])
  })

  it("a read of a workspace closed or switched meanwhile says nothing in the next one, which says its own afresh", async () => {
    const p = await project('epsilon', gitInit)
    renameSync(join(p, '.git'), join(p, 'moved.git'))
    // The old workspace's read of epsilon holds once it has read its config, while the window opens another workspace.
    const real = bound(w, w.projectConfig)
    let release: () => void = () => undefined
    const released = new Promise<void>((r) => (release = r))
    let held = false
    const spy = vi.spyOn(w, 'projectConfig').mockImplementation(async (path: string) => {
      const cfg = await real(path)
      if (path === p && !held) {
        held = true
        await released
      }
      return cfg
    })
    try {
      const old = info(p)
      await vi.waitFor(() => expect(held).toBe(true), { timeout: HUNG_MS })
      const next = tempDir('cw-platform-ws2-')
      await w.open(next)
      release()
      expect((await old).platform?.offer?.why).toBe('repositoryGone')
    } finally {
      release()
      spy.mockRestore()
    }
    expect(notices(p)).toEqual([])
    // Back in the first workspace: said there, as its own.
    await w.open(ws)
    await vi.waitFor(() => expect(notices(p)).toHaveLength(1), { timeout: HUNG_MS })
  })

  it('a project from before platforms (none recorded) follows detection, offering nothing, until the upgrade records one', async () => {
    const p = join(ws, 'gamma')
    mkdirSync(join(p, '.combwork'), { recursive: true })
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    expect((await info(p)).platform).toEqual({ id: 'none', capabilities: PLATFORMS.none.capabilities, detected: { platform: 'none' } })
    gitInit(p)
    expect((await info(p)).platform).toMatchObject({ id: 'git', detected: { platform: 'git' } })
    expect((await info(p)).platform?.offer).toBeUndefined()
    expect(recorded(p)).toBeUndefined()
    expect(notices(p)).toEqual([])
  })
})

describe('every git call goes through git()', () => {
  const started: string[][] = []
  beforeEach(() => {
    started.length = 0
    gitTestHooks.started = (_cwd, args) => void started.push([...args])
  })
  afterEach(() => {
    delete gitTestHooks.started
  })

  it("checkGit's git --version", async () => {
    expect((await checkGit()).state).toBe('ok')
    expect(started).toContainEqual(['--version'])
  })

  it("excludeCopies' rev-parse --git-common-dir", async () => {
    const p = tempDir('cw-platform-exclude-')
    gitInit(p)
    await excludeCopies(p)
    expect(started).toContainEqual(['rev-parse', '--git-common-dir'])
    expect(readFileSync(join(p, '.git', 'info', 'exclude'), 'utf8')).toContain('/.agents/skills/cw-*/')
    // Outside a repository: nothing written, nothing thrown.
    await excludeCopies(tempDir('cw-platform-norepo-'))
    expect((await git(p, ['status', '--short'])).ok).toBe(true)
  })
})
