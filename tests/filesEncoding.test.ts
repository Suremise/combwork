// The Files tab's editor and text that isn't UTF-8 (HI-2331): a Windows-1252 file used to be decoded with U+FFFD in
// place of its bytes and offered for editing, so saving any edit wrote EF BF BD over them. It is now refused (kind
// 'not-utf8', shown with Open in Default App), and its bytes are never read back as text.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'

const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
const files = await import('../src/main/files')

const base = tempDir('hive-encoding-')
const ws = join(base, 'ws')
const proj = join(ws, 'proj')
mkdirSync(proj, { recursive: true })
const w = createWorkspaceService()
w.path = ws
afterAll(async () => {
  await disposeWorkspaceService(w)
  rmSync(base, { recursive: true, force: true })
})

const put = (name: string, bytes: number[] | Buffer): Buffer => {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  writeFileSync(join(proj, name), buf)
  return buf
}

describe('Files tab: text that is not UTF-8 (HI-2331)', () => {
  it('a Windows-1252 file is refused, not decoded with replacement characters', async () => {
    const bytes = put('cafe-1252.txt', [0x63, 0x61, 0x66, 0xe9, 0x0d, 0x0a])
    const c = await files.readText(proj, 'cafe-1252.txt')
    expect(c.kind).toBe('not-utf8')
    expect(c.text).toBe('')
    expect(c.size).toBe(bytes.length)
    expect(readFileSync(join(proj, 'cafe-1252.txt'))).toEqual(bytes)
  })

  it('invalid bytes far past the binary sniff, and a truncated sequence at the end, are refused too', async () => {
    const late = Buffer.concat([Buffer.from('a'.repeat(20000)), Buffer.from([0x92]), Buffer.from('b\r\n')])
    put('late.csv', late)
    expect((await files.readText(proj, 'late.csv')).kind).toBe('not-utf8')
    put('cut.txt', Buffer.concat([Buffer.from('caf'), Buffer.from([0xc3])]))
    expect((await files.readText(proj, 'cut.txt')).kind).toBe('not-utf8')
  })

  it('a BOM followed by bytes that are not UTF-8 is refused', async () => {
    put('bom-1252.txt', [0xef, 0xbb, 0xbf, 0x63, 0x61, 0x66, 0xe9])
    expect((await files.readText(proj, 'bom-1252.txt')).kind).toBe('not-utf8')
  })

  it('UTF-8, with or without a BOM, still opens and saves back byte for byte', async () => {
    const plain = put('cafe-utf8.txt', Buffer.from('café — ☕ 𝄞\r\n', 'utf8'))
    const c = await files.readText(proj, 'cafe-utf8.txt')
    expect(c).toMatchObject({ kind: 'text', text: 'café — ☕ 𝄞\r\n', bom: false })
    await files.writeText(proj, 'cafe-utf8.txt', c.text, c.modified, c.bom)
    expect(readFileSync(join(proj, 'cafe-utf8.txt'))).toEqual(plain)

    const withBom = put('bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('café\n', 'utf8')]))
    const b = await files.readText(proj, 'bom.txt')
    expect(b).toMatchObject({ kind: 'text', text: 'café\n', bom: true })
    await files.writeText(proj, 'bom.txt', b.text, b.modified, b.bom)
    expect(readFileSync(join(proj, 'bom.txt'))).toEqual(withBom)
  })

  it('decodeUtf8 never substitutes: valid bytes decode, invalid ones give null', () => {
    expect(files.decodeUtf8(Buffer.from('héllo', 'utf8'))).toBe('héllo')
    expect(files.decodeUtf8(Buffer.from([0x68, 0xe9]))).toBeNull()
    expect(files.decodeUtf8(Buffer.from([0xed, 0xa0, 0x80]))).toBeNull() // a lone surrogate, encoded
    expect(files.decodeUtf8(new Uint8Array())).toBe('')
  })
})
