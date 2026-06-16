// Track N — N1: Admin governance UI
// Infrastructure requests queue. Engine submits requests; human approves/rejects.
// Nothing executes autonomously — every cross-boundary action waits for sign-off.

import fs from 'fs'
import path from 'path'
import { debugBus } from './debug/bus'

export type RequestCategory =
  | 'server_provisioning'
  | 'memory_store_management'
  | 'model_registry_addition'
  | 'self_patch'
  | 'data_deletion'

export type RequestStatus = 'pending' | 'approved' | 'rejected'

export interface GovernanceRequest {
  id: string
  category: RequestCategory
  title: string
  what: string       // what it needs
  why: string        // why it needs it
  how: string        // how it will execute
  impact: string     // projected impact
  status: RequestStatus
  createdAt: number
  decidedAt?: number
  decidedBy?: string  // 'user' or 'auto-expired'
  payload?: Record<string, unknown>  // data N2 will consume on approval
}

const QUEUE_FILE = '.crucible/governance-queue.json'
const MAX_REQUESTS = 50

function queuePath(dir: string) {
  return path.join(dir, QUEUE_FILE)
}

function loadQueue(dir: string): GovernanceRequest[] {
  try {
    const raw = fs.readFileSync(queuePath(dir), 'utf8')
    return JSON.parse(raw) as GovernanceRequest[]
  } catch {
    return []
  }
}

function saveQueue(dir: string, queue: GovernanceRequest[]): void {
  const p = queuePath(dir)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(queue.slice(-MAX_REQUESTS), null, 2))
}

// Submit a new infrastructure request. Returns the request id.
export function submitRequest(
  dir: string,
  req: Omit<GovernanceRequest, 'id' | 'status' | 'createdAt'>
): string {
  const queue = loadQueue(dir)
  const id = `gov-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const entry: GovernanceRequest = { ...req, id, status: 'pending', createdAt: Date.now() }
  queue.push(entry)
  saveQueue(dir, queue)
  debugBus.emit('pipeline', 'governance_request_submitted', { id, category: req.category, title: req.title }, { severity: 'info' })
  return id
}

// Approve a pending request. Returns the approved request (N2 can consume payload).
export function approveRequest(dir: string, id: string): GovernanceRequest | null {
  const queue = loadQueue(dir)
  const idx = queue.findIndex(r => r.id === id)
  if (idx === -1) return null
  const req = queue[idx]
  if (req.status !== 'pending') return null
  req.status = 'approved'
  req.decidedAt = Date.now()
  req.decidedBy = 'user'
  queue[idx] = req
  saveQueue(dir, queue)
  debugBus.emit('pipeline', 'governance_request_approved', { id, category: req.category }, { severity: 'success' })
  return req
}

// Reject a pending request.
export function rejectRequest(dir: string, id: string): GovernanceRequest | null {
  const queue = loadQueue(dir)
  const idx = queue.findIndex(r => r.id === id)
  if (idx === -1) return null
  const req = queue[idx]
  if (req.status !== 'pending') return null
  req.status = 'rejected'
  req.decidedAt = Date.now()
  req.decidedBy = 'user'
  queue[idx] = req
  saveQueue(dir, queue)
  debugBus.emit('pipeline', 'governance_request_rejected', { id, category: req.category }, { severity: 'warn' })
  return req
}

export function getPendingRequests(dir: string): GovernanceRequest[] {
  return loadQueue(dir).filter(r => r.status === 'pending')
}

export function getAllRequests(dir: string): GovernanceRequest[] {
  return loadQueue(dir)
}

export function getRequest(dir: string, id: string): GovernanceRequest | null {
  return loadQueue(dir).find(r => r.id === id) ?? null
}
