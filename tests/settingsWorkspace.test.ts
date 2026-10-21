// A workspace's own settings through the catalog and the settings tools (#412): Settings → Workspace → Card loop rounds
// and wait, kept in its workspace.json, and Project Settings → Card loops overriding them (null inherits).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { settingDefault, settingEntry, settingPatch, settingValue } from '../src/shared/settingsCatalog'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
import { tempDir } from './tempDir'

describe('Settings → Workspace → Card loops (#412)', async () => {
  const base = tempDir('hive-settings-ws-')
  ;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
  const { applySetting, entryOf, settingDetail, settingRows } = await import('../src/main/settingsTools')

  it('the catalog: workspace values (10 and 6 by default) and project overrides that inherit', () => {
    const rounds = settingEntry('workspace.loopRounds')!
    const wait = settingEntry('workspace.loopWaitHours')!
    expect([rounds.scope, wait.scope]).toEqual(['workspace', 'workspace'])
    expect([settingDefault(rounds), settingDefault(wait)]).toEqual([10, 6])
    expect(settingValue(rounds, DEFAULT_SETTINGS, null, { loops: { rounds: 4 } })).toBe(4)
    expect(settingValue(wait, DEFAULT_SETTINGS, null, null)).toBe(6)
    expect(settingPatch(wait, 3)).toEqual({ workspace: { waitHours: 3 } })
    const own = settingEntry('project.loopRounds')!
    expect(own.inherits).toBe(true)
    expect(settingDefault(own)).toBeNull()
  })

  it('the settings tools read and change the open workspace’s, saved in its workspace.json', async () => {
    const path = join(base, 'ws')
    mkdirSync(join(path, 'alpha', '.hive'), { recursive: true })
    writeFileSync(join(path, 'alpha', '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    const w = createWorkspaceService()
    await w.open(path)
    await inWorkspace(w, async () => {
      expect(settingRows({ query: 'card loop' }).find((r) => r.id === 'workspace.loopRounds')).toMatchObject({ value: '10' })
      // A row's gist (#1312): the first sentence, cut at a word within 60 characters.
      for (const r of settingRows({ query: 'compact' })) expect(r.desc.length <= 60 && !/[\s,;:]…$/.test(r.desc)).toBe(true)
      expect(settingRows({ query: 'compact' }).find((r) => r.id === 'sessions.transcriptWarnMB')?.desc).toBe("Size, in MB, at which a running conversation's transcript…")
      const changed = await applySetting(entryOf('workspace.loopRounds'), 7, null)
      expect([changed.old, changed.new]).toEqual([10, 7])
      await applySetting(entryOf('workspace.loopWaitHours'), '3', null)
      expect(settingDetail(entryOf('workspace.loopWaitHours'), null)).toMatchObject({ value: '3', default: '6' })
      expect(settingRows({ query: 'card loop' }).find((r) => r.id === 'workspace.loopRounds')).toMatchObject({ value: '7', default: '10' })
      await expect(applySetting(entryOf('workspace.loopRounds'), 99, null)).rejects.toThrow(/1 to 50/)
    })
    expect(JSON.parse(readFileSync(join(path, '.hive', 'workspace.json'), 'utf8')).loops).toEqual({ rounds: 7, waitHours: 3 })
    await disposeWorkspaceService(w)
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
        expect(settingRows({ query: 'advanced trust' }).map((r) => r.id)).toEqual(['advanced.claude-code.trust.prompt', 'advanced.codex.trust.prompt', 'advanced.copilot.trust.prompt'])
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
