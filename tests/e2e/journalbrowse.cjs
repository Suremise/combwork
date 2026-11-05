// The journal browser (#1033) under the Assistant's view: Journal → Timeline shows the workspace's Assistant journal
// newest first, by day, each a line (time, kind mark, summary, project, source) with its cards as the board's chips
// (a click opens the card); Weekly Digests shows only digests. Search (every word, as prefixes) and the filters (kind,
// project, source, dates) narrow it; Forget These… asks with how many, then deletes just those; an entry opens beside
// the timeline with its detail, why, links and tags, is edited (summary, kind, importance) and deleted after asking; the
// footer says its size and retention and opens Settings → Assistant; off, the browser says so, still reads it, and Turn
// On turns it on. The keyboard moves along the rows. Screenshots in both themes. Entries are Combwork's facts (a card into
// Done) plus rows written into the journal's file as the Assistant would (its tools are measured in replysize). No
// agents. Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'journalbrowse-profile')
const ws = path.join(lib.WORK, 'journalbrowse-ws')
const alpha = path.join(ws, 'alpha')
const dbFile = path.join(ws, '.combwork', 'assistant', 'journal.db')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/** Entries as the Assistant writes them, into the journal Combwork made (its triggers index them). */
function seed(cards, secondKey) {
  const db = new DatabaseSync(dbFile)
  try {
    db.function('journal_text', { deterministic: true, varargs: true }, (detail) => (typeof detail === 'string' ? detail : ''))
    // Today's between midnight and Combwork's fact (the newest), whatever the time the suite runs.
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    const fact = Date.parse(db.prepare('SELECT max(at) AS at FROM entries').get().at)
    const today = (f) => new Date(midnight.getTime() + (fact - midnight.getTime()) * f).toISOString()
    const day = (n, h) => {
      const d = new Date()
      d.setDate(d.getDate() - n)
      d.setHours(h, 15, 0, 0)
      return d.toISOString()
    }
    const add = db.prepare('INSERT INTO entries (at, kind, project, summary, detail, why, source, importance, digest_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const link = db.prepare('INSERT INTO links (entry_id, type, ref) VALUES (?, ?, ?)')
    const tag = db.prepare('INSERT INTO tags (entry_id, tag) VALUES (?, ?)')
    const rows = [
      [today(0.6), 'decision', 'alpha', 'Ship the journal browser under the Assistant view', 'Darren chose a small browser of its own, under the Assistant in the activity bar.\n\n- search and filters\n- edit and delete', 'No need for an external SQLite tool', 2, null, [['card', String(cards[0])], ['commit', '9e52d43e']], ['journal', 'ui']],
      [today(0.3), 'plan', 'alpha', 'Build the timeline first, then the entry pane', null, null, 1, null, [['card', secondKey]], []],
      [day(1, 17), 'incident', null, 'The orange tabby knocked the build over', 'A flaky e2e run while the machine was loaded.', 'Runs under load need conditions, not sleeps', 1, null, [], ['flake']],
      [day(1, 11), 'insight', 'beta', 'Orange markers read better than red in both themes', null, null, 0, null, [], []],
      [day(2, 10), 'decision', 'beta', 'Old decision about orange themes', null, null, 1, null, [], []],
      [day(3, 12), 'digest', null, 'Week 42: the journal store merged, the browser started', 'Merged #1031; #1032 and #1033 in parallel.', null, 2, '2026-W42', [], ['digest']]
    ]
    for (const [at, kind, project, summary, detail, why, importance, digestOf, links, tags] of rows) {
      const id = Number(add.run(at, kind, project, summary, detail, why, 'assistant', importance, digestOf).lastInsertRowid)
      for (const [t, r] of links) link.run(id, t, r)
      for (const t of tags) tag.run(id, t)
    }
    // The old decision superseded by the newest one.
    const newest = db.prepare("SELECT id FROM entries WHERE summary LIKE 'Ship the journal%'").get().id
    db.prepare("UPDATE entries SET superseded_by = ? WHERE summary = 'Old decision about orange themes'").run(newest)
  } finally {
    db.close()
  }
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha)
  lib.gitProject(path.join(ws, 'beta'))
  const { app, page, inv } = await lib.launch({ userData, viewport: { width: 1400, height: 900 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    // Combwork's own fact: a card into Done makes the journal and its first entry.
    const first = await inv('tasks:create', { title: 'Journal browser', project: 'alpha' })
    // A long title (HI-2000): its chip in an entry's Links cut its key in two ("HI-" over "1985").
    const second = await inv('tasks:create', { title: 'Timeline rows: newest first by day, with search, filters, the keyboard and the entry pane beside them', project: 'alpha' })
    await inv('tasks:update', second.number, { column: 'doing' })
    await inv('tasks:update', first.number, { column: 'done' })
    check("Combwork's fact made the journal", !!(await lib.until(async () => (await inv('journal:status')).entries === 1, HUNG_MS)))
    // The plan links its card by key (HI-1661: as cw_journal_write's link asks), the decision by number (written before).
    seed([first.number, second.number], second.key)

    await page.locator('.activity-btn[aria-label="Assistant"]').click()
    await page.locator('.row[data-section="journal"]').click()
    const view = page.locator('.journal')
    const rows = view.locator('.journal-row')
    check('Journal → Timeline shows every entry', !!(await lib.until(async () => (await rows.count()) === 7, HUNG_MS)), String(await rows.count()))
    const summaries = async () => rows.locator('.journal-summary').allInnerTexts()
    check("newest first, by day (Today first): Combwork's fact, then the Assistant's", /^[A-Z]{2,4}-\d+ "Journal browser" is Done/.test((await summaries())[0]) && (await summaries())[1] === 'Ship the journal browser under the Assistant view' && (await view.locator('.journal-day-head').first().innerText()).toLowerCase() === 'today', JSON.stringify(await summaries()))
    const top = rows.filter({ hasText: 'Ship the journal browser' })
    check('a row has its kind mark, project, source and card chip', (await top.locator('.journal-kind-mark').count()) === 1 && /alpha/.test(await top.innerText()) && (await top.locator('.journal-source-mark').count()) === 1 && (await top.locator(`.card-chip[data-task="${first.number}"]`).count()) === 1)
    check('important entries are marked', (await top.locator('.journal-important').count()) === 1)
    const plan = rows.filter({ hasText: 'Build the timeline first' })
    check('a card linked by its key is its card chip too (HI-1661)', (await plan.locator(`.card-chip[data-task="${second.number}"]`).count()) === 1, await plan.innerHTML())
    check('a superseded entry is marked', (await view.locator('.journal-row.superseded').count()) === 1)
    check("Combwork's fact is there, by Combwork", (await view.locator('.journal-row', { hasText: '"Journal browser" is Done' }).locator('.journal-source-mark[aria-label="Combwork"]').count()) === 1, await view.locator('.journal-row').last().innerHTML())
    /** The notices in the corner closed, so a screenshot shows the browser. */
    const dismissToasts = async () => {
      const close = page.locator('.toast .icon-btn[aria-label="Dismiss"]')
      await lib.until(async () => {
        if ((await close.count()) === 0) return true
        await close.first().click().catch(() => undefined)
        return false
      }, HUNG_MS)
    }
    const footer = view.locator('.journal-footer')
    check('the footer says its size, entries, retention and cap', /[\d.,]+ [KM]?B · 7 entries · everyday entries kept 90 days · cap 50 MB/.test(await footer.innerText()), await footer.innerText())
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await page.screenshot({ path: path.join(lib.WORK, `journalbrowse-timeline-${theme}.png`) })
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))

    // A card chip opens the card.
    await top.locator(`.card-chip[data-task="${first.number}"]`).click()
    const cardDialog = lib.cardDialog(page, await lib.cardLabel(inv, first.number))
    check('a card chip opens its card', !!(await lib.until(async () => (await cardDialog.count()) >= 1, HUNG_MS)))
    await page.keyboard.press('Escape')
    await lib.until(async () => (await cardDialog.count()) === 0, HUNG_MS)

    // The keyboard: down from the search box to the rows, along them, Enter opens one.
    await view.locator('.journal-search input').focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    const focused = await page.evaluate(() => document.activeElement?.closest('.journal-row')?.querySelector('.journal-summary')?.textContent)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowUp')
    const back = await page.evaluate(() => document.activeElement?.closest('.journal-row')?.querySelector('.journal-summary')?.textContent)
    check('arrow keys move along the rows', focused === 'Ship the journal browser under the Assistant view' && back === focused, `${focused} / ${back}`)
    await page.keyboard.press('Enter')
    const pane = view.locator('.journal-entry')
    check('Enter opens the entry beside the timeline', !!(await lib.until(async () => /Ship the journal browser/.test((await pane.innerText().catch(() => '')) ?? ''), HUNG_MS)))
    const paneText = await pane.innerText()
    check('…with its detail, why, links and tags', /search and filters/.test(paneText) && /No need for an external SQLite tool/.test(paneText) && /9e52d43e/.test(paneText) && (await pane.locator(`.card-chip[data-task="${first.number}"]`).count()) === 1 && /journal/.test(paneText) && /Important/.test(paneText), paneText)
    check('…and the entry it supersedes', /Supersedes entry/.test(paneText))
    check('the open row is the current one for screen readers', (await top.locator('.journal-row-main').getAttribute('aria-current')) === 'true')
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await page.screenshot({ path: path.join(lib.WORK, `journalbrowse-entry-${theme}.png`) })
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))

    // HI-2000: a linked card with a long title keeps its key whole on one line; only its title is cut.
    await rows.filter({ hasText: 'Build the timeline first' }).locator('.journal-row-main').click()
    const longChip = pane.locator(`.journal-links .card-chip[data-task="${second.number}"]`)
    check('an entry links a card with a long title', !!(await lib.until(async () => (await longChip.count()) === 1, HUNG_MS)), await pane.innerText().catch(() => ''))
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      const k = await longChip.evaluate((chip) => {
        const key = chip.querySelector('.card-chip-number')
        const title = chip.querySelector('.card-chip-title')
        const range = document.createRange()
        if (key) range.selectNodeContents(key)
        return { lines: key ? new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size : 0, keyH: key?.getBoundingClientRect().height ?? 0, chipH: chip.getBoundingClientRect().height, cut: !!title && title.scrollWidth > title.clientWidth }
      })
      check(`…its key on one line, its title cut (${theme})`, k.lines === 1 && k.keyH <= k.chipH && k.cut, JSON.stringify(k))
      await pane.locator('.journal-links').first().screenshot({ path: path.join(lib.WORK, `journalbrowse-longchip-${theme}.png`) })
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    // The rows' chips (key only) keep theirs too.
    const rowKeys = await view.locator('.journal-chips .card-chip-number').evaluateAll((els) => els.map((e) => {
      const range = document.createRange()
      range.selectNodeContents(e)
      return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size
    }))
    check("…and the rows' chips theirs", rowKeys.length > 0 && rowKeys.every((n) => n === 1), JSON.stringify(rowKeys))
    await top.locator('.journal-row-main').click()
    await lib.until(async () => /Ship the journal browser/.test((await pane.innerText().catch(() => '')) ?? ''), HUNG_MS)

    // Edit: summary, kind and importance.
    await pane.getByRole('button', { name: 'Edit' }).click()
    await pane.locator('.journal-edit-summary').fill('Ship the journal browser (edited)')
    await pane.locator('.journal-edit-kind').selectOption('plan')
    await pane.locator('.journal-edit-importance').selectOption('3')
    await pane.getByRole('button', { name: 'Save' }).click()
    check('Edit saves the summary, kind and importance', !!(await lib.until(async () => /Ship the journal browser \(edited\)/.test(await pane.innerText()) && /Essential/.test(await pane.innerText()) && (await top.getAttribute('data-kind')) === 'plan', HUNG_MS)), await pane.innerText())
    const edited = await inv('journal:entry', Number(await top.getAttribute('data-entry')))
    check('…in the journal itself, marked edited', edited?.summary === 'Ship the journal browser (edited)' && edited.kind === 'plan' && edited.importance === 3 && !!edited.updatedAt, JSON.stringify(edited))
    await pane.getByRole('button', { name: 'Close' }).click()

    // Search: every word, as prefixes.
    const search = view.locator('.journal-search input')
    await search.fill('orange')
    check('search finds every entry with the word', !!(await lib.until(async () => (await rows.count()) === 3, HUNG_MS)), String(await rows.count()))
    await search.fill('orange them')
    check('…every word must be found (prefixes)', !!(await lib.until(async () => JSON.stringify(await summaries()) === JSON.stringify(['Orange markers read better than red in both themes', 'Old decision about orange themes']), HUNG_MS)), JSON.stringify(await summaries()))
    check('…and says how many', /2 entries/.test(await view.locator('.journal-count').innerText()))
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await page.screenshot({ path: path.join(lib.WORK, `journalbrowse-search-${theme}.png`) })
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))

    // Forget everything about X: asks with the count, then deletes just those.
    await search.fill('orange')
    await lib.until(async () => (await rows.count()) === 3, HUNG_MS)
    await view.locator('.journal-forget').click()
    const ask = page.locator('.dialog', { hasText: 'Forget everything about “orange”?' })
    check('Forget asks first, saying how many go', !!(await lib.until(async () => (await ask.count()) === 1, HUNG_MS)) && /3 entries match this search/.test(await ask.innerText()), await ask.innerText().catch(() => ''))
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await page.screenshot({ path: path.join(lib.WORK, `journalbrowse-forget-${theme}.png`) })
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await ask.getByRole('button', { name: 'Forget 3 Entries' }).click()
    check('…then they are gone', !!(await lib.until(async () => /No entries match/.test(await view.innerText()), HUNG_MS)))
    check('…and only they: 4 entries left', (await inv('journal:status')).entries === 4)
    await view.getByRole('button', { name: 'Clear Filters' }).click()
    check('Clear Filters shows the rest', !!(await lib.until(async () => (await rows.count()) === 4, HUNG_MS)))
    check('Forget needs a search or filter first', await view.locator('.journal-forget').isDisabled())

    // HR6's round 1: a new filter's results are still being read (slow), the old ones only shown: Forget waits for them,
    // and asks with the count of the filter as it is.
    await app.evaluate(() => {
      process.env.CW_TEST_SLOW_IPC = 'journal:browse=3000*1'
    })
    await view.locator('.journal-source').selectOption('hive')
    check('while a new filter is read, the old rows are dimmed and Forget waits', !!(await lib.until(async () => (await view.locator('.journal-scroll.pending').count()) === 1 && (await view.locator('.journal-forget').isDisabled()) && (await rows.count()) === 4, HUNG_MS)), String(await rows.count()))
    check('…then its own rows, and Forget', !!(await lib.until(async () => (await rows.count()) === 1 && (await view.locator('.journal-scroll.pending').count()) === 0 && !(await view.locator('.journal-forget').isDisabled()), HUNG_MS)))
    await app.evaluate(() => {
      delete process.env.CW_TEST_SLOW_IPC
    })
    await view.locator('.journal-forget').click()
    const askCombwork = page.locator('.dialog', { hasText: 'Forget 1 entry?' })
    check("Forget asks with the filter's own count", !!(await lib.until(async () => (await askCombwork.count()) === 1, HUNG_MS)) && /1 entry matches/.test(await askCombwork.innerText()), await page.locator('.dialog').innerText().catch(() => ''))
    await askCombwork.getByRole('button', { name: 'Cancel' }).click()
    await view.locator('.journal-source').selectOption('')
    await lib.until(async () => (await rows.count()) === 4, HUNG_MS)

    // HR6's round 1: an entry edited into the search while Forget asks: nothing is deleted, and it says how many match now.
    await search.fill('timeline')
    await lib.until(async () => (await rows.count()) === 1 && !(await view.locator('.journal-forget').isDisabled()), HUNG_MS)
    await view.locator('.journal-forget').click()
    const askOne = page.locator('.dialog', { hasText: 'Forget everything about “timeline”?' })
    await lib.until(async () => (await askOne.count()) === 1, HUNG_MS)
    check('Forget asks for the one entry', /1 entry matches/.test(await askOne.innerText()), await askOne.innerText())
    const week = (await inv('journal:browse', { kinds: ['digest'] })).rows[0].id
    await inv('journal:edit', week, { summary: 'Week 42: the journal store merged, the browser timeline started' })
    await askOne.getByRole('button', { name: 'Forget 1 Entry' }).click()
    check('…an entry edited into the search meanwhile: nothing is forgotten, and it says so', !!(await lib.until(async () => (await page.locator('.toast', { hasText: 'Nothing was forgotten' }).count()) === 1, HUNG_MS)) && /2 entries match now/.test(await page.locator('.toast', { hasText: 'Nothing was forgotten' }).innerText()))
    check('…every entry is still there', (await inv('journal:status')).entries === 4 && !!(await inv('journal:entry', week)))
    await view.locator('.journal-forget').click()
    const askTwo = page.locator('.dialog', { hasText: 'Forget everything about “timeline”?' })
    check('asked again, it counts both', !!(await lib.until(async () => (await askTwo.count()) === 1 && /2 entries match/.test(await askTwo.innerText()), HUNG_MS)))
    await askTwo.getByRole('button', { name: 'Cancel' }).click()
    await search.fill('')
    await lib.until(async () => (await rows.count()) === 4 && (await view.locator('.journal-scroll.pending').count()) === 0, HUNG_MS)

    // Filters: kind, project, source, dates.
    await view.locator('.journal-kind').selectOption('plan')
    check('the kind filter', !!(await lib.until(async () => JSON.stringify(await summaries()) === JSON.stringify(['Ship the journal browser (edited)', 'Build the timeline first, then the entry pane']), HUNG_MS)), JSON.stringify(await summaries()))
    await view.locator('.journal-kind').selectOption('')
    await view.locator('.journal-source').selectOption('hive')
    check('the source filter: only Combwork\'s facts', !!(await lib.until(async () => (await rows.count()) === 1 && /Journal browser/.test(await rows.first().innerText()), HUNG_MS)), JSON.stringify(await summaries()))
    await view.locator('.journal-source').selectOption('')
    await view.locator('.journal-project').selectOption('alpha')
    check('the project filter', !!(await lib.until(async () => (await rows.count()) === 3, HUNG_MS)), JSON.stringify(await summaries()))
    await view.locator('.journal-project').selectOption({ label: 'The workspace (no project)' })
    check("…and the workspace's own entries", !!(await lib.until(async () => JSON.stringify(await summaries()) === JSON.stringify(['Week 42: the journal store merged, the browser timeline started']), HUNG_MS)), JSON.stringify(await summaries()))
    await view.locator('.journal-project').selectOption('')
    const today = new Date()
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    await view.locator('.journal-from').fill(iso)
    check('the date filter: from today', !!(await lib.until(async () => (await rows.count()) === 3, HUNG_MS)), JSON.stringify(await summaries()))
    await view.getByRole('button', { name: 'Clear Filters' }).click()
    await lib.until(async () => (await rows.count()) === 4, HUNG_MS)

    // Escape on the open row closes the entry; Enter opens it again.
    const build = rows.filter({ hasText: 'Build the timeline first' }).locator('.journal-row-main')
    await build.click()
    await lib.until(async () => (await pane.count()) === 1, HUNG_MS)
    await page.keyboard.press('Escape')
    check('Escape on its row closes the entry, the row keeping the keyboard', !!(await lib.until(async () => (await pane.count()) === 0, HUNG_MS)) && (await build.evaluate((b) => b === document.activeElement)))
    await page.keyboard.press('Enter')
    await lib.until(async () => (await pane.count()) === 1, HUNG_MS)

    // Delete one entry, after asking.
    await pane.getByRole('button', { name: 'Delete…' }).click()
    const del = page.locator('.dialog', { hasText: 'Delete this journal entry?' })
    check('Delete asks first, naming the entry', !!(await lib.until(async () => (await del.count()) === 1, HUNG_MS)) && /Build the timeline first/.test(await del.innerText()))
    await del.getByRole('button', { name: 'Delete', exact: true }).click()
    check('…then it is gone and the pane closes', !!(await lib.until(async () => (await rows.count()) === 3 && (await pane.count()) === 0, HUNG_MS)))

    // Weekly Digests: only digests, reached with the keyboard from the sidebar (HR6's round 1: the rows weren't tab stops).
    await page.locator('.row[data-section="journal"]').focus()
    await page.keyboard.press('Tab')
    check('the sidebar rows are tab stops, Timeline the current one', (await page.evaluate(() => document.activeElement?.getAttribute('data-section'))) === 'digests' && (await page.locator('.row[data-section="journal"]').getAttribute('aria-current')) === 'page')
    await page.keyboard.press('Enter')
    check('Weekly Digests shows only the digests', !!(await lib.until(async () => (await rows.count()) === 1 && /Week 42/.test(await rows.first().innerText()) && /2026-W42/.test(await rows.first().innerText()), HUNG_MS)), JSON.stringify(await summaries()))
    check('…and is the current one', (await page.locator('.row[data-section="digests"]').getAttribute('aria-current')) === 'page')
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press(' ')
    await lib.until(async () => (await rows.count()) === 3, HUNG_MS)

    // A new fact shows without a refresh (the journal tells the window).
    const third = await inv('tasks:create', { title: 'Live fact', project: 'alpha' })
    await inv('tasks:update', third.number, { column: 'done' })
    check('a new entry shows at once', !!(await lib.until(async () => (await rows.count()) === 4 && /Live fact/.test(await rows.first().innerText()), HUNG_MS)), JSON.stringify(await summaries()))

    // Off: said, still readable, Turn On.
    await inv('journal:set', { enabled: false })
    await view.getByRole('button', { name: 'Refresh' }).click()
    const off = view.locator('.journal-off')
    check('off, the browser says so', !!(await lib.until(async () => (await off.count()) === 1 && /The journal is off/.test(await off.innerText()), HUNG_MS)))
    check('…and still reads the entries', (await rows.count()) === 4)
    await dismissToasts()
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await page.screenshot({ path: path.join(lib.WORK, `journalbrowse-off-${theme}.png`) })
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await off.getByRole('button', { name: 'Turn On' }).click()
    check('Turn On turns it on', !!(await lib.until(async () => (await inv('journal:status')).settings.enabled === true && (await off.count()) === 0, HUNG_MS)))

    // The footer's link opens Settings → Assistant.
    await view.locator('.journal-settings-link').click()
    check('Journal Settings opens Settings → Assistant', !!(await lib.until(async () => (await page.locator('.journal-settings').count()) === 1, HUNG_MS)))
  } finally {
    await app.close()
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
