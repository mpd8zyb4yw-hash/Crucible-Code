// ── A draft that ships with "[Your Name]" is not finished (cont.120) ──────────
//
// Live report, 2026-07-29: the assistant drafted a reply ending
//
//     Best regards,
//
//     [Your Name]
//
// and the user's note was "it doesn't have the name to add at the bottom". That placeholder is
// the reason the draft could not simply be approved — it made a human edit mandatory before a
// send, which is precisely the work the assistant was asked to do.
//
// It is also a small instance of a general defect: an artifact containing an UNFILLED SLOT is not
// a finished artifact, and shipping one is the same class of false-green as claiming a file was
// written. A model emits these because a generic letter template has one; the system knows who
// the user is and can simply fill it in.
//
// TWO OUTCOMES, both better than the placeholder:
//
//   * We know the name → substitute it. The draft is signed and ready to send.
//   * We do not → remove the placeholder line entirely. "Best regards," with nothing after it
//     reads as an unfinished thought; "Best regards,\n\n[Your Name]" reads as a form the user
//     has to fill in. Neither is ideal, but only one of them can be sent as-is, so the sign-off
//     is kept and the bracket dropped.
//
// PURE. No I/O, no model — the caller supplies the name. That keeps it testable against the exact
// strings that shipped, which is the only reason this class of bug is ever noticed.

// ── Two tiers, because "[name]" is not always a signature ────────────────────
//
// The bench caught the naive single pattern rewriting real content:
//
//     "The variable [name] in the config refers to the service name."
//
// A bare `[name]` is a perfectly ordinary thing to write inside a sentence, and substituting the
// user's name into it corrupts the draft. So the discriminator is not a longer word list — it is
// POSITION. A signature slot stands alone on its own line; a prose reference sits inside a
// sentence. That distinction is structural and needs no vocabulary at all.

/**
 * Phrases that can only ever mean the sender: safe anywhere in the text, including mid-sentence
 * ("please reply to [Your Name] directly"). Bracketed, because prose does not bracket its nouns.
 */
const EXPLICIT_PLACEHOLDER =
  /[[<{]{1,2}\s*(?:your\s+name(?:\s+here)?|your\s+full\s+name|full\s+name|sender(?:'s)?(?:\s*name)?|my\s+name|insert\s+name|name\s+here|signature)\s*[\]>}]{1,2}/gi

/**
 * The generic slot — `[name]`, `{{name}}`. Only a signature when it stands ALONE on its line,
 * which is what a sign-off slot looks like and what a sentence never does.
 */
const GENERIC_PLACEHOLDER_LINE =
  /^[ \t]*[[<{]{1,2}\s*name\s*[\]>}]{1,2}[ \t]*$/gim

/** Replace both tiers. `replacement` may be the empty string, which removes the placeholder. */
function replacePlaceholders(text: string, replacement: string): string {
  EXPLICIT_PLACEHOLDER.lastIndex = 0
  GENERIC_PLACEHOLDER_LINE.lastIndex = 0
  return text
    .replace(EXPLICIT_PLACEHOLDER, replacement)
    .replace(GENERIC_PLACEHOLDER_LINE, replacement)
}

function containsPlaceholder(text: string): boolean {
  EXPLICIT_PLACEHOLDER.lastIndex = 0
  GENERIC_PLACEHOLDER_LINE.lastIndex = 0
  const hit = EXPLICIT_PLACEHOLDER.test(text) || GENERIC_PLACEHOLDER_LINE.test(text)
  EXPLICIT_PLACEHOLDER.lastIndex = 0
  GENERIC_PLACEHOLDER_LINE.lastIndex = 0
  return hit
}

/** A sign-off line the placeholder usually follows. Used to tidy up after removing one. */
const SIGN_OFF =
  /^\s*(?:best|best\s+regards|kind\s+regards|warm\s+regards|regards|sincerely|yours(?:\s+sincerely|\s+truly|\s+faithfully)?|thanks|thank\s+you|cheers|all\s+the\s+best|many\s+thanks)\s*,?\s*$/i

export interface SignatureResult {
  text: string
  /** True when a placeholder was present — the caller can report that it acted. */
  hadPlaceholder: boolean
  /** True when a real name was substituted, as opposed to the placeholder merely being removed. */
  signed: boolean
}

/**
 * Fill or remove the sender-name placeholder in a drafted message.
 *
 * @param name The user's real display name, or null when it is genuinely unknown. An empty or
 *   whitespace-only name is treated as unknown — signing a letter "Best regards," followed by
 *   nothing is better than signing it with the empty string, and far better than inventing one.
 *   NEVER guess a name here: a wrong name on an outgoing email is worse than no name.
 */
export function applySignature(draft: string, name: string | null | undefined): SignatureResult {
  const text = draft ?? ''
  if (!containsPlaceholder(text)) return { text, hadPlaceholder: false, signed: false }

  const clean = (name ?? '').trim()
  if (clean) {
    return { text: replacePlaceholders(text, clean), hadPlaceholder: true, signed: true }
  }

  // No name to use. Drop the placeholder and collapse the blank run it leaves behind, so the
  // sign-off ends the message instead of trailing three empty lines.
  const out = replacePlaceholders(text, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
  // Removing the placeholder must never empty the message — if that is all there was, the
  // original is still the better artifact to hand back.
  if (!out.trim()) return { text, hadPlaceholder: true, signed: false }
  return { text: out, hadPlaceholder: true, signed: false }
}

/** Does this text still contain an unfilled name placeholder? The post-condition to assert. */
export function hasNamePlaceholder(text: string): boolean {
  return containsPlaceholder(text ?? '')
}

/** Exposed for the bench — a sign-off line with nothing after it is a valid ending. */
export const isSignOffLine = (line: string): boolean => SIGN_OFF.test(line)
