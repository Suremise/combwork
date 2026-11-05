// HI-2587: the names upgrade's steps in the profile, at start (nameUpgradeProfile.ts, logger.ts moveOldLogs). The run
// marker of a 1.0 or RC run names its version under `hive`: renamed `app` before it is read, its other fields as they
// were; one already new, or not JSON, is left. The log's files: hive.log and hive.1.log take the new names while those
// are free; one whose new name is taken stays where it is, byte for byte; a fresh profile has nothing to do.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
import { upgradedAdvanced, upgradedConfig, upgradedRunMarker, upgradedRuns, upgradeProfileFiles, upgradeRunMarkerFile } from '../src/main/nameUpgradeProfile'
import { parseRunMarker } from '../src/shared/unexpectedClose'
import { moveOldLogs } from '../src/main/logger'

const base = tempDir('nameupgrade-profile-')
let n = 0
const MARKER = { version: 1, pid: 42, startedAt: '2026-10-17T01:00:00.000Z', lastSeen: '2026-10-17T03:02:56.000Z', hive: '1.1.0-rc.2', workspaces: ['D:/ws'], agents: [] }

describe('the run marker', () => {
  it("a 1.0 or RC marker's version is renamed app, read as before", () => {
    const now = upgradedRunMarker(JSON.stringify(MARKER))!
    expect(JSON.parse(now)).toEqual({ ...Object.fromEntries(Object.entries(MARKER).filter(([k]) => k !== 'hive')), app: '1.1.0-rc.2' })
    expect(parseRunMarker(now)?.app).toBe('1.1.0-rc.2')
    expect(upgradedRunMarker(now)).toBeNull()
    expect(upgradedRunMarker('not json')).toBeNull()
  })

  it('the file is rewritten in place once; a missing one is nothing', () => {
    const file = join(base, `running${++n}.json`)
    writeFileSync(file, JSON.stringify(MARKER))
    upgradeRunMarkerFile(file)
    expect(JSON.parse(readFileSync(file, 'utf8')).app).toBe('1.1.0-rc.2')
    upgradeRunMarkerFile(join(base, 'none.json'))
    expect(existsSync(join(base, 'none.json'))).toBe(false)
  })
})

describe("the log's files", () => {
  it('take the new names while they are free', () => {
    const dir = join(base, `logs${++n}`)
    mkdirSync(dir)
    writeFileSync(join(dir, 'hive.log'), 'now')
    writeFileSync(join(dir, 'hive.1.log'), 'before')
    moveOldLogs(dir)
    expect(readdirSync(dir).sort()).toEqual(['combwork.1.log', 'combwork.log'])
    expect(readFileSync(join(dir, 'combwork.log'), 'utf8')).toBe('now')
    expect(readFileSync(join(dir, 'combwork.1.log'), 'utf8')).toBe('before')
  })

  it("one whose new name is taken stays where it is, byte for byte; a fresh folder has nothing", () => {
    const dir = join(base, `logs${++n}`)
    mkdirSync(dir)
    writeFileSync(join(dir, 'hive.log'), 'old')
    writeFileSync(join(dir, 'combwork.log'), 'new')
    moveOldLogs(dir)
    expect(readFileSync(join(dir, 'hive.log'), 'utf8')).toBe('old')
    expect(readFileSync(join(dir, 'combwork.log'), 'utf8')).toBe('new')
    const fresh = join(base, `logs${++n}`)
    mkdirSync(fresh)
    moveOldLogs(fresh)
    expect(readdirSync(fresh)).toEqual([])
  })
})

// HI-2598 (design HI-2598/s9 §5): the profile's stored values. A 1.0 profile has every one old, an RC2 one some, a fresh one
// none; each file is rewritten only while it has one, so a second start only reads.
describe("the profile's stored values", () => {
  const CONFIG_10 = {
    version: 9,
    settings: {
      workflow: { git: { finish: 'hiveMerges', commitMessage: 'hive', review: 'agent' }, none: { maxAgents: 3 } },
      commands: { list: [{ id: 'c1', name: 'Tidy', command: 'x' }], onQuit: { run: [{ scope: 'hive', id: 'c1' }] } },
      agentApi: { enabled: true, provideHiveMcp: false }
    }
  }
  const ADVANCED_10 = { format: 1, values: { 'hive.processes.orphanNotice': false, 'hive.accounts.preview': true, 'claude-code.override.preApproveHiveTools': false, 'hive.agents.perProject': 4, 'hive.assistant.otherMcpServers': true }, madeFor: { 'claude-code.override.preApproveHiveTools': { version: '2.1.0', value: false } } }
  const RUNS_10 = { version: 1, runs: [{ id: 'r1', source: 'hive', agentName: 'Hive (merge queue)', title: 't' }, { id: 'r2', source: 'hive', agentName: 'Hive (slot slot-b)', title: 't' }, { id: 'r3', source: 'agent', agentName: 'HB2', title: 't' }] }

  it('config.json: workflow defaults, When Combwork quits and the Agent API switch take the new values', () => {
    const now = upgradedConfig(CONFIG_10) as typeof CONFIG_10 & { settings: { agentApi: Record<string, unknown> } }
    expect(now.settings.workflow).toEqual({ git: { finish: 'combworkMerges', commitMessage: 'combwork', review: 'agent' }, none: { maxAgents: 3 } })
    expect(now.settings.commands.onQuit.run).toEqual([{ scope: 'combwork', id: 'c1' }])
    expect(now.settings.agentApi).toEqual({ enabled: true, provideCombworkMcp: false })
    expect(upgradedConfig(now)).toBeNull()
    // RC2: a new key already there wins, and the old is dropped.
    expect((upgradedConfig({ settings: { agentApi: { provideHiveMcp: false, provideCombworkMcp: true } } }) as any).settings.agentApi).toEqual({ provideCombworkMcp: true })
    expect(upgradedConfig({ settings: { workflow: { git: { finish: 'combworkMerges' } } } })).toBeNull()
  })

  it("advanced.json: hive.* and the CLIs' pre-approve ids renamed, the retired switch dropped, a new id kept over its old one", () => {
    const now = upgradedAdvanced(ADVANCED_10) as { values: Record<string, unknown>; madeFor: Record<string, unknown> }
    expect(now.values).toEqual({ 'cw.processes.orphanNotice': false, 'claude-code.override.preApproveCombworkTools': false, 'cw.agents.perProject': 4, 'cw.assistant.otherMcpServers': true })
    expect(now.madeFor).toEqual({ 'claude-code.override.preApproveCombworkTools': { version: '2.1.0', value: false } })
    expect(upgradedAdvanced(now)).toBeNull()
    expect((upgradedAdvanced({ values: { 'hive.processes.orphanNotice': false, 'cw.processes.orphanNotice': true } }) as any).values).toEqual({ 'cw.processes.orphanNotice': true })
  })

  it("progress runs: Combwork's own take its source and names; an agent's stay", () => {
    const now = upgradedRuns(RUNS_10) as typeof RUNS_10
    expect(now.runs.map((r) => [r.source, r.agentName])).toEqual([['combwork', 'Combwork (merge queue)'], ['combwork', 'Combwork (slot slot-b)'], ['agent', 'HB2']])
    expect(upgradedRuns(now)).toBeNull()
  })

  it('the files are rewritten once at start; a fresh profile and files not JSON are left as they are', () => {
    const dir = join(base, `profile${++n}`)
    mkdirSync(join(dir, 'progress-history'), { recursive: true })
    writeFileSync(join(dir, 'config.json'), JSON.stringify(CONFIG_10))
    writeFileSync(join(dir, 'advanced.json'), JSON.stringify(ADVANCED_10))
    writeFileSync(join(dir, 'progress-history', 'abc.json'), JSON.stringify(RUNS_10))
    writeFileSync(join(dir, 'progress-history', 'bad.json'), 'not json')
    upgradeProfileFiles(dir)
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).settings.agentApi.provideCombworkMcp).toBe(false)
    expect(Object.keys(JSON.parse(readFileSync(join(dir, 'advanced.json'), 'utf8')).values)).not.toContain('hive.processes.orphanNotice')
    expect(JSON.parse(readFileSync(join(dir, 'progress-history', 'abc.json'), 'utf8')).runs[0].source).toBe('combwork')
    expect(readFileSync(join(dir, 'progress-history', 'bad.json'), 'utf8')).toBe('not json')
    const texts = ['config.json', 'advanced.json', join('progress-history', 'abc.json')].map((f) => readFileSync(join(dir, f), 'utf8'))
    upgradeProfileFiles(dir)
    expect(['config.json', 'advanced.json', join('progress-history', 'abc.json')].map((f) => readFileSync(join(dir, f), 'utf8'))).toEqual(texts)
    expect(readdirSync(dir).filter((f) => f.endsWith('.upgrading'))).toEqual([])
    const fresh = join(base, `profile${++n}`)
    mkdirSync(fresh)
    upgradeProfileFiles(fresh)
    expect(readdirSync(fresh)).toEqual([])
  })

  it("one it can't rewrite or read now is listed for the start to be refused, changed in nothing; the next start converts it (HR1's round 1)", () => {
    const dir = join(base, `profile${++n}`)
    mkdirSync(dir)
    const advanced = join(dir, 'advanced.json')
    writeFileSync(advanced, JSON.stringify(ADVANCED_10))
    const before = readFileSync(advanced, 'utf8')
    chmodSync(advanced, 0o444)
    try {
      expect(upgradeProfileFiles(dir)).toEqual([advanced])
      expect(readFileSync(advanced, 'utf8')).toBe(before)
      expect(readdirSync(dir).filter((f) => f.endsWith('.upgrading'))).toEqual([])
    } finally {
      chmodSync(advanced, 0o644)
    }
    expect(upgradeProfileFiles(dir)).toEqual([])
    expect(Object.keys(JSON.parse(readFileSync(advanced, 'utf8')).values)).toContain('cw.agents.perProject')
    // Not readable now (here a folder where the file is): whether it holds an old value can't be told, so it isn't settled.
    const held = join(base, `profile${++n}`)
    mkdirSync(join(held, 'config.json'), { recursive: true })
    expect(upgradeProfileFiles(held)).toEqual([join(held, 'config.json')])
  })

  it("config.json's last good copy is converted too, so a damaged config.json read from it is current", () => {
    const dir = join(base, `profile${++n}`)
    mkdirSync(dir)
    writeFileSync(join(dir, 'config.json'), '{ damaged')
    writeFileSync(join(dir, 'config.json.bak'), JSON.stringify(CONFIG_10))
    expect(upgradeProfileFiles(dir)).toEqual([])
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe('{ damaged')
    expect(JSON.parse(readFileSync(join(dir, 'config.json.bak'), 'utf8')).settings.agentApi).toEqual({ enabled: true, provideCombworkMcp: false })
  })
})
