// Generated from locales/en/workflow.json: do not edit. Each message's placeholders and their types, for tr(): a
// global script, so its interface merges with every other area's (shared/i18n/msg.ts).
interface CombworkMessageValues {
  'workflow.approveNote': { becomes: string }
  'workflow.contradiction.combworkMergesNeedsGit': undefined
  'workflow.contradiction.committedNeedsFolder': undefined
  'workflow.contradiction.focusedNeedsRunner': undefined
  'workflow.contradiction.jjNeedsSlots': undefined
  'workflow.contradiction.jjYouIntegrate': undefined
  'workflow.contradiction.mergeNeedsSlots': undefined
  'workflow.contradiction.noneHasNoSlots': undefined
  'workflow.contradiction.okWithReview': undefined
  'workflow.contradiction.poolNeedsAgent': undefined
  'workflow.contradiction.quorumNeedsAgent': undefined
  'workflow.contradiction.selfReview': undefined
  'workflow.contradiction.subfolderTarget': undefined
  'workflow.contradiction.upToDateNeedsSlots': undefined
  'workflow.earlierWork.message': { read: string; n: number; lines: string | number }
  'workflow.earlierWork.title': { read: string; card: string | number; line: string | number }
  'workflow.forYou.decidedAfterMerge': { card: string | number }
  'workflow.forYou.focusedSkip': { card: string | number; tests: string | number }
  'workflow.forYou.lineAsk': { line: string | number; card: string | number; target: string | number; next: string | number }
  'workflow.forYou.lineRefused': { line: string | number; target: string | number; reason: string | number; next: string | number }
  'workflow.forYou.lineUnfinished': { line: string | number; to: string | number; target: string | number; next: string | number }
  'workflow.forYou.lineWork': { line: string | number; target: string | number; commits: string | number; next: string | number }
  'workflow.forYou.mergeChoice': { project: string | number; target: string | number }
  'workflow.forYou.newDecision': { card: string | number }
  'workflow.forYou.okBefore': { card: string | number }
  'workflow.forYou.passedReview': { card: string | number }
  'workflow.forYou.queueAdvance': { card: string | number; target: string | number; folder: string | number }
  'workflow.forYou.queueCatchUp': { card: string | number; target: string | number; folder: string | number }
  'workflow.forYou.queuePublish': { card: string | number; result: string | number; endpoint: string | number; target: string | number }
  'workflow.forYou.queueStuck': { card: string | number; target: string | number; folder: string | number; files: number; how: string; finish: string | number; project: string | number; undo: string | number }
  'workflow.forYou.review': { card: string | number }
  'workflow.forYou.roundLimit': { card: string | number; rounds: number }
  'workflow.forYou.slotDirty': { card: string | number; slot: string | number; line: string | number; target: string | number }
  'workflow.forYouKind': { kind: string }
  'workflow.form.addCheck': undefined
  'workflow.form.allOff': undefined
  'workflow.form.allOffSummary': undefined
  'workflow.form.appliesNow': undefined
  'workflow.form.appliesNowBranches': undefined
  'workflow.form.cantSave': undefined
  'workflow.form.carried': { agents: string | number }
  'workflow.form.changeLine': { option: string | number; from: string | number; to: string | number }
  'workflow.form.changedMeanwhile': undefined
  'workflow.form.changesHead': undefined
  'workflow.form.checkCommand': undefined
  'workflow.form.checkName': undefined
  'workflow.form.closePreview': undefined
  'workflow.form.confirmMessage': undefined
  'workflow.form.confirmTitle': undefined
  'workflow.form.copied': undefined
  'workflow.form.copy': undefined
  'workflow.form.defaultBranch': undefined
  'workflow.form.discard': undefined
  'workflow.form.fileLocksNote': undefined
  'workflow.form.focusedPick': undefined
  'workflow.form.focusedRun': undefined
  'workflow.form.folders': undefined
  'workflow.form.from.global': undefined
  'workflow.form.from.here': undefined
  'workflow.form.from.platform': undefined
  'workflow.form.from.preset': undefined
  'workflow.form.from.project': undefined
  'workflow.form.from.workspace': undefined
  'workflow.form.fromTemplateDraft': { template: string | number }
  'workflow.form.fromTemplateMax': { template: string | number; max: number }
  'workflow.form.heir': { project: string | number; options: string | number }
  'workflow.form.heirCards': { n: number }
  'workflow.form.heirElsewhere': { project: string | number; workspace: string | number; options: string | number }
  'workflow.form.heirLanes': { n: number }
  'workflow.form.heirs': { n: number }
  'workflow.form.hoursValue': { n: number }
  'workflow.form.identity': { name: string | number; email: string | number }
  'workflow.form.identityValue': { name: string | number; email: string | number }
  'workflow.form.inFlight': { n: number }
  'workflow.form.inherit': undefined
  'workflow.form.inheritTip': { value: string | number }
  'workflow.form.inheritor': { project: string | number }
  'workflow.form.invalid': undefined
  'workflow.form.keptCard': { card: string | number; title: string | number; target: string | number }
  'workflow.form.keptLane': { named: string; name: string | number; builder: string | number; target: string | number }
  'workflow.form.keptTargets': { n: number }
  'workflow.form.labels': undefined
  'workflow.form.labelsValue': { labels: string | number }
  'workflow.form.lane': { builder: string | number; name: string | number }
  'workflow.form.laneUnnamed': { builder: string | number }
  'workflow.form.lanes': { n: number }
  'workflow.form.levelConfirm': undefined
  'workflow.form.levelForGit': undefined
  'workflow.form.levelForJj': undefined
  'workflow.form.levelForNone': undefined
  'workflow.form.levelGit': undefined
  'workflow.form.levelJj': undefined
  'workflow.form.levelNone': undefined
  'workflow.form.levelPlatform': undefined
  'workflow.form.loadFailed': { error: string | number }
  'workflow.form.loopsReadNote': undefined
  'workflow.form.minutesValue': { n: number }
  'workflow.form.neverOff.fileLocks': undefined
  'workflow.form.neverOff.folderGit': undefined
  'workflow.form.neverOff.indexLock': undefined
  'workflow.form.neverOff.queue': undefined
  'workflow.form.neverOffHead': undefined
  'workflow.form.noChanges': undefined
  'workflow.form.noChecks': undefined
  'workflow.form.noHeirs': undefined
  'workflow.form.noIdentity': undefined
  'workflow.form.noPreset': undefined
  'workflow.form.noneValue': undefined
  'workflow.form.notEnforced': undefined
  'workflow.form.off': undefined
  'workflow.form.on': undefined
  'workflow.form.openAdvanced': undefined
  'workflow.form.otherTargets': undefined
  'workflow.form.overMax': { count: number; max: number }
  'workflow.form.paste': undefined
  'workflow.form.pasteApply': undefined
  'workflow.form.pasteBad': undefined
  'workflow.form.pasteMessage': undefined
  'workflow.form.pastePlatform': undefined
  'workflow.form.pasteTitle': undefined
  'workflow.form.preset': undefined
  'workflow.form.presetDesc': undefined
  'workflow.form.presetsLabel': undefined
  'workflow.form.previewChanges': { n: number }
  'workflow.form.previewHead': { preset: string | number }
  'workflow.form.previewNow': { value: string | number }
  'workflow.form.readOnly': { agents: string | number }
  'workflow.form.removeCheck': undefined
  'workflow.form.retargetCard': { card: string | number; title: string | number }
  'workflow.form.retargetChoice': { from: string | number; to: string | number; cards: number; slots: number }
  'workflow.form.retargetDone': { skipped: number; to: string | number; cards: number; slots: number }
  'workflow.form.retargetFailed': undefined
  'workflow.form.retargetKeep': { what: string | number; why: string; to: string | number; from: string | number }
  'workflow.form.retargetLane': { hasCard: string; lane: string | number; card: string | number; title: string | number }
  'workflow.form.retargetSkipped': { what: string | number; why: string }
  'workflow.form.retargetSlot': { slot: string | number }
  'workflow.form.retargetStarted': { card: string | number; title: string | number }
  'workflow.form.retargetStays': { from: string | number }
  'workflow.form.save': undefined
  'workflow.form.saveBlocked': undefined
  'workflow.form.saved': undefined
  'workflow.form.stageName': { stage: string | number }
  'workflow.form.stageNamesValue': { n: number }
  'workflow.form.startedFrom': { preset: string | number }
  'workflow.form.stepWaitNote': undefined
  'workflow.form.templateIdentityOff': undefined
  'workflow.form.templateNoCommand': { count: number; checks: string | number }
  'workflow.form.templateOtherPlatform': { template: string | number; platform: string | number; project: string | number }
  'workflow.form.use': { preset: string | number }
  'workflow.group.checks': undefined
  'workflow.group.loops': undefined
  'workflow.group.merging': undefined
  'workflow.group.review': undefined
  'workflow.group.stages': undefined
  'workflow.group.team': undefined
  'workflow.group.where': undefined
  'workflow.group.work': undefined
  'workflow.mergeChoice.answer': { styleTitle: string | number; style: string | number; messageTitle: string | number; message: string | number }
  'workflow.missing.create': undefined
  'workflow.missing.failed': { branch: string | number }
  'workflow.missing.from': { branch: string | number }
  'workflow.missing.line': { branch: string | number }
  'workflow.missing.save': { branches: string | number; n: number }
  'workflow.move.answer': undefined
  'workflow.move.declarePaths': undefined
  'workflow.move.loopStep': undefined
  'workflow.move.move': undefined
  'workflow.move.putBack': undefined
  'workflow.move.removeFromQueue': undefined
  'workflow.move.reportMerge': undefined
  'workflow.move.resolveOnBuilder': undefined
  'workflow.move.retryMerge': undefined
  'workflow.move.start': undefined
  'workflow.move.startReview': undefined
  'workflow.move.submit': undefined
  'workflow.move.verdict': undefined
  'workflow.nextVersion.button': undefined
  'workflow.nextVersion.done': { name: string | number; from: string | number; added: string }
  'workflow.nextVersion.doneMoved': { name: string | number; from: string | number; cards: number; slots: number; skipped: number }
  'workflow.nextVersion.enterName': undefined
  'workflow.nextVersion.message': { from: string | number }
  'workflow.nextVersion.name': undefined
  'workflow.nextVersion.noStart': { from: string | number }
  'workflow.nextVersion.planFailed': undefined
  'workflow.nextVersion.start': undefined
  'workflow.nextVersion.starting': undefined
  'workflow.nextVersion.stays': { from: string | number }
  'workflow.nextVersion.stepAdd': { from: string | number }
  'workflow.nextVersion.stepCreate': { name: string | number; from: string | number; commit: string | number }
  'workflow.nextVersion.stepListed': { from: string | number }
  'workflow.nextVersion.stepTarget': { from: string | number; name: string | number }
  'workflow.nextVersion.tip': { from: string | number }
  'workflow.nextVersion.title': undefined
  'workflow.nextVersion.upstream': { name: string | number; how: string; remote: string | number; publish: string | number; track1: string | number; track2: string | number }
  'workflow.option.commands.desc': undefined
  'workflow.option.commands.title': undefined
  'workflow.option.commitMessage.desc': undefined
  'workflow.option.commitMessage.title': undefined
  'workflow.option.dependenciesDone.desc': undefined
  'workflow.option.dependenciesDone.none': undefined
  'workflow.option.dependenciesDone.title': undefined
  'workflow.option.excluded.desc': undefined
  'workflow.option.excluded.title': undefined
  'workflow.option.fileLocks.desc': undefined
  'workflow.option.fileLocks.title': undefined
  'workflow.option.finish.desc': undefined
  'workflow.option.finish.title': undefined
  'workflow.option.focusedTests.desc': undefined
  'workflow.option.focusedTests.title': undefined
  'workflow.option.folder.desc': undefined
  'workflow.option.folder.title': undefined
  'workflow.option.followRemote.desc': undefined
  'workflow.option.followRemote.title': undefined
  'workflow.option.identity.desc': undefined
  'workflow.option.identity.title': undefined
  'workflow.option.loopRounds.desc': undefined
  'workflow.option.loopRounds.title': undefined
  'workflow.option.loopStepWaitMinutes.desc': undefined
  'workflow.option.loopStepWaitMinutes.title': undefined
  'workflow.option.loopWaitHours.desc': undefined
  'workflow.option.loopWaitHours.title': undefined
  'workflow.option.loopWakes.desc': undefined
  'workflow.option.loopWakes.title': undefined
  'workflow.option.maxAgents.desc': undefined
  'workflow.option.maxAgents.title': undefined
  'workflow.option.mergeChecks.desc': undefined
  'workflow.option.mergeChecks.jjDesc': undefined
  'workflow.option.mergeChecks.jjTitle': undefined
  'workflow.option.mergeChecks.title': undefined
  'workflow.option.mergeInstall.desc': undefined
  'workflow.option.mergeInstall.jjDesc': undefined
  'workflow.option.mergeInstall.jjTitle': undefined
  'workflow.option.mergeInstall.title': undefined
  'workflow.option.noSelfReview.desc': undefined
  'workflow.option.noSelfReview.title': undefined
  'workflow.option.okBefore.desc': undefined
  'workflow.option.okBefore.title': undefined
  'workflow.option.otherTargets.desc': undefined
  'workflow.option.otherTargets.title': undefined
  'workflow.option.preChecks.desc': undefined
  'workflow.option.preChecks.title': undefined
  'workflow.option.pushTarget.desc': undefined
  'workflow.option.pushTarget.title': undefined
  'workflow.option.review.desc': undefined
  'workflow.option.review.none': undefined
  'workflow.option.review.shared': undefined
  'workflow.option.review.title': undefined
  'workflow.option.reviewerMode.desc': undefined
  'workflow.option.reviewerMode.title': undefined
  'workflow.option.reviewers.desc': undefined
  'workflow.option.reviewers.title': undefined
  'workflow.option.sameness.desc': undefined
  'workflow.option.sameness.title': undefined
  'workflow.option.sharedFolderWarning.desc': undefined
  'workflow.option.sharedFolderWarning.title': undefined
  'workflow.option.slotsUpToDate.desc': undefined
  'workflow.option.slotsUpToDate.title': undefined
  'workflow.option.stageNames.desc': undefined
  'workflow.option.stageNames.title': undefined
  'workflow.option.stopOwnRuns.desc': undefined
  'workflow.option.stopOwnRuns.title': undefined
  'workflow.option.strict.desc': undefined
  'workflow.option.strict.jjDesc': undefined
  'workflow.option.strict.jjTitle': undefined
  'workflow.option.strict.title': undefined
  'workflow.option.style.desc': undefined
  'workflow.option.style.jjDesc': undefined
  'workflow.option.style.jjTitle': undefined
  'workflow.option.style.title': undefined
  'workflow.option.target.desc': undefined
  'workflow.option.target.title': undefined
  'workflow.preset.custom': undefined
  'workflow.preset.note.teamFocused': undefined
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
  'workflow.refused.card.plainNumber.next': { key: string | number }
  'workflow.refused.check.revisionMismatch.message': { why: string; revision: string | number; head: string | number }
  'workflow.refused.check.revisionMismatch.next': { revision: string | number }
  'workflow.refused.done.contained.change': undefined
  'workflow.refused.done.contained.message': { card: string | number; revision: string | number; target: string | number }
  'workflow.refused.done.contained.next': { revision: string | number; target: string | number }
  'workflow.refused.evidence.changed.message': { card: string | number }
  'workflow.refused.evidence.changed.next': undefined
  'workflow.refused.forward.notAgents.message': { card: string | number }
  'workflow.refused.forward.notAgents.next': undefined
  'workflow.refused.forward.resolutionSource.message': { card: string | number; from: string | number; to: string | number; revision: string | number; source: string | number }
  'workflow.refused.forward.resolutionSource.next': { source: string | number }
  'workflow.refused.forward.resolutionTarget.message': { card: string | number; from: string | number; to: string | number; target: string | number }
  'workflow.refused.forward.resolutionTarget.next': { to: string | number }
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
  'workflow.refused.lane.lineBehind.next': { reader: string; line: string | number; target: string | number; card: string | number }
  'workflow.refused.lane.oneAtATime.change': undefined
  'workflow.refused.lane.oneAtATime.message': { card: string | number; earlier: string | number }
  'workflow.refused.lane.oneAtATime.next': { earlier: string | number; card: string | number }
  'workflow.refused.loop.followUpChecked.message': { card: string | number }
  'workflow.refused.loop.followUpChecked.next': { reader: string }
  'workflow.refused.loop.followUpMerging.message': { card: string | number }
  'workflow.refused.loop.followUpMerging.next': undefined
  'workflow.refused.loop.noReviewer.message': { card: string | number }
  'workflow.refused.loop.noReviewer.next': undefined
  'workflow.refused.loop.noStep.message': { card: string | number }
  'workflow.refused.loop.noStep.next': undefined
  'workflow.refused.loop.roundLimit.message': { card: string | number }
  'workflow.refused.loop.roundLimit.next': undefined
  'workflow.refused.loop.staleStep.message': { card: string | number; design: string | number; waiting: string | number }
  'workflow.refused.loop.staleStep.next': undefined
  'workflow.refused.loop.stepNotHere.message': { step: string; card: string | number; stage: string | number }
  'workflow.refused.loop.stepNotHere.next': { step: string }
  'workflow.refused.loop.stepNotYours.message': { side: string; card: string | number }
  'workflow.refused.loop.stepNotYours.next': { side: string }
  'workflow.refused.loop.tooEarly.change': undefined
  'workflow.refused.loop.tooEarly.message': { card: string | number; minutes: number }
  'workflow.refused.loop.tooEarly.next': undefined
  'workflow.refused.merge.combworkMerges.change': undefined
  'workflow.refused.merge.combworkMerges.message': { card: string | number }
  'workflow.refused.merge.combworkMerges.next': undefined
  'workflow.refused.merge.combworkMerges.nextMerged': undefined
  'workflow.refused.merge.combworkMerges.nextPaused': { reader: string; target: string | number }
  'workflow.refused.merge.combworkMerges.nextPausedAnswer': { reader: string; target: string | number }
  'workflow.refused.merge.combworkMerges.nextPausedFix': { reader: string; target: string | number }
  'workflow.refused.merge.combworkMerges.nextPausedFolder': { reader: string; target: string | number }
  'workflow.refused.merge.combworkMerges.nextPausedRules': { reader: string; target: string | number }
  'workflow.refused.merge.combworkMerges.nextQueued': { target: string | number; n: number }
  'workflow.refused.merge.combworkMerges.nextReturned': undefined
  'workflow.refused.merge.combworkMerges.nextStale': { current: string | number }
  'workflow.refused.merge.combworkMerges.nextTesting': { target: string | number }
  'workflow.refused.merge.waitsForBlockers.message': { card: string | number; waitsFor: string | number }
  'workflow.refused.merge.waitsForBlockers.next': { waitsFor: string | number }
  'workflow.refused.move.doingNobody.message': { card: string | number; stage: string | number; also: string; rules: string | number }
  'workflow.refused.move.doingNobody.next': { reader: string }
  'workflow.refused.move.needsOverride.change': { reader: string }
  'workflow.refused.move.needsOverride.message': { card: string | number; stage: string | number; rules: string | number }
  'workflow.refused.move.needsOverride.next': { reader: string }
  'workflow.refused.move.noStage.change': undefined
  'workflow.refused.move.noStage.message': { card: string | number; stage: string | number }
  'workflow.refused.move.noStage.next': { stages: string | number }
  'workflow.refused.move.notFromHere.message': { card: string | number; stage: string | number; move: string | number }
  'workflow.refused.move.notFromHere.next': { stage: string | number; moves: string | number }
  'workflow.refused.move.notFromHere.nextBuilder': undefined
  'workflow.refused.move.notFromHere.nextBuilderSubmit': undefined
  'workflow.refused.move.notFromHere.nextDone': { reader: string }
  'workflow.refused.move.notFromHere.nextNone': undefined
  'workflow.refused.move.notFromHere.nextReviewer': { back: string }
  'workflow.refused.move.useIntent.message': undefined
  'workflow.refused.move.useIntent.next': { intent: string | number }
  'workflow.refused.paths.excluded.message': { card: string | number; path: string | number; folder: string | number }
  'workflow.refused.paths.excluded.next': { folder: string | number }
  'workflow.refused.platform.changed.message': { card: string | number; platform: string | number }
  'workflow.refused.platform.changed.next': { platform: string | number }
  'workflow.refused.platform.detachedFolder.message': { card: string | number; head: string | number }
  'workflow.refused.platform.detachedFolder.next': { has: string; branch: string | number }
  'workflow.refused.platform.jjRefused.message': { why: string; card: string | number; count: number; files: string | number; setting: string | number; base: string | number; commit: string | number; other: string | number; max: number }
  'workflow.refused.platform.jjRefused.next': { why: string }
  'workflow.refused.platform.keptAcross.message': { card: string | number; slot: string | number; platform: string | number; now: string | number }
  'workflow.refused.platform.keptAcross.next': { gone: string; card: string | number; platform: string | number }
  'workflow.refused.platform.keptElsewhere.message': { card: string | number; slot: string | number }
  'workflow.refused.platform.keptElsewhere.next': { slot: string | number; card: string | number }
  'workflow.refused.platform.keptLine.message': { card: string | number; kept: string | number; target: string | number }
  'workflow.refused.platform.keptLine.next': { kept: string | number; target: string | number }
  'workflow.refused.platform.noTarget.message': { card: string | number }
  'workflow.refused.platform.noTarget.next': undefined
  'workflow.refused.platform.noUpstream.message': { card: string | number; target: string | number }
  'workflow.refused.platform.noUpstream.next': { how: string; remote: string | number; target: string | number; publish: string | number; track1: string | number; track2: string | number }
  'workflow.refused.platform.offLine.message': { card: string | number; line: string | number; where: string; head: string | number; on: string | number }
  'workflow.refused.platform.offLine.next': { where: string; lineArg: string | number; made: string; start: string | number; onArg: string | number }
  'workflow.refused.platform.slotLeft.message': { unknown: string; card: string | number; slot: string | number; folder: string | number }
  'workflow.refused.platform.slotLeft.next': { unknown: string }
  'workflow.refused.platform.switching.message': { card: string | number }
  'workflow.refused.platform.switching.next': undefined
  'workflow.refused.platform.targetGone.message': { card: string | number; target: string | number }
  'workflow.refused.platform.targetGone.next': undefined
  'workflow.refused.platform.unknown.message': { card: string | number; what: string | number; rule: string | number }
  'workflow.refused.platform.unknown.next': undefined
  'workflow.refused.platform.unknown.nextGone': { reader: string }
  'workflow.refused.queue.advancing.message': { card: string | number; target: string | number }
  'workflow.refused.queue.advancing.next': { target: string | number }
  'workflow.refused.requeue.allowed.change': undefined
  'workflow.refused.requeue.allowed.message': { card: string | number; revision: string | number; why: string | number }
  'workflow.refused.requeue.allowed.next': undefined
  'workflow.refused.review.decisionsReceived.message': { card: string | number }
  'workflow.refused.review.decisionsReceived.next': undefined
  'workflow.refused.review.headMoved.message': { card: string | number; submitted: string | number; head: string | number }
  'workflow.refused.review.headMoved.next': { head: string | number }
  'workflow.refused.review.inProgress.change': undefined
  'workflow.refused.review.inProgress.message': { who: string; card: string | number; submission: string | number; reviewer: string | number; minutes: number }
  'workflow.refused.review.inProgress.next': { who: string; reviewer: string | number; card: string | number }
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
  'workflow.refused.start.platformReady.message': { card: string | number }
  'workflow.refused.start.platformReady.next': undefined
  'workflow.refused.start.releaseUnknown.message': { target: string | number; what: string | number; card: string | number }
  'workflow.refused.start.releaseUnknown.next': undefined
  'workflow.refused.start.released.message': { card: string | number; target: string | number; dated: string; tag: string | number; date: Date | number; into: string | number }
  'workflow.refused.start.released.next': { has: string; suggest: string | number; target: string | number }
  'workflow.refused.start.slotAvailable.change': undefined
  'workflow.refused.start.slotAvailable.message': { card: string | number }
  'workflow.refused.start.slotAvailable.next': undefined
  'workflow.refused.submit.checksPassed.change': undefined
  'workflow.refused.submit.checksPassed.message': { check: string | number; revision: string | number; why: string; files: string }
  'workflow.refused.submit.checksPassed.next': { why: string; command: string | number; copy: string }
  'workflow.refused.submit.clean.change': undefined
  'workflow.refused.submit.clean.message': { card: string | number; folder: string | number; files: string | number }
  'workflow.refused.submit.clean.next': undefined
  'workflow.refused.submit.decisionsReceived.message': { card: string | number }
  'workflow.refused.submit.decisionsReceived.next': undefined
  'workflow.refused.submit.empty.message': { card: string | number }
  'workflow.refused.submit.empty.messageForUser': undefined
  'workflow.refused.submit.empty.next': { changes: string }
  'workflow.refused.submit.empty.nextForUser': undefined
  'workflow.refused.submit.focusedChosen.change': undefined
  'workflow.refused.submit.focusedChosen.message': { card: string | number; revision: string | number; state: string; why: string }
  'workflow.refused.submit.focusedChosen.next': undefined
  'workflow.refused.submit.followUpNotBuilder.message': { card: string | number }
  'workflow.refused.submit.followUpNotBuilder.next': undefined
  'workflow.refused.submit.identity.change': undefined
  'workflow.refused.submit.identity.message': { missing: string; card: string | number; commit: string | number; email: string | number }
  'workflow.refused.submit.identity.next': { missing: string; command: string | number }
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
  'workflow.refused.submit.trailer.next': { at: string; command: string | number }
  'workflow.refused.submit.unchanged.message': { card: string | number }
  'workflow.refused.submit.unchanged.next': undefined
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
  'workflow.rule.card.kind': undefined
  'workflow.rule.done.contained': undefined
  'workflow.rule.forward.resolutionSource': undefined
  'workflow.rule.integrate.approved': undefined
  'workflow.rule.integrate.checksPassed': undefined
  'workflow.rule.integrate.upToDate': undefined
  'workflow.rule.move.doingNobody': undefined
  'workflow.rule.requeue.allowed': undefined
  'workflow.rule.review.decisionsReceived': undefined
  'workflow.rule.review.inProgress': undefined
  'workflow.rule.review.notAuthor': undefined
  'workflow.rule.start.dependenciesIntegrated': undefined
  'workflow.rule.start.notBlocked': undefined
  'workflow.rule.start.platformReady': undefined
  'workflow.rule.start.released': undefined
  'workflow.rule.start.slotAvailable': undefined
  'workflow.rule.submit.checksPassed': undefined
  'workflow.rule.submit.clean': undefined
  'workflow.rule.submit.decisionsReceived': undefined
  'workflow.rule.submit.focusedChosen': undefined
  'workflow.rule.submit.identity': undefined
  'workflow.rule.submit.notDuplicate': undefined
  'workflow.rule.submit.ownRunsStopped': undefined
  'workflow.rule.submit.ready': undefined
  'workflow.rule.submit.trailer': undefined
  'workflow.rule.verdict.currentSubmission': undefined
  'workflow.rule.verdict.reviewing': undefined
  'workflow.slots.archive': undefined
  'workflow.slots.archiveDesc': undefined
  'workflow.slots.branches': undefined
  'workflow.slots.carried': { agent: string | number }
  'workflow.slots.copiesDefault': { n: number }
  'workflow.slots.copiesNow': { n: number; leased: number }
  'workflow.slots.copiesSize': undefined
  'workflow.slots.copiesSizeDesc': undefined
  'workflow.slots.copy': undefined
  'workflow.slots.copyDesc': undefined
  'workflow.slots.desc': undefined
  'workflow.slots.fromSetup': undefined
  'workflow.slots.gitFiles': undefined
  'workflow.slots.gitFilesDesc': undefined
  'workflow.slots.gitFilesLfs': { version: string | number }
  'workflow.slots.gitFilesNoFilter': undefined
  'workflow.slots.gitFilesNoLfs': undefined
  'workflow.slots.gitFilesSubmodules': { n: number }
  'workflow.slots.heading': undefined
  'workflow.slots.held': { agent: string | number }
  'workflow.slots.inUse': undefined
  'workflow.slots.inherit': undefined
  'workflow.slots.keptFor': { card: string | number }
  'workflow.slots.keptForgottenFor': { card: string | number }
  'workflow.slots.keptGoneFor': { card: string | number }
  'workflow.slots.lentCard': { agent: string | number; card: string | number }
  'workflow.slots.lentLane': { agent: string | number }
  'workflow.slots.levelInherit': undefined
  'workflow.slots.levelNone': undefined
  'workflow.slots.noSlots': undefined
  'workflow.slots.none': undefined
  'workflow.slots.notRecovered': { slot: string | number; why: string }
  'workflow.slots.notRemovedKept': { slot: string | number; why: string }
  'workflow.slots.off': undefined
  'workflow.slots.on': undefined
  'workflow.slots.openAdvanced': undefined
  'workflow.slots.recover': undefined
  'workflow.slots.recoverMessage': undefined
  'workflow.slots.recoverTitle': { slot: string | number }
  'workflow.slots.recovered': { slot: string | number }
  'workflow.slots.recoveredAsides': { n: number; files: string | number }
  'workflow.slots.recoveredCopies': { n: number }
  'workflow.slots.recoveredDivergent': { commit: string | number }
  'workflow.slots.recoveredKeptDeleted': { n: number; files: string | number }
  'workflow.slots.recoveredPutBack': { n: number }
  'workflow.slots.recoveredTitle': { slot: string | number }
  'workflow.slots.release': undefined
  'workflow.slots.removeForgottenFree': { slot: string | number }
  'workflow.slots.removeForgottenMessage': { card: string | number; commit: string }
  'workflow.slots.removeKept': undefined
  'workflow.slots.removeKeptMessage': { card: string | number; commit: string }
  'workflow.slots.removeKeptTitle': { slot: string | number }
  'workflow.slots.removedKept': { slot: string | number }
  'workflow.slots.reviewCopies': undefined
  'workflow.slots.reviewCopiesDesc': undefined
  'workflow.slots.saveFailed': undefined
  'workflow.slots.setHere': undefined
  'workflow.slots.setNone': undefined
  'workflow.slots.setup': undefined
  'workflow.slots.setupDesc': undefined
  'workflow.slots.stale': undefined
  'workflow.slots.state.creating': undefined
  'workflow.slots.state.dirty': undefined
  'workflow.slots.state.forgotten': undefined
  'workflow.slots.state.gone': undefined
  'workflow.slots.state.kept': undefined
  'workflow.slots.state.lent': undefined
  'workflow.slots.state.ready': undefined
  'workflow.slots.state.removing': undefined
  'workflow.slots.useNone': undefined
  'workflow.stage.active': undefined
  'workflow.stage.approved': undefined
  'workflow.stage.done': undefined
  'workflow.stage.hold': undefined
  'workflow.stage.merging': undefined
  'workflow.stage.review': undefined
  'workflow.stage.todo': undefined
  'workflow.stageName.control': { stage: string | number }
  'workflow.stageName.duplicate': { stage: string | number }
  'workflow.stageName.empty': { stage: string | number }
  'workflow.stageName.long': { stage: string | number; max: number }
  'workflow.summary.git.pair': undefined
  'workflow.summary.git.pairAgent': undefined
  'workflow.summary.git.solo': undefined
  'workflow.summary.git.team': undefined
  'workflow.summary.jj.pair': undefined
  'workflow.summary.jj.solo': undefined
  'workflow.summary.jj.team': undefined
  'workflow.summary.none.pair': undefined
  'workflow.summary.none.solo': undefined
  'workflow.summary.none.team': undefined
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
  'workflow.unreadable.remoteBehind': { target: string | number; endpoint: string | number }
  'workflow.unreadable.remoteHead': { branch: string | number; endpoint: string | number; target: string | number }
  'workflow.unreadable.remoteSetup': { target: string | number }
  'workflow.unreadable.replay': { revision: string | number; onto: string | number }
  'workflow.unreadable.replayedFiles': undefined
  'workflow.unreadable.reviewers': { card: string | number }
  'workflow.unreadable.revision': { revision: string | number }
  'workflow.unreadable.revisionIn': { folder: string | number }
  'workflow.unreadable.state': { folder: string | number }
  'workflow.unreadable.target': { target: string | number }
  'workflow.unreadable.tracking': { branch: string | number }
  'workflow.unreadable.uncommitted': { folder: string | number }
  'workflow.unreadable.worktrees': { folder: string | number }
  'workflow.unreadable.writes': { folder: string | number }
  'workflow.value.commitMessage.branch': undefined
  'workflow.value.commitMessage.cw': undefined
  'workflow.value.finish.agentMerges': undefined
  'workflow.value.finish.combworkMerges': undefined
  'workflow.value.finish.committed': undefined
  'workflow.value.finish.notChecked': undefined
  'workflow.value.finish.userIntegrates': undefined
  'workflow.value.folder.project': undefined
  'workflow.value.folder.slots': undefined
  'workflow.value.mergeInstall.always': undefined
  'workflow.value.mergeInstall.alwaysCandidate': undefined
  'workflow.value.mergeInstall.onManifestChange': undefined
  'workflow.value.okBefore.every': undefined
  'workflow.value.okBefore.labels': undefined
  'workflow.value.okBefore.never': undefined
  'workflow.value.review.agent': undefined
  'workflow.value.review.agentThenYou': undefined
  'workflow.value.review.none': undefined
  'workflow.value.review.noneNone': undefined
  'workflow.value.review.you': undefined
  'workflow.value.reviewerMode.lane': undefined
  'workflow.value.reviewerMode.pool': undefined
  'workflow.value.sameness.change': undefined
  'workflow.value.sameness.exact': undefined
  'workflow.value.style.merge': undefined
  'workflow.value.style.rebase': undefined
  'workflow.value.style.squash': undefined
  'workflow.why.commitMessage': undefined
  'workflow.why.dependenciesDone': undefined
  'workflow.why.excluded': undefined
  'workflow.why.finish': undefined
  'workflow.why.focusedTests': undefined
  'workflow.why.folder': undefined
  'workflow.why.followRemote': undefined
  'workflow.why.identity': undefined
  'workflow.why.maxAgents': undefined
  'workflow.why.mergeChecks': undefined
  'workflow.why.mergeInstall': undefined
  'workflow.why.noSelfReview': undefined
  'workflow.why.okBefore': undefined
  'workflow.why.preChecks': undefined
  'workflow.why.pushTarget': undefined
  'workflow.why.review': undefined
  'workflow.why.reviewerMode': undefined
  'workflow.why.reviewers': undefined
  'workflow.why.sameness': undefined
  'workflow.why.sharedFolderWarning': undefined
  'workflow.why.slotsUpToDate': undefined
  'workflow.why.stopOwnRuns': undefined
  'workflow.why.strict': undefined
  'workflow.why.style': undefined
  'workflow.why.target': undefined
}
