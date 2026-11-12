// HI-3047: a timed command's Git Bash (MSYS) programs are ended with its tree. MSYS's exec leaves such a program with a
// Windows parent id that names a process already gone, so it is found by a marker in its environment instead
// (processTree's MsysMark): which of its output's matches are taken (msysMatches: the same winpid around the read, a start
// no later than the second read), the script that asks MSYS (builtins only: it starts nothing), its bounds, the fallback
// when it fails (the native tree still ended, and said), the exact entry match against Git's own sh, and which MSYS folder
// a git's is (msysBinFor). The end-to-end case, a slow hook's sleep, is tests/gitFolderChanges.test.ts's (HI-3021's).
// Windows only where real processes run; tempDir() only.
import { spawn, type ChildProcess } from 'child_process'
import { randomBytes } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { msysBinFor } from '../src/main/gitWorker'
import { boundedOutput, endTreeAsync, findMsysMarked, msysMatches, MSYS_FIND_SCRIPT, RUN_MARK_VAR, treesToEnd, type ListedProcess } from '../src/main/processTree'
import { tempDir } from './tempDir'

const req = createRequire(import.meta.url)
const { baseEnv } = req('./e2e/runContext.cjs') as { baseEnv: () => Record<string, string> }
type Ids = { pid: number; started: number }[]
const { identify, endExactly } = req('./e2e/folderProcesses.cjs') as { identify: (pids: number[]) => Ids; endExactly: (targets: Ids) => number }

const isWin = process.platform === 'win32'
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
/** Processes a test started and must not leave behind: their identities, taken as each reported its pid (#603). */
const spawned: Ids = []
const own = (pid: number): void => void spawned.push(...identify([pid]))
afterEach(() => {
  endExactly(spawned.splice(0))
})

const p = (pid: number, started: number, parent = 0): ListedProcess => ({ pid, parent, started })

/**
 * Git Bash: `sleep 30` in the background, its winpid written to `$1` once it is sleep (until MSYS's exec, `$!` names the
 * forked sh.exe, another Windows process), then the shell exits, leaving the sleep's Windows parent gone.
 */
const SLEEPER = 'sleep 30 & while :; do read -r e < /proc/$!/exename; case "$e" in */sleep*) break;; esac; done; read -r w < /proc/$!/winpid; echo "$w" > "$1"; exit 0'
/** The `t` line for `ms` (Unix ms), as $EPOCHREALTIME prints it. */
const at = (ms: number): string => `t ${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, '0')}000`
/** A search's output: its time taken before any read (`t`), its lines, `end`. */
const said = (t: number, ...lines: string[]): string => [at(t), ...lines, 'end'].join('\n')

describe('msysMatches: which marked MSYS programs are ended (HI-3047)', () => {
  const list = [p(100, 1000), p(200, 1000), p(300, 5000), p(400, 1000), p(500, 2000, 100), p(600, 500, 100)]
  it('a match with the same winpid around the read, in the listing, started before the search: taken', () => {
    expect(msysMatches(said(3000, 'a 7 100', 'm 7 100', 'b 7 100'), list)).toEqual([p(100, 1000)])
  })
  it('an MSYS program without the marker: nothing', () => {
    expect(msysMatches(said(3000, 'a 7 100', 'a 8 200', 'b 7 100', 'b 8 200'), list)).toEqual([])
  })
  it('its pid named another winpid before or after the read (exec, or the pid given out again): nothing', () => {
    expect(msysMatches(said(3000, 'a 7 400', 'm 7 100', 'b 7 100'), list)).toEqual([])
    expect(msysMatches(said(3000, 'a 7 100', 'm 7 100', 'b 7 400'), list)).toEqual([])
    expect(msysMatches(said(3000, 'm 7 100', 'b 7 100'), list)).toEqual([])
    expect(msysMatches(said(3000, 'a 7 100', 'm 7 100'), list)).toEqual([])
  })
  it('its winpid not listed, or listed with a start after the search began: nothing', () => {
    expect(msysMatches(said(3000, 'a 7 900', 'm 7 900', 'b 7 900'), list)).toEqual([])
    expect(msysMatches(said(3000, 'a 7 300', 'm 7 300', 'b 7 300'), list)).toEqual([])
  })
  it("HR2's round 1: the marked process exits after its environment's read and both its ids go to a new process before the last read: the new one, started during the search, is never taken", () => {
    // The search began at 2000; every id agrees in all three reads, but the process listed with them started at 2500.
    const replaced = [p(100, 2500)]
    expect(msysMatches(said(2000, 'a 7 100', 'm 7 100', 'b 7 100'), replaced)).toEqual([])
    // The original, started before the search, still listed: taken.
    expect(msysMatches(said(2000, 'a 7 100', 'm 7 100', 'b 7 100'), [p(100, 500)])).toEqual([p(100, 500)])
  })
  it('malformed or cut short: null (the search incomplete), never a guess', () => {
    expect(msysMatches([at(3000), 'a 7 100', 'm 7 100'].join('\n'), list)).toBeNull()
    expect(msysMatches(['a 7 100', 'm 7 100', 'b 7 100', 'end'].join('\n'), list)).toBeNull()
    expect(msysMatches(said(3000, 'a 7 100', 'm 7 x', 'b 7 100'), list)).toBeNull()
    expect(msysMatches(said(3000, 'a 7 100', 'COMBWORK_RUN=abc'), list)).toBeNull()
    expect(msysMatches(said(3000, 'a 7 100', at(3000)), list)).toBeNull()
    expect(msysMatches('', list)).toBeNull()
  })
  it("each match's own tree is ended too, children first, each once; an older orphan with its pid as parent left alone", () => {
    // 500 is 100's child; 600 names 100 as parent but started before it (another, older process's child): left alone.
    expect(treesToEnd(list, 400, [p(100, 1000)]).map((x) => x.pid)).toEqual([500, 100, 400])
    expect(treesToEnd(list, 100, [p(100, 1000)]).map((x) => x.pid)).toEqual([500, 100])
  })
})

describe('the MSYS search script starts nothing (HI-3047)', () => {
  it('builtins only: no command substitution, pipe, subshell or background job (&& and || are fine)', () => {
    const s = MSYS_FIND_SCRIPT
    expect(s).not.toMatch(/\$\(|`|[()]/)
    expect(s).not.toMatch(/(?<!\|)\|(?!\|)/)
    expect(s).not.toMatch(/(?<![&>])&(?!&)/)
    // Each command's first word (after do/then, and a variable set before it) is a builtin or a keyword.
    const words = s
      .split(/\n|;|&&|\|\|/)
      .map((c) => c.trim().replace(/^(do|then)\s+/, '').replace(/^(\w+=\S*\s+)+/, ''))
      .filter((c) => c && !/^\w+=\S*$/.test(c))
      .map((c) => c.split(/\s+/)[0])
    expect(words.filter((w) => !['cd', 'exit', 'for', 'do', 'done', 'while', 'read', 'if', '[', 'then', 'fi', 'break', 'echo'].includes(w))).toEqual([])
    expect(words).toContain('read')
    expect(s).toContain(`"${RUN_MARK_VAR}=$1"`)
  })
})

describe.skipIf(!isWin)('bounded: the search ended at its limits, nothing left (HI-3047)', () => {
  it('past its time limit: an error, and its process gone', async () => {
    const r = await boundedOutput(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 500, maxBuffer: 1024, env: baseEnv() })
    expect(r).toMatchObject({ error: 'it ran past its time limit' })
    const pid = 'pid' in r ? r.pid! : 0
    expect(pid).toBeGreaterThan(0)
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 10_000 })
  })
  it('output past its cap: an error, and its process gone', async () => {
    const r = await boundedOutput(process.execPath, ['-e', "setInterval(() => process.stdout.write('x'.repeat(4096)), 1)"], { timeoutMs: 20_000, maxBuffer: 64 * 1024, env: baseEnv() })
    expect(r).toMatchObject({ error: 'its output passed the cap' })
    const pid = 'pid' in r ? r.pid! : 0
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 10_000 })
  })
  it("a shell that isn't there: an error", async () => {
    expect(await findMsysMarked({ mark: 'ab', bin: join(tempDir('msys-none-'), 'usr', 'bin') })).toMatchObject({ error: expect.stringMatching(/couldn't run/) })
  })
})

describe.skipIf(!isWin)('endTreeAsync with an MsysMark (HI-3047)', () => {
  /** A node process that starts a child and waits: a tree to end. Its child's pid in `child.pid`'s file. */
  const tree = async (): Promise<{ top: ChildProcess; child: number }> => {
    const file = join(tempDir('msys-tree-'), 'child.pid')
    const top = spawn(process.execPath, ['-e', `const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); require('fs').writeFileSync(${JSON.stringify(file)}, String(c.pid)); setInterval(() => {}, 1000)`], { stdio: 'ignore', windowsHide: true, env: baseEnv() })
    own(top.pid!)
    await vi.waitFor(() => expect(existsSync(file) && readFileSync(file, 'utf8').length > 0).toBe(true), { timeout: 20_000 })
    const child = Number(readFileSync(file, 'utf8'))
    own(child)
    return { top, child }
  }
  const lone = (): number => {
    const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, env: baseEnv() })
    own(c.pid!)
    return c.pid!
  }

  it('a search that fails, or answers malformed: the native tree still ended, and why said', async () => {
    for (const answer of [{ error: 'it ran past its time limit' }, { out: 'a 1 2\nnonsense' }]) {
      const { top, child } = await tree()
      const why: string[] = []
      await endTreeAsync(top, 'win32', { mark: 'ab', bin: 'x', onIncomplete: (w) => why.push(w), discover: async () => answer })
      await vi.waitFor(() => expect([alive(top.pid!), alive(child)]).toEqual([false, false]), { timeout: 10_000 })
      expect(why).toEqual(['error' in answer ? answer.error : 'its answer was malformed'])
    }
  }, 60_000)

  it('a match outside the tree is ended with it; an unrelated process, and one the answer names but started after the search began, are not', async () => {
    const { top, child } = await tree()
    const marked = lone()
    const unrelated = lone()
    // The search "began" as `marked` started (its listed start, from identify); `late` starts after that listing.
    const began = spawned.find((s) => s.pid === marked)!.started
    const late = lone()
    expect(spawned.find((s) => s.pid === late)!.started).toBeGreaterThan(began)
    const out = said(began, 'a 5 ' + marked, 'a 6 ' + late, 'm 5 ' + marked, 'm 6 ' + late, 'b 5 ' + marked, 'b 6 ' + late)
    const why: string[] = []
    await endTreeAsync(top, 'win32', { mark: 'ab', bin: 'x', onIncomplete: (w) => why.push(w), discover: async () => ({ out }) })
    await vi.waitFor(() => expect([alive(top.pid!), alive(child), alive(marked)]).toEqual([false, false, false]), { timeout: 10_000 })
    expect([alive(unrelated), alive(late)]).toEqual([true, true])
    expect(why).toEqual([])
  }, 60_000)
})

describe.skipIf(!isWin)("Git's own sh finds exactly the marker's entry (HI-3047)", () => {
  const bin = isWin ? msysBinFor({ env: process.env }) : null
  it.skipIf(!bin)('exact: found; a longer value either side, the marker inside another variable, none: not; nothing but ids printed', async () => {
    const mark = randomBytes(16).toString('hex')
    const dir = tempDir('msys-marked-')
    /**
     * A Git Bash shell that starts a background sleep, writes its winpid and exits (the sleep outlives it, its parent
     * gone). Its winpid once it is sleep: until MSYS's exec, `$!` is the forked sh.exe, another Windows process.
     */
    const sleeper = async (name: string, vars: Record<string, string>): Promise<number> => {
      const file = join(dir, name)
      spawn(join(bin!, 'sh.exe'), ['-c', SLEEPER, 'sh', file.replace(/\\/g, '/')], { stdio: 'ignore', windowsHide: true, env: { ...baseEnv(), ...vars } })
      await vi.waitFor(() => expect(existsSync(file) && /\d/.test(readFileSync(file, 'utf8'))).toBe(true), { timeout: 20_000 })
      const pid = Number(readFileSync(file, 'utf8').trim())
      own(pid)
      return pid
    }
    const exact = await sleeper('exact', { [RUN_MARK_VAR]: mark })
    const others = [
      await sleeper('suffix', { [RUN_MARK_VAR]: `${mark}0` }),
      await sleeper('prefix', { [RUN_MARK_VAR]: `0${mark}` }),
      await sleeper('embedded', { OTHER: `${RUN_MARK_VAR}=${mark}` }),
      await sleeper('none', {})
    ]
    const r = await findMsysMarked({ mark, bin: bin! })
    expect(r).toHaveProperty('out')
    const out = 'out' in r ? r.out : ''
    expect(out).not.toContain(mark)
    expect(out.trim().split(/\r?\n/).at(-1)).toBe('end')
    const winpids = out.split(/\r?\n/).filter((l) => l.startsWith('m ')).map((l) => Number(l.split(' ')[2]))
    expect(winpids).toEqual([exact])
    const list = [exact, ...others].map((pid) => p(pid, 0))
    expect(msysMatches(out, list)).toEqual([p(exact, 0)])
  }, 60_000)
})

describe('msysBinFor: the MSYS folder of the git started (HI-3047)', () => {
  const root = 'C:\\Git'
  const has = (...files: string[]) => (f: string): boolean => files.includes(f)
  const msys = has(join(root, 'usr', 'bin', 'msys-2.0.dll'), join(root, 'usr', 'bin', 'sh.exe'), join(root, 'cmd', 'git.exe'))
  it("from the launcher's folders, the real git's own, or PATH's git; null where there's no MSYS beside it", () => {
    expect(msysBinFor({ exe: join(root, 'mingw64', 'bin', 'git.exe'), launcherEnv: { pathFirst: [join(root, 'mingw64', 'bin'), join(root, 'usr', 'bin')].join(';'), msystem: 'MINGW64' } }, msys)).toBe(join(root, 'usr', 'bin'))
    expect(msysBinFor({ exe: join(root, 'ucrt64', 'libexec', 'git-core', 'git.exe') }, msys)).toBe(join(root, 'usr', 'bin'))
    expect(msysBinFor({ env: { PATH: `C:\\Other;${join(root, 'cmd')}` } }, msys)).toBe(join(root, 'usr', 'bin'))
    expect(msysBinFor({ exe: 'D:\\Elsewhere\\bin\\git.exe' }, msys)).toBeNull()
    expect(msysBinFor({ env: { PATH: 'C:\\Nothing' } }, msys)).toBeNull()
  })
})
