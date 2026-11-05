// Git missing (#346): a test copy whose PATH has no git (through the run context's environment, never the machine's)
// says so wherever git matters, never "not a git repository": Provider Setup's Git row (Git not found, with the fix and
// Git for Windows), the status bar, the Changes tab, the Merge dialog. Remove All's opt-in deletion keeps the worktree, with the reason. A repository with a worktree agent, made
// with the suite's own git before Combwork starts. Throwaway profile and workspace, quiet; no agent is started.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'gitmissing-profile')
const ws = path.join(lib.WORK, 'gitmissing-ws')
const repo = path.join(ws, 'repo')
const tree = path.join(`${ws}.worktrees`, 'repo', 'wt')
const MISSING = "Git isn't installed (or isn't on Combwork's PATH)"
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/** The run context's PATH for a test copy without the folders that hold git (node stays, for the CLIs' launchers). */
function pathWithoutGit() {
  const env = lib.combworkEnv({ CW_USER_DATA: userData })
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
  return (env[key] ?? '')
    .split(path.delimiter)
    .filter((d) => d && !['git.exe', 'git.com'].some((g) => fs.existsSync(path.join(d.replace(/^"|"$/g, ''), g))))
    .join(path.delimiter)
}

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(repo)
  const main = lib.git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  fs.mkdirSync(path.dirname(tree), { recursive: true })
  lib.git(repo, ['worktree', 'add', '-q', '-b', 'cw/wt', tree, main])
  // A worktree agent, as Add Agent would have saved it: merged and clean, so Remove All's box would delete it with git.
  fs.mkdirSync(path.join(repo, '.combwork'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a-wt', name: 'Treeling', provider: 'claude-code', worktree: { path: tree, branch: 'cw/wt', base: main } }] }))
  lib.enableProviders(userData)
  const hidden = pathWithoutGit()
  check('the test copy gets a PATH without git', !hidden.toLowerCase().includes('\\git\\cmd'))

  const { app, page, inv } = await lib.launch({ userData, env: { PATH: hidden }, viewport: { width: 1400, height: 860 } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, ws)
  const shot = (name) => page.screenshot({ path: path.join(lib.WORK, `gitmissing-${name}.png`) })
  const theme = async (t) => {
    await inv('settings:update', { appearance: { theme: t } })
    await lib.sleep(300)
  }

  // --- Git itself.
  const tool = await lib.until(async () => {
    const t = await inv('git:tool', true)
    return t.state === 'missing' ? t : null
  }, 15000)
  check('Combwork finds git missing', !!tool, JSON.stringify(await inv('git:tool')))
  const item = page.locator('.statusbar .status-item.warn', { hasText: 'Git' })
  check('the status bar shows it', !!(await lib.until(async () => (await item.count()) === 1, 10000)))

  // --- Provider Setup: the Git row, both themes.
  await item.click()
  const setup = page.locator('.dialog', { hasText: 'Provider Setup' })
  const row = setup.locator('.setup-git[data-git="missing"]')
  check("the status bar item opens Provider Setup, with Git's row", !!(await lib.until(async () => (await row.count()) === 1, 10000)))
  const rowText = await row.innerText().catch(() => '')
  check('…"Git not found", the fix and Git for Windows', rowText.includes('Git not found') && rowText.includes('Install Git for Windows') && (await row.locator('button', { hasText: 'Git for Windows' }).count()) === 1, rowText)
  await shot('setup-dark')
  await theme('light')
  await shot('setup-light')
  await theme('dark')
  await page.keyboard.press('Escape')
  check('Escape closes Provider Setup', !!(await lib.until(async () => (await setup.count()) === 0, HUNG_MS)))

  // --- Add Agent: nothing in it needs git (#1442: no worktree choice), so it opens as usual.
  const info = await inv('agents:gitInfo', repo)
  check('gitInfo: git missing, not "not a repository"', info.isRepo === false && info.gitProblem === MISSING, JSON.stringify(info))
  await page.getByText('repo', { exact: true }).first().click()
  await lib.addMenuRun(page, 'Configure Agent and Add…')
  const add = page.locator('.dialog', { hasText: 'Add an agent' })
  await lib.until(async () => (await add.count()) === 1, 5000)
  check('Add Agent: no worktree choice to turn off (#1442)', (await add.locator('.choice', { hasText: /New worktree|Existing worktree/ }).count()) === 0 && (await add.locator('[data-where-note]').count()) === 1, await add.innerText())
  await shot('addagent')
  await page.keyboard.press('Escape')
  await lib.until(async () => (await add.count()) === 0, HUNG_MS)
  const refused = await inv('agents:add', repo, { name: 'Nope', provider: 'claude-code', location: 'new-worktree' }).then(() => null, (e) => String(e?.message ?? e))
  // 1.0 (#1451) pins no agent to a worktree: refused whether git runs or not.
  check('adding a worktree agent anyway is refused', !!refused && /pinned to worktrees/.test(refused), refused ?? 'added')

  // --- The Changes tab.
  const status = await inv('git:status', repo)
  check('git:status: git missing, not "not a repository"', status.gitProblem === MISSING, JSON.stringify(status))
  await page.locator('.tab', { hasText: 'Version Control' }).click()
  const view = page.locator('.changes-git-missing')
  check('the Changes tab says git is missing, with the fix', !!(await lib.until(async () => (await view.count()) === 1, 8000)) && (await view.innerText()).includes(MISSING) && (await page.getByText('is not a git repository').count()) === 0, await view.innerText().catch(() => ''))
  await shot('changes-dark')
  await theme('light')
  await shot('changes-light')
  await theme('dark')

  // --- The Merge dialog: the error, no merge.
  await page.locator('.tabs .tab', { hasText: /^\s*Session\s*$/ }).click()
  await lib.agentMenu(page, 'Treeling')
  await page.locator('.menu-item', { hasText: 'Merge…' }).click()
  const merge = page.locator('.dialog', { hasText: 'Merge' })
  const mergeErr = merge.locator('.banner.warn', { hasText: MISSING })
  check('the Merge dialog says git is missing', !!(await lib.until(async () => (await mergeErr.count()) === 1, 8000)), await merge.innerText().catch(() => ''))
  check('…and nothing can be merged', (await merge.locator('.btn.primary', { hasText: 'Merge' }).isDisabled().catch(() => false)) && (await merge.getByText('There is nothing to merge').count()) === 0)
  await shot('merge')
  await page.keyboard.press('Escape')
  await lib.until(async () => (await merge.count()) === 0, HUNG_MS)

  // --- Remove All's checks and its opt-in deletion keep the worktree.
  const checks = await inv('agents:worktreeChecks', repo)
  check('worktree checks: not removable, because git is missing', checks.length === 1 && checks[0].removable === false && checks[0].reason === MISSING, JSON.stringify(checks))
  const removed = await inv('agents:remove', repo, 'a-wt', { deleteWorktree: 'merged-clean' })
  check('removing with "merged and clean" keeps the worktree, saying why', removed.worktree?.deleted === false && removed.worktree.reason === MISSING && fs.existsSync(tree), JSON.stringify(removed))
  check('…and its branch', lib.git(repo, ['branch', '--format=%(refname:short)']).includes('cw/wt'))

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log(`FAIL ${e.stack || e}`)
  process.exit(1)
})
