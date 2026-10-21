// Generated from locales/en/board.json: do not edit. Each message's placeholders and their types, for tr(): a
// global script, so its interface merges with every other area's (shared/i18n/msg.ts).
interface HiveMessageValues {
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
  'board.batch.andMore': { cards: string | number; n: number }
  'board.batch.archived': { n: number }
  'board.batch.backFailed': undefined
  'board.batch.broughtBack': { n: number }
  'board.batch.leftOnBoard': { n: number; why: string | number }
  'board.batch.noneBack': { failed: string | number }
  'board.batch.nothingArchived': undefined
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
  'board.card.stalled': { why: string | number }
  'board.card.stalledMark': undefined
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
  'board.columns.more': { column: string | number }
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
  'board.costs.cost': undefined
  'board.costs.laneFailed': undefined
  'board.costs.laneLoading': undefined
  'board.costs.note': { zero: string | number }
  'board.costs.onCards': undefined
  'board.costs.overhead': undefined
  'board.costs.overheadNote': undefined
  'board.costs.reviewer': undefined
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
  'board.details.countsAsCheck': { name: string | number }
  'board.details.ended': undefined
  'board.details.exitCode': undefined
  'board.details.gone': undefined
  'board.details.interrupted': undefined
  'board.details.lastStep': { step: string | number }
  'board.details.line': { label: string | number; text: string | number }
  'board.details.log': undefined
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
  'board.details.took': undefined
  'board.details.tookSoFar': { took: string | number; expected: string }
  'board.details.tookTotal': { took: string | number; expected: string }
  'board.details.waitingSince': { since: string | number; waiting: string | number }
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
  'board.dialog.write': undefined
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
  'board.inbox.asks': undefined
  'board.inbox.asksWhat': { message: string | number }
  'board.inbox.assistant': undefined
  'board.inbox.changes': undefined
  'board.inbox.commits': { n: number }
  'board.inbox.diff': { files: number; insertions: string | number; deletions: string | number }
  'board.inbox.failed': undefined
  'board.inbox.failedWhy': { message: string | number }
  'board.inbox.finished': undefined
  'board.inbox.merge': undefined
  'board.inbox.needYouCount': { n: number }
  'board.inbox.needYouEmptyHeading': undefined
  'board.inbox.needYouHeading': { n: string | number }
  'board.inbox.needYouTip': undefined
  'board.inbox.needsInput': undefined
  'board.inbox.needsInputWhat': { message: string | number }
  'board.inbox.nothing': undefined
  'board.inbox.panel': undefined
  'board.inbox.safeguard': undefined
  'board.inbox.safeguardSwitched': { to: string | number; from: string | number }
  'board.inbox.toReview': undefined
  'board.inbox.toReviewCount': { n: number }
  'board.inbox.toReviewHeading': { n: string | number }
  'board.inbox.toReviewTip': undefined
  'board.inbox.uncommitted': { n: number }
  'board.lane.afterRound': { where: string | number; round: string | number }
  'board.lane.andMore': { n: number }
  'board.lane.blocked': { card: string | number }
  'board.lane.blockedReason': { card: string | number; reason: string | number }
  'board.lane.finished': { n: number; cards: string | number }
  'board.lane.goneWhenEnded': { card: string | number }
  'board.lane.holdReason': { card: string | number; reason: string | number }
  'board.lane.holdWaiting': { card: string | number }
  'board.lane.holdWaitingShort': undefined
  'board.lane.inRound': { where: string | number; round: string | number }
  'board.lane.label': { card: string | number; title: string | number; where: string | number }
  'board.lane.labelWhenEnded': { card: string | number; title: string | number; where: string | number }
  'board.lane.more': { n: number; cards: string | number }
  'board.lane.notOnBoard': { card: string | number }
  'board.lane.openForMore': undefined
  'board.lane.reviewFailed': { card: string | number; round: string | number; next: string | number }
  'board.lane.reviewerGist': { gist: string | number }
  'board.lane.roundFailed': { where: string | number; round: string | number }
  'board.lane.unrecorded': { card: string | number; title: string | number }
  'board.lane.unrecordedUntitled': { card: string | number }
  'board.lane.workChecks': { passed: number; failed: number }
  'board.lane.workMerged': { commit: string | number }
  'board.lane.workRevision': { review: string; revision: string | number }
  'board.lane.workVerdict': { pass: string; revision: string; current: string }
  'board.lanes.alreadyEnd': { where: string; lane: string | number }
  'board.lanes.bar': { pair: string | number; finished: string | number; total: number }
  'board.lanes.barUnrecorded': { pair: string | number; total: number }
  'board.lanes.edge': undefined
  'board.lanes.edgeTip': { lanes: string | number }
  'board.lanes.edgeValue': { shown: string | number; count: number }
  'board.lanes.fold': undefined
  'board.lanes.moveDown': undefined
  'board.lanes.moveUp': undefined
  'board.lanes.moved': { lane: string | number; at: string | number; n: number }
  'board.lanes.show': undefined
  'board.lanes.stalled': undefined
  'board.lanes.state': { state: string }
  'board.lanes.title': undefined
  'board.lanes.usualOrder': undefined
  'board.lanes.usualOrderDetail': undefined
  'board.lanes.usualOrderSaid': undefined
  'board.links.archivedTitle': { card: string | number; title: string | number; column: string | number }
  'board.links.title': { card: string | number; title: string | number; column: string | number }
  'board.menu.delete': undefined
  'board.menu.moveTo': undefined
  'board.menu.nextRound': undefined
  'board.menu.open': undefined
  'board.menu.start': undefined
  'board.merge.fold': undefined
  'board.merge.region': undefined
  'board.merge.time': { sofar: string | number; left: string | number }
  'board.merge.timeOver': { sofar: string | number }
  'board.merge.unfold': undefined
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
  'board.progress.cantShow': { agent: string | number }
  'board.progress.copied': { what: string }
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
  'board.progress.miniWaiting': { agent: string | number; run: string | number }
  'board.progress.moreOthers': { n: number }
  'board.progress.moreRuns': { n: number }
  'board.progress.noAssistant': undefined
  'board.progress.openCard': { card: string | number }
  'board.progress.openLog': undefined
  'board.progress.openLogFailed': undefined
  'board.progress.projectGone': undefined
  'board.progress.railFiltered': { name: string | number; summary: string | number; all: number }
  'board.progress.railFilteredNone': { name: string | number; all: number }
  'board.progress.railLabel': undefined
  'board.progress.railShowing': { name: string | number; shown: number; all: number }
  'board.progress.recent': undefined
  'board.progress.recentFold': undefined
  'board.progress.recentHover': { agent: string | number; run: string | number; state: string | number }
  'board.progress.recentHoverTook': { agent: string | number; run: string | number; state: string | number; took: string | number }
  'board.progress.recentRuns': undefined
  'board.progress.recentShow': undefined
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
  'board.progress.stepOf': { step: number; total: number }
  'board.progress.stepOfNamed': { step: number; total: number; name: string | number }
  'board.progress.title': undefined
  'board.progress.waiting': undefined
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
  'board.stall.hintNobody': undefined
  'board.stall.hintNotWatching': undefined
  'board.stall.hintReviewSilent': undefined
  'board.stall.hintReviewVerdict': undefined
  'board.stall.hintReviewWait': undefined
  'board.stall.hintWakeUntaken': undefined
  'board.stalled.noAgent': undefined
  'board.stalled.notRunning': { agent: string | number }
  'board.stalled.notWatching': { agent: string | number; card: string | number }
  'board.stalled.removed': { agent: string | number }
  'board.stalled.removedUnnamed': undefined
  'board.stalled.reviewVerdictWait': { agent: string | number; card: string | number; waited: string | number }
  'board.stalled.reviewWait': { agent: string | number; card: string | number; waited: string | number }
  'board.stalled.reviewWaitBusy': { agent: string | number; card: string | number; waited: string | number }
  'board.stalled.reviewWaitSilent': { agent: string | number; card: string | number; silent: number; waited: string | number }
  'board.stalled.wakeUntaken': { agent: string | number; card: string | number }
  'board.start.busy': { status: string | number }
  'board.start.idle': { status: string | number }
  'board.start.intro': undefined
  'board.start.name': undefined
  'board.start.namePlaceholder': undefined
  'board.start.newAgent': undefined
  'board.start.newAgentText': undefined
  'board.start.noProject': undefined
  'board.start.notGit': undefined
  'board.start.ok': undefined
  'board.start.projectDefault': { provider: string | number }
  'board.start.projectGone': { project: string | number }
  'board.start.provider': undefined
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
  'board.toolbar.archived': { n: number }
  'board.toolbar.more': undefined
  'board.toolbar.search': undefined
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
  'board.work.badgeOutside': undefined
  'board.work.badgeStale': undefined
  'board.work.base': undefined
  'board.work.branch': undefined
  'board.work.carriedOver': { from: string | number; to: string | number }
  'board.work.check': { name: string | number; result: string; counted: string }
  'board.work.failed': { error: string | number }
  'board.work.files': { n: number }
  'board.work.folder': undefined
  'board.work.integrated': { method: string; target: string | number; result: string | number }
  'board.work.leftTarget': { target: string | number; revision: string | number }
  'board.work.mergedInPart': { target: string | number }
  'board.work.noCode': undefined
  'board.work.noRecord': undefined
  'board.work.noRevision': undefined
  'board.work.none': undefined
  'board.work.openFile': { path: string | number }
  'board.work.outsideHive': undefined
  'board.work.outsideRules': { rules: string | number }
  'board.work.overridden': undefined
  'board.work.preWorkflow': undefined
  'board.work.projectFolder': undefined
  'board.work.reading': undefined
  'board.work.retry': undefined
  'board.work.revisions': undefined
  'board.work.round': { round: number }
  'board.work.staleChange': { approved: string | number; current: string | number }
  'board.work.staleDecision': undefined
  'board.work.target': undefined
  'board.work.title': undefined
  'board.work.verdict': { reviewer: string | number; pass: string; current: string }
}
