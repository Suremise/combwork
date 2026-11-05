import { readFileSync } from 'original-fs'
import { join } from 'path'
import { HARDWARE_ACCELERATION_OFF, advancedDef, checkAdvanced, parseAdvancedFile } from '../shared/advanced'

/**
 * Hardware acceleration off (#676): for a graphics driver that leaves Combwork's window blank, flickering or crashing. It has
 * to be decided before the app is ready, so Settings → Advanced's value is read straight from advanced.json here, before
 * the full load (advanced.ts); `--disable-gpu` on Combwork's command line does the same for that start only (Chromium takes
 * the switch too). Terminals then skip xterm's WebGL renderer (AppInfo.gpu).
 */

/** The command-line switch that starts Combwork once without the graphics card. */
export const GPU_SWITCH = 'disable-gpu'

export interface GpuAtStart {
  /** Combwork draws without the graphics card this run. */
  off: boolean
  /** Why: Settings → Advanced, or --disable-gpu for this start; null when it's on. */
  why: 'setting' | 'switch' | null
  /** Settings → Advanced's value as Combwork started (a change since offers a restart). */
  setting: boolean
}

/**
 * Whether this start turns hardware acceleration off: advanced.json's value in the profile `folder` (one that is missing,
 * unreadable or not valid is off, the default), or `--disable-gpu`.
 */
export function gpuAtStart(folder: string, hasSwitch: boolean): GpuAtStart {
  const setting = advancedAtStart(folder, HARDWARE_ACCELERATION_OFF)
  return { off: setting || hasSwitch, why: setting ? 'setting' : hasSwitch ? 'switch' : null, setting } // i18n-ignore: values, not text
}

/** A boolean advanced setting's value in advanced.json, read before the full load: one missing, unreadable or not valid is off. */
export function advancedAtStart(folder: string, id: string): boolean {
  let text: string
  try {
    text = readFileSync(join(folder, 'advanced.json'), 'utf8')
  } catch {
    return false
  }
  const parsed = parseAdvancedFile(text)
  const raw = 'values' in parsed ? parsed.values[id] : undefined
  const def = advancedDef(id)
  if (raw === undefined || !def) return false
  const checked = checkAdvanced(def, raw)
  return 'value' in checked && checked.value === true
}

let thisRun: GpuAtStart = { off: false, why: null, setting: false }

/** Decides this start's hardware acceleration (before the app is ready), and keeps it for Copy Diagnostics. */
export function startGpu(folder: string, hasSwitch: boolean): GpuAtStart {
  thisRun = gpuAtStart(folder, hasSwitch)
  return thisRun
}

/** This run's hardware acceleration, as it started. */
export const gpuThisRun = (): GpuAtStart => thisRun

/** Copy Diagnostics' line: hardware acceleration on or off and why, and Electron's GPU feature status. */
export function gpuDiagnostics(run: GpuAtStart, status: Record<string, string>): string {
  const state = !run.off ? 'on' : run.why === 'switch' ? 'off (--disable-gpu, this start)' : 'off (Settings → Advanced)' // i18n-ignore: Copy Diagnostics' report: a bug report for the maintainer, in English
  return `- **Graphics**: hardware acceleration ${state}; ${gpuStatusLine(status) || 'no GPU feature status'}` // i18n-ignore: Copy Diagnostics' report: a bug report for the maintainer, in English
}

/** The arguments a restart starts Combwork with: this start's own, without the once-only --disable-gpu. */
export const relaunchArgs = (argv: string[]): string[] => argv.slice(1).filter((a) => a.toLowerCase() !== `--${GPU_SWITCH}`)

/** Electron's GPU feature status in a line for Copy Diagnostics ("gpu_compositing: disabled_software, webgl: …"). */
export const gpuStatusLine = (status: Record<string, string>): string =>
  Object.entries(status)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ')
