// HI-3126 (SPEC §16.9.4, Forward merges): Bring Up to Date… under "The target branch follows its remote", in the window.
// The queue fixture's project (queueFixture.cjs) merging into 1.5.0, 1.4.0 the other branch, both pushed to a bare
// `origin` and tracking it, follow mode on. The local 1.4.0 and 1.5.0 are equal; someone else pushes a hotfix to
// origin/1.4.0 from a clone of their own. 1.5.0's queue card, 0 commits behind locally, still offers Bring Up to Date…;
// chosen and confirmed, its forward card takes the remote's hotfix, merges it through 1.5.0's queue and publishes it:
// origin/1.5.0 has the hotfix. Asked again: up to date. Screenshots of the queue card before and after. Dev build,
// throwaway profile, workspace, remote and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const q = require('./queueFixture.cjs')

const PORT = Number(lib.port(47720))
const fx = q.queueProject('forwardremote')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const waitHung = (fn) => lib.until(fn, HUNG_MS, 200)
const git = (cwd, ...args) => lib.git(cwd, args).trim()
const isIn = (repo, commit, ref) => {
  try {
    lib.git(repo, ['merge-base', '--is-ancestor', commit, ref])
    return true
  } catch {
    return false
  }
}

;(async () => {
  q.prepare(fx)
  const origin = path.join(lib.WORK, 'forwardremote-origin.git')
  const other = path.join(lib.WORK, 'forwardremote-other')
  for (const d of [origin, other]) fs.rmSync(d, { recursive: true, force: true })
  lib.git(lib.WORK, ['init', '-q', '--bare', '-b', 'main', origin])
  lib.git(fx.alpha, ['branch', '1.4.0'])
  lib.git(fx.alpha, ['branch', '1.5.0'])
  lib.git(fx.alpha, ['remote', 'add', 'origin', origin])
  lib.git(fx.alpha, ['push', '-q', '-u', 'origin', 'main', '1.4.0', '1.5.0'])
  lib.git(lib.WORK, ['clone', '-q', origin, other])
  for (const [k, v] of [['user.name', 'Sam Other'], ['user.email', 'sam@example.com'], ['core.autocrlf', 'false']]) lib.git(other, ['config', k, v])
  let h = null
  try {
    h = await q.startCombwork(fx, { port: PORT, keepOptions: true })
    h.page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(h.app, h.page, { width: 1400, height: 900 })
    await h.inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx, { target: '1.5.0', otherTargets: ['1.4.0'], followRemote: true }) })

    // Someone else's hotfix on the release's remote; the local branches stay equal.
    lib.git(other, ['checkout', '-q', '1.4.0'])
    fs.writeFileSync(path.join(other, 'hotfix.txt'), 'hotfix\n')
    lib.git(other, ['add', '-A'])
    lib.git(other, ['commit', '-qm', 'Hotfix on the release'])
    const hotfix = git(other, 'rev-parse', 'HEAD')
    lib.git(other, ['push', '-q', 'origin', '1.4.0'])
    check('the local 1.4.0 and 1.5.0 are equal; only origin/1.4.0 has the hotfix', git(fx.alpha, 'rev-parse', '1.4.0') === git(fx.alpha, 'rev-parse', '1.5.0') && !isIn(fx.alpha, git(fx.alpha, 'rev-parse', '1.5.0'), hotfix) && git(origin, 'rev-parse', '1.4.0') === hotfix)

    const tab = await q.mergesTab(h)
    const card = tab.card('1.5.0')
    const view = async () => (await h.inv('queue:list', fx.alpha, '1.5.0'))[0]
    const fwd = await waitHung(async () => (await view())?.forward)
    check("1.5.0's queue says it follows its remote, 1.4.0 at 0 commits behind locally", fwd?.follows === true && JSON.stringify(fwd?.behind) === '[{"from":"1.4.0","commits":0}]', JSON.stringify(fwd))
    check('…its card shows no "behind" line, and still offers Bring Up to Date…', !!(await waitHung(async () => (await card.locator('[data-action="forward"]').count()) === 1)) && (await card.locator('[data-behind="1.4.0"]').count()) === 0, await tab.text('1.5.0'))
    await h.page.mouse.move(5, 5)
    await card.screenshot({ path: path.join(fx.shots, 'forwardremote-1-offered.png') })

    await card.locator('[data-action="forward"]').click()
    const ask = h.page.locator('.dialog', { hasText: 'Bring 1.5.0 up to date with 1.4.0?' })
    await ask.waitFor({ timeout: HUNG_MS })
    await ask.getByRole('button', { name: 'Queue It' }).click()
    const done = await waitHung(async () => (await h.inv('tasks:list')).find((c) => c.title === 'Bring 1.5.0 up to date with 1.4.0' && c.column === 'done'))
    const integrated = done ? (await h.facts(done.number)).find((f) => f.kind === 'Integrated') : null
    check("the forward card takes the remote's hotfix and merges it through 1.5.0's queue: Done", !!integrated && integrated.data.target === '1.5.0' && integrated.data.revision === hotfix, JSON.stringify(done ? await h.kinds(done.number) : null))
    check('…published: origin/1.5.0 has the hotfix, as a merge commit', isIn(origin, hotfix, '1.5.0') && git(origin, 'rev-list', '--parents', '-n', '1', '1.5.0').split(' ').length === 3, git(origin, 'log', '--oneline', '-3', '1.5.0'))
    check("…and the local 1.4.0 wasn't moved", git(fx.alpha, 'rev-parse', '1.4.0') !== hotfix)

    // Asked again: the remote 1.5.0 has it, so up to date, nothing new.
    const again = await h.inv('queue:forward', fx.alpha, '1.4.0', '1.5.0')
    check('asked again: up to date, nothing queued', again?.upToDate === true && again.queued === false, JSON.stringify(again))
    await h.page.mouse.move(5, 5)
    await card.screenshot({ path: path.join(fx.shots, 'forwardremote-2-merged.png') })
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await h?.app.close().catch(() => undefined)
  }
  console.log(`screenshots: ${fx.shots}`)
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
