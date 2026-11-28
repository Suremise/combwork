// HI-3616: an agent's preview captures, below Electron: the screenshot's encoding ladder within its limit, a place's shots
// kept to 20, the accessibility tree as text, the console list and the log's tail (design HI-3597 s8, s16 §E test 6);
// round 1: one deadline over a capture, its encoding and its save, and a preview's close cancelling and awaiting them.
import { readdir } from 'fs/promises'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { axText, checkOp, closeOps, consoleList, encodeLadder, exists, logTail, OpStopped, opsRunning, removeShots, runOp, saveShot, setShotMaxForTests, shotMax, SHOT, type AxNode, type Op, type Step } from '../src/main/previewCapture'
import { tempDir } from './tempDir'

/** A shoot whose steps' bytes have the given sizes (`png@1`, `jpeg80@1`, `jpeg60@0.5`…), each step recorded. */
const sized = (sizes: Record<string, number>, made: string[] = []) => async (st: Step): Promise<Buffer> => {
  const k = `${st.quality === null ? 'png' : `jpeg${st.quality}`}@${st.scale}`
  made.push(k)
  return Buffer.alloc(sizes[k] ?? 0)
}
const op = (id = 'pv-t'): Op => ({ id, cancelled: null })
/** A promise and its resolver: a step held until the test lets it go. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => undefined
  const wait = new Promise<void>((r) => (open = r))
  return { wait, open }
}
let ids = 0
const fresh = (): string => `pv-test-${++ids}`

describe('encodeLadder: the ladder', () => {
  it('keeps the PNG when it fits', async () => {
    expect(await encodeLadder(sized({ 'png@1': 100 }), 200, op())).toMatchObject({ ok: true, format: 'png', quality: null, scale: 1 })
  })
  it('steps PNG, JPEG 80, JPEG 60, 75%, 50%, checking the bytes each time', async () => {
    const made: string[] = []
    const e = await encodeLadder(sized({ 'png@1': 900, 'jpeg80@1': 900, 'jpeg60@1': 900, 'jpeg60@0.75': 900, 'jpeg60@0.5': 150 }, made), 200, op())
    expect(made).toEqual(['png@1', 'jpeg80@1', 'jpeg60@1', 'jpeg60@0.75', 'jpeg60@0.5'])
    expect(e).toMatchObject({ ok: true, format: 'jpeg', quality: 60, scale: 0.5 })
  })
  it('a high-entropy page: its PNG over 2 MB, its JPEG within', async () => {
    expect(await encodeLadder(sized({ 'png@1': 3 * 1024 * 1024, 'jpeg80@1': 1024 * 1024 }), SHOT.maxBytes, op())).toMatchObject({ ok: true, format: 'jpeg', quality: 80 })
  })
  it('every step over: not ok, with the smallest it came to', async () => {
    expect(await encodeLadder(sized({ 'png@1': 900, 'jpeg80@1': 800, 'jpeg60@1': 700, 'jpeg60@0.75': 600, 'jpeg60@0.5': 500 }), 200, op())).toEqual({ ok: false, smallest: 500 })
  })
  it('a cancelled operation stops before its next step', async () => {
    const o = op()
    const made: string[] = []
    const shoot = async (st: Step): Promise<Buffer> => {
      const b = await sized({}, made)(st)
      o.cancelled = 'timedOut'
      return Buffer.alloc(900 + b.length)
    }
    await expect(encodeLadder(shoot, 200, o)).rejects.toBeInstanceOf(OpStopped)
    expect(made).toEqual(['png@1'])
  })
  it("a test copy's limit, then SHOT.maxBytes again", () => {
    expect(setShotMaxForTests(100)).toBe(100)
    expect(shotMax()).toBe(100)
    expect(setShotMaxForTests(null)).toBe(SHOT.maxBytes)
  })
})

describe('runOp: one deadline over the capture, its encoding and its save (HI-3616 round 1)', () => {
  it('a slow encoder past the deadline: timed out, and no file even once it finishes', async () => {
    const dir = join(tempDir('preview-shots'), 'place')
    const slow = gate()
    let finished = false
    const id = fresh()
    const run = runOp(id, 50, async (o) => {
      try {
        const e = await encodeLadder(async () => {
          await slow.wait
          return Buffer.alloc(10)
        }, 200, o)
        return await saveShot(dir, e, 1, SHOT.keep, o)
      } finally {
        finished = true
      }
    })
    await expect(run).rejects.toMatchObject({ why: 'timedOut' })
    slow.open()
    await vi.waitFor(() => expect(finished).toBe(true))
    expect(await exists(dir)).toBe(false)
    expect(opsRunning(id)).toBe(0)
  })
  it("a preview's close cancels a capture held mid-way, waits for it, and refuses new ones; the next preview's run", async () => {
    const dir = join(tempDir('preview-shots'), 'place')
    const held = gate()
    const id = fresh()
    const run = runOp(id, 60_000, async (o) => {
      await held.wait
      checkOp(o)
      return saveShot(dir, { ok: true, data: Buffer.from('x'), format: 'png', quality: null, scale: 1 }, 1, SHOT.keep, o)
    })
    run.catch(() => undefined)
    expect(opsRunning(id)).toBe(1)
    let closed = false
    const closing = closeOps(id, 60_000).then(() => (closed = true))
    await expect(run).rejects.toMatchObject({ why: 'closed' })
    // The close waits for the work itself to end, not only its caller's answer.
    expect(closed).toBe(false)
    held.open()
    await closing
    expect(opsRunning(id)).toBe(0)
    expect(await exists(dir)).toBe(false)
    await expect(runOp(id, 60_000, async () => 'late')).rejects.toMatchObject({ why: 'closed' })
    // A new generation's preview is a new id: its operations run.
    expect(await runOp(fresh(), 60_000, async () => 'next')).toBe('next')
  })
  it("a close past its bound with work still running isn't proof: false, until the work has ended (round 2)", async () => {
    const held = gate()
    const id = fresh()
    const run = runOp(id, 60_000, async (o) => {
      await held.wait
      checkOp(o)
    })
    run.catch(() => undefined)
    // The bound passes with the work still held: not proved, the work still counted.
    expect(await closeOps(id, 20)).toBe(false)
    expect(opsRunning(id)).toBe(1)
    held.open()
    await vi.waitFor(() => expect(opsRunning(id)).toBe(0))
    // Asked again (the runner's retry): proved now.
    expect(await closeOps(id, 20)).toBe(true)
  })
  it('a close during the mkdir: the write never starts', async () => {
    const dir = join(tempDir('preview-shots'), 'place')
    const o = op()
    const p = saveShot(dir, { ok: true, data: Buffer.alloc(16), format: 'png', quality: null, scale: 1 }, 1, SHOT.keep, o)
    // saveShot is awaiting its mkdir now: the cancellation lands between the two.
    o.cancelled = 'closed'
    await expect(p).rejects.toBeInstanceOf(OpStopped)
    expect(await readdir(dir).catch(() => [])).toEqual([])
  })
  it('a save cancelled while it writes keeps nothing', async () => {
    const dir = join(tempDir('preview-shots'), 'place')
    const o = op()
    const p = saveShot(dir, { ok: true, data: Buffer.alloc(64 * 1024), format: 'png', quality: null, scale: 1 }, 1, SHOT.keep, o)
    o.cancelled = 'closed'
    await expect(p).rejects.toBeInstanceOf(OpStopped)
    expect((await readdir(dir).catch(() => [])).length).toBe(0)
  })
})

describe('saveShot', () => {
  it('writes nothing for a shot that failed every step', async () => {
    const dir = join(tempDir('preview-shots'), 'place')
    expect(await saveShot(dir, { ok: false, smallest: 9 }, 1)).toBeNull()
    expect(await exists(dir)).toBe(false)
  })
  it('keeps 20: the 21st removes the oldest; removeShots clears the folder', async () => {
    const dir = join(tempDir('preview-shots'), 'place')
    const first = await saveShot(dir, { ok: true, data: Buffer.from('x'), format: 'png', quality: null, scale: 1 }, 1)
    for (let n = 2; n <= 21; n++) await saveShot(dir, { ok: true, data: Buffer.from('y'), format: n % 2 ? 'png' : 'jpeg', quality: n % 2 ? null : 80, scale: 1 }, n)
    const names = await readdir(dir)
    expect(names).toHaveLength(20)
    expect(await exists(first!.path)).toBe(false)
    expect(names.some((n) => n.endsWith('.jpg'))).toBe(true)
    await removeShots(dir)
    expect(await exists(dir)).toBe(false)
  })
})

describe('axText', () => {
  const node = (nodeId: string, role: string, name = '', childIds: string[] = [], extra: Partial<AxNode> = {}): AxNode => ({ nodeId, role: { value: role }, name: { value: name }, childIds, ...extra })
  it('keeps role, name and value; drops structure and text repeating its parent', () => {
    const nodes = [node('1', 'RootWebArea', 'Home', ['2', '3']), node('2', 'generic', '', ['4', '5']), node('4', 'heading', 'Hello', ['6']), node('6', 'StaticText', 'Hello'), node('5', 'textbox', 'Name', [], { value: { value: 'x' } }), node('3', 'button', 'Go', [], { ignored: true })]
    const t = axText(nodes, 6 * 1024)
    expect(t.text.split('\n')).toEqual(['RootWebArea "Home"', '  heading "Hello"', '  textbox "Name" = x'])
    expect(t.more).toBe(0)
  })
  it('cuts at its bytes, saying how many lines more', () => {
    const kids = Array.from({ length: 500 }, (_, i) => node(`p${i}`, 'paragraph', `paragraph number ${i}`))
    const t = axText([node('r', 'RootWebArea', 'Big', kids.map((k) => k.nodeId)), ...kids], 1024)
    expect(Buffer.byteLength(t.text)).toBeLessThanOrEqual(1024)
    expect(t.more).toBe(t.lines - t.text.split('\n').length)
    expect(t.more).toBeGreaterThan(400)
  })
})

describe('consoleList and logTail', () => {
  it('the newest 20, each at most 300 characters, 6 KB in all', () => {
    const entries = Array.from({ length: 31 }, (_, i) => ({ level: 'error' as const, text: i === 30 ? 'w'.repeat(1000) : `e${i}`, at: i }))
    const list = consoleList(entries)
    expect(list).toHaveLength(20)
    expect(list[0].text).toBe('e11')
    expect(list[19].text).toHaveLength(300)
    expect(list[19].text.endsWith('…')).toBe(true)
    const huge = consoleList(Array.from({ length: 20 }, (_, i) => ({ level: 'warning' as const, text: 'z'.repeat(400), at: i })))
    expect(huge.reduce((n, e) => n + e.text.length, 0)).toBeLessThanOrEqual(6 * 1024)
    expect(huge.length).toBeLessThan(20)
  })
  it("the log's last 20 lines, at most 2 KB", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\r\n') + '\r\n'
    expect(logTail(text).split('\n')).toEqual(Array.from({ length: 20 }, (_, i) => `line ${i + 30}`))
    expect(Buffer.byteLength(logTail(Array.from({ length: 20 }, () => 'q'.repeat(500)).join('\n')))).toBeLessThanOrEqual(2048)
  })
})
