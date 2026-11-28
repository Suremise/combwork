// cw_preview, Combwork's side (HI-3616, design HI-3597 s8, s16 §B/§D, s21 §D′; SPEC §16.21.2): an agent starts, reads and
// screenshots its own place's preview, never another's. Its place is where it works: the review copy it holds for a review,
// else the folder its session runs in (a slot, or the project folder). Every answer starts with the stamp: the place, its
// card, the source the server was started from, and whether the place's files changed since.
//
// The agent's page is the preview's own offscreen page (previewGuard.ts agentPage): the same partition, proxy and handlers
// as the tab's view, never the user's view, so an agent's goto never moves the page the user looks at.
//
// Round 1's rules (HR1 on HI-3616):
// - Its place's identity is the generation it resolved (its lease): a start or stop acts only under it, and the place is
//   checked again before each, and before a shot is saved: a lease that ended or passed on meanwhile refuses the call.
// - Each load and capture is one operation (previewCapture.ts runOp): one deadline (cw.preview.captureSeconds) over all of
//   it, the ownership check, the load, the shot, its encoding and its save; the preview's close cancels it and waits for
//   it, so no file is written after its place is given back.
// - The ports' owners are checked before every load and capture, as the tab checks them: a stranger stops the preview.
// - Encoding runs in the page's own process (the DevTools protocol's screenshot, each step of the ladder), never on main's
//   thread, which carries every keystroke.
// - The source is read again at each capture and compared with the source at the page's load and at the server's start.

import type { NativeImage } from 'electron'
import { readFile } from 'original-fs/promises'
import { basename } from 'path'
import { advanced } from './advanced'
import { copiesFor } from './copiesApp'
import { PlaceMoved, placeOf, previewForAgents, shotsDirIn, startPreview } from './previewApp'
import { axText, checkOp, consoleList, encodeLadder, logTail, OpStopped, runOp, saveShot, shotMax, SHOT, type AxNode, type Op } from './previewCapture'
import type { AgentPage, PreviewGuard } from './previewGuard'
import type { PreviewRunner } from './previewRunner'
import { poolIfMade } from './slotsApp'
import { sessions } from './sessions'
import type { WorkspaceService } from './workspace'
import { PREVIEW_CAPTURE_SECONDS } from '../shared/advanced'
import { previewUrl, sameSource, validPreviewPath, type PreviewPlace, type PreviewSource, type PreviewView } from '../shared/preview'
import { PREVIEW_ACTIONS, type AgentPreviewReply, type CaptureNotes, type PreviewAction, type PreviewStamp, type SourceCompared } from '../shared/previewReplies'

/** The agents' page's size: its viewport (within SHOT.viewport). */
const PAGE = { width: 1280, height: 800 }
/** Text limits (s8): a snapshot, the server log's tail. */
const SNAPSHOT_BYTES = 6 * 1024

/** Why a call is refused (the Agent API's status and a code its tool says in its words). */
export type PreviewRefusal = 'notOwnPlace' | 'placeChanged' | 'notRunning' | 'notOwned' | 'badPath' | 'tooLarge' | 'timedOut' | 'badAction'

/** A refused call: its status, its code (the Agent API says it in its words, API.preview) and the code's values. */
export class PreviewRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: PreviewRefusal,
    readonly values: Record<string, string> = {}
  ) {
    super(code)
  }
}

const refuse = (code: PreviewRefusal, status = 400, values: Record<string, string> = {}): never => {
  throw new PreviewRefused(status, code, values)
}

/**
 * The agent's own place: the review copy it holds for a review (not returned), else the folder its session runs in (a
 * slot under its lease, or the project folder).
 */
export async function agentPlace(ws: WorkspaceService, projectPath: string, agentId: string): Promise<PreviewPlace> {
  const copies = await copiesFor(ws, projectPath).catch(() => null)
  const lease = copies?.unfreed().filter((l) => l.agent === agentId && l.kind === 'review' && !l.returned).at(-1)
  const copy = lease ? copies?.copies().find((c) => c.name === lease.copy) : null
  if (copy) return placeOf(ws, projectPath, copy.folder)
  const cwd = sessions.liveFor(projectPath, agentId)?.cwd
  return placeOf(ws, projectPath, cwd || projectPath)
}

/** The card a slot's open lease is for (the stamp's), or null. */
async function cardOf(ws: WorkspaceService, projectPath: string, place: PreviewPlace): Promise<number | null> {
  if (place.kind === 'slot') {
    const pool = poolIfMade(ws, projectPath)
    const l = pool ? (await pool).openLease(place.name) : null
    return l?.card ?? null
  }
  if (place.kind === 'copy') {
    const copies = await copiesFor(ws, projectPath).catch(() => null)
    return copies?.unfreed().find((l) => l.id === place.generation)?.card ?? null
  }
  return null
}

function stampOf(place: PreviewPlace, card: number | null, v: PreviewView | null): PreviewStamp {
  return { place: place.kind === 'project' ? basename(v?.projectPath ?? place.folder) : place.name, kind: place.kind, card, state: v?.state ?? 'none', url: v?.url ?? null, source: v?.source ?? null, changedAt: v?.changedAt ?? null, end: v?.end ?? null }
}

/** A capture's time bound (Settings → Advanced): over the whole operation. */
const captureMs = (): number => Math.max(2, Number(advanced.number(PREVIEW_CAPTURE_SECONDS)) || 10) * 1000

/** A promise's value within `ms`, else null (the source read, never let it time the capture out). */
async function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([p.catch(() => null), new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)))])
  } finally {
    clearTimeout(timer)
  }
}

/** The place's source now, read within half the capture's time (null: it couldn't be read in time, or at all). */
const sourceNow = (runner: PreviewRunner, id: string): Promise<PreviewSource | null> => within(runner.sourceNow(id).then((r) => r?.now ?? null), captureMs() / 2)

let shots = 0

/** The DevTools protocol on the agents' page (attached once). */
async function cdp<T>(page: AgentPage, method: string, params?: Record<string, unknown>): Promise<T> {
  const d = page.win.webContents.debugger
  if (!d.isAttached()) d.attach('1.3')
  return (await d.sendCommand(method, params)) as T
}

/**
 * The preview's ports still its server's (the tab's check before a load), before every load and capture: a stranger stops
 * it, and the call is refused. Checked before the operation begins: the stop it may cause closes the preview's
 * operations, this one's too.
 */
async function owned(runner: PreviewRunner, id: string): Promise<void> {
  const r = await runner.checkOwnership(id)
  if (!r.ok) refuse(r.end.kind === 'stranger' || r.end.kind === 'otherPort' ? 'notOwned' : 'notRunning', 409)
}

/** Loads `url` in the agents' page, the source at the load kept for captures. */
async function load(runner: PreviewRunner, v: PreviewView, page: AgentPage, url: string, fresh: boolean, op: Op): Promise<void> {
  const src = sourceNow(runner, v.id)
  const wc = page.win.webContents
  if (fresh) await wc.session.clearCache().catch(() => undefined)
  checkOp(op)
  await wc.loadURL(url, fresh ? { extraHeaders: 'pragma: no-cache\ncache-control: no-cache\n' } : {}).catch(() => undefined) // i18n-ignore: HTTP headers
  checkOp(op)
  page.loadSource = await src
}

/** Same, changed or can't tell (an unknown source on either side is never "same"). */
const compared = (now: PreviewSource | null, then: PreviewSource | null): SourceCompared => {
  if (!now || !then) return 'unknown'
  const same = sameSource(now, then)
  return same === null ? 'unknown' : same ? 'same' : 'changed'
}

/** What a capture can't promise: the source now against the page's load and the server's start, and changes meanwhile. */
function notesOf(page: AgentPage, v: PreviewView, now: PreviewSource | null, before: string | null, after: string | null): CaptureNotes {
  return {
    loadedAt: page.loadedAt !== null ? new Date(page.loadedAt).toISOString() : null,
    sourceNow: now,
    sinceLoad: compared(now, page.loadSource),
    sinceStart: compared(now, v.source),
    changedAt: after,
    changedDuring: before !== after
  }
}

/**
 * A frame drawn now, at `height` when given: asked for, its paint awaited (an offscreen page draws only when something
 * changes; a capture of a size it hasn't drawn yet fails), at most PAINT_MS.
 */
function painted(page: AgentPage, height?: number): Promise<void> {
  const wc = page.win.webContents
  return new Promise<void>((r) => {
    const t = setTimeout(done, PAINT_MS)
    function done(): void {
      clearTimeout(t)
      wc.off('paint', onPaint)
      r()
    }
    function onPaint(_e: unknown, _dirty: unknown, image: NativeImage): void {
      if (height === undefined || image.getSize().height === height) done()
      else wc.invalidate()
    }
    wc.on('paint', onPaint)
    wc.invalidate()
  })
}
const PAINT_MS = 3000

/**
 * A screenshot of the agents' page, encoded within its limit: its viewport, or its whole page cut at SHOT.full's height
 * (the window's content resized to it, a frame at that size awaited, restored after). Each step of the ladder is the
 * DevTools protocol's screenshot (made and encoded by the page's own process): PNG, or JPEG at its quality, at its scale.
 */
async function screenshot(page: AgentPage, full: boolean, op: Op): Promise<{ encoded: Awaited<ReturnType<typeof encodeLadder>>; width: number; height: number; cutFrom: number | null }> {
  const win = page.win
  const [w0, h0] = win.getContentSize()
  let width = w0
  let height = h0
  let cutFrom: number | null = null
  if (full) {
    const m = await cdp<{ cssContentSize: { width: number; height: number } }>(page, 'Page.getLayoutMetrics')
    checkOp(op)
    const tall = Math.ceil(m.cssContentSize.height)
    width = Math.min(w0, SHOT.full.width)
    height = Math.max(1, Math.min(tall, SHOT.full.height))
    cutFrom = tall > SHOT.full.height ? tall : null
    win.setContentSize(width, height)
  }
  try {
    await painted(page, height)
    checkOp(op)
    const shoot = async (s: { scale: number; quality: number | null }): Promise<Buffer> => {
      const r = await cdp<{ data: string }>(page, 'Page.captureScreenshot', { format: s.quality === null ? 'png' : 'jpeg', ...(s.quality === null ? {} : { quality: s.quality }), clip: { x: 0, y: 0, width, height, scale: s.scale }, fromSurface: true })
      return Buffer.from(r.data, 'base64')
    }
    return { encoded: await encodeLadder(shoot, shotMax(), op), width, height, cutFrom }
  } finally {
    if (full && !win.isDestroyed()) win.setContentSize(w0, h0)
  }
}

/** An agent's call of cw_preview, for its own place only (the route checks it is an agent's, with nothing else named). */
export async function agentPreview(ws: WorkspaceService, projectPath: string, agentId: string, body: Record<string, unknown>): Promise<AgentPreviewReply> {
  const action = body.action as PreviewAction
  if (!PREVIEW_ACTIONS.includes(action)) refuse('badAction', 400, { actions: PREVIEW_ACTIONS.join(', ') })
  // Only its own place: naming a project, place, folder or agent is refused, whatever it names.
  if (['project', 'place', 'folder', 'agent', 'id'].some((k) => body[k] !== undefined)) refuse('notOwnPlace', 403)
  const { runner, guard } = previewForAgents()
  const place = await agentPlace(ws, projectPath, agentId)
  /** Still the agent's place under the same lease: checked again before each act (its lease may have ended meanwhile). */
  const stillMine = async (): Promise<void> => {
    const now = await agentPlace(ws, projectPath, agentId)
    if (now.generation !== place.generation || now.folder.toLowerCase() !== place.folder.toLowerCase()) refuse('placeChanged', 409)
  }
  const card = await cardOf(ws, projectPath, place)
  const viewNow = (): PreviewView | null => {
    const v = runner.at(place.folder)
    return v && v.place.generation === place.generation ? v : null
  }
  if (action === 'start') {
    await stillMine()
    const v = await startPreview(ws, projectPath, place.folder, { generation: place.generation }).catch((e) => (e instanceof PlaceMoved ? refuse('placeChanged', 409) : Promise.reject(e)))
    return { action, stamp: stampOf(place, card, v) }
  }
  if (action === 'stop') {
    await stillMine()
    // Its own preview by its id: never whatever another lease runs in the folder by then.
    const v = viewNow()
    if (v && v.state !== 'stopped') await runner.stop(v.id, { kind: 'stopped' })
    return { action, stamp: stampOf(place, card, viewNow() ?? v) }
  }
  if (action === 'status') {
    const v = viewNow()
    const tail = v?.logPath ? logTail(await readFile(v.logPath, 'utf8').catch(() => '')) : ''
    return { action, stamp: stampOf(place, card, v), log: tail }
  }
  const v = viewNow()
  if (!v || v.state !== 'running') refuse('notRunning', 409)
  const running = v as PreviewView
  const path = typeof body.path === 'string' ? body.path : '/'
  if (action === 'goto' && !validPreviewPath(path)) refuse('badPath', 400)
  // Its ports' owners before every load and capture: a page loaded earlier may now be served by a stranger.
  await owned(runner, running.id)
  try {
    return await runOp(running.id, captureMs(), async (op) => {
      const g = (await guard(running.id).catch(() => refuse('notRunning', 409))) as PreviewGuard
      checkOp(op)
      const page = await g.agentPage(PAGE)
      checkOp(op)
      const before = viewNow()?.changedAt ?? null
      if (action === 'goto' || page.loadedAt === null) await load(runner, running, page, action === 'goto' ? previewUrl(running.port, path) : (running.url ?? previewUrl(running.port, '/')), action === 'goto' && body.fresh === true, op)
      const now = sourceNow(runner, running.id)
      const wc = page.win.webContents
      const notes = async (): Promise<CaptureNotes> => notesOf(page, viewNow() ?? running, await now, before, viewNow()?.changedAt ?? null)
      if (action === 'goto') return { action, stamp: stampOf(place, card, viewNow()), url: wc.getURL(), notes: await notes() }
      if (action === 'snapshot') {
        const ax = await cdp<{ nodes: AxNode[] }>(page, 'Accessibility.getFullAXTree')
        checkOp(op)
        const t = axText(ax.nodes, SNAPSHOT_BYTES)
        return { action, stamp: stampOf(place, card, viewNow()), title: wc.getTitle().slice(0, 200), url: wc.getURL(), tree: t.text, more: t.more, notes: await notes() }
      }
      if (action === 'console') return { action, stamp: stampOf(place, card, viewNow()), entries: consoleList(page.console), total: page.consoleTotal, notes: await notes() }
      // screenshot
      const shot = await screenshot(page, body.full === true, op)
      if (!shot.encoded.ok) refuse('tooLarge', 413)
      const encoded = shot.encoded as Extract<typeof shot.encoded, { ok: true }>
      // Its place still its own, under the same lease, and its preview still this one: never a file in the next holder's.
      await stillMine()
      if (viewNow()?.id !== running.id || viewNow()?.state !== 'running') refuse('notRunning', 409)
      const saved = await saveShot(shotsDirIn(running.place.folder), encoded, ++shots, SHOT.keep, op)
      if (!saved) refuse('tooLarge', 413)
      const n = await notes()
      checkOp(op)
      return { action: 'screenshot', stamp: stampOf(place, card, viewNow()), path: saved!.path, bytes: saved!.bytes, format: encoded.format, quality: encoded.quality, scale: encoded.scale, width: Math.round(shot.width * encoded.scale), height: Math.round(shot.height * encoded.scale), cutFrom: shot.cutFrom, notes: n }
    })
  } catch (e) {
    if (e instanceof OpStopped) refuse(e.why === 'timedOut' ? 'timedOut' : 'notRunning', e.why === 'timedOut' ? 504 : 409)
    throw e
  }
}
