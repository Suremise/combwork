// Dialects (HI-2065), HI-2465 round 2 (HR1): the events stream's lines as servers.ts broadcast says them, through the
// real resolver (sessions.ts registers it: a session's pinned chain, else the bound workspace's API chain). A stream with
// no session keeps the workspace its request was for, and each event is said in that workspace's API chain, whatever
// request (or none) is running as it comes; a closed workspace's stream, or one that named none, in the Default. Its own
// file: nothing here replaces the real resolver.
import { describe, expect, afterAll, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { closedNotice } from '../src/main/notices'
import type { CombworkEvent, Notice } from '../src/shared/types'

const AGENT = { workspace: 'C:\\ws', projectPath: 'C:\\ws\\webapp', agentId: 'a-1' }
const noticeEvent = (n: Partial<Notice>): CombworkEvent => ({ type: 'notice', notice: { id: 'n-1', kind: 'notice', title: 'Combwork a été fermé', body: 'b', projectPath: AGENT.projectPath, ...n } as Notice }) as CombworkEvent

describe("the events stream's lines, as broadcast says them", async () => {
  // The real resolver (sessions.ts registers it: a session's pinned chain, else the bound workspace's API chain) and two
  // workspaces with API files of their own.
  const base = tempDir('cw-agenttext-events-')
  mkdirSync(join(base, 'profile'), { recursive: true })
  ;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  const { apiTextTestHooks } = await import('../src/main/servers')
  const { apiChainReady, forgetApiChain, inApiWorkspace, requestApiWorkspace } = await import('../src/main/dialects/apiChain')
  const workspace = (name: string, closed: string): string => {
    const dir = join(base, name, '.combwork')
    mkdirSync(join(dir, 'dialects', 'api'), { recursive: true })
    writeFileSync(join(dir, 'dialects', 'api', 'cli.json'), JSON.stringify({ name: 'API', texts: { 'main.quit.closed': { text: closed, why: 'a test' } } }))
    return dir
  }
  const A = workspace('alpha', 'A CLOSED')
  const B = workspace('beta', 'B CLOSED')
  await apiChainReady(A)
  await apiChainReady(B)
  afterAll(() => [A, B].forEach(forgetApiChain))
  const closed = closedNotice(1)
  const event = noticeEvent({ apiTitle: closed.apiTitle, apiTitleText: closed.apiTitleText })
  const open = new Set([A, B].map((d) => d.toLowerCase()))
  const titleIn = (line: string | null): unknown => (line ? JSON.parse(line.split('\ndata: ')[1]).notice.title : null)
  const streams = { a: { agent: null, apiDir: A }, b: { agent: null, apiDir: B }, none: { agent: null, apiDir: null } }

  it("keeps the workspace a stream was opened for, from its request's binding", () => {
    expect(inApiWorkspace(A, () => requestApiWorkspace())).toBe(A)
    expect(requestApiWorkspace()).toBeNull()
  })

  it("says each stream's line in its own workspace's API chain, for an event outside any request", () => {
    const lineFor = apiTextTestHooks.streamLines(event, open)
    expect([titleIn(lineFor(streams.a)), titleIn(lineFor(streams.b)), titleIn(lineFor(streams.none))]).toEqual(['A CLOSED', 'B CLOSED', 'Combwork has closed'])
  })

  it("…and for an event made inside another workspace's request, whose binding never leaks into another stream", () => {
    const titles = inApiWorkspace(A, () => {
      const lineFor = apiTextTestHooks.streamLines(event, open)
      return [titleIn(lineFor(streams.b)), titleIn(lineFor(streams.none)), titleIn(lineFor(streams.a))]
    })
    expect(titles).toEqual(['B CLOSED', 'Combwork has closed', 'A CLOSED'])
  })

  it("says a closed workspace's stream in the Default", () => {
    const lineFor = apiTextTestHooks.streamLines(event, new Set([A.toLowerCase()]))
    expect([titleIn(lineFor(streams.a)), titleIn(lineFor(streams.b))]).toEqual(['A CLOSED', 'Combwork has closed'])
  })

  it('says an agent client in its session, never in a workspace a request bound', () => {
    const agentStream = { agent: AGENT, apiDir: null }
    expect(inApiWorkspace(A, () => titleIn(apiTextTestHooks.streamLines(event, open)(agentStream)))).toBe('Combwork has closed')
  })
})
