// The Git/None cutover audit (SPEC §16.3.6's last type-map row, HI-2792's R9): every place outside Git's own
// implementation that still imports a Git module, classified edge by edge, and the remaining "platform with lines" seams
// counted per caller. tests/gitAudit.test.ts (npm run check:repo) fails on an edge or a seam this table doesn't list, on
// a listed one that is gone (stale), and on a name taken across a constrained edge beyond its list; scripts/gitInventory.mjs
// prints the audit beside HI-2781's inventory. 1.5.0's J0 starts from it: a second platform with lines routes each seam.
//
// Classes:
// - `impl`: Git's implementation, or a part of it kept in a common file (its runner, its route, its 0.9 worktrees).
// - `registry`: a port's lookup naming each platform's implementation (the only place a platform's port is named).
// - `gitUi`: Git-facing UI and text: the Git view, Provider Setup's Git row, the 0.9 agent worktrees' dialogs.
// - `historic`: a migration that only ever ran on Git data; `op` names the legacy operation it serves.
// - `defect`: a Git assumption in common code, left for its follow-up card (`card`), not fixed in the refactor.
// - `common`: a module whose name says Git but whose work is every platform's (the folder fence, keyed by folder).

import { readdirSync, readFileSync, statSync } from 'fs'
import { dirname, join, relative, resolve } from 'path'
import ts from 'typescript-classic'

/** Git's own modules: an import of one from outside Git's implementation is an edge the audit classifies. */
const GIT_FILES = new Set([
  'src/main/git',
  'src/main/gitTool',
  'src/main/gitWorker',
  'src/main/gitCompare',
  'src/main/gitRepo',
  'src/main/gitInit',
  'src/main/branchWatch',
  'src/main/branchMerge',
  'src/main/filesGit',
  'src/main/worktrees',
  'src/main/unusedWorktrees',
  'src/main/repoLock',
  'src/main/repoLockCore',
  'src/main/repoLockWorker',
  'src/main/folderFence',
  'src/main/workflow/gitHost',
  'src/main/platform/refHold',
  'src/shared/gitTool',
  'src/shared/gitInit',
  'src/shared/gitRepo',
  'src/shared/gitIgnoreRules'
])

/** Whether a module (repo path, no extension) is Git's: one of GIT_FILES, or a platform module named git… (platform/git.ts, gitHistory.ts…). */
export const isGitModule = (m) => GIT_FILES.has(m) || /^src\/main\/platform\/git([A-Z]\w*)?$/.test(m)

/** A file that could name a Git module: only these are parsed (the rest can't import one). */
const MAY_NAME_GIT = new RegExp(String.raw`git|worktree|repoLock|folderFence|branchWatch|branchMerge|refHold|require\(|import\(\s*[^'"${'`'}\s]`, 'i')

/** A dynamic import or require whose specifier isn't a string (built from pieces): it could load anything, so it is an edge too. */
const HIDDEN = '(computed specifier)'

/** Every .ts/.tsx file under `dir` (repo paths, forward slashes). */
function sources(root, dir = 'src') {
  const out = []
  for (const e of readdirSync(join(root, dir))) {
    const p = `${dir}/${e}`
    if (statSync(join(root, p)).isDirectory()) out.push(...sources(root, p))
    else if (/\.tsx?$/.test(e) && !/\.d\.tsx?$/.test(e)) out.push(p)
  }
  return out
}

/** The files read, with `over`'s texts in place of theirs (a test's change to one, or a file added). */
const filesOf = (root, over) => [...new Set([...sources(root), ...Object.keys(over)])].map((file) => ({ file, text: over[file] ?? readFileSync(join(root, file), 'utf8') }))

/**
 * A file's imports and re-exports of Git modules: `{ file, module, names }`; names are those it takes (a namespace's: the
 * members it uses through it), null for a whole dynamic import. `over`: texts in place of the files' (tests).
 */
export function gitEdges(root, over = {}) {
  const out = []
  for (const { file, text } of filesOf(root, over)) {
    if (isGitModule(file.replace(/\.tsx?$/, ''))) continue
    // Each file's edges kept by its text (a test's runs reparse only the file it changes).
    const key = `${root}|${file}`
    const kept = parsed.get(key)
    if (kept?.text === text) {
      out.push(...kept.edges)
      continue
    }
    const edges = fileEdges(root, file, text)
    parsed.set(key, { text, edges })
    out.push(...edges)
  }
  return out.sort((a, b) => (a.file + a.module).localeCompare(b.file + b.module))
}

/** gitEdges' answers per file, by its text. */
const parsed = new Map()

/** One file's Git edges (gitEdges'). */
function fileEdges(root, file, text) {
  const out = []
  {
    const found = new Map()
    const add = (spec, names) => {
      if (spec === `./${HIDDEN}`) return void found.set(HIDDEN, null)
      // The renderer's alias for src/shared (electron.vite.config.ts).
      const path = spec.startsWith('@shared/') ? `src/shared/${spec.slice('@shared/'.length)}` : spec.startsWith('.') ? relative(root, resolve(root, dirname(file), spec)) : null
      if (path === null) return
      const module = path.replace(/\\/g, '/').replace(/\.(tsx?|js)$/, '')
      if (!isGitModule(module)) return
      const had = found.get(module)
      if (names === null || had === null) found.set(module, null)
      else found.set(module, [...new Set([...(had ?? []), ...names])].sort())
    }
    // TypeScript's own parser (HR1's HI-2792 round 1: a regex missed double quotes, indentation and side-effect imports).
    // Only a file whose text could name a Git module is parsed.
    if (!MAY_NAME_GIT.test(text)) return out
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    /** The members used through a namespace's name (`wt.createWorktree`), anywhere in the file. */
    const membersOf = (alias) => {
      const used = new Set()
      const visit = (n) => {
        if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === alias) used.add(n.name.text)
        if (ts.isQualifiedName(n) && ts.isIdentifier(n.left) && n.left.text === alias) used.add(n.right.text)
        ts.forEachChild(n, visit)
      }
      visit(sf)
      return [...used]
    }
    /** The names a module specifier's clause takes: named ones (by their exported name), `default`, a namespace's members; [] for a side effect. */
    const clauseNames = (clause) => {
      if (!clause) return []
      const names = clause.name ? ['default'] : []
      const b = clause.namedBindings
      if (b && ts.isNamespaceImport(b)) names.push(...membersOf(b.name.text))
      else if (b) names.push(...b.elements.map((e) => (e.propertyName ?? e.name).text))
      return names
    }
    const visit = (n) => {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) add(n.moduleSpecifier.text, clauseNames(n.importClause))
      else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) add(n.moduleReference.expression.text, membersOf(n.name.text))
      else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
        const c = n.exportClause
        add(n.moduleSpecifier.text, !c ? null : ts.isNamespaceExport(c) ? null : c.elements.map((e) => (e.propertyName ?? e.name).text))
      } else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require')) && n.arguments.length) {
        const arg = n.arguments[0]
        // A dynamic import or require: the names destructured from it (`const { a } = await import('./x')`), else the whole module.
        let up = n.parent
        while (up && (ts.isAwaitExpression(up) || ts.isParenthesizedExpression(up))) up = up.parent
        const bound = up && ts.isVariableDeclaration(up) && ts.isObjectBindingPattern(up.name) ? up.name.elements.map((e) => (e.propertyName && ts.isIdentifier(e.propertyName) ? e.propertyName : e.name).text) : null
        if (ts.isStringLiteralLike(arg)) add(arg.text, bound)
        // A specifier the parser can't read (built from pieces) is a hidden loader: named as such, so the audit fails it.
        else add(`./${HIDDEN}`, null)
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
    // Repo paths without the extension (a script's path in the table would read as one it runs: the WorkspaceService rule).
    for (const [module, names] of found) out.push({ file: file.replace(/\.tsx?$/, ''), module, names })
  }
  return out
}

/** The "platform with lines" seams (HI-2792): each call of these lookups, counted per file. */
export const SEAM_CALLS = ['lineHistory', 'lineRepoReads', 'lineRepoOps', 'queueIntegration', 'slotWorkspaces', 'slotRelocation']

/** Each file's count of each seam call (`name(`), outside the port modules that define them. */
export function seamCounts(root, over = {}) {
  const out = {}
  for (const { file, text } of filesOf(root, over)) {
    if (/^src\/main\/platform\/(historyPorts|repoReadsPorts|repoOpsPorts|integrationPorts|workspacePorts)\.ts$/.test(file)) continue
    for (const s of SEAM_CALLS) {
      const n = [...text.matchAll(new RegExp(`\\b${s}\\(`, 'g'))].length
      if (n) (out[file.replace(/\.tsx?$/, '')] ??= {})[s] = n
    }
  }
  return out
}

/**
 * The classified edges: `file` imports `module`, of class `class` because `why`. `names`: the only names it may take
 * there (omitted: any, for a module that is Git-facing as a whole). `op`: a historic edge's legacy operation.
 */
export const EDGES = [
  { file: 'src/main/agentWorktree', module: 'src/main/worktrees', class: 'impl', names: ['GIT_FAILED', 'uniqueFolder'], why: "a 0.9 worktree's recreation: a free folder's name and the failure message (R4's rule: no git run)" },
  { file: 'src/main/antivirus', module: 'src/main/worktrees', class: 'impl', names: ['worktreesRoot'], why: "the worktrees folder beside the workspace, excluded from scanning (Git's slots and 0.9 worktrees live there)" },
  { file: 'src/main/combworkMove', module: 'src/main/platform/gitKeepOut', class: 'historic', names: ['excludeLine', 'gitDirOf'], op: 'excludeMoveLock and moveExcludeLine (HI-2462)', why: "1.1's .hive → .combwork move keeps git's exclude lines right" }, // old-name: the 1.1 folder move's input, named as it was
  { file: 'src/main/combworkMove', module: 'src/main/repoLock', class: 'common', names: ['withNamedLock'], why: "the folder move's named lock (a lock file of Combwork's, not git's)" },
  { file: 'src/main/platform/jjOperations', module: 'src/main/git', class: 'impl', names: ['git'], why: "an operation preview reads the colocated store's refs and HEAD to compare with jj's record (HI-2800, E8): read-only git calls, never an import" },
  { file: 'src/main/platform/jjKeepOut', module: 'src/main/platform/gitKeepOut', class: 'impl', names: ['excludeLine', 'hasExcludeLine'], why: "a non-colocated jj repository's .combwork kept out in its Git store's info/exclude (HI-2800): Git's exclude-line text, pure helpers, no git run" },
  { file: 'src/main/platform/jjCompat', module: 'src/main/git', class: 'impl', names: ['git'], why: "jj's compatibility assessment reads Git's effective config, attributes and files of the colocated store (HI-2799, §16.3.6's gates): read-only git calls" },
  { file: 'src/main/workflow/storeSwitch', module: 'src/main/repoLock', class: 'common', names: ['commonGitDir'], why: "the store a Git ↔ jj switch is about (HI-2799): the Git store both platforms share, the repository lock's own key" },
  { file: 'src/main/deliveries', module: 'src/main/folderFence', class: 'common', names: ['folderChanging', 'folderSteady', 'inFolder', 'onFolderSteady'], why: "the folder fence: keyed by folder, every platform's (§16.3.6 port 1)" },
  { file: 'src/main/files', module: 'src/shared/gitIgnoreRules', class: 'gitUi', why: "the Files tab's ignore rule type (the Git dimming's tooltip)" },
  { file: 'src/main/index', module: 'src/main/branchWatch', class: 'gitUi', why: "starts the branch cards' watcher (the Git view's branch status)" },
  { file: 'src/main/index', module: 'src/main/unusedWorktrees', class: 'impl', names: ['setQueueNeed', 'setSlotPools'], why: "tells the 0.9 worktrees' clean-up which folders the slot pools and queues need" },
  { file: 'src/main/ipc', module: 'src/main/branchMerge', class: 'gitUi', why: "the Merge dialog's card and confirmation (R3: its merge goes through RepoOps)" },
  { file: 'src/main/ipc', module: 'src/main/branchWatch', class: 'gitUi', why: "the branch cards' status" },
  { file: 'src/main/ipc', module: 'src/main/filesGit', class: 'gitUi', why: "the Files tab's Git menu reads (R3 moved its writes to RepoOps)" },
  { file: 'src/main/ipc', module: 'src/main/gitTool', class: 'gitUi', why: "Provider Setup's Git row (git:tool), Git's own tool" },
  { file: 'src/main/ipc', module: 'src/main/unusedWorktrees', class: 'impl', names: ['combworkWorktreeOf', 'mergeUnused', 'removalPreview', 'removeUnusedWorktree', 'unusedBranchOf', 'unusedBranchStatus', 'unusedWorktrees'], why: "the 0.9 agent worktrees' clean-up view (Git's worktrees)" },
  { file: 'src/main/lineWriter', module: 'src/main/folderFence', class: 'common', names: ['folderChanging', 'folderSteady'], why: "the folder fence: keyed by folder, every platform's" },
  { file: 'src/main/nameUpgradeProjects', module: 'src/main/git', class: 'historic', names: ['git'], op: 'moveRefs (HI-2594)', why: "1.1's name upgrade moves refs/hive/* to refs/cw/*" }, // old-name: the 1.1 name upgrade's input refs, named as they were
  { file: 'src/main/nameUpgradeProjects', module: 'src/main/platform/gitKeepOut', class: 'historic', names: ['gitDirOf'], op: 'the exclude line upgrade (HI-2594)', why: "1.1's name upgrade rewrites git's exclude line" },
  { file: 'src/main/platform/adapters', module: 'src/main/platform/gitPlatform', class: 'registry', names: ['GitPlatform'], why: "the workflow adapters' map (HI-2792)" },
  { file: 'src/main/platform/historyPorts', module: 'src/main/platform/gitHistory', class: 'registry', names: ['gitHistory'], why: "the history port's map (R6)" },
  { file: 'src/main/slotsApp', module: 'src/main/repoLock', class: 'common', names: ['withRepoLock'], why: "jj's store lock for its workspace port's writes (HI-2866): the repository lock keyed by the store, every platform's" },
  { file: 'src/main/slotsApp', module: 'src/main/git', class: 'registry', names: ['git'], why: "jj's stale-slot recovery composed with the app's deps (HI-2866): J2's recoverStale reads the workspace's files through git, read-only" },
  { file: 'src/main/jjCards', module: 'src/main/git', class: 'registry', names: ['git'], why: "jj's card work composed with the app's deps (HI-2868): git on jj's Git-backed store (`--git-dir`): its pins, the named revision's resolution, J5's reads" },
  { file: 'src/main/platform/integrationPorts', module: 'src/main/platform/gitIntegration', class: 'registry', names: ['gitIntegration'], why: "the integration port's map (R7, R8)" },
  { file: 'src/main/platform/observe', module: 'src/main/git', class: 'impl', names: ['git', 'readRefsOffMain'], why: "the watcher's Git reads (refs off main's thread, git's reflog): ObservePort's Git half, kept with the common watcher (R6)" },
  { file: 'src/main/platform/repoContext', module: 'src/shared/gitIgnoreRules', class: 'impl', names: ['IgnoreRule'], why: "RepoFiles' ignore rule type: the Files tab's rule, Git's syntax" },
  { file: 'src/main/platform/repoOps', module: 'src/shared/gitIgnoreRules', class: 'gitUi', why: "RepoOps' view types keep their Git names (§16.3.6 port 5)" },
  { file: 'src/main/platform/repoOps', module: 'src/shared/gitInit', class: 'gitUi', why: "RepoOps' view types keep their Git names (§16.3.6 port 5)" },
  { file: 'src/main/platform/repoOps', module: 'src/shared/gitRepo', class: 'gitUi', why: "RepoOps' view types keep their Git names (§16.3.6 port 5)" },
  { file: 'src/main/platform/repoOpsPorts', module: 'src/main/platform/gitRepoOps', class: 'registry', names: ['gitRepoOps'], why: "the repository operations port's map (R3)" },
  { file: 'src/main/platform/repoPorts', module: 'src/main/platform/gitRepoPorts', class: 'registry', names: ['gitRepoPorts'], why: "the repository context port's map (R1)" },
  { file: 'src/main/platform/repoPorts', module: 'src/shared/gitIgnoreRules', class: 'impl', names: ['IgnoreRule'], why: "ignoredIn's rule type (RepoFiles)" },
  { file: 'src/main/platform/repoReads', module: 'src/shared/gitRepo', class: 'gitUi', why: "RepoReads' view types keep their Git names (§16.3.6 port 5)" },
  { file: 'src/main/platform/repoReadsPorts', module: 'src/main/platform/gitRepoReads', class: 'registry', names: ['gitRepoReads'], why: "the repository reads port's map (R2)" },
  { file: 'src/main/platform/workspacePorts', module: 'src/main/platform/gitWorkspacePort', class: 'registry', names: ['gitWorkspacePort'], why: "the workspace port's map (R4)" },
  { file: 'src/main/projectAgents', module: 'src/main/branchWatch', class: 'gitUi', why: "an agent's branch card checked again" },
  { file: 'src/main/projectAgents', module: 'src/main/gitTool', class: 'gitUi', why: "Add Agent's 0.9 worktree choice says why git can't run" },
  { file: 'src/main/projectAgents', module: 'src/main/repoLock', class: 'impl', names: ['withRepoLock'], why: "a 0.9 worktree's guarded removal under the repository lock (R5 left it to the audit)" },
  { file: 'src/main/projectAgents', module: 'src/main/worktrees', class: 'impl', names: ['RepoReads', 'WorktreeRef', 'branchStatus', 'dirtyCount', 'localBranches', 'removeCheckedWorktree', 'removeWorktree', 'tipOf', 'uniqueBranch', 'uniqueFolder', 'unmergedCommits', 'worktreeCheck'], why: "the 0.9 agent worktrees: Add Agent's branches, the reuse check, guarded removal (R5 left them to the audit)" },
  { file: 'src/main/projectAgents', module: 'src/shared/gitTool', class: 'gitUi', why: "Add Agent's 0.9 worktree choice says why git can't run" },
  { file: 'src/main/projectFolders', module: 'src/main/unusedWorktrees', class: 'impl', names: ['keptText'], why: "the 0.9 worktrees' kept-files text for a folder's row" },
  { file: 'src/main/projectRemoval', module: 'src/main/worktrees', class: 'impl', names: ['branchStatus', 'listWorktrees', 'removeWorktree'], why: 'removing a project: its 0.9 agent worktrees listed, checked and removed' },
  { file: 'src/main/servers', module: 'src/main/repoLock', class: 'impl', names: ['withRepoLock'], why: "the Agent API's 0.9 worktree merge under the repository lock" },
  { file: 'src/main/servers', module: 'src/main/unusedWorktrees', class: 'impl', names: ['unusedWorktreeCounts'], why: "the 0.9 worktrees' counts in the project's status" },
  { file: 'src/main/sessions', module: 'src/main/folderFence', class: 'common', names: ['folderChanging', 'folderSteady', 'inFolder'], why: "the folder fence: keyed by folder, every platform's" },
  { file: 'src/main/slotCards', module: 'src/main/folderFence', class: 'common', names: ['changingFolder', 'folderChanging', 'folderSteady'], why: "the folder fence: keyed by folder, every platform's" },
  { file: 'src/main/slotCards', module: 'src/main/repoLock', class: 'impl', names: ['withRepoLock'], why: "a card's slot preparation under the repository lock (R4 kept the lock order)" },
  { file: 'src/main/slotMigration', module: 'src/main/worktrees', class: 'historic', names: ['listWorktreesOrNull'], op: 'migrateSlots (0.9 → 1.0)', why: "1.0's slot migration adopts 0.9 worktrees" },
  { file: 'src/main/storage', module: 'src/main/unusedWorktrees', class: 'impl', names: ['unusedWorktreeFolders'], why: "the Storage view's 0.9 worktree folders" },
  { file: 'src/main/templates', module: 'src/main/worktrees', class: 'impl', names: ['RepoReads', 'WorktreeRef', 'branchStatus'], why: "templates' 0.9 worktree branch status" },
  { file: 'src/main/tray', module: 'src/main/branchWatch', class: 'gitUi', why: "the tray's branch status" },
  { file: 'src/main/workflow/mergeQueue', module: 'src/main/git', class: 'impl', names: ['GIT_PREFIX', 'git'], why: "the queue's own git when its config gives no runner (tests; the app passes QueueRunner's)" },
  { file: 'src/main/workflow/mergeQueue', module: 'src/main/gitTool', class: 'impl', names: ['gitExe'], why: "gitTree: the queue's default Git runner's tool" },
  { file: 'src/main/workflow/mergeQueue', module: 'src/main/gitWorker', class: 'impl', names: ['onOutputSettled', 'withLauncherEnv'], why: "gitTree: the queue's default Git runner's launcher" },
  { file: 'src/main/workflow/mergeQueue', module: 'src/main/platform/gitCommits', class: 'impl', names: ['CommitChild', 'CommitStream', 'commitFailed', 'readCommitStream'], why: "the merge commit's stream (R7 moved it to Git's module; the queue's runner reads it)" },
  { file: 'src/main/workflow/queueHost', module: 'src/main/folderFence', class: 'common', names: ['changingFolder', 'inFolder'], why: "the folder fence around a checked-out target's advance (R4.2)" },
  { file: 'src/main/workflow/queueHost', module: 'src/main/git', class: 'impl', names: ['git', 'withGitRoute'], why: "Git's route into the queue's host (withGitRoute, port 1), and the test-only race hook's outside commit (CW_TEST_QUEUE_RACE)" },
  { file: 'src/main/workflow/queueHost', module: 'src/main/repoLock', class: 'impl', names: ['withRepoLock'], why: 'the advance under the repository lock (R4.2)' },
  { file: 'src/main/workflow/queueRunner', module: 'src/main/git', class: 'impl', names: ['GIT_PREFIX', 'withoutGitRoute'], why: "the queue's runner: Git's launcher (its prefix, work outside the route)" },
  { file: 'src/main/workflow/queueRunner', module: 'src/main/gitTool', class: 'impl', names: ['GitExe', 'PATH_GIT', 'gitExe', 'gitExeGone'], why: "the queue's runner: Git's tool" },
  { file: 'src/main/workflow/queueRunner', module: 'src/main/gitWorker', class: 'impl', names: ['GitOutcome', 'GitRequest', 'onOutputSettled', 'withLauncherEnv'], why: "the queue's runner: Git's request and outcome" },
  { file: 'src/main/workflow/queueRunner', module: 'src/main/workflow/gitHost', class: 'impl', names: ['GitHost', 'HostResult', 'startGitHost'], why: "the queue's runner: Git's host process" },
  { file: 'src/main/workspace', module: 'src/main/worktrees', class: 'impl', names: ['worktreesRoot'], why: "the worktrees folder beside the workspace (Git's slots and 0.9 worktrees)" },
  { file: 'src/renderer/src/commands', module: 'src/shared/gitRepo', class: 'gitUi', why: "the Version Control tab's sections, for its commands" },
  { file: 'src/renderer/src/components/AgentDialogs', module: 'src/shared/gitTool', class: 'gitUi', why: "Add Agent's 0.9 worktree choice says why git can't run" },
  { file: 'src/renderer/src/components/Board', module: 'src/shared/gitTool', class: 'gitUi', why: "a slot project's board says why git can't run (Provider Setup's Git row)" },
  { file: 'src/renderer/src/components/ChangesCompare', module: 'src/shared/gitRepo', class: 'gitUi', why: "Compare's view types (the Git view's text)" },
  { file: 'src/renderer/src/components/ChangesLeftovers', module: 'src/shared/gitRepo', class: 'gitUi', why: "clean-up's branch rows (the Git view)" },
  { file: 'src/renderer/src/components/FilesGitMenu', module: 'src/shared/gitIgnoreRules', class: 'gitUi', why: "the Files tab's Git menu (ignore rules, Git's syntax)" },
  { file: 'src/renderer/src/components/InitRepo', module: 'src/shared/gitInit', class: 'gitUi', why: "Initialise repository, on Git's page (HI-1905)" },
  { file: 'src/renderer/src/components/Overlays', module: 'src/shared/gitTool', class: 'gitUi', why: "Provider Setup's Git row" },
  { file: 'src/renderer/src/components/Shell', module: 'src/shared/gitTool', class: 'gitUi', why: "the missing-Git banner (Provider Setup's Git row)" },
  { file: 'src/renderer/src/store', module: 'src/shared/gitRepo', class: 'gitUi', why: "the Version Control tab's open section" },
  { file: 'src/renderer/src/store', module: 'src/shared/gitTool', class: 'gitUi', why: "Provider Setup's Git row's state" },
  { file: 'src/renderer/src/views/GitBranches', module: 'src/shared/gitRepo', class: 'gitUi', why: 'Branches & remotes (the Git view)' },
  { file: 'src/renderer/src/views/GitTab', module: 'src/shared/gitRepo', class: 'gitUi', why: 'the Git view' },
  { file: 'src/renderer/src/views/GitTab', module: 'src/shared/gitTool', class: 'gitUi', why: "the Git view says why git can't run" },
  { file: 'src/renderer/src/views/ProjectTabs', module: 'src/shared/gitTool', class: 'gitUi', why: "the project's tabs say why git can't run" },
  { file: 'src/renderer/src/views/VersionControl', module: 'src/shared/gitRepo', class: 'gitUi', why: "the Version Control tab (the Git view's summary)" },
  { file: 'src/shared/api', module: 'src/shared/gitIgnoreRules', class: 'gitUi', why: "the window's API types for the Files tab's Git menu" },
  { file: 'src/shared/api', module: 'src/shared/gitInit', class: 'gitUi', why: "the window's API types for Initialise repository" },
  { file: 'src/shared/api', module: 'src/shared/gitRepo', class: 'gitUi', why: "the window's API types for the Git view (port 5's view types keep their Git names, §16.3.6)" },
  { file: 'src/shared/api', module: 'src/shared/gitTool', class: 'gitUi', why: "the window's API types for Provider Setup's Git row" },
  { file: 'src/shared/branchCleanup', module: 'src/shared/gitRepo', class: 'gitUi', why: "clean-up's choices over the Git view's branch rows" },
  { file: 'src/shared/tips', module: 'src/shared/gitRepo', class: 'gitUi', why: "the Git view's tip text" },
  { file: 'src/shared/types', module: 'src/shared/gitIgnoreRules', class: 'gitUi', why: "FileEntry's ignore rule (the Files tab's Git dimming)" },
  { file: 'src/shared/types', module: 'src/shared/gitTool', class: 'gitUi', why: "ProjectInfo's Git tool state (Provider Setup's Git row)" }
]

/** The seams, per file: how many calls of each lookup it makes, and why it can't route by the project's platform yet. */
export const SEAMS = {
  'src/main/agentFolders': { calls: { slotWorkspaces: 2 }, why: "a Resume's claim of a slot: the pool's platform (R5)" },
  'src/main/assistantUndo': { calls: { lineRepoOps: 1 }, why: "the Assistant's branch undo: the window's repository operations, whatever the project's workflow platform (R3)" },
  'src/main/ipc': { calls: { lineRepoReads: 19, slotWorkspaces: 1 }, why: "the window's repository reads: they read the folder whatever it is, as before (R2), the Changes tab's too (HI-2792), and Branches & remotes' Signing section (HI-1185); Slots and copies' submodules and LFS status, the slots' platform's (HI-1182)" },
  'src/main/lanes': { calls: { slotWorkspaces: 1 }, why: "a lane's start reads its slot through the pool's platform (R5)" },
  'src/main/projectAgents': { calls: { lineRepoOps: 1 }, why: "the 0.9 worktree merge through RepoOps (R3)" },
  'src/main/repoOpsIpc': { calls: { lineRepoOps: 1 }, why: "the window's repository operations (R3)" },
  'src/main/servers': { calls: { lineRepoOps: 1 }, why: "the Assistant's branch route (R3)" },
  'src/main/slotCards': { calls: { lineHistory: 1, slotWorkspaces: 1 }, why: "a slot's merged check and its folders: the pool's platform (R4, HI-2792)" },
  'src/main/slots': { calls: { lineHistory: 3, slotWorkspaces: 2 }, why: "the pool's reuse proof and folders: the pool's platform (R4, HI-2792)" },
  'src/main/workflow/focusedRun': { calls: { lineHistory: 1 }, why: "a focused pick's path changes: reached only with lines, its caller not carrying the platform (R6)" },
  'src/main/workflow/mergeQueue': { calls: { lineHistory: 1, queueIntegration: 2 }, why: "the project's identity and the owed push: the queue's work no card names (R8, HI-2792)" },
  'src/main/workflow/nextVersion': { calls: { lineRepoReads: 2, lineRepoOps: 2 }, why: "Start the next version: the window's repository reads and operations (R2, R3)" },
  'src/main/workflow/optionsForm': { calls: { lineHistory: 2 }, why: "the default target for kept targets and a changed form: reached with the project's path alone (HI-2792)" },
  'src/main/workflow/queueChecks': { calls: { lineHistory: 2 }, why: "the queue's check brackets (R6)" },
  'src/main/workflow/queueChecksApp': { calls: { slotWorkspaces: 1 }, why: "the queue's folder's submodules and LFS step: a worktree made as slots are, their platform's (HI-1182)" },
  'src/main/workflow/queueControls': { calls: { lineHistory: 9, queueIntegration: 1 }, why: "forwarding, the default target and Resume's condition: the queue's controls name no card (R8, HI-2792)" },
  'src/main/workflow/queueHost': { calls: { queueIntegration: 2 }, why: "the host's pin clean-up (R8)" },
  'src/main/workflow/queueRunner': { calls: { queueIntegration: 2 }, why: "the runner's workspace removal (R8)" },
  'src/main/workflow/reconcile': { calls: { lineHistory: 1 }, why: "a lane's own-work read (R6)" },
  'src/main/workflow/retarget': { calls: { lineHistory: 1 }, why: "the retarget preview (R6)" },
  'src/main/workflow/runLink': { calls: { lineHistory: 2 }, why: "a run's checked-out revision, before its card is known (HI-2792)" },
  'src/main/workflow/targets': { calls: { lineHistory: 3 }, why: "a lane's target and own-work reads, and empty lines dropped (R6)" },
  'src/main/workspaceMove': { calls: { slotWorkspaces: 4, slotRelocation: 1 }, why: "Repair's worktree steps: the pool's platform's relocation (HI-2792; §16.3.6's gate: relocation)" }
}

/**
 * A switch on a platform's id (`platform === 'git'`, `d.platform !== 'none'`), HI-2822's grep: SPEC §16.3.6's rule 2 says a
 * caller asks a port or reads the descriptor (a capability, its integration, deliverables, repository or operations).
 */
const SWITCH = /platform\)?\s*[!=]==?\s*'(git|none)'/g

/** Where a switch belongs: the descriptors, the platforms' adapters and the registry that picks between them. */
const SWITCH_HOME = /^src\/(shared\/platform\/descriptors|main\/platform\/(registry|adapters|adapter|git[A-Z]?\w*|none[A-Z]?\w*))$/

/**
 * The switches left outside their home, per file, each justified (HI-2822): Git-facing text that names Git, and Git's own
 * data read by a one-time step. Counted like the seams: a new switch, or one gone, fails tests/gitAudit.test.ts.
 */
export const SWITCHES = {
  'src/main/copies': { n: 1, why: "a copy's row records its platform only beyond Git's, the column's default for the rows made before jj (HI-2795): Git's data" },
  'src/main/slots': { n: 1, why: "a slot's row records its platform only beyond Git's, the column's default for the rows made before jj (HI-2795): Git's data" },
  'src/main/workflow/platformSwitch': { n: 1, why: "the switch to None warns that the folder is still a Git repository (gitFolder, git.vc.switch.gitFolder): Git-facing text" },
  'src/main/workflow/storeSwitch': { n: 1, why: "a project's repository store is read as Git's common directory (Git's, or colocated jj's): Git's data (HI-2799)" },
  'src/main/servers': { n: 1, why: "the project's status names what was found in Git's words for agents (`git at {root}`, api.project.vcsGit): Git-facing text" },
  'src/main/workflow/commitMessageStep': { n: 2, why: "HI-1997's one-time step over G19's stored Git options (in force, or kept as `kept.git`): historic, Git's data alone" },
  'src/renderer/src/views/VersionControl': { n: 1, why: "the Version Control tab compares git's own read of the folder (its status summary) with detection finding Git: Git's page" },
  'src/renderer/src/views/VersionControlHeader': { n: 1, why: "the tab's fact line says the folder is a Git repository at its root (git.vc.fact.repo, .subfolder): Git-facing text" }
}

/** Each file's count of switches on a platform's id, outside their home. */
export function switchCounts(root, over = {}) {
  const out = {}
  for (const { file, text } of filesOf(root, over)) {
    const f = file.replace(/\.tsx?$/, '')
    if (SWITCH_HOME.test(f)) continue
    const n = [...text.matchAll(SWITCH)].length
    if (n) out[f] = n
  }
  return out
}

/** The audit against the source: what isn't listed, what is listed but gone, and names beyond an edge's list. */
export function audit(root, over = {}) {
  const found = gitEdges(root, over)
  const key = (e) => `${e.file} -> ${e.module}`
  const listed = new Map(EDGES.map((e) => [key(e), e]))
  const unlisted = found.filter((e) => !listed.has(key(e))).map(key)
  const stale = EDGES.filter((e) => !found.some((f) => key(f) === key(e))).map(key)
  const extraNames = found.flatMap((f) => {
    const e = listed.get(key(f))
    if (!e?.names) return []
    if (f.names === null) return [`${key(f)}: imports it whole (namespace or dynamic), not just ${e.names.join(', ')}`]
    return f.names.filter((n) => !e.names.includes(n)).map((n) => `${key(f)}: ${n}`)
  })
  const counts = seamCounts(root, over)
  const seams = [...new Set([...Object.keys(counts), ...Object.keys(SEAMS)])].sort().flatMap((file) => {
    const have = counts[file] ?? {}
    const want = SEAMS[file]?.calls ?? {}
    return [...new Set([...Object.keys(have), ...Object.keys(want)])].filter((s) => (have[s] ?? 0) !== (want[s] ?? 0)).map((s) => `${file}: ${s}() ×${have[s] ?? 0}, listed ×${want[s] ?? 0}`)
  })
  const switched = switchCounts(root, over)
  const switches = [...new Set([...Object.keys(switched), ...Object.keys(SWITCHES)])].sort().filter((f) => (switched[f] ?? 0) !== (SWITCHES[f]?.n ?? 0)).map((f) => `${f}: ${switched[f] ?? 0} switches on a platform's id, listed ${SWITCHES[f]?.n ?? 0}`)
  return { found, unlisted, stale, extraNames, seams, switches }
}
