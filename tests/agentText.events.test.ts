// Dialects (HI-2065), HI-2465: a notification's title on the Agent API's events stream (/v1/events) keeps its English
// as made (`apiTitle`) and its text as data beside it (`apiTitleText`); each client's line is said in that client's scope
// (servers.ts broadcast), so a dialect's override reaches it. With no chain the events are byte-identical.
import { describe, expect, afterEach, it } from 'vitest'
import { setChainResolver, type DialectChain } from '../src/shared/agentText'
import { inRequestScope } from '../src/shared/agentText/asyncScope'
import { apiEventFor } from '../src/main/apiEvents'
import { closedNotice } from '../src/main/notices'
import { finishedApiTitle, finishedApiTitleText, type Finish } from '../src/shared/bursts'
import type { HiveEvent, Notice } from '../src/shared/types'

const chain = (texts: Record<string, string>): DialectChain => ({ texts, files: ['test.json'], hash: 'test' })
const AGENT = { workspace: 'C:\\ws', projectPath: 'C:\\ws\\webapp', agentId: 'a-1' }
/** A client's line, as broadcast says it: in the agent's scope, or the API's for the workspace and viewer tokens. */
const forClient = (event: HiveEvent, agent: typeof AGENT | null) => inRequestScope(agent ? { projectPath: agent.projectPath, agentId: agent.agentId } : null, () => apiEventFor(event, agent))
const noticeEvent = (n: Partial<Notice>): HiveEvent => ({ type: 'notice', notice: { id: 'n-1', kind: 'notice', title: 'Hive a été fermé', body: 'b', projectPath: AGENT.projectPath, ...n } as Notice }) as HiveEvent
const titleOf = (e: Record<string, unknown> | null): unknown => (e?.notice as { title?: unknown } | undefined)?.title


describe("the events stream's notification titles", () => {
  // Each test's resolver is its own (the real one, sessions.ts's, is agentText.eventsStream.test.ts's).
  afterEach(() => setChainResolver(null))
  const closed = closedNotice(2)
  const event = noticeEvent({ apiTitle: closed.apiTitle, apiTitleText: closed.apiTitleText })

  it('read in English as made with no chain, for every client, and leave the text as data out', () => {
    expect(closed.apiTitle).toBe('Combwork has closed')
    for (const client of [AGENT, null]) expect(forClient(event, client)).toEqual({ type: 'notice', notice: { id: 'n-1', kind: 'notice', title: 'Combwork has closed', projectPath: AGENT.projectPath } })
    // A notice from before (no text kept), or one whose title is its English: as it was.
    expect(titleOf(forClient(noticeEvent({ apiTitle: 'Combwork has closed' }), AGENT))).toBe('Combwork has closed')
    expect(titleOf(forClient(noticeEvent({ title: 'Agent finished' }), AGENT))).toBe('Agent finished')
  })

  it("are said in each client's chain", () => {
    setChainResolver((scope) => (scope.kind === 'session' ? chain({ 'main.quit.closed': 'Hive quit' }) : chain({ 'main.quit.closed': 'Hive closed (API)' })))
    expect(titleOf(forClient(event, AGENT))).toBe('Hive quit')
    expect(titleOf(forClient(event, null))).toBe('Hive closed (API)')
    // An override of another text leaves it as made.
    setChainResolver(() => chain({ 'main.plan.used': 'x' }))
    expect(titleOf(forClient(event, AGENT))).toBe('Combwork has closed')
  })

  it("a burst of finishes keeps its group title's text as data, which the stream says in the client's chain", () => {
    const one = (agent: string): Finish => ({ projectPath: AGENT.projectPath, project: 'webapp', agent, title: `${agent} finished`, apiTitle: `${agent} finished`, body: '' })
    const group = [one('b1'), one('b2'), one('b3')]
    expect(finishedApiTitle(group)).toBe('3 agents finished in webapp')
    const burst = noticeEvent({ kind: 'finished', title: '3 agents finished in webapp', apiTitleText: finishedApiTitleText(group) })
    expect(titleOf(forClient(burst, AGENT))).toBe('3 agents finished in webapp')
    setChainResolver(() => chain({ 'main.finished.inProject': '{project}: {n} done' }))
    expect(titleOf(forClient(burst, AGENT))).toBe('webapp: 3 done')
    // Alone, a finish keeps its own text (none here: as made).
    expect(finishedApiTitleText([group[0]])).toBeUndefined()
  })
})
