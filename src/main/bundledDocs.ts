// Combwork's own documents, read by section as `combwork:<name>` (HI-3622): the copy the app ships, as its Docs view
// shows it, never a file on disk. Its own module, imported by the Agent API's docs calls alone: the guide is a ?raw
// import, which the tests that bundle main's workers and children with esbuild (docSections.ts among them) can't load.
import userGuideDoc from '../../docs/USER_GUIDE.md?raw'

/** A `combwork:` path names one of these, and only these: any other is refused, never looked for in a folder. */
export const BUNDLED_PREFIX = 'combwork:'
const BUNDLED = [{ name: 'USER_GUIDE.md', text: userGuideDoc }]

/** A `combwork:` document's reference and text (its name in any case), or null for a name Combwork doesn't ship. */
export function bundledDoc(path: string): { ref: string; text: string } | null {
  const name = path.slice(BUNDLED_PREFIX.length).trim().toLowerCase()
  const doc = BUNDLED.find((d) => d.name.toLowerCase() === name)
  return doc ? { ref: `${BUNDLED_PREFIX}${doc.name}`, text: doc.text.replace(/^﻿/, '') } : null
}
