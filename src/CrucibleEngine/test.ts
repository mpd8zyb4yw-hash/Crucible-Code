// ============================================================
// CRUCIBLE — Scoring Engine Tests
// Run with: node --experimental-strip-types src/test.ts
// ============================================================

import { evaluateIteration, formatCritiqueForModel } from "./scoring-engine";
import { DEFAULT_SCORING_CONFIG } from "./types";

const config = DEFAULT_SCORING_CONFIG;

// ── TEST 1: Gold standard memoization ───────────────────────
console.log("\n═══ TEST 1: Gold standard memoization ═══");
const goldMemo = evaluateIteration({
  proposedSource: `
    function memoize<T>(fn: (...args: unknown[]) => T, maxSize = 500) {
      const cache = new Map<string, T>();
      return (...args: unknown[]): T => {
        const key = JSON.stringify(args);
        if (cache.has(key)) return cache.get(key)!;
        const result = fn(...args);
        if (cache.size >= maxSize) {
          const firstKey = cache.keys().next().value;
          cache.delete(firstKey);
        }
        cache.set(key, result);
        return result;
      };
    }
  `,
  problemStatement: "Implement memoization for expensive pure functions",
  pipelineLayer: 1,
}, config, 1);

console.log(formatCritiqueForModel(goldMemo.score));
console.log(`\nShould accept: ${goldMemo.shouldAccept}`);
console.log(`Should escalate: ${goldMemo.shouldEscalate}`);

// ── TEST 2: Broken implementation with antipatterns ─────────
console.log("\n═══ TEST 2: Broken implementation ═══");
const broken = evaluateIteration({
  proposedSource: `
    async function fetchWithRetry(url) {
      while (true) {
        try {
          return await fetch(url);
        } catch (e) {}
      }
    }
  `,
  problemStatement: "Fetch data with retry on failure",
  pipelineLayer: 1,
}, config, 1);

console.log(formatCritiqueForModel(broken.score));
console.log(`\nShould accept: ${broken.shouldAccept}`);

// ── TEST 3: Novel implementation ────────────────────────────
console.log("\n═══ TEST 3: Novel but functional ═══");
const novel = evaluateIteration({
  proposedSource: `
    // Adaptive retry with circuit breaker integration
    type RetryResult<T> = { ok: true; value: T } | { ok: false; error: Error; attempts: number };
    
    async function adaptiveRetry<T>(
      fn: () => Promise<T>,
      options: { maxAttempts: number; initialDelay: number; circuitBreaker?: CircuitBreaker }
    ): Promise<RetryResult<T>> {
      let attempt = 0;
      let lastError: Error;
      
      while (attempt < options.maxAttempts) {
        try {
          const value = await fn();
          return { ok: true, value };
        } catch (e) {
          lastError = e as Error;
          attempt++;
          if (attempt < options.maxAttempts) {
            const delay = options.initialDelay * (2 ** attempt) + Math.random() * 100;
            await new Promise(r => setTimeout(r, Math.min(delay, 30000)));
          }
        }
      }
      return { ok: false, error: lastError!, attempts: attempt };
    }
  `,
  problemStatement: "Robust async retry with backoff and result typing",
  pipelineLayer: 1,
}, config, 1);

console.log(formatCritiqueForModel(novel.score));
console.log(`\nIs surprise candidate: ${novel.score.isSurpriseCandidate}`);
console.log(`Should accept: ${novel.shouldAccept}`);

// ── TEST 4: Escalation after 3 iterations ───────────────────
console.log("\n═══ TEST 4: Escalation check ═══");
const iteration3 = evaluateIteration({
  proposedSource: `function doThing(x) { return x; }`,
  problemStatement: "Implement observer pattern",
  pipelineLayer: 1,
}, config, 3);

console.log(`Should escalate after iteration 3: ${iteration3.shouldEscalate}`);

console.log("\n═══ All tests complete ═══\n");
