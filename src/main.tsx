import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './mobile.css'
import App from './App.tsx'

// Desktop shell (hiddenInset titlebar) — flag the root element so CSS can reserve the
// macOS traffic-light band once, via --titlebar-clearance, instead of per-surface hacks.
if ((window as any).electronIPC) document.documentElement.classList.add('electron')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
