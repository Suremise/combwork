// A project's GitHub link (HI-3550) in Version Control → Workflow → GitHub: its repository read from its remotes on the
// GitHub host (origin first; another remote chosen when several are there; none on another host), and the GitHub CLI's
// sign-in there (signed in as whom, or the command to run, with Check Again). gh is a fake first on the app's PATH,
// its answers set by a file, logging every call: each names its host, and none gets a token. No real gh, no sign-in,
// no network: the remotes are URLs only. Dev build, throwaway profile and workspace; no agent runs.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const HUNG_MS = lib.timing('hang.ui')

const at = (x) => path.join(lib.WORK, `githublink-${x}`)
const userData = at('profile')
const ws = at('ws')
const alpha = path.join(ws, 'alpha')
const ghDir = at('gh')
const stateFile = path.join(ghDir, 'state.txt')
const callLog = path.join(ghDir, 'calls.jsonl')
const shots = at('shots')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 200)

/** The fake gh: `--version`, and `auth status --hostname <h> --json hosts` by the state file (in, out). */
function writeFakeGh() {
  fs.mkdirSync(ghDir, { recursive: true })
  fs.writeFileSync(
    path.join(ghDir, 'gh.cjs'),
    `const fs = require('fs')
const args = process.argv.slice(2)
const keys = Object.keys(process.env).filter((k) => /TOKEN/i.test(k))
fs.appendFileSync(${JSON.stringify(callLog)}, JSON.stringify({ args, keys, ghHost: process.env.GH_HOST ?? null }) + '\\n')
if (args[0] === '--version') { process.stdout.write('gh version 2.83.0 (2026-11-01)\\n'); process.exit(0) }
const state = fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8').trim()
const host = args[args.indexOf('--hostname') + 1]
if (args[0] === 'auth') {
  if (state === 'out') { process.stdout.write(JSON.stringify({ hosts: {} })); process.exit(1) }
  process.stdout.write(JSON.stringify({ hosts: { [host]: [{ state: 'success', active: true, login: 'mona' }] } }))
} else { process.stderr.write('not faked'); process.exit(1) }
`
  )
  fs.writeFileSync(path.join(ghDir, 'gh.cmd'), '@node "%~dp0gh.cjs" %*\r\n')
  fs.writeFileSync(stateFile, 'in')
  fs.writeFileSync(callLog, '')
}
const calls = () => fs.readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

;(async () => {
  for (const d of [userData, ws, ghDir, shots]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(shots, { recursive: true })
  writeFakeGh()
  lib.gitProject(alpha)
  const git = (...a) => execFileSync('git', a, { cwd: alpha, env: lib.gitEnv() })
  git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git')
  git('remote', 'add', 'upstream', 'git@github.com:upstream-org/widgets.git')
  git('remote', 'add', 'work', 'https://git.acme.example/team/app.git')
  // The fake gh first, Node beside it; a token in Combwork's own environment, which gh must never get.
  const env = lib.withPathFirst({ GH_TOKEN: 'ghp_never_given', GITHUB_TOKEN: 'ghp_never_given' }, [ghDir, path.dirname(process.execPath)])
  const h = await lib.launch({ userData, env })
  const { app, page, inv } = h
  const shoot = async (name, loc) => {
    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
      await page.mouse.move(5, 5)
      await loc.screenshot({ path: path.join(shots, `githublink-${name}-${theme}.png`) })
    }
    await inv('settings:update', { appearance: { theme: 'dark' } })
  }
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    await page.getByText('alpha', { exact: true }).first().click()
    await page.locator('.tabs .tab', { hasText: 'Version Control' }).click()
    await page.locator('.git-sections [data-section="workflow"]').click()
    const form = page.locator('.workflow-form')
    await lib.workflowTab(form, 'github')
    const link = form.locator('[data-group="githubLink"]')
    const repoRow = link.locator('[data-github-link="repository"]')
    const cli = link.locator('[data-github-link="cli"]')
    const text = (loc) => loc.innerText().catch(() => '')

    // --- Origin first: acme/widgets on github.com, gh signed in as mona there.
    check("the GitHub tab shows the repository from origin, on github.com", !!(await until(async () => (await link.getAttribute('data-linked')) === 'acme/widgets' && /On github\.com, from the remote origin\./.test(await text(repoRow)), HUNG_MS)), await text(link))
    check('…and gh signed in as mona on github.com, with its version', !!(await until(async () => /Signed in on github\.com as mona\. · gh 2\.83\.0/.test(await text(cli)), HUNG_MS)), await text(cli))
    check('…both github.com remotes offered, origin first; the other host’s left out', JSON.stringify(await repoRow.locator('select option').allInnerTexts()) === JSON.stringify(['origin: acme/widgets', 'upstream: upstream-org/widgets']), JSON.stringify(await repoRow.locator('select option').allInnerTexts()))
    await shoot('1-linked', link)

    // --- Another remote chosen: saved as the project's, the link follows.
    await repoRow.locator('select').selectOption('upstream')
    const cfg = () => JSON.parse(fs.readFileSync(path.join(alpha, '.combwork', 'project.json'), 'utf8'))
    check('choosing upstream links upstream-org/widgets, saved in project.json', !!(await until(async () => (await link.getAttribute('data-linked')) === 'upstream-org/widgets' && cfg().githubRemote === 'upstream', HUNG_MS)), JSON.stringify(cfg().githubRemote))

    // --- Signed out: the command to run, then Check Again finds it signed in.
    fs.writeFileSync(stateFile, 'out')
    await cli.locator('[data-action="gh-check-again"]').click()
    check('signed out: says so, with gh auth login --hostname github.com to copy', !!(await until(async () => (await cli.locator('[data-gh-state="signedOut"]').count()) === 1 && /gh auth login --hostname github\.com/.test(await text(cli)), HUNG_MS)), await text(cli))
    await shoot('2-signed-out', link)
    fs.writeFileSync(stateFile, 'in')
    await cli.locator('[data-action="gh-check-again"]').click()
    check('…Check Again: signed in again', !!(await until(async () => (await cli.locator('[data-gh-state="signedIn"]').count()) === 1, HUNG_MS)), await text(cli))

    // --- The GitHub host set to the company's server: its remote is the link, and gh is asked about that host.
    const hostField = form.locator('[data-github-option="host"] input')
    await hostField.fill('git.acme.example')
    await hostField.press('Enter')
    check('GitHub host git.acme.example: links team/app from the remote work, no list (one remote there)', !!(await until(async () => (await link.getAttribute('data-linked')) === 'team/app' && /On git\.acme\.example, from the remote work\./.test(await text(repoRow)) && (await repoRow.locator('select').count()) === 0, HUNG_MS)), await text(link))
    check('…and gh asked about git.acme.example', !!(await until(async () => /Signed in on git\.acme\.example as mona/.test(await text(cli)), HUNG_MS)), await text(cli))

    // --- A host none of the remotes is on: no link, saying why.
    await hostField.fill('tenant.ghe.com')
    await hostField.press('Enter')
    check('GitHub host tenant.ghe.com: no link, saying no remote is there', !!(await until(async () => (await link.getAttribute('data-linked')) === '' && (await repoRow.locator('[data-github-link-state="none"]').count()) === 1, HUNG_MS)), await text(link))
    await shoot('3-no-link', link)

    // --- Every gh call named its host, and none got a token or GH_HOST.
    const all = calls()
    const auth = all.filter((c) => c.args[0] === 'auth')
    check('every gh auth call names its host with --hostname', auth.length >= 4 && auth.every((c) => c.args.includes('--hostname') && ['github.com', 'git.acme.example', 'tenant.ghe.com'].includes(c.args[c.args.indexOf('--hostname') + 1])), JSON.stringify(auth.map((c) => c.args)))
    check('…no gh call got a token', all.length > 0 && all.every((c) => c.keys.length === 0), JSON.stringify(all.filter((c) => c.keys.length)))
    // GH_HOST only in Copilot's own sign-in check (its agents' environment), naming the very host it asks about.
    check('…and a GH_HOST only ever names the host the call asks about', all.every((c) => c.ghHost === null || c.ghHost === c.args[c.args.indexOf('--hostname') + 1]), JSON.stringify(all.filter((c) => c.ghHost)))
  } catch (e) {
    check('the suite ran to the end', false, e.stack ?? String(e))
    await page.screenshot({ path: at('failed.png') }).catch(() => {})
  } finally {
    await app.close().catch(() => {})
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
