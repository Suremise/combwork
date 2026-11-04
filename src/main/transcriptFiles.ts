import { createReadStream, createWriteStream } from 'original-fs'
import { open, rename, rm, stat } from 'original-fs/promises'
import { pipeline } from 'stream/promises'
import { createGunzip, createGzip, constants } from 'zlib'

/**
 * Hive's transcript backups compressed (#1110): a session's backup (`.combwork/sessions` or `.combwork/archive`, `<id>.jsonl`)
 * is gzipped to `<id>.jsonl.gz` once it ends or is archived (to under a third: pasted images shrink little), and everything that reads a
 * backup reads it through here, compressed or not: the transcript viewer, search and export, usage (the usage worker
 * too: no Electron here), a sub-session's first line, and a resume that puts a backup back where the CLI looks. A
 * resumed session's live backup is plain `.jsonl` again (copied whole from the CLI's transcript) until it ends; while
 * both exist, the plain one is the newer.
 */

export const GZ = '.gz'
export const isGz = (path: string): boolean => path.toLowerCase().endsWith(GZ)

/**
 * Reads a transcript's whole lines from `from` on (decompressed: a `.gz` one from its start, skipping what is before
 * `from`), handing each piece to `take`, a few MB at a time so a long one isn't held whole. A plain file's last line,
 * still being written without its newline, is left for the next read; a `.gz` one's is given (the file is finished).
 * Returns the offset after what was given.
 */
export async function readTranscript(path: string, from: number, take: (piece: Buffer) => void, chunk = 4 * 1024 * 1024): Promise<number> {
  if (isGz(path)) return readGz(path, from, take, chunk)
  const size = (await stat(path)).size
  let offset = from
  if (size <= offset) return offset
  const fh = await open(path, 'r')
  try {
    let piece = chunk
    while (offset < size) {
      const buf = Buffer.alloc(Math.min(piece, size - offset))
      const { bytesRead } = await fh.read(buf, 0, buf.length, offset)
      const end = buf.subarray(0, bytesRead).lastIndexOf(0x0a)
      if (end < 0) {
        // One line longer than the piece (a large image or tool output): read a bigger piece.
        if (bytesRead === buf.length && offset + bytesRead < size) {
          piece *= 2
          continue
        }
        break
      }
      take(buf.subarray(0, end + 1))
      offset += end + 1
      if (bytesRead < buf.length) break
    }
  } finally {
    await fh.close()
  }
  return offset
}

/** A `.gz` transcript's whole lines from `from` (of its decompressed bytes) on. */
async function readGz(path: string, from: number, take: (piece: Buffer) => void, chunk: number): Promise<number> {
  let at = 0
  let rest: Buffer = Buffer.alloc(0)
  const give = (b: Buffer): void => {
    // What is before `from` (read before) is skipped.
    if (at + b.length <= from) {
      at += b.length
      return
    }
    const skip = Math.max(0, from - at)
    at += skip
    const tail = b.subarray(skip)
    at += tail.length
    take(tail)
  }
  const gunzip = createGunzip({ chunkSize: Math.min(chunk, 1024 * 1024) })
  gunzip.on('data', (d: Buffer) => {
    const all = rest.length ? Buffer.concat([rest, d]) : d
    const end = all.lastIndexOf(0x0a)
    if (end < 0) {
      rest = all
      return
    }
    give(all.subarray(0, end + 1))
    rest = Buffer.from(all.subarray(end + 1))
  })
  await pipeline(createReadStream(path), gunzip)
  if (rest.length) give(rest)
  return Math.max(at, from)
}

/**
 * A transcript's bytes from `from` to `to` (of its decompressed bytes): an image the viewer shows, found by where the
 * parser saw it. A `.gz` one is decompressed only as far as `to`.
 */
export async function readBytes(path: string, from: number, to: number): Promise<Buffer> {
  if (!isGz(path)) {
    const fh = await open(path, 'r')
    try {
      const buf = Buffer.alloc(to - from)
      const { bytesRead } = await fh.read(buf, 0, buf.length, from)
      return buf.subarray(0, bytesRead)
    } finally {
      await fh.close()
    }
  }
  const src = createReadStream(path)
  const gunzip = createGunzip()
  // pipe() doesn't pass the file's errors on (a backup gone or unreadable): fail the decompression with them, so the
  // loop below throws them rather than the process seeing an unhandled stream error.
  src.on('error', (e) => gunzip.destroy(e))
  const parts: Buffer[] = []
  let at = 0
  try {
    for await (const d of src.pipe(gunzip) as AsyncIterable<Buffer>) {
      const end = at + d.length
      if (end > from) parts.push(d.subarray(Math.max(0, from - at), Math.min(d.length, to - at)))
      at = end
      if (at >= to) break
    }
  } finally {
    src.destroy()
    gunzip.destroy()
  }
  return Buffer.concat(parts)
}

/** A transcript's first line, at most `max` bytes of it (a sub-session's check). */
export async function readFirstLineOf(path: string, max = 1 << 20): Promise<string> {
  if (!isGz(path)) {
    const fh = await open(path, 'r')
    try {
      let out = ''
      const buf = Buffer.alloc(64 * 1024)
      let pos = 0
      while (out.length < max) {
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos)
        if (!bytesRead) break
        const piece = buf.toString('utf8', 0, bytesRead)
        const nl = piece.indexOf('\n')
        if (nl >= 0) return out + piece.slice(0, nl)
        out += piece
        pos += bytesRead
      }
      return out
    } finally {
      await fh.close()
    }
  }
  // Decompressed only as far as its first line.
  return new Promise((resolve, reject) => {
    let out = ''
    const src = createReadStream(path)
    const gunzip = createGunzip()
    const done = (s: string): void => {
      src.destroy()
      gunzip.destroy()
      resolve(s)
    }
    gunzip.on('data', (d: Buffer) => {
      const piece = d.toString('utf8')
      const nl = piece.indexOf('\n')
      if (nl >= 0) return done(out + piece.slice(0, nl))
      out += piece
      if (out.length >= max) done(out)
    })
    gunzip.on('end', () => done(out))
    gunzip.on('error', reject)
    src.on('error', reject)
    src.pipe(gunzip)
  })
}

/**
 * Gzips a finished backup: `<file>` to `<file>.gz`, written aside and put in place whole, the plain file removed only
 * after. Returns the compressed file. A failure part way leaves the plain file as it was (and no partial `.gz`).
 */
export async function compressFile(path: string): Promise<string> {
  const dest = path + GZ
  const tmp = `${dest}.${process.pid}-${Date.now()}.tmp`
  try {
    await pipeline(createReadStream(path), createGzip({ level: constants.Z_DEFAULT_COMPRESSION }), createWriteStream(tmp))
    await rename(tmp, dest)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
  await rm(path, { force: true })
  return dest
}

/** Writes a `.gz` file's content, decompressed, to `dest` (written aside and put in place whole). */
export async function decompressTo(gz: string, dest: string): Promise<void> {
  const tmp = `${dest}.${process.pid}-${Date.now()}.tmp`
  try {
    await pipeline(createReadStream(gz), createGunzip(), createWriteStream(tmp))
    await rename(tmp, dest)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
}

/**
 * A backup's plain `.jsonl` again, for what moves or appends to it (archiving): its `.gz` decompressed in its place, or
 * dropped when a plain one is beside it (the newer: written since a resume).
 */
export async function expandBackup(plain: string): Promise<void> {
  const gz = plain + GZ
  if (!(await stat(gz).catch(() => null))) return
  if (!(await stat(plain).catch(() => null))) await decompressTo(gz, plain)
  await rm(gz, { force: true })
}

/** What a `.gz` file holds before compression, from its trailer (the size modulo 4 GiB); null when unreadable. */
export async function gzSize(path: string): Promise<number | null> {
  try {
    const fh = await open(path, 'r')
    try {
      const size = (await fh.stat()).size
      if (size < 18) return null
      const buf = Buffer.alloc(4)
      await fh.read(buf, 0, 4, size - 4)
      return buf.readUInt32LE(0)
    } finally {
      await fh.close()
    }
  } catch {
    return null
  }
}
