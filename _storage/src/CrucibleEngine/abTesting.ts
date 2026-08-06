// A/B testing infrastructure — shadow-mode pipeline experiments.
// Every pipeline change can be tested by assigning a random cohort of queries
// to the "treatment" config and measuring score differences vs the control.
// Promotes automatically at p<0.05 and effect>0.03; reverts at p<0.1 degradation.

import fs from 'fs'
import path from 'path'

export interface ABExperiment {
  id: string
  name: string
  description: string
  treatmentRate: number   // 0–1 fraction of queries that get treatment
  startedAt: number
  status: 'running' | 'promoted' | 'reverted' | 'inconclusive'
  config: Record<string, any>  // arbitrary treatment config blob
}

export interface ABObservation {
  experimentId: string
  cohort: 'control' | 'treatment'
  score: number
  ts: number
}

const abFile   = (dir: string) => path.join(dir, '.crucible', 'ab-experiments.json')
const obsFile  = (dir: string) => path.join(dir, '.crucible', 'ab-observations.json')

function ensureDir(f: string) { fs.mkdirSync(path.dirname(f), { recursive: true }) }

export function loadExperiments(dir: string): ABExperiment[] {
  try { return JSON.parse(fs.readFileSync(abFile(dir), 'utf8')) } catch { return [] }
}

export function saveExperiments(dir: string, exps: ABExperiment[]) {
  ensureDir(abFile(dir))
  fs.writeFileSync(abFile(dir), JSON.stringify(exps, null, 2))
}

export function loadObservations(dir: string): ABObservation[] {
  try { return JSON.parse(fs.readFileSync(obsFile(dir), 'utf8')) } catch { return [] }
}

function saveObservations(dir: string, obs: ABObservation[]) {
  ensureDir(obsFile(dir))
  fs.writeFileSync(obsFile(dir), JSON.stringify(obs, null, 2))
}

// Welch's t-test — returns p-value (two-tailed)
function welchT(a: number[], b: number[]): number {
  if (a.length < 5 || b.length < 5) return 1
  const mean = (arr: number[]) => arr.reduce((s, x) => s + x, 0) / arr.length
  const vari = (arr: number[], m: number) => arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1)
  const ma = mean(a), mb = mean(b)
  const va = vari(a, ma), vb = vari(b, mb)
  const se = Math.sqrt(va / a.length + vb / b.length)
  if (se === 0) return ma === mb ? 1 : 0
  const t = Math.abs((ma - mb) / se)
  // Approximate p-value via t-distribution (df via Welch–Satterthwaite)
  const df = (va / a.length + vb / b.length) ** 2 /
    ((va / a.length) ** 2 / (a.length - 1) + (vb / b.length) ** 2 / (b.length - 1))
  // p approximation for large df: use normal distribution approximation
  const x = df / (df + t * t)
  const p = Math.max(0.001, Math.min(1, x ** (df / 2) * (1 + t * t / df)))
  return p
}

export function recordObservation(dir: string, experimentId: string, cohort: 'control' | 'treatment', score: number) {
  const obs = loadObservations(dir)
  obs.push({ experimentId, cohort, score, ts: Date.now() })
  // Cap at 2000 observations total
  if (obs.length > 2000) obs.splice(0, obs.length - 2000)
  saveObservations(dir, obs)
}

export function getExperimentStats(dir: string, experimentId: string) {
  const obs = loadObservations(dir).filter(o => o.experimentId === experimentId)
  const control   = obs.filter(o => o.cohort === 'control').map(o => o.score)
  const treatment = obs.filter(o => o.cohort === 'treatment').map(o => o.score)
  const meanC = control.length   ? control.reduce((s, x)   => s + x, 0) / control.length   : 0
  const meanT = treatment.length ? treatment.reduce((s, x) => s + x, 0) / treatment.length : 0
  const p = welchT(control, treatment)
  const effect = meanT - meanC
  return { controlN: control.length, treatmentN: treatment.length, meanC, meanT, effect, p }
}

// Assign a query to a cohort. Deterministic per requestId so retries stay in the same cohort.
export function assignCohort(exp: ABExperiment, requestId: string): 'control' | 'treatment' {
  // Simple hash: sum char codes mod 100, compare to treatmentRate
  const h = requestId.split('').reduce((s, c) => s + c.charCodeAt(0), 0) % 100
  return h < exp.treatmentRate * 100 ? 'treatment' : 'control'
}

// Check all running experiments and auto-promote/revert based on stats
export function runAutoDecisions(dir: string): void {
  const exps = loadExperiments(dir)
  let changed = false
  for (const exp of exps) {
    if (exp.status !== 'running') continue
    const stats = getExperimentStats(dir, exp.id)
    if (stats.controlN < 30 || stats.treatmentN < 30) continue  // not enough data
    if (stats.p < 0.05 && stats.effect > 0.03) {
      exp.status = 'promoted'
      console.log(`[A/B] PROMOTED: ${exp.name} — effect +${stats.effect.toFixed(3)}, p=${stats.p.toFixed(3)}`)
      changed = true
    } else if (stats.p < 0.10 && stats.effect < -0.03) {
      exp.status = 'reverted'
      console.log(`[A/B] REVERTED: ${exp.name} — effect ${stats.effect.toFixed(3)}, p=${stats.p.toFixed(3)}`)
      changed = true
    }
  }
  if (changed) saveExperiments(dir, exps)
}

export function createExperiment(dir: string, exp: Omit<ABExperiment, 'startedAt' | 'status'>): ABExperiment {
  const full: ABExperiment = { ...exp, startedAt: Date.now(), status: 'running' }
  const exps = loadExperiments(dir)
  exps.push(full)
  saveExperiments(dir, exps)
  return full
}

export function getActiveExperiments(dir: string): ABExperiment[] {
  return loadExperiments(dir).filter(e => e.status === 'running')
}
