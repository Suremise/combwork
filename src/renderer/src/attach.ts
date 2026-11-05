// Attaching files to an agent's or the Assistant's session (#387): a paste, a drop, or Insert into Session. Each file's
// path is pasted into the prompt (copied into the session's attachments folder first when main says so), large files
// are asked about first, and the terminal shows a chip per attachment until the prompt is sent.
import { useSyncExternalStore } from 'react'
import { LARGE_ATTACHMENT_BYTES, type AttachmentKind } from '@shared/attachments'
import { msg, tr } from '@shared/i18n'
import { attempt } from './actions'
import { call } from './api'
import { confirm } from './store'
import { offerTip } from './tips'
import { formatBytes, quotePath } from './util'

export interface AttachedChip {
  path: string
  name: string
  kind: AttachmentKind
}

const NONE: AttachedChip[] = []
/** Each terminal's chips (by pty key): what was attached since its prompt was last sent. */
const chips = new Map<string, AttachedChip[]>()
const listeners = new Set<() => void>()
const changed = (): void => listeners.forEach((l) => l())

/** The chips a terminal shows. */
export function useAttachedChips(key: string): AttachedChip[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => chips.get(key) ?? NONE
  )
}

/** Adds chips to a terminal (a path attached again keeps one chip). */
export function addChips(key: string, add: AttachedChip[]): void {
  if (!add.length) return
  const now = chips.get(key) ?? []
  chips.set(key, [...now.filter((c) => !add.some((a) => a.path === c.path)), ...add])
  changed()
}

/** Clears a terminal's chips (its prompt was sent), or one chip (dismissed). */
export function clearChips(key: string, path?: string): void {
  const now = chips.get(key)
  if (!now) return
  const left = path === undefined ? [] : now.filter((c) => c.path !== path)
  if (left.length) chips.set(key, left)
  else chips.delete(key)
  changed()
}

const ATTACH_FAILED = msg({ id: 'actions.attach.failed', defaultMessage: 'Could not attach', description: "An error's title: attaching files to an agent's prompt failed." })

/**
 * Attaches files to an agent's running session: asks first when one is large, then copies what main says into the
 * session's attachments folder. The text to paste into the prompt (each path quoted, a space after), or null when the
 * user cancelled or it failed (said in a notice). `key` is the terminal whose chips show them.
 */
export async function attachFiles(projectPath: string, agentId: string | undefined, sources: string[], key: string): Promise<string | null> {
  const plan = await attempt(tr(ATTACH_FAILED), () => call('session:planAttach', projectPath, sources, agentId))
  if (!plan?.length) return null
  const large = plan.filter((p) => !p.folder && p.size > LARGE_ATTACHMENT_BYTES)
  if (large.length) {
    const one = large.length === 1
    const ok = await confirm({
      title: tr(msg({ id: 'actions.attach.largeTitle', defaultMessage: '{n, plural, one {Attach a large file?} other {Attach # large files?}}', description: "Title of the confirmation before attaching large files to an agent's prompt." }), { n: large.length }),
      message: one
        ? tr(msg({ id: 'actions.attach.largeOne', defaultMessage: '"{file}" is {size}.', description: 'The confirmation before attaching one large file: its name ({file}) and size ({size}: "48 MB").' }), { file: large[0].name, size: formatBytes(large[0].size) })
        : tr(msg({ id: 'actions.attach.largeMany', defaultMessage: 'These files are over {size}:', description: 'The confirmation before attaching several large files, above their list: the size they are over ({size}: "20 MB").' }), { size: formatBytes(LARGE_ATTACHMENT_BYTES) }),
      list: one ? undefined : large.map((p) => `${p.name} (${formatBytes(p.size)})`),
      detail: tr(msg({ id: 'actions.attach.largeDetail', defaultMessage: 'An agent may not manage a file this large: its CLI can refuse it, or reading it can fill much of its context.{copy, select, yes { Combwork keeps a copy with the session.} other {}}', description: "Why attaching a large file needs a confirmation; then, when Combwork copies it into the session's attachments, that it keeps a copy (copy: yes)." }), { copy: large.some((p) => p.copy) ? 'yes' : 'no' }),
      confirmLabel: one ? tr(msg({ id: 'actions.attach.attach', defaultMessage: 'Attach', description: 'Button: attaches the large file anyway. Keep it short.' })) : tr(msg({ id: 'actions.attach.attachAll', defaultMessage: 'Attach All', description: 'Button: attaches the large files anyway. Keep it short.' }))
    })
    if (!ok) return null
  }
  const done = await attempt(tr(ATTACH_FAILED), () => call('session:attach', projectPath, sources, agentId))
  if (!done?.length) return null
  addChips(key, done.filter((d) => plan.some((p) => p.source === d.source && !p.folder)).map((d) => ({ path: d.path, name: d.name, kind: d.kind })))
  if (done.some((d) => d.copied)) offerTip('image-pasted')
  return done.map((d) => quotePath(d.path)).join(' ') + ' '
}
