export const meta = {
  name: 'skill-author-batch',
  description: 'Author + adversarially harden ~128 oracle-verifiable coding skills across 16 families',
  phases: [
    { title: 'Author', detail: 'one agent per family drafts ~8 CatalogEntry skills' },
    { title: 'Harden', detail: 'independent agent verifies each against the oracle and writes the JSON batch' },
  ],
}

// Existing skill ids/filenames — new skills MUST NOT collide with any of these.
const TAKEN = `aStarSearch actorSystem ahoCorasick arcCache arrayDiff arrayUtils articulationPoints asyncPatterns asyncQueue avlTree barrierSync base64 batchProcessor bellmanFord bfsDfs bimap binarySearch bipartiteMatch bitUtils bloomCountFilter bloomFilter btree cacheAside calendarQueue camelCase capitalize chunk circuitBreaker clamp clockHand colorUtils combinations commandPattern compact consistentHashing convolution cookieParse countBy countMinSketch countOccurrences crdt crdtLww cryptoHash cspChannel csvParse csvParser cuckooFilter dateFormat dateUtils dawg debounceThrottle decoratorPattern deepClone deepFreeze deepMerge dependencyInjector deque dijkstra dijkstraHeap disjointSet dotenvParse doublyLinkedList editDistance errorUtils escapeHtml eventEmitter eventEmitterSimple fenwickTree fft fibonacciHeap flatten flattenObject floydWarshall fnUtils formatBytes formatNumber fpUtils futurePromise geometryPrimitives gossipProtocol graph graphSimple groupBy hashUtils heap hexEncode hierarchicalTimer httpRouter hungarian hyperLogLog hyperLogLogPlus immutableStack iniParse intervalTimer intervalTree invIndex invert isEmail isPalindrome isURL isUUID iteratorPattern jsonDiff jsonParser jsonUtils kdTree kmpSearch kruskal leftistHeap linAlgebra lruCache lruCacheSimple lruK lruTtlStore lsmTree luhn manacher mapValues mathStats matrix matrixExponential maxFlow measureTime memoize memoizeTTL mergeSort merkleTree minHeap minMaxHeap monteCarlo mst multimap numberFormatUtils numberTheory numberWords objectDiff objectPath objectPool observable observerPattern octTree parseNumber parserCombinator pascalCase pathUtils percent persistentArray pickOmit pipeline polynomialHash prattParser prim promisePool promiseQueue promiseUtils pubSub pubSubBroker quadTree queryPlanner queryString queue quickSelect quotientFilter radixSort raftConsensus randomInt range rateLimiter redBlackTree reservoirSampling retry reverseString ringBuffer rollingHash rope rot13 rtree safeJSON schemaValidate searchUtils segmentTree semaphore semver setOps shuffle signal skipList sleep slidingWindow slug snakeCase sorting sparseTable splayTree sstable stack stateMachine statisticsLib strategyPattern stringExtras stringPadding stringSearch stringValidators stronglyConnected suffixArray sumBy tableFormat templateEngine textAnalysis timerWheel tokenizer topoSort topologicalSort treap trie trieCompressed trieSimple truncate twoThreeTree typeGuards typeUtils unionFind unique urlUtils uuid vEBTree vectorClock walLog waveletTree weightedGraph wordWrap workQueue workStealing xorFilter xorLinkedList zFunction zip`

const RULES = `
You are authoring entries for Crucible's verified-skill catalog. Each entry becomes a deterministic,
oracle-verified code generator. ZERO model inference at runtime — the impl IS the answer.

A CatalogEntry is a JSON object with EXACTLY these fields:
  id:        kebab-case unique id (e.g. "dijkstra-distances")
  filename:  camelCase unique filename stem (e.g. "dijkstraDistances")
  summary:   one-sentence human description. CRITICAL: it must CONTAIN the natural-language
             keywords your match patterns key on (the summary is reused as the proof spec).
  defaultPath: "src/<filename>.ts"
  exports:   array of the EXACT exported symbol names (functions or classes)
  patterns:  array of { re: <regex source string>, weight: <number> } scoring rules
  impl:      TypeScript source string that exports EXACTLY the names in \`exports\`
  tests:     array of { desc, call, want } — the adversarial hidden suite

HARD RULES (a violation = the oracle drops your skill):
1. filename AND id must be globally unique and MUST NOT be any existing name (provided below).
2. PATTERN/SELF-MATCH RULE — this is the #1 cause of rejection. The proof spec is:
     "<summary> at <defaultPath>.\\nexport function <export1>(...): unknown {}\\n..."
   Your patterns, scored against THAT text, must sum to >= 0.5. Guarantee it by including
   ONE pattern whose regex matches your exact primary export name with weight >= 0.5, e.g.
   for export "dijkstraDistances": { "re": "\\\\bdijkstraDistances\\\\b", "weight": 0.5 }.
   Then add 2-3 more lower-weight patterns matching keywords that appear in your summary
   (so real prose specs also match). Escape backslashes for JSON: \\b becomes "\\\\b".
3. impl must export exactly the declared exports, be fully self-contained, and run under tsx
   (Node builtins like crypto/fs are allowed). NO placeholders, NO TODOs, NO "...".
4. DETERMINISM: never call Math.random() or Date.now() inside impl in a way a test depends on.
   For randomness, take an injected rng: () => number (a function returning [0,1)). For time,
   take an injected Date or numeric clock. Tests must be fully reproducible.
5. TESTS — at least 7 per skill, adversarial: empty input, boundaries, negatives, large values,
   the tricky edge case for THIS algorithm. The runner does:
       JSON.stringify(await <call>) === JSON.stringify(<want>)
   So both \`call\` and \`want\` are raw JS EXPRESSIONS spliced verbatim:
     - number:    call:"gcd(12,8)"        want:"4"
     - string:    call:'slug("Hi There")' want:'"hi-there"'   (note the quotes inside want)
     - array:     call:"range(1,4)"        want:"[1,2,3]"
     - object:    call:"parse(\\"a=1\\")"   want:'{"a":"1"}'
     - boolean:   call:"isPrime(7)"        want:"true"
     - null:      call:"f(x)"              want:"null"
     - undefined: call:"arr.pop()"         want:"undefined"
     - multi-step: wrap in an IIFE: call:"(() => { const s=new Stack(); s.push(1); return s.pop() })()"
       async: call:"(async () => { ... })()"
   Compute every \`want\` by mentally EXECUTING your impl. Wrong expected values get the skill dropped.

Return ONLY through the structured schema. Make the impls genuinely correct senior-engineer code.
`

const ENTRY_SCHEMA = {
  type: 'object',
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          filename: { type: 'string' },
          summary: { type: 'string' },
          defaultPath: { type: 'string' },
          exports: { type: 'array', items: { type: 'string' } },
          patterns: {
            type: 'array',
            items: {
              type: 'object',
              properties: { re: { type: 'string' }, weight: { type: 'number' } },
              required: ['re', 'weight'],
            },
          },
          impl: { type: 'string' },
          tests: {
            type: 'array',
            items: {
              type: 'object',
              properties: { desc: { type: 'string' }, call: { type: 'string' }, want: { type: 'string' } },
              required: ['desc', 'call', 'want'],
            },
          },
        },
        required: ['id', 'filename', 'summary', 'defaultPath', 'exports', 'patterns', 'impl', 'tests'],
      },
    },
  },
  required: ['entries'],
}

const HARDEN_SCHEMA = {
  type: 'object',
  properties: {
    key: { type: 'string' },
    file: { type: 'string' },
    count: { type: 'number' },
    ids: { type: 'array', items: { type: 'string' } },
    dropped: { type: 'array', items: { type: 'string' } },
  },
  required: ['key', 'file', 'count', 'ids', 'dropped'],
}

const FAMILIES = [
  { key: 'graphPaths', title: 'Graph shortest paths', briefs: [
    'dijkstraDistances(n:number, edges:[number,number,number][], src:number):number[] — single-source shortest distances over a DIRECTED weighted graph, edge [u,v,w]; unreachable = Infinity; nodes 0..n-1; weights non-negative',
    'bellmanFordDistances(n:number, edges:[number,number,number][], src:number):number[]|null — shortest distances allowing negative edges; return null if a negative cycle is reachable from src; unreachable = Infinity',
    'floydAllPairs(dist:number[][]):number[][] — all-pairs shortest paths given an adjacency matrix (Infinity = no edge, 0 on diagonal); returns a new matrix',
    'bfsHopCounts(n:number, adj:number[][], src:number):number[] — shortest hop count in an unweighted graph given adjacency lists; unreachable = -1',
    'topoOrderKahn(n:number, edges:[number,number][]):number[] — a topological order via Kahn (smallest-id first when tied); return [] if the graph has a cycle',
    'connectedComponentsCount(n:number, edges:[number,number][]):number — number of connected components in an UNDIRECTED graph',
    'hasCycleUndirected(n:number, edges:[number,number][]):boolean — true if an undirected graph contains a cycle (ignore duplicate edges as parallel? treat each listed edge once)',
    'gridBfsSteps(grid:number[][], sr:number, sc:number, tr:number, tc:number):number — min 4-directional steps from (sr,sc) to (tr,tc); 1 = wall, 0 = open; -1 if unreachable',
  ]},
  { key: 'graphStruct', title: 'Graph structure & MST', briefs: [
    'DSU class (export class DSU) with constructor(n), find(x):number (path compression), union(a,b):void, connected(a,b):boolean, count():number remaining sets',
    'isBipartiteGraph(n:number, edges:[number,number][]):boolean — 2-colorability of an undirected graph',
    'kruskalMstWeight(n:number, edges:[number,number,number][]):number — total weight of the minimum spanning forest (sum across components)',
    'primMstWeight(n:number, edges:[number,number,number][]):number — MST weight via Prim from node 0; if disconnected, sum each component MST',
    'detectCycleDirected(n:number, edges:[number,number][]):boolean — true if a directed graph has a cycle',
    'topoSortLevels(n:number, edges:[number,number][]):number[][] — Kahn grouped by level; each inner array sorted ascending; [] (empty outer) if cyclic',
    'transitiveClosure(n:number, edges:[number,number][]):boolean[][] — reachability matrix (a node reaches itself = true)',
    'degreeSequence(n:number, edges:[number,number][]):number[] — undirected degree of each node, sorted descending',
  ]},
  { key: 'dpAlgos', title: 'Dynamic programming', briefs: [
    'longestCommonSubsequence(a:string, b:string):number — length of the LCS',
    'longestIncreasingSubsequence(arr:number[]):number — length of the strictly increasing LIS',
    'knapsack01(weights:number[], values:number[], capacity:number):number — max value, each item used at most once',
    'coinChangeMin(coins:number[], amount:number):number — min coins to make amount, or -1 if impossible (unlimited coins)',
    'coinChangeWays(coins:number[], amount:number):number — number of distinct combinations summing to amount (order-independent)',
    'maxSubArraySum(arr:number[]):number — maximum contiguous subarray sum (Kadane); for all-negative returns the largest single element',
    'editDistanceLev(a:string, b:string):number — Levenshtein edit distance',
    'subsetSumExists(arr:number[], target:number):boolean — whether some subset of non-negative ints sums to target',
  ]},
  { key: 'strAlgos', title: 'String algorithms', briefs: [
    'kmpSearchIndex(text:string, pattern:string):number — first index of pattern via KMP, or -1; empty pattern returns 0',
    'rabinKarpAll(text:string, pattern:string):number[] — all start indices where pattern occurs (overlaps allowed); empty pattern returns []',
    'zFunctionArray(s:string):number[] — the Z-array (z[0] is conventionally 0 or s.length; use s.length)',
    'longestPalindromicSubstr(s:string):string — a longest palindromic substring (first if ties)',
    'runLengthEncode(s:string):string and runLengthDecode(s:string):string — RLE like "aaabb"<->"3a2b"; both exports; decode(encode(x))===x',
    'longestCommonPrefixStrs(strs:string[]):string — longest common prefix of an array of strings; [] -> ""',
    'reverseWords(s:string):string — reverse word order, collapsing extra spaces to single, trimmed',
    'isRotationOf(a:string, b:string):boolean — true if b is a rotation of a (same length, b is substring of a+a)',
  ]},
  { key: 'numTheory', title: 'Number theory', briefs: [
    'sieveOfEratosthenes(n:number):number[] — all primes <= n (n<2 -> [])',
    'primeFactorize(n:number):number[] — prime factors with multiplicity, ascending (e.g. 12 -> [2,2,3]); n<2 -> []',
    'modPow(base:number, exp:number, mod:number):number — (base^exp) mod m via fast exponentiation; exp>=0',
    'extendedGcd(a:number, b:number):[number,number,number] — [g,x,y] with a*x+b*y=g',
    'modInverse(a:number, m:number):number|null — modular inverse of a mod m in [0,m), or null if none',
    'binomialCoeff(n:number, k:number):number — n choose k exact for small n; 0 if k<0 or k>n',
    'integerSqrt(n:number):number — floor of sqrt(n) for n>=0, exact (no float error)',
    'digitSum(n:number):number — sum of decimal digits of abs(n)',
  ]},
  { key: 'statsAlgos', title: 'Statistics', briefs: [
    'variancePop(arr:number[]):number — population variance; [] -> NaN',
    'standardDeviation(arr:number[]):number — population standard deviation; [] -> NaN',
    'percentileValue(arr:number[], p:number):number — the p-th percentile (0..100) with linear interpolation between closest ranks; sorts a copy',
    'pearsonCorrelation(x:number[], y:number[]):number — Pearson correlation coefficient (assume equal length >=2)',
    'linearRegression(x:number[], y:number[]):{slope:number,intercept:number} — least-squares fit',
    'exponentialMovingAverage(arr:number[], alpha:number):number[] — EMA series, ema[0]=arr[0]',
    'zScoreNormalize(arr:number[]):number[] — (x-mean)/stddev for each (population stddev); if stddev 0 -> all 0',
    'movingMedian(arr:number[], window:number):number[] — median of each sliding window of given size (windows that fit); empty if window>len',
  ]},
  { key: 'geometry2d', title: '2D geometry', briefs: [
    'distancePoints(ax:number, ay:number, bx:number, by:number):number — Euclidean distance',
    'polygonAreaShoelace(points:[number,number][]):number — absolute polygon area via shoelace; <3 points -> 0',
    'pointInPolygon(px:number, py:number, polygon:[number,number][]):boolean — ray casting; point on edge may be either, document choice',
    'segmentsIntersect(p1:[number,number], p2:[number,number], p3:[number,number], p4:[number,number]):boolean — do two segments intersect (proper or touching)',
    'convexHullArea(points:[number,number][]):number — area of the convex hull (Andrew monotone chain then shoelace); <3 -> 0',
    'manhattanDistance(ax:number, ay:number, bx:number, by:number):number — L1 distance',
    'boundingBox(points:[number,number][]):[number,number,number,number] — [minX,minY,maxX,maxY]; [] -> [0,0,0,0]',
    'rotatePointDeg(x:number, y:number, cx:number, cy:number, deg:number):[number,number] — rotate point around center by degrees CCW; round to 6 decimals',
  ]},
  { key: 'randomUtils', title: 'Seeded random & sampling', briefs: [
    'mulberry32(seed:number):() => number — returns a deterministic PRNG function yielding values in [0,1)',
    'shuffleSeeded(arr:T[], seed:number):T[] — pure Fisher-Yates shuffle using mulberry32(seed); does not mutate input; generic via <T>',
    'weightedChoice(items:T[], weights:number[], r:number):T — pick item by cumulative weights where r in [0,1); generic <T>',
    'reservoirSampleSeeded(arr:T[], k:number, seed:number):T[] — k-sample via reservoir with seeded rng; generic <T>',
    'randomIntInclusive(min:number, max:number, rng:() => number):number — integer in [min,max] using injected rng',
    'sampleWithoutReplacement(arr:T[], k:number, seed:number):T[] — k distinct elements, seeded; generic <T>',
    'randomStringFrom(length:number, alphabet:string, rng:() => number):string — string drawn from alphabet using injected rng',
    'rollDice(sides:number, count:number, rng:() => number):number — sum of count dice each 1..sides using injected rng',
  ]},
  { key: 'parsersB', title: 'Format parsers', briefs: [
    'parseSemverParts(v:string):{major:number,minor:number,patch:number,prerelease:string}|null and compareSemver(a:string,b:string):number (-1/0/1); both exports',
    'globToRegExpSource(glob:string):string returns a RegExp source string, and globMatch(glob:string,str:string):boolean; * matches within a segment, ? one char',
    'parseQueryParams(qs:string):Record<string,string> — parse a URL query string (leading ? optional), URL-decoded; last value wins on repeats',
    'parseCronFields(expr:string):{minute:string,hour:string,dayOfMonth:string,month:string,dayOfWeek:string}|null — split a 5-field cron expr; null if not exactly 5 fields',
    'parseDataUri(uri:string):{mime:string,isBase64:boolean,data:string}|null — parse a data: URI; null if malformed',
    'stripAnsiCodes(s:string):string — remove ANSI escape color codes',
    'parseRangeSpec(spec:string):number[] — expand "1-3,5,7-8" to [1,2,3,5,7,8]; ascending; ignore spaces',
    'parseAcceptHeader(h:string):string[] — media types from an HTTP Accept header, ordered by q-value desc (default q=1), stable on ties',
  ]},
  { key: 'validatorsB', title: 'Validators', briefs: [
    'luhnCheck(num:string):boolean — Luhn checksum validity (digits only, ignore spaces)',
    'isISBN(s:string):boolean — valid ISBN-10 or ISBN-13 (ignore hyphens/spaces)',
    'isEAN13(s:string):boolean — valid EAN-13 barcode checksum',
    'isE164Phone(s:string):boolean — matches E.164 (+ then 1..15 digits, no leading zero after +)',
    'isUUIDv4Strict(s:string):boolean — strict UUID v4 format',
    'isMacAddress(s:string):boolean — colon or hyphen separated 6-octet MAC',
    'isCreditCardType(s:string):string — returns "visa"|"mastercard"|"amex"|"discover"|"unknown" by prefix/length (ignore spaces)',
    'semverSatisfies(version:string, range:string):boolean — supports exact, ^x.y.z (compatible), ~x.y.z (patch), and >=x.y.z',
  ]},
  { key: 'encodingB', title: 'Encoding & hashing', briefs: [
    'base32Encode(s:string):string and base32Decode(s:string):string — RFC4648 base32 (with = padding); decode(encode(x))===x; both exports',
    'crc32(s:string):number — CRC-32 checksum as an unsigned 32-bit integer',
    'fnv1aHash(s:string):number — 32-bit FNV-1a hash as unsigned integer',
    'toBase64Url(s:string):string and fromBase64Url(s:string):string — URL-safe base64 (no padding); roundtrips; both exports',
    'percentEncode(s:string):string and percentDecode(s:string):string — RFC3986 percent encoding of a string; roundtrips; both exports',
    'caesarCipher(s:string, shift:number):string — shift letters by shift (wrap a-z/A-Z), non-letters unchanged; negative shift decodes',
    'toHexString(bytes:number[]):string and fromHexString(hex:string):number[] — bytes (0..255) <-> lowercase hex; roundtrips; both exports',
    'rot47(s:string):string — ROT47 over printable ASCII 33..126; involution',
  ]},
  { key: 'collectionsB', title: 'Collection data structures', briefs: [
    'PriorityQueue<T> class — push(item:T, priority:number):void, pop():T|undefined (lowest priority first), peek():T|undefined, size():number, isEmpty():boolean',
    'CircularBuffer<T> class — constructor(capacity), push(item):void (overwrites oldest when full), toArray():T[] (oldest first), size():number, isFull():boolean',
    'Counter<T> class — add(item:T):void, count(item:T):number, mostCommon(n:number):[T,number][] (desc by count, ties by insertion), total():number',
    'OrderedSet<T> class — add(item:T):void, has(item:T):boolean, delete(item:T):boolean, values():T[] (insertion order, unique), size():number',
    'sortedInsert(arr:number[], val:number):number[] — insert val into an already-sorted ascending array, returning a new sorted array (binary search position)',
    'LFUCache<K,V> class — constructor(capacity), get(k:K):V|undefined, put(k:K,v:V):void; evicts least-frequently-used (ties: least-recently-used)',
    'Deque<T> class — pushFront, pushBack, popFront():T|undefined, popBack():T|undefined, size():number, toArray():T[]',
    'IntervalSet class — add(start:number,end:number):void merging overlaps, contains(x:number):boolean, list():[number,number][] sorted',
  ]},
  { key: 'fpB', title: 'Functional programming', briefs: [
    'Option<T> class — static some(v), static none(), map(fn), getOrElse(default), isSome():boolean, isNone():boolean',
    'ResultBox class — static ok(v), static err(e), map(fn), mapErr(fn), unwrapOr(default), isOk():boolean',
    'composeFns(...fns):(x)=>any (right-to-left) and pipeFns(...fns):(x)=>any (left-to-right); both exports; empty -> identity',
    'curryN(fn:Function, arity:number):Function — curry a function to the given arity',
    'allPass(preds:Array<(x:any)=>boolean>):(x)=>boolean and anyPass(preds):(x)=>boolean; both exports',
    'memoizeUnary(fn:(x:any)=>any):(x)=>any — memoize a single-argument function (Map keyed by the arg)',
    'zipWith(a:any[], b:any[], fn:(x,y)=>any):any[] — elementwise combine up to the shorter length',
    'negate(pred:(...a:any[])=>boolean):(...a:any[])=>boolean — logical complement of a predicate',
  ]},
  { key: 'dateTimeB', title: 'Date & time (UTC, deterministic)', briefs: [
    'parseISODuration(s:string):number — ISO-8601 duration like "PT1H30M" or "P1DT2H" to milliseconds; invalid -> NaN',
    'formatDuration(ms:number):string — humanize ms to like "1h 30m" / "45s" / "2d 3h"; 0 -> "0s"; largest two non-zero units',
    'isoWeekNumber(date:Date):number — ISO-8601 week number (1..53) using UTC',
    'businessDaysBetween(a:Date, b:Date):number — count of Mon-Fri days strictly between (exclusive of a, inclusive of b); a<=b',
    'addBusinessDays(date:Date, n:number):Date — add n business days (skip Sat/Sun), UTC; returns a new Date',
    'quarterOf(date:Date):number — calendar quarter 1..4 (UTC month)',
    'dateRangeDays(a:Date, b:Date):string[] — inclusive list of YYYY-MM-DD strings from a to b (UTC); a<=b',
    'humanizeRelativeTime(from:Date, to:Date):string — "in 3 days" / "2 hours ago" relative phrasing using the largest unit',
  ]},
  { key: 'textFmtB', title: 'Text formatting', briefs: [
    'formatCurrency(amount:number, symbol:string):string — e.g. formatCurrency(1234.5,"$") -> "$1,234.50"; 2 decimals; thousands separators; negative as "-$x"',
    'ordinalWord(n:number):string — 1->"first" ... 10->"tenth" for 1..10, otherwise fall back to ordinal suffix like "11th","21st"',
    'humanizeList(items:string[]):string — "a", "a and b", "a, b and c"; [] -> ""',
    'abbreviateNumber(n:number):string — 1200->"1.2K", 1500000->"1.5M", 1000000000->"1B"; <1000 stays plain; one decimal trimmed if .0',
    'maskString(s:string, visible:number):string — keep the last `visible` chars, replace the rest with "*"',
    'titleCaseSmart(s:string):string — title-case but keep small words (a,an,the,of,and,or,in,on,to) lowercase unless first word',
    'slugifyUnicode(s:string):string — lowercase ascii slug: spaces->-, strip non-alphanumeric, collapse hyphens, trim hyphens',
    'padColumns(rows:string[][]):string[] — pad each column to its max width (space-padded right), join cells with a single space, per row',
  ]},
  { key: 'bitMatrixB', title: 'Bits & matrices', briefs: [
    'hammingDistance(a:number, b:number):number — number of differing bits between two non-negative ints',
    'reverseBits32(n:number):number — reverse the 32 bits of an unsigned int, return unsigned',
    'nextPowerOfTwo(n:number):number — smallest power of two >= n; n<=1 -> 1',
    'countLeadingZeros32(n:number):number — leading zero bits in a 32-bit representation (n=0 -> 32)',
    'grayEncode(n:number):number and grayDecode(g:number):number — binary<->Gray code; roundtrips; both exports',
    'matrixMultiply(a:number[][], b:number[][]):number[][] — matrix product (assume conformable)',
    'matrixTranspose(m:number[][]):number[][] — transpose (handles non-square and [])',
    'matrixDeterminant(m:number[][]):number — determinant of a square matrix via cofactor expansion (small n)',
  ]},
]

phase('Author')

const results = await pipeline(
  FAMILIES,
  // Stage 1 — author the family.
  (family) => agent(
    `Author ${family.briefs.length} CatalogEntry skills for the family "${family.title}".

${RULES}

EXISTING NAMES (do not reuse any as id or filename):
${TAKEN}

Author exactly these skills (use the suggested signature; pick a unique camelCase filename and kebab id; the export name(s) are given in each brief):
${family.briefs.map((b, i) => `${i + 1}. ${b}`).join('\n')}

Return { entries: [...] } with one fully-worked CatalogEntry per brief. Every test's \`want\` must be the
exact value your impl produces — reason through each one. Strongly prefer correctness over breadth: a
skill with a subtly-wrong test will be DROPPED, wasting it.`,
    { label: `author:${family.key}`, phase: 'Author', schema: ENTRY_SCHEMA, effort: 'high' },
  ),
  // Stage 2 — adversarially harden + verify against the real oracle + write the batch.
  (authored, family) => {
    if (!authored || !authored.entries || !authored.entries.length) return null
    return agent(
      `You are the adversarial verifier for the skill family "${family.title}". Below are ${authored.entries.length}
draft CatalogEntry objects (JSON). Your job: make every shippable entry provably correct, then write the batch.

${RULES}

DRAFT ENTRIES:
${JSON.stringify(authored.entries)}

PROCESS (do this with your tools — you have Bash, Write, Read):
1. Write the draft entries as a JSON array to: src/CrucibleEngine/synth/catalogs/${family.key}.json
2. Run the oracle:  npx tsx src/CrucibleEngine/synth/validate-batch.ts src/CrucibleEngine/synth/catalogs/${family.key}.json
3. For EVERY failure, diagnose and FIX it in the JSON, then re-run. Common failures:
   - wrong \`want\` value → recompute by tracing the impl (or add a quick scratch tsx script to print the real output)
   - impl bug → fix the implementation
   - self-match < 0.5 → add a pattern matching the exact export name with weight 0.5
   - shape gate → impl must \`export\` each declared name
   - missing export in suite import → exports array must match impl
4. If an entry cannot be made correct after a few tries, REMOVE it from the JSON (better to drop than ship wrong).
   Never weaken a test just to pass — the test must assert genuinely correct behavior.
5. Re-run the validator until it prints "All entries in batch pass the oracle." (exit 0).
6. Ensure the final file at src/CrucibleEngine/synth/catalogs/${family.key}.json is valid JSON (an array).

Iterate until the validator is fully green. Then return the manifest: the entries kept (ids), and any dropped.
Do NOT stop until validate-batch.ts exits 0 on the file you wrote.`,
      { label: `harden:${family.key}`, phase: 'Harden', schema: HARDEN_SCHEMA, effort: 'high' },
    )
  },
)

const ok = results.filter(Boolean)
const totalKept = ok.reduce((n, r) => n + (r.count || 0), 0)
const totalDropped = ok.reduce((n, r) => n + (r.dropped ? r.dropped.length : 0), 0)
log(`Authored ${FAMILIES.length} families → ${totalKept} skills written, ${totalDropped} dropped`)

return {
  families: ok.map(r => ({ key: r.key, count: r.count, ids: r.ids, dropped: r.dropped })),
  totalKept,
  totalDropped,
}
