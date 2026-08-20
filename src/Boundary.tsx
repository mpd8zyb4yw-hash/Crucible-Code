import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Crash containment.
 *
 * The app had NO error boundaries. In React, that is not a gap in polish — it
 * is a guarantee that any throw anywhere during render unmounts the entire
 * tree and leaves a white document. That is exactly what was observed: a
 * malformed model response reached the renderer, something threw, and the only
 * recovery was killing the app and relaunching it.
 *
 * Model output, planner output, tool output and connector output are ALL
 * untrusted inputs to the UI. They are validated upstream, but validation is a
 * thing that can have a bug in it, and the renderer must survive the day it
 * does. So containment is structural rather than a promise:
 *
 *   app       — last resort. The header and a recover control survive.
 *   surface   — one application. A throw in Maps must not blank Calendar.
 *   component — one rich widget inside a surface, where a partial surface is
 *               genuinely more useful than none.
 *
 * The nearest boundary wins, so a failure is contained at the smallest scope
 * that can still show something true.
 */

/** Crash context outlives the reload, because the screen that showed it is gone. */
const CRASH_LOG = 'cru.crash'

export type CrashRecord = {
  at: string
  scope: string
  level: Level
  message: string
  stack?: string
  componentStack?: string
  build?: unknown
}

export function recordCrash(rec: CrashRecord) {
  try {
    const prior: CrashRecord[] = JSON.parse(localStorage.getItem(CRASH_LOG) ?? '[]')
    // Newest first, bounded — a crash loop must not fill storage and become a
    // second, worse failure.
    localStorage.setItem(CRASH_LOG, JSON.stringify([rec, ...prior].slice(0, 20)))
  } catch {
    // Storage full, disabled, or itself corrupt. Losing the log is acceptable;
    // throwing from the crash handler is not.
  }
}

export function crashes(): CrashRecord[] {
  try {
    const v = JSON.parse(localStorage.getItem(CRASH_LOG) ?? '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export function clearCrashes() {
  try { localStorage.removeItem(CRASH_LOG) } catch { /* nothing useful to do */ }
}

type Level = 'app' | 'surface' | 'component'

type Props = {
  /** What failed, in his terms — "Calendar", "Maps", not a component name. */
  scope: string
  level?: Level
  children: ReactNode
  /**
   * What to show instead. Receives a retry that remounts the subtree, so a
   * transient failure (a bad model op that has since been replaced) recovers
   * without reloading the app.
   */
  fallback?: (e: { error: Error; retry: () => void; scope: string }) => ReactNode
}

type State = { error: Error | null }

export class Boundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    recordCrash({
      at: new Date().toISOString(),
      scope: this.props.scope,
      level: this.props.level ?? 'component',
      message: String(error?.message ?? error),
      stack: error?.stack,
      componentStack: info?.componentStack ?? undefined,
      build: (window as unknown as { __cruBuild?: unknown }).__cruBuild,
    })
  }

  retry = () => this.setState({ error: null })

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const { scope, level = 'component', fallback } = this.props
    if (fallback) return fallback({ error, retry: this.retry, scope })
    return <Failed scope={scope} level={level} error={error} retry={this.retry} />
  }
}

/**
 * The bounded error state.
 *
 * It says which part failed and why, and offers the smallest recovery that
 * could work. It is deliberately NOT a blank area: an empty region is
 * indistinguishable from "nothing here", and that ambiguity is what made the
 * original crash so hard to characterise.
 */
function Failed({ scope, level, error, retry }: { scope: string; level: Level; error: Error; retry: () => void }) {
  const app = level === 'app'
  return (
    <div
      role="alert"
      style={{
        padding: app ? '24px 20px' : '14px 16px',
        margin: app ? 0 : '8px 0',
        borderRadius: app ? 0 : 14,
        border: '1px solid rgba(255,255,255,.10)',
        background: 'rgba(255,255,255,.03)',
        color: 'rgba(255,255,255,.70)',
        font: '13px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif',
      }}
    >
      <div style={{ color: 'rgba(255,255,255,.92)', fontWeight: 560, marginBottom: 4 }}>
        {app ? 'Crucible hit a problem' : `${scope} could not be drawn`}
      </div>
      <div style={{ marginBottom: 10 }}>
        {app
          ? 'The rest of the app was kept. You can retry without relaunching.'
          : 'Everything else on this screen is unaffected.'}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button onClick={retry} style={btn}>Retry</button>
        {app && <button onClick={() => location.reload()} style={btn}>Reload</button>}
      </div>
      <details style={{ marginTop: 10 }}>
        <summary style={{ cursor: 'pointer', opacity: .6 }}>Diagnostic</summary>
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: .6, marginTop: 6, fontSize: 11 }}>
          {scope} · {level}{'\n'}{String(error?.message ?? error)}
        </pre>
      </details>
    </div>
  )
}

const btn: React.CSSProperties = {
  appearance: 'none',
  border: '1px solid rgba(255,255,255,.14)',
  background: 'rgba(255,255,255,.06)',
  color: 'rgba(255,255,255,.92)',
  borderRadius: 999,
  padding: '6px 14px',
  font: 'inherit',
  cursor: 'pointer',
}
