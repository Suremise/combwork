// Generated from locales/en/board.json: do not edit. Each message's placeholders and their types, for tr(): a
// global script, so its interface merges with every other area's (shared/i18n/msg.ts).
interface CombworkMessageValues {
  'board.agent.folded': { agent: string | number; status: string | number }
  'board.agent.notRunning': undefined
  'board.agent.removed': { agent: string | number }
  'board.agent.tip': { agent: string | number; status: string | number }
  'board.agent.unnamed': undefined
  'board.archiveAll.allBusy': { n: number }
  'board.archiveAll.button': { n: number }
  'board.archiveAll.columnCount': { column: string | number; n: number }
  'board.archiveAll.filteredNote': undefined
  'board.archiveAll.heldIncluded': { n: number }
  'board.archiveAll.heldRow': { card: string | number; title: string | number; why: string | number }
  'board.archiveAll.heldRowSkipped': { card: string | number; title: string | number; why: string | number }
  'board.archiveAll.heldSkipped': { n: number }
  'board.archiveAll.includeBusy': undefined
  'board.archiveAll.includeWarning': undefined
  'board.archiveAll.menuAll': { total: number }
  'board.archiveAll.menuColumn': { column: string | number; total: number }
  'board.archiveAll.menuShown': { n: number; total: number }
  'board.archiveAll.menuShownIn': { n: number; total: number }
  'board.archiveAll.messageAll': { n: number }
  'board.archiveAll.messageColumn': { n: number; column: string | number }
  'board.archiveAll.messageShown': { n: number; total: number }
  'board.archiveAll.messageShownIn': { n: number; column: string | number; total: number }
  'board.archiveAll.noneLeft': { hasColumn: string; column: string | number }
  'board.archiveAll.titleAll': undefined
  'board.archiveAll.titleColumn': { column: string | number }
  'board.archiveAll.titleShown': { n: number }
  'board.archiveAll.titleShownIn': { n: number; column: string | number }
  'board.archived.agent': undefined
  'board.archived.allBatches': undefined
  'board.archived.archived': undefined
  'board.archived.batch': undefined
  'board.archived.count': { n: number }
  'board.archived.countSelected': { n: number; selected: number }
  'board.archived.created': undefined
  'board.archived.from': undefined
  'board.archived.labels': undefined
  'board.archived.none': undefined
  'board.archived.noneMatch': undefined
  'board.archived.openRow': { card: string | number; title: string | number }
  'board.archived.project': undefined
  'board.archived.selectRow': { card: string | number }
  'board.archived.title': undefined
  'board.archived.unarchive': undefined
  'board.archived.unarchiveBatch': { n: number }
  'board.archived.unarchiveBatchTip': { n: number }
  'board.archived.unarchiveSelected': undefined
  'board.archived.unarchiveSelectedN': { n: number }
  'board.archived.unarchiveTip': { card: string | number; column: string | number }
  'board.attach.already': { card: string | number; file: string | number }
  'board.attach.attached': { file: string | number; card: string | number }
  'board.attach.drafts': { box: string }
  'board.attach.failed': { file: string | number }
  'board.attach.heading': { n: number }
  'board.attach.hint': undefined
  'board.attach.meta': { size: string | number; by: string | number; when: string | number }
  'board.attach.missing': undefined
  'board.attach.open': undefined
  'board.attach.otherCards': undefined
  'board.attach.paneHeader': { file: string | number }
  'board.attach.remove': undefined
  'board.attach.removeDraft': { name: string | number }
  'board.attach.removeMessage': { used: string }
  'board.attach.removeTitle': { name: string | number; card: string | number }
  'board.attach.removed': { name: string | number }
  'board.attach.show': undefined
  'board.attach.showInTab': undefined
  'board.attach.toCard': { card: string | number }
  'board.attach.tooLarge': { name: string | number; max: string | number }
  'board.attach.tooMuch': { files: number; total: string | number }
  'board.attach.where': { description: string; both: string; comments: number }
  'board.batch.andMore': { cards: string | number; n: number }
  'board.batch.archived': { n: number }
  'board.batch.backFailed': undefined
  'board.batch.broughtBack': { n: number }
  'board.batch.leftOnBoard': { n: number; why: string | number }
  'board.batch.noneBack': { failed: string | number }
  'board.batch.nothingArchived': undefined
  'board.batch.otherWorkspace': undefined
  'board.batch.someBack': { n: number; failed: string | number }
  'board.batch.stayArchived': undefined
  'board.batch.undo': undefined
  'board.batchName.allCards': undefined
  'board.batchName.allIn': { column: string | number }
  'board.batchName.shownCards': { n: number }
  'board.batchName.shownIn': { n: number; column: string | number }
  'board.busy.assistantWatching': undefined
  'board.busy.reviewing': { agent: string | number }
  'board.busy.watching': { agent: string | number }
  'board.busy.watchingUnnamed': undefined
  'board.busy.working': { agent: string | number }
  'board.busy.workingUnnamed': undefined
  'board.card.archive': undefined
  'board.card.blocked': undefined
  'board.card.blockedTip': { reason: string | number }
  'board.card.bringBack': undefined
  'board.card.collapse': { card: string | number }
  'board.card.contextBroken': { n: number; refs: string | number }
  'board.card.decisionsCount': { n: string | number }
  'board.card.decisionsTip': { n: string | number; decisions: string | number }
  'board.card.dependsOn': { cards: string | number }
  'board.card.expand': { card: string | number }
  'board.card.stageInProject': { project: string | number; stage: string | number }
  'board.card.stalled': { why: string | number }
  'board.card.stalledMark': undefined
  'board.card.waitingMark': undefined
  'board.card.waitingTip': { reason: string | number; by: string | number }
  'board.card.workspace': undefined
  'board.cards.count': { n: number }
  'board.chip.card': { card: string | number; title: string | number; decisions: number }
  'board.chip.clickToOpen': { card: string | number }
  'board.chip.doing': undefined
  'board.chip.open': { card: string | number }
  'board.chip.reviewing': undefined
  'board.clash.message': { fields: string | number }
  'board.clash.title': { card: string | number }
  'board.column.doing': undefined
  'board.column.doingDescription': undefined
  'board.column.done': undefined
  'board.column.doneDescription': undefined
  'board.column.hold': undefined
  'board.column.holdDescription': undefined
  'board.column.passed': undefined
  'board.column.passedDescription': undefined
  'board.column.review': undefined
  'board.column.reviewDescription': undefined
  'board.column.todo': undefined
  'board.column.todoDescription': undefined
  'board.columns.collapse': { column: string | number }
  'board.columns.collapseCards': undefined
  'board.columns.empty': undefined
  'board.columns.emptyTodo': undefined
  'board.columns.expand': { column: string | number }
  'board.columns.expandCards': undefined
  'board.columns.expandTip': { column: string | number; description: string | number }
  'board.columns.mergingTip': undefined
  'board.columns.more': { column: string | number }
  'board.columns.startLane': undefined
  'board.conflicts.base': undefined
  'board.conflicts.clipped': { n: number }
  'board.conflicts.count': { n: number }
  'board.conflicts.cut': { n: number }
  'board.conflicts.filesLeft': { n: number }
  'board.conflicts.line': { line: number }
  'board.conflicts.mayHaveMore': undefined
  'board.conflicts.more': { n: number }
  'board.conflicts.noText': undefined
  'board.conflicts.notRead': { why: string }
  'board.conflicts.readInPart': undefined
  'board.context.close': undefined
  'board.context.loading': undefined
  'board.context.open': undefined
  'board.context.openNote': undefined
  'board.context.problem': { why: string; closest: string }
  'board.cost.cardLine': { cost: string | number; rounds: number }
  'board.cost.nothingUsed': undefined
  'board.cost.perFinished': { estimated: string; cost: string | number; unpriced: string }
  'board.cost.tokens': { estimated: string; input: string | number; output: string | number; cacheWrite: string | number; cacheRead: string | number; unknown: string; requests: number }
  'board.cost.tokensUnknown': { requests: number }
  'board.costs.builder': undefined
  'board.costs.byRound': undefined
  'board.costs.byRoundFailed': undefined
  'board.costs.byRoundHourly': { days: number }
  'board.costs.byRoundNote': undefined
  'board.costs.cost': undefined
  'board.costs.laneFailed': undefined
  'board.costs.laneLoading': undefined
  'board.costs.note': { zero: string | number }
  'board.costs.onCards': undefined
  'board.costs.outsideRow': undefined
  'board.costs.overhead': undefined
  'board.costs.overheadNote': undefined
  'board.costs.reviewer': undefined
  'board.costs.roundColumn': undefined
  'board.costs.roundRow': { round: number }
  'board.costs.roundVerdict': { verdict: string }
  'board.costs.totalColumn': undefined
  'board.costs.unmatched': { n: number }
  'board.decision.add': undefined
  'board.decision.blank': undefined
  'board.decision.by': undefined
  'board.decision.byRecorded': { recorder: string | number }
  'board.decision.change': undefined
  'board.decision.editLabel': undefined
  'board.decision.edited': undefined
  'board.decision.heading': { n: string | number }
  'board.decision.info': undefined
  'board.decision.new': undefined
  'board.decision.newLabel': undefined
  'board.decision.newPlaceholder': undefined
  'board.decision.remove': undefined
  'board.decision.removeMessage': { decision: string | number; card: string | number }
  'board.decision.removeTip': undefined
  'board.decision.removeTitle': undefined
  'board.decision.removing': undefined
  'board.decision.saveAddsIt': undefined
  'board.delete.busy': undefined
  'board.delete.button': undefined
  'board.delete.message': { title: string | number }
  'board.delete.title': { card: string | number }
  'board.details.agent': undefined
  'board.details.card': undefined
  'board.details.check': undefined
  'board.details.command': undefined
  'board.details.copy': undefined
  'board.details.countsAsCheck': { name: string | number }
  'board.details.ended': undefined
  'board.details.exitCode': undefined
  'board.details.folder': undefined
  'board.details.gone': undefined
  'board.details.install': undefined
  'board.details.installAsWritten': undefined
  'board.details.interrupted': undefined
  'board.details.lastStep': { step: string | number }
  'board.details.line': { label: string | number; text: string | number }
  'board.details.log': undefined
  'board.details.noInstall': undefined
  'board.details.notCounted': { name: string | number; why: string }
  'board.details.provider': undefined
  'board.details.revision': undefined
  'board.details.run': undefined
  'board.details.staleAgentStopped': undefined
  'board.details.staleQuiet': { quiet: string | number }
  'board.details.started': undefined
  'board.details.state': { state: string; dismissed: string }
  'board.details.stateLabel': undefined
  'board.details.steps': { done: number; total: number }
  'board.details.stepsLabel': undefined
  'board.details.stepsLast': { done: number; total: number; step: string | number }
  'board.details.summary': undefined
  'board.details.temporary': undefined
  'board.details.testedOn': undefined
  'board.details.took': undefined
  'board.details.tookSoFar': { took: string | number; expected: string }
  'board.details.tookTotal': { took: string | number; expected: string }
  'board.details.transient': { cause: string; code: string | number }
  'board.details.waitingSince': { since: string | number; waiting: string | number }
  'board.dialog.activity': undefined
  'board.dialog.activityTip': undefined
  'board.dialog.addCard': undefined
  'board.dialog.added': { who: string; by: string | number; added: string | number; changed: string | number }
  'board.dialog.addedUnknown': { added: string | number; changed: string | number }
  'board.dialog.adding': undefined
  'board.dialog.agent': undefined
  'board.dialog.agentStatus': { agent: string | number; status: string | number }
  'board.dialog.archivedBanner': { cause: string; project: string | number }
  'board.dialog.archiving': undefined
  'board.dialog.blocked': undefined
  'board.dialog.blockedPlaceholder': undefined
  'board.dialog.bringingBack': undefined
  'board.dialog.cancel': undefined
  'board.dialog.column': undefined
  'board.dialog.comment': undefined
  'board.dialog.commentPlaceholder': undefined
  'board.dialog.comments': { n: string | number }
  'board.dialog.context': undefined
  'board.dialog.contextPlaceholder': undefined
  'board.dialog.creatingWorktree': undefined
  'board.dialog.delete': undefined
  'board.dialog.dependsOn': undefined
  'board.dialog.dependsOnPlaceholder': undefined
  'board.dialog.description': undefined
  'board.dialog.descriptionPlaceholder': undefined
  'board.dialog.history': { n: string | number }
  'board.dialog.labels': undefined
  'board.dialog.labelsPlaceholder': undefined
  'board.dialog.needsProject': undefined
  'board.dialog.needsTitle': undefined
  'board.dialog.newComment': undefined
  'board.dialog.noDescription': undefined
  'board.dialog.noProject': undefined
  'board.dialog.nobodyYet': undefined
  'board.dialog.posting': undefined
  'board.dialog.preview': undefined
  'board.dialog.project': undefined
  'board.dialog.projectGone': { project: string | number }
  'board.dialog.related': undefined
  'board.dialog.relatedPlaceholder': undefined
  'board.dialog.save': undefined
  'board.dialog.saveAndStart': undefined
  'board.dialog.savePostsIt': undefined
  'board.dialog.saving': undefined
  'board.dialog.start': undefined
  'board.dialog.startButton': undefined
  'board.dialog.startTip': undefined
  'board.dialog.startTipSave': undefined
  'board.dialog.starting': undefined
  'board.dialog.titlePlaceholder': undefined
  'board.dialog.tryAgain': undefined
  'board.dialog.waiting': undefined
  'board.dialog.waitingPlaceholder': undefined
  'board.dialog.write': undefined
  'board.discard.answer': undefined
  'board.discard.changes': undefined
  'board.discard.comment': undefined
  'board.discard.decision': undefined
  'board.discard.decisionChange': undefined
  'board.discard.discard': undefined
  'board.discard.keep': undefined
  'board.discard.message': { what: string | number }
  'board.discard.newCard': undefined
  'board.discard.title': undefined
  'board.doing.agent': undefined
  'board.doing.agentStatus': { agent: string | number; status: string | number }
  'board.doing.assign': undefined
  'board.doing.assignText': undefined
  'board.doing.button': undefined
  'board.doing.moving': undefined
  'board.doing.noAgents': undefined
  'board.doing.nobody': undefined
  'board.doing.nobodyFrom': { agent: string | number }
  'board.doing.start': undefined
  'board.doing.startText': undefined
  'board.doing.stopped': undefined
  'board.doing.title': { card: string | number }
  'board.duration.hours': { h: number }
  'board.duration.hoursMinutes': { h: number; min: string | number }
  'board.duration.minutes': { min: string | number }
  'board.duration.seconds': { s: string | number }
  'board.error.archive': undefined
  'board.error.change': undefined
  'board.error.inUse': undefined
  'board.error.move': undefined
  'board.error.newer': undefined
  'board.error.noBackup': undefined
  'board.error.noWorkspace': undefined
  'board.error.stopAgentsFirst': undefined
  'board.error.unarchive': undefined
  'board.error.unavailable': { error: string | number }
  'board.error.upgradeFirst': undefined
  'board.error.upgradeFirstStart': undefined
  'board.export.command': undefined
  'board.export.done': { n: number }
  'board.export.failed': undefined
  'board.field.agent': undefined
  'board.field.blocked': undefined
  'board.field.blockedBy': undefined
  'board.field.column': undefined
  'board.field.context': undefined
  'board.field.description': undefined
  'board.field.labels': undefined
  'board.field.links': undefined
  'board.field.project': undefined
  'board.field.title': undefined
  'board.filter.noProject': undefined
  'board.forYou.agree': { action: string }
  'board.forYou.agreeTip': undefined
  'board.forYou.answering': undefined
  'board.forYou.approve': undefined
  'board.forYou.asDecision': undefined
  'board.forYou.asDecisionTip': undefined
  'board.forYou.asked': { who: string; when: string | number }
  'board.forYou.checklist': undefined
  'board.forYou.chip': undefined
  'board.forYou.chipTip': { n: number; requests: string | number }
  'board.forYou.decline': undefined
  'board.forYou.declineNeeds': undefined
  'board.forYou.declineTitle': { request: string | number }
  'board.forYou.declineWhy': undefined
  'board.forYou.failed': undefined
  'board.forYou.heading': undefined
  'board.forYou.offer': { action: string }
  'board.forYou.offerReason': undefined
  'board.forYou.offerTip': { action: string }
  'board.forYou.reply': undefined
  'board.forYou.resolvedBy': { gone: string; decision: string | number; who: string; name: string | number }
  'board.forYou.resolvedHeading': undefined
  'board.forYou.rounds': undefined
  'board.forYou.saveAndMerge': undefined
  'board.forYou.send': undefined
  'board.forYou.sendTip': undefined
  'board.forYou.showAll': { all: string }
  'board.forYou.showStuck': undefined
  'board.forYou.tipAsks': { kind: string; who: string | number }
  'board.forYou.tipMore': { n: number }
  'board.forYou.tipOpen': undefined
  'board.forYou.todayValue': { today: string; value: string | number }
  'board.inbox.asks': undefined
  'board.inbox.asksWhat': { message: string | number }
  'board.inbox.assistant': undefined
  'board.inbox.cardRequests': { n: number }
  'board.inbox.changes': undefined
  'board.inbox.commits': { n: number }
  'board.inbox.diff': { files: number; insertions: string | number; deletions: string | number }
  'board.inbox.error': undefined
  'board.inbox.errorWhat': { message: string | number }
  'board.inbox.failed': undefined
  'board.inbox.failedWhy': { message: string | number }
  'board.inbox.finished': undefined
  'board.inbox.finishedCount': { n: number }
  'board.inbox.finishedHeading': { n: number }
  'board.inbox.finishedTip': undefined
  'board.inbox.merge': undefined
  'board.inbox.needYouCount': { n: number }
  'board.inbox.needYouEmptyHeading': undefined
  'board.inbox.needYouHeading': { n: number }
  'board.inbox.needYouThings': { agents: number; cards: number }
  'board.inbox.needsInput': undefined
  'board.inbox.needsInputWhat': { message: string | number }
  'board.inbox.nothing': undefined
  'board.inbox.panel': undefined
  'board.inbox.safeguard': undefined
  'board.inbox.safeguardSwitched': { to: string | number; from: string | number }
  'board.inbox.signin': undefined
  'board.inbox.toReview': undefined
  'board.inbox.toReviewCount': { n: number }
  'board.inbox.toReviewHeading': { n: string | number }
  'board.inbox.toReviewTip': undefined
  'board.inbox.uncommitted': { n: number }
  'board.kind.anyway': undefined
  'board.kind.askDetail': undefined
  'board.kind.askMessage': undefined
  'board.kind.askTitle': { kind: string; card: string | number }
  'board.kind.change': { kind: string }
  'board.kind.code': undefined
  'board.kind.confirm': undefined
  'board.kind.failed': undefined
  'board.kind.field': undefined
  'board.kind.keep': undefined
  'board.kind.newChoice': undefined
  'board.kind.noCode': undefined
  'board.kind.noCodeTip': undefined
  'board.kind.proposal': undefined
  'board.kind.proposedTip': undefined
  'board.kind.reason': undefined
  'board.kind.working': undefined
  'board.lane.afterRound': { where: string | number; round: string | number }
  'board.lane.andMore': { n: number }
  'board.lane.blocked': { card: string | number }
  'board.lane.blockedReason': { card: string | number; reason: string | number }
  'board.lane.finished': { n: number; cards: string | number }
  'board.lane.foldedMark': { card: string | number; mark: string | number }
  'board.lane.goneWhenEnded': { card: string | number }
  'board.lane.holdReason': { card: string | number; reason: string | number }
  'board.lane.holdWaiting': { card: string | number }
  'board.lane.holdWaitingShort': undefined
  'board.lane.inRound': { where: string | number; round: string | number }
  'board.lane.label': { card: string | number; title: string | number; where: string | number }
  'board.lane.labelWhenEnded': { card: string | number; title: string | number; where: string | number }
  'board.lane.more': { n: number; cards: string | number }
  'board.lane.notOnBoard': { card: string | number }
  'board.lane.oldRules': { enforced: string }
  'board.lane.openForMore': undefined
  'board.lane.reviewFailed': { card: string | number; round: string | number; next: string | number }
  'board.lane.reviewerGist': { gist: string | number }
  'board.lane.roundFailed': { where: string | number; round: string | number }
  'board.lane.unrecorded': { card: string | number; title: string | number }
  'board.lane.unrecordedUntitled': { card: string | number }
  'board.lane.workChecks': { passed: number; failed: number }
  'board.lane.workMerged': { commit: string | number }
  'board.lane.workNoCode': undefined
  'board.lane.workRefused': { times: number }
  'board.lane.workRevision': { review: string; revision: string | number }
  'board.lane.workStalePass': { now: string; approved: string | number; current: string | number }
  'board.lane.workVerdict': { pass: string; revision: string; current: string }
  'board.laneEdit.add': undefined
  'board.laneEdit.cancelChange': undefined
  'board.laneEdit.cards': undefined
  'board.laneEdit.dismiss': undefined
  'board.laneEdit.done': { op: string; card: string | number; lane: string | number }
  'board.laneEdit.handle': { card: string | number }
  'board.laneEdit.lastCard': { card: string | number }
  'board.laneEdit.leftOut': { n: number; cards: string | number }
  'board.laneEdit.locked': { card: string | number }
  'board.laneEdit.moveHere': undefined
  'board.laneEdit.noMatch': undefined
  'board.laneEdit.notLast': undefined
  'board.laneEdit.nothingToUndo': undefined
  'board.laneEdit.onOther': { builder: string | number }
  'board.laneEdit.otherWorkspace': undefined
  'board.laneEdit.queued': { card: string | number }
  'board.laneEdit.remove': { card: string | number }
  'board.laneEdit.said': { card: string | number; at: string | number; n: number }
  'board.laneEdit.search': undefined
  'board.laneEdit.stuck': { card: string | number }
  'board.laneEdit.undo': undefined
  'board.laneEdit.undoFailed': undefined
  'board.laneStart.addCard': undefined
  'board.laneStart.agentState': { agent: string | number; status: string | number }
  'board.laneStart.applyNow': undefined
  'board.laneStart.applyNowHint': { builder: string | number; card: string | number }
  'board.laneStart.applyNowNot': { builder: string | number; card: string | number; column: string }
  'board.laneStart.builder': undefined
  'board.laneStart.busyNow': { agents: string | number; n: number }
  'board.laneStart.cancel': undefined
  'board.laneStart.cards': undefined
  'board.laneStart.deferred': { agent: string | number }
  'board.laneStart.deferredText': { agent: string | number }
  'board.laneStart.down': { card: string | number }
  'board.laneStart.intro': undefined
  'board.laneStart.name': undefined
  'board.laneStart.noAgents': undefined
  'board.laneStart.noBuilders': undefined
  'board.laneStart.noCards': undefined
  'board.laneStart.noReviewer': undefined
  'board.laneStart.notRunning': undefined
  'board.laneStart.notStarted': { agent: string | number }
  'board.laneStart.notStartedText': { why: string | number; agent: string | number }
  'board.laneStart.note': undefined
  'board.laneStart.pool': { agents: string | number }
  'board.laneStart.poolNobody': undefined
  'board.laneStart.project': undefined
  'board.laneStart.remove': { card: string | number }
  'board.laneStart.reviewer': undefined
  'board.laneStart.show': undefined
  'board.laneStart.start': undefined
  'board.laneStart.started': { pair: string | number }
  'board.laneStart.startedText': { n: number }
  'board.laneStart.starting': undefined
  'board.laneStart.target': undefined
  'board.laneStart.targetDefault': { branch: string | number }
  'board.laneStart.title': undefined
  'board.laneStart.up': { card: string | number }
  'board.laneStart.waitAndStart': undefined
  'board.laneStart.waiting': { agents: string | number }
  'board.lanes.abandon': undefined
  'board.lanes.abandonConfirm': undefined
  'board.lanes.abandonMessage': undefined
  'board.lanes.abandonTitle': { lane: string | number }
  'board.lanes.alreadyEnd': { where: string; lane: string | number }
  'board.lanes.bar': { pair: string | number; finished: string | number; total: number }
  'board.lanes.barUnrecorded': { pair: string | number; total: number }
  'board.lanes.copyMerge': { commit: string | number }
  'board.lanes.edge': undefined
  'board.lanes.edgeTip': { lanes: string | number }
  'board.lanes.edgeValue': { shown: string | number; count: number }
  'board.lanes.end': undefined
  'board.lanes.endFailed': { lane: string | number }
  'board.lanes.endedCards': { n: number }
  'board.lanes.endedToday': { n: number }
  'board.lanes.endedTook': { time: string | number }
  'board.lanes.expand': { open: string; lane: string | number }
  'board.lanes.fold': undefined
  'board.lanes.freshBlocked': { agent: string | number; why: string; reason: string | number }
  'board.lanes.latestRun': { card: string | number; run: string | number; state: string }
  'board.lanes.legendButton': undefined
  'board.lanes.legendHold': { category: string | number }
  'board.lanes.legendLine': { category: string | number; stages: string | number }
  'board.lanes.legendTitle': undefined
  'board.lanes.mergeCopied': undefined
  'board.lanes.moveDown': undefined
  'board.lanes.moveUp': undefined
  'board.lanes.moved': { lane: string | number; at: string | number; n: number }
  'board.lanes.none': undefined
  'board.lanes.offSide': { agent: string | number; part: string }
  'board.lanes.oldRules': undefined
  'board.lanes.oldRulesTip': { enforced: string }
  'board.lanes.poolLastVerdict': { name: string | number; pass: string }
  'board.lanes.poolPair': { builder: string | number }
  'board.lanes.poolReviewing': { reviewing: string; name: string | number }
  'board.lanes.projectLink': { project: string | number }
  'board.lanes.queue': { lane: string | number }
  'board.lanes.queueState': { state: string }
  'board.lanes.queuedAdded': { n: number; cards: string | number }
  'board.lanes.queuedChange': { after: string; card: string | number; changes: string | number }
  'board.lanes.queuedMoves': { n: number; cards: string | number; builder: string | number }
  'board.lanes.queuedOrder': { cards: string | number }
  'board.lanes.queuedRemoved': { n: number; cards: string | number }
  'board.lanes.retryFresh': undefined
  'board.lanes.retryFreshFailed': { lane: string | number }
  'board.lanes.retryFreshShort': { agent: string | number }
  'board.lanes.round': { round: string | number }
  'board.lanes.show': undefined
  'board.lanes.slotLine': { line: string | number }
  'board.lanes.slotLink': { slot: string | number }
  'board.lanes.slotTip': { state: string; carried: string; since: string | number }
  'board.lanes.soFar': { time: string | number }
  'board.lanes.stalled': undefined
  'board.lanes.start': undefined
  'board.lanes.state': { state: string }
  'board.lanes.target': { branch: string | number }
  'board.lanes.targetTip': { branch: string | number }
  'board.lanes.teamPause': undefined
  'board.lanes.title': undefined
  'board.lanes.took': { time: string | number }
  'board.lanes.usualOrder': undefined
  'board.lanes.usualOrderDetail': undefined
  'board.lanes.usualOrderSaid': undefined
  'board.lanes.waitedAtLeast': { time: string | number }
  'board.lanes.waitedAtLeastTip': undefined
  'board.lanes.waiting': undefined
  'board.lanes.waitingForYou': { n: number }
  'board.lanes.waitingTip': { assistant: string; card: string | number; reason: string | number }
  'board.lanes.waits': { reason: string; card: string | number; ask: string; agent: string | number }
  'board.lanes.waitsDependency': { card: string | number; dependency: string | number }
  'board.lanes.waitsFresh': { agent: string | number }
  'board.lanes.waitsLink': undefined
  'board.lanes.waitsPreparing': { slot: string | number }
  'board.lanes.waitsSlotHeld': { slot: string | number; held: string; agent: string | number; broker: string | number; idle: string }
  'board.lanes.waitsStart': { card: string | number; why: string; agent: string | number }
  'board.lanes.waitsStartHeld': { card: string | number; slot: string | number; held: string; agent: string | number; program: string | number; more: number; broker: string | number; idle: string }
  'board.leftOut.detail': { hasPaths: string; paths: string | number; card: string | number }
  'board.leftOut.include': { n: number }
  'board.leftOut.leave': { n: number }
  'board.leftOut.message': { n: number; card: string | number }
  'board.leftOut.title': { card: string | number }
  'board.links.archivedTitle': { card: string | number; title: string | number; column: string | number }
  'board.links.title': { card: string | number; title: string | number; column: string | number }
  'board.menu.clearWaiting': undefined
  'board.menu.delete': undefined
  'board.menu.markWaiting': undefined
  'board.menu.moveTo': undefined
  'board.menu.nextRound': undefined
  'board.menu.open': undefined
  'board.menu.start': undefined
  'board.menu.startLane': undefined
  'board.merge.fold': undefined
  'board.merge.region': undefined
  'board.merge.time': { sofar: string | number; left: string | number }
  'board.merge.timeOver': { sofar: string | number }
  'board.merge.unfold': undefined
  'board.move.anyway': undefined
  'board.move.askDetail': undefined
  'board.move.askMessage': { n: number }
  'board.move.askTitle': { card: string | number; column: string | number }
  'board.move.notMoved': { column: string | number }
  'board.move.reason': undefined
  'board.move.refused': { card: string | number; column: string | number }
  'board.move.stopped': { card: string | number; column: string | number }
  'board.newCard.button': undefined
  'board.newCard.tip': undefined
  'board.overview.blocked': undefined
  'board.overview.noCards': undefined
  'board.overview.openTasks': undefined
  'board.overview.stalled': undefined
  'board.overview.waitingForReview': undefined
  'board.panel.allProjects': undefined
  'board.panel.info': undefined
  'board.panel.refresh': undefined
  'board.panel.stalledInfo': undefined
  'board.panel.workspace': undefined
  'board.progress.agentGone': { agent: string | number; project: string | number }
  'board.progress.allAgents': undefined
  'board.progress.allProjects': undefined
  'board.progress.anAgent': undefined
  'board.progress.attention': { n: number }
  'board.progress.badgeLanes': { n: number }
  'board.progress.badgeMerges': { n: number }
  'board.progress.badgeRuns': { n: number }
  'board.progress.blocksReview': { card: string | number }
  'board.progress.cantShow': { agent: string | number }
  'board.progress.combworkRun': undefined
  'board.progress.copied': { what: string }
  'board.progress.copiesRun': undefined
  'board.progress.copyCommand': undefined
  'board.progress.copyDetails': undefined
  'board.progress.copyFailed': { what: string }
  'board.progress.copyRevision': { revision: string | number }
  'board.progress.detailsOf': { run: string | number }
  'board.progress.dismiss': undefined
  'board.progress.empty': undefined
  'board.progress.filterAgent': undefined
  'board.progress.filterProject': undefined
  'board.progress.fold': undefined
  'board.progress.hideDetails': { run: string | number }
  'board.progress.inCopy': { copy: string | number }
  'board.progress.mergeQueue': undefined
  'board.progress.miniWaiting': { agent: string | number; run: string | number }
  'board.progress.moreOthers': { n: number }
  'board.progress.moreRuns': { n: number }
  'board.progress.noAssistant': undefined
  'board.progress.noMerges': undefined
  'board.progress.openCard': { card: string | number }
  'board.progress.openLog': undefined
  'board.progress.openLogFailed': undefined
  'board.progress.projectGone': undefined
  'board.progress.railFiltered': { name: string | number; summary: string | number; all: number }
  'board.progress.railFilteredNone': { name: string | number; all: number }
  'board.progress.railLabel': undefined
  'board.progress.railShowing': { name: string | number; shown: number; all: number }
  'board.progress.recentHover': { agent: string | number; run: string | number; state: string | number }
  'board.progress.recentHoverTook': { agent: string | number; run: string | number; state: string | number; took: string | number }
  'board.progress.region': undefined
  'board.progress.revisionCopied': { revision: string | number }
  'board.progress.revisionCopyFailed': undefined
  'board.progress.script': undefined
  'board.progress.scriptRun': undefined
  'board.progress.show': undefined
  'board.progress.showAgent': { agent: string | number; run: string | number }
  'board.progress.showAssistant': { run: string | number }
  'board.progress.showDetails': { run: string | number }
  'board.progress.showLog': undefined
  'board.progress.showLogFailed': undefined
  'board.progress.showTheAgent': undefined
  'board.progress.slotRun': { slot: string | number }
  'board.progress.stepOf': { step: number; total: number }
  'board.progress.stepOfNamed': { step: number; total: number; name: string | number }
  'board.progress.stopIsolated': undefined
  'board.progress.tab': { tab: string }
  'board.progress.tabs': undefined
  'board.progress.title': undefined
  'board.progress.waiting': undefined
  'board.queue.behind': { n: number; to: string | number; from: string | number }
  'board.queue.behindTip': { from: string | number }
  'board.queue.behindUnknown': { to: string | number; from: string | number }
  'board.queue.empty': undefined
  'board.queue.filesMore': { n: number }
  'board.queue.forward': undefined
  'board.queue.forwardAlready': { to: string | number; from: string | number }
  'board.queue.forwardAskConfirm': undefined
  'board.queue.forwardAskMessage': { from: string | number; to: string | number }
  'board.queue.forwardAskTitle': { to: string | number; from: string | number }
  'board.queue.forwardCancel': undefined
  'board.queue.forwardChooseMessage': { to: string | number }
  'board.queue.forwardChooseTitle': { to: string | number }
  'board.queue.forwardFailed': undefined
  'board.queue.forwardLocalAhead': { n: number; from: string | number; to: string | number }
  'board.queue.forwardResolving': { card: string | number }
  'board.queue.forwardUpToDate': { to: string | number; from: string | number }
  'board.queue.inVersionControl': undefined
  'board.queue.merged': { card: string | number; result: string | number }
  'board.queue.moreReturned': { n: number }
  'board.queue.openCard': undefined
  'board.queue.openNamed': { card: string | number }
  'board.queue.pause': undefined
  'board.queue.pause.approval': { card: string | number; target: string | number }
  'board.queue.pause.byAssistant': undefined
  'board.queue.pause.byYou': undefined
  'board.queue.pause.catchUpChanges': { card: string | number; target: string | number; files: string; count: number }
  'board.queue.pause.checkedOut': { target: string | number }
  'board.queue.pause.commit': undefined
  'board.queue.pause.commitTip': { files: string | number; target: string | number }
  'board.queue.pause.fetchFailed': { target: string | number }
  'board.queue.pause.fetchFailedCatchUp': { target: string | number; card: string | number }
  'board.queue.pause.folderBusy': { target: string | number }
  'board.queue.pause.hookTimedOut': undefined
  'board.queue.pause.identity': undefined
  'board.queue.pause.mergeChoice': { card: string | number }
  'board.queue.pause.needsYou': undefined
  'board.queue.pause.noUpstream': { target: string | number; files: string }
  'board.queue.pause.other': { reason: string | number }
  'board.queue.pause.publishFailed': { card: string | number; target: string | number }
  'board.queue.pause.publishRefused': { card: string | number; target: string | number }
  'board.queue.pause.publishUnknown': { card: string | number; target: string | number }
  'board.queue.pause.pushFailed': { card: string | number; target: string | number }
  'board.queue.pause.pushNoRemote': { card: string | number; target: string | number }
  'board.queue.pause.pushRefused': { card: string | number; target: string | number }
  'board.queue.pause.pushRejected': { card: string | number; target: string | number }
  'board.queue.pause.pushUnreadable': { card: string | number; target: string | number }
  'board.queue.pause.remoteAmbiguous': { target: string | number; files: string }
  'board.queue.pause.remoteDiverged': { target: string | number }
  'board.queue.pause.remoteUnsupported': { target: string | number }
  'board.queue.pause.rulesOff': undefined
  'board.queue.pause.setAside': undefined
  'board.queue.pause.setAsideTip': { files: string | number }
  'board.queue.pause.signing': undefined
  'board.queue.pause.signingWaits': undefined
  'board.queue.pause.staged': { files: string; target: string | number; count: number }
  'board.queue.pause.subfolderTarget': { card: string | number }
  'board.queue.pause.targetMovesFast': { target: string | number }
  'board.queue.pause.uncounted': undefined
  'board.queue.pause.unstagedChanges': { files: string; target: string | number; count: number }
  'board.queue.pause.wrongBranch': { target: string | number }
  'board.queue.pauseFailed': undefined
  'board.queue.pauseTip': undefined
  'board.queue.pulse': { target: string | number; state: string; card: string | number; n: number }
  'board.queue.queued': { n: number; cards: string | number }
  'board.queue.recent.cancelled': { reason: string }
  'board.queue.recent.heading': undefined
  'board.queue.recent.lasted': { duration: string | number }
  'board.queue.recent.merged': undefined
  'board.queue.recent.more': undefined
  'board.queue.recent.none': undefined
  'board.queue.recent.paused': { reason: string; code: string | number }
  'board.queue.recent.push': { state: string }
  'board.queue.recent.returned': { why: string | number }
  'board.queue.recent.stillPaused': undefined
  'board.queue.recent.took': { duration: string | number }
  'board.queue.remove': undefined
  'board.queue.removeConfirm': undefined
  'board.queue.removeFailed': undefined
  'board.queue.removeForwardMessage': { to: string | number; from: string | number }
  'board.queue.removeMessage': undefined
  'board.queue.removeNamed': { card: string | number }
  'board.queue.removeTitle': { card: string | number }
  'board.queue.resume': undefined
  'board.queue.resumeFailed': undefined
  'board.queue.returnWhy': { reason: string; files: string; check: string; target: string | number; why: string | number }
  'board.queue.returned': { card: string | number; why: string | number }
  'board.queue.returnedTo': { card: string | number; builder: string | number; why: string | number }
  'board.queue.runBy': { profile: string | number }
  'board.queue.saidMerged': { card: string | number }
  'board.queue.saidPaused': { target: string | number }
  'board.queue.saidResumed': { target: string | number }
  'board.queue.saidReturned': { card: string | number; why: string | number }
  'board.queue.showLog': undefined
  'board.queue.showLogFailed': undefined
  'board.queue.sofar': { sofar: string | number }
  'board.queue.sofarOf': { sofar: string | number; estimate: string | number }
  'board.queue.step': { step: string; check: string | number; target: string | number }
  'board.queue.stillPaused': undefined
  'board.queue.testing': { card: string | number; target: string | number; head: string | number; step: string | number }
  'board.queue.testingNoHead': { card: string | number; target: string | number; step: string | number }
  'board.queue.title': { target: string | number }
  'board.queue.transient': { why: string | number }
  'board.queue.waitingOn': { cards: string | number }
  'board.readOnly.newer': undefined
  'board.restore09.done': undefined
  'board.restore09.doneDetail': { file: string | number }
  'board.restore09.message': { when: string | number }
  'board.restore09.none': undefined
  'board.restore09.restore': undefined
  'board.restore09.restoring': undefined
  'board.restore09.title': undefined
  'board.review.line': { agent: string | number; ago: string | number }
  'board.review.lineNotRunning': { agent: string | number }
  'board.review.lineRemoved': { agent: string | number }
  'board.review.tip': { agent: string | number; ago: string | number }
  'board.review.tipNotRunning': { agent: string | number; ago: string | number }
  'board.review.tipRemoved': { agent: string | number; ago: string | number }
  'board.reviewSkip.askMessage': undefined
  'board.reviewSkip.askTitle': { card: string | number }
  'board.reviewSkip.change': { skip: string }
  'board.reviewSkip.confirm': undefined
  'board.reviewSkip.confirmLabel': undefined
  'board.reviewSkip.failed': undefined
  'board.reviewSkip.field': undefined
  'board.reviewSkip.keep': undefined
  'board.reviewSkip.newChoice': undefined
  'board.reviewSkip.note': undefined
  'board.reviewSkip.proposal': { reason: string | number }
  'board.reviewSkip.proposedMark': undefined
  'board.reviewSkip.proposedTip': undefined
  'board.reviewSkip.reason': undefined
  'board.reviewSkip.reviewed': undefined
  'board.reviewSkip.skipped': undefined
  'board.reviewSkip.skippedTip': { who: string; reason: string | number }
  'board.reviewSkip.working': undefined
  'board.run.agentStopped': undefined
  'board.run.failedAfter': { took: string | number }
  'board.run.finishing': { took: string | number }
  'board.run.goneAfter': { took: string | number }
  'board.run.overEstimate': { took: string | number }
  'board.run.passedIn': { took: string | number }
  'board.run.ranThenWaiting': { took: string | number; waited: string | number }
  'board.run.staleFor': { ago: string | number }
  'board.run.state': { state: string }
  'board.run.stoppedAfter': { took: string | number }
  'board.run.timeLeft': { took: string | number; left: string | number }
  'board.run.waiting': { waited: string | number }
  'board.run.wordsStale': { run: string | number }
  'board.run.wordsWaiting': { run: string | number }
  'board.runs.agent': undefined
  'board.runs.anyAgent': undefined
  'board.runs.anyLane': undefined
  'board.runs.cardRun': { card: string | number; run: string | number }
  'board.runs.cardSummary': { n: number; failed: number; stopped: number; running: string }
  'board.runs.clear': undefined
  'board.runs.dockEdge': undefined
  'board.runs.dockEdgeTip': { rows: number }
  'board.runs.dockEdgeValue': { rows: number }
  'board.runs.failedOnly': undefined
  'board.runs.finished': undefined
  'board.runs.group': { what: string | number; n: number; outcome: string; failed: number }
  'board.runs.lane': undefined
  'board.runs.noFinished': undefined
  'board.runs.none': undefined
  'board.runs.noneMatch': undefined
  'board.runs.noneToday': undefined
  'board.runs.other': undefined
  'board.runs.queueChecks': { checks: string | number; failed: number }
  'board.runs.search': undefined
  'board.runs.today': undefined
  'board.runs.yesterday': undefined
  'board.setAside.add': undefined
  'board.setAside.added': { n: string | number }
  'board.setAside.adding': undefined
  'board.setAside.close': undefined
  'board.setAside.discard': undefined
  'board.setAside.discardButton': undefined
  'board.setAside.discardMessage': { readable: string }
  'board.setAside.discardTitle': { title: string | number }
  'board.setAside.discarding': undefined
  'board.setAside.intro': undefined
  'board.setAside.keeps': { n: string | number }
  'board.setAside.links': undefined
  'board.setAside.loading': undefined
  'board.setAside.made': { by: string | number; when: string | number }
  'board.setAside.menu': { n: number }
  'board.setAside.none': undefined
  'board.setAside.number': { n: string | number }
  'board.setAside.taken': { n: string | number }
  'board.setAside.title': undefined
  'board.setAside.unreadable': undefined
  'board.setAside.where': { project: string; column: string | number; comments: number }
  'board.slots.agentMerging': { agent: string | number; cards: string }
  'board.slots.agentNext': { agent: string | number; cards: string }
  'board.slots.free': undefined
  'board.slots.freeNext': { agent: string | number }
  'board.slots.held': { holder: string | number; sofar: string | number; left: string | number }
  'board.slots.heldOver': { holder: string | number; sofar: string | number }
  'board.slots.into': { branch: string | number }
  'board.slots.line': { name: string | number; state: string | number }
  'board.slots.minutes': { n: number }
  'board.slots.note': { who: string | number; branch: string | number; waiting: number }
  'board.slots.release': undefined
  'board.slots.releaseAgent': { agent: string | number; project: string | number; branch: string | number }
  'board.slots.releaseFailed': undefined
  'board.slots.releaseNext': { agent: string | number }
  'board.slots.releaseTipAgent': { agent: string | number }
  'board.slots.releaseTipYou': undefined
  'board.slots.releaseTitle': undefined
  'board.slots.releaseYours': { project: string | number; branch: string | number }
  'board.slots.underMinute': undefined
  'board.slots.waiting': { agents: string | number }
  'board.slots.waitingToMerge': { agent: string | number }
  'board.slots.youMerging': undefined
  'board.slots.youMergingStart': undefined
  'board.stall.hintFollowUp': undefined
  'board.stall.hintForward': undefined
  'board.stall.hintLaneOrder': undefined
  'board.stall.hintLoopStep': undefined
  'board.stall.hintNobody': undefined
  'board.stall.hintNotWatching': undefined
  'board.stall.hintReviewSilent': undefined
  'board.stall.hintReviewVerdict': undefined
  'board.stall.hintReviewWait': undefined
  'board.stall.hintWakeUntaken': undefined
  'board.stalled.followUpWait': { builder: string | number; card: string | number; waited: string | number }
  'board.stalled.forwardWaits': { from: string | number; to: string | number; removeOnly: string }
  'board.stalled.laneOrderWait': { reviewer: string | number; other: string | number; card: string | number; builder: string | number; waited: string | number }
  'board.stalled.loopStepWait': { builder: string | number; card: string | number; waited: string | number }
  'board.stalled.noAgent': undefined
  'board.stalled.notRunning': { agent: string | number }
  'board.stalled.notWatching': { agent: string | number; card: string | number }
  'board.stalled.removed': { agent: string | number }
  'board.stalled.removedUnnamed': undefined
  'board.stalled.reviewVerdictWait': { agent: string | number; card: string | number; waited: string | number }
  'board.stalled.reviewWait': { agent: string | number; card: string | number; waited: string | number }
  'board.stalled.reviewWaitBusy': { agent: string | number; card: string | number; waited: string | number }
  'board.stalled.reviewWaitSilent': { agent: string | number; card: string | number; silent: string | number; waited: string | number }
  'board.stalled.startFailed': { agent: string | number; why: string | number }
  'board.stalled.startWaiting': { agent: string | number; why: string | number }
  'board.stalled.wakeUntaken': { agent: string | number; card: string | number }
  'board.start.busy': { status: string | number }
  'board.start.checkingConnection': undefined
  'board.start.idle': { status: string | number }
  'board.start.intro': undefined
  'board.start.name': undefined
  'board.start.namePlaceholder': undefined
  'board.start.newAgent': undefined
  'board.start.newAgentText': undefined
  'board.start.noProject': undefined
  'board.start.notGit': undefined
  'board.start.ok': undefined
  'board.start.projectGone': { project: string | number }
  'board.start.providerOff': { provider: string | number }
  'board.start.show': undefined
  'board.start.started': { card: string | number; agent: string | number }
  'board.start.stopped': undefined
  'board.start.title': { card: string | number; title: string | number }
  'board.start.titleShort': { card: string | number }
  'board.start.worktreeAgent': undefined
  'board.start.worktreeText': undefined
  'board.strip.count': { state: string; n: number }
  'board.strip.oneRun': { state: string }
  'board.strip.runs': { n: number; states: string | number }
  'board.target.failed': undefined
  'board.target.field': undefined
  'board.target.kept': { branch: string | number }
  'board.target.keptUnknown': undefined
  'board.target.mark': { branch: string | number }
  'board.target.markTip': { branch: string | number }
  'board.target.own': { branch: string | number }
  'board.team.cw': undefined
  'board.team.endDetail': undefined
  'board.team.endFailed': { label: string | number }
  'board.team.endIt': undefined
  'board.team.endMessage': { agent: string | number; label: string | number; pid: string | number }
  'board.team.endTitle': undefined
  'board.team.install': undefined
  'board.team.item': { kind: string; agent: string | number; label: string | number; pid: string | number }
  'board.team.notParked': undefined
  'board.team.otherNotPaused': { name: string | number }
  'board.team.parked': undefined
  'board.team.pause': undefined
  'board.team.pauseFailed': { n: number; names: string | number }
  'board.team.pauseFirst': undefined
  'board.team.pausing': { n: number }
  'board.team.resume': undefined
  'board.team.showWindow': undefined
  'board.team.showWindowTitle': undefined
  'board.team.thisWorkspace': undefined
  'board.team.windowGone': { name: string | number }
  'board.toolbar.archived': { n: number }
  'board.toolbar.forYou': { n: number }
  'board.toolbar.more': undefined
  'board.toolbar.search': undefined
  'board.toolbar.startLane': undefined
  'board.upgrade.askDetail': undefined
  'board.upgrade.askMessage': undefined
  'board.upgrade.askTitle': undefined
  'board.upgrade.banner': undefined
  'board.upgrade.bannerButton': undefined
  'board.upgrade.done': undefined
  'board.upgrade.doneDetail': undefined
  'board.upgrade.learnMore': undefined
  'board.upgrade.notNow': undefined
  'board.upgrade.upgrade': undefined
  'board.upgrade.upgrading': undefined
  'board.view.intro': undefined
  'board.view.noWorkspace': undefined
  'board.view.title': undefined
  'board.view.workspaceCards': undefined
  'board.work.accepted': { when: string | number }
  'board.work.adopted': { column: string | number }
  'board.work.backAtApproved': { revision: string | number }
  'board.work.badgeOutside': undefined
  'board.work.badgeOverride': { by: string; rules: string | number; hasReason: string; reason: string | number }
  'board.work.badgeStale': undefined
  'board.work.base': undefined
  'board.work.branch': undefined
  'board.work.carriedOver': { from: string | number; to: string | number }
  'board.work.change': { commits: number; change: string | number }
  'board.work.check': { name: string | number; result: string; counted: string }
  'board.work.doneUnproved': { when: string | number }
  'board.work.failed': { error: string | number }
  'board.work.files': { n: number }
  'board.work.filesNotRead': { note: string; why: string | number }
  'board.work.folder': undefined
  'board.work.folderGone': { folder: string | number }
  'board.work.inTarget': { target: string | number }
  'board.work.integrated': { method: string; target: string | number; result: string | number }
  'board.work.leftTarget': { target: string | number; revision: string | number }
  'board.work.mergedInPart': { target: string | number }
  'board.work.noCode': undefined
  'board.work.noRecord': undefined
  'board.work.noRevision': undefined
  'board.work.none': undefined
  'board.work.notRead': { note: string; why: string | number }
  'board.work.notReady': { slot: string | number; stale: string; why: string | number }
  'board.work.openFile': { path: string | number }
  'board.work.outsideCombwork': undefined
  'board.work.outsideRules': { rules: string | number }
  'board.work.overridden': undefined
  'board.work.preWorkflow': undefined
  'board.work.projectFolder': undefined
  'board.work.reading': undefined
  'board.work.retry': undefined
  'board.work.revisionNotRead': { note: string; why: string | number }
  'board.work.revisions': undefined
  'board.work.round': { round: number }
  'board.work.staleChange': { approved: string | number; current: string | number }
  'board.work.staleDecision': undefined
  'board.work.staleNext': { approved: string | number }
  'board.work.target': undefined
  'board.work.title': undefined
  'board.work.verdict': { reviewer: string | number; pass: string; current: string }
  'board.work.via': { via: string }
  'board.work.workspace': undefined
  'board.workQueue.advance': { target: string | number }
  'board.workQueue.advancing': { target: string | number }
  'board.workQueue.answerFailed': undefined
  'board.workQueue.approve': undefined
  'board.workQueue.approved': undefined
  'board.workQueue.cancelled': { reason: string }
  'board.workQueue.command': { purpose: string; folder: string | number }
  'board.workQueue.commands': undefined
  'board.workQueue.conflictFiles': undefined
  'board.workQueue.copied': undefined
  'board.workQueue.copy': undefined
  'board.workQueue.copyFailed': undefined
  'board.workQueue.copyNamed': { purpose: string }
  'board.workQueue.decline': undefined
  'board.workQueue.declineNeeds': undefined
  'board.workQueue.declineTitle': { target: string | number }
  'board.workQueue.declineWhy': undefined
  'board.workQueue.expected': undefined
  'board.workQueue.files': { n: number }
  'board.workQueue.forwardNext': { from: string | number; to: string | number }
  'board.workQueue.forwardRemoveOnly': { from: string | number; to: string | number }
  'board.workQueue.heading': undefined
  'board.workQueue.hideLog': undefined
  'board.workQueue.noBranch': undefined
  'board.workQueue.noCommands': undefined
  'board.workQueue.output': { n: number }
  'board.workQueue.paused': { target: string | number }
  'board.workQueue.queued': { target: string | number; position: number }
  'board.workQueue.queuedNoPlace': { target: string | number }
  'board.workQueue.remove': undefined
  'board.workQueue.resolve': undefined
  'board.workQueue.resolveConfirm': undefined
  'board.workQueue.resolveFailed': undefined
  'board.workQueue.resolveMessage': { card: string | number; to: string | number; from: string | number; revision: string | number }
  'board.workQueue.resolveTitle': { card: string | number }
  'board.workQueue.resolved': { card: string | number }
  'board.workQueue.result': undefined
  'board.workQueue.retried': undefined
  'board.workQueue.retry': undefined
  'board.workQueue.retryApprovedMessage': { revision: string | number }
  'board.workQueue.retryConfirm': undefined
  'board.workQueue.retryFailed': undefined
  'board.workQueue.retryMessage': { revision: string | number }
  'board.workQueue.retryTitle': { card: string | number }
  'board.workQueue.retryUsed': undefined
  'board.workQueue.retryWaits': { step: string }
  'board.workQueue.returned': { when: string | number; why: string | number }
  'board.workQueue.showRun': undefined
  'board.workQueue.side': { side: string }
  'board.workQueue.stuck': { target: string | number }
  'board.workQueue.stuckBranch': undefined
  'board.workQueue.stuckFolder': undefined
  'board.workQueue.stuckRef': { target: string | number }
  'board.workQueue.testing': { step: string | number }
  'board.workQueue.unreadRef': undefined
  'board.workQueue.waiting': { target: string | number; cards: string | number }
  'board.workflows': undefined
}
