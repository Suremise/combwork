// HI-3560 (HI-3541's decision, HI-3553/r9 point 6: a hint only, never required, never a gate): who wrote a pull
// request, when it says so itself: a `Co-Authored-By` trailer in one of its commits naming an AI model, else its body
// ("Generated with Claude Code"). Matched against each provider's own names (its assistant's, its product's and its
// company's, from its descriptor), never by a provider's id; an email's domain alone is never taken for a model (a
// human's GitHub noreply address would read as Copilot's). Pure.

/** A provider as authorship matches it: its id and the names its descriptor gives it. */
export interface ProviderNames {
  id: string
  /** Product name: "Claude Code". */
  name: string
  /** The assistant: "Claude". */
  assistant: string
  company: string
}

/** Who wrote a pull request, as it says: the name it gave (a model's, as written), the provider that runs it, and where it said so. */
export interface PrAuthorship {
  name: string
  /** The provider whose names it matched; null: an AI named that no provider here runs. */
  provider: string | null
  from: 'trailer' | 'body'
}

/** The most a name kept from a pull request is (characters): GitHub's text, shown to the user only. */
const NAME_MAX = 80

const words = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
/** Whether `text` holds `name` as whole words (case aside). */
const holds = (text: string, name: string): boolean => {
  const n = words(name)
  return !!n && ` ${words(text)} `.includes(` ${n} `)
}

/** The provider a name is of: its assistant's, product's or company's name in it, the longest match first. */
export function providerNamed(name: string, providers: readonly ProviderNames[]): string | null {
  const found = providers.flatMap((p) => [p.name, p.assistant, p.company].filter((x) => x && holds(name, x)).map((x) => ({ id: p.id, len: x.length })))
  found.sort((a, b) => b.len - a.len)
  return found[0]?.id ?? null
}

/**
 * Who wrote a pull request, from its commits' messages (their `Co-Authored-By` trailers naming a provider's model, the
 * first found) and its body (a "Generated with …" or "written by …" line naming one), or null when it doesn't say.
 */
export function prAuthorship(messages: readonly string[], body: string, providers: readonly ProviderNames[]): PrAuthorship | null {
  for (const m of messages) {
    for (const t of m.matchAll(/^co-authored-by:\s*([^<\r\n]+?)\s*(?:<[^>\r\n]*>)?\s*$/gim)) {
      const name = t[1].trim().slice(0, NAME_MAX)
      const provider = providerNamed(name, providers)
      if (provider) return { name, provider, from: 'trailer' }
    }
  }
  for (const line of body.split(/\r?\n/)) {
    const said = /\b(?:generated|written|drafted|created|authored|made)\s+(?:with|by|using)\s+\[?([^\]\r\n()]{2,80})/i.exec(line)
    if (!said) continue
    const name = said[1].replace(/[*_`]/g, '').trim().slice(0, NAME_MAX)
    const provider = providerNamed(name, providers)
    if (provider) return { name, provider, from: 'body' }
  }
  return null
}
