// A project holding .asar files (an Electron app's build output, dist/win-unpacked/resources/app.asar) stays a set of
// plain files to Combwork (#246): Electron's own fs opens an .asar it stats as an archive and keeps it open until the app
// quits, so `npm run dist` couldn't replace it. Storage, the Files tab (listing, watch, find, read), Changes, Attachments and
// image previews (a path inside an archive is refused; a real folder named art.asar is just a folder, #261) go over a project and an agent's worktree with .asar files in
// them, then each file is deleted from outside Combwork.
// The workspace watcher still notices projects coming and going and .combwork changes. Dev build, throwaway profile and
// workspace.
// Dev build only (#1580): it starts this checkout's Electron itself, and Tree is a 0.9 worktree agent
// (agents:testLegacy, refused by a packaged build), whose worktree holds a build.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'asarfiles-profile')
const ws = path.join(lib.WORK, 'asarfiles-ws')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
/** A 1×1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const SAMPLE = path.join(path.dirname(lib.ELECTRON), 'resources', 'default_app.asar')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
/** A folder's size the way Storage counts it: files only (an .asar is a file), links not followed. */
const sizeOf = (p) => {
  const st = fs.lstatSync(p, { throwIfNoEntry: false })
  if (!st) return 0
  if (st.isFile()) return st.size
  if (!st.isDirectory()) return 0
  return fs.readdirSync(p).reduce((n, f) => n + sizeOf(path.join(p, f)), 0)
}
const putAsar = (file) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.copyFileSync(SAMPLE, file)
}
/** Deletes a file from outside Combwork, as a build replacing it would: the error's code if Combwork holds it. */
const deleteFromOutside = (file) => {
  try {
    fs.rmSync(file)
    return fs.existsSync(file) ? 'still there' : null
  } catch (e) {
    return e.code || e.message
  }
}

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha, { 'a.ts': 'export const a = 1\n', '.gitignore': 'dist/\n' })
  const rootAsar = path.join(ws, 'tool.asar')
  const projectRootAsar = path.join(alpha, 'bundle.asar')
  const builtAsar = path.join(alpha, 'dist', 'win-unpacked', 'resources', 'app.asar')
  for (const f of [rootAsar, projectRootAsar, builtAsar]) putAsar(f)
  const asarSize = fs.statSync(SAMPLE).size

  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47921) })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await page.evaluate(() => {
    window.__events = []
    window.combwork.onEvent((e) => window.__events.push(e))
  })

  // An agent's worktree with a build in it, as Claudio's was.
  const tree = await lib.addAgent(inv, alpha, { name: 'Tree', location: 'new-worktree' })
  const treePath = tree.worktree?.path
  check('the worktree agent has a folder', !!treePath && fs.existsSync(treePath), JSON.stringify(tree.worktree))
  const treeAsar = path.join(treePath, 'dist', 'win-unpacked', 'resources', 'app.asar')
  putAsar(treeAsar)

  // Everything that walks or stats a project's files.
  const st = await inv('storage:project', alpha, true)
  const w = st.worktrees.find((x) => x.agent === 'Tree')
  check('Storage counts the worktree, its .asar as a file', !!w && w.bytes === sizeOf(treePath) && w.bytes >= asarSize, `${w?.bytes} vs ${sizeOf(treePath)}`)
  await inv('storage:workspace', true)
  const listed = await inv('files:list', alpha, 'dist/win-unpacked/resources')
  const entry = listed.find((e) => e.name === 'app.asar')
  check('Files lists app.asar as a file with its size', !!entry && !entry.isDir && entry.size === asarSize, JSON.stringify(entry))
  const top = await inv('files:list', alpha, '')
  check('… and bundle.asar at the top', top.some((e) => e.name === 'bundle.asar' && !e.isDir), JSON.stringify(top.map((e) => e.name)))
  const read = await inv('files:read', alpha, 'dist/win-unpacked/resources/app.asar').catch((e) => ({ error: String(e) }))
  check('opening the .asar in Files reads it as a file', !read.error, JSON.stringify(read).slice(0, 200))
  await inv('files:watch', alpha)
  const found = await inv('files:find', alpha, 'asar')
  // dist is ignored by git, which Find leaves out.
  check('Find files finds bundle.asar as a file', found.some((e) => e.name === 'bundle.asar' && !e.isDir), JSON.stringify(found.map((e) => e.relPath)))
  const inside = `combwork-img://img/${encodeURIComponent(path.join(builtAsar, 'icon.png'))}`
  // As an <img>, the way the window shows them (its CSP allows combwork-img: there, not to fetch).
  const shown = await page.evaluate(
    (u) =>
      new Promise((r) => {
        const img = new Image()
        img.addEventListener('load', () => r('loaded'))
        img.addEventListener('error', () => r('refused'))
        img.src = u
      }),
    inside
  )
  check('an image path inside an .asar is refused, not opened', shown === 'refused', shown)
  // A real folder whose name ends in .asar is just a folder (#261): its attachments show and its files open, as do others.
  const artDir = path.join(alpha, 'art.asar')
  fs.mkdirSync(artDir, { recursive: true })
  fs.writeFileSync(path.join(artDir, 'icon.png'), PNG)
  fs.writeFileSync(path.join(artDir, 'notes.md'), '# Art\n')
  fs.writeFileSync(path.join(alpha, 'plain.png'), PNG)
  const show = (file) =>
    page.evaluate(
      (u) =>
        new Promise((r) => {
          const img = new Image()
          img.addEventListener('load', () => r(`loaded ${img.naturalWidth}x${img.naturalHeight}`))
          img.addEventListener('error', () => r('refused'))
          img.src = u
        }),
      `combwork-img://img/${encodeURIComponent(file)}`
    )
  const artShown = await show(path.join(artDir, 'icon.png'))
  check('an image in a real folder named art.asar shows', artShown === 'loaded 1x1', artShown)
  const plainShown = await show(path.join(alpha, 'plain.png'))
  check('… as does one in an ordinary folder', plainShown === 'loaded 1x1', plainShown)
  // HI-2588: the scheme's name before 1.1 is renamed outright: neither registered nor allowed.
  const oldScheme = await page.evaluate(
    (u) =>
      new Promise((r) => {
        const img = new Image()
        img.addEventListener('load', () => r('loaded'))
        img.addEventListener('error', () => r('refused'))
        img.src = u
      }),
    `hive-img://img/${encodeURIComponent(path.join(alpha, 'plain.png'))}`
  )
  check('… and by the old hive-img: scheme it is not shown', oldScheme === 'refused', oldScheme)
  const missingShown = await show(path.join(artDir, 'missing.png'))
  check('… and a missing one is refused', missingShown === 'refused', missingShown)
  const artRead = await inv('file:read', path.join(artDir, 'notes.md')).catch((e) => `error: ${e}`)
  check('a file in art.asar opens', artRead === '# Art\n', JSON.stringify(artRead))
  const artListed = await inv('files:list', alpha, 'art.asar').catch((e) => [{ error: String(e) }])
  check('… and Files lists the folder', artListed.some((e) => e.name === 'icon.png'), JSON.stringify(artListed))
  // Copy Image on a path inside one fails before Electron's image reader (also asar-aware) opens the archive. The file
  // doesn't exist, so the clipboard is never written, even if this regressed.
  const copied = await inv('attachments:copyImage', path.join(projectRootAsar, 'missing.png')).then(() => 'copied', (e) => String(e))
  check('Copy Image refuses a path inside an .asar', /inside \.asar archives/.test(copied), copied)
  await inv('git:status', alpha)
  await inv('git:status', treePath)
  await inv('attachments:list', alpha)
  // The Files tab's watcher sees a change beside them.
  fs.writeFileSync(path.join(alpha, 'dist', 'win-unpacked', 'resources', 'touch.txt'), 'x')
  const seen = await lib.until(() => page.evaluate(() => window.__events.some((e) => e.type === 'files-changed')), 10000)
  check('the Files watcher reports a change beside them', !!seen)

  // Nothing holds them: a build can replace them.
  for (const [name, file] of [
    ['the workspace root', rootAsar],
    ["the project's root", projectRootAsar],
    ["the project's dist", builtAsar],
    ["the worktree's dist", treeAsar]
  ]) {
    const err = deleteFromOutside(file)
    check(`the .asar in ${name} can be deleted while Combwork runs`, !err, err)
  }
  const artErr = deleteFromOutside(path.join(alpha, 'art.asar', 'icon.png'))
  check('the image shown from art.asar can be deleted while Combwork runs', !artErr, artErr)
  let distGone = null
  try {
    fs.rmSync(path.join(alpha, 'dist'), { recursive: true })
  } catch (e) {
    distGone = e.code || e.message
  }
  check("… and the project's build folder too, while Files watches the project", !distGone, distGone)

  // The workspace watcher: projects coming and going (the root), and .combwork changes.
  const eventsOf = (type) => page.evaluate((t) => window.__events.filter((e) => e.type === t), type)
  const hasProject = (name) => async () => (await eventsOf('workspace-changed')).some((e) => e.workspace?.projects?.some((p) => p.name === name))
  fs.mkdirSync(beta)
  check('a new project folder shows', !!(await lib.until(hasProject('beta'), 10000)))
  await page.evaluate(() => (window.__events = []))
  fs.rmSync(beta, { recursive: true })
  const gone = await lib.until(async () => (await eventsOf('workspace-changed')).some((e) => e.workspace && !e.workspace.projects.some((p) => p.name === 'beta')), 10000)
  check('… and goes when it is deleted', !!gone)
  fs.mkdirSync(path.join(ws, '.combwork', 'shared'), { recursive: true })
  fs.writeFileSync(path.join(ws, '.combwork', 'shared', 'outside.md'), '# Written outside Combwork\n')
  check('a shared note written outside Combwork is noticed', !!(await lib.until(async () => (await eventsOf('notes-changed')).length > 0, 10000)))

  await page.screenshot({ path: path.join(lib.WORK, 'asarfiles.png') })
  await app.close()
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
