// The i18nshots route's text report (#899): what a screen's layout does to its text, found in the page, so an agent
// reads a short report and opens only the screenshots it flags instead of every image of a language run. Kinds:
//   ellipsis   text cut off with "…" (text-overflow: ellipsis or a line clamp)
//   clipped    text cut off by its own box, with no "…"
//   cut-off    text cut off by a box around it (overflow hidden), at a side or with a line cut or hidden at its top or
//              bottom (out of a scrolling box's view is that box's content: sideways says so, once)
//   outside    text past the window's left or right edge
//   wraps      a short label (a heading, a button, a column header, a badge, a tab) on more than one line
//   mid-word   a word broken across two lines
//   squeezed   a block of text in a narrow column: many short lines
//   overlaps   text drawn over other text nearby
//   sideways   a box that scrolls sideways (a table wider than its pane)
//   english    English left in a translated run: text equal to an English message the language translates differently
// It never fails a run: judging the words and the layout is for whoever reads the report and looks at the images.
const fs = require('fs')
const path = require('path')

/** Where English messages are: locales/en/<area>.json, { id: { defaultMessage, description } }. */
const EN_DIR = path.join(__dirname, '..', '..', 'locales', 'en')

/** Every English message, id → its text. */
function englishCatalogue(dir = EN_DIR) {
  const out = {}
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    for (const [id, m] of Object.entries(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))) if (typeof m?.defaultMessage === 'string') out[id] = m.defaultMessage
  }
  return out
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** At least this many letters outside a message's placeholders before text matching it counts as that message. */
const PATTERN_LETTERS = 6

/**
 * What English left looks like in a language: the English texts its translations replace, given English (id → text)
 * and the language's translations (id → text). A text is left out when the language also shows it as it is (a message
 * it doesn't translate, or translates to the same words, or another message's translation), since seeing it is then no
 * sign of a miss. Messages with plain placeholders ("{agent} (removed)") become patterns; plurals, selects and markup don't.
 * Returns { exact: [text], patterns: [{ id, source }], authored: [] } (source: a RegExp's, whole text). authored: what
 * the route itself wrote into Hive as a user would (a template's name, a card's blocked reason, HI-1915), each
 * { text, within } (within: a selector for where Hive shows it), added as cases write it: English there is the user's,
 * even where it equals a message ("Pair") or fits a placeholder message's pattern ("Waiting for {what}").
 */
function englishLeft(english, translations) {
  const shown = new Set(Object.values(translations).map((t) => norm(t)))
  for (const [id, e] of Object.entries(english)) if (!(id in translations) || norm(translations[id]) === norm(e)) shown.add(norm(e))
  const exact = new Set()
  const patterns = []
  for (const [id, e] of Object.entries(english)) {
    const t = translations[id]
    if (typeof t !== 'string' || shown.has(norm(e))) continue
    if (!/[{<]/.test(e)) {
      if (/\p{L}/u.test(e)) exact.add(norm(e))
      continue
    }
    // Plain placeholders only: {name}, with no ICU format (plural, select, number) and no markup or quoting.
    if (/[<'#]/.test(e) || /\{[^}]*,/.test(e)) continue
    const parts = norm(e).split(/\{\w+\}/)
    const literal = parts.join('')
    if (literal.replace(/[^\p{L}]/gu, '').length < PATTERN_LETTERS) continue
    // A placeholder and one bare word ("{provider} version") matches any phrase ending in that word, translated or not
    // ("Notes de version", HI-1590): only a pattern with two words, or marks around its words ("{agent} (removed)").
    if ((literal.match(/\p{L}+/gu) ?? []).length < 2 && !/[^\p{L}\s]/u.test(literal)) continue
    patterns.push({ id, source: `^${parts.map(escapeRegex).join('.+?')}$` })
  }
  return { exact: [...exact].sort(), patterns, authored: [] }
}

const norm = (s) => String(s).replace(/\s+/g, ' ').trim()

/**
 * Runs in the page (page.evaluate(inspectLayout, [root, english])): self-contained, it can't use anything outside.
 * root: the element photographed, or null for the whole window. english: englishLeft()'s, or null for an English run.
 * Returns [{ kind, text, where, px?, detail? }], at most LIMIT, one per kind, place and text.
 */
function inspectLayout([root, english]) {
  const LIMIT = 60
  const SKIP = '.xterm, .monaco-editor, pre, code, kbd, script, style, noscript, svg, input, textarea, select, option, [aria-hidden="true"]'
  const LABEL = 'h1, h2, h3, h4, h5, h6, th, button, label, summary, [role="tab"], [role="columnheader"], [role="menuitem"], [role="button"], .badge, .chip'
  const LABEL_CHARS = 40
  const SQUEEZED_LINES = 5
  const SQUEEZED_WIDTH = 260
  const SQUEEZED_CHARS = 28
  const NEAR = 5
  const TEXT_MAX = 80
  const top = root ?? document.body
  const issues = []
  const seen = new Set()
  const vw = window.innerWidth

  const short = (s) => {
    const t = s.replace(/\s+/g, ' ').trim()
    return t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX - 1)}…` : t
  }
  const name = (el) => {
    let n = el.tagName.toLowerCase()
    if (el.id) n += `#${el.id}`
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : []
    for (const c of cls) n += `.${c}`
    return n
  }
  const where = (el) => {
    const parts = []
    for (let e = el; e && e !== document.body && parts.length < 3; e = e.parentElement) parts.unshift(name(e))
    return parts.join(' > ')
  }
  const add = (kind, el, text, extra = {}) => {
    const w = where(el)
    const t = short(text)
    const key = `${kind}|${w}|${t}`
    if (seen.has(key) || issues.length >= LIMIT) return
    seen.add(key)
    issues.push({ kind, text: t, where: w, ...extra })
  }
  // Text for screen readers only (.visually-hidden, an icon-only tab's label) is clipped away by clip-path or clip.
  const clippedAway = (s) => (s.clipPath && s.clipPath !== 'none') || (s.clip && s.clip !== 'auto')
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return false
    const s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05 && !clippedAway(s)
  }
  /**
   * The boxes an element's text can show in, innermost first: its own when it clips, and each box around it that clips
   * ({ el, s, left, right, top, bottom }: the padding box). null when a box around it hides it (clip-path). A box
   * clips what is positioned inside it only from that thing's containing block outwards: a fixed dialog isn't clipped
   * by the scrolling page it is in, nor an absolute popup by boxes between it and its positioned ancestor.
   */
  const clipBoxes = (el) => {
    const out = []
    // 'fixed': past a fixed element, nothing around it clips; 'absolute': skipping to the next positioned ancestor.
    let escaping = null
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const s = getComputedStyle(a)
      if (a !== el && clippedAway(s)) return null
      const containing = s.position !== 'static' || s.transform !== 'none'
      if (escaping === 'absolute' && containing) escaping = null
      const clips = !escaping && !(s.overflowX === 'visible' && s.overflowY === 'visible')
      if (s.position === 'fixed' && s.transform === 'none') escaping = 'fixed'
      else if (s.position === 'absolute' && !escaping) escaping = 'absolute'
      if (!clips) continue
      const r = a.getBoundingClientRect()
      const left = r.left + a.clientLeft
      const upper = r.top + a.clientTop
      out.push({ el: a, s, left, right: left + a.clientWidth, top: upper, bottom: upper + a.clientHeight })
    }
    return out
  }
  /** What of each box shows: inside every clipping box and the window. */
  const shownParts = (rects, clips) => {
    const out = []
    for (const b of rects) {
      let p = { left: Math.max(b.left, 0), right: Math.min(b.right, window.innerWidth), top: Math.max(b.top, 0), bottom: Math.min(b.bottom, window.innerHeight) }
      for (const c of clips) p = { left: Math.max(p.left, c.left), right: Math.min(p.right, c.right), top: Math.max(p.top, c.top), bottom: Math.min(p.bottom, c.bottom) }
      if (p.right - p.left > 1 && p.bottom - p.top > 1) out.push(p)
    }
    return out
  }
  /** Whether hovering shows the whole text: a title on it or close around it, or Hive's tooltip wrapper. */
  const tooltip = (el) => {
    for (let e = el, i = 0; e && i < 4; e = e.parentElement, i++) if (e.hasAttribute('title') || e.classList.contains('tip-wrap')) return true
    return false
  }
  const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3 && n.nodeValue.trim()).map((n) => n.nodeValue)
  /** The boxes of an element's own text (its text nodes', not its padding or children's). */
  const textRects = (el) => {
    const rects = []
    for (const n of el.childNodes) {
      if (n.nodeType !== 3 || !n.nodeValue.trim()) continue
      const r = document.createRange()
      r.selectNodeContents(n)
      for (const b of r.getClientRects()) if (b.width > 0.5 && b.height > 0.5) rects.push(b)
    }
    return rects
  }
  const lineCount = (rects) => {
    const tops = []
    for (const b of [...rects].sort((a, c) => a.top - c.top)) if (!tops.length || b.top - tops[tops.length - 1] > b.height / 2) tops.push(b.top)
    return tops.length
  }
  const union = (rects) => rects.reduce((u, b) => ({ left: Math.min(u.left, b.left), right: Math.max(u.right, b.right), top: Math.min(u.top, b.top), bottom: Math.max(u.bottom, b.bottom) }), { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity })

  // The elements with text of their own, on screen, outside what is skipped.
  const texts = []
  const walker = document.createTreeWalker(top, NodeFilter.SHOW_ELEMENT)
  for (let el = top; el; el = walker.nextNode()) {
    if (el.closest(SKIP)) continue
    const s = getComputedStyle(el)
    // A box that scrolls sideways: its content is wider than it.
    if (/auto|scroll/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && visible(el)) add('sideways', el, el.innerText ?? '', { px: el.scrollWidth - el.clientWidth })
    if (!ownText(el).length || !visible(el)) continue
    const rects = textRects(el)
    const clips = rects.length ? clipBoxes(el) : null
    // Only text that shows: none of it scrolled away or clipped off by the boxes around it.
    const shown = clips ? shownParts(rects, clips) : []
    // Text a box around it hides sideways (a table's last column past its pane's edge) is reported, though none of it
    // shows; text scrolled away, or below a box's edge, isn't.
    const box = rects.length ? union(rects) : null
    const hiddenSideways = () => clips.some((c) => c.el !== el && /hidden|clip/.test(c.s.overflowX) && box.top < c.bottom && box.bottom > c.top && (box.left >= c.right || box.right <= c.left))
    if (shown.length || (clips && box && hiddenSideways())) texts.push({ el, rects, shown, clips, box, text: ownText(el).join(' ') })
  }

  for (const t of texts) {
    const { el, rects, box, clips } = t
    const s = getComputedStyle(el)
    const text = el.textContent ?? ''
    // Cut off by its own box. A cut with "…" that a tooltip shows whole is deliberate.
    const over = el.scrollWidth - el.clientWidth
    const overY = el.scrollHeight - el.clientHeight
    const ownClipX = s.overflowX !== 'visible'
    // Deliberate too: a long text (a description, past LABEL_CHARS) cut to a one-line summary, more of it cut than
    // shown, and a path cut short. A label or action is reported however much of it is cut.
    const cutWithDots = (e, px, extra = {}) => {
      const shownPx = extra.detail ? e.clientHeight : e.clientWidth
      const whole = e.textContent ?? ''
      const summary = whole.trim().length > LABEL_CHARS && px >= shownPx
      if (tooltip(e) || summary || /[A-Za-z]:\\|\/[^/\s]+\//.test(whole)) return
      add('ellipsis', e, whole, { px, ...extra })
    }
    if (over > 1 && ownClipX) {
      if (s.textOverflow === 'ellipsis') cutWithDots(el, over)
      else add('clipped', el, text, { px: over })
    } else if (overY > 1 && s.overflowY !== 'visible' && s.webkitLineClamp && s.webkitLineClamp !== 'none') cutWithDots(el, overY, { detail: 'line clamp' })
    else if (overY > 2 && s.overflowY !== 'visible' && !/auto|scroll/.test(s.overflowY) && el.clientHeight > 0) add('clipped', el, text, { px: overY, detail: 'below' })
    // Cut off by a box around it (one cutting with "…" is that box's ellipsis), or out of a sideways-scrolling box's
    // view; past the window's edge when no box cut it first.
    let cutBy = null
    if (!ownClipX) {
      for (const c of clips) {
        if (c.el === el) continue
        const cut = Math.max(0, box.right - c.right) + Math.max(0, c.left - box.left)
        if (cut <= 1) continue
        cutBy = c
        // Out of a sideways-scrolling box's view: that box's own line (sideways) says so, once.
        if (/auto|scroll/.test(c.s.overflowX)) break
        if (c.s.textOverflow === 'ellipsis') cutWithDots(c.el, Math.round(cut))
        else add('cut-off', el, text, { px: Math.round(cut), detail: `by ${name(c.el)}` })
        break
      }
    }
    if (!cutBy && !ownClipX && (box.right > vw + 1 || box.left < -1)) add('outside', el, text, { px: Math.round(Math.max(box.right - vw, -box.left)) })
    // Cut at the top or bottom by a box around it that hides what doesn't fit (a line cut in half, or lines hidden below
    // others that show). Rows a scrolling box hides are its content, not cut: the check stops at the first box that
    // scrolls downwards.
    if (s.overflowY === 'visible' && t.shown.length) {
      for (const c of clips) {
        if (c.el === el) continue
        if (/auto|scroll/.test(c.s.overflowY)) break
        if (c.s.overflowY === 'visible') continue
        const halved = rects.some((r) => (r.top < c.bottom - 1 && r.bottom > c.bottom + 1) || (r.top < c.top - 1 && r.bottom > c.top + 1))
        const hidden = rects.some((r) => r.top >= c.bottom - 1 || r.bottom <= c.top + 1)
        if (!halved && !hidden) continue
        add('cut-off', el, text, { px: Math.round(Math.max(box.bottom - c.bottom, c.top - box.top)), detail: `${box.bottom > c.bottom ? 'below' : 'above'}, by ${name(c.el)}` })
        break
      }
    }
    const lines = lineCount(rects)
    // A short label on more than one line.
    if (lines > 1 && el.matches(LABEL) && text.trim().length <= LABEL_CHARS) add('wraps', el, text, { detail: `${lines} lines` })
    // A block of text in a narrow column.
    if (lines >= SQUEEZED_LINES && box.right - box.left < SQUEEZED_WIDTH && text.trim().length / lines < SQUEEZED_CHARS) add('squeezed', el, text, { detail: `${lines} lines of about ${Math.round(text.trim().length / lines)} characters, ${Math.round(box.right - box.left)} px wide` })
    // A word broken across lines (only where the text wraps at all). Paths, addresses and ids (a run of text with \ / @
    // _ . or : inside) may break anywhere, and a hyphenated word at its hyphen. Chinese and Japanese have no spaces
    // between words, so a line may break between any two of their characters (HI-1590): a word is a run of other
    // letters (a Latin word inside Japanese text is still one), never of Han, Hiragana, Katakana or full-width forms.
    if (lines > 1) {
      for (const n of el.childNodes) {
        if (n.nodeType !== 3) continue
        const tokens = /\S+/g
        for (let tok; (tok = tokens.exec(n.nodeValue)); ) {
          if (/[\\/@_.:]/.test(tok[0].replace(/[.,:;!?)\]"'’”]+$/, '')) || /\p{Ll}\p{Lu}/u.test(tok[0])) continue
          const re = /(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}\u3000-\u303f\u30fc\uff00-\uffef])[\p{L}\p{N}'’]){4,}/gu
          for (let m; (m = re.exec(tok[0])); ) {
            const r = document.createRange()
            r.setStart(n, tok.index + m.index)
            r.setEnd(n, tok.index + m.index + m[0].length)
            const parts = [...r.getClientRects()].filter((b) => b.width > 0.5)
            if (lineCount(parts) > 1) add('mid-word', el, m[0], { detail: short(text) })
          }
        }
      }
    }
  }

  // Text over other text nearby (both in one part of the window: their closest shared box at most NEAR levels up, so a
  // menu or dialog over the window isn't counted), where the top one is what shows.
  const depthTo = (el, anc) => {
    let d = 0
    for (let e = el; e && e !== anc; e = e.parentElement) d++
    return d
  }
  const floats = (el, anc) => {
    for (let e = el; e && e !== anc; e = e.parentElement) {
      const s = getComputedStyle(e)
      if (/sticky|fixed/.test(s.position) || (s.position === 'absolute' && s.zIndex !== 'auto')) return true
    }
    return false
  }
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i]
      const b = texts[j]
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue
      const hit = a.shown.flatMap((ra) => b.shown.map((rb) => ({ l: Math.max(ra.left, rb.left), r: Math.min(ra.right, rb.right), t: Math.max(ra.top, rb.top), b: Math.min(ra.bottom, rb.bottom) }))).find((x) => x.r - x.l > 2 && x.b - x.t > 2)
      if (!hit) continue
      let common = a.el.parentElement
      while (common && !common.contains(b.el)) common = common.parentElement
      if (!common || depthTo(a.el, common) > NEAR || depthTo(b.el, common) > NEAR) continue
      // A layer meant to float over what's beside it (a sticky header or column, a fixed toast or menu).
      if (floats(a.el, common) || floats(b.el, common)) continue
      const onTop = document.elementFromPoint((hit.l + hit.r) / 2, (hit.t + hit.b) / 2)
      if (!onTop || !(a.el.contains(onTop) || b.el.contains(onTop) || onTop.contains(a.el) || onTop.contains(b.el))) continue
      add('overlaps', a.el, a.text, { px: Math.round(hit.r - hit.l), detail: `with "${short(b.text)}" (${where(b.el)})` })
    }
  }

  // English left in a translated run.
  if (english) {
    const exact = new Set(english.exact)
    const patterns = english.patterns.map((p) => ({ id: p.id, re: new RegExp(p.source, 'u') }))
    // Whitespace as englishLeft() reads it (in the page: nothing from outside reaches it).
    const squash = (s) => s.replace(/\s+/g, ' ').trim()
    // The user's own words where Hive shows them (englishLeft's authored): only that text, only there, so the same
    // words elsewhere (a message Hive left in English) are still reported.
    const authored = (english.authored ?? []).map((a) => ({ text: squash(a.text), within: a.within }))
    const own = (el, c) => authored.some((a) => a.text === c && !!el.closest(a.within))
    for (const t of texts) {
      // Not a document Hive renders (a skill, a mode, a note: their words are their author's, not messages).
      if (t.el.closest('.markdown')) continue
      // The element's text, and each piece of its own text beside its children: a piece only when it reads as words
      // (a space or a capital), not a lower-case fragment of an id ("project" in workspace.new.project).
      const pieces = ownText(t.el).map(squash).filter((p) => /\s|\p{Lu}/u.test(p))
      const candidates = [...new Set([squash(t.el.textContent ?? ''), ...pieces])].filter(Boolean)
      for (const c of candidates) {
        if (own(t.el, c)) continue
        const p = exact.has(c) ? null : patterns.find((x) => x.re.test(c))
        if (exact.has(c) || p) {
          add('english', t.el, c, p ? { detail: p.id } : {})
          break
        }
      }
    }
  }
  return issues
}

/** One line per issue: `board-board (pl): wraps "TO DO 4" [div.col > h3] → pl/board-board-dark.png`. */
function issueLine(screen, lang, issue, image) {
  const px = issue.px ? ` by ${issue.px} px` : ''
  const detail = issue.detail ? `, ${issue.detail}` : ''
  return `${screen} (${lang}): ${issue.kind}${px} "${issue.text}" [${issue.where}${detail}]${image ? ` → ${image}` : ''}`
}

/**
 * The report's text: per language, how many screens were checked and flagged and how many issues of each kind, then a
 * line per issue, screens in order. The same issue on several screens (the same kind, place and text: a part of the
 * window every screen shows) is one line, at its first screen, saying on how many others it is.
 * report: { [lang]: { [screen]: { image, issues: [...] } } }.
 */
function summarize(report) {
  const out = []
  for (const [lang, screens] of Object.entries(report)) {
    const entries = Object.entries(screens)
    const flagged = entries.filter(([, s]) => s.issues.length)
    const lines = new Map()
    for (const [screen, s] of flagged) {
      for (const i of s.issues) {
        const key = `${i.kind}|${i.where}|${i.text}`
        const seen = lines.get(key)
        if (seen) seen.others++
        else lines.set(key, { screen, image: s.image, issue: i, others: 0 })
      }
    }
    const counts = {}
    for (const { issue } of lines.values()) counts[issue.kind] = (counts[issue.kind] ?? 0) + 1
    const kinds = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ')
    out.push(`${lang}: ${entries.length} screens checked, ${flagged.length} flagged${kinds ? ` (${kinds})` : ''}`)
    for (const l of lines.values()) out.push(`  ${issueLine(l.screen, lang, l.issue, l.image)}${l.others ? ` (and ${l.others} other screen${l.others === 1 ? '' : 's'})` : ''}`)
  }
  return out.join('\n') + '\n'
}

module.exports = { englishCatalogue, englishLeft, inspectLayout, issueLine, summarize }
