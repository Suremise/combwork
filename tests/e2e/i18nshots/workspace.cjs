// Screenshot cases for the `workspace` area (#807): the status bar's plan limits tooltip of GitHub issue #1 (hovered,
// and under the pseudo-locale checked to read wholly translated: every line a message, no English word but the data),
// the status bar, the Workspace Overview (and its failed refresh), the Documentation view, the built-in hive MCP
// server's page, Settings → Workspace (storage, antivirus, hidden projects), a project's Storage and Clean Up, Remove
// Project, the update dialog and the Changes tab's Unused worktrees. Reached for the i18nshots route (#756's design,
// section 4) with locale-independent means only: IPC failures (HIVE_TEST_FAIL_IPC), events sent as main sends them,
// command ids and structural hooks (data-plan, data-section, classes, icons), never English text. See
// tests/e2e/i18nshots.cjs for ctx.
const fs = require('fs')
const path = require('path')
const { sessionsOf, putSessions } = require('../storeDocs.cjs')

/** Waits for a locator to be on the page; throws saying what didn't show. */
async function shown(ctx, locator, what) {
  if (!(await ctx.lib.until(async () => (await locator.count()) > 0, ctx.hungMs))) throw new Error(`${what} did not show`)
  return locator
}

/** Waits for a locator to be gone; throws saying what stayed. */
async function gone(ctx, locator, what) {
  if (!(await ctx.lib.until(async () => (await locator.count()) === 0, ctx.hungMs))) throw new Error(`${what} stayed`)
}

/** Closes the dialog on top with its Cancel (the first subtle button, whatever its words). */
async function cancelDialog(ctx) {
  const { page, lib } = ctx
  const cancel = () => page.locator('.dialog').last().locator('button.subtle').first().click({ timeout: 2000 }).then(() => false, () => false)
  if (!(await lib.until(async () => (await page.locator('.dialog').count()) === 0 || (await cancel()), ctx.hungMs))) throw new Error("the dialog didn't close")
}

/** Makes calls on an IPC channel fail: the next one (`*1`), or all until failing(ctx, ''): tests/e2e/README.md. */
const failing = (ctx, calls) => ctx.app.evaluate((_, c) => {
  process.env.HIVE_TEST_FAIL_IPC = c
}, calls)

/** Sends the window an event as main does (hive:event). */
const sendEvent = (ctx, ev) => ctx.app.evaluate(({ BrowserWindow }, e) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', e), ev)

/** An icon button by its icon (its name is translated), within `scope`. */
const iconButton = (ctx, scope, icon) => ctx.page.locator(`${scope} .icon-btn`, { has: ctx.page.locator(`.codicon-${icon}`) }).first()

/** The whole window. */
const windowShot = () => null

/**
 * Whether a line of the plan limits tooltip reads wholly in the pseudo-locale: a message ([…]) with no English word
 * left once the data is taken out (the provider's and plan's names; dates, which Intl writes in English for en-XA).
 */
function pseudoThroughout(line) {
  if (!/^\[.*\]$/.test(line)) return false
  const rest = line
    .replace(/Claude Code|\bmax\b/g, ' ')
    .replace(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/g, ' ')
    .replace(/\b(AM|PM)\b/g, ' ')
  return !/[A-Za-z]{2,}/.test(rest)
}

/**
 * GitHub issue #1: the status bar's plan limits tooltip, a 5-hour window resetting in hours and a weekly one resetting
 * on a weekday. Under en-XA every line must be a message with nothing left in English but the data.
 */
async function planTooltip(ctx) {
  const now = Date.now()
  await sendEvent(ctx, {
    type: 'plan-usage',
    provider: 'claude-code',
    usage: {
      provider: 'claude-code',
      plan: 'max',
      updatedAt: new Date(now - 4 * 60_000).toISOString(),
      limits: [
        { id: 'five_hour', label: '5-hour', windowMinutes: 300, usedPercent: 42, resetsAt: new Date(now + 125 * 60_000).toISOString() },
        { id: 'seven_day', label: 'weekly', windowMinutes: 7 * 24 * 60, usedPercent: 86, resetsAt: new Date(now + 3 * 24 * 3600_000).toISOString() }
      ]
    }
  })
  const item = await shown(ctx, ctx.page.locator('.statusbar [data-plan="claude-code"]'), "the status bar's plan limits")
  await item.first().hover()
  const tip = (await shown(ctx, ctx.page.locator('.tip', { has: ctx.page.locator('span[style*="pre-line"]') }), 'its tooltip')).last()
  if (ctx.lang === 'en-XA') {
    const lines = (await tip.innerText()).split('\n').map((l) => l.trim()).filter(Boolean)
    const english = lines.filter((l) => !pseudoThroughout(l))
    if (lines.length < 4 || english.length) throw new Error(`the plan limits tooltip isn't wholly translated: ${JSON.stringify(english.length ? english : lines)}`)
  }
  return tip
}

async function leaveTooltip(ctx) {
  await ctx.page.mouse.move(700, 300)
  await gone(ctx, ctx.page.locator('.tip', { has: ctx.page.locator('span[style*="pre-line"]') }), 'the tooltip')
}

/** The status bar. */
async function statusBar(ctx) {
  return shown(ctx, ctx.page.locator('.statusbar'), 'the status bar')
}

/**
 * A session of the Hive Assistant with usage today, as a Hive backup (.combwork/sessions in its home), so the Workspace
 * Overview has an Assistant row and chart series (wsoverview seeds projects the same way).
 */
function seedAssistantUsage(ctx) {
  const assistant = path.join(ctx.workspace, '.combwork', 'assistant')
  const home = path.join(assistant, '.combwork')
  const id = '77777777-aaaa-bbbb-cccc-000000000807'
  const at = new Date().toISOString()
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true })
  const lines = [
    { type: 'user', timestamp: at, message: { role: 'user', content: 'Go' } },
    { type: 'assistant', requestId: `${id}-0`, timestamp: at, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: 500 } } }
  ]
  fs.writeFileSync(path.join(home, 'sessions', `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  // Its records are in the workspace's database (#1061).
  const kept = sessionsOf(assistant)
  if (!kept.sessions.some((x) => x.id === id)) kept.sessions.push({ id, agent: 'claude-code', agentId: 'assistant', name: 'Assistant work', createdAt: at, lastActiveAt: at, archived: false })
  putSessions(assistant, kept)
}

/**
 * The seeded session in the usage history, which the Overview reads (#1106). A record written behind Hive's back reaches
 * it when a list of its host's sessions asks for it, as the Assistant's session picker does (the ten-minute sweep
 * otherwise, #1172): listed, then waited for until main counts it.
 */
async function assistantUsageRecorded(ctx) {
  await ctx.inv('session:list', path.join(ctx.workspace, '.combwork', 'assistant'))
  const counted = async () => (await ctx.inv('workspace:usage')).assistant.some((s) => s.usage)
  if (!(await ctx.lib.until(counted, ctx.hungMs))) throw new Error("the Assistant's seeded session never reached the usage history")
}

/** The Workspace Overview's sidebar row and chart legend entry for the Assistant. */
const assistantRow = (ctx) => ctx.page.locator('.sidebar .row', { has: ctx.page.locator('.assistant-mark') }).first().locator('.label')
const assistantLegend = (ctx) => ctx.page.locator('.overview-page .stack-legend > span').evaluateAll((spans) => spans.map((s) => s.textContent.trim()))

/** The Workspace Overview, with the Assistant's usage beside the projects'. */
async function overview(ctx) {
  seedAssistantUsage(ctx)
  await assistantUsageRecorded(ctx)
  await ctx.command('view.overview')
  await shown(ctx, ctx.page.locator('.overview-page .cards .card'), "the Workspace Overview's figures")
  await shown(ctx, ctx.page.locator('.sidebar .row .assistant-mark'), "the Assistant's row")
  await shown(ctx, ctx.page.locator('.overview-page .stack-legend .swatch'), "the chart's legend")
  if ((await assistantLegend(ctx)).length < 2) throw new Error(`the chart has no Assistant series: ${JSON.stringify(await assistantLegend(ctx))}`)
  return windowShot()
}

/** Sends the window a change of language, as main does when Settings → General → Language changes. */
const switchLanguage = (ctx, language) => sendEvent(ctx, { type: 'language-changed', language })

/**
 * A live change of language (#807, HR3's review): the Overview's Assistant label, worked out with its groups, follows
 * it in the sidebar and the chart's legend without a refresh. Under the pseudo-locale: to English and back.
 */
async function overviewLanguage(ctx) {
  if (ctx.lang === 'en-XA') {
    const info = (await ctx.inv('app:info')).language
    const pseudo = (t) => /^\[.*\]$/.test(t)
    if (!pseudo(await assistantRow(ctx).innerText())) throw new Error(`the Assistant's row isn't in the pseudo-locale: ${await assistantRow(ctx).innerText()}`)
    // i18n-ignore: the English the window changes to, compared with what it shows
    const english = 'Assistant'
    await switchLanguage(ctx, { ...info, code: 'en', locale: 'en', messages: {} })
    const followed = await ctx.lib.until(async () => (await assistantRow(ctx).innerText()) === english && (await assistantLegend(ctx)).includes(english), ctx.hungMs)
    const seen = `row ${JSON.stringify(await assistantRow(ctx).innerText())}, legend ${JSON.stringify(await assistantLegend(ctx))}`
    await switchLanguage(ctx, info)
    if (!followed) throw new Error(`after a change to English the Assistant shows as: ${seen}`)
    if (!(await ctx.lib.until(async () => pseudo(await assistantRow(ctx).innerText()) && (await assistantLegend(ctx)).some(pseudo), ctx.hungMs))) throw new Error("back in the pseudo-locale, the Assistant's row or legend stayed English")
  }
  return windowShot()
}

/** A refresh of the Workspace Overview that failed: the note over the figures, with Retry. */
async function overviewRefreshFailed(ctx) {
  await failing(ctx, 'workspace:usage*1')
  await iconButton(ctx, '.overview-head', 'refresh').click()
  return shown(ctx, ctx.page.locator('.overview-page', { has: ctx.page.locator('.load-stale') }).first(), "the failed refresh's note")
}

async function retryOverview(ctx) {
  await failing(ctx, '')
  await ctx.page.locator('.overview-page .load-stale button').first().click()
  await gone(ctx, ctx.page.locator('.overview-page .load-stale'), "the failed refresh's note")
}

/** The Documentation view on the licence (the view's own words; the documents are English until D2). */
async function docs(ctx) {
  await ctx.command('help.docs')
  const rows = await shown(ctx, ctx.page.locator('.split-list .pane-body .row', { has: ctx.page.locator('.codicon-law') }), 'the documentation pages')
  await rows.first().click()
  await shown(ctx, ctx.page.locator('.split-list .row.selected .codicon-law'), 'the licence page')
  return windowShot()
}

/** The built-in hive MCP server's page: what it is and its tools. */
async function mcpBuiltIn(ctx) {
  await ctx.command('view.mcp')
  await (await shown(ctx, ctx.page.locator('.sidebar .row.tall', { has: ctx.page.locator('.codicon-hubot') }), 'the built-in server')).first().click()
  await shown(ctx, ctx.page.locator('.page-narrow table'), "its tools' table")
  return windowShot()
}

/** Settings → Workspace: its storage, Defender's status (a test copy says so) and the hidden projects. */
async function settingsWorkspace(ctx) {
  await ctx.command('antivirus.show')
  await shown(ctx, ctx.page.locator('.settings .antivirus-scan'), "the antivirus status")
  await shown(ctx, ctx.page.locator('.settings .storage-table'), "the workspace's storage")
  return windowShot()
}

/** A project's Storage (Project Settings): what Hive keeps for it. */
async function projectStorage(ctx) {
  await ctx.command('view.projects')
  await ctx.command('project.tab.settings')
  await (await shown(ctx, ctx.page.locator('.settings-nav .row', { has: ctx.page.locator('.codicon-database') }), 'the Storage section')).first().click()
  await shown(ctx, ctx.page.locator('.settings-content .storage-table'), "the project's storage")
  return ctx.page.locator('.settings').first()
}

/** Clean Up…: what it offers and what would go. */
async function cleanUp(ctx) {
  await ctx.page.locator('.settings-content .storage-actions button.btn.small:not(.subtle)').first().click()
  await shown(ctx, ctx.page.locator('.dialog .cleanup-options'), 'Clean Up')
  return ctx.page.locator('.dialog').last()
}

/** Remove Project…: its three choices and what each touches. */
async function removeProject(ctx) {
  await ctx.command('project.remove')
  await shown(ctx, ctx.page.locator('.dialog .removal-list'), 'Remove Project')
  return ctx.page.locator('.dialog').last()
}

/** The update dialog (a test copy doesn't update itself: it says so). */
async function update(ctx) {
  await ctx.command('help.checkUpdates')
  await shown(ctx, ctx.page.locator('.dialog .update-dialog .update-line'), 'the update dialog')
  return ctx.page.locator('.dialog').last()
}

async function closeUpdate(ctx) {
  await ctx.page.locator('.dialog').last().locator('button.primary').last().click()
  await gone(ctx, ctx.page.locator('.dialog .update-dialog'), 'the update dialog')
}

/** The Changes tab's Unused worktrees (the project has none: said so, with what the page is for). */
async function unusedWorktrees(ctx) {
  await ctx.command('project.unusedWorktrees', ctx.project)
  await shown(ctx, ctx.page.locator('.unused-worktrees [data-about="unused"]'), 'Unused worktrees')
  return ctx.page.locator('.unused-worktrees').first()
}

/** Back to the Session tab for whatever comes next. */
async function closeLast(ctx) {
  await ctx.command('project.tab.session')
}

module.exports = {
  area: 'workspace',
  screens: [
    { name: 'plan-tooltip', open: planTooltip, close: leaveTooltip },
    { name: 'status-bar', open: statusBar },
    { name: 'overview', open: overview },
    { name: 'overview-language', open: overviewLanguage },
    { name: 'overview-refresh-failed', open: overviewRefreshFailed, close: retryOverview },
    { name: 'docs', open: docs },
    { name: 'mcp-builtin', open: mcpBuiltIn },
    { name: 'settings-workspace', open: settingsWorkspace },
    { name: 'project-storage', open: projectStorage },
    { name: 'clean-up', open: cleanUp, close: cancelDialog },
    { name: 'remove-project', open: removeProject, close: cancelDialog },
    { name: 'update', open: update, close: closeUpdate },
    { name: 'unused-worktrees', open: unusedWorktrees, close: closeLast }
  ]
}
