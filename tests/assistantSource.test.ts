// HI-3584: the Assistant links a card to a GitHub issue or pull request (cw_create_task's and cw_update_task's source),
// as the user does in the card dialog: read through the same path (a pull request first, else an issue, on the project's
// GitHub link only), with the same limits (never started, in Todo or On Hold) and label; an agent is refused before
// anything is read. Its change is recorded and undone as its other card changes are, and a card it linked is one Close
// Shipped Issues… lists. Nothing is written to GitHub. gh is a fake executable given through the test seam (CW_TEST_GH).
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-assistant-source-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const ghDir = join(base, 'gh')
const callLog = join(ghDir, 'calls.jsonl')
const repoFile = join(ghDir, 'repo.txt')
mkdirSync(ghDir, { recursive: true })
// Issues #31 and #32 and pull request #7 of acme/app; the release v1.0.0 published, GitHub's tags the project's own.
writeFileSync(
  join(ghDir, 'gh.cjs'),
  [
    "const fs = require('fs')",
    'const args = process.argv.slice(2)',
    `fs.appendFileSync(${JSON.stringify(callLog)}, JSON.stringify(args) + '\\n')`,
    "const out = (j) => { process.stdout.write(typeof j === 'string' ? j : JSON.stringify(j)); process.exit(0) }",
    "const fail = (s) => { process.stderr.write(s); process.exit(1) }",
    "const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null)",
    "if (args.includes('-R') && opt('-R') !== 'github.com/acme/app') fail('wrong repository: ' + opt('-R'))",
    "if (args[0] === 'pr' && args[1] === 'view' && args[2] === '7') out({ number: 7, title: 'Tidy the README', url: 'https://github.com/acme/app/pull/7', headRefName: 'tidy', baseRefName: 'main', isCrossRepository: false, maintainerCanModify: true, author: { login: 'mona' }, body: 'Tidies it.', commits: [] })",
    "if (args[0] === 'issue' && args[1] === 'view' && (args[2] === '31' || args[2] === '32')) out({ number: Number(args[2]), title: 'Issue ' + args[2], url: 'https://github.com/acme/app/issues/' + args[2], author: { login: 'stranger' }, body: 'It breaks.', labels: [], state: 'OPEN', comments: [] })",
    "if (args[0] === 'api' && /^repos\\/acme\\/app\\/(issues|pulls)\\/\\d+$/.test(args[1] || '')) out('NONE\\n')",
    "const tagRef = /^repos\\/acme\\/app\\/git\\/ref\\/tags\\/(.+)$/.exec(args[1] || '')",
    `if (args[0] === 'api' && tagRef) { try { out({ ref: 'refs/tags/' + tagRef[1], object: { type: 'commit', sha: require('child_process').execFileSync('git', ['-C', fs.readFileSync(${JSON.stringify(repoFile)}, 'utf8'), 'rev-parse', tagRef[1] + '^{commit}']).toString().trim() } }) } catch { fail('HTTP 404: Not Found') } }`,
    "if (args[0] === 'release' && args[1] === 'view' && args[2] === 'v1.0.0') out({ isDraft: false, url: 'https://github.com/acme/app/releases/tag/v1.0.0' })",
    "fail('GraphQL: Could not resolve to a PullRequest (' + args.slice(0, 3).join(' ') + ')')"
  ].join('\n')
)
writeFileSync(join(ghDir, 'gh.cmd'), '@node "%~dp0gh.cjs" %*\r\n')
process.env.CW_USER_DATA = join(base, 'profile')
process.env.CW_TEST_GH = join(ghDir, 'gh.cmd')
const calls = (): string[][] => (existsSync(callLog) ? readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : [])
const writes = (): string[][] => calls().filter((c) => (c[0] === 'issue' && ['close', 'comment', 'edit', 'create', 'reopen', 'delete'].includes(c[1])) || (c[0] === 'api' && c.includes('--method')) || (c[0] === 'pr' && ['comment', 'review', 'close', 'merge', 'edit'].includes(c[1])))

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const changes = await import('../src/main/assistantChanges')
const control = await import('../src/main/assistantControl')
const { userUndo } = await import('../src/main/assistantUndo')
const { advanced } = await import('../src/main/advanced')
const { shippedIssuesOf } = await import('../src/main/issueSources')
const { FactStore } = await import('../src/main/workflow/factStore')
const { apiTextTestHooks } = await import('../src/main/servers')
const { config } = await import('../src/main/config')

advanced.load(join(base, 'profile'))
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  advanced.stop()
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})
beforeEach(() => writeFileSync(callLog, ''))

const user = { kind: 'user' } as const
const assistant = { kind: 'assistant' } as const
const agent = { kind: 'agent', name: 'Builder (p)', self: { project: 'p', agentId: 'a1' }, scope: 'p' } as const
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
let n = 0

/** A workspace with project p, a Git repository whose origin is acme/app on github.com (a URL only). */
async function workspace(): Promise<{ w: WS; ws: string; repo: string }> {
  const ws = join(base, `ws-${++n}`)
  const repo = join(ws, 'p')
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(repo, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v)
  writeFileSync(join(repo, '.gitignore'), '.combwork/\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git')
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Builder' }] }))
  writeFileSync(repoFile, repo)
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, ws, repo }
}
/** One change of the Assistant's, recorded as servers.ts' assistantChange records it. */
const asAssistant = <T>(ws: string, w: WS, fn: () => Promise<T>): Promise<T> => changes.recordingChanges(ws, 'update-task', 'linked', () => inWorkspace(w, fn))
/** A new card of the Assistant's with a source, as POST /v1/tasks makes it. */
const assistantCard = async (w: WS, source: string, column?: 'todo' | 'hold' | 'doing') => {
  const read = await inWorkspace(w, () => tasks.readNewCardSource('p', column, source, assistant))
  return inWorkspace(w, () => tasks.createTask({ title: 'Fix it', project: 'p', labels: ['github-issue'], source: read, ...(column ? { column } : {}) }, assistant))
}

describe('the Assistant links a card to a GitHub source (HI-3584)', () => {
  it('links an existing card to an issue or a pull request, labelled as the card dialog labels it, and clears it', async () => {
    const { w } = await workspace()
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A card', project: 'p', labels: ['docs'] }, user))
    const issue = await inWorkspace(w, () => tasks.setSource(c.number, '#31', assistant))
    expect(issue.source).toMatchObject({ kind: 'issue', number: 31, owner: 'acme', repo: 'app', author: { login: 'stranger', association: 'NONE' } })
    expect(issue.labels).toEqual(['docs', 'github-issue'])
    expect(issue.sourceBody).toBe('It breaks.')
    // A pull request first, else an issue: #7 is a pull request.
    const pr = await inWorkspace(w, () => tasks.setSource(c.number, 'https://github.com/acme/app/pull/7', assistant))
    expect(pr.source).toMatchObject({ kind: 'pr', number: 7 })
    expect(pr.labels).toEqual(['docs', 'github-pr'])
    const cleared = await inWorkspace(w, () => tasks.setSource(c.number, null, assistant))
    expect(cleared.source).toBeUndefined()
    expect(cleared.labels).toEqual(['docs'])
    expect((await inWorkspace(w, () => tasks.getTask(c.number, w))).history.at(-1)?.by).toBe('Assistant')
    expect(writes()).toEqual([])
  })

  it('makes a new card linked in one save, only in Todo or On Hold', async () => {
    const { w } = await workspace()
    const made = await assistantCard(w, '#31')
    expect(made).toMatchObject({ column: 'todo', labels: ['github-issue'], source: { kind: 'issue', number: 31 } })
    const history = (await inWorkspace(w, () => tasks.getTask(made.number, w))).history
    expect(history.map((h) => [h.whatText?.id, h.at === history[0].at])).toEqual([
      ['tasks.history.created', true],
      ['tasks.history.source', true]
    ])
    expect((await assistantCard(w, '#32', 'hold')).column).toBe('hold')
    writeFileSync(callLog, '')
    await expect(assistantCard(w, '#31', 'doing')).rejects.toThrow('A card linked to a GitHub pull request or issue is made in Todo or On Hold')
    await expect(inWorkspace(w, () => tasks.readNewCardSource(null, undefined, '#31', assistant))).rejects.toThrow('only a project’s cards do')
    expect(calls()).toEqual([])
  })

  it('has the user’s limits: not once its work has started, nor an address of another repository', async () => {
    const { w } = await workspace()
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A card', project: 'p' }, user))
    await expect(inWorkspace(w, () => tasks.setSource(c.number, 'https://github.com/other/app/issues/31', assistant))).rejects.toThrow('isn’t on this project’s repository (acme/app on github.com)')
    await inWorkspace(w, () => tasks.updateTask(c.number, { column: 'doing', agent: 'a1' }, user))
    await expect(inWorkspace(w, () => tasks.setSource(c.number, '#31', assistant))).rejects.toThrow('can’t change once its work has started')
    expect((await inWorkspace(w, () => tasks.getTask(c.number, w))).source).toBeUndefined()
  })

  it('refuses an agent before anything is read, as before; the From GitHub… lists stay the user’s', async () => {
    const { w } = await workspace()
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A card', project: 'p' }, user))
    await expect(inWorkspace(w, () => tasks.setSource(c.number, '#31', agent))).rejects.toThrow('Only the user, or the Assistant for them, links a card to a GitHub pull request or issue.')
    await expect(inWorkspace(w, () => tasks.setSource(c.number, null, agent))).rejects.toThrow(tasks.TaskPermissionError)
    await expect(inWorkspace(w, () => tasks.readNewCardSource('p', undefined, '#31', agent))).rejects.toThrow(tasks.TaskPermissionError)
    expect(() => tasks.checkSourceActor(agent)).toThrow(tasks.TaskPermissionError)
    expect(() => tasks.checkSourceActor(assistant)).not.toThrow()
    await expect(inWorkspace(w, () => tasks.createFromIssue('p', 31, { host: 'github.com', owner: 'acme', repo: 'app' }, { title: 't', description: 'd' }, assistant))).rejects.toThrow('Only the user sets a card’s GitHub source.')
    expect(calls()).toEqual([])
    expect((await inWorkspace(w, () => tasks.getTask(c.number, w))).source).toBeUndefined()
  })

  it('refuses a source read for a card that moved to another project before the save', async () => {
    const { w, ws } = await workspace()
    mkdirSync(join(ws, 'q', '.combwork'), { recursive: true })
    writeFileSync(join(ws, 'q', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    await w.refresh()
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A card', project: 'p' }, user))
    const read = await inWorkspace(w, () => tasks.readCardSource(c.number, '#31', assistant))
    await inWorkspace(w, () => tasks.updateTask(c.number, { project: 'q' }, user))
    await expect(inWorkspace(w, () => tasks.writeCardSource(c.number, read, assistant))).rejects.toThrow('moved to another project while its GitHub source was read')
  })

  it('is recorded and undone as its other card changes: the source and its label back; a source changed since is kept', async () => {
    const { w, ws } = await workspace()
    await control.newAssistantToken(ws)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A card', project: 'p', labels: ['docs'] }, user))
    control.newTurn(ws)
    const group = control.currentTurn(ws).id
    await asAssistant(ws, w, () => tasks.setSource(c.number, '#31', assistant))
    const recorded = changes.changeGroups(w).find((g) => g.id === group)!.changes
    expect(recorded.map((x) => [x.kind, x.card, [...x.fields].sort().join()])).toEqual([['card', c.number, 'labels,source']])
    const undone = await userUndo(w, { group })
    expect(undone[0]).toMatchObject({ undone: expect.arrayContaining(['source', 'labels']), skipped: [] })
    const back = await inWorkspace(w, () => tasks.getTask(c.number, w))
    expect([back.source, back.sourceBody, back.labels]).toEqual([undefined, undefined, ['docs']])
    // Changed since by the user: kept, said.
    control.newTurn(ws)
    const again = control.currentTurn(ws).id
    await asAssistant(ws, w, () => tasks.setSource(c.number, '#31', assistant))
    await inWorkspace(w, () => tasks.setSource(c.number, '#32', user))
    const kept = await userUndo(w, { group: again })
    expect(kept[0].skipped).toEqual(expect.arrayContaining([{ field: 'source', why: 'changed' }]))
    const keptCard = await inWorkspace(w, () => tasks.getTask(c.number, w))
    expect(keptCard.source).toMatchObject({ number: 32 })
    // HR1's round 1: its label stays with the source kept.
    expect(keptCard.labels).toEqual(['docs', 'github-issue'])
    // Changed since to a pull request: the source and its github-pr kept, the Assistant's github-issue gone with its source.
    await inWorkspace(w, () => tasks.setSource(c.number, null, user))
    control.newTurn(ws)
    const third = control.currentTurn(ws).id
    await asAssistant(ws, w, () => tasks.setSource(c.number, '#31', assistant))
    await inWorkspace(w, () => tasks.setSource(c.number, '#7', user))
    const keptPr = await userUndo(w, { group: third })
    expect(keptPr[0].skipped).toEqual(expect.arrayContaining([{ field: 'source', why: 'changed' }]))
    expect(await inWorkspace(w, () => tasks.getTask(c.number, w))).toMatchObject({ source: { kind: 'pr', number: 7 }, labels: ['docs', 'github-pr'] })
    // A label the Assistant's change added beside the source still goes back while the source stays.
    await inWorkspace(w, () => tasks.setSource(c.number, null, user))
    control.newTurn(ws)
    const fourth = control.currentTurn(ws).id
    await asAssistant(ws, w, async () => {
      await tasks.setSource(c.number, '#31', assistant)
      await tasks.updateTask(c.number, { labels: ['docs', 'github-issue', 'triage'] }, assistant)
    })
    await inWorkspace(w, () => tasks.setSource(c.number, '#32', user))
    await userUndo(w, { group: fourth })
    expect(await inWorkspace(w, () => tasks.getTask(c.number, w))).toMatchObject({ source: { kind: 'issue', number: 32 }, labels: ['docs', 'github-issue'] })
    expect(writes()).toEqual([])
  })

  it('through the Agent API’s routes: the Assistant’s new and existing card linked; an agent’s, or one beside a decision’s answers, refused before anything is read (HR1’s round 1)', async () => {
    const { w, ws, repo } = await workspace()
    config.settings.assistant = { ...config.settings.assistant, control: 'projects' } as typeof config.settings.assistant
    await control.newAssistantToken(ws)
    const token = readFileSync(control.assistantTokenFile(ws), 'utf8').match(/"token":\s*"([0-9a-f]+)"/)![1]
    const call = (method: string, template: string, params: string[], body: unknown, as: 'assistant' | 'agent') => {
      const run = () => apiTextTestHooks.routeHandler(method, template)!({ params, query: new URLSearchParams(), body, signal: new AbortController().signal })
      return inWorkspace(w, () => (as === 'assistant' ? apiTextTestHooks.asAssistant(ws, token, run) : apiTextTestHooks.asAgent(ws, repo, 'a1', run)))
    }
    const made = (await call('POST', '/v1/tasks', [], { title: 'Fix it', project: 'p', source: '#31', labels: ['docs'], reply: 'short' }, 'assistant')) as { number: number; text?: string }
    const card = await inWorkspace(w, () => tasks.getTask(made.number, w))
    expect(card).toMatchObject({ column: 'todo', labels: ['docs', 'github-issue'], source: { kind: 'issue', number: 31 } })
    expect(JSON.stringify(made)).toContain('Linked to issue #31')
    const other = await inWorkspace(w, () => tasks.createTask({ title: 'Another', project: 'p' }, user))
    await call('PATCH', '/v1/tasks/:n', [String(other.number)], { source: 'https://github.com/acme/app/pull/7', reply: 'short' }, 'assistant')
    expect((await inWorkspace(w, () => tasks.getTask(other.number, w))).source).toMatchObject({ kind: 'pr', number: 7 })
    await expect(call('PATCH', '/v1/tasks/:n', [String(other.number)], { source: 12 }, 'assistant')).rejects.toThrow('source is a GitHub pull request or issue of the project')
    writeFileSync(callLog, '')
    // An agent: refused before any read or change, made or patched.
    await expect(call('PATCH', '/v1/tasks/:n', [String(other.number)], { source: '#31' }, 'agent')).rejects.toThrow('Only the user, or the Assistant for them')
    await expect(call('POST', '/v1/tasks', [], { title: 'Mine', project: 'p', source: '#31' }, 'agent')).rejects.toThrow('Only the user, or the Assistant for them')
    // A decision answering requests is that change alone: with a source it is refused whole.
    const before = await inWorkspace(w, () => tasks.getTask(other.number, w))
    await expect(call('PATCH', '/v1/tasks/:n', [String(other.number)], { decision: 'Use the bee icon.', answers: ['r-1'], source: '#31' }, 'assistant')).rejects.toThrow()
    const after = await inWorkspace(w, () => tasks.getTask(other.number, w))
    expect([after.source, after.decisions?.length ?? 0, after.labels]).toEqual([before.source, before.decisions?.length ?? 0, before.labels])
    expect(calls()).toEqual([])
    expect((await inWorkspace(w, () => tasks.allTasks(w))).map((c) => c.title).sort()).toEqual(['Another', 'Fix it'])
    expect(writes()).toEqual([])
  })

  it('a card it linked is one Close Shipped Issues… lists once its release ships', async () => {
    const { w, repo } = await workspace()
    const made = await assistantCard(w, '#31')
    git(repo, 'checkout', '-q', '-b', '1.0.0')
    writeFileSync(join(repo, 'fix.txt'), 'fixed\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'fix')
    const result = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'tag', 'v1.0.0')
    git(repo, 'checkout', '-q', 'main')
    // Released into the main line, as a version's line is (issueSources' releasedLines).
    git(repo, 'merge', '-q', '--ff-only', '1.0.0')
    const facts = FactStore.forBoard(w, { project: 'p', key: 'p' })
    await store.boardWrite(w, async () => facts.tx((tx) => void tx.append(made.number, { kind: 'Integrated', actor: 'combwork', source: 'recorded', data: { revision: result, target: '1.0.0', result, method: 'merge', by: 'combwork' } } as never)))
    await inWorkspace(w, () => tasks.moveTask(made.number, 'done', { confirm: true, paths: null }))
    const shipped = await inWorkspace(w, () => shippedIssuesOf(w, repo, '1.0.0'))
    expect('issues' in shipped && shipped.issues.map((i) => [i.issue, i.card, i.state])).toEqual([[31, made.number, 'open']])
    expect(writes()).toEqual([])
  })
})
