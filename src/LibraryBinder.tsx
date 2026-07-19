// LibraryPage — inline Settings page hosting TWO nested libraries
// (FABLE5_HANDOFF Feature 1), converted from the old right-edge drawer:
//   · Skill Library — the merged oracle-verified synth catalog (zero-inference
//     code primitives Crucible can emit without any model call)
//   · Tool Library — the agent's built-in tool registry + per-project dynamic
//     tools it has created for itself (.crucible/dynamic-tools/)
// Each section has a plain-language "describe it, have it built" box: the request
// is handed to the agent loop as a normal chat message, where create_tool (tools)
// or the skill factory pipeline (skills) does the actual work — no separate build
// machinery is duplicated here.

import { useEffect, useState } from 'react'
import { apiFetch, API_BASE } from './api'

interface SkillBuildJob {
  id: string
  status: 'running' | 'done' | 'failed'
  stage: string
  message: string
  detail?: string
  entry?: { id: string; summary: string; defaultPath: string; exports: string[] }
}

interface BuiltinTool { name: string; description: string; mutates: boolean }
interface DynamicTool {
  name: string; description: string; useCount: number; successCount: number
  tier: string; createdAt: number; lastUsed: number | null
}
interface SkillEntry { id: string; summary: string; defaultPath: string }

function SectionHeader({ label, count, open, onToggle }: {
  label: string; count: number | null; open: boolean; onToggle: () => void
}) {
  return (
    <button onClick={onToggle} style={{
      width: '100%', background: 'none', border: 'none', cursor: 'pointer',
      display: 'flex', alignItems: 'center', gap: 8, padding: '10px 4px',
      fontFamily: 'inherit',
    }}>
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{
        transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s cubic-bezier(0.22,1,0.36,1)',
        flexShrink: 0,
      }}>
        <path d="M3 1.5L7 5l-4 3.5" stroke="rgba(160,160,200,0.6)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
      <span style={{
        fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
        color: 'rgba(160,160,200,0.6)', textTransform: 'uppercase', flex: 1, textAlign: 'left',
      }}>{label}{count !== null ? ` · ${count}` : ''}</span>
    </button>
  )
}

function BuildBox({ placeholder, hint, onBuild }: {
  placeholder: string; hint: string; onBuild: (text: string) => void
}) {
  const [text, setText] = useState('')
  const submit = () => {
    const t = text.trim()
    if (!t) return
    onBuild(t)
    setText('')
  }
  return (
    <div style={{
      background: 'rgba(124,124,248,0.05)', border: '1px solid rgba(124,124,248,0.14)',
      borderRadius: 12, padding: 10, marginBottom: 10,
      display: 'flex', flexDirection: 'column', gap: 7,
    }}>
      <textarea
        value={text} onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit() }}
        placeholder={placeholder} rows={2}
        style={{
          background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.07)',
          borderRadius: 8, padding: '7px 10px', fontSize: 12, color: '#c8c8e8',
          outline: 'none', fontFamily: 'inherit', resize: 'none', lineHeight: 1.5,
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 10, color: 'rgba(160,160,200,0.4)', lineHeight: 1.5, flex: 1 }}>{hint}</span>
        <button onClick={submit} disabled={!text.trim()} style={{
          background: 'rgba(124,124,248,0.16)', border: '1px solid rgba(124,124,248,0.3)',
          borderRadius: 8, padding: '6px 14px', fontSize: 11, fontWeight: 600,
          color: '#b0b0f0', cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0,
          opacity: !text.trim() ? 0.45 : 1, transition: 'opacity 0.18s',
        }}>Build</button>
      </div>
    </div>
  )
}

export function LibraryPage({ onBuild }: { onBuild: (text: string) => void }) {
  const [skillsOpen, setSkillsOpen] = useState(true)
  const [toolsOpen, setToolsOpen] = useState(true)
  const [skills, setSkills] = useState<SkillEntry[]>([])
  const [builtin, setBuiltin] = useState<BuiltinTool[]>([])
  const [dynamic, setDynamic] = useState<DynamicTool[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)

  const refresh = () => {
    setLoading(true)
    Promise.all([
      apiFetch(`${API_BASE}/api/library/skills`, { credentials: 'include' }).then(r => r.json()),
      apiFetch(`${API_BASE}/api/library/tools`, { credentials: 'include' }).then(r => r.json()),
    ])
      .then(([s, t]) => {
        setSkills(s.skills ?? [])
        setBuiltin(t.builtin ?? [])
        setDynamic(t.dynamic ?? [])
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(() => { refresh() }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const q = search.trim().toLowerCase()
  const fSkills = q ? skills.filter(s => s.id.toLowerCase().includes(q) || s.summary.toLowerCase().includes(q)) : skills
  const fBuiltin = q ? builtin.filter(t => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)) : builtin
  const fDynamic = q ? dynamic.filter(t => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)) : dynamic

  const buildTool = (desc: string) => {
    onBuild(`Create a new reusable agent tool: ${desc}\n\nUse the create_tool mechanism so it persists for future sessions. Pick a clear snake_case name, write a focused description, and smoke-test it before confirming it works.`)
  }

  // Skill builds run through the dedicated verified pipeline (generate → oracle
  // validate → prove:all), not the agent loop — the page stays put and polls
  // the job so the user watches the proof happen.
  const [skillJob, setSkillJob] = useState<SkillBuildJob | null>(null)
  useEffect(() => {
    if (!skillJob || skillJob.status !== 'running' || !skillJob.id) return
    const t = setInterval(() => {
      apiFetch(`${API_BASE}/api/library/skills/build/${skillJob.id}`, { credentials: 'include' })
        .then(r => r.json())
        .then((j: SkillBuildJob) => {
          setSkillJob({ id: skillJob.id, status: j.status, stage: j.stage, message: j.message, detail: j.detail, entry: j.entry })
          if (j.status === 'done') refresh()
        })
        .catch(() => {})
    }, 3000)
    return () => clearInterval(t)
  }, [skillJob?.id, skillJob?.status])  // eslint-disable-line react-hooks/exhaustive-deps

  const buildSkill = (desc: string) => {
    apiFetch(`${API_BASE}/api/library/skills/build`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request: desc }),
    })
      .then(r => r.json().then(j => ({ httpOk: r.ok, j })))
      .then(({ httpOk, j }) => {
        if (httpOk && j.jobId) setSkillJob({ id: j.jobId, status: 'running', stage: 'admission', message: 'Starting the verified skill pipeline…' })
        else setSkillJob({ id: '', status: 'failed', stage: 'admission', message: j.error ?? 'Could not start the build' })
      })
      .catch(() => setSkillJob({ id: '', status: 'failed', stage: 'admission', message: 'Could not reach the server' }))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {/* Search — settings-page style row, replaces the old drawer header */}
      <input
        value={search} onChange={e => setSearch(e.target.value)}
        placeholder="Search skills and tools…"
        style={{
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 10, padding: '7px 12px', marginBottom: 4,
          fontSize: 12, color: '#c8c8e8', outline: 'none',
          fontFamily: 'inherit', width: '100%',
        }}
      />

      {loading && skills.length === 0 && builtin.length === 0 && (
        <div style={{ textAlign: 'center', color: '#55556a', fontSize: 12, padding: '24px 0' }}>loading…</div>
      )}

      {/* ── Skill Library ── */}
      <SectionHeader
        label="Skill library" count={skills.length ? fSkills.length : null}
        open={skillsOpen} onToggle={() => setSkillsOpen(o => !o)}
      />
      {skillsOpen && (
        <div style={{ paddingLeft: 4, marginBottom: 8 }}>
          <BuildBox
            placeholder={'Describe a skill: exact signature + 2 worked examples, e.g.\nexport function slugify(title: string): string\nslugify("Hello World") -> "hello-world"\nslugify("A  B!") -> "a-b"'}
            hint="Runs the verified pipeline: synthesize, oracle-prove against your examples, then re-prove the whole library. Only proven code lands."
            onBuild={buildSkill}
          />
          {skillJob && (
            <div style={{
              background: skillJob.status === 'failed' ? 'rgba(245,158,11,0.06)' : 'rgba(77,184,158,0.06)',
              border: `1px solid ${skillJob.status === 'failed' ? 'rgba(245,158,11,0.22)' : 'rgba(77,184,158,0.2)'}`,
              borderRadius: 10, padding: '9px 11px', marginBottom: 10,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', flex: 1,
                  color: skillJob.status === 'running' ? 'rgba(124,124,248,0.8)'
                    : skillJob.status === 'done' ? 'rgba(77,184,158,0.85)' : 'rgba(245,158,11,0.85)',
                }}>
                  {skillJob.status === 'running' ? `Building — ${skillJob.stage}` : skillJob.status === 'done' ? 'Proven & added' : 'Not added'}
                </span>
                {skillJob.status !== 'running' && (
                  <button onClick={() => setSkillJob(null)} style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: 'rgba(160,160,200,0.5)', fontSize: 11, fontFamily: 'inherit', padding: 0,
                  }}>dismiss</button>
                )}
              </div>
              <div style={{ fontSize: 11, color: 'rgba(200,200,232,0.75)', lineHeight: 1.55, marginTop: 4 }}>
                {skillJob.message}
              </div>
              {skillJob.detail && (
                <div style={{
                  fontSize: 10, color: 'rgba(160,160,200,0.5)', lineHeight: 1.5, marginTop: 4,
                  fontFamily: 'ui-monospace, monospace', whiteSpace: 'pre-wrap',
                }}>{skillJob.detail}</div>
              )}
            </div>
          )}
          {fSkills.map(s => (
            <div key={s.id} style={{
              borderBottom: '1px solid rgba(255,255,255,0.04)',
              padding: '9px 4px',
            }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: '#c8c8e8', fontFamily: 'ui-monospace, monospace' }}>{s.id}</span>
                <span style={{ fontSize: 10, color: 'rgba(160,160,200,0.35)', fontFamily: 'ui-monospace, monospace' }}>{s.defaultPath}</span>
              </div>
              <div style={{ fontSize: 11, color: 'rgba(160,160,200,0.5)', lineHeight: 1.5, marginTop: 3 }}>{s.summary}</div>
            </div>
          ))}
          {!loading && fSkills.length === 0 && (
            <div style={{ fontSize: 11, color: 'rgba(160,160,200,0.35)', padding: '10px 4px' }}>
              {q ? 'No matching skills' : 'No skills yet'}
            </div>
          )}
        </div>
      )}

      {/* ── Tool Library ── */}
      <SectionHeader
        label="Tool library" count={builtin.length ? fBuiltin.length + fDynamic.length : null}
        open={toolsOpen} onToggle={() => setToolsOpen(o => !o)}
      />
      {toolsOpen && (
        <div style={{ paddingLeft: 4 }}>
          <BuildBox
            placeholder="Describe a tool you want the agent to have…"
            hint="The agent writes, smoke-tests, and registers it. Persisted — available in all future sessions."
            onBuild={buildTool}
          />

          {/* Dynamic (agent-created) tools first — these are the user's own */}
          {fDynamic.length > 0 && (
            <div style={{ marginBottom: 6 }}>
              <span style={{
                fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
                color: 'rgba(77,184,158,0.7)', textTransform: 'uppercase',
                display: 'block', padding: '4px 4px 6px',
              }}>Created for this project</span>
              {fDynamic.map(t => (
                <div key={t.name} style={{
                  background: 'rgba(77,184,158,0.05)', border: '1px solid rgba(77,184,158,0.14)',
                  borderRadius: 10, padding: '9px 11px', marginBottom: 6,
                }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: '#c8c8e8', fontFamily: 'ui-monospace, monospace' }}>{t.name}</span>
                    <span style={{ fontSize: 9.5, color: 'rgba(160,160,200,0.45)' }}>
                      used {t.useCount}x{t.tier !== 'session' ? ` · ${t.tier}` : ''}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: 'rgba(160,160,200,0.5)', lineHeight: 1.5, marginTop: 3 }}>{t.description}</div>
                </div>
              ))}
            </div>
          )}

          {/* Built-in tools */}
          {fBuiltin.map(t => (
            <div key={t.name} style={{
              borderBottom: '1px solid rgba(255,255,255,0.04)',
              padding: '9px 4px',
            }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: '#c8c8e8', fontFamily: 'ui-monospace, monospace' }}>{t.name}</span>
                {t.mutates && (
                  <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', color: 'rgba(245,158,11,0.65)', textTransform: 'uppercase' }}>writes</span>
                )}
              </div>
              <div style={{ fontSize: 11, color: 'rgba(160,160,200,0.5)', lineHeight: 1.5, marginTop: 3 }}>{t.description}</div>
            </div>
          ))}
          {!loading && fBuiltin.length === 0 && fDynamic.length === 0 && (
            <div style={{ fontSize: 11, color: 'rgba(160,160,200,0.35)', padding: '10px 4px' }}>
              {q ? 'No matching tools' : 'No tools yet'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
