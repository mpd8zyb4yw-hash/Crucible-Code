// Git-mined bench tasks (W42.2, GAP_CLOSURE_ADDENDUM.md) — REAL historical bugs.
//
// Why this shard is different from the authored corpus: ref and suite here were written
// in SEPARATE sessions against LIVE behavior, not against each other in one sitting —
// the fix commit's engine file is the reference, and the subsystem's own regression
// bench (pinned at the fix commit) is the hidden suite. The agreement-in-error channel
// the authored corpus worries about (one author misreads the contract, encodes the same
// misreading into ref and suite) is decorrelated BY CONSTRUCTION: the bench existed to
// certify the real system, and the fix had to survive it plus live diagnosis.
//
// A task is four git coordinates plus a symptom-only prompt:
//   parentSha  — the world the agent starts from (contains the bug)
//   fixSha     — parent's child; its targetPath content is the REFERENCE
//   targetPath — the ONE file the agent may change
//   benchPath  — the paired regression bench, pinned at fixSha (the hidden suite)
// File contents are NEVER embedded here: git objects are content-addressed and
// immutable, so the SHAs are the pin. The certifier (__minedcorpus_bench.ts) proves,
// through the real hermetic oracle: ref certifies, parent is REJECTED BEHAVIORALLY
// (non-vacuity — the suite actually discriminates), the fix commit touched nothing but
// targetPath+benchPath (so parent-tree + ref overlay ≡ fix-tree), and the prompt leaks
// no line of the fix diff.
//
// Prompt discipline: SYMPTOM ONLY — what the subsystem observably does wrong and what
// correct behavior is, in contract terms. Never the mechanism of the fix, never a name
// introduced by the fix, never a verbatim added line (mechanically enforced). Naming
// functions that already exist in the parent file is fine — that is diagnosis context a
// real bug report would carry.
// Authoring rule (same as the other shards): no backticks, no dollar-brace in embedded
// text, so everything lives inside these template literals verbatim.

export interface MinedTask {
  id: string
  title: string
  /** Full 40-char sha of the commit CONTAINING the bug fix — targetPath here is the reference. */
  fixSha: string
  /** Full 40-char sha of fixSha's parent — the buggy world the agent starts from. */
  parentSha: string
  /** The one file the agent may change (repo-relative). */
  targetPath: string
  /** The paired regression bench, read at fixSha — the hidden suite. */
  benchPath: string
  /** Symptom-only bug report handed to the agent (validator enforces no fix-diff leakage). */
  prompt: string
  /** Per-run Gate-B budget — these suites are real subsystem benches, not 20-assert scripts. */
  runTimeoutMs?: number
}

/**
 * Candidates inspected and REJECTED, kept visible so the drop is a recorded decision,
 * not a silent cap (a mined corpus that quietly skips inconvenient commits is selecting
 * on ease, and its pass rate stops meaning anything). The certifier prints this list.
 */
export const DROPPED_COMMITS: Array<{ sha: string; reason: string }> = [
  {
    sha: 'cab4b7b5cbeafb2d7607a3a3f41f2a200c8efa35',
    reason:
      'arrow-param arity fix is VACUOUS as a task: the commit touched no bench, and the paired ' +
      '__retrieval_bench at that sha asserts the bare-arrow function is EXTRACTED but never its ' +
      'arity — the parent code passes the suite, so the suite cannot discriminate parent from fix.',
  },
]

const MINED_CONTRACT =
  'This is a BUG-FIX task in an existing TypeScript codebase. The workspace already contains the ' +
  'target file plus its immediate imports. Fix the bug by EDITING the target file ONLY — do not ' +
  'create, rename, or modify any other file. Preserve the file\'s existing exports and all ' +
  'unrelated behavior: an automated audit runs the subsystem\'s full regression bench (which you ' +
  'cannot see) against your edited file, and it fails if anything else regressed.'

export const MINED_TASKS: MinedTask[] = [
  {
    id: 'mined-aliased-import-propagation',
    title: 'Whole-tree signature propagation skips aliased importers (real bug, 2026-07-12)',
    fixSha: 'cfede63b463ff62b5cf3875e5070e8d0f071efd2',
    parentSha: '8f6f871e4f1da58feec2e6e487d23bd3e6d34efd',
    targetPath: 'src/CrucibleEngine/reasoning/emitPlan.ts',
    benchPath: 'src/CrucibleEngine/reasoning/__vgr_bench.ts',
    runTimeoutMs: 300_000,
    prompt: `Bug report for src/CrucibleEngine/reasoning/emitPlan.ts. ${MINED_CONTRACT}

SYMPTOM — whole-tree signature propagation silently ships broken aliased importers.
When planEmitTree propagates a changed function signature across the tree, a sibling
file that imports the entry function UNDER AN ALIAS is left untouched. Example: the
entry 'fmt' in src/fmt.ts gains a parameter, and a sibling reads

  import { fmt as f } from './fmt'
  export const banner = f('hi', 10)

Siblings importing { fmt } by its original name get their call sites reconciled to the
new signature, but the aliased sibling above comes back unchanged — reported as already
fitting — because its call sites are written f(...), and they were searched under the
name 'fmt'. The emitted tree is broken at exactly the aliased call sites. This violates
the planner's all-or-nothing guarantee: every importer is reconciled, or the whole edit
is refused with a note.

EXPECTED — a sibling that binds the entry under any local alias has those aliased call
sites found and reconciled exactly as if it imported the original name; when an aliased
call cannot absorb the new signature, the whole edit is refused, same as the non-aliased
path. A file importing the entry under several local names has all of them handled. A
sibling that both imports the entry and shadows it locally keeps its current
too-ambiguous refusal. Behavior for non-aliased importers must not change.`,
  },
  {
    id: 'mined-move-default-namespace-import',
    title: 'Move refactor misses default/namespace import deps (real bug, 2026-07-13)',
    fixSha: '450cab67e0f574c0e851d82286fa27b93095876f',
    parentSha: '1d458970fec203fda07dd32b57cae40797f9c6bb',
    targetPath: 'src/CrucibleEngine/reasoning/emitPlan.ts',
    benchPath: 'src/CrucibleEngine/reasoning/__vgr_bench.ts',
    runTimeoutMs: 300_000,
    prompt: `Bug report for src/CrucibleEngine/reasoning/emitPlan.ts. ${MINED_CONTRACT}

SYMPTOM — the move-function refactor silently breaks the destination when the moved
definition depends on a default or namespace import. planMoveTree must refuse to move
(abstain) when the definition is not self-contained — its body uses local bindings
introduced by the source file's import statements — unless the dependency is carried
along. That detection currently sees NAMED imports only. A definition using a default
import:

  import yaml from 'some-yaml-lib'
  export function readCfg(p: string) { return yaml.parse(p) }

or a namespace import:

  import * as os from 'os'
  export function tmpFor(name: string) { return os.tmpdir() + '/' + name }

is judged self-contained, so it is moved WITHOUT its dependency and the destination
file references a name that does not exist there — a silent break, invisible to the
transform because cross-file resolution is outside its view.

EXPECTED — the self-containment check sees every local binding an import statement
introduces: named bindings (including renamed ones), the default-import binding, and
the namespace binding. A moved definition using any of them is treated exactly like one
using a named import today (carried when possible, otherwise the move abstains).
Unrelated imports the definition never uses must NOT cause a false abstain: moving a
definition that touches no imported names still succeeds even when the source file has
default or namespace imports at the top.`,
  },
  {
    id: 'mined-apifaith-vocabulary',
    title: 'API-faithfulness vocabulary bug: false certify AND false reject (real bug, 2026-07-16)',
    fixSha: '3265f947da1455229bdcba48478c318214d6ab6f',
    parentSha: 'c45ebdf4058aed6f2e89f2ae6784430f89c90783',
    targetPath: 'src/CrucibleEngine/reasoning/apiFaithfulness.ts',
    benchPath: 'src/CrucibleEngine/reasoning/__apifaith_bench.ts',
    runTimeoutMs: 180_000,
    prompt: `Bug report for src/CrucibleEngine/reasoning/apiFaithfulness.ts. ${MINED_CONTRACT}

CONTEXT — documentedIdentifiers(evidence) harvests the vocabulary of identifier names
that a retrieved documentation text actually documents; the faithfulness verifier then
flags generated code whose library identifiers are absent from that vocabulary as
fabricated. One vocabulary bug currently fires in BOTH directions:

FALSE REJECT (the worse direction) — the harvester refuses single-character
identifiers, so 'z' can never be documented. With evidence plainly containing
'const ipv4 = z.ipv4();', code that writes the canonical zod import of z is reported
as fabricating 'z', and the repair loop is told to fix correct code. Single-character
namespace bindings such as z, _ and $ are the norm for popular libraries, not noise.

FALSE CERTIFY — the member-access harvesting rule tolerates whitespace between the dot
and the following name, so a prose sentence boundary reads as member access. Evidence
prose ending one sentence with 'addresses.' and starting the next line with 'Zod v4'
admits 'Zod' into the vocabulary, and fabricated code importing Zod (capital Z, a name
the library never exports) certifies green. Real member access never separates the dot
from the member name with whitespace; prose sentence boundaries do.

EXPECTED — both directions close at the harvester, and every consumer of the shared
vocabulary inherits the fix. The single-character floor is gone: any identifier that
genuinely appears called, dotted, or imported in evidence is documentable regardless of
length. Prose across a sentence boundary no longer enters the vocabulary. Dotted usage
in evidence documents both sides of the dot (the namespace root and the member), and a
chained member call starting its own line — a dot-leading line continuing a builder
chain — still documents that member. Ambiguity resolves toward abstain-side safety:
harvest generously from real code shapes, exclude only what is provably prose.`,
  },
]
