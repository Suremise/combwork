import { join } from 'path'
import { readdirSync, readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'
import { parseMode } from '../src/shared/assistant'
import type { Msg } from '../src/shared/i18n/msg'
import { SHIPPED_MODE_DESCRIPTIONS, SHIPPED_MODE_NAMES } from '../src/shared/modeDescriptions'

// The window shows a shipped mode's name and description translated while its file has Hive's words (#806, #885): each
// message's English must be its mode file's, or the mode falls back to English in every language without anyone
// noticing (#1528 changed two descriptions and not their messages; #1126 found them).
const MODES = join(__dirname, '..', 'resources', 'modes')
const files = readdirSync(MODES).filter((f) => f.endsWith('.md')).map((f) => ({ id: f.slice(0, -3), ...parseMode(readFileSync(join(MODES, f), 'utf8')) }))
const english = (messages: Record<string, Msg>): Record<string, string> => Object.fromEntries(Object.entries(messages).map(([id, m]) => [id, m.defaultMessage]))

describe('shipped mode names and descriptions', () => {
  it('Hive ships modes', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('has a message for each mode Hive ships, with its file name as the English', () => {
    // On a failure: change the message in src/shared/modeDescriptions.ts (SHIPPED_MODE_NAMES) to the name shown here.
    expect(english(SHIPPED_MODE_NAMES)).toEqual(Object.fromEntries(files.map((f) => [f.id, f.name])))
  })

  it("has a message for each mode Hive ships, with its file's description as the English", () => {
    // On a failure: change the message in src/shared/modeDescriptions.ts (SHIPPED_MODE_DESCRIPTIONS) to the description
    // shown here, then translate it in every locale.
    expect(english(SHIPPED_MODE_DESCRIPTIONS)).toEqual(Object.fromEntries(files.map((f) => [f.id, f.description])))
  })
})
