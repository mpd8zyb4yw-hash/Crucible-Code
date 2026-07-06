// Full-page Agents tab (Crucible v3 left-rail design). Prebuilt workflow cards (ported
// from the reference AgentsView.tsx) route into the real chat/agent-loop path via `onBuild`
// (same send() the topbar LibraryBinder's tool-build box already uses) — no separate mock
// engine. Below, the real skill/tool catalog (GET /api/library/skills + /tools) is browsable,
// same data LibraryBinder's drawer shows, just as a full page instead of a drawer.

import { useEffect, useState } from 'react'
import { apiFetch, API_BASE } from './api'

interface SkillEntry { id: string; summary: string; defaultPath: string }
interface BuiltinTool { name: string; description: string; mutates: boolean }
interface DynamicTool { name: string; description: string; useCount: number; successCount: number; tier: string }

function tintOf(hex: string, alpha: number) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

const AGENTS = [
  { name: 'Vibe Code', glyph: '{ }', color: '#4db89e', chip1: 'ON-DEVICE', chip2: 'LINTER',
    desc: 'Describe the app; Crucible writes, lints, and self-reviews the code on-device.',
    prompt: (d: string) => `Create a new reusable agent tool: ${d}\n\nUse the create_tool mechanism so it persists for future sessions. Pick a clear snake_case name, write a focused description, and smoke-test it before confirming it works.` },
  { name: 'Search Web', glyph: '◎', color: '#f59e0b', chip1: 'LIVE WEB', chip2: 'CITED',
    desc: 'Web-augmented answers with ranked, cited sources.',
    prompt: (d: string) => `Search the web and answer with cited sources: ${d}` },
  { name: 'Deep Research', glyph: '≡', color: '#38bdf8', chip1: 'AUTONOMOUS', chip2: 'REPORT',
    desc: 'Autonomous multi-step research runs with a structured, cited report.',
    prompt: (d: string) => `Do a deep, multi-step research pass and produce a structured cited report on: ${d}` },
  { name: 'Smoke Test', glyph: '✓', color: '#c084fc', chip1: 'ADVERSARIAL', chip2: 'CI-READY',
    desc: 'Throws adversarial cases at your code or spec and reports what breaks.',
    prompt: (d: string) => `Throw adversarial test cases at this and report exactly what breaks: ${d}` },
  { name: 'Decide For Me', glyph: '⚖', color: '#7c7cf8', chip1: 'DEBATE', chip2: 'RANKED',
    desc: 'Structured self-debate over your options with one ranked recommendation.',
    prompt: (d: string) => `Structure a self-debate over these options and give one ranked recommendation: ${d}` },
]

const chipStyle: React.CSSProperties = {
  fontSize: 9, fontWeight: 600, letterSpacing: '0.05em', padding: '2px 7px', borderRadius: 999,
  background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.07)', color: '#77778c',
}

export default function AgentsTabView({ onBuild }: { onBuild: (text: string) => void }) {
  const [descs, setDescs] = useState<Record<string, string>>({})
  const [skills, setSkills] = useState<SkillEntry[]>([])
  const [builtin, setBuiltin] = useState<BuiltinTool[]>([])
  const [dynamic, setDynamic] = useState<DynamicTool[]>([])
  const [q, setQ] = useState('')

  useEffect(() => {
    Promise.all([
      apiFetch(`${API_BASE}/api/library/skills`, { credentials: 'include' }).then(r => r.json()),
      apiFetch(`${API_BASE}/api/library/tools`, { credentials: 'include' }).then(r => r.json()),
    ]).then(([s, t]) => {
      setSkills(s.skills ?? [])
      setBuiltin(t.builtin ?? [])
      setDynamic(t.dynamic ?? [])
    }).catch(() => {})
  }, [])

  const query = q.trim().toLowerCase()
  const fSkills = query ? skills.filter(s => s.id.toLowerCase().includes(query) || s.summary.toLowerCase().includes(query)) : skills.slice(0, 30)
  const fBuiltin = query ? builtin.filter(t => t.name.toLowerCase().includes(query) || t.description.toLowerCase().includes(query)) : builtin
  const fDynamic = query ? dynamic.filter(t => t.name.toLowerCase().includes(query)) : dynamic

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative', zIndex: 1, overflowY: 'auto' }}>
      <div style={{ width: '100%', maxWidth: 860, margin: '0 auto', padding: '36px 32px 48px', display: 'flex', flexDirection: 'column', gap: 26 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em', color: '#eef' }}>Agents</span>
          <span style={{ fontSize: 12.5, color: '#77778c' }}>Prebuilt workflows, or vibe-code your own. All run on-device by default.</span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 12 }}>
          {AGENTS.map(a => (
            <div key={a.name} style={{
              display: 'flex', flexDirection: 'column', gap: 10, padding: 16, borderRadius: 16,
              background: `linear-gradient(150deg, ${tintOf(a.color, 0.09)} 0%, rgba(255,255,255,0.02) 60%)`,
              border: '1px solid rgba(255,255,255,0.07)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  width: 28, height: 28, borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: tintOf(a.color, 0.13), color: a.color, fontSize: 13, fontWeight: 700,
                }}>{a.glyph}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#e8e8f4', flex: 1 }}>{a.name}</span>
              </div>
              <span style={{ fontSize: 11.5, lineHeight: 1.55, color: '#8a8a9e' }}>{a.desc}</span>
              <textarea
                value={descs[a.name] ?? ''}
                onChange={e => setDescs(d => ({ ...d, [a.name]: e.target.value }))}
                placeholder="Optional — narrow the request…"
                rows={2}
                style={{
                  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8,
                  padding: '6px 9px', fontSize: 11.5, color: '#c8c8e8', outline: 'none', fontFamily: 'inherit', resize: 'none',
                }}
              />
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={chipStyle}>{a.chip1}</span>
                <span style={chipStyle}>{a.chip2}</span>
                <div style={{ flex: 1 }} />
                <button
                  onClick={() => onBuild(a.prompt(descs[a.name]?.trim() || a.desc))}
                  style={{ fontSize: 10, fontWeight: 700, color: a.color, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                >Run ▸</button>
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#d8d8e8', flex: 1 }}>Skill &amp; tool library</span>
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Search…"
              style={{
                background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10,
                padding: '6px 12px', fontSize: 12, color: '#d0d0e0', outline: 'none', fontFamily: 'inherit', width: 200,
              }}
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
            {fSkills.map(s => (
              <div key={s.id} style={{ padding: '9px 11px', borderRadius: 10, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: '#d8d8e8' }}>{s.id}</div>
                <div style={{ fontSize: 10.5, color: '#66667a', marginTop: 2 }}>{s.summary}</div>
              </div>
            ))}
            {fBuiltin.map(t => (
              <div key={t.name} style={{ padding: '9px 11px', borderRadius: 10, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: '#d8d8e8' }}>{t.name}</div>
                <div style={{ fontSize: 10.5, color: '#66667a', marginTop: 2 }}>{t.description}</div>
              </div>
            ))}
            {fDynamic.map(t => (
              <div key={t.name} style={{ padding: '9px 11px', borderRadius: 10, background: 'rgba(124,124,248,0.05)', border: '1px solid rgba(124,124,248,0.14)' }}>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: '#d8d8e8' }}>{t.name}</div>
                <div style={{ fontSize: 10.5, color: '#66667a', marginTop: 2 }}>{t.description}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
