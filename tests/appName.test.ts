import { readFileSync } from 'fs'
import { createRequire } from 'module'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { APP_NAME, DEV_APP_NAME, appName, profileFolder } from '../src/shared/appName'
import { RELEASES_REPO } from '../src/shared/defaults'

// #443: the app is displayed as "Hive Desktop", and nothing users have stored moves. These pin the names Windows and
// the installer use, so a change to productName or electron-builder can't move the profile or install folder.

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const builder = load(read('electron-builder.yml')) as { appId: string; productName: string; win: { executableName: string }; nsis: { shortcutName: string; artifactName: string; uninstallDisplayName?: string }; publish: { owner: string; repo: string } }
const pkg = JSON.parse(read('package.json')) as { name: string; productName: string }

describe('the app name (#443)', () => {
  it('is displayed as Hive Desktop, and Hive Desktop Dev for dev builds', () => {
    expect([APP_NAME, DEV_APP_NAME, appName(true), appName(false)]).toEqual(['Hive Desktop', 'Hive Desktop Dev', 'Hive Desktop', 'Hive Desktop Dev'])
    expect(pkg.productName).toBe(APP_NAME)
    expect(builder.productName).toBe(APP_NAME)
    expect(builder.nsis.shortcutName).toBe(APP_NAME)
    expect(builder.nsis.uninstallDisplayName).toBeUndefined() // "${productName} ${version}": Hive Desktop 0.5.0
    expect(read('src/renderer/index.html')).toContain('<title>Hive Desktop</title>')
  })

  it('keeps the app ID, exe, installer file and update feed', () => {
    expect(builder.appId).toBe('com.hive.desktop')
    expect(read('src/main/index.ts')).toContain("app.isPackaged ? 'com.hive.desktop' : 'com.hive.desktop.dev'")
    expect(builder.win.executableName).toBe('Hive')
    expect(builder.nsis.artifactName).toBe('Hive-Setup-${version}.${ext}')
    expect(builder.publish).toMatchObject({ owner: 'Suremise', repo: 'hive-desktop' })
    expect(builder.publish).toMatchObject(RELEASES_REPO) // the updater's feed (HI-2311)
    // electron-updater's download cache (%LOCALAPPDATA%\hive-updater) is named after package.json's name.
    expect(pkg.name).toBe('hive')
  })

  it('keeps the profile folders %APPDATA%\\Hive and Hive-Dev, set in main rather than taken from productName', () => {
    expect(profileFolder(true)).toBe('Hive')
    expect(profileFolder(false)).toBe('Hive-Dev')
    expect(read('src/main/index.ts')).toMatch(/else app\.setPath\('userData', join\(app\.getPath\('appData'\), profileFolder\(app\.isPackaged\)\)\)/)
  })

  it('keeps the install folder %LOCALAPPDATA%\\Programs\\Hive, as electron-builder names it', () => {
    // The installer's folder (APP_FILENAME) is the product file name, which executableName sets (assisted installer).
    const require = createRequire(import.meta.url)
    const { getWindowsInstallationDirName } = require('app-builder-lib/out/targets/targetUtil') as { getWindowsInstallationDirName: (info: { productFilename: string; sanitizedName: string }, tryProductName: boolean) => string }
    const { sanitizeFileName } = require('builder-util/out/filename') as { sanitizeFileName: (name: string) => string }
    expect(getWindowsInstallationDirName({ productFilename: sanitizeFileName(builder.win.executableName), sanitizedName: pkg.name }, true)).toBe('Hive')
  })
})
