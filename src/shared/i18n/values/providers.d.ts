// Generated from locales/en/providers.json: do not edit. Each message's placeholders and their types, for tr(): a
// global script, so its interface merges with every other area's (shared/i18n/msg.ts).
interface CombworkMessageValues {
  'providers.action.install': undefined
  'providers.action.signIn': undefined
  'providers.action.update': undefined
  'providers.antigravity.checkFailed': { provider: string | number; text: string | number }
  'providers.antigravity.conversationGone': { provider: string | number; conversation: string | number }
  'providers.antigravity.notOwnConversation': { provider: string | number; conversation: string | number }
  'providers.antigravity.notice.auto': { build: string | number }
  'providers.antigravity.notice.setup': undefined
  'providers.antigravity.notice.sse': { count: number; servers: string | number }
  'providers.antigravity.notice.title': undefined
  'providers.antigravity.projectServers': { provider: string | number; count: number; files: string | number; servers: string | number }
  'providers.antigravity.setup.action': undefined
  'providers.antigravity.setup.copied': undefined
  'providers.antigravity.setup.needed': undefined
  'providers.antigravity.setup.runs': undefined
  'providers.antigravity.signIn.runs': undefined
  'providers.antigravity.signIn.shared': undefined
  'providers.antigravity.unreadableConfig': { provider: string | number; file: string | number; why: string | number }
  'providers.autoCompact.autoIn': { key: string | number; scope: string | number }
  'providers.autoCompact.badSources': undefined
  'providers.autoCompact.disabledIn': { scope: string | number }
  'providers.autoCompact.envIn': { variable: string | number; scope: string | number }
  'providers.autoCompact.estimate': { unsure: string | number }
  'providers.autoCompact.keyIn': { key: string | number; scope: string | number }
  'providers.autoCompact.scope.local': undefined
  'providers.autoCompact.scope.managed': undefined
  'providers.autoCompact.scope.project': undefined
  'providers.autoCompact.scope.user': undefined
  'providers.autoCompact.unreadReason': undefined
  'providers.autoCompact.unreadable': { why: string | number }
  'providers.autoCompact.unsureFile.local': { unsure: string | number }
  'providers.autoCompact.unsureFile.managed': { unsure: string | number }
  'providers.autoCompact.unsureFile.project': { unsure: string | number }
  'providers.autoCompact.unsureFile.user': { unsure: string | number }
  'providers.autoCompact.unsureMode': undefined
  'providers.autoCompact.unsureScope': { scope: string | number; unsure: string | number }
  'providers.autoCompact.why.notFile': undefined
  'providers.autoCompact.why.tooBig': undefined
  'providers.claude.connections.setUp': undefined
  'providers.claude.hint.args': undefined
  'providers.claude.hint.broken': undefined
  'providers.claude.hint.model': undefined
  'providers.claude.hint.signIn': undefined
  'providers.claude.localLimits.inFile': { file: string | number }
  'providers.claude.localLimits.oursContext': { connection: string | number }
  'providers.claude.localLimits.oursOutput': { connection: string | number }
  'providers.claude.localLimits.outputNotBelow': { agent: string | number; output: number; outputFrom: string | number; context: number; contextFrom: string | number }
  'providers.claude.localLimits.tooSmall': { agent: string | number; context: number; contextFrom: string | number }
  'providers.cmdTooLong': { file: string | number; max: number; length: number }
  'providers.codex.connections.setUp': undefined
  'providers.codex.developerUnread.agentMessage': undefined
  'providers.codex.developerUnread.agentTitle': undefined
  'providers.codex.developerUnread.assistantMessage': undefined
  'providers.codex.developerUnread.assistantTitle': undefined
  'providers.codex.hint.broken': undefined
  'providers.codex.hint.model': undefined
  'providers.codex.hint.settings': undefined
  'providers.codex.hint.signIn': undefined
  'providers.codex.nativeCombwork': { file: string | number }
  'providers.codex.sandbox.default': undefined
  'providers.codex.sandbox.needed': undefined
  'providers.codex.sandbox.nonAdmin': undefined
  'providers.codex.sandbox.nonAdminUsed': undefined
  'providers.codex.sandbox.setUp': undefined
  'providers.codex.sandbox.setUpAction': undefined
  'providers.codex.sandbox.upgrade': undefined
  'providers.codex.sandbox.upgradeAction': undefined
  'providers.codex.storePwsh.fix': undefined
  'providers.codex.storePwsh.label': undefined
  'providers.codex.storePwsh.symptom': undefined
  'providers.codex.storePwsh.warning': undefined
  'providers.codex.stray.message': { folder: string | number; files: string | number }
  'providers.codex.stray.more': { n: number }
  'providers.codex.stray.title': undefined
  'providers.copilot.hint.args': undefined
  'providers.copilot.hint.broken': undefined
  'providers.copilot.hint.mcp': undefined
  'providers.copilot.hint.model': undefined
  'providers.copilot.hint.signIn': undefined
  'providers.copilot.parens.message': undefined
  'providers.copilot.parens.title': undefined
  'providers.copilot.planNote': undefined
  'providers.copilot.signIn.deviceCode': undefined
  'providers.copilot.signIn.gh': undefined
  'providers.copilot.signIn.ignored': { n: number; variables: string | number }
  'providers.copilot.signIn.runs': undefined
  'providers.copilot.updateAnyway': undefined
  'providers.copilot.updateManual': { provider: string | number }
  'providers.copilot.updateModified': undefined
  'providers.export.compacted': { trigger: string | number; before: string | number; after: string | number }
  'providers.export.error': undefined
  'providers.export.image': undefined
  'providers.export.imageAt': { path: string | number }
  'providers.export.result': undefined
  'providers.export.subtitle': { provider: string | number; session: string | number; project: string | number }
  'providers.export.summary': undefined
  'providers.export.thinking': undefined
  'providers.export.you': undefined
  'providers.localLimits.context': { value: number; from: string | number; estimate: string }
  'providers.localLimits.inFile': { file: string | number }
  'providers.localLimits.notUsed': { why: string; model: string | number; file: string | number; connection: string | number }
  'providers.localLimits.ours': { connection: string | number }
  'providers.localLimits.output': { value: number; from: string | number; fallback: string }
  'providers.localLimits.switched': { model: string | number }
  'providers.memory.connection': { file: string | number; name: string | number }
  'providers.memory.user': { file: string | number }
  'providers.readiness.notInstalled': { provider: string | number }
  'providers.readiness.signedOut': { provider: string | number }
  'providers.readiness.update': { provider: string | number; version: string | number }
  'providers.settings.hooksOff': { source: string; file: string | number }
  'providers.settings.noFile': undefined
  'providers.settings.noValue': undefined
  'providers.settings.notAFile': undefined
  'providers.settings.notJson': { file: string | number; why: string | number }
  'providers.settings.notList': { source: string; file: string | number; key: string | number }
  'providers.settings.notObject': { source: string; file: string | number }
  'providers.settings.tooLarge': undefined
  'providers.settings.unreadable': { file: string | number; why: string | number }
  'providers.transcript.aborted': undefined
  'providers.transcript.apiError': undefined
  'providers.transcript.interrupted': undefined
  'providers.transcript.resumed': undefined
  'providers.transcript.turnEnded': { reason: string | number }
  'providers.unknown': { provider: string | number }
}
