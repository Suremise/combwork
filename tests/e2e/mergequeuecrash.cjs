// Crash injection into the merge queue's update of a target checked out in a folder (#1351, SPEC §16.9.2's recovery
// table; S34d): `main` checked out in the project folder, Merge into a checked-out branch set to Automatically, fake
// Claude Code agents (one builder, building each card on the slot its start lends, and one reviewer, rejoined in each
// run of Hive), the Assistant off.
// - Hive ended (HIVE_TEST_QUEUE_CRASH) after IntegrationStarted, before and after read-tree, before and after update-ref,
//   and in and after a rollback (the target moved by another client just before the swap: HIVE_TEST_QUEUE_RACE): each
//   next start recovers per the table, the card merged exactly once, the folder clean on main, the queue not paused.
//   Where a point's recovery can't reach the next run's seam (no rollback), that next run is the restart too.
// - The terminal state: a listed file edited after a crash past read-tree; the restart pauses the queue (needs you) with
//   the state (branch, ref, the file's side, no command), changes nothing more, and asks in For you (screenshots of the
//   card dialog's request, both themes); put back and answered, the queue looks again and recovery finishes the swap.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
// Dev build only (#1578): every part ends Hive at a crash seam (HIVE_TEST_QUEUE_CRASH, _QUEUE_RACE), which a packaged
// build ignores.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const q = require('./queueFixture.cjs')

const PORT = Number(lib.port(47849))
const fx = q.queueProject('mergequeuecrash')
const HUNG_MS = 60000
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
// Every wait here is bounded only against a hang (#570).
const waitHung = (fn) => lib.until(fn, HUNG_MS, 200)
const f = q.folderHelpers(fx)
const main = () => q.head(fx, 'main')

;(async () => {
  q.prepare(fx)
  let crew = null
  /** A run of Hive with these seams, the crew (made in the first, rejoined after) ready. */
  async function start(env = {}) {
    const h = await q.startHive(fx, { port: PORT, env, keepOptions: !!crew })
    if (!crew) {
      await h.inv('workflow:setOptions', fx.alpha, { preset: null, options: f.options() })
      await h.inv('advanced:set', 'hive.queue.checkedOutTarget', 'auto')
      crew = { builder: await q.agent(fx, h, 'CB'), reviewer: await q.agent(fx, h, 'CR') }
    } else crew = { builder: await q.rejoin(fx, h, crew.builder), reviewer: await q.rejoin(fx, h, crew.reviewer) }
    return h
  }
  /** A card approved in this run, which ends at its seam: whether it did. Hive may end while the verdict is answered. */
  async function crashes(h, label) {
    let ended = false
    h.app.process().once('exit', () => (ended = true))
    q.steer(fx, 'pass')
    const steps = await q.approveBy(fx, h, crew.builder, crew.reviewer, `Card ${label}`, { [`${label}.txt`]: `${label}\n` }).then((r) => r.steps, (e) => String(e?.message ?? e))
    check(`${label}: Hive ended at the seam`, !!(await waitHung(() => ended)), JSON.stringify(steps))
    await h.app.close().catch(() => {})
  }
  /** After a restart: Done, Integrated once (its result in main), one merge commit, its file there, the folder clean. */
  async function recovered(h, label) {
    const c = await waitHung(async () => ((await f.byTitle(h, `Card ${label}`))?.column === 'done' ? f.byTitle(h, `Card ${label}`) : null))
    const integrated = c ? (await h.facts(c.number)).filter((x) => x.kind === 'Integrated') : []
    check(`${label}: restarted, recovered: Done, Integrated once (its result in main), merged once`, !!c && integrated.length === 1 && f.merges(c.key) === 1 && lib.git(fx.alpha, ['rev-list', 'main']).includes(integrated[0].data.result), JSON.stringify({ column: c?.column, integrated: integrated.length, merges: c ? f.merges(c.key) : 0 }))
    check(`${label}: …its file in the folder, the folder clean on main, the queue not paused`, f.text(`${label}.txt`) === `${label}\n` && f.status() === '' && lib.git(fx.alpha, ['branch', '--show-current']).trim() === 'main' && !(await h.inv('queue:list', fx.alpha, 'main'))[0]?.paused, `${f.status()} ${JSON.stringify((await h.inv('queue:list', fx.alpha, 'main'))[0]?.paused)}`)
  }
  let h = null
  try {
    // `chain`: the point's recovery finishes the swap, touching no seam, so its restart is the next point's run. The
    // others' recovery runs the card through the journal again (a rerun) or rolls back: a restart with no seam.
    const runs = [
      { point: 'afterStarted' },
      { point: 'beforeFiles' },
      { point: 'afterFiles', chain: true },
      { point: 'beforeRef', chain: true },
      { point: 'afterAdvance' },
      { point: 'inRollback', race: true },
      { point: 'afterRollback', race: true }
    ]
    let prev = null
    for (const r of runs) {
      h = await start({ HIVE_TEST_QUEUE_CRASH: r.point, ...(r.race ? { HIVE_TEST_QUEUE_RACE: 'beforeRef' } : {}) })
      if (prev) await recovered(h, prev)
      await crashes(h, r.point)
      prev = r.point
      if (r.chain) continue
      h = await start()
      await recovered(h, r.point)
      await h.app.close().catch(() => {})
      prev = null
    }

    // --- The terminal state: a listed file edited after a crash past read-tree.
    h = await start({ HIVE_TEST_QUEUE_CRASH: 'afterFiles' })
    await crashes(h, 'stuck')
    fs.writeFileSync(path.join(fx.alpha, 'stuck.txt'), 'edited after the crash\n')
    h = await start()
    h.page.on('pageerror', (e) => check('no page errors', false, e.message))
    const c = await waitHung(() => f.byTitle(h, 'Card stuck'))
    const view = await waitHung(async () => {
      const v = (await h.inv('queue:list', fx.alpha, 'main'))[0]
      return v?.paused?.stuck ? v : null
    })
    const st = view?.paused?.stuck
    check('terminal: the restart pauses the queue, needs you, with the state: branch, ref, the file and its side, no command', view?.paused?.reason === 'needsYou' && st?.branch === 'main' && st.ref === st.expected && st.phase === 'files' && JSON.stringify(st.files) === '[{"path":"stuck.txt","side":"other"}]' && st.commands.length === 0, JSON.stringify(view?.paused))
    check('…nothing more changed: main where it was, the edit kept', main() === st?.expected && f.text('stuck.txt') === 'edited after the crash\n')
    const item = await waitHung(async () => (await h.inv('tasks:forYou')).items?.find((i) => i.card === c.number && i.gate === 'queueStuck'))
    check('…For you asks you to settle it (Decide, its message)', item?.kind === 'decide' && item.shown?.id === 'workflow.forYou.queueStuck' && item.shown.values?.how === 'none', JSON.stringify(item))
    const s = await f.forYouSection(h, c.number)
    check("…the card dialog shows it: Decide, the request's words", !!(await waitHung(async () => /Decide[\s\S]*stopped part way/.test(await s.section.innerText().catch(() => '')))), await s.section.innerText().catch(() => ''))
    await f.themes(h.page, s.section, 'mergequeuecrash-stuck')
    await h.page.keyboard.press('Escape')
    // Settled by hand (the file as the journal left it: the index's), then answered: the queue looks again.
    lib.git(fx.alpha, ['checkout', '--', 'stuck.txt'])
    await h.inv('tasks:answer', c.number, item.request, { outcome: 'answered', reply: 'put back' })
    const doneAfter = await waitHung(async () => (await h.card(c.number))?.column === 'done')
    const integrated = (await h.facts(c.number)).filter((x) => x.kind === 'Integrated')
    check('…answered: the queue looks again, recovery finishes the swap: Done, merged once, the folder clean', !!doneAfter && integrated.length === 1 && f.merges(c.key) === 1 && f.status() === '' && f.text('stuck.txt') === 'stuck\n' && !(await h.inv('queue:list', fx.alpha, 'main'))[0]?.paused, JSON.stringify({ integrated: integrated.length, status: f.status() }))
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await h?.app.close().catch(() => {})
  }
  console.log(`screenshots: ${fx.shots}`)
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
