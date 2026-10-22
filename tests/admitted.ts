// A test's own folder used as a window's workspace (#1395): its databases are kept open only while a window holds it, so a
// test working on a bare folder (no WorkspaceService) admits it as a window opening it would, and dismisses it as that
// window closing it would. By the folder's real place, as the window records it.
import { placeKey } from '../src/main/fsutil'
import { admit, dismiss } from '../src/main/openingFence'

/** Admits the folder as a window opening it would; returns the dismissal (a window closing it). */
export function admitted(folder: string): () => void {
  const place = placeKey(folder)
  admit(place)
  return () => dismiss(place)
}
