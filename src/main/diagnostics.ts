import { app, screen } from 'electron'
import { legacyWorktree } from './agentFolders'
import { existsSync } from 'original-fs'
import { open, readdir } from 'original-fs/promises'
import { homedir, release, version as osVersion } from 'os'
import { basename, join } from 'path'
import { redact, redactLog, type RedactContext } from '../shared/redact'
import { providerName } from '../shared/providers'
import { testedComparison } from '../shared/testedClis'
import type { AgentInstallInfo, ProviderId } from '../shared/types'
import { config } from './config'
import { logsDir } from './logger'
import { provider } from './providers'
import { providerService } from './providerService'
import { gitTool } from './gitTool'
import { hiveWindows } from './windows'
import { GUIDANCE_REVISION } from './guidance'
import { hiveSkills } from './skills'
import { inWorkspace } from './workspace'
import { trackingLost, trackingProblem } from './agentProcesses'
import { diagnosticRecording } from '../shared/consoleFixtures.mts'
import { latestRecording, readRecordingText } from './consoleRecorder'
import { advanced } from './advanced'
import { gpuDiagnostics, gpuThisRun } from './gpu'
import { crashDumpLines, crashDumps, crashDumpsDir } from './exitLog'
import { lastRunDiagnostics } from './lastRun'
import { memoryDiagnostics } from './memory'
import { workerThreadLines } from './workerThreads'
import { queryMetrics } from './metrics'
import { toolListRows, type ToolListRow } from '../shared/metricsView'

/** How much of Hive's log a report carries. */
const LOG_LINES = 50

/** The end of Hive's log (64 KB, whole lines). */
async function logTail(): Promise<string[]> {
  const file = join(logsDir(), 'hive.log')
  if (!existsSync(file)) return []
  const f = await open(file, 'r')
  try {
    const { size } = await f.stat()
    const length = Math.min(size, 64 * 1024)
    const buf = Buffer.alloc(length)
    await f.read(buf, 0, length, size - length)
    const lines = buf.toString('utf8').split(/\r?\n/)
    return (length < size ? lines.slice(1) : lines).filter(Boolean)
  } finally {
    await f.close()
  }
}

/** Workspaces opened before (Hive's recent list) and their project folders: the log names them too. */
async function earlierWork(): Promise<{ folders: string[]; names: string[] }> {
  const folders = config.get().recentWorkspaces
  const names: string[] = []
  for (const f of folders) {
    names.push(basename(f))
    const entries = await readdir(f, { withFileTypes: true }).catch(() => [])
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) names.push(e.name)
  }
  return { folders, names }
}

/**
 * A workspace's hive tool list a start in the last 24 hours (HI-2063), per role and workflow role, as one line: counts
 * only, never a name. A size Hive didn't measure (a bridge from before it did) is said, never shown as zero.
 */
export function toolListLine(label: string, rows: ToolListRow[]): string {
  const n = (v: number): string => Math.round(v).toLocaleString('en')
  // i18n-ignore: Copy Diagnostics' report: a bug report for the maintainer, in English (the design keeps diagnostics content English)
  if (!rows.length) return `- ${label} hive tool list (24 h): none recorded`
  const row = (r: ToolListRow): string => {
    const parts = r.descriptionChars === null || r.paramChars === null || r.schemaChars === null ? 'parts not measured' : `descriptions ${n(r.descriptionChars)}, parameters ${n(r.paramChars)}, schemas ${n(r.schemaChars)}` // i18n-ignore: Copy Diagnostics' report: a bug report for the maintainer, in English (the design keeps diagnostics content English)
    const chars = r.chars === null ? 'characters not measured' : `${n(r.chars)} chars a start (${parts})` // i18n-ignore: Copy Diagnostics' report: a bug report for the maintainer, in English (the design keeps diagnostics content English)
    return `${r.role === 'assistant' ? 'assistant' : 'agents'} · ${r.workflow}: ${n(r.tools)} tools, ${chars}, ${n(r.bytes)} bytes, ${r.starts} start${r.starts === 1 ? '' : 's'}` // i18n-ignore: Copy Diagnostics' report: a bug report for the maintainer, in English (the design keeps diagnostics content English)
  }
  return `- ${label} hive tool list (24 h): ${rows.map(row).join('; ')}` // i18n-ignore: Copy Diagnostics' report: a bug report for the maintainer, in English (the design keeps diagnostics content English)
}

/** The tool list lines of each open workspace (its metrics' last 24 hours; one that can't be read says so). */
function toolListLines(windows: ReturnType<typeof hiveWindows>): string[] {
  // Numbered as the skills' lines number them: the windows with a workspace open.
  return windows.filter((w) => !!w.ws.path).map((w, i) => {
    const label = `Workspace ${i + 1}` // i18n-ignore: Copy Diagnostics' report: a bug report for the maintainer, in English (the design keeps diagnostics content English)
    try {
      const r = queryMetrics(w.ws, { scope: { kind: 'workspace' } })
      return toolListLine(label, toolListRows([...Object.values(r.projects), ...(r.workspace ? [r.workspace] : [])].flatMap((p) => p.catalog)))
    } catch {
      return `- ${label} hive tool list (24 h): couldn't be read` // i18n-ignore: Copy Diagnostics' report: a bug report for the maintainer, in English (the design keeps diagnostics content English)
    }
  })
}

const yesNo = (v: boolean | null | undefined): string => (v === true ? 'yes' : v === false ? 'no' : 'unknown')

/**
 * Help → Copy Diagnostics: versions, each coding agent's state, counts, the settings that change how Hive
 * behaves and the end of its log, as Markdown for a bug report. Redacted (shared/redact.ts): no folder,
 * workspace, project or agent names, prompts or secrets. `recording`: the newest developer console recording's newest
 * events too (#638), only a redacted one, redacted again like the log.
 */
export async function diagnostics(opts: { recording?: boolean } = {}): Promise<string> {
  const s = config.settings
  const windows = hiveWindows()
  const workspaces = windows.map((w) => w.ws.info()).filter((w) => !!w)
  const projects = workspaces.flatMap((w) => w.projects)
  const agents = projects.flatMap((p) => p.agents)
  const assistants = workspaces.map((w) => w.assistant).filter((a) => !!a)
  const display = screen.getPrimaryDisplay()

  const providers = providerService.all()
  const providerLines = (Object.entries(providers) as [ProviderId, AgentInstallInfo][]).flatMap(([id, info]) => {
    const set = s.providers[id]
    const head = `- **${providerName(id)}**: ${set?.enabled ? 'on' : 'off'}; ${info.found ? `${info.version ?? 'version unknown'} at \`${info.path ?? '?'}\`${info.source ? ` (${info.source})` : ''}` : 'not found'}; signed in: ${yesNo(info.loggedIn)}${info.updateAvailable && info.latestVersion ? `; ${info.latestVersion} available` : ''}` // i18n-ignore: Copy Diagnostics' report: a bug report for the maintainer, in English (the design keeps diagnostics content English)
    const extra = [
      // The version this release was tested with (#365): what a bug report about the CLI needs first.
      ...(info.tested ? [`  - this Hive release was tested with ${info.tested.version}${info.tested.testedAt ? ` (${info.tested.testedAt})` : ''}; installed: ${info.found ? testedComparison(info.tested) : 'not found'}`] : ['  - no tested version recorded for this Hive release']), // i18n-ignore: Copy Diagnostics' report: a bug report for the maintainer, in English (the design keeps diagnostics content English)
      ...(set?.executablePath ? ['  - its path is set in Settings'] : []), // i18n-ignore: Copy Diagnostics' report: a bug report for the maintainer, in English (the design keeps diagnostics content English)
      ...(set?.extraArgs ? ['  - extra arguments are set'] : []), // i18n-ignore: Copy Diagnostics' report: a bug report for the maintainer, in English (the design keeps diagnostics content English)
      ...(info.editorExtensionOnly ? ["  - only an editor extension's copy was found"] : []), // i18n-ignore: Copy Diagnostics' report: a bug report for the maintainer, in English (the design keeps diagnostics content English)
      ...(provider(id).diagnostics?.() ?? []).map((l) => `  - ${l}`),
      ...(info.readiness ?? []).map((r) => `  - ${r.level}: ${r.message}`)
    ]
    return [head, ...extra]
  })
  const g = gitTool()
  providerLines.push(`- **Git**: ${g.state === 'missing' ? "not found on Hive's PATH" : g.version ? `${g.version}${g.path ? ` at \`${g.path}\`` : ''}${g.state === 'old' ? ' (older than Hive needs)' : ''}` : `unknown${g.error ? ` (${g.error})` : ''}`}`) // i18n-ignore: Copy Diagnostics' report: a bug report for the maintainer, in English (the design keeps diagnostics content English)

  // Bundled skills: Hive's own names, so they are shown; the user's own skills only as a count.
  const skillLines: string[] = []
  for (const w of windows) {
    if (!w.ws.path) continue
    const list = await inWorkspace(w.ws, () => hiveSkills(true)).catch(() => [])
    const mark = (x: (typeof list)[number]): string => `${x.name} ${x.bundled}${x.updateAvailable ? ' (update available)' : ''}` // i18n-ignore: Copy Diagnostics' report: a bug report for the maintainer, in English (the design keeps diagnostics content English)
    skillLines.push(`- Workspace ${skillLines.length + 1}: ${list.filter((x) => x.bundled).map(mark).join(', ') || 'no bundled skills'}; ${list.filter((x) => !x.bundled).length} of its own`) // i18n-ignore: Copy Diagnostics' report: a bug report for the maintainer, in English (the design keeps diagnostics content English)
  }
  const running = agents.flatMap((a) => (a.live ? [a.live] : []))
  const older = running.filter((l) => l.launched && l.launched.guidance !== GUIDANCE_REVISION).length
  // Agents on a dialect (HI-2443): how many, and on how many chains; never the files' names (the user's own labels).
  const onDialect = running.flatMap((l) => (l.launched?.dialect?.hash ? [l.launched.dialect.hash] : []))
  const dialectLine = onDialect.length ? [`- Dialects: ${onDialect.length} running agent${onDialect.length === 1 ? '' : 's'} on ${new Set(onDialect).size} chain${new Set(onDialect).size === 1 ? '' : 's'} other than the Default`] : [] // i18n-ignore: Copy Diagnostics' report: a bug report for the maintainer, in English (the design keeps diagnostics content English)

  const header = [
    '## Hive diagnostics',
    '',
    `- **Hive** ${app.getVersion()} (${app.isPackaged ? 'installed' : 'development build'}); updates: ${s.updates.prerelease ? 'beta' : 'stable'} channel, check ${s.updates.checkAutomatically ? 'automatically' : 'manually'}, install ${s.updates.install}`,
    `- **Electron** ${process.versions.electron}, Chromium ${process.versions.chrome}, Node ${process.versions.node}`,
    `- **Windows**: ${osVersion()} ${release()} (${process.arch}); display scaling ${Math.round(display.scaleFactor * 100)}%; locale ${app.getLocale()}`,
    gpuDiagnostics(gpuThisRun(), app.getGPUFeatureStatus() as unknown as Record<string, string>),
    '',
    '### Coding agents',
    '',
    ...providerLines,
    '',
    '### Counts',
    '',
    `- Windows: ${windows.length}; projects: ${projects.filter((p) => p.active).length} active of ${projects.length}`,
    `- Agents: ${agents.length}, ${agents.filter((a) => a.live).length} running, ${agents.filter((a) => a.live?.slot).length} in slots`,
    `- Hive Assistant: ${assistants.some((a) => a.agents.some((x) => x.live)) ? 'running' : 'not running'}`,
    '',
    '### Guidance',
    '',
    `- Revision ${GUIDANCE_REVISION}${older ? `; ${older} running agent${older === 1 ? '' : 's'} launched with an older one` : ''}`,
    ...dialectLine,
    ...skillLines,
    ...toolListLines(windows),
    '',
    '### Settings',
    '',
    `- Background task limit: ${s.agents.backgroundTaskMinutes} min; leftover processes: ${s.agents.leftoverProcesses}`,
    `- Agents' processes: ${process.platform !== 'win32' ? 'not tracked (Windows only)' : trackingProblem() ? `not tracked: ${trackingProblem()}` : 'tracked'}${trackingLost() ? `; earlier, ${trackingLost()}` : ''}`,
    `- Confirm before quitting: ${s.general.confirmOnQuit}; close to tray: ${s.general.closeToTray ? 'on' : 'off'}; minimise to tray: ${s.general.minimizeToTray ? 'on' : 'off'}; keep the PC awake: ${s.general.keepAwake}`,
    `- Transcript backups: ${s.sessions.backupTranscripts ? 'on' : 'off'}; cache TTL: ${s.sessions.cacheTtl}; Overview refresh: ${s.sessions.overviewRefresh}`,
    `- Agent API: ${s.agentApi.enabled ? 'on' : 'off'}; built-in hive MCP server: ${s.agentApi.provideHiveMcp ? 'on' : 'off'}; session input: ${s.agentApi.allowSessionInput ? 'allowed' : 'off'}`,
    `- Assistant control: ${typeof s.assistant.control === 'string' ? s.assistant.control : 'custom'}`,
    `- Notifications: ${s.notifications.desktopNotifications ? 'on' : 'off'}; pop-ups about agents for ${{ all: 'all workspaces', workspace: 'this workspace', project: 'this project', none: 'none (bell only)' }[s.notifications.bannerScope]}; pop-ups ${s.notifications.bannerPosition}, ${s.notifications.bannerSeconds} s; waiting pop-ups ${s.notifications.waitingBannerStays ? 'stay' : 'close too'}; chime ${s.notifications.chimeEnabled ? 'on' : 'off'}`, // i18n-ignore: Copy Diagnostics' report: a bug report for the maintainer, in English (the design keeps diagnostics content English)
    `- Theme: ${s.appearance.theme}`,
    // Overrides of Hive's defaults (#367): how many and which, by Hive's names; never their values.
    ...advanced.diagnostics(windows.map((w) => (w.ws.path ? (w.ws.config.advanced ?? null) : null))),
    '',
    // Crashes Hive kept a dump of (#985): named, never attached.
    '### Crash dumps',
    '',
    ...crashDumpLines(crashDumps(), join(crashDumpsDir(), 'reports')),
    // The last run (#984): whether it quit, or ended without quitting.
    lastRunDiagnostics(),
    '',
    // The main process's memory (#1005): now, and the last lines logged, which the log's tail may not reach.
    '### Memory',
    '',
    ...memoryDiagnostics(app.getPath('userData')),
    '',
    // How each worker thread runs (HI-1880): an installed Hive ran their work on main's thread, unseen.
    '### Worker threads',
    '',
    ...workerThreadLines()
  ].join('\n')

  // The log goes back further than what is open now: earlier workspaces and their projects are taken out too.
  // Hive marks the user's own text as it logs it (logger.ts userText()); this catches older lines and the rest.
  const earlier = await earlierWork()
  const ctx: RedactContext = {
    home: homedir(),
    app: app.isPackaged ? undefined : app.getAppPath(),
    // Where agents work (#1451): their running sessions' folders (a slot, a retired home), and a 0.9 worktree not migrated yet.
    folders: [...workspaces.map((w) => w.path), ...agents.flatMap((a) => [...(a.live?.cwd ? [a.live.cwd] : []), ...(legacyWorktree(a) ? [legacyWorktree(a)!.path] : [])]), ...earlier.folders],
    names: [
      ...workspaces.map((w) => ({ name: w.name, as: '<workspace>' })),
      ...projects.map((p) => ({ name: p.name, as: '<project>' })),
      ...agents.flatMap((a) => [{ name: a.name, as: '<agent>' }, { name: a.id, as: '<agent>' }, ...(legacyWorktree(a) ? [{ name: legacyWorktree(a)!.branch, as: '<branch>' }] : [])]),
      ...earlier.names.map((name) => ({ name, as: '<name>' }))
    ]
  }
  // Names are only taken out of the log: the summary above has none, and a project called "Hive" would take Hive's own name with it.
  // The whole tail is redacted first: which run of Hive a line is from depends on the start lines before it.
  const log = redactLog((await logTail()).join('\n'), ctx).split('\n').slice(-LOG_LINES).join('\n')
  return `${redact(header, { ...ctx, names: [] })}\n\n### Log (last ${LOG_LINES} lines)\n\n\`\`\`\n${log}\n\`\`\`\n${opts.recording ? await recordingSection(ctx) : ''}` // i18n-ignore: Copy Diagnostics' report: a bug report for the maintainer, in English (the design keeps diagnostics content English)
}

/** The newest developer console recording, if it is redacted: a line about it and its newest events, redacted again. */
async function recordingSection(ctx: RedactContext): Promise<string> {
  const latest = await latestRecording()
  if (!latest) return '\n### Developer console recording\n\nNone.\n' // i18n-ignore: Copy Diagnostics' report: a bug report for the maintainer, in English (the design keeps diagnostics content English)
  if (latest.includeText) return '\n### Developer console recording\n\nThe newest recording includes prompt and reply text, so it is not attached.\n' // i18n-ignore: Copy Diagnostics' report: a bug report for the maintainer, in English (the design keeps diagnostics content English)
  const part = diagnosticRecording(await readRecordingText(latest.file), (s) => redact(s, ctx))
  if (!part) return ''
  return `\n### Developer console recording\n\n${part.summary}\n\n\`\`\`jsonl\n${part.lines.join('\n')}\n\`\`\`\n` // i18n-ignore: Copy Diagnostics' report: a bug report for the maintainer, in English (the design keeps diagnostics content English)
}
