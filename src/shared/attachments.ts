// Attachments (#387): files pasted or dropped into an agent's or the Assistant's prompt. Every one reaches the CLI the same
// way, as a path in the prompt; what differs is whether the CLI reads that kind of file as what it is (an image it sees,
// a PDF it reads) or only by opening the path with its tools. The kinds each CLI reads are in its descriptor
// (capabilities.attachments).

import { msg, tr, type Msg } from './i18n'

/** What kind of file an attachment is, as far as a CLI reading it cares. `file` is anything else (a zip, a binary). */
export type AttachmentKind = 'image' | 'pdf' | 'text' | 'file'

/** Where a session host keeps its attachments: `.combwork/attachments/<session id>` (or `run-<launch>` until it has one). */
export const ATTACHMENTS_DIR = 'attachments'
/**
 * Cards' attachments (HI-1700): `<host>/.combwork/attachments/cards/<card number>`, beside the sessions' folders. Never a
 * session's: the sessions' listings, Clean Up and Purge pass it by (isSessionFolder), so nothing of a session's removes it.
 */
export const CARD_ATTACHMENTS_DIR = 'cards'
/** Whether a folder in a host's attachments folder is a session's (any but the cards' folder). */
export const isSessionFolder = (name: string): boolean => name.toLowerCase() !== CARD_ATTACHMENTS_DIR

/** The folder's name before #387: Combwork moves it to ATTACHMENTS_DIR, and old paths into it still lead to the moved files. */
export const OLD_ATTACHMENTS_DIR = 'images'

/** Above this size Combwork asks before attaching a file: a CLI may refuse it, or reading it may fill the agent's context. */
export const LARGE_ATTACHMENT_BYTES = 20 * 1024 * 1024

export const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp)$/i
const PDF_FILE = /\.pdf$/i
// Text a CLI reads with its file tools: plain text, logs, data and code. Anything not listed is a `file`, read by path.
const TEXT_FILE =
  /\.(txt|text|md|markdown|mdx|rst|adoc|log|out|err|csv|tsv|json|jsonl|ndjson|yaml|yml|toml|ini|cfg|conf|env|properties|xml|html?|css|scss|less|svg|js|mjs|cjs|jsx|ts|mts|cts|tsx|py|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|cxx|hpp|cs|fs|vb|php|pl|lua|r|sql|sh|bash|zsh|ps1|psm1|bat|cmd|gradle|dockerfile|makefile|diff|patch|ipynb|vue|svelte|dart|scala|ex|exs|erl|hs|clj|tf|graphql|proto)$/i
const TEXT_NAMES = /^(dockerfile|makefile|license|readme|changelog|\.gitignore|\.editorconfig)$/i

/** The kind of file a name is, by its extension. */
export function attachmentKind(name: string): AttachmentKind {
  const base = name.split(/[\\/]/).pop() ?? name
  if (IMAGE_FILE.test(base)) return 'image'
  if (PDF_FILE.test(base)) return 'pdf'
  if (TEXT_FILE.test(base) || TEXT_NAMES.test(base)) return 'text'
  return 'file'
}

/** A kind's name for the user, for a filter or a chip: "Image", "PDF", "Text", "File" (#802: shown with tr). */
export const ATTACHMENT_KIND_LABEL: Record<AttachmentKind, Msg> = {
  image: msg({ id: 'sessions.attach.image', defaultMessage: 'Image', description: "An attachment's kind (a chip on an agent's prompt, the Attachments tab's filter): an image. Keep it short." }),
  pdf: msg({ id: 'sessions.attach.pdf', defaultMessage: 'PDF', description: "An attachment's kind: a PDF document. Keep it short." }),
  text: msg({ id: 'sessions.attach.text', defaultMessage: 'Text', description: "An attachment's kind: a text or code file. Keep it short." }),
  file: msg({ id: 'sessions.attach.file', defaultMessage: 'File', description: "An attachment's kind: any other file (a zip, a binary). Keep it short." })
}
/** The filters' order in the Attachments tab. */
export const ATTACHMENT_KINDS: AttachmentKind[] = ['image', 'pdf', 'text', 'file']
/** A kind's icon (codicons). */
export const ATTACHMENT_KIND_ICON: Record<AttachmentKind, string> = { image: 'file-media', pdf: 'file-pdf', text: 'file-code', file: 'file' } // i18n-ignore: icon names

/**
 * How an attachment is labelled for a CLI: its kind, and whether the CLI reads that kind itself (`native`) or the agent
 * opens it by its path. `reads` is the CLI's capabilities.attachments; `cli` its name for the explanation.
 */
export function attachmentLabel(kind: AttachmentKind, reads: readonly AttachmentKind[], cli: string): { label: string; native: boolean; detail: string } {
  const native = reads.includes(kind)
  const label = tr(ATTACHMENT_KIND_LABEL[kind])
  if (native) return { label, native, detail: tr(msg({ id: 'sessions.attach.native', defaultMessage: '{cli} {kind, select, image {sees the image} pdf {reads the PDF} other {reads the text}} itself.', description: "An attachment chip's hover: the agent's CLI ({cli}: \"Claude Code\") reads this kind of file itself (an image, a PDF, or text)." }), { cli, kind }) }
  return {
    label: tr(msg({ id: 'sessions.attach.byPath', defaultMessage: '{kind} · by path', description: "An attachment chip's label when the agent's CLI doesn't read that kind of file itself: the kind ({kind}: \"PDF\"), and that the agent gets only its path." }), { kind: label }),
    native,
    detail: tr(msg({ id: 'sessions.attach.byPathDetail', defaultMessage: "{cli} doesn't read {kind, select, pdf {PDFs} other {this kind of file}} itself: the agent gets its path and opens it with its tools.", description: "An attachment chip's hover when the agent's CLI ({cli}) doesn't read the file's kind (PDFs, or another kind) itself." }), { cli, kind })
  }
}

/**
 * Where a path into a session host's old attachments folder (`<host>\.combwork\images\…`) leads now that the folder is
 * `.combwork\attachments`: the same path with the folder renamed, or null for a path that isn't in an old folder.
 */
export function movedAttachmentPath(p: string): string | null {
  const m = /([\\/])\.combwork([\\/])images([\\/])/i.exec(p)
  if (!m) return null
  return p.slice(0, m.index) + `${m[1]}.combwork${m[2]}${ATTACHMENTS_DIR}${m[3]}` + p.slice(m.index + m[0].length)
}

/** Whether a path is already in a session host's attachments folder (or its old one): attached again as it is. */
export const inAttachmentsFolder = (p: string): boolean => /[\\/]\.combwork[\\/](attachments|images)[\\/]/i.test(p)
