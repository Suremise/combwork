// React's commits counted in a test copy (HI-1387: shared/commitWatch.ts). main.tsx imports this first, before React
// DOM, which looks for a DevTools hook as it loads and then reports each commit to it, production builds too. Only when
// the preload says the watch is on (a test copy's window); a hook already there (React DevTools) is left alone. It
// imports nothing of React's, so it runs before React DOM does.
import { burstCounter, chainCounter, COMMIT_BURST_MARKER, COMMIT_CHAIN_MARKER, FROM_MAIN_EVENT } from '../../shared/commitWatch'

interface Watched {
  combwork?: { commitWatch?: boolean }
  __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown
  /** The largest burst and the longest chain so far, for suites (commitburst) and lib.cjs. */
  __cwCommitBurst?: () => { max: number; chain: number }
}

/** The DOM events that start work from outside: the user's input, focus, scrolling, sizes, loads, animations ending. */
const OUTSIDE_EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerover', 'pointerout', 'mousedown', 'mousemove', 'mouseup', 'mouseover', 'mouseout', 'click', 'auxclick', 'dblclick', 'contextmenu', 'wheel', 'touchstart', 'touchmove', 'touchend', 'keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'change', 'compositionstart', 'compositionupdate', 'compositionend', 'focusin', 'focusout', 'focus', 'blur', 'paste', 'copy', 'cut', 'dragstart', 'drag', 'dragenter', 'dragover', 'dragleave', 'drop', 'dragend', 'scroll', 'resize', 'load', 'error', 'transitionend', 'animationend', 'visibilitychange', 'selectionchange', 'submit', 'toggle', 'message']

const w = window as unknown as Watched
if (w.combwork?.commitWatch && w.__REACT_DEVTOOLS_GLOBAL_HOOK__ === undefined) {
  const bursts = burstCounter()
  const chains = chainCounter()
  // Each new largest, small ones too (a window's normal work is what step 2's threshold is set from).
  let said = 0
  let saidChain = 0
  // Anything from outside starts a new chain (HI-1865): input and other DOM events (caught on their way down, before
  // any handler), a message or reply from main (the preload sends FROM_MAIN_EVENT first), and a timer's or frame's
  // callback. React schedules its own work (passive effects, the renders they ask for) through a MessageChannel and
  // microtasks, neither wrapped here, so a setState in a useEffect keeps one chain going however many tasks it takes.
  const outside = (): void => chains.outside()
  for (const type of OUTSIDE_EVENTS) window.addEventListener(type, outside, { capture: true, passive: true })
  window.addEventListener(FROM_MAIN_EVENT, outside, { capture: true })
  wrapCallbacks(outside)
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
      chains.commit()
      if (chains.max > saidChain) {
        saidChain = chains.max
        console.info(`${COMMIT_CHAIN_MARKER} ${saidChain}`)
      }
    },
    onCommitFiberUnmount: noop,
    onPostCommitFiberRoot: noop,
    onScheduleFiberRoot: noop,
    checkDCE: noop
  }
  w.__cwCommitBurst = () => ({ max: bursts.max, chain: chains.max })
}

/** Timers' and frames' callbacks start work from outside too: each marks it first (a string to evaluate stays as it is). */
function wrapCallbacks(outside: () => void): void {
  const marked = (fn: unknown): unknown =>
    typeof fn === 'function'
      ? (...args: unknown[]) => {
          outside()
          return (fn as (...a: unknown[]) => unknown)(...args)
        }
      : fn
  const g = window as unknown as Record<string, (fn: unknown, ...rest: unknown[]) => unknown>
  for (const name of ['setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback']) {
    const original = g[name]
    if (typeof original !== 'function') continue
    g[name] = (fn: unknown, ...rest: unknown[]) => original.call(window, marked(fn), ...rest)
  }
}
