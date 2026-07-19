// ── chat/CodeRunner — run & preview code blocks right inside the chat ──────────
// Two affordances on every code block, both novice-friendly with hover explanations:
//   · Preview — web code (HTML, or browser-flavored JS) opens in a sandboxed iframe
//     overlay, fully interactive (games are playable: the iframe gets keyboard focus).
//   · Run — interpreted code (js/ts/python/bash) executes on-device in the same
//     network-denied sandbox the verifier uses; compiled languages get a real
//     compile/syntax check. Output appears in a pane under the block.
import { useState } from 'react'
import { API_BASE, apiFetch } from '../api'

const RUN_LANGS = new Set(['javascript', 'js', 'typescript', 'ts', 'python', 'py', 'bash', 'sh', 'shell', 'zsh'])
const CHECK_LANGS = new Set(['rust', 'go', 'java', 'swift', 'c', 'cpp', 'c++', 'json', 'yaml', 'sql', 'css'])

export function codeCaps(language: string, code: string): { run: boolean; check: boolean; preview: boolean } {
  const lang = (language || '').toLowerCase()
  const preview =
    lang === 'html' || lang === 'xml' && /<html|<body|<canvas|<svg/i.test(code) ||
    ((lang === 'javascript' || lang === 'js' || lang === '') &&
      /document\.|window\.|canvas|addEventListener|requestAnimationFrame/i.test(code))
  return {
    run: RUN_LANGS.has(lang),
    check: CHECK_LANGS.has(lang),
    preview,
  }
}

// Wrap bare browser-JS in a dark shell with a centered canvas so games/animations
// "just work" without the model having to emit boilerplate.
function buildPreviewDoc(language: string, code: string): string {
  const lang = (language || '').toLowerCase()
  if (lang === 'html' || /<html|<!doctype/i.test(code)) return code
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:#101016;color:#e4e4ee;font-family:-apple-system,sans-serif;
      display:flex;align-items:center;justify-content:center;overflow:hidden}
    canvas{background:#0a0a0e;border-radius:12px;box-shadow:0 12px 48px rgba(0,0,0,0.5)}
  </style></head><body><canvas id="canvas" width="640" height="480"></canvas>
  <script>
    // Convenience globals many generated snippets assume.
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    window.addEventListener('load', () => canvas.focus());
  </scr` + `ipt><script>${code}</scr` + `ipt></body></html>`
}

const btnStyle = (color: string): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', gap: 4,
  fontSize: 10, fontWeight: 700, letterSpacing: '0.05em',
  padding: '3px 9px', borderRadius: 6, cursor: 'pointer',
  background: `${color}22`, border: `1px solid ${color}55`, color,
  fontFamily: 'inherit', transition: 'background 0.15s',
  flexShrink: 0,
})

export function CodeRunBar({ language, code }: { language: string; code: string }) {
  const caps = codeCaps(language, code)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<null | { success: boolean; output: string; error: string | null; staticOnly: boolean; ms: number }>(null)
  const [preview, setPreview] = useState(false)

  if (!caps.run && !caps.check && !caps.preview) return null

  const run = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (running) return
    setRunning(true); setResult(null)
    apiFetch(`${API_BASE}/api/sandbox/exec-snippet`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, language }),
    })
      .then(r => r.json())
      .then(d => setResult({ success: !!d.success, output: d.output ?? '', error: d.error ?? null, staticOnly: !!d.staticOnly, ms: d.ms ?? 0 }))
      .catch(err => setResult({ success: false, output: '', error: String(err?.message ?? err), staticOnly: false, ms: 0 }))
      .finally(() => setRunning(false))
  }

  return (
    <>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px',
        background: 'rgba(0,0,0,0.3)', borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}>
        {caps.preview && (
          <button
            onClick={e => { e.stopPropagation(); setPreview(true) }}
            title="Open a live, interactive preview of this code — it runs in a safe sandbox inside Crucible, so games and animations are playable right here."
            style={btnStyle('#4db89e')}
          >▶ Preview</button>
        )}
        {(caps.run || caps.check) && (
          <button
            onClick={run}
            disabled={running}
            title={caps.run
              ? 'Run this code on your Mac in a safe sandbox (no network access) and show the output below.'
              : 'Check this code compiles/parses correctly — compiled languages are verified rather than executed.'}
            style={{ ...btnStyle('#7c7cf8'), opacity: running ? 0.5 : 1 }}
          >{running ? '⋯ running' : caps.run ? '⌁ Run' : '✓ Check'}</button>
        )}
        <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.22)', marginLeft: 'auto' }}>
          sandboxed · on-device
        </span>
      </div>

      {result && (
        <div style={{ background: 'rgba(0,0,0,0.45)', borderBottom: '1px solid rgba(255,255,255,0.06)', padding: '8px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: result.output || result.error ? 6 : 0 }}>
            <span style={{
              fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', padding: '2px 7px', borderRadius: 4,
              background: result.success ? 'rgba(77,184,158,0.14)' : 'rgba(248,113,113,0.12)',
              border: `1px solid ${result.success ? 'rgba(77,184,158,0.4)' : 'rgba(248,113,113,0.35)'}`,
              color: result.success ? '#4db89e' : '#f87171',
            }}>{result.success ? (result.staticOnly ? 'VERIFIED (STATIC)' : 'RAN CLEAN') : 'FAILED'}</span>
            <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.25)' }}>{result.ms}ms</span>
            <button onClick={e => { e.stopPropagation(); setResult(null) }} title="Hide output"
              style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.3)', fontSize: 10, padding: 0 }}>✕</button>
          </div>
          {(result.output || result.error) && (
            <pre style={{
              margin: 0, fontSize: 10.5, lineHeight: 1.55, color: result.success ? '#9fef9f' : '#fca5a5',
              fontFamily: 'var(--mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              maxHeight: 180, overflowY: 'auto',
            }}>{result.output}{result.error ? `\n${result.error}` : ''}</pre>
          )}
        </div>
      )}

      {preview && <PreviewOverlay doc={buildPreviewDoc(language, code)} onClose={() => setPreview(false)} />}
    </>
  )
}

// Fullscreen sandboxed-iframe preview — shared by inline code blocks (CodeRunBar) and
// agent-written file artifacts (ArtifactPreviewBar).
export function PreviewOverlay({ doc, onClose }: { doc: string; onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(5,5,10,0.82)',
        backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        animation: 'fadeIn 0.2s ease',
        // Keep the preview card clear of the macOS traffic lights in the desktop shell.
        padding: 'calc(24px + var(--titlebar-clearance)) 24px 24px',
      }}
    >
      <div onClick={e => e.stopPropagation()} style={{
        width: 'min(920px, 94vw)', height: 'min(680px, 88vh)',
        display: 'flex', flexDirection: 'column', borderRadius: 'var(--c-radius-lg)',
        overflow: 'hidden', border: '1px solid var(--c-hairline-strong)',
        background: '#101016', boxShadow: '0 32px 120px rgba(0,0,0,0.6)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px',
          borderBottom: '1px solid var(--c-hairline)', flexShrink: 0,
        }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#4db89e' }} />
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--c-dim)' }}>
            LIVE PREVIEW · SANDBOXED
          </span>
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.22)' }}>
            click inside to give it keyboard control
          </span>
          <button
            onClick={onClose}
            title="Close preview"
            style={{
              marginLeft: 'auto', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--c-hairline)',
              borderRadius: 7, color: '#9797ab', cursor: 'pointer', width: 26, height: 26,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >✕</button>
        </div>
        <iframe
          title="crucible-code-preview"
          sandbox="allow-scripts allow-pointer-lock"
          srcDoc={doc}
          style={{ flex: 1, border: 'none', background: '#101016', width: '100%' }}
        />
      </div>
    </div>
  )
}

const PREVIEWABLE_FILE = /\.html?$/i

/** Deduped list of agent-written files that the in-chat sandbox can render. */
export function previewableArtifacts(paths: string[]): string[] {
  return [...new Set(paths)].filter(p => PREVIEWABLE_FILE.test(p))
}

// Run bar for files the agent wrote to disk (write_file), where the final reply has no
// code fence to hang a CodeRunBar on. Diff events truncate content, so the full file is
// re-fetched from the backend at click time.
export function ArtifactPreviewBar({ paths }: { paths: string[] }) {
  const files = previewableArtifacts(paths)
  const [doc, setDoc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState<string | null>(null)

  if (files.length === 0) return null

  const open = (filePath: string) => {
    if (loading) return
    setLoading(filePath); setError(null)
    apiFetch(`${API_BASE}/api/file/read`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.success && typeof d.content === 'string') setDoc(buildPreviewDoc('html', d.content))
        else setError(d.error || 'Could not read file')
      })
      .catch(err => setError(String(err?.message ?? err)))
      .finally(() => setLoading(null))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {files.map(p => (
        <div key={p} style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
          background: 'rgba(0,0,0,0.35)', borderRadius: 8,
          border: '1px solid rgba(77,184,158,0.25)',
        }}>
          <span style={{ fontSize: 11, color: '#ccc', fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
            {p.split('/').pop()}
          </span>
          <button
            onClick={() => open(p)}
            title="Open a live, interactive preview of this file — it runs in a safe sandbox inside Crucible, so games and animations are playable right here."
            style={{ ...btnStyle('#4db89e'), marginLeft: 'auto', opacity: loading === p ? 0.5 : 1 }}
          >{loading === p ? '⋯ loading' : '▶ Preview'}</button>
        </div>
      ))}
      {error && <div style={{ fontSize: 10.5, color: '#fca5a5' }}>{error}</div>}
      {doc && <PreviewOverlay doc={doc} onClose={() => setDoc(null)} />}
    </div>
  )
}
