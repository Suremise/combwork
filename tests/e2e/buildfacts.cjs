// Builds recorded as facts (#1534, #1062): a fake build script (scripts/buildFact.mjs, as npm run dist and npm run
// release call it) tells a running Combwork of a successful build through the Agent API, and the Assistant view's Journal
// shows it as Combwork's entry; a failed build (no build-info.json) records nothing; Settings → Advanced → Record builds in
// the journal off, Combwork answers that it wrote nothing; with Combwork closed the build is left as a marker in the workspace,
// recorded once when it next opens. No agents. Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { pathToFileURL } = require('url')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const PORT = Number(lib.port(47938))
const userData = path.join(lib.WORK, 'buildfacts-profile')
const ws = path.join(lib.WORK, 'buildfacts-ws')
const repo = path.join(ws, 'hive')
const markers = path.join(ws, '.combwork', 'builds')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/**
 * The fake build: a child Node process that does what dist.mjs does once its build has run: recordDist on the repo (its
 * dist/build-info.json saying whether the build succeeded). api: the Agent API's URL and token, or none (Combwork closed).
 */
function fakeBuild(api) {
  const src = `import { recordDist } from ${JSON.stringify(pathToFileURL(path.join(lib.ROOT, 'scripts', 'buildFact.mjs')).href)}
const line = await recordDist({ root: ${JSON.stringify(repo)}, lines: [${JSON.stringify(`Installer: ${path.join(repo, 'dist', 'Hive-Setup-9.9.9-rc.1.exe')}`)}], kind: 'baseline' })
console.log(line ?? 'nothing recorded')`
  const env = { ...lib.baseEnv(), CW_WORKSPACE: ws, ...(api ? { CW_API_URL: api.url, CW_API_TOKEN_FILE: lib.tokenFile(api.token) } : {}) }
  return execFileSync(process.execPath, ['--input-type=module', '-e', src], { cwd: lib.ROOT, env, encoding: 'utf8' }).trim()
}
const head = () => lib.git(repo, ['rev-parse', 'HEAD']).trim()
const succeeded = () => {
  fs.mkdirSync(path.join(repo, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'dist', 'build-info.json'), JSON.stringify({ version: '9.9.9-rc.1', head: head(), branch: 'main', builtAt: new Date().toISOString() }))
}
const builds = async (inv) => (await inv('journal:browse', { source: 'hive' })).rows.filter((r) => r.summary.startsWith('Built Combwork '))

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(repo)
  let { app, page, inv } = await lib.launch({ userData, env: { HIVE_API_PORT: String(PORT) }, viewport: { width: 1400, height: 900 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    const info = await inv('api:info')
    check('the Agent API is running', info.running && !!info.url, JSON.stringify({ running: info.running, error: info.error }))
    const api = { url: info.url, token: JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token }

    // A failed build leaves no build-info.json: nothing is recorded.
    check('a failed build records nothing', fakeBuild(api) === 'nothing recorded')
    check('…and leaves no marker', !fs.existsSync(markers))

    succeeded()
    const said = fakeBuild(api)
    check('a successful build is recorded through the Agent API', said === "Build recorded in Combwork's journal (baseline).", said)
    const rows = await lib.until(async () => ((await builds(inv)).length === 1 ? builds(inv) : null), HUNG_MS)
    check('the journal has it as a fact by Combwork', !!rows && rows[0].summary === `Built Combwork 9.9.9-rc.1 (baseline) from ${head().slice(0, 8)} on main` && rows[0].source === 'hive', JSON.stringify(rows))
    check('…with no marker left', !fs.existsSync(markers) || fs.readdirSync(markers).length === 0)
    const entry = rows ? await inv('journal:entry', rows[0].id) : null
    check("its detail names the installer, and it links the commit", !!entry && entry.detail.includes('Hive-Setup-9.9.9-rc.1.exe') && entry.links.some((l) => l.type === 'commit' && l.ref === head()), JSON.stringify(entry))

    // The Assistant view's Journal shows it, marked as Combwork's.
    await page.locator('.activity-btn[aria-label="Assistant"]').click()
    await page.locator('.row[data-section="journal"]').click()
    const row = page.locator('.journal .journal-row', { hasText: 'Built Combwork 9.9.9-rc.1 (baseline)' })
    check('Journal → Timeline shows the build', !!(await lib.until(async () => (await row.count()) === 1, HUNG_MS)))
    check("…marked as Combwork's", (await row.locator('.journal-source-mark[aria-label="Combwork"]').count()) === 1)
    await page.screenshot({ path: path.join(lib.WORK, 'buildfacts-journal.png') })

    // Settings → Advanced → Record builds in the journal off: Combwork answers it wrote nothing; no marker either.
    await inv('advanced:set', 'cw.journal.builds', false)
    const off = fakeBuild(api)
    check('with the switch off, Combwork says it wrote nothing', /^Build not recorded in Combwork's journal: Settings → Advanced → Record builds in the journal is off\.$/.test(off), off)
    check('…and nothing was written or left', (await builds(inv)).length === 1 && (!fs.existsSync(markers) || fs.readdirSync(markers).length === 0))
    await inv('advanced:set', 'cw.journal.builds', null)

    // Combwork closed: the build is left as a marker, then recorded once as the workspace opens.
    await app.close()
    app = null
    // Another build (its own time: the same build sent twice is recorded once).
    succeeded()
    const left = fakeBuild(null)
    check('with Combwork closed, the build is left for it', left.startsWith("Build left for Combwork's journal (baseline)"), left)
    check('…as one marker in the workspace', fs.existsSync(markers) && fs.readdirSync(markers).filter((n) => n.endsWith('.json')).length === 1)
    // Opened in German this time: the journal stores the line in English, and the window shows it in the user's language.
    ;({ app, page, inv } = await lib.launch({ userData, env: { HIVE_API_PORT: String(PORT), HIVE_LANG: 'de' }, viewport: { width: 1400, height: 900 } }))
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    check('opening the workspace records it', !!(await lib.until(async () => (await builds(inv)).length === 2, HUNG_MS)), JSON.stringify(await builds(inv)))
    check('…and takes the marker away', !!(await lib.until(() => fs.readdirSync(markers).length === 0, HUNG_MS)), JSON.stringify(fs.readdirSync(markers)))
    await page.locator('.activity-btn[aria-label="Assistent"]').click()
    await page.locator('.row[data-section="journal"]').click()
    const german = page.locator('.journal .journal-row', { hasText: `Combwork 9.9.9-rc.1 (Baseline) aus ${head().slice(0, 8)} auf main gebaut` })
    check('in German, Journal → Timeline shows both builds in German', !!(await lib.until(async () => (await german.count()) === 2, HUNG_MS)), await page.locator('.journal').innerText().catch(() => ''))
    await german.first().locator('.journal-row-main').click()
    const detail = page.locator('.journal-entry .journal-detail')
    check("…and the entry's detail too", !!(await lib.until(async () => /^Installer: .*Hive-Setup-9\.9\.9-rc\.1\.exe\s+Gebaut: /.test(await detail.innerText().catch(() => '')), HUNG_MS)), await detail.innerText().catch(() => ''))
    await page.screenshot({ path: path.join(lib.WORK, 'buildfacts-journal-de.png') })
  } catch (e) {
    check('no unexpected error', false, e.stack)
  } finally {
    if (app) await app.close()
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
  process.exit(failed ? 1 : 0)
})()
