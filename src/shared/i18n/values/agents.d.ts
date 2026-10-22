// Generated from locales/en/agents.json: do not edit. Each message's placeholders and their types, for tr(): a
// global script, so its interface merges with every other area's (shared/i18n/msg.ts).
interface HiveMessageValues {
  'agents.add.add': undefined
  'agents.add.basedOn': undefined
  'agents.add.branch': undefined
  'agents.add.branchHint': undefined
  'agents.add.checking': undefined
  'agents.add.createdIn': { folder: string | number; copied: string }
  'agents.add.currentBranch': { branch: string | number }
  'agents.add.detached': undefined
  'agents.add.existingMerged': { branch: string | number }
  'agents.add.existingMergedCurrent': undefined
  'agents.add.existingNote': undefined
  'agents.add.existingWorktree': undefined
  'agents.add.failed': undefined
  'agents.add.full': { limit: string | number }
  'agents.add.gitError': { error: string | number }
  'agents.add.gitProblem': { problem: string | number }
  'agents.add.heldWorktree': { branch: string | number; why: string | number }
  'agents.add.nameTaken': { project: string | number; agent: string | number }
  'agents.add.nameTakenHere': { project: string | number; agent: string | number }
  'agents.add.needsRepo': undefined
  'agents.add.newWorktree': undefined
  'agents.add.newWorktreeNote': undefined
  'agents.add.noUnused': undefined
  'agents.add.projectFolder': undefined
  'agents.add.projectFolderNote': undefined
  'agents.add.providerOff': { cli: string | number; whose: string }
  'agents.add.reuses': { path: string | number; branch: string | number; base: string | number }
  'agents.add.setupAgain': { setup: string | number }
  'agents.add.setupNone': undefined
  'agents.add.setupRuns': { setup: string | number; cli: string | number }
  'agents.add.startNow': undefined
  'agents.add.title': { project: string | number }
  'agents.add.useSuggestion': { name: string | number }
  'agents.add.where': undefined
  'agents.add.worktreeNotice': { agent: string | number; reused: string }
  'agents.batch.busy': { status: string }
  'agents.batch.outcome': { kind: string }
  'agents.batch.stoppedThen': { note: string; kind: string }
  'agents.batch.worktreeKept': { branch: string | number; why: string | number }
  'agents.batch.worktreeRemovable': { branch: string | number }
  'agents.batch.worktreeUnchecked': { branch: string | number }
  'agents.choice.chooseOne': undefined
  'agents.choice.noneOn': undefined
  'agents.choice.notInstalled': undefined
  'agents.choice.turnedOff': undefined
  'agents.claude.acceptEdits': undefined
  'agents.claude.acceptEditsDescription': undefined
  'agents.claude.auto': undefined
  'agents.claude.autoDescription': undefined
  'agents.claude.autoMaybe': { model: string | number }
  'agents.claude.autoUnsupported': { model: string | number }
  'agents.claude.bypass': undefined
  'agents.claude.bypassDescription': undefined
  'agents.claude.dontAsk': undefined
  'agents.claude.dontAskDescription': undefined
  'agents.claude.extensionNote': undefined
  'agents.claude.installNote': undefined
  'agents.claude.latestFable': undefined
  'agents.claude.latestGroup': undefined
  'agents.claude.latestHaiku': undefined
  'agents.claude.latestOpus': undefined
  'agents.claude.latestSonnet': undefined
  'agents.claude.manual': undefined
  'agents.claude.manualDescription': undefined
  'agents.claude.modelPlaceholder': undefined
  'agents.claude.pinnedGroup': undefined
  'agents.claude.plan': undefined
  'agents.claude.planDescription': undefined
  'agents.claude.safeguardHelp': undefined
  'agents.claude.signInHelp': undefined
  'agents.cliOwn.cliNote': undefined
  'agents.cliOwn.description': undefined
  'agents.cliOwn.label': undefined
  'agents.cliOwn.short': undefined
  'agents.codex.approveForMe': undefined
  'agents.codex.approveForMeDescription': undefined
  'agents.codex.ask': undefined
  'agents.codex.askDescription': undefined
  'agents.codex.extensionNote': undefined
  'agents.codex.fullAccess': undefined
  'agents.codex.fullAccessDescription': undefined
  'agents.codex.installNote': undefined
  'agents.codex.modelPlaceholder': undefined
  'agents.codex.readOnly': undefined
  'agents.codex.readOnlyDescription': undefined
  'agents.codex.safeguardHelp': undefined
  'agents.codex.signInHelp': undefined
  'agents.copilot.acceptEdits': undefined
  'agents.copilot.acceptEditsCliNote': undefined
  'agents.copilot.acceptEditsDescription': undefined
  'agents.copilot.allowAll': undefined
  'agents.copilot.allowAllDescription': undefined
  'agents.copilot.ask': undefined
  'agents.copilot.askDescription': undefined
  'agents.copilot.autopilot': undefined
  'agents.copilot.autopilotDescription': undefined
  'agents.copilot.extensionNote': undefined
  'agents.copilot.installNote': undefined
  'agents.copilot.modelPlaceholder': undefined
  'agents.copilot.othersGroup': undefined
  'agents.copilot.plan': undefined
  'agents.copilot.planDescription': undefined
  'agents.copilot.signInHelp': undefined
  'agents.dialog.busy': undefined
  'agents.dialog.cancel': undefined
  'agents.dialog.codingAgent': undefined
  'agents.dialog.mcpServers': undefined
  'agents.dialog.merge': undefined
  'agents.dialog.name': undefined
  'agents.dialog.projectFolder': undefined
  'agents.dialog.settings': undefined
  'agents.dialog.worksIn': undefined
  'agents.dialog.worktree': undefined
  'agents.effort.inherited': { effort: string | number }
  'agents.efforts.cliDefault': { provider: string | number }
  'agents.efforts.default': undefined
  'agents.efforts.defaultIs': { effort: string | number }
  'agents.efforts.high': undefined
  'agents.efforts.low': undefined
  'agents.efforts.max': undefined
  'agents.efforts.medium': undefined
  'agents.efforts.minimal': undefined
  'agents.efforts.none': undefined
  'agents.efforts.ultra': undefined
  'agents.efforts.xhigh': undefined
  'agents.fileLock.ask': undefined
  'agents.fileLock.askDescription': undefined
  'agents.fileLock.block': undefined
  'agents.fileLock.blockDescription': undefined
  'agents.fileLock.off': undefined
  'agents.fileLock.offDescription': undefined
  'agents.fileLock.warn': undefined
  'agents.fileLock.warnDescription': undefined
  'agents.handOver.askFirst': { agent: string | number }
  'agents.handOver.busy': { who: string; from: string | number; other: string | number }
  'agents.handOver.failed': { agent: string | number }
  'agents.handOver.go': undefined
  'agents.handOver.intro': { agent: string | number }
  'agents.handOver.needsTools': undefined
  'agents.handOver.off': { cli: string | number }
  'agents.handOver.running': undefined
  'agents.handOver.self': { agent: string | number }
  'agents.handOver.selfLater': undefined
  'agents.handOver.selfNote': { size: string }
  'agents.handOver.starts': { cli: string | number }
  'agents.handOver.stopped': { who: string; from: string | number; other: string | number }
  'agents.handOver.title': { agent: string | number }
  'agents.handOver.writes': { who: string; from: string | number; other: string | number }
  'agents.installSource.native': undefined
  'agents.installSource.settings': undefined
  'agents.installSource.standalone': undefined
  'agents.keys.clipboard': { key: string | number }
  'agents.keys.escape': undefined
  'agents.keys.shiftOnly': undefined
  'agents.keys.shiftTab': undefined
  'agents.keys.singleKey': undefined
  'agents.layout.columns2': undefined
  'agents.layout.columns3': undefined
  'agents.layout.grid': undefined
  'agents.layout.grid6': undefined
  'agents.layout.single': undefined
  'agents.limit.many': { limit: string | number; total: string | number; free: string | number }
  'agents.limit.manyMeasured': { limit: string | number; running: number; used: string | number; each: string | number; total: string | number; free: string | number }
  'agents.limit.reached': { limit: string | number }
  'agents.mcp.all': undefined
  'agents.mcp.its': undefined
  'agents.mcp.loading': undefined
  'agents.mcp.none': { where: string }
  'agents.mcp.notOn': { where: string }
  'agents.mcp.note': undefined
  'agents.mcp.only': undefined
  'agents.merge.blocked': { why: string; agent: string | number }
  'agents.merge.commits': { n: number; into: string | number }
  'agents.merge.nothing': { into: string | number }
  'agents.merge.uncommitted': { n: number }
  'agents.mergeDialog.anyway': undefined
  'agents.mergeDialog.anywayConfirm': undefined
  'agents.mergeDialog.anywayMessage': undefined
  'agents.mergeDialog.anywayTitle': { card: string | number }
  'agents.mergeDialog.cantRead': undefined
  'agents.mergeDialog.close': undefined
  'agents.mergeDialog.conflict': undefined
  'agents.mergeDialog.conflictFiles': { branch: string | number; into: string | number }
  'agents.mergeDialog.conflictHelp': undefined
  'agents.mergeDialog.copied': undefined
  'agents.mergeDialog.copy': undefined
  'agents.mergeDialog.mergeNote': undefined
  'agents.mergeDialog.mergeNoteUnused': undefined
  'agents.mergeDialog.mergesCommits': { commits: number; branch: string | number; into: string | number }
  'agents.mergeDialog.message': undefined
  'agents.mergeDialog.move': { branch: string | number; known: string; into: string | number }
  'agents.mergeDialog.moveNote': { agent: string | number }
  'agents.mergeDialog.noBranch': undefined
  'agents.mergeDialog.noFolderAgent': undefined
  'agents.mergeDialog.noInto': undefined
  'agents.mergeDialog.noMoveNote': undefined
  'agents.mergeDialog.nothing': { branch: string | number; into: string | number }
  'agents.mergeDialog.onlyUncommitted': { branch: string | number }
  'agents.mergeDialog.otherBase': { agent: string | number; base: string | number; into: string | number }
  'agents.mergeDialog.queueLookup': undefined
  'agents.mergeDialog.queueLookupFailed': { why: string | number }
  'agents.mergeDialog.queueMerges': { card: string | number }
  'agents.mergeDialog.queueNotYet': { target: string | number }
  'agents.mergeDialog.queuePaused': undefined
  'agents.mergeDialog.queueQueued': { target: string | number; position: number }
  'agents.mergeDialog.queueQueuedNoPlace': { target: string | number }
  'agents.mergeDialog.queueRetry': undefined
  'agents.mergeDialog.queueTesting': { target: string | number }
  'agents.mergeDialog.reading': { branch: string | number }
  'agents.mergeDialog.remove': undefined
  'agents.mergeDialog.removeUnused': undefined
  'agents.mergeDialog.running': { agent: string | number }
  'agents.mergeDialog.send': { agent: string | number }
  'agents.mergeDialog.squash': undefined
  'agents.mergeDialog.squashNote': undefined
  'agents.mergeDialog.squashNoteUnused': undefined
  'agents.mergeDialog.title': { agent: string | number }
  'agents.mergeDialog.titleUnused': { branch: string | number }
  'agents.mergeDialog.uncommitted': { files: number }
  'agents.merged.failed': undefined
  'agents.merged.kept': { branch: string | number }
  'agents.merged.moved': { branch: string | number; folder: string; into: string | number; agent: string | number }
  'agents.merged.notMoved': { branch: string | number; folder: string; into: string | number }
  'agents.merged.notMovedWhy': { why: string | number; folder: string; agent: string | number; into: string | number }
  'agents.merged.removed': { agent: string | number }
  'agents.merged.removedUnused': undefined
  'agents.merged.title': { branch: string | number; folder: string; into: string | number }
  'agents.model.cliDefault': { cli: string | number }
  'agents.model.inherited': { model: string | number }
  'agents.models.fallback': { provider: string | number; edited: string }
  'agents.models.fromCache': { provider: string | number; version: string }
  'agents.models.fromCli': { provider: string | number; version: string }
  'agents.models.olderGroup': undefined
  'agents.models.providerGroup': { provider: string | number }
  'agents.models.unavailableGroup': undefined
  'agents.name.empty': undefined
  'agents.name.taken': { agent: string | number; project: string | number; suggestion: string | number }
  'agents.name.tooLong': { max: string | number }
  'agents.overrides.context': undefined
  'agents.overrides.effort': undefined
  'agents.overrides.inherited': { whose: string | number; value: string | number }
  'agents.overrides.model': undefined
  'agents.overrides.off': undefined
  'agents.overrides.on': undefined
  'agents.overrides.permission': undefined
  'agents.overrides.projects': undefined
  'agents.permission.agentNewSessions': { agent: string | number }
  'agents.permission.answerFirst': undefined
  'agents.permission.badgeTip': { live: string; mode: string | number; note: string; key: string; cycles: string; plan: string }
  'agents.permission.cliOwnNoSwitch': undefined
  'agents.permission.cliOwnNoSwitchTitle': undefined
  'agents.permission.current': undefined
  'agents.permission.dangerConfirm': { mode: string | number }
  'agents.permission.dangerDetail': { provider: string | number }
  'agents.permission.dangerMessage': { where: string | number }
  'agents.permission.dangerTitle': { mode: string | number }
  'agents.permission.inherit': { mode: string | number }
  'agents.permission.menu': undefined
  'agents.permission.menuAgent': { agent: string | number }
  'agents.permission.newSessionsOf': { name: string | number }
  'agents.permission.notSwitched': undefined
  'agents.permission.planFailed': undefined
  'agents.permission.planMode': undefined
  'agents.permission.planOff': undefined
  'agents.permission.planOn': undefined
  'agents.permission.projectNewSessions': { project: string | number; provider: string | number }
  'agents.permission.restart': undefined
  'agents.permission.restartAgent': { mode: string | number; agent: string | number }
  'agents.permission.restartFailed': undefined
  'agents.permission.restartSession': { mode: string | number }
  'agents.permission.restartTitle': { mode: string | number }
  'agents.permission.restartWorking': undefined
  'agents.permission.restarts': undefined
  'agents.permission.saveFailed': undefined
  'agents.permission.sessionOnly': undefined
  'agents.permission.switchFailed': undefined
  'agents.permission.switching': { mode: string | number }
  'agents.permission.useProjects': { mode: string | number }
  'agents.permission.withPlan': { mode: string | number }
  'agents.picker.customModel': undefined
  'agents.picker.defaultModel': { provider: string | number }
  'agents.picker.effortNone': { provider: string | number; effort: string | number; model: string | number }
  'agents.picker.effortOffers': { provider: string | number; effort: string | number; model: string | number; efforts: string | number }
  'agents.picker.hideOlder': undefined
  'agents.picker.noEffort': { model: string | number }
  'agents.picker.notOffered': { effort: string | number; model: string | number }
  'agents.picker.showOlder': undefined
  'agents.provider.automatic': { state: string; provider: string | number }
  'agents.provider.compactDefault': { provider: string | number; at: number }
  'agents.provider.compactDefaultFor': { provider: string | number; at: number; why: string; estimate: string }
  'agents.provider.compactOff': { provider: string | number; source: string | number; estimate: string }
  'agents.provider.compactPercent': { share: number }
  'agents.provider.compactWindow': { provider: string | number; at: number; window: number; why: string | number; estimate: string }
  'agents.provider.context': { tokens: number }
  'agents.provider.contextOf': { tokens: number; window: number }
  'agents.provider.extraArgsDashes': undefined
  'agents.provider.lastTurn': { input: number; output: number }
  'agents.provider.warning': { why: string; provider: string | number }
  'agents.resume.goneWorktree': { folder: string | number }
  'agents.resume.noRoom': undefined
  'agents.resume.noTranscript': { cli: string | number }
  'agents.resume.notInstalled': { cli: string | number }
  'agents.resume.providerOff': { cli: string | number }
  'agents.resume.removedAdd': { agent: string; cli: string | number }
  'agents.resume.removedTo': { agent: string; target: string | number }
  'agents.resume.running': undefined
  'agents.resume.sub': { kind: string | number; cli: string | number }
  'agents.session.unnamed': { id: string | number }
  'agents.settings.appliesNext': { agent: string | number }
  'agents.settings.ownWorktree': undefined
  'agents.settings.role': undefined
  'agents.settings.roleNone': { name: string | number }
  'agents.settings.save': undefined
  'agents.settings.saving': undefined
  'agents.settings.stopToChange': { agent: string | number }
  'agents.settings.title': { agent: string | number }
  'agents.settings.worktreeOn': { branch: string | number; base: string | number }
  'agents.start.exited': { cli: string | number; code: string | number }
  'agents.switch.confirm': undefined
  'agents.switch.detail': undefined
  'agents.switch.message': { cli: string | number; was: string | number; agent: string | number }
  'agents.switch.title': { agent: string | number; cli: string | number }
  'agents.template.nameTaken': { name: string | number }
  'agents.template.new': undefined
  'agents.template.note': { template: string | number; projects: string | number }
  'agents.template.title': { agent: string | number }
  'agents.tested.newer': undefined
  'agents.tested.older': undefined
  'agents.tested.summary': { tested: string | number; installed: string | number }
  'agents.tested.summaryUnknown': { tested: string | number }
  'agents.tested.unknown': undefined
}
