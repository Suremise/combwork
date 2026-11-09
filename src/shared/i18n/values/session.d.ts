// Generated from locales/en/session.json: do not edit. Each message's placeholders and their types, for tr(): a
// global script, so its interface merges with every other area's (shared/i18n/msg.ts).
interface CombworkMessageValues {
  'session.archive.notKept': undefined
  'session.autoCompact.body': { provider: string | number }
  'session.autoCompact.title': { agent: string | number }
  'session.background.body': { provider: string | number; job: string | number }
  'session.background.cantStop': { provider: string | number }
  'session.background.stopAndResume': undefined
  'session.background.title': { agent: string | number }
  'session.bulk.notAnId': undefined
  'session.carryOn.already': undefined
  'session.cleanUp.already': undefined
  'session.cleanUp.changed': undefined
  'session.cleanUp.cliBack': undefined
  'session.cleanUp.cliGone': undefined
  'session.cleanUp.unarchived': undefined
  'session.cleanUp.unread': undefined
  'session.cleanUp.unreadBackups': undefined
  'session.compact.already': undefined
  'session.compact.busy': undefined
  'session.compact.stopped': undefined
  'session.compact.userTyped': undefined
  'session.compact.waiting': undefined
  'session.connection.fallback': { why: string; wanted: string | number; name: string | number }
  'session.connection.fallbackTitle': { agent: string | number }
  'session.error.agentGone': undefined
  'session.error.inUseElsewhere': undefined
  'session.error.noAgents': undefined
  'session.error.noDeliveries': undefined
  'session.error.noSession': undefined
  'session.error.running': undefined
  'session.error.severalAgents': undefined
  'session.error.stopFirst': { action: string }
  'session.error.stoppedBeforePrompt': undefined
  'session.error.stoppedBeforeStart': undefined
  'session.error.typingBusy': undefined
  'session.format.body': { provider: string | number }
  'session.format.bodyVersion': { provider: string | number; version: string | number }
  'session.format.title': { provider: string | number }
  'session.handOver.apiFailed': { agent: string | number }
  'session.handOver.asking': { agent: string | number }
  'session.handOver.busy': { agent: string | number }
  'session.handOver.didntStop': { agent: string | number; handover: string | number }
  'session.handOver.momentLost': { agent: string | number; handover: string | number }
  'session.handOver.noTools': undefined
  'session.handOver.none': { project: string | number }
  'session.handOver.noneWritten': { agent: string | number }
  'session.handOver.notNow': { agent: string | number }
  'session.handOver.notRunning': { agent: string | number }
  'session.handOver.other': { agent: string | number }
  'session.handOver.self': undefined
  'session.handOver.slow': { agent: string | number }
  'session.handOver.stopped': { agent: string | number }
  'session.handOver.writing': { agent: string | number }
  'session.inUse.attaching': undefined
  'session.inUse.open': undefined
  'session.inUse.reading': undefined
  'session.inUse.reserved': undefined
  'session.inUse.running': undefined
  'session.inUse.writing': undefined
  'session.keyRefused.body': { name: string | number }
  'session.keyRefused.title': { n: number; agent: string | number; name: string | number }
  'session.leftovers.body': { processes: string | number; n: number }
  'session.leftovers.end': undefined
  'session.leftovers.keep': undefined
  'session.leftovers.more': { n: number }
  'session.leftovers.notEnded': { n: number }
  'session.leftovers.notEndedBody': { processes: string | number; n: number }
  'session.leftovers.times': { n: number; label: string | number }
  'session.leftovers.title': { agent: string | number; processes: string | number }
  'session.lock.allow': undefined
  'session.lock.anotherAgent': undefined
  'session.lock.body': { holder: string | number; agent: string | number }
  'session.lock.theAgent': undefined
  'session.lock.title': { agent: string | number; file: string | number }
  'session.long.handOver': undefined
  'session.long.notNow': { agent: string | number }
  'session.long.notNowText': undefined
  'session.long.noticeText': { size: string | number; limit: number; when: string }
  'session.mergeSlot.holding': { branch: string | number }
  'session.mergeSlot.waiting': undefined
  'session.mergeSlot.waitingForYou': undefined
  'session.mergeSlot.waitingMerging': { agent: string | number }
  'session.mergeSlot.waitingMergingCards': { agent: string | number; cards: string | number }
  'session.mergeSlot.waitingNext': { agent: string | number }
  'session.mergeSlot.waitingNextCards': { agent: string | number; cards: string | number }
  'session.mode.asking': undefined
  'session.mode.assistantCliOwn': undefined
  'session.mode.ended': { mode: string | number }
  'session.mode.endedUnconfirmed': { provider: string | number; mode: string | number }
  'session.mode.notFound': { what: string | number; mode: string | number }
  'session.mode.notOffered': { provider: string | number; mode: string | number }
  'session.mode.notOfferedIn': { provider: string | number; mode: string | number; now: string | number }
  'session.mode.off': { mode: string | number; provider: string | number }
  'session.mode.restart': { mode: string | number }
  'session.mode.starting': undefined
  'session.mode.stopped': { mode: string | number; why: string | number }
  'session.mode.typing': undefined
  'session.mode.unconfirmed': { provider: string | number; mode: string | number }
  'session.mode.why.asking': { provider: string | number }
  'session.mode.why.busy': { seconds: number; provider: string | number }
  'session.mode.why.ended': undefined
  'session.mode.working': { provider: string | number }
  'session.modeOffer.many': { n: number; agents: string | number }
  'session.modeOffer.one': { agent: string | number }
  'session.modeOffer.switch': undefined
  'session.modeOffer.title': { modes: string | number }
  'session.model.switched': { cli: string | number; running: string | number; launched: string | number }
  'session.model.switchedTitle': { agent: string | number }
  'session.movedFresh.body': { n: number }
  'session.newConversation.didntStop': undefined
  'session.newConversation.notRunning': undefined
  'session.newConversation.pending': undefined
  'session.notice.finished': { agent: string | number }
  'session.notice.finishedBody': undefined
  'session.notice.hooksDoubledTitle': { agent: string | number }
  'session.notice.hooksMissingTitle': { agent: string | number }
  'session.notice.lineLost': { text: string | number }
  'session.notice.lineLostTitle': { agent: string | number }
  'session.notice.longConversation': { agent: string | number }
  'session.notice.needsInput': { agent: string | number }
  'session.notice.notWatching': { agent: string | number; cards: string | number }
  'session.notice.notWatchingBody': { n: number }
  'session.notice.question': { agent: string | number }
  'session.notice.questionBody': undefined
  'session.notice.safeguardSwitch': { agent: string | number; model: string | number }
  'session.notice.tasksEnded': undefined
  'session.notice.untaken': undefined
  'session.notice.untakenRetried': undefined
  'session.notice.untakenTitle': { agent: string | number }
  'session.notice.waitingForInput': undefined
  'session.orphan.body': { pid: string | number }
  'session.orphan.title': { agent: string | number; command: string | number; time: string | number }
  'session.plan.asking': undefined
  'session.plan.noToggle': { provider: string | number }
  'session.plan.typing': undefined
  'session.prompt.cliAsks': undefined
  'session.prompt.inputBlocked': undefined
  'session.prompt.inputNotCleared': undefined
  'session.prompt.untaken': undefined
  'session.purge.changed': undefined
  'session.purge.cliBack': undefined
  'session.purge.cliGone': undefined
  'session.purge.gone': undefined
  'session.purge.open': undefined
  'session.purge.reading': undefined
  'session.purge.running': undefined
  'session.purge.unread': undefined
  'session.renamedFresh.body': { n: number }
  'session.renamedFresh.title': undefined
  'session.restartMode.didntStop': { agent: string | number }
  'session.setup.failed': { code: string | number }
  'session.setup.failedTitle': { project: string | number; agent: string | number }
  'session.signIn.again': { provider: string | number }
  'session.signIn.againMany': { n: number }
  'session.signIn.againOne': { agent: string | number }
  'session.signIn.expired': { provider: string | number; help: string | number }
  'session.signIn.many': { n: number; provider: string | number }
  'session.signIn.notSignedIn': { provider: string | number }
  'session.signIn.one': { agent: string | number; provider: string | number }
  'session.start.agentRunning': { agent: string | number }
  'session.start.alreadyRunning': undefined
  'session.start.anotherAgent': undefined
  'session.start.archived': undefined
  'session.start.args': { problem: string | number; connection: string | number }
  'session.start.beingOpened': undefined
  'session.start.cleaning': undefined
  'session.start.cliRequired': { provider: string | number }
  'session.start.closing': undefined
  'session.start.couldNot': { agent: string | number }
  'session.start.fenced': { why: string | number }
  'session.start.independentTask': { agent: string | number }
  'session.start.moveFailed': { project: string | number; error: string | number }
  'session.start.openCommands': undefined
  'session.start.openIn': { agent: string | number }
  'session.start.otherFolder': { folder: string | number }
  'session.start.plainTask': { agent: string | number }
  'session.start.projectRunning': undefined
  'session.start.providerMissing': { resuming: string; provider: string | number; agent: string | number }
  'session.start.providerOff': { provider: string | number; resuming: string; agent: string | number }
  'session.start.removing': undefined
  'session.start.repairing': undefined
  'session.start.slotBusy': { slot: string | number; agent: string | number }
  'session.start.slotChanged': { slot: string | number; agent: string | number }
  'session.start.slotSetup': { slot: string | number; agent: string | number }
  'session.start.subSession': { kind: string | number; provider: string | number }
  'session.start.tempInside': { folder: string | number; inside: string | number }
  'session.start.tempNotMade': { folder: string | number; why: string | number }
  'session.start.tempUnset': { folder: string | number }
  'session.start.turnedOff': { provider: string | number; agent: string | number }
  'session.start.worktreeMissing': { agent: string | number; folder: string | number }
  'session.state.countIdle': { n: number }
  'session.state.countStalled': { n: number }
  'session.state.countStopped': { n: number }
  'session.state.countWaiting': { n: number }
  'session.state.countWorking': { n: number }
  'session.state.idle': undefined
  'session.state.stalled': undefined
  'session.state.waiting': undefined
  'session.state.working': undefined
  'session.status.asksAtStart': undefined
  'session.status.asksTrust': undefined
  'session.status.cliAsks': { provider: string | number; question: string | number }
  'session.status.compacting': undefined
  'session.status.connectionKeepsDropping': undefined
  'session.status.connectionNotBack': undefined
  'session.status.failedTurn': undefined
  'session.status.inputBlocked': undefined
  'session.status.safeguardAsks': { provider: string | number }
  'session.status.safeguardAsksTools': { provider: string | number; tools: string | number }
  'session.status.safeguardIdle': undefined
  'session.status.settingUp': { command: string | number }
  'session.status.signedInAgain': undefined
  'session.status.tasksDropped': { minutes: number }
  'session.status.waitingForConnection': undefined
  'session.switch.waits': { why: string | number }
  'session.switch.waitsTitle': { agent: string | number; slot: string | number }
  'session.tracker.body': { reason: string | number; detail: string | number }
  'session.tracker.detail': undefined
  'session.tracker.helperFailed': { why: string | number }
  'session.tracker.lost': { launches: number }
  'session.tracker.lostListed': { listed: number; launches: number }
  'session.tracker.noAnswer': undefined
  'session.tracker.noPowerShell': { error: string | number }
  'session.tracker.noStart': undefined
  'session.tracker.refused': undefined
  'session.tracker.slowHelper': { seconds: number }
  'session.tracker.stopped': { why: string | number }
  'session.tracker.title': undefined
  'session.tracker.unavailable': undefined
  'session.tracker.windowsOnly': undefined
}
