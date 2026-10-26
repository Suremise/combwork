// Card attachments (HI-1700): what main and the window share. A card's text names an attachment by a link to
// `attachment:<id>` (an image as `![name](attachment:<id>)`), resolved against that card's own attachments only; a draft in
// the card dialog (not stored yet) is `attachment:draft-<k>` until Save or Post stores it.
import type { AttachmentKind } from './attachments'

/** A file kept with a card, as Hive lists it. */
export interface CardAttachment {
  id: string
  card: number
  /** Its name in the card's folder (`<time>_<name>`). */
  file: string
  /** Its name as given. */
  name: string
  size: number
  sha256: string
  /** Who added it ("You", the Assistant, an agent's name). */
  by: string
  at: string
  /** Where it first came: a comment's id, `description`, `pane`, or null (attached to the card itself). */
  comment: string | null
  /** Its full path now. */
  path: string
  kind: AttachmentKind
  /** Its file is gone from disk (the window shows it, with Remove). */
  missing?: true
}

/**
 * The card dialog's drafts carried by one Save or Post (HI-1700): each file (a drop's or pick's path, a paste's bytes)
 * and the draft its text links it by (`draft-<k>`), in the same order. Nothing is stored before the call.
 */
export interface CardDrafts {
  files: ({ path: string } | { data: Uint8Array; name: string | null })[]
  keys: string[]
}

/** A project's card attachments as its Attachments tab lists them: by card, newest card first. */
export interface CardAttachmentGroup {
  card: number
  key: string | null
  title: string
  column: string
  archived: boolean
  attachments: CardAttachment[]
}

/** At most this many files in one call (a card's create or change, a comment, the dialog's Save or Post), all its boxes together. */
export const ATTACH_MAX_FILES = 10
/** At most this many bytes in one call, in all. */
export const ATTACH_MAX_TOTAL = 100 * 1024 * 1024

/** An attachment link's target in a card's text. */
export const attachmentHref = (id: string): string => `attachment:${id}`
/** A draft's (in the card dialog, before Save or Post). */
export const draftHref = (k: number): string => `attachment:draft-${k}`

/** Every attachment link in a text: its id (`draft-<k>` for a draft). */
export const ATTACHMENT_LINK = /\]\(attachment:((?:draft-)?[0-9a-z-]{1,40})\)/g

/** The ids a text links to, in order, once each. */
export function attachmentRefs(text: string | null | undefined): string[] {
  const out: string[] = []
  for (const m of (text ?? '').matchAll(ATTACHMENT_LINK)) if (!out.includes(m[1])) out.push(m[1])
  return out
}

/** A name as Markdown link text: what Markdown would read as markup, escaped; control characters dropped. */
export function escapeLinkText(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\x00-\x1f\x7f]/g, '').replace(/[\\[\]*_`<>!#|~]/g, (c) => `\\${c}`)
}

/** The Markdown that shows an attachment in a card's text: an image inline, any other file as a link. */
export const attachmentMarkdown = (name: string, kind: AttachmentKind, href: string): string => `${kind === 'image' ? '!' : ''}[${escapeLinkText(name)}](${href})`

/** A text's draft links given their stored ids (Save, Post): `draft-<k>` to the attachment's id. */
export function withStoredIds(text: string, ids: Map<string, string>): string {
  return text.replace(ATTACHMENT_LINK, (all, id: string) => (ids.has(id) ? `](${attachmentHref(ids.get(id)!)})` : all))
}

/**
 * A card's text as agents read it: each attachment link to the file's full path (they open it with their tools); a link
 * to an attachment no longer on the card says so.
 */
export function withAttachmentPaths(text: string, attachments: Pick<CardAttachment, 'id' | 'path'>[]): string {
  if (!text.includes('](attachment:')) return text
  const byId = new Map(attachments.map((a) => [a.id, a.path]))
  return text.replace(ATTACHMENT_LINK, (_all, id: string) => `](${byId.get(id) ?? 'attachment removed'})`) // i18n-ignore: agent-facing: a card's text as agents read it
}
