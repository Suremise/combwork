/**
 * The Combwork tool list's size as a CLI gets it (HI-2049, HI-2063): characters of its JSON (UTF-16 code units), and of
 * them, the tools' descriptions and their parameters' descriptions (every `description` string inside an inputSchema,
 * nested properties and items too), each as the JSON has it (escapes included, quotes not). The rest of the list, its
 * schemas and structure (names, types, enums, keys, JSON punctuation), is `toolsChars - descriptionChars - paramChars`.
 * Measures the list it is given without changing it.
 */
export function toolListSize(list: readonly { description?: unknown; inputSchema?: unknown }[]): { toolsChars: number; descriptionChars: number; paramChars: number } {
  const inJson = (s: string): number => JSON.stringify(s).length - 2
  let descriptionChars = 0
  let paramChars = 0
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) for (const x of v) walk(x)
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        // A parameter named "description" is an object here, walked like any other: only a string is a description.
        if (k === 'description' && typeof x === 'string') paramChars += inJson(x)
        else walk(x)
      }
  }
  for (const t of list) {
    if (typeof t.description === 'string') descriptionChars += inJson(t.description)
    walk(t.inputSchema)
  }
  return { toolsChars: JSON.stringify(list).length, descriptionChars, paramChars }
}
