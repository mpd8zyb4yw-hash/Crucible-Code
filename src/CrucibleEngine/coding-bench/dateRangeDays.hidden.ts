// Extended corpus suite (W42) — generated from coding-bench-ext; edit the shard, not this file.
// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — dateRangeDays.
// Run: npx tsx __audit__/dateRangeDays.hidden.ts   (imports ../src/dateRangeDays)
import { overlapDays } from '../src/dateRangeDays'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}

check('partial overlap', overlapDays(['2024-01-01', '2024-01-10'], ['2024-01-08', '2024-01-20']) === 3)
check('disjoint is zero', overlapDays(['2024-01-01', '2024-01-05'], ['2024-02-01', '2024-02-05']) === 0)
check('touching single day', overlapDays(['2024-01-01', '2024-01-05'], ['2024-01-05', '2024-01-09']) === 1)
check('containment', overlapDays(['2024-01-01', '2024-01-31'], ['2024-01-10', '2024-01-12']) === 3)
check('identical single day', overlapDays(['2024-03-03', '2024-03-03'], ['2024-03-03', '2024-03-03']) === 1)
check('identical ranges', overlapDays(['2024-01-01', '2024-01-07'], ['2024-01-01', '2024-01-07']) === 7)
check('leap day counted', overlapDays(['2024-02-28', '2024-03-01'], ['2024-02-29', '2024-03-05']) === 2)
check('non-leap february boundary', overlapDays(['2023-02-27', '2023-03-01'], ['2023-02-28', '2023-02-28']) === 1)
check('across month end', overlapDays(['2024-01-30', '2024-02-02'], ['2024-01-31', '2024-02-01']) === 2)
check('across year end', overlapDays(['2023-12-30', '2024-01-02'], ['2023-12-31', '2024-01-05']) === 3)
check('adjacent but not touching', overlapDays(['2024-01-01', '2024-01-04'], ['2024-01-05', '2024-01-09']) === 0)
const throwsType = (fn: () => void): boolean => {
  try { fn(); return false } catch (e) { return e instanceof TypeError }
}
const throwsRange = (fn: () => void): boolean => {
  try { fn(); return false } catch (e) { return e instanceof RangeError }
}
check('malformed date throws TypeError', throwsType(() => overlapDays(['2024-1-01', '2024-01-02'], ['2024-01-01', '2024-01-02'])))
check('impossible Feb 29 throws TypeError', throwsType(() => overlapDays(['2023-02-29', '2023-03-01'], ['2023-03-01', '2023-03-02'])))
check('impossible Apr 31 throws TypeError', throwsType(() => overlapDays(['2024-04-31', '2024-05-01'], ['2024-05-01', '2024-05-02'])))
check('datetime string throws TypeError', throwsType(() => overlapDays(['2024-01-01T00:00:00Z', '2024-01-02'], ['2024-01-01', '2024-01-02'])))
check('inverted range throws RangeError', throwsRange(() => overlapDays(['2024-01-05', '2024-01-01'], ['2024-01-01', '2024-01-02'])))

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
