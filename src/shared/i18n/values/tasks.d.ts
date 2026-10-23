// Generated from locales/en/tasks.json: do not edit. Each message's placeholders and their types, for tr(): a
// global script, so its interface merges with every other area's (shared/i18n/msg.ts).
interface HiveMessageValues {
  'tasks.by.assistant': undefined
  'tasks.by.repair': undefined
  'tasks.by.you': undefined
  'tasks.error.addOwnOnly': { project: string | number }
  'tasks.error.archiveNone': undefined
  'tasks.error.archiveNumbers': undefined
  'tasks.error.archived': { n: string | number }
  'tasks.error.badAnswer': { max: string | number }
  'tasks.error.badKind': { kind: string | number }
  'tasks.error.batchGone': undefined
  'tasks.error.beforeArchived': { before: string | number; column: string; n: string | number }
  'tasks.error.beforeElsewhere': { before: string | number; other: string; column: string; n: string | number }
  'tasks.error.beforeItself': undefined
  'tasks.error.beforeOrPosition': undefined
  'tasks.error.cardsNotNumber': { value: string | number }
  'tasks.error.cardsTooMany': { max: number }
  'tasks.error.cardsTwice': { n: string | number }
  'tasks.error.changeNone': undefined
  'tasks.error.chooseProject': undefined
  'tasks.error.contextList': undefined
  'tasks.error.contextRef': { ref: string | number }
  'tasks.error.decisionEmptied': undefined
  'tasks.error.decisionGone': { n: string | number }
  'tasks.error.decisionsUsers': undefined
  'tasks.error.emptyComment': undefined
  'tasks.error.emptyDecision': undefined
  'tasks.error.failedStays': { n: string | number }
  'tasks.error.holdCard': { n: string | number }
  'tasks.error.holdNew': undefined
  'tasks.error.inDoingWith': { n: string | number; agent: string | number; column: string }
  'tasks.error.inDoingWithAnother': { n: string | number; column: string }
  'tasks.error.kindNeedsReason': undefined
  'tasks.error.kindNotAgents': undefined
  'tasks.error.labelFieldList': { field: string | number }
  'tasks.error.labelsAddedAndRemoved': { labels: string | number }
  'tasks.error.labelsList': undefined
  'tasks.error.labelsMixed': undefined
  'tasks.error.needsTitle': undefined
  'tasks.error.noCard': { n: string | number }
  'tasks.error.noKindProposal': { n: string | number; kind: string | number }
  'tasks.error.noWorkspace': undefined
  'tasks.error.notReviewing': { n: string | number }
  'tasks.error.onlyUserArchives': undefined
  'tasks.error.onlyUserDone': undefined
  'tasks.error.onlyUserOrdersDone': undefined
  'tasks.error.onlyUserUnarchives': undefined
  'tasks.error.orderArchived': { n: string | number; column: string }
  'tasks.error.orderChanged': { n: string | number }
  'tasks.error.orderElsewhere': { n: string | number; other: string; column: string }
  'tasks.error.orderNone': undefined
  'tasks.error.overrideNotAgents': undefined
  'tasks.error.overrideShape': undefined
  'tasks.error.ownCardsOnly': { project: string | number }
  'tasks.error.projectThenAgent': undefined
  'tasks.error.refsList': { field: string | number }
  'tasks.error.refsNoCard': { field: string | number; n: string | number }
  'tasks.error.refsNotNumber': { field: string | number; value: string | number }
  'tasks.error.refsSelf': { field: string | number }
  'tasks.error.repairNoProject': { project: string | number }
  'tasks.error.reviewAgentsOnly': undefined
  'tasks.error.reviewNotInReview': { n: string | number; column: string }
  'tasks.error.reviewOnItsOwn': undefined
  'tasks.error.reviewTaken': { agent: string | number; n: string | number; since: string | number }
  'tasks.error.setAsideGone': undefined
  'tasks.error.staysInProject': { project: string | number }
  'tasks.error.tooLong': { what: string; max: number }
  'tasks.error.tooManyContext': { max: string | number }
  'tasks.error.tooManyDecisions': { max: string | number }
  'tasks.error.tooManyLabels': { max: string | number }
  'tasks.error.unknownAgent': { agent: string | number; project: string | number }
  'tasks.error.unknownColumn': { column: string | number; choices: string | number }
  'tasks.error.unknownPosition': { position: string | number }
  'tasks.error.unknownProject': { project: string | number }
  'tasks.error.unknownReview': { review: string | number }
  'tasks.error.unknownTask': { n: string | number }
  'tasks.error.verdictNotYours': { agent: string | number; n: string | number }
  'tasks.history.answerTold': { agent: string | number }
  'tasks.history.archived': undefined
  'tasks.history.archivedDone': { days: number }
  'tasks.history.archivedHidden': { project: string | number }
  'tasks.history.archivedInBatch': { n: number; label: string | number }
  'tasks.history.archivedRemoved': { project: string | number }
  'tasks.history.backWithBatch': { label: string | number }
  'tasks.history.blocked': { reason: string | number }
  'tasks.history.context': { refs: string | number }
  'tasks.history.contextRemoved': undefined
  'tasks.history.created': { column: string }
  'tasks.history.decision': { decision: string | number }
  'tasks.history.decisionChanged': { decision: string | number; was: string | number }
  'tasks.history.decisionRemoved': { decision: string | number }
  'tasks.history.decisionsTold': { agent: string | number; count: number }
  'tasks.history.dependsOn': { cards: string | number }
  'tasks.history.description': undefined
  'tasks.history.fromOlder': { was: string | number }
  'tasks.history.given': { agent: string | number }
  'tasks.history.imported': { project: string | number; was: string | number }
  'tasks.history.kind': { how: string; kind: string }
  'tasks.history.labels': { labels: string | number }
  'tasks.history.labelsAdded': { labels: string | number }
  'tasks.history.labelsAddedTakenOff': { added: string | number; removed: string | number }
  'tasks.history.labelsRemoved': undefined
  'tasks.history.labelsTakenOff': { labels: string | number }
  'tasks.history.linked': { cards: string | number }
  'tasks.history.linksRemoved': undefined
  'tasks.history.loopWake': { agent: string | number; kind: string }
  'tasks.history.moved': { column: string }
  'tasks.history.movedBefore': { column: string; before: string | number }
  'tasks.history.movedBeforeIn': { before: string | number; column: string }
  'tasks.history.movedBottom': { column: string }
  'tasks.history.movedTop': { column: string }
  'tasks.history.noDependencies': undefined
  'tasks.history.notified': { event: string; lane: string | number; hasWhy: string; why: string | number }
  'tasks.history.placed': { place: number; column: string }
  'tasks.history.renamed': { title: string | number }
  'tasks.history.repaired': { from: string | number; to: string | number }
  'tasks.history.restored': { project: string | number }
  'tasks.history.returned': { round: string | number }
  'tasks.history.reviewCopyLeased': { agent: string | number; copy: string | number; revision: string | number }
  'tasks.history.reviewCopyWaiting': { agent: string | number }
  'tasks.history.reviewEnded': { agent: string | number; why: string }
  'tasks.history.reviewFailed': undefined
  'tasks.history.reviewPassed': undefined
  'tasks.history.reviewStarted': undefined
  'tasks.history.reviewStopped': { agent: string | number }
  'tasks.history.reviewerRequest': { text: string | number }
  'tasks.history.safeguardStop': { agent: string | number; stops: number; model: string; time: string | number; to: string | number; from: string | number; since: string | number; state: string; hasTools: string; tools: string | number; hasHelp: string; help: string | number }
  'tasks.history.takenFrom': { agent: string | number }
  'tasks.history.takenFromAgent': undefined
  'tasks.history.takenFromOf': { agent: string | number; project: string | number }
  'tasks.history.takenFromOfWorkspace': { agent: string | number }
  'tasks.history.toProject': { project: string | number }
  'tasks.history.toWorkspace': undefined
  'tasks.history.unarchived': undefined
  'tasks.history.unblocked': undefined
  'tasks.history.watchEnded': { watcher: string | number; why: string; agent: string | number }
  'tasks.skipped.movedColumn': { column: string }
  'tasks.skipped.movedProject': undefined
  'tasks.skipped.movedStage': { stage: string | number }
  'tasks.skipped.noMatch': undefined
  'tasks.skipped.unreadable': undefined
  'tasks.skipped.unsaved': undefined
  'tasks.start.agentBusy': { agent: string | number; status: string }
  'tasks.start.alreadyStarting': { n: string | number }
  'tasks.start.archived': { n: string | number }
  'tasks.start.beingGiven': { agent: string | number }
  'tasks.start.changed': { n: string | number }
  'tasks.start.movedColumn': { n: string | number; column: string }
  'tasks.start.movedDone': { n: string | number }
  'tasks.start.movedProject': { n: string | number; project: string | number }
  'tasks.start.movedWorkspace': { n: string | number }
  'tasks.start.noProject': { n: string | number }
  'tasks.start.notGiven': { agent: string | number; n: string | number; why: string | number }
  'tasks.start.noteTooLong': { max: number }
  'tasks.start.reassigned': { n: string | number; who: string }
  'tasks.start.userTyping': { agent: string | number }
}
