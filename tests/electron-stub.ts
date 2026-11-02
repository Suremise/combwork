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
// A stand-in for DPAPI (HI-1772's key store): reversible, never plain text on disk; tests turn `available` off.
export const safeStorage = {
  available: true,
  isEncryptionAvailable(): boolean {
    return this.available
  },
  getSelectedStorageBackend(): string {
    return 'unknown'
  },
  encryptString(s: string): Buffer {
    return Buffer.from(`stub:${Buffer.from(s, 'utf8').toString('hex').split('').reverse().join('')}`, 'utf8')
  },
  decryptString(b: Buffer): string {
    const t = b.toString('utf8')
    if (!t.startsWith('stub:')) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
    return Buffer.from(t.slice(5).split('').reverse().join(''), 'hex').toString('utf8')
  }
}
export default { app, BrowserWindow, Notification, clipboard, shell, nativeImage, dialog, crashReporter, powerMonitor, screen, safeStorage }
