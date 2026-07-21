// Extended corpus suite (W42) — generated from coding-bench-ext; edit the shard, not this file.
// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — posixResolve.
// Run: npx tsx __audit__/posixResolve.hidden.ts   (imports ../src/posixResolve)
import { normalizePath } from '../src/posixResolve'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}

check('already normal', normalizePath('/a/b') === '/a/b')
check('collapse repeated slashes', normalizePath('/a//b///c') === '/a/b/c')
check('dot segments removed', normalizePath('/a/./b/.') === '/a/b')
check('dotdot resolves', normalizePath('/a/b/../c') === '/a/c')
check('dotdot chain', normalizePath('/a/b/c/../../d') === '/a/d')
check('root clamp', normalizePath('/../a') === '/a')
check('root multi clamp', normalizePath('/../../a') === '/a')
check('relative preserved dotdot', normalizePath('../../a') === '../../a')
check('relative overflow becomes dotdot', normalizePath('a/../../b') === '../b')
check('relative full cancel is dot', normalizePath('a/..') === '.')
check('empty is dot', normalizePath('') === '.')
check('dot is dot', normalizePath('.') === '.')
check('trailing slash dropped', normalizePath('/a/') === '/a')
check('root stays root', normalizePath('/') === '/')
check('relative trailing slash dropped', normalizePath('a/b/') === 'a/b')
check('dotdot after real segments', normalizePath('a/b/../c') === 'a/c')
check('mixed mess', normalizePath('./a//./b/../c/') === 'a/c')
check('no path module used', !String(normalizePath).includes('require'))

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)
