// React's commits counted in a test copy (HI-1387: shared/commitWatch.ts). main.tsx imports this first, before React
// DOM, which looks for a DevTools hook as it loads and then reports each commit to it, production builds too. Only when
// the preload says the watch is on (a test copy's window); a hook already there (React DevTools) is left alone. It
// imports nothing of React's, so it runs before React DOM does.
import { burstCounter, COMMIT_BURST_MARKER, COMMIT_BURST_SAID } from '../../shared/commitWatch'

interface Watched {
  hive?: { commitWatch?: boolean }
  __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown
  /** The largest burst so far, for suites (commitburst). */
  __hiveCommitBurst?: () => { max: number }
}

const w = window as unknown as Watched
if (w.hive?.commitWatch && w.__REACT_DEVTOOLS_GLOBAL_HOOK__ === undefined) {
  const bursts = burstCounter()
  let said = COMMIT_BURST_SAID - 1
  const noop = (): void => {}
  // The least of DevTools' hook React DOM needs to report to it: a renderer id from inject, and onCommitFiberRoot.
  w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject: () => 1,
    onCommitFiberRoot: () => {
      bursts.add(performance.now())
      if (bursts.max > said) {
        said = bursts.max
        console.info(`${COMMIT_BURST_MARKER} ${said}`)
      }
    },
    onCommitFiberUnmount: noop,
    onPostCommitFiberRoot: noop,
    onScheduleFiberRoot: noop,
    checkDCE: noop
  }
  w.__hiveCommitBurst = () => ({ max: bursts.max })
}
