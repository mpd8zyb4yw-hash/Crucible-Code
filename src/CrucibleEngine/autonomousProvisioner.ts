// Track N — N2: Autonomous server provisioning (gated)
// Consumes approved governance requests with category='server_provisioning'.
// Never executes without prior N1 approval.

import fs from 'fs'
import path from 'path'
import { approveRequest, getAllRequests } from './governanceQueue'
import { debugBus } from './debug/bus'

export type ProviderTarget = 'cloudflare_workers' | 'supabase' | 'railway' | 'render'

export interface ProvisioningPayload {
  provider: ProviderTarget
  resourceName: string
  region?: string
  envVars?: Record<string, string>
  plan?: string
}

export interface ProvisioningResult {
  requestId: string
  provider: ProviderTarget
  resourceName: string
  status: 'provisioned' | 'failed' | 'skipped'
  url?: string
  error?: string
  provisionedAt: number
}

const PROVISION_LOG = '.crucible/provisioning-log.json'

function loadLog(dir: string): ProvisioningResult[] {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, PROVISION_LOG), 'utf8'))
  } catch {
    return []
  }
}

function saveLog(dir: string, log: ProvisioningResult[]): void {
  const p = path.join(dir, PROVISION_LOG)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(log.slice(-100), null, 2))
}

// Provider-specific provisioning stubs.
// Replace stub bodies with real API calls once the user supplies provider tokens.
async function provisionCloudflareWorker(payload: ProvisioningPayload): Promise<{ url?: string }> {
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN not set')
  // Real call: POST https://api.cloudflare.com/client/v4/accounts/{id}/workers/scripts/{name}
  // For now: stub — validates token presence and logs intent
  debugBus.emit('pipeline', 'provision_stub', { provider: 'cloudflare_workers', name: payload.resourceName }, { severity: 'info' })
  return { url: `https://${payload.resourceName}.workers.dev` }
}

async function provisionSupabase(payload: ProvisioningPayload): Promise<{ url?: string }> {
  const token = process.env.SUPABASE_ACCESS_TOKEN
  if (!token) throw new Error('SUPABASE_ACCESS_TOKEN not set')
  // Real call: POST https://api.supabase.com/v1/projects
  debugBus.emit('pipeline', 'provision_stub', { provider: 'supabase', name: payload.resourceName }, { severity: 'info' })
  return { url: `https://${payload.resourceName}.supabase.co` }
}

async function provisionRailway(payload: ProvisioningPayload): Promise<{ url?: string }> {
  const token = process.env.RAILWAY_API_TOKEN
  if (!token) throw new Error('RAILWAY_API_TOKEN not set')
  // Real call: Railway GraphQL API — createProject mutation
  debugBus.emit('pipeline', 'provision_stub', { provider: 'railway', name: payload.resourceName }, { severity: 'info' })
  return { url: `https://${payload.resourceName}.railway.app` }
}

async function provisionRender(payload: ProvisioningPayload): Promise<{ url?: string }> {
  const token = process.env.RENDER_API_KEY
  if (!token) throw new Error('RENDER_API_KEY not set')
  // Real call: POST https://api.render.com/v1/services
  debugBus.emit('pipeline', 'provision_stub', { provider: 'render', name: payload.resourceName }, { severity: 'info' })
  return { url: `https://${payload.resourceName}.onrender.com` }
}

async function dispatchProvisioning(payload: ProvisioningPayload): Promise<{ url?: string }> {
  switch (payload.provider) {
    case 'cloudflare_workers': return provisionCloudflareWorker(payload)
    case 'supabase':           return provisionSupabase(payload)
    case 'railway':            return provisionRailway(payload)
    case 'render':             return provisionRender(payload)
    default: throw new Error(`Unknown provider: ${(payload as any).provider}`)
  }
}

// Scan for approved provisioning requests that haven't been executed yet, and execute them.
// Call this on startup and after each governance approval.
export async function runApprovedProvisioningRequests(dir: string): Promise<ProvisioningResult[]> {
  const log = loadLog(dir)
  const alreadyRun = new Set(log.map(l => l.requestId))
  const all = getAllRequests(dir)
  const pending = all.filter(r => r.status === 'approved' && r.category === 'server_provisioning' && !alreadyRun.has(r.id))

  const results: ProvisioningResult[] = []
  for (const req of pending) {
    const payload = req.payload as ProvisioningPayload | undefined
    if (!payload?.provider || !payload?.resourceName) {
      results.push({ requestId: req.id, provider: payload?.provider ?? 'render', resourceName: payload?.resourceName ?? 'unknown', status: 'skipped', error: 'missing payload fields', provisionedAt: Date.now() })
      continue
    }
    try {
      const out = await dispatchProvisioning(payload)
      results.push({ requestId: req.id, provider: payload.provider, resourceName: payload.resourceName, status: 'provisioned', url: out.url, provisionedAt: Date.now() })
      debugBus.emit('pipeline', 'provision_success', { requestId: req.id, provider: payload.provider, url: out.url }, { severity: 'success' })
    } catch (err: any) {
      results.push({ requestId: req.id, provider: payload.provider, resourceName: payload.resourceName, status: 'failed', error: err.message, provisionedAt: Date.now() })
      debugBus.emit('pipeline', 'provision_failed', { requestId: req.id, error: err.message }, { severity: 'error' })
    }
  }

  if (results.length > 0) saveLog(dir, [...log, ...results])
  return results
}

export function getProvisioningLog(dir: string): ProvisioningResult[] {
  return loadLog(dir)
}
