// Screenshot cases for the `git` area (#804): the Git tab without a repository and its Initialise dialog, History
// (commits and tags), Branches & remotes (upstream, branches, remotes, worktrees, commit identity), its forms (each
// checked to follow a change of language while it is open), the failed-load and failed-refresh notes, the operation
// panel of a merge left in conflict and its Abort dialog (HI-3504), the status bar's tooltip and the .combwork notice with its Untrack dialog, reached for the i18nshots route (#756's design, section
// 4) with locale-independent means only: git run on the project, IPC failures (CW_TEST_FAIL_IPC), the
// language-changed event, command ids and structural hooks (data-section, data-action, data-git-*, classes), never
// English text. See tests/e2e/i18nshots.cjs for ctx.
const fs = require('fs')
const { timing } = require('../../timing.cjs')
const path = require('path')
const { execFileSync } = require('child_process')
const { processes, descendantsIn, namesFolder } = require('../folderProcesses.cjs')

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
  const cancel = () => page.locator('.dialog').last().locator('button.subtle').first().click({ timeout: timing('poll.clickMs') }).then(() => false, () => false)
  if (!(await lib.until(async () => (await page.locator('.dialog').count()) === 0 || (await cancel()), ctx.hungMs))) throw new Error("the dialog didn't close")
}

/** Makes calls on an IPC channel fail: the next one (`*1`), or all until failing(ctx, ''): tests/e2e/README.md. */
const failing = (ctx, calls) => ctx.app.evaluate((_, c) => {
  process.env.CW_TEST_FAIL_IPC = c
}, calls)

/** git in the project, with an identity of its own for the commits these cases make (never the machine's config). */
const git = (ctx, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd: ctx.project, env: ctx.lib.gitEnv(), stdio: 'pipe', encoding: 'utf8' })

const gitView = (ctx) => ctx.page.locator('.git-view').first()
const section = async (ctx, id, hook, what) => {
  await gitTab(ctx)
  await ctx.page.locator(`.git-sections [data-section="${id}"]`).first().click()
  return shown(ctx, ctx.page.locator(hook), what)
}

/**
 * The project as a repository with history, once per window (the files area's cases made it one, with a first commit;
 * it is made here if they didn't run): a second commit and a tag, a branch, a remote it tracks (a bare repository
 * beside the workspace) with a commit to push, and an unused worktree.
 */
function seedRepo(ctx) {
  const dir = ctx.project
  if (fs.existsSync(path.join(dir, 'CHANGES.md'))) return
  if (!fs.existsSync(path.join(dir, '.git'))) {
    git(ctx, 'init', '-q', '-b', 'main')
    git(ctx, 'commit', '-q', '--allow-empty', '-m', 'init')
  }
  fs.writeFileSync(path.join(dir, 'CHANGES.md'), '# Changes\n')
  git(ctx, 'add', 'CHANGES.md')
  git(ctx, 'commit', '-qm', 'Add the change log')
  git(ctx, 'tag', '-a', 'v1.0.0', '-m', 'First release')
  git(ctx, 'branch', 'feature/greeting')
  const origin = path.join(path.dirname(ctx.workspace), `${path.basename(ctx.workspace)}-origin.git`)
  if (!fs.existsSync(origin)) execFileSync('git', ['init', '-q', '--bare', origin], { env: ctx.lib.gitEnv(), stdio: 'pipe' })
  git(ctx, 'remote', 'add', 'origin', origin)
  git(ctx, 'push', '-q', '-u', 'origin', 'HEAD')
  fs.writeFileSync(path.join(dir, 'CHANGES.md'), '# Changes\n\n- A greeting\n')
  git(ctx, 'commit', '-qam', 'Note the greeting')
  git(ctx, 'worktree', 'add', '-q', path.join(path.dirname(ctx.workspace), `${path.basename(ctx.workspace)}-wt`), '-b', 'spare')
}

/**
 * What may hold a folder in the project open (HI-3441), for a refused rename's message: the test Combwork's own
 * processes (its git commands) and any other naming the project. Windows refuses to rename a folder while anything has
 * a file or folder inside it open (a git command's index or refs, a directory read, a scan), and says EPERM; a
 * recursive watch on the folder above doesn't count. Not found among them: Combwork's main process itself (its ref
 * reads run on a worker thread there) or a scanner.
 */
function holders(ctx) {
  try {
    const list = processes()
    const pid = ctx.app.process().pid
    const tree = new Set(descendantsIn(list, pid).map((p) => p.pid))
    // Electron's own helpers (GPU, renderer, crash handler: `--type=`) and consoles open nothing in a project.
    const helper = (p) => /\s--type=/.test(p.commandLine) || /\\conhost\.exe/i.test(p.commandLine)
    const named = list.filter((p) => !helper(p) && (tree.has(p.pid) || (p.pid !== process.pid && namesFolder(p.commandLine, ctx.project))))
    return named.length ? named.map((p) => `${p.pid}${tree.has(p.pid) ? ' (Combwork\'s)' : ''}: ${p.commandLine.slice(0, 200)}`).join('; ') : `nothing running beside Combwork's main process (${pid}): it or a scan`
  } catch (e) {
    return `the processes couldn't be listed (${e.message})`
  }
}

/**
 * Renames a folder in the project, waiting until nothing holds it (HI-3441: under load a read of Combwork's could hold
 * .git at that moment): the rename is the check, tried until it lands or the bound passes. A refusal other than a
 * folder held is thrown at once; still held at the bound, it throws naming what was running at the first refusal and
 * at the end. A refusal that lands later is logged, with what was running then, so a run names the holder.
 */
async function renameWhenFree(ctx, from, to) {
  let refused = null
  let first = null
  const done = await ctx.lib.until(() => {
    try {
      fs.renameSync(from, to)
      return true
    } catch (e) {
      if (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES') throw e
      refused ??= { at: Date.now(), code: e.code, n: 0 }
      refused.n++
      first ??= holders(ctx)
      return false
    }
  }, ctx.hungMs)
  const what = `${path.basename(from)} → ${path.basename(to)}`
  if (!done) throw new Error(`renaming ${what} was refused (${refused.code}) ${refused.n} times over ${Date.now() - refused.at} ms: held at the first refusal by ${first}; at the end by ${holders(ctx)}`)
  if (refused) console.log(`renaming ${what} was refused (${refused.code}) ${refused.n} times, then landed after ${Date.now() - refused.at} ms: held at the first refusal by ${first}`)
}

/** The Git tab shown, if it isn't: a case after one that failed before showing it starts from it all the same. */
async function gitTab(ctx) {
  if ((await ctx.page.locator('.git-view').count()) === 0) await ctx.command('project.tab.changes')
  return shown(ctx, gitView(ctx), 'the Git tab')
}

/**
 * The Git tab of a project that isn't a repository: its .git set aside while the screen shows. Its header says the
 * repository is gone, with the offer (#1492: the tab's read has the workspace read again), never a mix.
 */
async function gitSetup(ctx) {
  seedRepo(ctx)
  await renameWhenFree(ctx, path.join(ctx.project, '.git'), path.join(ctx.project, '.git-aside'))
  await ctx.command('project.tab.changes')
  await shown(ctx, ctx.page.locator('[data-git-setup]'), 'the Git tab without a repository')
  await shown(ctx, ctx.page.locator('[data-vc-offer="repositoryGone"]'), 'the offer: the repository gone')
  return gitView(ctx)
}

/** Its Initialise dialog: what it will do, the starter .gitignore, and who it will commit as (the test identity, #1466). */
async function initDialog(ctx) {
  if (!fs.existsSync(path.join(ctx.project, '.git-aside'))) throw new Error("the project's .git wasn't set aside (git-setup didn't reach its screen)")
  await ctx.page.locator('[data-git-setup] [data-git-init]').first().click()
  return shown(ctx, ctx.page.locator('.dialog', { has: ctx.page.locator('[data-git-init-form]') }).last(), 'the Initialise dialog')
}

/** Its Cancel, and the repository back (left where it is if git-setup never set it aside). */
async function closeInit(ctx) {
  await cancelDialog(ctx)
  if (!fs.existsSync(path.join(ctx.project, '.git-aside'))) return
  await renameWhenFree(ctx, path.join(ctx.project, '.git-aside'), path.join(ctx.project, '.git'))
  // The tab reads git again when the window gets focus (as after using a terminal).
  await ctx.page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await gone(ctx, ctx.page.locator('[data-git-setup]'), 'the Git tab without a repository')
  // The workspace read again with it (#1492): settled before the next screen, whose reads it would otherwise start over.
  await gone(ctx, ctx.page.locator('[data-vc-offer]'), 'the offer: the repository gone')
}

/** History when it couldn't be read: said in its place, with Retry. */
async function historyFailed(ctx) {
  await failing(ctx, 'git:history*1')
  await section(ctx, 'history', '.git-view .load-failed', "History's failed load")
  return gitView(ctx)
}

/** Its Retry (the next read works). */
async function retryHistory(ctx) {
  await ctx.page.locator('.git-view .load-failed button').first().click()
  await gone(ctx, ctx.page.locator('.git-view .load-failed'), "History's failed load")
}

/** History: the commits and tags. */
async function history(ctx) {
  await section(ctx, 'history', '[data-git-history] [data-tag]', 'History with its tag')
  return gitView(ctx)
}

/** The pseudo-locale (shared/i18n/languages.ts): every message shows changed from its English. */
const PSEUDO = 'en-XA'

/**
 * Tells the window its language changed, as Settings → General → Language does (the language-changed event). A language
 * with translations (the run's, from app:info) goes by its code, main reading its catalogue: a whole catalogue sent
 * through app.evaluate can crash the test app's main process (lib.speakLanguage, HI-3434). English and the
 * pseudo-locale have none to send.
 */
const sendLanguage = (ctx, language) => ctx.lib.speakLanguage(ctx.app, language)

/**
 * The notices closed. Putting .git back (closeInit) raises "Version control changed in alpha" at the window's bottom
 * right, over the Tags heading's Create tag button: where a language's label is long enough (fr, pl), the button's
 * middle is under it and its click never lands (HI-2601).
 */
async function noNotices(ctx) {
  const { page, lib } = ctx
  const dismiss = () => page.locator('.toasts .toast .icon-btn').first().click({ timeout: timing('poll.clickMs') }).then(() => false, () => false)
  if (!(await lib.until(async () => (await page.locator('.toasts .toast').count()) === 0 || (await dismiss()), ctx.hungMs))) throw new Error("the notices didn't close")
}

/** The window back in the run's language, its switch landed (the page's lang). */
async function restoreLanguage(ctx, info) {
  await sendLanguage(ctx, info)
  if (!(await ctx.lib.until(async () => (await ctx.page.evaluate(() => document.documentElement.lang)) === info.code, ctx.hungMs))) throw new Error(`the window didn't switch back to ${info.code}`)
}

/**
 * A Git form opened in English that then follows the change to the run's language (#804, round 1: an open form keeps
 * no text of its own). It opens with the window switched to English, takes some typing, and is switched back; what
 * was typed must stay. Under the pseudo-locale every message differs from its English, so its title, help, labels and
 * button must each change; a language may rightly keep a word ("URL") or not have it translated yet (English, its
 * fallback), so there only the switch landing (the page's lang) is waited for. Throws otherwise, so the screen isn't
 * reached, with the window switched back to the run's language first, so the screens after it aren't in English
 * (HI-2601). The form is left open in the run's language, for its screenshots.
 */
async function formFollowsLanguage(ctx, action, what) {
  const info = (await ctx.inv('app:info')).language
  if (info.code === 'en') return openFollowing(ctx, action, what, info)
  try {
    return await openFollowing(ctx, action, what, info)
  } catch (e) {
    await restoreLanguage(ctx, info).catch(() => {})
    throw e
  }
}

async function openFollowing(ctx, action, what, info) {
  const { page, lib } = ctx
  const english = info.code === 'en'
  const pseudo = info.code === PSEUDO
  await noNotices(ctx)
  if (!english) await sendLanguage(ctx, { ...info, code: 'en', locale: 'en', messages: {} })
  await page.locator(`[data-action="${action}"]`).first().click()
  const dialog = await shown(ctx, page.locator('.dialog', { has: page.locator('.git-form') }).last(), what)
  if (english) return dialog
  const words = () => dialog.evaluate((d) => [...d.querySelectorAll('.dialog-header, .dialog-body > .hint, .git-form label, .dialog-footer button.primary')].map((e) => e.textContent.trim()))
  const before = await words()
  if (before.length < 4) throw new Error(`${what} shows ${before.length} of its words: ${JSON.stringify(before)}`)
  const box = dialog.locator('.git-form input').first()
  await box.fill('kept-1')
  await sendLanguage(ctx, info)
  let after = []
  const followed = await lib.until(async () => {
    if (!pseudo) return (await page.evaluate(() => document.documentElement.lang)) === info.code
    after = await words()
    return after.length === before.length && after.every((w, i) => w !== before[i])
  }, ctx.hungMs)
  if (!followed) throw new Error(pseudo ? `${what} didn't follow the language: ${JSON.stringify(before)} → ${JSON.stringify(after)}` : `the window didn't switch back to ${info.code}`)
  const kept = await box.inputValue()
  if (kept !== 'kept-1') throw new Error(`${what} lost what was typed: ${JSON.stringify(kept)}`)
  return dialog
}

/** Create tag's form, following a change of language. */
const tagForm = (ctx) => formFollowsLanguage(ctx, 'create-tag', 'the Create tag form')

/** Branches & remotes: the branch and its upstream, branches, remotes, the worktree and the commit identity. */
async function branches(ctx) {
  await section(ctx, 'branches', '[data-git-branches] [data-git-upstream]', 'Branches & remotes with its upstream')
  await shown(ctx, ctx.page.locator('[data-git-branches] [data-worktree-row]'), 'the worktrees')
  return gitView(ctx)
}

/** A refresh that failed while Branches & remotes stays on screen: the note over it, with Retry. */
async function branchesRefreshFailed(ctx) {
  // Every read fails until close, so a read the window starts meanwhile can't take the one failure.
  await failing(ctx, 'git:info')
  await ctx.page.locator('[data-git-branches] [data-action="reload-branches"]').first().click()
  await shown(ctx, ctx.page.locator('.git-view .load-stale'), "the failed refresh's note")
  return gitView(ctx)
}

async function retryBranches(ctx) {
  await failing(ctx, '')
  await ctx.page.locator('.git-view .load-stale button').first().click()
  await gone(ctx, ctx.page.locator('.git-view .load-stale'), "the failed refresh's note")
}

/** New branch's form. */
async function newBranch(ctx) {
  await ctx.page.locator('[data-action="new-branch"]').first().click()
  return shown(ctx, ctx.page.locator('.dialog').last(), 'the New branch form')
}

/** Add a remote's form, following a change of language. */
const addRemote = (ctx) => formFollowsLanguage(ctx, 'add-remote', 'the Add a remote form')

/** Commit identity's form, following a change of language. */
const identityForm = (ctx) => formFollowsLanguage(ctx, 'set-identity', 'the commit identity form')

/**
 * HI-3470's operation panel in Changes: the project folder mid-merge, one file in conflict (a branch and main each
 * changing it). Made from the seeded repository; abortClose ends the merge and drops the branch.
 */
async function operationPanel(ctx) {
  seedRepo(ctx)
  const file = path.join(ctx.project, 'CONFLICT.md')
  fs.writeFileSync(file, 'base\n')
  git(ctx, 'add', 'CONFLICT.md')
  git(ctx, 'commit', '-qm', 'Add a file both sides change')
  const branch = git(ctx, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
  git(ctx, 'switch', '-q', '-c', 'i18n-side')
  fs.writeFileSync(file, 'side\n')
  git(ctx, 'commit', '-qam', 'Side change')
  git(ctx, 'switch', '-q', branch)
  fs.writeFileSync(file, 'main\n')
  git(ctx, 'commit', '-qam', 'Main change')
  try {
    git(ctx, 'merge', '--no-edit', 'i18n-side')
  } catch {
    // The conflict stops it, as wanted: checked below.
  }
  if (!fs.existsSync(path.join(ctx.project, '.git', 'MERGE_HEAD'))) throw new Error("the project folder isn't mid-merge")
  // Branches & remotes read again says so, with Open in Changes (as tests/e2e/slotpool.cjs reaches it).
  await section(ctx, 'branches', '[data-git-branches]', 'Branches & remotes')
  const banner = ctx.page.locator('.banner[data-git-state="merge"]')
  const reload = () => ctx.page.locator('[data-git-branches] [data-action="reload-branches"]').first().click({ timeout: timing('poll.clickMs') }).then(() => false, () => false)
  if (!(await ctx.lib.until(async () => (await banner.count()) > 0 || (await reload()), ctx.hungMs))) throw new Error("Branches & remotes' merge banner did not show")
  await banner.locator('[data-action="open-operation"]').first().click()
  await shown(ctx, ctx.page.locator('.operation-panel[data-operation="merge"] [data-conflict]'), 'the operation panel with its conflict')
  return gitView(ctx)
}

/** Its Abort asks first (HI-3504: the confirm button reads differently from the dialog's Cancel in every language). */
async function abortDialog(ctx) {
  await ctx.page.locator('.operation-panel [data-step="abort"]').first().click()
  return shown(ctx, ctx.page.locator('.dialog').last(), 'the Abort dialog')
}

/** Its confirm button (the dialog's last): the merge ended, the panel gone; then the branch dropped. */
async function abortClose(ctx) {
  const { page, lib } = ctx
  const merging = () => fs.existsSync(path.join(ctx.project, '.git', 'MERGE_HEAD'))
  if ((await page.locator('.dialog').count()) > 0) {
    await page.locator('.dialog').last().locator('.dialog-footer button').last().click()
    if (!(await lib.until(async () => !merging(), ctx.hungMs))) {
      git(ctx, 'merge', '--abort')
      throw new Error("the dialog's Abort didn't end the merge")
    }
  } else if (merging()) git(ctx, 'merge', '--abort')
  try {
    git(ctx, 'branch', '-D', 'i18n-side')
  } catch {
    // Not made (operation-panel stopped before it).
  }
  await ctx.page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await gone(ctx, ctx.page.locator('.operation-panel'), 'the operation panel')
}

/** The status bar's git item, with its tooltip. */
async function statusBar(ctx) {
  const item = await shown(ctx, ctx.page.locator('[data-git-status]').first(), "the status bar's git item")
  await ctx.page.mouse.move(5, 5)
  await item.hover()
  await shown(ctx, ctx.page.locator('.tip:visible'), "its tooltip")
  return null
}

/** The .combwork notice in Project Settings: a file in .combwork committed to git. */
async function combworkNotice(ctx) {
  const { page, inv, project } = ctx
  await page.mouse.move(5, 5)
  fs.mkdirSync(path.join(project, '.combwork'), { recursive: true })
  fs.writeFileSync(path.join(project, '.combwork', 'committed.txt'), 'by mistake\n')
  git(ctx, 'add', '-f', '.combwork/committed.txt')
  git(ctx, 'commit', '-qm', 'Commit a file in .combwork')
  await inv('workspace:refresh')
  await ctx.command('project.tab.settings')
  return shown(ctx, page.locator('.cw-vcs-notice').first(), 'the .combwork notice')
}

/** Its Untrack… asks first, listing the files. */
async function untrackDialog(ctx) {
  await ctx.page.locator('.cw-vcs-notice button.primary').first().click()
  return shown(ctx, ctx.page.locator('.dialog').last(), 'the Untrack dialog')
}

/** Its Cancel, and back to the Session tab for the next area's cases. */
async function closeLast(ctx) {
  await cancelDialog(ctx)
  await ctx.command('project.tab.session')
}

module.exports = {
  area: 'git',
  screens: [
    { name: 'git-setup', open: gitSetup },
    { name: 'init-dialog', open: initDialog, close: closeInit },
    { name: 'history-failed', open: historyFailed, close: retryHistory },
    { name: 'history', open: history },
    { name: 'tag-form', open: tagForm, close: cancelDialog },
    { name: 'branches', open: branches },
    { name: 'branches-refresh-failed', open: branchesRefreshFailed, close: retryBranches },
    { name: 'new-branch-form', open: newBranch, close: cancelDialog },
    { name: 'add-remote-form', open: addRemote, close: cancelDialog },
    { name: 'identity-form', open: identityForm, close: cancelDialog },
    { name: 'operation-panel', open: operationPanel },
    { name: 'abort-dialog', open: abortDialog, close: abortClose },
    { name: 'status-bar', open: statusBar },
    { name: 'combwork-notice', open: combworkNotice },
    { name: 'untrack-dialog', open: untrackDialog, close: closeLast }
  ]
}
