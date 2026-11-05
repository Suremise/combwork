// Hardware acceleration off (#676): Settings → Advanced's value is read from advanced.json before the app is ready (any
// file that can't be read, or a value that isn't valid, leaves it on), --disable-gpu turns it off for one start (and a
// restart leaves the switch out), and Copy Diagnostics says which, with Electron's GPU feature status.
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { HARDWARE_ACCELERATION_OFF, HEAP_SNAPSHOT_NEAR_LIMIT, advancedDef, advancedFileText } from '../src/shared/advanced'
import { advancedAtStart, gpuAtStart, gpuDiagnostics, relaunchArgs } from '../src/main/gpu'
import { settingEntry } from '../src/shared/settingsCatalog'
import { tempDir } from './tempDir'

const profile = (text?: string): string => {
  const dir = tempDir('gpu-')
  if (text !== undefined) writeFileSync(join(dir, 'advanced.json'), text)
  return dir
}
const withValue = (v: unknown): string => advancedFileText({ [HARDWARE_ACCELERATION_OFF]: v }, {})

describe('hardware acceleration at start (#676)', () => {
  it("is Settings → Advanced's value, read early from advanced.json", () => {
    expect(gpuAtStart(profile(withValue(true)), false)).toEqual({ off: true, why: 'setting', setting: true })
    // As Combwork reads the value anywhere else: "on" written by hand is on.
    expect(gpuAtStart(profile(withValue('on')), false)).toEqual({ off: true, why: 'setting', setting: true })
    expect(gpuAtStart(profile(withValue(false)), false)).toEqual({ off: false, why: null, setting: false })
  })

  it('stays on without the file, with one that is damaged, or a value that is not valid', () => {
    expect(gpuAtStart(profile(), false)).toEqual({ off: false, why: null, setting: false })
    expect(gpuAtStart(profile('{ not json'), false).off).toBe(false)
    expect(gpuAtStart(profile('[]'), false).off).toBe(false)
    expect(gpuAtStart(profile(withValue('sometimes')), false).off).toBe(false)
    expect(gpuAtStart(profile(advancedFileText({ 'cw.mcp.replySeconds': 600 }, {})), false).off).toBe(false)
  })

  it("an upgraded profile's hive.* value counts at the first start, before the store has written it back; a cw.* one there too wins (HI-2518)", () => {
    const old = (values: Record<string, unknown>): string => profile(advancedFileText(values, {}))
    expect(HARDWARE_ACCELERATION_OFF).toBe('cw.disableHardwareAcceleration')
    expect(gpuAtStart(old({ 'hive.disableHardwareAcceleration': true }), false)).toEqual({ off: true, why: 'setting', setting: true })
    expect(gpuAtStart(old({ 'hive.disableHardwareAcceleration': true, 'cw.disableHardwareAcceleration': false }), false).off).toBe(false)
    expect(advancedAtStart(old({ 'hive.heapSnapshotNearLimit': true }), HEAP_SNAPSHOT_NEAR_LIMIT)).toBe(true)
    expect(advancedAtStart(old({ 'hive.heapSnapshotNearLimit': true, 'cw.heapSnapshotNearLimit': false }), HEAP_SNAPSHOT_NEAR_LIMIT)).toBe(false)
    // Read only: the early read never writes the file.
    const dir = old({ 'hive.disableHardwareAcceleration': true })
    gpuAtStart(dir, false)
    expect(JSON.parse(readFileSync(join(dir, 'advanced.json'), 'utf8')).values).toEqual({ 'hive.disableHardwareAcceleration': true })
  })

  it('--disable-gpu turns it off for this start; the setting is the reason when both say so', () => {
    expect(gpuAtStart(profile(), true)).toEqual({ off: true, why: 'switch', setting: false })
    expect(gpuAtStart(profile(withValue(true)), true)).toEqual({ off: true, why: 'setting', setting: true })
  })

  it('a restart starts Combwork as it was started, without the once-only --disable-gpu', () => {
    expect(relaunchArgs(['C:\\Hive\\Hive.exe', '--disable-gpu', '--hidden'])).toEqual(['--hidden'])
    expect(relaunchArgs(['electron.exe', '.', '--DISABLE-GPU'])).toEqual(['.'])
    expect(relaunchArgs(['Hive.exe'])).toEqual([])
  })

  it('Copy Diagnostics says whether it is on, why not, and the GPU feature status', () => {
    const status = { webgl: 'unavailable_off', gpu_compositing: 'disabled_software' }
    expect(gpuDiagnostics({ off: true, why: 'setting', setting: true }, status)).toBe('- **Graphics**: hardware acceleration off (Settings → Advanced); gpu_compositing: disabled_software, webgl: unavailable_off')
    expect(gpuDiagnostics({ off: true, why: 'switch', setting: false }, {})).toBe('- **Graphics**: hardware acceleration off (--disable-gpu, this start); no GPU feature status')
    expect(gpuDiagnostics({ off: false, why: null, setting: false }, { webgl: 'enabled' })).toBe('- **Graphics**: hardware acceleration on; webgl: enabled')
  })

  it('is a Combwork setting that applies when Combwork restarts, for Settings and the Assistant', () => {
    expect(advancedDef(HARDWARE_ACCELERATION_OFF)).toMatchObject({ group: 'cw', kind: 'boolean', default: false, applies: 'restart' })
    expect(settingEntry(`advanced.${HARDWARE_ACCELERATION_OFF}`)?.restart).toBe('hive')
  })
})
