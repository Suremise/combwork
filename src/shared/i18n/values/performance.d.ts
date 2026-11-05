// Generated from locales/en/performance.json: do not edit. Each message's placeholders and their types, for tr(): a
// global script, so its interface merges with every other area's (shared/i18n/msg.ts).
interface HiveMessageValues {
  'performance.appWide': { inFlight: number; refused: number; connections: number; events: number; size: string | number }
  'performance.card.data': undefined
  'performance.card.dataSub': { size: string | number }
  'performance.card.dataTip': undefined
  'performance.card.guidance': undefined
  'performance.card.guidanceSub': { launches: number; core: string | number; catalog: string | number }
  'performance.card.guidanceTip': undefined
  'performance.card.latency': undefined
  'performance.card.latencyTip': undefined
  'performance.card.p50': { latency: string | number }
  'performance.card.p95': { latency: string | number }
  'performance.card.requests': undefined
  'performance.card.requestsSub': { failed: string | number; cancelled: string | number }
  'performance.card.requestsSubRate': { rate: number; failed: string | number; cancelled: string | number }
  'performance.card.requestsTip': undefined
  'performance.card.toolReplies': undefined
  'performance.card.toolRepliesSub': { calls: number; size: string | number }
  'performance.card.toolRepliesTip': undefined
  'performance.cards.builder': undefined
  'performance.cards.card': undefined
  'performance.cards.column': undefined
  'performance.cards.cost': undefined
  'performance.cards.empty': { range: string }
  'performance.cards.heading': undefined
  'performance.cards.lastHeld': undefined
  'performance.cards.loadTarget': undefined
  'performance.cards.open': { number: string | number }
  'performance.cards.project': undefined
  'performance.cards.reviewer': undefined
  'performance.cards.rounds': undefined
  'performance.cards.roundsTip': undefined
  'performance.cards.tip': { range: string; zero: string | number }
  'performance.cards.unknown': { n: number }
  'performance.col.p50': undefined
  'performance.col.p95': undefined
  'performance.col.requests': undefined
  'performance.compare.about.export': { from: string | number; to: string | number; filters: string | number }
  'performance.compare.about.exportPart': { from: string | number; to: string | number; filters: string | number; part: string | number }
  'performance.compare.about.scenarios': { real: string; provider: string | number; model: string | number; effort: string | number; mode: string | number; fixtures: string | number; scenarios: number; repeats: number; head: string | number; spent: string | number; unpriced: number }
  'performance.compare.agent.assistant': undefined
  'performance.compare.agent.overflow': { n: number }
  'performance.compare.agent.unattributed': undefined
  'performance.compare.agentCalls': { agent: string | number; role: string; base: string | number; run: string | number }
  'performance.compare.baseline': undefined
  'performance.compare.callsByAgent': { agents: string | number }
  'performance.compare.cantCompare': undefined
  'performance.compare.col.allAgentsTip': undefined
  'performance.compare.col.calls': undefined
  'performance.compare.col.callsTip': undefined
  'performance.compare.col.change': undefined
  'performance.compare.col.checks': undefined
  'performance.compare.col.checksTip': undefined
  'performance.compare.col.context': undefined
  'performance.compare.col.kept': undefined
  'performance.compare.col.kind': undefined
  'performance.compare.col.measure': undefined
  'performance.compare.col.result': undefined
  'performance.compare.col.scenario': undefined
  'performance.compare.col.toolReplies': undefined
  'performance.compare.col.when': undefined
  'performance.compare.comparable': { kind: string }
  'performance.compare.comparisonLoadTarget': undefined
  'performance.compare.couldNotChange': undefined
  'performance.compare.couldNotImport': undefined
  'performance.compare.couldNotKeep': undefined
  'performance.compare.emptyHint': { scope: string }
  'performance.compare.error.benchmarkOnOwn': undefined
  'performance.compare.error.benchmarkOnProject': undefined
  'performance.compare.error.exportIsOwn': undefined
  'performance.compare.error.exportIsWhole': undefined
  'performance.compare.error.holdsOther': { project: string | number; other: string }
  'performance.compare.error.invalidBenchmark': undefined
  'performance.compare.error.invalidExport': undefined
  'performance.compare.error.noPart': { project: string | number }
  'performance.compare.error.noScenarios': undefined
  'performance.compare.error.notCombwork': undefined
  'performance.compare.error.notJson': undefined
  'performance.compare.error.otherProject': { project: string | number; here: string | number }
  'performance.compare.error.ownHoldsProjects': undefined
  'performance.compare.error.ownNoPart': undefined
  'performance.compare.error.projectsExport': { project: string | number }
  'performance.compare.error.sanitized': undefined
  'performance.compare.error.sanitizedPart': undefined
  'performance.compare.error.tooLarge': { mb: number }
  'performance.compare.error.unknownSchema': undefined
  'performance.compare.failedInRun': { checks: string | number }
  'performance.compare.filters': { role: string | number; provider: string | number; own: string }
  'performance.compare.filters.allProviders': undefined
  'performance.compare.filters.everyone': undefined
  'performance.compare.filters.role.agent': undefined
  'performance.compare.filters.role.api': undefined
  'performance.compare.filters.role.assistant': undefined
  'performance.compare.filters.role.viewer': undefined
  'performance.compare.hint': undefined
  'performance.compare.import': undefined
  'performance.compare.importTip': undefined
  'performance.compare.keep.confirm': undefined
  'performance.compare.keep.message': undefined
  'performance.compare.keep.placeholder': undefined
  'performance.compare.keep.title': undefined
  'performance.compare.keepCurrent': undefined
  'performance.compare.keepTip': { what: string | number }
  'performance.compare.keeps': { range: string; role: string }
  'performance.compare.keptList': { n: number }
  'performance.compare.keptListTip': { max: number }
  'performance.compare.keptLoadTarget': undefined
  'performance.compare.keptNotice': undefined
  'performance.compare.kind.export': undefined
  'performance.compare.kind.scenarios': undefined
  'performance.compare.label.benchmark': { provider: string | number }
  'performance.compare.label.export': { from: string | number; to: string | number; own: string }
  'performance.compare.label.exportPart': { from: string | number; to: string | number; project: string | number }
  'performance.compare.label.kept': { from: string | number; to: string | number }
  'performance.compare.measure.apiCancelled': undefined
  'performance.compare.measure.apiFailed': undefined
  'performance.compare.measure.apiMs': undefined
  'performance.compare.measure.apiRequestBytes': undefined
  'performance.compare.measure.apiRequests': undefined
  'performance.compare.measure.apiResponseBytes': undefined
  'performance.compare.measure.cacheReadTokens': undefined
  'performance.compare.measure.cacheWriteTokens': undefined
  'performance.compare.measure.combworkCallErrors': undefined
  'performance.compare.measure.combworkCalls': undefined
  'performance.compare.measure.contextBytes': undefined
  'performance.compare.measure.costUsd': undefined
  'performance.compare.measure.exportDetailCalls': undefined
  'performance.compare.measure.exportFailed': undefined
  'performance.compare.measure.exportGuidancePerLaunch': undefined
  'performance.compare.measure.exportLaunches': undefined
  'performance.compare.measure.exportRequests': undefined
  'performance.compare.measure.exportResponseBytes': undefined
  'performance.compare.measure.exportToolCalls': undefined
  'performance.compare.measure.exportToolChars': undefined
  'performance.compare.measure.exportToolListPerLaunch': undefined
  'performance.compare.measure.guidanceBytes': undefined
  'performance.compare.measure.guidanceChars': undefined
  'performance.compare.measure.inputTokens': undefined
  'performance.compare.measure.outputTokens': undefined
  'performance.compare.measure.providerRequests': undefined
  'performance.compare.measure.reasoningTokens': undefined
  'performance.compare.measure.repeatedCalls': undefined
  'performance.compare.measure.seconds': undefined
  'performance.compare.measure.skillBytes': undefined
  'performance.compare.measure.skillBytesRead': undefined
  'performance.compare.measure.skillHits': undefined
  'performance.compare.measure.skillInvalidations': undefined
  'performance.compare.measure.skillMisses': undefined
  'performance.compare.measure.skillScans': undefined
  'performance.compare.measure.skillsNotDelivered': undefined
  'performance.compare.measure.toolBytes': undefined
  'performance.compare.measure.toolCalls': undefined
  'performance.compare.measure.toolChars': undefined
  'performance.compare.measure.toolDetailCalls': undefined
  'performance.compare.measure.toolErrors': undefined
  'performance.compare.measure.toolListBytes': undefined
  'performance.compare.measure.toolListChars': undefined
  'performance.compare.measureTip.apiCancelled': undefined
  'performance.compare.measureTip.apiFailed': undefined
  'performance.compare.measureTip.apiMs': undefined
  'performance.compare.measureTip.apiRequestBytes': undefined
  'performance.compare.measureTip.apiRequests': undefined
  'performance.compare.measureTip.apiResponseBytes': undefined
  'performance.compare.measureTip.asReported': undefined
  'performance.compare.measureTip.combworkCallErrors': undefined
  'performance.compare.measureTip.combworkCalls': undefined
  'performance.compare.measureTip.contextBytes': undefined
  'performance.compare.measureTip.costUsd': undefined
  'performance.compare.measureTip.exportGuidancePerLaunch': undefined
  'performance.compare.measureTip.exportRequests': undefined
  'performance.compare.measureTip.exportToolChars': undefined
  'performance.compare.measureTip.exportToolListPerLaunch': undefined
  'performance.compare.measureTip.guidanceBytes': undefined
  'performance.compare.measureTip.guidanceChars': undefined
  'performance.compare.measureTip.outputTokens': undefined
  'performance.compare.measureTip.perHour': undefined
  'performance.compare.measureTip.providerRequests': undefined
  'performance.compare.measureTip.reasoningTokens': undefined
  'performance.compare.measureTip.repeatedCalls': undefined
  'performance.compare.measureTip.seconds': undefined
  'performance.compare.measureTip.skillBytes': undefined
  'performance.compare.measureTip.skillBytesRead': undefined
  'performance.compare.measureTip.skillHits': undefined
  'performance.compare.measureTip.skillInvalidations': undefined
  'performance.compare.measureTip.skillMisses': undefined
  'performance.compare.measureTip.skillScans': undefined
  'performance.compare.measureTip.skillsNotDelivered': undefined
  'performance.compare.measureTip.toolBytes': undefined
  'performance.compare.measureTip.toolCalls': undefined
  'performance.compare.measureTip.toolChars': undefined
  'performance.compare.measureTip.toolDetailCalls': undefined
  'performance.compare.measureTip.toolErrors': undefined
  'performance.compare.measureTip.toolListBytes': undefined
  'performance.compare.measureTip.toolListChars': undefined
  'performance.compare.noScenarios': undefined
  'performance.compare.notComparable': { reasons: string | number }
  'performance.compare.note.cliVersions': { base: string | number; run: string | number }
  'performance.compare.note.estimates': undefined
  'performance.compare.note.fakePerCall': undefined
  'performance.compare.note.fakeUsage': undefined
  'performance.compare.note.leftOut': { n: number; why: string | number }
  'performance.compare.note.measuredPartly': { n: number }
  'performance.compare.note.noSplit': { side: string }
  'performance.compare.note.notJudged': undefined
  'performance.compare.note.oneSample': undefined
  'performance.compare.note.partial': { side: string; what: string | number }
  'performance.compare.note.rangesDiffer': undefined
  'performance.compare.note.realUse': undefined
  'performance.compare.note.resumed': undefined
  'performance.compare.note.sameGuidance': undefined
  'performance.compare.note.skillRevisions': undefined
  'performance.compare.note.skillRevisionsOf': { names: string | number }
  'performance.compare.note.splitPartial': undefined
  'performance.compare.note.stale': { n: number }
  'performance.compare.note.usageNotEvery': undefined
  'performance.compare.note.withinSpread': undefined
  'performance.compare.nothingKept': undefined
  'performance.compare.nothingMeasured': undefined
  'performance.compare.nothingYet': undefined
  'performance.compare.oneMore': undefined
  'performance.compare.partial.dropped': { n: number }
  'performance.compare.partial.evicted': undefined
  'performance.compare.partial.invalid': { keys: string | number; n: number }
  'performance.compare.partial.projectPart': undefined
  'performance.compare.partial.unattributed': undefined
  'performance.compare.pin': undefined
  'performance.compare.reason.differentFilters': { base: string | number; run: string | number }
  'performance.compare.reason.differentFixtures': { base: string | number; run: string | number }
  'performance.compare.reason.differentKinds': undefined
  'performance.compare.reason.differentProviders': { base: string | number; run: string | number }
  'performance.compare.reason.differentScopes': { base: string | number; run: string | number }
  'performance.compare.reason.differentSetups': { base: string | number; run: string | number }
  'performance.compare.reason.fakeVsModel': undefined
  'performance.compare.reason.notRecording': undefined
  'performance.compare.reason.oneIncomplete': undefined
  'performance.compare.reason.sourceChanged': { side: string }
  'performance.compare.regressions': undefined
  'performance.compare.remove': undefined
  'performance.compare.rowLabel': { id: string | number; status: string | number; open: string }
  'performance.compare.run': undefined
  'performance.compare.sameFile': undefined
  'performance.compare.sample.checkTwice': undefined
  'performance.compare.sample.checksNotList': undefined
  'performance.compare.sample.countsDiffer': undefined
  'performance.compare.sample.didntComplete': undefined
  'performance.compare.sample.failedNoCheck': undefined
  'performance.compare.sample.invalidCheck': undefined
  'performance.compare.sample.noCheckRan': undefined
  'performance.compare.sample.tooManyChecks': undefined
  'performance.compare.samples': { title: string | number; base: number; run: number }
  'performance.compare.scopeName': { kind: string; project: string | number }
  'performance.compare.sideMeasure': { measure: string | number; side: string }
  'performance.compare.sizesHint': undefined
  'performance.compare.splitMeasure': { measure: string | number; part: string; assistant: string }
  'performance.compare.status.better': undefined
  'performance.compare.status.betterTip': undefined
  'performance.compare.status.failing': undefined
  'performance.compare.status.failingTip': undefined
  'performance.compare.status.incomplete': undefined
  'performance.compare.status.incompleteTip': undefined
  'performance.compare.status.onlyInBase': undefined
  'performance.compare.status.onlyInBaseTip': undefined
  'performance.compare.status.onlyInRun': undefined
  'performance.compare.status.onlyInRunTip': undefined
  'performance.compare.status.same': undefined
  'performance.compare.status.sameTip': undefined
  'performance.compare.status.smallerFailing': undefined
  'performance.compare.status.smallerFailingTip': undefined
  'performance.compare.status.worse': undefined
  'performance.compare.status.worseTip': undefined
  'performance.compare.summary': { n: number; status: string }
  'performance.compare.swap': undefined
  'performance.compare.unit.ms': { n: string | number }
  'performance.compare.unit.seconds': { n: string | number }
  'performance.compare.unknown': undefined
  'performance.compare.unknownTip': undefined
  'performance.compare.unpin': undefined
  'performance.compare.usageNotCompared': undefined
  'performance.compare.usePart.confirm': { project: string | number }
  'performance.compare.usePart.detail': undefined
  'performance.compare.usePart.message': { project: string | number }
  'performance.compare.usePart.title': { project: string | number }
  'performance.coverage.dropped': { n: number }
  'performance.coverage.evicted': { when: string | number }
  'performance.coverage.full': undefined
  'performance.coverage.none': undefined
  'performance.coverage.partial': { duration: string | number; percent: string | number; sinceShown: string; since: string | number; stretches: number }
  'performance.coverage.range': { from: string | number; to: string | number }
  'performance.coverage.unattributed': undefined
  'performance.duration.days': { d: number }
  'performance.duration.daysHours': { d: number; h: number }
  'performance.duration.hours': { h: number }
  'performance.duration.hoursMinutes': { h: number; m: number }
  'performance.duration.minutes': { m: number }
  'performance.empty': { filtered: string; range: string }
  'performance.export.button': undefined
  'performance.export.done': undefined
  'performance.export.failed': undefined
  'performance.export.tip': undefined
  'performance.guidance.catalog': undefined
  'performance.guidance.core': undefined
  'performance.guidance.empty': undefined
  'performance.guidance.heading': undefined
  'performance.guidance.launches': undefined
  'performance.guidance.mode': undefined
  'performance.guidance.notGiven': undefined
  'performance.guidance.notGivenTip': { notDelivered: number; unmeasured: number }
  'performance.guidance.onDisk': undefined
  'performance.guidance.project': undefined
  'performance.guidance.role': undefined
  'performance.guidance.skills': undefined
  'performance.guidance.tip': undefined
  'performance.guidance.unmeasured': undefined
  'performance.guidance.workflow': undefined
  'performance.guidance.workflowSide': { side: string }
  'performance.heading': undefined
  'performance.intro.project': undefined
  'performance.intro.workspace': undefined
  'performance.latency.ms': { ms: number }
  'performance.latency.over': { s: number }
  'performance.latency.seconds': { s: number }
  'performance.limits.heading': undefined
  'performance.limits.window': undefined
  'performance.loadTarget': undefined
  'performance.loading': undefined
  'performance.noWorkspace': undefined
  'performance.notRecording': undefined
  'performance.notRecording.settings': undefined
  'performance.pageLabel': { scope: string | number }
  'performance.panel.projects': undefined
  'performance.panel.tip': undefined
  'performance.provider.all': undefined
  'performance.provider.groupLabel': undefined
  'performance.provider.label': undefined
  'performance.provider.note': undefined
  'performance.provider.nothing': { provider: string | number; range: string; filtered: string }
  'performance.providersNote.assistant': undefined
  'performance.providersNote.scripts': undefined
  'performance.range.label': undefined
  'performance.range.name': { range: string }
  'performance.refresh': undefined
  'performance.role.agent': undefined
  'performance.role.all': undefined
  'performance.role.api': undefined
  'performance.role.assistant': undefined
  'performance.role.viewer': undefined
  'performance.routes.cancelled': undefined
  'performance.routes.empty': undefined
  'performance.routes.failed': undefined
  'performance.routes.heading': undefined
  'performance.routes.received': undefined
  'performance.routes.route': undefined
  'performance.routes.sent': undefined
  'performance.routes.tip': undefined
  'performance.routes.waits': undefined
  'performance.safeguards.agent': undefined
  'performance.safeguards.empty': undefined
  'performance.safeguards.heading': undefined
  'performance.safeguards.model': undefined
  'performance.safeguards.stops': undefined
  'performance.safeguards.tip': undefined
  'performance.scope.badgeTitle': undefined
  'performance.scope.label': undefined
  'performance.scope.own': undefined
  'performance.scope.ownTip': undefined
  'performance.scope.project': { project: string | number }
  'performance.scope.projectTip': { project: string | number }
  'performance.scope.whole': undefined
  'performance.scope.wholeTip': undefined
  'performance.skills.cache': undefined
  'performance.skills.cacheSub': { hits: number; misses: number; changed: number }
  'performance.skills.cacheTip': undefined
  'performance.skills.heading': undefined
  'performance.skills.read': undefined
  'performance.skills.readSub': { files: number; headers: string | number; entries: number }
  'performance.skills.scans': undefined
  'performance.skills.scansSub': { latency: string | number; shared: number }
  'performance.skills.tip': undefined
  'performance.skills.tooBig': undefined
  'performance.skills.tooBigSub': undefined
  'performance.skills.unfiltered': undefined
  'performance.stalls.count': { total: number; listed: string; kept: number }
  'performance.stalls.cpu': undefined
  'performance.stalls.cpuUnknown': undefined
  'performance.stalls.during': undefined
  'performance.stalls.empty': undefined
  'performance.stalls.heading': undefined
  'performance.stalls.length': undefined
  'performance.stalls.loadTarget': undefined
  'performance.stalls.more': { n: number }
  'performance.stalls.ms': { ms: number }
  'performance.stalls.none': undefined
  'performance.stalls.repeated': { n: number; length: string | number }
  'performance.stalls.running': { length: string | number }
  'performance.stalls.seconds': { s: string | number }
  'performance.stalls.since': undefined
  'performance.stalls.step': undefined
  'performance.stalls.tip': { kept: number }
  'performance.stalls.waiting': undefined
  'performance.stalls.when': undefined
  'performance.toolList.bytes': undefined
  'performance.toolList.chars': undefined
  'performance.toolList.descriptions': undefined
  'performance.toolList.empty': undefined
  'performance.toolList.heading': undefined
  'performance.toolList.params': undefined
  'performance.toolList.schemas': undefined
  'performance.toolList.starts': undefined
  'performance.toolList.tip': undefined
  'performance.toolList.tools': undefined
  'performance.tools.calls': undefined
  'performance.tools.chars': undefined
  'performance.tools.detail': undefined
  'performance.tools.empty': undefined
  'performance.tools.errors': undefined
  'performance.tools.heading': undefined
  'performance.tools.perCall': undefined
  'performance.tools.tip': undefined
  'performance.tools.tool': undefined
  'performance.trend.detail': { requests: number; failed: number; cancelled: number; toolCalls: number; chars: number; launches: number; partial: string; duration: string | number }
  'performance.trend.failed': undefined
  'performance.trend.heading': { step: string }
  'performance.trend.label': { step: string }
  'performance.trend.notRecorded': undefined
  'performance.trend.notRecordedLegend': undefined
  'performance.trend.slot': { when: string | number; detail: string | number }
  'performance.trend.succeeded': undefined
  'performance.trend.waits': { waits: number }
  'performance.trend.waitsLegend': undefined
  'performance.unknown': undefined
  'performance.updated': { when: string | number }
  'performance.usage.allUnreadable': undefined
  'performance.usage.cacheRead': undefined
  'performance.usage.cacheWrite': undefined
  'performance.usage.compactions': undefined
  'performance.usage.context': undefined
  'performance.usage.contextAvg': { avg: string | number }
  'performance.usage.contextMax': { max: string | number; hasWindow: string; window: string | number }
  'performance.usage.contextTip': { sessions: number; avg: string | number; max: string | number; hasWindow: string; window: string | number }
  'performance.usage.cost': undefined
  'performance.usage.costFree': { n: number }
  'performance.usage.costUnknown': { n: number }
  'performance.usage.empty': undefined
  'performance.usage.heading': undefined
  'performance.usage.input': undefined
  'performance.usage.notDetected': undefined
  'performance.usage.output': undefined
  'performance.usage.partial': { unreadable: number; hosts: number }
  'performance.usage.reasoning': undefined
  'performance.usage.running': { n: number }
  'performance.usage.sessions': undefined
  'performance.usage.tip': undefined
  'performance.usage.unknownCount': { n: number }
  'performance.view.compare': undefined
  'performance.view.label': undefined
  'performance.view.now': undefined
  'performance.who.agents': undefined
  'performance.who.assistant': undefined
  'performance.who.followsAll': undefined
  'performance.who.followsBox': undefined
  'performance.who.groupLabel': undefined
  'performance.who.label': undefined
  'performance.who.select': undefined
}
