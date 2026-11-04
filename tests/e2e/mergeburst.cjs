// HI-2379: a fast-forward that brings thousands of commits into a project folder's line while a card works in that folder
// (Solo, no slots): Hive attributes each of them to the card (SPEC §16.3.2), and main's thread is never held long while
// it does. The release merge into main brought 3,536 and held it for 40 s, each commit its own transaction folding the
// card's whole log again (2,000 here held it 18 s); in batches, main's longest stall stays well under a second.
// Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 180000
const COMMITS = 2000
const FILLER = 300
/** Main's longest stall allowed while it takes them in (18 s before HI-2379; about 100 ms after). */
const STALL_MS = 1000

const userData = path.join(lib.WORK, 'mergeburst-profile')
const ws = path.join(lib.WORK, 'mergeburst-ws')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const git = (args, input) => lib.git(alpha, ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...args], { timeoutMs: HUNG_MS, input, maxBuffer: 64 * 1024 * 1024 })

function fixture() {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha, { 'a.txt': 'one\n', '.gitignore': '.combwork/\n' })
  git(['branch', '-M', 'main'])
  // COMMITS commits on `big`, a file each, made at once.
  const from = git(['rev-parse', 'main']).trim()
  let s = ''
  for (let i = 0; i < COMMITS; i++) s += `commit refs/heads/big\ncommitter T <t@t> ${1700000000 + i} +0000\ndata 6\nwork ${i % 10}\n${i ? '' : `from ${from}\n`}M 100644 inline f/${i}.txt\ndata ${String(i).length + 1}\n${i}\n\n`
  git(['fast-import', '--quiet'], s)
  fs.mkdirSync(path.join(alpha, '.combwork'), { recursive: true })
  fs.writeFileSync(path.join(alpha, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'b1', name: 'Builder', provider: 'claude-code' }] }))
  lib.enableProviders(userData)
}

;(async () => {
  fixture()
  const h = await lib.launch({ userData, env: { HIVE_API_PORT: lib.port(47709) } })
  const { app, page, inv } = h
  try {
    await lib.openWorkspace(inv, page, ws)
    for (let i = 0; i < FILLER; i++) await inv('tasks:create', { title: `Filler ${i}`, project: 'alpha', description: 'x'.repeat(400) })
    const n = (await inv('tasks:create', { title: 'Work in the folder', project: 'alpha' })).number
    await inv('tasks:update', n, { column: 'doing', agent: 'b1' })
    const started = await lib.until(async () => (await inv('tasks:facts', n)).find((f) => f.kind === 'Started'), HUNG_MS)
    check('the card is started in the project folder', started?.data.folder === 'project', JSON.stringify(started?.data))
    // Main's longest gap between 10 ms ticks, from here on.
    await app.evaluate(() => {
      const g = (globalThis.__burstGap = { max: 0, last: Date.now() })
      setInterval(() => {
        const now = Date.now()
        g.max = Math.max(g.max, now - g.last - 10)
        g.last = now
      }, 10).unref()
    })
    // A fast-forward: they are the line's own then (a merge commit's branch is never attributed in the folder, HI-2382).
    git(['merge', '-q', '--ff-only', 'big'])
    const t0 = Date.now()
    const attributed = await lib.until(async () => (await inv('tasks:facts', n)).filter((f) => f.kind === 'CommitAttributed').length >= COMMITS || null, HUNG_MS, 500)
    console.log(`INFO ${COMMITS} commits attributed ${attributed ? `in ${Date.now() - t0} ms` : 'not all in time'}`)
    const longest = await app.evaluate(() => globalThis.__burstGap.max)
    console.log(`INFO main's longest stall meanwhile: ${longest} ms`)
    check(`every commit is attributed`, !!attributed)
    check(`main isn't held long by ${COMMITS} commits merged into the folder's line`, longest < STALL_MS, `${longest} ms`)
  } catch (e) {
    check('the suite ran', false, e.stack)
  } finally {
    await app.close().catch(() => {})
  }
  process.exit(failed ? 1 : 0)
})()
