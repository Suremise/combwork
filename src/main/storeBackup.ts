import { renameSync } from 'original-fs'
import { createLogger, userText } from './logger'

const log = createLogger('stores')

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-')

/** A store's file renamed to its backup name, `<file>.imported-<time>`; false when Windows refused (tried again at the next open). */
export function keepAsBackup(file: string): boolean {
  const to = `${file}.imported-${stamp()}`
  for (let i = 0; i < 5; i++) {
    try {
      renameSync(file, to)
      log.info(`${userText(file)} kept as ${userText(to)}`)
      return true
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') {
        log.warn(`keeping ${userText(file)} as a backup`, e)
        return false
      }
    }
  }
  log.warn(`couldn't rename ${userText(file)} (held open): tried again at the next open`)
  return false
}
