// ── Connections registry (Assistant layer step 2 — ASSISTANT_SPEC.md §1A) ─────
// One read model over every external capability the agent can use: Google (OAuth
// tokens in .crucible/google-tokens-<userId>.json, tools already in the agent tool
// registry), locally-executed CLI integrations (integrations/registry.ts), and the
// built-in Mac control surface. This module ADDS no execution path — every tool
// listed here already runs through the agent loop's registry.exec. It only answers
// "what is connected, as whom, with which tools" so the UI and the planner can
// reason about capability honestly.

import { loadTokens, googleServicesStatus } from '../tools/googleApis'
import { listIntegrations } from '../integrations/registry'

export interface ConnectionCard {
  id: string
  name: string
  kind: 'oauth' | 'cli' | 'builtin'
  /** connected = usable now; expired = has credentials that no longer work;
   *  available = detected but not enabled/authorized; disconnected = not set up. */
  authState: 'connected' | 'expired' | 'available' | 'disconnected'
  detail: string               // one-line human state, e.g. account/scopes/version
  tools: string[]              // agent-tool names this connection powers
  services?: Record<string, boolean>  // per-service availability (google scopes)
}

const GOOGLE_TOOLS_BY_SERVICE: Record<string, string[]> = {
  gmail: ['gmail_search', 'gmail_read', 'gmail_send'],
  calendar: ['calendar_list', 'calendar_create'],
  drive: ['drive_search', 'drive_read'],
  contacts: ['contacts_search'],
  youtube: ['youtube_search_api'],
}

export function googleConnection(userId: string | null): ConnectionCard {
  const t = userId ? loadTokens(userId) : null
  if (!t) {
    return {
      id: 'google', name: 'Google', kind: 'oauth', authState: 'disconnected',
      detail: 'Sign in with Google to power Gmail and Calendar tools.',
      tools: [], services: userId ? googleServicesStatus(userId) : undefined,
    }
  }
  const services = googleServicesStatus(userId!)
  const tools = Object.entries(GOOGLE_TOOLS_BY_SERVICE)
    .filter(([svc]) => services[svc])
    .flatMap(([, names]) => names)
  // expires_at only bounds the ACCESS token — with a refresh_token the connection
  // stays usable (gFetch auto-refreshes). Only a missing refresh token is "expired".
  const usable = !!t.refresh_token || Date.now() < t.expires_at - 60_000
  const svcList = Object.entries(services).filter(([, on]) => on).map(([k]) => k)
  return {
    id: 'google', name: 'Google', kind: 'oauth',
    authState: usable ? 'connected' : 'expired',
    detail: usable
      ? `Authorized: ${svcList.slice(0, 5).join(', ')}${svcList.length > 5 ? '…' : ''}`
      : 'Access expired — reconnect with Google to refresh authorization.',
    tools, services,
  }
}

export async function listConnections(userId: string | null): Promise<ConnectionCard[]> {
  const cards: ConnectionCard[] = [googleConnection(userId)]
  // CLI integrations — locally-executed binaries from the integrations drawer.
  try {
    for (const i of await listIntegrations()) {
      cards.push({
        id: `cli-${i.id}`, name: i.name, kind: 'cli',
        authState: i.enabled && i.detected ? 'connected' : i.detected ? 'available' : 'disconnected',
        detail: i.detected
          ? `${i.command}${i.version ? ` ${i.version}` : ''}${i.enabled ? '' : ' — detected, not enabled'}`
          : `${i.command} not found on PATH`,
        tools: i.enabled && i.detected ? [i.id.replace(/-/g, '_')] : [],
      })
    }
  } catch { /* integrations file unreadable — google + builtin still report */ }
  // Built-in Mac control — always present on this machine, no auth.
  cards.push({
    id: 'mac', name: 'This Mac', kind: 'builtin', authState: 'connected',
    detail: 'Local app control, files, and AppleScript — no credentials involved.',
    tools: ['open_app', 'type_text', 'click_element', 'run', 'list_dir', 'read_file', 'write_file'],
  })
  return cards
}
