import { readdir, readFile } from 'original-fs/promises'
import { join, resolve } from 'path'
import { CW_DIR } from '../shared/defaults'
import { isTemplateFile } from '../shared/templates'
import { withFileLock, writeKeptJson } from './fsutil'
import { createLogger, userText } from './logger'
import { ifAbsent } from './nameUpgradeFiles'
import { OLD_ID, NEW_ID, upgradedAdvancedIds, upgradedOptions } from './storedNames'

/**
 * The names upgrade's stored values in the settings files a workspace and its projects keep (HI-2598, its design
 * HI-2598/s9 §4): the workflow options' old values (`finish: 'hiveMerges'`, `commitMessage: 'hive'`) in project.json
 * (its options and each kept platform's), in workspace.json's defaults and in every template's sections; workspace.json's
 * command refs to Hive's own list (`scope: 'hive'`), and its advanced values under their `hive.*` ids. Each is pure on
 * the parsed file (`upgraded*`, null when nothing is old), and a file is written only when it changed, as Combwork's own
 * writer writes it (writeKeptJson), under the lock its changes take. A file that doesn't parse is left as it is: its
 * load recovers it as it would any damaged file.
 */

const log = createLogger('nameUpgrade')

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

/** A record of sections each holding `options` (a project's `kept`, a template's `workflow`), its old values converted; null when none is old. */
function upgradedSections(sections: unknown): Obj | null {
  if (!isObj(sections)) return null
  let out: Obj | null = null
  for (const [p, s] of Object.entries(sections)) {
    if (!isObj(s)) continue
    const options = upgradedOptions(isObj(s.options) ? s.options : null)
    if (options) out = { ...(out ?? sections), [p]: { ...s, options } }
  }
  return out
}

/** A project.json's value with its workflow options' old values converted (`options` and each `kept` platform's); null when none is old. */
export function upgradedProjectConfig(raw: unknown): Obj | null {
  if (!isObj(raw) || !isObj(raw.workflow)) return null
  const w = raw.workflow
  const options = upgradedOptions(isObj(w.options) ? w.options : null)
  const kept = upgradedSections(w.kept)
  if (!options && !kept) return null
  return { ...raw, workflow: { ...w, ...(options ? { options } : {}), ...(kept ? { kept } : {}) } }
}

/** A point's refs (workspace.json's commands.onOpen and onClose) with Hive's scope as Combwork's, each once; null when none is old. */
function upgradedPoint(point: unknown): Obj | null {
  if (!isObj(point) || !Array.isArray(point.run) || !point.run.some((r) => isObj(r) && r.scope === OLD_ID)) return null
  const run: unknown[] = []
  for (const r of point.run) {
    const ref = isObj(r) && r.scope === OLD_ID ? { ...r, scope: NEW_ID } : r
    if (isObj(ref) && run.some((x) => isObj(x) && x.scope === ref.scope && x.id === ref.id)) continue
    run.push(ref)
  }
  return { ...point, run }
}

/**
 * A workspace.json's value with its old stored values converted: its workflow defaults' (each platform's), its command
 * points' refs to Hive's list, and its advanced values' `hive.*` ids (where both ids are there the `cw.*` one wins).
 * Null when none is old. It runs before the workspace's load, whose command cleaning drops a scope it doesn't know.
 */
export function upgradedWorkspaceConfig(raw: unknown): Obj | null {
  if (!isObj(raw)) return null
  let out: Obj | null = null
  const set = (k: string, v: unknown): void => void (out = { ...(out ?? raw), [k]: v })
  if (isObj(raw.workflow)) {
    let workflow: Obj | null = null
    for (const [p, o] of Object.entries(raw.workflow)) {
      const now = upgradedOptions(isObj(o) ? o : null)
      if (now) workflow = { ...(workflow ?? raw.workflow), [p]: now }
    }
    if (workflow) set('workflow', workflow)
  }
  if (isObj(raw.commands)) {
    let commands: Obj | null = null
    for (const k of ['onOpen', 'onClose']) {
      const now = upgradedPoint(raw.commands[k])
      if (now) commands = { ...(commands ?? raw.commands), [k]: now }
    }
    if (commands) set('commands', commands)
  }
  if (isObj(raw.advanced)) {
    const { record, renamed } = upgradedAdvancedIds(raw.advanced)
    if (renamed.length) set('advanced', record)
  }
  return out
}

/** A template file's value with its sections' old option values converted; null when none is old. */
export function upgradedTemplate(raw: unknown): Obj | null {
  if (!isObj(raw)) return null
  const workflow = upgradedSections(raw.workflow)
  return workflow ? { ...raw, workflow } : null
}

/**
 * Rewrites a kept JSON file when `f` changes its value, under `lock`; whether it is settled. Gone: nothing to do; not JSON:
 * left as it is (said in the log). Unreadable now (another program holds it, HI-2414): left for the next open, which
 * runs the step again (false: the upgrade's record isn't written), and the open goes on as it would without the step.
 */
async function rewriteJson(file: string, lock: string, f: (raw: unknown) => Obj | null): Promise<boolean> {
  return withFileLock(lock, async () => {
    let text: string | null
    try {
      text = await readFile(file, 'utf8').catch(ifAbsent(null))
    } catch (e) {
      log.warn(`${userText(file)} couldn't be read: the names upgrade converts it at the next open`, e)
      return false
    }
    if (text === null) return true
    let raw: unknown
    try {
      raw = JSON.parse(text.replace(/^﻿/, ''))
    } catch {
      log.warn(`${userText(file)} isn't JSON: left as it is by the names upgrade`)
      return true
    }
    const now = f(raw)
    if (now) await writeKeptJson(file, now, { existing: true })
    return true
  })
}

/** A place's templates (`<host>/.combwork/templates`), each rewritten under that folder's lock (templates.ts withTemplatesLock's key). */
async function upgradeTemplates(host: string): Promise<boolean> {
  const dir = join(host, CW_DIR, 'templates')
  const files = (await readdir(dir).catch(ifAbsent([] as string[]))).filter(isTemplateFile)
  let settled = true
  for (const f of files) if (!(await rewriteJson(join(dir, f), `${resolve(dir)}|templates`, upgradedTemplate))) settled = false
  return settled
}

/** The workspace's values (the `files` step): workspace.json and the workspace's templates; whether all are settled. */
export async function upgradeWorkspaceValues(ws: string): Promise<boolean> {
  const file = join(ws, CW_DIR, 'workspace.json')
  const own = await rewriteJson(file, file, upgradedWorkspaceConfig)
  return (await upgradeTemplates(ws)) && own
}

/** A project's values (its part of the `projects` step): project.json, under mutateProjectConfig's lock, and its templates; whether all are settled. */
export async function upgradeProjectValues(project: string): Promise<boolean> {
  const file = join(project, CW_DIR, 'project.json')
  const own = await rewriteJson(file, file, upgradedProjectConfig)
  return (await upgradeTemplates(project)) && own
}
