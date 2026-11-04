// "How do you work? Solo / Pair / Team" (#1423, SPEC §16.3.5), the Assistant off, no CLI started:
// - a Git folder found in the workspace with a builder and a reviewer: the notice names it; Choose… opens its Version
//   Control tab at the step, Git in the header, Pair suggested; Choose asks once (nothing in flight) and saves Pair, and
//   the header reads "Workflow: Git · Pair";
// - the switch sequence: to None, None's step (Git's answer doesn't stop it); Not now; a folder found meanwhile gets the
//   notice, Not now; Hive restarted: no step for None and no notice; back to Git, Pair restored and no step; to None
//   again, its Not now respected;
// - New Project (a folder with no version control): its tab opens at None's step, with no notice; Customise… fills the
//   Workflow section with the preset, not saved;
// - an upgraded workspace (cards from before 1.0, options the upgrade wrote): no step and no notice, only the old
//   presets notice.
// Screenshots of the step and the notice, light and dark, English and French. Dev build, throwaway profile and workspaces.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'presetstep-profile')
const ws = path.join(lib.WORK, 'presetstep-ws')
const alpha = path.join(ws, 'alpha')
const found = path.join(ws, 'found')
const upgradedWs = path.join(lib.WORK, 'presetstep-upgraded')
const old = path.join(upgradedWs, 'old')
const shots = path.join(lib.WORK, 'presetstep-shots')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const projectJson = (p) => JSON.parse(fs.readFileSync(path.join(p, '.combwork', 'project.json'), 'utf8'))

;(async () => {
  for (const d of [userData, ws, upgradedWs, shots]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(shots, { recursive: true })
  // A Git folder put in the workspace with its agents, as one copied in or added by the Assistant: no workflow yet.
  lib.gitProject(alpha, { 'a.txt': 'a\n', '.gitignore': '.combwork/\n' })
  fs.mkdirSync(path.join(alpha, '.combwork'), { recursive: true })
  fs.writeFileSync(path.join(alpha, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents: [{ id: 'b1', name: 'Builder' }, { id: 'r1', name: 'Reviewer' }] }))
  // An upgraded workspace: its project kept today's way of working (the options the upgrade wrote, no preset).
  lib.gitProject(old, { 'o.txt': 'o\n', '.gitignore': '.combwork/\n' })
  fs.mkdirSync(path.join(old, '.combwork'), { recursive: true })
  fs.writeFileSync(path.join(old, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents: [], workflow: { platform: 'git', preset: null, options: { review: 'none', finish: 'notChecked', folder: 'project' } } }))

  let { app, page } = await lib.launch({ userData, viewport: { width: 1400, height: 900 } })
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    const text = async (loc) => ((await loc.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()
    const stepEl = () => page.locator('[data-preset-step]')
    const notice = () => page.locator('[data-step-notice]')
    const head = () => page.locator('[data-vc-head]')
    const dialog = () => page.locator('.dialog')
    const toTab = async (name) => {
      if (!(await page.getByText(name, { exact: true }).first().isVisible().catch(() => false))) await page.getByRole('button', { name: 'Projects' }).click()
      await page.getByText(name, { exact: true }).first().click()
      await page.locator('.tabs .tab', { hasText: 'Version Control' }).first().click()
      await lib.until(async () => (await head().count()) === 1, HUNG_MS)
    }
    const switchTo = async (to) => {
      await head().locator(`[data-platform="${to}"]`).click()
      await dialog().getByRole('button', { name: 'Switch', exact: true }).click()
      return !!(await lib.until(async () => (await dialog().count()) === 0 && (await head().locator(`[data-platform="${to}"][aria-checked="true"]`).count()) === 1, HUNG_MS))
    }
    const shoot = async (loc, name) => {
      await page.mouse.move(5, 5)
      for (const theme of ['dark', 'light']) {
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
        await loc.screenshot({ path: path.join(shots, `presetstep-${name}-${theme}.png`) })
      }
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    }
    const base = (await inv('app:info')).language
    const dir = path.join(lib.ROOT, 'locales', 'fr')
    const french = Object.assign({}, ...fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))))
    const speak = (language) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), { type: 'language-changed', language })

    // --- A Git folder found in the workspace: the notice, then the step.
    await lib.openWorkspace(inv, page, ws)
    check('the notice names the project found', !!(await lib.until(async () => (await text(notice())).startsWith('alpha was added: how do you work?'), HUNG_MS)), await text(notice()))
    check('…and no options were applied to it', projectJson(alpha).workflow === undefined)
    await shoot(notice(), 'notice')
    await speak({ ...base, code: 'fr', locale: 'fr', messages: french })
    await lib.until(async () => !(await text(notice())).startsWith('alpha was added'), HUNG_MS)
    await shoot(notice(), 'notice-fr')
    await speak(base)
    await lib.until(async () => (await text(notice())).startsWith('alpha was added'), HUNG_MS)
    // --- Notice banners in a narrow pane (HI-1717: at 900 px and 150% Not Now was cut at the edge, the text a word a line,
    // and the providers banner's "Choose providers" squeezed its text the same way, cut to "Ch" beside the Assistant):
    // the buttons go under the text, together, and stack where even they don't fit; each stays whole and clickable, and
    // the text takes the whole row the buttons left. Wide, one row. Both banners share the layout (`.wrap-banner`), so
    // each check measures both: the presets notice (two buttons) and the providers banner (one). Under zoom the window is
    // captured by Electron (an element's screenshot is wrong there, HI-1696).
    const BANNERS = { notice: '[data-step-notice]', providers: '.providers-banner' }
    const layout = (sel) => page.evaluate((s) => {
      const n = document.querySelector(s)
      if (!n) return null
      const cs = getComputedStyle(n)
      const outer = n.getBoundingClientRect()
      // The banner's content box: what its icon, text and buttons have.
      const box = { left: outer.left + parseFloat(cs.paddingLeft), right: outer.right - parseFloat(cs.paddingRight), top: outer.top + parseFloat(cs.paddingTop), bottom: outer.bottom - parseFloat(cs.paddingBottom) }
      const rect = (e) => {
        const r = e.getBoundingClientRect()
        return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width) }
      }
      const parts = { icon: rect(n.querySelector('.wrap-banner-text > .codicon')), text: rect(n.querySelector('.wrap-banner-text > .grow')), actions: rect(n.querySelector('.wrap-banner-actions')) }
      // The hit test with the button in view (a narrow banner can reach below the window), its bounds read before that.
      const bounds = [...n.querySelectorAll('.wrap-banner-actions button')].map((b) => [b, rect(b)])
      const buttons = bounds.map(([b, at]) => {
        b.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        const r = b.getBoundingClientRect()
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        // Its label's lines, read from each letter's line: a word broken across two lines leaves neither part a stray
        // letter ("fournisseur" / "s"); hyphenated, it breaks at a syllable ("fournis-" / "seurs").
        const label = [...b.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join('').trim()
        const node = [...b.childNodes].find((c) => c.nodeType === 3 && c.textContent.trim())
        const lines = []
        if (node) {
          const range = document.createRange()
          let top = null
          for (let i = 0; i < node.textContent.length; i++) {
            range.setStart(node, i)
            range.setEnd(node, i + 1)
            const letter = range.getClientRects()[0]
            if (!letter) continue
            if (top === null || letter.top > top + 2) lines.push('')
            top = letter.top
            lines[lines.length - 1] += node.textContent[i]
          }
        }
        const words = lines.map((l) => l.trim())
        const stray = words.some((w, i) => i > 0 && /\S$/.test(lines[i - 1]) && !/\s$/.test(lines[i - 1]) && /^\S/.test(lines[i]) && (w.split(/\s/)[0].length < 2 || words[i - 1].split(/\s/).pop().length < 2))
        return { ...at, label, lines: lines.length > 1 ? words : undefined, stray, cut: b.scrollWidth > b.clientWidth + 1 || b.scrollHeight > b.clientHeight + 1, hit: !!hit && b.contains(hit) }
      })
      return { inner: window.innerWidth, box: { left: Math.round(box.left), right: Math.round(box.right), top: Math.round(box.top), bottom: Math.round(box.bottom), width: Math.round(box.right - box.left) }, ...parts, buttons }
    }, sel)
    const layouts = async () => Object.fromEntries(await Promise.all(Object.entries(BANNERS).map(async ([k, s]) => [k, await layout(s)])))
    const inside = (r, b) => r.left >= b.left - 1 && r.right <= b.right + 1 && r.top >= b.top - 1 && r.bottom <= b.bottom + 1
    const apart = (a, b) => a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1
    // Every part inside the banner's content box and the window, none over another, each button whole and the one hit
    // at its middle; the actions under the text when they don't share its row, and then the text has its whole row.
    // A label narrower than its longest word (the 70 px case) may break anywhere: there is no hyphenation in Electron.
    const whole = (l, count, anyBreak = false) => {
      if (!l) return false
      const parts = [l.icon, l.text, l.actions]
      if (l.buttons.length !== count || !parts.concat(l.buttons).every((r) => inside(r, l.box) && r.right <= l.inner)) return false
      if (!parts.every((a, i) => parts.slice(i + 1).every((b) => apart(a, b)))) return false
      if (!l.buttons.every((a, i) => l.buttons.slice(i + 1).every((b) => apart(a, b)))) return false
      if (!l.buttons.every((b) => !b.cut && b.hit && (anyBreak || !b.stray) && inside(b, l.actions))) return false
      const besideText = l.actions.top < l.text.bottom - 1
      return besideText || l.text.width >= l.box.right - l.text.left - 2
    }
    const below = (l) => l.actions.top >= l.text.bottom - 1
    const stacked = (l) => l.buttons.length < 2 || l.buttons[1].top >= l.buttons[0].bottom - 1
    const capture = async (name) => {
      await page.mouse.move(5, 5)
      for (const theme of ['dark', 'light']) {
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
        const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
        fs.writeFileSync(path.join(shots, `presetstep-${name}-${theme}.png`), Buffer.from(png, 'base64'))
      }
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    }
    const zoomTo = async (z, width) => {
      await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(f), z)
      await lib.until(async () => Math.abs((await page.evaluate(() => window.innerWidth)) - width / z) <= 2, HUNG_MS)
    }
    // Both banners whole, and `also` true of each.
    const fits = (also = () => true) => lib.until(async () => {
      const l = await layouts()
      return whole(l.notice, 2) && whole(l.providers, 1) && also(l.notice) && also(l.providers)
    }, HUNG_MS)
    const sized = (sel, width) => page.evaluate(([s, w]) => (document.querySelector(s).style.width = w), [sel, width])
    await lib.fitWindow(app, page, { width: 900, height: 850 })
    await zoomTo(1.5, 900)
    check('900 px at 150%: each banner\'s buttons under its text, whole, inside it and apart; the text has its row (HI-1717)', !!(await fits(below)), JSON.stringify(await layouts()))
    await capture('notice-narrow-150')
    // French's longer labels (Choisir… / Pas maintenant, Choisir les fournisseurs).
    await speak({ ...base, code: 'fr', locale: 'fr', messages: french })
    await lib.until(async () => !(await text(notice())).startsWith('alpha was added'), HUNG_MS)
    check('…and in French', !!(await fits(below)), JSON.stringify(await layouts()))
    await capture('notice-narrow-150-fr')
    // Narrower than the pair: the buttons stack; narrower than a button's label: it wraps inside the button, still whole.
    // At 100% and one banner at a time, so even the tallest of these fits the window's height.
    await zoomTo(1, 900)
    for (const [key, sel] of Object.entries(BANNERS)) {
      for (const [width, what] of [[150, 'narrower than its buttons: they stack'], [70, 'narrower than a word: it wraps in its button']]) {
        await sized(sel, `${width}px`)
        check(`French, the ${key} banner ${width} px wide, ${what}, each whole`, !!(await lib.until(async () => {
          const l = await layout(sel)
          return whole(l, key === 'notice' ? 2 : 1, width === 70) && stacked(l)
        }, HUNG_MS)), JSON.stringify(await layout(sel)))
      }
      await sized(sel, '')
    }
    // Beside the Assistant's panel, at 100% (the room the panel leaves the work at 150% is panelroom's, HI-1737).
    await page.locator('.assistant-rail').click()
    await lib.until(async () => (await page.locator('.assistant-panel').count()) === 1, HUNG_MS)
    check("French, 900 px beside the Assistant's panel: each banner whole, inside it and apart", !!(await fits()), JSON.stringify(await layouts()))
    await capture('notice-narrow-assistant-fr')
    await speak(base)
    await lib.until(async () => (await text(notice())).startsWith('alpha was added'), HUNG_MS)
    check('…and in English', !!(await fits()), JSON.stringify(await layouts()))
    await capture('notice-narrow-assistant')
    await page.keyboard.press('Control+Alt+I')
    await lib.until(async () => (await page.locator('.assistant-rail').count()) === 1, HUNG_MS)
    await lib.fitWindow(app, page, { width: 1500, height: 900 })
    check('wide: each banner is one row, its buttons beside its text', !!(await fits((l) => !below(l) && l.buttons.every((b) => b.top === l.buttons[0].top))), JSON.stringify(await layouts()))
    await capture('notice-wide')
    await lib.fitWindow(app, page, { width: 1400, height: 900 })

    await notice().getByRole('button', { name: 'Choose…' }).click()
    check('Choose… opens its Version Control tab at the step: Git in the header', !!(await lib.until(async () => (await stepEl().getAttribute('data-preset-step').catch(() => null)) === 'git' && (await head().locator('[data-platform="git"][aria-checked="true"]').count()) === 1, HUNG_MS)))
    check('…and the notice goes', !!(await lib.until(async () => (await notice().count()) === 0, HUNG_MS)))
    check('Pair is suggested for a builder and a reviewer, and shown', (await stepEl().locator('[data-preset="pair"] .vc-step-tag').count()) === 1 && (await stepEl().locator('[data-preset="pair"]').getAttribute('aria-checked')) === 'true' && (await text(stepEl().locator('.vc-step-why'))) === 'Suggested for a builder and a reviewer.')
    check('compact: the presets and the buttons, the preview on request', (await stepEl().locator('.workflow-preview').count()) === 0)
    await shoot(stepEl(), 'step-git')
    await stepEl().locator('[data-action="step-details"]').click()
    check('…and, on request, what it sets and why', !!(await lib.until(async () => (await stepEl().locator('.workflow-preview[data-preview="pair"] li').count()) > 3, HUNG_MS)))
    check('nothing applied yet', projectJson(alpha).workflow === undefined)
    await shoot(stepEl(), 'step-git-details')
    await stepEl().locator('[data-action="step-details"]').click()
    await lib.until(async () => (await stepEl().locator('.workflow-preview').count()) === 0, HUNG_MS)
    await speak({ ...base, code: 'fr', locale: 'fr', messages: french })
    await lib.until(async () => (await text(stepEl().locator('h3'))) !== 'How do you work?', HUNG_MS)
    await shoot(stepEl(), 'step-git-fr')
    await speak(base)
    await lib.until(async () => (await text(stepEl().locator('h3'))) === 'How do you work?', HUNG_MS)
    await stepEl().locator('[data-action="step-choose"]').click()
    check('Choose asks once: nothing is in flight', !!(await lib.until(async () => /Nothing is in flight yet/.test(await text(dialog())), HUNG_MS)), await text(dialog()))
    await dialog().getByRole('button', { name: 'Use Pair' }).click()
    check('Pair saved, the step gone, and the header reads "Workflow: Git · Pair"', !!(await lib.until(async () => (await stepEl().count()) === 0 && (await text(head().locator('[data-action="vc-workflow"]'))) === 'Workflow: Git · Pair', HUNG_MS)) && projectJson(alpha).workflow?.preset === 'pair' && projectJson(alpha).workflow?.presetAsked === 'chosen', JSON.stringify(projectJson(alpha).workflow))

    // --- The switch sequence.
    check('switched to None', await switchTo('none'))
    check("None's step is offered: Git's answer doesn't stop it", !!(await lib.until(async () => (await stepEl().getAttribute('data-preset-step').catch(() => null)) === 'none', HUNG_MS)))
    check('…with no notice: the step is in front of the user', (await notice().count()) === 0)
    await shoot(stepEl(), 'step-none')
    await stepEl().locator('[data-action="step-notnow"]').click()
    check('Not now: the step goes, no preset chosen', !!(await lib.until(async () => (await stepEl().count()) === 0 && (await text(head().locator('[data-action="vc-workflow"]'))) === 'Workflow: None · no preset chosen', HUNG_MS)) && projectJson(alpha).workflow?.presetAsked === 'notNow' && Object.keys(projectJson(alpha).workflow?.options ?? {}).length === 0)
    // A folder found while the workspace is open: the notice; Not now.
    fs.mkdirSync(found, { recursive: true })
    fs.writeFileSync(path.join(found, 'notes.md'), '# Found\n')
    await inv('workspace:refresh')
    check('a folder found on reading the workspace gets the notice', !!(await lib.until(async () => (await text(notice())).startsWith('found was added'), HUNG_MS)), await text(notice()))
    await notice().getByRole('button', { name: 'Not Now' }).click()
    check('Not now: the notice goes', !!(await lib.until(async () => (await notice().count()) === 0, HUNG_MS)) && projectJson(found).workflow?.presetAsked === 'notNow')

    // Restarted: no step for None, no notice.
    await app.close()
    ;({ app, page } = await lib.launch({ userData, viewport: { width: 1400, height: 900 } }))
    page.on('pageerror', (e) => check('no page errors (restarted)', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    await toTab('alpha')
    check('after a restart: None, no step, no notice', !!(await lib.until(async () => (await head().locator('[data-platform="none"][aria-checked="true"]').count()) === 1, HUNG_MS)) && (await stepEl().count()) === 0 && (await notice().count()) === 0)
    check('back to Git', await switchTo('git'))
    check('Pair restored, and no step', !!(await lib.until(async () => (await text(head().locator('[data-action="vc-workflow"]'))) === 'Workflow: Git · Pair', HUNG_MS)) && (await stepEl().count()) === 0)
    check('to None again', await switchTo('none'))
    check("None's Not now is respected: no step", !!(await lib.until(async () => (await text(head().locator('[data-action="vc-workflow"]'))) === 'Workflow: None · no preset chosen', HUNG_MS)) && (await stepEl().count()) === 0)

    // --- New Project: its tab opens at None's step, with no notice.
    await page.keyboard.press('Control+Alt+N')
    const box = dialog().locator('input').first()
    await lib.until(async () => (await box.count()) === 1, HUNG_MS)
    await box.fill('fresh')
    await dialog().getByRole('button', { name: 'Create' }).click()
    check("New Project opens its tab at None's step", !!(await lib.until(async () => (await stepEl().getAttribute('data-preset-step').catch(() => null)) === 'none' && (await page.locator('.project-header', { hasText: 'fresh' }).count()) > 0, HUNG_MS)))
    check('…and Solo is suggested for no agents', (await stepEl().locator('[data-preset="solo"] .vc-step-tag').count()) === 1)
    check('…with no notice for it', (await notice().count()) === 0)
    // Customise…: the Workflow section with the preset filled in, not saved.
    await stepEl().locator('[data-preset="team"]').click()
    await stepEl().locator('[data-action="step-customise"]').click()
    const fresh = path.join(ws, 'fresh')
    check('Customise… opens Workflow with Team filled in, not saved', !!(await lib.until(async () => (await page.locator('.git-sections [data-section="workflow"]').getAttribute('aria-selected')) === 'true' && /Team/.test(await text(page.locator('.workflow-preset-now'))), HUNG_MS)) && projectJson(fresh).workflow === undefined, await text(page.locator('.workflow-preset-now')))

    // --- An upgraded workspace: no step, no notice, only the old presets notice.
    await lib.openWorkspace(inv, page, upgradedWs)
    const db = new DatabaseSync(path.join(upgradedWs, '.combwork', 'hive.db'), { timeout: 5000 })
    try {
      db.prepare("INSERT INTO board_meta (key, value) VALUES ('adoption_upto', '3') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run()
    } finally {
      db.close()
    }
    await page.reload()
    await lib.appReady(page)
    check('upgraded: the old presets notice', !!(await lib.until(async () => (await page.locator('.presets-notice').count()) === 1, HUNG_MS)))
    await toTab('old')
    check('…and no step and no notice for its project', (await stepEl().count()) === 0 && (await notice().count()) === 0)
  } catch (e) {
    check('no exception', false, e.stack)
    await page.screenshot({ path: path.join(shots, 'presetstep-failure.png') }).catch(() => {})
  } finally {
    await app.close().catch(() => {})
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
