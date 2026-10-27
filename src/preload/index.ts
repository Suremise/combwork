import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { HiveBridge } from '../shared/api'
import type { HiveEvent } from '../shared/types'
import { COMMIT_WATCH_ARG } from '../shared/commitWatch'

/**
 * What arrived from main lately (HI-1775): each reply, event and terminal output, the same kind in a row counted as
 * one, so a long task's line can say what came just before it. A small ring: only the last moments matter.
 */
const arrived: { at: number; what: string; n: number }[] = []
const noteArrived = (what: string): void => {
  const at = Date.now()
  const last = arrived.at(-1)
  if (last && last.what === what && at - last.at < 100) {
    last.n++
    last.at = at
    return
  }
  arrived.push({ at, what, n: 1 })
  if (arrived.length > 300) arrived.shift()
}
ipcRenderer.on('hive:event', (_: IpcRendererEvent, event: HiveEvent) => noteArrived(`event ${event.type}`)) // i18n-ignore: hive.log, in English
ipcRenderer.on('pty:data', () => noteArrived('terminal output')) // i18n-ignore: hive.log, in English

const bridge: HiveBridge = {
  invoke: (channel, ...args) =>
    ipcRenderer.invoke(channel, ...args).then(
      (r) => (noteArrived(`reply ${channel}`), r), // i18n-ignore: hive.log, in English
      (e: unknown) => {
        noteArrived(`reply ${channel} (failed)`) // i18n-ignore: hive.log, in English
        throw e
      }
    ),
  onEvent(listener) {
    const handler = (_: IpcRendererEvent, event: HiveEvent): void => listener(event)
    ipcRenderer.on('hive:event', handler)
    return () => ipcRenderer.removeListener('hive:event', handler)
  },
  onPtyData(listener) {
    const handler = (_: IpcRendererEvent, key: string, data: string): void => listener(key, data)
    ipcRenderer.on('pty:data', handler)
    return () => ipcRenderer.removeListener('pty:data', handler)
  },
  onPtyExit(listener) {
    const handler = (_: IpcRendererEvent, key: string, code: number): void => listener(key, code)
    ipcRenderer.on('pty:exit', handler)
    return () => ipcRenderer.removeListener('pty:exit', handler)
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
  platform: process.platform,
  commitWatch: process.argv.includes(COMMIT_WATCH_ARG),
  arrivals: (from, to) => arrived.filter((a) => a.at >= from && a.at <= to).map((a) => (a.n > 1 ? `${a.what} ×${a.n}` : a.what))
}

contextBridge.exposeInMainWorld('hive', bridge)
