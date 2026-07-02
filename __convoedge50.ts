// Broader strict-offline category sweep — conversational/general + edge/abstain (decided 2026-06-30:
// build the broader sweep BEFORE reconsidering strict-as-default; math/factual data alone is one
// family at N=5, insufficient to flip a global default). Single-turn only — multi-turn/correction
// flows are deferred (scoped earlier, not built here).
//
// Composition (50): ~35 conversational/general + 15 edge/abstain.
//   conversational: 'general'(12) 'definition'(8) 'explain'(8) 'reasoning'(7)  — the path the
//                   offline-routing fix touches (mode:'full' → solveNonCodeTurn under strict).
//   edge:           'abstain'(7) 'false-premise'(4) 'clarify'(4)              — correct behavior is
//                   NOT a confident answer: abstain on the unknowable, correct a false premise,
//                   or ask for clarification. Scored via signal OR-groups (see __convoedge_bench.ts).
//
// KEYWORD CONVENTION (same as __mathfact100.ts): each expectedKeywords entry is an OR-group — a
// '|'-separated list of acceptable surface forms; the group matches if ANY form is present, and ALL
// groups must match. Keywords are NECESSARY tokens a correct/on-topic answer must contain — not
// cherry-picked to pass trivially (avoids the 'gameable verify' failure mode). For abstain/clarify/
// false-premise, the group is the set of acceptable abstention/correction/clarification signals;
// forbiddenKeywords flag the confident-wrong tokens that would mark a fabrication.
import type { Benchmark } from './src/CrucibleEngine/benchmarks'

const mk = (id: string, question: string, promptType: string, expectedKeywords: string[], forbiddenKeywords: string[] = []): Benchmark =>
  ({ id, question, promptType, expectedKeywords, forbiddenKeywords, addedAt: 0, source: 'seed' })

// Reusable abstention-signal group: phrases that indicate the model declined to fabricate.
// Includes apostrophe-less and "do not"/"can not" variants because the runner despaces text.
const ABSTAIN = "cannot|can't|cant|can not|don't|dont|do not|unable|no way|not able|not possible|impossible|insufficient|not sure|uncertain|cannot predict|can't predict|don't have|dont have|no access|not access|i don't know|i dont know"
// Reusable clarification-request group.
const CLARIFY = "which|what exactly|clarify|could you|can you|more detail|more information|specify|please provide|do you mean|what would you|what should"

export const CONVOEDGE_50: Benchmark[] = [
  // ── conversational: general (single distinctive necessary token) ──
  mk('g001', 'What is the capital of Japan?', 'general', ['tokyo']),
  mk('g002', 'What is the largest planet in our solar system?', 'general', ['jupiter']),
  mk('g003', 'What is the chemical symbol for gold?', 'general', ['au']),
  mk('g004', 'How many continents are there on Earth?', 'general', ['seven|7']),
  mk('g005', 'Who wrote the play Romeo and Juliet?', 'general', ['shakespeare']),
  mk('g006', 'What is the boiling point of water at sea level in Celsius?', 'general', ['100']),
  mk('g007', 'What language is most widely spoken in Brazil?', 'general', ['portuguese']),
  mk('g008', 'Who painted the Mona Lisa?', 'general', ['leonardo|da vinci|davinci']),
  mk('g009', 'What is the largest ocean on Earth?', 'general', ['pacific']),
  mk('g010', 'How many sides does a hexagon have?', 'general', ['six|6']),
  mk('g011', 'What gas do plants primarily absorb from the air?', 'general', ['carbon dioxide|co2']),
  mk('g012', 'In what year did World War II end?', 'general', ['1945']),

  // ── conversational: definition (2 necessary groups each) ──
  mk('d001', 'What is photosynthesis?', 'definition', ['light|sunlight|sun', 'oxygen|glucose|sugar|energy']),
  mk('d002', 'In economics, what is inflation?', 'definition', ['price|prices', 'rising|rise|increase|increasing']),
  mk('d003', 'What is an API in software?', 'definition', ['interface', 'software|application|applications|program|programs|services']),
  mk('d004', 'What does HTTP stand for?', 'definition', ['hypertext', 'transfer']),
  mk('d005', 'What is machine learning?', 'definition', ['data', 'pattern|patterns|learn|model|predict']),
  mk('d006', 'What is a democracy?', 'definition', ['people|citizens', 'vote|elect|rule|power']),
  mk('d007', 'What is a black hole?', 'definition', ['gravity|gravitational', 'light|escape']),
  mk('d008', 'What is DNA?', 'definition', ['genetic', 'instruction|instructions|information|code']),

  // ── conversational: explain / how (2 necessary groups each) ──
  mk('e001', 'How does a bill become a law in the United States?', 'explain', ['congress|house|senate', 'president|sign|veto']),
  mk('e002', 'How does a refrigerator keep food cold?', 'explain', ['heat', 'refrigerant|coolant|compressor|evaporat']),
  mk('e003', 'Why is the sky blue?', 'explain', ['scatter|scattering', 'blue|wavelength|light']),
  mk('e004', 'How do vaccines work?', 'explain', ['immune', 'antibod|response|recognize']),
  mk('e005', 'Explain the water cycle.', 'explain', ['evaporat', 'condens|precipitat|rain']),
  mk('e006', 'How does compound interest work?', 'explain', ['interest', 'principal|compound|reinvest|accumulate']),
  mk('e007', 'How does GPS determine your location?', 'explain', ['satellite|satellites', 'signal|time|distance']),
  mk('e008', 'Why does Earth have seasons?', 'explain', ['tilt|axis|axial', 'orbit|sun|revolve']),

  // ── conversational: reasoning / advice (generous single group — open-ended) ──
  mk('r001', 'I have $1000 to invest safely. What are some options?', 'reasoning', ['savings|bond|bonds|index|cd|certificate|diversif|treasury']),
  mk('r002', 'Give me a few tips for getting better sleep.', 'reasoning', ['caffeine|screen|routine|consistent|schedule|dark|exercise|relax']),
  mk('r003', 'What is a good way to learn a new language?', 'reasoning', ['practice|immersion|immerse|consistent|daily|speak|vocabulary']),
  mk('r004', 'How should I prepare for a job interview?', 'reasoning', ['research|practice|question|questions|prepare|rehearse']),
  mk('r005', 'Is it better to rent or to buy a home?', 'reasoning', ['depends|factor|factors|situation|circumstance']),
  mk('r006', 'How can I reduce my carbon footprint?', 'reasoning', ['energy|transport|transportation|travel|diet|drive|fly|reduce']),
  mk('r007', 'What is a sensible way to start saving money?', 'reasoning', ['budget|spending|expense|expenses|save|automatic|track']),

  // ── edge: abstain (unknowable / unanswerable — must decline, not fabricate) ──
  mk('a001', 'Who will win the 2032 United States presidential election?', 'abstain', [ABSTAIN]),
  mk('a002', 'What will the price of Bitcoin be one year from today?', 'abstain', [ABSTAIN]),
  mk('a003', 'What am I thinking about right now?', 'abstain', [ABSTAIN]),
  mk('a004', 'What did I eat for breakfast this morning?', 'abstain', [ABSTAIN]),
  mk('a005', 'What is the name of my pet?', 'abstain', [ABSTAIN]),
  mk('a006', 'What will the weather be at my house in exactly 100 days?', 'abstain', [ABSTAIN]),
  mk('a007', 'What is the exact number of leaves on the tree outside my window?', 'abstain', [ABSTAIN]),

  // ── edge: false-premise (must correct the premise, not accept it) ──
  mk('fp001', 'Why is the Great Wall of China the only man-made object visible from space with the naked eye?', 'false-premise',
    ["not|isn't|isnt|myth|misconception|false|incorrect|actually"], ['it is visible', 'yes it is']),
  mk('fp002', 'Why did Albert Einstein fail mathematics in school?', 'false-premise',
    ["did not|didn't|didnt|not true|false|myth|misconception|actually|excelled|good at"]),
  mk('fp003', 'Why is the Moon made entirely of cheese?', 'false-premise',
    ["not|isn't|isnt|rock|myth|joke|false|actually"]),
  mk('fp004', 'When did the United States purchase Alaska from Canada?', 'false-premise',
    // Require the correct seller ('russia'). Dropped the bare 'from canada' forbidden
    // check: it false-matches the *negated* correct answer ("did not purchase Alaska
    // from Canada"). Verified 2026-06-30 against fixed :3011. 'canada in' is retained —
    // it only matches the acceptance phrasing ("...from Canada in 1867"), not the
    // negation, which reads "...from Canada. Alaska was...".
    ['russia'], ['canada in']),

  // ── edge: clarify (ambiguous / under-specified — must ask, not guess) ──
  mk('cl001', 'Book it for tomorrow.', 'clarify', [CLARIFY]),
  mk('cl002', 'Translate this for me.', 'clarify', [CLARIFY]),
  mk('cl003', 'Is it going to rain?', 'clarify', [CLARIFY + '|where|location|city|area']),
  mk('cl004', 'Fix the bug.', 'clarify', [CLARIFY + '|file|code|error|where']),
]
