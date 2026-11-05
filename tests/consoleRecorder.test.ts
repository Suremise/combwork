import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { WebContents } from 'electron'
import { sessionSourceId, type ConsoleSource } from '../src/shared/devConsole'
import { parseRecording, recordingName } from '../src/shared/consoleFixtures.mts'
import { SECRET_SAMPLES } from './secretSamples'

// Recording a console source (#638), the service itself: one recording per window, only while the window still wants
// it (a start overtaken by a close, a stop or a newer start records nothing, whenever it is overtaken); a file each,
// reserved however many starts come at once; stopping writes what was captured up to then before the end line and
// nothing after; the newest recording by when it started. Combwork's profile folder is a new temp folder of this file's.
vi.mock('electron', async () => {
  const { tempDir } = await import('./tempDir')
  const profile = tempDir('cw-recorder-')
  return { app: { getPath: () => profile, getVersion: () => '0.7.0-test' } }
})
// A file open can be made to fail once (a recordings folder Combwork can't write to), and a recording's writes can fail (a
// full disk) or take only part of what they're given, chosen by what is being written.
const openFails = vi.hoisted(() => ({ next: false }))
const writeFaults = vi.hoisted(() => ({ rules: [] as { when: (text: string) => boolean; fault: 'enospc' | number; times: number }[] }))
vi.mock('fs/promises', async (original) => {
  const fsp = await original<typeof import('fs/promises')>()
  const faulty = (fh: import('fs/promises').FileHandle) =>
    new Proxy(fh, {
      get(target, key) {
        if (key === 'write')
          return async (buf: Buffer, offset = 0, length = buf.length - offset, position: number | null = null) => {
            const text = buf.subarray(offset, offset + length).toString('utf8')
            const rule = writeFaults.rules.find((r) => r.times > 0 && r.when(text))
            if (rule) {
              rule.times--
              if (rule.fault === 'enospc') throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
              return target.write(buf, offset, Math.min(rule.fault, length), position)
            }
            return target.write(buf, offset, length, position)
          }
        const v = Reflect.get(target, key) as unknown
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
      }
    })
  return {
    ...fsp,
    open: async (...args: Parameters<typeof fsp.open>) => {
      if (!openFails.next) return faulty(await fsp.open(...args))
      openFails.next = false
      throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' })
    }
  }
})
vi.mock('../src/main/providerService', () => ({ providerService: { all: () => ({ 'claude-code': { version: '2.1.296', tested: { version: '2.1.296' } } }) } }))
vi.mock('../src/main/logger', () => ({ createLogger: () => ({ info: () => undefined, warn: () => undefined }), userText: (t: unknown) => String(t) }))

const { devConsole } = await import('../src/main/devConsole')
const { latestRecording, recordingOf, recordingsDir, startRecording, stopRecording } = await import('../src/main/consoleRecorder')

const HUNG_MS = 10000
const alpha = join('C:\\', 'work', 'alpha')
const A1 = sessionSourceId(alpha, 'a1')
const source: ConsoleSource = { id: A1, kind: 'session', label: 'alpha · B1', workspacePath: join('C:\\', 'work'), projectPath: alpha, agentId: 'a1', provider: 'claude-code', capturing: false, events: 0 }

let nextId = 1000
/** A window's page as the recorder sees it: an id, sent events, and its close. */
function fakePage(): WebContents & { close: () => void; sent: unknown[] } {
  const e = new EventEmitter() as EventEmitter & { id: number; destroyed: boolean; sent: unknown[] }
  e.id = nextId++
  e.destroyed = false
  e.sent = []
  return Object.assign(e, {
    isDestroyed: () => e.destroyed,
    send: (_c: string, ev: unknown) => e.sent.push(ev),
    close: () => {
      e.destroyed = true
      e.emit('destroyed')
    }
  }) as unknown as WebContents & { close: () => void; sent: unknown[] }
}

const hook = (name: string) => () => ({ kind: 'hook' as const, name, summary: name, raw: { hook_event_name: name } })
const files = (): string[] => readdirSync(recordingsDir()).filter((n) => n.endsWith('.jsonl'))
const lines = (file: string) => parseRecording(readFileSync(file, 'utf8'))
const recordingSubs = (): number => devConsole.stats().subscribers
const pages: ReturnType<typeof fakePage>[] = []
const page = (): ReturnType<typeof fakePage> => {
  const p = fakePage()
  pages.push(p)
  return p
}

afterEach(async () => {
  writeFaults.rules = []
  for (const p of pages.splice(0)) if (!p.isDestroyed()) p.close()
  await vi.waitFor(() => expect(recordingSubs()).toBe(0), { timeout: HUNG_MS })
})

describe('starting', () => {
  it('records a watched source to a file with its header, and stops with its end line', async () => {
    const wc = page()
    const info = await startRecording(wc, source, 'c:\\work', false, () => true)
    expect(info).toMatchObject({ recording: true, includeText: false, events: 0, kind: 'session' })
    devConsole.capture([A1], hook('Stop'))
    const done = await stopRecording(wc.id, 'stopped')
    const r = lines(info.file)
    expect(r.header).toMatchObject({ type: 'recording', combwork: '0.7.0-test', text: false, clis: [{ provider: 'claude-code', version: '2.1.296', tested: '2.1.296' }] })
    expect(r.events.map((e) => e.name)).toEqual(['Stop'])
    expect(r.end).toMatchObject({ events: 1, reason: 'stopped' })
    expect(done).toMatchObject({ recording: false, events: 1, reason: 'stopped' })
  })

  it('never records for a window closed while its start was on its way, at any point', async () => {
    // Closed before the start got going.
    const early = page()
    const first = startRecording(early, source, 'c:\\work', false, () => true)
    early.close()
    await expect(first).rejects.toThrow(/cancelled/)
    // Closed after its file was made (the check after the awaits): the file ends empty, and nothing is subscribed.
    const late = page()
    let calls = 0
    const second = startRecording(late, source, 'c:\\work', true, () => {
      if (++calls === 2) late.close()
      return true
    })
    await expect(second).rejects.toThrow(/cancelled/)
    expect(recordingOf(late.id)).toBeNull()
    expect(devConsole.sourcesOf(`record:${late.id}`)).toEqual([])
    devConsole.capture([A1], hook('PreToolUse'))
    const made = files().map((n) => lines(join(recordingsDir(), n))).find((r) => r.header?.text === true && r.end?.reason === 'closed' && r.events.length === 0)
    expect(made).toBeTruthy()
  })

  it('a stop or another source while a start is on its way cancels it', async () => {
    const wc = page()
    const pending = startRecording(wc, source, 'c:\\work', false, () => true)
    const stopped = stopRecording(wc.id, 'stopped')
    await expect(pending).rejects.toThrow(/cancelled/)
    expect(await stopped).toBeNull()
    let watching = true
    const other = startRecording(wc, source, 'c:\\work', false, () => watching)
    watching = false
    await expect(other).rejects.toThrow(/cancelled/)
    expect(recordingOf(wc.id)).toBeNull()
  })

  it('two starts at once in a window: the newer one records, once, in a file of its own', async () => {
    const wc = page()
    const before = new Set(files())
    const [a, b] = await Promise.allSettled([startRecording(wc, source, 'c:\\work', false, () => true), startRecording(wc, source, 'c:\\work', true, () => true)])
    expect(a.status).toBe('rejected')
    expect(b.status).toBe('fulfilled')
    expect(recordingOf(wc.id)?.includeText).toBe(true)
    expect(devConsole.sourcesOf(`record:${wc.id}`)).toEqual([A1])
    await stopRecording(wc.id, 'stopped')
    expect(files().filter((n) => !before.has(n))).toHaveLength(1)
  })

  it('starts in two windows in the same moment get two files', async () => {
    const [one, two] = [page(), page()]
    const [a, b] = await Promise.all([startRecording(one, source, 'c:\\work', false, () => true), startRecording(two, source, 'c:\\work', false, () => true)])
    expect(a.name).not.toBe(b.name)
    await Promise.all([stopRecording(one.id, 'stopped'), stopRecording(two.id, 'stopped')])
    expect(lines(a.file).end?.reason).toBe('stopped')
    expect(lines(b.file).end?.reason).toBe('stopped')
  })

  it("a start whose file can't be made fails, and records nothing", async () => {
    const wc = page()
    openFails.next = true
    await expect(startRecording(wc, source, 'c:\\work', false, () => true)).rejects.toThrow(/EACCES/)
    expect(recordingOf(wc.id)).toBeNull()
    expect(devConsole.sourcesOf(`record:${wc.id}`)).toEqual([])
  })
})

describe('stopping', () => {
  it('a recording with text keeps the text, and masks the secrets and sign-ins in it (#699 round 1)', async () => {
    const wc = page()
    const info = await startRecording(wc, source, 'c:\\work', true, () => true)
    for (const s of SECRET_SAMPLES) devConsole.capture([A1], () => ({ kind: 'hook', name: 'UserPromptSubmit', summary: 's', raw: { prompt: s.text, tool_input: { command: s.text } } }))
    await stopRecording(wc.id, 'stopped')
    const r = lines(info.file)
    expect(r.header).toMatchObject({ text: true })
    expect(r.events).toHaveLength(SECRET_SAMPLES.length)
    for (const [i, s] of SECRET_SAMPLES.entries()) {
      const text = JSON.stringify(r.events[i])
      for (const secret of s.secrets) expect(text, s.text).not.toContain(secret)
      for (const k of s.kept ?? []) expect(text, s.text).toContain(k)
    }
  })

  it('writes what was captured up to the stop, even still queued, and nothing after', async () => {
    const wc = page()
    const info = await startRecording(wc, source, 'c:\\work', false, () => true)
    devConsole.capture([A1], hook('PostToolUse'))
    devConsole.capture([A1], hook('Stop'))
    // In the same task: both are still in the recording's queue.
    const stopped = stopRecording(wc.id, 'stopped')
    devConsole.capture([A1], hook('SessionEnd'))
    await stopped
    const r = lines(info.file)
    expect(r.events.map((e) => e.name)).toEqual(['PostToolUse', 'Stop'])
    expect(r.end).toMatchObject({ events: 2, dropped: 0 })
  })

  it('a window closing ends its recording the same way', async () => {
    const wc = page()
    const info = await startRecording(wc, source, 'c:\\work', false, () => true)
    devConsole.capture([A1], hook('Stop'))
    wc.close()
    await vi.waitFor(() => expect(lines(info.file).end?.reason).toBe('closed'), { timeout: HUNG_MS })
    expect(lines(info.file).events.map((e) => e.name)).toEqual(['Stop'])
  })
})

describe('a file that cannot be written', () => {
  const isEvent = (t: string): boolean => t.startsWith('{"type":"event"')
  const isHeader = (t: string): boolean => t.startsWith('{"type":"recording"')
  const isEnd = (t: string): boolean => t.startsWith('{"type":"end"')
  const raw = (file: string): string => readFileSync(file, 'utf8')
  const last = (wc: ReturnType<typeof fakePage>) => (wc.sent.at(-1) as { recording: { recording: boolean; reason?: string; error?: string; events: number } }).recording

  it('a write that takes only part of its text is finished, the file whole and its count right', async () => {
    writeFaults.rules.push({ when: isHeader, fault: 15, times: 1 }, { when: isEvent, fault: 15, times: 2 }, { when: isEnd, fault: 7, times: 1 })
    const wc = page()
    const info = await startRecording(wc, source, 'c:\\work', false, () => true)
    devConsole.capture([A1], hook('Stop'))
    const done = await stopRecording(wc.id, 'stopped')
    const r = lines(info.file)
    expect(r.bad).toBe(0)
    expect(r.events.map((e) => e.name)).toEqual(['Stop'])
    expect(r.end).toMatchObject({ events: 1, reason: 'stopped' })
    expect(done).toMatchObject({ events: 1, reason: 'stopped', bytes: Buffer.byteLength(raw(info.file)) })
  })

  it('a full disk while recording: failed, with why, counting only what is in the file; never "saved"', async () => {
    writeFaults.rules.push({ when: isEvent, fault: 'enospc', times: 1 })
    const wc = page()
    const info = await startRecording(wc, source, 'c:\\work', false, () => true)
    devConsole.capture([A1], hook('Stop'))
    // Its last word comes once its file is finished (it is no longer the window's recording a little before).
    await vi.waitFor(() => expect(last(wc).recording).toBe(false), { timeout: HUNG_MS })
    expect(recordingOf(wc.id)).toBeNull()
    const r = lines(info.file)
    expect(r.events).toEqual([])
    expect(r.end).toMatchObject({ events: 0, reason: 'failed', error: expect.stringMatching(/ENOSPC/) })
    expect(last(wc)).toMatchObject({ recording: false, reason: 'failed', events: 0, error: expect.stringMatching(/ENOSPC/) })
    expect(wc.sent.some((e) => (e as { recording: { recording: boolean; reason?: string } }).recording.recording === false && (e as { recording: { reason?: string } }).recording.reason !== 'failed')).toBe(false)
  })

  it("an end line or header that can't be written: failed, the file kept as it is", async () => {
    writeFaults.rules.push({ when: isEnd, fault: 'enospc', times: 1 })
    const wc = page()
    const info = await startRecording(wc, source, 'c:\\work', false, () => true)
    devConsole.capture([A1], hook('Stop'))
    const done = await stopRecording(wc.id, 'stopped')
    expect(done).toMatchObject({ recording: false, reason: 'failed', events: 1, error: expect.stringMatching(/ENOSPC/) })
    expect(lines(info.file).events.map((e) => e.name)).toEqual(['Stop'])
    expect(lines(info.file).end).toBeNull()

    writeFaults.rules.push({ when: isHeader, fault: 'enospc', times: 1 })
    const other = page()
    await expect(startRecording(other, source, 'c:\\work', false, () => true)).rejects.toThrow(/ENOSPC/)
    expect(recordingOf(other.id)).toBeNull()
    expect(devConsole.sourcesOf(`record:${other.id}`)).toEqual([])
  })

  it("an old recording's failure never stops the newer one that replaced it", async () => {
    const wc = page()
    const old = await startRecording(wc, source, 'c:\\work', false, () => true)
    writeFaults.rules.push({ when: isEvent, fault: 'enospc', times: 1 })
    devConsole.capture([A1], hook('Stop'))
    const newer = await startRecording(wc, source, 'c:\\work', true, () => true)
    expect(lines(old.file).end).toMatchObject({ reason: 'failed', events: 0 })
    devConsole.capture([A1], hook('SessionEnd'))
    await vi.waitFor(() => expect(recordingOf(wc.id)?.events).toBe(1), { timeout: HUNG_MS })
    expect(recordingOf(wc.id)).toMatchObject({ name: newer.name, recording: true, includeText: true })
    await stopRecording(wc.id, 'stopped')
    expect(lines(newer.file).events.map((e) => e.name)).toEqual(['SessionEnd'])
  })
})

describe('latestRecording', () => {
  it('is the one that started last, whatever the names sort to, and says whether it has text', async () => {
    const dir = recordingsDir()
    mkdirSync(dir, { recursive: true })
    // Far in the future, so this test's are the newest in the folder.
    const at = new Date(2099, 0, 2, 3, 4, 5, 6)
    const write = (n: number, text: boolean): void => {
      const h = { type: 'recording', format: 1, combwork: '0.7.0-test', startedAt: new Date(at.getTime() + n).toISOString(), source: { kind: 'session', label: 'x' }, text, clis: [] }
      writeFileSync(join(dir, recordingName(at, n, 'session')), `${JSON.stringify(h)}\n`)
    }
    write(1, false)
    write(2, true)
    expect(await latestRecording()).toMatchObject({ name: recordingName(at, 2, 'session'), includeText: true })
    write(10, false)
    expect(await latestRecording()).toMatchObject({ name: recordingName(at, 10, 'session'), includeText: false })
  })
})
