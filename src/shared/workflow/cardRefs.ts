// Card references in intents (SPEC §16.12, OP-14): a key (`AM-12`) or an old alias (`#1061`). A plain number is refused
// in 1.0: agents' skills and memory pass `1061` meaning the old global card, which after the migration could be another
// project's per-project number.
//
// P2 spike (#1118): not wired into the app yet.

export type CardRef = { key: string; project: string; n: number } | { alias: number }

export type CardRefResult = { ok: true; ref: CardRef } | { ok: false; rule: 'card.plainNumber' }

const KEY = /^([A-Za-z][A-Za-z]{1,3})-(\d+)$/
const ALIAS = /^#(\d+)$/

/** Parses a card reference; a bare number (as a number or a string) is refused with the forms to use. */
export function parseCardRef(ref: unknown): CardRefResult {
  if (typeof ref === 'string') {
    const k = KEY.exec(ref.trim())
    if (k) return { ok: true, ref: { key: `${k[1].toUpperCase()}-${Number(k[2])}`, project: k[1].toUpperCase(), n: Number(k[2]) } }
    const a = ALIAS.exec(ref.trim())
    if (a) return { ok: true, ref: { alias: Number(a[1]) } }
  }
  return { ok: false, rule: 'card.plainNumber' }
}
