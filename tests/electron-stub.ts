// Unit tests run in plain Node: Hive's modules get this instead of Electron (no binary download in CI).
/* eslint-disable typescript/no-extraneous-class -- stand-ins for Electron's classes */
import { tempRoot } from './tempDir'

export const app = { getPath: () => tempRoot(), getVersion: () => '0.0.0-test', isPackaged: false }
export class BrowserWindow {}
export class Notification {
  // Tests that record notifications make it supported and spy on show().
  constructor(readonly options?: { title?: string; body?: string }) {}
  static isSupported(): boolean {
    return false
  }
  on(): this {
    return this
  }
  show(): void {}
}
export const clipboard = {}
export const shell = {}
export const nativeImage = {}
export const dialog = {}
export const crashReporter = {}
export const powerMonitor = {}
// No screens: main code that places windows (testQuiet.ts) is bundled in by trash.ts and config.ts.
export const screen = { getAllDisplays: (): unknown[] => [] }
export default { app, BrowserWindow, Notification, clipboard, shell, nativeImage, dialog, crashReporter, powerMonitor, screen }
