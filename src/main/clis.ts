import { join } from 'path'
import { app, shell } from 'electron'
import { readdir, readFile, stat, mkdir } from 'original-fs/promises'
import { withValues, type Text } from '../shared/advanced'
import { msg } from '../shared/i18n'
import { PROVIDERS } from '../shared/providers'
import { BUILT_IN_PROVIDERS } from '../shared/providers/registry'
import { CLI_BOUNDS, checkCliDescription, cliModule, type CliDescription } from '../shared/providers/cliDescription'
import { registerCliSnapshot, type CliSnapshotView } from '../shared/providers/cliSnapshot'
import { ensureHomeAccount } from './accounts'
import { emit } from './events'
import { createLogger, userText } from './logger'
import { registerCliAdapters } from './providers'
import { CliAdapter } from './providers/cliAdapter'
import { providerService } from './providerService'

// The user's own CLIs (HI-3196): one JSON description per CLI in the profile's `clis` folder (per machine: a binary's path
// is), read at startup and on Settings' Reload, each checked (shared/providers/cliDescription.ts) before it is used. A
// snapshot is applied in one synchronous step: the shared registry's tail and its advanced values, and main's adapters,
// together; then every window gets it. A launch takes its own copy at its start (forLaunch), so a reload never reaches
// one under way; a saved provider id is never remapped (an agent on a CLI that is gone is refused as an unknown provider).

const log = createLogger('clis')

const M = {
  tooManyFiles: msg({ id: 'clis.problem.tooManyFiles', defaultMessage: 'Only the first {max, number} descriptions are read: this one is left out.', description: 'Why a CLI description file is left out (HI-3196): the clis folder holds more files than Combwork reads.' }),
  tooBig: msg({ id: 'clis.problem.fileTooBig', defaultMessage: 'It is larger than {max, number} bytes.', description: 'Why a CLI description file is refused (HI-3196): it is too large. {max} is the limit in bytes.' }),
  badJson: msg({ id: 'clis.problem.fileBadJson', defaultMessage: 'It isn’t valid JSON: {error}', description: 'Why a CLI description file is refused (HI-3196): it can’t be read as JSON. {error} is the parser’s English message.' }),
  unreadable: msg({ id: 'clis.problem.unreadable', defaultMessage: 'It couldn’t be read: {error}', description: 'Why a CLI description file is refused (HI-3196): reading it failed. {error} is the English reason.' }),
  duplicate: msg({ id: 'clis.problem.duplicate', defaultMessage: 'Its id {id} is also in {other}: neither is used.', description: 'Why a CLI description file is refused (HI-3196): another file in the clis folder has the same id. {id} is the id; {other} the other file’s name.' })
}

/** The folder the user's own CLIs' descriptions are in. */
export const clisFolder = (): string => join(app.getPath('userData'), 'clis')

let generation = 0
let current: CliSnapshotView = { generation: 0, folder: '', clis: [], problems: [] }
/** Each file's last description that checked out, for this run: a later malformed edit keeps it (said beside it). */
const lastGood = new Map<string, CliDescription>()

/** The snapshot every window registers (its initial state and each `clis` event). */
export const cliSnapshot = (): CliSnapshotView => current

/** Reads the folder and checks each description: the snapshot it makes, not applied yet. */
export async function readClis(folder = clisFolder()): Promise<CliSnapshotView> {
  const problems: CliSnapshotView['problems'] = []
  let names: string[] = []
  try {
    names = (await readdir(folder)).filter((n) => /\.json$/i.test(n)).sort((a, b) => a.localeCompare(b))
  } catch {
    names = []
  }
  for (const n of names.slice(CLI_BOUNDS.files)) problems.push({ file: n, problems: [withValues(M.tooManyFiles, { max: CLI_BOUNDS.files })] })
  names = names.slice(0, CLI_BOUNDS.files)
  // Parsed first, each on its own: then ids two files share are refused in both.
  const parsed: { file: string; raw?: unknown; problem?: Text }[] = []
  for (const file of names) {
    const path = join(folder, file)
    try {
      const st = await stat(path)
      if (st.size > CLI_BOUNDS.fileBytes) {
        parsed.push({ file, problem: withValues(M.tooBig, { max: CLI_BOUNDS.fileBytes }) })
        continue
      }
      const text = await readFile(path, 'utf8')
      try {
        parsed.push({ file, raw: JSON.parse(text.replace(/^﻿/, '')) })
      } catch (e) {
        parsed.push({ file, problem: withValues(M.badJson, { error: (e as Error).message }) })
      }
    } catch (e) {
      parsed.push({ file, problem: withValues(M.unreadable, { error: (e as Error).message }) })
    }
  }
  const idOf = (raw: unknown): string | null => (raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string' ? (raw as { id: string }).id : null)
  const byId = new Map<string, string[]>()
  for (const p of parsed) {
    const id = p.raw !== undefined ? idOf(p.raw) : null
    if (id) byId.set(id, [...(byId.get(id) ?? []), p.file])
  }
  const builtIn = new Map(PROVIDERS.slice(0, BUILT_IN_PROVIDERS).map((d) => [d.id, d.name]))
  const clis: CliDescription[] = []
  for (const p of parsed) {
    let fileProblems: Text[] = []
    let cli: CliDescription | null = null
    if (p.problem) fileProblems = [p.problem]
    else {
      const id = idOf(p.raw)
      const others = id ? (byId.get(id) ?? []).filter((f) => f !== p.file) : []
      if (id && others.length) fileProblems = [withValues(M.duplicate, { id, other: others.join(', ') })]
      else {
        const r = checkCliDescription(p.raw, builtIn)
        if (r.ok) cli = r.cli
        else fileProblems = r.problems
      }
    }
    if (cli) {
      clis.push(cli)
      lastGood.set(p.file, cli)
      continue
    }
    // A file that had a good version this run keeps it (unless another file now has its id).
    const kept = lastGood.get(p.file)
    const usable = kept && !clis.some((c) => c.id === kept.id) && (byId.get(kept.id) ?? [p.file]).every((f) => f === p.file)
    if (usable) clis.push(kept)
    problems.push({ file: p.file, problems: fileProblems, ...(usable ? { usingLastGood: true } : {}) })
  }
  // A file gone is gone: its last good version too.
  for (const f of [...lastGood.keys()]) if (!names.includes(f)) lastGood.delete(f)
  return { generation: 0, folder, clis, problems }
}

/**
 * Applies a snapshot in one step (no await between): the shared registry's tail and advanced values, and main's adapters;
 * then tells every window, and looks for each new CLI's executable.
 */
export function applyClis(view: CliSnapshotView): CliSnapshotView {
  const was = new Set(current.clis.map((c) => c.id))
  generation++
  const snapshot = { ...view, generation }
  registerCliSnapshot(snapshot)
  registerCliAdapters(snapshot.clis.map((c) => new CliAdapter({ ...cliModule(c), cli: c })))
  current = snapshot
  emit({ type: 'clis', snapshot })
  for (const c of snapshot.clis) {
    // Its agents run on its PC-wide account (it has no sign-in connections): made once, as Copilot's was.
    ensureHomeAccount(c.id)
    if (!was.has(c.id)) void providerService.refresh(c.id).catch((e) => log.warn(`looking for ${userText(c.name)} failed`, e))
  }
  for (const p of snapshot.problems) log.warn(`CLI description ${userText(p.file)} wasn't used${p.usingLastGood ? ' (its last good version is)' : ''}`)
  return snapshot
}

let firstRead: Promise<CliSnapshotView> | null = null

/** The first read at startup (index.ts), which a window's first snapshot waits for: once only. */
export function startClis(): Promise<CliSnapshotView> {
  firstRead ??= reloadClis().catch((e) => {
    log.warn("reading the CLIs' descriptions failed", e)
    return current
  })
  return firstRead
}

/** The snapshot a window registers before its first render: the first read's, once it is done. */
export async function cliSnapshotForWindow(): Promise<CliSnapshotView> {
  await startClis()
  return current
}

/** Reads and applies the folder (at startup and on Settings' Reload). */
export async function reloadClis(): Promise<CliSnapshotView> {
  return applyClis(await readClis())
}

/** Opens the folder in Explorer, made first. */
export async function openClisFolder(): Promise<void> {
  await mkdir(clisFolder(), { recursive: true })
  const failed = await shell.openPath(clisFolder())
  if (failed) throw new Error(failed)
}
