// The presence-check rule (HI-2617, tests/presenceChecks.mjs): in the upgrade's code and the test area's, no
// existsSync and no handler that swallows an I/O failure, except where tests/presenceAllow.json says why.
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: a plain .mjs module without types
import { ALLOW_FILE, SCOPE, checkPresence, presenceFindings } from './presenceChecks.mjs'

const root = join(__dirname, '..')
type Finding = { line: number; rule: string; text: string }
const rules = (src: string): string[] => (presenceFindings('x.ts', src) as Finding[]).map((f) => f.rule)

describe('the presence-check rule (HI-2617)', () => {
  it('finds existsSync however it is named: imported, aliased, a member, by its name in brackets', () => {
    expect(rules("import { existsSync } from 'original-fs'\nif (existsSync(p)) go()")).toEqual(['existsSync', 'existsSync'])
    expect(rules("import { existsSync as there } from 'fs'\nthere(p)")).toEqual(['existsSync'])
    expect(rules("const fs = require('fs')\nfs.existsSync(p)")).toEqual(['existsSync'])
    expect(rules("const { existsSync: e } = require('fs')\ne(p)")).toEqual(['existsSync'])
    expect(rules("fs['existsSync'](p)")).toEqual(['existsSync'])
    expect(rules("import { present } from './fsPresence'\nif (present(p)) go()")).toEqual([])
  })

  it("finds HI-2612's swallowing handlers, as they were before its fixes", () => {
    // combworkFolder's ours(): existsSync took an old folder it couldn't look at for one not there.
    expect(rules("function ours(dir) { if (existsSync(join(dir, 'project.json'))) return true; return false }")).toEqual(['existsSync'])
    // warnRecreated's plainFolder(): a failed look taken for "not a plain folder".
    expect(rules('for (const h of hosts) if (h.marked && (await plainFolder(h.host).catch(() => false))) warn(h.host)')).toEqual(['.catch: swallows the error'])
    // removeOldShims(): a shim it couldn't remove taken for removed.
    expect(rules('for (const name of OLD_SHIMS) await rm(join(binDir, name), { force: true }).catch(() => undefined)')).toEqual(['.catch: swallows the error'])
    // retireOldCopies(): a marker it couldn't read taken for none.
    expect(rules("const marker = await readFile(join(dest, M), 'utf8').then((t) => JSON.parse(t).hash, () => undefined).catch(() => undefined)")).toEqual(['.then: swallows the error', '.catch: swallows the error'])
    // logger's moveOldLogs(): a rename that failed, taken for done.
    expect(rules('try { if (existsSync(a) && !existsSync(b)) renameSync(a, b) } catch { }')).toEqual(['existsSync', 'existsSync', 'catch: swallows the error'])
  })

  it("passes HI-2612's and HI-2611's handlers as they are after: an absence only, the failure recorded or rethrown", () => {
    const after = [
      "const text = await readFile(recordOf(host), 'utf8').catch(ifAbsent(null))",
      "for (const name of OLD_SHIMS) await rm(join(binDir, name), { force: true }).catch((e) => void left.push(`${name} (${e?.code ?? 'error'})`))",
      'const marker = markerHash(await readFile(join(dest, M), "utf8").catch(noMarker))\nfunction noMarker(e) { if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return null; throw e }',
      'try { statSync(p); return true } catch (e) { if (absent(e)) return false; throw e }',
      'export const lstatOrNullAsync = async (p) => { try { return await lstat(p) } catch (e) { if (absent(e)) return null; throw e } }',
      "try { names = readdirSync(dir) } catch (e) { if ((e)?.code !== 'ENOENT') failed.push(dir) }",
      "const busy = (file, what) => out.push({ file, what })\ntry { st = statSync(file) } catch (e) { if (absent(e)) return; busy(file, `couldn't look at it (${e.code})`) }",
      'try { run() } catch (e) { port.postMessage({ ok: false, error: String(e) }) }',
      'try { await go() } catch (e) { console.error(e.message); process.exit(1) }',
      'const r = await read(f).catch((e) => ({ ok: false, error: e }))',
      'p.catch((e) => Promise.reject(new Wrapped(e)))',
      'try { await go() } catch (e) { result.error = e }'
    ]
    for (const src of after) expect(rules(src), src).toEqual([])
  })

  it('a handler that only logs, then answers a success, swallows', () => {
    expect(rules("try { await rename(a, b) } catch (e) { log.warn('rename', e); return true }")).toEqual(['catch: swallows the error'])
    expect(rules("const done = await rename(a, b).then(() => true, (e) => (log.warn('rename', e), true))")).toEqual(['.then: swallows the error'])
    expect(rules("const ok = await mark().catch((e) => { log.warn('mark', e) })")).toEqual(['.catch: swallows the error'])
    // Logging it to a list of the logger's isn't recording it for the caller: log.warn is no push.
    expect(rules("try { x() } catch (e) { log.warn('x', e) }")).toEqual(['catch: swallows the error'])
  })

  it('a parse-only try passes; one that reads and parses, or parses what a read gives, does not', () => {
    expect(rules('try { d = JSON.parse(raw) } catch { return null }')).toEqual([])
    expect(rules("try { m = JSON.parse(text.replace(/^\\uFEFF/, '').trim()) } catch { return }")).toEqual([])
    expect(rules('try { u = new URL(s) } catch { u = null }')).toEqual([])
    expect(rules("try { const t = readFileSync(f, 'utf8'); d = JSON.parse(t) } catch { return null }")).toEqual(['catch: swallows the error'])
    expect(rules("try { d = JSON.parse(readFileSync(f, 'utf8')) } catch { return null }")).toEqual(['catch: swallows the error'])
    expect(rules("try { d = JSON.parse(readFileSync(f).toString()) } catch { return null }")).toEqual(['catch: swallows the error'])
    // A chain's catch covers the read too.
    expect(rules("const d = await readFile(f, 'utf8').then((t) => JSON.parse(t)).catch(() => null)")).toEqual(['.catch: swallows the error'])
  })

  it("queue bookkeeping passes only on a promise its function returns, so the caller gets the failure", () => {
    expect(rules('function inTurn(fn) { const run = prev.then(fn); const settled = run.catch(() => undefined); chains.set(k, settled); return run }')).toEqual([])
    expect(rules('function inTurn(fn) { const run = prev.then(fn); const settled = run.catch(() => undefined); chains.set(k, settled); return settled }')).toEqual(['.catch: swallows the error'])
    expect(rules('async function f() { await rm(p).catch(() => undefined) }')).toEqual(['.catch: swallows the error'])
  })

  it("reads a handler of the same file by name, and fails one it can't read", () => {
    expect(rules('const quiet = () => undefined\nawait rm(p).catch(quiet)')).toEqual(['.catch: swallows the error'])
    expect(rules("import { quiet } from './elsewhere'\nawait rm(p).catch(quiet)")).toEqual([".catch: a handler this rule can't read"])
    expect(rules("import { quiet } from './elsewhere'\nawait rm(p).catch(quiet())")).toEqual([".catch: a handler this rule can't read"])
  })

  it('excepts a finding only where an exception names its file and text, and fails a stale exception', () => {
    const files: Record<string, string> = { 'a.ts': "try { x() } catch (e) { log.warn('one', e) }\ntry { y() } catch (e) { log.warn('two', e) }", 'b.ts': 'fs.existsSync(p)' }
    const { findings, problems } = checkPresence({
      files: Object.keys(files),
      read: (f: string) => files[f] ?? null,
      exceptions: [{ file: 'a.ts', text: "'one'", why: '' }, { file: 'b.ts', text: "'one'", why: '' }]
    })
    expect(findings.map((f: Finding & { file: string }) => `${f.file}:${f.line} ${f.rule}`)).toEqual(['a.ts:2 catch: swallows the error', 'b.ts:1 existsSync'])
    expect(problems).toEqual(["exception 1 (b.ts: 'one') excepts nothing: remove it"])
  })

  it('fails a file of its scope that is gone', () => {
    expect(checkPresence({ files: ['gone.ts'], read: () => null, exceptions: [] }).findings).toEqual([{ file: 'gone.ts', line: 0, rule: 'scope', text: "isn't there: SCOPE names it" }])
  })
})

describe('presence checks in the repository (HI-2617)', () => {
  it("the upgrade's code and the test area's have none but those tests/presenceAllow.json excepts, each still needed", () => {
    const { exceptions } = JSON.parse(readFileSync(join(root, ALLOW_FILE), 'utf8'))
    const read = (f: string): string | null => {
      try {
        return readFileSync(join(root, f), 'utf8')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw e
      }
    }
    const { findings, problems } = checkPresence({ files: SCOPE, read, exceptions })
    expect(findings).toEqual([])
    expect(problems).toEqual([])
    for (const e of exceptions) expect(e.why, e.text).toBeTruthy()
  })

  it('fails a bare existsSync planted in a file of its scope', () => {
    const planted = `${readFileSync(join(root, 'src/main/nameUpgrade.ts'), 'utf8')}\nexport const planted = (p: string): boolean => existsSync(p)\n`
    const { exceptions } = JSON.parse(readFileSync(join(root, ALLOW_FILE), 'utf8'))
    const { findings } = checkPresence({ files: ['src/main/nameUpgrade.ts'], read: () => planted, exceptions })
    expect(findings.map((f: Finding) => f.rule)).toEqual(['existsSync'])
  })
})
