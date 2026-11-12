// HI-3050: a jj slot whose `jj workspace add` failed made again under its name. The port makes the slot's folder itself,
// exclusively, and reads its id with it (design HI-3050/s10); a failed add's leftover is removed only while it is provably
// that folder, empty and registered nowhere, and anything else is kept and named in the setup error. On the real jj (the
// add failures are jj's own), with a runner around it to change things at exact points. Skipped without the fetched jj
// (npm run jj:fetch).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { TESTED_JJ } from '../src/shared/jjTool'
import { JJ_REFUSED, keptNote } from '../src/main/platform/jjWorkspacePort'
import type { JjPortDeps } from '../src/main/platform/jjWorkspacePort'
import type { JjRunner, JjRunResult, JjRunOptions } from '../src/main/platform/jjRunner'
import { harness, jjExe } from './jjWorkspaceHarness'

const REAL_JJ_MS = 180_000
/** A commit id no repository here has: jj's add fails on it after the folder is there ("doesn't exist"). */
const NO_SUCH = 'f'.repeat(40)

const idOf = (p: string): string => {
  const s = statSync(p, { bigint: true })
  return `${s.ino}:${s.birthtimeNs}`
}

type Run = (folder: string, args: readonly string[], o?: JjRunOptions) => Promise<JjRunResult>
const isAdd = (args: readonly string[]): boolean => args.includes('workspace') && args.includes('add')

/** A colocated project and a port whose `workspace add`s go through `onAdd` (the real jj's run given), counted. */
function project(name: string, onAdd?: (real: Run, folder: string, args: readonly string[], o?: JjRunOptions) => Promise<JjRunResult>, more: Partial<JjPortDeps> = {}) {
  const h = harness()
  const { repo, root, base } = h.repo(name, true)
  const folder = join(root, 'slot-a')
  const real: Run = (f, a, o) => h.runner.run(f, a, o)
  const adds: string[][] = []
  const run: Run = (f, a, o) => {
    // The control's own add is the project's (made once, before any slot's): only a slot's goes through onAdd.
    if (!isAdd(a) || !a.includes(folder)) return real(f, a, o)
    adds.push([...a])
    return onAdd ? onAdd(real, f, a, o) : real(f, a, o)
  }
  const runner = new Proxy(h.runner, { get: (t, k) => (k === 'run' ? run : (Reflect.get(t, k) as unknown)) }) as JjRunner
  const port = h.portWith({ runner, ...more })
  const listed = (): boolean => h.jj(repo, '--ignore-working-copy', 'workspace', 'list').includes(port.nameFor(repo, folder))
  const asides = (): string[] => readdirSync(root).filter((n) => n.startsWith('.cw-add-'))
  return { h, repo, root, base, folder, port, adds, listed, asides }
}

describe('keptNote (HI-3050/s10 §3)', () => {
  it("names what was kept on jj's Error: line (the one the pool shows), jj's full answer after it", () => {
    const err = 'Hint: something\nError: Revision `x` doesn\'t exist\nHint: more'
    const note = keptNote(err, 'C:\\w\\slot-a', 'notEmpty')
    expect(note.split('\n')[0]).toBe("Error: Revision `x` doesn't exist (its folder C:\\w\\slot-a was left as it is: notEmpty)")
    expect(note.endsWith(`\n${err}`)).toBe(true)
    // No Error: line (a refusal of Combwork's own): its first line.
    expect(keptNote(JJ_REFUSED.control, 'F', 'uncertain')).toBe(`Error: ${JJ_REFUSED.control} (its folder F was left as it is: uncertain)\n${JJ_REFUSED.control}`)
    expect(keptNote('', 'F', 'replaced')).toBe('Error: failed (its folder F was left as it is: replaced)')
  })
})

describe.skipIf(!jjExe)(`a jj slot whose add failed made again under its name (HI-3050, jj ${TESTED_JJ.version})`, { timeout: REAL_JJ_MS }, () => {
  it("a transient failure (its revision gone): jj's error alone, the folder it left removed, the retry made", async () => {
    const p = project('lo-ok')
    const r = await p.port.create(p.repo, p.folder, NO_SUCH)
    expect(r.ok).toBe(false)
    expect(r.err).toContain("doesn't exist")
    expect(r.err).not.toContain('left as it is')
    expect(p.adds).toHaveLength(1)
    expect(existsSync(p.folder)).toBe(false)
    expect(p.asides()).toEqual([])
    expect(p.listed()).toBe(false)
    // The cause gone: made again under the same name.
    expect(await p.port.create(p.repo, p.folder, p.base)).toEqual({ ok: true, err: '' })
    expect(existsSync(join(p.folder, 'base.txt'))).toBe(true)
    expect(p.listed()).toBe(true)
  })

  it("its name taken by a workspace elsewhere (jj refuses the add): the folder it left removed, the other workspace untouched", async () => {
    const p = project('lo-name')
    const other = join(p.root, 'other')
    p.h.jj(p.repo, 'workspace', 'add', other, '--name', p.port.nameFor(p.repo, p.folder), '--no-colocate')
    const id = idOf(other)
    const r = await p.port.create(p.repo, p.folder, p.base)
    expect(r.ok).toBe(false)
    expect(r.err).not.toContain('left as it is')
    expect(existsSync(p.folder)).toBe(false)
    expect(p.asides()).toEqual([])
    expect(idOf(other)).toBe(id)
    expect(p.listed()).toBe(true)
  })

  it("Git's refusal (a worktree entry planted after the check): kept for the entry, untouched; then refused for what is there", async () => {
    let plant: (() => void) | null = null
    const p = project('lo-link', undefined, {
      slotParentMade: () => {
        const f = plant
        plant = null
        f?.()
      }
    })
    const entry = join(p.repo, '.git', 'worktrees', 'slot-a')
    plant = () => {
      p.h.git(p.repo, 'worktree', 'add', '--detach', p.folder)
      rmSync(p.folder, { recursive: true, force: true })
    }
    const r = await p.port.create(p.repo, p.folder, p.base)
    expect(r.ok).toBe(false)
    expect(r.err.split('\n')[0]).toContain(`(its folder ${p.folder} was left as it is: gitLink)`)
    expect(p.port.errorLine(r.err)).toContain('gitLink')
    expect(existsSync(entry)).toBe(true)
    expect(readdirSync(p.folder)).toEqual([])
    expect(p.listed()).toBe(false)
    const id = idOf(p.folder)
    // A later make: refused for what it read there (nothing proves this folder its own now), everything as it was.
    expect((await p.port.create(p.repo, p.folder, p.base)).err).toBe(`${JJ_REFUSED.exists}, empty: ${JJ_REFUSED.existsLeft}`)
    expect(idOf(p.folder)).toBe(id)
    expect(existsSync(entry)).toBe(true)
    expect(p.adds).toHaveLength(1)
  })

  it('replaced after the failed add, before its first read: kept as replaced, the replacement untouched', async () => {
    let replacement = ''
    const p = project('lo-swap', async (real, f, a, o) => {
      const r = await real(f, a, o)
      const folder = a[2]
      rmdirSync(folder)
      mkdirSync(folder)
      replacement = idOf(folder)
      return r
    })
    const r = await p.port.create(p.repo, p.folder, NO_SUCH)
    expect(r.ok).toBe(false)
    expect(p.port.errorLine(r.err)).toContain('left as it is: replaced')
    expect(idOf(p.folder)).toBe(replacement)
    expect(p.asides()).toEqual([])
  })

  it('replaced between the last check and the move aside: moved back under its name, kept as replaced, nothing removed', async () => {
    let replacement = ''
    const p = project('lo-race', undefined, {
      hooks: {
        beforeLeftoverAside: (folder) => {
          rmdirSync(folder)
          mkdirSync(folder)
          replacement = idOf(folder)
        }
      }
    })
    const r = await p.port.create(p.repo, p.folder, NO_SUCH)
    expect(r.ok).toBe(false)
    expect(p.port.errorLine(r.err)).toContain(`its folder ${p.folder} was left as it is: replaced`)
    expect(replacement).not.toBe('')
    expect(idOf(p.folder)).toBe(replacement)
    expect(p.asides()).toEqual([])
  })

  it.each([
    ['empty', (f: string) => mkdirSync(f)],
    ['not empty', (f: string) => (mkdirSync(f), writeFileSync(join(f, 'mine.txt'), 'x\n'))]
  ] as const)('a folder made there before the add (%s): refused for what was read, no add run, untouched', async (what, make) => {
    let before: (() => void) | null = null
    const p = project(`lo-pre-${what === 'empty' ? 'e' : 'n'}`, undefined, {
      slotParentMade: () => {
        const f = before
        before = null
        f?.()
      }
    })
    before = () => make(p.folder)
    const r = await p.port.create(p.repo, p.folder, p.base)
    expect(r.err).toBe(`${JJ_REFUSED.exists}, ${what}: ${JJ_REFUSED.existsLeft}`)
    expect(p.adds).toHaveLength(0)
    expect(existsSync(p.folder)).toBe(true)
    if (what === 'not empty') expect(readFileSync(join(p.folder, 'mine.txt'), 'utf8')).toBe('x\n')
  })

  it('a file put in it after the failed add: kept as not empty, the file intact', async () => {
    const p = project('lo-file', async (real, f, a, o) => {
      const r = await real(f, a, o)
      writeFileSync(join(a[2], 'late.txt'), 'late\n')
      return r
    })
    const r = await p.port.create(p.repo, p.folder, NO_SUCH)
    expect(p.port.errorLine(r.err)).toContain('left as it is: notEmpty')
    expect(readFileSync(join(p.folder, 'late.txt'), 'utf8')).toBe('late\n')
  })

  it.each(['timedOut', 'cancelled', 'failed'] as const)('an add whose outcome is uncertain (%s, no exit of its own): kept, untouched', async (why) => {
    const p = project(`lo-${why.slice(0, 3)}`, async (real, f, a, o) => {
      await real(f, a, o)
      return { out: '', ok: false, buf: Buffer.alloc(0), err: `jj workspace add didn't run to an exit (${why})`, code: -1, notRun: why, ...(why === 'timedOut' ? { timedOut: true } : {}), ...(why === 'cancelled' ? { cancelled: true as const } : {}) }
    })
    const r = await p.port.create(p.repo, p.folder, NO_SUCH)
    expect(p.port.errorLine(r.err)).toContain('left as it is: uncertain')
    expect(existsSync(p.folder)).toBe(true)
  })

  it('an add refused before jj started (its last check): the folder this attempt made removed, the retry made', async () => {
    let refuse = true
    const p = project('lo-ref', async (real, f, a, o) => {
      if (!refuse) return real(f, a, o)
      refuse = false
      return { out: '', ok: false, buf: Buffer.alloc(0), err: '', code: -1, refused: JJ_REFUSED.control }
    })
    const r = await p.port.create(p.repo, p.folder, p.base)
    expect(r).toEqual({ ok: false, err: JJ_REFUSED.control })
    expect(existsSync(p.folder)).toBe(false)
    expect(await p.port.create(p.repo, p.folder, p.base)).toEqual({ ok: true, err: '' })
  })
})
