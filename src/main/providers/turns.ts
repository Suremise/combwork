import type { TranscriptTurn } from './types'

/**
 * What every provider's transcript turn reader keeps between reads (#1371): the turns whose prompt it read, by id, in the
 * order read, with when and whether worked. Bounded: the oldest go first (a turn that old was settled long ago).
 */
export interface TurnsMemo {
  turns: Map<string, { at: number; worked: boolean; prompt?: string }>
}

const MAX_TURNS = 500

/** A prompt's text as compared between a hook and the transcript (#1371, Copilot): its words, spaced once, at most 500 characters. */
export const promptKey = (text: string): string => text.trim().replace(/\s+/g, ' ').slice(0, 500)

export const turnsMemo = (memo: Record<string, unknown>): TurnsMemo => (memo.turns ??= { turns: new Map() }) as TurnsMemo

/** A prompt of a turn was read: kept (once) from now on. */
export function promptRead(m: TurnsMemo, id: string, at: number, touched: Set<string>, prompt?: string): void {
  if (!m.turns.has(id)) {
    m.turns.set(id, { at, worked: false, ...(prompt ? { prompt } : {}) })
    if (m.turns.size > MAX_TURNS) m.turns.delete(m.turns.keys().next().value!)
  }
  touched.add(id)
}

/** The model took up a turn whose prompt was read (one not read is unknown, never a turn). */
export function workRead(m: TurnsMemo, id: string, touched: Set<string>): void {
  const t = m.turns.get(id)
  if (!t) return
  t.worked = true
  touched.add(id)
}

/** The turns this read touched, as they stand now. */
export function touchedTurns(m: TurnsMemo, touched: Set<string>): TranscriptTurn[] {
  return [...touched].flatMap((id) => {
    const t = m.turns.get(id)
    return t ? [{ id, at: t.at, worked: t.worked, ...(t.prompt ? { prompt: t.prompt } : {}) }] : []
  })
}

/** Each whole line's JSON object (lines that aren't one are skipped: a partial first line, a damaged one). */
export function* jsonLines(appended: string): Generator<Record<string, any>> {
  for (const line of appended.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    try {
      const o = JSON.parse(s)
      if (o && typeof o === 'object') yield o
    } catch {
      // Not a whole record.
    }
  }
}

/** A record's time (Unix ms), or NaN. */
export const timeOf = (v: unknown): number => (typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v : NaN)
