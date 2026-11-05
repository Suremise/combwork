import type { PermissionMode } from '../shared/types'

/**
 * What Combwork recognises on a CLI's screen in one launch, for the developer console (#638): the first time its prompt shows
 * (the adapter's `readyOutput`) and the first mode its footer shows (`footerMode`). Whatever the agent's status is: Combwork
 * acts on the prompt only while it is starting, and a transcript or hook can make it ready first, so the console's
 * status markers come and go with timing; these say only whether the screen was recognised, which is what a CLI's
 * contract holds (a changed prompt or footer is never recognised). Pure, so it is unit tested.
 */
export class ScreenRecognition {
  private tail = ''
  private prompt = false
  private footer = false

  constructor(private readonly patterns: { readyOutput?: RegExp; footerMode?(screen: string, launched?: PermissionMode | null): PermissionMode | null }) {}

  /** Output as it comes: true the first time the prompt is recognised in it (across chunks), never again. */
  output(data: string): boolean {
    if (this.prompt || !this.patterns.readyOutput) return false
    this.tail = (this.tail + data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ').replace(/\x1b\][^\x07]*\x07/g, ' ')).replace(/\s+/g, ' ').slice(-600)
    if (!this.patterns.readyOutput.test(this.tail)) return false
    this.prompt = true
    this.tail = ''
    return true
  }

  /** The screen as drawn: the mode its footer shows the first time one is recognised, never again; null otherwise. */
  footerOf(screen: string, launched: PermissionMode | null): PermissionMode | null {
    if (this.footer || !this.patterns.footerMode) return null
    const mode = this.patterns.footerMode(screen, launched)
    if (!mode) return null
    this.footer = true
    return mode
  }
}
