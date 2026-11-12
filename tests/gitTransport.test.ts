// HI-1183: follow mode's transport helpers: what a record may show of a URL, and the redaction of git's words; HI-2987:
// the sealed fetch's haves, on real repositories (a bare one as the remote).
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { appendFileSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { tempDir } from './tempDir'
import { destinationOf, displayUrl, fetchHeadOf, HAVES_MAX, projectRelative, redactTransport } from '../src/main/platform/gitTransport'
import { gitTree } from '../src/main/workflow/mergeQueue'
import type { CandidateHost } from '../src/main/platform/integration'

const { gitEnv } = createRequire(import.meta.url)('./e2e/runContext.cjs') as { gitEnv: (vars?: Record<string, string>) => NodeJS.ProcessEnv }
import { memoryTransportStore, snapshotDigest } from '../src/main/workflow/transportSnapshots'
import type { TransportSnapshot } from '../src/main/platform/integration'

const snap = (over: Partial<TransportSnapshot> = {}): TransportSnapshot => ({
  remote: 'origin',
  url: 'https://alice:s3cr3t-pass-word@example.com/team/repo.git',
  display: 'https://example.com/team/repo.git',
  ref: 'refs/heads/main',
  config: [
    ['http.extraheader', 'Authorization: Bearer tok_ABCDEFGHIJKLMNOP'],
    ['http.proxy', 'http://proxyuser:proxy-secret-99@proxy.local:8080'],
    ['credential.helper', '!f() { echo password=helper-secret-123; }; f'],
    ['http.sslbackend', 'schannel']
  ],
  objects: 'C:/repo/.git/objects',
  alternates: [],
  format: 'sha1',
  ...over
})

describe('follow mode’s transport helpers (HI-1183)', () => {
  it('a URL as it may be shown keeps no userinfo, query or fragment', () => {
    expect(displayUrl('https://alice:pw@example.com/r.git?token=x#frag')).toBe('https://example.com/r.git')
    expect(displayUrl('ssh://git@example.com:22/r.git')).toBe('ssh://example.com:22/r.git')
    expect(displayUrl('C:/Users/me/remote.git')).toBe('C:/Users/me/remote.git')
    expect(displayUrl('git@github.com:team/repo.git')).toBe('git@github.com:team/repo.git')
  })

  it('git’s words lose every credential: URL userinfo, authorization and bearer values, and each secret of the snapshot', () => {
    const s = snap()
    const text = [
      "fatal: unable to access 'https://alice:s3cr3t-pass-word@example.com/team/repo.git/': 403",
      'remote: header was Authorization: Bearer tok_ABCDEFGHIJKLMNOP',
      'remote: the token tok_ABCDEFGHIJKLMNOP is wrong',
      'proxy http://proxyuser:proxy-secret-99@proxy.local:8080 refused',
      'helper said helper-secret-123',
      'a bare s3cr3t-pass-word'
    ].join('\n')
    const out = redactTransport(text, s)
    for (const secret of ['s3cr3t-pass-word', 'tok_ABCDEFGHIJKLMNOP', 'proxy-secret-99', 'helper-secret-123']) expect(out).not.toContain(secret)
    expect(out).toContain('example.com/team/repo.git')
    expect(out).toContain('403')
    // With no snapshot, what any URL or header carries still goes.
    expect(redactTransport('https://u:p@h/x Authorization: Basic abc', null)).toBe('https://***@h/x Authorization: ***')
  })

  it('the store keeps a snapshot by id and digest: a changed or missing one is never returned', async () => {
    const store = memoryTransportStore()
    const s = snap()
    const kept = (await store.save('C:/P', 'main', s))!
    expect(kept.digest).toBe(snapshotDigest(s))
    expect(await store.load(kept.id, kept.digest)).toEqual(s)
    expect(await store.load(kept.id, 'other')).toBeNull()
    store.raw.set(kept.id, JSON.stringify({ ...s, url: 'https://elsewhere/r.git' }))
    expect(await store.load(kept.id, kept.digest)).toBeNull()
    // A target's clean-up drops only its own (HR2's round 2): never another project's, nor another target's.
    const other = (await store.save('C:/Q', 'main', s))!
    const sibling = (await store.save('C:/P', 'release', s))!
    await store.dropExcept('c:/p', 'main', new Set())
    expect(store.raw.has(kept.id)).toBe(false)
    expect(store.raw.has(other.id)).toBe(true)
    expect(store.raw.has(sibling.id)).toBe(true)
  })

  it('query and fragment credentials go too, in a URL and bare (HR2’s round 1)', () => {
    const s = snap({ url: 'https://example.com/r.git?access_token=QUERY-SECRET-123#frag-secret-456', display: 'https://example.com/r.git' })
    const out = redactTransport("fatal: unable to access 'https://example.com/r.git?access_token=QUERY-SECRET-123#frag-secret-456/': connection failed\nthe token QUERY-SECRET-123 and frag-secret-456", s)
    expect(out).not.toContain('QUERY-SECRET-123')
    expect(out).not.toContain('frag-secret-456')
    expect(out).toContain('https://example.com/r.git?***')
    expect(redactTransport('see https://h/x?token=abcdef', null)).toBe('see https://h/x?***')
  })

  it('a relative filesystem push URL is made absolute against the project; URLs, scp-like and absolute paths are kept', () => {
    expect(projectRelative('C:/work/proj', '../remote.git').replace(/\\/g, '/')).toBe('C:/work/remote.git')
    expect(projectRelative('C:/work/proj', 'https://h/r.git')).toBe('https://h/r.git')
    expect(projectRelative('C:/work/proj', 'git@github.com:team/r.git')).toBe('git@github.com:team/r.git')
    expect(projectRelative('C:/work/proj', 'C:/other/r.git')).toBe('C:/other/r.git')
    expect(projectRelative('C:/work/proj', 'D:\\x\\r.git')).toBe('D:\\x\\r.git')
  })
})

describe('the sealed fetch offers the project’s commits as haves (HI-2987)', () => {
  // Every git of the fixture with the run's allowlisted environment and test git config, no system config (tests/README.md, Isolation).
  const env = gitEnv()
  const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim()
  const slash = (p: string): string => p.replace(/\\/g, '/')
  /** The project's objects, loose and packed. */
  const objects = (repo: string): number => {
    const v = Object.fromEntries(sh(repo, 'count-objects', '-v').split(/\r?\n/).map((l) => l.split(': ')).map(([k, n]) => [k, Number(n)]))
    return v.count + v['in-pack']
  }

  /**
   * A project of 120 commits on `main` tracking a bare `origin`, with `branches` old local branches (`feature/…`, sorting
   * before `main`) at its tenth commit; someone else pushes one commit. Its host, snapshot, objects before and that commit.
   */
  async function pushedOnce(branches: number, o: { tracking?: boolean } = {}) {
    const root = tempDir('sealed-haves-')
    const bare = slash(join(root, 'origin.git'))
    const project = join(root, 'project')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env })
    execFileSync('git', ['init', '-q', '-b', 'main', project], { env })
    for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'T'], ['core.autocrlf', 'false']]) sh(project, 'config', k, v)
    // 120 commits, three objects each (commit, tree, blob), made with fast-import (HG1's probe).
    let stream = ''
    for (let i = 1; i <= 120; i++) {
      const data = `content ${i}\n`
      stream += `commit refs/heads/main\nmark :${i}\ncommitter T <t@example.com> ${1700000000 + i} +0000\ndata 3\nc${String(i).padStart(2, '0').slice(-2)}\n${i > 1 ? `from :${i - 1}\n` : ''}M 100644 inline f${i}.txt\ndata ${data.length}\n${data}\n`
    }
    execFileSync('git', ['fast-import', '--quiet'], { cwd: project, input: stream, env })
    sh(project, 'reset', '-q', '--hard', 'main')
    sh(project, 'remote', 'add', 'origin', bare)
    sh(project, 'push', '-q', '-u', 'origin', 'main')
    const old = sh(project, 'rev-parse', 'main~110')
    const feature = (i: number): string => `feature/${String(i).padStart(4, '0')}`
    if (branches && !o.tracking) execFileSync('git', ['update-ref', '--stdin'], { cwd: project, env, input: Array.from({ length: branches }, (_, i) => `create refs/heads/${feature(i)} ${old}\n`).join('') })
    if (branches && o.tracking) {
      // HR1's round 1: each a commit of its own, tracking origin/main (as a branch made from it): never before main's own.
      const own = Array.from({ length: branches }, (_, i) => `commit refs/heads/${feature(i)}\ncommitter T <t@example.com> ${1700001000 + i} +0000\ndata 2\nf\nfrom ${old}\nM 100644 inline g${i}.txt\ndata 2\n${i % 10}\n\n`).join('')
      execFileSync('git', ['fast-import', '--quiet'], { cwd: project, input: own, env })
      appendFileSync(join(project, '.git', 'config'), Array.from({ length: branches }, (_, i) => `[branch "${feature(i)}"]\n\tremote = origin\n\tmerge = refs/heads/main\n`).join(''))
    }
    sh(project, 'gc', '-q')
    const other = join(root, 'other')
    execFileSync('git', ['clone', '-q', bare, other], { env })
    for (const [k, v] of [['user.email', 'o@example.com'], ['user.name', 'O'], ['core.autocrlf', 'false']]) sh(other, 'config', k, v)
    writeFileSync(join(other, 'theirs.txt'), 'theirs\n')
    sh(other, 'add', 'theirs.txt')
    sh(other, 'commit', '-q', '-m', 'theirs')
    sh(other, 'push', '-q', 'origin', 'main')
    const theirs = sh(other, 'rev-parse', 'HEAD')
    const host: CandidateHost = { project, folder: project, signTimeoutMs: 0, identity: async () => null, reads: {}, run: (cwd, args, opts) => gitTree(cwd, args, { env, ...opts }) }
    const d = await destinationOf(host, 'main')
    if (!('snapshot' in d)) throw new Error(JSON.stringify(d))
    return { project, host, snapshot: d.snapshot, before: objects(project), theirs }
  }

  it('someone else pushed one commit: only its objects arrive, not the branch’s history again; then nothing new, nothing', { timeout: 120_000 }, async () => {
    const { project, host, snapshot, before, theirs } = await pushedOnce(0)
    expect(await fetchHeadOf(host, snapshot, 'refs/cw/queue/t-fetch')).toEqual({ head: theirs })
    // The new commit is three objects (commit, tree, blob); the branch's history is 360.
    expect(objects(project) - before).toBe(3)
    expect(sh(project, 'rev-parse', 'refs/cw/queue/t-fetch')).toBe(theirs)
    // Fetched again with nothing new: nothing arrives.
    const again = objects(project)
    expect(await fetchHeadOf(host, snapshot, 'refs/cw/queue/t-fetch')).toEqual({ head: theirs })
    expect(objects(project)).toBe(again)
  })

  it(`HI-3042: past ${HAVES_MAX} local branches sorting before the target, the target's own heads are still offered: only the new commit arrives`, { timeout: 120_000 }, async () => {
    const { project, host, snapshot, before, theirs } = await pushedOnce(HAVES_MAX + 4)
    expect(await fetchHeadOf(host, snapshot, 'refs/cw/queue/t-fetch')).toEqual({ head: theirs })
    expect(objects(project) - before).toBe(3)
  })

  it(`HI-3042: past ${HAVES_MAX} local branches of their own tracking the target, the target's own heads come before them`, { timeout: 120_000 }, async () => {
    const { project, host, snapshot, before, theirs } = await pushedOnce(HAVES_MAX + 4, { tracking: true })
    expect(sh(project, 'rev-parse', '--symbolic-full-name', 'feature/0000@{upstream}')).toBe('refs/remotes/origin/main')
    expect(await fetchHeadOf(host, snapshot, 'refs/cw/queue/t-fetch')).toEqual({ head: theirs })
    expect(objects(project) - before).toBe(3)
  })
})
