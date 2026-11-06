// Screenshot cases for the `files` area (#803): the Files tab (its tree, details, file views, menu and delete dialog),
// the Attachments tab and its viewer, the notes when a search, a load or a refresh fails, and DocEditor (the Memory
// tab's editor), reached for the i18nshots route (#756's design, section 4) with locale-independent means only: files
// written to the project, IPC failures (CW_TEST_FAIL_IPC), command ids and structural hooks (data-rel, data-kind,
// data-action, classes), never English text. See tests/e2e/i18nshots.cjs for ctx.
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
  if (!(await ctx.lib.until(async () => (await locator.count()) === 0, ctx.hungMs))) throw new Error(`${what} stayed open`)
}

/** Closes the dialog on top with its Cancel (the first subtle button, whatever its words). */
async function cancelDialog(ctx) {
  const { page, lib } = ctx
  const cancel = () => page.locator('.dialog').last().locator('button.subtle').first().click({ timeout: 2000 }).then(() => false, () => false)
  if (!(await lib.until(async () => (await page.locator('.dialog').count()) === 0 || (await cancel()), ctx.hungMs))) throw new Error("the dialog didn't close")
}

const ATTACHMENT_SESSION = '0b6a3c1e-5d2f-4e8a-9c71-2f4d6b8e0a13'

/**
 * The project's files, once per window: a git repository with a committed README and src/app.ts (then changed), and
 * untracked data.csv (more rows than its table shows) and logo.bin (binary).
 */
function seedFiles(ctx) {
  const dir = ctx.project
  if (fs.existsSync(path.join(dir, 'data.csv'))) return
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'README.md'), '# Alpha\n\nA project for the screenshots.\n')
  fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const app = 1\n')
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd: dir, env: ctx.lib.gitEnv(), stdio: 'pipe' })
  if (!fs.existsSync(path.join(dir, '.git'))) git('init', '-q')
  git('add', 'README.md', 'src/app.ts')
  git('commit', '-qm', 'init')
  fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const app = 2\n')
  fs.writeFileSync(path.join(dir, 'data.csv'), ['name,count', ...Array.from({ length: 5005 }, (_, i) => `row ${i + 1},${i}`)].join('\n'))
  fs.writeFileSync(path.join(dir, 'logo.bin'), Buffer.from([0, 1, 2, 3, 0, 0, 255, 254]))
}

/** A session's attachments: a picture, a PDF, a text file and one of another kind. */
function seedAttachments(ctx) {
  const dir = path.join(ctx.project, '.combwork', 'attachments', ATTACHMENT_SESSION)
  if (fs.existsSync(dir)) return
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '2026-10-14_09-30-00_screenshot.png'), ctx.lib.samplePng())
  fs.writeFileSync(path.join(dir, '2026-10-14_09-31-00_report.pdf'), '%PDF-1.4\n%%EOF\n')
  fs.writeFileSync(path.join(dir, '2026-10-14_09-32-00_build.log'), 'ok\n')
  fs.writeFileSync(path.join(dir, '2026-10-14_09-33-00_bundle.zip'), Buffer.from([80, 75, 5, 6, 0, 0, 0, 0]))
}

const filesSplit = (ctx) => ctx.page.locator('.split', { has: ctx.page.locator('.files-list') }).first()
const row = (ctx, rel) => ctx.page.locator(`.files-list [data-rel="${rel}"]`).first()

/** The Files tab with nothing selected: the tree (git's colours) and the hint. */
async function filesNone(ctx) {
  seedFiles(ctx)
  await ctx.command('project.tab.files')
  await shown(ctx, row(ctx, 'data.csv'), "the Files tab's tree")
  await shown(ctx, ctx.page.locator('.files-list .git-status'), "the tree's git status")
  return filesSplit(ctx)
}

/** A folder's details (type, modified, git). */
async function filesFolder(ctx) {
  await row(ctx, 'src').click()
  await shown(ctx, ctx.page.locator('.file-details .git-status'), "the folder's details")
  return filesSplit(ctx)
}

/** A CSV file in its table, with more rows than it shows. */
async function filesCsv(ctx) {
  await row(ctx, 'data.csv').click()
  const note = await shown(ctx, ctx.page.locator('.csv-preview .faint'), "the CSV's table and its note")
  // Its note is under the rows it shows.
  await note.first().scrollIntoViewIfNeeded()
  return filesSplit(ctx)
}

/** A binary file: it can only be opened in its app. */
async function filesBinary(ctx) {
  await row(ctx, 'logo.bin').click()
  return shown(ctx, ctx.page.locator('.split-main', { has: ctx.page.locator('.empty-state .hint') }).first(), "the binary file's view")
}

/**
 * Makes calls on an IPC channel fail: the next one (`*1`), or all of them until failing(ctx, '') ends it (unpackaged
 * builds read it as it changes: tests/e2e/README.md).
 */
const failing = (ctx, calls) => ctx.app.evaluate((_, c) => {
  process.env.CW_TEST_FAIL_IPC = c
}, calls)
const failNext = (ctx, channel) => failing(ctx, `${channel}*1`)

/** A search of the Files tab that failed: said in the list, with Retry. */
async function filesFindFailed(ctx) {
  await failNext(ctx, 'files:find')
  await ctx.page.locator('.files-filter input').first().fill('app')
  await shown(ctx, ctx.page.locator('.files-list .load-failed'), "the failed search's note")
  return filesSplit(ctx)
}

async function clearFind(ctx) {
  await ctx.page.locator('.files-filter input').first().fill('')
  await shown(ctx, row(ctx, 'data.csv'), "the Files tab's tree again")
}

/** A file's right-click menu. */
async function filesMenu(ctx) {
  await row(ctx, 'README.md').click({ button: 'right' })
  await shown(ctx, ctx.page.locator('.menu[role="menu"]'), 'the menu')
  return null
}

async function closeMenu(ctx) {
  await ctx.page.keyboard.press('Escape')
  await gone(ctx, ctx.page.locator('.menu[role="menu"]'), 'the menu')
}

/** Deleting a folder asks first. */
async function filesTrash(ctx) {
  await row(ctx, 'src').click()
  await ctx.page.keyboard.press('Delete')
  return shown(ctx, ctx.page.locator('.dialog').last(), 'the delete dialog')
}

/** DocEditor, in the Memory tab: an instructions file that doesn't exist yet, as it would be created. */
async function docEditor(ctx) {
  await ctx.command('project.tab.memory')
  await (await shown(ctx, ctx.page.locator('.split-list .pane-body .row').first(), "the Memory tab's files")).click()
  return shown(ctx, ctx.page.locator('.split-main', { has: ctx.page.locator('.editor-toolbar') }).first(), 'the editor')
}

/** The Attachments tab when they could not be read: said in its place, with Retry. */
async function attachmentsLoadFailed(ctx) {
  await failNext(ctx, 'attachments:list')
  await ctx.command('project.tab.images')
  return shown(ctx, ctx.page.locator('.load-failed').first(), "the Attachments tab's failed load")
}

/** Its Retry (the next read works). */
async function retryLoad(ctx) {
  await ctx.page.locator('.load-failed button').first().click()
  await gone(ctx, ctx.page.locator('.load-failed'), 'the failed load')
}

/** The Attachments tab with none yet. */
async function attachmentsNone(ctx) {
  await ctx.command('project.tab.images')
  return shown(ctx, ctx.page.locator('.empty-state', { has: ctx.page.locator('.hint kbd') }).first(), 'the empty Attachments tab')
}

/** The Attachments tab with a session's attachments of four kinds, and its filters. */
async function attachments(ctx) {
  seedAttachments(ctx)
  const page = ctx.page
  if (!(await ctx.lib.until(async () => (await page.locator('.images-page .thumb').count()) >= 4, ctx.hungMs))) throw new Error(`the Attachments tab shows ${await page.locator('.images-page .thumb').count()} of 4 attachments`)
  return page.locator('.images-page').first()
}

/** A refresh that failed while the attachments shown stay: the note over them, with Retry. */
async function attachmentsRefreshFailed(ctx) {
  // Every read fails until close: a reload the file watcher starts meanwhile can't take the one failure and leave the
  // click's read to succeed.
  await failing(ctx, 'attachments:list')
  await ctx.page.locator('.images-page [data-action="refresh-attachments"]').first().click()
  await shown(ctx, ctx.page.locator('.images-page .load-stale'), "the failed refresh's note")
  return ctx.page.locator('.images-page').first()
}

async function retryRefresh(ctx) {
  await failing(ctx, '')
  await ctx.page.locator('.images-page .load-stale button').first().click()
  await gone(ctx, ctx.page.locator('.images-page .load-stale'), "the failed refresh's note")
}

/** The viewer, on an attachment it has no preview for. */
async function attachmentViewer(ctx) {
  await ctx.page.locator('.images-page .thumb[data-kind="file"]').first().click()
  return shown(ctx, ctx.page.locator('.dialog', { has: ctx.page.locator('.attachment-none') }).last(), 'the attachment viewer')
}

async function closeViewer(ctx) {
  await ctx.page.keyboard.press('Escape')
  await gone(ctx, ctx.page.locator('.dialog'), 'the viewer')
}

/** Deleting a session's attachments asks first. */
async function attachmentsDelete(ctx) {
  await ctx.page.locator('.images-page [data-action="delete-attachments"]').first().click()
  return shown(ctx, ctx.page.locator('.dialog').last(), 'the delete dialog')
}

/** The last screen's Cancel, and back to the Session tab for the next area's cases. */
async function closeLast(ctx) {
  await cancelDialog(ctx)
  await ctx.command('project.tab.session')
}

module.exports = {
  area: 'files',
  screens: [
    { name: 'files-none', open: filesNone },
    { name: 'files-folder', open: filesFolder },
    { name: 'files-csv', open: filesCsv },
    { name: 'files-binary', open: filesBinary },
    { name: 'files-find-failed', open: filesFindFailed, close: clearFind },
    { name: 'files-menu', open: filesMenu, close: closeMenu },
    { name: 'files-trash-dialog', open: filesTrash, close: cancelDialog },
    { name: 'doc-editor', open: docEditor },
    { name: 'attachments-load-failed', open: attachmentsLoadFailed, close: retryLoad },
    { name: 'attachments-none', open: attachmentsNone },
    { name: 'attachments', open: attachments },
    { name: 'attachments-refresh-failed', open: attachmentsRefreshFailed, close: retryRefresh },
    { name: 'attachment-viewer', open: attachmentViewer, close: closeViewer },
    { name: 'attachments-delete-dialog', open: attachmentsDelete, close: closeLast }
  ]
}
