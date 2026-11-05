// Screenshot cases for the `assistant` area (#806): the Combwork Assistant's panel (idle, its menus, its strip and its
// settings), the Assistant view and its modes (with New Mode), the Skills view (its failed load and refresh, a skill's
// delete confirmation), Shared Notes and the MCP view (a server with a literal secret, whose warning main words), the
// Projects sidebar (a project's menu, the compact rail), and templates: the Templates view (its failed load, a
// template, its editor, Load into Project's plan, the delete confirmation) and a project's Templates tab. Reached for
// the i18nshots route (#756's design, section 4) with locale-independent means only: IPC calls and failures
// (CW_TEST_FAIL_IPC), command ids and structural hooks (classes, icons, data-path), never English text. See
// tests/e2e/i18nshots.cjs for ctx.
const fs = require('fs')
const path = require('path')

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

async function closeMenu(ctx) {
  await ctx.page.keyboard.press('Escape')
  await gone(ctx, ctx.page.locator('.menu[role="menu"]'), 'the menu')
}

/** The menu that opened. */
const menuShown = (ctx) => shown(ctx, ctx.page.locator('.menu[role="menu"]'), 'the menu')

/** Makes calls on an IPC channel fail: the next one (`*1`), or all until failing(ctx, ''): tests/e2e/README.md. */
const failing = (ctx, calls) => ctx.app.evaluate((_, c) => {
  process.env.CW_TEST_FAIL_IPC = c
}, calls)

/** An icon button by its icon (its name is translated), within `scope`. */
const iconButton = (ctx, scope, icon) => ctx.page.locator(`${scope} .icon-btn`, { has: ctx.page.locator(`.codicon-${icon}`) }).first()

/** Shows a sidebar view by its command, unless it is already shown (the command would hide the sidebar then). */
async function showView(ctx, command, hook) {
  if (!(await ctx.page.locator(hook).count())) await ctx.command(command)
}

/** The whole sidebar and main area (null: the window). */
const windowShot = () => null

// --- The Assistant's panel.

/** The panel, shown (it starts as a strip), before the Assistant starts: who it is and how to start it. */
async function panel(ctx) {
  const strip = ctx.page.locator('.assistant-rail')
  if (await strip.count()) await strip.first().click()
  await shown(ctx, ctx.page.locator('.assistant-panel .assistant-idle'), "the Assistant's panel, idle")
  return ctx.page.locator('.assistant-panel').first()
}

/** Its ⋯ menu. */
async function moreMenu(ctx) {
  await iconButton(ctx, '.assistant-header', 'ellipsis').click()
  return menuShown(ctx)
}

/** Its mode menu. */
async function modeMenu(ctx) {
  await ctx.page.locator('.assistant-header .assistant-mode').first().click()
  return menuShown(ctx)
}

/** Assistant Settings. */
async function settingsDialog(ctx) {
  await ctx.command('assistant.settings')
  return shown(ctx, ctx.page.locator('.dialog').last(), 'Assistant Settings')
}

/** The panel hidden (its command: the header's ⋯ has it, #979): the strip down the window's edge. */
async function rail(ctx) {
  await ctx.command('assistant.toggle')
  return shown(ctx, ctx.page.locator('.assistant-rail'), "the Assistant's strip")
}

// --- The Assistant view and its modes.

/** The modes Combwork ships, by their files (resources/modes): their names are the window's, their files Combwork's. */
const SHIPPED_MODES = ['coordinator', 'planner', 'qa-triager', 'release-manager']

/** A mode's name as its row shows it (the badges after it aside). */
const modeName = (ctx, id) => ctx.page.locator(`.sidebar .mode-row[data-mode="${id}"] .label`).first().evaluate((el) => el.firstChild?.textContent ?? '')

/** A mode file's own name (its front matter). */
const fileName = (ctx, id) => /^name:\s*(.+)$/m.exec(fs.readFileSync(path.join(ctx.workspace, '.combwork', 'modes', `${id}.md`), 'utf8'))?.[1].trim()

/**
 * The Assistant view: what it has used, its modes (one of the user's own among them), its conversations. Under the
 * pseudo-locale the shipped modes' names are translated while the user's keeps its own, and no file changes (#806).
 */
async function assistantView(ctx) {
  const own = await ctx.inv('modes:create', 'Night owl')
  await ctx.command('view.assistant')
  await shown(ctx, ctx.page.locator('.sidebar .assistant-summary'), 'the Assistant view')
  await shown(ctx, ctx.page.locator(`.sidebar .mode-row[data-mode="${own.id}"]`), 'its modes, with the new one')
  if (ctx.lang === 'en-XA') {
    for (const id of SHIPPED_MODES) {
      const name = await modeName(ctx, id)
      if (!/^\[.*\]$/.test(name)) throw new Error(`the shipped mode ${id} shows as ${JSON.stringify(name)}, not in the window's language`)
    }
    const ownName = await modeName(ctx, own.id)
    if (ownName !== 'Night owl') throw new Error(`the user's mode shows as ${JSON.stringify(ownName)}, not its own name`)
  }
  const files = [...SHIPPED_MODES, own.id].map((id) => fileName(ctx, id))
  // The names the files keep, whatever the window's language.
  if (JSON.stringify(files) !== JSON.stringify(['Coordinator', 'Planner', 'QA triager', 'Release manager', 'Night owl'])) throw new Error(`the mode files' names changed: ${JSON.stringify(files)}`)
  return windowShot()
}

/** A mode, open in the editor. */
async function mode(ctx) {
  await ctx.page.locator('.sidebar .mode-row').first().click()
  await shown(ctx, ctx.page.locator('.split .editor-toolbar'), 'the mode, open')
  return windowShot()
}

/** New Mode's dialog. */
async function newMode(ctx) {
  await iconButton(ctx, '.sidebar .section-actions', 'add').click()
  return shown(ctx, ctx.page.locator('.dialog').last(), 'New Mode')
}

// --- Skills.

/** The Skills view when the workspace's skills could not be read: said in their place, with Retry. */
async function skillsFailed(ctx) {
  await failing(ctx, 'skills:workspace')
  await ctx.command('view.skills')
  return shown(ctx, ctx.page.locator('.sidebar', { has: ctx.page.locator('.load-failed') }).first(), "the skills' failed load")
}

async function retrySkills(ctx) {
  await failing(ctx, '')
  await ctx.page.locator('.sidebar .load-failed button').first().click()
  await shown(ctx, ctx.page.locator('.sidebar .skill-row'), 'the skills')
}

/** The Skills view, a skill of Combwork's own open. */
async function skills(ctx) {
  await showView(ctx, 'view.skills', '.sidebar .skill-row')
  await (await shown(ctx, ctx.page.locator('.sidebar .skill-row'), 'the skills')).first().click()
  await shown(ctx, ctx.page.locator('.split .editor-toolbar'), 'the skill, open')
  return windowShot()
}

/** A refresh of the skills that failed: the note over them, with Retry. */
async function skillsRefreshFailed(ctx) {
  await failing(ctx, 'skills:workspace*1')
  await iconButton(ctx, '.sidebar .pane-header', 'refresh').click()
  return shown(ctx, ctx.page.locator('.sidebar', { has: ctx.page.locator('.load-stale') }).first(), "the failed refresh's note")
}

async function retrySkillsRefresh(ctx) {
  await failing(ctx, '')
  await ctx.page.locator('.sidebar .load-stale button').first().click()
  await gone(ctx, ctx.page.locator('.sidebar .load-stale'), "the failed refresh's note")
}

/** Deleting a Combwork skill asks first, saying who loses it. */
async function skillDelete(ctx) {
  await iconButton(ctx, '.split .editor-toolbar', 'trash').click()
  return shown(ctx, ctx.page.locator('.dialog').last(), "the skill's delete confirmation")
}

// --- Shared Notes and MCP.

/** Shared Notes, with a folder and a note, and a note's menu. */
async function notes(ctx) {
  await ctx.inv('notes:create', 'plans', true)
  await ctx.inv('notes:create', 'plans/next.md', false)
  await ctx.command('view.notes')
  // The plans folder's row, by its path: Workspace notes is pinned first (#1433) and has no menu.
  const row = ctx.page.locator('.sidebar .pane-body .row[data-note="plans"]')
  await (await shown(ctx, row, 'the notes')).click({ button: 'right' })
  await menuShown(ctx)
  return windowShot()
}

/** New Note's dialog. */
async function newNote(ctx) {
  await iconButton(ctx, '.sidebar .pane-header', 'new-file').click()
  return shown(ctx, ctx.page.locator('.dialog').last(), 'New Note')
}

/** New Folder's dialog: its example name in the window's language (#885). */
async function newFolder(ctx) {
  await iconButton(ctx, '.sidebar .pane-header', 'new-folder').click()
  return shown(ctx, ctx.page.locator('.dialog').last(), 'New Folder')
}

/** The MCP view, with a server whose definition has a literal secret: its warning, from main, in the window's language. */
async function mcp(ctx) {
  const name = 'tokens'
  if (!(await ctx.inv('mcp:list')).some((m) => m.name === name)) await ctx.inv('mcp:create', name)
  await ctx.inv('mcp:save', name, JSON.stringify({ command: 'node', args: ['server.js'], env: { GITHUB_TOKEN: 'ghp_abcdefghijklmnop' } }, null, 2))
  await ctx.command('view.mcp')
  const row = ctx.page.locator('.sidebar .row.tall', { has: ctx.page.locator('.codicon-warning') }).first()
  await (await shown(ctx, row, 'the server with a secret')).click()
  return windowShot()
}

/** New MCP Server's dialog. */
async function newMcp(ctx) {
  await iconButton(ctx, '.sidebar .pane-header', 'add').click()
  return shown(ctx, ctx.page.locator('.dialog').last(), 'New MCP Server')
}

// --- Projects.

/** A project's right-click menu in the Projects sidebar. */
async function projectMenu(ctx) {
  await ctx.command('view.projects')
  await (await shown(ctx, ctx.page.locator('.sidebar .project-row'), 'the projects')).first().click({ button: 'right' })
  await menuShown(ctx)
  return windowShot()
}

/** The Projects sidebar compacted to a rail. */
async function projectsRail(ctx) {
  await ctx.command('view.compactSidebar')
  return shown(ctx, ctx.page.locator('.sidebar.compact .rail'), 'the compact rail')
}

async function expandRail(ctx) {
  await ctx.command('view.compactSidebar')
  await gone(ctx, ctx.page.locator('.sidebar.compact'), 'the compact rail')
}

// --- Templates.

/** The Templates view when the templates could not be read: said in their place, with Retry. */
async function templatesFailed(ctx) {
  await failing(ctx, 'templates:all')
  await ctx.command('view.templates')
  return shown(ctx, ctx.page.locator('.sidebar', { has: ctx.page.locator('.load-failed') }).first(), "the templates' failed load")
}

async function retryTemplates(ctx) {
  await failing(ctx, '')
  // Two templates to show: the project's agents saved for the workspace and for the project itself.
  for (const scope of ['workspace', 'project']) await ctx.inv('templates:save', ctx.project, scope, 'Pair', true)
  // The user's name for them, though "Pair" is also a message (a workflow preset's): not English left.
  ctx.authored('Pair', '.template-row, .template-detail-title')
  await ctx.page.locator('.sidebar .load-failed button').first().click()
  await shown(ctx, ctx.page.locator('.sidebar .template-row'), 'the templates')
}

/** The Templates view, one of Combwork's own selected (#1436): Team 3×3, its roles and pairs, read-only. */
async function combworkTemplates(ctx) {
  await showView(ctx, 'view.templates', '.sidebar .template-row')
  await (await shown(ctx, ctx.page.locator('.sidebar .template-row[data-scope="combwork"]'), "Combwork's templates")).nth(3).click()
  await shown(ctx, ctx.page.locator('.template-detail[data-scope="combwork"] .template-agents'), "one of Combwork's templates")
  return windowShot()
}

/** The Templates view, a template selected: what it holds (the workspace's: Combwork's own are listed first). */
async function templates(ctx) {
  await showView(ctx, 'view.templates', '.sidebar .template-row')
  await (await shown(ctx, ctx.page.locator('.sidebar .template-row[data-scope="workspace"]'), 'the templates')).first().click()
  await shown(ctx, ctx.page.locator('.template-detail .template-agents'), 'the template')
  return windowShot()
}

/** Its editor. */
async function templateEditor(ctx) {
  await ctx.page.locator('.template-detail-actions button', { has: ctx.page.locator('.codicon-settings') }).first().click()
  return shown(ctx, ctx.page.locator('.template-editor'), 'the template editor')
}

/** Closes the editor (nothing changed: its Close). */
async function closeEditor(ctx) {
  await ctx.page.locator('.template-editor .template-detail-actions button.subtle').first().click()
  await gone(ctx, ctx.page.locator('.template-editor'), 'the template editor')
}

/** Load into Project…: the project, then the plan (who goes, who comes, as a table). */
async function templateLoad(ctx) {
  await ctx.page.locator('.template-detail-actions button.primary').first().click()
  await (await shown(ctx, ctx.page.locator('.dialog select'), 'the project to load into')).first().selectOption(ctx.project)
  await ctx.page.locator('.dialog button.primary').last().click()
  return shown(ctx, ctx.page.locator('.dialog', { has: ctx.page.locator('.template-plan') }).last(), "the template's plan")
}

/** Deleting a template asks first. */
async function templateDelete(ctx) {
  await iconButton(ctx, '.template-detail-actions', 'trash').click()
  return shown(ctx, ctx.page.locator('.dialog').last(), "the template's delete confirmation")
}

/** A project's Templates tab: its own and the workspace's, one selected. */
async function projectTemplates(ctx) {
  await ctx.command('view.projects')
  await ctx.command('project.tab.templates')
  await (await shown(ctx, ctx.page.locator('.split-list .template-row'), "the project's templates")).first().click()
  await shown(ctx, ctx.page.locator('.split-main .template-detail'), 'the template')
  return ctx.page.locator('.split').first()
}

/** Back to the Session tab for the next area's cases. */
async function closeLast(ctx) {
  await ctx.command('project.tab.session')
}

module.exports = {
  area: 'assistant',
  screens: [
    { name: 'panel', open: panel },
    { name: 'more-menu', open: moreMenu, close: closeMenu },
    { name: 'mode-menu', open: modeMenu, close: closeMenu },
    { name: 'settings', open: settingsDialog, close: cancelDialog },
    { name: 'rail', open: rail },
    { name: 'view', open: assistantView },
    { name: 'mode', open: mode },
    { name: 'new-mode', open: newMode, close: cancelDialog },
    { name: 'skills-failed', open: skillsFailed, close: retrySkills },
    { name: 'skills', open: skills },
    { name: 'skills-refresh-failed', open: skillsRefreshFailed, close: retrySkillsRefresh },
    { name: 'skill-delete', open: skillDelete, close: cancelDialog },
    { name: 'notes', open: notes, close: closeMenu },
    { name: 'new-note', open: newNote, close: cancelDialog },
    { name: 'new-folder', open: newFolder, close: cancelDialog },
    { name: 'mcp', open: mcp },
    { name: 'new-mcp', open: newMcp, close: cancelDialog },
    { name: 'project-menu', open: projectMenu, close: closeMenu },
    { name: 'projects-rail', open: projectsRail, close: expandRail },
    { name: 'templates-failed', open: templatesFailed, close: retryTemplates },
    { name: 'templates-hive', open: combworkTemplates },
    { name: 'templates', open: templates },
    { name: 'template-editor', open: templateEditor, close: closeEditor },
    { name: 'template-load', open: templateLoad, close: cancelDialog },
    { name: 'template-delete', open: templateDelete, close: cancelDialog },
    { name: 'project-templates', open: projectTemplates, close: closeLast }
  ]
}
