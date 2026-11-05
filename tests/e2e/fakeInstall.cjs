// A stand-in for an installed Combwork's resources folder (#1647): an app.asar holding only its package.json (with the
// version), and its build-identity.json when given one, for CW_TEST_RESOURCES (an unpackaged build with a test update
// feed reads its own and the installed copy's identity there; src/main/buildIdentity.ts) and the unit tests.
const fs = require('fs')
const path = require('path')

/**
 * An asar of one file, as @electron/asar lays it out: a pickle holding the header's size, the header (a pickle holding
 * its JSON's length and the JSON, padded to 4 bytes), then the files.
 */
function asarOf(files) {
  const bodies = []
  const entries = {}
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text)
    entries[name] = { size: body.length, offset: String(offset) }
    bodies.push(body)
    offset += body.length
  }
  const json = Buffer.from(JSON.stringify({ files: entries }))
  const padded = Math.ceil(json.length / 4) * 4
  const header = Buffer.alloc(8 + padded)
  header.writeUInt32LE(4 + padded, 0)
  header.writeUInt32LE(json.length, 4)
  json.copy(header, 8)
  const size = Buffer.alloc(8)
  size.writeUInt32LE(4, 0)
  size.writeUInt32LE(header.length, 4)
  return Buffer.concat([size, header, ...bodies])
}

/** Makes `dir` a stand-in resources folder: its app's `version`, and `identity` (an object, or raw text) if given. */
function fakeInstall(dir, { version, identity } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  if (version !== undefined) fs.writeFileSync(path.join(dir, 'app.asar'), asarOf({ 'package.json': JSON.stringify({ name: 'hive', version }) }))
  const file = path.join(dir, 'build-identity.json')
  if (identity === undefined) fs.rmSync(file, { force: true })
  else fs.writeFileSync(file, typeof identity === 'string' ? identity : JSON.stringify(identity))
  return dir
}

module.exports = { asarOf, fakeInstall }
