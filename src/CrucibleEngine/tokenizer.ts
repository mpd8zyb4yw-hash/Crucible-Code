// ============================================================
// CRUCIBLE — Structural Tokenizer
// Converts source code into normalized structural tokens
// for comparison. No external AST deps — pattern-based.
// Fast, deterministic, runs entirely on-device.
// ============================================================

// Token signatures we extract from source.
// These describe structural intent, not syntax details.
const STRUCTURAL_PATTERNS: Array<{ token: string; patterns: RegExp[] }> = [
  // Cache / memoization structures
  { token: "cache-map",          patterns: [/new Map\(\)/, /\{\s*\}.*cache/i, /cache\s*=\s*\{/, /memo\s*=\s*new/i] },
  { token: "cache-lookup-first", patterns: [/cache\.has\(/, /cache\[.*\]\s*!==\s*undefined/, /if\s*\(.*in\s+cache\)/] },
  { token: "store-result",       patterns: [/cache\.set\(/, /cache\[.*\]\s*=/, /memo\[.*\]\s*=/] },

  // Sorting / search structures
  { token: "sorted-check",       patterns: [/sorted/i, /\.sort\(/, /isSorted/i] },
  { token: "mid-index",          patterns: [/Math\.floor.*\/\s*2/, /mid\s*=/, /middle\s*=/, />> 1/] },
  { token: "compare-pivot",      patterns: [/\[\s*mid\s*\]/, /arr\[mid\]/, /pivot/i] },
  { token: "recurse-or-return",  patterns: [/return.*recursive|recursive.*return/i, /low\s*=\s*mid/, /high\s*=\s*mid/] },

  // Timer / debounce structures
  { token: "timer-ref",          patterns: [/timeoutId/, /timerId/, /timerRef/, /setTimeout.*=/, /useRef.*null/] },
  { token: "clear-on-call",      patterns: [/clearTimeout/, /clearInterval/] },
  { token: "set-timeout",        patterns: [/setTimeout\(/, /setInterval\(/] },
  { token: "execute-after-delay",patterns: [/delay\s*=/, /wait\s*=/, /ms\s*=/, /debounceTime/i] },

  // Observer / pub-sub structures
  { token: "subscriber-list",    patterns: [/subscribers\s*=/, /listeners\s*=/, /handlers\s*=/, /new Set\(\)/, /new Map\(\)/] },
  { token: "subscribe-method",   patterns: [/subscribe\s*\(/, /on\s*\(/, /addEventListener\s*\(/, /addListener\s*\(/] },
  { token: "unsubscribe-method", patterns: [/unsubscribe\s*\(/, /off\s*\(/, /removeEventListener\s*\(/, /return.*\(\)\s*=>/] },
  { token: "notify-all",         patterns: [/forEach.*emit|emit.*forEach/, /subscribers\.forEach/, /listeners\.forEach/, /\.emit\(/] },

  // Command pattern structures
  { token: "execute-method",     patterns: [/execute\s*\(\)/, /\.execute\(/, /run\s*\(\)/] },
  { token: "undo-method",        patterns: [/undo\s*\(\)/, /\.undo\(/, /revert\s*\(\)/] },
  { token: "command-interface",  patterns: [/interface.*Command/, /type.*Command\s*=/, /implements.*Command/] },
  { token: "command-history",    patterns: [/history\s*=\s*\[/, /stack\s*=\s*\[/, /commandHistory/, /undoStack/] },

  // Strategy pattern structures
  { token: "strategy-interface", patterns: [/interface.*Strategy/, /type.*Strategy\s*=/, /Strategy\s*{/] },
  { token: "set-strategy",       patterns: [/setStrategy\s*\(/, /strategy\s*=/, /this\.strategy/] },
  { token: "context-delegates",  patterns: [/strategy\.(execute|run|handle|process)\(/, /this\.strategy\./] },

  // Error handling structures
  { token: "ok-variant",         patterns: [/\{\s*ok:\s*true/, /Ok\(/, /success:\s*true/, /type:\s*['"]ok['"]/] },
  { token: "err-variant",        patterns: [/\{\s*ok:\s*false/, /Err\(/, /error:/, /type:\s*['"]err['"]/] },
  { token: "discriminated-union", patterns: [/type\s+Result/, /\|\s*\{.*ok:/, /discriminant/, /tag:/] },
  { token: "pattern-match-result", patterns: [/if.*\.ok\b/, /\.isOk\(\)/, /match\(.*ok/, /switch.*\.type/] },

  // Retry / backoff structures
  { token: "retry-count",        patterns: [/attempt\s*=/, /retries\s*=/, /retryCount/, /attempts\s*</] },
  { token: "exponential-delay",  patterns: [/Math\.pow\(2/, /2\s*\*\*\s*attempt/, /delay\s*\*=\s*2/, /backoff/i] },
  { token: "jitter",             patterns: [/Math\.random\(\)/, /jitter/, /randomize/i] },
  { token: "max-attempts",       patterns: [/maxAttempts/, /maxRetries/, /MAX_RETRIES/, /maxTries/] },
  { token: "non-retryable-check", patterns: [/nonRetryable/, /isRetryable/, /retryable\s*=\s*false/, /status\s*===\s*4/] },

  // Concurrency structures
  { token: "active-count",       patterns: [/activeCount/, /running\s*=/, /inFlight/, /concurrentCount/] },
  { token: "max-concurrency",    patterns: [/maxConcurrent/, /concurrencyLimit/, /MAX_CONCURRENT/, /poolSize/] },
  { token: "on-complete-dequeue", patterns: [/\.finally\(/, /then.*next/, /dequeue\(\)/, /processNext\(\)/] },

  // Circuit breaker states
  { token: "closed-state",       patterns: [/['"]closed['"]/, /state\s*=\s*['"]closed['"]/, /CLOSED/, /isClosed/] },
  { token: "open-state",         patterns: [/['"]open['"]/, /state\s*=\s*['"]open['"]/, /OPEN\b/, /isOpen/] },
  { token: "half-open-state",    patterns: [/['"]half-open['"]/, /halfOpen/, /HALF_OPEN/, /probing/i] },
  { token: "failure-threshold",  patterns: [/failureThreshold/, /maxFailures/, /FAILURE_THRESHOLD/, /failCount\s*>/] },
  { token: "reset-timeout",      patterns: [/resetTimeout/, /resetAfter/, /recoverAfter/, /openTimeout/] },

  // Event sourcing structures
  { token: "event-log",          patterns: [/eventLog/, /eventStore/, /events\s*:\s*Event/, /appendEvent/] },
  { token: "append-only",        patterns: [/push\(.*event\)/, /append\(/, /\.push\(new/, /immutable.*log/i] },
  { token: "replay-from-origin", patterns: [/replay\(/, /reduce.*events/, /events\.reduce/, /applyEvent/] },
  { token: "derived-state",      patterns: [/getState.*reduce/, /computeState/, /deriveState/, /currentState.*replay/] },

  // Virtualisation structures
  { token: "visible-window",     patterns: [/visibleItems/, /visibleRange/, /startIndex.*endIndex/, /windowSize/] },
  { token: "item-height",        patterns: [/itemHeight/, /rowHeight/, /ITEM_HEIGHT/, /estimatedSize/] },
  { token: "offset-translate",   patterns: [/translateY\(/, /transform.*offset/, /top:\s*offset/, /paddingTop.*offset/] },
  { token: "scroll-listener",    patterns: [/onScroll/, /scroll.*handler/, /addEventListener.*scroll/, /useScroll/] },

  // Security / sanitisation structures
  { token: "validate-type",      patterns: [/typeof.*=== ['"]string['"]/, /instanceof/, /schema\.parse/, /zod\.|yup\./] },
  { token: "sanitize-content",   patterns: [/sanitize\(/, /DOMPurify/, /escape\(/, /strip.*html/i, /xss/i] },
  { token: "escape-output",      patterns: [/encodeURI/, /escapeHtml/, /htmlspecialchars/, /\.replace.*[<>&]/] },
  { token: "allowlist-not-denylist", patterns: [/allowlist|whitelist/, /allowed\s*=\s*\[/, /permitted/i, /allowedTags/] },
];

// Antipattern signatures — things that should NOT be present
const ANTIPATTERN_PATTERNS: Array<{ name: string; pattern: RegExp; severity: "blocking" | "major" | "minor" }> = [
  { name: "linear-scan-on-sorted",     pattern: /\.find\(|\.indexOf\(|\.findIndex\(/,                    severity: "major" },
  { name: "unbounded-cache",           pattern: /new Map\(\)|cache\s*=\s*\{\}/,                          severity: "minor" },
  { name: "missing-cleanup",           pattern: /setTimeout(?![\s\S]{0,200}clearTimeout)/,              severity: "major" },
  { name: "memory-leak-no-unsubscribe",pattern: /addEventListener(?![\s\S]{0,300}removeEventListener)/, severity: "major" },
  { name: "swallowed-error",           pattern: /catch\s*\([^)]*\)\s*\{\s*\}/,                          severity: "blocking" },
  { name: "no-jitter",                 pattern: /retry|backoff(?![\s\S]{0,100}random)/i,                severity: "minor" },
  { name: "infinite-retry",            pattern: /while\s*\(true\).*retry|retry.*while\s*\(true\)/is,    severity: "blocking" },
  { name: "trust-client-input",        pattern: /innerHTML\s*=\s*.*req\.|innerHTML\s*=\s*.*user/i,       severity: "blocking" },
  { name: "render-all-items",          pattern: /\.map\(.*=>\s*<.*\/>\s*\)(?![\s\S]{0,50}slice|filter)/, severity: "major" },
  { name: "promise-all-unbounded",     pattern: /Promise\.all\(.*\.map\(/,                              severity: "minor" },
];

export interface TokenizationResult {
  structuralTokens: string[];
  detectedAntipatterns: Array<{ name: string; severity: "blocking" | "major" | "minor" }>;
  lineCount: number;
  hasAsyncAwait: boolean;
  hasErrorHandling: boolean;
  hasTypeAnnotations: boolean;
}

export function tokenizeSource(source: string): TokenizationResult {
  const structuralTokens: string[] = [];
  const detectedAntipatterns: Array<{ name: string; severity: "blocking" | "major" | "minor" }> = [];

  // Extract structural tokens
  for (const { token, patterns } of STRUCTURAL_PATTERNS) {
    const found = patterns.some((p) => p.test(source));
    if (found) structuralTokens.push(token);
  }

  // Detect antipatterns
  for (const { name, pattern, severity } of ANTIPATTERN_PATTERNS) {
    if (pattern.test(source)) {
      detectedAntipatterns.push({ name, severity });
    }
  }

  return {
    structuralTokens,
    detectedAntipatterns,
    lineCount: source.split("\n").length,
    hasAsyncAwait: /\basync\b/.test(source) || /\bawait\b/.test(source),
    hasErrorHandling: /try\s*\{/.test(source) || /\.catch\(/.test(source) || /Result|Either/.test(source),
    hasTypeAnnotations: /:\s*(string|number|boolean|void|never|unknown|any)\b/.test(source) || /interface |type /.test(source),
  };
}

// Jaccard similarity between two token sets
export function tokenSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter((t) => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  return intersection / union;
}
