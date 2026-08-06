import { chat, byId, canChat, listModels, type ChatRequest, type ChatResult, type Quota, type ProviderError, type RateSnapshot } from './providers.js'
import { getKey } from './secrets.js'
import { usable as usableModels, noteLiveCall, noteLiveFailure } from './models.js'

/**
 * The curator.
 *
 * Several free keys can be live at once, and they are not interchangeable:
 * one reasons well, one is fast and cheap, one can be thrown at bulk parsing
 * without a thought. Rather than pick a single "active model", every call
 * names the KIND OF WORK it is, and the router chooses.
 *
 * It also has to survive free tiers, which is mostly about rate limits. A 429
 * is not an error to surface — it is a signal to step aside and let the next
 * candidate take the work, and to stop sending that provider anything for a
 * while. Daily counts are kept so a limit can be seen coming rather than hit.
 */

export type Task =
  /** Whole-life synthesis into cards. The hardest thing the app does. */
  | 'synthesis'
  /** Deciding what it still needs to know. Hard, but shorter. */
  | 'curiosity'
  /** Turning search results into one plain fact. Easy, high volume. */
  | 'research'
  /** Replying in a card's thread. Medium, latency matters. */
  | 'chat'
  /** Connector payloads into observations. Bulk, mechanical. */
  | 'extract'

/**
 * How well each provider suits each task, 0-10. Deliberately coarse: this is
 * a preference order, not a benchmark. Measured evidence beats these numbers
 * and should replace them (see crucible-synthesis-basis-metric).
 */
const SKILL: Record<string, Partial<Record<Task, number>>> = {
  anthropic: { synthesis: 10, curiosity: 9, chat: 9, research: 7, extract: 7 },
  gemini: { synthesis: 9, curiosity: 9, chat: 8, research: 8, extract: 8 },
  openai: { synthesis: 8, curiosity: 8, chat: 8, research: 7, extract: 7 },
  xai: { synthesis: 7, curiosity: 7, chat: 7, research: 6, extract: 6 },
  groq: { synthesis: 4, curiosity: 5, chat: 7, research: 7, extract: 9 },
  openrouter: { synthesis: 6, curiosity: 6, chat: 6, research: 6, extract: 7 },
}

/**
 * There is deliberately no table of preferred model names here any more.
 *
 * There used to be: `PICK`, a hand-written heavy/cheap pair per provider. It
 * was the bug. It named two Gemini models that Google lists to every key and
 * runs for none of them on the free tier, so synthesis picked a dead model
 * first, every time, and the home feed failed before it started. A name written
 * by hand is a guess that goes stale silently — the provider ships a model, or
 * moves one between tiers, and nothing in the app notices.
 *
 * Model names now come from `server/models.ts`, which only lists what has
 * answered. See the tier selection in `candidates`.
 */

const HEAVY: Task[] = ['synthesis', 'curiosity']

/**
 * Published free-tier ceilings, for the providers that report nothing.
 *
 * Groq and OpenRouter return their remaining budget in response headers, so for
 * those this table is never consulted — the provider's own number always wins.
 * Gemini returns no rate-limit headers at all, and its daily request cap is the
 * limit that actually bites, so the only way to show anything useful is to
 * subtract what we have counted ourselves from the published ceiling.
 *
 * That makes these numbers an ESTIMATE and they are labelled as one everywhere
 * they surface. They are also the kind of number that goes stale — exactly the
 * failure mode of the model table this work removed — so they are a fallback of
 * last resort, they never override a measured value, and being wrong here
 * degrades a display rather than breaking a route.
 */
const PUBLISHED_DAILY: Record<string, Record<string, number>> = {
  gemini: {
    // Google publishes per-model RPD on the free tier; the flash family is the
    // only part of it this key can reach, so it is the only part worth stating.
    'default': 250,
    'gemini-3.6-flash': 250,
    'gemini-flash-latest': 250,
    'gemini-3.5-flash': 250,
    'gemini-flash-lite-latest': 1000,
    'gemini-3.1-flash-lite': 1000,
    'gemini-3.5-flash-lite': 1000,
  },
}

/** What we believe is left for a model, and how much that belief is worth. */
export interface Budget {
  model: string
  providerId: string
  /** Requests left in the window, or null when nothing is known. */
  requestsLeft: number | null
  requestLimit: number | null
  tokensLeft: number | null
  /** When the window resets, epoch ms, when the provider said. */
  resetsAt: number | null
  /** Our own count today, always real. */
  usedToday: number
  tokensInToday: number
  tokensOutToday: number
  /**
   * 'measured' — the provider's own headers.
   * 'modelled' — published ceiling minus our count.
   * 'unknown'  — no headers and no published figure; nothing is claimed.
   *
   * This distinction is the whole point. A modelled number presented as a
   * measured one is a fabricated statistic, and there is a standing rule
   * against reporting any figure that did not come from a real run.
   */
  basis: 'measured' | 'modelled' | 'unknown'
  /** Set when the model is resting, with the provider's reason. */
  restingUntil?: number
  why?: string
}

/**
 * The live budget picture, for every model we know of — including ones nothing
 * has called yet, which report `unknown` rather than a comfortable-looking
 * fiction.
 */
export async function budgets(): Promise<Budget[]> {
  const s = await readState()
  const day = today()
  const out: Budget[] = []

  for (const [providerId, st] of Object.entries(s)) {
    const seen = new Set([
      ...Object.keys(st.quota ?? {}),
      ...Object.keys(st.calls ?? {}),
      ...Object.keys(st.cool ?? {}),
    ])
    for (const model of seen) {
      const q = st.quota?.[model]
      const c = st.calls?.[model]
      const used = c && c.day === day ? c.requests : 0
      const published = PUBLISHED_DAILY[providerId]?.[model] ?? PUBLISHED_DAILY[providerId]?.default
      const resting = (st.cool?.[model] ?? 0) > Date.now() ? st.cool[model] : undefined

      // Headers first, always. They are the provider's own arithmetic; ours is
      // a guess that cannot see usage from anything other than this app.
      const measured = q && q.requestsLeft !== undefined
      out.push({
        model,
        providerId,
        requestsLeft: measured ? q!.requestsLeft! : published !== undefined ? Math.max(0, published - used) : null,
        requestLimit: measured ? (q!.requestLimit ?? null) : (published ?? null),
        tokensLeft: q?.tokensLeft ?? null,
        resetsAt: q?.resetsAt ?? null,
        usedToday: used,
        tokensInToday: c && c.day === day ? c.tokensIn : 0,
        tokensOutToday: c && c.day === day ? c.tokensOut : 0,
        basis: measured ? 'measured' : published !== undefined ? 'modelled' : 'unknown',
        restingUntil: resting,
        why: resting ? st.why?.[model] : undefined,
      })
    }
  }
  return out.sort((a, b) => a.providerId.localeCompare(b.providerId) || a.model.localeCompare(b.model))
}

/**
 * Which provider and model he chose in settings. The router used to ignore the
 * choice entirely and run its own hardcoded picks, so "think with this" changed
 * nothing. Injected because the choice lives in a config file on the Mac and in
 * KV on the edge, and the router must not know which.
 */
export interface ModelPrefs {
  activeProvider?: string
  models?: Record<string, string>
  /**
   * 'auto'   — Crucible picks per task, from what is answering right now.
   * 'pinned' — always start with the model he chose, whatever the task.
   *
   * Auto is the default and the interesting one: synthesis and a one-line
   * reply are not the same job, and the model that is best at one is often
   * both slower and scarcer than the right model for the other. Pinned exists
   * because "compare how sharp they are" is impossible if the router keeps
   * switching underneath you.
   */
  routing?: 'auto' | 'pinned'
}

let readPrefs: (() => Promise<ModelPrefs>) | null = null

export function setModelPrefs(read: () => Promise<ModelPrefs>): void {
  readPrefs = read
}

/**
 * What a key can actually reach, asked of the provider and cached. Without this
 * the router happily spends its whole candidate list on models that are not on
 * the plan, and reports "all providers failed" when one of them would have
 * answered. A failed lookup returns null, which means "assume nothing" — the
 * static picks are then tried as before rather than everything being filtered
 * away by a network blip.
 */
const REACHABLE_TTL = 10 * 60_000
const reachableCache = new Map<string, { at: number; models: Set<string> }>()

async function reachable(id: string, key: string): Promise<Set<string> | null> {
  const hit = reachableCache.get(id)
  if (hit && Date.now() - hit.at < REACHABLE_TTL) return hit.models
  const live = await listModels(id, key)
  if (!live?.length) return null
  const models = new Set(live)
  reachableCache.set(id, { at: Date.now(), models })
  return models
}

interface ProviderState {
  /** Calls today, for seeing a daily cap coming. */
  today: number
  day: string
  /**
   * Epoch ms until which each MODEL is rested after a 429, keyed by model.
   * Per-model rather than per-provider: on free plans the large model is
   * limited while the small one on the same key still answers.
   */
  cool: Record<string, number>
  /**
   * Why each rested model is resting, in the provider's own terms, so settings
   * can say "daily token budget spent, back in 33m" instead of "rate limited"
   * — which was true of a per-minute burst and a spent day alike, and told him
   * nothing about whether waiting would help.
   */
  why?: Record<string, string>
  /**
   * The smallest prompt each model has refused as too large, in characters.
   * "Request too large" is a fact about THIS request, not about the model:
   * the 8b model cannot take a whole-life synthesis and can take a one-line
   * chat reply all day. It used to be filed as a permanent outage, which shut
   * the model out of every task for a day because one big prompt bounced.
   */
  maxPrompt?: Record<string, number>
  /**
   * Whether each rested model is out of BUDGET or simply broken.
   *
   * Without this the screen said "every model I can reach is out of budget"
   * about a provider whose actual answer was "Provider returned error" — a
   * claim that is not merely imprecise but false, and that sends him off to
   * wait for a quota reset that has nothing to do with it.
   */
  kind?: Record<string, 'budget' | 'broken'>
  /** Consecutive failures; enough of them rests it for longer. */
  fails: number
  tokensIn: number
  tokensOut: number
  /**
   * The provider's own budget headers, per model, from the last call that
   * carried any. Free to collect — they ride along on responses we already
   * asked for — and authoritative in a way our own arithmetic never is.
   */
  quota?: Record<string, RateSnapshot>
  /**
   * What we have spent per model today, counted by us.
   *
   * This is the fallback for providers that report nothing. Gemini sends no
   * rate-limit headers at all, so the only way to say anything about its
   * remaining free-tier budget is to subtract our own usage from the published
   * ceiling — an estimate, and labelled as one wherever it is shown.
   */
  calls?: Record<string, { day: string; requests: number; tokensIn: number; tokensOut: number }>
}

export type RouterState = Record<string, ProviderState>

/**
 * Where the router's memory of rate limits lives — decided by the host, like
 * the world model and the keys before it.
 *
 * This was the one part of the brain still reaching for `node:fs` directly, and
 * it was writing to a home directory that does not exist on Cloudflare. Every
 * request there got a blank slate: a model that had just been refused was tried
 * again on the very next call, cooldowns never held, and a model shelved for
 * being off-plan came straight back. The Mac keeps this in ~/.crucible; the
 * edge keeps it in KV; neither is named here.
 */
export interface RouterStore {
  read(): Promise<RouterState | null>
  write(s: RouterState): Promise<void>
}

/**
 * Nothing installed: remember within this process and no further. Better than
 * throwing — the router still works, it just forgets between restarts.
 */
let memory: RouterState = {}
let store: RouterStore = {
  async read() { return memory },
  async write(s) { memory = s },
}

export function setRouterStore(s: RouterStore): void {
  store = s
}

/** Rate-limit bookkeeping in a single KV key. Small, hot, and rewritten often. */
export function kvRouterStore(kv: KVNamespace, key = 'router'): RouterStore {
  return {
    async read() {
      const raw = await kv.get(key)
      return raw ? (JSON.parse(raw) as RouterState) : null
    },
    async write(s) {
      await kv.put(key, JSON.stringify(s))
    },
  }
}

const today = () => new Date().toISOString().slice(0, 10)

const fresh = (): ProviderState => ({ today: 0, day: today(), cool: {}, maxPrompt: {}, fails: 0, tokensIn: 0, tokensOut: 0 })

async function readState(): Promise<RouterState> {
  try {
    return (await store.read()) ?? {}
  } catch {
    return {}
  }
}

async function writeState(s: RouterState): Promise<void> {
  // Bookkeeping must never sink the call it is recording: a failed write here
  // used to turn a SUCCESSFUL model call into a thrown error, because the note
  // sits inside the same try as the request it is describing.
  try {
    await store.write(s)
  } catch {
    /* the answer still stands; only the memory of it is lost */
  }
}

function get(s: RouterState, id: string): ProviderState {
  const cur = { ...fresh(), ...(s[id] ?? {}) }
  if (!cur.cool) cur.cool = {}
  if (!cur.maxPrompt) cur.maxPrompt = {}
  // State written before prompt size and outage were told apart shelved models
  // for a day over one oversized prompt. Those rests are wrong by construction;
  // let them go rather than making him wait out a limit that never existed.
  for (const [m, why] of Object.entries(cur.why ?? {})) {
    if (/bigger than the model takes/.test(why)) {
      delete cur.cool[m]
      delete cur.why![m]
    }
  }
  if (cur.day !== today()) {
    // New day, new allowance.
    cur.day = today()
    cur.today = 0
    cur.tokensIn = 0
    cur.tokensOut = 0
  }
  s[id] = cur
  return cur
}

export interface Candidate {
  providerId: string
  model: string
  score: number
  resting: boolean
  /** When it wakes, epoch ms. 0 when it is awake now. */
  wakesAt: number
  /** Why it is resting, in the provider's own terms. */
  why?: string
  /** Out of budget, or simply not working. */
  kind?: 'budget' | 'broken'
  /** Smallest prompt this model has refused as too big, in characters. */
  maxPrompt?: number
}

/** Everything holding a key, best-first for this task. */
export async function candidates(task: Task, preferred?: string): Promise<Candidate[]> {
  const state = await readState()
  const now = Date.now()
  const out: Candidate[] = []

  const cfg = readPrefs ? await readPrefs().catch(() => ({} as ModelPrefs)) : {}
  const pinned = cfg.routing === 'pinned'
  // Pinned makes his provider dominate; auto lets it nudge, so a task another
  // provider is plainly better at can still go there.
  const favourite = preferred ?? cfg.activeProvider
  const nudge = pinned ? 6 : 2

  for (const p of Object.keys(SKILL)) {
    const key = await getKey(p)
    if (!key) continue
    const def = byId(p)
    if (!def) continue
    const st = get(state, p)
    const base = (SKILL[p]?.[task] ?? 5) + (p === favourite ? nudge : 0)
    const wantHeavy = HEAVY.includes(task)

    /**
     * The two tiers, chosen from models that have actually answered.
     *
     * This used to read a hand-written `PICK` table, and that table is what
     * broke the app: it named `gemini-2.5-pro` and `gemini-2.5-flash`, Google
     * lists both to a free key and refuses to run either, and the catalogue
     * filter below could not tell the difference because listing and running
     * are separate facts. Now the names come from the registry, where a model
     * only appears once it has answered a real call or a probe.
     *
     * A cold registry falls back to the provider's declared default rather than
     * refusing to work — the first hunt has not run yet, and a brand-new key
     * must be able to think before it can be measured.
     */
    const verified = await usableModels(p)

    /**
     * The battery gates out broken models; it does not rank good ones.
     *
     * Four questions with known answers saturate — six Gemini models pass all
     * four — so quality alone leaves the heavy slot decided by whatever the
     * next sort key happens to be, and sorting on latency would hand whole-life
     * synthesis to the smallest, fastest model in the tie. That is the wrong
     * default for the one task where size is the whole point: the measured
     * difference between a model that chains five observations into a
     * conclusion and one that restates a single fact does not show up in a
     * trivia probe at all.
     *
     * So ties break toward capacity for heavy work — a full model over a
     * `-lite` or `-nano` variant of it — and toward latency for everything
     * else, where the work is short and waiting is the real cost.
     */
    const small = (m: { model: string }) => /lite|mini|nano|tiny|small|flash-8b/i.test(m.model)
    const byQuality = [...verified].sort(
      (a, b) =>
        b.quality - a.quality ||
        Number(small(a)) - Number(small(b)) ||
        (b.params ?? 0) - (a.params ?? 0) ||
        (a.latencyMs ?? 9e9) - (b.latencyMs ?? 9e9)
    )
    const bySpeed = [...verified].sort((a, b) => (a.latencyMs ?? 9e9) - (b.latencyMs ?? 9e9))

    const heavy = byQuality[0]?.model ?? def.defaultModel
    // The quickest model that is still worth asking. Falling straight to the
    // fastest would hand bulk extraction to whatever tiny model answers first,
    // which is fine, but hand CHAT to it too, where it reads as the app getting
    // stupider the moment it gets busy.
    const cheap =
      bySpeed.find((m) => m.quality >= 5 && m.model !== heavy)?.model ??
      bySpeed.find((m) => m.model !== heavy)?.model ??
      heavy

    const tiers: [string, number][] = wantHeavy
      ? [[heavy, base], [cheap, base - 1]]
      : [[cheap, base], [heavy, base - 2]]

    /**
     * Measured aptitude outranks the hand-set SKILL numbers.
     *
     * SKILL is a coarse preference order written by hand, and the standing note
     * on it is that evidence should replace it. This is that evidence: a model
     * that passed the reasoning probe is a better bet for synthesis than one
     * that did not, whatever its provider's reputation, and the bonus only
     * applies where a battery actually ran.
     */
    const aptBonus = (model: string): number => {
      const rec = verified.find((m) => m.model === model)
      if (!rec?.measured || !rec.aptitude) return 0
      if (wantHeavy) return rec.aptitude.reasoning ? 1.5 : -1.5
      return rec.aptitude.instruction ? 1 : -0.5
    }
    for (const t of tiers) t[1] += aptBonus(t[0])

    // Pinned: his model leads everything, and the tiers become the safety net
    // for when it will not answer. Auto: his model is one good candidate among
    // several, and the per-task skill order decides. Either way it is IN the
    // list — before this it was absent entirely and the choice did nothing.
    // A choice already saved before the picker learned to exclude classifiers
    // and embedders is still in prefs, and honouring it means failing every
    // pass forever. The saved name has to pass the same test as an offered one.
    const chosen = cfg.models?.[p]
    if (chosen && canChat(chosen)) tiers.unshift([chosen, pinned ? base + 6 : base + 1])

    const live = await reachable(p, key)
    const usable = live ? tiers.filter(([m]) => live.has(m)) : tiers
    // Everything named was stale or off-plan, but the key itself works — take
    // whatever the provider says it will answer to rather than skipping it.
    const fallback: [string, number][] =
      usable.length || !live ? [] : [[[...live][0], base - 3]]

    const seen = new Set<string>()
    for (const [model, score] of [...usable, ...fallback]) {
      if (seen.has(model)) continue
      seen.add(model)
      const wakesAt = (st.cool[model] ?? 0) > now ? st.cool[model] : 0
      out.push({
        providerId: p,
        model,
        score,
        resting: wakesAt > 0,
        wakesAt,
        why: wakesAt ? st.why?.[model] : undefined,
        kind: wakesAt ? st.kind?.[model] ?? 'broken' : undefined,
        maxPrompt: st.maxPrompt?.[model],
      })
    }
  }

  // Resting providers sink to the bottom rather than disappearing: if every
  // provider is rate-limited, trying a rested one beats failing outright.
  return out.sort((a, b) => Number(a.resting) - Number(b.resting) || b.score - a.score)
}

/**
 * How big a prompt the best available model for this task will actually take.
 *
 * The router learns each model's ceiling the hard way, from a refusal. That
 * knowledge was only ever used to SKIP a model — which meant that once every
 * awake model had bounced one oversized synthesis, the app had nothing left to
 * run and said so forever. Callers can now ask first and send something that
 * fits instead. Infinity means nothing has refused anything yet.
 */
export async function capacity(task: Task, preferred?: string): Promise<number> {
  const awake = (await candidates(task, preferred)).filter((c) => !c.resting)
  if (!awake.length) return Infinity
  return Math.max(...awake.map((c) => c.maxPrompt ?? Infinity))
}

const RATE_LIMITED = /\b429\b|rate.?limit|quota|resource.?exhausted|too many requests/i

/**
 * Failures that will not fix themselves. A provider listing a model is no
 * guarantee it will run it: some are retired but still listed, some are off
 * this key's plan. Resting those for a minute means every synthesis for the
 * rest of the day pays for them again before reaching a model that works — so
 * they step aside for the day instead.
 *
 * "Request too large" is deliberately NOT here: it is a fact about the prompt,
 * not the model, and filing it as an outage cost the app its fastest model for
 * chat because one synthesis prompt bounced off it. See TOO_LARGE.
 */
const PERMANENT =
  /no longer available|not found|does not exist|decommissioned|deprecated|unknown model|invalid model|not supported|does not support|permission|unauthorized|forbidden/i

const TOO_LARGE = /too large|too long|context length|maximum context|token limit for/i

/**
 * A quota of zero is not a rate limit — it is "this model is not on your plan",
 * wearing a 429 and a "please retry in 27s" that will never come true. Gemini
 * reports its paid tiers this way to free keys, which is how a pro model stayed
 * first in line for synthesis and failed every single pass.
 */
const NEVER_ALLOWED = /limit:\s*0\b/i

const DAY = 24 * 60 * 60_000

export interface RouteResult extends ChatResult {
  providerId: string
  model: string
  /** Providers tried and skipped before this one succeeded. */
  fellBackFrom: string[]
}

/**
 * Run a call as the right model for the job, stepping to the next candidate on
 * rate limits or transport errors. Throws only when every candidate fails.
 */
export async function route(
  task: Task,
  req: Omit<ChatRequest, 'providerId' | 'model' | 'key'>,
  opts: { preferred?: string } = {}
): Promise<RouteResult> {
  const all = await candidates(task, opts.preferred)
  if (!all.length) throw new Error('No model connected')

  // How big this particular piece of work is. A model that has already refused
  // a prompt this size will refuse it again — but it is still the right model
  // for the short jobs, so the skip is per-request, not per-model.
  const size = (req.system?.length ?? 0) + req.prompt.length
  const tooBig = (c: Candidate) => c.maxPrompt !== undefined && size >= c.maxPrompt

  /**
   * Only models that can actually take the work are called.
   *
   * Resting models used to be tried anyway, on the theory that a long shot
   * beats failing outright. It is the opposite: every one of those calls spends
   * budget to be told the budget is spent, and then REWRITES the cooldown from
   * the fresh refusal. That is why the home screen named a different model and
   * a different wait on each launch — the numbers were being regenerated by the
   * very attempt that reported them, so they never counted down. Nothing is
   * called when nothing is awake; the wait he is shown is then the one already
   * on the books, and it ticks down.
   */
  const list = all.filter((c) => !c.resting && !tooBig(c))
  if (!list.length) throw await nothingAwake(all, size)

  const fellBackFrom: string[] = []
  let lastErr: Error | null = null

  for (const c of list) {
    const key = await getKey(c.providerId)
    if (!key) continue
    try {
      const t0 = Date.now()
      const out = await chat({ ...req, providerId: c.providerId, model: c.model, key })
      await note(c.providerId, c.model, { ok: true, usage: out.usage, size, limits: out.limits })
      // Free evidence. A model that just did real work needs no probe to prove
      // it works, and this is why the registry can stay accurate on a budget
      // that could never afford to probe everything on a schedule.
      await noteLiveCall(c.providerId, c.model, Date.now() - t0)
      return { ...out, providerId: c.providerId, model: c.model, fellBackFrom }
    } catch (err) {
      const e = err as Error
      lastErr = e
      const quota = (e as ProviderError).quota
      const limited = !!quota || RATE_LIMITED.test(e.message)
      const oversize = !limited && TOO_LARGE.test(e.message)
      const permanent = NEVER_ALLOWED.test(e.message) || (!limited && !oversize && PERMANENT.test(e.message))
      const why = explain(e, quota)
      await note(c.providerId, c.model, { ok: false, limited, permanent, quota, why, oversize: oversize ? size : undefined })
      // Only a refusal that is ABOUT the model quarantines it. A rate limit or
      // an oversized prompt says nothing about whether the model works, and
      // counting either would quarantine the best model on the busiest key.
      if (!limited && !oversize) await noteLiveFailure(c.providerId, c.model, e)
      // The provider's actual reason, not the word "rate limited" for all of
      // them: a per-minute burst and a spent daily budget need different
      // answers from him, and lumping them together hid which one this was.
      const back = untilFree(quota, quota?.retryAfterMs, 0)
      fellBackFrom.push(`${c.providerId}/${c.model}: ${why}${back ? ` (back in ${humanise(back)})` : ''}`)
    }
  }
  // "All providers failed — groq/llama…: rate limited | gemini/…: rate limited"
  // was the entire home screen, and it answered none of the three questions he
  // actually has: is it broken, is it me, and when does it come back.
  throw await nothingAwake(await candidates(task, opts.preferred), size, fellBackFrom, lastErr)
}

/**
 * The one sentence the home screen gets when no model will take the work.
 *
 * Built from the cooldowns already on the books rather than from a fresh round
 * of refusals, so relaunching the app says the same thing with less time left
 * on it. Ties break by name, because "soonest" flapping between two models that
 * wake in the same second is indistinguishable from the app being confused.
 */
async function nothingAwake(
  all: Candidate[],
  size: number,
  fellBackFrom: string[] = [],
  lastErr: Error | null = null
): Promise<Error> {
  const now = Date.now()
  const resting = all
    .filter((c) => c.resting)
    .sort((a, b) => a.wakesAt - b.wakesAt || a.model.localeCompare(b.model))
  const soonest = resting[0]
  if (soonest) {
    // Only say "out of budget" when the reasons ARE budget. When a provider is
    // simply erroring, saying its quota is spent is a false statement about a
    // provider that was never rate limited — and it hides the real fault, which
    // is usually a model that cannot do the job at all.
    const budget = resting.filter((c) => c.kind === 'budget')
    const broken = resting.filter((c) => c.kind !== 'budget')
    const head =
      broken.length === 0
        ? 'Every model I can reach is out of budget right now.'
        : budget.length === 0
          ? 'No model I can reach is answering right now.'
          : `${budget.length} of my models are out of budget and ${broken.length} ${broken.length === 1 ? 'is' : 'are'} failing.`
    return new Error(
      `${head} ${soonest.providerId}/${soonest.model} is next, in ${humanise(soonest.wakesAt - now)} — ${soonest.why ?? 'no reason given'}.`
    )
  }
  // Not a budget problem: every model that is awake has already refused a
  // prompt this size. Saying "out of budget" here sent him to wait for a reset
  // that would change nothing.
  const small = all.filter((c) => !c.resting)
  if (small.length) {
    return new Error(
      `This is too much for the models I can reach — ${Math.round(size / 1000)}k of prompt, and the largest will not take it.`
    )
  }
  return new Error(`Nothing would answer — ${fellBackFrom.join(' | ') || lastErr?.message}`)
}

/**
 * How long a refusal really lasts.
 *
 * Providers answer "when does the next request succeed", not "when does this
 * budget return". Gemini says "retry in 3s" about a cap of twenty requests a
 * DAY — that 3s is its per-minute window resetting, and taking it at face value
 * meant retrying a spent daily budget every three seconds all evening. When the
 * ceiling is daily and the stated wait is implausibly short, wait for the day.
 */
const SUSPICIOUSLY_SHORT = 5 * 60_000

function untilFree(quota: Quota | undefined, stated: number | undefined, guess: number): number {
  if (quota?.daily && (!stated || stated < SUSPICIOUSLY_SHORT)) return untilTomorrow()
  return stated ?? guess
}

/** Free tiers reset on UTC midnight, which is the only reset time we can know. */
function untilTomorrow(): number {
  const now = new Date()
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  return Math.max(60_000, midnight - now.getTime())
}

/**
 * A refusal in one short phrase he could act on. Deliberately WITHOUT a time:
 * how long it lasts is kept beside it in `cool`, and every caller adds it once
 * — saying it here too produced "back in 62m — … — back in 62m".
 */
function explain(e: Error, quota?: Quota): string {
  if (!quota) {
    // Groq's version of this is 180 characters of organization id; the part
    // that matters is that the prompt does not fit.
    if (/too large/i.test(e.message)) return 'this work is bigger than the model takes'
    return e.message.length > 70 ? `${e.message.slice(0, 67)}…` : e.message
  }
  if (quota.limit === 0) return 'not included in this plan'
  if (quota.limit !== undefined && quota.used !== undefined) {
    return `${quota.what ?? 'budget'} spent (${quota.used}/${quota.limit})`
  }
  if (quota.limit !== undefined) {
    return `${quota.daily ? 'daily ' : ''}${quota.what ?? 'budget'} of ${quota.limit} reached`
  }
  return 'rate limited'
}

export function humanise(ms: number): string {
  if (ms < 90_000) return `${Math.round(ms / 1000)}s`
  if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 3_600_000)}h`
}

// `nextFree` lived here: the soonest cooldown across the WHOLE state, including
// models this task would never have used. It is gone because the answer has to
// come from the candidates for the work in hand — see nothingAwake.

async function note(
  id: string,
  model: string,
  r: {
    ok: boolean
    limited?: boolean
    permanent?: boolean
    quota?: Quota
    why?: string
    /** Prompt size, in characters, that this model refused as too big. */
    oversize?: number
    /** Prompt size of a call that succeeded, which retires a stale ceiling. */
    size?: number
    usage?: { in?: number; out?: number }
    /** Budget headers read off the response, when the provider sent any. */
    limits?: RateSnapshot
  }
) {
  const s = await readState()
  const st = get(s, id)
  st.why = st.why ?? {}
  st.maxPrompt = st.maxPrompt ?? {}
  st.kind = st.kind ?? {}
  st.quota = st.quota ?? {}
  st.calls = st.calls ?? {}
  st.today += 1

  // Per-model counting, so the ledger can say what is left for a model the
  // provider does not report headers for. Provider-level totals cannot: two
  // models on one key have separate budgets and spending one says nothing
  // about the other.
  const day = today()
  const c = st.calls[model] ?? { day, requests: 0, tokensIn: 0, tokensOut: 0 }
  if (c.day !== day) { c.day = day; c.requests = 0; c.tokensIn = 0; c.tokensOut = 0 }
  c.requests += 1
  c.tokensIn += r.usage?.in ?? 0
  c.tokensOut += r.usage?.out ?? 0
  st.calls[model] = c

  // The provider's own numbers always win over ours.
  if (r.limits) st.quota[model] = r.limits
  if (r.oversize !== undefined) {
    // Not an outage and not a failure streak — a ceiling. The model stays in
    // the running for everything smaller, which is most of what the app asks.
    st.maxPrompt[model] = Math.min(st.maxPrompt[model] ?? Infinity, r.oversize)
    await writeState(s)
    return
  }
  if (r.ok) {
    st.fails = 0
    delete st.cool[model]
    delete st.why[model]
    delete st.kind[model]
    // A prompt at least as big as the recorded ceiling just went through, so
    // the ceiling was wrong (or the provider raised it). Forget it rather than
    // shutting the model out of work it has proved it can do.
    if (r.size !== undefined && r.size >= (st.maxPrompt[model] ?? Infinity)) delete st.maxPrompt[model]
    st.tokensIn += r.usage?.in ?? 0
    st.tokensOut += r.usage?.out ?? 0
  } else if (r.permanent) {
    // Retired, off-plan, or too small for this work. Nothing about waiting
    // changes it, and it does not count as the provider being flaky.
    st.cool[model] = Date.now() + DAY
    st.kind[model] = 'broken'
    if (r.why) st.why[model] = r.why
  } else {
    st.fails += 1
    // Believe the provider over our own guess. Groq says "try again in 33m"
    // when the day's tokens are gone; resting it for the old fixed minute meant
    // thirty-three more doomed attempts, each one spending budget to be told
    // the budget was spent. A daily ceiling with no stated wait rests until
    // tomorrow rather than being retried all evening.
    const stated = r.quota?.retryAfterMs
    const guess = Math.min((r.limited ? 60_000 : 10_000) * st.fails, 15 * 60_000)
    const wait = untilFree(r.quota, stated, guess)
    st.cool[model] = Date.now() + Math.max(wait, guess)
    st.kind[model] = r.quota || r.limited ? 'budget' : 'broken'
    if (r.why) st.why[model] = r.why
  }
  await writeState(s)
}

/**
 * Wake a model up. Choosing one in settings proves it answers on this key
 * before it is saved, so any rest it was serving is stale by definition — and
 * being told "rate limited" about a model you just watched reply is how the
 * whole switch stops feeling real. Also clears the provider's failure streak,
 * which is what lengthens every subsequent backoff.
 */
export async function wake(providerId: string, model: string): Promise<void> {
  const s = await readState()
  const st = get(s, providerId)
  delete st.cool[model]
  st.fails = 0
  await writeState(s)
}

/** For the settings screen: who is connected, who is resting, what it has cost. */
export async function health(): Promise<
  {
    providerId: string
    callsToday: number
    tokensIn: number
    tokensOut: number
    restingFor: number
    restingModels: string[]
    rested: { model: string; why: string; backInMs: number }[]
    fails: number
  }[]
> {
  const s = await readState()
  const now = Date.now()
  const out = []
  for (const p of Object.keys(SKILL)) {
    if (!(await getKey(p))) continue
    const st = get(s, p)
    out.push({
      providerId: p,
      callsToday: st.today,
      tokensIn: st.tokensIn,
      tokensOut: st.tokensOut,
      restingFor: Math.max(0, Math.round((Math.max(0, ...Object.values(st.cool), 0) - now) / 1000)),
      restingModels: Object.entries(st.cool).filter(([, t]) => t > now).map(([m]) => m),
      // Why each is resting and for how long — the difference between "wait a
      // moment" and "not until tomorrow", which the UI has to be able to say.
      rested: Object.entries(st.cool)
        .filter(([, t]) => t > now)
        .map(([m, t]) => ({ model: m, why: st.why?.[m] ?? 'rate limited', backInMs: t - now })),
      fails: st.fails,
    })
  }
  return out
}
