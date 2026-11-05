// A card's text as the window shows it (HI-1700): its links to attachments (`attachment:<id>`, a draft's `draft-<k>`)
// made into what Markdown can show. An image is shown inline (combwork-img: for a stored one, a blob: preview for a draft),
// any other file is a link the dialog opens (`#card-attachment-<id>`), and a link to one no longer on the card is a grey
// "removed" chip, never a broken image. Apart from the dialog so a unit test can read it.
import { msg, tr } from '../../shared/i18n'
import type { AttachmentKind } from '../../shared/attachments'

/** What a link's target is now: an image's URL to show, or a file to open; null, gone from the card. */
export type AttachmentLookup = (id: string) => { name: string; kind: AttachmentKind; url: string | null } | null

/** A file link's anchor (the dialog's onLink opens it). */
export const ATTACHMENT_ANCHOR = '#card-attachment-'
/** An image's source until it is shown (attachmentImage gives its URL). */
export const ATTACHMENT_IMAGE = 'card-attachment/'

/** An attachment image's URL for Markdown's `images`, from its placeholder source; null for any other image. */
export const attachmentImage = (lookup: AttachmentLookup) => (src: string): string | null => (src.startsWith(ATTACHMENT_IMAGE) ? (lookup(src.slice(ATTACHMENT_IMAGE.length))?.url ?? null) : null)

const REMOVED = msg({ id: 'board.attach.removed', defaultMessage: '{name} (removed)', description: "In a card's description or comment (HI-1700): a link to an attachment that was removed from the card since; {name} is the file's name as the text gave it." })

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const LINK = /(!?)\[((?:\\.|[^\]\\])*)\]\(attachment:((?:draft-)?[0-9a-z-]{1,40})\)/g

/** A card's text with its attachment links resolved through `lookup`, for Markdown. */
export function withAttachmentUrls(text: string, lookup: AttachmentLookup): string {
  if (!text.includes('](attachment:')) return text
  return text.replace(LINK, (_all, _bang: string, label: string, id: string) => {
    const a = lookup(id)
    if (!a) return `<span class="attachment-gone">${escapeHtml(tr(REMOVED, { name: label.replace(/\\(.)/g, '$1') }))}</span>` // i18n-ignore: markup around a message
    // A relative source (the sanitiser keeps it), given its URL once shown (Markdown's `images`): combwork-img: and blob:
    // aren't sources the sanitiser lets through.
    // A link around it: a click opens it (the dialog's onLink).
    if (a.kind === 'image' && a.url) return `[![${label}](${ATTACHMENT_IMAGE}${id})](${ATTACHMENT_ANCHOR}${id})`
    return `[${label}](${ATTACHMENT_ANCHOR}${id})`
  })
}
