// The Changes tab's picker and pages (#476). A project with no worktrees opens on its folder, with no picker. A project
// with worktrees opens on Unused worktrees: first the picker says Hive is looking and the page shows a spinner and a
// message (listing is slowed, HIVE_TEST_SLOW_IPC), then the list, each labelled with who made it ("was B4": the Hive
// agent whose session last ran there; "not made by Hive": a `git worktree add` of its own). The picker lists the unused
// worktrees, then the folders agents work in (#1569: Coder's 0.9 worktree, the slot kept for it once the project has
// opened), then the project folder, last. Coming back shows the last list at once while it is
// checked again, and Refresh looks again; a Refresh that fails keeps the list, says so, and Retry recovers
// (HIVE_TEST_FAIL_IPC). A project with no agent whose only worktree is unused shows the spinner while it is first looked
// at, never its folder as if it had none; if that first look fails, it says so with Retry (still not its folder), and
// Retry settles it: the list, or, for a project with no worktrees, its folder. A project whose worktrees are all in use
// shows Unused worktrees empty. Each
// page says what it shows, and a diff's Open file opens that folder's copy, an unused worktree outside the workspace's
// too (#495). Screenshots in both themes. Repositories made with the suite's own git; throwaway profile
// and workspace; quiet; no agent is started.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'changespicker-profile')
const ws = path.join(lib.WORK, 'changespicker-ws')
const trees = `${ws}.worktrees`
const outside = path.join(lib.WORK, 'changespicker-outside')
const solo = path.join(ws, 'solo')
const repo = path.join(ws, 'repo')
const busy = path.join(ws, 'busy')
const cold = path.join(ws, 'cold')
const coldfail = path.join(ws, 'coldfail')
const plain = path.join(ws, 'plain')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const git = (cwd, ...a) => lib.git(cwd, ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a])

/** A worktree agent of `project` as Add Agent saves it, its worktree made with git in Hive's folder. */
function inUse(project, name) {
  const main = git(project, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
  const wt = { path: path.join(trees, path.basename(project), name.toLowerCase()), branch: `hive/${name.toLowerCase()}`, base: main }
  git(project, 'worktree', 'add', '-q', '-b', wt.branch, wt.path, main)
  return { id: `a-${name.toLowerCase()}`, name, provider: 'claude-code', worktree: wt }
}

;(async () => {
  for (const d of [userData, ws, trees, outside]) fs.rmSync(d, { recursive: true, force: true })
  for (const p of [solo, repo, busy, cold, coldfail, plain]) lib.gitProject(p)
  const main = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
  // repo: Coder works in a worktree; B4's worktree (Hive's folder, a session of B4's ran there) and one made outside
  // Hive are unused.
  const coder = inUse(repo, 'Coder')
  const b4 = path.join(trees, 'repo', 'b4')
  git(repo, 'worktree', 'add', '-q', '-b', 'hive/b4', b4, main)
  fs.writeFileSync(path.join(b4, 'b4.txt'), 'work\n')
  git(b4, 'add', '-A')
  git(b4, 'commit', '-qm', 'B4 work')
  const other = path.join(outside, 'experiment')
  git(repo, 'worktree', 'add', '-q', '-b', 'experiment', other, main)
  fs.mkdirSync(path.join(repo, '.hive'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [coder] }))
  const at = new Date().toISOString()
  fs.writeFileSync(path.join(repo, '.hive', 'sessions.json'), JSON.stringify({ version: 1, sessions: [{ id: 'b4-session', agent: 'claude-code', name: 'B4 work', createdAt: at, lastActiveAt: at, archived: false, agentId: 'a-b4', agentName: 'B4', cwd: b4 }] }))
  // cold: no agents, one unused worktree (its agent was removed, keeping it).
  const coldMain = git(cold, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
  git(cold, 'worktree', 'add', '-q', '-b', 'hive/old', path.join(trees, 'cold', 'old'), coldMain)
  // coldfail: the same, its first listing failing; plain: no worktrees, its first listing failing.
  git(coldfail, 'worktree', 'add', '-q', '-b', 'hive/kept', path.join(trees, 'coldfail', 'kept'), git(coldfail, 'rev-parse', '--abbrev-ref', 'HEAD').trim())
  // busy: its only worktree is in use.
  fs.mkdirSync(path.join(busy, '.hive'), { recursive: true })
  fs.writeFileSync(path.join(busy, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [inUse(busy, 'Solo')] }))

  const { app, page, inv } = await lib.launch({ userData, viewport: { width: 1400, height: 860 } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, ws)
  const theme = async (t) => {
    await inv('settings:update', { appearance: { theme: t } })
    await lib.sleep(300)
  }
  const shots = async (name) => {
    for (const t of ['dark', 'light']) {
      await theme(t)
      await page.screenshot({ path: path.join(lib.WORK, `changespicker-${name}-${t}.png`) })
    }
    await theme('dark')
  }
  const picker = page.locator('.split-list .changes-picker')
  const about = page.locator('.changes-about')
  const openChanges = async (name) => {
    await page.getByText(name, { exact: true }).first().click()
    await page.locator('.tab', { hasText: 'Version Control' }).click()
  }
  const slow = (v) => app.evaluate((_, x) => {
    process.env.HIVE_TEST_SLOW_IPC = x
  }, v)
  const failing = (v) => app.evaluate((_, x) => {
    process.env.HIVE_TEST_FAIL_IPC = x
  }, v)

  // --- No worktrees: the project folder, no picker, and what it shows.
  await openChanges('solo')
  check('a project without worktrees opens on its folder, with no picker', !!(await lib.until(async () => (await about.getAttribute('data-about').catch(() => null)) === 'project', 10000)) && (await picker.count()) === 0)
  check('…its description on the right, the left panel without one (#476)', (await page.locator('.split-main .changes-about').count()) === 1 && (await page.locator('.split-list .changes-about').count()) === 0)
  check('…saying what the page shows', (await about.innerText()).includes('The project folder'), await about.innerText().catch(() => ''))
  await shots('project-only')

  // --- Worktrees: Unused worktrees, with a spinner and a message while Hive looks.
  await slow('worktrees:unused=4000')
  await openChanges('repo')
  const loadingPage = page.locator('[data-unused-loading]')
  check('a project with worktrees opens on Unused worktrees', !!(await lib.until(async () => (await picker.count()) === 1 && (await picker.inputValue()) === 'unused', 10000)), await picker.inputValue().catch(() => ''))
  check('…showing a spinner and "Looking for unused worktrees…" while it looks', !!(await lib.until(async () => (await loadingPage.count()) === 1, 5000)) && (await loadingPage.innerText()).includes('Looking for unused worktrees') && (await loadingPage.locator('.codicon-loading').count()) === 1, await page.locator('.split-main').innerText().catch(() => ''))
  check('…and the picker says it is looking', (await picker.locator('option[value="unused"]').innerText()) === 'Unused worktrees (looking…)')
  check('…and the page says what unused worktrees are, on the right, once', (await about.count()) === 1 && (await about.getAttribute('data-about')) === 'unused' && (await about.innerText()).includes('no agent of repo works in') && (await page.locator('.split-list .changes-about').count()) === 0, await about.innerText().catch(() => ''))
  await shots('loading')

  const section = page.locator('.unused-worktrees-pane .unused-worktrees')
  const rows = section.locator('.unused-wt')
  check('then the list: both unused worktrees', !!(await lib.until(async () => (await rows.count()) === 2, 15000)), await page.locator('.split-main').innerText().catch(() => ''))
  const row = (p) => section.locator(`.unused-wt[data-path="${p.replace(/\\/g, '\\\\')}"]`)
  check('…B4\'s labelled "was B4" (its session ran there)', (await row(b4).locator('[data-origin="hive"]').innerText().catch(() => '')) === 'was B4', await row(b4).innerText().catch(() => ''))
  check('…the other "not made by Hive"', (await row(other).locator('[data-origin="other"]').innerText().catch(() => '')) === 'not made by Hive', await row(other).innerText().catch(() => ''))
  // The branch comparisons (HI-1824) come first, in a group of their own: these checks are of the folders after them.
  const all = await picker.locator('option').evaluateAll((os) => os.map((o) => ({ value: o.value, label: o.textContent ?? '' })))
  const folders = all.filter((o) => !(o.value.startsWith('compare:') || o.value === 'leftovers'))
  const values = folders.map((o) => o.value)
  const labels = folders.map((o) => o.label)
  check('the picker: Branches first, then Unused worktrees, then each unused one, then those in use, then the project folder last', all[0].value.startsWith('compare:') && all.findIndex((o) => !(o.value.startsWith('compare:') || o.value === 'leftovers')) === all.length - folders.length, JSON.stringify(all.map((o) => o.value)))
  check('…its folders: Unused worktrees first, then each unused one, then those in use, then the project folder last', values[0] === 'unused' && values[values.length - 1] === '' && values.indexOf(coder.id) > values.findIndex((v) => v.startsWith('unused:')) && values.filter((v) => v.startsWith('unused:')).length === 2, JSON.stringify(labels))
  check('…each unused one says who made it', labels.some((l) => l.startsWith('hive/b4 · was B4')) && labels.some((l) => l.startsWith('experiment · not made by Hive')), JSON.stringify(labels))
  check('…and Unused worktrees counts them', labels[0] === 'Unused worktrees (2)', labels[0])
  await shots('populated')

  // --- Back again: the last list at once, checked again in the background.
  await page.locator('.tab', { hasText: 'Overview' }).click()
  await lib.sleep(300)
  await page.locator('.tab', { hasText: 'Version Control' }).click()
  const refreshing = page.locator('[data-unused-refreshing]')
  check('coming back shows the last list at once, while it checks them again', !!(await lib.until(async () => (await rows.count()) === 2 && (await refreshing.count()) === 1, HUNG_MS)) && (await loadingPage.count()) === 0, await page.locator('.split-main').innerText().catch(() => ''))
  await shots('refreshing')
  check('…until the check is done', !!(await lib.until(async () => (await refreshing.count()) === 0, 15000)))
  // Refresh looks again.
  await slow('worktrees:unused=1500')
  await page.locator('.split-list .pane-header [aria-label^="Refresh"]').click()
  check('Refresh looks again (the list stays)', !!(await lib.until(async () => (await refreshing.count()) === 1, HUNG_MS)) && (await rows.count()) === 2)
  check('…and finishes', !!(await lib.until(async () => (await refreshing.count()) === 0, 10000)))
  await slow('')
  // A Refresh that fails keeps the list, and says so with Retry.
  await failing('worktrees:unused*1')
  await page.locator('.split-list .pane-header [aria-label^="Refresh"]').click()
  const stale = page.locator('.unused-worktrees-pane .load-stale')
  check('a failed Refresh keeps the list and says it could not refresh, with Retry', !!(await lib.until(async () => (await stale.count()) === 1, 8000)) && (await stale.innerText()).includes('Could not refresh the unused worktrees') && (await rows.count()) === 2, await page.locator('.split-main').innerText().catch(() => ''))
  await shots('refresh-failed')
  await stale.getByRole('button', { name: 'Retry' }).click()
  check('…and Retry recovers', !!(await lib.until(async () => (await stale.count()) === 0 && (await rows.count()) === 2 && (await refreshing.count()) === 0, 8000)))
  await failing('')

  // --- The other pages say what they show.
  // Coder's 0.9 worktree became the slot kept for it as the project opened (#1441): listed as where it works (#1569).
  check('…the folder Coder works in, as in use: the slot kept for it, with its branch', labels.includes('Coder · carried: coder · hive/coder'), JSON.stringify(labels))
  await picker.selectOption(coder.id)
  check("an agent's folder: what it shows", !!(await lib.until(async () => (await about.getAttribute('data-about')) === 'agent', 8000)) && (await about.innerText()).includes('Coder works in coder, the slot kept for it: everything on its branch since it left master.'), await about.innerText().catch(() => ''))
  check('…its branch since it left its base, and Merge hive/coder…', !!(await lib.until(async () => (await page.locator('.split-list').innerText()).includes('hive/coder since it left master') && (await page.locator('.split-list [aria-label="Merge hive/coder…"]').count()) === 1, 8000)), await page.locator('.split-list').innerText().catch(() => ''))
  await shots('agent-slot')
  await picker.selectOption(`unused:${b4}`)
  check('an unused one: what it shows', !!(await lib.until(async () => (await about.getAttribute('data-about')) === 'unused-one', 8000)) && (await about.innerText()).includes('hive/b4'), await about.innerText().catch(() => ''))
  await picker.selectOption('')
  check('the project folder, last: what it shows', !!(await lib.until(async () => (await about.getAttribute('data-about')) === 'project', 8000)))
  await shots('project-folder')

  // --- Open file opens the file of the folder whose diff is shown (#495): an agent's worktree, an unused one in Hive's
  // folder, one made outside the workspace, and the project folder, each with a file only it has. Main's shell is
  // stubbed, so nothing opens: the path it was asked to open is recorded.
  await app.evaluate(({ shell }) => {
    globalThis.__opened = []
    shell.openPath = async (p) => (globalThis.__opened.push(p), '')
  })
  const opened = () => app.evaluate(() => globalThis.__opened.at(-1) ?? null)
  for (const [label, value, folder] of [["Coder's slot", coder.id, coder.worktree.path], ['B4’s unused worktree', `unused:${b4}`, b4], ['the unused worktree outside the workspace', `unused:${other}`, other], ['the project folder', '', repo]]) {
    const name = `only-${(value || 'project').replace(/[^\w]+/g, '-').slice(-24)}.txt`
    fs.writeFileSync(path.join(folder, name), 'only here\n')
    await picker.selectOption(value)
    const fileRow = page.locator('.split-list .row', { hasText: name })
    const listed = await lib.until(async () => (await fileRow.count()) > 0, 10000)
    if (!listed) await page.locator('.split-list .pane-header [aria-label^="Refresh"]').click()
    await lib.until(async () => (await fileRow.count()) > 0, 10000)
    await fileRow.first().click()
    const button = page.locator('.split-main [aria-label="Open file"]')
    await lib.until(async () => (await button.count()) > 0 && (await page.locator('.split-main .path strong').innerText().catch(() => '')) === name, 10000)
    const before = await app.evaluate(() => globalThis.__opened.length)
    await button.click()
    const got = await lib.until(async () => (await app.evaluate(() => globalThis.__opened.length)) > before && (await opened()), 5000)
    check(`Open file on ${label} opens its own copy`, typeof got === 'string' && got.toLowerCase() === path.join(folder, name).toLowerCase(), `${got} (wanted ${path.join(folder, name)})`)
    fs.rmSync(path.join(folder, name), { force: true })
  }
  await page.screenshot({ path: path.join(lib.WORK, 'changespicker-open-file.png') })
  // Only a file of a folder the Changes tab may read: not one outside it, nor a folder that isn't one.
  fs.writeFileSync(path.join(outside, 'loose.txt'), 'outside\n')
  const before = await app.evaluate(() => globalThis.__opened.length)
  const refusals = [await inv('changes:openFile', repo, '..\\..\\changespicker-outside\\loose.txt').then(() => 'opened', (e) => e.message), await inv('changes:openFile', outside, 'loose.txt').then(() => 'opened', (e) => e.message)]
  check('Open file refuses a file outside the folder, and a folder that is no Changes root', refusals.every((r) => r !== 'opened') && (await app.evaluate(() => globalThis.__opened.length)) === before, JSON.stringify(refusals))

  // --- No agent, only an unused worktree, looked at for the first time: the spinner, not its folder.
  await slow('worktrees:unused=4000')
  await openChanges('cold')
  check('a project with no agent but an unused worktree shows the spinner while it is first looked at', !!(await lib.until(async () => (await loadingPage.count()) === 1, 5000)) && (await picker.count()) === 1 && (await picker.inputValue()) === 'unused' && (await page.getByText('Working tree clean').count()) === 0, await page.locator('.split-main').innerText().catch(() => ''))
  await shots('cold-loading')
  check('…then opens on it', !!(await lib.until(async () => (await rows.count()) === 1 && (await picker.inputValue()) === 'unused', 15000)), await page.locator('.split-main').innerText().catch(() => ''))
  await shots('cold-populated')
  await slow('')

  // --- The first look fails: never taken for "no worktrees". Its error and Retry, then what Retry finds.
  const failedPage = page.locator('[data-unused-error]')
  for (const [name, expectRows] of [['coldfail', true], ['plain', false]]) {
    // Hive reads it again only when its value changes (at its next call): a value of each project's own, so each
    // project's first look fails once.
    await failing(`worktrees:unused*1,none-${name}`)
    await openChanges(name)
    check(`${name}: a first look that fails says so, with Retry, on Unused worktrees (not the folder)`, !!(await lib.until(async () => (await failedPage.count()) === 1, 8000)) && (await picker.inputValue()) === 'unused' && (await page.getByText('Working tree clean').count()) === 0 && (await about.count()) === 1 && (await about.getAttribute('data-about')) === 'unused' && (await picker.locator('option[value="unused"]').innerText()) === "Unused worktrees (couldn't list)", await page.locator('.split-main').innerText().catch(() => ''))
    if (name === 'coldfail') await shots('first-look-failed')
    await failedPage.getByRole('button', { name: 'Retry' }).click()
    if (expectRows) check(`${name}: Retry lists its unused worktree`, !!(await lib.until(async () => (await rows.count()) === 1 && (await picker.inputValue()) === 'unused', 10000)), await page.locator('.split-main').innerText().catch(() => ''))
    else check(`${name}: Retry finds none, so its folder (no picker)`, !!(await lib.until(async () => (await about.getAttribute('data-about').catch(() => null)) === 'project' && (await picker.count()) === 0, 10000)), await page.locator('.split-main').innerText().catch(() => ''))
  }
  await failing('')

  // --- All worktrees in use: Unused worktrees, empty.
  await openChanges('busy')
  check('a project whose worktrees are all in use opens on Unused worktrees, empty', !!(await lib.until(async () => (await picker.count()) === 1 && (await picker.inputValue()) === 'unused' && /no unused worktrees/.test(await page.locator('.split-main').innerText()), 10000)), await page.locator('.split-main').innerText().catch(() => ''))
  await shots('empty')

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log(`FAIL ${e.stack || e}`)
  process.exit(1)
})
