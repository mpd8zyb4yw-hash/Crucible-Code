import { useState } from 'react'
import { useCrucibleStore } from '../../state/store'
import { draftAgent, type AgentDraft } from '../../CrucibleEngine/agent'

function tintOf(hex: string, alpha: number) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

const AGENTS = [
  { name: 'Vibe Code', glyph: '{ }', color: '#4db89e', desc: 'Describe the app; Crucible writes, lints, and self-reviews the code on-device.', chip1: 'ON-DEVICE', chip2: 'LINTER' },
  { name: 'Search Web', glyph: '◎', color: '#f59e0b', desc: 'Web-augmented answers with ranked, cited sources.', chip1: 'LIVE WEB', chip2: 'CITED' },
  { name: 'Deep Research', glyph: '≡', color: '#38bdf8', desc: 'Autonomous multi-step research runs with a structured, cited report.', chip1: 'AUTONOMOUS', chip2: 'REPORT' },
  { name: 'Smoke Test', glyph: '✓', color: '#c084fc', desc: 'Throws adversarial cases at your code or spec and reports what breaks.', chip1: 'ADVERSARIAL', chip2: 'CI-READY' },
  { name: 'Decide For Me', glyph: '⚖', color: '#7c7cf8', desc: 'Structured self-debate over your options with one ranked recommendation.', chip1: 'DEBATE', chip2: 'RANKED' },
  { name: 'Custom', glyph: '+', color: '#8a8a9e', desc: 'Start from a blank workflow — pick tools and stages yourself.', chip1: 'BLANK', chip2: 'YOURS' },
]

export default function AgentsView() {
  const runAgent = useCrucibleStore((s) => s.runAgent)
  const [desc, setDesc] = useState('')
  const [draft, setDraft] = useState<AgentDraft | null>(null)

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative', zIndex: 1, overflowY: 'auto' }}>
      <div style={{ width: '100%', maxWidth: 860, margin: '0 auto', padding: '36px 32px 48px', display: 'flex', flexDirection: 'column', gap: 26 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em', color: '#eef' }}>Agents</span>
          <span style={{ fontSize: 12.5, color: '#77778c' }}>Prebuilt workflows, or vibe-code your own. All run on-device by default.</span>
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            padding: '16px 16px 14px',
            borderRadius: 18,
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(124,124,248,0.2)',
            backdropFilter: 'blur(28px)',
            WebkitBackdropFilter: 'blur(28px)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'linear-gradient(135deg, #7c7cf8, #c084fc)',
                boxShadow: '0 0 8px rgba(150,120,250,0.7)',
              }}
            />
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: '#9d9dfa', textTransform: 'uppercase' }}>
              Vibe-code an agent
            </span>
          </div>
          <textarea
            rows={2}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="Describe what your agent should do — Crucible drafts its workflow, tools, and guardrails"
            style={{ background: 'none', border: 'none', color: '#e4e4ee', fontSize: 13, resize: 'none', outline: 'none', fontFamily: 'inherit', lineHeight: 1.6 }}
          />
          {draft && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', borderRadius: 12, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#d8d8e8' }}>{draft.name}</span>
              <ol style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 3 }}>
                {draft.steps.map((s, i) => (
                  <li key={i} style={{ fontSize: 11.5, color: '#8a8a9e' }}>
                    {s}
                  </li>
                ))}
              </ol>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  onClick={() => runAgent(draft.name, desc)}
                  style={{ padding: '6px 16px', borderRadius: 999, border: '1px solid rgba(77,184,158,0.35)', background: 'rgba(77,184,158,0.12)', color: '#4db89e', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}
                >
                  Run this
                </button>
              </div>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button
              onClick={() => desc.trim() && setDraft(draftAgent(desc))}
              style={{ padding: '6px 16px', borderRadius: 999, border: '1px solid rgba(124,124,248,0.35)', background: 'rgba(124,124,248,0.12)', color: '#b0b0ff', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}
            >
              Draft agent
            </button>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          {AGENTS.map((a) => (
            <div
              key={a.name}
              onClick={() => runAgent(a.name, a.desc)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                padding: 16,
                borderRadius: 16,
                background: `linear-gradient(150deg, ${a.name === 'Custom' ? 'rgba(255,255,255,0.045)' : tintOf(a.color, 0.09)} 0%, rgba(255,255,255,0.02) 60%)`,
                border: '1px solid rgba(255,255,255,0.07)',
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
                cursor: 'pointer',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 9,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: tintOf(a.color, 0.13),
                    color: a.color,
                    fontSize: 13,
                    fontWeight: 700,
                  }}
                >
                  {a.glyph}
                </span>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#e8e8f4', flex: 1 }}>{a.name}</span>
              </div>
              <span style={{ fontSize: 11.5, lineHeight: 1.55, color: '#8a8a9e' }}>{a.desc}</span>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 'auto' }}>
                <span style={chipStyle}>{a.chip1}</span>
                <span style={chipStyle}>{a.chip2}</span>
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 10, fontWeight: 700, color: a.color }}>Run ▸</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const chipStyle: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 600,
  letterSpacing: '0.05em',
  padding: '2px 7px',
  borderRadius: 999,
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.07)',
  color: '#77778c',
}
