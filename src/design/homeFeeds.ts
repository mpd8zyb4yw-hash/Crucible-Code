// ── useHomeFeeds — the single I/O owner for Home ───────────────────────────────
// Lifted from MissionWidgets.tsx's polling block. Before this, Home and Mission
// Control each fetched the same endpoints on their own timers: three of the four were
// duplicated, so a user with both mounted made seven requests per cycle instead of
// four. One hook, one timer, one set of state.
//
// Best-effort per source: each request lands independently, so a missing Google scope
// can never blank the GitHub or automations widgets.
//
// The bodies in HomeBoard are pure functions of what this returns. That is what makes
// "same component tree, two layout policies" (board vs deck) cheap.

import { useCallback, useEffect, useState } from 'react'
import { API_BASE, apiFetch } from '../api'
import type { GooglePreview, GithubPreview } from '../ConnectionWidgets'

export interface DigestEntry { automationId: string; name: string; ts: number; status: 'ok' | 'failed'; summary: string; ms: number }
export interface AutomationLite { id: string; name: string; enabled: boolean; nextRun: number | null; consecutiveFailures?: number }

export interface HomeFeeds {
  google: GooglePreview | null
  github: GithubPreview | null
  digest: DigestEntry[]
  automations: AutomationLite[]
  /** Upcoming enabled runs, soonest first. */
  upcoming: AutomationLite[]
  /** False until the first cycle settles, so "empty" and "not loaded yet" stay distinct. */
  loaded: boolean
}

const EMPTY: HomeFeeds = { google: null, github: null, digest: [], automations: [], upcoming: [], loaded: false }

// ── Demo fixtures ──────────────────────────────────────────────────────────────
// The live Home needs Google/GitHub OAuth, which cannot be completed on the user's
// behalf, so without a fixture path the surface is literally unverifiable. Same
// pattern as the existing `?forceMobile=1` escape hatch in App.tsx.
//
//   ?home=demo                       → populated
//   ?home=demo&state=empty           → connected but nothing to show
//   ?home=demo&state=disconnected    → no accounts linked
//   ?home=demo&state=partial         → mail only
//
// This is a VIEW fixture. It never writes anything and never touches the engine — do
// not grow it into a mock backend.
export type DemoState = 'full' | 'empty' | 'partial' | 'disconnected'

export function demoStateFromLocation(): DemoState | null {
  try {
    const q = new URLSearchParams(window.location.search)
    if (q.get('home') !== 'demo') return null
    const s = q.get('state')
    return s === 'empty' || s === 'partial' || s === 'disconnected' ? s : 'full'
  } catch { return null }
}

function iso(msFromNow: number): string { return new Date(Date.now() + msFromNow).toISOString() }

export function demoFeeds(state: DemoState): HomeFeeds {
  if (state === 'disconnected') return { ...EMPTY, loaded: true }

  const gmail = [
    { id: '1', from: 'Dana Reyes', subject: 'Lease renewal — needs your signature by Friday', date: iso(-2 * 3600_000), unread: true, important: true, reasons: ['addressed to you', 'asks a question'] },
    { id: '2', from: 'Priya Nandakumar', subject: 'Re: vendor SOC 2 renewals', date: iso(-5 * 3600_000), unread: true, important: true, reasons: ['addressed to you'] },
    { id: '3', from: 'Weekly Digest', subject: 'Your week in review', date: iso(-26 * 3600_000), unread: false, important: false, reasons: [] },
  ]
  const calendar = [
    { title: 'Standup', start: iso(40 * 60_000), end: iso(70 * 60_000), allDay: false },
    { title: 'Design review', start: iso(5 * 3600_000), end: iso(6 * 3600_000), allDay: false },
  ]

  if (state === 'partial') {
    return { ...EMPTY, loaded: true, google: { gmail, calendar: null } }
  }
  if (state === 'empty') {
    return { ...EMPTY, loaded: true, google: { gmail: [], calendar: [] }, github: { prs: [] } }
  }

  return {
    loaded: true,
    google: { gmail, calendar },
    github: { prs: [
      { title: 'Retire the ad-hoc easing curve', repo: 'justin/crucible', url: 'https://example.invalid/1', updatedAt: iso(-3 * 3600_000), state: 'open' },
      { title: 'Deterministic free-block solver', repo: 'justin/crucible', url: 'https://example.invalid/2', updatedAt: iso(-30 * 3600_000), state: 'open' },
    ] },
    digest: [
      { automationId: 'a', name: 'Node LTS', ts: Date.now() - 5 * 3600_000, status: 'ok', summary: 'Node LTS moved from 22 to 24 — confirmed against the published release table.', ms: 910 },
      { automationId: 'b', name: 'Landlord reply', ts: Date.now() - 20 * 3600_000, status: 'ok', summary: 'A reply arrived; it was not there at the previous check.', ms: 1200 },
      { automationId: 'c', name: 'API deprecations', ts: Date.now() - 26 * 3600_000, status: 'failed', summary: 'source unreachable', ms: 400 },
    ],
    automations: [
      { id: 'a', name: 'Node LTS', enabled: true, nextRun: Date.now() + 3600_000, consecutiveFailures: 0 },
      { id: 'b', name: 'Landlord reply', enabled: true, nextRun: Date.now() + 2 * 3600_000, consecutiveFailures: 0 },
      { id: 'c', name: 'API deprecations', enabled: false, nextRun: null, consecutiveFailures: 3 },
      { id: 'd', name: 'Rent index', enabled: true, nextRun: Date.now() + 8 * 3600_000, consecutiveFailures: 0 },
    ],
    upcoming: [
      { id: 'a', name: 'Node LTS', enabled: true, nextRun: Date.now() + 3600_000 },
      { id: 'b', name: 'Landlord reply', enabled: true, nextRun: Date.now() + 2 * 3600_000 },
    ],
  }
}

export function useHomeFeeds(): { feeds: HomeFeeds; refresh: () => void } {
  const demo = demoStateFromLocation()
  const [feeds, setFeeds] = useState<HomeFeeds>(() => (demo ? demoFeeds(demo) : EMPTY))

  const refresh = useCallback(() => {
    if (demo) { setFeeds(demoFeeds(demo)); return }

    const patch = (p: Partial<HomeFeeds>) => setFeeds(prev => ({ ...prev, ...p, loaded: true }))

    apiFetch(`${API_BASE}/api/connections/google/preview`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null).then(g => { if (g) patch({ google: g }) }).catch(() => {})
    apiFetch(`${API_BASE}/api/connections/github/preview`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null).then(gh => { if (gh) patch({ github: gh }) }).catch(() => {})
    apiFetch(`${API_BASE}/api/automations/digest`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null).then(d => { if (d) patch({ digest: (d.entries ?? []).slice(0, 6) }) }).catch(() => {})
    apiFetch(`${API_BASE}/api/automations`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(a => {
        if (!a) return
        const list: AutomationLite[] = a.automations ?? []
        patch({
          automations: list,
          upcoming: list
            .filter(x => x.enabled && x.nextRun != null)
            .sort((x, y) => x.nextRun! - y.nextRun!)
            .slice(0, 5),
        })
      }).catch(() => {})
  }, [demo])

  // Poll while mounted. A home that loads once goes stale on the wall; 45s matches the
  // data's real cadence and is what Mission Control already used.
  useEffect(() => {
    refresh()
    if (demo) { setFeeds(demoFeeds(demo)); return }
    const iv = setInterval(refresh, 45_000)
    return () => clearInterval(iv)
  }, [refresh, demo])

  return { feeds, refresh }
}
