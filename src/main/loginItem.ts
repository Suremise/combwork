// Launch at login, written again at each start of the installed app (HI-2460): Windows' Run value names the exe it
// starts, and an update that moves the exe (Hive.exe → Combwork.exe, its install folder too) leaves the old value
// pointing at nothing. Written only while the setting is on, so a user who turned it off is never registered. The old
// app's own value is removed by its installer (legacyUpgrade.ps1: only a value starting exactly Hive Desktop's Hive.exe).

import { app } from 'electron'

type SetLoginItem = (s: { openAtLogin: boolean; args: string[] }) => void

/** At start: registers Launch at login for this exe when it is on and this is the installed app. True: it wrote it. */
export function syncLoginItemAtStart(on: boolean, packaged = app.isPackaged, set: SetLoginItem = (s) => app.setLoginItemSettings(s)): boolean {
  if (!packaged || !on) return false
  set({ openAtLogin: true, args: ['--hidden'] })
  return true
}
