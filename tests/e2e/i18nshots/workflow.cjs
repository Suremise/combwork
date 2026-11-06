// Screenshot cases for the `workflow` area (#1126): the Version Control tab's Workflow section (the presets, a preset's
// preview, and its groups of options further down) and its Merge queue section, reached for the i18nshots route
// (#756's design, section 4) with locale-independent means only: IPC, the Agent API, command ids and structural hooks
// (data-section, data-vc-workflow, data-choice, data-group, data-task, data-lane, classes), never English text. The git
// area's cases ran first and left alpha a repository. See tests/e2e/i18nshots.cjs for ctx.
//
// Then 1.0's populated states (#1126 round 2), in a project of their own with long names, "Combwork merges" into
// `integration` (tests/e2e/queueFixture.cjs's helpers, through the route's Combwork): its merge queue paused by you with an
// approved card waiting, that card's dialog with its work (a revision, a check, a pass), a lane whose builder works in a
// slot from the project's pool, the Slots and copies group listing the pool, and a move you make that its rules refuse.
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const qf = require('../queueFixture.cjs')

/** Waits for a locator to be on the page; throws saying what didn't show. */
async function shown(ctx, locator, what) {
  if (!(await ctx.lib.until(async () => (await locator.count()) > 0, ctx.hungMs))) throw new Error(`${what} did not show`)
  return locator
}

/** Waits for a locator to be gone; throws saying what stayed. */
async function gone(ctx, locator, what) {
  if (!(await ctx.lib.until(async () => (await locator.count()) === 0, ctx.hungMs))) throw new Error(`${what} stayed open`)
}

/** Escape until nothing of `selector` is left (a dialog, a menu). */
async function dismiss(ctx, selector, what) {
  const { page, lib } = ctx
  if (!(await lib.until(async () => (await page.locator(selector).count()) === 0 || (await page.keyboard.press('Escape').then(() => false)), ctx.hungMs))) throw new Error(`${what} didn't close`)
}

const gitView = (ctx) => ctx.page.locator('.git-view').first()

/** The Version Control tab at a section. */
async function vcSection(ctx, id, hook, what) {
  await ctx.command('project.tab.changes')
  await (await shown(ctx, ctx.page.locator(`.git-sections [data-section="${id}"]`), `the ${id} section's tab`)).first().click()
  return shown(ctx, ctx.page.locator(hook), what)
}

/** Workflow: the presets and the first options. */
async function workflow(ctx) {
  await vcSection(ctx, 'workflow', '[data-vc-workflow] .workflow-form [data-group="presets"]', 'the Workflow section')
  await ctx.page.locator('[data-vc-workflow] [data-group="presets"]').first().scrollIntoViewIfNeeded()
  return gitView(ctx)
}

/** A preset other than the project's, opened: what it would change. */
async function preview(ctx) {
  await ctx.page.locator('[data-vc-workflow] .workflow-choice:not(.current)').first().click()
  return shown(ctx, ctx.page.locator('[data-vc-workflow] .workflow-preview'), "a preset's preview").then(() => gitView(ctx))
}

/** Its choice clicked again closes it. */
async function closePreview(ctx) {
  await ctx.page.locator('[data-vc-workflow] .workflow-choice.open').first().click()
  await gone(ctx, ctx.page.locator('[data-vc-workflow] .workflow-preview'), "the preset's preview")
}

/** A group of options further down, scrolled to the top of the page. */
const group = (id) => async (ctx) => {
  const g = await shown(ctx, ctx.page.locator(`[data-vc-workflow] [data-group="${id}"]`), `the ${id} options`)
  await g.first().evaluate((e) => e.scrollIntoView({ block: 'start' }))
  return gitView(ctx)
}

/** Merge queue: the project's queue (none waiting in alpha). */
async function queue(ctx) {
  await vcSection(ctx, 'queue', '.git-queue:not([aria-busy])', 'the Merge queue section')
  return gitView(ctx)
}

// ---------- 1.0's populated states, in a project of their own ----------

const BILLING = 'billing-portal-frontend'
const billingDir = (ctx) => path.join(ctx.workspace, BILLING)
const IDENTITY = { name: 'Combwork Queue Test', email: 'queue@example.com' }

/** Shows a project (Focus Project, the command notifications run with its folder) and waits for its title. */
async function showProject(ctx, dir) {
  const name = path.basename(dir)
  // Asked again until it shows: a project just added reaches the window's list a moment later, and focus skips one it lacks.
  // The title may start with how many agents need you: "(2) billing-portal-frontend — …".
  const shows = async () => (await ctx.page.title()).replace(/^\(\d+\) /, '').startsWith(name) || (await ctx.command('project.focus', dir).then(() => false))
  if (!(await ctx.lib.until(shows, ctx.hungMs))) throw new Error(`the project ${name} was not shown (the window's title: ${await ctx.page.title()})`)
}

/**
 * A project check run as an agent runs it, `cw-progress --check quick --card <key>` in its folder with its token (the
 * dev build's wrapper, run by Electron as Node): { code, out }.
 */
function runCheck(ctx, agent, key) {
  const { lib } = ctx
  const env = lib.childEnv({ ELECTRON_RUN_AS_NODE: '1', CW_PROGRESS_DATA: lib.probeDir('i18nshots-progress'), CW_API_URL: `http://127.0.0.1:${lib.port(47834)}`, CW_API_TOKEN_FILE: lib.tokenFile(agent.token) })
  return new Promise((resolve) => {
    const p = spawn(lib.ELECTRON, [path.join(lib.ROOT, 'out', 'main', 'cw-progress.js'), '--check', 'quick', '--card', key], { env, cwd: agent.folder, windowsHide: true })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('close', (code) => resolve({ code, out }))
  })
}

/**
 * The billing project, once per window: a repository on main with `integration` beside it, Combwork merging approved cards
 * into `integration` after a check that passes (run before review and as the merge check); its queue paused by you; a
 * builder and a reviewer (the fake Claude Code); card A approved (so queued, waiting behind the pause), then refused a
 * second submit; card B started in a lane, so its builder works in a slot from the pool.
 */
async function seedBilling(ctx) {
  if (ctx.billing) return ctx.billing
  // Made once: a later screen after a failed seed fails saying so, not on the half-made project.
  if (ctx.billingTried) throw new Error('the billing project was not made (see the first billing screen)')
  ctx.billingTried = true
  const { inv, lib } = ctx
  const dir = billingDir(ctx)
  const tools = path.join(ctx.workspace, '..', `${path.basename(ctx.workspace)}-billing-tools`)
  fs.mkdirSync(tools, { recursive: true })
  const tool = path.join(tools, 'check.cmd')
  fs.writeFileSync(tool, '@exit /b 0\r\n')
  lib.gitProject(dir, { 'invoices.txt': 'one\ntwo\nthree\n', '.gitignore': '.combwork/\n' })
  lib.git(dir, ['branch', '-M', 'main'])
  lib.git(dir, ['branch', 'integration'])
  // The identity its commits use, in its git config: G12 reads it from git each time (HI-2266, HI-2283).
  lib.git(dir, ['config', 'user.name', IDENTITY.name])
  lib.git(dir, ['config', 'user.email', IDENTITY.email])
  await inv('workspace:refresh')
  await inv('project:setActive', dir, true)
  await inv('workflow:setOptions', dir, {
    preset: null,
    options: { review: 'agent', noSelfReview: true, finish: 'combworkMerges', folder: 'slots', target: 'integration', style: 'merge', preChecks: ['quick'], mergeChecks: ['quick'], commands: { quick: `"${tool}"` }, identity: IDENTITY, okBefore: { mode: 'never', labels: [] } }
  })
  await inv('queue:pause', dir, 'integration')
  const fx = { name: 'i18nshots-billing', ws: ctx.workspace, claudeHome: ctx.claudeHome, alpha: dir, identity: IDENTITY }
  const h = { inv, port: lib.port(47834) }
  const builder = await qf.agent(fx, h, 'Invoice-Builder-North')
  const reviewer = await qf.agent(fx, h, 'Invoice-Reviewer-South')
  const make = async (title) => (await inv('tasks:create', { title, project: BILLING })).number
  const a = await make('Export invoices as PDF with the customer’s own letterhead, footer and payment terms')
  // As queueFixture's approve: started in the slot its start lends, committed there, submitted (its check runs), passed.
  const steps = { start: await qf.startCard(fx, h, builder, a) }
  fs.writeFileSync(path.join(builder.folder, 'invoices.txt'), 'one\ntwo\nthree\nPDF export\n')
  const as = ['-c', `user.name=${IDENTITY.name}`, '-c', `user.email=${IDENTITY.email}`]
  lib.git(builder.folder, [...as, 'add', '-A'])
  lib.git(builder.folder, [...as, 'commit', '-qm', 'Invoice PDF export'])
  // Submitted before its check ran: refused (the card's refusal line), then the check run as an agent runs it, and again.
  const early = await qf.intent(h, builder, a, 'submit', { summary: 'Invoice PDF export: ready' })
  if (early.status === 200) throw new Error(`card ${a}'s submit before its check wasn't refused`)
  const key = (await inv('tasks:list')).find((c) => c.number === a).key
  const run = await runCheck(ctx, builder, key)
  if (run.code !== 0) throw new Error(`card ${a}'s check didn't pass: ${JSON.stringify(run)}`)
  // Its run is recorded on the card as it ends, a moment after the wrapper exits.
  if (!(await lib.until(async () => (await inv('tasks:facts', a)).some((f) => f.kind === 'CheckRan'), ctx.hungMs))) throw new Error(`card ${a}'s check run wasn't recorded`)
  steps.submit = await qf.intent(h, builder, a, 'submit', { summary: 'Invoice PDF export: ready' })
  steps.review = await qf.intent(h, reviewer, a, 'start-review')
  steps.verdict = await qf.intent(h, reviewer, a, 'verdict', { pass: true, comment: 'Invoice PDF export: passed' })
  const failed = Object.entries(steps).filter(([, s]) => s.status !== 200)
  if (failed.length) throw new Error(`card ${a} wasn't approved: ${JSON.stringify(failed)}`)
  // Queued behind the pause.
  if (!(await lib.until(async () => (await inv('queue:list', dir, 'integration')).some((v) => v.queued?.length), ctx.hungMs))) throw new Error(`card ${a} wasn't queued`)
  const b = await make('Send overdue-payment reminders in the customer’s language, with the invoice attached')
  // A builder of its own: card A's keeps its slot until A is merged (the queue is paused).
  const second = await qf.agent(fx, h, 'Reminder-Builder-East')
  await ctx.api('POST', '/v1/lanes', { project: BILLING, builder: second.name, reviewer: reviewer.name, name: 'Invoices and reminders', cards: [b] })
  const started = await qf.startCard(fx, h, second, b)
  if (started.status !== 200) throw new Error(`card ${b} didn't start: ${JSON.stringify(started)}`)
  ctx.billing = { dir, a, b, agents: [builder, second, reviewer] }
  await showProject(ctx, dir)
  return ctx.billing
}

/** The Progress panel open at a tab. */
async function progressTab(ctx, tab) {
  const panel = ctx.page.locator('.progress-panel')
  if (!(await panel.count())) await ctx.command('progress.toggle')
  await (await shown(ctx, ctx.page.locator(`.progress-panel #progress-tab-${tab}`), `the Progress panel's ${tab} tab`)).first().click()
  return panel.first()
}

/** The Progress panel's Merges tab: the billing queue, paused by you, its approved card waiting. */
async function progressQueue(ctx) {
  await seedBilling(ctx)
  const panel = await progressTab(ctx, 'merges')
  await shown(ctx, panel.locator(`.progress-queue-card.paused[data-queue$="#integration"] [data-entry]`), 'the paused queue with its card')
  return panel
}

/** The Progress panel's Lanes tab: the billing lane, its builder in a slot. */
async function progressLanes(ctx) {
  const panel = await progressTab(ctx, 'lanes')
  await shown(ctx, panel.locator('.progress-lane'), "the billing lane's row")
  return panel
}

/** Version Control → Merge queue of the billing project: paused, its card waiting. */
async function billingQueue(ctx) {
  await seedBilling(ctx)
  await vcSection(ctx, 'queue', '.git-queue:not([aria-busy]) .git-queue-target', 'the paused queue')
  return gitView(ctx)
}

/** Version Control → Workflow's Slots and copies: the pool, a slot lent to card B. */
async function slots(ctx) {
  await seedBilling(ctx)
  await vcSection(ctx, 'workflow', '[data-vc-workflow] [data-group="slots"] [data-slot]', 'the slots in use')
  await ctx.page.locator('[data-vc-workflow] [data-group="slots"]').first().evaluate((e) => e.scrollIntoView({ block: 'start' }))
  return gitView(ctx)
}

/** A card's dialog, from the board of the project shown. */
async function openCard(ctx, n, what) {
  const { page } = ctx
  await ctx.command('view.board')
  await (await shown(ctx, page.locator(`.board-view .task-card[data-task="${n}"]`), `${what} on the board`)).first().click()
  return (await shown(ctx, page.locator('.dialog[role="dialog"]'), `${what}'s dialog`)).first()
}

/** Card A's dialog, at its Work section: what it waits for (the paused queue), its revision, its pass and its check. */
async function cardWork(ctx) {
  await seedBilling(ctx)
  const dialog = await openCard(ctx, ctx.billing.a, 'card A')
  const work = (await shown(ctx, dialog.locator('.card-work[data-work="recorded"] .card-work-rev'), "card A's work")).first()
  await dialog.locator('.card-work').first().evaluate((e) => e.scrollIntoView({ block: 'start' }))
  await work.waitFor()
  return dialog
}

/**
 * A refused move as you meet one: card B (started, nothing submitted) set to Review in its dialog and saved. Its
 * workflow refuses, saying why, what to do next and where the rule is set, in a notice (or, for a rule an exception can
 * skip, asks first): the whole window.
 */
async function moveRefused(ctx) {
  const { page, lib } = ctx
  await seedBilling(ctx)
  const dialog = await openCard(ctx, ctx.billing.b, 'card B')
  await dialog.locator('select:has(option[value="review"])').first().selectOption('review')
  await dialog.locator('.dialog-footer button.primary').first().click()
  const said = async () => (await page.locator('.toasts .toast').count()) > 0 || (await page.locator('.dialog[role="dialog"]').count()) > 1
  if (!(await lib.until(said, ctx.hungMs))) throw new Error("the move's refusal did not show")
  return null
}

/** Closes the notices and dialogs, stops the billing agents and goes back to alpha's Session tab for the next area's cases. */
async function closeBilling(ctx) {
  const { page, lib } = ctx
  const closeToast = () => page.locator('.toasts .toast .icon-btn').first().click({ timeout: 2000 }).then(() => false, () => false)
  if (!(await lib.until(async () => (await page.locator('.toasts .toast').count()) === 0 || (await closeToast()), ctx.hungMs))) throw new Error("the notices didn't close")
  await dismiss(ctx, '.dialog[role="dialog"]', "card B's dialog")
  for (const a of ctx.billing?.agents ?? []) await ctx.inv('session:stop', ctx.billing.dir, a.id)
  await showProject(ctx, ctx.project)
  await ctx.command('project.tab.session')
}

module.exports = {
  area: 'workflow',
  screens: [
    { name: 'vc-workflow', open: workflow },
    { name: 'vc-workflow-preview', open: preview, close: closePreview },
    { name: 'vc-workflow-review', open: group('review') },
    { name: 'vc-workflow-checks', open: group('checks') },
    { name: 'vc-workflow-merging', open: group('merging') },
    { name: 'vc-workflow-where', open: group('where') },
    { name: 'vc-workflow-loops', open: group('loops') },
    { name: 'vc-workflow-stages', open: group('stages') },
    { name: 'vc-queue', open: queue },
    { name: 'progress-queue-paused', open: progressQueue },
    { name: 'progress-lane-slot', open: progressLanes },
    { name: 'vc-queue-paused', open: billingQueue },
    { name: 'vc-slots', open: slots },
    { name: 'card-work', open: cardWork, close: (ctx) => dismiss(ctx, '.dialog[role="dialog"]', "card A's dialog") },
    { name: 'move-refused', open: moveRefused, close: closeBilling }
  ]
}
