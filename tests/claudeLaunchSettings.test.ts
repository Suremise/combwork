// A --settings in a Claude Code agent's own arguments (#330): Claude Code reads only the last --settings, so Combwork merges
// the user's settings into its launch file (their hooks added to Combwork's, Combwork's status line kept) and passes that alone.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { mergeLaunchSettings, userSettings, withoutSettingsArgs } from '../src/main/providers/claude/launchSettings'
import { tempDir } from './tempDir'

const base = tempDir('hive-launch-settings-')
afterAll(() => rmSync(base, { recursive: true, force: true }))

const hive = () => ({
  hooks: { Stop: [{ hooks: [{ type: 'http', url: 'hive-stop' }] }], SessionStart: [{ hooks: [{ type: 'command', command: 'hive-start' }] }] },
  statusLine: { type: 'command', command: 'hive-status', padding: 0 }
})
const NEEDS = { url: 'http://127.0.0.1:9/hook?run=r', envVar: 'CW_HOOK_TOKEN' }

describe("a --settings in a Claude Code agent's arguments (#330)", () => {
  it('drops every --settings from the arguments, in both forms, and nothing else', () => {
    expect(withoutSettingsArgs(['--verbose', '--settings', 'a.json', '--settings={"x":1}', '--add-dir', 'd'])).toEqual(['--verbose', '--add-dir', 'd'])
    // A --settings without a value never gets this far: userSettings refuses it first (#361).
    expect(withoutSettingsArgs(['--verbose', '--settings'])).toEqual(['--verbose'])
    expect(withoutSettingsArgs([])).toEqual([])
  })

  it("reads the last one, as Claude Code does: a file relative to the session's folder, an absolute one, or inline JSON", async () => {
    writeFileSync(join(base, 'first.json'), JSON.stringify({ env: { A: '1' } }))
    writeFileSync(join(base, 'mine.json'), '\uFEFF' + JSON.stringify({ env: { B: '2' }, autoCompactWindow: 250000 }))
    expect(await userSettings([], base)).toBeNull()
    expect(await userSettings(['--settings', 'first.json', '--settings', 'mine.json'], base)).toEqual({ env: { B: '2' }, autoCompactWindow: 250000 })
    expect(await userSettings([`--settings=${join(base, 'first.json')}`], 'C:\\elsewhere')).toEqual({ env: { A: '1' } })
    expect(await userSettings(['--settings', '{"model":"opus"}'], base)).toEqual({ model: 'opus' })
  })

  it("refuses at launch, saying which argument, what Claude Code would refuse or Combwork can't merge", async () => {
    writeFileSync(join(base, 'bad.json'), '{bad')
    writeFileSync(join(base, 'list.json'), '[1]')
    await expect(userSettings(['--settings', 'missing.json'], base)).rejects.toThrow("The settings file missing.json (--settings in Extra arguments) can't be read: there is no such file.")
    await expect(userSettings(['--settings', 'bad.json'], base)).rejects.toThrow("isn't valid JSON")
    await expect(userSettings(['--settings', 'list.json'], base)).rejects.toThrow("isn't a settings object")
    // Over Claude Code's 2 MiB limit, or not a regular file: refused, as Claude Code 2.1.292 refuses them (#333).
    writeFileSync(join(base, 'big.json'), JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) }))
    await expect(userSettings(['--settings', 'big.json'], base)).rejects.toThrow("The settings file big.json (--settings in Extra arguments) can't be read: it's over Claude Code's 2 MiB limit for settings files.")
    mkdirSync(join(base, 'folder.json'), { recursive: true })
    await expect(userSettings(['--settings', 'folder.json'], base)).rejects.toThrow("can't be read: it isn't a file.")
    await expect(userSettings(['--settings', 'CON'], base)).rejects.toThrow("can't be read")
    // Not JSON: Claude Code reads it as a file's name.
    await expect(userSettings(['--settings', '{bad'], base)).rejects.toThrow("The settings file {bad (--settings in Extra arguments) can't be read")
  })

  it('refuses a --settings given no value rather than dropping it (#361)', async () => {
    writeFileSync(join(base, 'ok.json'), JSON.stringify({ env: { A: '1' } }))
    const message = "The last --settings in Extra arguments has no value. Give it a settings file or inline JSON (--settings '<file or JSON>'), or remove it in Agent Settings or Settings → Claude Code."
    // Both forms: at the end of the arguments, and with = but nothing after it.
    await expect(userSettings(['--verbose', '--settings'], base)).rejects.toThrow(message)
    await expect(userSettings(['--settings='], base)).rejects.toThrow(message)
    // An empty (or blank) separate value.
    await expect(userSettings(['--settings', '', '--verbose'], base)).rejects.toThrow(message)
    await expect(userSettings(['--settings', '  '], base)).rejects.toThrow(message)
    // The last one counts, as Claude Code reads it: a malformed one after a valid one is still refused.
    await expect(userSettings(['--settings', 'ok.json', '--settings'], base)).rejects.toThrow(message)
    await expect(userSettings(['--settings={"model":"opus"}', '--settings='], base)).rejects.toThrow(message)
    // A malformed one followed by a valid one is what Claude Code reads too: the valid one.
    expect(await userSettings(['--settings=', '--settings', 'ok.json'], base)).toEqual({ env: { A: '1' } })
  })

  it("refuses settings that would turn Combwork's hooks off where a merge can't undo it (Claude Code 2.1.292)", async () => {
    // disableAllHooks turns off every hook and the status line, Combwork's with the user's.
    await expect(userSettings(['--settings', '{"disableAllHooks":true}'], base)).rejects.toThrow('The --settings in Extra arguments turns off all hooks (disableAllHooks)')
    // Refused, never launched without them (#1285, Darren's decision): saying why, and what to change.
    await expect(userSettings(['--settings', '{"disableAllHooks":true}'], base)).rejects.toThrow(/how it knows what the agent is doing.*Take disableAllHooks out of those settings, or remove the --settings from Extra arguments/)
    expect(await userSettings(['--settings', '{"disableAllHooks":false}'], base)).toEqual({ disableAllHooks: false })
    // An allowlist that isn't a list blocks Combwork's HTTP hooks.
    await expect(userSettings(['--settings', '{"allowedHttpHookUrls":"https://x.example/*"}'], base)).rejects.toThrow('sets allowedHttpHookUrls to something other than a list')
    await expect(userSettings(['--settings', '{"httpHookAllowedEnvVars":null}'], base)).rejects.toThrow('sets httpHookAllowedEnvVars to something other than a list')
    // A variable in the env block doesn't turn hooks off (2.1.292): left as it is.
    expect(await userSettings(['--settings', '{"env":{"CLAUDE_CODE_DISABLE_HOOKS":"1"}}'], base)).toEqual({ env: { CLAUDE_CODE_DISABLE_HOOKS: '1' } })
  })

  it("adds what Combwork's hooks need to the user's HTTP hook allowlists, which Claude Code takes whole from this file", () => {
    // Restrictive lists: Combwork's URL and token variable added, the user's entries kept.
    expect(mergeLaunchSettings(hive(), { allowedHttpHookUrls: ['https://hooks.example/*'], httpHookAllowedEnvVars: ['MY_TOKEN'] }, NEEDS)).toMatchObject({ allowedHttpHookUrls: ['https://hooks.example/*', NEEDS.url], httpHookAllowedEnvVars: ['MY_TOKEN', 'CW_HOOK_TOKEN'] })
    // Empty lists (nothing allowed): only Combwork's.
    expect(mergeLaunchSettings(hive(), { allowedHttpHookUrls: [], httpHookAllowedEnvVars: [] }, NEEDS)).toMatchObject({ allowedHttpHookUrls: [NEEDS.url], httpHookAllowedEnvVars: ['CW_HOOK_TOKEN'] })
    // Already allowed: unchanged, not repeated.
    expect(mergeLaunchSettings(hive(), { allowedHttpHookUrls: [NEEDS.url], httpHookAllowedEnvVars: ['CW_HOOK_TOKEN'] }, NEEDS)).toMatchObject({ allowedHttpHookUrls: [NEEDS.url], httpHookAllowedEnvVars: ['CW_HOOK_TOKEN'] })
    // Not set: not added (unset allows every URL and variable; setting one would block the user's other HTTP hooks).
    const merged = mergeLaunchSettings(hive(), { env: {} }, NEEDS)
    expect('allowedHttpHookUrls' in merged || 'httpHookAllowedEnvVars' in merged).toBe(false)
  })

  it("merges: every setting of theirs, their hooks after Combwork's for each event, Combwork's status line", () => {
    const theirs = {
      env: { B: '2' },
      autoCompactWindow: 250000,
      statusLine: { type: 'command', command: 'theirs-status' },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'theirs-stop' }] }], PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'theirs-post' }] }], Bad: 'x' }
    }
    expect(mergeLaunchSettings(hive(), theirs, NEEDS)).toEqual({
      env: { B: '2' },
      autoCompactWindow: 250000,
      statusLine: hive().statusLine,
      hooks: {
        Stop: [...hive().hooks.Stop, ...theirs.hooks.Stop],
        SessionStart: hive().hooks.SessionStart,
        PostToolUse: theirs.hooks.PostToolUse
      }
    })
    // Hooks that aren't an object, or none: Combwork's own.
    expect(mergeLaunchSettings(hive(), { hooks: [1] }, NEEDS).hooks).toEqual(hive().hooks)
    expect(mergeLaunchSettings(hive(), null, NEEDS)).toEqual(hive())
  })

  it('a launch passes one --settings, Combwork\'s file, holding Combwork\'s hooks and status line with the user\'s settings', async () => {
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    const project = join(base, 'project')
    writeFileSync(join(base, 'mine.json'), JSON.stringify({ env: { B: '2' }, autoCompactWindow: 250000 }))
    const ctx = {
      projectPath: project, agentId: 'a1', executable: 'C:\\bin\\claude.exe', cwd: base, workspacePath: base, runId: 'r', sessionId: '00000000-0000-4000-8000-000000000000',
      resume: false, name: '', skills: [], mcpServers: {}, model: null, effort: null, permissionMode: null, extraArgs: ['--verbose', '--settings', 'mine.json'], hookUrl: 'http://127.0.0.1:9/hook?run=r', hookAuthFile: 'C:/hive/hook-auth/r.txt', privateDir: join(base, 'private-r'), guidance: '', env: {}, allowBackgroundSessions: true, use200kContext: false
    }
    await claudeCode.prepareLaunch(ctx as never)
    const cmd = claudeCode.buildCommand(ctx.executable, ctx as never)
    const settingsArgs = cmd.args.filter((a) => a === '--settings')
    expect(settingsArgs).toHaveLength(1)
    const file = cmd.args[cmd.args.indexOf('--settings') + 1]
    // In the launch's private folder, outside the project (#345).
    expect(file).toBe(join(ctx.privateDir, 'settings.json'))
    expect(cmd.args).toContain('--verbose')
    expect(cmd.args).not.toContain('mine.json')
    const merged = JSON.parse(readFileSync(file, 'utf8'))
    expect(merged).toMatchObject({ env: { B: '2' }, autoCompactWindow: 250000, statusLine: { type: 'command' } })
    expect(merged.hooks.Stop[0].hooks[0]).toMatchObject({ type: 'http', url: ctx.hookUrl })
    expect(Object.keys(merged.hooks)).toContain('SessionStart')
    // One Combwork can't read, or that would turn its hooks off, stops the launch before its folder changes.
    await expect(claudeCode.prepareLaunch({ ...ctx, extraArgs: ['--settings', 'missing.json'] } as never)).rejects.toThrow("can't be read")
    await expect(claudeCode.prepareLaunch({ ...ctx, extraArgs: ['--settings', '{"disableAllHooks":true}'] } as never)).rejects.toThrow('disableAllHooks')
    // So does a --settings with no value, even after a valid one (#361).
    await expect(claudeCode.prepareLaunch({ ...ctx, extraArgs: ['--settings', 'mine.json', '--settings'] } as never)).rejects.toThrow('has no value')
    await expect(claudeCode.prepareLaunch({ ...ctx, extraArgs: ['--settings='] } as never)).rejects.toThrow('has no value')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(merged)
  })
})
