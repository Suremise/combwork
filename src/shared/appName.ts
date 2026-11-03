/**
 * The app's names (#443). "Hive Desktop" is the name where it stands alone or names a version: the window title, About,
 * the status bar's version, the tray, the installer and shortcuts (package.json's productName). In sentences and in
 * what agents see ("Hive couldn't…", the hive tools, the Agent API's app), the short name "Hive" stays.
 */
export const APP_NAME = 'Hive Desktop'

/** The name of a dev or test build (unpackaged): its title bar, status bar and Windows app ID say it. */
export const DEV_APP_NAME = 'Hive Desktop Dev'

/** The name to show for this build. */
export const appName = (packaged: boolean): string => (packaged ? APP_NAME : DEV_APP_NAME)

/**
 * The profile folder, in %APPDATA% and %LOCALAPPDATA% (HI-2461): Combwork's. Electron would take productName for it, so
 * main sets it explicitly.
 */
export const profileFolder = (packaged: boolean): string => (packaged ? 'Combwork' : 'Combwork-Dev')

/** The profile folder's name before HI-2461, which the installer moves (HI-2460) and the app falls back to while it hasn't (main/profileFolders.ts). */
export const legacyProfileFolder = (packaged: boolean): string => (packaged ? 'Hive' : 'Hive-Dev')
