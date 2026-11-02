// The onclose suite's close command (HI-1368): what a backup tool would check, and how a slow, chatty or failing one
// behaves. Arguments: <marker file> <label> <reason> <workspace folder or "-"> [mode], mode one of:
//   quick           check the workspace and write the marker at once
//   wait:<file>     print a line every 100 ms until <file> exists, then check and write the marker
//   chatty:<file>   print about 200 KB of output at a time until <file> exists, then check and write the marker
//   fail            print two lines and exit 3 (no marker)
//   flag:<file>     as fail until <file> exists, then as quick (the onopen suite's Rerun, HI-1954)
// The check: hive.db copied, the copy opened with node:sqlite, its integrity_check and its cards' titles read, and
// whether a -wal with anything in it was left beside the original (it shouldn't be, once Hive has closed the board).
const fs = require('fs')
const path = require('path')

const [marker, label, reason, workspace, mode = 'quick'] = process.argv.slice(2)

function check() {
  const out = { label, reason, at: Date.now() }
  if (workspace && workspace !== '-') {
    const db = path.join(workspace, '.hive', 'hive.db')
    const wal = `${db}-wal`
    out.walLeft = fs.existsSync(wal) ? fs.statSync(wal).size : 0
    const copy = `${marker}.hive.db`
    fs.copyFileSync(db, copy)
    const { DatabaseSync } = require('node:sqlite')
    const c = new DatabaseSync(copy)
    try {
      out.integrity = c.prepare('PRAGMA integrity_check').get().integrity_check
      out.titles = c.prepare('SELECT title FROM cards').all().map((r) => r.title)
    } finally {
      c.close()
    }
  }
  fs.writeFileSync(marker, JSON.stringify(out))
}

if (mode === 'fail' || (mode.startsWith('flag:') && !fs.existsSync(mode.slice(5)))) {
  console.log('backing up…')
  console.error('the backup target is missing')
  process.exit(3)
}
if (mode === 'quick' || mode.startsWith('flag:')) {
  check()
  process.exit(0)
}
const [kind, go] = [mode.slice(0, mode.indexOf(':')), mode.slice(mode.indexOf(':') + 1)]
let n = 0
const chunk = `${'z'.repeat(1023)}\n`.repeat(200)
const tick = setInterval(() => {
  if (fs.existsSync(go)) {
    clearInterval(tick)
    console.log('done')
    check()
    process.exit(0)
  }
  if (kind === 'chatty') process.stdout.write(chunk)
  else console.log(`step ${++n}`)
}, 100)
