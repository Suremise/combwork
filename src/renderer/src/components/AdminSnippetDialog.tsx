import { useEffect, useState } from 'react'
import { call, errorMessage } from '../api'
import { notify, set, useStore } from '../store'
import { msg, tr } from '@shared/i18n'
import { MANAGED_POLICY_GUIDE, claudeManagedSnippetText, type ClaudeSnippetFacts } from '@shared/claudeHookHandlers'
import { openGuideAt } from '../tips'
import { LoadFailed, Modal } from './ui'

const M = {
  title: msg({ id: 'hooks.snippet.title', defaultMessage: 'Claude Code admin snippet', description: "Title of the dialog with the admin snippet: a block of Claude Code settings an organisation's administrator pastes into its managed settings so Combwork's hooks run where policy allows only managed hooks." }),
  what: msg({ id: 'hooks.snippet.what', defaultMessage: "Where an organisation's Claude Code policy allows only managed hooks (allowManagedHooksOnly), Combwork's own hooks don't run, and Combwork can't tell what its agents are doing. An administrator can paste this block into the organisation's managed settings once: it gives Claude Code Combwork's hooks for every session, every account and every project, and does nothing in sessions Combwork didn't start. It holds no password or token.", description: 'The admin snippet dialog: what the block is for. Keep allowManagedHooksOnly as it is (a setting name).' }),
  port: msg({ id: 'hooks.snippet.port', defaultMessage: "Its hooks name Combwork's Agent API port, {port}. If that port changes (Settings → Agent API), the administrator pastes a new snippet.", description: "The admin snippet dialog: the snippet names a network port ({port}, a number shown as it is). Settings → Agent API is where it's set, as Combwork shows it." }),
  notListening: msg({ id: 'hooks.snippet.notListening', defaultMessage: "Combwork's Agent API isn't listening on port {port} now (another program may be using it), so hooks sent there won't reach Combwork until it is.", description: 'The admin snippet dialog: a warning that the port the snippet names is not open now. {port} is a number shown as it is.' }),
  statusLine: msg({ id: 'hooks.snippet.statusLine', defaultMessage: "Include Combwork's status line (cost, plan limits, model). It replaces any status line the organisation's managed settings set, in every Claude Code session on the computer, and shows nothing.", description: "A checkbox in the admin snippet dialog: whether the snippet also sets Claude Code's status line, which Combwork reads cost and limits from." }),
  otherPort: msg({ id: 'hooks.snippet.otherPort', defaultMessage: "Also for {build, select, dev {a development build} other {the installed app}} of Combwork (port {port})", description: 'A checkbox in the admin snippet dialog: also add hooks for the other kind of Combwork (a development build, or the installed app) on its own port. {port} is a number shown as it is.' }),
  allowlists: msg({ id: 'hooks.snippet.allowlists', defaultMessage: 'If the managed settings set allowedHttpHookUrls, add {url} to it; if they set httpHookAllowedEnvVars, add CW_HOOK_TOKEN.', description: 'The admin snippet dialog: what else an administrator adds when their settings restrict hooks. Keep the setting names, {url} (a web address) and CW_HOOK_TOKEN as they are.' }),
  copy: msg({ id: 'hooks.snippet.copy', defaultMessage: 'Copy', description: 'Button in the admin snippet dialog: copies the snippet to the clipboard.' }),
  copied: msg({ id: 'hooks.snippet.copied', defaultMessage: 'Admin snippet copied', description: 'A notice after copying the admin snippet (a block of Claude Code settings for an administrator).' }),
  guide: msg({ id: 'hooks.snippet.guide', defaultMessage: 'Where it goes…', description: "Button in the admin snippet dialog: opens the user guide's section on where an administrator pastes it. The … says it opens something: keep it." }),
  close: msg({ id: 'hooks.snippet.close', defaultMessage: 'Close', description: 'Button closing the admin snippet dialog.' }),
  loadWhat: msg({ id: 'hooks.snippet.loadWhat', defaultMessage: 'the admin snippet', description: "What couldn't be loaded, in a 'couldn't load …' message of the admin snippet dialog." })
}

/** Claude Code's admin snippet (HI-2777), with this Combwork's port filled in, to copy for an organisation's administrator. */
export function AdminSnippetDialog() {
  const open = useStore((s) => s.adminSnippetOpen)
  const [facts, setFacts] = useState<ClaudeSnippetFacts | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [statusLine, setStatusLine] = useState(true)
  const [both, setBoth] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    setFacts(null)
    setError(null)
    if (!open) return
    let current = true
    void call('api:claudeSnippet').then(
      (f) => current && setFacts(f),
      (e) => current && setError(errorMessage(e))
    )
    return () => {
      current = false
    }
  }, [open, attempt])
  if (!open) return null
  const close = (): void => set({ adminSnippetOpen: false })
  const ports = facts ? [facts.port, ...(both && facts.otherPort ? [facts.otherPort] : [])] : []
  const text = facts ? claudeManagedSnippetText(ports, facts.timeouts, { statusLine }) : ''
  const copy = (): void => {
    void navigator.clipboard.writeText(text).then(() => notify('success', tr(M.copied)))
  }
  return (
    <Modal
      title={tr(M.title)}
      icon="plug"
      wide
      onClose={close}
      footer={
        <>
          <button
            className="btn subtle"
            onClick={() => {
              close()
              openGuideAt(MANAGED_POLICY_GUIDE)
            }}
          >
            {tr(M.guide)}
          </button>
          <button className="btn" disabled={!facts} onClick={copy}>
            {tr(M.copy)}
          </button>
          <button className="btn subtle" onClick={close}>
            {tr(M.close)}
          </button>
        </>
      }
    >
      <p className="muted">{tr(M.what)}</p>
      {error ? (
        <LoadFailed what={tr(M.loadWhat)} error={error} onRetry={() => setAttempt((n) => n + 1)} />
      ) : facts ? (
        <>
          <p className="muted">{tr(M.port, { port: String(facts.port) })}</p>
          {!facts.listening && <p className="warn-text">{tr(M.notListening, { port: String(facts.port) })}</p>}
          <label className="flex muted">
            <input type="checkbox" className="checkbox" checked={statusLine} onChange={(e) => setStatusLine(e.target.checked)} /> {tr(M.statusLine)}
          </label>
          {facts.otherPort && (
            <label className="flex muted">
              <input type="checkbox" className="checkbox" checked={both} onChange={(e) => setBoth(e.target.checked)} /> {tr(M.otherPort, { build: facts.packaged ? 'dev' : 'installed', port: String(facts.otherPort) })}
            </label>
          )}
          <textarea className="mono admin-snippet" readOnly rows={14} value={text} onFocus={(e) => e.currentTarget.select()} />
          <p className="muted">{tr(M.allowlists, { url: `http://127.0.0.1:${facts.port}/hook` })}</p>
        </>
      ) : null}
    </Modal>
  )
}
