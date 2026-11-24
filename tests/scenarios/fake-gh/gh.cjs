// HI-3551: the GitHub CLI as scenario runs' Combwork sees it (CW_TEST_GH, a dev seam): signed in as mona on any host,
// and pull request #7 of the repository asked about, from a branch of the same repository into main. Never the user's own
// gh or sign-in, no network: a scenario's project has a github.com remote that is a URL only.
const args = process.argv.slice(2)
if (args[0] === '--version') {
  process.stdout.write('gh version 2.83.0\n')
} else if (args[0] === 'auth') {
  const host = args[args.indexOf('--hostname') + 1]
  process.stdout.write(JSON.stringify({ hosts: { [host]: [{ state: 'success', active: true, login: 'mona' }] } }))
} else if (args[0] === 'pr' && args[1] === 'view' && args[2] === '7') {
  const repo = args[args.indexOf('-R') + 1].split('/').slice(1).join('/')
  process.stdout.write(JSON.stringify({ number: 7, title: 'Tidy the README', url: `https://github.com/${repo}/pull/7`, headRefName: 'tidy-readme', baseRefName: 'main', isCrossRepository: false, maintainerCanModify: true }))
} else {
  process.stderr.write(`GraphQL: Could not resolve to a PullRequest or Issue (${args.slice(0, 3).join(' ')}).`)
  process.exit(1)
}
