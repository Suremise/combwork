import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { encodeProjectPath, parseTranscript } from '../src/main/providers/claude/usage'
import { recacheEstimate } from '../src/main/providers/common'
import { parseSkillFrontmatter } from '../src/main/skills'
import { findSecretWarnings, toLaunchDef } from '../src/main/mcp'
import { claudeFileAllowed, withFileLock, writeJsonAtomic } from '../src/main/fsutil'
import { splitArgs } from '../src/shared/providers'
import { readFile, readdir } from 'fs/promises'
import { assertSessionId, isSessionId, compactThreshold, DEFAULT_APP_CONFIG, DEFAULT_SETTINGS, effectiveModelLabel, mergeDefaults, migrateConfig, modelLabel } from '../src/shared/defaults'
import { tempDir, tempRoot } from './tempDir'
import type { StoredAgent } from '../src/shared/agentFolders'

const line = (o: unknown): string => JSON.stringify(o)

describe('encodeProjectPath', () => {
  it('matches Claude Code folder naming', () => {
    expect(encodeProjectPath('d:\\Code\\workspace\\hive')).toBe('d--Code-workspace-hive')
    expect(encodeProjectPath('/home/me/my.project')).toBe('-home-me-my-project')
  })
})

describe('parseTranscript', () => {
  const usage = (input: number, read: number, write: number, output: number, oneHour = true) => ({
    input_tokens: input,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: write,
    output_tokens: output,
    cache_creation: oneHour ? { ephemeral_1h_input_tokens: write, ephemeral_5m_input_tokens: 0 } : { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: write }
  })
  const transcript = [
    line({ type: 'user', timestamp: '2026-09-28T10:00:00.000Z', message: { role: 'user', content: 'hello' }, version: '2.1.283' }),
    // one request written as two content-block entries with the same usage — must be counted once
    line({ type: 'assistant', requestId: 'r1', timestamp: '2026-09-28T10:00:05.000Z', message: { model: 'claude-opus-5-5', usage: usage(10, 0, 5000, 100) } }),
    line({ type: 'assistant', requestId: 'r1', timestamp: '2026-09-28T10:00:06.000Z', message: { model: 'claude-opus-5-5', usage: usage(10, 0, 5000, 120) } }),
    line({ type: 'assistant', requestId: 'r2', timestamp: '2026-09-28T10:01:00.000Z', message: { model: 'claude-opus-5-5', usage: usage(2, 5000, 300, 50) } }),
    'not json',
    line({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-09-28T10:02:00.000Z', compactMetadata: { trigger: 'auto', preTokens: 900000, postTokens: 15000 } }),
    line({ type: 'ai-title', aiTitle: 'Fix login bug' }),
    line({ type: 'last-prompt', lastPrompt: 'run the tests' }),
    line({ type: 'unknown-future-entry', foo: 1 })
  ].join('\n')

  const u = parseTranscript(transcript, 'abc')

  it('counts each request once using its final usage', () => {
    expect(u.requests).toBe(2)
    expect(u.outputTokens).toBe(120 + 50)
    expect(u.inputTokens).toBe(12)
    expect(u.cacheWriteTokens).toBe(5300)
    expect(u.cacheReadTokens).toBe(5000)
  })

  it('uses post-compaction size as the current context', () => {
    // The compaction keeps the last request before it: its input and output (#154).
    expect(u.compactions).toEqual([{ timestamp: '2026-09-28T10:02:00.000Z', trigger: 'auto', preTokens: 900000, postTokens: 15000, lastInputTokens: 5302, lastOutputTokens: 50 }])
    expect(u.contextTokens).toBe(15000)
    expect([u.contextInputTokens, u.lastOutputTokens]).toEqual([15000, 0])
  })

  it("counts the last turn's output in the context: what Claude Code compacts on (#154)", async () => {
    const { turnPushedCompaction } = await import('../src/shared/defaults')
    const { autoCompactAt, contextLines } = await import('../src/shared/providers')
    // The Amiga session's first compaction: 116,144 in, then a turn of 72,443 output (mostly thinking), compacted at 189,560.
    const turn = line({ type: 'assistant', requestId: 'big', timestamp: '2026-10-04T10:00:00Z', message: { model: 'claude-opus-5-5', usage: { input_tokens: 3, cache_read_input_tokens: 110_000, cache_creation_input_tokens: 6_141, output_tokens: 72_443 } } })
    const before = parseTranscript(turn, 'amiga')
    expect([before.contextInputTokens, before.lastOutputTokens, before.contextTokens]).toEqual([116_144, 72_443, 188_587])
    const boundary = line({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-10-04T10:01:00Z', compactMetadata: { trigger: 'auto', preTokens: 189_560, postTokens: 9_000 } })
    const after = parseTranscript([turn, boundary].join('\n'), 'amiga')
    expect(after.compactions[0]).toMatchObject({ preTokens: 189_560, lastInputTokens: 116_144, lastOutputTokens: 72_443 })
    expect(turnPushedCompaction(after.compactions[0])).toBe(true)
    // A small turn, or one that wasn't most of the jump, doesn't explain it.
    expect(turnPushedCompaction({ preTokens: 189_560, lastInputTokens: 180_000, lastOutputTokens: 9_000 })).toBe(false)
    expect(turnPushedCompaction({ preTokens: 189_560, lastInputTokens: 100_000, lastOutputTokens: 30_000 })).toBe(false)
    expect(turnPushedCompaction({ preTokens: 189_560 })).toBe(false)
    // Where Claude Code compacts by itself: about 167K of 200K, 967K of 1M; Codex's rule isn't known.
    expect([autoCompactAt('claude-code', 200_000), autoCompactAt('claude-code', 1_000_000), autoCompactAt('claude-code', null), autoCompactAt('codex', 272_000), autoCompactAt('claude-code', 1000)]).toEqual([167_000, 967_000, null, null, null])
    // Not running: its settings weren't read, so the figure is the default, and said to be (#242).
    expect(contextLines({ ...before, contextWindow: 200_000 })).toEqual(['Context: 188,587 tokens of 200,000', '116,144 input + 72,443 output of the last turn (thinking included)', 'Claude Code compacts by itself at about 167,000 by default (its settings can change this)'])
  })

  it('says where the CLI compacts by itself, as its settings were read at launch (#242)', async () => {
    const { autoCompactLine } = await import('../src/shared/providers')
    // Read at launch and nothing set: the default for the window.
    expect(autoCompactLine('claude-code', 200_000, { window: null, source: null })).toBe('Claude Code compacts by itself at about 167,000, its default for this window')
    expect(autoCompactLine('claude-code', 1_000_000, { window: null, source: null })).toBe('Claude Code compacts by itself at about 967,000, its default for this window')
    // A window set: on a 1M model it moves; it never goes past the model's own window.
    expect(autoCompactLine('claude-code', 1_000_000, { window: 500_000, source: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW' })).toBe('Claude Code compacts by itself at about 467,000: its auto-compact window is 500,000 (CLAUDE_CODE_AUTO_COMPACT_WINDOW)')
    expect(autoCompactLine('claude-code', 200_000, { window: 500_000, source: '--autocompact' })).toBe('Claude Code compacts by itself at about 167,000: its auto-compact window is 200,000 (--autocompact)')
    // A percentage brings it earlier, never later.
    expect(autoCompactLine('claude-code', 200_000, { window: null, source: 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', percent: 50 })).toBe('Claude Code compacts by itself at about 100,000, its default for this window (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, at 50% of it)')
    expect(autoCompactLine('claude-code', 200_000, { window: null, source: null, percent: 95 })).toBe('Claude Code compacts by itself at about 167,000, its default for this window (at 95% of it)')
    // Off; "auto" in a settings file (the default, said where).
    expect(autoCompactLine('claude-code', 200_000, { window: 'off', source: "autoCompactEnabled: false in Claude Code's settings.json" })).toBe("Claude Code doesn't compact by itself: auto-compaction is off (autoCompactEnabled: false in Claude Code's settings.json)")
    expect(autoCompactLine('claude-code', 200_000, { window: null, source: '--autocompact auto' })).toBe('Claude Code compacts by itself at about 167,000, its default for this window (--autocompact auto)')
    // No window known, or a provider without a rule: nothing said.
    expect(autoCompactLine('claude-code', null, { window: 500_000, source: '--autocompact' })).toBeNull()
    expect(autoCompactLine('codex', 272_000, { window: null, source: null })).toBeNull()
  })

  it('reads metadata', () => {
    expect(u.title).toBe('Fix login bug')
    expect(u.model).toBe('claude-opus-5-5')
    expect(u.cliVersion).toBe('2.1.283')
    expect(u.lastPrompt).toBe('run the tests')
    expect(u.userMessages).toBe(1)
    expect(u.cacheTtlSeconds).toBe(3600)
    expect(u.lastActivity).toBe('2026-09-28T10:02:00.000Z')
  })

  it('detects the 5-minute cache', () => {
    const t = line({ type: 'assistant', requestId: 'x', timestamp: '2026-09-28T10:00:00Z', message: { usage: usage(1, 0, 100, 1, false) } })
    expect(parseTranscript(t, 'x').cacheTtlSeconds).toBe(300)
  })

  it('custom titles win over AI titles', () => {
    const t = [line({ type: 'ai-title', aiTitle: 'AI' }), line({ type: 'custom-title', customTitle: 'Mine' })].join('\n')
    expect(parseTranscript(t, 'x').title).toBe('Mine')
  })

  it("keeps the tokens used after Claude Code last wrote its cost, for Combwork's estimate", async () => {
    const t = [
      line({ type: 'assistant', requestId: 'r1', message: { model: 'claude-opus-5-5', usage: usage(10, 0, 1000, 100) } }),
      line({ type: 'cost-state', totalCostUSD: 1.5 }),
      line({ type: 'assistant', requestId: 'r2', message: { model: 'claude-opus-5-5', usage: usage(2, 1000, 0, 40) } }),
      line({ type: 'assistant', requestId: 'r3', message: { model: 'claude-opus-5-5', usage: usage(3, 2000, 500, 60) } })
    ].join('\n')
    const late = parseTranscript(t, 'x')
    expect(late.costUsd).toBe(1.5)
    expect(late.costUnreported).toEqual({ inputTokens: 5, outputTokens: 100, cacheWriteTokens: 500, cacheReadTokens: 3000 })
    // Everything reported: nothing to add.
    expect(parseTranscript([t, line({ type: 'cost-state', totalCostUSD: 2 })].join('\n'), 'x').costUnreported).toBeUndefined()
    // The session list adds the estimate for them and marks the cost as partly estimated.
    const { estimateCost } = await import('../src/shared/prices')
    expect(estimateCost({ ...late, ...late.costUnreported! })).toBeGreaterThan(0)
  })
})

describe('recacheEstimate', () => {
  const base = parseTranscript(line({ type: 'assistant', requestId: 'a', timestamp: '2026-09-28T10:00:00.000Z', message: { usage: { input_tokens: 5, cache_read_input_tokens: 80000, cache_creation_input_tokens: 1000, output_tokens: 1, cache_creation: { ephemeral_5m_input_tokens: 1000 } } } }), 'a')

  it('is warm within the TTL', () => {
    const r = recacheEstimate(base, 'auto', Date.parse('2026-09-28T10:03:00.000Z'))
    expect(r.warm).toBe(true)
    expect(r.secondsLeft).toBe(120)
    // The context: the last request's input and its output (#154).
    expect(r.tokens).toBe(81006)
  })

  it('expires after the TTL and honours overrides', () => {
    expect(recacheEstimate(base, 'auto', Date.parse('2026-09-28T10:06:00.000Z')).warm).toBe(false)
    expect(recacheEstimate(base, '1h', Date.parse('2026-09-28T10:06:00.000Z')).warm).toBe(true)
  })
})

describe('parseSkillFrontmatter', () => {
  it('reads simple and block values', () => {
    expect(parseSkillFrontmatter('---\nname: my-skill\ndescription: "Does things"\n---\nbody')).toEqual({ name: 'my-skill', description: 'Does things' })
    expect(parseSkillFrontmatter('---\r\nname: x\r\ndescription: >\r\n  line one\r\n  line two\r\n---\r\n')).toEqual({ name: 'x', description: 'line one line two' })
    expect(parseSkillFrontmatter('# no frontmatter')).toEqual({})
  })
  it('unescapes quoted values', () => {
    expect(parseSkillFrontmatter('---\ndescription: "Use for: \\"deploys\\" and C:\\\\temp"\n---\n').description).toBe('Use for: "deploys" and C:\\temp')
    expect(parseSkillFrontmatter("---\ndescription: 'It''s here'\n---\n").description).toBe("It's here")
  })
})

describe('MCP definitions', () => {
  it('flags literal secrets but not env references', () => {
    expect(findSecretWarnings({ command: 'x', env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } })).toHaveLength(0)
    expect(findSecretWarnings({ command: 'x', env: { GITHUB_TOKEN: 'ghp_abcdefghijklmnop' } })).toHaveLength(1)
    expect(findSecretWarnings({ command: 'x', env: { API_KEY: 'supersecretvalue' } })).toHaveLength(1)
    expect(findSecretWarnings({ url: 'https://x', headers: { Authorization: 'Bearer ${TOKEN}' } })).toHaveLength(0)
    expect(findSecretWarnings({ command: 'x', args: ['--key', 'sk-ant-12345'] })).toHaveLength(1)
    expect(findSecretWarnings({ command: 'x', env: { LOG_LEVEL: 'debug' } })).toHaveLength(0)
  })

  it('strips description and expands HIVE_MCP_DIR', () => {
    expect(toLaunchDef({ description: 'd', command: 'node', args: ['${HIVE_MCP_DIR}/srv/index.js'] }, 'C:\\ws\\.combwork\\mcp')).toEqual({ command: 'node', args: ['C:/ws/.combwork/mcp/srv/index.js'] })
  })
})

describe('splitArgs', () => {
  it('honours quotes', () => {
    expect(splitArgs('--add-dir "../my lib" --verbose \'a b\'')).toEqual(['--add-dir', '../my lib', '--verbose', 'a b'])
    expect(splitArgs('   ')).toEqual([])
  })
})

describe('mergeDefaults', () => {
  it('fills new settings and keeps saved ones', () => {
    const merged = mergeDefaults(DEFAULT_SETTINGS, { general: { closeToTray: false }, providers: { 'claude-code': { defaultModel: 'opus' } } })
    expect(merged.general.closeToTray).toBe(false)
    expect(merged.general.confirmOnQuit).toBe('working')
    expect(merged.providers['claude-code'].defaultModel).toBe('opus')
    expect(merged.providers['claude-code'].enabled).toBe(false)
    expect(merged.agentApi.port).toBe(DEFAULT_SETTINGS.agentApi.port)
  })
})

describe('migrateConfig', () => {
  const load = (confirmOnQuit: unknown) =>
    migrateConfig(mergeDefaults(structuredClone(DEFAULT_APP_CONFIG), { settings: { general: { confirmOnQuit } } })).settings.general.confirmOnQuit

  it('maps the old on/off quit confirmation', () => {
    expect(load(true)).toBe('working')
    expect(load(false)).toBe('never')
  })
  it('keeps valid choices and repairs unknown ones', () => {
    expect(load('always')).toBe('always')
    expect(load('never')).toBe('never')
    expect(load('sometimes')).toBe('working')
    expect(migrateConfig(structuredClone(DEFAULT_APP_CONFIG)).settings.general.confirmOnQuit).toBe('working')
  })
})

describe('providers migration', () => {
  const v1 = {
    settings: { claude: { executablePath: 'C:\\x\\claude.exe', defaultModel: 'opus', defaultEffort: 'high', defaultPermissionMode: 'acceptEdits', enableBypassOption: true, extraArgs: '--verbose', checkUpdatesOnLaunch: false } },
    observedDefaultModel: 'claude-opus-5-5',
    planUsage: { fiveHour: { usedPercent: 40, resetsAt: '2026-09-29T15:00:00.000Z' }, sevenDay: null, updatedAt: '2026-09-29T10:00:00.000Z' },
    planWarnings: { fiveHour: { resetsAt: '2026-09-29T15:00:00.000Z', level: 80 } }
  }
  const load = (raw: Record<string, unknown>) => migrateConfig(mergeDefaults(structuredClone(DEFAULT_APP_CONFIG), raw), raw)

  it('a fresh install starts with every provider off', () => {
    expect(Object.values(DEFAULT_SETTINGS.providers).every((p) => !p.enabled)).toBe(true)
    expect(DEFAULT_APP_CONFIG.version).toBe(9)
  })
  it('moves a default persona that went to its working mode, once (#259)', () => {
    // Saved before 0.9.3, as `persona` (#1084).
    expect(load({ version: 6, settings: { assistant: { persona: 'overseer' } } }).settings.assistant.mode).toBe('coordinator')
    expect(load({ version: 6, settings: { assistant: { persona: 'reviewer' } } }).settings.assistant.mode).toBe('qa-triager')
    expect(load({ version: 6, settings: { assistant: { persona: 'my-own' } } }).settings.assistant.mode).toBe('my-own')
    // Saved since (version 7): a mode of the user's named like an old one stays.
    expect(load({ version: 7, settings: { assistant: { persona: 'overseer' } } }).settings.assistant.mode).toBe('overseer')
    expect(load({ version: 8, settings: { assistant: { mode: 'overseer' } } }).settings.assistant.mode).toBe('overseer')
    expect(DEFAULT_SETTINGS.assistant.mode).toBe('coordinator')
  })
  it("carries what the persona names had over to the mode names (#1084): the default mode, the command's shortcut, the tip", () => {
    const c = load({ version: 8, settings: { assistant: { persona: 'planner' }, keybindings: { 'view.personas': 'Ctrl+Alt+M' } }, ui: { tips: { seen: ['agentMenu', 'personas'], used: ['view.personas'], moments: [] } } })
    expect(c.settings.assistant.mode).toBe('planner')
    expect(c.settings.assistant).not.toHaveProperty('persona')
    expect(c.settings.keybindings).toEqual({ 'view.modes': 'Ctrl+Alt+M' })
    expect(c.ui.tips).toMatchObject({ seen: ['agentMenu', 'modes'], used: ['view.modes'] })
    // What the new names already have stays: a newer Combwork saved both.
    const both = load({ version: 8, settings: { assistant: { persona: 'planner', mode: 'qa-triager' }, keybindings: { 'view.personas': 'Ctrl+Alt+M', 'view.modes': '' } }, ui: { tips: { seen: ['personas', 'modes'], used: [], moments: [] } } })
    expect(both.settings.assistant.mode).toBe('qa-triager')
    expect(both.settings.keybindings).toEqual({ 'view.modes': '' })
    expect(both.ui.tips?.seen).toEqual(['modes'])
    // None saved: the default.
    expect(load({ version: 8, settings: {} }).settings.assistant.mode).toBe('coordinator')
  })
  it("gives the Combwork Assistant's agent its mode from its persona of before 0.9.3 (#1084)", async () => {
    const { migrateProjectConfig } = await import('../src/shared/defaults')
    const m = migrateProjectConfig({ version: 2, providers: {}, layout: 'auto', agents: [{ id: 'assistant', name: 'Assistant', persona: 'planner' }, { id: 'a1', name: 'Builder' }] })
    expect(m.agents).toEqual([{ id: 'assistant', name: 'Assistant', mode: 'planner' }, { id: 'a1', name: 'Builder' }])
    // Saved by a newer Combwork with both: its mode stays.
    expect(migrateProjectConfig({ version: 2, providers: {}, layout: 'auto', agents: [{ id: 'assistant', name: 'Assistant', persona: 'planner', mode: 'coordinator' }] }).agents).toEqual([{ id: 'assistant', name: 'Assistant', mode: 'coordinator' }])
  })
  it('moves 0.1 Claude Code settings over and keeps Claude Code on', () => {
    const c = load(v1)
    expect(c.version).toBe(9)
    // Automatic (#474), which picks Claude Code: it stays on.
    expect(c.settings.defaultProvider).toBe('auto')
    expect(c.settings.providers['claude-code']).toMatchObject({ enabled: true, executablePath: 'C:\\x\\claude.exe', defaultModel: 'opus', defaultEffort: 'high', defaultPermissionMode: 'acceptEdits', enableDangerousMode: true, extraArgs: '--verbose', checkUpdatesOnLaunch: false })
    expect(c.observedDefaultModel).toEqual({ 'claude-code': 'claude-opus-5-5' })
    expect(c.planUsage['claude-code'].limits).toEqual([{ id: 'five_hour', label: '5-hour', windowMinutes: 300, usedPercent: 40, resetsAt: '2026-09-29T15:00:00.000Z' }])
    expect(c.planWarnings).toEqual({ 'claude-code:five_hour': { resetsAt: '2026-09-29T15:00:00.000Z', level: 80 } })
  })
  it('leaves a version 2 config alone', () => {
    const c = load({ version: 2, settings: { providers: { 'claude-code': { enabled: false } } } })
    expect(c.settings.providers['claude-code'].enabled).toBe(false)
  })
  it("moves the Assistant off 0.2's lighter defaults onto the agents', keeping other choices", () => {
    const assistant = (providers: Record<string, unknown>) => ({ settings: { assistant: { providers } } })
    const old = load({ version: 2, ...assistant({ 'claude-code': { model: 'sonnet', effort: 'low', permissionMode: '', extraArgs: '' }, codex: { model: '', effort: 'low', permissionMode: '', extraArgs: '' } }) })
    expect(old.settings.assistant.providers['claude-code']).toMatchObject({ model: '', effort: '' })
    expect(old.settings.assistant.providers.codex).toMatchObject({ model: '', effort: '' })
    const chosen = load({ version: 2, ...assistant({ 'claude-code': { model: 'opus', effort: 'medium', permissionMode: '', extraArgs: '' }, codex: { model: 'gpt-6.1-sol', effort: 'high', permissionMode: '', extraArgs: '' } }) })
    expect(chosen.settings.assistant.providers['claude-code']).toMatchObject({ model: 'opus', effort: 'medium' })
    expect(chosen.settings.assistant.providers.codex).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high' })
    // Once migrated, the same values are the user's choice.
    expect(load({ version: 3, ...assistant({ 'claude-code': { model: 'sonnet', effort: 'low', permissionMode: '', extraArgs: '' } }) }).settings.assistant.providers['claude-code']).toMatchObject({ model: 'sonnet', effort: 'low' })
    expect(DEFAULT_SETTINGS.assistant.providers['claude-code']).toMatchObject({ model: '', effort: '' })
  })
  it("drops Agents & Worktrees' merge style and moves its copy patterns to Combwork's slot default, once (HI-1765)", () => {
    const agents = (raw: Record<string, unknown>) => load(raw).settings.agents as Record<string, unknown>
    const slots = (raw: Record<string, unknown>) => load(raw).settings.slotDefaults
    expect(agents({ version: 8, settings: { agents: { mergeStyle: 'squash', worktreeCopy: 'a.env' } } })).not.toHaveProperty('mergeStyle')
    expect(agents({ version: 8, settings: { agents: { worktreeCopy: 'a.env' } } })).not.toHaveProperty('worktreeCopy')
    // A chosen value moves over, an empty one (none) too; the old default, saved into every config, doesn't.
    expect(slots({ version: 8, settings: { agents: { worktreeCopy: 'a.env, b.json' } } })).toEqual({ copy: 'a.env, b.json' })
    expect(slots({ version: 8, settings: { agents: { worktreeCopy: '' } } })).toEqual({ copy: '' })
    expect(slots({ version: 8, settings: { agents: { worktreeCopy: '.env*' } } })).toBeUndefined()
    // A slot default already set stays: the old key never restores itself over it.
    expect(slots({ version: 8, settings: { slotDefaults: { copy: 'new.env' }, agents: { worktreeCopy: 'old.env' } } })).toEqual({ copy: 'new.env' })
    expect(slots({ version: 8, settings: { agents: {} } })).toBeUndefined()
  })
  it('moves the old 50 MB transcript warning default to 20 MB once, keeping any other choice', () => {
    const warn = (raw: Record<string, unknown>) => load(raw).settings.sessions.transcriptWarnMB
    const saved = (version: number, transcriptWarnMB?: number) => ({ version, settings: { sessions: transcriptWarnMB === undefined ? {} : { transcriptWarnMB } } })
    expect(DEFAULT_SETTINGS.sessions.transcriptWarnMB).toBe(20)
    expect(warn(saved(4, 50))).toBe(20)
    expect(warn(saved(1, 50))).toBe(20)
    // Another size, Never (0), or none saved (the default).
    expect([warn(saved(4, 35)), warn(saved(4, 100)), warn(saved(4, 0)), warn(saved(4))]).toEqual([35, 100, 0, 20])
    // Once migrated, 50 is the user's choice.
    expect(warn(saved(5, 50))).toBe(50)
  })
  it("one notification system (HI-2320, config 9): While Combwork is focused goes, Show nothing becomes Only in the bell, top centre moves to bottom right", () => {
    const notifications = (raw: Record<string, unknown>) => load(raw).settings.notifications as unknown as Record<string, unknown>
    expect(DEFAULT_SETTINGS.notifications.bannerPosition).toBe('bottom-right')
    expect('whileFocused' in DEFAULT_SETTINGS.notifications).toBe(false)
    // Each While Combwork is focused × each scope: Show nothing becomes Only in the bell (background Windows notifications
    // are kept by the routing table, tests/notify.test.ts); Show in Combwork and Windows notification keep the scope.
    for (const bannerScope of ['all', 'workspace', 'project'] as const) {
      expect(notifications({ version: 8, settings: { notifications: { whileFocused: 'nothing', bannerScope } } }).bannerScope, bannerScope).toBe('none')
      expect(notifications({ version: 8, settings: { notifications: { whileFocused: 'inApp', bannerScope } } }).bannerScope, bannerScope).toBe(bannerScope)
      expect(notifications({ version: 8, settings: { notifications: { whileFocused: 'windows', bannerScope } } }).bannerScope, bannerScope).toBe(bannerScope)
    }
    for (const whileFocused of ['inApp', 'nothing', 'windows']) expect('whileFocused' in notifications({ version: 8, settings: { notifications: { whileFocused } } }), whileFocused).toBe(false)
    // Before version 6 everyone was moved to Show in Hive: their old onlyWhenUnfocused says nothing now, and goes.
    for (const onlyWhenUnfocused of [true, false]) {
      const n = notifications({ version: 5, settings: { notifications: { onlyWhenUnfocused, bannerScope: 'project' } } })
      expect(n.bannerScope).toBe('project')
      expect('onlyWhenUnfocused' in n).toBe(false)
    }
    // The old default place moves to the pop-ups' corner; any other place chosen is kept.
    expect(notifications({ version: 8, settings: { notifications: { bannerPosition: 'top-center' } } }).bannerPosition).toBe('bottom-right')
    for (const bannerPosition of ['top-left', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right']) expect(notifications({ version: 8, settings: { notifications: { bannerPosition } } }).bannerPosition, bannerPosition).toBe(bannerPosition)
    // Once migrated, a choice is the user's: top centre chosen since stays.
    expect(notifications({ version: 9, settings: { notifications: { bannerPosition: 'top-center' } } }).bannerPosition).toBe('top-center')
    expect(notifications({ version: 9, settings: { notifications: { bannerScope: 'none' } } }).bannerScope).toBe('none')
  })
  it('writes the Claude Code settings where 0.1 reads them', async () => {
    const { withLegacySettings } = await import('../src/shared/defaults')
    const out = withLegacySettings(load(v1))
    expect(out.settings.claude).toMatchObject({ defaultModel: 'opus', enableBypassOption: true, defaultPermissionMode: 'acceptEdits' })
  })
  it('moves a 0.1 project to Claude Code and back', async () => {
    const { migrateProjectConfig, withLegacyProjectFields, DEFAULT_PROJECT_CONFIG } = await import('../src/shared/defaults')
    const m = migrateProjectConfig({ version: 1, model: 'sonnet', effort: 'inherit', permissionMode: 'plan', extraArgs: '', agents: [{ id: 'a2', name: 'Agent 2' }], sessionLayout: 'grid' })
    expect(m.providers['claude-code']).toEqual({ model: 'sonnet', effort: 'inherit', permissionMode: 'plan', extraArgs: '' })
    expect('model' in m).toBe(false)
    // 0.2.0: 0.1's agents and layout are cleared; the project keeps inheriting the default provider.
    expect(m).toMatchObject({ version: 2, agents: [], layout: 'auto' })
    expect('sessionLayout' in m).toBe(false)
    expect(m.defaultProvider).toBeUndefined()
    const v2 = { version: 2, providers: {}, defaultProvider: 'inherit', agents: [{ id: 'a-1', name: 'Agent 1', provider: 'codex' }] }
    expect(migrateProjectConfig(v2)).toEqual({ ...v2, layout: 'auto' })
    const cfg = mergeDefaults(structuredClone(DEFAULT_PROJECT_CONFIG), m)
    expect(withLegacyProjectFields(cfg)).toMatchObject({ model: 'sonnet', permissionMode: 'plan' })
  })
  it('drops the skill switches from before 0.2, which nothing reads, keeping the MCP ones', async () => {
    const { migrateProjectConfig, withoutSkillSwitches, DEFAULT_PROJECT_CONFIG, DEFAULT_WORKSPACE_CONFIG } = await import('../src/shared/defaults')
    const project = migrateProjectConfig({ version: 2, providers: {}, layout: 'auto', skills: { disabled: ['handover'] }, mcp: { disabled: ['github'] } })
    expect('skills' in project).toBe(false)
    // A project.json from before #713 has chosen no server on itself: its disabled list is kept, its enabled list empty.
    expect(mergeDefaults(structuredClone(DEFAULT_PROJECT_CONFIG), project).mcp).toEqual({ disabled: ['github'], enabled: [] })
    const ws = mergeDefaults(structuredClone(DEFAULT_WORKSPACE_CONFIG), withoutSkillSwitches({ version: 1, skills: { enabled: ['handover'] }, mcp: { enabled: ['github'] } }))
    expect(ws).toEqual({ version: 1, mcp: { enabled: ['github'] } })
  })
  it('resolves an agent from its own, the project and the global settings', async () => {
    const { legacyLaunchSettings: agentLaunchSettings } = await import('../src/shared/connectionDefaults')
    const settings = mergeDefaults(DEFAULT_SETTINGS, { providers: { 'claude-code': { enabled: true, defaultModel: 'opus', defaultPermissionMode: 'auto' } } })
    const cfg = { defaultProvider: 'inherit', providers: { 'claude-code': { model: 'sonnet', effort: 'inherit', permissionMode: 'inherit', extraArgs: '--x', use200kContext: 'inherit' as const } } }
    expect(agentLaunchSettings({}, cfg, settings)).toMatchObject({ provider: 'claude-code', model: 'sonnet', permissionMode: 'auto', extraArgs: ['--x'] })
    expect(agentLaunchSettings({ model: 'haiku', permissionMode: 'plan' }, cfg, settings)).toMatchObject({ model: 'haiku', permissionMode: 'plan' })
    // The dangerous mode needs enabling; otherwise the project's mode is used.
    expect(agentLaunchSettings({ permissionMode: 'bypassPermissions' }, cfg, settings).permissionMode).toBe('auto')
    // A mode from another provider falls back too.
    expect(agentLaunchSettings({ permissionMode: 'full-access' }, cfg, settings).permissionMode).toBe('auto')
  })
  it('resolves the 200K context from the agent, the project and the global setting', async () => {
    const { legacyLaunchSettings: agentLaunchSettings } = await import('../src/shared/connectionDefaults')
    const base = { model: 'inherit', effort: 'inherit', permissionMode: 'inherit', extraArgs: '' }
    const project = (use200kContext: 'inherit' | 'on' | 'off') => ({ defaultProvider: 'inherit', providers: { 'claude-code': { ...base, use200kContext }, codex: { ...base, use200kContext } } })
    const on = mergeDefaults(DEFAULT_SETTINGS, { providers: { 'claude-code': { enabled: true, use200kContext: true }, codex: { enabled: true, use200kContext: true } } })
    const off = mergeDefaults(DEFAULT_SETTINGS, { providers: { 'claude-code': { enabled: true } } })
    // Off by default; the global setting, then the project's, then the agent's own choice.
    expect(agentLaunchSettings({}, project('inherit'), off).use200kContext).toBe(false)
    expect(agentLaunchSettings({}, project('inherit'), on).use200kContext).toBe(true)
    expect(agentLaunchSettings({}, project('off'), on).use200kContext).toBe(false)
    expect(agentLaunchSettings({}, project('on'), off).use200kContext).toBe(true)
    expect(agentLaunchSettings({ use200kContext: false }, project('on'), on).use200kContext).toBe(false)
    expect(agentLaunchSettings({ use200kContext: true }, project('off'), off).use200kContext).toBe(true)
    // A project.json from before the setting inherits.
    expect(agentLaunchSettings({}, { defaultProvider: 'inherit', providers: { 'claude-code': base as never } }, on).use200kContext).toBe(true)
    // Only for providers that can limit the context.
    expect(agentLaunchSettings({ provider: 'codex', use200kContext: true }, project('on'), on).use200kContext).toBe(false)
  })
})

describe('modelLabel', () => {
  it('names aliases and model ids', () => {
    expect(modelLabel('opus')).toBe('Opus')
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(modelLabel('claude-haiku-5-5')).toBe('Haiku 5.5')
    expect(modelLabel('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5')
    expect(modelLabel('claude-opus-4-20250514')).toBe('Opus 4')
    expect(modelLabel('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5 (1M)')
    expect(modelLabel('some-custom-model')).toBe('some-custom-model')
  })
  it('marks inherited models as the default', () => {
    // Without the CLI's catalog an alias can't be resolved: it shows as named (never guessed).
    const cliDefault = { defaultModel: 'claude-opus-5-5' }
    expect(effectiveModelLabel('claude-code', 'sonnet', 'opus', cliDefault)).toBe('Sonnet')
    expect(effectiveModelLabel('claude-code', 'inherit', 'opus', cliDefault)).toBe('Opus (default)')
    expect(effectiveModelLabel('claude-code', 'inherit', '', cliDefault)).toBe('Opus 5.5 (default)')
    expect(effectiveModelLabel('claude-code', 'inherit', '', null)).toBe('Claude Code default')
  })
})

describe('compactThreshold', () => {
  it('uses the project value, or inherits the global one', () => {
    expect(compactThreshold({ compactSuggestTokens: null }, 200000)).toBe(200000)
    expect(compactThreshold({ compactSuggestTokens: 50000 }, 200000)).toBe(50000)
    expect(compactThreshold({ compactSuggestTokens: 0 }, 200000)).toBe(0)
    expect(compactThreshold(undefined, 150000)).toBe(150000)
  })
})

describe('hookForwardCommand', () => {
  it("forwards the hook JSON from stdin to the hook server, its header read from the launch's auth file (#345)", async () => {
    const { hookForwardCommand } = await import('../src/main/providers/common')
    const cmd = hookForwardCommand('http://127.0.0.1:5000/hook?run=abc', 'C:\\Users\\me\\AppData\\Roaming\\Combwork\\hook-auth\\abc.txt')
    // The form that works in Git Bash, PowerShell and cmd (checked on Windows 11 with curl 8.21 and Git's 8.7.1).
    expect(cmd).toBe('curl.exe -s -m 5 -X POST -H "@C:/Users/me/AppData/Roaming/Combwork/hook-auth/abc.txt" -H "Content-Type: application/json" --data-binary "@-" "http://127.0.0.1:5000/hook?run=abc"')
    expect(cmd).not.toMatch(/Authorization|Bearer/)
  })
})

describe('Claude Code hooks', () => {
  it('turns hook calls into Combwork events', async () => {
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    const h = (body: Record<string, unknown>) => claudeCode.normalizeHook(body)
    expect(h({ hook_event_name: 'SessionStart', session_id: 's1', source: 'resume' })).toMatchObject({ event: { kind: 'start', source: 'resume' }, sessionId: 's1' })
    expect(h({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'a.ts' }, permission_mode: 'default' })).toMatchObject({ event: { kind: 'toolStart' }, editedPaths: ['a.ts'], mode: 'manual' })
    // Every tool's start reaches Combwork (#648: the turn ledger), but only an edit is checked against the locks.
    expect(h({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'a.ts' } })).toMatchObject({ event: { kind: 'toolStart' }, editedPaths: [] })
    expect(h({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' }).event).toEqual({ kind: 'ask', ask: { kind: 'permission', blocking: true, message: 'Claude needs your permission' } })
    expect(h({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }).event).toEqual({ kind: 'idle' })
    expect(h({ hook_event_name: 'Stop', last_assistant_message: 'done' }).event).toEqual({ kind: 'stop', lastMessage: 'done' })
    expect(claudeCode.lockReply({ kind: 'deny', reason: 'r' })).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'r' } })
  })

  it('reads the context window from the status line', async () => {
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    expect(claudeCode.statusLine({ context_window: { context_window_size: 1000000, used_percentage: 4 } }).contextWindow).toBe(1000000)
    expect(claudeCode.statusLine({ model: { display_name: 'Opus 5.5' } }).contextWindow).toBeUndefined()
  })

  it('reads the background job named when a resume is refused', async () => {
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    expect(claudeCode.backgroundJobIn('\x1b[31mSession a0292106 is still running in the background.\x1b[0m\r\nRun \x1b[1mclaude attach d98cd28c\x1b[0m to open it.')).toBe('d98cd28c')
    expect(claudeCode.backgroundJobIn('Run claude attach d98cd28c')).toBeNull()
    expect(claudeCode.backgroundJobIn('No conversation found with session ID a0292106')).toBeNull()
  })

  it('turns off 1M context for a 200K launch, without the "[1m]" Claude Code then rejects', async () => {
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    const ctx = {
      projectPath: 'C:\\ws\\p', agentId: 'a-1', executable: 'C:\\bin\\claude.exe', cwd: 'C:\\ws\\p', workspacePath: 'C:\\ws', runId: 'r', sessionId: '00000000-0000-4000-8000-000000000000',
      resume: false, name: '', skills: [], mcpServers: {}, model: 'opus[1m]', effort: null, permissionMode: null, extraArgs: [], hookUrl: '', hookAuthFile: '', privateDir: 'C:/hive/launches/r', guidance: '', env: { A: '1' }, allowBackgroundSessions: true, use200kContext: false
    }
    const full = claudeCode.buildCommand(ctx.executable, ctx)
    expect(full.args).toContain('opus[1m]')
    expect(full.env?.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBeUndefined()
    const small = claudeCode.buildCommand(ctx.executable, { ...ctx, use200kContext: true })
    expect(small.args[small.args.indexOf('--model') + 1]).toBe('opus')
    expect(small.env).toMatchObject({ A: '1', CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' })
  })

  it('resumes the Assistant with its current instructions, not the prompt its conversation recorded (#334)', async () => {
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    const ctx = {
      projectPath: 'C:\\ws\\.combwork\\assistant', agentId: 'assistant', executable: 'C:\\bin\\claude.exe', cliVersion: '2.1.292', cwd: 'C:\\ws', workspacePath: 'C:\\ws', runId: 'r', sessionId: '00000000-0000-4000-8000-000000000000',
      resume: true, name: '', skills: [], mcpServers: {}, model: null, effort: null, permissionMode: null, extraArgs: [] as string[], hookUrl: '', hookAuthFile: '', privateDir: 'C:/hive/launches/r', guidance: '', instructions: 'You are in Planner mode.', env: {}, allowBackgroundSessions: true, use200kContext: false
    }
    const snapshot = (c: typeof ctx): string | null => {
      const args = claudeCode.buildCommand(c.executable, c).args
      const i = args.indexOf('--system-prompt-snapshot')
      return i < 0 ? null : args[i + 1]
    }
    expect(snapshot(ctx)).toBe('off')
    expect(snapshot({ ...ctx, cliVersion: '2.1.267' })).toBe('off')
    // A new conversation records the prompt it is given; an agent has no instructions of its own.
    expect(snapshot({ ...ctx, resume: false })).toBeNull()
    expect(snapshot({ ...ctx, instructions: undefined as unknown as string })).toBeNull()
    // Older versions keep no record (and don't know the flag); an unknown version isn't given it either.
    expect(snapshot({ ...ctx, cliVersion: '2.1.266' })).toBeNull()
    expect(snapshot({ ...ctx, cliVersion: null as unknown as string })).toBeNull()
    // The user's own choice in Extra arguments stands.
    expect(snapshot({ ...ctx, extraArgs: ['--system-prompt-snapshot', 'on'] })).toBe('on')
    expect(claudeCode.buildCommand(ctx.executable, { ...ctx, extraArgs: ['--system-prompt-snapshot=on'] }).args.filter((a) => a.startsWith('--system-prompt-snapshot'))).toEqual(['--system-prompt-snapshot=on'])
  })

  it('passes the first task after "--", so extra arguments ending in a list option keep it (#523)', async () => {
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    const ctx = {
      projectPath: 'C:\\ws\\p', agentId: 'a-1', executable: 'C:\\bin\\claude.exe', cwd: 'C:\\ws\\p', workspacePath: 'C:\\ws', runId: 'r', sessionId: '00000000-0000-4000-8000-000000000000',
      resume: false, name: '', skills: [], mcpServers: {}, model: null, effort: null, permissionMode: null, extraArgs: ['--allowedTools', 'mcp__hive', 'Bash'], hookUrl: '', hookAuthFile: '', privateDir: 'C:/hive/launches/r', guidance: '', env: {}, allowBackgroundSessions: true, use200kContext: false,
      initialPrompt: 'Work on card #12'
    }
    // Claude Code 2.1.296 reads a plain argument after "--allowedTools a b" as another tool rule; after "--" it is the task.
    expect(claudeCode.buildCommand(ctx.executable, ctx).args.slice(-5)).toEqual(['--allowedTools', 'mcp__hive', 'Bash', '--', 'Work on card #12'])
    expect(claudeCode.buildCommand(ctx.executable, { ...ctx, resume: true }).args.slice(-2)).toEqual(['--', 'Work on card #12'])
    // The user's "--settings" Combwork takes out is not where the task goes.
    expect(claudeCode.buildCommand(ctx.executable, { ...ctx, extraArgs: ['--settings', '{}'] }).args.slice(-2)).toEqual(['--', 'Work on card #12'])
    // An option whose value is "--" is written with "=": Combwork's own "--" still comes before the task.
    expect(claudeCode.buildCommand(ctx.executable, { ...ctx, extraArgs: ['--append-system-prompt=--', '--allowedTools', 'Read'] }).args.slice(-5)).toEqual(['--append-system-prompt=--', '--allowedTools', 'Read', '--', 'Work on card #12'])
    // No task, no "--".
    expect(claudeCode.buildCommand(ctx.executable, { ...ctx, initialPrompt: undefined }).args).not.toContain('--')
  })

  it('refuses extra arguments with a bare "--" (#523: Combwork doesn\'t guess what it meant)', async () => {
    const { extraArgsProblem } = await import('../src/shared/providers')
    const refused = 'Combwork passes the task after "--"; remove it from extra arguments.'
    for (const args of ['--', '--allowedTools Read Bash --', '--append-system-prompt -- --allowedTools Read', '-- hello', '--verbose "--"']) expect(extraArgsProblem(args)).toContain(refused)
    expect(extraArgsProblem(['--model', 'opus', '--'])).toContain('--option=--')
    for (const args of ['', '--append-system-prompt=--', '--allowedTools a b', '--add-dir "../my -- lib"', '---', '--x']) expect(extraArgsProblem(args)).toBeNull()
  })
})

describe('ConversationParser', () => {
  const lines = [
    line({ type: 'user', timestamp: 't0', message: { role: 'user', content: 'Fix the zebra test' } }),
    line({ type: 'assistant', timestamp: 't1', message: { model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: '' }] } }),
    line({ type: 'assistant', timestamp: 't1', message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }] } }),
    line({ type: 'assistant', isSidechain: true, timestamp: 't1', message: { content: [{ type: 'text', text: 'subagent chatter' }] } }),
    line({ type: 'user', timestamp: 't2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'zebra failed', is_error: true }] } }),
    line({ type: 'assistant', timestamp: 't3', message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'b', name: 'mcp__combwork__cw_notify', input: { message: 'done' } }] } }),
    line({ type: 'user', timestamp: 't4', message: { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] } }),
    line({ type: 'user', isMeta: true, timestamp: 't4', message: { role: 'user', content: [{ type: 'text', text: '[Image: source: C:\\p\\.combwork\\images\\x.png]' }] } }),
    line({ type: 'user', isMeta: true, timestamp: 't4', message: { role: 'user', content: '<local-command-caveat>ignore</local-command-caveat>' } }),
    line({ type: 'system', subtype: 'compact_boundary', timestamp: 't5', compactMetadata: { trigger: 'manual', preTokens: 100000, postTokens: 5000 } }),
    line({ type: 'user', isCompactSummary: true, timestamp: 't5', message: { role: 'user', content: 'Summary: zebra fixed' } }),
    line({ type: 'user', timestamp: 't5', message: { role: 'user', content: '<command-name>/compact</command-name>\n<command-args>keep notes</command-args>' } }),
    line({ type: 'user', timestamp: 't5', message: { role: 'user', content: '<local-command-stdout>\u001b[2mCompacted\u001b[22m</local-command-stdout>' } }),
    line({ type: 'assistant', timestamp: 't6', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'All good.' }], usage: { input_tokens: 1, cache_read_input_tokens: 40000, cache_creation_input_tokens: 99 } } }),
    line({ type: 'user', timestamp: 't7', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } })
  ]
  const text = lines.join('\n') + '\n'

  it('turns entries into messages, tool calls, commands and compactions', async () => {
    const { ConversationParser } = await import('../src/main/providers/claude/conversation')
    const p = new ConversationParser('C:\\p')
    p.feed(Buffer.from(text))
    expect(p.items.map((i) => i.kind)).toEqual(['user', 'tool', 'tool', 'user', 'compaction', 'command', 'assistant', 'notice'])
    const [, bash, mcp, user, compaction, command] = p.items as any[]
    expect(bash.tool).toMatchObject({ name: 'Bash', summary: 'Run tests', input: 'npm test', result: 'zebra failed', isError: true })
    expect(mcp.tool).toMatchObject({ name: 'combwork · cw_notify', summary: 'done', result: null })
    expect(user.images).toEqual([{ id: 0, path: 'C:\\p\\.combwork\\images\\x.png' }])
    expect(compaction).toMatchObject({ trigger: 'manual', preTokens: 100000, postTokens: 5000, nextRequestTokens: 40100, summary: 'Summary: zebra fixed' })
    expect(command).toMatchObject({ name: '/compact', args: 'keep notes', output: 'Compacted' })
    expect(p.items.at(-1)).toMatchObject({ kind: 'notice', text: 'Interrupted by you' })
    expect(p.images[0].path).toEqual([1])
  })

  it('reads appended bytes and leaves a partial last line for later', async () => {
    const { ConversationParser } = await import('../src/main/providers/claude/conversation')
    const whole = new ConversationParser()
    whole.feed(Buffer.from(text))
    const parts = new ConversationParser()
    const buf = Buffer.from(text)
    const cut = buf.indexOf('zebra failed') // in the middle of a line
    expect(parts.feed(buf.subarray(0, cut))).toBeLessThan(cut)
    parts.feed(buf.subarray(parts.offset))
    expect(parts.offset).toBe(buf.length)
    expect(parts.items).toEqual(whole.items)
    expect(parts.images).toEqual(whole.images)
  })

  it('searches every kind of item and exports Markdown', async () => {
    const { ConversationParser } = await import('../src/main/providers/claude/conversation')
    const { searchItems, transcriptMarkdown } = await import('../src/main/providers/conversation')
    const p = new ConversationParser()
    p.feed(Buffer.from(text))
    const { hits, more } = searchItems(p.items, 'ZEBRA')
    expect(hits.map((h) => h.kind)).toEqual(['user', 'tool', 'compaction'])
    expect(more).toBe(false)
    expect(searchItems(p.items, 'zebra', 1)).toMatchObject({ more: true })
    expect(searchItems(p.items, '  ').hits).toEqual([])
    const md = transcriptMarkdown(p.items, 'Zebra', 'sub')
    expect(md).toContain('# Zebra')
    expect(md).toContain('<summary>Bash: Run tests</summary>')
    expect(md).toContain('**Error:**')
    expect(md).toContain('**Conversation compacted** (manual)')
    expect(md).toContain('> `/compact keep notes`')
    // A time it can't read is left out; one it can is in the user's date and time format.
    expect(md).toContain('## You\n')
    const { setDateStyle } = await import('../src/shared/dates')
    const dated = new ConversationParser()
    dated.feed(Buffer.from(line({ type: 'user', timestamp: '2026-10-04T12:05:00.000Z', message: { role: 'user', content: 'hi' } }) + '\n'))
    expect(transcriptMarkdown(dated.items, 'T', 'sub')).toMatch(/## You · \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n/)
    setDateStyle({ date: 'dmy', time: '12h' })
    try {
      expect(transcriptMarkdown(dated.items, 'T', 'sub')).toMatch(/## You · \d{2}\/\d{2}\/\d{4} \d{1,2}:\d{2} (AM|PM)\n/)
    } finally {
      setDateStyle(undefined)
    }
  })
})

describe('toolSummary', () => {
  it('describes common tools in one line', async () => {
    const { toolSummary } = await import('../src/main/providers/claude/conversation')
    expect(toolSummary('Read', { file_path: 'D:\\proj\\src\\a.ts' }, 'D:\\proj')).toBe('src/a.ts')
    expect(toolSummary('Read', { file_path: 'E:\\other\\a.ts' }, 'D:\\proj')).toBe('E:\\other\\a.ts')
    expect(toolSummary('Grep', { pattern: 'foo', path: 'D:\\proj\\src' }, 'D:\\proj')).toBe('foo in src')
    expect(toolSummary('Bash', { command: 'git status\ngit log' })).toBe('git status')
    expect(toolSummary('Agent', { description: 'Find usages', prompt: 'long' })).toBe('Find usages')
  })
})

describe('model choices', () => {
  it('knows older models, with or without the 1M suffix', async () => {
    const { isOlderModel, baseModel } = await import('../src/shared/claude')
    expect(baseModel('opus[1m]')).toBe('opus')
    expect(baseModel('claude-opus-4-6')).toBe('claude-opus-4-6')
    expect(isOlderModel('claude-opus-4-8[1m]')).toBe(true)
    expect(isOlderModel('claude-opus-5-5')).toBe(false)
  })
  it('labels effort from the session, the project or the default', async () => {
    const { effortLabel } = await import('../src/shared/defaults')
    expect(effortLabel('claude-code', 'xhigh', 'low', '')).toBe('Extra high')
    expect(effortLabel('claude-code', undefined, 'low', 'high')).toBe('Low')
    expect(effortLabel('claude-code', undefined, 'inherit', 'high')).toBe('High')
    expect(effortLabel('claude-code', undefined, 'inherit', '')).toBeNull()
  })
})

describe('plan usage', () => {
  it('reads rate limits from the status line payload', async () => {
    const { parseClaudePlanUsage: parsePlanUsage } = await import('../src/main/providers/claude/adapter')
    const now = new Date('2026-09-29T10:00:00Z')
    const u = parsePlanUsage({ rate_limits: { five_hour: { used_percentage: 34.4, resets_at: 1790000000 }, seven_day: { used_percentage: 12 } } }, now)
    expect(u).toEqual({
      provider: 'claude-code',
      plan: null,
      limits: [
        { id: 'five_hour', label: '5-hour', windowMinutes: 300, usedPercent: 34.4, resetsAt: new Date(1790000000 * 1000).toISOString() },
        { id: 'seven_day', label: 'weekly', windowMinutes: 10080, usedPercent: 12, resetsAt: null }
      ],
      updatedAt: now.toISOString()
    })
    expect(parsePlanUsage({ model: {} })).toBeNull()
    expect(parsePlanUsage({ rate_limits: { five_hour: { used_percentage: 'x' } } })).toBeNull()
  })
  it('warns once per level per reset period', async () => {
    const { nextWarning } = await import('../src/main/planUsage')
    const r = '2026-09-29T15:00:00.000Z'
    expect(nextWarning({ usedPercent: 50, resetsAt: r }, undefined)).toBeNull()
    expect(nextWarning({ usedPercent: 81, resetsAt: r }, undefined)).toBe(80)
    expect(nextWarning({ usedPercent: 85, resetsAt: r }, { resetsAt: r, level: 80 })).toBeNull()
    expect(nextWarning({ usedPercent: 96, resetsAt: r }, { resetsAt: r, level: 80 })).toBe(95)
    expect(nextWarning({ usedPercent: 99, resetsAt: '2026-09-29T15:00:20.000Z' }, { resetsAt: r, level: 95 })).toBeNull()
    expect(nextWarning({ usedPercent: 82, resetsAt: '2026-09-29T20:00:00.000Z' }, { resetsAt: r, level: 95 })).toBe(80)
  })
})

describe('agents', () => {
  it('lists only the agents added, all equal, in the order added', async () => {
    const { projectAgents } = await import('../src/shared/defaults')
    expect(projectAgents({ agents: [] })).toEqual([])
    const list = projectAgents({ agents: [{ id: 'a-2', name: 'Reviewer' }, { id: 'a-1', name: 'Lead', worktree: { path: 'x', branch: 'b', base: 'main' } } as StoredAgent, null as never] })
    expect(list.map((a) => a.name)).toEqual(['Reviewer', 'Lead'])
    expect((list[1] as StoredAgent).worktree).toBeDefined()
  })

  it('gives every agent its own terminal key, and a layout that shows them all', async () => {
    const { agentPtyKey, layoutForAgents } = await import('../src/shared/defaults')
    expect(agentPtyKey('D:\\WS\\Demo', 'a-2')).toBe('session:d:\\ws\\demo#a-2')
    expect([1, 2, 3, 4].map(layoutForAgents)).toEqual(['single', 'columns2', 'columns3', 'grid'])
  })

  it('shows the most urgent state in the combined dot', async () => {
    const { mostUrgent } = await import('../src/shared/defaults')
    expect(mostUrgent([])).toBeNull()
    expect(mostUrgent([{ status: 'finished' }, { status: 'working' }, null])!.status).toBe('working')
    expect(mostUrgent([{ status: 'working' }, { status: 'waiting' }])!.status).toBe('waiting')
    // Something unseen on any agent keeps the dot glowing.
    const s = mostUrgent([{ status: 'working', unseen: false }, { status: 'finished', unseen: true }])!
    expect(s.status).toBe('working')
    expect(s.unseen).toBe(true)
  })

  it('slugifies names for branches and folders', async () => {
    const { slugify } = await import('../src/shared/defaults')
    expect(slugify('Agent 2')).toBe('agent-2')
    expect(slugify('  Code Review!! ')).toBe('code-review')
    expect(slugify('***')).toBe('agent')
  })

  it('matches worktree copy patterns', async () => {
    const { copyPatterns } = await import('../src/main/worktrees')
    const rx = copyPatterns('.env*\nconfig/local.json, secrets/**')
    const hit = (p: string): boolean => rx.some((r) => r.test(p))
    expect(hit('.env')).toBe(true)
    expect(hit('.env.local')).toBe(true)
    expect(hit('packages/api/.env')).toBe(true)
    expect(hit('config/local.json')).toBe(true)
    expect(hit('other/config/local.json')).toBe(false)
    expect(hit('secrets/a/b.key')).toBe(true)
    expect(hit('src/env.ts')).toBe(false)
    expect(copyPatterns(' , \n')).toEqual([])
  })

  it('places the worktrees folder next to the workspace', async () => {
    const { worktreesRoot } = await import('../src/main/worktrees')
    expect(worktreesRoot('D:\\Dev\\HIVE')).toBe(join('D:\\Dev', 'HIVE.worktrees'))
  })
})

describe('resumeRecord', () => {
  const P = 'D:\\ws\\proj'
  const WT = 'D:\\ws.worktrees\\proj\\agent-2'
  const rec = (id: string, at: string, extra: Record<string, unknown> = {}) => ({ id, lastActiveAt: at, archived: false, ...extra })
  const records = [
    rec('m1', '2026-09-01'),
    rec('m2', '2026-09-03'),
    rec('a3', '2026-09-04', { agentId: 'a3' }),
    rec('w1', '2026-09-05', { agentId: 'a2', cwd: WT }),
    rec('old', '2026-09-06', { archived: true })
  ]
  // m1 and m2 are 0.1 sessions (no agent recorded); a3 belongs to agent a3; w1 to a worktree agent.
  const agents = new Set(['a3', 'a4'])
  it("prefers the agent's last session, then its latest, then the latest no agent owns", async () => {
    const { resumeRecord } = await import('../src/shared/defaults')
    expect(resumeRecord(P, { id: 'a4', lastSessionId: 'm1' }, records, new Set(), agents)?.id).toBe('m1')
    expect(resumeRecord(P, { id: 'a3' }, records, new Set(), agents)?.id).toBe('a3')
    expect(resumeRecord(P, { id: 'a4' }, records, new Set(), agents)?.id).toBe('m2')
    // Another agent's session is not "unowned".
    expect(resumeRecord(P, { id: 'a4' }, records, new Set(['m1', 'm2']), agents)).toBeNull()
    // Once a3 is removed, its sessions are unowned too.
    expect(resumeRecord(P, { id: 'a4' }, records, new Set(), new Set(['a4']))?.id).toBe('a3')
  })
  it('skips sessions open in another agent, archived ones and other folders', async () => {
    const { resumeRecord } = await import('../src/shared/defaults')
    expect(resumeRecord(P, { id: 'a4', lastSessionId: 'm2' }, records, new Set(['m2']), agents)?.id).toBe('m1')
    expect(resumeRecord(P, { id: 'a4', lastSessionId: 'w1' }, records, new Set(['m1', 'm2']), agents)).toBeNull()
    expect(resumeRecord(P, { id: 'a2', worktree: { path: WT, branch: 'cw/agent-2', base: 'main' } } as StoredAgent, records, new Set(), agents)?.id).toBe('w1')
    expect(resumeRecord(P, { id: 'a4', lastSessionId: 'old' }, records, new Set(), agents)?.id).toBe('m2')
  })
})

describe('sessionLabel', () => {
  it("uses Claude Code's title while the name is still automatic", async () => {
    const { sessionLabel } = await import('../src/shared/defaults')
    expect(sessionLabel({ id: 'abc12345x', name: 'hive · 29/09/2026, 10:00:00', title: 'Fix the tray' }, 'hive')).toBe('Fix the tray')
    expect(sessionLabel({ id: 'abc12345x', name: 'hive · Agent 2 · 9/29/2026, 10:00 AM', title: 'Docs' }, 'hive')).toBe('Docs')
    expect(sessionLabel({ id: 'abc12345x', name: 'My refactor', title: 'Fix the tray' }, 'hive')).toBe('My refactor')
    expect(sessionLabel({ id: 'abc12345x' }, 'hive')).toBe('Session abc12345')
  })

  it('shows when it started, not the project and agent, until it has a name or title', async () => {
    const { sessionLabel } = await import('../src/shared/defaults')
    const { setDateStyle } = await import('../src/shared/dates')
    const today = new Date(2026, 9, 2, 14, 5).toISOString()
    const earlier = new Date(2026, 8, 29, 9, 30).toISOString()
    const auto = 'hive · Claudette · 02/10/2026, 14:05:00'
    // Combwork passes its automatic name to Claude Code (--name), which keeps it as the session's title.
    expect(sessionLabel({ id: 'abc12345x', name: auto, title: auto, customTitle: auto, startedAt: today }, 'hive')).toBe('2026-10-02 14:05')
    expect(sessionLabel({ id: 'abc12345x', name: auto, title: null, createdAt: earlier }, 'hive')).toBe('2026-09-29 09:30')
    expect(sessionLabel({ id: 'abc12345x', name: auto, usage: { firstActivity: earlier } }, 'hive')).toBe('2026-09-29 09:30')
    expect(sessionLabel({ id: 'abc12345x', name: auto, startedAt: 'not a date' }, 'hive')).toBe('Session abc12345')
    // In the user's format; a name they gave stays as it is.
    setDateStyle({ date: 'dmy', time: '12h' })
    try {
      expect(sessionLabel({ id: 'abc12345x', name: auto, startedAt: today }, 'hive')).toBe('02/10/2026 2:05 PM')
      expect(sessionLabel({ id: 'abc12345x', name: '2026-10-02 14:05', startedAt: today }, 'hive')).toBe('2026-10-02 14:05')
    } finally {
      setDateStyle(undefined)
    }
  })

  it('the latest rename wins, in Combwork or with /rename', async () => {
    const { sessionLabel, cliRename } = await import('../src/shared/defaults')
    const auto = 'hive · Claudette · 02/10/2026, 14:05:00'
    // /rename on a session Combwork named automatically.
    expect(sessionLabel({ id: 'a', name: auto, title: 'Tray fix', customTitle: 'Tray fix' }, 'hive')).toBe('Tray fix')
    // Renamed in Combwork while running: Claude Code still has Combwork's automatic name, which is no rename.
    expect(sessionLabel({ id: 'a', name: 'Docs pass', customTitle: auto, titleAtRename: auto }, 'hive')).toBe('Docs pass')
    // Then /rename: Claude Code's name changed since Combwork's rename, so it is the newer one.
    expect(sessionLabel({ id: 'a', name: 'Docs pass', customTitle: 'Guide only', titleAtRename: auto }, 'hive')).toBe('Guide only')
    expect(cliRename({ id: 'a', name: 'Docs pass', customTitle: 'Guide only', titleAtRename: auto }, 'hive')).toBe('Guide only')
    // Renamed in Combwork again: Claude Code's name is the one it had then, so Combwork's wins.
    expect(sessionLabel({ id: 'a', name: 'Final docs', customTitle: 'Guide only', titleAtRename: 'Guide only' }, 'hive')).toBe('Final docs')
    // Resumed with --name: Claude Code's name is Combwork's.
    expect(sessionLabel({ id: 'a', name: 'Final docs', customTitle: 'Final docs', titleAtRename: 'Guide only' }, 'hive')).toBe('Final docs')
    // Claude Code's name from a list item's usage.
    expect(sessionLabel({ id: 'a', name: 'Docs pass', titleAtRename: null, usage: { customTitle: 'Guide only' } }, 'hive')).toBe('Guide only')
    // Renamed in Combwork by an earlier version (no titleAtRename), or Claude Code's name not known: Combwork's stands.
    expect(sessionLabel({ id: 'a', name: 'Docs pass', customTitle: 'Guide only' }, 'hive')).toBe('Docs pass')
    expect(sessionLabel({ id: 'a', name: 'Docs pass', titleAtRename: auto }, 'hive')).toBe('Docs pass')
    expect(cliRename({ id: 'a', name: 'Docs pass', customTitle: auto, titleAtRename: null }, 'hive')).toBeNull()
  })
})

describe('permission modes in a running session', () => {
  it('reads the mode from Claude Code footer output', async () => {
    const { footerMode } = await import('../src/shared/claude')
    expect(footerMode(' ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents ')).toBe('acceptEdits')
    expect(footerMode('⏸ plan mode on (shift+tab o cycle) · ←foragents')).toBe('plan')
    expect(footerMode('x ⏵⏵ auto mode on (shift+tab to cycle) y ⏸ manual mode on · ← for agents')).toBe('manual')
    expect(footerMode("⏵⏵ don't ask on (shift+tab to cycle)")).toBe('dontAsk')
    expect(footerMode('⏵⏵ bypass permissions on (shift+tab to cycle)')).toBe('bypassPermissions')
    expect(footerMode('Claude said: turn plan mode on and then')).toBeNull()
    // Manual has no hint after it (Claude Code 2.1.286), only its symbol before.
    expect(footerMode(' ⏵⏵ auto mode on (shift+tab to cycle)   ⏸  manual mode on   ')).toBe('manual')
    expect(footerMode('⏸ manual mode on')).toBe('manual')
    expect(footerMode('⏸ manual mode on    ⏵⏵  accept edits  on (shift+tab to cycle)')).toBe('acceptEdits')
  })
  it('reads a footer redrawn in part (NO_COLOR) from the rendered screen, not the output stream', async () => {
    const { footerMode } = await import('../src/shared/claude')
    const { TerminalScreen } = await import('../src/main/terminalScreen')
    // Without colours Claude Code redraws only the characters that changed: "⏸ m", a cursor move over the
    // unchanged "a", then "nual mode on" and an erase to the end of the line (Claude Code 2.1.289).
    const first = '\x1b[2J\x1b[1;1H> fix the tests\r\n\x1b[30;1H⏵⏵ auto mode on (shift+tab to cycle)'
    const redraw = '\x1b[30;1H⏸ m\x1b[1Cnual mode on\x1b[K'
    // Read as a stream (control sequences as spaces), the partial redraw is lost.
    expect(footerMode((first + redraw).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' '))).toBe('auto')
    const screen = new TerminalScreen(80, 32)
    const parsed = (data: string) => new Promise<void>((r) => screen.write(data, r))
    await parsed(first)
    expect(footerMode(screen.text())).toBe('auto')
    await parsed(redraw)
    expect(screen.text().split('\n')[29]).toBe('⏸ manual mode on')
    expect(footerMode(screen.text())).toBe('manual')
    // And back: "⏵⏵ " over "⏸ m", the rest changed from "anual" on.
    await parsed('\x1b[30;1H⏵⏵ auto mode on (shift+tab to cycle)')
    expect(footerMode(screen.text())).toBe('auto')
    // One screen, no scrollback, whatever was printed; nothing after it's disposed.
    await parsed('line\r\n'.repeat(500))
    expect(screen.text().split('\n')).toHaveLength(32)
    screen.resize(100, 10)
    expect(screen.text().split('\n')).toHaveLength(10)
    screen.dispose()
    let called = false
    screen.write('more', () => (called = true))
    expect(screen.text()).toBe('')
    expect(called).toBe(false)
  })
  it('warns that Claude Code may not run Haiku in Auto', async () => {
    const { modeCaveat } = await import('../src/shared/providers')
    expect(modeCaveat('claude-code', 'auto', 'haiku')).toMatch(/may not offer Auto with Haiku/)
    expect(modeCaveat('claude-code', 'auto', 'claude-haiku-4-5-20251001')).not.toBeNull()
    expect(modeCaveat('claude-code', 'auto', 'sonnet')).toBeNull()
    expect(modeCaveat('claude-code', 'manual', 'haiku')).toBeNull()
    // No model known (the CLI's default): no warning.
    expect(modeCaveat('claude-code', 'auto', null)).toBeNull()
    expect(modeCaveat('codex', 'approve-for-me', 'gpt-5.5')).toBeNull()
  })
  it('maps hook modes and knows what Shift+Tab can reach', async () => {
    const { hookMode, canSwitchLive } = await import('../src/shared/claude')
    expect(hookMode('default')).toBe('manual')
    expect(hookMode('acceptEdits')).toBe('acceptEdits')
    expect(hookMode('nonsense')).toBeNull()
    expect(canSwitchLive('auto', 'manual', 'manual')).toBe(true)
    expect(canSwitchLive('dontAsk', 'manual', 'dontAsk')).toBe(false)
    expect(canSwitchLive('bypassPermissions', 'auto', 'manual')).toBe(false)
    expect(canSwitchLive('bypassPermissions', 'auto', 'bypassPermissions')).toBe(true)
  })
})

describe('keyboard shortcuts', () => {
  it('resolves project over global over default, and null removes', async () => {
    const { resolveKeybinding } = await import('../src/shared/defaults')
    expect(resolveKeybinding('a', 'Mod+A', undefined, undefined)).toBe('Mod+A')
    expect(resolveKeybinding('a', 'Mod+A', { a: 'Mod+B' }, undefined)).toBe('Mod+B')
    expect(resolveKeybinding('a', 'Mod+A', { a: 'Mod+B' }, { a: 'Alt+C' })).toBe('Alt+C')
    expect(resolveKeybinding('a', 'Mod+A', { a: null }, undefined)).toBeUndefined()
    expect(resolveKeybinding('a', 'Mod+A', { a: 'Mod+B' }, { a: null })).toBeUndefined()
  })
  it('refuses keys that would break typing or editing', async () => {
    const { keybindingProblem } = await import('../src/shared/defaults')
    expect(keybindingProblem('A')).not.toBeNull()
    expect(keybindingProblem('Shift+A')).not.toBeNull()
    expect(keybindingProblem('Mod+C')).not.toBeNull()
    expect(keybindingProblem('Shift+Tab')).not.toBeNull()
    expect(keybindingProblem('F5')).toBeNull()
    expect(keybindingProblem('Mod+Alt+M')).toBeNull()
    expect(keybindingProblem('Mod+K Mod+S')).toBeNull()
    expect(keybindingProblem('Mod+K S')).not.toBeNull()
  })
})

describe('writeJsonAtomic and withFileLock', () => {
  it('never leaves a corrupt file when writes overlap', async () => {
    const dir = tempDir('hive-test-')
    const file = join(dir, 'sessions.json')
    const big = { sessions: Array.from({ length: 400 }, (_, k) => ({ id: `a${k}` })) }
    for (let i = 0; i < 50; i++) {
      await Promise.all([writeJsonAtomic(file, big), writeJsonAtomic(file, { sessions: [{ id: 'b' }] })])
      const text = await readFile(file, 'utf8')
      expect(() => JSON.parse(text)).not.toThrow()
    }
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('keeps every change when read-modify-writes overlap', async () => {
    const dir = tempDir('hive-test-')
    const file = join(dir, 'list.json')
    await writeJsonAtomic(file, { ids: [] })
    const add = (id: number) =>
      withFileLock(file, async () => {
        const cur = JSON.parse(await readFile(file, 'utf8')) as { ids: number[] }
        await new Promise((r) => setTimeout(r, 2))
        cur.ids.push(id)
        await writeJsonAtomic(file, cur)
      })
    await Promise.all(Array.from({ length: 20 }, (_, i) => add(i)))
    expect((JSON.parse(await readFile(file, 'utf8')) as { ids: number[] }).ids.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i))
  })

  it('carries on after a failed change', async () => {
    const file = join(tempRoot(), 'hive-lock-fail.json')
    await expect(withFileLock(file, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(withFileLock(file, async () => 'next')).resolves.toBe('next')
  })
})

describe('session ids', () => {
  it('accepts Claude Code ids and refuses paths', () => {
    expect(isSessionId('3f2b1c9e-8a7d-4e6f-9b0a-1c2d3e4f5a6b')).toBe(true)
    expect(isSessionId('agent-abc_123')).toBe(true)
    for (const bad of ['../../x', '..\\x', 'a/b', 'a.b', '', 'x'.repeat(101), 42, undefined]) expect(isSessionId(bad)).toBe(false)
    expect(() => assertSessionId('../evil')).toThrow('Invalid session id')
  })
})

describe('claudeFileAllowed', () => {
  const home = join('C:\\', 'Users', 'u', '.claude')
  const at = (...p: string[]): string => join(home, ...p)
  it('allows instructions and memory, read-only skills', () => {
    expect(claudeFileAllowed(at('CLAUDE.md'), true, home)).toBe(true)
    expect(claudeFileAllowed(at('projects', 'D--x', 'memory', 'MEMORY.md'), true, home)).toBe(true)
    expect(claudeFileAllowed(at('skills', 'pdf', 'SKILL.md'), false, home)).toBe(true)
    expect(claudeFileAllowed(at('skills', 'pdf', 'SKILL.md'), true, home)).toBe(false)
    expect(claudeFileAllowed(at('plugins', 'cache', 'p', 'skills', 's', 'SKILL.md'), false, home)).toBe(true)
  })
  it('refuses credentials, settings and anything outside', () => {
    expect(claudeFileAllowed(at('.credentials.json'), false, home)).toBe(false)
    expect(claudeFileAllowed(at('settings.json'), false, home)).toBe(false)
    expect(claudeFileAllowed(at('projects', 'D--x', 'abc.jsonl'), false, home)).toBe(false)
    expect(claudeFileAllowed(at('projects', 'D--x', 'notes.md'), true, home)).toBe(false)
    expect(claudeFileAllowed(`${home}/../secret.md`, false, home)).toBe(false)
    expect(claudeFileAllowed(home, false, home)).toBe(false)
  })
})
