import { msg, tr } from '@shared/i18n'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { call } from '../api'
import { saveAllDrafts, unsavedFiles } from './FileView'

/** The parts of the window an ErrorBoundary names when it fails; without one it says "This view". */
export type ErrorView = 'assistant' | 'progress' | 'tab' | 'devConsole' | 'hive'

interface Props {
  children: ReactNode
  /** What failed, for the message ("The Assistant ran into a problem…"): one sentence per view, so a language words each whole. */
  view?: ErrorView
  /** A new value (e.g. another project or tab) clears the error and tries again. */
  resetKey?: string
  /** The whole window failed: offer a reload instead of trying the view again. */
  root?: boolean
}

/**
 * Catches an error while rendering one view, so a bug there (e.g. an unexpected file in a preview)
 * shows a message in that view instead of blanking the whole window. Sessions keep running.
 */
export class ErrorBoundary extends Component<Props, { error: Error | null; key?: string; saveResult?: string }> {
  state: { error: Error | null; key?: string; saveResult?: string } = { error: null, key: this.props.resetKey }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  static getDerivedStateFromProps(props: Props, state: { error: Error | null; key?: string }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`${this.props.view ?? 'view'} failed`, error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="empty-state error-boundary" role="alert">
        <span className="codicon codicon-warning" />
        <strong>{this.props.view ? tr(msg({ id: 'shell.errorBoundary.named', defaultMessage: "{view, select, assistant {The Assistant ran into a problem and couldn't be shown.} progress {The Progress panel ran into a problem and couldn't be shown.} tab {This tab ran into a problem and couldn't be shown.} devConsole {The developer console ran into a problem and couldn't be shown.} other {Combwork ran into a problem and couldn't be shown.}}", description: "Where a part of the window failed to show. {view} picks which: the Combwork Assistant, the Progress panel, a project's tab, the developer console's window, or the whole window (other: Combwork)." }), { view: this.props.view }) : tr(msg({ id: 'shell.errorBoundary.view', defaultMessage: "This view ran into a problem and couldn't be shown.", description: 'Where a view of the window failed to show.' }))}</strong>
        <code className="error-boundary-message">{error.message || String(error)}</code>
        <span className="faint">{tr(msg({ id: 'shell.errorBoundary.sessions', defaultMessage: 'Running sessions are not affected.', description: 'Under a view that failed to show.' }))}</span>
        {this.state.saveResult && <span>{this.state.saveResult}</span>}
        <div className="flex" style={{ gap: 8, justifyContent: 'center' }}>
          {this.props.root ? (
            <>
              {unsavedFiles().length > 0 && (
                <button
                  className="btn"
                  onClick={() =>
                    void saveAllDrafts().then((r) => {
                      this.setState({ saveResult: r.failed.length ? tr(msg({ id: 'shell.errorBoundary.saveFailed', defaultMessage: "Couldn't save: {why}", description: 'After saving unsaved files from a failed window: what failed. {why} lists the reasons.' }), { why: r.failed.map((f) => f.message).join('; ') }) : tr(msg({ id: 'shell.errorBoundary.saved', defaultMessage: '{n, plural, one {Saved # file.} other {Saved # files.}}', description: 'After saving unsaved files from a failed window.' }), { n: r.saved }) })
                    })
                  }
                >
                  {tr(msg({ id: 'shell.errorBoundary.save', defaultMessage: '{n, plural, one {Save # Unsaved File} other {Save # Unsaved Files}}', description: 'Button under a failed window: saves the files with unsaved edits first.' }), { n: unsavedFiles().length })}
                </button>
              )}
              <button className="btn primary" onClick={() => location.reload()}>
                {tr(msg({ id: 'shell.errorBoundary.reload', defaultMessage: 'Reload Window', description: 'Button under a failed window: reloads it.' }))}
              </button>
            </>
          ) : (
            <button className="btn primary" onClick={() => this.setState({ error: null })}>
              {tr(msg({ id: 'shell.errorBoundary.tryAgain', defaultMessage: 'Try Again', description: 'Button under a view that failed: shows it again.' }))}
            </button>
          )}
          <button className="btn subtle" onClick={() => void call('app:openLogs')}>
            {tr(msg({ id: 'shell.errorBoundary.logs', defaultMessage: 'Open Logs', description: "Button under a view that failed: opens the folder of Combwork's log files." }))}
          </button>
        </div>
      </div>
    )
  }
}
