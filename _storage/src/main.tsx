import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './mobile.css'
import App from './App.tsx'
import ErrorBoundary from './ErrorBoundary'

// Desktop shell (hiddenInset titlebar) — flag the root element so CSS can reserve the
// macOS traffic-light band once, via --titlebar-clearance, instead of per-surface hacks.
if ((window as any).electronIPC) document.documentElement.classList.add('electron')

// ── The LAST line of defence (2026-08-04b) ─────────────────────────────────────
// The per-panel boundaries inside App contain a throw in a CHILD's render. They
// cannot contain a throw in App's OWN render — and props are built in the parent's
// frame, so plenty of real faults land there (a bad conversation record while
// composing a panel's props, a null deref in a handler-building expression). MEASURED:
// with only the inner boundaries in place, forcing a throw during prop construction
// still black-screened the entire app, which is the reported failure exactly.
//
// So the root gets one too. Anything that escapes every inner boundary now renders a
// readable notice with a working retry instead of an empty <div id="root"> that can
// only be fixed by reloading the page.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary label="Crucible">
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
