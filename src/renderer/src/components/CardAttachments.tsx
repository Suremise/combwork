// Card attachments in the window (HI-1700): the card dialog's drafts (pasted or dropped into its description or comment
// box, nothing stored until Save or Post), its list of the card's files, and the lookup its text's links are shown with.
import { useCallback, useEffect, useRef, useState } from 'react'
import { msg, tr } from '@shared/i18n'
import { ATTACHMENT_KIND_ICON, attachmentKind, type AttachmentKind } from '@shared/attachments'
import { ATTACH_MAX_FILES, ATTACH_MAX_TOTAL, attachmentMarkdown, attachmentRefs, draftHref, type CardAttachment, type CardAttachmentGroup, type CardDrafts } from '@shared/cardAttachments'
import { CARD_ATTACHMENT_MAX_ID } from '@shared/advanced'
import { formatBytes } from '@shared/units'
import type { TaskCard, TaskColumn } from '@shared/types'
import { agentRowCards, columnName } from '@shared/tasks'
import { call, errorMessage } from '../api'
import { useAdvancedValue } from '../advanced'
import { ATTACHMENT_ANCHOR, type AttachmentLookup } from '../cardAttachLinks'
import { confirm, notify, set, showAttachments, useStore } from '../store'
import { imageUrl, timeAgo } from '../util'
import { useScopedLoad } from '../scopedLoad'
import { Icon, IconButton, Tooltip, useContextMenu, type MenuEntry } from './ui'

/** A box of the card dialog that takes drafts. */
export type DraftBox = 'description' | 'comment'

/** A file pasted or dropped into a box: its preview, its name and size, and what is sent for it (its path, else its bytes). */
interface Draft {
  key: string
  file: File
  path: string | null
  url: string
  name: string
  kind: AttachmentKind
  size: number
}

const M = {
  tooLarge: msg({ id: 'board.attach.tooLarge', defaultMessage: '{name} is larger than {max}, the most a card keeps in one file (Settings → Advanced → Card attachments: largest file).', description: 'An error in the card dialog (HI-1700): a pasted or dropped file is larger than the limit ({max}: a size such as 25 MB); it was not added.' }),
  tooMuch: msg({ id: 'board.attach.tooMuch', defaultMessage: 'At most {files, number} files and {total} can be saved at once, the description and the comment together.', description: 'An error in the card dialog (HI-1700): more files, or more bytes in all ({total}: a size such as 100 MB), than one Save or Post takes; the last ones were not added.' }),
  drafts: msg({ id: 'board.attach.drafts', defaultMessage: 'Not saved yet: kept with the card when you {box, select, comment {post the comment} other {save}}', description: 'Under a box of the card dialog (HI-1700), beside files pasted or dropped into it: they are kept with the card only once the comment is posted, or the card saved.' }),
  removeDraft: msg({ id: 'board.attach.removeDraft', defaultMessage: 'Remove {name}', description: 'Button on a file pasted or dropped into the card dialog, not saved yet (HI-1700): takes it out, with its link in the text.' }),
  heading: msg({ id: 'board.attach.heading', defaultMessage: 'Attachments ({n, number})', description: "A heading in the card dialog (HI-1700): the files kept with the card, and how many ({n})." }),
  hint: msg({ id: 'board.attach.hint', defaultMessage: 'Paste or drop files into the description or a comment to keep them with the card.', description: 'Under the Attachments heading of the card dialog when the card has none yet (HI-1700).' }),
  open: msg({ id: 'board.attach.open', defaultMessage: 'Open', description: "A card attachment's action (HI-1700): opens an image or PDF in its program." }),
  show: msg({ id: 'board.attach.show', defaultMessage: 'Show in Folder', description: "A card attachment's action (HI-1700): shows the file in File Explorer." }),
  remove: msg({ id: 'board.attach.remove', defaultMessage: 'Remove', description: "A card attachment's action (HI-1700): takes it off the card (to the Recycle Bin), after asking." }),
  removeTitle: msg({ id: 'board.attach.removeTitle', defaultMessage: 'Remove {name} from {card}?', description: 'Title of the confirmation before removing a card attachment (HI-1700). {card} is the card’s name: its key, such as AM-12.' }),
  removeMessage: msg({ id: 'board.attach.removeMessage', defaultMessage: '{used, select, none {It goes to the Recycle Bin.} other {It goes to the Recycle Bin. It is shown in {used}: those links will say it was removed.}}', description: 'The confirmation before removing a card attachment (HI-1700); {used}: where the card shows it ("the description and 2 comments"), or none.' }),
  where: msg({ id: 'board.attach.where', defaultMessage: '{description, select, yes {the description} other {}}{both, select, yes { and } other {}}{comments, plural, =0 {} one {a comment} other {# comments}}', description: 'Where a card shows an attachment (HI-1700), in the remove confirmation: the description, and/or how many comments.' }),
  missing: msg({ id: 'board.attach.missing', defaultMessage: 'Its file is gone', description: "A card attachment whose file is no longer on disk (HI-1700): shown on it, with Remove." }),
  showInTab: msg({ id: 'board.attach.showInTab', defaultMessage: 'Show in Attachments', description: "A link beside the card dialog's Attachments heading (HI-1841): opens the project's Attachments tab on Card attachments, at this card's files." }),
  meta: msg({ id: 'board.attach.meta', defaultMessage: '{size} · {by}, {when}', description: "Under a card attachment's name (HI-1700): its size, who added it and when ({when}: \"4 minutes ago\")." })
}

/** What the attachment viewer says of a card attachment too (HI-1958): Show in Folder, and a file that is gone. */
export const CARD_ATTACH_TEXT = { show: M.show, missing: M.missing }

/**
 * Removes a card attachment after asking (the Attachments tab and its viewer, HI-1958): true once it is gone, false
 * when the user said no or it failed (said in a notice). `card`: the card's name, its key.
 */
export async function removeCardAttachmentAsked(card: string, a: CardAttachment): Promise<boolean> {
  if (!(await confirm({ title: tr(M.removeTitle, { name: a.name, card }), message: tr(M.removeMessage, { used: 'none' }), confirmLabel: tr(M.remove), danger: true }))) return false
  try {
    await call('cards:removeAttachment', a.card, a.id)
    return true
  } catch (e) {
    notify('error', tr(PANE.failed, { file: a.name }), errorMessage(e))
    return false
  }
}

/** A card's attachments, newest first, read again whenever the board changes. */
export function useCardAttachments(card: number | null): { list: CardAttachment[]; reload: () => Promise<void> } {
  // Each read of the board: an attachment added or removed leaves the cards, so `tasks`, as they were (HI-1853).
  const reads = useStore((s) => s.boardReads)
  const [list, setList] = useState<CardAttachment[]>([])
  const reload = useCallback(async () => {
    if (card === null) return setList([])
    setList(await call('cards:attachments', card).catch(() => []))
  }, [card])
  useEffect(() => {
    void reload()
  }, [reload, reads])
  return { list, reload }
}

/**
 * The card dialog's drafts: files pasted or dropped into its boxes, checked against the limits (each file, and all the
 * boxes' together) before any is read, each linked in its box's text where the caret is. Nothing is stored before Save or
 * Post sends them (payload); Cancel or closing drops them (clear).
 */
export function useAttachDrafts(onError: (text: string) => void) {
  const fileMax = useAdvancedValue<number>(CARD_ATTACHMENT_MAX_ID)
  const [drafts, setDrafts] = useState<Record<DraftBox, Draft[]>>({ description: [], comment: [] })
  const next = useRef(1)
  const all = useRef(drafts)
  all.current = drafts
  // Their previews go when the dialog does.
  useEffect(() => () => [...all.current.description, ...all.current.comment].forEach((d) => URL.revokeObjectURL(d.url)), [])

  /** Adds files to a box, linked at the caret: false (and an error) when one is over a limit; those before it are added. */
  const add = (box: DraftBox, files: File[], text: string, at: number, setText: (t: string) => void): void => {
    const now = [...all.current.description, ...all.current.comment]
    let count = now.length
    let total = now.reduce((n, d) => n + d.size, 0)
    const added: Draft[] = []
    for (const file of files) {
      if (file.size > fileMax) {
        onError(tr(M.tooLarge, { name: file.name, max: formatBytes(fileMax) }))
        break
      }
      if (count + 1 > ATTACH_MAX_FILES || total + file.size > ATTACH_MAX_TOTAL) {
        onError(tr(M.tooMuch, { files: ATTACH_MAX_FILES, total: formatBytes(ATTACH_MAX_TOTAL) }))
        break
      }
      count++
      total += file.size
      const name = file.name || 'pasted.png' // i18n-ignore: a file name
      added.push({ key: `draft-${next.current++}`, file, path: window.combwork.pathForFile(file) || null, url: URL.createObjectURL(file), name, kind: attachmentKind(name), size: file.size })
    }
    if (!added.length) return
    setDrafts((d) => ({ ...d, [box]: [...d[box], ...added] }))
    const links = added.map((d) => attachmentMarkdown(d.name, d.kind, draftHref(Number(d.key.slice(6))))).join('\n')
    setText(`${text.slice(0, at)}${links}${text.slice(at)}`)
  }

  /** What a box's textarea takes: a paste or drop of files becomes drafts, linked at the caret. */
  const boxProps = (box: DraftBox, text: string, setText: (t: string) => void) => ({
    onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = [...e.clipboardData.files]
      if (!files.length) return
      e.preventDefault()
      add(box, files, text, e.currentTarget.selectionStart ?? text.length, setText)
    },
    onDragOver: (e: React.DragEvent<HTMLTextAreaElement>) => {
      if (e.dataTransfer.types.includes('Files')) e.preventDefault()
    },
    onDrop: (e: React.DragEvent<HTMLTextAreaElement>) => {
      const files = [...e.dataTransfer.files]
      if (!files.length) return
      e.preventDefault()
      add(box, files, text, e.currentTarget.selectionStart ?? text.length, setText)
    }
  })

  /** Takes a draft out, with its link in the box's text. */
  const remove = (box: DraftBox, key: string, text: string, setText: (t: string) => void): void => {
    const d = all.current[box].find((x) => x.key === key)
    if (d) URL.revokeObjectURL(d.url)
    setDrafts((ds) => ({ ...ds, [box]: ds[box].filter((x) => x.key !== key) }))
    setText(text.replace(new RegExp(`!?\\[(?:\\\\.|[^\\]\\\\])*\\]\\(attachment:${key}\\)\\n?`, 'g'), ''))
  }

  /** What Save or Post sends for these boxes: the drafts their texts still link, each its path or its bytes. */
  const payload = async (texts: Partial<Record<DraftBox, string>>): Promise<CardDrafts | undefined> => {
    const files: CardDrafts['files'] = []
    const keys: string[] = []
    for (const box of Object.keys(texts) as DraftBox[]) {
      const linked = new Set(attachmentRefs(texts[box]))
      for (const d of all.current[box]) {
        if (!linked.has(d.key)) continue
        files.push(d.path ? { path: d.path } : { data: new Uint8Array(await d.file.arrayBuffer()), name: d.name })
        keys.push(d.key)
      }
    }
    return files.length ? { files, keys } : undefined
  }

  /** Drops a box's drafts (posted, saved, or the dialog cancelled). */
  const clear = (...boxes: DraftBox[]): void => {
    for (const b of boxes) all.current[b].forEach((d) => URL.revokeObjectURL(d.url))
    setDrafts((d) => ({ ...d, ...Object.fromEntries(boxes.map((b) => [b, []])) }))
  }

  return { drafts, boxProps, remove, payload, clear }
}

/** The lookup a card's text is shown with: its stored attachments and the dialog's drafts. */
export function attachmentLookup(list: CardAttachment[], drafts: Record<DraftBox, Draft[]>): AttachmentLookup {
  return (id) => {
    if (id.startsWith('draft-')) {
      const d = [...drafts.description, ...drafts.comment].find((x) => x.key === id)
      return d ? { name: d.name, kind: d.kind, url: d.kind === 'image' ? d.url : null } : null
    }
    const a = list.find((x) => x.id === id)
    return a ? { name: a.name, kind: a.kind, url: a.kind === 'image' && !a.missing ? imageUrl(a.path) : null } : null
  }
}

/** Opens a stored attachment a link names (images and PDFs in their program, any other file shown in its folder). */
export function openAttachmentLink(href: string, list: CardAttachment[]): boolean {
  if (!href.startsWith(ATTACHMENT_ANCHOR)) return false
  const a = list.find((x) => x.id === href.slice(ATTACHMENT_ANCHOR.length))
  if (a && !a.missing) void (a.kind === 'image' || a.kind === 'pdf' ? window.combwork.invoke('app:openPath', a.path) : window.combwork.invoke('app:showInFolder', a.path))
  return true
}

/** A box's drafts under it: each its preview or icon, its name, and × to take it out. */
export function DraftChips({ box, drafts, onRemove }: { box: DraftBox; drafts: Draft[]; onRemove: (key: string) => void }) {
  if (!drafts.length) return null
  return (
    <div className="attach-drafts" data-drafts={box}>
      {drafts.map((d) => (
        <span key={d.key} className="attach-draft" data-draft={d.key}>
          {d.kind === 'image' ? <img src={d.url} alt="" /> : <Icon name={ATTACHMENT_KIND_ICON[d.kind]} />}
          <span className="attach-draft-name">{d.name}</span>
          <IconButton icon="close" title={tr(M.removeDraft, { name: d.name })} onClick={() => onRemove(d.key)} />
        </span>
      ))}
      <span className="faint small">{tr(M.drafts, { box })}</span>
    </div>
  )
}

const PANE = {
  header: msg({ id: 'board.attach.paneHeader', defaultMessage: 'Attach {file} to a card', description: "The heading of the menu that copies a session's attachment ({file}: its name) to a card (HI-1700), from an agent's pane or the Attachments tab." }),
  toCard: msg({ id: 'board.attach.toCard', defaultMessage: 'Attach to {card}', description: "A menu entry (HI-1700): copies a session's attachment to the card {card} (its key, such as AM-12) that the agent works on or reviews." }),
  other: msg({ id: 'board.attach.otherCards', defaultMessage: "The project's other open cards", description: "A heading in the menu that copies a session's attachment to a card (HI-1700): the project's cards the agent isn't on." }),
  attached: msg({ id: 'board.attach.attached', defaultMessage: '{file} attached to {card}', description: "A notice (HI-1700): a session's attachment ({file}: its name) was copied to the card {card} (its key)." }),
  already: msg({ id: 'board.attach.already', defaultMessage: '{card} already has {file}', description: 'A notice (HI-1700): the card {card} already keeps the same file ({file}), so nothing was added.' }),
  failed: msg({ id: 'board.attach.failed', defaultMessage: 'Could not attach {file}', description: "An error's title (HI-1700): copying a session's attachment ({file}) to a card failed." })
}

/** At most this many cards in the Attach to card menu, besides the agent's own. */
const MENU_CARDS = 20

/**
 * The menu that copies a session's attachment (`path`, in host `hostPath`) to a card (HI-1700): the cards the agent works
 * on or reviews first ("Attach to HI-12"), then the project's other open cards, newest first. Copied, so a Clean Up of
 * the session can't break the card.
 */
export function attachToCardMenu(opts: { hostPath: string; project: string | null; agentId: string | null; path: string; name: string; cards: readonly TaskCard[]; label: (c: TaskCard) => string }): MenuEntry[] {
  const { hostPath, project, agentId, path, name, cards, label } = opts
  const open = cards.filter((c) => !c.archived && c.column !== 'done' && (project ? c.project.toLowerCase() === project.toLowerCase() : true))
  const mine = project && agentId ? agentRowCards(cards, project, agentId).map((x) => x.card) : []
  const others = open.filter((c) => !mine.includes(c)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MENU_CARDS)
  const go = (c: TaskCard) => async () => {
    try {
      const before = await call('cards:attachments', c.number)
      const a = await call('cards:attachFromPane', c.number, hostPath, path)
      notify('info', before.some((x) => x.id === a.id) ? tr(PANE.already, { card: label(c), file: name }) : tr(PANE.attached, { card: label(c), file: name }))
    } catch (e) {
      notify('error', tr(PANE.failed, { file: name }), errorMessage(e))
    }
  }
  return [
    { label: tr(PANE.header, { file: name }), header: true },
    ...mine.map((c) => ({ label: tr(PANE.toCard, { card: label(c) }), detail: c.title, icon: 'pinned', onClick: () => void go(c)() })),
    ...(others.length ? [{ separator: true }, { label: tr(PANE.other), header: true }, ...others.map((c) => ({ label: label(c), detail: c.title, onClick: () => void go(c)() }))] : [])
  ]
}

const TAB = {
  archived: msg({ id: 'files.attach.cardArchived', defaultMessage: 'Archived', description: "A badge on a card in the Attachments tab's Cards section (HI-1700): the card is archived (its files are kept)." }),
  openCard: msg({ id: 'files.attach.openCard', defaultMessage: 'Open {card}', description: "Hover of a card's name in the Attachments tab's Cards section (HI-1700): opens the card. {card} is its key." }),
  kept: msg({ id: 'files.attach.cardsKept', defaultMessage: "Kept with the card until it is deleted: Clean Up and Purge don't remove them.", description: "Under the Cards heading of a project's Attachments tab (HI-1700)." })
}

/**
 * A project's cards' attachments (its Attachments tab), read again whenever the board changes; `loaded` once a read for
 * this project has answered (HI-1841: its tabs choose only then), `failed` when the last one failed. Reads go through
 * useScopedLoad, so an older read (this project's, or one still running for the last project) never replaces a newer
 * one's answer (HR5's HI-1841 round 1).
 */
export function useProjectCardAttachments(projectPath: string | null): { groups: CardAttachmentGroup[]; reload: () => Promise<void>; loaded: boolean; failed: boolean } {
  // Each read of the board: an attachment added or removed leaves the cards, so `tasks`, as they were (HI-1853).
  const reads = useStore((s) => s.boardReads)
  const scope = projectPath ?? ''
  const read = useScopedLoad<CardAttachmentGroup[]>(scope)
  const { load } = read
  const reload = useCallback(async () => {
    load(scope, () => (projectPath ? call('cards:projectAttachments', projectPath) : Promise.resolve([])))
  }, [load, scope, projectPath])
  useEffect(() => {
    void reload()
  }, [reload, reads])
  return { groups: read.data ?? NO_GROUPS, reload, loaded: read.data !== null && !read.error, failed: !!read.error }
}

const NO_GROUPS: CardAttachmentGroup[] = []

/** A project's card attachments as its Attachments tab shows them, `kind` filtering them: by card, newest card first. */
export const shownCardGroups = (groups: CardAttachmentGroup[], kind: AttachmentKind | null): CardAttachmentGroup[] =>
  groups.map((g) => ({ ...g, attachments: g.attachments.filter((a) => !kind || a.kind === kind) })).filter((g) => g.attachments.length)

/**
 * The Attachments tab's Cards section (HI-1700): the files kept with the project's cards, by card (its key, which opens
 * it, title and column), newest card first; each file a tile, a click opens it in the attachment viewer (`onOpen`, as a
 * pane attachment's does: HI-1958), right-click to open, show or remove it.
 */
export function CardAttachmentSection({ groups, kind, reload, onOpen }: { groups: CardAttachmentGroup[]; kind: AttachmentKind | null; reload: () => Promise<void>; onOpen: (a: CardAttachment) => void }) {
  const menu = useContextMenu()
  const shown = shownCardGroups(groups, kind)
  if (!shown.length) return null
  const remove = async (g: CardAttachmentGroup, a: CardAttachment): Promise<void> => {
    await removeCardAttachmentAsked(g.key ?? `#${g.card}`, a)
    await reload()
  }
  const menuFor = (g: CardAttachmentGroup, a: CardAttachment): MenuEntry[] => [
    ...(!a.missing && (a.kind === 'image' || a.kind === 'pdf') ? [{ label: tr(M.open), icon: 'link-external', onClick: () => void window.combwork.invoke('app:openPath', a.path) }] : []),
    ...(!a.missing ? [{ label: tr(M.show), icon: 'folder-opened', onClick: () => void window.combwork.invoke('app:showInFolder', a.path) }] : []),
    { separator: true },
    { label: tr(M.remove), icon: 'trash', danger: true, onClick: () => void remove(g, a) }
  ]
  return (
    <section className="card-attachment-section" data-section="card-attachments">
      {/* Its tab names it and counts them (HI-1841): what keeps them, under it. */}
      <p className="hint">{tr(TAB.kept)}</p>
      {shown.map((g) => (
        <div key={g.card} className="image-group" data-card={g.card}>
          <div className="image-group-head">
            <Tooltip content={tr(TAB.openCard, { card: g.key ?? `#${g.card}` })}>
              <button className="image-group-name" onClick={() => set({ taskOpen: g.card })}>
                {g.key ?? `#${g.card}`}
              </button>
            </Tooltip>
            <span className="card-attachment-title">{g.title}</span>
            <span className="badge">{columnName(g.column as TaskColumn, tr)}</span>
            {g.archived && <span className="badge">{tr(TAB.archived)}</span>}
          </div>
          <div className="image-grid">
            {g.attachments.map((a) => (
              <Tooltip key={a.id} content={`${a.name} · ${formatBytes(a.size)} · ${a.by}${a.missing ? `\n${tr(M.missing)}` : ''}`}>
                <div className={`thumb${a.kind !== 'image' || a.missing ? ' file' : ''}`} data-kind={a.kind} data-attachment={a.id} onClick={() => onOpen(a)} onContextMenu={(e) => menu.open(e, menuFor(g, a))}>
                  {a.kind === 'image' && !a.missing ? (
                    <img src={imageUrl(a.path)} loading="lazy" alt={a.name} draggable={false} />
                  ) : (
                    <>
                      <Icon name={a.missing ? 'warning' : ATTACHMENT_KIND_ICON[a.kind]} />
                      <span className="thumb-name">{a.name}</span>
                    </>
                  )}
                  <span className="thumb-caption thumb-size">{formatBytes(a.size)}</span>
                  <span className="thumb-caption">{timeAgo(a.at)}</span>
                </div>
              </Tooltip>
            ))}
          </div>
        </div>
      ))}
      {menu.element}
    </section>
  )
}

/** Where a card's text shows an attachment: in its description, and in how many comments. */
function usedIn(card: TaskCard, id: string): { description: boolean; comments: number } {
  return { description: attachmentRefs(card.description).includes(id), comments: card.comments.filter((c) => attachmentRefs(c.text).includes(id)).length }
}

/** The card dialog's Attachments: every file kept with the card, newest first, with Open, Show in Folder and Remove. */
export function CardAttachmentList({ card, label, list, reload, readOnly }: { card: TaskCard; label: string; list: CardAttachment[]; reload: () => Promise<void>; readOnly: boolean }) {
  const [busy, setBusy] = useState<string | null>(null)
  // Its project in this window, whose Attachments tab Show in Attachments opens (HI-1841).
  const projectPath = useStore((s) => s.workspace?.projects.find((p) => p.name.toLowerCase() === card.project.toLowerCase())?.path ?? null)
  const remove = async (a: CardAttachment): Promise<void> => {
    const u = usedIn(card, a.id)
    const used = u.description || u.comments ? tr(M.where, { description: u.description ? 'yes' : 'no', both: u.description && u.comments ? 'yes' : 'no', comments: u.comments }) : 'none' // i18n-ignore: ICU select keys
    if (!(await confirm({ title: tr(M.removeTitle, { name: a.name, card: label }), message: tr(M.removeMessage, { used }), confirmLabel: tr(M.remove), danger: true }))) return
    setBusy(a.id)
    try {
      await call('cards:removeAttachment', card.number, a.id)
    } finally {
      setBusy(null)
      await reload()
    }
  }
  return (
    <div className="card-attachments" data-section="attachments">
      <div className="task-section-h">
        {tr(M.heading, { n: list.length })}
        {list.length > 0 && projectPath && (
          <button className="link-button card-attachments-show" data-action="show-in-attachments" onClick={() => (set({ taskOpen: null }), showAttachments(projectPath, { card: card.number }))}>
            {tr(M.showInTab)}
          </button>
        )}
      </div>
      {!list.length ? (
        <div className="faint small">{tr(M.hint)}</div>
      ) : (
        <div className="card-attachment-list">
          {list.map((a) => (
            <div key={a.id} className={`card-attachment${a.missing ? ' missing' : ''}`} data-attachment={a.id}>
              {a.kind === 'image' && !a.missing ? <img className="card-attachment-thumb" src={imageUrl(a.path)} alt="" loading="lazy" /> : <Icon name={a.missing ? 'warning' : ATTACHMENT_KIND_ICON[a.kind]} className="card-attachment-icon" />}
              <div className="card-attachment-text">
                <Tooltip content={a.path}>
                  <span className="card-attachment-name">{a.name}</span>
                </Tooltip>
                <span className="faint small">{a.missing ? tr(M.missing) : tr(M.meta, { size: formatBytes(a.size), by: a.by, when: timeAgo(a.at) })}</span>
              </div>
              {!a.missing && (a.kind === 'image' || a.kind === 'pdf') && <IconButton icon="link-external" title={tr(M.open)} onClick={() => void window.combwork.invoke('app:openPath', a.path)} />}
              {!a.missing && <IconButton icon="folder-opened" title={tr(M.show)} onClick={() => void window.combwork.invoke('app:showInFolder', a.path)} />}
              {!readOnly && <IconButton icon="trash" title={tr(M.remove)} disabled={busy === a.id} onClick={() => void remove(a)} />}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
