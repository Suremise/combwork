// The Assistant's settings tools (#186) on a provider's prices (#315): null puts back Combwork's prices as Settings' Reset to
// defaults does, the shipped models removed from the table too; a table keeps them removed. Undo coverage is in assistantUndo.test.ts.
import { describe, expect, it, vi } from 'vitest'
import { config } from '../src/main/config'
import { applySetting } from '../src/main/settingsTools'
import { inWorkspace } from '../src/main/workspace'
import type { WorkspaceConfig } from '../src/shared/types'
import { settingChangeTexts, settingEntry, settingReadOnly } from '../src/shared/settingsCatalog'
import { advanced } from '../src/main/advanced'
import { CARD_ATTACHMENT_FOLDERS_ID } from '../src/shared/advanced'

const prices = settingEntry('codex.prices')!
const mine = { 'gpt-7': { input: 1, cachedInput: 0.1, output: 5 } }

/** Runs with Codex's price table set to `own` overrides and `removed` shipped models, then puts the settings back. */
async function withPrices(own: Record<string, unknown>, removed: string[], fn: () => Promise<void>): Promise<void> {
  const was = structuredClone(config.settings.providers)
  try {
    config.setProviderPrices('codex', own as never, removed)
    await fn()
  } finally {
    config.settings.providers = was
  }
}

describe("the settings tools on a provider's prices", () => {
  it('null puts back the shipped models removed from the table, and says so', async () => {
    await withPrices(mine, ['gpt-5.5'], async () => {
      const r = await applySetting(prices, null, null)
      expect(r).toEqual({ old: mine, new: {}, removed: { old: ['gpt-5.5'], new: [] } })
      expect(config.settings.providers.codex.prices).toEqual({})
      expect('pricesRemoved' in config.settings.providers.codex).toBe(false)
      expect(settingChangeTexts(prices, r.old, r.new, r.removed)).toEqual({ oldText: 'gpt-7: {"input":1,"cachedInput":0.1,"output":5}, gpt-5.5: removed', newText: "gpt-7: (none), gpt-5.5: Combwork's price" })
    })
  })

  it('…even with no overrides, when only a removed model differs', async () => {
    await withPrices({}, ['gpt-5.5'], async () => {
      const r = await applySetting(prices, null, null)
      expect(r.removed).toEqual({ old: ['gpt-5.5'], new: [] })
      expect(settingChangeTexts(prices, r.old, r.new, r.removed)).toEqual({ oldText: 'gpt-5.5: removed', newText: "gpt-5.5: Combwork's price" })
    })
  })

  it('a table, even an empty one, keeps the removed models', async () => {
    await withPrices(mine, ['gpt-5.5'], async () => {
      expect((await applySetting(prices, { 'gpt-8': { input: 2, cachedInput: 0.2, output: 8 } }, null)).removed).toBeUndefined()
      expect(config.settings.providers.codex.pricesRemoved).toEqual(['gpt-5.5'])
      expect((await applySetting(prices, {}, null)).removed).toBeUndefined()
      expect(config.settings.providers.codex.pricesRemoved).toEqual(['gpt-5.5'])
    })
  })

  // HI-2480 round 2: where agents may attach files from is a permission: the Assistant reads it and never sets it.
  it("Card attachments: more folders is the user's: read and explained, never set by the Assistant, Hive's or a workspace's", async () => {
    for (const id of ['advanced.hive.cards.attachmentFolders', 'workspace.advanced.hive.cards.attachmentFolders']) {
      const e = settingEntry(id)!
      expect(e, id).toMatchObject({ sensitive: true })
      expect(settingReadOnly(e), id).toMatch(/^It decides which folders agents, the Assistant and scripts may attach files to cards from: only the user can change it, in /)
      await expect(applySetting(e, ['C:\\Evidence'], null), id).rejects.toMatchObject({ status: 403 })
    }
    expect(advanced.get(CARD_ATTACHMENT_FOLDERS_ID)).toEqual([])
  })

})

describe('extra arguments with a bare "--" (#523)', () => {
  it("are refused when saved, the providers' and the Assistant's, and the settings stay as they were", () => {
    const was = structuredClone(config.settings)
    try {
      const refused = 'Combwork passes the task after "--"; remove it from extra arguments.'
      expect(() => config.updateSettings({ providers: { 'claude-code': { extraArgs: '--allowedTools Read Bash --' } } } as never)).toThrow(refused)
      expect(() => config.updateSettings({ assistant: { providers: { codex: { extraArgs: '-- hello' } } } } as never)).toThrow(refused)
      expect(config.settings.providers['claude-code'].extraArgs).toBe(was.providers['claude-code'].extraArgs)
      expect(config.settings.assistant.providers.codex?.extraArgs).toBe(was.assistant.providers.codex?.extraArgs)
      // An option's value of "--" written with "=" is kept.
      config.updateSettings({ providers: { 'claude-code': { extraArgs: '--append-system-prompt=--' } } } as never)
      expect(config.settings.providers['claude-code'].extraArgs).toBe('--append-system-prompt=--')
    } finally {
      config.settings.providers = was.providers
      config.settings.assistant = was.assistant
    }
  })
})

describe("the settings tools on the copied files, Hive's slot default (HI-1765)", () => {
  it('sets patterns, none and inherit, saved as Settings saves the level, the old and new values said', async () => {
    const e = settingEntry('workflow.git.slotCopy')!
    const was = config.settings.slotDefaults
    try {
      config.settings.slotDefaults = undefined
      expect(await applySetting(e, '.env*\nconfig/local.json', null)).toEqual({ old: 'inherit', new: '.env*\nconfig/local.json' })
      expect(config.settings.slotDefaults).toEqual({ copy: '.env*\nconfig/local.json' })
      expect(await applySetting(e, '', null)).toEqual({ old: '.env*\nconfig/local.json', new: '' })
      expect(await applySetting(e, null, null)).toEqual({ old: '', new: 'inherit' })
      expect(config.settings.slotDefaults).toEqual({})
    } finally {
      config.settings.slotDefaults = was
    }
  })
})

describe("the settings tools on the workspace's copied files, in its save queue (HR5's HI-1765 round 1)", () => {
  const e = settingEntry('workspace.workflow.git.slotCopy')!
  /** A workspace whose saves wait in their queue until `release`, then work the change out as the real one does. */
  function heldWorkspace(copy: string) {
    const state = { slotDefaults: { copy } } as Partial<WorkspaceConfig>
    let change: ((c: WorkspaceConfig) => Partial<WorkspaceConfig>) | null = null
    let done: (e?: unknown) => void = () => {}
    const ws = {
      config: state,
      scheduleRefresh: () => {},
      saveWorkspaceConfigWith: (fn: (c: WorkspaceConfig) => Partial<WorkspaceConfig>) => {
        change = fn
        return new Promise<void>((res, rej) => (done = (err) => (err ? rej(err) : res())))
      }
    }
    const release = (): void => {
      try {
        Object.assign(state, change!(state as WorkspaceConfig))
        done()
      } catch (err) {
        done(err)
      }
    }
    return { ws, state, queued: () => change !== null, release }
  }

  it('a guard refusing by the time the change runs refuses it, nothing written', async () => {
    const w = heldWorkspace('old')
    let allowed = true
    const p = inWorkspace(w.ws as never, () =>
      applySetting(e, 'new', null, () => {
        if (!allowed) throw new Error('revoked')
      })
    )
    await vi.waitFor(() => expect(w.queued()).toBe(true))
    allowed = false
    w.release()
    await expect(p).rejects.toThrow('revoked')
    expect(w.state.slotDefaults).toEqual({ copy: 'old' })
  })

  it('the guard sees the value as the change replaces it, a change meanwhile included, and the reply says so', async () => {
    const w = heldWorkspace('old')
    const seen: unknown[] = []
    const p = inWorkspace(w.ws as never, () => applySetting(e, 'new', null, (now) => void seen.push(now)))
    await vi.waitFor(() => expect(w.queued()).toBe(true))
    w.state.slotDefaults = { copy: 'meanwhile' }
    w.release()
    expect(await p).toEqual({ old: 'meanwhile', new: 'new' })
    expect(seen).toEqual(['meanwhile'])
    expect(w.state.slotDefaults).toEqual({ copy: 'new' })
  })
})
