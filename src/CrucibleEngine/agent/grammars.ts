// ═══════════════════════════════════════════════════════════════════════════════
// W2 — GBNF grammar builders for constrained decoding (make malformed output impossible)
// ═══════════════════════════════════════════════════════════════════════════════
//
// A weak on-device model wastes proposals on OUTPUT-SHAPE errors: prose around the code,
// a missing/again-doubled fence, half a JSON object. Those never carry information the
// verifier can use — they are pure loss. GBNF (llama.cpp's grammar format) makes the wrong
// shape UNREACHABLE at the sampler: every token is masked to the grammar, so the model can
// only emit a well-formed answer and spends its capacity on being CORRECT, not well-formed.
//
// This module is PURE (grammar strings only) so the builders are unit-tested offline with no
// model. The activation site — node-llama-cpp's `createGrammar` + `session.prompt({ grammar })`
// in localModelPool — is a no-op until a GGUF runtime is present, exactly like the rest of that
// module. Zero model in this file.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Grammar that forces the output to be EXACTLY one fenced code block and nothing else —
 * `\`\`\`lang\n …code… \`\`\`` with no prose before or after. This is what makes the code
 * proposer's `extractCode()` infallible: there is always exactly one block to lift.
 *
 * The body admits any character INCLUDING one or two consecutive backticks as long as they are
 * followed by a non-backtick — so TypeScript template literals (`` `Hello ${x}` ``) and even a
 * doubled backtick remain reachable, but a run of THREE backticks can only be the closing fence.
 * This avoids the correctness hazard of a backtick-forbidding body (which would make any
 * template-literal solution unsamplable) while still guaranteeing an unambiguous, terminating
 * close — GBNF has no negative-lookahead to spell "any run not containing ```" directly, and this
 * ≤2-consecutive-backtick encoding is the standard llama.cpp idiom for it.
 */
export function fencedCodeGrammar(lang = 'typescript'): string {
  // `lang` is a fixed literal in the opening fence — no need to let the model choose it.
  const langLit = /^[a-zA-Z0-9_+-]*$/.test(lang) ? lang : 'typescript'
  const BT = '\\u0060'
  return [
    `root ::= "${BT}${BT}${BT}${langLit}\\n" body "${BT}${BT}${BT}" "\\n"?`,
    // body: any non-backtick, or one/two backticks that are followed by a non-backtick. Three
    // consecutive backticks are therefore never matchable inside body → only the closing fence.
    `body ::= ( [^${BT}] | "${BT}" [^${BT}] | "${BT}${BT}" [^${BT}] )*`,
  ].join('\n')
}

export type JsonFieldType = 'string' | 'number' | 'boolean'

/**
 * Grammar for a flat JSON object with a FIXED set of keys in a FIXED order, each constrained to
 * a primitive type. Structured extraction (classify / route / score) can then never emit an
 * unparseable object — the closing brace and every key are guaranteed. Keys are emitted in the
 * given order (GBNF sequences are ordered), which also makes the output canonical.
 */
export function jsonObjectGrammar(fields: Array<{ key: string; type: JsonFieldType }>): string {
  if (!fields.length) throw new Error('jsonObjectGrammar: at least one field is required')
  for (const f of fields) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(f.key)) throw new Error(`jsonObjectGrammar: unsafe key ${JSON.stringify(f.key)}`)
  }
  const val = (t: JsonFieldType) => (t === 'string' ? 'strval' : t === 'number' ? 'numval' : 'boolval')
  const pairs = fields
    .map(f => `"\\"${f.key}\\": " ${val(f.type)}`)
    .join(' ", " ')
  return [
    `root ::= "{" ws ${pairs} ws "}"`,
    `ws ::= [ \\t\\n]*`,
    // A JSON string: quote, then any char that is not a quote or backslash, or a valid escape.
    `strval ::= "\\"" ( [^"\\\\] | "\\\\" ["\\\\/bfnrt] )* "\\""`,
    `numval ::= "-"? ("0" | [1-9] [0-9]*) ("." [0-9]+)? ([eE] [-+]? [0-9]+)?`,
    `boolval ::= "true" | "false"`,
  ].join('\n')
}

/**
 * Grammar constraining the output to exactly one of a fixed set of literal choices (e.g. an
 * enum label from a classifier). Whitespace-free, so the whole generation IS the label.
 */
export function enumGrammar(choices: string[]): string {
  if (!choices.length) throw new Error('enumGrammar: at least one choice is required')
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `root ::= ${choices.map(c => `"${esc(c)}"`).join(' | ')}`
}
