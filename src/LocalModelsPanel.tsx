import { useEffect, useState } from 'react'

interface ModelStatus {
  id: string
  label: string
  params: string
  approxSizeGB: number
  license: string
  tier: 'fast' | 'balanced' | 'quality'
  status: { status: 'absent' | 'downloading' | 'ready' | 'error'; bytesDone: number; bytesTotal: number; error?: string }
}

const TIER_COLOR: Record<ModelStatus['tier'], string> = {
  fast: '#4db89e',
  balanced: '#c9a24d',
  quality: '#c96b4d',
}

export default function LocalModelsPanel() {
  const [models, setModels] = useState<ModelStatus[]>([])
  const [busy, setBusy] = useState<Record<string, number>>({})

  const refresh = () => fetch('/api/local-models').then(r => r.json()).then(d => setModels(d.models ?? []))

  useEffect(() => { refresh() }, [])

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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', color: '#b8b8cc', textTransform: 'uppercase' }}>
          Local Models
        </span>
        <span style={{ fontSize: 11.5, lineHeight: 1.55, color: '#77778c' }}>
          Optional, free, open-weight models that run fully on this device. Nothing is downloaded until you ask.
          Crucible routes a query to the fastest downloaded model first and escalates to a stronger one only if the
          answer scores low.
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {models.map(m => (
          <div key={m.id} style={{
            display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 14,
            background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
          }}>
            <span style={{ width: 8, height: 8, borderRadius: 999, background: TIER_COLOR[m.tier], flexShrink: 0 }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: '#d8d8e8' }}>{m.label}</span>
              <span style={{ fontSize: 11, color: '#66667a' }}>
                {m.params} · ~{m.approxSizeGB.toFixed(1)} GB · {m.license}
              </span>
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
              <button
                onClick={() => remove(m.id)}
                style={{ fontSize: 11, fontWeight: 600, color: '#e0a5a5', background: 'transparent', border: '1px solid rgba(224,165,165,0.3)', borderRadius: 8, padding: '6px 10px', cursor: 'pointer' }}
              >
                Remove
              </button>
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
