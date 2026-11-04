// Builds the installer and uploads it to a DRAFT GitHub release for the version in package.json,
// with latest.yml (what the updater reads) and the .blockmap (for smaller downloads). Uses the GitHub
// CLI's login. Nothing reaches users until the draft is reviewed and published on GitHub.
// It builds in this checkout's dist by npm run dist's rules (HI-2411; makeRelease in distCopy.mjs): it never builds over
// an installer of the same name there built from other code without --replace, and writes dist/build-info.json for the
// installer it uploaded. See RELEASING.md.
// --dialects (HI-2442): a dialect-only patch, refused unless only the shipped dialect files (with the version and its
// notes) changed since the last release; it runs the dialect checks instead of asking for the real tier (dialectRelease.mjs).
import { execFileSync, execSync, spawnSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { MANIFEST, manifestStale } from './testedClis.mjs'
import { recordBuild } from './buildFact.mjs'
import { installerName, makeRelease } from './distCopy.mjs'
import { dialectCheckArgs, dialectReleaseProblem, lastReleaseTag } from './dialectRelease.mjs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const args = process.argv.slice(2)
const unknown = args.filter((a) => a !== '--replace' && a !== '--dialects')
if (unknown.length) {
  console.error(`Unknown option ${unknown.join(' ')}: --replace builds over an installer of the same name in dist built from other code; --dialects makes a dialect-only patch release.`)
  process.exit(2)
}
const dialectsOnly = args.includes('--dialects')
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
const root = fileURLToPath(new URL('..', import.meta.url))
const changedSince = (commit) => {
  const r = spawnSync('git', ['diff', '--name-only', '--no-renames', commit, 'HEAD'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : null
}
if (dialectsOnly) {
  // Only the dialect files changed since the last release, so its tested-with manifest (unchanged, as the rules require)
  // still holds, and the real tier isn't run again (RELEASING.md, A dialect-only release).
  const tags = spawnSync('git', ['tag', '--merged', 'HEAD', '--list', 'v*'], { encoding: 'utf8' })
  const tag = tags.status === 0 ? lastReleaseTag(tags.stdout.split(/\r?\n/)) : null
  const changed = tag ? changedSince(tag) : []
  const read = (rev, path) => {
    try {
      return execFileSync('git', ['show', `${rev}:${path}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
    } catch {
      return null
    }
  }
  const problem = changed === null ? `git couldn't list what changed since ${tag}.` : dialectReleaseProblem({ version: pkg.version, tag, changed, read })
  if (problem) {
    console.error(problem)
    process.exit(1)
  }
  console.log(`A dialect-only patch of ${tag}: ${changed.filter((f) => f.startsWith('resources/dialects/')).length} dialect file(s) changed. Running the dialect checks…`)
  if (spawnSync('npx', dialectCheckArgs(), { stdio: 'inherit', cwd: root, shell: true }).status !== 0) process.exit(1)
} else {
  // The CLI versions this release was tested with (#365): made from the real tier's run record on this code.
  const manifestFile = new URL(`../${MANIFEST}`, import.meta.url)
  const stale = manifestStale(existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : null, changedSince)
  if (stale) {
    console.error(`${MANIFEST} isn't of this code: ${stale}. Run the real tier on this commit (npm run e2e -- --all --real --build --record), then npm run tested-clis, and commit the manifest (RELEASING.md).`)
    process.exit(1)
  }
}
// The committed notices must match what ships (#386): the build would otherwise regenerate them after the clean-tree check.
if (spawnSync('node', ['scripts/licenses.mjs', '--check'], { stdio: 'inherit', cwd: root }).status !== 0) process.exit(1)

console.log(`Building ${pkg.productName} ${pkg.version} and uploading a draft release…`)
const run = (cmd) => {
  const r = spawnSync(cmd, { cwd: root, stdio: 'inherit', shell: true, env: { ...process.env, GH_TOKEN: token } })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
const tag = `v${pkg.version}`
const publish = () => {
  // Create the draft first: electron-builder uploads the files in parallel and, with no release yet,
  // each upload creates its own draft (you end up with two drafts, the files split between them).
  const view = spawnSync('gh', ['release', 'view', tag, '--json', 'isDraft'], { shell: true, env: { ...process.env, GH_TOKEN: token } })
  const exists = view.status === 0
  // Only ever upload to a draft: a published release is what installed copies update from.
  if (exists && JSON.parse(view.stdout.toString() || '{}').isDraft !== true) {
    console.error(`${tag} is already published. Bump the version in package.json for a new release.`)
    process.exit(1)
  }
  if (!exists) run(`gh release create ${tag} --draft --title "${pkg.productName} ${pkg.version}" --notes ""`)
  run('npx electron-builder --win --publish always')
}
// The build, the draft and the upload, by npm run dist's rules (makeRelease): a release says so in its identity file
// (local: false, #1647), and dist/build-info.json describes what it uploaded. run() exits first on any failure.
const made = makeRelease({ root, replace: args.includes('--replace'), run, publish })
if (made.refused) {
  console.error(made.refused)
  process.exit(1)
}
console.log(`\n${made.lines.join('\n')}`)
console.log(`\nDraft release ${tag} uploaded. Review it at https://github.com/Suremise/combwork/releases and publish it there.`)
if (dialectsOnly) console.log('Before publishing a dialect-only release: the packaged checks on this build and the Sandbox upgrade check (RELEASING.md, A dialect-only release).')
// The uploaded build, recorded in Hive's journal (buildFact.mjs, #1534).
const git = (...a) => execSync(`git ${a.join(' ')}`, { cwd: root }).toString().trim()
console.log(await recordBuild({ root, version: pkg.version, commit: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current') || null, installer: join(root, 'dist', installerName(pkg.version)), by: 'release' }))
