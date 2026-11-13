// HI-3148: a new lane on a released line (1.2.0: tagged v1.2.0, annotated, and merged into main) is refused before
// anything is recorded, naming a line to start on instead (Work merges into, else the next version) that exists and isn't released. The user's or the Assistant's override,
// for exactly that line, starts it and is its grant: its cards' starts onto 1.2.0 go through while it runs, and end with
// it. A running lane's next card, its line released meanwhile, is refused until the override is given to that lane.
// Start Lane… reads the same refusal first (for Start Anyway); a card's new Merges into on a released line says so. Real Git.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-lanereleased-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const lanes = await import('../src/main/lanes')
const { workflowFor } = await import('../src/main/workflow/service')
const { isRefusal } = await import('../src/main/workflow/runtime')
const { agentActor } = await import('../src/shared/workflow/facts')
const { preset } = await import('../src/shared/workflow/options')
const { cardTargetSaid } = await import('../src/main/cardTargetReply')
const { englishText } = await import('../src/shared/advanced')

type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
const user = { kind: 'user' } as const
let n = 0

/** Releases `line`: an annotated tag v<line> on it, and it merged into main. */
function release(repo: string, line: string): void {
  git(repo, 'checkout', '-q', line)
  writeFileSync(join(repo, `${line}.txt`), `${line}\n`)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', line)
  git(repo, 'tag', '-a', `v${line}`, '-m', `release ${line}`)
  git(repo, 'checkout', '-q', 'main')
  git(repo, 'merge', '-q', '--no-ff', '-m', `release ${line}`, line)
}

/** A Pair project merging into main, listing 1.2.0 (released) and 1.3.0 (not) as other branches work can merge into. */
async function project(): Promise<{ w: WS; repo: string }> {
  const ws = join(base, `ws-${++n}`)
  const repo = join(ws, 'p')
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  mkdirSync(join(ws, '.combwork'), { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Pat Builder'], ['user.email', 'pat@example.com'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v)
  writeFileSync(join(repo, '.gitignore'), '.combwork/\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  git(repo, 'branch', '1.2.0')
  release(repo, '1.2.0')
  git(repo, 'branch', '1.3.0', '1.2.0')
  const { platform: _p, ...pair } = preset('git', 'pair')
  const agents = [{ id: 'b1', name: 'B1', workflowRole: 'either' }, { id: 'r1', name: 'R1', workflowRole: 'either' }]
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents, workflow: { platform: 'git', preset: 'pair', options: { ...pair, target: 'main', otherTargets: ['1.2.0', '1.3.0'] } } }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, repo }
}
const card = (w: WS, title: string, target?: string) => inWorkspace(w, () => tasks.createTask({ title, project: 'p', ...(target ? { target } : {}) }, user))
const start = async (w: WS, repo: string, number: number) => {
  const wf = (await workflowFor(w, repo))!
  return store.boardWrite(w, async () => wf.start(`#${number}`, agentActor('b1')))
}

describe('a lane on a released line (HI-3148)', () => {
  it('is refused, recording nothing, with a line to start on instead; Start Lane… reads the same first', async () => {
    const { w } = await project()
    const c = await card(w, 'New work')
    await expect(lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [c.number], by: 'You', target: '1.2.0' })).rejects.toThrow(/^1\.2\.0 is released \(v1\.2\.0, tagged .+, merged into main\)\. Did you mean main\?/)
    expect(await lanes.listLanes(w)).toEqual([])
    const check = await lanes.laneReleaseCheck(w, 'p', 'b1', '1.2.0')
    expect(check?.target).toBe('1.2.0')
    expect(englishText(check!.text)).toMatch(/^1\.2\.0 is released/)
    // Not released (1.3.0, main): nothing to say.
    expect(await lanes.laneReleaseCheck(w, 'p', 'b1', '1.3.0')).toBeNull()
    expect(await lanes.laneReleaseCheck(w, 'p', 'b1', null)).toBeNull()
  })

  it('the override for that line starts it; its cards start on 1.2.0 while it runs, and not once it ends', async () => {
    const { w, repo } = await project()
    const [a, b] = [await card(w, 'Hotfix'), await card(w, 'After', '1.2.0')]
    // Given for another line (the window's pick changed since): refused as before.
    await expect(lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [a.number], by: 'You', target: '1.2.0', released: { target: '1.3.0', reason: 'hotfix', by: 'user' } })).rejects.toThrow(/1\.2\.0 is released/)
    const r = await lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [a.number, b.number], by: 'You', target: '1.2.0', released: { target: '1.2.0', reason: 'hotfix 1.2.1', by: 'user' } })
    expect((await lanes.rawLanes(w)).find((l) => l.id === r.lane.id)?.releasedOverride).toMatchObject({ target: '1.2.0', by: 'user', reason: 'hotfix 1.2.1' })
    expect(await start(w, repo, a.number)).toMatchObject({ ok: true })
    // Ended, its grant goes with it: its next card's start onto 1.2.0 (its own Merges into) is refused again.
    await lanes.endLane(w, r.lane.id, { abandoned: true })
    const after = await start(w, repo, b.number)
    expect(isRefusal(after) && after.rule).toBe('start.released')
  })

  it('a running lane’s next card, its line released meanwhile: refused, then started once that lane is given the override', async () => {
    const { w, repo } = await project()
    const [a, b] = [await card(w, 'First'), await card(w, 'Second')]
    const r = await lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [a.number, b.number], by: 'You', target: '1.3.0' })
    release(repo, '1.3.0')
    const refused = await start(w, repo, a.number)
    expect(isRefusal(refused) && refused.rule).toBe('start.released')
    // An override for another line than the lane's: refused.
    await expect(lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [a.number, b.number], by: 'You', released: { target: '1.2.0', reason: 'hotfix', by: 'assistant' } })).rejects.toThrow(/B1’s lane merges into 1\.3\.0 until it ends/)
    await lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [a.number, b.number], by: 'You', released: { target: '1.3.0', reason: 'the user asked: 1.3.1', by: 'assistant' } })
    expect((await lanes.rawLanes(w)).find((l) => l.id === r.lane.id)?.releasedOverride).toMatchObject({ target: '1.3.0', by: 'assistant' })
    expect(await start(w, repo, a.number)).toMatchObject({ ok: true })
  })

  it('a tag made as the lane is saved (HR2’s round 1): decided again under the lock and refused, nothing recorded', async () => {
    const { w, repo } = await project()
    const c = await card(w, 'Late tag')
    let made = false
    // The save's own check, just before it is written: the release tag lands after the decision.
    const commit = (): void => {
      if (made) return
      made = true
      git(repo, 'tag', '-a', 'v1.3.0', '-m', 'release 1.3.0', '1.3.0')
    }
    await expect(lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [c.number], by: 'You', target: '1.3.0', commit })).rejects.toThrow(/^1\.3\.0 is released \(v1\.3\.0/)
    expect(made).toBe(true)
    expect(await lanes.listLanes(w)).toEqual([])
  })

  it('a card’s Merges into set to a released line says its start there will be refused', async () => {
    const { w } = await project()
    const c = await card(w, 'Retargeted')
    await inWorkspace(w, () => tasks.setTarget(c.number, '1.2.0', user))
    const said = await inWorkspace(w, () => cardTargetSaid(w, c.number, 'p'))
    expect(said.note).toMatch(/1\.2\.0 is released \(v1\.2\.0, merged into main\): #\d+'s start there is refused unless the user OKs work on 1\.2\.0 \(a hotfix\), given as override\.released 1\.2\.0\. Did you mean main\?/)
    await inWorkspace(w, () => tasks.setTarget(c.number, '1.3.0', user))
    expect((await inWorkspace(w, () => cardTargetSaid(w, c.number, 'p'))).note).not.toMatch(/released/)
  })
})
