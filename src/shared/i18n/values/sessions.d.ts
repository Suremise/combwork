// Generated from locales/en/sessions.json: do not edit. Each message's placeholders and their types, for tr(): a
// global script, so its interface merges with every other area's (shared/i18n/msg.ts).
interface CombworkMessageValues {
  'sessions.archive.failed': undefined
  'sessions.archive.message': undefined
  'sessions.archive.title': undefined
  'sessions.attach.byPath': { kind: string | number }
  'sessions.attach.byPathDetail': { cli: string | number; kind: string }
  'sessions.attach.file': undefined
  'sessions.attach.image': undefined
  'sessions.attach.native': { cli: string | number; kind: string }
  'sessions.attach.pdf': undefined
  'sessions.attach.text': undefined
  'sessions.branch.archive': { scope: string; n: number }
  'sessions.branch.delete': { scope: string; n: number }
  'sessions.branch.nothingToArchive': undefined
  'sessions.branch.unarchive': { scope: string; n: number }
  'sessions.bulk.andMore': { n: number }
  'sessions.bulk.archiveAll': undefined
  'sessions.bulk.archiveDetail': { skipNote: string | number }
  'sessions.bulk.archiveMessage': { what: string | number; branch: string | number }
  'sessions.bulk.archiveTitle': { what: string | number }
  'sessions.bulk.closedView': undefined
  'sessions.bulk.deleteAll': undefined
  'sessions.bulk.deleteDetail': { skipNote: string | number }
  'sessions.bulk.deleteMessage': { what: string | number; branch: string | number }
  'sessions.bulk.deleteTitle': { what: string | number }
  'sessions.bulk.done': { action: string; n: number }
  'sessions.bulk.doneSkipped': { action: string; n: number; skipped: number; why: string | number }
  'sessions.bulk.failed': { action: string; kind: string }
  'sessions.bulk.progress': { action: string; kind: string; done: number; total: number }
  'sessions.bulk.skipCount': { reason: string; n: number }
  'sessions.bulk.skipNote': { running: number }
  'sessions.bulk.skipReason': { reason: string }
  'sessions.cards.deleted': undefined
  'sessions.cards.reviewed': undefined
  'sessions.cards.workedOn': undefined
  'sessions.chips.dismiss': { file: string | number }
  'sessions.chips.label': undefined
  'sessions.chips.toCard': { file: string | number }
  'sessions.cleanup.age': { age: string }
  'sessions.cleanup.archive': undefined
  'sessions.cleanup.archiveSummary': undefined
  'sessions.cleanup.archived': { n: number }
  'sessions.cleanup.busy': { action: string }
  'sessions.cleanup.cancel': undefined
  'sessions.cleanup.delete': undefined
  'sessions.cleanup.deleteSummary': undefined
  'sessions.cleanup.go': { action: string }
  'sessions.cleanup.inUse': undefined
  'sessions.cleanup.nothing': { age: string; action: string }
  'sessions.cleanup.olderThan': undefined
  'sessions.cleanup.skipCount': { n: number; reason: string | number }
  'sessions.cleanup.skipReason': { reason: string }
  'sessions.cleanup.skipped': { skips: string | number }
  'sessions.cleanup.summary': { what: string | number; age: string }
  'sessions.cleanup.title': { kind: string }
  'sessions.common.adopt': undefined
  'sessions.common.adoptFailed': undefined
  'sessions.common.archive': undefined
  'sessions.common.collapseAll': undefined
  'sessions.common.delete': { kind: string }
  'sessions.common.expandAll': undefined
  'sessions.common.loading': undefined
  'sessions.common.moreActions': undefined
  'sessions.common.noneYet': { kind: string }
  'sessions.common.rename': undefined
  'sessions.common.resume': undefined
  'sessions.common.resumeElsewhere': undefined
  'sessions.common.resumeIn': { agent: string | number }
  'sessions.common.unarchive': undefined
  'sessions.compaction.copy': undefined
  'sessions.compaction.title': undefined
  'sessions.compaction.tokens': { before: string | number; after: string | number; next: string; freed: string | number; when: string | number }
  'sessions.delete.button': undefined
  'sessions.delete.detailCombwork': { cli: string | number }
  'sessions.delete.detailExternal': { cli: string | number }
  'sessions.delete.failed': { kind: string }
  'sessions.delete.message': { name: string | number }
  'sessions.delete.title': { kind: string }
  'sessions.empty.select': { kind: string }
  'sessions.export.done': undefined
  'sessions.export.failed': undefined
  'sessions.filter.archived': undefined
  'sessions.hit.assistant': undefined
  'sessions.hit.command': undefined
  'sessions.hit.compaction': undefined
  'sessions.hit.notice': undefined
  'sessions.hit.thinking': undefined
  'sessions.hit.tool': undefined
  'sessions.hit.user': undefined
  'sessions.image.copyPath': undefined
  'sessions.image.earlier': undefined
  'sessions.image.later': undefined
  'sessions.image.position': { n: number; total: number }
  'sessions.image.reveal': undefined
  'sessions.image.untitled': undefined
  'sessions.list.cleanUp': { kind: string }
  'sessions.list.heading': { kind: string }
  'sessions.list.info': undefined
  'sessions.list.infoAssistant': undefined
  'sessions.list.new': { kind: string }
  'sessions.list.noneHere': { kind: string }
  'sessions.list.othersLoading': undefined
  'sessions.list.refresh': undefined
  'sessions.list.what': { kind: string }
  'sessions.marker.cantResume': undefined
  'sessions.marker.orphan': undefined
  'sessions.menu.copyId': undefined
  'sessions.menu.delete': { kind: string }
  'sessions.menu.purge': undefined
  'sessions.menu.rename': undefined
  'sessions.menu.showAgent': { agent: string | number }
  'sessions.menu.showAssistant': undefined
  'sessions.origin.agent': { agent: string | number; id: string | number }
  'sessions.origin.named': { is: string; name: string | number }
  'sessions.origin.noAgent': undefined
  'sessions.origin.projectFolder': undefined
  'sessions.origin.ranIn': { folder: string | number }
  'sessions.origin.removed': { id: string | number }
  'sessions.origin.removedName': { agent: string | number }
  'sessions.origin.removedUnnamed': undefined
  'sessions.origin.worktree': { branch: string | number }
  'sessions.rename.failed': undefined
  'sessions.rename.title': undefined
  'sessions.resume.addsTip': undefined
  'sessions.resume.agentDetail': { where: string; branch: string | number; place: string | number; running: string }
  'sessions.resume.menuHeader': undefined
  'sessions.resume.startFresh': undefined
  'sessions.row.archived': undefined
  'sessions.row.backup': undefined
  'sessions.row.backupTip': { cli: string | number }
  'sessions.row.context': { tokens: string | number }
  'sessions.row.external': undefined
  'sessions.row.externalTip': undefined
  'sessions.row.lastActive': { when: string | number }
  'sessions.row.subs': { n: number }
  'sessions.row.subsTip': { cli: string | number; n: string | number }
  'sessions.running.agentTip': { agent: string | number }
  'sessions.running.assistantTip': undefined
  'sessions.running.show': undefined
  'sessions.running.showAgent': { agent: string | number }
  'sessions.search.clear': undefined
  'sessions.search.count': { kind: string; sessions: number; hits: number; more: string | number }
  'sessions.search.none': undefined
  'sessions.search.placeholder': { kind: string }
  'sessions.search.searching': undefined
  'sessions.search.what': undefined
  'sessions.size.none': { kind: string; cli: string | number; backup: string }
  'sessions.size.tip': { size: string | number; limit: number; long: string }
  'sessions.tool.copyInput': undefined
  'sessions.tool.copyResult': undefined
  'sessions.tool.empty': undefined
  'sessions.tool.error': undefined
  'sessions.tool.errorBadge': undefined
  'sessions.tool.exitCode': { code: string | number }
  'sessions.tool.input': undefined
  'sessions.tool.loadFailed': undefined
  'sessions.tool.noResult': undefined
  'sessions.tool.result': undefined
  'sessions.tool.scriptFailedCalls': { n: number }
  'sessions.tool.scriptKindCalls': { kind: string; n: number }
  'sessions.tool.scriptMcpCalls': { n: number; server: string | number }
  'sessions.tool.showAll': { n: number }
  'sessions.tree.both': { n: number; subs: number }
  'sessions.tree.none': undefined
  'sessions.tree.notFromAgent': undefined
  'sessions.tree.sessions': { n: number }
  'sessions.tree.subs': { n: number }
  'sessions.view.collapseTools': undefined
  'sessions.view.copy': undefined
  'sessions.view.copyMessage': undefined
  'sessions.view.copyReply': undefined
  'sessions.view.earlier': { n: number }
  'sessions.view.empty': undefined
  'sessions.view.expandTools': undefined
  'sessions.view.export': undefined
  'sessions.view.follow': undefined
  'sessions.view.followTip': undefined
  'sessions.view.following': undefined
  'sessions.view.followingTip': undefined
  'sessions.view.handedOver': undefined
  'sessions.view.handedOverTip': undefined
  'sessions.view.ranIn': undefined
  'sessions.view.refresh': undefined
  'sessions.view.running': undefined
  'sessions.view.thinking': undefined
  'sessions.view.usage': { context: string | number; output: string | number; prompts: number; compactions: number; cache: string; left: string | number }
  'sessions.view.you': undefined
}
