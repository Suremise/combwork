// Generated from locales/en/workflow.json: do not edit. Each message's placeholders and their types, for tr(): a
// global script, so its interface merges with every other area's (shared/i18n/msg.ts).
interface HiveMessageValues {
  'workflow.contradiction.committedNeedsFolder': undefined
  'workflow.contradiction.hiveMergesNeedsGit': undefined
  'workflow.contradiction.mergeNeedsSlots': undefined
  'workflow.contradiction.noneHasNoSlots': undefined
  'workflow.contradiction.okWithReview': undefined
  'workflow.contradiction.quorumNeedsAgent': undefined
  'workflow.contradiction.selfReview': undefined
  'workflow.forYou.decidedAfterMerge': { card: string | number }
  'workflow.forYou.lineAsk': { line: string | number; card: string | number; target: string | number; next: string | number }
  'workflow.forYou.lineRefused': { line: string | number; target: string | number; reason: string | number; next: string | number }
  'workflow.forYou.lineWork': { line: string | number; target: string | number; commits: string | number; next: string | number }
  'workflow.forYou.newDecision': { card: string | number }
  'workflow.forYou.okBefore': { card: string | number }
  'workflow.forYou.passedReview': { card: string | number }
  'workflow.forYou.review': { card: string | number }
  'workflow.forYou.roundLimit': { card: string | number; rounds: number }
  'workflow.forYouKind': { kind: string }
  'workflow.form.addCheck': undefined
  'workflow.form.agentsSection': undefined
  'workflow.form.cantSave': undefined
  'workflow.form.changeLine': { option: string | number; from: string | number; to: string | number }
  'workflow.form.changesHead': undefined
  'workflow.form.checkCommand': undefined
  'workflow.form.checkName': undefined
  'workflow.form.choose': undefined
  'workflow.form.confirmMessage': undefined
  'workflow.form.confirmTitle': undefined
  'workflow.form.copied': undefined
  'workflow.form.copy': undefined
  'workflow.form.defaultBranch': undefined
  'workflow.form.discard': undefined
  'workflow.form.fileLocks': undefined
  'workflow.form.fileLocksValue': undefined
  'workflow.form.folders': undefined
  'workflow.form.from.global': undefined
  'workflow.form.from.platform': undefined
  'workflow.form.from.preset': undefined
  'workflow.form.from.project': undefined
  'workflow.form.from.workspace': undefined
  'workflow.form.git': undefined
  'workflow.form.identity': { name: string | number; email: string | number }
  'workflow.form.identityValue': { name: string | number; email: string | number }
  'workflow.form.inFlight': { n: number }
  'workflow.form.inherit': undefined
  'workflow.form.inheritTip': { value: string | number }
  'workflow.form.invalid': undefined
  'workflow.form.labels': undefined
  'workflow.form.labelsValue': { labels: string | number }
  'workflow.form.lane': { builder: string | number; name: string | number }
  'workflow.form.laneUnnamed': { builder: string | number }
  'workflow.form.lanes': { n: number }
  'workflow.form.loadFailed': { error: string | number }
  'workflow.form.loops': undefined
  'workflow.form.loopsSection': undefined
  'workflow.form.loopsValue': { rounds: number; hours: number }
  'workflow.form.noChanges': undefined
  'workflow.form.noChecks': undefined
  'workflow.form.noIdentity': undefined
  'workflow.form.none': undefined
  'workflow.form.noneValue': undefined
  'workflow.form.notEnforced': undefined
  'workflow.form.off': undefined
  'workflow.form.on': undefined
  'workflow.form.openAdvanced': undefined
  'workflow.form.owned': { where: string | number }
  'workflow.form.ownedPrefix': undefined
  'workflow.form.paste': undefined
  'workflow.form.pasteApply': undefined
  'workflow.form.pasteBad': undefined
  'workflow.form.pasteMessage': undefined
  'workflow.form.pastePlatform': undefined
  'workflow.form.pasteTitle': undefined
  'workflow.form.platform': undefined
  'workflow.form.platformDesc': undefined
  'workflow.form.preset': undefined
  'workflow.form.presetDesc': undefined
  'workflow.form.removeCheck': undefined
  'workflow.form.save': undefined
  'workflow.form.saved': undefined
  'workflow.form.startedFrom': { preset: string | number }
  'workflow.form.unavailable': { preset: string | number; why: string | number }
  'workflow.form.worktree': undefined
  'workflow.move.answer': undefined
  'workflow.move.declarePaths': undefined
  'workflow.move.move': undefined
  'workflow.move.putBack': undefined
  'workflow.move.removeFromQueue': undefined
  'workflow.move.reportMerge': undefined
  'workflow.move.retryMerge': undefined
  'workflow.move.start': undefined
  'workflow.move.startReview': undefined
  'workflow.move.submit': undefined
  'workflow.move.verdict': undefined
  'workflow.notOffered.hiveMerges': undefined
  'workflow.notOffered.later': undefined
  'workflow.option.commands.desc': undefined
  'workflow.option.commands.title': undefined
  'workflow.option.dependenciesDone.desc': undefined
  'workflow.option.dependenciesDone.none': undefined
  'workflow.option.dependenciesDone.title': undefined
  'workflow.option.excluded.desc': undefined
  'workflow.option.excluded.title': undefined
  'workflow.option.finish.desc': undefined
  'workflow.option.finish.title': undefined
  'workflow.option.folder.desc': undefined
  'workflow.option.folder.title': undefined
  'workflow.option.identity.desc': undefined
  'workflow.option.identity.title': undefined
  'workflow.option.noSelfReview.desc': undefined
  'workflow.option.noSelfReview.title': undefined
  'workflow.option.okBefore.desc': undefined
  'workflow.option.okBefore.title': undefined
  'workflow.option.preChecks.desc': undefined
  'workflow.option.preChecks.title': undefined
  'workflow.option.review.desc': undefined
  'workflow.option.review.none': undefined
  'workflow.option.review.title': undefined
  'workflow.option.reviewers.desc': undefined
  'workflow.option.reviewers.title': undefined
  'workflow.option.sameness.desc': undefined
  'workflow.option.sameness.title': undefined
  'workflow.option.sharedFolderWarning.desc': undefined
  'workflow.option.sharedFolderWarning.title': undefined
  'workflow.option.stopOwnRuns.desc': undefined
  'workflow.option.stopOwnRuns.title': undefined
  'workflow.option.style.desc': undefined
  'workflow.option.style.title': undefined
  'workflow.option.target.desc': undefined
  'workflow.option.target.title': undefined
  'workflow.preset.custom': undefined
  'workflow.preset.needs.hiveMerges': undefined
  'workflow.preset.needs.slots': undefined
  'workflow.preset.pair': undefined
  'workflow.preset.pairAgent': undefined
  'workflow.preset.solo': undefined
  'workflow.preset.team': undefined
  'workflow.presetsNotice.choose': undefined
  'workflow.presetsNotice.notNow': undefined
  'workflow.presetsNotice.text': { n: number; projects: string | number }
  'workflow.refused.approval.given.change': undefined
  'workflow.refused.approval.given.message': { card: string | number }
  'workflow.refused.approval.given.next': undefined
  'workflow.refused.card.plainNumber.message': undefined
  'workflow.refused.card.plainNumber.next': { key: string | number; alias: string | number }
  'workflow.refused.check.revisionMismatch.message': { revision: string | number }
  'workflow.refused.check.revisionMismatch.next': { revision: string | number }
  'workflow.refused.done.contained.change': undefined
  'workflow.refused.done.contained.message': { card: string | number; revision: string | number; target: string | number }
  'workflow.refused.done.contained.next': { revision: string | number; target: string | number }
  'workflow.refused.evidence.changed.message': { card: string | number }
  'workflow.refused.evidence.changed.next': undefined
  'workflow.refused.integrate.approved.message': { card: string | number; revision: string | number; why: string | number }
  'workflow.refused.integrate.approved.next': undefined
  'workflow.refused.integrate.checksPassed.change': undefined
  'workflow.refused.integrate.checksPassed.message': { card: string | number }
  'workflow.refused.integrate.checksPassed.next': undefined
  'workflow.refused.integrate.upToDate.change': undefined
  'workflow.refused.integrate.upToDate.message': { card: string | number; revision: string | number; target: string | number }
  'workflow.refused.integrate.upToDate.next': undefined
  'workflow.refused.lane.lineBehind.change': undefined
  'workflow.refused.lane.lineBehind.message': { card: string | number; line: string | number; earlier: string | number; target: string | number }
  'workflow.refused.lane.lineBehind.next': { line: string | number; target: string | number; card: string | number }
  'workflow.refused.lane.oneAtATime.change': undefined
  'workflow.refused.lane.oneAtATime.message': { card: string | number; earlier: string | number }
  'workflow.refused.lane.oneAtATime.next': { earlier: string | number; card: string | number }
  'workflow.refused.loop.roundLimit.message': { card: string | number }
  'workflow.refused.loop.roundLimit.next': undefined
  'workflow.refused.move.needsOverride.change': undefined
  'workflow.refused.move.needsOverride.message': { card: string | number; stage: string | number; rules: string | number }
  'workflow.refused.move.needsOverride.next': undefined
  'workflow.refused.move.noStage.change': undefined
  'workflow.refused.move.noStage.message': { card: string | number; stage: string | number }
  'workflow.refused.move.noStage.next': { stages: string | number }
  'workflow.refused.move.notFromHere.message': { card: string | number; stage: string | number; move: string | number }
  'workflow.refused.move.notFromHere.next': { stage: string | number; moves: string | number }
  'workflow.refused.move.notFromHere.nextNone': undefined
  'workflow.refused.move.useIntent.message': undefined
  'workflow.refused.move.useIntent.next': { intent: string | number }
  'workflow.refused.platform.unknown.message': { card: string | number; what: string | number; rule: string | number }
  'workflow.refused.platform.unknown.next': undefined
  'workflow.refused.requeue.allowed.change': undefined
  'workflow.refused.requeue.allowed.message': { card: string | number; revision: string | number; why: string | number }
  'workflow.refused.requeue.allowed.next': undefined
  'workflow.refused.review.decisionsReceived.message': { card: string | number }
  'workflow.refused.review.decisionsReceived.next': undefined
  'workflow.refused.review.noSubmission.message': { card: string | number }
  'workflow.refused.review.noSubmission.next': undefined
  'workflow.refused.review.notAuthor.change': undefined
  'workflow.refused.review.notAuthor.message': { card: string | number }
  'workflow.refused.review.notAuthor.next': undefined
  'workflow.refused.start.dependenciesIntegrated.change': undefined
  'workflow.refused.start.dependenciesIntegrated.message': { card: string | number; waitsFor: string | number }
  'workflow.refused.start.dependenciesIntegrated.next': { waitsFor: string | number }
  'workflow.refused.start.notBlocked.change': undefined
  'workflow.refused.start.notBlocked.message': { card: string | number; reason: string | number }
  'workflow.refused.start.notBlocked.next': undefined
  'workflow.refused.start.slotAvailable.change': undefined
  'workflow.refused.start.slotAvailable.message': { card: string | number }
  'workflow.refused.start.slotAvailable.next': undefined
  'workflow.refused.submit.checksPassed.change': undefined
  'workflow.refused.submit.checksPassed.message': { check: string | number; revision: string | number }
  'workflow.refused.submit.checksPassed.next': { command: string | number }
  'workflow.refused.submit.clean.change': undefined
  'workflow.refused.submit.clean.message': { card: string | number; folder: string | number; files: string | number }
  'workflow.refused.submit.clean.next': undefined
  'workflow.refused.submit.decisionsReceived.message': { card: string | number }
  'workflow.refused.submit.decisionsReceived.next': undefined
  'workflow.refused.submit.empty.message': { card: string | number }
  'workflow.refused.submit.empty.next': undefined
  'workflow.refused.submit.identity.change': undefined
  'workflow.refused.submit.identity.message': { card: string | number; commit: string | number; email: string | number }
  'workflow.refused.submit.identity.next': { command: string | number }
  'workflow.refused.submit.notDuplicate.message': { card: string | number; revision: string | number }
  'workflow.refused.submit.notDuplicate.next': undefined
  'workflow.refused.submit.ownRunsStopped.change': undefined
  'workflow.refused.submit.ownRunsStopped.message': { card: string | number; runs: string | number }
  'workflow.refused.submit.ownRunsStopped.next': undefined
  'workflow.refused.submit.ready.message': { card: string | number; revision: string | number; files: string | number }
  'workflow.refused.submit.ready.next': undefined
  'workflow.refused.submit.sameRevisionNote.message': { revision: string | number }
  'workflow.refused.submit.sameRevisionNote.next': undefined
  'workflow.refused.submit.trailer.change': undefined
  'workflow.refused.submit.trailer.message': { card: string | number; commit: string | number }
  'workflow.refused.submit.trailer.next': { command: string | number }
  'workflow.refused.verdict.currentSubmission.message': { submission: string | number; card: string | number }
  'workflow.refused.verdict.currentSubmission.next': { latest: string | number }
  'workflow.refused.verdict.reviewing.message': { card: string | number; submission: string | number }
  'workflow.refused.verdict.reviewing.next': undefined
  'workflow.refused.why.passes': { n: number; q: number }
  'workflow.refused.why.requeueLimit': { n: number }
  'workflow.refused.why.requeueNotTransient': undefined
  'workflow.refused.why.stale': undefined
  'workflow.refused.why.userOk': undefined
  'workflow.roundChoice': { choice: string }
  'workflow.rule.approval.given': undefined
  'workflow.rule.done.contained': undefined
  'workflow.rule.integrate.approved': undefined
  'workflow.rule.integrate.checksPassed': undefined
  'workflow.rule.integrate.upToDate': undefined
  'workflow.rule.requeue.allowed': undefined
  'workflow.rule.review.decisionsReceived': undefined
  'workflow.rule.review.notAuthor': undefined
  'workflow.rule.start.dependenciesIntegrated': undefined
  'workflow.rule.start.notBlocked': undefined
  'workflow.rule.start.slotAvailable': undefined
  'workflow.rule.submit.checksPassed': undefined
  'workflow.rule.submit.clean': undefined
  'workflow.rule.submit.decisionsReceived': undefined
  'workflow.rule.submit.identity': undefined
  'workflow.rule.submit.notDuplicate': undefined
  'workflow.rule.submit.ownRunsStopped': undefined
  'workflow.rule.submit.ready': undefined
  'workflow.rule.submit.trailer': undefined
  'workflow.rule.verdict.currentSubmission': undefined
  'workflow.rule.verdict.reviewing': undefined
  'workflow.stage': { stage: string }
  'workflow.unreadable.branch': { folder: string | number }
  'workflow.unreadable.branchedOff': { a: string | number; b: string | number }
  'workflow.unreadable.branchedOffTarget': undefined
  'workflow.unreadable.cardPathsFiles': { n: number }
  'workflow.unreadable.cardPathsSize': { n: number }
  'workflow.unreadable.change': { from: string | number; to: string | number }
  'workflow.unreadable.changeFingerprint': undefined
  'workflow.unreadable.commitsOf': { range: string | number }
  'workflow.unreadable.commitsOn': { target: string | number }
  'workflow.unreadable.commitsSince': { revision: string | number; base: string | number }
  'workflow.unreadable.contains': { revision: string | number; target: string | number }
  'workflow.unreadable.defaultBranch': { folder: string | number }
  'workflow.unreadable.deliverables': { project: string | number; n: number }
  'workflow.unreadable.files': { revision: string | number }
  'workflow.unreadable.filesChanged': { from: string | number; to: string | number }
  'workflow.unreadable.folderFor': { branch: string | number }
  'workflow.unreadable.gitFolder': { folder: string | number }
  'workflow.unreadable.head': { where: string | number }
  'workflow.unreadable.history': { target: string | number }
  'workflow.unreadable.holdsChange': { where: string | number }
  'workflow.unreadable.ignored': { folder: string | number }
  'workflow.unreadable.line': { branch: string | number }
  'workflow.unreadable.pathOutside': { path: string | number }
  'workflow.unreadable.replay': { revision: string | number; onto: string | number }
  'workflow.unreadable.replayedFiles': undefined
  'workflow.unreadable.revision': { revision: string | number }
  'workflow.unreadable.revisionIn': { folder: string | number }
  'workflow.unreadable.state': { folder: string | number }
  'workflow.unreadable.target': { target: string | number }
  'workflow.unreadable.uncommitted': { folder: string | number }
  'workflow.unreadable.worktrees': { folder: string | number }
  'workflow.unreadable.writes': { folder: string | number }
  'workflow.value.finish.agentMerges': undefined
  'workflow.value.finish.committed': undefined
  'workflow.value.finish.hiveMerges': undefined
  'workflow.value.finish.notChecked': undefined
  'workflow.value.folder.project': undefined
  'workflow.value.folder.slots': undefined
  'workflow.value.okBefore.every': undefined
  'workflow.value.okBefore.labels': undefined
  'workflow.value.okBefore.never': undefined
  'workflow.value.review.agent': undefined
  'workflow.value.review.agentThenYou': undefined
  'workflow.value.review.none': undefined
  'workflow.value.review.noneNone': undefined
  'workflow.value.review.you': undefined
  'workflow.value.sameness.change': undefined
  'workflow.value.sameness.exact': undefined
  'workflow.value.style.merge': undefined
  'workflow.value.style.squash': undefined
}
