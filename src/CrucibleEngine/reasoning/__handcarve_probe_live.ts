// ═══════════════════════════════════════════════════════════════════════════════
// LIVE HAND-CARVE PROBE — hand the model the decomposition for FREE and see if it certifies.
// Run:  npx tsx src/CrucibleEngine/reasoning/__handcarve_probe_live.ts   (live head :8080)
//   HC_ENTRY=csvSelect     which hand carve to run (see CARVES below). Default csvSelect.
//   HC_RUNS=3              draws (default 3 — one draw of a stochastic head is an anecdote).
//   HC_WALL_MS=300000      per-draw wall ceiling, matching the scorecard's. 0 = uncapped.
//   HC_RUNG_EPOCHS=10      per-rung epoch budget (default: decomposePerRungBudget's, i.e. 10).
//   HC_RUNG_CALLS=64       per-rung call purse (default: decomposePerRungBudget's, i.e. 64).
//     These two exist to answer the ONE alternative reading of a stalled hard rung: that the purse,
//     not the head, ended the search. A rung reported `stalled` stopped on EPOCHS (no progress),
//     having spent neither its calls nor its wall — so re-running it with a fat purse is what turns
//     "it ran out of budget" into "more budget buys nothing". Report the fat-purse number alongside
//     the default-purse one; a ceiling claim rests on both.
// ═══════════════════════════════════════════════════════════════════════════════
//
// WHY THIS EXISTS — it is the tie-breaker for TOP OPEN ITEM 2 of NEXT_SESSION.md.
//
// The hard set is 0/12 at a 300s ceiling and 0/4 at 900s, and 10 of the 12 tier-3 deaths are the
// SAME rung shape: "split a structured string into parts" (`splitCsv`, `splitSeconds`,
// `splitIntoParts`, `wrapText`, `extractField`). That aggregate is consistent with two mutually
// exclusive stories and the scorecard cannot tell them apart:
//
//   PLANNER-SIDE GAP — the decomposition the FM invents is bad (it re-bakes the entry, names a
//     helper it never composes against, or invents example I/O the helper can't satisfy). The
//     search plumbing is fine and the fix is in `fmPlanner.ts`.
//   PROPOSER CEILING — the 1.5B simply cannot write a quoted-field CSV field splitter, however
//     the work is cut. Then no planner prompt saves it and the fix is to SHRINK THE RUNG (finer
//     carves, retrieval, a narrower per-rung goal) — a different roadmap entirely.
//
// This probe removes the planner from the experiment. `CARVES` below are decompositions a HUMAN
// wrote: correct helper names, correct helper goals, correct witnessed example I/O. They are
// injected through `opts.planner`, which the carve treats as a caller-supplied plan. Everything
// downstream is UNCHANGED and still fully verifier-gated — each rung is ground by the same
// `iterate` against its own cases, and the composed module is re-verified against the ORIGINAL
// scorecard cases. A hand-written plan can make the search easier; it cannot make it lie.
//
// HOW TO READ THE RESULT (this is the whole point — write the reading down before the numbers):
//   • rungs certify AND compose certifies  → PLANNER-SIDE. The task is inside the 1.5B's reach
//     once carved; tier 3's 0/12 is the FM planner failing to find a carve a human found.
//   • the hard rung does NOT certify        → PROPOSER CEILING. The decomposition was handed over
//     for free and the head still cannot fill it. No planner work recovers this row.
//   • rungs certify, compose does NOT       → GLUE. Neither of the above; the failure is the
//     composition idiom, which is the compose-rung recovery path's problem.
//
// WHAT THE CUSTOM PLANNER TURNS OFF, stated so the result is not over-read: supplying `planner`
// exempts the run from the alias-rebake filter, the degeneracy gate, the non-composing gate and
// the trace-carve probe (`solve.ts` gates each on `!opts.planner`). That is correct here — those
// gates exist to reject BAD INVENTED plans and there is no invented plan — and it also removes
// the known confound that the probe's one-call whole-task draft, not the carve, is what solves
// rows (see `crucible-carve-probe-is-a-tier0-in-disguise`). A solve here is the carve's.
//
// The planner is keyed on the TOP entry and returns null for anything else, so the recursion and
// glue levels (which re-invoke the same planner with a SUB-goal) decline immediately instead of
// being handed the top-level carve again for a sub-problem it does not describe.

import { fmComplete, headModelName } from '../agent/fmReact'
import { decomposeCodeBySubFunction, type SubFunctionSpec, type SubFunctionPlanner } from './solve'
import { decomposePerRungBudget, hasDecomposeTemplate } from './fmPlanner'
import { TASKS, HARD_TASKS, type GeneralProbe } from './__decompose_general_scorecard_live'

interface HandCarve {
  /** The task this carves. Resolved against the scorecard rows unless `row` is supplied. */
  entry: string
  /** Which rung the session's evidence says is the hard one, for the verdict line. */
  hardRung: string
  /**
   * A SELF-CONTAINED row, for carving something that is not a scorecard task — specifically a
   * FAILING RUNG of another carve. The 2026-08-02 result is that `splitCsvLine` cannot be filled
   * even when handed over for free, and the only remaining lever is a finer carve of that rung;
   * testing it needs the rung promoted to a task in its own right. Goal and cases MUST be copied
   * verbatim from the parent carve's helper spec (asserted at startup) so the sub-experiment is
   * measuring the same rung the parent failed on and not a friendlier restatement of it.
   */
  row?: GeneralProbe
  /** The human decomposition. Example I/O is derived from the row's own stated semantics. */
  helpers: SubFunctionSpec[]
}

/** The `csvSelect` carve's hard rung, promoted to a task so it can be carved further. */
const SPLIT_CSV_LINE: SubFunctionSpec = {
  name: 'splitCsvLine',
  goal:
    'Write splitCsvLine(line: string): string[] splitting one line of CSV into its fields. ' +
    'Fields are separated by commas. A field may be wrapped in double quotes, in which case ' +
    'commas inside it are literal text and a doubled double-quote ("") is one literal ' +
    'double-quote character; the wrapping quotes are not part of the returned value. A field ' +
    'that is not quoted is returned as-is. The line contains no newline.',
  cases: [
    { args: ['a,b'], expected: ['a', 'b'] },
    { args: ['a'], expected: ['a'] },
    { args: ['a,,b'], expected: ['a', '', 'b'] },
    { args: ['"x,y",z'], expected: ['x,y', 'z'] },
    { args: ['"he said ""hi""",z'], expected: ['he said "hi"', 'z'] },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// THE HAND CARVES. Each helper goal is written the way the FM planner's contract asks for one:
// a self-contained sentence naming the function, its signature and its exact semantics — no
// reference to the parent task, because a rung is ground in isolation with only the helpers its
// goal NAMES supplied as context (`solve.ts` context hygiene).
// ─────────────────────────────────────────────────────────────────────────────
const CARVES: HandCarve[] = [
  {
    entry: 'csvSelect',
    hardRung: 'splitCsvLine',
    helpers: [
      {
        name: 'csvLines',
        goal:
          'Write csvLines(csv: string): string[] splitting a string into its newline-separated ' +
          'lines. A string with no newline yields a one-element array containing the whole string. ' +
          'No line is trimmed and empty lines are kept.',
        cases: [
          { args: ['a,b\nc,d'], expected: ['a,b', 'c,d'] },
          { args: ['a'], expected: ['a'] },
          { args: ['a\nb,c'], expected: ['a', 'b,c'] },
        ],
      },
      // THE HARD RUNG. This is the shape 10 of 12 tier-3 deaths share.
      SPLIT_CSV_LINE,
    ],
  },
  // ───────────────────────────────────────────────────────────────────────────
  // SECOND-LEVEL CARVE — the follow-up the 2026-08-02 verdict demands.
  //
  // `splitCsvLine` never certified in 3 draws even handed over for free, which says the rung must
  // SHRINK. This is that hypothesis made falsifiable: the same rung, same goal, same cases (asserted
  // identical to the parent's), carved by hand into two strictly smaller pieces —
  //   splitCsvRaw     — a quote-AWARE split that does no unescaping (structure only), and
  //   unquoteCsvField — a pure string transform on ONE already-split field (escaping only).
  // The single hard thing about CSV is that those two concerns are entangled in one scan; separating
  // them is the smallest carve that still composes. If BOTH certify and the composition holds, the
  // ceiling is a RUNG-SIZE ceiling and recursion is the right medicine (the machinery already exists
  // — `solve.ts` recursion — it just needs a sub-plan this good). If `splitCsvRaw` also stalls, the
  // ceiling is the quote-state scan itself and no carve reaches it; retrieval is the remaining lever.
  {
    entry: 'splitCsvLine',
    hardRung: 'splitCsvRaw',
    row: {
      entry: SPLIT_CSV_LINE.name,
      label: 'splitCsvLine (the csvSelect rung that never certifies), carved one level finer',
      goal: SPLIT_CSV_LINE.goal,
      cases: SPLIT_CSV_LINE.cases,
    },
    helpers: [
      {
        name: 'splitCsvRaw',
        goal:
          'Write splitCsvRaw(line: string): string[] splitting a line on commas that are OUTSIDE ' +
          'double quotes. Scan the line one character at a time keeping a boolean "inside quotes" ' +
          'flag that flips on every double-quote character; a comma splits the line only while that ' +
          'flag is false. Every field is returned EXACTLY as it appears in the line, including any ' +
          'double-quote characters — this function removes nothing and unescapes nothing.',
        cases: [
          { args: ['a,b'], expected: ['a', 'b'] },
          { args: ['a'], expected: ['a'] },
          { args: ['a,,b'], expected: ['a', '', 'b'] },
          { args: ['"x,y",z'], expected: ['"x,y"', 'z'] },
          { args: ['"he said ""hi""",z'], expected: ['"he said ""hi"""', 'z'] },
        ],
      },
      {
        name: 'unquoteCsvField',
        goal:
          'Write unquoteCsvField(field: string): string normalising ONE CSV field. If the field ' +
          'starts and ends with a double-quote character, remove those two outer characters and ' +
          'then replace every doubled double-quote ("") in what remains with a single double-quote ' +
          'character. A field not wrapped in double quotes is returned unchanged.',
        cases: [
          { args: ['a'], expected: 'a' },
          { args: [''], expected: '' },
          { args: ['"x,y"'], expected: 'x,y' },
          { args: ['"he said ""hi"""'], expected: 'he said "hi"' },
          { args: ['""'], expected: '' },
        ],
      },
    ],
  },
]

const s = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

/** TRAP 5 — a misconfigured head returns EMPTY completions and scores as capability failure. */
async function preflightHead(): Promise<void> {
  const name = headModelName()
  console.log(`# head: ${name}`)
  if (/apple/i.test(name)) {
    console.error(`ABORT: head is '${name}', not the local GGUF (TRAP 2 — export CRUCIBLE_BONSAI_BIN/MODEL).`)
    process.exit(1)
  }
  const t0 = Date.now()
  const text = await fmComplete([{ role: 'user', content: 'Write a JS function add(a,b) that returns a+b. Code only.' }], { maxTokens: 64 })
  if (!text.trim()) {
    console.error(`ABORT: head returned an EMPTY completion (${Date.now() - t0}ms) — TRAP 5. Total -c must be PER_SLOT_CTX x SLOTS, and --jinja is required.`)
    process.exit(1)
  }
  console.log(`# head preflight ok (${text.trim().length} chars in ${Date.now() - t0}ms)\n`)
}

async function main(): Promise<void> {
  await preflightHead()
  const entry = process.env.HC_ENTRY ?? 'csvSelect'
  const carve = CARVES.find(c => c.entry === entry)
  if (!carve) { console.error(`no hand carve for ${entry} — add one to CARVES`); process.exit(1) }
  const row: GeneralProbe | undefined = carve.row ?? [...TASKS, ...HARD_TASKS].find(t => t.entry === entry)
  if (!row) { console.error(`no scorecard row named ${entry}`); process.exit(1) }
  // A self-contained row must be the SAME rung its parent carve failed on, byte for byte. Without
  // this, a second-level carve that quietly softened the goal or dropped the `""` case would read as
  // "the finer carve works" when what actually happened is that the problem got easier. Cheap,
  // mechanical, and it fails loudly rather than producing a publishable-looking wrong number.
  if (carve.row) {
    const parentRung = CARVES.flatMap(c => c.helpers).find(h => h.name === carve.row!.entry)
    if (!parentRung) {
      console.error(`self-contained row \`${carve.row.entry}\` is not a rung of any carve — nothing to be faithful to`)
      process.exit(1)
    }
    if (parentRung.goal !== row.goal || JSON.stringify(parentRung.cases) !== JSON.stringify(row.cases)) {
      console.error(`self-contained row \`${row.entry}\` DIFFERS from the parent carve's rung (goal or cases) — ` +
        `this would measure an easier problem than the one that failed`)
      process.exit(1)
    }
    console.log(`# sub-carve of rung \`${row.entry}\` — goal and cases verified identical to the parent carve's`)
  }
  // Same assertion the general scorecard makes: a templated row would measure the TEMPLATE path.
  if (hasDecomposeTemplate(row.goal, row.entry)) {
    console.error(`${entry} matches a decompose template — this probe would measure the template path`)
    process.exit(1)
  }

  const runs = Math.max(1, Number(process.env.HC_RUNS || 3))
  const wallMs = Number(process.env.HC_WALL_MS ?? 300_000)
  // Start from the SAME per-rung budget the scorecard's tier 3 uses, so the default run is
  // comparable to the 0/12, then let the two knobs widen only what they name.
  const base = decomposePerRungBudget(row.goal, row.entry)
  const iterate = {
    ...base,
    maxEpochs: Math.max(1, Number(process.env.HC_RUNG_EPOCHS || base.maxEpochs)),
    globalModelCalls: Math.max(1, Number(process.env.HC_RUNG_CALLS || base.globalModelCalls)),
    // The per-rung wall must not bind before the epochs do, or a fat-epoch run would just trade one
    // premature stop for another. Track the task ceiling when it is the larger of the two.
    wallClockMs: Math.max(base.wallClockMs, wallMs > 0 ? wallMs : base.wallClockMs),
  }

  // The hand plan, injected. Keyed on the TOP entry: recursion and the glue re-decomposition
  // re-invoke this same planner with a SUB-goal, and handing them the top-level carve again would
  // be a plan that does not describe their problem. Returning null makes them decline cheaply.
  const planner: SubFunctionPlanner = async (inp) =>
    inp.entry === carve.entry ? carve.helpers.map(h => ({ ...h })) : null

  console.log(`# HAND-CARVE PROBE — ${row.label}`)
  console.log(`# ${carve.helpers.length} hand-written rung(s): ${carve.helpers.map(h => h.name).join(', ')}  (hard rung: ${carve.hardRung})`)
  console.log(`# ${runs} draw(s) · wall ceiling ${wallMs > 0 ? s(wallMs) : 'none'} · per-rung purse ` +
    `${iterate.globalModelCalls}c / ${iterate.maxEpochs} epochs / ${s(iterate.wallClockMs)}` +
    (iterate.maxEpochs !== base.maxEpochs || iterate.globalModelCalls !== base.globalModelCalls
      ? `  (WIDENED from ${base.globalModelCalls}c / ${base.maxEpochs} epochs — not comparable to the scorecard's tier 3)` : '') + '\n')

  let solved = 0
  const hardRungCertified: boolean[] = []
  const composeCertified: boolean[] = []

  for (let run = 0; run < runs; run++) {
    const t0 = Date.now()
    const ac = wallMs > 0 ? new AbortController() : null
    const timer = ac ? setTimeout(() => ac.abort(), wallMs) : null
    // `planAttempts: 1` sets the FLOOR only. Since 2026-08-02 the retry loop keeps resampling while
    // another attempt fits the budget (`solve.ts` anotherAttemptFits), and with no call ledger and a
    // signal-only deadline both axes read Infinity — so the loop re-runs this CONSTANT carve until
    // the wall ceiling, up to the CRUCIBLE_MAX_PLAN_ATTEMPTS backstop. That is deliberately kept:
    // it hands the hand-written carve every attempt the clock allows, which is the most GENEROUS
    // setting for the planner-side hypothesis. A ceiling reached under those conditions is a
    // capability statement, not a budget artifact. It does mean `d.rungs` (the LAST attempt's) is
    // not the measurement — the per-attempt trace below is.
    const d = await decomposeCodeBySubFunction(
      { goal: row.goal, nl: row.goal, entry: row.entry, cases: row.cases },
      { planner, planAttempts: 1, iterate, ...(ac ? { signal: ac.signal } : {}) },
    )
    if (timer) clearTimeout(timer)
    const wall = Date.now() - t0
    if (d.status === 'solved') solved++

    const attempts = d.attempts ?? [{ attempt: 1, status: d.status, detail: d.detail, modelCalls: d.modelCalls, wallMs: wall, rungs: d.rungs }]
    console.log(`── draw ${run + 1}/${runs}: ${d.status} — ${d.modelCalls} calls, ${s(wall)}, ${attempts.length} attempt(s) at the same carve`)
    console.log(`   ${d.detail}`)
    for (const a of attempts) {
      console.log(`   attempt ${a.attempt}: ${a.status} — ${a.modelCalls} calls, ${s(a.wallMs)}`)
      for (const r of a.rungs) {
        // `bestScore` is the whole diagnosis for a stalled rung and is worth more than the call
        // count: `stalled` means two epochs without improvement, so the question is WHERE it
        // stalled. A rung parked at 0.8 is one counterexample from certifying and the lever is
        // failure-directed repair; a rung parked near 0 never had the shape and the lever is a
        // smaller rung. Printing only calls/seconds hides that difference entirely.
        console.log(`     ${(r.phase ?? 'unknown').padEnd(9)} ${r.name.padEnd(28)} ${(r.certified ? 'OK' : r.status).padEnd(9)} ` +
          `${String(r.modelCalls).padStart(3)}c ${(r.wallMs === undefined ? '   —' : s(r.wallMs)).padStart(7)}` +
          `  best ${r.bestScore.toFixed(2)}`)
      }
    }
    // The verdict's two facts, read across EVERY attempt rather than the last one. `d.rungs` holds
    // only whichever plan died last, so scoring it would report "never certified" for a rung that
    // certified on attempt 1 and was carried thereafter — the exact undercount that would fake a
    // proposer ceiling. A rung ABSENT from an attempt never ran there (an earlier rung collapsed
    // the plan first), which is not the same as failing; the per-attempt trace above shows which.
    const anyRung = (pred: (r: { name: string; phase?: string; certified: boolean }) => boolean): boolean =>
      attempts.some(a => a.rungs.some(r => pred(r)))
    // A recursion sub-rung is renamed `<helper>/<sub>`, so match the hard rung on its own name only.
    hardRungCertified.push(anyRung(r => r.name === carve.hardRung && r.certified))
    composeCertified.push(anyRung(r => r.phase === 'compose' && r.certified))
    console.log('')
  }

  const hard = hardRungCertified.filter(Boolean).length
  const comp = composeCertified.filter(Boolean).length
  console.log('── verdict ─────────────────────────────────────')
  console.log(`   whole task certified      ${solved}/${runs}`)
  console.log(`   hard rung \`${carve.hardRung}\` certified   ${hard}/${runs}`)
  console.log(`   compose certified         ${comp}/${runs}`)
  const verdict =
    hard === 0
      ? `PROPOSER CEILING — the decomposition was handed over for free and \`${carve.hardRung}\` still never certified. ` +
        `No FM-planner work recovers this row; the rung itself must shrink (finer carve / retrieval).`
      : solved === runs
        ? `PLANNER-SIDE — every rung and the composition certify on a hand carve. Tier 3's 0/12 is the FM ` +
          `planner failing to find a decomposition a human found, not a 1.5B capability ceiling.`
        : comp < hard
          ? `GLUE — the hand rungs certify (${hard}/${runs}) but composition does not (${comp}/${runs}). Neither the ` +
            `planner prompt nor rung capability is the binding constraint here; the compose rung is.`
          : `MIXED — hard rung ${hard}/${runs}, whole task ${solved}/${runs}. The carve is reachable but not reliably; ` +
            `read the per-draw traces above before attributing.`
  console.log(`\n   ${verdict}`)
  console.log(JSON.stringify({ handcarve_probe: true, entry, runs, wallMs, solved, hardRungCertified: hard, composeCertified: comp }))
}

main().catch(e => { console.error('hand-carve probe failed:', e); process.exit(1) })
