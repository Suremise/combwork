// HI-3126 (SPEC §16.9.4, Forward merges): Bring Up to Date… under "The target branch follows its remote", in the window.
// The queue fixture's project (queueFixture.cjs) merging into 1.5.0, 1.4.0 the other branch, both pushed to a bare
// `origin` and tracking it, follow mode on. The local 1.4.0 and 1.5.0 are equal; someone else pushes a hotfix to
// origin/1.4.0 from a clone of their own. 1.5.0's queue card, 0 commits behind locally, still offers Bring Up to Date…;
// chosen and confirmed, its forward card takes the remote's hotfix, merges it through 1.5.0's queue and publishes it:
// origin/1.5.0 has the hotfix. Asked again: up to date. HI-3127, fake builders and a reviewer in slots: (B) a card
// returned for a conflict only origin/1.5.0 has names the commit it was tested on, kept at its tested pin, nothing of the
// user's moved; merged in the builder's slot it conflicts, and resolved it merges and is published; (C) a forward that
// comes back for a remote-only conflict, resolved on a builder: the resolution's slot has the remote's 1.5.0, merging the
// forward's source there conflicts, and resolved it merges and is published. Screenshots of the queue card before and after. Dev build,
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
    // No agent works in alpha, so All projects leaves its idle queue out (HI-2165): the user picks it, as the panel offers.
    await tab.panel.locator('select[aria-label="Show the runs of"]').selectOption({ label: 'alpha' })
    const card = tab.card('1.5.0')
    const view = async () => (await h.inv('queue:list', fx.alpha, '1.5.0'))[0]
    const fwd = await waitHung(async () => (await view())?.forward)
    check("1.5.0's queue says it follows its remote, 1.4.0 (and main) at 0 commits behind locally", fwd?.follows === true && JSON.stringify(fwd?.behind) === '[{"from":"1.4.0","commits":0},{"from":"main","commits":0}]', JSON.stringify(fwd))
    check('…its card shows no "behind" line, and still offers Bring Up to Date…', !!(await waitHung(async () => (await card.locator('[data-action="forward"]').count()) === 1)) && (await card.locator('[data-behind="1.4.0"]').count()) === 0, await tab.text('1.5.0'))
    await h.page.mouse.move(5, 5)
    await card.screenshot({ path: path.join(fx.shots, 'forwardremote-1-offered.png') })

    await card.locator('[data-action="forward"]').click()
    // Two sources offered (1.4.0 and main): the choice of branch.
    const ask = h.page.locator('.dialog', { hasText: 'Bring 1.5.0 up to date with…' })
    await ask.waitFor({ timeout: HUNG_MS })
    await ask.getByRole('button', { name: '1.4.0', exact: true }).click()
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

    // --- HI-3127 (B): an ordinary card returned for a conflict only the remote has. Its builder starts it in a slot; then
    // someone else pushes clash.txt to origin/1.5.0; the card adds its own clash.txt.
    const reviewer = await q.agent(fx, h, 'R1')
    const builder = await q.agent(fx, h, 'B1')
    /** Someone else's commit of `file` on origin's `branch`, from their clone: its id. */
    const pushOther = (branch, file, text, message) => {
      lib.git(other, ['fetch', '-q', 'origin'])
      lib.git(other, ['checkout', '-q', '-B', branch, `origin/${branch}`])
      fs.writeFileSync(path.join(other, file), text)
      lib.git(other, ['add', '-A'])
      lib.git(other, ['commit', '-qm', message])
      lib.git(other, ['push', '-q', 'origin', branch])
      return git(other, 'rev-parse', 'HEAD')
    }
    const failedOf = async (n) => (await h.facts(n)).filter((f) => f.kind === 'IntegrationFailed').at(-1)?.data ?? null
    const merges = (folder, rev) => {
      try {
        lib.git(folder, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'merge', '--no-edit', rev])
        return 'clean'
      } catch {
        return lib.git(folder, ['diff', '--name-only', '--diff-filter=U']).trim() || 'failed'
      }
    }
    const commitIn = (folder, files, message) => {
      for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(folder, f), text)
      lib.git(folder, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'add', '-A'])
      lib.git(folder, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'commit', '-qm', message])
    }
    const pass = async (n, what) => (await q.act(fx, h, builder, n, 'submit', { summary: `${what}: ready` })).status === 200 && (await q.act(fx, h, reviewer, n, 'start-review')).status === 200 && (await q.act(fx, h, reviewer, n, 'verdict', { pass: true, comment: `${what}: passed` })).status === 200
    let theirs = null
    const nB = (await h.inv('tasks:create', { title: 'Clash', project: 'alpha' })).number
    const b = await q.approveCard(fx, h, builder, reviewer, nB, 'Clash', { 'clash.txt': 'ours\n' }, { afterStart: () => void (theirs = pushOther('1.5.0', 'clash.txt', 'theirs\n', 'Theirs on 1.5.0')) })
    check('B: the card is started in a slot, submitted and passed', b.steps.start.status === 200 && b.steps.verdict.status === 200, JSON.stringify(b.steps))
    const [local15, tracking15] = [git(fx.alpha, 'rev-parse', '1.5.0'), git(fx.alpha, 'rev-parse', 'refs/remotes/origin/1.5.0')]
    const backB = await waitHung(async () => ((await failedOf(nB))?.reason === 'conflict' ? failedOf(nB) : null))
    check('…returned for the conflict, naming the remote head it was tested on and its branch', backB?.onto === theirs && backB.remote === 'origin/1.5.0', JSON.stringify(backB))
    const keyB = (await h.card(nB)).key
    check('…kept at its tested pin; the local 1.5.0 and origin/1.5.0 tracking ref unmoved', git(fx.alpha, 'rev-parse', `refs/cw/tested/${keyB.toLowerCase()}`) === theirs && git(fx.alpha, 'rev-parse', '1.5.0') === local15 && git(fx.alpha, 'rev-parse', 'refs/remotes/origin/1.5.0') === tracking15)
    check("…in the builder's slot, git merge of the named commit shows the conflict", merges(builder.folder, theirs) === 'clash.txt')
    commitIn(builder.folder, { 'clash.txt': 'ours and theirs\n' }, 'Merge the remote 1.5.0, resolved')
    check('…resolved, submitted and passed again', await pass(nB, 'Clash resolved'))
    check('…merged and published: origin/1.5.0 has the resolution', !!(await waitHung(async () => (await h.card(nB))?.column === 'done')) && git(origin, 'show', '1.5.0:clash.txt') === 'ours and theirs', JSON.stringify(await h.kinds(nB)))

    // --- HI-3127 (C): a forward's resolution. A 1.4.0 fix and a remote-only 1.5.0 commit change fwd.txt both: the
    // forward comes back; Resolve on a builder makes a card, started in a real slot from the remote's 1.5.0.
    pushOther('1.4.0', 'fwd.txt', 'release\n', 'Fix on the release')
    const next = pushOther('1.5.0', 'fwd.txt', 'next\n', 'Next version, remote only')
    const fwdC = await h.inv('queue:forward', fx.alpha, '1.4.0', '1.5.0')
    check('C: the forward is queued', fwdC?.queued === true, JSON.stringify(fwdC))
    const backC = await waitHung(async () => ((await failedOf(fwdC.card))?.reason === 'conflict' ? failedOf(fwdC.card) : null))
    check('…comes back for the conflict with the remote-only 1.5.0, naming it', backC?.onto === next, JSON.stringify(backC))
    const resolution = await h.inv('queue:resolve', fwdC.card, 'by hand')
    check('…Resolve on a builder makes its resolution card', !!resolution?.number, JSON.stringify(resolution))
    const source = (await h.facts(resolution.number)).find((f) => f.kind === 'ForwardResolution')?.data?.source
    const startC = await q.startCard(fx, h, builder, resolution.number)
    check('…started in a slot', startC.status === 200 && !!builder.folder && builder.folder !== fx.alpha, JSON.stringify(startC))
    check("…whose history has the remote's 1.5.0 commit and its file", isIn(builder.folder, next, 'HEAD') && fs.readFileSync(path.join(builder.folder, 'fwd.txt'), 'utf8') === 'next\n')
    check('…and merging the source there shows the conflict', !!source && merges(builder.folder, source) === 'fwd.txt', String(source))
    commitIn(builder.folder, { 'fwd.txt': 'release and next\n' }, 'Merge 1.4.0 into 1.5.0, resolved')
    check('…resolved, submitted and passed', await pass(resolution.number, 'Resolution'))
    check('…merged and published: origin/1.5.0 has the release fix, resolved', !!(await waitHung(async () => (await h.card(resolution.number))?.column === 'done')) && git(origin, 'show', '1.5.0:fwd.txt') === 'release and next' && isIn(origin, source, '1.5.0'), JSON.stringify(await h.kinds(resolution.number)))
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
