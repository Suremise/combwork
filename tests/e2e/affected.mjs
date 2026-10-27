// Which e2e suites a change needs (npm run e2e -- --affected [base]): for review rounds that fixed a few things, rather
// than the whole set. A tool, not a merge's gate: merges run focused checks (#1010, tests/e2e/README.md). Errs towards more, never fewer: the files every
// part of Hive goes through, the test tooling, and any file that isn't in an area or known to need no suite (DOCS_ONLY,
// the unit tests'), mean every suite. The full set itself runs at checkpoints (each RC and release, on request:
// tests/e2e/README.md). Suites that start a real CLI (the real tier) are picked only when a change touches what they
// cover (an area naming them, or REAL_TIER), which is when a merge also needs the real tier. tests/e2esuites.test.ts
// checks that every suite is in an area, every source file is covered, and what no area names falls back to every suite.
import { execFileSync } from 'child_process'
import { createRequire } from 'module'

const runContext = createRequire(import.meta.url)('./runContext.cjs')

/** Changes to these touch everything (the IPC contract, types, the store, the shell, the test harness): every suite. */
export const EVERYTHING = [
  'src/main/index.ts',
  'src/main/ipc.ts',
  'src/main/config.ts',
  'src/main/events.ts',
  'src/main/windows.ts',
  'src/main/workspace.ts',
  'src/main/sessions.ts',
  'src/main/servers.ts',
  'src/main/fsutil.ts',
  // Every workspace's open and close marks it, and every database's open is fenced by that (#1379).
  'src/main/openingFence.ts',
  'src/main/paths.ts',
  'src/main/logger.ts',
  // Its thread writes every line hive.log and hooks.log get (HI-1730).
  'src/main/logWriter.ts',
  // Every IPC call, database step and slow log write is marked through it (HI-1692).
  'src/main/stallWork.ts',
  'src/main/ptyHost.ts',
  'src/main/testQuiet.ts',
  // Every IPC call's errors and the Agent API's go through it (#845).
  'src/main/hiveError.ts',
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
  'tests/e2e/record.mjs',
  'tests/e2e/runner.mjs',
  'tests/e2e/build.mjs',
  'tests/e2e/logs.mjs',
  'tests/e2e/lanes.mjs',
  'tests/e2e/runContext.cjs',
  'tests/e2e/slots.mjs',
  'tests/e2e/codexHomeLock.mjs',
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
  // A process that fails to start, reported with its code (#599).
  { paths: ['tests/e2e/windowsExits.cjs', 'tests/e2e/record.mjs'], suites: ['failfast'] },
  { paths: ['src/main/ptyHost.ts', 'src/main/sessions.ts'], suites: ['stopswitch', 'replysize', 'quit', 'copilotsize', 'termsize'] },
  { paths: ['src/main/agentProcesses.ts', 'src/main/processSupervisor.ts', 'src/main/launchGate.ts', 'src/main/ptyHost.ts', 'src/shared/agentProcesses.ts', 'src/main/sessions.ts', 'tests/e2e/fake-claude/linger.cjs'], suites: ['leftovers', 'leftovers-restart', 'unexpectedclose-leftovers'] },
  { paths: ['tests/e2e/fake-claude/devapp/'], suites: ['leftovers-restart'] },
  { paths: ['tests/scenarios/harness.cjs', 'tests/e2e/folderProcesses.cjs', 'tests/e2e/fake-claude/linger.cjs', 'src/main/progressReporters/'], suites: ['scenarioteardown'] },
  { paths: ['tests/e2e/folderProcesses.cjs', 'tests/e2e/leftCopies.mjs', 'tests/e2e/lanes.mjs'], suites: ['harnessleftovers'] },
  { paths: ['src/renderer/src/commitWatch.ts', 'src/renderer/src/commitLoop.tsx', 'src/shared/commitWatch.ts'], suites: ['commitburst'] },
  // The real CLIs' background processes (#515): only when what tracks them changes, not with every sessions.ts change.
  { paths: ['src/main/agentProcesses.ts', 'src/main/processSupervisor.ts', 'src/main/launchGate.ts'], suites: ['leftovers-claude', 'leftovers-codex'] },
  // The Agent API for apps that show Hive (#620): viewer tokens, the discovery file, the event stream's events.
  { paths: ['src/main/apiEvents.ts', 'src/shared/assistantActivity.ts', 'src/main/activityTargets.ts', 'src/main/apiDiscovery.ts', 'src/main/viewerTokens.ts', 'src/main/notices.ts', 'src/main/progressService.ts', 'src/main/mergeSlots.ts'], suites: ['viewer'] },
  // The developer console (#636): capture, its rings and redaction, the agents' reads and the hive tool's replies.
  { paths: ['src/main/devConsole.ts', 'src/main/devConsoleSources.ts', 'src/main/devConsoleWords.ts', 'src/shared/devConsole.ts', 'tests/e2e/devconsole.cjs', 'src/main/mergeSlotHost.ts', 'src/main/watches.ts', 'src/main/sessions.ts', 'src/main/servers.ts'], suites: ['devconsole', 'replysize'] },
  { paths: ['src/main/consoleWindow.ts', 'src/renderer/src/ConsoleApp.tsx', 'src/renderer/src/styles/console.css', 'src/renderer/src/main.tsx', 'src/shared/consoleView.ts', 'src/shared/devConsole.ts', 'src/main/devConsole.ts', 'src/main/devConsoleSources.ts', 'src/renderer/src/components/TitleBar.tsx', 'tests/e2e/consolewindow.cjs'], suites: ['consolewindow'] },
  { paths: ['src/main/consoleRecorder.ts', 'src/shared/consoleFixtures.mts', 'src/shared/devConsole.ts', 'src/main/devConsole.ts', 'src/main/providers/copilot/adapter.ts', 'src/main/providers/copilot/events.ts', 'src/main/screenRecognition.ts', 'tests/fixtures/console/copilot.json', 'scripts/consoleFixture.mjs', 'tests/e2e/contract-copilot.cjs'], suites: ['contract-copilot', 'devconsole'] },
  { paths: ['src/main/consoleRecorder.ts', 'src/main/diagnostics.ts'], suites: ['consolewindow'] },
  // Developer console: show text (#699): the advanced setting, what main sends the window, the banner.
  { paths: ['src/main/consoleWindow.ts', 'src/renderer/src/ConsoleApp.tsx', 'src/renderer/src/styles/console.css', 'src/shared/devConsole.ts', 'src/main/devConsole.ts', 'src/main/ipc.ts', 'src/shared/advanced.ts', 'src/main/advanced.ts', 'src/shared/redact.ts', 'tests/e2e/consoletext.cjs'], suites: ['consoletext'] },
  // The developer console's flight recorder (#698): its triggers, captures and notices.
  { paths: ['src/main/flightRecorder.ts', 'src/shared/flightRecorder.ts', 'src/main/consoleRecorder.ts', 'tests/e2e/flightrecorder.cjs'], suites: ['flightrecorder'] },
  // Advanced settings (#367): the list, advanced.json, the workspace's own values, and what uses them (the hive MCP server's waits).
  { paths: ['src/main/advanced.ts', 'src/shared/advanced.ts', 'src/renderer/src/advanced.ts', 'src/renderer/src/components/AdvancedSettings.tsx', 'src/main/diagnostics.ts', 'src/shared/settingsCatalog.ts', 'tests/fixtures/advanced/', 'tests/e2e/advanced.cjs'], suites: ['advanced'] },
  { paths: ['src/main/advanced.ts'], suites: ['replysize', 'assistantsettings'] },
  { paths: ['src/main/journal.ts', 'src/main/journalService.ts', 'src/main/walCheckpoint.ts', 'src/main/walCheckpointWorker.ts','src/shared/journal.ts', 'src/renderer/src/components/JournalSettings.tsx', 'tests/e2e/journal.cjs'], suites: ['journal', 'replysize'] },
  { paths: ['src/main/startView.ts', 'src/shared/startView.ts'], suites: ['journal', 'assistantcompact', 'assistantresume'] },
  // Builds recorded as facts (#1534): the scripts' side, Hive's route and markers, the Advanced switch.
  { paths: ['scripts/buildFact.mjs', 'src/main/buildFacts.ts', 'src/shared/buildFacts.ts', 'src/renderer/src/components/journalBuilds.ts', 'src/main/journalService.ts', 'src/shared/advanced.ts', 'tests/e2e/buildfacts.cjs'], suites: ['buildfacts'] },
  // The journal browser (#1033): the store's browse and forget, its IPC, the Assistant view's Journal.
  { paths: ['src/main/journal.ts', 'src/main/journalService.ts', 'src/shared/journal.ts', 'src/renderer/src/components/JournalView.tsx', 'src/renderer/src/components/journalBuilds.ts', 'src/renderer/src/components/AssistantView.tsx', 'tests/e2e/journalbrowse.cjs'], suites: ['journalbrowse'] },
  // Disable hardware acceleration (#676): the early read, the restart offer, the terminals' renderer, diagnostics.
  { paths: ['src/main/gpu.ts', 'src/shared/advanced.ts', 'src/main/advanced.ts', 'src/renderer/src/components/AdvancedSettings.tsx', 'src/renderer/src/components/TerminalView.tsx', 'src/main/diagnostics.ts', 'tests/e2e/hwaccel.cjs'], suites: ['hwaccel'] },
  { paths: ['src/main/agentTokens.ts'], suites: ['boardscope', 'review', 'progress', 'progressreport', 'cardloop', 'replysize', 'hivetools'] },
  { paths: ['src/main/assistantControl.ts', 'src/main/assistantChanges.ts', 'src/main/assistantUndo.ts', 'src/shared/assistantActivity.ts', 'src/main/activityTargets.ts', 'src/main/taskBatch.ts', 'src/shared/assistant.ts', 'src/shared/assistantStatus.ts', 'src/shared/assistantTools.ts', 'src/main/modes.ts', 'src/renderer/src/components/Assistant.tsx', 'src/renderer/src/components/AssistantChanges.tsx', 'src/renderer/src/assistantUndo.ts', 'src/shared/assistantChangeList.ts', 'src/renderer/src/components/AssistantMark.tsx', 'src/renderer/src/components/AssistantView.tsx', 'src/renderer/src/components/Modes.tsx', 'src/shared/modeDescriptions.ts'], suites: ['assistantside', 'assistant', 'assistant-control', 'assistantend', 'assistantimages', 'tipcorner', 'replysize', 'claude-real', 'assistantoverview', 'assistantbatch', 'assistantcompact', 'assistantsettings', 'assistantmode', 'cardchip', 'assistantpanel', 'assistantundo'] },
  { paths: ['src/main/installDir.ts'], suites: ['installdir'] },
  { paths: ['src/main/benchmarks.ts', 'src/shared/benchmark.ts', 'src/renderer/src/views/PerformanceCompare.tsx'], suites: ['perfcompare'] },
  // Cost per card and per lane (#602): the holds, the minutes the parsers give, the card's line, the lane's hover, Performance's Cards.
  { paths: ['src/main/cardCosts.ts', 'src/shared/cardCosts.ts', 'src/shared/usageTimeline.ts', 'src/renderer/src/components/CardCost.tsx', 'src/renderer/src/views/PerformanceCards.tsx', 'src/main/providers/claude/usage.ts', 'src/main/providers/codex/rollout.ts', 'src/main/providers/copilot/events.ts'], suites: ['cardcost', 'unpricedcost', 'overview'] },
  { paths: ['src/main/metrics.ts', 'src/main/metricsUsage.ts', 'src/shared/metrics.ts', 'src/shared/metricsView.ts', 'src/renderer/src/views/Performance.tsx'], suites: ['performance', 'perfcompare', 'bridgereport', 'perftable', 'cardcost'] },
  { paths: ['src/main/branchWatch.ts', 'src/main/git.ts', 'src/main/worktrees.ts'], suites: ['unmerged', 'agents', 'changes', 'paneheader', 'claude-real', 'wsmove', 'wtrecreate', 'removeall', 'gitmissing', 'unusedwt', 'changespicker', 'gitview'] },
  // git.ts's processes, started off main's thread (HI-1783): git.ts's suites.
  { paths: ['src/main/gitWorker.ts'], suites: ['unmerged', 'agents', 'changes', 'paneheader', 'claude-real', 'wsmove', 'wtrecreate', 'removeall', 'gitmissing', 'unusedwt', 'changespicker', 'gitview'] },
  // Git missing or too old (#346): Agent Setup's Git row, the status bar and every git-dependent screen.
  { paths: ['src/main/gitTool.ts', 'src/shared/gitTool.ts'], suites: ['gitmissing', 'providers'] },
  // The Git view (#607): the Git tab's sections and the status bar's item.
  { paths: ['src/main/gitRepo.ts', 'src/shared/gitRepo.ts', 'src/shared/branchCleanup.ts', 'src/renderer/src/views/GitTab.tsx', 'src/renderer/src/views/GitBranches.tsx', 'src/renderer/src/gitReads.ts'], suites: ['gitbranchcards', 'gitcleanup', 'gitupdate', 'gitview', 'gitremotes', 'changes', 'changespicker', 'gitmissing', 'unusedwt', 'inbox', 'gitinit', 'versioncontrol', 'mergedialogslots'] },
  { paths: ['src/renderer/src/views/VersionControl.tsx', 'src/renderer/src/views/VersionControlHeader.tsx'], suites: ['versioncontrol', 'vcswitch', 'gitview', 'gitinit', 'changes', 'queuecard', 'workflowoptions'] },
  // "How do you work?" (#1423): the step, its notice, the answer and the adoption on a board made by 1.0.
  { paths: ['src/renderer/src/components/PresetStep.tsx', 'src/shared/workflow/presetStep.ts', 'src/main/workflow/presetStep.ts', 'src/main/workflow/adoption.ts'], suites: ['presetstep', 'vcswitch', 'workflowoptions'] },
  // Switching the version control (#1419): the switch, detection's offers, the shared rules.
  { paths: ['src/main/workflow/platformSwitch.ts', 'src/main/platform/registry.ts', 'src/shared/platform/switching.ts', 'src/shared/workflow/projectWorkflow.ts'], suites: ['vcswitch', 'versioncontrol', 'workflowoptions'] },
  { paths: ['src/main/gitInit.ts', 'src/shared/gitInit.ts', 'src/renderer/src/components/InitRepo.tsx'], suites: ['gitinit', 'gitview'] },
  { paths: ['src/main/freshPath.ts', 'src/main/externalTerminal.ts'], suites: ['freshpath', 'gitmissing', 'providers'] },
  // The providers' version checks' GET (#1582): the test copies turn the checks off, so these drive its callers only.
  { paths: ['src/main/plainHttpsJson.ts'], suites: ['providers', 'providerdetect', 'setupcopy', 'setuplayout'] },
  { paths: ['src/main/testedClis.ts', 'src/shared/testedClis.ts', 'resources/tested-clis.json', 'scripts/testedClis.mjs', 'scripts/tested-clis.mjs', 'scripts/release.mjs'], suites: ['testedclis'] },
  // Unused worktrees (#353): the Overview's section, the Changes notice, Storage's line and the hints.
  { paths: ['src/main/unusedWorktrees.ts', 'src/shared/unusedWorktrees.ts', 'src/shared/recentCache.ts', 'src/renderer/src/components/UnusedWorktrees.tsx'], suites: ['unusedwt', 'unusedslots', 'changespicker'] },
  { paths: ['tests/e2e/unusedslots.cjs'], suites: ['unusedslots'] },
  { paths: ['src/main/branchMerge.ts', 'src/renderer/src/components/BranchMerge.tsx', 'tests/e2e/mergedialogslots.cjs'], suites: ['mergedialogslots'] },
  { paths: ['src/renderer/src/mergeChoice.ts'], suites: ['mergedialogslots', 'agents-ui'] },
  { paths: ['src/main/workspaceMove.ts', 'src/shared/movePaths.ts', 'src/renderer/src/components/MoveRepair.tsx', 'src/main/agentWorktree.ts', 'src/shared/projectIds.ts', 'src/main/beforeIds.ts', 'src/main/leftovers.ts', 'src/main/projectRename.ts', 'src/main/projectNames.ts'], suites: ['wsmove', 'wtrecreate', 'projectrename', 'repairbranches', 'repairdefender'] },
  { paths: ['src/main/bundled.ts', 'src/main/bundledHistory.json', 'src/main/skills.ts', 'src/main/revisions.ts', 'src/renderer/src/components/Skills.tsx', 'src/shared/skillDescriptions.ts'], suites: ['skills', 'skillaudience', 'skilldelivery'] },
  { paths: ['src/main/guidance.ts', 'src/shared/hiveGuidance.ts', 'src/shared/toolReplies.ts', 'src/main/mcp/'], suites: ['skilldelivery', 'replysize', 'mcp', 'bridgereport', 'cardloop', 'slotguidance'] },
  // Hive's skill copies per folder and the skills delivered (#1431).
  { paths: ['src/main/skillCopies.ts', 'src/shared/skillDelivery.ts', 'src/main/providers/common.ts'], suites: ['skilldelivery', 'skills'] },
  { paths: ['src/main/workspaceNotes.ts', 'src/shared/workspaceNotes.ts', 'src/renderer/src/components/WorkspaceNotes.tsx', 'src/main/providers/claude/adapter.ts', 'src/main/providers/codex/adapter.ts', 'src/main/providers/copilot/adapter.ts'], suites: ['workspacenotes'] },
  { paths: ['src/main/cardSessions.ts', 'src/renderer/src/components/CardChip.tsx'], suites: ['cardchip', 'sessionorigin'] },
  { paths: ['src/main/cardAttachments.ts', 'src/shared/cardAttachments.ts', 'src/renderer/src/components/CardAttachments.tsx', 'src/renderer/src/cardAttachLinks.ts', 'src/main/attachmentsFolder.ts', 'tests/e2e/cardattach.cjs'], suites: ['cardattach', 'storage', 'files', 'carddialog', 'attachread'] },
  // A card's attachment read through Hive (HI-1751).
  { paths: ['tests/e2e/attachread.cjs'], suites: ['attachread'] },
  // Accounts (HI-980): the store, its checks and watches, Settings → Accounts, and the fake's sign-in.
  { paths: ['src/main/accounts.ts', 'src/shared/accounts.ts', 'src/renderer/src/components/AccountsSettings.tsx', 'tests/e2e/accounts.cjs'], suites: ['accounts', 'connections', 'connections-codex', 'connections-server'] },
  // Server connections (HI-1772): the key store and its masking, the server's form, models and launch variables.
  { paths: ['src/main/serverConnections.ts', 'src/main/keyStore.ts', 'src/main/keyMatcher.ts', 'src/main/keyCoverage.ts', 'src/shared/serverConnection.ts', 'src/renderer/src/components/ServerConnections.tsx', 'tests/e2e/connections-server.cjs'], suites: ['connections-server'] },
  // Launching on a connection (HI-1755): the launch step, the switch at a safe point, the seam, the Connection choice.
  { paths: ['src/main/connectionSeam.ts', 'src/main/connectionSwitch.ts', 'src/renderer/src/components/ConnectionChoice.tsx', 'tests/e2e/connections.cjs'], suites: ['connections', 'connectionrows', 'connections-codex'] },
  { paths: ['tests/e2e/connections-codex.cjs', 'tests/e2e/fake-codex/', 'src/main/providers/codex/', 'src/shared/codex.ts'], suites: ['connections-codex'] },
  // Plan usage per connection, the status bar's and Overview's (HI-1756).
  { paths: ['src/main/planUsage.ts', 'src/renderer/src/connectionUsage.ts', 'tests/e2e/connectionusage.cjs'], suites: ['connectionusage', 'planusage'] },
  // The Agent API and connections (HI-1771): references, visibility, the agent routes' connection, the status.
  { paths: ['src/main/servers.ts', 'src/main/mcp/hive-mcp.ts', 'tests/e2e/connectionapi.cjs'], suites: ['connectionapi'] },
  // Model, effort and context belong to the connection (HI-1770): the resolver, the move, the defaults and the notice.
  { paths: ['src/shared/connectionDefaults.ts', 'src/main/connectionMoves.ts', 'src/renderer/src/components/ConnectionDefaults.tsx', 'tests/e2e/connectiondefaults.cjs'], suites: ['connectiondefaults', 'connections', 'context'] },
  // The agent rows and templates name connections (HI-1769).
  { paths: ['src/shared/connectionLabel.ts', 'src/renderer/src/components/TemplatePlan.tsx', 'src/renderer/src/components/TemplateLoad.tsx', 'tests/e2e/connectionrows.cjs'], suites: ['connectionrows', 'templates', 'templatesv2'] },
  { paths: ['src/shared/activity.ts', 'src/renderer/src/views/ActivityTab.tsx', 'src/renderer/src/activityView.ts', 'src/main/agentProcesses.ts'], suites: ['activitytab'] },
  { paths: ['src/main/compaction.ts'], suites: ['compact', 'overview', 'paneheader', 'idlestatus'] },
  { paths: ['src/shared/safeguards.ts', 'src/main/providers/claude/safeguards.ts', 'src/main/providers/codex/safeguards.ts', 'src/main/cardSessions.ts'], suites: ['safeguards'] },
  { paths: ['src/main/diagnostics.ts', 'src/shared/redact.ts'], suites: ['about', 'testedclis'] },
  { paths: ['src/main/files.ts', 'src/renderer/src/views/FilesTab.tsx', 'src/renderer/src/components/FileView.tsx', 'src/renderer/src/components/DocEditor.tsx', 'src/renderer/src/components/Editors.tsx', 'src/renderer/src/editorDrafts.ts', 'src/renderer/src/monaco.ts', 'src/renderer/src/monacoLang.ts'], suites: ['files', 'editor', 'drafts', 'unsaved', 'icons', 'image', 'assistantimages', 'asarfiles'] },
  { paths: ['src/main/attachmentsFolder.ts', 'src/shared/attachments.ts', 'src/renderer/src/attach.ts', 'src/renderer/src/components/AttachmentChips.tsx'], suites: ['image', 'files', 'assistantimages', 'storage', 'storageclose', 'dialogs', 'asarfiles', 'codex-extra'] },
  { paths: ['src/main/hookStatus.ts', 'src/main/terminalTitle.ts', 'src/shared/terminalInput.ts'], suites: ['background', 'attention', 'mode', 'busy', 'codex', 'codex-background', 'signin', 'idlestatus', 'turnledger', 'safeguards'] },
  // The turn ledger (#648): status by the CLIs' turn ids, reconciliation, the unknown state and Mark idle.
  { paths: ['src/main/turnLedger.ts', 'src/shared/runtime.ts'], suites: ['turnledger', 'idlestatus', 'background', 'attention', 'signin', 'lanewatch', 'replysize', 'hookshealth'] },
  // Hooks health (#1336): an agent whose hooks stop arriving shows as unknown, takes no lines, and pauses its lane.
  { paths: ['src/main/hooksHealth.ts', 'src/main/readiness.ts'], suites: ['hookshealth', 'hookstranscript', 'turnledger', 'idlestatus'] },
  { paths: ['src/main/turnsReader.ts', 'src/main/providers/turns.ts', 'src/main/providers/claude/turns.ts', 'src/main/providers/codex/turns.ts', 'src/main/providers/copilot/turns.ts', 'tests/e2e/hookstranscript.cjs', 'tests/e2e/hookscopilot.cjs'], suites: ['hookstranscript', 'hookscopilot', 'hookshealth'] },
  // The rendered screen Hive reads Claude Code's footer (the live permission mode) from.
  { paths: ['src/main/terminalScreen.ts'], suites: ['mode', 'assistant', 'wakepaste'] },
  // The footer's mode read from that screen, by Claude Code's and Copilot's per-mode patterns (#696).
  { paths: ['src/shared/footerModes.ts'], suites: ['mode', 'copilot', 'advanced'] },
  { paths: ['src/main/mcp.ts', 'src/main/mcpSecrets.ts'], suites: ['drafts', 'mcp', 'mcpagents', 'mcpfile'] },
  // Per-agent MCP servers (#537): the agent's choice, its launch, the dialogs and the MCP tab.
  { paths: ['src/shared/agentMcp.ts'], suites: ['mcpagents', 'mcpfile', 'templates'] },
  // The MCP workspace switch's project picker (#1093): its enable dialog.
  { paths: ['src/renderer/src/components/McpProjectPicker.tsx'], suites: ['mcpfile', 'mcpagents', 'mcp'] },
  { paths: ['src/main/notes.ts'], suites: ['drafts', 'codex-handover'] },
  { paths: ['src/main/planUsage.ts', 'src/renderer/src/components/ModelPicker.tsx', 'src/shared/claude.ts', 'src/shared/codex.ts', 'src/shared/prices.ts'], suites: ['plan', 'planusage', 'providers', 'codex-setup', 'context', 'unpricedcost', 'models'] },
  // Models and capabilities from the CLIs, and their fallbacks (#125).
  { paths: ['src/shared/models.ts', 'tests/fixtures/claude-initialize.json', 'tests/fixtures/codex-debug-models.json'], suites: ['models', 'assistant', 'footerfit', 'agents-ui', 'automode'] },
  { paths: ['src/main/power.ts', 'src/shared/keepAwake.ts'], suites: ['quitwait', 'quit'] },
  { paths: ['src/main/progress.ts', 'src/main/progressService.ts', 'src/shared/progress.ts', 'src/renderer/src/components/Progress.tsx', 'src/renderer/src/components/ShowAllList.tsx', 'src/shared/progressTabs.ts', 'tests/e2e/progresstabs.cjs'], suites: ['progress', 'progressgates', 'progresslanes', 'progressreport', 'progressstates', 'progresstabs', 'replysize'] },
  { paths: ['src/renderer/src/components/ProgressLanes.tsx', 'src/renderer/src/components/ProgressMerge.tsx', 'src/renderer/src/laneSource.ts', 'src/shared/laneBar.ts', 'tests/e2e/progressgates.cjs'], suites: ['agentstable', 'lanestages', 'lanestart', 'progressgates', 'progresslanes', 'cardcost'] },
  // Branches next to their cards (#1424).
  { paths: ['src/shared/branchCards.ts', 'tests/e2e/gitbranchcards.cjs'], suites: ['gitbranchcards'] },
  // The Progress panel's stages, legend, Solo's lanes, links and old rules marks (#1421).
  { paths: ['tests/e2e/lanesslots.cjs', 'src/renderer/src/components/ProgressLanes.tsx', 'src/renderer/src/laneSource.ts', 'src/shared/laneBar.ts', 'src/shared/lanes.ts', 'src/main/lanes.ts', 'src/main/slotCards.ts', 'src/shared/progressTabs.ts', 'src/renderer/src/components/Progress.tsx'], suites: ['lanesslots'] },
  { paths: ['src/shared/laneStages.ts', 'src/renderer/src/projectStages.ts', 'tests/e2e/lanestages.cjs'], suites: ['lanestages', 'progresslanes'] },
  { paths: ['tests/e2e/laneend.cjs', 'tests/e2e/cliquit.cjs', 'src/main/slotsApp.ts', 'src/main/sessions.ts', 'src/main/deliveries.ts', 'src/main/providers/claude/adapter.ts', 'src/main/providers/codex/adapter.ts'], suites: ['laneend', 'slotsessions', 'cliquit'] },
  { paths: ['src/main/laneStart.ts', 'src/shared/laneBrief.ts', 'src/renderer/src/components/LaneStartDialog.tsx', 'tests/e2e/lanestart.cjs'], suites: ['agentrole', 'lanestart'] },
  // A lane's brief (HI-1795): given with its cards' placements in slots, delivered outside them.
  { paths: ['src/main/laneBriefs.ts', 'tests/e2e/lanebrief.cjs'], suites: ['lanebrief', 'slotrecovery'] },
  // The shared list's other user: the Assistant's "Done by the Assistant" (#312).
  { paths: ['src/renderer/src/components/ShowAllList.tsx'], suites: ['assistantpanel', 'assistantundo'] },
  { paths: ['src/main/progressReporters/'], suites: ['progressreport', 'progressstates', 'packaged-progress'] },
  { paths: ['src/main/projectAgents.ts'], suites: ['agents', 'agents-ui', 'agents24', 'reorder', 'pages', 'unmerged', 'removeall', 'mergeslot', 'placement', 'swap', 'repolock'] },
  { paths: ['src/main/repoLock.ts', 'src/main/repoLockCore.ts', 'src/main/repoLockWorker.ts', 'tests/e2e/repolock.cjs'], suites: ['repolock', 'repolocktyping', 'gitview', 'mergeslot'] },
  { paths: ['src/main/workflow/queueHost.ts', 'src/main/workflow/mergeQueue.ts', 'src/main/workflow/mergeMessage.ts', 'src/main/workflow/queueRunner.ts', 'src/main/workflow/queueJobs.ts', 'src/main/workflow/queueChecks.ts', 'src/main/workflow/queueChecksApp.ts', 'src/main/repoLock.ts', 'tests/e2e/queueFixture.cjs', 'tests/e2e/mergequeue.cjs'], suites: ['mergequeue', 'queueagents', 'queueupgrade'] },
  // Agents under Hive merges (#1354): the refusals, the wakes and the card's queue state.
  { paths: ['src/main/workflow/queueState.ts', 'src/shared/workflow/refusals.ts', 'src/main/mergeSlots.ts', 'tests/e2e/queueagents.cjs'], suites: ['queueagents'] },
  // The queue's controls (#1353): its model, Pause/Resume, Remove from queue and Retry merge, hive_queue.
  { paths: ['src/main/workflow/mergeQueue.ts', 'src/main/workflow/queueHost.ts', 'src/main/workflow/queueControls.ts', 'src/main/folderFence.ts', 'src/shared/workflow/facts.ts', 'tests/e2e/queueFixture.cjs', 'tests/e2e/mergequeuefolder.cjs', 'tests/e2e/mergequeuecrash.cjs'], suites: ['mergequeuecrash', 'mergequeuefolder'] },
  { paths: ['src/main/workflow/mergeQueue.ts', 'src/shared/workflow/options.ts', 'src/shared/workflow/optionTexts.ts', 'src/renderer/src/components/WorkflowOptions.tsx', 'tests/e2e/queueFixture.cjs', 'tests/e2e/mergestrict.cjs'], suites: ['mergestrict', 'workflowoptions'] },
  { paths: ['src/main/workflow/queueControls.ts', 'src/shared/workflow/queue.ts', 'src/main/workflow/mergeQueue.ts', 'src/main/workflow/queueHost.ts', 'src/main/cardIntents.ts', 'tests/e2e/queueFixture.cjs', 'tests/e2e/queuecontrols.cjs'], suites: ['queuecontrols', 'replysize'] },
  // The queue on the card, in the Git tab and in the Merge dialog (#1357).
  { paths: ['src/renderer/src/components/CardQueue.tsx', 'src/renderer/src/components/GitQueueSection.tsx', 'src/renderer/src/components/CardWork.tsx', 'src/renderer/src/components/ForYou.tsx', 'src/renderer/src/components/AgentDialogs.tsx', 'src/shared/workflow/workView.ts', 'src/main/workflow/queueControls.ts', 'src/shared/workflow/queue.ts', 'tests/e2e/queueFixture.cjs', 'tests/e2e/queuecard.cjs'], suites: ['queuecard'] },
  // The queue in the Progress panel (#1356): its cards, Pulse's line, the badge, the announcements, Hive's runs in Runs.
  { paths: ['src/shared/progressQueue.ts', 'src/renderer/src/components/ProgressQueue.tsx', 'src/renderer/src/queueSource.ts', 'src/renderer/src/components/Progress.tsx', 'src/renderer/src/components/ProgressMerge.tsx', 'src/shared/progressTabs.ts', 'src/main/workflow/queueControls.ts', 'src/shared/workflow/queue.ts', 'tests/e2e/queueFixture.cjs', 'tests/e2e/progressqueue.cjs'], suites: ['progressqueue', 'progresstabs'] },
  { paths: ['src/main/mergeSlots.ts', 'src/main/mergeSlotHost.ts', 'src/shared/mergeSlot.ts', 'src/renderer/src/components/MergeSlots.tsx'], suites: ['mergeslot', 'progresslanes', 'replysize'] },
  // Lanes (#483): the card loop registers its lane; replysize measures hive_lane; the Progress panel shows them (#484).
  { paths: ['src/main/lanes.ts', 'src/shared/lanes.ts', 'src/main/workflow/lineUpdates.ts'], suites: ['cardloop', 'lanestages', 'progresslanes', 'replysize'] },
  // P5's acceptance (#1358): S55's lane, the scenarios first proven in the app, one queue runner across Hives.
  { paths: ['tests/e2e/p5lane.cjs', 'tests/e2e/queueFixture.cjs', 'src/main/workflow/mergeQueue.ts', 'src/main/workflow/queueHost.ts', 'src/main/workflow/lineUpdates.ts', 'src/main/laneStart.ts', 'src/main/workflow/optionsForm.ts'], suites: ['p5lane'] },
  // P6's acceptance (#1425): a project from added to Done through the Version Control tab, Solo, all off, S19 and S20.
  { paths: ['tests/e2e/p6lane.cjs', 'tests/e2e/queueFixture.cjs', 'src/main/workflow/presetStep.ts', 'src/renderer/src/components/PresetStep.tsx', 'src/main/workflow/platformSwitch.ts', 'src/renderer/src/boardStages.ts', 'src/main/laneStart.ts', 'src/main/workflow/optionsForm.ts'], suites: ['p6lane'] },
  // P7's acceptance (#1448): Team 6×6 on slots with review copies, two lanes, S42, S43, the pool, Resume All and restart.
  { paths: ['tests/e2e/p7lane.cjs', 'tests/e2e/queueFixture.cjs', 'src/main/laneStart.ts', 'src/main/slots.ts', 'src/main/slotsApp.ts', 'src/main/slotCards.ts', 'src/main/copies.ts', 'src/main/copiesApp.ts', 'src/main/reviewCopies.ts', 'src/main/agentFolders.ts'], suites: ['p7lane'] },
  { paths: ['tests/e2e/p6rules.cjs', 'tests/e2e/queueFixture.cjs', 'src/shared/workflow/guards.ts', 'src/shared/workflow/compile.ts', 'src/main/workflow/runtime.ts', 'src/main/workflow/mergeQueue.ts', 'src/main/platform/nonePlatform.ts'], suites: ['p6rules'] },
  { paths: ['tests/e2e/p5scenarios.cjs', 'tests/e2e/queueFixture.cjs', 'src/main/workflow/mergeQueue.ts', 'src/main/workflow/queueChecks.ts', 'src/main/workflow/queueChecksApp.ts', 'src/shared/progressQueue.ts'], suites: ['p5scenarios'] },
  { paths: ['tests/e2e/queuelease.cjs', 'tests/e2e/queueFixture.cjs', 'src/main/workflow/queueRunner.ts', 'src/main/workflow/queueJobs.ts', 'src/main/workflow/queueHost.ts'], suites: ['queuelease'] },
  { paths: ['tests/e2e/reviewcopies.cjs', 'src/main/reviewCopies.ts', 'src/main/copies.ts', 'src/main/copiesApp.ts'], suites: ['reviewcopies'] },
  { paths: ['tests/e2e/reviewcopiesreal.cjs'], suites: ['reviewcopiesreal'] },
  { paths: ['tests/e2e/reviewerpool.cjs', 'src/main/reviewerPool.ts', 'src/shared/workflow/reviewerPool.ts', 'src/main/laneStart.ts', 'src/shared/laneBrief.ts', 'src/renderer/src/components/LaneStartDialog.tsx', 'src/main/loopReviewer.ts'], suites: ['reviewerpool'] },
  { paths: ['tests/e2e/isolatedcheck.cjs', 'src/main/copies.ts', 'src/main/copiesApp.ts', 'src/main/workflow/launcher.ts', 'src/main/progressReporters/wrapper.ts', 'src/main/progressReporters/report.mts', 'src/main/workflow/runLink.ts', 'src/main/workflow/runChecks.ts'], suites: ['isolatedcheck', 'progressreport'] },
  { paths: ['tests/e2e/slotcards.cjs', 'tests/e2e/slotrecovery.cjs', 'src/main/slotCards.ts', 'src/main/laneStart.ts', 'src/main/platform/gitPlatform.ts', 'src/main/workflow/service.ts'], suites: ['slotcards', 'slotrecovery', 'lanestart'] },
  { paths: ['tests/e2e/slotpool.cjs', 'src/main/slots.ts', 'src/main/slotsApp.ts', 'src/main/slotJobs.ts', 'src/main/workflow/queueJobs.ts', 'src/main/workflow/queueChecks.ts'], suites: ['slotpool', 'slotsessions'] },
  // P7's switches and slot options set in the window and acting in the app (#1563).
  { paths: ['tests/e2e/p7settings.cjs', 'src/shared/advanced.ts', 'src/renderer/src/components/AdvancedSettings.tsx', 'src/renderer/src/views/ProjectTabs.tsx'], suites: ['p7settings'] },
  { paths: ['tests/e2e/slotscripts.cjs', 'tests/e2e/queueFixture.cjs', 'src/main/slots.ts', 'src/main/slotsApp.ts', 'src/main/slotSettings.ts', 'src/main/worktrees.ts'], suites: ['slotscripts'] },
  { paths: ['tests/e2e/slotswitches.cjs', 'src/main/slotCards.ts', 'src/main/slots.ts', 'src/main/laneStart.ts'], suites: ['slotswitches'] },
  { paths: ['tests/e2e/copyquiet.cjs', 'src/main/copies.ts', 'src/main/copiesApp.ts', 'src/main/reviewCopies.ts'], suites: ['copyquiet'] },
  { paths: ['tests/e2e/startfresh.cjs', 'src/main/freshStarts.ts', 'src/shared/freshStarts.ts', 'src/renderer/src/components/NoticeBanners.tsx'], suites: ['startfresh'] },
  { paths: ['tests/e2e/repairslots.cjs', 'tests/e2e/removeprojectslots.cjs', 'src/main/projectFolders.ts', 'src/shared/projectFolders.ts', 'src/main/projectRemoval.ts', 'src/renderer/src/components/MoveRepair.tsx', 'src/renderer/src/components/ProjectRemoval.tsx', 'src/main/agentWorktree.ts'], suites: ['repairslots', 'removeprojectslots', 'wsmove', 'wtrecreate', 'repairbranches'] },
  { paths: ['tests/e2e/queueupgrade.cjs'], suites: ['queueupgrade'] },
  { paths: ['src/shared/atMost.ts'], suites: ['sessionsize', 'slotsessions', 'skilldelivery', 'skills'] },
  { paths: ['src/main/openProgress.ts', 'src/renderer/src/components/WorkspaceOpening.tsx', 'tests/e2e/openguard.cjs', 'tests/e2e/openspeed.cjs'], suites: ['openguard', 'openspeed', 'queueupgrade'] },
  { paths: ['tests/e2e/slotupgrade.cjs', 'src/main/slotMigration.ts', 'src/main/workspaceMove.ts'], suites: ['slotupgrade', 'wsmove', 'repairbranches'] },
  { paths: ['tests/e2e/slotsessions.cjs', 'src/main/agentFolders.ts', 'src/shared/agentFolders.ts', 'src/shared/sessionResume.ts', 'src/shared/resumeAll.ts', 'src/main/sessions.ts'], suites: ['slotsessions', 'legacyworktree'] },
  { paths: ['tests/e2e/legacyworktree.cjs', 'src/main/agentWorktree.ts'], suites: ['legacyworktree', 'slotupgrade'] },
  { paths: ['tests/e2e/slotrelease.cjs', 'src/main/agentFolders.ts', 'src/renderer/src/components/SlotsAndCopies.tsx'], suites: ['slotrelease'] },
  { paths: ['tests/e2e/slotreleaseapi.cjs', 'src/main/slotRelease.ts', 'src/main/agentFolders.ts', 'src/main/slotMigration.ts'], suites: ['slotreleaseapi'] },
  // The Agent API's agents on slots (#1451): where each is, and adding none in a worktree.
  { paths: ['tests/e2e/agentapislots.cjs', 'src/main/agentFolders.ts', 'src/shared/agentFolders.ts', 'src/main/projectAgents.ts', 'src/main/mcp/hive-mcp.ts'], suites: ['agentapislots', 'replysize'] },
  { paths: ['tests/e2e/p4lane.cjs','src/main/workflow/lineUpdates.ts', 'src/main/workflow/runtime.ts', 'src/main/cardIntents.ts', 'src/main/laneStart.ts', 'src/main/workflow/optionsForm.ts'], suites: ['p4lane'] },
  // §16.19.2's continuation on a lane carried over the upgrade on a 0.9 worktree (#1579).
  { paths: ['tests/e2e/linecarried.cjs', 'src/main/workflow/lineUpdates.ts', 'src/main/worktrees.ts', 'src/main/laneStart.ts'], suites: ['linecarried'] },
  // The workspace database's small stores (#1018): lanes, card watches and deliveries.
  { paths: ['src/main/storeRows.ts'], suites: ['progresslanes', 'cardloop', 'deliveries', 'agentmessage', 'inbox', 'lanewatch', 'agentwatch', 'loopwatch', 'watchrelease', 'unexpectedclose'] },
  { paths: ['src/main/projectKeys.ts', 'src/main/schema/keysStep.ts', 'src/shared/projectKeys.ts', 'tests/e2e/projectkeys.cjs'], suites: ['projectkeys', 'keysui', 'replysize', 'hivetools', 'cardloop', 'boardupgrade'] },
  { paths: ['src/renderer/src/components/CardWork.tsx', 'src/renderer/src/cardWork.ts', 'src/shared/workflow/workView.ts', 'src/main/workflow/cardWork.ts', 'tests/e2e/cardwork.cjs'], suites: ['cardwork', 'board', 'carddialog', 'progressgates', 'progresslanes'] },
  { paths: ['src/renderer/src/projectKeys.ts', 'src/shared/cardLinks.ts', 'src/renderer/src/cardLinks.ts', 'tests/e2e/keysui.cjs'], suites: ['keysui', 'cardlinks', 'board', 'boardarchive', 'cardchip', 'progresslanes', 'rail'] },
  { paths: ['src/main/storeTables.ts', 'src/main/storeBackup.ts', 'src/main/schema/storeCodec.ts'], suites: ['progresslanes', 'cardloop', 'lanewatch', 'agentwatch', 'loopwatch', 'watchrelease', 'performance'] },
  { paths: ['src/main/projectRemoval.ts', 'src/renderer/src/components/ProjectRemoval.tsx'], suites: ['board', 'storage'] },
  // Hive's one way to the Recycle Bin (a test copy's trash folder, #414): the suites that delete something.
  { paths: ['src/main/trash.ts'], suites: ['board', 'files', 'storage', 'sessiontree', 'templateshare', 'unusedwt', 'skills', 'transcript', 'unsaved', 'assistantimages'] },
  { paths: ['src/main/providerService.ts', 'src/main/taskKeys.ts'], suites: ['providers', 'codex-setup', 'startfail', 'models', 'testedclis', 'freshpath', 'providerdetect'] },
  { paths: ['src/main/keySteps.ts'], suites: ['codex', 'codex-setup'] },
  { paths: ['src/main/rendererWatch.ts'], suites: ['rendercrash', 'windowhealth'] },
  { paths: ['src/shared/windowHealth.ts', 'src/renderer/src/windowHealth.ts', 'src/renderer/src/pageMarks.ts'], suites: ['windowhealth'] },
  // Why Hive stopped (#985): crash dumps and a log line for every way out; the updater and install-folder checks end the app through it.
  // Hive closing unexpectedly (#984): the running marker, the notice, Resume All and the setting; a merge left half done is told in it.
  { paths: ['src/main/lastRun.ts', 'src/shared/unexpectedClose.ts', 'src/main/mergeSlotHost.ts', 'src/main/mergeSlots.ts', 'tests/e2e/unexpectedclose.cjs', 'tests/e2e/unexpectedclose-leftovers.cjs'], suites: ['unexpectedclose', 'unexpectedclose-leftovers', 'restartresume'] },
  { paths: ['src/main/restartResume.ts', 'src/shared/restartResume.ts', 'tests/e2e/restartresume.cjs'], suites: ['restartresume', 'unexpectedclose'] },
  // "The main process was busy" (#1109): sleep isn't a stall, and a stall names what was running.
  { paths: ['src/shared/projectView.ts', 'src/main/fileHolders.ts', 'tests/e2e/projectview.cjs'], suites: ['projectview', 'tilesview', 'placement', 'templates'] },
  { paths: ['src/main/mainStalls.ts', 'src/main/threadPool.ts', 'src/main/stallWatchdog.ts', 'tests/e2e/stalls.cjs'], suites: ['stalls'] },
  { paths: ['src/main/exitLog.ts', 'src/main/memory.ts', 'src/main/diagnostics.ts', 'src/main/updater.ts', 'src/main/installDir.ts'], suites: ['crashdumps'] },
  // .hive kept out of version control, and its notice (#345).
  { paths: ['src/main/hiveVcs.ts', 'src/shared/hiveVcsText.ts', 'src/renderer/src/components/HiveVcsNotice.tsx'], suites: ['hivevcs', 'gitinit'] },
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
  { paths: ['src/main/taskStart.ts', 'src/main/tasks.ts', 'src/main/boardStore.ts', 'src/main/db.ts', 'src/main/walCheckpoint.ts', 'src/main/walCheckpointWorker.ts','src/shared/tasks.ts', 'src/shared/taskHistory.ts', 'src/shared/boardCopy.ts', 'src/renderer/src/boardReads.ts', 'src/renderer/src/components/Board.tsx', 'src/shared/edgeScroll.ts', 'src/main/cardBusy.ts', 'src/main/decisionNotices.ts', 'src/main/decisionWakes.ts', 'src/renderer/src/boardBatches.ts', 'src/main/coalesce.ts', 'src/renderer/src/components/SetAside.tsx', 'src/main/presence.ts', 'src/renderer/src/components/BoardUpgrade.tsx', 'src/main/schema/', 'src/main/workflow/factStore.ts', 'src/main/workflow/actionWorker.ts', 'src/main/workflow/cardWork.ts', 'src/renderer/src/cardWork.ts', 'src/main/workflow/adoption.ts', 'src/main/workflow/upgrade.ts', 'src/main/workflow/recorder.ts', 'src/main/workflow/reconciler.ts', 'src/main/workflow/reconcile.ts'], suites: ['reconcile', 'projectrename', 'setaside', 'board', 'boardupgrade', 'upgradelane', 'boardarchive', 'boardbulk', 'boardfold', 'boardscope', 'boardscroll', 'review', 'donemove', 'doingmove', 'carddialog', 'cardchip', 'taskoverview', 'busy', 'dialogs', 'decisions', 'decisionwake', 'replysize', 'cardcost'] },
  { paths: ['src/main/watches.ts', 'src/shared/watch.ts', 'src/shared/agentWatch.ts', 'src/main/loopCheck.ts', 'src/main/intentWatch.ts'], suites: ['agentmessage', 'deliveries', 'agentwatch', 'cardloop', 'decisionwake', 'lanewatch', 'loopwakes', 'loopwatch', 'quitwait', 'replysize', 'replytell', 'wakepaste', 'wakeuntaken', 'watchrelease'] },
  { paths: ['src/renderer/src/components/watchLine.ts'], suites: ['agentstable', 'agentwatch', 'cardloop'] },
  // Lane watches (#531), and stalls as cards and lanes tell them.
  { paths: ['src/shared/laneWatch.ts', 'src/main/cardStall.ts'], suites: ['lanewatch', 'watchrelease', 'loopwatch', 'replysize'] },
  { paths: ['src/main/taskbar.ts', 'src/shared/taskbar.ts'], suites: ['taskbar', 'progress'] },
  { paths: ['src/main/titleBar.ts', 'src/shared/titleBar.ts'], suites: ['carddialog'] },
  // A window fitted to the display it opens on (#812).
  { paths: ['src/main/windowBounds.ts'], suites: ['tabstrip', 'windows', 'closewindow', 'resize'] },
  { paths: ['src/main/transcripts.ts', 'src/main/transcriptReads.ts', 'src/main/transcriptFiles.ts', 'src/renderer/src/views/SessionsTab.tsx', 'src/shared/sessionOrigin.ts', 'src/shared/sessionResume.ts', 'src/shared/sessionTree.ts'], suites: ['transcript', 'sessionorigin', 'sessionsize', 'sessiontree', 'sessioncleanup', 'loadfail', 'sessionname', 'packaged-transcript', 'purge', 'overview'] },
  // Compressed backups (#1110): resumed from, sized in Storage, read in another language.
  { paths: ['src/main/transcriptFiles.ts'], suites: ['resume', 'storage', 'i18nlive'] },
  // A memo card tile follows a change of language itself (HI-1806).
  { paths: ['src/renderer/src/components/Board.tsx'], suites: ['i18nlive'] },
  { paths: ['src/shared/sessionCleanup.ts', 'src/renderer/src/views/SessionCleanup.tsx'], suites: ['sessioncleanup', 'sessiontree'] },
  // Messages left for agents (#530).
  { paths: ['src/main/agentMessages.ts'], suites: ['agentmessage', 'deliveries', 'replysize'] },
  // Deliveries and hive_inbox (#647).
  // The delivery service, its writer and readiness (#647, #649): every way into an agent goes through them.
  { paths: ['src/main/deliveries.ts', 'src/shared/deliveries.ts', 'src/main/schema/sessionDeliveryTables.ts', 'src/main/schema/sessionDeliveryCodec.ts', 'src/main/lineWriter.ts', 'src/main/readiness.ts'], suites: ['deliveries', 'agentmessage', 'viewer', 'replysize', 'loopwakes', 'agentwatch', 'wakeuntaken', 'wakepaste', 'cardloop', 'decisionwake', 'loopwatch', 'lanewatch', 'assistantmode', 'assistant-control', 'signin', 'watchrelease', 'inboxnotices', 'hivetools', 'carryingon', 'codexqueued'] },
  { paths: ['src/main/inboxNotices.ts', 'src/shared/doorbell.ts', 'tests/e2e/fake-claude/fake-claude.cjs'], suites: ['inboxnotices', 'deliveries', 'agentmessage', 'turnledger', 'carryingon'] },
  { paths: ['src/shared/inboxSwitches.ts'], suites: ['carryingon', 'inboxnotices'] },
  // A long conversation's Hand Over (#1057): the notice, the footer, the dialog and the hand-over's own checks.
  { paths: ['src/main/handOverCheck.ts', 'src/shared/handOver.ts', 'src/main/sessions.ts', 'src/main/lanes.ts', 'src/renderer/src/components/AgentPanes.tsx', 'src/renderer/src/components/AgentDialogs.tsx'], suites: ['handovernotice', 'longsession', 'sessionsize'] },
  // Hive's loop wakes (#405).
  { paths: ['src/main/loopWakes.ts', 'src/main/lanes.ts', 'src/main/queueReturn.ts'], suites: ['loopwakes', 'lanenotices'] },
  // A card's loop reviewer (#1382): who loop wakes go to, and who answers a builder's design.
  { paths: ['src/main/loopReviewer.ts'], suites: ['loopwakes', 'intents'] },
  // Hive's own notices of the work (#1266): a card's request for the user, a lane's events without the Assistant.
  { paths: ['src/main/workflowNotices.ts', 'tests/e2e/lanenotices.cjs'], suites: ['lanenotices'] },
  { paths: ['src/main/reviewsOnOpen.ts'], suites: ['review', 'stopswitch', 'recent'] },
  { paths: ['src/renderer/src/components/Board.tsx', 'src/renderer/src/components/CardWork.tsx', 'src/renderer/src/components/Overlays.tsx', 'src/shared/laneBar.ts', 'src/main/tasks.ts', 'src/shared/workflow/workView.ts', 'tests/e2e/boardgates.cjs'], suites: ['boardgates'] },
  { paths: ['src/main/cardIntents.ts', 'tests/e2e/intents.cjs'], suites: ['intents', 'replysize'] },
  { paths: ['src/renderer/src/components/CardKind.tsx', 'src/renderer/src/components/CardReviewSkip.tsx', 'src/renderer/src/components/reviewSkipTip.ts', 'tests/e2e/nocode.cjs'], suites: ['nocode'] },
  { paths: ['src/renderer/src/components/ForYou.tsx', 'src/renderer/src/forYou.ts', 'src/renderer/src/sharedRead.ts', 'src/renderer/src/components/Shell.tsx', 'src/main/answerRelay.ts'], suites: ['foryou'] },
  // A request's or a decision's short plain form (#1635): For you's chip, the inbox's rows, a card's decision count.
  { paths: ['src/shared/gist.ts'], suites: ['foryou', 'inbox', 'decisions'] },
  { paths: ['src/main/tasks.ts', 'src/main/lanes.ts', 'src/shared/lanes.ts', 'src/main/workflow/cardWork.ts', 'src/main/workflow/recorder.ts', 'src/main/workflow/runtime.ts', 'src/shared/workflow/workView.ts', 'tests/e2e/foryou.cjs'], suites: ['foryou'] },
  { paths: ['src/main/tray.ts', 'src/renderer/src/chime.ts', 'src/shared/bursts.ts'], suites: ['bursts', 'bell', 'banners'] },
  { paths: ['src/main/notices.ts', 'src/renderer/src/components/NoticeBanners.tsx', 'src/main/planUsage.ts'], suites: ['banners'] },
  { paths: ['src/main/updater.ts', 'src/renderer/src/components/Updates.tsx', 'src/main/buildIdentity.ts', 'src/shared/updates.ts', 'tests/e2e/fakeInstall.cjs'], suites: ['update', 'about'] },
  { paths: ['src/shared/workflow/roles.ts', 'tests/e2e/agentrole.cjs'], suites: ['agentrole', 'agentstable', 'lanestart'] },
  { paths: ['src/renderer/src/components/AgentDialogs.tsx', 'src/renderer/src/components/PermissionMode.tsx'], suites: ['agentrole', 'agents-ui', 'agents', 'mode', 'context', 'codex-handover', 'footerfit', 'dialogs', 'mcpagents'] },
  { paths: ['src/renderer/src/components/AgentPanes.tsx'], suites: ['paneheader', 'pages', 'reorder', 'unmerged', 'sessionname', 'ctxpercent', 'footerfit', 'longsession', 'startfail', 'cardchip', 'agents-ui', 'unpricedcost', 'swap', 'templates', 'narrowmain', 'placement'] },
  { paths: ['src/shared/paneCells.ts'], suites: ['placement', 'swap', 'reorder', 'pages', 'agents'] },
  { paths: ['src/renderer/src/pendingMoves.ts'], suites: ['placement', 'tilesview', 'reorder', 'swap'] },
  { paths: ['src/main/docSections.ts', 'src/shared/docSections.ts', 'src/main/mcp/', 'src/shared/toolReplies.ts'], suites: ['docsections', 'replysize'] },
  { paths: ['src/shared/docRefs.ts', 'src/main/docSections.ts', 'src/main/taskStart.ts', 'src/main/tasks.ts', 'src/renderer/src/components/Board.tsx', 'src/renderer/src/components/DocRefViewer.tsx'], suites: ['cardcontext'] },
  { paths: ['src/renderer/src/components/TerminalView.tsx', 'src/renderer/src/fileLinks.ts', 'src/shared/fileLinks.ts', 'src/renderer/src/cardLinks.ts', 'src/shared/cardLinks.ts', 'src/shared/osc52.ts', 'src/renderer/src/hiddenTerminalRedraws.ts'], suites: ['filelinks', 'cardlinks', 'image', 'restart', 'rendercrash', 'termsize', 'hiddenredraw', 'pageswitch', 'assistantbatch', 'copilotsize', 'copilotcopy', 'atlasmerge'] },
  { paths: ['src/renderer/src/deferredFocus.ts'], suites: ['progress', 'restart', 'termsize', 'assistantbatch'] },
  { paths: ['src/renderer/src/components/Inbox.tsx', 'src/renderer/src/inbox.ts', 'src/shared/inbox.ts'], suites: ['inbox', 'attention', 'bell', 'signin'] },
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
  { paths: ['src/main/gitCompare.ts', 'src/renderer/src/components/ChangesCompare.tsx'], suites: ['changescompare', 'changespicker'] },
  { paths: ['src/renderer/src/components/ChangesLeftovers.tsx', 'src/shared/branchCleanup.ts'], suites: ['changesleftovers', 'gitcleanup'] },
  { paths: ['src/renderer/src/components/DataTable.tsx', 'src/shared/tableView.ts'], suites: ['overview', 'ctxpercent', 'performance', 'perftable', 'boardarchive'] },
  { paths: ['src/renderer/src/views/ProjectView.tsx'], suites: ['agents-ui', 'agentstable', 'resumeall', 'paneheader', 'rail', 'tabstrip', 'startall', 'narrowmain', 'removeall', 'defaultprovider'] },
  { paths: ['src/renderer/src/views/SettingsView.tsx'], suites: ['numbers', 'keys', 'providers', 'context', 'models', 'assistantsettings'] },
  { paths: ['src/shared/settingsCatalog.ts', 'src/main/settingsTools.ts'], suites: ['assistantsettings', 'numbers', 'replysize', 'providers', 'context'] },
  { paths: ['src/renderer/src/views/WorkspaceOverview.tsx'], suites: ['wsoverview', 'taskoverview', 'cardchip', 'unpricedcost'] },
  // The displayed name (#443): window title, About, status bar, Welcome; the profile folder for packaged builds.
  { paths: ['src/shared/appName.ts'], suites: ['about', 'update', 'welcomefit', 'taskbar', 'packaged'] },
  { paths: ['src/shared/instructions.ts'], suites: ['skilldelivery'] },
  { paths: ['src/shared/resumeAll.ts'], suites: ['resumeall', 'signin'] },
  { paths: ['src/shared/projectTabs.ts'], suites: ['tabstrip', 'startall', 'gitview'] },
  { paths: ['src/shared/startAll.ts'], suites: ['startall', 'removeall'] },
  { paths: ['src/shared/startFailure.ts'], suites: ['startfail'] },
  { paths: ['src/main/templates.ts', 'src/shared/templates.ts', 'src/shared/templateLoad.ts', 'src/renderer/src/components/TemplatePlan.tsx', 'src/renderer/src/components/TemplateLoad.tsx', 'src/shared/templateDefaults.ts'], suites: ['templatenames', 'templates', 'templateshare', 'templatesv2'] },
  { paths: ['src/main/templateUpgrade.ts', 'tests/e2e/templatesv2.cjs'], suites: ['templatesv2'] },
  { paths: ['src/main/agentNames.ts', 'src/shared/agentNames.ts'], suites: ['agents', 'agents-ui', 'templatenames', 'templates'] },
  { paths: ['tests/e2e/templatenames.cjs'], suites: ['templatenames'] },
  { paths: ['src/shared/hiveBranches.ts'], suites: ['agents', 'agents-ui', 'templates', 'templateshare', 'unusedwt', 'changespicker', 'removeall', 'wtrecreate'] },
  { paths: ['src/renderer/src/stripMenus.ts'], suites: ['templates'] },
  { paths: ['src/renderer/src/components/Templates.tsx'], suites: ['templateshare', 'templatesv2'] },
  { paths: ['src/renderer/src/assets/'], suites: ['about', 'providers'] },
  // The providers' adapters are under src/main/providers/ (every suite, above); these say which suites each mainly drives.
  { paths: ['src/main/providers/claude/'], suites: ['agents', 'agentview', 'launchrace', 'restart', 'resume', 'mode', 'compact', 'image', 'plan', 'claude-real', 'claudehome', 'claudesettings', 'assistantmode', 'assistantresume'] },
  { paths: ['src/main/providers/codex/'], suites: ['codex', 'codex-background', 'codex-extra', 'codex-handover', 'codex-mcpapproval', 'codex-setup', 'codex-storepwsh', 'attention', 'skilldelivery', 'sessiontree', 'codexfolder'] },
  // Copilot's offline suite (the real CLI against the stand-in model), the provider pages and the skill copies it shares with Codex.
  { paths: ['src/main/providers/copilot/', 'src/shared/copilot.ts'], suites: ['copilot', 'copilotsize', 'copilotcopy', 'providers', 'skilldelivery', 'models'] },
  { paths: ['tests/e2e/fake-copilot-api.cjs'], suites: ['copilot', 'copilotsize', 'copilotcopy', 'workspacenotes', 'slotguidance'] },
  // A folder being changed under its agents (#646): the Git view takes it; deliveries and starts wait for it.
  { paths: ['src/main/folderFence.ts'], suites: ['gitview', 'deliveries', 'inbox', 'agentmessage', 'background'] },
  // How Hive's lines reach a busy real Codex or Copilot (#600): their runner, and what they check.
  { paths: ['tests/e2e/wakepaste-cli/', 'src/main/terminalScreen.ts', 'src/main/lineWriter.ts', 'src/main/deliveries.ts'], suites: ['wakepaste-codex', 'wakepaste-copilot'] },
  { paths: ['src/shared/copilot.ts', 'tests/e2e/fake-copilot-api.cjs'], suites: ['wakepaste-copilot'] },
  { paths: ['src/main/providers/codex/', 'src/shared/codex.ts'], suites: ['wakepaste-codex'] },
  // What a Codex launch through its app server would rely on (#653): checked against the installed Codex.
  { paths: ['src/main/providers/codex/'], suites: ['codex-appserver'] },
  // Codex's Advanced switches (#1167): right-click passed to Codex, and its terminal title left to the user's config.
  { paths: ['src/main/providers/codex/', 'src/main/advancedValues.ts', 'src/renderer/src/components/TerminalView.tsx', 'tests/e2e/codexoverrides.cjs'], suites: ['codexoverrides'] },
  // The switches for an agent pane's Ctrl+C and Ctrl+V and for what Hive types (#1286).
  { paths: ['src/renderer/src/components/TerminalView.tsx', 'src/shared/terminalInput.ts', 'src/main/sessions.ts', 'tests/e2e/fake-claude/fake-claude.cjs', 'tests/e2e/terminalinput.cjs', 'src/renderer/src/commands.ts', 'src/main/taskStart.ts'], suites: ['terminalinput'] },
  // Claude Code's status line, Hive's guidance and the user's own Codex hooks (#1285).
  { paths: ['src/main/providers/claude/launchSettings.ts', 'src/main/providers/claude/adapter.ts', 'src/main/servers.ts', 'tests/e2e/claudestatusline.cjs'], suites: ['claudestatusline'] },
  { paths: ['src/main/mcp/hive-mcp.ts', 'src/main/index.ts', 'tests/e2e/agentguidance.cjs'], suites: ['agentguidance'] },
  { paths: ['src/main/providers/codex/adapter.ts', 'tests/e2e/codexownhooks.cjs'], suites: ['codexownhooks'] },
  // Codex's app server asked one thing, owned until it ends (HI-1757): a connection's sign-in check, a launch's hook check.
  { paths: ['src/main/codexChecks.ts'], suites: ['connections-codex', 'codexownhooks'] },
  // The CLI's own setting and the Assistant's other MCP servers (#1284).
  { paths: ['src/shared/cliOwnMode.ts', 'src/renderer/src/components/PermissionMode.tsx', 'src/main/providers/claude/', 'tests/e2e/cliownmode.cjs'], suites: ['cliownmode'] },
  // The run context: every suite (above); isolation checks what it gives a test Hive and the children a suite starts.
  { paths: ['tests/e2e/runContext.cjs', 'src/main/testQuiet.ts'], suites: ['isolation'] },
  // The fake Codex CLI: every suite that runs it.
  { paths: ['tests/e2e/fake-codex/'], suites: ['attachread', 'carryingon', 'codexqueued', 'attention', 'footerfit', 'skilldelivery', 'models', 'sessiontree', 'termsize', 'freshpath', 'defaultprovider', 'providerdetect', 'codexfolder', 'turnledger', 'flightrecorder', 'hookshealth', 'hookstranscript', 'workspacenotes', 'reviewcopies', 'slotguidance', 'p7lane'] },
  // Hive's bundled skills and modes, read at runtime (not documentation).
  { paths: ['resources/skills/', 'src/main/bundledHistory.json'], suites: ['skills', 'skillaudience', 'skilldelivery', 'cardloop', 'replysize', 'slotguidance'] },
  { paths: ['resources/modes/', 'src/main/assistantMode.ts'], suites: ['assistant', 'assistant-control', 'assistantend', 'assistantmode', 'assistantresume'] },
  // Bundled into the Docs view (About's licence pages, Release Notes, the Agent API reference).
  { paths: ['docs/', 'CHANGELOG.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'scripts/licenses.mjs', 'scripts/licenseText.mjs', 'scripts/thirdPartyNotices.mjs', 'scripts/notices/'], suites: ['about'] },
  // The i18n screenshot route (#769): its case files (each area's, found by name), the translations it shows (every
  // other suite runs in English), and the screens its core cases reach by their hooks; its text report's layout check (#899).
  { paths: ['tests/e2e/layoutReport.cjs'], suites: ['i18nreport', 'i18nshots'] },
  { paths: ['tests/e2e/i18nshots/', 'locales/', 'src/renderer/src/views/ProjectTabs.tsx', 'src/renderer/src/components/Progress.tsx', 'src/renderer/src/components/NoticeBanners.tsx', 'src/renderer/src/components/Overlays.tsx', 'src/renderer/src/views/SettingsView.tsx', 'src/main/progress.ts'], suites: ['i18nshots'] },
  // The installer's copies (npm run dist first).
  { paths: ['electron-builder.yml', 'scripts/dist.mjs', 'scripts/distCopy.mjs'], suites: ['packaged', 'packaged-mcp', 'packaged-progress', 'packaged-transcript'] },
  // Session records in the workspace's database (#1061): the suites that read or write them, Remove from Hive and Repair.
  { paths: ['src/main/sessionStore.ts', 'tests/e2e/storeDocs.cjs', 'src/main/schema/sessionDeliveryTables.ts', 'src/main/schema/sessionDeliveryCodec.ts', 'tests/e2e/sessionDeliveryCodec.cjs'], suites: ['agents', 'assistantimages', 'assistantmode', 'cardchip', 'overview', 'providerdetect', 'quit', 'restart', 'resume', 'review', 'safeguards', 'sessionname', 'sessioncleanup', 'sessionorigin', 'sessionsize', 'sessiontree', 'wtrecreate', 'storage', 'transcript', 'wsmove', 'changespicker', 'dialogs', 'files', 'i18nlive', 'performance', 'projectrename', 'wsoverview', 'removeall', 'codex', 'codex-handover'] },
  // Background tasks read from Claude Code's transcript (#640: one the agent stopped wakes nothing).
  { paths: ['src/main/providers/claude/background.ts'], suites: ['background', 'turnledger', 'idlestatus'] }
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
 * Files that need no suite: notes for people and agents (the skills for developing Hive, in .claude/skills and
 * .agents/skills, are neither shipped nor read by the app; Hive's own copies there are git-ignored), and the unit tests
 * (npm test runs those).
 */
export const DOCS_ONLY = ['README.md', 'CONTRIBUTING.md', 'AGENTS.md', 'CLAUDE.md', 'RELEASING.md', 'tests/README.md', 'tests/e2e/README.md', 'tests/scenarios/', 'reference/', '.gitattributes', '.gitignore', '.claude/skills/', '.agents/skills/']

/** Fixtures the fake CLIs answer with too (#125): a change to one needs the suites its area names, not only npm test. */
const FAKE_FIXTURES = ['tests/fixtures/claude-initialize.json', 'tests/fixtures/codex-debug-models.json']

/**
 * What only the unit tests use (#390): Vitest's config, CI's workflow (it runs npm test, lint and typecheck, never an e2e
 * suite) and the unit tests' helpers in tests/ (electron-stub.ts, tempDir.ts…; no e2e suite or scenario loads a .ts
 * file from there, which tests/e2esuites.test.ts checks), and the sleeps checker (npm run test:waits: its unit test
 * and a scenario use it, no e2e suite). The i18n tooling too (#768): extracting, checking and counting translations and
 * the guard against new hard-coded text (npm test and CI run them; the app never reads them, nor the guard's allowlists
 * in i18n/allow/), and each area's i18n unit tests (tests/i18n/). tests/progressReport.mts is the runners' and in
 * EVERYTHING. The 1.0 workflow core spike (#1118) too: nothing in the app loads it, and tests/workflow runs its
 * scenarios; the phase that wires it into the app (P3, P4) gives it an area (the 1.0 schema, src/main/schema, has the
 * board's since its cards step, #1209, as the fact store and the actions worker do since #1215).
 */
export const UNIT_ONLY = ['vitest.config.ts', '.github/workflows/ci.yml', 'scripts/testWaits.mjs', 'scripts/i18nExtract.mjs', 'scripts/i18nValues.mjs', 'scripts/i18nCheck.mjs', 'scripts/i18nCoverage.mjs', 'scripts/i18nGuard.mjs', 'i18n/allow/', 'tests/i18n/', 'tests/workflow/', 'src/shared/workflow/', 'src/shared/platform/', 'src/main/workflow/', 'src/main/platform/']

/** Whether a file is a unit test (tests/*.test.ts, their helpers and fixtures, UNIT_ONLY): npm test covers it, no e2e suite. */
export const unitTest = (f) => /^tests\/[^/]+\.ts$/i.test(f) || under(f, UNIT_ONLY) || (/^tests\/fixtures\//i.test(f) && !FAKE_FIXTURES.includes(f))

/**
 * Hive's side of every real CLI: launching it, its hooks and the status they give, reading its transcripts, its
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
  'src/main/transcriptFiles.ts',
  'src/shared/providers.ts',
  'tests/e2e/lib.cjs',
  // The environment the real CLIs are started in.
  'tests/e2e/runContext.cjs',
  'tests/e2e/codexHomeLock.mjs'
]
const PROVIDER_OWN = ['src/main/providers/claude/', 'src/main/providers/codex/', 'src/main/providers/copilot/']

/**
 * The suites a set of changed files needs, from the known suite names (realNames: those that start a real CLI):
 * { all: true, why, real } when every fake suite is needed (real: the real-CLI suites also needed), else
 * { suites, why } (why: a line per reason). A real-CLI suite is needed when an area names it, its own file changed, or
 * a file in REAL_TIER (or one no area names) changed. Only DOCS_ONLY files and unit tests select nothing.
 */
export function affectedSuites(files, suiteNames, realNames = []) {
  const picked = new Set()
  const why = []
  let all = null
  let allReal = null
  for (const raw of files) {
    const file = raw.replace(/\\/g, '/')
    const own = /^tests\/e2e\/([^/]+)\.cjs$/i.exec(file)
    if (own && suiteNames.includes(own[1])) {
      picked.add(own[1])
      why.push(`${file}: its own suite`)
      continue
    }
    if (under(file, REAL_TIER) && !under(file, PROVIDER_OWN)) allReal ??= `${file}: every real-CLI suite`
    const areas = AREAS.filter((a) => under(file, a.paths))
    for (const a of areas) for (const s of a.suites) picked.add(s)
    if (under(file, EVERYTHING)) {
      all ??= `${file}: shared by every part of Hive`
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
  return { suites: suiteNames.filter((n) => picked.has(n) || (allReal && realNames.includes(n))), why: [...why, ...(allReal ? [allReal] : [])] }
}

const gitLines = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: runContext.baseEnv() }).split(/\r?\n/).filter(Boolean)

/** The commit a base's changes are counted from: where HEAD left the base (default main). */
export const mergeBase = (base = 'main', cwd = process.cwd()) => gitLines(cwd, 'merge-base', base, 'HEAD')[0]

/** The files changed against a base (default main): committed since the merge base, uncommitted and untracked. */
export function changedFiles(base = 'main', cwd = process.cwd()) {
  return [...new Set([...gitLines(cwd, 'diff', '--name-only', mergeBase(base, cwd)), ...gitLines(cwd, 'ls-files', '--others', '--exclude-standard')])]
}
