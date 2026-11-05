// Repair renames agents' branches named after where the workspace was (#1305, Darren's decision on #1303: always, never
// offered, Combwork's records with them). Before: workspace Scratch with project juniper and three worktree agents on
// cw/Scratch/juniper/<agent>; JB1 has a card started (its work's line is JB1's branch), JB2's branch tracks a remote,
// and a branch cw/Tools/juniper/jb3 is already there. Combwork is closed; the workspace and its worktrees folder move to
// Tools. Repair's plan lists each branch in its table (Was → Now): "rename", the remote's note, JB3's kept (its new name
// is taken). Repair renames JB1's and JB2's in git (the worktrees follow, JB2's upstream kept), in project.json, and on
// JB1's card (LineRenamed), whose reconciliation then follows the new name (a commit on it seen, never Gone: line).
// Repair again changes nothing. Last, with nothing moved: JB1's rename cut short after git's step, before its card's
// LineRenamed (reopened, its reconciliation follows the rename, never Gone: line), and JB2's branch named after another
// place, not renamed yet. With project.json
// unwritable, Repair fails JB2's before git is touched and says JB1's isn't recorded yet; writable again, it finishes
// both. Dev build, throwaway profile and folders, the fake Claude Code; quiet.
// Dev build only (#1580): 0.9 worktrees on purpose: JB1–JB4 are 0.9 worktree agents (agents:testLegacy, refused by a
// packaged build), whose branches Repair renames.
const lib = require('./lib.cjs')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000
const userData = path.join(lib.WORK, 'repairbranches-profile')
const home = path.join(lib.WORK, 'repairbranches-claude-home')
const root = path.join(lib.WORK, 'repairbranches')
const scratch = path.join(root, 'Scratch')
const tools = path.join(root, 'Tools')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const git = (cwd, args) => execFileSync('git', args, { cwd, env: lib.gitEnv(), encoding: 'utf8' }).trim()
const branches = (cwd) => git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split(/\r?\n/)
const configOf = (project) => JSON.parse(fs.readFileSync(path.join(project, '.combwork', 'project.json'), 'utf8'))
const agentsOf = (project) => configOf(project).agents
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

;(async () => {
  for (const d of [userData, root, home]) fs.rmSync(d, { recursive: true, force: true })
  const juniper = path.join(scratch, 'juniper')
  lib.gitProject(juniper)
  const env = { ...lib.fakeClaude(userData, home, [juniper, path.join(`${scratch}.worktrees`, 'juniper', 'jb1')]), HIVE_API_PORT: lib.port(47842) }
  let card = 0
  {
    const { app, page, inv } = await lib.launch({ userData, env })
    try {
      await lib.openWorkspace(inv, page, scratch)
      const added = []
      for (const name of ['JB1', 'JB2', 'JB3', 'JB4']) added.push(await inv('agents:testLegacy', juniper, { location: 'new-worktree', name }))
      check('the agents work on branches named after Scratch', JSON.stringify(agentsOf(juniper).map((a) => a.worktree.branch)) === JSON.stringify(['cw/Scratch/juniper/jb1', 'cw/Scratch/juniper/jb2', 'cw/Scratch/juniper/jb3', 'cw/Scratch/juniper/jb4']), JSON.stringify(agentsOf(juniper).map((a) => a.worktree?.branch)))
      // JB1's card, started from the window: its work is on JB1's branch. Its session is stopped (Repair waits for that).
      card = (await inv('tasks:create', { title: 'Work on JB1’s branch', project: 'juniper' })).number
      await inv('tasks:start', card, { kind: 'agent', agentId: added[0].id })
      check("JB1's card works on JB1's branch", !!(await lib.until(async () => (await inv('tasks:work', card))?.line === 'cw/Scratch/juniper/jb1', HUNG_MS)))
      await lib.until(async () => (await inv('session:live')).some((s) => s.agentId === added[0].id), HUNG_MS)
      await inv('session:stop', juniper, added[0].id)
      await lib.until(async () => !(await inv('session:live')).length, HUNG_MS)
      await lib.until(() => configOf(juniper).lastPath, HUNG_MS)
    } finally {
      await app.close()
    }
  }
  // JB2's branch tracks a remote's; the name JB3's would take is already a branch.
  git(juniper, ['config', 'branch.cw/Scratch/juniper/jb2.remote', 'origin'])
  git(juniper, ['config', 'branch.cw/Scratch/juniper/jb2.merge', 'refs/heads/cw/Scratch/juniper/jb2'])
  git(juniper, ['branch', 'cw/Tools/juniper/jb3', 'HEAD'])
  // The move: the workspace and its worktrees folder, together.
  fs.renameSync(scratch, tools)
  fs.renameSync(`${scratch}.worktrees`, `${tools}.worktrees`)
  const proj = path.join(tools, 'juniper')
  // JB4's worktree is gone after the move (its branch kept): Recreate makes it again, on its branch renamed in the same Repair.
  fs.rmSync(path.join(`${tools}.worktrees`, 'juniper', 'jb4'), { recursive: true, force: true })
  const cfgFile = path.join(proj, '.combwork', 'project.json')
  const wt = (agent) => agentsOf(proj).find((a) => a.name === agent).worktree

  {
    const { app, page, inv } = await lib.launch({ userData, env })
    try {
      await lib.openWorkspace(inv, page, tools)
      const plan = await inv('workspace:movePlan')
      const planned = plan?.hosts.find((h) => h.name === 'juniper')?.branches ?? []
      const b = (agent) => planned.find((x) => x.agentName === agent)
      check('the plan: JB1’s branch to cw/Tools/juniper/jb1, its card’s work on it too', b('JB1')?.from === 'cw/Scratch/juniper/jb1' && b('JB1')?.to === 'cw/Tools/juniper/jb1' && !b('JB1')?.kept, JSON.stringify(planned))
      check('…JB2’s, noting the remote it tracks', b('JB2')?.to === 'cw/Tools/juniper/jb2' && b('JB2')?.remote === 'origin' && !b('JB2')?.kept, JSON.stringify(b('JB2')))
      check('…JB3’s kept: its new name is taken', b('JB3')?.kept === 'exists', JSON.stringify(b('JB3')))
      check('…two to rename, for the banner', plan?.branches === 2, String(plan?.branches))

      const banner = page.locator('.moved-banner')
      await lib.until(async () => (await banner.count()) === 1, HUNG_MS)
      await banner.locator('button.primary').click()
      const dialog = page.locator('.dialog', { has: page.locator('.move-repair') })
      const text = async () => (await dialog.innerText().catch(() => '')).replace(/\s+/g, ' ')
      check('the dialog lists each branch: was, now, rename', !!(await lib.until(async () => /JB1's branch: was cw\/Scratch\/juniper\/jb1, now cw\/Tools\/juniper\/jb1; will rename/.test(await text()), HUNG_MS)), await text())
      check('…JB2’s with its remote’s note', /JB2's branch: [^;]*; will rename; origin keeps the old name/.test(await text()), await text())
      check('…JB3’s kept, in the warning colour', /JB3's branch: [^;]*; will kept: the new name is taken/.test(await text()) && (await dialog.locator('.repair-plan tr', { hasText: "JB3's branch" }).locator('.warn-text').count()) > 0, await text())
      // JB4's worktree recreated: its branch is renamed in this Repair too, not the one after.
      await dialog.locator('.repair-plan tr', { hasText: "JB4's worktree" }).getByRole('button', { name: 'Recreate worktree' }).click()
      check('…JB4’s worktree recreated: its branch listed to rename now', !!(await lib.until(async () => /JB4's worktree: was [^;]*; will recreate on cw\/Tools\/juniper\/jb4/.test(await text()) && /JB4's branch: was cw\/Scratch\/juniper\/jb4, now cw\/Tools\/juniper\/jb4; will rename/.test(await text()), HUNG_MS)), await text())
      await page.screenshot({ path: path.join(lib.WORK, 'repairbranches-plan.png') })

      await dialog.getByRole('button', { name: 'Repair', exact: true }).click()
      check('Repair renames JB1’s and JB2’s, and keeps JB3’s', !!(await lib.until(async () => /branch cw\/Scratch\/juniper\/jb1 of agent JB1 is now cw\/Tools\/juniper\/jb1\./.test(await text()) && /branch cw\/Scratch\/juniper\/jb2 of agent JB2 is now cw\/Tools\/juniper\/jb2; it still tracks cw\/Scratch\/juniper\/jb2 on remote origin/.test(await text()) && /branch cw\/Scratch\/juniper\/jb3 of agent JB3 keeps its name/.test(await text()), HUNG_MS)), await text())
      await page.screenshot({ path: path.join(lib.WORK, 'repairbranches-report.png') })
      const now = branches(proj)
      // The report's Now column is each branch as it is after Repair (#1313 round 2): the new name once renamed, the old
      // one when it was kept.
      const nowCell = async (what) => (await dialog.locator('.repair-report tr', { hasText: what }).first().locator('td').nth(2).innerText()).trim()
      check('the report’s Now: JB1’s new name, and JB3’s kept name, as git has them', (await nowCell("JB1's branch")) === 'cw/Tools/juniper/jb1' && (await nowCell("JB3's branch")) === 'cw/Scratch/juniper/jb3' && now.includes('cw/Scratch/juniper/jb3') && now.includes('cw/Tools/juniper/jb1'), JSON.stringify({ jb1: await nowCell("JB1's branch"), jb3: await nowCell("JB3's branch"), git: now }))
      check('git has the new names', now.includes('cw/Tools/juniper/jb1') && now.includes('cw/Tools/juniper/jb2') && !now.includes('cw/Scratch/juniper/jb1') && !now.includes('cw/Scratch/juniper/jb2') && now.includes('cw/Scratch/juniper/jb3'), JSON.stringify(now))
      check('JB4’s worktree is back on its renamed branch, its record with it', fs.existsSync(wt('JB4').path) && git(wt('JB4').path, ['rev-parse', '--abbrev-ref', 'HEAD']) === 'cw/Tools/juniper/jb4' && wt('JB4').branch === 'cw/Tools/juniper/jb4' && !branches(proj).includes('cw/Scratch/juniper/jb4'), JSON.stringify({ wt: wt('JB4'), git: branches(proj) }))
      check('the worktrees have them out', git(wt('JB1').path, ['rev-parse', '--abbrev-ref', 'HEAD']) === 'cw/Tools/juniper/jb1' && git(wt('JB2').path, ['rev-parse', '--abbrev-ref', 'HEAD']) === 'cw/Tools/juniper/jb2')
      check('…JB2’s upstream kept, at the remote’s old name', git(proj, ['config', '--get', 'branch.cw/Tools/juniper/jb2.merge']) === 'refs/heads/cw/Scratch/juniper/jb2')
      check('Combwork’s record changed with them, nothing left pending (project.json)', wt('JB1').branch === 'cw/Tools/juniper/jb1' && wt('JB2').branch === 'cw/Tools/juniper/jb2' && wt('JB3').branch === 'cw/Scratch/juniper/jb3' && !configOf(proj).pendingBranchRenames, JSON.stringify(configOf(proj).agents.map((a) => a.worktree.branch)))
      check("JB1's card follows its line (LineRenamed)", (await inv('tasks:work', card))?.line === 'cw/Tools/juniper/jb1' && (await inv('tasks:facts', card)).some((f) => f.kind === 'LineRenamed' && f.data.to === 'cw/Tools/juniper/jb1'), JSON.stringify(await inv('tasks:work', card)))
      // A commit on the renamed branch: reconciliation reads the card's line by its new name (its head moved), never gone.
      fs.writeFileSync(path.join(wt('JB1').path, 'work.txt'), 'work\n')
      git(wt('JB1').path, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', 'work.txt'])
      git(wt('JB1').path, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'work'])
      const head = git(wt('JB1').path, ['rev-parse', 'HEAD'])
      check('…its reconciliation sees the commit on cw/Tools/juniper/jb1', !!(await lib.until(async () => (await inv('tasks:facts', card)).some((f) => f.kind === 'HeadMoved' && f.data.line === 'cw/Tools/juniper/jb1' && f.data.to === head), HUNG_MS)), JSON.stringify((await inv('tasks:facts', card)).map((f) => f.kind)))
      check('…and never took its branch for gone', !(await inv('tasks:facts', card)).some((f) => f.kind === 'Gone' && f.data.what === 'line'), JSON.stringify((await inv('tasks:facts', card)).filter((f) => f.kind === 'Gone')))
      // Its folder follows the worktree's move too (#1343: FolderMoved), and was never taken for gone, before Repair either.
      check("JB1's card follows its worktree to Tools (FolderMoved)", samePath((await inv('tasks:work', card))?.folder ?? '', wt('JB1').path) && (await inv('tasks:facts', card)).some((f) => f.kind === 'FolderMoved' && samePath(f.data.to, wt('JB1').path)), JSON.stringify(await inv('tasks:work', card)))
      check('…and never took its folder for gone', !(await inv('tasks:facts', card)).some((f) => f.kind === 'Gone'), JSON.stringify((await inv('tasks:facts', card)).filter((f) => f.kind === 'Gone')))
      await dialog.locator('.btn.primary', { hasText: 'Close' }).click()
      check('the banner goes: a branch kept for its taken name is nothing left to do', !!(await lib.until(async () => (await banner.count()) === 0, HUNG_MS)))
      const again = await inv('workspace:moveRepair')
      check('Repair again renames nothing', !again.done.some((l) => /branch/.test(l)) && again.failed.length === 0, JSON.stringify(again))
    } finally {
      await app.close()
    }
  }
  // Nothing moved now. JB1's rename (its card's line) was cut short after git's step, before the card's LineRenamed and
  // the record (a crash, say): git has cw/Tools/juniper/jb1-3; the agent's record, the card's line and the pending
  // rename still name cw/Tools/juniper/jb1. JB2's branch is named after another place (renamed outside Combwork), its
  // record with it: a rename not begun.
  git(proj, ['branch', '-m', 'cw/Tools/juniper/jb1', 'cw/Tools/juniper/jb1-3'])
  git(proj, ['branch', '-m', 'cw/Tools/juniper/jb2', 'cw/Elsewhere/juniper/jb2'])
  const cfg = configOf(proj)
  const jb1 = cfg.agents.find((a) => a.name === 'JB1')
  cfg.agents = cfg.agents.map((a) => (a.name === 'JB2' ? { ...a, worktree: { ...a.worktree, branch: 'cw/Elsewhere/juniper/jb2' } } : a))
  cfg.pendingBranchRenames = [{ agentId: jb1.id, from: 'cw/Tools/juniper/jb1', to: 'cw/Tools/juniper/jb1-3' }]
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  {
    const { app, page, inv } = await lib.launch({ userData, env })
    try {
      await lib.openWorkspace(inv, page, tools)
      const lineGone = async () => (await inv('tasks:facts', card)).filter((f) => f.kind === 'Gone' && f.data.what === 'line')
      // Its Work view read (which reconciles it) before any Repair: the card follows the rename git made, never gone.
      await inv('tasks:work', card)
      check("reopened, the card's reconciliation follows the cut-short rename (LineRenamed), never takes its line for gone", !!(await lib.until(async () => (await inv('tasks:facts', card)).some((f) => f.kind === 'LineRenamed' && f.data.to === 'cw/Tools/juniper/jb1-3'), HUNG_MS)) && (await inv('tasks:work', card))?.line === 'cw/Tools/juniper/jb1-3' && !(await lineGone()).length, JSON.stringify({ line: (await inv('tasks:work', card))?.line, gone: await lineGone(), facts: (await inv('tasks:facts', card)).map((f) => [f.kind, f.data.what ?? f.data.line ?? f.data.to ?? '']) }))
      const banner = page.locator('.moved-banner')
      check('nothing moved, two branches to finish: the banner says so', !!(await lib.until(async () => /branches are still named after an old folder/.test(await banner.innerText().catch(() => '')), HUNG_MS)), await banner.innerText().catch(() => ''))
      const plan = await inv('workspace:movePlan')
      check('…the plan: JB1’s rename finished, JB2’s made', JSON.stringify(plan?.hosts.find((h) => h.name === 'juniper')?.branches?.filter((b) => !b.kept).map((b) => [b.from, b.to, !!b.pending])) === JSON.stringify([['cw/Tools/juniper/jb1', 'cw/Tools/juniper/jb1-3', true], ['cw/Elsewhere/juniper/jb2', 'cw/Tools/juniper/jb2', false]]), JSON.stringify(plan?.hosts))
      // Combwork's record can't be written (project.json read-only): JB2's rename fails before git is touched; JB1's, whose
      // git step is done, is said not recorded yet. Nothing is left half done either way.
      fs.chmodSync(cfgFile, 0o444)
      let refused
      try {
        refused = await inv('workspace:moveRepair')
      } finally {
        fs.chmodSync(cfgFile, 0o644)
      }
      check('with project.json unwritable: JB2’s rename fails, JB1’s isn’t recorded yet', refused.failed.some((l) => /branch cw\/Elsewhere\/juniper\/jb2 of agent JB2 couldn't be renamed/.test(l)) && refused.failed.some((l) => /the branch of agent JB1 is now cw\/Tools\/juniper\/jb1-3, but Combwork couldn't record it yet/.test(l)), JSON.stringify(refused))
      // Its rows: JB2's (failed before git) is at its old name, JB1's (git's step done, not recorded) at its new one.
      const row = (agent) => refused.rows.find((r) => r.what.kind === 'branch' && r.what.agent === agent)
      check('…the report’s rows say where each branch is now, as git has it', row('JB2')?.outcome === 'failed' && row('JB2')?.now === 'cw/Elsewhere/juniper/jb2' && branches(proj).includes(row('JB2').now) && row('JB1')?.outcome === 'failed' && row('JB1')?.now === 'cw/Tools/juniper/jb1-3' && branches(proj).includes(row('JB1').now), JSON.stringify({ rows: refused.rows, git: branches(proj) }))
      check('…git has JB2’s as it was, and the records are unchanged', branches(proj).includes('cw/Elsewhere/juniper/jb2') && !branches(proj).includes('cw/Tools/juniper/jb2') && wt('JB1').branch === 'cw/Tools/juniper/jb1' && wt('JB2').branch === 'cw/Elsewhere/juniper/jb2', JSON.stringify({ git: branches(proj), cfg: configOf(proj).agents.map((a) => a.worktree.branch) }))
      check('…and the banner stays', (await banner.count()) === 1)
      const report = await inv('workspace:moveRepair')
      check('writable again, Repair finishes both: the records have the new names, nothing pending', report.done.some((l) => /branch cw\/Tools\/juniper\/jb1 of agent JB1 is now cw\/Tools\/juniper\/jb1-3\./.test(l)) && report.done.some((l) => /branch cw\/Elsewhere\/juniper\/jb2 of agent JB2 is now cw\/Tools\/juniper\/jb2/.test(l)) && wt('JB1').branch === 'cw/Tools/juniper/jb1-3' && wt('JB2').branch === 'cw/Tools/juniper/jb2' && branches(proj).includes('cw/Tools/juniper/jb2') && !configOf(proj).pendingBranchRenames && report.complete, JSON.stringify(report))
      check("…JB1's card on its new name, its line never taken for gone through the recovery", (await inv('tasks:work', card))?.line === 'cw/Tools/juniper/jb1-3' && !(await lineGone()).length)
      check('…and nothing is left to rename', !(await inv('workspace:movePlan'))?.hosts?.some((h) => h.branches?.some((x) => !x.kept)), JSON.stringify(await inv('workspace:movePlan')))
      check('…and the banner goes', !!(await lib.until(async () => (await banner.count()) === 0, HUNG_MS)))
    } finally {
      await app.close()
    }
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
