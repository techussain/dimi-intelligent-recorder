import { Component, type ErrorInfo, type ReactNode } from 'react'
import { logToFile } from '../lib/errorBus'

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info)
    logToFile(
      `UI crashed: ${error.message}`,
      `${error.stack ?? ''}
${info.componentStack ?? ''}`,
    )
  }

  private reset = (): void => {
    this.setState({ error: null })
  }

  private reload = (): void => {
    window.location.reload()
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-bg p-6">
        <div className="max-w-xl w-full bg-elevated border border-danger/40 rounded-xl shadow-pop p-6 space-y-4">
          <div>
            <h1 className="text-base font-semibold text-danger">
              Something went wrong
            </h1>
            <p className="text-xs text-muted mt-1">
              The editor crashed. Your autosave should still be intact.
            </p>
          </div>
          <pre className="text-[11px] font-mono bg-surface2 border border-bd rounded-md p-3 max-h-48 overflow-auto whitespace-pre-wrap text-fg/80">
            {error.message}
            {error.stack ? '\n\n' + error.stack : ''}
          </pre>
          <div className="flex items-center justify-end gap-2">
            <button className="btn-ghost" onClick={this.reset}>
              Try again
            </button>
            <button className="btn-primary" onClick={this.reload}>
              Reload
            </button>
          </div>
        </div>
      </div>
    )
  }
}
