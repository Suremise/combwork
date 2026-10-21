// Repair renames agents' branches named after where the workspace was (#1305, Darren's decision on #1303: always, never
// offered). Before: workspace Scratch with project juniper and three worktree agents on hive/Scratch/juniper/<agent>;
// JB1 has a card started (its work's line is JB1's branch), JB2's branch tracks a remote, and a branch
// hive/Tools/juniper/jb3 is already there. Hive is closed; the workspace and its worktrees folder move to Tools.
// Repair's plan lists each branch in its table (Was → Now): JB2's "rename" with its remote's note, JB3's kept (its new
// name is taken), JB1's kept until its card is Done (a rename under the card's work would read as its branch gone).
// Repair renames JB2's in git (the worktree follows, its upstream kept) and in project.json, and says what it kept;
// Repair again changes nothing. Then JB1's card is Done: on opening, the banner says a branch is still named after an
// old folder, and Repair renames it. Dev build, throwaway profile and folders, the fake Claude Code; quiet.
const lib = require('./lib.cjs')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { baseEnv } = require('./runContext.cjs')

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
const git = (cwd, args) => execFileSync('git', args, { cwd, env: baseEnv(), encoding: 'utf8' }).trim()
const branches = (cwd) => git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split(/\r?\n/)
const agentsOf = (project) => JSON.parse(fs.readFileSync(path.join(project, '.hive', 'project.json'), 'utf8')).agents

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
      for (const name of ['JB1', 'JB2', 'JB3']) added.push(await inv('agents:add', juniper, { location: 'new-worktree', name }))
      check('the agents work on branches named after Scratch', JSON.stringify(agentsOf(juniper).map((a) => a.worktree.branch)) === JSON.stringify(['hive/Scratch/juniper/jb1', 'hive/Scratch/juniper/jb2', 'hive/Scratch/juniper/jb3']), JSON.stringify(agentsOf(juniper).map((a) => a.worktree?.branch)))
      // JB1's card, started from the window: its work is on JB1's branch. Its session is stopped (Repair waits for that).
      card = (await inv('tasks:create', { title: 'Work on JB1’s branch', project: 'juniper' })).number
      await inv('tasks:start', card, { kind: 'agent', agentId: added[0].id })
      check("JB1's card works on JB1's branch", !!(await lib.until(async () => (await inv('tasks:work', card))?.line === 'hive/Scratch/juniper/jb1', HUNG_MS)))
      await lib.until(async () => (await inv('session:live')).some((s) => s.agentId === added[0].id), HUNG_MS)
      await inv('session:stop', juniper, added[0].id)
      await lib.until(async () => !(await inv('session:live')).length, HUNG_MS)
      await lib.until(() => JSON.parse(fs.readFileSync(path.join(juniper, '.hive', 'project.json'), 'utf8')).lastPath, HUNG_MS)
    } finally {
      await app.close()
    }
  }
  // JB2's branch tracks a remote's; the name JB3's would take is already a branch.
  git(juniper, ['config', 'branch.hive/Scratch/juniper/jb2.remote', 'origin'])
  git(juniper, ['config', 'branch.hive/Scratch/juniper/jb2.merge', 'refs/heads/hive/Scratch/juniper/jb2'])
  git(juniper, ['branch', 'hive/Tools/juniper/jb3', 'HEAD'])
  // The move: the workspace and its worktrees folder, together.
  fs.renameSync(scratch, tools)
  fs.renameSync(`${scratch}.worktrees`, `${tools}.worktrees`)
  const proj = path.join(tools, 'juniper')
  const wt = (agent) => agentsOf(proj).find((a) => a.name === agent).worktree

  {
    const { app, page, inv } = await lib.launch({ userData, env })
    try {
      await lib.openWorkspace(inv, page, tools)
      const plan = await inv('workspace:movePlan')
      const planned = plan?.hosts.find((h) => h.name === 'juniper')?.branches ?? []
      const b = (agent) => planned.find((x) => x.agentName === agent)
      check('the plan: JB2’s branch to hive/Tools/juniper/jb2, noting the remote it tracks', b('JB2')?.from === 'hive/Scratch/juniper/jb2' && b('JB2')?.to === 'hive/Tools/juniper/jb2' && b('JB2')?.remote === 'origin' && !b('JB2')?.kept, JSON.stringify(planned))
      check('…JB3’s kept: its new name is taken', b('JB3')?.kept === 'exists', JSON.stringify(b('JB3')))
      check('…JB1’s kept until its card is Done', b('JB1')?.kept === 'card' && JSON.stringify(b('JB1')?.cards) === JSON.stringify([card]), JSON.stringify(b('JB1')))
      check('…one to rename, for the banner', plan?.branches === 1, String(plan?.branches))

      const banner = page.locator('.moved-banner')
      await lib.until(async () => (await banner.count()) === 1, HUNG_MS)
      await banner.locator('button.primary').click()
      const dialog = page.locator('.dialog', { has: page.locator('.move-repair') })
      const text = async () => (await dialog.innerText().catch(() => '')).replace(/\s+/g, ' ')
      check('the dialog lists each branch: was, now, rename with the remote’s note', !!(await lib.until(async () => /JB2's branch: was hive\/Scratch\/juniper\/jb2, now hive\/Tools\/juniper\/jb2; will rename; origin keeps the old name/.test(await text()), HUNG_MS)), await text())
      check('…JB3’s kept, in the warning colour', /JB3's branch: [^;]*; will kept: the new name is taken/.test(await text()) && (await dialog.locator('.repair-plan tr', { hasText: "JB3's branch" }).locator('.warn-text').count()) > 0, await text())
      check('…JB1’s kept until its card is Done, naming the card', new RegExp(`JB1's branch: [^;]*; will kept until \\S*${card}\\b[^;]* is Done`).test(await text()), await text())
      await page.screenshot({ path: path.join(lib.WORK, 'repairbranches-plan.png') })

      await dialog.getByRole('button', { name: 'Repair', exact: true }).click()
      check('Repair renames JB2’s, and says why JB1’s and JB3’s keep their names', !!(await lib.until(async () => /JB2's branch hive\/Scratch\/juniper\/jb2 is now hive\/Tools\/juniper\/jb2; it still tracks origin's hive\/Scratch\/juniper\/jb2/.test(await text()) && /JB3's branch hive\/Scratch\/juniper\/jb3 keeps its name/.test(await text()) && new RegExp(`JB1's branch hive/Scratch/juniper/jb1 keeps its name until #${card} is Done`).test(await text()), HUNG_MS)), await text())
      await page.screenshot({ path: path.join(lib.WORK, 'repairbranches-report.png') })
      const now = branches(proj)
      check('git has JB2’s new name, JB1’s and JB3’s as they were', now.includes('hive/Tools/juniper/jb2') && !now.includes('hive/Scratch/juniper/jb2') && now.includes('hive/Scratch/juniper/jb1') && now.includes('hive/Scratch/juniper/jb3'), JSON.stringify(now))
      check('JB2’s worktree has it out', git(wt('JB2').path, ['rev-parse', '--abbrev-ref', 'HEAD']) === 'hive/Tools/juniper/jb2')
      check('…its upstream kept, at the remote’s old name', git(proj, ['config', '--get', 'branch.hive/Tools/juniper/jb2.merge']) === 'refs/heads/hive/Scratch/juniper/jb2')
      check('Hive’s record changed with it (project.json)', wt('JB2').branch === 'hive/Tools/juniper/jb2' && wt('JB1').branch === 'hive/Scratch/juniper/jb1' && wt('JB3').branch === 'hive/Scratch/juniper/jb3', JSON.stringify(agentsOf(proj).map((a) => a.worktree.branch)))
      check("JB1's card still works on its branch", (await inv('tasks:work', card))?.line === 'hive/Scratch/juniper/jb1')
      await dialog.locator('.btn.primary', { hasText: 'Close' }).click()
      check('the banner goes: branches kept are nothing left to do', !!(await lib.until(async () => (await banner.count()) === 0, HUNG_MS)))
      const again = await inv('workspace:moveRepair')
      check('Repair again renames nothing', !again.done.some((l) => /branch/.test(l)) && again.failed.length === 0, JSON.stringify(again))
      // JB1's card is done (moved there past its rules, with a reason, as a person may).
      const moved = await inv('tasks:move', card, 'done', { confirm: true, reason: 'merged by hand (test)' })
      check("JB1's card is Done", !!(await lib.until(async () => (await inv('tasks:list')).find((c) => c.number === card)?.column === 'done', HUNG_MS)), JSON.stringify(moved))
    } finally {
      await app.close()
    }
  }
  // Opened again, nothing moved: the banner says a branch is still named after an old folder, and Repair renames it.
  {
    const { app, page, inv } = await lib.launch({ userData, env })
    try {
      await lib.openWorkspace(inv, page, tools)
      const banner = page.locator('.moved-banner')
      check('a branch still named after an old folder, nothing moved: the banner says so', !!(await lib.until(async () => /branch is still named after an old folder/.test(await banner.innerText().catch(() => '')), HUNG_MS)), await banner.innerText().catch(() => ''))
      const report = await inv('workspace:moveRepair')
      check('…and Repair renames JB1’s, now its card is Done', report.done.some((l) => /JB1's branch hive\/Scratch\/juniper\/jb1 is now hive\/Tools\/juniper\/jb1\./.test(l)) && branches(proj).includes('hive/Tools/juniper/jb1') && wt('JB1').branch === 'hive/Tools/juniper/jb1', JSON.stringify(report))
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
