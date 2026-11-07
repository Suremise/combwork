import type { CombworkErrorKind } from './types'

/**
 * A plain English error that isn't a message (a programming error's, or a technical one's kept in English), with the
 * kind that gives its Agent API status (servers.ts `errorStatus`, HI-2704), as a `CombworkError`'s does: code shared
 * with the window, or one too low to say a message, can't throw one of those.
 */
export class KindedError extends Error {
  constructor(
    message: string,
    readonly kind: CombworkErrorKind
  ) {
    super(message)
    this.name = 'KindedError'
  }
}
