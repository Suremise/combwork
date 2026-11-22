// Generated from locales/en/git.json: do not edit. Each message's placeholders and their types, for tr(): a
// global script, so its interface merges with every other area's (shared/i18n/msg.ts).
interface CombworkMessageValues {
  'git.branch.delete': undefined
  'git.branch.deleteMergedMessage': { target: string | number }
  'git.branch.deleteMergedTitle': { branch: string | number }
  'git.branch.deleteMore': { n: number }
  'git.branch.deleteTip': { branch: string | number }
  'git.branch.deleteUnmergedMessage': { n: number; target: string | number; branch: string | number }
  'git.branch.deleteUnmergedTitle': { n: number; branch: string | number }
  'git.branch.dropsFailed': { branch: string | number }
  'git.branches.branch': undefined
  'git.branches.cardOpen': { card: string | number; stage: string | number }
  'git.branches.checkedOut': { where: string; agent: string | number }
  'git.branches.cleanUp': undefined
  'git.branches.cleanUpTip': { n: number; target: string | number }
  'git.branches.copyRevision': { revision: string | number }
  'git.branches.deletingOn': { remote: string | number }
  'git.branches.earlierCards': { n: number }
  'git.branches.group': { group: string; target: string | number }
  'git.branches.groupTip': { group: string; target: string | number }
  'git.branches.heading': undefined
  'git.branches.loadTarget': undefined
  'git.branches.merge': { branch: string | number }
  'git.branches.merged': { has: string; revision: string | number }
  'git.branches.noCommits': undefined
  'git.branches.notInTarget': { n: number; target: string | number }
  'git.branches.openOperation': undefined
  'git.branches.reload': undefined
  'git.branches.remote': { count: number }
  'git.branches.revisionCopied': undefined
  'git.branches.stateBanner': { state: string }
  'git.branches.trackLocal': { branch: string | number; remote: string | number }
  'git.branches.tracks': { upstream: string | number; aheadBehind: string | number }
  'git.branches.tracksNothing': undefined
  'git.branches.underReview': { revision: string | number }
  'git.busy.agent': { agent: string | number; status: string; action: string }
  'git.busy.slotHeld': { agent: string | number; branch: string | number; action: string }
  'git.busy.slotWaiting': { agents: string | number; count: number; branch: string | number; action: string }
  'git.busy.yourMerge': { branch: string | number; action: string }
  'git.cancel': undefined
  'git.cleanUp.delete': undefined
  'git.cleanUp.deleting': undefined
  'git.cleanUp.failed': undefined
  'git.cleanUp.local': { n: number }
  'git.cleanUp.message': { target: string | number }
  'git.cleanUp.none': undefined
  'git.cleanUp.remote': { remotes: string | number; n: number }
  'git.cleanUp.remoteWarn': undefined
  'git.cleanUp.title': undefined
  'git.cleanUp.withLocal': undefined
  'git.combworkVcs.checking': undefined
  'git.combworkVcs.dismiss': undefined
  'git.combworkVcs.exclude': undefined
  'git.combworkVcs.excludeFailed': undefined
  'git.combworkVcs.excludedDone': { project: string | number }
  'git.combworkVcs.excluding': undefined
  'git.combworkVcs.ignoredBut': { synced: string | number; why: string | number }
  'git.combworkVcs.more': { count: number }
  'git.combworkVcs.noVcs': undefined
  'git.combworkVcs.notExcluded': undefined
  'git.combworkVcs.notExcludedTitle': undefined
  'git.combworkVcs.otherVcs': { vcs: string | number }
  'git.combworkVcs.synced': { service: string | number }
  'git.combworkVcs.syncedTitle': { service: string | number }
  'git.combworkVcs.titleSentence': { title: string | number }
  'git.combworkVcs.trackedDetail': { count: number; notExcluded: string }
  'git.combworkVcs.trackedTitle': { count: number }
  'git.combworkVcs.untrack': undefined
  'git.combworkVcs.untrackButton': undefined
  'git.combworkVcs.untrackFailed': undefined
  'git.combworkVcs.untrackMessage': { count: number; project: string | number }
  'git.combworkVcs.untrackTitle': { count: number }
  'git.combworkVcs.untracked': { project: string | number }
  'git.combworkVcs.untrackedDetail': undefined
  'git.combworkVcs.untracking': undefined
  'git.combworkVcs.why': undefined
  'git.fetch.at': { when: string | number }
  'git.fetch.button': undefined
  'git.fetch.failed': undefined
  'git.fetch.never': undefined
  'git.fetch.tip': undefined
  'git.form.enterName': undefined
  'git.gitlink.binary': undefined
  'git.gitlink.dirty': undefined
  'git.gitlink.hideGit': undefined
  'git.gitlink.showGit': undefined
  'git.gitlink.summary': { change: string; path: string | number; from: string | number; to: string | number }
  'git.head.detachedAt': { commit: string | number }
  'git.head.noCommits': undefined
  'git.health.about': undefined
  'git.health.fetch.busy': undefined
  'git.health.fetch.button': undefined
  'git.health.fetch.checkFailed': undefined
  'git.health.fetch.checking': undefined
  'git.health.fetch.confirm': undefined
  'git.health.fetch.fetching': { remotes: string | number }
  'git.health.fetch.head': undefined
  'git.health.fetch.message': { n: number }
  'git.health.fetch.remote': { remote: string | number; n: number }
  'git.health.fetch.remoteError': { remote: string | number; why: string | number }
  'git.health.fetch.state': { n: number }
  'git.health.fetch.title': undefined
  'git.health.fetch.trackedBy': { branches: string | number; n: number }
  'git.health.locks.age': { when: string | number }
  'git.health.locks.busy': undefined
  'git.health.locks.button': undefined
  'git.health.locks.confirm': undefined
  'git.health.locks.failed': undefined
  'git.health.locks.head': undefined
  'git.health.locks.held': { why: string; seconds: number; name: string | number; pid: number; when: string | number }
  'git.health.locks.message': { seconds: number }
  'git.health.locks.state': { n: number; stale: number }
  'git.health.locks.title': undefined
  'git.health.prune.busy': undefined
  'git.health.prune.button': undefined
  'git.health.prune.confirm': undefined
  'git.health.prune.failed': undefined
  'git.health.prune.head': undefined
  'git.health.prune.message': undefined
  'git.health.prune.noFolder': { id: string | number }
  'git.health.prune.ownerAgent': { name: string | number }
  'git.health.prune.ownerSlot': { name: string | number }
  'git.health.prune.state': { n: number }
  'git.health.prune.title': undefined
  'git.health.readAgain': undefined
  'git.health.readFailed': { error: string | number }
  'git.health.reading': undefined
  'git.health.title': undefined
  'git.history.branch': undefined
  'git.history.heading': undefined
  'git.history.headingOf': { head: string | number }
  'git.history.loadTarget': undefined
  'git.history.local': undefined
  'git.history.noCommits': undefined
  'git.history.option': { kind: string; branch: string | number }
  'git.history.reload': undefined
  'git.history.remote': undefined
  'git.identity.about': { hasGlobal: string; project: string | number; global: string | number }
  'git.identity.email': undefined
  'git.identity.global': undefined
  'git.identity.heading': undefined
  'git.identity.missing': { missing: string }
  'git.identity.name': undefined
  'git.identity.namePlaceholder': undefined
  'git.identity.notSet': undefined
  'git.identity.public': { email: string | number }
  'git.identity.save': undefined
  'git.identity.saving': undefined
  'git.identity.set': undefined
  'git.identity.thisRepo': undefined
  'git.identity.title': undefined
  'git.identity.used': undefined
  'git.init.button': undefined
  'git.init.cancel': undefined
  'git.init.close': undefined
  'git.init.commitsAs': { name: string | number; email: string | number }
  'git.init.committing': undefined
  'git.init.conditional': { missing: string }
  'git.init.enterEmail': undefined
  'git.init.enterName': undefined
  'git.init.firstCommitButton': undefined
  'git.init.gitignore.dotnet': undefined
  'git.init.gitignore.godot': undefined
  'git.init.gitignore.minimal': undefined
  'git.init.gitignore.node': undefined
  'git.init.gitignore.none': undefined
  'git.init.gitignore.python': undefined
  'git.init.gitignoreName': { choice: string; kind: string | number }
  'git.init.initialise': undefined
  'git.init.initialising': undefined
  'git.init.kept': undefined
  'git.init.looking': undefined
  'git.init.makeFirstCommit': undefined
  'git.init.makes': { name: string | number; empty: string }
  'git.init.namePlaceholder': undefined
  'git.init.nested': { folder: string | number }
  'git.init.nestedAnyway': { folder: string | number }
  'git.init.noIdentity': { missing: string }
  'git.init.noReply': undefined
  'git.init.ownRepoButton': undefined
  'git.init.resume': { name: string | number; empty: string; gitignore: string }
  'git.init.starterGitignore': undefined
  'git.init.title': { project: string | number }
  'git.init.titleResume': { project: string | number }
  'git.init.yourEmail': undefined
  'git.init.yourName': undefined
  'git.learnMore': undefined
  'git.moves.about': undefined
  'git.moves.back': { n: number }
  'git.moves.branch': undefined
  'git.moves.cantTitle': { branch: string | number }
  'git.moves.confirm': undefined
  'git.moves.dropped': { n: number }
  'git.moves.failed': undefined
  'git.moves.heading': undefined
  'git.moves.inTheWay': undefined
  'git.moves.loadFailed': { error: string | number }
  'git.moves.more': { n: number }
  'git.moves.moveLine': { branch: string | number; from: string | number; to: string | number }
  'git.moves.noBranch': undefined
  'git.moves.none': undefined
  'git.moves.nothing': undefined
  'git.moves.now': undefined
  'git.moves.ok': undefined
  'git.moves.openCard': { card: string | number }
  'git.moves.option': { kind: string; branch: string | number }
  'git.moves.pushed': { n: number; upstream: string | number }
  'git.moves.reload': undefined
  'git.moves.restore': undefined
  'git.moves.restoreTip': { branch: string | number; commit: string | number }
  'git.moves.running': undefined
  'git.moves.tip': { message: string | number; commit: string | number; when: string | number }
  'git.moves.title': { branch: string | number; commit: string | number }
  'git.moves.view': { view: string }
  'git.moves.viewName': undefined
  'git.moves.wayBack': undefined
  'git.moves.what': { kind: string; name: string | number }
  'git.moves.whereNowhere': { branch: string | number }
  'git.moves.whereProject': undefined
  'git.newBranch.blocked': { why: string | number }
  'git.newBranch.button': undefined
  'git.newBranch.commitFirst': undefined
  'git.newBranch.create': undefined
  'git.newBranch.message': { onBranch: string; commit: string | number; current: string | number }
  'git.newBranch.name': undefined
  'git.newBranch.noSpaces': undefined
  'git.newBranch.noStart': { ref: string | number }
  'git.newBranch.noStartAt': { ref: string | number }
  'git.newBranch.placeholder': undefined
  'git.newBranch.resolved': { kind: string; commit: string | number; subject: string | number }
  'git.newBranch.startsAt': undefined
  'git.newBranch.startsAtHint': undefined
  'git.newBranch.switchElsewhere': undefined
  'git.newBranch.switchNow': undefined
  'git.newBranch.tip': { commit: string | number }
  'git.newBranch.title': undefined
  'git.operation.abort': undefined
  'git.operation.abortMessage': { what: string }
  'git.operation.abortTitle': { what: string; folder: string | number }
  'git.operation.at': { commit: string | number; subject: string | number }
  'git.operation.conflicts': { count: number }
  'git.operation.continue': undefined
  'git.operation.done': { step: string; what: string; folder: string | number }
  'git.operation.endBisect': undefined
  'git.operation.failed': undefined
  'git.operation.goOn': undefined
  'git.operation.leftFrom': { from: string; stash: string | number }
  'git.operation.leftTheirsTip': { from: string; stash: string | number; has: string; command: string | number }
  'git.operation.leftTitle': { folder: string | number }
  'git.operation.lentMessage': { agent: string | number; what: string | number }
  'git.operation.lentTitle': { slot: string | number; card: string; lane: string | number }
  'git.operation.mine': undefined
  'git.operation.mineTip': { swap: string; has: string; command: string | number }
  'git.operation.open': undefined
  'git.operation.projectFolder': undefined
  'git.operation.readFailed': { error: string | number }
  'git.operation.resolved': undefined
  'git.operation.resolvedTip': { command: string | number }
  'git.operation.runs': { command: string | number }
  'git.operation.skip': undefined
  'git.operation.skipMessage': undefined
  'git.operation.skipTitle': { commit: string; what: string | number }
  'git.operation.step': { at: number; of: number }
  'git.operation.stoppedAgain': { step: string; what: string | number; folder: string | number }
  'git.operation.submoduleStaged': { path: string | number; commit: string | number; command: string }
  'git.operation.theirs': undefined
  'git.operation.theirsStash': undefined
  'git.operation.theirsTip': { swap: string; has: string; command: string | number }
  'git.operation.title': { what: string | number; folder: string | number }
  'git.operation.unreadable': undefined
  'git.operation.unresolved': { count: number }
  'git.parentRepo': { folder: string | number }
  'git.problem.agentSetup': undefined
  'git.problem.cantRead': { problem: string | number }
  'git.pull.busy': undefined
  'git.pull.button': undefined
  'git.pull.detached': undefined
  'git.pull.failed': undefined
  'git.pull.noUpstream': { branch: string | number }
  'git.pull.state': { state: string }
  'git.pull.tip': { upstream: string | number; branch: string | number }
  'git.push.busy': undefined
  'git.push.button': undefined
  'git.push.detached': undefined
  'git.push.failed': { branch: string | number }
  'git.push.message': { branch: string | number }
  'git.push.noCommits': undefined
  'git.push.noRemote': undefined
  'git.push.remote': undefined
  'git.push.tipTo': { branch: string | number; upstream: string | number }
  'git.push.tipTrack': { branch: string | number }
  'git.push.title': { branch: string | number }
  'git.pushTo.about': { onBranch: string; branch: string | number }
  'git.pushTo.all': undefined
  'git.pushTo.button': undefined
  'git.pushTo.thisBranch': { branch: string | number }
  'git.pushTo.tip': { branch: string | number }
  'git.pushTo.title': undefined
  'git.pushTo.what': undefined
  'git.queue.cancelled': { reason: string }
  'git.queue.cancelledShort': undefined
  'git.queue.card': undefined
  'git.queue.history': { target: string | number }
  'git.queue.merged': { result: string | number }
  'git.queue.mergedShort': undefined
  'git.queue.noHistory': undefined
  'git.queue.none': undefined
  'git.queue.open': { card: string | number }
  'git.queue.outcome': undefined
  'git.queue.past': { n: number }
  'git.queue.pastPick': undefined
  'git.queue.pastTip': undefined
  'git.queue.purge': undefined
  'git.queue.purgeAll': undefined
  'git.queue.purgeConfirm': undefined
  'git.queue.purgeMessage': { n: number }
  'git.queue.purgeTitle': { n: number; target: string | number }
  'git.queue.purging': undefined
  'git.queue.reading': undefined
  'git.queue.region': undefined
  'git.queue.result': undefined
  'git.queue.returned': { why: string | number }
  'git.queue.returnedShort': undefined
  'git.queue.revision': undefined
  'git.queue.title': undefined
  'git.queue.when': undefined
  'git.reading': undefined
  'git.remote.change': undefined
  'git.remote.changeFailed': { remote: string | number }
  'git.remote.changeTitle': { remote: string | number }
  'git.remote.removeButton': undefined
  'git.remote.removeDetail': { remote: string | number }
  'git.remote.removeFailed': { remote: string | number }
  'git.remote.removeMessage': { n: number; remote: string | number }
  'git.remote.removeTip': { remote: string | number }
  'git.remote.removeTitle': { remote: string | number }
  'git.remote.removing': undefined
  'git.remote.renameButton': undefined
  'git.remote.renameFailed': { remote: string | number }
  'git.remote.renameMessage': undefined
  'git.remote.renameTip': { remote: string | number }
  'git.remote.renameTitle': { remote: string | number }
  'git.remote.taken': { remote: string | number }
  'git.remotes.add': undefined
  'git.remotes.addAbout': undefined
  'git.remotes.addButton': undefined
  'git.remotes.addTitle': undefined
  'git.remotes.adding': undefined
  'git.remotes.heading': undefined
  'git.remotes.name': undefined
  'git.remotes.none': undefined
  'git.remotes.pushesTo': { url: string | number }
  'git.remotes.url': undefined
  'git.repoLock.busy': { profile: string | number }
  'git.repoLock.noGitDir': { folder: string | number; why: string | number }
  'git.repoLock.order': undefined
  'git.repoLock.waiting': { profile: string | number }
  'git.repoLock.waitingFor': { seconds: number }
  'git.repoOp.notOffered': undefined
  'git.retry': undefined
  'git.section.branches': undefined
  'git.section.changes': undefined
  'git.section.history': undefined
  'git.section.queue': undefined
  'git.section.workflow': undefined
  'git.setup.howTo': undefined
  'git.setup.learnMore': undefined
  'git.setup.notRepo': { project: string | number }
  'git.setup.withoutGit': undefined
  'git.signing.cantSign': { message: string | number }
  'git.signing.checkAgain': undefined
  'git.signing.checking': undefined
  'git.signing.couldNotComplete': undefined
  'git.signing.defaultKey': undefined
  'git.signing.format': undefined
  'git.signing.formatName': { format: string }
  'git.signing.heading': undefined
  'git.signing.howGpg': undefined
  'git.signing.howSsh': undefined
  'git.signing.key': undefined
  'git.signing.limits': undefined
  'git.signing.needsSomeone': undefined
  'git.signing.no': undefined
  'git.signing.notChecked': { why: string; path: string | number }
  'git.signing.off': undefined
  'git.signing.program': undefined
  'git.signing.scope': { scope: string }
  'git.signing.signs': undefined
  'git.signing.unattended': undefined
  'git.signing.unreadable': { message: string | number }
  'git.signing.yes': undefined
  'git.stash.applied': { dropped: string; folder: string | number }
  'git.stash.apply': undefined
  'git.stash.applyMessage': { name: string | number; files: number; folder: string | number; pop: string }
  'git.stash.applyTip': { folder: string | number }
  'git.stash.applyTitle': { pop: string; folder: string | number }
  'git.stash.binary': undefined
  'git.stash.close': undefined
  'git.stash.combwork': { why: string; card: string | number; target: string | number; text: string | number }
  'git.stash.conflicts': { count: number; folder: string | number }
  'git.stash.conflictsDetail': { files: string | number }
  'git.stash.diffFailed': { error: string | number }
  'git.stash.drop': undefined
  'git.stash.dropMessage': { files: number; card: string; commit: string | number }
  'git.stash.dropTip': undefined
  'git.stash.dropTitle': { name: string | number }
  'git.stash.dropped': { commit: string | number }
  'git.stash.failed': undefined
  'git.stash.fileTip': undefined
  'git.stash.filesFailed': { error: string | number }
  'git.stash.filesLoading': undefined
  'git.stash.goOn': undefined
  'git.stash.hide': undefined
  'git.stash.inStash': { name: string | number }
  'git.stash.inline': { inline: string }
  'git.stash.lentMessage': { agent: string | number }
  'git.stash.lentTitle': { slot: string | number; card: string; lane: string | number }
  'git.stash.meta': { branch: string; when: string | number; files: number }
  'git.stash.openCard': { card: string | number }
  'git.stash.otherBranch': { branch: string | number; folder: string | number; current: string | number }
  'git.stash.pop': undefined
  'git.stash.popTip': { folder: string | number }
  'git.stash.projectFolder': undefined
  'git.stash.readFailed': { error: string | number }
  'git.stash.show': undefined
  'git.stash.title': undefined
  'git.stash.toggle': { open: string }
  'git.stash.untracked': undefined
  'git.state': { state: string }
  'git.status.aheadBehind': { ahead: number; behind: number }
  'git.status.noUpstream': undefined
  'git.statusBar.tip': undefined
  'git.switch.button': undefined
  'git.switch.detachedHead': undefined
  'git.switch.failed': { branch: string | number }
  'git.switch.idle': { agents: string | number; count: number; branch: string | number }
  'git.switch.message': { current: string | number; branch: string | number }
  'git.switch.tip': { branch: string | number }
  'git.switch.title': { project: string | number; branch: string | number }
  'git.tags.about': { onBranch: string; branch: string | number }
  'git.tags.busy': undefined
  'git.tags.create': undefined
  'git.tags.createButton': undefined
  'git.tags.dontPush': undefined
  'git.tags.heading': undefined
  'git.tags.message': undefined
  'git.tags.name': undefined
  'git.tags.noSpaces': undefined
  'git.tags.none': undefined
  'git.tags.older': { count: number }
  'git.tags.optional': undefined
  'git.tags.pushTo': undefined
  'git.tags.title': { commit: string | number }
  'git.tags.titleNoCommit': undefined
  'git.tip.click': undefined
  'git.tip.detached': { commit: string | number }
  'git.tip.fetched': { when: string | number }
  'git.tip.gone': { upstream: string | number }
  'git.tip.neverFetched': undefined
  'git.tip.noCommits': undefined
  'git.tip.noRemotes': undefined
  'git.tip.noTracking': undefined
  'git.tip.on': { branch: string | number }
  'git.tip.state': { state: string }
  'git.tip.tracks': { upstream: string | number; ahead: number; behind: number }
  'git.tool.fixMissing': { min: string | number }
  'git.tool.fixOld': { min: string | number }
  'git.tool.missing': undefined
  'git.tool.oldLoses': { lost: string; version: string | number }
  'git.tool.tooOld': { version: string | number; min: string | number }
  'git.tool.tooOldToRun': { version: string | number }
  'git.track.about': { tracks: string; branch: string | number; upstream: string | number }
  'git.track.button': undefined
  'git.track.pushFirst': { remote: string | number; branch: string | number; local: string | number }
  'git.track.remoteBranch': undefined
  'git.track.tip': { branch: string | number }
  'git.track.title': { branch: string | number }
  'git.untrack.button': undefined
  'git.untrack.failed': { branch: string | number; upstream: string | number }
  'git.untrack.message': { branch: string | number }
  'git.untrack.tip': { upstream: string | number }
  'git.untrack.title': { branch: string | number; upstream: string | number }
  'git.update.agents': { agents: string | number; n: number }
  'git.update.approval': { approval: string; card: string | number }
  'git.update.behind': { n: number; target: string | number }
  'git.update.busy': undefined
  'git.update.card': { card: string | number }
  'git.update.confirm': undefined
  'git.update.counts': { target: string | number; behind: number; branch: string | number; ahead: number }
  'git.update.forward': { target: string | number }
  'git.update.forwardNote': { branch: string | number; target: string | number }
  'git.update.how': undefined
  'git.update.merge': { target: string | number }
  'git.update.mergeNote': { target: string | number; branch: string | number }
  'git.update.planFailed': { branch: string | number }
  'git.update.rebase': { target: string | number }
  'git.update.rebaseNote': { branch: string | number; n: number; target: string | number; pushed: string }
  'git.update.tip': { branch: string | number; target: string | number }
  'git.update.title': { branch: string | number; target: string | number }
  'git.update.undone': { branch: string | number }
  'git.update.where': { where: string; branch: string | number; slot: string | number; folder: string | number }
  'git.upstream.gone': undefined
  'git.validate.enterName': undefined
  'git.validate.enterUrl': undefined
  'git.validate.nameLine': undefined
  'git.validate.notEmail': undefined
  'git.validate.notUrl': undefined
  'git.validate.remoteName': undefined
  'git.validate.wholeUrl': undefined
  'git.vc.choice': undefined
  'git.vc.fact.gone': undefined
  'git.vc.fact.none': undefined
  'git.vc.fact.other': { vcs: string | number }
  'git.vc.fact.otherGit': { vcs: string | number }
  'git.vc.fact.repo': { root: string | number }
  'git.vc.fact.subfolder': { root: string | number }
  'git.vc.git': undefined
  'git.vc.initHint': undefined
  'git.vc.initOwnHint': undefined
  'git.vc.insideRepo': { root: string | number }
  'git.vc.noCommitYet': undefined
  'git.vc.none': undefined
  'git.vc.notRepoYet': undefined
  'git.vc.offer.gitFound': { root: string | number }
  'git.vc.offer.notNow': undefined
  'git.vc.offer.otherFound': { vcs: string | number }
  'git.vc.offer.repositoryGone': undefined
  'git.vc.offer.switchGit': undefined
  'git.vc.offer.switchNone': undefined
  'git.vc.previewTip': undefined
  'git.vc.sections': undefined
  'git.vc.step.cantSave': undefined
  'git.vc.step.choose': { preset: string | number }
  'git.vc.step.confirmTitle': { preset: string | number; project: string | number }
  'git.vc.step.customise': undefined
  'git.vc.step.details': { preset: string | number }
  'git.vc.step.hideDetails': { preset: string | number }
  'git.vc.step.intro': undefined
  'git.vc.step.introNone': undefined
  'git.vc.step.keeps': { n: number }
  'git.vc.step.notNow': undefined
  'git.vc.step.nothing': undefined
  'git.vc.step.presets': undefined
  'git.vc.step.saved': { project: string | number; preset: string | number }
  'git.vc.step.suggested': undefined
  'git.vc.step.title': undefined
  'git.vc.step.use': { preset: string | number }
  'git.vc.step.why': { why: string }
  'git.vc.stepNotice.choose': undefined
  'git.vc.stepNotice.notNow': undefined
  'git.vc.stepNotice.text': { n: number; projects: string | number }
  'git.vc.switch.changed': { platform: string | number }
  'git.vc.switch.confirm': undefined
  'git.vc.switch.done': { project: string | number; platform: string | number }
  'git.vc.switch.fresh': { to: string | number; from: string | number }
  'git.vc.switch.gitFolder': undefined
  'git.vc.switch.inFlight': { n: number; from: string | number }
  'git.vc.switch.lane': { name: string | number; builder: string | number }
  'git.vc.switch.laneUnnamed': { builder: string | number }
  'git.vc.switch.lanes': { n: number; from: string | number }
  'git.vc.switch.noGit': undefined
  'git.vc.switch.notSwitched': { project: string | number; error: string | number }
  'git.vc.switch.nothing': { to: string | number }
  'git.vc.switch.otherFound': { vcs: string | number }
  'git.vc.switch.queue': undefined
  'git.vc.switch.restored': { to: string | number; from: string | number }
  'git.vc.switch.title': { project: string | number; platform: string | number }
  'git.vc.switch.what': { project: string | number; to: string | number; from: string | number }
  'git.vc.switchTip': { platform: string | number }
  'git.vc.templateNotApplied': { project: string | number; template: string | number }
  'git.vc.templatePending': { template: string | number }
  'git.vc.useParent': undefined
  'git.vc.workflow': { platform: string | number; state: string; preset: string | number }
  'git.vc.workflowTip': undefined
  'git.worktree.agent': { agent: string | number }
  'git.worktree.badge': undefined
  'git.worktree.slotLease': { kind: string; slot: string | number; agent: string | number; card: string | number; lane: string | number }
  'git.worktree.unused': undefined
  'git.worktrees.changes': undefined
  'git.worktrees.copiesHeading': undefined
  'git.worktrees.copiesHint': undefined
  'git.worktrees.copyRow': { use: string; copy: string | number; agent: string | number; card: string | number; revision: string | number }
  'git.worktrees.heading': undefined
  'git.worktrees.queueHeading': undefined
  'git.worktrees.queueHint': undefined
  'git.worktrees.queueRow': undefined
  'git.worktrees.readOnly': undefined
}
