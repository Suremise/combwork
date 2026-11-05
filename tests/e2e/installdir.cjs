// A folder Combwork runs from whose permissions have an entry for an AppContainer package but none for ALL APPLICATION
// PACKAGES makes Electron refuse to start, with nothing on screen (#431). Combwork checks at start (src/main/installDir.ts):
// it adds the entry when it can (to the folder, and to the file Electron checks if that doesn't inherit it), and when it
// can't, says what to run and quits. Dev build, throwaway profile; the folders checked are test folders of the suite's
// (HIVE_TEST_INSTALL_DIR), never Combwork's own; the message is recorded (HIVE_TEST_NOTIFY_LOG) and drawn to a picture,
// never shown.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const PACKAGE = 'S-1-15-2-1430448594-2639229838-973813799-439329657-1197984847-4069167804-1277922394'
const FOLDER_ENTRY = '*S-1-15-2-1:(OI)(CI)(RX)'
const FILE_ENTRY = '*S-1-15-2-1:(RX)'
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take.
const HUNG_MS = 30000
const system32 =(...p) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', ...p)
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const run = (...args) => spawnSync(system32('icacls.exe'), args, { encoding: 'utf8', windowsHide: true, env: lib.baseEnv() })
/** A file's or folder's DACL as SDDL. */
const sddl = (p) => {
  const out = path.join(lib.WORK, 'installdir-acl.txt')
  fs.rmSync(out, { force: true })
  run(p, '/save', out)
  return fs.existsSync(out) ? (fs.readFileSync(out, 'utf16le').split(/\r?\n/)[1] ?? '') : ''
}
const lacks = (p) => sddl(p).includes(PACKAGE) && !/;(AC|S-1-15-2-1)\)/.test(sddl(p))
const has = (p) => /;AC\)/.test(sddl(p))

const userData = path.join(lib.WORK, 'installdir-profile')
const notifyLog = path.join(lib.WORK, 'installdir-notify.log')

/** Starts Combwork on a test folder it can't fix and returns its exit code and the message it recorded. */
async function cantStart(dir, vars = {}) {
  fs.rmSync(notifyLog, { force: true })
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47883), HIVE_TEST_INSTALL_DIR: dir, HIVE_TEST_NOTIFY_LOG: notifyLog, ...vars })
  const child = spawn(lib.ELECTRON, [lib.ROOT], { cwd: lib.ROOT, env, stdio: 'ignore' })
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill()
      resolve('still running after 60 s')
    }, 60_000)
    child.on('exit', (c) => {
      clearTimeout(timer)
      resolve(c)
    })
  })
  const notes = fs.existsSync(notifyLog) ? fs.readFileSync(notifyLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []
  return { code, message: notes.find((n) => n.kind === 'dialog'), notes }
}

/**
 * What the message's command, pasted into PowerShell, gives icacls: one argument list per call (icacls itself stood
 * in for by a function that prints what it was given).
 */
function pasted(message) {
  const command = message?.body.split('\n').pop() ?? ''
  const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; function icacls { ConvertTo-Json -Compress -InputObject @($args) }; ${command}`
  const ps = spawnSync(system32('WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, env: lib.baseEnv() })
  try {
    return { calls: ps.stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l)), detail: `${command} → ${ps.stdout}${ps.stderr}` }
  } catch {
    return { calls: null, detail: `${command} → ${ps.stdout}${ps.stderr}` }
  }
}

;(async () => {
  const fixable = path.join(lib.WORK, 'installdir-fixable')
  // A name with what PowerShell or cmd would otherwise expand or end a string at.
  const locked = path.join(lib.WORK, `installdir-locked O'Brien $HOME %TEMP% ${String.fromCharCode(0x2019)}x`)
  const fileLocked = path.join(lib.WORK, 'installdir-file-locked')
  const snapshot = path.join(lib.WORK, 'installdir-message.png')
  for (const p of [userData, fixable, locked, fileLocked, notifyLog, snapshot]) fs.rmSync(p, { recursive: true, force: true })
  for (const p of [fixable, locked, fileLocked]) fs.mkdirSync(p, { recursive: true })

  // A folder of the user's with its permissions made explicit and a package's entry added, holding the file Electron
  // checks with permissions of its own (inheriting nothing): Combwork adds the missing entry to the folder, and to the file,
  // which the folder's entry doesn't reach.
  run(fixable, '/inheritance:d')
  run(fixable, '/grant', `*${PACKAGE}:(OI)(CI)(RX)`)
  const icu = path.join(fixable, 'icudtl.dat')
  fs.writeFileSync(icu, 'test')
  run(icu, '/inheritance:d')
  for (const p of [fixable, icu]) check(`${path.basename(p)} has a package entry and no ALL APPLICATION PACKAGES`, lacks(p), sddl(p))
  check('icudtl.dat inherits nothing', sddl(icu).startsWith('D:P'), sddl(icu))
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47883), HIVE_TEST_INSTALL_DIR: fixable, HIVE_TEST_NOTIFY_LOG: notifyLog })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  await lib.appReady(page)
  check('Combwork started', true)
  check('it added ALL APPLICATION PACKAGES to the folder, read and inherited', /\(A;OICI;0x1200a9;;;AC\)/.test(sddl(fixable)), sddl(fixable))
  check('and to the file Electron checks, read', /\(A;;0x1200a9;;;AC\)/.test(sddl(icu)), sddl(icu))
  await app.close()
  // Its lines, written by the log's own thread (HI-1730), in words: a profile that never saved a key masks nothing (HI-1855).
  const logFile = path.join(userData, 'logs', 'combwork.log')
  const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '')
  const said = await lib.until(() => readLog().includes("icudtl.dat doesn't inherit") && readLog().includes('Added ALL APPLICATION PACKAGES to the install folder'), HUNG_MS)
  check('its log says so', !!said, readLog().split('\n').filter((l) => l.includes('[installDir]')).join(' | '))

  // A folder the user can't change the permissions of (the owner held to reading by OWNER RIGHTS): Combwork can't add it,
  // so it says what to run and quits instead of starting.
  run(locked, '/grant:r', '*S-1-3-4:(OI)(CI)(RX)', `*${PACKAGE}:(OI)(CI)(RX)`, '/inheritance:r')
  run(locked, '/grant', FOLDER_ENTRY)
  check("the locked folder's permissions can't be changed", lacks(locked), sddl(locked))
  const a = await cantStart(locked, { HIVE_TEST_DIALOG_SNAPSHOT: snapshot })
  check('Combwork quit with an error instead of starting', a.code === 1, String(a.code))
  check("it told the user Combwork can't start", a.message?.title === "Combwork can't start", JSON.stringify(a.notes))
  check('naming the folder', !!a.message?.body.includes(`the folder Combwork is installed in:\n${locked}\n`), a.message?.body)
  const pa = pasted(a.message)
  check('with the command to run in PowerShell, exactly', JSON.stringify(pa.calls) === JSON.stringify([[locked, '/grant', FOLDER_ENTRY]]), pa.detail)
  // Drawn without its text and buttons, the window is about 3 KB; with them, over 10 KB.
  const drawn = fs.existsSync(snapshot) ? fs.statSync(snapshot).size : 0
  check('the message window draws, with its text and buttons (Windows Forms in PowerShell)', drawn > 8000, `${drawn} bytes`)

  // A folder Combwork can change, holding the file Electron checks inheriting nothing, with a package's entry, and its owner
  // held to reading it: the folder gets the entry, the file can't, so Combwork names the file and gives the command that
  // adds the entry to the folder and to the file (the folder's alone, which it just added, wouldn't reach it).
  run(fileLocked, '/inheritance:d')
  run(fileLocked, '/grant', `*${PACKAGE}:(OI)(CI)(RX)`)
  const lockedIcu = path.join(fileLocked, 'icudtl.dat')
  fs.writeFileSync(lockedIcu, 'test')
  run(lockedIcu, '/grant:r', '*S-1-3-4:(RX)', `*${PACKAGE}:(RX)`, '/inheritance:r')
  run(lockedIcu, '/grant', FILE_ENTRY)
  check("the locked icudtl.dat's permissions can't be changed", lacks(lockedIcu), sddl(lockedIcu))
  const b = await cantStart(fileLocked)
  check('Combwork quit with an error instead of starting', b.code === 1, String(b.code))
  check('having added the entry to the folder', has(fileLocked), sddl(fileLocked))
  check('naming the file that still lacks it', !!b.message?.body.includes(`a file in the folder Combwork is installed in:\n${lockedIcu}\n`), b.message?.body)
  const pb = pasted(b.message)
  check('with the command for the folder, then the file', JSON.stringify(pb.calls) === JSON.stringify([[fileLocked, '/grant', FOLDER_ENTRY], [lockedIcu, '/grant', FILE_ENTRY]]), pb.detail)

  // The locked folder and file go with their parents' permission to delete what they hold.
  for (const p of [locked, fileLocked]) fs.rmSync(p, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
