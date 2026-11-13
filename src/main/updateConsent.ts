// HI-3167: a downloaded update installs as Combwork quits only by the user's say for that quit and that version: Install
// now in the quit dialog, or Restart and Update. Never by Install automatically alone (a silent install the user didn't
// see, then a shutdown, left no Combwork). Windows ending the session voids it: a consent counts only within the session
// generation it was given in, a counter (never a clock) that each query-session-end or session-end moves on, so a
// shutdown another app cancelled leaves later explicit choices working. Pure: updater.ts keeps the one instance.

/** What a quit dialog offered: this version, in this session generation. */
export interface InstallOffer {
  version: string
  generation: number
}

/** Why the update installs: the quit dialog's Install now (a quit), or Restart and Update (an update's restart). */
export type ConsentKind = 'quit' | 'restart'

export interface InstallConsentRecord extends InstallOffer {
  kind: ConsentKind
}

export class InstallConsent {
  private generation = 0
  private consent: InstallConsentRecord | null = null

  /** Windows asks whether the session may end, or ends it: any consent given so far is void. */
  sessionEnding(): void {
    this.generation++
    this.consent = null
  }

  /** What a quit dialog offers now, for its answer to be checked against. */
  offer(version: string): InstallOffer {
    return { version, generation: this.generation }
  }

  /**
   * The quit dialog's Install now: kept only when the version it showed is the one ready now and no session end came
   * since it was shown. False (and no consent) otherwise.
   */
  accept(offer: InstallOffer, ready: string | null): boolean {
    if (!ready || offer.version !== ready || offer.generation !== this.generation) return false
    this.consent = { ...offer, kind: 'quit' }
    return true
  }

  /** Restart and Update for this version (its notice's, checked ready by the updater). */
  grant(version: string): void {
    this.consent = { version, generation: this.generation, kind: 'restart' }
  }

  /** Cancelled, Next time, Close this window only, a new quit request: nothing installs. */
  clear(): void {
    this.consent = null
  }

  /** The consent that holds for the version ready now, or null: none, another version's, or one a session end voided. */
  valid(ready: string | null): InstallConsentRecord | null {
    const c = this.consent
    return c && ready && c.version === ready && c.generation === this.generation ? c : null
  }
}
