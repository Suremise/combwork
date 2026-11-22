// HI-3504: a confirmation whose action is a cancel-like word (Abort, Skip, End bisect, Undo) must not read the same as
// the dialog's own Cancel in any language: de, es and fr had Abbrechen/Cancelar/Annuler on both buttons of Abort's,
// and fr had Annuler on both of the Assistant's Undo. A language missing a translation shows the English.
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, resolve } from 'path'

const LOCALES = resolve(__dirname, '..', 'locales')
const CANCEL = 'shell.dialog.cancel'
/** The confirm buttons of dialogs that keep the default Cancel, whose action is a cancel-like word. */
const CONFIRMS = ['git.operation.abort', 'git.operation.skip', 'git.operation.endBisect', 'assistant.undo.confirm']

const translations = (code: string): Record<string, string> => {
  const all: Record<string, string> = {}
  for (const f of readdirSync(join(LOCALES, code)).filter((name) => name.endsWith('.json'))) Object.assign(all, JSON.parse(readFileSync(join(LOCALES, code, f), 'utf8')))
  return all
}
const english = (): Record<string, string> => {
  const all: Record<string, string> = {}
  for (const f of readdirSync(join(LOCALES, 'en')).filter((name) => name.endsWith('.json'))) for (const [id, m] of Object.entries(JSON.parse(readFileSync(join(LOCALES, 'en', f), 'utf8')) as Record<string, { defaultMessage: string }>)) all[id] = m.defaultMessage
  return all
}
const codes = readdirSync(LOCALES).filter((d) => !d.startsWith('.') && d !== 'en' && statSync(join(LOCALES, d)).isDirectory())

describe('confirm buttons beside Cancel (HI-3504)', () => {
  const en = english()
  it('names messages that exist', () => {
    for (const id of [CANCEL, ...CONFIRMS]) expect(en[id], id).toBeTypeOf('string')
    expect(codes.length).toBeGreaterThanOrEqual(7)
  })
  it.each(['en', ...codes])('%s: each reads differently from Cancel', (code) => {
    const t = code === 'en' ? en : { ...en, ...translations(code) }
    const cancel = t[CANCEL].trim().toLocaleLowerCase(code)
    expect(CONFIRMS.filter((id) => t[id].trim().toLocaleLowerCase(code) === cancel)).toEqual([])
  })
})
