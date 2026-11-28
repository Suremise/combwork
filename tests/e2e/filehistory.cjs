// The Files tab's History (HI-3475), driven in the window: a project whose doc.txt was made as old.txt, renamed and
// edited in a commit naming a card, and edited on a side branch by a commit naming none, merged by a commit naming the
// card. History, from the file's toolbar, lists the file's commits across the rename, the card's key on its commit
// (opening the card), "Renamed from"; a click shows the commit's diff in place of the editor, the rename's from its old
// path, and Back to file returns to the editor with its unsaved edit and its undo kept; Find its merge on the side commit
// says it came in with the card's merge; a folder's History lists its commits; switching file shows that file's history.
// Screenshots of the panel and a diff in both themes. Git's global config the suite's own. Dev build, throwaway profile
// and workspace.
const lib = require('./lib.cjs')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = lib.timing('hang.ui')

const userData = path.join(lib.WORK, 'filehistory-profile')
const ws = path.join(lib.WORK, 'filehistory-ws')
const claudeHome = path.join(lib.WORK, 'filehistory-claude-home')
const globalConfig = path.join(lib.WORK, 'filehistory-gitconfig')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.writeFileSync(globalConfig, '[user]\n\tname = Test User\n\temail = 1+test@users.noreply.github.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n')
  const gitEnv = lib.gitEnv({ GIT_CONFIG_GLOBAL: globalConfig })
  const g = (...a) => execFileSync('git', a, { cwd: alpha, env: gitEnv, encoding: 'utf8' }).trim()
  const write = (f, t) => {
    fs.mkdirSync(path.dirname(path.join(alpha, f)), { recursive: true })
    fs.writeFileSync(path.join(alpha, f), t)
  }
  fs.mkdirSync(alpha, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', alpha], { env: gitEnv })
  write('old.txt', 'one\ntwo\nthree\nfour\nfive\nsix\n')
  write('notes/a.md', '# A\n')
  g('add', '-A')
  g('commit', '-qm', 'start')
  const claude = lib.fakeClaude(userData, claudeHome, [alpha])
  const env = { ...claude, CW_API_PORT: lib.port(47608), GIT_CONFIG_GLOBAL: globalConfig }

  const { app, page, inv } = await lib.launch({ userData, env, viewport: { width: 1500, height: 950 } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  try {
    await lib.openWorkspace(inv, page, ws)
    const card = await inv('tasks:create', { title: 'Rename the doc', project: 'alpha' })
    const key = card.key
    check('a card to name in commits', typeof key === 'string' && /-\d+$/.test(key), JSON.stringify(card))
    // The card's commit renames and edits the file; a side branch's commit (no key) edits it, merged under the card.
    g('mv', 'old.txt', 'doc.txt')
    write('doc.txt', 'ONE\ntwo\nthree\nfour\nfive\nsix\n')
    g('commit', '-qam', `${key}: rename the doc`)
    const renamed = g('rev-parse', 'HEAD')
    g('switch', '-q', '-c', 'side')
    write('doc.txt', 'ONE\ntwo\nthree\nfour\nfive\nSIX\n')
    g('commit', '-qam', 'tidy the end')
    const sideCommit = g('rev-parse', 'HEAD')
    g('switch', '-q', 'main')
    write('notes/b.md', '# B\n')
    g('add', '-A')
    g('commit', '-qm', 'add notes b')
    g('merge', '-q', '--no-ff', '-m', `${key}: merge side`, 'side')

    const text = (loc) => loc.innerText().catch(() => '')
    const shown = (loc) => lib.until(async () => (await loc.count()) > 0 && (await loc.first().isVisible()), HUNG_MS)
    const theme = async (t) => {
      await inv('settings:update', { appearance: { theme: t } })
      await lib.until(() => page.evaluate((x) => document.documentElement.dataset.theme === x, t), HUNG_MS)
    }
    const shoot = async (loc, name) => {
      for (const t of ['dark', 'light']) {
        await theme(t)
        await page.mouse.move(5, 5)
        await loc.screenshot({ path: path.join(lib.WORK, `filehistory-${name}-${t}.png`) })
      }
      await theme('dark')
    }
    await page.getByText('alpha', { exact: true }).first().click()
    await page.locator('.tab', { hasText: 'Files' }).click()
    await lib.until(async () => (await page.locator('.file-row').count()) > 0, HUNG_MS)
    const row = (rel) => page.locator(`.file-row[data-rel="${rel}"]`)
    await row('doc.txt').click()
    await shown(page.locator('.split-main .monaco .view-lines'))

    // An unsaved edit, before History is opened: it must outlive a diff and Back to file.
    await page.locator('.split-main .monaco').first().click({ position: { x: 200, y: 10 } })
    await page.keyboard.press('Control+End')
    await page.keyboard.type('unsaved line')
    check('the edit marks the file unsaved', !!(await lib.until(async () => (await page.locator('.editor-toolbar .dirty-dot').count()) === 1, HUNG_MS)))

    await page.locator('[data-action="file-history"]').click()
    const panel = page.locator('[data-file-history="doc.txt"]')
    const rows = panel.locator('[data-history-row]')
    check("History lists the file's commits across its rename", !!(await lib.until(async () => (await rows.count()) === 3, HUNG_MS)), String(await rows.count()))
    const subjects = await panel.locator('.history-subject').allInnerTexts()
    check('…newest first', JSON.stringify(subjects) === JSON.stringify(['tidy the end', `${key}: rename the doc`, 'start']), JSON.stringify(subjects))
    const renameRow = panel.locator(`[data-history-row="${renamed}"]`)
    check("the rename's commit names its card", (await renameRow.locator(`[data-history-card="${key}"]`).count()) === 1)
    check('…and says what the file was called', /Renamed from old\.txt/.test(await text(renameRow)))
    const sideRow = panel.locator(`[data-history-row="${sideCommit}"]`)
    check('the side commit names no card', (await sideRow.locator('[data-history-card]').count()) === 0)
    await shoot(panel, 'panel')

    // A commit's diff, over the editor; the rename's from its old path.
    await renameRow.locator('.history-main').click()
    const diff = page.locator(`[data-history-diff="${renamed}:doc.txt"]`)
    check("a click shows the commit's diff of the file", await shown(diff.locator('.monaco')))
    check("…the rename's, from the old path", /old\.txt → doc\.txt/.test(await text(diff)))
    check('…in place of the editor', (await page.locator('.split-main .editor-host[hidden]').count()) === 1)
    await shoot(page.locator('.split-main'), 'diff')
    await diff.locator('[data-action="history-back"]').click()
    check('Back to file shows the editor', !!(await lib.until(async () => (await diff.count()) === 0 && (await page.locator('.split-main .editor-host[hidden]').count()) === 0, HUNG_MS)))
    // Monaco draws a space as a no-break space.
    const editorText = () => page.evaluate(() => (document.querySelector('.split-main .monaco .view-lines')?.textContent ?? '').replace(/\u00a0/g, ' '))
    check('…with the unsaved edit kept', (await editorText()).includes('unsaved line') && (await page.locator('.editor-toolbar .dirty-dot').count()) === 1)
    await page.locator('.split-main .monaco').first().click({ position: { x: 200, y: 10 } })
    await page.keyboard.press('Control+Z')
    check('…and its undo too', !!(await lib.until(async () => !(await editorText()).includes('unsaved line'), HUNG_MS)))
    await page.keyboard.press('Control+Y')
    await lib.until(async () => (await editorText()).includes('unsaved line'), HUNG_MS)

    // A commit naming no card: the merge that brought it in names the card.
    await sideRow.locator('[data-action="history-find-merge"]').click()
    check("Find its merge says the card's merge brought it in", !!(await lib.until(async () => (await sideRow.locator(`[data-history-came-in="${key}"]`).count()) === 1, HUNG_MS)), await text(sideRow))
    await sideRow.locator(`[data-history-came-in="${key}"]`).click()
    const cardDialog = page.locator('.dialog[role="dialog"]').filter({ has: page.locator('.task-title-input') })
    check('…and opens that card', !!(await lib.until(async () => (await cardDialog.locator('.task-title-input').inputValue().catch(() => '')) === 'Rename the doc', HUNG_MS)))
    await cardDialog.locator('.dialog-header button[aria-label^="Close"]').click()
    await lib.until(async () => (await cardDialog.count()) === 0, HUNG_MS)

    // Another item selected: its history, never the last one's.
    await row('notes').click()
    const folder = page.locator('[data-file-history="notes"]')
    check("a folder's History lists its commits", !!(await lib.until(async () => (await folder.locator('[data-history-row]').count()) === 2, HUNG_MS)), await text(folder))
    await folder.locator('[data-history-row]').first().locator('.history-main').click()
    check("…a commit's files under it", await shown(folder.locator('[data-history-file="notes/b.md"]')))
    await folder.locator('[data-history-file="notes/b.md"]').click()
    check("…and one file's diff in place of the folder's details", await shown(page.locator('[data-history-diff$=":notes/b.md"] .monaco')))
    await row('doc.txt').click()
    check('back on the file, its history again and its editor (the diff left with the folder)', !!(await lib.until(async () => (await panel.locator('[data-history-row]').count()) === 3 && (await page.locator('[data-history-diff]').count()) === 0, HUNG_MS)))
    check('…its edit still unsaved', (await editorText()).includes('unsaved line'))

    await page.locator('[data-file-history] .file-history-head .icon-btn').last().click()
    check('closing hides the panel', !!(await lib.until(async () => (await page.locator('[data-file-history]').count()) === 0, HUNG_MS)))
    // Saved, so quitting has no unsaved file to ask about.
    await page.locator('.split-main .monaco').first().click({ position: { x: 200, y: 10 } })
    await page.keyboard.press('Control+S')
    check('the edit saves to the file', !!(await lib.until(async () => fs.readFileSync(path.join(alpha, 'doc.txt'), 'utf8').includes('unsaved line'), HUNG_MS)))
  } finally {
    await app.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
