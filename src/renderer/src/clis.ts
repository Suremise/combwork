import { registerCliSnapshot, type CliSnapshotView } from '@shared/providers/cliSnapshot'
import { call } from './api'
import { set, useStore } from './store'

/**
 * The user's own CLIs in this window (HI-3196): main's snapshot registered before the first render (main.tsx), so no
 * provider is read before it, and each later one (a `clis` event: a reload) in place of it, in order.
 */
function apply(view: CliSnapshotView): void {
  if (view.generation <= (useStore.getState().clis?.generation ?? 0)) return
  registerCliSnapshot(view)
  set({ clis: view })
}

export async function initClis(): Promise<void> {
  window.combwork.onEvent((e) => {
    if (e.type === 'clis') apply(e.snapshot)
  })
  apply(await call('clis:snapshot'))
}

/** Settings' Reload: main reads the folder again and every window gets the snapshot. */
export const reloadClis = async (): Promise<CliSnapshotView> => {
  const view = await call('clis:reload')
  apply(view)
  return view
}
