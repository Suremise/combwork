// R9's moved callers, traced (HI-2792, the last card of the 1.4.0 Git refactor; SPEC §16.3.6's rule 1): keeping .combwork
// out of a repository (ensured, its tracked files listed, one untracked), the 1.1 folder move's worktree repair, a run's
// checked-out revision and a revision's commit (runLink), the queue's commits behind (queueControls), a card's adoption
// reads (upgrade, Git and None) and the options form's presets (Git and None), each through the ports now. The same git
// commands (folder, argv, order) and answers as the code before them: the expected traces were recorded at 4cb852f0d
// (1.4.0, before R9) with `CW_RECORD_CUTOVER_TRACES=1 npx vitest run tests/cutoverTraces.test.ts`, into
// tests/fixtures/cutoverTraces.json.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
import { gitTestHooks } from '../src/main/git'
import { combworkVcs, ensureCombworkExcluded, trackedCombworkFiles, untrackCombwork } from '../src/main/combworkVcs'
import { repairWorktrees } from '../src/main/combworkMove'
import { commitIn, folderHead } from '../src/main/workflow/runLink'
import { commitsBehind } from '../src/main/workflow/queueControls'
import { adoptionInputs } from '../src/main/workflow/upgrade'
import { presetInputs } from '../src/main/workflow/optionsForm'
import { commit, gitRepo, sh } from './workflow/harness'

const FIXTURE = join(__dirname, 'fixtures', 'cutoverTraces.json')
const RECORD = process.env.CW_RECORD_CUTOVER_TRACES === '1'
const recorded: Record<string, string[]> = {}
const expected = (): Record<string, string[]> => (existsSync(FIXTURE) ? (JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, string[]>) : {})

afterEach(() => {
  gitTestHooks.started = undefined
  if (RECORD) writeFileSync(FIXTURE, `${JSON.stringify({ ...expected(), ...recorded }, null, 2)}\n`)
})

/** The git commands `fn` started, each `<folder> :: <args>`, then its answer (`=> <JSON>`), the test's folder and full ids made stable. */
async function traced(base: string, fn: () => Promise<unknown>): Promise<string[]> {
  const ran: string[] = []
  const at = resolve(base).toLowerCase().replace(/\\/g, '/')
  const stable = (s: string): string => s.replace(/\\/g, '/').toLowerCase().split(at).join('<base>').replace(/\b[0-9a-f]{40}\b/g, '<id>')
  gitTestHooks.started = (cwd, args) => void ran.push(stable(`${resolve(cwd)} :: ${args.join(' ')}`))
  try {
    const v = await fn()
    ran.push(stable(`=> ${JSON.stringify(v ?? null).replace(/\\\\/g, '/')}`))
  } finally {
    gitTestHooks.started = undefined
  }
  return ran
}

function same(step: string, trace: string[]): void {
  if (RECORD) recorded[step] = trace
  else expect(trace, step).toEqual(expected()[step])
}

describe("R9's moved callers keep their git commands (HI-2792)", { timeout: 90_000 }, () => {
  it('keeps .combwork out of a repository: ensured, read only, its tracked files listed and untracked, the whole check', async () => {
    const base = tempDir('cutover-traces-')
    const project = gitRepo(join(base, 'project'))
    commit(project, { '.combwork/sessions.json': '{}\n', 'a.txt': 'a\n' }, 'tracked before the exclude')
    same('keepOut.ensure', await traced(base, () => ensureCombworkExcluded(project)))
    same('keepOut.readOnly', await traced(base, () => ensureCombworkExcluded(project, { readOnly: true })))
    same('keepOut.tracked', await traced(base, () => trackedCombworkFiles(project, project, { fresh: true })))
    same('keepOut.untrack', await traced(base, () => untrackCombwork(project, ['.combwork/sessions.json'])))
    same('keepOut.combworkVcs', await traced(base, () => combworkVcs(project)))
    const plain = join(base, 'plain')
    mkdirSync(plain, { recursive: true })
    same('keepOut.noRepository', await traced(base, () => ensureCombworkExcluded(plain)))
  })

  it("repairs a moved folder's worktrees (the 1.1 folder move)", async () => {
    const base = tempDir('cutover-traces-')
    const project = gitRepo(join(base, 'project'))
    commit(project, { 'a.txt': 'a\n' }, 'first')
    const from = join(base, 'old', 'wt')
    mkdirSync(join(base, 'old'), { recursive: true })
    sh(project, 'worktree', 'add', '-q', '-b', 'side', from)
    const to = join(base, 'new', 'wt')
    mkdirSync(join(base, 'new'), { recursive: true })
    renameSync(from, to)
    same('relocate.repairWorktrees', await traced(base, () => repairWorktrees(project, [{ from: join(base, 'old'), to: join(base, 'new') }])))
    same('relocate.noRepository', await traced(base, () => repairWorktrees(join(base, 'new'), [])))
  })

  it("reads a run's checked-out revision, a revision's commit and the queue's commits behind", async () => {
    const base = tempDir('cutover-traces-')
    const project = gitRepo(join(base, 'project'))
    commit(project, { 'a.txt': 'a\n' }, 'first')
    sh(project, 'branch', 'target')
    commit(project, { 'b.txt': 'b\n' }, 'second')
    same('runLink.folderHead', await traced(base, () => folderHead(project)))
    same('runLink.commitIn', await traced(base, () => commitIn(project, 'target')))
    same('runLink.commitInNone', await traced(base, () => commitIn(project, 'no-such-line')))
    same('queue.commitsBehind', await traced(base, () => commitsBehind(project, 'main', 'target')))
    same('queue.commitsBehindGone', await traced(base, () => commitsBehind(project, 'main', 'gone')))
  })

  it("reads a card's adoption and the options form's presets, Git and None", async () => {
    const base = tempDir('cutover-traces-')
    const project = gitRepo(join(base, 'project'))
    commit(project, { 'a.txt': 'a\n' }, 'first')
    sh(project, 'branch', 'target')
    commit(project, { 'b.txt': 'b\n' }, 'second')
    same('adoption.git', await traced(base, () => adoptionInputs(project, 'git', 'review', { agent: 'user', target: 'target' })))
    same('adoption.none', await traced(base, () => adoptionInputs(project, 'none', 'review', { agent: 'user', target: 'target' })))
    same('presets.git', await traced(base, () => presetInputs(project, 'git')))
    same('presets.none', await traced(base, () => presetInputs(project, 'none')))
  })
})
