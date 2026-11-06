// Tested CLI versions (#365): Provider Setup shows the version this Combwork release was tested with next to the installed one,
// with a tick when they match and a calm note when the installed one is newer or older; nothing when the release names
// none; Copy Diagnostics and provider:info carry it. The fake Claude Code (it reports 2.1.999) against a manifest of the
// suite's own (CW_TEST_TESTED_CLIS, unpackaged builds only), rewritten between checks and read again on Check again.
// Throwaway profile and workspace, quiet; no agent is started.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'testedclis-profile')
const ws = path.join(lib.WORK, 'testedclis-ws')
const home = path.join(lib.WORK, 'testedclis-claude-home')
const manifest = path.join(lib.WORK, 'testedclis-manifest.json')
const NEWER = 'This version came out after this Combwork release was tested. Most updates work; if something behaves oddly, report it (Copy Diagnostics).'
const OLDER = 'Older than tested; consider updating.'
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
/** The manifest naming this version for Claude Code (none: no entry for it). */
const testedWith = (version) => fs.writeFileSync(manifest, JSON.stringify(version ? { 'claude-code': { version, testedAt: '2026-10-07', record: '0123456789ab' } } : {}))

;(async () => {
  for (const d of [userData, ws, home]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(path.join(ws, 'demo'), { recursive: true })
  testedWith('2.1.999')
  const claude = lib.fakeClaude(userData, home)
  // An empty Codex home: Combwork looks for Codex too, and its sign-in check must not read the user's.
  fs.mkdirSync(path.join(lib.WORK, 'testedclis-codex-home'), { recursive: true })
  const { app, page, inv } = await lib.launch({ userData, env: { ...claude, CODEX_HOME: path.join(lib.WORK, 'testedclis-codex-home'), CW_TEST_TESTED_CLIS: manifest }, viewport: { width: 1200, height: 800 } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, ws)
  const info = await lib.waitForProvider(inv)
  // The runner's log of the CLIs this suite's Combwork selected (the run record's real CLIs come from it, #365): the fake
  // Claude Code Combwork found, by its path and version. Only when started by the runner, which gives the log.
  const cliLog = process.env.CW_TEST_CLI_LOG
  if (cliLog) {
    const lines = fs.existsSync(cliLog) ? fs.readFileSync(cliLog, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l)) : []
    check("Combwork notes the CLI it selected for the run record", lines.some((l) => l.provider === 'claude-code' && l.version === '2.1.999' && l.path === info.path), JSON.stringify(lines))
  }
  check('the installed CLI and the tested one are the same', JSON.stringify(info.tested) === JSON.stringify({ version: '2.1.999', testedAt: '2026-10-07', installed: 'same' }), JSON.stringify(info.tested))
  const theme = async (t) => {
    await inv('settings:update', { appearance: { theme: t } })
    await lib.sleep(300)
  }
  const shot = async (name) => {
    await page.screenshot({ path: path.join(lib.WORK, `testedclis-${name}-dark.png`) })
    await theme('light')
    await page.screenshot({ path: path.join(lib.WORK, `testedclis-${name}-light.png`) })
    await theme('dark')
  }

  // --- Provider Setup, through the command palette.
  await page.keyboard.press('Control+Shift+P')
  await lib.sleep(300)
  await page.keyboard.type('Provider Setup')
  await lib.sleep(300)
  await page.keyboard.press('Enter')
  const setup = page.locator('.dialog', { hasText: 'Provider Setup' })
  check('Provider Setup opens', !!(await lib.until(async () => (await setup.count()) === 1, 10000)))
  const line = setup.locator('.setup-tested')
  const shows = async (kind) => !!(await lib.until(async () => (await setup.locator(`.setup-tested[data-tested="${kind}"]`).count()) === 1, 10000))
  check('the same version: "Tested with 2.1.999 · installed 2.1.999" and a tick', (await shows('same')) && (await line.innerText()).trim() === 'Tested with 2.1.999 · installed 2.1.999' && (await line.locator('.setup-tested-ok').count()) === 1, await line.innerText().catch(() => ''))
  await shot('same')

  // Check again reads the manifest again: each case without restarting.
  const again = async (version) => {
    testedWith(version)
    await setup.locator('button', { hasText: 'Check again' }).click()
    await lib.until(async () => !(await inv('provider:info'))['claude-code'].checking, 15000)
  }
  await again('2.1.900')
  check('installed newer than tested: the versions and the calm note, no tick', (await shows('newer')) && (await line.innerText()).includes('Tested with 2.1.900 · installed 2.1.999') && (await line.innerText()).includes(NEWER) && (await line.locator('.setup-tested-ok').count()) === 0, await line.innerText().catch(() => ''))
  check('…nothing is blocked: no error or warning badge for it', (await setup.locator('.badge.warn').count()) === 0, await setup.innerText().catch(() => ''))
  await shot('newer')

  await again('2.2.0')
  check('installed older than tested: "Older than tested; consider updating."', (await shows('older')) && (await line.innerText()).includes('Tested with 2.2.0 · installed 2.1.999') && (await line.innerText()).includes(OLDER), await line.innerText().catch(() => ''))
  await shot('older')
  const diag = await inv('app:diagnostics')
  check('Copy Diagnostics: the tested and installed versions', diag.includes('this Combwork release was tested with 2.2.0 (2026-10-07); installed: older than tested') && /\*\*Claude Code\*\*: on; 2\.1\.999/.test(diag), diag.split('\n').filter((l) => /Claude Code|tested/.test(l)).join(' | '))

  await again(null)
  check('a release that names no tested version: no line', !!(await lib.until(async () => (await line.count()) === 0, 10000)) && (await inv('provider:info'))['claude-code'].tested === null)
  check('…and diagnostics say so', (await inv('app:diagnostics')).includes('no tested version recorded for this Combwork release'))

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
