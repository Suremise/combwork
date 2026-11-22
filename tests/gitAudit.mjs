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
import { basename, dirname, join, relative, resolve } from 'path'
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
  // HI-2944: Commit and Set aside of a target folder's changes (port 5's folderChanges, Git's implementation).
  'src/main/gitFolderChanges',
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
    if (/^src\/main\/platform\/(historyPorts|repoReadsPorts|repoOpsPorts|integrationPorts|workspacePorts|releaseReadsPorts)\.ts$/.test(file)) continue
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
  { file: 'src/main/platform/integrationPorts', module: 'src/main/platform/gitIntegration', class: 'registry', names: ['gitIntegration'], why: "the integration port's map (R7, R8)" },
  { file: 'src/main/platform/observe', module: 'src/main/git', class: 'impl', names: ['readRefsOffMain'], why: "the watcher's Git reads (refs off main's thread, git's reflog): ObservePort's Git half, kept with the common watcher (R6)" },
  { file: 'src/main/platform/observe', module: 'src/main/platform/gitIgnoredByKind', class: 'impl', names: ['gitIgnoredByKind', 'EntryKind', 'RecordedKinds'], why: "a Git folder's write record leaves out what Git ignores, each path by every kind it had (HI-3173): ObservePort's Git half, read-only check-ignore" },
  { file: 'src/main/platform/repoContext', module: 'src/shared/gitIgnoreRules', class: 'impl', names: ['IgnoreRule'], why: "RepoFiles' ignore rule type: the Files tab's rule, Git's syntax" },
  { file: 'src/main/platform/repoOps', module: 'src/shared/gitIgnoreRules', class: 'gitUi', why: "RepoOps' view types keep their Git names (§16.3.6 port 5)" },
  { file: 'src/main/platform/repoOps', module: 'src/shared/gitInit', class: 'gitUi', why: "RepoOps' view types keep their Git names (§16.3.6 port 5)" },
  { file: 'src/main/platform/repoOps', module: 'src/shared/gitRepo', class: 'gitUi', why: "RepoOps' view types keep their Git names (§16.3.6 port 5)" },
  { file: 'src/main/platform/repoOpsPorts', module: 'src/main/platform/gitRepoOps', class: 'registry', names: ['gitRepoOps'], why: "the repository operations port's map (R3)" },
  { file: 'src/main/platform/repoPorts', module: 'src/main/platform/gitRepoPorts', class: 'registry', names: ['gitRepoPorts'], why: "the repository context port's map (R1)" },
  { file: 'src/main/platform/repoPorts', module: 'src/shared/gitIgnoreRules', class: 'impl', names: ['IgnoreRule'], why: "ignoredIn's rule type (RepoFiles)" },
  { file: 'src/main/platform/repoPorts', module: 'src/main/repoLock', class: 'common', names: ['withStoreLocks'], why: "every context's store locked by the repository lock's one owner, whatever platform named it (HI-2896, s13 §2)" },
  { file: 'src/main/platform/repoReads', module: 'src/shared/gitRepo', class: 'gitUi', why: "RepoReads' view types keep their Git names (§16.3.6 port 5)" },
  { file: 'src/main/platform/repoReadsPorts', module: 'src/main/platform/gitRepoReads', class: 'registry', names: ['gitRepoReads'], why: "the repository reads port's map (R2)" },
  { file: 'src/main/platform/releaseReadsPorts', module: 'src/main/platform/gitReleaseReads', class: 'registry', names: ['gitReleaseReads'], why: "the release reads port's map (HI-3148)" },
  { file: 'src/main/platform/revisionReadsPorts', module: 'src/main/platform/gitRevisionReads', class: 'registry', names: ['gitRevisionReads'], why: "the revision reads port's map (HI-3218)" },
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
  'src/main/workflow/nextVersion': { calls: { lineRepoReads: 2, lineRepoOps: 2, queueIntegration: 1 }, why: "Start the next version: the window's repository reads and operations (R2, R3); HI-3128: the new branch's upstream remedy under follow mode" },
  'src/main/workflow/optionsForm': { calls: { lineHistory: 2 }, why: "the default target for kept targets and a changed form: reached with the project's path alone (HI-2792)" },
  'src/main/workflow/queueChecks': { calls: { lineHistory: 2 }, why: "the queue's check brackets (R6)" },
  'src/main/workflow/queueChecksApp': { calls: { slotWorkspaces: 1 }, why: "the queue's folder's submodules and LFS step: a worktree made as slots are, their platform's (HI-1182)" },
  'src/main/workflow/queueControls': { calls: { lineHistory: 8, queueIntegration: 1 }, why: "forwarding, the default target and Resume's condition: the queue's controls name no card (R8, HI-2792)" },
  'src/main/workflow/queueHost': { calls: { queueIntegration: 2 }, why: "the host's pin clean-up (R8)" },
  'src/main/workflow/queueRunner': { calls: { queueIntegration: 2 }, why: "the runner's workspace removal (R8)" },
  'src/main/workflow/reconcile': { calls: { lineHistory: 1 }, why: "a lane's own-work read (R6)" },
  'src/main/workflow/retarget': { calls: { lineHistory: 1 }, why: "the retarget preview (R6)" },
  'src/main/workflow/runLink': { calls: { lineHistory: 2 }, why: "a run's checked-out revision, before its card is known (HI-2792)" },
  'src/main/workflow/targets': { calls: { lineHistory: 3 }, why: "a lane's target and own-work reads, and empty lines dropped (R6)" },
  'src/main/workflow/keptLine': { calls: { lineHistory: 1 }, why: "HI-3112: a put-back card's line read against the target it would follow (R6)" },
  'src/main/workspaceMove': { calls: { slotWorkspaces: 4, slotRelocation: 1 }, why: "Repair's worktree steps: the pool's platform's relocation (HI-2792; §16.3.6's gate: relocation)" }
}

/**
 * A switch on a platform's id (HI-2822's rule, HI-3140's parsed scan): SPEC §16.3.6's rule 2 says a caller asks a port or
 * reads the descriptor (a capability, its integration, deliverables, repository, operations, presentation), never the
 * id. Found with TypeScript's parser, so quotes, operand order and spelling don't hide one, and prose never counts:
 * - a comparison (`===`, `!==`, `==`, `!=`, either side) with a platform id's string literal;
 * - a `case` of one;
 * - `'<id>' in x` (a platform's own shape read by its key; `none` is every union's "nothing" member, `{ none }`, so not);
 * - a platform id given to a descriptor helper (`revisionShort('jj', …)`, `hasCapability('git', …)`) or read off
 *   `PLATFORMS` by name (`PLATFORMS.jj`, `PLATFORMS['git']`).
 * `none` is also other enums' value (`review === 'none'`): a comparison or case with it is exempt only when the other
 * side's name is one NOT_PLATFORM lists, with why; any other spelling (`to`, `id`, `p`…) counts.
 */

/** The descriptors' module, whose `PlatformId` names every platform. */
const DESCRIPTORS = 'src/shared/platform/descriptors'

/** The platform ids, read from the descriptors' own type (a new one is scanned for without editing this file). */
export function platformIds(root, over = {}) {
  // Found by its folder's listing: a source path in this text would read as a script it runs (the WorkspaceService rule).
  const name = readdirSync(join(root, dirname(DESCRIPTORS))).find((e) => e.startsWith(`${basename(DESCRIPTORS)}.`))
  const file = `${dirname(DESCRIPTORS)}/${name}`
  const text = over[file] ?? readFileSync(join(root, file), 'utf8')
  return platformIdsIn(file, text)
}

/**
 * The string literals of a source's `PlatformId` union, read by TypeScript's parser (any quotes, any line breaks; HR1's
 * HI-3140 round 1). A declaration that can't be read throws: an audit that found no platform would enforce nothing.
 */
export function platformIdsIn(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const decl = sf.statements.find((st) => ts.isTypeAliasDeclaration(st) && st.name.text === 'PlatformId')
  const members = !decl ? [] : ts.isUnionTypeNode(decl.type) ? decl.type.types : [decl.type]
  const ids = members.map((t) => (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal) ? t.literal.text : null))
  if (!ids.length || ids.includes(null)) throw new Error(`${file}: its PlatformId isn't a union of string literals the audit can read`)
  return ids
}

/**
 * Field names whose `=== 'none'` is another enum's, never a platform's, each with why. Only names of a field or a
 * variable naming that enum: a generic one (`id`, `to`, `p`, `s`) is never listed, so its comparison counts. A name no
 * comparison uses any more fails as stale.
 */
export const NOT_PLATFORM = {
  review: "a workflow's review option (G3)",
  why: "an account choice's reason",
  kind: "a connection choice's or usage reading's kind",
  state: "a key matcher's or a GitHub login's state",
  route: "a notice's route",
  bannerScope: "a notice's pop-up scope",
  how: "a live mode switch's way, or a lane bar's round kind",
  response: "a hook's response kind",
  mode: "the taskbar progress bar's mode",
  cache: "a storage reading's cache state",
  skip: "a close command plan's skip reason",
  scan: "the antivirus scan's state",
  liveModeSwitch: "a provider descriptor's capability"
}

/** The descriptor helpers that take a platform's id: one given by name is a switch. */
const HELPERS = new Set(['revisionShort', 'hasCapability', 'merges', 'accepts', 'deliversCommits', 'declaresPaths', 'needsRepository', 'hasOperation', 'hasGate', 'ownsWorkspaces', 'platformName', 'ruleKeyOf'])

/** Where a switch belongs, whole: the platform layer (its descriptors and presentation, its ports and their registries) and Git's own modules. */
const SWITCH_HOME = (f) => /^src\/(shared\/platform|main\/platform)\//.test(f) || isGitModule(f)

/** An expression without what never changes its value: parentheses, `!`, `as`, `satisfies`, `<T>x`. */
function bare(n) {
  while (n && (ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isTypeAssertionExpression(n))) n = n.expression
  return n
}

/** The name an operand reads as (`a.b?.platform!` → platform), or null for any other expression. */
function nameOf(n) {
  n = bare(n)
  if (ts.isIdentifier(n)) return n.text
  if (ts.isPropertyAccessExpression(n)) return n.name.text
  return null
}

const COMPARE = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken])

/** One file's switches: each `{ id, line }`; `exempt` collects the NOT_PLATFORM names it used. */
export function fileSwitches(file, text, ids, exempt) {
  // Every file is parsed (no text prefilter: HR1's round 1 found one skipping `PLATFORMS.jj`); switchCounts keeps each
  // file's answer by its text.
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const idOf = (n0) => {
    const n = bare(n0)
    return n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && ids.includes(n.text) ? n.text : null
  }
  const out = []
  const add = (id, n) => out.push({ id, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 })
  const versus = (id, other, n) => {
    const name = nameOf(other) ?? ''
    if (id === 'none' && Object.hasOwn(NOT_PLATFORM, name)) return void exempt?.add(name)
    add(id, n)
  }
  const visit = (n) => {
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind
      if (COMPARE.has(op)) {
        const l = idOf(n.left)
        const r = idOf(n.right)
        if (l) versus(l, n.right, n)
        else if (r) versus(r, n.left, n)
      } else if (op === ts.SyntaxKind.InKeyword && idOf(n.left) && idOf(n.left) !== 'none') add(idOf(n.left), n)
    } else if (ts.isCaseClause(n) && idOf(n.expression)) {
      versus(idOf(n.expression), n.parent.parent.expression, n)
    } else if (ts.isCallExpression(n) && HELPERS.has(nameOf(n.expression) ?? '')) {
      for (const a of n.arguments) if (idOf(a)) add(idOf(a), n)
    } else if (ts.isElementAccessExpression(n) && nameOf(n.expression) === 'PLATFORMS' && idOf(n.argumentExpression)) {
      add(idOf(n.argumentExpression), n)
    } else if (ts.isPropertyAccessExpression(n) && nameOf(n.expression) === 'PLATFORMS' && ids.includes(n.name.text)) {
      add(n.name.text, n)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

/** switchCounts' answers per file, by its text. */
const switchesParsed = new Map()

/**
 * Each file's count of switches on a platform's id outside their home. `used` collects the NOT_PLATFORM names the files
 * used.
 */
export function switchCounts(root, over = {}, used = new Set()) {
  const ids = platformIds(root, over)
  const out = {}
  for (const { file, text } of filesOf(root, over)) {
    const f = file.replace(/\.tsx?$/, '')
    if (SWITCH_HOME(f)) continue
    // Each file's answer kept by its text and the ids (a test's runs reparse only the file it changes).
    const key = `${root}|${file}|${ids.join(',')}`
    let kept = switchesParsed.get(key)
    if (kept?.text !== text) {
      const exempt = new Set()
      kept = { text, found: fileSwitches(file, text, ids, exempt), exempt }
      switchesParsed.set(key, kept)
    }
    for (const n of kept.exempt) used.add(n)
    if (kept.found.length) out[f] = kept.found.length
  }
  return out
}

/**
 * The switches left outside their home, per file, each justified (HI-2822): Git-facing text that names Git, and Git's own
 * data read by a one-time step. Counted like the seams: a new switch, or one gone, fails tests/gitAudit.test.ts.
 */
export const SWITCHES = {
  'src/main/combworkMove': { n: 2, class: 'historic', why: "1.1's .hive → .combwork move fixes git's exclude lines in a Git repository (HI-2462): its boundary read as Git's" }, // old-name: the 1.1 folder move's input, named as it was
  'src/main/nameUpgradeProjects': { n: 2, class: 'historic', why: "1.1's name upgrade moves a Git repository's refs and exclude line (HI-2594): its boundary read as Git's" },
  'src/main/ipc': { n: 1, class: 'gitUi', why: "the Files tab's Git menu reads only a Git repository's boundary (git:…)" },
  'src/main/workflow/platformSwitch': { n: 1, class: 'gitUi', why: "the switch to None warns that the folder is still a Git repository (gitFolder, git.vc.switch.gitFolder): Git-facing text" },
  'src/main/workflow/commitMessageStep': { n: 2, class: 'historic', why: "HI-1997's one-time step over G19's stored Git options (in force, or kept as `kept.git`): Git's data alone" },
  'src/renderer/src/components/AgentTiles': { n: 1, class: 'data', why: "a CSS grid column token (`none`): not a platform" },
  'src/renderer/src/components/WorkflowOptions': { n: 1, class: 'data', why: "the review option's value `none` (G3), said in None's words where the platform accepts work: not a platform" },
  'src/renderer/src/views/VersionControl': { n: 1, class: 'gitUi', why: "the Version Control tab compares git's own read of the folder (its status summary) with detection finding Git: Git's page" },
  'src/renderer/src/views/VersionControlHeader': { n: 1, class: 'gitUi', why: "Initialise repository… switches the project to Git by name once Git's page made it one (switchAfterInit): Git's page" }
}


/** The descriptor fields that declare a platform's integration modes (HI-2840): its finishes and its default one. */
export const MODE_FIELDS = ['finishes', 'defaultFinish']

/** The module whose `Finisher` union names every integration mode. */
const FINISHERS = 'src/shared/workflow/options'

/** The modes, read from `Finisher`'s union by TypeScript's parser (a new one is looked for without editing this file). */
function finisherValues(root, over) {
  // Found by its folder's listing, as platformIds finds the descriptors (a source path in this text reads as a script).
  const file = `${dirname(FINISHERS)}/${readdirSync(join(root, dirname(FINISHERS))).find((e) => e.startsWith(`${basename(FINISHERS)}.`))}`
  const sf = ts.createSourceFile(file, over[file] ?? readFileSync(join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const decl = sf.statements.find((st) => ts.isTypeAliasDeclaration(st) && st.name.text === 'Finisher')
  const members = !decl ? [] : ts.isUnionTypeNode(decl.type) ? decl.type.types : [decl.type]
  const out = members.map((t) => (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal) ? t.literal.text : null))
  if (!out.length || out.includes(null)) throw new Error(`${file}: its Finisher isn't a union of string literals the audit can read`)
  return out
}

/**
 * HI-2840 (the integration modes are a generic capability the platform declares): each place
 * outside the descriptors that declares a platform's modes, as `<file>:<line> <field>`: a property of that name (an
 * object's field, a class's) given a mode or a list holding one. That would be a second list the form, the
 * contradictions or the workflow could follow instead of the descriptor's; reading `PLATFORMS[p].finishes` is how they
 * ask. Other things named so (a count of finishes told, a batcher) hold no mode, so never count.
 */
export function modeDeclarations(root, over = {}) {
  const modes = finisherValues(root, over)
  const isMode = (n) => !!n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && modes.includes(n.text)
  const holdsMode = (n) => {
    while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n))) n = n.expression
    return !!n && (isMode(n) || (ts.isArrayLiteralExpression(n) && n.elements.some(isMode)))
  }
  const out = []
  for (const { file, text } of filesOf(root, over)) {
    if (file.replace(/\.tsx?$/, '') === DESCRIPTORS || !MODE_FIELDS.some((f) => text.includes(f))) continue
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const visit = (n) => {
      const value = ts.isPropertyAssignment(n) || ts.isPropertyDeclaration(n) ? n.initializer : null
      const name = value && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) ? n.name.text : null
      if (name && MODE_FIELDS.includes(name) && holdsMode(value)) out.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${name}`)
      ts.forEachChild(n, visit)
    }
    visit(sf)
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
  const used = new Set()
  const switched = switchCounts(root, over, used)
  const switches = [...new Set([...Object.keys(switched), ...Object.keys(SWITCHES)])].sort().filter((f) => (switched[f] ?? 0) !== (SWITCHES[f]?.n ?? 0)).map((f) => `${f}: ${switched[f] ?? 0} switches on a platform's id, listed ${SWITCHES[f]?.n ?? 0}`)
  // HI-3140: an exemption nothing uses any more is stale: a NOT_PLATFORM name no comparison has.
  switches.push(...Object.keys(NOT_PLATFORM).filter((n) => !used.has(n)).map((n) => `NOT_PLATFORM ${n}: no comparison uses it (stale)`))
  return { found, unlisted, stale, extraNames, seams, switches }
}
