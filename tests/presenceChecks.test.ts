// The presence-check rule (HI-2617, tests/presenceChecks.mjs): in the upgrade's code and the test area's, no
// existsSync and no handler that swallows an I/O failure, except where tests/presenceAllow.json says why.
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: a plain .mjs module without types
import { ALLOW_FILE, SCOPE, SCOPE_FILES, checkPresence, presenceFindings } from './presenceChecks.mjs'

const root = join(__dirname, '..')
type Finding = { file: string; line: number; rule: string; fn: string; text: string }
type Exception = { file: string; in: string; node: string; why: string }
/** An absence helper defined as the rule reads one (its own definition, never its name). */
const ABSENT = "const absent = (e) => e?.code === 'ENOENT' || e?.code === 'ENOTDIR'\n"
const rules = (src: string, file = 'x.ts'): string[] => (presenceFindings(file, src) as Finding[]).map((f) => f.rule)
const ok = (src: string): void => expect(rules(src), src).toEqual([])
const swallows = (src: string, rule = 'catch: swallows the error'): void => expect(rules(src), src).toEqual([rule])
const exceptions = (): Exception[] => JSON.parse(readFileSync(join(root, ALLOW_FILE), 'utf8')).exceptions
const readRepo = (f: string): string | null => {
  try {
    return readFileSync(join(root, f), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

describe('the presence-check rule (HI-2617)', () => {
  it('finds existsSync however it is named: imported, aliased, a member, by its name in brackets', () => {
    expect(rules("import { existsSync } from 'original-fs'\nif (existsSync(p)) go()")).toEqual(['existsSync', 'existsSync'])
    expect(rules("import { existsSync as there } from 'fs'\nthere(p)")).toEqual(['existsSync'])
    expect(rules("const fs = require('fs')\nfs.existsSync(p)")).toEqual(['existsSync'])
    expect(rules("const { existsSync: e } = require('fs')\ne(p)")).toEqual(['existsSync'])
    expect(rules("fs['existsSync'](p)")).toEqual(['existsSync'])
    ok("import { present } from './fsPresence'\nif (present(p)) go()")
  })

  it("finds HI-2612's swallowing handlers, as they were before its fixes", () => {
    // combworkFolder's ours(): existsSync took an old folder it couldn't look at for one not there.
    expect(rules("function ours(dir) { if (existsSync(join(dir, 'project.json'))) return true; return false }")).toEqual(['existsSync'])
    // warnRecreated's plainFolder(): a failed look taken for "not a plain folder".
    swallows('for (const h of hosts) if (h.marked && (await plainFolder(h.host).catch(() => false))) warn(h.host)', '.catch: swallows the error')
    // removeOldShims(): a shim it couldn't remove taken for removed.
    swallows('for (const name of OLD_SHIMS) await rm(join(binDir, name), { force: true }).catch(() => undefined)', '.catch: swallows the error')
    // retireOldCopies(): a marker it couldn't read taken for none.
    expect(rules("const marker = await readFile(join(dest, M), 'utf8').then((t) => JSON.parse(t).hash, () => undefined).catch(() => undefined)")).toEqual(['.then: swallows the error', '.catch: swallows the error'])
    // logger's moveOldLogs(): a rename that failed, taken for done.
    expect(rules('try { if (existsSync(a) && !existsSync(b)) renameSync(a, b) } catch { }')).toEqual(['existsSync', 'existsSync', 'catch: swallows the error'])
  })

  it("passes HI-2612's and HI-2611's handlers as they are after: an absence only, the failure recorded or rethrown", () => {
    for (const src of [
      "const text = await readFile(recordOf(host), 'utf8').catch(ifAbsent(null))",
      "for (const name of OLD_SHIMS) await rm(join(binDir, name), { force: true }).catch((e) => void left.push(`${name} (${e?.code ?? 'error'})`))",
      "const noMarker = (e) => (['ENOENT', 'ENOTDIR'].includes(e?.code ?? '') ? null : Promise.reject(e))\nconst marker = markerHash(await readFile(join(dest, M), 'utf8').catch(noMarker))",
      `${ABSENT}try { statSync(p); return true } catch (e) { if (absent(e)) return false; throw e }`,
      `${ABSENT}export const lstatOrNullAsync = async (p) => { try { return await lstat(p) } catch (e) { if (absent(e)) return null; throw e } }`,
      "try { names = readdirSync(dir) } catch (e) { if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') failed.push(`${dir} (${e.code})`) }",
      "const absent = (e) => { const code = e?.code; return code === 'ENOENT' || code === 'ENOTDIR' }\nconst busy = (file, what) => out.push({ file, what })\nfor (const f of files) { try { st = statSync(f) } catch (e) { if (absent(e)) continue; busy(f, `couldn't look at it (${e.code})`); continue } }",
      "try { renameSync(a, b) } catch (e) { left.push(`${a} (${e?.code ?? 'error'})`) }\nreturn left",
      'try { run() } catch (e) { port.postMessage({ ok: false, error: String(e) }) }',
      'try { await go() } catch (e) { console.error(e.message); process.exit(1) }',
      'const r = await read(f).catch((e) => ({ ok: false, error: e }))',
      'p.catch((e) => Promise.reject(new Wrapped(e)))',
      'try { await go() } catch (e) { result.error = e }',
      // profileFolders' look(): the code kept in a const, the absence answered, anything else returned as the error.
      "try { return statSync(p) } catch (e) { const code = (e as NodeJS.ErrnoException).code; return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : { error: code ?? String(e) } }",
      // A handler that logs, then rethrows.
      `${ABSENT}try { x() } catch (e) { if (absent(e)) return null; log.warn('x', e); throw e }`
    ])
      ok(src)
  })

  it('a handler that only logs, then answers a success, swallows', () => {
    swallows("try { await rename(a, b) } catch (e) { log.warn('rename', e); return true }")
    swallows("const done = await rename(a, b).then(() => true, (e) => (log.warn('rename', e), true))", '.then: swallows the error')
    swallows("const ok = await mark().catch((e) => { log.warn('mark', e) })", '.catch: swallows the error')
    swallows("const ok = await mark().catch((e) => log.warn('mark', e))", '.catch: swallows the error')
    swallows("try { x() } catch (e) { log.warn('x', e) }")
  })

  it('follows every way out: one that answers a success after only the absence is passed on swallows', () => {
    // HR1's round 1: EACCES passed over by a branch that rethrows only the absence.
    swallows("try { readFileSync(p) } catch (e) { if (e.code === 'ENOENT') throw e; return null }")
    // A rethrow on one branch only.
    swallows(`${ABSENT}try { x() } catch (e) { if (absent(e)) return null; if (strict) throw e; return true }`)
    swallows("try { x() } catch (e) { if (busy(e)) { throw e } else { log.warn('x', e) } }")
    // The absence's own branch may answer anything; every other way must pass it on.
    ok("try { x() } catch (e) { if (e.code !== 'ENOENT') throw e; return null }")
    ok(`${ABSENT}try { x() } catch (e) { if (absent(e)) { return null } else { throw e } }`)
    // Only the absence's codes: another beside them isn't an absence.
    swallows("const f = (e) => (['ENOENT', 'EACCES'].includes(e?.code ?? '') ? null : Promise.reject(e))\nawait rm(p).catch(f)", '.catch: swallows the error')
    swallows("try { x() } catch (e) { const code = e.code; return code === 'ENOENT' ? 'missing' : 'present' }")
    swallows(`${ABSENT}try { x() } catch (e) { if (absent(e) || e.code === 'EACCES') return null; throw e }`)
    // A loop or a switch isn't followed: not taken to pass anything on.
    swallows('try { x() } catch (e) { for (const t of tries) if (t(e)) throw e }')
  })

  it('a record passes the failure on only when the error is in what is recorded', () => {
    // HR1's round 1: an unrelated push beside a success.
    swallows('try { readFileSync(p) } catch (e) { stats.push(1); return true }')
    swallows("try { x() } catch (e) { seen.add(p); log.warn('x', e) }")
    swallows('const count = (n) => tally.push(n)\ntry { x() } catch (e) { count(1); return true }')
    swallows('try { x() } catch (e) { result.done = true }')
    // A record on one branch only.
    swallows('try { x() } catch (e) { if (verbose) left.push(String(e.code)); return true }')
    ok('try { x() } catch (e) { left.push(e.code); return true }')
  })

  it("counts a record, an exit or the error's value only where it happens whatever runs (HR2's round 2)", () => {
    swallows('try { readFileSync(p) } catch (e) { false && failures.push(e); return true }')
    swallows('try { readFileSync(p) } catch (e) { verbose ? failures.push(e) : 0; return true }')
    swallows('try { readFileSync(p) } catch (e) { false && process.exit(1); return true }')
    swallows('function record(e) { if (false) failures.push(e) }\ntry { readFileSync(p) } catch (e) { record(e); return true }')
    swallows('function record(e) { if (!e) return; failures.push(e) }\ntry { readFileSync(p) } catch (e) { record(e); return true }')
    swallows('try { readFileSync(p) } catch (e) { return !!e }')
    swallows("try { readFileSync(p) } catch (e) { return e ? 'failed' : 'ok' }")
    swallows('try { readFileSync(p) } catch (e) { return e instanceof Error }')
    swallows('const r = await readFile(p).catch((e) => !!e)', '.catch: swallows the error')
    swallows('try { readFileSync(p) } catch (e) { flag && (result.error = e); return true }')
    // What does count: a record whatever runs, through a helper that records what it is given first thing, the error wrapped.
    ok('function record(e) { failures.push(e) }\ntry { readFileSync(p) } catch (e) { record(e); return true }')
    ok('try { readFileSync(p) } catch (e) { return new Unreadable(e) }')
    ok('try { readFileSync(p) } catch (e) { return { ok: false, error: e.code || e.message } }')
  })

  it("trusts an absence helper by its definition, never its name (HR2's round 2)", () => {
    swallows("function isAbsent(e) { return ['ENOENT', 'EACCES'].includes(e.code) }\ntry { x() } catch (e) { if (isAbsent(e)) return null; throw e }")
    swallows("const absent = (e) => e?.code === 'ENOENT' || e?.code === 'EACCES'\ntry { x() } catch (e) { if (absent(e)) return null; throw e }")
    swallows("const absent = (e) => { log(e); return e?.code === 'ENOENT' }\ntry { x() } catch (e) { if (absent(e)) return null; throw e }")
    swallows("import { absent } from './elsewhere'\ntry { x() } catch (e) { if (absent(e)) return null; throw e }")
    expect(rules("const { absent } = require('./elsewhere.cjs')\ntry { x() } catch (e) { if (absent(e)) return null; throw e }", 'tests/a.mjs')).toEqual(['catch: swallows the error'])
    ok("function isAbsent(e) { return ['ENOENT', 'ENOTDIR'].includes(e.code) }\ntry { x() } catch (e) { if (isAbsent(e)) return null; throw e }")
    // One APPROVED_ABSENCE names, imported from its module (whose definition checkPresence reads: below).
    expect(rules("const { absent } = require('./testArea.cjs')\ntry { x() } catch (e) { if (absent(e)) return null; throw e }", 'tests/moveTestArea.mjs')).toEqual([])
    expect(rules("const { absent } = require('./testArea.cjs')\ntry { x() } catch (e) { if (absent(e)) return null; throw e }", 'src/main/x.ts')).toEqual(['catch: swallows the error'])
    const misdefined = "const absent = (e) => e?.code === 'ENOENT' || e?.code === 'EACCES'\nmodule.exports = { absent }"
    expect(checkPresence({ scope: [], read: () => misdefined, exceptions: [] }).problems).toEqual(["tests/testArea.cjs: absent, an approved absence helper, isn't an absence test (ENOENT or ENOTDIR only)"])
  })

  it('a parse-only try passes; one that reads and parses, or parses what a read gives, does not', () => {
    ok('try { d = JSON.parse(raw) } catch { return null }')
    ok("try { m = JSON.parse(text.replace(/^\\uFEFF/, '').trim()) } catch { return }")
    ok('try { u = new URL(s) } catch { u = null }')
    swallows("try { const t = readFileSync(f, 'utf8'); d = JSON.parse(t) } catch { return null }")
    swallows("try { d = JSON.parse(readFileSync(f, 'utf8')) } catch { return null }")
    swallows('try { d = JSON.parse(readFileSync(f).toString()) } catch { return null }')
    // A chain's catch covers the read too.
    swallows("const d = await readFile(f, 'utf8').then((t) => JSON.parse(t)).catch(() => null)", '.catch: swallows the error')
  })

  it('queue bookkeeping passes only on a const its function returns at every return, ending with it', () => {
    ok('function inTurn(fn) { const run = prev.then(fn); const settled = run.catch(() => undefined); chains.set(k, settled); return run }')
    swallows('function inTurn(fn) { const run = prev.then(fn); const settled = run.catch(() => undefined); chains.set(k, settled); return settled }', '.catch: swallows the error')
    swallows('async function f() { await rm(p).catch(() => undefined) }', '.catch: swallows the error')
    // HR1's round 1: a return of p that never runs, the caller given a success.
    swallows('function f() { const p = readFile(file); p.catch(() => undefined); if (false) return p; return Promise.resolve(null) }', '.catch: swallows the error')
    swallows('function f() { let p = readFile(file); p.catch(() => undefined); p = other(); return p }', '.catch: swallows the error')
  })

  it("reads a handler of the same file by name, and fails one it can't read", () => {
    swallows('const quiet = () => undefined\nawait rm(p).catch(quiet)', '.catch: swallows the error')
    expect(rules("import { quiet } from './elsewhere'\nawait rm(p).catch(quiet)")).toEqual([".catch: a handler this rule can't read"])
    expect(rules("import { quiet } from './elsewhere'\nawait rm(p).catch(quiet())")).toEqual([".catch: a handler this rule can't read"])
  })

  it('excepts one finding by its file, function and whole text; never a fragment, another function or a second copy, and fails a stale one', () => {
    const swallow = "catch (e) { log.warn('one', e) }"
    const files: Record<string, string> = {
      'a.ts': `function f() { try { x() } ${swallow} }\nfunction g() { try { x() } ${swallow} }\nfunction f2() { try { x() } catch (e) { log.warn('one, again', e) } }`,
      'b.ts': `function f() { try { x() } ${swallow}\ntry { y() } ${swallow} }`
    }
    const { findings, problems } = checkPresence({
      scope: Object.keys(files),
      read: (f: string) => files[f] ?? null,
      approved: {},
      exceptions: [
        { file: 'a.ts', in: 'f', node: swallow, why: '' },
        { file: 'b.ts', in: 'f', node: swallow, why: '' },
        { file: 'b.ts', in: 'f', node: "log.warn('one'", why: '' }
      ]
    })
    expect(findings.map((f: Finding) => `${f.file}:${f.line} ${f.fn}`)).toEqual(['a.ts:2 g', 'a.ts:3 f2', 'b.ts:2 f'])
    expect(problems).toEqual(['exception 2 (b.ts, f) excepts nothing: remove it'])
  })

  it('holds a function SCOPE names, not the rest of its file, and fails a scope that is gone', () => {
    const src = 'export function moveOld(d) { try { renameSync(d, e) } catch { } }\nexport function other() { try { x() } catch { } }'
    expect(checkPresence({ scope: ['log.ts#moveOld'], read: () => src, exceptions: [], approved: {} }).findings.map((f: Finding) => f.fn)).toEqual(['moveOld'])
    expect(checkPresence({ scope: ['log.ts#gone'], read: () => src, exceptions: [], approved: {} }).findings).toEqual([{ file: 'log.ts', line: 0, rule: 'scope', fn: 'gone', text: 'has no function gone: SCOPE names it' }])
    expect(checkPresence({ scope: ['gone.ts'], read: () => null, exceptions: [], approved: {} }).findings).toEqual([{ file: 'gone.ts', line: 0, rule: 'scope', fn: '(top)', text: "isn't there: SCOPE names it" }])
  })
})

describe('presence checks in the repository (HI-2617)', () => {
  it("the upgrade's code and the test area's have none but those tests/presenceAllow.json excepts, each still needed", () => {
    const { findings, problems } = checkPresence({ scope: SCOPE, read: readRepo, exceptions: exceptions() })
    expect(findings).toEqual([])
    expect(problems).toEqual([])
    for (const e of exceptions()) expect(e.why, e.node).toBeTruthy()
    expect(SCOPE_FILES).toContain('src/main/logger.ts')
  })

  it('fails a bare existsSync planted in a file of its scope', () => {
    const planted = `${readRepo('src/main/nameUpgrade.ts')}\nexport const planted = (p: string): boolean => existsSync(p)\n`
    const { findings } = checkPresence({ scope: ['src/main/nameUpgrade.ts'], read: () => planted, exceptions: exceptions(), approved: {} })
    expect(findings.map((f: Finding) => f.rule)).toEqual(['existsSync'])
  })

  it("a second swallowing handler can't reuse an exception made for another (HR1's round 1)", () => {
    const planted = `${readRepo('src/main/nameUpgradeFiles.ts')}\nexport function planted(p: string): boolean {\n  try {\n    readFileSync(p)\n  } catch (e) {\n    log.warn('later(', e)\n    return true\n  }\n  return false\n}\n`
    const { findings, problems } = checkPresence({ scope: ['src/main/nameUpgradeFiles.ts'], read: () => planted, exceptions: exceptions().filter((e) => e.file === 'src/main/nameUpgradeFiles.ts'), approved: {} })
    expect(findings.map((f: Finding) => `${f.fn} ${f.rule}`)).toEqual(['planted catch: swallows the error'])
    expect(problems).toEqual([])
  })

  it("fails moveOldLogs' old existsSync and empty catch planted back into it (logger.ts, by its function)", () => {
    const src = readRepo('src/main/logger.ts')!
    const before = src
      .replace('if (present(join(dir, from)) && !present(join(dir, to))) renameSync', 'if (existsSync(join(dir, from)) && !existsSync(join(dir, to))) renameSync')
      .replace(/\} catch \(e\) \{\r?\n\s*left\.push\([^\n]*\r?\n\s*\}/, '} catch {\n    }')
    expect(before).not.toBe(src)
    const { findings } = checkPresence({ scope: ['src/main/logger.ts#moveOldLogs'], read: () => before, exceptions: [], approved: {} })
    expect(findings.map((f: Finding) => `${f.fn} ${f.rule}`)).toEqual(['moveOldLogs existsSync', 'moveOldLogs existsSync', 'moveOldLogs catch: swallows the error'])
    expect(checkPresence({ scope: ['src/main/logger.ts#moveOldLogs'], read: () => src, exceptions: [], approved: {} }).findings).toEqual([])
  })

  it("fails a bare existsSync, or a swallowing catch, planted in fsutil's swap helpers (HR2's round 2), not in its other code", () => {
    const src = readRepo('src/main/fsutil.ts')!
    const scope = SCOPE.filter((s: string) => s.startsWith('src/main/fsutil.ts#'))
    const fsutil = exceptions().filter((e) => e.file === 'src/main/fsutil.ts')
    const head = /async function hashChecked\(path: string\): Promise<string \| null \| Unreadable> \{\r?\n/
    const planted = src.replace(head, (h) => `${h}  if (!existsSync(path)) return null\n`)
    expect(planted).not.toBe(src)
    expect(checkPresence({ scope, read: () => planted, exceptions: fsutil, approved: {} }).findings.map((f: Finding) => `${f.fn} ${f.rule}`)).toEqual(['hashChecked existsSync'])
    const swallowed = src.replace("return (e as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? null : new Unreadable(e)", 'return null')
    expect(swallowed).not.toBe(src)
    const r = checkPresence({ scope, read: () => swallowed, exceptions: fsutil, approved: {} })
    expect(r.findings.map((f: Finding) => `${f.fn} ${f.rule}`)).toEqual(['hashChecked catch: swallows the error'])
    // fsutil's other code isn't held: sourceProblem's existsSync is there today.
    expect(src).toMatch(/existsSync\(source\)/)
    expect(checkPresence({ scope, read: () => src, exceptions: fsutil, approved: {} })).toEqual({ findings: [], problems: [] })
  })
})
