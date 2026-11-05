import type { TranscriptItem, TranscriptSearchHit } from '../../shared/types'
import { englishText, shownText, type Text } from '../../shared/advanced'
import { msg, tr } from '../../shared/i18n'
import { isAbsolute } from 'path'
import { formatDateTime } from '../../shared/dates'
import { formatTokens } from '../../shared/units'
import { relativeInside } from '../places'

/**
 * The provider-neutral side of transcripts: the viewer's items are the same for every provider, so
 * search and Markdown export live here. Each provider's adapter has its own parser into these items.
 */

/** An item before it gets its id (distributes over the union, so each kind keeps its own fields). */
export type NewItem = TranscriptItem extends infer T ? (T extends TranscriptItem ? Omit<T, 'id'> : never) : never

/** "mcp__combwork__cw_notify" → "combwork · cw_notify"; built-in tools keep their name. */
export function toolLabel(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  return m ? `${m[1]} · ${m[2]}` : name
}

/** A path relative to the project, when it is inside it (also by another name for its folder: #494). */
export function shortPath(p: unknown, root: string | null): string {
  if (typeof p !== 'string') return ''
  if (root && p.toLowerCase().startsWith(root.toLowerCase() + '\\')) return p.slice(root.length + 1).replace(/\\/g, '/')
  if (root && p.toLowerCase().startsWith(root.toLowerCase().replace(/\\/g, '/') + '/')) return p.slice(root.length + 1)
  if (!root || !isAbsolute(p)) return p
  return realInside(root, p) || p
}

/** Whether paths outside the project as spelt are inside it by real location, each resolved once (bounded). */
const realInsideSeen = new Map<string, string | null>()
function realInside(root: string, p: string): string | null {
  const k = `${root}|${p}`.toLowerCase()
  let rel = realInsideSeen.get(k)
  if (rel === undefined) {
    if (realInsideSeen.size >= 1000) realInsideSeen.clear()
    rel = relativeInside(root, p)?.replace(/\\/g, '/') ?? null
    realInsideSeen.set(k, rel)
  }
  return rel
}

export const firstLine = (s: unknown): string => (typeof s === 'string' ? s.trim().split('\n')[0] : '')

/** Everything searchable in an item, in the order it is shown. */
/** Combwork's notices in a conversation (#797), kept as data and shown in the language the window shows (shownNotice). */
export const NOTICE_TEXT = {
  interrupted: msg({ id: 'providers.transcript.interrupted', defaultMessage: 'Interrupted by you', description: "A notice in a conversation, in the Sessions tab's transcript viewer and its Markdown export: the user stopped the agent's turn." }),
  apiError: msg({ id: 'providers.transcript.apiError', defaultMessage: 'API error', description: "A notice in a conversation, in the Sessions tab's transcript viewer and its Markdown export: the coding agent's model API failed, with no message of its own." }),
  turnEnded: msg({ id: 'providers.transcript.turnEnded', defaultMessage: 'Turn ended: {reason}', description: "A notice in a conversation, in the Sessions tab's transcript viewer and its Markdown export: the turn ended early. {reason} is the coding agent's own word for why (timeout), in English." }),
  aborted: msg({ id: 'providers.transcript.aborted', defaultMessage: 'Turn ended: aborted', description: "A notice in a conversation, in the Sessions tab's transcript viewer and its Markdown export: the turn ended early, for no reason given." }),
  resumed: msg({ id: 'providers.transcript.resumed', defaultMessage: 'Session resumed', description: "A notice in a conversation, in the Sessions tab's transcript viewer and its Markdown export: the conversation was resumed here (GitHub Copilot)." })
}

/** A notice of Combwork's: its English text (the transcript's own words, as cached) and the same as data, for the window. */
// window: a notice in the window's view of a conversation (transcripts.ts shownNotice); no agent reads it
export const noticeOf = (message: Text, level: 'info' | 'error'): { kind: 'notice'; text: string; level: 'info' | 'error'; message: Text } => ({ kind: 'notice', text: englishText(message), level, message })

/** A notice's text in the language the window shows: Combwork's own words translated, a CLI's as they are. */
export const shownNotice = (item: { text: string; message?: Text }): string => (item.message ? shownText(item.message) : item.text)

export function itemText(item: TranscriptItem): string {
  switch (item.kind) {
    case 'tool':
      return [item.tool.name, item.tool.summary, item.tool.input, item.tool.result ?? ''].join('\n')
    case 'compaction':
      return item.summary ?? ''
    case 'command':
      return [item.name, item.args, item.output].join('\n')
    case 'notice':
      return shownNotice(item)
    default:
      return item.text
  }
}

/** Case-insensitive plain-text search. Snippets show the text around the first match in each item. */
export function searchItems(items: TranscriptItem[], query: string, limit = 200): { hits: TranscriptSearchHit[]; more: boolean } {
  const q = query.trim().toLowerCase()
  const hits: TranscriptSearchHit[] = []
  if (!q) return { hits, more: false }
  for (const item of items) {
    const text = itemText(item)
    const at = text.toLowerCase().indexOf(q)
    if (at === -1) continue
    if (hits.length === limit) return { hits, more: true }
    const from = Math.max(0, at - 60)
    const snippet = (from ? '…' : '') + text.slice(from, at + q.length + 100).replace(/\s+/g, ' ').trim() + (at + q.length + 100 < text.length ? '…' : '')
    hits.push({ itemId: item.id, kind: item.kind, snippet })
  }
  return { hits, more: false }
}

/** A code fence longer than any run of backticks in the text. */
function fence(text: string, lang = ''): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  const f = '`'.repeat(longest + 1)
  return `${f}${lang}\n${text}\n${f}` // i18n-ignore: Markdown's code fence
}

const when = (ts: string | null): string => (ts ? formatDateTime(ts) : '')

/** The conversation as Markdown, with tool calls, thinking and summaries in collapsible sections. */
export function transcriptMarkdown(items: TranscriptItem[], title: string, subtitle: string, assistant = 'Claude' /* i18n-ignore: the model's name */): string {
  const out: string[] = [`# ${title}`, '', subtitle, '']
  let speaker: 'user' | 'assistant' | null = null
  const heading = (who: 'user' | 'assistant', ts: string | null): void => {
    if (speaker === who) return
    speaker = who
    out.push(`## ${who === 'user' ? tr(msg({ id: 'providers.export.you', defaultMessage: 'You', description: "The Markdown export of a conversation (Sessions tab → Export): the heading over the user's messages." })) : assistant}${when(ts) ? ` · ${when(ts)}` : ''}`, '')
  }
  const details = (summary: string, body: string): void => {
    out.push('<details>', `<summary>${summary.replace(/</g, '&lt;')}</summary>`, '', body, '', '</details>', '')
  }
  for (const item of items) {
    switch (item.kind) {
      case 'user':
        heading('user', item.timestamp)
        out.push(item.text, '')
        for (const img of item.images) out.push(img.path ? tr(msg({ id: 'providers.export.imageAt', defaultMessage: '*[Image: {path}]*', description: 'The Markdown export of a conversation (Sessions tab → Export): an image the user sent, where the conversation had it. *[…]* is Markdown: keep the marks. {path} is its file.' }), { path: img.path }) : tr(msg({ id: 'providers.export.image', defaultMessage: '*[Image]*', description: 'The Markdown export of a conversation (Sessions tab → Export): an image the user sent. *[…]* is Markdown: keep the marks.' })), '')
        speaker = 'user'
        break
      case 'assistant':
        heading('assistant', item.timestamp)
        out.push(item.text, '')
        break
      case 'thinking':
        heading('assistant', item.timestamp)
        details(tr(msg({ id: 'providers.export.thinking', defaultMessage: 'Thinking', description: "The Markdown export of a conversation (Sessions tab → Export): the summary of a collapsed section holding the model's thinking." })), item.text)
        break
      case 'tool': {
        heading('assistant', item.timestamp)
        const t = item.tool
        const body = [fence(t.input)]
        if (t.result !== null) body.push('', t.isError ? tr(msg({ id: 'providers.export.error', defaultMessage: '**Error:**', description: "The Markdown export of a conversation (Sessions tab → Export): over a tool call's failed result. **…** is Markdown bold: keep the marks." })) : tr(msg({ id: 'providers.export.result', defaultMessage: '**Result:**', description: "The Markdown export of a conversation (Sessions tab → Export): over a tool call's result. **…** is Markdown bold: keep the marks." })), '', fence(t.result))
        details(`${t.name}${t.summary ? `: ${t.summary}` : ''}`, body.join('\n'))
        break
      }
      case 'compaction':
        speaker = null
        out.push('---', '', `${tr(msg({ id: 'providers.export.compacted', defaultMessage: '**Conversation compacted** ({trigger}) · {before} → {after} tokens', description: 'The Markdown export of a conversation (Sessions tab → Export): where the conversation was compacted. **…** is Markdown bold: keep the marks. {trigger} is how (auto or manual, in English); {before} and {after} its size in tokens (12.3k).' }), { trigger: item.trigger, before: formatTokens(item.preTokens), after: formatTokens(item.postTokens) })}${when(item.timestamp) ? ` · ${when(item.timestamp)}` : ''}`, '')
        if (item.summary) details(tr(msg({ id: 'providers.export.summary', defaultMessage: 'Summary', description: "The Markdown export of a conversation (Sessions tab → Export): the summary of a collapsed section holding a compaction's summary." })), item.summary)
        out.push('---', '')
        break
      case 'command':
        speaker = null
        out.push(`> \`${item.name === '!' ? `! ${item.args}` : `${item.name}${item.args ? ` ${item.args}` : ''}`}\``, '')
        if (item.output) out.push(fence(item.output), '')
        break
      case 'notice':
        out.push(`> *${shownNotice(item).replace(/\n+/g, ' ')}*`, '')
        break
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}
