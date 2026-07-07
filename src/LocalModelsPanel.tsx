import { useEffect, useState } from 'react'

interface ModelStatus {
  id: string
  label: string
  params: string
  approxSizeGB: number
  license: string
  tier: 'fast' | 'balanced' | 'quality'
  strengthNote: string
  enabled: boolean
  status: { status: 'absent' | 'downloading' | 'ready' | 'error'; bytesDone: number; bytesTotal: number; error?: string }
}

const TIER_COLOR: Record<ModelStatus['tier'], string> = {
  fast: '#4db89e',
  balanced: '#c9a24d',
  quality: '#c96b4d',
}

/** Family inferred from the model id, used to pick a badge glyph. */
function modelFamily(id: string): 'smollm' | 'qwen' | 'gemma' | 'phi' {
  if (id.startsWith('smollm')) return 'smollm'
  if (id.startsWith('qwen')) return 'qwen'
  if (id.startsWith('gemma')) return 'gemma'
  return 'phi'
}

/**
 * Small abstract monogram badges, one per model family — not the vendors' real
 * trademarked logos (no image assets in this codebase per the no-stock-images rule),
 * just a distinct geometric mark per family so rows are scannable at a glance.
 */
function ModelBadge({ id, tier }: { id: string; tier: ModelStatus['tier'] }) {
  const color = TIER_COLOR[tier]
  const family = modelFamily(id)
  const common = { width: 20, height: 20, viewBox: '0 0 20 20', style: { flexShrink: 0 } }
  switch (family) {
    case 'smollm':
      return (
        <svg {...common}>
          <circle cx={10} cy={10} r={7} fill="none" stroke={color} strokeWidth={1.6} />
          <circle cx={10} cy={10} r={2} fill={color} />
        </svg>
      )
    case 'qwen':
      return (
        <svg {...common}>
          <path d="M10 3 L16.5 10 L10 17 L3.5 10 Z" fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" />
        </svg>
      )
    case 'gemma':
      return (
        <svg {...common}>
          <path d="M10 3.5 C13.5 3.5 16.5 6.5 16.5 10 C13 10 10 13 10 16.5 C6.5 16.5 3.5 13.5 3.5 10 C7 10 10 7 10 3.5 Z" fill={color} opacity={0.85} />
        </svg>
      )
    case 'phi':
    default:
      return (
        <svg {...common}>
          <ellipse cx={10} cy={10} rx={4.5} ry={7} fill="none" stroke={color} strokeWidth={1.6} />
          <line x1={3.5} y1={10} x2={16.5} y2={10} stroke={color} strokeWidth={1.6} />
        </svg>
      )
  }
}

export default function LocalModelsPanel() {
  const [models, setModels] = useState<ModelStatus[]>([])
  const [busy, setBusy] = useState<Record<string, number>>({})
  const [location, setLocation] = useState<string | undefined>()

  const refresh = () => fetch('/api/local-models').then(r => r.json()).then(d => setModels(d.models ?? []))
  const refreshConfig = () => fetch('/api/local-models/config').then(r => r.json()).then(c => setLocation(c.location))

  useEffect(() => { refresh(); refreshConfig() }, [])

  const download = (id: string) => {
    fetch(`/api/local-models/${id}/download`, { method: 'POST' }).then(async res => {
      const reader = res.body?.getReader()
      if (!reader) return refresh()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const state = JSON.parse(line.slice(6))
          if (state.bytesTotal) setBusy(b => ({ ...b, [id]: Math.round((state.bytesDone / state.bytesTotal) * 100) }))
        }
      }
      setBusy(b => { const { [id]: _drop, ...rest } = b; return rest })
      refresh()
    })
  }

  const remove = (id: string) => fetch(`/api/local-models/${id}`, { method: 'DELETE' }).then(refresh)

  const toggle = (id: string, enabled: boolean) =>
    fetch(`/api/local-models/${id}/toggle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
    }).then(refresh)

  const changeLocation = async () => {
    const picked = await window.electronIPC?.invoke('pick-local-models-folder')
    if (!picked) return
    await fetch('/api/local-models/location', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: picked }),
    })
    refreshConfig()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', color: '#b8b8cc', textTransform: 'uppercase' }}>
          Local Models
        </span>
        <span style={{ fontSize: 11.5, lineHeight: 1.55, color: '#77778c' }}>
          Optional, free, open-weight models that run fully on this device — nothing downloads until you ask.
          Crucible routes each query to the model best suited to it, and runs others in parallel to corroborate
          when a query is ambiguous or high-stakes. A tray menu toggle exists for each model too.
        </span>
      </div>

      {window.electronIPC && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 12, background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <span style={{ fontSize: 11, color: '#8a8a9e', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            Storage: {location || 'Crucible app data (default)'}
          </span>
          <button
            onClick={changeLocation}
            style={{ fontSize: 10.5, fontWeight: 600, color: '#d8d8e8', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '5px 9px', cursor: 'pointer', whiteSpace: 'nowrap' }}
          >
            Change…
          </button>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {models.map(m => (
          <div key={m.id} style={{
            display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 14,
            background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
          }}>
            <ModelBadge id={m.id} tier={m.tier} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: '#d8d8e8' }}>{m.label}</span>
              <span style={{ fontSize: 11, color: '#66667a' }}>
                {m.params} · ~{m.approxSizeGB.toFixed(1)} GB · {m.license}
              </span>
              <span style={{ fontSize: 10.5, color: '#5c5c72', fontStyle: 'italic' }}>{m.strengthNote}</span>
              {m.id in busy && (
                <div style={{ height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.08)', marginTop: 4, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${busy[m.id]}%`, background: TIER_COLOR[m.tier], transition: 'width 0.2s ease' }} />
                </div>
              )}
              {m.status.status === 'error' && (
                <span style={{ fontSize: 10.5, color: '#e07a7a' }}>{m.status.error}</span>
              )}
            </div>
            {m.status.status === 'ready' ? (
              <>
                <button
                  onClick={() => toggle(m.id, !m.enabled)}
                  title={m.enabled ? 'Disable — excluded from routing' : 'Enable — included in routing'}
                  style={{
                    width: 34, height: 20, borderRadius: 999, border: '1px solid rgba(255,255,255,0.12)', cursor: 'pointer',
                    background: m.enabled ? 'rgba(77,184,158,0.35)' : 'rgba(255,255,255,0.06)', position: 'relative', flexShrink: 0,
                  }}
                >
                  <span style={{
                    position: 'absolute', top: 1, left: m.enabled ? 15 : 1, width: 16, height: 16, borderRadius: 999,
                    background: m.enabled ? '#4db89e' : '#8a8a9e', transition: 'left 0.15s ease',
                  }} />
                </button>
                <button
                  onClick={() => remove(m.id)}
                  style={{ fontSize: 11, fontWeight: 600, color: '#e0a5a5', background: 'transparent', border: '1px solid rgba(224,165,165,0.3)', borderRadius: 8, padding: '6px 10px', cursor: 'pointer' }}
                >
                  Remove
                </button>
              </>
            ) : (
              <button
                onClick={() => download(m.id)}
                disabled={m.id in busy}
                style={{ fontSize: 11, fontWeight: 600, color: '#d8d8e8', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '6px 10px', cursor: m.id in busy ? 'default' : 'pointer', opacity: m.id in busy ? 0.6 : 1 }}
              >
                {m.id in busy ? `${busy[m.id]}%` : 'Download'}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
