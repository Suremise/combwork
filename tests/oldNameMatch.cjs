// The old name's matcher (HI-2617, HI-2633): one for the repository's guard (tests/oldNames.mjs) and the clean-install
// check (tests/sandbox/clean.cjs, which the Sandbox runs from this tests folder), so both find the same hits. Node
// built-ins only (none): the Sandbox requires it as it is.

// old-name: begin detector
/** Every place the name appears, in any case, as a word or joined to anything (myHive, HIVE_DIR, hive2, xhive, hives). */
const NAME = /hive/gi
/**
 * The ordinary words that hold its letters, and only these: archive in all its forms (Archived, unarchive, ARCHIVE_DIR,
 * boardarchive, désarchiver), chive and chives, beehive and beehives. Each is the text just before the letters and just
 * after them. The letters are in one case, all lower or all upper, as the word's are: arcHive, beeHive or ArcHIVE (a
 * capital where a word joins) is a hit.
 */
const ORDINARY = {
  lower: [
    { before: /[Aa]rc$/, after: /^/ },
    { before: /(?:^|[^A-Za-z])[Cc]$/, after: /^s?(?![A-Za-z])/ },
    { before: /(?:^|[^A-Za-z])[Bb]ee$/, after: /^s?(?![A-Za-z])/ }
  ],
  upper: [
    { before: /ARC$/, after: /^/ },
    { before: /(?:^|[^A-Za-z])C$/, after: /^S?(?![A-Za-z])/ },
    { before: /(?:^|[^A-Za-z])BEE$/, after: /^S?(?![A-Za-z])/ }
  ]
}
// old-name: end detector

/** The hits in a text: [{ at, match }]. */
function nameHits(text) {
  const s = String(text ?? '')
  const out = []
  for (const m of s.matchAll(NAME)) {
    const words = m[0] === m[0].toLowerCase() ? ORDINARY.lower : m[0] === m[0].toUpperCase() ? ORDINARY.upper : []
    const before = s.slice(Math.max(0, m.index - 4), m.index)
    const after = s.slice(m.index + 4, m.index + 6)
    if (words.some((w) => w.before.test(before) && w.after.test(after))) continue
    out.push({ at: m.index, match: m[0] })
  }
  return out
}

module.exports = { nameHits }
