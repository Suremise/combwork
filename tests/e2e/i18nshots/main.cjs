// Screenshot cases for the `main` area (#796): text the main process shows, reached for the i18nshots route
// (tests/e2e/i18nshots.cjs has the case format) with locale-independent means only: IPC, command ids, the notify log,
// stand-ins for native dialogs and structural hooks, never English text. What Windows or Electron draws (a
// notification, a message box) can't be photographed in the window, so its text, as Combwork recorded it, is drawn on the
// page and photographed there; the install-folder message, drawn by Combwork itself to a picture (HIVE_TEST_DIALOG_SNAPSHOT)
// by a start of its own in the language, is shown the same way.
const fs = require('fs')
const path = require('path')
const { spawn, spawnSync } = require('child_process')

/** An AppContainer package's SID, and the entry the install-folder check looks for (as tests/e2e/installdir.cjs). */
const PACKAGE = 'S-1-15-2-1430448594-2639229838-973813799-439329657-1197984847-4069167804-1277922394'
const FOLDER_ENTRY = '*S-1-15-2-1:(OI)(CI)(RX)'
const OVERLAY = 'data-main-shot'

/** Waits for a locator to be on the page; throws saying what didn't show. */
async function shown(ctx, locator, what) {
  if (!(await ctx.lib.until(async () => (await locator.count()) > 0, ctx.hungMs))) throw new Error(`${what} did not show`)
  return locator.first()
}

/** Draws what Combwork said outside the window (each { title, body, buttons }, or a picture) on top of the page. */
async function overlay(ctx, items) {
  await ctx.page.evaluate(
    ([attr, list]) => {
      document.querySelector(`[${attr}]`)?.remove()
      const box = document.createElement('div')
      box.setAttribute(attr, '')
      box.style.cssText = 'position:fixed;left:16px;top:16px;z-index:100000;max-width:760px;padding:16px;border-radius:8px;background:var(--bg-elevated,var(--bg,#222));color:var(--fg,#ddd);box-shadow:0 4px 24px rgba(0,0,0,.4);font:13px/1.45 system-ui'
      for (const it of list) {
        const sec = document.createElement('section')
        sec.style.cssText = 'margin-bottom:12px'
        if (it.png) {
          const img = document.createElement('img')
          img.src = `data:image/png;base64,${it.png}`
          img.style.cssText = 'display:block;max-width:100%'
          sec.append(img)
        }
        for (const [k, v] of [['b', it.title], ['pre', it.body], ['i', (it.buttons ?? []).join(' | ')]]) {
          if (!v) continue
          const el = document.createElement(k)
          el.textContent = v
          el.style.cssText = 'display:block;white-space:pre-wrap;margin:4px 0;font-family:inherit'
          sec.append(el)
        }
        box.append(sec)
      }
      document.body.append(box)
    },
    [OVERLAY, items]
  )
  return shown(ctx, ctx.page.locator(`[${OVERLAY}]`), 'the drawn text')
}

async function removeOverlay(ctx) {
  await ctx.page.evaluate((attr) => document.querySelector(`[${attr}]`)?.remove(), OVERLAY)
}

/** A project's damaged project.json (no good copy to go back to): main's notice that it was set aside. */
async function corruptFile(ctx) {
  const { inv, page } = ctx
  // Notices earlier screens left go first: the one shown then is this one.
  await closeToasts(ctx)
  const dir = path.join(ctx.workspace, 'mainbeta', '.combwork')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'project.json'), '{ not json')
  const old = new Date(Date.now() - 60_000) // damaged a while ago: one changed within 2 s is a save in progress (#1601)
  fs.utimesSync(path.join(dir, 'project.json'), old, old)
  await inv('workspace:refresh')
  return shown(ctx, page.locator('.toasts .toast'), 'the damaged-file notice')
}

async function closeToasts(ctx) {
  const { page, lib } = ctx
  const dismiss = () => page.locator('.toasts .toast .icon-btn').first().click({ timeout: 2000 }).then(() => false, () => false)
  if (!(await lib.until(async () => (await page.locator('.toasts .toast').count()) === 0 || (await dismiss()), ctx.hungMs))) throw new Error("the notices didn't close")
}

/** The live sessions of the first two agents. */
const liveOf = async (ctx) => {
  const live = await ctx.inv('session:live')
  return ctx.agents.slice(0, 2).map((a) => live.find((s) => s.projectPath.toLowerCase() === ctx.project.toLowerCase() && s.agentId === a.id))
}

/** The notify log's entries (the route's, as its test copy writes it). */
async function notes(ctx) {
  const file = await ctx.app.evaluate(() => process.env.HIVE_TEST_NOTIFY_LOG)
  if (!file || !fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

/** Two agents finish together while Combwork is in the background: the Windows notification (main's bursts) it records. */
async function finishedNotification(ctx) {
  const { inv, lib, project } = ctx
  const agents = ctx.agents.slice(0, 2)
  for (const a of agents) await inv('session:start', project, { agentId: a.id })
  if (!(await lib.until(async () => (await liveOf(ctx)).every((s) => s?.status === 'ready'), ctx.hungMs))) throw new Error(`the agents did not start: ${JSON.stringify((await liveOf(ctx)).map((s) => s?.status))}`)
  await ctx.setFocus(false)
  const before = (await notes(ctx)).length
  const prompts = agents.map((a, i) => lib.fakePrompts(inv, lib.ptyKey(project, a.id), async () => (await liveOf(ctx))[i], { home: ctx.claudeHome }))
  const typed = []
  for (const p of prompts) typed.push(await p.type('hello'))
  for (const [i, p] of prompts.entries()) if (!(await p.over(typed[i]))) throw new Error(`${agents[i].name}'s turn did not end`)
  let note = null
  if (!(await lib.until(async () => (note = (await notes(ctx)).slice(before).find((n) => n.kind === 'notification')), ctx.hungMs))) throw new Error('no Windows notification was recorded')
  return overlay(ctx, [note])
}

async function closeFinished(ctx) {
  const { inv, lib, project } = ctx
  await removeOverlay(ctx)
  for (const a of ctx.agents.slice(0, 2)) await inv('session:stop', project, a.id)
  if (!(await lib.until(async () => (await liveOf(ctx)).every((s) => !s || s.status === 'stopped' || s.status === 'exited'), ctx.hungMs))) throw new Error("the agents didn't stop")
}

/** The window stops responding: the question main asks (Electron's message box, recorded by a stand-in). */
async function hangQuestion(ctx) {
  const { app, lib } = ctx
  await app.evaluate(({ dialog }) => {
    globalThis.__mainShotBoxes = []
    globalThis.__mainShotShow ??= dialog.showMessageBox
    dialog.showMessageBox = (_win, o) => {
      globalThis.__mainShotBoxes.push({ title: o.message, body: o.detail, buttons: o.buttons })
      return new Promise((resolve) => o.signal?.addEventListener('abort', () => resolve({ response: 0 })))
    }
  })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('unresponsive'))
  let boxes = []
  if (!(await lib.until(async () => (boxes = await app.evaluate(() => globalThis.__mainShotBoxes)).length > 0, ctx.hungMs))) throw new Error('the question was not asked')
  return overlay(ctx, boxes)
}

async function closeHang(ctx) {
  const { app } = ctx
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('responsive'))
  // Electron's own message box again, for the screens after this one.
  const back = await app.evaluate(({ dialog }) => {
    if (globalThis.__mainShotShow) dialog.showMessageBox = globalThis.__mainShotShow
    return dialog.showMessageBox === globalThis.__mainShotShow
  })
  await removeOverlay(ctx)
  if (!back) throw new Error("the message box wasn't put back")
}

/**
 * Combwork started from a folder whose permissions it can't fix (as tests/e2e/installdir.cjs makes one): the message it
 * shows before it is ready, in the language, drawn to a picture by that start of its own, which then quits.
 */
async function installFolder(ctx) {
  const { lib, lang } = ctx
  const system32 = (...p) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', ...p)
  const icacls = (...args) => spawnSync(system32('icacls.exe'), args, { encoding: 'utf8', windowsHide: true, env: lib.baseEnv() })
  const base = path.join(lib.WORK, `i18nshots-main-${lang}`)
  const locked = path.join(base, 'locked')
  const snapshot = path.join(base, 'message.png')
  const log = path.join(base, 'notify.log')
  fs.rmSync(base, { recursive: true, force: true })
  fs.mkdirSync(locked, { recursive: true })
  icacls(locked, '/grant:r', '*S-1-3-4:(OI)(CI)(RX)', `*${PACKAGE}:(OI)(CI)(RX)`, '/inheritance:r')
  icacls(locked, '/grant', FOLDER_ENTRY)
  const env = lib.hiveEnv({ HIVE_USER_DATA: path.join(base, 'profile'), HIVE_API_PORT: lib.port(47883), HIVE_LANG: lang, HIVE_TEST_INSTALL_DIR: locked, HIVE_TEST_NOTIFY_LOG: log, HIVE_TEST_DIALOG_SNAPSHOT: snapshot })
  const child = spawn(lib.ELECTRON, [lib.ROOT], { cwd: lib.ROOT, env, stdio: 'ignore' })
  let code = null
  child.on('exit', (c) => (code = c ?? -1))
  const ended = await lib.until(async () => code !== null, 60_000)
  if (!ended) child.kill()
  fs.rmSync(locked, { recursive: true, force: true })
  if (!ended) throw new Error('the start from the locked folder did not quit')
  const said = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((n) => n.kind === 'dialog') : null
  if (!said || !fs.existsSync(snapshot)) throw new Error(`no message was recorded and drawn (exit ${code})`)
  return overlay(ctx, [{ png: fs.readFileSync(snapshot).toString('base64') }, said])
}

module.exports = {
  area: 'main',
  screens: [
    { name: 'corrupt-file', open: corruptFile, close: closeToasts },
    { name: 'finished-notification', open: finishedNotification, close: closeFinished },
    { name: 'hang-question', open: hangQuestion, close: closeHang },
    { name: 'install-folder', open: installFolder, close: removeOverlay }
  ]
}
