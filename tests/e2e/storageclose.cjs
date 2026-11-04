// Storage measurements stop when the page that asked for them goes (#260). A page abandons a measurement when it stops
// waiting, but closing its window, or reloading the page, runs none of the page's clean-up, so main abandons a window's
// requests itself. The walk is held at a gate in main (opendir under the projects' attachments) to catch it half way: window
// 2 asks for beta, window 1 for alpha with the same request id; closing window 2 stops beta's walk and leaves alpha's
// to finish, then a reload in window 1 stops another of alpha's. Dev build, throwaway profile and workspaces, quiet.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'storageclose-profile')
const wsA = path.join(lib.WORK, 'storageclose-a')
const wsB = path.join(lib.WORK, 'storageclose-b')
const alpha = path.join(wsA, 'alpha')
const beta = path.join(wsB, 'beta')
const DIRS = 30
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/** A project whose attachments are DIRS folders of one 100-byte file each. */
function project(p) {
  for (let i = 0; i < DIRS; i++) {
    fs.mkdirSync(path.join(p, '.combwork', 'attachments', `d${i}`), { recursive: true })
    fs.writeFileSync(path.join(p, '.combwork', 'attachments', `d${i}`, 'f.png'), 'x'.repeat(100))
  }
}

;(async () => {
  for (const d of [userData, wsA, wsB]) fs.rmSync(d, { recursive: true, force: true })
  project(alpha)
  project(beta)
  lib.enableProviders(userData)
  const { app, page, inv } = await lib.launch({ userData, viewport: { width: 1200, height: 800 } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, wsA)
  const next = app.waitForEvent('window')
  await inv('window:new')
  const page2 = await next
  await page2.waitForLoadState('domcontentloaded')
  await lib.appReady(page2)
  const inv2 = (ch, ...a) => page2.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv2, page2, wsB)

  // The gate: main's opendir under a project's attachments waits while held, and counts each folder read, by project.
  await app.evaluate((_e, roots) => {
    const fsp = process.mainModule.require('original-fs/promises')
    const real = fsp.opendir
    const gate = (globalThis.__storageGate = { held: true, waiters: [], reads: {} })
    gate.release = () => {
      gate.held = false
      for (const w of gate.waiters.splice(0)) w()
    }
    fsp.opendir = async (p, ...rest) => {
      const root = roots.find((r) => String(p).toLowerCase().startsWith(r))
      if (root) {
        gate.reads[root] = (gate.reads[root] ?? 0) + 1
        while (gate.held) await new Promise((r) => gate.waiters.push(r))
      }
      return real(p, ...rest)
    }
  }, [alpha, beta].map((p) => path.join(p, '.combwork', 'attachments').toLowerCase()))
  const reads = async () => {
    const r = await app.evaluate(() => globalThis.__storageGate.reads)
    return { alpha: r[path.join(alpha, '.combwork', 'attachments').toLowerCase()] ?? 0, beta: r[path.join(beta, '.combwork', 'attachments').toLowerCase()] ?? 0 }
  }
  const hold = () => app.evaluate(() => void (globalThis.__storageGate.held = true))
  const release = () => app.evaluate(() => globalThis.__storageGate.release())
  /** Asks for a project's storage from a page, without waiting: its answer goes to window.__storage. */
  const ask = (pg, p, request) =>
    pg.evaluate(([x, r]) => {
      window.__storage = window.hive.invoke('storage:project', x, true, r).then((v) => ({ attachments: v.attachments }), (e) => ({ error: String(e) }))
    }, [p, request])

  // Both windows measure, with the same request id; each walk is held at its first folder.
  await ask(page2, beta, 'storage-1')
  await ask(page, alpha, 'storage-1')
  const started = await lib.until(async () => {
    const r = await reads()
    return r.alpha === 1 && r.beta === 1 ? r : null
  }, 5000)
  check('both walks start and are held', !!started, JSON.stringify(await reads()))

  // Window 2 closes: its walk stops; window 1's, with the same request id, carries on.
  await inv2('window:close').catch(() => undefined) // The page can go before it hears back.
  check('window 2 closes', !!(await lib.until(async () => (await inv('window:count')) === 1, 10000)))
  await release()
  const done = await page.evaluate(() => window.__storage)
  check("window 1's measurement gets its whole result", done.attachments === DIRS * 100, JSON.stringify(done))
  await lib.sleep(500) // A fixed wait on purpose: this checks that beta's walk reads NO further folders, which no condition can show.
  const after = await reads()
  check("window 2's walk stopped when it closed: no folder read after its first", after.beta === 1, JSON.stringify(after))
  check("…and window 1's read every folder", after.alpha === DIRS + 1, JSON.stringify(after))

  // A reload in window 1 stops its own walk the same way.
  await hold()
  await ask(page, alpha, 'storage-2')
  check("window 1's next walk is held", !!(await lib.until(async () => (await reads()).alpha === DIRS + 2, 5000)), JSON.stringify(await reads()))
  await page.reload()
  await lib.appReady(page)
  await release()
  await lib.sleep(500) // A fixed wait on purpose, as above: no further folder read.
  const reloaded = await reads()
  check('reloading the page stopped its walk', reloaded.alpha === DIRS + 2, JSON.stringify(reloaded))

  // The page measures afresh as usual.
  const fresh = await inv('storage:project', alpha, true, 'storage-3')
  check('a new call measures afresh', fresh.attachments === DIRS * 100, JSON.stringify(fresh.attachments))

  await app.close()
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
