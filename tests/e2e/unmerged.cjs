// A worktree agent's unmerged work in its name's hover and as the detail of Merge… in its pane's ⋯ (#977: a header button
// before): none at first, the count once a turn ends with a commit on its branch, gone after the merge, and • for
// uncommitted files alone. The agent runs the
// fake Claude Code (fake-claude/). Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
// Dev build only (#1580): it starts this checkout's Electron itself, and Two is a 0.9 worktree agent
// (agents:testLegacy, refused by a packaged build): a worktree agent's unmerged work is what it tests.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'unmerged-profile')
const ws = path.join(lib.WORK, 'unmerged-ws')
const claudeHome = path.join(lib.WORK, 'unmerged-claude-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
// Git in the test repositories, waiting out the Combwork under test's own git (lib.git, #199).
const git = (cwd, ...a) => lib.git(cwd, a)

;(async () => {
  for (const d of [userData, ws, ws + '.worktrees', claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  git(alpha, 'config', 'user.email', 't@t')
  git(alpha, 'config', 'user.name', 't')
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47897), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const until = async (fn, ms = 10000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(200)
    return v
  }
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)

  await page.getByText('alpha', { exact: true }).first().click()
  const two = await lib.addAgent(inv, alpha, { name: 'Two', location: 'new-worktree' })
  const wt = two.worktree.path
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase(), wt.toLowerCase()]))
  await inv('session:start', alpha, { agentId: two.id })
  check('the agent starts in its worktree', !!(await until(async () => (await live(two.id))?.status === 'ready', 15000)))

  const key = lib.ptyKey(alpha, two.id)
  const screen = async () => lib.plainText(await inv('pty:buffer', key).catch(() => ''))
  // What the agent and Combwork's branch check say, for a failed check's log line.
  const state = async () => {
    const s = await live(two.id)
    const b = (await inv('agents:branchStatuses')).find((x) => x.agentId === two.id)?.status
    return `status ${s?.status} since ${s?.statusSince}; branch ahead ${b?.ahead} dirty ${b?.dirty}; terminal …${(await screen()).slice(-160)}`
  }

  /**
   * A prompt to the agent, and the end of its turn, each step checked (#662): the fake echoes the prompt as it takes it
   * ("> turn n"), prints "Done: turn n" as the turn ends, and Combwork marks it finished once the Stop arrives: that turn's
   * finished (since the prompt), not the last turn's still showing.
   */
  let turns = 0
  const turn = async () => {
    const text = `turn ${++turns}`
    const asked = Date.now()
    const taken = await lib.sendPrompt(inv, key, text, { submitted: async () => (await screen()).includes(`> ${text}`), waitMs: HUNG_MS })
    const ended = taken && (await lib.until(async () => (await screen()).includes(`Done: ${text}`), HUNG_MS))
    const finished =
      ended &&
      (await lib.until(async () => {
        const s = await live(two.id)
        return s?.status === 'finished' && Date.parse(s.statusSince ?? '') >= asked
      }, HUNG_MS))
    check(`${text}: the agent takes it and finishes`, !!finished, `${!taken ? 'not taken' : !ended ? 'no Done' : 'not finished'}: ${await state()}`)
    if (taken > 1) console.log(`  (${text} was taken on attempt ${taken})`)
  }
  // What Merge… in its ⋯ says is left to merge (#975: the agent strip's tab had it as a badge): its commits ("1"), • for
  // uncommitted files alone, '' for nothing. Read from the menu's detail in one step, the menu closed after.
  const count = async () => {
    const { detail } = await mergeItem()
    return /(\d+) commits? not merged/.exec(detail)?.[1] ?? (/uncommitted/.test(detail) ? '•' : '')
  }
  const openMenu = async () => {
    await page.locator('.pane-header-bar').getByRole('button', { name: 'More', exact: true }).click()
    const item = page.locator('.menu .menu-item', { hasText: 'Merge…' })
    await until(() => item.isVisible(), HUNG_MS)
    return item
  }
  /** Merge… in the agent's ⋯: its detail (what is left to merge, or why it is disabled) and whether it is disabled. */
  const mergeItem = async () => {
    const item = await openMenu()
    const r = await item.evaluate((el) => ({ detail: el.querySelector('.menu-detail')?.textContent ?? '', disabled: el.classList.contains('disabled') }))
    await page.keyboard.press('Escape')
    await until(async () => (await page.locator('.menu').count()) === 0, HUNG_MS)
    return r
  }
  /** Merge… says there is work to merge. */
  const highlighted = async () => /not merged|uncommitted/.test((await mergeItem()).detail)

  await turn()
  await lib.sleep(2500) // A fixed wait on purpose: this checks that no count appears after a turn that changed nothing.
  check('nothing to merge: Merge… says nothing', (await count()) === '' && !(await highlighted()), `${await count()}`)

  // The agent commits on its branch during a turn: the count shows once the turn ends.
  fs.writeFileSync(path.join(wt, 'b.ts'), 'export const b = 2\n')
  git(wt, 'add', '-A')
  git(wt, 'commit', '-q', '-m', 'b')
  await turn()
  check('a commit shows on Merge… once the turn ends', !!(await until(async () => (await count()) === '1', 8000)), `${await count()}; ${await state()}`)
  check('Merge… says it', await highlighted())
  // Its name's hover says it too (#975: everything the strip's tab said).
  const nameTip = await lib.hoverTip(page, lib.paneHeader(page, 'Two').locator('.agent-name'), (t) => /To merge:/.test(t))
  check("and its name's hover says what is left to merge", /To merge: 1 commit not merged into/.test(nameTip), nameTip)
  await page.mouse.move(5, 5)
  await openMenu()
  check('Merge… in its ⋯ says what is unmerged', !!(await until(async () => (await page.locator('.menu .menu-item', { hasText: '1 commit not merged into' }).count()) > 0, HUNG_MS)))
  await page.screenshot({ path: path.join(lib.WORK, 'unmerged-1-commit.png') })
  await page.keyboard.press('Escape')

  // Merged: the count goes.
  const r = await inv('agents:merge', alpha, two.id, { squash: false, message: 'Merge Two', cleanup: false })
  check('the merge succeeds', r.ok, JSON.stringify(r))
  check('after the merge Merge… is plain again', !!(await until(async () => (await count()) === '', 8000)), `${await count()}`)

  // Uncommitted files alone: a dot.
  fs.writeFileSync(path.join(wt, 'c.ts'), 'export const c = 3\n')
  await turn()
  check('uncommitted files alone show •', !!(await until(async () => (await count()) === '•', 8000)), `${await count()}`)
  const st = (await inv('agents:branchStatuses')).find((b) => b.agentId === two.id)?.status
  check('the window was told the counts', st?.ahead === 0 && st?.dirty === 1, JSON.stringify(st))
  await page.screenshot({ path: path.join(lib.WORK, 'unmerged-2-dirty.png') })

  // Uncommitted files aren't merged (#1347): the merge is refused, counting them, and nothing is committed for the agent.
  const dirtyMerge = await inv('agents:merge', alpha, two.id, { squash: true, message: 'Squash Two', cleanup: false })
  check('a merge with uncommitted files is refused, counting them', !dirtyMerge.ok && dirtyMerge.uncommitted === 1 && git(wt, 'status', '--porcelain').includes('c.ts'), JSON.stringify(dirtyMerge))
  git(wt, 'add', '-A')
  git(wt, 'commit', '-q', '-m', 'c')

  // A squash merge that keeps the worktree: the branch's commits aren't in master, but their changes are.
  const sq = await inv('agents:merge', alpha, two.id, { squash: true, message: 'Squash Two', cleanup: false })
  check('the squash merge succeeds', sq.ok, JSON.stringify(sq))
  check('git still counts the commit as not merged', git(alpha, 'rev-list', '--count', `master..${two.worktree.branch}`).trim() !== '0')
  check('but after a squash merge Merge… is plain again', !!(await until(async () => (await count()) === '', 8000)), `${await count()}`)
  // New work on top of it counts again.
  fs.writeFileSync(path.join(wt, 'd.ts'), 'export const d = 4\n')
  git(wt, 'add', '-A')
  git(wt, 'commit', '-q', '-m', 'd')
  await turn()
  check('new work after a squash merge shows again', !!(await until(async () => (await count()) !== '' && (await highlighted()), 8000)), `${await count()}; ${await state()}`)

  // The Merge dialog: Merge and keeping the worktree are the defaults; Squash offers to move the branch.
  await (await openMenu()).click()
  const dialog = page.locator('[role=dialog]', { hasText: "Merge Two's work" })
  await until(async () => (await dialog.locator('input[type=radio]').count()) === 2, 5000)
  const choice = (name) => dialog.locator('label.choice', { hasText: name }).locator('input[type=radio]')
  const remove = dialog.locator('label', { hasText: 'Remove the worktree' }).locator('input[type=checkbox]')
  const move = dialog.locator('label', { hasText: /^\s*Move cw\// }).locator('input[type=checkbox]')
  check('the dialog defaults to Merge', (await choice('Merge').first().isChecked()) && !(await choice('Squash').isChecked()))
  check('and keeps the worktree', !(await remove.isChecked()))
  check('Merge has no branch move', (await move.count()) === 0)
  await choice('Squash').check()
  check('Squash offers to move the branch, ticked', (await move.count()) === 1 && (await move.isChecked()))
  await page.screenshot({ path: path.join(lib.WORK, 'unmerged-3-dialog.png') })
  await dialog.getByRole('button', { name: 'Merge', exact: true }).click()
  check('the dialog closes after the squash', !!(await until(async () => (await dialog.count()) === 0, 8000)))
  check('the branch was moved onto the squash commit', git(alpha, 'rev-list', '--count', `master..${two.worktree.branch}`).trim() === '0' && git(wt, 'rev-parse', 'HEAD').trim() === git(alpha, 'rev-parse', 'master').trim())
  check('and Merge… is plain', !!(await until(async () => (await count()) === '', 8000)), await count())
  fs.writeFileSync(path.join(wt, 'e.ts'), 'export const e = 5\n')
  git(wt, 'add', '-A')
  git(wt, 'commit', '-q', '-m', 'e')
  await turn()
  check('the next task counts only its own commit', !!(await until(async () => (await count()) === '1', 8000)), `${await count()}; ${await state()}`)
  const next = await inv('agents:merge', alpha, two.id, { squash: false, message: 'Merge Two again', cleanup: false })
  check('and merges cleanly', next.ok && fs.existsSync(path.join(alpha, 'e.ts')), JSON.stringify(next))
  check('the worktree and agent are still there', fs.existsSync(wt) && (await lib.paneHeader(page, 'Two').count()) === 1)

  // Not while the agent is in the middle of a task: Merge… is disabled (its count still shows), and Combwork refuses.
  fs.writeFileSync(path.join(wt, 'f.ts'), 'export const f = 6\n')
  const working = await lib.sendPrompt(inv, key, 'work 6', { submitted: async () => (await live(two.id))?.status === 'working', waitMs: HUNG_MS })
  check('the agent is working', working > 0, await state())
  const off = await until(async () => {
    const m = await mergeItem()
    return m.disabled && m
  }, HUNG_MS)
  check('Merge… is disabled while it works', !!off)
  check('…and says why', off?.detail === 'Two is working. Merge once it has finished.', JSON.stringify(off))
  const busy = await inv('agents:merge', alpha, two.id, { squash: false, message: 'Mid-task', cleanup: false }).then(() => 'merged', (e) => String(e.message ?? e))
  check('a merge while it works is refused', busy.includes('Two is working'), busy)
  check('and nothing was committed', git(wt, 'status', '--porcelain').includes('f.ts'))
  await until(async () => (await live(two.id))?.status === 'finished', 15000)
  check('Merge… is enabled again once it has finished', !!(await until(async () => !(await mergeItem()).disabled, 5000)))

  await inv('session:stop', alpha, two.id).catch(() => undefined)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
