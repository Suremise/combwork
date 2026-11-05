// P5's scenarios first proven in the app (#1358, SPEC §16.18; their cores in #1349 and #1350): a project set to "Combwork
// merges" into `main` checked out in the project folder (queueFixture.cjs), fake Claude Code agents acting by their own
// tokens, the Assistant off, and a Combwork that sees no global git config (the machine's identity can't stand in for the
// repository's).
// - S13: the queue's warm worktree has a package installed; a change uses it without declaring it in package.json; the
//   install runs from scratch (the project's setup command), the check fails, main doesn't move;
// - S4: two approved changes, each fine alone and broken together: the second's merge checks fail, main doesn't move,
//   the card is returned with the output, in the Merges tab and on the card;
// - S47: no identity → paused, said in the panel, merged once the user sets one and resumes; a commit-msg hook rejecting
//   Combwork's merge commit → returned with its output; a stand-in signer that waits → paused "signing waits for you", the
//   signer ended, merged once signing is off and the queue resumed;
// - S57(e): the user's decision recorded on the card while its merge checks run: nothing advances, back to Review;
// - S14 under Combwork merges (G10): a release card waits on For you (Approve), unqueued; the OK given, merged.
// Screenshots of each, both themes. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const q = require('./queueFixture.cjs')

const PORT = Number(lib.port(47853))
const fx = q.queueProject('p5scenarios')
const HUNG_MS = 60000
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
// Every wait here is bounded only against a hang (#570).
const waitHung = (fn) => lib.until(fn, HUNG_MS, 200)
const f = q.folderHelpers(fx)
const head = () => q.head(fx, 'main')
const slash = (p) => p.replace(/\\/g, '/')

;(async () => {
  q.prepare(fx)
  // The project's packages (S13): left-pad declared and used; node_modules ignored. main only: the target.
  for (const [file, text] of Object.entries({ 'package.json': '{"dependencies":{"left-pad":"1"}}\n', 'index.js': "require('left-pad')\n", '.gitignore': '.combwork/\nnode_modules/\n' })) fs.writeFileSync(path.join(fx.alpha, file), text)
  lib.git(fx.alpha, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'])
  lib.git(fx.alpha, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'packages'])
  // The setup command: node_modules from package.json's dependencies, from scratch (as npm ci would).
  const install = path.join(fx.tools, 'install.js')
  fs.writeFileSync(install, "const fs = require('fs'); fs.rmSync('node_modules', { recursive: true, force: true }); for (const d of Object.keys(JSON.parse(fs.readFileSync('package.json', 'utf8')).dependencies || {})) fs.mkdirSync('node_modules/' + d, { recursive: true })\n")
  // No global or system git config for this Combwork: the repository's identity (the fixture's, until S47 removes it) is all
  // the queue can use.
  const noGlobal = path.join(fx.tools, 'empty.gitconfig')
  fs.writeFileSync(noGlobal, '')
  const h = await q.startHive(fx, { port: PORT, env: { GIT_CONFIG_GLOBAL: noGlobal, GIT_CONFIG_NOSYSTEM: '1' }, keepOptions: true })
  const { page, inv } = h
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(h.app, page, { width: 1400, height: 900 })
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: f.options({ mergeInstall: 'onManifestChange' }) })
    // Quoted, as a user would write a path (#1454: its quotes reach cmd as typed).
    await inv('project:updateConfig', fx.alpha, { worktreeSetup: `node "${install}"` })
    const reviewer = await q.agent(fx, h, 'R1')
    check('the reviewer has its token', !!reviewer.token)
    const column = async (n) => (await h.card(n))?.column
    const keyOf = async (n) => (await h.card(n))?.key
    const lastFailure = async (n) => (await h.facts(n)).filter((x) => x.kind === 'IntegrationFailed').at(-1)
    const returned = (n) => waitHung(async () => ((await column(n)) === 'doing' ? lastFailure(n) : null))
    const done = async (n) => !!(await waitHung(async () => (await column(n)) === 'done'))
    const text = async (loc) => ((await loc.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ')
    const shoot = async (loc, name) => {
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await waitHung(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme)
        await page.mouse.move(5, 5)
        await loc.screenshot({ path: path.join(fx.shots, `p5scenarios-${name}-${theme}.png`) })
      }
      await inv('settings:update', { appearance: { theme: 'dark' } })
    }
    const dialog = page.locator('.dialog').filter({ has: page.locator('.task-title-input') })
    const openCard = async (n) => {
      await q.showBoard(page)
      await q.openByTitle(page, n)
      await waitHung(async () => (await dialog.count()) === 1)
      return dialog.locator('.card-work-queue')
    }
    const closeCard = async () => {
      await page.keyboard.press('Escape')
      await waitHung(async () => (await dialog.count()) === 0)
    }
    const queueFolderOf = () => lib.git(fx.alpha, ['worktree', 'list', '--porcelain']).split(/\r?\n/).filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)).find((p) => /[\\/]queue-[^\\/]+$/.test(p))

    // --- S13: the warm worktree has is-odd; a change drops it from package.json and uses it; the clean install shows it.
    q.checkWith(fx, 'requires', "const fs = require('fs'); const missing = fs.readdirSync('.').filter((f) => f.endsWith('.js')).flatMap((f) => [...fs.readFileSync(f, 'utf8').matchAll(/require\\('([^']+)'\\)/g)].map((m) => m[1])).filter((d) => !fs.existsSync('node_modules/' + d)); if (missing.length) { console.error(\"Cannot find module '\" + missing[0] + \"'\"); process.exit(1) }")
    // The second card is under way before the first merges (as in a lane): the queue keeps its worktree, warm, for it.
    const useOdd = { n: (await inv('tasks:create', { title: 'Use is-odd', project: 'alpha' })).number }
    useOdd.builder = await q.agent(fx, h, `B${useOdd.n}`)
    const useSteps = [await q.startCard(fx, h, useOdd.builder, useOdd.n)]
    const addOdd = await q.approve(fx, h, reviewer, 'Add is-odd', { 'package.json': '{"dependencies":{"left-pad":"1","is-odd":"1"}}\n' })
    check('the first card is approved', Object.values(addOdd.steps).every((x) => x.status === 200), JSON.stringify(addOdd.steps))
    check('S13: the first card (is-odd added to package.json) is merged', await done(addOdd.n), JSON.stringify(await h.kinds(addOdd.n)))
    const warm = queueFolderOf()
    check("…the queue's worktree is kept for the card under way, is-odd installed (warm)", !!warm && fs.existsSync(path.join(warm, 'node_modules', 'is-odd')), warm)
    const beforeUse = head()
    // Its builder brings main in, then drops is-odd from package.json and uses it.
    const who = ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`]
    lib.git(useOdd.builder.folder, [...who, 'merge', '-q', '--no-edit', 'main'])
    fs.writeFileSync(path.join(useOdd.builder.folder, 'package.json'), '{"dependencies":{"left-pad":"1"}}\n')
    fs.writeFileSync(path.join(useOdd.builder.folder, 'odd.js'), "require('is-odd')\n")
    lib.git(useOdd.builder.folder, [...who, 'add', '-A'])
    lib.git(useOdd.builder.folder, [...who, 'commit', '-qm', 'Use is-odd'])
    useSteps.push(await q.intent(h, useOdd.builder, useOdd.n, 'submit', { summary: 'Use is-odd: ready' }), await q.intent(h, reviewer, useOdd.n, 'start-review'), await q.intent(h, reviewer, useOdd.n, 'verdict', { pass: true, comment: 'Use is-odd: passed' }))
    check('the second card is approved', useSteps.every((x) => x.status === 200), JSON.stringify(useSteps))
    const f13 = await returned(useOdd.n)
    check("S13: the change using is-odd undeclared: the install runs from scratch, the check fails (Cannot find module 'is-odd'), returned", f13?.data?.reason === 'checks' && f13.data.transient === false && String(f13.data.log).includes("Cannot find module 'is-odd'"), JSON.stringify(f13))
    check('…main unmoved', head() === beforeUse)
    check('…in the same worktree, installed from scratch: is-odd gone from it', !fs.existsSync(path.join(warm, 'node_modules', 'is-odd')) && fs.existsSync(path.join(warm, 'node_modules', 'left-pad')))
    let part = await openCard(useOdd.n)
    check("…its Work section says so, with the check's output", !!(await waitHung(async () => (await text(part)).includes("Cannot find module 'is-odd'"))), await text(part))
    await shoot(dialog.locator('.card-work'), 's13-returned')
    await closeCard()

    // --- S4: X on and Y on, each fine alone, broken together. Both approved while X's check waits.
    const hold = path.join(fx.tools, 'hold')
    q.checkWith(fx, 'together', `const fs = require('fs'); const on = (f) => fs.existsSync(f) && fs.readFileSync(f, 'utf8').trim() === 'on'; const end = () => { if (on('x.txt') && on('y.txt')) { console.error('x and y are both on: they break each other'); process.exit(1) } process.exit(0) }; const t = Date.now(); const tick = () => (!fs.existsSync(${JSON.stringify(hold)}) || Date.now() - t > 120000 ? end() : setTimeout(tick, 100)); tick()`)
    fs.writeFileSync(hold, '')
    fs.rmSync(fx.started, { force: true })
    const x = await q.approve(fx, h, reviewer, 'X on', { 'x.txt': 'on\n' })
    check("S4: X's merge checks are running", !!(await waitHung(() => fs.existsSync(fx.started))))
    const y = await q.approve(fx, h, reviewer, 'Y on', { 'y.txt': 'on\n' })
    check('…Y is approved meanwhile (both approved, each fine alone)', Object.values(y.steps).every((s) => s.status === 200), JSON.stringify(y.steps))
    fs.rmSync(hold)
    check('…X is merged', await done(x.n), JSON.stringify(await h.kinds(x.n)))
    const afterX = head()
    const f4 = await returned(y.n)
    check("S4: Y's merge checks fail on the combination: returned, not transient, with the output", f4?.data?.reason === 'checks' && f4.data.transient === false && String(f4.data.log).includes('x and y are both on'), JSON.stringify(f4))
    check('…main where X left it', head() === afterX)
    const yKey = await keyOf(y.n)
    const tab = await q.mergesTab(h)
    const yRow = tab.card('main').locator(`.progress-queue-returned[data-entry^="${yKey}/"]`)
    check('…the Merges tab shows Y returned, with Show log', !!(await waitHung(async () => (await yRow.count()) === 1 && (await yRow.locator('[data-action="show-log"]').count()) === 1)), await tab.text('main'))
    await shoot(tab.card('main'), 's4-merges')
    part = await openCard(y.n)
    check("…and its card's Work section, with the output", !!(await waitHung(async () => (await text(part)).includes('x and y are both on'))), await text(part))
    await shoot(dialog.locator('.card-work'), 's4-card')
    await closeCard()
    q.restoreCheck(fx)
    q.steer(fx, 'pass')

    // --- S47 (a): no identity for the repository (and none on the machine for this Combwork): paused, said in the panel.
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: f.options({ identity: null, mergeInstall: 'onManifestChange' }) })
    lib.git(fx.alpha, ['config', '--unset', 'user.name'])
    lib.git(fx.alpha, ['config', '--unset', 'user.email'])
    const beforeId = head()
    const noId = await q.approve(fx, h, reviewer, 'No identity', { 'id.txt': 'id\n' })
    const paused = await waitHung(async () => ((await inv('queue:list', fx.alpha, 'main'))[0]?.paused?.reason === 'identity' ? (await inv('queue:list', fx.alpha, 'main'))[0].paused : null))
    check('S47: no commit identity: the queue pauses (identity), naming the folder; nothing merged, not returned', !!paused && head() === beforeId && (await column(noId.n)) === 'passed' && !(await h.kinds(noId.n)).includes('IntegrationFailed'), JSON.stringify(paused))
    await q.mergesTab(h)
    check('…the panel says why', !!(await waitHung(async () => /no commit identity/.test(await tab.text('main')))), await tab.text('main'))
    await shoot(tab.card('main'), 's47-identity')
    lib.git(fx.alpha, ['config', 'user.name', 'Repo Identity'])
    lib.git(fx.alpha, ['config', 'user.email', 'repo@example.com'])
    await tab.card('main').locator('[data-action="resume"]').click()
    check('…the user sets one and resumes: merged, by that identity', (await done(noId.n)) && lib.git(fx.alpha, ['log', '-1', '--format=%cn <%ce>', 'main']).trim() === 'Repo Identity <repo@example.com>', lib.git(fx.alpha, ['log', '-1', '--format=%cn <%ce>', 'main']))
    // Back to the fixture's identity, the one the later cards commit as with G12 on (HI-2266: G12 reads git's).
    lib.git(fx.alpha, ['config', 'user.name', fx.identity.name])
    lib.git(fx.alpha, ['config', 'user.email', fx.identity.email])

    // --- S47 (b): a commit-msg hook that rejects Combwork's merge commit (its trailers): returned with the hook's output.
    const hook = path.join(fx.alpha, '.git', 'hooks', 'commit-msg')
    fs.writeFileSync(hook, '#!/bin/sh\nif grep -q "Combwork-Card" "$1"; then echo "message rejected by policy: no Hive trailers here" >&2; exit 1; fi\nexit 0\n')
    const beforeHook = head()
    const hooked = await q.approve(fx, h, reviewer, 'Hooked', { 'hook.txt': 'hook\n' })
    const fh = await returned(hooked.n)
    check("S47: a commit-msg hook rejecting the merge commit returns the card (hook) with the hook's output", fh?.data?.reason === 'hook' && String(fh.data.log).includes('message rejected by policy'), JSON.stringify(fh))
    check('…main unmoved, the queue not paused', head() === beforeHook && !(await inv('queue:list', fx.alpha, 'main'))[0]?.paused)
    part = await openCard(hooked.n)
    check("…its Work section shows the hook's output", !!(await waitHung(async () => (await text(part)).includes('message rejected by policy'))), await text(part))
    await shoot(dialog.locator('.card-work'), 's47-hook')
    await closeCard()
    fs.rmSync(hook)

    // --- S47 (c): a stand-in signer that waits as a pinentry would: paused "signing waits for you" within the bound.
    await inv('advanced:set', 'cw.queue.signSeconds', 5)
    const pidFile = path.join(fx.tools, 'signer.pid')
    const waiter = path.join(fx.tools, 'wait.js')
    fs.writeFileSync(waiter, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)\n`)
    const gpg = path.join(fx.tools, 'gpg-waits.sh')
    fs.writeFileSync(gpg, `#!/bin/sh\nexec node "${slash(waiter)}"\n`)
    // The card's own commit made before signing is on (the builder's commit would wait too).
    const n = (await inv('tasks:create', { title: 'Signed', project: 'alpha' })).number
    const builder = await q.agent(fx, h, `B${n}`)
    const signedSteps = [await q.startCard(fx, h, builder, n)]
    fs.writeFileSync(path.join(builder.folder, 'signed.txt'), 'signed\n')
    lib.git(builder.folder, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'add', '-A'])
    lib.git(builder.folder, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'commit', '-qm', 'Signed'])
    lib.git(fx.alpha, ['config', 'commit.gpgsign', 'true'])
    lib.git(fx.alpha, ['config', 'gpg.program', slash(gpg)])
    const beforeSign = head()
    signedSteps.push(await q.intent(h, builder, n, 'submit', { summary: 'Signed: ready' }), await q.intent(h, reviewer, n, 'start-review'), await q.intent(h, reviewer, n, 'verdict', { pass: true, comment: 'Signed: passed' }))
    check('the signed card is approved', signedSteps.every((s) => s.status === 200), JSON.stringify(signedSteps))
    const signing = await waitHung(async () => ((await inv('queue:list', fx.alpha, 'main'))[0]?.paused?.reason === 'signingWaits' ? (await inv('queue:list', fx.alpha, 'main'))[0].paused : null))
    const signer = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0
    const alive = (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    check('S47: a signer that waits: paused "signing waits" naming the card; main unmoved; not returned', !!signing && signing.card === (await keyOf(n)) && head() === beforeSign && (await column(n)) === 'passed', JSON.stringify(signing))
    check('…the waiting signer was ended', signer > 0 && !!(await waitHung(() => !alive(signer))), String(signer))
    await q.mergesTab(h)
    check('…the panel says signing waits for you', !!(await waitHung(async () => /Signing the merge commit waits for you/.test(await tab.text('main')))), await tab.text('main'))
    await shoot(tab.card('main'), 's47-signing')
    lib.git(fx.alpha, ['config', '--unset', 'commit.gpgsign'])
    await tab.card('main').locator('[data-action="resume"]').click()
    check('…signing off and the queue resumed: merged', await done(n), JSON.stringify(await h.kinds(n)))
    await inv('advanced:set', 'cw.queue.signSeconds', null)

    // --- S57(e): the user records a decision on the card while its merge checks run: no advance, back to review.
    q.steer(fx, 'wait')
    const decided = await q.approve(fx, h, reviewer, 'Decided late', { 'late.txt': 'late\n' })
    check('S57(e): its merge checks are running', !!(await waitHung(() => fs.existsSync(fx.started))))
    const beforeDecision = head()
    await openCard(decided.n)
    await dialog.getByLabel('New decision').fill('Keep it behind a flag.')
    await dialog.getByRole('button', { name: 'Add Decision' }).click()
    await waitHung(async () => (await h.card(decided.n))?.decisions?.length === 1)
    await closeCard()
    fs.writeFileSync(fx.go, 'go')
    check('…the checks end, nothing advances: its pass no longer holds, back to Review', !!(await waitHung(async () => (await column(decided.n)) === 'review')) && head() === beforeDecision && !(await h.kinds(decided.n)).includes('Integrated'), JSON.stringify(await h.kinds(decided.n)))
    q.steer(fx, 'pass')

    // --- S14 under Combwork merges (G10): a release card under "your OK for release" waits on For you (Approve), unqueued.
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: f.options({ mergeInstall: 'onManifestChange', okBefore: { mode: 'labels', labels: ['release'] } }) })
    const rn = (await inv('tasks:create', { title: 'Release notes', project: 'alpha', labels: ['release'] })).number
    const rb = await q.agent(fx, h, `B${rn}`)
    const rSteps = [await q.startCard(fx, h, rb, rn)]
    fs.writeFileSync(path.join(rb.folder, 'notes.md'), 'notes\n')
    lib.git(rb.folder, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'add', '-A'])
    lib.git(rb.folder, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'commit', '-qm', 'Release notes'])
    rSteps.push(await q.intent(h, rb, rn, 'submit', { summary: 'notes' }), await q.intent(h, reviewer, rn, 'start-review'), await q.intent(h, reviewer, rn, 'verdict', { pass: true, comment: 'notes: passed' }))
    check('S14: the release card is approved', rSteps.every((s) => s.status === 200), JSON.stringify(rSteps))
    const rKey = await keyOf(rn)
    const beforeOk = head()
    const ok = await f.forYouSection(h, rn)
    check('…it waits for your OK (For you, Approve), not queued', !!(await waitHung(async () => (await text(ok.section)).includes(`${rKey} is approved: OK to merge?`))) && !(await h.kinds(rn)).includes('IntegrationRequested') && head() === beforeOk, await text(ok.section))
    await shoot(ok.section, 's14-ok')
    await ok.section.getByRole('button', { name: 'Approve' }).click()
    check('…the OK given: queued and merged, Done', await done(rn), JSON.stringify(await h.kinds(rn)))
    await closeCard()
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await h.app.close().catch(() => undefined)
  }
  console.log(`screenshots: ${fx.shots}`)
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
