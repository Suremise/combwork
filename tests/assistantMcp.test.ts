// The Hive Assistant's MCP servers (HI-1472, HI-2059): it works like a project. A workspace server runs for it only when
// added for it (workspace.json's mcp.assistant, none until added); a project's never reach it, nor its a project. Adding
// one shows what it runs. Before its list is converted to mean added, #1093's meaning holds (on in the workspace too).
// The old Advanced switch (every workspace server for it) moves once per workspace, before the Assistant can start: a
// new workspace gets none. Each case has workspaces of its own.
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-assistantmcp-')
const profile = join(base, 'profile')
;(electron.app as unknown as { getPath: () => string }).getPath = () => profile
process.env.HIVE_USER_DATA = profile
// A test copy on its CLI test home: its agents start with no connection (the seam, HI-1755).
process.env.HIVE_TEST_CLI_HOME_CONNECTION = '1'
// Never the user's own CLI homes: the Codex and Copilot adapters read their config.
process.env.CODEX_HOME = join(base, 'codex-home')
process.env.COPILOT_HOME = join(base, 'copilot-home')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const mcp = await import('../src/main/mcp')
const { sessions } = await import('../src/main/sessions')
const { advanced } = await import('../src/main/advanced')

type Service = ReturnType<typeof createWorkspaceService>
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const ASSISTANT = { id: 'assistant', name: 'Assistant' }

/** advanced.json with the old switch as given (undefined: not set), read again. */
function legacySwitch(on: boolean | undefined): void {
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'advanced.json'), JSON.stringify({ format: 1, values: on === undefined ? {} : { 'hive.assistant.otherMcpServers': on } }))
  advanced.load(profile)
}

/**
 * A workspace as one from before: notes, sandbox and idle deployed; notes and sandbox on in the workspace; its project
 * demo has sandbox on. `mcp` is workspace.json's mcp as written (its `assistant` absent unless given).
 */
function oldWorkspace(mcpCfg: Record<string, unknown> = { enabled: ['notes', 'sandbox'], model: 2 }): { ws: string; proj: string } {
  const ws = tempDir('hive-assistantmcp-ws-')
  const proj = join(ws, 'demo')
  mkdirSync(join(ws, '.combwork', 'mcp'), { recursive: true })
  mkdirSync(join(proj, '.combwork'), { recursive: true })
  for (const n of ['notes', 'sandbox', 'idle']) writeFileSync(join(ws, '.combwork', 'mcp', `${n}.json`), JSON.stringify({ description: `The ${n} server`, command: 'node', args: [`${n}.js`] }))
  writeFileSync(join(ws, '.combwork', 'workspace.json'), JSON.stringify({ version: 1, mcp: mcpCfg }))
  writeFileSync(join(proj, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Builder', provider: 'claude-code' }], mcp: { disabled: [], enabled: ['sandbox'] } }))
  return { ws, proj }
}

async function opened(ws: string): Promise<Service> {
  const w = createWorkspaceService()
  await w.open(ws)
  return w
}

/** The servers a launch gets, but Hive's own. */
const gets = async (path: string, agent: object): Promise<string[]> => Object.keys((await sessions.effective(path, agent as never)).mcpServers).filter((n) => n !== 'hive').sort()
const assistantGets = (w: Service) => gets(w.assistantHome, ASSISTANT)
const saved = (ws: string): unknown => json(join(ws, '.combwork', 'workspace.json')).mcp.assistant

const was = process.env.HIVE_TEST_TRASH_DIR
beforeAll(() => {
  process.env.HIVE_TEST_TRASH_DIR = join(base, 'trash')
})
afterAll(() => {
  if (was === undefined) delete process.env.HIVE_TEST_TRASH_DIR
  else process.env.HIVE_TEST_TRASH_DIR = was
  advanced.stop()
})

describe("the Assistant's MCP servers move from the old Advanced switch (HI-1472)", () => {
  it('a new workspace gets none, even with the old switch on', async () => {
    legacySwitch(true)
    const ws = join(tempDir('hive-assistantmcp-new-'), 'fresh')
    mkdirSync(ws)
    const w = await opened(ws)
    try {
      expect(w.config.mcp.assistant).toEqual([])
      expect(saved(ws)).toEqual([])
    } finally {
      await disposeWorkspaceService(w)
    }
  })

  it("one from before keeps what the switch gave it, before the Assistant can start: on, the workspace's servers; else none", async () => {
    legacySwitch(true)
    const on = oldWorkspace()
    const w = await opened(on.ws)
    try {
      expect(saved(on.ws)).toEqual(['notes', 'sandbox'])
      // Its first launch after the open has them: the move is done before the open ends.
      expect(await assistantGets(w)).toEqual(['notes', 'sandbox'])
    } finally {
      await disposeWorkspaceService(w)
    }
    for (const value of [false, undefined]) {
      legacySwitch(value)
      const off = oldWorkspace()
      const w2 = await opened(off.ws)
      try {
        expect(saved(off.ws)).toEqual([])
        expect(await assistantGets(w2)).toEqual([])
      } finally {
        await disposeWorkspaceService(w2)
      }
    }
  })

  it('a list already there, an empty one too, is the user\'s and stays; the old value stays in advanced.json for later workspaces', async () => {
    legacySwitch(true)
    const chosen = oldWorkspace({ enabled: ['notes', 'sandbox'], model: 2, assistant: [] })
    const w = await opened(chosen.ws)
    try {
      expect(saved(chosen.ws)).toEqual([])
      expect(await assistantGets(w)).toEqual([])
    } finally {
      await disposeWorkspaceService(w)
    }
    // Another setting changed meanwhile: the old one is kept as it was, and not listed as unknown.
    await advanced.set('hive.mcp.replySeconds', 30)
    expect(json(join(profile, 'advanced.json')).values['hive.assistant.otherMcpServers']).toBe(true)
    expect(advanced.state(null).unknown).not.toContain('hive.assistant.otherMcpServers')
    expect(advanced.legacy('hive.assistant.otherMcpServers')).toBe(true)
    await advanced.resetAll()
    expect(json(join(profile, 'advanced.json')).values['hive.assistant.otherMcpServers']).toBe(true)
  })

  it('an Assistant launch worked out while the move is held waits for it, and gets what it moves', async () => {
    legacySwitch(true)
    const { ws } = oldWorkspace()
    const w = createWorkspaceService()
    // The move held until released: the open is under way, the workspace's path already set.
    let release = (): void => {}
    const held = new Promise<void>((r) => (release = r))
    let entered = false
    const inner = w as unknown as { migrateAssistantMcp: (fresh: boolean) => Promise<void> }
    const original = inner.migrateAssistantMcp.bind(w)
    inner.migrateAssistantMcp = async (fresh: boolean) => {
      entered = true
      await held
      return original(fresh)
    }
    const opening = w.open(ws)
    try {
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 15000 })
      // Started while the move is held: without waiting for it, it would read no choices and give none.
      const launch = assistantGets(w)
      release()
      expect(await launch).toEqual(['notes', 'sandbox'])
      await opening
    } finally {
      release()
      await opening.catch(() => undefined)
      await disposeWorkspaceService(w)
    }
  })

  it('a choice saved while the move is under way wins over it', async () => {
    legacySwitch(true)
    const { ws } = oldWorkspace({ enabled: ['notes', 'sandbox'], model: 2, assistant: [] })
    const w = await opened(ws)
    try {
      // As if the move hadn't run yet: the user's save is queued first, the move's after it.
      delete w.config.mcp.assistant
      const user = w.saveWorkspaceConfigWith((c) => ({ mcp: { ...c.mcp, assistant: ['notes'] } }))
      const move = (w as unknown as { migrateAssistantMcp: (fresh: boolean) => Promise<void> }).migrateAssistantMcp(false)
      await Promise.all([user, move])
      expect(saved(ws)).toEqual(['notes'])
      expect(w.config.mcp.assistant).toEqual(['notes'])
    } finally {
      await disposeWorkspaceService(w)
    }
  })
})

describe("the Assistant's added servers (HI-1472, HI-2059)", () => {
  /** Adds a server for the Assistant as its view's Add server picker does: shown first. */
  const addFor = async (w: Service, name: string): Promise<void> =>
    inWorkspace(w, async () => {
      const m = (await mcp.listMcp(true)).find((x) => x.name === name)!
      await mcp.addMcpTo('assistant', name, { def: m.def, revision: m.revision })
    })

  it("gets exactly the servers added for it, never a project's, nor a project its", async () => {
    legacySwitch(undefined)
    const { ws, proj } = oldWorkspace()
    const w = await opened(ws)
    try {
      const builder = () => gets(proj, { id: 'a1', name: 'Builder', provider: 'claude-code' })
      expect(await assistantGets(w)).toEqual([])
      const before = sessions.signature(await sessions.effective(w.assistantHome, ASSISTANT as never))
      await addFor(w, 'notes')
      // idle, off in the workspace before: no switch now, so it is simply added.
      await addFor(w, 'idle')
      expect(await assistantGets(w)).toEqual(['idle', 'notes'])
      expect(await builder()).toEqual(['sandbox'])
      expect((await w.projectConfig(proj)).mcp.enabled).toEqual(['sandbox'])
      // Its launch changes, so a running Assistant is told to restart.
      expect(sessions.signature(await sessions.effective(w.assistantHome, ASSISTANT as never))).not.toBe(before)
      // listMcp and the window say so.
      const listed = await inWorkspace(w, () => mcp.listMcp(true))
      expect(listed.map((m) => [m.name, m.assistant, m.projects.length])).toEqual([
        ['idle', true, 0],
        ['notes', true, 0],
        ['sandbox', false, 1]
      ])
      await inWorkspace(w, () => mcp.removeMcpFrom('assistant', 'idle'))
      expect(await assistantGets(w)).toEqual(['notes'])
    } finally {
      await disposeWorkspaceService(w)
    }
  })

  it('is refused without the definition shown, or one changed since, and changes nothing then', async () => {
    legacySwitch(undefined)
    const { ws } = oldWorkspace()
    const w = await opened(ws)
    try {
      await expect(inWorkspace(w, () => mcp.addMcpTo('assistant', 'notes', { def: null }))).rejects.toThrow('has changed since it was shown to you')
      const shown = (await inWorkspace(w, () => mcp.listMcp(true))).find((x) => x.name === 'notes')!
      // Replaced meanwhile: refused.
      writeFileSync(join(ws, '.combwork', 'mcp', 'notes.json'), JSON.stringify({ command: 'node', args: ['other.js'] }))
      await expect(inWorkspace(w, () => mcp.addMcpTo('assistant', 'notes', { def: shown.def, revision: shown.revision }))).rejects.toThrow('has changed since it was shown to you')
      await expect(inWorkspace(w, () => mcp.addMcpTo('assistant', 'missing', { def: null }))).rejects.toThrow('no MCP server named missing')
      expect(saved(ws)).toEqual([])
      expect(await assistantGets(w)).toEqual([])
    } finally {
      await disposeWorkspaceService(w)
    }
  })

  it("before its conversion it keeps #1093's meaning, and a change converts it without starting one the workspace had off", async () => {
    legacySwitch(undefined)
    const { ws } = oldWorkspace()
    const w = await opened(ws)
    try {
      // As a conversion cut short leaves it: idle remembered while the workspace had it off.
      w.config.mcp.assistant = ['idle', 'notes']
      delete w.config.mcp.assistantModel
      expect(await assistantGets(w)).toEqual(['notes'])
      expect((await inWorkspace(w, () => mcp.listMcp(true))).filter((m) => m.assistant).map((m) => m.name)).toEqual(['notes'])
      await inWorkspace(w, () => mcp.removeMcpFrom('assistant', 'sandbox'))
      expect(json(join(ws, '.combwork', 'workspace.json')).mcp).toMatchObject({ assistant: ['notes'], assistantModel: 3 })
      expect(await assistantGets(w)).toEqual(['notes'])
    } finally {
      await disposeWorkspaceService(w)
    }
  })

  it("is set with Add to… in the MCP view, and lost with a deleted server, as a project's is", async () => {
    legacySwitch(undefined)
    const { ws, proj } = oldWorkspace()
    const w = await opened(ws)
    try {
      const idle = (await inWorkspace(w, () => mcp.listMcp(true))).find((x) => x.name === 'idle')!
      expect(await inWorkspace(w, () => mcp.setMcpPlaces('idle', { def: idle.def, revision: idle.revision }, {}, true))).toEqual({ added: ['assistant'], removed: [], failed: [] })
      expect(await assistantGets(w)).toEqual(['idle'])
      expect((await w.projectConfig(proj)).mcp.enabled).toEqual(['sandbox'])
      await inWorkspace(w, () => mcp.deleteMcp('idle'))
      expect(saved(ws)).toEqual([])
      // Added again under the name: added nowhere, as for every project.
      writeFileSync(join(ws, '.combwork', 'mcp', 'idle.json'), JSON.stringify({ command: 'node', args: ['idle.js'] }))
      expect((await inWorkspace(w, () => mcp.listMcp(true))).find((x) => x.name === 'idle')?.assistant).toBe(false)
    } finally {
      await disposeWorkspaceService(w)
    }
  })

  it("is each workspace's own, and kept across a reopen", async () => {
    legacySwitch(undefined)
    const a = oldWorkspace()
    const b = oldWorkspace()
    const wa = await opened(a.ws)
    const wb = await opened(b.ws)
    try {
      await addFor(wa, 'notes')
      await addFor(wb, 'sandbox')
      expect([await assistantGets(wa), await assistantGets(wb)]).toEqual([['notes'], ['sandbox']])
    } finally {
      await disposeWorkspaceService(wa)
      await disposeWorkspaceService(wb)
    }
    const again = await opened(a.ws)
    try {
      expect(await assistantGets(again)).toEqual(['notes'])
    } finally {
      await disposeWorkspaceService(again)
    }
  })
})
