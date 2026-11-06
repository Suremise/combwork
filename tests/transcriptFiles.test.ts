// Compressed transcript backups (#1110): one reader for plain and gzipped transcripts (whole lines, from an offset), a
// first line read without decompressing the rest, compression and decompression that never leave a half-written file,
// and the size before compression from a gzip's trailer.
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { gzipSync } from 'zlib'
import { describe, expect, it } from 'vitest'
import { compressFile, decompressTo, expandBackup, gzSize, isGz, readBytes, readFirstLineOf, readTranscript } from '../src/main/transcriptFiles'
import { tempDir } from './tempDir'

const lines = Array.from({ length: 3000 }, (_, i) => JSON.stringify({ type: 'assistant', i, text: 'x'.repeat(i % 97) })).join('\n') + '\n'

async function readAll(path: string, from = 0, chunk?: number): Promise<{ text: string; offset: number }> {
  const parts: Buffer[] = []
  const offset = await readTranscript(path, from, (p) => parts.push(Buffer.from(p)), chunk)
  return { text: Buffer.concat(parts).toString('utf8'), offset }
}

describe('transcript files', () => {
  it('reads a plain and a compressed transcript to the same lines, from any line offset', async () => {
    const dir = tempDir('cw-transcript-files-')
    const plain = join(dir, 'a.jsonl')
    writeFileSync(plain, lines)
    const gz = join(dir, 'b.jsonl.gz')
    writeFileSync(gz, gzipSync(lines))
    expect(isGz(gz) && !isGz(plain)).toBe(true)
    for (const chunk of [64, 4096, 1 << 20]) {
      expect(await readAll(plain, 0, chunk)).toEqual({ text: lines, offset: Buffer.byteLength(lines) })
      expect(await readAll(gz, 0, chunk)).toEqual({ text: lines, offset: Buffer.byteLength(lines) })
    }
    const from = lines.indexOf('\n', 5000) + 1
    expect((await readAll(plain, from)).text).toBe(lines.slice(from))
    expect((await readAll(gz, from)).text).toBe(lines.slice(from))
  })

  it('reads a range of either (an image the viewer shows, where the parser saw it)', async () => {
    const dir = tempDir('cw-transcript-files-')
    const plain = join(dir, 'a.jsonl')
    writeFileSync(plain, lines)
    const gz = join(dir, 'b.jsonl.gz')
    writeFileSync(gz, gzipSync(lines))
    const all = Buffer.from(lines)
    for (const [from, to] of [[0, 10], [70_000, 70_500], [all.length - 20, all.length]]) {
      expect((await readBytes(plain, from, to)).equals(all.subarray(from, to))).toBe(true)
      expect((await readBytes(gz, from, to)).equals(all.subarray(from, to))).toBe(true)
    }
  })

  it('a range of a missing or damaged .gz fails its call, not the process', async () => {
    const dir = tempDir('cw-transcript-files-')
    const uncaught: unknown[] = []
    const onUncaught = (e: unknown): void => void uncaught.push(e)
    process.on('uncaughtException', onUncaught)
    try {
      await expect(readBytes(join(dir, 'missing.jsonl.gz'), 0, 10)).rejects.toThrow(/ENOENT/)
      writeFileSync(join(dir, 'bad.jsonl.gz'), 'not gzip at all')
      await expect(readBytes(join(dir, 'bad.jsonl.gz'), 0, 10)).rejects.toThrow()
      await expect(readFirstLineOf(join(dir, 'missing.jsonl.gz'))).rejects.toThrow(/ENOENT/)
      await expect(readAll(join(dir, 'missing.jsonl.gz'))).rejects.toThrow(/ENOENT/)
      // Any stream error left over would surface on a later tick.
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(uncaught).toEqual([])
    } finally {
      process.off('uncaughtException', onUncaught)
    }
  })

  it("leaves a plain file's line still being written for the next read", async () => {
    const dir = tempDir('cw-transcript-files-')
    const plain = join(dir, 'a.jsonl')
    writeFileSync(plain, '{"a":1}\n{"b":')
    expect(await readAll(plain)).toEqual({ text: '{"a":1}\n', offset: 8 })
  })

  it('reads the first line of either, and the size a compressed one holds', async () => {
    const dir = tempDir('cw-transcript-files-')
    const gz = join(dir, 'b.jsonl.gz')
    writeFileSync(gz, gzipSync(lines))
    expect(await readFirstLineOf(gz)).toBe(lines.slice(0, lines.indexOf('\n')))
    expect(await gzSize(gz)).toBe(Buffer.byteLength(lines))
    expect(await gzSize(join(dir, 'missing.gz'))).toBeNull()
  })

  it('compresses a file whole, and decompresses one, never leaving half of either', async () => {
    const dir = tempDir('cw-transcript-files-')
    const plain = join(dir, 's.jsonl')
    writeFileSync(plain, lines)
    const gz = await compressFile(plain)
    expect(gz).toBe(plain + '.gz')
    expect(existsSync(plain)).toBe(false)
    expect(readFileSync(gz).length).toBeLessThan(Buffer.byteLength(lines) / 3)
    const back = join(dir, 'back.jsonl')
    await decompressTo(gz, back)
    expect(readFileSync(back, 'utf8')).toBe(lines)
    // A damaged .gz: nothing written where it was to go, no temp file left.
    writeFileSync(join(dir, 'bad.jsonl.gz'), 'not gzip')
    await expect(decompressTo(join(dir, 'bad.jsonl.gz'), join(dir, 'out.jsonl'))).rejects.toThrow()
    expect(existsSync(join(dir, 'out.jsonl'))).toBe(false)
  })

  it("expands a backup for a move: its .gz decompressed in its place, or dropped beside a newer plain one", async () => {
    const dir = tempDir('cw-transcript-files-')
    const plain = join(dir, 's.jsonl')
    writeFileSync(plain + '.gz', gzipSync(lines))
    await expandBackup(plain)
    expect([readFileSync(plain, 'utf8') === lines, existsSync(plain + '.gz')]).toEqual([true, false])
    writeFileSync(plain + '.gz', gzipSync('old\n'))
    writeFileSync(plain, 'newer\n')
    await expandBackup(plain)
    expect([readFileSync(plain, 'utf8'), existsSync(plain + '.gz')]).toEqual(['newer\n', false])
  })
})
