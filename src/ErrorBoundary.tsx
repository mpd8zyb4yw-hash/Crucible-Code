// ── Error boundary ─────────────────────────────────────────────────────────────
// WHY THIS EXISTS (2026-08-04): the app had NO error boundary anywhere. React's
// documented behaviour when a render throws and nothing catches it is to unmount the
// WHOLE tree — which is exactly the reported failure: opening Settings black-screened
// the app and only a page refresh brought it back. One bad field in one panel took
// down every other surface, including the chat the user was in the middle of.
//
// The fix is structural, not a patch on whichever component happened to throw: a
// boundary around each independently-renderable region means a failure is CONTAINED
// and REPORTED in place, and everything around it keeps working. A card that cannot
// render shows a quiet inline notice; the rest of the board is untouched.
//
// It is deliberately not decorative. A crash is information: it shows what failed and
// offers a retry that re-mounts just that subtree (`key` bump), so recovering never
// requires reloading the page and losing conversation state.

import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Shown in the notice so the user knows WHICH surface failed ("Settings", "Inbox"). */
  label?: string
  /** Renders instead of the default notice — for regions too small for prose. */
  fallback?: (retry: () => void, error: Error) => ReactNode
}
interface State { error: Error | null; attempt: number }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, attempt: 0 }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The console is the only place a developer can see this after the fact, and the
    // component stack is the part that actually locates the fault.
    console.error(`[crucible] ${this.props.label ?? 'A surface'} failed to render:`, error, info.componentStack)
  }

  private retry = () => this.setState(s => ({ error: null, attempt: s.attempt + 1 }))

  render() {
    const { error, attempt } = this.state
    if (!error) {
      // The key is what makes retry a real remount rather than a no-op re-render:
      // without it React reuses the same (still-broken) instances.
      return <div key={attempt} style={{ display: 'contents' }}>{this.props.children}</div>
    }
    if (this.props.fallback) return this.props.fallback(this.retry, error)
    return (
      <div
        role="alert"
        style={{
          display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start',
          padding: '16px 18px', borderRadius: 'var(--radius-card)',
          background: 'var(--glass-fill)', border: '1px solid var(--glass-edge)',
          backdropFilter: 'var(--glass-blur)', WebkitBackdropFilter: 'var(--glass-blur)',
          minWidth: 0, overflow: 'hidden',
        }}
      >
        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--glass-text)' }}>
          {this.props.label ? `${this.props.label} could not be displayed` : 'This part could not be displayed'}
        </div>
        <div style={{
          fontSize: 12, lineHeight: 1.55, color: 'var(--glass-text-2)',
          overflowWrap: 'anywhere', maxWidth: '100%',
        }}>
          {error.message || String(error)}
        </div>
        <button
          onClick={this.retry}
          style={{
            padding: '6px 14px', borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit',
            fontSize: 12, fontWeight: 600, color: 'var(--glass-text)',
            background: 'var(--glass-fill-plate)', border: '1px solid var(--glass-edge)',
          }}
        >Try again</button>
      </div>
    )
  }
}
