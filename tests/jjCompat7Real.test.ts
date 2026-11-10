// jj's compatibility cases J7 verifies on the real jj (HI-2800; SPEC §16.3.6, jj's recovery, agents and compatibility):
// a non-colocated repository (no .git beside .jj: a None project) keeps .combwork out in its own Git store's
// info/exclude, which jj honours, and only what jj hasn't recorded; trust's root for it is the folder itself, and for a
// colocated one Git's main working tree, the jj root.
//
// Without the fetched jj (npm run jj:fetch) it is skipped, saying so; with CW_JJ_REAL=1 its absence fails.
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { TESTED_JJ } from '../src/shared/jjTool'
import { ensureJjExcluded, jjGitStoreOf } from '../src/main/platform/jjKeepOut'
import { combworkVcs } from '../src/main/combworkVcs'
import { trustRoot } from '../src/main/platform/repoPorts'
import { tempDir } from './tempDir'

const require = createRequire(import.meta.url)
const { portableJj } = require('./jjPortable.cjs') as { portableJj: () => string | null }
const { gitEnv } = require('./e2e/runContext.cjs') as { gitEnv: (vars?: Record<string, string>) => NodeJS.ProcessEnv }

const exe = portableJj()
if (!exe && process.env.CW_JJ_REAL === '1') throw new Error(`CW_JJ_REAL=1 but jj ${TESTED_JJ.version} isn't fetched: run npm run jj:fetch`)
if (!exe) console.warn(`jjCompat7Real.test.ts skipped: jj ${TESTED_JJ.version} isn't fetched (npm run jj:fetch)`)

describe.skipIf(!exe)('jj compatibility on the real jj (HI-2800)', () => {
  const home = tempDir('jj7r-home-')
  const config = join(home, 'jj.toml')
  writeFileSync(config, '[user]\nname = "Combwork Test"\nemail = "test@example.invalid"\n[ui]\npaginate = "never"\n')
  const env = gitEnv({ HOME: home, USERPROFILE: home, APPDATA: home, JJ_CONFIG: config, NO_COLOR: '1' })
  const jj = (cwd: string, ...args: string[]): string => execFileSync(exe!, args, { cwd, env, windowsHide: true, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })

  function repo(name: string, colocate: boolean): string {
    const root = join(tempDir(`jj7r-${name}-`), 'repo')
    mkdirSync(root)
    jj(root, 'git', 'init', colocate ? '--colocate' : '--no-colocate')
    writeFileSync(join(root, 'a.txt'), 'a\n')
    return resolve(realpathSync.native(root))
  }

  it("non-colocated: .combwork kept out in jj's own Git store, which jj honours; asked only, nothing written", async () => {
    const root = repo('keep', false)
    const store = jjGitStoreOf(root)
    expect(await store).toBe(join(root, '.jj', 'repo', 'store', 'git'))
    mkdirSync(join(root, '.combwork'))
    writeFileSync(join(root, '.combwork', 'project.json'), '{}')
    expect(await ensureJjExcluded(root, { readOnly: true })).toEqual({ excluded: false, root, added: false })
    expect(await ensureJjExcluded(root)).toEqual({ excluded: true, root, added: true })
    expect(readFileSync(join((await store)!, 'info', 'exclude'), 'utf8')).toMatch(/^\/\.combwork\/$/m)
    expect(await ensureJjExcluded(root)).toEqual({ excluded: true, root, added: false })
    const status = jj(root, 'status')
    expect(status).toMatch(/a\.txt/)
    expect(status).not.toMatch(/\.combwork/)
    expect(await combworkVcs(root)).toMatchObject({ state: 'excluded', vcs: 'Jujutsu' })
  })

  it('non-colocated: what jj recorded before stays tracked (documented: jj file untrack)', async () => {
    const root = repo('late', false)
    mkdirSync(join(root, '.combwork'))
    writeFileSync(join(root, '.combwork', 'state'), 'x')
    jj(root, 'status')
    await ensureJjExcluded(root)
    writeFileSync(join(root, '.combwork', 'state'), 'y')
    expect(jj(root, 'status')).toMatch(/\.combwork/)
  })

  it('colocated: Git’s keep-out holds it, not jj’s', async () => {
    const root = repo('colo', true)
    expect(await ensureJjExcluded(root)).toBeNull()
  })

  it("non-colocated, a linked workspace (HR2's round 1): its pointer followed to the shared store; the workspace itself and a project subfolder of it kept out, the primary's rules kept", async () => {
    const root = repo('linked', false)
    mkdirSync(join(root, '.combwork'))
    writeFileSync(join(root, '.combwork', 'p.md'), 'primary')
    expect((await ensureJjExcluded(root))?.added).toBe(true)
    const other = join(resolve(root, '..'), 'other')
    jj(root, 'workspace', 'add', '--no-colocate', other)
    const store = await jjGitStoreOf(other)
    expect(store).toBe(await jjGitStoreOf(root))
    // The workspace as a project.
    mkdirSync(join(other, '.combwork'))
    writeFileSync(join(other, '.combwork', 'private.md'), 'secret')
    writeFileSync(join(other, 'b.txt'), 'b\n')
    expect(await ensureJjExcluded(other)).toEqual({ excluded: true, root: other, added: false })
    // A project in a subfolder of it: its own anchored line.
    const sub = join(other, 'sub')
    mkdirSync(join(sub, '.combwork'), { recursive: true })
    writeFileSync(join(sub, '.combwork', 'private.md'), 'secret')
    writeFileSync(join(sub, 'c.txt'), 'c\n')
    expect(await ensureJjExcluded(sub)).toEqual({ excluded: true, root: other, added: true })
    const exclude = readFileSync(join(store!, 'info', 'exclude'), 'utf8')
    expect(exclude).toMatch(/^\/\.combwork\/$/m)
    expect(exclude).toMatch(/^\/sub\/\.combwork\/$/m)
    // jj's own snapshot of each workspace: the files, never .combwork.
    const files = jj(other, 'file', 'list')
    expect(files).toMatch(/b\.txt/)
    expect(files).toMatch(/sub[\\/]c\.txt/)
    expect(files).not.toMatch(/\.combwork/)
    expect(jj(root, 'file', 'list')).not.toMatch(/\.combwork/)
  })

  it("trust's root: the folder itself when not colocated, Git's main working tree (the jj root) when colocated", async () => {
    const loose = repo('trust-loose', false)
    expect(await trustRoot(loose, { timeout: 10_000 })).toEqual({ none: true })
    const colo = repo('trust-colo', true)
    mkdirSync(join(colo, 'sub'))
    const t = await trustRoot(join(colo, 'sub'), { timeout: 10_000 })
    expect('root' in t && t.root && resolve(t.root).toLowerCase()).toBe(colo.toLowerCase())
  })
})
