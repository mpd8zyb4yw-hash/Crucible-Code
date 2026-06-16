// ============================================================
// CRUCIBLE — Debug Tap (NOT a UI component)
//
// This file is a convenience re-export for anything outside
// the CrucibleEngine that needs to subscribe to the debug bus
// or read analyzer state. The bus itself runs purely in
// server.ts — this is just the access point.
//
// HOW TO TAP IN (server-side, e.g. a new route or module):
//
//   import { debugBus } from './src/CrucibleEngine/debug/bus'
//   import { debugAnalyzer } from './src/CrucibleEngine/debug/analyzer'
//
//   // Subscribe to live events
//   const unsub = debugBus.subscribe(event => { ... })
//   unsub() // call to unsubscribe
//
//   // Read last N events
//   const recent = debugBus.history(50)
//
//   // Get causal chain for a specific request
//   const chain = debugBus.causalChain(requestId)
//
//   // Get learned error patterns
//   const patterns = debugAnalyzer.allPatterns()
//
//   // Predict likely errors for a language
//   const pred = debugAnalyzer.predict('python')
//
// HTTP ENDPOINTS (all on port 3001):
//   GET  /api/debug/stream          — SSE live feed (all events)
//   GET  /api/debug/history?n=100   — last N events as JSON
//   GET  /api/debug/chain/:requestId — causal chain for one request
//   GET  /api/debug/patterns         — learned patterns + prediction
//   GET  /api/debug/topology         — model health / circuit states
//
// EMIT FROM A NEW MODULE:
//   debugBus.emit('category', 'event_type', { ...data }, { severity, requestId })
//   Categories: 'model' | 'pipeline' | 'verify' | 'execution' | 'agent' | 'tool' | 'circuit' | 'system'
//   Severities: 'info' | 'warn' | 'error' | 'success'
//
// ============================================================

export { debugBus } from './CrucibleEngine/debug/bus'
export { debugAnalyzer } from './CrucibleEngine/debug/analyzer'
export type { DebugEvent, DebugSeverity } from './CrucibleEngine/debug/bus'
export type { ErrorPattern, CausalChain, Prediction } from './CrucibleEngine/debug/analyzer'
