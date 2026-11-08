// A deliberate render loop, for the commit watch's own suite (HI-1387, commitburst): a setState per commit in a useEffect,
// as #1366's was, `n` times in a root of its own, then unmounted. Only where the watch is on (a test copy's window).
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

function Loop({ n, done }: { n: number; done: () => void }): null {
  const [i, setI] = useState(0)
  useEffect(() => {
    if (i < n) setI(i + 1)
    else done()
  }, [i, n, done])
  return null
}

type Seams = { __cwCommitBurst?: unknown; __cwTestCommitLoop?: (n: number) => Promise<void> }
// The window's seams by name, never the window itself in a variable (HI-2697: the test picker reads that as unknown code).
if ((window as unknown as Seams).__cwCommitBurst) {
  ;(window as unknown as Seams).__cwTestCommitLoop = (n) =>
    new Promise<void>((resolve) => {
      const host = document.createElement('div')
      const root = createRoot(host)
      root.render(
        <Loop
          n={n}
          done={() => {
            root.unmount()
            resolve()
          }}
        />
      )
    })
}
