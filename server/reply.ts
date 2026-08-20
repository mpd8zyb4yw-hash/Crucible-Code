import { parseLoose } from './think.js'

/**
 * THE BOUNDARY BETWEEN A PROVIDER'S BYTES AND WHAT HE READS.
 *
 * A screenshot showed this in his chat, as an ordinary assistant message:
 *
 *     { "reply": "I don't have the address or restaurant name for your event
 *
 * That is the model's structured-output contract, cut off at the token limit
 * and rendered as prose. It was not a rendering bug — the renderer drew exactly
 * what it was given. `say()` did this:
 *
 *     const reply = String(parsed?.reply ?? out.text ?? '')
 *
 * `parsed` is null whenever `parseLoose` cannot repair the JSON, and the
 * commonest way for it to fail is truncation MID-STRING, which is precisely the
 * case where `out.text` is a half-written protocol envelope. So the fallback
 * for "the contract was broken" was "show him the contract".
 *
 * The rule this file exists to make structural: THE RAW PROVIDER RESPONSE IS
 * NEVER A USER-FACING STRING. It is a thing to be parsed, salvaged, or
 * reported as a failure — never displayed. Four steps, in order, each one
 * cheaper than the one below it:
 *
 *   1  parse            the envelope arrived intact. Take the field.
 *   2  salvage          the envelope is truncated but the human sentence
 *                       inside it is readable. Take the sentence, not the JSON.
 *   3  pass through     the model ignored the shape and simply talked. That is
 *                       usable prose and there is no reason to discard it.
 *   4  refuse           it is protocol, and it is broken. Say so in one line.
 *
 * Step 3 is the one that needs the care: "not JSON" and "safe to show" are
 * different questions, and answering the first as if it were the second is how
 * the leak happens. `looksLikeProtocol` is the second question.
 */

export interface ParsedReply {
  /** Safe to render. Never contains protocol syntax. */
  text: string
  /** The envelope, when there was one. Null when nothing parsed. */
  envelope: Record<string, unknown> | null
  /** How the text was arrived at — recorded, so silent salvage is visible. */
  via: 'parse' | 'salvage' | 'prose' | 'refused'
}

/**
 * What we say when the response cannot be turned into anything he should read.
 *
 * Recoverable and specific enough to act on, with no internals in it. The
 * surface he was looking at is untouched — a failed parse must not also cost
 * him the screen.
 */
const REFUSAL = 'That answer came back malformed — say it again and I’ll retry.'

/**
 * Does this text carry machine syntax he must never be shown?
 *
 * Deliberately generous. A false positive costs one retry; a false negative is
 * the bug this whole file exists for.
 */
export function looksLikeProtocol(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  // A structured envelope, whole or partial.
  if (/^[[{]/.test(t)) return true
  // A fenced code block whose language is a data format — the model wrapping
  // its answer rather than giving it.
  if (/```\s*(json|jsonc|yaml|xml)?\s*[[{]/i.test(t)) return true
  // Our own contract's keys, quoted, anywhere in the text.
  if (/"(reply|action|ui|op|surface|args|intent|kind)"\s*:/.test(t)) return true
  // Tool-call syntax from any of the providers.
  if (/<\/?(tool|function|antml:invoke|invoke|parameter)\b/i.test(t)) return true
  if (/"type"\s*:\s*"(tool_use|function_call|tool_result)"/.test(t)) return true
  return false
}

/**
 * Pull the human sentence out of a truncated envelope.
 *
 * `parseLoose` repairs JSON that was cut between values; it cannot repair JSON
 * cut in the MIDDLE of a string, because there is no way to know whether the
 * missing tail changes the meaning. For our purposes there is: the field is a
 * sentence, a sentence cut short is still readable, and the alternative on the
 * table is showing him the brace. So this reads the string value by hand,
 * accepting an unterminated one, and marks it as salvaged.
 */
export function salvageField(text: string, field: string): string | null {
  const key = new RegExp(`"${field}"\\s*:\\s*"`)
  const m = key.exec(text)
  if (!m) return null

  let out = ''
  let esc = false
  for (let i = m.index + m[0].length; i < text.length; i++) {
    const ch = text[i]
    if (esc) {
      out += ch === 'n' ? '\n' : ch === 't' ? '\t' : ch === 'r' ? '\r'
        : ch === 'u' ? String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16) || 0) : ch
      if (ch === 'u') i += 4
      esc = false
      continue
    }
    if (ch === '\\') { esc = true; continue }
    // A real closing quote ends the value; running off the end does too, and
    // that is the truncation case this exists for.
    if (ch === '"') break
    out += ch
  }
  const trimmed = out.trim()
  if (!trimmed) return null
  // A salvaged sentence that is itself protocol is not a salvage.
  return looksLikeProtocol(trimmed) ? null : trimmed
}

/**
 * Raw provider text → something it is safe to render.
 *
 * `field` is the envelope key holding the human part. Everything else in the
 * envelope is returned separately for the caller to validate on its own terms;
 * this function's single responsibility is that `text` is never protocol.
 */
export function humanReply(raw: string, field = 'reply'): ParsedReply {
  const text = String(raw ?? '')

  // 1. The envelope arrived.
  let envelope: Record<string, unknown> | null = null
  try {
    const p = parseLoose(text)
    if (p && typeof p === 'object' && !Array.isArray(p)) envelope = p as Record<string, unknown>
  } catch {
    /* step 2 */
  }
  if (envelope) {
    const v = envelope[field]
    if (typeof v === 'string' && v.trim() && !looksLikeProtocol(v)) {
      return { text: v.trim(), envelope, via: 'parse' }
    }
  }

  // 2. Truncated mid-sentence. The sentence is still his answer.
  const salvaged = salvageField(text, field)
  if (salvaged) return { text: salvaged, envelope, via: 'salvage' }

  // 3. The model ignored the shape and just talked. That is a usable answer,
  //    and discarding it would be throwing away the thing he asked for.
  if (!looksLikeProtocol(text)) {
    const prose = stripFence(text).trim()
    if (prose) return { text: prose, envelope, via: 'prose' }
  }

  // 4. Protocol, and broken. He gets a sentence; the bytes stay here.
  return { text: REFUSAL, envelope, via: 'refused' }
}

/** Markdown fencing around otherwise ordinary prose. */
function stripFence(text: string): string {
  const m = /^\s*```[a-z]*\s*\n([\s\S]*?)\n?\s*```\s*$/i.exec(text)
  return m ? m[1] : text
}
