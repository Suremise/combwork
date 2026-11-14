// HI-3128: the commands that give a branch with no upstream the one follow mode needs (UpstreamRemedy), read locally, and
// each run exactly as rendered (PowerShell, as shellLine quotes for): the branch named in each, so the folder's
// checked-out branch and its upstream never change, nor the remote's fetch mapping; after them, follow mode's own reads
// (destinationOf, fetchHeadOf) work for the new branch. A remote is named only when it is known; otherwise a placeholder.
import { execFileSync } from 'child_process'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
import { destinationOf, fetchHeadOf, projectHost, upstreamRemedyOf } from '../src/main/platform/gitTransport'
import { REMOTE_PLACEHOLDER } from '../src/shared/workflow/queue'
import { isAgain } from '../src/main/platform/again'

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
const config = (cwd: string, key: string): string | null => {
  try {
    return git(cwd, 'config', '--get-all', key)
  } catch {
    return null
  }
}
/** A command line as the user would run it: PowerShell, the shell shellLine quotes for. */
const run = (cwd: string, line: string): void => void execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `${line}; if ($LASTEXITCODE) { exit $LASTEXITCODE }`], { cwd, stdio: 'pipe', encoding: 'utf8' })

/** A project on 1.4.0 (tracking `r`), with `branch` made here only; `r` a bare remote; `narrow`: r's fetch mapping covers main only. */
function project(branch = '1.5.0', o: { narrow?: boolean; remoteHas?: boolean } = {}) {
  const base = tempDir('cw-upstream-')
  const bare = join(base, 'r.git').replace(/\\/g, '/')
  const repo = join(base, 'p')
  git(base, 'init', '-q', '--bare', '-b', 'main', bare)
  git(base, 'init', '-q', '-b', 'main', repo)
  for (const [k, v] of [['user.name', 'Pat'], ['user.email', 'pat@example.com'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v)
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'initial')
  git(repo, 'remote', 'add', 'r', bare)
  git(repo, 'branch', '1.4.0')
  git(repo, 'push', '-q', '-u', 'r', 'main', '1.4.0')
  git(repo, 'switch', '-q', '1.4.0')
  git(repo, 'branch', branch)
  if (o.remoteHas) {
    git(repo, 'push', '-q', 'r', `refs/heads/${branch}:refs/heads/${branch}`)
    try {
      git(repo, 'update-ref', '-d', `refs/remotes/r/${branch}`)
    } catch {
      // none made
    }
  }
  if (o.narrow) git(repo, 'config', '--replace-all', 'remote.r.fetch', '+refs/heads/main:refs/remotes/r/main')
  return { repo, bare }
}

/** What stays as it was: the checked-out branch, its upstream, the remote's fetch mapping. */
const kept = (repo: string) => ({ on: git(repo, 'branch', '--show-current'), remote: config(repo, 'branch.1.4.0.remote'), merge: config(repo, 'branch.1.4.0.merge'), fetch: config(repo, 'remote.r.fetch') })

/** Follow mode's own reads for `branch` now: its endpoint captured and its remote head fetched. */
async function follows(repo: string, branch: string): Promise<string> {
  const h = projectHost(repo)
  const d = await destinationOf(h, branch)
  if (isAgain(d) || 'pause' in d) throw new Error(`no destination: ${JSON.stringify(d)}`)
  const f = await fetchHeadOf(h, d.snapshot, `refs/cw/fetch/test`)
  if ('failed' in f) throw new Error(f.failed)
  return f.head
}

describe('HI-3128: what gives a new branch the upstream follow mode needs', () => {
  for (const narrow of [false, true]) {
    it(`publish, run as rendered, makes it on the remote and its upstream (${narrow ? 'a narrowed' : 'the standard'} fetch mapping)`, async () => {
      const { repo, bare } = project('1.5.0', { narrow })
      const before = kept(repo)
      const m = await upstreamRemedyOf(projectHost(repo), '1.5.0', '1.4.0')
      expect(m).toMatchObject({ kind: 'ready', remote: 'r', publish: 'git push -u r refs/heads/1.5.0:refs/heads/1.5.0' })
      if (m.kind === 'unusable') return
      run(repo, m.publish)
      expect([config(repo, 'branch.1.5.0.remote'), config(repo, 'branch.1.5.0.merge')]).toEqual(['r', 'refs/heads/1.5.0'])
      expect(kept(repo)).toEqual(before)
      expect(await follows(repo, '1.5.0')).toBe(git(bare, 'rev-parse', '1.5.0'))
    })
  }

  it('track, run as rendered, sets what it tracks when the remote has it, whatever the fetch mapping (no tracking ref, narrowed)', async () => {
    const { repo, bare } = project('1.5.0', { narrow: true, remoteHas: true })
    const before = kept(repo)
    const m = await upstreamRemedyOf(projectHost(repo), '1.5.0', '1.4.0')
    if (m.kind === 'unusable') throw new Error('unusable')
    expect(m.track).toEqual(['git config branch.1.5.0.remote r', 'git config branch.1.5.0.merge refs/heads/1.5.0'])
    for (const line of m.track) run(repo, line)
    expect(kept(repo)).toEqual(before)
    expect(await follows(repo, '1.5.0')).toBe(git(bare, 'rev-parse', '1.5.0'))
  })

  it('a branch name that needs quoting is quoted, and runs', async () => {
    const name = "rel'1.5.0"
    const { repo } = project(name)
    const m = await upstreamRemedyOf(projectHost(repo), name, '1.4.0')
    if (m.kind === 'unusable') throw new Error('unusable')
    expect(m.publish).toBe("git push -u r 'refs/heads/rel''1.5.0:refs/heads/rel''1.5.0'")
    run(repo, m.publish)
    expect(config(repo, `branch.${name}.merge`)).toBe(`refs/heads/${name}`)
  })

  it('names a remote only when it is known: several or none give the placeholder; several push addresses or a shallow clone, no commands', async () => {
    // Several remotes, none tracked by the branch or its source: the placeholder, never origin.
    const two = project('1.5.0')
    git(two.repo, 'config', '--unset', 'branch.1.4.0.remote')
    git(two.repo, 'remote', 'add', 'origin', two.bare)
    const several = await upstreamRemedyOf(projectHost(two.repo), '1.5.0', '1.4.0')
    expect(several).toMatchObject({ kind: 'choose', remote: null, publish: `git push -u ${REMOTE_PLACEHOLDER} refs/heads/1.5.0:refs/heads/1.5.0` })
    expect(JSON.stringify(several)).not.toContain('origin')
    // None at all.
    const none = project('1.5.0')
    git(none.repo, 'remote', 'remove', 'r')
    expect(await upstreamRemedyOf(projectHost(none.repo), '1.5.0', '1.4.0')).toMatchObject({ kind: 'choose', remote: null })
    // The known remote with two push addresses: no ready-to-run publication.
    const pushes = project('1.5.0')
    git(pushes.repo, 'remote', 'set-url', '--add', '--push', 'r', pushes.bare)
    git(pushes.repo, 'remote', 'set-url', '--add', '--push', 'r', `${pushes.bare}-mirror`)
    const ambiguous = await upstreamRemedyOf(projectHost(pushes.repo), '1.5.0', '1.4.0')
    expect(ambiguous).toEqual({ kind: 'unusable', remote: 'r', why: 'ambiguous' })
  })
})
