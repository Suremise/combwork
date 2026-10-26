import { closeSync, openSync, readFileSync, readSync } from 'original-fs'
import { join } from 'path'
import { readBuildIdentity, type BuildIdentity, type InstalledCopy } from '../shared/updates'

/**
 * What this build is, and what is installed on disk (#1647). A packaged build carries `resources/build-identity.json`
 * (written by `npm run dist`, `local: true`, and the release workflow, `local: false`; scripts/buildIdentity.mjs); one
 * from before has none and is a release. Read synchronously: the installed copy is read inside the quit, whose handlers
 * can't wait.
 */

export const IDENTITY_FILE = 'build-identity.json'

/** A file's text, null when it doesn't exist; any other failure throws. */
function textOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/**
 * The version in an asar's package.json, read from the archive itself (original-fs: Electron's fs would open it as a
 * folder, #246). Its layout: a pickle holding the header's size, then the header (a pickle holding its JSON's length and
 * the JSON), then the files, each at its offset from the header's end. Throws when it can't be read as one.
 */
export function asarPackageVersion(asar: string): string {
  const fd = openSync(asar, 'r')
  try {
    const head = Buffer.alloc(16)
    if (readSync(fd, head, 0, 16, 0) !== 16) throw new Error('too short for an asar') // i18n-ignore: a reason for the log, never shown
    const headerSize = head.readUInt32LE(4)
    const jsonLength = head.readUInt32LE(12)
    if (jsonLength > headerSize || headerSize > 64 * 1024 * 1024) throw new Error('not an asar header') // i18n-ignore: a reason for the log, never shown
    const json = Buffer.alloc(jsonLength)
    if (readSync(fd, json, 0, jsonLength, 16) !== jsonLength) throw new Error('its header is cut short') // i18n-ignore: a reason for the log, never shown
    const entry = (JSON.parse(json.toString('utf8')) as { files?: Record<string, { size?: number; offset?: string; unpacked?: boolean }> }).files?.['package.json']
    if (!entry || typeof entry.size !== 'number' || entry.size > 1024 * 1024) throw new Error('no package.json in it') // i18n-ignore: a reason for the log, never shown
    let text: string
    if (entry.unpacked) text = readFileSync(join(`${asar}.unpacked`, 'package.json'), 'utf8')
    else {
      const body = Buffer.alloc(entry.size)
      if (readSync(fd, body, 0, entry.size, 8 + headerSize + Number(entry.offset)) !== entry.size) throw new Error('its package.json is cut short') // i18n-ignore: a reason for the log, never shown
      text = body.toString('utf8')
    }
    const version = (JSON.parse(text) as { version?: unknown }).version
    if (typeof version !== 'string') throw new Error('its package.json has no version') // i18n-ignore: a reason for the log, never shown
    return version
  } finally {
    closeSync(fd)
  }
}

/** This build's identity: the file beside its resources, else (a build from before, or a development build) a release. */
export function runningIdentity(version: string, resources: string = process.resourcesPath): BuildIdentity {
  try {
    const text = textOrNull(join(resources, IDENTITY_FILE))
    const id = text === null ? null : readBuildIdentity(JSON.parse(text))
    if (id && id.version === version) return id
  } catch {
    // Unreadable: treated as a release, which only means a release of its own version isn't offered.
  }
  return { version, commit: null, local: false }
}

/**
 * The copy installed in `resources` (its install folder's), read now: its identity file, the version in its app.asar,
 * then the identity file again. Known only when they agree: an identity file whose version isn't the asar's, one that
 * changed between the reads (an installer replacing the copy), malformed, or a read failing, is `unreadable`. No
 * identity file at all is a copy from before builds said what they are (a release), its version the asar's. Never the
 * running Hive's own version: the copy on disk may be newer.
 */
export function installedCopy(resources: string = process.resourcesPath): InstalledCopy {
  try {
    const file = join(resources, IDENTITY_FILE)
    const first = textOrNull(file)
    const version = asarPackageVersion(join(resources, 'app.asar'))
    const again = textOrNull(file)
    if (first !== again) return { kind: 'unreadable', why: 'its identity changed while it was read' } // i18n-ignore: a reason for the log, never shown
    if (first === null) return { kind: 'known', identity: { version, commit: null, local: false }, legacy: true }
    const id = readBuildIdentity(JSON.parse(first))
    if (!id) return { kind: 'unreadable', why: 'its identity file is malformed' } // i18n-ignore: a reason for the log, never shown
    if (id.version !== version) return { kind: 'unreadable', why: `its identity says ${id.version}, its app ${version}` } // i18n-ignore: a reason for the log, never shown
    return { kind: 'known', identity: id }
  } catch (e) {
    return { kind: 'unreadable', why: (e as Error).message }
  }
}
