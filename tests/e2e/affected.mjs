// Which e2e suites a change needs (npm run e2e -- --affected [base]): for review rounds that fixed a few things, rather
// than the whole set. A tool, not a merge's gate: merges run focused checks (#1010, tests/e2e/README.md). Errs towards more, never fewer: the files every
// part of Combwork goes through, the test tooling, and any file that isn't in an area or known to need no suite (DOCS_ONLY,
// the unit tests'), mean every suite. The full set itself runs at checkpoints (each RC and release, on request:
// tests/e2e/README.md). Suites that start a real CLI (the real tier) are picked only when a change touches what they
// cover (an area naming them, or REAL_TIER), which is when a merge also needs the real tier. tests/e2esuites.test.ts
// checks that every suite is in an area, every source file is covered, and what no area names falls back to every suite.
// Some EVERYTHING files are selected by the parts of them a change touches instead (HI-2659): SPLIT in affectedUnits.mjs,
// whose selection --affected and the picker work out from the diff (splitSelections) and pass to affectedSuites as
// `units`; without it, or when it can't follow a change (affectedUnits.mjs says when), they select every suite.
//
// `node tests/e2e/affected.mjs --pick` is this repository's focused-test picker (HI-1367, the merge queue's "each
// card's focused tests"): see pickTests and UNIT_SCANS below. Imported (run.mjs, the unit tests), it does nothing.
import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { createRequire } from 'module'
import { SCOPE_FILES as PRESENCE_SCOPE } from '../presenceChecks.mjs'
import { gitChangedLines, gitRevision, splitOf, typeOnlyChange, unitSelection } from './affectedUnits.mjs'
import { narrowRelatedInTree } from './relatedTests.mjs'
import { join, resolve } from 'path'
import { pathToFileURL } from 'url'

const runContext = createRequire(import.meta.url)('./runContext.cjs')

/**
 * Changes to these touch everything (the IPC contract, types, the store, the shell, the test harness): every suite. The
 * SPLIT ones (affectedUnits.mjs: ipc.ts, shared/api.ts, actions.ts, commands.ts, workspace.ts, runner.mjs) only when
 * their changed parts can't be followed. A file leaves this list for SPLIT, a card at a time, once its parts have callers
 * a name search can find.
 */
export const EVERYTHING = [
  'src/main/index.ts',
  'src/main/ipc.ts',
  'src/main/config.ts',
  'src/main/events.ts',
  'src/main/windows.ts',
  'src/main/workspace.ts',
  'src/main/sessions.ts',
  // The Agent API (HI-2690 measured why it isn't split by route): 109 files hold a request, most through a helper whose
  // path is `BASE + path` (lib.cjs's, every suite's own), which no selection can follow to the routes it reaches.
  'src/main/servers.ts',
  // Every Agent API route is matched through it (HI-2258).
  'src/main/routePattern.ts',
  'src/main/fsutil.ts',
  // Every workspace's open and close marks it, and every database's open is fenced by that (#1379).
  'src/main/openingFence.ts',
  'src/main/paths.ts',
  'src/main/logger.ts',
  // Its thread writes every line combwork.log and hooks.log get (HI-1730).
  'src/main/logWriter.ts',
  // Every IPC call, database step and slow log write is marked through it (HI-1692).
  'src/main/stallWork.ts',
  'src/main/ptyHost.ts',
  'src/main/testQuiet.ts',
  // Every IPC call's errors and the Agent API's go through it (#845).
  'src/main/combworkError.ts',
  // The Agent API's status of plain errors that aren't messages (HI-2704), beside it.
  'src/shared/kindedError.ts',
  // The language (#767): chosen before every window starts, and every translated text goes through it.
  'src/main/i18n.ts',
  'src/renderer/src/i18n.ts',
  'src/shared/i18n/',
  'src/main/raw.d.ts',
  'src/preload/',
  'src/renderer/index.html',
  'src/renderer/src/main.tsx',
  // React's commit watch, in every test copy's window before React DOM (HI-1387).
  'src/renderer/src/commitWatch.ts',
  'src/renderer/src/commitLoop.tsx',
  'src/shared/commitWatch.ts',
  'src/renderer/src/App.tsx',
  'src/renderer/src/store.ts',
  // The store's every update of the workspace and the board (HI-1806).
  'src/shared/keepSame.ts',
  'src/renderer/src/actions.ts',
  'src/renderer/src/api.ts',
  'src/renderer/src/util.ts',
  'src/renderer/src/commands.ts',
  'src/renderer/src/components/ui.tsx',
  'src/renderer/src/components/Shell.tsx',
  'src/renderer/src/components/ErrorBoundary.tsx',
  'src/renderer/src/styles/app.css',
  'src/shared/api.ts',
  'src/shared/types.ts',
  'src/shared/defaults.ts',
  'src/shared/dates.ts',
  'src/shared/units.ts',
  'src/shared/providers.ts',
  // Coalesces reads for sessions.ts and the renderer's api.ts (#1629, #1646), both above.
  'src/shared/coalesce.ts',
  'src/main/providers/',
  'tests/e2e/lib.cjs',
  'tests/e2e/run.mjs',
  'tests/e2e/fake-claude/',
  'tests/e2e/fake-bridge.cjs',
  'tests/e2e/suites.mjs',
  'tests/e2e/affected.mjs',
  'tests/e2e/affectedUnits.mjs',
  'tests/e2e/relatedTests.mjs',
  'tests/e2e/record.mjs',
  'tests/e2e/runner.mjs',
  'tests/e2e/build.mjs',
  'tests/e2e/logs.mjs',
  'tests/e2e/lanes.mjs',
  'tests/e2e/runContext.cjs',
  'tests/e2e/slots.mjs',
  'tests/e2e/codexHomeLock.mjs',
  'tests/e2e/testHomeLock.mjs',
  'tests/e2e/testHomes.mjs',
  'tests/e2e/testHomeManifest.mjs',
  'tests/e2e/clean.mjs',
  'tests/e2e/evidence.cjs',
  'tests/e2e/boardRows.cjs',
  'tests/e2e/windowsExits.cjs',
  'tests/e2e/recycleBin.mjs',
  // The concurrency checker and the scenario harness: shared test tooling (#628), checked with the full set.
  'tests/e2e/concurrency.mjs',
  'tests/e2e/tempWorktrees.mjs',
  'tests/scenarios/harness.cjs',
  'tests/scenarios/run.mjs',
  'tests/progressReport.mts',
  // The runs' temp folders (HI-2102): the unit tests' (through tests/tempDir.ts) and the e2e and scenario runners'.
  'tests/runTemp.mts',
  'package.json',
  'package-lock.json',
  'electron.vite.config.ts',
  'electron-builder.yml'
]

/**
 * Areas: source paths (a file, or a folder ending in /) and the suites that exercise them. A path may be in several.
 * A suite's own file (tests/e2e/<suite>.cjs) always selects it.
 */
export const AREAS = [
  { paths: ['tests/e2e/codexDiagnostics.cjs'], suites: ['codex-background'] },
  { paths: ['src/main/agentProcesses.ts', 'src/main/processSupervisor.ts', 'src/main/launchGate.ts', 'src/main/ptyHost.ts', 'src/shared/agentProcesses.ts', 'src/main/sessions.ts', 'tests/e2e/fake-claude/linger.cjs'], suites: ['leftovers', 'leftovers-restart', 'unexpectedclose-leftovers'] },
  { paths: ['tests/scenarios/harness.cjs', 'tests/e2e/folderProcesses.cjs', 'tests/e2e/fake-claude/linger.cjs', 'src/main/progressReporters/'], suites: ['scenarioteardown'] },
  { paths: ['tests/e2e/folderProcesses.cjs', 'tests/e2e/leftCopies.mjs', 'tests/e2e/lanes.mjs'], suites: ['harnessleftovers'] },
  // HI-2379: a shared folder's attribution of a burst of merged commits, and main's stall while it runs.
  { paths: ['src/main/workflow/reconcile.ts', 'src/main/workflow/reconciler.ts', 'src/main/platform/observe.ts'], suites: ['mergeburst'] },
  // The real CLIs' background processes (#515): only when what tracks them changes, not with every sessions.ts change.
  { paths: ['src/main/agentProcesses.ts', 'src/main/processSupervisor.ts', 'src/main/launchGate.ts'], suites: ['leftovers-claude', 'leftovers-codex'] },
  // The Agent API for apps that show Combwork (#620): viewer tokens, the discovery file, the event stream's events.
  { paths: ['src/main/apiEvents.ts', 'src/shared/assistantActivity.ts', 'src/main/activityTargets.ts', 'src/main/apiDiscovery.ts', 'src/main/viewerTokens.ts', 'src/main/notices.ts', 'src/main/progressService.ts', 'src/main/mergeSlots.ts'], suites: ['viewer'] },
  // The developer console (#636): capture, its rings and redaction, the agents' reads and the Combwork tool's replies.
  { paths: ['src/main/devConsole.ts', 'src/main/devConsoleSources.ts', 'src/main/devConsoleWords.ts', 'src/shared/devConsole.ts', 'tests/e2e/devconsole.cjs', 'src/main/mergeSlotHost.ts', 'src/main/watches.ts', 'src/main/sessions.ts', 'src/main/servers.ts'], suites: ['devconsole', 'replysize'] },
  { paths: ['src/main/consoleWindow.ts', 'src/renderer/src/ConsoleApp.tsx', 'src/renderer/src/styles/console.css', 'src/renderer/src/main.tsx', 'src/shared/consoleView.ts', 'src/shared/devConsole.ts', 'src/main/devConsole.ts', 'src/main/devConsoleSources.ts', 'src/renderer/src/components/TitleBar.tsx', 'tests/e2e/consolewindow.cjs'], suites: ['consolewindow'] },
  { paths: ['src/main/consoleRecorder.ts', 'src/shared/consoleFixtures.mts', 'src/shared/devConsole.ts', 'src/main/devConsole.ts', 'src/main/providers/copilot/adapter.ts', 'src/main/providers/copilot/events.ts', 'src/main/screenRecognition.ts', 'tests/fixtures/console/copilot.json', 'scripts/consoleFixture.mjs', 'tests/e2e/contract-copilot.cjs'], suites: ['contract-copilot', 'devconsole'] },
  { paths: ['src/main/consoleRecorder.ts', 'src/main/diagnostics.ts'], suites: ['consolewindow'] },
  // Developer console: show text (#699): the advanced setting, what main sends the window, the banner.
  { paths: ['src/main/consoleWindow.ts', 'src/renderer/src/ConsoleApp.tsx', 'src/renderer/src/styles/console.css', 'src/shared/devConsole.ts', 'src/main/devConsole.ts', 'src/main/ipc.ts', 'src/shared/advanced.ts', 'src/main/advanced.ts', 'src/shared/redact.ts', 'tests/e2e/consoletext.cjs'], suites: ['consoletext'] },
  // The developer console's flight recorder (#698): its triggers, captures and notices.
  { paths: ['src/main/flightRecorder.ts', 'src/shared/flightRecorder.ts', 'src/main/consoleRecorder.ts', 'tests/e2e/flightrecorder.cjs'], suites: ['flightrecorder'] },
  // Advanced settings (#367): the list, advanced.json, the workspace's own values, and what uses them (the combwork MCP server's waits).
  { paths: ['src/main/advanced.ts', 'src/shared/advanced.ts', 'src/renderer/src/advanced.ts', 'src/renderer/src/components/AdvancedSettings.tsx', 'src/main/diagnostics.ts', 'src/shared/settingsCatalog.ts', 'tests/fixtures/advanced/', 'tests/e2e/advanced.cjs'], suites: ['advanced'] },
  { paths: ['src/main/advanced.ts'], suites: ['replysize', 'assistantsettings'] },
  // The Combwork tools' description limits (HI-2012): replysize checks them.
  { paths: ['tests/e2e/toolLimits.cjs'], suites: ['replysize'] },
  { paths: ['tests/e2e/toolsides.cjs', 'src/shared/assistantTools.ts', 'src/main/mcp/cw-mcp.ts', 'src/main/sessions.ts', 'src/shared/workflow/roles.ts', 'src/main/launchSides.ts', 'src/main/workflowTools.ts', 'src/renderer/src/components/AgentDialogs.tsx'], suites: ['toolsides', 'replysize'] },
  { paths: ['src/main/providers/opencode/', 'src/shared/opencode.ts', 'src/main/opencodeHistoryHost.ts', 'src/main/opencodeHistoryWorker.ts', 'tests/e2e/fake-opencode/'], suites: ['opencode', 'opencode-assistant', 'opencode-history', 'opencode-isolation', 'opencode-launch', 'opencode-providers', 'opencode-status', 'opencode-tools', 'opencodereal', 'opencodereal-dirs'] },
  { paths: ['src/main/providers/antigravity/', 'src/main/statusLineState.ts', 'src/shared/antigravity.ts', 'tests/e2e/fake-agy/'], suites: ['antigravity', 'antigravity-windows', 'antigravityreal'] },
  { paths: ['src/main/assistantMemory.ts', 'src/shared/assistantMemory.ts', 'src/renderer/src/components/AssistantMemory.tsx', 'src/renderer/src/components/AssistantView.tsx'], suites: ['assistantmemory', 'assistantimages'] },
  { paths: ['src/main/journal.ts', 'src/main/journalService.ts', 'src/main/walCheckpoint.ts', 'src/main/walCheckpointWorker.ts','src/shared/journal.ts', 'src/renderer/src/components/JournalSettings.tsx', 'tests/e2e/journal.cjs'], suites: ['journal', 'replysize'] },
  { paths: ['src/main/startView.ts', 'src/shared/startView.ts'], suites: ['journal', 'assistantcompact', 'assistantresume'] },
  // Builds recorded as facts (#1534): the scripts' side, Combwork's route and markers, the Advanced switch.
  { paths: ['scripts/buildFact.mjs', 'src/main/buildFacts.ts', 'src/shared/buildFacts.ts', 'src/renderer/src/components/journalBuilds.ts', 'src/main/journalService.ts', 'src/shared/advanced.ts', 'tests/e2e/buildfacts.cjs'], suites: ['buildfacts'] },
  // The journal browser (#1033): the store's browse and forget, its IPC, the Assistant view's Journal.
  { paths: ['src/main/journal.ts', 'src/main/journalService.ts', 'src/shared/journal.ts', 'src/renderer/src/components/JournalView.tsx', 'src/renderer/src/components/journalBuilds.ts', 'src/renderer/src/components/AssistantView.tsx', 'tests/e2e/journalbrowse.cjs'], suites: ['journalbrowse'] },
  // Disable hardware acceleration (#676): the early read, the restart offer, the terminals' renderer, diagnostics.
  { paths: ['src/main/gpu.ts', 'src/shared/advanced.ts', 'src/main/advanced.ts', 'src/renderer/src/components/AdvancedSettings.tsx', 'src/renderer/src/components/TerminalView.tsx', 'src/main/diagnostics.ts', 'tests/e2e/hwaccel.cjs'], suites: ['hwaccel'] },
  { paths: ['src/main/agentTokens.ts'], suites: ['boardscope', 'review', 'progress', 'progressreport', 'cardloop', 'replysize', 'combworktools'] },
  { paths: ['src/main/assistantControl.ts', 'src/main/assistantChanges.ts', 'src/main/assistantUndo.ts', 'src/shared/assistantActivity.ts', 'src/main/activityTargets.ts', 'src/main/taskBatch.ts', 'src/shared/assistant.ts', 'src/shared/assistantStatus.ts', 'src/shared/assistantTools.ts', 'src/main/modes.ts', 'src/renderer/src/components/Assistant.tsx', 'src/renderer/src/components/AssistantChanges.tsx', 'src/renderer/src/assistantUndo.ts', 'src/shared/assistantChangeList.ts', 'src/renderer/src/components/AssistantMark.tsx', 'src/renderer/src/components/AssistantView.tsx', 'src/renderer/src/components/Modes.tsx', 'src/shared/modeDescriptions.ts'], suites: ['assistantside', 'assistant', 'assistant-control', 'assistantend', 'assistantimages', 'tipcorner', 'replysize', 'claude-real', 'assistantoverview', 'assistantbatch', 'assistantcompact', 'assistantsettings', 'assistantmode', 'cardchip', 'assistantpanel', 'assistantundo'] },
  { paths: ['src/main/installDir.ts'], suites: ['installdir'] },
  { paths: ['src/main/benchmarks.ts', 'src/shared/benchmark.ts', 'src/renderer/src/views/PerformanceCompare.tsx'], suites: ['perfcompare'] },
  // Cost per card and per lane (#602): the holds, the minutes the parsers give, the card's line, the lane's hover, Performance's Cards.
  { paths: ['src/main/cardCosts.ts', 'src/shared/cardCosts.ts', 'src/shared/usageTimeline.ts', 'src/renderer/src/components/CardCost.tsx', 'src/renderer/src/views/PerformanceCards.tsx', 'src/main/providers/claude/usage.ts', 'src/main/providers/codex/rollout.ts', 'src/main/providers/copilot/events.ts'], suites: ['cardcost', 'unpricedcost', 'overview'] },
  { paths: ['src/main/metrics.ts', 'src/main/metricsUsage.ts', 'src/shared/metrics.ts', 'src/shared/metricsView.ts', 'src/renderer/src/views/Performance.tsx', 'src/renderer/src/views/perfReasons.ts'], suites: ['performance', 'perfcompare', 'bridgereport', 'perftable', 'cardcost'] },
  // A launch's side of the workflow for its metrics (HI-2049): replysize checks each real launch's guidance and tool list carry it.
  { paths: ['src/main/launchSides.ts', 'src/shared/workflow/roles.ts'], suites: ['replysize'] },
  // The Combwork tool list's parts as the bridge measures them (HI-2063): replysize checks a real launch's, bridgereport the bridge's reports.
  { paths: ['src/shared/toolListSize.ts'], suites: ['replysize', 'bridgereport'] },
  { paths: ['src/main/branchWatch.ts', 'src/main/git.ts', 'src/main/worktrees.ts', 'src/main/platform/repoReads.ts', 'src/main/platform/gitRepoReads.ts', 'src/main/platform/repoReadsPorts.ts'], suites: ['unmerged', 'agents', 'changes', 'paneheader', 'claude-real', 'wsmove', 'wtrecreate', 'removeall', 'gitmissing', 'unusedwt', 'changespicker', 'gitview'] },
  // git.ts's processes, started off main's thread (HI-1783): git.ts's suites.
  { paths: ['src/main/gitWorker.ts'], suites: ['gitdirect', 'unmerged', 'agents', 'changes', 'paneheader', 'claude-real', 'wsmove', 'wtrecreate', 'removeall', 'gitmissing', 'unusedwt', 'changespicker', 'gitview'] },
  // Git missing or too old (#346): Provider Setup's Git row, the status bar and every git-dependent screen.
  { paths: ['src/main/gitTool.ts', 'src/shared/gitTool.ts', 'src/shared/gitLayout.ts'], suites: ['gitdirect', 'gitmissing', 'providers'] },
  // The Git view (#607): the Git tab's sections and the status bar's item.
  { paths: ['src/main/gitRepo.ts', 'src/shared/gitRepo.ts', 'src/shared/branchCleanup.ts', 'src/renderer/src/views/GitTab.tsx', 'src/renderer/src/views/GitBranches.tsx', 'src/renderer/src/gitReads.ts', 'src/main/platform/repoReads.ts', 'src/main/platform/gitRepoReads.ts', 'src/main/platform/repoReadsPorts.ts', 'src/main/platform/repoOps.ts', 'src/main/platform/gitRepoOps.ts', 'src/main/platform/repoOpsPorts.ts', 'src/main/repoOpsIpc.ts', 'src/shared/repoOpChannels.ts', 'src/renderer/src/repoOps.ts', 'src/renderer/src/repoOffers.ts'], suites: ['gitbranchcards', 'gitcleanup', 'gitupdate', 'gitview', 'gitremotes', 'changes', 'changespicker', 'gitmissing', 'unusedwt', 'inbox', 'gitinit', 'versioncontrol', 'mergedialogslots'] },
  // HI-2807: New branch… from a ref, a missing target's offer, Start the next version (gitview drives all three).
  { paths: ['src/renderer/src/components/NewBranchForm.tsx', 'src/renderer/src/components/NextVersion.tsx', 'src/main/workflow/nextVersion.ts', 'src/shared/nextVersion.ts'], suites: ['gitview', 'workflowoptions', 'retarget'] },
  // The shared tab strip (HI-1837, HI-1839) and every suite driving one: Version Control's sections, Settings' workflow
  // defaults, Advanced's per CLI, Keyboard Shortcuts' categories, the Attachments tab's pane and card tabs.
  { paths: ['src/renderer/src/components/Tabs.tsx', 'src/shared/tabs.ts'], suites: ['versioncontrol', 'vcswitch', 'gitview', 'agentslots', 'gitbranchcards', 'lanesslots', 'lanestages', 'mergedialogslots', 'slotrelease', 'unusedslots', 'p6lane', 'workflowdefaults', 'workflowoptions', 'advanced', 'keys', 'cardattach', 'image', 'i18nshots'] },
  // Where a Version Control or workflow default came from (HI-1837).
  { paths: ['src/renderer/src/components/OriginText.tsx'], suites: ['versioncontrol', 'workflowdefaults', 'workflowoptions'] },
  { paths: ['src/renderer/src/views/VersionControl.tsx', 'src/renderer/src/views/VersionControlHeader.tsx'], suites: ['versioncontrol', 'vcswitch', 'gitview', 'gitinit', 'changes', 'queuecard', 'workflowoptions', 'jjview'] },
  // jj in the Version Control tab and the switch (HI-2799).
  { paths: ['src/renderer/src/views/JjSections.tsx', 'src/renderer/src/views/StoreSwitchDetails.tsx', 'src/shared/jjViews.ts', 'src/shared/platform/gateTexts.ts', 'src/main/platform/jjViews.ts', 'src/main/platform/jjCompat.ts', 'src/main/platform/jjPlatform.ts', 'src/main/platform/platformFence.ts', 'src/main/platform/fenceAdmit.ts', 'src/main/workflow/storeSwitch.ts', 'src/main/platform/jjOperations.ts', 'src/main/platform/jjOpView.ts', 'src/main/platform/jjSourcesPrint.ts'], suites: ['jjview', 'vcswitch'] },
  // "How do you work?" (#1423): the step, its notice, the answer and the adoption on a board made by 1.0.
  { paths: ['src/renderer/src/components/PresetStep.tsx', 'src/shared/workflow/presetStep.ts', 'src/main/workflow/presetStep.ts', 'src/main/workflow/adoption.ts'], suites: ['presetstep', 'vcswitch', 'workflowoptions'] },
  // Switching the version control (#1419): the switch, detection's offers, the shared rules.
  { paths: ['src/main/workflow/platformSwitch.ts', 'src/main/platform/registry.ts', 'src/shared/platform/switching.ts', 'src/shared/workflow/projectWorkflow.ts'], suites: ['vcswitch', 'versioncontrol', 'workflowoptions', 'jjview'] },
  { paths: ['src/main/gitInit.ts', 'src/shared/gitInit.ts', 'src/renderer/src/components/InitRepo.tsx'], suites: ['gitinit', 'gitview'] },
  { paths: ['src/main/freshPath.ts', 'src/main/externalTerminal.ts'], suites: ['freshpath', 'gitmissing', 'providers'] },
  // The providers' version checks' GET (#1582): the test copies turn the checks off, so these drive its callers only.
  { paths: ['src/main/plainHttpsJson.ts'], suites: ['providers', 'providerdetect', 'setupcopy', 'setuplayout'] },
  { paths: ['src/main/testedClis.ts', 'src/shared/testedClis.ts', 'resources/tested-clis.json', 'scripts/testedClis.mjs', 'scripts/tested-clis.mjs', 'scripts/release.mjs'], suites: ['testedclis'] },
  // Unused worktrees (#353): the Overview's section, the Changes notice, Storage's line and the hints.
  { paths: ['src/main/unusedWorktrees.ts', 'src/shared/unusedWorktrees.ts', 'src/shared/recentCache.ts', 'src/renderer/src/components/UnusedWorktrees.tsx'], suites: ['unusedwt', 'unusedslots', 'changespicker'] },
  { paths: ['tests/e2e/unusedslots.cjs'], suites: ['unusedslots'] },
  { paths: ['src/main/branchMerge.ts', 'src/renderer/src/components/BranchMerge.tsx', 'tests/e2e/mergedialogslots.cjs', 'src/main/platform/gitRepoOps.ts', 'src/main/platform/repoOpsPorts.ts', 'src/main/repoOpsIpc.ts', 'src/main/platform/repoReads.ts', 'src/main/platform/gitRepoReads.ts', 'src/main/platform/repoReadsPorts.ts'], suites: ['mergedialogslots'] },
  { paths: ['src/renderer/src/mergeChoice.ts'], suites: ['mergedialogslots', 'agents-ui'] },
  { paths: ['src/main/combworkMove.ts', 'src/main/combworkFolder.ts', 'src/main/combworkMoveWorker.ts', 'src/main/boardFileMove.ts', 'src/main/nameUpgrade.ts', 'src/main/nameUpgradeFiles.ts', 'src/main/nameUpgradeProjects.ts', 'src/main/nameUpgradeValues.ts', 'src/main/storedNames.ts', 'src/main/fsPresence.ts', 'src/shared/combworkFolderMove.ts', 'tests/e2e/combworkfolder.cjs'], suites: ['combworkfolder', 'combworkvcs', 'wsmove'] },
  { paths: ['src/main/workspaceMove.ts', 'src/main/viewPrefs.ts', 'src/shared/movePaths.ts', 'src/renderer/src/components/MoveRepair.tsx', 'src/main/agentWorktree.ts', 'src/shared/projectIds.ts', 'src/main/beforeIds.ts', 'src/main/leftovers.ts', 'src/main/projectRename.ts', 'src/main/projectNames.ts'], suites: ['wsmove', 'wtrecreate', 'projectrename', 'repairbranches', 'repairdefender'] },
  { paths: ['src/main/bundled.ts', 'src/main/bundledHistory.json', 'src/main/skills.ts', 'src/main/revisions.ts', 'src/renderer/src/components/Skills.tsx', 'src/shared/skillDescriptions.ts', 'src/shared/skillLinks.ts'], suites: ['skills', 'skillaudience', 'skilldelivery'] },
  { paths: ['src/main/guidance.ts', 'src/shared/combworkGuidance.ts', 'src/shared/toolReplies.ts', 'src/shared/combworkToolLoad.ts', 'src/main/mcp/'], suites: ['skilldelivery', 'replysize', 'mcp', 'bridgereport', 'cardloop', 'slotguidance'] },
  // Agent text (HI-2065): the module every agent message is said through, and its extracted catalogue and schema; the
  // canary runs through the built cw-mcp.js in agentguidance.
  { paths: ['src/shared/agentText/', 'agent-text/catalogue/', 'agent-text/schema/', 'src/main/apiText.ts', 'src/main/sessionText.ts'], suites: ['agentguidance', 'replysize', 'mcp', 'skilldelivery', 'bridgereport'] },
  // HI-2245: a builder's card watch and cw_lane next saying its card in Review has unsubmitted commits.
  { paths: ['src/main/unsubmitted.ts', 'src/shared/unsubmitted.ts'], suites: ['replysize', 'cardloop'] },
  // HI-2285: a lane's builder watching its own card while nothing waits on it: its watch's reply, and the stall.
  { paths: ['src/main/idleWatch.ts', 'src/shared/idleWatch.ts'], suites: ['replysize', 'cardloop', 'lanewatch'] },
  // Combwork's skill copies per folder and the skills delivered (#1431).
  { paths: ['src/main/skillCopies.ts', 'src/shared/skillDelivery.ts', 'src/main/providers/common.ts'], suites: ['skilldelivery', 'skills'] },
  // A .cmd/.bat launcher through cmd.exe (HI-2722): its command line, as tasks, sign-ins and agents start it.
  { paths: ['src/main/providers/common.ts', 'src/main/launchGate.ts', 'src/main/ptyHost.ts'], suites: ['cmdlauncher'] },
  { paths: ['src/main/workspaceNotes.ts', 'src/shared/workspaceNotes.ts', 'src/renderer/src/components/WorkspaceNotes.tsx', 'src/main/providers/claude/adapter.ts', 'src/main/providers/codex/adapter.ts', 'src/main/providers/copilot/adapter.ts'], suites: ['workspacenotes'] },
  { paths: ['src/main/cardSessions.ts', 'src/renderer/src/components/CardChip.tsx'], suites: ['cardchip', 'sessionorigin'] },
  { paths: ['src/main/cardAttachments.ts', 'src/shared/cardAttachments.ts', 'src/renderer/src/components/CardAttachments.tsx', 'src/renderer/src/cardAttachLinks.ts', 'src/main/attachmentsFolder.ts', 'src/main/cardAttachmentCleanup.ts', 'src/main/cardCleanupFs.ts', 'src/shared/cardCleanup.ts', 'tests/e2e/cardattach.cjs'], suites: ['cardattach', 'storage', 'files', 'carddialog', 'attachread'] },
  // A card's attachment read through Combwork (HI-1751).
  { paths: ['tests/e2e/attachread.cjs'], suites: ['attachread'] },
  // Accounts (HI-980): the store, its checks and watches, Settings → Accounts, and the fake's sign-in.
  { paths: ['src/main/accounts.ts', 'src/shared/accounts.ts', 'src/renderer/src/components/AccountsSettings.tsx', 'src/renderer/src/components/accountCard.ts', 'tests/e2e/accounts.cjs'], suites: ['accounts', 'connections', 'connections-codex', 'connections-server', 'usagemove'] },
  // Server connections (HI-1772): the key store and its masking, the server's form, models and launch variables.
  { paths: ['src/shared/localModelLimits.ts', 'src/main/providers/claude/localLimits.ts', 'src/main/localLimitsTest.ts'], suites: ['connections-server', 'serverdiag'] },
  { paths: ['src/main/serverConnections.ts', 'src/main/serverMarks.ts', 'src/main/keyStore.ts', 'src/main/keyMatcher.ts', 'src/main/keyCoverage.ts', 'src/shared/serverConnection.ts', 'src/renderer/src/components/ServerConnections.tsx', 'tests/e2e/connections-server.cjs'], suites: ['connections-server'] },
  // Server diagnostics (HI-2683): its service, judgements, dialog and the plain request it sends.
  { paths: ['src/main/serverDiagnostics.ts', 'src/shared/serverDiagnostics.ts', 'src/renderer/src/components/ServerDiagnostics.tsx', 'tests/e2e/serverdiag.cjs'], suites: ['serverdiag'] },
  // Launching on a connection (HI-1755): the launch step, the switch at a safe point, the seam, the Connection choice.
  { paths: ['src/main/connectionSeam.ts', 'src/main/connectionSwitch.ts', 'src/renderer/src/components/ConnectionChoice.tsx', 'tests/e2e/connections.cjs'], suites: ['connections', 'connectionrows', 'connections-codex'] },
  { paths: ['tests/e2e/connections-codex.cjs', 'tests/e2e/fake-codex/', 'src/main/providers/codex/', 'src/shared/codex.ts'], suites: ['connections-codex'] },
  // Plan usage per connection, the status bar's and Overview's (HI-1756).
  { paths: ['src/main/planUsage.ts', 'src/shared/planLimits.ts', 'src/renderer/src/connectionUsage.ts', 'tests/e2e/connectionusage.cjs'], suites: ['connectionusage', 'planusage', 'antigravity'] },
  { paths: ['src/main/usageMoves.ts', 'src/shared/usageMoves.ts', 'src/main/connectionSwitch.ts', 'src/main/agentChoice.ts', 'src/renderer/src/components/UsageMoveRule.tsx', 'tests/e2e/usagemove.cjs'], suites: ['usagemove'] },
  // The Agent API and connections (HI-1771): references, visibility, the agent routes' connection, the status.
  { paths: ['src/main/servers.ts', 'src/main/mcp/cw-mcp.ts', 'tests/e2e/connectionapi.cjs'], suites: ['connectionapi'] },
  // Model, effort and context belong to the connection (HI-1770): the resolver, the move, the defaults and the notice.
  { paths: ['src/shared/connectionDefaults.ts', 'src/main/connectionMoves.ts', 'src/renderer/src/components/ConnectionDefaults.tsx', 'tests/e2e/connectiondefaults.cjs'], suites: ['connectiondefaults', 'connections', 'context'] },
  // The agent rows and templates name connections (HI-1769).
  { paths: ['src/shared/connectionLabel.ts', 'src/renderer/src/components/TemplatePlan.tsx', 'src/renderer/src/components/TemplateLoad.tsx', 'tests/e2e/connectionrows.cjs'], suites: ['connectionrows', 'connectionfirst', 'templates', 'templatesv2'] },
  { paths: ['src/shared/activity.ts', 'src/renderer/src/views/ActivityTab.tsx', 'src/renderer/src/activityView.ts', 'src/main/agentProcesses.ts'], suites: ['activitytab', 'activityworkspace', 'activitywindows'] },
  { paths: ['src/renderer/src/views/WorkspaceActivity.tsx', 'src/main/activityWorkspace.ts'], suites: ['activityworkspace'] },
  // What agents' commands leave running while they run (HI-2111).
  { paths: ['src/main/orphanProcesses.ts', 'src/main/agentProcesses.ts', 'src/main/processSupervisor.ts', 'src/main/activityWorkspace.ts', 'src/main/teamParked.ts', 'src/main/inboxNotices.ts', 'src/renderer/src/views/ActivityTab.tsx', 'tests/e2e/fake-claude/linger.cjs'], suites: ['orphans'] },
  { paths: ['src/main/compaction.ts'], suites: ['compact', 'overview', 'paneheader', 'idlestatus'] },
  { paths: ['src/shared/safeguards.ts', 'src/main/providers/claude/safeguards.ts', 'src/main/providers/codex/safeguards.ts', 'src/main/cardSessions.ts'], suites: ['safeguards'] },
  { paths: ['src/main/diagnostics.ts', 'src/shared/redact.ts'], suites: ['about', 'testedclis'] },
  { paths: ['src/main/files.ts', 'src/main/platform/gitFiles.ts', 'src/shared/platform/metadataDirs.ts', 'src/renderer/src/views/FilesTab.tsx', 'src/renderer/src/components/FileView.tsx', 'src/renderer/src/components/DocEditor.tsx', 'src/renderer/src/components/Editors.tsx', 'src/renderer/src/editorDrafts.ts', 'src/renderer/src/monaco.ts', 'src/renderer/src/monacoLang.ts'], suites: ['files', 'editor', 'drafts', 'unsaved', 'icons', 'image', 'assistantimages', 'asarfiles'] },
  // The Files tab's Git menu (HI-2743): only the Files tab uses it.
  { paths: ['src/main/filesGit.ts', 'src/shared/gitIgnoreRules.ts', 'src/renderer/src/components/FilesGitMenu.ts', 'src/main/platform/gitRepoOps.ts', 'src/main/platform/repoOpsPorts.ts', 'src/main/repoOpsIpc.ts', 'src/renderer/src/repoOps.ts', 'src/renderer/src/repoOffers.ts'], suites: ['files'] },
  { paths: ['src/main/attachmentsFolder.ts', 'src/shared/attachments.ts', 'src/renderer/src/attach.ts', 'src/renderer/src/components/AttachmentChips.tsx'], suites: ['image', 'files', 'assistantimages', 'storage', 'storageclose', 'dialogs', 'asarfiles', 'codex-extra'] },
  { paths: ['src/main/heldLine.ts', 'tests/e2e/idlequestion.cjs'], suites: ['idlequestion', 'wakeuntaken'] },
  // Codex's offer of a cheaper model (HI-2609): read on its screen, hidden per launch, and a model switch marked.
  { paths: ['tests/e2e/codexnudge.cjs', 'src/main/providers/codex/adapter.ts', 'src/renderer/src/views/ActivityTab.tsx'], suites: ['codexnudge'] },
  { paths: ['tests/e2e/inputblocked.cjs', 'src/main/lineWriter.ts', 'src/main/slotCards.ts'], suites: ['inputblocked', 'idlequestion'] },
  { paths: ['src/main/hookStatus.ts', 'src/main/terminalTitle.ts', 'src/shared/terminalInput.ts'], suites: ['background', 'idlequestion', 'attention', 'mode', 'busy', 'codex', 'codex-background', 'signin', 'idlestatus', 'turnledger', 'safeguards'] },
  // The turn ledger (#648): status by the CLIs' turn ids, reconciliation, the unknown state and Mark idle.
  { paths: ['src/main/turnLedger.ts', 'src/shared/runtime.ts'], suites: ['turnledger', 'idlestatus', 'background', 'attention', 'signin', 'lanewatch', 'replysize', 'hookshealth'] },
  // A CLI's retry wait (HI-1972): Codex's log read in its worker, shown as the agent's status.
  { paths: ['src/main/codexLogWorker.ts', 'src/main/providers/codex/retryLog.ts', 'src/main/retryNotice.ts'], suites: ['turnledger'] },
  // Hooks health (#1336): an agent whose hooks stop arriving shows as unknown, takes no lines, and pauses its lane.
  { paths: ['src/main/hooksHealth.ts', 'src/main/readiness.ts'], suites: ['hookshealth', 'hookstranscript', 'turnledger', 'idlestatus'] },
  { paths: ['src/main/turnsReader.ts', 'src/main/providers/turns.ts', 'src/main/providers/claude/turns.ts', 'src/main/providers/codex/turns.ts', 'src/main/providers/copilot/turns.ts', 'tests/e2e/hookstranscript.cjs', 'tests/e2e/hookscopilot.cjs'], suites: ['hookstranscript', 'hookscopilot', 'hookshealth'] },
  // The rendered screen Combwork reads Claude Code's footer (the live permission mode) from.
  { paths: ['src/main/terminalScreen.ts'], suites: ['mode', 'assistant', 'wakepaste'] },
  // The footer's mode read from that screen, by Claude Code's and Copilot's per-mode patterns (#696).
  { paths: ['src/shared/footerModes.ts'], suites: ['mode', 'copilot', 'advanced'] },
  { paths: ['src/main/mcp.ts', 'src/main/mcpSecrets.ts'], suites: ['assistantmcp', 'drafts', 'mcp', 'mcpagents', 'mcpfile'] },
  // Per-agent MCP servers (#537): the agent's choice, its launch, the dialogs and the MCP tab.
  { paths: ['src/shared/agentMcp.ts'], suites: ['assistantmcp', 'mcpagents', 'mcpfile', 'templates'] },
  // The MCP workspace switch's project picker (#1093): its enable dialog.
  { paths: ['src/renderer/src/components/McpProjectPicker.tsx', 'src/renderer/src/components/McpServerPicker.tsx'], suites: ['assistantmcp', 'mcpfile', 'mcpagents', 'mcp'] },
  { paths: ['tests/e2e/assistantmcp.cjs'], suites: ['assistantmcp'] },
  // MCP catalogues (HI-545): reading, checking and installing their servers, the Catalogue tab and Settings → MCP Catalogues.
  { paths: ['src/main/mcpCatalog.ts', 'src/shared/mcpCatalog.ts', 'src/renderer/src/components/McpCatalog.tsx', 'tests/e2e/mcpcatalog.cjs'], suites: ['mcpcatalog', 'mcpfile'] },
  { paths: ['src/main/notes.ts'], suites: ['drafts', 'codex-handover'] },
  { paths: ['src/main/planUsage.ts', 'src/renderer/src/components/ModelPicker.tsx', 'src/shared/claude.ts', 'src/shared/codex.ts', 'src/shared/prices.ts'], suites: ['plan', 'planusage', 'providers', 'codex-setup', 'context', 'unpricedcost', 'models'] },
  // Models and capabilities from the CLIs, and their fallbacks (#125).
  { paths: ['src/shared/models.ts', 'tests/fixtures/claude-initialize.json', 'tests/fixtures/codex-debug-models.json'], suites: ['models', 'assistant', 'footerfit', 'agents-ui', 'automode'] },
  { paths: ['src/main/power.ts', 'src/shared/keepAwake.ts'], suites: ['quitwait', 'quit'] },
  // The close commands (HI-1368): run as a workspace closes and as Combwork quits, after the drain of its writes.
  { paths: ['src/main/closeCommand/', 'src/main/dbWrites.ts', 'src/shared/closeCommand.ts', 'src/shared/commands.ts', 'src/main/openGate.ts', 'src/renderer/src/components/CloseCommandPanel.tsx', 'src/renderer/src/components/CommandsSettings.tsx', 'tests/e2e/onclose/', 'tests/e2e/onopen.cjs'], suites: ['onclose', 'onopen', 'quit', 'closewindow'] },
  { paths: ['src/main/progress.ts', 'src/main/progressService.ts', 'src/shared/progress.ts', 'src/renderer/src/components/Progress.tsx', 'src/renderer/src/components/ShowAllList.tsx', 'src/shared/progressTabs.ts', 'tests/e2e/progresstabs.cjs'], suites: ['progress', 'progressgates', 'progresslanes', 'progressreport', 'progressstates', 'progresstabs', 'replysize'] },
  { paths: ['src/renderer/src/components/ProgressLanes.tsx', 'src/renderer/src/components/ProgressMerge.tsx', 'src/renderer/src/laneSource.ts', 'src/shared/laneBar.ts', 'tests/e2e/progressgates.cjs'], suites: ['agentstable', 'lanestages', 'lanestart', 'progressgates', 'progresslanes', 'cardcost'] },
  // Branches next to their cards (#1424).
  { paths: ['src/shared/branchCards.ts', 'tests/e2e/gitbranchcards.cjs'], suites: ['gitbranchcards'] },
  // The Progress panel's stages, legend, Solo's lanes, links and old rules marks (#1421).
  { paths: ['tests/e2e/lanesslots.cjs', 'src/renderer/src/components/ProgressLanes.tsx', 'src/renderer/src/laneSource.ts', 'src/shared/laneBar.ts', 'src/shared/lanes.ts', 'src/main/lanes.ts', 'src/main/slotCards.ts', 'src/shared/progressTabs.ts', 'src/renderer/src/components/Progress.tsx'], suites: ['lanesslots'] },
  { paths: ['src/shared/laneStages.ts', 'src/renderer/src/projectStages.ts', 'tests/e2e/lanestages.cjs'], suites: ['lanestages', 'progresslanes'] },
  // HI-2466: a lane waiting for a slot that something still holds, lent it once it is free.
  { paths: ['tests/e2e/laneslotretry.cjs', 'src/main/slotCards.ts', 'src/main/slots.ts', 'src/main/lanes.ts', 'src/shared/lanes.ts'], suites: ['laneslotretry'] },
  { paths: ['tests/e2e/laneend.cjs', 'tests/e2e/cliquit.cjs', 'src/main/slotsApp.ts', 'src/main/sessions.ts', 'src/main/deliveries.ts', 'src/main/providers/claude/adapter.ts', 'src/main/providers/codex/adapter.ts'], suites: ['laneend', 'slotsessions', 'cliquit'] },
  // A watch from a builder's previous conversation, and an agent's watch guards (HI-2197).
  { paths: ['tests/e2e/stalewatch.cjs', 'src/main/watchGuards.ts', 'src/main/watches.ts', 'src/main/cardIntents.ts'], suites: ['stalewatch'] },
  { paths: ['src/main/laneStart.ts', 'src/shared/laneBrief.ts', 'src/renderer/src/components/LaneStartDialog.tsx', 'tests/e2e/lanestart.cjs'], suites: ['agentrole', 'lanestart'] },
  // A lane's brief (HI-1795): given with its cards' placements in slots, delivered outside them.
  { paths: ['src/main/laneBriefs.ts', 'tests/e2e/lanebrief.cjs'], suites: ['lanebrief', 'slotrecovery'] },
  // The shared list's other user: the Assistant's "Done by the Assistant" (#312).
  { paths: ['src/renderer/src/components/ShowAllList.tsx'], suites: ['assistantpanel', 'assistantundo'] },
  { paths: ['src/main/progressReporters/'], suites: ['progressreport', 'progressstates', 'packaged-progress'] },
  { paths: ['src/main/projectAgents.ts'], suites: ['agents', 'agents-ui', 'agents24', 'reorder', 'pages', 'unmerged', 'removeall', 'mergeslot', 'placement', 'swap', 'repolock', 'maxagents'] },
  // Maximum agents (HI-2001): the option, its migration, its refusals and the Load dialog's offer.
  { paths: ['tests/e2e/maxagents.cjs', 'src/shared/agentLimits.ts', 'src/renderer/src/components/ManyAgentsNote.tsx', 'src/main/workflow/preferences.ts', 'src/shared/workflow/preferences.ts'], suites: ['maxagents', 'agents24'] },
  { paths: ['src/main/repoLock.ts', 'src/main/repoLockCore.ts', 'src/main/repoLockWorker.ts', 'tests/e2e/repolock.cjs'], suites: ['repolock', 'repolocktyping', 'gitview', 'mergeslot'] },
  { paths: ['src/main/workflow/queueHost.ts', 'src/main/workflow/mergeQueue.ts', 'src/main/workflow/mergeMessage.ts', 'src/main/workflow/queueRunner.ts', 'src/main/workflow/queueJobs.ts', 'src/main/workflow/queueChecks.ts', 'src/main/workflow/queueChecksApp.ts', 'src/main/repoLock.ts', 'src/main/queueTransportStore.ts', 'tests/e2e/queueFixture.cjs', 'tests/e2e/mergequeue.cjs'], suites: ['mergequeue', 'queueagents', 'queueupgrade'] },
  // HI-2790 (R7), HI-2791 (R8): the queue's candidate, advance, recovery, push and clean-up, moved behind the integration
  // port (its contract, lookup and Git's implementation, Git's commit stream reading, and `again`): a change there is a
  // change to the queue's test merge, strict's update, the journaled advance, a restart's recovery, the push and the lease's
  // workspace removal.
  { paths: ['src/main/platform/integration.ts', 'src/main/platform/integrationPorts.ts', 'src/main/platform/gitIntegration.ts', 'src/main/platform/gitCommits.ts', 'src/main/platform/gitTransport.ts', 'src/main/workflow/transportSnapshots.ts', 'src/main/platform/again.ts'], suites: ['mergequeue', 'mergequeuecrash', 'mergequeuefolder', 'queueagents', 'queuecontrols', 'queuelease', 'queueupgrade'] },
  // Agents under Combwork merges (#1354): the refusals, the wakes and the card's queue state.
  { paths: ['src/main/workflow/queueState.ts', 'src/shared/workflow/refusals.ts', 'src/main/mergeSlots.ts', 'tests/e2e/queueagents.cjs'], suites: ['queueagents'] },
  // Each card's focused tests (G20, HI-1367): chosen at submit, run by the merge queue; this repository's picker and runner.
  { paths: ['tests/e2e/queuefocused.cjs', 'scripts/focusedTests.mjs'], suites: ['queuefocused'] },
  // The queue's controls (#1353): its model, Pause/Resume, Remove from queue and Retry merge, cw_queue.
  { paths: ['src/main/workflow/mergeQueue.ts', 'src/main/workflow/queueHost.ts', 'src/main/workflow/queueControls.ts', 'src/main/folderFence.ts', 'src/shared/workflow/facts.ts', 'tests/e2e/queueFixture.cjs', 'tests/e2e/mergequeuefolder.cjs', 'tests/e2e/mergequeuecrash.cjs'], suites: ['mergequeuecrash', 'mergequeuefolder'] },
  { paths: ['src/main/workflow/mergeQueue.ts', 'src/shared/workflow/options.ts', 'src/shared/workflow/optionTexts.ts', 'src/renderer/src/components/WorkflowOptions.tsx', 'tests/e2e/queueFixture.cjs'], suites: ['p5lane', 'workflowoptions'] },
  { paths: ['src/main/workflow/queueControls.ts', 'src/shared/workflow/queue.ts', 'src/main/workflow/mergeQueue.ts', 'src/main/workflow/queueHost.ts', 'src/main/cardIntents.ts', 'tests/e2e/queueFixture.cjs', 'tests/e2e/queuecontrols.cjs'], suites: ['queuecontrols', 'replysize'] },
  // The queue on the card, in the Git tab and in the Merge dialog (#1357).
  { paths: ['src/renderer/src/components/CardQueue.tsx', 'src/renderer/src/components/GitQueueSection.tsx', 'src/renderer/src/components/CardWork.tsx', 'src/renderer/src/components/ForYou.tsx', 'src/renderer/src/components/AgentDialogs.tsx', 'src/shared/workflow/workView.ts', 'src/main/workflow/queueControls.ts', 'src/shared/workflow/queue.ts', 'tests/e2e/queueFixture.cjs', 'tests/e2e/queuecard.cjs'], suites: ['queuecard'] },
  // The queue in the Progress panel (#1356): its cards, Pulse's line, the badge, the announcements, Combwork's runs in Runs.
  { paths: ['src/shared/progressQueue.ts', 'src/renderer/src/components/ProgressQueue.tsx', 'src/renderer/src/queueSource.ts', 'src/renderer/src/components/Progress.tsx', 'src/renderer/src/components/ProgressMerge.tsx', 'src/shared/progressTabs.ts', 'src/main/workflow/queueControls.ts', 'src/shared/workflow/queue.ts', 'tests/e2e/queueFixture.cjs', 'tests/e2e/progressqueue.cjs'], suites: ['progressqueue', 'progresstabs'] },
  { paths: ['src/main/mergeSlots.ts', 'src/main/mergeSlotHost.ts', 'src/shared/mergeSlot.ts', 'src/renderer/src/components/MergeSlots.tsx'], suites: ['mergeslot', 'progresslanes', 'replysize'] },
  // Lanes (#483): the card loop registers its lane; replysize measures cw_lane; the Progress panel shows them (#484).
  { paths: ['src/main/lanes.ts', 'src/shared/lanes.ts', 'src/main/workflow/lineUpdates.ts'], suites: ['cardloop', 'lanestages', 'progresslanes', 'replysize'] },
  // HI-1990: Combwork starts a lane's next card once the one before it is Done: the suites whose lanes go on from a Done card.
  { paths: ['src/main/laneStarts.ts', 'src/main/laneDeps.ts'], suites: ['p4lane', 'p5lane', 'p6lane', 'p7lane', 'linecarried', 'reviewerpool', 'slotcards', 'slotswitches', 'slotupgrade', 'cardloop'] },
  // HI-2081: pausing the team before an update: its holds, what still runs, Install Now, the Assistants' authority.
  { paths: ['src/main/teamPause.ts', 'src/main/teamParked.ts', 'src/shared/teamPause.ts', 'src/renderer/src/teamPause.ts', 'src/renderer/src/components/TeamPause.tsx', 'tests/e2e/teampause.cjs'], suites: ['teampause', 'lanewatch', 'progresslanes'] },
  // P5's acceptance (#1358): S55's lane, the scenarios first proven in the app, one queue runner across copies of Combwork.
  { paths: ['tests/e2e/p5lane.cjs', 'tests/e2e/queueFixture.cjs', 'src/main/workflow/mergeQueue.ts', 'src/main/workflow/queueHost.ts', 'src/main/workflow/lineUpdates.ts', 'src/main/laneStart.ts', 'src/main/workflow/optionsForm.ts'], suites: ['p5lane'] },
  // P6's acceptance (#1425): a project from added to Done through the Version Control tab, Solo, all off, S19 and S20.
  { paths: ['src/main/workflow/retarget.ts', 'src/renderer/src/components/WorkflowOptions.tsx', 'tests/e2e/retarget.cjs'], suites: ['retarget'] },
  { paths: ['tests/e2e/p6lane.cjs', 'tests/e2e/queueFixture.cjs', 'src/main/workflow/presetStep.ts', 'src/renderer/src/components/PresetStep.tsx', 'src/main/workflow/platformSwitch.ts', 'src/renderer/src/boardStages.ts', 'src/main/laneStart.ts', 'src/main/workflow/optionsForm.ts'], suites: ['p6lane'] },
  // P7's acceptance (#1448): Team 6×6 on slots with review copies, two lanes, S42, S43, the pool, Resume All and restart.
  { paths: ['tests/e2e/p7lane.cjs', 'tests/e2e/queueFixture.cjs', 'src/main/laneStart.ts', 'src/main/slots.ts', 'src/main/slotsApp.ts', 'src/main/slotCards.ts', 'src/main/copies.ts', 'src/main/copiesApp.ts', 'src/main/reviewCopies.ts', 'src/main/agentFolders.ts'], suites: ['p7lane'] },
  { paths: ['tests/e2e/pathsleftout.cjs', 'tests/e2e/queueFixture.cjs', 'src/main/workflow/runtime.ts', 'src/main/platform/nonePlatform.ts', 'src/main/tasks.ts'], suites: ['pathsleftout'] },
  { paths: ['tests/e2e/p6rules.cjs', 'tests/e2e/queueFixture.cjs', 'src/shared/workflow/guards.ts', 'src/shared/workflow/compile.ts', 'src/main/workflow/runtime.ts', 'src/main/workflow/mergeQueue.ts', 'src/main/platform/nonePlatform.ts'], suites: ['p6rules'] },
  // HI-2340: a None card's whole-project read, off main's thread: None starts and submits, code and no-code.
  { paths: ['src/main/noneBaseline.ts', 'src/main/noneBaselineWorker.ts'], suites: ['p6rules', 'nocode'] },
  { paths: ['tests/e2e/p5scenarios.cjs', 'tests/e2e/queueFixture.cjs', 'src/main/workflow/mergeQueue.ts', 'src/main/workflow/queueChecks.ts', 'src/main/workflow/queueChecksApp.ts', 'src/shared/progressQueue.ts'], suites: ['p5scenarios'] },
  { paths: ['tests/e2e/queuelease.cjs', 'tests/e2e/queueFixture.cjs', 'src/main/workflow/queueRunner.ts', 'src/main/workflow/queueJobs.ts', 'src/main/workflow/queueHost.ts'], suites: ['queuelease'] },
  { paths: ['tests/e2e/reviewcopies.cjs', 'src/main/reviewCopies.ts', 'src/main/copies.ts', 'src/main/copiesApp.ts'], suites: ['reviewcopies'] },
  { paths: ['tests/e2e/reviewcopiesreal.cjs'], suites: ['reviewcopiesreal'] },
  { paths: ['tests/e2e/followupsubmit.cjs'], suites: ['followupsubmit'] },
  { paths: ['tests/e2e/reviewerpool.cjs', 'src/main/reviewerPool.ts', 'src/shared/workflow/reviewerPool.ts', 'src/main/laneStart.ts', 'src/shared/laneBrief.ts', 'src/renderer/src/components/LaneStartDialog.tsx', 'src/main/loopReviewer.ts'], suites: ['reviewerpool'] },
  { paths: ['tests/e2e/isolatedcheck.cjs', 'src/main/copies.ts', 'src/main/copiesApp.ts', 'src/main/workflow/launcher.ts', 'src/main/progressReporters/wrapper.ts', 'src/main/processTree.ts', 'src/main/progressReporters/report.mts', 'src/main/workflow/runLink.ts', 'src/main/workflow/runChecks.ts'], suites: ['isolatedcheck', 'progressreport'] },
  { paths: ['tests/e2e/slotcards.cjs', 'tests/e2e/slotrecovery.cjs', 'src/main/slotCards.ts', 'src/main/finishPath.ts', 'src/main/laneStart.ts', 'src/main/platform/gitPlatform.ts', 'src/main/workflow/service.ts'], suites: ['slotcards', 'slotrecovery', 'lanestart'] },
  { paths: ['tests/e2e/slotpool.cjs', 'src/main/slots.ts', 'src/main/slotsApp.ts', 'src/main/slotJobs.ts', 'src/main/workflow/queueJobs.ts', 'src/main/workflow/queueChecks.ts'], suites: ['slotpool', 'slotsessions'] },
  { paths: ['tests/e2e/slotwriterhold.cjs', 'src/main/agentFolders.ts', 'src/main/slots.ts', 'src/main/slotsApp.ts'], suites: ['slotwriterhold'] },
  // P7's switches and slot options set in the window and acting in the app (#1563).
  { paths: ['tests/e2e/p7settings.cjs', 'src/shared/advanced.ts', 'src/renderer/src/components/AdvancedSettings.tsx', 'src/renderer/src/views/ProjectTabs.tsx'], suites: ['p7settings'] },
  { paths: ['tests/e2e/slotscripts.cjs', 'tests/e2e/queueFixture.cjs', 'src/main/slots.ts', 'src/main/slotsApp.ts', 'src/main/slotSettings.ts', 'src/main/worktrees.ts'], suites: ['slotscripts'] },
  { paths: ['tests/e2e/slotswitches.cjs', 'src/main/slotCards.ts', 'src/main/slots.ts', 'src/main/laneStart.ts'], suites: ['slotswitches'] },
  { paths: ['tests/e2e/copyquiet.cjs', 'src/main/copies.ts', 'src/main/copiesApp.ts', 'src/main/reviewCopies.ts'], suites: ['copyquiet'] },
  { paths: ['tests/e2e/startfresh.cjs', 'src/main/freshStarts.ts', 'src/shared/freshStarts.ts', 'src/renderer/src/components/Popups.tsx'], suites: ['startfresh'] },
  { paths: ['tests/e2e/repairslots.cjs', 'tests/e2e/removeprojectslots.cjs', 'src/main/projectFolders.ts', 'src/shared/projectFolders.ts', 'src/main/projectRemoval.ts', 'src/renderer/src/components/MoveRepair.tsx', 'src/renderer/src/components/ProjectRemoval.tsx', 'src/main/agentWorktree.ts'], suites: ['repairslots', 'removeprojectslots', 'wsmove', 'wtrecreate', 'repairbranches'] },
  { paths: ['tests/e2e/queueupgrade.cjs'], suites: ['queueupgrade'] },
  { paths: ['src/shared/atMost.ts'], suites: ['sessionsize', 'slotsessions', 'skilldelivery', 'skills'] },
  { paths: ['src/main/openProgress.ts', 'src/renderer/src/components/WorkspaceOpening.tsx', 'tests/e2e/openguard.cjs', 'tests/e2e/openspeed.cjs'], suites: ['openguard', 'openspeed', 'queueupgrade'] },
  { paths: ['tests/e2e/slotupgrade.cjs', 'src/main/slotMigration.ts', 'src/main/workspaceMove.ts'], suites: ['slotupgrade', 'wsmove', 'repairbranches'] },
  { paths: ['tests/e2e/slotsessions.cjs', 'src/main/agentFolders.ts', 'src/shared/agentFolders.ts', 'src/shared/sessionResume.ts', 'src/shared/resumeAll.ts', 'src/main/sessions.ts'], suites: ['slotsessions', 'legacyworktree'] },
  { paths: ['tests/e2e/legacyworktree.cjs', 'src/main/agentWorktree.ts'], suites: ['legacyworktree', 'slotupgrade'] },
  { paths: ['tests/e2e/slotbroker.cjs', 'src/main/systemBrokers.ts', 'src/main/connectionSwitch.ts', 'src/main/agentProcesses.ts', 'src/main/processSupervisor.ts'], suites: ['slotbroker'] },
  { paths: ['tests/e2e/slotrelease.cjs', 'src/main/agentFolders.ts', 'src/renderer/src/components/SlotsAndCopies.tsx'], suites: ['slotrelease'] },
  // HI-2786: the workspace lifecycle port the slot pool, its card hooks and a 0.9 worktree's recreation act on folders through.
  { paths: ['src/main/platform/workspacePort.ts', 'src/main/platform/gitWorkspacePort.ts', 'src/main/platform/workspacePorts.ts', 'src/main/platform/gitRelocation.ts'], suites: ['slotpool', 'slotrecovery', 'slotrelease', 'slotcards', 'repairslots', 'wtrecreate', 'legacyworktree', 'agentslots', 'lanesslots'] },
  { paths: ['tests/e2e/slotwindows.cjs', 'src/main/agentFolders.ts', 'src/main/agentProcesses.ts', 'src/main/index.ts'], suites: ['slotwindows'] },
  { paths: ['tests/e2e/slotreleaseapi.cjs', 'src/main/slotRelease.ts', 'src/main/agentFolders.ts', 'src/main/slotMigration.ts'], suites: ['slotreleaseapi'] },
  // The Agent API's agents on slots (#1451): where each is, and adding none in a worktree.
  { paths: ['tests/e2e/agentapislots.cjs', 'src/main/agentFolders.ts', 'src/shared/agentFolders.ts', 'src/main/projectAgents.ts', 'src/main/mcp/cw-mcp.ts'], suites: ['agentapislots', 'replysize'] },
  { paths: ['tests/e2e/p4lane.cjs','src/main/workflow/lineUpdates.ts', 'src/main/workflow/runtime.ts', 'src/main/cardIntents.ts', 'src/main/laneStart.ts', 'src/main/workflow/optionsForm.ts'], suites: ['p4lane'] },
  // §16.19.2's continuation on a lane carried over the upgrade on a 0.9 worktree (#1579).
  { paths: ['tests/e2e/linecarried.cjs', 'src/main/workflow/lineUpdates.ts', 'src/main/worktrees.ts', 'src/main/laneStart.ts'], suites: ['linecarried'] },
  // The workspace database's small stores (#1018): lanes, card watches and deliveries.
  { paths: ['src/main/storeRows.ts'], suites: ['progresslanes', 'cardloop', 'deliveries', 'agentmessage', 'inbox', 'lanewatch', 'agentwatch', 'loopwatch', 'watchrelease', 'unexpectedclose'] },
  { paths: ['src/main/projectKeys.ts', 'src/main/schema/keysStep.ts', 'src/main/schema/namesStep.ts', 'src/main/schema/valuesStep.ts', 'src/shared/projectKeys.ts', 'tests/e2e/projectkeys.cjs'], suites: ['projectkeys', 'keysui', 'replysize', 'combworktools', 'cardloop'] },
  { paths: ['src/renderer/src/components/CardWork.tsx', 'src/renderer/src/cardWork.ts', 'src/shared/workflow/workView.ts', 'src/main/workflow/cardWork.ts', 'tests/e2e/cardwork.cjs'], suites: ['cardwork', 'board', 'carddialog', 'progressgates', 'progresslanes'] },
  { paths: ['src/renderer/src/projectKeys.ts', 'src/shared/cardLinks.ts', 'src/renderer/src/cardLinks.ts', 'tests/e2e/keysui.cjs'], suites: ['keysui', 'cardlinks', 'board', 'boardarchive', 'cardchip', 'progresslanes', 'rail'] },
  { paths: ['src/main/storeTables.ts', 'src/main/storeBackup.ts', 'src/main/schema/storeCodec.ts'], suites: ['progresslanes', 'cardloop', 'lanewatch', 'agentwatch', 'loopwatch', 'watchrelease', 'performance'] },
  { paths: ['src/main/projectRemoval.ts', 'src/renderer/src/components/ProjectRemoval.tsx'], suites: ['board', 'storage'] },
  // Combwork's one way to the Recycle Bin (a test copy's trash folder, #414): the suites that delete something.
  { paths: ['src/main/trash.ts'], suites: ['board', 'files', 'storage', 'sessiontree', 'templateshare', 'unusedwt', 'skills', 'transcript', 'unsaved', 'assistantimages'] },
  { paths: ['src/main/providerService.ts', 'src/main/taskKeys.ts', 'src/main/updateStayed.ts'], suites: ['providers', 'codex-setup', 'startfail', 'models', 'testedclis', 'freshpath', 'providerdetect'] },
  // GitHub hosts and Copilot's sign-in per host (HI-2779).
  { paths: ['tests/e2e/githubhosts.cjs', 'src/shared/githubHost.ts', 'src/main/githubHosts.ts', 'src/main/githubHostChanges.ts', 'src/main/providers/copilot/hosts.ts', 'src/main/providers/copilot/install.ts', 'src/main/providers/copilot/models.ts', 'src/renderer/src/components/GithubHosts.tsx', 'src/shared/githubHostText.ts', 'src/renderer/src/signInHost.ts'], suites: ['githubhosts', 'providers'] },
  { paths: ['src/main/keySteps.ts'], suites: ['codex', 'codex-setup'] },
  { paths: ['src/main/rendererWatch.ts'], suites: ['rendercrash', 'windowhealth'] },
  { paths: ['src/shared/windowHealth.ts', 'src/renderer/src/windowHealth.ts', 'src/renderer/src/pageMarks.ts'], suites: ['windowhealth'] },
  // Why Combwork stopped (#985): crash dumps and a log line for every way out; the updater and install-folder checks end the app through it.
  // Combwork closing unexpectedly (#984): the running marker, the notice, Resume All and the setting; a merge left half done is told in it.
  { paths: ['src/main/lastRun.ts', 'src/main/nameUpgradeProfile.ts', 'src/main/listenRetry.ts', 'src/shared/unexpectedClose.ts', 'src/main/mergeSlotHost.ts', 'src/main/mergeSlots.ts', 'tests/e2e/unexpectedclose.cjs', 'tests/e2e/unexpectedclose-leftovers.cjs'], suites: ['unexpectedclose', 'unexpectedclose-leftovers', 'restartresume'] },
  { paths: ['src/main/restartResume.ts', 'src/shared/restartResume.ts', 'tests/e2e/restartresume.cjs'], suites: ['restartresume', 'unexpectedclose'] },
  // Resuming after a connection drops (HI-1612): the wait, its status, Progress run and note.
  { paths: ['src/main/outageResume.ts', 'src/main/outageCore.ts', 'src/main/assistantNotes.ts', 'tests/e2e/outage.cjs'], suites: ['outage'] },
  // "The main process was busy" (#1109): sleep isn't a stall, and a stall names what was running.
  { paths: ['src/shared/projectView.ts', 'src/main/fileHolders.ts', 'tests/e2e/projectview.cjs'], suites: ['projectview', 'tilesview', 'placement', 'templates'] },
  { paths: ['src/main/mainStalls.ts', 'src/shared/mainStalls.ts', 'src/renderer/src/views/PerformanceStalls.tsx', 'src/main/threadPool.ts', 'src/main/stallWatchdog.ts', 'tests/e2e/stalls.cjs'], suites: ['stalls'] },
  { paths: ['src/main/exitLog.ts', 'src/main/memory.ts', 'src/main/diagnostics.ts', 'src/main/updater.ts', 'src/main/installDir.ts'], suites: ['crashdumps'] },
  // .combwork kept out of version control, and its notice (#345).
  { paths: ['src/main/combworkVcs.ts', 'src/main/vcsDetect.ts', 'src/main/platform/gitKeepOut.ts', 'src/main/platform/jjKeepOut.ts', 'src/shared/combworkVcsText.ts', 'src/renderer/src/components/CombworkVcsNotice.tsx'], suites: ['combworkvcs', 'gitinit'] },
  // Hook tokens per launch (#345): the hook server, and hook commands reading their header from the auth file.
  { paths: ['src/main/hookTokens.ts'], suites: ['agents', 'ctxpercent', 'codex-extra', 'attention', 'claude-real', 'claudehome', 'codex', 'review'] },
  { paths: ['src/main/storage.ts', 'src/shared/storage.ts', 'src/renderer/src/components/Storage.tsx'], suites: ['storage', 'storageclose', 'asarfiles', 'purge'] },
  { paths: ['src/renderer/src/components/Purge.tsx'], suites: ['purge'] },
  { paths: ['src/main/antivirus.ts', 'src/shared/antivirus.ts', 'src/renderer/src/components/Antivirus.tsx'], suites: ['antivirus', 'performance', 'repairdefender'] },
  { paths: ['src/shared/tipPlacement.ts'], suites: ['tooltips'] },
  // Where a menu opens (#1329): agents-ui checks + Add ▾ at the window's right edge; the others open menus.
  { paths: ['src/shared/menuPlacement.ts'], suites: ['agents-ui', 'context', 'cardchip', 'keys'] },
  // List dialogs' shared pieces (#1317): ShortPath and the item table the agents tables are built on.
  { paths: ['src/shared/shortPath.ts', 'src/renderer/src/components/ItemTable.tsx'], suites: ['agentstable', 'removeall', 'quit', 'startall', 'cardchip', 'pages'] },
  { paths: ['src/shared/uiPrefs.ts', 'src/renderer/src/projectPrefs.ts'], suites: ['skillprefs', 'skills', 'sessiontree'] },
  { paths: ['src/renderer/src/components/Board.tsx', 'src/renderer/src/components/Overlays.tsx', 'src/renderer/src/components/Tips.tsx', 'src/renderer/src/views/SettingsView.tsx'], suites: ['searchclear'] },
  { paths: ['src/main/taskStart.ts', 'src/main/tasks.ts', 'src/main/boardStore.ts', 'src/main/db.ts', 'src/main/walCheckpoint.ts', 'src/main/walCheckpointWorker.ts','src/shared/tasks.ts', 'src/shared/taskHistory.ts', 'src/shared/boardCopy.ts', 'src/renderer/src/boardReads.ts', 'src/renderer/src/components/Board.tsx', 'src/shared/edgeScroll.ts', 'src/main/cardBusy.ts', 'src/main/decisionNotices.ts', 'src/main/decisionWakes.ts', 'src/renderer/src/boardBatches.ts', 'src/main/coalesce.ts', 'src/renderer/src/components/SetAside.tsx', 'src/main/presence.ts', 'src/renderer/src/components/BoardUpgrade.tsx', 'src/main/schema/', 'src/main/workflow/factStore.ts', 'src/main/workflow/actionWorker.ts', 'src/main/workflow/cardWork.ts', 'src/renderer/src/cardWork.ts', 'src/main/workflow/adoption.ts', 'src/main/workflow/upgrade.ts', 'src/main/workflow/recorder.ts', 'src/main/workflow/reconciler.ts', 'src/main/workflow/reconcile.ts'], suites: ['reconcile', 'projectrename', 'setaside', 'board', 'boardarchive', 'boardbulk', 'boardfold', 'boardscope', 'boardscroll', 'review', 'donemove', 'doingmove', 'carddialog', 'cardchip', 'taskoverview', 'busy', 'dialogs', 'decisions', 'decisionwake', 'replysize', 'cardcost'] },
  { paths: ['src/main/watches.ts', 'src/shared/watch.ts', 'src/shared/agentWatch.ts', 'src/shared/usageWatch.ts', 'src/main/loopCheck.ts', 'src/main/intentWatch.ts'], suites: ['agentmessage', 'deliveries', 'agentwatch', 'cardloop', 'decisionwake', 'lanewatch', 'loopwakes', 'loopwatch', 'quitwait', 'replysize', 'replytell', 'wakepaste', 'wakeuntaken', 'watchrelease'] },
  { paths: ['src/renderer/src/components/watchLine.ts'], suites: ['agentstable', 'agentwatch', 'cardloop'] },
  // Lane watches (#531), and stalls as cards and lanes tell them.
  { paths: ['src/shared/laneWatch.ts', 'src/main/cardStall.ts', 'src/main/agentStarts.ts', 'src/shared/stallSafeguard.ts'], suites: ['lanewatch', 'watchrelease', 'loopwatch', 'replysize'] },
  { paths: ['src/main/taskbar.ts', 'src/shared/taskbar.ts'], suites: ['taskbar', 'progress'] },
  { paths: ['src/main/titleBar.ts', 'src/shared/titleBar.ts'], suites: ['carddialog'] },
  // A window fitted to the display it opens on (#812).
  { paths: ['src/main/windowBounds.ts'], suites: ['tabstrip', 'windows', 'closewindow', 'resize'] },
  { paths: ['src/main/transcripts.ts', 'src/main/transcriptDisplay.ts', 'src/main/transcriptReads.ts', 'src/main/transcriptFiles.ts', 'src/renderer/src/views/SessionsTab.tsx', 'src/shared/sessionOrigin.ts', 'src/shared/sessionResume.ts', 'src/shared/sessionTree.ts'], suites: ['transcript', 'sessionorigin', 'sessionsize', 'sessiontree', 'sessioncleanup', 'loadfail', 'sessionname', 'packaged-transcript', 'purge', 'overview'] },
  // Compressed backups (#1110): resumed from, sized in Storage, read in another language.
  { paths: ['src/main/transcriptFiles.ts'], suites: ['resume', 'storage', 'i18nlive'] },
  // A memo card tile follows a change of language itself (HI-1806).
  { paths: ['src/renderer/src/components/Board.tsx'], suites: ['i18nlive'] },
  { paths: ['src/shared/sessionCleanup.ts', 'src/renderer/src/views/SessionCleanup.tsx'], suites: ['sessioncleanup', 'sessiontree'] },
  // Messages left for agents (#530).
  { paths: ['src/main/agentMessages.ts'], suites: ['agentmessage', 'deliveries', 'replysize'] },
  // Deliveries and cw_inbox (#647).
  // The delivery service, its writer and readiness (#647, #649): every way into an agent goes through them.
  { paths: ['src/main/deliveries.ts', 'src/shared/deliveries.ts', 'src/main/schema/sessionDeliveryTables.ts', 'src/main/schema/sessionDeliveryCodec.ts', 'src/main/lineWriter.ts', 'src/main/readiness.ts'], suites: ['deliveries', 'idlequestion', 'agentmessage', 'viewer', 'replysize', 'loopwakes', 'agentwatch', 'wakeuntaken', 'wakepaste', 'cardloop', 'decisionwake', 'loopwatch', 'lanewatch', 'assistantmode', 'assistant-control', 'signin', 'watchrelease', 'inboxnotices', 'combworktools', 'carryingon', 'codexqueued', 'wakeputoff'] },
  { paths: ['src/main/inboxNotices.ts', 'src/shared/doorbell.ts', 'tests/e2e/fake-claude/fake-claude.cjs'], suites: ['inboxnotices', 'deliveries', 'agentmessage', 'turnledger', 'carryingon'] },
  { paths: ['src/shared/inboxSwitches.ts'], suites: ['carryingon', 'inboxnotices'] },
  // A long conversation's Hand Over (#1057): the notice, the footer, the dialog and the hand-over's own checks.
  { paths: ['src/main/handOverCheck.ts', 'src/shared/handOver.ts', 'src/main/sessions.ts', 'src/main/lanes.ts', 'src/renderer/src/components/AgentPanes.tsx', 'src/renderer/src/components/AgentDialogs.tsx'], suites: ['handovernotice', 'longsession', 'sessionsize'] },
  // Combwork's loop wakes (#405).
  { paths: ['src/main/loopWakes.ts', 'src/main/lanes.ts', 'src/main/queueReturn.ts'], suites: ['loopwakes', 'lanenotices'] },
  // A card's loop reviewer (#1382): who loop wakes go to, and who answers a builder's design.
  { paths: ['src/main/loopReviewer.ts'], suites: ['loopwakes', 'intents'] },
  // Combwork's own notices of the work (#1266): a card's request for the user, a lane's events without the Assistant.
  { paths: ['src/main/workflowNotices.ts', 'tests/e2e/lanenotices.cjs'], suites: ['lanenotices'] },
  { paths: ['src/main/reviewsOnOpen.ts'], suites: ['review', 'stopswitch', 'recent'] },
  { paths: ['src/renderer/src/components/Board.tsx', 'src/renderer/src/components/CardWork.tsx', 'src/renderer/src/components/Overlays.tsx', 'src/shared/laneBar.ts', 'src/main/tasks.ts', 'src/shared/workflow/workView.ts', 'tests/e2e/boardgates.cjs'], suites: ['boardgates'] },
  { paths: ['src/main/cardIntents.ts', 'tests/e2e/intents.cjs'], suites: ['intents', 'replysize'] },
  // The nudge an agent's reply adds for a long card title (HI-1872).
  { paths: ['src/main/titleNudge.ts'], suites: ['replysize'] },
  // An agent's request for the Assistant on a card, cw_ask_assistant (HI-1866).
  { paths: ['src/main/assistantAsk.ts'], suites: ['intents', 'replysize'] },
  { paths: ['src/renderer/src/components/CardKind.tsx', 'src/renderer/src/components/CardReviewSkip.tsx', 'src/renderer/src/components/CardTarget.tsx', 'src/renderer/src/components/reviewSkipTip.ts', 'tests/e2e/nocode.cjs'], suites: ['nocode'] },
  { paths: ['src/renderer/src/components/ForYou.tsx', 'src/renderer/src/forYou.ts', 'src/renderer/src/sharedRead.ts', 'src/renderer/src/components/Shell.tsx', 'src/main/answerRelay.ts'], suites: ['foryou'] },
  // A request's or a decision's short plain form (#1635): For you's chip, the inbox's rows, a card's decision count.
  { paths: ['src/shared/gist.ts'], suites: ['foryou', 'inbox', 'decisions'] },
  { paths: ['src/main/tasks.ts', 'src/main/lanes.ts', 'src/shared/lanes.ts', 'src/main/workflow/cardWork.ts', 'src/main/workflow/recorder.ts', 'src/main/workflow/runtime.ts', 'src/shared/workflow/workView.ts', 'tests/e2e/foryou.cjs'], suites: ['foryou'] },
  { paths: ['src/main/tray.ts', 'src/renderer/src/chime.ts', 'src/shared/bursts.ts'], suites: ['bursts', 'bell', 'banners'] },
  { paths: ['src/main/notices.ts', 'src/main/planUsage.ts'], suites: ['banners'] },
  // One notification system (HI-2320): the routing table, tell(), the pop-ups, the bell and its buttons.
  { paths: ['src/shared/notify.ts', 'src/main/notify.ts', 'src/main/outcomes.ts', 'src/renderer/src/components/Popups.tsx', 'src/renderer/src/entryConditions.ts', 'tests/e2e/notifyonce.cjs'], suites: ['notifyonce', 'banners', 'bell', 'bursts', 'notifytarget'] },
  { paths: ['tests/e2e/notifytarget.cjs', 'src/renderer/src/noticeTarget.ts', 'src/renderer/src/components/Overlays.tsx', 'src/main/events.ts'], suites: ['notifytarget'] },
  { paths: ['src/main/updater.ts', 'src/main/updateFeed.ts', 'src/renderer/src/components/Updates.tsx', 'src/main/buildIdentity.ts', 'src/shared/updates.ts', 'tests/e2e/fakeInstall.cjs'], suites: ['update', 'about'] },
  { paths: ['src/shared/workflow/roles.ts', 'tests/e2e/agentrole.cjs'], suites: ['agentrole', 'agentstable', 'lanestart'] },
  { paths: ['src/shared/launchPolicy.ts', 'src/main/connectionLaunch.ts', 'src/main/independent.ts', 'src/renderer/src/components/LaunchSettings.tsx', 'tests/e2e/launchsettings.cjs'], suites: ['launchsettings', 'agentrole'] },
  { paths: ['src/renderer/src/components/AgentDialogs.tsx', 'src/renderer/src/components/PermissionMode.tsx'], suites: ['agentrole', 'agents-ui', 'agents', 'mode', 'context', 'codex-handover', 'footerfit', 'dialogs', 'mcpagents'] },
  { paths: ['src/renderer/src/components/AgentPanes.tsx'], suites: ['paneheader', 'pages', 'reorder', 'unmerged', 'sessionname', 'ctxpercent', 'footerfit', 'longsession', 'startfail', 'cardchip', 'agents-ui', 'unpricedcost', 'swap', 'templates', 'narrowmain', 'placement'] },
  { paths: ['src/shared/paneCells.ts'], suites: ['placement', 'swap', 'reorder', 'pages', 'agents'] },
  { paths: ['src/renderer/src/pendingMoves.ts'], suites: ['placement', 'tilesview', 'reorder', 'swap'] },
  { paths: ['src/main/docSections.ts', 'src/shared/docSections.ts', 'src/main/mcp/', 'src/shared/toolReplies.ts'], suites: ['docsections', 'replysize'] },
  { paths: ['src/shared/docRefs.ts', 'src/main/docSections.ts', 'src/main/taskStart.ts', 'src/main/tasks.ts', 'src/renderer/src/components/Board.tsx', 'src/renderer/src/components/DocRefViewer.tsx'], suites: ['cardcontext'] },
  { paths: ['src/renderer/src/components/TerminalView.tsx', 'src/renderer/src/fileLinks.ts', 'src/shared/fileLinks.ts', 'src/renderer/src/cardLinks.ts', 'src/shared/cardLinks.ts', 'src/shared/osc52.ts', 'src/renderer/src/hiddenTerminalRedraws.ts'], suites: ['filelinks', 'cardlinks', 'image', 'restart', 'rendercrash', 'termsize', 'hiddenredraw', 'pageswitch', 'assistantbatch', 'copilotsize', 'copilotcopy', 'atlasmerge'] },
  { paths: ['src/renderer/src/deferredFocus.ts'], suites: ['progress', 'restart', 'termsize', 'assistantbatch'] },
  { paths: ['src/shared/sessionEpoch.ts'], suites: ['assistantbatch', 'restart', 'termsize', 'pageswitch'] },
  { paths: ['src/renderer/src/components/Inbox.tsx', 'src/renderer/src/inbox.ts', 'src/shared/inbox.ts'], suites: ['inbox', 'attention', 'bell', 'signin'] },
  // HI-1931's count of what needs you: For you's rows, the status bar's and window title's count, the taskbar badge, the tray.
  { paths: ['src/shared/needYou.ts'], suites: ['foryou', 'inbox', 'attention', 'bell', 'taskbar'] },
  { paths: ['src/renderer/src/components/Keybindings.tsx'], suites: ['keys'] },
  // A change of language while the window is open: the palette and the shortcut editor's clashes (#795).
  { paths: ['src/renderer/src/components/ui.tsx', 'src/renderer/src/components/Overlays.tsx', 'tests/e2e/setupcopy.cjs'], suites: ['setupcopy', 'setuplayout'] },
  { paths: ['src/renderer/src/keyConflicts.ts', 'src/renderer/src/components/Keybindings.tsx', 'src/renderer/src/components/Overlays.tsx', 'src/renderer/src/commands.ts', 'tests/e2e/i18nlive.cjs'], suites: ['i18nlive', 'keys'] },
  { paths: ['src/renderer/src/components/NumberField.tsx', 'src/shared/numberInput.ts'], suites: ['numbers'] },
  { paths: ['src/renderer/src/components/Overlays.tsx', 'src/shared/folderLabels.ts'], suites: ['about', 'quit', 'carddialog', 'keys', 'closewindow', 'removeall', 'testedclis', 'contrast', 'setuplayout'] },
  { paths: ['src/renderer/src/components/ProviderIcon.tsx'], suites: ['providers', 'agents-ui'] },
  // Recent workspaces (#144).
  { paths: ['src/main/recentWorkspaces.ts'], suites: ['recent', 'windows'] },
  { paths: ['src/renderer/src/components/Resizer.tsx'], suites: ['resize', 'progress'] },
  { paths: ['src/renderer/src/components/Sidebar.tsx'], suites: ['agentstable', 'cardchip', 'rail', 'windows', 'contrast', 'panelroom'] },
  // Side-panel lists' one-line descriptions and their tooltips (HI-2527).
  { paths: ['tests/e2e/onelinedesc.cjs', 'src/renderer/src/components/Modes.tsx', 'src/renderer/src/components/Skills.tsx', 'src/renderer/src/components/Templates.tsx', 'src/renderer/src/components/Dialects.tsx', 'src/renderer/src/components/AssistantView.tsx', 'src/renderer/src/components/McpCatalog.tsx'], suites: ['onelinedesc'] },
  // Settings' and Project Settings' section lists: cut names' tooltips (HI-2531).
  { paths: ['tests/e2e/settingsnav.cjs', 'src/renderer/src/views/SettingsView.tsx', 'src/renderer/src/views/ProjectTabs.tsx', 'src/renderer/src/components/ui.tsx'], suites: ['settingsnav'] },
  // Leaving Settings for a view (HI-2525): the activity bar, the side panel, shortcuts, and what is half typed.
  { paths: ['tests/e2e/settingsleave.cjs', 'src/renderer/src/components/Sidebar.tsx', 'src/renderer/src/components/Shell.tsx', 'src/renderer/src/views/SettingsView.tsx', 'src/renderer/src/App.tsx'], suites: ['settingsleave'] },
  // Room for the work beside the side panels (HI-1737).
  { paths: ['src/renderer/src/layoutRoom.ts'], suites: ['panelroom', 'presetstep', 'rail'] },
  // The session toolbar (#975): Panes | Tiles, the summary chip, + Add ▾.
  { paths: ['src/renderer/src/components/AgentPanes.tsx', 'src/renderer/src/components/AgentTiles.tsx'], suites: ['sessiontoolbar'] },
  // Start and Resume busy while a session starts (#1177).
  { paths: ['src/renderer/src/actions.ts', 'src/renderer/src/components/AgentPanes.tsx', 'src/renderer/src/components/Assistant.tsx', 'src/renderer/src/views/SessionsTab.tsx', 'src/renderer/src/views/ProjectView.tsx', 'src/renderer/src/components/Sidebar.tsx', 'src/main/stepTimes.ts'], suites: ['startbusy'] },
  // The Tiles view and focus view (#976).
  { paths: ['src/renderer/src/components/AgentTiles.tsx', 'src/shared/tiles.ts', 'src/renderer/src/views/ProjectView.tsx', 'src/renderer/src/commands.ts'], suites: ['tilestrip', 'tilesview'] },
  // The agent-state marks (#973).
  { paths: ['src/renderer/src/components/StateMark.tsx', 'src/shared/agentState.ts'], suites: ['statemarks', 'contrast'] },
  { paths: ['src/renderer/src/components/AgentsTable.tsx', 'src/shared/agentTable.ts'], suites: ['agentrole', 'agentstable', 'cardchip'] },
  { paths: ['src/renderer/src/agentPlace.ts', 'tests/e2e/agentslots.cjs'], suites: ['agentslots', 'agents-ui', 'files', 'sessionorigin'] },
  { paths: ['src/renderer/src/components/Tips.tsx', 'src/renderer/src/tips.ts', 'src/shared/tips.ts', 'src/shared/corner.ts', 'docs/USER_GUIDE.md', 'src/shared/userGuide.ts'], suites: ['tips', 'tipcorner'] },
  { paths: ['src/renderer/src/tips.ts', 'src/shared/tips.ts'], suites: ['tipwindows'] },
  { paths: ['src/renderer/src/startupReplay.ts'], suites: ['tips', 'tipwindows', 'skillprefs', 'sessiontree'] },
  { paths: ['src/renderer/src/components/TitleBar.tsx'], suites: ['windows', 'keys', 'carddialog', 'pin', 'closewindow', 'assistantside', 'startall', 'recent', 'removeall'] },
  { paths: ['src/main/pin.ts'], suites: ['pin', 'windows'] },
  { paths: ['src/renderer/src/scopedLoad.ts', 'src/shared/scoped.ts'], suites: ['loadfail'] },
  { paths: ['src/renderer/src/usage.ts', 'src/shared/liveUsage.ts', 'src/shared/usageDays.ts', 'src/shared/usageTotals.ts'], suites: ['overview', 'wsoverview', 'ctxpercent', 'context', 'unpricedcost'] },
  // The usage history (#1106): what every usage view reads, the worker that records it, the parsers it runs, Delete and Clean Up recording first.
  { paths: ['src/main/usageHistory.ts', 'src/main/usageWorker.ts', 'src/main/usageDb.ts', 'src/main/usageParsers.ts', 'src/main/advancedValues.ts', 'src/shared/usageLedger.ts'], suites: ['overview', 'wsoverview', 'cardcost', 'unpricedcost', 'perftable', 'performance', 'storage', 'transcript', 'sessioncleanup', 'assistantoverview', 'loadfail', 'safeguards', 'advanced'] },
  { paths: ['src/renderer/src/views/OtherViews.tsx'], suites: ['about', 'skills', 'drafts', 'windows', 'recent', 'welcomefit'] },
  { paths: ['tests/e2e/slotoptions.cjs', 'src/renderer/src/components/SlotsAndCopies.tsx', 'src/main/slotSettings.ts','src/main/workflow/slotsUpToDateStep.ts', 'src/main/workflow/optionsForm.ts', 'src/renderer/src/components/WorkflowOptions.tsx', 'src/shared/workflow/options.ts', 'src/shared/workflow/optionTexts.ts'], suites: ['slotoptions'] },
  { paths: ['src/shared/slotDefaults.ts', 'src/renderer/src/workflowOrigins.ts'], suites: ['slotoptions', 'workflowdefaults'] },
  { paths: ['src/shared/loopLimits.ts', 'src/shared/workflow/preferences.ts', 'src/main/workflow/preferences.ts'], suites: ['workflowoptions', 'workflowdefaults', 'cardloop', 'loopwakes', 'p7settings'] },
  { paths: ['src/main/workflow/optionsForm.ts', 'src/main/workflow/rulesets.ts', 'src/renderer/src/components/WorkflowOptions.tsx', 'src/shared/workflow/options.ts', 'src/shared/workflow/optionTexts.ts', 'tests/e2e/workflowoptions.cjs'], suites: ['workflowoptions', 'assistantsettings', 'workflowdefaults'] },
  { paths: ['src/main/workflow/levels.ts', 'src/renderer/src/views/SettingsView.tsx'], suites: ['workflowdefaults', 'workflowoptions', 'assistantsettings'] },
  { paths: ['src/renderer/src/boardStages.ts', 'src/renderer/src/components/BoardWorkflow.tsx', 'src/renderer/src/components/Board.tsx', 'src/shared/workflow/stages.ts', 'tests/e2e/queueFixture.cjs', 'tests/e2e/boardstages.cjs'], suites: ['boardstages'] },
  { paths: ['src/shared/workflow/stages.ts', 'src/shared/workflow/projectWorkflow.ts', 'src/shared/workflow/compile.ts', 'src/shared/workflow/options.ts', 'src/shared/tasks.ts', 'src/main/workflow/optionsForm.ts', 'src/main/workflow/rulesets.ts', 'src/shared/settingsCatalog.ts', 'src/main/settingsTools.ts', 'tests/e2e/stagenames.cjs'], suites: ['stagenames'] },
  { paths: ['src/renderer/src/views/ProjectTabs.tsx'], suites: ['overview', 'taskoverview', 'skillaudience', 'numbers', 'storage', 'unpricedcost', 'changes', 'changescompare', 'changespicker', 'unusedwt', 'mcpagents'] },
  { paths: ['src/main/gitCompare.ts', 'src/renderer/src/components/ChangesCompare.tsx', 'src/main/platform/repoReads.ts', 'src/main/platform/gitRepoReads.ts', 'src/main/platform/repoReadsPorts.ts'], suites: ['changescompare', 'changespicker'] },
  { paths: ['src/renderer/src/components/ChangesLeftovers.tsx', 'src/shared/branchCleanup.ts'], suites: ['changesleftovers', 'gitcleanup'] },
  { paths: ['src/renderer/src/components/DataTable.tsx', 'src/shared/tableView.ts'], suites: ['overview', 'ctxpercent', 'performance', 'perftable', 'boardarchive'] },
  { paths: ['src/renderer/src/views/ProjectView.tsx', 'src/renderer/src/oneAgentMenu.ts', 'src/shared/oneAgent.ts'], suites: ['oneagent', 'agents-ui', 'agentstable', 'resumeall', 'paneheader', 'rail', 'tabstrip', 'startall', 'narrowmain', 'removeall', 'defaultprovider'] },
  { paths: ['src/renderer/src/views/SettingsView.tsx'], suites: ['numbers', 'keys', 'providers', 'context', 'models', 'assistantsettings'] },
  { paths: ['tests/e2e/settingstips.cjs', 'src/renderer/src/views/SettingsView.tsx', 'src/renderer/src/components/ui.tsx', 'src/shared/settingsCatalog.ts'], suites: ['settingstips'] },
  { paths: ['src/shared/settingsCatalog.ts', 'src/main/settingsTools.ts'], suites: ['assistantsettings', 'numbers', 'replysize', 'providers', 'context'] },
  { paths: ['src/renderer/src/views/WorkspaceOverview.tsx'], suites: ['wsoverview', 'taskoverview', 'cardchip', 'unpricedcost'] },
  // The displayed name (#443): window title, About, status bar, Welcome; the profile folder for packaged builds.
  { paths: ['src/shared/appName.ts'], suites: ['about', 'update', 'welcomefit', 'taskbar', 'packaged'] },
  // Which profile folders a run uses, and its start notices (HI-2461): the accounts folder follows the local choice.
  { paths: ['src/main/profileFolders.ts', 'src/main/profileNotices.ts'], suites: ['accounts'] },
  // Launch at login written again at start (HI-2460): the installed app's only.
  { paths: ['src/main/loginItem.ts'], suites: ['packaged'] },
  { paths: ['src/shared/instructions.ts'], suites: ['skilldelivery'] },
  { paths: ['src/shared/resumeAll.ts'], suites: ['resumeall', 'signin'] },
  { paths: ['src/shared/sessionFresh.ts', 'src/renderer/src/freshResume.ts'], suites: ['freshresume'] },
  { paths: ['src/shared/projectTabs.ts'], suites: ['tabstrip', 'startall', 'gitview'] },
  { paths: ['src/shared/startAll.ts'], suites: ['startall', 'removeall'] },
  { paths: ['src/shared/startFailure.ts'], suites: ['startfail'] },
  // A stopped agent's look (HI-1881): its pane's bar, its dimmed terminal, its header and tile.
  { paths: ['src/shared/sessionEnd.ts', 'src/renderer/src/stopped.ts'], suites: ['stoppedpane', 'image', 'startfail', 'tilesview'] },
  { paths: ['src/main/templates.ts', 'src/renderer/src/templateList.ts', 'src/shared/templates.ts', 'src/shared/templateLoad.ts', 'src/renderer/src/components/TemplatePlan.tsx', 'src/renderer/src/components/TemplateLoad.tsx', 'src/shared/templateDefaults.ts'], suites: ['templateapi', 'templatenames', 'templates', 'templateshare', 'templatesv2', 'templateworkflow'] },
  // The Assistant's template load (HI-1502): its routes, the shared replacement and undo of a load.
  { paths: ['src/main/templateApi.ts', 'tests/e2e/templateapi.cjs'], suites: ['templateapi', 'replysize'] },
  // Choose Connections… and the template picker (HI-2109).
  { paths: ['src/shared/templateConnections.ts', 'src/renderer/src/components/TemplateConnections.tsx', 'tests/e2e/chooseconnections.cjs'], suites: ['chooseconnections', 'templates', 'templateapi'] },
  { paths: ['src/shared/workflow/templateOptions.ts', 'src/renderer/src/components/TemplateLoadWorkflow.tsx', 'src/renderer/src/components/TemplateWorkflowView.tsx', 'tests/e2e/templateworkflow.cjs'], suites: ['templateworkflow'] },
  { paths: ['src/main/templateUpgrade.ts', 'tests/e2e/templatesv2.cjs'], suites: ['templatesv2'] },
  { paths: ['src/main/agentNames.ts', 'src/shared/agentNames.ts'], suites: ['agents', 'agents-ui', 'templatenames', 'templates'] },
  { paths: ['tests/e2e/templatenames.cjs'], suites: ['templatenames'] },
  { paths: ['src/shared/agentBranches.ts'], suites: ['agents', 'agents-ui', 'templates', 'templateshare', 'unusedwt', 'changespicker', 'removeall', 'wtrecreate'] },
  { paths: ['src/renderer/src/stripMenus.ts'], suites: ['templates'] },
  { paths: ['src/renderer/src/components/Templates.tsx'], suites: ['templateshare', 'templatesv2'] },
  { paths: ['src/renderer/src/assets/'], suites: ['about', 'providers'] },
  // The providers' adapters are under src/main/providers/ (every suite, above); these say which suites each mainly drives.
  { paths: ['src/main/providers/claude/'], suites: ['agents', 'agentview', 'launchrace', 'restart', 'resume', 'mode', 'compact', 'image', 'plan', 'claude-real', 'claudehome', 'claudesettings', 'assistantmode', 'assistantresume'] },
  { paths: ['src/main/providers/codex/'], suites: ['codex', 'codex-background', 'codex-extra', 'codex-handover', 'codex-mcpapproval', 'codex-setup', 'codex-storepwsh', 'attention', 'skilldelivery', 'sessiontree', 'codexfolder'] },
  // Copilot's offline suite (the real CLI against the stand-in model), the provider pages and the skill copies it shares with Codex.
  { paths: ['src/main/providers/copilot/', 'src/shared/copilot.ts', 'src/main/exitKeys.ts'], suites: ['copilot', 'copilotsize', 'copilotcopy', 'providers', 'skilldelivery', 'models'] },
  { paths: ['tests/e2e/fake-copilot-api.cjs'], suites: ['copilot', 'copilotsize', 'copilotcopy', 'workspacenotes', 'slotguidance'] },
  // A folder being changed under its agents (#646): the Git view takes it; deliveries and starts wait for it.
  { paths: ['src/main/folderFence.ts'], suites: ['gitview', 'deliveries', 'inbox', 'agentmessage', 'background'] },
  // How Combwork's lines reach a busy real Codex or Copilot (#600): their runner, and what they check.
  { paths: ['tests/e2e/wakepaste-cli/', 'src/main/terminalScreen.ts', 'src/main/lineWriter.ts', 'src/main/deliveries.ts'], suites: ['wakepaste-codex', 'wakepaste-copilot'] },
  { paths: ['src/shared/copilot.ts', 'tests/e2e/fake-copilot-api.cjs'], suites: ['wakepaste-copilot'] },
  { paths: ['src/main/providers/codex/', 'src/shared/codex.ts'], suites: ['wakepaste-codex'] },
  // What a Codex launch through its app server would rely on (#653): checked against the installed Codex.
  { paths: ['src/main/providers/codex/'], suites: ['codex-appserver'] },
  // Codex's Advanced switches (#1167): right-click passed to Codex, and its terminal title left to the user's config.
  { paths: ['src/main/providers/codex/', 'src/main/advancedValues.ts', 'src/renderer/src/components/TerminalView.tsx', 'tests/e2e/codexoverrides.cjs'], suites: ['codexoverrides'] },
  // The switches for an agent pane's Ctrl+C and Ctrl+V and for what Combwork types (#1286).
  { paths: ['src/renderer/src/components/TerminalView.tsx', 'src/shared/terminalInput.ts', 'src/main/sessions.ts', 'tests/e2e/fake-claude/fake-claude.cjs', 'tests/e2e/terminalinput.cjs', 'src/renderer/src/commands.ts', 'src/main/taskStart.ts'], suites: ['terminalinput'] },
  // Claude Code's status line, Combwork's guidance and the user's own Codex hooks (#1285).
  { paths: ['src/main/providers/claude/launchSettings.ts', 'src/main/providers/claude/adapter.ts', 'src/main/servers.ts', 'tests/e2e/claudestatusline.cjs'], suites: ['claudestatusline'] },
  { paths: ['src/main/mcp/cw-mcp.ts', 'src/main/index.ts', 'tests/e2e/agentguidance.cjs'], suites: ['agentguidance'] },
  { paths: ['src/main/providers/codex/adapter.ts', 'tests/e2e/codexownhooks.cjs'], suites: ['codexownhooks'] },
  // Codex's app server asked one thing, owned until it ends (HI-1757): a connection's sign-in check, a launch's hook check.
  { paths: ['src/main/codexChecks.ts'], suites: ['connections-codex', 'codexownhooks'] },
  // The CLI's own setting and the Assistant's other MCP servers (#1284).
  { paths: ['src/shared/cliOwnMode.ts', 'src/renderer/src/components/PermissionMode.tsx', 'src/main/providers/claude/', 'tests/e2e/cliownmode.cjs'], suites: ['cliownmode'] },
  // A typed prompt's line breaks for Codex (HI-1327): the fake Codex's (codexnewline) and the real one's (codex-newline).
  { paths: ['tests/e2e/codexnewline.cjs', 'tests/e2e/codex-newline.cjs', 'src/shared/terminalInput.ts', 'src/main/providers/codex/'], suites: ['codexnewline', 'codex-newline'] },
  // An agent's Hooks dialog and Activity's lock blocks (HI-982), on the fake Claude Code and the fake Codex.
  { paths: ['tests/e2e/claudemanaged.cjs', 'tests/e2e/fake-claude/', 'src/shared/claudeHookHandlers.ts', 'src/main/hookTwins.ts', 'src/main/hookTokens.ts', 'src/main/providers/claude/hookPolicy.ts', 'src/main/providers/claude/adapter.ts', 'src/main/providers/claude/updateChannel.ts', 'src/main/servers.ts', 'src/renderer/src/components/AdminSnippetDialog.tsx', 'src/renderer/src/views/ProjectView.tsx'], suites: ['claudemanaged'] },
  { paths: ['tests/e2e/claudemanagedreal.cjs'], suites: ['claudemanagedreal'] },
  { paths: ['tests/e2e/hooksview.cjs', 'src/main/hookListing.ts', 'src/shared/hooks.ts', 'src/renderer/src/components/HooksDialog.tsx', 'src/main/servers.ts', 'src/main/providers/codex/', 'src/main/providers/claude/', 'src/main/providers/copilot/'], suites: ['hooksview'] },
  // The fake Codex CLI: every suite that runs it.
  { paths: ['tests/e2e/fake-codex/'], suites: ['accounts', 'attachread', 'connectionfirst','carryingon', 'codexqueued', 'codexnudge', 'attention', 'footerfit', 'skilldelivery', 'models', 'sessiontree', 'termsize', 'freshpath', 'defaultprovider', 'providerdetect', 'codexfolder', 'turnledger', 'flightrecorder', 'hookshealth', 'hookstranscript', 'workspacenotes', 'reviewcopies', 'slotguidance', 'p7lane', 'codexnewline', 'hooksview', 'wakeputoff', 'lockask', 'dialectlaunch', 'agenttemp', 'independentlaunch'] },
  // Agents' temp folder (HI-2496): each launch's TEMP, TMP, TMPDIR and CLAUDE_CODE_TMPDIR, the empty default, a refused folder.
  { paths: ['src/main/agentTemp.ts', 'tests/e2e/agenttemp.cjs'], suites: ['agenttemp'] },
  // An Independent agent launches as from a terminal (HI-2731): one agent's role cycle and a fresh one per fake CLI, a running one restarted.
  { paths: ['src/shared/launchPolicy.ts', 'tests/e2e/independentlaunch.cjs'], suites: ['independentlaunch'] },
  // "Ask me" file locks for Codex: the notice's Allow after the blocked turn's end, and the go-ahead (HI-2386).
  { paths: ['tests/e2e/lockask.cjs', 'src/main/sessions.ts', 'src/main/deliveries.ts', 'src/main/notify.ts', 'src/main/providers/codex/'], suites: ['lockask', 'codex-extra'] },
  // Combwork's bundled skills and modes, read at runtime (not documentation).
  { paths: ['resources/skills/', 'src/main/bundledHistory.json'], suites: ['skills', 'skillaudience', 'skilldelivery', 'cardloop', 'replysize', 'slotguidance'] },
  { paths: ['resources/modes/', 'src/main/assistantMode.ts'], suites: ['assistant', 'assistant-control', 'assistantend', 'assistantmode', 'assistantresume'] },
  // The shipped dialect files (HI-2442): synced into each workspace as it opens, beside the skills and modes, and each
  // session's chain is pinned from them at its launch (HI-2443).
  { paths: ['resources/dialects/'], suites: ['skills', 'openspeed', 'dialectlaunch', 'dialectsview'] },
  // The dialects service wired into sessions and the Agent API (HI-2443): chains pinned at launch, the Dialect setting,
  // the launch record, CW_DIALECT_FILE for cw-mcp.js and cw-progress, the API chain.
  { paths: ['src/main/dialects/', 'tests/e2e/dialectlaunch.cjs'], suites: ['dialectlaunch', 'agentguidance', 'dialectsview'] },
  // The Dialects view (HI-2444): its list, a file's texts and layers, Save's checks, the JSON tab, the file actions,
  // Agent Settings' Dialect.
  { paths: ['src/renderer/src/components/Dialects.tsx', 'src/renderer/src/components/dialectOnTip.ts', 'src/shared/dialects.ts', 'tests/e2e/dialectsview.cjs'], suites: ['dialectsview'] },
  // Bundled into the Docs view (About's licence pages, Release Notes, the Agent API reference).
  { paths: ['docs/', 'CHANGELOG.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'scripts/licenses.mjs', 'scripts/licenseText.mjs', 'scripts/thirdPartyNotices.mjs', 'scripts/notices/'], suites: ['about'] },
  // The i18n screenshot route (#769): its case files (each area's, found by name), the translations it shows (every
  // other suite runs in English), and the screens its core cases reach by their hooks; its text report's layout check (#899).
  { paths: ['tests/e2e/layoutReport.cjs'], suites: ['i18nreport', 'i18nshots'] },
  { paths: ['tests/e2e/i18nshots/', 'locales/', 'src/renderer/src/views/ProjectTabs.tsx', 'src/renderer/src/components/Progress.tsx', 'src/renderer/src/components/Popups.tsx', 'src/renderer/src/components/Overlays.tsx', 'src/renderer/src/views/SettingsView.tsx', 'src/main/progress.ts'], suites: ['i18nshots'] },
  // The installer's copies (npm run dist first).
  { paths: ['electron-builder.yml', 'scripts/dist.mjs', 'scripts/distCopy.mjs'], suites: ['packaged', 'packaged-mcp', 'packaged-progress', 'packaged-transcript', 'packaged-workers'] },
  // Combwork's worker threads in the installed copy, their scripts inside app.asar (HI-1880).
  { paths: ['src/main/workerThreads.ts', 'src/main/places.ts', 'src/main/usageWorker.ts', 'src/main/gitWorker.ts', 'src/main/repoLockWorker.ts', 'src/main/walCheckpointWorker.ts', 'src/main/codexLogWorker.ts', 'src/main/noneBaselineWorker.ts', 'src/main/stallWatchdog.ts', 'tests/e2e/packaged-workers.cjs'], suites: ['packaged-workers'] },
  // Session records in the workspace's database (#1061): the suites that read or write them, Remove from Combwork and Repair.
  { paths: ['src/main/sessionStore.ts', 'tests/e2e/storeDocs.cjs', 'src/main/schema/sessionDeliveryTables.ts', 'src/main/schema/sessionDeliveryCodec.ts', 'tests/e2e/sessionDeliveryCodec.cjs'], suites: ['agents', 'assistantimages', 'assistantmode', 'cardchip', 'overview', 'providerdetect', 'quit', 'restart', 'resume', 'review', 'safeguards', 'sessionname', 'sessioncleanup', 'sessionorigin', 'sessionsize', 'sessiontree', 'wtrecreate', 'storage', 'transcript', 'wsmove', 'changespicker', 'dialogs', 'files', 'i18nlive', 'performance', 'projectrename', 'wsoverview', 'removeall', 'codex', 'codex-handover'] },
]

/** Whether a repo path is under one of these paths (a file, or a folder ending in /). Case-insensitive, / separators. */
export function under(file, paths) {
  const f = file.replace(/\\/g, '/').toLowerCase()
  return paths.some((p) => {
    const q = p.toLowerCase()
    return q.endsWith('/') ? f.startsWith(q) : f === q
  })
}

/**
 * Files that need no suite: notes for people and agents (the skills for developing Combwork, in .claude/skills and
 * .agents/skills, are neither shipped nor read by the app; Combwork's own copies there are git-ignored), and the unit tests
 * (npm test runs those).
 */
export const DOCS_ONLY = ['README.md', 'CONTRIBUTING.md', 'AGENTS.md', 'CLAUDE.md', 'RELEASING.md', 'tests/README.md', 'tests/e2e/README.md', 'tests/scenarios/', 'reference/', '.gitattributes', '.gitignore', '.claude/skills/', '.agents/skills/']

/** Fixtures the fake CLIs answer with too (#125): a change to one needs the suites its area names, not only npm test. */
const FAKE_FIXTURES = ['tests/fixtures/claude-initialize.json', 'tests/fixtures/codex-debug-models.json']

/**
 * What only the unit tests use (#390): Vitest's config, CI's workflow (it runs npm test, lint and typecheck, never an e2e
 * suite) and the unit tests' helpers in tests/ (electron-stub.ts, tempDir.ts…; no e2e suite or scenario loads a .ts
 * file from there, which tests/e2esuites.test.ts checks), and the sleeps checker (npm run test:waits: its unit test
 * and a scenario use it, no e2e suite), with its ready-waits rule (readyWaits.mjs, HI-2688). The i18n tooling too (#768): extracting, checking and counting translations and
 * the guard against new hard-coded text (npm test and CI run them; the app never reads them, nor the guard's allowlists
 * in i18n/allow/), and each area's i18n unit tests (tests/i18n/). Agent text's extract script and guard likewise
 * (HI-2065), with the guard's lists in agent-text/allow/. tests/progressReport.mts and tests/runTemp.mts are the runners' and in
 * EVERYTHING. The 1.0 workflow core spike (#1118) too: nothing in the app loads it, and tests/workflow runs its
 * scenarios; the phase that wires it into the app (P3, P4) gives it an area (the 1.0 schema, src/main/schema, has the
 * board's since its cards step, #1209, as the fact store and the actions worker do since #1215). The dialects service
 * (src/main/dialects) has its area since card 6b (HI-2443) wired it into sessions. The dialect-only release's rules
 * (scripts/dialectRelease.mjs, HI-2442: release.mjs runs them, tests/dialectRelease.test.ts tests them) are unit-only.
 * So are the Windows Sandbox checks' own files (tests/sandbox/, HI-2690): no e2e suite or scenario loads or reads them
 * (tests/e2esuites.test.ts checks), the Sandbox runs them on a packaged build, and UNIT_SCANS selects their unit tests.
 */
export const UNIT_ONLY = ['tests/sandbox/', 'scripts/dialectRelease.mjs', 'tests/oldNames.mjs', 'tests/oldNamesAllow.json', 'tests/presenceChecks.mjs', 'tests/presenceAllow.json', 'vitest.config.ts', '.github/workflows/ci.yml', 'scripts/testWaits.mjs', 'scripts/readyWaits.mjs', 'scripts/i18nExtract.mjs', 'scripts/i18nValues.mjs', 'scripts/i18nCheck.mjs', 'scripts/i18nCoverage.mjs', 'scripts/i18nGuard.mjs', 'i18n/allow/', 'scripts/agentTextExtract.mjs', 'scripts/agentTextGuard.mjs', 'scripts/agentTextBoth.mjs', 'scripts/agentTextFiles.mjs', 'agent-text/allow/', 'tests/i18n/', 'tests/workflow/', 'src/shared/workflow/', 'src/shared/platform/', 'src/main/workflow/', 'src/main/platform/', 'src/shared/jjTool.ts', 'resources/tested-vcs.json', 'scripts/fetchJj.mjs', 'tests/jjPortable.cjs']

/** Whether a file is a unit test (tests/*.test.ts, their helpers and fixtures, UNIT_ONLY): npm test covers it, no e2e suite. */
export const unitTest = (f) => /^tests\/[^/]+\.ts$/i.test(f) || under(f, UNIT_ONLY) || (/^tests\/fixtures\//i.test(f) && !FAKE_FIXTURES.includes(f))

/**
 * Combwork's side of every real CLI: launching it, its hooks and the status they give, reading its transcripts, its
 * readiness, and the suites' CLI helpers. A change here needs every real-CLI suite (the real tier: run.mjs --real), not
 * only the fake ones. Each provider's own adapter (PROVIDER_OWN) needs only the real suites its area names.
 */
export const REAL_TIER = [
  'src/main/sessions.ts',
  'src/main/providers/',
  'src/main/providerService.ts',
  'src/main/ptyHost.ts',
  'src/main/hookStatus.ts',
  'src/main/transcripts.ts',
  'src/main/transcriptDisplay.ts',
  'src/main/transcriptFiles.ts',
  'src/shared/providers.ts',
  'tests/e2e/lib.cjs',
  // The environment the real CLIs are started in.
  'tests/e2e/runContext.cjs',
  'tests/e2e/codexHomeLock.mjs',
  // Each real CLI's test home, reset before its run (HI-2606).
  'tests/e2e/testHomeLock.mjs',
  'tests/e2e/testHomes.mjs',
  'tests/e2e/testHomeManifest.mjs'
]
const PROVIDER_OWN = ['src/main/providers/claude/', 'src/main/providers/codex/', 'src/main/providers/copilot/', 'src/main/providers/antigravity/']

/** At most this many reasons a suite (`because`, HI-2690's D5): the first ones, in the changed files' order. */
export const REASONS_PER_SUITE = 3

/** affectedSuites' reasons as lines, `suite: reason; reason`, in the suites' order (none for every suite). */
export const becauseLines = (affected) => (affected.all ? [] : affected.suites.map((s) => `${s}: ${(affected.because?.[s] ?? []).join('; ') || 'picked'}`))

/**
 * The suites a set of changed files needs, from the known suite names (realNames: those that start a real CLI):
 * { all: true, why, real } when every fake suite is needed (real: the real-CLI suites also needed), else
 * { suites, why, because } (why: a line per reason; because: { suite: up to REASONS_PER_SUITE reasons it was picked,
 * deduplicated, in the files' order }, for a ledger's boundary analysis to cite). A real-CLI suite is needed when an
 * area names it, its own file changed, or a file in REAL_TIER (or one no area names) changed. DOCS_ONLY files, unit
 * tests and a change of types only (units[file].typeOnly, splitSelections: HI-2690's D1) select nothing.
 */
export function affectedSuites(files, suiteNames, realNames = [], units = {}) {
  const picked = new Set()
  const because = new Map()
  const why = []
  let all = null
  let allReal = null
  const pick = (s, reason) => {
    picked.add(s)
    if (!because.has(s)) because.set(s, [])
    const r = because.get(s)
    if (r.length < REASONS_PER_SUITE && !r.includes(reason)) r.push(reason)
  }
  for (const raw of files) {
    const file = raw.replace(/\\/g, '/')
    const u = units[file]
    // Types only: erased before anything runs, so no suite, the real tier's included.
    if (u?.typeOnly) {
      why.push(u.typeOnly)
      continue
    }
    const own = /^tests\/e2e\/([^/]+)\.cjs$/i.exec(file)
    if (own && suiteNames.includes(own[1])) {
      pick(own[1], `${file}: its own suite`)
      why.push(`${file}: its own suite`)
      continue
    }
    if (under(file, REAL_TIER) && !under(file, PROVIDER_OWN)) allReal ??= `${file}: every real-CLI suite`
    const areas = AREAS.filter((a) => under(file, a.paths))
    // A SPLIT file (affectedUnits.mjs), by the units its change touches, when the caller worked them out (its areas'
    // suites are in that, when its change needs them).
    if (!u || u.all) for (const a of areas) for (const s of a.suites) pick(s, `${file} (its area)`)
    if (under(file, EVERYTHING)) {
      if (u && !u.all) {
        // Each suite's trail from unitSelection's lines (`file: unit → consumer: suites`); else the file's changed parts.
        const trails = new Map()
        for (const w of u.why) {
          const m = /^(.*): ([^:]*)$/.exec(w)
          if (!m || !m[1].includes(' → ')) continue
          for (const s of m[2].split(', ')) if (!trails.has(s)) trails.set(s, m[1])
        }
        for (const s of u.suites) pick(s, trails.get(s) ?? `${file}: by its changed parts (its areas or a seam)`)
        why.push(`${file}: by its changed parts: ${u.suites.length ? [...new Set(u.suites)].join(', ') : 'no suite'}`, ...u.why.map((w) => `  ${w}`))
        continue
      }
      all ??= u?.all ?? `${file}: shared by every part of Combwork`
      continue
    }
    if (areas.length) {
      why.push(`${file}: ${[...new Set(areas.flatMap((a) => a.suites))].join(', ')}`)
      continue
    }
    if (under(file, DOCS_ONLY) || unitTest(file)) continue
    // Anything else (code, resources, scripts, build files no area names): everything, rather than guess.
    all ??= `${file}: no area names it, so every suite`
    allReal ??= `${file}: no area names it, so every real-CLI suite too`
  }
  const real = realNames.filter((n) => allReal || picked.has(n))
  if (all) return { all: true, why: [all, ...(allReal ? [allReal] : [])], real }
  const suites = suiteNames.filter((n) => picked.has(n) || (allReal && realNames.includes(n)))
  if (allReal) for (const s of realNames) if (!picked.has(s)) pick(s, allReal)
  return { suites, why: [...why, ...(allReal ? [allReal] : [])], because: Object.fromEntries(suites.map((s) => [s, because.get(s) ?? []])) }
}

/**
 * How a file that names a changed unit of a SPLIT file counts (affectedUnits.mjs): as it would changed itself, without
 * the real tier: { suites, why } (its own suite, its areas'), { all: why } (shared by everything, or in no area), or
 * null (docs and unit tests: no suite).
 */
export function placeReference(file, suiteNames) {
  const f = file.replace(/\\/g, '/')
  const own = /^tests\/e2e\/([^/]+)\.cjs$/i.exec(f)
  if (own && suiteNames.includes(own[1])) return { suites: [own[1]] }
  if (under(f, EVERYTHING)) return { all: 'shared by every part of Combwork' }
  const suites = [...new Set(AREAS.filter((a) => under(f, a.paths)).flatMap((a) => a.suites))]
  if (suites.length) return { suites }
  if (under(f, DOCS_ONLY) || unitTest(f)) return null
  return { all: 'which no area names' }
}

/**
 * The unit selections (affectedUnits.mjs) of the SPLIT files among files, changed from base (a commit) to head (a
 * commit, or null: the working tree, as --affected and the picker see it): { file: unitSelection's result }, for
 * affectedSuites' units. Errors don't escape: a file it can't work out selects every suite, saying why.
 */
export function splitSelections(files, { cwd = process.cwd(), base, head = null, suiteNames }) {
  const out = {}
  const all = [...new Set(files.map((f) => f.replace(/\\/g, '/')))]
  const typed = all.filter((f) => /\.(ts|tsx|mts|cts)$/i.test(f))
  const split = all.filter((f) => splitOf(f))
  if (!split.length && !typed.length) return out
  const revs = { base: gitRevision(cwd, base), head: gitRevision(cwd, head) }
  // A TypeScript file changed in its types alone selects nothing (HI-2690's D1); one this can't tell about, as usual.
  for (const file of typed) {
    try {
      const t = typeOnlyChange({ file, ...revs, lines: gitChangedLines(cwd, base, head, file) })
      if (t) out[file] = { typeOnly: t, all: null, suites: [], why: [] }
    } catch {
      // As usual: its selection below, or its areas'.
    }
  }
  for (const file of split) {
    if (out[file]?.typeOnly) continue
    try {
      out[file] = unitSelection({ file, ...revs, lines: gitChangedLines(cwd, base, head, file), place: (f) => placeReference(f, suiteNames), areaSuites: (f) => [...new Set(AREAS.filter((a) => under(f, a.paths)).flatMap((a) => a.suites))] })
    } catch (e) {
      out[file] = { all: `${file}: its changed parts couldn't be worked out (${e.message}), so every suite`, suites: [], why: [] }
    }
  }
  return out
}

const gitLines = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: runContext.baseEnv() }).split(/\r?\n/).filter(Boolean)

/** The commit a base's changes are counted from: where HEAD left the base (default main). */
export const mergeBase = (base = 'main', cwd = process.cwd()) => gitLines(cwd, 'merge-base', base, 'HEAD')[0]

/** The files changed against a base (default main): committed since the merge base, uncommitted and untracked. */
export function changedFiles(base = 'main', cwd = process.cwd()) {
  return [...new Set([...gitLines(cwd, 'diff', '--name-only', mergeBase(base, cwd)), ...gitLines(cwd, 'ls-files', '--others', '--exclude-standard')])]
}

// --- The focused-test picker (HI-1367): which unit tests and e2e suites a change needs.
//
// Combwork's merge queue calls the project's `focused.pick` command in a clean checkout of the revision, with the base
// commit in CW_FOCUSED_BASE and the changed paths on stdin, and reads one JSON line per test (or {"every":true}).
// The unit tests come from three places: a changed test file itself; Vitest's import graph (`vitest list --changed`,
// which the CLI runs, so a change to code a test imports selects it), narrowed to the tests loading a file that names a
// changed part (relatedTests.mjs, HI-2677: every related test where it can't tell); and UNIT_SCANS, for the tests that read the
// repository by `git ls-files`, folder scans or file reads rather than imports, which the import graph can't see.
// The e2e suites are affectedSuites' (above): a change it can't place means every test.

/**
 * The test files `npm run check:repo` runs by test name (its `vitest run … -t "…"` run), from package.json, as
 * tests/checkRepo.test.ts reads its script: null when it isn't in that form (the caller then takes every test file).
 */
export function checkRepoNamed(packageText = null) {
  try {
    const text = packageText ?? readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    const script = JSON.parse(text).scripts?.['check:repo'] ?? ''
    const m = /vitest run ((?:tests\/\S+\.test\.ts\s+)+)-t "/.exec(script)
    return m ? m[1].trim().split(/\s+/) : null
  } catch {
    return null
  }
}

/**
 * The unit tests that read the repository rather than import it, and the changes that can break them. Each entry:
 * `test` (its repo path; a test may have several entries), `paths` (as under() takes them: a file, or a folder ending
 * in /; none: anywhere), and what change to a file under them selects it: `adds` (one added, deleted or renamed),
 * `lines` (RegExp sources, matched case-insensitively against the diff's added and removed lines), or, with
 * neither, any change. tests/focusedPick.test.ts checks that every test file scanning the repository is here.
 */
export const UNIT_SCANS = [
  // Every AREAS and EVERYTHING path must exist, every suite file is listed, every tracked file is placed (ls-files);
  // the suites' own sources are read for their rules (headers, waits, ports, CLI steps); the seams src reads.
  { test: 'tests/e2esuites.test.ts', adds: true },
  { test: 'tests/e2esuites.test.ts', paths: ['tests/e2e/'] },
  { test: 'tests/e2esuites.test.ts', paths: ['src/'], lines: ['CW_TEST_'] },
  // No suite or scenario loads a unit test's helper (tests/*.ts).
  { test: 'tests/e2esuites.test.ts', paths: ['tests/scenarios/'], lines: ['require\\(', '\\bimport\\b', '\\bfrom\\s+[\'"`]'] },
  // Every source file: no control character (#1040), no mixed line endings (#149).
  { test: 'tests/controlCharacters.test.ts', lines: ['[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]'] },
  { test: 'tests/lineEndings.test.ts' },
  // The upgrade's code and the test area's: no existsSync, no handler swallowing an I/O failure (HI-2617).
  { test: 'tests/presenceChecks.test.ts', paths: [...PRESENCE_SCOPE, 'tests/presenceAllow.json'] },
  // Test tooling and Combwork end processes by identity (#603).
  { test: 'tests/folderProcesses.test.ts', paths: ['tests/', 'scripts/', 'src/'], lines: ['process\\.kill', 'task[k]ill'] },
  // Test tooling starts nothing through the shell (#599).
  { test: 'tests/windowsExits.test.ts', paths: ['tests/', 'scripts/'], lines: ['start-process', 'invoke-item', 'shell\\.open(path|external)', '\\bstart\\b'] },
  // Every recorded CLI test home listing is classified by the reset's manifest (HI-2606).
  { test: 'tests/testHomes.test.ts', paths: ['tests/fixtures/testHomes/'] },
  // Tests name the temp folder only through tests/tempDir.ts (#448).
  { test: 'tests/tempDir.test.ts', paths: ['tests/'], lines: ['\\btmpdir\\b', '\\benv\\s*(\\.\\s*|\\[\\s*[\'"`])(temp|tmp)\\b'] },
  // Every e2e suite and scenario starts Combwork with a test profile, quiet.
  // old-name: begin test-area-pick
  { test: 'tests/testArea.test.ts', lines: ['hive-test'] }, // the test area's old name only in its move (HI-2590)
  // old-name: end test-area-pick
  // The fakes refuse an old release's names (HI-2614); the mode that read them is gone (HI-2742).
  { test: 'tests/fakeOldDialect.test.ts', paths: ['tests/e2e/'], lines: ['oldDialect', 'old[-_ ]?[Rr]elease', 'FAKE_OLD'] },
  { test: 'tests/testQuiet.test.ts', paths: ['tests/e2e/', 'tests/scenarios/'], lines: ['_electron\\.launch\\(', 'CW_USER_DATA', 'CW_TEST_QUIET'] },
  // The tools-connected log line (HI-2584): sessions.ts writes it, and suites read it only through lib.combworkToolsConnected.
  { test: 'tests/toolsConnectedLine.test.ts', paths: ['src/main/sessions.ts', 'tests/e2e/', 'tests/scenarios/', 'scripts/'], lines: ['tools connected'] },
  // Every caller of copilotTestEnv gives it `above` (#1308).
  { test: 'tests/fakeCopilotApi.test.ts', paths: ['tests/'], lines: ['copilotTestEnv'] },
  // Source scans of src/ for one rule each.
  { test: 'tests/admission.test.ts', paths: ['src/main/'], lines: ['openingFence'] },
  { test: 'tests/networkDecoding.test.ts', paths: ['src/main/', 'src/preload/', 'src/shared/'], lines: ['fetch', 'undici', 'brotli', 'DecompressionStream', 'zlib'] },
  { test: 'tests/searchBoxes.test.ts', paths: ['src/renderer/src/'], lines: ['<input', 'placeholder', 'aria-label'] },
  { test: 'tests/trash.test.ts', paths: ['src/'], lines: ['trashItem'] },
  // HI-2784: the callers moved to the repository context port, its contract, and who imports Git's implementation of it.
  { test: 'tests/repoPortsImports.test.ts', paths: ['src/main/settingsTools.ts', 'src/main/workflow/levels.ts', 'src/main/workflow/optionsForm.ts', 'src/main/workflow/platformSwitch.ts', 'src/main/platform/repoContext.ts', 'src/main/platform/repoPorts.ts'] },
  { test: 'tests/repoPortsImports.test.ts', paths: ['src/'], lines: ['gitRepoPorts'] },
  // HI-2786: the callers moved to the workspace lifecycle port, its contract and registry, and who imports Git's.
  { test: 'tests/repoPortsImports.test.ts', paths: ['src/main/slots.ts', 'src/main/slotCards.ts', 'src/main/agentWorktree.ts', 'src/main/platform/workspacePort.ts', 'src/main/platform/workspacePorts.ts'] },
  { test: 'tests/repoPortsImports.test.ts', paths: ['src/'], lines: ['gitWorkspacePort'] },
  // HI-2785's R2: the window's reads through the repository reads port (its moved callers, the contract, Git's implementation).
  { test: 'tests/repoReadsImports.test.ts', paths: ['src/main/ipc.ts', 'src/main/workflow/nextVersion.ts', 'src/main/platform/repoReads.ts', 'src/main/platform/repoReadsPorts.ts'] },
  { test: 'tests/repoReadsImports.test.ts', paths: ['src/'], lines: ['gitRepoReads'] },
  // HI-2788's R3: the window's and the Assistant's mutations through the repository operations port.
  { test: 'tests/repoOpsImports.test.ts', paths: ['src/main/ipc.ts', 'src/main/repoOpsIpc.ts', 'src/main/servers.ts', 'src/main/workflow/nextVersion.ts', 'src/main/assistantUndo.ts', 'src/main/projectAgents.ts', 'src/main/platform/repoOps.ts', 'src/main/platform/repoOpsPorts.ts'] },
  { test: 'tests/repoOpsImports.test.ts', paths: ['src/'], lines: ['gitRepoOps'] },
  // HI-2788's round 1: the renderer's merge entries gated, and no mutation channel called past repoOp.
  { test: 'tests/repoOffers.test.ts', paths: ['src/renderer/src/'], lines: ['branchMergeFor', 'mergeFor', "call(Shared)?\\('"] },
  { test: 'tests/repoOffers.test.ts', paths: ['src/shared/repoOpChannels.ts', 'src/shared/platform/descriptors.ts', 'src/renderer/src/repoOps.ts', 'src/renderer/src/repoOffers.ts'] },
  // HI-2789: copies, a Resume's claim, a lane's start, agents' worktrees and the providers' context reads moved to the ports.
  { test: 'tests/repoPortsImports.test.ts', paths: ['src/main/accounts.ts', 'src/main/providers/common.ts', 'src/main/providers/claude/memoryDir.ts', 'src/main/copies.ts', 'src/main/agentFolders.ts', 'src/main/lanes.ts', 'src/main/projectAgents.ts'] },
  { test: 'tests/historyPortsImports.test.ts', paths: ['src/main/workflow/reconcile.ts', 'src/main/workflow/reconciler.ts', 'src/main/workflow/recorder.ts', 'src/main/workflow/targets.ts', 'src/main/workflow/retarget.ts', 'src/main/workflow/runChecks.ts', 'src/main/workflow/focusedRun.ts', 'src/main/workflow/queueChecks.ts', 'src/main/platform/history.ts', 'src/main/platform/historyPorts.ts'] },
  { test: 'tests/historyPortsImports.test.ts', paths: ['src/'], lines: ['gitHistory'] },
  // HI-2790: the merge queue's candidate through the integration port, its contract, and who imports Git's implementation of it.
  { test: 'tests/integrationPortsImports.test.ts', paths: ['src/main/workflow/mergeQueue.ts', 'src/main/workflow/queueHost.ts', 'src/main/workflow/queueRunner.ts', 'src/main/workflow/queueControls.ts', 'src/main/platform/integration.ts', 'src/main/platform/integrationPorts.ts'] },
  { test: 'tests/integrationPortsImports.test.ts', paths: ['src/'], lines: ['gitIntegration'] },
  { test: 'tests/exitLog.test.ts', paths: ['src/main/'], lines: ['app\\.quit', 'app\\.exit', 'process\\.exit', 'app\\.relaunch', 'quitAndInstall', 'exitBy'] },
  // Each function in main taking the board's lock or a database lease is listed by file and name (HI-1368): a new
  // one, or a change to a listed file (a rename of its function), can break it.
  { test: 'tests/dbWrites.test.ts', paths: ['src/main/'], lines: ['withFileLock', 'boardLock', 'leaseDb', 'withLeasedDb'] },
  { test: 'tests/dbWrites.test.ts', paths: ['src/main/boardStore.ts', 'src/main/deliveries.ts', 'src/main/sessionStore.ts', 'src/main/storeRows.ts', 'src/main/storeTables.ts'] },
  { test: 'tests/legacyWorktreeGate.test.ts', paths: ['src/'], lines: ['worktree'] },
  { test: 'tests/i18nFormatting.test.ts', paths: ['src/'], lines: ['toLocale', 'Intl\\.', 'i18n-ignore'] },
  { test: 'tests/userGuide.test.ts', paths: ['src/renderer/src/'], lines: ['openGuideAt'] },
  { test: 'tests/userGuide.test.ts', paths: ['docs/USER_GUIDE.md', 'README.md'] },
  { test: 'tests/tips.test.ts', paths: ['docs/USER_GUIDE.md'] },
  // The translations and the messages they come from (#768): extracted catalogues current, files well formed, the
  // guard against new hard-coded text over every file in src/ and its allowlists.
  { test: 'tests/i18n.test.ts', paths: ['locales/'] },
  { test: 'tests/i18n/numbers.test.ts', paths: ['locales/en/'] },
  { test: 'tests/i18nCatalogues.test.ts', paths: ['locales/', 'src/shared/i18n/values/'] },
  { test: 'tests/i18nCatalogues.test.ts', paths: ['src/'], lines: ['msg\\(', '\\btr\\(', 'tRich\\(', 'defaultMessage', 'description', '\\bid:'] },
  // A real file and its allowlist (Board.tsx's); the whole source is the CLI's (check:repo, CI), not this test's (HI-2663).
  { test: 'tests/i18nGuard.test.ts', paths: ['src/renderer/src/components/Board.tsx', 'i18n/allow/'] },
  // Agent text (HI-2065): two real files and their lists; the whole source is the CLI's (check:repo, CI), not this
  // test's (HI-2689). The catalogue and schema extracted from the agentMsg() descriptors, current.
  { test: 'tests/agentTextGuard.test.ts', paths: ['src/shared/combworkGuidance.ts', 'src/shared/toolReplies.ts', 'agent-text/allow/'] },
  { test: 'tests/agentText.test.ts', paths: ['agent-text/catalogue/', 'agent-text/schema/'] },
  // HI-2457: agentTextSchema() against the schema area files on disk; each glob user's source read (none imported but schema.ts).
  { test: 'tests/globCache.test.ts', paths: ['agent-text/schema/', 'src/main/installDir.ts', 'src/shared/i18n/catalogues.ts'] },
  { test: 'tests/agentText.test.ts', paths: ['src/'], lines: ['agentMsg\\('] },
  // HI-2440: the window's messages agents read, followed from the calls that read text (the catalogue's audience both).
  { test: 'tests/agentText.test.ts', paths: ['src/main/', 'src/shared/'], lines: ['msg\\(', 'agent-text:', 'CombworkError', 'englishText', 'agentText'] },
  { test: 'tests/agentTextBoth.test.ts', paths: ['agent-text/catalogue/', 'agent-text/schema/'] },
  // The dialects service checks files against the schema it bundles (an import glob, which --changed doesn't follow).
  { test: 'tests/dialects.test.ts', paths: ['agent-text/schema/'] },
  { test: 'tests/i18nshots.test.ts', paths: ['tests/e2e/i18nshots/', 'tests/e2e/i18nshots.cjs'] },
  // German or Polish read from locales/ to check a screen in that language.
  { test: 'tests/actionHandlers.test.ts', paths: ['locales/de/'] },
  { test: 'tests/gitInit.test.ts', paths: ['locales/de/'] },
  { test: 'tests/progressQueue.test.ts', paths: ['locales/de/'] },
  { test: 'tests/settingsTools.test.ts', paths: ['locales/de/'] },
  { test: 'tests/skillDescriptions.test.ts', paths: ['locales/de/', 'resources/skills/'] },
  { test: 'tests/benchmark.test.ts', paths: ['locales/pl/'] },
  { test: 'tests/flightRecorder.test.ts', paths: ['locales/pl/'] },
  { test: 'tests/buildFacts.test.ts', paths: ['locales/'] },
  { test: 'tests/laneBar.test.ts', paths: ['locales/'] },
  // Every workflow refusal rendered in each locale (HI-2281): a translation changed alone imports nothing it sees.
  { test: 'tests/workflow/texts.test.ts', paths: ['locales/'] },
  // What the Sandbox checks' window driver relies on (HI-2298): Combwork's English text, the selectors, IPC channels and
  // Agent API routes it uses, and the e2e fake Claude Code its stand-in installer copies.
  { test: 'tests/sandboxChecks.test.ts', paths: ['locales/en/', 'src/shared/api.ts', 'src/main/servers.ts'] },
  { test: 'tests/sandboxChecks.test.ts', paths: ['src/renderer/src/'], lines: ['providers-banner', 'setup-tab', 'welcome', 'workbench', 'statusbar', 'status-item', 'data-git', 'palette', 'data-command', 'help\\.agentSetup', 'overview-page', 'ws-projects', 'board', 'data-note', 'skill-row', 'pane-empty', 'sessions-(list|tree)', 'main-area', 'empty-state', 'name="loading"'] },
  { test: 'tests/sandboxChecks.test.ts', paths: ['tests/e2e/fake-claude/', 'tests/e2e/fake-bridge.cjs'], adds: true },
  // The profile move's script (HI-2602) reads the record of a move and the sign-in check's log lines the app writes.
  { test: 'tests/sandboxChecks.test.ts', paths: ['src/main/profileNotices.ts', 'src/main/profileFolders.ts', 'src/main/index.ts'] },
  // The clean-install check's step (HI-2592): the English text, IPC channels, palette commands and Settings selectors it
  // uses, and StartOptions' prompt, which gives the agent its first task.
  { test: 'tests/sandboxClean.test.ts', paths: ['locales/en/', 'src/shared/api.ts', 'src/renderer/src/commands.ts', 'src/renderer/src/components/ui.tsx', 'src/main/sessions.ts'] },
  // The Windows Sandbox checks' own files (HI-2690's D3: no e2e suite runs them): their unit tests load them by
  // require, which Vitest's graph may not follow, and read the scripts inside as text.
  { test: 'tests/sandboxChecks.test.ts', paths: ['tests/sandbox/'] },
  { test: 'tests/sandboxClean.test.ts', paths: ['tests/sandbox/'] },
  { test: 'tests/sandboxCompare.test.ts', paths: ['tests/sandbox/'] },
  { test: 'tests/sandboxReport.test.ts', paths: ['tests/sandbox/'] },
  // The bundled skills and modes (resources/), and the guidance that names them.
  { test: 'tests/assistant.test.ts', paths: ['resources/modes/'] },
  { test: 'tests/modeDescriptions.test.ts', paths: ['resources/modes/'] },
  { test: 'tests/skills.test.ts', paths: ['resources/skills/'] },
  { test: 'tests/retention.test.ts', paths: ['resources/skills/'] },
  // Each side's skill files name only the tools offered to that side (HI-2664).
  { test: 'tests/toolSides.test.ts', paths: ['resources/skills/'] },
  { test: 'tests/bundled.test.ts', paths: ['resources/', 'src/main/bundledHistory.json'] },
  { test: 'tests/bundledrace.test.ts', paths: ['resources/'] },
  // The shipped dialect files (HI-2442): each one's form, model and schema, and their sync into a workspace.
  { test: 'tests/dialectsShipped.test.ts', paths: ['resources/dialects/', 'src/main/bundledHistory.json'] },
  { test: 'tests/guidance.test.ts', paths: ['resources/skills/', 'resources/modes/', '.claude/skills/', '.agents/skills/', 'AGENTS.md', 'RELEASING.md', 'docs/AGENT_API.md', 'tests/scenarios/scenarios.cjs', 'src/main/mcp/cw-mcp.ts'] },
  // THIRD_PARTY_NOTICES.md is generated from what ships (package.json's dependencies, the renderer's libraries).
  { test: 'tests/licenses.test.ts', paths: ['package.json', 'package-lock.json', 'THIRD_PARTY_NOTICES.md', 'LICENSE', 'scripts/thirdPartyNotices.mjs', 'scripts/licenseText.mjs', 'scripts/licenses.mjs', 'scripts/notices/'] },
  // Advanced settings (#367): the list, and the recorded fixtures each CLI-facing default is checked against.
  { test: 'tests/advanced.test.ts', paths: ['src/shared/advanced.ts', 'tests/fixtures/'] },
  { test: 'tests/settingsWorkspace.test.ts', paths: ['src/shared/advanced.ts'] },
  // npm run check:repo's test files and the tests it picks by name exist (HI-2244): its script, a test file renamed or
  // deleted, or a describe or test renamed in a file it runs by name.
  { test: 'tests/checkRepo.test.ts', paths: ['package.json'] },
  { test: 'tests/checkRepo.test.ts', paths: ['tests/'], adds: true },
  // The files check:repo runs by test name (its `-t` run), read from package.json as checkRepo.test.ts reads them
  // (HI-2689): unreadable there, every test file.
  { test: 'tests/checkRepo.test.ts', paths: checkRepoNamed() ?? ['tests/'], lines: ['\\bdescribe\\(', '\\bit\\('] },
  // This table's own check: a test file added, or one starting to scan the repository.
  // The hubs most tests reach must stay known to the unit picker's gate (HI-2697): their text, not their imports.
  { test: 'tests/relatedTests.test.ts', paths: ['src/main/workflow/launcher.ts', 'src/main/workflow/gitHost.ts', 'src/main/mcp/cw-mcp.ts', 'src/renderer/src/commitLoop.tsx', 'src/renderer/src/commitWatch.ts', 'src/renderer/src/windowHealth.ts'] },
  { test: 'tests/focusedPick.test.ts', paths: ['tests/'], adds: true },
  { test: 'tests/focusedPick.test.ts', paths: ['tests/'], lines: ['ls-files', 'readdir', '\\bglob'] }
]

const slashes = (p) => p.replace(/\\/g, '/')

/** Whether a UNIT_SCANS entry selects its test for a changed file (moved: added, deleted or renamed; lines: the diff's). */
export function scanSelects(entry, file, { moved = false, lines = [] } = {}) {
  if (entry.paths && !under(file, entry.paths)) return false
  if (!entry.adds && !entry.lines) return true
  if (entry.adds && moved) return true
  if (!entry.lines) return false
  const res = entry.lines.map((s) => new RegExp(s, 'i'))
  return lines.some((l) => res.some((re) => re.test(l)))
}

/** Whether a UNIT_SCANS entry needs a file's diff lines (it has `lines` and covers the file). */
export const needsLines = (file) => UNIT_SCANS.some((e) => e.lines && (!e.paths || under(file, e.paths)))

/** A unit test's id: a test file under tests/ (tests/x.test.ts, tests/i18n/y.test.ts). */
export const isUnitTestFile = (f) => /^tests\/(?:[^/]+\/)*[^/]+\.test\.ts$/.test(f) && !f.startsWith('tests/e2e/')

/**
 * The tests a change needs, from what the CLI gathered: { every: true, why } when the change needs every test (one
 * affectedSuites can't place), else { tests: [{ test, needs }], why } (why: a line per reason, for stderr). paths: the
 * changed files (repo-relative, /); added and deleted: those of them new or gone (a rename is both, by its two paths);
 * diffLines: { path: the diff's added and removed lines } for the files needsLines names; suites: the e2e suites' names
 * (realNames: the real tier's, packagedNames: the installer's); vitestRelated: the unit test files Vitest's import
 * graph relates to the change. Unit tests first (sorted), then suites (in suites' order).
 */
export function pickTests({ paths, added = [], deleted = [], diffLines = {}, suites, realNames = [], packagedNames = [], vitestRelated = [], units = {} }) {
  const files = [...new Set(paths.map(slashes).filter(Boolean))]
  const affected = affectedSuites(files, suites, realNames, units)
  if (affected.all) return { every: true, why: affected.why }
  const unit = unitPicks({ paths: files, added, deleted, diffLines, vitestRelated })
  const tests = [
    ...[...unit.keys()].map((test) => ({ test, needs: ['unit'] })),
    ...affected.suites.map((s) => ({ test: s, needs: [realNames.includes(s) ? 'real' : packagedNames.includes(s) ? 'packaged' : 'fake'] }))
  ]
  const ids = tests.map((t) => t.test)
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new Error(`picked an empty or repeated test id: ${ids.join(', ')}`)
  // Its stderr lines: the unit tests' reasons, the suites', then why each suite (HI-2690: stdout stays the JSON lines).
  return { tests, why: [...unit.values(), ...affected.why, ...becauseLines(affected).map((l) => `why ${l}`)] }
}

/**
 * The unit tests a change needs, sorted, each with why: a changed test file that still exists, one Vitest's import
 * graph relates to the change (vitestRelated), and each UNIT_SCANS entry a changed file meets. pickTests' unit part.
 */
export function unitPicks({ paths, added = [], deleted = [], diffLines = {}, vitestRelated = [] }) {
  const files = [...new Set(paths.map(slashes).filter(Boolean))]
  const moved = new Set([...added, ...deleted].map(slashes))
  const gone = new Set(deleted.map(slashes).filter((f) => !added.map(slashes).includes(f)))
  const unit = new Map()
  const pick = (test, why) => {
    if (!unit.has(test)) unit.set(test, why)
  }
  for (const f of files) if (isUnitTestFile(f) && !gone.has(f)) pick(f, `${f}: changed`)
  for (const f of vitestRelated.map(slashes)) if (isUnitTestFile(f)) pick(f, `${f}: imports what changed (vitest --changed)`)
  for (const f of files) {
    const lines = diffLines[f] ?? []
    for (const e of UNIT_SCANS) if (!gone.has(e.test) && scanSelects(e, f, { moved: moved.has(f), lines })) pick(e.test, `${e.test}: reads ${f}${e.lines ? ' (a line it checks)' : e.adds && moved.has(f) ? ' (added or removed)' : ''}`)
  }
  return new Map([...unit.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/** The picker's output: one JSON line per test, or {"every":true} alone; nothing for nothing needed. */
export const pickLines = (picked) => (picked.every ? [JSON.stringify({ every: true })] : picked.tests.map((t) => JSON.stringify(t)))

/** A unified diff's (-U0) added and removed lines per file, the +++/--- headers aside. */
export function diffLinesOf(diff) {
  const out = {}
  let file = null
  let from = null
  for (const raw of diff.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('diff --git ')) {
      file = from = null
      continue
    }
    if (line.startsWith('--- ')) {
      from = line === '--- /dev/null' ? null : line.slice(4).replace(/^a\//, '')
      continue
    }
    if (line.startsWith('+++ ')) {
      file = line === '+++ /dev/null' ? from : line.slice(4).replace(/^b\//, '')
      continue
    }
    if (file && (line.startsWith('+') || line.startsWith('-'))) (out[file] ??= []).push(line.slice(1))
  }
  return out
}

/** The unit test files Vitest relates to the changes since base (its import graph), repo-relative; throws on failure. */
function listVitestRelated(cwd, base) {
  const vitest = join(cwd, 'node_modules', 'vitest', 'vitest.mjs')
  if (!existsSync(vitest)) throw new Error(`no ${vitest}: the checkout needs its packages (npm install) to pick unit tests`)
  mkdirSync(join(runContext.TEST_ROOT, 'tmp'), { recursive: true })
  const dir = mkdtempSync(join(runContext.TEST_ROOT, 'tmp', 'focused-pick-'))
  try {
    const out = join(dir, 'list.json')
    // Its output goes to stderr: stdout is the picker's answer alone.
    const r = spawnSync(process.execPath, [vitest, 'list', '--filesOnly', '--passWithNoTests', '--changed', base, `--json=${out}`], { cwd, env: runContext.baseEnv(), stdio: ['ignore', 2, 2] })
    if (r.error) throw r.error
    if (r.status !== 0) throw new Error(`vitest list --changed ${base} exited with ${r.status}`)
    const root = slashes(resolve(cwd)).toLowerCase() + '/'
    return JSON.parse(readFileSync(out, 'utf8')).map((e) => slashes(e.file ?? e)).map((f) => (f.toLowerCase().startsWith(root) ? f.slice(root.length) : f))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const git = (cwd, args) => execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8', env: runContext.baseEnv(), maxBuffer: 512 * 1024 * 1024 })

/** The CLI: gathers pickTests' inputs in the checkout (cwd) and prints its lines. Diagnostics go to stderr. */
async function pickCli() {
  const cwd = process.cwd()
  const base = process.env.CW_FOCUSED_BASE
  if (!base) throw new Error('CW_FOCUSED_BASE (the base commit) is not set')
  git(cwd, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])
  const paths = [...new Set(readFileSync(0, 'utf8').split(/\r?\n/).map((l) => slashes(l.trim())).filter(Boolean))]
  if (!paths.length) return
  const { SUITES } = await import('./suites.mjs')
  const { isRealCli } = await import('./runner.mjs')
  const suites = SUITES.map((s) => s.name)
  const realNames = SUITES.filter(isRealCli).map((s) => s.name)
  const packagedNames = SUITES.filter((s) => (s.needs ?? []).includes('packaged')).map((s) => s.name)
  // The SPLIT files by their changed parts (the checkout is the revision: its working tree against the base).
  const units = splitSelections(paths, { cwd, base, head: null, suiteNames: suites })
  // Every suite: no need to look further.
  if (affectedSuites(paths, suites, realNames, units).all) {
    const picked = pickTests({ paths, suites, realNames, packagedNames, units })
    for (const w of picked.why) console.error(w)
    for (const l of pickLines(picked)) console.log(l)
    return
  }
  const atBase = new Set(git(cwd, ['ls-tree', '-r', '--name-only', '-z', base]).split('\0').filter(Boolean))
  const added = paths.filter((p) => !atBase.has(p))
  const deleted = paths.filter((p) => atBase.has(p) && !existsSync(join(cwd, p)))
  const diffLines = paths.some(needsLines) ? diffLinesOf(git(cwd, ['diff', '--no-ext-diff', '--no-color', '--no-renames', '-U0', base, '--'])) : {}
  // Vitest's related tests, narrowed to those loading a file that names what changed (relatedTests.mjs, HI-2677).
  const related = narrowRelatedInTree({ cwd, base, paths, related: listVitestRelated(cwd, base) })
  const picked = pickTests({ paths, added, deleted, diffLines, suites, realNames, packagedNames, vitestRelated: related.keep, units })
  for (const w of related.why) console.error(w)
  for (const w of picked.why) console.error(w)
  for (const l of pickLines(picked)) console.log(l)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv.includes('--pick')) {
  pickCli().catch((e) => {
    console.error(`The pick failed: ${e.message}`)
    process.exit(2)
  })
}
