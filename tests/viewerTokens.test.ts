// The Agent API's viewer tokens (#620): why one isn't made is the window's text (HI-2459), shown in Settings → Agent API
// → Viewer tokens in the user's language, with its English for the log.
import { readdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { setLanguage } from '../src/shared/i18n'
import { tempDir } from './tempDir'

const base = tempDir('hive-viewer-tokens-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => base
afterAll(() => rmSync(base, { recursive: true, force: true }))
afterEach(() => setLanguage('en', {}))

const { createViewerToken, viewerTokens } = await import('../src/main/viewerTokens')
const { HiveError, shownError, windowError } = await import('../src/main/hiveError')

/** What the window is told, as the IPC layer sends it. */
const told = async (p: Promise<unknown>): Promise<{ english: string; shown: string }> => {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(HiveError)
    return { english: (e as Error).message, shown: (windowError(e) as Error).message }
  }
  throw new Error('not refused')
}

const locale = (code: string): Record<string, string> => {
  const dir = join(__dirname, '..', 'locales', code)
  return Object.assign({}, ...readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))))
}

describe('a viewer token refused', () => {
  it('says why in English as before', async () => {
    expect((await told(createViewerToken('  '))).english).toBe('Give the viewer token a name, such as the app it is for')
    expect((await told(createViewerToken('x'.repeat(41)))).english).toBe("A viewer token's name is at most 40 characters")
    await createViewerToken('Apiary')
    expect((await told(createViewerToken('apiary'))).english).toBe('There is already a viewer token named "apiary"')
    for (let i = viewerTokens().length; i < 20; i++) await createViewerToken(`app ${i}`)
    expect((await told(createViewerToken('one more'))).english).toBe('Hive keeps at most 20 viewer tokens: revoke one first')
  })

  it("and in the language Hive shows, with the log's English kept", async () => {
    setLanguage('de', locale('de'))
    const r = await told(createViewerToken(''))
    expect(r.shown).toBe('Gib dem Lese-Token einen Namen, etwa den der App, für die es ist')
    expect(r.english).toBe('Give the viewer token a name, such as the app it is for')
    expect((await told(createViewerToken('x'.repeat(41)))).shown).toBe('Der Name eines Lese-Tokens hat höchstens 40 Zeichen')
    // Apiary is the first test's (a name is checked before the count).
    expect((await told(createViewerToken('APIARY'))).shown).toBe('Es gibt bereits ein Lese-Token namens „APIARY“')
    expect(shownError(new HiveError('plain'))).toBe('plain')
  })
})
