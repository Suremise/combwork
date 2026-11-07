import { useEffect, useRef, useState } from 'react'
import type { Account } from '@shared/types'
import { providerDescriptor } from '@shared/providers'
import { msg, tr, type Msg } from '@shared/i18n'
import type { ContextCheck, ContextValue, LastCheck, ServerContext, ToolTest, ToolTestFailure } from '@shared/serverDiagnostics'
import { call, errorMessage } from '../api'
import { timeAgo } from '../util'
import { Icon, Modal } from './ui'

/**
 * A server connection's diagnostics (HI-2683, design s7 and s11): a model's context as its server reports it (the most
 * it was trained for, what is configured, what is allocated now, each with when it was read, or "not reported"), the
 * context the user says it has, the advice, and a small structured tool-call test the user starts. Read-only: nothing
 * here changes the server. Its checks run in main (the key never comes here); each has its own id, cancelled as the
 * dialog closes or another starts.
 */

const D = {
  title: msg({ id: 'settings.connections.diag.title', defaultMessage: 'Server diagnostics: {name}', description: "Title of the Server diagnostics dialog (Settings → Accounts & Connections → a server connection's Check Server…, HI-2683). {name} is the connection's name." }),
  open: msg({ id: 'settings.connections.diag.open', defaultMessage: 'Check Server…', description: "Button on a server connection (Settings → Accounts & Connections, the connection editor, Provider Setup): opens its Server diagnostics (its model's context, a tool-call test)." }),
  model: msg({ id: 'settings.connections.diag.model', defaultMessage: 'Model', description: 'Label of the model chosen in Server diagnostics.' }),
  kind: msg({ id: 'settings.connections.diag.kind', defaultMessage: '{kind, select, llamacpp {llama.cpp server} ollama {Ollama} other {A compatible server: its context isn\'t readable}}', description: "Server diagnostics: what the server is, by how it answered. {kind} is a key: don't translate the keys. llama.cpp and Ollama are product names." }),
  prefixed: msg({ id: 'settings.connections.diag.prefixed', defaultMessage: "Its base URL has a path (a gateway), so Combwork doesn't ask the server's own paths for its context: not reported.", description: 'Server diagnostics, when the base URL has a path such as /anthropic after the host: the context fields are not asked for.' }),
  reading: msg({ id: 'settings.connections.diag.reading', defaultMessage: 'Reading…', description: 'Server diagnostics while it reads the context from the server.' }),
  readAgain: msg({ id: 'settings.connections.diag.readAgain', defaultMessage: 'Read Again', description: 'Button in Server diagnostics: reads the context from the server again.' }),
  context: msg({ id: 'settings.connections.diag.context', defaultMessage: 'Context', description: 'Heading in Server diagnostics: the model\'s context window, in tokens.' }),
  trained: msg({ id: 'settings.connections.diag.trained', defaultMessage: 'Trained maximum', description: 'A row of Server diagnostics: the most context the model was trained for, as the server reports it.' }),
  configured: msg({ id: 'settings.connections.diag.configured', defaultMessage: 'Configured', description: "A row of Server diagnostics: the context set for the model in the server's settings (Ollama's Modelfile num_ctx)." }),
  allocated: msg({ id: 'settings.connections.diag.allocated', defaultMessage: 'Allocated now', description: 'A row of Server diagnostics: the context the server has allocated for the loaded model now.' }),
  value: msg({ id: 'settings.connections.diag.value', defaultMessage: '{tokens, number} tokens · read {ago}', description: 'A context value in Server diagnostics: {tokens} is a number, {ago} when it was read ("2 min ago").' }),
  notReported: msg({ id: 'settings.connections.diag.notReported', defaultMessage: 'not reported', description: "A context value in Server diagnostics the server didn't report (never shown as 0)." }),
  notLoaded: msg({ id: 'settings.connections.diag.notLoaded', defaultMessage: "not loaded: Ollama allocates it when the model is first used", description: "Server diagnostics' Allocated now for an Ollama model that isn't loaded now." }),
  ollamaDefault: msg({ id: 'settings.connections.diag.ollamaDefault', defaultMessage: "Ollama's own default (OLLAMA_CONTEXT_LENGTH) can't be read over its API: where no Modelfile sets num_ctx, it decides the context.", description: "A note in Server diagnostics for an Ollama server. OLLAMA_CONTEXT_LENGTH and num_ctx are Ollama's setting names: keep them." }),
  templateTools: msg({ id: 'settings.connections.diag.templateTools', defaultMessage: "{state, select, supported {Its chat template supports tool calls.} unsupported {Its chat template doesn't support tool calls. llama-server needs --jinja for tools: if it was started without it, add it.} inconsistent {Its chat template's tool flags disagree. llama-server needs --jinja for tools: if it was started without it, add it.} other {Its chat template doesn't say whether it supports tools. llama-server needs --jinja for tools: if it was started without it, add it.}}", description: "Server diagnostics for a llama.cpp server: what its chat template says of tools. {state} is a key: translate the texts only. llama-server and --jinja are a program and its option: keep them." }),
  mine: msg({ id: 'settings.connections.diag.mine', defaultMessage: "Context (if the server doesn't say)", description: "Label of the box in Server diagnostics where the user types the context their model has on this server, in tokens. Combwork keeps it as theirs." }),
  mineHint: msg({ id: 'settings.connections.diag.mineHint', defaultMessage: "Yours, in tokens: compared with the advice here. A server's own figures never replace it.", description: 'Under the context box in Server diagnostics.' }),
  save: msg({ id: 'settings.connections.diag.save', defaultMessage: 'Save', description: 'Button in Server diagnostics: saves the context the user typed.' }),
  clear: msg({ id: 'settings.connections.diag.clear', defaultMessage: 'Clear', description: 'Button in Server diagnostics: clears the context the user typed.' }),
  advice: msg({ id: 'settings.connections.diag.advice', defaultMessage: '{name} recommends {size, number} tokens or more for {cli}.', description: 'Server diagnostics: the service\'s advice ({name}: "Ollama", {cli}: "Claude Code", {size}: 64,000).' }),
  below: msg({ id: 'settings.connections.diag.below', defaultMessage: 'This model has {tokens, number}: below it. A prompt longer than the context can lose its start, tools included.', description: 'Server diagnostics: the model\'s context ({tokens}) is below the advice.' }),
  meets: msg({ id: 'settings.connections.diag.meets', defaultMessage: 'This model has {tokens, number}: enough by that advice.', description: "Server diagnostics: the model's context ({tokens}) meets the advice." }),
  measured: msg({ id: 'settings.connections.diag.measured', defaultMessage: "Measured on a test server: Claude Code's first request, with Combwork's tools, was about 14,000 to 28,000 tokens. Other models count differently.", description: 'A note in Server diagnostics: a measurement from a test server, a guide, not a rule.' }),
  tools: msg({ id: 'settings.connections.diag.tools', defaultMessage: 'Tool calls', description: 'Heading in Server diagnostics: the tool-call test.' }),
  toolsWhat: msg({ id: 'settings.connections.diag.toolsWhat', defaultMessage: "Asks the model to call one tool, then gives it the tool's result and checks its answer used it, through the API Claude Code uses. A small structured tool-call check: it doesn't show that every Claude Code tool or a long conversation will work.", description: 'Under the Tool calls heading in Server diagnostics: what the test does and what it proves.' }),
  test: msg({ id: 'settings.connections.diag.test', defaultMessage: 'Test Tool Calls', description: 'Button in Server diagnostics: runs the tool-call test (two requests to the model).' }),
  testing: msg({ id: 'settings.connections.diag.testing', defaultMessage: 'Testing…', description: 'Server diagnostics while the tool-call test runs (a model may take a while to load).' }),
  passed: msg({ id: 'settings.connections.diag.passed', defaultMessage: 'Passed: the model called the tool as asked and answered with its result ({ago}).', description: "Server diagnostics: the tool-call test passed. {ago} is when (\"just now\")." }),
  failedStep: msg({ id: 'settings.connections.diag.failedStep', defaultMessage: '{step, select, 2 {Failed at its result:} other {Failed at the call:}} {why}', description: 'Server diagnostics: the tool-call test failed at its first request (the call) or second (the tool\'s result). {why} is why, a sentence.' }),
  seen: msg({ id: 'settings.connections.diag.seen', defaultMessage: 'Seen: HTTP {status}{stop, select, none {} other {, stop reason {stop}}}{blocks, select, none {} other {, blocks {blocks}}}', description: "Under a failed tool-call test in Server diagnostics: what the server's reply was, as data. {status}, {stop} and {blocks} are values from the reply (none: not there)." }),
  close: msg({ id: 'settings.connections.diag.close', defaultMessage: 'Close', description: 'Button closing Server diagnostics.' }),
  line: msg({ id: 'settings.connections.diag.line', defaultMessage: 'Server context {tokens, number} (read {ago})', description: "A line in the connection editor and Provider Setup for a server connection: its model's context as last read in Server diagnostics. {ago}: when." }),
  lineBelow: msg({ id: 'settings.connections.diag.lineBelow', defaultMessage: 'Server context {tokens, number} (read {ago}): below {name}\'s advice of {size, number}', description: "The same line when the context is below the service's advice ({name}: \"Ollama\", {size}: 64,000)." }),
  failed: msg({ id: 'settings.connections.diag.failed', defaultMessage: "Couldn't check the server", description: "An error's title in Server diagnostics." })
}

/** Why a check gave nothing, and why a tool test failed: each its own sentence (never the server's text). */
const WHY: Record<ToolTestFailure | 'unreachable' | 'stale' | 'busy', Msg> = {
  unreachable: msg({ id: 'settings.connections.diag.why.unreachable', defaultMessage: "Couldn't reach the server: check its base URL and that it is running.", description: 'Why a Server diagnostics check failed: no answer.' }),
  stale: msg({ id: 'settings.connections.diag.why.stale', defaultMessage: 'The connection changed while it was checked. Check again.', description: 'Why a Server diagnostics check was dropped: its server, key or model changed meanwhile, or a newer check started.' }),
  busy: msg({ id: 'settings.connections.diag.why.busy', defaultMessage: 'Other checks are running. Try again in a moment.', description: 'Why a Server diagnostics check was refused: too many at once.' }),
  endpoint: msg({ id: 'settings.connections.diag.why.endpoint', defaultMessage: "The server has no Messages API at this base URL (Claude Code calls the base URL followed by /v1/messages). Check the base URL.", description: 'Why the tool-call test failed: 404 or 405 from the messages URL. Keep /v1/messages as it is.' }),
  protocol: msg({ id: 'settings.connections.diag.why.protocol', defaultMessage: "The server's answer isn't the Messages API's (as Claude Code expects it).", description: "Why the tool-call test failed: the reply wasn't the Anthropic Messages API's shape." }),
  refused: msg({ id: 'settings.connections.diag.why.refused', defaultMessage: 'The server refused the key (401). Replace the key, then test again.', description: 'Why the tool-call test failed: 401.' }),
  forbidden: msg({ id: 'settings.connections.diag.why.forbidden', defaultMessage: 'The server refused access (403).', description: 'Why the tool-call test failed: 403.' }),
  modelRejected: msg({ id: 'settings.connections.diag.why.modelRejected', defaultMessage: "The server says it doesn't have this model. Check its id, or load or pull it on the server.", description: 'Why the tool-call test failed: the server said the model is missing.' }),
  promptTooLarge: msg({ id: 'settings.connections.diag.why.promptTooLarge', defaultMessage: "The server says the prompt is larger than the model's context. Give the model a larger context in the server's settings.", description: 'Why the tool-call test failed: the server said the prompt exceeds the context.' }),
  toolsUnsupported: msg({ id: 'settings.connections.diag.why.toolsUnsupported', defaultMessage: "The server says it doesn't support tools for this model (for llama.cpp, --jinja may be missing).", description: 'Why the tool-call test failed: the server said tools are unsupported. --jinja is a llama-server option: keep it.' }),
  toolText: msg({ id: 'settings.connections.diag.why.toolText', defaultMessage: "The model returned tool-shaped text rather than a tool call: check the loaded context and the server's tool parser.", description: "Why the tool-call test failed: the model wrote out a tool call as text instead of making one." }),
  noToolCall: msg({ id: 'settings.connections.diag.why.noToolCall', defaultMessage: "The model answered without calling the tool it was asked to use.", description: 'Why the tool-call test failed: an answer with no tool call.' }),
  wrongTool: msg({ id: 'settings.connections.diag.why.wrongTool', defaultMessage: 'The model called a tool it wasn\'t offered.', description: 'Why the tool-call test failed: a call to another tool.' }),
  extraCalls: msg({ id: 'settings.connections.diag.why.extraCalls', defaultMessage: 'The model made more than the one call asked for.', description: 'Why the tool-call test failed: several tool calls.' }),
  invalidArguments: msg({ id: 'settings.connections.diag.why.invalidArguments', defaultMessage: "The model's call had arguments the tool doesn't take.", description: "Why the tool-call test failed: the call's arguments don't fit the tool's schema." }),
  wrongArgument: msg({ id: 'settings.connections.diag.why.wrongArgument', defaultMessage: "The model's call was valid but not for what was asked (another city).", description: 'Why the tool-call test failed: a valid call with the wrong argument.' }),
  thinkingBudget: msg({ id: 'settings.connections.diag.why.thinkingBudget', defaultMessage: 'The model spent its whole output budget thinking, and wrote no answer.', description: 'Why the tool-call test failed: only thinking, cut at the output limit.' }),
  resultIgnored: msg({ id: 'settings.connections.diag.why.resultIgnored', defaultMessage: "The model's answer didn't use the tool's result.", description: "Why the tool-call test failed at its second step: the answer doesn't contain the result, or calls the tool again." }),
  incomplete: msg({ id: 'settings.connections.diag.why.incomplete', defaultMessage: 'The answer stopped before its end (the output limit).', description: 'Why the tool-call test failed at its second step: cut at the output limit.' }),
  unexpected: msg({ id: 'settings.connections.diag.why.unexpected', defaultMessage: 'An unexpected reply.', description: "Why the tool-call test failed: none of the named reasons; what was seen is shown under it." })
}

/** The button that opens them, wherever a server connection shows. */
export const CHECK_SERVER = D.open

const newRequest = (): string => `${Date.now()}-${Math.random().toString(36).slice(2)}`

/** The context to compare with the advice: what the server allocated, else configured, else the user's own. */
export function effectiveContext(ctx: ServerContext | undefined, mine: number | undefined): number | null {
  return ctx?.allocated?.tokens ?? ctx?.configured?.tokens ?? mine ?? null
}

/** The advice for a connection: its preset's, or Ollama's when the server answered as Ollama. */
export function adviceOf(c: Account, ctx?: ServerContext): { name: string; size: number } | null {
  const presets = providerDescriptor(c.provider).capabilities.connections?.server?.presets ?? []
  const p = presets.find((x) => x.id === c.server?.preset) ?? (ctx?.kind === 'ollama' ? presets.find((x) => x.id === 'ollama') : undefined)
  return p?.contextAdvice ? { name: p.name, size: p.contextAdvice } : null
}

function ContextRow({ label, v, empty }: { label: Msg; v?: ContextValue; empty?: string }) {
  return (
    <>
      <span className="muted">{tr(label)}</span>
      <span data-context-value>{v ? tr(D.value, { tokens: v.tokens, ago: timeAgo(new Date(v.readAt).toISOString()) }) : (empty ?? tr(D.notReported))}</span>
    </>
  )
}

export function ServerDiagnosticsDialog({ c, model: first, onClose }: { c: Account; model?: string; onClose: () => void }) {
  const models = c.server?.models ?? []
  const [model, setModel] = useState(first && models.some((m) => m.id === first) ? first : (models[0]?.id ?? ''))
  const [problem, setProblem] = useState<string | null>(null)
  return (
    <Modal
      title={tr(D.title, { name: c.name })}
      icon="pulse"
      wide
      error={problem}
      onClose={onClose}
      footer={<button className="btn subtle" onClick={onClose}>{tr(D.close)}</button>}
    >
      <div className="agent-form server-diag" data-server-diag={c.id}>
        <label htmlFor="diag-model">{tr(D.model)}</label>
        <select
          id="diag-model"
          className="input"
          value={model}
          onChange={(e) => {
            setProblem(null)
            setModel(e.target.value)
          }}
        >
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
            </option>
          ))}
        </select>
        {/* Everything of one model's is its own (HR3, round 1): another model starts afresh, and what was asked for the
            one before is cancelled as it goes. */}
        {model && <ModelDiagnostics key={`${c.id}\0${model}`} c={c} model={model} setProblem={setProblem} />}
      </div>
    </Modal>
  )
}

/** One model's diagnostics: its context, the user's own figure, the advice and the tool-call test. */
function ModelDiagnostics({ c, model, setProblem }: { c: Account; model: string; setProblem: (p: string | null) => void }) {
  const [last, setLast] = useState<LastCheck>({})
  const [reading, setReading] = useState(false)
  const [testing, setTesting] = useState(false)
  const mineSaved = c.server?.models.find((m) => m.id === model)?.context
  const [mine, setMine] = useState(mineSaved ? String(mineSaved) : '')
  // The saved figure changed (saved here, or elsewhere): the field shows it.
  useEffect(() => setMine(mineSaved ? String(mineSaved) : ''), [mineSaved])
  // This model's checks in flight, by kind; `live` false once it is gone (a late reply then changes nothing).
  const running = useRef<{ read?: string; test?: string; live: boolean }>({ live: true })

  const read = async (): Promise<void> => {
    const request = newRequest()
    running.current.read = request
    setReading(true)
    setProblem(null)
    try {
      const r: ContextCheck = await call('connections:readContext', c.id, model, request)
      if (!running.current.live || running.current.read !== request) return
      if (r.ok) setLast((l) => ({ ...l, context: r }))
      else setProblem(tr(WHY[r.why]))
    } catch (e) {
      if (running.current.live && running.current.read === request) setProblem(errorMessage(e))
    } finally {
      if (running.current.live && running.current.read === request) {
        running.current.read = undefined
        setReading(false)
      }
    }
  }
  const test = async (): Promise<void> => {
    const request = newRequest()
    running.current.test = request
    setTesting(true)
    try {
      const r: ToolTest = await call('connections:testTools', c.id, model, request)
      if (!running.current.live || running.current.test !== request) return
      setLast((l) => ({ ...l, tools: { ...r, at: r.at ?? Date.now() } as LastCheck['tools'] }))
    } catch (e) {
      if (running.current.live && running.current.test === request) setProblem(errorMessage(e))
    } finally {
      if (running.current.live && running.current.test === request) {
        running.current.test = undefined
        setTesting(false)
      }
    }
  }

  // Its last results, then its context read again (read-only, and asked for by opening this); its checks cancelled by
  // their own ids as it goes.
  useEffect(() => {
    const own = running.current
    void call('connections:lastCheck', c.id, model).then((l) => own.live && setLast((now) => ({ ...l, ...now })), () => undefined)
    void read()
    return () => {
      own.live = false
      for (const r of [own.read, own.test]) if (r) void call('connections:cancelCheck', c.id, model, r).catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const saveMine = async (tokens: number | null): Promise<void> => {
    try {
      await call('connections:setModelContext', c.id, model, tokens)
      if (tokens === null) setMine('')
    } catch (e) {
      setProblem(errorMessage(e))
    }
  }

  const ctx = last.context?.context
  const advice = adviceOf(c, ctx)
  const have = effectiveContext(ctx, mineSaved)
  const tools = last.tools
  const cli = providerDescriptor(c.provider).name
  const seenStop = tools && !tools.ok && tools.seen?.stopReason ? tools.seen.stopReason : 'none'
  const seenBlocks = tools && !tools.ok && tools.seen?.blocks?.length ? tools.seen.blocks.join(', ') : 'none'

  return (
    <>
      <h4 className="span2">
        {tr(D.context)}{' '}
        <button className="btn subtle small" data-read-again disabled={reading} onClick={() => void read()}>
          {tr(reading ? D.reading : D.readAgain)}
        </button>
      </h4>
      {ctx && <div className="span2 muted" data-server-kind={ctx.kind}>{ctx.prefixed ? tr(D.prefixed) : tr(D.kind, { kind: ctx.kind })}</div>}
      {ctx && !ctx.prefixed && (
        <div className="span2 server-diag-values">
          <ContextRow label={D.trained} v={ctx.trained} />
          <ContextRow label={D.configured} v={ctx.configured} />
          <ContextRow label={D.allocated} v={ctx.allocated} empty={ctx.kind === 'ollama' && ctx.loaded === false ? tr(D.notLoaded) : undefined} />
        </div>
      )}
      {ctx?.kind === 'ollama' && <div className="span2 hint">{tr(D.ollamaDefault)}</div>}
      {ctx?.kind === 'llamacpp' && <div className="span2 hint" data-template-tools={ctx.templateTools}>{tr(D.templateTools, { state: ctx.templateTools ?? 'notReported' })}</div>}

      <label htmlFor="diag-mine">{tr(D.mine)}</label>
      <div className="flex">
        <input id="diag-mine" className="input" inputMode="numeric" value={mine} data-context-mine onChange={(e) => setMine(e.target.value.replace(/[^\d]/g, ''))} />
        <button className="btn subtle small" data-save-context disabled={!mine || Number(mine) === mineSaved} onClick={() => void saveMine(Number(mine))}>{tr(D.save)}</button>
        {mineSaved !== undefined && <button className="btn subtle small" data-clear-context onClick={() => void saveMine(null)}>{tr(D.clear)}</button>}
      </div>
      <div className="span2 hint">{tr(D.mineHint)}</div>

      {advice && (
        <div className="span2" data-advice={have !== null && have < advice.size ? 'below' : have !== null ? 'meets' : 'unknown'}>
          {tr(D.advice, { name: advice.name, size: advice.size, cli })}{' '}
          {have !== null && (have < advice.size ? <span className="account-warning"><Icon name="warning" /> {tr(D.below, { tokens: have })}</span> : tr(D.meets, { tokens: have }))}
        </div>
      )}
      <div className="span2 hint">{tr(D.measured)}</div>

      <h4 className="span2">{tr(D.tools)}</h4>
      <div className="span2 hint">{tr(D.toolsWhat)}</div>
      <div className="span2 flex">
        <button className="btn small" data-test-tools disabled={testing} onClick={() => void test()}>{tr(testing ? D.testing : D.test)}</button>
      </div>
      {tools && (
        <div className="span2" data-tool-test={tools.ok ? 'passed' : tools.why}>
          {tools.ok ? (
            <span>
              <Icon name="check" /> {tr(D.passed, { ago: timeAgo(new Date(tools.at).toISOString()) })}
            </span>
          ) : (
            <>
              <div className="account-warning">
                <Icon name="warning" /> {tools.step ? tr(D.failedStep, { step: String(tools.step), why: tr(WHY[tools.why]) }) : tr(WHY[tools.why])}
              </div>
              {tools.seen && <div className="muted" data-seen>{tr(D.seen, { status: String(tools.seen.status), stop: seenStop, blocks: seenBlocks })}</div>}
            </>
          )}
        </div>
      )}
    </>
  )
}

/**
 * A server connection's one line, for the connection editor and Provider Setup: its first model's context as last read
 * in Server diagnostics (compared with the advice), and Check Server…, which opens them.
 */
export function ServerContextLine({ c }: { c: Account }) {
  const [open, setOpen] = useState(false)
  const [last, setLast] = useState<LastCheck>({})
  const model = c.server?.models[0]?.id
  useEffect(() => {
    if (!model || open) return
    let live = true
    void call('connections:lastCheck', c.id, model).then((l) => live && setLast(l), () => undefined)
    return () => {
      live = false
    }
  }, [c.id, model, open])
  if (!c.server || !model) return null
  const ctx = last.context?.context
  const have = effectiveContext(ctx, c.server.models[0]?.context)
  const advice = adviceOf(c, ctx)
  const ago = last.context ? timeAgo(new Date(last.context.at).toISOString()) : ''
  return (
    <div className="server-context-line muted flex" data-server-context-line={c.id}>
      {have !== null && ago && <span>{advice && have < advice.size ? tr(D.lineBelow, { tokens: have, ago, name: advice.name, size: advice.size }) : tr(D.line, { tokens: have, ago })}</span>}
      <button className="btn subtle small" data-check-server onClick={() => setOpen(true)}>{tr(D.open)}</button>
      {open && <ServerDiagnosticsDialog c={c} model={model} onClose={() => setOpen(false)} />}
    </div>
  )
}
