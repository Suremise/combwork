// The Operations section's preview against the real jj Combwork is tested with (HI-2800, J7; design HI-2800/s12, s16 and
// s19, HR2's): each eligibility rule E1–E7 on a real repository, read through the production functions
// (platform/jjOperations.ts), each preview writing nothing (the operation heads' bytes, the project's checkout record and
// its files the same after it). Where a command is offered, the test runs exactly that command from the project folder,
// as the user would, and proves the revert left everything outside "what O did" as it was at the operation it applied to
// (B: the head, or the user's own snapshot S when jj recorded their edits first, found by its provenance and exact delta).
//
// Without the fetched jj (npm run jj:fetch) it is skipped, saying so; with CW_JJ_REAL=1 its absence fails.
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { TESTED_JJ } from '../src/shared/jjTool'
import { createJjRunner } from '../src/main/platform/jjRunner'
import { jjContextOf } from '../src/main/platform/jjDetect'
import { readOpHeads } from '../src/main/platform/jjView'
import { jjOperationPreview, jjOperations, type GitRead } from '../src/main/platform/jjOperations'
import { operationFacts, previewOf, viewEntries, type OpPreviewInput, type ViewEntries } from '../src/main/platform/jjOpView'
import { isJjViewUnknown, type JjOperationPreview } from '../src/shared/jjViews'
import { tempDir } from './tempDir'

const require = createRequire(import.meta.url)
const { portableJj } = require('./jjPortable.cjs') as { portableJj: () => string | null }
const { gitEnv } = require('./e2e/runContext.cjs') as { gitEnv: (vars?: Record<string, string>) => NodeJS.ProcessEnv }

const exe = portableJj()
if (!exe && process.env.CW_JJ_REAL === '1') throw new Error(`CW_JJ_REAL=1 but jj ${TESTED_JJ.version} isn't fetched: run npm run jj:fetch`)
if (!exe) console.warn(`jjOperationsReal.test.ts skipped: jj ${TESTED_JJ.version} isn't fetched (npm run jj:fetch)`)

function isolated(): NodeJS.ProcessEnv {
  const home = tempDir('jjo-home-')
  const config = join(home, 'jj.toml')
  writeFileSync(config, '[user]\nname = "Combwork Test"\nemail = "test@example.invalid"\n[ui]\npaginate = "never"\n')
  return gitEnv({ HOME: home, USERPROFILE: home, APPDATA: home, JJ_CONFIG: config, NO_COLOR: '1' })
}

describe.skipIf(!exe)('jj operations: the revert preview on the real jj (HI-2800)', () => {
  const env = isolated()
  const runner = createJjRunner({ exe: exe!, env })
  const jj = (cwd: string, ...args: string[]): string => execFileSync(exe!, args, { cwd, env, windowsHide: true, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

  /** A colocated repository: base, then main's commit with a bookmark main, and @ an empty child. */
  async function repo(name: string) {
    const parent = tempDir(`jjo-${name}-`)
    const root = join(parent, 'repo')
    mkdirSync(root)
    jj(root, 'git', 'init', '--colocate')
    writeFileSync(join(root, 'base.txt'), 'base\n')
    jj(root, 'commit', '-m', 'base')
    writeFileSync(join(root, 'a.txt'), 'one\n')
    jj(root, 'commit', '-m', 'main work')
    jj(root, 'bookmark', 'set', 'main', '-r', '@-')
    const real = resolve(realpathSync.native(root))
    const d = await jjContextOf(real, runner)
    if (!('jj' in d)) throw new Error(`not detected: ${JSON.stringify(d)}`)
    const read = (...args: string[]): string => jj(real, '--ignore-working-copy', ...args)
    /** The head operation now. */
    const head = (): string => read('op', 'log', '--no-graph', '-n', '1', '-T', 'id').trim()
    /** An operation's facts and its view's entries. */
    const factsOf = (op: string) => operationFacts(read('--at-op', op, 'debug', 'object', 'operation', op))!
    const viewOf = (op: string): ViewEntries => {
      const v = viewEntries(read('--at-op', op, 'debug', 'object', 'view', factsOf(op).view))
      if (!(v instanceof Map)) throw new Error(`view ${v}`)
      return v
    }
    const id = (rev: string, t = 'commit_id'): string => read('log', '--no-graph', '-r', rev, '-T', t).trim()
    return { root: real, ctx: d.jj, head, factsOf, viewOf, id, parent }
  }
  type Repo = Awaited<ReturnType<typeof repo>>

  /** Everything a preview must leave alone: the operation heads' bytes, the project's checkout record, its files. */
  const state = (r: Repo): string => JSON.stringify({ heads: readOpHeads(r.ctx.jjRepo), checkout: readFileSync(join(r.root, '.jj', 'working_copy', 'checkout')).toString('hex'), files: ['base.txt', 'a.txt', 'local.txt'].map((f) => { try { return readFileSync(join(r.root, f), 'utf8') } catch { return null } }) })

  async function preview(r: Repo, op: string, moment?: string): Promise<JjOperationPreview> {
    const before = state(r)
    const p = await jjOperationPreview(r.root, op, moment, runner)
    expect(state(r)).toBe(before)
    if (isJjViewUnknown(p)) throw new Error(`unknown: ${JSON.stringify(p)}`)
    return p
  }

  /** Runs the preview's command from the project folder, as the user would, and returns the revert operation R and the operation it applied to, B. */
  function runCommand(r: Repo, p: JjOperationPreview): { R: string; B: string; S: string | null } {
    expect(p.command).toBe(`jj op revert ${p.op}`)
    const [, , ...args] = p.command!.split(' ')
    jj(r.root, 'op', ...args)
    const R = r.head()
    const rf = r.factsOf(R)
    expect(rf.parents).toHaveLength(1)
    const B = rf.parents[0]
    expect(readOpHeads(r.ctx.jjRepo)).toEqual([R])
    if (B === p.at) return { R, B, S: null }
    // jj recorded the user's edits first: S, its parent the previewed head, a snapshot in the project's workspace whose
    // only changes are that workspace's working-copy commit and the heads.
    const sf = r.factsOf(B)
    expect(sf.parents).toEqual([p.at])
    expect(sf.snapshot).toBe(true)
    expect(sf.workspace).toBe('default')
    const H = r.viewOf(p.at)
    const S = r.viewOf(B)
    const changed = [...new Set([...H.keys(), ...S.keys()])].filter((k) => H.get(k) !== S.get(k))
    expect(changed.every((k) => k === 'wc:default' || k.startsWith('head:') || k === 'githead:default')).toBe(true)
    expect(changed).toContain('wc:default')
    return { R, B, S: B }
  }

  /** Every entry outside what O did is the same at R as at B. */
  function untouchedOutside(r: Repo, p: JjOperationPreview, R: string, B: string): void {
    const own = new Set(p.did.map((d) => d.key))
    const atR = r.viewOf(R)
    const atB = r.viewOf(B)
    const outside = [...new Set([...atR.keys(), ...atB.keys()])].filter((k) => !own.has(k) && atR.get(k) !== atB.get(k))
    expect(outside).toEqual([])
    for (const d of p.did) expect(atR.get(d.key) ?? null).toBe(d.before)
  }

  it('a bookmark created, with an unrelated one after: previewed, its command run, only it undone (and Git’s branch with it)', async () => {
    const r = await repo('create')
    jj(r.root, 'bookmark', 'create', 'feature', '-r', 'main')
    const O = r.head()
    jj(r.root, 'bookmark', 'create', 'other', '-r', 'main-')
    const list = await jjOperations(r.root, null, runner)
    if (isJjViewUnknown(list)) throw new Error('list')
    expect(list.rows[1].id).toBe(O)
    expect(list.rows[1].description).toMatch(/feature/)
    const p = await preview(r, O)
    expect(p.refused).toBeNull()
    expect(p.did.map((d) => d.key)).toEqual(expect.arrayContaining(['bookmark:feature', 'gitref:refs/heads/feature', 'remote:git:bookmark:feature']))
    const wcBefore = r.id('@')
    const { R, B, S } = runCommand(r, p)
    expect(S).toBeNull()
    untouchedOutside(r, p, R, B)
    expect(git(r.root, 'branch', '--list', 'feature')).toBe('')
    expect(git(r.root, 'branch', '--list', 'other')).toMatch(/other/)
    expect(r.id('@')).toBe(wcBefore)
    expect(readFileSync(join(r.root, 'a.txt'), 'utf8')).toBe('one\n')
  })

  it('the same with an edit jj hasn’t recorded: the preview the same and writing nothing; the command records it first (S), keeps its bytes, and reverts only O', async () => {
    const r = await repo('edit')
    jj(r.root, 'bookmark', 'create', 'feature', '-r', 'main')
    const O = r.head()
    const clean = await preview(r, O)
    writeFileSync(join(r.root, 'local.txt'), 'unrecorded edit\n')
    const p = await preview(r, O)
    expect(p).toEqual(clean)
    expect(p.refused).toBeNull()
    const { R, B, S } = runCommand(r, p)
    expect(S).not.toBeNull()
    untouchedOutside(r, p, R, B)
    const wcAtS = r.viewOf(S!).get('wc:default')!
    const wcCommit = /"([0-9a-f]{40})"/.exec(wcAtS)![1]
    expect(jj(r.root, '--ignore-working-copy', 'file', 'show', '-r', wcCommit, 'local.txt')).toBe('unrecorded edit\n')
    expect(readFileSync(join(r.root, 'local.txt'), 'utf8')).toBe('unrecorded edit\n')
    expect(git(r.root, 'branch', '--list', 'feature')).toBe('')
  })

  it('a bookmark deleted: a command, run, the bookmark back', async () => {
    const r = await repo('delete')
    jj(r.root, 'bookmark', 'create', 'old', '-r', 'main')
    jj(r.root, 'bookmark', 'delete', 'old')
    const O = r.head()
    const p = await preview(r, O)
    expect(p.refused).toBeNull()
    const { R, B } = runCommand(r, p)
    untouchedOutside(r, p, R, B)
    expect(git(r.root, 'branch', '--list', 'old')).toMatch(/old/)
  })

  it('tracking only: a command while nothing changed it since, none once it changed again', async () => {
    const r = await repo('track')
    const remote = join(r.parent, 'remote.git')
    git(r.parent, 'init', '-q', '--bare', remote)
    jj(r.root, 'git', 'remote', 'add', 'origin', remote)
    jj(r.root, 'git', 'push', '-b', 'main')
    jj(r.root, 'bookmark', 'untrack', 'main', '--remote', 'origin')
    const O = r.head()
    const p = await preview(r, O)
    expect(p.refused).toBeNull()
    expect(p.did.map((d) => d.key)).toEqual(['remote:origin:bookmark:main'])
    jj(r.root, 'bookmark', 'track', 'main', '--remote', 'origin')
    const again = await preview(r, O)
    expect(again.refused).toBe('overlap')
    expect(again.command).toBeNull()
    const t = r.head()
    const p2 = await preview(r, t)
    expect(p2.refused).toBeNull()
    const { R, B } = runCommand(r, p2)
    untouchedOutside(r, p2, R, B)
  })

  it('later overlap: the same bookmark moved since, and a commit made on what it rewrote', async () => {
    const r = await repo('overlap')
    jj(r.root, 'bookmark', 'create', 'feature', '-r', 'main')
    const O = r.head()
    jj(r.root, 'bookmark', 'set', 'feature', '-r', 'main-', '--allow-backwards')
    const p = await preview(r, O)
    expect(p.refused).toBe('overlap')
    expect(p.later.map((l) => l.key)).toContain('bookmark:feature')
    // A side commit (not @'s), described again (O2: no working-copy change), then a child made on it later.
    jj(r.root, 'new', '--no-edit', 'main', '-m', 'side')
    jj(r.root, 'describe', '-r', 'description(exact:"side\n")', '-m', 'side two')
    const O2 = r.head()
    const before = await preview(r, O2)
    expect(before.later).toEqual([])
    expect(before.refused).toBeNull()
    jj(r.root, 'new', '--no-edit', 'description(exact:"side two\n")', '-m', 'child')
    const p2 = await preview(r, O2)
    expect(p2.refused).toBe('overlap')
    expect(p2.later.some((l) => l.why === 'descendant')).toBe(true)
  })

  it('no command for a merge of operations, either racing bookmark set, a working-copy change or a workspace added', async () => {
    const r = await repo('refused')
    const base = r.head()
    const side = r.id('main-')
    jj(r.root, '--at-op', base, '--ignore-working-copy', 'bookmark', 'set', 'main', '-r', side, '--allow-backwards')
    const one = readOpHeads(r.ctx.jjRepo)!.find((h) => h !== base)!
    jj(r.root, '--at-op', base, '--ignore-working-copy', 'bookmark', 'set', 'main', '-r', 'root()', '--allow-backwards')
    // Two heads: nothing is read (E1), nothing written.
    const twoHeads = await jjOperationPreview(r.root, one, null, runner)
    expect(isJjViewUnknown(twoHeads) && twoHeads.jjUnknown).toBe('heads')
    expect(readOpHeads(r.ctx.jjRepo)).toHaveLength(2)
    jj(r.root, '--ignore-working-copy', 'bookmark', 'list')
    const merge = r.head()
    expect(r.factsOf(merge).parents).toHaveLength(2)
    expect((await preview(r, merge)).refused).toBe('parents')
    expect((await preview(r, one)).refused).toBe('overlap')
    writeFileSync(join(r.root, 'c.txt'), 'c\n')
    jj(r.root, 'commit', '-m', 'c')
    expect((await preview(r, r.head())).refused).toBe('workingCopy')
    jj(r.root, 'workspace', 'add', join(r.parent, 'ws2'))
    expect((await preview(r, r.head())).refused).toBe('workingCopy')
  })

  it("Git's own change: jj's import of a plain Git branch move gives no command", async () => {
    const r = await repo('import')
    git(r.root, 'branch', '-f', 'gitside', r.id('main-'))
    jj(r.root, 'status')
    const imported = r.head()
    expect(r.factsOf(imported).description).toBe('import git refs')
    const p = await preview(r, imported)
    expect(p.refused).toBe('gitOwn')
    expect(p.command).toBeNull()
  })

  it('a stale project workspace gives no command', async () => {
    const r = await repo('stale')
    const ws2 = join(r.parent, 'ws2')
    jj(r.root, 'workspace', 'add', ws2)
    // From ws2, rewrite the project workspace's working-copy commit: the project folder's files are behind it.
    writeFileSync(join(r.root, 'dirty.txt'), 'x\n')
    jj(r.root, 'status')
    jj(ws2, 'describe', '-r', 'default@', '-m', 'rewritten from ws2')
    jj(ws2, 'bookmark', 'create', 'later', '-r', 'main')
    const p = await preview(r, r.head())
    expect(p.refused).toBe('stale')
  })

  it('the head moving after the preview: Copy’s revalidation gives no command, and a fresh preview offers it again', async () => {
    const r = await repo('moved')
    jj(r.root, 'bookmark', 'create', 'feature', '-r', 'main')
    const O = r.head()
    const shown = await preview(r, O)
    expect(shown.command).not.toBeNull()
    jj(r.root, 'bookmark', 'create', 'unrelated', '-r', 'main-')
    const atCopy = await preview(r, O, shown.moment)
    expect(atCopy.refused).toBe('moved')
    expect(atCopy.command).toBeNull()
    expect(atCopy.at).not.toBe(shown.at)
    const fresh = await preview(r, O)
    expect(fresh.command).toBe(shown.command)
    expect((await preview(r, O, fresh.moment)).command).toBe(shown.command)
  })
  it("a plain Git move jj hasn't imported (HR2's round 1): before the preview, no command (E8); between the preview and Copy, nothing copied; nothing imported or written", async () => {
    const r = await repo('plaingit')
    jj(r.root, 'bookmark', 'create', 'feature', '-r', 'main')
    const O = r.head()
    const shown = await preview(r, O)
    expect(shown.command).not.toBeNull()
    // Between the preview and Copy: Git moves the very branch, jj's operation heads untouched.
    const heads = readOpHeads(r.ctx.jjRepo)
    git(r.root, 'update-ref', 'refs/heads/feature', r.id('main-'))
    expect(readOpHeads(r.ctx.jjRepo)).toEqual(heads)
    const atCopy = await preview(r, O, shown.moment)
    expect(atCopy.command).toBeNull()
    expect(atCopy.at).toBe(shown.at)
    // A fresh preview now: Git disagrees with jj's record at the same head, so no command at all.
    const fresh = await preview(r, O)
    expect(fresh.refused).toBe('unimported')
    expect(fresh.command).toBeNull()
    expect(readOpHeads(r.ctx.jjRepo)).toEqual(heads)
    // A new Git branch jj never imported, and HEAD moved by plain Git, disagree the same way.
    git(r.root, 'update-ref', 'refs/heads/feature', r.id('main'))
    expect((await preview(r, O)).refused).toBeNull()
    git(r.root, 'branch', 'gitonly', r.id('main-'))
    expect((await preview(r, O)).refused).toBe('unimported')
    git(r.root, 'branch', '-D', 'gitonly')
    git(r.root, 'update-ref', '--no-deref', 'HEAD', r.id('main-'))
    expect((await preview(r, O)).refused).toBe('unimported')
    expect(readOpHeads(r.ctx.jjRepo)).toEqual(heads)
  })
  /** Git as the preview reads it (read-only, no optional locks), with `during` run inside the n-th call, before it answers. */
  function gitWith(during: (call: number, args: string[]) => void): GitRead {
    let n = 0
    return async (cwd, args) => {
      n++
      try {
        const out = execFileSync('git', ['--no-optional-locks', ...args], { cwd, env, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        during(n, args)
        return { ok: true, out, code: 0 }
      } catch (e) {
        during(n, args)
        const x = e as { status?: number; stdout?: string }
        return { ok: false, out: x.stdout ?? '', code: x.status ?? null }
      }
    }
  }

  it("the verified capture (HR2's round 2): a tag or a remote ref made during the last Git read, or during the last awaited read of all, gives no answer; and Copy after one gives no command", async () => {
    const r = await repo('capture')
    jj(r.root, 'bookmark', 'create', 'feature', '-r', 'main')
    const O = r.head()
    const shown = await preview(r, O)
    expect(shown.command).not.toBeNull()
    const heads = readOpHeads(r.ctx.jjRepo)
    // A tag made during HEAD's read (the last Git read): its answer is unchanged, the refs read before it lack the tag.
    let made = false
    const tagLate = await jjOperationPreview(r.root, O, null, runner, gitWith((n, args) => {
      if (args[0] === 'rev-parse' && !made) {
        git(r.root, 'tag', 'late', r.id('main'))
        made = true
      }
    }))
    expect(made).toBe(true)
    expect(isJjViewUnknown(tagLate) && tagLate.jjUnknown).toBe('moved')
    git(r.root, 'tag', '-d', 'late')
    // A remote ref made during the refs' own read.
    made = false
    const remoteLate = await jjOperationPreview(r.root, O, null, runner, gitWith((n, args) => {
      if (args.includes('for-each-ref') && !made) {
        git(r.root, 'update-ref', 'refs/remotes/origin/late', r.id('main'))
        made = true
      }
    }))
    expect(made).toBe(true)
    expect(isJjViewUnknown(remoteLate) && remoteLate.jjUnknown).toBe('moved')
    git(r.root, 'update-ref', '-d', 'refs/remotes/origin/late')
    // During the last awaited read of all (the worker's preview): the synchronous check at the answer catches it.
    made = false
    const lastRead = await jjOperationPreview(r.root, O, null, { ...runner, preview: async (input: OpPreviewInput) => {
      git(r.root, 'tag', 'latest', r.id('main'))
      made = true
      return previewOf(input)
    } })
    expect(made).toBe(true)
    expect(isJjViewUnknown(lastRead) && lastRead.jjUnknown).toBe('moved')
    // Copy after it: the moment shown isn't the moment now.
    const atCopy = await preview(r, O, shown.moment)
    expect(atCopy.refused).toBe('moved')
    expect(atCopy.command).toBeNull()
    git(r.root, 'tag', '-d', 'latest')
    // Deleting it leaves an empty refs/tags the first print didn't have: still another moment. A fresh preview offers it.
    expect((await preview(r, O)).command).toBe(shown.command)
    expect(readOpHeads(r.ctx.jjRepo)).toEqual(heads)
  })

  it('a non-colocated store: an eligible preview, and a tag made in its Git store during the refs read gives no answer', async () => {
    const parent = tempDir('jjo-loose-')
    const root = join(parent, 'repo')
    mkdirSync(root)
    jj(root, 'git', 'init', '--no-colocate')
    writeFileSync(join(root, 'a.txt'), 'a\n')
    jj(root, 'commit', '-m', 'a')
    jj(root, 'bookmark', 'create', 'feature', '-r', '@-')
    const real = resolve(realpathSync.native(root))
    const O = jj(real, '--ignore-working-copy', 'op', 'log', '--no-graph', '-n', '1', '-T', 'id').trim()
    const p = await jjOperationPreview(real, O, null, runner)
    if (isJjViewUnknown(p)) throw new Error(JSON.stringify(p))
    expect(p.refused).toBeNull()
    const store = join(real, '.jj', 'repo', 'store', 'git')
    const commit = jj(real, '--ignore-working-copy', 'log', '--no-graph', '-r', '@-', '-T', 'commit_id').trim()
    let made = false
    const late = await jjOperationPreview(real, O, null, runner, gitWith((n, args) => {
      if (args.includes('for-each-ref') && !made) {
        git(real, `--git-dir=${store}`, 'tag', 'late', commit)
        made = true
      }
    }))
    expect(made).toBe(true)
    expect(isJjViewUnknown(late) && late.jjUnknown).toBe('moved')
    // And with the tag there, jj hasn't imported it: E8.
    const after = await jjOperationPreview(real, O, null, runner)
    expect(!isJjViewUnknown(after) && after.refused).toBe('unimported')
  })
})
