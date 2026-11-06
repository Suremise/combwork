// HI-2454: an old asynchronous read must not restore settings superseded while it waited.
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

const reads = vi.hoisted(() => ({
  held: null as null | { file: string; entered: boolean; wait: Promise<void> },
  watchers: [] as { listener: (event: string, name: string) => void }[]
}))
vi.mock('original-fs', async (original) => {
  const actual = await original<typeof import('fs')>()
  const { EventEmitter } = await import('events')
  return {
    ...actual,
    watch: (_folder: unknown, listener: (event: string, name: string) => void) => {
      reads.watchers.push({ listener })
      return Object.assign(new EventEmitter(), { close: () => undefined })
    }
  }
})
vi.mock('original-fs/promises', async (original) => {
  const actual = await original<typeof import('fs/promises')>()
  return {
    ...actual,
    readFile: async (file: Parameters<typeof actual.readFile>[0], options: Parameters<typeof actual.readFile>[1]) => {
      const held = reads.held
      if (!held || String(file) !== held.file) return actual.readFile(file, options)
      reads.held = null
      const text = await actual.readFile(file, options)
      held.entered = true
      await held.wait
      return text
    }
  }
})

const { AdvancedStore } = await import('../src/main/advanced')
const HUNG_MS = 10_000
const stores: InstanceType<typeof AdvancedStore>[] = []
afterEach(() => {
  reads.held = null
  reads.watchers.length = 0
  for (const store of stores.splice(0)) store.stop()
})

const setting = 'cw.mcp.replySeconds'
const legacy = 'cw.assistant.otherMcpServers'
const text = (values: Record<string, unknown>): string => JSON.stringify({ format: 1, values })
function opened(values: Record<string, unknown>) {
  const folder = tempDir('cw-advanced-reload-')
  const file = join(folder, 'advanced.json')
  writeFileSync(file, text(values))
  const store = new AdvancedStore()
  stores.push(store)
  store.load(folder)
  // Drive reloads explicitly: native watcher timing is not the interleaving under test.
  store.stop()
  return { store, folder, file }
}

function hold(file: string) {
  let release!: () => void
  const held = { file, entered: false, wait: new Promise<void>((resolve) => (release = resolve)) }
  reads.held = held
  return { held, release }
}

describe('advanced settings read ordering (HI-2454)', () => {
  it('a callback queued by a closed watcher cannot schedule another read', async () => {
    const { store } = opened({ [setting]: 600 })
    const watcher = reads.watchers.at(-1)!
    const reload = vi.spyOn(store, 'reload').mockResolvedValue(undefined)
    vi.useFakeTimers()
    try {
      watcher.listener('change', 'advanced.json')
      await vi.runAllTimersAsync()
      expect(reload).not.toHaveBeenCalled()
    } finally {
      reload.mockRestore()
      vi.useRealTimers()
    }
  })

  it('a reload already holding the old legacy switch cannot undo a newer load', async () => {
    const { store, folder, file } = opened({ [legacy]: true })
    const { held, release } = hold(file)
    const pending = store.reload()
    try {
      await vi.waitFor(() => expect(held.entered).toBe(true), { timeout: HUNG_MS })
      writeFileSync(file, text({}))
      store.load(folder)
      release()
      await pending
      expect(store.legacy(legacy)).toBeUndefined()
    } finally {
      release()
      await pending
    }
  })

  it('two reloads completing backwards keep the newer read', async () => {
    const { store, file } = opened({ [setting]: 600 })
    const { held, release } = hold(file)
    const pending = store.reload()
    try {
      await vi.waitFor(() => expect(held.entered).toBe(true), { timeout: HUNG_MS })
      writeFileSync(file, text({ [setting]: 900 }))
      await store.reload()
      release()
      await pending
      expect(store.number(setting)).toBe(900)
    } finally {
      release()
      await pending
    }
  })

  it('a setting saved while a reload holds its old contents stays saved in memory too', async () => {
    const { store, file } = opened({ [setting]: 600 })
    const { held, release } = hold(file)
    const pending = store.reload()
    try {
      await vi.waitFor(() => expect(held.entered).toBe(true), { timeout: HUNG_MS })
      await store.set(setting, 900)
      release()
      await pending
      expect(JSON.parse(readFileSync(file, 'utf8')).values[setting]).toBe(900)
      expect(store.number(setting)).toBe(900)
    } finally {
      release()
      await pending
    }
  })

  it('a stopped store ignores a read still in flight', async () => {
    const { store, file } = opened({ [setting]: 600 })
    writeFileSync(file, text({ [setting]: 900 }))
    const { held, release } = hold(file)
    const pending = store.reload()
    try {
      await vi.waitFor(() => expect(held.entered).toBe(true), { timeout: HUNG_MS })
      store.stop()
      release()
      await pending
      expect(store.number(setting)).toBe(600)
    } finally {
      release()
      await pending
    }
  })
})
