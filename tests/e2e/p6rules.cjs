// The workflow rules #1425's options table found with no test of them acting in the app (#1507), each with fake Claude
// Code agents acting by their own tokens (queueFixture.cjs: alpha is "Hive merges" into `integration`, one merge check):
// - G1b two reviewers: one pass leaves the card in Review, the same reviewer again doesn't count, a second reviewer's
//   pass approves it (S57's quorum), then it is merged;
// - G13 stop own runs: the builder's own Progress run still open refuses its submit, naming the run; once it ends, the
//   submit goes through; with G13 off, an open run refuses nothing;
// - G9's `mergeInstall: always`: the queue installs from scratch before every entry's checks, also in its warm worktree
//   with no manifest changed (`onManifestChange` is p5scenarios' S13);
// - None (a project folder with no version control, `nada`): N3 a check before review refuses submit until it is counted
//   (run through Progress for the card, as hive-progress --check does); N4 a change under node_modules isn't part of the
//   work (not unclaimed, and written while the check runs, the check still counts), nor can a card declare it (#1511); N2 the builder can't review its own card; N6 a card blocked by one not yet accepted can't start, and
//   starts once it is.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const q = require('./queueFixture.cjs')

const PORT = Number(lib.port(47859))
const fx = q.queueProject('p6rules')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const waitHung = (fn) => lib.until(fn, HUNG_MS, 200)

;(async () => {
  q.prepare(fx)
  // None's project: a plain folder, its deliverable and what N4 leaves out.
  const nada = path.join(fx.ws, 'nada')
  fs.mkdirSync(path.join(nada, '.combwork'), { recursive: true })
  fs.writeFileSync(path.join(nada, 'notes.txt'), 'notes\n')
  const h = await q.startHive(fx, { port: PORT })
  const { page, inv } = h
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    const column = async (n) => (await h.card(n))?.column
    const done = async (n) => !!(await waitHung(async () => (await column(n)) === 'done'))
    const api = async (who, method, url, body) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, headers: { Authorization: `Bearer ${who.token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    const who = ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`]
    const commitIn = (folder, files, message) => {
      for (const [f, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(folder, f)), { recursive: true })
        fs.writeFileSync(path.join(folder, f), text)
      }
      lib.git(folder, [...who, 'add', '-A'])
      lib.git(folder, [...who, 'commit', '-qm', message])
    }
    const setOptions = (over) => inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx, over) })
    const r1 = await q.agent(fx, h, 'R1')
    const r2 = await q.agent(fx, h, 'R2')
    const b1 = await q.agent(fx, h, 'B1')
    check('the agents have their tokens', !!(r1.token && r2.token && b1.token))
    /** A card of B1's: started on the slot its start lends (#1578), `files` committed there. */
    const started = async (title, files) => {
      const n = (await inv('tasks:create', { title, project: 'alpha' })).number
      const s = await q.startCard(fx, h, b1, n)
      // Refused, B1's folder is still its last card's slot: nothing is committed there.
      if (s.status === 200) commitIn(b1.folder, files, title)
      return { n, start: s }
    }

    // ===== G1b: two reviewers must pass the same change.
    await setOptions({ reviewers: 2 })
    const g1 = await started('Quorum', { 'quorum.txt': 'two reviewers\n' })
    const g1sub = await q.intent(h, b1, g1.n, 'submit', { summary: 'quorum: ready' })
    check('G1b: started and submitted', g1.start.status === 200 && g1sub.status === 200, JSON.stringify({ start: g1.start.body, sub: g1sub.body }))
    const pass = async (r) => [await q.intent(h, r, g1.n, 'start-review'), await q.intent(h, r, g1.n, 'verdict', { pass: true, comment: `quorum: passed by ${r.name}` })]
    const first = await pass(r1)
    check("G1b: R1's pass is taken, and the card stays in Review", first.every((x) => x.status === 200) && (await column(g1.n)) === 'review', JSON.stringify(first.map((x) => [x.status, x.body?.rule ?? x.body?.to])))
    const again = await pass(r1)
    check('…R1 again: not a second pass, still in Review', (await column(g1.n)) === 'review' && !(await h.kinds(g1.n)).includes('IntegrationRequested'), JSON.stringify(again.map((x) => [x.status, x.body?.rule ?? x.body?.to])))
    const second = await pass(r2)
    check("…R2's pass approves it: queued and merged, Done", second.every((x) => x.status === 200) && (await done(g1.n)), JSON.stringify({ second: second.map((x) => [x.status, x.body?.rule ?? x.body?.to]), kinds: await h.kinds(g1.n) }))
    const verdicts = (await h.facts(g1.n)).filter((x) => x.kind === 'Verdict' && x.data?.pass)
    check('…its passes: R1 and R2, each its own', new Set(verdicts.map((v) => v.data.reviewer)).size === 2, JSON.stringify(verdicts.map((v) => v.data.reviewer)))

    // ===== G13: the builder's own run still going refuses its submit; ended, it goes through; off, nothing is refused.
    await setOptions({ stopOwnRuns: true })
    const g13 = await started('Own runs', { 'runs.txt': 'own runs\n' })
    const run = await api(b1, 'POST', '/v1/progress', { title: 'unit tests (B1)', card: `#${g13.n}` })
    check('G13: B1 starts a Progress run of its own', run.status === 200 && !!run.body?.id, JSON.stringify(run.body))
    const refused = await q.intent(h, b1, g13.n, 'submit', { summary: 'own runs: ready' })
    check("G13: B1's submit is refused while its run goes on, naming it, its next step to stop it", refused.status === 409 && refused.body?.rule === 'submit.ownRunsStopped' && JSON.stringify(refused.body).includes('unit tests (B1)') && (refused.body?.next ?? '').startsWith('Stop them or let them finish'), JSON.stringify(refused.body))
    check('…and nothing moved', (await column(g13.n)) === 'doing')
    await api(b1, 'POST', `/v1/progress/${run.body.id}/finish`, { ok: true })
    const after = await q.intent(h, b1, g13.n, 'submit', { summary: 'own runs: ready' })
    check('…the run ended: submitted', after.status === 200 && (await column(g13.n)) === 'review', JSON.stringify(after.body))
    // Each card reviewed and merged before B1's next starts (its slot is the card's until then, #1578), so G9's part has
    // the queue to itself.
    const merged = async (n) => {
      await q.intent(h, r1, n, 'start-review')
      await q.intent(h, r1, n, 'verdict', { pass: true, comment: 'passed' })
      return done(n)
    }
    check('…reviewed and merged', await merged(g13.n), JSON.stringify(await h.kinds(g13.n)))
    await setOptions({ stopOwnRuns: false })
    const off = await started('Runs allowed', { 'allowed.txt': 'runs allowed\n' })
    const run2 = await api(b1, 'POST', '/v1/progress', { title: 'lint (B1)', card: `#${off.n}` })
    const offSub = await q.intent(h, b1, off.n, 'submit', { summary: 'allowed: ready' })
    check('G13 off: an open run of B1’s refuses nothing', off.start.status === 200 && run2.status === 200 && offSub.status === 200 && (await column(off.n)) === 'review', JSON.stringify({ start: off.start.body, sub: offSub.body }))
    await api(b1, 'POST', `/v1/progress/${run2.body.id}/finish`, { ok: true })
    check('…reviewed and merged too', await merged(off.n), JSON.stringify(await h.kinds(off.n)))

    // ===== G9 mergeInstall: always: an install before every entry's checks, in the warm worktree too.
    const order = path.join(fx.tools, 'order.log')
    fs.writeFileSync(order, '')
    const install = path.join(fx.tools, 'install.js')
    // Each install says where it ran: slots run the setup too, and only the queue's count here.
    fs.writeFileSync(install, `require('fs').appendFileSync(${JSON.stringify(order)}, 'install ' + process.cwd() + '\\n')\n`)
    await inv('project:updateConfig', fx.alpha, { worktreeSetup: `node "${install}"` })
    q.checkWith(fx, 'ordered', `require('fs').appendFileSync(${JSON.stringify(order)}, 'check\\n')`)
    await setOptions({ mergeInstall: 'always' })
    /** The queue's installs and checks, in order (its worktree is `…\queue-…`; the check runs only there). */
    const lines = () =>
      fs
        .readFileSync(order, 'utf8')
        .split(/\r?\n/)
        .filter((l) => l === 'check' || (l.startsWith('install ') && /[\\/]queue-[^\\/]+$/.test(l.slice(8))))
        .map((l) => l.split(' ')[0])
    // The second card under way as the first merges (as in a lane): the queue keeps its worktree, warm, for it.
    const second9 = (await inv('tasks:create', { title: 'Install again', project: 'alpha' })).number
    const b9 = await q.agent(fx, h, `B${second9}`)
    const s9 = await q.startCard(fx, h, b9, second9)
    const first9 = await q.approve(fx, h, r1, 'Install first', { 'first.txt': 'first\n' })
    check('G9: the first card approved and merged', s9.status === 200 && Object.values(first9.steps).every((x) => x.status === 200) && (await done(first9.n)), JSON.stringify(first9.steps))
    check('…an install before its check', JSON.stringify(lines()) === JSON.stringify(['install', 'check']), JSON.stringify(lines()))
    lib.git(b9.folder, [...who, 'merge', '-q', '--no-edit', 'integration'])
    commitIn(b9.folder, { 'second.txt': 'second, no manifest changed\n' }, 'Install again')
    const steps9 = [await q.intent(h, b9, second9, 'submit', { summary: 'again: ready' }), await q.intent(h, r1, second9, 'start-review'), await q.intent(h, r1, second9, 'verdict', { pass: true, comment: 'again: passed' })]
    check('G9: the second card (no manifest changed) approved and merged', steps9.every((x) => x.status === 200) && (await done(second9)), JSON.stringify(steps9.map((x) => [x.status, x.body?.rule])))
    check('…mergeInstall always: installed again before its check', JSON.stringify(lines()) === JSON.stringify(['install', 'check', 'install', 'check']), JSON.stringify(lines()))
    q.restoreCheck(fx)

    // ===== None (nada): N3 a check before review, N4 what the work is, N2 no self-review, N6 dependencies accepted.
    fs.writeFileSync(path.join(nada, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    await inv('workspace:refresh')
    const nb = await q.agent(fx, h, 'NB', { project: nada })
    const nr = await q.agent(fx, h, 'NR', { project: nada })
    const noneOptions = { review: 'agent', noSelfReview: true, preChecks: ['quick'], commands: { quick: `"${fx.tool}"` }, finish: 'accept', folder: 'project', dependenciesDone: true }
    const set = await inv('workflow:setOptions', nada, { preset: null, options: noneOptions })
    check("nada is None, its options saved", !!set && (await inv('workflow:stages', nada))?.stages.some((x) => x.id === 'review'), JSON.stringify(await inv('workflow:stages', nada)))
    const nc = (await inv('tasks:create', { title: 'Write the notes', project: 'nada' })).number
    const nd = (await inv('tasks:create', { title: 'After the notes', project: 'nada' })).number
    await inv('tasks:update', nd, { blockedBy: [nc] })
    const ncStart = await q.intent(h, nb, nc, 'start')
    check('None: NB starts its card in the project folder', ncStart.status === 200, JSON.stringify(ncStart.body))
    fs.writeFileSync(path.join(nada, 'notes.txt'), 'notes, written\n')
    fs.mkdirSync(path.join(nada, 'node_modules', 'pad'), { recursive: true })
    fs.writeFileSync(path.join(nada, 'node_modules', 'pad', 'index.js'), 'module.exports = 1\n')
    // Another change in the folder, no card's.
    fs.writeFileSync(path.join(nada, 'extra.txt'), 'nobody declared this\n')
    // The paths the card declares (None's paths: its agent's edits fill them in; these the suite wrote), before its check
    // runs on them.
    const decl = await q.intent(h, nb, nc, 'declare-paths', { paths: ['notes.txt'] })
    check('None: NB declares the path its card changes', decl.status === 200, JSON.stringify(decl.body))
    const unclaimed = decl.body?.data?.unclaimed ?? []
    check("N4: what no card claims is extra.txt; node_modules' change isn't part of the work", unclaimed.includes('extra.txt') && !unclaimed.some((x) => x.startsWith('node_modules')), JSON.stringify(decl.body?.data))
    // #1511: nor can a card declare it its work: a path under node_modules is refused, the card's paths kept.
    const widen = await q.intent(h, nb, nc, 'declare-paths', { paths: ['notes.txt', 'node_modules/pad/index.js'] })
    check('N4: declaring a path under node_modules is refused, saying why', widen.status === 409 && widen.body?.rule === 'paths.excluded' && /node_modules\/pad\/index\.js is in node_modules/.test(JSON.stringify(widen.body)), JSON.stringify(widen.body))
    const kept = await q.intent(h, nb, nc, 'declare-paths', { paths: ['notes.txt'] })
    check("…the card's paths as declared before", kept.status === 200 && kept.body?.data?.revision === decl.body?.data?.revision, JSON.stringify(kept.body))
    const early = await q.intent(h, nb, nc, 'submit', { summary: 'notes: ready' })
    check('N3: submit refused until the check before review is counted', early.status === 409 && early.body?.rule === 'submit.checksPassed' && JSON.stringify(early.body).includes('quick'), JSON.stringify(early.body))
    // The check through Progress for the card, as hive-progress --check reports it: resolved (the folder as it starts),
    // started, passed. As it runs, it writes a cache under node_modules (N4: not a deliverable, so the run still counts).
    /** A run of the quick check for the card, `during` written as it runs; its CheckRan once recorded. */
    const quickRun = async (during) => {
      const before = (await h.facts(nc)).filter((x) => x.kind === 'CheckRan').length
      const resolved = await api(nb, 'POST', '/v1/progress/resolve', { folder: nada, card: `#${nc}`, check: 'quick' })
      const crun = await api(nb, 'POST', '/v1/progress', { title: 'quick', link: resolved.body?.link, command: resolved.body?.check?.command })
      for (const [f, text] of Object.entries(during)) {
        fs.mkdirSync(path.dirname(path.join(nada, f)), { recursive: true })
        fs.writeFileSync(path.join(nada, f), text)
      }
      const cfin = crun.body?.id ? await api(nb, 'POST', `/v1/progress/${crun.body.id}/finish`, { ok: true, exitCode: 0 }) : null
      const ran = await waitHung(async () => (await h.facts(nc)).filter((x) => x.kind === 'CheckRan').at(before)?.data ?? null)
      return { ok: resolved.status === 200 && crun.status === 200 && cfin?.status === 200, ran, said: JSON.stringify({ resolved: resolved.body, crun: crun.body, ran }) }
    }
    // A deliverable written as it runs: the run doesn't count (the contrast for N4 below).
    const changed = await quickRun({ 'extra.txt': 'written while the check runs\n' })
    check('a run that writes a deliverable as it runs (extra.txt) does not count', changed.ok && changed.ran?.counted === false && changed.ran?.whyNot === 'changed', changed.said)
    const cached = await quickRun({ 'node_modules/.cache/run.txt': 'written by the check\n' })
    check('N3: the check run for the card counts (N4: its write under node_modules too)', cached.ok && cached.ran?.counted === true, cached.said)
    const sub = await q.intent(h, nb, nc, 'submit', { summary: 'notes: ready' })
    check('…then submitted', sub.status === 200 && (await column(nc)) === 'review', JSON.stringify(sub.body))
    const files = ((await h.facts(nc)).filter((x) => x.kind === 'Submitted').at(-1)?.data?.files ?? []).map((x) => (typeof x === 'string' ? x : x.path))
    check('…its change: notes.txt, as declared', JSON.stringify(files) === JSON.stringify(['notes.txt']), JSON.stringify(files))
    const self = await q.intent(h, nb, nc, 'start-review')
    check("N2: NB can't review its own card", self.status === 409 && self.body?.rule === 'review.notAuthor', JSON.stringify(self.body))
    const blocked = await q.intent(h, nb, nd, 'start')
    check('N6: a card blocked by one not yet accepted is refused its start', blocked.status === 409 && blocked.body?.rule === 'start.dependenciesIntegrated', JSON.stringify(blocked.body))
    const nrSteps = [await q.intent(h, nr, nc, 'start-review'), await q.intent(h, nr, nc, 'verdict', { pass: true, comment: 'notes: passed' })]
    check('…NR reviews and passes it: accepted, Done', nrSteps.every((x) => x.status === 200) && (await done(nc)) && (await h.kinds(nc)).includes('Accepted'), JSON.stringify({ steps: nrSteps.map((x) => [x.status, x.body?.rule]), kinds: await h.kinds(nc) }))
    const ndStart = await q.intent(h, nb, nd, 'start')
    check('N6: once accepted, the blocked card starts', ndStart.status === 200 && (await column(nd)) === 'doing', JSON.stringify(ndStart.body))
  } catch (e) {
    check('the suite ran to the end', false, e.stack)
  } finally {
    await h.app.close().catch(() => undefined)
  }
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
