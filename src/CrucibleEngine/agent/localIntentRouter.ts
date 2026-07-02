// ── Local Intent Router — Offline-First agentic execution (Track O, Layer 0) ──
//
// THE VISION: a truly offline Crucible that leans on its own knowledge and on-device
// capability, reaching for an external LLM only in genuinely niche cases. This module
// is Layer 0 of that stack: deterministic intent → tool resolution with ZERO model
// calls. The most common agentic commands ("open Spotify", "play X on YouTube",
// "empty the trash", "click the Submit button", "type hello") are unambiguous — they
// do not need a 5–10s LLM round-trip to plan. We pattern-match them and dispatch the
// exact tool sequence directly.
//
// Design rules:
//   • HIGH PRECISION over recall. When in doubt, return null and let the LLM agent
//     loop handle it. A wrong deterministic action is far worse than a slow correct one.
//   • Pure resolver. resolveLocalIntent(message) is a pure function (message → plan |
//     null) so it is trivially unit-testable without a running daemon or API key.
//   • Chaining via deriveArgs. Steps that depend on a prior result (search → open)
//     derive their args from the previous ToolResult.
//
// This is the foundation the corpus-grounded answer path (Layer 1) and local-FM
// planning (Layer 2) build on. See ROADMAP Track O.

import type { ToolResult } from '../tools/protocol'

export interface LocalStep {
  tool: string
  args?: Record<string, unknown>
  /** Derive args from the previous step's result (search → open chaining). Return
   *  null to abort the plan (e.g. the search found nothing). */
  deriveArgs?: (prev: ToolResult) => Record<string, unknown> | null
}

export interface LocalPlan {
  /** Coarse intent label, surfaced on the debug bus. */
  intent: string
  /** Human-facing summary used as the agent's final text. */
  label: string
  steps: LocalStep[]
}

// ── Vocabulary ────────────────────────────────────────────────────────────────

// Known macOS app names → canonical `open -a` target. Lowercased keys.
const APP_ALIASES: Record<string, string> = {
  spotify: 'Spotify', finder: 'Finder', safari: 'Safari', chrome: 'Google Chrome',
  'google chrome': 'Google Chrome', firefox: 'Firefox', arc: 'Arc', mail: 'Mail',
  messages: 'Messages', notes: 'Notes', calendar: 'Calendar', reminders: 'Reminders',
  music: 'Music', 'apple music': 'Music', photos: 'Photos', preview: 'Preview',
  terminal: 'Terminal', iterm: 'iTerm', 'vs code': 'Visual Studio Code',
  vscode: 'Visual Studio Code', 'visual studio code': 'Visual Studio Code',
  xcode: 'Xcode', slack: 'Slack', discord: 'Discord', zoom: 'zoom.us',
  textedit: 'TextEdit', calculator: 'Calculator', 'system settings': 'System Settings',
  'system preferences': 'System Settings', maps: 'Maps', facetime: 'FaceTime',
  podcasts: 'Podcasts', 'activity monitor': 'Activity Monitor',
}

// Streaming services that should resolve to a web search + open, not a native app.
const WEB_SERVICES: Record<string, { kind: 'youtube' | 'web'; site?: string }> = {
  youtube: { kind: 'youtube' },
  netflix: { kind: 'web', site: 'https://www.netflix.com/search?q=' },
}

const stripPunct = (s: string) => s.trim().replace(/[.!?]+$/, '').trim()

// Parse the first verified YouTube URL out of search_youtube's text output.
function firstYoutubeUrl(out: string): string | null {
  const m = out.match(/https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}/)
  return m ? m[0] : null
}

// ── Resolvers (ordered: most specific first) ───────────────────────────────────

// "play <something> on youtube" / "put on <something>" / "play <x>" (defaults YT)
function resolvePlayMedia(m: string): LocalPlan | null {
  // Capture the media subject and (optionally) the service.
  const re = /\b(?:play|put on|queue(?: up)?|pull up)\b\s+(.+?)(?:\s+on\s+(youtube|spotify|netflix|apple music|music))?\s*$/i
  const match = m.match(re)
  if (!match) return null
  const subject = stripPunct(match[1])
  if (!subject || subject.length < 2) return null
  const service = (match[2] ?? 'youtube').toLowerCase()

  if (service === 'spotify' || service === 'apple music' || service === 'music') {
    // Open the app and search via its URL scheme where possible. Spotify supports a
    // search URI; Music falls back to opening the app (search-by-URL is unreliable).
    if (service === 'spotify') {
      return {
        intent: 'play_media',
        label: `Opening Spotify search for "${subject}".`,
        steps: [{ tool: 'open_app', args: { target: `spotify:search:${encodeURIComponent(subject)}` } }],
      }
    }
    return {
      intent: 'play_media',
      label: `Opening Music for "${subject}".`,
      steps: [{ tool: 'open_app', args: { target: 'Music' } }],
    }
  }

  // YouTube (default): live search, then open the top verified result. No LLM.
  return {
    intent: 'play_media',
    label: `Searching YouTube for "${subject}" and playing the top result.`,
    steps: [
      { tool: 'search_youtube', args: { query: subject, count: 3 } },
      {
        tool: 'open_app',
        deriveArgs: (prev) => {
          if (!prev.ok) return null
          const url = firstYoutubeUrl(prev.output)
          return url ? { target: url } : null
        },
      },
    ],
  }
}

// "open <app>" / "launch <app>" / "open <url>"
function resolveOpen(m: string): LocalPlan | null {
  const match = m.match(/\b(?:open|launch|start up|fire up|bring up)\s+(.+?)\s*$/i)
  if (!match) return null
  const raw = stripPunct(match[1]).replace(/^(the|my)\s+/i, '')
  if (!raw) return null

  // URL?
  if (/^https?:\/\//i.test(raw) || /^[a-z0-9-]+\.(com|org|net|io|dev|app|co|ai)\b/i.test(raw)) {
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
    return { intent: 'open_url', label: `Opening ${url}.`, steps: [{ tool: 'open_app', args: { target: url } }] }
  }

  // Known web service (e.g. "open youtube") → open its site.
  const svc = WEB_SERVICES[raw.toLowerCase()]
  if (svc) {
    const url = svc.kind === 'youtube' ? 'https://www.youtube.com' : (svc.site?.replace(/search.*$/, '') ?? 'https://www.netflix.com')
    return { intent: 'open_url', label: `Opening ${raw}.`, steps: [{ tool: 'open_app', args: { target: url } }] }
  }

  // Known native app?
  const appName = APP_ALIASES[raw.toLowerCase()]
  if (appName) {
    return { intent: 'open_app', label: `Opening ${appName}.`, steps: [{ tool: 'open_app', args: { target: appName } }] }
  }

  // Unknown single-word target that looks like an app name (no spaces, short) — try it.
  // open -a fails cleanly if the app doesn't exist, so this is safe.
  if (/^[A-Za-z][A-Za-z0-9 ]{1,28}$/.test(raw) && raw.split(' ').length <= 3) {
    return { intent: 'open_app', label: `Opening ${raw}.`, steps: [{ tool: 'open_app', args: { target: raw } }] }
  }
  return null
}

// "empty the trash" / "empty trash"
function resolveEmptyTrash(m: string): LocalPlan | null {
  if (/\bempty\b.*\btrash\b/i.test(m) || /\btrash\b.*\bempty\b/i.test(m)) {
    return { intent: 'empty_trash', label: 'Emptying the Trash.', steps: [{ tool: 'empty_trash' }] }
  }
  return null
}

// System settings ("set brightness to 50%", "dark mode on", "turn wifi off", "mute",
// "lock the screen", "battery level"). These MUST be deterministic — routing them through
// the LLM loop makes it drive the System Settings UI via Accessibility, which fails
// ("Can't set «class tabg» … to 0.5, -10006"), loops, and steals focus. control_mac runs
// the reliable native command and verifies it. Backed by the macCapabilities recipe library.
function cm(intent: string, label: string, args: Record<string, unknown> = {}): LocalPlan {
  return { intent: 'control_mac', label, steps: [{ tool: 'control_mac', args: { intent, ...args } }] }
}

function resolveSystemControl(m: string): LocalPlan | null {
  const lower = m.toLowerCase()

  // ── Toggles (no number needed) ──────────────────────────────────────────────
  // Mute / unmute
  if (/^\s*(un)?mute\b/.test(lower) ||
      /\b(mute|unmute)\b.*\b(volume|sound|audio)\b/.test(lower) ||
      /\b(volume|sound|audio)\b.*\b(mute|unmute)\b/.test(lower)) {
    const on = !/\bunmute\b/.test(lower)
    return cm('mute', on ? 'Muting.' : 'Unmuting.', { on })
  }
  // Dark / light mode
  if (/\b(dark|light)\s*(mode|theme|appearance)\b/.test(lower) || /\bappearance\b/.test(lower)) {
    const on = /\bdark\b/.test(lower)
    return cm('dark_mode', on ? 'Switching to Dark mode.' : 'Switching to Light mode.', { on })
  }
  // Wi-Fi on/off (connect-to-network is left to the loop — needs SSID/password parsing)
  if (/\b(wi-?fi|wireless|airport)\b/.test(lower) && !/\b(connect|join|password|network named)\b/.test(lower)) {
    const off = /\b(off|disable|turn off|disconnect)\b/.test(lower)
    return cm('wifi', off ? 'Turning Wi-Fi off.' : 'Turning Wi-Fi on.', { on: !off })
  }
  // Lock screen
  if (/\block\b.{0,12}\b(screen|mac|computer|it)\b/.test(lower) || /^\s*lock\s*$/.test(lower)) {
    return cm('lock_screen', 'Locking the screen.')
  }
  // Sleep (Mac vs display)
  if (/\b(turn off|sleep)\b.{0,12}\b(screen|display|monitor)\b/.test(lower)) {
    return cm('display_sleep', 'Turning the display off.')
  }
  if (/\b(go to sleep|sleep the (mac|computer)|put .* to sleep)\b/.test(lower) || /^\s*sleep\s*$/.test(lower)) {
    return cm('sleep', 'Putting the Mac to sleep.')
  }
  // Battery (read-only)
  if (/\bbattery\b/.test(lower) || /\b(charge|power)\s*(level|status|percentage)\b/.test(lower)) {
    return cm('battery', 'Checking battery.')
  }

  // ── Level setters (need an absolute number) ─────────────────────────────────
  const isBrightness = /\bbrightness\b/.test(lower) || /\b(dim|brighten)\b.{0,15}\b(screen|display)\b/.test(lower)
  const isVolume = /\bvolume\b/.test(lower) || /\b(set|turn|change|adjust)\b.{0,15}\b(sound|audio)\b/.test(lower)
  if (!isBrightness && !isVolume) return null

  // Absolute target only — "50%", "50 percent", "to 50", else any bare number.
  // Relative ("a bit brighter") is left to the loop: precision over recall.
  const pm = lower.match(/(\d{1,3})\s*(?:%|percent)/) || lower.match(/\bto\s+(\d{1,3})\b/) || lower.match(/\b(\d{1,3})\b/)
  if (!pm) return null
  const percent = Math.max(0, Math.min(100, parseInt(pm[1], 10)))
  const intent = isBrightness ? 'brightness' : 'volume'
  return cm(intent, `Setting ${intent} to ${percent}%.`, { percent })
}

// "click the <X> button" / "click <X>" / "tap <X>"  (Remote Brain Mac control)
function resolveClick(m: string): LocalPlan | null {
  const match = m.match(/\b(?:click|tap|press)\b\s+(?:on\s+)?(?:the\s+)?(.+?)(?:\s+(?:button|link|tab|icon|menu item|item))?\s*$/i)
  if (!match) return null
  const target = stripPunct(match[1])
  if (!target || target.length < 2 || target.length > 40) return null
  return { intent: 'click_element', label: `Clicking "${target}".`, steps: [{ tool: 'click_element', args: { title: target } }] }
}

// "type <X>" / "enter <X>"  (Remote Brain Mac control)
function resolveType(m: string): LocalPlan | null {
  const match = m.match(/^\s*(?:type|enter|input)\s+(?:in\s+)?["“]?(.+?)["”]?\s*$/i)
  if (!match) return null
  const text = match[1].trim()
  if (!text || text.length > 500) return null
  return { intent: 'type_text', label: `Typing "${text.slice(0, 40)}${text.length > 40 ? '…' : ''}".`, steps: [{ tool: 'type_text', args: { text } }] }
}

const RESOLVERS = [resolveSystemControl, resolvePlayMedia, resolveEmptyTrash, resolveOpen, resolveClick, resolveType]

/**
 * Resolve a message to a deterministic tool plan, or null if no high-confidence
 * match. Pure function — safe to unit-test in isolation.
 */
// Multi-step / sequenced requests ("open settings, set brightness, then play a video")
// must NOT be served by a single-action resolver — that silently drops every step after
// the first. Hand them to the full LLM agent loop, which can plan + execute in sequence.
const MULTI_STEP_LOCAL = /\b(?:then|after that|and then)\b/i
const ACTION_VERB_LOCAL = /\b(?:open|turn|set|play|show|find|search|close|launch|go to|put on|click|type|increase|decrease|adjust|mute|change|switch)\b/gi

export function resolveLocalIntent(message: string): LocalPlan | null {
  const m = (message ?? '').trim()
  if (!m || m.length > 200) return null  // long prose → not a simple command
  // Compound request → not a simple command. Precision over recall: defer to the loop.
  if (MULTI_STEP_LOCAL.test(m) || (m.match(ACTION_VERB_LOCAL)?.length ?? 0) >= 3) return null
  for (const r of RESOLVERS) {
    const plan = r(m)
    if (plan) return plan
  }
  return null
}

/**
 * Execute a resolved plan against a tool-exec function. Returns the per-step outputs
 * and a final summary. Aborts (ok:false) if any required step fails or a chained
 * deriveArgs returns null. Kept exec-injected so it's testable with a mock.
 */
export async function runLocalPlan(
  plan: LocalPlan,
  exec: (call: { id: string; name: string; args: Record<string, unknown> }) => Promise<ToolResult>,
): Promise<{ ok: boolean; outputs: ToolResult[]; summary: string }> {
  const outputs: ToolResult[] = []
  let prev: ToolResult | null = null
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i]
    let args = step.args ?? {}
    if (step.deriveArgs) {
      const derived = prev ? step.deriveArgs(prev) : null
      if (!derived) {
        return { ok: false, outputs, summary: `Could not complete "${plan.label}" — no usable result from the previous step.` }
      }
      args = derived
    }
    const result = await exec({ id: `local_${i}`, name: step.tool, args })
    outputs.push(result)
    prev = result
    if (!result.ok) {
      return { ok: false, outputs, summary: `Step ${i + 1} (${step.tool}) failed: ${result.output.slice(0, 200)}` }
    }
  }
  // For single-step plans the tool's own output is the verified, informative result
  // (e.g. "Battery: 27%, charging" or "Volume set to 35% (confirmed: 35%)") — surface it
  // instead of the generic label. Multi-step plans keep the clean label as the summary.
  const lastOut = outputs[outputs.length - 1]?.output?.trim()
  const summary = plan.steps.length === 1 && lastOut ? lastOut : plan.label
  return { ok: true, outputs, summary }
}
