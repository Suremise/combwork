import { randomBytes, randomUUID } from 'crypto'
import { constants, existsSync } from 'original-fs'
import { copyFile, link, mkdir, readFile, readdir, rename, stat, unlink } from 'original-fs/promises'
import { join, resolve } from 'path'
import { HIVE_DIR } from '../shared/defaults'
import { isTemplateFile, TEMPLATE_VERSION } from '../shared/templates'
import { msg, tr } from '../shared/i18n'
import { boardValue, boardWrite, setBoardValue, upgradeWaiting } from './boardStore'
import { createLogger, userText } from './logger'
import { withTemplatesLock } from './templates'
import type { WorkspaceService } from './workspace'

/**
 * 0.9's agent templates at the upgrade to 1.0 (#1436; Darren's 19 Oct decision on #1123: "existing templates are wiped",
 * a clean cut-over). 1.0 never reads them (`readTemplate` refuses a version 1), so the user's saved ones, the workspace's
 * and each project's, are **moved into the 0.9 board backup's folder** (`.hive/backups/templates-0.9`, beside the copy
 * of hive.db the upgrade keeps, OP-37) rather than deleted: Help → Restore the 0.9 Board Backup… puts them back where
 * they were for 0.9.3 (`putBackV09Templates`). Hive's own templates take their place. One quiet notice says so.
 *
 * **A move never touches a file it doesn't own** (#1436 rounds 2–3), whatever another Hive or a save does meanwhile:
 * 1. *Claim*: the template is renamed, in its own folder, to a name only this move uses
 *    (`pair.json.v09-<run>-<target>`, the name it is to have in the backup at its end; its `.bak` likewise with the same
 *    run). A rename to a name nobody else writes never replaces a file, and from then on a save to `pair.json` makes a
 *    new file there, never this one. The claimed file is read again: one that isn't 0.9's (a save landed between the
 *    look and the claim) is given back where it was, never moved.
 * 2. *Publish*: a hard link at the target in the backup (refused when anything is there, in any process; a copy that
 *    won't overwrite where links can't be made). A target taken meanwhile: another is chosen, and the claims (this
 *    run's own names) renamed to say it.
 * 3. *Finish*: the claim is unlinked: its name is this move's alone.
 *
 * Every step leaves a state the next run finishes from the names alone: a claim in a templates folder is an unfinished
 * move; the file at its target being the same file (its identity, not its name) means it was published, so only the
 * claim goes (never a second copy). Runs, cut short or failing (a folder or file that can't be read, other than gone),
 * leave no mark; the mark (board_meta `templates.v09`) is written once a run finds nothing 0.9's and no claim left in
 * any folder. Once per workspace after its upgrade, at each open until done. Each folder's run holds the templates'
 * lock in this process, so no save of this Hive runs meanwhile. A file whose version isn't 0.9's stays where it is.
 */

const log = createLogger('templates')

/** board_meta's mark: how many files this Hive set aside (`0`: none), once every one is done. */
const MARK = 'templates.v09'
/** board_meta's notice to say once in the window: `due`, then `said`. */
const NOTICE = 'templates.v09.notice'
/** The folder in `.hive/backups` the files go to: `workspace`, and `projects/<project id>` (ids follow a rename, #508). */
export const V09_TEMPLATES = 'templates-0.9'

/** A claimed file: its name before, the run that claimed it, and the name it is to have in the backup. */
const CLAIM = /^(.+?\.json(?:\.bak)?)\.v09-([0-9a-f]{12})-(.+)$/

/** Seams for unit tests: a failure where a run reads or moves, and moments between the steps of a move. */
export const testHooks: {
  fail?: (op: 'scan' | 'read' | 'claim' | 'link' | 'unlink', path: string) => void
  beforeClaim?: (src: string) => Promise<void>
  afterClaim?: (src: string) => Promise<void>
  beforeLink?: (dest: string) => Promise<void>
} = {}

const backupDir = (workspacePath: string): string => join(workspacePath, HIVE_DIR, 'backups', V09_TEMPLATES)
const code = (e: unknown): string | undefined => (e as NodeJS.ErrnoException)?.code

/** The template folders to look in, each with where its files go in the backup: the workspace's and each project's. */
async function places(ws: WorkspaceService, workspacePath: string): Promise<{ from: string; to: string }[]> {
  const dir = backupDir(workspacePath)
  const out = [{ from: join(workspacePath, HIVE_DIR, 'templates'), to: join(dir, 'workspace') }]
  const ids = await ws.projectIds()
  for (const p of await ws.listProjectPaths()) {
    const id = ids.byPath.get(resolve(p).toLowerCase())
    if (id) out.push({ from: join(p, HIVE_DIR, 'templates'), to: join(dir, 'projects', id) })
  }
  return out
}

/** A folder's files; none when it isn't there. Any other failure throws (the run stops, unmarked, to go on later). */
async function filesIn(dir: string): Promise<string[]> {
  testHooks.fail?.('scan', dir)
  try {
    return await readdir(dir)
  } catch (e) {
    if (code(e) === 'ENOENT') return []
    throw e
  }
}

/** Whether a file is 0.9's template: JSON whose version is a whole number under 1.0's. Gone: no. Unreadable: throws. */
async function from09(file: string): Promise<boolean> {
  testHooks.fail?.('read', file)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (e) {
    if (code(e) === 'ENOENT') return false
    throw e
  }
  try {
    const raw = JSON.parse(text.replace(/^﻿/, '')) as { version?: unknown }
    return typeof raw?.version === 'number' && Number.isInteger(raw.version) && raw.version >= 1 && raw.version < TEMPLATE_VERSION
  } catch {
    return false
  }
}

/** Whether two paths are one file (its identity on the volume, never its name or bytes); false when either is gone. */
async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const [x, y] = await Promise.all([stat(a, { bigint: true }), stat(b, { bigint: true })])
    return x.ino === y.ino && x.dev === y.dev && x.ino !== 0n
  } catch (e) {
    if (code(e) === 'ENOENT') return false
    throw e
  }
}

/** Makes `dest` the file at `src` without ever replacing a file at `dest`: `taken` when one is there, `gone` when `src` isn't. */
async function linkNoReplace(src: string, dest: string): Promise<'linked' | 'taken' | 'gone'> {
  testHooks.fail?.('link', src)
  await testHooks.beforeLink?.(dest)
  try {
    await link(src, dest)
    return 'linked'
  } catch (e) {
    if (code(e) === 'EEXIST') return 'taken'
    if (code(e) === 'ENOENT') return 'gone'
    if (code(e) !== 'EXDEV' && code(e) !== 'EPERM' && code(e) !== 'ENOTSUP') throw e
  }
  try {
    await copyFile(src, dest, constants.COPYFILE_EXCL)
    return 'linked'
  } catch (e) {
    if (code(e) === 'EEXIST') return 'taken'
    if (code(e) === 'ENOENT') return 'gone'
    throw e
  }
}

/** Removes a name this move owns (a claim, or a backup copy Restore published): gone already is fine. */
async function unlinkOwn(path: string): Promise<void> {
  testHooks.fail?.('unlink', path)
  await unlink(path).catch((e) => {
    if (code(e) !== 'ENOENT') throw e
  })
}

/** A name in `dir` for `file` that neither it nor its `.bak` has: itself, else numbered ("pair-2.json"). */
function freeName(dir: string, file: string, n = 1): string {
  const name = n === 1 ? file : file.replace(/\.json$/, `-${n}.json`)
  return existsSync(join(dir, name)) || existsSync(join(dir, `${name}.bak`)) ? freeName(dir, file, n + 1) : name
}

/**
 * Claims a 0.9 template and its kept copy for one move (step 1): renamed to this run's names, which carry the target.
 * False when there's nothing to move: gone (another Hive has it), or, read again, not 0.9's after all (given back).
 */
async function claim(from: string, to: string, f: string): Promise<boolean> {
  const run = randomBytes(6).toString('hex')
  const target = freeName(to, f)
  const claimed = join(from, `${f}.v09-${run}-${target}`)
  await testHooks.beforeClaim?.(join(from, f))
  testHooks.fail?.('claim', join(from, f))
  try {
    await rename(join(from, f), claimed)
  } catch (e) {
    if (code(e) === 'ENOENT') return false
    throw e
  }
  await testHooks.afterClaim?.(join(from, f))
  if (!(await from09(claimed))) {
    // A save landed between the look and the claim: it goes back where it was. A newer save there since replaced it,
    // as saves replace each other.
    await linkNoReplace(claimed, join(from, f))
    await unlinkOwn(claimed)
    return false
  }
  await rename(join(from, `${f}.bak`), join(from, `${f}.bak.v09-${run}-${target}.bak`)).catch((e) => {
    if (code(e) !== 'ENOENT') throw e
  })
  return true
}

/**
 * Finishes every move claimed in `from` (steps 2 and 3), this run's and any cut short before, in any process: each
 * template, then its kept copy at its template's target. How many templates moved.
 */
async function finishClaims(from: string, to: string): Promise<number> {
  const claims = (await filesIn(from)).map((n) => ({ n, m: CLAIM.exec(n) })).filter((c): c is { n: string; m: RegExpExecArray } => !!c.m)
  let moved = 0
  for (const c of claims.filter((x) => !x.m[1].endsWith('.bak'))) {
    const run = c.m[2]
    const target = await publish(from, to, c.n, c.m[3], (t) => `${c.m[1]}.v09-${run}-${t}`)
    if (target === null) continue
    moved++
    // Its kept copy (this run's), renamed to follow its template's target if that changed.
    const bak = (await filesIn(from)).find((n) => {
      const m = CLAIM.exec(n)
      return !!m && m[2] === run && m[1].endsWith('.bak')
    })
    if (bak) await publish(from, to, bak, `${target}.bak`, (t) => `${CLAIM.exec(bak)![1]}.v09-${run}-${t}`, `${target}.${run}.bak`)
  }
  // A kept copy whose template is in the backup already (its move finished before this one).
  for (const c of (await filesIn(from)).map((n) => ({ n, m: CLAIM.exec(n) })).filter((x) => x.m?.[1].endsWith('.bak'))) {
    await publish(from, to, c.n, c.m![3], (t) => `${c.m![1]}.v09-${c.m![2]}-${t}`, `${c.m![3].replace(/\.bak$/, '')}.${c.m![2]}.bak`)
  }
  return moved
}

/**
 * Publishes one claimed file at its target in the backup and removes the claim (steps 2 and 3). Its target: as the
 * claim says; when another file has taken it, a free one (`fallback` for a kept copy, which keeps its template's name),
 * the claim renamed to say so before anything is published there. The target's name, or null when the claim was gone.
 */
async function publish(from: string, to: string, claimName: string, target: string, claimFor: (target: string) => string, fallback?: string): Promise<string | null> {
  await mkdir(to, { recursive: true })
  let name = claimName
  let t = target
  for (let tries = 0; tries < 50; tries++) {
    const src = join(from, name)
    // Published already (cut short before its claim went): only the claim goes.
    if (await sameFile(src, join(to, t))) {
      await unlinkOwn(src)
      return t
    }
    if (existsSync(join(to, t))) {
      const next = fallback && t !== fallback ? fallback : freeName(to, t.replace(/\.bak$/, '')) + (t.endsWith('.bak') ? '.bak' : '')
      const renamed = claimFor(next)
      await rename(src, join(from, renamed)).catch((e) => {
        if (code(e) !== 'ENOENT') throw e
      })
      if (!existsSync(join(from, renamed))) return null
      name = renamed
      t = next
      continue
    }
    const r = await linkNoReplace(src, join(to, t))
    if (r === 'gone') return null
    if (r === 'taken') continue
    await unlinkOwn(src)
    return t
  }
  throw new Error(`no free name in the 0.9 templates' backup for ${claimName}`) // i18n-ignore: a failure for the log (tried again at the next open)
}

/**
 * Sets 0.9's templates aside, once the workspace's board is upgraded (see the module's note). How many templates this
 * run moved, or null when there was nothing to do (the upgrade waits, or it was done before). Throws when a folder, file
 * or move fails: nothing is marked, and the next open goes on.
 */
export async function setAsideV09Templates(ws: WorkspaceService): Promise<number | null> {
  const path = ws.path
  if (!path || upgradeWaiting(path) || boardValue(ws, MARK) !== null) return null
  const life = ws.lifetime
  let moved = 0
  for (const { from, to } of await places(ws, path)) {
    const done = await withTemplatesLock(from, async () => {
      // Moves cut short before (this Hive's or another's), first.
      let n = await finishClaims(from, to)
      for (const f of (await filesIn(from)).filter(isTemplateFile)) {
        if (life.aborted) return null
        if (!(await from09(join(from, f)))) continue
        if (await claim(from, to, f)) n += await finishClaims(from, to)
      }
      // A 0.9 kept copy whose template a move took before it could claim it too (one cut short): it follows.
      for (const bak of (await filesIn(from)).filter((x) => x.endsWith('.json.bak') && isTemplateFile(x.slice(0, -4)) && !existsSync(join(from, x.slice(0, -4))))) {
        const f = bak.slice(0, -4)
        if (!(await from09(join(from, bak)))) continue
        const run = randomBytes(6).toString('hex')
        const target = existsSync(join(to, f)) && !existsSync(join(to, bak)) ? bak : `${freeName(to, f)}.bak`
        await rename(join(from, bak), join(from, `${bak}.v09-${run}-${target}`)).catch((e) => {
          if (code(e) !== 'ENOENT') throw e
        })
        await finishClaims(from, to)
      }
      // Done here only with nothing claimed left over.
      if ((await filesIn(from)).some((x) => CLAIM.test(x))) throw new Error(`moves left unfinished in ${from}`) // i18n-ignore: a failure for the log (tried again at the next open)
      return n
    })
    if (done === null) return null
    moved += done
  }
  await boardWrite(ws, async () => {
    if (life.aborted || ws.path !== path) return
    setBoardValue(ws, MARK, String(moved))
    if (moved) setBoardValue(ws, NOTICE, 'due')
  })
  if (moved) log.info(`set aside ${moved} template file(s) from 0.9 in ${userText(path)} (${V09_TEMPLATES} in the backups)`)
  return moved
}

/** Says once, quietly, that 0.9's templates were set aside (in the workspace's window). */
export async function sayV09TemplatesOnce(ws: WorkspaceService): Promise<void> {
  const path = ws.path
  const life = ws.lifetime
  if (!path || upgradeWaiting(path) || boardValue(ws, NOTICE) !== 'due') return
  const n = (await setAsideFiles(path)).filter((f) => isTemplateFile(f.split('/').pop())).length
  const title = tr(msg({ id: 'service.templates.v09Title', defaultMessage: 'Your 0.9 agent templates were set aside', description: "A quiet notice's title, once after the upgrade to Hive 1.0: the agent templates saved in 0.9 were moved out of the way (into the 0.9 backup)." }))
  const message = tr(msg({ id: 'service.templates.v09', defaultMessage: "1.0 templates don't pin agents to worktrees. The Hive templates replace them; {n, plural, one {the file is} other {the # files are}} kept with the 0.9 board backup.", description: "A quiet notice once after the upgrade to Hive 1.0: the {n} agent template files saved in 0.9 were moved into the folder of the board's 0.9 backup (Help → Restore the 0.9 Board Backup puts them back). \"The Hive templates\" are Hive's own templates (the Templates view's Hive group)." }), { n })
  ws.emit({ type: 'toast', toast: { id: randomUUID(), level: 'info', title, message, timestamp: new Date().toISOString(), quiet: true } })
  void boardWrite(ws, async () => {
    if (!life.aborted && ws.path === path) setBoardValue(ws, NOTICE, 'said')
  }).catch((e) => log.warn('noting the 0.9 templates notice as said', e))
}

/**
 * Help → Restore the 0.9 Board Backup… (#1436): the templates set aside go back where they were, each published by a
 * link that never replaces a file (a template saved there since, in any process, stays, and so does its 0.9 namesake in
 * the backup), then its backup name removed (the backup is written by these moves alone). A Restore cut short between
 * the two is finished by the next: the same file at both names. How many went back. Under the templates' lock in this
 * process. The restored board has no mark, so the next upgrade sets them aside again.
 */
export async function putBackV09Templates(ws: WorkspaceService): Promise<number> {
  const path = ws.path
  if (!path) return 0
  let back = 0
  for (const { from: home, to: kept } of await places(ws, path)) {
    back += await withTemplatesLock(home, async () => {
      let n = 0
      for (const f of (await filesIn(kept)).filter(isTemplateFile)) {
        await mkdir(home, { recursive: true })
        if (!(await putBack(join(kept, f), join(home, f)))) continue
        n++
        // Its kept copy too, where none is (else it stays in the backup).
        await putBack(join(kept, `${f}.bak`), join(home, `${f}.bak`))
      }
      return n
    })
  }
  if (back) log.info(`put ${back} template file(s) from 0.9 back in ${userText(path)}`)
  return back
}

/** One file of the backup back at `home`, never over another file there; true when it is there now. */
async function putBack(kept: string, home: string): Promise<boolean> {
  if (await sameFile(kept, home)) {
    await unlinkOwn(kept)
    return true
  }
  const r = await linkNoReplace(kept, home)
  if (r !== 'linked') return false
  await unlinkOwn(kept)
  return true
}

/** For the log and tests: the backup folder's files, by place ("workspace", "projects/<id>"). */
export async function setAsideFiles(workspacePath: string): Promise<string[]> {
  const dir = backupDir(workspacePath)
  const out: string[] = []
  for (const f of await readdir(join(dir, 'workspace')).catch(() => [] as string[])) out.push(`workspace/${f}`)
  for (const id of await readdir(join(dir, 'projects')).catch(() => [] as string[])) for (const f of await readdir(join(dir, 'projects', id)).catch(() => [] as string[])) out.push(`projects/${id}/${f}`)
  return out.sort()
}
