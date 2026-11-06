// npm run dist [-- --here | --replace | --kind <beta|baseline|rc|release>]: builds Combwork and its Windows installer (dist/Combwork-Setup-<version>.exe, with its
// blockmap and latest.yml; never published: npm run release does that, RELEASING.md), and writes dist/build-info.json:
// what the installer was built from (the code's fingerprint, commit, branch, version, time), only if that didn't change
// while it was built. Built in an agent's git worktree, the installer is also copied to the main checkout's dist, where
// the user looks for it (distCopy.mjs, #150), unless --here; one of the same name there built from other code is never
// replaced without --replace.
// Its `npm run build` makes the dev build in out/ that the app is packaged from: that is stamped as `npm run e2e --
// --build` stamps it (tests/e2e/build.mjs, under the worktree's build lock), so the packaged checks run straight after
// it (npm run e2e -- packaged packaged-mcp packaged-progress --record) find out/ from this source (#274).
// A successful build is then recorded in Combwork's journal (buildFact.mjs, #1534); --kind says what it is (else from the
// version: RELEASING.md).
import { spawnSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { makeDist } from './distCopy.mjs'
import { BUILD_KINDS, recordDist } from './buildFact.mjs'
import { buildStamped } from '../tests/e2e/build.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const kindAt = args.indexOf('--kind')
const kind = kindAt >= 0 ? args[kindAt + 1] : null
if (kindAt >= 0 && !BUILD_KINDS.includes(kind)) {
  console.error(`--kind is one of: ${BUILD_KINDS.join(', ')}.`)
  process.exit(2)
}
const unknown = args.filter((a, i) => !['--here', '--replace', '--kind'].includes(a) && !(kindAt >= 0 && i === kindAt + 1))
if (unknown.length) {
  console.error(`Unknown option ${unknown.join(' ')}: --here keeps a worktree's installer in it, --replace copies it over a different build, --kind <${BUILD_KINDS.join('|')}> says what the build is.`)
  process.exit(2)
}
const run = (cmd) => {
  const r = spawnSync(cmd, { cwd: root, stdio: 'inherit', shell: true })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
// Its build regenerates THIRD_PARTY_NOTICES.md (npm run licenses): a change it makes is reported, not left unnoticed in
// the checkout (#386).
const noticesFile = join(root, 'THIRD_PARTY_NOTICES.md')
const notices = () => (existsSync(noticesFile) ? readFileSync(noticesFile, 'utf8') : null)
const noticesBefore = notices()
// An earlier build's records go first, so a build that fails part way leaves nothing vouching for its installer and
// dist/win-unpacked, and the e2e runner's packaged checks say so (tests/e2e/runner.mjs packagedStatus): makeDist.
// It refuses, building nothing, while a release or another npm run dist builds in this checkout's dist (HI-2417).
const made = makeDist({ root, here: args.includes('--here'), replace: args.includes('--replace'), run, buildStamped })
if (made.refused) {
  console.error(`\n${made.refused}`)
  process.exit(1)
}
const { lines } = made
if (notices() !== noticesBefore) lines.push('THIRD_PARTY_NOTICES.md changed: the build regenerated it for changed dependencies. Commit it (the unit tests fail until it is).')
const recorded = await recordDist({ root, lines, kind })
if (recorded) lines.push(recorded)
console.log(`\n${lines.join('\n')}`)
