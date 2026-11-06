import { app } from 'electron'
import { join } from 'path'

/** Folder with the app's runtime resources (icons), inside the install or the repo. */
export function resourcesDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'resources') : join(__dirname, '../../resources')
}

/** The Combwork icon for Windows notifications (otherwise they may show a generic app icon). */
export function notificationIcon(): string {
  return join(resourcesDir(), 'icon.png')
}
