// Inline author for the strAlgos family. Run: npx tsx _author_str.ts
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

interface Entry {
  id: string; filename: string; summary: string; defaultPath: string
  exports: string[]; patterns: { re: string; weight: number }[]; impl: string
  tests: { desc: string; call: string; want: string }[]
}

const entries: Entry[] = [
  {
    id: 'kmp-search-index', filename: 'kmpSearchIndex',
    summary: 'kmpSearchIndex returns the first index where a pattern occurs in text using the Knuth-Morris-Pratt algorithm, or -1.',
    defaultPath: 'src/kmpSearchIndex.ts', exports: ['kmpSearchIndex'],
    patterns: [{ re: '\\bkmpSearchIndex\\b', weight: 0.6 }, { re: 'knuth.?morris.?pratt|\\bkmp\\b|substring search', weight: 0.3 }],
    impl: `export function kmpSearchIndex(text: string, pattern: string): number {
  if (pattern === '') return 0
  const lps = new Array(pattern.length).fill(0)
  for (let i = 1, len = 0; i < pattern.length;) {
    if (pattern[i] === pattern[len]) lps[i++] = ++len
    else if (len) len = lps[len - 1]
    else lps[i++] = 0
  }
  for (let i = 0, j = 0; i < text.length;) {
    if (text[i] === pattern[j]) { i++; j++; if (j === pattern.length) return i - j }
    else if (j) j = lps[j - 1]
    else i++
  }
  return -1
}`,
    tests: [
      { desc: 'basic', call: 'kmpSearchIndex("hello world","world")', want: '6' },
      { desc: 'overlap start', call: 'kmpSearchIndex("aaaa","aa")', want: '0' },
      { desc: 'no match', call: 'kmpSearchIndex("abc","d")', want: '-1' },
      { desc: 'empty text', call: 'kmpSearchIndex("","a")', want: '-1' },
      { desc: 'empty pattern', call: 'kmpSearchIndex("abc","")', want: '0' },
      { desc: 'mid match', call: 'kmpSearchIndex("mississippi","issip")', want: '4' },
      { desc: 'lps reuse', call: 'kmpSearchIndex("abcabcabd","abcabd")', want: '3' },
    ],
  },
  {
    id: 'rabin-karp-all', filename: 'rabinKarpAll',
    summary: 'rabinKarpAll returns all start indices where a pattern occurs in text (overlaps allowed) using Rabin-Karp hashing.',
    defaultPath: 'src/rabinKarpAll.ts', exports: ['rabinKarpAll'],
    patterns: [{ re: '\\brabinKarpAll\\b', weight: 0.6 }, { re: 'rabin.?karp|all.*occurrence|all match.*indices', weight: 0.3 }],
    impl: `export function rabinKarpAll(text: string, pattern: string): number[] {
  const res: number[] = []
  const n = text.length, m = pattern.length
  if (m === 0 || m > n) return res
  const B = 256, MOD = 1000000007
  let ph = 0, th = 0, pow = 1
  for (let i = 0; i < m; i++) {
    ph = (ph * B + pattern.charCodeAt(i)) % MOD
    th = (th * B + text.charCodeAt(i)) % MOD
    if (i) pow = (pow * B) % MOD
  }
  for (let i = 0; i + m <= n; i++) {
    if (ph === th && text.substr(i, m) === pattern) res.push(i)
    if (i + m < n) {
      let rm = th - (text.charCodeAt(i) * pow) % MOD
      rm = ((rm % MOD) + MOD) % MOD
      th = (rm * B + text.charCodeAt(i + m)) % MOD
    }
  }
  return res
}`,
    tests: [
      { desc: 'overlaps', call: 'rabinKarpAll("aaaa","aa")', want: '[0,1,2]' },
      { desc: 'two matches', call: 'rabinKarpAll("abcabc","abc")', want: '[0,3]' },
      { desc: 'no match', call: 'rabinKarpAll("abc","d")', want: '[]' },
      { desc: 'single char', call: 'rabinKarpAll("aaa","a")', want: '[0,1,2]' },
      { desc: 'empty text', call: 'rabinKarpAll("","a")', want: '[]' },
      { desc: 'empty pattern', call: 'rabinKarpAll("abc","")', want: '[]' },
      { desc: 'pattern longer', call: 'rabinKarpAll("ab","abc")', want: '[]' },
    ],
  },
  {
    id: 'z-function-array', filename: 'zFunctionArray',
    summary: 'zFunctionArray computes the Z-array of a string where z[i] is the longest common prefix of s and s[i:]; z[0] is the full length.',
    defaultPath: 'src/zFunctionArray.ts', exports: ['zFunctionArray'],
    patterns: [{ re: '\\bzFunctionArray\\b', weight: 0.6 }, { re: 'z.?function|z.?array|z.?algorithm', weight: 0.3 }],
    impl: `export function zFunctionArray(s: string): number[] {
  const n = s.length
  const z = new Array(n).fill(0)
  if (n === 0) return z
  z[0] = n
  let l = 0, r = 0
  for (let i = 1; i < n; i++) {
    if (i < r) z[i] = Math.min(r - i, z[i - l])
    while (i + z[i] < n && s[z[i]] === s[i + z[i]]) z[i]++
    if (i + z[i] > r) { l = i; r = i + z[i] }
  }
  return z
}`,
    tests: [
      { desc: 'aabaab', call: 'zFunctionArray("aabaab")', want: '[6,1,0,3,1,0]' },
      { desc: 'all a', call: 'zFunctionArray("aaaaa")', want: '[5,4,3,2,1]' },
      { desc: 'empty', call: 'zFunctionArray("")', want: '[]' },
      { desc: 'single', call: 'zFunctionArray("a")', want: '[1]' },
      { desc: 'no repeat', call: 'zFunctionArray("abc")', want: '[3,0,0]' },
      { desc: 'abab', call: 'zFunctionArray("abab")', want: '[4,0,2,0]' },
    ],
  },
  {
    id: 'longest-palindromic-substr', filename: 'longestPalindromicSubstr',
    summary: 'longestPalindromicSubstr returns the first longest palindromic substring of a string.',
    defaultPath: 'src/longestPalindromicSubstr.ts', exports: ['longestPalindromicSubstr'],
    patterns: [{ re: '\\blongestPalindromicSubstr\\b', weight: 0.6 }, { re: 'longest palindrom', weight: 0.35 }],
    impl: `export function longestPalindromicSubstr(s: string): string {
  if (s.length < 2) return s
  let start = 0, maxLen = 1
  const expand = (l: number, r: number): [number, number] => {
    while (l >= 0 && r < s.length && s[l] === s[r]) { l--; r++ }
    return [l + 1, r - l - 1]
  }
  for (let i = 0; i < s.length; i++) {
    const [s1, l1] = expand(i, i)
    const [s2, l2] = expand(i, i + 1)
    if (l1 > maxLen) { maxLen = l1; start = s1 }
    if (l2 > maxLen) { maxLen = l2; start = s2 }
  }
  return s.slice(start, start + maxLen)
}`,
    tests: [
      { desc: 'babad', call: 'longestPalindromicSubstr("babad")', want: '"bab"' },
      { desc: 'cbbd', call: 'longestPalindromicSubstr("cbbd")', want: '"bb"' },
      { desc: 'single', call: 'longestPalindromicSubstr("a")', want: '"a"' },
      { desc: 'empty', call: 'longestPalindromicSubstr("")', want: '""' },
      { desc: 'no pair', call: 'longestPalindromicSubstr("ac")', want: '"a"' },
      { desc: 'long embedded', call: 'longestPalindromicSubstr("forgeeksskeegfor")', want: '"geeksskeeg"' },
    ],
  },
  {
    id: 'run-length-coding', filename: 'runLengthCoding',
    summary: 'runLengthEncode and runLengthDecode perform run-length encoding of a string, like aaabb to 3a2b; decode reverses it.',
    defaultPath: 'src/runLengthCoding.ts', exports: ['runLengthEncode', 'runLengthDecode'],
    patterns: [{ re: '\\brunLengthEncode\\b|\\brunLengthDecode\\b', weight: 0.6 }, { re: 'run.?length', weight: 0.35 }],
    impl: `export function runLengthEncode(s: string): string {
  let out = '', i = 0
  while (i < s.length) {
    let j = i
    while (j < s.length && s[j] === s[i]) j++
    out += (j - i) + s[i]
    i = j
  }
  return out
}

export function runLengthDecode(s: string): string {
  let out = ''
  const re = /(\\d+)(\\D)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) out += m[2].repeat(Number(m[1]))
  return out
}`,
    tests: [
      { desc: 'encode basic', call: 'runLengthEncode("aaabb")', want: '"3a2b"' },
      { desc: 'encode empty', call: 'runLengthEncode("")', want: '""' },
      { desc: 'encode singles', call: 'runLengthEncode("abc")', want: '"1a1b1c"' },
      { desc: 'decode basic', call: 'runLengthDecode("3a2b")', want: '"aaabb"' },
      { desc: 'decode multidigit', call: 'runLengthDecode("12a").length', want: '12' },
      { desc: 'roundtrip', call: 'runLengthDecode(runLengthEncode("aaabbbc"))', want: '"aaabbbc"' },
      { desc: 'encode run', call: 'runLengthEncode("aaa")', want: '"3a"' },
    ],
  },
  {
    id: 'longest-common-prefix-strs', filename: 'longestCommonPrefixStrs',
    summary: 'longestCommonPrefixStrs returns the longest common prefix shared by an array of strings.',
    defaultPath: 'src/longestCommonPrefixStrs.ts', exports: ['longestCommonPrefixStrs'],
    patterns: [{ re: '\\blongestCommonPrefixStrs\\b', weight: 0.6 }, { re: 'longest common prefix', weight: 0.35 }],
    impl: `export function longestCommonPrefixStrs(strs: string[]): string {
  if (!strs.length) return ''
  let prefix = strs[0]
  for (let i = 1; i < strs.length; i++) {
    while (!strs[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1)
      if (!prefix) return ''
    }
  }
  return prefix
}`,
    tests: [
      { desc: 'common fl', call: 'longestCommonPrefixStrs(["flower","flow","flight"])', want: '"fl"' },
      { desc: 'none', call: 'longestCommonPrefixStrs(["dog","cat"])', want: '""' },
      { desc: 'empty array', call: 'longestCommonPrefixStrs([])', want: '""' },
      { desc: 'single', call: 'longestCommonPrefixStrs(["abc"])', want: '"abc"' },
      { desc: 'identical', call: 'longestCommonPrefixStrs(["abc","abc"])', want: '"abc"' },
      { desc: 'has empty', call: 'longestCommonPrefixStrs([""])', want: '""' },
      { desc: 'full prefix', call: 'longestCommonPrefixStrs(["abcd","abc"])', want: '"abc"' },
    ],
  },
  {
    id: 'reverse-words', filename: 'reverseWords',
    summary: 'reverseWords reverses the order of words in a string, collapsing repeated whitespace and trimming.',
    defaultPath: 'src/reverseWords.ts', exports: ['reverseWords'],
    patterns: [{ re: '\\breverseWords\\b', weight: 0.6 }, { re: 'reverse.*word|word.*order.*reverse', weight: 0.3 }],
    impl: `export function reverseWords(s: string): string {
  return s.trim().split(/\\s+/).filter(Boolean).reverse().join(' ')
}`,
    tests: [
      { desc: 'padded', call: 'reverseWords("  hello   world  ")', want: '"world hello"' },
      { desc: 'sentence', call: 'reverseWords("the sky is blue")', want: '"blue is sky the"' },
      { desc: 'empty', call: 'reverseWords("")', want: '""' },
      { desc: 'single', call: 'reverseWords("single")', want: '"single"' },
      { desc: 'spaces only', call: 'reverseWords("   ")', want: '""' },
      { desc: 'two words', call: 'reverseWords("a b")', want: '"b a"' },
    ],
  },
  {
    id: 'is-rotation-of', filename: 'isRotationOf',
    summary: 'isRotationOf reports whether one string is a rotation of another.',
    defaultPath: 'src/isRotationOf.ts', exports: ['isRotationOf'],
    patterns: [{ re: '\\bisRotationOf\\b', weight: 0.6 }, { re: 'string rotation|is.*rotation', weight: 0.3 }],
    impl: `export function isRotationOf(a: string, b: string): boolean {
  return a.length === b.length && (a + a).includes(b)
}`,
    tests: [
      { desc: 'classic', call: 'isRotationOf("waterbottle","erbottlewat")', want: 'true' },
      { desc: 'simple rotation', call: 'isRotationOf("abc","cab")', want: 'true' },
      { desc: 'not rotation', call: 'isRotationOf("abc","acb")', want: 'false' },
      { desc: 'both empty', call: 'isRotationOf("","")', want: 'true' },
      { desc: 'length mismatch', call: 'isRotationOf("abc","ab")', want: 'false' },
      { desc: 'identical', call: 'isRotationOf("aa","aa")', want: 'true' },
    ],
  },
]

const out = path.join(HERE, 'strAlgos.json')
fs.writeFileSync(out, JSON.stringify(entries, null, 2))
console.log(`wrote ${entries.length} entries → ${out}`)
