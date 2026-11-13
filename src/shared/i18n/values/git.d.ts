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
  'git.branches.earlierCards': { n: number }
  'git.branches.group': { group: string; target: string | number }
  'git.branches.groupTip': { group: string; target: string | number }
  'git.branches.heading': undefined
  'git.branches.loadTarget': undefined
  'git.branches.merge': { branch: string | number }
  'git.branches.merged': { has: string; revision: string | number }
  'git.branches.noCommits': undefined
  'git.branches.notInTarget': { n: number; target: string | number }
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
  'git.gate.advance.name': undefined
  'git.gate.advance.why': undefined
  'git.gate.attributes.name': undefined
  'git.gate.attributes.why': undefined
  'git.gate.hooks.name': undefined
  'git.gate.hooks.why': undefined
  'git.gate.lfs.name': undefined
  'git.gate.lfs.why': undefined
  'git.gate.plainGit.name': undefined
  'git.gate.plainGit.why': undefined
  'git.gate.publish.name': undefined
  'git.gate.publish.why': undefined
  'git.gate.relocation.name': undefined
  'git.gate.relocation.why': undefined
  'git.gate.sharedFolder.name': undefined
  'git.gate.sharedFolder.why': undefined
  'git.gate.signing.name': undefined
  'git.gate.signing.why': undefined
  'git.gate.submodules.name': undefined
  'git.gate.submodules.why': undefined
  'git.gitlink.binary': undefined
  'git.gitlink.dirty': undefined
  'git.gitlink.hideGit': undefined
  'git.gitlink.showGit': undefined
  'git.gitlink.summary': { change: string; path: string | number; from: string | number; to: string | number }
  'git.head.detachedAt': { commit: string | number }
  'git.head.noCommits': undefined
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
  'git.queue.pastTip': undefined
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
  'git.repoLock.jjFolder': { folder: string | number }
  'git.repoLock.noGitDir': { folder: string | number; why: string | number }
  'git.repoLock.order': undefined
  'git.repoLock.unknownRepo': { root: string | number; why: string | number }
  'git.repoLock.waiting': { profile: string | number }
  'git.repoLock.waitingFor': { seconds: number }
  'git.repoOp.notOffered': undefined
  'git.retry': undefined
  'git.section.branches': undefined
  'git.section.changes': undefined
  'git.section.history': undefined
  'git.section.jjBookmarks': undefined
  'git.section.jjCompare': undefined
  'git.section.jjConflicts': undefined
  'git.section.jjHistory': undefined
  'git.section.jjOperations': undefined
  'git.section.jjRepo': undefined
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
  'git.vc.fact.jj': { root: string | number; colocated: string }
  'git.vc.fact.jjGone': undefined
  'git.vc.fact.jjInGit': { root: string | number; git: string | number }
  'git.vc.fact.none': undefined
  'git.vc.fact.other': { vcs: string | number }
  'git.vc.fact.otherGit': { vcs: string | number }
  'git.vc.fact.repo': { root: string | number }
  'git.vc.fact.subfolder': { root: string | number }
  'git.vc.git': undefined
  'git.vc.initHint': undefined
  'git.vc.initOwnHint': undefined
  'git.vc.insideRepo': { root: string | number }
  'git.vc.jj': undefined
  'git.vc.noCommitYet': undefined
  'git.vc.none': undefined
  'git.vc.notRepoYet': undefined
  'git.vc.offer.gitFound': { root: string | number }
  'git.vc.offer.jjFound': { root: string | number }
  'git.vc.offer.jjGone': { platform: string | number }
  'git.vc.offer.notNow': undefined
  'git.vc.offer.otherFound': { vcs: string | number }
  'git.vc.offer.repositoryGone': undefined
  'git.vc.offer.switchGit': undefined
  'git.vc.offer.switchJj': undefined
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
  'git.vc.store.autocrlf': { command: string | number }
  'git.vc.store.card': { project: string | number; card: string | number; title: string | number }
  'git.vc.store.clear': { gate: string | number }
  'git.vc.store.conflictedBookmark': { name: string | number }
  'git.vc.store.conflictedCommit': { commit: string | number }
  'git.vc.store.copy': { project: string | number; kind: string; copy: string | number }
  'git.vc.store.detached': { project: string | number; head: string | number }
  'git.vc.store.drain': undefined
  'git.vc.store.fallback': undefined
  'git.vc.store.fallbackUnknown': { detail: string | number }
  'git.vc.store.gates': undefined
  'git.vc.store.group': { n: number }
  'git.vc.store.heads': { n: number }
  'git.vc.store.kept': { project: string | number; card: string | number; slot: string | number }
  'git.vc.store.lane': { project: string | number; name: string | number; builder: string | number }
  'git.vc.store.laneUnnamed': { project: string | number; builder: string | number }
  'git.vc.store.limit': { gate: string | number; why: string | number }
  'git.vc.store.member': { project: string | number; platform: string | number }
  'git.vc.store.notExported': { name: string | number }
  'git.vc.store.queue': { project: string | number }
  'git.vc.store.slot': { project: string | number; slot: string | number; agent: string | number }
  'git.vc.store.stock': undefined
  'git.vc.store.stuck': { projects: string | number; changed: string | number }
  'git.vc.store.stuckTitle': undefined
  'git.vc.store.toGit': undefined
  'git.vc.store.toJj': undefined
  'git.vc.store.unknown': { gate: string | number; what: string | number }
  'git.vc.store.unsupported': undefined
  'git.vc.store.uses': { gate: string | number; what: string | number }
  'git.vc.switch.changed': { platform: string | number }
  'git.vc.switch.checkAgain': undefined
  'git.vc.switch.close': undefined
  'git.vc.switch.confirm': undefined
  'git.vc.switch.done': { project: string | number; platform: string | number }
  'git.vc.switch.drain': undefined
  'git.vc.switch.fallback': undefined
  'git.vc.switch.fresh': { to: string | number; from: string | number }
  'git.vc.switch.gates': undefined
  'git.vc.switch.gitFolder': undefined
  'git.vc.switch.groupChanged': undefined
  'git.vc.switch.inFlight': { n: number; from: string | number }
  'git.vc.switch.jjInGit': { root: string | number }
  'git.vc.switch.jjNoGitCopy': undefined
  'git.vc.switch.jjTool': { state: string }
  'git.vc.switch.jjToolBack': { state: string }
  'git.vc.switch.jjUnknown': { code: string | number }
  'git.vc.switch.lane': { name: string | number; builder: string | number }
  'git.vc.switch.laneUnnamed': { builder: string | number }
  'git.vc.switch.lanes': { n: number; from: string | number }
  'git.vc.switch.memberDrain': undefined
  'git.vc.switch.memberNoJj': { project: string | number }
  'git.vc.switch.noGit': undefined
  'git.vc.switch.noJj': undefined
  'git.vc.switch.notSwitched': { project: string | number; error: string | number }
  'git.vc.switch.nothing': { to: string | number }
  'git.vc.switch.otherFound': { vcs: string | number }
  'git.vc.switch.otherWorkspace': { workspace: string | number }
  'git.vc.switch.queue': undefined
  'git.vc.switch.restored': { to: string | number; from: string | number }
  'git.vc.switch.storeRuns': { platform: string | number }
  'git.vc.switch.switching': undefined
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
