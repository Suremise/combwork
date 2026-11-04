// A project's .combwork kept out of version control (#345): a repository's own info/exclude gets it at once; a project with
// no repository shows the notice in its Overview (which ✕ dismisses) and Project Settings (which always shows it); a
// `git init` made later is excluded at the next refresh, and the notice goes. Exclude refuses where no git repository
// holds the project. A project whose .combwork was committed before (#364) says how many files git still tracks, with the
// command, and Untrack… (after a confirmation listing them) untracks them, leaving them on disk. Dev build, throwaway
// profile and workspace, quiet.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'hivevcs-profile')
const ws = path.join(lib.WORK, 'hivevcs-ws')
const plain = path.join(ws, 'plain')
const repo = path.join(ws, 'repo')
const committed = path.join(ws, 'committed')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const excludeOf = (p) => {
  try {
    return fs.readFileSync(path.join(p, '.git', 'info', 'exclude'), 'utf8')
  } catch {
    return ''
  }
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(plain, { recursive: true })
  fs.writeFileSync(path.join(plain, 'notes.md'), '# Notes\n')
  lib.gitProject(repo)
  // .combwork committed with add -A, before Hive ever excluded it.
  fs.mkdirSync(path.join(committed, '.combwork'), { recursive: true })
  fs.writeFileSync(path.join(committed, '.combwork', 'notes.md'), 'kept by an old Hive')
  lib.gitProject(committed)
  lib.enableProviders(userData)
  const { app, page, inv } = await lib.launch({ userData, viewport: { width: 1300, height: 800 } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, ws)
  const state = async (p) => (await inv('workspace:refresh')).projects.find((x) => x.path.toLowerCase() === p.toLowerCase())?.hiveVcs
  const shot = (name) => page.screenshot({ path: path.join(lib.WORK, `hivevcs-${name}.png`) })

  // --- A repository from the start: excluded at once, and no notice.
  check("a repository's own .combwork is in its info/exclude", /^\/\.combwork\/$/m.test(excludeOf(repo)), excludeOf(repo))
  check('…and reported excluded', JSON.stringify(await state(repo)) === JSON.stringify({ state: 'excluded' }), JSON.stringify(await state(repo)))

  // --- No repository: the Overview and Project Settings say so.
  const plainState = await state(plain)
  check('a project with no repository: reported as none', plainState?.state === 'none', JSON.stringify(plainState))
  await page.getByText('plain', { exact: true }).first().click()
  await page.locator('.tabs .tab', { hasText: 'Overview' }).click()
  const notice = page.locator('.hive-vcs-notice')
  check("the Overview says .combwork isn't excluded", !!(await lib.until(async () => (await notice.count()) === 1, 10000)) && (await notice.innerText()).includes(".combwork isn't excluded from version control"), await notice.innerText().catch(() => ''))
  check('…why it matters, with Learn more and no Exclude (no repository to add it to)', /sessions, transcript backups and launch settings/.test(await notice.innerText()) && (await notice.locator('button', { hasText: 'Learn more' }).count()) === 1 && (await notice.locator('button', { hasText: 'Exclude' }).count()) === 0)
  await shot('overview-dark')
  await inv('settings:update', { appearance: { theme: 'light' } })
  await lib.sleep(300)
  await shot('overview-light')
  await inv('settings:update', { appearance: { theme: 'dark' } })
  // Dismissed in the Overview: gone there, still in Project Settings.
  await notice.locator('button[aria-label^="Don\'t show this here again"]').click()
  check('✕ dismisses it in the Overview', !!(await lib.until(async () => (await notice.count()) === 0, 5000)))
  await lib.openProjectSettings(page)
  check('Project Settings still shows it', !!(await lib.until(async () => (await page.locator('.settings .hive-vcs-notice').count()) === 1, 5000)))
  await shot('settings')
  // Exclude refuses where no git repository holds the project.
  const refused = await inv('project:excludeHive', plain).then(() => null, (e) => String(e?.message ?? e))
  check('Exclude refuses with no repository, saying what to do', !!refused && refused.includes('No git repository holds this project'), refused ?? 'no error')

  // --- git init later: excluded at the next refresh, and the notice goes.
  lib.git(plain, 'init -q')
  check('after git init, the next refresh excludes it', (await state(plain))?.state === 'excluded' && /^\/\.combwork\/$/m.test(excludeOf(plain)), excludeOf(plain))
  check('…and Project Settings no longer shows the notice', !!(await lib.until(async () => (await page.locator('.settings .hive-vcs-notice').count()) === 0, 5000)))
  // Exclude on a repository: nothing to add, nothing repeated.
  await inv('project:excludeHive', plain)
  check('Exclude on an excluded repository adds nothing more', (excludeOf(plain).match(/\/\.combwork\//g) ?? []).length === 1, excludeOf(plain))

  // --- Committed before it was excluded (#364).
  const tracked = await state(committed)
  check('a committed .combwork: excluded, and its tracked files counted', tracked?.state === 'excluded' && tracked.tracked === 1, JSON.stringify(tracked))
  await page.getByText('committed', { exact: true }).first().click()
  await page.locator('.tabs .tab', { hasText: 'Overview' }).click()
  const trackedNotice = page.locator('.hive-vcs-notice', { hasText: 'committed to git' })
  check('the Overview says it is committed, with the command and Untrack…', !!(await lib.until(async () => (await trackedNotice.count()) === 1, 10000)) && (await trackedNotice.innerText()).includes('git rm -r --cached .combwork') && (await trackedNotice.getByRole('button', { name: 'Untrack…' }).count()) === 1, await trackedNotice.innerText().catch(() => ''))
  await shot('tracked-dark')
  await inv('settings:update', { appearance: { theme: 'light' } })
  await lib.sleep(300)
  await shot('tracked-light')
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await trackedNotice.getByRole('button', { name: 'Untrack…' }).click()
  const ask = page.locator('.dialog', { hasText: 'Untrack this file?' })
  check('Untrack… lists the file first', !!(await lib.until(async () => (await ask.count()) === 1, 5000)) && (await ask.innerText()).includes('.combwork/notes.md'), await ask.innerText().catch(() => ''))
  await shot('untrack')
  // A file staged while the question is open isn't one the user agreed to: nothing is untracked, and it says so.
  fs.writeFileSync(path.join(committed, '.combwork', 'later.md'), 'staged after the question')
  lib.git(committed, ['add', '-f', '.combwork/later.md'])
  await ask.getByRole('button', { name: 'Untrack' }).click()
  check('a file staged while the question was open: nothing untracked, saying why', !!(await lib.until(async () => /changed since you were shown them/.test(await ask.innerText().catch(() => '')), 8000)) && lib.git(committed, ['ls-files', '--', '.combwork']).includes('.combwork/later.md') && lib.git(committed, ['ls-files', '--', '.combwork']).includes('.combwork/notes.md'), await ask.innerText().catch(() => ''))
  await ask.getByRole('button', { name: 'Cancel' }).click()
  lib.git(committed, ['rm', '--cached', '-q', '.combwork/later.md'])
  await trackedNotice.getByRole('button', { name: 'Untrack…' }).click()
  await lib.until(async () => (await ask.count()) === 1, 5000)
  await ask.getByRole('button', { name: 'Untrack' }).click()
  check('…untracks it: the notice goes', !!(await lib.until(async () => (await trackedNotice.count()) === 0 && !(await state(committed))?.tracked, 10000)))
  check('…the file stays on disk, its removal staged for the user to commit', fs.existsSync(path.join(committed, '.combwork', 'notes.md')) && /^D  \.combwork\/notes\.md$/m.test(lib.git(committed, ['status', '--porcelain'])), lib.git(committed, ['status', '--porcelain']))

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log(`FAIL ${e.stack || e}`)
  process.exit(1)
})
