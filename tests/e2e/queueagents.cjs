// Agents under Combwork merges (#1354, SPEC §16.9.3): a project set to "Combwork merges" into `integration` (queueFixture.cjs),
// fake Claude Code agents acting by their own tokens, the Assistant off. A builder whose card is approved and queued
// tries to merge it itself:
// - cw_report_merge (report-merge) and cw_merge_slot (claim naming the card): both refused (409, merge.combworkMerges)
//   with where it is in the merge queue and where the rule is set; the card untouched;
// - its card read says who merges it and where it is;
// then the queue returns it for a conflict, and its wake names the files and the next step; the builder merges the
// target in, resolves, commits and submits; reviewed and passed again, the queue merges it: Done.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const q = require('./queueFixture.cjs')

const PORT = Number(lib.port(47848))
const fx = q.queueProject('queueagents')
const HUNG_MS = 60000
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 200)

/** An agent's call to the Agent API by its own token: its status and reply. */
async function call(h, who, method, url, body) {
  const res = await fetch(`http://127.0.0.1:${h.port}${url}`, { method, headers: { Authorization: `Bearer ${who.token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: res.status, body: await res.json().catch(() => null) }
}

;(async () => {
  q.prepare(fx)
  const h = await q.startCombwork(fx, { port: PORT })
  try {
    h.page.on('pageerror', (e) => check('no page errors', false, e.message))
    const reviewer = await q.agent(fx, h, 'R1')
    check('the reviewer has its token', !!reviewer.token)
    const column = async (n) => (await h.card(n))?.column

    // --- A first card holds the queue (its check waits), so the next stays queued while its builder tries to merge it.
    q.steer(fx, 'wait')
    const first = await q.approve(fx, h, reviewer, 'First', { 'first.txt': 'first\n' })
    check('a first card is approved and its check is running', Object.values(first.steps).every((s) => s.status === 200) && !!(await until(() => fs.existsSync(fx.started), HUNG_MS)), JSON.stringify(first.steps))
    // Someone's change lands once the card's line is made (a line is made from the target's head).
    const someone = () => q.commitOn(fx, 'integration', { 'a.txt': 'one\nTWO by someone\nthree\n' }, 'someone changes a.txt')
    const card = await q.approve(fx, h, reviewer, 'Conflicting', { 'a.txt': 'one\ntwo by the builder\nthree\n' }, { afterStart: someone })
    check('the card is approved (start, submit, review, pass)', Object.values(card.steps).every((s) => s.status === 200), JSON.stringify(card.steps))
    const key = (await h.card(card.n)).key
    const before = q.head(fx)

    const report = await q.intent(h, card.builder, card.n, 'report-merge')
    check('report merge: refused (409) by merge.combworkMerges', report.status === 409 && report.body?.rule === 'merge.combworkMerges', JSON.stringify(report))
    check('…saying Combwork merges it, and where the rule is set', String(report.body?.message).startsWith(`Combwork merges ${key}`) && String(report.body?.change).includes('Who merges'), JSON.stringify(report.body))
    // The first card is the one testing now (its checks run in this Combwork's queue: the window's order, #1353): this one is next.
    check('…its next step: its place in the queue (next, behind the card being tested), and wait for Done or a return', String(report.body?.next) === 'It is in the merge queue for integration (position 1) and moves to Done once merged: wait for that, or for it to come back.', String(report.body?.next))
    const slot = await call(h, card.builder, 'POST', '/v1/projects/alpha/merge-slot/claim', { cards: [card.n], timeoutSeconds: 0 })
    check('the merge slot claimed for it: refused the same way', slot.status === 409 && slot.body?.rule === 'merge.combworkMerges', JSON.stringify(slot))
    const holders = await call(h, card.builder, 'GET', '/v1/projects/alpha/merge-slot?branch=integration')
    check('…the slot not taken', holders.status === 200 && !JSON.stringify(holders.body).includes(card.builder.name), JSON.stringify(holders.body))
    check('…the card untouched: not Done, the target unmoved', (await column(card.n)) !== 'done' && q.head(fx) === before)
    check('…both refusals recorded on the card', (await h.facts(card.n)).filter((f) => f.kind === 'Refused' && f.data?.rule === 'merge.combworkMerges').length === 2, JSON.stringify(await h.kinds(card.n)))
    const read = await call(h, card.builder, 'GET', `/v1/tasks/${encodeURIComponent(key)}`)
    check("its card read says Combwork merges it and where it is", read.status === 200 && String(read.body?.merge).startsWith('Combwork merges this card (its rules)'), JSON.stringify(read.body?.merge))

    // HI-2087: its builder watches it for Done, as a builder whose card passed does (HB2 on HI-2046): when the queue
    // returns it, that watch's line must say so too, never lead with the review's pass.
    const watching = await call(h, card.builder, 'POST', '/v1/tasks/wait', { cards: [card.n], column: 'done', wake: true, limitMinutes: 60 })
    check('its builder watches it for Done', watching.status === 200, JSON.stringify(watching))

    // --- The first card merges; then the queue tests this one: a conflict with the target returns it, its wake naming
    // the file and the next step.
    fs.writeFileSync(fx.go, 'go')
    check('the first card is merged: Done', !!(await until(async () => (await column(first.n)) === 'done', HUNG_MS)), JSON.stringify(await h.kinds(first.n)))
    const failure = await until(async () => (await h.facts(card.n)).find((f) => f.kind === 'IntegrationFailed') ?? null, HUNG_MS)
    check('the queue returns it for a conflict naming a.txt', failure?.data?.reason === 'conflict' && JSON.stringify(failure.data.files) === '["a.txt"]', JSON.stringify(failure))
    // Its inbox read until the return has come (the queue's own wake, a loop wake's note; its watch for Done stays on).
    const seen = []
    const wake = await until(async () => {
      const r = await call(h, card.builder, 'POST', '/v1/inbox', {})
      seen.push(...(r.body?.items ?? []).filter((i) => i.card === card.n))
      const text = JSON.stringify(seen)
      return text.includes('came back from the merge queue') ? text : null
    }, HUNG_MS)
    check("its builder's wake says what came back and what to do", !!wake && wake.includes('a conflict with integration in a.txt') && wake.includes('Merge integration into your worktree'), String(wake))
    check("…and every line about it leads with the return, none with the review's pass (HI-2087)", seen.length > 0 && seen.every((i) => String(i.text).includes(`${key} came back from the merge queue`)) && !JSON.stringify(seen).includes('latest comment by'), JSON.stringify(seen))
    const said = await until(async () => (await h.card(card.n))?.comments?.findLast((c) => c.by === 'Combwork') ?? null, HUNG_MS)
    check('…and Combwork says so on the card (its latest comment): what came back, in English for agents and as a message for the window', !!said && String(said.text).startsWith(`${key} came back from the merge queue: a conflict with integration in a.txt`) && said.appText?.id === 'tasks.history.queueReturned', JSON.stringify(said))
    const after = await call(h, card.builder, 'GET', `/v1/tasks/${encodeURIComponent(key)}`)
    check('its card read now says it came back, and what to do', String(after.body?.merge).includes('came back from the merge queue'), JSON.stringify(after.body?.merge))

    // --- The builder merges the target in, resolves, commits and submits; reviewed again, the queue merges it.
    q.steer(fx, 'pass')
    const who = ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`]
    try {
      lib.git(card.builder.folder, [...who, 'merge', '-q', 'integration'])
    } catch {
      // The conflict the queue found: resolved by hand.
    }
    fs.writeFileSync(path.join(card.builder.folder, 'a.txt'), 'one\nTWO by someone, two by the builder\nthree\n')
    lib.git(card.builder.folder, [...who, 'add', '-A'])
    lib.git(card.builder.folder, [...who, 'commit', '-qm', 'resolve the conflict with integration'])
    const submit = await q.intent(h, card.builder, card.n, 'submit', { summary: 'Resolved: integration merged in' })
    check('…its builder submits the fix', submit.status === 200, JSON.stringify(submit))
    const review = await q.intent(h, reviewer, card.n, 'start-review')
    const verdict = await q.intent(h, reviewer, card.n, 'verdict', { pass: true, comment: 'resolved' })
    check('…reviewed and passed again', review.status === 200 && verdict.status === 200, JSON.stringify({ review, verdict }))
    check('…and the queue merges it: Done', !!(await until(async () => (await column(card.n)) === 'done', HUNG_MS)), JSON.stringify(await h.kinds(card.n)))
    const integ = (await h.facts(card.n)).filter((f) => f.kind === 'Integrated')
    check('…Integrated by Combwork, the target at its result', integ.length === 1 && integ[0].data.by === 'combwork' && integ[0].data.result === q.head(fx), JSON.stringify(integ))
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await h.app.close().catch(() => {})
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
