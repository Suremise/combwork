// S28 (#1347, SPEC §16.9.3): two Hives merge into one repository at once, and one waits on the repository lock. Two
// test Hives (their own profiles and ports) each have a project in the same repository: A's the main checkout, B's a
// linked worktree of it, so they share its common git dir and so its lock. A git hook holds A's merge (the lock taken)
// until the test lets it go: B's merge waits, its window saying which Hive holds the repository, and merges once A's is
// done. With B's wait (Settings → Advanced) cut to 1 s, B gives up, changing nothing and naming A. Dev build, fake tier.
// Dev build only (#1580): each Hive's agent is a 0.9 worktree agent (agents:testLegacy, refused by a packaged build),
// with a commit on its branch to merge (S28 isn't one of the packaged checks).
const lib = require('./lib.cjs')
const fs = require('fs')
const net = require('net')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const root = path.join(lib.WORK, 'repolock')
const profileA = path.join(root, 'repolock-a')
const profileB = path.join(root, 'repolock-b')
const wsA = path.join(root, 'ws-a')
const wsB = path.join(root, 'ws-b')
const alpha = path.join(wsA, 'alpha')
const beta = path.join(wsB, 'beta')
const holdDir = path.join(root, 'hold')
const hold = path.join(holdDir, 'hold')
const started = path.join(holdDir, 'started')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const git = (cwd, ...a) => lib.git(cwd, a)
const rev = (ref) => git(alpha, 'rev-parse', ref).trim()
const freePort = () =>
  new Promise((r) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => r(String(p)))
    })
  })

/** A worktree agent of the project with one commit on its branch. */
async function agentWithWork(inv, project, name) {
  const a = await lib.addAgent(inv, project, { name, location: 'new-worktree' })
  fs.writeFileSync(path.join(a.worktree.path, `${name}.txt`), name)
  git(a.worktree.path, 'add', '-A')
  git(a.worktree.path, 'commit', '-qm', `${name}'s work`)
  return a
}

;(async () => {
  for (const d of [root, wsA + '.worktrees', wsB + '.worktrees']) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(holdDir, { recursive: true })
  fs.mkdirSync(wsB, { recursive: true })
  lib.gitProject(alpha)
  git(alpha, 'config', 'user.email', 't@t')
  git(alpha, 'config', 'user.name', 't')
  git(alpha, 'worktree', 'add', '-q', '-b', 'other', beta)
  // Every merge commit in the repository waits here while the hold file is there (its worktrees share the hooks).
  const slash = (p) => p.replace(/\\/g, '/')
  fs.writeFileSync(path.join(alpha, '.git', 'hooks', 'pre-merge-commit'), `#!/bin/sh\necho started > "${slash(started)}"\nwhile [ -f "${slash(hold)}" ]; do sleep 0.1; done\nexit 0\n`)
  for (const p of [profileA, profileB]) lib.enableProviders(p)

  const hives = []
  try {
    const a = await lib.launch({ userData: profileA, env: { HIVE_API_PORT: lib.port(47844) } })
    hives.push(a.app)
    const b = await lib.launch({ userData: profileB, env: { HIVE_API_PORT: await freePort() } })
    hives.push(b.app)
    for (const [h, ws] of [[a, wsA], [b, wsB]]) {
      h.page.on('pageerror', (e) => check('no page errors', false, e.message))
      await lib.openWorkspace(h.inv, h.page, ws)
    }

    // 1. A merges, held in the hook with the lock taken; B merges meanwhile and waits for it.
    const one = await agentWithWork(a.inv, alpha, 'One')
    const two = await agentWithWork(b.inv, beta, 'Two')
    fs.writeFileSync(hold, '')
    const mergeA = a.inv('agents:merge', alpha, one.id, { squash: false, message: 'One into the main branch', cleanup: false })
    check("A's merge is under way (in the hook)", !!(await lib.until(() => fs.existsSync(started), HUNG_MS)))
    const other = rev('other')
    let bDone = false
    const mergeB = b.inv('agents:merge', beta, two.id, { squash: false, message: 'Two into other', cleanup: false }).finally(() => (bDone = true))
    const notice = b.page.locator('.toast', { hasText: 'Another Combwork is merging into this repository (repolock-a)' })
    check("B waits, and its window names A's Combwork", !!(await lib.until(async () => (await notice.count()) > 0, HUNG_MS)), await b.page.locator('.toast').allInnerTexts().catch(() => []).then(String))
    await b.page.screenshot({ path: path.join(lib.WORK, 'repolock-1-waiting.png') })
    check('…B has merged nothing meanwhile', !bDone && rev('other') === other)
    fs.rmSync(hold)
    const ra = await mergeA
    const rb = await mergeB
    check("A's merge ends, with its merge commit", ra.ok && ra.mergeCommit === rev('HEAD'), JSON.stringify(ra))
    check("…then B's, after it", rb.ok && rb.mergeCommit === rev('other') && rev('other') !== other, JSON.stringify(rb))
    check('…both merged', git(alpha, 'show', 'HEAD:One.txt') === 'One' && git(alpha, 'show', 'other:Two.txt') === 'Two')

    // 2. With B's wait cut to 1 s, B gives up while A holds the lock: nothing changed, A named.
    await b.inv('advanced:set', 'cw.merge.lockWaitSeconds', 1)
    fs.writeFileSync(path.join(one.worktree.path, 'One.txt'), 'One again')
    git(one.worktree.path, 'commit', '-qam', 'One again')
    fs.writeFileSync(path.join(two.worktree.path, 'Two.txt'), 'Two again')
    git(two.worktree.path, 'commit', '-qam', 'Two again')
    fs.rmSync(started, { force: true })
    fs.writeFileSync(hold, '')
    const mergeA2 = a.inv('agents:merge', alpha, one.id, { squash: false, message: 'One again', cleanup: false })
    check("A's second merge is under way", !!(await lib.until(() => fs.existsSync(started), HUNG_MS)))
    const before = rev('other')
    const refused = await b.inv('agents:merge', beta, two.id, { squash: false, message: 'Two again', cleanup: false }).then(
      (r) => `merged: ${JSON.stringify(r)}`,
      (e) => String(e?.message ?? e)
    )
    check('B gives up after its wait, naming A, changing nothing', /Another Combwork is merging into this repository \(repolock-a\)\. Nothing was changed/.test(refused) && rev('other') === before, refused)
    fs.rmSync(hold)
    const ra2 = await mergeA2
    check("…A's merge isn't disturbed", ra2.ok && ra2.mergeCommit === rev('HEAD'), JSON.stringify(ra2))
    const rb2 = await b.inv('agents:merge', beta, two.id, { squash: false, message: 'Two again', cleanup: false })
    check('…and B merges once A is done', rb2.ok && git(alpha, 'show', 'other:Two.txt') === 'Two again', JSON.stringify(rb2))
  } catch (e) {
    check('suite ran', false, e?.stack ?? String(e))
  } finally {
    fs.rmSync(hold, { force: true })
    for (const app of hives) await app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS')
  process.exit(failed ? 1 : 0)
})()
