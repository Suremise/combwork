// The presence-check rule (HI-2617, tests/presenceChecks.mjs): in the upgrade's code and the test area's, no
// existsSync, and every catch, .catch() or .then(_, f) a rethrow, fsPresence's ifAbsent, or an exact entry in
// tests/presenceAllow.json with why. A closed rule: nothing else passes, however it is written.
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: a plain .mjs module without types
import { ALLOW_FILE, SCOPE, SCOPE_FILES, checkPresence, presenceFindings } from './presenceChecks.mjs'

const root = join(__dirname, '..')
type Finding = { file: string; line: number; rule: string; fn: string; text: string }
type Exception = { file: string; in: string; node: string; why: string }
const CATCH = 'catch: not a rethrow'
const HANDLER = (kind: '.catch' | '.then'): string => `${kind}: not a rethrow or fsPresence's ifAbsent`
const rules = (src: string, file = 'src/main/x.ts'): string[] => (presenceFindings(file, src) as Finding[]).map((f) => f.rule)
const ok = (src: string, file?: string): void => expect(rules(src, file), src).toEqual([])
const fails = (src: string, rule = CATCH, file?: string): void => expect(rules(src, file), src).toEqual([rule])
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

  it('passes a rethrow: a block ending in throw, with no other way out', () => {
    ok("try { x() } catch (e) { log.warn('x', e); throw e }")
    ok('try { x() } catch (e) { throw new Wrapped(e) }')
    ok("try { x() } catch (e) { if (busy(e)) log.warn('busy'); throw e }")
    ok('const r = await x().catch((e) => { throw e })')
    ok('const r = await x().then(ok, (e) => { log(e); throw new Wrapped(e) })')
  })

  it('fails every other catch, whatever it does: an absence answered, a record, a rejection, a parse', () => {
    fails("try { x() } catch (e) { if (e.code === 'ENOENT') return null; throw e }")
    fails('try { x() } catch (e) { if (strict) throw e }')
    fails('try { x() } catch (e) { for (const t of tries) { if (t) break } throw e }')
    fails('for (;;) { try { x() } catch (e) { if (busy(e)) continue; throw e } }')
    fails('try { x() } catch (e) { failures.push(e); return true }')
    fails('try { d = JSON.parse(raw) } catch { return null }')
    fails('try { x() } catch { }')
    fails("try { x() } catch (e) { log.warn('x', e) }")
    fails('const r = await x().catch(() => null)', HANDLER('.catch'))
    fails('const r = await x().catch((e) => Promise.reject(e))', HANDLER('.catch'))
    fails('const r = await x().catch((e) => { failures.push(e) })', HANDLER('.catch'))
    fails('const r = await x().then(ok, () => false)', HANDLER('.then'))
    fails('const quiet = (e) => { throw e }\nawait x().catch(quiet)', HANDLER('.catch'))
  })

  it("holds .catch and .then however the call names them: dotted, optional, in brackets (HR2's round 5)", () => {
    fails("const r = await readFile(p)['catch'](() => null)", HANDLER('.catch'))
    fails("const r = await readFile(p)['then'](ok, () => true)", HANDLER('.then'))
    fails('const r = await readFile(p)[`catch`](() => null)', HANDLER('.catch'))
    fails('const r = await readFile(p)?.catch(() => null)', HANDLER('.catch'))
    fails("const r = await readFile(p)?.['catch'](() => null)", HANDLER('.catch'))
    ok("const r = await readFile(p)['catch']((e) => { throw e })")
    ok("import { ifAbsent } from './fsPresence'\nconst r = await readFile(p)['catch'](ifAbsent(null))")
    ok("import { ifAbsent } from './fsPresence'\nconst r = await readFile(p)['then'](ok, ifAbsent(null))")
    // A method named only at run time could be either: a finding of its own.
    fails("const m = 'catch'\nconst r = await readFile(p)[m](() => null)", 'a call by a computed name')
  })

  it("fails the reviewers' probes of rounds 1 to 3 the same way: none is read, so none is accepted", () => {
    for (const src of [
      "try { readFileSync(p) } catch (e) { if (e.code === 'ENOENT') throw e; return null }",
      'try { readFileSync(p) } catch (e) { stats.push(1); return true }',
      'try { readFileSync(p) } catch (e) { false && failures.push(e); return true }',
      'function record(e) { if (false) failures.push(e) }\ntry { readFileSync(p) } catch (e) { record(e); return true }',
      'try { readFileSync(p) } catch (e) { false && process.exit(1); return true }',
      'try { readFileSync(p) } catch (e) { return !!e }',
      "function isAbsent(e) { return ['ENOENT', 'EACCES'].includes(e.code) }\ntry { x() } catch (e) { if (isAbsent(e)) return null; throw e }",
      'try { readFileSync(p) } catch (e) { failures?.push(e); return true }',
      'try { readFileSync(p) } catch (e) { alreadyFailed ||= failures.push(e); return true }',
      'try { readFileSync(p) } catch (e) { alreadyFailed ??= failures.push(e); return true }'
    ])
      expect(rules(src), src).toContain(CATCH)
    fails('function f() { const p = readFile(file); p.catch(() => undefined); if (false) return p; return Promise.resolve(null) }', HANDLER('.catch'))
  })

  it("passes ifAbsent only as fsPresence's: imported from src/main/fsPresence and not declared again in the file", () => {
    ok("import { ifAbsent } from './fsPresence'\nconst t = await readFile(p, 'utf8').catch(ifAbsent(null))")
    ok("import { ifAbsent as quietly } from './fsPresence'\nconst t = await readFile(p).catch(quietly(null))")
    ok("import { ifAbsent } from '../main/fsPresence'\nconst t = await readFile(p).catch(ifAbsent(''))", 'src/shared/x.ts')
    // HR1's round 3: a factory of that name of the file's own.
    fails('export async function probe() { const ifAbsent = () => () => null; return await readFile(p).catch(ifAbsent(null)) }', HANDLER('.catch'))
    fails("import { ifAbsent } from './elsewhere'\nawait readFile(p).catch(ifAbsent(null))", HANDLER('.catch'))
    fails("import { ifAbsent } from './fsPresence'\nawait readFile(p).catch(ifAbsent(null))", HANDLER('.catch'), 'src/shared/x.ts')
    fails("import { ifAbsent } from './fsPresence'\nfunction f(ifAbsent) { return readFile(p).catch(ifAbsent(null)) }", HANDLER('.catch'))
    fails("import { ifAbsent } from './fsPresence'\nfunction f() { const ifAbsent = (v) => () => v; return readFile(p).catch(ifAbsent(null)) }", HANDLER('.catch'))
    fails("import { ifAbsent } from './fsPresence'\nawait readFile(p).catch(ifAbsent)", HANDLER('.catch'))
    fails("const { ifAbsent } = require('./fsPresence')\nawait readFile(p).catch(ifAbsent(null))", HANDLER('.catch'))
    // HR1's round 4: a named function expression's own name, where its body calls it.
    fails("import { ifAbsent } from './fsPresence'\nexport const reviewProbe = function ifAbsent(value) { if (arguments.length) return () => null; return readFile(p).catch(ifAbsent(null)) }", HANDLER('.catch'))
    // And every other binding of the name where it is called: a class, a catch binding, a block's let, a function's own.
    fails("import { ifAbsent } from './fsPresence'\nconst C = class ifAbsent { static m() { return readFile(p).catch(ifAbsent(null)) } }", HANDLER('.catch'))
    fails("import { ifAbsent } from './fsPresence'\ntry { x() } catch (ifAbsent) { await readFile(p).catch(ifAbsent(null)); throw ifAbsent }", HANDLER('.catch'))
    fails("import { ifAbsent } from './fsPresence'\nif (a) { let ifAbsent = (v) => () => v; await readFile(p).catch(ifAbsent(null)) }", HANDLER('.catch'))
    fails("import { ifAbsent } from './fsPresence'\nfunction g() { function ifAbsent(v) { return () => v } return readFile(p).catch(ifAbsent(null)) }", HANDLER('.catch'))
    // The import stays the one used outside the place that shadows it.
    expect(rules("import { ifAbsent } from './fsPresence'\nfunction g(ifAbsent) { return ifAbsent }\nconst t = await readFile(p).catch(ifAbsent(null))")).toEqual([])
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
    expect(checkPresence({ scope: ['log.ts#moveOld'], read: () => src, exceptions: [] }).findings.map((f: Finding) => f.fn)).toEqual(['moveOld'])
    expect(checkPresence({ scope: ['log.ts#gone'], read: () => src, exceptions: [] }).findings).toEqual([{ file: 'log.ts', line: 0, rule: 'scope', fn: 'gone', text: 'has no function gone: SCOPE names it' }])
    expect(checkPresence({ scope: ['gone.ts'], read: () => null, exceptions: [] }).findings).toEqual([{ file: 'gone.ts', line: 0, rule: 'scope', fn: '(top)', text: "isn't there: SCOPE names it" }])
  })
})

describe('presence checks in the repository (HI-2617)', () => {
  it("the upgrade's code and the test area's have none but those tests/presenceAllow.json excepts, each still needed and saying why", () => {
    const { findings, problems } = checkPresence({ scope: SCOPE, read: readRepo, exceptions: exceptions() })
    expect(findings).toEqual([])
    expect(problems).toEqual([])
    for (const e of exceptions()) expect(e.why, e.node).toBeTruthy()
    expect(SCOPE_FILES).toEqual(expect.arrayContaining(['src/main/logger.ts', 'src/main/fsutil.ts', 'src/main/fsPresence.ts']))
  })

  it('fails a bare existsSync planted in a file of its scope', () => {
    const planted = `${readRepo('src/main/nameUpgrade.ts')}\nexport const planted = (p: string): boolean => existsSync(p)\n`
    const { findings, problems } = checkPresence({ scope: ['src/main/nameUpgrade.ts'], read: () => planted, exceptions: exceptions().filter((e) => e.file === 'src/main/nameUpgrade.ts') })
    expect(findings.map((f: Finding) => f.rule)).toEqual(['existsSync'])
    expect(problems).toEqual([])
  })

  it("fails .catch and .then in brackets planted in a file of its scope (HR2's round 5)", () => {
    const planted = `${readRepo('src/main/nameUpgrade.ts')}\nexport async function probeCatch(p: string): Promise<unknown> { return readFile(p)['catch'](() => null) }\nexport async function probeThen(p: string): Promise<unknown> { return readFile(p)['then'](() => false, () => true) }\n`
    const { findings, problems } = checkPresence({ scope: ['src/main/nameUpgrade.ts'], read: () => planted, exceptions: exceptions().filter((e) => e.file === 'src/main/nameUpgrade.ts') })
    expect(findings.map((f: Finding) => `${f.fn} ${f.rule}`)).toEqual([`probeCatch ${HANDLER('.catch')}`, `probeThen ${HANDLER('.then')}`])
    expect(problems).toEqual([])
  })

  it("fails a new catch planted beside the listed ones, however like them it is: an entry is for one handler (HR1's round 1)", () => {
    const files = exceptions().filter((e) => e.file === 'src/main/nameUpgradeFiles.ts')
    const fragment = `${readRepo('src/main/nameUpgradeFiles.ts')}\nexport function planted(p: string): boolean {\n  try {\n    readFileSync(p)\n  } catch (e) {\n    log.warn('later(', e)\n    return true\n  }\n  return false\n}\n`
    const a = checkPresence({ scope: ['src/main/nameUpgradeFiles.ts'], read: () => fragment, exceptions: files })
    expect(a.findings.map((f: Finding) => `${f.fn} ${f.rule}`)).toEqual([`planted ${CATCH}`])
    expect(a.problems).toEqual([])
    // A listed handler copied word for word into another function is a finding of its own.
    const moves = exceptions().filter((e) => e.file === 'src/main/combworkMove.ts')
    const copied = moves.find((e) => e.in === 'excludeMoveLock')!
    const copy = `${readRepo('src/main/combworkMove.ts')}\nexport function excludeMoveLock2(): void {\n  try {\n    x()\n  } ${copied.node}\n}\n`
    const b = checkPresence({ scope: ['src/main/combworkMove.ts'], read: () => copy, exceptions: moves })
    expect(b.findings.map((f: Finding) => `${f.fn} ${f.rule}`)).toEqual([`excludeMoveLock2 ${CATCH}`])
    expect(b.problems).toEqual([])
    // HR1's round 4, in the real file (which imports fsPresence's ifAbsent): a named function expression of that name.
    const shadow = `${readRepo('src/main/combworkMove.ts')}\nexport const reviewProbe = function ifAbsent(value) { if (arguments.length) return () => null; return readFile(p).catch(ifAbsent(null)); };\n`
    const c = checkPresence({ scope: ['src/main/combworkMove.ts'], read: () => shadow, exceptions: moves })
    expect(c.findings.map((f: Finding) => `${f.fn} ${f.rule}`)).toEqual([`reviewProbe ${HANDLER('.catch')}`])
    expect(c.problems).toEqual([])
  })

  it("fails moveOldLogs' old existsSync and empty catch planted back into it (logger.ts, by its function)", () => {
    const src = readRepo('src/main/logger.ts')!
    const before = src
      .replace('if (present(join(dir, from)) && !present(join(dir, to))) renameSync', 'if (existsSync(join(dir, from)) && !existsSync(join(dir, to))) renameSync')
      .replace(/\} catch \(e\) \{\r?\n\s*left\.push\([^\n]*\r?\n\s*\}/, '} catch {\n    }')
    expect(before).not.toBe(src)
    const listed = exceptions().filter((e) => e.file === 'src/main/logger.ts')
    const { findings, problems } = checkPresence({ scope: ['src/main/logger.ts#moveOldLogs'], read: () => before, exceptions: listed })
    expect(findings.map((f: Finding) => `${f.fn} ${f.rule}`)).toEqual(['moveOldLogs existsSync', 'moveOldLogs existsSync', `moveOldLogs ${CATCH}`])
    // The audited catch it replaced is gone: its entry is stale.
    expect(problems).toEqual(['exception 0 (src/main/logger.ts, moveOldLogs) excepts nothing: remove it'])
    expect(checkPresence({ scope: ['src/main/logger.ts#moveOldLogs'], read: () => src, exceptions: listed })).toEqual({ findings: [], problems: [] })
  })

  it("fails a bare existsSync, or a changed catch, planted in fsutil's swap helpers, and not in its other code", () => {
    const src = readRepo('src/main/fsutil.ts')!
    const scope = SCOPE.filter((s: string) => s.startsWith('src/main/fsutil.ts#'))
    const listed = exceptions().filter((e) => e.file === 'src/main/fsutil.ts')
    const head = /async function hashChecked\(path: string\): Promise<string \| null \| Unreadable> \{\r?\n/
    const planted = src.replace(head, (h) => `${h}  if (!existsSync(path)) return null\n`)
    expect(planted).not.toBe(src)
    expect(checkPresence({ scope, read: () => planted, exceptions: listed })).toEqual({ findings: [expect.objectContaining({ fn: 'hashChecked', rule: 'existsSync' })], problems: [] })
    const swallowed = src.replace("return (e as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? null : new Unreadable(e)", 'return null')
    expect(swallowed).not.toBe(src)
    const r = checkPresence({ scope, read: () => swallowed, exceptions: listed })
    expect(r.findings.map((f: Finding) => `${f.fn} ${f.rule}`)).toEqual([`hashChecked ${CATCH}`])
    expect(r.problems).toHaveLength(1)
    // fsutil's other code isn't held: sourceProblem's existsSync is there today.
    expect(src).toMatch(/existsSync\(source\)/)
    expect(checkPresence({ scope, read: () => src, exceptions: listed })).toEqual({ findings: [], problems: [] })
  })
})
