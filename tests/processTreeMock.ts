// node:child_process for processTree's endTreeAsync tests (HI-3054, HI-3358): its PowerShell runs are replaced, so no real
// process is listed, held or ended. The listing run and the ending session's `list` requests each answer with the next of
// `probe.listings` (past the last, the last again); the session's `end` requests hold and end each target except those in
// `probe.gone` (exited before its end, or its pid another's by then: its start time doesn't match). `probe.hang`: no run
// answers or exits until it is killed. Used as `vi.mock('node:child_process', async (o) => (await import('./processTreeMock')).mocked(await o()))`.
import { EventEmitter } from 'node:events'

export const probe = {
  /** Each PowerShell command started, in order. */
  commands: [] as string[],
  /** Each request written to an ending session, in order. */
  requests: [] as string[],
  listings: [] as string[],
  /** How many listings were read. */
  lists: 0,
  /** `pid:started` of targets that can't be held. */
  gone: new Set<string>(),
  /** Run as each listing is read, before it is answered. */
  onList: null as (() => void) | null,
  hang: false,
  /** How many of an ending session's requests are answered: past that, it answers nothing more until it is killed. */
  answers: Infinity,
  /** HI-3376: how long (ms, fake or real time) the first listing run, and each session request by its index, takes to answer. */
  listDelayMs: 0,
  delays: [] as number[]
}

export function resetProbe(): void {
  probe.commands.length = 0
  probe.requests.length = 0
  probe.listings = []
  probe.lists = 0
  probe.gone.clear()
  probe.onList = null
  probe.hang = false
  probe.answers = Infinity
  probe.listDelayMs = 0
  probe.delays = []
}

/** The ending session's `end` requests, each as its targets (`pid:started`). */
export const ends = (): string[][] => probe.requests.filter((r) => r.startsWith('end ')).map((r) => r.slice(4).split(','))

const nextListing = (): string => {
  probe.onList?.()
  return probe.listings[Math.min(probe.lists++, probe.listings.length - 1)] ?? ''
}

type FakeChild = EventEmitter & { stdout: EventEmitter; stdin?: EventEmitter & { writable: boolean; write: (s: string) => void; end: () => void }; kill: () => void }

export function mocked<T extends object>(real: T): T {
  return {
    ...real,
    spawn: (_exe: string, args: string[]) => {
      const cmd = args.at(-1)!
      probe.commands.push(cmd)
      const c = new EventEmitter() as FakeChild
      c.stdout = new EventEmitter()
      let closed = false
      const close = (): void => {
        if (closed) return
        closed = true
        if (c.stdin) c.stdin.writable = false
        queueMicrotask(() => c.emit('close', 0))
      }
      c.kill = close
      if (cmd.includes('[Console]::In.ReadLine()')) {
        const stdin = new EventEmitter() as NonNullable<FakeChild['stdin']>
        stdin.writable = true
        stdin.end = close
        stdin.write = (s: string) => {
          const request = s.trim()
          probe.requests.push(request)
          if (probe.hang || probe.requests.length > probe.answers) return
          let answer: string[] = []
          if (request === 'list') answer = nextListing().split('\n')
          else if (request.startsWith('end '))
            for (const t of request.slice(4).split(',')) if (!probe.gone.has(t)) answer.push(`held ${t}`, `ended ${t.split(':')[0]}`)
          const say = (): void => void (closed || c.stdout.emit('data', Buffer.from([...answer, 'ok', ''].join('\r\n'))))
          const delay = probe.delays[probe.requests.length - 1] ?? 0
          if (delay) setTimeout(say, delay)
          else queueMicrotask(say)
        }
        c.stdin = stdin
      } else if (!probe.hang) {
        const say = (): void => {
          if (closed) return
          c.stdout.emit('data', Buffer.from(cmd.includes('Get-CimInstance') ? nextListing() : ''))
          close()
        }
        if (probe.listDelayMs) setTimeout(say, probe.listDelayMs)
        else queueMicrotask(say)
      }
      return c
    }
  } as T
}
