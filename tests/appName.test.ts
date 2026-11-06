import { readFileSync } from 'fs'
import { createRequire } from 'module'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { APP_NAME, DEV_APP_NAME, appName, profileFolder } from '../src/shared/appName'
import { oldProfileFolder } from '../src/main/nameUpgradeProfile'
import { RELEASES_REPO } from '../src/shared/defaults'

// #443, HI-2458: the app is displayed as "Combwork", and nothing users have stored moves. These pin the names Windows and
// the installer use, so a change to productName or electron-builder can't move the profile or install folder.

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const builder = load(read('electron-builder.yml')) as { appId: string; productName: string; win: { executableName: string }; nsis: { shortcutName: string; artifactName: string; uninstallDisplayName?: string }; publish: { owner: string; repo: string } }
const pkg = JSON.parse(read('package.json')) as { name: string; productName: string }

describe('the app name (#443, HI-2458)', () => {
  it('is displayed as Combwork, and Combwork Dev for dev builds', () => {
    expect([APP_NAME, DEV_APP_NAME, appName(true), appName(false)]).toEqual(['Combwork', 'Combwork Dev', 'Combwork', 'Combwork Dev'])
    expect(pkg.productName).toBe(APP_NAME)
    expect(builder.productName).toBe(APP_NAME)
    expect(builder.nsis.uninstallDisplayName).toBeUndefined() // "${productName} ${version}": Combwork 1.1.0
    expect(read('src/renderer/index.html')).toContain('<title>Combwork</title>')
  })

  it("has Combwork's app ID, exe and shortcut (HI-2460), its installer file (HI-2458), and keeps the update feed", () => {
    expect(builder.appId).toBe('it.surmise.combwork')
    expect(read('src/main/index.ts')).toContain("app.isPackaged ? 'it.surmise.combwork' : 'it.surmise.combwork.dev'")
    expect(builder.win.executableName).toBe('Combwork')
    expect(builder.nsis.shortcutName).toBe('Combwork')
    expect(builder.nsis.artifactName).toBe('Combwork-Setup-${version}.${ext}')
    expect(builder.publish).toMatchObject({ owner: 'Suremise', repo: 'combwork' })
    expect(builder.publish).toMatchObject(RELEASES_REPO) // the updater's feed (HI-2311)
    // electron-updater's download cache (%LOCALAPPDATA%\combwork-updater) is named after package.json's name.
    expect(pkg.name).toBe('combwork')
  })

  it("names the profile folders Combwork and Combwork-Dev (HI-2461), set in main rather than taken from productName; 1.0's only the names upgrade's input (HI-2594)", () => {
    expect(profileFolder(true)).toBe('Combwork')
    expect(profileFolder(false)).toBe('Combwork-Dev')
    // old-name: begin old-profile-folders-1
    expect(oldProfileFolder(true)).toBe('Hive')
    expect(oldProfileFolder(false)).toBe('Hive-Dev')
    // old-name: end old-profile-folders-1
    const index = read('src/main/index.ts')
    expect(index).toContain('chooseProfile(roamingParent, oldProfileFolder(packaged), profileFolder(packaged))')
    expect(index).toContain("else chooseProfiles(app.getPath('appData'), process.env.LOCALAPPDATA || join(app.getPath('home'), 'AppData', 'Local'), app.isPackaged)")
    expect(index).toContain("app.setPath('userData', roaming.use)")
  })

  it('installs in %LOCALAPPDATA%\\Programs\\Combwork (HI-2460), as electron-builder names it', () => {
    // The installer's folder (APP_FILENAME) is the product file name, which executableName sets (assisted installer).
    const require = createRequire(import.meta.url)
    const { getWindowsInstallationDirName } = require('app-builder-lib/out/targets/targetUtil') as { getWindowsInstallationDirName: (info: { productFilename: string; sanitizedName: string }, tryProductName: boolean) => string }
    const { sanitizeFileName } = require('builder-util/out/filename') as { sanitizeFileName: (name: string) => string }
    expect(getWindowsInstallationDirName({ productFilename: sanitizeFileName(builder.win.executableName), sanitizedName: pkg.name }, true)).toBe('Combwork')
  })
})
