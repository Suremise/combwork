// No network reply reaches Node's Brotli decoder (#1582, CVE-2026-111497; kept after HI-1503's Electron with Node 24.22.1).
// fetch decompresses `Content-Encoding: br` with it, so Combwork's code that runs in Node (main, preload, shared, the hive
// MCP server) calls fetch only for Combwork's own local API, and decompresses Brotli only for its own data. Network calls
// go through plainHttpsJson, which refuses an encoded reply.
import { readdirSync, readFileSync } from 'fs'
import { join, relative } from 'path'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname, '..', 'src')
// Node's code: everything but the renderer, whose fetch is Chromium's.
const ROOTS = ['main', 'preload', 'shared'].map((d) => join(SRC, d))

/** fetch to Combwork's own local API (the Agent API on 127.0.0.1) only: the hive MCP server and hive-progress's reports. */
const FETCH_ALLOWED = ['main/mcp/hive-mcp.ts', 'main/progressReporters/report.mts']
/** Brotli decompression of Combwork's own data only (the journal's compressed details, usage.db's saved parser states: HI-1912). */
const BROTLI_ALLOWED = ['main/journal.ts', 'main/usageParsers.ts']

const FETCH = /(?<![.\w$])fetch\s*\(|globalThis\.fetch\b|from ['"]undici['"]|require\(['"]undici['"]\)/
const BROTLI = /\b(brotliDecompress|brotliDecompressSync|createBrotliDecompress|BrotliDecompress)\b|\bDecompressionStream\b|\bzlib\.decompress/

/** Every source file under a folder. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : /\.(ts|tsx|mts|cts|js|cjs|mjs)$/.test(e.name) ? [join(dir, e.name)] : []))
}

/** A file's code, its comments left out (they name fetch to explain why it isn't used). */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
}

function users(re: RegExp): string[] {
  return ROOTS.flatMap(sources)
    .filter((f) => re.test(code(f)))
    .map((f) => relative(SRC, f).replace(/\\/g, '/'))
    .sort()
}

describe('network replies and Node’s Brotli decoder (#1582)', () => {
  it('calls fetch only for Combwork’s local API: network calls use plainHttpsJson', () => {
    expect(users(FETCH)).toEqual(FETCH_ALLOWED)
  })

  it('decompresses Brotli only for Combwork’s own data', () => {
    expect(users(BROTLI)).toEqual(BROTLI_ALLOWED)
  })

  it('catches the forms it looks for', () => {
    for (const s of ["await fetch('https://x')", 'fetch (url)', 'globalThis.fetch', "import { request } from 'undici'"]) expect(FETCH.test(s), s).toBe(true)
    for (const s of ['scopedFetch(x)', 'this.fetch(x)', 'net.fetch(x)', 'prefetch(x)']) expect(FETCH.test(s), s).toBe(false)
    for (const s of ['brotliDecompressSync(b)', 'zlib.createBrotliDecompress()', 'new DecompressionStream("br")', 'zlib.decompress(b)']) expect(BROTLI.test(s), s).toBe(true)
  })
})
