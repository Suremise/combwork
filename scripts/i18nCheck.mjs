// The blocking check of the translations (#768): `npm run i18n:check` fails (exit 1) on a translation that would show
// wrong, never on one that is missing (a missing message shows in English: `npm run i18n:coverage` reports those):
//   - an extra key: an id the English catalogue doesn't have (renamed or removed in the code);
//   - a message that isn't valid ICU, or whose structure differs from the English: a placeholder renamed or dropped
//     ({name} → {nazwa}), a plural without `other`, a tag that isn't the English's;
//   - a file that isn't an object of texts, or a message filed under another area's file;
//   - a control character (U+0000–U+001F, U+007F) in a translation, but for a line break where the English has one, or
//     a lone surrogate: formatjs verify lets both through, and the window shows them as ▯ (#888).
// It runs `formatjs verify --source-locale en --extra-keys --structural-equality` (without --missing-keys) once per
// language, over every area's English (locales/en/<area>.json) and that language's files (locales/<code>/<area>.json).
// Where FormatJS's CLI has no native binding (Windows on Arm), or with --js, the same checks run here with FormatJS's
// own parser. tests/i18nCatalogues.test.ts runs this in `npm test` and CI, and checks the two ways agree.
// A value the English doesn't use but the code passes too, for a language that wants it (ALTERNATE_VALUES, #904), counts
// as the English placeholder it stands in for, in both ways.
import { spawnSync } from 'child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { isStructurallySame, parse } from '@formatjs/icu-messageformat-parser'
import { areaOf, cliBin, EN_DIR, hasNativeCli, ROOT, rootArg } from './i18nExtract.mjs'

/** The languages with a folder in locales/, English and .source aside. */
export const translatedLanguages = (root = ROOT) =>
  existsSync(join(root, 'locales'))
    ? readdirSync(join(root, 'locales'), { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== 'en' && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort()
    : []

/** The English messages, every area merged: id → its English. */
export function englishMessages(root = ROOT) {
  const out = {}
  const dir = join(root, EN_DIR)
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort())
    for (const [id, m] of Object.entries(JSON.parse(readFileSync(join(dir, f), 'utf8')))) out[id] = m.defaultMessage
  return out
}

const codePoint = (ch) => `U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`

/**
 * What's wrong with a translation's characters, which formatjs verify lets through (#888: a `\1` a heredoc made U+0001,
 * shown as ▯): a control character (U+0000–U+001F, U+007F), but for a line break where the English has one, and a lone
 * surrogate (half of a pair, from an escape in the JSON).
 */
export function characterProblems(text, english = '') {
  const problems = []
  const controls = [...new Set(text.match(/[\u0000-\u001f\u007f]/g) ?? [])]
  const breaks = controls.includes('\n') && !english.includes('\n')
  const others = controls.filter((ch) => ch !== '\n')
  if (others.length) problems.push(`has a control character (${others.map(codePoint).join(', ')})`)
  if (breaks) problems.push("has a line break (U+000A) the English hasn't")
  const lone = [...new Set(text.match(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g) ?? [])]
  if (lone.length) problems.push(`has a lone surrogate (${lone.map(codePoint).join(', ')})`)
  return problems
}

/** A language's translations, every area merged, and what's wrong with its files themselves (not an object, not text, a message in another area's file, a control character). */
export function readLanguage(root, code, english = englishMessages(root)) {
  const messages = {}
  const problems = []
  const dir = join(root, 'locales', code)
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    let data
    try {
      data = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    } catch (e) {
      problems.push(`${code}/${f}: not JSON (${String(e.message).split(/\r?\n/)[0]})`)
      continue
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      problems.push(`${code}/${f}: not an object of messages (id → text)`)
      continue
    }
    const area = f.slice(0, -'.json'.length)
    for (const [id, text] of Object.entries(data)) {
      if (typeof text !== 'string') problems.push(`${code}/${f}: ${id} is not text`)
      else if (areaOf(id) !== area) problems.push(`${code}/${f}: ${id} belongs in ${code}/${areaOf(id)}.json`)
      else {
        for (const p of characterProblems(text, english[id])) problems.push(`${code}/${f}: ${id} ${p}`)
        messages[id] = text
      }
    }
  }
  return { messages, problems }
}

/**
 * Values the code passes beside the English's for a language that wants them, which a translation may write in place of
 * the English placeholder (id → { alternate: the placeholder it stands in for }). The message's description tells
 * translators of it (a unit test checks). #904: mode names each in its own quotes, for languages that quote them.
 */
export const ALTERNATE_VALUES = {
  'settings.provider.enableDangerousMode.confirm.title': { quotedNames: 'names' },
  'settings.provider.enableDangerousMode.tip': { quotedNames: 'names' },
  'settings.provider.enableDangerousMode.title': { quotedNames: 'names' }
}

/** A translation as the structural check reads it: each alternate value it uses (a plain `{quotedNames}`) as the placeholder it stands in for. */
export function asEnglishPlaceholders(id, text) {
  let out = text
  for (const [alt, name] of Object.entries(ALTERNATE_VALUES[id] ?? {})) out = out.replace(new RegExp(`\\{\\s*${alt}\\s*\\}`, 'g'), `{${name}}`)
  return out
}

/** The checks with FormatJS's parser, as `formatjs verify --extra-keys --structural-equality` makes them. */
export function verifyWithJs(english, translated) {
  const problems = []
  for (const id of Object.keys(translated)) if (!(id in english)) problems.push(`${id}: an extra key (the English has no such message)`)
  for (const [id, source] of Object.entries(english)) {
    // An empty translation is a missing one: it shows in English.
    if (!translated[id]) continue
    try {
      const r = isStructurallySame(parse(source), parse(translated[id]))
      if (!r.success) problems.push(`${id}: ${r.error?.message ?? 'structurally different from the English'}`)
    } catch (e) {
      problems.push(`${id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return problems
}

/** The same checks by `formatjs verify`: each problem as a line of its report. */
export function verifyWithCli(code, english, translated) {
  const dir = mkdtempSync(join(tmpdir(), 'cw-i18n-check-'))
  try {
    writeFileSync(join(dir, 'en.json'), JSON.stringify(english))
    writeFileSync(join(dir, `${code}.json`), JSON.stringify(translated))
    // Relative names: verify takes each file's locale from its name, and its file patterns are globs, which a Windows path breaks.
    const r = spawnSync(process.execPath, [cliBin(), 'verify', '--source-locale', 'en', '--extra-keys', '--structural-equality', 'en.json', `${code}.json`], { cwd: dir, encoding: 'utf8' })
    if (r.status === 0) return []
    const lines = `${r.stderr}\n${r.stdout}`.split(/\r?\n/).filter((l) => l.trim() && !/^-+$/.test(l.trim()))
    return lines.length ? lines : [`formatjs verify failed (exit ${r.status})`]
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Every language's problems (code → lines), and which way they were checked. */
export function checkTranslations(root = ROOT, { js = !hasNativeCli() } = {}) {
  const english = englishMessages(root)
  const results = {}
  for (const code of translatedLanguages(root)) {
    const { messages: read, problems } = readLanguage(root, code, english)
    const messages = Object.fromEntries(Object.entries(read).map(([id, text]) => [id, asEnglishPlaceholders(id, text)]))
    results[code] = [...problems, ...(js ? verifyWithJs(english, messages) : verifyWithCli(code, english, messages))]
  }
  return { results, engine: js ? 'js' : 'cli' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { results, engine } = checkTranslations(rootArg(), process.argv.includes('--js') ? { js: true } : undefined)
  let failed = false
  for (const [code, problems] of Object.entries(results)) {
    if (!problems.length) {
      console.log(`${code}: ok`)
      continue
    }
    failed = true
    console.log(`${code}: ${problems.length} to fix (they show in English until fixed)\n  ${problems.join('\n  ')}`)
  }
  console.log(`i18n:check: languages ${Object.keys(results).join(', ') || 'none'}, checked with ${engine === 'cli' ? 'formatjs verify' : "FormatJS's parser"}${failed ? '; FAILED' : ''}`)
  process.exit(failed ? 1 : 0)
}
