import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
const base = tempDir('cw-dbg-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { createWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { workflowFor } = await import('../src/main/workflow/service')
const { agentActor } = await import('../src/shared/workflow/facts')
const { preset } = await import('../src/shared/workflow/options')
const T = await import('../src/main/workflow/targets')
const G = await import('../src/main/platform/git')
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
it('dbg', async () => {
  const ws = join(base, 'ws'); const repo = join(ws, 'p')
  mkdirSync(join(repo, '.combwork'), { recursive: true }); mkdirSync(join(ws, '.combwork'), { recursive: true })
  git(repo, 'init', '-q', '-b', 'main'); for (const [k, v] of [['user.name', 'P'], ['user.email', 'p@e.com']]) git(repo, 'config', k, v)
  writeFileSync(join(repo, '.gitignore'), '.combwork/\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'i'); git(repo, 'branch', '1.1.0')
  const { platform: _p, ...pair } = preset('git', 'pair')
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents: [{ id: 'b1', name: 'B1' }], workflow: { platform: 'git', preset: 'pair', options: { ...pair, target: '1.1.0' } } }))
  const w = createWorkspaceService(); await w.open(ws)
  const c = await inWorkspace(w, () => tasks.createTask({ title: 'x', project: 'p' }, { kind: 'user' }))
  const wf = (await workflowFor(w, repo))!
  console.log('start', JSON.stringify(await store.boardWrite(w, async () => wf.start(`#${c.number}`, agentActor('b1')))))
  console.log('putback', JSON.stringify(await store.boardWrite(w, async () => wf.putBack(`#${c.number}`, 'user'))))
  writeFileSync(join(repo, 'left.txt'), 'left\n')
  const s = wf.state(wf.store.card(c.number))
  console.log('STATE', s.stage, JSON.stringify(s.started), JSON.stringify(s.lines), wf.folderOf(s))
  console.log('DIRTY', JSON.stringify(await G.dirty(repo)))
  console.log('OWN', JSON.stringify(await T.hasOwnWork(repo, s, wf.folderOf(s))))
})
