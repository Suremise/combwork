// Generated from locales/en/actions.json: do not edit. Each message's placeholders and their types, for tr(): a
// global script, so its interface merges with every other area's (shared/i18n/msg.ts).
interface CombworkMessageValues {
  'actions.agent.addFailed': undefined
  'actions.agent.manyMessage': undefined
  'actions.agent.manyTitle': { n: string | number }
  'actions.agent.moveFailed': undefined
  'actions.agent.noRoom': undefined
  'actions.agent.noRoomMessage': { why: string | number }
  'actions.ago.days': { n: number }
  'actions.ago.hours': { n: number }
  'actions.ago.justNow': undefined
  'actions.ago.minutes': { n: number }
  'actions.ago.yesterday': undefined
  'actions.archive.confirm': undefined
  'actions.archive.detail': undefined
  'actions.archive.failed': undefined
  'actions.archive.message': { session: string | number }
  'actions.archive.nothing': undefined
  'actions.archive.title': undefined
  'actions.attach.attach': undefined
  'actions.attach.attachAll': undefined
  'actions.attach.failed': undefined
  'actions.attach.largeDetail': { copy: string }
  'actions.attach.largeMany': { size: string | number }
  'actions.attach.largeOne': { file: string | number; size: string | number }
  'actions.attach.largeTitle': { n: number }
  'actions.batch.providerMissing': { cli: string | number }
  'actions.batch.providerOff': { cli: string | number }
  'actions.cards.andMore': { cards: string | number; n: string | number }
  'actions.cards.detail': { cards: number; agent: string }
  'actions.cards.leave': { cards: number }
  'actions.cards.release': { cards: number }
  'actions.cards.title': { agents: number; agent: string | number; cards: number }
  'actions.chooseConnections.busy': undefined
  'actions.chooseConnections.confirm': undefined
  'actions.chooseConnections.failed': undefined
  'actions.chooseConnections.later': undefined
  'actions.chooseConnections.message': undefined
  'actions.chooseConnections.restartMessage': { agents: string | number; count: number }
  'actions.chooseConnections.restartTitle': undefined
  'actions.chooseConnections.skipped': { count: number }
  'actions.chooseConnections.skippedWhy': { agent: string | number; why: string }
  'actions.chooseConnections.switch': undefined
  'actions.chooseConnections.title': { project: string | number }
  'actions.delete.busy': undefined
  'actions.delete.confirm': undefined
  'actions.delete.message': { folder: string; name: string | number }
  'actions.delete.title': undefined
  'actions.discard.confirm': undefined
  'actions.discard.detail': undefined
  'actions.discard.failed': undefined
  'actions.discard.message': { path: string | number; branch: string | number; agent: string | number }
  'actions.discard.title': { agent: string | number }
  'actions.drafts.changedOnDisk': undefined
  'actions.duration.hoursMinutes': { h: number; m: string | number }
  'actions.duration.minutes': { m: string | number }
  'actions.duration.seconds': { s: string | number }
  'actions.keys.ctrl': undefined
  'actions.keys.delete': undefined
  'actions.keys.shift': undefined
  'actions.layout.failed': undefined
  'actions.mcp.add': undefined
  'actions.mcp.addFailed': undefined
  'actions.mcp.addTitle': undefined
  'actions.mcp.badName': undefined
  'actions.mcp.copied': { names: string | number }
  'actions.mcp.copyFailed': undefined
  'actions.mcp.deleteAdded': { where: string | number }
  'actions.mcp.deleteMessage': { name: string | number }
  'actions.mcp.deleteTitle': undefined
  'actions.mcp.listFailed': undefined
  'actions.mcp.listFailedPicker': undefined
  'actions.mcp.namePlaceholder': undefined
  'actions.mcp.openFailed': undefined
  'actions.mcp.rename': undefined
  'actions.mcp.replace': undefined
  'actions.mcp.replaceMessage': { name: string | number }
  'actions.mcp.replaceTitle': { name: string | number }
  'actions.mcp.updateFailedAdded': undefined
  'actions.pane.edge': { agent: string | number; dir: string }
  'actions.pane.moved': { agent: string | number; pages: string; page: string | number; row: string | number; column: string | number; other: string }
  'actions.project.activateFailed': undefined
  'actions.project.create': undefined
  'actions.project.createFailed': undefined
  'actions.project.created': { name: string | number }
  'actions.project.deactivateDetail': { n: number }
  'actions.project.deactivateFailed': undefined
  'actions.project.deactivateMessage': { n: number; project: string | number }
  'actions.project.deactivateTitle': { n: number }
  'actions.project.key': undefined
  'actions.project.keyHint': { first: string | number; second: string | number }
  'actions.project.nameChars': { chars: string | number }
  'actions.project.nameDot': undefined
  'actions.project.nameEmpty': undefined
  'actions.project.namePlaceholder': undefined
  'actions.project.newMessage': undefined
  'actions.project.newTitle': undefined
  'actions.project.noWorkspace': undefined
  'actions.project.stopAndDeactivate': undefined
  'actions.provider.lookingMessage': undefined
  'actions.provider.lookingTitle': undefined
  'actions.provider.offAgent': undefined
  'actions.provider.offTitle': { cli: string | number }
  'actions.provider.openSettings': undefined
  'actions.providers.agentSetup': undefined
  'actions.providers.checkFailed': undefined
  'actions.providers.noneOn': undefined
  'actions.providers.noneOnMessage': undefined
  'actions.providers.notInstalled': { cli: string | number }
  'actions.providers.notInstalledMessage': undefined
  'actions.providers.upToDate': { cli: string | number }
  'actions.providers.update': undefined
  'actions.providers.updateTitle': { cli: string | number; version: string | number }
  'actions.providers.version': { version: string | number }
  'actions.providers.youHave': { version: string | number }
  'actions.recache.archiveFailed': { what: string }
  'actions.recache.detail': { what: string }
  'actions.recache.fresh': undefined
  'actions.recache.message': { what: string; tokens: string | number }
  'actions.recache.resume': undefined
  'actions.recache.title': { what: string }
  'actions.recent.clear': undefined
  'actions.recent.clearFailed': undefined
  'actions.recent.clearMessage': undefined
  'actions.recent.clearTitle': undefined
  'actions.recent.elsewhere': undefined
  'actions.recent.elsewhereTip': undefined
  'actions.recent.keep': undefined
  'actions.recent.notFound': undefined
  'actions.recent.notFoundMessage': { path: string | number }
  'actions.recent.notFoundTip': undefined
  'actions.recent.notFoundTitle': undefined
  'actions.recent.removeFailed': undefined
  'actions.recent.removeFromRecent': undefined
  'actions.releaseHeld.confirm': undefined
  'actions.releaseHeld.detailIdleBroker': undefined
  'actions.releaseHeld.detailListed': { n: number }
  'actions.releaseHeld.detailUnknown': undefined
  'actions.releaseHeld.endFirst': undefined
  'actions.releaseHeld.messageGone': { slot: string | number; agent: string | number; run: string | number; pid: string | number }
  'actions.releaseHeld.messageIdleBroker': { slot: string | number; names: string | number; agent: string | number; run: string | number }
  'actions.releaseHeld.messageSelf': { agent: string | number; slot: string | number; run: string | number; pid: string | number }
  'actions.releaseHeld.process': { label: string | number; pid: string | number }
  'actions.releaseHeld.readFailed': undefined
  'actions.releaseHeld.title': { agent: string | number; slot: string | number }
  'actions.releaseSlot.confirm': undefined
  'actions.releaseSlot.detail': { agent: string | number }
  'actions.releaseSlot.failed': undefined
  'actions.releaseSlot.message': { slot: string | number; agent: string | number }
  'actions.releaseSlot.title': { agent: string | number; slot: string | number }
  'actions.remove.confirm': undefined
  'actions.remove.deleteConfirm': undefined
  'actions.remove.deleteDetail': { branch: string | number }
  'actions.remove.deleteMessage': { path: string | number; branch: string | number }
  'actions.remove.deleteThem': undefined
  'actions.remove.deleteTitle': undefined
  'actions.remove.failed': undefined
  'actions.remove.keepWorktree': undefined
  'actions.remove.keptMessage': { branch: string | number; path: string | number }
  'actions.remove.keptTitle': { agent: string | number }
  'actions.remove.message': { agent: string | number; project: string | number }
  'actions.remove.reviewUnused': undefined
  'actions.remove.title': { agent: string | number }
  'actions.remove.worktreeDetail': undefined
  'actions.remove.worktreeMessage': { agent: string | number; branch: string | number }
  'actions.removeAll.branchKept': { branch: string | number; why: string | number }
  'actions.removeAll.checkFailed': undefined
  'actions.removeAll.confirm': { n: number }
  'actions.removeAll.deleteMerged': { into: string | number; branches: string | number }
  'actions.removeAll.deleted': { branches: string | number }
  'actions.removeAll.failed': { all: string; tried: number; failed: string | number }
  'actions.removeAll.kept': { branches: string | number }
  'actions.removeAll.keptMessage': undefined
  'actions.removeAll.keptTitle': { n: number }
  'actions.removeAll.message': { n: number; agent: string | number; project: string | number }
  'actions.removeAll.notChecked': { branch: string | number }
  'actions.removeAll.note': { running: string; trees: string }
  'actions.removeAll.removed': { n: number; agent: string | number }
  'actions.removeAll.removedList': { agents: string | number }
  'actions.removeAll.title': { n: number; agent: string | number }
  'actions.removeAll.worktreeKept': { branch: string | number; why: string | number }
  'actions.resets.hours': { h: string | number; min: string | number }
  'actions.resets.minutes': { min: string | number }
  'actions.resets.now': undefined
  'actions.resume.alreadyOpen': undefined
  'actions.resume.alreadyOpenMessage': { agent: string | number }
  'actions.resume.cantFolder': { cli: string }
  'actions.resume.cantTitle': undefined
  'actions.resume.cantWorktree': { folder: string | number }
  'actions.resume.heldTitle': undefined
  'actions.resume.noneMessage': { agent: string }
  'actions.resume.noneTitle': undefined
  'actions.resume.readTranscript': undefined
  'actions.resume.startFresh': undefined
  'actions.resumeAll.coldLine': { agent: string | number; tokens: string | number }
  'actions.resumeAll.confirm': { n: number }
  'actions.resumeAll.failed': { all: string; tried: number; failed: string | number }
  'actions.resumeAll.heldLine': { agent: string | number; why: string | number }
  'actions.resumeAll.heldTitle': { n: number }
  'actions.resumeAll.message': { who: string; cold: number }
  'actions.resumeAll.nothing': undefined
  'actions.resumeAll.nothingMessage': undefined
  'actions.resumeAll.resumed': { agents: string | number }
  'actions.resumeAll.show': { agent: string | number }
  'actions.resumeAll.title': { n: number }
  'actions.session.listFailed': undefined
  'actions.session.resumeFailed': undefined
  'actions.session.startFailed': undefined
  'actions.sessionView.failed': undefined
  'actions.slot.goneDetail': undefined
  'actions.slot.goneMessage': { agent: string | number; slot: string | number; path: string | number; branch: string | number }
  'actions.slot.goneNoBranch': { agent: string | number; slot: string | number; path: string | number }
  'actions.slot.goneTitle': undefined
  'actions.slot.recreate': undefined
  'actions.slot.recreateFailed': undefined
  'actions.slot.release': undefined
  'actions.slot.releaseFailed': undefined
  'actions.startAll.archiveMessage': { n: number; agent: string | number; project: string | number }
  'actions.startAll.failed': { all: string; tried: number; failed: string | number }
  'actions.startAll.noAgents': undefined
  'actions.startAll.noAgentsMessage': undefined
  'actions.startAll.note': { running: string; archive: string }
  'actions.startAll.nothingToArchive': undefined
  'actions.startAll.start': undefined
  'actions.startAll.startMessage': { n: number; project: string | number }
  'actions.startAll.started': { agents: string | number }
  'actions.startAll.title': { kind: string; n: number }
  'actions.startFresh.confirm': undefined
  'actions.startFresh.line': { agent: string | number; why: string | number }
  'actions.startFresh.message': { project: string | number }
  'actions.startFresh.noneTitle': undefined
  'actions.startFresh.reportTitle': { n: number }
  'actions.startFresh.title': { n: number }
  'actions.startFresh.why.background': undefined
  'actions.startFresh.why.fresh': undefined
  'actions.startFresh.why.lease': { card: string }
  'actions.startFresh.why.pending': undefined
  'actions.startFresh.why.stopped': undefined
  'actions.startFresh.why.waiting': undefined
  'actions.startFresh.why.watching': undefined
  'actions.startFresh.why.working': undefined
  'actions.stop.confirm': undefined
  'actions.stop.detail': undefined
  'actions.stop.failed': undefined
  'actions.stop.message': { named: string; agent: string | number; project: string | number }
  'actions.stop.title': undefined
  'actions.stopAll.busy': undefined
  'actions.stopAll.confirm': { n: number }
  'actions.stopAll.message': { n: number; project: string | number }
  'actions.stopAll.note': undefined
  'actions.stopAll.title': { n: number }
  'actions.stopFirst.confirm': { what: string; agent: string | number }
  'actions.stopFirst.detail': undefined
  'actions.stopFirst.message': { named: string; agent: string | number; project: string | number }
  'actions.stopFirst.title': { what: string; agent: string | number }
  'actions.template.addAgentFailed': undefined
  'actions.template.addConfirm': undefined
  'actions.template.addName': undefined
  'actions.template.addSuggests': { role: string | number; hasCli: string; cli: string | number }
  'actions.template.addTitle': undefined
  'actions.template.blockedMessage': { project: string }
  'actions.template.blockedTitle': { name: string | number }
  'actions.template.everyProject': undefined
  'actions.template.includeWorkflow': { platform: string | number }
  'actions.template.load': undefined
  'actions.template.loadAdds': { project: string | number }
  'actions.template.loadReplaces': { project: string | number }
  'actions.template.loadTitle': { name: string | number }
  'actions.template.loading': undefined
  'actions.template.nameEmpty': undefined
  'actions.template.namePlaceholder': undefined
  'actions.template.nameTooLong': { max: string | number }
  'actions.template.noAgents': undefined
  'actions.template.noAgentsMessage': undefined
  'actions.template.ok': undefined
  'actions.template.readFailed': undefined
  'actions.template.replace': undefined
  'actions.template.replaceDetail': undefined
  'actions.template.replaceMessage': { scope: string; name: string | number }
  'actions.template.replaceTitle': undefined
  'actions.template.save': undefined
  'actions.template.saveFailed': undefined
  'actions.template.saveMessage2': { n: number }
  'actions.template.saveTitle': undefined
  'actions.template.saved': undefined
  'actions.template.savedMessage': { name: string | number; n: number; scope: string }
  'actions.template.switchPreset': { preset: string | number }
  'actions.template.usePatterns': { example: string | number; pattern: string | number }
  'actions.template.workflowChanged': { template: string | number }
  'actions.template.workflowKept': { count: number; platforms: string | number }
  'actions.template.workflowNone': undefined
  'actions.template.workflowSaved': { platform: string | number }
  'actions.unsaved.changedMessage': { action: string }
  'actions.unsaved.changedTitle': undefined
  'actions.unsaved.message': { n: number; file: string | number; action: string }
  'actions.unsaved.saveAll': undefined
  'actions.unsaved.saveFailed': { n: number }
  'actions.unsaved.title': undefined
  'actions.workspace.closeFailed': undefined
  'actions.workspace.createFailed': undefined
  'actions.workspace.openFailed': undefined
  'actions.worktree.createFailed': undefined
  'actions.worktree.createNew': undefined
  'actions.worktree.goneDetail': { setup: string | number }
  'actions.worktree.goneMessage': { agent: string | number; path: string | number; branch: string | number; base: string | number }
  'actions.worktree.goneTitle': undefined
  'actions.worktree.recreate': undefined
  'actions.worktree.recreateMessage': { agent: string | number; path: string | number; branch: string | number }
  'actions.worktree.recreateTitle': undefined
  'actions.worktree.recreating': undefined
  'actions.worktree.setup': undefined
  'actions.worktree.unlink': undefined
  'actions.worktree.unlinkFailed': undefined
}
