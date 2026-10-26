import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { HiveBridge } from '../shared/api'
import type { HiveEvent } from '../shared/types'
import { COMMIT_WATCH_ARG } from '../shared/commitWatch'

const bridge: HiveBridge = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
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
  commitWatch: process.argv.includes(COMMIT_WATCH_ARG)
}

contextBridge.exposeInMainWorld('hive', bridge)
