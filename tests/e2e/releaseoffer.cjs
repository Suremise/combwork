// HI-3155 (SPEC §16.5.4, the release offer): a project's own For you item, in the window, on real Git. No agents.
// - alpha works on 1.4.0, released (tagged v1.4.0, merged into main), and lists 1.3.0 (released, unused) and 1.5.0 (made):
//   the status bar counts the offer and its popover lists it; on the board with For you ticked it is a row above the
//   cards; Move… opens Version Control → Workflow's Save… with the change and its retarget; saved, Work merges into is
//   1.5.0 and 1.4.0 joins the other branches; the offer becomes cleanup-only (1.4.0 released and unused); Not now hides it.
// - beta works on 1.4.0, released, with no 1.5.0 yet, and a card on 1.3.0 (released): Start 1.5.0… opens Start the next
//   version; started, its cleanup-only offer names 1.4.0 removable and 1.3.0 kept (the card uses it).
// Screenshots of each in both themes. Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000
// The offer is looked at each minute (and on a branch moving): a tag made alone shows within that.
const OFFER_MS = 2 * 60000 + HUNG_MS

const PORT = Number(lib.port(47866))
const userData = path.join(lib.WORK, 'releaseoffer-profile')
const ws = path.join(lib.WORK, 'releaseoffer-ws')
const shots = path.join(lib.WORK, 'releaseoffer-shots')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms = HUNG_MS) => lib.until(fn, ms, 200)

const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd, env: lib.gitEnv ? lib.gitEnv() : process.env, encoding: 'utf8' }).trim()
/** Releases `line` (made from main): a commit on it, an annotated tag v<line>, merged into main. */
function release(repo, line) {
  git(repo, 'branch', line)
  git(repo, 'checkout', '-q', line)
  fs.writeFileSync(path.join(repo, `${line}.txt`), `${line}\n`)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', line)
  git(repo, 'tag', '-a', `v${line}`, '-m', `release ${line}`)
  git(repo, 'checkout', '-q', 'main')
  git(repo, 'merge', '-q', '--no-ff', '-m', `release ${line}`, line)
}

;(async () => {
  for (const d of [userData, ws, shots]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(shots, { recursive: true })
  for (const p of [alpha, beta]) {
    lib.gitProject(p)
    git(p, 'branch', '-M', 'main')
    release(p, '1.3.0')
    release(p, '1.4.0')
  }
  git(alpha, 'branch', '1.5.0')
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), CW_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    const shoot = async (name, target) => {
      await page.mouse.move(2, 2)
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme)
        await target.screenshot({ path: path.join(shots, `${name}-${theme}.png`) })
      }
      await inv('settings:update', { appearance: { theme: 'dark' } })
    }
    await inv('workflow:setOptions', alpha, { preset: null, options: { review: 'you', folder: 'project', target: '1.4.0', otherTargets: ['1.3.0', '1.5.0'] } })
    await inv('workflow:setOptions', beta, { preset: null, options: { review: 'you', folder: 'project', target: '1.4.0', otherTargets: ['1.3.0'] } })
    const offerOf = async (p) => (await inv('workflow:releaseOffers')).find((o) => o.projectPath.toLowerCase() === p.toLowerCase()) ?? null
    const a1 = await until(async () => {
      const o = await offerOf(alpha)
      return o?.move?.moveTo === '1.5.0' ? o : null
    }, OFFER_MS)
    check("alpha's offer: 1.4.0 released, move to 1.5.0, 1.3.0 to come off", !!a1 && a1.move.tag === 'v1.4.0' && JSON.stringify(a1.cleanup?.drop.map((d) => d.branch)) === '["1.3.0"]', JSON.stringify(a1))

    // --- The status bar counts it, and its popover lists it with its buttons.
    const needItem = page.locator('.statusbar .inbox-item:not(.inbox-finished)')
    check('the status bar counts the offers', !!(await until(async () => /^\d+ needs? you$/.test((await needItem.innerText().catch(() => '')).trim()))), await needItem.innerText().catch(() => ''))
    await needItem.click()
    const inboxRow = page.locator(`.inbox-panel [data-release-offer="${a1.id}"]`)
    const words = async (l) => (await l.innerText().catch(() => '')).replace(/\s+/g, ' ')
    check('…its popover lists the offer in words, with Move…, Not now', !!(await until(async () => (await inboxRow.count()) === 1 && /1\.4\.0 is released \(v1\.4\.0, tagged .+, merged into main\)\. Move Work merges into to 1\.5\.0\?/.test(await words(inboxRow)) && /1\.3\.0 is released and nothing uses it/.test(await words(inboxRow)) && (await inboxRow.getByRole('button', { name: 'Move…' }).count()) === 1 && (await inboxRow.getByRole('button', { name: 'Not now' }).count()) === 1)), await words(inboxRow))
    await shoot('inbox', page.locator('.inbox-panel'))
    await page.keyboard.press('Escape')

    // --- The board, For you ticked: the offer as a row above the cards.
    await page.getByRole('button', { name: 'Task Board' }).click()
    await page.locator('.board-for-you-filter input').check()
    const boardRow = page.locator(`.board-release-offers [data-release-offer="${a1.id}"]`)
    check('the board with For you ticked shows it above the cards', !!(await until(async () => (await boardRow.count()) === 1)))
    await shoot('board', page.locator('.board-release-offers'))

    // --- Move…: Version Control → Workflow's Save…, the change filled in; saved, it applies.
    await boardRow.getByRole('button', { name: 'Move…' }).click()
    const saveDialog = page.locator('.dialog', { hasText: 'Save Workflow Options' })
    check('Move… opens Workflow’s Save… with the change', !!(await until(async () => (await saveDialog.count()) === 1 && /1\.5\.0/.test(await saveDialog.innerText()))), await saveDialog.innerText().catch(() => ''))
    await shoot('save', saveDialog)
    await saveDialog.getByRole('button', { name: 'Save', exact: true }).click()
    const form = async () => inv('workflow:form', alpha)
    check('…saved: Work merges into is 1.5.0, 1.4.0 joins the other branches, 1.3.0 is off', !!(await until(async () => {
      const f = await form()
      return f.options.target === '1.5.0' && JSON.stringify([...(f.options.otherTargets ?? [])].sort()) === '["1.4.0"]'
    })), JSON.stringify((await form()).options))
    const a2 = await until(async () => {
      const o = await offerOf(alpha)
      return o && !o.move && o.cleanup?.drop[0]?.branch === '1.4.0' ? o : null
    }, OFFER_MS)
    check('…the offer is cleanup-only now: 1.4.0 released and unused', !!a2, JSON.stringify(await offerOf(alpha)))

    // --- Not now: hidden.
    await page.getByRole('button', { name: 'Task Board' }).click()
    const a2Row = page.locator(`.board-release-offers [data-release-offer="${a2?.id}"]`)
    await until(async () => (await a2Row.count()) === 1)
    await shoot('cleanup', a2Row)
    await a2Row.getByRole('button', { name: 'Not now' }).click()
    check('Not now hides it', !!(await until(async () => (await a2Row.count()) === 0 && !(await offerOf(alpha)))))

    // --- beta: Start 1.5.0… opens Start the next version; started, its cleanup-only offer (1.4.0 off, 1.3.0 kept).
    const card = await inv('tasks:create', { title: 'On 1.3.0', project: 'beta', target: '1.3.0' })
    const b1 = await until(async () => {
      const o = await offerOf(beta)
      return o?.move?.startNext === '1.5.0' && o.cleanup?.kept.length ? o : null
    }, OFFER_MS)
    check("beta's offer: start 1.5.0, 1.3.0 kept (a card uses it)", !!b1, JSON.stringify(await offerOf(beta)))
    const bRow = page.locator(`.board-release-offers [data-release-offer="${b1?.id}"]`)
    await until(async () => (await bRow.count()) === 1)
    check('…its Start 1.5.0… button, and the kept branch said', (await bRow.getByRole('button', { name: 'Start 1.5.0…' }).count()) === 1 && /1\.3\.0 \(.+\) is released but still in use, so it stays/.test(await words(bRow)), await words(bRow))
    await shoot('start', bRow)
    await bRow.getByRole('button', { name: 'Start 1.5.0…' }).click()
    const startDialog = page.locator('.dialog', { hasText: 'Start the next version' })
    check('Start 1.5.0… opens Start the next version', !!(await until(async () => (await startDialog.count()) === 1)))
    await startDialog.getByRole('button', { name: 'Start', exact: true }).click()
    const b2 = await until(async () => {
      const o = await offerOf(beta)
      return o && !o.move && o.cleanup?.drop.some((d) => d.branch === '1.4.0') && o.cleanup.kept.some((k) => k.branch === '1.3.0') ? o : null
    }, OFFER_MS)
    check('…started: the cleanup-only offer, 1.4.0 to come off and 1.3.0 kept', !!b2, JSON.stringify(await offerOf(beta)))
    const b2Row = page.locator(`.board-release-offers [data-release-offer="${b2?.id}"]`)
    if (await until(async () => (await b2Row.count()) === 1)) await shoot('after-start', b2Row)
    // The card on 1.3.0 is what keeps it: named among its uses.
    check('…1.3.0 kept, named with the card that uses it', !!b2?.cleanup?.kept.find((k) => k.branch === '1.3.0')?.uses.some((u) => u.includes(String(card.number)) || (card.key && u.includes(card.key))), JSON.stringify(b2?.cleanup))
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} FAILED` : '\nAll passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log(`FAIL ${e.stack ?? e}`)
  process.exit(1)
})
