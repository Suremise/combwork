// The Agent API's viewer tokens (#620): why one isn't made is the window's text (HI-2459), shown in Settings → Agent API
// → Viewer tokens in the user's language, with its English for the log. Each test has a profile of its own.
import { readdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
/** The language set by the test that ran last, put back (each test's modules are its own: see fresh()). */
let putBack: (() => void) | null = null
afterEach(() => {
  putBack?.()
  putBack = null
})

/** The viewer tokens module fresh, on an empty profile of its own (its tokens are kept in memory once read). */
async function fresh() {
  const profile = tempDir('hive-viewer-tokens-')
  dirs.push(profile)
  vi.resetModules()
  // Electron's mock as these fresh modules import it.
  const electron = await import('electron')
  ;(electron.app as unknown as { getPath: () => string }).getPath = () => profile
  const { createViewerToken } = await import('../src/main/viewerTokens')
  const { HiveError, windowError } = await import('../src/main/hiveError')
  // The i18n these modules use: a test's language is set here, on the same instance.
  const { setLanguage } = await import('../src/shared/i18n')
  putBack = () => setLanguage('en', {})
  /** What the window is told, as the IPC layer sends it, and the English kept for the log. */
  const told = async (p: Promise<unknown>): Promise<{ english: string; shown: string }> => {
    try {
      await p
    } catch (e) {
      expect(e).toBeInstanceOf(HiveError)
      return { english: (e as Error).message, shown: (windowError(e) as Error).message }
    }
    throw new Error('not refused')
  }
  /** A token for each of 20 apps, the most Hive keeps; the first is Apiary. */
  const fill = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await createViewerToken(i ? `app ${i}` : 'Apiary')
  }
  return { createViewerToken, told, fill, setLanguage }
}

const locale = (code: string): Record<string, string> => {
  const dir = join(__dirname, '..', 'locales', code)
  return Object.assign({}, ...readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))))
}

describe('a viewer token refused', () => {
  it('says why in English as before', async () => {
    const { createViewerToken, told, fill } = await fresh()
    expect((await told(createViewerToken('  '))).english).toBe('Give the viewer token a name, such as the app it is for')
    expect((await told(createViewerToken('x'.repeat(41)))).english).toBe("A viewer token's name is at most 40 characters")
    await fill()
    expect((await told(createViewerToken('apiary'))).english).toBe('There is already a viewer token named "apiary"')
    expect((await told(createViewerToken('one more'))).english).toBe('Hive keeps at most 20 viewer tokens: revoke one first')
  })

  it("and in the language Hive shows, with the log's English kept", async () => {
    const { createViewerToken, told, fill, setLanguage } = await fresh()
    setLanguage('de', locale('de'))
    const r = await told(createViewerToken(''))
    expect(r.shown).toBe('Gib dem Lese-Token einen Namen, etwa den der App, für die es ist')
    expect(r.english).toBe('Give the viewer token a name, such as the app it is for')
    expect((await told(createViewerToken('x'.repeat(41)))).shown).toBe('Der Name eines Lese-Tokens hat höchstens 40 Zeichen')
    await fill()
    expect((await told(createViewerToken('APIARY'))).shown).toBe('Es gibt bereits ein Lese-Token namens „APIARY“')
    const many = await told(createViewerToken('one more'))
    expect(many.shown).toBe('Hive behält höchstens 20 Lese-Tokens: Widerrufe zuerst eines')
    expect(many.english).toBe('Hive keeps at most 20 viewer tokens: revoke one first')
  })
})
