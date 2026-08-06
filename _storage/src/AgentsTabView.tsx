// Agents & skills panel — Item 18/19 redesign (cont.42).
//
// Previously this was a full-page tab (`tab === 'agents'`) that unmounted the chat view
// entirely — running an agent or browsing tools meant navigating away from the conversation.
// Now it's an inline drawer anchored to the chat panel (same pattern as LibraryBinder's
// right-edge drawer / History & Settings binders): a trigger button toggles it open as an
// overlay, the chat underneath stays mounted and scrolled where the user left it.
//
// Presentation is "app store / command palette", not a man-page:
//   - Prebuilt workflow cards ("Agents") are the default, conversational surface —
//     "Crucible can also: search the web, do deep research, ...".
//   - Skills & tools are grouped into labeled categories with plain-language descriptions,
//     with a single search box across everything.
//   - Raw/power-user detail (exact tool name, use-count telemetry, per-tool tier) is hidden
//     behind an "Advanced" toggle — off by default — rather than being the default view.
//
// Data shape (unchanged from before, still GET /api/library/skills + /api/library/tools):
//   SkillEntry   { id, summary, defaultPath }              — oracle-verified synth catalog
//   BuiltinTool  { name, description, mutates }             — built-in agent tool registry
//   DynamicTool  { name, description, useCount, successCount, tier } — agent-created, per-project

import { useEffect, useMemo, useState } from 'react'
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

// Exported so the composer's (+) expander can offer the same workflows as a quick
// command list without opening this drawer (trust-audit item H).
export const AGENT_WORKFLOWS = [
  { name: 'Vibe Code', glyph: '{ }', color: '#4db89e', category: 'Build',
    desc: 'Describe the app; Crucible writes, lints, and self-reviews the code on-device.',
    prompt: (d: string) => `Build this for me: ${d}\n\nWrite the actual working code (real files, no stubs), run it to verify it works, and fix anything that breaks before finishing. If it's a game or interactive app, also produce a self-contained single-file web version (HTML + inline JS/canvas) so it's playable right inside Crucible.` },
  { name: 'Search Web', glyph: '◎', color: '#f59e0b', category: 'Research',
    desc: 'Web-augmented answers with ranked, cited sources.',
    prompt: (d: string) => `Search the web and answer with cited sources: ${d}` },
  { name: 'Deep Research', glyph: '≡', color: '#38bdf8', category: 'Research',
    desc: 'Autonomous multi-step research runs with a structured, cited report.',
    prompt: (d: string) => `Do a deep, multi-step research pass and produce a structured cited report on: ${d}` },
  { name: 'Smoke Test', glyph: '✓', color: '#c084fc', category: 'Build',
    desc: 'Throws adversarial cases at your code or spec and reports what breaks.',
    prompt: (d: string) => `Throw adversarial test cases at this and report exactly what breaks: ${d}` },
  { name: 'Decide For Me', glyph: '⚖', color: '#7c7cf8', category: 'Reasoning',
    desc: 'Structured self-debate over your options with one ranked recommendation.',
    prompt: (d: string) => `Structure a self-debate over these options and give one ranked recommendation: ${d}` },
]

const chipStyle: React.CSSProperties = {
  fontSize: 9, fontWeight: 600, letterSpacing: '0.05em', padding: '2px 7px', borderRadius: 999,
  background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.07)', color: '#77778c',
}

function CategoryLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase',
      color: 'rgba(160,160,200,0.55)', padding: '2px 4px 8px',
    }}>{children}</div>
  )
}

// A plain-language "the assistant can also…" row — used for skills/tools in the default
// (non-advanced) view. Clickable: drops "/toolName " into the composer so the user can
// type the arguments, same pattern as Claude/OpenAI's "/" command palette.
function CapabilityRow({ name, desc, mono, tint, onSelect }: { name: string; desc: string; mono?: boolean; tint?: string; onSelect?: () => void }) {
  return (
    <div
      onClick={onSelect}
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onKeyDown={onSelect ? (e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect() } }) : undefined}
      style={{
        padding: '8px 11px', borderRadius: 9, cursor: onSelect ? 'pointer' : 'default',
        background: tint ? tintOf(tint, 0.05) : 'rgba(255,255,255,0.03)',
        border: `1px solid ${tint ? tintOf(tint, 0.16) : 'rgba(255,255,255,0.06)'}`,
        transition: 'background 0.15s, border-color 0.15s',
      }}
      onMouseEnter={onSelect ? (e => { e.currentTarget.style.background = tint ? tintOf(tint, 0.1) : 'rgba(255,255,255,0.06)' }) : undefined}
      onMouseLeave={onSelect ? (e => { e.currentTarget.style.background = tint ? tintOf(tint, 0.05) : 'rgba(255,255,255,0.03)' }) : undefined}
    >
      <div style={{ fontSize: 11, fontWeight: 600, color: '#d8d8e8', fontFamily: mono ? 'ui-monospace, monospace' : 'inherit' }}>{name}</div>
      <div style={{ fontSize: 10, color: '#8a8a9e', marginTop: 1, lineHeight: 1.4 }}>{desc}</div>
    </div>
  )
}

export default function AgentsTabView({ onBuild, onClose, onInsert }: { onBuild: (text: string, display?: string) => void; onClose?: () => void; onInsert?: (text: string) => void }) {
  const [descs, setDescs] = useState<Record<string, string>>({})
  const [skills, setSkills] = useState<SkillEntry[]>([])
  const [builtin, setBuiltin] = useState<BuiltinTool[]>([])
  const [dynamic, setDynamic] = useState<DynamicTool[]>([])
  const [q, setQ] = useState('')
  const [advanced, setAdvanced] = useState(false)

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
  const fAgents = query ? AGENT_WORKFLOWS.filter(a => a.name.toLowerCase().includes(query) || a.desc.toLowerCase().includes(query) || a.category.toLowerCase().includes(query)) : AGENT_WORKFLOWS
  const fSkills = query ? skills.filter(s => s.id.toLowerCase().includes(query) || s.summary.toLowerCase().includes(query)) : skills.slice(0, 30)
  const fBuiltin = query ? builtin.filter(t => t.name.toLowerCase().includes(query) || t.description.toLowerCase().includes(query)) : builtin
  const fDynamic = query ? dynamic.filter(t => t.name.toLowerCase().includes(query)) : dynamic

  const agentsByCategory = useMemo(() => {
    const map = new Map<string, typeof AGENT_WORKFLOWS>()
    for (const a of fAgents) {
      const arr = map.get(a.category) ?? []
      arr.push(a)
      map.set(a.category, arr)
    }
    return map
  }, [fAgents])

  const totalResults = fAgents.length + fSkills.length + fBuiltin.length + fDynamic.length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Header — search + advanced toggle + close, sticky */}
      <div style={{
        flexShrink: 0, padding: '14px 18px 12px', display: 'flex', flexDirection: 'column', gap: 10,
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: '-0.01em', color: '#eef', flex: 1 }}>Agents &amp; capabilities</span>
          {onClose && (
            <button onClick={onClose} aria-label="Close" style={{
              background: 'none', border: 'none', cursor: 'pointer', color: '#666',
              width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: 8, flexShrink: 0,
            }}>
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              </svg>
            </button>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', opacity: 0.4 }}>
              <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.4" />
              <path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Search what Crucible can do…"
              style={{
                width: '100%', background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10,
                padding: '7px 12px 7px 30px', fontSize: 12, color: '#d0d0e0', outline: 'none', fontFamily: 'inherit',
              }}
            />
          </div>
          <button
            onClick={() => setAdvanced(a => !a)}
            title="Show raw tool/skill details"
            style={{
              fontSize: 10.5, fontWeight: 600, letterSpacing: '0.02em', whiteSpace: 'nowrap',
              padding: '7px 11px', borderRadius: 9, cursor: 'pointer', fontFamily: 'inherit',
              background: advanced ? 'rgba(124,124,248,0.14)' : 'rgba(255,255,255,0.04)',
              border: `1px solid ${advanced ? 'rgba(124,124,248,0.3)' : 'rgba(255,255,255,0.08)'}`,
              color: advanced ? '#b0b0f8' : '#8a8a9e', transition: 'background 0.18s, color 0.18s, border-color 0.18s',
            }}
          >Advanced{advanced ? ' ✓' : ''}</button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, WebkitOverflowScrolling: 'touch' }}>
        <div style={{ padding: '16px 18px 32px', display: 'flex', flexDirection: 'column', gap: 22 }}>

          {query && totalResults === 0 && (
            <div style={{ textAlign: 'center', color: 'rgba(160,160,200,0.4)', fontSize: 12, padding: '32px 0' }}>No matches for &ldquo;{q}&rdquo;</div>
          )}

          {/* ── Prebuilt agent workflows, grouped by category ── */}
          {agentsByCategory.size > 0 && Array.from(agentsByCategory.entries()).map(([cat, items]) => (
            <div key={cat} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <CategoryLabel>{cat}</CategoryLabel>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
                {items.map(a => (
                  <div key={a.name} style={{
                    display: 'flex', flexDirection: 'column', gap: 9, padding: 14, borderRadius: 14,
                    background: `linear-gradient(150deg, ${tintOf(a.color, 0.09)} 0%, rgba(255,255,255,0.02) 60%)`,
                    border: '1px solid rgba(255,255,255,0.07)',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{
                        width: 26, height: 26, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: tintOf(a.color, 0.13), color: a.color, fontSize: 12, fontWeight: 700, flexShrink: 0,
                      }}>{a.glyph}</span>
                      <span style={{ fontSize: 12.5, fontWeight: 700, color: '#e8e8f4', flex: 1 }}>{a.name}</span>
                    </div>
                    <span style={{ fontSize: 11, lineHeight: 1.5, color: '#8a8a9e' }}>{a.desc}</span>
                    <textarea
                      value={descs[a.name] ?? ''}
                      onChange={e => setDescs(d => ({ ...d, [a.name]: e.target.value }))}
                      placeholder="Optional — narrow the request…"
                      rows={2}
                      style={{
                        background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8,
                        padding: '6px 9px', fontSize: 11, color: '#c8c8e8', outline: 'none', fontFamily: 'inherit', resize: 'none',
                      }}
                    />
                    <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                      <div style={{ flex: 1 }} />
                      <button
                        onClick={() => { const d = descs[a.name]?.trim() || a.desc; onClose?.(); onBuild(a.prompt(d), `${a.name}: ${d}`) }}
                        style={{ fontSize: 10.5, fontWeight: 700, color: a.color, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                      >Run ▸</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* ── Skills & tools: plain-language by default, raw list behind Advanced ── */}
          {(fSkills.length > 0 || fBuiltin.length > 0 || fDynamic.length > 0) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              {fDynamic.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <CategoryLabel>Built for this project</CategoryLabel>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
                    {fDynamic.map(t => (
                      <CapabilityRow key={t.name} name={t.name} tint="#4db89e" mono={advanced}
                        desc={advanced ? `${t.description} · used ${t.useCount}x · ${t.tier}` : t.description}
                        onSelect={onInsert ? () => onInsert(`/${t.name} `) : undefined} />
                    ))}
                  </div>
                </div>
              )}
              {fBuiltin.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <CategoryLabel>Crucible can also</CategoryLabel>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
                    {fBuiltin.map(t => (
                      <CapabilityRow key={t.name} name={t.name} mono={advanced}
                        desc={advanced && t.mutates ? `${t.description} · writes` : t.description}
                        onSelect={onInsert ? () => onInsert(`/${t.name} `) : undefined} />
                    ))}
                  </div>
                </div>
              )}
              {fSkills.length > 0 && advanced && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <CategoryLabel>Skill library (raw)</CategoryLabel>
                    <span style={chipStyle}>{skills.length}</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
                    {fSkills.map(s => (
                      <CapabilityRow key={s.id} name={s.id} desc={s.summary} mono
                        onSelect={onInsert ? () => onInsert(`/${s.id} `) : undefined} />
                    ))}
                  </div>
                </div>
              )}
              {fSkills.length > 0 && !advanced && (
                <div style={{ fontSize: 10.5, color: 'rgba(160,160,200,0.35)', padding: '0 4px' }}>
                  + {skills.length} verified code skills — toggle Advanced to browse the raw catalog.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
