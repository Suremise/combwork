// Builds the installer and uploads it to a DRAFT GitHub release for the version in package.json,
// with latest.yml (what the updater reads) and the .blockmap (for smaller downloads). Uses the GitHub
// CLI's login. Nothing reaches users until the draft is reviewed and published on GitHub.
// See RELEASING.md.
import { execSync, spawnSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { MANIFEST, manifestStale } from './testedClis.mjs'
import { recordBuild } from './buildFact.mjs'
import { writeAppIdentity } from './appIdentity.mjs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
let token
try {
  token = execSync('gh auth token', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
} catch {
  console.error('The GitHub CLI is not logged in. Run: gh auth login')
  process.exit(1)
}
const dirty = execSync('git status --porcelain').toString().trim()
if (dirty) {
  console.error('Commit or stash your changes first; a release is built from a clean tree.\n' + dirty)
  process.exit(1)
}
// The CLI versions this release was tested with (#365): made from the real tier's run record on this code.
const manifestFile = new URL(`../${MANIFEST}`, import.meta.url)
const changedSince = (commit) => {
  const r = spawnSync('git', ['diff', '--name-only', commit, 'HEAD'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : null
}
const stale = manifestStale(existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : null, changedSince)
if (stale) {
  console.error(`${MANIFEST} isn't of this code: ${stale}. Run the real tier on this commit (npm run e2e -- --all --real --build --record), then npm run tested-clis, and commit the manifest (RELEASING.md).`)
  process.exit(1)
}
// The committed notices must match what ships (#386): the build would otherwise regenerate them after the clean-tree check.
if (spawnSync('node', ['scripts/licenses.mjs', '--check'], { stdio: 'inherit', cwd: new URL('..', import.meta.url) }).status !== 0) process.exit(1)

console.log(`Building Hive Desktop ${pkg.version} and uploading a draft release…`)
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true, env: { ...process.env, GH_TOKEN: token } })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
run('npm', ['run', 'build'])
// A release says so (#1647): its identity file local: false, and its installer never waits for another (installer.nsh).
writeAppIdentity(fileURLToPath(new URL('..', import.meta.url)), { version: pkg.version, commit: execSync('git rev-parse HEAD').toString().trim(), local: false })
// Create the draft first: electron-builder uploads the files in parallel and, with no release yet,
// each upload creates its own draft (you end up with two drafts, the files split between them).
const tag = `v${pkg.version}`
const view = spawnSync('gh', ['release', 'view', tag, '--json', 'isDraft'], { shell: true, env: { ...process.env, GH_TOKEN: token } })
const exists = view.status === 0
// Only ever upload to a draft: a published release is what installed copies update from.
if (exists && JSON.parse(view.stdout.toString() || '{}').isDraft !== true) {
  console.error(`${tag} is already published. Bump the version in package.json for a new release.`)
  process.exit(1)
}
if (!exists) run('gh', ['release', 'create', tag, '--draft', '--title', `"Hive Desktop ${pkg.version}"`, '--notes', '""'])
run('npx', ['electron-builder', '--win', '--publish', 'always'])
console.log(`\nDraft release v${pkg.version} uploaded. Review it at https://github.com/Suremise/hive-desktop/releases and publish it there.`)
// The uploaded build, recorded in Hive's journal (buildFact.mjs, #1534): run() exits first on any failure.
const root = fileURLToPath(new URL('..', import.meta.url))
const git = (...a) => execSync(`git ${a.join(' ')}`, { cwd: root }).toString().trim()
console.log(await recordBuild({ root, version: pkg.version, commit: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current') || null, installer: join(root, 'dist', `Hive-Setup-${pkg.version}.exe`), by: 'release' }))
