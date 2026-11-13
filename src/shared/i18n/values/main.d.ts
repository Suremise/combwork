// Generated from locales/en/main.json: do not edit. Each message's placeholders and their types, for tr(): a
// global script, so its interface merges with every other area's (shared/i18n/msg.ts).
interface CombworkMessageValues {
  'main.accounts.badTarget': { target: string | number; cli: string | number }
  'main.accounts.checkHeld': { name: string | number; cli: string | number }
  'main.accounts.folderNotUsable': { name: string | number }
  'main.accounts.inUse': { name: string | number }
  'main.accounts.keyRemoveFailed': { name: string | number }
  'main.accounts.leftover': { name: string | number }
  'main.accounts.letGoFailed': { name: string | number }
  'main.accounts.makeFailed': { error: string | number }
  'main.accounts.noHome': { cli: string | number; folder: string | number }
  'main.accounts.noName': undefined
  'main.accounts.noProvider': { cli: string | number }
  'main.accounts.notFound': undefined
  'main.accounts.nothingToKeep': { name: string | number }
  'main.accounts.removeFailed': { name: string | number; error: string | number }
  'main.accounts.running': { name: string | number }
  'main.accounts.setUpCancelled': { name: string | number }
  'main.accounts.usageMove.bad': undefined
  'main.antivirus.allExcluded': undefined
  'main.antivirus.changed': undefined
  'main.antivirus.closed': undefined
  'main.antivirus.foldersChanged': undefined
  'main.antivirus.noWorkspace': undefined
  'main.antivirus.noneAdded': undefined
  'main.antivirus.notDefender': undefined
  'main.antivirus.notWaiting': undefined
  'main.antivirus.other': undefined
  'main.antivirus.timeout': { seconds: string | number }
  'main.antivirus.tooLong': undefined
  'main.antivirus.unreadable': undefined
  'main.antivirus.windowsOnly': undefined
  'main.assistantQuestion.answered': undefined
  'main.assistantQuestion.stop.message': { agent: string | number; state: string | number; hasReason: string; reason: string | number }
  'main.assistantQuestion.stop.no': undefined
  'main.assistantQuestion.stop.state': { status: string }
  'main.assistantQuestion.stop.title': { agent: string | number; project: string | number }
  'main.assistantQuestion.stop.yes': undefined
  'main.board.damagedBody': { files: string | number; folder: string | number }
  'main.board.damagedTitle': { n: number }
  'main.board.foundBody': { folder: string | number }
  'main.board.foundTitle': { n: number }
  'main.board.review': undefined
  'main.branchMerge.cardWork': { branch: string | number; card: string | number }
  'main.branchMerge.notBranch': { branch: string | number }
  'main.branchMerge.same': { branch: string | number }
  'main.combworkMove.bothBody': undefined
  'main.combworkMove.bothTitle': { folder: string | number }
  'main.combworkMove.linkBody': undefined
  'main.combworkMove.linkTitle': { folder: string | number }
  'main.combworkMove.what.cards': undefined
  'main.combworkMove.what.excludes': undefined
  'main.combworkMove.what.folders': undefined
  'main.combworkMove.what.notes': undefined
  'main.combworkMove.what.worktrees': undefined
  'main.connections.badMode': { cli: string | number; mode: string | number }
  'main.connections.beingRemoved': { name: string | number }
  'main.connections.choice.missing': { agent: string | number }
  'main.connections.choice.off': { name: string | number; agent: string | number }
  'main.connections.choice.otherCli': { name: string | number; agent: string | number }
  'main.connections.inUse': { name: string | number; users: string | number }
  'main.connections.launch.agentChanged': { agent: string | number }
  'main.connections.launch.busy': undefined
  'main.connections.launch.changedAgain': { agent: string | number }
  'main.connections.launch.changedMeanwhile': { name: string | number }
  'main.connections.launch.changing': { name: string | number; agent: string | number }
  'main.connections.launch.confirm': { agents: string | number; fingerprint: string | number }
  'main.connections.launch.deleted': { agent: string | number }
  'main.connections.launch.impactChanged': { agents: string | number; fingerprint: string | number }
  'main.connections.launch.noKey': { name: string | number; agent: string | number }
  'main.connections.launch.none': { cli: string | number; agent: string | number }
  'main.connections.launch.offHere': { n: number; cli: string | number; names: string | number; agent: string | number }
  'main.connections.launch.offNoDefault': { agent: string | number; name: string | number; cli: string | number }
  'main.connections.launch.offSide': { agent: string | number; part: string; lane: string | number; role: string }
  'main.connections.launch.otherProvider': { agent: string | number; cli: string | number }
  'main.connections.launch.projectMissing': { project: string | number }
  'main.connections.launch.projectUnreadable': { project: string | number; error: string | number }
  'main.connections.launch.projectUnusable': { project: string | number }
  'main.connections.launch.projectsUnread': { workspace: string | number }
  'main.connections.launch.signedOut': { name: string | number; agent: string | number }
  'main.connections.launch.unreadable': { error: string | number }
  'main.connections.moveFailed': { project: string | number }
  'main.connections.nameTaken': { account: string | number; name: string | number }
  'main.connections.noName': undefined
  'main.connections.notFound': undefined
  'main.connections.tagTooLong': { max: number }
  'main.connections.userIn': { agent: string | number; project: string | number }
  'main.console.noWorkspace': undefined
  'main.console.title': { workspace: string | number }
  'main.corrupt.damaged': { file: string | number }
  'main.corrupt.defaultsBody': { aside: string | number }
  'main.corrupt.restored': { file: string | number }
  'main.corrupt.restoredBody': { aside: string | number }
  'main.danger.off': { modes: string | number }
  'main.danger.offBody': { projects: string | number }
  'main.finished.inProject': { n: number; project: string | number }
  'main.finished.many': { n: number }
  'main.finished.project': { project: string | number; n: string | number }
  'main.freshStart.action': undefined
  'main.freshStart.body': { project: string | number }
  'main.freshStart.notFound': { agent: string | number }
  'main.freshStart.title': undefined
  'main.gitInit.already': undefined
  'main.gitInit.done': { steps: string | number }
  'main.gitInit.failed.commit': undefined
  'main.gitInit.failed.config': { key: string | number }
  'main.gitInit.failed.exclude': undefined
  'main.gitInit.failed.gitignore': undefined
  'main.gitInit.failed.identity': { which: string }
  'main.gitInit.failed.ignored': undefined
  'main.gitInit.failed.init': undefined
  'main.gitInit.failed.stage': undefined
  'main.gitInit.failed.staged': undefined
  'main.gitInit.fix.commit': { git: string | number }
  'main.gitInit.fix.identity': { which: string }
  'main.gitInit.fix.ignored': undefined
  'main.gitInit.fix.staged': undefined
  'main.gitInit.nested': { root: string | number }
  'main.gitInit.noEmail': undefined
  'main.gitInit.noGit': { problem: string | number }
  'main.gitInit.noName': undefined
  'main.gitInit.otherVcs': { vcs: string | number; root: string | number }
  'main.gitInit.step.commit': { n: number }
  'main.gitInit.step.empty': undefined
  'main.gitInit.step.gitignore': { gitignore: string | number }
  'main.gitInit.step.identity': undefined
  'main.gitInit.step.init': undefined
  'main.gitInit.stopped': { what: string | number; why: string | number }
  'main.gitInit.stoppedAfter': { done: string | number; what: string | number; why: string | number }
  'main.gitInit.unreadable': { why: string | number }
  'main.installDir.close': undefined
  'main.installDir.copied': undefined
  'main.installDir.copy': undefined
  'main.installDir.copyCommand': undefined
  'main.installDir.title': undefined
  'main.installDir.whatFile': undefined
  'main.installDir.whatFolder': undefined
  'main.installDir.whyFile': undefined
  'main.installDir.whyFolder': undefined
  'main.keys.maskingFull': undefined
  'main.keys.maskingUnreadable': undefined
  'main.keys.unsafe': undefined
  'main.leftovers.end': undefined
  'main.leftovers.keep': undefined
  'main.leftovers.leave': undefined
  'main.leftovers.offerChanged': undefined
  'main.leftovers.offerEnded': { n: number }
  'main.leftovers.offerEndedSome': { n: number; more: number }
  'main.leftovers.offerGone': undefined
  'main.leftovers.offerIncomplete': undefined
  'main.leftovers.offerKept': undefined
  'main.leftovers.offerNotEnded': { n: number }
  'main.leftovers.offerUnchecked': undefined
  'main.leftovers.quitDetail': { n: number }
  'main.leftovers.quitMessage': { n: number }
  'main.leftovers.restoredBody': { n: number; processes: string | number }
  'main.leftovers.restoredTitle': { n: number; agent: string | number }
  'main.mergeSlot.expiredBody': { agent: string | number; branch: string | number }
  'main.mergeSlot.expiredTitle': { agent: string | number }
  'main.mergeSlot.leftBody': { branch: string | number; hasCards: string; cards: string | number; folder: string | number }
  'main.mergeSlot.leftBodyGone': { branch: string | number; hasCards: string; cards: string | number; project: string | number; folder: string | number }
  'main.mergeSlot.leftTitle': { agent: string | number }
  'main.modes.retiredBody': { moved: string | number }
  'main.modes.retiredTitle': undefined
  'main.move.adoptFailed': { why: string | number }
  'main.move.already': undefined
  'main.move.alsoMoved': { n: number; things: string | number; from: string | number; to: string | number }
  'main.move.assistant': undefined
  'main.move.branchBoth': undefined
  'main.move.branchFailed': { host: string | number; from: string | number; agent: string | number; to: string | number; why: string | number }
  'main.move.branchGone': { host: string | number; from: string | number; agent: string | number }
  'main.move.branchQueued': undefined
  'main.move.branchRenamed': { host: string | number; from: string | number; agent: string | number; to: string | number }
  'main.move.branchRenamedRemote': { host: string | number; from: string | number; agent: string | number; to: string | number; remote: string | number }
  'main.move.branchTaken': { host: string | number; from: string | number; agent: string | number; to: string | number }
  'main.move.branchUnrecorded': { host: string | number; agent: string | number; to: string | number; why: string | number }
  'main.move.cards': { n: number; from: string | number; to: string | number }
  'main.move.cardsNotMoved': { host: string | number; agent: string | number; path: string | number; why: string | number }
  'main.move.closeRunsFailed': { why: string | number }
  'main.move.copied': { n: number; owner: string; host: string | number; provider: string | number; agent: string | number; of: string | number }
  'main.move.copyFailed': { n: number; owner: string; host: string | number; provider: string | number; folder: string | number; files: string | number; agent: string | number; of: string | number }
  'main.move.copyKept': { n: number; owner: string; host: string | number; provider: string | number; folder: string | number; files: string | number; agent: string | number; of: string | number }
  'main.move.defenderFailed': { why: string | number }
  'main.move.folder.busy': undefined
  'main.move.folder.failed': { host: string | number; what: string | number; path: string | number; why: string | number }
  'main.move.folder.forgotten': { host: string | number; what: string | number; path: string | number }
  'main.move.folder.homeMissing': { host: string | number; what: string | number; path: string | number }
  'main.move.folder.later': { host: string | number; what: string | number; path: string | number }
  'main.move.folder.movedTo': { host: string | number; what: string | number; path: string | number }
  'main.move.folder.original': { host: string | number; what: string | number; path: string | number; project: string | number }
  'main.move.folder.recreateFailed': { host: string | number; what: string | number; why: string | number }
  'main.move.folder.recreated': { host: string | number; what: string | number; branch: string | number; path: string | number }
  'main.move.folder.released': { host: string | number; what: string | number }
  'main.move.folder.relinked': { host: string | number; what: string | number; path: string | number }
  'main.move.folder.slotMissing': { hasBranch: string; host: string | number; what: string | number; path: string | number; branch: string | number }
  'main.move.gitFailed': { command: string | number }
  'main.move.lanes': { n: number }
  'main.move.madeNew': { host: string | number; agent: string | number; branch: string | number; path: string | number }
  'main.move.makeNewFailed': { host: string | number; agent: string | number; why: string | number }
  'main.move.missing': { host: string | number; agent: string | number; path: string | number }
  'main.move.missingNoBranch': { host: string | number; agent: string | number; path: string | number }
  'main.move.more': { n: number }
  'main.move.movedTo': { host: string | number; agent: string | number; path: string | number }
  'main.move.notRepaired': { host: string | number; agent: string | number; path: string | number }
  'main.move.notRepairedWhy': { host: string | number; agent: string | number; path: string | number; why: string | number }
  'main.move.nothing': undefined
  'main.move.original': { host: string | number; agent: string | number; path: string | number; project: string | number }
  'main.move.recent': { to: string | number; from: string | number }
  'main.move.recreateFailed': { host: string | number; agent: string | number; why: string | number }
  'main.move.recreated': { host: string | number; agent: string | number; branch: string | number; path: string | number }
  'main.move.relinked': { host: string | number; agent: string | number; path: string | number }
  'main.move.result.agentWorktree': { agent: string | number }
  'main.move.result.cards': { n: number }
  'main.move.result.copied': { n: number }
  'main.move.result.copyFailed': { n: number }
  'main.move.result.copyKept': { n: number }
  'main.move.result.failed': { why: string | number }
  'main.move.result.folderMissing': { kind: string; gone: string }
  'main.move.result.forgotten': undefined
  'main.move.result.given': { to: string | number; what: string | number }
  'main.move.result.gone': undefined
  'main.move.result.later': undefined
  'main.move.result.linked': undefined
  'main.move.result.missing': { gone: string }
  'main.move.result.notGiven': { to: string | number; why: string | number }
  'main.move.result.notRepaired': { hasWhy: string; why: string | number }
  'main.move.result.original': undefined
  'main.move.result.pruneBlocked': { n: number; worktrees: string | number }
  'main.move.result.recent': undefined
  'main.move.result.recreateFailed': { made: string; why: string | number }
  'main.move.result.recreated': { made: string }
  'main.move.result.released': undefined
  'main.move.result.renameFailed': { why: string | number }
  'main.move.result.renamed': { remote: string }
  'main.move.result.sessions': { n: number }
  'main.move.result.taken': undefined
  'main.move.result.unlinked': undefined
  'main.move.result.unrecorded': { why: string | number }
  'main.move.result.working': { projects: string | number }
  'main.move.running': { agents: string | number }
  'main.move.savedFailed': { from: string | number; to: string | number; why: string | number }
  'main.move.sessions': { n: number; host: string | number }
  'main.move.sessionsFailed': { host: string | number; why: string | number }
  'main.move.unlinked': { host: string | number; agent: string | number; path: string | number }
  'main.move.watches': { n: number }
  'main.move.workingMoved': { projects: string | number }
  'main.move.workingRenamed': { n: number; projects: string | number }
  'main.nameUpgrade.boardBothBody': undefined
  'main.nameUpgrade.boardBothTitle': { folder: string | number }
  'main.nameUpgrade.boardLeftBody': undefined
  'main.nameUpgrade.boardLeftTitle': { file: string | number }
  'main.nameUpgrade.profileTitle': undefined
  'main.nameUpgrade.what.board': undefined
  'main.nameUpgrade.what.files': undefined
  'main.nameUpgrade.what.projects': undefined
  'main.notify.answered': undefined
  'main.notify.sessionEnded': undefined
  'main.outage.gaveUpBody': { n: number }
  'main.outage.gaveUpTitle': { agent: string | number }
  'main.outage.progressTitle': { agent: string | number }
  'main.outage.progressWaiting': undefined
  'main.outage.resumedSummary': { dropped: string | number; back: string | number }
  'main.outage.timedOutBody': { minutes: number }
  'main.outage.timedOutTitle': { agent: string | number }
  'main.outcome.allowed': undefined
  'main.outcome.conversationEnded': undefined
  'main.outcome.conversationMoved': undefined
  'main.outcome.modesChanged': undefined
  'main.outcome.modesNextSession': undefined
  'main.outcome.modesNothing': undefined
  'main.outcome.namesDiffer': undefined
  'main.outcome.noLongerAsked': undefined
  'main.outcome.noLongerHeld': undefined
  'main.outcome.notResumed': undefined
  'main.outcome.offerReplaced': undefined
  'main.outcome.openHereAgain': undefined
  'main.outcome.released': undefined
  'main.outcome.resuming': undefined
  'main.outcome.runsAnother': undefined
  'main.outcome.stoppedAndResumed': undefined
  'main.outcome.updateInstalling': undefined
  'main.outcome.updateNotReady': undefined
  'main.plan.close': undefined
  'main.plan.pause': undefined
  'main.plan.resetsAt': { time: string | number }
  'main.plan.resetsOn': { when: string | number }
  'main.plan.used': { share: number; provider: string | number; window: string; hours: number; label: string | number }
  'main.plan.usedOn': { share: number; window: string; hours: number; label: string | number; connection: string | number }
  'main.profileMove.refused': { from: string | number; to: string | number; reason: string | number }
  'main.profileMove.refusedTitle': undefined
  'main.profileMove.signInBody': { names: string | number; n: number }
  'main.profileMove.signInTitle': { n: number }
  'main.quit.closed': undefined
  'main.quit.closedBody': { n: number }
  'main.quit.dialogTitle': undefined
  'main.removal.ahead': { n: number }
  'main.removal.already': { project: string | number }
  'main.removal.cardsKept': { why: string | number }
  'main.removal.deleteBlocked': { folders: string | number }
  'main.removal.dirty': { n: number }
  'main.removal.folder.copyBusy': undefined
  'main.removal.folder.copyHeld': { by: string | number }
  'main.removal.folder.copyLeased': undefined
  'main.removal.folder.deleting': undefined
  'main.removal.folder.heldNow': undefined
  'main.removal.folder.home': undefined
  'main.removal.folder.notCombwork': undefined
  'main.removal.folder.notForgotten': { why: string | number }
  'main.removal.folder.notHeld': { n: number }
  'main.removal.folder.notTrashed': { path: string | number; why: string | number }
  'main.removal.folder.outsideDelete': undefined
  'main.removal.folderGone': { folder: string | number }
  'main.removal.folderKept': { what: string | number; path: string | number; why: string | number }
  'main.removal.handoverKept': { note: string | number; why: string | number }
  'main.removal.heldTree': { agent: string | number; work: string | number }
  'main.removal.leftAlone': { worktree: string | number }
  'main.removal.notHidden': { project: string | number }
  'main.removal.notProject': { path: string | number }
  'main.removal.notTrashed': { path: string | number; why: string | number }
  'main.removal.refusedTree': { agent: string | number; path: string | number; why: string | number }
  'main.removal.stillThere': { project: string | number }
  'main.removal.stopFailed': { project: string | number }
  'main.removal.tooManyNames': { note: string | number }
  'main.removal.trashFailed': { project: string | number; why: string | number }
  'main.removal.unmerged': { worktrees: string | number }
  'main.removal.why.contains': undefined
  'main.removal.why.notListed': undefined
  'main.removal.why.otherProject': undefined
  'main.removal.wontRemove': { worktrees: string | number }
  'main.restart.dismiss': undefined
  'main.restart.notResumedLine': { agent: string | number; project: string | number; why: string | number }
  'main.restart.offerQuit': { names: string | number }
  'main.restart.offerTitle': { n: number }
  'main.restart.offerUpdate': { names: string | number }
  'main.restart.reportResume': { n: number }
  'main.restart.reportUpdate': { n: number }
  'main.restart.resume': undefined
  'main.restart.resumedLine': { names: string | number }
  'main.restart.why.expired': undefined
  'main.restart.why.held': undefined
  'main.restart.why.idle': undefined
  'main.restart.why.movedOn': undefined
  'main.restart.why.notReady': undefined
  'main.restart.why.notStopped': undefined
  'main.restart.why.removed': undefined
  'main.restart.why.running': undefined
  'main.restart.why.stopped': undefined
  'main.server.context.invalid': { max: number }
  'main.server.context.noModel': { model: string | number }
  'main.server.key.chars': undefined
  'main.server.key.inField': { field: string }
  'main.server.key.length': { min: number; max: number }
  'main.server.notServer': undefined
  'main.server.output.invalid': { max: number }
  'main.server.output.notBelow': { model: string | number; output: number; context: number }
  'main.server.setUp.noKey': { name: string | number }
  'main.server.unsupported': { cli: string | number }
  'main.server.url.extra': undefined
  'main.server.url.invalid': undefined
  'main.server.url.remoteHttp': undefined
  'main.server.url.scheme': undefined
  'main.server.url.userinfo': undefined
  'main.storage.claimed': undefined
  'main.storage.launchInUse': undefined
  'main.storage.noLonger': { path: string | number }
  'main.storage.purgeChanged': undefined
  'main.storage.purgeClaimed': undefined
  'main.storage.purgeExpired': undefined
  'main.storage.purgeLastCopy': undefined
  'main.storage.purgeNoLonger': undefined
  'main.storage.purgeNotKept': undefined
  'main.storage.purgeRunning': undefined
  'main.storage.purgeSessionChanged': undefined
  'main.storage.purgeUnrecorded': undefined
  'main.storage.running': undefined
  'main.storage.unarchived': undefined
  'main.tray.active': undefined
  'main.tray.cancelQuit': undefined
  'main.tray.counts': { working: string | number; needYou: number }
  'main.tray.finished': undefined
  'main.tray.more': { n: number }
  'main.tray.needYou': undefined
  'main.tray.noProjects': undefined
  'main.tray.quit': undefined
  'main.tray.quitNow': undefined
  'main.tray.quitting': { n: number }
  'main.tray.restartToUpdate': { version: string | number }
  'main.tray.section': { title: string | number; n: string | number }
  'main.tray.settings': undefined
  'main.tray.show': undefined
  'main.tray.status.background': undefined
  'main.tray.status.error': undefined
  'main.tray.status.finished': undefined
  'main.tray.status.ready': undefined
  'main.tray.status.signin': undefined
  'main.tray.status.starting': undefined
  'main.tray.status.stopped': undefined
  'main.tray.status.waiting': undefined
  'main.tray.status.watching': undefined
  'main.tray.status.working': undefined
  'main.tray.statusOfMany': { n: number; status: string | number }
  'main.tray.toReview': undefined
  'main.tray.willQuit': undefined
  'main.unexpectedClose.agents': { n: number; projects: string | number }
  'main.unexpectedClose.dump': undefined
  'main.unexpectedClose.failed': { n: number; agents: string | number }
  'main.unexpectedClose.held': { n: number; agents: string | number }
  'main.unexpectedClose.heldTitle': { n: number }
  'main.unexpectedClose.merge': { agent: string | number; branch: string | number; folder: string | number }
  'main.unexpectedClose.mergeCards': { agent: string | number; branch: string | number; cards: string | number; folder: string | number }
  'main.unexpectedClose.notChecked': { u: number; ids: string | number }
  'main.unexpectedClose.notResumed': undefined
  'main.unexpectedClose.notStopped': { n: number }
  'main.unexpectedClose.notStoppedNorChecked': { n: number; u: number; ids: string | number }
  'main.unexpectedClose.overview': undefined
  'main.unexpectedClose.progressRun': { title: string | number; n: number }
  'main.unexpectedClose.resumeAll': undefined
  'main.unexpectedClose.resumeFailedTitle': undefined
  'main.unexpectedClose.resumed': { n: number }
  'main.unexpectedClose.resumedTitle': { n: number }
  'main.unexpectedClose.stillRunning': { n: number; processes: string | number }
  'main.unexpectedClose.stopThem': undefined
  'main.unexpectedClose.stopped': { n: number }
  'main.unexpectedClose.title': undefined
  'main.unexpectedClose.when': { date: string | number; time: string | number }
  'main.unused.branchKept': { branch: string | number; why: string | number }
  'main.unused.cantCheck': { why: string | number }
  'main.unused.changed': { changed: string | number }
  'main.unused.field.ahead': undefined
  'main.unused.field.branch': undefined
  'main.unused.field.dirty': undefined
  'main.unused.field.files': undefined
  'main.unused.field.head': undefined
  'main.unused.field.into': undefined
  'main.unused.field.intoTip': undefined
  'main.unused.field.path': undefined
  'main.unused.gitFailed': { command: string | number }
  'main.unused.gone': undefined
  'main.unused.kept': undefined
  'main.unused.noBase': undefined
  'main.unused.noIndex': { why: string | number }
  'main.unused.notChecked': undefined
  'main.unused.nothingToMerge': undefined
  'main.unused.ownedMerge': undefined
  'main.unused.read.base': { branch: string | number }
  'main.unused.read.branch': undefined
  'main.unused.read.commits': undefined
  'main.unused.read.head': undefined
  'main.unused.read.status': undefined
  'main.unused.refused': { why: string | number }
  'main.unused.slot.archiveFailed': { error: string | number }
  'main.unused.slot.busy': undefined
  'main.unused.slot.cantCheck': { detail: string | number }
  'main.unused.slot.dirty': { files: number }
  'main.unused.slot.editedSkillCopy': { copies: number; names: string | number }
  'main.unused.slot.gitRefused': { detail: string | number }
  'main.unused.slot.inFlight': { card: string | number }
  'main.unused.slot.leased': { agent: string | number }
  'main.unused.slot.process': undefined
  'main.unused.slot.session': { detail: string | number }
  'main.unused.slot.unmerged': { target: string | number }
  'main.unused.stale': { n: number }
  'main.unused.tooBig': { n: number }
  'main.unused.tooMany': { n: number }
  'main.unused.why.contains': undefined
  'main.unused.why.detached': undefined
  'main.unused.why.notListed': undefined
  'main.unused.why.notUnused': undefined
  'main.unused.why.otherProject': undefined
  'main.unused.why.owned': undefined
  'main.unused.why.queueBusy': undefined
  'main.unused.why.session': undefined
  'main.unused.why.slotGuarded': undefined
  'main.unused.why.slotInUse': undefined
  'main.update.checksum': undefined
  'main.update.devBuild': undefined
  'main.update.noRelease': undefined
  'main.update.notInstalled': { app: string | number; version: string | number }
  'main.update.notInstalledNotNewer': undefined
  'main.update.notInstalledUnreadable': undefined
  'main.update.offline': undefined
  'main.update.openReleasePage': undefined
  'main.update.ready': { app: string | number; version: string | number }
  'main.update.readyAuto': undefined
  'main.update.readyManual': undefined
  'main.update.restart': undefined
  'main.update.sameVersion': { app: string | number; version: string | number }
  'main.update.sameVersionBody': { version: string | number; hasCommit: string; commit: string | number }
  'main.update.testCopy': undefined
  'main.update.updated': { app: string | number; version: string | number }
  'main.update.updatedBody': undefined
  'main.update.whatsNew': undefined
  'main.usageMove.blockedBody': { reason: string; to: string | number; share: number; window: string; workspace: string | number; agents: string | number }
  'main.usageMove.blockedTitle': { from: string | number; to: string | number }
  'main.usageMove.movedAgent': { agent: string | number; by: string; tag: string | number }
  'main.usageMove.movedBody': { from: string | number; share: number; window: string; agents: string | number; to: string | number }
  'main.usageMove.movedTitle': { count: number; from: string | number; to: string | number }
  'main.viewerTokens.noName': undefined
  'main.viewerTokens.taken': { name: string | number }
  'main.viewerTokens.tooLong': { most: number }
  'main.viewerTokens.tooMany': { most: number }
  'main.window.openLogs': undefined
  'main.window.quit': undefined
  'main.window.reload': undefined
  'main.window.reloaded': undefined
  'main.window.reloadedLost': { n: number }
  'main.window.reloadedTitle': undefined
  'main.window.stillRunning': undefined
  'main.window.stopped': undefined
  'main.window.unresponsive': undefined
  'main.window.unresponsiveDetail': { stillRunning: string | number }
  'main.window.wait': undefined
}
