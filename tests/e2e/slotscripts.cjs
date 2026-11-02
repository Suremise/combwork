// The slots' copy patterns, idle removal switch and archive script acting in the app (#1563, tests/workflow/README.md's
// P7 table), through a test Hive's `slots:test` channel as slotpool does, the options set with the Version Control tab's
// channel (slots:setSetting):
// - Files copied into new slots `*.key`: a git-ignored api.key is copied into each new slot; an ignored notes.local and
//   .env (the default's) are not;
// - Remove idle slots after a day off (Settings → Advanced): a day later, with one builder left, both slots are kept;
//   turned on again, the same tidy removes the one beyond the pool's size;
// - an archive script that fails (exit 3) keeps the slot, saying so; once it passes, it runs before the slot is removed
//   (it saw the folder), and the slot goes.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR (no agent is started).
// Dev build only (#1578): its slots are lent and released through slots:test, which a packaged build refuses.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const q = require('./queueFixture.cjs')

const PORT = Number(lib.port(47809))
const fx = q.queueProject('slotscripts')
const DAY_MS = 24 * 60 * 60 * 1000
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  q.prepare(fx)
  // Git-ignored files in the project folder: one the copy patterns name, two they don't.
  fs.writeFileSync(path.join(fx.alpha, '.gitignore'), '.hive/\n*.key\nnotes.local\n.env\n')
  lib.git(fx.alpha, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'ignore the local files'])
  fs.writeFileSync(path.join(fx.alpha, 'api.key'), 'secret-1\n')
  fs.writeFileSync(path.join(fx.alpha, 'notes.local'), 'mine\n')
  fs.writeFileSync(path.join(fx.alpha, '.env'), 'A=1\n')
  // The archive script: records the slot it ran for and whether its folder was still there, and exits with the code in
  // archive-exit.txt. It writes outside the slot (a slot it left files in would be kept for those).
  const archiveLog = path.join(fx.tools, 'archive.log')
  const exitFile = path.join(fx.tools, 'archive-exit.txt')
  const archive = path.join(fx.tools, 'archive.js')
  fs.writeFileSync(archive, ["const fs = require('fs')", `fs.appendFileSync(${JSON.stringify(archiveLog)}, process.env.HIVE_SLOT + ' ' + fs.existsSync('.git') + '\\n')`, `process.exit(Number(fs.readFileSync(${JSON.stringify(exitFile)}, 'utf8')))`, ''].join('\n'))
  const archived = () => (fs.existsSync(archiveLog) ? fs.readFileSync(archiveLog, 'utf8').trim().split('\n').filter(Boolean) : [])
  const h = await q.startHive(fx, { port: PORT, keepOptions: true })
  try {
    const { page, inv } = h
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    const op = (o) => inv('slots:test', fx.alpha, o)
    const slots = () => inv('slots:list', fx.alpha)
    const names = async () => (await slots()).map((s) => s.name).sort()
    const set = await inv('slots:setSetting', fx.alpha, 'copy', '*.key')
    check("Files copied into new slots set to *.key, the project's own", set.slots?.copy === '*.key', JSON.stringify(set))
    const b1 = await lib.addAgent(inv, fx.alpha, { name: 'B1' })
    const b2 = await lib.addAgent(inv, fx.alpha, { name: 'B2' })

    // --- The copy patterns: each new slot gets api.key, never the other ignored files.
    const a = await op({ op: 'lend', agent: b1.id, card: 101 })
    const b = await op({ op: 'lend', agent: b2.id, card: 102 })
    check('two slots lent', a.ok && b.ok && a.slot.name === 'slot-a' && b.slot.name === 'slot-b', JSON.stringify({ a, b }))
    for (const s of [a, b].filter((x) => x.ok)) {
      const has = (f) => fs.existsSync(path.join(s.slot.folder, f))
      check(`${s.slot.name}: the ignored api.key is copied in`, has('api.key') && fs.readFileSync(path.join(s.slot.folder, 'api.key'), 'utf8') === 'secret-1\n')
      check(`…notes.local and .env, ignored but not named, are not`, !has('notes.local') && !has('.env'))
    }
    check('both released clean, ready', (await op({ op: 'release', lease: a.lease.id, why: 'done' })) === true && (await op({ op: 'release', lease: b.lease.id, why: 'done' })) === true && (await slots()).every((s) => s.state === 'ready'), JSON.stringify(await slots()))

    // --- Remove idle slots after a day, off: one builder left, a day later, nothing is removed.
    await inv('agents:remove', fx.alpha, b2.id, { deleteWorktree: false })
    await inv('advanced:set', 'hive.slots.removeIdle', false)
    const later = Date.now() + DAY_MS + 60_000
    const kept = await op({ op: 'tidy', at: later })
    check('Remove idle slots off: a day later the tidy removes nothing', JSON.stringify(kept) === '[]', JSON.stringify(kept))
    check('…both slots stay, their folders too', JSON.stringify(await names()) === '["slot-a","slot-b"]' && fs.existsSync(a.slot.folder) && fs.existsSync(b.slot.folder), JSON.stringify(await names()))
    await inv('advanced:set', 'hive.slots.removeIdle', true)
    const removed = await op({ op: 'tidy', at: later })
    check('…turned on, the same tidy removes the one beyond the pool of one', Array.isArray(removed) && removed.length === 1 && (await slots()).length === 1, JSON.stringify({ removed, left: await names() }))
    const left = (await slots())[0]

    // --- The archive script: failing, it keeps the slot; passing, it runs first and the slot goes.
    check('Archive script set', (await inv('slots:setSetting', fx.alpha, 'archive', `node "${archive}"`)).slots?.archive === `node "${archive}"`)
    fs.writeFileSync(exitFile, '3')
    const refused = await op({ op: 'remove', slot: left.name })
    check(`${left.name}'s removal: its archive script exits 3, and the slot is kept, saying so`, refused?.why === 'archiveFailed' && /exited with code 3/.test(refused.error ?? ''), JSON.stringify(refused))
    check('…the script ran in the slot', JSON.stringify(archived()) === JSON.stringify([`${left.name} true`]), JSON.stringify(archived()))
    check('…which is still listed, its folder there, ready', (await slots()).some((s) => s.name === left.name && s.state === 'ready') && fs.existsSync(left.folder), JSON.stringify(await slots()))
    fs.writeFileSync(exitFile, '0')
    const gone = await op({ op: 'remove', slot: left.name })
    check('its script passing, the slot is removed', gone === null && !(await slots()).length, JSON.stringify({ gone, slots: await slots() }))
    check('…the script having run first, with the folder still there', JSON.stringify(archived()) === JSON.stringify([`${left.name} true`, `${left.name} true`]), JSON.stringify(archived()))
    check("…and the folder is gone, git doesn't list it", !fs.existsSync(left.folder) && !lib.git(fx.alpha, ['worktree', 'list']).toLowerCase().includes(left.name))
  } catch (e) {
    check('no exception', false, e?.stack ?? String(e))
  } finally {
    await h.app.close().catch(() => {})
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
