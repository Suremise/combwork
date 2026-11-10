// The merge queue's controls in the app (#1353, SPEC §16.9.3, OP-9): a project set to "Combwork merges" into `integration`
// (queueFixture.cjs), fake Claude Code agents acting by their own tokens.
// - Remove from queue during its check, then a restart: never merged (S33a);
// - Retry merge after a red check: queued again once, and merged;
// - GET /v1/queue's shape for a project agent; an agent's and a script's pause refused (403);
// - the Assistant within Control: refused at Look and advise, pauses and resumes at Control agents, both in its actions.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
const q = require('./queueFixture.cjs')

const PORT = Number(lib.port(47846))
const fx = q.queueProject('queuecontrols')
const HUNG_MS = 60000
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 200)
const TARGET = 'integration'

;(async () => {
  q.prepare(fx)
  let h = await q.startCombwork(fx, { port: PORT })
  let removed = null
  let removedAt = null
  let headAtClose = null
  try {
    h.page.on('pageerror', (e) => check('no page errors', false, e.message))
    const reviewer = await q.agent(fx, h, 'R1')
    check('the reviewer has its token', !!reviewer.token)
    const column = async (n) => (await h.card(n))?.column
    const done = async (n) => (await until(async () => (await column(n)) === 'done', HUNG_MS)) === true
    const view = async () => (await h.inv('queue:list', fx.alpha, TARGET))[0]
    /** The queue at rest: no run of this Combwork's going, nothing being tested. */
    const idle = (v) => !!v && !v.runHere && !v.testing
    const api = async (token, method, p, body) => {
      const res = await fetch(`http://127.0.0.1:${h.port}${p}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: res.status, body: await res.json().catch(() => null) }
    }

    // Pause queue and Resume (an approved card waits, unmerged; the pause kept as the user's) are progressqueue's, through the
    // window's Pause, queuecard's (approved while paused waits) and queuePause.test.ts's: here too, over IPC, until HI-2663.

    // --- Remove from queue during its check: back to Passed, never merged.
    q.steer(fx, 'wait')
    const two = await q.approve(fx, h, reviewer, 'Two', { 'two.txt': 'two\n' })
    check('Remove: its check is running', !!(await until(() => fs.existsSync(fx.started), HUNG_MS)))
    const testing = await until(async () => {
      const v = await view()
      return v?.testing?.card === two.n && v.testing.step === 'checks' ? v : null
    }, HUNG_MS)
    check('…the model says it is testing, at its checks, with its run', !!testing && !!testing.testing.revision && !!testing.testing.started, JSON.stringify(testing?.testing))
    const out = await h.inv('queue:remove', two.n, 'not now')
    check('…Remove from queue: back to Passed', out?.column === 'passed', JSON.stringify(out?.column))
    removedAt = q.head(fx)
    fs.writeFileSync(fx.go, 'go')
    const settled = await until(async () => {
      const v = await view()
      return idle(v) && v.recent.some((r) => r.card === two.n && r.outcome === 'cancelled') ? v : null
    }, HUNG_MS)
    check('…its outcome: cancelled (removed); the target unmoved', !!settled && settled.recent.find((r) => r.card === two.n)?.reason === 'removed' && q.head(fx) === removedAt, JSON.stringify(settled?.recent))
    removed = two.n

    // --- Retry merge after a red check: queued again once, and merged.
    q.steer(fx, 'fail', 'flaky')
    const three = await q.approve(fx, h, reviewer, 'Three', { 'three.txt': 'three\n' })
    const returned = await until(async () => ((await column(three.n)) === 'doing' ? true : null), HUNG_MS)
    const v3 = await view()
    check('a red check returns it; the model keeps why, with its log', !!returned && v3?.recent?.[0]?.card === three.n && v3.recent[0].outcome === 'returned' && v3.recent[0].reason === 'checks' && String(v3.recent[0].log).includes('red: flaky'), JSON.stringify(v3?.recent?.[0]))
    q.steer(fx, 'pass')
    const retried = await h.inv('queue:retry', three.n, 'known flaky')
    check('Retry merge: queued again', retried?.column === 'passed', JSON.stringify(retried?.column))
    check('…and merged', await done(three.n), JSON.stringify(await h.kinds(three.n)))
    check('…recorded as an override with its reason', (await h.facts(three.n)).some((f) => f.kind === 'Override' && f.data.move === 'retry merge' && f.data.reason === 'known flaky'))

    // --- GET /v1/queue for a project agent; an agent's and a script's pause refused.
    const listed = await api(reviewer.token, 'GET', '/v1/queue')
    const qv = listed.body?.[0]
    check('GET /v1/queue (a project agent, its own project): the queue, lean', listed.status === 200 && qv?.project === 'alpha' && qv.target === TARGET && qv.paused === null && Array.isArray(qv.queued) && qv.recent?.length >= 3 && !('projectPath' in qv) && !('returns' in qv) && !('returnsMore' in qv) && !('inFlight' in qv) && qv.recent.every((r) => !('log' in r)) && qv.recent.some((r) => r.hasLog === true), JSON.stringify(listed.body).slice(0, 600))
    const agentPause = await api(reviewer.token, 'POST', '/v1/queue/pause', { target: TARGET })
    check("an agent's pause is refused (403), saying whose it is", agentPause.status === 403 && /user/.test(agentPause.body?.error ?? '') && (await view()).paused === null, JSON.stringify(agentPause.body))
    const apiToken = JSON.parse(fs.readFileSync(path.join(fx.userData, 'agent-api.json'), 'utf8')).token
    const scriptPause = await api(apiToken, 'POST', '/v1/queue/pause', { project: 'alpha', target: TARGET })
    check("a script's pause is refused (403)", scriptPause.status === 403 && (await view()).paused === null, JSON.stringify(scriptPause.body))

    // --- The Assistant, with its own token: refused at Look and advise; pauses and resumes at Control agents.
    const home = (await h.inv('workspace:refresh')).assistant.path
    await h.inv('session:start', home, { agentId: 'assistant' })
    await until(async () => {
      const s = (await h.inv('session:live')).find((x) => x.projectPath.toLowerCase() === home.toLowerCase() && x.agentId === 'assistant')
      if (s?.status === 'waiting') await h.inv('pty:write', lib.ptyKey(home, 'assistant'), '\r')
      return s?.status === 'ready'
    }, HUNG_MS)
    const tokenFile = path.join(fx.userData, 'assistant-api', `${createHash('sha256').update(fx.ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)
    const assistant = (await until(() => fs.existsSync(tokenFile), HUNG_MS)) ? JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token : null
    check('the Assistant has its token', !!assistant)
    await h.inv('settings:update', { assistant: { control: 'look' } })
    const looked = await api(assistant, 'POST', '/v1/queue/pause', { project: 'alpha', target: TARGET })
    check('at Look and advise the Assistant\'s pause is refused (403)', looked.status === 403 && (await view()).paused === null, JSON.stringify(looked.body))
    await h.inv('settings:update', { assistant: { control: 'agents' } })
    const byAssistant = await api(assistant, 'POST', '/v1/queue/pause', { project: 'alpha' })
    check('at Control agents it pauses the queue (its only target by default), saved as the Assistant\'s', byAssistant.status === 200 && byAssistant.body?.paused?.by === 'assistant' && (await view()).paused?.by === 'assistant', JSON.stringify(byAssistant.body))
    const actions = await h.inv('assistant:actions')
    check('…listed in its actions', actions.some((x) => x.ok && x.kind === 'queue-pause' && x.project === 'alpha'), JSON.stringify(actions.map((x) => [x.kind, x.text])))
    const back = await api(assistant, 'POST', '/v1/queue/resume', { project: 'alpha', target: TARGET })
    check('…and resumes it', back.status === 200 && back.body?.resumed === true && (await view()).paused === null, JSON.stringify(back.body))
    // Its panel's "Done by the Assistant": the pause and the resume, each saying why undo can't take it back (both themes).
    await lib.fitWindow(h.app, h.page, { width: 1500, height: 900 })
    const panel = () => h.page.locator('.assistant-panel')
    await h.page.evaluate(() => document.activeElement?.blur())
    await h.page.keyboard.press('Control+Alt+I')
    const link = panel().locator('.assistant-done-link')
    await until(async () => (await link.count()) === 1, HUNG_MS)
    await link.click()
    const rows = panel().locator('.assistant-change-group').first().locator('.assistant-action[data-status="final"]')
    const inPanel = await until(async () => {
      const t = await panel().locator('.assistant-change-group').first().innerText().catch(() => '')
      return (await rows.count()) === 2 && /Paused the merge queue for integration in alpha/.test(t) && /Resumed the merge queue for integration in alpha/.test(t) ? t : null
    }, HUNG_MS)
    check("its panel lists the pause and the resume, each Can't be undone", !!inPanel, await panel().innerText().catch(() => ''))
    // Each row's tooltip says why (the newest first: the resume, then the pause), in both themes for the screenshots.
    for (const [i, why, name] of [[0, /A merge queue it resumed isn.t paused again/, 'resume'], [1, /A merge queue it paused stays paused/, 'pause']]) {
      for (const theme of ['dark', 'light']) {
        await h.inv('settings:update', { appearance: { theme } })
        await until(async () => (await h.page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
        await h.page.mouse.move(5, 5)
        const tip = await lib.hoverTip(h.page, rows.nth(i), (t) => why.test(t), HUNG_MS)
        check(`…the ${name}'s tooltip says why undo leaves it (${theme})`, why.test(tip), tip)
        await h.page.screenshot({ path: path.join(fx.shots, `queuecontrols-assistant-${name}-${theme}.png`) })
      }
    }
    await h.page.mouse.move(5, 5)
    await h.inv('settings:update', { appearance: { theme: 'dark' } })
    const noReason = await api(assistant, 'POST', '/v1/queue/retry', { card: `#${three.n}` })
    check("its Retry merge needs a reason (400)", noReason.status === 400, JSON.stringify(noReason.body))
    // --- HI-2892: a forward merge against the release path's direction (into main, the default branch): refused with its
    // reason; the user's override only as the JSON boolean true, recorded in the Assistant's action.
    await h.inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx, { otherTargets: ['main'] }) })
    const backward = await api(assistant, 'POST', '/v1/queue/forward', { project: 'alpha', from: TARGET, to: 'main' })
    check('HI-2892: a forward into main is refused (400), saying why', backward.status === 400 && /main isn’t brought up to date with integration: main is the repository’s default branch, which a release reaches through its pull request/.test(JSON.stringify(backward.body)), JSON.stringify(backward.body))
    const loose = await api(assistant, 'POST', '/v1/queue/forward', { project: 'alpha', from: TARGET, to: 'main', override: 'true' })
    check('…an override that isn’t the boolean true is refused (400)', loose.status === 400 && /override is true or left out/.test(JSON.stringify(loose.body)), JSON.stringify(loose.body))
    const overridden = await api(assistant, 'POST', '/v1/queue/forward', { project: 'alpha', from: TARGET, to: 'main', override: true })
    const fwdCard = overridden.body?.card
    check('…with override true it is queued, the override on its card', overridden.status === 200 && overridden.body?.queued === true && (await h.facts(fwdCard)).some((f) => f.kind === 'ForwardRequested' && f.data.override?.dir === 'backward' && f.data.override?.why === 'default'), JSON.stringify(overridden.body))
    const fwdActions = await h.inv('assistant:actions')
    check('…its action says it overrode the direction', fwdActions.some((x) => x.ok && x.kind === 'queue-forward' && /with the user’s override of the release path’s direction/.test(x.text)), JSON.stringify(fwdActions.map((x) => [x.kind, x.text])))
    // Taken out again, unless merged already: only the override was checked.
    if (fwdCard) await h.inv('queue:remove', fwdCard, 'only the override was checked').catch(() => null)
    await h.inv('session:stop', home, 'assistant')

    // --- G18 (#1179): Push the target branch after merging, on, in a repository with no remote: the card merges, then
    // the queue pauses saying why (the Merges tab, both themes); turned off and resumed, nothing is owed and it goes on.
    await h.inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx, { pushTarget: true }) })
    q.steer(fx, 'pass')
    const pushed = await q.approve(fx, h, reviewer, 'Pushed', { 'pushed.txt': 'pushed\n' })
    check('G18: a card approved with push after merging on is merged', await done(pushed.n), JSON.stringify(await h.kinds(pushed.n)))
    const noRemote = await until(async () => ((await view())?.paused?.reason === 'pushNoRemote' ? await view() : null), HUNG_MS)
    check('…no remote to push to: the queue pauses, saying so', !!noRemote, JSON.stringify(await view()))
    const merges = await q.mergesTab(h)
    const said = await until(async () => ((await merges.text(TARGET)).includes('has no remote to push to') ? merges.text(TARGET) : null), HUNG_MS)
    check('…the Merges tab says why, and to turn the option off to keep merging locally', !!said && said.includes('Push the target branch after merging'), await merges.text(TARGET))
    await q.folderHelpers(fx).themes(h.page, merges.card(TARGET), 'queuecontrols-push-paused')
    await h.inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx) })
    const resumedPush = await h.inv('queue:resume', fx.alpha, TARGET)
    check('…turned off and resumed: resumed, not paused', resumedPush?.resumed === true && resumedPush.view.paused === null, JSON.stringify(resumedPush))
    // The queue's run after the Resume drops the owed push (the option is off) and pauses for nothing.
    const unpaused = await until(async () => {
      const v = await view()
      return idle(v) ? v : null
    }, HUNG_MS)
    check('…and its run after it leaves the queue unpaused', !!unpaused && unpaused.paused === null, JSON.stringify(unpaused))
    headAtClose = q.head(fx)
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await h.app.close().catch(() => {})
  }

  // --- S33a: after a restart, the removed card is never merged.
  if (removed !== null) {
    try {
      h = await q.startCombwork(fx, { port: PORT, keepOptions: true })
      const rest = await until(async () => {
        const v = (await h.inv('queue:list', fx.alpha, TARGET))[0]
        return v && !v.runHere && !v.testing && !v.queued.length ? v : null
      }, HUNG_MS)
      const kinds = await h.kinds(removed)
      check('S33a: restarted, the removed card is still Passed, never merged, the target where Combwork left it', !!rest && (await h.card(removed))?.column === 'passed' && !kinds.includes('Integrated') && !kinds.includes('IntegrationStarted') && q.head(fx) === headAtClose, JSON.stringify({ kinds, head: q.head(fx), headAtClose }))
    } catch (e) {
      check('no exception after the restart', false, e.stack)
    } finally {
      await h.app.close().catch(() => {})
    }
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
