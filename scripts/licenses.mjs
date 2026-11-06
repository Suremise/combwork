// Writes THIRD_PARTY_NOTICES.md (made by thirdPartyNotices.mjs): the licence of every package that ships inside Combwork.
// Run by `npm run build`; commit the result. Written only when its content changed (line endings aside), with the endings
// the file on disk already has, so a build leaves an unchanged notice alone (licenseText.mjs, #148).
// `--check` writes nothing and exits 1 when the committed file is out of date (#386; tests/licenses.test.ts checks the same
// in `npm test` and CI, and npm run release runs it before building).
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { noticesDrift, noticesToWrite, staleNoticesMessage } from './licenseText.mjs'
import { generateNotices } from './thirdPartyNotices.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { text, packages } = generateNotices(root)
const file = join(root, 'THIRD_PARTY_NOTICES.md')
const existing = existsSync(file) ? readFileSync(file, 'utf8') : null
if (process.argv.includes('--check')) {
  const drift = noticesDrift(text, existing)
  if (drift) {
    console.error(staleNoticesMessage(drift))
    process.exit(1)
  }
  console.log(`THIRD_PARTY_NOTICES.md: ${packages} packages, up to date`)
} else {
  const write = noticesToWrite(text, existing)
  if (write !== null) writeFileSync(file, write)
  console.log(`THIRD_PARTY_NOTICES.md: ${packages} packages${write === null ? ', unchanged' : ''}`)
}
