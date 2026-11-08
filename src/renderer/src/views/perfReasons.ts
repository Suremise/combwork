/**
 * A refusal's or a wrong call's reason as the Performance view says it (HI-2553 round 1): the metrics keep only its
 * label (`rule:<id>`, `msg:<id>`, `agent:<id>`, `other`: shared/metrics.ts REASON_LABEL), never the text it was said
 * with, so a reason is said again as a general sentence (its placeholders "…"). A rule's is its refusal's first sentence
 * (REFUSALS); a window message's, the message of that id, found in the English catalogue (`locales/en/<area>.json`,
 * loaded only when the table has such a reason; the translations are the window's own), in the window's language.
 * An agent message's (the Agent API's own errors, HI-2681) is its English from the agent-text catalogue
 * (`agent-text/catalogue/<area>.json`): agent text is English only, never a window message, so it is shown as English.
 */
// Relative, not @shared: tests (tsconfig.node) import this file too.
import { trTemplate, type Msg } from '../../../shared/i18n'
import { formatIcu, parseIcu, placeholdersOf } from '../../../shared/agentText/icu'
import { REFUSALS, type RuleId } from '../../../shared/workflow/refusals'

type Entry = { defaultMessage: string; description?: string }
const EN = import.meta.glob<{ default: Record<string, Entry> }>('../../../../locales/en/*.json')
const AGENT = import.meta.glob<{ default: Record<string, { text: string }> }>('../../../../agent-text/catalogue/*.json')
const areas = new Map<string, Promise<Record<string, unknown> | null>>()

/** A catalogue's area (`board`, `tasks`…), loaded once; null when there is none. */
function area<T>(files: Record<string, () => Promise<{ default: Record<string, T> }>>, path: string): Promise<Record<string, T> | null> {
  let p = areas.get(path)
  if (!p) {
    const load = files[path]
    p = load ? load().then((m) => m.default, () => null) : Promise.resolve(null)
    areas.set(path, p)
  }
  return p as Promise<Record<string, T> | null>
}

/** A reason's message, as the table says it: a window message (said in the window's language), or an agent message's English. */
export type ReasonMessage = Msg | { english: string }

/** The messages the `msg:` and `agent:` reasons name, by reason; a reason whose message isn't found has none. */
export async function reasonMessages(reasons: readonly string[]): Promise<Record<string, ReasonMessage>> {
  const out: Record<string, ReasonMessage> = {}
  for (const r of reasons) {
    if (r.startsWith('msg:')) {
      const id = r.slice(4)
      const e = (await area(EN, `../../../../locales/en/${id.split('.')[0]}.json`))?.[id]
      if (e && typeof e.defaultMessage === 'string') out[r] = { id, defaultMessage: e.defaultMessage, description: e.description ?? '' }
    } else if (r.startsWith('agent:')) {
      const id = r.slice(6)
      const e = (await area(AGENT, `../../../../agent-text/catalogue/${id.split('.')[0]}.json`))?.[id]
      if (e && typeof e.text === 'string') out[r] = { english: e.text }
    }
  }
  return out
}

/** An agent message's English as a general sentence, as trTemplate says a window message: a placeholder "…", a count 2, a select its other form. */
export function englishTemplate(text: string): string {
  try {
    const values: Record<string, string | number> = {}
    for (const [name, kind] of Object.entries(placeholdersOf(parseIcu(text)))) values[name] = kind === 'plain' ? '…' : kind === 'select' ? 'other' : kind === 'date' || kind === 'time' ? 0 : 2
    return formatIcu(text, values)
  } catch {
    return text
  }
}

/** A reason as a sentence, and whether it is English whatever the window's language (an agent message); null when it can't be said (`other`, a rule or message this Combwork doesn't know). */
export function reasonSentence(reason: string, messages: Record<string, ReasonMessage>): { text: string; english: boolean } | null {
  if (reason.startsWith('rule:')) {
    const text = REFUSALS[reason.slice(5) as RuleId]
    return text ? { text: trTemplate(text.message), english: false } : null
  }
  const m = messages[reason]
  if (!m) return null
  return 'english' in m ? { text: englishTemplate(m.english), english: true } : { text: trTemplate(m), english: false }
}
