// What a packaged Combwork says it is (#1647): out/identity/build-identity.json, packaged beside its resources
// (electron-builder.yml extraResources), and read by src/main/buildIdentity.ts. `npm run dist` writes it with
// local: true (distCopy.mjs makeDist), the release workflow with local: false (release.mjs), each just before
// electron-builder runs, and sets CW_LOCAL_BUILD for the installer's script (build/installer.nsh): only a local
// build's installer waits for another Combwork installer to finish before it installs.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

export const IDENTITY_DIR = join('out', 'identity')

/** Writes the identity file for a build of `version` from `commit` (null: not known), and the installer's flag. */
export function writeAppIdentity(root, { version, commit, local }) {
  const dir = join(root, IDENTITY_DIR)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'build-identity.json'), `${JSON.stringify({ version, commit: commit ?? null, local }, null, 2)}\n`)
  process.env.CW_LOCAL_BUILD = local ? '1' : '0'
}
