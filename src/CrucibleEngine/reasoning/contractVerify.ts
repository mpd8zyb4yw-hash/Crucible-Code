// ============================================================
// CRUCIBLE — Answer-path BEHAVIORAL-CONTRACT verifier (cont.92)
//
// WHY THIS EXISTS. cont.91 closed the STRUCTURAL hole (code that parses, then dies when its
// own demo runs) — and its live suite immediately showed the next one: the linked-list answer's
// pop() lost nodes and the token-bucket's acquire() was inverted, yet both PARSED, both ran
// their own demo without a structural throw, and both shipped stamped. "Won't crash" is not
// "is correct". The metamorphic/property logic oracles existed (vgr:bench-proven) but were
// reachable ONLY from the VGR solve path — the answer route never saw them.
//
// THE PRINCIPLE — same doctrine as metamorphicSpec.ts, extended to STATEFUL contracts. "Stack",
// "queue", "LRU cache", "rate limiter" are not vague prompts: each names a contract with
// invariants that hold for EVERY correct implementation (LIFO order, FIFO order, recency
// eviction, capacity + refill). Certifying against those is correctness for the right reason;
// nothing here memorizes an answer.
//
// FAILS IN TWO DIRECTIONS (cont.85) — the false-reject discipline shapes every stage:
//   DETECTION proposes (from the QUESTION's text — the user's ask is the authority on WHAT
//     was requested), RESOLUTION disposes (the ANSWER's own AST decides what to judge; no
//     coherent class/function → abstain), CALIBRATION arbitrates (constructor conventions are
//     probed and sanity-checked before any judgment; nothing calibrates → abstain, with one
//     deliberate exception documented at the rate-limiter), and only calibrated batteries
//     judge. Convention variance (pop-vs-poll, push-to-head vs append-to-tail, absent-get
//     returning undefined/null/-1/false) is ACCEPTED, never penalized. Async APIs abstain.
//   Every check that observes a wrong value reports a CONCRETE counterexample (for the user)
//   plus a FORWARD requirement (for repair — cont.89: never show the rejected artifact, or
//   anything shaped like it, to the retry).
//
// TIME is under test for rate-limiter/debounce/throttle: the sandbox gets a fake clock and a
// fake timer queue (installed BEFORE the candidate loads), and `__advance(ms)` drives both —
// so lazy Date.now() refill math AND setInterval-driven refill both verify without real waiting.
//
// Zero model calls. In-process vm (the vm timeout interrupts runaway loops ANYWHERE in the
// script — a broken pop()'s infinite while is caught and attributed to the check that hung).
// ============================================================
/// <reference types="node" />

import * as vm from 'vm'
import * as ts from 'typescript'
import { answerCodeBlocks, extractLibraryUsage, classifyLibraryUsage, makeSafeBuiltinRequire } from './apiFaithfulness'
import { deriveMetamorphicSpec, canonicalImpl } from './metamorphicSpec'
import { propertyForFunction } from './propertyVerifier'

export interface ContractDefect {
  /** The invariant that failed. */
  check: string
  /** Concrete observed behavior — for the user-facing warning and telemetry. */
  counterexample: string
  /** Forward-phrased requirement — for the repair prompt (never describes the broken code). */
  requirement: string
}

export interface ContractVerdict {
  status: 'certified' | 'violations' | 'abstain'
  /** Contract family judged ('' when none detected/resolved). */
  family: string
  /** The class/function in the ANSWER that was judged. */
  entry: string
  reason: string
  defects: ContractDefect[]
  checksRun: number
  executionMs: number
}

// ── Contract detection (QUESTION text) ────────────────────────────────────────────────
// "implement a queue using two stacks": the noun after using/with/backed-by is the MEDIUM,
// not the ask — strip that tail before matching, or both orderings of queue/stack misfire.
function askText(question: string): string {
  return question.toLowerCase().replace(/\b(using|via|backed by|based on|on top of|out of|implemented with)\b[\s\S]*$/, ' ')
}

type Kind =
  | 'linked-list' | 'lru-cache' | 'bst' | 'binary-search' | 'heap' | 'rate-limiter'
  | 'debounce' | 'throttle' | 'queue' | 'stack' | 'event-emitter' | 'memoize'
  | 'fizzbuzz' | 'anagram' | 'brackets' | 'two-sum' | 'deep-clone' | 'deep-equal'

export interface DetectedContract {
  kind: Kind
  /** brackets: question mentions non-paren bracket types → battery includes them. */
  multi?: boolean
  /** heap: 'min' | 'max' | null (plain heap / priority queue accepts either drain direction). */
  dir?: 'min' | 'max' | null
}

/** Ordered, guard-heavy detection. Null = no contract named → the tier abstains untouched. */
export function detectContract(question: string): DetectedContract | null {
  const q = askText(question)
  if (/linked[- ]?list/.test(q)) return { kind: 'linked-list' }
  if (/\blru\b|least[- ]recently[- ]used/.test(q)) return { kind: 'lru-cache' }
  if (/binary[- ]search[- ]tree|\bbst\b/.test(q)) return { kind: 'bst' }
  if (/binary[- ]search/.test(q)) return { kind: 'binary-search' }
  if (/(min|max)[- ]?heap|priority[- ]?queue|\bheap\b/.test(q) && !/heap (memory|dump|snapshot|corruption|overflow)|heap alloc/.test(q)) {
    return { kind: 'heap', dir: /min[- ]?heap/.test(q) ? 'min' : /max[- ]?heap/.test(q) ? 'max' : null }
  }
  if (/rate[- ]?limit|token[- ]?bucket|leaky[- ]?bucket/.test(q) ||
      (/sliding[- ]?window|fixed[- ]?window/.test(q) && /limit|rate|requests?/.test(q)) ||
      (/throttl/.test(q) && /requests?|api|calls? per/.test(q))) return { kind: 'rate-limiter' }
  if (/debounc/.test(q)) return { kind: 'debounce' }
  if (/throttl/.test(q)) return { kind: 'throttle' }
  // deque conventions (front AND back ops) don't pin FIFO — out of scope, not misjudged.
  // \bdeque\b, not /deque/: "dequeue" contains the substring and must NOT be excluded.
  if (/\bqueue\b/.test(q) && !/message queue|job queue|task queue|queue service|rabbitmq|kafka|sqs|\bdeque\b|double[- ]ended/.test(q)) return { kind: 'queue' }
  if (/\bstack\b/.test(q) && !/full[- ]?stack|tech[- ]stack|stack (trace|overflow)|call stack|mern|mean stack/.test(q)) return { kind: 'stack' }
  if (/event[- ]?emitter|pub[- ]?sub|publish[- ]?subscribe|event bus/.test(q)) return { kind: 'event-emitter' }
  if (/memoi[sz]/.test(q)) return { kind: 'memoize' }
  if (/fizz[- ]?buzz/.test(q)) return { kind: 'fizzbuzz' }
  if (/anagram/.test(q)) return { kind: 'anagram' }
  if (/(parenthes|bracket|brace)/.test(q) && /balanc|valid|match/.test(q)) {
    return { kind: 'brackets', multi: /bracket|brace|\[|\{/.test(q) }
  }
  if (/two[- ]?sum|find (a |the )?pair [^.]*sum/.test(q)) return { kind: 'two-sum' }
  if (/deep[- ]?(clone|copy)/.test(q)) return { kind: 'deep-clone' }
  if (/deep[- ]?equal/.test(q)) return { kind: 'deep-equal' }
  return null
}

// ── Answer-side declared surface (TS AST over the transpiled code) ────────────────────

interface DeclaredClass { name: string; methods: string[]; ctorParams: string[] }
interface Surface { classes: DeclaredClass[]; functions: string[] }

function declaredSurface(js: string): Surface {
  const sf = ts.createSourceFile('__answer.js', js, ts.ScriptTarget.ES2020, true)
  const classes: DeclaredClass[] = []
  const functions: string[] = []
  for (const st of sf.statements) {
    if (ts.isClassDeclaration(st) && st.name) {
      const methods: string[] = []
      let ctorParams: string[] = []
      for (const m of st.members) {
        if ((ts.isMethodDeclaration(m) || ts.isGetAccessor(m)) && m.name && ts.isIdentifier(m.name)) methods.push(m.name.text)
        if (ts.isConstructorDeclaration(m)) {
          ctorParams = m.parameters.map(p => (ts.isIdentifier(p.name) ? p.name.text : '{destructured}'))
        }
      }
      classes.push({ name: st.name.text, methods, ctorParams })
    } else if (ts.isFunctionDeclaration(st) && st.name) functions.push(st.name.text)
    else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer &&
            (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) functions.push(d.name.text)
      }
    }
  }
  return { classes, functions }
}

// ── Resolution: which declaration implements the asked contract ───────────────────────
// Node/ListNode/TreeNode are structure cells, never the contract's face.
const NODE_NAME = /^(list|tree|linked|dll|sll)?_?node$/i

const CLASS_NAME_RE: Partial<Record<Kind, RegExp>> = {
  'stack': /stack/i,
  'queue': /queue/i,
  'linked-list': /list/i,
  'lru-cache': /lru|cache/i,
  'rate-limiter': /limit|bucket|throttl/i,
  'bst': /tree|bst/i,
  'heap': /heap|priority|pq/i,
  'event-emitter': /emit|event|bus|pubsub|observ/i,
}

const has = (c: DeclaredClass, names: string[]) => names.some(n => c.methods.some(m => m.toLowerCase() === n))

/** Does this class carry a method set compatible with the kind? (fallback when names miss) */
function methodsFit(kind: Kind, c: DeclaredClass): boolean {
  switch (kind) {
    case 'stack': return has(c, ['push']) && has(c, ['pop'])
    case 'queue': return has(c, ['enqueue', 'push', 'add', 'offer']) && has(c, ['dequeue', 'shift', 'poll', 'remove', 'pop'])
    case 'linked-list': return has(c, ['append', 'push', 'add', 'addlast', 'insertlast', 'insert', 'prepend', 'unshift', 'addfirst', 'insertathead', 'insertatbeginning', 'insertfirst', 'addtohead'])
    case 'lru-cache': return has(c, ['get']) && has(c, ['put', 'set'])
    case 'rate-limiter': return has(c, ['acquire', 'tryacquire', 'allow', 'allowrequest', 'isallowed', 'tryconsume', 'consume', 'take', 'tryremovetokens', 'hit', 'request', 'removetokens', 'canproceed', 'shouldallow', 'handle'])
    case 'bst': return has(c, ['insert', 'add', 'put']) && has(c, ['contains', 'has', 'search', 'find', 'includes', 'lookup', 'inorder', 'inordertraversal', 'toarray'])
    case 'heap': return has(c, ['push', 'insert', 'add', 'enqueue', 'offer']) && has(c, ['pop', 'poll', 'extractmin', 'extractmax', 'extract', 'remove', 'dequeue', 'deletemin', 'deletemax'])
    case 'event-emitter': return has(c, ['on', 'subscribe', 'addlistener', 'addeventlistener']) && has(c, ['emit', 'publish', 'trigger', 'dispatch', 'fire'])
    default: return false
  }
}

function resolveClass(kind: Kind, surface: Surface): DeclaredClass | null {
  const pool = surface.classes.filter(c => !NODE_NAME.test(c.name))
  const nameRe = CLASS_NAME_RE[kind]
  const byName = nameRe ? pool.filter(c => nameRe.test(c.name)) : []
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) {
    const both = byName.filter(c => methodsFit(kind, c))
    return both.length === 1 ? both[0] : null
  }
  const byMethods = pool.filter(c => methodsFit(kind, c))
  return byMethods.length === 1 ? byMethods[0] : null
}

const FN_NAME_RE: Partial<Record<Kind, RegExp>> = {
  'memoize': /memo/i,
  'debounce': /debounc/i,
  'throttle': /throttl/i,
  'binary-search': /binar|bsearch|search/i,
  'fizzbuzz': /fizz/i,
  'anagram': /anagram/i,
  'brackets': /valid|balanc|paren|bracket|brace|match/i,
  'two-sum': /two_?sum|pairsum|findpair/i,
  'deep-clone': /clone|copy/i,
  'deep-equal': /equal|compare/i,
}

function resolveFunction(kind: Kind, surface: Surface): string | null {
  const re = FN_NAME_RE[kind]
  const byName = re ? surface.functions.filter(f => re.test(f)) : []
  if (byName.length === 1) return byName[0]
  if (byName.length === 0 && surface.functions.length === 1) return surface.functions[0]
  return null
}

// ── Sandbox prelude: fake clock + fake timers, installed BEFORE the candidate loads ───
// Pure JS (runs inside the vm). Lazy Date.now() math and setInterval-driven refill both
// answer to __advance(ms). Interval floor 1ms + a fire cap keep a pathological interval
// from spinning the advance loop.
const CLOCK_PRELUDE = `
var __vnow = __hostNow;
var __timers = []; var __tid = 1;
var __RealDate = Date;
Date = class extends __RealDate {
  constructor(...a) { if (a.length === 0) { super(__vnow) } else { super(...a) } }
  static now() { return __vnow }
};
Date.parse = __RealDate.parse; Date.UTC = __RealDate.UTC;
var performance = { now: function () { return __vnow } };
var setTimeout = function (fn, ms) { var a = [].slice.call(arguments, 2); __timers.push({ t: __vnow + Math.max(0, ms || 0), fn: function () { fn.apply(null, a) }, id: __tid, every: 0 }); return __tid++ };
var setInterval = function (fn, ms) { var a = [].slice.call(arguments, 2); var e = Math.max(1, ms || 1); __timers.push({ t: __vnow + e, fn: function () { fn.apply(null, a) }, id: __tid, every: e }); return __tid++ };
var clearTimeout = function (id) { __timers = __timers.filter(function (x) { return x.id !== id }) };
var clearInterval = clearTimeout;
function __advance(ms) {
  var end = __vnow + Math.max(0, ms);
  for (var fired = 0; fired < 10000; fired++) {
    var due = null;
    for (var i = 0; i < __timers.length; i++) if (__timers[i].t <= end && (due === null || __timers[i].t < due.t)) due = __timers[i];
    if (!due) break;
    __vnow = due.t;
    if (due.every) { due.t += due.every } else { __timers = __timers.filter(function (x) { return x !== due }) }
    try { due.fn() } catch (e) {}
  }
  __vnow = end;
}
`

// Harness-side helpers (script 2 — after the candidate has loaded).
const HELPERS = `
function __m(o, names) { for (var i = 0; i < names.length; i++) { if (o != null && typeof o[names[i]] === 'function') return names[i] } return null }
function __num(o, names) { for (var i = 0; i < names.length; i++) { if (o == null) break; var v = o[names[i]]; if (typeof v === 'function') { try { v = o[names[i]]() } catch (e) { continue } } if (typeof v === 'number') return v } return null }
function __absent(v) { return v === undefined || v === null || v === false || v === -1 }
function __fmt(v) { try { if (typeof v === 'string') return JSON.stringify(v); if (v && typeof v === 'object') { var s = JSON.stringify(v); return s && s.length > 60 ? s.slice(0, 60) + '…' : String(s) } return String(v) } catch (e) { return String(v) } }
function __sortedNums(a) { return a.slice().sort(function (x, y) { return x - y }) }
function __eq(a, b) { return JSON.stringify(a) === JSON.stringify(b) }
function __thenable(v) { return v != null && typeof v.then === 'function' }
`

// ── Per-contract harness builders ─────────────────────────────────────────────────────
// Each returns the JS for script 2. Conventions: __progress(label) before each check (hang
// attribution), __fail(check, counterexample, requirement) on a violated invariant,
// __abstain(reason) + return when calibration cannot establish judging authority.

function stackHarness(C: string): string {
  return `(function () {
  var s; try { s = new ${C}() } catch (e) { __abstain('constructing ${C}() threw: ' + e.message); return }
  var push = __m(s, ['push', 'add']); var pop = __m(s, ['pop'])
  if (!push || !pop) { __abstain('${C} lacks a push/pop surface'); return }
  __progress('LIFO order')
  s[push](10); s[push](20); s[push](30)
  var p1 = s[pop]()
  if (p1 !== 30) { __fail('LIFO order', 'push(10),push(20),push(30) then pop() → ' + __fmt(p1) + ' (expected 30, the most recent push)', 'pop() must return the MOST RECENTLY pushed value (LIFO)') }
  else {
    var p2 = s[pop](); var p3 = s[pop]()
    if (p2 !== 20 || p3 !== 10) __fail('LIFO drain', 'popping all three after push(10),push(20),push(30) → 30,' + __fmt(p2) + ',' + __fmt(p3) + ' (expected 30,20,10)', 'repeated pop() must drain elements in exact reverse push order')
  }
  var s2 = new ${C}(); s2[push](7)
  var peek = __m(s2, ['peek', 'top'])
  if (peek) {
    __progress('peek is non-destructive')
    var k1 = s2[peek](); var k2 = s2[peek]()
    if (k1 !== 7 || k2 !== 7) __fail('peek', 'push(7) then peek(),peek() → ' + __fmt(k1) + ',' + __fmt(k2) + ' (expected 7 both times)', 'peek() must return the top value WITHOUT removing it')
    else if (s2[pop]() !== 7) __fail('peek/pop agreement', 'after peek()=7, pop() did not return 7', 'pop() after peek() must return the same top value')
  }
  var s3 = new ${C}(); s3[push](1); s3[push](2); s3[push](3)
  var n = __num(s3, ['size', 'length', 'count'])
  if (n !== null) {
    __progress('size tracks pushes')
    if (n !== 3) __fail('size', 'after 3 pushes size/length reports ' + n, 'size must equal the number of elements currently on the stack')
  }
})()`
}

function queueHarness(C: string): string {
  return `(function () {
  var q; try { q = new ${C}() } catch (e) { __abstain('constructing ${C}() threw: ' + e.message); return }
  var add = __m(q, ['enqueue', 'push', 'add', 'offer'])
  var rem = __m(q, ['dequeue', 'shift', 'poll', 'remove', 'pop'])
  if (!add || !rem) { __abstain('${C} lacks an enqueue/dequeue surface'); return }
  __progress('FIFO order')
  q[add](10); q[add](20); q[add](30)
  var r1 = q[rem]()
  if (r1 !== 10) { __fail('FIFO order', add + '(10),' + add + '(20),' + add + '(30) then ' + rem + '() → ' + __fmt(r1) + ' (expected 10, the OLDEST element)', 'removal must return the OLDEST enqueued element first (FIFO)') }
  else {
    var r2 = q[rem](); var r3 = q[rem]()
    if (r2 !== 20 || r3 !== 30) __fail('FIFO drain', 'draining after adding 10,20,30 → 10,' + __fmt(r2) + ',' + __fmt(r3) + ' (expected 10,20,30)', 'repeated removal must drain elements in exact insertion order')
  }
  var q2 = new ${C}(); q2[add](5); q2[add](6)
  var peek = __m(q2, ['peek', 'front', 'first'])
  if (peek) {
    __progress('peek matches next removal')
    var k = q2[peek]()
    if (k !== 5) __fail('peek', 'after adding 5,6, ' + peek + '() → ' + __fmt(k) + ' (expected 5)', 'peek/front must return the element the next removal would return, without removing it')
  }
  var q3 = new ${C}(); q3[add](1); q3[add](2); q3[add](3)
  var n = __num(q3, ['size', 'length', 'count'])
  if (n !== null) {
    __progress('size tracks enqueues')
    if (n !== 3) __fail('size', 'after 3 enqueues size/length reports ' + n, 'size must equal the number of elements currently queued')
  }
})()`
}

function linkedListHarness(C: string): string {
  return `(function () {
  var l; try { l = new ${C}() } catch (e) { __abstain('constructing ${C}() threw: ' + e.message); return }
  var addNames = ['append', 'push', 'add', 'addLast', 'insertLast', 'insert', 'prepend', 'unshift', 'addFirst', 'insertAtHead', 'insertAtBeginning', 'insertFirst', 'addToHead']
  var add = null
  for (var i = 0; i < addNames.length; i++) { var nm = addNames[i]; if (typeof l[nm] === 'function' && l[nm].length <= 1) { add = nm; break } }
  if (!add) { __abstain('${C} has no arity-1 insertion method'); return }
  var observe = function (inst) {
    var ta = __m(inst, ['toArray', 'values', 'toList', 'asArray', 'print'])
    if (ta) { try { var a = inst[ta](); if (Array.isArray(a)) return a } catch (e) {} }
    var h = inst.head !== undefined ? inst.head : inst.first
    if (h === undefined && inst.getHead && typeof inst.getHead === 'function') { try { h = inst.getHead() } catch (e) {} }
    if (h !== undefined) {
      var out = []; var cur = h; var steps = 0
      while (cur != null && steps < 12) { out.push(cur.value !== undefined ? cur.value : (cur.val !== undefined ? cur.val : cur.data)); cur = cur.next; steps++ }
      if (steps >= 12) return 'CYCLE'
      return out
    }
    return null
  }
  __progress('insertion preserves elements and order')
  l[add](10); l[add](20); l[add](30)
  var seq = observe(l)
  if (seq === 'CYCLE') { __fail('traversal terminates', 'after inserting 10,20,30 traversal from head never reaches null within 12 steps — the list links form a cycle', 'node next-pointers must form a null-terminated chain (no cycles)'); return }
  if (Array.isArray(seq)) {
    var fwd = __eq(seq, [10, 20, 30]); var rev = __eq(seq, [30, 20, 10])
    if (!fwd && !rev) {
      if (!__eq(__sortedNums(seq.filter(function (v) { return typeof v === 'number' })), [10, 20, 30])) {
        __fail('elements preserved', 'after inserting 10,20,30 the list contains ' + __fmt(seq) + ' — elements were lost, duplicated, or corrupted', 'after inserting values 10,20,30 the list must contain exactly those three values')
      } else {
        __fail('consistent order', 'after inserting 10,20,30 the list reads ' + __fmt(seq) + ' — neither insertion order nor reverse-insertion order', 'traversal must yield elements in a consistent order (insertion order for tail-insert, reverse for head-insert)')
      }
    }
  }
  var n = __num(l, ['size', 'length', 'count', 'getSize'])
  if (n !== null) {
    __progress('size tracks insertions')
    if (n !== 3) __fail('size', 'after 3 insertions size/length reports ' + n, 'size must equal the number of nodes in the list')
  }
  var rem = __m(l, ['pop', 'removeLast', 'deleteLast', 'removeTail'])
  if (rem) {
    __progress('removal returns an end element')
    var v1 = l[rem]()
    var got1 = (v1 && typeof v1 === 'object' && v1.value !== undefined) ? v1.value : (v1 && typeof v1 === 'object' && v1.val !== undefined ? v1.val : v1)
    if (got1 !== 10 && got1 !== 30) {
      __fail('removal value', rem + '() after inserting 10,20,30 → ' + __fmt(v1) + ' — must return an END element (10 or 30), never a middle value or undefined', 'the removal method must return the value stored at the end of the list it removes from')
    } else {
      __progress('removing everything yields each element once')
      var v2 = l[rem](); var v3 = l[rem]()
      var g = function (x) { return (x && typeof x === 'object' && x.value !== undefined) ? x.value : (x && typeof x === 'object' && x.val !== undefined ? x.val : x) }
      var drained = __sortedNums([got1, g(v2), g(v3)].filter(function (v) { return typeof v === 'number' }))
      if (!__eq(drained, [10, 20, 30])) __fail('drain preserves elements', 'removing all three after inserting 10,20,30 returned ' + __fmt([got1, g(v2), g(v3)]) + ' — every inserted element must come back exactly once', 'removing every node one by one must return each inserted value exactly once')
    }
  } else if (seq === null) { __abstain('${C} exposes no way to observe contents (no toArray/head/removal)'); return }
  var l2 = new ${C}(); l2[add](1); l2[add](2); l2[add](3)
  var rv = __m(l2, ['reverse'])
  if (rv && Array.isArray(observe(l2))) {
    __progress('reverse reverses the order')
    var before = observe(l2)
    var ret = l2[rv]()
    var after = observe(l2)
    if ((!Array.isArray(after) || !__eq(after, before.slice().reverse())) && (ret == null || !Array.isArray(observe(ret)) || !__eq(observe(ret), before.slice().reverse()))) {
      __fail('reverse', 'reverse() on ' + __fmt(before) + ' left ' + __fmt(after) + (ret != null ? ' (returned ' + __fmt(observe(ret)) + ')' : ''), 'reverse() must yield the same elements in exactly reversed order')
    }
  }
  var l3 = new ${C}(); l3[add](10); l3[add](20); l3[add](30)
  var find = null
  var findNames = ['contains', 'has', 'includes', 'find', 'search']
  for (var j = 0; j < findNames.length; j++) { var fn2 = findNames[j]; if (typeof l3[fn2] === 'function' && l3[fn2].length === 1) { find = fn2; break } }
  if (find) {
    __progress('membership')
    var present = l3[find](20); var missing = l3[find](99)
    if (__absent(present)) __fail('membership present', find + '(20) → ' + __fmt(present) + ' after inserting 10,20,30 — an inserted value must be found', 'the search method must find a value that was inserted')
    if (!__absent(missing) && missing !== false && missing != null && missing !== -1 && missing !== undefined) __fail('membership absent', find + '(99) → ' + __fmt(missing) + ' — 99 was never inserted', 'the search method must report absence (null/undefined/false/-1) for values never inserted')
  }
})()`
}

function lruHarness(C: string): string {
  return `(function () {
  var mk = function () {
    var forms = [[2], [{ capacity: 2, max: 2, maxSize: 2, limit: 2, size: 2 }]]
    for (var i = 0; i < forms.length; i++) {
      var c; try { c = new ${C}(...forms[i]) } catch (e) { c = null }
      if (!c) continue
      var put = __m(c, ['put', 'set']); var get = __m(c, ['get'])
      if (!put || !get) return { fail: 'api' }
      try { c[put]('a', 1); if (c[get]('a') === 1) return { put: put, get: get, args: forms[i] } } catch (e) {}
    }
    return null
  }
  var cal = mk()
  if (cal && cal.fail === 'api') { __abstain('${C} lacks a get/put surface'); return }
  if (!cal) {
    __fail('get/put roundtrip', "put('a',1) then get('a') did not return 1 under any constructor form tried (capacity 2) — the cache cannot store and retrieve a value", "get(k) immediately after put(k, v) must return v")
    return
  }
  var fresh = function () { return new ${C}(...cal.args) }
  __progress('capacity eviction')
  var c1 = fresh(); c1[cal.put]('a', 1); c1[cal.put]('b', 2); c1[cal.put]('c', 3)
  var ga = c1[cal.get]('a'); var gb = c1[cal.get]('b'); var gc = c1[cal.get]('c')
  if (!__absent(ga)) __fail('capacity eviction', "capacity-2 cache: put a,b,c then get('a') → " + __fmt(ga) + ' — the least-recently-used entry (a) must have been evicted', 'inserting beyond capacity must evict the least-recently-used entry')
  if (gb !== 2 || gc !== 3) __fail('retained entries', "capacity-2 cache after put a,b,c: get('b') → " + __fmt(gb) + ", get('c') → " + __fmt(gc) + ' (expected 2 and 3)', 'the two most recently used entries must remain retrievable')
  __progress('recency refresh (LRU, not FIFO)')
  var c2 = fresh(); c2[cal.put]('a', 1); c2[cal.put]('b', 2)
  c2[cal.get]('a')
  c2[cal.put]('c', 3)
  var ra = c2[cal.get]('a'); var rb = c2[cal.get]('b')
  if (__absent(ra) || !__absent(rb)) __fail('recency refresh', "put a,b; get('a'); put c → get('a') → " + __fmt(ra) + ", get('b') → " + __fmt(rb) + " — reading 'a' made it most-recent, so 'b' must be the eviction victim (FIFO eviction is not LRU)", 'get(k) must refresh k to most-recently-used, so the OTHER entry is evicted on the next overflow')
})()`
}

function rateLimiterHarness(C: string, ctorParams: string[]): string {
  // Map the answer's OWN constructor parameter names onto (capacity 5, ~1 token/sec) — judging
  // under a mis-construction is how a correct impl gets false-rejected, so the AST-named mapping
  // ranks first, the kitchen-sink options object (feeds destructured ctors) second, and blind
  // positional guesses last, gated behind calibration.
  const val = (p: string): string | null => {
    const n = p.toLowerCase().replace(/[^a-z]/g, '')
    if (/^(capacity|maxtokens|max|limit|maxrequests|burst|tokens|buckedsize|bucketsize|maxcalls|count)$/.test(n)) return '5'
    if (/^(refillratepersecond|refillratepersec|refillrate|tokenspersecond|tokenspersec|rate|refillpersecond|refillspersecond)$/.test(n)) return '1'
    if (/^(windowms|window|intervalms|interval|refillintervalms|refillinterval|period|periodms|timewindow|windowsizems|windowsize|per|ms|durationms|duration|timeframe)$/.test(n)) return '1000'
    if (/^(refillamount|tokensperinterval|tokensperrefill|refilltokens)$/.test(n)) return '1'
    return null
  }
  const mapped = ctorParams.length > 0 && ctorParams.every(p => val(p) !== null)
    ? `[${ctorParams.map(p => val(p)).join(', ')}]` : 'null'
  return `(function () {
  var SINK = { capacity: 5, maxTokens: 5, max: 5, limit: 5, maxRequests: 5, burst: 5, tokens: 5,
    refillRate: 1, tokensPerSecond: 1, refillRatePerSecond: 1, rate: 1, refillAmount: 1, tokensPerInterval: 1,
    windowMs: 1000, window: 1000, intervalMs: 1000, interval: 1000, refillIntervalMs: 1000, refillInterval: 1000, period: 1000, periodMs: 1000, per: 1000, duration: 1000 }
  var astArgs = ${mapped}
  var forms = []
  if (astArgs) forms.push({ args: astArgs, named: true })
  // The kitchen-sink options object feeds destructured ctors correctly, but poured into a
  // POSITIONAL 2+-param ctor it constructs garbage — so it carries reject-authority (named)
  // only when the ctor takes at most one parameter (an options bag or nothing).
  forms.push({ args: [SINK], named: ${ctorParams.length <= 1 ? 'true' : 'false'} })
  forms.push({ args: [5, 1000], named: false }, { args: [5, 1], named: false }, { args: [5], named: false }, { args: [], named: false })
  var acqNames = ['acquire', 'tryAcquire', 'allow', 'allowRequest', 'isAllowed', 'tryConsume', 'consume', 'take', 'tryRemoveTokens', 'hit', 'request', 'removeTokens', 'canProceed', 'shouldAllow', 'handle']
  var attempt = function (form) {
    var c; try { c = new ${C}(...form.args) } catch (e) { return null }
    var acq = __m(c, acqNames)
    if (!acq) return { noApi: true }
    var call = function (inst) { return inst[acq].length >= 1 ? inst[acq](1) : inst[acq]() }
    var first
    try { first = call(c) } catch (e) { return { inst: c, acq: acq, call: call, firstThrew: true } }
    if (__thenable(first)) return { async: true }
    if (typeof first === 'number') return { numeric: true }
    // void-return convention: allowed = no throw, denied = throw. boolean: allowed = true(-ish object).
    var allowed = first === true || first === undefined ||
      (first && typeof first === 'object' && (first.allowed === true || first.success === true || first.ok === true))
    return { inst: c, acq: acq, call: call, firstAllowed: allowed, voidStyle: first === undefined }
  }
  var calibrated = null; var namedTried = false; var namedDeniedFirst = false; var sawAsync = false; var sawNumeric = false
  for (var i = 0; i < forms.length; i++) {
    var a = attempt(forms[i])
    if (!a) continue
    if (a.noApi) { __abstain('${C} exposes no acquire-like method'); return }
    if (a.async) { sawAsync = true; continue }
    if (a.numeric) { sawNumeric = true; continue }
    if (forms[i].named) namedTried = true
    if (a.firstThrew || !a.firstAllowed) { if (forms[i].named) namedDeniedFirst = true; continue }
    calibrated = { form: forms[i], acq: a.acq, voidStyle: a.voidStyle }
    break
  }
  if (!calibrated) {
    if (sawAsync) { __abstain('acquire returns a Promise — an async (waiting) limiter is valid and not judged here'); return }
    if (sawNumeric) { __abstain('acquire returns a number — remaining-token conventions are ambiguous, not judged'); return }
    if (namedTried && namedDeniedFirst) {
      __fail('fresh limiter admits', 'a freshly constructed limiter (capacity 5) denied the very FIRST request under every constructor interpretation, including one matching its own parameter names — the allow/deny logic is inverted or the bucket starts empty and never fills', 'a fresh limiter with capacity N must allow the first request')
      return
    }
    __abstain('could not construct + calibrate ${C} under any known convention'); return
  }
  var freshL = function () { return new ${C}(...calibrated.form.args) }
  var callOn = function (inst) {
    var r
    try { r = inst[calibrated.acq].length >= 1 ? inst[calibrated.acq](1) : inst[calibrated.acq]() } catch (e) { return false }
    if (calibrated.voidStyle) return true
    return r === true || (r && typeof r === 'object' && (r.allowed === true || r.success === true || r.ok === true))
  }
  __progress('burst within capacity is admitted')
  var L = freshL(); var burst = []
  for (var b = 0; b < 5; b++) burst.push(callOn(L))
  var denied = burst.indexOf(false)
  if (denied !== -1) __fail('burst within capacity', 'request #' + (denied + 1) + ' of 5 was denied on a fresh capacity-5 limiter with time frozen — under-admits within capacity', 'a fresh limiter with capacity 5 must admit 5 immediate requests')
  __progress('over-capacity burst is limited')
  var over = [callOn(L), callOn(L), callOn(L)]
  if (over[0] && over[1] && over[2]) __fail('over-capacity limit', 'requests #6, #7 and #8 were ALL admitted with time frozen on a capacity-5 limiter — it never limits', 'once capacity is exhausted and no time has passed, further requests must be denied')
  __progress('refill after time passes')
  __advance(10000)
  if (!callOn(L)) __fail('refill', 'after advancing the clock 10 seconds, a request is still denied — tokens never refill', 'after enough time passes (rate ~1 token/sec, window 1000ms), a previously exhausted limiter must admit requests again')
  __progress('post-refill burst is still capped')
  // 10 idle seconds at ~1 token/sec is 10 tokens of refill on a capacity-5 bucket: a correct
  // limiter CLAMPS to capacity, so after the refill check consumed one token at most 4 remain —
  // at least one of the next 5 immediate requests must be denied. Chunky elapsed*rate refill
  // without the clamp admits all 6 (over-admits after idle). Every calibrated convention has
  // capacity 5 (sliding window, fixed window, token bucket all deny the 6th here), and if the
  // refill check above already failed (nothing refills), these are all denied too — no double
  // judgment, so this check cannot fire on a correct or already-failed implementation.
  var post = []
  for (var r = 0; r < 5; r++) post.push(callOn(L))
  if (post.indexOf(false) === -1) __fail('post-refill cap clamp', 'after 10 idle seconds on a capacity-5 limiter, requests #2–#6 following the refill were ALL admitted — idle time accumulated more tokens than capacity (elapsed×rate refill without a cap clamp)', 'refill must never raise available tokens above capacity: after any idle period, a capacity-5 limiter must still deny the 6th immediate request')
})()`
}

function bstHarness(C: string): string {
  return `(function () {
  var t; try { t = new ${C}() } catch (e) { __abstain('constructing ${C}() threw: ' + e.message); return }
  var ins = __m(t, ['insert', 'add', 'put'])
  if (!ins) { __abstain('${C} has no insert method'); return }
  var vals = [50, 30, 80, 20, 40, 70, 90]
  for (var i = 0; i < vals.length; i++) t[ins](vals[i])
  var find = __m(t, ['contains', 'has', 'search', 'find', 'includes', 'lookup'])
  var walk = __m(t, ['inorder', 'inOrder', 'inorderTraversal', 'inOrderTraversal', 'toArray', 'toSortedArray', 'values'])
  if (!find && !walk) { __abstain('${C} exposes neither membership nor traversal'); return }
  if (find) {
    __progress('membership')
    var p = t[find](40); var a = t[find](99)
    if (__absent(p)) __fail('membership present', find + '(40) → ' + __fmt(p) + ' after inserting it — an inserted value must be found', 'search must find every inserted value')
    if (!__absent(a)) __fail('membership absent', find + '(99) → ' + __fmt(a) + ' — 99 was never inserted', 'search must report absence for values never inserted')
  }
  if (walk) {
    __progress('in-order traversal is sorted')
    var arr; try { arr = t[walk]() } catch (e) { arr = null }
    if (Array.isArray(arr)) {
      if (!__eq(arr.slice(), __sortedNums(vals))) __fail('inorder sorted', 'in-order traversal → ' + __fmt(arr) + ' (expected ascending ' + __fmt(__sortedNums(vals)) + ') — the BST ordering invariant is broken', 'in-order traversal of a BST must visit values in ascending order, containing every inserted value exactly once')
    }
  }
})()`
}

function heapHarness(C: string, dir: 'min' | 'max' | null): string {
  return `(function () {
  var h; try { h = new ${C}() } catch (e) { __abstain('constructing ${C}() threw: ' + e.message); return }
  var ins = __m(h, ['push', 'insert', 'add', 'enqueue', 'offer'])
  var rem = __m(h, ['pop', 'poll', 'extractMin', 'extractMax', 'extract', 'remove', 'dequeue', 'deleteMin', 'deleteMax'])
  if (!ins || !rem) { __abstain('${C} lacks an insert/extract surface'); return }
  var vals = [50, 10, 40, 20, 30]
  for (var i = 0; i < vals.length; i++) { if (h[ins].length >= 2) { h[ins](vals[i], vals[i]) } else { h[ins](vals[i]) } }
  __progress('drains in priority order')
  var outs = []
  for (var j = 0; j < 5; j++) {
    var v = h[rem]()
    if (v && typeof v === 'object') { v = v.value !== undefined ? v.value : (v.item !== undefined ? v.item : (v.val !== undefined ? v.val : (v.priority !== undefined ? v.priority : v))) }
    outs.push(v)
  }
  if (outs.some(function (v) { return typeof v !== 'number' })) { __abstain('extraction returns non-numeric shapes — not judged'); return }
  var asc = __eq(outs, [10, 20, 30, 40, 50]); var desc = __eq(outs, [50, 40, 30, 20, 10])
  var wantAsc = ${dir === 'min' ? 'true' : 'false'}; var wantDesc = ${dir === 'max' ? 'true' : 'false'}
  if (wantAsc && !asc) __fail('min-heap order', 'inserting 50,10,40,20,30 then extracting all → ' + __fmt(outs) + ' — a MIN-heap must drain ascending [10,20,30,40,50]', 'extract must always return the SMALLEST remaining value (min-heap)')
  else if (wantDesc && !desc) __fail('max-heap order', 'inserting 50,10,40,20,30 then extracting all → ' + __fmt(outs) + ' — a MAX-heap must drain descending [50,40,30,20,10]', 'extract must always return the LARGEST remaining value (max-heap)')
  else if (!wantAsc && !wantDesc && !asc && !desc) __fail('priority order', 'inserting 50,10,40,20,30 then extracting all → ' + __fmt(outs) + ' — a heap/priority queue must drain in fully sorted priority order', 'repeated extraction must return values in priority order (fully ascending or fully descending)')
})()`
}

function emitterHarness(C: string): string {
  return `(function () {
  var e; try { e = new ${C}() } catch (err) { __abstain('constructing ${C}() threw: ' + err.message); return }
  var on = __m(e, ['on', 'subscribe', 'addListener', 'addEventListener'])
  var emit = __m(e, ['emit', 'publish', 'trigger', 'dispatch', 'fire'])
  if (!on || !emit) { __abstain('${C} lacks an on/emit surface'); return }
  var calls = []
  var h = function () { calls.push([].slice.call(arguments)) }
  e[on]('x', h)
  __progress('listener receives its event and payload')
  e[emit]('x', 42)
  if (calls.length !== 1) __fail('delivery', "one emit('x', 42) invoked the listener " + calls.length + ' times (expected exactly 1)', "emitting an event once must invoke each of that event's listeners exactly once")
  else if (calls[0].indexOf(42) === -1) __fail('payload', "the 'x' listener was called without the emitted payload 42 (got " + __fmt(calls[0]) + ')', 'emit must pass the emitted arguments through to the listener')
  __progress('event names are isolated')
  var before = calls.length
  e[emit]('y', 1)
  if (calls.length !== before) __fail('isolation', "emit('y') invoked the 'x' listener — events must only reach their own listeners", "a listener registered for event 'x' must not fire for other event names")
  var off = __m(e, ['off', 'unsubscribe', 'removeListener', 'removeEventListener'])
  if (off) {
    __progress('off detaches')
    try { e[off]('x', h) } catch (err) {}
    var b2 = calls.length
    e[emit]('x', 7)
    if (calls.length !== b2) __fail('off', "after off('x', handler), emit('x') still invoked it", 'a removed listener must not be invoked by later emits')
  }
})()`
}

// ── Function-shaped contract harnesses ────────────────────────────────────────────────

function memoizeHarness(F: string): string {
  return `(function () {
  var n = 0
  var base = function (x) { n++; return x * 2 }
  var m; try { m = ${F}(base) } catch (e) { __fail('memoize returns a function', '${F}(fn) threw: ' + e.message, 'memoize(fn) must accept a function and return a function'); return }
  if (typeof m !== 'function') { __fail('memoize returns a function', '${F}(fn) returned ' + __fmt(m) + ' (expected a function)', 'memoize(fn) must return a callable wrapper'); return }
  __progress('caches repeated calls')
  var a = m(3); var b = m(3)
  if (a !== 6 || b !== 6) __fail('wrong result', 'memoized fn(3) → ' + __fmt(a) + ' then ' + __fmt(b) + ' (expected 6 both times)', 'the wrapper must return the same result the underlying function returns')
  if (n !== 1) __fail('caching', 'the underlying function ran ' + n + ' times for two identical calls fn(3) (expected 1 — the second must come from cache)', 'a repeated call with the same argument must NOT re-invoke the underlying function')
  __progress('distinct args recompute')
  var c = m(4)
  if (c !== 8) __fail('stale cache', 'memoized fn(4) → ' + __fmt(c) + ' (expected 8) — a different argument returned a stale cached value', 'a call with a NEW argument must invoke the underlying function and return its fresh result')
})()`
}

function debounceHarness(F: string): string {
  return `(function () {
  var n = 0; var last
  var f = function (x) { n++; last = x }
  var d; try { d = ${F}(f, 100) } catch (e) { __fail('debounce returns a function', '${F}(fn, 100) threw: ' + e.message, 'debounce(fn, wait) must return a function'); return }
  if (typeof d !== 'function') { __fail('debounce returns a function', '${F}(fn, 100) returned ' + __fmt(d), 'debounce(fn, wait) must return a callable wrapper'); return }
  __progress('burst coalesces')
  d(1); d(2); d(3)
  if (n > 1) __fail('coalescing', 'three rapid calls executed the wrapped fn ' + n + ' times before any time passed (expected at most 1) — the calls are not being coalesced', 'rapid successive calls within the wait window must coalesce into a single execution')
  __advance(150)
  if (n === 0) __fail('eventually fires', 'after the wait elapsed, the wrapped fn never executed for the burst', 'after the wait elapses following a burst, the wrapped fn must execute exactly once')
  else if (n > 1) __fail('single fire', 'one burst of three calls executed the wrapped fn ' + n + ' times (expected exactly 1)', 'one burst must produce exactly one execution')
  else if (last !== 3 && last !== 1) __fail('argument choice', 'the burst d(1);d(2);d(3) executed with argument ' + __fmt(last) + ' (expected 3 for trailing-edge or 1 for leading-edge)', 'the executed call must use the first or last argument of the burst, never a middle one')
  __progress('separate bursts fire separately')
  var n0 = n
  d(9); __advance(150)
  if (n !== n0 + 1) __fail('second burst', 'a later isolated call executed ' + (n - n0) + ' times (expected exactly 1)', 'each separate burst must produce its own single execution')
})()`
}

function throttleHarness(F: string): string {
  return `(function () {
  var n = 0
  var f = function () { n++ }
  var t; try { t = ${F}(f, 100) } catch (e) { __fail('throttle returns a function', '${F}(fn, 100) threw: ' + e.message, 'throttle(fn, interval) must return a function'); return }
  if (typeof t !== 'function') { __fail('throttle returns a function', '${F}(fn, 100) returned ' + __fmt(t), 'throttle(fn, interval) must return a callable wrapper'); return }
  __progress('rapid calls are limited')
  t(); t(); t(); t(); t()
  if (n > 1) __fail('limiting', 'five rapid calls executed the wrapped fn ' + n + ' times before any time passed (expected at most 1) — nothing is being throttled', 'within one interval, at most one immediate execution may happen no matter how many calls arrive')
  __progress('eventually executes')
  __advance(500)
  if (n === 0) __fail('starvation', 'the wrapped fn NEVER executed despite five calls and 500ms passing', 'a throttled function must still execute (leading and/or trailing edge) — it must not swallow all calls')
})()`
}

function binarySearchHarness(F: string): string {
  return `(function () {
  var arr = [2, 5, 8, 12, 16, 23, 38, 56, 72, 91]
  var call = null
  try { if (${F}(arr, 23) === 5) call = function (a, t) { return ${F}(a, t) } } catch (e) {}
  if (!call) { try { if (${F}(23, arr) === 5) call = function (a, t) { return ${F}(t, a) } } catch (e) {} }
  if (!call) {
    var probe; var threw = false
    try { probe = ${F}(arr, 23) } catch (e) { threw = true }
    if (!threw && typeof probe === 'number') {
      __fail('finds present element', '${F}(sortedArray, 23) → ' + __fmt(probe) + ' but 23 is at index 5 of ' + __fmt(arr), 'searching a sorted array for a present element must return that element\\'s index')
    } else { __abstain('could not calibrate ${F}\\'s signature against a known present element') }
    return
  }
  __progress('every present element found at its index')
  for (var i = 0; i < arr.length; i++) {
    var r = call(arr, arr[i])
    if (r !== i) { __fail('finds present element', '${F} searching for ' + arr[i] + ' in ' + __fmt(arr) + ' → ' + __fmt(r) + ' (expected index ' + i + ')', 'searching for any element present in the sorted array must return its exact index'); break }
  }
})()`
}

function fizzbuzzHarness(F: string): string {
  return `(function () {
  var norm = function (v) { return String(v).toLowerCase() }
  var r15; var threw = false
  try { r15 = ${F}(15) } catch (e) { threw = true }
  if (threw) { __abstain('${F}(15) threw — unknown signature'); return }
  if (Array.isArray(r15)) {
    __progress('array form 1..15')
    if (r15.length !== 15) { __fail('length', '${F}(15) returned an array of length ' + r15.length + ' (expected 15, one entry per number 1..15)', 'fizzbuzz(n) returning an array must have exactly n entries for 1..n'); return }
    if (norm(r15[2]) !== 'fizz') __fail('multiples of 3', 'entry for 3 is ' + __fmt(r15[2]) + ' (expected "Fizz")', 'multiples of 3 (not 5) must map to "Fizz"')
    if (norm(r15[4]) !== 'buzz') __fail('multiples of 5', 'entry for 5 is ' + __fmt(r15[4]) + ' (expected "Buzz")', 'multiples of 5 (not 3) must map to "Buzz"')
    if (norm(r15[14]) !== 'fizzbuzz') __fail('multiples of 15', 'entry for 15 is ' + __fmt(r15[14]) + ' (expected "FizzBuzz")', 'multiples of both 3 and 5 must map to "FizzBuzz"')
    if (norm(r15[0]) !== '1') __fail('plain numbers', 'entry for 1 is ' + __fmt(r15[0]) + ' (expected 1)', 'numbers divisible by neither 3 nor 5 must map to themselves')
    return
  }
  __progress('scalar form per number')
  if (norm(r15) !== 'fizzbuzz') { __fail('multiples of 15', '${F}(15) → ' + __fmt(r15) + ' (expected "FizzBuzz")', 'a multiple of both 3 and 5 must yield "FizzBuzz"') }
  var r3 = ${F}(3); var r5 = ${F}(5); var r7 = ${F}(7)
  if (norm(r3) !== 'fizz') __fail('multiples of 3', '${F}(3) → ' + __fmt(r3) + ' (expected "Fizz")', 'a multiple of 3 (not 5) must yield "Fizz"')
  if (norm(r5) !== 'buzz') __fail('multiples of 5', '${F}(5) → ' + __fmt(r5) + ' (expected "Buzz")', 'a multiple of 5 (not 3) must yield "Buzz"')
  if (norm(r7) !== '7') __fail('plain numbers', '${F}(7) → ' + __fmt(r7) + ' (expected 7)', 'a number divisible by neither must yield the number itself')
})()`
}

function anagramHarness(F: string): string {
  return `(function () {
  __progress('anagram pairs against letter-count reference')
  var cases = [['listen', 'silent', true], ['evil', 'vile', true], ['hello', 'world', false], ['aab', 'abb', false], ['abc', 'abcd', false]]
  for (var i = 0; i < cases.length; i++) {
    var a = cases[i][0]; var b = cases[i][1]; var want = cases[i][2]
    var r; try { r = ${F}(a, b) } catch (e) { __fail('anagram check', '${F}(' + __fmt(a) + ', ' + __fmt(b) + ') threw: ' + e.message, 'the function must accept two strings and return whether they are anagrams'); return }
    if (Boolean(r) !== want) { __fail('anagram check', '${F}(' + __fmt(a) + ', ' + __fmt(b) + ') → ' + __fmt(r) + ' (expected ' + want + ' — ' + (want ? 'same letters rearranged' : 'letter counts differ') + ')', 'two strings are anagrams exactly when their letter multisets are equal'); break }
  }
})()`
}

function bracketsHarness(F: string, multi: boolean): string {
  const cases = multi
    ? `[['()', true], ['()[]{}', true], ['{[]}', true], ['(]', false], ['([)]', false], ['(((', false], ['', true], [')(', false]]`
    : `[['()', true], ['(())', true], ['()()', true], ['(()', false], ['())', false], ['', true], [')(', false]]`
  return `(function () {
  __progress('balanced-bracket cases against reference')
  var cases = ${cases}
  for (var i = 0; i < cases.length; i++) {
    var s = cases[i][0]; var want = cases[i][1]
    var r; try { r = ${F}(s) } catch (e) { __fail('balance check', '${F}(' + __fmt(s) + ') threw: ' + e.message, 'the function must accept a string and return whether its brackets balance'); return }
    if (Boolean(r) !== want) { __fail('balance check', '${F}(' + __fmt(s) + ') → ' + __fmt(r) + ' (expected ' + want + ')', 'brackets balance exactly when every opener is closed by its matching closer in the correct nesting order'); break }
  }
})()`
}

function twoSumHarness(F: string): string {
  return `(function () {
  __progress('returned pair actually sums to the target')
  var cases = [[[2, 7, 11, 15], 9], [[3, 2, 4], 6], [[-1, 4, 8, 12], 3]]
  for (var i = 0; i < cases.length; i++) {
    var arr = cases[i][0]; var target = cases[i][1]
    var r; try { r = ${F}(arr.slice(), target) } catch (e) { __fail('two-sum', '${F}(' + __fmt(arr) + ', ' + target + ') threw: ' + e.message, 'the function must accept (numbers, target) and return the pair summing to target'); return }
    if (!Array.isArray(r) || r.length !== 2) { __abstain('${F} returned ' + __fmt(r) + ' — not a two-element pair; convention not judged'); return }
    var okIdx = Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[0] >= 0 && r[1] >= 0 && r[0] < arr.length && r[1] < arr.length && r[0] !== r[1] && (arr[r[0]] + arr[r[1]] === target)
    var okVal = arr.indexOf(r[0]) !== -1 && arr.indexOf(r[1]) !== -1 && (r[0] + r[1] === target)
    if (!okIdx && !okVal) { __fail('two-sum', '${F}(' + __fmt(arr) + ', ' + target + ') → ' + __fmt(r) + ' — neither a valid index pair nor a value pair summing to ' + target, 'the returned pair must identify two distinct elements of the input that sum to the target'); break }
  }
})()`
}

function deepCloneHarness(F: string): string {
  return `(function () {
  var src = { a: 1, b: { c: [1, 2, { d: 'x' }] }, e: [{ f: 2 }] }
  var r; try { r = ${F}(src) } catch (e) { __fail('clone', '${F}(obj) threw: ' + e.message, 'the function must accept a nested object and return a deep copy'); return }
  __progress('structural equality')
  if (!__eq(r, src)) { __fail('structural equality', 'the clone ' + __fmt(r) + ' differs structurally from the source', 'the clone must be structurally identical to the source'); return }
  __progress('deep independence (not shallow)')
  if (r === src || r.b === src.b || r.b.c === src.b.c || r.e[0] === src.e[0]) { __fail('deep independence', 'a nested object in the clone is the SAME reference as in the source — this is a shallow copy', 'every nested object/array must be a NEW object, not a shared reference'); return }
  r.b.c[2].d = 'CHANGED'; r.e[0].f = 999
  if (src.b.c[2].d !== 'x' || src.e[0].f !== 2) __fail('mutation isolation', 'mutating the clone changed the original object', 'mutating any depth of the clone must leave the original untouched')
})()`
}

function deepEqualHarness(F: string): string {
  return `(function () {
  __progress('deep-equality cases against reference')
  var cases = [
    [{ a: 1, b: [1, { c: 2 }] }, { a: 1, b: [1, { c: 2 }] }, true],
    [[1, [2, 3]], [1, [2, 3]], true], [5, 5, true], ['x', 'x', true],
    [{ a: 1 }, { a: 2 }, false], [[1, 2], [1, 2, 3], false], [{ a: 1 }, { a: 1, b: 2 }, false]
  ]
  for (var i = 0; i < cases.length; i++) {
    var a = cases[i][0]; var b = cases[i][1]; var want = cases[i][2]
    var r; try { r = ${F}(a, b) } catch (e) { __fail('deep equal', '${F}(' + __fmt(a) + ', ' + __fmt(b) + ') threw: ' + e.message, 'the function must accept two values and return whether they are deeply equal'); return }
    if (Boolean(r) !== want) { __fail('deep equal', '${F}(' + __fmt(a) + ', ' + __fmt(b) + ') → ' + __fmt(r) + ' (expected ' + want + ')', 'values are deeply equal exactly when their whole structure and leaf values match'); break }
  }
})()`
}

// ── vm runner: two scripts, one context — load jurisdiction vs battery jurisdiction ───

interface RunOutcome {
  loadError?: string
  abstained?: string
  timedOutDuring?: string
  failures: ContractDefect[]
  checksRun: number
}

function runHarness(candidateJs: string, harnessJs: string, timeoutMs: number): RunOutcome {
  const failures: ContractDefect[] = []
  let abstained: string | undefined
  let lastProgress = 'setup'
  let checksRun = 0

  const moduleObj: { exports: Record<string, unknown> } = { exports: {} }
  const sandbox: Record<string, unknown> = {
    __hostNow: Date.now(),
    __fail: (check: string, counterexample: string, requirement?: string) => {
      failures.push({ check: String(check), counterexample: String(counterexample), requirement: String(requirement ?? `must satisfy: ${check}`) })
    },
    __progress: (label: string) => { lastProgress = String(label); checksRun++ },
    __abstain: (reason: string) => { abstained = String(reason) },
    // Resolves only the safe builtins the answer imports (events/util/…); denies everything else.
    // The gate above already rejected third-party + I/O builtins, so this only serves the allowlist.
    require: makeSafeBuiltinRequire(`${process.cwd()}/package.json`),
    module: moduleObj,
    exports: moduleObj.exports,
    console: { log: () => {}, error: () => {}, warn: () => {}, info: () => {} },
    JSON, Math, Array, Object, String, Number, Boolean, Date, RegExp, Error, TypeError,
    RangeError, Map, Set, Promise, Symbol, BigInt, isNaN, parseInt, parseFloat,
  }
  const context = vm.createContext(sandbox)

  // Script 1: clock prelude + the candidate (its own demo runs here). A death here is the
  // plain-code tier's finding, not ours — report loadError so the caller abstains.
  try {
    new vm.Script(CLOCK_PRELUDE + '\n' + candidateJs).runInContext(context, { timeout: timeoutMs })
  } catch (e: any) {
    return { loadError: `${e?.name ?? 'Error'}: ${e?.message ?? e}`, failures: [], checksRun: 0 }
  }

  // Script 2: helpers + battery. Top-level class/function declarations from script 1 live in
  // the context's global lexical environment, so the battery sees them by name.
  try {
    new vm.Script(HELPERS + '\n' + harnessJs).runInContext(context, { timeout: timeoutMs })
  } catch (e: any) {
    const msg = String(e?.message ?? e)
    if (/Script execution timed out/.test(msg)) {
      return { timedOutDuring: lastProgress, failures, checksRun }
    }
    // A stray throw mid-battery is a candidate method blowing up on legitimate contract inputs.
    failures.push({
      check: lastProgress,
      counterexample: `a contract operation threw during "${lastProgress}": ${msg}`,
      requirement: `the operation exercised by "${lastProgress}" must not throw on ordinary inputs`,
    })
  }
  return { abstained, failures, checksRun }
}

// ── Assembly + verdict ────────────────────────────────────────────────────────────────

const CLASS_KINDS = new Set<Kind>(['stack', 'queue', 'linked-list', 'lru-cache', 'rate-limiter', 'bst', 'heap', 'event-emitter'])

function classHarness(det: DetectedContract, cls: DeclaredClass): string {
  switch (det.kind) {
    case 'stack': return stackHarness(cls.name)
    case 'queue': return queueHarness(cls.name)
    case 'linked-list': return linkedListHarness(cls.name)
    case 'lru-cache': return lruHarness(cls.name)
    case 'rate-limiter': return rateLimiterHarness(cls.name, cls.ctorParams)
    case 'bst': return bstHarness(cls.name)
    case 'heap': return heapHarness(cls.name, det.dir ?? null)
    case 'event-emitter': return emitterHarness(cls.name)
    default: return ''
  }
}

function fnHarness(det: DetectedContract, fn: string): string {
  switch (det.kind) {
    case 'memoize': return memoizeHarness(fn)
    case 'debounce': return debounceHarness(fn)
    case 'throttle': return throttleHarness(fn)
    case 'binary-search': return binarySearchHarness(fn)
    case 'fizzbuzz': return fizzbuzzHarness(fn)
    case 'anagram': return anagramHarness(fn)
    case 'brackets': return bracketsHarness(fn, det.multi === true)
    case 'two-sum': return twoSumHarness(fn)
    case 'deep-clone': return deepCloneHarness(fn)
    case 'deep-equal': return deepEqualHarness(fn)
    default: return ''
  }
}

/** Stem match so prong A can bind the question's relation-class to the answer's function name. */
const FAMILY_STEM: Array<[RegExp, RegExp]> = [
  [/^sort/, /sort/i], [/^reverse$/, /revers/i], [/^dedupe$/, /dedup|uniq|distinct/i],
  [/^max$/, /max|largest/i], [/^min$/, /min|small/i], [/^sum$/, /sum|total|add/i],
  [/^average$/, /av(g|erage)|mean/i], [/^flatten$/, /flat/i], [/^filter/, /filter|keep|even|odd|positive|select/i],
  [/^slug$/, /slug/i], [/^trim$/, /trim|strip/i], [/^uppercase$/, /upper/i], [/^lowercase$/, /lower/i],
]

/**
 * The behavioral-contract verdict for a code answer, judged against the QUESTION's contract.
 *
 * Tiers, first decisive verdict wins (abstains fall through):
 *   1. Stateful class contract (stack/queue/linked-list/LRU/limiter/BST/heap/emitter)
 *   2. Function contract (memoize/debounce/throttle/binary-search/… )
 *   3. Question-derived metamorphic relation bound to the answer's function (sort/reverse/…)
 *   4. Name-gated property families over every declared function (factorial/gcd/isPrime/…)
 */
export function verifyAnswerContract(
  question: string,
  answer: string,
  opts: { timeoutMs?: number } = {},
): ContractVerdict {
  const started = Date.now()
  const timeoutMs = opts.timeoutMs ?? 5000
  const done = (v: Omit<ContractVerdict, 'executionMs'>): ContractVerdict => ({ ...v, executionMs: Date.now() - started })
  const abstain = (reason: string, family = '', entry = ''): ContractVerdict =>
    done({ status: 'abstain', family, entry, reason, defects: [], checksRun: 0 })

  const blocks = answerCodeBlocks(answer)
  if (!blocks.length) return abstain('no code blocks in the answer — nothing to judge')
  const source = [...new Set(blocks.map(b => b.trim()))].join('\n')
  // A third-party import is the library path's job; an I/O-capable builtin we cannot safely provide.
  // But a pure computational builtin (events/util/stream/…) is providable, so contract answers built
  // on `import { EventEmitter } from 'events'` still get their LOGIC probed instead of laundering
  // past the tier on the mere presence of an import (cont.93).
  const { other } = classifyLibraryUsage(extractLibraryUsage(source))
  if (other.length > 0) return abstain(`answer imports ${other.join(', ')} — the library execution path judges it`)

  let js: string
  try {
    js = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, strict: false },
    }).outputText
  } catch (e: any) {
    return abstain(`answer code could not be transpiled: ${e?.message ?? e}`)
  }

  const surface = declaredSurface(js)
  const det = detectContract(question)

  const judge = (family: string, entry: string, harness: string): ContractVerdict | null => {
    const run = runHarness(js, harness, timeoutMs)
    if (run.loadError) return abstain(`answer code did not load (${run.loadError}) — structural death is the plain-code tier's finding`, family, entry)
    if (run.timedOutDuring) {
      return done({
        status: 'violations', family, entry,
        reason: `a ${family} operation never terminated (hung during: ${run.timedOutDuring}) — likely a loop whose pointer/counter never advances`,
        defects: [{
          check: 'termination',
          counterexample: `the check "${run.timedOutDuring}" did not complete within ${timeoutMs}ms — an operation loops forever on ordinary inputs`,
          requirement: 'every operation must terminate on small ordinary inputs',
        }],
        checksRun: run.checksRun,
      })
    }
    // Real violations outrank a later abstain: a battery that PROVED an invariant broken and
    // then lost its observation channel must still report what it proved.
    if (run.failures.length) {
      return done({
        status: 'violations', family, entry,
        reason: `${run.failures.length} ${family}-contract invariant${run.failures.length > 1 ? 's' : ''} violated under execution: ${run.failures[0].counterexample}`,
        defects: run.failures,
        checksRun: run.checksRun,
      })
    }
    if (run.abstained) return abstain(run.abstained, family, entry)
    if (run.checksRun === 0) return null // battery never engaged — treat as fall-through, not a certify
    return done({
      status: 'certified', family, entry,
      reason: `${run.checksRun} behavioral check${run.checksRun > 1 ? 's' : ''} of the ${family} contract held under execution (${entry})`,
      defects: [], checksRun: run.checksRun,
    })
  }

  // Tier 1+2: the asked contract.
  if (det) {
    if (CLASS_KINDS.has(det.kind)) {
      const cls = resolveClass(det.kind, surface)
      if (cls) {
        const v = judge(det.kind, cls.name, classHarness(det, cls))
        if (v) return v
      }
      // No resolvable class → the ask names a stateful contract the answer didn't legibly
      // implement. That alone is not proof of wrongness (prose may explain, code may be partial)
      // — abstain rather than guess.
    } else {
      const fn = resolveFunction(det.kind, surface)
      if (fn) {
        const v = judge(det.kind, fn, fnHarness(det, fn))
        if (v) return v
      }
    }
  }

  // Tier 3: metamorphic relation from the question, bound to the answer's own function.
  // The probe entry makes FAMILY detection independent of the question naming a function —
  // "write a function to sort an array ascending" names none, but the relation-class is there.
  const meta0 = deriveMetamorphicSpec(question, '__probe__')
  if (meta0 && surface.functions.length > 0) {
    const stem = FAMILY_STEM.find(([famRe]) => famRe.test(meta0.family))?.[1]
    const byStem = stem ? surface.functions.filter(f => stem.test(f)) : []
    const entry = byStem.length === 1 ? byStem[0] : (surface.functions.length === 1 ? surface.functions[0] : null)
    if (entry) {
      const spec = deriveMetamorphicSpec(question, entry)
      if (spec) {
        const harness = assertionHarness(spec.assertions)
        const v = judge(spec.family, entry, harness)
        if (v) return v
      }
    }
  }

  // Tier 4: name-gated property families over every declared function (factorial, gcd, …).
  for (const fn of surface.functions) {
    const ps = propertyForFunction(fn)
    if (!ps) continue
    const v = judge(ps.family, fn, assertionHarness(ps.assertions))
    if (v) return v
  }

  return abstain(det ? `detected a ${det.kind} ask but found no judgeable implementation in the answer` : 'no contract family detected for this question')
}

/** Wrap prop/check assertion strings (metamorphicSpec / propertyVerifier shape) for the vm. */
function assertionHarness(assertions: string[]): string {
  const body = assertions
    .map(a => `try { ${a} } catch (e) { __fail('assertion', 'assertion threw: ' + (e && e.message ? e.message : e), 'the implementation must not throw while its defining properties are checked') }`)
    .join(';\n')
  return `
function prop(label, cond) { __progress(label); if (!cond) __fail(label, 'property violated: ' + label, 'the implementation must satisfy: ' + label) }
function check(label, fn) { __progress(label); try { var d = fn(); if (d) __fail(label, typeof d === 'string' ? d : 'check failed: ' + label, typeof d === 'string' ? d : 'the implementation must satisfy: ' + label) } catch (e) { __fail(label, label + ' [threw: ' + (e && e.message ? e.message : e) + ']', 'the implementation must satisfy: ' + label) }
}
${body}
`
}

// ── Repair support ────────────────────────────────────────────────────────────────────

export interface ContractRepairSpec {
  entry: string
  family: string
  /** Forward requirements for a CLEAN re-synthesis — never derived from the rejected code. */
  constraints: string[]
  /** Zero-model verified reference for metamorphic families ("Crucible IS the model"), else null. */
  canonical: string | null
}

/**
 * Everything the seam's repair loop needs, with the cont.89 rule enforced by construction:
 * constraints are the defects' forward `requirement` lines (what a correct implementation MUST
 * do), never the rejected artifact or a description of its behavior.
 */
export function contractRepairSpec(question: string, verdict: ContractVerdict): ContractRepairSpec {
  const spec = verdict.entry ? deriveMetamorphicSpec(question, verdict.entry) : deriveMetamorphicSpec(question)
  const canonical = spec && spec.family === verdict.family ? canonicalImpl(spec) : null
  const constraints = [...new Set(verdict.defects.map(d => d.requirement))]
  return { entry: verdict.entry, family: verdict.family, constraints, canonical }
}

/**
 * The one-line API requirement a fresh synthesis must satisfy for the asked contract — derived
 * from the same aliases/invariants the battery calibrates against, so the ask and the judge
 * agree. Used by the seam's no-code repair: a collapse-shaped non-answer gives the retry no
 * violations to learn from, so the KIND's own contract supplies the forward constraint.
 */
export function contractAskHint(kind: string): string | null {
  switch (kind) {
    case 'stack': return 'Expose push(value) and pop() where pop returns the most recently pushed value (LIFO).'
    case 'queue': return 'Expose enqueue(value) and dequeue() where dequeue returns the oldest value (FIFO).'
    case 'linked-list': return 'Expose an append/push method, a pop/remove method, and a toArray() that returns the stored values in order.'
    case 'lru-cache': return 'Take the capacity in the constructor and expose get(key) and put(key, value) with least-recently-used eviction.'
    case 'rate-limiter': return 'Expose an acquire() (or allow()) method that returns true when a request is admitted and false when rate-limited, with tokens refilling as time passes.'
    case 'bst': return 'Expose insert(value), contains(value), and an inorder() traversal returning values ascending.'
    case 'heap': return 'Expose push/insert and pop/extract where repeated extraction returns values in priority order.'
    case 'event-emitter': return 'Expose on(event, handler), emit(event, ...args), and off(event, handler).'
    case 'memoize': return 'memoize(fn) must return a wrapper that calls fn at most once per distinct argument and returns the cached result on repeats.'
    case 'debounce': return 'debounce(fn, wait) must return a wrapper that coalesces rapid calls into a single execution after the wait.'
    case 'throttle': return 'throttle(fn, interval) must return a wrapper that executes at most once per interval.'
    case 'binary-search': return 'The function must take (sortedArray, target) and return the index of the target when present.'
    default: return null
  }
}

/**
 * Swap a certified repair into the answer: the FIRST fenced block becomes `code`, every later
 * fence is dropped (they demo/duplicate the code being replaced — keeping them would ship the
 * rejected artifact alongside its fix). Prose is preserved. Pure; the caller re-verifies the
 * result through the full gate stack before adopting it.
 */
export function replaceAnswerCodeBlocks(answer: string, code: string, lang = 'ts'): string {
  let first = true
  const replaced = answer.replace(/```[\w-]*\n[\s\S]*?```/g, () => {
    if (first) { first = false; return '```' + lang + '\n' + code.replace(/\n?$/, '\n') + '```' }
    return ''
  })
  return replaced.replace(/\n{3,}/g, '\n\n')
}
