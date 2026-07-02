// Inline author for the dpAlgos family. Run: npx tsx _author_dp.ts
// Authored in JS, serialized to JSON (zero escaping risk), then gated by validate-batch.
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
    id: 'longest-common-subsequence', filename: 'longestCommonSubsequence',
    summary: 'longestCommonSubsequence returns the length of the longest common subsequence of two strings.',
    defaultPath: 'src/longestCommonSubsequence.ts', exports: ['longestCommonSubsequence'],
    patterns: [{ re: '\\blongestCommonSubsequence\\b', weight: 0.6 }, { re: 'longest common subsequence|\\blcs\\b', weight: 0.3 }],
    impl: `export function longestCommonSubsequence(a: string, b: string): number {
  const m = a.length, n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
  return dp[m][n]
}`,
    tests: [
      { desc: 'classic ABCBDAB/BDCAB', call: 'longestCommonSubsequence("ABCBDAB","BDCAB")', want: '4' },
      { desc: 'AGGTAB/GXTXAYB', call: 'longestCommonSubsequence("AGGTAB","GXTXAYB")', want: '4' },
      { desc: 'identical', call: 'longestCommonSubsequence("abc","abc")', want: '3' },
      { desc: 'disjoint', call: 'longestCommonSubsequence("abc","def")', want: '0' },
      { desc: 'empty', call: 'longestCommonSubsequence("","xyz")', want: '0' },
      { desc: 'single match', call: 'longestCommonSubsequence("a","a")', want: '1' },
      { desc: 'abcde/ace', call: 'longestCommonSubsequence("abcde","ace")', want: '3' },
    ],
  },
  {
    id: 'longest-increasing-subsequence', filename: 'longestIncreasingSubsequence',
    summary: 'longestIncreasingSubsequence returns the length of the longest strictly increasing subsequence of a number array.',
    defaultPath: 'src/longestIncreasingSubsequence.ts', exports: ['longestIncreasingSubsequence'],
    patterns: [{ re: '\\blongestIncreasingSubsequence\\b', weight: 0.6 }, { re: 'longest increasing subsequence|\\blis\\b', weight: 0.3 }],
    impl: `export function longestIncreasingSubsequence(arr: number[]): number {
  const tails: number[] = []
  for (const x of arr) {
    let lo = 0, hi = tails.length
    while (lo < hi) { const mid = (lo + hi) >> 1; tails[mid] < x ? lo = mid + 1 : hi = mid }
    tails[lo] = x
  }
  return tails.length
}`,
    tests: [
      { desc: 'classic', call: 'longestIncreasingSubsequence([10,9,2,5,3,7,101,18])', want: '4' },
      { desc: 'empty', call: 'longestIncreasingSubsequence([])', want: '0' },
      { desc: 'increasing', call: 'longestIncreasingSubsequence([1,2,3])', want: '3' },
      { desc: 'decreasing', call: 'longestIncreasingSubsequence([3,2,1])', want: '1' },
      { desc: 'single', call: 'longestIncreasingSubsequence([5])', want: '1' },
      { desc: 'with dip', call: 'longestIncreasingSubsequence([1,3,2,4])', want: '3' },
      { desc: 'all equal strict', call: 'longestIncreasingSubsequence([7,7,7])', want: '1' },
    ],
  },
  {
    id: 'knapsack-01', filename: 'knapsack01',
    summary: 'knapsack01 returns the maximum value for the 0/1 knapsack problem given weights, values, and a capacity.',
    defaultPath: 'src/knapsack01.ts', exports: ['knapsack01'],
    patterns: [{ re: '\\bknapsack01\\b', weight: 0.6 }, { re: 'knapsack', weight: 0.35 }],
    impl: `export function knapsack01(weights: number[], values: number[], capacity: number): number {
  const dp = new Array(capacity + 1).fill(0)
  for (let i = 0; i < weights.length; i++)
    for (let c = capacity; c >= weights[i]; c--)
      dp[c] = Math.max(dp[c], dp[c - weights[i]] + values[i])
  return dp[capacity]
}`,
    tests: [
      { desc: 'classic', call: 'knapsack01([1,3,4,5],[1,4,5,7],7)', want: '9' },
      { desc: 'zero capacity', call: 'knapsack01([1,2,3],[10,20,30],0)', want: '0' },
      { desc: 'empty items', call: 'knapsack01([],[],10)', want: '0' },
      { desc: 'all fit', call: 'knapsack01([1,2,3],[6,10,12],6)', want: '28' },
      { desc: 'none fit', call: 'knapsack01([5,6],[10,20],4)', want: '0' },
      { desc: 'single fits', call: 'knapsack01([4],[100],4)', want: '100' },
      { desc: 'choose better', call: 'knapsack01([2,3],[3,4],5)', want: '7' },
    ],
  },
  {
    id: 'coin-change-min', filename: 'coinChangeMin',
    summary: 'coinChangeMin returns the minimum number of coins to make an amount, or -1 if impossible, with unlimited coins.',
    defaultPath: 'src/coinChangeMin.ts', exports: ['coinChangeMin'],
    patterns: [{ re: '\\bcoinChangeMin\\b', weight: 0.6 }, { re: 'coin change|minimum coins|fewest coins', weight: 0.3 }],
    impl: `export function coinChangeMin(coins: number[], amount: number): number {
  const dp = new Array(amount + 1).fill(Infinity)
  dp[0] = 0
  for (let a = 1; a <= amount; a++)
    for (const c of coins)
      if (c <= a && dp[a - c] + 1 < dp[a]) dp[a] = dp[a - c] + 1
  return dp[amount] === Infinity ? -1 : dp[amount]
}`,
    tests: [
      { desc: 'classic 11', call: 'coinChangeMin([1,2,5],11)', want: '3' },
      { desc: 'impossible', call: 'coinChangeMin([2],3)', want: '-1' },
      { desc: 'zero amount', call: 'coinChangeMin([1,2,5],0)', want: '0' },
      { desc: 'exact single', call: 'coinChangeMin([1,5,10,25],30)', want: '2' },
      { desc: 'only ones', call: 'coinChangeMin([1],7)', want: '7' },
      { desc: 'no coins', call: 'coinChangeMin([],5)', want: '-1' },
      { desc: 'no coins zero amount', call: 'coinChangeMin([],0)', want: '0' },
    ],
  },
  {
    id: 'coin-change-ways', filename: 'coinChangeWays',
    summary: 'coinChangeWays counts the distinct combinations of coins that sum to an amount (order-independent).',
    defaultPath: 'src/coinChangeWays.ts', exports: ['coinChangeWays'],
    patterns: [{ re: '\\bcoinChangeWays\\b', weight: 0.6 }, { re: 'coin change.*ways|number of combinations|count.*combinations', weight: 0.3 }],
    impl: `export function coinChangeWays(coins: number[], amount: number): number {
  const dp = new Array(amount + 1).fill(0)
  dp[0] = 1
  for (const c of coins)
    for (let a = c; a <= amount; a++)
      dp[a] += dp[a - c]
  return dp[amount]
}`,
    tests: [
      { desc: 'classic 5', call: 'coinChangeWays([1,2,5],5)', want: '4' },
      { desc: 'impossible', call: 'coinChangeWays([2],3)', want: '0' },
      { desc: 'zero amount', call: 'coinChangeWays([1,2,5],0)', want: '1' },
      { desc: 'only ones', call: 'coinChangeWays([1],4)', want: '1' },
      { desc: 'amount 3 with 1,2', call: 'coinChangeWays([1,2],3)', want: '2' },
      { desc: 'no coins positive', call: 'coinChangeWays([],5)', want: '0' },
      { desc: 'no coins zero', call: 'coinChangeWays([],0)', want: '1' },
    ],
  },
  {
    id: 'max-subarray-sum', filename: 'maxSubArraySum',
    summary: 'maxSubArraySum returns the maximum contiguous subarray sum (Kadane), handling all-negative arrays.',
    defaultPath: 'src/maxSubArraySum.ts', exports: ['maxSubArraySum'],
    patterns: [{ re: '\\bmaxSubArraySum\\b', weight: 0.6 }, { re: 'maximum.*subarray|kadane|contiguous.*sum', weight: 0.3 }],
    impl: `export function maxSubArraySum(arr: number[]): number {
  if (!arr.length) return 0
  let best = arr[0], cur = arr[0]
  for (let i = 1; i < arr.length; i++) {
    cur = Math.max(arr[i], cur + arr[i])
    best = Math.max(best, cur)
  }
  return best
}`,
    tests: [
      { desc: 'classic', call: 'maxSubArraySum([-2,1,-3,4,-1,2,1,-5,4])', want: '6' },
      { desc: 'single', call: 'maxSubArraySum([1])', want: '1' },
      { desc: 'all negative', call: 'maxSubArraySum([-1,-2,-3])', want: '-1' },
      { desc: 'all positive', call: 'maxSubArraySum([5,4,-1,7,8])', want: '23' },
      { desc: 'two negatives', call: 'maxSubArraySum([-2,-1])', want: '-1' },
      { desc: 'empty', call: 'maxSubArraySum([])', want: '0' },
      { desc: 'mixed peak', call: 'maxSubArraySum([1,2,-1,3])', want: '5' },
    ],
  },
  {
    id: 'edit-distance-lev', filename: 'editDistanceLev',
    summary: 'editDistanceLev returns the Levenshtein edit distance between two strings.',
    defaultPath: 'src/editDistanceLev.ts', exports: ['editDistanceLev'],
    patterns: [{ re: '\\beditDistanceLev\\b', weight: 0.6 }, { re: 'levenshtein|edit distance', weight: 0.3 }],
    impl: `export function editDistanceLev(a: string, b: string): number {
  const m = a.length, n = b.length
  const dp = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0))
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
  return dp[m][n]
}`,
    tests: [
      { desc: 'kitten/sitting', call: 'editDistanceLev("kitten","sitting")', want: '3' },
      { desc: 'empty to abc', call: 'editDistanceLev("","abc")', want: '3' },
      { desc: 'identical', call: 'editDistanceLev("abc","abc")', want: '0' },
      { desc: 'flaw/lawn', call: 'editDistanceLev("flaw","lawn")', want: '2' },
      { desc: 'single sub', call: 'editDistanceLev("a","b")', want: '1' },
      { desc: 'both empty', call: 'editDistanceLev("","")', want: '0' },
      { desc: 'insertion', call: 'editDistanceLev("ac","abc")', want: '1' },
    ],
  },
  {
    id: 'subset-sum-exists', filename: 'subsetSumExists',
    summary: 'subsetSumExists reports whether some subset of non-negative integers sums to a target.',
    defaultPath: 'src/subsetSumExists.ts', exports: ['subsetSumExists'],
    patterns: [{ re: '\\bsubsetSumExists\\b', weight: 0.6 }, { re: 'subset sum', weight: 0.35 }],
    impl: `export function subsetSumExists(arr: number[], target: number): boolean {
  if (target === 0) return true
  if (target < 0) return false
  const dp = new Array(target + 1).fill(false)
  dp[0] = true
  for (const x of arr)
    for (let t = target; t >= x; t--)
      if (dp[t - x]) dp[t] = true
  return dp[target]
}`,
    tests: [
      { desc: 'classic true', call: 'subsetSumExists([3,34,4,12,5,2],9)', want: 'true' },
      { desc: 'classic false', call: 'subsetSumExists([3,34,4,12,5,2],30)', want: 'false' },
      { desc: 'empty target zero', call: 'subsetSumExists([],0)', want: 'true' },
      { desc: 'empty positive target', call: 'subsetSumExists([],5)', want: 'false' },
      { desc: 'exact sum', call: 'subsetSumExists([1,2,3],6)', want: 'true' },
      { desc: 'over sum', call: 'subsetSumExists([1,2,3],7)', want: 'false' },
      { desc: 'single match', call: 'subsetSumExists([5],5)', want: 'true' },
    ],
  },
]

const out = path.join(HERE, 'dpAlgos.json')
fs.writeFileSync(out, JSON.stringify(entries, null, 2))
console.log(`wrote ${entries.length} entries → ${out}`)
