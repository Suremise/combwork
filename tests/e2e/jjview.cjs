// jj (Jujutsu) in the Version Control tab (HI-2799, J6; SPEC §16.3.5, §16.3.6 "jj in the window and the switch",
// §16.6.5): the real app, the pinned jj (npm run jj:fetch) on its PATH, a throwaway profile and workspace, no CLI agent.
// - Operations (HI-2800, J7): shop's operations by name; a clean one's preview gives its `jj op revert` command, Copy
//   copies it, and a head moved since the preview copies nothing and shows it again; an operation whose bookmark moved
//   again since gives no command, with the later work listed; no preview writes anything.
// - shop: a Git project in a jj repository colocated with Git (made by jj): the fact and the jjFound offer; Git's own
//   sections first (Git's UI kept). The switch to jj refused while a card is in flight (the drain, listed, Check Again),
//   then made: the group named, every gate clear, jj's limits listed. jj's sections: Repository (the unsupported list,
//   Waiting for you to integrate), History (change id beside commit id, divergent, conflicted, working copy), Compare (a
//   divergent change id lists both commits, one picked), Bookmarks (a conflicted one with its sides), Conflicts. The switch's
//   warning says cards run in slots (J9e: a jj card's start is jjwindow's). Back to Git refused (conflicted bookmark and commit), then,
//   once jj's state is fixed, made: Git's sections again.
//   Then (HI-2974) its switch to None, as a fence member, refused while a card is in flight (listed, Check Again), then warned.
// - J9c (HI-2869): the publish records to check and the set-up's leftovers, seeded as
//   J9b2's publish pass and HI-2887's control leave them; Mark as checked after its confirmation (only its resolution
//   written); a leftover proved gone pruned, one still there listed. Waiting's containment and Recover… with a running
//   jj card are jjwindow's.
// - notes: a colocated jj repository whose .gitattributes sets eol: the switch refused, the gate listed.
// - loose: a jj repository not colocated with Git (HI-2896): jj offered and switched to (the gates read through jj's store,
//   all clear), its Repository saying so; back to Git greyed out (no Git working copy), its reason in the tooltip; None,
//   the project's own switch, made. Its header in all seven locales.
// Screenshots of each step in both themes, and the jj sections in all seven locales.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { DatabaseSync } = require('node:sqlite')
const { jjDir, portableJj } = require('../jjPortable.cjs')

const HUNG_MS = 30000
const exe = portableJj()
if (!exe) {
  console.log('SKIP jjview: the pinned jj isn\'t fetched (npm run jj:fetch)')
  process.exit(process.env.CW_JJ_REAL === '1' ? 1 : 0)
}

const work = path.join(lib.WORK, 'jjview')
const userData = path.join(work, 'profile')
const ws = path.join(work, 'ws')
const shop = path.join(ws, 'shop')
const notes = path.join(ws, 'notes')
const loose = path.join(ws, 'loose')
// Beside the suite's other files, so --keep-files keeps them with a passed run.
const shots = lib.WORK
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

// jj's and git's config for the fixtures and the app alike: no user's, no system's (attributes included), no autocrlf.
const home = path.join(work, 'home')
const jjConfig = path.join(home, 'jj.toml')
const gitConfig = path.join(home, 'gitconfig')
const gitEnvOfTools = () => ({ ...lib.gitEnv({ GIT_CONFIG_GLOBAL: gitConfig, GIT_ATTR_NOSYSTEM: '1', XDG_CONFIG_HOME: home, JJ_CONFIG: jjConfig, NO_COLOR: '1' }) })
const jj = (cwd, ...args) => execFileSync(exe, args, { cwd, env: gitEnvOfTools(), windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const id = (cwd, rev, t = 'commit_id') => jj(cwd, '--ignore-working-copy', 'log', '--no-graph', '-r', rev, '-T', t).trim()
const heads = (cwd) => fs.readdirSync(path.join(cwd, '.jj', 'repo', 'op_heads', 'heads'))

function project(dir, cfg) {
  fs.mkdirSync(path.join(dir, '.combwork'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [], ...cfg }))
}

/** A jj repository (colocated unless `loose`), .combwork ignored, with base and main, the bookmark main on main. */
function jjRepo(dir, o = {}) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '.gitignore'), '.combwork/\n')
  jj(dir, 'git', 'init', o.loose ? '--no-colocate' : '--colocate')
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n')
  if (o.attributes) fs.writeFileSync(path.join(dir, '.gitattributes'), '*.txt text eol=lf\n')
  jj(dir, 'commit', '-m', 'base')
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n')
  jj(dir, 'commit', '-m', 'main work')
  jj(dir, 'bookmark', 'set', 'main', '-r', '@-')
}

;(async () => {
  fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(jjConfig, '[user]\nname = "Combwork Test"\nemail = "test@example.invalid"\n[ui]\npaginate = "never"\n')
  fs.writeFileSync(gitConfig, `[user]\n\tname = ${lib.TEST_GIT_IDENTITY.name}\n\temail = ${lib.TEST_GIT_IDENTITY.email}\n[core]\n\tautocrlf = false\n`)

  // shop: a feature line, a change made divergent, and a merge storing a conflict on the bookmark "merged".
  jjRepo(shop)
  jj(shop, 'new', 'main', '-m', 'left')
  fs.writeFileSync(path.join(shop, 'a.txt'), 'left\n')
  jj(shop, 'new', 'main', '-m', 'right')
  fs.writeFileSync(path.join(shop, 'a.txt'), 'right\n')
  jj(shop, 'new', 'description(substring:"left")', 'description(substring:"right")', '-m', 'merge')
  jj(shop, 'bookmark', 'set', 'merged', '-r', '@')
  jj(shop, 'new', 'main', '-m', 'feature')
  fs.writeFileSync(path.join(shop, 'f.txt'), 'feature\n')
  jj(shop, 'new')
  const feature = id(shop, 'description(substring:"feature")')
  const featureChange = id(shop, feature, 'change_id')
  const op = heads(shop)[0]
  jj(shop, '--ignore-working-copy', 'describe', '-r', feature, '-m', 'feature v1')
  jj(shop, '--at-op', op, 'describe', '-r', feature, '-m', 'feature v2')
  jj(shop, 'status')
  const base = id(shop, 'description(substring:"base")')
  project(shop, { platform: 'git', workflow: { platform: 'git', preset: 'solo', options: { finish: 'committed', folder: 'project' } } })
  jjRepo(notes, { attributes: true })
  project(notes, { platform: 'git', workflow: { platform: 'git', preset: null, options: {} } })
  jjRepo(loose, { loose: true })
  project(loose, { platform: 'none' })

  const env = lib.withPathFirst({ ...gitEnvOfTools() }, jjDir())
  delete env.CW_USER_DATA
  const { app, page } = await lib.launch({ userData, env, viewport: { width: 1400, height: 950 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    const text = async (loc) => ((await loc.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()
    const until = (fn, ms) => lib.until(fn, ms, 200)
    await lib.openWorkspace(inv, page, ws)
    const vcTab = page.locator('.tabs .tab', { hasText: 'Version Control' })
    const head = page.locator('[data-vc-head]')
    const offer = page.locator('[data-vc-offer]')
    const dialog = page.locator('.dialog')
    const sections = () => page.locator('.git-sections [role="tab"]').evaluateAll((b) => b.map((x) => x.getAttribute('data-section')))
    const shoot = async (loc, name) => {
      await page.mouse.move(5, 5)
      for (const theme of ['dark', 'light']) {
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
        await loc.screenshot({ path: path.join(shots, `jjview-${name}-${theme}.png`) })
      }
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    }
    const toTab = async (name) => {
      await page.getByText(name, { exact: true }).first().click()
      await vcTab.first().click()
      await until(async () => (await head.count()) === 1, HUNG_MS)
    }
    const section = async (name) => {
      await page.locator(`.git-sections [data-section="${name}"]`).click()
      return page.locator(`[data-jj-section="${name.replace(/^jj/, '').toLowerCase()}"]`)
    }
    // HI-2971's races: the next call on a channel slowed (CW_TEST_SLOW_IPC, dev builds), and the calls main has answered.
    const slowNext = (v) => app.evaluate((_e, x) => void (process.env.CW_TEST_SLOW_IPC = x), v)
    const settled = (channel) => app.evaluate((_e, c) => globalThis.__cwSettledIpc?.[c] ?? 0, channel)
    // Every answer main sent so far has reached the window and been drawn: a call answered after them (the same pipe, in
    // order), then two frames.
    const answered = async () => {
      await inv('app:info')
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))))
    }

    // --- shop as Git: Git's UI kept, jj found and offered.
    await toTab('shop')
    check('shop: Git chosen, jj offered beside None', !!(await until(async () => (await head.locator('[data-platform="git"][aria-checked="true"]').count()) === 1 && (await head.locator('[data-platform="jj"]').count()) === 1, HUNG_MS)), await text(head))
    check("Git's own sections, unchanged", JSON.stringify(await sections()) === JSON.stringify(['workflow', 'changes', 'history', 'branches', 'queue']), JSON.stringify(await sections()))
    check('the jjFound offer: jj found at the root, Switch to jj…', !!(await until(async () => (await offer.getAttribute('data-vc-offer').catch(() => null)) === 'jjFound' && /jj found at/.test(await text(offer)), HUNG_MS)), await text(offer))
    await shoot(page.locator('.vc-view'), 'offer')

    // --- The drain: a card in flight refuses the switch, listed; Check Again reads it again.
    const card = await inv('tasks:create', { title: 'In flight', project: 'shop' })
    const moved = await inv('tasks:move', card.number, 'doing', { confirm: true, reason: 'jjview: a card in flight' })
    check('a card started in shop', !!moved && (await inv('tasks:list')).find((t) => t.number === card.number)?.column === 'doing', JSON.stringify(moved))
    await head.locator('[data-platform="jj"]').click()
    const drained = dialog.filter({ has: page.locator('[data-vc-store-drain]') })
    check('refused while the card is in flight: the drain lists it', !!(await until(async () => (await drained.count()) === 1 && (await text(drained)).includes('In flight'), HUNG_MS)), await text(dialog))
    await shoot(drained, 'drain')
    await inv('tasks:move', card.number, 'done', { confirm: true, reason: 'jjview: done' })
    await drained.getByRole('button', { name: 'Check Again' }).click()

    // --- The switch: the group, the gates, jj's limits.
    const warn = dialog.filter({ has: page.locator('[data-vc-store="jj"]') })
    check('the warning: shop alone in its group, every gate clear, jj’s limits listed', !!(await until(async () => (await warn.count()) === 1 && (await warn.locator('[data-vc-store-drain]').count()) === 0 && (await warn.locator('[data-gate-state="clear"]').count()) === 5 && (await warn.locator('[data-vc-store-unsupported] li').count()) === 5, HUNG_MS)), await text(dialog))
    // J9e (HI-2874): cards run under jj, and the warning says how (no "not yet").
    check('…it says cards run in slots of their own and you integrate', /Cards run in slots of their own, and you integrate the reviewed work yourself/.test(await text(warn)) && !/don.t run in a jj project yet/.test(await text(warn)), await text(warn))
    await shoot(warn, 'switch-to-jj')
    await warn.getByRole('button', { name: 'Switch', exact: true }).click()
    check('shop uses jj: header and project.json', !!(await until(async () => (await head.locator('[data-platform="jj"][aria-checked="true"]').count()) === 1, HUNG_MS)) && JSON.parse(fs.readFileSync(path.join(shop, '.combwork', 'project.json'), 'utf8')).platform === 'jj')
    check("jj's sections", !!(await until(async () => JSON.stringify(await sections()) === JSON.stringify(['workflow', 'jjRepo', 'jjHistory', 'jjCompare', 'jjBookmarks', 'jjConflicts', 'jjOperations']), HUNG_MS)), JSON.stringify(await sections()))

    // --- Repository.
    const repo = await section('jjRepo')
    check('Repository: the root, colocated, the unsupported list (every gate)', !!(await until(async () => (await text(repo)).includes(shop) && /Colocated with Git/.test(await text(repo)) && (await repo.locator('[data-jj-unsupported] li').count()) === 10, HUNG_MS)), await text(repo))
    check('…and Waiting for you to integrate, no merge offered', (await repo.locator('[data-jj-integrate]').count()) === 1 && (await page.locator('[data-action*="merge" i]').count()) === 0)
    await shoot(page.locator('.vc-view'), 'repository')

    // --- J9c (HI-2869): publish records to check and the set-up's leftovers, seeded in the workspace database.
    const pid = JSON.parse(fs.readFileSync(path.join(shop, '.combwork', 'project.json'), 'utf8')).id
    check('shop has its canonical id', typeof pid === 'string' && pid.length > 0, String(pid))
    const kept = path.join(work, 'leftover-kept')
    const gone = path.join(work, 'leftover-gone')
    fs.mkdirSync(path.join(kept, 'ws'), { recursive: true })
    fs.writeFileSync(path.join(kept, 'ws', 'notes.txt'), 'a note of the user\'s\n')
    const C = (c) => c.repeat(40)
    const db = new DatabaseSync(path.join(ws, '.combwork', 'combwork.db'), { timeout: 5000 })
    try {
      const seen = JSON.stringify({ remote: 'origin', url: 'https://example.invalid/shop.git', pushed: C('1'), head: C('1'), op: 'a'.repeat(128), print: 'p', at: Date.now() - 3600e3 })
      const flag = db.prepare(`INSERT INTO jj_obligations (project, card, cycle, bundle, target, result, since, state, pushed, at, seq, seen, "check") VALUES (?, ?, 1, ?, 'main', ?, 1, 'checkThis', ?, 5, 1, ?, ?)`)
      flag.run(pid, 'SHOP-1', 'b1shop1', C('1'), C('1'), seen, JSON.stringify({ was: 'published', differs: [{ what: 'pushed', was: C('1'), now: C('2') }], at: 100 }))
      flag.run(pid, 'SHOP-2', 'b1shop2', C('3'), C('3'), seen, JSON.stringify({ was: 'notHeld', differs: [{ what: 'held', was: 'no', now: 'yes' }], at: 101 }))
      const control = { phase: 'idle', residues: [{ path: kept, why: 'notEmpty' }, { path: gone, name: 'cw-0000-control-gone', why: 'lost' }] }
      db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(`jj_control:${shop.toLowerCase()}`, JSON.stringify(control))
    } finally {
      db.close()
    }
    await section('jjHistory')
    const repo2 = await section('jjRepo')
    const toCheck = repo2.locator('[data-jj-to-check]')
    check('Publish records to check: both, each with what differs', !!(await until(async () => (await toCheck.locator('[data-jj-to-check-row]').count()) === 2 && /now has 2222222/.test(await text(toCheck)) && /back in its target/.test(await text(toCheck)), HUNG_MS)), await text(toCheck))
    const leftovers = repo2.locator('[data-jj-leftovers]')
    check('Leftovers: the one still there listed, the one proved gone pruned', !!(await until(async () => JSON.stringify(await leftovers.locator('[data-jj-leftover]').evaluateAll((l) => l.map((x) => x.getAttribute('data-jj-leftover')))) === JSON.stringify([kept]), HUNG_MS)), await text(leftovers))
    const control = (() => {
      const r = new DatabaseSync(path.join(ws, '.combwork', 'combwork.db'), { readOnly: true })
      try {
        return JSON.parse(r.prepare('SELECT value FROM board_meta WHERE key = ?').get(`jj_control:${shop.toLowerCase()}`).value)
      } finally {
        r.close()
      }
    })()
    check('…the journal keeps the kept one only', control.residues.length === 1 && control.residues[0].path === kept && fs.existsSync(kept), JSON.stringify(control))
    // The switch's notices would cover the panels: hidden for their shots (the window's own, as is).
    const quiet = await page.addStyleTag({ content: '.toasts { display: none !important; }' })
    await shoot(toCheck, 'to-check')
    await shoot(leftovers, 'leftovers')
    await quiet.evaluate((el) => el.remove())
    await toCheck.locator('[data-jj-to-check-row="SHOP-1"] [data-jj-mark-checked]').click()
    const ask = dialog.filter({ hasText: 'Mark SHOP-1 as checked?' })
    check('Mark as checked asks first, saying nothing changes in the repository', !!(await until(async () => (await ask.count()) === 1 && /changes nothing in the repository/.test(await text(ask)), HUNG_MS)), await text(dialog))
    await shoot(ask, 'mark-checked')
    await ask.getByRole('button', { name: 'Mark as checked', exact: true }).click()
    check('…then SHOP-1 leaves the list, SHOP-2 stays', !!(await until(async () => (await toCheck.locator('[data-jj-to-check-row]').count()) === 1 && (await toCheck.locator('[data-jj-to-check-row="SHOP-2"]').count()) === 1, HUNG_MS)), await text(toCheck))
    const marked = (() => {
      const r = new DatabaseSync(path.join(ws, '.combwork', 'combwork.db'), { readOnly: true })
      try {
        return r.prepare('SELECT state, seen, "check" AS c FROM jj_obligations WHERE project = ? AND card = ?').get(pid, 'SHOP-1')
      } finally {
        r.close()
      }
    })()
    const mc = JSON.parse(marked.c)
    check('…only its resolution written: still checkThis, seen and the differences kept', marked.state === 'checkThis' && mc.resolvedAt > 0 && mc.differs.length === 1 && JSON.parse(marked.seen).remote === 'origin', JSON.stringify(marked))

    // --- History: change id beside commit id, divergent, conflicted, working copy.
    const hist = await section('jjHistory')
    check('History: the feature’s two variants divergent, each with the change id and its own commit id', !!(await until(async () => (await hist.locator(`[data-change="${featureChange}"]`).count()) >= 2 && (await hist.locator('[data-jj-badge="divergent"]').count()) >= 2, HUNG_MS)), await text(hist))
    check('…a conflicted commit and the working copy', (await hist.locator('[data-jj-badge="conflict"]').count()) >= 1 && /working copy/.test(await text(hist)))
    await shoot(page.locator('.vc-view'), 'history')

    // --- Compare: an ambiguous change id lists both commits; one picked.
    const cmp = await section('jjCompare')
    await cmp.locator('[data-jj-from]').fill(base)
    await cmp.locator('[data-jj-to]').fill(featureChange)
    await cmp.locator('[data-action="jj-compare"]').click()
    const amb = cmp.locator('[data-jj-resolve="to"][data-jj-resolve-state="ambiguous"]')
    check('Compare: the divergent change id names 2 commits, none picked', !!(await until(async () => (await amb.count()) === 1 && (await amb.locator('[data-action="jj-pick"]').count()) === 2, HUNG_MS)), await text(cmp))
    await shoot(page.locator('.vc-view'), 'compare-ambiguous')
    await amb.locator('[data-action="jj-pick"]').first().click()
    await cmp.locator('[data-action="jj-compare"]').click()
    check('…one picked by its commit id: what changed', !!(await until(async () => (await cmp.locator('[data-jj-compare-result]').count()) === 1 && /f\.txt/.test(await text(cmp.locator('[data-jj-files]'))), HUNG_MS)), await text(cmp))
    await shoot(page.locator('.vc-view'), 'compare')

    // --- Bookmarks and Conflicts.
    const bm = await section('jjBookmarks')
    check('Bookmarks: main, merged, read only', !!(await until(async () => (await bm.locator('[data-jj-bookmark="main"]').count()) >= 1 && (await bm.locator('[data-jj-bookmark="merged"]').count()) >= 1, HUNG_MS)), await text(bm))
    await shoot(page.locator('.vc-view'), 'bookmarks')
    const cf = await section('jjConflicts')
    check('Conflicts: the merge, with a.txt', !!(await until(async () => (await cf.locator('[data-jj-conflicts] > li').count()) >= 1 && /a\.txt/.test(await text(cf)), HUNG_MS)), await text(cf))
    await shoot(page.locator('.vc-view'), 'conflicts')

    // --- Operations (HI-2800): by name, a preview of undoing one, the command only when nothing else would change.
    jj(shop, 'bookmark', 'create', 'opdemo', '-r', base)
    const clean = heads(shop)[0]
    jj(shop, 'bookmark', 'create', 'moved', '-r', base)
    const overlapped = heads(shop)[0]
    jj(shop, 'bookmark', 'set', 'moved', '-r', feature, '--allow-backwards')
    const ops = await section('jjOperations')
    await ops.locator('[data-action="jj-refresh"]').click()
    check('Operations: each by the name jj gave it', !!(await until(async () => (await ops.locator(`[data-jj-op="${clean}"]`).count()) === 1 && /create bookmark opdemo/.test(await text(ops.locator(`[data-jj-op="${clean}"]`))), HUNG_MS)), await text(ops))
    const before = JSON.stringify(heads(shop))
    await ops.locator(`[data-jj-op="${clean}"] [data-action="jj-op-preview"]`).click()
    const cleanPreview = ops.locator(`[data-jj-op-preview="${clean}"][data-jj-refused=""]`)
    check('…a clean one: what it changed, and its jj op revert command', !!(await until(async () => (await cleanPreview.count()) === 1 && (await text(cleanPreview.locator('[data-jj-op-command] code'))) === `jj op revert ${clean}` && /opdemo/.test(await text(cleanPreview.locator('[data-jj-op-did]'))), HUNG_MS)), await text(ops))
    await shoot(page.locator('.vc-view'), 'operations-command')
    await cleanPreview.locator('[data-action="jj-op-copy"]').click()
    check('…Copy copies it', !!(await until(async () => /Command copied/.test(await text(page.locator('body'))), HUNG_MS)))
    // The head moves after the preview: Copy copies nothing and shows it again.
    jj(shop, 'bookmark', 'create', 'meanwhile', '-r', base)
    await cleanPreview.locator('[data-action="jj-op-copy"]').click()
    check('…a head moved since: nothing copied, the preview shown again', !!(await until(async () => (await ops.locator('[data-jj-moved-at-copy]').count()) === 1, HUNG_MS)), await text(ops))
    await shoot(page.locator('.vc-view'), 'operations-moved')
    const afterMoved = JSON.stringify(heads(shop))
    await ops.locator('[data-action="jj-refresh"]').click()
    await until(async () => (await ops.locator(`[data-jj-op="${overlapped}"]`).count()) === 1, HUNG_MS)
    await ops.locator(`[data-jj-op="${overlapped}"] [data-action="jj-op-preview"]`).click()
    const overlapPreview = ops.locator(`[data-jj-op-preview="${overlapped}"][data-jj-refused="overlap"]`)
    check('…one whose bookmark moved again since: no command, the later work listed', !!(await until(async () => (await overlapPreview.count()) === 1 && (await overlapPreview.locator('[data-jj-op-command]').count()) === 0 && /moved/.test(await text(overlapPreview.locator('[data-jj-op-later]'))), HUNG_MS)), await text(ops))
    await shoot(page.locator('.vc-view'), 'operations-overlap')
    check('…and no preview wrote anything (the operation heads only the commands’ own)', JSON.stringify(heads(shop)) === afterMoved && before !== afterMoved && heads(shop).length === 1)
    // A late preview never replaces a later one (HI-2971): the clean one's, slowed, answers after the overlapped one's.
    const prev0 = await settled('jj:operationPreview')
    await slowNext('jj:operationPreview=3000*1')
    await ops.locator(`[data-jj-op="${clean}"] [data-action="jj-op-preview"]`).click()
    await ops.locator(`[data-jj-op="${overlapped}"] [data-action="jj-op-preview"]`).click()
    check('two quick previews: the later one shows', !!(await until(async () => (await overlapPreview.count()) === 1, HUNG_MS)), await text(ops))
    check('…the earlier one answers late', !!(await until(async () => (await settled('jj:operationPreview')) >= prev0 + 2, HUNG_MS)))
    await answered()
    check('…and the later one still shows', (await overlapPreview.count()) === 1 && (await ops.locator(`[data-jj-op-preview="${clean}"]`).count()) === 0, await text(ops))
    // Nor does Copy's re-read (HR1's round 1): Copy, its check slowed, finds the head moved and reads the preview again;
    // a Preview Undo of the same operation asked meanwhile answers first, and the re-read's late answer leaves it shown.
    const anyClean = ops.locator(`[data-jj-op-preview="${clean}"]`)
    const movedNote = ops.locator('[data-jj-moved-at-copy]')
    await slowNext('')
    await ops.locator(`[data-jj-op="${clean}"] [data-action="jj-op-preview"]`).click()
    check('the clean one previewed again', !!(await until(async () => (await anyClean.locator('[data-action="jj-op-copy"]').count()) === 1 && (await movedNote.count()) === 0, HUNG_MS)), await text(ops))
    jj(shop, 'bookmark', 'create', 'meanwhile2', '-r', base)
    const copy0 = await settled('jj:operationPreview')
    await slowNext('jj:operationPreview=5000*1')
    await anyClean.locator('[data-action="jj-op-copy"]').click()
    await ops.locator(`[data-jj-op="${clean}"] [data-action="jj-op-preview"]`).click()
    check('…Copy with the head moved, then Preview Undo of it again: the new preview shows', !!(await until(async () => (await settled('jj:operationPreview')) >= copy0 + 1 && (await anyClean.locator('[data-action="jj-op-copy"]').count()) === 1, HUNG_MS)), await text(ops))
    check("…Copy's check and re-read answer after it", !!(await until(async () => (await settled('jj:operationPreview')) >= copy0 + 3, HUNG_MS)))
    await answered()
    check("…and the new preview still shows, not Copy's re-read (no moved-at-copy note)", (await anyClean.count()) === 1 && (await movedNote.count()) === 0, await text(ops))
    await slowNext('')

    // --- Unsupported features: notes' .gitattributes refuses the switch, listed; its own core.autocrlf too, with the hint
    // to turn it off there alone (HI-2872), and the note that Git for Windows' stock settings don't count.
    execFileSync('git', ['config', 'core.autocrlf', 'true'], { cwd: notes, env: gitEnvOfTools(), windowsHide: true, stdio: 'ignore' })
    await toTab('notes')
    await head.locator('[data-platform="jj"]').click()
    const gated = dialog.filter({ has: page.locator('[data-vc-store-gates]') })
    check('notes: refused, attributes used (.gitattributes eol)', !!(await until(async () => (await gated.locator('[data-gate="attributes"][data-gate-state="uses"]').count()) === 1 && /eol=lf/.test(await text(gated)), HUNG_MS)), await text(dialog))
    check('…core.autocrlf with the hint to turn it off in the repository, and the stock note', (await gated.locator('[data-gate="attributes"] [data-gate-hint="autocrlf"]').count()) === 1 && /git config core\.autocrlf false/.test(await text(gated.locator('[data-gate-hint="autocrlf"]'))) && /core\.autocrlf \(local\) = true/.test(await text(gated)) && (await gated.locator('[data-vc-store-stock]').count()) === 1, await text(gated))
    await shoot(gated, 'gates')
    await gated.getByRole('button', { name: 'Close', exact: true }).click()
    check('…and notes stays Git', JSON.parse(fs.readFileSync(path.join(notes, '.combwork', 'project.json'), 'utf8')).platform === 'git')

    // --- A jj repository not colocated with Git (HI-2896): switched to jj like a colocated one; no Git to go back to.
    await toTab('loose')
    const looseJj = head.locator('[data-platform="jj"]')
    check('loose: jj offered (jjFound), not refused', (await looseJj.getAttribute('aria-disabled')) !== 'true' && !!(await until(async () => (await offer.getAttribute('data-vc-offer').catch(() => null)) === 'jjFound', HUNG_MS)), await text(head))
    await shoot(page.locator('.vc-view'), 'loose-offer')
    await looseJj.click()
    check('loose: the warning, every gate clear (read through the store inside .jj)', !!(await until(async () => (await warn.count()) === 1 && (await warn.locator('[data-gate-state="clear"]').count()) === 5, HUNG_MS)), await text(dialog))
    await shoot(warn, 'loose-switch-to-jj')
    await warn.getByRole('button', { name: 'Switch', exact: true }).click()
    check('loose uses jj: header and project.json', !!(await until(async () => (await head.locator('[data-platform="jj"][aria-checked="true"]').count()) === 1, HUNG_MS)) && JSON.parse(fs.readFileSync(path.join(loose, '.combwork', 'project.json'), 'utf8')).platform === 'jj')
    check('loose: its fact says not colocated', !!(await until(async () => /not colocated with Git/.test(await text(head)), HUNG_MS)), await text(head))
    const looseRepo = await section('jjRepo')
    check('loose Repository: not colocated, its root', !!(await until(async () => /Not colocated with Git/.test(await text(looseRepo)) && (await text(looseRepo)).includes(loose), HUNG_MS)), await text(looseRepo))
    await shoot(page.locator('.vc-view'), 'loose-repository')
    const looseBookmarks = await section('jjBookmarks')
    check('loose Bookmarks: main, nothing marked as differing from Git', !!(await until(async () => (await text(looseBookmarks)).includes('main'), HUNG_MS)) && (await looseBookmarks.locator('[data-jj-not-in-git]').count()) === 0, await text(looseBookmarks))
    check('…and still no .git in its folder', !fs.existsSync(path.join(loose, '.git')))
    const looseGit = head.locator('[data-platform="git"]')
    check('loose: back to Git not available', (await looseGit.getAttribute('aria-disabled')) === 'true')
    const tip = await lib.hoverTip(page, looseGit, (t) => /Git working copy/.test(t))
    if (!tip) await page.screenshot({ path: path.join(shots, 'jjview-loose-tip.png') })
    check('…its tooltip says why and how (jj git colocation enable, or None)', /No Git working copy here/.test(tip ?? '') && /jj git colocation enable/.test(tip ?? ''), tip)
    await shoot(head, 'loose-git-refused')

    // --- A read that answers after a switch to another jj project (HI-2971): shop's Refresh, slowed, answers after loose's
    // own read, and loose's History still shows its history, its Refresh enabled (it stayed on Reading… for good).
    const looseShows = async (h) => /main work/.test(await text(h)) && !/feature/.test(await text(h)) && !(await h.locator('[data-action="jj-refresh"]').isDisabled())
    const looseHist = await section('jjHistory')
    check('loose: History shows its own', !!(await until(() => looseShows(looseHist), HUNG_MS)), await text(looseHist))
    await toTab('shop')
    const shopHist = await section('jjHistory')
    check('shop: History shows its own', !!(await until(async () => /feature/.test(await text(shopHist)) && !(await shopHist.locator('[data-action="jj-refresh"]').isDisabled()), HUNG_MS)), await text(shopHist))
    const hist0 = await settled('jj:history')
    await slowNext('jj:history=3000*1')
    await shopHist.locator('[data-action="jj-refresh"]').click()
    await page.getByText('loose', { exact: true }).first().click()
    check("switched to loose during shop's Refresh: loose's History shows its own", !!(await until(async () => (await head.textContent())?.includes(loose) && (await looseShows(looseHist)), HUNG_MS)), await text(looseHist))
    check("…shop's slowed read answers late", !!(await until(async () => (await settled('jj:history')) >= hist0 + 2, HUNG_MS)))
    await answered()
    check('…and loose still shows its history, Refresh enabled, not Reading…', (await looseShows(looseHist)) && !/Reading…/.test(await text(looseHist)), await text(looseHist))
    await shoot(page.locator('.vc-view'), 'history-after-switch')

    await slowNext('')

    // --- While a switch's read is out (HI-3038): back to shop with its read held in main (CW_TEST_HOLD_IPC) until the
    // suite lets it go, its History shows Reading…, never loose's rows relabelled as shop's. Looked at while the read
    // can't answer, not polled for the state that ends it, nor raced against a delay (HR3's round 1).
    const holdIpc = (v) => app.evaluate((_e, x) => void (x ? (process.env.CW_TEST_HOLD_IPC = x) : delete process.env.CW_TEST_HOLD_IPC), v)
    const held = (channel) => app.evaluate((_e, c) => globalThis.__cwHeldIpc?.[c] ?? 0, channel)
    await holdIpc('jj:history')
    try {
      await page.getByText('shop', { exact: true }).first().click()
      check('switched back to shop, its History read held in main', !!(await until(async () => (await head.textContent())?.includes(shop) && (await held('jj:history')) >= 1, HUNG_MS)), `${await text(head)} (held ${await held('jj:history')})`)
      await answered()
      const during = await text(shopHist)
      check("…while shop's read is held, its History shows Reading…, not loose's history", /Reading…/.test(during) && !/main work/.test(during), during)
    } finally {
      await holdIpc('')
    }
    check("…let go, shop's own", !!(await until(async () => /feature/.test(await text(shopHist)) && !(await shopHist.locator('[data-action="jj-refresh"]').isDisabled()), HUNG_MS)), await text(shopHist))

    // --- Back to Git: refused while jj's state can't go back, then made.
    await toTab('shop')
    await head.locator('[data-platform="git"]').click()
    const fb = dialog.filter({ has: page.locator('[data-vc-store-fallback]') })
    check('back to Git refused: a commit storing conflicts listed', !!(await until(async () => (await fb.locator('[data-fallback="conflictedCommit"]').count()) >= 1, HUNG_MS)), await text(dialog))
    await shoot(fb, 'fallback-refused')
    // The user fixes it with jj: the conflicted merge abandoned, everything exported.
    jj(shop, 'abandon', 'merged')
    jj(shop, 'bookmark', 'delete', 'merged')
    jj(shop, 'git', 'export')
    await fb.getByRole('button', { name: 'Check Again' }).click()
    const back = dialog.filter({ has: page.locator('[data-vc-store="git"]') })
    check('…then the warning to go back to Git', !!(await until(async () => (await back.count()) === 1 && (await back.locator('[data-vc-store-fallback]').count()) === 0, HUNG_MS)), await text(dialog))
    await shoot(back, 'switch-to-git')
    await back.getByRole('button', { name: 'Switch', exact: true }).click()
    check("shop is Git again, Git's sections back, .jj left in place", !!(await until(async () => (await head.locator('[data-platform="git"][aria-checked="true"]').count()) === 1 && JSON.stringify(await sections()) === JSON.stringify(['workflow', 'changes', 'history', 'branches', 'queue']), HUNG_MS)) && fs.existsSync(path.join(shop, '.jj')))

    // --- HI-2974: shop's repository has been switched, so its switch to None waits for its work: refused while a card is
    // in flight (the drain listed, Check Again), then the usual warning (cancelled here: shop goes on as Git below).
    const card2 = await inv('tasks:create', { title: 'Still running', project: 'shop' })
    await inv('tasks:move', card2.number, 'doing', { confirm: true, reason: 'jjview: a card in flight' })
    await head.locator('[data-platform="none"]').click()
    const memberDrained = dialog.filter({ has: page.locator('[data-vc-store-drain]') })
    check('to None refused while a card is in flight: the drain lists it', !!(await until(async () => (await memberDrained.count()) === 1 && /Work is still running in this project/.test(await text(memberDrained)) && (await text(memberDrained)).includes('Still running'), HUNG_MS)), await text(dialog))
    check('…no group listed (the project alone)', (await memberDrained.locator('[data-vc-store-group]').count()) === 0)
    await shoot(memberDrained, 'member-none-drain')
    await inv('tasks:move', card2.number, 'done', { confirm: true, reason: 'jjview: done' })
    await memberDrained.getByRole('button', { name: 'Check Again' }).click()
    const noneWarn = dialog.filter({ has: page.locator('[data-vc-switch="none"]') })
    check('…then the warning to switch to None', !!(await until(async () => (await noneWarn.count()) === 1 && (await noneWarn.locator('[data-vc-store-drain]').count()) === 0, HUNG_MS)), await text(dialog))
    await noneWarn.getByRole('button', { name: 'Cancel' }).click()
    check('…cancelled: shop still Git', !!(await until(async () => (await dialog.count()) === 0, HUNG_MS)) && JSON.parse(fs.readFileSync(path.join(shop, '.combwork', 'project.json'), 'utf8')).platform === 'git')

    // --- All seven locales: jj's Repository section of notes after a switch would need clear gates; shop's offer and
    // the jj option's tooltip in each language, and a jj project's sections (shop again) in each.
    await head.locator('[data-platform="jj"]').click()
    await until(async () => (await warn.count()) === 1, HUNG_MS)
    await warn.getByRole('button', { name: 'Switch', exact: true }).click()
    await until(async () => (await head.locator('[data-platform="jj"][aria-checked="true"]').count()) === 1, HUNG_MS)
    await section('jjRepo')
    // The window's language, as a change of it reaches the window (vcswitch's way).
    const speak = (language) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('cw:event', ev), { type: 'language-changed', language })
    const english = (await inv('app:info')).language
    const catalogue = (code) => Object.assign({}, ...fs.readdirSync(path.join(lib.ROOT, 'locales', code)).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(lib.ROOT, 'locales', code, f), 'utf8'))))
    for (const language of ['de', 'es', 'fr', 'ja', 'pl', 'pt-BR', 'zh-CN']) {
      await speak({ ...english, code: language, locale: language, messages: catalogue(language) })
      const cat = Object.assign({}, ...['jj', 'git'].map((a) => JSON.parse(fs.readFileSync(path.join(lib.ROOT, 'locales', language, `${a}.json`), 'utf8'))))
      // Repository may be the same word in a language: the unsupported list's heading and Compare's label say it.
      const want = [cat['git.section.jjCompare'], cat['jj.repo.unsupported'], cat['jj.toCheck.head'], cat['jj.leftovers.head']]
      check(`${language}: jj's sections in the language`, want.every(Boolean) && !!(await until(async () => (await text(page.locator('.git-sections'))).includes(want[0]) && (await text(page.locator('.vc-view'))).includes(want[1]), HUNG_MS)), await text(page.locator('.git-sections')))
      await page.locator('.vc-view').screenshot({ path: path.join(shots, `jjview-repository-${language}.png`) })
      await page.locator('[data-jj-to-check]').screenshot({ path: path.join(shots, `jjview-to-check-${language}.png`) })
      await page.locator('[data-jj-leftovers]').screenshot({ path: path.join(shots, `jjview-leftovers-${language}.png`) })
      const opsHere = await section('jjOperations')
      check(`${language}: Operations in the language`, !!cat['jj.ops.intro'] && !!(await until(async () => (await text(opsHere)).includes(cat['jj.ops.intro'].slice(0, 20)), HUNG_MS)), await text(opsHere))
      await page.locator('.vc-view').screenshot({ path: path.join(shots, `jjview-operations-${language}.png`) })
      await section('jjRepo')
    }
    // loose's header (not colocated, Git refused) in each language: its fact in the language's words (its tab found in English).
    await speak(english)
    await toTab('loose')
    for (const language of ['de', 'es', 'fr', 'ja', 'pl', 'pt-BR', 'zh-CN']) {
      await speak({ ...english, code: language, locale: language, messages: catalogue(language) })
      check(`${language}: loose's fact in the language`, !!(await until(async () => !/not colocated with Git/.test(await text(head)) && (await text(head)).includes(loose), HUNG_MS)), await text(head))
      await head.screenshot({ path: path.join(shots, `jjview-loose-${language}.png`) })
    }
    await speak(english)
    // None: the project's own switch, always offered.
    await head.locator('[data-platform="none"]').click()
    const toNone = dialog.filter({ hasText: 'None' })
    await until(async () => (await toNone.getByRole('button', { name: 'Switch', exact: true }).count()) === 1, HUNG_MS)
    await toNone.getByRole('button', { name: 'Switch', exact: true }).click()
    check('loose back to None', !!(await until(async () => JSON.parse(fs.readFileSync(path.join(loose, '.combwork', 'project.json'), 'utf8')).platform === 'none', HUNG_MS)))
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(`screenshots: ${shots}`)
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
