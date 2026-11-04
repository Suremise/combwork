// A workspace's own settings through the catalog and the settings tools: since HI-1766 its card loops' rounds and wait
// are its workflow defaults (Settings → Workspace's workflow defaults, None and Git), kept in its workspace.json, and a
// project's own are its workflow options; an old `loops` moves into the defaults as the workspace is read.
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { settingDefault, settingEntry, settingPatch, settingPath, settingValue } from '../src/shared/settingsCatalog'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
import { tempDir } from './tempDir'

describe("a workspace's card loops, as its workflow defaults (#412, HI-1766)", async () => {
  const base = tempDir('hive-settings-ws-')
  ;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
  const { createWorkspaceService: createService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
  const workspaces = new Set<ReturnType<typeof createService>>()
  const createWorkspaceService = () => {
    const w = createService()
    workspaces.add(w)
    return w
  }
  // An assertion can fail before a test's explicit close (HI-2495). Await every service's close before tempDir's
  // retrying cleanup removes the folders, including watchers, background refreshes and bundled-item writes.
  afterEach(async () => {
    for (const w of workspaces) await disposeWorkspaceService(w)
    workspaces.clear()
  })
  const { applySetting, entryOf, settingDetail, settingRows } = await import('../src/main/settingsTools')

  it('the catalog: a level default for each platform that inherits, and a project option that inherits; the old rows are gone', () => {
    const rounds = settingEntry('workspace.workflow.none.loopRounds')!
    const wait = settingEntry('workspace.workflow.git.loopWaitHours')!
    expect([rounds.type, wait.type, rounds.max, wait.max]).toEqual(['number', 'number', 50, 24])
    expect([settingDefault(rounds), settingDefault(wait)]).toEqual(['inherit', 'inherit'])
    expect(settingValue(rounds, DEFAULT_SETTINGS, null, { workflow: { none: { loopRounds: 4 } } })).toBe(4)
    expect(settingPatch(wait, 3)).toEqual({ workflowLevel: { level: 'workspace', platform: 'git', key: 'loopWaitHours', value: 3 } })
    const own = settingEntry('project.workflow.loopRounds')!
    expect(own.inherits).toBe(true)
    for (const gone of ['workspace.loopRounds', 'workspace.loopWaitHours', 'project.loopRounds', 'project.loopWakes', 'project.loopStepWaitMinutes', 'project.fileLocks', 'agents.fileLocks', 'project.workflow']) expect(settingEntry(gone)).toBeUndefined()
    // The hidden workflow rows are the project's Version Control tab's, not a section of Project Settings.
    expect(settingPath(own)).toBe('Version Control → Workflow → Rounds')
    // The levels' rows are Settings → Version Control's two parts (HI-1768), their ids as before.
    expect(settingPath(rounds)).toBe('Settings → Version Control → Workspace defaults → Rounds')
    expect(settingPath(settingEntry('workflow.git.loopRounds')!)).toBe('Settings → Version Control → Combwork defaults → Rounds')
    expect(settingPath(settingEntry('workflow.git.slotCopy')!)).toBe('Settings → Version Control → Combwork defaults → Files copied into new slots')
    expect(settingPath(settingEntry('workspace.workflow.git.slotCopy')!)).toBe('Settings → Version Control → Workspace defaults → Files copied into new slots')
    expect([settingEntry('workflow.workspaceDefaults')?.section, settingEntry('workspace.workflowDefaults')]).toEqual(['workflow', undefined])
  })

  it('the settings tools read and change the open workspace’s, saved in its workspace.json; an old loops is moved in, an override of the new kind kept', async () => {
    const path = join(base, 'ws')
    mkdirSync(join(path, 'alpha', '.hive'), { recursive: true })
    mkdirSync(join(path, '.hive'), { recursive: true })
    writeFileSync(join(path, 'alpha', '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    // Saved by a build from before HI-1766: Card loop rounds 4 and wait 2, and Git's wait already set the new way.
    writeFileSync(join(path, '.hive', 'workspace.json'), JSON.stringify({ loops: { rounds: 4, waitHours: 2 }, workflow: { git: { loopWaitHours: 5 } } }))
    const w = createWorkspaceService()
    await w.open(path)
    expect(w.config.workflow).toEqual({ none: { loopRounds: 4, loopWaitHours: 2 }, git: { loopRounds: 4, loopWaitHours: 5 } })
    expect('loops' in w.config).toBe(false)
    await inWorkspace(w, async () => {
      // A plain listing folds the level defaults into one line; a query lists them.
      expect(settingRows({ query: 'card loop rounds' }).find((r) => r.id === 'workspace.workflow.none.loopRounds')).toMatchObject({ value: '4' })
      // A row's gist (#1312): the first sentence, cut at a word within 60 characters.
      for (const r of settingRows({ query: 'compact' })) expect(r.desc.length <= 60 && !/[\s,;:]…$/.test(r.desc)).toBe(true)
      expect(settingRows({ query: 'compact' }).find((r) => r.id === 'sessions.transcriptWarnMB')?.desc).toBe("Size, in MB, at which a running conversation's transcript…")
      const changed = await applySetting(entryOf('workspace.workflow.none.loopRounds'), 7, null)
      expect([changed.old, changed.new]).toEqual([4, 7])
      await applySetting(entryOf('workspace.workflow.none.loopWaitHours'), '3', null)
      // Its user guide heading by its id (#1535), given as the heading's text.
      expect(settingDetail(entryOf('workspace.workflow.none.loopWaitHours'), null)).toMatchObject({ value: '3', default: 'inherit', docs: 'Combwork and workspace defaults' })
      await expect(applySetting(entryOf('workspace.workflow.none.loopRounds'), 99, null)).rejects.toThrow(/1 to 50/)
      const inherit = await applySetting(entryOf('workspace.workflow.git.loopWaitHours'), null, null)
      expect([inherit.old, inherit.new]).toEqual([5, 'inherit'])
    })
    const saved = JSON.parse(readFileSync(join(path, '.hive', 'workspace.json'), 'utf8'))
    expect(saved.workflow).toEqual({ none: { loopRounds: 7, loopWaitHours: 3 }, git: { loopRounds: 4 } })
    expect('loops' in saved).toBe(false)
    await disposeWorkspaceService(w)
    // Read again: nothing moves twice, and nothing comes back.
    const again = createWorkspaceService()
    await again.open(path)
    expect(again.config.workflow).toEqual(saved.workflow)
    await disposeWorkspaceService(again)
  })

  it("a project with no workflow options yet and its card loops from before HI-1766: the settings tool and the form read them as its own, and Inherit from either keeps them inherited after reading again (HR5's round 1)", async () => {
    const { setWorkflowOptions, workflowForm } = await import('../src/main/workflow/optionsForm')
    const path = join(base, 'ws-legacy')
    const old = { version: 2, platform: 'none', agents: [], loopRounds: 4, loopWakes: false, fileLocks: 'warn' }
    const file = (p: string) => join(path, p, '.hive', 'project.json')
    for (const p of ['tool', 'form']) {
      mkdirSync(join(path, p, '.hive'), { recursive: true })
      writeFileSync(file(p), JSON.stringify(old))
    }
    const w = createWorkspaceService()
    await w.open(path)
    const legacyKeys = (p: string) => ['loopRounds', 'loopWakes', 'fileLocks', 'loopWaitHours', 'loopStepWaitMinutes'].filter((k) => k in JSON.parse(readFileSync(file(p), 'utf8')))
    await inWorkspace(w, async () => {
      // The settings tool: it reads the old value the runtime uses, its change says so, and Inherit sticks.
      const rounds = entryOf('project.workflow.loopRounds')
      const tool = { name: 'tool', config: await w.projectConfig(join(path, 'tool')) }
      expect(settingDetail(rounds, tool)).toMatchObject({ value: '4' })
      const r = await applySetting(rounds, null, join(path, 'tool'))
      expect([r.old, r.new]).toEqual([4, 'inherit'])
      expect(legacyKeys('tool')).toEqual([])
      expect(JSON.parse(readFileSync(file('tool'), 'utf8')).workflow.options).toEqual({ loopWakes: false, fileLocks: 'warn' })
      // The form: its own options are the old ones; saved without the rounds, they stay inherited.
      const form = await workflowForm(w, join(path, 'form'))
      expect(form.own).toEqual({ loopRounds: 4, loopWakes: false, fileLocks: 'warn' })
      const { loopRounds: _r, ...rest } = form.own
      await setWorkflowOptions(w, join(path, 'form'), { preset: null, options: rest, base: { preset: form.preset, options: form.own } }, { applyTo: [] })
      expect(legacyKeys('form')).toEqual([])
      expect(JSON.parse(readFileSync(file('form'), 'utf8')).workflow.options).toEqual({ loopWakes: false, fileLocks: 'warn' })
    })
    await disposeWorkspaceService(w)
    // Read again: nothing moves back.
    const again = createWorkspaceService()
    await again.open(path)
    for (const p of ['tool', 'form']) {
      const cfg = await again.projectConfig(join(path, p))
      expect(cfg.workflow?.options, p).toEqual({ loopWakes: false, fileLocks: 'warn' })
      expect('loopRounds' in cfg, p).toBe(false)
    }
    await disposeWorkspaceService(again)
  })

  it('advanced settings (#367): set in advanced.json or the workspace’s own, listed only when changed or asked for', async () => {
    const { advanced, updateSettingsChecked } = await import('../src/main/advanced')
    const profile = join(base, 'profile-advanced')
    mkdirSync(profile, { recursive: true })
    advanced.load(profile)
    const path = join(base, 'ws-advanced')
    mkdirSync(join(path, 'alpha', '.hive'), { recursive: true })
    writeFileSync(join(path, 'alpha', '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    const w = createWorkspaceService()
    await w.open(path)
    try {
      await inWorkspace(w, async () => {
        // A plain listing: the advanced ones at their defaults are one line.
        const plain = settingRows({})
        expect(plain.filter((r) => r.id.startsWith('advanced.') && r.id !== 'advanced.showDeveloperFeatures')).toEqual([expect.objectContaining({ id: 'advanced.*', value: expect.stringMatching(/^\d+ more$/), title: 'query "advanced" lists them' })])
        // Every trust-related advanced setting: each CLI's trust prompt, Claude Code's accounts field (HI-1870), Codex's per-launch trust (HI-1871), Codex's hook listing (HI-982: Hive trusts its hooks by its own hashes without it).
        expect(settingRows({ query: 'advanced trust' }).map((r) => r.id)).toEqual(['advanced.claude-code.trust.prompt', 'advanced.claude-code.accounts.trustField', 'advanced.codex.trust.perLaunch', 'advanced.codex.trust.prompt', 'advanced.codex.hooks.listMethod', 'advanced.copilot.trust.prompt'])
        const changed = await applySetting(entryOf('advanced.hive.mcp.replySeconds'), 600, null)
        expect([changed.old, changed.new]).toEqual([300, 600])
        expect(JSON.parse(readFileSync(join(profile, 'advanced.json'), 'utf8')).values).toEqual({ 'hive.mcp.replySeconds': 600 })
        expect(settingRows({}).find((r) => r.id === 'advanced.hive.mcp.replySeconds')).toMatchObject({ value: '600 s', default: '300 s' })
        await expect(applySetting(entryOf('advanced.hive.mcp.replySeconds'), 5, null)).rejects.toThrow(/30 to 3600/)
        const own = await applySetting(entryOf('workspace.advanced.hive.progress.lanesShown'), 6, null)
        expect([own.old, own.new]).toEqual([null, 6])
        expect(settingDetail(entryOf('workspace.advanced.hive.progress.lanesShown'), null)).toMatchObject({ value: '6 lanes', default: 'inherit' })
        await applySetting(entryOf('advanced.hive.mcp.replySeconds'), null, null)
        expect(JSON.parse(readFileSync(join(profile, 'advanced.json'), 'utf8')).values).toEqual({})
        // The developer setting (its own catalogue entry) is kept in advanced.json too: an unreadable file refuses it, nothing changed.
        const { config } = await import('../src/main/config')
        writeFileSync(join(profile, 'advanced.json'), '{')
        await vi.waitFor(() => expect(advanced.state(null).fileError).toBeTruthy(), { timeout: 10_000 })
        await expect(applySetting(entryOf('advanced.showDeveloperFeatures'), true, null)).rejects.toThrow('Fix advanced.json')
        expect(config.settings.advanced.showDeveloperFeatures).toBe(false)
        writeFileSync(join(profile, 'advanced.json'), '{}')
        await vi.waitFor(() => expect(advanced.state(null).fileError).toBeNull(), { timeout: 10_000 })
        await applySetting(entryOf('advanced.showDeveloperFeatures'), true, null)
        expect(JSON.parse(readFileSync(join(profile, 'advanced.json'), 'utf8')).values).toEqual({ 'hive.showDeveloperFeatures': true })
        expect(config.settings.advanced.showDeveloperFeatures).toBe(true)
        await applySetting(entryOf('advanced.showDeveloperFeatures'), false, null)
        // A revert queued behind a newer change of the user's (#367 round 4): its guard sees the value it would replace,
        // in its own turn, so it is refused and the user's change stays. advanced.json's lock held, nothing timed.
        const { withFileLock } = await import('../src/main/fsutil')
        const reply = entryOf('advanced.hive.mcp.replySeconds')
        await applySetting(reply, 600, null)
        let open!: () => void
        const gate = new Promise<void>((r) => (open = r))
        let held!: () => void
        const holding = new Promise<void>((r) => (held = r))
        const lock = withFileLock(join(profile, 'advanced.json'), async () => {
          held()
          await gate
        })
        await holding
        const users = advanced.set('hive.mcp.replySeconds', 700)
        const revert = applySetting(reply, 300, null, (current) => {
          if (current !== 600) throw new Error(`It has changed since (it is ${String(current)} now).`)
        })
        open()
        await lock
        await users
        await expect(revert).rejects.toThrow('It has changed since (it is 700 now).')
        expect(JSON.parse(readFileSync(join(profile, 'advanced.json'), 'utf8')).values['hive.mcp.replySeconds']).toBe(700)
        // Changes queued together each report the value they replaced and the one they left.
        const [a, b] = await Promise.all([applySetting(reply, 800, null), applySetting(reply, 900, null)])
        expect([a.old, a.new, b.old, b.new]).toEqual([700, 800, 800, 900])
        // The developer setting's path too: queued behind a user's change, its guard sees that change.
        let open2!: () => void
        const gate2 = new Promise<void>((r) => (open2 = r))
        let held2!: () => void
        const holding2 = new Promise<void>((r) => (held2 = r))
        const lock2 = withFileLock(join(profile, 'advanced.json'), async () => {
          held2()
          await gate2
        })
        await holding2
        // The user turns it on in Settings (settings:update), queued behind the lock too.
        const usersDev = updateSettingsChecked({ advanced: { showDeveloperFeatures: true } }, (p) => config.updateSettings(p))
        const revertDev = applySetting(entryOf('advanced.showDeveloperFeatures'), true, null, (current) => {
          if (current !== false) throw new Error(`It has changed since (it is ${String(current)} now).`)
        })
        open2()
        await lock2
        await usersDev
        await expect(revertDev).rejects.toThrow('It has changed since (it is true now).')
        await applySetting(entryOf('advanced.showDeveloperFeatures'), false, null)
        await applySetting(reply, null, null)
      })
      expect(JSON.parse(readFileSync(join(path, '.hive', 'workspace.json'), 'utf8')).advanced).toEqual({ 'hive.progress.lanesShown': 6 })
    } finally {
      advanced.stop()
      await disposeWorkspaceService(w)
    }
  })
})
