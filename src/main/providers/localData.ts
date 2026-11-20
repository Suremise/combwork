import { join } from 'path'
import { app } from 'electron'
import { profileFolder } from '../../shared/appName'
import { localProfileInUse } from '../profileFolders'

/**
 * Combwork's local data folder (%LOCALAPPDATA%\Combwork, or a test copy's), as accounts.ts's accountsRoot finds it, whose
 * `accounts` sits beside the profiles: computed here, since accounts.ts reaches the providers (an import cycle).
 */
export function localDataRoot(): string {
  const inUse = localProfileInUse()
  if (inUse) return inUse
  if (process.env.CW_USER_DATA) return process.env.CW_USER_DATA
  const local = process.env.LOCALAPPDATA || join(app.getPath('home'), 'AppData', 'Local')
  return join(local, profileFolder(app.isPackaged))
}
