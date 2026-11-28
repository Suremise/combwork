// HI-3616: an agent's preview captures, below Electron: the screenshot's encoding ladder within its limit, a place's shots
// kept to 20, the accessibility tree as text, the console list and the log's tail (design HI-3597 s8, s16 §E test 6).
import { readdir } from 'fs/promises'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { axText, consoleList, encodeWithin, exists, logTail, removeShots, saveShot, setShotMaxForTests, shotMax, SHOT, type AxNode, type Encodable } from '../src/main/previewCapture'
import { tempDir } from './tempDir'

/** An image whose encodings have the given sizes: png, jpeg by quality, and each scale's own. */
function fake(sizes: Record<string, number>, scale = 1, made: string[] = []): Encodable {
  const at = (k: string): Buffer => {
    made.push(k)
    return Buffer.alloc(sizes[k] ?? 0)
  }
  return { png: () => at(`png@${scale}`), jpeg: (q) => at(`jpeg${q}@${scale}`), scaled: (f) => fake(sizes, f, made) }
}

describe('encodeWithin: the ladder', () => {
  it('keeps the PNG when it fits', () => {
    const e = encodeWithin(fake({ 'png@1': 100 }), 200)
    expect(e).toMatchObject({ ok: true, format: 'png', quality: null, scale: 1 })
  })
  it('steps PNG, JPEG 80, JPEG 60, 75%, 50%, checking the bytes each time', () => {
    const made: string[] = []
    const e = encodeWithin(fake({ 'png@1': 900, 'jpeg80@1': 900, 'jpeg60@1': 900, 'jpeg60@0.75': 900, 'jpeg60@0.5': 150 }, 1, made), 200)
    expect(made).toEqual(['png@1', 'jpeg80@1', 'jpeg60@1', 'jpeg60@0.75', 'jpeg60@0.5'])
    expect(e).toMatchObject({ ok: true, format: 'jpeg', quality: 60, scale: 0.5 })
  })
  it('a high-entropy page: its PNG over 2 MB, its JPEG within', () => {
    const e = encodeWithin(fake({ 'png@1': 3 * 1024 * 1024, 'jpeg80@1': 1024 * 1024 }))
    expect(e).toMatchObject({ ok: true, format: 'jpeg', quality: 80 })
  })
  it('every step over: not ok, with the smallest it came to', () => {
    const e = encodeWithin(fake({ 'png@1': 900, 'jpeg80@1': 800, 'jpeg60@1': 700, 'jpeg60@0.75': 600, 'jpeg60@0.5': 500 }), 200)
    expect(e).toEqual({ ok: false, smallest: 500 })
  })
  it("a test copy's limit, then SHOT.maxBytes again", () => {
    expect(setShotMaxForTests(100)).toBe(100)
    expect(shotMax()).toBe(100)
    expect(setShotMaxForTests(null)).toBe(SHOT.maxBytes)
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
