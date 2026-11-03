/**
 * The app's displayed name (HI-2458, after #443's "Hive Desktop"): the window title, About, the status bar's version,
 * the tray, the installer and shortcuts (package.json's productName), and the window's sentences ("Combwork couldn't…").
 * Only what the user sees: what agents see (the hive tools, the doorbell, guidance, the Agent API) still says Hive until
 * HI-2463, and the app ID, exe and folders move on HI-2460, HI-2461 and HI-2462.
 */
export const APP_NAME = 'Combwork'

/** The name of a dev or test build (unpackaged): its title bar, status bar and Windows app ID say it. */
export const DEV_APP_NAME = 'Combwork Dev'

/** The name to show for this build. */
export const appName = (packaged: boolean): string => (packaged ? APP_NAME : DEV_APP_NAME)

/**
 * The profile folder in %APPDATA%: the names from before the rename, kept so nothing users stored moves. Electron
 * would take productName ("Hive Desktop") for it, so main sets it explicitly.
 */
export const profileFolder = (packaged: boolean): string => (packaged ? 'Hive' : 'Hive-Dev')
