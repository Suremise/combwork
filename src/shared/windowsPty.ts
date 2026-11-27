/**
 * The first Windows build whose ConPTY reflows its lines itself and no longer ends a line wrapped at the last column with
 * CR LF (xterm's own cut-off: CoreTerminal's wrapping heuristics, Buffer._isReflowEnabled).
 */
export const CONPTY_REFLOW_BUILD = 21376

/**
 * xterm's `windowsPty` option for a pane on this system (HI-3589), from `platform` and the OS version
 * (`process.getSystemVersion()`: "10.0.19045" on Windows 10). Combwork runs Windows' own ConPTY (ptyHost.ts). From build
 * 21376 (Windows 11): no build number, so xterm re-wraps lines as the terminal narrows or widens (#896), as ConPTY
 * itself does. Below it (Windows 10) the build, so xterm joins a line that ConPTY wrapped with CR LF at the last column
 * (selecting and copying a long line gives it whole) and leaves reflowing to ConPTY, which reprints the screen itself.
 * An OS version it can't read: as from 21376.
 */
export function windowsPtyOption(platform: string, systemVersion: string): { backend: 'conpty'; buildNumber?: number } {
  const build = platform === 'win32' ? Number(systemVersion.split('.')[2]) : NaN
  return Number.isInteger(build) && build > 0 && build < CONPTY_REFLOW_BUILD ? { backend: 'conpty', buildNumber: build } : { backend: 'conpty' }
}
