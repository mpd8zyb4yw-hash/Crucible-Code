/**
 * WHAT A FAILURE IS ALLOWED TO SAY TO HIM.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 *
 * `src/api.ts` minted `new Error(body?.error ?? \`HTTP ${res.status}\`)` and
 * `App.tsx` appended `(e as Error).message` straight into the conversation as an
 * assistant turn. So a Cloudflare hiccup became a chat bubble reading
 *
 *     HTTP 503
 *
 * in the voice of the assistant, sitting in his transcript, persisted across
 * launches. It is hard to think of a shorter way to tell someone that the thing
 * they are talking to is not really there.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 *
 * Every failure that can reach a screen is one of a closed set of KINDS, and
 * each kind carries four things:
 *
 *     code          what went wrong, for the client to branch on
 *     message       one sentence, in the assistant's voice, safe to render
 *     retryable     whether trying again could plausibly work
 *     diagnosticId  the thread back to the real cause, which stays server-side
 *
 * The provider's own words, the HTTP status, the stack and the URL are
 * DIAGNOSTICS. They are logged against the id and never serialised to the
 * client, because there is no version of "the model returned 429 with body
 * {...}" that helps the person holding the phone.
 *
 * `retryable` is what earns the "Retry?" affordance. It is a claim about the
 * world — a timeout may pass, a spent daily quota will not — so it is decided
 * here from the cause rather than by the UI guessing from a string.
 */

/** The closed set. A failure that is none of these is `server_error`. */
export type ApiErrorCode =
  /** The provider could not be reached, or refused in a way that may pass. */
  | 'provider_unavailable'
  /** Budget or rate limit. Retrying now will fail the same way. */
  | 'provider_quota'
  /** It did not answer inside the deadline. See `providers.ts`. */
  | 'provider_timeout'
  /** It answered, and the answer was not the shape it promised. */
  | 'provider_malformed'
  /** Google, or another connected account, is unreachable or unauthorised. */
  | 'connector_unavailable'
  /** He is not signed in. The one code the client acts on structurally. */
  | 'not_signed_in'
  /** The deploy is missing secrets. Not his problem to fix, but not a bug either. */
  | 'not_configured'
  /** Everything else. Deliberately last and deliberately vague. */
  | 'server_error'

/**
 * ONE SENTENCE PER KIND, AND NONE OF THEM MENTION A PROTOCOL.
 *
 * Written to be true when read aloud by the assistant, because that is exactly
 * where they land. No status codes, no provider names, no "an error occurred" —
 * which says nothing while sounding like it said something.
 */
const SAFE: Record<ApiErrorCode, string> = {
  provider_unavailable: 'I couldn’t get an answer just now.',
  provider_quota: 'I’ve used up what I’m allowed to ask for today.',
  provider_timeout: 'That took too long to come back.',
  provider_malformed: 'I got an answer back that I couldn’t make sense of.',
  connector_unavailable: 'I couldn’t reach your account just now.',
  not_signed_in: 'You’re signed out.',
  not_configured: 'This isn’t set up yet.',
  server_error: 'Something went wrong on my side.',
}

/** Whether trying the same thing again could plausibly work. */
const RETRYABLE: Record<ApiErrorCode, boolean> = {
  provider_unavailable: true,
  provider_quota: false,
  provider_timeout: true,
  provider_malformed: true,
  connector_unavailable: true,
  not_signed_in: false,
  not_configured: false,
  server_error: true,
}

const HTTP_STATUS: Record<ApiErrorCode, number> = {
  provider_unavailable: 503,
  provider_quota: 429,
  provider_timeout: 504,
  provider_malformed: 502,
  connector_unavailable: 503,
  not_signed_in: 401,
  not_configured: 503,
  server_error: 500,
}

/** Short, unguessable, and enough to find the log line. Not a UUID; it is read aloud. */
function mintDiagnosticId(): string {
  try {
    return crypto.randomUUID().slice(0, 8)
  } catch {
    return Math.random().toString(36).slice(2, 10)
  }
}

/** The wire shape. Exactly this, and never a bare string. */
export interface ApiErrorBody {
  code: ApiErrorCode
  message: string
  retryable: boolean
  diagnosticId: string
}

export class ApiError extends Error {
  readonly code: ApiErrorCode
  readonly retryable: boolean
  readonly diagnosticId: string
  readonly status: number
  /** The real cause, for the log. NEVER serialised — see `body()`. */
  readonly detail: string

  constructor(code: ApiErrorCode, detail = '') {
    // `message` is the SAFE sentence, so that even a caller which ignores all of
    // this and prints `e.message` — which is what the client used to do — prints
    // something fit to show him. The failure mode is chosen.
    super(SAFE[code])
    this.name = 'ApiError'
    this.code = code
    this.retryable = RETRYABLE[code]
    this.status = HTTP_STATUS[code]
    this.diagnosticId = mintDiagnosticId()
    this.detail = detail
  }

  /** What crosses the wire. The detail is not in it. */
  body(): { error: ApiErrorBody } {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        diagnosticId: this.diagnosticId,
      },
    }
  }

  /** What goes in the log, where the detail belongs. */
  logLine(): string {
    return `[${this.diagnosticId}] ${this.code}: ${this.detail || '(no detail)'}`
  }
}

/** Patterns that identify a cause from a provider's own words. */
const QUOTA = /quota|rate.?limit|too many requests|429|insufficient_quota|budget/i
const TIMEOUT = /timed? ?out|abort|deadline|ETIMEDOUT|signal is aborted/i
const AUTH = /not signed in|unauthori[sz]ed|invalid_grant|token/i
const MALFORMED = /unexpected token|JSON|unparse|malformed|could not read/i
const CONNECTOR = /google|calendar|gmail|fit|youtube|connector/i

/**
 * TURN ANYTHING THROWN INTO ONE OF THE KINDS.
 *
 * Ordered most-specific first, and quota before timeout because a provider that
 * rate-limits by holding the connection open until the deadline is a quota
 * problem wearing a timeout's clothes — retrying that one immediately is exactly
 * the wrong move.
 *
 * An `ApiError` passes through unchanged: something upstream already knew more
 * about this failure than a regular expression ever will.
 */
export function classify(e: unknown): ApiError {
  if (e instanceof ApiError) return e
  const err = e as Error & { code?: string; name?: string; quota?: unknown }
  const detail = err?.message ?? String(e)

  if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') return new ApiError('provider_timeout', detail)
  if (err?.quota || QUOTA.test(detail)) return new ApiError('provider_quota', detail)
  if (TIMEOUT.test(detail)) return new ApiError('provider_timeout', detail)
  if (AUTH.test(detail)) return new ApiError('not_signed_in', detail)
  if (MALFORMED.test(detail)) return new ApiError('provider_malformed', detail)
  if (CONNECTOR.test(detail)) return new ApiError('connector_unavailable', detail)
  return new ApiError('server_error', detail)
}

/**
 * Classify, log the real cause, and hand back what may be shown.
 *
 * The one function a route should call, so that "the detail was written down"
 * and "the detail was not sent" cannot come apart.
 */
export function failure(e: unknown): ApiError {
  const api = classify(e)
  console.warn(api.logLine())
  return api
}
