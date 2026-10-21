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
  'workflow.forYou.newDecision': { card: string | number }
  'workflow.forYou.okBefore': { card: string | number }
  'workflow.forYou.passedReview': { card: string | number }
  'workflow.forYou.review': { card: string | number }
  'workflow.forYou.roundLimit': { card: string | number; rounds: number }
  'workflow.forYouKind': { kind: string }
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
  'workflow.refused.loop.roundLimit.message': { card: string | number }
  'workflow.refused.loop.roundLimit.next': undefined
  'workflow.refused.move.needsOverride.change': undefined
  'workflow.refused.move.needsOverride.message': { card: string | number; stage: string | number; rules: string | number }
  'workflow.refused.move.needsOverride.next': undefined
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
}
