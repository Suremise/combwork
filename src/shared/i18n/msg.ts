/**
 * A message as written in the code (#767): its id, its English and a note for translators. Imports nothing, so data
 * modules that agent scripts also reach (the settings catalogue, the tips) can hold messages without loading FormatJS
 * or a translation: they keep the descriptor, and the window shows it with `tr()` (`shared/i18n`).
 */

/** A message: `msg({ id: 'area.thing', defaultMessage: 'English text', description: 'For translators' })`. */
export interface Msg<Id extends string = string> {
  /** `area.thing`: stable and readable. Changing the English keeps the id (the translations are then flagged outdated). */
  id: Id
  /** The English, in ICU MessageFormat: `{name}`, `{n, plural, one {# card} other {# cards}}`, `<b>tags</b>`. */
  defaultMessage: string
  /** What it is and where it shows, for translators: "Button, keep it short", "{n} is a number of agents". */
  description: string
}

/** Values for a message's placeholders. */
export type Values = Record<string, string | number | boolean | Date | null | undefined>

declare global {
  /**
   * Each message's placeholders and their types, by id: generated per area into `shared/i18n/values/<area>.d.ts`
   * from `locales/en/<area>.json`, so `tr(m, values)` checks the names and types. `undefined`: it takes none.
   */
  interface CombworkMessageValues {}
}

/** The values `tr()` takes for a message: its generated ones, none, or any (a message not generated yet). */
export type MessageArgs<Id extends string> = string extends Id ? [values?: Values] : Id extends keyof CombworkMessageValues ? (CombworkMessageValues[Id] extends undefined ? [] : [values: CombworkMessageValues[Id]]) : [values?: Values]

/** A message, as data. The identity function extraction looks for: keep its argument a literal object. */
export const msg = <const Id extends string>(m: Msg<Id>): Msg<Id> => m
