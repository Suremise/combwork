// Screenshot cases for the `project` area (#805): the project's header, tab strip and menu; the Overview (figures, the
// agents running, the table by agent, the session's details, and its failed load) and the plan limits of GitHub issue
// #1; the Git tab's Changes; Memory (with a new instructions file saved, checked to be the English starter agents
// read), Skills and MCP (with their failed loads and refreshes); and Project Settings
// (sections and the reset dialog). Reached for the i18nshots route (#756's design, section 4) with locale-independent
// means only: git run on the project, IPC failures (HIVE_TEST_FAIL_IPC), events sent as main sends them, command ids
// and structural hooks (data-action, data-section, data-stat, classes, icons), never English text. See
// tests/e2e/i18nshots.cjs for ctx.
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

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

/** git in the project, with an identity of its own for the commits made here (never the machine's config). */
const git = (ctx, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd: ctx.project, env: ctx.lib.gitEnv(), stdio: 'pipe', encoding: 'utf8' })

/** The project as a repository with uncommitted changes, whatever the cases before made of it. */
function seedChanges(ctx) {
  const dir = ctx.project
  if (!fs.existsSync(path.join(dir, '.git'))) {
    git(ctx, 'init', '-q')
    git(ctx, 'commit', '-q', '--allow-empty', '-m', 'init')
  }
  fs.writeFileSync(path.join(dir, 'NOTES.md'), `# Notes\n\nChanged ${Date.now()}\n`)
}

/** The project's header (its status, Active and the batch actions) and its tab strip, over the Session tab. */
async function header(ctx) {
  await ctx.command('project.tab.session')
  await shown(ctx, ctx.page.locator('.project-header'), "the project's header")
  await shown(ctx, ctx.page.locator('.tabs-row .tab.active'), 'the tab strip')
  return null
}

/** The project header's ⋯ menu. */
async function projectMenu(ctx) {
  await ctx.page.locator('.project-header [data-action="project-menu"]').first().click()
  await shown(ctx, ctx.page.locator('.menu[role="menu"]'), "the project's menu")
  return null
}

async function closeMenu(ctx) {
  await ctx.page.keyboard.press('Escape')
  await gone(ctx, ctx.page.locator('.menu[role="menu"]'), 'the menu')
}

/** The Overview when the sessions could not be read: said in its place, with Retry. */
async function overviewFailed(ctx) {
  await failing(ctx, 'session:list')
  await ctx.command('project.tab.overview')
  return shown(ctx, ctx.page.locator('.load-failed').first(), "the Overview's failed load")
}

async function retryOverview(ctx) {
  await failing(ctx, '')
  await ctx.page.locator('.load-failed button').first().click()
  await shown(ctx, ctx.page.locator('.overview-page'), 'the Overview')
}

/** The Overview, with the plan limits a provider reported (a 5-hour window and a weekly one, resetting in days: issue #1). */
async function overview(ctx) {
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
  await ctx.command('project.tab.overview')
  await shown(ctx, ctx.page.locator('.overview-page .card[data-stat="cost"]'), "the Overview's figures")
  await shown(ctx, ctx.page.locator('.overview-page .overview-plan'), 'the plan limits')
  return ctx.page.locator('.overview-page').first()
}

/** The provider's plan limits on the Overview: the 5-hour one resets in hours, the weekly one on a day (issue #1). */
async function planLimits(ctx) {
  const section = ctx.page.locator('.overview-page .page-narrow > div', { has: ctx.page.locator('.overview-plan') }).first()
  await shown(ctx, section.locator('.cards .card'), 'the plan limits')
  await section.locator('.overview-plan').scrollIntoViewIfNeeded()
  return section
}

/** The Git tab's Changes, of the project folder: a changed file and its diff. */
async function changes(ctx) {
  seedChanges(ctx)
  await ctx.command('project.tab.changes')
  await (await shown(ctx, ctx.page.locator('.git-sections [data-section="changes"]'), "the Git tab's sections")).first().click()
  // The project folder's own changes (the picker's last entry, its value empty), when the picker is there. It shows
  // once the tab has read the branches it can compare (HI-1824), and the page it opens on may be another (unused
  // worktrees, or two branches compared), so choose the folder until its changes list.
  const picker = ctx.page.locator('.changes-picker')
  const rows = ctx.page.locator('.split-list .pane-body .row')
  await ctx.lib.until(async () => {
    if ((await picker.count()) && (await picker.first().inputValue().catch(() => null)) !== '') {
      await picker.first().selectOption('').catch(() => {})
      return false
    }
    return (await rows.count()) > 0
  }, ctx.hungMs)
  const row = await shown(ctx, rows, 'a changed file')
  await row.first().click()
  await shown(ctx, ctx.page.locator('.split-main .editor-toolbar'), 'its diff')
  return ctx.page.locator('.split', { has: picker.or(ctx.page.locator('.split-list .pane-body')) }).first()
}

/** Memory when its files could not be read: said in the list, with Retry. */
async function memoryFailed(ctx) {
  await failing(ctx, 'memory:list')
  await ctx.command('project.tab.memory')
  return shown(ctx, ctx.page.locator('.split', { has: ctx.page.locator('.load-failed') }).first(), "Memory's failed load")
}

async function retryMemory(ctx) {
  await failing(ctx, '')
  await ctx.page.locator('.load-failed button').first().click()
  await gone(ctx, ctx.page.locator('.load-failed'), "Memory's failed load")
}

/** The project's instructions file Memory offers to create (its row's path in the project, the file not there yet). */
async function missingInstructions(ctx) {
  await shown(ctx, ctx.page.locator('.split-list .pane-body .row[data-path]'), "Memory's files")
  const paths = await ctx.page.locator('.split-list .pane-body .row[data-path]').evaluateAll((rows) => rows.map((r) => r.dataset.path))
  const file = paths.find((p) => path.dirname(p) === ctx.project && !fs.existsSync(p))
  if (!file) throw new Error(`no instructions file to create in the project (rows: ${paths.join(', ')})`)
  return [file, paths.indexOf(file)]
}

/** Memory: each provider's instructions and memory, with the project's instructions file to create open. */
async function memory(ctx) {
  await ctx.command('project.tab.memory')
  ;[ctx.newInstructions, ctx.newInstructionsRow] = await missingInstructions(ctx)
  await ctx.page.locator('.split-list .pane-body .row[data-path]').nth(ctx.newInstructionsRow).click()
  await shown(ctx, ctx.page.locator('.split-main .editor-toolbar button.primary:not([disabled])'), 'the file to create, with Save')
  return ctx.page.locator('.split').first()
}

/**
 * Saved: what agents read stays English in any language (#805, HR3's review): the file starts with the English
 * starter under the project's own name, not the window's language.
 */
async function memorySaved(ctx) {
  const file = ctx.newInstructions
  await ctx.page.locator('.split-main .editor-toolbar button.primary').first().click()
  if (!(await ctx.lib.until(() => fs.existsSync(file), ctx.hungMs))) throw new Error(`${file} was not written`)
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  // The English starter (shared/projectTabs.ts instructionsStarter), whatever the window's language.
  const english = new RegExp(`^# ${path.basename(ctx.project)}\n\nInstructions for [A-Za-z ]+ in this project\\.\n$`)
  if (!english.test(text)) throw new Error(`the new instructions file isn't the English starter: ${JSON.stringify(text)}`)
  await shown(ctx, ctx.page.locator('.split-main .editor-toolbar button.primary[disabled]'), 'the file, saved')
  return ctx.page.locator('.split').first()
}

/** The project's Skills tab, with the provider's skills unfolded. */
async function skills(ctx) {
  await ctx.command('project.tab.skills')
  await shown(ctx, ctx.page.locator('.skill-provider-toggle'), "the provider's skills")
  if ((await ctx.page.locator('.skill-provider-toggle[aria-expanded="false"]').count()) > 0) await ctx.page.locator('.skill-provider-toggle').first().click()
  await shown(ctx, ctx.page.locator('.skill-provider-toggle[aria-expanded="true"]'), "the provider's skills, unfolded")
  return ctx.page.locator('.split').first()
}

/** A refresh of the skills that failed: the note over them, with Retry. */
async function skillsRefreshFailed(ctx) {
  await failing(ctx, 'skills:list')
  await ctx.page.locator('.split-list .pane-header .icon-btn').first().click()
  await shown(ctx, ctx.page.locator('.split-list .load-stale'), "the failed refresh's note")
  return ctx.page.locator('.split').first()
}

async function retrySkills(ctx) {
  await failing(ctx, '')
  await ctx.page.locator('.split-list .load-stale button').first().click()
  await gone(ctx, ctx.page.locator('.split-list .load-stale'), "the failed refresh's note")
}

/** The project's MCP tab. */
async function mcp(ctx) {
  await ctx.command('project.tab.mcp')
  await shown(ctx, ctx.page.locator('.page-narrow .toggle-list'), 'the MCP tab')
  return ctx.page.locator('.page-narrow').first()
}

/** Project Settings: a section, by its icon in the list of sections (HI-2107: no provider pages; a CLI's settings are under Agents). */
async function settingsSection(ctx, icon) {
  await ctx.command('project.tab.settings')
  await shown(ctx, ctx.page.locator('.settings-nav .row'), 'the sections of Project Settings')
  const row = ctx.page.locator('.settings-nav .row', { has: ctx.page.locator(`.codicon-${icon}`) })
  await (await shown(ctx, row, `the section (${icon})`)).first().click()
  await shown(ctx, ctx.page.locator('.settings-nav .row.selected'), 'the section, selected')
  await shown(ctx, ctx.page.locator('.settings-content .setting'), 'its settings')
  return ctx.page.locator('.settings').first()
}

/** Project Settings → Advanced's Reset asks first. */
async function resetDialog(ctx) {
  await settingsSection(ctx, 'tools')
  await ctx.page.locator('.settings-content .setting button.btn.subtle').last().click()
  return shown(ctx, ctx.page.locator('.dialog').last(), 'the reset dialog')
}

/** Its Cancel, and back to the Session tab for the next area's cases. */
async function closeLast(ctx) {
  await cancelDialog(ctx)
  await ctx.command('project.tab.session')
}

module.exports = {
  area: 'project',
  screens: [
    { name: 'header', open: header },
    { name: 'project-menu', open: projectMenu, close: closeMenu },
    { name: 'overview-failed', open: overviewFailed, close: retryOverview },
    { name: 'overview', open: overview },
    { name: 'plan-limits', open: planLimits },
    { name: 'changes', open: changes },
    { name: 'memory-failed', open: memoryFailed, close: retryMemory },
    { name: 'memory', open: memory },
    { name: 'memory-saved', open: memorySaved },
    { name: 'skills', open: skills },
    { name: 'skills-refresh-failed', open: skillsRefreshFailed, close: retrySkills },
    { name: 'mcp', open: mcp },
    { name: 'settings-agents', open: (ctx) => settingsSection(ctx, 'organization') },
    { name: 'settings-sessions', open: (ctx) => settingsSection(ctx, 'history') },
    { name: 'reset-dialog', open: resetDialog, close: closeLast }
  ]
}
