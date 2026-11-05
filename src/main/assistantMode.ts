import { ASSISTANT_AGENT_ID, assistantModeId, modeMessage, modeSummary } from '../shared/assistant'
import { projectAgents } from '../shared/defaults'
import { config } from './config'
import { msg } from '../shared/i18n'
import { combworkError } from './combworkError'
import { createLogger, userText } from './logger'
import { readMode } from './modes'
import { sessions } from './sessions'
import { createDelivery, offerNow, registerSource } from './deliveries'
import { inWorkspace, workspace, workspaceOf } from './workspace'

/**
 * Switching the Combwork Assistant's mode (#259): the workspace keeps the choice (its next launch uses the mode's
 * instructions), and a running Assistant is told at once, without a restart: Hive gives it "[Hive] Mode: …" with the
 * mode's habits, a delivery (#649: a control notice for that launch, deliveries.ts) typed into its conversation, which
 * keeps its context. Offered only while it is idle and the user isn't typing there; otherwise when it next is (only the
 * latest switch is told). Its session stopping drops the message; the conversation records the mode once it is received.
 *
 * Each conversation records the mode it was last given (SessionRecord.mode: the one it started in, or the last one
 * it was told), and a resumed one in another mode, or with none recorded, is told that mode the same way, once (#334): a
 * stop with a message waiting, or a switch while it was stopped, reaches it when it is resumed. The CLI may also keep
 * the system prompt the conversation started with (Claude Code's adapter asks for the current one).
 */

const log = createLogger('assistant')
const AGENT = ASSISTANT_AGENT_ID

/**
 * How many switches each home has had (by key). A message, or a resume's check, made before the latest switch began is
 * stale: dropped after each wait and before it is typed, so an older mode never reaches the conversation after a newer
 * one, even one already typed (#334).
 */
const switches = new Map<string, number>()
const revision = (key: string): number => switches.get(key) ?? 0

/** Combwork's own deliveries come from it. */
const COMBWORK = { kind: 'combwork', name: 'Combwork' } as const // i18n-ignore: the product's name, as a delivery's sender

/**
 * The mode notices' part in their deliveries (#649): offered only while no newer switch has begun since it was made (one
 * made before it is cancelled); received, its conversation records the mode it was given.
 */
registerSource('mode', {
  refresh: async (r, host) => (r.meta?.rev === revision(host.toLowerCase()) ? null : { cancel: 'a newer mode was chosen' }), // i18n-ignore: why a delivery was cancelled, for the log
  holds: (r, host) => r.meta?.rev === revision(host.toLowerCase()),
  received: (r, host) => {
    const modeId = r.meta?.modeId
    if (typeof modeId !== 'string' || !r.forRun) return
    log.info(`Told the Assistant its new mode, ${userText(String(r.meta?.mode ?? modeId))}`)
    sessions.modeGiven(host, AGENT, r.forRun, modeId).catch((e) => log.warn('Could not record the mode the Assistant was told', e))
  }
})

/**
 * Makes a mode (a file in .combwork/modes) this workspace's Assistant's. Returns whether a running Assistant was told now, will be
 * when it is idle, or wasn't running (the mode applies when it starts); 'saved' too for a switch a newer one overtook
 * (the newer one is saved and told, and says so).
 */
export async function switchMode(modeId: string, save = true): Promise<'told' | 'later' | 'saved'> {
  const home = workspace.assistantHome
  const key = home.toLowerCase()
  // Switches count in the order they are made: the latest is the user's choice, however the reads and writes finish.
  const rev = revision(key) + 1
  switches.set(key, rev)
  const current = (): boolean => revision(key) === rev
  const mode = await readMode(modeId)
  if (!mode) throw combworkError(msg({ id: 'content.mode.unknown', defaultMessage: 'There is no mode "{mode}" in this workspace.', description: "An error switching the Combwork Assistant's mode: the workspace has no mode (a file in .combwork/modes) called {mode}." }), { mode: modeId }, { kind: 'notFound' })
  if (!current()) return 'saved'
  // save=false: the choice is already saved (Assistant Settings, which can also choose "the default").
  if (save) {
    let overtaken = false
    await workspace.mutateProjectConfig(home, (cfg) => {
      // Checked inside the file's lock: a switch waiting for it never writes over a newer one's choice.
      if (!current()) {
        overtaken = true
        return {}
      }
      const agents = projectAgents(cfg)
      if (!agents.some((a) => a.id === AGENT)) throw combworkError(msg({ id: 'content.mode.noAssistant', defaultMessage: 'The Assistant has no settings in this workspace.', description: "An error switching the Combwork Assistant's mode: the workspace's Assistant settings are missing." }))
      return { agents: agents.map((a) => (a.id === AGENT ? { ...a, mode: modeId } : a)) }
    })
    if (overtaken) return 'saved'
  }
  const live = sessions.liveFor(home, AGENT)
  if (!live) return 'saved'
  if (!current()) return 'saved'
  return (await tell({ home, runId: live.runId, text: modeMessage(mode.name, modeSummary(mode)), mode: mode.name, modeId: mode.id, rev })) ? 'told' : 'later'
}

/** A conversation resumed in the mode `modeId`: told it once it is idle, unless that is the mode it was last given. */
async function resumed(home: string, runId: string, sessionId: string, modeId: string): Promise<void> {
  const key = home.toLowerCase()
  const rev = revision(key)
  const ws = workspaceOf(home)
  const record = (await ws.sessionsFile(home)).sessions.find((s) => s.id === sessionId)
  if (record?.mode === modeId) return
  // The mode chosen now: one chosen since its launch read it is told by that switch.
  const agent = (await ws.projectConfig(home)).agents?.find((a) => a.id === AGENT)
  const mode = await inWorkspace(ws, () => readMode(modeId))
  // Stopped meanwhile, or a switch since (the newer message): nothing to add.
  if (!mode || !agent || assistantModeId(agent, config.settings) !== modeId || revision(key) !== rev) return
  if (sessions.liveFor(home, AGENT)?.runId !== runId) return
  log.info(`The resumed Assistant was last given ${record?.mode ? userText(record.mode) : 'no recorded mode'}: it will be told ${userText(mode.name)}`)
  await tell({ home, runId, text: modeMessage(mode.name, modeSummary(mode)), mode: mode.name, modeId: mode.id, rev })
}

/**
 * Gives a running Assistant a mode message for its launch `runId`: a delivery (one per home, the newest made again from a
 * newer switch), offered now if it is idle and the user isn't typing there, else when it next is. True once it is typed.
 */
async function tell(w: { home: string; runId: string; text: string; mode: string; modeId: string; rev: number }): Promise<boolean> {
  const key = w.home.toLowerCase()
  // Stopped or restarted since (the launch it has, or will have, is in the mode already), or a newer switch began.
  if (sessions.liveFor(w.home, AGENT)?.runId !== w.runId || w.rev !== revision(key)) return false
  await createDelivery(w.home, { agentId: AGENT, kind: 'control', from: COMBWORK, body: w.text, source: 'mode', ref: 'mode', replace: true, forRun: w.runId, meta: { rev: w.rev, modeId: w.modeId, mode: w.mode } })
  const typed = await offerNow(w.home, AGENT)
  if (!typed) log.info('The Assistant will be told its mode when it is free')
  return typed
}

let started = false

/** Tells a resumed Assistant its mode (the delivery service offers what waits when it is next idle). */
export function initAssistantModes(): void {
  if (started) return
  started = true
  sessions.onAssistantResumed = (home, runId, sessionId, modeId) => {
    resumed(home, runId, sessionId, modeId).catch((e) => log.warn('Could not check the mode of the resumed Assistant', e))
  }
}
