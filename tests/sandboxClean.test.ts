// The clean-install check's search (HI-2592, tests/sandbox/clean.cjs) and its report (report.cjs, scenario 9): the old name
// planted in each place it searches (file and folder names, text files, logs, a profile's database, the workspace's
// .git, the registry, the agent's environment, the window's text, Copy Diagnostics and the export) is found with its
// place and text, nothing else is, and app.asar's hits are counted but never fail the check.
import assert from 'assert'
import fs from 'fs'
import { createRequire } from 'module'
import path from 'path'
import { test } from 'vitest'
import { tempDir } from './tempDir'

const require = createRequire(import.meta.url)
// What the scan writes and the report reads is plain JSON.
// oxlint-disable-next-line typescript/no-explicit-any
type Json = Record<string, any>
const { CATEGORIES, oldNameHits, tally, scanText, scanTree, regEntries, newRegistryHits, cleanChecks } = require('./sandbox/clean.cjs')
const { evaluate, markdown, verdict, REQUIRED } = require('./sandbox/report.cjs')

const write = (file: string, data: string | Buffer): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, data)
}
const places = (t: Json, category: string): string[] => t.places[category].hits.map((h: Json) => h.place)

// The planted cases: the old name in each form and place the search must find, beside the ordinary words it passes.
// old-name: begin sandboxClean-cases
test('a hit: "hive" in any case, alone or joined (as HG1\'s sweep read it); not inside an ordinary word', () => {
  const hits = ['Hive', 'HIVE', 'hive_test', 'cw-hive-mcp', '.hive/', "Hive's", 'hiveGuidance', 'getHive()', 'CW_HIVE_X', 'Hive Desktop', 'hive.db', 'x/hive', '2hive', 'hives']
  for (const h of hits) assert.strictEqual(oldNameHits(h).length, 1, h)
  const not = ['archive', 'Archive', 'ARCHIVE', 'archived', 'chives', 'beehive', 'Combwork', 'hiv e', '']
  for (const n of not) assert.deepStrictEqual(oldNameHits(n), [], n)
  // Each hit carries its line, shortened around it, and several on a line are each counted.
  const [a, b] = oldNameHits('first line\nthe Hive app, archive, hive.log\nlast')
  assert.strictEqual(a.text, 'the Hive app, archive, hive.log')
  assert.strictEqual(b.match, 'hive')
  assert.strictEqual(oldNameHits(`${'x'.repeat(200)} hive ${'y'.repeat(200)}`)[0].text.length, 80 + 4 + 80 + 2)
})

test('a folder: names and text files searched, logs apart, a profile\'s binaries read, the install folder\'s left unread, app.asar counted apart', () => {
  const dir = tempDir('sandbox-clean-tree-')
  const install = path.join(dir, 'Programs', 'Combwork')
  write(path.join(install, 'Combwork.exe'), Buffer.from('MZ\0\0 Hive inside Electron\0'))
  write(path.join(install, 'LICENSES.chromium.html'), '<p>archive libraries</p>')
  write(path.join(install, 'resources', 'hive-skills', 'SKILL.md'), '# A skill\n')
  write(path.join(install, 'resources', 'notes.txt'), 'Made by Combwork.\nHive Desktop moved.\n')
  write(path.join(install, 'resources', 'utf16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('From HIVE_USER_DATA', 'utf16le')]))
  write(path.join(install, 'resources', 'app.asar'), Buffer.from('\0\0{"files":{"hiveGuidance.js":{}}}\0 .hive hive.db \0'))
  const local = path.join(dir, 'Local', 'Combwork')
  write(path.join(local, 'logs', 'main.log'), 'started\nopened C:\\w\\.hive\\hive.db\n')
  write(path.join(local, 'combwork.db'), Buffer.from('SQLite format 3\0\0\0 card: Hive-Card trailer \0'))
  write(path.join(local, 'clean.json'), '{"ok":true}')
  const ws = path.join(dir, 'Clean')
  write(path.join(ws, 'demo', '.git', 'info', 'exclude'), '# git ls-files --others\n.hive/\n')
  write(path.join(ws, 'demo', '.git', 'objects', 'ab', 'cdef'), Buffer.from('x\0compressed hive bytes'))
  write(path.join(ws, 'demo', '.gitignore'), 'node_modules\n')
  write(path.join(ws, 'demo', 'README.md'), '# demo\n')
  write(path.join(ws, '.combwork', 'hive.log'), 'a log under its old name\n')

  const t = tally()
  assert.ok(scanTree(t, 'install', install) > 0)
  scanTree(t, 'local', local, { binary: 'scan' })
  scanTree(t, 'workspace', ws, { binary: 'scan', skip: (rel: string) => /(^|\/)\.git\/objects\//.test(rel) })
  // The install folder: a folder's name and two text files (UTF-8 and UTF-16); Combwork.exe's bytes unread, app.asar apart.
  assert.deepStrictEqual(places(t, 'install').sort(), [path.join(install, 'resources', 'hive-skills'), path.join(install, 'resources', 'notes.txt'), path.join(install, 'resources', 'utf16.txt')].sort())
  assert.deepStrictEqual(t.places.install.hits.find((h: Json) => h.place.endsWith('notes.txt')).text, 'Hive Desktop moved.')
  assert.deepStrictEqual(t.asar, [{ place: path.join(install, 'resources', 'app.asar'), count: 3 }])
  // The profile's database is the app's own: read as bytes. Its log goes under logs.
  assert.deepStrictEqual(places(t, 'local'), [path.join(local, 'combwork.db')])
  assert.match(t.places.local.hits[0].text, /Hive-Card trailer/)
  // main.log names .hive and hive.db (two hits); hive.log only by its name.
  assert.deepStrictEqual(places(t, 'logs').sort(), [path.join(local, 'logs', 'main.log'), path.join(local, 'logs', 'main.log'), path.join(ws, '.combwork', 'hive.log')].sort())
  // The workspace: .git/info/exclude read; .git/objects named, not read.
  assert.deepStrictEqual(places(t, 'workspace'), [path.join(ws, 'demo', '.git', 'info', 'exclude')])
  assert.strictEqual(t.places.workspace.hits[0].text, '.hive/')
  // Every folder and file was counted as searched (names), so a place with nothing in it can't pass.
  assert.ok(t.places.workspace.scanned >= 8, String(t.places.workspace.scanned))
  // A folder that isn't there: nothing searched.
  assert.strictEqual(scanTree(t, 'roaming', path.join(dir, 'Roaming', 'Combwork')), 0)
  assert.strictEqual(t.places.roaming.scanned, 0)
})

test('a folder or file that can\'t be read is counted against its place, with why (HR1, round 1)', () => {
  const dir = tempDir('sandbox-clean-unread-')
  const ws = path.join(dir, 'Clean')
  write(path.join(ws, 'demo', 'README.md'), '# demo\n')
  write(path.join(ws, 'locked', 'inside.txt'), 'Hive, unseen')
  write(path.join(ws, 'demo', 'busy.json'), '{"hive":1}')
  write(path.join(ws, 'logs', 'busy.log'), 'hive.log')
  // As Windows answers a folder it may not list, and files another process holds open without sharing.
  const { readdirSync, openSync } = fs
  const deny = (p: unknown, what: string): never => { throw Object.assign(new Error(`EPERM: operation not permitted, ${what} '${String(p)}'`), { code: 'EPERM' }) }
  fs.readdirSync = ((p: fs.PathLike, o?: unknown) => (String(p) === path.join(ws, 'locked') ? deny(p, 'scandir') : (readdirSync as (a: unknown, b?: unknown) => unknown)(p, o))) as typeof fs.readdirSync
  fs.openSync = ((p: fs.PathLike, ...rest: unknown[]) => (/busy\./.test(String(p)) ? deny(p, 'open') : (openSync as (...a: unknown[]) => number)(p, ...rest))) as typeof fs.openSync
  const t = tally()
  try {
    scanTree(t, 'workspace', ws, { binary: 'scan' })
  } finally {
    fs.readdirSync = readdirSync
    fs.openSync = openSync
  }
  assert.strictEqual(t.places.workspace.count, 0)
  assert.strictEqual(t.places.workspace.unread, 2)
  assert.strictEqual(t.places.logs.unread, 1)
  assert.deepStrictEqual(t.skipped.map((s: Json) => [s.category, path.relative(ws, s.place)]).sort(), [['logs', path.join('logs', 'busy.log')], ['workspace', 'locked'], ['workspace', path.join('demo', 'busy.json')]].sort())
  // Its check fails, naming each with why, though nothing that was read had a hit.
  const scan = { places: t.places, asar: [{ place: 'app.asar', count: 0 }], skipped: t.skipped }
  for (const c of CATEGORIES) if (!scan.places[c.id].scanned) scanText(t, c.id, `${c.id} place`, 'Combwork')
  const failed = collect(scan).filter((c) => !c.ok)
  assert.deepStrictEqual(failed.map((c) => c.id), ['9.no-old-name-workspace', '9.no-old-name-logs'])
  assert.match(failed[0].detail, /^2 not read: /)
  assert.match(failed[0].detail, /locked \(EPERM: operation not permitted, scandir /)
  assert.match(failed[0].detail, /busy\.json \(EPERM: operation not permitted, open /)
  assert.doesNotMatch(failed[0].detail, /hit/)
})

// reg query HKCU /f hive /s, as reg.exe prints it: before the install, Windows' own entries, one only "archive".
const REG_BEFORE = [
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Archive',
  '    Last    REG_SZ    C:\\Users\\WDAGUtilityAccount\\archive.zip',
  '',
  'HKEY_CURRENT_USER\\System\\HiveList',
  '    Kept    REG_SZ    by Windows',
  'End of search: 3 match(es) found.'
].join('\r\n')
const REG_AFTER = [
  REG_BEFORE.replace('End of search: 3 match(es) found.', ''),
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\10a7595a-0e90-558c-b6b6-ae33bdd80748',
  '    DisplayName    REG_SZ    Combwork 1.1.0',
  '    Comments    REG_SZ    Was Hive Desktop',
  'HKEY_CURRENT_USER\\Software\\Classes\\hive',
  '    URL Protocol    REG_SZ    ',
  'End of search: 6 match(es) found.'
].join('\r\n')

test('the registry: only what the install added and names "hive" is a hit, with its key, value and data', () => {
  assert.deepStrictEqual(regEntries(REG_BEFORE), [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Archive',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Archive\\Last = C:\\Users\\WDAGUtilityAccount\\archive.zip',
    'HKEY_CURRENT_USER\\System\\HiveList',
    'HKEY_CURRENT_USER\\System\\HiveList\\Kept = by Windows'
  ])
  assert.deepStrictEqual(newRegistryHits(REG_BEFORE, REG_AFTER), [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\10a7595a-0e90-558c-b6b6-ae33bdd80748\\Comments = Was Hive Desktop',
    'HKEY_CURRENT_USER\\Software\\Classes\\hive',
    'HKEY_CURRENT_USER\\Software\\Classes\\hive\\URL Protocol = '
  ])
  assert.deepStrictEqual(newRegistryHits(REG_BEFORE, REG_BEFORE), [])
  const t = tally()
  scanText(t, 'registry', 'HKCU, what was added since the install', newRegistryHits(REG_BEFORE, REG_AFTER).join('\n'))
  assert.strictEqual(t.places.registry.count, 3)
})

test("the agent's environment, the window's text, Copy Diagnostics and the shortcuts: each hit named by its place", () => {
  const t = tally()
  const env = 'CW_AGENT=a-1\r\nPATH=C:\\Windows;C:\\Users\\u\\AppData\\Local\\Programs\\Combwork\\resources\\hive-bin\r\nHIVE_API_URL=http://127.0.0.1:47821\r\nTEMP=C:\\Temp\\archive'
  for (const line of env.split(/\r?\n/)) scanText(t, 'env', `env ${line.split('=')[0]}`, line)
  assert.deepStrictEqual(places(t, 'env'), ['env PATH', 'env HIVE_API_URL'])
  scanText(t, 'window', 'window: Settings: general', 'Combwork\nGeneral\nStart Hive at login | Launch at login')
  scanText(t, 'window', 'window: board', 'Task Board\nA first card')
  assert.deepStrictEqual(t.places.window.hits, [{ place: 'window: Settings: general', text: 'Start Hive at login | Launch at login' }])
  scanText(t, 'diagnostics', 'Copy Diagnostics', 'Combwork 1.1.0\nLog: hive.log (last 50 lines)')
  assert.strictEqual(t.places.diagnostics.hits[0].text, 'Log: hive.log (last 50 lines)')
  scanText(t, 'shortcuts', 'C:\\Desktop\\Combwork.lnk', JSON.stringify({ target: 'C:\\Programs\\Combwork\\Combwork.exe', appUserModelId: 'com.hive.desktop' }))
  assert.match(t.places.shortcuts.hits[0].text, /com\.hive\.desktop/)
})

/** A scan as clean-scan.cjs writes it: every place searched, nothing found, app.asar's hits counted. */
const cleanScan = (): Json => {
  const t = tally()
  for (const c of CATEGORIES) scanText(t, c.id, `${c.id} place`, 'Combwork')
  t.asar.push({ place: 'C:\\Programs\\Combwork\\resources\\app.asar', count: 41 })
  return { at: 't', places: t.places, asar: t.asar, skipped: [] }
}
const collect = (scan: Json): Json[] => {
  const checks: Json[] = []
  cleanChecks(scan, (id: string, name: string, ok: boolean, detail: string) => checks.push({ id, name, ok, detail }))
  return checks
}

test("the check: passes on a scan with no hits, app.asar's hits counted but not failed", () => {
  const checks = collect(cleanScan())
  assert.deepStrictEqual(checks.map((c) => c.id), [...CATEGORIES.map((c: Json) => `9.no-old-name-${c.id}`), '9.asar-counted'])
  assert.ok(checks.every((c) => c.ok), JSON.stringify(checks.filter((c) => !c.ok)))
  assert.strictEqual(checks.at(-1)?.name, "app.asar's own hits counted, not failed: 41")
})

test('the check: a hit fails its place with the place and text; a place not searched fails too, never a silent pass', () => {
  const scan = cleanScan()
  const t = { places: scan.places, asar: [], skipped: [] }
  scanText(t, 'env', 'env HIVE_API_URL', 'HIVE_API_URL=http://127.0.0.1:47821')
  scan.places.export = { scanned: 0, count: 0, hits: [], why: 'no exported board (the driver named none)' }
  scan.asar = []
  const failed = collect(scan).filter((c) => !c.ok)
  assert.deepStrictEqual(failed.map((c) => [c.id, c.detail]), [
    ['9.no-old-name-env', '1 hit: env HIVE_API_URL: HIVE_API_URL=http://127.0.0.1:47821'],
    ['9.no-old-name-export', 'not searched: no exported board (the driver named none)'],
    ['9.asar-counted', 'no app.asar in the install folder']
  ])
})

/** The clean kind's report: its install, its driver (every step passed) and its scan. */
const report = (scan: Json): Json => {
  const req = REQUIRED.clean.drivers.s9
  const s9 = { completed: true, checks: req.ids.map((id: string) => ({ id, scenario: 9, name: `check ${id}`, ok: true })), facts: { version: '1.1.0', workspace: 'C:\\w', exportDir: 'C:\\e' } }
  const meta = { app: { productName: 'Combwork', shortcutName: 'Combwork', exeName: 'Combwork' }, installer: 'Combwork-Setup-1.1.0.exe', installerVersion: '1.1.0', ran: ['clean'], date: 'd', hostBuild: '10.0.26200', minutes: '9.0', shots: REQUIRED.clean.shots, steps: [{ scenario: 9, what: '9. install', ok: true }] }
  return evaluate(meta, { 's9-run': { exitCode: 0, seconds: 20 }, s9, 's9-scan': scan })
}

test('the report: scenario 9 passes with no hits and notes app.asar\'s count; a hit fails it and is listed with its place and text', () => {
  const ok = report(cleanScan())
  assert.strictEqual(ok.failed, 0, JSON.stringify(ok.checks.filter((c: Json) => !c.ok)))
  assert.strictEqual(verdict(ok), `PASSED: all ${ok.checks.length} checks`)
  assert.ok(ok.checks.length >= 1 + 12 + CATEGORIES.length + 1)
  const md = markdown(ok)
  assert.match(md, /## 9\. A clean install used as a new user would, then searched: no trace of the old name anywhere \(HI-2592\)/)
  assert.match(md, /- \*\*app\.asar\*\* holds 41 hit\(s\) of the old name \(C:\\Programs\\Combwork\\resources\\app\.asar: 41\): counted, not failed\./)
  assert.doesNotMatch(md, /Where the old name was found/)

  const scan = cleanScan()
  const t = { places: scan.places, asar: [], skipped: [] }
  scanText(t, 'window', 'window: Settings: general', 'Start Hive at login')
  scanText(t, 'roaming', 'C:\\Users\\u\\AppData\\Roaming\\Combwork\\hive.log', 'hive.log')
  const bad = report(scan)
  assert.strictEqual(bad.failed, 2)
  const md2 = markdown(bad)
  assert.match(md2, /\*\*FAILED: 2 of \d+ checks\*\*/)
  assert.match(md2, /## 9\. Where the old name was found/)
  assert.match(md2, /\| window: Settings: general \| Start Hive at login \|/)
  assert.match(md2, /\| C:\\Users\\u\\AppData\\Roaming\\Combwork\\hive\.log \| hive\.log \|/)
})
// old-name: end sandboxClean-cases

// The clean step (drive.cjs) drives Combwork's window, IPC and palette, and hands clean-scan.cjs its files: when one
// changes, the check would fail only at the next release candidate. Checked here, so both are fixed together.
test('what the clean step relies on is still there, and it hands the scan the files it reads', () => {
  const root = path.resolve(__dirname, '..')
  const inside = path.join(__dirname, 'sandbox', 'inside')
  const drive = fs.readFileSync(path.join(inside, 'drive.cjs'), 'utf8')
  const scan = fs.readFileSync(path.join(inside, 'clean-scan.cjs'), 'utf8')
  const api = fs.readFileSync(path.join(root, 'src', 'shared', 'api.ts'), 'utf8')
  const commands = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'commands.ts'), 'utf8')
  const ui = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'components', 'ui.tsx'), 'utf8')
  const english = fs.readdirSync(path.join(root, 'locales', 'en')).map((f) => fs.readFileSync(path.join(root, 'locales', 'en', f), 'utf8')).join('\n')
  const channels = ['connections:add', 'connections:signIn', 'agents:add', 'session:start', 'session:stop', 'pty:buffer', 'pty:write', 'tasks:create', 'workspace:open', 'provider:info']
  const missing = [
    ...channels.filter((c) => !api.includes(`'${c}'`)).map((c) => `IPC ${c} (src/shared/api.ts)`),
    ...channels.filter((c) => !drive.includes(`'${c}'`)).map((c) => `IPC ${c} not used by drive.cjs`),
    ...['help.diagnostics', 'task.exportBoard'].filter((id) => !commands.includes(`id: '${id}'`) || !drive.includes(`'${id}'`)).map((id) => `palette command ${id}`),
    ...['settings-nav', 'data-section'].filter((c) => !ui.includes(c)).map((c) => `selector ${c} (ui.tsx)`),
    ...['Copy Diagnostics', 'Export Board to JSON', 'Choose providers', 'Use {name}'].filter((t) => !english.includes(t)).map((t) => `text "${t}" (locales/en)`)
  ]
  assert.deepStrictEqual(missing, [])
  // The agent's first task reaches the fake as its prompt (StartOptions.prompt), which runs `shell: set`.
  assert.match(fs.readFileSync(path.join(root, 'src', 'main', 'sessions.ts'), 'utf8'), /interface StartOptions \{[^}]*\bprompt\?: string/)
  // Every check the report requires of the step is one it records.
  for (const id of REQUIRED.clean.drivers.s9.ids) assert.ok(drive.includes(`check('${id}'`), id)
  // What the step writes is what the scan reads.
  for (const f of ['window.json', 'diagnostics.txt', 'agent-env.txt']) {
    assert.ok(drive.includes(`\`\${prefix}-${f}\``), `drive.cjs writes ${f}`)
    assert.ok(scan.includes(`out('${f}')`), `clean-scan.cjs reads ${f}`)
  }
  // Logs are found inside the folders it searches (clean.cjs scanTree): none at all fails 9.no-old-name-logs.
  for (const c of CATEGORIES.filter((x: Json) => x.id !== 'logs')) assert.ok(scan.includes(`'${c.id}'`), `clean-scan.cjs searches ${c.id}`)
})

test('the report: a place with something unread fails, and the report lists it with why', () => {
  const scan = cleanScan()
  scan.places.local.unread = 1
  scan.skipped = [{ category: 'local', place: 'C:\\Users\\u\\AppData\\Local\\Combwork\\combwork.db', why: 'EBUSY: resource busy or locked' }]
  const r = report(scan)
  assert.deepStrictEqual(r.checks.filter((c: Json) => !c.ok).map((c: Json) => c.detail), ['1 not read: C:\\Users\\u\\AppData\\Local\\Combwork\\combwork.db (EBUSY: resource busy or locked)'])
  assert.match(markdown(r), /### Not read: 1\n\n\| Place \| Why \|\n\|---\|---\|\n\| C:\\Users\\u\\AppData\\Local\\Combwork\\combwork\.db \| EBUSY: resource busy or locked \|/)
})

test('the report: a clean run whose scan or driver is missing fails, never a silent gap', () => {
  const r = evaluate({ app: {}, installerVersion: '1.1.0', ran: ['clean'], shots: [], steps: [] }, {})
  const names = r.checks.filter((c: Json) => !c.ok).map((c: Json) => c.name)
  for (const n of ['s9-run: result recorded', 's9: result recorded', 's9-scan: result recorded', 'Screenshot s9-desktop.jpg collected']) assert.ok(names.includes(n), names.join('\n'))
})
