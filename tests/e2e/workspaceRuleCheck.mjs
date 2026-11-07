// check:repo's step (HI-2678): the WorkspaceService rule (workspaceRule.mjs) on the working tree, when the diff against
// the merge target touches one of its inputs. `--reaudit <commit>`: an audited tree's record takes the rule's new
// identity when the census still finds exactly what was audited there.
//   node tests/e2e/workspaceRuleCheck.mjs --diff [--base <target>]   (the merge queue gives the target as CW_CHECK_BASE)
import { execFileSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { gitRevision } from './affectedUnits.mjs'
import { AUDITED, census, ruleIdentity, ruleInput } from './workspaceRule.mjs'

const runContext = createRequire(import.meta.url)('./runContext.cjs')
const AUDIT_FILE = new URL('./workspaceRule.audited.json', import.meta.url)
const args = process.argv.slice(2)
const at = args.indexOf('--base')
const cwd = process.cwd()
const git = (a) => execFileSync('git', ['-c', 'core.quotepath=false', ...a], { cwd, encoding: 'utf8', env: runContext.baseEnv(), maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
const fail = (why) => {
  console.error(`The WorkspaceService rule fails: ${why}`)
  process.exit(1)
}
// --reaudit <commit>: after a change to this file or the compiler, an audited tree's record takes the rule's new
// identity only when the census still finds exactly the escapes and errors audited there (their proofs are about
// that tree's code, which is fixed); anything else needs its audit read again by hand.
const re = args.indexOf('--reaudit')
if (re >= 0) {
  const rev = gitRevision(cwd, args[re + 1])
  const tree = rev.tree()
  const records = JSON.parse(readFileSync(AUDIT_FILE, 'utf8'))
  const record = records.find((a) => a.tree === tree)
  if (!record) fail(`${args[re + 1]}'s tree ${tree} has no audit record`)
  const saved = AUDITED.splice(0, AUDITED.length)
  const c = census(rev, cwd)
  AUDITED.push(...saved)
  if (c.all) fail(c.all)
  const same = (a, b) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort())
  const found = { escapes: c.escapes.map((e) => `${e.file}\0${e.text}\0${e.why}`), errors: c.errors.map((e) => `${e.file}\0${e.code}\0${e.text}`) }
  const audited = { escapes: record.escapes.map((e) => `${e.file}\0${e.text}\0${e.why}`), errors: record.errors.map((e) => `${e.file}\0${e.code}\0${e.text}`) }
  if (!same(found.escapes, audited.escapes) || !same(found.errors, audited.errors)) fail(`the census finds other escapes or errors in ${args[re + 1]} than were audited: read them and write the record again by hand`)
  Object.assign(record, ruleIdentity())
  writeFileSync(AUDIT_FILE, JSON.stringify(records, null, 2) + '\n')
  console.log(`${args[re + 1]}'s audit takes the rule's identity: the same ${record.escapes.length} escapes and ${record.errors.length} errors.`)
  process.exit(0)
}
// The merge queue gives the target's head (CW_CHECK_BASE); locally, --base <ref>. Without one it runs: it never skips
// on what it can't compare.
const base = (at >= 0 ? args[at + 1] : null) || process.env.CW_CHECK_BASE
if (args.includes('--diff') && base) {
  let changed
  try {
    const mb = git(['merge-base', base, 'HEAD']).trim()
    changed = [...git(['diff', '--name-only', '-z', mb]).split('\0'), ...git(['ls-files', '-z', '--others', '--exclude-standard']).split('\0')].filter(Boolean)
  } catch (e) {
    fail(`the diff against ${base} couldn't be read (${String(e.message).split('\n')[0]})`)
  }
  const inputs = changed.filter(ruleInput)
  if (!inputs.length) {
    console.log(`The WorkspaceService rule: nothing it reads changed against ${base} (${changed.length} files changed): not run.`)
    process.exit(0)
  }
}
const c = census(gitRevision(cwd, null), cwd)
if (c.all) fail(c.all)
if (c.broken) fail(c.broken)
console.log(`The WorkspaceService rule holds (${c.files} files, ${(c.ms / 1000).toFixed(1)} s; ${c.exempt.length} escapes in the reviewed Proxy; ${c.pinned.length} test files pinned; ${c.work} type visits).`)
