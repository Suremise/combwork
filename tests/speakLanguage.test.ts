// HI-3434: lib.speakLanguage tells a test window a language by code, main reading its catalogue, so no whole catalogue
// (about 1.4 MB) crosses Playwright's app.evaluate, by Node's inspector (HI-3428: its I/O thread crashed the test app's
// main process under load). What the helper sends is checked here with a stub app; the function it runs is run as main
// would, with a stub window, to see the event the window gets.
import { readdirSync, readFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

type Language = { code: string; locale: string; messages: Record<string, string>; [k: string]: unknown }
type Sent = { base: Language; code?: string; dir: string | null }
const { speakLanguage, ROOT } = createRequire(import.meta.url)('./e2e/lib.cjs') as {
  speakLanguage: (app: unknown, base: Language, code?: string) => Promise<Record<string, string> | null>
  ROOT: string
}

const catalogue = (code: string) => Object.assign({}, ...readdirSync(join(ROOT, 'locales', code)).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(ROOT, 'locales', code, f), 'utf8'))))

/** A stub app: what crosses app.evaluate (its argument, and its size as Playwright sends it), and the event the window gets. */
function stubApp() {
  const seen: { said: Sent[]; bytes: number[]; events: { type: string; language: Language }[] } = { said: [], bytes: [], events: [] }
  const app = {
    evaluate: async (fn: (electron: unknown, arg: Sent) => void, arg: Sent) => {
      seen.said.push(arg)
      seen.bytes.push(JSON.stringify(arg).length)
      fn({ BrowserWindow: { getAllWindows: () => [{ webContents: { send: (_channel: string, ev: { type: string; language: Language }) => seen.events.push(ev) } }] } }, arg)
    }
  }
  return { app, seen }
}

/** Small enough that no catalogue is in it: a language's info without messages is a few hundred bytes. */
const SMALL = 4096

describe('lib.speakLanguage sends no catalogue through app.evaluate (HI-3434)', () => {
  const english: Language = { code: 'en', locale: 'en-GB', messages: {}, forced: 'en' }

  it('English back: the window is sent its language as it was, with nothing to read', async () => {
    const { app, seen } = stubApp()
    expect(await speakLanguage(app, english)).toBeNull()
    expect(seen.said[0].dir).toBeNull()
    expect(seen.events).toEqual([{ type: 'language-changed', language: english }])
  })

  it('a language by its code: main reads its catalogue, only the code crosses', async () => {
    const { app, seen } = stubApp()
    const de = catalogue('de')
    expect(await speakLanguage(app, english, 'de')).toEqual(de)
    expect(seen.bytes[0]).toBeLessThan(SMALL)
    expect(seen.events[0].language).toEqual({ ...english, code: 'de', locale: 'de', messages: de })
  })

  it("a base with translations of its own (an app started in Japanese) isn't sent with them", async () => {
    const japanese: Language = { code: 'ja', locale: 'ja-JP', messages: catalogue('ja') }
    expect(JSON.stringify(japanese).length).toBeGreaterThan(SMALL)
    const { app, seen } = stubApp()
    // Another language: lanestages' pt-BR from a Japanese app.
    await speakLanguage(app, japanese, 'pt-BR')
    expect(seen.bytes[0]).toBeLessThan(SMALL)
    expect(seen.events[0].language).toEqual({ code: 'pt-BR', locale: 'pt-BR', messages: catalogue('pt-BR') })
    // Back to its own (i18nshots' git forms after their English step): by its code, its locale kept.
    await speakLanguage(app, japanese)
    expect(seen.bytes[1]).toBeLessThan(SMALL)
    expect(seen.events[1].language).toEqual(japanese)
  })

  it('the pseudo-locale, which has no catalogue, is sent as it is', async () => {
    const pseudo: Language = { code: 'en-XA', locale: 'en-XA', messages: {} }
    const { app, seen } = stubApp()
    await speakLanguage(app, pseudo)
    expect(seen.said[0].dir).toBeNull()
    expect(seen.events[0].language).toEqual(pseudo)
  })
})
