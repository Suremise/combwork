import { readFileSync } from 'fs'
import { createRequire } from 'module'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { APP_NAME, DEV_APP_NAME, appName, profileFolder } from '../src/shared/appName'
import { RELEASES_REPO } from '../src/shared/defaults'

// #443, HI-2458: the app is displayed as "Combwork" ("Hive Desktop" before), and nothing users have stored moves. These pin the names Windows and
// the installer use, so a change to productName or electron-builder can't move the profile or install folder.

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const builder = load(read('electron-builder.yml')) as { appId: string; productName: string; win: { executableName: string }; nsis: { shortcutName: string; artifactName: string; uninstallDisplayName?: string }; publish: { owner: string; repo: string } }
const pkg = JSON.parse(read('package.json')) as { name: string; productName: string }

describe('the app name (#443, HI-2458)', () => {
  it('is displayed as Combwork, and Combwork Dev for dev builds', () => {
    expect([APP_NAME, DEV_APP_NAME, appName(true), appName(false)]).toEqual(['Combwork', 'Combwork Dev', 'Combwork', 'Combwork Dev'])
    expect(pkg.productName).toBe(APP_NAME)
    expect(builder.productName).toBe(APP_NAME)
    // The shortcuts' name is HI-2460's to change with the installer's other names (the Assistant's split of electron-builder.yml).
    expect(builder.nsis.shortcutName).toBe('Hive Desktop')
    expect(builder.nsis.uninstallDisplayName).toBeUndefined() // "${productName} ${version}": Combwork 1.1.0
    expect(read('src/renderer/index.html')).toContain('<title>Combwork</title>')
  })

  it('keeps the app ID, exe and update feed (HI-2460 moves them); the installer file says Combwork', () => {
    expect(builder.appId).toBe('com.hive.desktop')
    expect(read('src/main/index.ts')).toContain("app.isPackaged ? 'com.hive.desktop' : 'com.hive.desktop.dev'")
    expect(builder.win.executableName).toBe('Hive')
    expect(builder.nsis.artifactName).toBe('Combwork-Setup-${version}.${ext}')
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
