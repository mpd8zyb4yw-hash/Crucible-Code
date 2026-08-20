import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { BUILD } from '../server/build'
import { diagnostics } from './surface/store'
import { Boundary, crashes } from './Boundary'

/**
 * Build identity, reachable from a phone with no tooling: `window.__cruBuild`.
 *
 * Stamped into the bundle at build time, so it is the identity of THIS
 * JavaScript, not of whatever the server happens to be running. Comparing it
 * against `/api/version` is what distinguishes "the deploy did not land" from
 * "the deploy landed and the behaviour is still wrong" — a distinction that
 * cost a whole session of debugging the wrong thing.
 */
;(window as unknown as { __cruBuild: unknown }).__cruBuild = BUILD

/**
 * `__cruDiag()` — what is mounted RIGHT NOW, with the build that drew it.
 *
 * The question this answers is "is the rich renderer actually mounted", which
 * is not the same question as "does the rich renderer exist", and the two were
 * being confused in both directions: a renderer that existed and never mounted,
 * and a watch mentioning Maps being read as a Maps surface.
 */
;(window as unknown as { __cruDiag: unknown }).__cruDiag = () => ({
  build: BUILD,
  surfaces: diagnostics(),
})

/** Crash history survives the relaunch that used to be the only recovery. */
;(window as unknown as { __cruCrashes: unknown }).__cruCrashes = crashes

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/*
      Last-resort boundary. Everything below can fail; this is what stops a
      failure from becoming a white document that only an app kill recovers.
    */}
    <Boundary scope="Crucible" level="app">
      <App />
    </Boundary>
  </StrictMode>
)
