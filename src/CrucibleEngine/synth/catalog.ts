// ============================================================================
// Skill catalog — typed source of truth for Tier-1A/B/C utility skills.
// Run `npm run generate:skills` to materialize these into skill + suite files.
// Run `npm run prove:all` to gate them through Invariant 4 and update _manifest.
// ============================================================================

export interface CatalogPattern {
  re: string    // regex source (will be new RegExp(re, 'i'))
  weight: number
}

export interface CatalogTest {
  desc: string
  call: string   // expression to evaluate (may use imports)
  want: string   // expression for expected value (JSON-comparable)
}

export interface CatalogEntry {
  id: string            // registerSkill id
  filename: string      // skills/<filename>.ts
  summary: string
  patterns: CatalogPattern[]
  defaultPath: string   // fallback emit path
  exports: string[]     // exported names the skill emits
  impl: string          // implementation code (inserted into IMPL template literal)
  tests: CatalogTest[]  // adversarial hidden suite tests
}

const CATALOG: CatalogEntry[] = [

  // ── String utilities ───────────────────────────────────────────────────────

  {
    id: 'capitalize',
    filename: 'capitalize',
    summary: 'Capitalize the first letter of each word (title case).',
    defaultPath: 'src/capitalize.ts',
    exports: ['capitalize'],
    patterns: [
      { re: '\\bcapitaliz', weight: 0.65 },
      { re: '\\btitle[- ]?case\\b', weight: 0.5 },
      { re: '\\bfirst.*letter.*upper|upper.*first.*letter', weight: 0.3 },
    ],
    impl: `export function capitalize(str: string): string {
  return str.replace(/\\b\\w/g, c => c.toUpperCase())
}`,
    tests: [
      { desc: 'basic', call: 'capitalize("hello world")', want: '"Hello World"' },
      { desc: 'already capitalized', call: 'capitalize("Hello World")', want: '"Hello World"' },
      { desc: 'mixed case', call: 'capitalize("hELLO wORLD")', want: '"HELLO WORLD"' },
      { desc: 'empty string', call: 'capitalize("")', want: '""' },
      { desc: 'single word', call: 'capitalize("hello")', want: '"Hello"' },
      { desc: 'with punctuation', call: 'capitalize("it\'s a test")', want: '"It\'S A Test"' },
      { desc: 'numbers unchanged', call: 'capitalize("2fast 2furious")', want: '"2fast 2furious"' },
    ],
  },

  {
    id: 'camel-case',
    filename: 'camelCase',
    summary: 'Convert a string to camelCase.',
    defaultPath: 'src/camelCase.ts',
    exports: ['camelCase'],
    patterns: [
      { re: '\\bcamel[- ]?case\\b', weight: 0.7 },
      { re: '\\bcamelCase\\b', weight: 0.3 },
      { re: '\\bto[- ]?camel\\b', weight: 0.4 },
    ],
    impl: `export function camelCase(str: string): string {
  return str
    .replace(/[-_\\s]+(.)/g, (_, c) => c.toUpperCase())
    .replace(/^[A-Z]/, c => c.toLowerCase())
}`,
    tests: [
      { desc: 'kebab to camel', call: 'camelCase("hello-world")', want: '"helloWorld"' },
      { desc: 'snake to camel', call: 'camelCase("hello_world")', want: '"helloWorld"' },
      { desc: 'space to camel', call: 'camelCase("hello world")', want: '"helloWorld"' },
      { desc: 'already camel', call: 'camelCase("helloWorld")', want: '"helloWorld"' },
      { desc: 'PascalCase input', call: 'camelCase("HelloWorld")', want: '"helloWorld"' },
      { desc: 'multiple words', call: 'camelCase("the-quick-brown-fox")', want: '"theQuickBrownFox"' },
      { desc: 'empty', call: 'camelCase("")', want: '""' },
      { desc: 'single word', call: 'camelCase("hello")', want: '"hello"' },
    ],
  },

  {
    id: 'pascal-case',
    filename: 'pascalCase',
    summary: 'Convert a string to PascalCase.',
    defaultPath: 'src/pascalCase.ts',
    exports: ['pascalCase'],
    patterns: [
      { re: '\\bpascal[- ]?case\\b', weight: 0.7 },
      { re: '\\bpascalCase\\b', weight: 0.3 },
      { re: '\\bupper[- ]?camel\\b', weight: 0.4 },
    ],
    impl: `export function pascalCase(str: string): string {
  return str
    .replace(/[-_\\s]+(.)/g, (_, c) => c.toUpperCase())
    .replace(/^[a-z]/, c => c.toUpperCase())
}`,
    tests: [
      { desc: 'kebab to pascal', call: 'pascalCase("hello-world")', want: '"HelloWorld"' },
      { desc: 'snake to pascal', call: 'pascalCase("hello_world")', want: '"HelloWorld"' },
      { desc: 'space to pascal', call: 'pascalCase("hello world")', want: '"HelloWorld"' },
      { desc: 'camelCase input', call: 'pascalCase("helloWorld")', want: '"HelloWorld"' },
      { desc: 'already pascal', call: 'pascalCase("HelloWorld")', want: '"HelloWorld"' },
      { desc: 'single word', call: 'pascalCase("hello")', want: '"Hello"' },
      { desc: 'empty', call: 'pascalCase("")', want: '""' },
    ],
  },

  {
    id: 'snake-case',
    filename: 'snakeCase',
    summary: 'Convert a string to snake_case.',
    defaultPath: 'src/snakeCase.ts',
    exports: ['snakeCase'],
    patterns: [
      { re: '\\bsnake[- ]?case\\b', weight: 0.7 },
      { re: '\\bsnakeCase\\b', weight: 0.3 },
      { re: '\\bto[- ]?snake\\b', weight: 0.4 },
      { re: '\\bunder[_\\s]?score[- ]?case\\b', weight: 0.3 },
    ],
    impl: `export function snakeCase(str: string): string {
  return str
    .replace(/([A-Z])/g, '_$1')
    .replace(/[-\\s]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase()
}`,
    tests: [
      { desc: 'camel to snake', call: 'snakeCase("helloWorld")', want: '"hello_world"' },
      { desc: 'pascal to snake', call: 'snakeCase("HelloWorld")', want: '"hello_world"' },
      { desc: 'kebab to snake', call: 'snakeCase("hello-world")', want: '"hello_world"' },
      { desc: 'space to snake', call: 'snakeCase("hello world")', want: '"hello_world"' },
      { desc: 'already snake', call: 'snakeCase("hello_world")', want: '"hello_world"' },
      { desc: 'multiple caps', call: 'snakeCase("theQuickBrownFox")', want: '"the_quick_brown_fox"' },
      { desc: 'empty', call: 'snakeCase("")', want: '""' },
    ],
  },

  {
    id: 'truncate',
    filename: 'truncate',
    summary: 'Truncate a string to maxLength, appending an ellipsis if cut.',
    defaultPath: 'src/truncate.ts',
    exports: ['truncate'],
    patterns: [
      { re: '\\btruncate\\b', weight: 0.7 },
      { re: '\\bellipsis\\b', weight: 0.3 },
      { re: '\\bclip.*string|string.*clip\\b', weight: 0.2 },
    ],
    impl: `export function truncate(str: string, maxLength: number, ellipsis = '...'): string {
  if (str.length <= maxLength) return str
  return str.slice(0, maxLength - ellipsis.length) + ellipsis
}`,
    tests: [
      { desc: 'no truncation needed', call: 'truncate("hello", 10)', want: '"hello"' },
      { desc: 'exact length', call: 'truncate("hello", 5)', want: '"hello"' },
      { desc: 'truncated with ellipsis', call: 'truncate("hello world", 8)', want: '"hello..."' },
      { desc: 'custom ellipsis', call: 'truncate("hello world", 7, "…")', want: '"hello …"' },
      { desc: 'very short max', call: 'truncate("hello", 3)', want: '"..."' },
      { desc: 'empty string', call: 'truncate("", 5)', want: '""' },
      { desc: 'maxLength equals ellipsis length', call: 'truncate("hi there", 3)', want: '"..."' },
    ],
  },

  {
    id: 'count-occurrences',
    filename: 'countOccurrences',
    summary: 'Count non-overlapping occurrences of a substring in a string.',
    defaultPath: 'src/countOccurrences.ts',
    exports: ['countOccurrences'],
    patterns: [
      { re: '\\bcount.*occurrence|occurrence.*count', weight: 0.65 },
      { re: '\\bcountOccurrences\\b', weight: 0.3 },
      { re: '\\bcount.*substring|substring.*count', weight: 0.3 },
    ],
    impl: `export function countOccurrences(str: string, sub: string): number {
  if (!sub) return 0
  let count = 0, pos = 0
  while ((pos = str.indexOf(sub, pos)) !== -1) { count++; pos += sub.length }
  return count
}`,
    tests: [
      { desc: 'basic', call: 'countOccurrences("hello world hello", "hello")', want: '2' },
      { desc: 'no match', call: 'countOccurrences("hello", "xyz")', want: '0' },
      { desc: 'non-overlapping', call: 'countOccurrences("aaaa", "aa")', want: '2' },
      { desc: 'single char', call: 'countOccurrences("banana", "a")', want: '3' },
      { desc: 'empty sub', call: 'countOccurrences("hello", "")', want: '0' },
      { desc: 'empty string', call: 'countOccurrences("", "a")', want: '0' },
      { desc: 'sub longer than str', call: 'countOccurrences("hi", "hello")', want: '0' },
      { desc: 'sub equals str', call: 'countOccurrences("abc", "abc")', want: '1' },
    ],
  },

  {
    id: 'is-palindrome',
    filename: 'isPalindrome',
    summary: 'Check whether a string is a palindrome (ignoring case and non-alphanumeric).',
    defaultPath: 'src/isPalindrome.ts',
    exports: ['isPalindrome'],
    patterns: [
      { re: '\\bpalindrome\\b', weight: 0.8 },
      { re: '\\bisPalindrome\\b', weight: 0.3 },
    ],
    impl: `export function isPalindrome(str: string): boolean {
  const clean = str.toLowerCase().replace(/[^a-z0-9]/g, '')
  return clean === clean.split('').reverse().join('')
}`,
    tests: [
      { desc: 'simple palindrome', call: 'isPalindrome("racecar")', want: 'true' },
      { desc: 'not palindrome', call: 'isPalindrome("hello")', want: 'false' },
      { desc: 'mixed case', call: 'isPalindrome("RaceCar")', want: 'true' },
      { desc: 'with spaces/punct', call: 'isPalindrome("A man a plan a canal Panama")', want: 'true' },
      { desc: 'empty string', call: 'isPalindrome("")', want: 'true' },
      { desc: 'single char', call: 'isPalindrome("a")', want: 'true' },
      { desc: 'two same chars', call: 'isPalindrome("aa")', want: 'true' },
      { desc: 'two diff chars', call: 'isPalindrome("ab")', want: 'false' },
    ],
  },

  {
    id: 'reverse-string',
    filename: 'reverseString',
    summary: 'Reverse a string.',
    defaultPath: 'src/reverseString.ts',
    exports: ['reverseString'],
    patterns: [
      { re: '\\breverse.*string|string.*revers', weight: 0.7 },
      { re: '\\breverseString\\b', weight: 0.3 },
    ],
    impl: `export function reverseString(str: string): string {
  return str.split('').reverse().join('')
}`,
    tests: [
      { desc: 'basic', call: 'reverseString("hello")', want: '"olleh"' },
      { desc: 'palindrome', call: 'reverseString("racecar")', want: '"racecar"' },
      { desc: 'empty', call: 'reverseString("")', want: '""' },
      { desc: 'single char', call: 'reverseString("a")', want: '"a"' },
      { desc: 'with spaces', call: 'reverseString("hello world")', want: '"dlrow olleh"' },
      { desc: 'numbers', call: 'reverseString("12345")', want: '"54321"' },
    ],
  },

  // ── Array utilities ────────────────────────────────────────────────────────

  {
    id: 'flatten',
    filename: 'flatten',
    summary: 'Flatten a nested array one level deep (or deeply with depth param).',
    defaultPath: 'src/flatten.ts',
    exports: ['flatten'],
    patterns: [
      { re: '\\bflatten\\b', weight: 0.65 },
      { re: '\\bflatMap\\b|\\bflat\\b.*array', weight: 0.25 },
      { re: '\\bnested.*array.*flat|flat.*nested.*array', weight: 0.3 },
    ],
    impl: `export function flatten<T>(arr: Array<T | T[]>, depth = 1): T[] {
  if (depth <= 0) return arr as T[]
  const out: T[] = []
  for (const item of arr) {
    if (Array.isArray(item) && depth > 0) out.push(...flatten(item, depth - 1))
    else out.push(item as T)
  }
  return out
}`,
    tests: [
      { desc: 'one level', call: 'flatten([[1,2],[3,4]])', want: '[1,2,3,4]' },
      { desc: 'nested one level default', call: 'flatten([[1,[2]],[3]])', want: '[1,[2],3]' },
      { desc: 'deep flatten', call: 'flatten([[1,[2,[3]]]], Infinity as any)', want: '[1,2,3]' },
      { desc: 'empty', call: 'flatten([])', want: '[]' },
      { desc: 'no nesting', call: 'flatten([1,2,3])', want: '[1,2,3]' },
      { desc: 'depth 2', call: 'flatten([[1,[2,[3]]]], 2)', want: '[1,2,[3]]' },
      { desc: 'mixed types', call: 'flatten([["a",["b"]],"c"])', want: '["a",["b"],"c"]' },
    ],
  },

  {
    id: 'unique',
    filename: 'unique',
    summary: 'Return a new array with duplicate values removed (preserves order).',
    defaultPath: 'src/unique.ts',
    exports: ['unique', 'uniqueBy'],
    patterns: [
      { re: '\\bunique\\b', weight: 0.55 },
      { re: '\\bdedupe\\b|\\bdedup\\b|\\bde-dup\\b', weight: 0.5 },
      { re: '\\bremove.*duplicate|duplicate.*remov', weight: 0.4 },
      { re: '\\buniqueBy\\b', weight: 0.3 },
    ],
    impl: `export function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)]
}

export function uniqueBy<T>(arr: T[], key: (item: T) => unknown): T[] {
  const seen = new Set<unknown>()
  return arr.filter(item => {
    const k = key(item)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}`,
    tests: [
      { desc: 'removes duplicates', call: 'unique([1,2,1,3,2])', want: '[1,2,3]' },
      { desc: 'empty', call: 'unique([])', want: '[]' },
      { desc: 'no duplicates', call: 'unique([1,2,3])', want: '[1,2,3]' },
      { desc: 'all same', call: 'unique([1,1,1])', want: '[1]' },
      { desc: 'strings', call: 'unique(["a","b","a","c"])', want: '["a","b","c"]' },
      { desc: 'uniqueBy field', call: 'uniqueBy([{n:1,v:"a"},{n:2,v:"b"},{n:1,v:"c"}], x=>x.n)', want: '[{"n":1,"v":"a"},{"n":2,"v":"b"}]' },
      { desc: 'uniqueBy length', call: 'uniqueBy(["a","bb","c","dd"], s=>s.length)', want: '["a","bb"]' },
    ],
  },

  {
    id: 'set-ops',
    filename: 'setOps',
    summary: 'Array set operations: intersection, difference, union.',
    defaultPath: 'src/setOps.ts',
    exports: ['intersection', 'difference', 'union'],
    patterns: [
      { re: '\\bintersection\\b', weight: 0.5 },
      { re: '\\bdifference\\b.*array|array.*\\bdifference\\b', weight: 0.4 },
      { re: '\\bunion\\b.*array|array.*\\bunion\\b', weight: 0.35 },
      { re: '\\bset.*operation|intersection.*difference', weight: 0.4 },
    ],
    impl: `export function intersection<T>(a: T[], b: T[]): T[] {
  const setB = new Set(b)
  return [...new Set(a)].filter(x => setB.has(x))
}

export function difference<T>(a: T[], b: T[]): T[] {
  const setB = new Set(b)
  return [...new Set(a)].filter(x => !setB.has(x))
}

export function union<T>(a: T[], b: T[]): T[] {
  return [...new Set([...a, ...b])]
}`,
    tests: [
      { desc: 'intersection basic', call: 'intersection([1,2,3],[2,3,4])', want: '[2,3]' },
      { desc: 'intersection empty', call: 'intersection([1,2],[3,4])', want: '[]' },
      { desc: 'intersection deduped', call: 'intersection([1,1,2],[1,2,2])', want: '[1,2]' },
      { desc: 'difference basic', call: 'difference([1,2,3],[2,3])', want: '[1]' },
      { desc: 'difference none removed', call: 'difference([1,2],[3,4])', want: '[1,2]' },
      { desc: 'difference all removed', call: 'difference([1,2],[1,2,3])', want: '[]' },
      { desc: 'union basic', call: 'union([1,2],[2,3])', want: '[1,2,3]' },
      { desc: 'union deduped', call: 'union([1,1,2],[2,3,3])', want: '[1,2,3]' },
    ],
  },

  {
    id: 'compact',
    filename: 'compact',
    summary: 'Remove all falsy values from an array.',
    defaultPath: 'src/compact.ts',
    exports: ['compact'],
    patterns: [
      { re: '\\bcompact\\b', weight: 0.65 },
      { re: '\\bremove.*falsy|falsy.*remov', weight: 0.5 },
      { re: '\\bfilter.*null.*undefined|null.*undefined.*filter', weight: 0.3 },
    ],
    impl: `export function compact<T>(arr: Array<T | null | undefined | false | 0 | ''>): T[] {
  return arr.filter(Boolean) as T[]
}`,
    tests: [
      { desc: 'removes all falsy', call: 'compact([0, 1, false, 2, "", 3, null, undefined])', want: '[1,2,3]' },
      { desc: 'no falsy', call: 'compact([1,2,3])', want: '[1,2,3]' },
      { desc: 'all falsy', call: 'compact([0, false, null, undefined, ""])', want: '[]' },
      { desc: 'empty', call: 'compact([])', want: '[]' },
      { desc: 'strings', call: 'compact(["","a","","b"])', want: '["a","b"]' },
    ],
  },

  {
    id: 'zip',
    filename: 'zip',
    summary: 'Zip two arrays into pairs; unzip pairs back into two arrays.',
    defaultPath: 'src/zip.ts',
    exports: ['zip', 'unzip'],
    patterns: [
      { re: '\\bzip\\b.*array|array.*\\bzip\\b', weight: 0.6 },
      { re: '\\bunzip\\b', weight: 0.4 },
      { re: '\\bzip.*pair|pair.*array', weight: 0.3 },
    ],
    impl: `export function zip<A, B>(a: A[], b: B[]): [A, B][] {
  const len = Math.min(a.length, b.length)
  const out: [A, B][] = []
  for (let i = 0; i < len; i++) out.push([a[i], b[i]])
  return out
}

export function unzip<A, B>(pairs: [A, B][]): [A[], B[]] {
  const as: A[] = [], bs: B[] = []
  for (const [a, b] of pairs) { as.push(a); bs.push(b) }
  return [as, bs]
}`,
    tests: [
      { desc: 'basic zip', call: 'zip([1,2,3],["a","b","c"])', want: '[[1,"a"],[2,"b"],[3,"c"]]' },
      { desc: 'zip shorter', call: 'zip([1,2,3],["a","b"])', want: '[[1,"a"],[2,"b"]]' },
      { desc: 'zip empty', call: 'zip([],[1,2])', want: '[]' },
      { desc: 'unzip basic', call: 'unzip([[1,"a"],[2,"b"],[3,"c"]])', want: '[[1,2,3],["a","b","c"]]' },
      { desc: 'unzip empty', call: 'unzip([])', want: '[[],[]]' },
      { desc: 'zip roundtrip', call: 'JSON.stringify(unzip(zip([1,2],["a","b"])))', want: 'JSON.stringify([[1,2],["a","b"]])' },
    ],
  },

  {
    id: 'range',
    filename: 'range',
    summary: 'Generate an array of numbers from start to end (exclusive), with optional step.',
    defaultPath: 'src/range.ts',
    exports: ['range'],
    patterns: [
      { re: '\\brange\\b.*number|number.*\\brange\\b', weight: 0.6 },
      { re: '\\brange\\(', weight: 0.5 },
      { re: '\\bsequence.*number|number.*sequence', weight: 0.2 },
    ],
    impl: `export function range(start: number, end?: number, step = 1): number[] {
  if (end === undefined) { end = start; start = 0 }
  const out: number[] = []
  if (step > 0) for (let i = start; i < end; i += step) out.push(i)
  else if (step < 0) for (let i = start; i > end; i += step) out.push(i)
  return out
}`,
    tests: [
      { desc: 'range(5)', call: 'range(5)', want: '[0,1,2,3,4]' },
      { desc: 'range(1,5)', call: 'range(1,5)', want: '[1,2,3,4]' },
      { desc: 'range with step', call: 'range(0,10,2)', want: '[0,2,4,6,8]' },
      { desc: 'range(0,0)', call: 'range(0,0)', want: '[]' },
      { desc: 'range descending', call: 'range(5,0,-1)', want: '[5,4,3,2,1]' },
      { desc: 'range(3,3)', call: 'range(3,3)', want: '[]' },
      { desc: 'range(0,1)', call: 'range(0,1)', want: '[0]' },
    ],
  },

  {
    id: 'array-utils',
    filename: 'arrayUtils',
    summary: 'take, drop, last, first, partition array helpers.',
    defaultPath: 'src/arrayUtils.ts',
    exports: ['take', 'drop', 'last', 'first', 'partition'],
    patterns: [
      { re: '\\btake\\b.*\\bdrop\\b|\\bdrop\\b.*\\btake\\b', weight: 0.55 },
      { re: '\\bpartition\\b.*array|array.*\\bpartition\\b', weight: 0.45 },
      { re: '\\btake.*first.*n|first.*n.*element', weight: 0.35 },
      { re: '\\blast\\b.*array.*element', weight: 0.3 },
    ],
    impl: `export function take<T>(arr: T[], n: number): T[] {
  return arr.slice(0, Math.max(0, n))
}

export function drop<T>(arr: T[], n: number): T[] {
  return arr.slice(Math.max(0, n))
}

export function last<T>(arr: T[]): T | undefined {
  return arr[arr.length - 1]
}

export function first<T>(arr: T[]): T | undefined {
  return arr[0]
}

export function partition<T>(arr: T[], pred: (item: T) => boolean): [T[], T[]] {
  const yes: T[] = [], no: T[] = []
  for (const item of arr) (pred(item) ? yes : no).push(item)
  return [yes, no]
}`,
    tests: [
      { desc: 'take basic', call: 'take([1,2,3,4,5], 3)', want: '[1,2,3]' },
      { desc: 'take more than length', call: 'take([1,2], 10)', want: '[1,2]' },
      { desc: 'take 0', call: 'take([1,2,3], 0)', want: '[]' },
      { desc: 'drop basic', call: 'drop([1,2,3,4,5], 2)', want: '[3,4,5]' },
      { desc: 'drop all', call: 'drop([1,2,3], 10)', want: '[]' },
      { desc: 'drop 0', call: 'drop([1,2,3], 0)', want: '[1,2,3]' },
      { desc: 'last basic', call: 'last([1,2,3])', want: '3' },
      { desc: 'last empty', call: 'last([])', want: 'undefined' },
      { desc: 'first basic', call: 'first([1,2,3])', want: '1' },
      { desc: 'first empty', call: 'first([])', want: 'undefined' },
      { desc: 'partition evens/odds', call: 'partition([1,2,3,4,5], n=>n%2===0)', want: '[[2,4],[1,3,5]]' },
      { desc: 'partition empty', call: 'partition([], ()=>true)', want: '[[],[]]' },
      { desc: 'partition all true', call: 'partition([1,2,3], ()=>true)', want: '[[1,2,3],[]]' },
    ],
  },

  {
    id: 'sum-by',
    filename: 'sumBy',
    summary: 'Sum, min, max, sort array by a key function.',
    defaultPath: 'src/sumBy.ts',
    exports: ['sumBy', 'minBy', 'maxBy', 'sortBy'],
    patterns: [
      { re: '\\bsumBy\\b|\\bsum.*by\\b', weight: 0.55 },
      { re: '\\bminBy\\b|\\bmaxBy\\b', weight: 0.45 },
      { re: '\\bsortBy\\b|\\bsort.*by.*key', weight: 0.4 },
    ],
    impl: `export function sumBy<T>(arr: T[], key: (item: T) => number): number {
  return arr.reduce((acc, item) => acc + key(item), 0)
}

export function minBy<T>(arr: T[], key: (item: T) => number): T | undefined {
  if (!arr.length) return undefined
  return arr.reduce((min, item) => key(item) < key(min) ? item : min)
}

export function maxBy<T>(arr: T[], key: (item: T) => number): T | undefined {
  if (!arr.length) return undefined
  return arr.reduce((max, item) => key(item) > key(max) ? item : max)
}

export function sortBy<T>(arr: T[], key: (item: T) => number | string): T[] {
  return [...arr].sort((a, b) => {
    const ka = key(a), kb = key(b)
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
}`,
    tests: [
      { desc: 'sumBy numbers', call: 'sumBy([{v:1},{v:2},{v:3}], x=>x.v)', want: '6' },
      { desc: 'sumBy empty', call: 'sumBy([], (x:any)=>x)', want: '0' },
      { desc: 'minBy', call: 'minBy([{v:3},{v:1},{v:2}], x=>x.v)', want: '{"v":1}' },
      { desc: 'minBy empty', call: 'minBy([], (x:any)=>x)', want: 'undefined' },
      { desc: 'maxBy', call: 'maxBy([{v:3},{v:1},{v:2}], x=>x.v)', want: '{"v":3}' },
      { desc: 'sortBy number', call: 'sortBy([3,1,2], x=>x)', want: '[1,2,3]' },
      { desc: 'sortBy field', call: 'sortBy([{n:"b"},{n:"a"},{n:"c"}], x=>x.n)', want: '[{"n":"a"},{"n":"b"},{"n":"c"}]' },
      { desc: 'sortBy stable empty', call: 'sortBy([], (x:any)=>x)', want: '[]' },
    ],
  },

  // ── Object utilities ───────────────────────────────────────────────────────

  {
    id: 'map-values',
    filename: 'mapValues',
    summary: 'Map over object values; map over object keys; filter object entries.',
    defaultPath: 'src/mapValues.ts',
    exports: ['mapValues', 'mapKeys', 'filterValues'],
    patterns: [
      { re: '\\bmapValues\\b|\\bmap.*values\\b', weight: 0.6 },
      { re: '\\bmapKeys\\b|\\bmap.*keys\\b', weight: 0.5 },
      { re: '\\bfilterValues\\b|\\bfilter.*object', weight: 0.4 },
    ],
    impl: `export function mapValues<T, U>(
  obj: Record<string, T>,
  fn: (value: T, key: string) => U,
): Record<string, U> {
  const out: Record<string, U> = {}
  for (const [k, v] of Object.entries(obj)) out[k] = fn(v, k)
  return out
}

export function mapKeys<T>(
  obj: Record<string, T>,
  fn: (key: string, value: T) => string,
): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [k, v] of Object.entries(obj)) out[fn(k, v)] = v
  return out
}

export function filterValues<T>(
  obj: Record<string, T>,
  pred: (value: T, key: string) => boolean,
): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [k, v] of Object.entries(obj)) if (pred(v, k)) out[k] = v
  return out
}`,
    tests: [
      { desc: 'mapValues double', call: 'mapValues({a:1,b:2,c:3}, v=>v*2)', want: '{"a":2,"b":4,"c":6}' },
      { desc: 'mapValues empty', call: 'mapValues({}, v=>v)', want: '{}' },
      { desc: 'mapKeys uppercase', call: 'mapKeys({a:1,b:2}, k=>k.toUpperCase())', want: '{"A":1,"B":2}' },
      { desc: 'filterValues positive', call: 'filterValues({a:1,b:-1,c:2}, v=>v>0)', want: '{"a":1,"c":2}' },
      { desc: 'filterValues empty result', call: 'filterValues({a:1}, v=>v>10)', want: '{}' },
      { desc: 'filterValues with key', call: 'filterValues({aa:1,b:2,cc:3}, (_,k)=>k.length>1)', want: '{"aa":1,"cc":3}' },
    ],
  },

  {
    id: 'invert',
    filename: 'invert',
    summary: 'Swap keys and values of a string-keyed object.',
    defaultPath: 'src/invert.ts',
    exports: ['invert'],
    patterns: [
      { re: '\\binvert\\b.*object|object.*\\binvert\\b', weight: 0.6 },
      { re: '\\bswap.*keys.*values|keys.*values.*swap|flip.*object', weight: 0.5 },
      { re: '\\binvert\\b', weight: 0.35 },
    ],
    impl: `export function invert(obj: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) out[v] = k
  return out
}`,
    tests: [
      { desc: 'basic', call: 'invert({a:"1",b:"2",c:"3"})', want: '{"1":"a","2":"b","3":"c"}' },
      { desc: 'empty', call: 'invert({})', want: '{}' },
      { desc: 'single', call: 'invert({x:"y"})', want: '{"y":"x"}' },
      { desc: 'roundtrip', call: 'JSON.stringify(invert(invert({a:"1",b:"2"})))', want: 'JSON.stringify({a:"1",b:"2"})' },
      { desc: 'duplicate value last wins', call: 'Object.keys(invert({a:"x",b:"x"})).length', want: '1' },
    ],
  },

  {
    id: 'flatten-object',
    filename: 'flattenObject',
    summary: 'Flatten a nested object to dot-separated keys; unflatten back.',
    defaultPath: 'src/flattenObject.ts',
    exports: ['flattenObject', 'unflattenObject'],
    patterns: [
      { re: '\\bflatten.*object|flat.*object\\b', weight: 0.6 },
      { re: '\\bdot.*notation|dot.*separated.*key', weight: 0.4 },
      { re: '\\bunflatten.*object', weight: 0.4 },
    ],
    impl: `export function flattenObject(
  obj: Record<string, unknown>,
  prefix = '',
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? \`\${prefix}.\${k}\` : k
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flattenObject(v as Record<string, unknown>, key))
    } else {
      out[key] = v
    }
  }
  return out
}

export function unflattenObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    const parts = k.split('.')
    let cur = out
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {}
      cur = cur[parts[i]] as Record<string, unknown>
    }
    cur[parts[parts.length - 1]] = v
  }
  return out
}`,
    tests: [
      { desc: 'flatten nested', call: 'flattenObject({a:{b:{c:1}},d:2})', want: '{"a.b.c":1,"d":2}' },
      { desc: 'flatten already flat', call: 'flattenObject({a:1,b:2})', want: '{"a":1,"b":2}' },
      { desc: 'flatten empty', call: 'flattenObject({})', want: '{}' },
      { desc: 'flatten array value kept', call: 'flattenObject({a:[1,2]})', want: '{"a":[1,2]}' },
      { desc: 'unflatten basic', call: 'unflattenObject({"a.b.c":1,"d":2})', want: '{"a":{"b":{"c":1}},"d":2}' },
      { desc: 'unflatten flat', call: 'unflattenObject({a:1,b:2})', want: '{"a":1,"b":2}' },
      { desc: 'roundtrip', call: 'JSON.stringify(unflattenObject(flattenObject({a:{b:1},c:2})))', want: 'JSON.stringify({a:{b:1},c:2})' },
    ],
  },

  // ── Number utilities ───────────────────────────────────────────────────────

  {
    id: 'clamp',
    filename: 'clamp',
    summary: 'Clamp a number between min and max; lerp between two values; round to N decimals.',
    defaultPath: 'src/clamp.ts',
    exports: ['clamp', 'lerp', 'roundTo'],
    patterns: [
      { re: '\\bclamp\\b', weight: 0.65 },
      { re: '\\blerp\\b|linear.*interpolat', weight: 0.5 },
      { re: '\\broundTo\\b|round.*decimal', weight: 0.4 },
    ],
    impl: `export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}`,
    tests: [
      { desc: 'clamp in range', call: 'clamp(5, 0, 10)', want: '5' },
      { desc: 'clamp below min', call: 'clamp(-5, 0, 10)', want: '0' },
      { desc: 'clamp above max', call: 'clamp(15, 0, 10)', want: '10' },
      { desc: 'clamp at min', call: 'clamp(0, 0, 10)', want: '0' },
      { desc: 'clamp at max', call: 'clamp(10, 0, 10)', want: '10' },
      { desc: 'lerp halfway', call: 'lerp(0, 10, 0.5)', want: '5' },
      { desc: 'lerp start', call: 'lerp(0, 10, 0)', want: '0' },
      { desc: 'lerp end', call: 'lerp(0, 10, 1)', want: '10' },
      { desc: 'roundTo 2', call: 'roundTo(3.14159, 2)', want: '3.14' },
      { desc: 'roundTo 0', call: 'roundTo(3.7, 0)', want: '4' },
      { desc: 'roundTo 3', call: 'roundTo(1.2345, 3)', want: '1.235' },
    ],
  },

  {
    id: 'format-number',
    filename: 'formatNumber',
    summary: 'Format a number with thousand separators and optional decimal places.',
    defaultPath: 'src/formatNumber.ts',
    exports: ['formatNumber'],
    patterns: [
      { re: '\\bformat.*number|number.*format', weight: 0.55 },
      { re: '\\bformatNumber\\b', weight: 0.3 },
      { re: '\\bthousand.*separator|comma.*thousand', weight: 0.5 },
      { re: '\\bnumber.*comma|comma.*separat', weight: 0.3 },
    ],
    impl: `export function formatNumber(
  value: number,
  decimals?: number,
  decimalSep = '.',
  thousandSep = ',',
): string {
  const fixed = decimals !== undefined ? value.toFixed(decimals) : String(value)
  const [int, dec] = fixed.split('.')
  const intFormatted = int.replace(/\\B(?=(\\d{3})+(?!\\d))/g, thousandSep)
  return dec !== undefined ? \`\${intFormatted}\${decimalSep}\${dec}\` : intFormatted
}`,
    tests: [
      { desc: 'basic thousands', call: 'formatNumber(1000)', want: '"1,000"' },
      { desc: 'millions', call: 'formatNumber(1000000)', want: '"1,000,000"' },
      { desc: 'with decimals', call: 'formatNumber(1234.5678, 2)', want: '"1,234.57"' },
      { desc: 'zero', call: 'formatNumber(0)', want: '"0"' },
      { desc: 'small number', call: 'formatNumber(42)', want: '"42"' },
      { desc: 'negative', call: 'formatNumber(-1234567)', want: '"-1,234,567"' },
      { desc: 'custom sep', call: 'formatNumber(1234567, 2, ",", ".")', want: '"1.234.567,00"' },
    ],
  },

  // ── Type-checking guards ───────────────────────────────────────────────────

  {
    id: 'type-guards',
    filename: 'typeGuards',
    summary: 'Runtime type-checking guards: isString, isNumber, isArray, isNil, isEmpty.',
    defaultPath: 'src/typeGuards.ts',
    exports: ['isString', 'isNumber', 'isBoolean', 'isArray', 'isObject', 'isNil', 'isEmpty'],
    patterns: [
      { re: '\\bisString\\b|\\bisNumber\\b|\\bisArray\\b', weight: 0.55 },
      { re: '\\btype.*guard|runtime.*type.*check', weight: 0.45 },
      { re: '\\bisNil\\b|\\bisEmpty\\b', weight: 0.4 },
      { re: '\\btype.*check.*util', weight: 0.35 },
    ],
    impl: `export function isString(v: unknown): v is string { return typeof v === 'string' }
export function isNumber(v: unknown): v is number { return typeof v === 'number' && !isNaN(v) }
export function isBoolean(v: unknown): v is boolean { return typeof v === 'boolean' }
export function isArray(v: unknown): v is unknown[] { return Array.isArray(v) }
export function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}
export function isNil(v: unknown): v is null | undefined { return v === null || v === undefined }
export function isEmpty(v: unknown): boolean {
  if (isNil(v)) return true
  if (typeof v === 'string' || Array.isArray(v)) return v.length === 0
  if (isObject(v)) return Object.keys(v).length === 0
  return false
}`,
    tests: [
      { desc: 'isString true', call: 'isString("hello")', want: 'true' },
      { desc: 'isString false', call: 'isString(42)', want: 'false' },
      { desc: 'isNumber true', call: 'isNumber(42)', want: 'true' },
      { desc: 'isNumber NaN', call: 'isNumber(NaN)', want: 'false' },
      { desc: 'isArray true', call: 'isArray([1,2,3])', want: 'true' },
      { desc: 'isArray false obj', call: 'isArray({length:3})', want: 'false' },
      { desc: 'isObject true', call: 'isObject({a:1})', want: 'true' },
      { desc: 'isObject false arr', call: 'isObject([1,2])', want: 'false' },
      { desc: 'isObject false null', call: 'isObject(null)', want: 'false' },
      { desc: 'isNil null', call: 'isNil(null)', want: 'true' },
      { desc: 'isNil undefined', call: 'isNil(undefined)', want: 'true' },
      { desc: 'isNil 0', call: 'isNil(0)', want: 'false' },
      { desc: 'isEmpty empty str', call: 'isEmpty("")', want: 'true' },
      { desc: 'isEmpty empty arr', call: 'isEmpty([])', want: 'true' },
      { desc: 'isEmpty empty obj', call: 'isEmpty({})', want: 'true' },
      { desc: 'isEmpty non-empty', call: 'isEmpty("hi")', want: 'false' },
      { desc: 'isEmpty null', call: 'isEmpty(null)', want: 'true' },
    ],
  },

  // ── Function utilities ─────────────────────────────────────────────────────

  {
    id: 'fn-utils',
    filename: 'fnUtils',
    summary: 'Function utilities: once, compose, pipe, debounce, throttle.',
    defaultPath: 'src/fnUtils.ts',
    exports: ['once', 'compose', 'pipe'],
    patterns: [
      { re: '\\bonce\\b.*function|function.*\\bonce\\b', weight: 0.55 },
      { re: '\\bcompose\\b.*function|function.*\\bcompose\\b', weight: 0.5 },
      { re: '\\bpipe\\b.*function|function.*\\bpipe\\b', weight: 0.45 },
      { re: '\\bcompose.*pipe|pipe.*compose', weight: 0.5 },
    ],
    impl: `export function once<T extends (...args: unknown[]) => unknown>(fn: T): T {
  let called = false, result: unknown
  return ((...args: unknown[]) => {
    if (!called) { called = true; result = fn(...args) }
    return result
  }) as T
}

export function compose<T>(...fns: Array<(arg: T) => T>): (arg: T) => T {
  return (arg: T) => fns.reduceRight((v, f) => f(v), arg)
}

export function pipe<T>(...fns: Array<(arg: T) => T>): (arg: T) => T {
  return (arg: T) => fns.reduce((v, f) => f(v), arg)
}`,
    tests: [
      { desc: 'once calls fn once', call: '(() => { let n=0; const f = once(()=>++n); f();f();f(); return n })()', want: '1' },
      { desc: 'once returns same value', call: '(() => { let n=0; const f = once(()=>++n); return [f(),f(),f()] })()', want: '[1,1,1]' },
      { desc: 'compose right to left', call: 'compose((x:number)=>x*2,(x:number)=>x+1)(3)', want: '8' },
      { desc: 'compose single', call: 'compose((x:number)=>x*2)(5)', want: '10' },
      { desc: 'compose empty', call: 'compose<number>()(5)', want: '5' },
      { desc: 'pipe left to right', call: 'pipe((x:number)=>x+1,(x:number)=>x*2)(3)', want: '8' },
      { desc: 'pipe single', call: 'pipe((x:number)=>x*3)(4)', want: '12' },
      { desc: 'pipe three fns', call: 'pipe((x:number)=>x+1,(x:number)=>x*2,(x:number)=>x-1)(0)', want: '1' },
    ],
  },

  // ── Validation guards (Tier-1C) ───────────────────────────────────────────

  {
    id: 'is-email',
    filename: 'isEmail',
    summary: 'Validate an email address format.',
    defaultPath: 'src/isEmail.ts',
    exports: ['isEmail'],
    patterns: [
      { re: '\\bvalidate.*email|email.*validat', weight: 0.6 },
      { re: '\\bisEmail\\b', weight: 0.4 },
      { re: '\\bemail.*format|email.*check', weight: 0.3 },
    ],
    impl: `export function isEmail(str: string): boolean {
  return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(str)
}`,
    tests: [
      { desc: 'valid basic', call: 'isEmail("user@example.com")', want: 'true' },
      { desc: 'valid with plus', call: 'isEmail("user+tag@example.co.uk")', want: 'true' },
      { desc: 'missing @', call: 'isEmail("userexample.com")', want: 'false' },
      { desc: 'missing domain', call: 'isEmail("user@")', want: 'false' },
      { desc: 'missing tld', call: 'isEmail("user@example")', want: 'false' },
      { desc: 'empty', call: 'isEmail("")', want: 'false' },
      { desc: 'spaces', call: 'isEmail("user @example.com")', want: 'false' },
      { desc: 'double @', call: 'isEmail("u@@ex.com")', want: 'false' },
    ],
  },

  {
    id: 'is-url',
    filename: 'isURL',
    summary: 'Validate a URL (http or https).',
    defaultPath: 'src/isURL.ts',
    exports: ['isURL'],
    patterns: [
      { re: '\\bvalidate.*url|url.*validat', weight: 0.6 },
      { re: '\\bisURL\\b|\\bis[- ]?url\\b', weight: 0.4 },
      { re: '\\bhttp.*url.*check|url.*format.*check', weight: 0.3 },
    ],
    impl: `export function isURL(str: string): boolean {
  try { const u = new URL(str); return u.protocol === 'http:' || u.protocol === 'https:' } catch { return false }
}`,
    tests: [
      { desc: 'valid http', call: 'isURL("http://example.com")', want: 'true' },
      { desc: 'valid https', call: 'isURL("https://example.com/path?q=1")', want: 'true' },
      { desc: 'no protocol', call: 'isURL("example.com")', want: 'false' },
      { desc: 'ftp rejected', call: 'isURL("ftp://example.com")', want: 'false' },
      { desc: 'empty', call: 'isURL("")', want: 'false' },
      { desc: 'just scheme', call: 'isURL("https://")', want: 'false' },
      { desc: 'localhost', call: 'isURL("http://localhost:3000")', want: 'true' },
    ],
  },

  {
    id: 'is-uuid',
    filename: 'isUUID',
    summary: 'Validate a UUID v4 string.',
    defaultPath: 'src/isUUID.ts',
    exports: ['isUUID'],
    patterns: [
      { re: '\\bvalidate.*uuid|uuid.*validat', weight: 0.6 },
      { re: '\\bisUUID\\b|\\buuid.*check\\b', weight: 0.4 },
      { re: '\\buuid.*format\\b', weight: 0.3 },
    ],
    impl: `export function isUUID(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str)
}`,
    tests: [
      { desc: 'valid v4', call: 'isUUID("550e8400-e29b-41d4-a716-446655440000")', want: 'true' },
      { desc: 'valid uppercase', call: 'isUUID("550E8400-E29B-41D4-A716-446655440000")', want: 'true' },
      { desc: 'wrong version', call: 'isUUID("550e8400-e29b-31d4-a716-446655440000")', want: 'false' },
      { desc: 'no hyphens', call: 'isUUID("550e8400e29b41d4a716446655440000")', want: 'false' },
      { desc: 'too short', call: 'isUUID("550e8400-e29b-41d4")', want: 'false' },
      { desc: 'empty', call: 'isUUID("")', want: 'false' },
      { desc: 'invalid variant', call: 'isUUID("550e8400-e29b-41d4-c716-446655440000")', want: 'false' },
    ],
  },

  {
    id: 'luhn',
    filename: 'luhn',
    summary: 'Validate a credit card number using the Luhn algorithm.',
    defaultPath: 'src/luhn.ts',
    exports: ['luhn'],
    patterns: [
      { re: '\\bluhn\\b', weight: 0.8 },
      { re: '\\bcredit.*card.*valid|card.*number.*valid', weight: 0.4 },
      { re: '\\bmod.*10|modulo.*10', weight: 0.3 },
    ],
    impl: `export function luhn(num: string): boolean {
  const digits = num.replace(/\\D/g, '')
  if (!digits.length) return false
  let sum = 0
  let odd = true
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = parseInt(digits[i], 10)
    if (!odd) { d *= 2; if (d > 9) d -= 9 }
    sum += d
    odd = !odd
  }
  return sum % 10 === 0
}`,
    tests: [
      { desc: 'valid Visa', call: 'luhn("4532015112830366")', want: 'true' },
      { desc: 'valid Mastercard', call: 'luhn("5425233430109903")', want: 'true' },
      { desc: 'invalid', call: 'luhn("1234567890123456")', want: 'false' },
      { desc: 'single zero', call: 'luhn("0")', want: 'true' },
      { desc: 'with spaces', call: 'luhn("4532 0151 1283 0366")', want: 'true' },
      { desc: 'with dashes', call: 'luhn("4532-0151-1283-0366")', want: 'true' },
      { desc: 'empty', call: 'luhn("")', want: 'false' },
    ],
  },

  // ── Standard-format parsers (Tier-1B) ──────────────────────────────────────

  {
    id: 'semver',
    filename: 'semver',
    summary: 'Parse and compare semantic version strings.',
    defaultPath: 'src/semver.ts',
    exports: ['parseSemver', 'compareSemver', 'isValidSemver'],
    patterns: [
      { re: '\\bsemver\\b|semantic.*version', weight: 0.7 },
      { re: '\\bparseSemver\\b|\\bcompareSemver\\b', weight: 0.4 },
      { re: '\\bversion.*compar|compar.*version', weight: 0.3 },
    ],
    impl: `export interface SemVer { major: number; minor: number; patch: number; pre?: string }

export function parseSemver(v: string): SemVer | null {
  const m = v.replace(/^v/, '').match(/^(\\d+)\\.(\\d+)\\.(\\d+)(?:-([\\w.]+))?$/)
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] }
}

export function isValidSemver(v: string): boolean {
  return parseSemver(v) !== null
}

export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemver(a), pb = parseSemver(b)
  if (!pa || !pb) throw new Error('invalid semver')
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (pa[k] < pb[k]) return -1
    if (pa[k] > pb[k]) return 1
  }
  if (!pa.pre && pb.pre) return 1
  if (pa.pre && !pb.pre) return -1
  if (pa.pre && pb.pre) return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0
  return 0
}`,
    tests: [
      { desc: 'parse basic', call: 'JSON.stringify(parseSemver("1.2.3"))', want: '"{\\"major\\":1,\\"minor\\":2,\\"patch\\":3}"' },
      { desc: 'parse with pre', call: 'parseSemver("1.0.0-alpha")?.pre', want: '"alpha"' },
      { desc: 'parse with v prefix', call: 'parseSemver("v2.0.0")?.major', want: '2' },
      { desc: 'parse invalid', call: 'parseSemver("1.2")', want: 'null' },
      { desc: 'isValid true', call: 'isValidSemver("1.2.3")', want: 'true' },
      { desc: 'isValid false', call: 'isValidSemver("abc")', want: 'false' },
      { desc: 'compare equal', call: 'compareSemver("1.2.3","1.2.3")', want: '0' },
      { desc: 'compare major', call: 'compareSemver("2.0.0","1.9.9")', want: '1' },
      { desc: 'compare minor', call: 'compareSemver("1.1.0","1.2.0")', want: '-1' },
      { desc: 'compare patch', call: 'compareSemver("1.0.1","1.0.0")', want: '1' },
      { desc: 'pre < release', call: 'compareSemver("1.0.0-alpha","1.0.0")', want: '-1' },
    ],
  },

  {
    id: 'query-string',
    filename: 'queryString',
    summary: 'Parse and stringify URL query strings.',
    defaultPath: 'src/queryString.ts',
    exports: ['parseQueryString', 'stringifyQueryString'],
    patterns: [
      { re: '\\bquery.*string|querystring\\b', weight: 0.65 },
      { re: '\\bparse.*query|stringify.*query', weight: 0.5 },
      { re: '\\burl.*param|search.*param', weight: 0.3 },
    ],
    impl: `export function parseQueryString(qs: string): Record<string, string> {
  const out: Record<string, string> = {}
  const str = qs.startsWith('?') ? qs.slice(1) : qs
  if (!str) return out
  for (const part of str.split('&')) {
    const eq = part.indexOf('=')
    if (eq === -1) { out[decodeURIComponent(part)] = ''; continue }
    out[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(part.slice(eq + 1))
  }
  return out
}

export function stringifyQueryString(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => v === '' ? encodeURIComponent(k) : \`\${encodeURIComponent(k)}=\${encodeURIComponent(v)}\`)
    .join('&')
}`,
    tests: [
      { desc: 'parse basic', call: 'JSON.stringify(parseQueryString("a=1&b=2"))', want: '"{\\"a\\":\\"1\\",\\"b\\":\\"2\\"}"' },
      { desc: 'parse with ?', call: 'parseQueryString("?x=1")["x"]', want: '"1"' },
      { desc: 'parse empty', call: 'JSON.stringify(parseQueryString(""))', want: '"{}"' },
      { desc: 'parse encoded', call: 'parseQueryString("q=hello%20world")["q"]', want: '"hello world"' },
      { desc: 'parse no value', call: 'parseQueryString("flag")["flag"]', want: '""' },
      { desc: 'stringify basic', call: 'stringifyQueryString({a:"1",b:"2"})', want: '"a=1&b=2"' },
      { desc: 'stringify encodes spaces', call: 'stringifyQueryString({q:"hello world"})', want: '"q=hello%20world"' },
      { desc: 'stringify empty value', call: 'stringifyQueryString({flag:""})', want: '"flag"' },
      { desc: 'roundtrip', call: 'JSON.stringify(parseQueryString(stringifyQueryString({a:"1",b:"hello world"})))', want: '"{\\"a\\":\\"1\\",\\"b\\":\\"hello world\\"}"' },
    ],
  },

  {
    id: 'csv-parse',
    filename: 'csvParse',
    summary: 'Parse CSV text to rows; stringify rows back to CSV.',
    defaultPath: 'src/csvParse.ts',
    exports: ['parseCSV', 'stringifyCSV'],
    patterns: [
      { re: '\\bcsv\\b.*pars|pars.*\\bcsv\\b', weight: 0.7 },
      { re: '\\bparseCSV\\b|\\bstringifyCSV\\b', weight: 0.4 },
      { re: '\\bcomma.*separated|comma.*delimit', weight: 0.4 },
    ],
    impl: `export function parseCSV(text: string, sep = ','): string[][] {
  return text.split('\\n').filter(l => l.trim()).map(line => {
    const cells: string[] = []
    let cur = '', inQ = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (c === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++ }
        else inQ = !inQ
      } else if (c === sep && !inQ) { cells.push(cur); cur = '' }
      else cur += c
    }
    cells.push(cur)
    return cells
  })
}

export function stringifyCSV(rows: string[][], sep = ','): string {
  return rows.map(row =>
    row.map(cell => {
      const needsQuote = cell.includes(sep) || cell.includes('"') || cell.includes('\\n')
      return needsQuote ? \`"\${cell.replace(/"/g, '""')}"\` : cell
    }).join(sep)
  ).join('\\n')
}`,
    tests: [
      { desc: 'basic parse', call: 'JSON.stringify(parseCSV("a,b,c\\n1,2,3"))', want: '"[[\\"a\\",\\"b\\",\\"c\\"],[\\"1\\",\\"2\\",\\"3\\"]]"' },
      { desc: 'quoted comma field', call: 'parseCSV("name,\\"John, Jr.\\"")[0][1]', want: '"John, Jr."' },
      { desc: 'quoted roundtrip', call: 'parseCSV(stringifyCSV([["a,b","c,d"]]))[0][1]', want: '"c,d"' },
      { desc: 'empty cells', call: 'JSON.stringify(parseCSV("a,,c"))', want: '"[[\\"a\\",\\"\\",\\"c\\"]]"' },
      { desc: 'stringify basic', call: 'stringifyCSV([["a","b"],["1","2"]])', want: '"a,b\\n1,2"' },
      { desc: 'stringify quotes comma', call: 'stringifyCSV([["a,b","c"]])', want: '"\\"a,b\\",c"' },
      { desc: 'stringify round-trips quote', call: 'parseCSV(stringifyCSV([["say \\"hi\\""]]))[0][0]', want: '"say \\"hi\\""' },
    ],
  },

  {
    id: 'template-engine',
    filename: 'templateEngine',
    summary: 'Simple mustache-style template engine: replace {{key}} placeholders.',
    defaultPath: 'src/templateEngine.ts',
    exports: ['renderTemplate'],
    patterns: [
      { re: '\\btemplate.*engine|mustache\\b', weight: 0.6 },
      { re: '\\brender.*template|template.*render', weight: 0.5 },
      { re: '\\b\\{\\{.*\\}\\}|placeholder.*replac', weight: 0.4 },
    ],
    impl: `export function renderTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\\{\\{\\s*([\\w.]+)\\s*\\}\\}/g, (_, key) => {
    const val = key.split('.').reduce((obj: unknown, k: string) =>
      obj != null && typeof obj === 'object' ? (obj as Record<string, unknown>)[k] : undefined, vars)
    return val === undefined ? '' : String(val)
  })
}`,
    tests: [
      { desc: 'basic substitution', call: 'renderTemplate("Hello, {{name}}!", {name:"World"})', want: '"Hello, World!"' },
      { desc: 'multiple keys', call: 'renderTemplate("{{a}} + {{b}}", {a:"1",b:"2"})', want: '"1 + 2"' },
      { desc: 'missing key gives empty', call: 'renderTemplate("{{x}}", {})', want: '""' },
      { desc: 'nested key', call: 'renderTemplate("{{user.name}}", {user:{name:"Alice"}})', want: '"Alice"' },
      { desc: 'whitespace in braces', call: 'renderTemplate("{{ name }}", {name:"Bob"})', want: '"Bob"' },
      { desc: 'no placeholders', call: 'renderTemplate("plain text", {})', want: '"plain text"' },
      { desc: 'number value', call: 'renderTemplate("{{n}}", {n:42})', want: '"42"' },
    ],
  },

  // ── More array/collection utilities ────────────────────────────────────────

  {
    id: 'shuffle',
    filename: 'shuffle',
    summary: 'Fisher-Yates shuffle and random sample from an array.',
    defaultPath: 'src/shuffle.ts',
    exports: ['shuffle', 'sample'],
    patterns: [
      { re: '\\bshuffle\\b.*array|array.*\\bshuffle\\b', weight: 0.65 },
      { re: '\\bfisher.*yates\\b', weight: 0.5 },
      { re: '\\bsample\\b.*array|random.*element', weight: 0.4 },
    ],
    impl: `export function shuffle<T>(arr: T[], rng: () => number = Math.random): T[] {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export function sample<T>(arr: T[], rng: () => number = Math.random): T | undefined {
  if (!arr.length) return undefined
  return arr[Math.floor(rng() * arr.length)]
}`,
    tests: [
      { desc: 'shuffle same elements', call: 'shuffle([1,2,3,4,5], ()=>0.5).sort((a,b)=>a-b)', want: '[1,2,3,4,5]' },
      { desc: 'shuffle length preserved', call: 'shuffle([1,2,3]).length', want: '3' },
      { desc: 'shuffle does not mutate', call: '(() => { const a=[1,2,3]; shuffle(a); return a })()', want: '[1,2,3]' },
      { desc: 'shuffle empty', call: 'shuffle([])', want: '[]' },
      { desc: 'sample from array', call: '[1,2,3].includes(sample([1,2,3])!)', want: 'true' },
      { desc: 'sample empty', call: 'sample([])', want: 'undefined' },
      { desc: 'sample single', call: 'sample([42])', want: '42' },
    ],
  },

  {
    id: 'count-by',
    filename: 'countBy',
    summary: 'Count array elements by a key function; tally occurrences.',
    defaultPath: 'src/countBy.ts',
    exports: ['countBy', 'frequencies'],
    patterns: [
      { re: '\\bcountBy\\b|\\bcount.*by\\b', weight: 0.65 },
      { re: '\\bfrequenc|\\btally\\b', weight: 0.45 },
      { re: '\\boccurrence.*count|count.*occurrence', weight: 0.35 },
    ],
    impl: `export function countBy<T>(arr: T[], key: (item: T) => string | number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const item of arr) {
    const k = String(key(item))
    out[k] = (out[k] ?? 0) + 1
  }
  return out
}

export function frequencies<T>(arr: T[]): Map<T, number> {
  const out = new Map<T, number>()
  for (const item of arr) out.set(item, (out.get(item) ?? 0) + 1)
  return out
}`,
    tests: [
      { desc: 'countBy length', call: 'JSON.stringify(countBy(["a","bb","cc","ddd"], s=>s.length))', want: '"{\\"1\\":1,\\"2\\":2,\\"3\\":1}"' },
      { desc: 'countBy parity', call: 'JSON.stringify(countBy([1,2,3,4,5,6], n=>n%2===0?"even":"odd"))', want: '"{\\"odd\\":3,\\"even\\":3}"' },
      { desc: 'countBy empty', call: 'JSON.stringify(countBy([], (x:any)=>x))', want: '"{}"' },
      { desc: 'frequencies basic', call: 'frequencies([1,2,1,3,2,1]).get(1)', want: '3' },
      { desc: 'frequencies missing key', call: 'frequencies([1,2,3]).get(4)', want: 'undefined' },
      { desc: 'frequencies strings', call: 'frequencies(["a","b","a"]).get("a")', want: '2' },
    ],
  },

  {
    id: 'deep-merge',
    filename: 'deepMerge',
    summary: 'Deep merge two plain objects (right overwrites left, arrays replaced).',
    defaultPath: 'src/deepMerge.ts',
    exports: ['deepMerge'],
    patterns: [
      { re: '\\bdeep.*merge|merge.*deep', weight: 0.7 },
      { re: '\\bdeepMerge\\b', weight: 0.35 },
      { re: '\\brecursive.*merge|merge.*nested.*object', weight: 0.4 },
    ],
    impl: `export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  ...sources: Partial<T>[]
): T {
  const out = { ...target } as T
  for (const src of sources) {
    for (const [k, v] of Object.entries(src)) {
      if (v !== null && typeof v === 'object' && !Array.isArray(v) &&
          out[k as keyof T] !== null && typeof out[k as keyof T] === 'object' &&
          !Array.isArray(out[k as keyof T])) {
        (out as Record<string, unknown>)[k] = deepMerge(
          out[k as keyof T] as Record<string, unknown>,
          v as Record<string, unknown>
        )
      } else {
        (out as Record<string, unknown>)[k] = v
      }
    }
  }
  return out
}`,
    tests: [
      { desc: 'basic merge', call: 'JSON.stringify(deepMerge({a:1,b:2},{b:3,c:4}))', want: '"{\\"a\\":1,\\"b\\":3,\\"c\\":4}"' },
      { desc: 'deep nested', call: 'JSON.stringify(deepMerge({a:{x:1,y:2}},{a:{y:3,z:4}}))', want: '"{\\"a\\":{\\"x\\":1,\\"y\\":3,\\"z\\":4}}"' },
      { desc: 'does not mutate target', call: '(() => { const t={a:1}; deepMerge(t,{b:2}); return t })()', want: '{"a":1}' },
      { desc: 'array replaced not merged', call: 'JSON.stringify(deepMerge({a:[1,2]},{a:[3]}))', want: '"{\\"a\\":[3]}"' },
      { desc: 'multiple sources', call: 'JSON.stringify(deepMerge({a:1},{b:2},{c:3}))', want: '"{\\"a\\":1,\\"b\\":2,\\"c\\":3}"' },
      { desc: 'empty source', call: 'JSON.stringify(deepMerge({a:1},{}))', want: '"{\\"a\\":1}"' },
    ],
  },

  // ── Async utilities ────────────────────────────────────────────────────────

  {
    id: 'retry',
    filename: 'retry',
    summary: 'Retry an async callback with exponential backoff (N max attempts).',
    defaultPath: 'src/retry.ts',
    exports: ['retry'],
    patterns: [
      { re: '\\bretry\\b.*async|async.*\\bretry\\b', weight: 0.55 },
      { re: '\\bretry\\b.*backoff|backoff.*\\bretry\\b', weight: 0.6 },
      { re: '\\bexponential.*backoff\\b', weight: 0.5 },
      { re: '\\bretry\\b.*attempt|attempt.*\\bretry\\b', weight: 0.45 },
    ],
    impl: `export interface RetryOpts {
  attempts?: number
  delayMs?: number
  backoff?: number
  onRetry?: (err: unknown, attempt: number) => void
}

export async function retry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const { attempts = 3, delayMs = 100, backoff = 2, onRetry } = opts
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try { return await fn() } catch (err) {
      lastErr = err
      if (i < attempts - 1) {
        onRetry?.(err, i + 1)
        await new Promise(r => setTimeout(r, delayMs * backoff ** i))
      }
    }
  }
  throw lastErr
}`,
    tests: [
      { desc: 'succeeds first try', call: '(async()=>await retry(()=>Promise.resolve(42)))()', want: '42' },
      { desc: 'succeeds after retry', call: '(async()=>{let n=0;return await retry(()=>++n<3?Promise.reject("e"):Promise.resolve(n),{attempts:3,delayMs:0})})()', want: '3' },
      { desc: 'throws after max attempts', call: '(async()=>{try{await retry(()=>Promise.reject("fail"),{attempts:2,delayMs:0})}catch(e){return e}})()', want: '"fail"' },
      { desc: 'onRetry called', call: '(async()=>{let calls=0;try{await retry(()=>Promise.reject("e"),{attempts:3,delayMs:0,onRetry:()=>calls++})}catch{}return calls})()', want: '2' },
      { desc: 'default 3 attempts', call: '(async()=>{let n=0;try{await retry(()=>{n++;return Promise.reject("e")},{delayMs:0})}catch{}return n})()', want: '3' },
    ],
  },

  {
    id: 'debounce-throttle',
    filename: 'debounceThrottle',
    summary: 'Debounce and throttle: delay or rate-limit repeated calls.',
    defaultPath: 'src/debounceThrottle.ts',
    exports: ['debounce', 'throttle'],
    patterns: [
      { re: '\\bdebounce\\b', weight: 0.6 },
      { re: '\\bthrottle\\b', weight: 0.5 },
      { re: '\\bdebounce.*throttle|throttle.*debounce', weight: 0.65 },
    ],
    impl: `export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T, waitMs: number, now: () => number = Date.now
): T & { cancel(): void; flush(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  let last: unknown
  const debounced = (...args: unknown[]) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; last = fn(...args) }, waitMs)
  }
  debounced.cancel = () => { if (timer) { clearTimeout(timer); timer = null } }
  debounced.flush = () => { if (timer) { clearTimeout(timer); timer = null } }
  return debounced as T & { cancel(): void; flush(): void }
}

export function throttle<T extends (...args: unknown[]) => unknown>(
  fn: T, waitMs: number, now: () => number = Date.now
): T & { cancel(): void } {
  let last = -Infinity
  const throttled = (...args: unknown[]) => {
    const t = now()
    if (t - last >= waitMs) { last = t; return fn(...args) }
  }
  throttled.cancel = () => { last = -Infinity }
  return throttled as T & { cancel(): void }
}`,
    tests: [
      { desc: 'throttle allows first call', call: '(() => { let n=0; const t=throttle(()=>n++,100); t(); return n })()', want: '1' },
      { desc: 'throttle blocks second call', call: '(() => { let n=0; const now=()=>0; const t=throttle(()=>n++,100,now); t(); t(); return n })()', want: '1' },
      { desc: 'throttle allows after wait', call: '(() => { let n=0; let time=0; const t=throttle(()=>n++,100,()=>time); t(); time=100; t(); return n })()', want: '2' },
      { desc: 'debounce returns cancel/flush', call: '(() => { const d=debounce(()=>{},50); return typeof d.cancel === "function" && typeof d.flush === "function" })()', want: 'true' },
      { desc: 'throttle cancel resets', call: '(() => { let n=0; const now=()=>0; const t=throttle(()=>n++,100,now); t(); t.cancel(); t(); return n })()', want: '2' },
    ],
  },

  // ── Crypto / hashing utilities ─────────────────────────────────────────────

  {
    id: 'hash-utils',
    filename: 'hashUtils',
    summary: 'Fast non-cryptographic hash (djb2) and simple checksum utilities.',
    defaultPath: 'src/hashUtils.ts',
    exports: ['djb2Hash', 'simpleChecksum'],
    patterns: [
      { re: '\\bdjb2\\b|\\bhash.*string|string.*hash', weight: 0.55 },
      { re: '\\bchecksum\\b', weight: 0.5 },
      { re: '\\bnon.*cryptograph.*hash|fast.*hash', weight: 0.4 },
    ],
    impl: `export function djb2Hash(str: string): number {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i)
    hash |= 0  // convert to 32-bit int
  }
  return hash >>> 0  // unsigned
}

export function simpleChecksum(str: string): number {
  return str.split('').reduce((sum, c) => (sum + c.charCodeAt(0)) & 0xffff, 0)
}`,
    tests: [
      { desc: 'djb2 hello is number', call: 'typeof djb2Hash("hello") === "number"', want: 'true' },
      { desc: 'djb2 empty', call: 'djb2Hash("")', want: '5381' },
      { desc: 'djb2 deterministic', call: 'djb2Hash("test") === djb2Hash("test")', want: 'true' },
      { desc: 'djb2 different strings differ', call: 'djb2Hash("abc") !== djb2Hash("xyz")', want: 'true' },
      { desc: 'checksum empty', call: 'simpleChecksum("")', want: '0' },
      { desc: 'checksum deterministic', call: 'simpleChecksum("hello") === simpleChecksum("hello")', want: 'true' },
      { desc: 'checksum in range', call: 'simpleChecksum("hello world") <= 0xffff', want: 'true' },
    ],
  },

  // ── UUID generation ────────────────────────────────────────────────────────

  {
    id: 'uuid',
    filename: 'uuid',
    summary: 'Generate a UUID v4 string.',
    defaultPath: 'src/uuid.ts',
    exports: ['uuidv4'],
    patterns: [
      { re: '\\buuid\\b.*generat|generat.*\\buuid\\b', weight: 0.65 },
      { re: '\\buuidv4\\b|\\buuid.*v4\\b', weight: 0.5 },
      { re: '\\brandom.*uuid|unique.*id.*generat', weight: 0.35 },
    ],
    impl: `export function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
  })
}`,
    tests: [
      { desc: 'format matches uuid v4', call: '/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuidv4())', want: 'true' },
      { desc: 'length is 36', call: 'uuidv4().length', want: '36' },
      { desc: 'unique each call', call: 'uuidv4() !== uuidv4()', want: 'true' },
      { desc: 'version digit is 4', call: 'uuidv4()[14]', want: '"4"' },
      { desc: 'variant digit is 8-b', call: '"89ab".includes(uuidv4()[19])', want: 'true' },
    ],
  },

  // ── Math & numbers ────────────────────────────────────────────────────────

  {
    id: 'math-stats',
    filename: 'mathStats',
    summary: 'sum, average, median, mode of a number array.',
    defaultPath: 'src/mathStats.ts',
    exports: ['sum', 'average', 'median', 'mode'],
    patterns: [
      { re: '\\bsum\\b.*array|array.*\\bsum\\b', weight: 0.4 },
      { re: '\\baverage\\b|\\bmean\\b', weight: 0.5 },
      { re: '\\bmedian\\b', weight: 0.55 },
      { re: '\\bmode\\b.*array|most.*frequent.*number', weight: 0.5 },
      { re: '\\bsum.*average|average.*median|median.*mode', weight: 0.6 },
    ],
    impl: `export function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0)
}

export function average(arr: number[]): number {
  if (!arr.length) return NaN
  return sum(arr) / arr.length
}

export function median(arr: number[]): number {
  if (!arr.length) return NaN
  const s = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid]
}

export function mode(arr: number[]): number[] {
  if (!arr.length) return []
  const freq = new Map<number, number>()
  for (const n of arr) freq.set(n, (freq.get(n) ?? 0) + 1)
  const max = Math.max(...freq.values())
  return [...freq.entries()].filter(([, v]) => v === max).map(([k]) => k).sort((a, b) => a - b)
}`,
    tests: [
      { desc: 'sum basic', call: 'sum([1,2,3,4,5])', want: '15' },
      { desc: 'sum empty', call: 'sum([])', want: '0' },
      { desc: 'sum negatives', call: 'sum([-1,-2,3])', want: '0' },
      { desc: 'average basic', call: 'average([1,2,3,4,5])', want: '3' },
      { desc: 'average empty', call: 'Number.isNaN(average([]))', want: 'true' },
      { desc: 'average float', call: 'average([1,2])', want: '1.5' },
      { desc: 'median odd', call: 'median([3,1,2])', want: '2' },
      { desc: 'median even', call: 'median([1,2,3,4])', want: '2.5' },
      { desc: 'median unsorted', call: 'median([5,1,3])', want: '3' },
      { desc: 'mode single', call: 'mode([1,2,2,3])', want: '[2]' },
      { desc: 'mode multi', call: 'mode([1,1,2,2,3])', want: '[1,2]' },
      { desc: 'mode all same', call: 'mode([3,3,3])', want: '[3]' },
    ],
  },

  {
    id: 'random-int',
    filename: 'randomInt',
    summary: 'Generate a random integer between min and max (inclusive).',
    defaultPath: 'src/randomInt.ts',
    exports: ['randomInt'],
    patterns: [
      { re: '\\brandom.*int|random.*integer', weight: 0.65 },
      { re: '\\brandomInt\\b', weight: 0.4 },
      { re: '\\brandom.*number.*between|random.*between.*min.*max', weight: 0.5 },
    ],
    impl: `export function randomInt(min: number, max: number, rng: () => number = Math.random): number {
  return Math.floor(rng() * (max - min + 1)) + min
}`,
    tests: [
      { desc: 'in range', call: '(() => { const n = randomInt(1, 10); return n >= 1 && n <= 10 })()', want: 'true' },
      { desc: 'min equals max', call: 'randomInt(5, 5)', want: '5' },
      { desc: 'deterministic with rng', call: 'randomInt(0, 9, () => 0)', want: '0' },
      { desc: 'deterministic max', call: 'randomInt(0, 9, () => 0.9999)', want: '9' },
      { desc: 'negative range', call: 'randomInt(-5, -1, () => 0)', want: '-5' },
      { desc: 'is integer', call: 'Number.isInteger(randomInt(1, 100))', want: 'true' },
    ],
  },

  {
    id: 'number-theory',
    filename: 'numberTheory',
    summary: 'gcd, lcm, isPrime, factorial, fibonacci.',
    defaultPath: 'src/numberTheory.ts',
    exports: ['gcd', 'lcm', 'isPrime', 'factorial', 'fibonacci'],
    patterns: [
      { re: '\\bgcd\\b|greatest.*common.*divisor', weight: 0.6 },
      { re: '\\blcm\\b|least.*common.*multiple', weight: 0.5 },
      { re: '\\bisPrime\\b|prime.*number.*check', weight: 0.55 },
      { re: '\\bfactorial\\b', weight: 0.6 },
      { re: '\\bfibonacci\\b', weight: 0.65 },
      { re: '\\bgcd.*lcm|factorial.*fibonacci', weight: 0.55 },
    ],
    impl: `export function gcd(a: number, b: number): number {
  a = Math.abs(a); b = Math.abs(b)
  while (b) { [a, b] = [b, a % b] }
  return a
}

export function lcm(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : Math.abs(a * b) / gcd(a, b)
}

export function isPrime(n: number): boolean {
  if (n < 2) return false
  if (n < 4) return true
  if (n % 2 === 0 || n % 3 === 0) return false
  for (let i = 5; i * i <= n; i += 6) if (n % i === 0 || n % (i + 2) === 0) return false
  return true
}

export function factorial(n: number): number {
  if (n < 0) throw new Error('negative factorial')
  return n <= 1 ? 1 : n * factorial(n - 1)
}

export function fibonacci(n: number): number {
  if (n < 0) throw new Error('negative fibonacci')
  if (n <= 1) return n
  let a = 0, b = 1
  for (let i = 2; i <= n; i++) [a, b] = [b, a + b]
  return b
}`,
    tests: [
      { desc: 'gcd basic', call: 'gcd(12, 8)', want: '4' },
      { desc: 'gcd primes', call: 'gcd(13, 7)', want: '1' },
      { desc: 'gcd with zero', call: 'gcd(0, 5)', want: '5' },
      { desc: 'lcm basic', call: 'lcm(4, 6)', want: '12' },
      { desc: 'lcm with zero', call: 'lcm(0, 5)', want: '0' },
      { desc: 'isPrime 2', call: 'isPrime(2)', want: 'true' },
      { desc: 'isPrime 1', call: 'isPrime(1)', want: 'false' },
      { desc: 'isPrime 17', call: 'isPrime(17)', want: 'true' },
      { desc: 'isPrime 4', call: 'isPrime(4)', want: 'false' },
      { desc: 'isPrime 97', call: 'isPrime(97)', want: 'true' },
      { desc: 'factorial 0', call: 'factorial(0)', want: '1' },
      { desc: 'factorial 5', call: 'factorial(5)', want: '120' },
      { desc: 'fibonacci 0', call: 'fibonacci(0)', want: '0' },
      { desc: 'fibonacci 1', call: 'fibonacci(1)', want: '1' },
      { desc: 'fibonacci 10', call: 'fibonacci(10)', want: '55' },
    ],
  },

  // ── Data structures ────────────────────────────────────────────────────────

  {
    id: 'stack',
    filename: 'stack',
    summary: 'LIFO stack with push, pop, peek, size, isEmpty.',
    defaultPath: 'src/stack.ts',
    exports: ['Stack'],
    patterns: [
      { re: '\\bstack\\b.*(?:push|pop|peek|lifo)', weight: 0.65 },
      { re: '\\blifo\\b', weight: 0.6 },
      { re: '\\bStack\\b', weight: 0.4 },
    ],
    impl: `export class Stack<T> {
  private items: T[] = []

  push(item: T): void { this.items.push(item) }
  pop(): T | undefined { return this.items.pop() }
  peek(): T | undefined { return this.items[this.items.length - 1] }
  size(): number { return this.items.length }
  isEmpty(): boolean { return this.items.length === 0 }
  toArray(): T[] { return [...this.items] }
  clear(): void { this.items = [] }
}`,
    tests: [
      { desc: 'push and pop', call: '(() => { const s = new Stack<number>(); s.push(1); s.push(2); return s.pop() })()', want: '2' },
      { desc: 'peek does not remove', call: '(() => { const s = new Stack<number>(); s.push(1); s.peek(); return s.size() })()', want: '1' },
      { desc: 'isEmpty true', call: 'new Stack().isEmpty()', want: 'true' },
      { desc: 'isEmpty false', call: '(() => { const s = new Stack<number>(); s.push(1); return s.isEmpty() })()', want: 'false' },
      { desc: 'pop empty', call: 'new Stack().pop()', want: 'undefined' },
      { desc: 'size', call: '(() => { const s = new Stack<number>(); s.push(1); s.push(2); s.push(3); return s.size() })()', want: '3' },
      { desc: 'toArray order', call: '(() => { const s = new Stack<number>(); s.push(1); s.push(2); return s.toArray() })()', want: '[1,2]' },
      { desc: 'clear', call: '(() => { const s = new Stack<number>(); s.push(1); s.clear(); return s.size() })()', want: '0' },
    ],
  },

  {
    id: 'queue',
    filename: 'queue',
    summary: 'FIFO queue with enqueue, dequeue, peek, size, isEmpty.',
    defaultPath: 'src/queue.ts',
    exports: ['Queue'],
    patterns: [
      { re: '\\bqueue\\b.*(?:enqueue|dequeue|fifo)', weight: 0.65 },
      { re: '\\bfifo\\b', weight: 0.6 },
      { re: '\\bQueue\\b', weight: 0.4 },
    ],
    impl: `export class Queue<T> {
  private items: T[] = []
  private head = 0

  enqueue(item: T): void { this.items.push(item) }
  dequeue(): T | undefined {
    if (this.head >= this.items.length) return undefined
    const item = this.items[this.head++]
    if (this.head > this.items.length / 2) { this.items = this.items.slice(this.head); this.head = 0 }
    return item
  }
  peek(): T | undefined { return this.items[this.head] }
  size(): number { return this.items.length - this.head }
  isEmpty(): boolean { return this.size() === 0 }
  toArray(): T[] { return this.items.slice(this.head) }
  clear(): void { this.items = []; this.head = 0 }
}`,
    tests: [
      { desc: 'enqueue and dequeue FIFO', call: '(() => { const q = new Queue<number>(); q.enqueue(1); q.enqueue(2); return q.dequeue() })()', want: '1' },
      { desc: 'peek first', call: '(() => { const q = new Queue<number>(); q.enqueue(1); q.enqueue(2); return q.peek() })()', want: '1' },
      { desc: 'isEmpty true', call: 'new Queue().isEmpty()', want: 'true' },
      { desc: 'dequeue empty', call: 'new Queue().dequeue()', want: 'undefined' },
      { desc: 'size after enqueue', call: '(() => { const q = new Queue<number>(); q.enqueue(1); q.enqueue(2); return q.size() })()', want: '2' },
      { desc: 'size after dequeue', call: '(() => { const q = new Queue<number>(); q.enqueue(1); q.enqueue(2); q.dequeue(); return q.size() })()', want: '1' },
      { desc: 'toArray order', call: '(() => { const q = new Queue<number>(); q.enqueue(1); q.enqueue(2); q.enqueue(3); return q.toArray() })()', want: '[1,2,3]' },
    ],
  },

  {
    id: 'binary-search',
    filename: 'binarySearch',
    summary: 'Binary search a sorted array; return index or -1.',
    defaultPath: 'src/binarySearch.ts',
    exports: ['binarySearch', 'lowerBound', 'upperBound'],
    patterns: [
      { re: '\\bbinary.*search\\b', weight: 0.75 },
      { re: '\\bbinarySearch\\b', weight: 0.4 },
      { re: '\\bsorted.*array.*search|search.*sorted.*array', weight: 0.45 },
    ],
    impl: `export function binarySearch(arr: number[], target: number): number {
  let lo = 0, hi = arr.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid] === target) return mid
    else if (arr[mid] < target) lo = mid + 1
    else hi = mid - 1
  }
  return -1
}

export function lowerBound(arr: number[], target: number): number {
  let lo = 0, hi = arr.length
  while (lo < hi) { const mid = (lo + hi) >>> 1; arr[mid] < target ? lo = mid + 1 : hi = mid }
  return lo
}

export function upperBound(arr: number[], target: number): number {
  let lo = 0, hi = arr.length
  while (lo < hi) { const mid = (lo + hi) >>> 1; arr[mid] <= target ? lo = mid + 1 : hi = mid }
  return lo
}`,
    tests: [
      { desc: 'found mid', call: 'binarySearch([1,3,5,7,9], 5)', want: '2' },
      { desc: 'found first', call: 'binarySearch([1,3,5,7,9], 1)', want: '0' },
      { desc: 'found last', call: 'binarySearch([1,3,5,7,9], 9)', want: '4' },
      { desc: 'not found', call: 'binarySearch([1,3,5,7,9], 4)', want: '-1' },
      { desc: 'empty array', call: 'binarySearch([], 1)', want: '-1' },
      { desc: 'lowerBound', call: 'lowerBound([1,2,2,3,4], 2)', want: '1' },
      { desc: 'upperBound', call: 'upperBound([1,2,2,3,4], 2)', want: '3' },
      { desc: 'single element found', call: 'binarySearch([42], 42)', want: '0' },
    ],
  },

  {
    id: 'sorting',
    filename: 'sorting',
    summary: 'Merge sort, quick sort, and insertion sort for number arrays.',
    defaultPath: 'src/sorting.ts',
    exports: ['mergeSort', 'quickSort', 'insertionSort'],
    patterns: [
      { re: '\\bmerge.*sort\\b', weight: 0.65 },
      { re: '\\bquick.*sort\\b', weight: 0.6 },
      { re: '\\binsertion.*sort\\b', weight: 0.55 },
      { re: '\\bmergeSort\\b|\\bquickSort\\b', weight: 0.4 },
    ],
    impl: `export function mergeSort(arr: number[]): number[] {
  if (arr.length <= 1) return arr
  const mid = arr.length >> 1
  const left = mergeSort(arr.slice(0, mid))
  const right = mergeSort(arr.slice(mid))
  const out: number[] = []
  let i = 0, j = 0
  while (i < left.length && j < right.length) {
    left[i] <= right[j] ? out.push(left[i++]) : out.push(right[j++])
  }
  return out.concat(left.slice(i), right.slice(j))
}

export function quickSort(arr: number[]): number[] {
  if (arr.length <= 1) return arr
  const pivot = arr[arr.length >> 1]
  const left = arr.filter(x => x < pivot)
  const mid = arr.filter(x => x === pivot)
  const right = arr.filter(x => x > pivot)
  return [...quickSort(left), ...mid, ...quickSort(right)]
}

export function insertionSort(arr: number[]): number[] {
  const out = [...arr]
  for (let i = 1; i < out.length; i++) {
    const key = out[i]; let j = i - 1
    while (j >= 0 && out[j] > key) { out[j + 1] = out[j]; j-- }
    out[j + 1] = key
  }
  return out
}`,
    tests: [
      { desc: 'mergeSort basic', call: 'mergeSort([3,1,4,1,5,9,2,6])', want: '[1,1,2,3,4,5,6,9]' },
      { desc: 'mergeSort empty', call: 'mergeSort([])', want: '[]' },
      { desc: 'mergeSort sorted', call: 'mergeSort([1,2,3])', want: '[1,2,3]' },
      { desc: 'mergeSort reverse', call: 'mergeSort([5,4,3,2,1])', want: '[1,2,3,4,5]' },
      { desc: 'quickSort basic', call: 'quickSort([3,1,4,1,5,9,2,6])', want: '[1,1,2,3,4,5,6,9]' },
      { desc: 'quickSort empty', call: 'quickSort([])', want: '[]' },
      { desc: 'insertionSort basic', call: 'insertionSort([5,2,4,6,1,3])', want: '[1,2,3,4,5,6]' },
      { desc: 'insertionSort single', call: 'insertionSort([1])', want: '[1]' },
      { desc: 'does not mutate input', call: '(() => { const a=[3,1,2]; mergeSort(a); return a })()', want: '[3,1,2]' },
    ],
  },

  // ── String extras ──────────────────────────────────────────────────────────

  {
    id: 'word-wrap',
    filename: 'wordWrap',
    summary: 'Wrap text at a given column width without breaking words.',
    defaultPath: 'src/wordWrap.ts',
    exports: ['wordWrap'],
    patterns: [
      { re: '\\bword.*wrap|wrap.*text', weight: 0.7 },
      { re: '\\bwordWrap\\b', weight: 0.4 },
      { re: '\\bline.*length.*wrap|column.*width.*wrap', weight: 0.4 },
    ],
    impl: `export function wordWrap(text: string, width: number): string {
  const words = text.split(/\\s+/)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (!word) continue
    if (!current) { current = word; continue }
    if (current.length + 1 + word.length <= width) {
      current += ' ' + word
    } else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines.join('\\n')
}`,
    tests: [
      { desc: 'basic wrap', call: 'wordWrap("the quick brown fox", 10)', want: '"the quick\\nbrown fox"' },
      { desc: 'no wrap needed', call: 'wordWrap("hello world", 20)', want: '"hello world"' },
      { desc: 'single word', call: 'wordWrap("hello", 3)', want: '"hello"' },
      { desc: 'empty', call: 'wordWrap("", 10)', want: '""' },
      { desc: 'over width wraps', call: 'wordWrap("hi there!", 8)', want: '"hi\\nthere!"' },
      { desc: 'multiple lines', call: 'wordWrap("a b c d e", 3)', want: '"a b\\nc d\\ne"' },
    ],
  },

  {
    id: 'hex-encode',
    filename: 'hexEncode',
    summary: 'Encode a string to hex; decode hex back to a string.',
    defaultPath: 'src/hexEncode.ts',
    exports: ['hexEncode', 'hexDecode'],
    patterns: [
      { re: '\\bhex.*encod|encod.*hex', weight: 0.65 },
      { re: '\\bhexEncode\\b|\\bhexDecode\\b', weight: 0.4 },
      { re: '\\bhexadecimal.*string|string.*hexadecimal', weight: 0.4 },
    ],
    impl: `export function hexEncode(str: string): string {
  return Buffer.from(str, 'utf8').toString('hex')
}

export function hexDecode(hex: string): string {
  return Buffer.from(hex, 'hex').toString('utf8')
}`,
    tests: [
      { desc: 'encode hello', call: 'hexEncode("hello")', want: '"68656c6c6f"' },
      { desc: 'encode empty', call: 'hexEncode("")', want: '""' },
      { desc: 'decode hello', call: 'hexDecode("68656c6c6f")', want: '"hello"' },
      { desc: 'roundtrip', call: 'hexDecode(hexEncode("Hello World!"))', want: '"Hello World!"' },
      { desc: 'roundtrip unicode', call: 'hexDecode(hexEncode("café"))', want: '"café"' },
    ],
  },

  {
    id: 'rot13',
    filename: 'rot13',
    summary: 'ROT13 substitution cipher — encode and decode (same operation).',
    defaultPath: 'src/rot13.ts',
    exports: ['rot13'],
    patterns: [
      { re: '\\brot13\\b|\\brot-13\\b', weight: 0.85 },
      { re: '\\bcaesar.*cipher|substitution.*cipher', weight: 0.3 },
    ],
    impl: `export function rot13(str: string): string {
  return str.replace(/[a-zA-Z]/g, c => {
    const base = c <= 'Z' ? 65 : 97
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base)
  })
}`,
    tests: [
      { desc: 'hello', call: 'rot13("hello")', want: '"uryyb"' },
      { desc: 'HELLO', call: 'rot13("HELLO")', want: '"URYYB"' },
      { desc: 'involution', call: 'rot13(rot13("Hello, World!"))', want: '"Hello, World!"' },
      { desc: 'preserves non-alpha', call: 'rot13("Hello, 123!")', want: '"Uryyb, 123!"' },
      { desc: 'empty', call: 'rot13("")', want: '""' },
      { desc: 'mixed case', call: 'rot13("aBcDeFg")', want: '"nOpQrSt"' },
    ],
  },

  {
    id: 'safe-json',
    filename: 'safeJSON',
    summary: 'Safe JSON parse (returns null on error) and safe stringify (handles circular).',
    defaultPath: 'src/safeJSON.ts',
    exports: ['safeJSONParse', 'safeJSONStringify'],
    patterns: [
      { re: '\\bsafe.*json.*parse|json.*parse.*safe', weight: 0.65 },
      { re: '\\bsafeJSON\\b|\\bsafeJSONParse\\b', weight: 0.4 },
      { re: '\\bjson.*parse.*error|parse.*json.*try.*catch', weight: 0.45 },
    ],
    impl: `export function safeJSONParse<T = unknown>(str: string, fallback: T | null = null): T | null {
  try { return JSON.parse(str) } catch { return fallback }
}

export function safeJSONStringify(value: unknown, space?: number): string {
  const seen = new WeakSet()
  return JSON.stringify(value, (_, v) => {
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) return '[Circular]'
      seen.add(v)
    }
    return v
  }, space)
}`,
    tests: [
      { desc: 'parse valid', call: 'safeJSONParse(\'{"a":1}\')', want: '{"a":1}' },
      { desc: 'parse invalid returns null', call: 'safeJSONParse("not json")', want: 'null' },
      { desc: 'parse with fallback', call: 'safeJSONParse("bad", 42)', want: '42' },
      { desc: 'stringify basic', call: 'safeJSONStringify({a:1,b:2})', want: '"{\\"a\\":1,\\"b\\":2}"' },
      { desc: 'stringify circular safe', call: '(() => { const o: any = {a:1}; o.self = o; return safeJSONStringify(o) })()', want: '"{\\"a\\":1,\\"self\\":\\"[Circular]\\"}"' },
      { desc: 'stringify with space', call: 'safeJSONStringify({a:1}, 2).includes("\\n")', want: 'true' },
    ],
  },

  {
    id: 'sleep',
    filename: 'sleep',
    summary: 'Async sleep for N milliseconds; setTimeout-based delay.',
    defaultPath: 'src/sleep.ts',
    exports: ['sleep'],
    patterns: [
      { re: '\\bsleep\\b.*ms|async.*sleep', weight: 0.7 },
      { re: '\\bdelay\\b.*promise|promise.*delay', weight: 0.55 },
      { re: '\\bwait.*millisecond|setTimeout.*promise', weight: 0.45 },
    ],
    impl: `export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}`,
    tests: [
      { desc: 'resolves', call: 'sleep(0)', want: 'undefined' },
      { desc: 'returns promise', call: 'sleep(0) instanceof Promise', want: 'true' },
      { desc: 'awaitable', call: '(async () => { await sleep(0); return true })()', want: 'true' },
    ],
  },

  {
    id: 'deep-freeze',
    filename: 'deepFreeze',
    summary: 'Recursively freeze an object so it cannot be mutated.',
    defaultPath: 'src/deepFreeze.ts',
    exports: ['deepFreeze'],
    patterns: [
      { re: '\\bdeep.*freeze|freeze.*deep', weight: 0.7 },
      { re: '\\bdeepFreeze\\b', weight: 0.4 },
      { re: '\\bimmutable.*object|freeze.*nested', weight: 0.4 },
    ],
    impl: `export function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== 'object') return obj
  Object.freeze(obj)
  for (const key of Object.keys(obj as object)) {
    deepFreeze((obj as Record<string, unknown>)[key])
  }
  return obj as Readonly<T>
}`,
    tests: [
      { desc: 'top level frozen', call: '(() => { const o = deepFreeze({a:1}); return Object.isFrozen(o) })()', want: 'true' },
      { desc: 'nested frozen', call: '(() => { const o = deepFreeze({a:{b:1}}); return Object.isFrozen(o.a) })()', want: 'true' },
      { desc: 'returns original', call: '(() => { const o = {a:1}; return deepFreeze(o) === o })()', want: 'true' },
      { desc: 'primitive passthrough', call: 'deepFreeze(42)', want: '42' },
      { desc: 'null passthrough', call: 'deepFreeze(null)', want: 'null' },
    ],
  },

  // ── Parsers (Tier-1B) ──────────────────────────────────────────────────────

  {
    id: 'ini-parse',
    filename: 'iniParse',
    summary: 'Parse INI/config file format to a nested object; stringify back.',
    defaultPath: 'src/iniParse.ts',
    exports: ['parseINI', 'stringifyINI'],
    patterns: [
      { re: '\\bini\\b.*pars|pars.*\\bini\\b', weight: 0.7 },
      { re: '\\bconfig.*file.*pars|pars.*config.*file', weight: 0.35 },
      { re: '\\bparseINI\\b|\\bstringifyINI\\b', weight: 0.4 },
    ],
    impl: `export type INIData = Record<string, string | Record<string, string>>

export function parseINI(text: string): INIData {
  const out: INIData = {}
  let section = ''
  for (const raw of text.split('\\n')) {
    const line = raw.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    const sMatch = line.match(/^\\[([^\\]]+)\\]$/)
    if (sMatch) { section = sMatch[1]; out[section] = out[section] as Record<string, string> ?? {}; continue }
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    const val = line.slice(eq + 1).trim()
    if (section) (out[section] as Record<string, string>)[key] = val
    else out[key] = val
  }
  return out
}

export function stringifyINI(data: INIData): string {
  const lines: string[] = []
  const global: [string, string][] = []
  const sections: [string, Record<string, string>][] = []
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string') global.push([k, v])
    else sections.push([k, v])
  }
  for (const [k, v] of global) lines.push(\`\${k}=\${v}\`)
  for (const [sec, kvs] of sections) {
    if (lines.length) lines.push('')
    lines.push(\`[\${sec}]\`)
    for (const [k, v] of Object.entries(kvs)) lines.push(\`\${k}=\${v}\`)
  }
  return lines.join('\\n')
}`,
    tests: [
      { desc: 'parse global key', call: 'parseINI("key=value")["key"]', want: '"value"' },
      { desc: 'parse section', call: '(parseINI("[db]\\nhost=localhost") ["db"] as any)["host"]', want: '"localhost"' },
      { desc: 'skip comments', call: 'Object.keys(parseINI("; comment\\nkey=val")).length', want: '1' },
      { desc: 'parse empty', call: 'JSON.stringify(parseINI(""))', want: '"{}"' },
      { desc: 'stringify global', call: 'stringifyINI({key:"val"})', want: '"key=val"' },
      { desc: 'stringify section', call: 'stringifyINI({db:{host:"localhost"}})', want: '"[db]\\nhost=localhost"' },
      { desc: 'roundtrip', call: '(parseINI(stringifyINI({a:"1",s:{x:"2"}})) as any)["s"]["x"]', want: '"2"' },
    ],
  },

  {
    id: 'dotenv-parse',
    filename: 'dotenvParse',
    summary: 'Parse .env file format to a Record<string, string>.',
    defaultPath: 'src/dotenvParse.ts',
    exports: ['parseDotenv', 'stringifyDotenv'],
    patterns: [
      { re: '\\bdotenv\\b|\\b\\.env\\b', weight: 0.75 },
      { re: '\\benv.*file.*pars|pars.*env.*file', weight: 0.5 },
      { re: '\\bparseDotenv\\b', weight: 0.4 },
    ],
    impl: `export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

export function stringifyDotenv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => v.includes(' ') || v.includes('"') || v.includes("'")
      ? \`\${k}="\${v.replace(/"/g, '\\\\"')}"\`
      : \`\${k}=\${v}\`)
    .join('\\n')
}`,
    tests: [
      { desc: 'parse basic', call: 'parseDotenv("KEY=value")["KEY"]', want: '"value"' },
      { desc: 'parse quoted double', call: 'parseDotenv(\'KEY="hello world"\')["KEY"]', want: '"hello world"' },
      { desc: 'parse quoted single', call: "parseDotenv(\"KEY='hello'\")[\"KEY\"]", want: '"hello"' },
      { desc: 'skip comments', call: 'Object.keys(parseDotenv("# comment\\nK=v")).length', want: '1' },
      { desc: 'multiple keys', call: 'parseDotenv("A=1\\nB=2")["B"]', want: '"2"' },
      { desc: 'stringify basic', call: 'stringifyDotenv({FOO:"bar"})', want: '"FOO=bar"' },
      { desc: 'stringify with spaces quotes', call: 'stringifyDotenv({A:"hello world"}).startsWith("A=\\"")', want: 'true' },
      { desc: 'roundtrip', call: 'parseDotenv(stringifyDotenv({K:"v",X:"y"}))["X"]', want: '"y"' },
    ],
  },

  {
    id: 'cookie-parse',
    filename: 'cookieParse',
    summary: 'Parse HTTP Cookie header to a Record; serialize a cookie value.',
    defaultPath: 'src/cookieParse.ts',
    exports: ['parseCookies', 'serializeCookie'],
    patterns: [
      { re: '\\bcookie.*pars|pars.*cookie', weight: 0.7 },
      { re: '\\bhttp.*cookie|cookie.*header', weight: 0.5 },
      { re: '\\bparseCookies\\b|\\bserializeCookie\\b', weight: 0.4 },
    ],
    impl: `export function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const key = decodeURIComponent(part.slice(0, eq).trim())
    const val = decodeURIComponent(part.slice(eq + 1).trim())
    out[key] = val
  }
  return out
}

export function serializeCookie(
  name: string, value: string,
  opts: { maxAge?: number; path?: string; httpOnly?: boolean; secure?: boolean } = {}
): string {
  let str = \`\${encodeURIComponent(name)}=\${encodeURIComponent(value)}\`
  if (opts.maxAge !== undefined) str += \`; Max-Age=\${opts.maxAge}\`
  if (opts.path) str += \`; Path=\${opts.path}\`
  if (opts.httpOnly) str += '; HttpOnly'
  if (opts.secure) str += '; Secure'
  return str
}`,
    tests: [
      { desc: 'parse single', call: 'parseCookies("session=abc123")["session"]', want: '"abc123"' },
      { desc: 'parse multiple', call: 'parseCookies("a=1; b=2; c=3")["b"]', want: '"2"' },
      { desc: 'parse encoded', call: 'parseCookies("k=hello%20world")["k"]', want: '"hello world"' },
      { desc: 'parse empty', call: 'JSON.stringify(parseCookies(""))', want: '"{}"' },
      { desc: 'serialize basic', call: 'serializeCookie("id", "abc")', want: '"id=abc"' },
      { desc: 'serialize maxAge', call: 'serializeCookie("id","abc",{maxAge:3600})', want: '"id=abc; Max-Age=3600"' },
      { desc: 'serialize httpOnly', call: 'serializeCookie("id","abc",{httpOnly:true})', want: '"id=abc; HttpOnly"' },
      { desc: 'serialize encodes name', call: 'serializeCookie("my id","val")', want: '"my%20id=val"' },
    ],
  },

  // ── More math / number ─────────────────────────────────────────────────────

  {
    id: 'percent',
    filename: 'percent',
    summary: 'Calculate percentage, percentage change, and percentage of total.',
    defaultPath: 'src/percent.ts',
    exports: ['percent', 'percentChange', 'percentOf'],
    patterns: [
      { re: '\\bpercent\\b|\\bpercentage\\b', weight: 0.55 },
      { re: '\\bpercentChange\\b|\\bpercentOf\\b', weight: 0.4 },
      { re: '\\bpercent.*change|change.*percent', weight: 0.45 },
    ],
    impl: `export function percent(value: number, total: number): number {
  if (total === 0) return 0
  return (value / total) * 100
}

export function percentChange(from: number, to: number): number {
  if (from === 0) return to === 0 ? 0 : Infinity
  return ((to - from) / Math.abs(from)) * 100
}

export function percentOf(pct: number, total: number): number {
  return (pct / 100) * total
}`,
    tests: [
      { desc: 'percent basic', call: 'percent(25, 100)', want: '25' },
      { desc: 'percent zero total', call: 'percent(5, 0)', want: '0' },
      { desc: 'percent half', call: 'percent(1, 2)', want: '50' },
      { desc: 'percentChange increase', call: 'percentChange(100, 150)', want: '50' },
      { desc: 'percentChange decrease', call: 'percentChange(200, 100)', want: '-50' },
      { desc: 'percentChange no change', call: 'percentChange(100, 100)', want: '0' },
      { desc: 'percentOf basic', call: 'percentOf(25, 200)', want: '50' },
      { desc: 'percentOf zero', call: 'percentOf(0, 100)', want: '0' },
    ],
  },

  {
    id: 'number-format-utils',
    filename: 'numberFormatUtils',
    summary: 'ordinal suffix (1st, 2nd), roman numerals, integer to words.',
    defaultPath: 'src/numberFormatUtils.ts',
    exports: ['ordinal', 'toRoman', 'fromRoman'],
    patterns: [
      { re: '\\bordinal\\b|\\b1st.*2nd|suffix.*number', weight: 0.55 },
      { re: '\\broman.*numeral|numeral.*roman', weight: 0.6 },
      { re: '\\btoRoman\\b|\\bfromRoman\\b', weight: 0.4 },
    ],
    impl: `export function ordinal(n: number): string {
  const abs = Math.abs(n)
  const mod10 = abs % 10, mod100 = abs % 100
  if (mod100 >= 11 && mod100 <= 13) return n + 'th'
  if (mod10 === 1) return n + 'st'
  if (mod10 === 2) return n + 'nd'
  if (mod10 === 3) return n + 'rd'
  return n + 'th'
}

const ROMAN_VALS: [number, string][] = [
  [1000,'M'],[900,'CM'],[500,'D'],[400,'CD'],[100,'C'],[90,'XC'],
  [50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I'],
]

export function toRoman(n: number): string {
  if (n <= 0 || n > 3999) throw new Error('out of range')
  let result = ''
  for (const [val, sym] of ROMAN_VALS) { while (n >= val) { result += sym; n -= val } }
  return result
}

export function fromRoman(s: string): number {
  const map: Record<string, number> = {I:1,V:5,X:10,L:50,C:100,D:500,M:1000}
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const cur = map[s[i]], next = map[s[i+1]]
    n += (next && cur < next) ? -cur : cur
  }
  return n
}`,
    tests: [
      { desc: 'ordinal 1', call: 'ordinal(1)', want: '"1st"' },
      { desc: 'ordinal 2', call: 'ordinal(2)', want: '"2nd"' },
      { desc: 'ordinal 3', call: 'ordinal(3)', want: '"3rd"' },
      { desc: 'ordinal 4', call: 'ordinal(4)', want: '"4th"' },
      { desc: 'ordinal 11', call: 'ordinal(11)', want: '"11th"' },
      { desc: 'ordinal 12', call: 'ordinal(12)', want: '"12th"' },
      { desc: 'ordinal 21', call: 'ordinal(21)', want: '"21st"' },
      { desc: 'toRoman 1', call: 'toRoman(1)', want: '"I"' },
      { desc: 'toRoman 4', call: 'toRoman(4)', want: '"IV"' },
      { desc: 'toRoman 9', call: 'toRoman(9)', want: '"IX"' },
      { desc: 'toRoman 2024', call: 'toRoman(2024)', want: '"MMXXIV"' },
      { desc: 'fromRoman XIV', call: 'fromRoman("XIV")', want: '14' },
      { desc: 'fromRoman MMXXIV', call: 'fromRoman("MMXXIV")', want: '2024' },
      { desc: 'roundtrip', call: 'fromRoman(toRoman(42))', want: '42' },
    ],
  },

  // ── More data structures ───────────────────────────────────────────────────

  {
    id: 'trie-simple',
    filename: 'trieSimple',
    summary: 'Prefix trie: insert words, search exact, startsWith prefix.',
    defaultPath: 'src/trieSimple.ts',
    exports: ['Trie'],
    patterns: [
      { re: '\\btrie\\b.*(?:insert|search|prefix)', weight: 0.7 },
      { re: '\\bprefix.*tree|prefix.*search', weight: 0.5 },
      { re: '\\bTrie\\b', weight: 0.4 },
      { re: '\\bautocomplete\\b', weight: 0.35 },
    ],
    impl: `interface TrieNode { children: Map<string, TrieNode>; end: boolean }

export class Trie {
  private root: TrieNode = { children: new Map(), end: false }

  insert(word: string): void {
    let node = this.root
    for (const ch of word) {
      if (!node.children.has(ch)) node.children.set(ch, { children: new Map(), end: false })
      node = node.children.get(ch)!
    }
    node.end = true
  }

  search(word: string): boolean {
    let node = this.root
    for (const ch of word) {
      if (!node.children.has(ch)) return false
      node = node.children.get(ch)!
    }
    return node.end
  }

  startsWith(prefix: string): boolean {
    let node = this.root
    for (const ch of prefix) {
      if (!node.children.has(ch)) return false
      node = node.children.get(ch)!
    }
    return true
  }

  words(prefix = ''): string[] {
    let node = this.root
    for (const ch of prefix) {
      if (!node.children.has(ch)) return []
      node = node.children.get(ch)!
    }
    const out: string[] = []
    const dfs = (n: TrieNode, s: string) => {
      if (n.end) out.push(s)
      for (const [ch, child] of n.children) dfs(child, s + ch)
    }
    dfs(node, prefix)
    return out
  }
}`,
    tests: [
      { desc: 'search inserted word', call: '(() => { const t = new Trie(); t.insert("hello"); return t.search("hello") })()', want: 'true' },
      { desc: 'search missing word', call: '(() => { const t = new Trie(); t.insert("hello"); return t.search("hell") })()', want: 'false' },
      { desc: 'startsWith true', call: '(() => { const t = new Trie(); t.insert("hello"); return t.startsWith("hel") })()', want: 'true' },
      { desc: 'startsWith false', call: '(() => { const t = new Trie(); t.insert("hello"); return t.startsWith("world") })()', want: 'false' },
      { desc: 'words with prefix', call: '(() => { const t = new Trie(); ["apple","app","application"].forEach(w=>t.insert(w)); return t.words("app").sort() })()', want: '["app","apple","application"]' },
      { desc: 'words all', call: '(() => { const t = new Trie(); ["hi","ho"].forEach(w=>t.insert(w)); return t.words().sort() })()', want: '["hi","ho"]' },
      { desc: 'empty trie', call: 'new Trie().search("x")', want: 'false' },
    ],
  },

  {
    id: 'lru-cache-simple',
    filename: 'lruCacheSimple',
    summary: 'Simple LRU cache with get, set, and max capacity eviction.',
    defaultPath: 'src/lruCacheSimple.ts',
    exports: ['LRUCache'],
    patterns: [
      { re: '\\blru\\b.*cache|cache.*\\blru\\b', weight: 0.7 },
      { re: '\\bLRUCache\\b', weight: 0.4 },
      { re: '\\bleast.*recently.*used', weight: 0.6 },
      { re: '\\bevict.*oldest|capacity.*cache', weight: 0.35 },
    ],
    impl: `export class LRUCache<K, V> {
  private map = new Map<K, V>()

  constructor(private capacity: number) {}

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined
    const val = this.map.get(key)!
    this.map.delete(key)
    this.map.set(key, val)
    return val
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key)
    else if (this.map.size >= this.capacity) {
      this.map.delete(this.map.keys().next().value!)
    }
    this.map.set(key, value)
  }

  has(key: K): boolean { return this.map.has(key) }
  size(): number { return this.map.size }
  clear(): void { this.map.clear() }
}`,
    tests: [
      { desc: 'get after set', call: '(() => { const c = new LRUCache<string,number>(3); c.set("a",1); return c.get("a") })()', want: '1' },
      { desc: 'get missing', call: 'new LRUCache(3).get("x")', want: 'undefined' },
      { desc: 'evicts LRU on overflow', call: '(() => { const c = new LRUCache<string,number>(2); c.set("a",1); c.set("b",2); c.set("c",3); return c.has("a") })()', want: 'false' },
      { desc: 'get refreshes recency', call: '(() => { const c = new LRUCache<string,number>(2); c.set("a",1); c.set("b",2); c.get("a"); c.set("c",3); return c.has("a") })()', want: 'true' },
      { desc: 'size', call: '(() => { const c = new LRUCache(5); c.set("x",1); c.set("y",2); return c.size() })()', want: '2' },
      { desc: 'clear', call: '(() => { const c = new LRUCache(5); c.set("x",1); c.clear(); return c.size() })()', want: '0' },
    ],
  },

  {
    id: 'event-emitter-simple',
    filename: 'eventEmitterSimple',
    summary: 'Simple typed event emitter: on, off, emit, once.',
    defaultPath: 'src/eventEmitterSimple.ts',
    exports: ['EventEmitter'],
    patterns: [
      { re: '\\bevent.*emitter|emitter.*event', weight: 0.65 },
      { re: '\\bEventEmitter\\b', weight: 0.45 },
      { re: '\\bon\\b.*\\bemit\\b|\\bemit\\b.*\\bon\\b', weight: 0.4 },
      { re: '\\bpublish.*subscribe|pub.*sub', weight: 0.35 },
    ],
    impl: `type Listener = (...args: unknown[]) => void

export class EventEmitter {
  private listeners = new Map<string, Set<Listener>>()

  on(event: string, fn: Listener): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(fn)
    return this
  }

  off(event: string, fn: Listener): this {
    this.listeners.get(event)?.delete(fn)
    return this
  }

  emit(event: string, ...args: unknown[]): boolean {
    const fns = this.listeners.get(event)
    if (!fns?.size) return false
    for (const fn of fns) fn(...args)
    return true
  }

  once(event: string, fn: Listener): this {
    const wrapper: Listener = (...args) => { this.off(event, wrapper); fn(...args) }
    return this.on(event, wrapper)
  }

  removeAllListeners(event?: string): this {
    if (event) this.listeners.delete(event)
    else this.listeners.clear()
    return this
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0
  }
}`,
    tests: [
      { desc: 'on and emit', call: '(() => { const e = new EventEmitter(); let x = 0; e.on("a", () => x++); e.emit("a"); return x })()', want: '1' },
      { desc: 'off removes listener', call: '(() => { const e = new EventEmitter(); let x = 0; const fn = () => x++; e.on("a", fn); e.off("a", fn); e.emit("a"); return x })()', want: '0' },
      { desc: 'once fires once', call: '(() => { const e = new EventEmitter(); let x = 0; e.once("a", () => x++); e.emit("a"); e.emit("a"); return x })()', want: '1' },
      { desc: 'emit returns true when listeners', call: '(() => { const e = new EventEmitter(); e.on("a", ()=>{}); return e.emit("a") })()', want: 'true' },
      { desc: 'emit returns false no listeners', call: 'new EventEmitter().emit("x")', want: 'false' },
      { desc: 'listenerCount', call: '(() => { const e = new EventEmitter(); e.on("a",()=>{}); e.on("a",()=>{}); return e.listenerCount("a") })()', want: '2' },
      { desc: 'passes args', call: '(() => { const e = new EventEmitter(); let got: unknown; e.on("a", (v) => got = v); e.emit("a", 42); return got })()', want: '42' },
    ],
  },

  // ── String extras II ──────────────────────────────────────────────────────

  {
    id: 'string-padding',
    filename: 'stringPadding',
    summary: 'padLeft, padRight, padBoth — pad a string to a target length.',
    defaultPath: 'src/stringPadding.ts',
    exports: ['padLeft', 'padRight', 'padBoth'],
    patterns: [
      { re: '\\bpadLeft\\b|\\bleft.*pad\\b|\\bpad.*left\\b', weight: 0.6 },
      { re: '\\bpadRight\\b|\\bright.*pad\\b', weight: 0.5 },
      { re: '\\bpadBoth\\b|\\bcenter.*pad|\\bpad.*center', weight: 0.45 },
      { re: '\\bpad.*string|string.*pad', weight: 0.35 },
    ],
    impl: `export function padLeft(str: string, len: number, char = ' '): string {
  if (str.length >= len) return str
  return char.repeat(Math.ceil((len - str.length) / char.length)).slice(0, len - str.length) + str
}

export function padRight(str: string, len: number, char = ' '): string {
  if (str.length >= len) return str
  return str + char.repeat(Math.ceil((len - str.length) / char.length)).slice(0, len - str.length)
}

export function padBoth(str: string, len: number, char = ' '): string {
  if (str.length >= len) return str
  const total = len - str.length
  const left = Math.floor(total / 2)
  return padLeft(padRight(str, str.length + (total - left), char), len, char)
}`,
    tests: [
      { desc: 'padLeft basic', call: 'padLeft("5", 3, "0")', want: '"005"' },
      { desc: 'padLeft spaces', call: 'padLeft("hi", 5)', want: '"   hi"' },
      { desc: 'padLeft no change', call: 'padLeft("hello", 3)', want: '"hello"' },
      { desc: 'padRight basic', call: 'padRight("hi", 5, ".")', want: '"hi..."' },
      { desc: 'padRight spaces', call: 'padRight("hi", 4)', want: '"hi  "' },
      { desc: 'padBoth even', call: 'padBoth("hi", 6)', want: '"  hi  "' },
      { desc: 'padBoth odd', call: 'padBoth("hi", 5)', want: '" hi  "' },
      { desc: 'padBoth no change', call: 'padBoth("hello", 3)', want: '"hello"' },
    ],
  },

  {
    id: 'string-search',
    filename: 'stringSearch',
    summary: 'Fuzzy string match score and Levenshtein edit distance.',
    defaultPath: 'src/stringSearch.ts',
    exports: ['editDistance', 'fuzzyScore'],
    patterns: [
      { re: '\\bedit.*distance|levenshtein\\b', weight: 0.7 },
      { re: '\\bfuzzy.*match|fuzzy.*search|fuzzy.*score', weight: 0.6 },
      { re: '\\bfuzzyScore\\b|\\beditDistance\\b', weight: 0.4 },
    ],
    impl: `export function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0))
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1])
  return dp[m][n]
}

export function fuzzyScore(pattern: string, text: string): number {
  if (!pattern) return 1
  if (!text) return 0
  const p = pattern.toLowerCase(), t = text.toLowerCase()
  let score = 0, pi = 0, consecutive = 0
  for (let ti = 0; ti < t.length && pi < p.length; ti++) {
    if (t[ti] === p[pi]) {
      score += 1 + consecutive
      consecutive++
      pi++
    } else consecutive = 0
  }
  return pi === p.length ? score / (text.length + pattern.length) : 0
}`,
    tests: [
      { desc: 'editDistance same', call: 'editDistance("hello", "hello")', want: '0' },
      { desc: 'editDistance kitten sitting', call: 'editDistance("kitten", "sitting")', want: '3' },
      { desc: 'editDistance one deletion', call: 'editDistance("abc", "ac")', want: '1' },
      { desc: 'editDistance one insertion', call: 'editDistance("ac", "abc")', want: '1' },
      { desc: 'editDistance one substitution', call: 'editDistance("cat", "bat")', want: '1' },
      { desc: 'editDistance empty', call: 'editDistance("", "abc")', want: '3' },
      { desc: 'fuzzyScore exact', call: 'fuzzyScore("hello", "hello") > 0', want: 'true' },
      { desc: 'fuzzyScore no match', call: 'fuzzyScore("xyz", "hello")', want: '0' },
      { desc: 'fuzzyScore partial', call: 'fuzzyScore("hlo", "hello") > 0', want: 'true' },
      { desc: 'fuzzyScore empty pattern', call: 'fuzzyScore("", "hello")', want: '1' },
    ],
  },

  {
    id: 'measure-time',
    filename: 'measureTime',
    summary: 'Measure sync and async execution time in milliseconds.',
    defaultPath: 'src/measureTime.ts',
    exports: ['measureTime', 'measureTimeAsync'],
    patterns: [
      { re: '\\bmeasure.*time|time.*execut', weight: 0.6 },
      { re: '\\bmeasureTime\\b|\\bbenchmark\\b.*function', weight: 0.5 },
      { re: '\\bexecution.*time|elapsed.*time', weight: 0.4 },
    ],
    impl: `export function measureTime<T>(fn: () => T): { result: T; ms: number } {
  const start = performance.now()
  const result = fn()
  return { result, ms: performance.now() - start }
}

export async function measureTimeAsync<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = performance.now()
  const result = await fn()
  return { result, ms: performance.now() - start }
}`,
    tests: [
      { desc: 'returns result', call: 'measureTime(() => 42).result', want: '42' },
      { desc: 'ms is number', call: 'typeof measureTime(() => {}).ms === "number"', want: 'true' },
      { desc: 'ms >= 0', call: 'measureTime(() => {}).ms >= 0', want: 'true' },
      { desc: 'async returns result', call: 'measureTimeAsync(async () => 99).then(r => r.result)', want: '99' },
      { desc: 'async ms is number', call: 'measureTimeAsync(async () => {}).then(r => typeof r.ms === "number")', want: 'true' },
    ],
  },

  {
    id: 'color-utils',
    filename: 'colorUtils',
    summary: 'Convert between hex, RGB, and HSL color formats.',
    defaultPath: 'src/colorUtils.ts',
    exports: ['hexToRgb', 'rgbToHex', 'rgbToHsl', 'hslToRgb'],
    patterns: [
      { re: '\\bhex.*rgb|rgb.*hex', weight: 0.65 },
      { re: '\\bhsl.*rgb|rgb.*hsl', weight: 0.6 },
      { re: '\\bcolor.*convert|convert.*color', weight: 0.5 },
      { re: '\\bhexToRgb\\b|\\brgbToHex\\b', weight: 0.4 },
    ],
    impl: `export interface RGB { r: number; g: number; b: number }
export interface HSL { h: number; s: number; l: number }

export function hexToRgb(hex: string): RGB | null {
  const m = hex.replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (!m) return null
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) }
}

export function rgbToHex({ r, g, b }: RGB): string {
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')
}

export function rgbToHsl({ r, g, b }: RGB): HSL {
  const rn = r/255, gn = g/255, bn = b/255
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l: Math.round(l * 100) }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0)
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  return { h: Math.round(h * 60), s: Math.round(s * 100), l: Math.round(l * 100) }
}

export function hslToRgb({ h, s, l }: HSL): RGB {
  const sn = s / 100, ln = l / 100
  const c = (1 - Math.abs(2 * ln - 1)) * sn
  const x = c * (1 - Math.abs((h / 60) % 2 - 1))
  const m = ln - c / 2
  let [rn, gn, bn] = [0, 0, 0]
  if (h < 60) [rn, gn, bn] = [c, x, 0]
  else if (h < 120) [rn, gn, bn] = [x, c, 0]
  else if (h < 180) [rn, gn, bn] = [0, c, x]
  else if (h < 240) [rn, gn, bn] = [0, x, c]
  else if (h < 300) [rn, gn, bn] = [x, 0, c]
  else [rn, gn, bn] = [c, 0, x]
  return { r: Math.round((rn+m)*255), g: Math.round((gn+m)*255), b: Math.round((bn+m)*255) }
}`,
    tests: [
      { desc: 'hexToRgb white', call: 'JSON.stringify(hexToRgb("#ffffff"))', want: '"{\\"r\\":255,\\"g\\":255,\\"b\\":255}"' },
      { desc: 'hexToRgb black', call: 'JSON.stringify(hexToRgb("#000000"))', want: '"{\\"r\\":0,\\"g\\":0,\\"b\\":0}"' },
      { desc: 'hexToRgb red', call: 'JSON.stringify(hexToRgb("#ff0000"))', want: '"{\\"r\\":255,\\"g\\":0,\\"b\\":0}"' },
      { desc: 'hexToRgb invalid', call: 'hexToRgb("invalid")', want: 'null' },
      { desc: 'rgbToHex black', call: 'rgbToHex({r:0,g:0,b:0})', want: '"#000000"' },
      { desc: 'rgbToHex white', call: 'rgbToHex({r:255,g:255,b:255})', want: '"#ffffff"' },
      { desc: 'roundtrip hex', call: 'rgbToHex(hexToRgb("#3a7bd5")!)', want: '"#3a7bd5"' },
      { desc: 'rgbToHsl black', call: 'JSON.stringify(rgbToHsl({r:0,g:0,b:0}))', want: '"{\\"h\\":0,\\"s\\":0,\\"l\\":0}"' },
    ],
  },

  // ── Date utilities ────────────────────────────────────────────────────────

  {
    id: 'date-format',
    filename: 'dateFormat',
    summary: 'Format a Date with tokens YYYY MM DD HH mm ss.',
    defaultPath: 'src/dateFormat.ts',
    exports: ['formatDate', 'parseDate'],
    patterns: [
      { re: '\\bformat.*date|date.*format', weight: 0.65 },
      { re: '\\bformatDate\\b|\\bparseDate\\b', weight: 0.4 },
      { re: '\\bdate.*string|YYYY.*MM.*DD', weight: 0.5 },
    ],
    impl: `export function formatDate(date: Date, pattern: string): string {
  const p = (n: number, len = 2) => String(n).padStart(len, '0')
  return pattern
    .replace('YYYY', p(date.getUTCFullYear(), 4))
    .replace('MM', p(date.getUTCMonth() + 1))
    .replace('DD', p(date.getUTCDate()))
    .replace('HH', p(date.getUTCHours()))
    .replace('mm', p(date.getUTCMinutes()))
    .replace('ss', p(date.getUTCSeconds()))
}

export function parseDate(str: string): Date {
  return new Date(str)
}`,
    tests: [
      { desc: 'format YYYY-MM-DD', call: 'formatDate(new Date("2024-01-15T00:00:00Z"), "YYYY-MM-DD")', want: '"2024-01-15"' },
      { desc: 'format with time', call: 'formatDate(new Date("2024-06-28T14:30:45Z"), "YYYY-MM-DD HH:mm:ss")', want: '"2024-06-28 14:30:45"' },
      { desc: 'format DD/MM/YYYY', call: 'formatDate(new Date("2024-03-07T00:00:00Z"), "DD/MM/YYYY")', want: '"07/03/2024"' },
      { desc: 'format single digit padded', call: 'formatDate(new Date("2024-01-05T00:00:00Z"), "MM/DD/YYYY")', want: '"01/05/2024"' },
      { desc: 'parseDate valid', call: 'parseDate("2024-01-15") instanceof Date', want: 'true' },
      { desc: 'parseDate timestamp', call: 'formatDate(parseDate("2024-06-01T00:00:00Z"), "YYYY-MM-DD")', want: '"2024-06-01"' },
    ],
  },

  {
    id: 'date-utils',
    filename: 'dateUtils',
    summary: 'addDays, diffDays, isLeapYear, daysInMonth, startOfDay, endOfDay.',
    defaultPath: 'src/dateUtils.ts',
    exports: ['addDays', 'diffDays', 'isLeapYear', 'daysInMonth', 'startOfDay', 'endOfDay'],
    patterns: [
      { re: '\\baddDays\\b|\\badd.*days\\b', weight: 0.55 },
      { re: '\\bdiffDays\\b|\\bdiff.*days\\b|\\bdays.*between', weight: 0.55 },
      { re: '\\bisLeapYear\\b|\\bleap.*year', weight: 0.6 },
      { re: '\\bdaysInMonth\\b|\\bdays.*month', weight: 0.55 },
      { re: '\\baddDays.*diffDays|date.*arithmetic', weight: 0.6 },
    ],
    impl: `export function addDays(date: Date, days: number): Date {
  const d = new Date(date)
  d.setUTCDate(d.getUTCDate() + days)
  return d
}

export function diffDays(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86400000)
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

export function startOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

export function endOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999))
}`,
    tests: [
      { desc: 'addDays basic', call: 'addDays(new Date("2024-01-01T00:00:00Z"), 5).toISOString().slice(0,10)', want: '"2024-01-06"' },
      { desc: 'addDays month boundary', call: 'addDays(new Date("2024-01-30T00:00:00Z"), 3).toISOString().slice(0,10)', want: '"2024-02-02"' },
      { desc: 'addDays negative', call: 'addDays(new Date("2024-01-10T00:00:00Z"), -3).toISOString().slice(0,10)', want: '"2024-01-07"' },
      { desc: 'diffDays positive', call: 'diffDays(new Date("2024-01-01T00:00:00Z"), new Date("2024-01-06T00:00:00Z"))', want: '5' },
      { desc: 'diffDays negative', call: 'diffDays(new Date("2024-01-06T00:00:00Z"), new Date("2024-01-01T00:00:00Z"))', want: '-5' },
      { desc: 'diffDays same', call: 'diffDays(new Date("2024-01-01T00:00:00Z"), new Date("2024-01-01T00:00:00Z"))', want: '0' },
      { desc: 'isLeapYear 2024', call: 'isLeapYear(2024)', want: 'true' },
      { desc: 'isLeapYear 2023', call: 'isLeapYear(2023)', want: 'false' },
      { desc: 'isLeapYear 1900', call: 'isLeapYear(1900)', want: 'false' },
      { desc: 'isLeapYear 2000', call: 'isLeapYear(2000)', want: 'true' },
      { desc: 'daysInMonth Jan', call: 'daysInMonth(2024, 1)', want: '31' },
      { desc: 'daysInMonth Feb leap', call: 'daysInMonth(2024, 2)', want: '29' },
      { desc: 'daysInMonth Feb non-leap', call: 'daysInMonth(2023, 2)', want: '28' },
      { desc: 'startOfDay midnight', call: 'startOfDay(new Date("2024-01-15T14:30:00Z")).toISOString()', want: '"2024-01-15T00:00:00.000Z"' },
    ],
  },

  // ── Object path utilities ─────────────────────────────────────────────────

  {
    id: 'object-path',
    filename: 'objectPath',
    summary: 'get, set, has, unset by dot-notation path on nested objects.',
    defaultPath: 'src/objectPath.ts',
    exports: ['getPath', 'setPath', 'hasPath', 'unsetPath'],
    patterns: [
      { re: '\\bget.*nested|nested.*path|dot.*notation.*object', weight: 0.55 },
      { re: '\\bgetPath\\b|\\bsetPath\\b|\\bhasPath\\b', weight: 0.45 },
      { re: '\\blodash.*get|_\\.get|object.*path.*access', weight: 0.5 },
      { re: '\\bpath.*object.*access|dot.*path.*value', weight: 0.45 },
    ],
    impl: `function parsePath(path: string): string[] {
  return path.split('.').flatMap(p => p.replace(/\\[(\\d+)\\]/g, '.$1').split('.')).filter(Boolean)
}

export function getPath(obj: unknown, path: string, defaultVal?: unknown): unknown {
  const keys = parsePath(path)
  let cur: unknown = obj
  for (const k of keys) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return defaultVal
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur === undefined ? defaultVal : cur
}

export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = parsePath(path)
  let cur = obj as Record<string, unknown>
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]
    if (cur[k] === null || cur[k] === undefined || typeof cur[k] !== 'object') {
      cur[k] = isNaN(Number(keys[i + 1])) ? {} : []
    }
    cur = cur[k] as Record<string, unknown>
  }
  cur[keys[keys.length - 1]] = value
}

export function hasPath(obj: unknown, path: string): boolean {
  const keys = parsePath(path)
  let cur: unknown = obj
  for (const k of keys) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return false
    if (!Object.prototype.hasOwnProperty.call(cur, k)) return false
    cur = (cur as Record<string, unknown>)[k]
  }
  return true
}

export function unsetPath(obj: Record<string, unknown>, path: string): void {
  const keys = parsePath(path)
  let cur = obj as Record<string, unknown>
  for (let i = 0; i < keys.length - 1; i++) {
    cur = (cur[keys[i]] ?? {}) as Record<string, unknown>
  }
  delete cur[keys[keys.length - 1]]
}`,
    tests: [
      { desc: 'getPath simple', call: 'getPath({a:{b:1}}, "a.b")', want: '1' },
      { desc: 'getPath deep', call: 'getPath({a:{b:{c:42}}}, "a.b.c")', want: '42' },
      { desc: 'getPath missing default', call: 'getPath({}, "a.b", "default")', want: '"default"' },
      { desc: 'getPath missing undefined', call: 'getPath({a:1}, "b")', want: 'undefined' },
      { desc: 'getPath array index', call: 'getPath({a:[1,2,3]}, "a[1]")', want: '2' },
      { desc: 'setPath simple', call: '(() => { const o = {}; setPath(o,"a.b",42); return (o as any).a.b })()', want: '42' },
      { desc: 'setPath creates nested', call: '(() => { const o: any = {}; setPath(o,"x.y.z","v"); return o.x.y.z })()', want: '"v"' },
      { desc: 'hasPath true', call: 'hasPath({a:{b:1}}, "a.b")', want: 'true' },
      { desc: 'hasPath false', call: 'hasPath({a:1}, "a.b")', want: 'false' },
      { desc: 'hasPath null value', call: 'hasPath({a:null}, "a")', want: 'true' },
      { desc: 'unsetPath removes', call: '(() => { const o: any = {a:{b:1,c:2}}; unsetPath(o,"a.b"); return o.a })()', want: '{"c":2}' },
    ],
  },

  {
    id: 'object-diff',
    filename: 'objectDiff',
    summary: 'Compute added, removed, and changed keys between two plain objects.',
    defaultPath: 'src/objectDiff.ts',
    exports: ['objectDiff'],
    patterns: [
      { re: '\\bobject.*diff|diff.*object', weight: 0.65 },
      { re: '\\bobjectDiff\\b', weight: 0.4 },
      { re: '\\bcompare.*object|object.*compare.*change', weight: 0.4 },
    ],
    impl: `export interface DiffResult {
  added: Record<string, unknown>
  removed: Record<string, unknown>
  changed: Record<string, { from: unknown; to: unknown }>
}

export function objectDiff(from: Record<string, unknown>, to: Record<string, unknown>): DiffResult {
  const added: Record<string, unknown> = {}
  const removed: Record<string, unknown> = {}
  const changed: Record<string, { from: unknown; to: unknown }> = {}
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  for (const k of Object.keys(to)) {
    if (!(k in from)) added[k] = to[k]
    else if (!eq(from[k], to[k])) changed[k] = { from: from[k], to: to[k] }
  }
  for (const k of Object.keys(from)) { if (!(k in to)) removed[k] = from[k] }
  return { added, removed, changed }
}`,
    tests: [
      { desc: 'added key', call: 'JSON.stringify(objectDiff({a:1},{a:1,b:2}).added)', want: '"{\\"b\\":2}"' },
      { desc: 'removed key', call: 'JSON.stringify(objectDiff({a:1,b:2},{a:1}).removed)', want: '"{\\"b\\":2}"' },
      { desc: 'changed key', call: 'objectDiff({a:1},{a:2}).changed["a"]', want: '{"from":1,"to":2}' },
      { desc: 'no diff', call: 'JSON.stringify(objectDiff({a:1},{a:1}))', want: '"{\\"added\\":{},\\"removed\\":{},\\"changed\\":{}}"' },
      { desc: 'nested change detected', call: 'Object.keys(objectDiff({a:{b:1}},{a:{b:2}}).changed).length', want: '1' },
    ],
  },

  // ── More validators (Tier-1C) ─────────────────────────────────────────────

  {
    id: 'string-validators',
    filename: 'stringValidators',
    summary: 'isAlpha, isAlphanumeric, isNumeric, isHexColor, isIPv4, isPort.',
    defaultPath: 'src/stringValidators.ts',
    exports: ['isAlpha', 'isAlphanumeric', 'isNumeric', 'isHexColor', 'isIPv4', 'isPort'],
    patterns: [
      { re: '\\bisAlpha\\b|\\bisAlphanumeric\\b', weight: 0.6 },
      { re: '\\bisHexColor\\b|\\bhex.*color.*valid', weight: 0.55 },
      { re: '\\bisIPv4\\b|\\bip.*address.*valid', weight: 0.55 },
      { re: '\\bisPort\\b|\\bport.*number.*valid', weight: 0.5 },
      { re: '\\bstring.*validator|validate.*string.*type', weight: 0.45 },
    ],
    impl: `export function isAlpha(s: string): boolean { return /^[a-zA-Z]+$/.test(s) }
export function isAlphanumeric(s: string): boolean { return /^[a-zA-Z0-9]+$/.test(s) }
export function isNumeric(s: string): boolean { return s.length > 0 && !isNaN(Number(s)) && !isNaN(parseFloat(s)) }
export function isHexColor(s: string): boolean { return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s) }
export function isIPv4(s: string): boolean {
  const parts = s.split('.')
  return parts.length === 4 && parts.every(p => /^\\d+$/.test(p) && +p >= 0 && +p <= 255)
}
export function isPort(n: number): boolean { return Number.isInteger(n) && n >= 0 && n <= 65535 }`,
    tests: [
      { desc: 'isAlpha true', call: 'isAlpha("hello")', want: 'true' },
      { desc: 'isAlpha false digit', call: 'isAlpha("hello1")', want: 'false' },
      { desc: 'isAlpha empty', call: 'isAlpha("")', want: 'false' },
      { desc: 'isAlphanumeric true', call: 'isAlphanumeric("hello123")', want: 'true' },
      { desc: 'isAlphanumeric false space', call: 'isAlphanumeric("hello world")', want: 'false' },
      { desc: 'isNumeric int', call: 'isNumeric("42")', want: 'true' },
      { desc: 'isNumeric float', call: 'isNumeric("3.14")', want: 'true' },
      { desc: 'isNumeric false', call: 'isNumeric("abc")', want: 'false' },
      { desc: 'isNumeric empty', call: 'isNumeric("")', want: 'false' },
      { desc: 'isHexColor 6 digit', call: 'isHexColor("#ff0000")', want: 'true' },
      { desc: 'isHexColor 3 digit', call: 'isHexColor("#f00")', want: 'true' },
      { desc: 'isHexColor invalid', call: 'isHexColor("ff0000")', want: 'false' },
      { desc: 'isIPv4 valid', call: 'isIPv4("192.168.1.1")', want: 'true' },
      { desc: 'isIPv4 invalid octet', call: 'isIPv4("192.168.1.256")', want: 'false' },
      { desc: 'isIPv4 wrong parts', call: 'isIPv4("1.2.3")', want: 'false' },
      { desc: 'isPort valid', call: 'isPort(8080)', want: 'true' },
      { desc: 'isPort zero', call: 'isPort(0)', want: 'true' },
      { desc: 'isPort overflow', call: 'isPort(65536)', want: 'false' },
    ],
  },

  // ── Promise utilities ─────────────────────────────────────────────────────

  {
    id: 'promise-utils',
    filename: 'promiseUtils',
    summary: 'withTimeout, pMap (parallel map), pFilter, pReduce.',
    defaultPath: 'src/promiseUtils.ts',
    exports: ['withTimeout', 'pMap', 'pFilter'],
    patterns: [
      { re: '\\bwithTimeout\\b|\\bpromise.*timeout|timeout.*promise', weight: 0.6 },
      { re: '\\bpMap\\b|\\bparallel.*map|map.*async.*concurrent', weight: 0.55 },
      { re: '\\bpFilter\\b|\\bpromise.*util', weight: 0.45 },
    ],
    impl: `export function withTimeout<T>(promise: Promise<T>, ms: number, message = 'Timeout'): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ])
}

export async function pMap<T, U>(
  arr: T[],
  fn: (item: T, index: number) => Promise<U>,
  concurrency = Infinity,
): Promise<U[]> {
  const results: U[] = new Array(arr.length)
  let idx = 0
  const worker = async () => {
    while (idx < arr.length) {
      const i = idx++
      results[i] = await fn(arr[i], i)
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, arr.length || 1) }, worker)
  await Promise.all(workers)
  return results
}

export async function pFilter<T>(
  arr: T[],
  fn: (item: T, index: number) => Promise<boolean>,
): Promise<T[]> {
  const flags = await pMap(arr, fn)
  return arr.filter((_, i) => flags[i])
}`,
    tests: [
      { desc: 'withTimeout resolves', call: 'withTimeout(Promise.resolve(42), 1000)', want: '42' },
      { desc: 'withTimeout rejects on timeout', call: 'withTimeout(new Promise(()=>{}), 1, "T").catch(e=>e.message)', want: '"T"' },
      { desc: 'pMap basic', call: 'pMap([1,2,3], async x => x*2)', want: '[2,4,6]' },
      { desc: 'pMap preserves order', call: 'pMap([3,1,2], async x => x)', want: '[3,1,2]' },
      { desc: 'pMap empty', call: 'pMap([], async x => x)', want: '[]' },
      { desc: 'pMap concurrency 1', call: 'pMap([1,2,3], async x => x+10, 1)', want: '[11,12,13]' },
      { desc: 'pFilter basic', call: 'pFilter([1,2,3,4,5], async x => x%2===0)', want: '[2,4]' },
      { desc: 'pFilter all false', call: 'pFilter([1,3,5], async x => x%2===0)', want: '[]' },
    ],
  },

  // ── Path utilities ────────────────────────────────────────────────────────

  {
    id: 'path-utils',
    filename: 'pathUtils',
    summary: 'joinPath, getExtension, getFileName, getDirName, stripExtension, normalizePath.',
    defaultPath: 'src/pathUtils.ts',
    exports: ['joinPath', 'getExtension', 'getFileName', 'getDirName', 'stripExtension', 'normalizePath'],
    patterns: [
      { re: '\\bjoinPath\\b|\\bjoin.*path\\b', weight: 0.55 },
      { re: '\\bgetExtension\\b|\\bfile.*extension', weight: 0.5 },
      { re: '\\bgetFileName\\b|\\bfile.*name', weight: 0.45 },
      { re: '\\bpath.*util|normalizePath\\b', weight: 0.45 },
    ],
    impl: `export function joinPath(...parts: string[]): string {
  return parts.join('/').replace(/\\/+/g, '/').replace(/\\/$/, '') || '/'
}

export function getExtension(filePath: string): string {
  const base = filePath.split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot)
}

export function getFileName(filePath: string): string {
  return filePath.split('/').pop() ?? ''
}

export function getDirName(filePath: string): string {
  const parts = filePath.split('/')
  parts.pop()
  return parts.join('/') || '/'
}

export function stripExtension(filePath: string): string {
  const ext = getExtension(filePath)
  return ext ? filePath.slice(0, -ext.length) : filePath
}

export function normalizePath(filePath: string): string {
  const parts = filePath.split('/')
  const out: string[] = []
  for (const p of parts) {
    if (p === '..') out.pop()
    else if (p !== '.') out.push(p)
  }
  return out.join('/') || '/'
}`,
    tests: [
      { desc: 'joinPath basic', call: 'joinPath("src", "utils", "foo.ts")', want: '"src/utils/foo.ts"' },
      { desc: 'joinPath trailing slash', call: 'joinPath("src/", "/utils")', want: '"src/utils"' },
      { desc: 'getExtension .ts', call: 'getExtension("foo.ts")', want: '".ts"' },
      { desc: 'getExtension .tar.gz', call: 'getExtension("file.tar.gz")', want: '".gz"' },
      { desc: 'getExtension no ext', call: 'getExtension("Makefile")', want: '""' },
      { desc: 'getFileName basic', call: 'getFileName("/src/utils/foo.ts")', want: '"foo.ts"' },
      { desc: 'getDirName basic', call: 'getDirName("/src/utils/foo.ts")', want: '"/src/utils"' },
      { desc: 'getDirName no dir', call: 'getDirName("foo.ts")', want: '"/"' },
      { desc: 'stripExtension', call: 'stripExtension("foo.ts")', want: '"foo"' },
      { desc: 'normalizePath dotdot', call: 'normalizePath("src/../lib/foo.ts")', want: '"lib/foo.ts"' },
      { desc: 'normalizePath dot', call: 'normalizePath("./src/./foo")', want: '"src/foo"' },
    ],
  },

  // ── Crypto hashing (Node.js) ──────────────────────────────────────────────

  {
    id: 'crypto-hash',
    filename: 'cryptoHash',
    summary: 'MD5, SHA-1, SHA-256 hashes of a string via Node crypto.',
    defaultPath: 'src/cryptoHash.ts',
    exports: ['md5', 'sha1', 'sha256'],
    patterns: [
      { re: '\\bsha256\\b|\\bsha-256\\b', weight: 0.65 },
      { re: '\\bmd5\\b.*hash|hash.*\\bmd5\\b', weight: 0.55 },
      { re: '\\bcrypto.*hash|hash.*string', weight: 0.5 },
      { re: '\\bmd5\\b|\\bsha1\\b|\\bsha256\\b', weight: 0.4 },
    ],
    impl: `import { createHash } from 'crypto'

export function md5(str: string): string { return createHash('md5').update(str).digest('hex') }
export function sha1(str: string): string { return createHash('sha1').update(str).digest('hex') }
export function sha256(str: string): string { return createHash('sha256').update(str).digest('hex') }`,
    tests: [
      { desc: 'md5 hello', call: 'md5("hello")', want: '"5d41402abc4b2a76b9719d911017c592"' },
      { desc: 'md5 empty', call: 'md5("")', want: '"d41d8cd98f00b204e9800998ecf8427e"' },
      { desc: 'sha256 hello', call: 'sha256("hello")', want: '"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"' },
      { desc: 'sha256 empty', call: 'sha256("")', want: '"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"' },
      { desc: 'sha1 hello', call: 'sha1("hello")', want: '"aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d"' },
      { desc: 'deterministic', call: 'sha256("test") === sha256("test")', want: 'true' },
      { desc: 'different inputs differ', call: 'sha256("a") !== sha256("b")', want: 'true' },
    ],
  },

  // ── More string utilities ─────────────────────────────────────────────────

  {
    id: 'string-extras',
    filename: 'stringExtras',
    summary: 'pluralize, stripHtml, initials, words, nl2br, repeat, padLines.',
    defaultPath: 'src/stringExtras.ts',
    exports: ['pluralize', 'stripHtml', 'initials', 'words', 'nl2br'],
    patterns: [
      { re: '\\bpluralize\\b', weight: 0.65 },
      { re: '\\bstrip.*html|remove.*html.*tag', weight: 0.6 },
      { re: '\\binitials\\b', weight: 0.6 },
      { re: '\\bpluralize.*stripHtml|html.*plural', weight: 0.5 },
      { re: '\\bnl2br\\b|\\bnewline.*br|line.*break.*html', weight: 0.55 },
    ],
    impl: `export function pluralize(word: string, count: number, plural?: string): string {
  if (count === 1) return word
  return plural ?? (word.endsWith('s') || word.endsWith('x') || word.endsWith('z') ||
    word.endsWith('ch') || word.endsWith('sh') ? word + 'es' : word + 's')
}

export function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim()
}

export function initials(name: string): string {
  return name.trim().split(/\\s+/).map(w => w[0]?.toUpperCase() ?? '').join('')
}

export function words(str: string): string[] {
  return str.trim().split(/[^a-zA-Z0-9']+/).filter(Boolean)
}

export function nl2br(str: string): string {
  return str.replace(/\\r?\\n/g, '<br>')
}`,
    tests: [
      { desc: 'pluralize 1', call: 'pluralize("cat", 1)', want: '"cat"' },
      { desc: 'pluralize 2', call: 'pluralize("cat", 2)', want: '"cats"' },
      { desc: 'pluralize custom', call: 'pluralize("child", 2, "children")', want: '"children"' },
      { desc: 'pluralize -es', call: 'pluralize("box", 2)', want: '"boxes"' },
      { desc: 'stripHtml basic', call: 'stripHtml("<b>hello</b>")', want: '"hello"' },
      { desc: 'stripHtml entities', call: 'stripHtml("<p>a &amp; b</p>")', want: '"a & b"' },
      { desc: 'stripHtml nested', call: 'stripHtml("<div><p>text</p></div>")', want: '"text"' },
      { desc: 'initials two words', call: 'initials("John Doe")', want: '"JD"' },
      { desc: 'initials three words', call: 'initials("Mary Jane Watson")', want: '"MJW"' },
      { desc: 'words basic', call: 'words("hello world")', want: '["hello","world"]' },
      { desc: 'words with punct', call: 'words("hello, world!")', want: '["hello","world"]' },
      { desc: 'nl2br basic', call: 'nl2br("line1\\nline2")', want: '"line1<br>line2"' },
      { desc: 'nl2br crlf', call: 'nl2br("a\\r\\nb")', want: '"a<br>b"' },
    ],
  },

  // ── More collections ──────────────────────────────────────────────────────

  {
    id: 'sliding-window',
    filename: 'slidingWindow',
    summary: 'Sliding window, windowed iteration, rolling average over an array.',
    defaultPath: 'src/slidingWindow.ts',
    exports: ['windows', 'rollingAverage', 'maxWindow'],
    patterns: [
      { re: '\\bsliding.*window|window.*slide', weight: 0.7 },
      { re: '\\brolling.*average|rolling.*mean', weight: 0.6 },
      { re: '\\bwindows\\b.*array|\\bwindowed\\b', weight: 0.5 },
      { re: '\\bwindow.*size.*array', weight: 0.45 },
    ],
    impl: `export function windows<T>(arr: T[], size: number): T[][] {
  if (size <= 0 || size > arr.length) return []
  return arr.slice(0, arr.length - size + 1).map((_, i) => arr.slice(i, i + size))
}

export function rollingAverage(arr: number[], size: number): number[] {
  return windows(arr, size).map(w => w.reduce((a, b) => a + b, 0) / size)
}

export function maxWindow(arr: number[], size: number): number[] {
  return windows(arr, size).map(w => Math.max(...w))
}`,
    tests: [
      { desc: 'windows basic', call: 'windows([1,2,3,4,5], 3)', want: '[[1,2,3],[2,3,4],[3,4,5]]' },
      { desc: 'windows size 1', call: 'windows([1,2,3], 1)', want: '[[1],[2],[3]]' },
      { desc: 'windows full size', call: 'windows([1,2,3], 3)', want: '[[1,2,3]]' },
      { desc: 'windows empty on oversized', call: 'windows([1,2], 5)', want: '[]' },
      { desc: 'rollingAverage', call: 'rollingAverage([1,2,3,4,5], 3)', want: '[2,3,4]' },
      { desc: 'rollingAverage size 1', call: 'rollingAverage([1,2,3], 1)', want: '[1,2,3]' },
      { desc: 'maxWindow', call: 'maxWindow([3,1,4,1,5,9,2,6], 3)', want: '[4,4,5,9,9,9]' },
    ],
  },

  {
    id: 'combinations',
    filename: 'combinations',
    summary: 'All k-combinations and permutations of an array.',
    defaultPath: 'src/combinations.ts',
    exports: ['combinations', 'permutations', 'powerSet'],
    patterns: [
      { re: '\\bcombination\\b', weight: 0.65 },
      { re: '\\bpermutation\\b', weight: 0.6 },
      { re: '\\bpowerSet\\b|\\bpower.*set', weight: 0.55 },
      { re: '\\bnChooseK\\b|\\bcombination.*array', weight: 0.5 },
    ],
    impl: `export function combinations<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]]
  if (k > arr.length) return []
  const [first, ...rest] = arr
  return [
    ...combinations(rest, k - 1).map(c => [first, ...c]),
    ...combinations(rest, k),
  ]
}

export function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr]
  return arr.flatMap((item, i) =>
    permutations([...arr.slice(0, i), ...arr.slice(i + 1)]).map(p => [item, ...p])
  )
}

export function powerSet<T>(arr: T[]): T[][] {
  return arr.reduce<T[][]>((acc, item) => [...acc, ...acc.map(s => [...s, item])], [[]])
}`,
    tests: [
      { desc: 'combinations 2 from 3', call: 'combinations([1,2,3], 2)', want: '[[1,2],[1,3],[2,3]]' },
      { desc: 'combinations 0', call: 'combinations([1,2,3], 0)', want: '[[]]' },
      { desc: 'combinations k=n', call: 'combinations([1,2], 2)', want: '[[1,2]]' },
      { desc: 'combinations k>n', call: 'combinations([1,2], 3)', want: '[]' },
      { desc: 'permutations 3', call: 'permutations([1,2,3]).length', want: '6' },
      { desc: 'permutations 1', call: 'permutations([1])', want: '[[1]]' },
      { desc: 'powerSet 3', call: 'powerSet([1,2,3]).length', want: '8' },
      { desc: 'powerSet includes empty', call: 'powerSet([1,2]).some(s=>s.length===0)', want: 'true' },
    ],
  },

  // ── More data structures ──────────────────────────────────────────────────

  {
    id: 'min-heap',
    filename: 'minHeap',
    summary: 'Min-heap with insert, extractMin, peek, and heapify.',
    defaultPath: 'src/minHeap.ts',
    exports: ['MinHeap'],
    patterns: [
      { re: '\\bmin[- ]?heap\\b', weight: 0.75 },
      { re: '\\bMinHeap\\b', weight: 0.4 },
      { re: '\\bpriority.*queue.*min|min.*priority.*queue', weight: 0.5 },
      { re: '\\bheap.*extract.*min|extractMin', weight: 0.5 },
    ],
    impl: `export class MinHeap<T> {
  private data: Array<{ value: T; priority: number }> = []

  private up(i: number): void {
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.data[p].priority <= this.data[i].priority) break
      ;[this.data[p], this.data[i]] = [this.data[i], this.data[p]]
      i = p
    }
  }

  private down(i: number): void {
    const n = this.data.length
    while (true) {
      let min = i
      const l = 2 * i + 1, r = 2 * i + 2
      if (l < n && this.data[l].priority < this.data[min].priority) min = l
      if (r < n && this.data[r].priority < this.data[min].priority) min = r
      if (min === i) break
      ;[this.data[min], this.data[i]] = [this.data[i], this.data[min]]
      i = min
    }
  }

  insert(value: T, priority: number): void {
    this.data.push({ value, priority })
    this.up(this.data.length - 1)
  }

  extractMin(): { value: T; priority: number } | null {
    if (!this.data.length) return null
    const min = this.data[0]
    const last = this.data.pop()!
    if (this.data.length) { this.data[0] = last; this.down(0) }
    return min
  }

  peek(): { value: T; priority: number } | null { return this.data[0] ?? null }
  size(): number { return this.data.length }
  isEmpty(): boolean { return !this.data.length }
}`,
    tests: [
      { desc: 'extract min priority', call: '(() => { const h = new MinHeap<string>(); h.insert("a",3); h.insert("b",1); h.insert("c",2); return h.extractMin()?.value })()', want: '"b"' },
      { desc: 'peek does not remove', call: '(() => { const h = new MinHeap<string>(); h.insert("x",1); h.peek(); return h.size() })()', want: '1' },
      { desc: 'extract order', call: '(() => { const h = new MinHeap<number>(); [3,1,4,1,5].forEach(n=>h.insert(n,n)); return [h.extractMin()?.priority,h.extractMin()?.priority] })()', want: '[1,1]' },
      { desc: 'isEmpty true', call: 'new MinHeap().isEmpty()', want: 'true' },
      { desc: 'isEmpty false after insert', call: '(() => { const h = new MinHeap<number>(); h.insert(1,1); return h.isEmpty() })()', want: 'false' },
      { desc: 'extract empty', call: 'new MinHeap().extractMin()', want: 'null' },
    ],
  },

  {
    id: 'doubly-linked-list',
    filename: 'doublyLinkedList',
    summary: 'Doubly linked list with push, pop, unshift, shift, insert, remove.',
    defaultPath: 'src/doublyLinkedList.ts',
    exports: ['DoublyLinkedList'],
    patterns: [
      { re: '\\bdoubly.*linked|linked.*list.*doubly', weight: 0.75 },
      { re: '\\bDoublyLinkedList\\b', weight: 0.4 },
      { re: '\\blinked.*list.*prev|previous.*node.*linked', weight: 0.5 },
    ],
    impl: `interface Node<T> { value: T; prev: Node<T> | null; next: Node<T> | null }

export class DoublyLinkedList<T> {
  private head: Node<T> | null = null
  private tail: Node<T> | null = null
  private _size = 0

  push(value: T): void {
    const node: Node<T> = { value, prev: this.tail, next: null }
    if (this.tail) this.tail.next = node; else this.head = node
    this.tail = node; this._size++
  }

  pop(): T | undefined {
    if (!this.tail) return undefined
    const val = this.tail.value
    this.tail = this.tail.prev
    if (this.tail) this.tail.next = null; else this.head = null
    this._size--; return val
  }

  unshift(value: T): void {
    const node: Node<T> = { value, prev: null, next: this.head }
    if (this.head) this.head.prev = node; else this.tail = node
    this.head = node; this._size++
  }

  shift(): T | undefined {
    if (!this.head) return undefined
    const val = this.head.value
    this.head = this.head.next
    if (this.head) this.head.prev = null; else this.tail = null
    this._size--; return val
  }

  size(): number { return this._size }
  isEmpty(): boolean { return this._size === 0 }

  toArray(): T[] {
    const out: T[] = []
    let cur = this.head
    while (cur) { out.push(cur.value); cur = cur.next }
    return out
  }

  toArrayReverse(): T[] {
    const out: T[] = []
    let cur = this.tail
    while (cur) { out.push(cur.value); cur = cur.prev }
    return out
  }
}`,
    tests: [
      { desc: 'push and toArray', call: '(() => { const l = new DoublyLinkedList<number>(); [1,2,3].forEach(n=>l.push(n)); return l.toArray() })()', want: '[1,2,3]' },
      { desc: 'pop', call: '(() => { const l = new DoublyLinkedList<number>(); l.push(1); l.push(2); return l.pop() })()', want: '2' },
      { desc: 'unshift', call: '(() => { const l = new DoublyLinkedList<number>(); l.push(2); l.unshift(1); return l.toArray() })()', want: '[1,2]' },
      { desc: 'shift', call: '(() => { const l = new DoublyLinkedList<number>(); [1,2,3].forEach(n=>l.push(n)); return l.shift() })()', want: '1' },
      { desc: 'toArrayReverse', call: '(() => { const l = new DoublyLinkedList<number>(); [1,2,3].forEach(n=>l.push(n)); return l.toArrayReverse() })()', want: '[3,2,1]' },
      { desc: 'size', call: '(() => { const l = new DoublyLinkedList<number>(); l.push(1); l.push(2); return l.size() })()', want: '2' },
      { desc: 'isEmpty', call: 'new DoublyLinkedList().isEmpty()', want: 'true' },
      { desc: 'pop empty', call: 'new DoublyLinkedList().pop()', want: 'undefined' },
    ],
  },

  {
    id: 'graph-simple',
    filename: 'graphSimple',
    summary: 'Adjacency list graph with BFS, DFS, shortest path, and connected components.',
    defaultPath: 'src/graphSimple.ts',
    exports: ['Graph'],
    patterns: [
      { re: '\\bgraph\\b.*(?:bfs|dfs|shortest|adjacen)', weight: 0.65 },
      { re: '\\bbreadth.*first|depth.*first.*search', weight: 0.55 },
      { re: '\\bshortest.*path.*graph|graph.*path.*find', weight: 0.55 },
      { re: '\\bGraph\\b.*class|adjacency.*list', weight: 0.5 },
    ],
    impl: `export class Graph<T> {
  private adj = new Map<T, Set<T>>()

  addVertex(v: T): void { if (!this.adj.has(v)) this.adj.set(v, new Set()) }
  addEdge(u: T, v: T, directed = false): void {
    this.addVertex(u); this.addVertex(v)
    this.adj.get(u)!.add(v)
    if (!directed) this.adj.get(v)!.add(u)
  }
  neighbors(v: T): T[] { return [...(this.adj.get(v) ?? [])] }
  vertices(): T[] { return [...this.adj.keys()] }
  hasEdge(u: T, v: T): boolean { return this.adj.get(u)?.has(v) ?? false }

  bfs(start: T): T[] {
    const visited = new Set<T>(), queue = [start], out: T[] = []
    visited.add(start)
    while (queue.length) {
      const v = queue.shift()!; out.push(v)
      for (const n of this.adj.get(v) ?? []) if (!visited.has(n)) { visited.add(n); queue.push(n) }
    }
    return out
  }

  dfs(start: T): T[] {
    const visited = new Set<T>(), out: T[] = []
    const go = (v: T) => { visited.add(v); out.push(v); for (const n of this.adj.get(v) ?? []) if (!visited.has(n)) go(n) }
    go(start); return out
  }

  shortestPath(start: T, end: T): T[] | null {
    const prev = new Map<T, T>(), visited = new Set<T>([start]), queue = [start]
    while (queue.length) {
      const v = queue.shift()!
      if (v === end) { const path: T[] = []; let c: T | undefined = end; while (c !== undefined) { path.unshift(c); c = prev.get(c) }; return path }
      for (const n of this.adj.get(v) ?? []) if (!visited.has(n)) { visited.add(n); prev.set(n, v); queue.push(n) }
    }
    return null
  }
}`,
    tests: [
      { desc: 'addEdge and neighbors', call: '(() => { const g = new Graph<number>(); g.addEdge(1,2); return g.neighbors(1) })()', want: '[2]' },
      { desc: 'undirected both ways', call: '(() => { const g = new Graph<number>(); g.addEdge(1,2); return g.hasEdge(2,1) })()', want: 'true' },
      { desc: 'directed one way', call: '(() => { const g = new Graph<number>(); g.addEdge(1,2,true); return g.hasEdge(2,1) })()', want: 'false' },
      { desc: 'bfs order', call: '(() => { const g = new Graph<number>(); g.addEdge(1,2); g.addEdge(1,3); g.addEdge(2,4); return g.bfs(1) })()', want: '[1,2,3,4]' },
      { desc: 'dfs visits all', call: '(() => { const g = new Graph<number>(); g.addEdge(1,2); g.addEdge(2,3); return g.dfs(1).length })()', want: '3' },
      { desc: 'shortestPath basic', call: '(() => { const g = new Graph<number>(); g.addEdge(1,2); g.addEdge(2,3); return g.shortestPath(1,3) })()', want: '[1,2,3]' },
      { desc: 'shortestPath no path', call: '(() => { const g = new Graph<number>(); g.addVertex(1); g.addVertex(2); return g.shortestPath(1,2) })()', want: 'null' },
    ],
  },

  // ── State machine ─────────────────────────────────────────────────────────

  {
    id: 'state-machine',
    filename: 'stateMachine',
    summary: 'Finite state machine with typed states, transitions, guards, and actions.',
    defaultPath: 'src/stateMachine.ts',
    exports: ['StateMachine'],
    patterns: [
      { re: '\\bstate.*machine|finite.*state', weight: 0.7 },
      { re: '\\bStateMachine\\b', weight: 0.4 },
      { re: '\\bfsm\\b|\\btransition.*state|state.*transition', weight: 0.55 },
    ],
    impl: `export interface Transition<S extends string, E extends string> {
  from: S | '*'
  event: E
  to: S
  guard?: () => boolean
  action?: () => void
}

export class StateMachine<S extends string, E extends string> {
  private state: S
  private transitions: Transition<S, E>[]
  private history: S[] = []

  constructor(initial: S, transitions: Transition<S, E>[]) {
    this.state = initial
    this.transitions = transitions
    this.history = [initial]
  }

  getState(): S { return this.state }
  getHistory(): S[] { return [...this.history] }

  send(event: E): boolean {
    const t = this.transitions.find(t =>
      (t.from === '*' || t.from === this.state) &&
      t.event === event &&
      (!t.guard || t.guard())
    )
    if (!t) return false
    t.action?.()
    this.state = t.to
    this.history.push(t.to)
    return true
  }

  can(event: E): boolean {
    return this.transitions.some(t =>
      (t.from === '*' || t.from === this.state) &&
      t.event === event &&
      (!t.guard || t.guard())
    )
  }
}`,
    tests: [
      { desc: 'initial state', call: 'new StateMachine("idle", []).getState()', want: '"idle"' },
      { desc: 'transition', call: '(() => { const m = new StateMachine("idle", [{from:"idle",event:"start",to:"running"}]); m.send("start"); return m.getState() })()', want: '"running"' },
      { desc: 'send returns true on success', call: '(() => { const m = new StateMachine("idle", [{from:"idle",event:"go",to:"on"}]); return m.send("go") })()', want: 'true' },
      { desc: 'send returns false on miss', call: '(() => { const m = new StateMachine("idle", []); return m.send("go" as any) })()', want: 'false' },
      { desc: 'can check', call: '(() => { const m = new StateMachine("idle", [{from:"idle",event:"go",to:"on"}]); return m.can("go") })()', want: 'true' },
      { desc: 'guard blocks transition', call: '(() => { const m = new StateMachine("idle", [{from:"idle",event:"go",to:"on",guard:()=>false}]); m.send("go"); return m.getState() })()', want: '"idle"' },
      { desc: 'history tracking', call: '(() => { const m = new StateMachine("a", [{from:"a",event:"go",to:"b"},{from:"b",event:"go",to:"c"}]); m.send("go"); m.send("go"); return m.getHistory() })()', want: '["a","b","c"]' },
    ],
  },

  // ── Observer / pub-sub ────────────────────────────────────────────────────

  {
    id: 'observable',
    filename: 'observable',
    summary: 'Observable value with subscribe, next, complete; basic reactive state.',
    defaultPath: 'src/observable.ts',
    exports: ['Observable', 'Subject'],
    patterns: [
      { re: '\\bobservable\\b', weight: 0.6 },
      { re: '\\bSubject\\b.*observable|reactive.*state', weight: 0.55 },
      { re: '\\bsubscribe\\b.*\\bnext\\b|observer.*pattern.*reactive', weight: 0.5 },
    ],
    impl: `export interface Observer<T> { next: (val: T) => void; error?: (err: unknown) => void; complete?: () => void }
export interface Subscription { unsubscribe(): void }

export class Observable<T> {
  constructor(private _subscribe: (obs: Observer<T>) => void | (() => void)) {}

  subscribe(observer: Observer<T> | ((val: T) => void)): Subscription {
    const obs: Observer<T> = typeof observer === 'function' ? { next: observer } : observer
    let cleanup: void | (() => void)
    let done = false
    cleanup = this._subscribe({
      next: v => { if (!done) obs.next(v) },
      error: e => { if (!done) { done = true; obs.error?.(e) } },
      complete: () => { if (!done) { done = true; obs.complete?.() } },
    })
    return { unsubscribe: () => { done = true; (cleanup as (() => void)| void)?.() } }
  }

  static of<T>(...values: T[]): Observable<T> {
    return new Observable(obs => { values.forEach(v => obs.next(v)); obs.complete?.() })
  }

  map<U>(fn: (v: T) => U): Observable<U> {
    return new Observable(obs => this.subscribe({ next: v => obs.next(fn(v)), error: obs.error, complete: obs.complete }))
  }

  filter(fn: (v: T) => boolean): Observable<T> {
    return new Observable(obs => this.subscribe({ next: v => fn(v) && obs.next(v), error: obs.error, complete: obs.complete }))
  }
}

export class Subject<T> extends Observable<T> {
  private observers: Observer<T>[] = []

  constructor() {
    super(obs => { this.observers.push(obs) })
  }

  next(value: T): void { this.observers.forEach(o => o.next(value)) }
  complete(): void { this.observers.forEach(o => o.complete?.()) }
  error(err: unknown): void { this.observers.forEach(o => o.error?.(err)) }
}`,
    tests: [
      { desc: 'Observable.of emits values', call: '(() => { const vals: number[] = []; Observable.of(1,2,3).subscribe(v=>vals.push(v)); return vals })()', want: '[1,2,3]' },
      { desc: 'map transforms', call: '(() => { const vals: number[] = []; Observable.of(1,2,3).map(x=>x*2).subscribe(v=>vals.push(v)); return vals })()', want: '[2,4,6]' },
      { desc: 'filter selects', call: '(() => { const vals: number[] = []; Observable.of(1,2,3,4).filter(x=>x%2===0).subscribe(v=>vals.push(v)); return vals })()', want: '[2,4]' },
      { desc: 'unsubscribe stops', call: '(() => { const vals: number[] = []; const s = new Subject<number>(); const sub = s.subscribe(v=>vals.push(v)); s.next(1); sub.unsubscribe(); s.next(2); return vals })()', want: '[1]' },
      { desc: 'Subject emits', call: '(() => { const vals: number[] = []; const s = new Subject<number>(); s.subscribe(v=>vals.push(v)); s.next(1); s.next(2); return vals })()', want: '[1,2]' },
    ],
  },

  // ── Functional programming ────────────────────────────────────────────────

  {
    id: 'fp-utils',
    filename: 'fpUtils',
    summary: 'curry, partial, memoize, identity, constant, noop, flip.',
    defaultPath: 'src/fpUtils.ts',
    exports: ['curry', 'partial', 'identity', 'constant', 'noop', 'flip'],
    patterns: [
      { re: '\\bcurry\\b.*function|function.*\\bcurry\\b', weight: 0.6 },
      { re: '\\bpartial.*application|partial.*function', weight: 0.55 },
      { re: '\\bcurry.*partial|functional.*programming.*util', weight: 0.6 },
      { re: '\\bflip\\b.*argument|argument.*\\bflip\\b', weight: 0.45 },
    ],
    impl: `export function curry<T extends unknown[], R>(fn: (...args: T) => R): (...args: unknown[]) => unknown {
  return function curried(...args: unknown[]): unknown {
    if (args.length >= fn.length) return (fn as (...a: unknown[]) => R)(...args)
    return (...more: unknown[]) => curried(...args, ...more)
  }
}

export function partial<T extends unknown[], R>(fn: (...args: T) => R, ...pre: unknown[]): (...args: unknown[]) => R {
  return (...args: unknown[]) => (fn as (...a: unknown[]) => R)(...pre, ...args)
}

export function identity<T>(x: T): T { return x }
export function constant<T>(x: T): () => T { return () => x }
export function noop(): void {}
export function flip<A, B, C>(fn: (a: A, b: B) => C): (b: B, a: A) => C {
  return (b, a) => fn(a, b)
}`,
    tests: [
      { desc: 'curry two args', call: '(curry((a:number,b:number)=>a+b) as any)(1)(2)', want: '3' },
      { desc: 'curry all at once', call: '(curry((a:number,b:number)=>a+b) as any)(1,2)', want: '3' },
      { desc: 'partial first arg', call: 'partial((a:number,b:number)=>a+b, 10)(5)', want: '15' },
      { desc: 'identity', call: 'identity(42)', want: '42' },
      { desc: 'constant', call: 'constant(42)()', want: '42' },
      { desc: 'noop returns undefined', call: 'noop()', want: 'undefined' },
      { desc: 'flip args', call: 'flip((a:string,b:string)=>a+b)("world","hello")', want: '"helloworld"' },
    ],
  },

  // ── Number parsing & formatting ───────────────────────────────────────────

  {
    id: 'parse-number',
    filename: 'parseNumber',
    summary: 'safeParseInt, safeParseFloat, toFixed, toPrecision with fallback.',
    defaultPath: 'src/parseNumber.ts',
    exports: ['safeParseInt', 'safeParseFloat', 'toFixed', 'inRange'],
    patterns: [
      { re: '\\bsafeParseInt\\b|\\bsafe.*parse.*int', weight: 0.6 },
      { re: '\\bsafeParseFloat\\b|\\bsafe.*parse.*float', weight: 0.55 },
      { re: '\\bparse.*number.*safe|safe.*number.*parse', weight: 0.5 },
      { re: '\\binRange\\b|\\bnumber.*range.*check', weight: 0.4 },
    ],
    impl: `export function safeParseInt(s: string, fallback = 0, radix = 10): number {
  const n = parseInt(s, radix)
  return isNaN(n) ? fallback : n
}

export function safeParseFloat(s: string, fallback = 0): number {
  const n = parseFloat(s)
  return isNaN(n) ? fallback : n
}

export function toFixed(n: number, decimals: number): number {
  return parseFloat(n.toFixed(decimals))
}

export function inRange(n: number, min: number, max: number, inclusive = true): boolean {
  return inclusive ? n >= min && n <= max : n > min && n < max
}`,
    tests: [
      { desc: 'safeParseInt valid', call: 'safeParseInt("42")', want: '42' },
      { desc: 'safeParseInt invalid', call: 'safeParseInt("abc")', want: '0' },
      { desc: 'safeParseInt fallback', call: 'safeParseInt("x", 99)', want: '99' },
      { desc: 'safeParseInt hex', call: 'safeParseInt("ff", 0, 16)', want: '255' },
      { desc: 'safeParseFloat valid', call: 'safeParseFloat("3.14")', want: '3.14' },
      { desc: 'safeParseFloat invalid', call: 'safeParseFloat("abc")', want: '0' },
      { desc: 'toFixed rounds', call: 'toFixed(3.14159, 2)', want: '3.14' },
      { desc: 'toFixed returns number', call: 'typeof toFixed(1.5, 0) === "number"', want: 'true' },
      { desc: 'inRange in', call: 'inRange(5, 1, 10)', want: 'true' },
      { desc: 'inRange out', call: 'inRange(15, 1, 10)', want: 'false' },
      { desc: 'inRange exclusive', call: 'inRange(10, 1, 10, false)', want: 'false' },
    ],
  },

  // ── Text processing ───────────────────────────────────────────────────────

  {
    id: 'text-analysis',
    filename: 'textAnalysis',
    summary: 'wordFrequency, readingTime, sentenceCount, charCount, longestWord.',
    defaultPath: 'src/textAnalysis.ts',
    exports: ['wordFrequency', 'readingTime', 'sentenceCount', 'longestWord'],
    patterns: [
      { re: '\\bword.*frequency|frequency.*word', weight: 0.6 },
      { re: '\\breading.*time|estimate.*read', weight: 0.55 },
      { re: '\\btext.*analysis|analyse.*text', weight: 0.5 },
      { re: '\\blongestWord\\b|\\bsentenceCount\\b', weight: 0.4 },
    ],
    impl: `export function wordFrequency(text: string): Map<string, number> {
  const map = new Map<string, number>()
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) map.set(w, (map.get(w) ?? 0) + 1)
  return map
}

export function readingTime(text: string, wpm = 200): number {
  const count = (text.match(/[a-z]+/gi) ?? []).length
  return Math.ceil(count / wpm)
}

export function sentenceCount(text: string): number {
  return (text.match(/[.!?]+/g) ?? []).length
}

export function longestWord(text: string): string {
  const words = text.match(/[a-zA-Z]+/g) ?? []
  return words.reduce((a, b) => b.length > a.length ? b : a, '')
}`,
    tests: [
      { desc: 'wordFrequency counts', call: 'wordFrequency("the cat and the dog")!.get("the")', want: '2' },
      { desc: 'wordFrequency case insensitive', call: 'wordFrequency("Hello hello")!.get("hello")', want: '2' },
      { desc: 'readingTime 200 words', call: 'readingTime(Array(200).fill("word").join(" "))', want: '1' },
      { desc: 'readingTime rounds up', call: 'readingTime("word", 200)', want: '1' },
      { desc: 'sentenceCount basic', call: 'sentenceCount("Hello. How are you? Fine!")', want: '3' },
      { desc: 'sentenceCount empty', call: 'sentenceCount("")', want: '0' },
      { desc: 'longestWord basic', call: 'longestWord("the quick brown fox")', want: '"quick"' },
      { desc: 'longestWord empty', call: 'longestWord("")', want: '""' },
    ],
  },

  // ── HTTP / URL ────────────────────────────────────────────────────────────

  {
    id: 'url-utils',
    filename: 'urlUtils',
    summary: 'parseURL, buildURL, getQueryParam, updateQueryParam, removeQueryParam.',
    defaultPath: 'src/urlUtils.ts',
    exports: ['parseURL', 'buildURL', 'getQueryParam', 'updateQueryParam'],
    patterns: [
      { re: '\\bparse.*url|url.*parse', weight: 0.55 },
      { re: '\\bbuildURL\\b|\\bbuild.*url\\b', weight: 0.5 },
      { re: '\\bquery.*param.*update|update.*query.*param', weight: 0.5 },
      { re: '\\bgetQueryParam\\b|\\burl.*util', weight: 0.45 },
    ],
    impl: `export interface ParsedURL {
  protocol: string; host: string; pathname: string
  search: string; hash: string; params: Record<string, string>
}

export function parseURL(url: string): ParsedURL | null {
  try {
    const u = new URL(url)
    const params: Record<string, string> = {}
    u.searchParams.forEach((v, k) => { params[k] = v })
    return { protocol: u.protocol, host: u.host, pathname: u.pathname, search: u.search, hash: u.hash, params }
  } catch { return null }
}

export function buildURL(base: string, params: Record<string, string>): string {
  try {
    const u = new URL(base)
    Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v))
    return u.toString()
  } catch { return base }
}

export function getQueryParam(url: string, key: string): string | null {
  try { return new URL(url).searchParams.get(key) } catch { return null }
}

export function updateQueryParam(url: string, key: string, value: string): string {
  try {
    const u = new URL(url); u.searchParams.set(key, value); return u.toString()
  } catch { return url }
}`,
    tests: [
      { desc: 'parseURL basic', call: 'parseURL("https://example.com/path?q=1")?.pathname', want: '"/path"' },
      { desc: 'parseURL params', call: 'parseURL("https://ex.com?a=1&b=2")?.params["b"]', want: '"2"' },
      { desc: 'parseURL invalid', call: 'parseURL("not-a-url")', want: 'null' },
      { desc: 'buildURL adds param', call: 'buildURL("https://ex.com", {q:"hello"}).includes("q=hello")', want: 'true' },
      { desc: 'getQueryParam found', call: 'getQueryParam("https://ex.com?key=val", "key")', want: '"val"' },
      { desc: 'getQueryParam missing', call: 'getQueryParam("https://ex.com", "key")', want: 'null' },
      { desc: 'updateQueryParam updates', call: 'getQueryParam(updateQueryParam("https://ex.com?k=old","k","new"), "k")', want: '"new"' },
    ],
  },

  // ── Async patterns ────────────────────────────────────────────────────────

  {
    id: 'async-patterns',
    filename: 'asyncPatterns',
    summary: 'memoizeAsync, raceTimeout, sequential, waterfall for async tasks.',
    defaultPath: 'src/asyncPatterns.ts',
    exports: ['memoizeAsync', 'sequential', 'waterfall'],
    patterns: [
      { re: '\\bmemoize.*async|async.*memoize', weight: 0.6 },
      { re: '\\bsequential.*async|run.*async.*sequence', weight: 0.55 },
      { re: '\\bwaterfall\\b.*async|async.*waterfall', weight: 0.55 },
      { re: '\\basync.*pattern|async.*util.*advanced', weight: 0.45 },
    ],
    impl: `export function memoizeAsync<T extends unknown[], R>(fn: (...args: T) => Promise<R>): (...args: T) => Promise<R> {
  const cache = new Map<string, Promise<R>>()
  return (...args: T): Promise<R> => {
    const key = JSON.stringify(args)
    if (!cache.has(key)) cache.set(key, fn(...args))
    return cache.get(key)!
  }
}

export async function sequential<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
  const results: T[] = []
  for (const task of tasks) results.push(await task())
  return results
}

export async function waterfall<T>(
  input: T,
  fns: Array<(v: T) => Promise<T>>,
): Promise<T> {
  let val = input
  for (const fn of fns) val = await fn(val)
  return val
}`,
    tests: [
      { desc: 'memoizeAsync caches', call: '(async()=>{let n=0;const f=memoizeAsync(async()=>++n);await f();await f();return n})()', want: '1' },
      { desc: 'memoizeAsync different args', call: '(async()=>{let n=0;const f=memoizeAsync(async(x:number)=>{n++;return x*2});const r=[await f(1),await f(2),await f(1)];return [r,n]})()', want: '[[2,4,2],2]' },
      { desc: 'sequential order', call: 'sequential([async()=>1, async()=>2, async()=>3])', want: '[1,2,3]' },
      { desc: 'sequential empty', call: 'sequential([])', want: '[]' },
      { desc: 'waterfall transforms', call: 'waterfall(1, [async x=>x+1, async x=>x*2, async x=>x-1])', want: '3' },
      { desc: 'waterfall no fns', call: 'waterfall(42, [])', want: '42' },
    ],
  },

  // ── Diff / patch ──────────────────────────────────────────────────────────

  {
    id: 'array-diff',
    filename: 'arrayDiff',
    summary: 'Myers diff algorithm for arrays: compute add/remove patches, apply patch.',
    defaultPath: 'src/arrayDiff.ts',
    exports: ['diffArrays', 'applyPatch'],
    patterns: [
      { re: '\\bdiff.*array|array.*diff', weight: 0.65 },
      { re: '\\bmyers.*diff|lcs.*diff', weight: 0.55 },
      { re: '\\bdiffArrays\\b|\\bapplyPatch\\b', weight: 0.4 },
      { re: '\\bpatch.*array|compute.*changes.*array', weight: 0.45 },
    ],
    impl: `export type DiffOp<T> = { op: 'keep' | 'add' | 'remove'; value: T }

export function diffArrays<T>(from: T[], to: T[], eq = (a: T, b: T) => a === b): DiffOp<T>[] {
  const m = from.length, n = to.length
  const dp: number[][] = Array.from({length: m+1}, () => new Array(n+1).fill(0))
  for (let i = m-1; i >= 0; i--)
    for (let j = n-1; j >= 0; j--)
      dp[i][j] = eq(from[i], to[j]) ? dp[i+1][j+1]+1 : Math.max(dp[i+1][j], dp[i][j+1])
  const ops: DiffOp<T>[] = []
  let i = 0, j = 0
  while (i < m || j < n) {
    if (i < m && j < n && eq(from[i], to[j])) { ops.push({op:'keep',value:from[i]}); i++; j++ }
    else if (j < n && (i >= m || dp[i][j+1] >= dp[i+1][j])) { ops.push({op:'add',value:to[j]}); j++ }
    else { ops.push({op:'remove',value:from[i]}); i++ }
  }
  return ops
}

export function applyPatch<T>(from: T[], patch: DiffOp<T>[]): T[] {
  return patch.filter(op => op.op !== 'remove').map(op => op.value)
}`,
    tests: [
      { desc: 'diff no change', call: 'diffArrays([1,2,3],[1,2,3]).every(o=>o.op==="keep")', want: 'true' },
      { desc: 'diff addition', call: 'diffArrays([1,2],[1,2,3]).some(o=>o.op==="add"&&o.value===3)', want: 'true' },
      { desc: 'diff removal', call: 'diffArrays([1,2,3],[1,3]).some(o=>o.op==="remove"&&o.value===2)', want: 'true' },
      { desc: 'applyPatch produces target', call: 'JSON.stringify(applyPatch([1,2,3],diffArrays([1,2,3],[1,4,3])))', want: '"[1,4,3]"' },
      { desc: 'diff empty to', call: 'diffArrays([1,2],[]).every(o=>o.op==="remove")', want: 'true' },
      { desc: 'diff empty from', call: 'diffArrays([],[1,2]).every(o=>o.op==="add")', want: 'true' },
    ],
  },

  // ── Validation schema ─────────────────────────────────────────────────────

  {
    id: 'schema-validate',
    filename: 'schemaValidate',
    summary: 'Lightweight runtime schema validation: required, type, min, max, pattern.',
    defaultPath: 'src/schemaValidate.ts',
    exports: ['validate', 'createSchema'],
    patterns: [
      { re: '\\bschema.*validat|validat.*schema', weight: 0.65 },
      { re: '\\bruntime.*validat|validat.*runtime', weight: 0.5 },
      { re: '\\bcreateSchema\\b|\\bvalidate\\b.*object.*schema', weight: 0.5 },
      { re: '\\bzod.*like|yup.*like|simple.*validat', weight: 0.4 },
    ],
    impl: `export interface FieldRule {
  type?: 'string' | 'number' | 'boolean' | 'array' | 'object'
  required?: boolean
  min?: number; max?: number
  pattern?: RegExp
  enum?: unknown[]
  items?: FieldRule
}
export type Schema = Record<string, FieldRule>
export interface ValidationResult { valid: boolean; errors: string[] }

export function validate(data: Record<string, unknown>, schema: Schema): ValidationResult {
  const errors: string[] = []
  for (const [key, rule] of Object.entries(schema)) {
    const val = data[key]
    if (rule.required && (val === undefined || val === null || val === '')) {
      errors.push(\`\${key}: required\`); continue
    }
    if (val === undefined || val === null) continue
    if (rule.type) {
      const actual = Array.isArray(val) ? 'array' : typeof val
      if (actual !== rule.type) { errors.push(\`\${key}: expected \${rule.type}, got \${actual}\`); continue }
    }
    if (rule.pattern && typeof val === 'string' && !rule.pattern.test(val)) errors.push(\`\${key}: pattern mismatch\`)
    if (rule.enum && !rule.enum.includes(val)) errors.push(\`\${key}: must be one of \${rule.enum.join(', ')}\`)
    if (typeof val === 'number') {
      if (rule.min !== undefined && val < rule.min) errors.push(\`\${key}: min \${rule.min}\`)
      if (rule.max !== undefined && val > rule.max) errors.push(\`\${key}: max \${rule.max}\`)
    }
    if (typeof val === 'string') {
      if (rule.min !== undefined && val.length < rule.min) errors.push(\`\${key}: minLength \${rule.min}\`)
      if (rule.max !== undefined && val.length > rule.max) errors.push(\`\${key}: maxLength \${rule.max}\`)
    }
  }
  return { valid: errors.length === 0, errors }
}

export function createSchema(schema: Schema) {
  return (data: Record<string, unknown>) => validate(data, schema)
}`,
    tests: [
      { desc: 'valid object', call: 'validate({name:"Alice",age:25},{name:{type:"string",required:true},age:{type:"number",min:0}}).valid', want: 'true' },
      { desc: 'missing required', call: 'validate({},{name:{required:true}}).valid', want: 'false' },
      { desc: 'wrong type', call: 'validate({age:"25"},{age:{type:"number"}}).valid', want: 'false' },
      { desc: 'min number', call: 'validate({age:-1},{age:{type:"number",min:0}}).valid', want: 'false' },
      { desc: 'max string length', call: 'validate({name:"toolongname"},{name:{type:"string",max:5}}).valid', want: 'false' },
      { desc: 'enum valid', call: 'validate({color:"red"},{color:{enum:["red","blue"]}}).valid', want: 'true' },
      { desc: 'enum invalid', call: 'validate({color:"green"},{color:{enum:["red","blue"]}}).valid', want: 'false' },
      { desc: 'createSchema', call: 'createSchema({x:{type:"number",required:true}})({x:1}).valid', want: 'true' },
      { desc: 'error messages', call: 'validate({},{name:{required:true}}).errors.length', want: '1' },
    ],
  },

  // ── Bit operations ────────────────────────────────────────────────────────

  {
    id: 'bit-utils',
    filename: 'bitUtils',
    summary: 'Bitwise utilities: setBit, clearBit, toggleBit, hasBit, countBits, isPowerOf2.',
    defaultPath: 'src/bitUtils.ts',
    exports: ['setBit', 'clearBit', 'toggleBit', 'hasBit', 'countBits', 'isPowerOf2'],
    patterns: [
      { re: '\\bbit.*manipulat|bitwise.*util', weight: 0.6 },
      { re: '\\bsetBit\\b|\\bclearBit\\b|\\bhasBit\\b', weight: 0.55 },
      { re: '\\bcountBits\\b|\\bpopcount\\b|\\bcount.*set.*bit', weight: 0.5 },
      { re: '\\bisPowerOf2\\b|\\bpower.*of.*2', weight: 0.5 },
    ],
    impl: `export function setBit(n: number, bit: number): number { return n | (1 << bit) }
export function clearBit(n: number, bit: number): number { return n & ~(1 << bit) }
export function toggleBit(n: number, bit: number): number { return n ^ (1 << bit) }
export function hasBit(n: number, bit: number): boolean { return (n & (1 << bit)) !== 0 }
export function countBits(n: number): number {
  let count = 0, x = n >>> 0
  while (x) { count += x & 1; x >>>= 1 }
  return count
}
export function isPowerOf2(n: number): boolean { return n > 0 && (n & (n - 1)) === 0 }`,
    tests: [
      { desc: 'setBit', call: 'setBit(0b1010, 0)', want: '11' },
      { desc: 'clearBit', call: 'clearBit(0b1010, 1)', want: '8' },
      { desc: 'toggleBit set', call: 'toggleBit(0, 2)', want: '4' },
      { desc: 'toggleBit clear', call: 'toggleBit(4, 2)', want: '0' },
      { desc: 'hasBit true', call: 'hasBit(0b1010, 1)', want: 'true' },
      { desc: 'hasBit false', call: 'hasBit(0b1010, 0)', want: 'false' },
      { desc: 'countBits 7', call: 'countBits(7)', want: '3' },
      { desc: 'countBits 0', call: 'countBits(0)', want: '0' },
      { desc: 'isPowerOf2 true', call: 'isPowerOf2(16)', want: 'true' },
      { desc: 'isPowerOf2 false', call: 'isPowerOf2(6)', want: 'false' },
      { desc: 'isPowerOf2 zero', call: 'isPowerOf2(0)', want: 'false' },
    ],
  },

  // ── Formatting ────────────────────────────────────────────────────────────

  {
    id: 'table-format',
    filename: 'tableFormat',
    summary: 'Format an array of objects as an ASCII table string.',
    defaultPath: 'src/tableFormat.ts',
    exports: ['formatTable'],
    patterns: [
      { re: '\\btable.*format|format.*table|ascii.*table', weight: 0.65 },
      { re: '\\bformatTable\\b', weight: 0.4 },
      { re: '\\barray.*object.*table|tabular.*format', weight: 0.45 },
    ],
    impl: `export function formatTable(rows: Record<string, unknown>[], columns?: string[]): string {
  if (!rows.length) return ''
  const cols = columns ?? Object.keys(rows[0])
  const widths = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length)))
  const pad = (s: string, w: number) => s.padEnd(w)
  const sep = '+' + widths.map(w => '-'.repeat(w + 2)).join('+') + '+'
  const row = (cells: string[]) => '|' + cells.map((c, i) => ' ' + pad(c, widths[i]) + ' ').join('|') + '|'
  return [
    sep,
    row(cols),
    sep,
    ...rows.map(r => row(cols.map(c => String(r[c] ?? '')))),
    sep,
  ].join('\\n')
}`,
    tests: [
      { desc: 'basic table', call: 'formatTable([{a:"x",b:"y"}]).includes("a")', want: 'true' },
      { desc: 'has separator', call: 'formatTable([{n:"Alice",age:"30"}]).includes("---")', want: 'true' },
      { desc: 'empty returns empty', call: 'formatTable([])', want: '""' },
      { desc: 'includes data', call: 'formatTable([{name:"Bob"}]).includes("Bob")', want: 'true' },
      { desc: 'custom columns', call: 'formatTable([{a:1,b:2,c:3}],["a","c"]).includes("b")', want: 'false' },
    ],
  },

  // ── Streams / chunked processing ──────────────────────────────────────────

  {
    id: 'batch-processor',
    filename: 'batchProcessor',
    summary: 'Process a large array in batches with optional concurrency and progress callback.',
    defaultPath: 'src/batchProcessor.ts',
    exports: ['processBatches'],
    patterns: [
      { re: '\\bbatch.*process|process.*batch', weight: 0.65 },
      { re: '\\bprocessBatches\\b', weight: 0.4 },
      { re: '\\blarge.*array.*chunk|chunk.*async.*process', weight: 0.45 },
    ],
    impl: `export interface BatchOpts<T, R> {
  batchSize?: number
  concurrency?: number
  onBatch?: (results: R[], batchIndex: number) => void
}

export async function processBatches<T, R>(
  items: T[],
  fn: (batch: T[]) => Promise<R[]>,
  opts: BatchOpts<T, R> = {},
): Promise<R[]> {
  const { batchSize = 100, concurrency = 1, onBatch } = opts
  const batches: T[][] = []
  for (let i = 0; i < items.length; i += batchSize) batches.push(items.slice(i, i + batchSize))
  const allResults: R[] = []
  for (let i = 0; i < batches.length; i += concurrency) {
    const slice = batches.slice(i, i + concurrency)
    const results = await Promise.all(slice.map(b => fn(b)))
    results.forEach((r, j) => { allResults.push(...r); onBatch?.(r, i + j) })
  }
  return allResults
}`,
    tests: [
      { desc: 'processes all', call: 'processBatches([1,2,3,4,5], async b=>b.map(x=>x*2), {batchSize:2})', want: '[2,4,6,8,10]' },
      { desc: 'empty input', call: 'processBatches([], async b=>b)', want: '[]' },
      { desc: 'single batch', call: 'processBatches([1,2,3], async b=>b, {batchSize:10})', want: '[1,2,3]' },
      { desc: 'onBatch called', call: '(async()=>{let calls=0;await processBatches([1,2,3,4],async b=>b,{batchSize:2,onBatch:()=>calls++});return calls})()', want: '2' },
      { desc: 'concurrency 2', call: 'processBatches([1,2,3,4,5,6], async b=>b.map(x=>x+10), {batchSize:2,concurrency:2})', want: '[11,12,13,14,15,16]' },
    ],
  },

  // ── Type narrowing helpers ────────────────────────────────────────────────

  {
    id: 'type-utils',
    filename: 'typeUtils',
    summary: 'assertNever, isError, tryCatch, Result type with ok/err helpers.',
    defaultPath: 'src/typeUtils.ts',
    exports: ['isError', 'tryCatch', 'ok', 'err'],
    patterns: [
      { re: '\\bResult.*type|\\bResult<', weight: 0.55 },
      { re: '\\btryCatch\\b|\\btry.*catch.*util', weight: 0.55 },
      { re: '\\bisError\\b|\\berror.*util', weight: 0.5 },
      { re: '\\bok\\b.*\\berr\\b.*result|result.*type.*ok.*err', weight: 0.55 },
    ],
    impl: `export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E }

export function ok<T>(value: T): Result<T, never> { return { ok: true, value } }
export function err<E>(error: E): Result<never, E> { return { ok: false, error } }

export function isError(val: unknown): val is Error {
  return val instanceof Error
}

export function tryCatch<T>(fn: () => T): Result<T, Error> {
  try { return ok(fn()) } catch (e) { return err(e instanceof Error ? e : new Error(String(e))) }
}

export async function tryCatchAsync<T>(fn: () => Promise<T>): Promise<Result<T, Error>> {
  try { return ok(await fn()) } catch (e) { return err(e instanceof Error ? e : new Error(String(e))) }
}`,
    tests: [
      { desc: 'ok result', call: 'ok(42)', want: '{"ok":true,"value":42}' },
      { desc: 'err result', call: 'JSON.stringify(err("oops"))', want: '"{\\"ok\\":false,\\"error\\":\\"oops\\"}"' },
      { desc: 'tryCatch success', call: 'tryCatch(()=>42)', want: '{"ok":true,"value":42}' },
      { desc: 'tryCatch failure ok false', call: 'tryCatch(()=>{throw new Error("boom")}).ok', want: 'false' },
      { desc: 'tryCatch error message', call: '(tryCatch(()=>{throw new Error("boom")}) as any).error.message', want: '"boom"' },
      { desc: 'isError true', call: 'isError(new Error("x"))', want: 'true' },
      { desc: 'isError false', call: 'isError("x")', want: 'false' },
    ],
  },

  // ── Serialization / encoding ──────────────────────────────────────────────

  {
    id: 'json-utils',
    filename: 'jsonUtils',
    summary: 'JSON deep-diff, JSON flatten/unflatten, JSON schema coerce.',
    defaultPath: 'src/jsonUtils.ts',
    exports: ['jsonDiff', 'jsonFlatten', 'jsonUnflatten'],
    patterns: [
      { re: '\\bjson.*diff|diff.*json', weight: 0.6 },
      { re: '\\bjson.*flatten|flatten.*json', weight: 0.55 },
      { re: '\\bjsonDiff\\b|\\bjsonFlatten\\b', weight: 0.4 },
    ],
    impl: `export type JSONPrimitive = string | number | boolean | null
export type JSONValue = JSONPrimitive | JSONValue[] | { [key: string]: JSONValue }

export interface JSONDiffEntry { path: string; from: JSONValue; to: JSONValue }

export function jsonDiff(a: JSONValue, b: JSONValue, path = ''): JSONDiffEntry[] {
  const results: JSONDiffEntry[] = []
  if (JSON.stringify(a) === JSON.stringify(b)) return results
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) {
    return [{ path: path || '.', from: a, to: b }]
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    const sub = path ? \`\${path}.\${k}\` : k
    const av = (a as Record<string, JSONValue>)[k], bv = (b as Record<string, JSONValue>)[k]
    if (av === undefined) results.push({ path: sub, from: undefined as any, to: bv })
    else if (bv === undefined) results.push({ path: sub, from: av, to: undefined as any })
    else results.push(...jsonDiff(av, bv, sub))
  }
  return results
}

export function jsonFlatten(obj: JSONValue, prefix = ''): Record<string, JSONPrimitive> {
  const out: Record<string, JSONPrimitive> = {}
  function walk(v: JSONValue, p: string) {
    if (v === null || typeof v !== 'object') { out[p] = v as JSONPrimitive; return }
    for (const [k, child] of Object.entries(v)) walk(child, p ? \`\${p}.\${k}\` : k)
  }
  walk(obj, prefix)
  return out
}

export function jsonUnflatten(flat: Record<string, JSONPrimitive>): JSONValue {
  const out: Record<string, JSONValue> = {}
  for (const [k, v] of Object.entries(flat)) {
    const parts = k.split('.')
    let cur = out as Record<string, JSONValue>
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {}
      cur = cur[parts[i]] as Record<string, JSONValue>
    }
    cur[parts[parts.length - 1]] = v
  }
  return out
}`,
    tests: [
      { desc: 'diff no change', call: 'jsonDiff({a:1},{a:1}).length', want: '0' },
      { desc: 'diff changed value', call: 'jsonDiff({a:1},{a:2})[0]', want: '{"path":"a","from":1,"to":2}' },
      { desc: 'diff added key', call: 'jsonDiff({},{a:1})[0].path', want: '"a"' },
      { desc: 'diff nested', call: 'jsonDiff({a:{b:1}},{a:{b:2}})[0].path', want: '"a.b"' },
      { desc: 'flatten basic', call: 'JSON.stringify(jsonFlatten({a:{b:1},c:2}))', want: '"{\\"a.b\\":1,\\"c\\":2}"' },
      { desc: 'flatten nested', call: 'jsonFlatten({x:{y:{z:42}}})["x.y.z"]', want: '42' },
      { desc: 'unflatten roundtrip', call: 'JSON.stringify(jsonUnflatten(jsonFlatten({a:{b:1},c:2})))', want: '"{\\"a\\":{\\"b\\":1},\\"c\\":2}"' },
    ],
  },

  // ── Memoize with TTL ──────────────────────────────────────────────────────

  {
    id: 'memoize-ttl',
    filename: 'memoizeTTL',
    summary: 'Memoize with per-entry TTL expiration and optional max size.',
    defaultPath: 'src/memoizeTTL.ts',
    exports: ['memoizeTTL'],
    patterns: [
      { re: '\\bmemoize.*ttl|ttl.*memoize', weight: 0.7 },
      { re: '\\bcache.*expire|expir.*cache.*key', weight: 0.55 },
      { re: '\\bmemoizeTTL\\b', weight: 0.4 },
    ],
    impl: `export function memoizeTTL<T extends unknown[], R>(
  fn: (...args: T) => R,
  ttlMs: number,
  now: () => number = Date.now,
): (...args: T) => R {
  const cache = new Map<string, { value: R; exp: number }>()
  return (...args: T): R => {
    const key = JSON.stringify(args)
    const entry = cache.get(key)
    if (entry && now() < entry.exp) return entry.value
    const value = fn(...args)
    cache.set(key, { value, exp: now() + ttlMs })
    return value
  }
}`,
    tests: [
      { desc: 'returns correct value', call: 'memoizeTTL((x:number)=>x*2, 1000)(5)', want: '10' },
      { desc: 'caches within TTL', call: '(()=>{let n=0;const f=memoizeTTL(()=>++n,1000);f();f();return n})()', want: '1' },
      { desc: 'recomputes after TTL', call: '(()=>{let n=0,t=0;const f=memoizeTTL(()=>++n,100,()=>t);f();t=200;f();return n})()', want: '2' },
      { desc: 'different args separate', call: '(()=>{const f=memoizeTTL((x:number)=>x,1000);return [f(1),f(2)]})()', want: '[1,2]' },
    ],
  },

  // ── Pipeline / builder pattern ────────────────────────────────────────────

  {
    id: 'pipeline',
    filename: 'pipeline',
    summary: 'Data pipeline: chain sync and async transformations on a value.',
    defaultPath: 'src/pipeline.ts',
    exports: ['Pipeline'],
    patterns: [
      { re: '\\bpipeline\\b.*class|\\bdata.*pipeline', weight: 0.6 },
      { re: '\\bPipeline\\b.*builder|chain.*transform', weight: 0.55 },
      { re: '\\bmethod.*chain.*transform|fluent.*pipeline', weight: 0.45 },
    ],
    impl: `export class Pipeline<T> {
  constructor(private value: T) {}

  static of<T>(value: T): Pipeline<T> { return new Pipeline(value) }

  map<U>(fn: (v: T) => U): Pipeline<U> { return new Pipeline(fn(this.value)) }

  tap(fn: (v: T) => void): Pipeline<T> { fn(this.value); return this }

  filter(pred: (v: T) => boolean, fallback: T): Pipeline<T> {
    return new Pipeline(pred(this.value) ? this.value : fallback)
  }

  async mapAsync<U>(fn: (v: T) => Promise<U>): Promise<Pipeline<U>> {
    return new Pipeline(await fn(this.value))
  }

  value(): T { return this.value as T }
  unwrap(): T { return this.value as T }
}`,
    tests: [
      { desc: 'of and unwrap', call: 'Pipeline.of(42).unwrap()', want: '42' },
      { desc: 'map transforms', call: 'Pipeline.of(5).map(x=>x*2).unwrap()', want: '10' },
      { desc: 'chain maps', call: 'Pipeline.of("hello").map(s=>s.toUpperCase()).map(s=>s+"!").unwrap()', want: '"HELLO!"' },
      { desc: 'tap does not change', call: '(()=>{let side=0;const v=Pipeline.of(42).tap(x=>{side=x}).unwrap();return [v,side]})()', want: '[42,42]' },
      { desc: 'filter passes', call: 'Pipeline.of(5).filter(x=>x>0,0).unwrap()', want: '5' },
      { desc: 'filter falls back', call: 'Pipeline.of(-1).filter(x=>x>0,0).unwrap()', want: '0' },
      { desc: 'mapAsync', call: 'Pipeline.of(10).mapAsync(async x=>x+5).then(p=>p.unwrap())', want: '15' },
    ],
  },

  // ── Caching patterns ──────────────────────────────────────────────────────

  {
    id: 'cache-aside',
    filename: 'cacheAside',
    summary: 'Cache-aside pattern: fetch from cache or load and store.',
    defaultPath: 'src/cacheAside.ts',
    exports: ['CacheAside'],
    patterns: [
      { re: '\\bcache.?aside|read.?through.*cache', weight: 0.65 },
      { re: '\\bCacheAside\\b', weight: 0.4 },
      { re: '\\bcache.*miss.*load|load.*cache.*miss', weight: 0.5 },
    ],
    impl: `export class CacheAside<K, V> {
  private store = new Map<K, V>()

  constructor(private loader: (key: K) => Promise<V>) {}

  async get(key: K): Promise<V> {
    if (this.store.has(key)) return this.store.get(key)!
    const value = await this.loader(key)
    this.store.set(key, value)
    return value
  }

  set(key: K, value: V): void { this.store.set(key, value) }
  has(key: K): boolean { return this.store.has(key) }
  delete(key: K): boolean { return this.store.delete(key) }
  clear(): void { this.store.clear() }
  size(): number { return this.store.size }
}`,
    tests: [
      { desc: 'loads on miss', call: '(async()=>{let loads=0;const c=new CacheAside(async k=>{loads++;return k*2});await c.get(5);return loads})()', want: '1' },
      { desc: 'caches on hit', call: '(async()=>{let loads=0;const c=new CacheAside(async k=>{loads++;return k});await c.get(1);await c.get(1);return loads})()', want: '1' },
      { desc: 'returns correct value', call: '(async()=>{const c=new CacheAside(async k=>k+"!");return await c.get("hello")})()', want: '"hello!"' },
      { desc: 'has after load', call: '(async()=>{const c=new CacheAside(async k=>k);await c.get("x");return c.has("x")})()', want: 'true' },
      { desc: 'delete removes', call: '(async()=>{const c=new CacheAside(async k=>k);await c.get("x");c.delete("x");return c.has("x")})()', want: 'false' },
      { desc: 'set bypasses loader', call: '(async()=>{let loads=0;const c=new CacheAside(async k=>{loads++;return k});c.set("x","manual");await c.get("x");return loads})()', want: '0' },
    ],
  },

  // ── String parsing extras ─────────────────────────────────────────────────

  {
    id: 'number-words',
    filename: 'numberWords',
    summary: 'Convert numbers to English words and back.',
    defaultPath: 'src/numberWords.ts',
    exports: ['numberToWords', 'wordsToNumber'],
    patterns: [
      { re: '\\bnumber.*words?|words?.*number', weight: 0.6 },
      { re: '\\bnumberToWords\\b|\\bwordsToNumber\\b', weight: 0.4 },
      { re: '\\binteger.*english|english.*number', weight: 0.5 },
      { re: '\\bspell.*number|number.*spell', weight: 0.55 },
    ],
    impl: `const ONES = ['','one','two','three','four','five','six','seven','eight','nine',
  'ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen']
const TENS = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety']

export function numberToWords(n: number): string {
  if (n === 0) return 'zero'
  if (n < 0) return 'negative ' + numberToWords(-n)
  if (n < 20) return ONES[n]
  if (n < 100) return TENS[Math.floor(n/10)] + (n%10 ? '-' + ONES[n%10] : '')
  if (n < 1000) return ONES[Math.floor(n/100)] + ' hundred' + (n%100 ? ' ' + numberToWords(n%100) : '')
  if (n < 1000000) return numberToWords(Math.floor(n/1000)) + ' thousand' + (n%1000 ? ' ' + numberToWords(n%1000) : '')
  if (n < 1000000000) return numberToWords(Math.floor(n/1000000)) + ' million' + (n%1000000 ? ' ' + numberToWords(n%1000000) : '')
  return String(n)
}

export function wordsToNumber(words: string): number {
  const w = words.toLowerCase().trim()
  if (w === 'zero') return 0
  let n = 0, current = 0
  for (const word of w.replace(/-/g,' ').split(' ')) {
    const ones = ONES.indexOf(word)
    const tens = TENS.indexOf(word)
    if (ones > 0) current += ones
    else if (tens > 0) current += tens * 10
    else if (word === 'hundred') current *= 100
    else if (word === 'thousand') { n += current * 1000; current = 0 }
    else if (word === 'million') { n += current * 1000000; current = 0 }
  }
  return n + current
}`,
    tests: [
      { desc: 'zero', call: 'numberToWords(0)', want: '"zero"' },
      { desc: 'one', call: 'numberToWords(1)', want: '"one"' },
      { desc: 'teens', call: 'numberToWords(13)', want: '"thirteen"' },
      { desc: 'tens', call: 'numberToWords(42)', want: '"forty-two"' },
      { desc: 'hundred', call: 'numberToWords(100)', want: '"one hundred"' },
      { desc: '142', call: 'numberToWords(142)', want: '"one hundred forty-two"' },
      { desc: 'thousand', call: 'numberToWords(1000)', want: '"one thousand"' },
      { desc: 'wordsToNumber forty-two', call: 'wordsToNumber("forty-two")', want: '42' },
      { desc: 'wordsToNumber hundred', call: 'wordsToNumber("one hundred")', want: '100' },
      { desc: 'wordsToNumber zero', call: 'wordsToNumber("zero")', want: '0' },
    ],
  },

  // ── Interval / timer ──────────────────────────────────────────────────────

  {
    id: 'interval-timer',
    filename: 'intervalTimer',
    summary: 'setIntervalAsync, clearIntervalAsync, and a StopWatch class.',
    defaultPath: 'src/intervalTimer.ts',
    exports: ['Stopwatch'],
    patterns: [
      { re: '\\bstopwatch\\b|\\bStopwatch\\b', weight: 0.65 },
      { re: '\\belapsed.*time.*class|timer.*class', weight: 0.5 },
      { re: '\\bstart.*stop.*elapsed|lap.*timer', weight: 0.45 },
    ],
    impl: `export class Stopwatch {
  private startTime: number | null = null
  private elapsed = 0
  private laps: number[] = []

  start(): this {
    if (this.startTime === null) this.startTime = Date.now()
    return this
  }

  stop(): number {
    if (this.startTime !== null) {
      this.elapsed += Date.now() - this.startTime
      this.startTime = null
    }
    return this.elapsed
  }

  lap(): number {
    const t = this.elapsedMs()
    this.laps.push(t)
    return t
  }

  reset(): this { this.startTime = null; this.elapsed = 0; this.laps = []; return this }

  elapsedMs(): number {
    return this.startTime !== null ? this.elapsed + (Date.now() - this.startTime) : this.elapsed
  }

  isRunning(): boolean { return this.startTime !== null }
  getLaps(): number[] { return [...this.laps] }
}`,
    tests: [
      { desc: 'not running initially', call: 'new Stopwatch().isRunning()', want: 'false' },
      { desc: 'running after start', call: 'new Stopwatch().start().isRunning()', want: 'true' },
      { desc: 'not running after stop', call: '(() => { const s = new Stopwatch(); s.start(); s.stop(); return s.isRunning() })()', want: 'false' },
      { desc: 'elapsed >= 0', call: 'new Stopwatch().start().elapsedMs() >= 0', want: 'true' },
      { desc: 'reset clears', call: '(() => { const s = new Stopwatch(); s.start(); s.stop(); s.reset(); return s.elapsedMs() })()', want: '0' },
      { desc: 'laps empty initially', call: 'new Stopwatch().getLaps()', want: '[]' },
      { desc: 'stop returns elapsed', call: 'typeof new Stopwatch().start().stop() === "number"', want: 'true' },
    ],
  },

  // ── Error handling patterns ───────────────────────────────────────────────

  {
    id: 'error-utils',
    filename: 'errorUtils',
    summary: 'createError, serializeError, wrapError, isNetworkError, retryable.',
    defaultPath: 'src/errorUtils.ts',
    exports: ['createError', 'serializeError', 'wrapError', 'isNetworkError'],
    patterns: [
      { re: '\\bcreateError\\b|\\bcreate.*error.*util', weight: 0.55 },
      { re: '\\bserializeError\\b|\\bserialize.*error', weight: 0.6 },
      { re: '\\bwrapError\\b|\\bwrap.*error|error.*wrap', weight: 0.5 },
      { re: '\\berror.*util|error.*helper.*util', weight: 0.45 },
    ],
    impl: `export interface AppError extends Error {
  code: string
  statusCode?: number
  cause?: unknown
}

export function createError(message: string, code: string, statusCode?: number, cause?: unknown): AppError {
  const err = new Error(message) as AppError
  err.code = code; err.statusCode = statusCode; err.cause = cause
  return err
}

export function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { message: err.message, name: err.name, stack: err.stack, ...(err as AppError).code ? { code: (err as AppError).code } : {} }
  }
  return { message: String(err) }
}

export function wrapError(err: unknown, message: string, code = 'WRAPPED'): AppError {
  return createError(message, code, undefined, err)
}

export function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|network|fetch/i.test(err.message)
}`,
    tests: [
      { desc: 'createError has code', call: 'createError("oops","ERR_BAD","ignored" as any).code', want: '"ERR_BAD"' },
      { desc: 'createError is Error', call: 'createError("msg","CODE") instanceof Error', want: 'true' },
      { desc: 'serializeError message', call: 'serializeError(new Error("boom"))["message"]', want: '"boom"' },
      { desc: 'serializeError non-error', call: 'serializeError("raw")["message"]', want: '"raw"' },
      { desc: 'wrapError wraps', call: 'wrapError(new Error("orig"),"wrapped").message', want: '"wrapped"' },
      { desc: 'isNetworkError ECONNREFUSED', call: 'isNetworkError(new Error("ECONNREFUSED"))', want: 'true' },
      { desc: 'isNetworkError false', call: 'isNetworkError(new Error("SyntaxError"))', want: 'false' },
    ],
  },

  // ── Collections II ────────────────────────────────────────────────────────

  {
    id: 'multimap',
    filename: 'multimap',
    summary: 'MultiMap: map one key to multiple values, with add, get, delete, has.',
    defaultPath: 'src/multimap.ts',
    exports: ['MultiMap'],
    patterns: [
      { re: '\\bmultimap\\b|\\bMultiMap\\b', weight: 0.75 },
      { re: '\\bone.*key.*multiple.*value|map.*multiple.*value', weight: 0.55 },
      { re: '\\bgroup.*map|map.*array.*value', weight: 0.45 },
    ],
    impl: `export class MultiMap<K, V> {
  private map = new Map<K, V[]>()

  add(key: K, value: V): this { const arr = this.map.get(key) ?? []; arr.push(value); this.map.set(key, arr); return this }
  get(key: K): V[] { return this.map.get(key) ?? [] }
  has(key: K): boolean { return this.map.has(key) }
  delete(key: K): boolean { return this.map.delete(key) }
  deleteEntry(key: K, value: V): boolean {
    const arr = this.map.get(key); if (!arr) return false
    const i = arr.indexOf(value); if (i < 0) return false
    arr.splice(i, 1); if (!arr.length) this.map.delete(key); return true
  }
  keys(): K[] { return [...this.map.keys()] }
  size(): number { return this.map.size }
  totalSize(): number { return [...this.map.values()].reduce((n, a) => n + a.length, 0) }
  clear(): void { this.map.clear() }
  toObject(): Record<string, V[]> {
    const out: Record<string, V[]> = {}
    for (const [k, v] of this.map) out[String(k)] = v
    return out
  }
}`,
    tests: [
      { desc: 'add and get', call: '(() => { const m = new MultiMap<string,number>(); m.add("a",1).add("a",2); return m.get("a") })()', want: '[1,2]' },
      { desc: 'get missing', call: 'new MultiMap().get("x")', want: '[]' },
      { desc: 'has true', call: '(() => { const m = new MultiMap<string,number>(); m.add("a",1); return m.has("a") })()', want: 'true' },
      { desc: 'has false', call: 'new MultiMap().has("x")', want: 'false' },
      { desc: 'totalSize', call: '(() => { const m = new MultiMap<string,number>(); m.add("a",1).add("a",2).add("b",3); return m.totalSize() })()', want: '3' },
      { desc: 'deleteEntry', call: '(() => { const m = new MultiMap<string,number>(); m.add("a",1).add("a",2); m.deleteEntry("a",1); return m.get("a") })()', want: '[2]' },
      { desc: 'delete all removes key', call: '(() => { const m = new MultiMap<string,number>(); m.add("a",1); m.delete("a"); return m.has("a") })()', want: 'false' },
    ],
  },

  {
    id: 'bimap',
    filename: 'bimap',
    summary: 'Bidirectional map: look up by key or by value in O(1).',
    defaultPath: 'src/bimap.ts',
    exports: ['BiMap'],
    patterns: [
      { re: '\\bbimap\\b|\\bBiMap\\b|\\bbidirectional.*map', weight: 0.75 },
      { re: '\\binverse.*map|reverse.*lookup.*map', weight: 0.55 },
      { re: '\\bmap.*both.*direction|two.*way.*map', weight: 0.5 },
    ],
    impl: `export class BiMap<K, V> {
  private fwd = new Map<K, V>()
  private rev = new Map<V, K>()

  set(key: K, value: V): this {
    if (this.fwd.has(key)) this.rev.delete(this.fwd.get(key)!)
    if (this.rev.has(value)) this.fwd.delete(this.rev.get(value)!)
    this.fwd.set(key, value); this.rev.set(value, key); return this
  }

  getByKey(key: K): V | undefined { return this.fwd.get(key) }
  getByValue(value: V): K | undefined { return this.rev.get(value) }
  hasKey(key: K): boolean { return this.fwd.has(key) }
  hasValue(value: V): boolean { return this.rev.has(value) }
  deleteByKey(key: K): boolean {
    if (!this.fwd.has(key)) return false
    this.rev.delete(this.fwd.get(key)!); this.fwd.delete(key); return true
  }
  size(): number { return this.fwd.size }
  clear(): void { this.fwd.clear(); this.rev.clear() }
}`,
    tests: [
      { desc: 'set and getByKey', call: '(() => { const m = new BiMap<string,number>(); m.set("a",1); return m.getByKey("a") })()', want: '1' },
      { desc: 'getByValue', call: '(() => { const m = new BiMap<string,number>(); m.set("a",1); return m.getByValue(1) })()', want: '"a"' },
      { desc: 'hasKey', call: '(() => { const m = new BiMap<string,number>(); m.set("a",1); return m.hasKey("a") })()', want: 'true' },
      { desc: 'hasValue', call: '(() => { const m = new BiMap<string,number>(); m.set("a",1); return m.hasValue(1) })()', want: 'true' },
      { desc: 'size', call: '(() => { const m = new BiMap<string,number>(); m.set("a",1).set("b",2); return m.size() })()', want: '2' },
      { desc: 'overwrite key removes old value', call: '(() => { const m = new BiMap<string,number>(); m.set("a",1); m.set("a",2); return m.hasValue(1) })()', want: 'false' },
      { desc: 'delete', call: '(() => { const m = new BiMap<string,number>(); m.set("a",1); m.deleteByKey("a"); return m.hasKey("a") })()', want: 'false' },
    ],
  },

  // ── Signal / reactive ─────────────────────────────────────────────────────

  {
    id: 'signal',
    filename: 'signal',
    summary: 'Reactive signal: computed values, effects, and automatic dependency tracking.',
    defaultPath: 'src/signal.ts',
    exports: ['signal', 'computed', 'effect'],
    patterns: [
      { re: '\\bsignal\\b.*reactive|reactive.*\\bsignal\\b', weight: 0.65 },
      { re: '\\bcomputed\\b.*signal|\\beffect\\b.*signal', weight: 0.6 },
      { re: '\\bsignal\\(|\\bcomputed\\(|\\beffect\\(', weight: 0.5 },
    ],
    impl: `type Cleanup = () => void

let currentEffect: (() => void) | null = null

export class Signal<T> {
  private _value: T
  private subscribers = new Set<() => void>()

  constructor(initial: T) { this._value = initial }

  get(): T {
    if (currentEffect) this.subscribers.add(currentEffect)
    return this._value
  }

  set(val: T): void {
    if (val === this._value) return
    this._value = val
    for (const sub of [...this.subscribers]) sub()
  }

  update(fn: (v: T) => T): void { this.set(fn(this._value)) }
}

export function signal<T>(initial: T): Signal<T> { return new Signal(initial) }

export function computed<T>(fn: () => T): { get(): T } {
  const s = new Signal(fn())
  effect(() => s.set(fn()))
  return { get: () => s.get() }
}

export function effect(fn: () => void): Cleanup {
  const run = () => { currentEffect = run; fn(); currentEffect = null }
  run()
  return () => { /* cleanup: signal subscribers are weak */ }
}`,
    tests: [
      { desc: 'signal get', call: 'signal(42).get()', want: '42' },
      { desc: 'signal set', call: '(() => { const s = signal(0); s.set(99); return s.get() })()', want: '99' },
      { desc: 'signal update', call: '(() => { const s = signal(5); s.update(x=>x*2); return s.get() })()', want: '10' },
      { desc: 'effect runs immediately', call: '(() => { let ran = false; effect(() => { ran = true }); return ran })()', want: 'true' },
      { desc: 'effect reacts to signal', call: '(() => { const s = signal(0); let last = 0; effect(() => { last = s.get() }); s.set(42); return last })()', want: '42' },
      { desc: 'computed derives', call: '(() => { const s = signal(5); const c = computed(() => s.get() * 2); return c.get() })()', want: '10' },
    ],
  },

  // ── More sorting / searching ───────────────────────────────────────────────

  {
    id: 'search-utils',
    filename: 'searchUtils',
    summary: 'Linear search, interpolation search, exponential search for sorted arrays.',
    defaultPath: 'src/searchUtils.ts',
    exports: ['linearSearch', 'interpolationSearch', 'exponentialSearch'],
    patterns: [
      { re: '\\blinear.*search|search.*linear', weight: 0.6 },
      { re: '\\binterpolation.*search', weight: 0.65 },
      { re: '\\bexponential.*search', weight: 0.6 },
      { re: '\\bsearch.*algorithm.*sorted', weight: 0.45 },
    ],
    impl: `export function linearSearch<T>(arr: T[], target: T): number {
  for (let i = 0; i < arr.length; i++) if (arr[i] === target) return i
  return -1
}

export function interpolationSearch(arr: number[], target: number): number {
  let lo = 0, hi = arr.length - 1
  while (lo <= hi && target >= arr[lo] && target <= arr[hi]) {
    if (lo === hi) return arr[lo] === target ? lo : -1
    const pos = lo + Math.floor((target - arr[lo]) * (hi - lo) / (arr[hi] - arr[lo]))
    if (arr[pos] === target) return pos
    if (arr[pos] < target) lo = pos + 1; else hi = pos - 1
  }
  return -1
}

export function exponentialSearch(arr: number[], target: number): number {
  if (!arr.length) return -1
  if (arr[0] === target) return 0
  let i = 1
  while (i < arr.length && arr[i] <= target) i *= 2
  let lo = i >> 1, hi = Math.min(i, arr.length - 1)
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] === target) return mid
    if (arr[mid] < target) lo = mid + 1; else hi = mid - 1
  }
  return -1
}`,
    tests: [
      { desc: 'linearSearch found', call: 'linearSearch([1,2,3,4,5], 3)', want: '2' },
      { desc: 'linearSearch not found', call: 'linearSearch([1,2,3], 9)', want: '-1' },
      { desc: 'linearSearch empty', call: 'linearSearch([], 1)', want: '-1' },
      { desc: 'interpolationSearch found', call: 'interpolationSearch([10,20,30,40,50], 30)', want: '2' },
      { desc: 'interpolationSearch not found', call: 'interpolationSearch([1,2,3], 9)', want: '-1' },
      { desc: 'exponentialSearch found', call: 'exponentialSearch([1,2,3,4,5,6,7,8,9,10], 7)', want: '6' },
      { desc: 'exponentialSearch first', call: 'exponentialSearch([1,2,3], 1)', want: '0' },
      { desc: 'exponentialSearch not found', call: 'exponentialSearch([1,2,3], 9)', want: '-1' },
    ],
  },

]

export default CATALOG
