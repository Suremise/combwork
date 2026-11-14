// Every reader of the files a jj write of Combwork's replaces goes through Combwork's file gate (HI-2918): each jj
// file of src/main that names a working copy's files, a Git store's refs, packed refs or HEAD, or runs git with
// `--git-dir`, either uses the gate itself or is listed here with where its reads are gated. A new reader fails here
// until it is gated or listed with its reason.
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..')
const READS = /working_copy'|packed-refs'|'refs'|--git-dir|'HEAD'/
/** A call through the gate (not a mention in a comment). */
const GATED = /jjFileGate\.(read|readSync|acquire|recheck)\(|storeGitGated\(|storeGatedHistory\(/

/** Files that name those paths without using the gate themselves: where their reads are gated. */
const ALLOW: Record<string, string> = {
  'src/main/platform/jjAdvanceProbe.ts': "its git is the caller's (jjCards' gitOn, storeGitGated); its writes go through the runner (gated)",
  'src/main/platform/jjCandidates.ts': "its git is jjCards' gitOn (storeGitGated); its writes go through the runner, with a recheck",
  'src/main/platform/jjIntegration.ts': "its git is jjCards' gitOn (storeGitGated); its prints are jjPublishTail's (readSync)",
  'src/main/platform/jjRecovery.ts': "its git is slotsApp's (storeGitGated); its jj writes go through the port, with rechecks",
  'src/main/platform/jjRepoWatch.ts': 'watches folders and lists op heads: opens no ref or working-copy file'
}

const jjFiles = (): string[] => {
  const out: string[] = []
  for (const dir of ['src/main', 'src/main/platform'])
    for (const f of readdirSync(join(root, dir)))
      if (/^jj.*\.ts$/.test(f)) out.push(`${dir}/${f}`)
  return out.sort()
}

describe("readers of jj's replaced files (HI-2918)", () => {
  it('each jj file that reads them uses the file gate, or says where its reads are gated', () => {
    const ungated: string[] = []
    for (const f of jjFiles()) {
      if (f === 'src/main/platform/jjFileGate.ts') continue
      const src = readFileSync(join(root, f), 'utf8')
      if (!READS.test(src) || GATED.test(src) || ALLOW[f]) continue
      ungated.push(f)
    }
    expect(ungated).toEqual([])
  })

  it('lists no file that no longer reads them, or that uses the gate itself', () => {
    const stale = Object.keys(ALLOW).filter((f) => {
      const src = readFileSync(join(root, f), 'utf8')
      return !READS.test(src) || GATED.test(src)
    })
    expect(stale).toEqual([])
  })

  it('the git and history handed to jj code are the gated ones', () => {
    expect(readFileSync(join(root, 'src/main/jjCards.ts'), 'utf8')).toMatch(/storeGitGated\(store, full/)
    expect(readFileSync(join(root, 'src/main/jjCards.ts'), 'utf8')).toMatch(/history: storeGatedHistory\(historyFor\('git'\)\)/)
    expect(readFileSync(join(root, 'src/main/slotsApp.ts'), 'utf8')).toMatch(/git: \(cwd, args\) => storeGitGated\(cwd, args/)
    expect(readFileSync(join(root, 'src/main/platform/jjCompat.ts'), 'utf8')).toMatch(/git: \(cwd, args\) => storeGitGated\(cwd, args/)
    expect(readFileSync(join(root, 'src/main/platform/jjOperations.ts'), 'utf8')).toMatch(/storeGitGated\(cwd, args, \(\) => gitRun/)
  })
})
