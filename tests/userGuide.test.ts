// The user guide's heading ids (#1535): every heading has an explicit id (`<a id="…"></a>`), and every link into the
// guide (tips, Settings, the window's Learn more links, the guide's own #links, the README's) names one, so renaming a
// heading keeps its links.
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { docOutline, headingId } from '../src/shared/docSections'
import { TIPS } from '../src/shared/tips'
import { SETTINGS_CATALOG } from '../src/shared/settingsCatalog'
import { BOARD_UPGRADE_GUIDE } from '../src/shared/userGuide'
import { GIT_VIEW_GUIDE } from '../src/shared/gitRepo'
import { GIT_GUIDE } from '../src/shared/gitTool'
import { HIVE_FOLDER_GUIDE } from '../src/shared/hiveVcsText'
import { UNUSED_WORKTREES_GUIDE } from '../src/shared/unusedWorktrees'

const root = join(__dirname, '..')
const guide = readFileSync(join(root, 'docs', 'USER_GUIDE.md'), 'utf8')
const ids = (md: string): Set<string> => new Set(docOutline(md).filter((h) => h.fixed).map((h) => h.slug))

/** The window's links that aren't tips or settings, by the constant `openGuideAt` is called with. */
const CONSTANTS: Record<string, string> = { BOARD_UPGRADE_GUIDE, GIT_VIEW_GUIDE, GIT_GUIDE, HIVE_FOLDER_GUIDE, UNUSED_WORKTREES_GUIDE }

/** Every link the app makes into the guide, each with where it comes from. */
const appLinks = (): [string, string][] => [
  ...TIPS.filter((t) => t.docs).map((t): [string, string] => [`tip ${t.id}`, t.docs!]),
  ...SETTINGS_CATALOG.map((e): [string, string] => [`setting ${e.id}`, e.docs]),
  ...Object.entries(CONSTANTS)
]

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? sources(join(dir, d.name)) : /\.tsx?$/.test(d.name) ? [join(dir, d.name)] : []))

describe("the user guide's heading ids", () => {
  it('every heading has an explicit id, unique, in slug form', () => {
    const outline = docOutline(guide)
    expect(outline.length).toBeGreaterThan(50)
    const shared = outline.filter((h) => h.sharedId).map((h) => `line ${h.line}: ${h.text} (${h.sharedId})`)
    expect(shared, 'an id two headings carry (a copied heading): give the new one its own').toEqual([])
    const without = outline.filter((h) => !h.fixed).map((h) => `line ${h.line}: ${h.text}`)
    expect(without, 'a heading without an id: end it with <a id="its-slug"></a> (its slug as cw_doc_outline lists it, then never change the id)').toEqual([])
    expect(new Set(outline.map((h) => h.slug)).size).toBe(outline.length)
    for (const h of outline) expect(h.slug, h.text).toMatch(/^[a-z0-9][a-z0-9_-]*$/)
  })

  it('every link the app makes names a heading id: tips, settings and the Learn more links', () => {
    const known = ids(guide)
    const broken = appLinks().filter(([, id]) => !known.has(id))
    expect(broken, 'a link to a heading id the guide lacks (a link names the id, never the heading text)').toEqual([])
  })

  it("the window calls openGuideAt only with a tip's docs or a constant checked here", () => {
    const calls = sources(join(root, 'src', 'renderer', 'src')).flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/openGuideAt\(([^)]*)\)/g)].map((m) => m[1].trim()))
    const unchecked = calls.filter((a) => a !== 'id: string' && a !== 'tip.docs!' && !(a in CONSTANTS))
    expect(unchecked, 'a new Learn more link: put its id in a shared constant and add it to CONSTANTS here').toEqual([])
  })

  it("the guide's own #links and the README's links into it name heading ids", () => {
    const known = ids(guide)
    const own = [...guide.matchAll(/\]\(#([^)\s]+)\)/g)].map((m) => m[1])
    expect(own.length).toBeGreaterThan(20)
    expect(own.filter((id) => !known.has(id))).toEqual([])
    const readme = readFileSync(join(root, 'README.md'), 'utf8')
    expect([...readme.matchAll(/USER_GUIDE\.md#([^)\s]+)/g)].map((m) => m[1]).filter((id) => !known.has(id))).toEqual([])
  })

  it('a renamed heading keeps its links: every heading renamed, every link still finds its heading', () => {
    let n = 0
    const renamed = guide.replace(/^(#{1,6}) (.*?)( <a id="[^"]+"><\/a>)(?=\r?$)/gm, (_, marks: string, _text: string, anchor: string) => `${marks} Renamed heading ${++n}${anchor}`)
    expect(n).toBe(docOutline(guide).length)
    const outline = docOutline(renamed)
    expect(outline.every((h) => h.text.startsWith('Renamed heading'))).toBe(true)
    const known = ids(renamed)
    expect(appLinks().filter(([, id]) => !known.has(id))).toEqual([])
    // As the Docs view and a card's reference find one: by its id, and the text is the new one.
    const tip = TIPS.find((t) => t.docs)!
    expect(outline.find((h) => h.slug === tip.docs)?.text).toMatch(/^Renamed heading/)
    expect(headingId(renamed.split(/\r?\n/).find((l) => l.endsWith(`<a id="${tip.docs}"></a>`))!)).toBe(tip.docs)
  })
})
