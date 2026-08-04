// ============================================================================
// "Is this Response actually a stream?" — the check six SSE call sites were missing.
//
// Every streaming endpoint in App.tsx used to be consumed after testing `!res.body`
// and nothing else. An error response HAS a body: a JSON object. So a 403 or a 500
// was handed to the SSE parser, which looked for `data:` lines, found none, ended
// cleanly, and left the UI showing a generic stall — with the server's actual
// explanation read off the wire and thrown away.
//
// That is exactly how the locality guard's 403 (a phone reaching Crucible over the
// public tunnel instead of the LAN) presented as "sending from mobile just doesn't
// work": the server said precisely what was wrong, every time, and the UI dropped it.
//
// Returning a STRING rather than throwing is deliberate — it keeps each call site a
// two-line guard that can still surface the reason in that surface's own idiom
// (deliveryError on a chat round, verifyMessage on a verification card).
// ============================================================================

/**
 * The server's own explanation for a response that cannot be streamed, or null when
 * the response is a genuine stream and should be consumed.
 *
 * NOTE the contract callers rely on: a non-null return means `res.body` must not be
 * read, and a null return guarantees `res.body` is present. TypeScript cannot narrow
 * `res.body` through an async helper, which is why call sites assert it.
 */
export async function streamFailure(res: Response, apiBase: string): Promise<string | null> {
  if (res.ok && res.body) return null
  // A 200 with no body is not an error the server can explain, but it is still not a
  // stream — saying so beats a silent no-op.
  if (res.ok) return 'Crucible returned an empty response.'
  let detail = ''
  try {
    detail = String(((await res.json()) as { error?: unknown } | null)?.error ?? '')
  } catch { /* not JSON — fall through to the status-only message */ }
  const host = apiBase.replace(/^https?:\/\//, '')
  return detail
    ? `${detail} (HTTP ${res.status})`
    : `Crucible answered HTTP ${res.status} at ${host}.`
}
