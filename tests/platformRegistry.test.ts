// Each project's platform (SPEC §16.3, #1213): detected per case of §16.3.5's table, recorded in project.json when Hive
// makes it and never switched silently after (a different detection is offered and said once), the
// descriptor's capabilities in ProjectInfo, and the two git calls that bypassed `git()` now going through it.
import { execFileSync } from 'child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import type { HiveEvent, ProjectConfig } from '../src/shared/types'
import { PLATFORMS, revisionShort } from '../src/shared/platform/descriptors'
import { detect, projectPlatform } from '../src/main/platform/registry'
import { git, gitTestHooks } from '../src/main/git'
import { checkGit } from '../src/main/gitTool'
import { excludeCopies } from '../src/main/providers/common'
import { onHiveEvent } from '../src/main/events'
import { tempDir } from './tempDir'

const base = tempDir('hive-platform-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')

const run = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' })
const gitInit = (folder: string): void => void run(folder, 'init', '-q', '-b', 'main')

describe('detection, per case of §16.3.5', () => {
  it('a Git repository is Git, at its root', () => {
    const p = tempDir('hive-platform-git-')
    gitInit(p)
    expect(detect(p)).toEqual({ platform: 'git', root: p })
  })

  it('a folder with no version control is None', () => {
    expect(detect(tempDir('hive-platform-none-'))).toEqual({ platform: 'none' })
  })

  it('a subfolder of a larger repository is Git, showing the repository root', () => {
    const root = tempDir('hive-platform-sub-')
    gitInit(root)
    const p = join(root, 'project')
    mkdirSync(p)
    expect(detect(p)).toEqual({ platform: 'git', root, subfolder: true })
  })

  it('Mercurial and Jujutsu are None, naming what was found', () => {
    for (const [marker, name] of [['.hg', 'Mercurial'], ['.jj', 'Jujutsu']]) {
      const p = tempDir('hive-platform-other-')
      mkdirSync(join(p, marker))
      expect(detect(p)).toEqual({ platform: 'none', other: name })
    }
  })

  it('a colocated jj+git repository is Jujutsu, so None', () => {
    const p = tempDir('hive-platform-jjgit-')
    gitInit(p)
    mkdirSync(join(p, '.jj'))
    expect(detect(p)).toEqual({ platform: 'none', other: 'Jujutsu' })
  })
})

describe("a project's platform", () => {
  it('takes what detection finds until one is recorded, with its descriptor\'s capabilities', () => {
    const p = tempDir('hive-platform-first-')
    expect(projectPlatform(p, undefined)).toEqual({ id: 'none', capabilities: PLATFORMS.none.capabilities, detected: { platform: 'none' } })
    gitInit(p)
    expect(projectPlatform(p, undefined)).toEqual({ id: 'git', capabilities: PLATFORMS.git.capabilities, detected: { platform: 'git', root: p } })
  })

  it('keeps the recorded one when detection differs, and offers the switch', () => {
    const p = tempDir('hive-platform-kept-')
    gitInit(p)
    expect(projectPlatform(p, 'none')).toMatchObject({ id: 'none', capabilities: PLATFORMS.none.capabilities, offer: { offer: 'git', why: 'gitFound' } })
    renameSync(join(p, '.git'), join(p, 'moved.git'))
    expect(projectPlatform(p, 'git')).toMatchObject({ id: 'git', capabilities: PLATFORMS.git.capabilities, offer: { offer: 'none', why: 'repositoryGone' } })
    mkdirSync(join(p, '.hg'))
    expect(projectPlatform(p, 'git')).toMatchObject({ id: 'git', offer: { offer: 'none', why: 'otherFound' }, detected: { other: 'Mercurial' } })
    // None with another system found: nothing to offer (it is None either way).
    expect(projectPlatform(p, 'none').offer).toBeUndefined()
  })

  it('shows revisions through its descriptor', () => {
    expect(revisionShort('git', 'a3f2c1d9e8b7')).toBe('a3f2c1d')
    expect(revisionShort('none', '0123456789abcdef')).toBe('0123456')
  })
})

describe('in ProjectInfo', () => {
  let ws: string
  let w: ReturnType<typeof createWorkspaceService>
  const events: HiveEvent[] = []
  let off: () => void = () => undefined
  /** A project Hive sets up (its project.json made by ensureProject, as adding one does). */
  const project = async (name: string, before?: (p: string) => void): Promise<string> => {
    const p = join(ws, name)
    mkdirSync(p)
    before?.(p)
    await inWorkspace(w, () => w.ensureProject(p))
    return p
  }
  const recorded = (p: string): ProjectConfig['platform'] => (JSON.parse(readFileSync(join(p, '.hive', 'project.json'), 'utf8')) as ProjectConfig).platform
  const notices = (p: string) => events.flatMap((e) => (e.type === 'toast' && e.toast.source === p ? [e.toast] : []))
  const info = (p: string) => inWorkspace(w, () => w.projectInfo(p))

  beforeEach(async () => {
    ws = tempDir('hive-platform-ws-')
    events.length = 0
    off = onHiveEvent((e) => events.push(e))
    w = createWorkspaceService()
    await w.open(ws)
  })
  afterEach(() => {
    off()
    disposeWorkspaceService(w)
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
    expect(notices(p)[0]).toMatchObject({ level: 'info', title: 'Version control changed in alpha' })
    // Said once while it lasts.
    await info(p)
    expect(notices(p)).toHaveLength(1)
  })

  it('a Git project whose repository goes stays Git, and says so', async () => {
    const p = await project('beta', gitInit)
    expect(recorded(p)).toBe('git')
    expect((await info(p)).platform?.id).toBe('git')
    renameSync(join(p, '.git'), join(p, 'moved.git'))
    expect((await info(p)).platform).toMatchObject({ id: 'git', capabilities: PLATFORMS.git.capabilities, offer: { why: 'repositoryGone' } })
    expect(notices(p).map((t) => t.message)).toEqual(["beta's Git repository is gone. Hive goes on treating it as a Git project, so what needs Git can't be read until the repository is back."])
  })

  it('a project from before platforms (none recorded) follows detection, offering nothing, until the upgrade records one', async () => {
    const p = join(ws, 'gamma')
    mkdirSync(join(p, '.hive'), { recursive: true })
    writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
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
    const p = tempDir('hive-platform-exclude-')
    gitInit(p)
    await excludeCopies(p)
    expect(started).toContainEqual(['rev-parse', '--git-common-dir'])
    expect(readFileSync(join(p, '.git', 'info', 'exclude'), 'utf8')).toContain('/.agents/skills/hive-*/')
    // Outside a repository: nothing written, nothing thrown.
    await excludeCopies(tempDir('hive-platform-norepo-'))
    expect((await git(p, ['status', '--short'])).ok).toBe(true)
  })
})
