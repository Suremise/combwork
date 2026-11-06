import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser'
import { PSEUDO_LANGUAGE } from '../../src/shared/i18n/languages'
import { setLanguage, setProblemReporter, tr, type Msg } from '../../src/shared/i18n'
import { gitFixText, gitOldText, gitProblemEnglish, gitProblemText } from '../../src/shared/gitTool'
import { folderBusy, folderBusyData, gitStatusText, gitStatusTip, headText, identityWarnings, type GitRepoSummary } from '../../src/shared/gitRepo'
import { gitignoreName, initAbout, type GitInitCheck } from '../../src/shared/gitInit'
import { englishText } from '../../src/shared/advanced'
import { combworkVcsText } from '../../src/shared/combworkVcsText'

// #804: the `git` area (the Git tab, Initialise repository, the .combwork notice, and what the shared git modules say). Its
// messages are read from the English catalogue (tests/i18nCatalogues.test.ts checks it is current); the sentences that
// were glued together or pluralised by hand read as they did in English; and what main's errors carry stays English
// whatever the window's language, as agents read it too.

const ROOT = resolve(__dirname, '../..')
const CATALOGUE = JSON.parse(readFileSync(join(ROOT, 'locales/en/git.json'), 'utf8')) as Record<string, { defaultMessage: string; description: string }>
const M: Record<string, Msg> = Object.fromEntries(Object.entries(CATALOGUE).map(([id, m]) => [id, { id, ...m }]))
const m = (id: string): Msg => {
  expect(M[id], id).toBeTruthy()
  return M[id]
}

afterEach(() => {
  setLanguage('en', {})
  setProblemReporter(() => undefined)
})

/** A message's placeholders (tags aside). */
function placeholders(els: MessageFormatElement[], acc = new Set<string>()): Set<string> {
  for (const el of els) {
    if (el.type === TYPE.literal || el.type === TYPE.pound) continue
    if (el.type !== TYPE.tag) acc.add(el.value)
    if (el.type === TYPE.plural || el.type === TYPE.select) for (const o of Object.values(el.options)) placeholders(o.value, acc)
    if (el.type === TYPE.tag) placeholders(el.children, acc)
  }
  return acc
}

/** Some value for each placeholder: a number where it is a plural's. */
function sampleValues(message: string): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  const walk = (els: MessageFormatElement[]): void => {
    for (const el of els) {
      if (el.type === TYPE.plural) out[el.value] = 2
      else if (el.type === TYPE.argument || el.type === TYPE.select || el.type === TYPE.number) out[el.value] ??= el.type === TYPE.number ? 2 : 'X'
      if (el.type === TYPE.plural || el.type === TYPE.select) for (const o of Object.values(el.options)) walk(o.value)
      if (el.type === TYPE.tag) walk(el.children)
    }
  }
  walk(parse(message))
  return out
}

const summary = (s: Partial<GitRepoSummary>): GitRepoSummary => ({ isRepo: true, branch: 'main', head: 'abc1234', state: null, upstream: null, remotes: [], fetchedAt: null, ...s })
const check = (c: Partial<GitInitCheck>): GitInitCheck => ({ refused: null, identity: { name: 'A', email: 'a@b' }, hasGitignore: false, empty: false, ...c })

describe('the git area', () => {
  it('has its messages, each with a note for translators, all under git.', () => {
    expect(Object.keys(CATALOGUE).length).toBeGreaterThan(150)
    for (const [id, c] of Object.entries(CATALOGUE)) {
      expect(id.startsWith('git.'), id).toBe(true)
      expect(c.description.length, id).toBeGreaterThan(10)
    }
  })

  it("its typed values list every message's placeholders", () => {
    const dts = readFileSync(join(ROOT, 'src/shared/i18n/values/git.d.ts'), 'utf8')
    for (const [id, c] of Object.entries(CATALOGUE)) {
      const line = dts.split(/\r?\n/).find((l) => l.trim().startsWith(`'${id}':`))
      expect(line, id).toBeTruthy()
      const names = [...placeholders(parse(c.defaultMessage))]
      if (!names.length) expect(line, id).toMatch(/: undefined$/)
      for (const n of names) expect(line, `${id}: ${n}`).toContain(`${n}: `)
    }
  })

  it('the pseudo-locale formats every message, with nothing reported', () => {
    const problems: string[] = []
    setProblemReporter((p) => problems.push(p))
    setLanguage(PSEUDO_LANGUAGE, {})
    for (const [id, c] of Object.entries(CATALOGUE)) {
      if (/<\w+>/.test(c.defaultMessage)) continue
      expect(tr(M[id], sampleValues(c.defaultMessage)), id).toMatch(/^\[.*\]$/s)
    }
    expect(problems).toEqual([])
  })
})

describe('git missing or too old', () => {
  it('reads as before in English, and how to fix it', () => {
    expect(gitProblemText({ state: 'missing' })).toBe("Git isn't installed (or isn't on Combwork's PATH)")
    expect(gitProblemText({ state: 'old', version: '2.16.0' })).toBe('Git 2.16.0 is too old for Combwork (it needs 2.38 or later)')
    expect(gitFixText({ state: 'old', version: '2.30.0' })).toBe('Update Git for Windows to 2.38 or later, then Check again in Provider Setup.')
    expect(gitFixText({ state: 'missing' })).toBe('Install Git for Windows (2.38 or later), or add the folder holding git.exe to your PATH, then Check again in Provider Setup (no need to restart Combwork).')
  })

  it("lists what an older git loses, by how old it is", () => {
    const base = "merging can't check for conflicts before it starts (the merge still stops at one); squash-merged branches still count as unmerged, so Remove All and loading a template keep their worktrees; the merge-ready skill can't check a branch for conflicts"
    expect(gitOldText('2.37.0')).toBe(`With Git 2.37.0: ${base}.`)
    expect(gitOldText('2.29.0')).toBe(`With Git 2.29.0: ${base}; moving a workspace can't repair its worktrees.`)
    expect(gitOldText('2.26.0')).toBe(`With Git 2.26.0: ${base}; Remove All and loading a template keep the branches of the worktrees they remove; moving a workspace can't repair its worktrees.`)
    expect(gitOldText('2.16.0')).toBe("Combwork's git commands fail with Git 2.16.0: worktrees, merging, the Version Control tab's Git sections and the unmerged counts don't work.")
  })

  it("stays English for the main process's errors, whatever the window's language", () => {
    setLanguage(PSEUDO_LANGUAGE, {})
    expect(gitProblemText({ state: 'missing' })).not.toBe("Git isn't installed (or isn't on Combwork's PATH)")
    expect(gitProblemEnglish({ state: 'missing' })).toBe("Git isn't installed (or isn't on Combwork's PATH)")
    expect(gitProblemEnglish({ state: 'old', version: '2.16.0' })).toBe('Git 2.16.0 is too old for Combwork (it needs 2.38 or later)')
    expect(gitProblemEnglish({ state: 'old', version: '2.30.0' })).toBeNull()
    expect(gitProblemEnglish({ state: 'ok', version: '2.45.0' })).toBeNull()
  })
})

describe('the sentences once built by hand read as before, in English', () => {
  it('the folder busy, by status and action', () => {
    expect(folderBusy([{ name: 'B1', status: 'signin' }], [], 'create')).toBe('B1 stopped in the middle of a task when its sign-in expired in the project folder: create and switch to a branch once it has finished.')
    expect(folderBusy([], [{ branch: 'main', holder: null, byUser: true, waiting: [] }], 'pull')).toBe('Your merge into main is running: pull once it is done.')
    expect(folderBusy([], [{ branch: 'main', holder: null, waiting: ['B2'] }], 'switch')).toBe('B2 is waiting for the merge slot for main: switch branches once those merges are done.')
    // As text (#871): its English for main's refusal, the same words, the waiting agents a unit list as before.
    const slots = [{ branch: 'main', holder: null, waiting: ['B2', 'B3'] }]
    expect(englishText(folderBusyData([], slots, 'pull')!)).toBe('B2, B3 are waiting for the merge slot for main: pull once those merges are done.')
    expect(folderBusy([], slots, 'pull')).toBe(englishText(folderBusyData([], slots, 'pull')!))
    setLanguage(PSEUDO_LANGUAGE, {})
    expect(folderBusy([], slots, 'pull')).toMatch(/^\[/)
    expect(englishText(folderBusyData([], slots, 'pull')!)).toBe('B2, B3 are waiting for the merge slot for main: pull once those merges are done.')
  })

  it("the status bar's item and tooltip", () => {
    expect(headText({ branch: null, head: 'abc1234' })).toBe('detached at abc1234')
    expect(headText({ branch: null, head: null })).toBe('no commits yet')
    expect(gitStatusText(summary({ state: 'cherry-pick', remotes: ['origin'] }))).toBe('main · cherry-picking · no upstream')
    expect(gitStatusTip(summary({ state: 'cherry-pick', upstream: { name: 'origin/main', remote: 'origin', ahead: 1, behind: 0 }, remotes: ['origin'] }), '5m ago').split('\n')).toEqual([
      'On main',
      'Git is cherry-picking: finish or abort it in a terminal.',
      'Tracks origin/main: 1 commit to push, nothing to pull.',
      'As of the last fetch, 5m ago. Combwork never fetches by itself.',
      'Click for Version Control → Branches & remotes.'
    ])
    expect(gitStatusTip(summary({ upstream: { name: 'origin/main', remote: 'origin', ahead: 3, behind: 2 }, remotes: ['origin'] }), null)).toContain('Tracks origin/main: 3 commits to push, 2 commits to pull.')
    // #915: the counts are numbers in the window's language.
    const far = summary({ upstream: { name: 'origin/main', remote: 'origin', ahead: 1234, behind: 0 }, remotes: ['origin'] })
    expect(gitStatusText(far)).toBe('main · origin · ↑1,234 ↓0')
    setLanguage('de', { 'git.status.aheadBehind': '↑{ahead, number} ↓{behind, number}' })
    expect(gitStatusText(far)).toBe('main · origin · ↑1.234 ↓0')
  })

  it('the commit identity', () => {
    expect(identityWarnings({ local: {}, global: {}, effective: {} }, [])).toEqual(['Git has no user.name or user.email for this repository, so commits fail. Set them here (or in your global git config).'])
    expect(identityWarnings({ local: {}, global: {}, effective: { name: 'A' } }, [])[0]).toMatch(/^Git has no user\.email for this/)
  })

  it('Initialise repository', () => {
    expect(gitignoreName('minimal')).toBe('a minimal .gitignore')
    expect(gitignoreName('dotnet')).toBe('a .NET .gitignore')
    expect(initAbout('alpha', check({ resume: true, empty: true, hasGitignore: true }))).toBe(
      'alpha is a git repository with no commits yet, and worktrees need one. This keeps its .combwork out of git and commits nothing yet (an empty first commit) as the first commit. Its own .gitignore is kept.'
    )
    expect(initAbout('alpha', check({ hasGitignore: true, parentRepo: 'D:\\ws' }))).toBe(
      'Makes alpha a git repository on a branch called main, keeps its .combwork out of git, and commits everything in the folder as the first commit, so agents can work in worktrees at once. Its own .gitignore is kept. It is inside the git repository in D:\\ws: a repository inside another is usually a mistake, and that one will no longer see the files here as its own.'
    )
  })

  it('the .combwork notice', () => {
    expect(combworkVcsText({ state: 'excluded', tracked: 1 })?.title).toBe('1 file in .combwork is committed to git')
    expect(combworkVcsText({ state: 'not-excluded', tracked: 3 })?.detail).toBe(
      "Excluding .combwork keeps new files out of git, but these were committed before, so git still tracks them and commits their changes. Run `git rm -r --cached .combwork` in the project folder, then commit: the files stay on disk. Combwork couldn't exclude .combwork either: a rule in a .gitignore may bring it back."
    )
    expect(tr(m('git.combworkVcs.titleSentence'), { title: 'X' })).toBe('X.')
    expect(tr(m('git.combworkVcs.untrackTitle'), { count: 1 })).toBe('Untrack this file?')
    expect(tr(m('git.combworkVcs.untrackTitle'), { count: 4 })).toBe('Untrack these 4 files?')
    expect(tr(m('git.init.commitsAs'), { name: 'A', email: 'a@b' })).toBe('Commits as A <a@b>.')
  })

  it('the Git tab', () => {
    expect(tr(m('git.switch.idle'), { agents: 'One', count: 1, branch: 'dev' })).toBe('One has a session in the project folder: it finds dev on the next turn.')
    expect(tr(m('git.switch.idle'), { agents: 'One, Two', count: 2, branch: 'dev' })).toBe('One, Two have sessions in the project folder: they find dev on the next turn.')
    expect(tr(m('git.newBranch.message'), { onBranch: 'yes', commit: 'abc1234', current: 'main' })).toBe('A branch at abc1234, where main is now.')
    expect(tr(m('git.newBranch.message'), { onBranch: 'no', commit: 'abc1234', current: '' })).toBe('A branch at abc1234.')
    expect(tr(m('git.tags.about'), { onBranch: 'yes', branch: 'main' })).toBe("Tags the commit the project folder has checked out (main). With a message, it's an annotated tag.")
    expect(tr(m('git.branches.checkedOut'), { where: 'agent', agent: 'One' })).toBe("Checked out in One's worktree: a branch is in one folder at a time.")
    expect(tr(m('git.identity.about'), { project: 'alpha', hasGlobal: 'yes', global: 'a@b' })).toBe(
      "Who alpha's commits are made as, agents' too (git config --local). Leave both empty to use your global identity (a@b). On GitHub, its no-reply address keeps your email private."
    )
  })
})
