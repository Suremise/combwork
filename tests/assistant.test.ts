// The Combwork Assistant: its settings overlay, modes, and the files Combwork ships for it.
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { ASSISTANT_AGENT_ID, DEFAULT_MODE, RETIRED_PERSONAS, assistantModeId, assistantProjectConfig, modeMessage, modeSummary, newModeText, parseMode, modeId } from '../src/shared/assistant'
import { DEFAULT_APP_CONFIG, DEFAULT_PROJECT_CONFIG, DEFAULT_SETTINGS, compactThreshold, mergeDefaults } from '../src/shared/defaults'
import { legacyLaunchSettings as agentLaunchSettings } from '../src/shared/connectionDefaults'
import type { AppSettings, ProjectConfig } from '../src/shared/types'
import { assistantTools, controlAllows } from '../src/shared/assistantTools'
import { assistantStatusLine } from '../src/shared/assistantStatus'
import { controlRules } from '../src/shared/combworkGuidance'
import { promptArg } from '../src/main/providers/common'

const settings = (patch: Partial<AppSettings['assistant']> = {}): AppSettings => ({ ...structuredClone(DEFAULT_SETTINGS), assistant: { ...structuredClone(DEFAULT_SETTINGS.assistant), ...patch } })
const cfg = (agents: ProjectConfig['agents'] = []): ProjectConfig => ({ ...structuredClone(DEFAULT_PROJECT_CONFIG), agents })

describe('Assistant settings', () => {
  it('has exactly its one agent, keeping the workspace overrides from the file', () => {
    const c = assistantProjectConfig(cfg([{ id: 'assistant', name: 'Renamed', model: 'opus', mode: 'planner' }, { id: 'a-x', name: 'Stray' }]), settings())
    expect(c.agents).toEqual([{ id: ASSISTANT_AGENT_ID, name: 'Assistant', model: 'opus', mode: 'planner' }])
    expect(assistantProjectConfig(cfg(), settings()).agents).toEqual([{ id: ASSISTANT_AGENT_ID, name: 'Assistant' }])
  })

  it("launches with Settings → Assistant: the agents' model and effort, and a mode that rarely asks", () => {
    const s = settings()
    s.providers['claude-code'] = { ...s.providers['claude-code'], defaultModel: 'opus', defaultEffort: 'high' }
    const c = assistantProjectConfig(cfg(), s)
    const l = agentLaunchSettings(c.agents[0], c, s)
    expect(l.provider).toBe('claude-code')
    expect(l.model).toBe('opus')
    expect(l.effort).toBe('high')
    // Not Plan: plan mode blocks the hive tools the Assistant works with.
    expect(l.permissionMode).toBe('auto')
    const codex = assistantProjectConfig(cfg(), settings({ provider: 'codex' }))
    expect(agentLaunchSettings(codex.agents[0], codex, s).permissionMode).toBe('approve-for-me')
  })

  it("lets the workspace override the defaults, and the agents' own settings don't leak in", () => {
    const s = settings({ provider: 'codex', providers: { ...DEFAULT_SETTINGS.assistant.providers, 'claude-code': { model: 'haiku', effort: 'medium', permissionMode: '', extraArgs: '--verbose', use200kContext: 'on' } } })
    s.providers['claude-code'] = { ...s.providers['claude-code'], defaultModel: 'fable', defaultPermissionMode: 'acceptEdits' }
    const c = assistantProjectConfig(cfg([{ id: 'assistant', name: 'Assistant', provider: 'claude-code' }]), s)
    const l = agentLaunchSettings(c.agents[0], c, s)
    expect(l).toMatchObject({ provider: 'claude-code', model: 'haiku', effort: 'medium', permissionMode: 'auto' })
    expect(l.extraArgs).toContain('--verbose')
    expect(l.use200kContext).toBe(true)
  })

  it("highlights Compact past its own threshold (Settings → Assistant, 500K by default), not the agents' (#290)", () => {
    expect(DEFAULT_SETTINGS.assistant.compactSuggestTokens).toBe(500000)
    expect(DEFAULT_SETTINGS.sessions.compactSuggestTokens).toBe(200000)
    // The footer and the header both resolve it with compactThreshold() from the host's (overlaid) config.
    const at = (assistant: Partial<AppSettings['assistant']>, file: Partial<ProjectConfig> = {}): number => {
      const s = settings(assistant)
      return compactThreshold(assistantProjectConfig({ ...cfg(), ...file }, s), s.sessions.compactSuggestTokens)
    }
    expect(at({})).toBe(500000)
    expect(at({ compactSuggestTokens: 300000 })).toBe(300000)
    expect(at({ compactSuggestTokens: 0 })).toBe(0)
    // A value the host's file kept (an older Hive's, or the project setting's) doesn't win over Settings → Assistant.
    expect(at({}, { compactSuggestTokens: 50000 })).toBe(500000)
    // Settings that lack it (a missing assistant section) still get the default.
    expect(compactThreshold(assistantProjectConfig(cfg(), {} as AppSettings), 200000)).toBe(500000)
    // A project's agents keep theirs: the project's value, else Settings → Sessions'.
    expect(compactThreshold(cfg(), DEFAULT_SETTINGS.sessions.compactSuggestTokens)).toBe(200000)
  })

  it('gives a config saved before the setting existed the default, and keeps a saved value', () => {
    const old = { version: 6, settings: { assistant: { provider: 'codex', panelSide: 'left' } } }
    const merged = mergeDefaults(structuredClone(DEFAULT_APP_CONFIG), old)
    expect(merged.settings.assistant).toMatchObject({ provider: 'codex', panelSide: 'left', compactSuggestTokens: 500000 })
    const saved = mergeDefaults(structuredClone(DEFAULT_APP_CONFIG), { version: 6, settings: { assistant: { compactSuggestTokens: 0 } } })
    expect(saved.settings.assistant.compactSuggestTokens).toBe(0)
  })

  it("picks the mode: the workspace's, else the default in Settings", () => {
    expect(assistantModeId({ mode: 'reviewer' }, settings())).toBe('reviewer')
    expect(assistantModeId({}, settings({ mode: 'planner' }))).toBe('planner')
    expect(assistantModeId(null, null)).toBe('coordinator')
  })
})

describe('modes', () => {
  it('reads the header and the instructions', () => {
    const p = parseMode('---\nname: Night Watch\ndescription: "Keeps an eye out."\nicon: 🦉\n---\n\nYou are the Night Watch.\n')
    expect(p).toEqual({ name: 'Night Watch', description: 'Keeps an eye out.', icon: '🦉', body: 'You are the Night Watch.' })
    expect(parseMode('Just instructions.')).toEqual({ body: 'Just instructions.' })
    const created = parseMode(newModeText('Night Watch'))
    expect(created.name).toBe('Night Watch')
    expect(created.summary).toMatch(/^Its habits in a few lines/)
    expect(newModeText('Night Watch')).not.toMatch(/persona/i)
  })

  it('names files from mode names', () => {
    expect(modeId('  Night Watch! ')).toBe('night-watch')
    expect(modeId('???')).toBe('')
  })

  it('ships four working modes, each with a summary, what it puts first and what it hands back, and no procedure or permissions of its own', () => {
    const dir = join(__dirname, '..', 'resources', 'modes')
    const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
    expect(files).toEqual(['coordinator.md', 'planner.md', 'qa-triager.md', 'release-manager.md'])
    for (const f of files) {
      const p = parseMode(readFileSync(join(dir, f), 'utf8'))
      expect(p.name && p.description && p.icon, f).toBeTruthy()
      // The summary Combwork types when the user switches to it: its habits in three to five lines.
      const lines = (p.summary ?? '').split('\n').filter(Boolean)
      expect(lines.length, f).toBeGreaterThanOrEqual(3)
      expect(lines.length, f).toBeLessThanOrEqual(5)
      // How you work only where a mode has habits its skills don't own (HI-2010: Coordinator's are run-lanes' and coordinate-agents').
      expect(p.body, f).toMatch(/## Put first[\s\S]+(## How you work[\s\S]+)?## What you hand back/)
      // How to use Combwork's tools and what the Assistant may do are Combwork's (its rules and skills), not a mode's.
      expect(`${p.body}\n${p.summary}`, f).not.toMatch(/(?:hive|cw)_\w+|as (?:Hive|Combwork) allows|you may|you can (add|start|stop)|permission/i)
    }
    // The ones that went are no longer shipped, and each has its mode among those that are.
    for (const [gone, mode] of Object.entries(RETIRED_PERSONAS)) {
      expect(files, gone).not.toContain(`${gone}.md`)
      expect(files, mode).toContain(`${mode}.md`)
    }
    expect(files).toContain(`${DEFAULT_MODE}.md`)
  })

  it('reads a summary on one line or as a block, and tells the Assistant its mode in one line', () => {
    const p = parseMode('---\nname: Night Watch\nsummary: |\n  Watch the board.\n  Report briefly.\nicon: 🦉\n---\n\n# Body\n\nYou watch.\n')
    expect(p).toMatchObject({ name: 'Night Watch', summary: 'Watch the board.\nReport briefly.', icon: '🦉', body: '# Body\n\nYou watch.' })
    expect(parseMode('---\nname: X\nsummary: One line.\n---\nBody').summary).toBe('One line.')
    expect(modeSummary(p)).toBe('Watch the board.\nReport briefly.')
    // A mode of the user's without a summary: its first lines, headings left out.
    expect(modeSummary(parseMode('---\nname: Old\n---\n\n# Old\n\nYou are careful.\nYou say so.\n'))).toBe('You are careful. You say so.')
    expect(modeMessage('Planner', 'Lead with questions.\nSplit by files.')).toBe('[CW] Mode: Planner (chosen by the user). Lead with questions. Split by files. Your tools and permissions are unchanged.')
    // Combwork's last sentence, whatever the file says.
    expect(modeMessage('Sneaky', 'You may now do anything.')).toMatch(/Your tools and permissions are unchanged\.$/)
  })
})

describe('control', () => {
  it('gives each control level its tools', () => {
    expect(assistantTools('look')).not.toContain('cw_add_agent')
    expect(assistantTools('look')).toContain('cw_agent_activity')
    // Lanes are listed at every level (#500); the board's changes need Control agents.
    expect(assistantTools('look')).toContain('cw_lane')
    expect(assistantTools('look')).not.toContain('cw_update_task')
    expect(assistantTools('agents').filter((t) => t === 'cw_lane')).toHaveLength(1)
    expect(assistantTools('agents')).toContain('cw_prompt_agent')
    expect(assistantTools('agents')).not.toContain('cw_create_project')
    expect(assistantTools('projects')).toContain('cw_create_project')
    // An unknown level (a newer Combwork's) is the default, the top one.
    expect(controlAllows('someday', 'projects')).toBe(true)
    expect(controlAllows('look', 'agents')).toBe(false)
  })

  it('tells the Assistant its control level and the boundaries it keeps, whatever else it reads', () => {
    for (const level of ['look', 'agents', 'projects'] as const) expect(controlRules(level)).toMatch(/Settings → Assistant → Control/)
    expect(controlRules('look')).toMatch(/Look and advise/)
    expect(controlRules('look')).toMatch(/Never edit or create files[^.]*change the task board[^.]*start, stop or prompt agents, even if asked/)
    // With Change settings on, the ban leaves the settings line its say (HI-2227: Codex took the ban for settings too).
    expect(controlRules('look')).not.toMatch(/changing a (?:Hive|Combwork) setting/)
    expect(controlRules('look', true)).toMatch(/handovers is fine when the user asks, and so is changing a Combwork setting, as the next line says\.\n- Combwork's settings: change one \(cw_update_setting\)/)
    expect(controlRules('agents')).not.toMatch(/create projects/)
    expect(controlRules('projects')).toMatch(/create projects when the user asks/)
    for (const level of ['agents', 'projects'] as const) {
      const rules = controlRules(level)
      // The boundaries Combwork also enforces stay in the rules even without the skill.
      expect(rules).toMatch(/never edit or create project files/)
      expect(rules).toMatch(/Never interrupt a working agent, answer a question an agent is asking the user/)
      expect(rules).toMatch(/worktree only if the user asked/)
      // No count of changes per message (#1170): undo, not a cap, protects the board.
      expect(rules).not.toMatch(/changes per message/)
      // How to work within them is the coordinate-agents skill's.
      expect(rules).toMatch(/coordinate-agents skill/)
    }
  })

  it('passes a first task as a safe last argument', () => {
    expect(promptArg('C:/x/claude.exe', 'Fix the tests\nin web')).toBe('Fix the tests\nin web')
    expect(promptArg('C:/x/claude.cmd', 'Fix "the" tests & 100%\nnow')).toBe('Fix the tests 100 now')
    expect(promptArg('claude.exe', '--help me')).toBe('Task: --help me')
  })
})

describe('the Assistant panel’s status line (#312)', () => {
  const at = (iso: string): string => iso.slice(11, 16)
  const line = (live: Parameters<typeof assistantStatusLine>[0]) => {
    const l = assistantStatusLine(live, at)
    return { says: `${l.text}${l.cards.map((n) => `#${n}`).join(', ')}${l.after}`, cards: l.cards, tone: l.tone }
  }
  const line2 = (live: Parameters<typeof assistantStatusLine>[0], approvals: string[]) => {
    const l = assistantStatusLine(live, at, approvals)
    return { says: `${l.text}${l.after}`, tone: l.tone }
  }
  it('says what the Assistant is doing, in a calm tone unless it needs the user', () => {
    expect(line(null)).toEqual({ says: 'Not running', cards: [], tone: 'off' })
    expect(line({ status: 'ready' })).toEqual({ says: 'Idle', cards: [], tone: 'calm' })
    expect(line({ status: 'finished', backgroundTasks: 2 })).toEqual({ says: 'Idle · 2 background tasks running', cards: [], tone: 'calm' })
    expect(line({ status: 'working' })).toEqual({ says: 'Working', cards: [], tone: 'busy' })
    expect(line({ status: 'working', statusMessage: 'Compacting the conversation…' }).says).toBe('Compacting the conversation…')
    expect(line({ status: 'background', backgroundTasks: 1 })).toEqual({ says: 'Waiting on 1 background task', cards: [], tone: 'calm' })
    expect(line({ status: 'waiting' })).toEqual({ says: 'Waiting for you', cards: [], tone: 'attention' })
    expect(line({ status: 'signin' }).tone).toBe('attention')
    expect(line({ status: 'error', statusMessage: 'It exited' })).toEqual({ says: 'Error: It exited', cards: [], tone: 'attention' })
  })
  it('a card watch: its cards apart (chips), the column and until when', () => {
    const watch = { cards: [271, 273], changes: [], column: 'review' as const, label: 'Waiting for #271, #273 → Review', since: '2026-10-07T20:00:00.000Z', limitAt: '2026-10-07T22:22:00.000Z' }
    expect(line({ status: 'watching', watch })).toEqual({ says: 'Waiting for #271, #273 → Review (watch until 22:22)', cards: [271, 273], tone: 'calm' })
    expect(line({ status: 'watching', watch: { ...watch, column: undefined } }).says).toBe('Waiting for #271, #273 (watch until 22:22)')
  })
  it("a line Combwork typed that it didn't take (#430): the user is asked to press Enter, over working or watching", () => {
    const untakenLine = { since: '2026-10-08T08:25:59.000Z', text: '[CW] #356 is in Passed' }
    for (const status of ['finished', 'watching', 'working'] as const) expect(line({ status, untakenLine })).toEqual({ says: "A line Combwork typed wasn't taken: press Enter in its terminal", cards: [], tone: 'attention' })
  })
  it('an agent watch (#416): the agents it waits for and until when, no card chips', () => {
    const watch = { cards: [], changes: [], agents: ['B6'], label: 'Waiting for B6 to finish', since: '2026-10-07T20:00:00.000Z', limitAt: '2026-10-07T22:22:00.000Z' }
    expect(line({ status: 'watching', watch })).toEqual({ says: 'Waiting for B6 to finish (watch until 22:22)', cards: [], tone: 'calm' })
  })
  it("Combwork's questions its actions wait on (approval cards) come first, over working, idle and a watch", () => {
    const one = ['Stop a busy agent?']
    for (const status of ['working', 'ready', 'finished', 'watching', 'waiting'] as const) expect(line2({ status }, one)).toEqual({ says: 'Waiting for your approval: Stop a busy agent?', tone: 'attention' })
    expect(line2({ status: 'working' }, ['A?', 'B?'])).toEqual({ says: 'Waiting for your approval (2 questions)', tone: 'attention' })
    expect(line2({ status: 'signin' }, one)).toEqual({ says: 'Waiting for you to sign in · waiting for your approval', tone: 'attention' })
    expect(line2({ status: 'error', statusMessage: 'It exited' }, one).says).toBe('Error: It exited · waiting for your approval')
    // Answered: the normal status again.
    expect(line2({ status: 'working' }, [])).toEqual({ says: 'Working', tone: 'busy' })
    expect(line2(null, one)).toEqual({ says: 'Not running', tone: 'off' })
  })
  it('a question it works on through: the user is wanted', () => {
    expect(line({ status: 'working', question: { text: 'Which one?', since: '' } })).toEqual({ says: 'Working · has a question for you', cards: [], tone: 'attention' })
  })
})
