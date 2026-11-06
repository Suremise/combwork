// HI-2462: a workspace as 1.0 left it (its folders under 1.0's name) opens in Combwork with everything under .combwork
// (SPEC §4.1.1). The dev build makes a workspace (a project, cards, a shared note, a handover, a card's attachment), then,
// closed, the workspace is put back as 1.0 kept it: each .combwork renamed back to 1.0's name (the workspace's, the Assistant's home's
// inside it, the project's), git's exclude line as 1.0 wrote it, and a card and a handover naming files by their old
// paths. Opened again: no old folder is left, the board's cards, the notes and the attachment are there, the paths in
// the card and the handover point into .combwork, an old link still opens (combwork-img, through the map), the exclude line
// follows, and the project keeps its agent. Opened once more: nothing moves again. No agents. Dev build, throwaway
// profile and workspace.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000
// old-name: begin combworkfolder-inputs
/** 1.0's folder, board file and exclude line: what the workspace is put back as. */
const OLD_DIR = '.hive'
const OLD_DB = 'hive.db'
const OLD_LINE = '/.hive/'
// old-name: end combworkfolder-inputs

const userData = path.join(lib.WORK, 'combworkfolder-profile')
const ws = path.join(lib.WORK, 'combworkfolder-ws')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/** Every old and .combwork folder under the workspace, as relative paths (three levels: the Assistant's is ws\.x\assistant\.x). */
function folders() {
  const out = []
  const walk = (dir, depth) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      // Gone since its parent was listed: a swap's staging folder the app was installing a skill through, say.
      if (e.code === 'ENOENT') return
      throw e
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === '.git' || e.name === 'node_modules') continue
      const p = path.join(dir, e.name)
      if (e.name === OLD_DIR || e.name === '.combwork') out.push(path.relative(ws, p))
      if (depth < 3) walk(p, depth + 1)
    }
  }
  walk(ws, 0)
  return out.sort()
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha)
  fs.mkdirSync(path.join(alpha, '.combwork'), { recursive: true })
  fs.writeFileSync(path.join(alpha, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a-coder', name: 'Coder' }] }))

  // The workspace, made by the dev build.
  let numbers
  let stored
  {
    const { app, page, inv } = await lib.launch({ userData })
    try {
      await lib.openWorkspace(inv, page, ws)
      const one = await inv('tasks:create', { title: 'With evidence', project: 'alpha' })
      const two = await inv('tasks:create', { title: 'Plain', project: 'alpha' })
      numbers = [one.number, two.number]
      await inv('notes:create', 'plan.md', false)
      // A screenshot attached to the first card, as the window attaches one: kept in alpha's folder.
      const pasted = path.join(alpha, '.combwork', 'attachments', 'shot.png')
      fs.mkdirSync(path.dirname(pasted), { recursive: true })
      fs.writeFileSync(pasted, lib.samplePng())
      stored = (await inv('cards:attachFromPane', one.number, alpha, pasted))?.path
    } finally {
      await app.close()
    }
  }

  // As 1.0 left it: its old folders, its exclude line, and paths into them stored in a card and a handover.
  check("the attachment is kept in the project's folder", !!stored && stored.startsWith(path.join(alpha, '.combwork', 'attachments', 'cards')) && fs.existsSync(stored), String(stored))
  const shot = (dir) => path.join(alpha, dir, path.relative(path.join(alpha, '.combwork'), stored))
  fs.mkdirSync(path.join(ws, '.combwork', 'shared', 'handovers'), { recursive: true })
  fs.writeFileSync(path.join(ws, '.combwork', 'shared', 'handovers', '2026-11-01-evidence.md'), `# Evidence\n\nThe screenshot: ${shot(OLD_DIR)}\n`)
  for (const [from, to] of [
    [path.join(ws, '.combwork', 'assistant', '.combwork'), path.join(ws, '.combwork', 'assistant', OLD_DIR)],
    [path.join(ws, '.combwork'), path.join(ws, OLD_DIR)],
    [path.join(alpha, '.combwork'), path.join(alpha, OLD_DIR)]
  ])
    if (fs.existsSync(from)) fs.renameSync(from, to)
  // And the board's file under 1.0's name (HI-2587's names upgrade moves it back).
  for (const s of ['', '-wal', '-shm']) if (fs.existsSync(path.join(ws, OLD_DIR, `combwork.db${s}`))) fs.renameSync(path.join(ws, OLD_DIR, `combwork.db${s}`), path.join(ws, OLD_DIR, `${OLD_DB}${s}`))
  // 1.0 had no record of the names upgrade (this build wrote one as it made the workspace).
  fs.rmSync(path.join(ws, OLD_DIR, 'combwork-names.json'), { force: true })
  const exclude = path.join(alpha, '.git', 'info', 'exclude')
  fs.writeFileSync(exclude, fs.readFileSync(exclude, 'utf8').replace(/^\/\.combwork\/$/m, OLD_LINE))
  {
    const db = new DatabaseSync(path.join(ws, OLD_DIR, OLD_DB))
    db.prepare('UPDATE cards SET description = ? WHERE number = ?').run(`The screenshot: ![shot](${shot(OLD_DIR)})`, numbers[0])
    db.close()
  }
  check('the workspace is as 1.0 kept it: old folders only', folders().join() === [OLD_DIR, path.join(OLD_DIR, 'assistant', OLD_DIR), path.join('alpha', OLD_DIR)].sort().join(), folders().join())

  // Opened in Combwork.
  const { app, page, inv } = await lib.launch({ userData })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws, HUNG_MS)
    check('every old folder moved to .combwork, none left', folders().join() === ['.combwork', path.join('.combwork', 'assistant', '.combwork'), path.join('alpha', '.combwork')].sort().join(), folders().join())
    const files = fs.readdirSync(path.join(ws, '.combwork'))
    check("the board's file is combwork.db, nothing of the old file left, the names upgrade recorded (HI-2587)", files.includes('combwork.db') && !files.some((f) => f.startsWith(OLD_DB)) && files.includes('combwork-names.json'), files.join())
    const cards = await inv('tasks:list')
    const card = cards.find((c) => c.number === numbers[0])
    check('the board has its cards', numbers.every((n) => cards.some((c) => c.number === n)), cards.map((c) => c.number).join())
    check("the card's link points into .combwork", card?.description === `The screenshot: ![shot](${shot('.combwork')})`, card?.description)
    check('the attachment is there', fs.existsSync(shot('.combwork')))
    const handover = fs.readFileSync(path.join(ws, '.combwork', 'shared', 'handovers', '2026-11-01-evidence.md'), 'utf8')
    check("the handover's path points into .combwork", handover.includes(shot('.combwork')) && !handover.includes(OLD_DIR), handover)
    const tree = JSON.stringify(await inv('notes:tree'))
    check('the shared notes are there', tree.includes('plan.md') && tree.includes('2026-11-01-evidence.md'), tree.slice(0, 300))
    // A link kept elsewhere by its old path (a transcript, the journal) still opens: through the map.
    // Shown as the window shows an image (combwork-img:, which the page's policy allows for images).
    const shown = (p) => page.evaluate((src) => new Promise((res) => {
      const img = new Image()
      img.addEventListener('load', () => res(img.naturalWidth), { once: true })
      img.addEventListener('error', () => res(0), { once: true })
      img.src = `combwork-img://img/${encodeURIComponent(src)}`
    }), p)
    const width = await shown(shot(OLD_DIR))
    check('an old link to the attachment still opens', width === 64, String(width))
    check('…and a path into an old folder that never moved does not', (await shown(path.join(ws, 'nowhere', OLD_DIR, 'attachments', 'x.png'))) === 0)
    check("git's exclude line follows", /^\/\.combwork\/$/m.test(fs.readFileSync(exclude, 'utf8')) && !fs.readFileSync(exclude, 'utf8').split(/\r?\n/).includes(OLD_LINE), fs.readFileSync(exclude, 'utf8'))
    const project = JSON.parse(fs.readFileSync(path.join(alpha, '.combwork', 'project.json'), 'utf8'))
    check('the project keeps its agent', (project.agents ?? []).some((a) => a.id === 'a-coder'), JSON.stringify(project.agents))
    check('the move finished: its plan gone, its map kept', !fs.existsSync(path.join(ws, '.combwork', 'combwork-move.json')) && fs.existsSync(path.join(ws, '.combwork', 'combwork-moved.json')))
    // Opened again (another workspace, then this one): nothing moves twice.
    const other = path.join(lib.WORK, 'combworkfolder-other')
    fs.rmSync(other, { recursive: true, force: true })
    fs.mkdirSync(other, { recursive: true })
    await lib.openWorkspace(inv, page, other, HUNG_MS)
    await lib.openWorkspace(inv, page, ws, HUNG_MS)
    check('opened again, nothing changes', folders().join() === ['.combwork', path.join('.combwork', 'assistant', '.combwork'), path.join('alpha', '.combwork')].sort().join() && (await inv('tasks:list')).find((c) => c.number === numbers[0])?.description === card?.description)
  } finally {
    await app.close()
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
