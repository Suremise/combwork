import { app } from 'electron'
import { agentMsg, say } from '../shared/agentText'
import type { DeliveryNeed } from '../shared/deliveries'
import { createLogger, userText } from './logger'
import { folderChanging, folderSteady } from './folderFence'
import { readyFor } from './readiness'
import { sessions } from './sessions'

/**
 * The writer of Hive's lines into an agent's terminal (#649: what the delivery service types with, moved out of
 * watches.ts): one line at a time per agent, only while it can take one (readiness.ts), nobody types there and no line of
 * Hive's waits to be taken; checked before each piece and before Enter; then confirmed taken (#376, #430). It holds
 * sessions' composer reservation (`sendPrompt`'s), which the CLI controls (compaction) take too. The delivery service
 * (deliveries.ts) is its only caller for lines of Hive's own.
 */

// Its log lines are the wakes' as they always were (e2e suites read them).
const log = createLogger('watches')

/** How long a typed line has to be taken (the CLI starts a turn) before Enter is pressed again, once (#376). */
const TAKE_MS = 10_000
/** For unit tests: how long a typed line has to be taken (TAKE_MS). */
export const testHooks: { takeMs?: number } = {}
/** TAKE_MS, or a unit test's, or an unpackaged test build's (CW_TEST_WAKE_TAKE_MS). */
function takeMs(): number {
  const v = !app.isPackaged ? Number(process.env.CW_TEST_WAKE_TAKE_MS) : NaN
  return testHooks.takeMs ?? (Number.isFinite(v) && v >= 0 ? v : TAKE_MS)
}

const agentKey = (projectPath: string, agentId: string): string => `${projectPath.toLowerCase()}#${agentId}`

/**
 * What the writer is doing in the background: the confirmations that a typed line was taken. `settled()` resolves once
 * none is left (watches' and loop wakes' settled() wait for it too, #570).
 */
const inFlight = new Set<Promise<unknown>>()
function inBackground(what: string, work: Promise<unknown>): void {
  const p = work.catch((e) => log.warn(what, e))
  inFlight.add(p)
  void p.finally(() => inFlight.delete(p))
}
export async function settled(): Promise<void> {
  while (inFlight.size) await Promise.allSettled([...inFlight])
}
export const inFlightNow = (): boolean => inFlight.size > 0

/** Agents Hive is typing a line into now (one at a time each). */
const writing = new Set<string>()

/**
 * Told when Hive is done with an agent's line (HI-2191): its typing over, or its check that the CLI took it. Neither
 * changes the agent's status, so what waits on `whyNoLine` for these (a slot's placement) looks again by it.
 */
const freed = new Set<(projectPath: string, agentId: string) => void>()
export function onLineFreed(fn: (projectPath: string, agentId: string) => void): () => void {
  freed.add(fn)
  return () => void freed.delete(fn)
}
function tellFreed(projectPath: string, agentId: string): void {
  for (const fn of [...freed]) {
    try {
      fn(projectPath, agentId)
    } catch (e) {
      log.warn('a line freed: its listener failed', e)
    }
  }
}

/** Whether an agent has a line of Hive's being made that goes first (watches.ts: a fired watch whose line isn't made yet). */
let lineComing: (projectPath: string, agentId: string) => boolean = () => false
export function onLineComing(fn: (projectPath: string, agentId: string) => boolean): void {
  lineComing = fn
}

/** Whether another line of Hive's has an agent now: one being typed, or a watch's being made (#1432: Deliver Now waits for it). */
export const lineBusy = (projectPath: string, agentId: string): boolean => writing.has(agentKey(projectPath, agentId)) || lineComing(projectPath, agentId)

/** Why Hive could not type a line into an agent now (whyNoLine), in the reply of the call that wanted it: said in its caller's dialect. */
const T = {
  notRunning: agentMsg({ id: 'inbox.noLine.notRunning', text: "it isn't running", note: 'Why Combwork could not type a line (a delivery given now, Deliver Now) into an agent, in the reply of the call that wanted it: the agent named.' }),
  typing: agentMsg({ id: 'inbox.noLine.typing', text: 'Combwork is already typing a line into it', note: 'Why Combwork could not type a line into an agent now, in the reply of the call that wanted it.' }),
  hooksMissing: agentMsg({ id: 'inbox.noLine.hooksMissing', text: "its CLI's hooks aren't reaching Combwork, so Combwork can't tell when it is free", note: 'Why Combwork could not type a line into an agent now, in the reply of the call that wanted it.' }),
  inputBlocked: agentMsg({ id: 'inbox.noLine.inputBlocked', text: 'something on its screen is taking its keys, and it waits for the user to answer it there', note: 'Why Combwork could not type a line into an agent now (HI-2191), in the reply of the call that wanted it.' }),
  watching: agentMsg({ id: 'inbox.noLine.watching', text: 'it is waiting on cards, and takes no new work until it is woken', note: 'Why Combwork could not type a line into an agent now: it waits on a watch, in the reply of the call that wanted it.' }),
  status: agentMsg({ id: 'inbox.noLine.status', text: 'it is {status}', note: "Why Combwork could not type a line into an agent now, in the reply of the call that wanted it. status: the agent's status, as Combwork names it (working, starting…)." }),
  userTyping: agentMsg({ id: 'inbox.noLine.userTyping', text: 'the user has just typed in its terminal and may still be writing there', note: 'Why Combwork could not type a line into an agent now, in the reply of the call that wanted it.' }),
  lineWaiting: agentMsg({ id: 'inbox.noLine.lineWaiting', text: "its CLI hasn't taken the line Combwork typed before", note: 'Why Combwork could not type a line into an agent now, in the reply of the call that wanted it.' }),
  cliAsks: agentMsg({ id: 'inbox.noLine.cliAsks', text: 'its CLI shows a question for the user, which a line would answer', note: 'Why Combwork could not type a line into an agent now (HI-1959), in the reply of the call that wanted it.' }),
  launchTask: agentMsg({ id: 'inbox.noLine.launchTask', text: "its CLI hasn't taken its launch's task yet", note: 'Why Combwork could not type a line into an agent now, in the reply of the call that wanted it.' }),
  toolsWaiting: agentMsg({ id: 'inbox.noLine.toolsWaiting', text: "its Combwork tools haven't connected yet", note: 'Why Combwork could not type a line into an agent now (#865), in the reply of the call that wanted it.' }),
  folder: agentMsg({ id: 'inbox.noLine.folder', text: 'its folder is being changed ({what})', note: "Why Combwork could not type a line into an agent now (#646), in the reply of the call that wanted it. what: what is changing the agent's folder (a Git switch or pull)." }),
  wakeFirst: agentMsg({ id: 'inbox.noLine.wakeFirst', text: "a watch's wake goes first", note: "Why Combwork could not type a line into an agent now (#1432): a watch's wake is being made for it, in the reply of the call that wanted it." })
}

/**
 * Whether a line of Hive's could be typed into an agent now (typeLine's own conditions, before it asks what is wanted):
 * it can take one (`need`), nobody types there, no earlier line is waiting there, no line is being typed and none of a
 * watch's is being made. Null when it could; else why not, as the reply of a call that wanted it now says it.
 */
export function whyNoLine(projectPath: string, agentId: string, need: DeliveryNeed = 'idle'): string | null {
  const st = sessions.liveFor(projectPath, agentId)
  if (!st) return say(T.notRunning)
  if (writing.has(agentKey(projectPath, agentId))) return say(T.typing)
  if (st.hooksMissing) return say(T.hooksMissing)
  // Something on its screen takes its keys (HI-2191): it waits for the user to answer it there.
  if (sessions.inputBlocked(projectPath, agentId)) return say(T.inputBlocked)
  if (!readyFor(st, need)) return st.status === 'watching' ? say(T.watching) : say(T.status, { status: st.status })
  if (sessions.userMayBeTyping(projectPath, agentId)) return say(T.userTyping)
  if (sessions.lineWaiting(projectPath, agentId)) return say(T.lineWaiting)
  // Its CLI's own question on its screen (HI-1959), before its status says so: Enter would answer it.
  if (sessions.cliAsks(projectPath, agentId)) return say(T.cliAsks)
  if (sessions.launchTaskWaiting(projectPath, agentId)) return say(T.launchTask)
  // A doorbell before its hive tools have connected is a turn that can't read the inbox (#865: a resumed Claude Code).
  if (sessions.hiveToolsWaiting(projectPath, agentId)) return say(T.toolsWaiting)
  // Its folder being changed under it (#646: a Git switch or pull): no turn of Hive's starts there until that is done.
  const changing = folderChanging(st.cwd)
  if (changing) return say(T.folder, { what: changing })
  if (lineComing(projectPath, agentId)) return say(T.wakeFirst)
  return null
}
export const canTypeLine = (projectPath: string, agentId: string, need: DeliveryNeed = 'idle'): boolean => whyNoLine(projectPath, agentId, need) === null

/**
 * What the delivery service follows of a typed line (#647, #650): `confirming` with the launch and prompt count it was
 * typed at while the confirmation runs, and `settled` once that has ended; `taken` once its CLI took it (not a receipt:
 * the doorbell carries no text), never for a launch that ended first; `lost` when that launch ended (or another began)
 * before its CLI took it; `left` when the user typed into it before its CLI took it (#652 round 1 finding 2), so it is
 * theirs now and never submitted by Hive. What it names doesn't decide whether it may still be submitted (#652): Hive's
 * lines are the doorbell, fixed words and ids, whose Enter again gives nothing that may no longer be given (cw_inbox
 * checks each delivery as it is read), or the user's own task.
 */
export interface LineFollow {
  confirming?: (before: { runId: string; count: number }) => void
  /**
   * Whether what the line rang for has been read since it was typed (#1514): the CLI took it, whether or not a prompt was
   * seen. Codex takes a line typed while a turn runs (its compaction at a turn's start) as queued input, with no
   * UserPromptSubmit: on 23 Oct RR2 read m157 eight seconds after it was typed, and Hive still pressed Enter again and
   * marked the line not taken, which then blocked every prompt until the user pressed Enter on an empty composer.
   */
  read?: () => boolean
  /** The deliveries the line rang for (its doorbell's ids): kept with a mark that it wasn't taken, which only their read clears. */
  ids?: readonly string[]
  settled?: () => void
  taken?: () => void
  lost?: () => void
  left?: () => void
}

/**
 * Types a line of Hive's into an agent: only while it can take one (`need`), nobody types there, no earlier line is
 * waiting there; one at a time per agent; checked to be taken (#376). `wanted` is asked again before every piece and
 * before Enter. Whether it was typed (false: try again later).
 */
export async function typeLine(projectPath: string, agentId: string, line: string, wanted: () => boolean, opts: { follow?: LineFollow; need?: DeliveryNeed } = {}): Promise<boolean> {
  const key = agentKey(projectPath, agentId)
  const need = opts.need ?? 'idle'
  if (!canTypeLine(projectPath, agentId, need) || !wanted()) return false
  writing.add(key)
  try {
    // What the CLI had taken just before this line's Enter (#376): sampled by the writer's last check, after what it
    // carries was saved as offered (#647: a prompt of the user's taken while that save was slow isn't this line's), so a
    // confirmation never takes an earlier prompt for this one.
    let before: { runId: string; count: number } | null = null
    await sessions.sendPrompt(projectPath, agentId, line, () => {
      if (!wanted()) throw new Error('It is no longer wanted.') // i18n-ignore: why a line wasn't typed, for the log
      if (!readyFor(sessions.liveFor(projectPath, agentId), need)) throw new Error('The agent got busy.') // i18n-ignore: why a line wasn't typed, for the log
      if (sessions.userMayBeTyping(projectPath, agentId)) throw new Error('The user is typing there.') // i18n-ignore: why a line wasn't typed, for the log
      if (folderChanging(sessions.liveFor(projectPath, agentId)?.cwd)) throw new Error('Its folder is being changed.') // i18n-ignore: why a line wasn't typed, for the log
      before = sessions.promptsTaken(projectPath, agentId)
    })
    log.info(`Woke ${userText(agentId)}: ${userText(line.slice(0, 80))}`)
    if (before) inBackground('checking a wake was taken', confirmTaken(projectPath, agentId, before, line, opts.follow)) // i18n-ignore: what failed, for the log
    return true
  } catch (e) {
    log.info(`Wake for ${userText(agentId)} put off: ${(e as Error).message}`)
    return false
  } finally {
    writing.delete(key)
    tellFreed(projectPath, agentId)
  }
}

/**
 * Whether a typed line was taken (#376): the CLI started a turn for it (UserPromptSubmit). On 7 Oct a Codex reviewer's
 * wake stayed in its prompt, unsent, for hours, while its watch had ended. Not taken in time, Enter is pressed again,
 * once; still not taken, it is logged, and the agent's cards show as stalled when its loop is checked (loopCheck.ts).
 */
export async function confirmTaken(projectPath: string, agentId: string, before: { runId: string; count: number }, line: string, follow?: LineFollow): Promise<boolean> {
  // Nothing more is typed into it while this runs, however long (#430): released when it ends (taken, or marked).
  const release = sessions.holdForConfirm(projectPath, agentId, before.runId)
  follow?.confirming?.(before)
  confirmsRunning++
  try {
    const r = await confirming(projectPath, agentId, before, line, follow?.read, follow?.ids)
    if (r === 'taken') follow?.taken?.()
    else if (r === 'gone') follow?.lost?.()
    else if (r === 'left') follow?.left?.()
    return r === 'taken' || r === 'gone'
  } finally {
    confirmsRunning--
    follow?.settled?.()
    release?.()
    tellFreed(projectPath, agentId)
  }
}
let confirmsRunning = 0
/** How many typed lines are being checked for being taken now: tests wait for none, after which no Enter comes. */
export const confirmsInFlight = (): number => confirmsRunning

async function confirming(projectPath: string, agentId: string, before: { runId: string; count: number }, line: string, read?: () => boolean, ids: readonly string[] = []): Promise<'taken' | 'gone' | 'left' | false> {
  const t0 = Date.now()
  const taken = (): 'taken' | 'gone' | false => {
    const now = sessions.promptsTaken(projectPath, agentId)
    // Another launch (or none): what was typed has gone with the old one, untaken.
    if (!now || now.runId !== before.runId) return 'gone'
    // Each wake's outcome in the log (#430): typed (Woke …), taken and how soon, Enter again, not taken.
    if (now.count > before.count) log.info(`The wake typed into ${userText(agentId)} was taken after ${Date.now() - t0} ms`)
    // What it rang for read with no prompt seen (#1514: Codex's queued input in a running turn): taken all the same.
    else if (read?.()) log.info(`The wake typed into ${userText(agentId)} was taken after ${Date.now() - t0} ms: what it rang for was read, with no prompt seen`)
    else return false
    return 'taken'
  }
  const waitTaken = async (): Promise<'taken' | 'gone' | false> => {
    const end = Date.now() + takeMs()
    while (Date.now() < end) {
      const t = taken()
      if (t) return t
      await new Promise((r) => setTimeout(r, 250))
    }
    return taken()
  }
  const first = await waitTaken()
  if (first) return first
  // Enter again, once, when that is safe (the same launch, idle, nobody typing there, Hive not typing): waited for a
  // while rather than given up at once (#430). Never a third Enter.
  let retried = false
  for (let end = Date.now() + 6 * takeMs(); ; ) {
    const t = taken()
    if (t) return t
    // Its folder being changed (#646 round 1): no Enter until that is done; the wait doesn't count against the window,
    // so the line is held, not given up.
    const cwd = sessions.liveFor(projectPath, agentId)?.cwd
    if (folderChanging(cwd)) {
      const held = Date.now()
      await folderSteady(cwd)
      end += Date.now() - held
      continue
    }
    // The user has typed into the prompt since Hive's line began (#652 round 1 finding 2: any pause, 0 included): it is
    // their draft, never submitted or cleared by Hive, and nothing more is typed into the agent until a prompt is sent.
    if (sessions.userTypedOverLine(projectPath, agentId)) {
      sessions.leaveToUser(projectPath, agentId, before.runId)
      log.info(`Left the line typed into ${userText(agentId)} to the user, who has typed there since`)
      return 'left'
    }
    if (sessions.submitAgain(projectPath, agentId, before.runId)) {
      retried = true
      break
    }
    if (Date.now() >= end) break
    await new Promise((r) => setTimeout(r, 250))
  }
  if (retried) {
    log.warn(`The wake typed into ${userText(agentId)} wasn't taken: pressed Enter again`)
    const again = await waitTaken()
    if (again) return again
    log.warn(`The wake typed into ${userText(agentId)} still wasn't taken: it may be waiting in its prompt`)
  } else log.warn(`The wake typed into ${userText(agentId)} wasn't taken, and Enter couldn't be pressed again (busy, or the user typing there)`)
  // Shown in its pane, the user told once, and nothing more typed into it until it is taken (#430).
  sessions.lineNotTaken(projectPath, agentId, before.runId, line, retried, ids)
  return false
}
