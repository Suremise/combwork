// Generated from locales/en/service.json: do not edit. Each message's placeholders and their types, for tr(): a
// global script, so its interface merges with every other area's (shared/i18n/msg.ts).
interface CombworkMessageValues {
  'service.advanced.asIs': { problem: string | number }
  'service.advanced.changedOutside': undefined
  'service.advanced.fixFirst': { problem: string | number }
  'service.advanced.fixOrDelete': { problem: string | number }
  'service.advanced.newer': { format: string | number; supported: string | number }
  'service.advanced.notJson': { error: string | number }
  'service.advanced.notObject': { example: string | number }
  'service.advanced.notValues': undefined
  'service.advanced.onConnection': { id: string | number }
  'service.advanced.unknown': { id: string | number }
  'service.answerRelay.title': { card: string | number }
  'service.assistantAsk.title': { card: string | number }
  'service.attachments.badFolder': undefined
  'service.attachments.badRecord': { file: string | number }
  'service.attachments.notOwn': { folder: string | number }
  'service.benchmarks.allPinned': { n: string | number }
  'service.benchmarks.cantRead': { error: string | number }
  'service.benchmarks.closed': undefined
  'service.benchmarks.damaged': undefined
  'service.benchmarks.evictedStays': undefined
  'service.benchmarks.fileGone': undefined
  'service.benchmarks.invalid': { n: number }
  'service.benchmarks.noFile': undefined
  'service.benchmarks.noSuch': undefined
  'service.benchmarks.noSuchHere': undefined
  'service.benchmarks.noWorkspace': undefined
  'service.benchmarks.notRemoved': undefined
  'service.benchmarks.notWaiting': undefined
  'service.benchmarks.overflow': { n: number }
  'service.benchmarks.recovered': { reason: string | number; n: number; setAside: string }
  'service.benchmarks.removalFinished': undefined
  'service.benchmarks.strays': { n: number }
  'service.benchmarks.stuck': { n: number }
  'service.benchmarks.switched': undefined
  'service.benchmarks.tooLarge': { mb: string | number }
  'service.benchmarks.unwritable': undefined
  'service.benchmarks.why': { why: string }
  'service.benchmarks.wrongScope': undefined
  'service.cardAttach.moveFailed': { project: string | number; why: string | number }
  'service.cardAttach.moved': undefined
  'service.cardAttach.noAttachment': undefined
  'service.cardAttach.noCard': undefined
  'service.cardAttach.noProject': { project: string | number }
  'service.cardAttach.refused': { path: string | number }
  'service.cardAttach.refusedFrom': { path: string | number; caller: string; temp: string | number; more: string; folders: string | number }
  'service.cardAttach.tooLarge': { name: string | number; max: string | number }
  'service.cardAttach.tooMuch': { files: number; total: string | number }
  'service.cardCleanup.stale': undefined
  'service.combworkMove.busy': { profile: string | number }
  'service.combworkMove.closed': undefined
  'service.combworkMove.locked': { folder: string | number }
  'service.combworkMove.otherOpen': { profile: string | number }
  'service.combworkMove.phaseFailed': { what: string | number; error: string | number }
  'service.combworkVcs.cantList': undefined
  'service.combworkVcs.cantListWhy': { problem: string | number }
  'service.combworkVcs.changed': undefined
  'service.combworkVcs.exitCode': { code: string | number }
  'service.combworkVcs.noRepo': undefined
  'service.combworkVcs.rmFailed': { why: string | number }
  'service.files.badName': { name: string | number }
  'service.files.exists': { name: string | number }
  'service.files.existsIn': { root: string; name: string | number; folder: string | number }
  'service.files.groupInUse': undefined
  'service.files.inUse': undefined
  'service.files.insideItself': { name: string | number }
  'service.files.nameRequired': undefined
  'service.files.needsEntry': undefined
  'service.files.notAttachment': undefined
  'service.files.notKept': undefined
  'service.files.outside': undefined
  'service.files.throughLink': undefined
  'service.filesGit.busy': undefined
  'service.filesGit.failed': { why: string | number }
  'service.filesGit.linked': { file: string | number }
  'service.filesGit.notIgnored': undefined
  'service.filesGit.notRepo': undefined
  'service.filesGit.notUtf8': { file: string | number }
  'service.filesGit.nothing': undefined
  'service.filesGit.ruleChanged': undefined
  'service.filesGit.tooLarge': { file: string | number }
  'service.forward.byAssistant': undefined
  'service.forward.byUser': undefined
  'service.forward.description': { from: string | number; source: string | number; to: string | number; by: string | number }
  'service.forward.missing': { unknown: string; branch: string | number }
  'service.forward.noGit': undefined
  'service.forward.notAgents': undefined
  'service.forward.notTargets': { from: string | number; to: string | number; targets: string | number }
  'service.forward.raced': undefined
  'service.forward.title': { to: string | number; from: string | number }
  'service.fsutil.keptBusy': { file: string | number }
  'service.fsutil.keptUnreadable': { file: string | number }
  'service.fsutil.notCopied': { name: string | number }
  'service.git.exitCode': { code: string | number }
  'service.git.failed': { command: string | number; why: string | number }
  'service.git.outside': undefined
  'service.git.tooLarge': { kb: number }
  'service.gitCompare.noBranch': { branch: string | number }
  'service.gitRepo.addFailed': { remote: string | number; why: string | number }
  'service.gitRepo.added': { remote: string | number }
  'service.gitRepo.alreadyOn': { branch: string | number }
  'service.gitRepo.badName': { kind: string; hasName: string; name: string | number }
  'service.gitRepo.branchKept': { why: string; branch: string | number; target: string | number }
  'service.gitRepo.branchTaken': { name: string | number }
  'service.gitRepo.branchesDeleted': { n: number; branches: string | number }
  'service.gitRepo.chooseRemote': undefined
  'service.gitRepo.command': { command: string | number; why: string | number }
  'service.gitRepo.createFailed': { name: string | number; why: string | number }
  'service.gitRepo.createdAt': { name: string | number; commit: string | number }
  'service.gitRepo.createdFrom': { name: string | number; from: string | number; commit: string | number }
  'service.gitRepo.createdFromSwitched': { name: string | number; from: string | number }
  'service.gitRepo.createdSwitched': { name: string | number }
  'service.gitRepo.deleteBranchFailed': { branch: string | number; why: string | number }
  'service.gitRepo.detachedPull': undefined
  'service.gitRepo.detachedPush': undefined
  'service.gitRepo.diverged': { branch: string | number; upstream: string | number; ahead: number; behind: number }
  'service.gitRepo.exitCode': { code: string | number }
  'service.gitRepo.fetchFailed': { why: string | number }
  'service.gitRepo.fetched': { remotes: string | number }
  'service.gitRepo.gaveUp': { minutes: string | number }
  'service.gitRepo.identityRemoved': undefined
  'service.gitRepo.identitySet': undefined
  'service.gitRepo.inWorktree': { branch: string | number; folder: string | number }
  'service.gitRepo.midOperation': { state: string | number }
  'service.gitRepo.noBranch': { branch: string | number }
  'service.gitRepo.noCommits': undefined
  'service.gitRepo.noRemote': { remote: string | number }
  'service.gitRepo.noRemotes': undefined
  'service.gitRepo.noRemotesFetch': undefined
  'service.gitRepo.noStart': { ref: string | number }
  'service.gitRepo.noTarget': { target: string | number }
  'service.gitRepo.noUpstream': { branch: string | number }
  'service.gitRepo.notOnRemote': { remote: string | number; branch: string | number }
  'service.gitRepo.notRepo': { folder: string | number }
  'service.gitRepo.nothingToPush': undefined
  'service.gitRepo.nothingToTag': undefined
  'service.gitRepo.pullFailed': { why: string | number }
  'service.gitRepo.pulled': { n: number; upstream: string | number }
  'service.gitRepo.pushAllRefused': { remote: string | number; n: number }
  'service.gitRepo.pushFailed': { to: string | number; why: string | number }
  'service.gitRepo.pushOutcome': { result: string; refs: string | number }
  'service.gitRepo.pushUpToDate': { to: string | number; branch: string | number }
  'service.gitRepo.pushed': { branch: string | number; to: string | number }
  'service.gitRepo.pushedAll': { remote: string | number }
  'service.gitRepo.rejected': { to: string | number; branch: string | number }
  'service.gitRepo.remoteBranchesDeleted': { n: number; branches: string | number; remote: string | number }
  'service.gitRepo.remoteDeleteRefused': { remote: string | number; branches: string | number }
  'service.gitRepo.remoteRemoved': { n: number; remote: string | number; branches: string | number }
  'service.gitRepo.remoteRenamed': { n: number; from: string | number; to: string | number; branches: string | number }
  'service.gitRepo.remoteSameName': { remote: string | number }
  'service.gitRepo.remoteTaken': { remote: string | number }
  'service.gitRepo.remoteTrackingChanged': { remote: string | number }
  'service.gitRepo.removeRemoteFailed': { remote: string | number; why: string | number }
  'service.gitRepo.renameRemoteFailed': { remote: string | number; why: string | number }
  'service.gitRepo.setFailed': { key: string | number; why: string | number }
  'service.gitRepo.startMoved': { ref: string | number; now: string | number }
  'service.gitRepo.switchFailed': { branch: string | number; why: string | number }
  'service.gitRepo.switched': { branch: string | number }
  'service.gitRepo.switchedTracking': { branch: string | number; remote: string | number }
  'service.gitRepo.tagPushFailed': { commit: string | number; name: string | number; remote: string | number; why: string | number }
  'service.gitRepo.tagTaken': { name: string | number }
  'service.gitRepo.tagged': { commit: string | number; name: string | number }
  'service.gitRepo.taggedPushed': { commit: string | number; name: string | number; remote: string | number }
  'service.gitRepo.trackedNothing': { branch: string | number }
  'service.gitRepo.tracking': { pushed: string; branch: string | number; upstream: string | number }
  'service.gitRepo.untracked': { branch: string | number; upstream: string | number }
  'service.gitRepo.upToDate': { branch: string | number; upstream: string | number }
  'service.gitRepo.update.agentBusy': { agent: string | number; status: string; folder: string | number; branch: string | number }
  'service.gitRepo.update.conflict': { how: string; branch: string | number; target: string | number; files: string | number }
  'service.gitRepo.update.dirty': { folder: string | number; branch: string | number }
  'service.gitRepo.update.failed': { branch: string | number; target: string | number; why: string | number }
  'service.gitRepo.update.forwarded': { branch: string | number; target: string | number; commit: string | number }
  'service.gitRepo.update.isTarget': { branch: string | number }
  'service.gitRepo.update.merged': { target: string | number; branch: string | number; commit: string | number }
  'service.gitRepo.update.midOperation': { state: string | number; folder: string | number }
  'service.gitRepo.update.missed': { branch: string | number; target: string | number }
  'service.gitRepo.update.moved': { branch: string | number }
  'service.gitRepo.update.noTarget': { branch: string | number }
  'service.gitRepo.update.notUndone': { branch: string | number; target: string | number; folder: string | number; state: string; why: string | number }
  'service.gitRepo.update.notUndoneTemporary': { branch: string | number; target: string | number; folder: string | number; why: string | number }
  'service.gitRepo.update.queued': { card: string | number; branch: string | number }
  'service.gitRepo.update.rebased': { branch: string | number; n: number; target: string | number; commit: string | number }
  'service.gitRepo.update.temporaryLeft': { folder: string | number }
  'service.gitRepo.update.upToDate': { branch: string | number; target: string | number }
  'service.gitRepo.upstreamGone': { upstream: string | number }
  'service.gitRepo.urlChanged': { remote: string | number }
  'service.gitRepo.urlFailed': { remote: string | number; why: string | number }
  'service.intent.noWorkflow': { card: string | number }
  'service.intent.queueNotAgents': undefined
  'service.keys.closed': undefined
  'service.keys.form': undefined
  'service.keys.notice': { keys: string | number }
  'service.keys.noticeTitle': undefined
  'service.keys.prefix': { key: string | number; other: string | number }
  'service.keys.taken': { key: string | number }
  'service.keys.unknownProject': undefined
  'service.laneStart.busy': { status: string; agent: string | number }
  'service.laneStart.done': { card: string | number }
  'service.laneStart.needsReviewer': { project: string | number }
  'service.laneStart.noCards': undefined
  'service.laneStart.notTheProjects': { card: string | number; project: string | number }
  'service.laneStart.poolEmpty': { project: string | number }
  'service.laneStart.poolNotOffered': { project: string | number }
  'service.laneStart.sameAgent': undefined
  'service.laneStart.starting': { agent: string | number }
  'service.laneStart.unknownAgent': { agent: string | number; project: string | number }
  'service.laneStarts.freshBlockedBody': { why: string; minutes: number; reason: string | number }
  'service.laneStarts.freshBlockedTitle': { agent: string | number }
  'service.lanes.noWorkspace': undefined
  'service.lanes.targetBuilder': undefined
  'service.lanes.targetCard': { card: string | number; cardTarget: string | number; target: string | number }
  'service.lanes.targetFixed': { builder: string | number; target: string | number }
  'service.lanes.targetMissing': { unknown: string; target: string | number }
  'service.lanes.targetNotListed': { hasTargets: string; target: string | number; default: string | number; hasOthers: string; others: string | number }
  'service.lanes.targetRulesOff': undefined
  'service.lanes.teamPaused': undefined
  'service.lanes.unknown': { id: string | number }
  'service.mcp.addedDropped': { n: number }
  'service.mcp.addedTitle': undefined
  'service.metrics.badProvider': undefined
  'service.metrics.badRange': undefined
  'service.metrics.badRole': undefined
  'service.metrics.droppedPerProject': undefined
  'service.metrics.notCliContext': undefined
  'service.metrics.notNetwork': undefined
  'service.metrics.notPerProvider': undefined
  'service.metrics.notSkillReads': undefined
  'service.metrics.notTokens': undefined
  'service.metrics.notTransport': undefined
  'service.metrics.sharedNumbers': undefined
  'service.nameUpgrade.boardNotFolded': { file: string | number; log: string | number }
  'service.nameUpgrade.boardOrphan': { file: string | number; old: string | number }
  'service.nameUpgrade.failed': { what: string | number; error: string | number }
  'service.nameUpgrade.profileFailed': { files: string | number; n: number }
  'service.nextVersion.movedOn': { now: string | number; from: string | number }
  'service.nextVersion.noName': { from: string | number }
  'service.nextVersion.notBranch': { from: string | number }
  'service.nextVersion.notGit': undefined
  'service.nextVersion.partial': { name: string | number; commit: string | number; why: string | number; kept: string }
  'service.nextVersion.sameName': { from: string | number }
  'service.providers.keysStopped': { task: string | number; why: string | number }
  'service.providers.noSetup': { cli: string | number }
  'service.providers.notInstalled': { cli: string | number }
  'service.providers.pickNotFound': { task: string | number; item: string | number }
  'service.providers.retryUnavailable': undefined
  'service.providers.signInConnections': { cli: string | number }
  'service.providers.stillLooking': { cli: string | number }
  'service.providers.stillLookingAll': undefined
  'service.providers.stopFirst': { cli: string | number }
  'service.providers.stoppedBusy': { seconds: number }
  'service.providers.stoppedClosed': undefined
  'service.providers.task': { task: string; cli: string | number }
  'service.providers.taskDone': { task: string | number }
  'service.providers.taskFailed': { task: string | number; code: string | number }
  'service.providers.unknownHost': { cli: string | number }
  'service.slots.notPrepared': { slot: string | number; card: string | number; why: string | number }
  'service.slots.resumeFailed': { agent: string | number; slot: string | number; card: string | number; why: string | number }
  'service.slots.resumeHeld': { card: string | number; agent: string | number; slot: string | number; why: string | number }
  'service.templates.v09': { n: number }
  'service.templates.v09Title': undefined
  'service.transcripts.busy': undefined
  'service.transcripts.exported': { session: string | number; date: string | number }
  'service.transcripts.imageNotKept': undefined
  'service.transcripts.noImage': undefined
  'service.transcripts.noTool': undefined
  'service.transcripts.none': undefined
  'service.workflow.changedMeanwhile': undefined
  'service.workflow.closed': undefined
  'service.workflow.inheritor': { project: string | number }
  'service.workflow.targetInUse': { branch: string | number; uses: string | number }
  'service.workflow.targetMissing': { n: number; branches: string | number }
  'service.workflowNotice.blocked': { card: string | number; reason: string | number }
  'service.workflowNotice.blockedNoReason': { card: string | number }
  'service.workflowNotice.failed': { card: string | number }
  'service.workflowNotice.forYou': { card: string | number }
  'service.workflowNotice.lane': { lane: string | number }
  'service.workflowNotice.mergeDue': undefined
  'service.workflowNotice.mergeStalled': undefined
  'service.workflowNotice.merging': { card: string | number }
  'service.workflowNotice.notMerged': { card: string | number }
  'service.workflowNotice.safeguardGuidance': { provider: string | number }
  'service.workflowNotice.stalled': { card: string | number }
  'service.workflowNotice.stalledSafeguard': { card: string | number; agent: string | number; provider: string | number; time: string | number; stops: number }
  'service.workspace.advancedNotHere': { setting: string | number }
  'service.workspace.agentGone': undefined
  'service.workspace.badName': { chars: string | number }
  'service.workspace.closed': undefined
  'service.workspace.connectionGone': { agent: string | number }
  'service.workspace.folderExists': { name: string | number }
  'service.workspace.holdsOpen': { workspace: string | number; folder: string | number; name: string | number }
  'service.workspace.insideOpen': { folder: string | number; workspace: string | number }
  'service.workspace.nameIn': { name: string | number; projects: string | number }
  'service.workspace.namesShared': undefined
  'service.workspace.none': undefined
  'service.workspace.notFound': { folder: string | number }
  'service.workspace.notProject': { path: string | number }
  'service.workspace.notRoot': { path: string | number }
  'service.workspace.openElsewhere': { folder: string | number }
  'service.workspace.platformGitFound': { project: string | number }
  'service.workspace.platformInvalid': { project: string | number; value: string | number }
  'service.workspace.platformInvalidTitle': { project: string | number }
  'service.workspace.platformOpen': undefined
  'service.workspace.platformOtherFound': { vcs: string | number; project: string | number }
  'service.workspace.platformRepositoryGone': { project: string | number }
  'service.workspace.platformSettled': undefined
  'service.workspace.platformTitle': { project: string | number }
  'service.workspace.renameAgent': { project: string | number; agent: string | number }
  'service.workspace.sharedNames': { shared: string | number; project: string | number; agent: string | number; suggestion: string | number }
  'service.workspace.stillClosing': { name: string | number }
  'service.workspace.stillOpening': { name: string | number }
  'service.workspace.twoCalled': { name: string | number }
}
