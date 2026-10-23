// Screenshot cases for the `service` area (#850): what main's services say in the window, shown in the run's language:
// advanced.json that can't be read (why, above Settings → Advanced's list) and a file too large for the Changes tab to
// compare (in place of its diff). Reached for the i18nshots route (tests/e2e/i18nshots.cjs has the case format and ctx)
// with locale-independent means only: files in the test profile and project, IPC, command ids and structural hooks
// (classes, data-section, role), never English text; a file's row is found by the name the diff shows for it, which is
// the file's own. Each case's close() puts back what it changed. The area's refusals reach the window through IPC,
// which tests/i18n/service.test.ts checks in another language.
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

/** Waits for a locator to be on the page; throws saying what didn't show. */
async function shown(ctx, locator, what) {
  if (!(await ctx.lib.until(async () => (await locator.count()) > 0, ctx.hungMs))) throw new Error(`${what} did not show`)
  return locator.first()
}

/** Waits for a locator to be gone; throws saying what stayed. */
async function gone(ctx, locator, what) {
  if (!(await ctx.lib.until(async () => (await locator.count()) === 0, ctx.hungMs))) throw new Error(`${what} stayed`)
}

/** advanced.json in the test copy's profile. */
const advancedFile = async (ctx) => path.join((await ctx.inv('app:info')).userData, 'advanced.json')

/** advanced.json that isn't JSON: Settings → Advanced says why above its list, and keeps the values it read before. */
async function advancedFileError(ctx) {
  const { page } = ctx
  fs.writeFileSync(await advancedFile(ctx), '{\n')
  if (!(await page.locator('.settings').count())) await ctx.command('settings.open')
  await (await shown(ctx, page.locator('.settings-nav [data-section="advanced"]'), "Settings' Advanced section in its list")).click()
  await shown(ctx, page.locator('.settings-group[data-section="advanced"] .advanced-note.error[role="alert"]'), "advanced.json's problem")
  // The window: the section's top, with the note (the whole list is far taller than the window).
  return null
}

async function closeAdvancedFileError(ctx) {
  const { page } = ctx
  fs.writeFileSync(await advancedFile(ctx), `${JSON.stringify({ format: 1, values: {}, madeFor: {} }, null, 2)}\n`)
  await gone(ctx, page.locator('.advanced-note.error[role="alert"]'), "advanced.json's problem")
  // Back to the project: its Session tab, as the next cases expect.
  await ctx.command('project.tab.session')
}

const BIG = 'too-big-to-diff.bin'

/** git in the project, with an identity of its own (never the machine's config). */
const git = (ctx, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd: ctx.project, env: ctx.lib.gitEnv(), stdio: 'pipe', encoding: 'utf8' })

/** A file over the Changes tab's 2 MB, uncommitted: in place of its changes, the tab says it is too large to compare. */
async function diffTooLarge(ctx) {
  const { page } = ctx
  if (!fs.existsSync(path.join(ctx.project, '.git'))) {
    git(ctx, 'init', '-q', '-b', 'main')
    git(ctx, 'commit', '-q', '--allow-empty', '-m', 'init')
  }
  fs.writeFileSync(path.join(ctx.project, BIG), Buffer.alloc(3 * 1024 * 1024, 120))
  await ctx.command('project.tab.changes')
  await (await shown(ctx, page.locator('.git-sections [data-section="changes"]'), "the Git tab's sections")).click()
  // The project folder's own changes (the picker's last entry), when there is a picker.
  const picker = page.locator('select.changes-picker')
  if (await picker.count()) await picker.first().selectOption({ index: (await picker.first().locator('option').count()) - 1 })
  const rows = page.locator('.split-list .pane-body .row')
  const shownFile = page.locator('.split-main .editor-toolbar .path strong').first()
  // Each row in turn until the diff shown is the big file's (its name, which is the file's own in every language).
  const opened = await ctx.lib.until(async () => {
    const n = await rows.count()
    for (let i = 0; i < n; i++) {
      await rows.nth(i).click({ timeout: 2000 }).catch(() => undefined)
      if (await ctx.lib.until(async () => ((await shownFile.textContent({ timeout: 500 }).catch(() => null)) ?? '').endsWith(BIG), 1500)) return true
    }
    return false
  }, ctx.hungMs)
  if (!opened) throw new Error('the big file did not show in the Changes tab')
  await shown(ctx, page.locator('.split-main .editor-host .empty-state'), 'the note in place of its changes')
  return page.locator('.split').first()
}

async function closeDiffTooLarge(ctx) {
  fs.rmSync(path.join(ctx.project, BIG), { force: true })
  await ctx.command('project.tab.session')
}

module.exports = {
  area: 'service',
  screens: [
    { name: 'advanced-file-error', open: advancedFileError, close: closeAdvancedFileError },
    { name: 'diff-too-large', open: diffTooLarge, close: closeDiffTooLarge }
  ]
}
