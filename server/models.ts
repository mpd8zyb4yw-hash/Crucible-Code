import { chat, canChat, listModels, byId, ProviderError } from './providers.js'
import { getKey } from './secrets.js'

/**
 * The model registry.
 *
 * The router used to think with a wish list. `PICK` named two Gemini models by
 * hand, and Google happily LISTS both to a free key while refusing to run
 * either — "not included in this plan", "no longer available to new users". A
 * catalogue lookup could not catch that, because being listed and being
 * callable are different facts, and only one of them is discoverable by asking.
 * The other has to be measured.
 *
 * So nothing is trusted here until it has answered. A model enters as a
 * candidate, is probed, and either graduates to the verified set the router is
 * allowed to choose from, or is quarantined with the provider's own reason and
 * a cooldown that lengthens each time it fails again. The picker in settings
 * only ever offers verified models, so it is not possible to select something
 * broken — which is how a prompt-injection classifier once became the model the
 * whole app thought with.
 *
 * The expensive part is deliberately rare. Probing costs tokens on the same
 * free tier the app is trying to conserve, so the cheapest evidence is the kind
 * we get for nothing: a model that just answered a real request has proved
 * itself, and `noteLiveCall` records that instead of paying for a probe to
 * learn what production already knew.
 */

// ── What we keep about a model ───────────────────────────────────────────────

export type Verdict =
  /** Answered. The router may use it. */
  | 'verified'
  /** Discovered but not yet probed. Invisible to the router and the picker. */
  | 'candidate'
  /** Failed. Hidden, with the reason kept so it can still be explained. */
  | 'quarantined'

/** The kinds of work the quality battery can distinguish. */
export type Aptitude = 'reasoning' | 'factual' | 'instruction' | 'language'

export interface ModelRecord {
  providerId: string
  model: string
  /** Short human name, for the picker. */
  label: string
  verdict: Verdict
  /**
   * 0–10. Starts as an inference from the model's own name and is REPLACED by
   * the battery result the first time one runs — never averaged with it, so a
   * guess cannot dilute a measurement.
   */
  quality: number
  /** True once `quality` came from the battery rather than the name. */
  measured: boolean
  /** Which aptitudes it demonstrated. Absent until the battery has run. */
  aptitude?: Partial<Record<Aptitude, boolean>>
  /** Round-trip of the last successful call, ms. */
  latencyMs?: number
  /** Roughly how big, in billions of parameters, when the name says so. */
  params?: number
  /** When it last answered anything — a probe or a real request. */
  provenAt?: number
  /** When it was last looked at, successfully or not. */
  checkedAt?: number

  // Quarantine
  /** Consecutive HARD failures. A 429 never increments this. */
  failures?: number
  /** The provider's own words, kept verbatim so it can be shown or explained. */
  reason?: string
  /** Epoch ms before which it must not be retried. */
  until?: number
}

export interface Registry {
  models: ModelRecord[]
  /** When a full hunt last completed, per provider. */
  hunted?: Record<string, number>
}

// ── Where it lives ───────────────────────────────────────────────────────────

/**
 * Injected, like every other piece of state the brain keeps about itself: a
 * JSON file on the Mac, a KV value on the edge. The registry must not know
 * which, or `server/*` stops being shared verbatim with the Worker.
 */
export interface RegistryStore {
  read(): Promise<Registry | null>
  write(r: Registry): Promise<void>
}

let store: RegistryStore | null = null
export function setRegistryStore(s: RegistryStore): void {
  store = s
}

/** The registry as a single KV value, for the edge. */
export function kvRegistryStore(kv: KVNamespace, key = 'models'): RegistryStore {
  return {
    async read() {
      const raw = await kv.get(key)
      return raw ? (JSON.parse(raw) as Registry) : null
    },
    async write(r) {
      await kv.put(key, JSON.stringify(r))
    },
  }
}

const EMPTY: Registry = { models: [], hunted: {} }

async function read(): Promise<Registry> {
  if (!store) return { ...EMPTY }
  return (await store.read().catch(() => null)) ?? { ...EMPTY }
}

async function write(r: Registry): Promise<void> {
  if (store) await store.write(r).catch(() => {})
}

const keyOf = (providerId: string, model: string) => `${providerId}/${model}`
const find = (r: Registry, providerId: string, model: string) =>
  r.models.find((m) => m.providerId === providerId && m.model === model)

// ── Quarantine ───────────────────────────────────────────────────────────────

/**
 * How long a model sits out after failing, by how many times it has now failed
 * in a row. Rising steps rather than one fixed wait, because the two reasons a
 * model fails have very different half-lives: a transient outage clears in
 * hours, while "not included in this plan" will still be true next month and
 * re-probing it daily is just spending the free tier to relearn the same fact.
 *
 * It never becomes permanent. Providers move models between tiers all the time,
 * and a model that is off the plan today can be on it after a pricing change —
 * a registry that gave up forever would never notice.
 */
const COOLDOWN = [
  6 * 60 * 60_000,       // 6 hours
  48 * 60 * 60_000,      // 2 days
  30 * 24 * 60 * 60_000, // 30 days
  90 * 24 * 60 * 60_000, // 90 days
]

const cooldownFor = (failures: number) => COOLDOWN[Math.min(failures, COOLDOWN.length) - 1] ?? COOLDOWN[0]

/**
 * Is this refusal the model's fault?
 *
 * A rate limit says nothing about whether the model works — it says the key is
 * out of budget this minute. Counting it as a failure would quarantine the best
 * model on the busiest key, which is exactly backwards, and it is the mistake
 * that made the old per-provider cooldowns throw synthesis to a much weaker
 * model when a same-provider step-down was available.
 */
function isSoft(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? '')

  /**
   * "limit: 0" is a permanent refusal wearing a rate limit's clothes.
   *
   * Gemini returns 429 with `Please retry in 55s` for a model the free tier
   * grants ZERO requests of — gemini-2.5-pro, the pro previews, all of them.
   * The retry hint is real HTTP politeness and completely misleading: waiting
   * 55 seconds and asking again fails identically, forever, because the quota
   * is not exhausted, it never existed. Read literally this is the perfect
   * trap — every probe looks like bad luck rather than a dead model, so the
   * model is never quarantined and every hunt spends its budget rediscovering
   * that the same five models still do not work.
   *
   * A quota whose ceiling is zero is a fact about the PLAN, so it is hard.
   */
  if (/limit:\s*0\b/i.test(msg)) return false

  // Anything we could not draw a conclusion from. Never a verdict on the model.
  if (/inconclusive/i.test(msg)) return true

  if (e instanceof ProviderError) {
    if (e.quota?.retryAfterMs !== undefined) return true
    if (/rate.?limit|quota|429|too many requests|overload|capacity|timeout|temporarily/i.test(e.message)) return true
  }
  return /timeout|abort|network|fetch failed|ECONN|socket/i.test(msg)
}

/**
 * The provider's reason, short enough to show someone.
 *
 * Gemini's refusals arrive as a paragraph with four repeated metric lines and
 * two URLs. Kept whole it is unreadable in a card and useless in a settings
 * row, so the one clause that says what actually happened is lifted out.
 */
function shortReason(e: unknown): string {
  const msg = String((e as Error)?.message ?? 'would not answer')
  if (/limit:\s*0\b/i.test(msg)) {
    const model = /model:\s*([\w.-]+)/i.exec(msg)?.[1]
    return `not available on this plan${model ? ` (${model} is granted a quota of zero)` : ''}`
  }
  return msg.split('\n')[0]!.replace(/\s*For more information.*$/i, '').trim().slice(0, 180)
}

// ── Guessing, before anything is measured ────────────────────────────────────

/** Parameter count out of the model's name, when it states one. */
function paramsOf(name: string): number | undefined {
  const m = /(\d+(?:\.\d+)?)\s*b\b/i.exec(name)
  if (m) return parseFloat(m[1])
  return undefined
}

/**
 * A first guess at quality from the name alone, used only to decide what to
 * probe FIRST. It is never reported as a measurement and never survives one:
 * `measured` stays false until the battery replaces this number outright.
 */
function guessQuality(model: string): number {
  const n = model.toLowerCase()
  const p = paramsOf(n) ?? 0
  let q = 5
  if (/pro|opus|large|ultra|405b|70b/.test(n)) q = 8
  else if (/flash|sonnet|medium|mini|small|8b|7b/.test(n)) q = 6
  else if (/nano|tiny|lite|1b|3b/.test(n)) q = 4
  if (p >= 70) q = Math.max(q, 8)
  else if (p >= 30) q = Math.max(q, 7)
  else if (p > 0 && p <= 4) q = Math.min(q, 5)
  // A preview or experimental build is likelier to be withdrawn or gated, which
  // is precisely how the old hardcoded pro-preview became a dead first choice.
  if (/preview|exp|experimental|alpha|beta/.test(n)) q -= 1
  return Math.max(1, Math.min(10, q))
}

/** The bit of a model id worth showing a human. */
function labelOf(model: string): string {
  return model.replace(/^[^/]+\//, '').replace(/:free$/, '').slice(0, 44)
}

// ── The quality battery ──────────────────────────────────────────────────────

/**
 * Four questions with known answers, one per aptitude.
 *
 * These are not a benchmark and are not reported as a score out of anything
 * public — they exist to separate a model that can follow a short instruction
 * and reason about it from one that emits fluent nothing. The bat-and-ball
 * question is here because it is the cheapest known separator: a model that
 * pattern-matches rather than reasons answers 10 with total confidence.
 *
 * Kept to four, at 24 output tokens each, because every one of these is spent
 * from the same free budget the app needs for actual work.
 */
const BATTERY: { aptitude: Aptitude; prompt: string; pass: (r: string) => boolean }[] = [
  {
    aptitude: 'reasoning',
    prompt: 'A bat and ball cost $1.10 together. The bat costs $1.00 more than the ball. How many cents does the ball cost? Reply with only the number.',
    pass: (r) => /(^|\D)5(\D|$)/.test(r.trim()) && !/10/.test(r),
  },
  {
    aptitude: 'factual',
    prompt: 'What is the chemical symbol for gold? Reply with only the symbol.',
    pass: (r) => /^\W*au\b/i.test(r.trim()),
  },
  {
    aptitude: 'instruction',
    prompt: 'Reply with exactly the word CRUCIBLE in uppercase and nothing else.',
    pass: (r) => /^\W*CRUCIBLE\W*$/.test(r.trim()),
  },
  {
    aptitude: 'language',
    prompt: 'Translate to Italian: "the kettle is on the stove". Reply with only the translation.',
    pass: (r) => /bollitore|teiera/i.test(r) && /fornello|stufa|cucina/i.test(r),
  },
]

/**
 * How much room a probe gives the model to answer. Generous on purpose.
 *
 * The first version asked for four tokens, on the reasoning that "ok" is one
 * token and anything more is waste. It quarantined every good model Google
 * has. Modern Gemini models THINK before they speak, and the thinking comes
 * out of the same output budget: asked for "ok" with a four-token ceiling,
 * gemini-3.6-flash spends one token thinking, hits MAX_TOKENS, and returns
 * empty text — measured directly against the API, where the same prompt with
 * 256 tokens returns "ok" after spending 75 tokens thinking. So the probe was
 * starving the model and then blaming it, and the registry duly hid the single
 * best synthesis model available on the strength of it.
 *
 * The real cost is unchanged: a model that answers in one token is still
 * billed for the one token plus its thoughts. The ceiling is a ceiling, not a
 * spend, and it has to sit above the thinking budget or the answer never
 * arrives.
 */
const PROBE_MAX_TOKENS = 512

/** The whole battery shares one deadline, so one hanging model cannot stall a hunt. */
const BATTERY_BUDGET_MS = 40_000
const LIVENESS_TIMEOUT_MS = 20_000
/** A model this slow on a one-word answer will not survive a real synthesis prompt. */
const MAX_LATENCY_MS = 18_000

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ])
}

/**
 * Does it answer at all? One call, four tokens — the cheapest possible question.
 *
 * Returns the latency on success, or throws so the caller can tell a hard
 * refusal ("not on this plan") from a soft one ("try again in 40 seconds").
 */
async function liveness(providerId: string, model: string, key: string): Promise<number> {
  const t0 = Date.now()
  const out = await withTimeout(
    chat({ providerId, model, key, prompt: 'Reply with: ok', maxTokens: PROBE_MAX_TOKENS }),
    LIVENESS_TIMEOUT_MS
  )
  /**
   * Silence is inconclusive, so it must not be a hard failure.
   *
   * An empty reply is much more likely to be something about how we asked —
   * a token ceiling, a safety filter, a model that only speaks through a
   * different API — than proof the model is broken. Quarantining on it is how
   * a probe bug becomes a permanent verdict on a model that works fine. Thrown
   * as a soft error so the model keeps whatever standing it already had.
   */
  if (!out.text.trim()) throw new ProviderError('answered with nothing — inconclusive, will retry', {})
  return Date.now() - t0
}

async function battery(
  providerId: string,
  model: string,
  key: string
): Promise<{ quality: number; aptitude: Partial<Record<Aptitude, boolean>> }> {
  const aptitude: Partial<Record<Aptitude, boolean>> = {}
  const deadline = Date.now() + BATTERY_BUDGET_MS
  let asked = 0
  let passed = 0

  for (const probe of BATTERY) {
    const left = deadline - Date.now()
    if (left < 1500) break
    try {
      const out = await withTimeout(
        chat({ providerId, model, key, prompt: probe.prompt, maxTokens: PROBE_MAX_TOKENS }),
        left
      )
      asked++
      const ok = probe.pass(out.text)
      aptitude[probe.aptitude] = ok
      if (ok) passed++
    } catch (e) {
      // A rate limit mid-battery is not a wrong answer. Stop rather than score
      // the model on the two questions it happened to get in before the cap.
      if (isSoft(e)) break
      asked++
      aptitude[probe.aptitude] = false
    }
  }

  // Nothing was actually asked, so there is nothing to report. The caller keeps
  // the name-based guess and `measured` stays false rather than a 0 being
  // written as though it were evidence.
  if (asked === 0) return { quality: -1, aptitude: {} }

  // 3–10, so a model that passes nothing is still usable as a last resort
  // rather than being scored below the guess floor and never tried again.
  return { quality: 3 + Math.round((passed / asked) * 7), aptitude }
}

// ── Recording what happened ──────────────────────────────────────────────────

/**
 * A real request just succeeded on this model.
 *
 * This is the free evidence path, and the reason a hunt does not have to be
 * frequent: production traffic proves models continuously and at no extra cost.
 * It also un-quarantines — if a model the registry had written off answers a
 * live request, the registry was wrong and should say so immediately.
 */
export async function noteLiveCall(providerId: string, model: string, latencyMs?: number): Promise<void> {
  const r = await read()
  let rec = find(r, providerId, model)
  if (!rec) {
    rec = blank(providerId, model)
    r.models.push(rec)
  }
  rec.verdict = 'verified'
  rec.provenAt = Date.now()
  rec.checkedAt = Date.now()
  if (latencyMs !== undefined) rec.latencyMs = latencyMs
  rec.failures = 0
  delete rec.reason
  delete rec.until
  await write(r)
}

/**
 * A real request just failed on this model.
 *
 * Soft failures are recorded but do not count toward quarantine — the router's
 * own per-model cooldown already handles resting a rate-limited model, and
 * that is a different mechanism with a different lifetime.
 */
export async function noteLiveFailure(providerId: string, model: string, e: unknown): Promise<void> {
  if (isSoft(e)) return
  const r = await read()
  let rec = find(r, providerId, model)
  if (!rec) {
    rec = blank(providerId, model)
    r.models.push(rec)
  }
  quarantine(rec, shortReason(e))
  await write(r)
}

function blank(providerId: string, model: string): ModelRecord {
  return {
    providerId,
    model,
    label: labelOf(model),
    verdict: 'candidate',
    quality: guessQuality(model),
    measured: false,
    params: paramsOf(model),
  }
}

function quarantine(rec: ModelRecord, reason: string): void {
  rec.failures = (rec.failures ?? 0) + 1
  rec.verdict = 'quarantined'
  rec.reason = reason.slice(0, 200)
  rec.until = Date.now() + cooldownFor(rec.failures)
  rec.checkedAt = Date.now()
}

// ── What the rest of the app is allowed to see ───────────────────────────────

/**
 * The models the router may choose and the picker may offer.
 *
 * A quarantined model whose cooldown has expired comes back as a candidate
 * rather than staying hidden, so the set repairs itself without anyone running
 * a hunt by hand.
 */
export async function usable(providerId?: string): Promise<ModelRecord[]> {
  const r = await read()
  const now = Date.now()
  return r.models
    .filter((m) => !providerId || m.providerId === providerId)
    .filter((m) => canChat(m.model))
    .filter((m) => m.verdict === 'verified' || (m.verdict === 'quarantined' && (m.until ?? 0) <= now))
    .sort((a, b) => b.quality - a.quality || (a.latencyMs ?? 9e9) - (b.latencyMs ?? 9e9))
}

/**
 * Everything, including what is hidden and why.
 *
 * Nothing in the UI navigates to this — it is what the assistant consults when
 * it is asked a question about itself. "Why did gemini-2.5-pro disappear" has a
 * real answer sitting in `reason` and `until`, and the alternative to exposing
 * it is either a hardcoded question-matcher or a model inventing a plausible
 * story about its own internals.
 */
export async function snapshot(): Promise<Registry> {
  return read()
}

// ── The hunt ─────────────────────────────────────────────────────────────────

/**
 * How many models to probe in one hunt, across all providers.
 *
 * Small on purpose. OpenRouter alone lists thousands, and a hunt that probed
 * even the free subset would spend a day's Gemini allowance learning about
 * models it will never route to. The registry gets better a few models at a
 * time, every hunt, forever — and production traffic does the rest for free.
 */
const PROBE_BUDGET = 6
/** Of those, how many earn the full battery rather than just a liveness call. */
const BATTERY_BUDGET = 3
/** Don't re-hunt a provider more often than this. */
const HUNT_INTERVAL_MS = 6 * 60 * 60_000
/** Re-prove a verified model that production hasn't exercised in this long. */
const STALE_MS = 7 * 24 * 60 * 60_000

export interface HuntReport {
  probed: number
  verified: string[]
  quarantined: { model: string; reason: string }[]
  discovered: number
  skipped: string[]
}

/**
 * Find out what actually works, and write it down.
 *
 * Order matters more than volume here. Anything never probed goes first,
 * because an unknown model is the only kind that can turn out to be better than
 * what we have; then verified models that production has not touched in a week,
 * because a registry that never rechecks is just a slower kind of hardcoding;
 * and expired quarantines last, since they have already disappointed us once.
 */
export async function hunt(opts: { providerId?: string; force?: boolean } = {}): Promise<HuntReport> {
  const r = await read()
  const now = Date.now()
  const report: HuntReport = { probed: 0, verified: [], quarantined: [], discovered: 0, skipped: [] }
  r.hunted ??= {}

  const ids = opts.providerId ? [opts.providerId] : ['gemini', 'groq', 'openrouter', 'anthropic', 'openai', 'xai']
  const keys = new Map<string, string>()

  // ── Discovery: ask each key what it can reach, and file anything new.
  for (const id of ids) {
    const key = await getKey(id)
    if (!key) continue
    keys.set(id, key)
    if (!opts.force && now - (r.hunted[id] ?? 0) < HUNT_INTERVAL_MS) {
      report.skipped.push(`${id}: hunted recently`)
      continue
    }
    const live = await listModels(id, key)
    if (!live?.length) {
      report.skipped.push(`${id}: catalogue unavailable`)
      continue
    }
    r.hunted[id] = now

    for (const model of live) {
      if (!canChat(model)) continue
      if (find(r, id, model)) continue
      r.models.push(blank(id, model))
      report.discovered++
    }

    /**
     * A model that vanished from the catalogue is gone, not broken.
     *
     * Keeping it as `verified` would leave the router choosing a name the
     * provider no longer answers to — the exact failure this file exists to
     * prevent, arrived at from the opposite direction.
     */
    const still = new Set(live)
    for (const m of r.models) {
      if (m.providerId !== id || still.has(m.model)) continue
      if (m.verdict === 'quarantined') continue
      m.verdict = 'quarantined'
      m.reason = 'withdrawn from the provider’s catalogue'
      m.until = now + COOLDOWN[2]
      m.checkedAt = now
    }
  }

  // ── Selection: who gets probed with the budget we have.
  const due = (m: ModelRecord): number | null => {
    if (!keys.has(m.providerId)) return null
    if (m.verdict === 'candidate') return 0
    if (m.verdict === 'quarantined') return (m.until ?? 0) <= now ? 2 : null
    if (m.verdict === 'verified') {
      if (now - (m.provenAt ?? 0) > STALE_MS) return 1
      /**
       * Verified but never measured — its quality is still a guess made from
       * its name, and quality is what the router sorts on. Without this rank a
       * model that got in on a liveness call while the battery budget was
       * already spent would keep that guess permanently, and the hunt would
       * report nothing left to do while the most important number in the
       * registry was still an inference from a string.
       */
      if (!m.measured) return 3
      return null
    }
    return null
  }

  const queue = r.models
    .map((m) => ({ m, rank: due(m) }))
    .filter((x): x is { m: ModelRecord; rank: number } => x.rank !== null)
    // Within a rank, try the most promising first: on a budget of six, the
    // order decides which models the app actually ends up able to think with.
    .sort((a, b) => a.rank - b.rank || b.m.quality - a.m.quality)
    .slice(0, PROBE_BUDGET)

  let batteriesLeft = BATTERY_BUDGET

  for (const { m } of queue) {
    const key = keys.get(m.providerId)!
    report.probed++
    m.checkedAt = now

    let latency: number
    try {
      latency = await liveness(m.providerId, m.model, key)
    } catch (e) {
      if (isSoft(e)) {
        // Out of budget or briefly unwell. It keeps whatever standing it had —
        // resting is the router's job and has nothing to do with quarantine.
        report.skipped.push(`${m.model}: ${shortReason(e)}`)
        continue
      }
      quarantine(m, shortReason(e))
      report.quarantined.push({ model: m.model, reason: m.reason! })
      continue
    }

    if (latency > MAX_LATENCY_MS) {
      quarantine(m, `too slow to be useful (${Math.round(latency / 1000)}s for four tokens)`)
      report.quarantined.push({ model: m.model, reason: m.reason! })
      continue
    }

    m.verdict = 'verified'
    m.latencyMs = latency
    m.provenAt = now
    m.failures = 0
    delete m.reason
    delete m.until
    report.verified.push(m.model)

    // The battery is the expensive half, so it is spent on models that could
    // plausibly do the hard work — there is no point measuring the reasoning of
    // something we would only ever hand bulk extraction to.
    if (batteriesLeft > 0 && !m.measured && m.quality >= 5) {
      batteriesLeft--
      const { quality, aptitude } = await battery(m.providerId, m.model, key)
      if (quality >= 0) {
        m.quality = quality
        m.aptitude = aptitude
        m.measured = true
      }
    }
  }

  await write(r)
  return report
}

/**
 * Make sure there is something to think with, right now.
 *
 * Called before the first synthesis on a cold registry. Without it the very
 * first `think()` after adding a key has nothing verified to choose from and
 * falls back to guesses — which is how this whole class of bug started.
 */
export async function ensureVerified(providerId: string): Promise<ModelRecord[]> {
  const have = await usable(providerId)
  if (have.some((m) => m.verdict === 'verified')) return have
  await hunt({ providerId, force: true })
  return usable(providerId)
}
