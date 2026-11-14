// HI-3155 on jj (the pinned real jj, colocated): a project's release offer through its platform's release reads, never
// Git's. Work merges into (1.4.0) tagged v1.4.0 and in main: move it to 1.5.0, which exists and isn't released; jj keeps
// no tag date. Followed: a jj operation (1.5.0 released too) moves the operation head, the offer is read again, and with
// no unreleased next version it offers no move. Skipped without the fetched jj (npm run jj:fetch).
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { TESTED_JJ } from '../src/shared/jjTool'
import { harness, jjExe } from './jjWorkspaceHarness'
import { tempDir } from './tempDir'

if (!jjExe) console.warn(`releaseOfferJj.test.ts skipped: jj ${TESTED_JJ.version} isn't fetched (npm run jj:fetch)`)

// jj's release reads through the harness's jj (its isolated environment), as the app's are through its own.
const jjRuns = vi.hoisted(() => ({ runner: null as unknown }))
vi.mock('../src/main/platform/releaseReadsPorts', async (orig) => {
  const real = await orig<typeof import('../src/main/platform/releaseReadsPorts')>()
  const { jjReleaseReadsWith } = await import('../src/main/platform/jjReleaseReads')
  return { ...real, releaseReadsOf: (p: Parameters<typeof real.releaseReadsOf>[0]) => (p === 'jj' && jjRuns.runner ? jjReleaseReadsWith(jjRuns.runner as never) : real.releaseReadsOf(p)) }
})

const base = tempDir('releaseofferjj-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
const { boardFile, closeAllBoards } = await import('../src/main/boardStore')
const { fileSlotConn } = await import('../src/main/slots')
const { gitHistory } = await import('../src/main/platform/gitHistory')
const { boardPrepStore } = await import('../src/main/platform/jjSlotPrep')
const { registerWorkspacePort } = await import('../src/main/platform/workspacePorts')
const { offerFor, currentOffer, startReleaseOffers, stopReleaseOffers, releaseOfferTiming } = await import('../src/main/workflow/releaseOffer')
const { DEFAULT_PROJECT_CONFIG } = await import('../src/shared/defaults')

const REAL_JJ_MS = 180_000
const cleanups: (() => Promise<void> | void)[] = []
afterAll(async () => {
  stopReleaseOffers()
  for (const c of cleanups.splice(0).reverse()) await c()
  closeAllBoards()
})

describe.skipIf(!jjExe)('a release offer on jj (HI-3155)', () => {
  it('released Work merges into: move to the next version; a jj operation reads it again', { timeout: REAL_JJ_MS }, async () => {
    const h = harness()
    jjRuns.runner = h.runner
    const { repo } = h.repo('project', true)
    const wsPath = dirname(repo)
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.combwork/\n')
    // 1.4.0: a commit past main, tagged v1.4.0, main moved onto it (released); 1.5.0 at main (made, not released).
    writeFileSync(join(repo, 'r.txt'), 'r\n')
    h.jj(repo, 'commit', '-m', 'release work')
    h.jj(repo, 'bookmark', 'create', '1.4.0', '-r', '@-')
    h.jj(repo, 'tag', 'set', 'v1.4.0', '-r', '1.4.0')
    h.jj(repo, 'bookmark', 'set', 'main', '-r', '1.4.0')
    h.jj(repo, 'bookmark', 'create', '1.5.0', '-r', 'main')
    mkdirSync(join(repo, '.combwork'), { recursive: true })
    writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ ...DEFAULT_PROJECT_CONFIG, id: 'p1', platform: 'jj', platformFound: 'jj', agents: [], workflow: { platform: 'jj', preset: null, options: { review: 'you', folder: 'slots', finish: 'userIntegrates', target: '1.4.0', otherTargets: ['1.5.0'] }, presetAsked: 'chosen' } }))
    const ws = createWorkspaceService()
    await ws.open(wsPath)
    await ws.refresh()
    // jj's workspace port, as the app registers it (its targets are jj's bookmarks).
    const conn = fileSlotConn(boardFile(wsPath))
    const prep = boardPrepStore(conn)
    registerWorkspacePort('jj', h.portWith({ prep: () => prep, contains: (s, t, c, at) => gitHistory.contains(s, t, c, at) }))
    cleanups.push(async () => {
      conn.close()
      await disposeWorkspaceService(ws)
    })

    const o = (await offerFor(ws, repo, 'project'))!
    expect(o.move).toEqual({ target: '1.4.0', tag: 'v1.4.0', into: 'main', date: null, moveTo: '1.5.0', startNext: null })
    expect(o.cleanup).toBeNull()

    // Followed: the offer comes; 1.5.0 released too (jj operations: the operation head moves), read again, no move left.
    releaseOfferTiming.tickMs = 150
    startReleaseOffers()
    const soon = async (ok: (x: ReturnType<typeof currentOffer>) => boolean): Promise<ReturnType<typeof currentOffer>> => {
      const end = Date.now() + 60_000
      for (;;) {
        const x = currentOffer(ws, repo)
        if (ok(x)) return x
        if (Date.now() > end) throw new Error(`offer never came: ${JSON.stringify(x)}`)
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    await soon((x) => x?.move?.moveTo === '1.5.0')
    writeFileSync(join(repo, 'n.txt'), 'n\n')
    h.jj(repo, 'commit', '-m', 'next work')
    h.jj(repo, 'bookmark', 'set', '1.5.0', '-r', '@-')
    h.jj(repo, 'tag', 'set', 'v1.5.0', '-r', '1.5.0')
    h.jj(repo, 'bookmark', 'set', 'main', '-r', '1.5.0')
    const after = await soon((x) => !!x?.move && x.move.moveTo === null)
    // 1.5.0 (another branch work can merge into) is released now too: offered to come off, as nothing uses it.
    expect(after?.cleanup?.drop.map((d) => d.branch)).toEqual(['1.5.0'])
  })
})
