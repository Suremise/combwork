// The merge queue after the 1.0 upgrade, in one session (#1621): a workspace whose board 0.9 left opens in the dev build,
// read-only and asked first. Opening it, the steps that need a board taking writes (the merge queues, the cards' and
// projects' ids and keys, ending reviews, archiving) skip it quietly: the log has no "no such table" nor "This board is
// from Hive 0.9" from them. The user says Upgrade; then, with no restart, a card approved under "Combwork merges" is merged
// by the queue (Done, Integrated by Combwork, the target at it). HI-1694: the window shows the upgrade and the steps after it
// as they go, nothing runs against the board meanwhile ("no such table", "readonly"), and the log times each step.
// The first merge waits for the merge style and commit message, which the upgrade left to the user (HI-1697): asked under
// For you, answered there (Squash, the branch's own message); then by a Workflow save; then through a crash after the
// board records the choice and one inside its change, each started again (CW_TEST_MERGE_CHOICE_CRASH); then a card with
// Combwork's message.
// The 0.9 board is written here as 0.9.3's schema steps made it (v1 `cards`, v2 `store_rows`: 0.9 is released, so they
// are fixed), so no packaged 0.9 is needed. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
// Dev build only (HI-1697): its crash cases end Combwork at a merge choice's seam (CW_TEST_MERGE_CHOICE_CRASH), which a
// packaged build ignores.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')
const q = require('./queueFixture.cjs')

const PORT = Number(lib.port(47900))
const fx = q.queueProject('queueupgrade')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000
const ASK = "Upgrade this workspace's board to 1.0?"
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 200)
const dbFile = path.join(fx.ws, '.combwork', 'combwork.db')

/** The workspace's board as Hive 0.9.3 left it: its two schema steps, no cards. */
function board09() {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true })
  const db = new DatabaseSync(dbFile)
  try {
    db.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL, hive_version TEXT NOT NULL) STRICT;
      CREATE TABLE cards (
        number     INTEGER PRIMARY KEY,
        doc        TEXT NOT NULL,
        project    TEXT    GENERATED ALWAYS AS (json_extract(doc, '$.project'))   STORED,
        project_id TEXT    GENERATED ALWAYS AS (json_extract(doc, '$.projectId')) STORED,
        col        TEXT    GENERATED ALWAYS AS (json_extract(doc, '$.column'))    STORED,
        ord        REAL    GENERATED ALWAYS AS (json_extract(doc, '$.order'))     STORED,
        agent      TEXT    GENERATED ALWAYS AS (json_extract(doc, '$.agent'))     STORED,
        archived   INTEGER GENERATED ALWAYS AS (coalesce(json_extract(doc, '$.archived') = 1, 0)) STORED,
        updated_at TEXT    GENERATED ALWAYS AS (json_extract(doc, '$.updatedAt')) STORED
      );
      CREATE INDEX cards_place ON cards(archived, col, ord);
      CREATE INDEX cards_project ON cards(project_id, archived);
      CREATE INDEX cards_agent ON cards(agent) WHERE agent IS NOT NULL;
      CREATE INDEX cards_updated ON cards(updated_at);
      CREATE TABLE board_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE archive_batches (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, doc TEXT NOT NULL) STRICT;
      CREATE TABLE store_rows (store TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL, ord INTEGER NOT NULL, doc TEXT NOT NULL, PRIMARY KEY (store, scope, key)) STRICT, WITHOUT ROWID;
      CREATE TABLE store_meta (store TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, scope, key)) STRICT, WITHOUT ROWID;
    `)
    const at = new Date().toISOString()
    const put = db.prepare('INSERT INTO schema_version (version, name, applied_at, hive_version) VALUES (?, ?, ?, ?)')
    put.run(1, 'cards', at, '0.9.3')
    put.run(2, 'store_rows', at, '0.9.3')
  } finally {
    db.close()
  }
}

/** The board's rows for a query, read on a connection of the suite's own. */
function rows(sql, ...args) {
  const db = new DatabaseSync(dbFile, { readOnly: true, timeout: 5000 })
  try {
    return db.prepare(sql).all(...args)
  } finally {
    db.close()
  }
}

/** The test profile's log as it is now. */
const log = () => {
  try {
    return fs.readFileSync(path.join(fx.userData, 'logs', 'combwork.log'), 'utf8')
  } catch {
    return ''
  }
}

;(async () => {
  q.prepare(fx)
  board09()
  // The project as 0.9 left it: a project.json with no platform recorded (1.0 records it as it makes one), so the
  // upgrade gives it its options, and leaves its merge style and commit message to be asked (HI-1697).
  fs.mkdirSync(path.join(fx.alpha, '.combwork'), { recursive: true })
  fs.writeFileSync(path.join(fx.alpha, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
  // Opened as the user opens it: the ask shows, nothing is pre-answered (no CW_TEST_BOARD_UPGRADE), options kept for after.
  let h = await q.startCombwork(fx, { port: PORT, keepOptions: true })
  try {
    h.page.on('pageerror', (e) => check('no page errors', false, e.message))
    const ask = h.page.locator('.dialog', { hasText: ASK })
    check('the 0.9 board opens read-only, asked first', !!(await until(async () => (await ask.count()) === 1, HUNG_MS)) && (await h.inv('board:state')).readOnly === 'upgrade')
    // The opening's steps have begun by the time its line is logged (they start before it, in the background).
    check('…the workspace opened', !!(await until(() => log().includes('[workspace] Opened workspace'), HUNG_MS)))
    check('…and the log says the board waits for the question (HI-1694)', /the board of .* waits for its upgrade to 1\.0 \(from v2\): read-only until the window's question is answered/.test(log()))

    // The opening view, from the click until the adoption and the slots are done (HI-1694), each text it shows.
    const view = h.page.locator('.workspace-opening')
    // The workspace's own opening ended first (its view, "Opening …", can still be up while the question shows).
    check('…its opening ended', !!(await until(async () => /opening .*: projects took \d+ ms; \d+ ms in all/.test(log()) && (await view.count()) === 0, HUNG_MS)))
    // Recorded in the window, not read from here now and then (HI-1988): the steps main tells it, and each text the view
    // shows with its step. The adoption and slots can take 50 ms in all: under load the window, busy with the upgraded
    // board, takes all three events before it renders again, so a step it was told need not be painted.
    await h.page.evaluate(() => {
      const seen = (window.__opening = { told: [], shown: [] })
      window.combwork.onEvent((e) => e.type === 'workspace-progress' && seen.told.push(e.progress))
      new MutationObserver(() => {
        const el = document.querySelector('.workspace-opening')
        const t = el?.innerText.replace(/\s+/g, ' ').trim()
        const last = seen.shown.at(-1)
        if (t && (last?.text !== t || last?.step !== el.dataset.step)) seen.shown.push({ step: el.dataset.step, text: t })
      }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-step'] })
    })
    await ask.getByRole('button', { name: 'Upgrade', exact: true }).click()
    check('Upgrade upgrades it', !!(await until(async () => (await h.inv('board:state')).readOnly === null, HUNG_MS)))
    // The adoption runs once after the upgrade, in the background: the project's options are set after it.
    check('…then the adoption, once', !!(await until(() => rows("SELECT value FROM board_meta WHERE key = 'adoption'").length === 1, HUNG_MS)))
    check('…and the opening view goes once its steps are done', !!(await until(async () => (await view.count()) === 0, HUNG_MS)))
    const { told, shown } = await h.page.evaluate(() => window.__opening)
    const name = path.basename(fx.ws)
    const toldSteps = told.map((p) => p?.step ?? null)
    check("…the window told the upgrade's steps, with the workspace's name, then that they ended", toldSteps.join() === 'upgrade,adoption,slots,' && told.slice(0, 3).every((p) => p.name === name), JSON.stringify(told))
    const STEP_TEXT = { upgrade: 'Upgrading its board.', adoption: 'Adopting its cards and projects…', slots: "Adopting its agents' worktrees as slots…" }
    check("…having shown each, as far as it was painted, under the workspace's name", shown.length > 0 && shown.every((s) => s.text.includes(`Upgrading ${name} to Combwork 1.0`) && s.text.includes(STEP_TEXT[s.step] ?? '\0')), shown.map((s) => `${s.step}: ${s.text}`).join(' | '))
    const skipped = log().split(/\r?\n/).filter((l) => /\[(WARN|ERROR)\]/.test(l) && /no such table|This board is from Hive 0\.9|readonly database|Could not save the performance metrics|bringing builders/.test(l))
    check('while it waited, nothing failed on the read-only board (no "no such table", "readonly", nor "This board is from Hive 0.9")', skipped.length === 0, skipped.join(' | '))
    const timed = log().split(/\r?\n/).filter((l) => /schema step|\[workspace\] opening |upgraded the board/.test(l))
    check("the log times the upgrade's steps and the opening's (HI-1694)", timed.some((l) => /took \d+ schema step\(s\) in \d+ ms, its copy before them \d+ ms: .*sessions and deliveries in tables \d+ ms/.test(l)) && timed.some((l) => /upgraded the board of .* to 1\.0 \(from v2\) in \d+ ms/.test(l)) && timed.some((l) => /opening .*: slots took \d+ ms; \d+ ms in all/.test(l)), timed.join(' | '))

    // No restart: "Combwork merges" into integration, and a card approved now goes to the queue. The upgrade left the merge
    // style and commit message unchosen (HI-1697): the queue asks under For you before it merges, and merges as answered.
    await h.inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx, { commitMessage: undefined }) })
    const projectJson = () => JSON.parse(fs.readFileSync(path.join(fx.alpha, '.combwork', 'project.json'), 'utf8'))
    check('the upgrade marked the project: its merge style and commit message are to be asked (a save keeping them keeps it)', projectJson().workflow?.mergeAsk === true, JSON.stringify(projectJson().workflow))
    let reviewer = await q.agent(fx, h, 'R1')
    check('the reviewer has its token', !!reviewer.token)
    q.steer(fx, 'pass')
    const before = q.head(fx)
    const one = await q.approve(fx, h, reviewer, 'After the upgrade', { 'one.txt': 'one\n' })
    check('a card is approved after the upgrade (start, submit, review, pass)', Object.values(one.steps).every((s) => s.status === 200), JSON.stringify(one.steps))
    const asked = async () => (await h.facts(one.n)).find((f) => f.kind === 'ApprovalRequested' && f.data?.gate === 'mergeChoice')
    check('the queue asks before its first merge: a Decide on the card, for the user', !!(await until(async () => (await asked())?.data?.kind === 'decide', HUNG_MS)), JSON.stringify(await h.kinds(one.n)))
    check('…the queue paused for it, nothing merged', q.head(fx) === before && (await h.card(one.n))?.column !== 'done', JSON.stringify(await h.kinds(one.n)))
    const helpers = q.folderHelpers(fx)
    const { dialog, section } = await helpers.forYouSection(h, one.n)
    const choice = section.locator('[data-merge-choice]')
    check("…shown in For you with the two options: the merge style as until now, the branch's own message first (HI-1997)", !!(await until(async () => (await choice.count()) === 1, HUNG_MS)) && (await choice.locator('[data-option="style"]').inputValue()) === 'merge' && (await choice.locator('[data-option="commitMessage"]').inputValue()) === 'branch')
    await helpers.themes(h.page, section, 'queueupgrade-merge-choice')
    await choice.locator('[data-option="style"]').selectOption('squash')
    await choice.locator('[data-option="commitMessage"]').selectOption('branch')
    await choice.getByRole('button', { name: 'Save and Carry On Merging' }).click()
    const done = await until(async () => (await h.card(one.n))?.column === 'done', HUNG_MS)
    check('answered: the queue merges it with no restart: Done', !!done, JSON.stringify(await h.kinds(one.n)))
    await h.page.keyboard.press('Escape')
    await until(async () => (await dialog.count()) === 0, HUNG_MS)
    const integrated = (await h.facts(one.n)).find((f) => f.kind === 'Integrated')
    const msgOf = (ref = 'integration') => lib.git(fx.alpha, ['log', '-1', '--format=%B', ref]).trim()
    const parents = (ref = 'integration') => lib.git(fx.alpha, ['log', '-1', '--format=%P', ref]).trim().split(' ').length
    check("…Integrated by Combwork, the target at its result, one squashed commit with the branch's own message: no key, no trailer", integrated?.data?.by === 'combwork' && integrated.data.result === q.head(fx) && parents() === 1 && msgOf() === 'After the upgrade', `${JSON.stringify(integrated)} / ${msgOf()}`)
    // The board records the choice first; project.json follows it (the upgrade's mark stays: the record answers it).
    const recorded = () => {
      const row = rows("SELECT value FROM board_meta WHERE key = 'workflow:alpha:mergeChoice'")[0]
      return row ? JSON.parse(row.value) : null
    }
    const wfNow = projectJson().workflow
    check("…the choice recorded on the board, and saved as the project's options", recorded()?.style === 'squash' && recorded().commitMessage === 'branch' && recorded().pending === false && wfNow?.options?.style === 'squash' && wfNow.options.commitMessage === 'branch', `${JSON.stringify(recorded())} / ${JSON.stringify(wfNow)}`)
    const request = (await asked())?.data?.request
    check('…and the question answered as the user', (await h.facts(one.n)).some((f) => f.kind === 'Approval' && f.data?.request === request && f.actor === 'user'), JSON.stringify(await h.kinds(one.n)))

    // The question again for each way the rest answers it: back to a merge commit and Combwork's message (the choice made, an
    // ordinary save), then Combwork closed, the board's record removed (as before any answer), and Combwork started again (with a
    // crash seam, `crash`). The builder and reviewer rejoin each run.
    let builder = one.builder
    const unchosen = async (crash) => {
      await h.inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx, { commitMessage: undefined }) })
      await h.app.close().catch(() => {})
      const db = new DatabaseSync(dbFile, { timeout: 5000 })
      try {
        db.prepare("DELETE FROM board_meta WHERE key = 'workflow:alpha:mergeChoice'").run()
      } finally {
        db.close()
      }
      await startAgain(crash ? { CW_TEST_MERGE_CHOICE_CRASH: crash } : {})
    }
    const startAgain = async (env = {}) => {
      h = await q.startCombwork(fx, { port: PORT, keepOptions: true, env })
      reviewer = await q.rejoin(fx, h, reviewer)
      builder = await q.rejoin(fx, h, builder)
    }
    const askedOf = async (n) => (await h.facts(n)).find((f) => f.kind === 'ApprovalRequested' && f.data?.gate === 'mergeChoice')
    /** A card approved and asked about: its number and the question's request. */
    const askedCard = async (title, file) => {
      q.steer(fx, 'pass')
      const c = await q.approveBy(fx, h, builder, reviewer, title, { [file]: `${title}\n` })
      check(`${title}: approved`, Object.values(c.steps).every((s) => s.status === 200), JSON.stringify(c.steps))
      check(`${title}: the queue asks`, !!(await until(async () => !!(await askedOf(c.n)), HUNG_MS)), JSON.stringify(await h.kinds(c.n)))
      return { n: c.n, request: (await askedOf(c.n))?.data?.request }
    }
    const landed = async (n, title, what) =>
      check(`${title}: ${what}: Done, one squashed commit with the branch's own message`, !!(await until(async () => (await h.card(n))?.column === 'done', HUNG_MS)) && parents() === 1 && msgOf() === title, `${parents()} parent(s) / ${msgOf()} / ${JSON.stringify(await h.kinds(n))}`)
    /** What the choice must leave alone: the project's other options, as queueOptions set them. */
    const unrelated = () => {
      const o = projectJson().workflow?.options ?? {}
      return o.finish === 'combworkMerges' && o.target === 'integration' && JSON.stringify(o.mergeChecks) === '["quick"]' && o.identity?.email === fx.identity.email
    }

    // The other way to answer (decision 3, HR5's round 1): a save in Version Control → Workflow, Squash with the branch's
    // own, lands the waiting card as one squashed commit (its ruleset had a merge commit when it was approved).
    await unchosen()
    const three = await askedCard('Chosen in Workflow', 'three.txt')
    await h.inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx, { style: 'squash', commitMessage: 'branch' }) })
    await landed(three.n, 'Chosen in Workflow', 'answered by the save')
    check('…the save recorded the choice and closed the question', recorded()?.style === 'squash' && (await h.facts(three.n)).some((f) => f.kind === 'RequestClosed' && f.data?.request === three.request))

    // A crash after the board's commit, before project.json (the Assistant's design, HR5's round 3): the board has the
    // choice, its file write pending; started again, Combwork writes the file from it, and the queue merges as chosen.
    await unchosen('beforeFile')
    const four = await askedCard('Crash after the board', 'four.txt')
    let ended = false
    h.app.process().once('exit', () => (ended = true))
    void h.inv('workflow:chooseMerge', fx.alpha, { card: four.n, request: four.request, style: 'squash', commitMessage: 'branch' }).catch(() => {})
    check('crash after the board: Combwork ended at the seam', !!(await until(() => ended, HUNG_MS)))
    check('…the board has the choice, its file write pending; project.json still has a merge commit', recorded()?.style === 'squash' && recorded().pending === true && projectJson().workflow?.options?.style === 'merge', `${JSON.stringify(recorded())} / ${JSON.stringify(projectJson().workflow?.options)}`)
    await h.app.close().catch(() => {})
    await startAgain()
    await landed(four.n, 'Crash after the board', 'started again')
    check('…project.json written from the board, its other options as they were', projectJson().workflow?.options?.style === 'squash' && projectJson().workflow.options.commitMessage === 'branch' && unrelated() && recorded()?.pending === false, JSON.stringify(projectJson().workflow))

    // A crash inside the board's change, before its commit: nothing kept, the question still open; started again, it is
    // answered and the card merges as chosen.
    await unchosen('recorded')
    const five = await askedCard('Crash inside the board', 'five.txt')
    ended = false
    h.app.process().once('exit', () => (ended = true))
    void h.inv('workflow:chooseMerge', fx.alpha, { card: five.n, request: five.request, style: 'squash', commitMessage: 'branch' }).catch(() => {})
    check('crash inside the board: Combwork ended at the seam', !!(await until(() => ended, HUNG_MS)))
    await h.app.close().catch(() => {})
    // Started again in German (HI-1733): the answer kept on the card as the user's comment is in their language.
    await startAgain({ CW_LANG: 'de' })
    // The crash is told in the corner ("Combwork closed unexpectedly", for two minutes), beside other notices of the restart
    // (resume the agent that was working…), any of which can lie over the card clicked below (HI-1989): the crash's seen,
    // then the corner's notices hidden.
    const notice = h.page.locator('.toasts .toast-title', { hasText: JSON.parse(fs.readFileSync(path.join(lib.ROOT, 'locales', 'de', 'main.json'), 'utf8'))['main.unexpectedClose.title'] })
    check('…the crash told in the corner: Combwork closed unexpectedly', !!(await until(async () => (await notice.count()) === 1, HUNG_MS)))
    await h.page.addStyleTag({ content: '.toasts { display: none !important; }' })
    const open = async () => !(await h.facts(five.n)).some((f) => (f.kind === 'Approval' || f.kind === 'RequestClosed') && f.data?.request === five.request)
    check('…nothing kept: no choice recorded, project.json as it was, the question still open, nothing merged', recorded() === null && projectJson().workflow?.options?.style === 'merge' && unrelated() && (await open()) && (await h.card(five.n))?.column !== 'done', `${JSON.stringify(recorded())} / ${JSON.stringify(projectJson().workflow?.options)}`)
    await h.inv('workflow:chooseMerge', fx.alpha, { card: five.n, request: five.request, style: 'squash', commitMessage: 'branch' })
    await landed(five.n, 'Crash inside the board', 'answered after the restart')
    const de = JSON.parse(fs.readFileSync(path.join(lib.ROOT, 'locales', 'de', 'workflow.json'), 'utf8'))
    const german = `${de['workflow.option.style.title']}: ${de['workflow.value.style.squash']}. ${de['workflow.option.commitMessage.title']}: ${de['workflow.value.commitMessage.branch']}.`
    const answer = (await h.facts(five.n)).find((x) => x.kind === 'Approval' && x.data?.request === five.request)
    check("…the answer, in German, as Version Control → Workflow names the options (HI-1733)", answer?.data?.note === german, JSON.stringify(answer?.data))
    // The board by its command, as the menu runs it (its button's name is German now).
    if (!(await h.page.locator('.board').isVisible())) await h.app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('cw:event', ev), { type: 'menu-command', command: 'view.board', args: [] })
    await until(async () => (await h.page.locator(`.task-card[data-task="${five.n}"]`).count()) === 1, HUNG_MS)
    await q.openByTitle(h.page, five.n)
    const comment = h.page.locator('.task-comment', { hasText: de['workflow.value.style.squash'] }).last()
    check('…kept on the card as the user’s comment', !!(await until(async () => (await comment.count()) === 1 && (await comment.innerText()).includes(german), HUNG_MS)), await comment.innerText().catch(() => ''))
    await comment.scrollIntoViewIfNeeded()
    await comment.screenshot({ path: path.join(fx.shots, 'queueupgrade-answer-de.png') })
    await h.page.keyboard.press('Escape')

    // Combwork's message again (the other option), still squashing: the next card lands as "KEY: title" with its trailers.
    await h.inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx, { style: 'squash', commitMessage: 'combwork' }) })
    q.steer(fx, 'pass')
    const two = await q.approveBy(fx, h, builder, reviewer, 'With the key', { 'two.txt': 'two\n' })
    check('a card with the choice made is approved', Object.values(two.steps).every((s) => s.status === 200), JSON.stringify(two.steps))
    check("…merged with no question: Combwork's message, its key and trailers", !!(await until(async () => (await h.card(two.n))?.column === 'done', HUNG_MS)) && /^[A-Z][A-Z0-9]*-\d+: With the key\n\nCombwork-Card: [A-Z][A-Z0-9]*-\d+\nCombwork-Revision: /.test(msgOf()) && parents() === 1, msgOf())
    const queueWarnings = log().split(/\r?\n/).filter((l) => /\[WARN\] \[queue\]/.test(l))
    check('…and the queue warned of nothing', queueWarnings.length === 0, queueWarnings.join(' | '))
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await h.app.close().catch(() => {})
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
