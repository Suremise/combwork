// HI-3534: a git speaking German, for tests that prove Combwork reads git's words in English whatever the user's
// language. Git ships no catalogues with Git for Windows, but it is built with gettext and reads one from
// GIT_TEXTDOMAINDIR: this writes a small German one (GNU .mo) of the messages the tests read, and the environment that
// makes git use it.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

/** git's English text, and the German a translated git prints instead. */
export const GERMAN: readonly (readonly [string, string])[] = [
  ['Removing %s/%s: %s', 'Entferne %s/%s: %s'],
  ['gitdir file points to non-existent location', 'gitdir-Datei verweist auf nicht existierenden Ort'],
  ['not a git repository (or any of the parent directories): %s', 'Kein Git-Repository (oder irgendeines der Elternverzeichnisse): %s']
]

/** A GNU .mo catalogue of `pairs` (msgid, msgstr), with its header. */
export function moCatalogue(pairs: readonly (readonly [string, string])[]): Buffer {
  const all = [['', 'Content-Type: text/plain; charset=UTF-8\n'], ...pairs].map(([o, t]) => [Buffer.from(o, 'utf8'), Buffer.from(t, 'utf8')] as const).sort((a, b) => Buffer.compare(a[0], b[0]))
  const n = all.length
  const origAt = 28
  const transAt = origAt + n * 8
  const head = Buffer.alloc(transAt + n * 8)
  head.writeUInt32LE(0x950412de, 0)
  head.writeUInt32LE(n, 8)
  head.writeUInt32LE(origAt, 12)
  head.writeUInt32LE(transAt, 16)
  const body: Buffer[] = []
  let at = head.length
  const place = (s: Buffer, table: number, i: number): void => {
    head.writeUInt32LE(s.length, table + i * 8)
    head.writeUInt32LE(at, table + i * 8 + 4)
    body.push(s, Buffer.from([0]))
    at += s.length + 1
  }
  all.forEach(([o], i) => place(o, origAt, i))
  all.forEach(([, t], i) => place(t, transAt, i))
  return Buffer.concat([head, ...body])
}

/** Writes the German catalogue under `dir`; the environment that has git speak German with it. */
export function germanGit(dir: string): Record<string, string> {
  const at = join(dir, 'de', 'LC_MESSAGES')
  mkdirSync(at, { recursive: true })
  writeFileSync(join(at, 'git.mo'), moCatalogue(GERMAN))
  return { GIT_TEXTDOMAINDIR: dir, LANGUAGE: 'de', LC_ALL: 'de_DE.UTF-8', LANG: 'de_DE.UTF-8' }
}

/** Runs `fn` with `vars` in this process's environment (which git's runner and the tests' `sh` hand on), then puts it back. */
export async function withProcessEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before = new Map(Object.keys(vars).map((k) => [k, process.env[k]] as const))
  Object.assign(process.env, vars)
  try {
    return await fn()
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}
