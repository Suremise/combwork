/**
 * A refusal's or a wrong call's reason as the Performance view says it (HI-2553 round 1): the metrics keep only its
 * label (`rule:<id>`, `msg:<id>`, `other`: shared/metrics.ts REASON_LABEL), never the text it was said with, so a reason
 * is said again as a general sentence (trTemplate: its placeholders "…"), in the window's language. A rule's is its
 * refusal's first sentence (REFUSALS); a message's, the message of that id, found in the English catalogue
 * (`locales/en/<area>.json`, loaded only when the table has such a reason; the translations are the window's own).
 */
// Relative, not @shared: tests (tsconfig.node) import this file too.
import { trTemplate, type Msg } from '../../../shared/i18n'
import { REFUSALS, type RuleId } from '../../../shared/workflow/refusals'

type Entry = { defaultMessage: string; description?: string }
const EN = import.meta.glob<{ default: Record<string, Entry> }>('../../../../locales/en/*.json')
const areas = new Map<string, Promise<Record<string, Entry> | null>>()

/** The English catalogue of an area (`board`, `tasks`…), loaded once; null when there is none. */
function area(name: string): Promise<Record<string, Entry> | null> {
  let p = areas.get(name)
  if (!p) {
    const load = EN[`../../../../locales/en/${name}.json`]
    p = load ? load().then((m) => m.default, () => null) : Promise.resolve(null)
    areas.set(name, p)
  }
  return p
}

/** The messages the `msg:` reasons name, by reason; a reason whose message isn't found has none. */
export async function reasonMessages(reasons: readonly string[]): Promise<Record<string, Msg>> {
  const out: Record<string, Msg> = {}
  for (const r of reasons) {
    if (!r.startsWith('msg:')) continue
    const id = r.slice(4)
    const e = (await area(id.split('.')[0]))?.[id]
    if (e && typeof e.defaultMessage === 'string') out[r] = { id, defaultMessage: e.defaultMessage, description: e.description ?? '' }
  }
  return out
}

/** A reason as a sentence; null when it can't be said (`other`, a rule or message this Combwork doesn't know). */
export function reasonSentence(reason: string, messages: Record<string, Msg>): string | null {
  if (reason.startsWith('rule:')) {
    const text = REFUSALS[reason.slice(5) as RuleId]
    return text ? trTemplate(text.message) : null
  }
  const m = messages[reason]
  return m ? trTemplate(m) : null
}
