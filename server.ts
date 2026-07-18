import dotenv from 'dotenv'
dotenv.config({ path: process.env.CRUCIBLE_ENV_PATH || '.env.local' })
import express from 'express'
import cors from 'cors'
import compression from 'compression'
import Groq from 'groq-sdk'
import { Mistral } from '@mistralai/mistralai'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { evaluateIteration, DEFAULT_SCORING_CONFIG, generateContract, getAspectContext } from './src/CrucibleEngine/index'
import { buildWorldContext } from './src/CrucibleEngine/state/world'
import type { InterfaceContract } from './src/CrucibleEngine/index'
import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { classifyPrompt, regexClassify, selectModels, recordProviderCall, recordModelFailure, getModelFailureCount, PIPELINE_CONFIG, SIMPLE_PIPELINE_CONFIG, getModelEntry, scoreComplexity, tripCircuitBreaker, resetCircuitBreaker, getCircuitState, parseRetryDelay, circuitBreakers, allProviderLoads, recordSpecialization, getSpecializationWeights, learnClassification, classifierStats, recordModelOutcome, pickStandby, substrateReport, lastModelCall, viabilitySnapshot, predictProviderLoad, providerHealthSnapshot, registerFineTunedModel, providerHasKey, enterByokKeys, resolveProviderKey, currentByokKeys } from './modelRegistry'
import type { SelectedModel } from './modelRegistry'
import { createServer } from 'http'
import { WebSocketServer as WsServer } from 'ws'
import webpush from 'web-push'
import { buildIndex, queryIndex, getIndexStats } from './src/CrucibleEngine/rag-context'
import { createCheckpoint, rollbackToCheckpoint, getCheckpoints } from './src/CrucibleEngine/checkpoint'
import { registry } from './src/CrucibleEngine/tools/registry'
import { resolveLocalIntent, runLocalPlan } from './src/CrucibleEngine/agent/localIntentRouter'
import { answerCountingQuery } from './src/CrucibleEngine/countingVerifier'
import { verifyAndRepair } from './src/CrucibleEngine/baselineVerify'
import { localFmPlan, runFmPlan } from './src/CrucibleEngine/agent/localFmPlanner'
import { corpusFirstAnswer } from './src/CrucibleEngine/corpus/corpusFirst'
import { fenceProtocolPrompt, parseFenceToolCall } from './src/CrucibleEngine/tools/protocol'
import type { ToolCtx } from './src/CrucibleEngine/tools/protocol'
import { runAgentLoop } from './src/CrucibleEngine/agent/loop'
import { classifyIntent } from './src/CrucibleEngine/agent/intentClassifier'
import { getOrCreateSession, getSession, startTask, completeTask, abortCurrentTask, buildTaskContext, getSessionMessages } from './src/CrucibleEngine/agent/taskSession'
import { makeVerifier, detectCheck } from './src/CrucibleEngine/agent/verify'
import { foldAttachmentContext } from './src/CrucibleEngine/agent/attachmentContext'
import { synthesizePureCode } from './src/CrucibleEngine/synth/pureCode'
import { nativeDriveTurn, driverComplete, currentDriverLabel } from './src/CrucibleEngine/agent/driver'
import { makeOfflineDriveTurn, withOfflineFallback, solveNonCodeTurn } from './src/CrucibleEngine/agent/synthDriver'
import { answerQuery } from './src/CrucibleEngine/answer/answerEngine'
import { clarifyBuild } from './src/CrucibleEngine/answer/conversational'
import { resolveBuildTurn } from './src/CrucibleEngine/answer/buildNegotiation'
import { solveCodingRequest } from './src/CrucibleEngine/reasoning/solve'
import { selectBestEffort } from './src/CrucibleEngine/reasoning/keepK'
import type { Attempt } from './src/CrucibleEngine/reasoning/types'
import { retrieveForTask as retrieveCodeRefs } from './src/CrucibleEngine/retrieval/retrievalLayer'
import { detectPruneImportsAll, detectRename, detectTargetPath, extractPastedCode, isModifyRequest, planEmit, planEmitTree } from './src/CrucibleEngine/reasoning/emitPlan'
import { planRefactor } from './src/server/refactorRoutes'
import { signJwt as signJwtCore, verifyJwt as verifyJwtCore, parseCookies } from './src/server/jwt'
import { vectorize, cosineSim } from './src/server/textVector'
import { LatencyTracker } from './src/server/latency'
import { withTimeout, estimateMessageTokens, conversationTitle } from './src/server/util'
import { verifyMultiFileCode } from './src/CrucibleEngine/reasoning/codeVerifier'
import { detectRequestedFiles as detectRequestedFilesMF, isMultiFileRequest, mergeCertifiedFileSet, solveMultiFileRequest } from './src/CrucibleEngine/reasoning/multiFile'
import { enqueueFm, fmQueueStats, beginForeground, endForeground, isForegroundActive } from './src/CrucibleEngine/agent/fmQueue'
import { detectConversationalClarify } from './src/CrucibleEngine/conversationalClarify'
import { fmComplete, checkFmAvailable as fmAvailable } from './src/CrucibleEngine/agent/fmReact'
import { isDesktopActionGoal } from './src/CrucibleEngine/ambiguity'
import { needsPlan, runPlannedTask } from './src/CrucibleEngine/agent/planner'
import { defaultSystemPreamble } from './src/CrucibleEngine/agent/loop'
import { extractSubtasks, decompose } from './src/CrucibleEngine/goalDecomposer'
import { createGraph, getOpenGraphs, setGraphStatus, buildOpenGoalsContext } from './src/CrucibleEngine/taskGraph'
import { runResearchSession } from './src/CrucibleEngine/researchMode'
import { runResearchDag } from './src/CrucibleEngine/research/researchDag'
import { listModelStatuses, downloadModel, deleteModel, setModelEnabled, setModelsLocation, getModelsConfig, setFireAllMode, setPinnedModelId } from './src/CrucibleEngine/agent/modelDownloadManager'
import { isGgufRuntimeAvailable } from './src/CrucibleEngine/agent/localModelPool'
import { voiceStatus, transcribeAudio } from './src/CrucibleEngine/agent/voiceTranscribe'
import { routeLocalModelQuery, hasReadyLocalModels, councilPeers } from './src/CrucibleEngine/agent/localModelRouter'
import { runDebate } from './src/CrucibleEngine/agent/debate'
import { classifyDomain } from './src/CrucibleEngine/agent/localModelCatalog'
import { getStats } from './src/CrucibleEngine/localModels/telemetry'
import { read_pdf } from './src/CrucibleEngine/tools/visionTools'
import { runLearningCycle } from './src/CrucibleEngine/corpus/routingLearner'
import { DOMAIN_SHARDS } from './src/CrucibleEngine/corpus/db'
import { runSelfPlayCycle } from './src/CrucibleEngine/selfPlay'
import { speak } from './src/CrucibleEngine/tts'
import { runMetaRouter, consult } from './src/CrucibleEngine/agent/metaRouter'
import { runRsiCycle, rsiStatus, setRsiEnabled, type RsiDeps } from './src/CrucibleEngine/rsi/controller'
import { selfRepairStatus, buildCycleProposal, resolveProposal, recordProposalOutcome, setAutoApprove, isAutoApproveEnabled, listProposals } from './src/CrucibleEngine/rsi/proposals'
import { assessStakes } from './src/CrucibleEngine/agent/stakesRouter'
import { buildArchetypeTools, selectArchetype, type ArchetypeId } from './src/CrucibleEngine/agent/archetypes'
import { detectConversational, buildConversationalFallback, applyVoiceLayer } from './src/CrucibleEngine/conversationalMode'
import { readScratch } from './src/CrucibleEngine/agent/taskScratchpad'
import { approveGlobalGraduation } from './src/CrucibleEngine/tools/dynamicTools'
import { saveTokens, googleServicesStatus, GOOGLE_SCOPES } from './src/CrucibleEngine/tools/googleApis'
import { latestResumable, saveSession, newSessionId, readMemoryDigest, appendMemory, readGlobalMemoryDigest, globalMemoryFile } from './src/CrucibleEngine/state/session'
import { buildCodebaseContext, indexStats, ensureIndex, reindexFiles, searchIndex } from './src/CrucibleEngine/state/codebaseIndex'
import { loadDynamicToolsInto, dynamicToolStats } from './src/CrucibleEngine/tools/dynamicTools'
import SKILL_CATALOG from './src/CrucibleEngine/synth/catalogIndex'
import { buildUserSkill, type UserSkillStage } from './src/CrucibleEngine/synth/userSkillPipeline'
import { listIntegrations, setIntegrationEnabled, addCustomIntegration, removeIntegration, recommendIntegrations } from './src/CrucibleEngine/integrations/registry'
import { registerIntegrationTools, cliToolForEntry } from './src/CrucibleEngine/integrations/tools'
import { identifyGoals, loadGoalReport, saveGoalReport } from './src/CrucibleEngine/goalEngine'
import { metaLearningStatus } from './src/CrucibleEngine/triumvirate'
import { writeCheckpoint, clearCheckpoint, readCheckpoint, findAllCheckpoints, sweepStaleCheckpoints } from './src/CrucibleEngine/state/checkpoint'
import { Pool } from 'pg'

// ── Postgres connection pool (cloud) / JSON file fallback (local dev) ─────────
const pgPool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null

async function initPg(): Promise<void> {
  if (!pgPool) return
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `)
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS history (
      id SERIAL PRIMARY KEY,
      user_id TEXT,
      ts BIGINT NOT NULL,
      data JSONB NOT NULL
    )
  `)
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      user_id TEXT NOT NULL,
      endpoint TEXT PRIMARY KEY,
      sub JSONB NOT NULL
    )
  `)
  console.log('[Postgres] Schema ready')
}

// ── History helpers — Postgres when DATABASE_URL set, JSON file otherwise ─────
function _historyFilePath(userId: string | null): string {
  return userId
    ? path.join(process.cwd(), '.crucible', `history-${userId}.json`)
    : path.join(process.cwd(), '.crucible', 'history-default.json')
}

async function historyLoad(userId: string | null, limit = 200): Promise<any[]> {
  if (pgPool) {
    const r = await pgPool.query(
      'SELECT data FROM history WHERE user_id IS NOT DISTINCT FROM $1 ORDER BY ts DESC LIMIT $2',
      [userId, limit]
    )
    return r.rows.map((row: any) => row.data)
  }
  try { return JSON.parse(fs.readFileSync(_historyFilePath(userId), 'utf8')) } catch { return [] }
}

function historyPush(userId: string | null, entry: any): void {
  if (pgPool) {
    pgPool.query('INSERT INTO history (user_id, ts, data) VALUES ($1, $2, $3)',
      [userId, entry.ts, JSON.stringify(entry)])
      .catch((e: any) => console.error('[History] Postgres write failed:', e.message))
    return
  }
  try {
    const file = _historyFilePath(userId)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    let sessions: any[] = []
    try { sessions = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
    sessions.push(entry)
    if (sessions.length > 200) sessions = sessions.slice(-200)
    fs.writeFileSync(file, JSON.stringify(sessions, null, 2))
  } catch (e: any) { console.error('[History] File write failed:', e.message) }
}

// ── Chat conversations store ──────────────────────────────────────────────────
// A "conversation" is a whole chat thread (many rounds), grouped under one id —
// the ChatGPT/Claude model. Refresh starts a NEW conversation; prior ones live here,
// searchable and reopenable. Distinct from history-*.json (loose per-round analytics
// rows) and active-session-*.json (the legacy single-session resume blob).
const MAX_CONVERSATIONS = 100
function _conversationsFilePath(userId: string | null): string {
  return path.join(process.cwd(), '.crucible', `conversations-${userId ?? 'anon'}.json`)
}
function loadConversations(userId: string | null): any[] {
  try { return JSON.parse(fs.readFileSync(_conversationsFilePath(userId), 'utf8')) } catch { return [] }
}
// conversationTitle lives in src/server/util.ts (unit-testable).
// Upsert a conversation by id. Empty (no rounds) conversations are ignored so a bare
// refresh never litters the history with blank entries.
function saveConversationEntry(userId: string | null, conv: { id: string; mode?: string; rounds: any[] }): void {
  if (!conv?.id || !Array.isArray(conv.rounds) || conv.rounds.length === 0) return
  try {
    const file = _conversationsFilePath(userId)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const list = loadConversations(userId)
    const now = Date.now()
    const idx = list.findIndex(c => c.id === conv.id)
    const startedAt = idx >= 0 ? (list[idx].startedAt ?? now) : now
    const entry = { id: conv.id, title: conversationTitle(conv.rounds), mode: conv.mode ?? 'quorum', rounds: conv.rounds, startedAt, updatedAt: now }
    if (idx >= 0) list[idx] = entry; else list.push(entry)
    list.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    fs.writeFileSync(file, JSON.stringify(list.slice(0, MAX_CONVERSATIONS), null, 2))
  } catch (e: any) { console.error('[Conversations] write failed:', e.message) }
}
function getConversationById(userId: string | null, id: string): any | null {
  return loadConversations(userId).find(c => c.id === id) ?? null
}
function deleteConversationById(userId: string | null, id: string): void {
  try {
    const file = _conversationsFilePath(userId)
    const list = loadConversations(userId).filter(c => c.id !== id)
    fs.writeFileSync(file, JSON.stringify(list, null, 2))
  } catch (e: any) { console.error('[Conversations] delete failed:', e.message) }
}
// roundId → conversationId, registered at request start so the server-authoritative
// completion patch can write the finished answer into the right conversation even if
// the client disconnected mid-stream.
const roundConversation = new Map<string, string>()

// ── KEEP-K draft carry-forward ────────────────────────────────────────────────────────
// A best-effort draft (VGR could not certify, so it was SHOWN but deliberately not written
// to any file) would otherwise be lost the moment the turn ends: repairSeed only reads the
// named target file or code pasted into the CURRENT message, and a draft is neither. So the
// draft's own "tell me to keep going and I'll iterate" would be a promise the server cannot
// keep, and the next turn would restart from zero — re-deriving a near-miss it already had.
// Stashing it makes the near-miss the next turn's repair seed, which is exactly the
// failing-case-evidence mechanism that lifted fault:live recovery in cont.78.
// Keyed per user+project so one user's draft can never seed another's request.
// The GOAL is stashed with the code and matters as much: the spec + acceptance cases are parsed
// out of the message text, so a bare "keep going" would give solveCodingRequest nothing to verify
// against and it would abstain instantly. Resuming means re-running the ORIGINAL goal with the
// draft as the repair seed.
const lastVgrDraft = new Map<string, { code: string; goal: string; ts: number }>()
const DRAFT_TTL_MS = 30 * 60 * 1000
const MAX_DRAFTS = 200
const draftKey = (userId: string | null | undefined, projectPath: string) => `${userId ?? 'anon'}::${projectPath}`
function stashVgrDraft(userId: string | null | undefined, projectPath: string, code: string, goal: string) {
  if (lastVgrDraft.size >= MAX_DRAFTS) {
    // Evict the oldest — bounded memory; this is a convenience cache, never a source of truth.
    const oldest = [...lastVgrDraft.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]
    if (oldest) lastVgrDraft.delete(oldest[0])
  }
  lastVgrDraft.set(draftKey(userId, projectPath), { code, goal, ts: Date.now() })
}
function takeVgrDraft(userId: string | null | undefined, projectPath: string): { code: string; goal: string } | null {
  const k = draftKey(userId, projectPath)
  const hit = lastVgrDraft.get(k)
  if (!hit) return null
  lastVgrDraft.delete(k)   // single-use: a stale draft must never silently seed a later, unrelated task
  if (Date.now() - hit.ts > DRAFT_TTL_MS) return null
  return { code: hit.code, goal: hit.goal }
}
/** Non-consuming check — used by the VGR routing gate, which must not eat the draft. */
function hasPendingVgrDraft(userId: string | null | undefined, projectPath: string): boolean {
  const hit = lastVgrDraft.get(draftKey(userId, projectPath))
  return !!hit && Date.now() - hit.ts <= DRAFT_TTL_MS
}
function patchConversationRound(userId: string | null, conversationId: string, roundId: string, patch: Record<string, unknown>): void {
  if (!conversationId || !roundId) return
  try {
    const list = loadConversations(userId)
    const conv = list.find(c => c.id === conversationId)
    if (!conv || !Array.isArray(conv.rounds)) return
    const ri = conv.rounds.findIndex((r: any) => r && r.id === roundId)
    if (ri < 0) return
    conv.rounds[ri] = { ...conv.rounds[ri], ...patch }
    conv.updatedAt = Date.now()
    fs.writeFileSync(_conversationsFilePath(userId), JSON.stringify(list, null, 2))
  } catch (e: any) { console.error('[Conversations] patch failed:', e.message) }
}

const CIRCUIT_STATE_FILE = path.join(process.cwd(), '.circuit-state.json')

// ── Build/version stamp ───────────────────────────────────────────────────────
// So you can VERIFY which code the running server actually has — the #1 confusion today
// was "git is updated but the long-lived tsx process still runs old code." Surfaced at
// /api/version and in /api/diag as `version`, and logged once at boot. Reads git at startup;
// degrades to 'unknown' without failing if git isn't available (packaged build). (execSync is
// imported at the bottom of this file; ESM hoists top-level imports so it's available here.)
const BUILD_INFO = (() => {
  const bootedAt = new Date().toISOString()
  try {
    const g = (cmd: string) => execSync(cmd, { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return {
      commit: g('git rev-parse --short HEAD'),
      subject: g('git log -1 --pretty=%s'),
      committedAt: g('git log -1 --pretty=%cI'),
      dirty: g('git status --porcelain').length > 0,
      bootedAt,
    }
  } catch {
    return { commit: 'unknown', subject: '', committedAt: '', dirty: false, bootedAt }
  }
})()
console.log(`[Crucible] running commit ${BUILD_INFO.commit}${BUILD_INFO.dirty ? '+dirty' : ''} — "${BUILD_INFO.subject}" (booted ${BUILD_INFO.bootedAt})`)

// ── Keepalive pause guard ─────────────────────────────────────────────────────
// Incremented on pipeline entry, decremented in finally. Keepalive pings skip
// all model calls when > 0 to avoid consuming quota during live requests.
let activePipelineRequests = 0

// ── Desktop workspace slug ────────────────────────────────────────────────────
const SLUG_WORDS = [
  'able','amber','arc','aria','ask','atlas','august','axle','bay','beam',
  'birch','blaze','bolt','boreal','branch','brine','brook','calm','cedar','chalk',
  'cinder','civic','clan','clear','cliff','cloud','coal','coast','code','coil',
  'colt','coral','core','crest','crisp','crop','cross','crown','crust','current',
  'curve','dark','dawn','deep','delta','dense','depot','draft','drift','dune',
  'dusk','dust','echo','edge','elm','ember','epoch','even','fern','field',
  'firm','flair','flame','flat','fleet','flint','flora','flow','foam','fold',
  'ford','forge','form','fort','front','frost','gale','glow','gold','grain',
  'grand','grant','gust','haven','haze','hemp','hill','hive','hold','hollow',
  'horn','hull','hurl','iron','isle','jade','keen','kite','knob','lake',
  'lamp','lance','lark','lath','lava','leaf','leap','ledge','lend','lift',
  'lime','link','loft','loop','lure','mare','mark','marsh','mast','maze',
  'mesa','mild','mill','mint','mist','mode','mold','moor','moss','mount',
  'nave','nest','node','noon','norm','note','nova','opal','orb','ore',
  'oval','pact','pale','palm','park','path','peak','pine','pipe','plain',
  'plume','point','pool','port','post','prime','prism','probe','pulse','pure',
  'quest','rack','rail','rain','ramp','range','rapid','reef','relay','ridge',
  'rift','rime','ring','rink','rise','rive','road','roan','rock','roll',
  'roof','root','rope','rose','route','rune','rush','sage','sail','salt',
  'sand','seal','seed','seep','shelf','shore','silt','skip','slate','sleet',
  'slope','smoke','snow','soil','solar','solid','span','spark','spire','split',
  'spoke','spray','sprint','spun','stack','staff','stag','stake','stalk','stamp',
  'star','stark','stem','step','stern','stone','storm','strand','stream','strict',
  'strip','strong','sum','surge','swift','swirl','tack','tale','tall','tame',
  'tang','tarn','teal','tide','tile','tilt','timber','tip','titan','toll',
  'tone','track','trail','trait','tram','trend','trove','trunk','tuft','tune',
  'tusk','vale','vane','vast','vault','vein','vent','verdant','verge','view',
  'vigor','vine','vista','void','volt','wade','wake','ward','warm','wave',
  'way','weld','well','west','whirl','wide','wild','wind','wire','wood',
  'word','worn','wren','yard','yoke','zeal','zinc','zone',
]
function generateSlug(): string {
  const pick = () => SLUG_WORDS[Math.floor(Math.random() * SLUG_WORDS.length)]
  return `${pick()}-${pick()}-${pick()}-${pick()}`
}
function newDesktopProjectPath(): string {
  const base = path.join(process.env.HOME ?? '/Users/' + process.env.USER, 'Desktop', 'Crucible')
  const slug = generateSlug()
  return path.join(base, slug)
}

function loadCircuitState() {
  try {
    if (fs.existsSync(CIRCUIT_STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CIRCUIT_STATE_FILE, 'utf-8'))
      const now = Date.now()
      for (const [id, cb] of Object.entries(parsed) as [string, any][]) {
        if (cb.failReason !== 'decommissioned' && now - cb.trippedAt >= cb.cooldownMs) continue
        circuitBreakers[id] = cb
      }
      console.log(`[Circuit] Loaded ${Object.keys(circuitBreakers).length} persisted state(s)`)
    }
  } catch (e) { console.warn('[Circuit] Failed to load state:', e) }
}

export function saveCircuitState() {
  try {
    fs.writeFileSync(CIRCUIT_STATE_FILE, JSON.stringify(circuitBreakers, null, 2))
  } catch (e) { console.warn('[Circuit] Failed to save state:', e) }
}

loadCircuitState()
import { exec, execFile, spawn } from 'child_process'
import { prewarmPython, shutdownSandbox } from './src/CrucibleEngine/sandbox'
import { debugBus } from './src/CrucibleEngine/debug/bus'
import { debugAnalyzer } from './src/CrucibleEngine/debug/analyzer'
import { qualityPredictor } from './src/CrucibleEngine/qualityPredictor'
import { init as autoImproveInit, triggerImprovementPass, rollbackIfDegraded, status as autoImproveStatus, loadLearnedWeights, setCallModel as autoImproveSetCallModel } from './src/CrucibleEngine/autoImprove'
import { loadTriumvirateLog, loadPendingQueue } from './src/CrucibleEngine/triumvirate'
import { createExperiment, getActiveExperiments, assignCohort, recordObservation, runAutoDecisions, getExperimentStats, loadExperiments } from './src/CrucibleEngine/abTesting'
import { buildEpisodeContext, summariseSession, loadEpisodes } from './src/CrucibleEngine/episodicMemory'
import { loadBenchmarks, runBenchmarkSuite, loadRuns } from './src/CrucibleEngine/benchmarks'
import { domainVerify, correctArithmeticCascade, verifyCodeBlocks, relabelMislabeledJsFences, crossGrammarRelabel, fenceUnfencedCode, detectNoDependencyConstraint, findExternalImports } from './src/CrucibleEngine/domainVerifiers'
import { verifyPlainCodeByExecution } from './src/CrucibleEngine/reasoning/executionVerify'
import { verifyAnswerContract, contractRepairSpec, replaceAnswerCodeBlocks, detectContract, contractAskHint } from './src/CrucibleEngine/reasoning/contractVerify'
import { isCodingQuery } from './src/CrucibleEngine/retrieval/retrievalLayer'
import { bonsaiComplete, isBonsaiInstalled, repairModelName } from './src/CrucibleEngine/localModels/bonsaiSidecar'
import { assessCollabMode, buildClarifyResponse } from './src/CrucibleEngine/collaborationGradient'
import { recordRoundContributions, evaluateRoster, getModelsReadyForReprobe, promoteFromBench } from './src/CrucibleEngine/rosterRotation'
import { runSelfPatcher, loadPatches, rejectPatch } from './src/CrucibleEngine/selfPatcher'
import { buildFailureTaxonomy, loadTaxonomy } from './src/CrucibleEngine/failureTaxonomy'
import { recordRound as recordStageWeightRound, getStageWeightSummary, getStageMultipliers } from './src/CrucibleEngine/stageWeightLearner'
import { getForcedModels, applyForcedSlots, recordPipelineRun, recordForcedCall } from './src/CrucibleEngine/specializationForcing'
import { enqueueModel, updateWaitlistScores, promoteNextFromWaitlist, getProbationIds, recordProbationOutcome, waitlistStatus } from './src/CrucibleEngine/waitlistManager'
import { distillRound, getDistillationContext } from './src/CrucibleEngine/knowledgeDistillation'
import { buildGraphDigest, loadGraph, expireStaleEntities } from './src/CrucibleEngine/entityGraph'
import { applyWorldDiff, loadContradictionLog } from './src/CrucibleEngine/worldModelDiff'
import { detectGapsFromRound, listGaps, resolveGap } from './src/CrucibleEngine/knowledgeGapQueue'
import { readSynthesis, getSynthesisIndex, recordSessionForCluster, writeSynthesis } from './src/CrucibleEngine/knowledgeSynthesis'
import { buildDecisionContext } from './src/CrucibleEngine/decisionMemory'
import { recordFeedback as recordPreferenceFeedback, getPreferenceSummary } from './src/CrucibleEngine/preferenceModel'
import { detectEmergentClusters, loadClusters } from './src/CrucibleEngine/specializationDetector'
import { lookupUncertainty, recordCalibrationForQuery, getSurface } from './src/CrucibleEngine/uncertaintySurface'
import { checkAmbientContext } from './src/CrucibleEngine/ambientWatcher'
import { submitRequest, approveRequest, rejectRequest, getPendingRequests, getAllRequests } from './src/CrucibleEngine/governanceQueue'
import { runApprovedProvisioningRequests, getProvisioningLog } from './src/CrucibleEngine/autonomousProvisioner'
import { getDomainContext, ingestIntoDomainStore, getDomainStoreIndex } from './src/CrucibleEngine/domainRouter'
import { buildAdaptationContext } from './src/CrucibleEngine/behavioralAdaptation'
import { getLongHorizonContext, extendHorizonPlan, getHorizonPlan } from './src/CrucibleEngine/longHorizonPlanner'
import { buildCausalDigest, enrichAndRecord } from './src/CrucibleEngine/causalMemory'
import { scanForContradictions, buildContradictionWarning, recordSessionConclusions } from './src/CrucibleEngine/crossSessionContradiction'
import { recordRoundScore as recordArcScore } from './src/CrucibleEngine/sessionQualityArc'
import { daemonTick, loadDaemonState } from './src/CrucibleEngine/improvementDaemon'
import { CF_TYPES, runCounterfactual, loadCounterfactuals } from './src/CrucibleEngine/counterfactualBranch'
import { isTimeDependent, groundQuery, buildGroundingBlock } from './src/CrucibleEngine/webGrounding'
import { groundAcademic, buildAcademicBlock } from './src/CrucibleEngine/academicRetrieval'
import { assignSpecialistRoles, buildRoleAddendum } from './src/CrucibleEngine/specialistRoles'
import { generateScaffold, buildScaffoldBlock } from './src/CrucibleEngine/reasoningEngine'
import { calibrate, getFragilityAssumption } from './src/CrucibleEngine/confidenceCalibrator'
import { shouldRunTrace, extractFirstCodeBlock, buildTraceBlock } from './src/CrucibleEngine/executionTrace'
import { runHypothesisTest, shouldRunHypothesis } from './src/CrucibleEngine/hypothesisTester'
import { scheduleMetaTask, loadMetaTask, loadMetaTaskResult, clearMetaTask, appendMetaLog, saveMetaTask } from './src/CrucibleEngine/metaPipeline'
import { buildSFTDataset, buildDPODataset, exportSFTJsonl, exportDPOJsonl, submitFineTuneJob, loadFineTuneJobs, buildHardNegativeDataset, flagHardNegative, buildDisagreementDataset, getFineTunedModelId, buildAdversarialPairs, buildCalibrationDataset, exportCalibrationJsonl } from './src/CrucibleEngine/fineTuning'
import { getAnchor } from './src/CrucibleEngine/contextAnchor'
import { runMasterpieceLight, runMasterpieceDeep, renderLightEnrichment, warmCorpus } from './src/CrucibleEngine/masterpiece/orchestrator'
import { evaluateGate } from './src/CrucibleEngine/masterpiece/gate'
import type { EnrichedContext } from './src/CrucibleEngine/masterpiece/types'
import { runAnimaShaping, runAnimaLearning, renderShapingBlock, isTransparencyQuery, buildTransparencyReport, animaStore } from './src/CrucibleEngine/anima/index'
import type { AnimaShaping } from './src/CrucibleEngine/anima/index'

// ── Exact response cache ──────────────────────────────────────────────────────
interface CachedRound {
  events: object[]
  timestamp: number
  message: string
  vec: Map<string, number>  // content-word term-frequency vector for semantic matching
}
const responseCache = new Map<string, CachedRound>()
const CACHE_TTL_MS = 60 * 60 * 1000   // 1 hour
const CACHE_MAX    = 200

// ── Diagnostics session state — one-call full-system snapshot (/api/diag) ─────
// All counters are SESSION-scoped (reset on server restart). Persistent stats
// come from their own stores; this object only holds what has no other home.
const SESSION_START = Date.now()
let CORPUS_CHUNK_BASELINE: number | null = null   // captured on first /api/diag
const diag = {
  requestsThisSession: 0,
  cacheHits: 0,
  qualityScores: [] as number[],
  lastRequest: null as null | { prompt: string; mode: string; durationMs: number; finalScore: number },
  hotSwapsThisSession: 0,
  lastSelection: null as null | { id: string; provider: string; label: string }[],
  lastDiversityScore: 0,
  lightFiredThisSession: 0,
  deepFiredThisSession: 0,
  lightWithHits: 0,
  noveltyScores: [] as number[],
  lastGateDecision: null as null | { mode: string; reason: string; conditions: Record<string, unknown> },
  animaShapingApplied: 0,
  lastValence: null as null | { score: number; dominant: string; confidence: number },
}

function cacheKey(message: string): string {
  return message.trim().toLowerCase()
}

// ── Semantic cache ───────────────────────────────────────────────────────────
// When the exact-match cache misses, we look for a *paraphrase* of a prior query.
// Similarity is a local, instant content-word token-cosine (no premium model — true
// to the free-tier philosophy). A high threshold keeps it precise: a single differing
// key noun ("reverse a string" vs "reverse a list") drops cosine below the bar. The
// vec/cosine pair is deliberately isolated so a real embedding backend can swap in later.
const SEMANTIC_THRESHOLD = 0.82
// stem / vectorize / cosineSim live in src/server/textVector.ts (unit-testable, pure).

// Returns the best paraphrase match above threshold, or null.
function semanticLookup(message: string): { entry: CachedRound; sim: number } | null {
  const qv = vectorize(message)
  if (qv.size === 0) return null
  let best: { entry: CachedRound; sim: number } | null = null
  const now = Date.now()
  for (const entry of responseCache.values()) {
    if (now - entry.timestamp >= CACHE_TTL_MS) continue
    const sim = cosineSim(qv, entry.vec)
    if (sim >= SEMANTIC_THRESHOLD && (!best || sim > best.sim)) best = { entry, sim }
  }
  return best
}

function pruneCache() {
  const now = Date.now()
  for (const [k, v] of responseCache) {
    if (now - v.timestamp > CACHE_TTL_MS) responseCache.delete(k)
  }
  if (responseCache.size > CACHE_MAX) {
    const oldest = [...responseCache.entries()]
      .sort((a, b) => a[1].timestamp - b[1].timestamp)
      .slice(0, responseCache.size - CACHE_MAX)
    for (const [k] of oldest) responseCache.delete(k)
  }
}




// ── Dynamic free model refresh from OpenRouter ───────────────────────────────
import { MODEL_REGISTRY, LOCAL_MODEL } from './modelRegistry'

async function refreshFreeModels() {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${process.env.VITE_OPENROUTER_API_KEY}` }
    })
    if (!res.ok) return
    const { data } = await res.json() as { data: Array<{ id: string; pricing: { prompt: string; completion: string }; name: string }> }
    const freeIds = new Set(
      data
        .filter(m => parseFloat(m.pricing?.prompt ?? '1') === 0 && parseFloat(m.pricing?.completion ?? '1') === 0)
        .map(m => `openrouter/${m.id}`)
    )
    let added = 0, removed = 0
    for (const m of MODEL_REGISTRY) {
      if (m.provider !== 'openrouter') continue
      const wasLive = m.free
      m.free = freeIds.has(m.id)
      if (wasLive && !m.free) removed++
      if (!wasLive && m.free) added++
    }
    console.log(`[ModelRefresh] Free model check complete — +${added} enabled, -${removed} disabled`)
  } catch (e) {
    console.warn('[ModelRefresh] Failed to refresh model list:', e)
  }
}

refreshFreeModels()
setInterval(refreshFreeModels, 6 * 60 * 60 * 1000)

// ── Autonomous Model Hunter ───────────────────────────────────────────────────
import { runModelHunter, loadDiscoveredModels } from './src/CrucibleEngine/modelHunter'

// ── Track C — Living Corpus ───────────────────────────────────────────────────
import { initCorpus, corpusStatus, startAcquisition } from './src/CrucibleEngine/corpus/index'
import { ingestDocument } from './src/CrucibleEngine/corpus/ingest'

// Load previously-discovered models into the live registry at startup
;(function loadDiscovered() {
  const discovered = loadDiscoveredModels(process.cwd())
  let added = 0
  for (const m of discovered) {
    if (!MODEL_REGISTRY.find((r: any) => r.id === m.id)) {
      MODEL_REGISTRY.push(m as any)
      added++
    }
  }
  if (added > 0) console.log(`[Hunter] Loaded ${added} previously-discovered model(s) into registry`)
})()

// 3.2 — Re-integrate the fine-tuned model (if a fine-tune has completed) as a
// first-class ensemble member. No-op until getFineTunedModelId returns an id.
;(function loadFineTuned() {
  try {
    const ftId = getFineTunedModelId(process.cwd())
    if (ftId) registerFineTunedModel(ftId)
  } catch (e: any) { console.warn('[FineTune] re-integration skipped:', e?.message ?? e) }
})()

// Run hunter once at startup (after 30s delay to avoid hitting rate limits during boot),
// then every 24h
setTimeout(async () => {
  const apiKey = process.env.VITE_OPENROUTER_API_KEY ?? ''
  if (!apiKey) return
  // Standing constraint: under CRUCIBLE_OFFLINE=strict, NO external calls — ever.
  // The Hunter probes OpenRouter (boot + 24h). They never touch the chat path, but they
  // are external network calls; strict must mean strict literally (decided 2026-07-01).
  if ((process.env.CRUCIBLE_OFFLINE ?? '1') === 'strict') return
  await runModelHunter(process.cwd(), apiKey, MODEL_REGISTRY as any, m => {
    MODEL_REGISTRY.push(m as any)
    console.log(`[Hunter] Live-added to registry: ${m.label}`)
  })
}, 30_000)
setInterval(async () => {
  const apiKey = process.env.VITE_OPENROUTER_API_KEY ?? ''
  if (!apiKey) return
  // Standing constraint: under CRUCIBLE_OFFLINE=strict, NO external calls — ever.
  // The Hunter probes OpenRouter (boot + 24h). They never touch the chat path, but they
  // are external network calls; strict must mean strict literally (decided 2026-07-01).
  if ((process.env.CRUCIBLE_OFFLINE ?? '1') === 'strict') return
  await runModelHunter(process.cwd(), apiKey, MODEL_REGISTRY as any, m => {
    MODEL_REGISTRY.push(m as any)
    enqueueModel(process.cwd(), {
      id: m.id, label: m.label, provider: m.provider,
      params: m.params, probeLatencyMs: m.probeLatencyMs ?? 0, qualityScore: m.quality
    })
  })
}, 24 * 60 * 60 * 1000)

// Waitlist background scorer — updates external benchmark scores every 6h
setInterval(async () => {
  const apiKey = process.env.VITE_OPENROUTER_API_KEY ?? ''
  if (!apiKey) return
  // Strict = no external calls. The waitlist scorer hits OpenRouter benchmarks (decided 2026-07-01).
  if ((process.env.CRUCIBLE_OFFLINE ?? '1') === 'strict') return
  await updateWaitlistScores(process.cwd(), apiKey)
  promoteNextFromWaitlist(process.cwd())
}, 6 * 60 * 60 * 1000)

// ── Live scoring config — merges defaults with learned weights from autoImprove
// Mutated at startup after loadLearnedWeights() resolves disk state.
// A fresh install gets DEFAULT_SCORING_CONFIG; weights drift gradually over time.
const SCORING_CONFIG = { ...DEFAULT_SCORING_CONFIG }
function refreshScoringConfig() {
  const learned = loadLearnedWeights(process.cwd())
  SCORING_CONFIG.weights.similarity = learned.similarity
  SCORING_CONFIG.weights.functional  = learned.functional
  SCORING_CONFIG.weights.novelty     = learned.novelty
}

const app = express()
app.use(cors({
  origin: (origin, cb) => cb(null, origin ?? 'http://localhost:5173'),
  credentials: true,
}))
// Gzip all responses except SSE streams (text/event-stream must flush immediately;
// gzip buffering breaks the real-time delivery of SSE frames and pipeline events).
app.use(compression({
  filter: (req, res) => {
    const ct = res.getHeader('Content-Type') as string | undefined
    if (ct && ct.includes('text/event-stream')) return false
    return compression.filter(req, res)
  },
}))
app.use(express.json())

// Serve the production frontend build so phones can load the app directly from :3001
// (one hop, compressed, no Vite proxy chain). PC dev flow still uses :5173 with HMR.
// Loaded AFTER compression so static files benefit from gzip automatically.
// ── 1.2 — Data relocation support ─────────────────────────────────────────────
// All user data lives under <cwd>/.crucible. When packaged, electron.cjs spawns
// the server with cwd = app.getPath('userData') so ALL data (corpus DB, learned
// state, history) relocates to ~/Library/Application Support/Crucible/ atomically
// — every path keys off process.cwd() at call/load time. The ONLY thing that must
// NOT relocate is the code (the frontend bundle): pin it to the script's own dir.
const CODE_DIR = path.dirname(path.resolve(process.argv[1] || process.cwd()))
const FRONTEND_BUILD = [path.join(CODE_DIR, 'app'), path.join(process.cwd(), 'app')]
  .find(p => fs.existsSync(p)) ?? path.join(CODE_DIR, 'app')
if (fs.existsSync(FRONTEND_BUILD)) {
  app.use(express.static(FRONTEND_BUILD, {
    maxAge: '1y',
    etag: true,
    setHeaders(res, filePath) {
      // Never cache the HTML shell — asset filenames are content-hashed, so
      // a new deploy produces new hashes; the HTML must always be fresh.
      if (filePath.endsWith('index.html') || filePath.endsWith('sw.js') || filePath.endsWith('.webmanifest')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
      }
    },
  }))
}

// ── Auth utilities ─────────────────────────────────────────────────────────────
// Persist the JWT secret so server restarts don't invalidate every session.
// New installs generate a random secret once and write it to disk.
const JWT_SECRET_FILE = path.join(process.cwd(), '.crucible', 'jwt_secret')
function loadOrCreateJwtSecret(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET
  try { return fs.readFileSync(JWT_SECRET_FILE, 'utf8').trim() } catch {}
  const secret = crypto.randomBytes(32).toString('hex')
  try { fs.mkdirSync(path.dirname(JWT_SECRET_FILE), { recursive: true }); fs.writeFileSync(JWT_SECRET_FILE, secret) } catch {}
  return secret
}
const JWT_SECRET = loadOrCreateJwtSecret()
const CRUCIBLE_DIR = path.join(process.cwd(), '.crucible')
const USERS_FILE   = path.join(CRUCIBLE_DIR, 'users.json')

// OAuth provider config — loaded from .env.local
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID ?? ''
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? ''
const GITHUB_CLIENT_ID     = process.env.GITHUB_CLIENT_ID ?? ''
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET ?? ''
// Set OAUTH_BASE_URL to a tunnel URL (e.g. https://xxx.serveo.net) when accessing
// from mobile or any device that can't reach localhost/private IPs.
const OAUTH_BASE_URL = (process.env.OAUTH_BASE_URL ?? '').replace(/\/$/, '')

// In-memory CSRF state store — keyed by random state param, value = provider
const oauthStates = new Map<string, string>()

interface CrucibleUser { id: string; email: string; provider: string; providerId: string; createdAt: number }

function loadUsers(): CrucibleUser[] {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) } catch { return [] }
}
function saveUsers(users: CrucibleUser[]) {
  fs.mkdirSync(CRUCIBLE_DIR, { recursive: true })
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2))
}
async function upsertUser(provider: string, providerId: string, email: string): Promise<CrucibleUser> {
  if (pgPool) {
    const existing = await pgPool.query(
      'SELECT id, email, provider, provider_id as "providerId", created_at as "createdAt" FROM users WHERE provider = $1 AND provider_id = $2',
      [provider, providerId]
    )
    if (existing.rows.length > 0) return existing.rows[0] as CrucibleUser
    const user: CrucibleUser = { id: crypto.randomUUID(), email, provider, providerId, createdAt: Date.now() }
    await pgPool.query(
      'INSERT INTO users (id, email, provider, provider_id, created_at) VALUES ($1, $2, $3, $4, $5)',
      [user.id, user.email, user.provider, user.providerId, user.createdAt]
    )
    return user
  }
  const users = loadUsers()
  let user = users.find(u => u.provider === provider && u.providerId === providerId)
  if (!user) {
    user = { id: crypto.randomUUID(), email, provider, providerId, createdAt: Date.now() }
    saveUsers([...users, user])
  }
  return user
}

// JWT crypto + cookie parsing live in src/server/jwt.ts (unit-testable); these thin wrappers
// bind them to the process JWT_SECRET so every call site stays unchanged.
function signJwt(payload: object): string { return signJwtCore(payload, JWT_SECRET) }
function verifyJwt(token: string): { id: string; email: string; exp: number } | null { return verifyJwtCore(token, JWT_SECRET) }

function getAuthUser(req: express.Request): { id: string; email: string } | null {
  const cookies = parseCookies(req.headers.cookie ?? '')
  const token = cookies['crucible_session']
  if (!token) return null
  return verifyJwt(token)
}

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!getAuthUser(req)) return res.status(401).json({ error: 'Unauthorized' })
  next()
}

// Auth guard — all /api/* except /api/auth/*, /api/screen-stream, and /api/diag
app.use('/api', (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (req.path.startsWith('/auth/')) return next()
  if (req.path === '/screen-stream') return next()   // no cookie on phone; LAN-only stream
  if (req.path === '/screen-diag') return next()     // LAN diagnostic — no cookie (curl'd on the Mac)
  if (req.path === '/diag') return next()            // diagnostic endpoint — no auth needed
  if (req.path === '/version') return next()         // build stamp — no auth needed
  return requireAuth(req, res, next)
})

// Migrate legacy history.json to history-default.json on startup
;(() => {
  const legacy = path.join(CRUCIBLE_DIR, 'history.json')
  const target = path.join(CRUCIBLE_DIR, 'history-default.json')
  if (fs.existsSync(legacy) && !fs.existsSync(target)) {
    try { fs.renameSync(legacy, target); console.log('[Auth] Migrated history.json → history-default.json') }
    catch (e) { console.warn('[Auth] Migration failed:', e) }
  }
})()

// ── SSE broadcast for cross-device streaming ─────────────────────────────────
const broadcastClients = new Map<string, Set<express.Response>>()

function registerBroadcastClient(sessionId: string, res: express.Response) {
  if (!broadcastClients.has(sessionId)) broadcastClients.set(sessionId, new Set())
  broadcastClients.get(sessionId)!.add(res)
}
function unregisterBroadcastClient(sessionId: string, res: express.Response) {
  broadcastClients.get(sessionId)?.delete(res)
  if (broadcastClients.get(sessionId)?.size === 0) broadcastClients.delete(sessionId)
}
function broadcastEvent(sessionId: string, data: string, exclude?: express.Response) {
  broadcastClients.get(sessionId)?.forEach(client => {
    if (client === exclude) return
    try { client.write(data) } catch { /* client gone */ }
  })
}

// ── Task registry: server owns the task, not the tab ─────────────────────────
// Every /api/chat run is a task that BUFFERS its full SSE event stream, keyed by taskId.
// When a client backgrounds / reloads / drops, the task keeps running and its events are
// retained. On return the client reconnects to /api/task/stream?taskId=&from=<index> and
// the missed events replay in order, then live tail resumes — seamless. Finished tasks are
// kept for a TTL so late reconnects still get the full result.
interface TaskRecord {
  id: string
  userId: string | null
  events: string[]                       // raw 'data: …\n\n' lines, in order (index = position)
  done: boolean
  createdAt: number
  updatedAt: number
  subscribers: Set<express.Response>     // live tailers attached via /api/task/stream
}
const taskRegistry = new Map<string, TaskRecord>()
const TASK_DONE_TTL_MS = 60 * 60 * 1000          // keep finished tasks 1h for late reconnects
const TASK_STALE_TTL_MS = 30 * 60 * 1000         // drop never-finished tasks after 30m

function createTask(id: string, userId: string | null): TaskRecord {
  const rec: TaskRecord = { id, userId, events: [], done: false, createdAt: Date.now(), updatedAt: Date.now(), subscribers: new Set() }
  taskRegistry.set(id, rec)
  return rec
}
function appendTaskEvent(rec: TaskRecord, line: string) {
  rec.events.push(line)
  rec.updatedAt = Date.now()
  rec.subscribers.forEach(s => { try { s.write(line) } catch { rec.subscribers.delete(s) } })
}
function finishTask(rec: TaskRecord) {
  if (rec.done) return
  rec.done = true
  rec.updatedAt = Date.now()
  rec.subscribers.forEach(s => { try { s.write('data: [DONE]\n\n'); s.end() } catch {} })
  rec.subscribers.clear()
  // "Answer ready" push — only for real runs (skip instant/cached). The service worker
  // suppresses it when a window is focused, so the user is only pinged if they left.
  if (Date.now() - rec.createdAt > 3000 && rec.events.length > 4) {
    void notifyUser(rec.userId, { title: 'Crucible', body: 'Your answer is ready.', url: '/' })
  }
}
setInterval(() => {
  const now = Date.now()
  for (const [id, rec] of taskRegistry) {
    const ttl = rec.done ? TASK_DONE_TTL_MS : TASK_STALE_TTL_MS
    if (now - rec.updatedAt > ttl) taskRegistry.delete(id)
  }
}, 5 * 60 * 1000)

// Reconnect/replay endpoint: replays buffered events from `from`, then live-tails if running.
app.get('/api/task/stream', (req: express.Request, res: express.Response) => {
  const taskId = String(req.query.taskId ?? '')
  const from = Math.max(0, parseInt(String(req.query.from ?? '0'), 10) || 0)
  const rec = taskRegistry.get(taskId)
  if (!rec) return res.status(404).json({ error: 'task not found' })   // client falls back to restore
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  // Replay everything the client hasn't seen yet, in order.
  for (let i = from; i < rec.events.length; i++) { try { res.write(rec.events[i]) } catch {} }
  if (rec.done) { try { res.write('data: [DONE]\n\n') } catch {}; res.end(); return }
  // Still running — attach as a live tailer for the remaining events.
  rec.subscribers.add(res)
  const keepalive = setInterval(() => { try { res.write(': keepalive\n\n') } catch { clearInterval(keepalive) } }, 25000)
  req.on('close', () => { clearInterval(keepalive); rec.subscribers.delete(res) })
})

// Lightweight status check — used by the client on load to decide whether to reconnect.
app.get('/api/task/:taskId/status', (req: express.Request, res: express.Response) => {
  const rec = taskRegistry.get(String(req.params.taskId))
  if (!rec) return res.json({ exists: false })
  res.json({ exists: true, done: rec.done, total: rec.events.length })
})

// ── Web Push (PWA notifications) ─────────────────────────────────────────────
// Since the task lives on the server, it can notify "answer ready" even with the app
// fully closed. The service worker suppresses the notification when a window is focused.
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY ?? ''
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY ?? ''
const pushEnabled = !!(VAPID_PUBLIC && VAPID_PRIVATE)
if (pushEnabled) {
  try { webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? 'mailto:admin@crucible.local', VAPID_PUBLIC, VAPID_PRIVATE) }
  catch (e: any) { console.error('[Push] VAPID setup failed:', e?.message) }
}
const PUSH_SUBS_FILE = path.join(CRUCIBLE_DIR, 'push-subscriptions.json')
type PushSub = { userId: string; sub: any }
async function loadPushSubs(): Promise<PushSub[]> {
  if (pgPool) {
    const r = await pgPool.query('SELECT user_id as "userId", sub FROM push_subscriptions')
    return r.rows as PushSub[]
  }
  try { return JSON.parse(fs.readFileSync(PUSH_SUBS_FILE, 'utf8')) } catch { return [] }
}
async function savePushSubs(subs: PushSub[]): Promise<void> {
  if (pgPool) {
    const client = await pgPool.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM push_subscriptions')
      for (const s of subs) {
        await client.query(
          'INSERT INTO push_subscriptions (user_id, endpoint, sub) VALUES ($1, $2, $3)',
          [s.userId, s.sub?.endpoint ?? '', JSON.stringify(s.sub)]
        )
      }
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }
    return
  }
  try { fs.mkdirSync(CRUCIBLE_DIR, { recursive: true }); fs.writeFileSync(PUSH_SUBS_FILE, JSON.stringify(subs)) } catch {}
}
async function notifyUser(userId: string | null, payload: { title: string; body: string; url?: string }) {
  if (!pushEnabled || !userId) return
  const subs = await loadPushSubs()
  const mine = subs.filter(s => s.userId === userId)
  if (mine.length === 0) return
  const dead: any[] = []
  await Promise.all(mine.map(async ({ sub }) => {
    try { await webpush.sendNotification(sub, JSON.stringify(payload)) }
    catch (e: any) { if (e?.statusCode === 404 || e?.statusCode === 410) dead.push(sub.endpoint) }
  }))
  if (dead.length) await savePushSubs(subs.filter(s => !dead.includes(s.sub?.endpoint)))
}

app.get('/api/push/vapid-public', (_req: express.Request, res: express.Response) => {
  res.json({ key: pushEnabled ? VAPID_PUBLIC : null })
})
app.post('/api/push/subscribe', async (req: express.Request, res: express.Response) => {
  const user = getAuthUser(req)
  if (!user) return res.status(401).json({ error: 'Unauthorized' })
  const sub = req.body?.subscription
  if (!sub?.endpoint) return res.status(400).json({ error: 'invalid subscription' })
  const subs = (await loadPushSubs()).filter(s => s.sub?.endpoint !== sub.endpoint)  // dedupe by endpoint
  subs.push({ userId: user.id, sub })
  await savePushSubs(subs)
  res.json({ ok: true })
})

// ── OAuth helpers ─────────────────────────────────────────────────────────────
function issueSession(res: express.Response, user: CrucibleUser) {
  const token = signJwt({ id: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 30 * 86400 })
  res.cookie('crucible_session', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 30 * 86400 * 1000 })
}

// Detect the origin the browser sees so the callback can redirect back to it.
// In dev: frontend is :5173, backend is :3001 — redirect to :5173 after OAuth.
// In prod: they share the same origin — redirect to /.
function isLocal(): boolean {
  return !!process.env.CRUCIBLE_DATA_DIR // set by electron for local runs
}

function serverBase(req: express.Request): string {
  if (OAUTH_BASE_URL && !isLocal()) return OAUTH_BASE_URL
  return `http://${req.hostname}:3001`
}

function frontendOrigin(req: express.Request): string {
  if (OAUTH_BASE_URL && !isLocal()) return OAUTH_BASE_URL
  const origin = req.headers.origin ?? req.headers.referer ?? ''
  if (origin.includes(':5173')) return 'http://localhost:5173'
  return `http://localhost:5173`
}

// ── Auth endpoints ────────────────────────────────────────────────────────────

// Google OAuth — step 1: redirect to Google consent screen
app.get('/api/auth/google', (req: express.Request, res: express.Response) => {
  if (!GOOGLE_CLIENT_ID) return res.status(503).send('GOOGLE_CLIENT_ID not configured in .env.local')
  const state = crypto.randomBytes(16).toString('hex')
  oauthStates.set(state, 'google')
  setTimeout(() => oauthStates.delete(state), 10 * 60 * 1000) // expire in 10 min
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `${serverBase(req)}/api/auth/callback/google`,
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    state,
    access_type: 'offline',
    prompt: 'consent',  // force refresh_token on every login
  })
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
})

// Google OAuth — step 2: exchange code for tokens, upsert user, issue session
app.get('/api/auth/callback/google', async (req: express.Request, res: express.Response) => {
  const { code, state, error } = req.query as Record<string, string>
  if (error) return res.redirect(`${frontendOrigin(req)}/?auth_error=${encodeURIComponent(error)}`)
  if (!state || !oauthStates.has(state)) return res.redirect(`${frontendOrigin(req)}/?auth_error=invalid_state`)
  oauthStates.delete(state)
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: `${serverBase(req)}/api/auth/callback/google`,
        grant_type: 'authorization_code',
      }),
    })
    const tokens = await tokenRes.json() as any
    if (!tokenRes.ok) throw new Error(tokens.error_description ?? 'token exchange failed')
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    const profile = await userRes.json() as any
    const user = await upsertUser('google', profile.id, profile.email)
    // Store Google tokens for API tool use
    saveTokens(user.id, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? '',
      expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      scope: tokens.scope ?? GOOGLE_SCOPES,
    })
    issueSession(res, user)
    res.redirect(`${frontendOrigin(req)}/`)
  } catch (e: any) {
    console.error('[OAuth/Google]', e.message)
    res.redirect(`${frontendOrigin(req)}/?auth_error=${encodeURIComponent('Google sign-in failed')}`)
  }
})

// GitHub OAuth — step 1: redirect to GitHub consent screen
app.get('/api/auth/github', (req: express.Request, res: express.Response) => {
  if (!GITHUB_CLIENT_ID) return res.status(503).send('GITHUB_CLIENT_ID not configured in .env.local')
  const state = crypto.randomBytes(16).toString('hex')
  oauthStates.set(state, 'github')
  setTimeout(() => oauthStates.delete(state), 10 * 60 * 1000)
  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: `${serverBase(req)}/api/auth/callback/github`,
    scope: 'user:email',
    state,
  })
  res.redirect(`https://github.com/login/oauth/authorize?${params}`)
})

// GitHub OAuth — step 2: exchange code for token, upsert user, issue session
app.get('/api/auth/callback/github', async (req: express.Request, res: express.Response) => {
  const { code, state, error } = req.query as Record<string, string>
  if (error) return res.redirect(`${frontendOrigin(req)}/?auth_error=${encodeURIComponent(error)}`)
  if (!state || !oauthStates.has(state)) return res.redirect(`${frontendOrigin(req)}/?auth_error=invalid_state`)
  oauthStates.delete(state)
  try {
    // Exchange code for access token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET,
        code, redirect_uri: `${serverBase(req)}/api/auth/callback/github`,
      }),
    })
    const tokens = await tokenRes.json() as any
    if (tokens.error) throw new Error(tokens.error_description ?? tokens.error)
    // Get user profile
    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${tokens.access_token}`, 'User-Agent': 'Crucible' },
    })
    const profile = await userRes.json() as any
    // GitHub may have a private email — fall back to /user/emails
    let email = profile.email as string | null
    if (!email) {
      const emailRes = await fetch('https://api.github.com/user/emails', {
        headers: { Authorization: `Bearer ${tokens.access_token}`, 'User-Agent': 'Crucible' },
      })
      const emails = await emailRes.json() as any[]
      email = (emails.find((e: any) => e.primary)?.email) ?? emails[0]?.email ?? ''
    }
    const user = await upsertUser('github', String(profile.id), email)
    issueSession(res, user)
    res.redirect(`${frontendOrigin(req)}/`)
  } catch (e: any) {
    console.error('[OAuth/GitHub]', e.message)
    res.redirect(`${frontendOrigin(req)}/?auth_error=${encodeURIComponent('GitHub sign-in failed')}`)
  }
})

app.post('/api/auth/logout', (_req: express.Request, res: express.Response) => {
  res.clearCookie('crucible_session')
  res.json({ ok: true })
})

app.get('/api/auth/me', (req: express.Request, res: express.Response) => {
  const user = getAuthUser(req)
  if (!user) return res.status(401).json({ error: 'Unauthorized' })
  res.json({ id: user.id, email: user.email })
})

// ── Session persistence endpoints (Task 2) ────────────────────────────────────
app.post('/api/session/save', (req: express.Request, res: express.Response) => {
  const user = getAuthUser(req)
  const file = path.join(CRUCIBLE_DIR, `active-session-${user?.id ?? 'anon'}.json`)
  try {
    fs.mkdirSync(CRUCIBLE_DIR, { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ ...req.body, timestamp: Date.now() }))
    res.json({ ok: true })
  } catch { res.status(500).json({ error: 'save failed' }) }
})

app.get('/api/session/restore', (req: express.Request, res: express.Response) => {
  const user = getAuthUser(req)
  const file = path.join(CRUCIBLE_DIR, `active-session-${user?.id ?? 'anon'}.json`)
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (Date.now() - (data.timestamp ?? 0) > 24 * 3600 * 1000) return res.json({ session: null })
    res.json({ session: data })
  } catch { res.json({ session: null }) }
})

// Patch a finished answer back into the user's active session, keyed by round id.
// This makes the SERVER authoritative: the pipeline / agent loop keeps running after the
// client disconnects, and when it finishes we write the answer into the active session so
// `/api/session/restore` returns a COMPLETED conversation instead of a dead, unanswered
// query. Read-modify-write preserves the rest of the thread the client already saved.
function patchActiveSessionRound(user: { id: string } | null | undefined, roundId: string, patch: Record<string, unknown>) {
  if (!roundId) return
  // 1) Legacy active-session blob — best-effort. Only patch a round the client already
  // persisted; if it's missing, skip THIS write (don't abort the whole function).
  const file = path.join(CRUCIBLE_DIR, `active-session-${user?.id ?? 'anon'}.json`)
  try {
    let data: any = {}
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
    const rounds: any[] = Array.isArray(data.rounds) ? data.rounds : []
    const idx = rounds.findIndex(r => r && r.id === roundId)
    if (idx >= 0) {
      rounds[idx] = { ...rounds[idx], ...patch }
      fs.mkdirSync(CRUCIBLE_DIR, { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ ...data, rounds, timestamp: Date.now() }))
    }
  } catch (e: any) {
    console.error('[Session] patchActiveSessionRound failed:', e?.message)
  }
  // 2) Grouped conversation store (source of truth for history) — ALWAYS attempt, even
  // if the legacy blob lacked the round, so a finished answer lands in history even when
  // the client disconnected/refreshed mid-stream.
  const convId = roundConversation.get(roundId)
  if (convId) patchConversationRound(user?.id ?? null, convId, roundId, patch)
}

// ── Chat conversations API (grouped, searchable, reopenable threads) ──────────
// Save/upsert the current conversation. Client calls this continuously (debounced).
app.post('/api/conversations/save', (req: express.Request, res: express.Response) => {
  const user = getAuthUser(req)
  const { id, mode, rounds } = req.body ?? {}
  if (typeof id !== 'string' || !id) return res.status(400).json({ error: 'id required' })
  saveConversationEntry(user?.id ?? null, { id, mode, rounds: Array.isArray(rounds) ? rounds : [] })
  res.json({ ok: true })
})
// List conversation summaries (newest first) for the history drawer.
app.get('/api/conversations', (req: express.Request, res: express.Response) => {
  const user = getAuthUser(req)
  const list = loadConversations(user?.id ?? null)
  res.json({
    conversations: list.map((c: any) => {
      const lastAnswer = Array.isArray(c.rounds) ? [...c.rounds].reverse().find((r: any) => r?.synthesis)?.synthesis ?? '' : ''
      return { id: c.id, title: c.title, mode: c.mode, startedAt: c.startedAt, updatedAt: c.updatedAt, roundCount: Array.isArray(c.rounds) ? c.rounds.length : 0, snippet: String(lastAnswer).slice(0, 240) }
    }),
  })
})
// Full conversation (all rounds) to reopen and continue.
app.get('/api/conversations/:id', (req: express.Request, res: express.Response) => {
  const user = getAuthUser(req)
  const conv = getConversationById(user?.id ?? null, String(req.params.id))
  if (!conv) return res.status(404).json({ error: 'not found' })
  res.json({ conversation: conv })
})
app.delete('/api/conversations/:id', (req: express.Request, res: express.Response) => {
  const user = getAuthUser(req)
  deleteConversationById(user?.id ?? null, String(req.params.id))
  res.json({ ok: true })
})

// ── Passive SSE stream for cross-device broadcast (Task 3) ────────────────────
app.get('/api/session/stream', (req: express.Request, res: express.Response) => {
  const sessionId = (req.query.sessionId as string) ?? ''
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' })
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  res.write('data: {"type":"connected"}\n\n')
  registerBroadcastClient(sessionId, res)
  const keepalive = setInterval(() => { try { res.write(': keepalive\n\n') } catch { clearInterval(keepalive) } }, 25000)
  req.on('close', () => { clearInterval(keepalive); unregisterBroadcastClient(sessionId, res) })
})

const groq    = new Groq({ apiKey: process.env.VITE_GROQ_API_KEY ?? 'missing' })
const mistral = new Mistral({ apiKey: process.env.VITE_MISTRAL_API_KEY ?? 'missing' })
const gemini  = new GoogleGenerativeAI(process.env.VITE_GEMINI_API_KEY ?? '')

// ── Generic OpenAI-compatible providers ──────────────────────────────────────
// Together, Cerebras, Cohere (via /compatibility/v1), Fireworks, and DeepInfra all
// speak the OpenAI {model, messages, stream} request shape and return choices[].delta
// SSE — so ONE transport serves all of them. To add another OpenAI-compatible provider:
// add a row here + registry entries with `id` = `<key>/<exact-api-model-id>`. The model
// id sent to the API is everything after the first `/` (the provider key is stripped).
const OPENAI_COMPAT_PROVIDERS: Record<string, { url: string; envVar: string; maxTokens: number }> = {
  together:  { url: 'https://api.together.ai/v1/chat/completions',             envVar: 'TOGETHER_API_KEY',  maxTokens: 4096 },
  cerebras:  { url: 'https://api.cerebras.ai/v1/chat/completions',             envVar: 'CEREBRAS_API_KEY',  maxTokens: 8192 },
  cohere:    { url: 'https://api.cohere.ai/compatibility/v1/chat/completions', envVar: 'COHERE_API_KEY',    maxTokens: 4096 },
  fireworks: { url: 'https://api.fireworks.ai/inference/v1/chat/completions',  envVar: 'FIREWORKS_API_KEY', maxTokens: 4096 },
  deepinfra: { url: 'https://api.deepinfra.com/v1/openai/chat/completions',    envVar: 'DEEPINFRA_TOKEN',   maxTokens: 4096 },
}

// ── Track S — Local inference (Apple Foundation Models bridge) ───────────────
const LOCAL_INFERENCE_URL = process.env.LOCAL_INFERENCE_URL ?? 'http://127.0.0.1:11435'
// Best-effort liveness flag. Set once at startup; local routing is skipped when
// false so the daemon being down NEVER blocks or breaks the pipeline.
let localInferenceAvailable = false

async function checkLocalInference(): Promise<boolean> {
  try {
    const res = await fetch(`${LOCAL_INFERENCE_URL}/health`, { signal: AbortSignal.timeout(2000) })
    const data = await res.json()
    if (data?.available === true) {
      console.log('[Local] Apple Foundation Models bridge up — on-device inference active')
      return true
    }
    console.log(`[Local] Bridge reachable but model unavailable: ${data?.detail ?? 'unknown'} — local inference inactive`)
    return false
  } catch {
    console.log('[Local] FM bridge not running — local inference inactive (external pool only)')
    return false
  }
}

// Item-9 (2026-07-07): local-FM call ceiling. In CRUCIBLE_OFFLINE=strict there is NO external
// pool to escalate to, so a slow local FM on a genuinely hard task must be allowed to grind to
// completion rather than aborting empty-handed (the single most trust-damaging failure). Strict
// → generous (still bounded so a wedged daemon can't hang forever); hybrid keeps the short
// ceiling so a stall escalates quickly. Env-overridable via CRUCIBLE_FM_TIMEOUT_MS.
const LOCAL_FM_TIMEOUT_MS = Number(
  // cont.47: !== '0' — non-quorum requests are strict per-request regardless of env,
  // so only an explicit CRUCIBLE_OFFLINE=0 keeps the short ceiling. Mirrors fmReact.ts.
  process.env.CRUCIBLE_FM_TIMEOUT_MS ?? ((process.env.CRUCIBLE_OFFLINE ?? '1') !== '0' ? 600_000 : 30_000),
)

// Fail-silent local call: returns '' on any error (used where the pipeline must
// never throw, e.g. emergency fallback synthesis). For normal routing that should
// surface failures, use callModel({ provider: 'local', ... }) instead.
async function callLocalModel(systemPrompt: string, userMessage: string, timeoutMs = LOCAL_FM_TIMEOUT_MS): Promise<string> {
  try {
    const res = await enqueueFm(() => fetch(`${LOCAL_INFERENCE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'apple-fm',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        max_tokens: 1024,
        temperature: 0.7,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    }), { priority: 'normal', label: 'callLocalModel' })
    if (!res.ok) return ''
    const data = await res.json()
    return data.choices?.[0]?.message?.content ?? ''
  } catch {
    return ''
  }
}

const stripThink = (text: string) =>
  text.replace(/<think>[\s\S]*?<\/think>/g, '').trim()

// ── Offline-first gate — THE single chokepoint ───────────────────────────────
// Every server-side external model call funnels through callModel /
// callModelStreaming (Stage 1-5, MASTERPIECE via mpDeps, compressCallModel,
// probes, synthesis). Gating here makes the model-cost-independent contract hold
// BY CONSTRUCTION: a new call site cannot silently leak, because the leak path
// itself is gated. Mirrors the activeDriveTurn contract on the agentic side
// (the agentic driver.ts is self-contained and gated separately — untouched).
//   '1' / default — local Apple FM first; on empty/failed FM, fall to external
//   'strict'      — local FM only; THROW rather than ever escalate (abstain≡abstain)
//   '0'           — external only (offline brain opted out)
class OfflineStrictError extends Error {
  constructor(provider: string) {
    super(`[offline-strict] external escalation to "${provider}" blocked; local FM unavailable`)
    this.name = 'OfflineStrictError'
  }
}

async function callLocalFromMessages(
  messages: { role: string; content: string }[],
  timeoutMs = LOCAL_FM_TIMEOUT_MS,
): Promise<string> {
  try {
    const res = await enqueueFm(() => fetch(`${LOCAL_INFERENCE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'apple-fm', messages, max_tokens: 1024, temperature: 0.7 }),
      signal: AbortSignal.timeout(timeoutMs),
    }), { priority: 'normal', label: 'callLocalFromMessages' })
    if (!res.ok) return ''
    const data = await res.json()
    return stripThink(data.choices?.[0]?.message?.content ?? '')
  } catch {
    return ''
  }
}

// Returns { handled:true, text } when offline served the call locally; { handled:false }
// to proceed with the external dispatch. Throws OfflineStrictError under 'strict' when
// the local FM can't serve it — callers that must degrade (mpDeps) catch and return ''.
async function offlineGate(
  provider: string,
  messages: { role: string; content: string }[],
): Promise<{ handled: boolean; text?: string }> {
  const offline = process.env.CRUCIBLE_OFFLINE ?? '1'
  if (offline === '0' || provider === 'local') return { handled: false }
  const local = await callLocalFromMessages(messages)
  if (local) {
    debugBus.emit('model', 'offline_local_served', { provider, mode: offline }, { severity: 'info' })
    return { handled: true, text: local }
  }
  if (offline === 'strict') throw new OfflineStrictError(provider)
  debugBus.emit('model', 'offline_local_miss_escalate', { provider }, { severity: 'warn' })
  return { handled: false }
}

// withTimeout / estimateMessageTokens live in src/server/util.ts (unit-testable).

// ── Unified model caller ──────────────────────────────────────────────────────
// ── Agentic tool-call loop (fence protocol via tool registry) ────────────────
async function callModelAgentic(model: SelectedModel, messages: { role: string; content: string }[], maxIterations = 3): Promise<string> {
  const ctx: ToolCtx = { projectPath: process.cwd(), allowMutation: false }
  const agenticMessages = [...messages]
  if (agenticMessages[0]?.role === 'system') {
    agenticMessages[0] = { ...agenticMessages[0], content: agenticMessages[0].content + fenceProtocolPrompt(registry.list()) }
  }
  for (let i = 0; i < maxIterations; i++) {
    const response = await callModel(model, agenticMessages)
    const toolCall = parseFenceToolCall(response)
    if (!toolCall) return response  // no tool call — final response
    console.log(`[Agentic] Tool call: ${toolCall.name}(${JSON.stringify(toolCall.args)})`)
    const result = await registry.exec(toolCall, ctx)
    agenticMessages.push({ role: 'assistant', content: response })
    agenticMessages.push({ role: 'user', content: `Tool result (${result.ok ? 'ok' : 'error'}):\n${result.output}\n\nContinue your response.` })
  }
  // Max iterations hit — call once more for final answer
  return await callModel(model, agenticMessages)
}

// ── KV-cache prefix optimization ────────────────────────────────────────────
// Providers (Groq, OpenRouter, Mistral, …) cache the KV state of identical leading
// tokens across requests. To maximise those hits we prepend ONE byte-for-byte
// identical block to the system message of every call — same text, same position,
// every time. The variable, per-call content (contract, aspect, codebase, question)
// follows it, so the shared prefix is as long as possible. The rolling keepalive
// pings carry the same preamble, so they actively keep this prefix warm in the
// provider's cache. The marker keeps the prepend idempotent.
const KV_PREFIX_MARKER = '[[crucible-core-v1]]'
const STATIC_PREAMBLE =
  `${KV_PREFIX_MARKER}\n` +
  'You are a model inside Crucible, a multi-model reasoning pipeline. Global rules, ' +
  'always in force: respond in plain text with no emojis or decorative pictographs; ' +
  'be rigorous, precise, and direct; never wrap prose in code blocks or variable ' +
  'assignments; lead with substance, not preamble; do not restate the question. ' +
  'When asked to build a game, animation, or interactive demo in chat, emit a single ' +
  'self-contained HTML file with inline JS/canvas (no external assets or third-party ' +
  'packages) — Crucible can preview and run that in-app; python packages like pygame ' +
  'cannot run in its sandbox. ' +
  'Task-specific instructions follow.'

// Short preamble for token-constrained providers — omits the pipeline framing but
// keeps the critical output-format rules that affect scoring. Used when total message
// tokens would exceed a model's tpmLimit soft cap.
const STATIC_PREAMBLE_SHORT =
  `${KV_PREFIX_MARKER}\n` +
  'Respond in plain text. No emojis. Be direct and precise. Lead with substance.'

// Estimate message token cost before dispatch.

// Prepend the identical static prefix to the system message (or inject one). Idempotent.
// When a tpmLimit is provided and the existing message payload is already large,
// uses the short preamble to avoid a 413 on token-limited Groq models.
function withStaticPrefix(
  messages: { role: string; content: string }[],
  tpmLimit?: number,
): { role: string; content: string }[] {
  if (messages.length && messages[0].content.startsWith(KV_PREFIX_MARKER)) return messages
  const existingTokens = estimateMessageTokens(messages)
  const preamble = tpmLimit && existingTokens + Math.ceil(STATIC_PREAMBLE.length / 4) > tpmLimit * 0.88
    ? STATIC_PREAMBLE_SHORT
    : STATIC_PREAMBLE
  if (messages.length && messages[0].role === 'system') {
    return [{ ...messages[0], content: `${preamble}\n\n${messages[0].content}` }, ...messages.slice(1)]
  }
  return [{ role: 'system', content: preamble }, ...messages]
}

// ── External API proxy (Cloudflare Worker) ──────────────────────────────────────
// When PROXY_URL is set, every hosted-provider model call is routed through a
// stateless Cloudflare Worker that holds the API keys (worker/index.ts). This is
// what lets keys leave the server, which is what lets Crucible run off the Fly box.
// The Worker speaks the OpenAI chat-completions protocol for every provider, so the
// response shape here is always OpenAI-style (JSON for batch, SSE deltas for stream)
// — identical to what the openrouter/huggingface branches already parse.
const PROXY_URL = (process.env.PROXY_URL ?? '').replace(/\/$/, '')
// Long-lived internal token the Worker validates (same HS256/JWT_SECRET scheme as
// user sessions and RSI_TOKEN). Minted once at startup; only when proxying is on.
const PROXY_JWT = PROXY_URL
  ? signJwt({ id: 'proxy-internal', email: 'proxy@crucible.local', exp: Math.floor(Date.now() / 1000) + 10 * 365 * 86400 })
  : ''
// Never proxy the local Apple FM daemon — it's on loopback and needs no key.
const PROXY_SKIP_PROVIDERS = new Set(['local'])

// Extra upstream params that must survive the proxy hop to preserve direct-call
// behaviour. Groq qwen models disable the reasoning trace (mirrors callModel).
function proxyExtraBody(model: SelectedModel): Record<string, unknown> | undefined {
  if (model.provider === 'groq' && model.id.includes('qwen')) return { reasoning_effort: 'none' }
  return undefined
}
// Match the per-provider max_tokens caps the direct paths apply (others uncapped).
function proxyMaxTokens(model: SelectedModel): number | undefined {
  if (model.provider === 'huggingface') return 4096
  const compat = OPENAI_COMPAT_PROVIDERS[model.provider]
  if (compat) return compat.maxTokens
  return undefined
}

async function proxyChat(
  model: SelectedModel,
  messages: { role: string; content: string }[],
  signal: AbortSignal,
): Promise<string> {
  const res = await fetch(`${PROXY_URL}/proxy/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PROXY_JWT}` },
    body: JSON.stringify({
      provider: model.provider, model: model.id, messages, stream: false,
      max_tokens: proxyMaxTokens(model), extra: proxyExtraBody(model),
    }),
    signal,
  })
  if (!res.ok) throw new Error(`Proxy ${model.provider} ${res.status}: ${await res.text()}`)
  const data: any = await res.json()
  let text = data.choices?.[0]?.message?.content || ''
  if (model.provider === 'groq' && model.id.includes('qwen')) text = stripThink(text)
  return text
}

async function proxyChatStreaming(
  model: SelectedModel,
  messages: { role: string; content: string }[],
  onChunk: (text: string) => void,
): Promise<string> {
  const isQwen = model.provider === 'groq' && model.id.includes('qwen')
  const res = await fetch(`${PROXY_URL}/proxy/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PROXY_JWT}` },
    body: JSON.stringify({
      provider: model.provider, model: model.id, messages, stream: true,
      max_tokens: proxyMaxTokens(model), extra: proxyExtraBody(model),
    }),
  })
  if (!res.ok) throw new Error(`Proxy ${model.provider} ${res.status}: ${await res.text()}`)
  // A provider with no streaming surface (e.g. cloudflare) may return a single JSON
  // even when stream:true was asked — fall back to a one-shot emit in that case.
  const ct = res.headers.get('Content-Type') ?? ''
  if (!ct.includes('text/event-stream')) {
    const data: any = await res.json().catch(() => null)
    let text = data?.choices?.[0]?.message?.content || ''
    if (isQwen) text = stripThink(text)
    onChunk(text)
    return text
  }
  let sseBuf = '', fullText = ''
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    sseBuf += decoder.decode(value, { stream: true })
    const lines = sseBuf.split('\n')
    sseBuf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') break
      try {
        const j = JSON.parse(data)
        const text = j.choices?.[0]?.delta?.content || ''
        // qwen: buffer silently and emit only the cleaned text at the end (mirrors direct path).
        if (text) { fullText += text; if (!isQwen) onChunk(text) }
      } catch {}
    }
  }
  if (isQwen) { const clean = stripThink(fullText); onChunk(clean); return clean }
  return fullText
}

async function callModel(
  model: SelectedModel,
  messages: { role: string; content: string }[],
  opts: { requestId?: string; timeoutMs?: number } = {},
): Promise<string> {
  const { id, provider } = model
  // ── NORTH-STAR TRIPWIRE (permanent, lowest-level guarantee): on-device models ONLY.
  // No external / token-limited model is ever dispatched with a BUNDLED key. The only way
  // an external provider is allowed is when the USER has explicitly supplied their OWN key
  // for it this request (BYOK) — a deliberate, per-request opt-in that cannot fire by
  // accident. Everything else (Apple FM, synth) is provider 'local'. This is what stops the
  // "answered by Groq / a leading technology company / AC-DC" class at the source, even if a
  // future routing change forgets to pin strict. Retrieval tools (web, knowledge-graph) do
  // NOT go through callModel, so this never blocks the north-star-allowed external DATA.
  if (provider !== 'local' && provider !== 'synth' && !currentByokKeys()[provider]) {
    throw new OfflineStrictError(provider)
  }
  // Offline-first gate (see offlineGate): local FM first under offline modes;
  // 'strict' throws rather than escalate. Runs before token guards so an oversized
  // external payload never blocks a request the local FM can serve.
  const _g = await offlineGate(provider, messages)
  if (_g.handled) return _g.text!
  messages = withStaticPrefix(messages, model.tpmLimit)
  const tokenEst = estimateMessageTokens(messages)
  if (model.tpmLimit && tokenEst > model.tpmLimit) {
    const msg = `Token budget exceeded: ~${tokenEst} tokens estimated, limit is ${model.tpmLimit} for ${id}`
    console.warn(`[TokenGuard] ${msg}`)
    debugBus.emit('model', 'token_guard_reject', { model: id, provider, tokenEst, tpmLimit: model.tpmLimit }, { requestId: opts.requestId, severity: 'warn' })
    throw new Error(msg)
  }
  recordProviderCall(provider)
  const t0 = Date.now()
  debugBus.emit('model', 'model_call', { model: id, provider, promptTokensEst: tokenEst }, { requestId: opts.requestId })

  // Default per-call timeout for non-local providers — prevents a slow/hung API
  // from blocking the pipeline indefinitely. Stage 1 already wraps callModelStreaming
  // in withTimeout; this guards callModel uses elsewhere (probes, synthesis, etc.).
  const callTimeoutMs = opts.timeoutMs ?? (provider === 'local' ? LOCAL_FM_TIMEOUT_MS : 45000)
  const callAbort = AbortSignal.timeout(callTimeoutMs)

  // Route every hosted provider through the Cloudflare Worker key-proxy when enabled.
  // Local FM stays direct (loopback, no key). The Worker normalises to OpenAI shape.
  // BYOK exception: if the user supplied their OWN key for this provider, bypass the shared
  // proxy (which would use bundled keys) and call the provider directly with the user's key.
  const _hasUserKey = !!currentByokKeys()[provider]
  if (PROXY_URL && !PROXY_SKIP_PROVIDERS.has(provider) && !_hasUserKey) {
    return await proxyChat(model, messages, callAbort)
  }

  if (provider === 'groq') {
    const modelId = id.replace(/^groq\//, '')
    const isQwen = modelId.includes('qwen')
    const res = await groq.chat.completions.create(
      { model: modelId, messages, stream: false, ...(isQwen ? { reasoning_effort: 'none' } : {}) } as any,
      { signal: callAbort },
    )
    const text = res.choices[0]?.message?.content || ''
    return isQwen ? stripThink(text) : text
  }

  if (provider === 'mistral') {
    const modelId = id.replace(/^mistral\//, '')
    const res = await mistral.chat.complete({ model: modelId, messages } as any, { signal: callAbort } as any)
    return (res.choices?.[0]?.message?.content as string) || ''
  }

  if (provider === 'gemini') {
    const modelId = id.replace(/^gemini\//, '')
    const gModel = gemini.getGenerativeModel({ model: modelId })
    const history = messages.slice(0, -1).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }))
    const last = messages[messages.length - 1]
    const chat = gModel.startChat({ history })
    const result = await Promise.race([
      chat.sendMessage(last.content),
      new Promise<never>((_, reject) => callAbort.addEventListener('abort', () => reject(new Error('timeout')))),
    ])
    return result.response.text()
  }

  if (provider === 'openrouter') {
    const modelId = id.replace(/^openrouter\//, '')
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${resolveProviderKey('openrouter')}`,
        'HTTP-Referer': 'https://crucible.local',
        'X-Title': 'Crucible',
      },
      body: JSON.stringify({ model: modelId, messages }),
      signal: callAbort,
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`OpenRouter ${res.status}: ${err}`)
    }
    const data = await res.json()
    return data.choices?.[0]?.message?.content || ''
  }

  if (provider === 'huggingface') {
    const modelId = id.replace(/^huggingface\//, '')
    const res = await fetch('https://router.huggingface.co/novita/v3/openai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.VITE_HF_API_KEY}`,
      },
      body: JSON.stringify({ model: modelId, messages, max_tokens: 4096 }),
      signal: callAbort,
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`HuggingFace ${res.status}: ${err}`)
    }
    const data = await res.json()
    return data.choices?.[0]?.message?.content || ''
  }

  if (provider === 'cloudflare') {
    const modelId = id.replace(/^cloudflare\//, '')
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
    const apiKey = process.env.CLOUDFLARE_API_KEY
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${modelId}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messages }),
      signal: callAbort,
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Cloudflare ${res.status}: ${err}`)
    }
    const data = await res.json()
    return data.result?.response || ''
  }

  // Track S — local Apple Foundation Models via the localhost bridge daemon.
  // OpenAI-compatible shape; no auth, no rate limit. Throws on daemon error so
  // the instrumented caller records the failure (callers that must not fail use
  // callLocalModel() instead, which returns '' silently).
  if (provider === 'local') {
    const res = await enqueueFm(() => fetch(`${LOCAL_INFERENCE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'apple-fm', messages, max_tokens: 1024, temperature: 0.7 }),
      signal: callAbort,
    }), { priority: 'normal', label: 'callModel-local' })
    if (!res.ok) throw new Error(`Local FM ${res.status}: ${await res.text()}`)
    const data = await res.json()
    return data.choices?.[0]?.message?.content || ''
  }

  // Generic OpenAI-compatible providers (together/cerebras/cohere/fireworks/deepinfra)
  const compat = OPENAI_COMPAT_PROVIDERS[provider]
  if (compat) {
    const modelId = id.slice(id.indexOf('/') + 1)  // strip the provider-key prefix
    const res = await fetch(compat.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env[compat.envVar] ?? ''}`,
      },
      body: JSON.stringify({ model: modelId, messages, max_tokens: compat.maxTokens }),
      signal: callAbort,
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`${provider} ${res.status}: ${err}`)
    }
    const data = await res.json()
    return data.choices?.[0]?.message?.content || ''
  }

  throw new Error(`Unknown provider: ${provider}`)
}

async function callModelInstrumented(
  model: SelectedModel,
  messages: { role: string; content: string }[],
  opts: { requestId?: string } = {},
): Promise<string> {
  const t0 = Date.now()
  try {
    const text = await callModel(model, messages, opts)
    _emitModelResult(model, t0, text, opts.requestId)
    return text
  } catch (e: any) {
    const cleanMsg = (e.message ?? 'unknown error').replace(/\{[\s\S]*\}/g, '[provider error]').trim()
    debugBus.emit('model', 'model_result', { model: model.id, latencyMs: Date.now() - t0, error: cleanMsg }, { severity: 'error', requestId: opts.requestId })
    throw new Error(cleanMsg)
  }
}

// ── Per-model latency stats (rolling, in-memory) ──────────────────────────────
// Per-model latency tracking lives in src/server/latency.ts (unit-testable); these wrappers
// keep the existing call sites while the store + percentile math sit in the LatencyTracker.
const latencyTracker = new LatencyTracker(50)  // modelId → last-50 latency samples
function recordLatency(modelId: string, latencyMs: number): void { latencyTracker.record(modelId, latencyMs) }
function getLatencyReport(): Record<string, { avg: number; p50: number; p95: number; samples: number }> { return latencyTracker.report() }

// Wrap callModel result emission (called after each provider returns)
function _emitModelResult(model: SelectedModel, t0: number, text: string, requestId?: string) {
  const latencyMs = Date.now() - t0
  recordLatency(model.id, latencyMs)
  recordModelOutcome(model.id, true, latencyMs)  // Track Q — viability fingerprint
  debugBus.emit('model', 'model_result', {
    model: model.id, latencyMs,
    outputTokensEst: text.length >> 2,
  }, { severity: 'info', requestId })
}

// ── Streaming caller ──────────────────────────────────────────────────────────
async function callModelStreaming(
  model: SelectedModel,
  messages: { role: string; content: string }[],
  onChunk: (text: string) => void
): Promise<string> {
  const { id, provider } = model
  // Q3 hot-swap fault injection (verification only). CRUCIBLE_FORCE_FAIL is a
  // comma-list of model ids (or "*") that should throw a HARD (non-429,
  // non-decommission) error so the live standby-dispatch path in runStage1Model
  // is exercised deterministically. The "503" in the message makes isServerErrS1
  // true while keeping is429/isDead false, satisfying the hot-swap gate.
  const _forceFail = process.env.CRUCIBLE_FORCE_FAIL
  if (_forceFail && (_forceFail === '*' || _forceFail.split(',').map(s => s.trim()).includes(id))) {
    throw new Error(`[forced-fail] simulated 503 for ${id} (CRUCIBLE_FORCE_FAIL)`)
  }
  // NORTH-STAR TRIPWIRE (see callModel): on-device only; a bundled-key external dispatch
  // is structurally impossible. External providers are allowed ONLY with an explicit BYOK key.
  if (provider !== 'local' && provider !== 'synth' && !currentByokKeys()[provider]) {
    throw new OfflineStrictError(provider)
  }
  // Offline-first gate (see offlineGate). On a local hit the full text is emitted as
  // a single chunk — token-by-token streaming is the documented tradeoff of offline mode.
  const _g = await offlineGate(provider, messages)
  if (_g.handled) { onChunk(_g.text!); return _g.text! }
  messages = withStaticPrefix(messages, model.tpmLimit)
  // 4.2 — pre-dispatch token guard: reject before the wire so an oversized payload
  // can never come back as a reactive 413. Mirrors the guard in callModel().
  const streamTokenEst = estimateMessageTokens(messages)
  if (model.tpmLimit && streamTokenEst > model.tpmLimit) {
    const msg = `Token budget exceeded: ~${streamTokenEst} tokens estimated, limit is ${model.tpmLimit} for ${id}`
    console.warn(`[TokenGuard] ${msg}`)
    debugBus.emit('model', 'token_guard_reject', { model: id, provider, tokenEst: streamTokenEst, tpmLimit: model.tpmLimit }, { severity: 'warn' })
    throw new Error(msg)
  }
  recordProviderCall(provider)

  // Route every hosted provider through the Cloudflare Worker key-proxy when enabled
  // (local FM stays direct). Streams OpenAI-style SSE deltas straight to onChunk.
  if (PROXY_URL && !PROXY_SKIP_PROVIDERS.has(provider)) {
    return await proxyChatStreaming(model, messages, onChunk)
  }

  if (provider === 'groq') {
    const modelId = id.replace(/^groq\//, '')
    const isQwen = modelId.includes('qwen')
    let buf = ''
    const stream = await groq.chat.completions.create({
      model: modelId, messages, stream: true,
      ...(isQwen ? { reasoning_effort: 'none' } : {}),
    } as any) as any
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content || ''
      if (text) { buf += text; if (!isQwen) onChunk(text) }
    }
    const clean = isQwen ? stripThink(buf) : buf
    if (isQwen) onChunk(clean)
    return clean
  }

  if (provider === 'mistral') {
    const modelId = id.replace(/^mistral\//, '')
    let buf = ''
    const stream = await mistral.chat.stream({ model: modelId, messages } as any)
    for await (const chunk of stream) {
      const text = (chunk.data.choices[0]?.delta?.content as string) || ''
      if (text) { buf += text; onChunk(text) }
    }
    return buf
  }

  if (provider === 'openrouter') {
    const modelId = id.replace(/^openrouter\//, '')
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${resolveProviderKey('openrouter')}`,
        'HTTP-Referer': 'https://crucible.local',
        'X-Title': 'Crucible',
      },
      body: JSON.stringify({ model: modelId, messages, stream: true }),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`OpenRouter ${res.status}: ${err}`)
    }
    let sseBuf = '', fullText = ''
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      sseBuf += decoder.decode(value, { stream: true })
      const lines = sseBuf.split('\n')
      sseBuf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') break
        try {
          const j = JSON.parse(data)
          const text = j.choices?.[0]?.delta?.content || ''
          if (text) { fullText += text; onChunk(text) }
        } catch {}
      }
    }
    return fullText
  }

  if (provider === 'huggingface') {
    const modelId = id.replace(/^huggingface\//, '')
    const res = await fetch('https://router.huggingface.co/novita/v3/openai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.VITE_HF_API_KEY}`,
      },
      body: JSON.stringify({ model: modelId, messages, max_tokens: 4096, stream: true }),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`HuggingFace ${res.status}: ${err}`)
    }
    let sseBuf = '', fullText = ''
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      sseBuf += decoder.decode(value, { stream: true })
      const lines = sseBuf.split('\n')
      sseBuf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') break
        try {
          const j = JSON.parse(data)
          const text = j.choices?.[0]?.delta?.content || ''
          if (text) { fullText += text; onChunk(text) }
        } catch {}
      }
    }
    return fullText
  }

  if (provider === 'gemini') {
    const modelId = id.replace(/^gemini\//, '')
    const gModel = gemini.getGenerativeModel({ model: modelId })
    const history = messages.slice(0, -1).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }))
    const last = messages[messages.length - 1]
    const chat = gModel.startChat({ history })
    let buf = ''
    const result = await chat.sendMessageStream(last.content)
    for await (const chunk of result.stream) {
      const text = chunk.text()
      if (text) { buf += text; onChunk(text) }
    }
    return buf
  }

  // Generic OpenAI-compatible providers — SSE streaming (identical delta parsing to openrouter/hf)
  const compat = OPENAI_COMPAT_PROVIDERS[provider]
  if (compat) {
    const modelId = id.slice(id.indexOf('/') + 1)
    const res = await fetch(compat.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env[compat.envVar] ?? ''}`,
      },
      body: JSON.stringify({ model: modelId, messages, max_tokens: compat.maxTokens, stream: true }),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`${provider} ${res.status}: ${err}`)
    }
    let sseBuf = '', fullText = ''
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      sseBuf += decoder.decode(value, { stream: true })
      const lines = sseBuf.split('\n')
      sseBuf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') break
        try {
          const j = JSON.parse(data)
          const text = j.choices?.[0]?.delta?.content || ''
          if (text) { fullText += text; onChunk(text) }
        } catch {}
      }
    }
    return fullText
  }

  // Cloudflare: batch only (fast small models, no streaming API)
  const text = await callModel(model, messages)
  onChunk(text)
  return text
}

// ── /api/config — expose pipeline config to frontend ─────────────────────────
// ── /api/checkpoint — surface any resumable iteration checkpoints ────────────
app.get('/api/checkpoint', (_req, res) => {
  const checkpoints = findAllCheckpoints()
  res.json({ checkpoints })
})

app.delete('/api/checkpoint', (req, res) => {
  const { projectPath } = req.body
  if (projectPath) clearCheckpoint(path.resolve(projectPath))
  res.json({ ok: true })
})

app.get('/api/config', (_req, res) => {
  res.json({
    parallelCount: PIPELINE_CONFIG.parallelCount,
    wildcardCount: PIPELINE_CONFIG.wildcardCount,
    // The server reads CRUCIBLE_OFFLINE from its OWN process env at startup — a client
    // setting this var on itself (e.g. a benchmark script) has no effect on this value.
    // Exposed so callers can verify the running server is actually in the mode they think
    // it's in, instead of silently testing whatever mode happened to be live.
    offlineMode: process.env.CRUCIBLE_OFFLINE ?? '1',
  })
})

// ── /api/waitlist — waitlist + probation status ───────────────────────────────
app.get('/api/waitlist', (_req, res) => {
  res.json(waitlistStatus(process.cwd()))
})

// ── /api/integrations — external agentic tool drawer (GitHub CLI first) ───────
// All integrations are locally-executed open-source CLIs (external-tool
// invariant); enabling one is always an explicit human action from the drawer.
app.get('/api/integrations', async (_req, res) => {
  try { res.json({ integrations: await listIntegrations() }) }
  catch (e: any) { res.status(500).json({ error: e?.message ?? 'list failed' }) }
})

app.post('/api/integrations', async (req, res) => {
  try {
    const r = await addCustomIntegration({
      name: String(req.body?.name ?? ''),
      command: String(req.body?.command ?? ''),
      description: typeof req.body?.description === 'string' ? req.body.description : undefined,
      keywords: Array.isArray(req.body?.keywords) ? req.body.keywords.map(String) : undefined,
    })
    if (!r.ok) return res.status(400).json({ error: (r as { error: string }).error })
    // Register its agent tool immediately — no restart needed. (Still hidden from
    // the model until the user flips the enable toggle.)
    if (!registry.get(r.entry.id.replace(/-/g, '_'))) registry.register(cliToolForEntry(r.entry))
    res.json({ integration: r.entry })
  } catch (e: any) { res.status(500).json({ error: e?.message ?? 'add failed' }) }
})

app.post('/api/integrations/:id/toggle', (req, res) => {
  const enabled = req.body?.enabled === true
  const entry = setIntegrationEnabled(String(req.params.id), enabled)
  if (!entry) return res.status(404).json({ error: 'unknown integration' })
  debugBus.emit('system', 'integration_toggle', { id: entry.id, enabled })
  res.json({ integration: entry })
})

app.delete('/api/integrations/:id', (req, res) => {
  if (!removeIntegration(String(req.params.id))) {
    return res.status(400).json({ error: 'unknown integration, or builtin (builtins can be disabled, not removed)' })
  }
  res.json({ ok: true })
})

// Recommendations for the current request draft: deterministic keyword match,
// sharpened by the LOCAL Apple FM when it is up — zero external model calls.
app.post('/api/integrations/recommend', async (req, res) => {
  try {
    const goal = String(req.body?.goal ?? '')
    res.json({ recommendations: await recommendIntegrations(goal, fmComplete) })
  } catch (e: any) { res.status(500).json({ error: e?.message ?? 'recommend failed' }) }
})

// ── /api/task-graph — persistent multi-session task graphs ────────────────────
// GET    list open graphs (each with node progress for the UI)
// POST   create a graph from { goal } (heuristic decomposition, no model call)
// DELETE :id  mark a graph complete/abandoned (removes it from the open list)
app.get('/api/task-graph', (_req, res) => {
  try {
    const graphs = getOpenGraphs().map(g => ({
      id: g.id,
      goal: g.goal,
      created: g.created,
      status: g.status,
      total: g.nodes.length,
      done: g.nodes.filter(n => n.status === 'done').length,
      nodes: g.nodes.map(n => ({ id: n.id, goal: n.goal, status: n.status, assignedArchetype: n.assignedArchetype })),
    }))
    res.json({ graphs })
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) })
  }
})

app.post('/api/task-graph', (req, res) => {
  const goal = typeof req.body?.goal === 'string' ? req.body.goal.trim() : ''
  if (goal.length < 4) { res.status(400).json({ error: 'Missing or too-short goal' }); return }
  try {
    const graph = createGraph(goal)
    res.json({ graph })
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) })
  }
})

app.delete('/api/task-graph/:id', (req, res) => {
  const status = req.body?.status === 'done' ? 'done' : 'abandoned'
  const graph = setGraphStatus(req.params.id, status)
  if (!graph) { res.status(404).json({ error: 'Graph not found' }); return }
  res.json({ ok: true, graph })
})

// ── /api/research — Session J: autonomous research mode (SSE) ─────────────────
// Drives the iterative search→read→extract→gap→synthesize→audit loop and streams
// research_step / research_done events in the same SSE shape the frontend consumes.
function pickResearchModel(): any {
  const active = (MODEL_REGISTRY as any[]).filter(m => getCircuitState(m.id) === 'active')
  return active.find(m => m.provider === 'groq') ?? active[0] ?? (MODEL_REGISTRY as any[])[0] ?? null
}

// Session N — publish the latest benchmark result to the Worker so the public dashboard
// (GET /api/benchmarks/public) shows real data. Best-effort; only when the proxy is set.
async function publishBenchmarks(): Promise<void> {
  if (!PROXY_URL) return
  try {
    const body = fs.readFileSync(path.join(process.cwd(), '.crucible', 'smoke-last.json'), 'utf8')
    await fetch(`${PROXY_URL}/api/benchmarks/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PROXY_JWT}` },
      body,
      signal: AbortSignal.timeout(8000),
    })
  } catch { /* best-effort — dashboard just keeps its prior value */ }
}

// Session E — LLM domain classifier used by the routing active-learning loop.
async function classifyMissDomain(query: string): Promise<string> {
  const model = pickResearchModel()
  if (!model) return 'general'
  try {
    const out = await callModel(model, [{
      role: 'user',
      content: `Classify this query into exactly one knowledge domain from this list: ${DOMAIN_SHARDS.join(', ')}.\nReply with ONLY the domain name, nothing else.\n\nQuery: ${query}`,
    }], { timeoutMs: 4000 })
    const d = (out ?? '').trim().toLowerCase().split(/\s+/)[0]
    return d || 'general'
  } catch { return 'general' }
}
app.post('/api/research', async (req, res) => {
  const question = (typeof req.body?.message === 'string' ? req.body.message
    : typeof req.body?.question === 'string' ? req.body.question : '').trim()
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  const send = (p: object) => { try { res.write(`data: ${JSON.stringify(p)}\n\n`) } catch {} }
  if (!question) { send({ type: 'research_error', text: 'A research question is required.' }); res.write('data: [DONE]\n\n'); return res.end() }

  // V2: Gen-2 research DAG (local FM + provenance oracle, no external model).
  // Falls back to Gen-1 (runResearchSession) only when CRUCIBLE_RESEARCH_V1=1 is set.
  if (process.env.CRUCIBLE_RESEARCH_V1 === '1') {
    const model = pickResearchModel()
    const deps = {
      search: async (q: string) => {
        try { const t = registry.get('web_search'); if (!t) return ''; const r: any = await (t as any).run({ query: q }, {}); return r?.output ?? '' } catch { return '' }
      },
      model: async (prompt: string) => {
        if (!model) return ''
        try { return await callModelInstrumented(model, [{ role: 'user', content: prompt }]) } catch { return '' }
      },
      readSource: async (url: string) => { try { return await read_pdf(url) } catch { return '' } },
    }
    try {
      for await (const ev of runResearchSession(question, { maxIterations: 4, minSources: 4 }, deps)) send(ev)
    } catch (e: any) {
      send({ type: 'research_error', text: e?.message ?? 'research failed' })
    }
  } else {
    try {
      for await (const ev of runResearchDag(question, {
        projectDir: process.cwd(),
        maxLeafNodes: 6,
        maxWebPages: 10,
        maxMs: 90_000,
      })) send(ev)
    } catch (e: any) {
      send({ type: 'research_error', text: e?.message ?? 'research DAG failed' })
    }
  }
  res.write('data: [DONE]\n\n'); res.end()
})

// POST /api/corpus/learn-routes — Session E: run the routing active-learning cycle now
// (also runs hourly via the improvement daemon's routing_learn task).
app.post('/api/corpus/learn-routes', async (_req, res) => {
  try {
    const result = await runLearningCycle(classifyMissDomain, { batch: 20, gapMs: 1500 })
    res.json({ ok: true, ...result })
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message ?? 'learn-routes failed' })
  }
})

// ── Session L: TTS + Remote Brain cellular tunnel ────────────────────────────
// POST /api/tts — speak text on the Mac's speakers (Remote Brain agent talkback + voice mode).
// `wait: true` (voice conversation mode) resolves AFTER playback finishes so the client knows
// exactly when to re-open the mic; without it the old fire-and-forget behavior is kept so the
// Remote Brain response path is never blocked.
app.post('/api/tts', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text : ''
  const wait = req.body?.wait === true
  if (!text.trim()) return res.json({ ok: true })
  if (wait) { await speak(text).catch(() => {}); return res.json({ ok: true, spoken: true }) }
  speak(text).catch(() => {})
  res.json({ ok: true })
})

// GET /api/voice/status — is the local whisper.cpp voice stack installed? The composer's mic
// button uses this to decide between "dictate" and "guide the user to setup".
app.get('/api/voice/status', async (_req, res) => {
  try { res.json({ ok: true, ...(await voiceStatus()) }) }
  catch (e: any) { res.status(500).json({ ok: false, error: String(e?.message ?? e) }) }
})

// POST /api/voice/transcribe — on-device speech-to-text. Accepts a base64 audio data URL from
// the browser's MediaRecorder, runs it through local whisper.cpp, returns the text. When the
// local stack isn't installed yet it returns { needsModel:true } so the UI prompts setup.
app.post('/api/voice/transcribe', express.json({ limit: '25mb' }), async (req, res) => {
  const audio = String(req.body?.audio || '')
  if (!audio) return res.status(400).json({ error: 'missing audio' })
  try {
    // strict:false weakens discriminated-union narrowing on this multi-branch result,
    // so read through a permissive view (runtime shape is the TranscribeResult union).
    const r = await transcribeAudio(audio, String(req.body?.mime || 'audio/webm')) as
      { ok: boolean; text?: string; needsModel?: boolean; status?: unknown; error?: string }
    if (r.ok) return res.json({ ok: true, text: r.text })
    if (r.needsModel) return res.json({ ok: false, needsModel: true, status: r.status })
    return res.status(500).json({ ok: false, error: r.error })
  } catch (e: any) { res.status(500).json({ ok: false, error: String(e?.message ?? e) }) }
})

// A single quick tunnel reused across calls so we don't spawn one per request.
let _remoteTunnel: { url: string; cp?: import('child_process').ChildProcess } | null = null
// POST /api/remote-brain/tunnel/start — spin up a Cloudflare quick tunnel that points
// DIRECTLY at this Mac (origin localhost:3001), giving the phone an https/wss path to
// the screen stream from cellular / a different network. Returns the trycloudflare URL.
app.post('/api/remote-brain/tunnel/start', (_req, res) => {
  if (process.platform !== 'darwin') return res.status(503).json({ ok: false, error: 'Remote Brain tunnel requires macOS' })
  if (_remoteTunnel) return res.json({ ok: true, url: _remoteTunnel.url, reused: true })
  let done = false
  const finish = (status: number, body: any) => { if (done) return; done = true; res.status(status).json(body) }
  try {
    const cp = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${Number(process.env.PORT) || 3001}`], { stdio: ['ignore', 'pipe', 'pipe'] })
    const onData = (buf: Buffer) => {
      const m = buf.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
      if (m) { _remoteTunnel = { url: m[0], cp }; finish(200, { ok: true, url: m[0] }) }
    }
    cp.stdout.on('data', onData)
    cp.stderr.on('data', onData)   // cloudflared prints the assigned URL to stderr
    cp.on('error', (e) => finish(500, { ok: false, error: e.message }))
    cp.on('exit', () => { if (!done) finish(500, { ok: false, error: 'cloudflared exited before announcing a URL' }); _remoteTunnel = null })
    setTimeout(() => finish(504, { ok: false, error: 'tunnel did not start within 25s' }), 25000)
  } catch (e: any) { finish(500, { ok: false, error: e?.message ?? 'spawn failed' }) }
})

// ── /api/config — update pipeline config at runtime ──────────────────────────
app.post('/api/config', (req, res) => {
  const { parallelCount, wildcardCount } = req.body
  if (typeof parallelCount === 'number' && parallelCount >= 2) {
    PIPELINE_CONFIG.parallelCount = parallelCount
  }
  if (typeof wildcardCount === 'number' && wildcardCount >= 0) {
    PIPELINE_CONFIG.wildcardCount = Math.min(wildcardCount, PIPELINE_CONFIG.parallelCount - 1)
  }
  console.log(`[Config] Updated: parallelCount=${PIPELINE_CONFIG.parallelCount} wildcardCount=${PIPELINE_CONFIG.wildcardCount}`)
  res.json({ parallelCount: PIPELINE_CONFIG.parallelCount, wildcardCount: PIPELINE_CONFIG.wildcardCount })
})


// ── /api/prewarm — predictive pre-warm on keypress ───────────────────────────
interface PrewarmEntry {
  token: string
  modelId: string
  result: Promise<string>
  resolvedText?: string
  createdAt: number
}
// keyed by `token:modelId`
const prewarmCache = new Map<string, PrewarmEntry>()

function clearPrewarmToken(token: string) {
  for (const key of prewarmCache.keys()) {
    if (key.startsWith(token + ':')) prewarmCache.delete(key)
  }
}

app.post('/api/prewarm', async (req, res) => {
  const { query, token } = req.body
  if (!query || !token) { res.status(400).json({ error: 'Missing query or token' }); return }

  // Cancel any existing prewarm for this token
  clearPrewarmToken(token)

  const promptType = classifyPrompt(query)
  const complexity = scoreComplexity(query)
  const config = complexity === 'simple' ? SIMPLE_PIPELINE_CONFIG : PIPELINE_CONFIG
  const { models } = selectModels(promptType, config, complexity, 'quorum')

  const modelIds: string[] = []
  for (const model of models) {
    const ragContext = getAspectContext(model.id, promptType, 'deterministic', models.indexOf(model))
    const messages = [
      { role: 'system', content: ragContext },
      { role: 'user', content: query },
    ]
    const entry: PrewarmEntry = {
      token,
      modelId: model.id,
      result: Promise.resolve(''),
      createdAt: Date.now(),
    }
    entry.result = callModel(model, messages).then(text => {
      entry.resolvedText = text
      return text
    }).catch(() => '')
    prewarmCache.set(`${token}:${model.id}`, entry)
    modelIds.push(model.id)
  }

  console.log(`[Prewarm] Started — ${models.map(m => m.label).join(', ')}, token: ${token}`)
  res.json({ ok: true, modelIds })
})

// ── ensemble_solve — the scoring pipeline as a worker tool for the driver ────
// Crucible's differentiator: the driver can hand a hard, bounded sub-problem to
// the parallel ensemble and get back the best contract-scored candidate.
registry.register({
  name: 'ensemble_solve',
  description: 'Solve ONE hard, bounded sub-problem (a tricky function, algorithm, or test) by running multiple models in parallel and returning the highest-scored candidate. Use for the genuinely hard core of a task, not routine code.',
  params: {
    type: 'object',
    properties: {
      subprompt: { type: 'string', description: 'Self-contained description of the sub-problem, with any needed context inlined' },
    },
    required: ['subprompt'],
  },
  async run(args) {
    const subprompt = String(args.subprompt ?? '')
    if (!subprompt) return { ok: false, output: 'subprompt required' }
    const t0 = Date.now()
    const promptType = classifyPrompt(subprompt)
    const { models } = selectModels(promptType, SIMPLE_PIPELINE_CONFIG, 'complex', 'quorum')
    const contract = generateContract(subprompt, promptType)
    const workers = models.slice(0, 3)
    console.log(`[Ensemble] solve(${promptType}) via ${workers.map(m => m.label).join(', ')}`)
    const candidates = await Promise.all(workers.map(m =>
      withTimeout(callModel(m, [
        { role: 'system', content: contract.systemPrompt },
        { role: 'user', content: subprompt },
      ]).catch(() => ''), 30_000, '')
    ))
    let best = ''; let bestScore = -1; let bestModel = ''
    candidates.forEach((text, i) => {
      if (!text) return
      const r = evaluateIteration(
        { proposedSource: text, problemStatement: subprompt, pipelineLayer: 1, promptType, contract },
        SCORING_CONFIG, 1,
      )
      if (r.score.compositeScore > bestScore) { bestScore = r.score.compositeScore; best = text; bestModel = workers[i].label }
    })
    if (!best) return { ok: false, output: 'All ensemble workers failed or timed out.' }
    return {
      ok: true,
      output: best,
      meta: { model: bestModel, score: Number(bestScore.toFixed(3)), ms: Date.now() - t0, candidates: candidates.filter(Boolean).length },
    }
  },
})

/** Imperative coding request that wants ACTIONS (write files, run them), not just code to read.
 *  "show me code / a snippet / an example" is a DISPLAY request → belongs in the ensemble
 *  pipeline (renders code in chat), NOT the file-writing agent loop. */
function detectAgentTask(message: string): boolean {
  // Routing must see only what the USER typed. Attachment plumbing appends the composer's
  // note and (after foldAttachmentContext) the attached files' CONTENT — and file content
  // trivially matches build-ish regexes below (any attached .ts file contains ".ts"), which
  // hijacked "what can you tell me about this file?" onto the agent path (cont.66k report).
  message = message.split('\nATTACHED FILE CONTENT')[0].split(/\[User attached \d+ file\(s\)/)[0]
  const m = message.toLowerCase()
  // Display-only intent — user wants to SEE code, not have files written/run.
  const wantsDisplay = /\b(show|display|paste|print|give)\b[\s\S]{0,30}\bcode\b/.test(m)
    || /\bjust (the )?code\b/.test(m) || /\b(snippet|example)\b/.test(m)
    || /\bhow (do|to|can|would)\b/.test(m) || /\bwhat('?s| is| does)\b/.test(m)
  // Strong build/execute signals — an actual artifact or run is requested.
  const wantsBuild =
    // Buildable-artifact nouns: "game" & friends were missing until 2026-07-07 —
    // "build me a fully playable snake game" matched NOTHING in this function, fell
    // through to the offline chat brain, timed out, and strict-abstained with a refusal.
    // A request to build a game/tool/demo is exactly as agentic as one to build an app.
    /\b(create|write|build|make|add|implement|generate|scaffold)\b[\s\S]{0,40}\b(file|script|app|application|website|page|module|package|component|server|api|directory|folder|repo|project|game|clone|tool|calculator|dashboard|demo|prototype|simulator|simulation|visuali[sz]ation|animation|widget|editor|quiz|puzzle)\b/.test(m)
    // Runnable-deliverable adjectives: "playable"/"working"/"interactive" promise an
    // artifact that RUNS — display-in-chat can't satisfy that, only the agent can.
    || /\b(build|create|make|write|code|program|implement|generate)\b[\s\S]{0,60}\b(playable|interactive|working|functional|runnable|from scratch)\b/.test(m)
    || /\b(run|execute|compile|install|deploy|and run|then run|make it work|get it working|build it)\b/.test(m)
    || /\.(py|js|ts|tsx|jsx|html|css|json|sh|go|rs|java|cpp|c|rb|php)\b/.test(m)
    || /\b(save|write|put)\b[\s\S]{0,20}\b(to|into|as|in)\b[\s\S]{0,20}\.[a-z]/.test(m)
    || /\b(delete|remove|trash|erase|wipe|empty|clean up)\b[\s\S]{0,60}\b(file|folder|directory|image|photo|download|bin|recycling)\b/.test(m)
    || /\b(move|copy|rename|organize|sort)\b[\s\S]{0,40}\b(file|folder|image|photo|download)\b/.test(m)
    // A code-symbol rename ("rename pad to padLeft") has no "file" noun but is squarely an
    // agent/refactor task — the VGR rename block infers the defining file and rewrites call sites.
    || /\brename\s+(?:the\s+)?(?:function\s+|method\s+)?[a-z_$][\w$]*\s+(?:to|as|into)\s+[a-z_$][\w$]*\b/i.test(message)
    // Project-wide unused-import cleanup ("remove all unused imports") — a whole-tree refactor.
    || detectPruneImportsAll(message)
    || /\b(download|fetch|grab|save)\b[\s\S]{0,40}\b(image|photo|file|url|link)\b/.test(m)
    || /\b(create|make|open|launch)\b[\s\S]{0,30}\b(folder|directory)\b/.test(m)
    || /\b(write|save|create)\b[\s\S]{0,40}\b(file|markdown|document|note|report)\b/.test(m)
    // "write a function/class" = code display in chat (stays in pipeline); only trigger
    // agent if there's also a file target (.py extension, "to file", "save to", etc.)
    // || /\b(write|implement|create|build|make)\b[\s\S]{0,60}\b(function|class|algorithm|solution|program|script|module|library)\b/.test(m)
    || /\b(with a test|and test|and verify|that works|make it run|and run it)\b/.test(m)
    || /\b(search|find|look up)\b[\s\S]{0,40}\b(and|then)\b[\s\S]{0,40}\b(save|write|create|download|open)\b/.test(m)
    || /\b(open|show|reveal)\b[\s\S]{0,20}\b(finder|folder|directory|desktop)\b/.test(m)
  // External system execution — action verbs directed at media/app/service targets.
  // "put on a video", "play something on Spotify", "search YouTube and play" → agent executes, not text response.
  const EXEC_VERBS = /\b(put on|play|open|launch|pull up|start|queue(?: up)?|navigate to|go to|turn on|switch to)\b/
  const EXTERNAL_TARGETS = /\b(youtube|spotify|netflix|apple music|music|podcast|video|song|playlist|calendar|gmail|mail|maps|browser|chrome|safari|finder|app)\b/
  const wantsExternalExec =
    (EXEC_VERBS.test(m) && EXTERNAL_TARGETS.test(m))
    || /\b(search|find|look up)\b[\s\S]{0,60}\b(youtube|spotify|netflix|apple music)\b[\s\S]{0,60}\b(and|then)\b[\s\S]{0,40}\b(play|put on|open|watch|listen|queue)\b/.test(m)
  // Mac UI control commands — Remote Brain "eyes and hands" actions
  const wantsMacControl =
    /\b(click|tap|press)\b[\s\S]{0,60}\b(button|link|tab|icon|menu|item|field|checkbox)\b/.test(m)
    || /\b(type|enter|input|fill in)\b[\s\S]{0,40}\b(in|into|on|the)\b/.test(m)
    || /\b(go to|navigate to|switch to|bring up)\b[\s\S]{0,30}\b(desktop|screen|window|tab|dock|menu bar|app|application)\b/.test(m)
    || /\b(close|minimize|maximize|hide|show)\b[\s\S]{0,30}\b(window|app|application|tab)\b/.test(m)
    || /\b(scroll|swipe)\b[\s\S]{0,30}\b(up|down|left|right|to)\b/.test(m)
    || /\bon my mac\b|\bon the mac\b/.test(m)
  // Short confirmation replies — only meaningful with agent history context
  const isConfirmation = /^\s*(yes|yeah|yep|ok|okay|sure|proceed|go ahead|do it|confirm|continue|approved|affirmative|correct|right|exactly|please do|go for it)[\.!]?\s*$/i.test(m)
  if (wantsDisplay && !wantsBuild && !wantsExternalExec && !wantsMacControl && !isConfirmation) return false
  return wantsBuild || wantsExternalExec || wantsMacControl || isConfirmation
}

// A short repair/continuation reply ("try again", "fix it", "another way?", "run it",
// "it didn't work") that only makes sense as a follow-up to an in-progress agent task.
// Used for STICKY AGENTIC ROUTING: combined with a recent agent task in the same chat
// session, these keep the conversation on the tool-capable agent path instead of
// silently bouncing to the tool-less quorum pipeline (which can only hallucinate about
// file/system state — the "fix and try again → unrelated regex answer" failure).
function isContinuationPhrase(message: string): boolean {
  const m = (message ?? '').trim().toLowerCase()
  if (!m) return false
  if (/\b(try again|retry|another way|other way|different (way|approach)|keep going|go on|run it|do it now|now (run|try|do|open|fix|change|delete|move)|did(n'?t| not) work|does(n'?t| not) work|still (broken|failing|not working|fails?|errors?)|same error|that failed|it failed|fix (it|that|this|the error|the bug|manually))\b/.test(m)) return true
  const words = m.split(/\s+/).length
  if (words <= 6 && /\b(fix|run|try|open|continue|retry|again|execute|build|rebuild|change|update|delete|move|undo|redo|finish)\b/.test(m)) return true
  return false
}

// Sticky-routing signal: does this chat session have an agent task running now, or one
// completed within the last 15 minutes? If so, ambiguous follow-ups belong on the agent
// path. Pure read — never creates a session.
function hasRecentAgentTask(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false
  const s = getSession(sessionId)
  if (!s) return false
  if (s.status === 'running') return true
  const last = s.taskStack[s.taskStack.length - 1]
  return !!last && (Date.now() - last.completedAt) < 15 * 60_000
}

// Hard execution signals — a real artifact/run is unambiguously requested. Used to
// keep creative-prose requests OUT of the agent loop unless the user clearly wants
// files written or commands run (e.g. "write a python script that prints primes").
function hasHardExecSignal(message: string): boolean {
  const m = message.toLowerCase()
  return /\.(py|js|ts|tsx|jsx|html|css|json|sh|go|rs|java|cpp|c|rb|php)\b/.test(m)
    || /\b(run|execute|compile|install|deploy|make it work|get it working|build it|and run it)\b/.test(m)
    || /\b(create|write|build|make|add|generate|scaffold)\b[\s\S]{0,40}\b(file|app|application|website|page|module|package|component|server|api|directory|folder|repo|project)\b/.test(m)
    || detectExternalExecIntent(message)
}

// "script", "story", "character", "plot" are ambiguous between creative writing and
// code. When the prompt classifies as creative AND carries no hard exec signal, it is
// a writing request — never route it to the code agent (that's the "story → wall of
// code" bug). A genuine "write a python script" still has a hard exec signal and passes.
function isCreativeProse(message: string): boolean {
  return classifyPrompt(message) === 'creative' && !hasHardExecSignal(message)
}

// Returns true when the message contains an executable intent toward an external system.
// Used to inject a stronger execution directive into the agent system preamble.
function detectExternalExecIntent(message: string): boolean {
  const m = message.toLowerCase()
  const EXEC_VERBS = /\b(put on|play|open|launch|pull up|start|queue(?: up)?|navigate to|go to|turn on|switch to)\b/
  const EXTERNAL_TARGETS = /\b(youtube|spotify|netflix|apple music|music|podcast|video|song|playlist|calendar|gmail|mail|maps|browser|chrome|safari|finder|app)\b/
  return (EXEC_VERBS.test(m) && EXTERNAL_TARGETS.test(m))
    || /\b(search|find|look up)\b[\s\S]{0,60}\b(youtube|spotify|netflix|apple music)\b[\s\S]{0,60}\b(and|then)\b[\s\S]{0,40}\b(play|put on|open|watch|listen|queue)\b/.test(m)
}

// Translate a Layer-2 FM plan step (which uses the FM planner's own tool vocabulary)
// into a registry ToolCall. Without this, registry.exec reads `.name` (undefined on the
// raw {tool,args} step) → "Unknown tool: undefined", and the FM tool names/arg shapes
// don't all match the registry (shell_exec→run, search_web→web_search, click_element
// label→title). Fixing this makes Layer 2 actually execute on-device.
function fmStepToToolCall(step: { tool: string; args: Record<string, unknown> }, i: number) {
  const NAME_MAP: Record<string, string> = { shell_exec: 'run', search_web: 'web_search' }
  const name = NAME_MAP[step.tool] ?? step.tool
  const args: Record<string, unknown> = { ...(step.args ?? {}) }
  if (step.tool === 'click_element' && 'label' in args && !('title' in args)) {
    args.title = args.label
    delete args.label
  }
  return { id: `fm_${i}`, name, args }
}

// D3 — for a vague agent goal, return a one-line assumption the agent will proceed
// under (announced, never blocking). null when the goal is specific enough. This keeps
// the agent fully autonomous: it states its reasonable defaults rather than asking.
function buildAssumptionNote(message: string): string | null {
  const m = (message ?? '').toLowerCase()
  const words = (message ?? '').trim().split(/\s+/).length
  const vagueVerb = /\b(improve|optimi[sz]e|fix|clean ?up|refactor|enhance|update|sort out|make .*better|polish|tidy)\b/.test(m)
  if (vagueVerb && words < 9) {
    return `Proceeding autonomously on "${message.slice(0, 60)}${message.length > 60 ? '…' : ''}" with sensible defaults — I'll make reasonable choices and you can redirect me at any time.`
  }
  return null
}

// A task whose deliverable is WRITTEN CODE at specific paths belongs on the coding loop
// (planner/single-loop with the full Coder toolset + execution verification), NOT the
// meta-router. The meta-router decomposes and `selectArchetype` DEFAULTS ambiguous
// subtasks to the Researcher — which then web-searches and returns prose (a coding bench
// run produced research about Go LRU caches instead of a TypeScript module, and wrote no
// file). The single/planned coding loop still has web_search if it needs to look something
// up, and actually writes + runs the code.
function isCodeImplementationTask(message: string): boolean {
  const m = message ?? ''
  const buildVerb = /\b(implement|build|write|create|develop|code|scaffold|refactor)\b/i.test(m)
  const hasCodePath = /\b[\w./-]+\.(ts|tsx|js|jsx|py|go|rs|java|cpp|cc|c|rb|php|swift|kt)\b/.test(m)
  const codeNoun = /\b(function|class|module|interface|api|endpoint|algorithm|parser|engine|component|library|package|cli|data structure|test suite|self-test)\b/i.test(m)
  return buildVerb && (hasCodePath || codeNoun)
}

// Edit-phrased code requests ("add a slugify function to src/strings.ts", "modify
// utils.ts to …") don't match isCodeImplementationTask (which requires a build verb),
// so historically they routed to the model-driven agent loop and shipped PLAUSIBLE-BUT-
// UNVERIFIED edits. This detector lets them reach the VGR block instead, whose emitPlan
// APPENDS certified code to the named file (recompile-checked, never corrupts it).
// Conservative: an edit verb AND an explicit code path — the path is required anyway for
// emitPlan's append target, and demanding it keeps prose ("add two numbers") from matching.

// WEB grounding for the VGR research loop (channel 3): on a stall, fetch reference
// implementations/API-usage from the open web (StackOverflow/docs) as PROPOSER grounding — the
// candidate that adapts it is still EXECUTED against the derived spec, so this can never certify a
// false answer (doctrine-sound). Only wired when CRUCIBLE_CODE_WEB_GROUND=1 (network + latency, and
// it only fires on the converge path's stall). Best-effort: any failure → null → the loop proceeds.
async function codeWebGround(query: string): Promise<string | null> {
  try {
    const bundle = await retrieveCodeRefs({ goal: query }, { budget: 1500, maxPages: 2 })
    const block = bundle.block?.trim()
    return block ? block : null
  } catch { return null }
}
const webGroundOrNull = process.env.CRUCIBLE_CODE_WEB_GROUND === '1' ? codeWebGround : undefined

function isCodeEditTask(message: string): boolean {
  const m = message ?? ''
  const editVerb = /\b(add|append|insert|modify|change|update|extend|patch|edit|include|rewrite|fix|correct|repair|improve|adjust|replace|refactor|rename|move|relocate|extract|delete|remove|drop|prune|organi[sz]e|tidy|clean)\b/i.test(m)
  const hasCodePath = /\b[\w./-]+\.(ts|tsx|js|jsx|py|go|rs|java|cpp|cc|c|rb|php|swift|kt)\b/.test(m)
  // A "rename X to Y" or "remove all unused imports" with no file path still routes: the blocks
  // infer the target(s) themselves.
  return (editVerb && hasCodePath) || detectRename(m) != null || detectPruneImportsAll(m)
}

// Decide whether a goal warrants the multi-specialist meta-router (decompose →
// specialist DAG → critic → strategist synthesis) instead of the planner/loop.
// Gate conservatively: genuine multi-part work spanning ≥2 specialist archetypes
// OR carrying real cross-subtask dependencies. Single-domain tasks use the cheaper path.
function shouldUseMetaRouter(message: string): boolean {
  try {
    // Pure code-implementation goals bypass the meta-router (see above) → coding loop.
    if (isCodeImplementationTask(message)) return false
    const subs = decompose(message ?? '').nodes.filter(n => n.depth > 0)
    if (subs.length < 2) return false
    const archetypes = new Set(subs.map(n => selectArchetype(n.goal)))
    const hasDeps = subs.some(n => n.dependsOn.some(d => subs.some(s => s.id === d)))
    return archetypes.size >= 2 || hasDeps
  } catch { return false }
}

app.post('/api/chat', async (req, res) => {
  // v3: the DEFAULT mode is 'code' (Crucible-local). 'quorum' is only ever sent by the
  // client after the explicit per-query ensemble confirm — it is never a fallback.
  // `message` is mutable: a bare "/<tool> natural language" slash whose args can't be
  // mapped mechanically gets rewritten into an agent-loop goal (see the slash block).
  let { message } = req.body
  const { mode = 'code', prewarmToken, device = 'desktop', history = [], sessionId: reqSessionId, roundId: reqRoundId, conversationId: reqConversationId, byokKeys } = req.body
  // BYOK: scope any user-supplied provider keys to this request's async context so the
  // external pipeline runs on the USER's keys, never a bundled/shared one (product
  // constraint). Local/synth paths ignore this. No-op when no keys are sent.
  enterByokKeys(byokKeys)
  // Attachment contextual awareness (cont.66k): if the composer folded an attachment note
  // into the message, replace it with the actual file CONTENT (text inline, images via
  // on-device Vision OCR) so the brain can act on what was attached, not just see a path.
  try { message = await foldAttachmentContext(String(message ?? ''), sandboxResolve) } catch { /* never blocks a send */ }
  // ── NORTH STAR (non-negotiable): on-device models ONLY. No external / token-limited
  // provider is ever called from a model dispatch — not as a default, not as a fallback, and
  // not for the 'quorum' ensemble. Earlier this was `mode==='quorum' ? env : 'strict'`, which
  // left a hole: a quorum request escalated to Groq/Gemini/Mistral using the BUNDLED keys in
  // .env.local (the "I was made by AC/DC / by a leading technology company" cloud answers).
  // requestOffline is now HARD-PINNED to 'strict' for every request, so offlineGate throws on
  // any external escalation and the answer engine (answerQuery) serves it fully on-device.
  const requestOffline: string = 'strict'
  const chatSessionId = typeof reqSessionId === 'string' ? reqSessionId : ''
  const chatRoundId = typeof reqRoundId === 'string' ? reqRoundId : ''
  // Register roundId → conversationId so the completion patch can update the grouped
  // conversation store even if the client disconnects before the answer finishes.
  if (chatRoundId && typeof reqConversationId === 'string' && reqConversationId) {
    roundConversation.set(chatRoundId, reqConversationId)
    if (roundConversation.size > 500) roundConversation.delete(roundConversation.keys().next().value as string)
  }

  // ── Build-negotiation resolution ─────────────────────────────────────────────
  // After a build has been under discussion, an explicit greenlight ("build the game",
  // "i trust you, do your thing", "go ahead") must ASSEMBLE the accumulated spec from history
  // and route to the real builder — not let the weak FM role-play another planning outline.
  // Deterministic; passthrough when the turn isn't a greenlight or no topic was established.
  const buildTurn = resolveBuildTurn(message ?? '', Array.isArray(history) ? history : [])
  // The goal handed to the agent/builder. Defaults to the user's literal message; the negotiation
  // resolver overrides it with a concrete, buildable spec when it fires. `message` stays intact
  // for history/persistence fidelity.
  const agentGoal = buildTurn.action === 'build' && buildTurn.spec ? buildTurn.spec : (message ?? '')
  if (buildTurn.action === 'build') {
    debugBus.emit('agent', 'build_negotiation_resolved', { topic: buildTurn.topic, downscoped: !!buildTurn.note }, { severity: 'info' })
  }

  const chatUser = getAuthUser(req)
  // ── Register this run as a server-owned task and buffer its event stream ──────
  // One write-hook captures EVERY 'data:' line (both the agent path and the synthesis
  // pipeline write through res), so a client that disconnects can reconnect and replay.
  // The task keeps running and buffering regardless of whether the browser is attached.
  if (chatRoundId) {
    const task = taskRegistry.get(chatRoundId) ?? createTask(chatRoundId, chatUser?.id ?? null)
    const origWrite = res.write.bind(res)
    const origEnd = res.end.bind(res)
    ;(res as any).write = (chunk: any, ...rest: any[]) => {
      try { if (typeof chunk === 'string' && chunk.startsWith('data: ')) appendTaskEvent(task, chunk) } catch {}
      return (origWrite as any)(chunk, ...rest)
    }
    ;(res as any).end = (...args: any[]) => {
      // If the stream ends without an explicit [DONE] line, still close the task cleanly.
      finishTask(task)
      return (origEnd as any)(...args)
    }
  }
  console.log('[/api/chat] Received:', message?.slice(0, 80), '| mode:', mode, '| device:', device)

  // Mark this as a live foreground request so background FM schedulers (autoImprove, the
  // improvement daemon, prewarm rounds) yield the single-session daemon while it runs.
  // Fires endForeground exactly once when the response closes, regardless of exit path.
  beginForeground()
  let _foregroundEnded = false
  const _endForeground = () => { if (!_foregroundEnded) { _foregroundEnded = true; endForeground() } }
  res.on('close', _endForeground)
  res.on('finish', _endForeground)

  // Abort the turn's in-flight/queued FM work when the client disconnects, so a user who
  // gives up (or the browser closes the SSE) doesn't leave verification fan-out draining the
  // single-session FM gate and starving the next request. Passed as `signal` to answerQuery.
  const _turnAbort = new AbortController()
  res.on('close', () => { if (!res.writableFinished) _turnAbort.abort() })
  const turnSignal = _turnAbort.signal

  // ── /skill and /tool slash shortcuts (FABLE5_HANDOFF Feature 1 increment) ──
  // "I know exactly what I want to run": exact-name lookup, zero NL intent
  // classification, zero model calls. `/skill <id>` emits a proven catalog
  // entry's oracle-verified impl into the project; `/tool <name> [json|text]`
  // invokes a registry tool directly.
  let slash = /^\/(skill|tool)\s+(\S+)\s*([\s\S]*)$/.exec((message ?? '').trim())
  // Bare form — "/<name> [args]" — is what the Agents drawer and the composer's "/"
  // palette insert (e.g. "/read_file src/x.ts"). Resolve the name against the tool
  // registry first, then the skill catalog; unresolved bare slashes fall through to
  // normal chat so a stray leading "/" still gets answered instead of erroring.
  //
  // "Just work" rule: direct mechanical execution ONLY when the args are unambiguous —
  // valid JSON, no args at all, or a single-required-string-param tool (read_file,
  // web_search…) taking the raw text. Anything else ("/control_mac open finder and go
  // to downloads", "/create_tool …") is natural language: rewrite it into an agent-loop
  // goal pinned to that tool instead of throwing a raw schema error at the user.
  let slashAgentTool: string | null = null
  if (!slash) {
    const bare = /^\/([A-Za-z0-9_./-]+)\s*([\s\S]*)$/.exec((message ?? '').trim())
    if (bare) {
      const bareName = bare[1], bareLower = bare[1].toLowerCase()
      const bareDef = registry.get(bareName)
      if (bareDef) {
        const rest = bare[2].trim()
        let restIsJson = false
        if (rest) { try { JSON.parse(rest); restIsJson = true } catch {} }
        const schema = bareDef.params as { properties?: Record<string, any>; required?: string[] }
        const reqd = schema.required ?? []
        const firstProp = schema.properties?.[reqd[0] ?? Object.keys(schema.properties ?? {})[0] ?? '']
        const directOk = !rest || restIsJson ||
          (reqd.length <= 1 && firstProp?.type === 'string' && !firstProp?.enum)
        if (directOk) {
          slash = [bare[0], 'tool', bareName, bare[2]] as unknown as RegExpExecArray
        } else {
          slashAgentTool = bareDef.name
          // The goal stays EXACTLY the user's words — any injected prose here trips the
          // ambiguity gate's unresolved-reference check ("the task", "via /x", ...).
          // The tool preference travels in the agent's system preamble instead.
          message = rest
        }
      } else if (SKILL_CATALOG.some(e =>
        e.id.toLowerCase() === bareLower || e.filename.toLowerCase() === bareLower ||
        e.id.toLowerCase() === `user/${bareLower}` ||
        e.exports.some(x => x.toLowerCase() === bareLower))) {
        slash = [bare[0], 'skill', bareName, bare[2]] as unknown as RegExpExecArray
      }
    }
  }
  if (slash) {
    const [, slashKind, slashName, slashRest] = slash
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    const send = (payload: object) => {
      const line = `data: ${JSON.stringify(payload)}\n\n`
      res.write(line)
      if (chatSessionId) broadcastEvent(chatSessionId, line, res)
    }
    const finish = (text: string, meta?: Record<string, unknown>) => {
      send({ type: 'final', text, ...(meta ? { meta } : {}) })
      patchActiveSessionRound(chatUser, chatRoundId, { synthesis: text, synthesisDone: true, synthStreaming: false })
      historyPush(chatUser?.id ?? null, { ts: Date.now(), query: message, promptType: `slash-${slashKind}`, models: ['crucible-direct'], synthesis: text })
      res.write('data: [DONE]\n\n')
      res.end()
    }
    const projectPath = req.body.projectPath ? path.resolve(req.body.projectPath) : newDesktopProjectPath()
    fs.mkdirSync(projectPath, { recursive: true })

    if (slashKind === 'skill') {
      const lower = slashName.toLowerCase()
      const entry = SKILL_CATALOG.find(e =>
        e.id.toLowerCase() === lower || e.filename.toLowerCase() === lower ||
        e.id.toLowerCase() === `user/${lower}` ||
        e.exports.some(x => x.toLowerCase() === lower))
      if (!entry) {
        const near = SKILL_CATALOG
          .filter(e => e.id.toLowerCase().includes(lower) || e.summary.toLowerCase().includes(lower))
          .slice(0, 5)
        finish(near.length
          ? `No skill named '${slashName}'. Closest matches:\n${near.map(e => `  · ${e.id} — ${e.summary}`).join('\n')}`
          : `No skill named '${slashName}' in the ${SKILL_CATALOG.length}-entry library. Browse the Library drawer, or describe it there to have it built and proven.`)
        return
      }
      const rel = entry.defaultPath
      const abs = path.join(projectPath, rel)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, `// Synthesized by Crucible — ${entry.summary}\n${entry.impl}\n`)
      try { reindexFiles(projectPath, [abs]) } catch {}
      send({ type: 'tool_call', tool: 'write_file', args: { path: rel } })
      send({ type: 'tool_result', tool: 'write_file', ok: true, output: `Emitted proven skill '${entry.id}' (oracle-verified, zero model calls)` })
      finish(`Emitted proven skill '${entry.id}' → ${rel} (exports: ${entry.exports.join(', ')}). Oracle-verified library code — zero model calls.`,
        { synthesized: true, skill: entry.id, source: 'primitive', confidence: 1 })
      return
    }

    // /tool — exact-name direct invocation
    const def = registry.get(slashName)
    if (!def) {
      const names = registry.list().map(t => t.name).filter(n => n.includes(slashName.toLowerCase())).slice(0, 8)
      finish(names.length
        ? `No tool named '${slashName}'. Did you mean: ${names.join(', ')}?`
        : `No tool named '${slashName}'. Open the Library drawer for the full tool list.`)
      return
    }
    let toolArgs: Record<string, unknown> = {}
    const restTrim = slashRest.trim()
    if (restTrim) {
      try { toolArgs = JSON.parse(restTrim) } catch {
        // Not JSON — map the raw text onto the tool's first required param.
        const schema = def.params as { properties?: Record<string, unknown>; required?: string[] }
        const firstParam = schema.required?.[0] ?? Object.keys(schema.properties ?? {})[0]
        if (firstParam) toolArgs = { [firstParam]: restTrim }
      }
    }
    const toolResult = await registry.exec(
      { id: `slash_${Date.now()}`, name: def.name, args: toolArgs },
      {
        projectPath, userId: chatUser?.id, emit: send, allowMutation: true,
        onFileMutated: (absPaths: string[]) => { try { reindexFiles(projectPath, absPaths) } catch {} },
      },
    )
    finish(toolResult.ok
      ? (toolResult.output || `Tool '${def.name}' ran (empty output).`)
      : `Tool '${def.name}' failed: ${toolResult.output}\n\nTip: you can also just describe what you want in plain words (with or without the leading /${def.name}) and Crucible's agent will work out the right steps.`)
    return
  }

  // Agentic-intent flag — hoisted above the agent branch so the Layer-2 FM planner
  // gate (which reads it) doesn't hit a temporal dead zone. Also reused downstream by
  // the exact-cache bypass and pipeline routing.
  // Sticky agentic follow-up: a continuation/repair reply in a session that just ran
  // an agent task stays on the agent path (keeps tool access for "fix it / try again").
  const agenticFollowup = isContinuationPhrase(message ?? '') && hasRecentAgentTask(chatSessionId)
  // ── Deterministic counting gate — "how many r's in strawberry" (verify, never guess) ──
  // Letter/substring counting is arithmetic, not generation: free models routinely hallucinate
  // it (pattern-completing a prior answer). Compute the real answer with zero model calls, before
  // any pipeline, so it's never wrong. Uses this server's own final-answer event shape.
  // NB: `mode` DEFAULTS to 'code' (line ~2436), so we must NOT exclude 'code' here or the gate
  // would never fire on a normal request. answerCountingQuery is precise (only "how many/count X
  // in Y") so it can't hijack a real code-gen ask; we only skip explicit agent/seeker/tool tasks.
  if (mode !== 'agent' && mode !== 'seeker' && slashAgentTool === null && !slash && !detectAgentTask(message ?? '')) {
    const countAns = answerCountingQuery(message ?? '')
    if (countAns) {
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      const send = (payload: object) => {
        const line = `data: ${JSON.stringify(payload)}\n\n`
        res.write(line)
        if (chatSessionId) broadcastEvent(chatSessionId, line, res)
      }
      debugBus.emit('pipeline', 'counting_gate', { needle: countAns.needle, haystack: countAns.haystack, count: countAns.count }, { severity: 'info' })
      send({ type: 'final', text: countAns.text })
      patchActiveSessionRound(chatUser, chatRoundId, { synthesis: countAns.text, synthesisDone: true, synthStreaming: false })
      historyPush(chatUser?.id ?? null, { ts: Date.now(), query: message, promptType: 'counting', models: ['system/count-verifier'], synthesis: countAns.text })
      res.write('data: [DONE]\n\n'); res.end()
      return
    }
  }

  // ── Mid-negotiation refinement short-circuit ──────────────────────────────────
  // While a build is under discussion, a refinement turn ("a simple fps game?", "battle royale",
  // "can it be something different?") must be answered deterministically — not handed to the weak
  // FM, which role-plays a planning assistant ("Great choice! Here's an outline…") and builds
  // nothing (the 2026-07-11 negotiation-loop failure). resolveBuildTurn returns action 'clarify'
  // with the concrete reply; we ship it here, before any agent/task machinery, like the counting
  // gate. Un-poisonable and instant. (Greenlights — action 'build' — flow to the agent branch.)
  if (buildTurn.action === 'clarify' && buildTurn.text) {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    const send = (payload: object) => {
      const line = `data: ${JSON.stringify(payload)}\n\n`
      res.write(line)
      if (chatSessionId) broadcastEvent(chatSessionId, line, res)
    }
    debugBus.emit('agent', 'build_negotiation_clarify', { topic: buildTurn.topic, downscoped: !!buildTurn.note, message: (message ?? '').slice(0, 60) }, { severity: 'info' })
    send({ type: 'final', text: buildTurn.text })
    patchActiveSessionRound(chatUser, chatRoundId, { synthesis: buildTurn.text, synthesisDone: true, synthStreaming: false })
    historyPush(chatUser?.id ?? null, { ts: Date.now(), query: message, promptType: 'build-negotiation-clarify', models: ['system/build-negotiation'], synthesis: buildTurn.text })
    res.write('data: [DONE]\n\n'); res.end()
    return
  }

  const isAgenticIntent = slashAgentTool !== null || mode === 'agent' || detectAgentTask(message ?? '') || agenticFollowup || buildTurn.action === 'build'
  if (agenticFollowup && !detectAgentTask(message ?? '')) {
    console.log('[/api/chat] Sticky agentic routing — continuation of a recent agent task')
    debugBus.emit('agent', 'sticky_agentic_route', { message: (message ?? '').slice(0, 80) }, { severity: 'info' })
  }

  // ── Agent mode — sustained tool loop instead of the synthesis pipeline ─────
  if (buildTurn.action === 'build' || slashAgentTool !== null || mode === 'agent' || mode === 'seeker' || (mode === 'code' && detectAgentTask(message ?? '')) || (req.body.agentMode !== false && (detectAgentTask(message ?? '') || agenticFollowup) && !isCreativeProse(message ?? ''))) {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    const send = (payload: object) => {
      const line = `data: ${JSON.stringify(payload)}\n\n`
      res.write(line)
      if (chatSessionId) broadcastEvent(chatSessionId, line, res)
    }

    // ── Intent classification — fast heuristic, no LLM ──────────────────────
    // Classifies every agent-mode message before dispatch so we can handle
    // conversational_redirect (mid-task corrections) separately from new tasks.
    const agentSession = chatSessionId ? getOrCreateSession(chatSessionId) : null
    // Capture whether a task was ALREADY running BEFORE this request — startTask() below
    // flips this same session object to 'running', so any later status read is useless for
    // "was the user mid-task when they sent this?". The build-clarifier gate needs this.
    const hadActiveTaskBefore = agentSession?.status === 'running'
    const intentResult = classifyIntent(message ?? '', {
      hasActiveTask: hadActiveTaskBefore,
    })
    console.log(`[Agent] Intent: ${intentResult.intent} (${intentResult.confidence})`)
    debugBus.emit('agent', 'intent_classified', { intent: intentResult.intent, confidence: intentResult.confidence, sessionId: chatSessionId }, { severity: 'info' })

    // Handle redirect — abort the running task and continue with new goal in context
    if (intentResult.intent === 'conversational_redirect' && agentSession) {
      const wasAborted = abortCurrentTask(chatSessionId)
      if (wasAborted) {
        send({ type: 'task_redirected', from: agentSession.currentGoal, to: message })
        // Brief pause so the abort signal propagates to the running loop
        await new Promise(r => setTimeout(r, 200))
        // Fall through with the new message as the goal — task session context preserved
      }
    }

    const projectPath = req.body.projectPath
      ? path.resolve(req.body.projectPath)
      : newDesktopProjectPath()
    fs.mkdirSync(projectPath, { recursive: true })

    // Register task with the stateful session (also provides the AbortController)
    const sessionAc = chatSessionId ? startTask(chatSessionId, message ?? '') : null
    const ac = sessionAc ?? new AbortController()
    // res 'close' fires on client disconnect; req 'close' fires once the body is
    // consumed in Express 5, which would falsely cancel the loop.
    // Grace period before aborting on disconnect. Generous (10 min) so a code task you
    // walk away from runs to completion server-side instead of being cut off — when it
    // finishes, patchActiveSessionRound() writes the answer into your session, so you
    // come back to a finished result. runAgentLoop's own maxIters bounds true runaways,
    // and the per-round checkpoint means resume covers anything beyond the window.
    const DISCONNECT_GRACE_MS = 10 * 60_000
    let graceTimer: ReturnType<typeof setTimeout> | null = null
    res.on('close', () => {
      graceTimer = setTimeout(() => ac.abort(), DISCONNECT_GRACE_MS)
    })

    const t0 = Date.now()

    // ── SSE keepalive — prevents proxy/browser from closing an idle connection
    // while the agent is thinking. Fires every 25s, cleared when task ends.
    const keepaliveInterval = setInterval(() => {
      try { send({ type: 'keepalive', elapsed: Date.now() - t0 }) } catch {}
    }, 25_000)
    const endAgent = () => { clearInterval(keepaliveInterval); if (graceTimer) clearTimeout(graceTimer); res.write('data: [DONE]\n\n'); res.end() }

    // ── Resume a persisted task if one is unfinished for this project ─────────
    const iterCheckpoint = req.body.resumeFromCheckpoint ? readCheckpoint(projectPath) : null
    const resumable = req.body.resume === false ? null : latestResumable(projectPath)
    const memoryDigest = readMemoryDigest(projectPath)
    const globalMemory = readGlobalMemoryDigest()
    const episodeContext = buildEpisodeContext(message)
    const graphDigest = buildGraphDigest(message)
    const decisionCtx = buildDecisionContext(message)
    // Open goals from persistent multi-session task graphs — keeps the agent aware
    // of unfinished work carried over from earlier sessions. Empty string when none.
    let openGoalsCtx = ''
    try { openGoalsCtx = buildOpenGoalsContext() } catch {}
    // Task history from the stateful session — injected into systemPreamble for context continuity
    const taskHistoryCtx = chatSessionId ? buildTaskContext(chatSessionId) : ''
    // Accumulated session messages — used as initialMessages for context continuity across turns
    const sessionMessages = chatSessionId ? getSessionMessages(chatSessionId) : []
    // ── Underspecified creation request → clarify, don't hallucinate ──────────
    // "build me a game" (a generic verb + generic noun, no spec) has nothing to build
    // FROM. The single agent loop, seeded with prior session messages, let the weak FM
    // free-associate off stale history — it emitted a recycled greeting and reported
    // "build complete · verified" (the 2026-07-11 nonsense the user caught). A capable
    // collaborator asks the one question that unblocks the build. Deterministic reply,
    // rendered as a normal chat turn (no agent card), un-poisonable by history. Skipped
    // only when a task is actively RUNNING (a mid-task redirect the loop should own). A
    // *completed* prior task must NOT suppress clarification of a brand-new vague build.
    // (No isContinuationPhrase guard here — it false-positives on "build me a game", and
    // genuine continuations like "run it" never match clarifyBuild in the first place.)
    // Skip the vague-build clarifier when the negotiation already resolved to a concrete build —
    // the user has moved past clarification (they greenlit) and we're about to build.
    if (buildTurn.action !== 'build' && !resumable && !iterCheckpoint && !hadActiveTaskBefore) {
      const buildClarify = clarifyBuild(message ?? '')
      if (buildClarify) {
        send({ type: 'layer1', modelId: 'local/apple-fm', model: 'Crucible (offline)', text: buildClarify, done: true })
        send({ type: 'synthesis', modelId: 'local/apple-fm', model: 'Crucible', text: buildClarify, done: true, replace: false })
        patchActiveSessionRound(chatUser, chatRoundId, { synthesis: buildClarify, synthesisDone: true, synthStreaming: false })
        debugBus.emit('agent', 'build_clarify', { message: (message ?? '').slice(0, 60) }, { severity: 'info' })
        endAgent()
        return
      }
    }

    // Build negotiation resolved to a concrete goal → tell the user what we're building (and,
    // when we scoped an over-ambitious ask down to something that actually runs on-device, say
    // so honestly) before the builder starts. agentGoal already carries the assembled spec.
    if (buildTurn.action === 'build') {
      const lead = buildTurn.note
        ? buildTurn.note
        : `On it — building ${buildTurn.topic ? `a ${buildTurn.topic} game` : 'that'} now.`
      send({ type: 'thought', text: lead })
    }

    // Build/update codebase index non-blocking; extract relevant context for this query
    let codebaseContext = ''
    try {
      codebaseContext = buildCodebaseContext(projectPath, message)
    } catch (e) {
      console.warn('[Index] failed to build codebase context:', e)
    }
    // Provenance-honest driver badge (same rule as the pill/footer): a strict request
    // NEVER touches the external pool, so naming a free-pool model ("GPT OSS 120B")
    // here ships false provenance to the UI. Label what will actually drive the loop.
    const agentDriverLabel = requestOffline === 'strict'
      ? 'ON-DEVICE (Apple FM + synth)'
      : requestOffline === '0'
      ? currentDriverLabel()
      : `on-device first · fallback ${currentDriverLabel()}`
    send({ type: 'agent_start', driver: agentDriverLabel, projectPath, resumed: !!resumable || !!iterCheckpoint })
    console.log(`[Agent] Starting — driver: ${agentDriverLabel}, project: ${projectPath}, planned: ${needsPlan(message)}, resume: ${!!resumable}, checkpoint: ${!!iterCheckpoint}, memory: ${memoryDigest.length}c, index: ${codebaseContext.length}c`)

    // Keep codebase index fresh as the agent mutates files
    const onFileMutated = (absPaths: string[]) => {
      try { reindexFiles(projectPath, absPaths) } catch {}
    }

    // Track final messages for stateful session continuity
    let lastAgentMessages: Array<Record<string, unknown>> = []

    // Shared checkpoint writer — called after every agent loop iteration
    const onCheckpoint = (messages: Array<Record<string, unknown>>, iter: number, extra?: Partial<Parameters<typeof writeCheckpoint>[1]>) => {
      lastAgentMessages = messages
      writeCheckpoint(projectPath, {
        sessionId: 'active',
        goal: message,
        projectPath,
        stepIndex: 0, stepTotal: 1, stepIntent: message.slice(0, 120),
        iter, maxIters: 32,
        messages,
        completedSummaries: [],
        steps: [],
        ...extra,
      })
    }

    // ── Layer 0: Local intent fast-path (Offline-First, Track O) ──────────────
    // Resolve unambiguous commands ("open Spotify", "play X on YouTube", "empty the
    // trash", "click Submit", "type hello") directly to tool calls with ZERO model
    // round-trip. This is what eliminates the 5–10s agentic latency for common
    // commands and is the seed of fully-offline agentic execution. High precision:
    // anything it can't confidently resolve falls through to the LLM agent loop.
    // Skipped when resuming a persisted multi-step task.
    if (!resumable && !iterCheckpoint) {
      const localPlan = resolveLocalIntent(message ?? '')
      if (localPlan) {
        console.log(`[Agent] Local fast-path: ${localPlan.intent} — no model call`)
        debugBus.emit('agent', 'local_intent_resolved', { intent: localPlan.intent, steps: localPlan.steps.map(s => s.tool) }, { severity: 'info' })
        send({ type: 'agent_start', driver: 'on-device (no LLM)', projectPath, resumed: false })
        const toolCtx: ToolCtx = {
          projectPath, userId: chatUser?.id, emit: send, signal: ac.signal,
          allowMutation: true, allowDestructive: false, onFileMutated,
        }
        try {
          const { ok, summary, corrections } = await runLocalPlan(
            localPlan,
            (call) => registry.exec(call, toolCtx),
            (ev) => {
              // Surface real-time outcome verification / self-correction on the debug bus,
              // and when a step actually self-corrects, tell the user via a status event.
              debugBus.emit('agent', `local_${ev.type}`, ev as any, { severity: ev.type === 'step_failed' ? 'warn' : 'info' })
              if (ev.type === 'self_correction') send({ type: 'status', text: `Self-correcting: ${ev.reason}` })
            },
          )
          if (corrections.length) debugBus.emit('agent', 'local_intent_self_corrected', { intent: localPlan.intent, corrections }, { severity: 'info' })
          if (ok) {
            send({ type: 'final', text: summary })
            patchActiveSessionRound(chatUser, chatRoundId, { synthesis: summary, synthesisDone: true, synthStreaming: false })
            debugBus.emit('agent', 'local_intent_done', { intent: localPlan.intent, ok: true }, { severity: 'info' })
            console.log(`[Agent] Local fast-path completed in ${((Date.now() - t0) / 1000).toFixed(2)}s`)
            endAgent()
            return
          }
          // B5 — fast-path couldn't complete it; escalate to the full agent loop below.
          console.warn(`[Agent] Local fast-path failed — escalating to full agent loop: ${summary.slice(0, 120)}`)
          debugBus.emit('agent', 'local_intent_fallthrough', { intent: localPlan.intent }, { severity: 'warn' })
        } catch (e: any) {
          // A throw in the fast-path also escalates rather than dead-ending the user.
          console.warn('[Agent] Local fast-path threw — escalating to full agent loop:', e?.message ?? e)
          debugBus.emit('agent', 'local_intent_fallthrough', { intent: localPlan.intent, error: String(e?.message ?? e).slice(0, 120) }, { severity: 'warn' })
        }
      }
    }

    // ── Layer 2: Local FM planner (Offline-First, Track O) ────────────────────
    // For agentic requests that Layer 0 couldn't pattern-match, ask the Apple FM
    // daemon (on-device, zero API) to produce a tiny tool-call plan (1–3 steps).
    // FM output is validated against a strict schema; any ambiguity → null → LLM.
    // Skipped when resuming a persisted multi-step task or when FM is unavailable.
    // Code-edit-shaped requests are deliberately excluded here: the FM planner would emit an
    // unverified edit_file plan, whereas VGR (below) certifies the change by execution before
    // appending it to the target file. Let them fall through to the VGR block.
    if (!resumable && !iterCheckpoint && localInferenceAvailable && isAgenticIntent
        && !isCodeEditTask(message ?? '')) {
      try {
        const fmPlan = await localFmPlan(message ?? '', (sys, usr) => callLocalModel(sys, usr, 12000))
        if (fmPlan) {
          console.log(`[Agent] Layer 2 FM plan: ${fmPlan.intent} (${fmPlan.steps.length} steps)`)
          debugBus.emit('agent', 'layer2_fm_plan', { intent: fmPlan.intent, steps: fmPlan.steps.map(s => s.tool) }, { severity: 'info' })
          send({ type: 'agent_start', driver: 'on-device FM (Layer 2)', projectPath, resumed: false })
          const toolCtx: ToolCtx = {
            projectPath, userId: chatUser?.id, emit: send, signal: ac.signal,
            allowMutation: true, allowDestructive: false, onFileMutated,
          }
          let fmStepIdx = 0
          const { ok, summary } = await runFmPlan(fmPlan, (call) => registry.exec(fmStepToToolCall(call, fmStepIdx++), toolCtx))
          if (ok) {
            send({ type: 'final', text: summary })
            patchActiveSessionRound(chatUser, chatRoundId, { synthesis: summary, synthesisDone: true, synthStreaming: false })
            debugBus.emit('agent', 'layer2_fm_done', { intent: fmPlan.intent, ok: true }, { severity: 'info' })
            console.log(`[Agent] Layer 2 FM done in ${((Date.now() - t0) / 1000).toFixed(2)}s`)
            endAgent()
            return
          }
          // B5 — FM plan failed (e.g. invalid tool, bad step). Do NOT surface the raw
          // error as the answer; escalate to the full LLM agent loop below.
          console.warn(`[Agent] Layer 2 FM plan failed — escalating to full agent loop: ${summary.slice(0, 120)}`)
          debugBus.emit('agent', 'layer2_fm_fallthrough', { intent: fmPlan.intent, summary: summary.slice(0, 120) }, { severity: 'warn' })
        }
      } catch (e: any) {
        console.warn('[Agent] Layer 2 FM plan error (falling through to LLM loop):', e?.message ?? e)
      }
    }

    // ── Layer 2.5: FM ReAct desktop driver (Offline-First) ────────────────────
    // Desktop-action goals ("open finder and go to downloads") are exactly where the
    // online pool's driver models refuse ("I cannot perform external tasks") — while the
    // on-device FM happily drives the Mac (verified live 2026-07-07). When the goal is
    // desktop-action-shaped, the FM is up, and Layer 2's rigid 1–3-step plan didn't
    // complete, run the FM ReAct loop with the desktop tool set BEFORE falling back to
    // the online-pool LLM loop. Tool activity streams to the UI through the same
    // tool_call/tool_result events the main loop emits.
    if (!resumable && !iterCheckpoint && localInferenceAvailable && isAgenticIntent &&
        isDesktopActionGoal(message ?? '')) {
      try {
        const DESKTOP_TOOL_NAMES = ['open_app', 'control_mac', 'get_ui_tree', 'click_element', 'run', 'list_dir', 'move_file', 'search_youtube']
        const fmToolCtx: ToolCtx = {
          projectPath, userId: chatUser?.id, emit: send, signal: ac.signal,
          allowMutation: true, allowDestructive: false, onFileMutated,
        }
        let fmrIdx = 0
        const desktopTools = DESKTOP_TOOL_NAMES.flatMap(n => {
          const def = registry.get(n)
          if (!def) return []
          const props = (def.params as { properties?: Record<string, { description?: string; type?: string }> }).properties ?? {}
          const paramDesc = Object.entries(props).map(([k, v]) => `${k}: ${v.description ?? v.type ?? ''}`).join('; ') || '(no parameters)'
          return [{
            name: def.name,
            description: def.description,
            params: paramDesc,
            execute: async (args: Record<string, string>) => {
              const id = `fmr_${fmrIdx++}`
              send({ type: 'tool_call', id, tool: def.name, args })
              const r = await registry.exec({ id, name: def.name, args }, fmToolCtx)
              send({ type: 'tool_result', id, tool: def.name, ok: r.ok, output: r.output.slice(0, 800), truncated: r.output.length > 800 })
              return `(${r.ok ? 'ok' : 'error'}) ${r.output}`
            },
          }]
        })
        send({ type: 'agent_start', driver: 'on-device FM (desktop)', projectPath, resumed: false })
        const { fmReact } = await import('./src/CrucibleEngine/agent/fmReact')
        const fmRes = await fmReact({ goal: message ?? '', projectPath, signal: ac.signal, extraTools: desktopTools, noSearch: true, maxRounds: 8 })
        // Accept only a real attempt: a non-empty answer grounded in at least one tool call.
        if (!fmRes.abstained && fmRes.answer.trim() && fmRes.toolsUsed.length > 0) {
          send({ type: 'final', text: fmRes.answer })
          patchActiveSessionRound(chatUser, chatRoundId, { synthesis: fmRes.answer, synthesisDone: true, synthStreaming: false })
          debugBus.emit('agent', 'layer25_fm_react_done', { rounds: fmRes.rounds, tools: fmRes.toolsUsed }, { severity: 'info' })
          console.log(`[Agent] Layer 2.5 FM ReAct done in ${((Date.now() - t0) / 1000).toFixed(2)}s (${fmRes.toolsUsed.join(', ')})`)
          endAgent()
          return
        }
        console.warn('[Agent] Layer 2.5 FM ReAct fell through (abstained or zero tool calls) — escalating to LLM loop')
        debugBus.emit('agent', 'layer25_fm_react_fallthrough', { abstained: fmRes.abstained, tools: fmRes.toolsUsed }, { severity: 'warn' })
      } catch (e: any) {
        console.warn('[Agent] Layer 2.5 FM ReAct error (falling through to LLM loop):', e?.message ?? e)
      }
    }

    // D3 — announce the working assumption for a vague goal and proceed (never block).
    if (!resumable && !iterCheckpoint) {
      const assumption = buildAssumptionNote(message)
      if (assumption) {
        send({ type: 'task_assumption', text: assumption })
        debugBus.emit('agent', 'task_assumption', { note: assumption.slice(0, 120) }, { severity: 'info' })
      }
    }

    // Wrap agent execution so a throw in runPlannedTask/runAgentLoop can't leak the
    // keepalive interval or hang the SSE stream — endAgent() runs in finally.
    //
    // Progress bridge (trust audit 2026-07-07): on-device synth turns can grind for
    // minutes inside one loop iteration, so the stream showed nothing but keepalives —
    // indistinguishable from a hang. Forward the synth driver's own debugBus progress
    // events into this task's SSE as human-readable 'thought' lines.
    const PROGRESS_EVENTS: Record<string, (d: any) => string> = {
      // The event fires for every pathless web artifact, not just games (cont.79h widened the
      // routing), so read the injected target rather than asserting "game".
      offline_game_goal: d => `Recognized a single-file web build — targeting ${d?.path ?? 'a self-contained HTML file'}`,
      offline_html_synth: d => `Generated ${d?.path ?? 'the HTML file'} (attempt ${d?.attempt ?? 1}) — verified in a real headless browser`,
      offline_html_retry: d => `Attempt ${d?.attempt ?? '?'} rejected by the run-and-verify gate (${String(d?.problem ?? '').slice(0, 100)}) — regenerating`,
      offline_synth: d => `Synthesized ${d?.path ?? 'file'} (oracle-verified)`,
      offline_noncode_attempt: () => 'Answering via the offline research/reasoning stack',
      offline_turn_escalate: d => `On-device attempt escalated: ${String(d?.reason ?? '').slice(0, 100)}`,
    }
    const unsubProgress = debugBus.subscribe((ev: any) => {
      const fmt = PROGRESS_EVENTS[ev?.type]
      if (fmt) { try { send({ type: 'thought', text: fmt(ev?.data) }) } catch { /* stream gone */ } }
    })
    try {
    let handled = false

    // ── PURE-CODE SYNTHESIS FAST-PATH — "Crucible IS the model" ────────────────
    // Before invoking ANY model (free pool or on-device), try to produce the deliverable
    // with PURE CODE and ZERO model inference, via the no-model cascade:
    //   L0 — exact match to a library-verified primitive (instant), then
    //   L1 — bottom-up enumerative program search from the spec's worked examples, which
    //        REASONS about a novel task it has no primitive for, gated by the execution
    //        oracle (tsc + spec-derived tests) so a search bug can never ship wrong code.
    // A verified result → emit the files + finish, model-cost-independent. Any miss (no primitive,
    // no enumerable program, under-specified spec) falls through to the model-driven agent
    // loop below — honest escalation, never plausible-wrong code. The oracle runs async so
    // an in-request verification never stalls other in-flight SSE streams.
    if (!resumable && !iterCheckpoint && isCodeImplementationTask(message ?? '')) {
      try {
        const pc = await synthesizePureCode(message ?? '', { enumTimeBudgetMs: 2500, projectPath })
        if (pc.verified && pc.files.length && pc.source) {
          const how = pc.source === 'primitive'
            ? `verified '${pc.skillId}' primitive`
            : 'pure-code enumerative program search'
          send({ type: 'synth_match', skill: pc.skillId ?? pc.source, confidence: 1, source: pc.source })
          debugBus.emit('agent', 'synth_match', { skill: pc.skillId ?? pc.source, source: pc.source }, { severity: 'info' })
          const written: string[] = []
          for (const f of pc.files) {
            const abs = path.join(projectPath, f.path)
            fs.mkdirSync(path.dirname(abs), { recursive: true })
            fs.writeFileSync(abs, f.content)
            written.push(abs)
            send({ type: 'tool_call', tool: 'write_file', args: { path: f.path } })
            send({ type: 'tool_result', tool: 'write_file', ok: true, output: `Synthesized ${f.path} via ${how} (no model)` })
          }
          onFileMutated(written)
          // L0 primitives are verified once by `npm run synth:prove` (tested-stdlib model); L1
          // results are oracle-verified in-line (tsc + spec-derived behavioral tests) inside
          // synthesizePureCode before we get here. Either way the emitted code is proven.
          const report = pc.source === 'primitive'
            ? `Verified primitive '${pc.skillId}' (proven by synth:prove).`
            : `Oracle-verified pure-code search — tsc + ${pc.testsDerived} spec-derived test(s), no model.`
          send({ type: 'verify', passed: true, signal: pc.source === 'primitive' ? 'compile' : 'test', report })
          const answer = `Synthesized ${pc.files.map(f => f.path).join(', ')} via ${how} — deterministic, model-cost-independent, zero model calls.`
          send({ type: 'final', text: answer, meta: { synthesized: true, skill: pc.skillId ?? pc.source, source: pc.source, confidence: 1 } })
          patchActiveSessionRound(chatUser, chatRoundId, { synthesis: answer, synthesisDone: true, synthStreaming: false })
          if (chatSessionId) completeTask(chatSessionId, answer.slice(0, 200), [])
          historyPush(chatUser?.id ?? null, { ts: Date.now(), query: message, promptType: 'agent-synth', models: ['crucible-synth'], synthesis: answer })
          handled = true
        }

        // Phase F — honest-escalation UX: tell the client WHY we're falling through.
        // This is the spec-dependence ceiling signal — never wrong-ships, but also
        // never silently "trying AI" when offline synthesis was attempted and missed.
        if (!handled) {
          if (pc.testsDerived === 0) {
            // Spec has no derivable worked examples → oracle cannot verify novel code offline.
            // The most common case: a prose-only description with no f(args)===output pins.
            send({
              type: 'synth_miss',
              reason: 'no-examples',
              detail: 'No worked examples in spec — offline synthesis needs at least one f(args)===output pair to oracle-verify. Handing off to AI.',
            })
            debugBus.emit('agent', 'synth_miss', { reason: 'no-examples', tests: 0 }, { severity: 'info' })
          } else {
            // Tests exist but no pure-code solution found (novel logic beyond the skill library).
            send({
              type: 'synth_miss',
              reason: 'no-match',
              detail: `Offline synthesis attempted (${pc.testsDerived} derivable test${pc.testsDerived === 1 ? '' : 's'}) — no pure-code solution found. Handing off to AI.`,
            })
            debugBus.emit('agent', 'synth_miss', { reason: 'no-match', tests: pc.testsDerived, detail: pc.detail }, { severity: 'info' })
          }
        }
      } catch (synthErr: any) {
        debugBus.emit('agent', 'synth_error', { error: String(synthErr?.message ?? synthErr).slice(0, 120) }, { severity: 'warn' })
        // fall through to the model-driven loop
      }
    }

    // ── Verification-Guided Reasoning (DOCTRINE.md) — certified model-proposed code ──
    // When deterministic synthesis (L0/L1 above) misses, the legacy fallback hands the
    // task to the model-driven agent loop, which can ship PLAUSIBLE-BUT-UNVERIFIED code.
    // VGR closes that hole: the model only PROPOSES; every candidate is EXECUTED against
    // an auto-extracted, consensus-guarded spec; only a case-passing implementation is
    // emitted, otherwise it abstains and falls through. This is the doctrine's live path.
    // DEFAULT-ON (cont.56): this is the doctrine's live path, now proven reliable + latency-
    // gated on real traffic. It runs ONLY after deterministic synth (L0/L1) misses, and only
    // ships CERTIFIED code — on any abstain it falls through unchanged. So default-on strictly
    // adds certification to tasks that would otherwise hand off unverified. Set CRUCIBLE_VGR=0
    // to disable. See DOCTRINE.md + src/CrucibleEngine/reasoning/.
    // A bare "keep going" carries no edit verb and no file path, so both task detectors say
    // false and this block is skipped — which meant the follow-up a best-effort draft explicitly
    // INVITES ("tell me to keep going") fell through to the tool-less pipeline and answered
    // "I'm sorry, but I can't continue." A pending draft is strong evidence the conversation is
    // mid-code-task, so it re-opens the gate. Deliberately narrow: only for a continuation
    // phrase, only while an un-consumed draft exists for THIS user+project (30-min TTL).
    if (!handled && !resumable && !iterCheckpoint && process.env.CRUCIBLE_VGR !== '0'
        && (isCodeImplementationTask(message ?? '') || isCodeEditTask(message ?? '')
            || (isContinuationPhrase(message ?? '') && hasPendingVgrDraft(chatUser?.id, projectPath)))) {
      try {
        send({ type: 'thought', text: 'Verification-guided reasoning: proposing candidates, certifying each by execution…' })

        // ── Deterministic refactors (move / prune / delete / move-file / rename) ──
        // Detection + planning + refusal-messaging live in src/server/refactorRoutes.ts (pure,
        // testable). All run BEFORE the multi-file branch: several name two paths and would else be
        // misrouted into the slow model-driven solver. Each is deterministic (0 model calls),
        // all-or-nothing, esbuild-compile-verified; a SAFETY abstain ends the turn honestly (refused)
        // rather than risking a destructive FM edit; a parse-miss falls through unchanged.
        if (!handled) {
          const snapshot: Record<string, string> = {}
          try {
            for (const rel of collectProjectTsFiles(projectPath)) {
              try { snapshot[rel] = fs.readFileSync(path.join(projectPath, rel), 'utf-8') } catch { /* skip */ }
            }
          } catch { /* best-effort */ }
          const outcome = await planRefactor(message ?? '', snapshot)
          if (outcome) {
            for (const t of outcome.thoughts) send({ type: 'thought', text: t })
            if (outcome.terminal) {
              const mutated: string[] = []
              outcome.writes.forEach((w, i) => {
                const abs = path.join(projectPath, w.rel)
                if (w.mode === 'delete') { try { fs.unlinkSync(abs) } catch { /* already gone */ } }
                else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, w.content) }
                mutated.push(abs)
                const tool = w.mode === 'delete' ? 'delete_file' : 'edit_file'
                send({ type: 'tool_call', id: `${outcome.toolIdPrefix}_${i}`, tool, args: { path: w.rel } })
                send({ type: 'tool_result', id: `${outcome.toolIdPrefix}_${i}`, tool, ok: true, output: `${outcome.outputLabel} — ${w.detail}` })
              })
              if (mutated.length) onFileMutated(mutated)
              if (outcome.verify) send({ type: 'verify', passed: outcome.verify.passed, signal: 'compile', report: outcome.verify.report })
              if (outcome.answer) {
                send({ type: 'final', text: outcome.answer, meta: outcome.meta })
                patchActiveSessionRound(chatUser, chatRoundId, { synthesis: outcome.answer, synthesisDone: true, synthStreaming: false })
                if (chatSessionId) completeTask(chatSessionId, outcome.answer.slice(0, 200), [])
                if (outcome.historyType) historyPush(chatUser?.id ?? null, { ts: Date.now(), query: message, promptType: outcome.historyType, models: [`crucible-${outcome.kind}`], synthesis: outcome.answer })
              }
              handled = true
            }
          }
        }

        // ── Multi-FILE branch — a request spanning ≥2 files / cross-file imports ──────
        // The model proposes a FILE SET; the verifier bundles the import graph and runs the
        // cases across it. On certification we write every file; if any target file already
        // exists we do NOT overwrite (never corrupt real files) — we fall through instead.
        if (!handled && isMultiFileRequest(message ?? '')) {
          send({ type: 'thought', text: 'Multi-file request detected — proposing a file set, bundling the import graph, certifying by execution…' })
          // Modify-shaped requests get the CURRENT contents of the named files as grounding —
          // the proposer edits real code instead of re-inventing the files blind.
          let mfContext: string | undefined
          if (isModifyRequest(message ?? '')) {
            const chunks: string[] = []
            for (const rel of detectRequestedFilesMF(message ?? '')) {
              try {
                const src = fs.readFileSync(path.join(projectPath, rel), 'utf-8')
                if (src.length <= 4000) chunks.push(`Current contents of \`${rel}\` (modify this, keep unrelated code intact):\n\`\`\`\n${src}\n\`\`\``)
              } catch { /* absent — nothing to ground */ }
            }
            if (chunks.length) mfContext = chunks.join('\n\n')
          }
          // Retry-until-certified: same rationale as the single-file path — the on-device
          // proposer is nondeterministic and multi-file certification abstains honestly, so a
          // fresh attempt is pure upside (never a wrong write). Bounded + abort-aware.
          const MF_MAX_ATTEMPTS = Math.max(1, Number(process.env.CRUCIBLE_VGR_ATTEMPTS ?? 3))
          let mf = await solveMultiFileRequest(message ?? '', { maxModelCalls: 10, beamWidth: 2, context: mfContext, signal: ac.signal })
          // Escalation for the multi-file path (mirrors the single-file ladder): once the first
          // attempt fails, fold a WEB reference approach into the proposer's grounding context on
          // retries. Fetched once (retrieveForTask caches), best-effort. Certification unchanged —
          // the multi-file verifier still executes the whole bundled graph against the spec.
          let mfWebGrounded: string | undefined
          for (let attempt = 2; attempt <= MF_MAX_ATTEMPTS && !(mf.status === 'solved' && mf.files?.length) && !ac.signal.aborted; attempt++) {
            if (attempt === 2 && webGroundOrNull && !ac.signal.aborted) {
              try {
                const ref = await webGroundOrNull(message ?? '')
                if (ref) { mfWebGrounded = `${mfContext ? mfContext + '\n\n' : ''}### Web reference (adapt to the spec — NOT trusted; the file graph is executed against hidden cases):\n${ref}`; send({ type: 'thought', text: 'VGR multi-file · folded a web reference approach into the proposer context' }) }
              } catch { /* best-effort */ }
            }
            send({ type: 'thought', text: `VGR multi-file · attempt ${attempt - 1}/${MF_MAX_ATTEMPTS} did not certify (${mf.status}) — escalating${mfWebGrounded ? ' with web grounding' : ''}` })
            mf = await solveMultiFileRequest(message ?? '', { maxModelCalls: 10, beamWidth: 2, context: mfWebGrounded ?? mfContext, signal: ac.signal })
            if (mf.status === 'solved' && mf.files?.length) send({ type: 'thought', text: `VGR multi-file · certified on attempt ${attempt}/${MF_MAX_ATTEMPTS}` })
          }
          debugBus.emit('agent', 'vgr_multifile_result', { status: mf.status, files: mf.files?.map(f => f.path), calls: mf.search?.modelCalls }, { severity: 'info' })
          if (mf.status === 'solved' && mf.files?.length) {
            const collisions = mf.files.filter(f => fs.existsSync(path.join(projectPath, f.path.replace(/^\.\//, ''))))
            let filesToWrite = mf.files
            let mergeNote = ''
            let mergeFailed = false
            if (collisions.length && isModifyRequest(message ?? '')) {
              // Modify-shaped request touching existing files → structural merge (splice
              // same-named declarations, append new, union imports), then RE-VERIFY the
              // merged graph by execution against the same cases before any write.
              const existingByPath = new Map<string, string>()
              for (const f of collisions) {
                const rel = f.path.replace(/^\.\//, '')
                try { existingByPath.set(rel, fs.readFileSync(path.join(projectPath, rel), 'utf-8')) } catch { /* treat as absent */ }
              }
              const merged = await mergeCertifiedFileSet(mf.files, existingByPath)
              const reverified = merged && mf.cases?.length
                ? await verifyMultiFileCode(merged.files, { entry: mf.entry ?? '', entries: mf.entries ?? undefined, cases: mf.cases })
                : null
              if (merged && (!mf.cases?.length || reverified?.pass)) {
                filesToWrite = merged.files
                mergeNote = ` — merged into ${collisions.length} existing file(s) (${merged.detail})${reverified?.pass ? '; merged graph re-verified by execution' : ''}`
                send({ type: 'thought', text: `VGR multi-file: merged certified code into ${collisions.length} existing file(s)${reverified?.pass ? ' and re-certified the merged graph by execution' : ''}.` })
              } else {
                mergeFailed = true
                send({ type: 'thought', text: `VGR multi-file certified ${mf.files.length} file(s), but ${merged ? 'the merged graph failed execution re-verification' : `${collisions.length} existing target(s) could not be merged safely`} — not touching existing files; handing off.` })
              }
            } else if (collisions.length) {
              mergeFailed = true
              send({ type: 'thought', text: `VGR multi-file certified ${mf.files.length} file(s), but ${collisions.length} target path(s) already exist and the request is not modify-shaped — not overwriting existing files; handing off.` })
            }
            if (!mergeFailed) {
              const written: string[] = []
              const rels: string[] = []
              // Each file gets a UNIQUE event id so the UI maps every tool_result to its own
              // tool_call card (the reducer keys results by id — reusing one id collapses them).
              const mergedPaths = new Set(collisions.map(f => f.path.replace(/^\.\//, '')))
              for (let i = 0; i < filesToWrite.length; i++) {
                const f = filesToWrite[i]
                const rel = f.path.replace(/^\.\//, '')
                const abs = path.join(projectPath, rel)
                fs.mkdirSync(path.dirname(abs), { recursive: true })
                fs.writeFileSync(abs, f.source)
                written.push(abs); rels.push(rel)
                const id = `vgr_mf_${i}`
                const tool = mergedPaths.has(rel) ? 'edit_file' : 'write_file'
                send({ type: 'tool_call', id, tool, args: { path: rel } })
                send({ type: 'tool_result', id, tool, ok: true, output: `VGR-certified ${rel} — part of a ${filesToWrite.length}-file import graph (no external model)${mergedPaths.has(rel) ? ' — merged into the existing file' : ''}` })
              }
              onFileMutated(written)
              send({ type: 'verify', passed: true, signal: 'test', report: `Execution-certified across ${rels.length} file(s) against ${mf.cases?.length ?? 0} case(s) in ${mf.search?.modelCalls ?? 0} model call(s) — cross-file imports bundled + run — ${mf.detail}${mergeNote}` })
              const answer = `Wrote and CERTIFIED a ${rels.length}-file module (${rels.join(', ')}) via verification-guided reasoning — the model proposed a file set, execution bundled the import graph and verified every case (${mf.cases?.length ?? 0} passed). Zero external model calls.${mergeNote}`
              send({ type: 'final', text: answer, meta: { vgrCertified: true, multiFile: true, files: rels, entry: mf.entry, modelCalls: mf.search?.modelCalls, confidence: 1 } })
              patchActiveSessionRound(chatUser, chatRoundId, { synthesis: answer, synthesisDone: true, synthStreaming: false })
              if (chatSessionId) completeTask(chatSessionId, answer.slice(0, 200), [])
              historyPush(chatUser?.id ?? null, { ts: Date.now(), query: message, promptType: 'agent-vgr-multifile', models: ['crucible-vgr'], synthesis: answer })
              handled = true
            }
          } else {
            send({ type: 'thought', text: `VGR multi-file could not certify (${mf.status}) — trying single-file, then handing off.` })
          }
        }

        // ── Single-FILE solve — when not multi-file, or the multi-file branch didn't ship. ──
        // Retry-until-certified: the on-device proposer is nondeterministic, so a single VGR
        // invocation certifies an ordinary modify only ~half the time — a fresh attempt often
        // converges where the last abstained. Since VGR NEVER ships uncertified code (it abstains
        // honestly), retrying is pure upside: it only ever turns an honest give-up into a certified
        // solve, never a wrong write. Bounded (default 3) and abort-aware so it can't grind.
        const VGR_MAX_ATTEMPTS = Math.max(1, Number(process.env.CRUCIBLE_VGR_ATTEMPTS ?? 3))
        // REPAIR SEED: for a modify/fix request naming an existing file, hand the current (broken)
        // source to solveCodingRequest as `buggyCode`. It runs ONE deterministic verify over it (no
        // model call) and folds the concrete failing-case evidence into the first proposal — so the
        // loop localizes the bug on call #1 instead of burning a call rediscovering which cases fail
        // (measured lift: fault:live recovery 48-52%→60%). Bounded read; certification is unchanged.
        let repairSeed: string | undefined
        if (isModifyRequest(message ?? '')) {
          const rel = detectTargetPath(message ?? '')
          if (rel) {
            try {
              const src = fs.readFileSync(path.join(projectPath, rel), 'utf-8')
              if (src.length <= 4000) repairSeed = src
            } catch { /* no such file — nothing to seed */ }
          }
          // No named target file — fall back to a fenced code block pasted inline in the message.
          // Same failing-case-evidence seed, for the "fix this bug: ```…```" shape that doesn't
          // reference the project tree at all.
          if (!repairSeed) repairSeed = extractPastedCode(message ?? '') ?? undefined
        }
        // CARRY-FORWARD: "keep going" after a best-effort draft. The draft was shown but never
        // written, so there is no file to read and nothing pasted — without this the next turn
        // restarts from zero and re-derives a near-miss it already paid for. Single-use + TTL'd,
        // and only ever a SEED: every candidate is still executed, so a stale draft can at worst
        // waste evidence, never certify a wrong answer.
        // The effective goal: normally the message itself, but a bare continuation carries no
        // spec or acceptance cases, so resuming re-runs the ORIGINAL goal with the draft seeded.
        let vgrGoal = message ?? ''
        if (!repairSeed && isContinuationPhrase(message ?? '')) {
          const draft = takeVgrDraft(chatUser?.id, projectPath)
          if (draft) {
            repairSeed = draft.code
            vgrGoal = draft.goal
            send({ type: 'thought', text: `VGR · resuming the previous task from its best draft (${draft.code.length} chars) — re-running the original goal with the draft's failing cases seeded into the first proposal.` })
          }
        }
        let vgr = null
        // KEEP-K: the retry loop below restarts search() from scratch each attempt and throws
        // away every non-certified candidate — discarding ranking the verifier already PAID to
        // compute. Retain the distinct ones across attempts so that if nothing certifies we can
        // still say something measured ("7/8 cases pass") instead of only "I gave up".
        const keptAttempts: Attempt<string>[] = []
        const keptSeen = new Set<string>()
        for (let attempt = 1; !handled && attempt <= VGR_MAX_ATTEMPTS; attempt++) {
          if (ac.signal.aborted) break
          // Escalate effort per attempt: attempt 1 is the FAST path (deterministic tiers + a
          // single-shot FM) — most tasks certify here with no network, no extra epochs. Once
          // attempt 1 fails, the task is demonstrably HARD, so attempts 2+ engage "try hard" mode:
          // the converge loop (iterate across epochs) + WEB grounding (fetch a reference approach
          // and seed the proposer). This targets the expensive help exactly where it's needed and
          // costs nothing on the easy tasks that already succeeded. Web still just informs the
          // proposer — every candidate is executed, so it can never certify a wrong answer.
          const tryHard = attempt > 1
          if (tryHard) send({ type: 'thought', text: `VGR · escalating to convergence${webGroundOrNull ? ' + web reference lookup' : ''} for this harder task…` })
          vgr = await solveCodingRequest(vgrGoal, {
            maxModelCalls: 8, beamWidth: 2,
            signal: ac.signal,
            buggyCode: repairSeed,
            converge: process.env.CRUCIBLE_CONVERGE === '1' || tryHard,
            webGround: tryHard ? webGroundOrNull : undefined,
            emit: (ev: any) => { if (ev?.type === 'thought' && typeof ev.text === 'string') send({ type: 'thought', text: `VGR · ${ev.text}` }) },
          })
          if (vgr && vgr.status === 'solved' && vgr.code && vgr.entry) {
            if (attempt > 1) send({ type: 'thought', text: `VGR · certified on attempt ${attempt}/${VGR_MAX_ATTEMPTS} (escalated effort converged where the first attempt abstained)` })
            break
          }
          for (const a of vgr?.search?.attempts ?? []) {
            if (keptSeen.has(a.candidate.fingerprint)) continue
            keptSeen.add(a.candidate.fingerprint)
            keptAttempts.push(a)
          }
          if (attempt < VGR_MAX_ATTEMPTS) send({ type: 'thought', text: `VGR · attempt ${attempt}/${VGR_MAX_ATTEMPTS} did not certify (${vgr?.status ?? 'no result'}) — escalating before handing off` })
        }
        if (vgr) debugBus.emit('agent', 'vgr_result', { status: vgr.status, entry: vgr.entry, calls: vgr.search?.modelCalls, convergedEpochs: vgr.converged?.epochs ?? null }, { severity: 'info' })
        // The signal that justifies flipping converge default-ON: the loop earned an answer
        // single-shot would have stalled on. epochs===1 means converge was a harmless no-op.
        if (vgr?.converged && vgr.converged.epochs > 1) {
          debugBus.emit('agent', 'vgr_converge_win', { entry: vgr.entry, epochs: vgr.converged.epochs, modelCalls: vgr.converged.modelCalls }, { severity: 'info' })
          send({ type: 'thought', text: `VGR · convergence EARNED this — ${vgr.converged.epochs} epochs, ${vgr.converged.modelCalls} model call(s) (single-shot would have stalled)` })
        }
        if (vgr && vgr.status === 'solved' && vgr.code && vgr.entry) {
          // Decide WHERE it lands: an explicit target path in the request → that file (append if
          // it exists and the combined file still compiles), else a new src/<entry>.ts. Never
          // corrupts an existing file (planEmit downgrades to a new file if appending would break).
          // vgrGoal, not message: on a resumed turn the file path lives in the ORIGINAL goal
          // ("src/double.ts"), not in the bare "keep going" that triggered this run.
          const targetPath = detectTargetPath(vgrGoal)
          const existingAbs = targetPath ? path.join(projectPath, targetPath) : null
          let existing: string | null = null
          try { if (existingAbs && fs.existsSync(existingAbs)) existing = fs.readFileSync(existingAbs, 'utf-8') } catch { /* treat as absent */ }
          // Whole-tree: when this is an in-place modify that changes the signature, gather
          // sibling modules so planEmitTree can reconcile (or refuse over) their call sites too.
          const siblings: Record<string, string> = {}
          if (targetPath && existing != null && isModifyRequest(message ?? '')) {
            try {
              for (const relSib of collectProjectTsFiles(projectPath)) {
                if (relSib === targetPath) continue
                try { siblings[relSib] = fs.readFileSync(path.join(projectPath, relSib), 'utf-8') } catch { /* skip unreadable */ }
              }
            } catch { /* tree walk best-effort */ }
          }
          const tree = await planEmitTree(message ?? '', vgr.entry, vgr.code, existing, targetPath, siblings)
          const plan = tree.primary
          const rel = plan.rel
          const abs = path.join(projectPath, rel)
          fs.mkdirSync(path.dirname(abs), { recursive: true })
          fs.writeFileSync(abs, plan.content)
          const mutated = [abs]
          // Apply the reconciled sibling edits (all-or-nothing already enforced by planEmitTree).
          tree.propagated.forEach((p, i) => {
            const pAbs = path.join(projectPath, p.rel)
            fs.writeFileSync(pAbs, p.content)
            mutated.push(pAbs)
            send({ type: 'tool_call', id: `vgr_prop_${i}`, tool: 'edit_file', args: { path: p.rel } })
            send({ type: 'tool_result', id: `vgr_prop_${i}`, tool: 'edit_file', ok: true, output: `VGR whole-tree propagation — ${p.detail}` })
          })
          if (tree.propagated.length) send({ type: 'thought', text: `VGR · whole-tree signature propagation — ${tree.notes.join('; ')}` })
          onFileMutated(mutated)
          send({ type: 'tool_call', id: 'vgr_0', tool: plan.mode !== 'create' ? 'edit_file' : 'write_file', args: { path: rel } })
          // Certification basis: case-based tiers report N executed cases; the property /
          // metamorphic tiers carry `cases: null` and are certified against invariants, so
          // "0 cases passed" would misread as "nothing verified". Describe what actually held.
          const nCasesCert = vgr.cases?.length ?? 0
          const certBasis = nCasesCert > 0
            ? `${nCasesCert} executed case(s) passed`
            : 'general invariants held — property/metamorphic certification'
          send({ type: 'tool_result', id: 'vgr_0', tool: plan.mode !== 'create' ? 'edit_file' : 'write_file', ok: true, output: `VGR-certified ${rel} — ${plan.detail} (${certBasis}, no external model)` })
          send({ type: 'verify', passed: true, signal: 'test', report: `Execution-certified — ${certBasis} in ${vgr.search?.modelCalls ?? 0} model call(s) — ${vgr.detail}` })
          // "the model proposed" is FALSE on a zero-model solve (a mechanical single-edit repair
          // or retrieved source certified outright), so say what actually happened instead.
          const provenance = vgr.search?.modelCalls === 0
            ? 'no model was involved — the fix was derived mechanically and certified by execution'
            : 'the model proposed, execution verified the result'
          const answer = `Wrote and CERTIFIED ${rel} via verification-guided reasoning — ${provenance} (${certBasis}). Zero external model calls.`
          send({ type: 'final', text: answer, meta: { vgrCertified: true, entry: vgr.entry, modelCalls: vgr.search?.modelCalls, confidence: 1 } })
          patchActiveSessionRound(chatUser, chatRoundId, { synthesis: answer, synthesisDone: true, synthStreaming: false })
          if (chatSessionId) completeTask(chatSessionId, answer.slice(0, 200), [])
          historyPush(chatUser?.id ?? null, { ts: Date.now(), query: message, promptType: 'agent-vgr', models: ['crucible-vgr'], synthesis: answer })
          handled = true
        } else if (vgr) {
          // ── KEEP-K best-effort tier ────────────────────────────────────────────────────
          // Nothing certified. Before falling through, ask the verifier what the best kept
          // candidate actually scored. A NEAR-MISS (default: at most 1 failing case) is worth
          // showing, because the alternative here is NOT "something better" — it is a handoff
          // to the model-driven loop, which ships code with no execution evidence at all. A
          // draft measured at 7/8 is strictly more honest than an unmeasured guess.
          //
          // Three invariants keep this from becoming a silent unverified ship:
          //   1. It is NEVER written to a file — certified code writes, drafts only display.
          //   2. It is labelled NOT CERTIFIED, with the real score and the failing signals.
          //   3. The floor is tight, so anything but a near-miss falls through exactly as before.
          const beFloor = Number(process.env.CRUCIBLE_VGR_BEST_EFFORT_FLOOR ?? -1)
          const pick = Number.isFinite(beFloor) && vgr.cases?.length
            ? selectBestEffort(keptAttempts, vgr.cases.length, beFloor)
            : null
          if (pick) {
            const cov = pick.coverage ? `${pick.coverage.passed}/${pick.coverage.total} cases pass` : `score ${pick.score}`
            send({ type: 'thought', text: `VGR · nothing certified, but the best of ${keptAttempts.length} kept candidate(s) measures ${cov} — showing it as an explicit draft, not writing it.` })
            // Make the draft's own "tell me to keep going" offer real — see lastVgrDraft.
            // Stash the GOAL, not the message: a second "keep going" must resume the original
            // task, not the continuation phrase that triggered this run.
            stashVgrDraft(chatUser?.id, projectPath, pick.code, vgrGoal)
            debugBus.emit('agent', 'vgr_best_effort', { score: pick.score, coverage: pick.coverage, kept: keptAttempts.length, entry: vgr.entry }, { severity: 'info' })
            const answer =
              `I could **not certify** this, so I have not written it to any file. ` +
              `Here is the closest candidate — the verifier actually executed it and measured **${cov}**:\n\n` +
              '```ts\n' + pick.code + '\n```\n\n' +
              (pick.signals.length ? `**What still fails:** ${pick.signals.join(' | ')}\n\n` : '') +
              `Treat this as a draft, not a verified answer. Tell me to keep going and I'll iterate on the failing case${pick.coverage && pick.coverage.total - pick.coverage.passed === 1 ? '' : 's'}.`
            send({ type: 'final', text: answer, meta: { vgrCertified: false, vgrBestEffort: true, score: pick.score, coverage: pick.coverage, entry: vgr.entry, modelCalls: vgr.search?.modelCalls, confidence: 0 } })
            patchActiveSessionRound(chatUser, chatRoundId, { synthesis: answer, synthesisDone: true, synthStreaming: false })
            if (chatSessionId) completeTask(chatSessionId, answer.slice(0, 200), [])
            historyPush(chatUser?.id ?? null, { ts: Date.now(), query: message, promptType: 'agent-vgr-best-effort', models: ['crucible-vgr'], synthesis: answer })
            handled = true
          } else {
            // Honest: could not CERTIFY a solution → do not ship a guess; fall through.
            send({ type: 'thought', text: `VGR could not certify a solution (${vgr.status}: ${vgr.detail}) — handing off without shipping unverified code.` })
          }
        }
      } catch (vgrErr: any) {
        debugBus.emit('agent', 'vgr_error', { error: String(vgrErr?.message ?? vgrErr).slice(0, 120) }, { severity: 'warn' })
        // fall through to the model-driven loop — never blocks the request
      }
    }

    // ── Multi-level orchestration (Track I) — the meta-router ──────────────────
    // For genuinely multi-part goals: decompose into a specialist DAG, run each
    // subtask with the best archetype (researcher/coder/critic/strategist) in
    // topological waves, then critic-audit and strategist-synthesise. Falls back
    // to the single loop on any failure so it can never regress baseline behavior.
    if (!handled && !resumable && !iterCheckpoint && shouldUseMetaRouter(message)) {
      try {
        const metaTaskId = chatSessionId || newSessionId(t0)
        // Phase E: model-cost-independent driver.
        //   CRUCIBLE_OFFLINE=strict — offline-only (Apple FM + synth; no external models)
        //   CRUCIBLE_OFFLINE=0      — external models only (opt-out of offline brain)
        //   default                 — offline-first with external fallback (production default)
        const _offlineDrive = makeOfflineDriveTurn(projectPath)
        const _offlineMode = requestOffline
        const activeDriveTurn = _offlineMode === 'strict'
          ? _offlineDrive
          : _offlineMode === '0'
          ? nativeDriveTurn
          : withOfflineFallback(_offlineDrive, nativeDriveTurn, () =>
              // Run escalated off-device — flip the badge/pill so ON-DEVICE never lies.
              send({ type: 'agent_start', driver: currentDriverLabel(), projectPath, resumed: false }))

        // I4 — assigned just below (after buildDriveTurn exists); referenced here so
        // every subtask loop's ToolCtx carries the consult hook.
        let consultSpecialist: ((archetype: ArchetypeId, question: string) => Promise<string>) | undefined
        const runLoop = (o: Parameters<typeof runAgentLoop>[0]) => runAgentLoop({
          driveTurn: activeDriveTurn,
          projectPath,
          userId: chatUser?.id,
          emit: send,
          signal: ac.signal,
          onFileMutated,
          consultSpecialist,
          // Per-subtask grounding off — the meta-router's critic+strategist audit
          // already validates the combined result, so a self-check per subtask is
          // redundant latency. The single-loop / planned-task paths keep it on.
          groundFinal: false,
          // C2 — default-on verification: a fresh verifier per subtask. Auto-passes
          // when no runnable check exists (research/critic), gives the coder real
          // test/compile validation + self-heal. Subtask opts can still override.
          verify: makeVerifier({ command: req.body.verifyCommand }).verify,
          compressCallModel: (msgs) => {
            const { models: cm } = selectModels('general', SIMPLE_PIPELINE_CONFIG, 'simple', 'quorum')
            const m = cm[0]
            return m ? callModel(m, msgs) : Promise.reject(new Error('no model for compression'))
          },
          ...o,   // subtask overrides (goal, archetype-filtered driveTurn, per-subtask signal, maxIters, systemPreamble) win
        })
        // buildDriveTurn uses the offline-first activeDriveTurn so critic/strategist
        // passes also route through Apple FM before falling back to external models.
        const buildDriveTurn = (archetype: ArchetypeId) =>
          ((msgs: Array<Record<string, unknown>>, _tools: any, sig?: AbortSignal) =>
            activeDriveTurn(msgs, buildArchetypeTools(archetype, registry.list()), sig)) as typeof nativeDriveTurn
        // I4 — depth-1 guarded specialist consultation, injected into every subtask
        // loop's ToolCtx via the runLoop closure above (consultSpecialist key).
        let _consultDepth = 0
        consultSpecialist = async (archetype, question) => {
          if (_consultDepth >= 1) return '[consultation depth limit reached — specialists may consult once]'
          _consultDepth++
          try { return await consult(metaTaskId, archetype as ArchetypeId, question, runLoop, buildDriveTurn, send, projectPath, ac.signal) }
          finally { _consultDepth-- }
        }
        send({ type: 'agent_meta', event: 'router_start' })
        debugBus.emit('agent', 'metarouter_route', { goal: message.slice(0, 80) }, { severity: 'info' })
        const metaResult = await runMetaRouter({
          goal: message, projectPath, taskId: metaTaskId,
          runLoop, buildDriveTurn, emit: send, signal: ac.signal,
        })
        const answer = (metaResult.finalAnswer ?? '').trim()
        if (answer.length >= 20) {
          send({ type: 'final', text: answer, meta: { subtasks: metaResult.subtasks.length, critic: !!metaResult.criticFindings, confidence: metaResult.confidence, completeness: metaResult.completeness } })
          patchActiveSessionRound(chatUser, chatRoundId, { synthesis: answer, synthesisDone: true, synthStreaming: false })
          if (chatSessionId) completeTask(chatSessionId, answer.slice(0, 200), [])
          historyPush(chatUser?.id ?? null, { ts: Date.now(), query: message, promptType: 'agent-meta', models: ['meta-router'], synthesis: answer })
          handled = true
        } else {
          debugBus.emit('agent', 'metarouter_fallback', { reason: 'empty_or_short_answer' }, { severity: 'warn' })
        }
      } catch (metaErr: any) {
        console.warn('[Agent] metaRouter failed — falling back to single loop:', metaErr?.message ?? metaErr)
        debugBus.emit('agent', 'metarouter_fallback', { reason: String(metaErr?.message ?? metaErr).slice(0, 120) }, { severity: 'warn' })
      }
    }

    if (!handled) {
    // Same model-cost-independent driver selection as the meta-router path above —
    // this block runs when shouldUseMetaRouter() is false, so it needs its own copy.
    // Pass the current turn's goal explicitly: this single-loop path prepends prior
    // conversation history ahead of the goal, so the offline driver must NOT re-derive
    // the goal from the first user message (that returns a stale earlier turn).
    const _offlineDriveSingle = makeOfflineDriveTurn(projectPath, agentGoal)
    const _offlineModeSingle = requestOffline
    const activeDriveTurn = _offlineModeSingle === 'strict'
      ? _offlineDriveSingle
      : _offlineModeSingle === '0'
      ? nativeDriveTurn
      : withOfflineFallback(_offlineDriveSingle, nativeDriveTurn, () =>
          // Run escalated off-device — flip the badge/pill so ON-DEVICE never lies.
          send({ type: 'agent_start', driver: currentDriverLabel(), projectPath, resumed: false }))

    if (resumable || needsPlan(agentGoal)) {
      const goal = resumable?.goal ?? agentGoal
      const sessionId = resumable?.id ?? newSessionId(t0)
      const persist = (steps: any[], completedSummaries: string[], status: 'running' | 'done' | 'failed') =>
        saveSession({ id: sessionId, goal, projectPath, steps, completedSummaries, status, createdAt: resumable?.createdAt ?? t0, updatedAt: t0 })
      // Use FM for planning when offline-first mode is on; fall back to external driver.
      const offlinePlanMode = requestOffline
      const planModelFn = offlinePlanMode === '0'
        ? driverComplete
        : async (msgs: Array<{ role: string; content: string }>, cls?: 'glue' | 'hard') => {
            const fmAns = await fmComplete(msgs)
            if (fmAns) return fmAns
            return driverComplete(msgs, cls)
          }
      const result = await runPlannedTask({
        goal,
        projectPath,
        driveTurn: activeDriveTurn,
        planModel: planModelFn,
        emit: send,
        signal: ac.signal,
        makeVerify: () => makeVerifier({ command: req.body.verifyCommand, goal }).verify,
        memoryDigest: [memoryDigest, codebaseContext].filter(Boolean).join('\n\n'),
        onPersist: persist,
        resume: resumable ? { steps: resumable.steps, completedSummaries: resumable.completedSummaries } : undefined,
        onCheckpoint: (msgs, iter) => onCheckpoint(msgs, iter),
        resumeCheckpoint: iterCheckpoint
          ? { stepIndex: iterCheckpoint.stepIndex, messages: iterCheckpoint.messages }
          : undefined,
        onFileMutated,
      })
      // Clean up on success
      if (result.ok) {
        clearCheckpoint(projectPath)
        const check = detectCheck(projectPath)
        if (check) appendMemory(projectPath, `Verify with: \`${check.command}\` (${check.signal})`, t0)
      } else {
        // Persist failure reason so the UI can surface "paused at step X"
        const cp = readCheckpoint(projectPath)
        if (cp) writeCheckpoint(projectPath, { ...cp, failureReason: result.summary.slice(0, 200) })
      }
      send({ type: 'final', text: result.summary })
      patchActiveSessionRound(chatUser, chatRoundId, { synthesis: result.summary, synthesisDone: true, synthStreaming: false })
    } else {
      const verifier = makeVerifier({ command: req.body.verifyCommand, goal: agentGoal })
      const result = await runAgentLoop({
        goal: agentGoal,
        projectPath,
        userId: chatUser?.id,
        driveTurn: activeDriveTurn,
        emit: send,
        signal: ac.signal,
        verify: verifier.verify,
        // Adversarial harden pass — self-gates on a passing execution check, so it only
        // fires for code-producing tasks (catches edge-case bugs the agent's tests miss).
        hardenFinal: true,
        onCheckpoint: (msgs, iter) => onCheckpoint(msgs, iter),
        initialMessages: iterCheckpoint?.messages ?? (
          // Prefer accumulated session messages (stateful continuity) over raw history array
          sessionMessages.length > 1
            ? [...sessionMessages.filter(m => m.role !== 'user' || m !== sessionMessages[sessionMessages.length - 1]),
               { role: 'user', content: agentGoal }]
            : history.length > 0 ? [
                { role: 'system', content: '' },
                ...history.flatMap((h: {user: string, assistant: string}) => [
                  { role: 'user', content: h.user },
                  { role: 'assistant', content: h.assistant }
                ]),
                { role: 'user', content: agentGoal }
              ] : undefined
        ),
        systemPreamble: `${defaultSystemPreamble(projectPath)}${slashAgentTool ? `\n\nTOOL SHORTCUT: the user invoked this request through the /${slashAgentTool} shortcut — prefer the ${slashAgentTool} tool where it fits, and use any other tools you need to finish.` : ''}\n\nDEVICE CONTEXT: This request came from a ${device === 'mobile' ? 'mobile phone' : 'desktop'}. When the user asks to open apps, files, or URLs — always execute the action on the Mac desktop, never on the user's phone. If the request is ambiguous, assume they want it on the Mac.\n\nUSER LOCATION: Timezone is Europe/Rome. Use this to infer the user region for location-dependent queries like weather. Never ask for location unless the query is too specific for timezone inference.${detectExternalExecIntent(message ?? '') ? '\n\nEXECUTION INTENT DETECTED: The user wants you to perform an action on an external system (open a URL, play media, launch an app). Do NOT return a link or describe how to do it. Do NOT construct YouTube URLs from memory — video IDs from training data are dead links. For YouTube: call search_youtube with a specific query, pick the best result URL from the live results, then call open_app with that URL. For other media/apps: use web_search to find the URL, then open_app. Execute — do not instruct.' : ''}\n\n${[openGoalsCtx, taskHistoryCtx, globalMemory, episodeContext, graphDigest, decisionCtx, memoryDigest, codebaseContext].filter(Boolean).join('\n\n')}`,
        onFileMutated,
        // Inject a fast text-only model call for model-assisted context compression
        compressCallModel: (msgs) => {
          const { models: compModels } = selectModels('general', SIMPLE_PIPELINE_CONFIG, 'simple', 'quorum')
          const m = compModels[0]
          return m ? callModel(m, msgs) : Promise.reject(new Error('no model for compression'))
        },
      })
      // B1 — clear the checkpoint on success AND on terminal failures that a blind
      // resume can't fix (verify_failed/stalled/max_iters/error). Only budget/cancelled
      // stops stay resumable, so an unwinnable task can't be retried forever.
      if (result.ok || result.stopped === 'verify_failed' || result.stopped === 'stalled' || result.stopped === 'max_iters' || result.stopped === 'error') {
        clearCheckpoint(projectPath)
      }
      if (result.finalText) {
        send({ type: 'final', text: result.finalText })
        patchActiveSessionRound(chatUser, chatRoundId, { synthesis: result.finalText, synthesisDone: true, synthStreaming: false })
        // Persist task completion to stateful session for redirect context continuity
        if (chatSessionId) {
          completeTask(chatSessionId, result.finalText.slice(0, 200), lastAgentMessages)
        }
      }
      // Summarise into episodic memory (non-blocking)
      if (result.finalText) {
        summariseSession(message, result.finalText, projectPath, result.ok ? 'success' : 'partial', callModel).catch(() => {})
      }
      // Persist agent round to session history
      if (result.finalText) {
        try {
          historyPush(chatUser?.id ?? null, { ts: Date.now(), query: message, promptType: 'agent', models: ['agent-loop'], synthesis: result.finalText })
        } catch {}
      }
    }
    }
    console.log(`[Agent] End-to-end latency: ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    } catch (agentErr: any) {
      console.error('[Agent] Fatal error:', agentErr?.message ?? agentErr)
      try { send({ type: 'error', message: `Agent task failed: ${agentErr?.message ?? 'unknown error'}` }) } catch {}
    } finally {
      unsubProgress()
      endAgent()
    }
    return
  }

  // ── Consume prewarm if available ─────────────────────────────────────────
  // Store all prewarm results keyed by modelId for fast lookup at Stage 1
  const prewarmResults: Record<string, string> = {}
  if (prewarmToken) {
    for (const [key, pw] of prewarmCache.entries()) {
      if (!key.startsWith(prewarmToken + ':')) continue
      if (Date.now() - pw.createdAt > 30000) continue
      try {
        const text = pw.resolvedText ?? await pw.result
        if (text) {
          prewarmResults[pw.modelId] = text
          console.log(`[Prewarm] HIT — model: ${pw.modelId}, chars: ${text.length}`)
        }
      } catch {}
    }
    clearPrewarmToken(prewarmToken)
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  const send = (payload: object) => {
    if (res.writableEnded) return
    const line = `data: ${JSON.stringify(payload)}\n\n`
    res.write(line)
    if (chatSessionId) broadcastEvent(chatSessionId, line, res)
  }
  const requestId = `chat-${Date.now()}`
  // M3: stable session key for ambient context tracking (IP + UA, no auth needed)
  const ambientSessionKey = `${req.ip || 'local'}-${(req.headers['user-agent'] || '').slice(0, 40)}`

  // Instant first token — client shows "Analyzing…" immediately, before any model work
  send({ type: 'thinking' })

  // ── M1 — Conversational mode: catch casual/low-content inputs before pipeline ──
  // "test" → "Ready when you are" not a dictionary definition.
  // No ensemble, no calibration, no web grounding — just a natural response.
  if (mode !== 'agent' && mode !== 'seeker' && mode !== 'code') {
    // Ambiguity pre-check runs BEFORE the casual-mode short-circuit below: a terse
    // imperative like "Book it for tomorrow." has no DOMAIN_SIGNAL_WORDS hit, so
    // detectConversational() would misclassify it as small talk and instruct the
    // local model to "mirror exactly what was sent" — which just echoes the command
    // back. Ask what's missing instead of treating it as chit-chat.
    const earlyClarify = detectConversationalClarify(message, Array.isArray(history) && history.length > 0)
    if (earlyClarify.needsClarification) {
      send({ type: 'synthesis', modelId: 'local/apple-fm', model: 'Crucible', text: earlyClarify.question, done: true, replace: false })
      send({ type: 'stage', stage: 5, status: 'done' })
      res.write('data: [DONE]\n\n')
      res.end()
      debugBus.emit('pipeline', 'conversational_clarify_early', { query: message.slice(0, 60) }, { severity: 'info' })
      return
    }
    const convDecision = detectConversational(message)
    if (convDecision.isConversational) {
      // S4b — casual replies don't need frontier quality. When the local Apple
      // model is up, generate a natural reply on-device (zero quota, ~300-600ms);
      // the deterministic template stays as the guaranteed fail-silent fallback.
      const template = buildConversationalFallback(message)
      let reply = template
      let replySource: 'local' | 'template' = 'template'
      if (localInferenceAvailable) {
        const t0 = Date.now()
        const local = await callLocalModel(
          'You are Crucible. Match the user energy exactly. Terse input gets terse output. One word in, one word out. Never add warmth that was not in the input. No offers to help. Mirror exactly what was sent.',
          message,
          4000,
        )
        if (local.trim()) {
          reply = applyVoiceLayer(local.trim())
          replySource = 'local'
          debugBus.emit('model', 'local_inference', { task: 'conversational', latencyMs: Date.now() - t0 }, { severity: 'info' })
        }
      }
      send({ type: 'synthesis', modelId: replySource === 'local' ? 'local/apple-fm' : 'system', model: 'Crucible', text: reply, done: true, replace: false })
      send({ type: 'stage', stage: 5, status: 'done' })
      res.write('data: [DONE]\n\n')
      res.end()
      debugBus.emit('pipeline', 'conversational_mode', { reason: convDecision.reason, reply: reply.slice(0, 60) }, { severity: 'info' })
      return
    }
  }

  // ── Track U — ANIMA transparency layer ───────────────────────────────────
  // "what have you learned about humans?" → the Universal Truth Store in plain
  // language. This is the ONLY place ANIMA is ever made explicit to the user.
  if (mode !== 'agent' && mode !== 'seeker' && mode !== 'code' && isTransparencyQuery(message)) {
    // Build the report BEFORE writing anything. If building throws (e.g. a DB
    // read error), nothing has been sent, so we can safely fall through to the
    // normal pipeline. Once we begin sending we commit to this path and always
    // end the stream — never fall through after a partial write (that would let
    // the cache/pipeline below double-write and corrupt the SSE stream).
    let report: ReturnType<typeof buildTransparencyReport> | null = null
    try {
      report = buildTransparencyReport()
    } catch (e: any) {
      console.error('[ANIMA] transparency build error — falling through:', e?.message)
      report = null
    }
    if (report) {
      try {
        send({ type: 'anima_transparency', count: report.count, entries: report.entries })
        send({ type: 'synthesis', modelId: 'anima', model: 'ANIMA', text: report.text, done: true, replace: false })
        send({ type: 'stage', stage: 5, status: 'done' })
        debugBus.emit('pipeline', 'anima_transparency', { count: report.count }, { severity: 'info' })
      } catch (e: any) {
        console.error('[ANIMA] transparency send error:', e?.message)
      } finally {
        // Always close the stream on this committed path — no fall-through.
        if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end() }
      }
      return
    }
  }

  diag.requestsThisSession++  // /api/diag — session request counter
  const diagReqStart = Date.now()

  // ── Query triage ─────────────────────────────────────────────────────────
  // Runs before cache so filler queries never hit the pipeline or get cached.
  // Every tier still feeds the learning loop.
  const FILLER_RX = /^(ok|okay|thanks|thank you|cool|got it|great|nice|sure|sounds good|perfect|awesome|yes|no|yep|nope|lol|haha|k|thx)[\s!.]*$/i
  // Reasoning / multi-step / code / multi-fact-calc signals — these earn the full ensemble,
  // never collapse to the single fast model even if short. Keeps quality on the hard ones.
  const NEEDS_ENSEMBLE_RX = /\b(divided by|step by step|prove|derive|compare|contrast|pros and cons|trade-?offs?|debug|refactor|optimi[sz]e|analy[sz]e|implement|architect|write (a |an |me )?(function|code|program|script|class|method|sql|query|regex|algorithm)|design (a|an|the))\b|\bif\b[^?]+\bthen\b|\d[\d,. ]*\s*(\/|÷|×|·|\*|\^)\s*\d|\b\d+\s*x\s*\d/i
  // Obviously-simple knowledge / lookup / short-list questions — one good model answers in
  // 1-3 sentences. Broadened 2026-06-21: was missing name/list/why/which/tell-me, so trivial
  // queries like "Name three bridges" fell into the 6-model pipeline (~27s instead of ~1s).
  const SIMPLE_RX = /^(what('?s| is| are| was| were)\b|who\b|when (is|was|did|does|will|would|did)\b|where('?s| is| are| did| was| were)\b|why (is|are|was|do|does|did|can|would)\b|which\b|how (many|much|old|tall|far|long|big|deep|fast|hot|cold)\b|how (do|does|can|would) (you|i|we|it|they)\b|define\b|name (a |an |the |some |several |two |three |four |five |\d)|list (a |an |the |some |several |two |three |four |five |\d)|give me (a |an |some |several |two |three |four |five |\d)|tell me about\b|explain\b[^.?!]{0,80}\b(briefly|simply|in (one|a|a few|two|three) (sentence|word|line)s?))/i
  // Premise-bearing explanatory / temporal-event questions presuppose a state of affairs
  // ("why is X <surprising property>", "why did X <happen>", "when did X <event>"). A single
  // fast local-model call can only continue the presupposition from parametric memory — it has
  // no way to VERIFY the embedded claim, so it parrots false premises whenever the correction
  // isn't already memorized (Great-Wall-from-space, Alaska-from-Canada). These must reach the
  // research DAG (full tier → solveNonCodeTurn) where retrieval + the grounding check can test
  // the premise against evidence rather than assume it. Pure factoid lookups (what/who/where/
  // define/list) assert no contestable premise and stay 'simple'. This is a SHAPE rule, not a
  // list of known-false facts. See server.ts:3056 (offline full path) + synthDriver.ts grounding.
  const PREMISE_RX = /^(why (is|are|was|were|do|does|did|can|could|would|will)|when (did|was|were|do|does|will|had|has)|how (did|does|do) [^?]*\b(only|never|always|impossible|fail|failed|cause[ds]?)\b)\b/i
  type TriageTier = 'filler' | 'simple' | 'full'
  function triageQuery(q: string): TriageTier {
    const trimmed = q.trim()
    if (FILLER_RX.test(trimmed)) return 'filler'
    // Premise-bearing questions never collapse to a single fast call — route to the DAG
    // so the embedded claim is verified against evidence, not parroted from memory.
    if (PREMISE_RX.test(trimmed)) return 'full'
    const qMarks = (trimmed.match(/\?/g) || []).length
    if (trimmed.length <= 160 && qMarks <= 1 && SIMPLE_RX.test(trimmed) && !NEEDS_ENSEMBLE_RX.test(trimmed)) return 'simple'
    return 'full'
  }
  // Context-dependent follow-ups ("what is ITS population?", "and THAT one?") mean
  // nothing without the prior turns. They must NOT collapse to the history-blind
  // simple-triage single call, and must NOT be served from the message-keyed caches
  // (the same text resolves to a different referent in a different conversation).
  // Route them to the 'full' tier, where the offline brain threads history.
  const _hasHistory = Array.isArray(history) && history.length > 0
  const _isBackReference = /\b(it|its|it's|that|this|those|these|they|them|their|there|he|she|his|her|him|the one|the former|the latter|same)\b/i.test(message) || /^\s*(and|but|what about|how about|ok|okay|so)\b/i.test(message)
  const isContextDependent = _hasHistory && _isBackReference
  const triageTier = mode === 'agent' ? 'full' : (isContextDependent ? 'full' : triageQuery(message))

  // ── Exact response cache check ───────────────────────────────────────────
  const ck = cacheKey(message)
  const cached = responseCache.get(ck)
  // Agentic-intent requests bypass cache — cached instructions must never substitute
  // for live execution (the agent needs to run, not replay a prior answer).
  // (isAgenticIntent is computed once near the top of the handler.)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS && !isAgenticIntent && !isContextDependent) {
    console.log('[Cache] HIT —', message?.slice(0, 60))
    diag.cacheHits++
    for (const event of cached.events) {
      res.write(`data: ${JSON.stringify({ ...event, cached: true })}\n\n`)
    }
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }
  // ── Semantic cache check (paraphrase of a prior query) ───────────────────
  const semantic = semanticLookup(message)
  if (semantic && !isAgenticIntent && !isContextDependent) {
    diag.cacheHits++
    console.log(`[Cache] SEMANTIC HIT (${semantic.sim.toFixed(3)}) — "${message?.slice(0, 50)}" ≈ "${semantic.entry.message.slice(0, 50)}"`)
    debugBus.emit('pipeline', 'semantic_cache_hit', { query: message.slice(0, 80), matched: semantic.entry.message.slice(0, 80), similarity: parseFloat(semantic.sim.toFixed(3)) }, { severity: 'success' })
    send({ type: 'semantic_cache', similarity: parseFloat(semantic.sim.toFixed(3)), matchedQuery: semantic.entry.message })
    for (const event of semantic.entry.events) {
      res.write(`data: ${JSON.stringify({ ...event, cached: true, semantic: true })}\n\n`)
    }
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }

  // ── VGR coding pre-gate (non-agent flow) ─────────────────────────────────
  // A plain "write a TypeScript function that …" is NOT detected as an agent task, so it
  // used to skip the whole agent branch (which owns the VGR block) and fall through to the
  // answer engine — shipping RAW, unverified FM code (observed 2026-07-11: a buggy slugify
  // that left a trailing hyphen and didn't collapse runs, with a comment claiming the right
  // output). This gate gives those requests the SAME execution-certified path as agentic
  // coding, but INLINE (no file writes, no heavy loop): propose candidates → execute each
  // against a derived spec (user examples → named property → metamorphic → differential) →
  // ship only a certified solution; on abstain, fall through UNCHANGED to the FM path below.
  // NB: fires for ANY triage tier — a "write a function" request classifies as 'full'
  // (substantive), so gating on tier would exclude exactly the coding requests we want.
  // VGR certifies by EXECUTING JS/TS — it cannot verify Python/Go/Rust/etc., and proposing JS
  // for a Python request would be doubly wrong. Skip the gate when another language is asked for
  // (explicit language word OR a non-JS/TS file path) so those hand off to the FM immediately
  // instead of burning the search budget on an unverifiable, wrong-language attempt.
  const wantsNonJsLang = /\b(python|py|golang|rust|ruby|php|swift|kotlin|scala|haskell|elixir|c\+\+|c#|\bgo\b|\bjava\b|\bc\b)\b/i.test(message ?? '')
    || /\.(py|go|rs|rb|php|java|swift|kt|cpp|cc|cs|c)\b/.test(message ?? '')
  if (process.env.CRUCIBLE_VGR !== '0' && mode !== 'agent' && !wantsNonJsLang
      && (isCodeImplementationTask(message ?? '') || isCodeEditTask(message ?? ''))
      && !isMultiFileRequest(message ?? '')) {
    try {
      send({ type: 'stage', stage: 1, status: 'start' })
      send({ type: 'thought', text: 'Verification-guided reasoning: proposing candidates and certifying each by execution (no external model)…' })
      // Time-box the search: canonical/property paths are instant; a non-certifiable function
      // must fail FAST to the FM rather than burn the full budget (twoSum ran 88s pre-fix).
      const vgrTimeout = AbortSignal.timeout(Number(process.env.CRUCIBLE_VGR_PREGATE_MS ?? 40_000))
      const vgrSignal = AbortSignal.any([turnSignal, vgrTimeout])
      const vgr = await solveCodingRequest(message ?? '', {
        maxModelCalls: 6, beamWidth: 2, signal: vgrSignal,
        converge: process.env.CRUCIBLE_CONVERGE === '1',
        webGround: webGroundOrNull,
        // Forward VGR/iterate() reasoning thoughts (per-epoch convergence steps, proposer
        // diagnostics) to the live stream so a convergence run is observable, not silent.
        emit: (ev: any) => { if (ev?.type === 'thought' && typeof ev.text === 'string') send({ type: 'thought', text: `VGR · ${ev.text}` }) },
      })
      if (vgr.status === 'solved' && vgr.code) {
        const nCases = vgr.cases?.length ?? 0
        const how = /canonical reference/.test(vgr.detail ?? '')
          ? 'a verified canonical reference, checked against the spec invariants — no model was used at all'
          : nCases > 0
            ? `executing ${nCases} case(s) against a spec derived without any external model`
            : 'checking it against invariants derived from the description — no external model was used'
        const body = `Here is a solution, certified by ${how}.\n\n\`\`\`typescript\n${vgr.code.trim()}\n\`\`\``
        send({ type: 'verify', passed: true, report: `VGR-certified \`${vgr.entry}\` — ${vgr.detail}` })
        send({ type: 'layer1', modelId: 'local/crucible-vgr', model: 'Crucible (VGR)', text: body, done: true })
        send({ type: 'stage', stage: 1, status: 'done' })
        send({ type: 'synthesis', modelId: 'local/crucible-vgr', model: 'Crucible', text: body, done: true, replace: false })
        send({ type: 'stage', stage: 5, status: 'done' })
        debugBus.emit('pipeline', 'vgr_pregate_certified', { query: message.slice(0, 60), entry: vgr.entry, cases: nCases, convergedEpochs: vgr.converged?.epochs ?? null }, { severity: 'info', requestId })
        // Convergence actually earned this (single-shot would have stalled) — the signal we watch.
        if (vgr.converged && vgr.converged.epochs > 1) {
          debugBus.emit('pipeline', 'vgr_converge_win', { entry: vgr.entry, epochs: vgr.converged.epochs, modelCalls: vgr.converged.modelCalls }, { severity: 'info', requestId })
          send({ type: 'thought', text: `VGR · convergence EARNED this — ${vgr.converged.epochs} epochs, ${vgr.converged.modelCalls} model call(s) (single-shot would have stalled)` })
        }
        if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end() }
        return
      }
      // Not certified → hand off to the normal path (never ship unverified from here).
      send({ type: 'thought', text: `VGR could not certify a solution (${vgr.status}) — answering with the on-device model.` })
      debugBus.emit('pipeline', 'vgr_pregate_abstain', { query: message.slice(0, 60), status: vgr.status }, { severity: 'info', requestId })
    } catch (e: any) {
      debugBus.emit('pipeline', 'vgr_pregate_error', { error: String(e?.message ?? e).slice(0, 120) }, { severity: 'warn', requestId })
    }
  }

  // ── Simple triage — single fast model ───────────────────────────────────
  if (triageTier === 'simple') {
    // Standing constraint: under CRUCIBLE_OFFLINE=strict, NO external calls — ever.
    // The Apple FM daemon is deliberately NOT in MODEL_REGISTRY (see modelRegistry.ts),
    // so the external fastModelEntry lookup below would silently fall back to Groq/qwen
    // under strict. Pin strict simple-triage to a single DIRECT local FM call instead:
    // one concise callLocalModel (same fast, single-call shape this branch intends),
    // gated on daemon liveness. If the daemon is down, abstain honestly — never external.
    const _offlineTriageMode = requestOffline
    if (_offlineTriageMode === 'strict') {
      const simplePT = classifyPrompt(message)
      learnClassification(message, regexClassify(message))
      send({ type: 'contract', promptType: simplePT, requiredStructure: [], forbiddenAntipatterns: [] })
      send({ type: 'stage', stage: 1, status: 'start' })
      // The SYSTEM is the brain, the FM is the messenger. Route through the answer engine:
      // it classifies the query's facets, gathers grounding (retrieval / compute), drafts with
      // a DEPTH-APPROPRIATE prompt (no blanket "1-3 sentences" throttle that forced wrong
      // one-liners on reasoning asks), then CHECKS the draft with deterministic critics
      // (arithmetic oracle + sanity) and does one bounded repair round — or ABSTAINS honestly.
      // Strict-offline: local Apple FM only, retrieval via our own tooling, never an external
      // model. Replaces the old bare callLocalModel('answer in 1-3 sentences') bypass.
      const t0l = Date.now()
      const result = await answerQuery(message, { history, emit: send, signal: turnSignal })
      send({ type: 'layer1', modelId: 'local/apple-fm', model: 'Crucible (offline)', text: result.text, done: true })
      send({ type: 'stage', stage: 1, status: 'done' })
      // When the answer already STREAMED to the client (synthesis deltas), finalize with
      // replace:true so the polished text (sources footer, any critic fix) REPLACES the streamed
      // fragments instead of appending a duplicate.
      send({ type: 'synthesis', modelId: 'local/apple-fm', model: 'Crucible', text: result.text, done: true, replace: result.streamed === true })
      send({ type: 'stage', stage: 5, status: 'done' })
      recordModelOutcome('local/apple-fm', !result.abstained, Date.now() - t0l)
      if (!result.abstained) {
        triggerImprovementPass()
        summariseSession(message, result.text, process.cwd(), 'success', callModel).catch(() => {})
      }
      debugBus.emit('pipeline', result.abstained ? 'triage_simple_strict_abstain' : 'triage_simple_strict_local',
        { query: message.slice(0, 60), latencyMs: Date.now() - t0l, intent: result.facets.intent, usedRetrieval: result.usedRetrieval, corrections: result.corrections, repaired: result.repaired },
        { severity: result.abstained ? 'warn' : 'info', requestId })
      if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end() }
      return
    }
    // Non-strict (default / '0'): unchanged — prefer local FM entry if registered, else
    // a fast/free external model with a key.
    const fastModelEntry = MODEL_REGISTRY.find(m =>
      // The local Apple FM is registered under provider 'local' (see callModel / PROXY_SKIP_PROVIDERS);
      // the old 'apple-foundation-models' literal isn't a valid provider, so this preference was DEAD —
      // it silently never fired, defeating the local-first intent whenever a local entry is registered.
      m.provider === 'local' && getCircuitState(m.id) === 'active'
    ) || (MODEL_REGISTRY as any[]).find(m =>
      m.speed === 'fast' && getCircuitState(m.id) === 'active' && providerHasKey(m.provider)
    ) || (MODEL_REGISTRY as any[]).find(m =>
      m.free && getCircuitState(m.id) === 'active' && providerHasKey(m.provider)
    )
    if (fastModelEntry) {
      const fastModel: SelectedModel = { id: fastModelEntry.id, provider: fastModelEntry.provider, label: fastModelEntry.label, isWildcard: false }
      try {
        const simplePT = classifyPrompt(message)
        learnClassification(message, regexClassify(message))  // train on regex ground truth, not self
        send({ type: 'contract', promptType: simplePT, requiredStructure: [], forbiddenAntipatterns: [] })
        send({ type: 'stage', stage: 1, status: 'start' })
        const t0s = Date.now()
        const reply = await callModel(fastModel, [
          { role: 'system', content: 'Answer concisely and accurately in 1-3 sentences.' },
          { role: 'user', content: message },
        ], { requestId })
        const latencyMs = Date.now() - t0s
        // Universal verification baseline: the fast single-model path skips the full pipeline for
        // speed, so it also skipped every check — a raw unverified guess reached the user. Run one
        // deterministic verify + (only if flagged) one cheap same-model repair before emitting.
        const vr = await verifyAndRepair(message, simplePT, reply,
          (system, user) => callModel(fastModel, [{ role: 'system', content: system }, { role: 'user', content: user }], { requestId }))
        const finalReply = vr.text
        if (vr.repaired) send({ type: 'verify', passed: true, report: `Corrected before sending: ${vr.issues.join('; ')}` })
        send({ type: 'layer1', modelId: fastModel.id, model: fastModel.label, text: finalReply, done: true })
        send({ type: 'stage', stage: 1, status: 'done' })
        send({ type: 'synthesis', modelId: fastModel.id, model: fastModel.label, text: finalReply, done: true, replace: false })
        send({ type: 'stage', stage: 5, status: 'done' })
        recordModelOutcome(fastModel.id, finalReply.length > 0, latencyMs)
        triggerImprovementPass()
        summariseSession(message, finalReply, process.cwd(), 'success', callModel).catch(() => {})
        debugBus.emit('pipeline', 'triage_simple', { query: message.slice(0, 60), model: fastModel.label, latencyMs }, { severity: 'info', requestId })
        res.write('data: [DONE]\n\n')
        res.end()
        return
      } catch (e: any) {
        console.warn(`[Triage] Simple path failed (${e.message}) — falling through to full pipeline`)
        debugBus.emit('pipeline', 'triage_fallback', { query: message.slice(0, 60), reason: e.message }, { severity: 'warn', requestId })
      }
    }
  }

  // ── Offline-first conversational path (option C — measured 2026-06-30) ───────
  // Under offline mode the full multi-model ensemble below collapses onto ONE local
  // FM daemon, serialized: every per-stage timeout (6/12/20s, tuned for fast external
  // models) blows and the synthesis degrades to fallback text. Measured: ~110s/prompt,
  // keyword coverage 0.17 vs 0.89 external. Instead, route the full-tier conversational
  // turn through the proven offline brain (solveNonCodeTurn: research DAG → FM ReAct →
  // FM direct) for ONE coherent local answer. Simple-triage above already collapses to
  // a single gated FM call, so it is left untouched.
  //   'strict' — local only; on FM-daemon-down or empty, abstain honestly (never external)
  //   default  — local first; on OfflineEscalateError, fall through to the ensemble
  const _offlineConvMode = requestOffline
  // v3: 'code' is no longer excluded — it's the default local mode, and its conversational
  // turns must route through the offline brain, not fall through to the external pipeline.
  if (_offlineConvMode !== '0' && mode !== 'agent' && mode !== 'seeker' && triageTier === 'full' && !isAgenticIntent) {
    const abstain = (text: string) => {
      send({ type: 'synthesis', modelId: 'local/apple-fm', model: 'Crucible', text, done: true, replace: false })
      send({ type: 'stage', stage: 5, status: 'done' })
      if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end() }
    }
    try {
      const convPT = classifyPrompt(message)
      send({ type: 'contract', promptType: convPT, requiredStructure: [], forbiddenAntipatterns: [] })
      send({ type: 'stage', stage: 1, status: 'start' })
      const t0o = Date.now()
      // Local GGUF ensemble pool (Tracks A-D, 2026-07-07): when the user has downloaded models
      // (or pinned/fire-all is set), prefer routing/strengthening across that pool over the
      // single-call offline brain below. With zero GGUF models downloaded, routeLocalModelQuery's
      // only fallback is a raw Track-S-FM call — weaker than solveNonCodeTurn's research-DAG /
      // FM-ReAct chain — so it is skipped entirely in that case, not just deprioritized.
      const histSlice = Array.isArray(history) ? history.slice(-6) : undefined
      // Strict mode (the production default for every non-quorum request) routes through the
      // answer engine as the PRIMARY brain: it classifies the query, picks reasoning depth (no
      // forced "1-3 sentences"), runs verified self-consistency on multi-step reasoning,
      // delegates genuine external-fact asks to the retrieval/tool brain, and CHECKS every draft
      // with deterministic critics before it ships — or abstains. The unverified local-GGUF
      // ensemble is deliberately NOT consulted here: shipping its raw output is exactly the
      // "trust the model" pattern the engine replaces (it produced the wrong train-catch-up
      // answer). Default mode ('1') keeps the GGUF ensemble → solveNonCodeTurn chain so an
      // OfflineEscalateError can still fall through to the external ensemble below.
      let routed: Awaited<ReturnType<typeof routeLocalModelQuery>> = null
      let strictDebate: Awaited<ReturnType<typeof runDebate>> = null
      let answer: string
      let answerStreamed = false
      // Council corroboration is DEFERRED: running the peer FM calls here (before the answer's
      // synthesis is emitted) made the client show "still streaming" through the whole ~15-25s
      // debate even though the answer text was already on screen. Instead we mark this turn for
      // a POST-answer council (run after the synthesis done:true below), so the answer completes
      // immediately and the debate card streams in afterward.
      let deferStrictCouncil = false
      if (_offlineConvMode === 'strict') {
        // Pass the FULL history — answerQuery's conversation-memory layer bounds it internally
        // (recent thread verbatim + relevance-retrieved older turns), so pre-slicing to the last 6
        // here would strip exactly the turn-1 facts that layer exists to recall. histSlice below
        // still bounds the coarser solveNonCodeTurn fallback.
        const fullHistory = Array.isArray(history) ? history : undefined
        const strictResult = await answerQuery(message, { history: fullHistory, emit: send, signal: turnSignal })
        answer = strictResult.text
        answerStreamed = strictResult.streamed === true
        // Council corroboration (cont.58c): the answer engine's verified draft is seated as one
        // voice and the local council (GGUF pool + Apple FM) cross-examines it. Display layer
        // ONLY — the shipped text is never overruled. Gated to corroboration domains; SKIPPED for
        // web-grounded answers (already cited — stronger provenance than a lexical vote).
        const dom = classifyDomain(message)
        const councilWorthy = !strictResult.usedRetrieval &&
          (dom === 'code' || dom === 'reasoning' || dom === 'factual' || message.trim().length >= 60)
        deferStrictCouncil = !!(answer && answer.trim() && councilWorthy)
      } else {
        if (hasReadyLocalModels()) {
          try {
            routed = await routeLocalModelQuery('', message)
          } catch (e: any) {
            debugBus.emit('pipeline', 'local_ensemble_error', { query: message.slice(0, 60), error: String(e?.message ?? e) }, { severity: 'warn', requestId })
          }
        }
        answer = routed && routed.text.trim()
          ? routed.text
          : await solveNonCodeTurn(message, undefined, histSlice)
      }
      const latencyMs = Date.now() - t0o
      // Deterministic arithmetic guard (ZERO inference): the free-tier model does mental
      // math token-by-token and ships wrong products (47×53 → "2,591"). Before sending,
      // splice the oracle-computed value into any "EXPR = NUMBER" claim whose EXPR is
      // cleanly evaluable and whose stated NUMBER is wrong. Non-evaluable claims (variables,
      // factorials, π/√) are left untouched — no guessing. No external call, no fanout.
      if (answer && answer.trim()) {
        try {
          const { text: fixed, corrections } = correctArithmeticCascade(answer)
          if (corrections.length) {
            answer = fixed
            debugBus.emit('pipeline', 'offline_arithmetic_corrected', { query: message.slice(0, 60), corrections }, { severity: 'info', requestId })
          }
        } catch { /* non-blocking: ship the original answer */ }
      }
      // FENCELESS CODE (cont.95 live finding): a code-intent answer shipped 3.7KB of raw source
      // with NO fences, so every code gate below (they all key on ```-presence) abstained on the
      // one answer that needed them. Deterministic first: if a fenceless answer contains a region
      // that PARSES as code, fence it — zero inference, byte-identical code — so the full gate
      // stack downstream gets to judge it. Message-independent: gated on the answer's own shape.
      if (answer && answer.trim() && !answer.includes('```')) {
        try {
          const f = fenceUnfencedCode(answer)
          if (f.fenced > 0) {
            answer = f.text
            debugBus.emit('pipeline', 'code_fence_inferred', { count: f.fenced }, { severity: 'info', requestId })
          }
        } catch { /* non-blocking */ }
      }
      // CODE ASK, NO CODE (cont.92 live finding): the reason-intent lane can collapse a code
      // ask to its extracted "Answer:" line — shipped live as the ENTIRE answer "Answer: true"
      // for "implement a token bucket rate limiter". A code ask answered with zero fences is a
      // non-answer, so re-synthesize from the QUESTION alone (there is nothing of the collapsed
      // draft worth showing — which is also the cont.89 forward-only rule) and adopt only when
      // the full gate stack clears the candidate. Double-gated on an implement-shaped verb so an
      // explain-style ask that legitimately answers in prose is never replaced with bare code.
      // FORWARD-ONLY code re-synthesis from the QUESTION (cont.89 rule: the retry never sees
      // the rejected draft — showing a model its own broken artifact makes it re-produce it,
      // measured 0/6 cont.94 and again 0/2 live cont.96). Shared by the no-code seam below and
      // the broken-block escalation (cont.96). When the question names a contract, the retry
      // carries that contract's own API line as a forward constraint AND the adoption bar rises
      // to contract-CERTIFIED — measured live (cont.92b): without it, qwen answered "rate
      // limiter" with a token COUNTER. fullyVerified = every gate cleared AND (no named
      // contract, or certified); otherwise the best candidate returns flagged for the caller
      // to ship (or not) as explicit best-effort.
      const isImplementAsk = /\b(implement|write|build|create|code|program)\b/i.test(message)
        && !/\b(explain|why does|how does|what is|difference between)\b/i.test(message)
        && isCodingQuery(message)
      const resynthCodeAnswer = async (): Promise<{ text: string; by: string; fullyVerified: boolean; certified: boolean; askedKind: string | null } | null> => {
        const asked = detectContract(message)
        const hint = asked ? contractAskHint(asked.kind) : null
        const msgs = [
          { role: 'system' as const, content: 'You write correct, self-contained TypeScript. Output ONLY the code — no fences, no commentary.' },
          { role: 'user' as const, content: `${message}\n\nProvide a complete, runnable implementation.${hint ? `\n${hint}` : ''}\nEnd with a brief usage example that exercises it.` },
        ]
        const gens: Array<{ src: string; gen: () => Promise<string | null> }> = [
          { src: 'fm', gen: async () => (await fmComplete(msgs)).trim() },
          ...(isBonsaiInstalled()
            ? [{ src: repairModelName(), gen: async () => (await bonsaiComplete(msgs, { maxTokens: 700, timeoutMs: 30_000 })).trim() }]
            : []),
        ]
        let fallback: { text: string; by: string } | null = null
        for (const cand of gens) {
          if (turnSignal?.aborted) break
          let raw: string | null = null
          try { raw = await cand.gen() } catch { raw = null }
          if (!raw || raw.trim().length < 20) continue
          const codeBody = raw.replace(/^```\w*\n?/, '').replace(/```\s*$/, '').trim()
          const candidate = '```ts\n' + codeBody + '\n```'
          // Full stack: syntax, own-demo, behavioral contract. Violations always block.
          if (verifyCodeBlocks(candidate).length > 0) continue
          if (verifyPlainCodeByExecution(candidate).status === 'violations') continue
          const cv = verifyAnswerContract(message, candidate)
          if (cv.status === 'violations') continue
          if (asked && cv.status !== 'certified') {
            // Right shape unproven for a NAMED contract — hold as best-effort, keep looking.
            if (!fallback) fallback = { text: candidate, by: cand.src }
            continue
          }
          return { text: candidate, by: cand.src, fullyVerified: true, certified: cv.status === 'certified', askedKind: asked?.kind ?? null }
        }
        if (fallback) return { ...fallback, fullyVerified: false, certified: false, askedKind: asked?.kind ?? null }
        return null
      }
      if (answer && answer.trim() && !answer.includes('```') && isImplementAsk) {
        try {
          debugBus.emit('pipeline', 'answer_code_missing', { len: answer.length, preview: answer.slice(0, 60) }, { severity: 'warn', requestId })
          const r = await resynthCodeAnswer()
          if (r && r.fullyVerified) {
            answer = r.text
            debugBus.emit('pipeline', 'answer_code_missing_repaired', { by: r.by, certified: r.certified }, { severity: 'info', requestId })
          } else if (r) {
            // Keep-K best-effort: unverified code beats the literal non-answer it replaces,
            // but it must SAY it is unverified (a green-looking stamp here is the cont.79h sin).
            answer = r.text + `\n\n> ⚠ This implementation could not be verified against the ${r.askedKind} contract — review before relying on it.`
            debugBus.emit('pipeline', 'answer_code_missing_repaired', { by: r.by, certified: false }, { severity: 'info', requestId })
          }
        } catch { /* non-blocking: ship the answer as-is */ }
      }
      // Run-to-verify gate for code answers (trust audit 2026-07-07, repro #3): the offline
      // brain shipped Python with a SyntaxError presented as working code. Syntax-check
      // every fenced py/js block; on failure, one FM repair attempt of that block, re-checked.
      // Still broken → ship with an explicit warning instead of silently claiming it works.
      if (answer && answer.trim() && answer.includes('```')) {
        try {
          // Deterministic first (cont.94): TS mislabeled as ```js is a LABEL defect, not a code
          // defect — relabel before spending any model call on a "repair" measured 0/6 here.
          const relab = relabelMislabeledJsFences(answer)
          if (relab.relabeled > 0) {
            answer = relab.text
            debugBus.emit('pipeline', 'code_block_relabeled', { count: relab.relabeled }, { severity: 'info', requestId })
          }
          // Re-verify from scratch after every splice: a repair/relabel shifts every later
          // block's offsets, so iterating a stale problems array splices at wrong positions
          // (latent multi-fence bug, found cont.96). The attempted-set makes progress explicit:
          // each broken block gets exactly one shot at relabel → FM → sidecar, then an honest
          // per-block warning — no early break that leaves later broken blocks unexamined
          // (the cont.95 live oddity: one fence certified while another shipped TS1005).
          const attempted = new Set<string>()
          for (let guard = 0; guard < 6; guard++) {
            const p = verifyCodeBlocks(answer).find(pr => !attempted.has(pr.lang + ' ' + pr.code))
            if (!p) break
            attempted.add(p.lang + ' ' + p.code)
            // Deterministic first: a block that parses clean under ANOTHER grammar is a label
            // defect (python inside a ```ts fence → TS1005) — relabel, byte-identical code.
            const relang = crossGrammarRelabel(p.lang, p.code)
            if (relang) {
              answer = answer.slice(0, p.start) + '```' + relang + '\n' + p.code.replace(/\n?$/, '\n') + '```' + answer.slice(p.end)
              debugBus.emit('pipeline', 'code_block_relabeled', { from: p.lang, to: relang, cross: true }, { severity: 'info', requestId })
              continue
            }
            const msgs = [
              { role: 'system' as const, content: 'You fix syntax errors in code. Output ONLY the corrected code, no fences, no commentary. Keep the logic identical.' },
              { role: 'user' as const, content: `This ${p.lang} code fails to parse: ${p.error}\n\n${p.code}` },
            ]
            const seats: Array<{ src: string; gen: () => Promise<string> }> = [
              { src: 'fm', gen: async () => await fmComplete(msgs) },
              ...(isBonsaiInstalled()
                ? [{ src: repairModelName(), gen: async () => await bonsaiComplete(msgs, { maxTokens: 700, timeoutMs: 30_000 }) }]
                : []),
            ]
            let repairedBlock = false
            for (const seat of seats) {
              if (turnSignal?.aborted) break
              let fixedRaw: string | null = null
              try { fixedRaw = await seat.gen() } catch { fixedRaw = null }
              const fixed = (fixedRaw ?? '').replace(/^```\w*\n?/, '').replace(/```\s*$/, '')
              if (fixed.trim() && verifyCodeBlocks('```' + p.lang + '\n' + fixed + '\n```').length === 0) {
                answer = answer.slice(0, p.start) + '```' + p.lang + '\n' + fixed.replace(/\n?$/, '\n') + '```' + answer.slice(p.end)
                debugBus.emit('pipeline', 'code_block_repaired', { lang: p.lang, error: p.error, by: seat.src }, { severity: 'info', requestId })
                repairedBlock = true
                break
              }
            }
            if (!repairedBlock) {
              answer += `\n\n> ⚠ The ${p.lang} code above failed a syntax check (${p.error}) and could not be auto-repaired — it will not run as written.`
              debugBus.emit('pipeline', 'code_block_broken_shipped', { lang: p.lang, error: p.error }, { severity: 'warn', requestId })
            }
          }
          // ESCALATION (cont.96, live-measured): the show-the-broken-block repair above is 0/2
          // live and 0/6 benched — the model re-produces its own defect (cont.89). When a block
          // is STILL broken on an implement-shaped ask, re-synthesize from the QUESTION alone
          // and adopt only a candidate the FULL gate stack clears (syntax, own-demo, contract-
          // certified when named). Anything less keeps the honestly-warned original — a fresh
          // unverified draft must never replace a partially-good answer.
          if (isImplementAsk && verifyCodeBlocks(answer).length > 0) {
            const r = await resynthCodeAnswer()
            if (r && r.fullyVerified) {
              answer = r.text
              debugBus.emit('pipeline', 'code_block_resynthesized', { by: r.by, certified: r.certified }, { severity: 'info', requestId })
            }
          }
        } catch { /* non-blocking */ }
      }
      // Run-to-verify gate for PLAIN-code answers (cont.91): the codeblock gate above catches
      // code that fails to PARSE. This catches code that parses and then dies STRUCTURALLY when
      // its OWN example runs — a method that isn't defined, a fabricated free identifier reached
      // only on a call, a `this.head` deref on undefined (the cont.90 linked-list class). It
      // executes the answer's own demonstration in a module/network-denied vm, so it synthesizes
      // NO inputs and cannot false-reject correct code: a structural throw on the author's chosen
      // inputs is input-independent by construction. No self-demo → abstain → nothing appended.
      if (answer && answer.trim() && answer.includes('```')) {
        try {
          const exec = verifyPlainCodeByExecution(answer)
          debugBus.emit('pipeline', 'answer_plaincode_exec', {
            status: exec.status, exercised: exec.exercised.length, reason: exec.reason.slice(0, 120),
          }, { severity: exec.status === 'violations' ? 'warn' : 'info', requestId })
          if (exec.status === 'violations') {
            const err = exec.defects[0]?.error ?? 'a structural error'
            answer += `\n\n> ⚠ Running the example above throws (${err}) — the code will not work as written.`
            debugBus.emit('pipeline', 'code_block_exec_broken_shipped', { error: err }, { severity: 'warn', requestId })
          }
        } catch { /* non-blocking: ship the answer as-is */ }
      }
      // BEHAVIORAL-CONTRACT gate for code answers (cont.92). The two gates above prove the code
      // PARSES and SURVIVES its own demo — neither says the logic is right, which is exactly how
      // the cont.91 live suite shipped a linked list whose pop() loses nodes and a token bucket
      // whose acquire() is inverted, both council-stamped. When the QUESTION names a contract
      // (stack/queue/linked list/LRU/rate limiter/heap/BST/emitter/memoize/debounce/…), execute
      // the answer's own class/function against that contract's invariants (fake clock for the
      // time-based ones). On violation, attempt repair with FORWARD constraints only — the retry
      // never sees the rejected code (cont.89: showing a model its own broken artifact makes it
      // re-produce it). Candidates in cost order: the verified canonical reference (zero model
      // calls), the FM, then the sidecar seat (2nd-proposer standing rule). A repair is adopted
      // ONLY when the patched answer re-certifies through the FULL gate stack — otherwise the
      // original ships with an explicit counterexample warning instead of a silent stamp.
      if (answer && answer.trim() && answer.includes('```')) {
        try {
          const contract = verifyAnswerContract(message, answer)
          if (contract.status !== 'abstain') {
            debugBus.emit('pipeline', 'answer_contract', {
              family: contract.family, entry: contract.entry, status: contract.status,
              checksRun: contract.checksRun, reason: contract.reason.slice(0, 140),
            }, { severity: contract.status === 'violations' ? 'warn' : 'info', requestId })
          }
          if (contract.status === 'violations') {
            const rspec = contractRepairSpec(message, contract)
            const ask = `${message}\n\nRequirements the code MUST satisfy:\n${rspec.constraints.map(c => `- ${c}`).join('\n')}\n${rspec.entry ? `Name it ${rspec.entry}.` : ''}\nEnd with a brief usage example that exercises it.`
            const msgs = [
              { role: 'system' as const, content: 'You write correct, self-contained TypeScript. Output ONLY the code — no fences, no commentary.' },
              { role: 'user' as const, content: ask },
            ]
            const candidates: Array<{ src: string; gen: () => Promise<string | null> }> = [
              { src: 'canonical', gen: async () => rspec.canonical },
              { src: 'fm', gen: async () => (await fmComplete(msgs)).trim() },
              ...(isBonsaiInstalled()
                ? [{ src: repairModelName(), gen: async () => (await bonsaiComplete(msgs, { maxTokens: 700, timeoutMs: 30_000 })).trim() }]
                : []),
            ]
            let repaired = false
            for (const cand of candidates) {
              if (turnSignal?.aborted) break
              let raw: string | null = null
              try { raw = await cand.gen() } catch { raw = null }
              if (!raw || raw.trim().length < 20) continue
              const code = raw.replace(/^```\w*\n?/, '').replace(/```\s*$/, '').trim()
              const patched = replaceAnswerCodeBlocks(answer, code)
              // Full stack, same oracles: syntax gate, own-demo gate, and the SAME contract.
              if (verifyCodeBlocks(patched).length > 0) continue
              if (verifyPlainCodeByExecution(patched).status === 'violations') continue
              const re = verifyAnswerContract(message, patched)
              if (re.status === 'certified') {
                // Earlier gates may have stamped warnings about the code being REPLACED — those
                // claims are now false (the full stack just re-certified the patched artifact),
                // and shipping them over correct code misleads (measured live, cont.92 run 1:
                // a stale TS2588 warning rode along above qwen's correct repair).
                answer = patched.replace(/\n+> ⚠ (The \w+ code above failed a syntax check|Running the example above throws)[^\n]*/g, '')
                repaired = true
                debugBus.emit('pipeline', 'answer_contract_repaired', {
                  family: contract.family, by: cand.src, checksRun: re.checksRun,
                }, { severity: 'info', requestId })
                break
              }
            }
            if (!repaired) {
              const d = contract.defects[0]
              answer += `\n\n> ⚠ Behavioral check failed (${contract.family}): ${d?.counterexample ?? contract.reason} — the code above does not correctly implement what was asked.`
              debugBus.emit('pipeline', 'answer_contract_broken_shipped', {
                family: contract.family, entry: contract.entry,
                counterexample: (d?.counterexample ?? '').slice(0, 160),
              }, { severity: 'warn', requestId })
            }
          }
        } catch { /* non-blocking: ship the answer as-is */ }
      }
      // NO-EXTERNAL-DEPENDENCY constraint gate (cont.95 live finding): the FM routinely IGNORES
      // "no external packages" and ships express code. The constraint is stated by the QUESTION
      // and checkable deterministically against the answer's own imports (all node builtins and
      // relative paths allowed — the constraint is about npm packages). On violation: forward-only
      // re-synthesis with the constraint made explicit (the retry never sees the rejected code,
      // cont.89), adopted only when the candidate passes the FULL gate stack AND imports nothing
      // external; otherwise the original ships with an honest violation warning, never silently.
      if (answer && answer.trim() && answer.includes('```') && detectNoDependencyConstraint(message)) {
        try {
          const externals = findExternalImports(answer)
          if (externals.length > 0) {
            debugBus.emit('pipeline', 'answer_dependency_violation', { externals }, { severity: 'warn', requestId })
            const ask = `${message}\n\nHARD CONSTRAINT: use ONLY Node.js built-in modules. Do not import or require ANY npm package. If the question mentions a package, implement the equivalent yourself with builtins.\nEnd with a brief usage example that exercises it.`
            const msgs = [
              { role: 'system' as const, content: 'You write correct, self-contained TypeScript using only Node.js built-in modules. Output ONLY the code — no fences, no commentary.' },
              { role: 'user' as const, content: ask },
            ]
            const gens: Array<{ src: string; gen: () => Promise<string | null> }> = [
              { src: 'fm', gen: async () => (await fmComplete(msgs)).trim() },
              ...(isBonsaiInstalled()
                ? [{ src: repairModelName(), gen: async () => (await bonsaiComplete(msgs, { maxTokens: 700, timeoutMs: 30_000 })).trim() }]
                : []),
            ]
            let repaired = false
            for (const cand of gens) {
              if (turnSignal?.aborted) break
              let raw: string | null = null
              try { raw = await cand.gen() } catch { raw = null }
              if (!raw || raw.trim().length < 20) continue
              const code = raw.replace(/^```\w*\n?/, '').replace(/```\s*$/, '').trim()
              const candidate = '```ts\n' + code + '\n```'
              if (findExternalImports(candidate).length > 0) continue
              if (verifyCodeBlocks(candidate).length > 0) continue
              if (verifyPlainCodeByExecution(candidate).status === 'violations') continue
              const cv = verifyAnswerContract(message, candidate)
              if (cv.status === 'violations') continue
              answer = replaceAnswerCodeBlocks(answer, code)
              repaired = true
              debugBus.emit('pipeline', 'answer_dependency_repaired', { by: cand.src, was: externals }, { severity: 'info', requestId })
              break
            }
            if (!repaired) {
              answer += `\n\n> ⚠ The question asked for no external packages, but this code imports ${externals.join(', ')} — it does not satisfy that constraint as written.`
              debugBus.emit('pipeline', 'answer_dependency_broken_shipped', { externals }, { severity: 'warn', requestId })
            }
          }
        } catch { /* non-blocking: ship the answer as-is */ }
      }
      if (answer && answer.trim()) {
        const provenanceModelId = routed ? `local/${routed.modelId}` : 'local/apple-fm'
        const provenanceModel = routed ? routed.modelLabel : 'Crucible (offline)'
        const provenanceExtra = routed
          ? { contributors: routed.contributors, confidence: routed.confidence, method: routed.method, corroboratedBy: routed.corroboration.map(c => c.modelId) }
          : {}
        send({ type: 'layer1', modelId: provenanceModelId, model: provenanceModel, text: answer, done: true, ...provenanceExtra })
        // Council-debate transcript (cont.58c) — when the local ensemble cross-examined
        // itself, ship the full propose/rebut/verdict trail so the UI can render the
        // debate card. Entry texts are clipped: the card shows positions, not essays.
        const sendDebateCard = (d: NonNullable<typeof strictDebate>) => send({
          type: 'local_debate',
          debate: {
            agreement: d.agreement, method: d.method, confidence: d.confidence,
            winnerId: d.winnerId, winnerLabel: d.winnerLabel, contributors: d.contributors,
            mindsChanged: d.mindsChanged, totalLatencyMs: d.totalLatencyMs,
            rounds: d.rounds.map(r => ({
              kind: r.kind,
              entries: r.entries.map(e => ({
                modelId: e.modelId, modelLabel: e.modelLabel,
                text: e.text.length > 600 ? e.text.slice(0, 600) + '…' : e.text,
                latencyMs: e.latencyMs, errored: e.errored, changedPosition: e.changedPosition === true,
              })),
            })),
          },
        })
        // Routed-path debate is already computed (part of routeLocalModelQuery) — free to send now.
        if (routed?.debate) sendDebateCard(routed.debate)
        send({ type: 'stage', stage: 1, status: 'done' })
        send({ type: 'synthesis', modelId: provenanceModelId, model: 'Crucible', text: answer, done: true, replace: answerStreamed, ...provenanceExtra })
        send({ type: 'stage', stage: 5, status: 'done' })
        recordModelOutcome(provenanceModelId, true, latencyMs)
        triggerImprovementPass()
        summariseSession(message, answer, process.cwd(), 'success', callModel).catch(() => {})
        debugBus.emit('pipeline', routed ? 'local_ensemble_conversational' : 'offline_conversational', { query: message.slice(0, 60), latencyMs, mode: _offlineConvMode, ...(routed ? { modelId: routed.modelId, method: routed.method } : {}) }, { severity: 'info', requestId })
        // Deferred council — the answer's synthesis(done:true) already went out above, so the
        // round is visually complete; the debate card now streams in without blocking it.
        if (deferStrictCouncil && !turnSignal?.aborted) {
          try {
            const peers = await councilPeers(message)
            if (peers.length >= 1) {
              const engineVoice = { modelId: 'answer-engine', modelLabel: 'Crucible Answer Engine', call: async () => answer }
              const d = await runDebate([engineVoice, ...peers], '', message, {
                seedProposals: [{ modelId: 'answer-engine', modelLabel: 'Crucible Answer Engine', text: answer }],
              })
              if (d) sendDebateCard(d)
            }
          } catch (e: any) {
            debugBus.emit('pipeline', 'council_corroboration_error', { query: message.slice(0, 60), error: String(e?.message ?? e) }, { severity: 'warn', requestId })
          }
        }
        if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end() }
        return
      }
      // Empty local answer: strict abstains; default falls through to the ensemble.
      if (_offlineConvMode === 'strict') { abstain("I can't answer this reliably offline right now (local model returned nothing), and strict mode disables external escalation."); return }
      debugBus.emit('pipeline', 'offline_conversational_empty', { query: message.slice(0, 60) }, { severity: 'warn', requestId })
    } catch (e: any) {
      // Tier-3 fmDirectAnswer (synthDriver.ts) is unguarded, so the raw callFm
      // error (fmReact.ts) surfaces here as-is. Distinguish a slow-but-healthy
      // daemon (FM_TIMEOUT_MS abort, e.name === 'TimeoutError') from a genuinely
      // unreachable one (OfflineEscalateError from the upfront health check, or
      // ECONNREFUSED) — these were previously collapsed into one mislabeled
      // "daemon is unreachable" string, which cost real diagnostic time.
      const isTimeout = e?.name === 'TimeoutError'
      const isUnreachable = !isTimeout && (/daemon unavailable/i.test(String(e?.message ?? '')) || e?.cause?.code === 'ECONNREFUSED' || e?.cause?.code === 'ECONNRESET')
      const reason = isTimeout
        ? 'the local model is taking too long to respond (timed out)'
        : isUnreachable
          ? 'the local model daemon is unreachable'
          : 'the local model could not produce an answer'
      debugBus.emit('pipeline', 'offline_conversational_escalate', { reason: String(e?.message ?? e).slice(0, 100), errName: e?.name, mode: _offlineConvMode }, { severity: 'warn', requestId })
      if (_offlineConvMode === 'strict') { abstain(`I can't answer this offline right now — ${reason}, and strict mode blocks external escalation.`); return }
      // default: fall through to the external ensemble below.
    }
  }

  const cacheEvents: object[] = []
  // Models dropped by the Stage 1 straggler timer — their layer1 streaming events
  // are still sent to the client (UI shows the work) but NOT recorded in cacheEvents,
  // so a cache replay never replays a straggler that arrived after synthesis.
  const timerDropped = new Set<string>()
  const sendAndRecord = (payload: object) => {
    const p = payload as any
    if (p.type === 'layer1' && p.modelId && timerDropped.has(p.modelId)) {
      send(payload)  // still stream to UI, just don't cache
      return
    }
    cacheEvents.push(payload)
    send(payload)
  }

  // Top-level safety net for the whole pipeline below (L1/L2/domain/Stage 1–5).
  // Any uncaught throw here must still close the SSE stream, or the client hangs
  // forever waiting for [DONE]. The matching catch is just before the handler ends.
  try {
  // Keepalive pause guard — count this request as live for its entire duration so
  // background keepalive pings skip model calls. Balanced in the finally below, so
  // every exit path (early return, completion, throw) decrements exactly once.
  activePipelineRequests++

  // ── Model selection ───────────────────────────────────────────────────────
  const promptType = classifyPrompt(message)
  // Train on the deterministic regex baseline (intentional keyword ground truth) — NOT
  // on classifyPrompt's own output, which created a self-reinforcing loop that drifted
  // code/math prompts to 'factual' and silently gated out hypothesis/execution-trace.
  learnClassification(message, regexClassify(message))  // feed classifier history

  // ── Layer 1: Corpus-first answer gate (Offline-First, Track O) ────────────
  // If the living corpus covers this question well, synthesize the answer on-device
  // (Apple FM) from our own knowledge — ZERO external API. High precision: fires only
  // on strong coverage + available local synth, else falls through to the pipeline.
  if (localInferenceAvailable && !isAgenticIntent && triageTier !== 'simple') {
    try {
      // 3s cap — if the ONNX embedder isn't warm yet, skip rather than block the pipeline.
      const corpusAns = await Promise.race([
        corpusFirstAnswer(message, promptType, {
          localSynth: (sys, usr) => callLocalModel(sys, usr, 20000),
        }),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 3000)),
      ])
      if (corpusAns) {
        console.log(`[Pipeline] Corpus-first HIT (conf ${corpusAns.confidence.toFixed(2)}) — answered offline, no API`)
        debugBus.emit('pipeline', 'corpus_first_answer', { confidence: corpusAns.confidence, sources: corpusAns.sources.length, domains: [...new Set(corpusAns.sources.map(s => s.domain))] }, { severity: 'success' })
        const domains = [...new Set(corpusAns.sources.map(s => s.domain))].join(', ')
        const answerText = `${applyVoiceLayer(corpusAns.answer)}\n\n*Answered on-device from Crucible's knowledge corpus (${domains}) — no external models used.*`
        // Mirror the proven offline-mode event shape so the client renders it identically.
        send({ type: 'contract', promptType, requiredStructure: [], forbiddenAntipatterns: [] })
        send({ type: 'corpus_first', confidence: corpusAns.confidence, sources: corpusAns.sources })
        send({ type: 'stage', stage: 1, status: 'start' })
        send({ type: 'layer1', modelId: 'local/apple-fm', model: 'Corpus + Apple FM (offline)', text: answerText, done: true })
        send({ type: 'stage', stage: 1, status: 'done' })
        send({ type: 'synthesis', modelId: 'local/apple-fm', model: 'Corpus + Apple FM (offline)', text: answerText, done: true, replace: false })
        send({ type: 'stage', stage: 5, status: 'done' })
        patchActiveSessionRound(chatUser, chatRoundId, { synthesis: answerText, synthesisDone: true, synthStreaming: false })
        res.write('data: [DONE]\n\n'); res.end()
        return
      }
    } catch (e: any) {
      console.warn('[Pipeline] corpus-first gate error (continuing to pipeline):', e?.message ?? e)
    }
  }

  // Quality prediction: tune pipeline aggressiveness before models run
  const qualityPrediction = qualityPredictor.predict(message)
  // Low-confidence prediction (< 0.3) on a "simple" query → full pipeline anyway
  // High-confidence + expected high score (≥ 0.8) → lower early-exit threshold to 0.75
  const qualityForceFull = qualityPrediction.confidence < 0.3 && qualityPrediction.sampleSize > 10
  // H2 — Uncertainty surface: look up this query's topic cluster calibration history.
  // Declared here (not later) because the early-exit threshold below reads it.
  const uncertaintyResult = lookupUncertainty(process.cwd(), message, requestId)
  // Uncertainty surface can also lower the early-exit threshold (force full pipeline already handled via complexity)
  // Quality predictor: lower threshold on high-confidence easy queries; uncertainty surface raises it on known-weak topics
  // Stage weight multipliers: if stage3_critique has historically negative delta for this
  // prompt type (high confidence), it adds latency without value — let early-exit fire sooner.
  // If it has positive delta, require higher Stage 1 quality before skipping it.
  const stageMultipliers = getStageMultipliers(process.cwd(), promptType as any)
  const critiqueMultiplier = stageMultipliers.stage3_critique  // >1 = critique adds value, <1 = doesn't
  const baseEarlyExitThreshold = uncertaintyResult.lowerEarlyExitThreshold
    ? 0.92  // harder to early-exit on topics where calibration has historically been weak
    : (qualityPrediction.confidence >= 0.5 && qualityPrediction.predictedScore >= 0.8) ? 0.75 : 0.85
  // Shift threshold by at most ±0.05 based on critique value learned so far
  const qualityEarlyExitThreshold = Math.max(0.60, Math.min(0.95,
    baseEarlyExitThreshold + (1.0 - critiqueMultiplier) * 0.1
  ))
  if (qualityPrediction.sampleSize > 0) {
    debugBus.emit('pipeline', 'quality_prediction', {
      predictedScore: qualityPrediction.predictedScore,
      confidence: qualityPrediction.confidence,
      trend: qualityPrediction.trend,
      earlyExitThreshold: qualityEarlyExitThreshold,
      forceFull: qualityForceFull,
    }, { severity: 'info' })
    console.log(`[Quality] Predicted score: ${qualityPrediction.predictedScore} (conf: ${qualityPrediction.confidence}) → earlyExit@${qualityEarlyExitThreshold}`)
  }

  // Collaboration gradient — assess whether to answer, caveat, or ask for clarification.
  // D1 — resolve ambiguity from context the user already gave (prior turns + project
  // memory): boost confidence so the system doesn't ask about things it can already
  // infer. We do NOT blanket-suppress clarification — a genuinely ambiguous question
  // that context does not resolve should still be asked. The boost just raises the bar
  // so asking stays rare: "smart enough to do most things without added context."
  const hasPriorContext = (Array.isArray(history) && history.length > 0) ||
    (chatSessionId ? getSessionMessages(chatSessionId).length > 1 : false)
  const memoryCtx = (() => { try { return readMemoryDigest(process.cwd()).length > 40 } catch { return false } })()
  const contextBoost = (hasPriorContext ? 0.15 : 0) + (memoryCtx ? 0.08 : 0)
  const collabDecision = assessCollabMode(
    message,
    qualityPrediction.predictedScore,
    qualityPrediction.confidence,
    qualityPrediction.sampleSize,
    { contextBoost }
  )
  if (collabDecision.mode === 'clarify' && collabDecision.clarifyQuestion) {
    // Skip the full pipeline — return the clarifying question immediately
    const clarifyText = buildClarifyResponse(message, collabDecision.clarifyQuestion)
    sendAndRecord({ type: 'thinking' })
    sendAndRecord({ type: 'synthesis', modelId: 'system', model: 'Crucible', text: clarifyText, done: true, replace: false })
    sendAndRecord({ type: 'stage', stage: 5, status: 'done' })
    res.write('data: [DONE]\n\n')
    res.end()
    debugBus.emit('pipeline', 'collab_clarify', { question: collabDecision.clarifyQuestion }, { severity: 'info' })
    return
  }

  let complexity = scoreComplexity(message)
  if (qualityForceFull || uncertaintyResult.forceFullPipeline) complexity = 'complex'
  console.log(`[Pipeline] Complexity: ${complexity}`)
  const config = complexity === 'simple' ? SIMPLE_PIPELINE_CONFIG : PIPELINE_CONFIG

  // ── Circuit breaker probes ────────────────────────────────────────────────
  const allRegistryModels = Object.values(MODEL_REGISTRY)
  const probingModels = allRegistryModels.filter(m => getCircuitState(m.id) === 'probing')
  if (probingModels.length > 0) {
    console.log(`[CircuitBreaker] Probing ${probingModels.length} model(s): ${probingModels.map(m => m.label).join(', ')}`)
    await Promise.all(probingModels.map(async (m) => {
      try {
        await callModel(m as unknown as SelectedModel, [{ role: 'user', content: 'ping' }])
        resetCircuitBreaker(m.id); saveCircuitState()
        console.log(`[CircuitBreaker] Probe success — ${m.label} restored`)
      } catch (e: any) {
        const is429 = e.message?.includes('429') || e.message?.includes('quota') || e.message?.includes('rate limit')
        if (is429) {
          tripCircuitBreaker(m.id, parseRetryDelay(e.message, m.provider), 'quota-429'); saveCircuitState()
          console.log(`[CircuitBreaker] Probe failed (429) — ${m.label} re-tripped`)
        } else {
          // Non-429 probe failure (timeout, 5xx, network) — re-trip with a short cooldown
          // rather than leaving in probing state indefinitely. Probing models must not
          // remain selectable: if the probe fails they are not recovered yet.
          tripCircuitBreaker(m.id, 5 * 60 * 1000, 'probe-fail'); saveCircuitState()
          console.log(`[CircuitBreaker] Probe failed (${e.message?.slice(0, 60)}) — ${m.label} re-tripped 5min`)
        }
      }
    }))
  }

  // C4 — adaptive ensemble size based on quality predictor confidence
  const adaptiveConfig = { ...config }
  if (qualityPrediction.sampleSize > 30) {
    if (qualityPrediction.confidence >= 0.70 && qualityPrediction.predictedScore >= 0.75) {
      // High confidence on easy question — shrink to 2 models
      adaptiveConfig.parallelCount = Math.max(2, Math.min(config.parallelCount, 2))
    } else if (qualityPrediction.confidence < 0.35) {
      // Low confidence — expand to max+2 models for harder coverage
      adaptiveConfig.parallelCount = Math.min(config.parallelCount + 2, 8)
    }
  }

  const selResult = selectModels(promptType, adaptiveConfig, complexity, mode)
  const forcedSlots = getForcedModels(promptType as any, MODEL_REGISTRY, getSpecializationWeights)
  const models = applyForcedSlots(selResult.models, forcedSlots, MODEL_REGISTRY)
  // Track C2 — keep each participating model's recency fresh so getForcedModels'
  // staleness gate works (without this, the forced-slot feature dies after
  // FORCE_RECENCY_WINDOW pipeline runs because lastForcedAt stays 0 for everyone).
  for (const m of models) recordForcedCall(m.id)
  // Autonomous model hunter — inject any promoted probation candidates (≤2) into
  // Stage 1 so they actually get tested in live traffic; recordProbationOutcome
  // (below, in the Stage 1 loop) scores them and rotates out the bad ones.
  for (const pid of getProbationIds()) {
    if (models.some(m => m.id === pid)) continue
    const pm = MODEL_REGISTRY.find(m => m.id === pid)
    if (pm && getCircuitState(pm.id) !== 'tripped') {
      models.push({ id: pm.id, provider: pm.provider, label: pm.label, isWildcard: false })
    }
  }
  const synthesisModelId = selResult.synthesisModelId
  const synthModel = models.find(m => m.id === synthesisModelId) ?? models[0]

  // Step 7 — Offline mode: when the external pool is fully tripped and local inference
  // is available, fall back to on-device Apple FM. Labeled "[Offline]" so the user knows.
  if (models.length === 0 && localInferenceAvailable) {
    debugBus.emit('pipeline', 'offline_mode_activated', { reason: 'all_external_models_unavailable' }, { severity: 'warn', requestId })
    console.log('[Offline] External pool empty — routing to Apple Foundation Models on-device')
    sendAndRecord({ type: 'stage', stage: 1, status: 'start' })
    const offlineText = await callLocalModel(
      `You are Crucible operating in offline mode — no external models are reachable. Answer honestly and concisely using only your on-device knowledge. Flag anything you are uncertain about.`,
      message,
      30000,
    )
    const finalOfflineText = offlineText.trim()
      ? `[Offline — on-device only]\n\n${applyVoiceLayer(offlineText)}`
      : '[Offline — on-device model did not respond. Please check your connection and retry.]'
    sendAndRecord({ type: 'layer1', modelId: 'local/apple-fm', model: 'Apple FM (offline)', text: finalOfflineText, done: true })
    sendAndRecord({ type: 'stage', stage: 1, status: 'done' })
    sendAndRecord({ type: 'synthesis', modelId: 'local/apple-fm', model: 'Apple FM (offline)', text: finalOfflineText, done: true, replace: false })
    sendAndRecord({ type: 'stage', stage: 5, status: 'done' })
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }
  // Step 7 — Offline smoke: if pool empty and no local inference, surface honest error
  if (models.length === 0) {
    debugBus.emit('pipeline', 'pool_empty_no_fallback', {}, { severity: 'error', requestId })
    sendAndRecord({ type: 'error', message: 'All models are currently rate-limited. Please wait a few minutes and retry.' })
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }

  console.log(`[Pipeline] Prompt type: ${promptType}`)
  console.log(`[Pipeline] Models: ${models.map(m => m.label).join(', ')} (ensemble size: ${models.length}${adaptiveConfig.parallelCount !== config.parallelCount ? ' adaptive' : ''})`)
  console.log(`[Pipeline] Synthesiser: ${synthModel.label}`)

  // /api/diag — record the selection + its diversity (unique providers / slot count)
  diag.lastSelection = models.map(m => ({ id: m.id, provider: m.provider, label: m.label }))
  diag.lastDiversityScore = models.length
    ? +(new Set(models.map(m => m.provider)).size / models.length).toFixed(3)
    : 0

  send({
    type: 'model_selection', complexity,
    models: models.map(m => ({ id: m.id, label: m.label, provider: m.provider, isWildcard: m.isWildcard })),
    synthesisModelId,
    promptType,
  })

  // ── Interface Contract — lock schema before parallel execution ──────────────
  const contract: InterfaceContract = generateContract(message, promptType)
  // Inject world memory into pipeline system prompt (agent already gets this via loop.ts)
  if (mode !== 'agent') {
    try {
      const worldCtx = buildWorldContext()
      if (worldCtx) contract.systemPrompt = `${contract.systemPrompt}

${worldCtx}`
    } catch (e: any) {
      console.warn('[WorldContext] Failed to inject:', e.message)
    }
  }
  console.log(`[Contract] Generated for type: ${promptType}`)
  sendAndRecord({ type: 'contract', promptType, requiredStructure: contract.requiredStructure, forbiddenAntipatterns: contract.forbiddenAntipatterns })

  // ── Partial / streaming scoring ────────────────────────────────────────────
  // Cheap, deterministic provisional score from the *partial* text as it streams,
  // so the score bar fills live and the adaptive early-exit can drop models that
  // are already clearly losing — without waiting for the full response to finish.
  const STUB_RX = /\b(TODO|FIXME|your code here|implement this|as an ai|i cannot|i can't help|placeholder)\b/i
  const promptKeywords = (Array.from(new Set(
    message.toLowerCase().match(/[a-z]{4,}/g) ?? []
  )).slice(0, 40)) as string[]
  function provisionalScore(partial: string): number {
    if (!partial) return 0
    const t = partial.trim()
    // Length completeness — saturating; a few hundred chars reads as substantive.
    const lengthScore = Math.min(1, t.length / 600)
    // Structure — code fences (code mode) or terminated sentences (prose).
    const hasFence = /```/.test(t)
    const sentences = (t.match(/[.!?](\s|$)/g) ?? []).length
    const structureScore = mode === 'code'
      ? (hasFence ? 1 : Math.min(0.6, t.length / 400))
      : Math.min(1, sentences / 4)
    // Relevance — overlap with prompt keywords.
    const lower = t.toLowerCase()
    const hits = promptKeywords.filter(k => lower.includes(k)).length
    const relevanceScore = promptKeywords.length ? Math.min(1, hits / Math.min(8, promptKeywords.length)) : 0.5
    // Penalty for stub / refusal / error markers.
    const penalty = STUB_RX.test(t) ? 0.5 : 1
    const raw = (0.4 * lengthScore + 0.3 * structureScore + 0.3 * relevanceScore) * penalty
    return parseFloat(raw.toFixed(3))
  }

  // ── L1 — Parallel intake: prompt hardening (A/B) + web grounding fire simultaneously ──
  // Previously sequential; now both run in Promise.all — saves up to 5s on time-sensitive queries.
  const hardeningCohort: 'hardened' | 'raw' = Math.random() < 0.20 ? 'hardened' : 'raw'
  let workingMessage = message
  let groundingBlock = ''
  let academicBlock = ''
  let scaffoldBlock = ''

  await Promise.all([
    // E2 — Prompt hardening (A/B)
    (async () => {
      if (hardeningCohort !== 'hardened' && process.env.PROMPT_HARDENING !== 'true') return
      try {
        const hardener = MODEL_REGISTRY.find(m =>
          m.provider === 'groq' && m.speed === 'fast' && getCircuitState(m.id) === 'active'
        )
        if (hardener) {
          const hardened = await Promise.race([
            callModel(
              { id: hardener.id, label: hardener.label, provider: hardener.provider, isWildcard: false },
              [
                { role: 'system', content:
                  'You are a prompt clarity optimizer. Rewrite the user\'s question for maximum precision. ' +
                  'Remove ambiguity, make implicit constraints explicit, preserve intent completely. ' +
                  'Return ONLY the rewritten question — no explanation, no preamble.' },
                { role: 'user', content: message },
              ],
              { requestId }
            ),
            new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
          ]) as string
          if (hardened && hardened.length > 10 && hardened.length < message.length * 3) {
            workingMessage = hardened
            debugBus.emit('pipeline', 'prompt_hardened', { original: message.slice(0, 80), hardened: hardened.slice(0, 80) }, { severity: 'info', requestId })
          }
        }
      } catch {}
    })(),
    // A3 — Live web grounding (time-sensitive queries)
    (async () => {
      if (!isTimeDependent(message)) return
      try {
        const gr = await Promise.race([
          groundQuery(message),
          new Promise<null>(resolve => setTimeout(() => resolve(null), 5000)),
        ])
        if (gr) {
          const today = new Date().toISOString().slice(0, 10)
          groundingBlock = buildGroundingBlock(gr, today)
          debugBus.emit('pipeline', 'web_grounded', { source: gr.source, chars: gr.summary.length }, { severity: 'info', requestId })
        }
      } catch {}
    })(),
    // Step 3 — Academic retrieval lane (math/reasoning/factual complex queries)
    (async () => {
      try {
        const ag = await Promise.race([
          groundAcademic(message, promptType),
          new Promise<null>(resolve => setTimeout(() => resolve(null), 6000)),
        ])
        if (ag) {
          academicBlock = buildAcademicBlock(ag)
          debugBus.emit('pipeline', 'academic_grounded', { sources: ag.results.map(r => r.source), count: ag.results.length }, { severity: 'info', requestId })
        }
      } catch (e: any) {
        debugBus.emit('pipeline', 'academic_retrieval_error', { error: e?.message }, { severity: 'warn', requestId })
      }
    })(),
    // Step 4 — Reasoning Engine scaffold (math/reasoning complex queries)
    (async () => {
      try {
        // Use the fastest available model for scaffolding — groq/cloudflare if available
        const { models: fastPool } = selectModels(promptType, SIMPLE_PIPELINE_CONFIG, 'simple', 'quorum')
        const fastScaffoldModel = fastPool.find(m => getCircuitState(m.id) === 'active') ?? null
        const scaffold = await Promise.race([
          generateScaffold(message, promptType, complexity, callModel, fastScaffoldModel),
          new Promise<null>(resolve => setTimeout(() => resolve(null), 4000)),
        ])
        if (scaffold) {
          scaffoldBlock = buildScaffoldBlock(scaffold)
          debugBus.emit('pipeline', 'reasoning_scaffold_built', {
            scaffoldType: scaffold.scaffoldType,
            approach: scaffold.approachSuggestion.slice(0, 60),
          }, { severity: 'info', requestId })
        }
      } catch (e: any) {
        debugBus.emit('pipeline', 'reasoning_scaffold_error', { error: e?.message }, { severity: 'warn', requestId })
      }
    })(),
  ])

  // ── N3 — Domain-aware knowledge store routing ────────────────────────────
  // Classify query domain, retrieve relevant accumulated knowledge, inject into Stage 1.
  const domainCtx = getDomainContext(process.cwd(), workingMessage, requestId)
  const domainInjection = domainCtx.retrievedContext
    ? `[Domain context: ${domainCtx.domain}]\n${domainCtx.retrievedContext}\n\n`
    : ''
  // J5 — inject the cross-session "state of knowledge" doc for this query's topic
  // cluster (written after every 20 sessions in the same cluster). Closes the read
  // loop so accumulated cross-session expertise reaches Stage 1.
  const synthesisDoc = uncertaintyResult.clusterId
    ? readSynthesis(process.cwd(), uncertaintyResult.clusterId)
    : null
  const knowledgeSynthesisBlock = synthesisDoc
    ? `[ACCUMULATED KNOWLEDGE — prior cross-session synthesis for this topic. Treat as established context, not as new claims to attribute:]\n${synthesisDoc.slice(0, 4000)}`
    : ''
  if (knowledgeSynthesisBlock) {
    debugBus.emit('pipeline', 'knowledge_synthesis_injected', { clusterId: uncertaintyResult.clusterId, chars: synthesisDoc!.length }, { severity: 'info', requestId })
  }
  if (domainInjection) {
    workingMessage = domainInjection + workingMessage
  }

  // ── L2 — Parallel workstream decomposition ───────────────────────────────
  // Multi-part prompts (numbered sections, "and also", explicit lists) are split
  // into independent subtasks that each run in parallel on their own model. The
  // section answers are joined (and lightly unified when the payload is small
  // enough). Falls through to the normal Stage 1 pipeline if fewer than 3 parts.
  // NOTE: extracts from the ORIGINAL message — domain/grounding context prepended
  // to workingMessage would otherwise shift the numbered list off position 0.
  // Lower the threshold to 2 for long prompts (≥100 estimated tokens) — even a
  // 2-way parallel split prevents a complex prompt from losing threads.
  const l2Min = Math.ceil(message.length / 4) >= 100 ? 2 : 3
  const l2Subtasks = extractSubtasks(message, { min: l2Min })
  if (l2Subtasks.length >= l2Min) {
    debugBus.emit('pipeline', 'l2_decomposed', { subtaskCount: l2Subtasks.length }, { severity: 'info', requestId })
    // Track O — long-horizon: persist decomposed subtasks to the horizon plan
    extendHorizonPlan(process.cwd(), message.slice(0, 80), l2Subtasks, ambientSessionKey)
    sendAndRecord({ type: 'stage', stage: 1, status: 'start' })
    try {
      // normalizeOutput is also dynamically imported later in this handler; declare a
      // block-scoped binding here so the L2 fast-path doesn't reference it inside the
      // temporal dead zone of that later function-scoped const.
      const { normalizeOutput } = await import('./src/CrucibleEngine/normalize')
      // Use the broad (complex) pool, not the fast-only simple set — sections need
      // healthy fallback models when the free-tier pool is partly rate-limited.
      const { models: sectionModels } = selectModels(promptType, PIPELINE_CONFIG, 'complex', 'quorum')
      // Free-tier rate limits make a 7-way concurrent burst self-defeating (groq TPM
      // caps trip and every section 429s). Run sections with bounded concurrency and
      // give each one a fallback model if its primary returns empty.
      const SECTION_CONCURRENCY = Math.min(3, sectionModels.length)
      const SECTION_TIMEOUT = 22000
      const L2_DEADLINE = Date.now() + 45000   // hard ceiling on total L2 time
      let aborted = false                       // fail-fast flag (set when pool looks dead)
      const answerSection = async (intent: string, idx: number): Promise<{ intent: string; result: string }> => {
        // Try up to 2 distinct models (primary + 1 fallback) so a section can find a
        // healthy provider without burning the whole deadline on one slow section.
        const n = sectionModels.length
        const tryModels = [0, 1].map(o => sectionModels[(idx + o) % n]).filter((m, i, a) => m && a.indexOf(m) === i)
        for (const sm of tryModels) {
          if (!sm || aborted || Date.now() > L2_DEADLINE) break
          try {
            const raw = await withTimeout(
              callModel(sm, [
                { role: 'system', content: 'You are answering one section of a multi-part question. Answer ONLY the specific section given. Be concise and direct. Plain text only.' },
                { role: 'user', content: intent },
              ]),
              SECTION_TIMEOUT,
              '',
            )
            const norm = normalizeOutput(raw, { stripPreamble: true })
            if (norm && norm.length > 40) return { intent, result: norm }
          } catch { /* try fallback model */ }
        }
        return { intent, result: '' }
      }
      // Worker-pool bounded concurrency — at most SECTION_CONCURRENCY in flight.
      // Fail-fast: if the first full batch yields zero sections, the free-tier pool
      // is too degraded for the L2 fast path — abandon it and let the full pipeline
      // (streaming + early-exit) handle the prompt instead of grinding all 7 sections.
      const sectionResults: { intent: string; result: string }[] = new Array(l2Subtasks.length)
      let cursor = 0, attempted = 0, succeeded = 0
      const worker = async () => {
        while (cursor < l2Subtasks.length && !aborted && Date.now() < L2_DEADLINE) {
          const i = cursor++
          sectionResults[i] = await answerSection(l2Subtasks[i], i)
          attempted++
          if (sectionResults[i].result) succeeded++
          if (attempted >= SECTION_CONCURRENCY && succeeded === 0) aborted = true  // pool is dead — bail
        }
      }
      await Promise.all(Array.from({ length: Math.max(1, SECTION_CONCURRENCY) }, worker))
      const completed = sectionResults.filter(s => s && s.result)
      const joinedSections = completed
        .map((s, i) => `**${i + 1}. ${s.intent.slice(0, 60)}**\n${s.result}`)
        .join('\n\n')
      // Require a majority of sections to have answered, else fall through to the
      // full pipeline rather than ship a half-empty multi-part answer.
      if (completed.length >= Math.ceil(l2Subtasks.length / 2) && joinedSections.length > 100) {
        // Light unify pass ONLY when the combined payload fits a safe budget;
        // above that, re-synthesis would truncate sections, so ship them as-is.
        let finalMultipart = joinedSections
        if (joinedSections.length <= 6000) {
          try {
            const { models: synthModels } = selectModels(promptType, SIMPLE_PIPELINE_CONFIG, 'simple', 'quorum')
            const polished = await withTimeout(
              callModel(synthModels[0], [
                { role: 'system', content: 'You are the final synthesis layer. The user asked a multi-part question. You have answers to each part. Polish and unify them into a cohesive response. Preserve all content and section structure. Plain text only, no emojis.' },
                { role: 'user', content: `Original question: ${message}\n\nSection answers:\n${joinedSections}` },
              ]),
              20000,
              joinedSections,
            )
            if (polished && polished.length > joinedSections.length * 0.5) finalMultipart = normalizeOutput(polished, { stripPreamble: true })
          } catch {}
        }
        sendAndRecord({ type: 'stage', stage: 1, status: 'done', avgScores: {} })
        sendAndRecord({ type: 'stage', stage: 5, status: 'done' })
        // (pipelineSynthesisText is declared later in this handler; the L2 path ships
        // finalMultipart directly and returns, so no assignment is needed here.)
        sendAndRecord({ type: 'synthesis', modelId: 'ensemble', model: 'Parallel Workstreams', text: finalMultipart, done: true, replace: false })
        res.write('data: [DONE]\n\n')
        res.end()
        debugBus.emit('pipeline', 'l2_workstreams_done', { sections: completed.length, total: l2Subtasks.length }, { severity: 'success', requestId })
        return
      }
      debugBus.emit('pipeline', 'l2_insufficient_sections', { completed: completed.length, total: l2Subtasks.length }, { severity: 'warn', requestId })
    } catch (e: any) {
      debugBus.emit('pipeline', 'l2_fallthrough', { error: e.message }, { severity: 'warn', requestId })
      // Fall through to normal pipeline
    }
  }

  // Track O — Behavioral adaptation: build priors from preference weights + episodic memory
  const adaptation = buildAdaptationContext(process.cwd(), workingMessage, requestId)

  // Track O — Long-horizon context: if this query continues an in-progress plan, inject it
  const horizonBlock = getLongHorizonContext(process.cwd(), workingMessage, requestId)

  // Track J — Causal memory: surface why structurally-related things worked/failed,
  // so models reason from causal precedent rather than from scratch. Local graph
  // traversal, no model call — zero latency cost.
  let causalDigest = ''
  try { causalDigest = buildCausalDigest(workingMessage) }
  catch (e: any) { debugBus.emit('pipeline', 'causal_digest_error', { error: e?.message ?? String(e) }, { severity: 'error', requestId }) }

  // Cross-session contradiction scan: if this query conflicts with a conclusion from
  // a prior session, surface it rather than silently contradicting past work.
  let contradictionWarning = ''
  try {
    const contradictionEvents = scanForContradictions(workingMessage, process.cwd(), requestId)
    contradictionWarning = buildContradictionWarning(contradictionEvents)
  } catch (e: any) {
    debugBus.emit('pipeline', 'contradiction_scan_error', { error: e?.message ?? String(e) }, { severity: 'error', requestId })
  }

  // ── Track P + U — MASTERPIECE light mode + ANIMA, fired at request arrival ──
  // Both run in PARALLEL with Stage 1 so they add zero latency to the critical
  // path. Light mode (local corpus enrichment, < 500ms) and ANIMA shaping
  // (synchronous valence + store query) produce context that is injected into
  // the Stage 5 synthesis prompt below.
  const mpDeps = {
    // REJECT-SAFE: free-tier providers throw 429 under load, and withTimeout only
    // catches timeouts (Promise.race), NOT rejections — so an un-caught 429 would
    // propagate through a stage's Promise.all and abort the ENTIRE deep pipeline.
    // Returning '' on failure lets each masterpiece/ANIMA sub-stage degrade to its
    // own fallback (heuristic shard split, default coherence, original shard text)
    // instead of all-or-nothing. The deep assembler guards against an empty result.
    // Offline-first is enforced universally inside callModel (offlineGate) — no
    // per-site gating here. This wrapper only degrades failures (incl. the strict
    // OfflineStrictError) to '' so a 429 / abstain in one MASTERPIECE sub-stage
    // degrades that stage to its own heuristic fallback instead of aborting the
    // whole deep pipeline via an un-caught rejection in Promise.all.
    callModel: (m: { id: string; label: string; provider: string; isWildcard: boolean }, msgs: { role: string; content: string }[], opts?: { requestId?: string }) =>
      callModel(m as any, msgs, { requestId: opts?.requestId ?? requestId })
        .catch((e: any) => { console.error('[mpDeps.callModel] model failed (degrading):', e?.message?.slice(0, 120)); return '' }),
    selectModels: (pt: string, cfg?: unknown, complexity?: 'simple' | 'complex') => {
      const validPt = (['coding','reasoning','creative','factual','math','general'] as const).includes(pt as any)
        ? pt as 'coding'|'reasoning'|'creative'|'factual'|'math'|'general'
        : 'general'
      return selectModels(validPt, cfg as any, complexity, mode as 'quorum')
    },
    withTimeout,
    requestId,
  }
  const mpGate = evaluateGate(message)
  // /api/diag — gate decision + light/deep fire counters
  diag.lightFiredThisSession++  // light is always on
  if (mpGate.mode === 'deep') diag.deepFiredThisSession++
  diag.lastGateDecision = {
    mode: mpGate.mode,
    reason: mpGate.deepReasons.length ? mpGate.deepReasons.join('; ') : 'all deep conditions met',
    conditions: { tokenEstimate: mpGate.tokenEstimate, detectedSubtasks: mpGate.detectedSubtasks, promptType: mpGate.promptType },
  }
  // Light mode — always on. Detached promise with internal guards; never rejects.
  // recordSignal=false for deep-bound prompts: deep mode runs the full dialectical
  // calibration (recordCalibration) on the same paths, so adding the weak light
  // signal too would double-reinforce a path within one request.
  const lightPromise: Promise<EnrichedContext | null> = runMasterpieceLight(message, history, mpDeps, { recordSignal: mpGate.mode !== 'deep' })
    .then(ctx => {
      console.log(`[MASTERPIECE:light] found ${ctx.connections.length} connections, novelty scores: [${ctx.connections.map(c => c.noveltyScore.toFixed(2)).join(', ')}]`)
      // /api/diag — corpus hit rate (light fires that returned ≥1 connection) + novelty
      if (ctx.connections.length > 0) {
        diag.lightWithHits++
        for (const c of ctx.connections) diag.noveltyScores.push(c.noveltyScore)
        if (diag.noveltyScores.length > 500) diag.noveltyScores.splice(0, diag.noveltyScores.length - 500)
      }
      return ctx
    })
    .catch(e => { console.error('[MASTERPIECE:light] error (non-blocking):', e?.message); return null })
  // ANIMA shaping — synchronous, instant (valence + store query, no model calls).
  let animaShaping: AnimaShaping | null = null
  try {
    animaShaping = runAnimaShaping(history, message)
    // /api/diag — last valence reading + shaping-applied counter
    diag.lastValence = { score: animaShaping.valence.score, dominant: animaShaping.valence.dominant, confidence: animaShaping.valence.confidence }
    if (animaShaping.appliedTruths?.length) diag.animaShapingApplied++
    if (animaShaping.valence.confidence >= 0.4) {
      console.log(`[ANIMA] valence: ${animaShaping.valence.dominant} (${animaShaping.valence.score.toFixed(2)}, conf ${animaShaping.valence.confidence.toFixed(2)}), directives: tone=${animaShaping.directives.toneShift} lead=${animaShaping.directives.leadWith}`)
    }
  } catch (e: any) {
    console.error('[ANIMA] shaping error (non-blocking):', e?.message)
  }

  // ── Stage 1 — parallel responses ─────────────────────────────────────────
  console.log('[Stage 1] Starting')
  const responses: Record<string, string> = {}
  const scores: Record<string, number>    = {}
  const provisional: Record<string, number> = {}
  const streamed: Record<string, string>     = {}
  for (const m of models) { responses[m.id] = ''; scores[m.id] = 0; provisional[m.id] = 0; streamed[m.id] = '' }

  // ── Speculative synthesis ───────────────────────────────────────────────────
  // When an early model finishes Stage 1 with a dominant score (>=0.85, which forces
  // the early-exit path) while slower models are still streaming, we speculatively
  // start synthesis NOW on the responses gathered so far — overlapping the synth call
  // with the dead wait for stragglers. At Stage 5 we COMMIT the speculative result if
  // the final synthesis input set is exactly what we speculated on (stragglers dropped
  // or rolled back); otherwise we DISCARD it and synthesise normally. The wasted call
  // costs nothing on the free tier; the win is hiding synthesis latency behind Stage 1.
  const synthSystemContent =
    mode === 'seeker'
      ? 'You are the synthesis layer of an adversarial AI pipeline. You have attack analyses from multiple models. Your job: produce a ranked vulnerability report. Lead with the most critical finding. Be precise, not exhaustive. Format: numbered list, most critical first. Plain text only — never use emojis or decorative pictographs.'
      : mode === 'code'
      ? 'You are the synthesis layer of a multi-model AI pipeline specialising in code. You have revised responses from different models. Your job: produce ONE definitive, working code solution. Prefer correctness over brevity. Include all necessary code. ALWAYS put the code inside a single fenced code block with the correct language tag (```language … ```) — this is required, not optional. Explain key decisions briefly in prose after the code block. Plain text only — never use emojis or decorative pictographs.'
      : 'You are the final synthesis layer of a multi-model AI pipeline. You have been given multiple independent responses to the same question.\n\n' +
        'Your job is to produce the SINGLE BEST POSSIBLE answer — authoritative, precise, and genuinely useful. You are writing THE answer, not summarising the responses.\n\n' +
        'How to synthesize well:\n' +
        '1. Anchor on the most rigorous reasoning — pick the strongest track and build from it\n' +
        '2. Cross-verify facts and numbers; where responses disagree, reason through which is correct\n' +
        '3. Fill gaps — if all responses miss something the user clearly needs, supply it from your own knowledge\n' +
        '4. Lead with a direct, decisive answer; follow with the most important supporting context\n' +
        '5. Be concrete — specific numbers, names, mechanisms, and examples beat vague generalities\n\n' +
        'CRITICAL: Never reference the source responses or mention which model said what. Write as a single unified voice — the reader should not know this answer came from a pipeline. ' +
        'Plain text only — never use emojis or decorative pictographs. ' +
        'For code requests: always put code in a fenced code block with the correct language tag, then explain briefly after. Never describe the code in prose without showing it.'

  const { normalizeOutput: normalizeForSynth } = await import('./src/CrucibleEngine/normalize')
  const distillationCtx = getDistillationContext(process.cwd(), promptType, 3)

  // Synthesis payload budget — keeps the combined prompt within the context window
  // of small free-tier models (≈8k tokens). Without this, a multi-part prompt where
  // 8 models each write 1k+ words overflows and the provider returns "request too
  // large". Entries are ranked by score so the strongest responses survive the cap.
  const SYNTH_ENTRY_BUDGET = 12000   // total chars across all model entries
  const SYNTH_PER_MODEL_CAP = 3000   // max chars taken from any single model
  function boundedSynthEntries(ids: string[], store: Record<string, string>): string {
    const ranked = ids
      .filter(id => store[id] && !store[id].startsWith('Error:'))
      .sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0))
    let budget = SYNTH_ENTRY_BUDGET
    const parts: string[] = []
    const letters = 'ABCDEFGHIJKLMNOP'
    for (let i = 0; i < ranked.length; i++) {
      if (budget <= 200) break
      const id = ranked[i]
      const text = normalizeForSynth(store[id]).slice(0, Math.min(SYNTH_PER_MODEL_CAP, budget))
      // Anonymous labels prevent synthesis from referencing specific model names in output
      parts.push(`Response ${letters[i] ?? i + 1}:\n${text}`)
      budget -= text.length
    }
    return parts.join('\n\n')
  }

  function buildSynthesisMessages(entryIds: string[], causal = '') {
    const entries = boundedSynthEntries(entryIds, responses)
    const causalBlock = causal ? `\n\nCAUTION — potential failure modes identified by an auditor:\n${causal}\n\nAddress or rule out these failure modes in your synthesis.` : ''
    const distillBlock = distillationCtx ? `\n\n${distillationCtx}` : ''
    const contradictionBlock = contradictionWarning ? `\n\n${contradictionWarning}` : ''
    return [
      { role: 'system' as const, content: synthSystemContent },
      { role: 'user' as const, content: `Original question: ${message}\n\n${entries}${causalBlock}${distillBlock}${contradictionBlock}\n\nSynthesise these into one definitive answer.` },
    ]
  }

  let speculation: { ids: string[]; synthId: string; promise: Promise<string> } | null = null
  function maybeSpeculate(leaderId: string) {
    if (speculation) return
    const ready = models.filter(m => responses[m.id] && !responses[m.id].startsWith('Error:') && responses[m.id].length >= 20).map(m => m.id)
    const pending = models.some(m => !responses[m.id] && scores[m.id] === 0)
    if (!pending || ready.length === 0) return  // nothing to overlap, or nothing usable yet
    const synthId = leaderId
    debugBus.emit('pipeline', 'speculative_synthesis_start', { synthId, inputCount: ready.length, requestId })
    console.log(`[Speculative] Starting synthesis on ${ready.length} ready track(s) while ${models.length - ready.length} still pending`)
    speculation = {
      ids: ready,
      synthId,
      promise: withTimeout(callModel(models.find(m => m.id === synthId)!, buildSynthesisMessages(ready)), 45000, '').catch(() => ''),
    }
  }

  // Step 3 — Specialist role assignment for complex queries
  const specialistRoleMap = assignSpecialistRoles(models.map(m => m.id), promptType, complexity)
  if (specialistRoleMap.size > 0) {
    debugBus.emit('pipeline', 'specialist_roles_assigned', {
      roles: Object.fromEntries([...specialistRoleMap.entries()].map(([id, r]) => [id, r.id])),
      promptType, complexity,
    }, { severity: 'info', requestId })
  }

  // Adaptive early-exit: once first model finishes, remaining models get a complexity-aware timeout
  let firstDone = false
  let adaptiveTimer: ReturnType<typeof setTimeout> | null = null
  const modelResolvers: Record<string, () => void> = {}
  const modelPromises = models.map(model => new Promise<void>(resolve => { modelResolvers[model.id] = resolve }))

  // Track Q — standby hot-swap bookkeeping. A hard failure during the early
  // window dispatches a diverse standby that re-enters this same function and
  // joins the ensemble (appended to `models` so downstream stages include it).
  const swappedIds = new Set<string>()
  let hotSwapsRemaining = 2
  async function runStage1Model(model: SelectedModel): Promise<void> {
    const _t0 = Date.now()
    try {
      console.log(`[Stage 1] ${model.label} starting`)
      const modelEntry = getModelEntry(model.id)
      const slotIndex = models.indexOf(model)
      const aspectContext = modelEntry
        ? getAspectContext(model.id, promptType, modelEntry.fit, slotIndex)
        : ''
      const codebaseContext = queryIndex(message)
      const modeAppend =
        mode === 'code'
          ? '\n\nMODE: CODE. You are in a code-specialist pipeline. Rules: produce complete, runnable code. ' +
            'Use fenced code blocks with language tags. No pseudo-code. No handwavy prose. ' +
            'If you explain, do it concisely after the code. Prioritise correctness over elegance.'
          : mode === 'seeker'
          ? '\n\nMODE: SEARCH. You are a research specialist. Prioritise factual accuracy over depth. ' +
            'State what you know confidently, what you are uncertain about explicitly. ' +
            'If a claim has a specific well-known source, name it. Do not hallucinate citations.'
          : ''
      const roleAddendum = buildRoleAddendum(model.id, specialistRoleMap)
      const fullSystemPrompt = [
        contract.systemPrompt + modeAppend,
        aspectContext || '',
        codebaseContext ? `// Relevant project files:\n${codebaseContext}` : '',
        adaptation.injectionBlock || '',
        horizonBlock || '',
        knowledgeSynthesisBlock || '',   // J5: cross-session state-of-knowledge doc
        causalDigest || '',
        contradictionWarning || '',
        scaffoldBlock || '',   // Step 4: reasoning scaffold for math/reasoning complex queries
        roleAddendum || '',
      ].filter(Boolean).join('\n\n')
      console.log(`[RAG] ${model.label} aspect context injected (${aspectContext.length} chars)${codebaseContext ? ` + ${codebaseContext.length} chars codebase context` : ''})`)
      // ── Use prewarm result if available for this model ───────────────────
      let text: string
      if (prewarmResults[model.id]) {
        text = prewarmResults[model.id]
        console.log(`[Prewarm] Injected into Stage 1 — ${model.label} (${text.length} chars)`)
        sendAndRecord({ type: 'layer1', modelId: model.id, model: model.label, text })
        delete prewarmResults[model.id]
      } else {
        const s1TimeoutMs = complexity === 'simple' ? 15000 : 30000
        let lastScoredLen = 0
        text = await withTimeout(
          callModelStreaming(
            model,
            [{ role: 'system', content: fullSystemPrompt }, { role: 'user', content: [groundingBlock, academicBlock, workingMessage].filter(Boolean).join('\n\n') }],
            (chunk) => {
              streamed[model.id] += chunk
              // Re-score at most every ~200 chars of growth to keep this cheap.
              const buf = streamed[model.id]
              if (buf.length - lastScoredLen >= 200) {
                lastScoredLen = buf.length
                provisional[model.id] = provisionalScore(buf)
                sendAndRecord({ type: 'layer1', modelId: model.id, model: model.label, text: chunk, score: provisional[model.id], provisional: true })
              } else {
                sendAndRecord({ type: 'layer1', modelId: model.id, model: model.label, text: chunk })
              }
            }
          ),
          s1TimeoutMs,
          ''
        )
      }
      // If the straggler timer already dropped this model while it was streaming,
      // bail out — don't write to shared state or run linting. The timer already
      // resolved modelResolvers[model.id], so the pipeline has moved on.
      if (timerDropped.has(model.id)) {
        console.log(`[Stage 1] ${model.label} finished after straggler drop — ignoring late response`)
        return
      }
      responses[model.id] = text
      // Track Q — viability fingerprint: Stage 1 streams (bypasses _emitModelResult),
      // so record the success outcome here. Empty text = timeout fallback = failure.
      recordModelOutcome(model.id, text.length > 0, Date.now() - _t0)
      recordProbationOutcome(process.cwd(), model.id, { ok: text.length > 0, hardFail: false })
      let result = evaluateIteration(
        { proposedSource: text, problemStatement: message, pipelineLayer: 1, promptType, contract },
        SCORING_CONFIG, 1
      )

      // ── Straggler clock starts on the first valid response — before linting ──
      // The linter remediation can add 5-20s; don't let it gate the adaptive timer.
      // Any model that produced a non-empty response (score > 0) qualifies.
      const preLinterscore = result.score.compositeScore
      if (!firstDone && preLinterscore > 0 && !text.startsWith('Error:')) {
        firstDone = true
        const waitMs = complexity === 'simple'
          ? 2000
          : preLinterscore >= qualityEarlyExitThreshold ? 2500
          : promptType === 'factual' ? (preLinterscore >= 0.55 ? 2500 : 3500)
          : preLinterscore >= 0.65 ? 4000
          : 6000
        console.log(`[Stage 1] First response (${model.label}, score: ${preLinterscore.toFixed(2)}) — straggler clock starts, wait ${waitMs}ms`)
        adaptiveTimer = setTimeout(() => {
          for (const m of models) {
            // Drop any model that hasn't fully scored yet — this catches both models
            // that haven't finished streaming AND models stuck in linter remediation.
            // scores[m.id] is only set after all linting completes (line ~3493).
            if (scores[m.id] === 0) {
              console.log(`[Stage 1] Adaptive timeout — dropping ${m.label}`)
              timerDropped.add(m.id)
              recordModelFailure(m.id)
              recordModelOutcome(m.id, false)
              modelResolvers[m.id]?.()
            }
          }
        }, waitMs)
      }

      // ── Linter Gate — one remediation pass if contract violated ────────────
      // Only remediate coding queries where the response actually contains code.
      // If the response is prose (no code blocks), the linter can't help — skip it.
      // This guards against misclassified analytical queries (e.g. "compare SQL vs NoSQL"
      // landing as promptType=coding) triggering futile 8s remediation cycles.
      const hasCodeBlock = /```[\w]*\n[\s\S]+?```/.test(text)
      // Only lint responses that have actual function/class definitions — SQL queries,
      // simple scripts, and one-liners won't satisfy language-agnostic quality gates
      // (error handling, type annotations) so linting them just adds latency for no gain.
      const hasFunctionDef = /\b(def |function |const\s+\w+\s*=\s*(async\s+)?\(|class\s+\w+|impl\s+\w+|fn\s+\w+)/.test(text)
      // Never remediate on simple queries — the straggler timer fires at 2000ms
      // and would drop the only responding model before the 8s linting call returns.
      const wantsLinterRemediation = promptType === 'coding' &&
        hasCodeBlock &&
        hasFunctionDef &&
        complexity !== 'simple' &&
        !result.shouldAccept && result.score.compositeScore < 0.75 &&
        result.score.critiques.some(c => c.severity === 'blocking' || c.severity === 'major')
      if (wantsLinterRemediation) {
        console.log(`[Linter] ${model.label} failed gate (score: ${result.score.compositeScore.toFixed(2)}) — issuing remediation`)
        sendAndRecord({ type: 'linter', modelId: model.id, model: model.label, status: 'failed', score: result.score.compositeScore, critiqueText: result.critiqueText })

        const remediated = await withTimeout(
          callModelAgentic(model, [
            { role: 'system', content: contract.systemPrompt },
            { role: 'user', content: workingMessage },
            { role: 'assistant', content: text },
            {
              role: 'user',
              content:
                'Your previous response failed the pipeline quality gate. ' +
                'The following issues must be resolved before your response is accepted:\n\n' +
                result.critiqueText +
                '\n\nRewrite your response addressing every issue above. Conform strictly to the contract. You may use file tools if you need to inspect code.',
            },
          ]),
          8000,
          text
        )

        // Straggler timer fired while we were awaiting remediation — keep the
        // original response and pre-linting score so synthesis still has material.
        if (timerDropped.has(model.id)) {
          scores[model.id] = preLinterscore
          console.log(`[Linter] ${model.label} dropped during remediation — keeping original (score: ${preLinterscore.toFixed(2)})`)
          return
        }

        if (remediated && remediated !== text && remediated.length > 50) {
          responses[model.id] = remediated
          result = evaluateIteration(
            { proposedSource: remediated, problemStatement: message, pipelineLayer: 2, promptType, contract },
            SCORING_CONFIG, 2
          )
          console.log(`[Linter] ${model.label} remediated — new score: ${result.score.compositeScore.toFixed(2)}`)
          sendAndRecord({ type: 'linter', modelId: model.id, model: model.label, status: 'remediated', score: result.score.compositeScore })
          // Stream the remediated text to UI so user sees the improved version
          sendAndRecord({ type: 'layer1', modelId: model.id, model: model.label, text: '', remediated: true, newText: remediated })
        } else {
          console.log(`[Linter] ${model.label} remediation produced no improvement — keeping original`)
          sendAndRecord({ type: 'linter', modelId: model.id, model: model.label, status: 'unchanged' })
        }
      } else {
        console.log(`[Linter] ${model.label} passed gate (score: ${result.score.compositeScore.toFixed(2)})`)
        sendAndRecord({ type: 'linter', modelId: model.id, model: model.label, status: 'passed', score: result.score.compositeScore })
      }

      scores[model.id] = result.score.compositeScore
      sendAndRecord({ type: 'layer1', modelId: model.id, model: model.label, text: '', done: true, score: scores[model.id] })
      console.log(`[Stage 1] ${model.label} done, score: ${scores[model.id]}`)
      recordSpecialization(model.id, promptType, scores[model.id])
      // Dominant early leader (forces early-exit) OR any simple-path leader → both
      // skip Stage 3+4, so we can speculatively start synthesis while stragglers stream.
      if (scores[model.id] >= qualityEarlyExitThreshold || (complexity === 'simple' && scores[model.id] >= 0.4)) maybeSpeculate(model.id)
    } catch (e: any) {
      console.error(`[Stage 1] ${model.label} error:`, e.message)
      const is429s1 = e.message?.includes('429') || e.message?.includes('quota') || e.message?.includes('rate limit')
      const isDeadS1 = e.message?.includes('decommissioned') || e.message?.includes('model_decommissioned')
      const isTimeoutS1 = e.message?.includes('[withTimeout] Timed out')
      const isServerErrS1 = e.message?.includes('503') || e.message?.includes('502') || e.message?.includes('500')
      if (isDeadS1) {
        tripCircuitBreaker(model.id, 30 * 24 * 60 * 60 * 1000, 'decommissioned'); saveCircuitState()
        console.log(`[CircuitBreaker] ${model.label} decommissioned — tripped for 30 days`)
      } else if (is429s1) {
        tripCircuitBreaker(model.id, parseRetryDelay(e.message, model.provider), 'quota-429'); saveCircuitState()
      } else {
        recordModelFailure(model.id)
        // Repeated timeouts or server errors trip the breaker with a short cooldown.
        // A soft penalty alone doesn't prevent re-selection — the model keeps getting
        // dispatched and keeps failing. Trip after 2 consecutive hard failures.
        if ((isTimeoutS1 || isServerErrS1) && getModelFailureCount(model.id) >= 2) {
          tripCircuitBreaker(model.id, 10 * 60 * 1000, isTimeoutS1 ? 'timeout' : 'server-error'); saveCircuitState()
          console.log(`[CircuitBreaker] ${model.label} tripped 10min — repeated ${isTimeoutS1 ? 'timeouts' : 'server errors'}`)
        }
      }
      recordModelOutcome(model.id, false)  // Track Q — viability fingerprint
      recordProbationOutcome(process.cwd(), model.id, { ok: false, hardFail: isDeadS1 })
      sendAndRecord({ type: 'layer1', modelId: model.id, model: model.label, text: 'Error: ' + e.message, done: true })

      // ── Track Q — standby hot-swap ──────────────────────────────────────────
      // A hard failure (not quota/decommission — those trip the breaker and are
      // excluded by pickStandby) before the ensemble has a leader: dispatch the
      // best diverse standby not already in flight so the ensemble doesn't shrink.
      if (!firstDone && !is429s1 && !isDeadS1 && hotSwapsRemaining > 0 && !swappedIds.has(model.id)) {
        swappedIds.add(model.id)
        const inUse = [...models.map(m => m.id), ...swappedIds]
        const standby = pickStandby(promptType, complexity, inUse)
        if (standby) {
          hotSwapsRemaining--
          diag.hotSwapsThisSession++  // /api/diag
          models.push(standby)
          swappedIds.add(standby.id)  // a standby that fails is not itself re-swapped
          console.log(`[Substrate] Hot-swap: ${model.label} failed → dispatching standby ${standby.label}`)
          debugBus.emit('model', 'hot_swap', { failed: model.id, standby: standby.id, provider: standby.provider }, { severity: 'warn', requestId })
          sendAndRecord({ type: 'model_selection', complexity, models: models.map(m => ({ id: m.id, label: m.label, provider: m.provider, isWildcard: m.isWildcard })), synthesisModelId, promptType, hotSwap: { failed: model.id, standby: standby.id } })
          await runStage1Model(standby)
        }
      }
    }
    // Signal this model is done
    modelResolvers[model.id]?.()
  }
  const stage1Work = models.map(model => runStage1Model(model))

  // Gate ONLY on modelPromises — they resolve when each model finishes OR when the
  // straggler timer drops them. Straggler work continues in background (the early-return
  // inside runStage1Model prevents it from writing to shared state once dropped).
  await Promise.all(modelPromises)
  if (adaptiveTimer) clearTimeout(adaptiveTimer)
  // Suppress unhandled-rejection warnings from background stragglers
  for (const p of stage1Work) p.catch(() => {})
  console.log('[Stage 1] All done')

  // ── Stage 2 — scores ──────────────────────────────────────────────────────
  sendAndRecord({ type: 'stage', stage: 2, status: 'start' })
  sendAndRecord({ type: 'scores', scores })
  const _mids = Object.keys(scores); const _avg = _mids.length ? _mids.reduce((s, id) => s + scores[id], 0) / _mids.length : 0; sendAndRecord({ type: 'stage', stage: 2, status: 'done', avgScores: scores, pipelineAvg: parseFloat(_avg.toFixed(3)) });

  // ── Rollback Gate — quarantine failed tracks before Stage 3 ─────────────────
  const rolledBack = new Set<string>(
    models
      .filter(m =>
        timerDropped.has(m.id) ||    // dropped by straggler timer
        !responses[m.id] ||
        responses[m.id].startsWith('Error:') ||
        responses[m.id].length < 20 ||
        scores[m.id] < 0.20
      )
      .map(m => m.id)
  )
  if (rolledBack.size > 0) {
    console.log(`[Rollback] Quarantining ${rolledBack.size} track(s): ${[...rolledBack].map(id => models.find(m => m.id === id)?.label).join(', ')}`)
    sendAndRecord({ type: 'rollback', rolledBack: [...rolledBack].map(id => ({ id, reason: responses[id]?.startsWith('Error:') ? 'error' : scores[id] < 0.20 ? 'score-floor' : 'empty' })) })
  }
  let activeModels = models.filter(m => !rolledBack.has(m.id))
  if (activeModels.length === 0) {
    const best = models.reduce((a, b) => (scores[a.id] ?? 0) >= (scores[b.id] ?? 0) ? a : b)
    rolledBack.delete(best.id)
    activeModels = [best]
    console.log(`[Rollback] All tracks failed — keeping best: ${best.label} (score: ${(scores[best.id] ?? 0).toFixed(2)})`)
  }
  console.log(`[Rollback] Active tracks: ${activeModels.map(m => m.label).join(', ')}`)

  // ── Stage 2.5 — Causal probe (reasoning/math/factual only, non-blocking) ───
  // Fires concurrently with Stage 3 setup. A single fast model asks "why might
  // these answers be wrong?" and its output is injected into the synthesis prompt
  // to force causal framing — the synthesiser sees failure modes before assembling.
  const maxScoreForCausal = Math.max(...activeModels.map(m => scores[m.id] ?? 0))
  const earlyExit = maxScoreForCausal >= qualityEarlyExitThreshold
  let causalContext = ''
  const CAUSAL_TYPES = new Set(['reasoning', 'math', 'factual'])
  const wantsCausal = CAUSAL_TYPES.has(promptType) && complexity !== 'simple' && !earlyExit
  const causalProbePromise: Promise<void> = wantsCausal
    ? (async () => {
        try {
          const probeSelection = selectModels('reasoning', SIMPLE_PIPELINE_CONFIG, 'simple')
          const probeModel = probeSelection.models[0]
          if (!probeModel) return
          const topResponses = activeModels
            .sort((a, b) => (scores[b.id] ?? 0) - (scores[a.id] ?? 0))
            .slice(0, 3)
            .map(m => `[${m.label}]: ${responses[m.id]?.slice(0, 600)}`)
            .join('\n\n')
          const probeResult = await Promise.race([
            callModel(probeModel, [
              { role: 'system', content: 'You are a critical reasoning auditor. Be concise — 3-5 bullet points max. Plain text only.' },
              { role: 'user', content: `Question: ${message}\n\nTop model answers:\n${topResponses}\n\nFor each answer: (1) identify the key assumption it relies on, (2) describe one scenario where this answer would be wrong or incomplete. Be specific and brief.` },
            ]),
            new Promise<string>((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
          ])
          if (probeResult && probeResult.length > 30) {
            causalContext = probeResult
            debugBus.emit('pipeline', 'causal_probe_done', { promptType, chars: probeResult.length }, { severity: 'info', requestId })
            console.log(`[Causal] Probe done — ${probeResult.length}c`)
          }
        } catch { /* non-blocking — fall through silently */ }
      })()
    : Promise.resolve()

  // ── Stage 3 — cross-critique (skipped for simple queries) ──────────────────
  const revised: Record<string, string> = {}

  // earlyExit already declared in Stage 2.5
  if (earlyExit) {
    console.log(`[Early Exit] Max score ${maxScoreForCausal.toFixed(2)} >= ${qualityEarlyExitThreshold} — skipping Stage 3+4`)
    sendAndRecord({ type: 'stage', stage: 3, status: 'start' })
    sendAndRecord({ type: 'stage', stage: 3, status: 'done' })
    sendAndRecord({ type: 'stage', stage: 4, status: 'start' })
    sendAndRecord({ type: 'stage', stage: 4, status: 'done' })
  } else if (complexity === 'simple') {
    console.log('[Stage 3] Skipped — simple query fast-path')
    sendAndRecord({ type: 'stage', stage: 3, status: 'start' })
    sendAndRecord({ type: 'stage', stage: 3, status: 'done' })
    sendAndRecord({ type: 'stage', stage: 4, status: 'start' })
    sendAndRecord({ type: 'stage', stage: 4, status: 'done' })
  } else {
  // ── Stages 3+4 collapsed — critique-and-revise in one parallel wave ─────────
  console.log('[Stage 3+4] Starting collapsed critique-revise')
  sendAndRecord({ type: 'stage', stage: 3, status: 'start' })
  sendAndRecord({ type: 'stage', stage: 4, status: 'start' })

  for (const m of activeModels) revised[m.id] = ''

  // Straggler gate: after the first model finishes critique, wait at most 8s for others.
  // Prevents one slow model from holding the whole stage hostage.
  let s34FirstDone = false
  let s34StragglerTimer: ReturnType<typeof setTimeout> | null = null
  const s34Resolvers: Record<string, () => void> = {}
  const s34Promises = activeModels.map(m => new Promise<void>(resolve => { s34Resolvers[m.id] = resolve }))

  // Each model sees all peer responses and produces its improved answer in one call
  await Promise.all([...s34Promises, ...activeModels.map(async (model) => {
    const PEER_CAP = 1500
    const peerContext = activeModels
      .filter(m => m.id !== model.id)
      .map(m => `${m.label}'s response:\n${(responses[m.id] || '').slice(0, PEER_CAP)}`)
      .join('\n\n---\n\n')

    try {
      sendAndRecord({ type: 'critique', criticId: model.id, targetId: model.id, critic: model.label, target: model.label, text: '', status: 'start' })
      let streamedText = ''
      const result = await withTimeout(
        callModelStreaming(model, [
          {
            role: 'system',
            content:
              mode === 'seeker'
                ? 'You are one model in an adversarial AI pipeline. ' +
                  'You have seen your own analysis and peer analyses. ' +
                  'Your task: attack the peer findings. Find flaws they missed, challenge their assumptions, ' +
                  'identify edge cases and failure modes they overlooked. Be precise and ruthless.'
                : mode === 'code'
                ? 'You are one model in a code-specialist AI pipeline. ' +
                  'You have seen your own code solution and peer solutions. ' +
                  'Your task: produce a single improved, working implementation. ' +
                  'Fix any bugs in your original. Adopt better logic from peers if it exists. ' +
                  'The output must be complete, runnable code — no placeholders, no pseudo-code. ' +
                  'Use correct language syntax. Explain only what is non-obvious, after the code block.'
                : 'You are one model in a multi-model AI pipeline. ' +
                  'You have seen your own response and the responses from peer models. ' +
                  'Your task: produce a single improved response that incorporates the best insights from all responses, ' +
                  'fixes any errors in your original, and adds anything important that was missed. ' +
                  'Be direct and concise. Do not narrate what you are doing — just deliver the improved answer. ' +
                  'Plain text only — never use emojis or decorative pictographs.',
          },
          {
            role: 'user',
            content:
              `Original question: ${message}\n\n` +
              `Your previous response:\n${responses[model.id]}\n\n` +
              `Peer responses for reference:\n${peerContext || 'No peer responses available.'}\n\n` +
              `Write your improved response now.`,
          },
        ], (chunk) => {
          streamedText += chunk
          // Stream partial critique text to client as it generates
          send({ type: 'critique', criticId: model.id, targetId: model.id, text: chunk })
        }),
        20000,
        responses[model.id]
      )
      revised[model.id] = result || responses[model.id]
      sendAndRecord({ type: 'critique', criticId: model.id, targetId: model.id, critic: model.label, target: model.label, text: '', done: true })
      sendAndRecord({ type: 'revision', modelId: model.id, model: model.label, text: revised[model.id] })
    } catch (e: any) {
      console.error(`[Stage 3+4] ${model.label} error:`, e.message)
      const is429s34 = e.message?.includes('429') || e.message?.includes('quota') || e.message?.includes('rate limit')
      const isDeadS34 = e.message?.includes('decommissioned') || e.message?.includes('model_decommissioned')
      if (isDeadS34) {
        tripCircuitBreaker(model.id, 30 * 24 * 60 * 60 * 1000, 'decommissioned'); saveCircuitState()
        console.log(`[CircuitBreaker] ${model.label} decommissioned — tripped for 30 days`)
      } else if (is429s34) {
        tripCircuitBreaker(model.id, parseRetryDelay(e.message, model.provider), 'quota-429'); saveCircuitState()
      } else {
        recordModelFailure(model.id)
      }
      recordModelOutcome(model.id, false)  // Track Q — viability fingerprint
      revised[model.id] = responses[model.id]
      sendAndRecord({ type: 'revision', modelId: model.id, model: model.label, text: revised[model.id] })
    }
    // Signal this model's Stage 3+4 complete and start straggler timer on first finish
    s34Resolvers[model.id]?.()
    if (!s34FirstDone && revised[model.id] && !revised[model.id].startsWith('Error:')) {
      s34FirstDone = true
      s34StragglerTimer = setTimeout(() => {
        for (const m of activeModels) {
          if (!revised[m.id] || revised[m.id] === '') {
            console.log(`[Stage 3+4] Straggler timeout — dropping ${m.label}, using Stage 1 response`)
            revised[m.id] = responses[m.id] || ''
            s34Resolvers[m.id]?.()
          }
        }
      }, 8000)
    }
  })])
  if (s34StragglerTimer) clearTimeout(s34StragglerTimer)

  sendAndRecord({ type: 'stage', stage: 3, status: 'done' })
  sendAndRecord({ type: 'stage', stage: 4, status: 'done' })

  } // end complexity === 'complex' block

  // Ensure revised is populated for simple path or early exit (use stage 1 responses directly)
  if (complexity === 'simple' || earlyExit) {
    for (const m of activeModels) {
      revised[m.id] = responses[m.id] || ''
    }
  }

  // Await causal probe (started concurrently with Stage 3+4, should already be done)
  await causalProbePromise

  // ── Stage 5 — synthesis ───────────────────────────────────────────────────
  console.log('[Stage 5] Starting synthesis')
  sendAndRecord({ type: 'stage', stage: 5, status: 'start' })
  let pipelineSynthesisText = ''

  // Best synthesiser = highest scorer among active (non-rolled-back) tracks
  const activeSynthModel = activeModels
    .filter(m => revised[m.id] && revised[m.id].length > 0 && !revised[m.id].startsWith('Error:'))
    .sort((a, b) => (scores[b.id] ?? 0) - (scores[a.id] ?? 0))[0]
    ?? activeModels[0]
    ?? models[0]

  console.log(`[Stage 5] Synthesiser: ${activeSynthModel.label}`)

  const { normalizeOutput, extractLengthDirective } = await import('./src/CrucibleEngine/normalize')

  const revisedEntries = boundedSynthEntries(models.map(m => m.id), revised)

  // ── Track P + U — inject light enrichment + ANIMA shaping into synthesis ───
  // Light mode fired in parallel with Stage 1; by now it has resolved. ANIMA
  // shaping was computed synchronously at request arrival. Both are folded into
  // the synthesis system/user prompt — invisibly to the user.
  const lightCtx = await lightPromise.catch(() => null)
  const lightEnrichment = lightCtx ? renderLightEnrichment(lightCtx) : ''
  // Light enrichment is invisible UNLESS a connection scored above 0.6 novelty —
  // then we surface one plain-language sentence in HOW WE GOT HERE.
  if (lightCtx && lightCtx.topNovelty > 0.6 && lightCtx.connections.length) {
    const top = lightCtx.connections[0]
    sendAndRecord({ type: 'masterpiece_light', topNovelty: lightCtx.topNovelty, connection: top.bridgeHint, sourceDomain: top.sourceDomain, targetDomain: top.targetDomain })
  }
  const shapingBlock = animaShaping ? renderShapingBlock(animaShaping.directives) : ''
  const shapedSynthSystem = shapingBlock ? `${synthSystemContent}\n\n${shapingBlock}` : synthSystemContent
  const enrichmentBlock = lightEnrichment ? `\n\n${lightEnrichment}` : ''

  try {
    const synthesisMessages = [
      { role: 'system' as const, content: shapedSynthSystem },
      {
        role: 'user' as const,
        content: `Original question: ${message}\n\n${revisedEntries}${causalContext ? `\n\nCAUTION — potential failure modes identified by an auditor:\n${causalContext}\n\nAddress or rule out these failure modes in your synthesis.` : ''}${enrichmentBlock}\n\nSynthesise these into one definitive answer.`,
      },
    ]

    // ── Speculative commit/discard ────────────────────────────────────────────
    // Commit the speculative synthesis iff its input set is exactly the final
    // synthesis input set (stragglers dropped/rolled back). On a hit we skip the
    // real synth call entirely; on a miss we discard and synthesise normally.
    const finalInputIds = models.filter(m => revised[m.id]).map(m => m.id).sort()
    const specHit = speculation
      && JSON.stringify([...speculation.ids].sort()) === JSON.stringify(finalInputIds)
      && (earlyExit || complexity === 'simple')

    let synthesisText: string
    if (specHit && speculation) {
      const speculated = await speculation.promise
      if (speculated && speculated.length > 20) {
        console.log('[Speculative] HIT — committing pre-computed synthesis (synth latency hidden behind Stage 1)')
        debugBus.emit('pipeline', 'speculative_synthesis_hit', { inputCount: speculation.ids.length, requestId }, { severity: 'success' })
        send({ type: 'synthesis_token', text: speculated })
        synthesisText = speculated
      } else {
        debugBus.emit('pipeline', 'speculative_synthesis_miss', { reason: 'empty', requestId }, { severity: 'info' })
        synthesisText = await withTimeout(
          callModelStreaming(activeSynthModel, synthesisMessages, (chunk) => send({ type: 'synthesis_token', text: chunk })),
          45000, revised[activeSynthModel.id] || Object.values(revised).find(r => r) || ''
        )
      }
    } else {
      if (speculation) {
        console.log('[Speculative] MISS — input set changed; discarding and synthesising normally')
        debugBus.emit('pipeline', 'speculative_synthesis_miss', { reason: 'input-set-changed', requestId }, { severity: 'info' })
      }
      // Stream synthesis tokens to client — user sees the answer build in real-time
      synthesisText = await withTimeout(
        callModelStreaming(activeSynthModel, synthesisMessages, (chunk) => {
          send({ type: 'synthesis_token', text: chunk })
        }),
        45000,
        revised[activeSynthModel.id] || Object.values(revised).find(r => r) || ''
      )
    }

    // ── A2/A4/Hypothesis — all three run concurrently to minimize pre-polish latency ──
    // cf: adversarial counterfactual (factual/reasoning/math)
    // trace: sandbox-execute first code block (coding only)
    // hyp: generate-and-run a verification test for computational claims
    // All three results feed extraIssues → polish pass; awaited together below.
    let counterfactualCaveat = ''
    const cfPromise = CF_TYPES.has(promptType) ? (async () => {
      try {
        const cfModel = MODEL_REGISTRY.find(m => m.provider === 'openrouter' && getCircuitState(m.id) === 'active')
        if (!cfModel) return
        const { caveat } = await runCounterfactual(
          message, synthesisText, promptType, process.cwd(),
          (m, msgs, opts) => callModel(m, msgs, { ...opts, requestId }),
          { id: cfModel.id, label: cfModel.label, provider: cfModel.provider, isWildcard: false, color: '#7c7cf8', rgb: '124,124,248' }
        )
        if (caveat) {
          counterfactualCaveat = caveat
          debugBus.emit('pipeline', 'counterfactual_flagged', { promptType, caveatLen: caveat.length }, { severity: 'warn', requestId })
        }
      } catch (e: any) {
        debugBus.emit('pipeline', 'counterfactual_error', { error: e?.message ?? String(e) }, { severity: 'error', requestId })
      }
    })() : Promise.resolve()

    let traceBlock = ''
    const tracePromise = shouldRunTrace(synthesisText, promptType) ? (async () => {
      try {
        const cb = extractFirstCodeBlock(synthesisText)
        if (cb) {
          const verifyRes = await fetch(`http://localhost:${process.env.PORT || 3001}/api/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: cb.code, language: cb.language }),
          })
          if (verifyRes.ok) {
            const vd = await verifyRes.json() as any
            traceBlock = buildTraceBlock({
              stdout: vd.stdout ?? '', stderr: vd.stderr ?? vd.error ?? '',
              exitCode: vd.passed ? 0 : 1, runtimeMs: vd.runtimeMs ?? 0,
              language: cb.language, passed: vd.passed ?? false,
            }, cb.code)
            debugBus.emit('pipeline', 'execution_trace_injected', { language: cb.language, passed: vd.passed }, { severity: 'info', requestId })
          }
        }
      } catch (e: any) {
        debugBus.emit('pipeline', 'execution_trace_error', { error: e?.message ?? String(e) }, { severity: 'error', requestId })
      }
    })() : Promise.resolve()

    let hypothesisAddendum = ''
    const hypPromise = shouldRunHypothesis(promptType, message) ? (async () => {
      try {
        const { executeCode: execForHypothesis } = await import('./src/CrucibleEngine/sandbox')
        const runCode = async (code: string, language: string) => {
          const r = await execForHypothesis(code, language as any, 8000)
          return {
            stdout: r.output ?? '', stderr: r.error ?? '',
            exitCode: r.success ? 0 : 1, runtimeMs: r.executionMs ?? 0,
            language: r.language, passed: r.success,
          }
        }
        const hyp = await runHypothesisTest(message, promptType, runCode, requestId)
        if (hyp) hypothesisAddendum = hyp.synthesisAddendum
      } catch (e: any) {
        debugBus.emit('pipeline', 'hypothesis_wire_error', { error: e?.message ?? String(e) }, { severity: 'error', requestId })
      }
    })() : Promise.resolve()

    // ── Stage 5b-pre — domain verifier (deterministic, fast) ─────────────────
    let verifierIssues: string[] = []
    try {
      const dvResult = await domainVerify(promptType, synthesisText, message)
      if (!dvResult.passed && dvResult.issues.length > 0 && dvResult.confidence > 0.5) {
        verifierIssues = dvResult.issues
        debugBus.emit('pipeline', 'domain_verify_failed', { promptType, issues: dvResult.issues, confidence: dvResult.confidence }, { severity: 'warn', requestId })
        console.log(`[DomainVerify] Issues found:`, dvResult.issues)
      }
    } catch { /* non-blocking */ }

    // Await all three concurrent branches before polish
    await Promise.all([cfPromise, tracePromise, hypPromise])

    // ── Stage 5b — deterministic + model polish (the "gold out" half) ───────
    // Polish runs silently; the final polished text replaces the streamed draft.
    let finalText = normalizeOutput(synthesisText, { stripPreamble: true })
    // Append counterfactual caveat to finalText before polish sees it
    if (counterfactualCaveat) finalText = `${finalText}\n\n---\n${counterfactualCaveat}`
    const directive = extractLengthDirective(message)
    const extraIssues = [
      ...verifierIssues,
      ...(traceBlock ? [traceBlock] : []),
      ...(hypothesisAddendum ? [hypothesisAddendum] : []),
    ]
    try {
      const polished = await withTimeout(
        callModel(activeSynthModel, [
          { role: 'system', content:
            'You are the final polish pass of a multi-model pipeline. ' +
            'You are given a draft answer to a user question. Return the SAME answer, improved. ' +
            'Be RUTHLESSLY concise: default to the shortest response that fully and directly answers — ' +
            'no preamble, no restating the question, no hedging, no filler, no closing pleasantries. ' +
            (directive
              ? `The user EXPLICITLY constrained the format/length: "${directive}". Obey it exactly, even if the draft ignored it. `
              : 'If the question implies a short answer, keep it short. ') +
            (uncertaintyResult.injectionFlag ? uncertaintyResult.injectionFlag + ' ' : '') +
            'Remove redundancy and fix any internal contradiction, but do not add new claims or drop ' +
            'correct substance. Keep code blocks intact. Plain text only — never use emojis. ' +
            'Return ONLY the polished answer, nothing else.' },
          { role: 'user', content: `Question: ${message}\n\nDraft answer:\n${finalText}${extraIssues.length ? `\n\nFLAGGED ISSUES (fix or explicitly caveat these):\n${extraIssues.map(i => `- ${i}`).join('\n')}` : ''}\n\nReturn the polished answer.` },
        ]),
        30000,
        finalText,
      )
      const cleaned = normalizeOutput(polished, { stripPreamble: true })
      const floor = directive ? 0.04 : 0.5
      if (cleaned && cleaned.length > finalText.length * floor) finalText = cleaned
    } catch (e: any) {
      console.error('[Stage 5b] Polish error:', e.message)
    }
    // ── Confidence calibration + fragility analysis (H1, H4) ────────────────
    // Critic (I5) starts concurrently with calibration to eliminate the
    // sequential fragility+critic latency stack (~4s + 6s = 10s → max(4,6) = 6s).
    // Critic result is awaited and sent right after confidence SSE events.
    let criticPromise: Promise<string[]> = Promise.resolve([])
    try {
      const { models: criticModels } = selectModels('reasoning', SIMPLE_PIPELINE_CONFIG, 'simple', 'quorum')
      const criticModel = criticModels[0]
      if (criticModel) {
        const criticPrompt = `You are an adversarial critic. Given a question and a proposed answer, find the three most significant problems: things that are WRONG, INCOMPLETE, or OVERCONFIDENT. Do not find minor stylistic issues.\n\nQuestion: ${message}\n\nProposed answer:\n${finalText.slice(0, 2000)}\n\nIf you find real problems (not minor style issues), list them each on one line prefixed with "PROBLEM:". If you find nothing significant, reply with exactly: NO_ISSUES`
        criticPromise = withTimeout(
          callModel(criticModel, [
            { role: 'system', content: 'You are a ruthless adversarial critic. Find real problems, not style issues. Be concise.' },
            { role: 'user', content: criticPrompt },
          ]),
          6000,
          'NO_ISSUES',
        ).then(raw => raw.split('\n').filter((l: string) => l.startsWith('PROBLEM:')).map((l: string) => l.replace(/^PROBLEM:\s*/, '').trim()).filter(Boolean))
          .catch(() => [])
      }
    } catch { /* non-blocking */ }

    try {
      const modelResponses = Object.values(revised).filter(r => r && !r.startsWith('Error:'))
      const scoreValues = Object.values(scores).filter(s => typeof s === 'number') as number[]
      const ensembleCompositeScore = scoreValues.length
        ? scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length
        : undefined

      // Pick the fastest active model for the fragility probe — smallest/fastest
      // wins here since we want specificity from the prompt, not raw capability.
      const { models: fastModels } = selectModels('general', SIMPLE_PIPELINE_CONFIG, 'simple', 'quorum')
      // S4a — on simple/medium queries the fragility probe doesn't need frontier
      // quality, so run it on the local Apple model (zero external quota) when the
      // bridge is up. Complex queries keep the external fast model.
      const fragilityModel = (localInferenceAvailable && complexity !== 'complex')
        ? LOCAL_MODEL
        : fastModels[0]
      if (fragilityModel?.provider === 'local') {
        debugBus.emit('model', 'local_inference', { task: 'fragility', complexity }, { severity: 'info', requestId })
      }
      const fastModel = fastModels[0]

      // H5 — frontier detection: local regex scan for epistemic hedge signals
      const FRONTIER_PATTERNS = [
        /ongoing\s+research/i, /not\s+yet\s+(?:established|understood|known|settled)/i,
        /debated\s+(?:among|by|within)\s+(?:experts|researchers|scientists)/i,
        /open\s+question/i, /no\s+(?:consensus|definitive\s+answer)/i,
        /(?:remains?|is)\s+unknown/i, /(?:scientists?|researchers?)\s+(?:disagree|debate)/i,
        /frontier\s+of\s+(?:human\s+)?knowledge/i, /active\s+area\s+of\s+(?:research|study)/i,
        /(?:not\s+)?(?:fully\s+)?understood/i,
      ]
      const hasFrontierHedge = (promptType === 'factual' || promptType === 'reasoning') &&
        FRONTIER_PATTERNS.some(p => p.test(finalText))

      const [calibration, fragilityAssumption, frontierQuestion] = await Promise.all([
        Promise.resolve(calibrate(finalText, {
          modelResponses,
          webGroundingContext: groundingBlock || undefined,
          verificationPassed: verifierIssues.length === 0 ? undefined : false,
          domainVerifierIssues: verifierIssues,
          ensembleCompositeScore,
          requestId,
        })),
        fragilityModel
          ? withTimeout(
              getFragilityAssumption(finalText, message, promptType, callModel, fragilityModel, requestId),
              5000,
              null
            )
          : Promise.resolve(null),
        // H5 — only fire model call if local regex found a hedge signal
        (hasFrontierHedge && fastModel)
          ? withTimeout(
              callModel(
                { id: fastModel.id, label: fastModel.label, provider: fastModel.provider, isWildcard: false },
                [
                  { role: 'system', content: 'You identify open research questions. Given a synthesis text, extract ONE specific open question that scientists or experts have not definitively answered. Output ONLY the question (1-2 sentences). If no genuinely open question exists, output NONE.' },
                  { role: 'user', content: `Synthesis:\n${finalText.slice(0, 900)}\n\nOpen question:` },
                ],
                { requestId },
              ),
              5000,
              '',
            ).then(r => (r && r !== 'NONE' && !r.startsWith('NONE') ? r.trim() : null)).catch(() => null)
          : Promise.resolve(null),
      ])

      const flaggedClaims = calibration.claims.filter(c => c.tier === 'LOW' || c.tier === 'UNVERIFIED')
      const { overallTier, overallScore, HIGH, MEDIUM, LOW, UNVERIFIED } = calibration.summary
      sendAndRecord({
        type: 'confidence',
        overallTier,
        overallScore,
        summary: { high: HIGH, medium: MEDIUM, low: LOW, unverified: UNVERIFIED },
        flaggedClaims: flaggedClaims.map(c => ({ claim: c.claim, tier: c.tier })),
        fragilityAssumption: fragilityAssumption ?? undefined,
        frontierQuestion: frontierQuestion ?? undefined,
      })
      // H2 — record calibration score for this query's cluster so future queries route correctly
      recordCalibrationForQuery(process.cwd(), message, overallScore, requestId)

      // Confidence-gated response commitment — when overall calibration is low,
      // surface what would resolve the uncertainty rather than silently delivering
      // a low-confidence answer as if it were settled.
      if (overallScore < 0.55 && (promptType === 'factual' || promptType === 'reasoning' || promptType === 'math')) {
        try {
          const { models: gateModels } = selectModels('general', SIMPLE_PIPELINE_CONFIG, 'simple', 'quorum')
          const gateModel = gateModels[0]
          if (gateModel) {
            const gatePrompt = `Given this question and a low-confidence answer, state in ONE sentence what specific information, source, or verification step would allow a definitive answer. Be concrete — name the specific thing needed, not a generic "more research".\n\nQuestion: ${message}\n\nAnswer (low confidence): ${finalText.slice(0, 600)}\n\nComplete: "A definitive answer requires: ..."`
            const gateRaw = await withTimeout(
              callModel(gateModel, [{ role: 'user', content: gatePrompt }], { requestId }),
              5000, ''
            ).catch(() => '')
            if (gateRaw && gateRaw.trim() && gateRaw.length > 20) {
              const resolvingStep = gateRaw.replace(/^(a definitive answer requires:?\s*)/i, '').trim()
              sendAndRecord({ type: 'uncertain_commitment', overallScore, resolvingStep })
              debugBus.emit('pipeline', 'uncertain_commitment', { overallScore, resolvingStep: resolvingStep.slice(0, 100) }, { severity: 'warn', requestId })
            }
          }
        } catch { /* non-blocking */ }
      }

      // M3 — ambient watchfulness: surface a proactive suggestion if world model has
      // something relevant the user didn't ask about. Non-blocking, rate-limited per session.
      checkAmbientContext(process.cwd(), ambientSessionKey, message, requestId)
        .then(suggestion => { if (suggestion) send(suggestion) })
        .catch(() => {})
    } catch { /* non-blocking — calibration failure never stops delivery */ }

    // ── I5 — Adversarial Critic pass (always-on) ──────────────────────────────
    // Started concurrently with calibration above. Await result here.
    // INVARIANT: never modifies finalText, never emits replace:true.
    try {
      const problems = await criticPromise
      if (problems.length > 0) {
        debugBus.emit('pipeline', 'critic_findings', { count: problems.length, problems: problems.slice(0, 3) }, { severity: 'warn', requestId })
        sendAndRecord({ type: 'critic', problems: problems.slice(0, 3) })
      } else {
        debugBus.emit('pipeline', 'critic_clean', { requestId }, { severity: 'success', requestId })
      }
    } catch { /* non-blocking */ }

    // M2 — apply voice layer so pipeline answer feels like same voice as conversational replies
    finalText = applyVoiceLayer(finalText)

    // N3 — ingest final answer into domain store for future retrieval
    try {
      ingestIntoDomainStore(process.cwd(), domainCtx.domain, finalText, message.slice(0, 60))
    } catch { /* non-blocking */ }

    // Final event replaces the streamed draft with the polished text
    pipelineSynthesisText = finalText
    sendAndRecord({ type: 'synthesis', modelId: activeSynthModel.id, model: activeSynthModel.label, text: finalText, done: true, replace: true })
  } catch (e: any) {
    console.error('[Stage 5] Synthesis error:', e.message)
    const fallback = applyVoiceLayer(normalizeOutput(revised[activeSynthModel.id] || Object.values(revised).find(r => r) || '', { stripPreamble: true }))
    pipelineSynthesisText = fallback
    sendAndRecord({ type: 'synthesis', modelId: activeSynthModel.id, model: activeSynthModel.label, text: fallback, done: true, replace: true })
  }

  sendAndRecord({ type: 'stage', stage: 5, status: 'done' })
  recordPipelineRun()
  console.log('[Stage 5] Pipeline complete')

  // ── Close SSE now if MASTERPIECE deep won't fire — post-pipeline ops run async ──
  // All remaining work (genealogy, world diff, history, cache) is state recording
  // for future rounds. It doesn't affect the current answer. Closing early cuts
  // ~8s of post-synthesis latency from the client's perspective.
  if (mpGate.mode !== 'deep') {
    res.write('data: [DONE]\n\n')
    res.end()
  }

  // ── Track P — MASTERPIECE deep mode ───────────────────────────────────────
  // Light mode already ran (in parallel with Stage 1) and enriched the synthesis
  // above. Deep mode runs ONLY when the gate selected 'deep' (prompt complexity:
  // ≥150 tokens AND ≥2 subtasks AND non-factual) — no ensemble-confidence
  // condition. It consumes the light EnrichedContext so corpus queries are not
  // repeated, then replaces the synthesis with the full dialectical result.
  // SSE events are FLATTENED at the emit boundary ({type, ...data}) so the App's
  // flat-field readers (parsed.shardCount, not parsed.data.shardCount) populate.
  // The gate decision is authoritative: deep runs whenever mode==='deep'. Light is
  // an optimization, not a prerequisite — if it failed (lightCtx null), deep still
  // runs with a minimal fallback EnrichedContext (empty connections, fresh anchor).
  if (mpGate.mode === 'deep') {
    const deepCtx: EnrichedContext = lightCtx ?? {
      anchorId: `anchor-${requestId}`,
      promptDomain: 'general',
      connections: [],
      structuralPatterns: [],
      topNovelty: 0,
      elapsedMs: 0,
      partial: true,
    }
    console.log(`[MASTERPIECE:deep] activating — token estimate ${mpGate.tokenEstimate}, subtasks ${mpGate.detectedSubtasks}, type ${mpGate.promptType}${lightCtx ? '' : ' (light unavailable — fallback context)'}`)
    sendAndRecord({ type: 'masterpiece_gate', gate: { ...mpGate, shouldActivate: true } })
    try {
      const mpResult = await runMasterpieceDeep(
        message,
        pipelineSynthesisText,
        deepCtx,
        mpDeps,
        (event) => sendAndRecord({ type: event.type, ...event.data }),
      )
      pipelineSynthesisText = mpResult.synthesis
      sendAndRecord({
        type: 'synthesis',
        modelId: 'masterpiece',
        model: 'MASTERPIECE',
        text: mpResult.synthesis,
        done: true,
        replace: true,
      })
      console.log('[MASTERPIECE:deep] complete — synthesis replaced')
    } catch (e: any) {
      console.error('[MASTERPIECE:deep] error (non-blocking):', e?.message)
    }
  }

  // ── Track U — ANIMA learning (background, non-blocking) ───────────────────
  // The response is finalised; now ANIMA studies the interaction for universal
  // observations. observe → verify (5 gates) → store. This must NEVER block the
  // user-facing response, so it is fire-and-forget with its own guards.
  if (animaShaping) {
    void runAnimaLearning(history, message, pipelineSynthesisText, animaShaping.valence, mpDeps)
      .then(outcomes => {
        const stored = outcomes.filter(o => o.result === 'stored').length
        const confirmed = outcomes.filter(o => o.result === 'confirmed-existing').length
        if (stored || confirmed) console.log(`[ANIMA] learning — ${stored} new truth(s), ${confirmed} confirmed`)
      })
      .catch(e => console.error('[ANIMA] learning error (non-blocking):', e?.message))
  }

  // ── Response Genealogy — attribute synthesis sentences to source models ──
  // Splits the synthesis into sentences and finds the best-matching model
  // response for each using token-cosine (reuses the vectorize/cosineSim fns
  // already built for the semantic cache). Contribution rates feed back into
  // specialization: synthesis survivors get an extra positive signal.
  const attribution: Record<number, string> = {}
  const contributionRates: Record<string, number> = {}
  try {
    const sentences = pipelineSynthesisText
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 20)

    const modelIds = models.filter(m => revised[m.id]).map(m => m.id)
    const modelVecs = Object.fromEntries(
      modelIds.map(id => [id, vectorize(revised[id] ?? '')])
    )

    for (let i = 0; i < sentences.length; i++) {
      const sv = vectorize(sentences[i])
      let bestId = modelIds[0]
      let bestSim = -1
      for (const id of modelIds) {
        const sim = cosineSim(sv, modelVecs[id])
        if (sim > bestSim) { bestSim = sim; bestId = id }
      }
      attribution[i] = bestId
    }

    for (const id of modelIds) contributionRates[id] = 0
    for (const id of Object.values(attribution)) contributionRates[id] = (contributionRates[id] ?? 0) + 1
    const total = sentences.length || 1
    for (const id of modelIds) {
      contributionRates[id] = parseFloat((contributionRates[id] / total).toFixed(3))
      // Synthesis survival is a stronger quality signal than Stage 1 score alone
      if (contributionRates[id] > 0) {
        recordSpecialization(id, promptType, 0.5 + contributionRates[id] * 0.5)
      }
    }

    debugBus.emit('pipeline', 'genealogy_computed', { sentences: sentences.length, contributionRates }, { severity: 'info', requestId })
    sendAndRecord({ type: 'genealogy', contributionRates })

    // Distill structural differences between high/low scoring responses (Track C3)
    try {
      const scoredResponses = models.map(m => ({ modelId: m.id, text: responses[m.id] ?? '', score: scores[m.id] ?? 0 })).filter(r => r.text)
      distillRound(process.cwd(), message, promptType, scoredResponses)
    } catch (e: any) {
      debugBus.emit('pipeline', 'distill_round_error', { error: e?.message ?? String(e) }, { severity: 'error', requestId })
    }
  } catch (e: any) {
    console.error('[Genealogy] Attribution error:', e.message)
  }

  // ── Record quality observation + trigger autonomous improvement ─────────────
  try {
    const finalComposite = Object.values(scores).length
      ? Object.values(scores).reduce((a, b) => a + b, 0) / Object.values(scores).length
      : 0.5
    qualityPredictor.record(message, finalComposite, promptType)
    // /api/diag — last-request summary + session quality samples
    diag.qualityScores.push(finalComposite)
    if (diag.qualityScores.length > 500) diag.qualityScores.splice(0, diag.qualityScores.length - 500)
    diag.lastRequest = { prompt: message.slice(0, 200), mode, durationMs: Date.now() - diagReqStart, finalScore: +finalComposite.toFixed(3) }
    // Session quality arc — detect context degradation (Track G3)
    try { recordArcScore(process.cwd(), requestId.slice(0, 20), finalComposite) } catch (e: any) {
      debugBus.emit('pipeline', 'arc_score_error', { error: e?.message ?? String(e) }, { severity: 'error', requestId })
    }
    // Rollback autonomous changes if quality has been trending down
    const qStats = qualityPredictor.stats()
    rollbackIfDegraded(qStats.trend)
    // Fire the background improvement pass (debounced 5s, non-blocking)
    triggerImprovementPass()
    // Reload scoring weights in case autoImprove updated them
    refreshScoringConfig()
    // Record A/B observation for any running experiments
    try {
      const compositeScore = qStats.recentAvg ?? 0
      for (const exp of getActiveExperiments(process.cwd())) {
        const cohort = assignCohort(exp, requestId)
        recordObservation(process.cwd(), exp.id, cohort, compositeScore)
      }
      runAutoDecisions(process.cwd())
    } catch (e: any) {
      debugBus.emit('pipeline', 'ab_record_error', { error: e?.message ?? String(e) }, { severity: 'error', requestId })
    }

    // ── Roster rotation (Track C1) ─────────────────────────────────────────
    try {
      const allLabels = Object.fromEntries(models.map(m => [m.id, m.label]))
      recordRoundContributions(process.cwd(), contributionRates, models.map(m => m.id), allLabels)
      const histSize = (() => { try { const hf = chatUser ? path.join(process.cwd(), '.crucible', `history-${chatUser.id}.json`) : path.join(process.cwd(), '.crucible', 'history-default.json'); return JSON.parse(fs.readFileSync(hf, 'utf8')).length } catch { return 0 } })()
      evaluateRoster(process.cwd(), histSize, (id, label, avg) => {
        debugBus.emit('model', 'model_benched', { modelId: id, label, avgContribution: avg }, { severity: 'warn', requestId })
      })
    } catch (e: any) {
      debugBus.emit('pipeline', 'roster_eval_error', { error: e?.message ?? String(e) }, { severity: 'error', requestId })
    }

    // ── J3 — World model diff from synthesis text ──────────────────────────
    try { applyWorldDiff(process.cwd(), pipelineSynthesisText, 'pipeline', requestId) }
    catch (e: any) {
      debugBus.emit('pipeline', 'world_diff_error', { error: e?.message ?? String(e) }, { severity: 'error', requestId })
    }

    // ── J4 — Knowledge gap detection ──────────────────────────────────────
    try {
      const scoreVals = Object.values(scores).filter(s => typeof s === 'number') as number[]
      const variance = scoreVals.length >= 2
        ? Math.max(...scoreVals) - Math.min(...scoreVals) : 0
      const qualPred = qualityPredictor.predict(message)
      detectGapsFromRound(process.cwd(), message, finalComposite, variance, qualPred.predictedScore, finalComposite)
    } catch (e: any) {
      debugBus.emit('pipeline', 'gap_detection_error', { error: e?.message ?? String(e) }, { severity: 'error', requestId })
    }

    // ── Track B3 — Stage weight learner: record per-stage quality so future rounds
    // can dynamically reweight which stages are worth running for this prompt type.
    try {
      const stage1Baseline = finalComposite  // scores[] is Stage 2 output = Stage 1 quality
      recordStageWeightRound(process.cwd(), promptType as any, {
        stage5_synthesis: pipelineSynthesisText.length > 100 ? Math.min(1, finalComposite + 0.05) : finalComposite,
      }, stage1Baseline)
      debugBus.emit('pipeline', 'stage_weights_recorded', { promptType, stage1Baseline }, { severity: 'info', requestId })
    } catch (e: any) {
      debugBus.emit('pipeline', 'stage_weights_error', { error: e?.message ?? String(e) }, { severity: 'error', requestId })
    }

    // ── Track J — Causal learning: record this round (query → answer) so future
    // queries can reason from it as causal precedent. Confidence tracks the round's
    // composite quality so weak rounds carry weak causal weight.
    try {
      enrichAndRecord(
        message.slice(0, 200),
        pipelineSynthesisText.slice(0, 200),
        requestId.slice(0, 20),
        Math.max(0.3, Math.min(0.9, finalComposite)),
        [promptType],
      )
    } catch (e: any) {
      debugBus.emit('pipeline', 'causal_record_error', { error: e?.message ?? String(e) }, { severity: 'error', requestId })
    }

    // ── Cross-session contradiction: store this session's conclusions so future
    // sessions can detect when they contradict what was concluded here.
    try {
      recordSessionConclusions(requestId.slice(0, 20), pipelineSynthesisText, promptType, process.cwd())
    } catch (e: any) {
      debugBus.emit('pipeline', 'contradiction_record_error', { error: e?.message ?? String(e) }, { severity: 'error', requestId })
    }

    // ── J5 — Cross-session knowledge synthesis: count this session against its
    // topic cluster; every SESSION_THRESHOLD (20) sessions, regenerate the
    // cluster's state-of-knowledge document from recent history. The doc is read
    // back at prompt-assembly time (readSynthesis, injected near the uncertainty
    // flag) so durable cross-session conclusions reach future matching queries.
    try {
      const cId = uncertaintyResult.clusterId
      const cLabel = uncertaintyResult.clusterLabel
      if (cId && cLabel) {
        const due = recordSessionForCluster(process.cwd(), cId, cLabel)
        if (due) {
          let corpus = ''
          try {
            const hf = chatUser
              ? path.join(process.cwd(), '.crucible', `history-${chatUser.id}.json`)
              : path.join(process.cwd(), '.crucible', 'history-default.json')
            const hist: any[] = JSON.parse(fs.readFileSync(hf, 'utf8'))
            corpus = hist.slice(-40)
              .map(h => `Q: ${h.query}\nA: ${String(h.synthesis ?? '').slice(0, 600)}`)
              .join('\n\n---\n\n')
          } catch {}
          const { models: synthModels } = selectModels('general', SIMPLE_PIPELINE_CONFIG, 'simple', 'quorum')
          const synthModel = synthModels[0]
          if (synthModel && corpus) {
            const synthPrompt = `You are writing a concise "state of knowledge" document for the topic cluster "${cLabel}". Below are recent Q&A sessions in this cluster. Synthesize the durable, cross-session conclusions: what is now well-established, what remains open or contested, and the key caveats. Output markdown, 200-500 words.\n\n${corpus.slice(0, 8000)}`
            const content = await withTimeout(
              callModel(synthModel, [{ role: 'user', content: synthPrompt }], { requestId, timeoutMs: 15000 }),
              15000, ''
            ).catch(() => '')
            if (content && content.trim().length > 80) {
              writeSynthesis(process.cwd(), cId, cLabel, content.trim())
            }
          }
        }
      }
    } catch (e: any) {
      debugBus.emit('pipeline', 'knowledge_synthesis_error', { error: e?.message ?? String(e) }, { severity: 'error', requestId })
    }
  } catch (e: any) {
    debugBus.emit('pipeline', 'post_synthesis_block_error', { error: e?.message ?? String(e) }, { severity: 'error', requestId })
  }

  // ── Persist the finished answer back into the active session ───────────────
  // Survives client disconnect: if the user left mid-pipeline, restore now returns the
  // completed synthesis instead of a dead, unanswered query.
  patchActiveSessionRound(chatUser, chatRoundId, { synthesis: pipelineSynthesisText, synthesisDone: true, synthStreaming: false })

  // ── Persist to session history ───────────────────────────────────────────
  try {
    const topScore = Math.max(...models.map(m => scores[m.id] ?? 0), 0)
    historyPush(chatUser?.id ?? null, {
      ts: Date.now(),
      query: message,
      promptType,
      models: models.map(m => m.label),
      synthesis: pipelineSynthesisText,
      topScore: parseFloat(topScore.toFixed(3)),
      attribution,
      contributionRates,
      hardeningCohort,
    })
  } catch (e: any) {
    console.error('[History] Failed to persist:', e.message)
  }

  // ── Write to cache ───────────────────────────────────────────────────────
  pruneCache()
  responseCache.set(ck, { events: cacheEvents, timestamp: Date.now(), message, vec: vectorize(message) })
  console.log(`[Cache] STORED — cache size: ${responseCache.size}`)

  if (!res.writableEnded) {
    res.write('data: [DONE]\n\n')
    res.end()
  }
  } catch (pipelineErr: any) {
    // Pipeline threw before completing — make sure the client doesn't hang.
    console.error('[Pipeline] Fatal error:', pipelineErr?.message ?? pipelineErr)
    if (!res.writableEnded) {
      try {
        send({ type: 'error', message: 'The pipeline hit an unexpected error and could not complete.' })
        res.write('data: [DONE]\n\n')
        res.end()
      } catch { /* socket already gone */ }
    }
  } finally {
    // Balance the keepalive pause guard for every exit path (early return, completion, throw).
    activePipelineRequests = Math.max(0, activePipelineRequests - 1)
  }
})

// ── /api/verify — Code execution and self-healing ────────────────────────
// Three rounds:
//   1. Execute as-is
//   2. Algorithmic fix (up to 2 iterations) — zero API calls
//   3. Surgical single-model fix — ONE fast model call, stream result, re-verify
// The client no longer needs to handle verify_needs_model; the loop closes here.
app.post('/api/verify', async (req, res) => {
  const { code, language, originalPrompt = '' } = req.body
  if (!code) { res.status(400).json({ error: 'No code provided' }); return }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  const rid = `v-${Date.now()}`
  const send = (payload: object) => res.write(`data: ${JSON.stringify(payload)}\n\n`)

  const { executeCode, verifyCode } = await import('./src/CrucibleEngine/sandbox')
  const { parseError, attemptAlgorithmicFix, buildSurgicalPrompt } = await import('./src/CrucibleEngine/error-intelligence')
  const { detectLanguage } = await import('./src/CrucibleEngine/sandbox')

  const lang = language ?? detectLanguage(code)
  send({ type: 'verify_start', language: lang })
  debugBus.emit('verify', 'verify_start', { language: lang, codeLen: code.length }, { requestId: rid })

  const emitExec = (result: Awaited<ReturnType<typeof executeCode>>, currentCode: string) => {
    debugBus.emit('execution', 'execution_result', {
      language: lang, success: result.success,
      error: result.error, errorType: result.errorType,
      errorLine: result.errorLine, executionMs: result.executionMs,
    }, { severity: result.success ? 'success' : 'error', requestId: rid })
    if (!result.success && result.errorType) {
      const parsed = parseError(result, currentCode)
      debugBus.emit('verify', 'error_detected', {
        language: lang, errorType: result.errorType,
        errorLine: result.errorLine, symbol: parsed.symbol,
        fixStrategy: parsed.fixStrategy,
      }, { severity: 'warn', requestId: rid })
    }
  }

  try {
    send({ type: 'verify_status', message: 'Running...' })
    // Graded verification: full execution when possible; on a pure module-resolution
    // failure (external deps unavailable in the network-denied sandbox), this falls back
    // to REAL static verification (syntax + types) instead of skipping or false-failing.
    const result = await verifyCode(code, lang, 5000)
    emitExec(result, code)

    if (result.success) {
      if (result.staticOnly) {
        // Verified at the deepest level the offline sandbox allows. Honest, not a skip.
        debugBus.emit('verify', 'verify_result', { passed: true, mode: 'static' }, { severity: 'success', requestId: rid })
        send({ type: 'verify_static', message: 'Syntax & types verified (runtime needs external deps)' })
        res.write('data: [DONE]\n\n'); res.end(); return
      }
      debugBus.emit('verify', 'verify_result', { passed: true }, { severity: 'success', requestId: rid })
      send({ type: 'verify_clean' })
      res.write('data: [DONE]\n\n'); res.end(); return
    }

    // ── Round 2: algorithmic fix (up to 2 passes) ───────────────────────
    let workingCode = code
    let patchCount = 0
    for (let pass = 0; pass < 2; pass++) {
      const parsed = parseError({ ...result, error: result.error ?? '', errorType: result.errorType ?? 'UNKNOWN' } as any, workingCode)
      if (!parsed.fixable) break
      const fix = attemptAlgorithmicFix(workingCode, parsed, lang)
      if (!fix.fixed) break

      send({ type: 'verify_status', message: `Applying fix: ${fix.description}` })
      debugBus.emit('verify', 'fix_applied', {
        language: lang, errorType: parsed.type, strategy: fix.strategy,
        pass, succeeded: false,
      }, { requestId: rid })

      const recheck = await executeCode(fix.code, lang, 5000)
      emitExec(recheck, fix.code)

      debugBus.emit('verify', 'fix_applied', {
        language: lang, errorType: parsed.type, strategy: fix.strategy,
        pass, succeeded: recheck.success,
      }, { severity: recheck.success ? 'success' : 'warn', requestId: rid })

      if (recheck.success) {
        patchCount++
        debugBus.emit('verify', 'verify_result', { passed: true, patchCount }, { severity: 'success', requestId: rid })
        send({ type: 'verify_fixed', code: fix.code, patchCount, strategy: fix.strategy })
        res.write('data: [DONE]\n\n'); res.end(); return
      }
      workingCode = fix.code
    }

    // ── Round 3: surgical single-model fix ──────────────────────────────
    send({ type: 'verify_status', message: 'Applying surgical model fix...' })
    debugBus.emit('verify', 'model_fix', { phase: 'start' }, { requestId: rid })

    const finalParsed = parseError({ ...result, error: result.error ?? '', errorType: result.errorType ?? 'UNKNOWN' } as any, workingCode)
    const surgicalPrompt = buildSurgicalPrompt(originalPrompt, workingCode, finalParsed, lang)

    // Pick one fast free model — no ensemble overhead
    const surgicalModels: SelectedModel[] = [
      { id: 'groq/llama-3.3-70b-versatile', provider: 'groq', label: 'Llama 3.3 70B', isWildcard: false },
      { id: 'mistral/mistral-small-latest', provider: 'mistral', label: 'Mistral Small', isWildcard: false },
      { id: 'openrouter/mistralai/mistral-7b-instruct:free', provider: 'openrouter', label: 'Mistral 7B', isWildcard: false },
    ]

    let fixedCode: string | null = null
    const codeBlockRe = /```(?:\w+)?\n([\s\S]*?)```/

    for (const model of surgicalModels) {
      try {
        const modelResult = await callModel(model as any, [
          { role: 'system', content: 'You are a surgical code fixer. Return ONLY the corrected code inside a single code block. No explanation.' },
          { role: 'user', content: surgicalPrompt },
        ], { requestId: rid })

        const match = modelResult.match(codeBlockRe)
        const candidate = (match ? match[1] : modelResult).trim()
        // Reject non-code replies: a fixer that returns an explanation, a refusal, or
        // "// No change needed…" must NEVER be treated as fixed code — splicing that in
        // destroys the answer. Require real (non-comment) code lines.
        const hasRealCode = candidate.split('\n').some(l => {
          const t = l.trim()
          return t && !t.startsWith('//') && !t.startsWith('#') && !t.startsWith('*') && !t.startsWith('/*')
        })
        if (match && hasRealCode && candidate.length > 10) { fixedCode = candidate; break }
        fixedCode = null
      } catch {
        fixedCode = null
      }
    }

    if (fixedCode) {
      send({ type: 'verify_status', message: 'Re-verifying model fix...' })
      const modelCheck = await executeCode(fixedCode, lang, 5000)
      emitExec(modelCheck, fixedCode)

      if (modelCheck.success) {
        debugBus.emit('verify', 'model_fix', { phase: 'success' }, { severity: 'success', requestId: rid })
        debugBus.emit('verify', 'verify_result', { passed: true, patchCount: 1, source: 'model' }, { severity: 'success', requestId: rid })
        send({ type: 'verify_fixed', code: fixedCode, patchCount: 1, strategy: 'model' })
        res.write('data: [DONE]\n\n'); res.end(); return
      }
    }

    // ── Round 4: full analysis pipeline — multi-model tournament ───────────
    const { runAnalysisPipeline } = await import('./src/CrucibleEngine/debug/pipeline')
    const { executeCode: execCode } = await import('./src/CrucibleEngine/sandbox')

    const pipelineFixed = await runAnalysisPipeline(
      {
        code: workingCode,
        language: lang,
        errorMessage: result.error ?? 'Unknown error',
        errorType: result.errorType,
        errorLine: result.errorLine,
        originalPrompt,
        requestId: rid,
      },
      (model, messages) => callModel(model as any, messages, { requestId: rid }),
      (code, language, timeoutMs) => execCode(code, language, timeoutMs),
      (event) => send(event),
    )

    if (pipelineFixed) {
      // analysis_fixed already sent by the pipeline with the code
      debugBus.emit('verify', 'verify_result', { passed: true, source: 'pipeline' }, { severity: 'success', requestId: rid })
      res.write('data: [DONE]\n\n'); res.end(); return
    }

    // All rounds exhausted
    debugBus.emit('verify', 'verify_result', { passed: false }, { severity: 'error', requestId: rid })
    send({ type: 'verify_failed', error: result.error ?? 'Could not fix automatically' })
    send({ type: 'verify_needs_model', error: finalParsed, surgicalPrompt })

  } catch (e: any) {
    console.error('[Verify] Error:', e.message)
    debugBus.emit('verify', 'verify_result', { passed: false, error: e.message }, { severity: 'error', requestId: rid })
    send({ type: 'verify_failed', error: e.message })
  }

  res.write('data: [DONE]\n\n')
  res.end()
})

// (Removed dead /api/terminal endpoint: it ran arbitrary unsandboxed `exec` against a
// hardcoded, non-existent cwd and had no caller. Sandboxed execution lives at
// /api/sandbox/run, which uses sandbox-exec with network-deny.)

// ── File Tools (Agentic) ─────────────────────────────────────────────────────
app.post('/api/file/read', (req, res) => {
  const { filePath } = req.body
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(400).json({ error: 'File not found' })
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    res.json({ success: true, content, filePath })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/file/write', (req, res) => {
  const { filePath, content, projectPath, message } = req.body
  if (!filePath || content === undefined) {
    return res.status(400).json({ error: 'filePath and content required' })
  }
  try {
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    if (projectPath) createCheckpoint(projectPath, message || 'before edit')
    fs.writeFileSync(filePath, content, 'utf-8')
    console.log(`[FileWrite] ${filePath}`)
    // Keep codebase index fresh after every write
    if (projectPath) {
      try { reindexFiles(path.resolve(projectPath), [path.resolve(filePath)]) } catch {}
    }
    res.json({ success: true, filePath })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/file/list', (req, res) => {
  const { dirPath } = req.body
  if (!dirPath || !fs.existsSync(dirPath)) {
    return res.status(400).json({ error: 'Directory not found' })
  }
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    res.json({
      success: true,
      entries: entries.map(e => ({ name: e.name, isDir: e.isDirectory() }))
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ── Sandbox API (Code tab) ────────────────────────────────────────────────────
// A dedicated scratch dir under .crucible/sandbox/ where the Code-tab editor and the
// agent operate with no risk to the user's real tree. All paths are gated to this root;
// `run` is executed under macOS sandbox-exec with network DENIED (lightweight isolation,
// no containers — matches the project's no-heavy-framework invariant).
const SANDBOX_ROOT = path.join(process.cwd(), '.crucible', 'sandbox')
const SANDBOX_SKIP = new Set(['node_modules', '.git', '.DS_Store', 'dist', '.crucible'])

function ensureSandbox() {
  if (!fs.existsSync(SANDBOX_ROOT)) fs.mkdirSync(SANDBOX_ROOT, { recursive: true })
}
// Resolve a relative path against the sandbox root, refusing any escape (../, abs paths).
// Bounded walk of a project's TypeScript/JavaScript sources (project-relative paths), for
// whole-tree signature propagation. Skips deps/build dirs and caps total files so a huge repo
// can't stall the VGR write path.
function collectProjectTsFiles(root: string, cap = 400): string[] {
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.crucible', 'out', 'coverage', '.next'])
  const out: string[] = []
  const walk = (dir: string, rel: string) => {
    if (out.length >= cap) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (out.length >= cap) return
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(dir, e.name), childRel)
      else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(e.name)) out.push(childRel)
    }
  }
  walk(root, '')
  return out
}

function sandboxResolve(relPath: string): string | null {
  const clean = (relPath || '').replace(/^\/+/, '')
  const abs = path.resolve(SANDBOX_ROOT, clean)
  if (abs !== SANDBOX_ROOT && !abs.startsWith(SANDBOX_ROOT + path.sep)) return null
  return abs
}
function sandboxTree(dir: string, rel = ''): any[] {
  const out: any[] = []
  let entries: fs.Dirent[] = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
    if (SANDBOX_SKIP.has(e.name)) continue
    const childRel = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push({ name: e.name, path: childRel, isDir: true, children: sandboxTree(path.join(dir, e.name), childRel) })
    else out.push({ name: e.name, path: childRel, isDir: false })
  }
  return out
}

app.get('/api/sandbox/tree', (_req, res) => {
  ensureSandbox()
  res.json({ success: true, root: SANDBOX_ROOT, tree: sandboxTree(SANDBOX_ROOT) })
})

app.post('/api/sandbox/read', (req, res) => {
  const abs = sandboxResolve(req.body?.path)
  if (!abs) return res.status(400).json({ error: 'path outside sandbox' })
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return res.status(404).json({ error: 'not a file' })
  try { res.json({ success: true, content: fs.readFileSync(abs, 'utf-8') }) }
  catch (e: any) { res.status(500).json({ error: e.message }) }
})

app.post('/api/sandbox/write', (req, res) => {
  const abs = sandboxResolve(req.body?.path)
  if (!abs) return res.status(400).json({ error: 'path outside sandbox' })
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, req.body?.content ?? '', 'utf-8')
    res.json({ success: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// Upload a file INTO the sandbox from the composer's attach button. Accepts a base64
// data URL (or raw base64) so it rides the same JSON transport as the rest of the sandbox
// API — but with its own 25 MB body limit (the global express.json() cap is 100 KB, far too
// small for a real attachment). Binary-safe: content is written from a Buffer, not a string.
// Names are sanitised and resolved through sandboxResolve, so an upload can never escape the
// sandbox root. Collisions get a numeric suffix rather than clobbering an existing file.
// 40mb body: a 25 MB file inflates ~1.37x as base64, so the old 25mb limit 413'd large images.
app.post('/api/sandbox/upload', express.json({ limit: '40mb' }), (req, res) => {
  ensureSandbox()
  const rawName = String(req.body?.name || '').trim()
  const b64 = String(req.body?.data || '')
  if (!rawName) return res.status(400).json({ error: 'missing file name' })
  if (!b64) return res.status(400).json({ error: 'missing file data' })
  // Keep only the base filename, strip anything path-like, allow a safe charset.
  const safeName = path.basename(rawName).replace(/[^\w.\-() ]+/g, '_').slice(0, 120) || 'upload'
  // Accept a data URL ("data:<mime>;base64,AAAA…") or bare base64.
  const comma = b64.indexOf(',')
  const payload = b64.startsWith('data:') && comma !== -1 ? b64.slice(comma + 1) : b64
  let buf: Buffer
  try { buf = Buffer.from(payload, 'base64') } catch { return res.status(400).json({ error: 'invalid base64' }) }
  if (!buf.length) return res.status(400).json({ error: 'empty file' })
  // Resolve inside the sandbox; on name collision append -1, -2, … so nothing is overwritten.
  let rel = safeName
  let abs = sandboxResolve(rel)
  if (!abs) return res.status(400).json({ error: 'path outside sandbox' })
  const ext = path.extname(safeName)
  const stem = safeName.slice(0, safeName.length - ext.length)
  for (let n = 1; fs.existsSync(abs) && n < 1000; n++) {
    rel = `${stem}-${n}${ext}`
    abs = sandboxResolve(rel)!
  }
  try {
    fs.writeFileSync(abs, buf)
    res.json({ success: true, path: rel, bytes: buf.length })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

app.post('/api/sandbox/delete', (req, res) => {
  const abs = sandboxResolve(req.body?.path)
  if (!abs || abs === SANDBOX_ROOT) return res.status(400).json({ error: 'path outside sandbox' })
  try { fs.rmSync(abs, { recursive: true, force: true }); res.json({ success: true }) }
  catch (e: any) { res.status(500).json({ error: e.message }) }
})

// Run a command in the sandbox with network denied. Streams nothing yet — returns on exit.
app.post('/api/sandbox/run', (req, res) => {
  ensureSandbox()
  const command = String(req.body?.command || '')
  if (!command.trim()) return res.status(400).json({ error: 'command required' })
  // macOS sandbox-exec profile: allow everything except outbound/inbound network.
  const profile = '(version 1)(allow default)(deny network*)'
  const started = Date.now()
  execFile('sandbox-exec', ['-p', profile, '/bin/sh', '-c', command], {
    cwd: SANDBOX_ROOT, timeout: 20000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, PATH: process.env.PATH || '' },
  }, (error, stdout, stderr) => {
    res.json({
      success: !error,
      output: (stdout || '') + (stderr ? `\n${stderr}` : ''),
      code: (error as any)?.code ?? 0,
      timedOut: (error as any)?.killed ?? false,
      ms: Date.now() - started,
    })
  })
})

// Run ONE code snippet from a chat code block — the "Run" button in CollapsibleCode.
// Uses the same network-denied sandbox machinery as verification (executeCode):
// js/ts/python/bash run for real; compiled languages get a real syntax/compile check.
app.post('/api/sandbox/exec-snippet', async (req, res) => {
  const code = String(req.body?.code ?? '')
  const language = req.body?.language ? String(req.body.language) : undefined
  if (!code.trim()) return res.status(400).json({ error: 'code required' })
  try {
    const { executeCode, detectLanguage } = await import('./src/CrucibleEngine/sandbox')
    const lang = (language && language !== 'auto' ? language : detectLanguage(code)) as any
    const result = await executeCode(code.slice(0, 200_000), lang, 15_000)
    // The on-device sandbox is intentionally stdlib-only (network-denied, no pip). A
    // third-party import (pygame et al.) fails with a bare ModuleNotFoundError that
    // reads like a Crucible bug. Translate it into what the user can actually do.
    let friendlyError = result.error
    // Python worker surfaces just the message ("No module named 'pygame'"), not the
    // exception class — match both shapes.
    const missingMod = /No module named ['"]([^'"]+)['"]/.exec(result.error ?? '')
    if (missingMod) {
      friendlyError = `This code needs the third-party package "${missingMod[1]}", which isn't available in Crucible's on-device sandbox (it runs standard-library code only, with no network or pip). Ask Crucible for a version that runs here — e.g. "rewrite this as a single-file HTML/canvas version" for games, which is playable via the Preview button.`
    }
    res.json({
      success: result.success,
      output: result.output || '',
      error: friendlyError,
      language: result.language,
      staticOnly: result.staticOnly ?? false,
      ms: result.executionMs,
    })
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'execution failed' })
  }
})

// Quick, prompt-specific build-step labels to narrate the Code Studio progress bar.
// One fast driver call; degrades to generic phases if it fails.
app.post('/api/studio/plan', async (req, res) => {
  const desc = String(req.body?.desc || '').slice(0, 300)
  const fallback = ['understanding your idea', 'sketching the structure', 'bringing it to life', 'polishing the details']
  try {
    const raw = await driverComplete([
      { role: 'system', content: 'You narrate a build. Given what the user wants to make, output ONLY a JSON array of 4-5 short present-continuous phrases (2-4 words each, lowercase, no period) describing the build steps in order, specific to their idea. Example for "a bouncing ball": ["drawing the ball","setting up physics","adding the bounce","polishing the motion"]. JSON array only.' },
      { role: 'user', content: desc },
    ])
    const arr = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] ?? '[]')
    const steps = Array.isArray(arr) ? arr.filter((s: any) => typeof s === 'string').slice(0, 5) : []
    res.json({ steps: steps.length ? steps : fallback })
  } catch {
    res.json({ steps: fallback })
  }
})

// ── Checkpoint API ────────────────────────────────────────────────────────────
app.post('/api/checkpoint', (req, res) => {
  const { projectPath, message } = req.body
  if (!projectPath) return res.status(400).json({ error: 'projectPath required' })
  const checkpoint = createCheckpoint(projectPath, message || 'manual checkpoint')
  res.json({ success: !!checkpoint, checkpoint })
})

app.post('/api/checkpoint/rollback', (req, res) => {
  const { hash, projectPath } = req.body
  if (!hash || !projectPath) return res.status(400).json({ error: 'hash and projectPath required' })
  const success = rollbackToCheckpoint(hash, projectPath)
  res.json({ success })
})

app.get('/api/checkpoints', (req, res) => {
  const projectPath = req.query.projectPath as string | undefined
  res.json({ checkpoints: getCheckpoints(projectPath) })
})

// ── Codebase Indexer ─────────────────────────────────────────────────────────
app.post('/api/index', async (req, res) => {
  const { rootPath } = req.body
  if (!rootPath || !fs.existsSync(rootPath)) {
    return res.status(400).json({ error: 'Invalid path' })
  }
  try {
    const index = buildIndex(rootPath)
    res.json({ success: true, fileCount: index.files.length, rootPath })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/index/stats', (req, res) => {
  const stats = getIndexStats()
  if (!stats) return res.json({ indexed: false })
  res.json({ indexed: true, ...stats })
})

// ── Track C — Living Corpus status ────────────────────────────────────────────
app.get('/api/corpus/status', (_req, res) => {
  try {
    res.json(corpusStatus())
  } catch (e: any) {
    res.status(500).json({ error: e?.message })
  }
})

// Manually trigger a deliberate-curation acquisition cycle (background).
app.post('/api/corpus/acquire', (req, res) => {
  const byteBudget = Math.min(Number(req.body?.byteBudgetMB ?? 20) * 1_048_576, 200 * 1_048_576)
  startAcquisition(
    {
      callModel: (m, msgs) => callModel(m as any, msgs, {}).catch(() => ''),
      pickFastModel: () => { try { return selectModels('general', SIMPLE_PIPELINE_CONFIG, 'simple', 'quorum').models[0] ?? null } catch { return null } },
    },
    { byteBudget, relationshipBudget: 100 },
  )
  res.json({ started: true, byteBudget })
})

// P14 — Ingest a user-provided document into the Living Corpus.
// Accepts { text, domain, source?, sourceReliability? } in the request body.
// The same validation/dedup/quarantine pipeline as the autonomous acquisition runs.
// Returns ingested/deduped/quarantined/bytes counts.
app.post('/api/corpus/ingest-document', async (req, res) => {
  const { text, domain, source, sourceReliability } = req.body ?? {}
  if (!text || typeof text !== 'string' || text.trim().length < 50) {
    return res.status(400).json({ error: 'text must be at least 50 characters' })
  }
  if (!domain || typeof domain !== 'string') {
    return res.status(400).json({ error: 'domain is required' })
  }
  try {
    const deps = {
      callModel: (m: any, msgs: any) => callModel(m, msgs, {}).catch(() => ''),
      pickFastModel: () => {
        try { return selectModels('general', SIMPLE_PIPELINE_CONFIG, 'simple', 'quorum').models[0] ?? null } catch { return null }
      },
    }
    const result = await ingestDocument(
      {
        text: text.trim(),
        domain: domain.trim(),
        source: source ?? 'user-provided',
        sourceReliability: typeof sourceReliability === 'number' ? Math.min(1, Math.max(0, sourceReliability)) : 0.75,
        stalenessClass: 'engineering',
      },
      deps,
      { relationshipBudget: 20 },
    )
    debugBus.emit('system', 'corpus_user_ingest', { domain, chars: text.length, ingested: result.ingested, deduped: result.deduped })
    res.json({ ok: true, ...result })
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'ingest failed' })
  }
})

// ── Step 9: Remote Brain ──────────────────────────────────────────────────────

// WebSocket /api/screen-stream-ws — binary JPEG frames for Remote Brain mode.
//
// Replaced SSE (text/event-stream + base64) with WebSocket binary frames to
// eliminate the 30-second lag caused by ngrok free-tier SSE buffering. ngrok
// and Cloudflare Tunnel both forward WebSocket frames without the HTTP chunked-
// transfer buffering that stalls SSE. Binary (ws.binaryType='blob') also skips
// the base64 encode/decode round-trip, halving per-frame bytes on the wire.
//
// iOS Safari fully supports binary WebSocket — no MJPEG or MediaSource needed.
// No auth: endpoint is LAN-scoped by the router ACL (same as the old SSE endpoint).
//
// Wired up to httpServer after it is created (see bottom of file).
// Live diagnostics for the screen stream — surfaced by GET /api/screen-diag so we can
// see which capture path is actually running (fast desktopCapturer vs slow screencapture
// fallback), the real fps, frame size, and any capture/permission error — without guessing.
const screenDiag = {
  producerConnected: false,   // Electron capture window's WS is connected
  ingestFlowing: false,       // it's actually delivering frames right now
  liveFps: 0,
  frameKB: 0,
  viewers: 0,
  viewerIps: [] as string[],  // source IPs of connected viewers (LAN phone vs Mac vs tunnel)
  captureError: null as string | null,
  fallbackActive: false,      // the slow screencapture loop is the current source
}
const _ingestFrameTimes: number[] = []

function attachScreenStreamWs(httpSrv: import('http').Server) {
  // Two WS endpoints share one HTTP server, so they must use `noServer` + a single
  // manual upgrade router. Attaching two `WsServer({ server })` instances makes both
  // grab the 'upgrade' event and race (400s / corrupt frames) — a real bug caught in
  // testing. Unmatched paths are left untouched so any other upgrade handler still works.
  const wss = new WsServer({ noServer: true })
  // Real-time producer channel: an in-process Electron capture window (desktopCapturer
  // → live MediaStream → JPEG) connects here and pushes 30fps frames. This is the
  // "real video viewer" path — no per-frame process spawn, no disk I/O. The legacy
  // screencapture loop below is now a FALLBACK that only runs when this feed is absent
  // (server started without Electron, or Screen-Recording permission denied), so the
  // stream is never worse than before.
  const ingestWss = new WsServer({ noServer: true })

  // Route WS upgrades by path. Leave unmatched requests alone (do NOT destroy the
  // socket) so other WS handlers on this server keep working.
  httpSrv.on('upgrade', (req, socket, head) => {
    let pathname = ''
    try { pathname = new URL(req.url ?? '', 'http://localhost').pathname } catch { /* ignore */ }
    if (pathname === '/api/screen-stream-ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
    } else if (pathname === '/api/screen-ingest-ws') {
      ingestWss.handleUpgrade(req, socket, head, (ws) => ingestWss.emit('connection', ws, req))
    }
  })

  // Phone viewers.
  const clients = new Map<import('ws').WebSocket, { framesSent: number; captureT0: number; ip: string; id: number }>()
  const refreshViewerIps = () => { screenDiag.viewerIps = [...clients.values()].map(s => s.ip) }

  // ── WebRTC signaling relay ────────────────────────────────────────────────────
  // The JPEG-over-WS path below can't be both loaded-from-crucible.cam AND direct-to-LAN
  // (an https page may not open a ws:// LAN socket — mixed content), so on the tunnel it
  // pays full tunnel latency. WebRTC fixes that: the page loads over https (auth intact),
  // the tunnel carries only tiny SDP/ICE signaling, and the video flows peer-to-peer
  // (Mac ↔ phone directly over the LAN/hotspot) via a hardware codec. This just RELAYS
  // signaling between the single producer (capture window) and each viewer by id; media
  // never touches the server. If WebRTC fails to connect, the viewer keeps using JPEG.
  let viewerSeq = 0
  const viewersById = new Map<number, import('ws').WebSocket>()
  function sendToProducer(obj: unknown): void {
    if (ingestProducer && ingestProducer.readyState === 1) {
      try { ingestProducer.send(JSON.stringify(obj)) } catch { /* noop */ }
    }
  }
  function sendJson(ws: import('ws').WebSocket, obj: unknown): void {
    if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)) } catch { /* noop */ } }
  }
  // Relay one JPEG frame to every viewer, dropping for any client whose buffer is
  // backing up (a slow phone must never stall the whole broadcast).
  function relay(frame: Buffer): void {
    for (const [ws, stat] of clients) {
      if (ws.readyState !== 1 /* OPEN */) continue
      if ((ws as any).bufferedAmount > 0) continue
      try { ws.send(frame); stat.framesSent++ } catch { /* cleaned up on 'close' */ }
    }
  }

  // ── Real-time ingest (preferred) ────────────────────────────────────────────
  let ingestProducer: import('ws').WebSocket | null = null
  let lastIngestFrameAt = 0
  let ingestFrames = 0
  // "Flowing" = a producer is connected AND has delivered a frame very recently.
  // Gating on actual frames (not just a connected socket) means a producer that
  // connects but can't capture (permission denied) does NOT suppress the fallback.
  const ingestFlowing = () => !!ingestProducer && ingestProducer.readyState === 1 && (Date.now() - lastIngestFrameAt < 1500)
  // Tell the capture window to start/stop the (CPU-costing) MediaStream based on
  // whether anyone is actually watching.
  function signalProducer(): void {
    if (ingestProducer && ingestProducer.readyState === 1) {
      try { ingestProducer.send(JSON.stringify({ cmd: clients.size > 0 ? 'start' : 'stop' })) } catch { /* noop */ }
    }
  }
  ingestWss.on('connection', (ws: import('ws').WebSocket, req) => {
    // Localhost only — the producer is the Electron app on THIS Mac.
    const ra = req.socket.remoteAddress || ''
    if (!(ra.includes('127.0.0.1') || ra.endsWith('::1') || ra === '::ffff:127.0.0.1')) { ws.close(); return }
    ingestProducer = ws
    screenDiag.producerConnected = true
    debugBus.emit('model', 'screen_ingest_start', {}, { severity: 'info' })
    signalProducer()
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      // Text (non-binary) messages are JSON control from the capture page: a captureError
      // (getDisplayMedia failed → permission) or captureOk (feed is up). Everything else
      // is a binary JPEG frame.
      if (!isBinary) {
        try {
          const msg = JSON.parse(data.toString())
          if (msg?.type === 'captureError') screenDiag.captureError = String(msg.error).slice(0, 300)
          else if (msg?.type === 'captureOk') screenDiag.captureError = null
          // WebRTC signaling from the producer → a specific viewer (offer / ICE).
          else if ((msg?.type === 'webrtc-offer' || msg?.type === 'webrtc-ice') && typeof msg.to === 'number') {
            const viewer = viewersById.get(msg.to)
            if (viewer) sendJson(viewer, msg)
          }
        } catch { /* ignore */ }
        return
      }
      const frame = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
      if (!frame.length) return
      lastIngestFrameAt = Date.now()
      ingestFrames++
      screenDiag.captureError = null
      screenDiag.frameKB = Math.round(frame.length / 1024)
      _ingestFrameTimes.push(lastIngestFrameAt)
      if (_ingestFrameTimes.length > 40) _ingestFrameTimes.shift()
      relay(frame)
      if (ingestFrames % 150 === 0) {
        debugBus.emit('model', 'screen_ingest_perf', { frames: ingestFrames, bytes: frame.length, clients: clients.size }, { severity: 'info' })
      }
    })
    const done = () => { if (ingestProducer === ws) { ingestProducer = null; screenDiag.producerConnected = false } }
    ws.on('close', done)
    ws.on('error', done)
  })

  // ── Fallback: per-frame screencapture (only when no real-time feed) ──────────
  const FRAME_INTERVAL_MS = 80
  const rawFile = '/tmp/crucible_screen_raw.jpg'
  const outFile = '/tmp/crucible_screen_out.jpg'
  const captureCmd = `screencapture -x -t jpg ${rawFile} && sips -Z 1100 ${rawFile} --out ${outFile} -s format jpeg -s formatOptions 45 >/dev/null 2>&1 || cp ${rawFile} ${outFile}`
  let loopRunning = false
  let totalBroadcasts = 0

  function broadcastLoop() {
    // Stop if nobody is watching, or the real-time feed has taken over.
    if (clients.size === 0 || ingestFlowing()) { loopRunning = false; screenDiag.fallbackActive = false; return }
    screenDiag.fallbackActive = true
    const loopStart = Date.now()
    exec(captureCmd, { timeout: 5000 }, (err) => {
      if (clients.size === 0 || ingestFlowing()) { loopRunning = false; return }
      if (err) { setTimeout(broadcastLoop, FRAME_INTERVAL_MS); return }
      fs.readFile(outFile, (readErr, frame) => {
        if (clients.size === 0 || ingestFlowing()) { loopRunning = false; return }
        if (readErr || !frame?.length) { setTimeout(broadcastLoop, FRAME_INTERVAL_MS); return }
        const captureMs = Date.now() - loopStart
        totalBroadcasts++
        relay(frame)
        if (totalBroadcasts % 50 === 0) {
          debugBus.emit('model', 'screen_stream_perf', { captureMs, clients: clients.size, frame: frame.length }, { severity: 'info' })
        }
        const elapsed = Date.now() - loopStart
        setTimeout(broadcastLoop, Math.max(0, FRAME_INTERVAL_MS - elapsed))
      })
    })
  }

  // Supervisor: while anyone is watching, make sure SOMETHING is producing frames —
  // the fallback loop whenever the real-time feed isn't flowing. This also resumes
  // the fallback within ~1s if the Electron feed drops mid-session.
  let supervisor: ReturnType<typeof setInterval> | null = null
  function ensureProducing() {
    if (clients.size > 0 && !ingestFlowing() && !loopRunning) { loopRunning = true; broadcastLoop() }
  }

  wss.on('connection', (ws: import('ws').WebSocket, req?: import('http').IncomingMessage) => {
    // Record the viewer's source IP so the diag can tell a LAN phone (192.168.x/10.x)
    // from the Mac's own app window (127.0.0.1/::1) from a tunnel-forwarded connection.
    const rawIp = (req?.socket?.remoteAddress || '').replace('::ffff:', '')
    const ip = rawIp === '::1' ? '127.0.0.1' : (rawIp || 'unknown')
    const id = ++viewerSeq
    const stat = { framesSent: 0, captureT0: Date.now(), ip, id }
    clients.set(ws, stat)
    viewersById.set(id, ws)
    screenDiag.viewers = clients.size
    refreshViewerIps()
    debugBus.emit('model', 'screen_stream_start', { totalClients: clients.size }, { severity: 'info' })
    signalProducer()          // wake the Electron capture window
    ensureProducing()         // and start the fallback until real frames arrive
    if (!supervisor) supervisor = setInterval(ensureProducing, 700)
    // Tell the producer a new viewer is here so it can open a WebRTC peer connection.
    // The viewer's own id is sent to it first so it can tag its signaling replies.
    sendJson(ws, { type: 'webrtc-id', id })
    sendToProducer({ type: 'viewer-join', id })

    // Signaling from this viewer → the producer (answer / ICE), tagged with its id.
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) return
      try {
        const msg = JSON.parse(data.toString())
        if (msg?.type === 'webrtc-answer' || msg?.type === 'webrtc-ice') {
          sendToProducer({ ...msg, from: id })
        }
      } catch { /* ignore */ }
    })

    ws.on('close', () => {
      clients.delete(ws)
      viewersById.delete(id)
      screenDiag.viewers = clients.size
      refreshViewerIps()
      sendToProducer({ type: 'viewer-leave', id })
      debugBus.emit('model', 'screen_stream_stop', { framesSent: stat.framesSent, totalClients: clients.size }, { severity: 'info' })
      if (clients.size === 0) {
        signalProducer()       // tell the capture window to stop capturing
        if (supervisor) { clearInterval(supervisor); supervisor = null }
      }
    })
    ws.on('error', () => { clients.delete(ws); viewersById.delete(id); refreshViewerIps() })
  })
}

// Mac's real LAN IPv4 addresses, ranked so the phone can connect DIRECTLY to this
// machine instead of looping through the Cloudflare tunnel (which may land on the
// Fly box that has no screen). Physical interfaces (en*) first, private ranges only.
// Hotspot networks (172.20.10.x), home WiFi (192.168.x.x) and 10.x all qualify.
function lanIpv4Addresses(): string[] {
  const isPrivate = (ip: string) =>
    /^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  const ifaces = os.networkInterfaces()
  const scored: { ip: string; rank: number }[] = []
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal || !isPrivate(a.address)) continue
      // en0/en1 (WiFi/Ethernet) preferred over bridge/utun/anpi virtual interfaces.
      const rank = /^en\d/.test(name) ? 0 : /^bridge/.test(name) ? 5 : 9
      scored.push({ ip: a.address, rank })
    }
  }
  return scored.sort((a, b) => a.rank - b.rank).map(s => s.ip)
}

// GET /api/screen-diag — one-glance answer to "why is the stream slow?". Open on the
// Mac: curl -s http://localhost:3001/api/screen-diag. Tells us which capture path is live
// (fast desktopCapturer vs slow screencapture fallback), the real fps, frame size, viewer
// count, and any capture/permission error — so we measure instead of guess.
app.get('/api/screen-diag', (_req: express.Request, res: express.Response) => {
  const now = Date.now()
  const recent = _ingestFrameTimes.filter(t => now - t < 1500)
  const liveFps = recent.length >= 2
    ? Math.round((recent.length - 1) * 1000 / (recent[recent.length - 1] - recent[0]))
    : 0
  const flowing = recent.length > 0 && (now - recent[recent.length - 1] < 1500)
  const source = flowing
    ? 'desktopCapturer (fast, real-time)'
    : screenDiag.fallbackActive
      ? 'screencapture fallback (slow ~2-3fps)'
      : (screenDiag.viewers > 0 ? 'starting…' : 'idle — no viewer connected')
  res.json({
    source,
    liveFps,
    frameKB: screenDiag.frameKB,
    viewers: screenDiag.viewers,
    viewerIps: screenDiag.viewerIps,
    producerConnected: screenDiag.producerConnected,
    captureError: screenDiag.captureError,
    hint: screenDiag.captureError
      ? 'The Electron capture window connected but getDisplayMedia failed — almost always macOS Screen-Recording permission. System Settings → Privacy & Security → Screen Recording → enable Crucible, then relaunch.'
      : flowing
        ? 'Fast path is live. If the phone still lags, it is connecting via the tunnel instead of the LAN — make sure the phone is on the same WiFi and using the ws://<lan-ip>:3001 URL.'
        : !screenDiag.producerConnected
          ? 'No capture producer connected. The Electron capture window is not running/reaching the server — is the app launched (not just the server)?'
          : 'Producer connected but no frames yet — waiting for a viewer or for capture to start.',
  })
})

// GET /api/remote-brain/status — check if Remote Brain tools are available
app.get('/api/remote-brain/status', requireAuth, (req, res) => {
  if (process.platform !== 'darwin') {
    return res.status(503).json({ available: false, error: 'Remote Brain requires macOS' })
  }
  exec('osascript -e "tell application \\"System Events\\" to return name of first process whose frontmost is true"',
    { timeout: 2000 }, (err, stdout) => {
      const frontApp = err ? null : stdout.trim()
      const port = Number(process.env.PORT) || 3001
      const lanIps = lanIpv4Addresses()
      const lanIp = lanIps[0]
      // Direct-to-Mac stream URL. The phone uses this to bypass the tunnel entirely
      // when it's on the same network — the only path that reliably reaches the
      // screen, since the tunnel can resolve to the screenless Fly origin.
      const screenStream = lanIp ? `ws://${lanIp}:${port}/api/screen-stream-ws` : null
      const lanOrigin = lanIp ? `http://${lanIp}:${port}` : null
      res.json({
        available: !err,
        frontApp,
        screenStream,      // direct-to-Mac ws:// URL (null if no LAN address found)
        lanOrigin,         // http://<lan-ip>:<port> — the fully-local app origin
        lanIps,            // all candidate LAN IPv4 addresses, ranked
        tools: ['get_ui_tree', 'click_element', 'type_text'],
      })
    })
})

// ── Debug API ─────────────────────────────────────────────────────────────────

// GET /api/debug/stream — SSE feed of all debug events in real time
app.get('/api/debug/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('Access-Control-Allow-Origin', '*')

  // Flush recent history first so the UI has context on connect
  const history = debugBus.history(200)
  res.write(`data: ${JSON.stringify({ type: 'history', events: history })}\n\n`)

  const unsub = debugBus.subscribe(event => {
    res.write(`data: ${JSON.stringify({ type: 'event', event })}\n\n`)
  })

  req.on('close', unsub)
})

// GET /api/debug/history — last N events as JSON
app.get('/api/debug/history', (req, res) => {
  const n = Math.min(500, parseInt((req.query.n as string) ?? '100', 10))
  res.json({ events: debugBus.history(n) })
})

// GET /api/google/status — which Google services are available for the current user
app.get('/api/google/status', (req: express.Request, res: express.Response) => {
  const user = getAuthUser(req)
  if (!user) return res.status(401).json({ error: 'Unauthorized' })
  res.json(googleServicesStatus(user.id))
})

// GET /api/history — session history (persisted rounds)
app.get('/api/history', async (req, res) => {
  const user = getAuthUser(req)
  try {
    const sessions = await historyLoad(user?.id ?? null, 200)
    res.json({ sessions: sessions.reverse ? sessions.reverse() : sessions })
  } catch {
    res.json({ sessions: [] })
  }
})

// GET /api/debug/chain/:requestId — causal chain for one request
app.get('/api/debug/chain/:requestId', (req, res) => {
  res.json({ chain: debugBus.causalChain(req.params.requestId) })
})

// GET /api/debug/patterns — learned error patterns + predictions
app.get('/api/debug/patterns', (req, res) => {
  const da = debugAnalyzer
  const lang = (req.query.lang as string) ?? 'javascript'
  res.json({
    patterns: da.allPatterns(),
    prediction: da.predict(lang as any),
  })
})

// GET /api/debug/topology — live system state
app.get('/api/debug/topology', (_req, res) => {
  const promptTypes = ['coding', 'reasoning', 'creative', 'factual', 'math', 'general'] as const
  const allSpec = Object.fromEntries(
    promptTypes.map(pt => [pt, getSpecializationWeights(pt as any)])
  )
  const registryState = MODEL_REGISTRY.map((m: any) => {
    const spec: Record<string, string> = {}
    for (const pt of promptTypes) {
      const w = allSpec[pt][m.id]
      if (w != null) spec[pt] = (w >= 0.5 ? '+' : '') + ((w - 0.5) * 100).toFixed(1) + '%'
    }
    return {
      id: m.id,
      label: m.label,
      provider: m.provider,
      circuitState: getCircuitState(m.id) ?? 'active',
      specialization: Object.keys(spec).length > 0 ? spec : undefined,
    }
  })
  const wls = waitlistStatus(process.cwd())
  res.json({
    models: registryState,
    modelsTotal: registryState.length,
    modelsHealthy: registryState.filter((m: any) => m.circuitState === 'active').length,
    providerLoad: allProviderLoads(),
    probation: wls.probation,
    localInference: {
      available: localInferenceAvailable,
      model: 'apple-fm',
      provider: 'apple-foundation-models',
      rateLimited: false,
      url: LOCAL_INFERENCE_URL,
    },
    uptime: process.uptime(),
  })
})

// GET /api/debug/quality — quality predictor stats + recent trend
app.get('/api/debug/quality', (_req, res) => {
  const stats = qualityPredictor.stats()
  res.json(stats)
})

// GET /api/debug/uncertainty-surface — per-topic calibration history (H2)
app.get('/api/debug/uncertainty-surface', (_req, res) => {
  res.json(getSurface(process.cwd()))
})

// J4 — Knowledge gap queue
app.get('/api/knowledge-gaps', (_req, res) => { res.json(listGaps(process.cwd())) })
app.post('/api/knowledge-gaps/:id/resolve', (req, res) => {
  resolveGap(process.cwd(), req.params.id, req.body.summary ?? '')
  res.json({ ok: true })
})

// J3 — Contradiction log
app.get('/api/contradiction-log', (_req, res) => { res.json(loadContradictionLog(process.cwd())) })

// J5 — Knowledge synthesis index
app.get('/api/knowledge-synthesis', (_req, res) => { res.json(getSynthesisIndex(process.cwd())) })
app.get('/api/knowledge-synthesis/:clusterId', (req, res) => {
  const content = readSynthesis(process.cwd(), req.params.clusterId)
  if (!content) { res.status(404).json({ error: 'not found' }); return }
  res.type('text/plain').send(content)
})

// GET /api/classifier/stats — learned prompt classifier health
app.get('/api/classifier/stats', (_req, res) => {
  const stats = classifierStats()
  res.json(stats)
})

// GET /api/debug/dynamic-tools — tools the agent has created for this project
app.get('/api/debug/dynamic-tools', (req, res) => {
  const projectPath = (req.query.project as string) || process.cwd()
  res.json(dynamicToolStats(projectPath))
})

// ── Library drawers (FABLE5_HANDOFF Feature 1) ────────────────────────────────
// GET /api/library/tools — built-in agent tools + per-project dynamic tools,
// shaped for the Tool Library drawer. Read-only; no auth-sensitive data.
app.get('/api/library/tools', (req, res) => {
  const projectPath = (req.query.project as string) || process.cwd()
  const dynamic = dynamicToolStats(projectPath).tools
  const dynamicNames = new Set(dynamic.map(t => t.name))
  const builtin = registry.list()
    .filter(t => !dynamicNames.has(t.name))
    .map(t => ({ name: t.name, description: t.description, mutates: t.mutates ?? false }))
    .sort((a, b) => a.name.localeCompare(b.name))
  res.json({ builtin, dynamic })
})

// GET /api/library/skills — the merged oracle-verified skill catalog (id,
// summary, path only — impl/tests omitted; entry count makes full payloads heavy).
app.get('/api/library/skills', (req, res) => {
  const q = ((req.query.q as string) || '').toLowerCase()
  let entries = SKILL_CATALOG.map(e => ({ id: e.id, summary: e.summary, defaultPath: e.defaultPath }))
  if (q) entries = entries.filter(e => e.id.toLowerCase().includes(q) || e.summary.toLowerCase().includes(q))
  res.json({ count: entries.length, total: SKILL_CATALOG.length, skills: entries })
})

// ── Verified NL-skill pipeline (FABLE5_HANDOFF Feature 1 increment) ──────────
// POST /api/library/skills/build starts a background build job: plain-language
// request → oracle-gated synthesis → catalogs/user-skills.json → generate:skills
// + prove:all. Long-running (FM rounds + ~100s prove), so POST returns a jobId
// and the drawer polls GET /api/library/skills/build/:id. One at a time — the
// pipeline contends for the FM daemon and rewrites the skill manifest.
interface SkillBuildJob {
  id: string
  status: 'running' | 'done' | 'failed'
  stage: UserSkillStage
  message: string
  request: string
  log: Array<{ ts: number; stage: UserSkillStage; message: string }>
  startedAt: number
  finishedAt?: number
  detail?: string
  entry?: { id: string; summary: string; defaultPath: string; exports: string[] }
}
const skillBuildJobs = new Map<string, SkillBuildJob>()

app.post('/api/library/skills/build', (req, res) => {
  const request = String(req.body?.request ?? '').trim()
  if (!request) { res.status(400).json({ error: 'request (plain-language skill description) required' }); return }
  const active = [...skillBuildJobs.values()].find(j => j.status === 'running')
  if (active) { res.status(409).json({ error: 'a skill build is already running', jobId: active.id }); return }
  const id = `sb_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const job: SkillBuildJob = {
    id, status: 'running', stage: 'admission',
    message: 'Starting the verified skill pipeline', request,
    log: [], startedAt: Date.now(),
  }
  skillBuildJobs.set(id, job)
  if (skillBuildJobs.size > 50) skillBuildJobs.delete(skillBuildJobs.keys().next().value as string)
  buildUserSkill(request, p => {
    job.stage = p.stage; job.message = p.message
    job.log.push({ ts: Date.now(), ...p })
  })
    .then(r => {
      job.status = r.ok ? 'done' : 'failed'
      job.stage = r.stage; job.message = r.message; job.detail = r.detail
      if (r.ok && r.entry) {
        job.entry = { id: r.entry.id, summary: r.entry.summary, defaultPath: r.entry.defaultPath, exports: r.entry.exports }
        // Make it live in THIS process immediately: the drawer listing, /skill
        // shortcut, and synthesis matching all read the merged catalog array.
        if (!SKILL_CATALOG.some(e => e.id === r.entry!.id)) SKILL_CATALOG.push(r.entry)
      }
      debugBus.emit('agent', 'user_skill_build', { ok: r.ok, stage: r.stage, id: r.entry?.id ?? null }, { severity: r.ok ? 'info' : 'warn' })
    })
    .catch(e => {
      job.status = 'failed'
      job.message = `Pipeline crashed: ${String(e?.message ?? e).slice(0, 200)}`
    })
    .finally(() => { job.finishedAt = Date.now() })
  res.json({ jobId: id })
})

app.get('/api/library/skills/build/:id', (req, res) => {
  const job = skillBuildJobs.get(req.params.id)
  if (!job) { res.status(404).json({ error: 'unknown job' }); return }
  res.json(job)
})

// POST /api/agent/graduate — approve global graduation for a dynamic tool (I6)
app.post('/api/agent/graduate', (req, res) => {
  const { name, projectPath } = req.body
  if (!name) { res.status(400).json({ error: 'name required' }); return }
  const ok = approveGlobalGraduation(projectPath || process.cwd(), name)
  res.json({ ok, name })
})

// GET /api/agent/scratchpad — inspect task scratchpad (I3)
app.get('/api/agent/scratchpad/:taskId', (req, res) => {
  res.json({ entries: readScratch(req.params.taskId) })
})

// GET /api/debug/codebase — codebase index stats + optional top-K search
app.get('/api/debug/codebase', (req, res) => {
  const projectPath = (req.query.project as string) || process.cwd()
  const query = req.query.q as string | undefined
  const stats = indexStats(projectPath)
  if (query) {
    const idx = ensureIndex(projectPath)
    const hits = searchIndex(idx, query, 10)
    res.json({ ...stats, query, hits: hits.map((e: any) => ({ rel: e.rel, lang: e.lang, symbols: e.symbols, summary: e.summary })) })
  } else {
    res.json(stats)
  }
})

// GET /api/debug/latency — per-model response-time dashboard (avg / p50 / p95)
app.get('/api/debug/latency', (_req, res) => {
  const report = getLatencyReport()
  // Annotate with model labels from registry
  const annotated = Object.entries(report).map(([id, stats]) => {
    const entry = MODEL_REGISTRY.find((m: any) => m.id === id)
    return { id, label: entry?.label ?? id, provider: entry?.provider ?? 'unknown', ...stats }
  }).sort((a, b) => a.avg - b.avg)
  res.json({ models: annotated, sampleCount: Object.values(report).reduce((s, v) => s + v.samples, 0) })
})

// GET /api/debug/substrate — Track Q: viability fingerprints + provider/family spread
app.get('/api/debug/substrate', (_req, res) => {
  res.json(substrateReport())
})

// GET /api/diag — ONE-CALL full-system snapshot. Every subsystem in a single
// response so a diagnosis needs no grep / log-reading. Each block is independently
// guarded: a failure in one subsystem yields { error } for that block, never a 500.
// GET /api/version — the exact code the running server has. Hit this (or crucible.cam/api/version)
// to confirm a fix actually landed: `commit`/`subject` should match the commit you expect.
app.get('/api/version', (_req, res) => { res.json(BUILD_INFO) })

app.get('/api/diag', (_req, res) => {
  const avg = (xs: number[]) => xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3) : 0
  const block = <T>(fn: () => T): T | { error: string } => {
    try { return fn() } catch (e: any) { return { error: e?.message ?? String(e) } }
  }

  const pipeline = block(() => ({
    requestsThisSession: diag.requestsThisSession,
    avgQualityScore: avg(diag.qualityScores),
    cacheHitRate: diag.requestsThisSession ? +(diag.cacheHits / diag.requestsThisSession).toFixed(3) : 0,
    lastRequest: diag.lastRequest,
  }))

  // FM daemon serialization queue — depth>0 or a high maxDepth means the single-session
  // model is contended (background work vs interactive); this is what starves live searches.
  const fmQueue = block(() => ({
    active: fmQueueStats.active, depth: fmQueueStats.depth, maxDepth: fmQueueStats.maxDepth,
    enqueued: fmQueueStats.enqueued, completed: fmQueueStats.completed, failed: fmQueueStats.failed,
  }))

  const models = block(() => {
    const registry = MODEL_REGISTRY.map(m => {
      const state = getCircuitState(m.id) ?? 'active'
      let tpmHeadroom = 0
      try { const l = predictProviderLoad(m.provider); tpmHeadroom = Math.max(0, l.cap - l.count) } catch {}
      return { id: m.id, label: m.label, provider: m.provider, state, tpmHeadroom, lastCall: lastModelCall(m.id) }
    })
    return {
      total: registry.length,
      active: registry.filter(m => m.state === 'active').length,
      tripped: registry.filter(m => m.state === 'tripped').length,
      probing: registry.filter(m => m.state === 'probing').length,
      registry,
      localInference: {
        available: localInferenceAvailable,
        model: 'apple-fm',
        provider: 'apple-foundation-models',
        rateLimited: false,
        url: LOCAL_INFERENCE_URL,
      },
    }
  })

  const substrate = block(() => {
    const rep = substrateReport()
    const lastIds = new Set((diag.lastSelection ?? []).map(m => m.id))
    const standbyPool = rep.models
      .filter(m => !lastIds.has(m.id))
      .slice(0, 5)
      .map(m => ({ id: m.id, label: m.label, viability: m.viability }))
    return {
      lastViabilityCheck: viabilitySnapshot(),
      lastDiversityScore: diag.lastDiversityScore,
      standbyPool,
      hotSwapsThisSession: diag.hotSwapsThisSession,
      providerHealth: providerHealthSnapshot(),   // 4.1 — live pool rebalance weights
    }
  })

  const masterpiece = block(() => ({
    lightFiredThisSession: diag.lightFiredThisSession,
    deepFiredThisSession: diag.deepFiredThisSession,
    lastGateDecision: diag.lastGateDecision,
    avgNoveltyScore: avg(diag.noveltyScores),
    corpusHitRate: diag.lightFiredThisSession ? +(diag.lightWithHits / diag.lightFiredThisSession).toFixed(3) : 0,
  }))

  const anima = block(() => {
    const truths = animaStore.allLiveTruths()
    return {
      truthStoreSize: truths.length,
      avgConfidence: avg(truths.map(t => t.confidence)),
      lastValenceReading: diag.lastValence,
      shapingAppliedThisSession: diag.animaShapingApplied,
      recentTruths: truths
        .sort((a, b) => (b.lastUpdated > a.lastUpdated ? 1 : -1))
        .slice(0, 5)
        .map(t => ({ observation: t.observation, domain: t.domain, confidence: t.confidence })),
    }
  })

  const corpus = block(() => {
    const s: any = corpusStatus()
    if (CORPUS_CHUNK_BASELINE == null) CORPUS_CHUNK_BASELINE = s.activeChunks ?? 0
    const domains: Record<string, number> = {}
    for (const d of (s.distribution ?? [])) domains[d.domain ?? d.name ?? 'unknown'] = d.count ?? d.chunks ?? 0
    return {
      totalChunks: s.activeChunks ?? 0,
      sizeMb: s.totalMB ?? 0,
      domains,
      topGaps: (s.gaps ?? []).slice(0, 5).map((g: any) => g.domain ?? g.name ?? g),
      ingestionQueueDepth: s.acquiring ? 1 : 0,  // no explicit queue; 1 = an acquisition cycle is active
      chunksAddedThisSession: Math.max(0, (s.activeChunks ?? 0) - (CORPUS_CHUNK_BASELINE ?? 0)),
    }
  })

  const errors = block(() => ({
    last10: debugBus.history(500)
      .filter(e => e.severity === 'error')
      .slice(-10)
      .map(e => ({ at: new Date(e.ts).toISOString(), category: e.category, type: e.type, data: e.data })),
  }))

  res.json({
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    version: BUILD_INFO,
    pipeline, fmQueue, models, substrate, masterpiece, anima, corpus, errors,
  })
})

// GET /api/autonomous/status — background improvement job state
app.get('/api/autonomous/status', (_req, res) => {
  res.json(autoImproveStatus())
})

// ── RSI — Recursive Self-Improvement layer ────────────────────────────────────
// Drives autonomous shaping of the offline brain (corpus + learned scoring weights)
// under a hard monotonic gate: every cycle snapshots known-good state, applies an
// improvement, re-measures the FULL pipeline against a benchmark baseline, and keeps
// the change ONLY if it holds or improves — otherwise it git-restores the snapshot.
// Long-lived internal token so the benchmark gate can drive the real authenticated
// pipeline (this is what makes the gate measure what RSI actually mutates).
const RSI_TOKEN = signJwt({ id: 'rsi-internal', email: 'rsi@crucible.local', exp: Math.floor(Date.now() / 1000) + 10 * 365 * 86400 })

// Extract the synthesized answer text from a /api/chat SSE response body.
function extractSynthesisFromSSE(body: string): string {
  let best = ''
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const payload = line.slice(6).trim()
    if (payload === '[DONE]') continue
    try {
      const ev = JSON.parse(payload)
      if ((ev.type === 'synthesis' || ev.type === 'final' || ev.type === 'layer1') && typeof ev.text === 'string') {
        if (ev.text.length > best.length) best = ev.text   // the full synthesis is the longest text event
      }
    } catch { /* skip partial/non-JSON lines */ }
  }
  return best
}

function buildRsiDeps(): RsiDeps {
  return {
    // Run a benchmark question through the FULL authenticated pipeline (quorum, no agent),
    // so the gate measures the scoring weights/patterns + corpus that RSI mutates.
    runQuery: async (question: string) => {
      const resp = await fetch(`http://localhost:${process.env.PORT || 3001}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `crucible_session=${RSI_TOKEN}` },
        body: JSON.stringify({ message: question, projectPath: process.cwd(), mode: 'quorum', device: 'desktop', agentMode: false }),
      })
      return extractSynthesisFromSSE(await resp.text())
    },
    // Best-effort internet→corpus acquisition for current gaps (additive, self-quarantining).
    acquire: () => {
      try {
        startAcquisition(
          {
            callModel: (m, msgs) => callModel(m as any, msgs, {}).catch(() => ''),
            pickFastModel: () => { try { return selectModels('general', SIMPLE_PIPELINE_CONFIG, 'simple', 'quorum').models[0] ?? null } catch { return null } },
          },
          { byteBudget: 25 * 1_048_576 },
        )
      } catch { /* acquisition is best-effort */ }
    },
    // Reload restored learned weights into the live SCORING_CONFIG after a revert, so a
    // rollback takes effect immediately (not just on the next restart).
    reloadLearnedState: () => { try { refreshScoringConfig() } catch {} },
  }
}

// GET /api/rsi/status — RSI ledger/state snapshot
app.get('/api/rsi/status', (_req, res) => {
  res.json(rsiStatus(process.cwd()))
})

// POST /api/rsi/cycle — manually trigger one gated RSI cycle (runs in background; idle-gated)
app.post('/api/rsi/cycle', (req, res) => {
  const user = getAuthUser(req)
  if (!user) return res.status(401).json({ error: 'Unauthorized' })
  if (activePipelineRequests > 0) return res.status(409).json({ error: 'busy — RSI runs only when idle', activePipelineRequests })
  runRsiCycle(process.cwd(), buildRsiDeps(), { force: true })
    .then(v => debugBus.emit('system', 'rsi_manual_cycle', { verdict: v }, { severity: 'info' }))
    .catch(() => {})
  res.json({ ok: true, started: true })
})

// POST /api/rsi/kill — kill switch: enable/disable all autonomous self-improvement
app.post('/api/rsi/kill', (req, res) => {
  const user = getAuthUser(req)
  if (!user) return res.status(401).json({ error: 'Unauthorized' })
  const enable = req.body?.enable === true
  setRsiEnabled(enable)
  res.json({ ok: true, enabled: enable })
})

// ── Self-repair approval layer (FABLE5_HANDOFF Feature 7) ─────────────────────
// The RSI cycle stays mechanically never-regress; these endpoints add the human
// propose → explain-in-plain-language → approve/reject step in front of it.

// GET /api/rsi/proposals — status blob: RSI state, auto-approve flag, recent proposals
app.get('/api/rsi/proposals', (_req, res) => {
  res.json(selfRepairStatus(process.cwd()))
})

// POST /api/rsi/propose — build a new pending proposal from live signals
app.post('/api/rsi/propose', (req, res) => {
  const user = getAuthUser(req)
  if (!user) return res.status(401).json({ error: 'Unauthorized' })
  const proposal = buildCycleProposal(process.cwd())
  if (!proposal) return res.status(409).json({ error: 'a proposal is already pending — answer it first' })
  res.json({ ok: true, proposal })
})

// POST /api/rsi/proposals/:id/approve — run the gated cycle; outcome lands on the proposal
app.post('/api/rsi/proposals/:id/approve', (req, res) => {
  const user = getAuthUser(req)
  if (!user) return res.status(401).json({ error: 'Unauthorized' })
  if (activePipelineRequests > 0) return res.status(409).json({ error: 'busy — self-repair runs only when idle', activePipelineRequests })
  const dir = process.cwd()
  const p = resolveProposal(dir, req.params.id, true)
  if (!p) return res.status(404).json({ error: 'no such pending proposal' })
  runRsiCycle(dir, buildRsiDeps(), { force: true })
    .then(v => recordProposalOutcome(dir, p.id, v))
    .catch(e => recordProposalOutcome(dir, p.id, 'error', String(e?.message ?? e).slice(0, 200)))
  res.json({ ok: true, started: true, proposal: p })
})

// POST /api/rsi/proposals/:id/reject
app.post('/api/rsi/proposals/:id/reject', (req, res) => {
  const user = getAuthUser(req)
  if (!user) return res.status(401).json({ error: 'Unauthorized' })
  const p = resolveProposal(process.cwd(), req.params.id, false)
  if (!p) return res.status(404).json({ error: 'no such pending proposal' })
  res.json({ ok: true, proposal: p })
})

// POST /api/rsi/auto-approve — opt into fully-automatic cycles (true AFK mode)
app.post('/api/rsi/auto-approve', (req, res) => {
  const user = getAuthUser(req)
  if (!user) return res.status(401).json({ error: 'Unauthorized' })
  const enabled = req.body?.enabled === true
  setAutoApprove(process.cwd(), enabled)
  res.json({ ok: true, enabled })
})

// ── Scheduled RSI tick — the auto-approve CONSUMER (FABLE5_HANDOFF Feature 7
// increment). The 6h scheduler no longer runs cycles silently; every tick is
// routed through the HITL/AFK stakes router (assessStakes 'rsi_cycle' — its
// first non-filesystem consumer, priority-ladder item 3):
//   · toggle OFF → high stakes → surface a pending proposal card in the
//     Self-repair drawer and WAIT for the human (nothing runs).
//   · toggle ON  → low stakes (standing authorization) → approve the proposal
//     and run the same gated cycle the manual Apply button runs, with the
//     honest outcome recorded onto the proposal either way.
async function runScheduledRsiTick(): Promise<{ action: string; detail?: string; proposalId?: string }> {
  const dir = process.cwd()
  if (activePipelineRequests > 0) return { action: 'skipped', detail: 'busy — RSI runs only when idle' }
  const auto = isAutoApproveEnabled(dir)
  const stakes = assessStakes('rsi_cycle', { autoApproveEnabled: auto }, '')

  if (stakes.stakes === 'high') {
    const proposal = buildCycleProposal(dir)
    if (!proposal) return { action: 'already-pending', detail: 'a proposal is already awaiting an answer' }
    debugBus.emit('system', 'rsi_tick_proposed', { proposalId: proposal.id, reason: stakes.reason }, { severity: 'info' })
    return { action: 'proposed', detail: stakes.reason, proposalId: proposal.id }
  }

  // AFK path — approve the pending proposal if one exists (the standing opt-in
  // covers it), else create-and-approve a fresh one so the ledger stays complete.
  const pending = listProposals(dir).find(p => p.status === 'pending') ?? buildCycleProposal(dir)
  if (!pending) return { action: 'skipped', detail: 'a prior approved cycle is still running' }
  resolveProposal(dir, pending.id, true)
  debugBus.emit('system', 'rsi_tick_auto_approved', { proposalId: pending.id }, { severity: 'info' })
  runRsiCycle(dir, buildRsiDeps())
    .then(v => { recordProposalOutcome(dir, pending.id, v); console.log(`[RSI] auto-approved scheduled cycle: ${v}`) })
    .catch(e => recordProposalOutcome(dir, pending.id, 'error', String(e?.message ?? e).slice(0, 200)))
  return { action: 'auto-approved', proposalId: pending.id }
}

// POST /api/rsi/tick — fire one scheduler tick on demand (ops/testing; identical
// decision path to the 6h interval, including the stakes-router gate).
app.post('/api/rsi/tick', async (req, res) => {
  const user = getAuthUser(req)
  if (!user) return res.status(401).json({ error: 'Unauthorized' })
  res.json({ ok: true, ...(await runScheduledRsiTick()) })
})

// ── Feedback (F2 — RLHF signal) ───────────────────────────────────────────────
const FEEDBACK_FILE = path.join(process.cwd(), '.crucible', 'feedback.json')
app.post('/api/feedback', (req, res) => {
  try {
    const { query, synthesis, vote, promptType } = req.body
    if (!query || !synthesis || !['up', 'down'].includes(vote)) return res.status(400).json({ error: 'bad params' })
    fs.mkdirSync(path.dirname(FEEDBACK_FILE), { recursive: true })
    let fb: any[] = []
    try { fb = JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8')) } catch {}
    fb.push({ ts: Date.now(), query: query.slice(0, 200), synthesis: synthesis.slice(0, 500), vote, promptType })
    if (fb.length > 2000) fb = fb.slice(-2000)
    fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(fb, null, 2))
    // Feed implicit preference model (Track D4)
    try { recordPreferenceFeedback(process.cwd(), vote, synthesis, query, promptType ?? 'general') } catch {}
    res.json({ ok: true })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// GET /api/export/gold-standard — JSONL of high-quality (score>=0.8, verified, no rephrase)
app.get('/api/export/gold-standard', async (req, res) => {
  try {
    const threshold = parseFloat((req.query.threshold as string) ?? '0.80')
    const expUser = getAuthUser(req)
    const sessions: any[] = await historyLoad(expUser?.id ?? null, 1000)
    const feedback: any[] = (() => { try { return JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8')) } catch { return [] } })()
    const downvotedQueries = new Set(feedback.filter(f => f.vote === 'down').map(f => f.query))
    const gold = sessions.filter(s =>
      (s.topScore ?? 0) >= threshold &&
      s.synthesis?.length > 50 &&
      !downvotedQueries.has(s.query)
    )
    const jsonl = gold.map(s => JSON.stringify({
      prompt: s.query,
      completion: s.synthesis,
      metadata: { promptType: s.promptType, score: s.topScore, ts: s.ts },
    })).join('\n')
    res.setHeader('Content-Type', 'application/x-ndjson')
    res.setHeader('Content-Disposition', `attachment; filename="crucible-gold-${Date.now()}.jsonl"`)
    res.send(jsonl || '// No gold-standard entries yet. Run more queries to accumulate data.')
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// ── A/B testing endpoints ─────────────────────────────────────────────────────
app.get('/api/ab/experiments', (_req, res) => {
  const exps = loadExperiments(process.cwd())
  const stats = exps.map(e => ({ ...e, stats: getExperimentStats(process.cwd(), e.id) }))
  res.json({ experiments: stats })
})
app.post('/api/ab/create', (req, res) => {
  const exp = createExperiment(process.cwd(), req.body)
  res.json({ experiment: exp })
})
app.post('/api/ab/decisions', (_req, res) => {
  runAutoDecisions(process.cwd())
  res.json({ ok: true })
})

// ── Benchmark endpoints ───────────────────────────────────────────────────────
app.get('/api/benchmarks', (_req, res) => {
  const benchmarks = loadBenchmarks(process.cwd())
  const runs = loadRuns(process.cwd())
  res.json({ count: benchmarks.length, lastRun: runs[runs.length - 1] ?? null })
})

app.post('/api/benchmarks/run', async (_req, res) => {
  res.json({ status: 'started' })
  // Run asynchronously — results persisted to .crucible/benchmark-runs.json
  runBenchmarkSuite(process.cwd(), async (question, pType) => {
    // Run through the fast pipeline path (simple complexity, no streaming)
    const { data: models } = selectModels(pType as any, SIMPLE_PIPELINE_CONFIG, 'simple') as any
    const m = (models ?? [])[0]
    if (!m) return ''
    return callModel(m, [
      { role: 'system', content: 'Answer concisely and accurately.' },
      { role: 'user', content: question },
    ]).catch(() => '')
  }, (done, total) => {
    console.log(`[Benchmarks] ${done}/${total}`)
  })
})

// ── Episodic memory endpoints ─────────────────────────────────────────────────
app.get('/api/memory/episodes', (req, res) => {
  const query = req.query.q as string
  const episodes = loadEpisodes()
  const context = query ? buildEpisodeContext(query) : ''
  res.json({ count: episodes.length, context, recent: episodes.slice(-5).reverse() })
})

// GET /api/hunter/status — discovered models
app.get('/api/hunter/status', (_req, res) => {
  const discovered = loadDiscoveredModels(process.cwd())
  res.json({
    count: discovered.length,
    models: discovered.map(m => ({
      id: m.id, label: m.label, params: m.params,
      probeLatencyMs: m.probeLatencyMs,
      discoveredAt: m.discoveredAt,
    })),
  })
})

// GET /api/hunter/run — trigger a manual hunt
app.post('/api/hunter/run', async (_req, res) => {
  const apiKey = process.env.VITE_OPENROUTER_API_KEY ?? ''
  if (!apiKey) return res.status(400).json({ error: 'No OpenRouter API key' })
  res.json({ status: 'started' })
  runModelHunter(process.cwd(), apiKey, MODEL_REGISTRY as any, m => {
    MODEL_REGISTRY.push(m as any)
  })
})

// GET /api/memory/global — read global memory digest
// ── F3/F4 — Fine-tuning pipeline endpoints ───────────────────────────────────

// Preview the SFT dataset (returns count + first 3 samples)
app.get('/api/finetune/preview', (req, res) => {
  const type = (req.query.type as string) ?? 'sft'
  try {
    if (type === 'dpo') {
      const triples = buildDPODataset(process.cwd())
      res.json({ type: 'dpo', count: triples.length, samples: triples.slice(0, 3) })
    } else {
      const entries = buildSFTDataset(process.cwd(), 0.80)
      res.json({ type: 'sft', count: entries.length, samples: entries.slice(0, 3) })
    }
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// Download as JSONL file
app.get('/api/finetune/export', (req, res) => {
  const type = (req.query.type as string) ?? 'sft'
  try {
    let jsonl: string
    let filename: string
    if (type === 'dpo') {
      jsonl = exportDPOJsonl(buildDPODataset(process.cwd()))
      filename = `crucible-dpo-${Date.now()}.jsonl`
    } else if (type === 'calibration') {
      // K5 — confident-but-wrong calibration training set as JSONL
      jsonl = exportCalibrationJsonl(buildCalibrationDataset(process.cwd()))
      filename = `crucible-calibration-${Date.now()}.jsonl`
    } else {
      jsonl = exportSFTJsonl(buildSFTDataset(process.cwd(), 0.80))
      filename = `crucible-sft-${Date.now()}.jsonl`
    }
    res.setHeader('Content-Type', 'text/plain')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(jsonl)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// Submit a fine-tune job to HuggingFace AutoTrain
app.post('/api/finetune/submit', async (req, res) => {
  const { type, hfToken, hfRepo } = req.body
  const token = hfToken || process.env.HF_TOKEN
  const repo = hfRepo || process.env.HF_REPO
  if (!token || !repo) return res.status(400).json({ error: 'HF_TOKEN and HF_REPO required' })
  try {
    const job = await submitFineTuneJob(process.cwd(), type ?? 'sft', token, repo)
    res.json(job)
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

app.get('/api/finetune/jobs', (_req, res) => {
  res.json({ jobs: loadFineTuneJobs(process.cwd()) })
})

// ── K1-K5 — Training data moat endpoints ─────────────────────────────────────
app.get('/api/finetune/hard-negatives', (_req, res) => { res.json(buildHardNegativeDataset(process.cwd())) })
app.post('/api/finetune/flag-negative', (req, res) => {
  const { query, correctedBy } = req.body
  if (!query || !correctedBy) { res.status(400).json({ error: 'query and correctedBy required' }); return }
  flagHardNegative(process.cwd(), query, correctedBy)
  res.json({ ok: true })
})
app.get('/api/finetune/disagreements', (_req, res) => { res.json(buildDisagreementDataset(process.cwd())) })
app.get('/api/finetune/adversarial-pairs', (_req, res) => { res.json(buildAdversarialPairs(process.cwd())) })
app.get('/api/finetune/calibration', (_req, res) => { res.json(buildCalibrationDataset(process.cwd())) })
app.get('/api/finetune/calibration/export', (_req, res) => {
  const examples = buildCalibrationDataset(process.cwd())
  res.type('text/plain').send(exportCalibrationJsonl(examples))
})
app.get('/api/finetune/finetuned-model-id', (_req, res) => { res.json({ modelId: getFineTunedModelId(process.cwd()) }) })

// ── E2 — Hardening A/B stats endpoint ────────────────────────────────────────
app.get('/api/debug/hardening-ab', async (_req, res) => {
  try {
    let sessions: any[] = []
    try { sessions = await historyLoad(null, 200) } catch {}
    const recent = sessions.slice(-200).filter((s: any) => s.hardeningCohort && s.topScore !== undefined)
    const hardened = recent.filter((s: any) => s.hardeningCohort === 'hardened')
    const raw = recent.filter((s: any) => s.hardeningCohort === 'raw')
    const avg = (arr: any[]) => arr.length ? arr.reduce((s, x) => s + x.topScore, 0) / arr.length : null
    res.json({
      hardenedCount: hardened.length,
      rawCount: raw.length,
      hardenedAvg: avg(hardened) ? parseFloat(avg(hardened)!.toFixed(4)) : null,
      rawAvg: avg(raw) ? parseFloat(avg(raw)!.toFixed(4)) : null,
      lift: (avg(hardened) !== null && avg(raw) !== null) ? parseFloat((avg(hardened)! - avg(raw)!).toFixed(4)) : null,
    })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// ── A2 — Counterfactual pairs endpoint ───────────────────────────────────────
app.get('/api/counterfactuals', (_req, res) => {
  res.json({ pairs: loadCounterfactuals(process.cwd()).slice(-20) })
})

// ── B4 — Meta-pipeline endpoints ─────────────────────────────────────────────
app.get('/api/meta-pipeline/task', (_req, res) => {
  res.json({ task: loadMetaTask(process.cwd()), result: loadMetaTaskResult(process.cwd()) })
})

app.post('/api/meta-pipeline/schedule', async (_req, res) => {
  try {
    const { loadTaxonomy: lt } = await import('./src/CrucibleEngine/failureTaxonomy')
    const clusters = lt(process.cwd()).map((c: any) => ({ label: c.label, exampleQuery: c.exampleQuery }))
    const task = scheduleMetaTask(process.cwd(), clusters)
    res.json({ task })
  } catch (e: any) { res.status(500).json({ error: e.message }) }
})

// ── Context anchor debug endpoint ────────────────────────────────────────────
app.get('/api/debug/context-anchor', (req, res) => {
  const anchorId = String(req.query.id ?? '')
  if (!anchorId) { res.status(400).json({ error: 'Pass ?id=<anchorId>' }); return }
  const anchor = getAnchor(anchorId)
  if (!anchor) { res.status(404).json({ error: 'Anchor not found (may have been cleaned up after loop end)' }); return }
  res.json({
    id: anchor.id,
    original: anchor.original.slice(0, 300),
    entityCount: anchor.entities.length,
    entities: anchor.entities.slice(0, 15),
    requirementCount: anchor.requirements.length,
    requirements: anchor.requirements,
  })
})

// ── Track B2/B3/C2/C3/D1/D2/D4/G1/G2/G3 debug endpoints ─────────────────────

app.get('/api/failure-taxonomy', (_req, res) => {
  res.json({ clusters: loadTaxonomy(process.cwd()) })
})

app.post('/api/failure-taxonomy/rebuild', (_req, res) => {
  try { res.json({ clusters: buildFailureTaxonomy(process.cwd()) }) }
  catch (e: any) { res.status(500).json({ error: e.message }) }
})

app.get('/api/stage-weights', (_req, res) => {
  res.json(getStageWeightSummary(process.cwd()))
})

app.get('/api/query-clusters', (_req, res) => {
  res.json({ clusters: loadClusters(process.cwd()) })
})

app.post('/api/query-clusters/rebuild', (_req, res) => {
  try { res.json({ clusters: detectEmergentClusters(process.cwd()) }) }
  catch (e: any) { res.status(500).json({ error: e.message }) }
})

app.get('/api/preference-model', (_req, res) => {
  res.json({ features: getPreferenceSummary(process.cwd()) })
})

app.get('/api/daemon/state', (_req, res) => {
  res.json(loadDaemonState(process.cwd()))
})

app.get('/api/entity-graph', (_req, res) => {
  res.json(loadGraph())
})

app.get('/api/roster', async (_req, res) => {
  try {
    const { loadRoster } = await import('./src/CrucibleEngine/rosterRotation')
    res.json({ roster: loadRoster(process.cwd()) })
  } catch (e: any) { res.json({ roster: [], error: e.message }) }
})

app.post('/api/roster/promote', (req, res) => {
  try {
    promoteFromBench(process.cwd(), req.body.modelId)
    res.json({ ok: true })
  } catch (e: any) { res.json({ ok: false, error: e.message }) }
})

app.get('/api/self-patcher/patches', (_req, res) => {
  try {
    res.json({ patches: loadPatches(process.cwd()) })
  } catch (e: any) { res.json({ patches: [], error: e.message }) }
})

app.post('/api/self-patcher/approve', async (req, res) => {
  try {
    const { approvePatch } = await import('./src/CrucibleEngine/selfPatcher')
    approvePatch(process.cwd(), req.body.id)
    res.json({ ok: true })
  } catch (e: any) { res.json({ ok: false, error: e.message }) }
})

// POST /api/self-patcher/reject — manual override / kill switch (see rejectPatch doc
// comment): pulls a live prompt patch out of rotation, or overturns a triumvirate rejection.
app.post('/api/self-patcher/reject', (req, res) => {
  try {
    if (!req.body?.id) { res.status(400).json({ ok: false, error: 'id required' }); return }
    rejectPatch(process.cwd(), req.body.id)
    res.json({ ok: true })
  } catch (e: any) { res.json({ ok: false, error: e.message }) }
})

app.get('/api/memory/global', (_req, res) => {
  const digest = readGlobalMemoryDigest()
  res.json({ digest, file: globalMemoryFile() })
})

// GET /api/autonomous/goals — ranked improvement goals from the goal engine
app.get('/api/autonomous/goals', (req, res) => {
  const projectPath = (req.query.project as string) || process.cwd()
  const refresh = req.query.refresh === 'true'
  try {
    const report = refresh ? (() => {
      const r = identifyGoals(projectPath)
      saveGoalReport(projectPath, r)
      return r
    })() : (loadGoalReport(projectPath) ?? (() => {
      const r = identifyGoals(projectPath)
      saveGoalReport(projectPath, r)
      return r
    })())
    res.json(report)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/autonomous/meta — triumvirate meta-learning state + effective thresholds
app.get('/api/autonomous/meta', (req, res) => {
  const projectPath = (req.query.project as string) || process.cwd()
  res.json(metaLearningStatus(projectPath))
})

// GET /api/autonomous/debates — triumvirate debate log + pending queue
app.get('/api/autonomous/debates', (req, res) => {
  const n = Math.min(parseInt((req.query.n as string) ?? '20', 10), 200)
  const log = loadTriumvirateLog(process.cwd()).slice(0, n)
  const pending = loadPendingQueue(process.cwd())
  res.json({ count: log.length, debates: log, pending: { count: pending.length, items: pending } })
})

// GET /api/debug/ratelimit — predictive rate management snapshot. Shows each
// provider's current fill, request velocity, projected load, and estimated time
// to its soft cap. `atRisk` flags providers we should shift load away from NOW.
app.get('/api/debug/ratelimit', (_req, res) => {
  const loads = allProviderLoads()
  res.json({
    providers: loads,
    atRisk: loads.filter(l => l.penalty < 1.0).map(l => l.provider),
  })
})

// ── Rolling keepalive — ping every registry model every 4 min so connections
// stay warm and provider KV caches stay populated. Staggers calls 3 s apart to
// avoid simultaneous rate-limit hits. Skips tripped circuit breakers.
const KEEPALIVE_INTERVAL_MS = 4 * 60 * 1000
const KEEPALIVE_STAGGER_MS  = 3_000
const KEEPALIVE_PROMPT = [{ role: 'user' as const, content: 'Hi' }]

async function runKeepaliveRound() {
  // Keepalive pause guard — never consume free-tier quota (or the single-session FM) with
  // warmup pings while a real request is mid-flight. activePipelineRequests covers the
  // pipeline path; isForegroundActive() also covers the agent/VGR path (which doesn't touch
  // that counter) so a live coding search is never delayed by a warmup round.
  if (activePipelineRequests > 0 || isForegroundActive()) return
  const models = MODEL_REGISTRY.filter(m => {
    const state = getCircuitState(m.id)
    return state !== 'tripped'
  })
  for (let i = 0; i < models.length; i++) {
    const m = models[i]
    if (i > 0) await new Promise(r => setTimeout(r, KEEPALIVE_STAGGER_MS))
    const selected: SelectedModel = { id: m.id, provider: m.provider, label: m.label, isWildcard: false }
    callModel(selected, KEEPALIVE_PROMPT).catch(() => {})
  }
  // Predictive rate check — surface providers trending toward their cap so the
  // selection penalty (already applied per-call) is visible in the debug stream.
  for (const load of allProviderLoads()) {
    if (load.penalty < 1.0) {
      debugBus.emit('circuit', 'ratelimit_warning', {
        provider: load.provider,
        count: load.count,
        cap: load.cap,
        velocityPerMin: Math.round(load.velocityPerMin),
        projectedCount: Math.round(load.projectedCount),
        secondsToCap: load.secondsToCap === Infinity ? null : Math.round(load.secondsToCap),
        penalty: load.penalty,
      }, { severity: load.penalty <= 0.3 ? 'warn' : 'info' })
    }
  }
  console.log(`[Keepalive] Pinged ${models.length} models`)
}

// ── Track N — N1: Admin governance endpoints ──────────────────────────────────
// GET  /api/governance          — all requests (pending + history)
// GET  /api/governance/pending  — pending only (for the UI badge)
// POST /api/governance/:id/approve
// POST /api/governance/:id/reject
// POST /api/governance          — submit a new request (for testing / N2 hook-in)

app.get('/api/governance', (_req, res) => {
  res.json(getAllRequests(process.cwd()))
})

app.get('/api/governance/pending', (_req, res) => {
  res.json(getPendingRequests(process.cwd()))
})

app.post('/api/governance/:id/approve', async (req, res) => {
  const result = approveRequest(process.cwd(), req.params.id)
  if (!result) return res.status(404).json({ error: 'not found or already decided' })
  // N2 — trigger provisioning dispatch for server_provisioning approvals
  if (result.category === 'server_provisioning') {
    runApprovedProvisioningRequests(process.cwd()).catch((e: any) => {
      debugBus.emit('pipeline', 'provisioning_error', { error: e?.message ?? String(e) }, { severity: 'error' })
    })
  }
  res.json(result)
})

// N2 — provisioning log
app.get('/api/governance/provisioning-log', (_req, res) => {
  res.json(getProvisioningLog(process.cwd()))
})

// N3 — domain store index
app.get('/api/domain-stores', (_req, res) => {
  res.json(getDomainStoreIndex(process.cwd()))
})

// Track O — horizon plan
app.get('/api/horizon-plan', (_req, res) => {
  res.json(getHorizonPlan(process.cwd()) ?? { tasks: [], goalSummary: '' })
})

app.post('/api/governance/:id/reject', (req, res) => {
  const result = rejectRequest(process.cwd(), req.params.id)
  if (!result) return res.status(404).json({ error: 'not found or already decided' })
  res.json(result)
})

// ── Optional local model pool — download/status/query for the on-device GGUF models ──
app.get('/api/local-models', async (_req, res) => {
  // ggufRuntimeAvailable: whether node-llama-cpp is importable. The model-switch UI
  // hides GGUF entries when it is false — offering a model the router can only fail to
  // load (pin silently no-ops) is worse than not offering it.
  const ggufRuntimeAvailable = await isGgufRuntimeAvailable()
  res.json({ models: listModelStatuses(), ggufRuntimeAvailable })
})

app.post('/api/local-models/:id/download', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  downloadModel(req.params.id, state => res.write(`data: ${JSON.stringify(state)}\n\n`))
    .then(() => res.end())
    .catch(err => { res.write(`data: ${JSON.stringify({ status: 'error', error: err?.message ?? String(err) })}\n\n`); res.end() })
})

app.delete('/api/local-models/:id', (req, res) => {
  deleteModel(req.params.id)
  res.json({ ok: true })
})

app.post('/api/local-models/:id/toggle', (req, res) => {
  const { enabled } = req.body ?? {}
  setModelEnabled(req.params.id, !!enabled)
  res.json({ ok: true })
})

app.get('/api/local-models/config', (_req, res) => {
  res.json(getModelsConfig())
})

app.post('/api/local-models/fire-all', (req, res) => {
  const { fireAll } = req.body ?? {}
  setFireAllMode(!!fireAll)
  res.json({ ok: true })
})

app.post('/api/local-models/pin', (req, res) => {
  const { modelId } = req.body ?? {}
  setPinnedModelId(typeof modelId === 'string' && modelId ? modelId : undefined)
  res.json({ ok: true })
})

app.get('/api/local-models/telemetry', (_req, res) => {
  res.json({ stats: getStats() })
})

app.post('/api/local-models/location', (req, res) => {
  const { path: newPath } = req.body ?? {}
  if (!newPath || typeof newPath !== 'string') return res.status(400).json({ error: 'missing path' })
  try {
    setModelsLocation(newPath)
    res.json({ ok: true, location: newPath })
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) })
  }
})

app.post('/api/local-models/query', async (req, res) => {
  const { system, user } = req.body ?? {}
  if (!user) return res.status(400).json({ error: 'missing user prompt' })
  try {
    const result = await routeLocalModelQuery(system ?? '', user)
    if (!result) return res.status(503).json({ error: 'no local models downloaded' })
    res.json(result)
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) })
  }
})

app.post('/api/governance', (req, res) => {
  const { category, title, what, why, how, impact, payload } = req.body as any
  if (!category || !title || !what || !why || !how || !impact) {
    return res.status(400).json({ error: 'missing required fields: category, title, what, why, how, impact' })
  }
  const id = submitRequest(process.cwd(), { category, title, what, why, how, impact, payload })
  res.json({ id })
})

// Real-time capture page — loaded ONLY by the hidden Electron capture window (see
// electron.cjs). It pulls a live screen MediaStream via getDisplayMedia (auto-granted
// by the main-process display-media handler), encodes ~30fps JPEG frames off a canvas,
// and streams them to /api/screen-ingest-ws, which relays to phone viewers. Runs on
// http://localhost (a secure context, so getDisplayMedia is allowed) and only captures
// while a viewer is connected (server sends start/stop). Must be registered BEFORE the
// SPA fallback below or index.html would shadow it.
app.get('/_capture', (_req: express.Request, res: express.Response) => {
  // Bitrate knobs — the dominant lever for glass-to-glass latency on a bandwidth-limited
  // phone link. At 24fps × ~95KB (the old 1100px/q0.55/30fps) the stream needs ~18 Mbit/s
  // sustained; when the link can't keep up, frames buffer below the server's visibility and
  // latency grows to many seconds. Lower defaults (~15fps, 900px, q0.42 ≈ 5 Mbit/s) fit
  // ordinary WiFi with headroom. Tunable live via env without a code change.
  const capW = Number(process.env.CRUCIBLE_CAPTURE_MAXW) || 900
  const capFps = Number(process.env.CRUCIBLE_CAPTURE_FPS) || 15
  const capQ = Number(process.env.CRUCIBLE_CAPTURE_QUALITY) || 0.42
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Crucible capture</title></head>
<body style="margin:0;background:#000">
<script>
(function () {
  var MAX_W = ${capW}, FPS = ${capFps}, QUALITY = ${capQ};
  var ws = null, stream = null, video = null, canvas = null, ctx = null;
  var capturing = false, wantCapture = false, timer = 0, reconnectT = 0;

  // WebRTC publisher state: one RTCPeerConnection per viewer id. The screen MediaStream
  // track is published peer-to-peer (Mac ↔ phone), so media never crosses the tunnel.
  // The JPEG loop below stays as an automatic fallback for viewers that can't establish
  // a peer connection.
  var peers = {};          // viewerId -> RTCPeerConnection
  var streamCbs = [];      // callbacks waiting for getDisplayMedia to resolve
  var ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

  function log(m){ try { console.log('[capture]', m) } catch(e){} }
  function sig(obj){ try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)) } catch(e){} }

  function whenStream(cb){ if (stream) cb(stream); else { streamCbs.push(cb); startCapture(); } }

  function onViewerJoin(id){
    whenStream(function (s){
      if (peers[id]) return;
      var pc = new RTCPeerConnection({ iceServers: ICE });
      peers[id] = pc;
      s.getVideoTracks().forEach(function (t){ try { pc.addTrack(t, s) } catch(e){} });
      pc.onicecandidate = function (ev){ if (ev.candidate) sig({ type: 'webrtc-ice', to: id, candidate: ev.candidate }); };
      pc.oniceconnectionstatechange = function (){
        var st = pc.iceConnectionState;
        if (st === 'failed' || st === 'closed' || st === 'disconnected') closePeer(id);
      };
      pc.createOffer().then(function (off){ return pc.setLocalDescription(off); })
        .then(function (){ sig({ type: 'webrtc-offer', to: id, sdp: pc.localDescription }); })
        .catch(function (e){ log('offer failed: ' + e); closePeer(id); });
    });
  }
  function onAnswer(id, sdp){ var pc = peers[id]; if (pc && sdp) pc.setRemoteDescription(sdp).catch(function(e){ log('answer failed: ' + e) }); }
  function onRemoteIce(id, cand){ var pc = peers[id]; if (pc && cand) pc.addIceCandidate(cand).catch(function(){}); }
  function closePeer(id){ var pc = peers[id]; if (pc){ try { pc.close() } catch(e){} delete peers[id]; } }
  function closeAllPeers(){ for (var k in peers) closePeer(k); }

  function connect() {
    clearTimeout(reconnectT);
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host + '/api/screen-ingest-ws');
    ws.binaryType = 'arraybuffer';
    ws.onmessage = function (e) {
      var msg; try { msg = JSON.parse(e.data) } catch (x) { return }
      if (msg.cmd === 'start') { wantCapture = true; startCapture() }
      else if (msg.cmd === 'stop') { wantCapture = false; stopCapture() }
      else if (msg.type === 'viewer-join') { wantCapture = true; onViewerJoin(msg.id) }
      else if (msg.type === 'viewer-leave') { closePeer(msg.id) }
      else if (msg.type === 'webrtc-answer') { onAnswer(msg.from, msg.sdp) }
      else if (msg.type === 'webrtc-ice') { onRemoteIce(msg.from, msg.candidate) }
    };
    ws.onclose = function () { stopCapture(); reconnectT = setTimeout(connect, 1000) };
    ws.onerror = function () { try { ws.close() } catch (x) {} };
  }

  function startCapture() {
    if (capturing || !wantCapture) return;
    capturing = true;
    navigator.mediaDevices.getDisplayMedia({ video: { frameRate: FPS }, audio: false })
      .then(function (s) {
        if (!wantCapture) { s.getTracks().forEach(function (t) { t.stop() }); capturing = false; return }
        stream = s;
        try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'captureOk' })) } catch (e) {}
        video = document.createElement('video');
        video.muted = true; video.srcObject = stream;
        // If the user stops sharing from the OS, tear down cleanly.
        stream.getVideoTracks()[0].addEventListener('ended', stopCapture);
        video.play().then(loop).catch(loop);
        // Flush any viewers that joined before the stream was ready — open their peers now.
        var cbs = streamCbs; streamCbs = [];
        cbs.forEach(function (cb){ try { cb(stream) } catch (e){} });
      })
      .catch(function (err) {
        log('getDisplayMedia failed: ' + err);
        // Report the failure to the server so /api/screen-diag can show it — this is
        // how "Screen-Recording permission denied" becomes visible instead of a silent
        // drop to the slow screencapture fallback.
        try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'captureError', error: String(err && err.message || err) })) } catch (e) {}
        capturing = false;
      });
  }

  function stopCapture() {
    capturing = false;
    clearTimeout(timer);
    closeAllPeers();
    if (stream) { stream.getTracks().forEach(function (t) { t.stop() }); stream = null }
    video = null;
  }

  function loop() {
    if (!capturing) return;
    var vw = video && video.videoWidth, vh = video && video.videoHeight;
    if (vw && vh && ws && ws.readyState === 1) {
      var w = Math.min(MAX_W, vw), h = Math.round(vh * (w / vw));
      if (!canvas) { canvas = document.createElement('canvas'); ctx = canvas.getContext('2d', { alpha: false }) }
      if (canvas.width !== w) { canvas.width = w; canvas.height = h }
      try { ctx.drawImage(video, 0, 0, w, h) } catch (e) {}
      // Only encode+send when the socket isn't already backed up — this self-throttles
      // to the real network/CPU rate and naturally drops frames instead of piling up.
      if (ws.bufferedAmount === 0) {
        canvas.toBlob(function (b) {
          if (b && ws && ws.readyState === 1 && ws.bufferedAmount === 0) {
            b.arrayBuffer().then(function (ab) { try { ws.send(ab) } catch (e) {} });
          }
        }, 'image/jpeg', QUALITY);
      }
    }
    timer = setTimeout(loop, Math.round(1000 / FPS));
  }

  connect();
})();
</script>
</body></html>`)
})

// SPA fallback — serve index.html for any non-API GET so React handles routing
// and the phone PWA never gets a 404 on direct URL access or page refresh.
// Must use app.use (not app.get('*')) — Express 5 / path-to-regexp v8 rejects bare '*'.
if (fs.existsSync(FRONTEND_BUILD)) {
  app.use((_req: express.Request, res: express.Response) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    res.sendFile(path.join(FRONTEND_BUILD, 'index.html'))
  })
}

const httpServer = createServer(app)
httpServer.keepAliveTimeout = 620000
httpServer.headersTimeout   = 630000
if (process.platform === 'darwin') attachScreenStreamWs(httpServer)

// ── Self-healing port binding ─────────────────────────────────────────────────
// If port 3001 is occupied by a stale Crucible/tsx process, kill it and retry.
// If occupied by something else (another app), bail with a clear message.
import { execSync } from 'child_process'

function startListening(port: number, attempt = 0) {
  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`Crucible server running on port ${port}`)
    // Track S — probe the local Apple FM bridge (macOS only, best-effort)
    if (process.platform === 'darwin') checkLocalInference().then(ok => { localInferenceAvailable = ok })
    initPg().catch(e => console.error('[Postgres] Init failed:', e.message))
    sweepStaleCheckpoints()
    prewarmPython()
    debugAnalyzer.init(process.cwd())
    qualityPredictor.init(process.cwd())
    autoImproveInit(process.cwd())
    autoImproveSetCallModel(callModel, MODEL_REGISTRY)
    refreshScoringConfig()
    // Load persisted dynamic tools the agent has created for this project
    loadDynamicToolsInto(process.cwd(), (def) => registry.register(def))
    // Integrations drawer: register a tool per known integration (gh, ripgrep, …).
    // Disabled ones stay registered but invisible to the agent (loop.ts filters
    // on enablement) — so a drawer toggle takes effect with no restart.
    registerIntegrationTools((def) => registry.register(def), (name) => !!registry.get(name))
      .then(n => console.log(`[Integrations] ${n} integration tool(s) registered`))
      .catch(e => console.warn('[Integrations] registration failed:', e?.message ?? e))
    // J2: expire stale world model facts at startup
    try { const r = expireStaleEntities(); if (r.expired) console.log(`[J2] Expired ${r.expired} stale entity facts`) } catch {}
    debugBus.emit('system', 'server_start', { port, cwd: process.cwd() })
    // Orphan sweep: a Crucible server that lost (or never won) the port can LINGER with all
    // its background daemons (keepalive, improvement ticks — every one FM-bound) and starve
    // this live instance's chat turns on the single FM bridge (observed 2026-07-11: five
    // lingering instances → chat stopped answering after the first query). We hold the port,
    // so any other orphaned (reparented-to-init) server.ts process is by definition stale.
    // Conservative match: node + server.ts, NOT a `tsx watch` supervisor, not us/our parent.
    try {
      const rows = execSync(`ps -eo pid=,ppid=,command= | grep 'server\\.ts' | grep node | grep -v grep`, { encoding: 'utf8' })
        .split('\n').map(l => l.trim()).filter(Boolean)
      for (const row of rows) {
        const m = /^(\d+)\s+(\d+)\s+(.*)$/.exec(row)
        if (!m) continue
        const [pid, ppid, cmd] = [Number(m[1]), Number(m[2]), m[3] as unknown as string] as [number, number, string]
        if (pid === process.pid || pid === process.ppid || /\bwatch\b/.test(cmd)) continue
        if (ppid !== 1) continue // only clearly-orphaned processes; live supervised trees are left alone
        try { process.kill(pid, 'SIGKILL'); console.warn(`[OrphanSweep] Killed lingering server.ts orphan ${pid}`) } catch { /* already gone */ }
      }
    } catch { /* sweep is best-effort */ }
    // Track P — seed the MASTERPIECE corpus off the request path so the first
    // light-mode call (which runs on every prompt) is not slowed by ONNX warmup.
    warmCorpus()

    // Track C — Living Corpus: start the lifecycle manager + initial gap audit,
    // and kick a background deliberate-curation acquisition cycle. All async/
    // background — never blocks request handling (corpus invariant #5).
    initCorpus(
      {
        callModel: (m, msgs) => callModel(m as any, msgs, {}).catch(() => ''),
        pickFastModel: () => {
          try { return selectModels('general', SIMPLE_PIPELINE_CONFIG, 'simple', 'quorum').models[0] ?? null } catch { return null }
        },
      },
      {
        // Standing constraint: under CRUCIBLE_OFFLINE=strict, NO external calls — ever.
        // Deliberate-curation acquisition fetches from external sources (e.g. arxiv.org);
        // strict must mean strict literally (decided 2026-07-01).
        autoAcquire: (process.env.CRUCIBLE_OFFLINE ?? '1') === 'strict' ? false : process.env.CORPUS_AUTOACQUIRE !== '0',
        byteBudget: 50 * 1_048_576,
      },
    )
    // Pre-warm the ONNX embedder in the background so the first query doesn't pay
    // the 20-30s cold-load cost inside the corpus-first gate. Fire-and-forget.
    import('./src/CrucibleEngine/masterpiece/corpus/embed.js')
      .then(({ ensureEmbedderReady }) => ensureEmbedderReady())
      .catch(() => {})

    runKeepaliveRound()
    setInterval(runKeepaliveRound, KEEPALIVE_INTERVAL_MS)

    // B4 meta-pipeline: poll for pending tasks every 30 min, run via internal agent call
    setInterval(async () => {
      try {
        const task = loadMetaTask(process.cwd())
        if (!task || task.status !== 'pending') return
        task.status = 'running'
        saveMetaTask(process.cwd(), task)
        appendMetaLog(process.cwd(), { event: 'task_start', id: task.id, failureMode: task.failureMode })
        // Post to own /api/chat agent endpoint
        const resp = await fetch(`http://localhost:${process.env.PORT || 3001}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: task.goal, projectPath: process.cwd(), mode: 'auto', device: 'desktop' }),
        })
        // Read full SSE stream to completion
        const text = await resp.text()
        const finalTextMatch = text.match(/"text":"([^"]+)"[^}]*"final":true/)
        const summary = finalTextMatch?.[1] ?? 'completed'
        task.status = 'done'
        task.resultSummary = summary.slice(0, 200)
        saveMetaTask(process.cwd(), task)
        appendMetaLog(process.cwd(), { event: 'task_done', id: task.id, summary })
        clearMetaTask(process.cwd())
      } catch (e: any) {
        const task = loadMetaTask(process.cwd())
        if (task) { task.status = 'failed'; saveMetaTask(process.cwd(), task) }
        appendMetaLog(process.cwd(), { event: 'task_failed', error: e.message })
      }
    }, 30 * 60 * 1000)

    // Improvement daemon tick (Track G1) — runs every 15 min
    setInterval(() => {
      // Yield the single-session FM to live requests: skip this heavy background pass
      // (learning cycles, self-play — all FM-bound) while any interactive request runs.
      // It will run on the next tick once the user is idle.
      if (isForegroundActive()) return
      daemonTick(process.cwd(), {
        failure_taxonomy: async () => {
          const clusters = buildFailureTaxonomy(process.cwd())
          // B4: schedule a meta-task targeting the top failure cluster
          if (clusters.length) scheduleMetaTask(process.cwd(), clusters.map(c => ({ label: c.label, exampleQuery: c.exampleQuery })))
        },
        cluster_detection: async () => { detectEmergentClusters(process.cwd()) },
        routing_learn: async () => { await runLearningCycle(classifyMissDomain, { batch: 20, gapMs: 2000 }) },
        ensemble_self_play: async () => {
          const r = await runSelfPlayCycle({
            weakQuestions: () => {
              try {
                const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.crucible', 'benchmarks.json'), 'utf8'))
                const arr = Array.isArray(raw) ? raw : (raw.benchmarks ?? raw.questions ?? [])
                return arr.filter((b: any) => (b.lastScore ?? b.score ?? 1) < 0.75)
                  .map((b: any) => b.question ?? b.prompt ?? b.q).filter(Boolean).slice(0, 20)
              } catch { return [] }
            },
            generate: async (q: string) => {
              const active = (MODEL_REGISTRY as any[]).filter(m => getCircuitState(m.id) === 'active').slice(0, 2)
              const out: string[] = []
              for (const m of active) { try { out.push(await callModel(m, [{ role: 'user', content: q }], { timeoutMs: 12000 })) } catch {} }
              return out
            },
            critique: async (question: string, answer: string) => {
              const model = pickResearchModel()
              if (!model) return ''
              try {
                return await callModel(model, [{ role: 'user', content: `This is a flawed answer to "${question}". Identify the SPECIFIC error (factual or logical), not surface issues. If the answer is actually correct, reply exactly: NO ERROR.\n\nAnswer:\n${answer}` }], { timeoutMs: 12000 })
              } catch { return '' }
            },
            onThreshold: async (_p: string, size: number) => {
              try { const ft = await import('./src/CrucibleEngine/fineTuning'); ft.buildDPODataset(process.cwd()) } catch {}
              debugBus.emit('system', 'self_play_threshold', { size }, { severity: 'info' })
            },
          }, { maxQuestions: 5, threshold: 200 })
          debugBus.emit('system', 'ensemble_self_play', r as any, { severity: 'info' })
        },
        benchmark_check: async () => {
          const { runBenchmarkSuite } = await import('./src/CrucibleEngine/benchmarks')
          const reg = MODEL_REGISTRY.filter((m: any) => m.provider !== 'wildcard')
          if (!reg.length) return
          const model = reg[0]
          const runQuery = (question: string, promptType: string) =>
            callModel(model as unknown as SelectedModel, [
              { role: 'system', content: `You are a helpful assistant. Answer concisely. Prompt type: ${promptType}.` },
              { role: 'user', content: question },
            ], { timeoutMs: 12000 })
          await runBenchmarkSuite(process.cwd(), runQuery)
          await publishBenchmarks()   // Session N: feed the public dashboard
        },
        stage_weight_rebuild: async () => {
          let sessions: any[] = []
          try { sessions = await historyLoad(null, 50) } catch {}
          for (const s of sessions.slice(-50)) {
            if (s.promptType && s.topScore !== undefined) {
              recordStageWeightRound(process.cwd(), s.promptType, { stage5_synthesis: s.topScore }, s.topScore * 0.8)
            }
          }
        },
        // 3.1 — Close the fine-tuning loop: auto-submit an SFT run when the
        // gold-standard dataset first crosses 1000 entries, then every +500.
        finetune_autotrigger: async () => {
          const dir = process.cwd()
          const markerFile = path.join(dir, '.crucible', 'finetune-autotrigger.json')
          let marker: { lastSubmitCount: number } = { lastSubmitCount: 0 }
          try { marker = JSON.parse(fs.readFileSync(markerFile, 'utf8')) } catch {}
          const goldCount = buildSFTDataset(dir, 0.80).length
          // Highest threshold crossed: 1000, then 1500, 2000, ... (every +500).
          const threshold = goldCount >= 1000 ? 1000 + Math.floor((goldCount - 1000) / 500) * 500 : 0
          if (threshold === 0 || threshold <= marker.lastSubmitCount) {
            debugBus.emit('system', 'finetune_autotrigger_idle', { goldCount, nextAt: marker.lastSubmitCount === 0 ? 1000 : marker.lastSubmitCount + 500 }, { severity: 'info' })
            return
          }
          const token = process.env.HF_TOKEN || process.env.VITE_HF_API_KEY
          const repo = process.env.HF_REPO
          if (!token || !repo) {
            // Armed but unconfigured — do NOT advance the marker, so it fires once HF_REPO is set.
            console.warn(`[FineTune] auto-trigger armed (gold=${goldCount} ≥ ${threshold}) but HF_REPO/HF_TOKEN unset — skipping`)
            debugBus.emit('system', 'finetune_autotrigger_unconfigured', { goldCount, threshold }, { severity: 'warn' })
            return
          }
          console.log(`[FineTune] auto-trigger: gold-standard ${goldCount} ≥ ${threshold} — submitting SFT job`)
          const job = await submitFineTuneJob(dir, 'sft', token, repo)
          marker.lastSubmitCount = threshold
          try { fs.mkdirSync(path.dirname(markerFile), { recursive: true }); fs.writeFileSync(markerFile, JSON.stringify(marker, null, 2)) } catch {}
          debugBus.emit('system', 'finetune_autotrigger_submitted', { goldCount, threshold, jobId: job.id, status: job.status }, { severity: job.status === 'failed' ? 'error' : 'success' })
        },
      })
    }, 15 * 60 * 1000)

    // Self-patcher: analyse debug + quality history every 6 hours
    const runSelfPatchCycle = async () => {
      try {
        const debugHistory = debugBus.history(500)
        let qualityHistory: any[] = []
        try { qualityHistory = await historyLoad(null, 200) } catch {}
        const promptTypes = ['coding', 'reasoning', 'creative', 'factual', 'math', 'general']
        const triumvirate = async (proposal: string) => {
          // Three independent judge calls — majority rules
          const judges = await Promise.allSettled(
            [0, 1, 2].map(() => callModel(
              { id: 'mistralai/mistral-7b-instruct:free', label: 'judge', provider: 'openrouter', isWildcard: false },
              [{ role: 'user', content: `You are a conservative pipeline safety judge. Evaluate this proposed pipeline change. Reply with JSON only: {"approved": true/false, "reason": "..."}\n\n${proposal}` }],
              { timeoutMs: 8000 }
            ))
          )
          const votes = judges.map(r => {
            if (r.status !== 'fulfilled') return { approved: false, reason: 'judge failed' }
            try { return JSON.parse(r.value.replace(/```json|```/g, '').trim()) } catch { return { approved: false, reason: 'parse error' } }
          })
          const approveCount = votes.filter(v => v.approved).length
          return { approved: approveCount >= 2, reason: votes[0]?.reason ?? '' }
        }
        runSelfPatcher(process.cwd(), debugHistory, qualityHistory, promptTypes, triumvirate)
          .catch(e => console.warn('[SelfPatcher] Cycle error:', e.message))
      } catch {}
    }
    setTimeout(runSelfPatchCycle, 60_000)  // first run 60s after startup
    setInterval(runSelfPatchCycle, 6 * 60 * 60 * 1000)  // then every 6h

    // ── RSI — Recursive Self-Improvement cycle (Track RSI) ────────────────────
    // Every 6h, ONLY when fully idle, run one monotonic self-improvement cycle:
    // snapshot → acquire (internet→corpus) + improve (learned weights) → re-benchmark
    // the full pipeline → keep only if it holds/improves, else git-restore. Off the
    // request path; kill-switch via POST /api/rsi/kill or env RSI_ENABLED=0.
    // Every tick now routes through the stakes-router + proposal layer (see
    // runScheduledRsiTick next to the /api/rsi endpoints): proposes-and-waits by
    // default, auto-approves only under the explicit fully-automatic opt-in.
    const rsiTick = () => {
      runScheduledRsiTick()
        .then(r => console.log(`[RSI] scheduled tick: ${r.action}${r.detail ? ` — ${r.detail}` : ''}`))
        .catch(e => console.warn('[RSI] tick error:', e?.message ?? e))
    }
    setInterval(rsiTick, 6 * 60 * 60 * 1000)   // every 6h, idle-gated (no run at boot)

    // ── 4.3 — Automated smoke at startup ───────────────────────────────────────
    // Run the smoke benchmark suite once shortly after boot (background, non-
    // blocking), persist the result, and ALERT the debug bus on any regression vs
    // the previous run. Throttled to once per 6h so rapid restarts don't burn the
    // free-tier pool. Disable with CRUCIBLE_SMOKE_ON_BOOT=0.
    const runStartupSmoke = () => {
      if (process.env.CRUCIBLE_SMOKE_ON_BOOT === '0') return
      const dir = process.cwd()
      const resultFile = path.join(dir, '.crucible', 'smoke-last.json')
      let prev: { ts: number; hardFailures: number; softFailures: number; passed: boolean } | null = null
      try { prev = JSON.parse(fs.readFileSync(resultFile, 'utf8')) } catch {}
      if (prev && Date.now() - prev.ts < 6 * 60 * 60 * 1000) {
        console.log('[Smoke] skipped boot run — last run < 6h ago')
        return
      }
      console.log('[Smoke] running boot smoke suite (background)…')
      const child = spawn('npx', ['tsx', 'src/CrucibleEngine/smoke-benchmarks.ts'], {
        cwd: CODE_DIR, env: { ...process.env, CRUCIBLE_API: `http://localhost:${port}` },
      })
      let out = ''
      child.stdout.on('data', d => { out += d.toString() })
      child.stderr.on('data', d => { out += d.toString() })
      child.on('error', e => {
        debugBus.emit('system', 'smoke_boot_error', { error: e.message }, { severity: 'warn' })
      })
      child.on('close', code => {
        const grab = (re: RegExp) => { const m = out.match(re); return m ? parseInt(m[1], 10) : -1 }
        const hardFailures = grab(/HARD failures:\s*(\d+)/)
        const softFailures = grab(/SOFT failures:\s*(\d+)/)
        const passed = code === 0
        const result = { ts: Date.now(), hardFailures, softFailures, passed, exitCode: code }
        try { fs.mkdirSync(path.dirname(resultFile), { recursive: true }); fs.writeFileSync(resultFile, JSON.stringify(result, null, 2)) } catch {}
        const regressed = prev != null && ((prev.passed && !passed) || (hardFailures > prev.hardFailures && hardFailures >= 0))
        debugBus.emit('system', 'smoke_boot_result', {
          passed, hardFailures, softFailures, exitCode: code,
          regressedFromPrevious: regressed,
          previous: prev ? { hardFailures: prev.hardFailures, passed: prev.passed } : null,
        }, { severity: regressed || !passed ? 'error' : 'success' })
        console.log(`[Smoke] boot run ${passed ? 'PASSED' : 'FAILED'} (hard=${hardFailures}, soft=${softFailures}${regressed ? ', REGRESSION vs previous' : ''})`)
      })
    }
    setTimeout(runStartupSmoke, 90_000)   // 90s after boot — server + pool warm

    // Re-probe benched models once per hour
    setInterval(() => {
      try {
        const ready = getModelsReadyForReprobe(process.cwd())
        for (const entry of ready) {
          const model = MODEL_REGISTRY.find(m => m.id === entry.modelId)
          if (!model) continue
          callModel(model as unknown as SelectedModel, [{ role: 'user', content: 'Reply with one word: ready' }], { timeoutMs: 8000 })
            .then(() => {
              promoteFromBench(process.cwd(), entry.modelId)
              console.log(`[Roster] Re-probe passed: ${entry.label} restored to active`)
            })
            .catch(() => console.log(`[Roster] Re-probe failed: ${entry.label} remains benched`))
        }
      } catch {}
    }, 60 * 60 * 1000)
  })

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EADDRINUSE') throw err
    if (attempt > 0) {
      console.error(`[Port] Port ${port} still occupied after kill attempt. Exiting.`)
      process.exit(1)
    }
    console.warn(`[Port] ${port} in use — scanning for stale Crucible process…`)
    try {
      // Find the PID holding the port
      const lsof = execSync(`lsof -ti tcp:${port} 2>/dev/null`, { encoding: 'utf8' }).trim()
      if (!lsof) { console.error('[Port] Cannot identify occupant. Exiting.'); process.exit(1) }
      const pids = lsof.split('\n').filter(Boolean)
      for (const pid of pids) {
        try {
          // Only kill if it's a tsx/node process (safety check)
          const cmd = execSync(`ps -p ${pid} -o comm= 2>/dev/null`, { encoding: 'utf8' }).trim()
          if (/node|tsx/.test(cmd)) {
            console.warn(`[Port] Killing stale process ${pid} (${cmd})`)
            execSync(`kill -9 ${pid}`)
          } else {
            console.error(`[Port] Port ${port} held by non-Crucible process "${cmd}" (PID ${pid}). Exiting.`)
            process.exit(1)
          }
        } catch { /* pid already gone */ }
      }
      // Give the OS a moment to release the port, then retry once
      setTimeout(() => {
        httpServer.removeAllListeners('error')
        startListening(port, attempt + 1)
      }, 600)
    } catch (e) {
      console.error('[Port] Failed to resolve port conflict:', e)
      process.exit(1)
    }
  })
}

startListening(Number(process.env.PORT) || 3001)

// Shutdown MUST terminate the process. The previous handlers called httpServer.close()
// (which only releases the port) but never exited, and the `setInterval(()=>{},1<<30)`
// below kept the event loop alive forever — so every preview/app stop or relaunch
// stranded a fully-live server (RSI, self-patch, hunter, corpus, keepalive loops + a
// resident Python REPL child) running for hours. On an 8GB machine a handful of these
// orphans is swap-death. Close the socket, reap child processes, then hard-exit — with
// a bounded fallback so a hung close() can't wedge shutdown again.
// Reap every long-lived child this process owns, so shutdown doesn't orphan them
// (the persistent Python REPL worker and any cloudflared tunnel were the observed strays).
function killManagedChildren() {
  try { shutdownSandbox() } catch {}
  try { _remoteTunnel?.cp?.kill('SIGKILL') } catch {}
}

let shuttingDown = false
function gracefulShutdown(signal: string) {
  if (shuttingDown) { process.exit(0); return }
  shuttingDown = true
  console.log(`[Shutdown] ${signal} — closing server and reaping children`)
  try { killManagedChildren() } catch {}
  try { httpServer.close(() => process.exit(0)) } catch { process.exit(0) }
  // Fallback: never let a lingering connection or timer keep us alive.
  setTimeout(() => process.exit(0), 2000).unref()
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT',  () => gracefulShutdown('SIGINT'))
