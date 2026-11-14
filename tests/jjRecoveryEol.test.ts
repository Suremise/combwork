// Recover… when jj converts line endings (HI-3098, from HI-3058's hunt): the user's own `working-copy.eol-conversion`
// (`input-output`: CRLF in the folder, LF in commits; `input`: LF in commits). Recover… compares the folder's bytes with
// commits as jj will store them (`storedForm`), so an untouched file is no edit, its preserved commit is tidied and no
// copies are left; edits come back byte for byte. `storedForm`'s rule is jj 0.47.1's, probed: below, at its edges.
// The real-jj cases are skipped without the fetched jj (npm run jj:fetch).

import { execFileSync } from 'child_process'
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { recoverStale, storedForm, type GitRun, type RecoveryResult } from '../src/main/platform/jjRecovery'
import { isUnknown } from '../src/main/platform/types'
import { harness, jjExe } from './jjWorkspaceHarness'
import { tempDir } from './tempDir'

const yes = { still: () => true }
const quiet = async (): Promise<boolean> => true

describe('a file as jj stores it under eol-conversion (storedForm, HI-3098)', () => {
  const b = (s: string): Buffer => Buffer.from(s, 'latin1')
  it('none: the bytes as they are', () => {
    expect(storedForm(b('a\r\nb\r\n'), 'none')).toEqual(b('a\r\nb\r\n'))
  })
  it.each(['input', 'input-output'] as const)('%s: every CRLF as LF in a text file, a lone CR past the window kept', (eol) => {
    expect(storedForm(b('a\r\nb\r\n'), eol)).toEqual(b('a\nb\n'))
    expect(storedForm(b('a\r\nb\nc\r\n'), eol)).toEqual(b('a\nb\nc\n'))
    expect(storedForm(b('\r\n'), eol)).toEqual(b('\n'))
    expect(storedForm(b('a\r\n' + 'y'.repeat(20000) + '\rz\r\n'), eol)).toEqual(b('a\n' + 'y'.repeat(20000) + '\rz\n'))
  })
  it.each(['input', 'input-output'] as const)('%s: binary (a NUL or a lone CR in the first 8192 bytes) as it is', (eol) => {
    expect(storedForm(b('\0a\r\n'), eol)).toEqual(b('\0a\r\n'))
    expect(storedForm(b('a\rb\r\n'), eol)).toEqual(b('a\rb\r\n'))
    expect(storedForm(b('a\r\n\r'), eol).toString('latin1')).toBe('a\n\r')
    // The window's edges, as jj 0.47.1 has them: a NUL at index 8191 is in it, at 8192 not.
    expect(storedForm(b('x'.repeat(8191) + '\0\r\n'), eol)).toEqual(b('x'.repeat(8191) + '\0\r\n'))
    expect(storedForm(b('x'.repeat(8192) + '\0\r\n'), eol)).toEqual(b('x'.repeat(8192) + '\0\n'))
    // A lone CR at index 8190 counts (its next byte in the window); at 8191, its next byte outside, not.
    expect(storedForm(b('a\r\n' + 'x'.repeat(8187) + '\rz'), eol)).toEqual(b('a\r\n' + 'x'.repeat(8187) + '\rz'))
    expect(storedForm(b('a\r\n' + 'x'.repeat(8188) + '\rz'), eol)).toEqual(b('a\n' + 'x'.repeat(8188) + '\rz'))
  })
})

/** A slot gone stale (its commit rebased from the project folder) with local edits, then Recover…. */
async function staleRun(eol: string | null, colocated: boolean, crlf = false): Promise<{ r: RecoveryResult; slot: string; files: string[]; head: unknown; divergent: string }> {
  const h = harness()
  if (eol) appendFileSync(h.env.JJ_CONFIG!, `[working-copy]\neol-conversion = "${eol}"\n`)
  const { repo, root } = h.repo('eol', colocated)
  writeFileSync(join(repo, 'shared.txt'), 'one\ntwo\n')
  writeFileSync(join(repo, 'a.txt'), 'a1\na2\n')
  writeFileSync(join(repo, 'b.txt'), 'b1\nb2\n')
  writeFileSync(join(repo, 'data.bin'), Buffer.from('\0bin\r\n', 'latin1'))
  h.jj(repo, 'commit', '-m', 'shared')
  const base = h.id(repo, '@-')
  const slot = join(root, 'slot-a')
  expect((await h.port.create(repo, slot, base)).ok).toBe(true)
  const name = h.port.nameFor(repo, slot)
  writeFileSync(join(slot, 'early.txt'), 'early\n')
  h.jj(slot, 'status')
  h.jj(repo, 'new', base, '-m', 'dest')
  writeFileSync(join(repo, 'd.txt'), 'd\n')
  h.jj(repo, 'status')
  h.jj(repo, 'rebase', '-r', `${name}@`, '-d', '@')
  writeFileSync(join(slot, 'local.txt'), crlf ? 'mine\r\n' : 'mine\n')
  if (crlf) {
    writeFileSync(join(slot, 'a.txt'), 'a1\r\nA2 edited\r\n')
    // A binary file edited: jj keeps its CRLF, so it is an edit.
    writeFileSync(join(slot, 'data.bin'), Buffer.from('\0bin edited\r\n', 'latin1'))
  }
  const id = (await h.port.identity!(slot))!
  const git: GitRun = async (cwd, args) => {
    try {
      const buf = execFileSync('git', args, { cwd, env: h.env, windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
      return { ok: true, out: buf.toString('utf8'), buf, err: '' }
    } catch (e) {
      const err = e as { stderr?: Buffer; stdout?: Buffer }
      return { ok: false, out: err.stdout?.toString('utf8') ?? '', buf: err.stdout ?? Buffer.alloc(0), err: err.stderr?.toString('utf8') ?? String(e) }
    }
  }
  const preserveRoot = join(tempDir('jj-preserve-'), '.cw-recovery')
  const r = await recoverStale({ port: h.port, git, preserveRoot, trash: async () => undefined }, { repo, folder: slot, identity: id, journal: h.journals.of('rec'), fence: yes, quiet })
  const head = await h.port.head(slot)
  const divergent = h.jj(repo, '--ignore-working-copy', 'log', '--no-graph', '-r', `${name}@`, '-T', 'divergent')
  return { r, slot, files: readdirSync(slot).sort(), head, divergent }
}

describe.skipIf(!jjExe)('Recover… with jj line-ending conversion on (HI-3098)', { timeout: 120_000 }, () => {
  for (const colocated of [true, false]) {
    const layout = colocated ? 'colocated' : 'non-colocated'
    it(`control, no conversion (${layout}): only the local edit restored, no copies`, async () => {
      const x = await staleRun(null, colocated)
      expect(x.r).toMatchObject({ ok: true, restored: ['local.txt'], beside: [], late: [], xKept: false })
      expect(x.files.filter((f) => f.includes('.cw-'))).toEqual([])
    })
    for (const eol of ['input-output', 'input']) {
      it(`eol-conversion = ${eol} (${layout}): only the local edit restored, no copies, X tidied, the head readable`, async () => {
        const x = await staleRun(eol, colocated)
        expect(x.r).toMatchObject({ ok: true, restored: ['local.txt'], beside: [], late: [], xKept: false })
        expect(x.files.filter((f) => f.includes('.cw-'))).toEqual([])
        expect(isUnknown(x.head)).toBe(false)
        expect(x.divergent).toBe('false')
      })
    }
    it(`eol-conversion = input-output with CRLF edits (${layout}): each edit back byte for byte, no copies, not divergent`, async () => {
      const x = await staleRun('input-output', colocated, true)
      expect(x.r).toMatchObject({ ok: true, beside: [], late: [], xKept: false })
      if (x.r.ok) expect([...x.r.restored].sort()).toEqual(['a.txt', 'data.bin', 'local.txt'])
      expect(x.files.filter((f) => f.includes('.cw-'))).toEqual([])
      expect(readFileSync(join(x.slot, 'a.txt'), 'latin1')).toBe('a1\r\nA2 edited\r\n')
      expect(readFileSync(join(x.slot, 'local.txt'), 'latin1')).toBe('mine\r\n')
      expect(readFileSync(join(x.slot, 'data.bin'), 'latin1')).toBe('\0bin edited\r\n')
      expect(isUnknown(x.head)).toBe(false)
      expect(x.divergent).toBe('false')
    })
  }
})
